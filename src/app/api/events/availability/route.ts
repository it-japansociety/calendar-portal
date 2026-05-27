import { getDB } from '@/lib/cloudflare'
import type { AvailabilityResult, AvailabilityConflict } from '@/lib/types'

// GET /api/events/availability
// Query params: date (required, YYYY-MM-DD), start_time (HH:MM), end_time (HH:MM), location
//
// Returns all non-cancelled events on the date (if no times given),
// or specifically those that overlap with the requested time window.
// Two intervals [A_start, A_end] overlap when A_start < B_end AND A_end > B_start.
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url)
  const date      = url.searchParams.get('date') || ''
  const startTime = url.searchParams.get('start_time') || ''
  const endTime   = url.searchParams.get('end_time') || ''
  const location  = url.searchParams.get('location') || ''

  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return Response.json({ error: 'date param required (YYYY-MM-DD)' }, { status: 400 })
  }

  let db: D1Database
  try {
    db = await getDB()
  } catch (err) {
    console.error(err)
    return Response.json({ error: 'Database not configured' }, { status: 503 })
  }

  const bindings: string[] = [date]
  let timeOverlapClause = ''

  if (startTime && endTime) {
    // Primary event time overlap + hold time overlap
    timeOverlapClause = `AND (
      (event_start < ? AND event_end > ?)
      OR (hold_start IS NOT NULL AND hold_end IS NOT NULL AND hold_start < ? AND hold_end > ?)
    )`
    bindings.push(endTime, startTime, endTime, startTime)
  }

  const locationClause = location ? 'AND location = ?' : ''
  if (location) bindings.push(location)

  try {
    const result = await db
      .prepare(`
        SELECT id, event_name, location, event_start, event_end, status
        FROM events
        WHERE is_archived = 0
          AND event_date = ?
          AND status NOT IN ('Cancelled')
          ${timeOverlapClause}
          ${locationClause}
        ORDER BY event_start ASC
      `)
      .bind(...bindings)
      .all()

    const conflicts = (result.results || []) as unknown as AvailabilityConflict[]

    const response: AvailabilityResult = {
      date,
      start_time: startTime || null,
      end_time:   endTime   || null,
      is_available: conflicts.length === 0,
      conflicts,
    }

    return Response.json(response)
  } catch (err) {
    console.error('Availability query error', err)
    return Response.json({ error: 'Query failed' }, { status: 500 })
  }
}
