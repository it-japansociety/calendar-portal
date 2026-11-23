// POST /api/admin/action — admin console verbs against the workflow:
//   confirm  admin-override confirm of a group (function form NOT required)
//   release  release a group's mirror events + cancel the group
//   retry    reset a group's failed jobs to pending and kick the drain
//   undo     reverse a logged rule_actions status change
// Dev stage: everything acts on the local mirror rows (events table) only.
import { getDB } from '@/lib/cloudflare'
import { getUserEmail, isAdmin } from '@/lib/identity'
import type { EventGroup, RuleAction } from '@/lib/workflow-types'

interface ActionBody {
  action?: string
  group_id?: string
  rule_action_id?: number
  on_behalf_of?: string
}

function bad(message: string): Response {
  return Response.json({ ok: false, error: message }, { status: 400 })
}

function logAction(db: D1Database, a: {
  rule: string
  group_id?: string | null
  event_id?: number | null
  jotform_id?: string | null
  detail?: string | null
  before_status?: string | null
  after_status?: string | null
  actor: string
}): D1PreparedStatement {
  return db.prepare(`
    INSERT INTO rule_actions
      (rule, group_id, event_id, jotform_id, detail, before_status, after_status, dry_run, actor)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)
  `).bind(
    a.rule, a.group_id ?? null, a.event_id ?? null, a.jotform_id ?? null,
    a.detail ?? null, a.before_status ?? null, a.after_status ?? null, a.actor,
  )
}

// A group-level status change mirrors into the events table with event-status
// vocabulary; this maps between the two when reversing.
function groupToEventStatus(groupStatus: string | null): string {
  const s = (groupStatus || '').toLowerCase()
  if (s === 'confirmed') return 'Confirmed'
  if (s === 'cancelled') return 'Released'
  return 'Pending'
}

export async function POST(request: Request): Promise<Response> {
  const email = getUserEmail(request)
  if (!isAdmin(email)) {
    return Response.json({ error: 'Admin access required' }, { status: 403 })
  }

  let body: ActionBody
  try {
    body = await request.json() as ActionBody
  } catch {
    return bad('Request body must be JSON')
  }

  const action = body.action || ''
  if (!['confirm', 'release', 'retry', 'undo'].includes(action)) {
    return bad(`Unknown action "${action}" — expected confirm, release, retry, or undo`)
  }

  let db: D1Database
  try {
    db = await getDB()
  } catch (err) {
    console.error(err)
    return Response.json({ error: 'Database not configured' }, { status: 503 })
  }

  const actor = `admin:${email}` + (body.on_behalf_of ? ` on behalf of ${body.on_behalf_of}` : '')

  try {
    // ── confirm: admin override — no function-form completeness required ─────
    if (action === 'confirm') {
      if (!body.group_id) return bad('confirm needs a group_id')
      const g = await db.prepare('SELECT * FROM event_groups WHERE group_id = ?')
        .bind(body.group_id).first<EventGroup>()
      if (!g) return bad('Booking not found')
      if (g.status === 'cancelled') return bad('This booking was cancelled — it cannot be confirmed')
      if (g.status === 'confirmed') return bad('This booking is already confirmed')

      const [evRes] = await db.batch([
        db.prepare(`
          UPDATE events SET status = 'Confirmed', updated_at = datetime('now')
          WHERE group_id = ? AND status NOT IN ('Released', 'Cancelled')
        `).bind(g.group_id),
        db.prepare(`
          UPDATE event_groups SET status = 'confirmed', updated_at = datetime('now')
          WHERE group_id = ?
        `).bind(g.group_id),
        logAction(db, {
          rule: 'admin_confirm',
          group_id: g.group_id,
          detail: 'admin override: confirmed without requiring function form completeness',
          before_status: g.status,
          after_status: 'confirmed',
          actor,
        }),
      ])
      return Response.json({ ok: true, result: { events_confirmed: evRes.meta.changes || 0 } })
    }

    // ── release: mirror rows -> Released, group -> cancelled ─────────────────
    if (action === 'release') {
      if (!body.group_id) return bad('release needs a group_id')
      const g = await db.prepare('SELECT * FROM event_groups WHERE group_id = ?')
        .bind(body.group_id).first<EventGroup>()
      if (!g) return bad('Booking not found')

      const [evRes] = await db.batch([
        db.prepare(`
          UPDATE events SET status = 'Released', updated_at = datetime('now')
          WHERE group_id = ? AND status != 'Released'
        `).bind(g.group_id),
        db.prepare(`
          UPDATE event_groups SET status = 'cancelled', updated_at = datetime('now')
          WHERE group_id = ?
        `).bind(g.group_id),
        logAction(db, {
          rule: 'admin_release',
          group_id: g.group_id,
          detail: 'would email contact + boxoffice@',
          before_status: g.status,
          after_status: 'cancelled',
          actor,
        }),
      ])
      return Response.json({ ok: true, result: { events_released: evRes.meta.changes || 0 } })
    }

    // ── retry: reset failed jobs, kick the drain ─────────────────────────────
    if (action === 'retry') {
      if (!body.group_id) return bad('retry needs a group_id')
      const reset = await db.prepare(`
        UPDATE submission_jobs SET state = 'pending', attempts = 0, updated_at = datetime('now')
        WHERE group_id = ? AND state = 'failed'
      `).bind(body.group_id).run()
      const n = reset.meta.changes || 0
      if (n === 0) return bad('No failed jobs to retry for this booking')

      let drain: unknown = null
      try {
        const res = await fetch(new URL('/api/queue/drain', request.url), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ max: 50 }),
        })
        drain = await res.json()
      } catch {
        drain = { error: 'drain kick failed — jobs stay pending until the next drain' }
      }

      await logAction(db, {
        rule: 'retry',
        group_id: body.group_id,
        detail: `reset ${n} failed job(s) to pending and kicked the drain`,
        actor,
      }).run()
      return Response.json({ ok: true, result: { jobs_reset: n, drain } })
    }

    // ── undo: reverse a logged status change ─────────────────────────────────
    if (action === 'undo') {
      if (body.rule_action_id === undefined || body.rule_action_id === null) {
        return bad('undo needs a rule_action_id')
      }
      const ra = await db.prepare('SELECT * FROM rule_actions WHERE id = ?')
        .bind(body.rule_action_id).first<RuleAction>()
      if (!ra) return bad('Logged action not found')
      if (ra.undone === 1) return bad('That action was already undone')
      if (ra.rule === 'undo') return bad('An undo cannot itself be undone')

      const statements: D1PreparedStatement[] = []
      const isStatusChange = ra.before_status !== null && ra.before_status !== ''

      if (isStatusChange) {
        if (ra.event_id !== null && ra.event_id !== undefined) {
          statements.push(db.prepare(`
            UPDATE events SET status = ?, updated_at = datetime('now') WHERE id = ?
          `).bind(ra.before_status, ra.event_id))
        } else if (ra.jotform_id) {
          statements.push(db.prepare(`
            UPDATE events SET status = ?, updated_at = datetime('now') WHERE jotform_id = ?
          `).bind(ra.before_status, ra.jotform_id))
        } else if (ra.group_id) {
          statements.push(db.prepare(`
            UPDATE event_groups SET status = ?, updated_at = datetime('now') WHERE group_id = ?
          `).bind(ra.before_status, ra.group_id))
          // Mirror rows follow the group: rows the original action moved to the
          // after-state go back to the before-state equivalent.
          statements.push(db.prepare(`
            UPDATE events SET status = ?, updated_at = datetime('now')
            WHERE group_id = ? AND status = ?
          `).bind(
            groupToEventStatus(ra.before_status),
            ra.group_id,
            groupToEventStatus(ra.after_status),
          ))
        }
      }

      statements.push(db.prepare(
        `UPDATE rule_actions SET undone = 1 WHERE id = ?`,
      ).bind(ra.id))
      statements.push(logAction(db, {
        rule: 'undo',
        group_id: ra.group_id,
        event_id: ra.event_id,
        jotform_id: ra.jotform_id,
        detail: `undo of rule_action #${ra.id} (${ra.rule})` +
          (isStatusChange ? '' : ' — no status change to reverse; marked undone only'),
        before_status: ra.after_status,
        after_status: ra.before_status,
        actor,
      }))

      await db.batch(statements)
      return Response.json({
        ok: true,
        result: { undone_action: ra.id, reversed_status_change: isStatusChange },
      })
    }

    return bad('Unhandled action')
  } catch (err) {
    console.error('Admin action error', err)
    return Response.json({ ok: false, error: 'Action failed — check the server logs' }, { status: 500 })
  }
}
