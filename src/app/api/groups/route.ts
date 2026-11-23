// Booking groups API for Booking Workflow v2 (Phase 1, dry-run).
//   POST  /api/groups         create a group + one 'create' job per expanded day
//   GET   /api/groups?mine=1  the caller's groups enriched to GroupSummary
//   GET   /api/groups?id=...  one group with jobs, function form, queue position
//   PATCH /api/groups         edit group fields; fans 'edit' jobs to done days
// All JotForm side effects happen in the queue drain (dry-run mirrors rows into
// the events table); this route only writes event_groups / submission_jobs.
import { getDB } from '@/lib/cloudflare'
import { getUserEmail } from '@/lib/identity'
import { ROOM_NAMES, roomsInLocation } from '@/lib/rooms'
import {
  expandGroupDates,
  weekdayMaskFrom,
  weekdaysFromMask,
  REQUIRED_EVENT_FIELDS,
} from '@/lib/workflow-types'
import type {
  CreateGroupRequest,
  EventGroup,
  FunctionFormRow,
  GroupSummary,
  SubmissionJob,
} from '@/lib/workflow-types'

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/
const TIME_FIELDS = ['event_start', 'event_end', 'hold_start', 'hold_end', 'doors_open', 'check_in_time'] as const

function bad(message: string): Response {
  return Response.json({ error: message }, { status: 400 })
}

// Trimmed non-empty string or null (D1 binds reject undefined).
function optionalString(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null
}

function isValidISODate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false
  const t = Date.parse(`${s}T12:00:00Z`)
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === s
}

// Fire-and-forget kick of the queue drain; errors are the drain's problem.
async function kickDrain(request: Request): Promise<void> {
  await fetch(new URL('/api/queue/drain', request.url), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  }).catch(() => {})
}

// ── Enrichment helpers (GET) ──────────────────────────────────────────────────

interface CandidateRow {
  id: number
  group_id: string | null
  location: string | null
  event_date: string
  submitted_at: string | null
}

// Still-active events rows in a date window that could contest a room. Room
// matching can't be done in SQL against the free-form location strings, so we
// fetch candidates once and compute overlap in JS (same pattern as /api/events).
const CANDIDATE_SQL = `
  SELECT id, group_id, location, event_date, submitted_at
  FROM events
  WHERE is_archived = 0
    AND status NOT IN ('Released', 'Cancelled', 'Confirmed')
    AND event_date >= ? AND event_date <= ?
  ORDER BY event_date ASC
  LIMIT 5000
`

// Earlier-submitted, still-active events rows from OTHER groups/submissions
// sharing at least one room on at least one of the group's dates. Each
// qualifying row counts once. queue_position = this count (0 = first).
function competingAhead(g: EventGroup, candidates: CandidateRow[]): number {
  const dates = new Set(expandGroupDates(g.date_from, g.date_to, weekdaysFromMask(g.weekday_mask)))
  const rooms = roomsInLocation(g.location)
  let n = 0
  for (const row of candidates) {
    if (row.group_id === g.group_id) continue // our own (mirror) rows never compete
    if (!row.submitted_at || row.submitted_at >= g.created_at) continue
    if (!dates.has(row.event_date)) continue
    const theirs = roomsInLocation(row.location)
    let shared = false
    for (const r of theirs) {
      if (rooms.has(r)) { shared = true; break }
    }
    if (shared) n++
  }
  return n
}

function missingFields(g: EventGroup): string[] {
  return REQUIRED_EVENT_FIELDS.filter(f => {
    const v = g[f]
    return v === null || v === undefined || String(v).trim() === ''
  })
}

// ── POST /api/groups ──────────────────────────────────────────────────────────

export async function POST(request: Request): Promise<Response> {
  let body: Partial<CreateGroupRequest>
  try {
    body = await request.json() as Partial<CreateGroupRequest>
  } catch {
    return bad('Request body must be valid JSON.')
  }

  const event_name = optionalString(body.event_name)
  if (!event_name) return bad('Please provide an event name.')
  const department = optionalString(body.department)
  if (!department) return bad('Please choose a department.')

  const locations = Array.isArray(body.locations)
    ? body.locations.filter((r): r is string => typeof r === 'string' && r.trim() !== '').map(r => r.trim())
    : []
  if (locations.length === 0) return bad('Please pick at least one room.')
  const unknownRoom = locations.find(r => !ROOM_NAMES.includes(r))
  if (unknownRoom) return bad(`"${unknownRoom}" is not a bookable room. Please pick rooms from the list.`)

  const contact_name = optionalString(body.contact_name)
  if (!contact_name) return bad('Please provide a contact name.')
  const email = optionalString(body.email)
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return bad('Please provide a valid email address.')
  }

  const date_from = optionalString(body.date_from) || ''
  const date_to = optionalString(body.date_to) || ''
  if (!isValidISODate(date_from) || !isValidISODate(date_to)) {
    return bad('Dates must be real dates in YYYY-MM-DD format.')
  }
  if (date_to < date_from) return bad('The end date must be on or after the start date.')

  const weekdays = Array.isArray(body.weekdays) ? body.weekdays : []
  if (weekdays.length === 0 || !weekdays.every(d => Number.isInteger(d) && d >= 0 && d <= 6)) {
    return bad('Please pick at least one weekday (Sunday through Saturday).')
  }

  // Reject over-long ranges up front so expandGroupDates never silently truncates.
  const spanDays = (Date.parse(`${date_to}T12:00:00Z`) - Date.parse(`${date_from}T12:00:00Z`)) / 86400000 + 1
  if (spanDays > 366) {
    return bad('That date range is too long — a booking can span at most one year (366 days). Please split it into shorter bookings.')
  }

  const days = expandGroupDates(date_from, date_to, weekdays)
  if (days.length === 0) {
    return bad('No dates match: none of the selected weekdays fall between the start and end dates.')
  }

  const times: Record<string, string | null> = {}
  for (const f of TIME_FIELDS) {
    const v = optionalString(body[f])
    if (v && !TIME_RE.test(v)) {
      return bad(`"${v}" is not a valid ${f.replace(/_/g, ' ')} — use 24-hour HH:MM (for example 14:30).`)
    }
    times[f] = v
  }
  const run_time = optionalString(body.run_time)
  const description = optionalString(body.description)
  const phone = optionalString(body.phone)
  let count: number | null = null
  if (body.count !== undefined && body.count !== null && String(body.count).trim() !== '') {
    const n = Number(body.count)
    if (!Number.isFinite(n) || n < 0) return bad('Attendee count must be a number.')
    count = Math.round(n)
  }

  let db: D1Database
  try {
    db = await getDB()
  } catch (err) {
    console.error(err)
    return Response.json({ error: 'Database not configured' }, { status: 503 })
  }

  const group_id = crypto.randomUUID()
  const location = locations.join(', ')
  const weekday_mask = weekdayMaskFrom(weekdays)
  const created_by = getUserEmail(request)

  // Snapshot of the fields at enqueue time; each job carries it plus its date.
  const snapshot = {
    group_id, event_name, department, location, description, contact_name,
    email, phone, count,
    event_start: times.event_start, event_end: times.event_end,
    hold_start: times.hold_start, hold_end: times.hold_end,
    doors_open: times.doors_open, check_in_time: times.check_in_time, run_time,
  }

  try {
    await db.batch([
      db.prepare(`
        INSERT INTO event_groups (
          group_id, event_name, department, location, description, contact_name,
          email, phone, count, date_from, date_to, weekday_mask,
          event_start, event_end, hold_start, hold_end,
          doors_open, check_in_time, run_time, status, created_by
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?)
      `).bind(
        group_id, event_name, department, location, description, contact_name,
        email, phone, count, date_from, date_to, weekday_mask,
        times.event_start, times.event_end, times.hold_start, times.hold_end,
        times.doors_open, times.check_in_time, run_time, created_by,
      ),
      ...days.map(day =>
        db.prepare(`
          INSERT INTO submission_jobs (group_id, form, action, event_date, payload, state)
          VALUES (?, 'event', 'create', ?, ?, 'pending')
        `).bind(group_id, day, JSON.stringify({ ...snapshot, event_date: day })),
      ),
    ])
    await db.prepare(`UPDATE event_groups SET status = 'creating', updated_at = datetime('now') WHERE group_id = ?`)
      .bind(group_id).run()
  } catch (err) {
    console.error('Group create failed', err)
    return Response.json({ error: 'Could not save the booking. Please try again.' }, { status: 500 })
  }

  await kickDrain(request)

  return Response.json({ group_id, days, jobs: days.length })
}

// ── GET /api/groups ───────────────────────────────────────────────────────────

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url)
  const id = url.searchParams.get('id')
  const mine = url.searchParams.get('mine')

  let db: D1Database
  try {
    db = await getDB()
  } catch (err) {
    console.error(err)
    return Response.json({ error: 'Database not configured' }, { status: 503 })
  }

  try {
    if (id) {
      const group = await db.prepare(`SELECT * FROM event_groups WHERE group_id = ?`)
        .bind(id).first<EventGroup>()
      if (!group) return Response.json({ error: 'Booking not found.' }, { status: 404 })

      const [jobsRes, ffRes, candRes] = await db.batch([
        db.prepare(`SELECT * FROM submission_jobs WHERE group_id = ? ORDER BY event_date ASC, id ASC`).bind(id),
        db.prepare(`SELECT * FROM function_forms WHERE group_id = ?`).bind(id),
        db.prepare(CANDIDATE_SQL).bind(group.date_from, group.date_to),
      ])
      const jobs = (jobsRes.results || []) as unknown as SubmissionJob[]
      const function_form = ((ffRes.results || [])[0] as unknown as FunctionFormRow | undefined) ?? null
      const candidates = (candRes.results || []) as unknown as CandidateRow[]
      const competing_ahead = competingAhead(group, candidates)

      return Response.json({
        group,
        jobs,
        function_form,
        queue_position: competing_ahead,
        competing_ahead,
        missing_fields: missingFields(group),
      })
    }

    if (mine) {
      const email = getUserEmail(request)
      const groupsRes = await db.prepare(`
        SELECT * FROM event_groups
        WHERE email = ? OR created_by = ?
        ORDER BY created_at DESC
      `).bind(email, email).all()
      const groups = (groupsRes.results || []) as unknown as EventGroup[]
      if (groups.length === 0) return Response.json({ groups: [] })

      const ids = groups.map(g => g.group_id)
      const ph = ids.map(() => '?').join(', ')
      // One candidate fetch covering every group's window; per-group filtering in JS.
      const minFrom = groups.reduce((m, g) => (g.date_from < m ? g.date_from : m), groups[0].date_from)
      const maxTo = groups.reduce((m, g) => (g.date_to > m ? g.date_to : m), groups[0].date_to)

      const [statsRes, ffRes, candRes] = await db.batch([
        db.prepare(`
          SELECT group_id, state, COUNT(*) as n
          FROM submission_jobs
          WHERE form = 'event' AND action = 'create' AND group_id IN (${ph})
          GROUP BY group_id, state
        `).bind(...ids),
        db.prepare(`SELECT group_id, complete FROM function_forms WHERE group_id IN (${ph})`).bind(...ids),
        db.prepare(CANDIDATE_SQL).bind(minFrom, maxTo),
      ])

      const stats = new Map<string, { total: number; done: number; failed: number }>()
      for (const raw of statsRes.results || []) {
        const row = raw as { group_id: string; state: string; n: number }
        const s = stats.get(row.group_id) || { total: 0, done: 0, failed: 0 }
        s.total += row.n
        if (row.state === 'done') s.done += row.n
        if (row.state === 'failed') s.failed += row.n
        stats.set(row.group_id, s)
      }
      const ffComplete = new Map<string, boolean>()
      for (const raw of ffRes.results || []) {
        const row = raw as { group_id: string; complete: number }
        ffComplete.set(row.group_id, row.complete === 1)
      }
      const candidates = (candRes.results || []) as unknown as CandidateRow[]

      const summaries: GroupSummary[] = groups.map(g => {
        const s = stats.get(g.group_id) || { total: 0, done: 0, failed: 0 }
        const ahead = competingAhead(g, candidates)
        return {
          ...g,
          days_total: s.total,
          days_done: s.done,
          days_failed: s.failed,
          function_form_complete: ffComplete.get(g.group_id) ?? false,
          missing_fields: missingFields(g),
          queue_position: ahead,
          competing_ahead: ahead,
        }
      })

      return Response.json({ groups: summaries })
    }

    return bad('Pass mine=1 for your bookings, or id=<group_id> for one booking.')
  } catch (err) {
    console.error('Groups query error', err)
    return Response.json({ error: 'Query failed' }, { status: 500 })
  }
}

// ── PATCH /api/groups ─────────────────────────────────────────────────────────

export async function PATCH(request: Request): Promise<Response> {
  let body: Partial<CreateGroupRequest> & { group_id?: unknown }
  try {
    body = await request.json() as Partial<CreateGroupRequest> & { group_id?: unknown }
  } catch {
    return bad('Request body must be valid JSON.')
  }

  const group_id = optionalString(body.group_id)
  if (!group_id) return bad('group_id is required.')
  if (body.date_from !== undefined || body.date_to !== undefined || body.weekdays !== undefined) {
    return bad('Date and weekday changes are not supported yet — please cancel this booking and rebook with the new dates.')
  }

  // Whitelisted column -> new value; keys below are literal column names only.
  const updates: Record<string, string | number | null> = {}

  if (body.event_name !== undefined) {
    const v = optionalString(body.event_name)
    if (!v) return bad('The event name cannot be blank.')
    updates.event_name = v
  }
  if (body.department !== undefined) {
    const v = optionalString(body.department)
    if (!v) return bad('The department cannot be blank.')
    updates.department = v
  }
  if (body.locations !== undefined) {
    const locations = Array.isArray(body.locations)
      ? body.locations.filter((r): r is string => typeof r === 'string' && r.trim() !== '').map(r => r.trim())
      : []
    if (locations.length === 0) return bad('Please pick at least one room.')
    const unknownRoom = locations.find(r => !ROOM_NAMES.includes(r))
    if (unknownRoom) return bad(`"${unknownRoom}" is not a bookable room. Please pick rooms from the list.`)
    updates.location = locations.join(', ')
  }
  if (body.contact_name !== undefined) {
    const v = optionalString(body.contact_name)
    if (!v) return bad('The contact name cannot be blank.')
    updates.contact_name = v
  }
  if (body.email !== undefined) {
    const v = optionalString(body.email)
    if (!v || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) return bad('Please provide a valid email address.')
    updates.email = v
  }
  if (body.phone !== undefined) updates.phone = optionalString(body.phone)
  if (body.description !== undefined) updates.description = optionalString(body.description)
  if (body.count !== undefined) {
    if (body.count === null || String(body.count).trim() === '') {
      updates.count = null
    } else {
      const n = Number(body.count)
      if (!Number.isFinite(n) || n < 0) return bad('Attendee count must be a number.')
      updates.count = Math.round(n)
    }
  }
  for (const f of TIME_FIELDS) {
    if (body[f] !== undefined) {
      const v = optionalString(body[f])
      if (v && !TIME_RE.test(v)) {
        return bad(`"${v}" is not a valid ${f.replace(/_/g, ' ')} — use 24-hour HH:MM (for example 14:30).`)
      }
      updates[f] = v
    }
  }
  if (body.run_time !== undefined) updates.run_time = optionalString(body.run_time)

  const cols = Object.keys(updates)
  if (cols.length === 0) return bad('No editable fields were provided.')

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

    const setClause = cols.map(c => `${c} = ?`).join(', ')
    await db.prepare(`UPDATE event_groups SET ${setClause}, updated_at = datetime('now') WHERE group_id = ?`)
      .bind(...cols.map(c => updates[c]), group_id)
      .run()

    // One 'edit' job per day that already has a completed 'create' job; the
    // UNIQUE(group_id, form, action, event_date) constraint dedupes re-edits.
    const doneRes = await db.prepare(`
      SELECT event_date FROM submission_jobs
      WHERE group_id = ? AND form = 'event' AND action = 'create' AND state = 'done' AND event_date IS NOT NULL
      ORDER BY event_date ASC
    `).bind(group_id).all()
    const doneDates = ((doneRes.results || []) as unknown as { event_date: string }[]).map(r => r.event_date)

    let jobs_enqueued = 0
    if (doneDates.length > 0) {
      const payload = JSON.stringify(updates)
      const results = await db.batch(doneDates.map(day =>
        db.prepare(`
          INSERT OR IGNORE INTO submission_jobs (group_id, form, action, event_date, payload, state)
          VALUES (?, 'event', 'edit', ?, ?, 'pending')
        `).bind(group_id, day, payload),
      ))
      for (const r of results) jobs_enqueued += r.meta?.changes ?? 0
    }

    await kickDrain(request)

    return Response.json({ ok: true, jobs_enqueued })
  } catch (err) {
    console.error('Group edit failed', err)
    return Response.json({ error: 'Could not update the booking. Please try again.' }, { status: 500 })
  }
}
