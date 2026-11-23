import { getDB } from '@/lib/cloudflare'
import { getUserEmail, isAdmin } from '@/lib/identity'

// Setup maps / floor-plan diagrams attached to a function form. Dev-stage
// storage is base64 in D1 (see migration 0004) — fine at these file sizes,
// swap for R2 in P2. Owner (contact email or created_by) or an admin may
// read/write; anyone with the direct group link can view via GET (matches
// the rest of the function-form route's permission model).
const MAX_BYTES = 4 * 1024 * 1024 // 4MB — comfortable for a floor-plan PNG/PDF, small enough for D1

async function assertAccess(db: D1Database, groupId: string, email: string): Promise<boolean> {
  if (isAdmin(email)) return true
  const g = await db.prepare(
    `SELECT 1 FROM event_groups WHERE group_id = ? AND (email = ? OR created_by = ?)`
  ).bind(groupId, email, email).first()
  return !!g
}

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url)
  const groupId = url.searchParams.get('group')
  if (!groupId) return Response.json({ error: 'group required' }, { status: 400 })

  let db: D1Database
  try {
    db = await getDB()
  } catch {
    return Response.json({ error: 'Database not configured' }, { status: 503 })
  }

  const result = await db.prepare(`
    SELECT id, filename, mime_type, size_bytes, uploaded_by, created_at
    FROM function_form_attachments WHERE group_id = ? ORDER BY created_at ASC
  `).bind(groupId).all()

  return Response.json({ attachments: result.results || [] })
}

export async function POST(request: Request): Promise<Response> {
  const email = getUserEmail(request)
  let body: { group_id?: string; filename?: string; mime_type?: string; data_base64?: string }
  try {
    body = await request.json()
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 })
  }
  const { group_id, filename, mime_type, data_base64 } = body
  if (!group_id || !filename || !mime_type || !data_base64) {
    return Response.json({ error: 'group_id, filename, mime_type, and data_base64 are all required' }, { status: 400 })
  }

  const sizeBytes = Math.ceil((data_base64.length * 3) / 4)
  if (sizeBytes > MAX_BYTES) {
    return Response.json({ error: `File is too large — attachments are limited to ${MAX_BYTES / (1024 * 1024)}MB` }, { status: 413 })
  }

  let db: D1Database
  try {
    db = await getDB()
  } catch {
    return Response.json({ error: 'Database not configured' }, { status: 503 })
  }

  if (!(await assertAccess(db, group_id, email))) {
    return Response.json({ error: 'You do not have access to this booking' }, { status: 403 })
  }

  const inserted = await db.prepare(`
    INSERT INTO function_form_attachments (group_id, filename, mime_type, size_bytes, data_base64, uploaded_by)
    VALUES (?, ?, ?, ?, ?, ?)
  `).bind(group_id, filename, mime_type, sizeBytes, data_base64, email).run()

  return Response.json({ ok: true, id: inserted.meta.last_row_id })
}

export async function DELETE(request: Request): Promise<Response> {
  const email = getUserEmail(request)
  const url = new URL(request.url)
  const id = url.searchParams.get('id')
  if (!id) return Response.json({ error: 'id required' }, { status: 400 })

  let db: D1Database
  try {
    db = await getDB()
  } catch {
    return Response.json({ error: 'Database not configured' }, { status: 503 })
  }

  const row = await db.prepare(`SELECT group_id FROM function_form_attachments WHERE id = ?`)
    .bind(id).first<{ group_id: string }>()
  if (!row) return Response.json({ error: 'Not found' }, { status: 404 })
  if (!(await assertAccess(db, row.group_id, email))) {
    return Response.json({ error: 'You do not have access to this booking' }, { status: 403 })
  }

  await db.prepare(`DELETE FROM function_form_attachments WHERE id = ?`).bind(id).run()
  return Response.json({ ok: true })
}
