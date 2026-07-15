'use client'

import { useCallback, useMemo, useRef, useState } from 'react'
import type { RefObject } from 'react'
import FullCalendar from '@fullcalendar/react'
import dayGridPlugin from '@fullcalendar/daygrid'
import timeGridPlugin from '@fullcalendar/timegrid'
import type { DatesSetArg, EventClickArg, EventInput } from '@fullcalendar/core'
import { ROOM_NAMES, locationMatchesAny } from '../lib/rooms'
import { deptColorFor, DEPT_LEGEND, DEPT_COLORS } from '../lib/departments'
import {
  isAllDay, isConfirmedStatus, isCancelledStatus, formatTime12, formatTimeRange,
} from '../lib/status'
import type { CalendarEvent, PaginatedEvents } from '../lib/types'

type StatusBucket = 'confirmed' | 'tentative' | 'cancelled'

function bucketOf(ev: CalendarEvent): StatusBucket {
  if (isCancelledStatus(ev.status)) return 'cancelled'
  if (isConfirmedStatus(ev.status)) return 'confirmed'
  // Pending/Contingent/TBD and anything unrecognised counts as tentative —
  // an unknown status should read as "maybe happening", never as confirmed.
  return 'tentative'
}

// "2026-10-19" -> "Mon, Oct 19, 2026"
function formatFullDate(iso: string): string {
  const d = new Date(`${iso}T12:00:00Z`)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleDateString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC',
  })
}

export default function CalendarView({ isDark, t }: { isDark: boolean, t: (key: string) => string }) {
  const [events, setEvents] = useState<CalendarEvent[]>([])
  const [loading, setLoading] = useState(false)
  const [buckets, setBuckets] = useState<Record<StatusBucket, boolean>>({
    confirmed: true, tentative: true, cancelled: false,
  })
  const [selRooms, setSelRooms] = useState<string[]>([])
  const [selected, setSelected] = useState<CalendarEvent | null>(null)
  // Range already fetched, so switching views/filters inside it skips the refetch
  const fetchedRange = useRef<string>('')
  const calendarRef: RefObject<FullCalendar | null> = useRef(null)

  // Search panel: free-text (name/location/department/contact) + optional date range
  const [searchQuery, setSearchQuery] = useState({ text: '', date_from: '', date_to: '' })
  const [searchResults, setSearchResults] = useState<CalendarEvent[] | null>(null)
  const [searchLoading, setSearchLoading] = useState(false)

  const runSearch = useCallback(async () => {
    const { text, date_from, date_to } = searchQuery
    if (!text && !date_from && !date_to) return
    setSearchLoading(true)
    try {
      const all: CalendarEvent[] = []
      for (let page = 1; page <= 5; page++) {
        const params = new URLSearchParams({ page_size: '200', page: String(page) })
        if (text) params.set('search', text)
        if (date_from) params.set('date_from', date_from)
        if (date_to) params.set('date_to', date_to)
        const res = await fetch(`/api/events?${params}`)
        if (!res.ok) break
        const json: PaginatedEvents = await res.json()
        all.push(...(json.data || []))
        if (all.length >= (json.pagination?.total ?? 0) || (json.data || []).length === 0) break
      }
      setSearchResults(all)
    } catch {
      setSearchResults([])
    } finally {
      setSearchLoading(false)
    }
  }, [searchQuery])

  const clearSearch = useCallback(() => {
    setSearchQuery({ text: '', date_from: '', date_to: '' })
    setSearchResults(null)
  }, [])

  // Clicking a search result jumps the calendar to that date and opens the detail card
  const goToResult = useCallback((ev: CalendarEvent) => {
    calendarRef.current?.getApi().gotoDate(ev.event_date)
    setSelected(ev)
  }, [])

  const handleDatesSet = useCallback(async (arg: DatesSetArg) => {
    const from = arg.startStr.slice(0, 10)
    const to = arg.endStr.slice(0, 10)
    const key = `${from}..${to}`
    if (fetchedRange.current === key) return
    fetchedRange.current = key
    setLoading(true)
    try {
      const all: CalendarEvent[] = []
      for (let page = 1; page <= 25; page++) {
        const params = new URLSearchParams({
          date_from: from, date_to: to, page_size: '200', page: String(page),
        })
        const res = await fetch(`/api/events?${params}`)
        if (!res.ok) break
        const json: PaginatedEvents = await res.json()
        all.push(...(json.data || []))
        if (all.length >= (json.pagination?.total ?? 0) || (json.data || []).length === 0) break
      }
      setEvents(all)
    } catch {
      fetchedRange.current = ''
    } finally {
      setLoading(false)
    }
  }, [])

  const fcEvents: EventInput[] = useMemo(() =>
    events
      .filter(ev => buckets[bucketOf(ev)])
      .filter(ev => locationMatchesAny(ev.location, selRooms))
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
      }),
    [events, buckets, selRooms])

  const handleEventClick = useCallback((arg: EventClickArg) => {
    setSelected((arg.event.extendedProps as { ev: CalendarEvent }).ev)
  }, [])

  const toggleBucket = (b: StatusBucket) =>
    setBuckets(prev => ({ ...prev, [b]: !prev[b] }))

  const toggleRoom = (room: string) =>
    setSelRooms(prev => prev.includes(room) ? prev.filter(r => r !== room) : [...prev, room])

  const chip = (active: boolean) =>
    `px-3 py-1.5 rounded-full text-xs font-medium border transition-all duration-200 ${
      active
        ? isDark ? 'bg-red-900/60 border-red-700 text-red-100' : 'bg-red-100 border-red-300 text-red-800'
        : isDark ? 'bg-gray-700/40 border-gray-600 text-gray-400 hover:text-gray-200' : 'bg-gray-50 border-gray-200 text-gray-400 hover:text-gray-700'
    }`

  const selectedBucket = selected ? bucketOf(selected) : null

  return (
    <section className="animate-fadeIn">
      <div className="text-center mb-8">
        <h2 className={`text-3xl md:text-4xl font-bold mb-4 ${isDark ? 'text-white' : 'text-gray-900'}`}>
          {t('schedule.title')}
        </h2>
        <p className={`text-lg max-w-2xl mx-auto ${isDark ? 'text-gray-300' : 'text-gray-600'}`}>
          {t('schedule.desc')}
        </p>
      </div>

      {/* Search */}
      <div className={`rounded-2xl border p-4 mb-4 ${isDark ? 'bg-gray-800 border-red-800/30' : 'bg-white border-red-200'}`}>
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex-1 min-w-[220px]">
            <label className={`block text-xs font-medium mb-1 ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>Search</label>
            <input
              type="text"
              placeholder="Event name, location, department, or contact…"
              value={searchQuery.text}
              onChange={e => setSearchQuery(q => ({ ...q, text: e.target.value }))}
              onKeyDown={e => { if (e.key === 'Enter') runSearch() }}
              className={`w-full rounded-lg border px-3 py-2 text-sm ${isDark ? 'bg-gray-700 border-gray-600 text-white placeholder-gray-500' : 'bg-white border-gray-300 text-gray-900 placeholder-gray-400'}`}
            />
          </div>
          <div>
            <label className={`block text-xs font-medium mb-1 ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>From</label>
            <input
              type="date"
              value={searchQuery.date_from}
              onChange={e => setSearchQuery(q => ({ ...q, date_from: e.target.value }))}
              className={`rounded-lg border px-3 py-2 text-sm ${isDark ? 'bg-gray-700 border-gray-600 text-white' : 'bg-white border-gray-300 text-gray-900'}`}
            />
          </div>
          <div>
            <label className={`block text-xs font-medium mb-1 ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>To</label>
            <input
              type="date"
              value={searchQuery.date_to}
              min={searchQuery.date_from || undefined}
              onChange={e => setSearchQuery(q => ({ ...q, date_to: e.target.value }))}
              className={`rounded-lg border px-3 py-2 text-sm ${isDark ? 'bg-gray-700 border-gray-600 text-white' : 'bg-white border-gray-300 text-gray-900'}`}
            />
          </div>
          <button
            onClick={runSearch}
            disabled={searchLoading || (!searchQuery.text && !searchQuery.date_from && !searchQuery.date_to)}
            className={`px-5 py-2 rounded-lg font-medium text-sm transition-all ${
              !searchLoading && (searchQuery.text || searchQuery.date_from || searchQuery.date_to)
                ? 'bg-red-600 text-white hover:bg-red-700'
                : isDark ? 'bg-gray-700 text-gray-500 cursor-not-allowed' : 'bg-gray-200 text-gray-400 cursor-not-allowed'
            }`}
          >
            {searchLoading ? 'Searching…' : 'Search'}
          </button>
          {searchResults !== null && (
            <button
              onClick={clearSearch}
              className={`px-4 py-2 rounded-lg font-medium text-sm ${isDark ? 'bg-gray-700 text-gray-300 hover:bg-gray-600' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}
            >
              Clear
            </button>
          )}
        </div>

        {searchResults !== null && (
          <div className="mt-4">
            <p className={`text-xs font-semibold uppercase tracking-wide mb-2 ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
              {searchResults.length} result{searchResults.length === 1 ? '' : 's'}
              {searchResults.length > 0 && ' · click a row to jump to it on the calendar'}
            </p>
            {searchResults.length > 0 && (
              <div className={`max-h-72 overflow-y-auto rounded-xl border divide-y ${isDark ? 'border-gray-700 divide-gray-700' : 'border-gray-200 divide-gray-100'}`}>
                {searchResults.map(ev => (
                  <div
                    key={ev.id}
                    onClick={() => goToResult(ev)}
                    className={`flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-xs cursor-pointer ${
                      isDark ? 'text-gray-300 hover:bg-gray-700/50' : 'text-gray-700 hover:bg-gray-50'
                    }`}
                  >
                    <span className="font-semibold w-24 shrink-0">{formatFullDate(ev.event_date).replace(/, \d{4}$/, '')}</span>
                    <span className={`font-medium ${isDark ? 'text-white' : 'text-gray-900'}`}>{ev.event_name}</span>
                    {ev.location && <span className="opacity-70">{ev.location}</span>}
                    <span className="opacity-70">{formatTimeRange(ev.event_start, ev.event_end)}</span>
                    <span className={`ml-auto px-2 py-0.5 rounded-full font-semibold ${
                      isConfirmedStatus(ev.status)
                        ? isDark ? 'bg-green-900/60 text-green-200' : 'bg-green-100 text-green-800'
                        : isCancelledStatus(ev.status)
                          ? isDark ? 'bg-gray-700 text-gray-300' : 'bg-gray-200 text-gray-600'
                          : isDark ? 'bg-yellow-900/50 text-yellow-200' : 'bg-yellow-100 text-yellow-800'
                    }`}>{ev.status || 'Pending'}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Filters */}
      <div className={`rounded-2xl border p-4 mb-6 ${isDark ? 'bg-gray-800 border-red-800/30' : 'bg-white border-red-200'}`}>
        <div className="flex flex-wrap items-center gap-2 mb-3">
          <span className={`text-xs font-semibold uppercase tracking-wide mr-1 ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
            Status
          </span>
          <button onClick={() => toggleBucket('confirmed')} className={chip(buckets.confirmed)}>
            <span className={`inline-block w-2 h-2 rounded-full mr-1.5 align-middle border-2 ${isDark ? 'bg-gray-200 border-gray-200' : 'bg-gray-700 border-gray-700'}`} />
            Confirmed
          </button>
          <button onClick={() => toggleBucket('tentative')} className={chip(buckets.tentative)}>
            <span className={`inline-block w-2 h-2 rounded-full mr-1.5 align-middle border-2 border-dashed ${isDark ? 'border-gray-300' : 'border-gray-500'}`} />
            Tentative
          </button>
          <button onClick={() => toggleBucket('cancelled')} className={chip(buckets.cancelled)}>
            <span className="inline-block w-2 h-2 rounded-full mr-1.5 align-middle bg-gray-400" />
            Cancelled
          </button>
          {loading && (
            <span className={`text-xs ml-2 ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>Loading…</span>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 mb-3">
          <span className={`text-xs font-semibold uppercase tracking-wide mr-1 ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
            Colors
          </span>
          {DEPT_LEGEND.map(({ label, dept }) => (
            <span key={dept} title={dept} className={`inline-flex items-center gap-1.5 text-xs ${isDark ? 'text-gray-300' : 'text-gray-600'}`}>
              <span
                className="inline-block w-3 h-3 rounded-sm border"
                style={{
                  backgroundColor: DEPT_COLORS[dept].bg,
                  borderColor: DEPT_COLORS[dept].border ?? DEPT_COLORS[dept].bg,
                }}
              />
              {label}
            </span>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className={`text-xs font-semibold uppercase tracking-wide mr-1 ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
            Rooms
          </span>
          {ROOM_NAMES.map(room => (
            <button key={room} onClick={() => toggleRoom(room)} className={chip(selRooms.includes(room))}>
              {room}
            </button>
          ))}
          {selRooms.length > 0 && (
            <button
              onClick={() => setSelRooms([])}
              className={`text-xs underline underline-offset-2 ${isDark ? 'text-red-400 hover:text-red-300' : 'text-red-600 hover:text-red-700'}`}
            >
              Clear
            </button>
          )}
        </div>
      </div>

      {/* Calendar */}
      <div className={`js-cal ${isDark ? 'js-cal-dark' : ''} rounded-2xl border p-4 ${
        isDark ? 'bg-gray-800 border-red-800/30' : 'bg-white border-red-200'
      }`}>
        <FullCalendar
          ref={calendarRef}
          plugins={[dayGridPlugin, timeGridPlugin]}
          initialView="dayGridMonth"
          headerToolbar={{
            left: 'prev,next today',
            center: 'title',
            right: 'dayGridMonth,timeGridWeek,timeGridDay',
          }}
          buttonText={{ today: 'Today', month: 'Month', week: 'Week', day: 'Day' }}
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

      {/* Event detail modal */}
      {selected && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4"
          onClick={() => setSelected(null)}
        >
          <div
            className={`w-full max-w-lg rounded-2xl border shadow-2xl p-6 max-h-[85vh] overflow-y-auto ${
              isDark ? 'bg-gray-800 border-red-800/30 text-gray-200' : 'bg-white border-red-200 text-gray-800'
            }`}
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-4 mb-4">
              <h3 className={`text-xl font-bold ${isDark ? 'text-white' : 'text-gray-900'}`}>
                {selected.event_name}
              </h3>
              <button
                onClick={() => setSelected(null)}
                className={`shrink-0 rounded-full w-8 h-8 flex items-center justify-center ${
                  isDark ? 'bg-gray-700 hover:bg-gray-600' : 'bg-gray-100 hover:bg-gray-200'
                }`}
                aria-label="Close"
              >
                ✕
              </button>
            </div>

            <span className={`inline-block px-3 py-1 rounded-full text-xs font-semibold mb-4 ${
              selectedBucket === 'confirmed'
                ? isDark ? 'bg-green-900/60 text-green-200' : 'bg-green-100 text-green-800'
                : selectedBucket === 'cancelled'
                  ? isDark ? 'bg-gray-700 text-gray-300' : 'bg-gray-200 text-gray-600'
                  : isDark ? 'bg-yellow-900/50 text-yellow-200' : 'bg-yellow-100 text-yellow-800'
            }`}>
              {selected.status || 'Pending'}
            </span>

            <dl className="space-y-2 text-sm">
              {[
                ['Date', formatFullDate(selected.event_date)],
                ['Event Time', formatTimeRange(selected.event_start, selected.event_end)],
                ['Hold Time', selected.hold_start && selected.hold_end
                  ? formatTimeRange(selected.hold_start, selected.hold_end) : ''],
                ['Doors Open', formatTime12(selected.doors_open)],
                ['Check-In', formatTime12(selected.check_in_time)],
                ['Run Time', formatTime12(selected.run_time)],
                ['Location', selected.location || ''],
                ['Department', selected.department || ''],
                ['Count', selected.count != null ? String(selected.count) : ''],
                ['Contact', selected.contact_name !== 'Unknown' ? selected.contact_name : ''],
                ['Email', selected.email || ''],
                ['Phone', selected.phone || ''],
                ['Submitted', selected.submitted_at ? selected.submitted_at.slice(0, 16) : ''],
              ].filter(([, v]) => v).map(([label, value]) => (
                <div key={label} className="flex gap-3">
                  <dt className={`w-28 shrink-0 font-medium ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>{label}</dt>
                  <dd className="break-words min-w-0">{value}</dd>
                </div>
              ))}
              {selected.description && (
                <div className="flex gap-3">
                  <dt className={`w-28 shrink-0 font-medium ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>Notes</dt>
                  <dd className="break-words min-w-0 whitespace-pre-wrap">{selected.description}</dd>
                </div>
              )}
              {selected.attachment_url && (
                <div className="flex gap-3">
                  <dt className={`w-28 shrink-0 font-medium ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>Attachment</dt>
                  <dd className="break-words min-w-0">
                    <a
                      href={selected.attachment_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className={`underline underline-offset-2 ${isDark ? 'text-red-400 hover:text-red-300' : 'text-red-600 hover:text-red-700'}`}
                    >
                      View attachment ↗
                    </a>
                  </dd>
                </div>
              )}
            </dl>
          </div>
        </div>
      )}
    </section>
  )
}
