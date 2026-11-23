// GET/POST /api/function-form — read + upsert a group's function form.
// GET  ?group=<id>  -> { group: EventGroup, form: FunctionFormRow | null }
// POST { group_id, data: FunctionFormData, complete: boolean } -> { ok, complete }
// Ownership: the group's contact email or created_by must match the caller
// (isAdmin bypasses). A complete=true save kicks the rules engine (dry-run,
// fire-and-forget) so auto-confirm can evaluate the group right away.
import { getCloudflareContext } from '@opennextjs/cloudflare'
import { getDB } from '@/lib/cloudflare'
import { getUserEmail, isAdmin } from '@/lib/identity'
import type { EventGroup, FunctionFormData, FunctionFormRow } from '@/lib/workflow-types'

// Field groups from the real paper Function Form (workflow-types.ts), split
// by storage kind since each needs its own sanitizing rule below.
const STRING_FIELDS: (keyof FunctionFormData)[] = [
  'staff_in_charge', 'prep_time_from', 'clean_up_to', 'check_in_open', 'doors_open', 'run_time',
  'sponsors_co_organizers', 'guest_count', 'dept_project_codes', 'schedule',
  'gallery_hours_note',
  'butlers_qty', 'butlers_from', 'butlers_to', 'coat_check_from', 'coat_check_to',
  'box_office_early', 'staff_notes',
  'bento_qty', 'senbei_location', 'dietary_restrictions', 'fnb_notes',
  'mics_wireless_qty', 'mics_wired_qty', 'platforms_qty', 'whiteboards_qty',
  'table_skirts_qty', 'folding_screens_qty', 'easels_qty', 'stanchions_qty',
  'coat_racks_qty', 'aud_rows_covered_qty', 'av_notes',
  'additional_comments',
]
// Enum-like string fields — stored the same as STRING_FIELDS, but callers
// may legitimately send '' to mean "explicitly none" rather than "unset", so
// an empty string is kept rather than dropped.
const ENUM_FIELDS: (keyof FunctionFormData)[] = [
  'reception', 'laptop', 'laptop_location', 'stream', 'stage_panels', 'waterfall',
]
const BOOL_FIELDS: (keyof FunctionFormData)[] = [
  'intermission', 'latecomer_admitted', 'gallery_open_beyond_hours',
  'ticket_takers', 'coat_check', 'party_rentals', 'av_tech_booked',
]
const ARRAY_FIELDS: (keyof FunctionFormData)[] = ['extra_spaces', 'fnb', 'av']

// Keep only known FunctionFormData fields, coerced to their expected shape.
function sanitizeFunctionForm(raw: Record<string, unknown>): FunctionFormData {
  const out: Record<string, unknown> = {}
  for (const key of STRING_FIELDS) {
    const v = raw[key]
    if (typeof v === 'string' && v.trim()) out[key] = v.trim()
    else if (typeof v === 'number' && Number.isFinite(v)) out[key] = String(v)
  }
  for (const key of ENUM_FIELDS) {
    const v = raw[key]
    if (typeof v === 'string') out[key] = v.trim()
  }
  for (const key of BOOL_FIELDS) {
    const v = raw[key]
    if (typeof v === 'boolean') out[key] = v
  }
  for (const key of ARRAY_FIELDS) {
    const v = raw[key]
    if (Array.isArray(v)) {
      const cleaned = v.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map(x => x.trim())
      if (cleaned.length > 0) out[key] = cleaned
    }
  }
  return out as FunctionFormData
}

function canAccess(group: EventGroup, email: string): boolean {
  if (isAdmin(email)) return true
  return email === (group.email || '').toLowerCase()
    || email === (group.created_by || '').toLowerCase()
}

export async function GET(request: Request): Promise<Response> {
  const groupId = new URL(request.url).searchParams.get('group') || ''
  if (!groupId) {
    return Response.json({ error: 'Missing group parameter' }, { status: 400 })
  }

  let db: D1Database
  try {
    db = await getDB()
  } catch (err) {
    console.error(err)
    return Response.json({ error: 'Database not configured' }, { status: 503 })
  }

  try {
    const group = await db
      .prepare('SELECT * FROM event_groups WHERE group_id = ?')
      .bind(groupId)
      .first<EventGroup>()
    if (!group) {
      return Response.json({ error: 'Booking not found' }, { status: 404 })
    }

    if (!canAccess(group, getUserEmail(request))) {
      return Response.json({ error: 'You do not have access to this booking' }, { status: 403 })
    }

    const form = await db
      .prepare('SELECT * FROM function_forms WHERE group_id = ?')
      .bind(groupId)
      .first<FunctionFormRow>()

    return Response.json({ group, form: form ?? null })
  } catch (err) {
    console.error('Function form query error', err)
    return Response.json({ error: 'Query failed' }, { status: 500 })
  }
}

export async function POST(request: Request): Promise<Response> {
  let body: { group_id?: unknown; data?: unknown; complete?: unknown }
  try {
    body = await request.json() as { group_id?: unknown; data?: unknown; complete?: unknown }
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const groupId = typeof body.group_id === 'string' ? body.group_id.trim() : ''
  if (!groupId) {
    return Response.json({ error: 'group_id is required' }, { status: 400 })
  }

  // Keep only the known function-form fields, coerced to their expected shape.
  const raw = (body.data && typeof body.data === 'object' ? body.data : {}) as Record<string, unknown>
  const data = sanitizeFunctionForm(raw)

  // Server-side completeness gate: staff in charge + guest count present.
  // The client only offers Submit once both are filled in, but the caller's
  // `complete` flag is not trusted on its own — it is honored only when the
  // sanitized data actually satisfies this.
  const requestedComplete = body.complete === true
  const complete = requestedComplete && Boolean(data.staff_in_charge && data.guest_count)

  let db: D1Database
  try {
    db = await getDB()
  } catch (err) {
    console.error(err)
    return Response.json({ error: 'Database not configured' }, { status: 503 })
  }

  try {
    const group = await db
      .prepare('SELECT * FROM event_groups WHERE group_id = ?')
      .bind(groupId)
      .first<EventGroup>()
    if (!group) {
      return Response.json({ error: 'Booking not found' }, { status: 404 })
    }

    if (!canAccess(group, getUserEmail(request))) {
      return Response.json({ error: 'You do not have access to this booking' }, { status: 403 })
    }

    await db
      .prepare(`
        INSERT INTO function_forms (group_id, data, complete, updated_at)
        VALUES (?, ?, ?, datetime('now'))
        ON CONFLICT(group_id) DO UPDATE SET
          data = excluded.data,
          complete = excluded.complete,
          updated_at = datetime('now')
      `)
      .bind(groupId, JSON.stringify(data), complete ? 1 : 0)
      .run()

    if (complete) {
      // Fire-and-forget: let the rules engine evaluate auto-confirm now that
      // the function form is in. Failures are non-fatal — rules also run on
      // their own schedule.
      const kick = fetch(new URL('/api/rules/run', request.url), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dry_run: true }),
      }).then(() => undefined).catch(() => undefined)
      try {
        const { ctx } = await getCloudflareContext()
        ctx.waitUntil(kick)
      } catch {
        // Dev server without a workers context: the un-awaited promise still runs.
      }
    }

    return Response.json({ ok: true, complete })
  } catch (err) {
    console.error('Function form save error', err)
    return Response.json({ error: 'Save failed' }, { status: 500 })
  }
}
