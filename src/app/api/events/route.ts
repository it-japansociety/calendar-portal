import { getDB } from '@/lib/cloudflare'
import type { CalendarEvent, PaginatedEvents } from '@/lib/types'

// GET /api/events
// Query params: date_from, date_to, status (comma-sep), department, location,
//               include_archived (bool), page, page_size
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url)
  const p = url.searchParams

  const dateFrom     = p.get('date_from') || ''
  const dateTo       = p.get('date_to') || ''
  const statusFilter = p.get('status') || ''
  const department   = p.get('department') || ''
  const location     = p.get('location') || ''
  const search       = p.get('search') || ''
  const inclArchived = p.get('include_archived') === 'true'
  const page         = Math.max(1, parseInt(p.get('page') || '1', 10))
  const pageSize     = Math.min(200, Math.max(1, parseInt(p.get('page_size') || '50', 10)))
  const offset       = (page - 1) * pageSize

  let db: D1Database
  try {
    db = await getDB()
  } catch (err) {
    console.error(err)
    return Response.json({ error: 'Database not configured' }, { status: 503 })
  }

  // Lazy archive: mark events whose date passed 7+ days ago before querying
  try {
    await db
      .prepare(`
        UPDATE events
        SET is_archived = 1, archived_at = datetime('now')
        WHERE is_archived = 0 AND event_date < date('now', '-7 days')
      `)
      .run()
  } catch {
    // Non-fatal: stale events will just appear unarchived until the next write
  }

  // Build dynamic WHERE clause
  const conditions: string[] = [`is_archived = ${inclArchived ? 1 : 0}`]
  const bindings: (string | number)[] = []

  if (dateFrom) { conditions.push('event_date >= ?'); bindings.push(dateFrom) }
  if (dateTo)   { conditions.push('event_date <= ?'); bindings.push(dateTo) }
  if (department) { conditions.push('department = ?'); bindings.push(department) }
  if (location)   { conditions.push('location = ?');   bindings.push(location) }
  if (search)     { conditions.push('event_name LIKE ?'); bindings.push(`%${search}%`) }

  if (statusFilter) {
    const statuses = statusFilter.split(',').map(s => s.trim()).filter(Boolean)
    if (statuses.length === 1) {
      conditions.push('status = ?')
      bindings.push(statuses[0])
    } else if (statuses.length > 1) {
      conditions.push(`status IN (${statuses.map(() => '?').join(', ')})`)
      bindings.push(...statuses)
    }
  }

  const where = conditions.join(' AND ')

  try {
    const [dataResult, countResult] = await db.batch([
      db.prepare(`
        SELECT * FROM events WHERE ${where}
        ORDER BY event_date ASC, event_start ASC
        LIMIT ? OFFSET ?
      `).bind(...bindings, pageSize, offset),

      db.prepare(`SELECT COUNT(*) as total FROM events WHERE ${where}`)
        .bind(...bindings),
    ])

    const data   = (dataResult.results  || []) as unknown as CalendarEvent[]
    const total  = ((countResult.results?.[0] as { total: number })?.total) || 0

    const response: PaginatedEvents = {
      data,
      pagination: { page, page_size: pageSize, total },
    }

    return Response.json(response, {
      headers: { 'Cache-Control': 'public, max-age=60, stale-while-revalidate=120' },
    })
  } catch (err) {
    console.error('Events query error', err)
    return Response.json({ error: 'Query failed' }, { status: 500 })
  }
}
