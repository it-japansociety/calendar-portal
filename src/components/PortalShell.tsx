'use client'

// The portal chrome from the "Design Calendar" concept: logo left, a floating
// centre nav pill with the five destinations, Main Site + user avatar right.
// Every page (portal sections and standalone routes alike) renders inside it.
import { useEffect, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { cachedFetch } from '../lib/client-cache'

export type PortalSection = 'home' | 'book' | 'my' | 'availability' | 'calendar' | 'forms' | 'contact'

// Theme follows the OS; no manual toggle to maintain.
export function useSystemTheme(): boolean {
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
  return isDark
}

const NAV: { key: PortalSection; label: string; href: string }[] = [
  { key: 'home', label: 'Home', href: '/' },
  { key: 'book', label: 'Book a Space', href: '/submit' },
  { key: 'my', label: 'My Bookings', href: '/my' },
  { key: 'availability', label: 'Availability', href: '/availability' },
  { key: 'calendar', label: 'Calendar', href: '/calendar' },
]

export function useWhoami(): { email: string; name: string } | null {
  const [me, setMe] = useState<{ email: string; name: string } | null>(null)
  useEffect(() => {
    cachedFetch<{ email: string; name: string }>('whoami', '/api/whoami', setMe)
      .then(v => { if (v) setMe(v) })
      .catch(() => { /* greeting falls back */ })
  }, [])
  return me
}

// Destinations that don't earn a slot in the centre pill but still need a way
// in — they live in the menu alongside the primary nav on small screens.
const SECONDARY: { key: PortalSection | 'admin' | 'views'; label: string; href: string }[] = [
  { key: 'forms', label: 'Submit a Form', href: '/forms' },
  { key: 'views', label: 'Other Views', href: '/views' },
  { key: 'contact', label: 'Contact', href: '/contact' },
]

export function PortalNav({ active }: { active: PortalSection }) {
  const [open, setOpen] = useState(false)

  // Close on Escape or a click anywhere outside the menu.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    const onClick = (e: MouseEvent) => {
      if (!(e.target as HTMLElement)?.closest('[data-portal-menu]')) setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('click', onClick)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('click', onClick)
    }
  }, [open])

  return (
    <header className="sticky top-0 z-50">
      <div className="max-w-7xl mx-auto px-4 sm:px-6">
        <div className="flex items-center justify-between gap-3 h-16">
          <Link href="/" className="flex items-center gap-2.5 shrink-0" aria-label="Japan Society home">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/Japan-Society-Logo-White Background.png" alt="" className="w-7 h-7 rounded-full" />
            <span className="font-bold text-[0.95rem] hidden sm:inline" style={{ color: 'var(--jsp-ink)' }}>
              Japan Society
            </span>
          </Link>

          {/* Centre pill — the concept's signature nav */}
          <nav className="jsp-navpill hidden lg:flex" aria-label="Portal sections">
            {NAV.map(item => (
              <Link key={item.key} href={item.href} className="jsp-navlink" data-active={active === item.key}>
                {item.label}
              </Link>
            ))}
          </nav>

          {/* Hamburger — holds Main Site and the secondary destinations at every
              width, plus the primary nav below lg where the pill is hidden. */}
          <div className="relative shrink-0" data-portal-menu>
            <button
              type="button"
              onClick={() => setOpen(o => !o)}
              aria-expanded={open}
              aria-haspopup="menu"
              aria-label={open ? 'Close menu' : 'Open menu'}
              className="w-11 h-11 rounded-full grid place-items-center transition-colors"
              style={{ border: '1px solid var(--jsp-line)', background: 'var(--jsp-card)' }}
            >
              <svg width="18" height="14" viewBox="0 0 18 14" aria-hidden="true"
                fill="none" stroke="var(--jsp-ink)" strokeWidth="1.75" strokeLinecap="round">
                <path d="M1 1h16M1 7h16M1 13h16" />
              </svg>
            </button>

            {open && (
              <div
                role="menu"
                className="jsp-card absolute right-0 top-full mt-2 p-2 flex flex-col min-w-[13rem] z-50"
              >
                {/* Primary nav only where the centre pill isn't showing */}
                <div className="lg:hidden flex flex-col">
                  {NAV.map(item => (
                    <Link
                      key={item.key}
                      href={item.href}
                      role="menuitem"
                      onClick={() => setOpen(false)}
                      className="jsp-navlink text-left"
                      data-active={active === item.key}
                    >
                      {item.label}
                    </Link>
                  ))}
                  <div className="my-1.5 h-px" style={{ background: 'var(--jsp-line)' }} />
                </div>

                {SECONDARY.map(item => (
                  <Link
                    key={item.key}
                    href={item.href}
                    role="menuitem"
                    onClick={() => setOpen(false)}
                    className="jsp-navlink text-left"
                    data-active={active === item.key}
                  >
                    {item.label}
                  </Link>
                ))}
                <div className="my-1.5 h-px" style={{ background: 'var(--jsp-line)' }} />
                <a
                  href="https://apps.japansociety.org"
                  target="_blank"
                  rel="noopener noreferrer"
                  role="menuitem"
                  onClick={() => setOpen(false)}
                  className="jsp-navlink text-left"
                >
                  Main Site ↗
                </a>
              </div>
            )}
          </div>
        </div>
      </div>
    </header>
  )
}

// Page hero: kicker, serif title, optional standfirst and right-hand actions.
export function PortalHero({
  kicker, title, lede, actions,
}: {
  kicker: string
  title: ReactNode
  lede?: string
  actions?: ReactNode
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4 mb-8">
      <div className="min-w-0">
        <p className="jsp-kicker mb-2">{kicker}</p>
        <h1 className="jsp-display text-3xl sm:text-4xl">{title}</h1>
        {lede && <p className="mt-2 text-sm sm:text-base" style={{ color: 'var(--jsp-muted)' }}>{lede}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-3">{actions}</div>}
    </div>
  )
}

export default function PortalShell({
  active, children, wide,
}: {
  active: PortalSection
  children: ReactNode
  wide?: boolean
}) {
  useSystemTheme()
  return (
    <div className="jsp-bg">
      <PortalNav active={active} />
      <main className={`${wide ? 'max-w-7xl' : 'max-w-5xl'} mx-auto px-4 sm:px-6 py-8 sm:py-10`}>
        {children}
      </main>
      <footer className="max-w-7xl mx-auto px-4 sm:px-6 py-8 mt-8 border-t flex flex-wrap items-center justify-between gap-3 text-sm"
        style={{ borderColor: 'var(--jsp-line)', color: 'var(--jsp-muted)' }}>
        <span>Japan Society Calendar Portal</span>
        <span className="flex items-center gap-4">
          <Link href="/contact" style={{ color: 'var(--jsp-red)' }}>Contact the box office</Link>
          <a href="https://apps.japansociety.org" target="_blank" rel="noopener noreferrer" style={{ color: 'var(--jsp-red)' }}>
            Main site ↗
          </a>
        </span>
      </footer>
    </div>
  )
}

// Dev-stage notice — every write is simulated until live mode is switched on.
export function DevNotice() {
  return (
    <div className="jsp-card px-4 py-2.5 mb-6 text-sm flex items-start gap-2"
      style={{ borderColor: 'rgba(217,165,46,0.4)', background: 'rgba(217,165,46,0.09)' }}>
      <span className="font-semibold" style={{ color: '#8A6410' }}>Dev preview.</span>
      <span style={{ color: 'var(--jsp-ink)' }}>
        Nothing is sent to JotForm and no emails go out — actions show what would happen.
      </span>
    </div>
  )
}
