'use client'

import { useState, useEffect, useCallback } from 'react'
import { translations } from '../utils/translations'
import { ROOM_NAMES, roomsInLocation } from '../lib/rooms'
import type { CalendarEvent, PaginatedEvents } from '../lib/types'

// A booking with no usable time range (blank, equal, or start >= end — e.g. the
// "12:00-12:00" all-day placeholder some submissions default to) occupies the whole day.
function isAllDay(start?: string | null, end?: string | null): boolean {
  return !start || !end || start >= end
}

// Whether an event occupies a requested [start, end) window. All-day bookings always do;
// otherwise two intervals overlap when start < otherEnd && end > otherStart.
function eventOccupies(ev: CalendarEvent, start: string, end: string): boolean {
  if (isAllDay(ev.event_start, ev.event_end)) return true
  return ev.event_start < end && ev.event_end > start
}

// Booking-status buckets for availability. Only a Confirmed booking firmly occupies
// a space; Pending/Contingent/TBD are tentative (contested, not yet decided);
// Released and Cancelled are ignored (and archived events are filtered out upstream).
function isConfirmedStatus(s?: string | null): boolean {
  return (s || '').toLowerCase().trim() === 'confirmed'
}
function isTentativeStatus(s?: string | null): boolean {
  return ['pending', 'contingent', 'tbd'].includes((s || '').toLowerCase().trim())
}
function isReleasedStatus(s?: string | null): boolean {
  return (s || '').toLowerCase().trim() === 'released'
}

// Convert a 24h "HH:MM" string to 12-hour "h:MM AM/PM" for display.
function formatTime12(t?: string | null): string {
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
function formatTimeRange(start?: string | null, end?: string | null): string {
  return isAllDay(start, end) ? 'All day' : `${formatTime12(start)}–${formatTime12(end)}`
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

export default function Home() {
  const [currentSection, setCurrentSection] = useState('home')
  const [isDark, setIsDark] = useState(false)
  const [language, setLanguage] = useState('en')
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)

  // Events DB state
  const [eventsData, setEventsData] = useState<CalendarEvent[]>([])
  const [eventsPagination, setEventsPagination] = useState({ page: 1, page_size: 50, total: 0 })
  const [eventsLoading, setEventsLoading] = useState(false)
  const [eventsFilters, setEventsFilters] = useState({
    date_from: '', date_to: '', status: '', department: '',
    locations: [] as string[],
    search: '', include_archived: false, include_released: false,
    sort: '', dir: 'asc' as 'asc' | 'desc', page: 1,
  })
  const [availQuery, setAvailQuery] = useState({
    date: '', end_date: '', start_time: '', end_time: '',
    locations: [] as string[],
  })
  const [availEvents, setAvailEvents] = useState<CalendarEvent[]>([])
  // The date range the current availEvents were fetched for (set on Check click)
  const [availRange, setAvailRange] = useState<{ from: string; to: string } | null>(null)
  const [availLoading, setAvailLoading] = useState(false)
  // Dates expanded in the range-mode result list to show all blocking bookings
  const [expandedDates, setExpandedDates] = useState<Set<string>>(new Set())

  useEffect(() => {
    const savedTheme = localStorage.getItem('theme')
    const savedLang = localStorage.getItem('language')

    if (savedTheme === 'dark') {
      setIsDark(true)
      document.documentElement.classList.add('dark')
    }

    if (savedLang) setLanguage(savedLang)
  }, [])

  const toggleTheme = useCallback(() => {
    const newIsDark = !isDark
    setIsDark(newIsDark)
    if (newIsDark) {
      document.documentElement.classList.add('dark')
      localStorage.setItem('theme', 'dark')
    } else {
      document.documentElement.classList.remove('dark')
      localStorage.setItem('theme', 'light')
    }
  }, [isDark])

  const toggleLanguage = useCallback(() => {
    const newLang = language === 'en' ? 'ja' : 'en'
    setLanguage(newLang)
    localStorage.setItem('language', newLang)
  }, [language])

  const t = useCallback((key: string) => translations[language]?.[key] || key, [language])

  const showSection = useCallback((section: string) => {
    setCurrentSection(section)
    setMobileMenuOpen(false)
  }, [])

  // Shared between the table fetch and the CSV export so both honour the same filters
  const buildEventsParams = useCallback(() => {
    const params = new URLSearchParams()
    if (eventsFilters.date_from) params.set('date_from', eventsFilters.date_from)
    if (eventsFilters.date_to)   params.set('date_to',   eventsFilters.date_to)
    if (eventsFilters.status)    params.set('status',    eventsFilters.status)
    if (eventsFilters.department) params.set('department', eventsFilters.department)
    if (eventsFilters.locations.length) params.set('locations', eventsFilters.locations.join(','))
    if (eventsFilters.search)    params.set('search',    eventsFilters.search)
    if (eventsFilters.include_archived) params.set('include_archived', 'true')
    if (eventsFilters.include_released) params.set('include_released', 'true')
    if (eventsFilters.sort) { params.set('sort', eventsFilters.sort); params.set('dir', eventsFilters.dir) }
    return params
  }, [eventsFilters])

  const fetchEvents = useCallback(async () => {
    setEventsLoading(true)
    try {
      const params = buildEventsParams()
      params.set('page', String(eventsFilters.page))
      const res = await fetch(`/api/events?${params}`)
      if (!res.ok) throw new Error('Failed to fetch events')
      const json: PaginatedEvents = await res.json()
      setEventsData(json.data || [])
      setEventsPagination(json.pagination || { page: 1, page_size: 50, total: 0 })
    } catch {
      setEventsData([])
    } finally {
      setEventsLoading(false)
    }
  }, [buildEventsParams, eventsFilters.page])

  // Downloads every row matching the current filters as a CSV (opens in Excel)
  const exportCSV = useCallback(() => {
    const params = buildEventsParams()
    params.set('format', 'csv')
    const a = document.createElement('a')
    a.href = `/api/events?${params}`
    a.download = 'events-export.csv'
    document.body.appendChild(a)
    a.click()
    a.remove()
  }, [buildEventsParams])

  const checkAvailability = useCallback(async () => {
    if (!availQuery.date) return
    const from = availQuery.date
    // An end date before the start date is ignored (single-day check)
    const to = availQuery.end_date && availQuery.end_date > from ? availQuery.end_date : from
    setAvailLoading(true)
    setAvailRange(null)
    setAvailEvents([])
    setExpandedDates(new Set())
    try {
      // Fetch every event in the range; room/time filtering happens client-side
      // so the grid and per-date list can break results down by room.
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
      setAvailEvents(all)
      setAvailRange({ from, to })
    } catch {
      setAvailRange(null)
    } finally {
      setAvailLoading(false)
    }
  }, [availQuery])

  // Fetch events whenever filters change or user navigates to the Events section
  useEffect(() => {
    if (currentSection !== 'events') return
    const timer = setTimeout(() => { fetchEvents() }, 300)
    return () => clearTimeout(timer)
  }, [currentSection, fetchEvents])

  return (
    <div className={`min-h-screen transition-all duration-500 ${
      isDark ? 'bg-gray-900' : 'bg-gray-50'
    }`}>
      {/* Header */}
      <header className={`sticky top-0 z-50 backdrop-blur-lg border-b transition-all duration-300 ${
        isDark 
          ? 'bg-gray-800/90 border-red-800/30' 
          : 'bg-white/90 border-red-200/50'
      }`}>
        <nav className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between items-center h-16">
            {/* Logo */}
            <button
              onClick={() => showSection('home')}
              className="flex items-center gap-2 transition-all duration-300 hover:scale-105"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/Japan-Society-Logo-White Background.png" alt="Japan Society" className="w-8 h-8 rounded-full" />
              <span className={`text-xl font-bold ${isDark ? 'text-white' : 'text-gray-900'}`}>
                Japan Society
              </span>
            </button>

            {/* Desktop Navigation */}
            <div className="hidden md:flex items-center space-x-1">
              <NavLink onClick={() => showSection('home')} active={currentSection === 'home'} isDark={isDark}>
                {t('nav.home')}
              </NavLink>
              <NavLink onClick={() => showSection('form')} active={currentSection === 'form'} isDark={isDark}>
                {t('nav.form')}
              </NavLink>
              <NavLink onClick={() => showSection('events')} active={currentSection === 'events'} isDark={isDark}>
                {t('nav.events')}
              </NavLink>
              <NavLink onClick={() => showSection('excel')} active={currentSection === 'excel'} isDark={isDark}>
                {t('nav.excel')}
              </NavLink>
              <NavLink onClick={() => showSection('calendar')} active={currentSection === 'calendar'} isDark={isDark}>
                {t('nav.table')}
              </NavLink>
              <a
                href="https://apps.japansociety.org"
                className={`px-3 py-2 rounded-lg transition-all duration-200 ${
                  isDark 
                    ? 'text-gray-300 hover:text-white hover:bg-gray-700' 
                    : 'text-gray-600 hover:text-gray-900 hover:bg-gray-100'
                }`}
                target="_blank"
                rel="noopener noreferrer"
              >
                {t('nav.main')}
              </a>
            </div>

            {/* Controls */}
            <div className="flex items-center space-x-3">
              <button
                onClick={toggleLanguage}
                className={`px-4 py-2 rounded-full text-sm font-medium transition-all duration-300 hover:scale-105 ${
                  isDark
                    ? 'bg-red-900/50 text-red-200 hover:bg-red-800/50'
                    : 'bg-red-100 text-red-700 hover:bg-red-200'
                }`}
              >
                {language === 'en' ? '日本語' : 'English'}
              </button>
              <button
                onClick={toggleTheme}
                className={`p-2 rounded-full transition-all duration-300 hover:scale-110 ${
                  isDark
                    ? 'bg-red-900/50 text-red-200 hover:bg-red-800/50'
                    : 'bg-red-100 text-red-700 hover:bg-red-200'
                }`}
              >
                {isDark ? '🏮' : '🌙'}
              </button>
              
              {/* Mobile menu button */}
              <button
                onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
                className={`md:hidden p-2 rounded-full transition-all duration-300 ${
                  isDark 
                    ? 'bg-red-900/50 text-red-200 hover:bg-red-800/50' 
                    : 'bg-red-100 text-red-700 hover:bg-red-200'
                }`}
              >
                ☰
              </button>
            </div>
          </div>

          {/* Mobile Navigation */}
          {mobileMenuOpen && (
            <div className={`md:hidden absolute top-16 right-4 rounded-2xl shadow-2xl border p-4 min-w-[200px] z-50 ${
              isDark 
                ? 'bg-gray-800 border-red-800/30' 
                : 'bg-white border-red-200'
            }`}>
              <div className="flex flex-col space-y-2">
                <MobileNavLink onClick={() => showSection('home')} active={currentSection === 'home'} isDark={isDark}>
                  {t('nav.home')}
                </MobileNavLink>
                <MobileNavLink onClick={() => showSection('form')} active={currentSection === 'form'} isDark={isDark}>
                  {t('nav.form')}
                </MobileNavLink>
                <MobileNavLink onClick={() => showSection('events')} active={currentSection === 'events'} isDark={isDark}>
                  {t('nav.events')}
                </MobileNavLink>
                <MobileNavLink onClick={() => showSection('excel')} active={currentSection === 'excel'} isDark={isDark}>
                  {t('nav.excel')}
                </MobileNavLink>
                <MobileNavLink onClick={() => showSection('calendar')} active={currentSection === 'calendar'} isDark={isDark}>
                  {t('nav.table')}
                </MobileNavLink>
              </div>
            </div>
          )}
        </nav>
      </header>

      {/* Main Content */}
      <main className="mx-auto px-4 sm:px-6 lg:px-8 py-12" style={{ maxWidth: "100%" }}> 
        {/* Home Section */}
        {currentSection === 'home' && (
          <section className="animate-fadeIn">
            {/* Title - Japan Society House Calendar Portal */}
            <div className="text-center mb-16">
              <h1 className={`text-4xl md:text-5xl lg:text-6xl font-bold mb-6 transition-colors duration-300 ${
                isDark ? 'text-white' : 'text-gray-900'
              }`}>
                {t('home.title')}
              </h1>
              <p className={`text-lg md:text-xl max-w-3xl mx-auto leading-relaxed ${
                isDark ? 'text-gray-300' : 'text-gray-600'
              }`}>
                {t('home.desc')}
              </p>
            </div>

            {/* Clean Cards */}
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-5 gap-6">
              <CleanCard
                onClick={() => showSection('form')}
                title={t('home.card.form')}
                description={t('home.card.formDesc')}
                isDark={isDark}
                icon="📋"
              />
              <CleanCard
                onClick={() => showSection('events')}
                title={t('home.card.events')}
                description={t('home.card.eventsDesc')}
                isDark={isDark}
                icon="🔍"
              />
              <CleanCard
                onClick={() => showSection('excel')}
                title={t('home.card.excel')}
                description={t('home.card.excelDesc')}
                isDark={isDark}
                icon="📊"
              />
              <CleanCard
                onClick={() => showSection('calendar')}
                title={t('home.card.table')}
                description={t('home.card.tableDesc')}
                isDark={isDark}
                icon="📅"
              />
              <CleanCard
                onClick={() => window.open('https://japan-society.gogenuity.com/help_center', '_blank')}
                title={t('home.card.support')}
                description={t('home.card.supportDesc')}
                isDark={isDark}
                icon="💬"
              />
            </div>
          </section>
        )}

        {/* Form Section */}
        {currentSection === 'form' && (
          <section className="animate-fadeIn">
            <div className="text-center mb-8">
              <h2 className={`text-3xl md:text-4xl font-bold mb-4 ${
                isDark ? 'text-white' : 'text-gray-900'
              }`}>
                {t('form.title')}
              </h2>
              <p className={`text-lg max-w-2xl mx-auto mb-3 ${
                isDark ? 'text-gray-300' : 'text-gray-600'
              }`}>
                Fill out all required fields to submit your event information or registration.
              </p>
              <a
                href="https://form.jotform.com/252113809267053"
                target="_blank"
                rel="noopener noreferrer"
                className={`inline-text text-sm underline underline-offset-2 transition-colors ${
                  isDark ? 'text-red-400 hover:text-red-300' : 'text-red-600 hover:text-red-700'
                }`}
              >
                Open form in new tab ↗
              </a>
            </div>

            <div className={`rounded-3xl shadow-xl border overflow-hidden transition-all duration-300 hover:shadow-2xl ${
              isDark
                ? 'bg-gray-800 border-red-800/30'
                : 'bg-white border-red-200'
            }`}>
              <iframe
                src="https://form.jotform.com/252113809267053"
                className="w-full border-0 block"
                style={{ height: 'min(1100px, 85vh)' }}
                title="Japan Society Form"
                loading="lazy"
              />
            </div>
          </section>
        )}

        {/* Calendar/Table Section */}
        {currentSection === 'calendar' && (
          <section className="animate-fadeIn">
            <div className="text-center mb-8">
              <h2 className={`text-3xl md:text-4xl font-bold mb-4 ${
                isDark ? 'text-white' : 'text-gray-900'
              }`}>
                {t('calendar.title')}
              </h2>
              <p className={`text-lg max-w-2xl mx-auto mb-3 ${
                isDark ? 'text-gray-300' : 'text-gray-600'
              }`}>
                Browse all submitted event forms in JotForm&apos;s table view.
              </p>
              <a
                href="https://www.jotform.com/tables/252113809267053"
                target="_blank"
                rel="noopener noreferrer"
                className={`inline-text text-sm underline underline-offset-2 transition-colors ${
                  isDark ? 'text-red-400 hover:text-red-300' : 'text-red-600 hover:text-red-700'
                }`}
              >
                Open in JotForm ↗
              </a>
            </div>
            <div className={`rounded-2xl shadow-xl border p-2 transition-all duration-300 hover:shadow-2xl max-w-[95vw] mx-auto ${
              isDark ? 'bg-gray-800 border-red-800/30' : 'bg-white border-red-200'
            }`}>
              <div className="w-full h-[900px] md:h-[950px] lg:h-[1000px] rounded-xl overflow-hidden">
                <iframe
                  src="https://www.jotform.com/tables/252113809267053?embedMode=iframeembed"
                  className="w-full h-full border-0"
                  title="Japan Society Calendar Table"
                  loading="lazy"
                />
              </div>
            </div>
          </section>
        )}
        {/* Weekly Calendar Section */}
        {/* Excel Section */}
        {currentSection === 'excel' && (
          <section className="animate-fadeIn">
            <div className="text-center mb-8">
              <h2 className={`text-3xl md:text-4xl font-bold mb-4 ${
                isDark ? 'text-white' : 'text-gray-900'
              }`}>
                {t('excel.title')}
              </h2>
              <p className={`text-lg max-w-2xl mx-auto ${
                isDark ? 'text-gray-300' : 'text-gray-600'
              }`}>
                Live Weekly Calendar view with updates from our spreadsheet.
              </p>
            </div>
            
            {/* Large Excel Sheets container */}
                {/* <div>
                  className={`flex justify-center rounded-2xl shadow-xl border p-2 overflow-hidden transition-all duration-300 hover:shadow-2xl max-w-[95vw] mx-auto ${
                isDark ? 'bg-gray-800 border-red-800/30' : 'bg-white border-red-200'
                }`}
                </div> */}
              {/* Created by Max (Excel-Sharepoint Weekly Calendar) */}

              {/* Embedded Excel view */}
                <div
                  style={{
                    position: "relative",
                    width: "100%",
                    paddingBottom: "65%",
                    height: 0,
                  }}
                >
                  <iframe
                    src="https://japansoc.sharepoint.com/:x:/r/sites/JapanSociety/_layouts/15/Doc.aspx?sourcedoc=%7Be0169345-0224-4f18-b5f0-cc974fa4afa1%7D&action=embedview&wdAllowInteractivity=False&wdHideGridlines=True&wdHideHeaders=True&wdDownloadButton=True&wdInConfigurator=True&edaebf=rslc0"
                    title="Weekly Calendar"
                    loading="lazy"
                    allowFullScreen
                    style={{
                      position: "absolute",
                      top: 0,
                      left: 0,
                      width: "100%",
                      height: "100%",
                      border: "none",
                    }}
                  />
                </div>
          </section>
        )}
        {/* Events DB Section */}
        {currentSection === 'events' && (
          <section className="animate-fadeIn">
            <div className="text-center mb-8">
              <h2 className={`text-3xl md:text-4xl font-bold mb-4 ${isDark ? 'text-white' : 'text-gray-900'}`}>
                {t('events.title')}
              </h2>
              <p className={`text-lg max-w-2xl mx-auto ${isDark ? 'text-gray-300' : 'text-gray-600'}`}>
                {t('events.desc')}
              </p>
            </div>

            {/* Availability Search */}
            <div className={`rounded-2xl border p-6 mb-6 ${isDark ? 'bg-gray-800 border-red-800/30' : 'bg-white border-red-200'}`}>
              <h3 className={`text-lg font-semibold mb-4 ${isDark ? 'text-white' : 'text-gray-900'}`}>
                Check Availability
              </h3>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-3">
                <div>
                  <label className={`block text-xs font-medium mb-1 ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>From *</label>
                  <input
                    type="date"
                    value={availQuery.date}
                    onChange={e => setAvailQuery(q => ({ ...q, date: e.target.value }))}
                    className={`w-full rounded-lg border px-3 py-2 text-sm ${isDark ? 'bg-gray-700 border-gray-600 text-white' : 'bg-white border-gray-300 text-gray-900'}`}
                  />
                </div>
                <div>
                  <label className={`block text-xs font-medium mb-1 ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>To (optional)</label>
                  <input
                    type="date"
                    value={availQuery.end_date}
                    min={availQuery.date || undefined}
                    onChange={e => setAvailQuery(q => ({ ...q, end_date: e.target.value }))}
                    className={`w-full rounded-lg border px-3 py-2 text-sm ${isDark ? 'bg-gray-700 border-gray-600 text-white' : 'bg-white border-gray-300 text-gray-900'}`}
                  />
                </div>
                <div>
                  <label className={`block text-xs font-medium mb-1 ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>Start Time</label>
                  <input
                    type="time"
                    value={availQuery.start_time}
                    onChange={e => setAvailQuery(q => ({ ...q, start_time: e.target.value }))}
                    className={`w-full rounded-lg border px-3 py-2 text-sm ${isDark ? 'bg-gray-700 border-gray-600 text-white' : 'bg-white border-gray-300 text-gray-900'}`}
                  />
                </div>
                <div>
                  <label className={`block text-xs font-medium mb-1 ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>End Time</label>
                  <input
                    type="time"
                    value={availQuery.end_time}
                    onChange={e => setAvailQuery(q => ({ ...q, end_time: e.target.value }))}
                    className={`w-full rounded-lg border px-3 py-2 text-sm ${isDark ? 'bg-gray-700 border-gray-600 text-white' : 'bg-white border-gray-300 text-gray-900'}`}
                  />
                </div>
              </div>
              <div className="mb-4">
                <label className={`block text-xs font-medium mb-1.5 ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                  Locations <span className="font-normal opacity-70">(click to select — none selected = all)</span>
                </label>
                <RoomChips
                  selected={availQuery.locations}
                  onToggle={room => setAvailQuery(q => ({
                    ...q,
                    locations: q.locations.includes(room)
                      ? q.locations.filter(r => r !== room)
                      : [...q.locations, room],
                  }))}
                  isDark={isDark}
                />
              </div>
              <div className="flex gap-2">
                <button
                  onClick={checkAvailability}
                  disabled={!availQuery.date || availLoading}
                  className={`px-5 py-2 rounded-lg font-medium text-sm transition-all ${
                    availQuery.date && !availLoading
                      ? 'bg-red-600 text-white hover:bg-red-700'
                      : isDark ? 'bg-gray-700 text-gray-500 cursor-not-allowed' : 'bg-gray-200 text-gray-400 cursor-not-allowed'
                  }`}
                >
                  {availLoading ? 'Checking…' : 'Check Availability'}
                </button>
                {(availQuery.date || availQuery.end_date || availQuery.start_time || availQuery.end_time || availQuery.locations.length > 0 || availRange) && (
                  <button
                    onClick={() => { setAvailQuery({ date: '', end_date: '', start_time: '', end_time: '', locations: [] }); setAvailRange(null); setAvailEvents([]); setExpandedDates(new Set()) }}
                    className={`px-4 py-2 rounded-lg font-medium text-sm transition-all ${
                      isDark ? 'bg-gray-700 text-gray-300 hover:bg-gray-600' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                    }`}
                  >
                    Clear
                  </button>
                )}
              </div>

              {availRange && (() => {
                const start = availQuery.start_time, end = availQuery.end_time
                const hasWindow = !!(start && end)
                const windowLabel = hasWindow ? `${formatTime12(start)}–${formatTime12(end)}` : 'All Day'
                const isRangeMode = availRange.to > availRange.from
                const rooms = availQuery.locations.length ? availQuery.locations : ROOM_NAMES
                const legend = (
                  <p className={`text-[11px] mb-2 ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
                    <span className="text-green-600">✓ Free</span> · <span className="text-red-600">✗ Booked (Confirmed)</span> · <span className="text-amber-600">⚠ Tentative (Pending/Contingent/TBD)</span>
                  </p>
                )

                // Per-room status for one day's events
                const roomState = (dayEvents: CalendarEvent[], room: string) => {
                  const roomEvents = dayEvents.filter(e =>
                    roomsInLocation(e.location).has(room) &&
                    (!hasWindow || eventOccupies(e, start, end))
                  )
                  const confirmed = roomEvents.filter(e => isConfirmedStatus(e.status))
                  const tentative = roomEvents.filter(e => isTentativeStatus(e.status))
                  const state = confirmed.length ? 'booked' : tentative.length ? 'tentative' : 'free'
                  return { state, blocking: confirmed.length ? confirmed : tentative }
                }

                if (isRangeMode) {
                  // ── Range mode: one row per date, status per selected room ──
                  const dates = datesBetween(availRange.from, availRange.to)
                  const rows = dates.map(d => {
                    const dayEvents = availEvents.filter(e => e.event_date === d)
                    const roomStates = rooms.map(room => ({ room, ...roomState(dayEvents, room) }))
                    const worst = roomStates.some(r => r.state === 'booked') ? 'booked'
                      : roomStates.some(r => r.state === 'tentative') ? 'tentative' : 'free'
                    return { date: d, roomStates, worst }
                  })
                  const freeCount = rows.filter(r => r.worst === 'free').length
                  return (
                    <div className="mt-5">
                      <p className={`text-xs font-semibold uppercase tracking-wide mb-1 ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                        Availability · {formatDateLabel(availRange.from)} – {formatDateLabel(availRange.to)} · {windowLabel}
                        {availQuery.locations.length > 0 && ` · ${availQuery.locations.join(' + ')}`}
                      </p>
                      {legend}
                      <p className={`text-xs mb-2 font-medium ${isDark ? 'text-gray-300' : 'text-gray-600'}`}>
                        {freeCount} of {rows.length} days fully free
                      </p>
                      <div className={`max-h-[480px] overflow-y-auto rounded-xl border divide-y ${isDark ? 'border-gray-700 divide-gray-700' : 'border-gray-200 divide-gray-100'}`}>
                        {rows.map(row => {
                          const expandable = row.worst !== 'free'
                          const isExpanded = expandedDates.has(row.date)
                          return (
                          <div key={row.date} className={
                            row.worst === 'free'
                              ? isDark ? 'bg-green-900/20 text-green-300' : 'bg-green-50/60 text-green-900'
                              : row.worst === 'booked'
                                ? isDark ? 'bg-red-900/20 text-red-300' : 'bg-red-50/60 text-red-900'
                                : isDark ? 'bg-amber-900/20 text-amber-300' : 'bg-amber-50/60 text-amber-900'
                          }>
                            <div
                              onClick={expandable ? () => setExpandedDates(prev => {
                                const next = new Set(prev)
                                if (next.has(row.date)) next.delete(row.date)
                                else next.add(row.date)
                                return next
                              }) : undefined}
                              title={expandable ? (isExpanded ? 'Click to collapse' : 'Click to see all bookings') : undefined}
                              className={`flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-1.5 text-xs ${expandable ? 'cursor-pointer' : ''}`}
                            >
                              <span className="font-semibold w-24 shrink-0">{formatDateLabel(row.date)}</span>
                              {row.worst === 'free' ? (
                                <span>✓ {availQuery.locations.length ? 'Free' : 'All rooms free'}</span>
                              ) : (
                                (availQuery.locations.length
                                  ? row.roomStates
                                  : row.roomStates.filter(r => r.state !== 'free')
                                ).map(r => (
                                  <span key={r.room} className="inline-flex items-baseline gap-1">
                                    <span className="font-medium">
                                      {r.state === 'free' ? '✓' : r.state === 'booked' ? '✗' : '⚠'} {r.room}
                                    </span>
                                    {r.blocking.length > 0 && !isExpanded && (
                                      <span className="opacity-70 max-w-[260px] truncate">
                                        · {r.blocking[0].event_name} ({formatTimeRange(r.blocking[0].event_start, r.blocking[0].event_end)}){r.blocking.length > 1 ? ` +${r.blocking.length - 1}` : ''}
                                      </span>
                                    )}
                                  </span>
                                ))
                              )}
                              {expandable && <span className="ml-auto shrink-0 opacity-60">{isExpanded ? '▾' : '▸'}</span>}
                            </div>
                            {isExpanded && (
                              <div className="px-3 pb-2 pl-[6.75rem] space-y-1">
                                {row.roomStates.filter(r => r.blocking.length > 0).flatMap(r =>
                                  r.blocking.map(ev => (
                                    <div key={`${r.room}-${ev.id}`} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
                                      <span className="font-medium">{r.state === 'booked' ? '✗' : '⚠'} {r.room}</span>
                                      <span>{ev.event_name}</span>
                                      <span className="opacity-70">{formatTimeRange(ev.event_start, ev.event_end)}</span>
                                      <StatusBadge status={ev.status} />
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

                // ── Single-day mode: location grid + that day's events ──
                const dayEvents = availEvents.filter(e => e.event_date === availRange.from)
                const listEvents = dayEvents.filter(e => !isReleasedStatus(e.status))
                return (
                <div className="mt-5 space-y-4">
                  {/* Location availability grid */}
                  <div>
                    <p className={`text-xs font-semibold uppercase tracking-wide mb-1 ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                      Location Availability · {windowLabel}
                    </p>
                    {legend}
                    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-2">
                      {rooms.map(room => {
                        const { state, blocking } = roomState(dayEvents, room)
                        return (
                          <div key={room} className={`rounded-lg p-2 border text-xs ${
                            state === 'free'
                              ? isDark ? 'bg-green-900/30 border-green-700/50 text-green-300' : 'bg-green-50 border-green-200 text-green-800'
                              : state === 'booked'
                                ? isDark ? 'bg-red-900/30 border-red-700/50 text-red-300' : 'bg-red-50 border-red-200 text-red-800'
                                : isDark ? 'bg-amber-900/30 border-amber-700/50 text-amber-300' : 'bg-amber-50 border-amber-200 text-amber-800'
                          }`}>
                            <div className="font-semibold truncate">{room}</div>
                            <div className="mt-0.5 opacity-80">
                              {state === 'free'
                                ? '✓ Free'
                                : state === 'booked'
                                  ? `✗ Booked · ${blocking.length}`
                                  : `⚠ Tentative · ${blocking.length}`}
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  </div>

                  {/* Events scheduled that day (Released events are omitted) */}
                  <div>
                    <p className={`text-xs font-semibold uppercase tracking-wide mb-2 ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                      All Events That Day ({listEvents.length})
                    </p>
                    <div className={`rounded-xl border divide-y overflow-hidden ${isDark ? 'border-gray-700 divide-gray-700' : 'border-gray-200 divide-gray-100'}`}>
                      {listEvents.map(ev => (
                        <div key={ev.id} className={`flex flex-wrap gap-x-4 gap-y-1 px-3 py-2 text-xs ${isDark ? 'text-gray-300' : 'text-gray-700'} ${ev.status === 'Cancelled' ? 'opacity-40 line-through' : ''}`}>
                          <span className={`font-medium ${isDark ? 'text-white' : 'text-gray-900'}`}>{ev.event_name}</span>
                          {ev.location && <span className="opacity-70">{ev.location}</span>}
                          <span>{formatTimeRange(ev.event_start, ev.event_end)}</span>
                          <StatusBadge status={ev.status} />
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
                )
              })()}
            </div>

            {/* Filter Bar */}
            <div className={`rounded-2xl border p-4 mb-4 ${isDark ? 'bg-gray-800 border-red-800/30' : 'bg-white border-red-200'}`}>
              <div className="mb-3 flex gap-2">
                <input
                  type="text"
                  placeholder="Search by event, location, department, or contact…"
                  value={eventsFilters.search}
                  onChange={e => setEventsFilters(f => ({ ...f, search: e.target.value, page: 1 }))}
                  className={`flex-1 rounded-lg border px-3 py-2 text-sm ${isDark ? 'bg-gray-700 border-gray-600 text-white placeholder-gray-500' : 'bg-white border-gray-300 text-gray-900 placeholder-gray-400'}`}
                />
                {(eventsFilters.search || eventsFilters.date_from || eventsFilters.date_to || eventsFilters.status || eventsFilters.department || eventsFilters.locations.length > 0) && (
                  <button
                    onClick={() => setEventsFilters(f => ({ ...f, search: '', date_from: '', date_to: '', status: '', department: '', locations: [], page: 1 }))}
                    className={`px-4 py-2 rounded-lg text-sm font-medium ${isDark ? 'bg-gray-700 text-gray-300 hover:bg-gray-600' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}
                  >
                    Clear
                  </button>
                )}
                <button
                  onClick={exportCSV}
                  title="Download the current filtered results as a CSV file (opens in Excel)"
                  className={`px-4 py-2 rounded-lg text-sm font-medium border transition-all ${
                    isDark ? 'border-gray-600 text-gray-300 hover:bg-gray-700' : 'border-gray-300 text-gray-600 hover:bg-gray-100'
                  }`}
                >
                  ⬇ Export CSV
                </button>
              </div>
              <div className="mb-3">
                <label className={`block text-xs font-medium mb-1.5 ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                  Locations <span className="font-normal opacity-70">(click to select — none selected = all)</span>
                </label>
                <RoomChips
                  selected={eventsFilters.locations}
                  onToggle={room => setEventsFilters(f => ({
                    ...f,
                    locations: f.locations.includes(room)
                      ? f.locations.filter(r => r !== room)
                      : [...f.locations, room],
                    page: 1,
                  }))}
                  isDark={isDark}
                />
              </div>
              <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3 items-end">
                <div>
                  <label className={`block text-xs font-medium mb-1 ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>From</label>
                  <input type="date" value={eventsFilters.date_from}
                    onChange={e => setEventsFilters(f => ({ ...f, date_from: e.target.value, page: 1 }))}
                    className={`w-full rounded-lg border px-2 py-1.5 text-sm ${isDark ? 'bg-gray-700 border-gray-600 text-white' : 'bg-white border-gray-300 text-gray-900'}`}
                  />
                </div>
                <div>
                  <label className={`block text-xs font-medium mb-1 ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>To</label>
                  <input type="date" value={eventsFilters.date_to}
                    onChange={e => setEventsFilters(f => ({ ...f, date_to: e.target.value, page: 1 }))}
                    className={`w-full rounded-lg border px-2 py-1.5 text-sm ${isDark ? 'bg-gray-700 border-gray-600 text-white' : 'bg-white border-gray-300 text-gray-900'}`}
                  />
                </div>
                <div>
                  <label className={`block text-xs font-medium mb-1 ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>Status</label>
                  <select value={eventsFilters.status}
                    onChange={e => setEventsFilters(f => ({ ...f, status: e.target.value, page: 1 }))}
                    className={`w-full rounded-lg border px-2 py-1.5 text-sm ${isDark ? 'bg-gray-700 border-gray-600 text-white' : 'bg-white border-gray-300 text-gray-900'}`}
                  >
                    <option value="">All Statuses</option>
                    {['Released','Confirmed','Contingent','Pending','Cancelled','TBD','Other'].map(s => (
                      <option key={s} value={s}>{s}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className={`block text-xs font-medium mb-1 ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>Department</label>
                  <select value={eventsFilters.department}
                    onChange={e => setEventsFilters(f => ({ ...f, department: e.target.value, page: 1 }))}
                    className={`w-full rounded-lg border px-2 py-1.5 text-sm ${isDark ? 'bg-gray-700 border-gray-600 text-white' : 'bg-white border-gray-300 text-gray-900'}`}
                  >
                    <option value="">All Departments</option>
                    {['IT Development','PA','Building Services','Finance','House Operations','Human Resources','Media & Marketing','B&P','Education & Family','Film','Language Center','Administration','Holiday Rentals','Special Events','Office of the President','Gallery','C&C','Talks','Other'].map(d => (
                      <option key={d} value={d}>{d}</option>
                    ))}
                  </select>
                </div>
                <div className="flex flex-col gap-1 pt-1">
                  <div className="flex items-center gap-2">
                    <input type="checkbox" id="inclArchived" checked={eventsFilters.include_archived}
                      onChange={e => setEventsFilters(f => ({ ...f, include_archived: e.target.checked, page: 1 }))}
                      className="accent-red-600"
                    />
                    <label htmlFor="inclArchived" className={`text-sm ${isDark ? 'text-gray-300' : 'text-gray-600'}`}>
                      Show archived
                    </label>
                  </div>
                  <div className="flex items-center gap-2">
                    <input type="checkbox" id="inclReleased" checked={eventsFilters.include_released}
                      onChange={e => setEventsFilters(f => ({ ...f, include_released: e.target.checked, page: 1 }))}
                      className="accent-red-600"
                    />
                    <label htmlFor="inclReleased" className={`text-sm ${isDark ? 'text-gray-300' : 'text-gray-600'}`}>
                      Show released
                    </label>
                  </div>
                </div>
              </div>
            </div>

            {/* Events Table */}
            <div className={`rounded-2xl border overflow-hidden ${isDark ? 'bg-gray-800 border-red-800/30' : 'bg-white border-red-200'}`}>
              {eventsLoading ? (
                <div className="p-12 text-center">
                  <div className={`inline-block w-8 h-8 border-4 border-t-red-600 rounded-full animate-spin ${isDark ? 'border-gray-600' : 'border-gray-200'}`} />
                  <p className={`mt-3 text-sm ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>Loading events…</p>
                </div>
              ) : eventsData.length === 0 ? (
                <div className={`p-12 text-center text-sm ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                  No events found. Adjust filters or check back after syncing data.
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm min-w-[900px]">
                    <thead>
                      <tr className={isDark ? 'bg-gray-700/60' : 'bg-gray-50'}>
                        {([
                          { label: 'Date',       key: 'event_date' },
                          { label: 'Day',        key: '' },
                          { label: 'Event Name', key: 'event_name' },
                          { label: 'Location',   key: 'location' },
                          { label: 'Dept',       key: 'department' },
                          { label: 'Start',      key: 'event_start' },
                          { label: 'End',        key: 'event_end' },
                          { label: 'Hold',       key: '' },
                          { label: 'Contact',    key: 'contact_name' },
                          { label: 'Status',     key: 'status' },
                        ] as { label: string; key: string }[]).map(col => (
                          <th
                            key={col.label}
                            onClick={col.key ? () => setEventsFilters(f => ({
                              ...f,
                              sort: col.key,
                              dir: f.sort === col.key && f.dir === 'asc' ? 'desc' : 'asc',
                              page: 1,
                            })) : undefined}
                            title={col.key ? 'Click to sort' : undefined}
                            className={`px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide whitespace-nowrap select-none ${
                              isDark ? 'text-gray-300' : 'text-gray-500'
                            } ${col.key ? 'cursor-pointer hover:text-red-500' : ''} ${
                              eventsFilters.sort === col.key && col.key ? 'text-red-600 dark:text-red-400' : ''
                            }`}
                          >
                            {col.label}
                            {eventsFilters.sort === col.key && col.key ? (eventsFilters.dir === 'asc' ? ' ▲' : ' ▼') : ''}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {eventsData.map((ev, i) => (
                        <tr key={ev.id}
                          className={`border-t transition-colors ${
                            isDark
                              ? `border-gray-700 ${i % 2 === 0 ? '' : 'bg-gray-700/20'} hover:bg-gray-700/40`
                              : `border-gray-100 ${i % 2 === 0 ? '' : 'bg-gray-50/50'} hover:bg-red-50/30`
                          } ${ev.status === 'Cancelled' ? 'opacity-50' : ''}`}
                        >
                          <td className={`px-4 py-3 whitespace-nowrap font-medium ${isDark ? 'text-gray-200' : 'text-gray-900'}`}>
                            {ev.event_date}
                          </td>
                          <td className={`px-4 py-3 whitespace-nowrap ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                            {ev.day_of_week || '—'}
                          </td>
                          <td className={`px-4 py-3 max-w-[200px] truncate font-medium ${isDark ? 'text-white' : 'text-gray-900'} ${ev.status === 'Cancelled' ? 'line-through' : ''}`}
                            title={ev.event_name}>
                            {ev.event_name}
                          </td>
                          <td className={`px-4 py-3 whitespace-nowrap ${isDark ? 'text-gray-300' : 'text-gray-700'}`}>
                            {ev.location || '—'}
                          </td>
                          <td className={`px-4 py-3 whitespace-nowrap text-xs ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                            {ev.department || '—'}
                          </td>
                          <td className={`px-4 py-3 whitespace-nowrap ${isDark ? 'text-gray-300' : 'text-gray-700'}`}>
                            {formatTime12(ev.event_start) || '—'}
                          </td>
                          <td className={`px-4 py-3 whitespace-nowrap ${isDark ? 'text-gray-300' : 'text-gray-700'}`}>
                            {formatTime12(ev.event_end) || '—'}
                          </td>
                          <td className={`px-4 py-3 whitespace-nowrap text-xs ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                            {ev.hold_start ? `${formatTime12(ev.hold_start)}–${formatTime12(ev.hold_end)}` : '—'}
                          </td>
                          <td className={`px-4 py-3 whitespace-nowrap text-xs ${isDark ? 'text-gray-300' : 'text-gray-700'}`}>
                            {ev.contact_name}
                          </td>
                          <td className="px-4 py-3 whitespace-nowrap">
                            <StatusBadge status={ev.status} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {/* Pagination */}
              {eventsPagination.total > eventsPagination.page_size && (
                <div className={`flex items-center justify-between px-4 py-3 border-t text-sm ${isDark ? 'border-gray-700 text-gray-300' : 'border-gray-100 text-gray-600'}`}>
                  <span>{eventsPagination.total} total</span>
                  <div className="flex gap-2">
                    <button
                      onClick={() => setEventsFilters(f => ({ ...f, page: f.page - 1 }))}
                      disabled={eventsFilters.page <= 1}
                      className={`px-3 py-1 rounded-lg text-xs ${eventsFilters.page <= 1 ? 'opacity-40 cursor-not-allowed' : isDark ? 'hover:bg-gray-700' : 'hover:bg-gray-100'}`}
                    >← Prev</button>
                    <span className="px-2 py-1">Page {eventsFilters.page} of {Math.ceil(eventsPagination.total / eventsPagination.page_size)}</span>
                    <button
                      onClick={() => setEventsFilters(f => ({ ...f, page: f.page + 1 }))}
                      disabled={eventsFilters.page >= Math.ceil(eventsPagination.total / eventsPagination.page_size)}
                      className={`px-3 py-1 rounded-lg text-xs ${eventsFilters.page >= Math.ceil(eventsPagination.total / eventsPagination.page_size) ? 'opacity-40 cursor-not-allowed' : isDark ? 'hover:bg-gray-700' : 'hover:bg-gray-100'}`}
                    >Next →</button>
                  </div>
                </div>
              )}
            </div>
          </section>
        )}
      </main>
    </div>
  )
}

{/* Components */}
interface NavLinkProps {
  onClick: () => void
  children: React.ReactNode
  active: boolean
  isDark: boolean
}

function NavLink({ onClick, children, active, isDark }: NavLinkProps) {
  return (
    <button
      onClick={onClick}
      className={`px-4 py-2 rounded-lg font-medium transition-all duration-300 hover:scale-105 ${
        active 
          ? isDark
            ? 'bg-red-800 text-red-100 shadow-lg' 
            : 'bg-red-600 text-white shadow-lg'
          : isDark
            ? 'text-gray-300 hover:text-white hover:bg-gray-700' 
            : 'text-gray-600 hover:text-gray-900 hover:bg-gray-100'
      }`}
    >
      {children}
    </button>
  )
}

function MobileNavLink({ onClick, children, active, isDark }: NavLinkProps) {
  return (
    <button
      onClick={onClick}
      className={`px-4 py-3 rounded-xl font-medium transition-all duration-300 text-left w-full ${
        active 
          ? isDark
            ? 'bg-red-800 text-red-100' 
            : 'bg-red-600 text-white'
          : isDark
            ? 'text-gray-300 hover:text-white hover:bg-gray-700' 
            : 'text-gray-600 hover:text-gray-900 hover:bg-gray-100'
      }`}
    >
      {children}
    </button>
  )
}

// Multi-select room picker: one toggleable chip per canonical room.
// No selection means "all rooms".
function RoomChips({ selected, onToggle, isDark }: {
  selected: string[]
  onToggle: (room: string) => void
  isDark: boolean
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {ROOM_NAMES.map(room => {
        const active = selected.includes(room)
        return (
          <button
            key={room}
            type="button"
            onClick={() => onToggle(room)}
            className={`px-2.5 py-1 rounded-full text-xs font-medium border transition-all ${
              active
                ? 'bg-red-600 border-red-600 text-white'
                : isDark
                  ? 'bg-gray-700 border-gray-600 text-gray-300 hover:border-red-500'
                  : 'bg-white border-gray-300 text-gray-600 hover:border-red-400'
            }`}
          >
            {room}
          </button>
        )
      })}
    </div>
  )
}

function StatusBadge({ status }: { status: string }) {
  const colours: Record<string, string> = {
    Confirmed:  'bg-green-100  text-green-800  dark:bg-green-900/40  dark:text-green-300',
    Released:   'bg-blue-100   text-blue-800   dark:bg-blue-900/40   dark:text-blue-300',
    Contingent: 'bg-orange-100 text-orange-800 dark:bg-orange-900/40 dark:text-orange-300',
    Pending:    'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/40 dark:text-yellow-300',
    Cancelled:  'bg-gray-100   text-gray-500   dark:bg-gray-700      dark:text-gray-400',
    TBD:        'bg-purple-100 text-purple-800 dark:bg-purple-900/40 dark:text-purple-300',
    Other:      'bg-gray-100   text-gray-700   dark:bg-gray-700      dark:text-gray-300',
  }
  return (
    <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${colours[status] || colours.Other}`}>
      {status}
    </span>
  )
}

interface CleanCardProps {
  onClick?: () => void
  title: string
  description: string
  isDark: boolean
  icon: string
}

function CleanCard({ onClick, title, description, isDark, icon }: CleanCardProps) {
  return (
    <div
      onClick={onClick}
      className={`group cursor-pointer rounded-2xl p-6 shadow-lg border transition-all duration-300 hover:shadow-xl hover:-translate-y-2 ${
        isDark 
          ? 'bg-gray-800 border-gray-700 hover:border-red-600/50' 
          : 'bg-white border-gray-200 hover:border-red-400/50'
      }`}
    >
      <div className="flex items-center space-x-3 mb-4">
        <span className="text-2xl">{icon}</span>
        <div className={`flex-1 h-0.5 ${
          isDark ? 'bg-red-400/30' : 'bg-red-300/50'
        }`}></div>
      </div>
      <h3 className={`text-xl font-semibold mb-3 transition-colors duration-300 ${
        isDark 
          ? 'text-white group-hover:text-red-300' 
          : 'text-gray-900 group-hover:text-red-700'
      }`}>
        {title}
      </h3>
      <p className={`leading-relaxed text-sm ${
        isDark ? 'text-gray-300' : 'text-gray-600'
      }`}>
        {description}
      </p>
    </div>
  )
}
