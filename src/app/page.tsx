'use client'

import { useState, useEffect } from 'react'
import { translations } from '../utils/translations'

export default function Home() {
  const [currentSection, setCurrentSection] = useState('home')
  const [isDark, setIsDark] = useState(false)
  const [language, setLanguage] = useState('en')
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)

  useEffect(() => {
    if (typeof window !== 'undefined') {
      const savedTheme = localStorage.getItem('theme')
      const savedLang = localStorage.getItem('language')
      
      if (savedTheme === 'dark') {
        setIsDark(true)
        document.documentElement.classList.add('dark')
      }
      
      if (savedLang) setLanguage(savedLang)
    }
  }, [])

  const toggleTheme = () => {
    const newIsDark = !isDark
    setIsDark(newIsDark)
    
    if (typeof window !== 'undefined') {
      if (newIsDark) {
        document.documentElement.classList.add('dark')
        localStorage.setItem('theme', 'dark')
      } else {
        document.documentElement.classList.remove('dark')
        localStorage.setItem('theme', 'light')
      }
    }
  }

  const toggleLanguage = () => {
    const newLang = language === 'en' ? 'ja' : 'en'
    setLanguage(newLang)
    if (typeof window !== 'undefined') {
      localStorage.setItem('language', newLang)
    }
  }

  const t = (key: string) => translations[language]?.[key] || key

  const showSection = (section: string) => {
    setCurrentSection(section)
    setMobileMenuOpen(false)
  }

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
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-8">
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
            <div className="text-center mb-12">
              <h2 className={`text-3xl md:text-4xl font-bold mb-4 ${
                isDark ? 'text-white' : 'text-gray-900'
              }`}>
                {t('form.title')}
              </h2>
              <p className={`text-lg max-w-2xl mx-auto ${
                isDark ? 'text-gray-300' : 'text-gray-600'
              }`}>
                Complete the form below to submit your information or register for events.
              </p>
            </div>
            
            <div className={`rounded-3xl shadow-xl border p-8 transition-all duration-300 hover:shadow-2xl ${
              isDark 
                ? 'bg-gray-800 border-red-800/30' 
                : 'bg-white border-red-200'
            }`}>
              <div className="w-full h-[600px] rounded-2xl overflow-hidden">
                <iframe
                  src="https://form.jotform.com/252113809267053"
                  className="w-full h-full border-0"
                  title="Japan Society Form"
                />
              </div>
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
              <div
                className={`flex justify-center rounded-2xl shadow-xl border p-2 overflow-hidden transition-all duration-300 hover:shadow-2xl max-w-[95vw] mx-auto ${
                  isDark ? 'bg-gray-800 border-red-800/30' : 'bg-white border-red-200'
                }`}
              >
               <iframe width="100%" height="1025" frameborder="0" scrolling="no" src="https://japansoc.sharepoint.com/sites/JapanSociety/_layouts/15/Doc.aspx?sourcedoc={499f0501-9b73-4f1e-9121-d0d3f45d237c}&action=embedview&wdAllowInteractivity=False&wdHideGridlines=True&wdInConfigurator=True&wdInConfigurator=True"></iframe> 
              </div>

          </section>
        )}
      </main>
    </div>
  )
}

// Components
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
