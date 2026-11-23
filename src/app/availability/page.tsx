'use client'

// Availability checker — pick a date (or range) and optional rooms, see what's
// free. Ported from the "Check Availability" panel that used to live inside
// the old src/app/page.tsx Events tab; the querying strategy (page through
// every event in range, then filter by room/time on the client) and the
// walls-only / confirmed-vs-tentative rules are unchanged, only the shell and
// visual language are new.
import {
  useCallback, useEffect, useState,
  type Dispatch, type ReactNode, type SetStateAction,
} from 'react'
import PortalShell, { PortalHero } from '../../components/PortalShell'
import { ROOM_NAMES, roomsInLocation } from '../../lib/rooms'
import {
  isAllDay, isConfirmedStatus, isTentativeStatus, isReleasedStatus, isCancelledStatus,
  isUnrecognisedStatus, isWallsOnly,
  formatTime12, formatTimeRange,
} from '../../lib/status'
import { deptColorFor } from '../../lib/departments'
import type { CalendarEvent, PaginatedEvents } from '../../lib/types'

// ── Helpers (ported verbatim from the old availability panel) ──────────────

// Whether an event occupies a requested [start, end) window. All-day bookings
// always do; otherwise two intervals overlap when start < otherEnd && end > otherStart.
function eventOccupies(ev: CalendarEvent, start: string, end: string): boolean {
  if (isAllDay(ev.event_start, ev.event_end)) return true
  return ev.event_start < end && ev.event_end > start
}

// Inclusive list of ISO dates from..to, capped at 366 days.
function datesBetween(from: string, to: string): string[] {
  const dates: string[] = []
  const d = new Date(`${from}T12:00:00Z`)
  const endMs = new Date(`${to}T12:00:00Z`).getTime()
  if (Number.isNaN(d.getTime()) || Number.isNaN(endMs)) return dates
  while (d.getTime() <= endMs && dates.length < 366) {
    dates.push(d.toISOString().slice(0, 10))
    d.setUTCDate(d.getUTCDate() + 1)
  }
  return dates
}

// "2026-10-01" -> "Oct 1 · Wed"
function formatDateLabel(iso: string): string {
  const d = new Date(`${iso}T12:00:00Z`)
  if (Number.isNaN(d.getTime())) return iso
  const md = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
  const wd = d.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' })
  return `${md} · ${wd}`
}

type RoomStateValue = 'free' | 'booked' | 'tentative'
type RoomState = { room: string; state: RoomStateValue; blocking: CalendarEvent[]; wallsOnly: CalendarEvent[] }

// Per-room status for one day's events. "Walls only" bookings (flagged in the
// description, e.g. art exhibitions on the A-Level walls) never block the
// room — the space itself stays usable.
function roomStateFor(dayEvents: CalendarEvent[], room: string, hasWindow: boolean, start: string, end: string): Omit<RoomState, 'room'> {
  const roomEvents = dayEvents.filter(e =>
    roomsInLocation(e.location).has(room) && (!hasWindow || eventOccupies(e, start, end))
  )
  const blocking_ = roomEvents.filter(e => !isWallsOnly(e.description))
  const wallsOnly = roomEvents.filter(e => isWallsOnly(e.description))
  const confirmed = blocking_.filter(e => isConfirmedStatus(e.status))
  // An unrecognised status still occupies the room. Reporting such a booking
  // as free is the dangerous failure mode (it invites a double-booking), so
  // anything not explicitly released/cancelled counts as at least tentative.
  const tentative = blocking_.filter(e =>
    isTentativeStatus(e.status) || isUnrecognisedStatus(e.status))
  const state: RoomStateValue = confirmed.length ? 'booked' : tentative.length ? 'tentative' : 'free'
  return { state, blocking: confirmed.length ? confirmed : tentative, wallsOnly }
}

// Dot colours and row tints all come from the three status hues already in
// the system (green/gold/red) — no new colours invented.
const STATE_DOT: Record<RoomStateValue, string> = {
  free: 'var(--jsp-green)',
  booked: 'var(--jsp-red)',
  tentative: 'var(--jsp-gold)',
}
const STATE_TEXT: Record<RoomStateValue, (n: number) => string> = {
  free: () => 'Free',
  booked: n => `Booked · ${n}`,
  tentative: n => `Tentative · ${n}`,
}
// Same rgba hues as .jsp-status-confirmed / -pending / -alert, at lower
// opacity so a whole row can be tinted without turning into a solid block.
const STATE_TINT: Record<RoomStateValue, string> = {
  free: 'rgba(87, 180, 118, 0.10)',
  booked: 'rgba(240, 30, 55, 0.08)',
  tentative: 'rgba(217, 165, 46, 0.12)',
}

function StatusPill({ status }: { status: string }) {
  const cls = isConfirmedStatus(status) ? 'jsp-status-confirmed'
    : isCancelledStatus(status) ? 'jsp-status-cancelled'
    : isTentativeStatus(status) ? 'jsp-status-pending'
    : 'jsp-status-alert'
  return <span className={`jsp-status ${cls}`}>{status}</span>
}

function MicroLabel({ children }: { children: ReactNode }) {
  return (
    <span className="block text-[11px] font-semibold uppercase tracking-wide mb-1.5" style={{ color: 'var(--jsp-muted)' }}>
      {children}
    </span>
  )
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <MicroLabel>{label}</MicroLabel>
      {children}
    </label>
  )
}

const EMPTY_QUERY = { date: '', end_date: '', start_time: '', end_time: '', locations: [] as string[] }

export default function AvailabilityPage() {
  // window.location.search, captured after mount — passed through to every
  // /api/events call so the ?as= dev identity override keeps working.
  const [search, setSearch] = useState<string | null>(null)
  useEffect(() => { setSearch(window.location.search) }, [])

  const [query, setQuery] = useState(EMPTY_QUERY)
  const [events, setEvents] = useState<CalendarEvent[]>([])
  // The date range the current `events` were fetched for (null = no query run yet)
  const [range, setRange] = useState<{ from: string; to: string } | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  // Dates expanded in the range-mode result list to show all blocking bookings
  const [expandedDates, setExpandedDates] = useState<Set<string>>(new Set())

  const checkAvailability = useCallback(async () => {
    if (!query.date || search === null) return
    const from = query.date
    // An end date before the start date is ignored (single-day check)
    const to = query.end_date && query.end_date > from ? query.end_date : from
    setLoading(true)
    setLoadError(null)
    setRange(null)
    setEvents([])
    setExpandedDates(new Set())
    try {
      // Fetch every event in the range; room/time filtering happens client-side
      // so the grid and per-date list can break results down by room.
      const all: CalendarEvent[] = []
      for (let page = 1; page <= 25; page++) {
        const params = new URLSearchParams({ date_from: from, date_to: to, page_size: '200', page: String(page) })
        const res = await fetch(`/api/events?${params}${search ? `&${search.slice(1)}` : ''}`)
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const json: PaginatedEvents = await res.json()
        all.push(...(json.data || []))
        if (all.length >= (json.pagination?.total ?? 0) || (json.data || []).length === 0) break
      }
      setEvents(all)
      setRange({ from, to })
    } catch {
      setLoadError('Could not check availability. Check your connection and try again.')
    } finally {
      setLoading(false)
    }
  }, [query, search])

  const clear = () => {
    setQuery(EMPTY_QUERY)
    setRange(null)
    setEvents([])
    setLoadError(null)
    setExpandedDates(new Set())
  }

  const toggleRoom = (room: string) =>
    setQuery(q => ({
      ...q,
      locations: q.locations.includes(room) ? q.locations.filter(r => r !== room) : [...q.locations, room],
    }))

  const dirty = !!(query.date || query.end_date || query.start_time || query.end_time || query.locations.length > 0 || range)

  const start = query.start_time
  const end = query.end_time
  const hasWindow = !!(start && end)
  const windowLabel = hasWindow ? `${formatTime12(start)}–${formatTime12(end)}` : 'All day'
  const isRangeMode = !!range && range.to > range.from
  const rooms = query.locations.length ? query.locations : ROOM_NAMES

  return (
    <PortalShell active="availability">
      <PortalHero
        kicker="AVAILABILITY"
        title="Check a Date"
        lede="Pick a date and rooms — leave rooms empty to check the whole house."
      />

      <form
        className="jsp-card p-6"
        onSubmit={e => { e.preventDefault(); checkAvailability() }}
      >
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <Field label="From">
            <input
              type="date" className="jsp-input" value={query.date}
              onChange={e => setQuery(q => ({ ...q, date: e.target.value }))}
            />
          </Field>
          <Field label="To (optional)">
            <input
              type="date" className="jsp-input" value={query.end_date} min={query.date || undefined}
              onChange={e => setQuery(q => ({ ...q, end_date: e.target.value }))}
            />
          </Field>
          <Field label="Start time">
            <input
              type="time" className="jsp-input" value={query.start_time}
              onChange={e => setQuery(q => ({ ...q, start_time: e.target.value }))}
            />
          </Field>
          <Field label="End time">
            <input
              type="time" className="jsp-input" value={query.end_time}
              onChange={e => setQuery(q => ({ ...q, end_time: e.target.value }))}
            />
          </Field>
        </div>

        <div className="mt-5">
          <MicroLabel>
            Rooms <span className="normal-case font-normal opacity-80">— none selected checks the whole house</span>
          </MicroLabel>
          <div className="flex flex-wrap gap-2">
            {ROOM_NAMES.map(room => (
              <button
                key={room} type="button" className="jsp-chip" data-on={query.locations.includes(room)}
                onClick={() => toggleRoom(room)}
              >
                {room}
              </button>
            ))}
          </div>
        </div>

        <div className="mt-6 flex flex-wrap items-center gap-3">
          <button type="submit" className="jsp-btn" disabled={!query.date || loading}>
            {loading ? 'Checking…' : 'Check availability'}
          </button>
          {dirty && (
            <button type="button" className="jsp-btn-ghost" onClick={clear}>Clear</button>
          )}
        </div>
      </form>

      <div className="mt-8">
        {loadError && (
          <div className="jsp-card px-4 py-3 flex items-center justify-between gap-3 text-sm">
            <span style={{ color: 'var(--jsp-red)' }}>{loadError}</span>
            <button type="button" className="jsp-btn-ghost shrink-0" onClick={checkAvailability}>Retry</button>
          </div>
        )}

        {!loadError && loading && <AvailabilitySkeleton />}

        {!loadError && !loading && !range && (
          <div className="jsp-card p-8 text-sm text-center" style={{ color: 'var(--jsp-muted)' }}>
            Pick a date above and check availability to see room status and that day&rsquo;s events.
          </div>
        )}

        {!loadError && !loading && range && !isRangeMode && (
          <SingleDayResults
            dayEvents={events.filter(e => e.event_date === range.from)}
            rooms={rooms}
            hasWindow={hasWindow}
            start={start}
            end={end}
            windowLabel={windowLabel}
          />
        )}

        {!loadError && !loading && range && isRangeMode && (
          <RangeResults
            range={range}
            events={events}
            rooms={rooms}
            hasWindow={hasWindow}
            start={start}
            end={end}
            windowLabel={windowLabel}
            allRoomsSelected={query.locations.length === 0}
            expandedDates={expandedDates}
            setExpandedDates={setExpandedDates}
          />
        )}
      </div>
    </PortalShell>
  )
}

// ── Loading skeleton ────────────────────────────────────────────────────────

function SkeletonBar({ w = '60%' }: { w?: string }) {
  return <div className="h-3 rounded-full animate-pulse" style={{ width: w, background: 'var(--jsp-line)' }} />
}

function AvailabilitySkeleton() {
  return (
    <div className="space-y-8">
      <div>
        <div className="h-3 w-40 rounded-full animate-pulse mb-3" style={{ background: 'var(--jsp-line)' }} />
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-6 gap-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="jsp-card p-4 space-y-2">
              <SkeletonBar w="70%" />
              <SkeletonBar w="45%" />
            </div>
          ))}
        </div>
      </div>
      <div>
        <div className="h-3 w-52 rounded-full animate-pulse mb-3" style={{ background: 'var(--jsp-line)' }} />
        <div className="jsp-card overflow-hidden">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="p-4" style={{ borderTop: i > 0 ? '1px solid var(--jsp-line)' : undefined }}>
              <SkeletonBar w="80%" />
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

// ── Single-day results: room grid + that day's events ───────────────────────

function SingleDayResults({
  dayEvents, rooms, hasWindow, start, end, windowLabel,
}: {
  dayEvents: CalendarEvent[]
  rooms: string[]
  hasWindow: boolean
  start: string
  end: string
  windowLabel: string
}) {
  // Released events are done with the space — omitted from "that day's" list.
  const listEvents = dayEvents.filter(e => !isReleasedStatus(e.status))

  return (
    <div className="space-y-8">
      <div>
        <p className="jsp-kicker mb-1">ROOM AVAILABILITY</p>
        <p className="text-xs mb-3" style={{ color: 'var(--jsp-muted)' }}>{windowLabel}</p>
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-6 gap-3">
          {rooms.map(room => {
            const { state, blocking, wallsOnly } = roomStateFor(dayEvents, room, hasWindow, start, end)
            return (
              <div key={room} className="jsp-card p-4">
                <div className="font-semibold text-sm truncate" style={{ color: 'var(--jsp-ink)' }}>{room}</div>
                <div className="mt-1.5 flex items-center gap-1.5 text-xs" style={{ color: 'var(--jsp-muted)' }}>
                  <span className="jsp-dot" style={{ background: STATE_DOT[state] }} />
                  {STATE_TEXT[state](blocking.length)}
                </div>
                {wallsOnly.length > 0 && (
                  <div
                    className="mt-1 text-[11px]" style={{ color: 'var(--jsp-muted)' }}
                    title={wallsOnly.map(e => e.event_name).join(', ')}
                  >
                    Walls in use (space usable)
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>

      <div>
        <p className="jsp-kicker mb-3">{`ALL EVENTS THAT DAY (${listEvents.length})`}</p>
        <div className="jsp-card overflow-hidden">
          {listEvents.length === 0 ? (
            <p className="p-4 text-sm" style={{ color: 'var(--jsp-muted)' }}>No events scheduled.</p>
          ) : listEvents.map((ev, i) => (
            <div
              key={ev.id}
              className={`flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 text-sm ${isCancelledStatus(ev.status) ? 'opacity-50' : ''}`}
              style={{ borderTop: i > 0 ? '1px solid var(--jsp-line)' : undefined }}
            >
              <span
                className="jsp-dot" title={ev.department || 'No department'}
                style={{ background: deptColorFor(ev.department).bg, boxShadow: '0 0 0 1px var(--jsp-line)' }}
              />
              <span
                className={`font-medium ${isCancelledStatus(ev.status) ? 'line-through' : ''}`}
                style={{ color: 'var(--jsp-ink)' }}
              >
                {ev.event_name}
              </span>
              {ev.location && <span style={{ color: 'var(--jsp-muted)' }}>{ev.location}</span>}
              <span style={{ color: 'var(--jsp-muted)' }}>{formatTimeRange(ev.event_start, ev.event_end)}</span>
              <StatusPill status={ev.status} />
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

// ── Range results: one row per date, expandable to show every blocker ───────

function RangeResults({
  range, events, rooms, hasWindow, start, end, windowLabel, allRoomsSelected, expandedDates, setExpandedDates,
}: {
  range: { from: string; to: string }
  events: CalendarEvent[]
  rooms: string[]
  hasWindow: boolean
  start: string
  end: string
  windowLabel: string
  allRoomsSelected: boolean
  expandedDates: Set<string>
  setExpandedDates: Dispatch<SetStateAction<Set<string>>>
}) {
  const dates = datesBetween(range.from, range.to)
  const rows = dates.map(d => {
    const dayEvents = events.filter(e => e.event_date === d)
    const roomStates: RoomState[] = rooms.map(room => ({ room, ...roomStateFor(dayEvents, room, hasWindow, start, end) }))
    const worst: RoomStateValue = roomStates.some(r => r.state === 'booked') ? 'booked'
      : roomStates.some(r => r.state === 'tentative') ? 'tentative' : 'free'
    return { date: d, roomStates, worst }
  })
  const freeCount = rows.filter(r => r.worst === 'free').length

  const toggle = (date: string) => setExpandedDates(prev => {
    const next = new Set(prev)
    if (next.has(date)) next.delete(date)
    else next.add(date)
    return next
  })

  return (
    <div>
      <p className="jsp-kicker mb-1">
        {`AVAILABILITY · ${formatDateLabel(range.from)} – ${formatDateLabel(range.to)} · ${windowLabel}`}
      </p>
      <p className="text-sm mb-3" style={{ color: 'var(--jsp-muted)' }}>
        {freeCount} of {rows.length} days fully free
      </p>
      <div className="jsp-card overflow-hidden max-h-[520px] overflow-y-auto">
        {rows.map((row, i) => {
          const expandable = row.worst !== 'free'
          const isExpanded = expandedDates.has(row.date)
          const visibleRooms = allRoomsSelected ? row.roomStates.filter(r => r.state !== 'free') : row.roomStates
          return (
            <div
              key={row.date}
              style={{ background: STATE_TINT[row.worst], borderTop: i > 0 ? '1px solid var(--jsp-line)' : undefined }}
            >
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-sm">
                <span className="font-semibold w-24 shrink-0" style={{ color: 'var(--jsp-ink)' }}>
                  {formatDateLabel(row.date)}
                </span>
                {row.worst === 'free' ? (
                  <span style={{ color: 'var(--jsp-muted)' }}>{allRoomsSelected ? 'All rooms free' : 'Free'}</span>
                ) : (
                  visibleRooms.map(r => (
                    <span key={r.room} className="inline-flex items-baseline gap-1.5">
                      <span className="inline-flex items-center gap-1 font-medium" style={{ color: 'var(--jsp-ink)' }}>
                        <span className="jsp-dot" style={{ background: STATE_DOT[r.state] }} />
                        {r.room}
                      </span>
                      {r.blocking.length > 0 && !isExpanded && (
                        <span className="max-w-[240px] truncate text-xs" style={{ color: 'var(--jsp-muted)' }}>
                          {r.blocking[0].event_name} ({formatTimeRange(r.blocking[0].event_start, r.blocking[0].event_end)})
                          {r.blocking.length > 1 ? ` +${r.blocking.length - 1}` : ''}
                        </span>
                      )}
                    </span>
                  ))
                )}
                {expandable && (
                  <button
                    type="button" onClick={() => toggle(row.date)}
                    className="ml-auto shrink-0 text-xs font-medium underline underline-offset-2"
                    style={{ color: 'var(--jsp-red)' }}
                  >
                    {isExpanded ? 'Hide' : 'Show details'}
                  </button>
                )}
              </div>
              {isExpanded && (
                <div className="px-4 pb-3 pl-[7rem] space-y-1.5">
                  {row.roomStates.filter(r => r.blocking.length > 0).flatMap(r =>
                    r.blocking.map(ev => (
                      <div
                        key={`${r.room}-${ev.id}`}
                        className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs"
                        style={{ color: 'var(--jsp-muted)' }}
                      >
                        <span className="jsp-dot" style={{ background: STATE_DOT[r.state] }} />
                        <span className="font-medium" style={{ color: 'var(--jsp-ink)' }}>{r.room}</span>
                        <span>{ev.event_name}</span>
                        <span>{formatTimeRange(ev.event_start, ev.event_end)}</span>
                        <StatusPill status={ev.status} />
                      </div>
                    ))
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
