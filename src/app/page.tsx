'use client'

// Home dashboard — the portal's front door. Shows the signed-in user's own
// bookings at a glance, four primary actions, and a compact snapshot of the
// house calendar (mini month grid + upcoming events + today's room status).
// The old multi-section SPA (Availability / Calendar / Excel / JotForm table)
// has moved to its own routes (/availability, /calendar, and siblings) owned
// by other pages — this file only renders the dashboard itself.

import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react'
import Link from 'next/link'
import PortalShell, { useWhoami } from '../components/PortalShell'
import { cachedFetch } from '../lib/client-cache'
import type { GroupSummary, GroupStatus } from '../lib/workflow-types'
import { ROOM_NAMES, roomsInLocation } from '../lib/rooms'
import { deptColorFor } from '../lib/departments'
import { formatTime12, isAllDay, isCancelledStatus } from '../lib/status'
import type { CalendarEvent, PaginatedEvents } from '../lib/types'

const pad2 = (n: number) => String(n).padStart(2, '0')
const isoDate = (y: number, m: number, d: number) => `${y}-${pad2(m + 1)}-${pad2(d)}`
const toMinutes = (t: string) => {
  const [h, m] = t.split(':').map(Number)
  return h * 60 + m
}

// A snapshot of "now", taken once on mount. Computing dates client-side only
// (rather than during the initial render) keeps server/client markup identical
// and sidesteps timezone drift near midnight.
interface TodaySnapshot {
  year: number
  month: number // 0-indexed
  day: number
  nowMinutes: number
  todayIso: string
  monthName: string
  monthFirstIso: string
  monthLastIso: string
}

function snapshotNow(): TodaySnapshot {
  const d = new Date()
  const year = d.getFullYear()
  const month = d.getMonth()
  const day = d.getDate()
  const daysInMonth = new Date(year, month + 1, 0).getDate()
  return {
    year,
    month,
    day,
    nowMinutes: d.getHours() * 60 + d.getMinutes(),
    todayIso: isoDate(year, month, day),
    monthName: d.toLocaleDateString('en-US', { month: 'long' }),
    monthFirstIso: isoDate(year, month, 1),
    monthLastIso: isoDate(year, month, daysInMonth),
  }
}

interface MonthCell {
  iso: string
  day: number
  inMonth: boolean
}

// 7-column grid for a month, padded with the tail of the previous month and
// the head of the next so every row is a full week.
function buildMonthGrid(year: number, month: number): MonthCell[] {
  const firstDow = new Date(year, month, 1).getDay()
  const daysInMonth = new Date(year, month + 1, 0).getDate()
  const daysInPrevMonth = new Date(year, month, 0).getDate()
  const cells: MonthCell[] = []
  for (let i = 0; i < firstDow; i++) {
    const day = daysInPrevMonth - firstDow + 1 + i
    const m = month === 0 ? 11 : month - 1
    const y = month === 0 ? year - 1 : year
    cells.push({ iso: isoDate(y, m, day), day, inMonth: false })
  }
  for (let day = 1; day <= daysInMonth; day++) {
    cells.push({ iso: isoDate(year, month, day), day, inMonth: true })
  }
  let nextDay = 1
  while (cells.length % 7 !== 0) {
    const m = month === 11 ? 0 : month + 1
    const y = month === 11 ? year + 1 : year
    cells.push({ iso: isoDate(y, m, nextDay), day: nextDay, inMonth: false })
    nextDay++
  }
  return cells
}

// Appends the current page's query string (e.g. the dev "?as=" override) to an
// internal href so it survives navigation between portal pages.
function withQS(path: string, qs: string): string {
  if (!qs) return path
  const q = qs.startsWith('?') ? qs.slice(1) : qs
  return path.includes('?') ? `${path}&${q}` : `${path}?${q}`
}

// "2026-10-01" -> "Oct 1" (noon-anchored so no UTC-shift near midnight)
function shortDate(iso: string): string {
  const d = new Date(`${iso}T12:00:00Z`)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
}

function bookingDateLabel(from: string, to: string): string {
  return from === to ? shortDate(from) : `${shortDate(from)} – ${shortDate(to)}`
}

function groupStatusPill(status: GroupStatus): { cls: string; label: string } {
  switch (status) {
    case 'confirmed': return { cls: 'jsp-status-confirmed', label: 'Confirmed' }
    case 'cancelled': return { cls: 'jsp-status-cancelled', label: 'Cancelled' }
    case 'partial_error': return { cls: 'jsp-status-alert', label: 'Needs attention' }
    case 'active': return { cls: 'jsp-status-pending', label: 'Active' }
    case 'creating': return { cls: 'jsp-status-pending', label: 'Creating' }
    case 'queued': return { cls: 'jsp-status-pending', label: 'Queued' }
    default: return { cls: 'jsp-status-pending', label: 'Draft' }
  }
}

// A small red diamond glyph — the design system's recurring motif, used here
// to mirror .jsp-kicker's own leading diamond on the other side of a label.
function DiamondGlyph({ size = '0.45rem' }: { size?: string }) {
  return (
    <span
      aria-hidden
      style={{ display: 'inline-block', width: size, height: size, background: 'var(--jsp-red)', transform: 'rotate(45deg)', flex: 'none' }}
    />
  )
}

function Skeleton({ className = '', style }: { className?: string; style?: CSSProperties }) {
  return <div className={`animate-pulse rounded-lg ${className}`} style={{ background: 'var(--jsp-line)', ...style }} />
}

// Geometric outline marks for the four action cards — no emoji anywhere.
function IconDiamond() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden>
      <rect x="4" y="4" width="12" height="12" stroke="var(--jsp-red)" strokeWidth="1.5" transform="rotate(45 10 10)" />
    </svg>
  )
}
function IconCircle() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden>
      <circle cx="10" cy="10" r="7" stroke="var(--jsp-red)" strokeWidth="1.5" />
    </svg>
  )
}
function IconSquare() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden>
      <rect x="3.5" y="3.5" width="13" height="13" stroke="var(--jsp-red)" strokeWidth="1.5" />
    </svg>
  )
}
function IconHalfCircle() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden>
      <path d="M10 3 A7 7 0 0 1 10 17 Z" fill="var(--jsp-red)" />
      <circle cx="10" cy="10" r="7" stroke="var(--jsp-red)" strokeWidth="1.5" />
    </svg>
  )
}

function ActionCard({ href, title, desc, icon }: { href: string; title: string; desc: string; icon: ReactNode }) {
  const [hover, setHover] = useState(false)
  return (
    <Link
      href={href}
      className="jsp-card p-5 flex flex-col gap-3 transition-colors"
      style={{ borderColor: hover ? 'var(--jsp-red)' : undefined }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      {icon}
      <div>
        <p className="font-semibold text-sm" style={{ color: 'var(--jsp-ink)' }}>{title}</p>
        <p className="text-xs mt-0.5" style={{ color: 'var(--jsp-muted)' }}>{desc}</p>
      </div>
    </Link>
  )
}

export default function Home() {
  const me = useWhoami()

  // Dev "?as=" override passthrough for every internal link on this page.
  const [qs, setQs] = useState('')
  useEffect(() => { setQs(window.location.search) }, [])

  // "Now", taken once on mount — see snapshotNow().
  const [today, setToday] = useState<TodaySnapshot | null>(null)
  const [selectedIso, setSelectedIso] = useState('')
  useEffect(() => {
    const snap = snapshotNow()
    setToday(snap)
    setSelectedIso(snap.todayIso)
  }, [])

  // The signed-in user's own booking groups.
  const [myGroups, setMyGroups] = useState<GroupSummary[] | null>(null)
  useEffect(() => {
    let cancelled = false
    cachedFetch<{ groups: GroupSummary[] }>('my-groups', '/api/groups?mine=1', fresh => {
      if (!cancelled) setMyGroups(fresh.groups ?? [])
    })
      .then(initial => { if (!cancelled && initial) setMyGroups(initial.groups ?? []) })
      .catch(() => { if (!cancelled) setMyGroups([]) })
    return () => { cancelled = true }
  }, [])

  // This month's events, fetched once "today" is known — feeds the mini
  // calendar dots, the upcoming-events list, and today's room status.
  const [monthEvents, setMonthEvents] = useState<CalendarEvent[] | null>(null)
  useEffect(() => {
    if (!today) return
    let cancelled = false
    const key = `dash-events-${today.year}-${pad2(today.month + 1)}`
    const url = `/api/events?date_from=${today.monthFirstIso}&date_to=${today.monthLastIso}&page_size=200`
    cachedFetch<PaginatedEvents>(key, url, fresh => {
      if (!cancelled) setMonthEvents(fresh.data ?? [])
    })
      .then(initial => { if (!cancelled && initial) setMonthEvents(initial.data ?? []) })
      .catch(() => { if (!cancelled) setMonthEvents([]) })
    return () => { cancelled = true }
  }, [today])

  const monthGrid = useMemo(() => (today ? buildMonthGrid(today.year, today.month) : []), [today])

  const eventsByDate = useMemo(() => {
    const map = new Map<string, CalendarEvent[]>()
    for (const ev of monthEvents ?? []) {
      if (isCancelledStatus(ev.status)) continue
      const list = map.get(ev.event_date) ?? []
      list.push(ev)
      map.set(ev.event_date, list)
    }
    for (const list of map.values()) list.sort((a, b) => a.event_start.localeCompare(b.event_start))
    return map
  }, [monthEvents])

  const selectedDayEvents = eventsByDate.get(selectedIso) ?? []
  const selectedLabel = useMemo(() => {
    if (!selectedIso) return ''
    const [y, m, d] = selectedIso.split('-').map(Number)
    return new Date(y, m - 1, d).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })
  }, [selectedIso])

  const upcomingEvents = useMemo(() => {
    if (!today) return []
    return (monthEvents ?? [])
      .filter(ev => !isCancelledStatus(ev.status) && ev.event_date >= today.todayIso)
      .sort((a, b) => (a.event_date === b.event_date ? a.event_start.localeCompare(b.event_start) : a.event_date.localeCompare(b.event_date)))
      .slice(0, 4)
  }, [monthEvents, today])

  const roomsToday = useMemo(() => {
    if (!today) return []
    const todays = (monthEvents ?? []).filter(ev => ev.event_date === today.todayIso && !isCancelledStatus(ev.status))
    return ROOM_NAMES.slice(0, 6).map(room => {
      const matches = todays.filter(ev => roomsInLocation(ev.location).has(room))
      const current = matches.filter(ev => isAllDay(ev.event_start, ev.event_end) || toMinutes(ev.event_end) > today.nowMinutes)
      if (current.length === 0) return { room, free: true, label: 'Free today' }
      if (current.some(ev => isAllDay(ev.event_start, ev.event_end))) return { room, free: false, label: 'Busy all day' }
      const latestEnd = current.reduce((max, ev) => (ev.event_end > max ? ev.event_end : max), current[0].event_end)
      return { room, free: false, label: `Busy until ${formatTime12(latestEnd)}` }
    })
  }, [monthEvents, today])

  // Bookings panel derivations.
  const activeGroups = (myGroups ?? []).filter(g => g.status !== 'cancelled')
  const needsAttention = activeGroups.filter(g => !g.function_form_complete || g.missing_fields.length > 0 || g.days_failed > 0)
  const alertGroup = activeGroups.find(g => !g.function_form_complete) ?? null
  const todayIsoForSort = today?.todayIso ?? ''
  const topBookings = [...activeGroups]
    .sort((a, b) => {
      const aUp = a.date_to >= todayIsoForSort
      const bUp = b.date_to >= todayIsoForSort
      if (aUp !== bUp) return aUp ? -1 : 1
      return a.date_from.localeCompare(b.date_from)
    })
    .slice(0, 3)

  const heroDateLabel = today
    ? new Date(today.year, today.month, today.day).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
    : ''

  return (
    <PortalShell active="home" wide>
      {/* ── Hero ─────────────────────────────────────────────────────────── */}
      <div className="text-center max-w-2xl mx-auto py-4 sm:py-8 mb-10">
        <div className="flex items-center justify-center gap-3 mb-4">
          {today ? (
            <>
              <p className="jsp-kicker">{heroDateLabel}</p>
              <DiamondGlyph />
            </>
          ) : (
            <Skeleton className="h-4 w-52" />
          )}
        </div>
        <h1 className="jsp-display text-4xl sm:text-5xl mb-4">House Calendar Portal</h1>
        <p className="text-base sm:text-lg" style={{ color: 'var(--jsp-muted)' }}>
          Book spaces, track your requests, and see what&apos;s on across the house — all in one place.
        </p>
      </div>

      {/* ── Your bookings + primary actions ─────────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 mb-14">
        <div className="lg:col-span-7 jsp-card p-6">
          <div className="flex items-center justify-between gap-2 mb-4">
            <p className="jsp-kicker">YOUR BOOKINGS</p>
            <Link href={withQS('/my', qs)} className="text-sm font-semibold" style={{ color: 'var(--jsp-red)' }}>
              View all →
            </Link>
          </div>

          {myGroups === null ? (
            <div className="space-y-3">
              <Skeleton className="h-7 w-40" />
              <Skeleton className="h-4 w-56" />
              <Skeleton className="h-14" />
              <Skeleton className="h-14" />
            </div>
          ) : (
            <>
              <h2 className="jsp-display text-2xl mb-1">{me?.name ? `Hi, ${me.name}` : 'Welcome back'}</h2>
              <p className="text-sm mb-4" style={{ color: 'var(--jsp-muted)' }}>
                {myGroups.length} request{myGroups.length === 1 ? '' : 's'} · {needsAttention.length} needs attention
              </p>

              {alertGroup && (
                <div
                  className="rounded-xl p-3 flex flex-wrap items-center justify-between gap-2 mb-4"
                  style={{ background: 'rgba(240,30,55,0.07)', border: '1px solid rgba(240,30,55,0.25)' }}
                >
                  <span className="flex items-center gap-2 text-sm min-w-0">
                    <DiamondGlyph />
                    <span className="min-w-0">
                      <strong>{alertGroup.event_name}</strong> still needs its function form before the box office can confirm.
                    </span>
                  </span>
                  <Link
                    href={withQS(`/function-form?group=${encodeURIComponent(alertGroup.group_id)}`, qs)}
                    className="text-sm font-semibold shrink-0"
                    style={{ color: 'var(--jsp-red)' }}
                  >
                    Complete form →
                  </Link>
                </div>
              )}

              {myGroups.length === 0 ? (
                <div>
                  <p className="text-sm mb-4" style={{ color: 'var(--jsp-muted)' }}>No bookings yet.</p>
                  <Link href={withQS('/submit', qs)} className="jsp-btn">Book a Space</Link>
                </div>
              ) : (
                <div>
                  {topBookings.map((g, i) => {
                    const pill = groupStatusPill(g.status)
                    return (
                      <div
                        key={g.group_id}
                        className="flex flex-wrap items-center justify-between gap-2 py-2.5"
                        style={{ borderTop: i === 0 ? 'none' : '1px solid var(--jsp-line)' }}
                      >
                        <div className="min-w-0">
                          <p className="text-sm font-semibold truncate">{g.event_name}</p>
                          <p className="text-xs truncate" style={{ color: 'var(--jsp-muted)' }}>
                            {bookingDateLabel(g.date_from, g.date_to)} · {g.location || 'No room set'}
                          </p>
                        </div>
                        <span className={`jsp-status ${pill.cls}`}>{pill.label}</span>
                      </div>
                    )
                  })}
                </div>
              )}
            </>
          )}
        </div>

        <div className="lg:col-span-5 grid grid-cols-1 sm:grid-cols-2 gap-4">
          <ActionCard href={withQS('/submit', qs)} title="Book a Space" desc="Single day or a whole range" icon={<IconDiamond />} />
          <ActionCard href={withQS('/my', qs)} title="My Bookings" desc="Track, edit, or cancel" icon={<IconCircle />} />
          <ActionCard href={withQS('/availability', qs)} title="Availability" desc="Check a date or a range" icon={<IconSquare />} />
          <ActionCard href={withQS('/calendar', qs)} title="Calendar" desc="Month, week, or day" icon={<IconHalfCircle />} />
        </div>
      </div>

      {/* ── At a glance ──────────────────────────────────────────────────── */}
      <section>
        <p className="jsp-kicker mb-2">AT A GLANCE</p>
        <div className="flex flex-wrap items-center justify-between gap-3 mb-6">
          <h2 className="jsp-display text-2xl sm:text-3xl">{today ? `${today.monthName} at JS` : 'This month at JS'}</h2>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
            <Link href={withQS('/calendar', qs)} className="font-semibold" style={{ color: 'var(--jsp-red)' }}>Open full calendar →</Link>
            <Link href={withQS('/availability', qs)} className="font-semibold" style={{ color: 'var(--jsp-red)' }}>Check availability →</Link>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          {/* Mini month calendar */}
          <div className="lg:col-span-5 jsp-card p-5">
            {!today ? (
              <Skeleton className="h-80" />
            ) : (
              <>
                <div className="flex items-center justify-between gap-2 mb-4 flex-wrap">
                  <h3 className="jsp-display text-lg">{today.monthName} {today.year}</h3>
                  <button type="button" onClick={() => setSelectedIso(today.todayIso)} className="jsp-chip" data-on="true">
                    Today · {shortDate(today.todayIso)}
                  </button>
                </div>

                <div className="grid grid-cols-7 gap-1 mb-1 text-center text-[0.65rem] font-semibold uppercase tracking-wide" style={{ color: 'var(--jsp-muted)' }}>
                  {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((d, i) => <span key={i}>{d}</span>)}
                </div>
                <div className="grid grid-cols-7 gap-1">
                  {monthGrid.map(cell => {
                    const isToday = cell.iso === today.todayIso
                    const isSelected = cell.iso === selectedIso
                    const dots = (eventsByDate.get(cell.iso) ?? []).slice(0, 3)
                    return (
                      <button
                        key={cell.iso}
                        type="button"
                        onClick={() => setSelectedIso(cell.iso)}
                        className="flex flex-col items-center gap-1 py-1.5 rounded-lg"
                        style={{ opacity: cell.inMonth ? 1 : 0.38 }}
                      >
                        <span
                          className="w-6 h-6 rounded-full grid place-items-center text-xs"
                          style={
                            isToday
                              ? { background: 'var(--jsp-red)', color: '#fff', fontWeight: 700 }
                              : isSelected
                                ? { boxShadow: '0 0 0 1.5px var(--jsp-red)', color: 'var(--jsp-ink)' }
                                : { color: 'var(--jsp-ink)' }
                          }
                        >
                          {cell.day}
                        </span>
                        <span className="flex items-center gap-0.5 h-1.5">
                          {dots.map(ev => (
                            <span key={ev.id} className="jsp-dot" style={{ background: deptColorFor(ev.department).bg }} />
                          ))}
                        </span>
                      </button>
                    )
                  })}
                </div>

                <div className="mt-4 pt-4 border-t" style={{ borderColor: 'var(--jsp-line)' }}>
                  <p className="text-sm font-semibold mb-2">
                    {selectedLabel}
                    {selectedIso ? ` — ${selectedDayEvents.length} event${selectedDayEvents.length === 1 ? '' : 's'}` : ''}
                  </p>
                  {selectedDayEvents.length === 0 ? (
                    <p className="text-xs" style={{ color: 'var(--jsp-muted)' }}>No events that day.</p>
                  ) : (
                    <div className="space-y-1.5">
                      {selectedDayEvents.map(ev => (
                        <div key={ev.id} className="flex items-center gap-2 text-xs">
                          <span className="w-16 shrink-0" style={{ color: 'var(--jsp-muted)' }}>
                            {isAllDay(ev.event_start, ev.event_end) ? 'All day' : formatTime12(ev.event_start)}
                          </span>
                          <span className="jsp-dot" style={{ background: deptColorFor(ev.department).bg }} />
                          <span className="font-medium truncate flex-1">{ev.event_name}</span>
                          <span className="shrink-0 truncate max-w-[35%] text-right" style={{ color: 'var(--jsp-muted)' }}>
                            {Array.from(roomsInLocation(ev.location))[0] ?? ev.location ?? ''}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </>
            )}
          </div>

          {/* Upcoming events + rooms today */}
          <div className="lg:col-span-7 flex flex-col gap-6">
            <div className="jsp-card p-5">
              <div className="flex items-center justify-between gap-2 mb-3">
                <p className="jsp-kicker">UPCOMING EVENTS</p>
                <Link href={withQS('/calendar', qs)} className="text-sm font-semibold" style={{ color: 'var(--jsp-red)' }}>Full calendar →</Link>
              </div>
              {!today || monthEvents === null ? (
                <div className="space-y-3">
                  <Skeleton className="h-10" />
                  <Skeleton className="h-10" />
                  <Skeleton className="h-10" />
                  <Skeleton className="h-10" />
                </div>
              ) : upcomingEvents.length === 0 ? (
                <p className="text-sm" style={{ color: 'var(--jsp-muted)' }}>Nothing else on the books this month.</p>
              ) : (
                <div>
                  {upcomingEvents.map((ev, i) => (
                    <div
                      key={ev.id}
                      className="flex items-center gap-3 py-2.5"
                      style={{ borderTop: i === 0 ? 'none' : '1px solid var(--jsp-line)' }}
                    >
                      <span className="text-xs font-bold w-12 shrink-0" style={{ color: 'var(--jsp-red)' }}>
                        {shortDate(ev.event_date).toUpperCase()}
                      </span>
                      <span className="jsp-dot" style={{ background: deptColorFor(ev.department).bg }} />
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-semibold truncate">{ev.event_name}</p>
                        <p className="text-xs truncate" style={{ color: 'var(--jsp-muted)' }}>
                          {isAllDay(ev.event_start, ev.event_end) ? 'All day' : formatTime12(ev.event_start)} · {Array.from(roomsInLocation(ev.location))[0] ?? ev.location ?? 'TBD'}
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="jsp-card p-5">
              <div className="flex items-center justify-between gap-2 mb-3">
                <p className="jsp-kicker">ROOMS TODAY</p>
                <Link href={withQS('/availability', qs)} className="text-sm font-semibold" style={{ color: 'var(--jsp-red)' }}>Check availability →</Link>
              </div>
              {!today || monthEvents === null ? (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-10" />)}
                </div>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1">
                  {roomsToday.map(r => (
                    <div key={r.room} className="flex items-center gap-2 py-1.5 text-sm">
                      <span className="jsp-dot" style={{ background: r.free ? 'var(--jsp-green)' : 'var(--jsp-red)' }} />
                      <span className="truncate flex-1">{r.room}</span>
                      <span className="text-xs font-medium shrink-0" style={{ color: r.free ? 'var(--jsp-green)' : 'var(--jsp-red)' }}>
                        {r.label}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      </section>
    </PortalShell>
  )
}
