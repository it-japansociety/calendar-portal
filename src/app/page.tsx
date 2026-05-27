'use client'

import { useState, useEffect, useCallback } from 'react'
import { translations } from '../utils/translations'
import type { CalendarEvent, AvailabilityConflict, AvailabilityResult, PaginatedEvents } from '../lib/types'

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
    date_from: '', date_to: '', status: '', department: '', location: '',
    include_archived: false, page: 1,
  })
  const [availQuery, setAvailQuery] = useState({ date: '', start_time: '', end_time: '', location: '' })
  const [availResult, setAvailResult] = useState<AvailabilityResult | null>(null)
  const [availLoading, setAvailLoading] = useState(false)

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

  const fetchEvents = useCallback(async () => {
    setEventsLoading(true)
    try {
      const params = new URLSearchParams()
      if (eventsFilters.date_from) params.set('date_from', eventsFilters.date_from)
      if (eventsFilters.date_to)   params.set('date_to',   eventsFilters.date_to)
      if (eventsFilters.status)    params.set('status',    eventsFilters.status)
      if (eventsFilters.department) params.set('department', eventsFilters.department)
      if (eventsFilters.location)  params.set('location',  eventsFilters.location)
      if (eventsFilters.include_archived) params.set('include_archived', 'true')
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
  }, [eventsFilters])

  const checkAvailability = useCallback(async () => {
    if (!availQuery.date) return
    setAvailLoading(true)
    setAvailResult(null)
    try {
      const params = new URLSearchParams({ date: availQuery.date })
      if (availQuery.start_time) params.set('start_time', availQuery.start_time)
      if (availQuery.end_time)   params.set('end_time',   availQuery.end_time)
      if (availQuery.location)   params.set('location',   availQuery.location)
      const res = await fetch(`/api/events/availability?${params}`)
      if (!res.ok) throw new Error('Failed to check availability')
      const json: AvailabilityResult = await res.json()
      setAvailResult(json)
    } catch {
      setAvailResult(null)
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
            {/* Logo - Just "Japan Society" */}
            <button 
              onClick={() => showSection('home')}
              className={`text-xl font-bold transition-all duration-300 hover:scale-105 ${
                isDark ? 'text-white' : 'text-gray-900'
              }`}
            >
              Japan Society
            </button>

            {/* Desktop Navigation */}
            <div className="hidden md:flex items-center space-x-1">
              <NavLink onClick={() => showSection('home')} active={currentSection === 'home'} isDark={isDark}>
                {t('nav.home')}
              </NavLink>
              <NavLink onClick={() => showSection('form')} active={currentSection === 'form'} isDark={isDark}>
                {t('nav.form')}
              </NavLink>
              <NavLink onClick={() => showSection('calendar')} active={currentSection === 'calendar'} isDark={isDark}>
                {t('nav.table')}
              </NavLink>
              <NavLink onClick={() => showSection('excel')} active={currentSection === 'excel'} isDark={isDark}>
                {t('nav.excel')}
              </NavLink>
              <NavLink onClick={() => showSection('events')} active={currentSection === 'events'} isDark={isDark}>
                {t('nav.events')}
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
                onClick={toggleTheme}
                className={`p-2 rounded-full transition-all duration-300 hover:scale-110 ${
                  isDark 
                    ? 'bg-red-900/50 text-red-200 hover:bg-red-800/50' 
                    : 'bg-red-100 text-red-700 hover:bg-red-200'
                }`}
              >
                {isDark ? '🏮' : '🌙'}
              </button>
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
                <MobileNavLink onClick={() => showSection('calendar')} active={currentSection === 'calendar'} isDark={isDark}>
                  {t('nav.table')}
                </MobileNavLink>
                <MobileNavLink onClick={() => showSection('excel')} active={currentSection === 'excel'} isDark={isDark}>
                  {t('nav.excel')}
                </MobileNavLink>
                <MobileNavLink onClick={() => showSection('events')} active={currentSection === 'events'} isDark={isDark}>
                  {t('nav.events')}
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
                onClick={() => showSection('calendar')}
                title={t('home.card.table')}
                description={t('home.card.tableDesc')}
                isDark={isDark}
                icon="📅"
              />
              <CleanCard
                onClick={() => showSection('excel')}
                title={t('home.card.excel')}
                description={t('home.card.excelDesc')}
                isDark={isDark}
                icon="📊"
              />
              <CleanCard
                onClick={() => showSection('events')}
                title={t('home.card.events')}
                description={t('home.card.eventsDesc')}
                isDark={isDark}
                icon="🗄️"
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
              <p className={`text-lg max-w-2xl mx-auto ${
                isDark ? 'text-gray-300' : 'text-gray-600'
              }`}>
                Browse through submitted forms and scheduled events in this interactive table.
              </p>
            </div>
            
            {/* Larger container that uses more screen width */}
            <div className={`rounded-2xl shadow-xl border p-2 transition-all duration-300 hover:shadow-2xl max-w-[95vw] mx-auto ${
              isDark 
                ? 'bg-gray-800 border-red-800/30' 
                : 'bg-white border-red-200'
            }`}>
              <div className="w-full h-[900px] md:h-[950px] lg:h-[1000px] rounded-xl overflow-hidden">
                <iframe
                  src="https://www.jotform.com/tables/252113809267053"
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
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
                <div>
                  <label className={`block text-xs font-medium mb-1 ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>Date *</label>
                  <input
                    type="date"
                    value={availQuery.date}
                    onChange={e => setAvailQuery(q => ({ ...q, date: e.target.value }))}
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
                <div>
                  <label className={`block text-xs font-medium mb-1 ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>Location</label>
                  <select
                    value={availQuery.location}
                    onChange={e => setAvailQuery(q => ({ ...q, location: e.target.value }))}
                    className={`w-full rounded-lg border px-3 py-2 text-sm ${isDark ? 'bg-gray-700 border-gray-600 text-white' : 'bg-white border-gray-300 text-gray-900'}`}
                  >
                    <option value="">All Locations</option>
                    {['4th Fl Conference Room','3rd Fl Conference Room','AUD','MURSON','YSKY','FOY','GAL','Online','Offsite','A-Level','LC Pond','ATRO','Other'].map(loc => (
                      <option key={loc} value={loc}>{loc}</option>
                    ))}
                  </select>
                </div>
              </div>
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

              {availResult && (
                <div className={`mt-4 rounded-xl p-4 border ${
                  availResult.is_available
                    ? isDark ? 'bg-green-900/30 border-green-700 text-green-300' : 'bg-green-50 border-green-300 text-green-800'
                    : isDark ? 'bg-red-900/30 border-red-700 text-red-300'   : 'bg-red-50 border-red-300 text-red-800'
                }`}>
                  <p className="font-semibold text-sm mb-2">
                    {availResult.is_available ? '✓ Available' : `✗ ${availResult.conflicts.length} conflict${availResult.conflicts.length !== 1 ? 's' : ''} found`}
                  </p>
                  {availResult.conflicts.length > 0 && (
                    <div className="space-y-1">
                      {availResult.conflicts.map((c: AvailabilityConflict) => (
                        <div key={c.id} className="text-xs flex gap-3 flex-wrap">
                          <span className="font-medium">{c.event_name}</span>
                          <span>{c.event_start} – {c.event_end}</span>
                          {c.location && <span className="opacity-75">{c.location}</span>}
                          <StatusBadge status={c.status} />
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Filter Bar */}
            <div className={`rounded-2xl border p-4 mb-4 ${isDark ? 'bg-gray-800 border-red-800/30' : 'bg-white border-red-200'}`}>
              <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3 items-end">
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
                <div>
                  <label className={`block text-xs font-medium mb-1 ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>Location</label>
                  <select value={eventsFilters.location}
                    onChange={e => setEventsFilters(f => ({ ...f, location: e.target.value, page: 1 }))}
                    className={`w-full rounded-lg border px-2 py-1.5 text-sm ${isDark ? 'bg-gray-700 border-gray-600 text-white' : 'bg-white border-gray-300 text-gray-900'}`}
                  >
                    <option value="">All Locations</option>
                    {['4th Fl Conference Room','3rd Fl Conference Room','AUD','MURSON','YSKY','FOY','GAL','Online','Offsite','A-Level','LC Pond','ATRO','Other'].map(l => (
                      <option key={l} value={l}>{l}</option>
                    ))}
                  </select>
                </div>
                <div className="flex items-center gap-2 pt-4">
                  <input type="checkbox" id="inclArchived" checked={eventsFilters.include_archived}
                    onChange={e => setEventsFilters(f => ({ ...f, include_archived: e.target.checked, page: 1 }))}
                    className="accent-red-600"
                  />
                  <label htmlFor="inclArchived" className={`text-sm ${isDark ? 'text-gray-300' : 'text-gray-600'}`}>
                    Show archived
                  </label>
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
                        {['Date','Day','Event Name','Location','Dept','Start','End','Hold','Contact','Status'].map(h => (
                          <th key={h} className={`px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide whitespace-nowrap ${isDark ? 'text-gray-300' : 'text-gray-500'}`}>{h}</th>
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
                            {ev.event_start}
                          </td>
                          <td className={`px-4 py-3 whitespace-nowrap ${isDark ? 'text-gray-300' : 'text-gray-700'}`}>
                            {ev.event_end}
                          </td>
                          <td className={`px-4 py-3 whitespace-nowrap text-xs ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                            {ev.hold_start ? `${ev.hold_start}–${ev.hold_end}` : '—'}
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
