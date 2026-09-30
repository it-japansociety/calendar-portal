import { getDB } from '@/lib/cloudflare'

// GET /api/changes — what actually changed in the mirror, from event_changes.
//
// Query params:
//   days=7            how far back to look (default 7, max 90)
//   since=YYYY-MM-DD  explicit start, overrides days
//   field=status      only this field
//   format=text       plain-text digest instead of JSON (for email/chat)
//   limit=500         cap on returned rows (default 500, max 2000)
//
// Reads only. Safe to poll.

type ChangeRow = {
  jotform_id: string
  event_name: string | null
  event_date: string | null
  change_type: string
  field: string | null
  old_value: string | null
  new_value: string | null
  detected_at: string
}

const FIELD_LABELS: Record<string, string> = {
  event_name: 'Event name', event_date: 'Date', event_start: 'Start time',
  event_end: 'End time', hold_start: 'Hold start', hold_end: 'Hold end',
  location: 'Rooms', department: 'Department', status: 'Status',
  contact_name: 'Contact', email: 'Email', phone: 'Phone',
  description: 'Notes', count: 'Headcount', doors_open: 'Doors open',
  check_in_time: 'Check-in', run_time: 'Run time',
}

function label(field: string | null): string {
  if (!field) return ''
  return FIELD_LABELS[field] || field
}

function shorten(v: string | null, max = 48): string {
  const s = (v ?? '').trim()
  if (!s) return '(empty)'
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

export async function GET(request: Request): Promise<Response> {
  const p = new URL(request.url).searchParams
  const days = Math.min(90, Math.max(1, parseInt(p.get('days') || '7', 10) || 7))
  const since = p.get('since') || ''
  const field = p.get('field') || ''
  const asText = p.get('format') === 'text'
  const limit = Math.min(2000, Math.max(1, parseInt(p.get('limit') || '500', 10) || 500))

  let db: D1Database
  try {
    db = await getDB()
  } catch (err) {
    console.error(err)
    return Response.json({ error: 'Database not configured' }, { status: 503 })
  }

  const conditions: string[] = []
  const binds: (string | number)[] = []
  if (since && /^\d{4}-\d{2}-\d{2}$/.test(since)) {
    conditions.push('detected_at >= ?')
    binds.push(since)
  } else {
    conditions.push(`detected_at >= datetime('now', ?)`)
    binds.push(`-${days} days`)
  }
  if (field) { conditions.push('field = ?'); binds.push(field) }
  const where = conditions.join(' AND ')

  let rows: ChangeRow[] = []
  let summary: { change_type: string; field: string | null; n: number }[] = []
  try {
    const [rowsRes, sumRes] = await db.batch([
      db.prepare(`
        SELECT jotform_id, event_name, event_date, change_type, field,
               old_value, new_value, detected_at
        FROM event_changes WHERE ${where}
        ORDER BY detected_at DESC, id DESC
        LIMIT ?
      `).bind(...binds, limit),
      db.prepare(`
        SELECT change_type, field, COUNT(*) AS n
        FROM event_changes WHERE ${where}
        GROUP BY change_type, field
        ORDER BY n DESC
      `).bind(...binds),
    ])
    rows = (rowsRes.results || []) as unknown as ChangeRow[]
    summary = (sumRes.results || []) as unknown as { change_type: string; field: string | null; n: number }[]
  } catch (err) {
    // The table only exists once an import has run against this database.
    console.error('Changes query error', err)
    return Response.json(
      { error: 'No change history yet — it starts accumulating after the next sync.' },
      { status: 503 },
    )
  }

  const created = summary.filter(s => s.change_type === 'created').reduce((a, s) => a + s.n, 0)
  const updated = summary.filter(s => s.change_type === 'updated').reduce((a, s) => a + s.n, 0)
  const bookingsTouched = new Set(rows.map(r => r.jotform_id)).size
  const window = since ? `since ${since}` : `last ${days} day${days === 1 ? '' : 's'}`

  if (!asText) {
    return Response.json({
      window,
      totals: { new_bookings: created, field_changes: updated, bookings_touched: bookingsTouched },
      by_field: summary
        .filter(s => s.change_type === 'updated')
        .map(s => ({ field: s.field, label: label(s.field), count: s.n })),
      changes: rows,
      truncated: rows.length === limit,
    })
  }

  // Plain-text digest — readable in email, chat, or a terminal.
  const lines: string[] = []
  lines.push(`House Calendar — changes ${window}`)
  lines.push('='.repeat(46))
  lines.push(`${created} new booking${created === 1 ? '' : 's'} · ${updated} field change${updated === 1 ? '' : 's'} across ${bookingsTouched} booking${bookingsTouched === 1 ? '' : 's'}`)
  lines.push('')

  const byFieldUpdated = summary.filter(s => s.change_type === 'updated')
  if (byFieldUpdated.length) {
    lines.push('What changed most:')
    for (const s of byFieldUpdated.slice(0, 10)) {
      lines.push(`  ${String(s.n).padStart(4)}  ${label(s.field)}`)
    }
    lines.push('')
  }

  const newOnes = rows.filter(r => r.change_type === 'created')
  if (newOnes.length) {
    lines.push(`New bookings (${newOnes.length}):`)
    for (const r of newOnes.slice(0, 40)) {
      lines.push(`  ${r.event_date || '(no date)'}  ${shorten(r.event_name, 52)}`)
    }
    if (newOnes.length > 40) lines.push(`  …and ${newOnes.length - 40} more`)
    lines.push('')
  }

  const edits = rows.filter(r => r.change_type === 'updated')
  if (edits.length) {
    lines.push(`Edits (${edits.length}):`)
    for (const r of edits.slice(0, 80)) {
      lines.push(`  ${r.event_date || '(no date)'}  ${shorten(r.event_name, 34)}`)
      lines.push(`      ${label(r.field)}: ${shorten(r.old_value, 34)} → ${shorten(r.new_value, 34)}`)
    }
    if (edits.length > 80) lines.push(`  …and ${edits.length - 80} more`)
  }

  if (!newOnes.length && !edits.length) lines.push('No changes in this window.')

  return new Response(lines.join('\n'), {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  })
}
