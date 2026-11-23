'use client'

// /contact — the two lines people actually need: the box office (bookings,
// forms, approvals) and house operations (setup, AV, day-of changes).
// Deliberately short; everything else routes through /forms or the booking
// flow itself. Details are placeholders where the box office hasn't
// finalized them yet — fine for the dev preview.
import PortalShell, { PortalHero } from '../../components/PortalShell'

function ContactCard({
  kicker, email, ext, line, footnote,
}: {
  kicker: string
  email: string
  ext: string
  line: string
  footnote: string
}) {
  return (
    <div className="jsp-card p-6">
      <p className="jsp-kicker mb-4">{kicker}</p>
      <a href={`mailto:${email}`} className="block text-lg font-semibold break-all" style={{ color: 'var(--jsp-red)' }}>
        {email}
      </a>
      <p className="mt-3 text-sm" style={{ color: 'var(--jsp-ink)' }}>{ext}</p>
      <p className="text-sm" style={{ color: 'var(--jsp-ink)' }}>{line}</p>
      <p className="mt-4 text-xs italic" style={{ color: 'var(--jsp-muted)' }}>{footnote}</p>
    </div>
  )
}

export default function ContactPage() {
  return (
    <PortalShell active="contact">
      <PortalHero
        kicker="CONTACT"
        title="Reach the box office"
        lede="For bookings, forms, and day-of changes."
      />

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-6 max-w-3xl">
        <ContactCard
          kicker="Box Office"
          email="boxoffice@japansociety.org"
          ext="Ext. 234"
          line="Mon–Fri · 9 AM – 6 PM"
          footnote="Bookings, approvals, and function forms."
        />
        <ContactCard
          kicker="House Operations"
          email="facilities@japansociety.org"
          ext="Ext. 267"
          line="Setup, AV & room changes"
          footnote="For urgent day-of changes, call directly."
        />
      </div>
    </PortalShell>
  )
}
