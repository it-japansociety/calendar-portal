'use client'

// Shared shell for the Workflow v2 pages (/submit, /my, /function-form, /admin).
// Mirrors the main portal's look (red accent, dark mode via localStorage) with
// a slim header instead of the full nav — every page links back to the portal.
import { useEffect, useState, type ReactNode } from 'react'
import Link from 'next/link'

// Theme follows the system (prefers-color-scheme) and tracks live changes —
// no manual toggle. Drives the .dark CSS scope (glass surfaces, calendar).
export function useTheme(): [boolean, () => void] {
  const [isDark, setIsDark] = useState(false)
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = (dark: boolean) => {
      setIsDark(dark)
      document.documentElement.classList.toggle('dark', dark)
    }
    apply(mq.matches)
    const onChange = (e: MediaQueryListEvent) => apply(e.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])
  return [isDark, () => { /* system-synced; kept for API compatibility */ }]
}

export default function Shell({
  title, isDark, badge, children,
}: {
  title: string
  isDark: boolean
  onToggleTheme?: () => void   // legacy prop, theme is system-synced now
  badge?: ReactNode
  children: ReactNode
}) {
  return (
    <div className="min-h-screen transition-colors duration-300 v2-bg">
      <header className={`sticky top-0 z-50 backdrop-blur-xl border-b ${
        isDark ? 'bg-gray-900/60 border-red-800/30' : 'bg-white/60 border-red-200/60'
      }`}>
        <div className="max-w-5xl mx-auto px-4 sm:px-6 h-14 flex items-center justify-between">
          <div className="flex items-center gap-3 min-w-0">
            <Link href="/" className="flex items-center gap-2 shrink-0" title="Back to portal">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/Japan-Society-Logo-White Background.png" alt="Japan Society" className="w-7 h-7 rounded-full" />
              <span className={`hidden sm:inline text-sm font-bold ${isDark ? 'text-white' : 'text-gray-900'}`}>
                Japan Society
              </span>
            </Link>
            <span className={isDark ? 'text-gray-600' : 'text-gray-300'}>/</span>
            <h1 className={`text-base font-semibold truncate ${isDark ? 'text-white' : 'text-gray-900'}`}>{title}</h1>
            {badge}
          </div>
          <div className="flex items-center gap-2">
            <Link href="/my" className={`text-sm px-3 py-1.5 rounded-full ${
              isDark ? 'text-gray-300 hover:bg-gray-700' : 'text-gray-600 hover:bg-gray-100'
            }`}>My Bookings</Link>
          </div>
        </div>
      </header>
      <main className="max-w-5xl mx-auto px-4 sm:px-6 py-8">{children}</main>
    </div>
  )
}

// Dry-run banner shown on every Workflow v2 page while live_mode is off.
export function DryRunBanner({ isDark }: { isDark: boolean }) {
  return (
    <div className={`rounded-xl border px-4 py-2.5 mb-6 text-sm flex items-center gap-2 ${
      isDark ? 'bg-amber-900/30 border-amber-700/50 text-amber-200' : 'bg-amber-50 border-amber-300 text-amber-800'
    }`}>
      <span aria-hidden>🧪</span>
      <span><b>Dev preview.</b> Nothing is sent to JotForm and no emails go out — actions show what <i>would</i> happen.</span>
    </div>
  )
}
