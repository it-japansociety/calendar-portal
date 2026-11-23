'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { RefObject } from 'react'
import FullCalendar from '@fullcalendar/react'
import dayGridPlugin from '@fullcalendar/daygrid'
import timeGridPlugin from '@fullcalendar/timegrid'
import type { DatesSetArg, EventClickArg, EventInput } from '@fullcalendar/core'
import { ROOM_NAMES, locationMatchesAny } from '../lib/rooms'
import { deptColorFor, DEPT_LEGEND, DEPT_COLORS } from '../lib/departments'
import {
  isAllDay, isConfirmedStatus, isCancelledStatus, formatTimeRange,
} from '../lib/status'
import type { CalendarEvent, PaginatedEvents } from '../lib/types'
import { PortalHero, useSystemTheme } from './PortalShell'

type StatusBucket = 'confirmed' | 'tentative' | 'cancelled'
type ViewType = 'dayGridMonth' | 'timeGridWeek' | 'timeGridDay'

function bucketOf(ev: CalendarEvent): StatusBucket {
  if (isCancelledStatus(ev.status)) return 'cancelled'
  if (isConfirmedStatus(ev.status)) return 'confirmed'
  // Pending/Contingent/TBD and anything unrecognised counts as tentative —
  // an unknown status should read as "maybe happening", never as confirmed.
  return 'tentative'
}

function bucketPillClass(bucket: StatusBucket | null): string {
  if (bucket === 'confirmed') return 'jsp-status jsp-status-confirmed'
  if (bucket === 'cancelled') return 'jsp-status jsp-status-cancelled'
  return 'jsp-status jsp-status-pending'
}

// "2026-10-19" -> "Mon, Oct 19, 2026"
function formatFullDate(iso: string): string {
  const d = new Date(`${iso}T12:00:00Z`)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleDateString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC',
  })
}

export default function CalendarView() {
  const isDark = useSystemTheme()
  const [events, setEvents] = useState<CalendarEvent[]>([])
  const [loading, setLoading] = useState(false)
  const [buckets, setBuckets] = useState<Record<StatusBucket, boolean>>({
    confirmed: true, tentative: true, cancelled: false,
  })
  const [selRooms, setSelRooms] = useState<string[]>([])
  const [selDepts, setSelDepts] = useState<string[]>([])
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<CalendarEvent | null>(null)
  // Range already fetched, so switching views/filters inside it skips the refetch
  const fetchedRange = useRef<string>('')
  const calendarRef: RefObject<FullCalendar | null> = useRef(null)

  // Header controls (prev/next/today/segmented switcher) are wired to the
  // FullCalendar API via the ref; the title/view/today state stays in sync
  // through datesSet so it never drifts from what FullCalendar is showing.
  const [title, setTitle] = useState(() =>
    new Date().toLocaleDateString('en-US', { month: 'long', year: 'numeric' }))
  const [viewType, setViewType] = useState<ViewType>('dayGridMonth')
  const [showsToday, setShowsToday] = useState(true)

  const handleDatesSet = useCallback(async (arg: DatesSetArg) => {
    setTitle(arg.view.title)
    setViewType(arg.view.type as ViewType)
    const todayIso = new Date().toISOString().slice(0, 10)
    setShowsToday(todayIso >= arg.startStr.slice(0, 10) && todayIso < arg.endStr.slice(0, 10))

    const from = arg.startStr.slice(0, 10)
    const to = arg.endStr.slice(0, 10)
    const key = `${from}..${to}`
    if (fetchedRange.current === key) return
    fetchedRange.current = key
    setLoading(true)
    try {
      const all: CalendarEvent[] = []
      for (let page = 1; page <= 25; page++) {
        // include_archived so past months still show their events (everything
        // 7+ days old is auto-archived); rows archived BEFORE their event date
        // were removed/trashed bookings and are filtered back out below.
        const params = new URLSearchParams({
          date_from: from, date_to: to, page_size: '200', page: String(page),
          include_archived: 'true',
        })
        const res = await fetch(`/api/events?${params}`)
        if (!res.ok) break
        const json: PaginatedEvents = await res.json()
        all.push(...(json.data || []))
        if (all.length >= (json.pagination?.total ?? 0) || (json.data || []).length === 0) break
      }
      // Auto-archived history stays visible; bookings archived before their
      // event date (trashed or removed in JotForm) stay hidden.
      setEvents(all.filter(ev =>
        !ev.is_archived || (ev.archived_at != null && ev.archived_at >= ev.event_date)
      ))
    } catch {
      fetchedRange.current = ''
    } finally {
      setLoading(false)
    }
  }, [])

  const fcEvents: EventInput[] = useMemo(() => {
    const q = search.trim().toLowerCase()
    return events
      .filter(ev => buckets[bucketOf(ev)])
      .filter(ev => locationMatchesAny(ev.location, selRooms))
      .filter(ev => {
        if (selDepts.length === 0) return true
        const parts = (ev.department || '').split(',').map(s => s.trim())
        return selDepts.some(d => parts.includes(d))
      })
      .filter(ev => {
        if (!q) return true
        return [ev.event_name, ev.location, ev.department, ev.contact_name]
          .some(v => (v || '').toLowerCase().includes(q))
      })
      .map(ev => {
        const allDay = isAllDay(ev.event_start, ev.event_end)
        const bucket = bucketOf(ev)
        // Fill color = department (house color sheet); booking status is carried
        // by the border/opacity: solid = confirmed, dashed + faded = tentative.
        const c = deptColorFor(ev.department)
        const cancelled = bucket === 'cancelled'
        return {
          id: String(ev.id),
          title: ev.event_name,
          start: allDay ? ev.event_date : `${ev.event_date}T${ev.event_start}`,
          end: allDay ? undefined : `${ev.event_date}T${ev.event_end}`,
          allDay,
          // Cancelled events keep the gray strikethrough styling from CSS,
          // so no inline colors for them (inline would win over the class).
          ...(cancelled ? {} : {
            backgroundColor: c.bg,
            borderColor: c.border ?? c.bg,
            textColor: c.text,
          }),
          classNames: [
            cancelled ? 'evt-cancelled' : bucket === 'tentative' ? 'evt-dept-tentative' : 'evt-dept-confirmed',
            ...(c.bold && !cancelled ? ['evt-dept-bold'] : []),
          ],
          extendedProps: { ev },
        }
      })
  }, [events, buckets, selRooms, selDepts, search])

  const handleEventClick = useCallback((arg: EventClickArg) => {
    setSelected((arg.event.extendedProps as { ev: CalendarEvent }).ev)
  }, [])

  // Close the detail modal on Escape.
  useEffect(() => {
    if (!selected) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setSelected(null) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selected])

  const toggleBucket = (b: StatusBucket) =>
    setBuckets(prev => ({ ...prev, [b]: !prev[b] }))

  const toggleRoom = (room: string) =>
    setSelRooms(prev => prev.includes(room) ? prev.filter(r => r !== room) : [...prev, room])

  const toggleDept = (dept: string) =>
    setSelDepts(prev => prev.includes(dept) ? prev.filter(d => d !== dept) : [...prev, dept])

  const changeView = (view: ViewType) => calendarRef.current?.getApi().changeView(view)
  const goPrev = () => calendarRef.current?.getApi().prev()
  const goNext = () => calendarRef.current?.getApi().next()
  const goToday = () => calendarRef.current?.getApi().today()

  const selectedBucket = selected ? bucketOf(selected) : null
  const roundBtnStyle = { width: '2.5rem', height: '2.5rem', padding: 0, fontSize: '1.15rem', lineHeight: 1 }

  return (
    <section className="animate-fadeIn">
      <PortalHero
        kicker="CALENDAR"
        title={title}
        actions={
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              aria-label="Previous"
              onClick={goPrev}
              className="jsp-btn-ghost rounded-full inline-flex items-center justify-center"
              style={roundBtnStyle}
            >
              ‹
            </button>
            <button
              type="button"
              aria-label="Next"
              onClick={goNext}
              className="jsp-btn-ghost rounded-full inline-flex items-center justify-center"
              style={roundBtnStyle}
            >
              ›
            </button>
            <button type="button" className="jsp-chip" data-on={showsToday} onClick={goToday}>
              Today
            </button>
            <div className="jsp-navpill">
              <button
                type="button"
                className="jsp-navlink"
                data-active={viewType === 'dayGridMonth'}
                onClick={() => changeView('dayGridMonth')}
              >
                Month
              </button>
              <button
                type="button"
                className="jsp-navlink"
                data-active={viewType === 'timeGridWeek'}
                onClick={() => changeView('timeGridWeek')}
              >
                Week
              </button>
              <button
                type="button"
                className="jsp-navlink"
                data-active={viewType === 'timeGridDay'}
                onClick={() => changeView('timeGridDay')}
              >
                Day
              </button>
            </div>
          </div>
        }
      />

      {/* Filters */}
      <div className="jsp-card p-4 mb-4">
        <input
          type="text"
          className="jsp-input mb-4"
          placeholder="Search events, rooms, departments…"
          value={search}
          onChange={e => setSearch(e.target.value)}
        />

        <div className="mb-3">
          <p className="text-xs font-semibold uppercase tracking-wide mb-2" style={{ color: 'var(--jsp-muted)' }}>
            Status
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className="jsp-chip" data-on={buckets.confirmed} onClick={() => toggleBucket('confirmed')}>
              Confirmed
            </button>
            <button type="button" className="jsp-chip" data-on={buckets.tentative} onClick={() => toggleBucket('tentative')}>
              Tentative
            </button>
            <button type="button" className="jsp-chip" data-on={buckets.cancelled} onClick={() => toggleBucket('cancelled')}>
              Cancelled
            </button>
            {loading && <span className="text-xs" style={{ color: 'var(--jsp-muted)' }}>Loading…</span>}
          </div>
        </div>

        <div className="mb-3">
          <p className="text-xs font-semibold uppercase tracking-wide mb-2" style={{ color: 'var(--jsp-muted)' }}>
            Depts
          </p>
          <div className="flex flex-wrap gap-2">
            {DEPT_LEGEND.map(({ label, dept }) => (
              <button
                key={dept}
                type="button"
                className="jsp-chip"
                data-on={selDepts.includes(dept)}
                onClick={() => toggleDept(dept)}
              >
                <span className="jsp-dot" style={{ background: DEPT_COLORS[dept]?.bg ?? 'var(--jsp-muted)' }} />
                {label}
              </button>
            ))}
          </div>
        </div>

        <div>
          <p className="text-xs font-semibold uppercase tracking-wide mb-2" style={{ color: 'var(--jsp-muted)' }}>
            Rooms
          </p>
          <div className="flex flex-wrap gap-2">
            {ROOM_NAMES.map(room => (
              <button
                key={room}
                type="button"
                className="jsp-chip"
                data-on={selRooms.includes(room)}
                onClick={() => toggleRoom(room)}
              >
                {room}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Calendar */}
      <div className="jsp-card p-2 sm:p-4">
        <div className={`js-cal ${isDark ? 'js-cal-dark' : ''}`}>
          <FullCalendar
            ref={calendarRef}
            plugins={[dayGridPlugin, timeGridPlugin]}
            initialView="dayGridMonth"
            headerToolbar={false}
            events={fcEvents}
            datesSet={handleDatesSet}
            eventClick={handleEventClick}
            eventDisplay="block"
            dayMaxEventRows={5}
            height="auto"
            nowIndicator
            slotMinTime="06:00:00"
            scrollTime="08:00:00"
            eventTimeFormat={{ hour: 'numeric', minute: '2-digit', meridiem: 'short' }}
            slotLabelFormat={{ hour: 'numeric', minute: '2-digit', meridiem: 'short' }}
          />
        </div>
      </div>

      {/* Event detail modal */}
      {selected && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4"
          onClick={() => setSelected(null)}
        >
          <div
            className="jsp-card w-full max-w-lg p-6 max-h-[85vh] overflow-y-auto"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-4 mb-3">
              <h3 className="jsp-display text-xl">{selected.event_name}</h3>
              <button
                type="button"
                aria-label="Close"
                onClick={() => setSelected(null)}
                className="jsp-btn-ghost rounded-full inline-flex items-center justify-center shrink-0"
                style={{ width: '2.25rem', height: '2.25rem', padding: 0 }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
                  <path d="M6 6l12 12M18 6L6 18" />
                </svg>
              </button>
            </div>

            <span className={bucketPillClass(selectedBucket)}>
              {selectedBucket === 'confirmed' ? 'Confirmed' : selectedBucket === 'cancelled' ? 'Cancelled' : (selected.status || 'Pending')}
            </span>

            <dl className="mt-4 text-sm">
              {([
                ['Date', formatFullDate(selected.event_date)],
                ['Event Time', formatTimeRange(selected.event_start, selected.event_end)],
                ['Location', selected.location || ''],
                ['Department', selected.department || ''],
                ['Contact', selected.contact_name && selected.contact_name !== 'Unknown' ? selected.contact_name : ''],
                ['Notes', selected.description || ''],
              ] as [string, string][]).map(([label, value], i) => (
                <div
                  key={label}
                  // Stacked on narrow screens so values never squeeze into
                  // three-word-per-line columns; side by side from sm up.
                  className="flex flex-col sm:flex-row gap-1 sm:gap-3 py-2.5"
                  style={i > 0 ? { borderTop: '1px solid var(--jsp-line)' } : undefined}
                >
                  <dt
                    className="sm:w-28 shrink-0 text-xs font-semibold uppercase tracking-wide sm:pt-0.5"
                    style={{ color: 'var(--jsp-muted)' }}
                  >
                    {label}
                  </dt>
                  <dd className="min-w-0 break-words whitespace-pre-wrap" style={{ color: 'var(--jsp-ink)' }}>
                    {value || '—'}
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        </div>
      )}
    </section>
  )
}
