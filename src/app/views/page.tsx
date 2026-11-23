'use client'

// "Other views" — the pre-v2 surfaces, kept reachable through the transition.
// The scope calls for these to live behind ONE nav entry rather than three
// top-level tabs: the SharePoint weekly calendar, the JotForm Tables view the
// box office works in, and the original JotForm booking form (the fallback
// path while the custom wizard is still in dry run).
import { useState } from 'react'
import Link from 'next/link'
import PortalShell, { PortalHero } from '../../components/PortalShell'

type ViewKey = 'weekly' | 'tables' | 'form'

const VIEWS: { key: ViewKey; label: string; blurb: string; src: string; external: string }[] = [
  {
    key: 'weekly',
    label: 'Weekly Calendar',
    blurb: 'The live Excel weekly calendar from SharePoint.',
    src: 'https://japansoc.sharepoint.com/:x:/r/sites/JapanSociety/_layouts/15/Doc.aspx?sourcedoc=%7Be0169345-0224-4f18-b5f0-cc974fa4afa1%7D&action=embedview&wdAllowInteractivity=False&wdHideGridlines=True&wdHideHeaders=True&wdDownloadButton=True&wdInConfigurator=True&edaebf=rslc0',
    external: 'https://japansoc.sharepoint.com/:x:/r/sites/JapanSociety/_layouts/15/Doc.aspx?sourcedoc=%7Be0169345-0224-4f18-b5f0-cc974fa4afa1%7D',
  },
  {
    key: 'tables',
    label: 'JotForm Tables',
    blurb: 'Every submission in JotForm\u2019s own table view — where the box office changes status.',
    src: 'https://www.jotform.com/tables/252113809267053?embedMode=iframeembed',
    external: 'https://www.jotform.com/tables/252113809267053',
  },
  {
    key: 'form',
    label: 'JotForm Booking Form',
    blurb: 'The original booking form. Still available while the new request flow is in preview.',
    src: 'https://form.jotform.com/252113809267053',
    external: 'https://form.jotform.com/252113809267053',
  },
]

export default function OtherViewsPage() {
  const [active, setActive] = useState<ViewKey>('weekly')
  const view = VIEWS.find(v => v.key === active) ?? VIEWS[0]

  return (
    <PortalShell active="home" wide>
      <PortalHero
        kicker="OTHER VIEWS"
        title="Weekly calendar & JotForm"
        lede="The original surfaces, kept here while the new portal is in preview."
      />

      <div className="jsp-card p-4 sm:p-5 mb-6">
        <p className="text-[0.68rem] font-semibold uppercase tracking-widest mb-2.5"
          style={{ color: 'var(--jsp-muted)' }}>
          View
        </p>
        <div className="flex flex-wrap gap-2">
          {VIEWS.map(v => (
            <button
              key={v.key}
              type="button"
              onClick={() => setActive(v.key)}
              className="jsp-chip"
              data-on={active === v.key}
            >
              {v.label}
            </button>
          ))}
        </div>
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm" style={{ color: 'var(--jsp-muted)' }}>{view.blurb}</p>
          <a
            href={view.external}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm font-medium shrink-0"
            style={{ color: 'var(--jsp-red)' }}
          >
            Open in a new tab ↗
          </a>
        </div>
      </div>

      <div className="jsp-card overflow-hidden">
        {/* Fixed-ratio frame: these are third-party embeds, so they get a
            generous viewport rather than trying to size to their content. */}
        <iframe
          key={view.key}
          src={view.src}
          title={view.label}
          loading="lazy"
          allowFullScreen
          className="w-full border-0 block rounded-[17px]"
          style={{ height: 'min(1000px, 80vh)' }}
        />
      </div>

      {active === 'form' && (
        <div className="jsp-card p-4 mt-6 text-sm" style={{ color: 'var(--jsp-ink)' }}>
          Booking a range of dates? The{' '}
          <Link href="/submit" style={{ color: 'var(--jsp-red)', fontWeight: 600 }}>
            new request flow
          </Link>{' '}
          covers a whole series in one submission instead of one form per day.
        </div>
      )}
    </PortalShell>
  )
}
