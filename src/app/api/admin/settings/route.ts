// GET/POST /api/admin/settings — workflow settings (live/dry switch, rule
// thresholds). GET is readable by any logged-in user (the UI banner needs
// live_mode); POST is admin-only and upserts only the known keys.
import { getDB } from '@/lib/cloudflare'
import { getUserEmail, isAdmin } from '@/lib/identity'

const BOOLEAN_KEYS = ['live_mode', 'email_enabled']
const NUMERIC_KEYS = ['hold_max_age_days', 'near_date_days', 'max_holds_per_contact']
const KNOWN_KEYS = [...BOOLEAN_KEYS, ...NUMERIC_KEYS]

async function readSettings(db: D1Database): Promise<Record<string, string>> {
  const res = await db.prepare('SELECT key, value FROM settings').all()
  const rows = (res.results || []) as unknown as { key: string; value: string }[]
  return Object.fromEntries(rows.map(r => [r.key, r.value]))
}

// Any logged-in user may read (the dry-run banner needs live_mode).
export async function GET(): Promise<Response> {
  let db: D1Database
  try {
    db = await getDB()
  } catch (err) {
    console.error(err)
    return Response.json({ error: 'Database not configured' }, { status: 503 })
  }
  try {
    return Response.json({ settings: await readSettings(db) })
  } catch (err) {
    console.error('Settings query error', err)
    return Response.json({ error: 'Query failed' }, { status: 500 })
  }
}

export async function POST(request: Request): Promise<Response> {
  const email = getUserEmail(request)
  if (!isAdmin(email)) {
    return Response.json({ error: 'Admin access required' }, { status: 403 })
  }

  let body: { settings?: Record<string, unknown> }
  try {
    body = await request.json() as { settings?: Record<string, unknown> }
  } catch {
    return Response.json({ error: 'Request body must be JSON' }, { status: 400 })
  }
  const incoming = body.settings
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming) || Object.keys(incoming).length === 0) {
    return Response.json({ error: 'Body must be { settings: { key: value } } with at least one setting' }, { status: 400 })
  }

  // Validate everything before writing anything.
  const validated: [string, string][] = []
  for (const [key, raw] of Object.entries(incoming)) {
    if (!KNOWN_KEYS.includes(key)) {
      return Response.json(
        { error: `Unknown setting "${key}" — known settings: ${KNOWN_KEYS.join(', ')}` },
        { status: 400 },
      )
    }
    if (typeof raw !== 'string' && typeof raw !== 'number') {
      return Response.json({ error: `Setting "${key}" must be a string or number` }, { status: 400 })
    }
    const value = String(raw).trim()
    if (BOOLEAN_KEYS.includes(key) && value !== '0' && value !== '1') {
      return Response.json({ error: `Setting "${key}" must be '0' or '1'` }, { status: 400 })
    }
    if (NUMERIC_KEYS.includes(key) && !/^\d+$/.test(value)) {
      return Response.json({ error: `Setting "${key}" must be a whole number` }, { status: 400 })
    }
    validated.push([key, value])
  }

  let db: D1Database
  try {
    db = await getDB()
  } catch (err) {
    console.error(err)
    return Response.json({ error: 'Database not configured' }, { status: 503 })
  }

  try {
    await db.batch(validated.map(([key, value]) =>
      db.prepare(`
        INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
      `).bind(key, value),
    ))
    return Response.json({ settings: await readSettings(db) })
  } catch (err) {
    console.error('Settings update error', err)
    return Response.json({ error: 'Update failed' }, { status: 500 })
  }
}
