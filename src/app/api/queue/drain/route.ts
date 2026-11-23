// POST /api/queue/drain — drains the submission_jobs queue.
//
// Phase 1 is DRY-RUN ONLY (settings.live_mode='0'): the queue NEVER calls
// JotForm. Instead jobs act on the local events mirror so the calendar and
// availability checker show the booking:
//   create  -> done with jotform_id 'dryrun-<group8>-<date>' + mirror row INSERT
//   edit    -> mirror rows re-synced from the current event_groups row
//   release -> mirror rows' status set to 'Released'
// The live_mode='1' path is present (buildEventSubmission/createSubmission/
// editSubmission) but does not run in this phase.
import { getDB } from '@/lib/cloudflare'
import { runRules } from '@/lib/rules'
import {
  buildEventSubmission, createSubmission, editSubmission,
  EVENT_FORM_ID, FUNCTION_FORM_ID,
} from '@/lib/jotform-client'
import type { DrainResult, EventGroup, SubmissionJob } from '@/lib/workflow-types'

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

function dryRunId(groupId: string, suffix: string): string {
  return `dryrun-${groupId.slice(0, 8)}-${suffix}`
}

function dayOfWeekFor(isoDate: string): string {
  const d = new Date(`${isoDate}T12:00:00Z`)
  return Number.isNaN(d.getTime()) ? '' : WEEKDAYS[d.getUTCDay()]
}

// Process one claimed job. Returns the jotform_id to record on the job (null
// keeps whatever the job already has). Throws on failure — the caller handles
// attempts/state bookkeeping.
async function processJob(
  db: D1Database, job: SubmissionJob, group: EventGroup, liveMode: boolean,
): Promise<string | null> {
  if (!liveMode) {
    // ── DRY-RUN: act on the local events mirror only ──────────────────────────
    if (job.form === 'function') {
      // The function form has no per-day calendar mirror; just mark it fanned
      // out locally so the group can roll up.
      const jid = dryRunId(job.group_id, 'function')
      await db
        .prepare(
          `UPDATE function_forms SET jotform_id = ?, updated_at = datetime('now')
           WHERE group_id = ? AND jotform_id IS NULL`,
        )
        .bind(jid, job.group_id)
        .run()
      return jid
    }

    if (job.action === 'create') {
      if (!job.event_date) throw new Error('create job missing event_date')
      const jid = dryRunId(job.group_id, job.event_date)
      await db
        .prepare(
          `INSERT INTO events
             (event_name, department, location, event_date, day_of_week,
              event_start, event_end, hold_start, hold_end,
              contact_name, email, phone, description,
              status, jotform_id, group_id, submitted_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Pending', ?, ?, datetime('now'), datetime('now'))
           ON CONFLICT(jotform_id) DO NOTHING`,
        )
        .bind(
          group.event_name,
          group.department,
          group.location,
          job.event_date,
          dayOfWeekFor(job.event_date),
          group.event_start ?? '',
          group.event_end ?? '',
          group.hold_start,
          group.hold_end,
          group.contact_name ?? '',
          group.email ?? '',
          group.phone,
          group.description,
          jid,
          job.group_id,
        )
        .run()
      return jid
    }

    if (job.action === 'release') {
      if (job.event_date) {
        await db
          .prepare(
            `UPDATE events SET status = 'Released', updated_at = datetime('now')
             WHERE group_id = ? AND event_date = ?`,
          )
          .bind(job.group_id, job.event_date)
          .run()
        return dryRunId(job.group_id, job.event_date)
      }
      await db
        .prepare(
          `UPDATE events SET status = 'Released', updated_at = datetime('now')
           WHERE group_id = ?`,
        )
        .bind(job.group_id)
        .run()
      return null
    }

    // 'edit': re-sync mirror rows from the current group fields (the group row
    // is the source of truth after a PATCH; payload is kept for the live path).
    const setSql = `UPDATE events SET
        event_name = ?, department = ?, location = ?,
        event_start = ?, event_end = ?, hold_start = ?, hold_end = ?,
        contact_name = ?, email = ?, phone = ?, description = ?,
        updated_at = datetime('now')`
    const binds: (string | null)[] = [
      group.event_name, group.department, group.location,
      group.event_start ?? '', group.event_end ?? '',
      group.hold_start, group.hold_end,
      group.contact_name ?? '', group.email ?? '',
      group.phone, group.description,
    ]
    if (job.event_date) {
      await db
        .prepare(`${setSql} WHERE group_id = ? AND event_date = ?`)
        .bind(...binds, job.group_id, job.event_date)
        .run()
      return dryRunId(job.group_id, job.event_date)
    }
    await db.prepare(`${setSql} WHERE group_id = ?`).bind(...binds, job.group_id).run()
    return null
  }

  // ── LIVE MODE (live_mode='1'): calls JotForm. Present for P2, does not run
  // in Phase 1 — the dev database keeps live_mode='0'. ─────────────────────────
  const apiKey = process.env.JOTFORM_API_KEY || ''
  if (!apiKey) throw new Error('JOTFORM_API_KEY not configured')

  if (job.form === 'function') {
    if (!FUNCTION_FORM_ID) throw new Error('Function form not configured in JotForm yet')
    throw new Error('Function form fan-out not implemented (P2)')
  }

  if (job.action === 'create') {
    if (!job.event_date) throw new Error('create job missing event_date')
    return await createSubmission(apiKey, EVENT_FORM_ID, buildEventSubmission(group, job.event_date))
  }

  // edit / release target the submission recorded on the mirror row for that day.
  const target = job.event_date
    ? await db
        .prepare(`SELECT jotform_id FROM events WHERE group_id = ? AND event_date = ?`)
        .bind(job.group_id, job.event_date)
        .first<{ jotform_id: string | null }>()
    : null
  const submissionId = target?.jotform_id || job.jotform_id
  if (!submissionId) throw new Error(`no submission id for ${job.action} job ${job.id}`)

  if (job.action === 'release') {
    await editSubmission(apiKey, submissionId, { 'submission[12]': 'Released' })
    return submissionId
  }
  await editSubmission(apiKey, submissionId, buildEventSubmission(group, job.event_date || group.date_from))
  return submissionId
}

// Recompute one group's rollup status after its jobs changed.
// cancelled stays cancelled; any failed job -> partial_error; all jobs done ->
// active (confirmed stays confirmed); otherwise still creating.
async function rollupGroup(db: D1Database, groupId: string): Promise<void> {
  const g = await db
    .prepare(`SELECT status FROM event_groups WHERE group_id = ?`)
    .bind(groupId)
    .first<{ status: string }>()
  if (!g || g.status === 'cancelled') return

  const counts = await db
    .prepare(
      `SELECT
         SUM(CASE WHEN state = 'failed' THEN 1 ELSE 0 END) AS failed,
         SUM(CASE WHEN state != 'done' THEN 1 ELSE 0 END) AS not_done
       FROM submission_jobs WHERE group_id = ?`,
    )
    .bind(groupId)
    .first<{ failed: number | null; not_done: number | null }>()

  const failedN = counts?.failed ?? 0
  const notDone = counts?.not_done ?? 0
  let next: string
  if (failedN > 0) next = 'partial_error'
  else if (notDone === 0) next = g.status === 'confirmed' ? 'confirmed' : 'active'
  else next = 'creating'

  if (next !== g.status) {
    await db
      .prepare(`UPDATE event_groups SET status = ?, updated_at = datetime('now') WHERE group_id = ?`)
      .bind(next, groupId)
      .run()
  }
}

export async function POST(request: Request): Promise<Response> {
  let body: { max?: number } = {}
  try {
    body = await request.json() as { max?: number }
  } catch {
    // Empty/absent body is fine — defaults apply.
  }
  const requested = typeof body.max === 'number' && Number.isFinite(body.max) ? body.max : 25
  const max = Math.min(100, Math.max(1, Math.floor(requested)))

  let db: D1Database
  try {
    db = await getDB()
  } catch (err) {
    console.error(err)
    return Response.json({ error: 'Database not configured' }, { status: 503 })
  }

  try {
    const liveModeRow = await db
      .prepare(`SELECT value FROM settings WHERE key = 'live_mode'`)
      .first<{ value: string }>()
    const liveMode = (liveModeRow?.value ?? '0') === '1'

    // Claim up to max pending jobs oldest-first. D1 has no SELECT FOR UPDATE;
    // single-writer semantics are fine for this queue.
    await db
      .prepare(
        `UPDATE submission_jobs SET state = 'in_flight', updated_at = datetime('now')
         WHERE id IN (SELECT id FROM submission_jobs WHERE state = 'pending' ORDER BY id LIMIT ?)`,
      )
      .bind(max)
      .run()

    const claimed = ((await db
      .prepare(`SELECT * FROM submission_jobs WHERE state = 'in_flight' ORDER BY id LIMIT ?`)
      .bind(max)
      .all()).results || []) as unknown as SubmissionJob[]

    const groupCache = new Map<string, EventGroup | null>()
    const touched = new Set<string>()
    let done = 0
    let failed = 0

    for (const job of claimed) {
      touched.add(job.group_id)
      try {
        let group = groupCache.get(job.group_id)
        if (group === undefined) {
          group = (await db
            .prepare(`SELECT * FROM event_groups WHERE group_id = ?`)
            .bind(job.group_id)
            .first<EventGroup>()) ?? null
          groupCache.set(job.group_id, group)
        }
        if (!group) throw new Error(`group ${job.group_id} not found`)

        const jotformId = await processJob(db, job, group, liveMode)
        await db
          .prepare(
            `UPDATE submission_jobs
             SET state = 'done', jotform_id = COALESCE(?, jotform_id),
                 last_error = NULL, updated_at = datetime('now')
             WHERE id = ?`,
          )
          .bind(jotformId, job.id)
          .run()
        done++
      } catch (err) {
        const message = (err instanceof Error ? err.message : String(err)).slice(0, 500)
        const nowFailed = job.attempts + 1 >= 3
        await db
          .prepare(
            `UPDATE submission_jobs
             SET attempts = attempts + 1,
                 state = CASE WHEN attempts + 1 >= 3 THEN 'failed' ELSE 'pending' END,
                 last_error = ?, updated_at = datetime('now')
             WHERE id = ?`,
          )
          .bind(message, job.id)
          .run()
        if (nowFailed) failed++
      }
    }

    for (const groupId of touched) {
      await rollupGroup(db, groupId)
    }

    const remainingRow = await db
      .prepare(`SELECT COUNT(*) AS n FROM submission_jobs WHERE state = 'pending'`)
      .first<{ n: number }>()
    const remaining = remainingRow?.n ?? 0

    // Keep rule flags fresh after every drain; the drain result must not fail
    // because a rule query did.
    try {
      await runRules(db, { dryRun: true })
    } catch (err) {
      console.error('rules engine error after drain (swallowed)', err)
    }

    const result: DrainResult = { drained: claimed.length, done, failed, remaining, live_mode: liveMode }
    return Response.json(result)
  } catch (err) {
    console.error('Queue drain error', err)
    return Response.json({ error: 'Drain failed' }, { status: 500 })
  }
}
