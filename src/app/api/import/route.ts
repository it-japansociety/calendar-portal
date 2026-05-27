import { getDB } from '@/lib/cloudflare'
import { mapAnswersToEvent } from '@/lib/jotform-parser'
import type { JotFormAnswers } from '@/lib/jotform-parser'

const JOTFORM_FORM_ID = '252113809267053'
const BATCH_SIZE = 100

export async function POST(request: Request): Promise<Response> {
  try {
    return await handleImport(request)
  } catch (err) {
    console.error('Unhandled import error', err)
    return Response.json({ error: 'Unhandled error', details: String(err) }, { status: 500 })
  }
}

async function handleImport(request: Request): Promise<Response> {
  // API key is passed in the Authorization header by the caller (GitHub Actions / admin)
  // and used directly for JotForm API calls — no Cloudflare secret needed
  const authHeader = request.headers.get('Authorization') || ''
  const apiKey = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : ''
  if (!apiKey) {
    return Response.json({ error: 'Authorization: Bearer <JOTFORM_API_KEY> required' }, { status: 401 })
  }

  let body: { dry_run?: boolean; offset?: number; debug?: boolean } = {}
  try {
    body = await request.json()
  } catch {
    // Body is optional — defaults are fine
  }

  const dryRun = body.dry_run === true
  const debugMode = body.debug === true
  const startOffset = Math.max(0, body.offset || 0)

  // Debug mode: fetch first submission and return raw answer labels
  if (debugMode) {
    const res = await fetch(
      `https://api.jotform.com/form/${JOTFORM_FORM_ID}/submissions?apiKey=${apiKey}&limit=1&offset=0`
    )
    const json = await res.json() as { content: Array<{ id: string; answers: Record<string, { text?: string; answer?: unknown }> }> }
    const first = json.content?.[0]
    if (!first) return Response.json({ error: 'No submissions found' }, { status: 404 })
    const fields = Object.entries(first.answers).map(([id, a]) => ({
      id,
      text: a.text,
      answer: a.answer,
    }))
    return Response.json({ submission_id: first.id, fields })
  }

  let db: D1Database | undefined
  if (!dryRun) {
    try {
      db = await getDB()
    } catch (err) {
      console.error(err)
      return Response.json({ error: 'Database not configured' }, { status: 503 })
    }
  }

  let totalFetched = 0
  let inserted = 0
  let skipped = 0
  let offset = startOffset
  const limit = 100

  try {
    while (true) {
      const res = await fetch(
        `https://api.jotform.com/form/${JOTFORM_FORM_ID}/submissions` +
        `?apiKey=${apiKey}&limit=${limit}&offset=${offset}&orderby=created_at&direction=ASC`
      )

      if (!res.ok) {
        throw new Error(`JotForm API error: ${res.status} ${await res.text()}`)
      }

      const json = await res.json() as {
        content: Array<{ id: string; answers: JotFormAnswers }>
        resultSet: { count: number; limit: number; offset: number }
      }

      const submissions = json.content || []
      totalFetched += submissions.length

      if (submissions.length === 0) break

      if (!dryRun && db) {
        // Insert in batches of BATCH_SIZE using D1's batch() for efficiency
        for (let i = 0; i < submissions.length; i += BATCH_SIZE) {
          const chunk = submissions.slice(i, i + BATCH_SIZE)
          const stmts = chunk.map(sub => {
            const ev = mapAnswersToEvent(sub.answers)
            return db!.prepare(`
              INSERT OR REPLACE INTO events (
                event_name, department, location, event_date, day_of_week,
                event_start, event_end, hold_start, hold_end, doors_open,
                check_in_time, run_time, contact_name, email, phone,
                description, attachment_url, status, count, jotform_id
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).bind(
              ev.event_name, ev.department, ev.location, ev.event_date,
              ev.day_of_week, ev.event_start, ev.event_end, ev.hold_start,
              ev.hold_end, ev.doors_open, ev.check_in_time, ev.run_time,
              ev.contact_name, ev.email, ev.phone, ev.description,
              ev.attachment_url, ev.status, ev.count, sub.id
            )
          })

          const results = await db.batch(stmts)
          results.forEach(r => {
            if (r.meta?.changes && r.meta.changes > 0) inserted++
            else skipped++
          })
        }
      } else {
        // dry_run: count as if all would insert
        inserted += submissions.length
      }

      if (submissions.length < limit) break
      offset += limit
    }
  } catch (err) {
    console.error('Import error', err)
    return Response.json(
      { error: String(err), total_fetched: totalFetched, inserted, skipped },
      { status: 500 }
    )
  }

  return Response.json({
    dry_run: dryRun,
    total_fetched: totalFetched,
    inserted,
    skipped,
    message: dryRun
      ? `Dry run complete. Would have inserted up to ${inserted} submissions.`
      : `Import complete.`,
  })
}
