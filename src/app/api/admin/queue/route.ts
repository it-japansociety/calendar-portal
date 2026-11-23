// GET /api/admin/queue — admin console feed: every non-cancelled event group
// enriched like GroupSummary, plus rule flags, failed jobs, age, the recent
// rule_actions audit trail, and a count of legacy JotForm-direct pending events.
import { getDB } from '@/lib/cloudflare'
import { getUserEmail, isAdmin } from '@/lib/identity'
import { roomsInLocation } from '@/lib/rooms'
import { REQUIRED_EVENT_FIELDS } from '@/lib/workflow-types'
import type { EventGroup, GroupSummary, RuleAction } from '@/lib/workflow-types'

interface JobLite {
  id: number
  group_id: string
  form: string
  action: string
  event_date: string | null
  state: string
  last_error: string | null
  jotform_id: string | null
}

interface FlagRow {
  id: number
  rule: string
  group_id: string | null
  jotform_id: string | null
  detail: string | null
  created_at: string
}

export interface AdminQueueRow extends GroupSummary {
  flags: { id: number; rule: string; detail: string | null; jotform_id: string | null; created_at: string }[]
  failed_jobs: { id: number; event_date: string | null; last_error: string | null }[]
  age_days: number
}

export async function GET(request: Request): Promise<Response> {
  const email = getUserEmail(request)
  if (!isAdmin(email)) {
    return Response.json({ error: 'Admin access required' }, { status: 403 })
  }

  let db: D1Database
  try {
    db = await getDB()
  } catch (err) {
    console.error(err)
    return Response.json({ error: 'Database not configured' }, { status: 503 })
  }

  try {
    const [groupsRes, jobsRes, ffRes, flagsRes, recentRes, legacyRes] = await db.batch([
      db.prepare(`
        SELECT *, julianday('now') - julianday(created_at) AS age_days
        FROM event_groups
        WHERE status != 'cancelled'
        ORDER BY created_at ASC, group_id ASC
      `),
      db.prepare(`
        SELECT id, group_id, form, action, event_date, state, last_error, jotform_id
        FROM submission_jobs
        WHERE group_id IN (SELECT group_id FROM event_groups WHERE status != 'cancelled')
      `),
      db.prepare(`SELECT group_id, complete FROM function_forms`),
      db.prepare(`
        SELECT id, rule, group_id, jotform_id, detail, created_at
        FROM rule_actions
        WHERE undone = 0
        ORDER BY id DESC
        LIMIT 500
      `),
      db.prepare(`SELECT * FROM rule_actions ORDER BY id DESC LIMIT 50`),
      db.prepare(`SELECT COUNT(*) AS n FROM events WHERE status = 'Pending' AND group_id IS NULL`),
    ])

    const rawGroups = (groupsRes.results || []) as unknown as (EventGroup & { age_days: number })[]
    const jobs = (jobsRes.results || []) as unknown as JobLite[]
    const ffRows = (ffRes.results || []) as unknown as { group_id: string; complete: number }[]
    const flagRows = (flagsRes.results || []) as unknown as FlagRow[]
    const recent_actions = (recentRes.results || []) as unknown as RuleAction[]
    const legacy_pending_count =
      ((legacyRes.results?.[0] as { n: number } | undefined)?.n) || 0

    // Index jobs by group, and jotform ids back to their group so rule flags
    // logged against a submission id still surface on the right booking.
    const jobsByGroup = new Map<string, JobLite[]>()
    const groupByJotform = new Map<string, string>()
    for (const j of jobs) {
      const list = jobsByGroup.get(j.group_id) || []
      list.push(j)
      jobsByGroup.set(j.group_id, list)
      if (j.jotform_id) groupByJotform.set(j.jotform_id, j.group_id)
    }

    const ffComplete = new Map(ffRows.map(r => [r.group_id, r.complete === 1]))
    const roomsByGroup = new Map(rawGroups.map(g => [g.group_id, roomsInLocation(g.location)]))

    const groups: AdminQueueRow[] = rawGroups.map(g => {
      const gJobs = jobsByGroup.get(g.group_id) || []
      const createJobs = gJobs.filter(j => j.form === 'event' && j.action === 'create')
      const days_total = createJobs.length
      const days_done = createJobs.filter(j => j.state === 'done').length
      const days_failed = createJobs.filter(j => j.state === 'failed').length

      const missing_fields = REQUIRED_EVENT_FIELDS.filter(f => {
        const v = g[f]
        return v === null || v === undefined || String(v).trim() === ''
      }) as string[]

      // Competition: earlier-created, non-cancelled groups whose date range
      // overlaps and that share at least one canonical room.
      const myRooms = roomsByGroup.get(g.group_id) || new Set<string>()
      let competing_ahead = 0
      if (myRooms.size > 0) {
        for (const h of rawGroups) {
          if (h.group_id === g.group_id) continue
          const earlier = h.created_at < g.created_at ||
            (h.created_at === g.created_at && h.group_id < g.group_id)
          if (!earlier) continue
          if (h.date_from > g.date_to || h.date_to < g.date_from) continue
          const theirRooms = roomsByGroup.get(h.group_id) || new Set<string>()
          let shares = false
          for (const r of theirRooms) {
            if (myRooms.has(r)) { shares = true; break }
          }
          if (shares) competing_ahead++
        }
      }

      const flags = flagRows
        .filter(f =>
          (f.group_id && f.group_id === g.group_id) ||
          (f.jotform_id && groupByJotform.get(f.jotform_id) === g.group_id))
        .map(f => ({
          id: f.id, rule: f.rule, detail: f.detail,
          jotform_id: f.jotform_id, created_at: f.created_at,
        }))

      const failed_jobs = gJobs
        .filter(j => j.state === 'failed')
        .map(j => ({ id: j.id, event_date: j.event_date, last_error: j.last_error }))

      const { age_days, ...groupFields } = g
      return {
        ...groupFields,
        days_total,
        days_done,
        days_failed,
        function_form_complete: ffComplete.get(g.group_id) || false,
        missing_fields,
        queue_position: competing_ahead,
        competing_ahead,
        flags,
        failed_jobs,
        age_days: Math.round(age_days * 10) / 10,
      }
    })

    return Response.json({ groups, recent_actions, legacy_pending_count })
  } catch (err) {
    console.error('Admin queue query error', err)
    return Response.json({ error: 'Query failed' }, { status: 500 })
  }
}
