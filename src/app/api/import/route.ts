import { getDB } from '@/lib/cloudflare'
import { mapAnswersToEvent } from '@/lib/jotform-parser'
import type { JotFormAnswers } from '@/lib/jotform-parser'

const JOTFORM_FORM_ID = '252113809267053'
const BATCH_SIZE = 100

type JotFormSubmission = {
  id: string
  status?: string       // ACTIVE | DELETED (trashed)
  created_at?: string   // "YYYY-MM-DD HH:MM:SS"
  updated_at?: string | null
  answers: JotFormAnswers
}

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

  let body: {
    dry_run?: boolean
    offset?: number
    debug?: boolean
    since_date?: string
    reconcile?: boolean
  } = {}
  try {
    body = await request.json()
  } catch {
    // Body is optional — defaults are fine
  }

  const dryRun = body.dry_run === true
  const debugMode = body.debug === true
  const startOffset = Math.max(0, body.offset || 0)
  // Only sync submissions created OR EDITED after this datetime — catches both new
  // submissions and status/field updates to existing ones.
  const sinceDate = body.since_date || ''

  // Debug mode: fetch first submission and return raw answer labels
  if (debugMode) {
    const res = await fetch(
      `https://api.jotform.com/form/${JOTFORM_FORM_ID}/submissions?apiKey=${apiKey}&limit=1&offset=0`
    )
    const json = await res.json() as { content: JotFormSubmission[] }
    const first = json.content?.[0]
    if (!first) return Response.json({ error: 'No submissions found' }, { status: 404 })
    const fields = Object.entries(first.answers).map(([id, a]) => ({
      id,
      text: (a as { text?: string }).text,
      answer: (a as { answer?: unknown }).answer,
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

  // ── Reconcile mode: remove D1 rows whose submission no longer exists in JotForm ──
  if (body.reconcile === true) {
    return await reconcile(apiKey, db, dryRun)
  }

  let totalFetched = 0
  let upserted = 0
  let skipped = 0
  let deleted = 0
  let offset = startOffset
  const limit = 100

  try {
    while (true) {
      // Filter on updated_at so edits to existing submissions are picked up too
      // (JotForm sets updated_at on creation as well, so new submissions match).
      const dateFilter = sinceDate
        ? `&filter=${encodeURIComponent(JSON.stringify({ 'updated_at:gt': sinceDate }))}`
        : ''
      const res = await fetch(
        `https://api.jotform.com/form/${JOTFORM_FORM_ID}/submissions` +
        `?apiKey=${apiKey}&limit=${limit}&offset=${offset}&orderby=created_at&direction=ASC${dateFilter}`
      )

      if (!res.ok) {
        throw new Error(`JotForm API error: ${res.status} ${await res.text()}`)
      }

      const json = await res.json() as {
        content: JotFormSubmission[]
        resultSet: { count: number; limit: number; offset: number }
      }

      const submissions = json.content || []
      totalFetched += submissions.length

      if (submissions.length === 0) break

      // Belt and braces: even if the API-side filter is ignored, never write rows
      // that weren't actually created/updated inside the window. This guarantees a
      // sync only touches changed rows, never the whole table.
      const inWindow = sinceDate
        ? submissions.filter(s =>
            (s.updated_at && s.updated_at > sinceDate) || (s.created_at && s.created_at > sinceDate))
        : submissions
      skipped += submissions.length - inWindow.length

      // Submissions moved to JotForm's trash come back with status DELETED —
      // remove them from D1 rather than upserting stale data.
      const trashed = inWindow.filter(s => s.status === 'DELETED')
      const active  = inWindow.filter(s => s.status !== 'DELETED')

      if (!dryRun && db) {
        if (trashed.length > 0) {
          for (let i = 0; i < trashed.length; i += 50) {
            const chunk = trashed.slice(i, i + 50)
            await db.prepare(
              `DELETE FROM events WHERE jotform_id IN (${chunk.map(() => '?').join(', ')})`
            ).bind(...chunk.map(s => s.id)).run()
          }
          deleted += trashed.length
        }

        // Upsert in batches using D1's batch() for efficiency. ON CONFLICT updates
        // the existing row in place (preserving id and created_at) instead of the
        // old INSERT OR REPLACE delete-and-reinsert.
        for (let i = 0; i < active.length; i += BATCH_SIZE) {
          const chunk = active.slice(i, i + BATCH_SIZE)
          const stmts = chunk.map(sub => {
            const ev = mapAnswersToEvent(sub.answers)
            return db!.prepare(`
              INSERT INTO events (
                event_name, department, location, event_date, day_of_week,
                event_start, event_end, hold_start, hold_end, doors_open,
                check_in_time, run_time, contact_name, email, phone,
                description, attachment_url, status, count, jotform_id, updated_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
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
                is_archived   = CASE WHEN excluded.event_date < date('now', '-7 days') THEN 1 ELSE 0 END,
                updated_at    = datetime('now')
            `).bind(
              ev.event_name, ev.department, ev.location, ev.event_date,
              ev.day_of_week, ev.event_start, ev.event_end, ev.hold_start,
              ev.hold_end, ev.doors_open, ev.check_in_time, ev.run_time,
              ev.contact_name, ev.email, ev.phone, ev.description,
              ev.attachment_url, ev.status, ev.count, sub.id
            )
          })

          if (stmts.length > 0) await db.batch(stmts)
          upserted += chunk.length
        }
      } else {
        // dry_run: count what would be written
        upserted += active.length
        deleted += trashed.length
      }

      if (submissions.length < limit) break
      offset += limit
    }
  } catch (err) {
    console.error('Import error', err)
    return Response.json(
      { error: String(err), total_fetched: totalFetched, upserted, skipped, deleted },
      { status: 500 }
    )
  }

  return Response.json({
    dry_run: dryRun,
    since_date: sinceDate || null,
    total_fetched: totalFetched,
    upserted,
    skipped,
    deleted,
    message: dryRun
      ? `Dry run complete. Would have upserted ${upserted} and deleted ${deleted}.`
      : `Import complete.`,
  })
}

// Fetch every submission ID from JotForm and delete D1 rows that no longer exist
// there (covers permanent deletions that never appear in incremental syncs).
async function reconcile(apiKey: string, db: D1Database | undefined, dryRun: boolean): Promise<Response> {
  const remoteIds = new Set<string>()
  let offset = 0
  const limit = 1000

  while (true) {
    const res = await fetch(
      `https://api.jotform.com/form/${JOTFORM_FORM_ID}/submissions?apiKey=${apiKey}&limit=${limit}&offset=${offset}`
    )
    if (!res.ok) {
      throw new Error(`JotForm API error during reconcile: ${res.status} ${await res.text()}`)
    }
    const json = await res.json() as { content: JotFormSubmission[] }
    const subs = json.content || []
    for (const s of subs) {
      if (s.status !== 'DELETED') remoteIds.add(s.id)
    }
    if (subs.length < limit) break
    offset += limit
    if (offset > 50000) break // runaway guard
  }

  // Safety: an empty remote list almost certainly means an API problem,
  // not a form with zero submissions — never wipe the table on that.
  if (remoteIds.size === 0) {
    return Response.json({ error: 'Reconcile aborted: JotForm returned no submissions' }, { status: 502 })
  }

  if (!db) {
    return Response.json({ reconcile: true, dry_run: dryRun, remote_count: remoteIds.size, deleted: 0 })
  }

  const local = await db.prepare(
    `SELECT jotform_id FROM events WHERE jotform_id IS NOT NULL`
  ).all()
  const localIds = ((local.results || []) as { jotform_id: string }[]).map(r => r.jotform_id)
  const toDelete = localIds.filter(id => !remoteIds.has(id))

  if (!dryRun && toDelete.length > 0) {
    for (let i = 0; i < toDelete.length; i += 50) {
      const chunk = toDelete.slice(i, i + 50)
      await db.prepare(
        `DELETE FROM events WHERE jotform_id IN (${chunk.map(() => '?').join(', ')})`
      ).bind(...chunk).run()
    }
  }

  return Response.json({
    reconcile: true,
    dry_run: dryRun,
    remote_count: remoteIds.size,
    local_count: localIds.length,
    deleted: dryRun ? 0 : toDelete.length,
    would_delete: dryRun ? toDelete.length : undefined,
  })
}
