// Rules engine for Booking Workflow v2 (Phase 1, dev stage, DRY-RUN ONLY).
//
// Three rules run against the local D1 state (event_groups + the events mirror
// rows the dry-run queue maintains):
//   1. auto_confirm — a group whose event side is complete AND whose function
//      form is complete gets its Pending mirror rows confirmed (applied only
//      when dryRun===false; live JotForm edits are a marked TODO for P2).
//   2. hold_expiry  — flags stale tentative holds and tentative holds whose
//      event date is near. Flag only, never writes to events.
//   3. hold_count   — flags contacts holding more tentative spaces than the
//      max_holds_per_contact threshold. Flag only.
//
// Every evaluated action is returned; each is also logged to rule_actions
// unless an identical un-undone row already exists (dedupe so repeated runs
// don't spam the audit log).
import { REQUIRED_EVENT_FIELDS, type EventGroup } from './workflow-types'

// A RuleAction as evaluated by the engine — everything but the DB-assigned id.
export interface EvaluatedRuleAction {
  rule: 'auto_confirm' | 'hold_expiry' | 'hold_count'
  group_id: string | null
  event_id: number | null
  jotform_id: string | null
  detail: string | null
  before_status: string | null
  after_status: string | null
  dry_run: number
  actor: string
  undone: number
  created_at: string
}

export interface RulesSummary {
  evaluated: number      // actions the rules produced this run
  logged: number         // rows actually inserted into rule_actions (post-dedupe)
  applied: number        // mirror rows actually updated (auto_confirm, non-dry, dry-run mode)
  by_rule: Record<string, number>
  dry_run: boolean
  live_mode: boolean
}

export interface RunRulesOptions {
  dryRun: boolean
  // Restrict rule 1 (auto_confirm) to a single group — the admin Confirm
  // button calls POST /api/rules/run with confirm_group_id + dry_run:false.
  confirmGroupId?: string
  // Recorded as rule_actions.actor; defaults to 'rules'.
  actor?: string
}

interface MirrorEventRow {
  id: number
  jotform_id: string | null
}

interface HoldExpiryRow {
  id: number
  group_id: string | null
  jotform_id: string | null
  status: string
  age_days: number | null
  days_until: number | null
  is_stale: number
}

export async function runRules(
  db: D1Database,
  opts: RunRulesOptions,
): Promise<{ actions: EvaluatedRuleAction[]; summary: RulesSummary }> {
  const settingsRes = await db.prepare(`SELECT key, value FROM settings`).all()
  const settings: Record<string, string> = {}
  for (const row of (settingsRes.results || []) as { key: string; value: string }[]) {
    settings[row.key] = row.value
  }
  const liveMode = settings['live_mode'] === '1'
  const holdMaxAgeDays = parseInt(settings['hold_max_age_days'] || '30', 10)
  const nearDateDays = parseInt(settings['near_date_days'] || '14', 10)
  const maxHoldsPerContact = parseInt(settings['max_holds_per_contact'] || '10', 10)

  const dryRunFlag = opts.dryRun ? 1 : 0
  const actor = opts.actor || 'rules'
  // Matches sqlite datetime('now') formatting, so evaluated actions look like
  // their eventual rule_actions rows.
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ')
  const actions: EvaluatedRuleAction[] = []
  let applied = 0

  // ── Rule 1: auto_confirm ────────────────────────────────────────────────────
  let groupsSql = `SELECT * FROM event_groups WHERE status = 'active'`
  const groupBinds: string[] = []
  if (opts.confirmGroupId) {
    groupsSql += ` AND group_id = ?`
    groupBinds.push(opts.confirmGroupId)
  }
  const groups = ((await db.prepare(groupsSql).bind(...groupBinds).all()).results ||
    []) as unknown as EventGroup[]

  for (const g of groups) {
    const missing = REQUIRED_EVENT_FIELDS.filter(f => {
      const v = g[f]
      return v === null || v === undefined || String(v).trim() === ''
    })
    if (missing.length > 0) continue

    const ff = await db
      .prepare(`SELECT complete FROM function_forms WHERE group_id = ?`)
      .bind(g.group_id)
      .first<{ complete: number }>()
    if (!ff || ff.complete !== 1) continue

    const pendingRows = ((await db
      .prepare(
        `SELECT id, jotform_id FROM events
         WHERE group_id = ? AND is_archived = 0 AND status = 'Pending'`,
      )
      .bind(g.group_id)
      .all()).results || []) as unknown as MirrorEventRow[]

    for (const row of pendingRows) {
      actions.push({
        rule: 'auto_confirm',
        group_id: g.group_id,
        event_id: row.id,
        jotform_id: row.jotform_id,
        detail: 'complete: event + function form',
        before_status: 'Pending',
        after_status: 'Confirmed',
        dry_run: dryRunFlag,
        actor,
        undone: 0,
        created_at: now,
      })
    }

    if (!opts.dryRun && pendingRows.length > 0) {
      if (liveMode) {
        // TODO(live, P2): for each mirror row call
        //   editSubmission(JOTFORM_API_KEY, row.jotform_id, { 'submission[12]': 'Confirmed' })
        // from src/lib/jotform-client. Live mode is intentionally inert in
        // Phase 1 (dev stage, dry-run only) — nothing calls JotForm here.
      } else {
        await db
          .prepare(
            `UPDATE events SET status = 'Confirmed', updated_at = datetime('now')
             WHERE group_id = ? AND is_archived = 0 AND status = 'Pending'`,
          )
          .bind(g.group_id)
          .run()
        await db
          .prepare(
            `UPDATE event_groups SET status = 'confirmed', updated_at = datetime('now')
             WHERE group_id = ?`,
          )
          .bind(g.group_id)
          .run()
        applied += pendingRows.length
      }
    }
  }

  // ── Rule 2: hold_expiry (flag only, never writes to events) ─────────────────
  const expiryRows = ((await db
    .prepare(
      `SELECT id, group_id, jotform_id, status,
              CAST(julianday('now') - julianday(submitted_at) AS INTEGER) AS age_days,
              CAST(julianday(event_date) - julianday('now') AS INTEGER) AS days_until,
              (submitted_at IS NOT NULL AND julianday('now') - julianday(submitted_at) > ?) AS is_stale
       FROM events
       WHERE is_archived = 0
         AND status IN ('Pending', 'Contingent', 'TBD')
         AND (
           (submitted_at IS NOT NULL AND julianday('now') - julianday(submitted_at) > ?)
           OR (event_date >= date('now') AND julianday(event_date) - julianday('now') < ?)
         )`,
    )
    .bind(holdMaxAgeDays, holdMaxAgeDays, nearDateDays)
    .all()).results || []) as unknown as HoldExpiryRow[]

  for (const row of expiryRows) {
    const detail = row.is_stale
      ? `stale ${row.age_days ?? '?'} days old`
      : `event in ${row.days_until ?? '?'} days still tentative`
    actions.push({
      rule: 'hold_expiry',
      group_id: row.group_id,
      event_id: row.id,
      jotform_id: row.jotform_id,
      detail,
      before_status: row.status,
      after_status: null,
      dry_run: dryRunFlag,
      actor,
      undone: 0,
      created_at: now,
    })
  }

  // ── Rule 3: hold_count (flag only) ──────────────────────────────────────────
  const countRows = ((await db
    .prepare(
      `SELECT email, COUNT(*) AS n FROM events
       WHERE is_archived = 0
         AND status IN ('Pending', 'Contingent', 'TBD')
         AND email IS NOT NULL AND TRIM(email) != ''
       GROUP BY LOWER(email)
       HAVING COUNT(*) > ?`,
    )
    .bind(maxHoldsPerContact)
    .all()).results || []) as unknown as { email: string; n: number }[]

  for (const row of countRows) {
    actions.push({
      rule: 'hold_count',
      group_id: null,
      event_id: null,
      jotform_id: null,
      detail: `${row.email} holds ${row.n} spaces`,
      before_status: null,
      after_status: null,
      dry_run: dryRunFlag,
      actor,
      undone: 0,
      created_at: now,
    })
  }

  // ── Log to rule_actions with dedupe ─────────────────────────────────────────
  // Skip when an identical un-undone row (rule + jotform_id/group_id + detail)
  // already exists. dry_run is part of the key so a real application (admin
  // Confirm) still gets its own audit row after an earlier dry-run flag.
  let logged = 0
  for (const a of actions) {
    const existing = await db
      .prepare(
        `SELECT id FROM rule_actions
         WHERE rule = ? AND undone = 0
           AND jotform_id IS ? AND group_id IS ? AND detail IS ? AND dry_run = ?
         LIMIT 1`,
      )
      .bind(a.rule, a.jotform_id, a.group_id, a.detail, a.dry_run)
      .first<{ id: number }>()
    if (existing) continue
    await db
      .prepare(
        `INSERT INTO rule_actions
           (rule, group_id, event_id, jotform_id, detail, before_status, after_status, dry_run, actor)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        a.rule, a.group_id, a.event_id, a.jotform_id, a.detail,
        a.before_status, a.after_status, a.dry_run, actor,
      )
      .run()
    logged++
  }

  const byRule: Record<string, number> = {}
  for (const a of actions) byRule[a.rule] = (byRule[a.rule] || 0) + 1

  return {
    actions,
    summary: {
      evaluated: actions.length,
      logged,
      applied,
      by_rule: byRule,
      dry_run: opts.dryRun,
      live_mode: liveMode,
    },
  }
}
