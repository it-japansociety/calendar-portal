import type { EventInsert, EventStatus } from './types'

export type JotFormAnswer = {
  name?: string
  text?: string
  type?: string
  order?: string
  answer?: unknown
}

export type JotFormAnswers = Record<string, JotFormAnswer>

// ── Lookup helpers ────────────────────────────────────────────────────────────

function findByLabel(answers: JotFormAnswers, label: string): JotFormAnswer | undefined {
  const target = label.toLowerCase().trim()
  return Object.values(answers).find(a => a.text?.toLowerCase().trim() === target)
}

function str(val: unknown): string {
  if (typeof val === 'string') return val.trim()
  if (typeof val === 'number') return String(val)
  return ''
}

// ── Date normalisation ────────────────────────────────────────────────────────

// Converts JotForm date formats to YYYY-MM-DD for SQL range queries.
// Handles:
//   { month: "05", day: "27", year: "2026" }
//   "05/27/2026"  "2026-05-27"
export function parseJotFormDate(raw: unknown): string {
  if (!raw) return ''

  if (typeof raw === 'object' && raw !== null) {
    const d = raw as Record<string, string>
    const y = (d.year || '').padStart(4, '0')
    const m = (d.month || '').padStart(2, '0')
    const day = (d.day || '').padStart(2, '0')
    if (y && m && day) return `${y}-${m}-${day}`
  }

  const s = str(raw)
  // Already ISO
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s
  // MM/DD/YYYY
  const slash = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)
  if (slash) return `${slash[3]}-${slash[1].padStart(2, '0')}-${slash[2].padStart(2, '0')}`

  return s
}

// ── Time normalisation ────────────────────────────────────────────────────────

// Converts JotForm time formats to HH:MM (24h) for SQL string comparisons.
// Handles:
//   { hours: "2", minutes: "30", ampm: "pm" }
//   "2:30 PM"  "14:30"
export function parseJotFormTime(raw: unknown): string {
  if (!raw) return ''

  if (typeof raw === 'object' && raw !== null) {
    const t = raw as Record<string, string>
    let h = parseInt(t.hours || '0', 10)
    const m = parseInt(t.minutes || '0', 10)
    const ampm = (t.ampm || '').toLowerCase()
    if (ampm === 'pm' && h < 12) h += 12
    if (ampm === 'am' && h === 12) h = 0
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
  }

  const s = str(raw)
  // Already HH:MM 24h
  if (/^\d{2}:\d{2}$/.test(s)) return s
  // H:MM AM/PM
  const match = s.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i)
  if (match) {
    let h = parseInt(match[1], 10)
    const m = parseInt(match[2], 10)
    const ampm = match[3].toLowerCase()
    if (ampm === 'pm' && h < 12) h += 12
    if (ampm === 'am' && h === 12) h = 0
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
  }

  return s
}

// ── Day-of-week helper ────────────────────────────────────────────────────────

export function getDayOfWeek(isoDate: string): string {
  if (!isoDate) return ''
  try {
    return new Date(`${isoDate}T12:00:00Z`).toLocaleDateString('en-US', {
      weekday: 'short',
      timeZone: 'UTC',
    })
  } catch {
    return ''
  }
}

// ── Main mapping function ─────────────────────────────────────────────────────

// Maps a JotForm answers object to an EventInsert record ready for D1.
// Matches fields by their text label so no hardcoded question IDs are needed.
// After configuring the JotForm webhook, do a test submission and log the
// rawRequest to verify all fields parse correctly.
export function mapAnswersToEvent(answers: JotFormAnswers): EventInsert {
  const get = (label: string) => findByLabel(answers, label)?.answer

  const eventDate = parseJotFormDate(get('Date'))

  return {
    event_name:    str(get('Event Name'))       || 'Untitled Event',
    department:    str(get('Department'))        || null,
    location:      str(get('Location'))          || null,
    event_date:    eventDate,
    day_of_week:   getDayOfWeek(eventDate)       || str(get('Day')) || null,
    event_start:   parseJotFormTime(get('Event Start')),
    event_end:     parseJotFormTime(get('Event End')),
    hold_start:    parseJotFormTime(get('Hold Start'))    || null,
    hold_end:      parseJotFormTime(get('Hold End'))      || null,
    doors_open:    parseJotFormTime(get('Doors Open'))    || null,
    check_in_time: parseJotFormTime(get('Check-In Time')) || null,
    run_time:      parseJotFormTime(get('Run Time'))      || null,
    contact_name:  str(get('Name'))              || 'Unknown',
    email:         str(get('Email'))             || '',
    phone:         str(get('Phone Number'))      || null,
    description:   str(get('Description/Notes (Public Facing)')) || null,
    attachment_url: str(get('Attachment'))       || null,
    status:        (str(get('Status')) as EventStatus) || 'Pending',
    count:         parseInt(str(get('Count')), 10) || null,
    jotform_id:    null,
  }
}

// ── Parse raw JotForm webhook body ────────────────────────────────────────────

// JotForm POSTs application/x-www-form-urlencoded containing a `rawRequest`
// key whose value is a JSON-encoded answers object.
export function parseWebhookBody(body: string): { submissionID: string; answers: JotFormAnswers } {
  const params = new URLSearchParams(body)
  const submissionID = params.get('submissionID') || params.get('submission_id') || ''

  const raw = params.get('rawRequest')
  if (raw) {
    try {
      const answers: JotFormAnswers = JSON.parse(raw)
      return { submissionID, answers }
    } catch {
      // fall through to direct-field parsing
    }
  }

  // Fallback: JotForm sometimes sends fields directly as q{id}_{name}=value
  const answers: JotFormAnswers = {}
  let idx = 0
  params.forEach((value, key) => {
    const match = key.match(/^q(\d+)_(.+)$/)
    if (match) {
      answers[match[1]] = { name: key, text: match[2], answer: value }
    } else if (!['formID', 'submissionID', 'webhookURL', 'ip', 'type'].includes(key)) {
      answers[String(idx++)] = { name: key, text: key, answer: value }
    }
  })

  return { submissionID, answers }
}
