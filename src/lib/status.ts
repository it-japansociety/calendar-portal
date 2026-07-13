// Booking-status buckets and time formatting shared by the availability tab
// and the interactive calendar view.

// A booking with no usable time range (blank, equal, or start >= end — e.g. the
// "12:00-12:00" all-day placeholder some submissions default to) occupies the whole day.
export function isAllDay(start?: string | null, end?: string | null): boolean {
  return !start || !end || start >= end
}

// Only a Confirmed booking firmly occupies a space; Pending/Contingent/TBD are
// tentative (contested, not yet decided); Released and Cancelled are ignored
// (and archived events are filtered out upstream).
export function isConfirmedStatus(s?: string | null): boolean {
  return (s || '').toLowerCase().trim() === 'confirmed'
}
export function isTentativeStatus(s?: string | null): boolean {
  return ['pending', 'contingent', 'tbd'].includes((s || '').toLowerCase().trim())
}
export function isReleasedStatus(s?: string | null): boolean {
  return (s || '').toLowerCase().trim() === 'released'
}
export function isCancelledStatus(s?: string | null): boolean {
  return (s || '').toLowerCase().trim() === 'cancelled'
}

// A "walls only" booking (marked in its public description, e.g. the JSSP student
// exhibitions hanging art on the A-Level walls) reserves the walls but leaves the
// space itself usable — it must not block the room in the availability checker.
export function isWallsOnly(description?: string | null): boolean {
  return /walls[\s-]?only/i.test(description || '')
}

// Convert a 24h "HH:MM" string to 12-hour "h:MM AM/PM" for display.
export function formatTime12(t?: string | null): string {
  if (!t) return ''
  const m = /^(\d{1,2}):(\d{2})/.exec(t)
  if (!m) return t
  let h = parseInt(m[1], 10)
  const ampm = h >= 12 ? 'PM' : 'AM'
  h = h % 12
  if (h === 0) h = 12
  return `${h}:${m[2]} ${ampm}`
}

// Render a booking's time range, collapsing all-day placeholders to "All day".
export function formatTimeRange(start?: string | null, end?: string | null): string {
  return isAllDay(start, end) ? 'All day' : `${formatTime12(start)}–${formatTime12(end)}`
}
