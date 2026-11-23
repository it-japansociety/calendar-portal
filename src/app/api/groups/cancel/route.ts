// POST /api/groups/cancel — cancel (release) a booking group, in whole or for
// specific days. Owner or admin only. Dry-run phase: enqueues 'release' jobs
// (the queue drain flips the mirror events rows to Released), logs the
// rule_actions audit row, and kicks the drain; no email is actually sent.
import { getDB } from '@/lib/cloudflare'
import { getUserEmail, isAdmin } from '@/lib/identity'
import type { EventGroup } from '@/lib/workflow-types'

export async function POST(request: Request): Promise<Response> {
  let body: { group_id?: unknown; dates?: unknown }
  try {
    body = await request.json() as { group_id?: unknown; dates?: unknown }
  } catch {
    return Response.json({ error: 'Request body must be valid JSON.' }, { status: 400 })
  }

  const group_id = typeof body.group_id === 'string' && body.group_id.trim() !== ''
    ? body.group_id.trim()
    : null
  if (!group_id) return Response.json({ error: 'group_id is required.' }, { status: 400 })

  if (body.dates !== undefined && !Array.isArray(body.dates)) {
    return Response.json({ error: 'dates must be a list of YYYY-MM-DD strings.' }, { status: 400 })
  }
  const rawDates = Array.isArray(body.dates) ? body.dates : null
  const dates = rawDates
    ? rawDates.filter((d): d is string => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d))
    : null
  if (rawDates && dates && dates.length !== rawDates.length) {
    return Response.json({ error: 'Dates must be in YYYY-MM-DD format.' }, { status: 400 })
  }

  let db: D1Database
  try {
    db = await getDB()
  } catch (err) {
    console.error(err)
    return Response.json({ error: 'Database not configured' }, { status: 503 })
  }

  try {
    const group = await db.prepare(`SELECT * FROM event_groups WHERE group_id = ?`)
      .bind(group_id).first<EventGroup>()
    if (!group) return Response.json({ error: 'Booking not found.' }, { status: 404 })

    const email = getUserEmail(request)
    const isOwner = (group.email || '').toLowerCase() === email
      || (group.created_by || '').toLowerCase() === email
    if (!isOwner && !isAdmin(email)) {
      return Response.json(
        { error: 'Only the booking owner or an admin can cancel this booking.' },
        { status: 403 },
      )
    }

    // Days that actually exist downstream: dates whose 'create' job completed.
    const doneRes = await db.prepare(`
      SELECT event_date FROM submission_jobs
      WHERE group_id = ? AND form = 'event' AND action = 'create' AND state = 'done' AND event_date IS NOT NULL
      ORDER BY event_date ASC
    `).bind(group_id).all()
    const doneDates = ((doneRes.results || []) as unknown as { event_date: string }[]).map(r => r.event_date)

    const wanted = dates && dates.length > 0 ? dates : null
    const releaseDates = wanted ? doneDates.filter(d => wanted.includes(d)) : doneDates
    // Whole-group cancel: no specific dates asked for, or the asked-for dates
    // cover every created day.
    const wholeGroup = !wanted || (doneDates.length > 0 && doneDates.every(d => wanted.includes(d)))

    const payload = JSON.stringify({ reason: 'cancel', requested_by: email })
    const statements: D1PreparedStatement[] = releaseDates.map(day =>
      db.prepare(`
        INSERT OR IGNORE INTO submission_jobs (group_id, form, action, event_date, payload, state)
        VALUES (?, 'event', 'release', ?, ?, 'pending')
      `).bind(group_id, day, payload),
    )
    if (wholeGroup) {
      statements.push(
        db.prepare(`UPDATE event_groups SET status = 'cancelled', updated_at = datetime('now') WHERE group_id = ?`)
          .bind(group_id),
      )
    }
    statements.push(
      db.prepare(`
        INSERT INTO rule_actions (rule, group_id, detail, before_status, after_status, dry_run, actor)
        VALUES ('cancel', ?, 'would email contact + boxoffice@', ?, ?, 1, ?)
      `).bind(group_id, group.status, wholeGroup ? 'cancelled' : group.status, email),
    )

    const results = await db.batch(statements)
    // Count only the release inserts that were not deduped by INSERT OR IGNORE.
    let released = 0
    for (let i = 0; i < releaseDates.length; i++) {
      released += results[i]?.meta?.changes ?? 0
    }

    await fetch(new URL('/api/queue/drain', request.url), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    }).catch(() => {})

    return Response.json({ ok: true, released })
  } catch (err) {
    console.error('Group cancel failed', err)
    return Response.json({ error: 'Could not cancel the booking. Please try again.' }, { status: 500 })
  }
}
