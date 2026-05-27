import { getDB } from '@/lib/cloudflare'
import { parseWebhookBody, mapAnswersToEvent } from '@/lib/jotform-parser'

// Receives JotForm webhook POST submissions and upserts them into D1.
// Configure JotForm: Settings → Integrations → Webhooks
// URL: https://<your-worker>.workers.dev/api/webhook?token=<WEBHOOK_SECRET>
export async function POST(request: Request): Promise<Response> {
  const url = new URL(request.url)

  // Validate shared secret passed as query param
  const token = url.searchParams.get('token')
  const expected = (process.env.WEBHOOK_SECRET as string) || ''
  if (!expected || !timingSafeEqual(token || '', expected)) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let body: string
  try {
    body = await request.text()
  } catch {
    return Response.json({ error: 'Failed to read body' }, { status: 400 })
  }

  let submissionID: string
  let event: ReturnType<typeof mapAnswersToEvent>
  try {
    const parsed = parseWebhookBody(body)
    submissionID = parsed.submissionID
    event = mapAnswersToEvent(parsed.answers)
  } catch (err) {
    console.error('Webhook parse error', err)
    return Response.json({ error: 'Failed to parse submission' }, { status: 400 })
  }

  if (!submissionID) {
    return Response.json({ error: 'Missing submissionID' }, { status: 400 })
  }

  try {
    const db = await getDB()
    await db
      .prepare(`
        INSERT INTO events (
          event_name, department, location, event_date, day_of_week,
          event_start, event_end, hold_start, hold_end, doors_open,
          check_in_time, run_time, contact_name, email, phone,
          description, attachment_url, status, count, jotform_id, updated_at
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now')
        )
        ON CONFLICT(jotform_id) DO UPDATE SET
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
          updated_at    = datetime('now')
      `)
      .bind(
        event.event_name, event.department, event.location, event.event_date,
        event.day_of_week, event.event_start, event.event_end, event.hold_start,
        event.hold_end, event.doors_open, event.check_in_time, event.run_time,
        event.contact_name, event.email, event.phone, event.description,
        event.attachment_url, event.status, event.count, submissionID
      )
      .run()
  } catch (err) {
    console.error('D1 insert error', err)
    return Response.json({ error: 'Database error' }, { status: 500 })
  }

  return Response.json({ success: true, submissionID })
}

// Constant-time string comparison to prevent timing attacks on the token check.
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return diff === 0
}
