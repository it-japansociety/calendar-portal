import { getDB } from '@/lib/cloudflare'
import { locationMatchesAny } from '@/lib/rooms'
import type { CalendarEvent, PaginatedEvents } from '@/lib/types'

// Sortable columns, whitelisted to keep the ORDER BY injection-safe.
const SORT_COLUMNS: Record<string, string> = {
  event_date:   'event_date',
  event_name:   'event_name',
  location:     'location',
  department:   'department',
  event_start:  'event_start',
  event_end:    'event_end',
  status:       'status',
  contact_name: 'contact_name',
  submitted_at: 'submitted_at',
}

// 24h "HH:MM" -> "h:MM AM/PM" for CSV export (matches the portal display).
function csvTime(t?: string | null): string {
  if (!t) return ''
  const m = /^(\d{1,2}):(\d{2})/.exec(t)
  if (!m) return t
  let h = parseInt(m[1], 10)
  const ampm = h >= 12 ? 'PM' : 'AM'
  h = h % 12
  if (h === 0) h = 12
  return `${h}:${m[2]} ${ampm}`
}

function csvField(val: unknown): string {
  const s = val === null || val === undefined ? '' : String(val)
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

function toCSV(rows: CalendarEvent[]): string {
  const header = [
    'Date', 'Day', 'Event Name', 'Location', 'Department',
    'Start', 'End', 'Hold Start', 'Hold End',
    'Contact', 'Email', 'Phone', 'Status', 'Description',
  ]
  const lines = rows.map(ev => [
    ev.event_date, ev.day_of_week, ev.event_name, ev.location, ev.department,
    csvTime(ev.event_start), csvTime(ev.event_end), csvTime(ev.hold_start), csvTime(ev.hold_end),
    ev.contact_name, ev.email, ev.phone, ev.status, ev.description,
  ].map(csvField).join(','))
  // BOM so Excel opens UTF-8 correctly
  const BOM = String.fromCharCode(0xfeff)
  return BOM + [header.map(csvField).join(','), ...lines].join('\r\n')
}

// GET /api/events
// Query params: date_from, date_to, status (comma-sep), department, location (exact),
//               locations (comma-sep canonical room names, alias-matched),
//               search (name/location/department/contact), include_archived (bool),
//               include_released (bool), sort, dir (asc|desc), page, page_size,
//               format=csv (exports every matching row, ignores pagination)
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url)
  const p = url.searchParams

  const dateFrom     = p.get('date_from') || ''
  const dateTo       = p.get('date_to') || ''
  const statusFilter = p.get('status') || ''
  const department   = p.get('department') || ''
  const location     = p.get('location') || ''
  // Canonical room names matched against the free-form multi-room location strings
  // ("MUR, SONY, SKY" / "Auditorium, Murasae Room") via the shared alias map.
  const selRooms     = (p.get('locations') || '').split(',').map(s => s.trim()).filter(Boolean)
  const search       = p.get('search') || ''
  const inclArchived = p.get('include_archived') === 'true'
  const inclReleased = p.get('include_released') === 'true'
  const sortCol      = SORT_COLUMNS[p.get('sort') || ''] || ''
  const sortDir      = p.get('dir') === 'desc' ? 'DESC' : 'ASC'
  const asCSV        = p.get('format') === 'csv'
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
  if (search) {
    conditions.push('(event_name LIKE ? OR location LIKE ? OR department LIKE ? OR contact_name LIKE ?)')
    const like = `%${search}%`
    bindings.push(like, like, like, like)
  }

  const statuses = statusFilter.split(',').map(s => s.trim()).filter(Boolean)
  if (statuses.length === 1) {
    conditions.push('status = ?')
    bindings.push(statuses[0])
  } else if (statuses.length > 1) {
    conditions.push(`status IN (${statuses.map(() => '?').join(', ')})`)
    bindings.push(...statuses)
  }

  // Released events behave like archived: hidden unless explicitly requested
  // (via the toggle or by filtering for the Released status directly).
  if (!inclReleased && !statuses.includes('Released')) {
    conditions.push(`status != 'Released'`)
  }

  // Exact lookup by JotForm submission id, used by the sync workflow's parity
  // check. Overrides every other filter (including archived/released visibility)
  // so a synced row is found regardless of its state.
  const jotformId = p.get('jotform_id') || ''
  if (jotformId) {
    conditions.length = 0
    bindings.length = 0
    conditions.push('jotform_id = ?')
    bindings.push(jotformId)
  }

  const where = conditions.join(' AND ')
  const orderBy = sortCol
    ? `${sortCol} ${sortDir}, event_date ASC, event_start ASC`
    : 'event_date ASC, event_start ASC'

  try {
    let data: CalendarEvent[]
    let total: number

    if (selRooms.length > 0 || asCSV) {
      // Room filtering can't be expressed as SQL against the free-form location
      // strings (and CSV needs every row), so fetch the whole result set (capped)
      // and filter + paginate in JS.
      const result = await db.prepare(`
        SELECT * FROM events WHERE ${where}
        ORDER BY ${orderBy}
        LIMIT 5000
      `).bind(...bindings).all()

      const matched = ((result.results || []) as unknown as CalendarEvent[])
        .filter(ev => locationMatchesAny(ev.location, selRooms))

      if (asCSV) {
        return new Response(toCSV(matched), {
          headers: {
            'Content-Type': 'text/csv; charset=utf-8',
            'Content-Disposition': `attachment; filename="events-export.csv"`,
          },
        })
      }

      total = matched.length
      data = matched.slice(offset, offset + pageSize)
    } else {
      const [dataResult, countResult] = await db.batch([
        db.prepare(`
          SELECT * FROM events WHERE ${where}
          ORDER BY ${orderBy}
          LIMIT ? OFFSET ?
        `).bind(...bindings, pageSize, offset),

        db.prepare(`SELECT COUNT(*) as total FROM events WHERE ${where}`)
          .bind(...bindings),
      ])

      data  = (dataResult.results || []) as unknown as CalendarEvent[]
      total = ((countResult.results?.[0] as { total: number })?.total) || 0
    }

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
