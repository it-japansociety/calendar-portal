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
//
// IMPORTANT: the Status field in JotForm is free-form in practice. Staff type
// their own variants — 89 live bookings read "Confirmed - Function Form
// Recieved" (sic). Exact-equality matching classified those as NEITHER
// confirmed NOR tentative, so the availability checker reported the rooms as
// FREE while they were in fact confirmed — a double-booking waiting to happen.
// These matchers therefore look for the status WORD anywhere in the value, and
// order matters: cancelled and released are checked before confirmed so that
// a value like "Confirmed then released" resolves to released, not confirmed.

function norm(s?: string | null): string {
  return (s || '').toLowerCase().trim()
}

export function isCancelledStatus(s?: string | null): boolean {
  return /\bcancel/.test(norm(s))
}
export function isReleasedStatus(s?: string | null): boolean {
  return !isCancelledStatus(s) && /\breleas/.test(norm(s))
}
export function isConfirmedStatus(s?: string | null): boolean {
  const v = norm(s)
  if (isCancelledStatus(v) || isReleasedStatus(v)) return false
  return /\bconfirm/.test(v)
}
export function isTentativeStatus(s?: string | null): boolean {
  const v = norm(s)
  if (!v) return false
  if (isCancelledStatus(v) || isReleasedStatus(v) || isConfirmedStatus(v)) return false
  return /\b(pending|contingent|tbd|hold|tentative)\b/.test(v)
}

// Any status that isn't recognised at all. Such a booking still occupies its
// room — treating it as free is the dangerous failure — so callers bucket it
// as tentative, and /api/changes surfaces it so the wording can be corrected.
export function isUnrecognisedStatus(s?: string | null): boolean {
  const v = norm(s)
  if (!v) return false
  return !isCancelledStatus(v) && !isReleasedStatus(v)
    && !isConfirmedStatus(v) && !isTentativeStatus(v)
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
