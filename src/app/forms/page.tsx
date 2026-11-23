'use client'

// /forms — a lightweight router into the box office's paper forms.
// "Function form" hands off to the real structured form at /function-form
// (tied to one of the user's bookings) so there stays exactly one source of
// truth for that data. "Event registration" and "AV request" aren't built as
// structured forms yet, so submitting them here just shows what would be
// sent once they are — no backend invented for either.
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import PortalShell, { PortalHero, DevNotice, useWhoami } from '../../components/PortalShell'
import { cachedFetch } from '../../lib/client-cache'
import type { GroupSummary } from '../../lib/workflow-types'

type FormType = 'function' | 'event' | 'av'

const FORM_TYPES: { key: FormType; label: string }[] = [
  { key: 'function', label: 'Function form' },
  { key: 'event', label: 'Event registration' },
  { key: 'av', label: 'AV request' },
]

function MicroLabel({ children }: { children: ReactNode }) {
  return (
    <p className="text-[11px] font-semibold uppercase tracking-wide mb-1.5" style={{ color: 'var(--jsp-muted)' }}>
      {children}
    </p>
  )
}

// "Sep 4" — compact enough for the related-event picker's label.
function shortDate(iso: string): string {
  const d = new Date(`${iso}T12:00:00Z`)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
}

export default function FormsPage() {
  const me = useWhoami()

  // window.location.search, captured after mount, so the ?as= dev identity
  // override keeps working for the bookings lookup and the handoff link.
  const [search, setSearch] = useState<string | null>(null)
  useEffect(() => { setSearch(window.location.search) }, [])
  const passthru = (base: string) => `${base}${search ? `&${search.slice(1)}` : ''}`

  const [groups, setGroups] = useState<GroupSummary[]>([])
  useEffect(() => {
    if (search === null) return
    cachedFetch<{ groups: GroupSummary[] }>('my-groups', passthru('/api/groups?mine=1'), fresh => setGroups(fresh.groups ?? []))
      .then(json => { if (json) setGroups(json.groups ?? []) })
      .catch(() => setGroups([]))
    // Re-run only when the passthrough query settles, not on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search])

  // "<Event name> — <short date>" options, most recent bookings first, for
  // the related-event datalist. A plain Map back to the group id keeps the
  // input a normal text field (no custom combobox needed).
  const bookingOptions = useMemo(
    () => groups
      .filter(g => g.status !== 'cancelled')
      .sort((a, b) => a.date_from.localeCompare(b.date_from))
      .map(g => ({ id: g.group_id, label: `${g.event_name} — ${shortDate(g.date_from)}` })),
    [groups],
  )
  const labelToId = useMemo(() => new Map(bookingOptions.map(o => [o.label, o.id])), [bookingOptions])

  const [formType, setFormType] = useState<FormType>('function')
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [relatedText, setRelatedText] = useState('')
  const [details, setDetails] = useState('')
  const [sent, setSent] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Prefill name/email once from /api/whoami without clobbering later edits.
  const [seeded, setSeeded] = useState(false)
  useEffect(() => {
    if (seeded || !me) return
    setName(me.name || '')
    setEmail(me.email || '')
    setSeeded(true)
  }, [me, seeded])

  const selectedGroupId = labelToId.get(relatedText.trim()) ?? null
  const opensRealForm = formType === 'function' && !!selectedGroupId
  const canSubmit = name.trim().length > 0 && email.trim().length > 0

  function chooseType(key: FormType) {
    setFormType(key)
    setSent(false)
    setError(null)
  }

  function handlePrimary() {
    setError(null)
    if (opensRealForm) {
      window.location.href = passthru(`/function-form?group=${encodeURIComponent(selectedGroupId as string)}`)
      return
    }
    if (formType === 'function') {
      setError('Select one of your bookings above — the function form is tied to a specific booking.')
      return
    }
    setSent(true)
  }

  return (
    <PortalShell active="forms">
      <DevNotice />
      <PortalHero
        kicker="SUBMIT A FORM"
        title="Function & event forms"
        lede="Send details straight to the box office — no external forms."
      />

      <div className="jsp-card p-6 max-w-2xl">
        <MicroLabel>Form type</MicroLabel>
        <div className="flex flex-wrap gap-2 mb-6">
          {FORM_TYPES.map(ft => (
            <button
              key={ft.key}
              type="button"
              className="jsp-chip"
              data-on={formType === ft.key}
              onClick={() => chooseType(ft.key)}
            >
              {ft.label}
            </button>
          ))}
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-5">
          <div>
            <MicroLabel>Your name</MicroLabel>
            <input className="jsp-input" value={name} onChange={e => setName(e.target.value)} placeholder="Your name" />
          </div>
          <div>
            <MicroLabel>Email</MicroLabel>
            <input
              className="jsp-input" type="email" value={email}
              onChange={e => setEmail(e.target.value)} placeholder="you@japansociety.org"
            />
          </div>
        </div>

        <div className="mb-5">
          <MicroLabel>Related event <span className="normal-case font-normal">(optional)</span></MicroLabel>
          <input
            className="jsp-input" list="forms-my-bookings" placeholder="e.g. Test Event — Sep 4"
            value={relatedText} onChange={e => setRelatedText(e.target.value)}
          />
          <datalist id="forms-my-bookings">
            {bookingOptions.map(o => <option key={o.id} value={o.label} />)}
          </datalist>
          {formType === 'function' && (
            <p className="mt-1.5 text-xs" style={{ color: 'var(--jsp-muted)' }}>
              Pick a booking to open its function form — the real, structured version of this form.
            </p>
          )}
        </div>

        <div className="mb-6">
          <MicroLabel>Details</MicroLabel>
          <textarea
            className="jsp-input" rows={4}
            placeholder="Setup, AV, staffing, timing — anything the box office should know."
            value={details} onChange={e => setDetails(e.target.value)}
          />
        </div>

        {error && <p className="text-sm mb-4" style={{ color: 'var(--jsp-red)' }}>{error}</p>}

        {sent ? (
          <div className="jsp-card p-4" style={{ borderColor: 'rgba(87,180,118,0.4)', background: 'rgba(87,180,118,0.08)' }}>
            <p className="text-sm" style={{ color: 'var(--jsp-ink)' }}>
              In the dev preview this is not sent. Live, it will reach{' '}
              <a href="mailto:boxoffice@japansociety.org" style={{ color: 'var(--jsp-red)' }}>boxoffice@japansociety.org</a>.
            </p>
            <button type="button" className="jsp-btn-ghost mt-4" onClick={() => setSent(false)}>
              Submit another
            </button>
          </div>
        ) : (
          <button type="button" className="jsp-btn" disabled={!canSubmit} onClick={handlePrimary}>
            {opensRealForm ? 'Open the function form' : 'Send to box office'}
          </button>
        )}
      </div>
    </PortalShell>
  )
}
