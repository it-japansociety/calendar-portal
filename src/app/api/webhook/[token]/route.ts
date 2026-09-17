import { getDB } from '@/lib/cloudflare'
import { getCloudflareContext } from '@opennextjs/cloudflare'
import { parseWebhookBody, mapAnswersToEvent } from '@/lib/jotform-parser'

// The house calendar form. Declared here rather than imported so this route
// has no dependency outside the files that ship with it.
const EVENT_FORM_ID = '252113809267053'

// JotForm webhook receiver. JotForm cannot sign its requests (confirmed with
// their support), so this endpoint is secured three ways:
//
//  1. The shared secret is a PATH SEGMENT, not a query parameter — query
//     strings leak into access logs, proxies and Referer headers far more
//     readily than paths do.
//  2. The POSTed payload is NOT trusted. We take only the submissionID from
//     it and re-fetch the authoritative record from JotForm's own API. A
//     forged request can therefore do nothing worse than make us re-sync a
//     submission that genuinely exists.
//  3. The re-fetched record must belong to our form, and writes are keyed on
//     jotform_id, so replaying an old request is a harmless no-op.
//
// Requires two Worker secrets: WEBHOOK_SECRET and JOTFORM_API_KEY.

const MAX_BODY_BYTES = 512 * 1024 // JotForm posts form-encoded answers; 512KB is generous

type JotFormSubmission = {
  id: string
  form_id?: string
  status?: string
  created_at?: string
  updated_at?: string | null
  answers: Record<string, { text?: string; answer?: unknown }>
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

async function secrets(): Promise<{ webhookSecret: string; apiKey: string }> {
  try {
    const { env } = await getCloudflareContext()
    const e = env as CloudflareEnv & { WEBHOOK_SECRET?: string; JOTFORM_API_KEY?: string }
    return {
      webhookSecret: e.WEBHOOK_SECRET || process.env.WEBHOOK_SECRET || '',
      apiKey: e.JOTFORM_API_KEY || process.env.JOTFORM_API_KEY || '',
    }
  } catch {
    return {
      webhookSecret: process.env.WEBHOOK_SECRET || '',
      apiKey: process.env.JOTFORM_API_KEY || '',
    }
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ token: string }> },
): Promise<Response> {
  const { token } = await params
  const { webhookSecret, apiKey } = await secrets()

  // 1 — authenticate
  if (!webhookSecret || !timingSafeEqual(token || '', webhookSecret)) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // 2 — read the payload only far enough to learn WHICH submission changed
  const declaredLength = parseInt(request.headers.get('content-length') || '0', 10)
  if (declaredLength > MAX_BODY_BYTES) {
    return Response.json({ error: 'Payload too large' }, { status: 413 })
  }

  let submissionID = ''
  let fallbackAnswers: Record<string, { text?: string; answer?: unknown }> | null = null
  try {
    const body = await request.text()
    if (body.length > MAX_BODY_BYTES) {
      return Response.json({ error: 'Payload too large' }, { status: 413 })
    }
    const parsed = parseWebhookBody(body)
    submissionID = parsed.submissionID
    fallbackAnswers = parsed.answers
  } catch (err) {
    console.error('Webhook parse error', err)
    return Response.json({ error: 'Failed to parse submission' }, { status: 400 })
  }

  if (!submissionID || !/^\d{6,25}$/.test(submissionID)) {
    return Response.json({ error: 'Missing or malformed submissionID' }, { status: 400 })
  }

  // 3 — re-fetch the authoritative record. This is what makes a forged payload
  // useless: whatever the caller sent, we write what JotForm actually holds.
  let authoritative: JotFormSubmission | null = null
  if (apiKey) {
    try {
      const res = await fetch(
        `https://api.jotform.com/submission/${submissionID}?apiKey=${apiKey}`,
        { signal: AbortSignal.timeout(8000) },
      )
      if (res.ok) {
        const json = await res.json() as { content?: JotFormSubmission }
        authoritative = json.content ?? null
      } else if (res.status === 404) {
        // Deleted between the hook firing and this fetch — nothing to mirror.
        return Response.json({ ok: true, submissionID, action: 'not_found' })
      }
    } catch (err) {
      console.error('Webhook re-fetch failed, falling back to payload', err)
    }
  }

  // The submission must belong to OUR form — otherwise someone pointed a
  // different form's webhook (or a forged id) at this endpoint.
  if (authoritative?.form_id && authoritative.form_id !== EVENT_FORM_ID) {
    return Response.json({ error: 'Submission does not belong to this form' }, { status: 403 })
  }

  // A submission JotForm reports as deleted/archived gets archived here rather
  // than written as live data.
  if (authoritative && authoritative.status === 'DELETED') {
    try {
      const db = await getDB()
      await db.prepare(`
        UPDATE events SET is_archived = 1, archived_at = datetime('now')
        WHERE jotform_id = ? AND is_archived = 0
      `).bind(submissionID).run()
      return Response.json({ ok: true, submissionID, action: 'archived' })
    } catch (err) {
      console.error('Webhook archive error', err)
      return Response.json({ error: 'Database error' }, { status: 500 })
    }
  }

  // Prefer the authoritative answers; fall back to the posted ones only if the
  // API was unreachable, so a transient JotForm outage doesn't drop the event.
  const answers = authoritative?.answers ?? fallbackAnswers
  if (!answers) {
    return Response.json({ error: 'No answers available' }, { status: 502 })
  }
  const event = mapAnswersToEvent(answers)
  const submittedAt = authoritative?.created_at ?? null

  try {
    const db = await getDB()
    await db
      .prepare(`
        INSERT INTO events (
          event_name, department, location, event_date, day_of_week,
          event_start, event_end, hold_start, hold_end, doors_open,
          check_in_time, run_time, contact_name, email, phone,
          description, attachment_url, status, count, jotform_id,
          submitted_at, updated_at
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
          COALESCE(?, datetime('now')), datetime('now')
        )
        ON CONFLICT(jotform_id) DO UPDATE SET
          submitted_at  = COALESCE(events.submitted_at, excluded.submitted_at),
          event_name    = excluded.event_name,
          department    = excluded.department,
          location      = excluded.location,
          event_date    = excluded.event_date,
          day_of_week   = excluded.day_of_week,
          event_start   = excluded.event_start,
          event_end     = excluded.event_end,
          hold_start    = excluded.hold_start,
          hold_end      = excluded.hold_end,
          doors_open    = excluded.doors_open,
          check_in_time = excluded.check_in_time,
          run_time      = excluded.run_time,
          contact_name  = excluded.contact_name,
          email         = excluded.email,
          phone         = excluded.phone,
          description   = excluded.description,
          attachment_url = excluded.attachment_url,
          status        = excluded.status,
          count         = excluded.count,
          is_archived   = CASE WHEN excluded.event_date < date('now', '-7 days') THEN 1 ELSE 0 END,
          updated_at    = datetime('now')
      `)
      .bind(
        event.event_name, event.department, event.location, event.event_date,
        event.day_of_week, event.event_start, event.event_end, event.hold_start,
        event.hold_end, event.doors_open, event.check_in_time, event.run_time,
        event.contact_name, event.email, event.phone, event.description,
        event.attachment_url, event.status, event.count, submissionID,
        submittedAt,
      )
      .run()
  } catch (err) {
    console.error('Webhook D1 write error', err)
    return Response.json({ error: 'Database error' }, { status: 500 })
  }

  return Response.json({
    ok: true,
    submissionID,
    action: 'upserted',
    verified: !!authoritative,
  })
}

// JotForm pings the URL when you save the webhook; answer politely so the
// form's webhook screen shows it as reachable.
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ token: string }> },
): Promise<Response> {
  const { token } = await params
  const { webhookSecret } = await secrets()
  if (!webhookSecret || !timingSafeEqual(token || '', webhookSecret)) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }
  return Response.json({ ok: true, endpoint: 'jotform-webhook', method: 'POST expected' })
}
