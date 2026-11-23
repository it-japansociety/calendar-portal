import { getDB } from '@/lib/cloudflare'
import { getUserEmail, isAdmin } from '@/lib/identity'

// GET /api/function-form/attachments/[id] — streams one attachment's bytes
// back with its real content-type, so it can be viewed inline or downloaded.
// Kept separate from the list route so listing attachments never has to move
// the (potentially several-MB) base64 payload of every file.
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params
  const email = getUserEmail(request)

  let db: D1Database
  try {
    db = await getDB()
  } catch {
    return Response.json({ error: 'Database not configured' }, { status: 503 })
  }

  const row = await db.prepare(`
    SELECT group_id, filename, mime_type, data_base64 FROM function_form_attachments WHERE id = ?
  `).bind(id).first<{ group_id: string; filename: string; mime_type: string; data_base64: string }>()
  if (!row) return Response.json({ error: 'Not found' }, { status: 404 })

  if (!isAdmin(email)) {
    const g = await db.prepare(
      `SELECT 1 FROM event_groups WHERE group_id = ? AND (email = ? OR created_by = ?)`
    ).bind(row.group_id, email, email).first()
    if (!g) return Response.json({ error: 'You do not have access to this booking' }, { status: 403 })
  }

  const bytes = Uint8Array.from(atob(row.data_base64), c => c.charCodeAt(0))
  return new Response(bytes, {
    headers: {
      'Content-Type': row.mime_type,
      'Content-Disposition': `inline; filename="${row.filename.replace(/"/g, '')}"`,
      'Cache-Control': 'private, max-age=3600',
    },
  })
}
