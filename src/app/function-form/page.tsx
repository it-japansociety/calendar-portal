'use client'

// /function-form?group=<id> — the box office's real paper Function Form,
// mirrored field-for-field. Everything the booking already knows (title,
// dates, times, rooms, department, contact) is shown read-only up top so
// nothing gets re-typed; this page only collects what's NOT already on file.
// Saves into function_forms via /api/function-form; a complete submit lets
// the rules engine auto-confirm the booking once everything checks out.
import { Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useSearchParams } from 'next/navigation'
import PortalShell, { PortalHero, DevNotice } from '../../components/PortalShell'
import { roomsInLocation } from '@/lib/rooms'
import { cachedFetch, invalidateCache } from '@/lib/client-cache'
import { formatTimeRange } from '@/lib/status'
import { expandGroupDates, weekdaysFromMask, FUNCTION_FORM_MAX } from '@/lib/workflow-types'
import type { EventGroup, FunctionFormData, FunctionFormRow } from '@/lib/workflow-types'

const WEEKDAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

const EXTRA_SPACES_MAIN = [
  'Coatroom', 'Gallery — North', 'Gallery — South', 'Gallery — Bamboo',
  'Dressing Room #1', 'Dressing Room #2', 'Library', 'Teachers Lounge',
]
const EXTRA_SPACES_LC = ['Language Center CL#1', 'Language Center CL#2', 'Language Center CL#3']

const FNB_OPTIONS = [
  'JS wine (red & white)', 'Other wine', 'Sparkling/Champagne', 'JS beer', 'Other beer',
  'Sake', 'Soda/Seltzer', 'Coffee service', 'Senbei', 'Bento boxes',
  'Donated food/beverage', 'Catering',
]

const AV_OPTIONS = [
  'Lectern', 'Projector & screen', 'Headset mic', 'Portable television', 'Video camera',
  'Extra wired internet', 'Outside projectionist', 'JS step & repeats',
  'Piano — program must arrange tuning', 'Simultaneous translation',
]

const QTY_SPECS: { key: string; label: string }[] = [
  { key: 'platforms_qty', label: 'Platforms' },
  { key: 'whiteboards_qty', label: 'Whiteboards' },
  { key: 'table_skirts_qty', label: 'Table skirts' },
  { key: 'folding_screens_qty', label: 'Folding screens' },
  { key: 'easels_qty', label: 'Easels' },
  { key: 'stanchions_qty', label: 'Stanchions' },
  { key: 'coat_racks_qty', label: 'Coat racks' },
  { key: 'aud_rows_covered_qty', label: 'Auditorium rows covered' },
]

type BoolField =
  | 'intermission' | 'latecomer_admitted' | 'gallery_open_beyond_hours'
  | 'ticket_takers' | 'coat_check' | 'party_rentals' | 'av_tech_booked'
type ArrField = 'extra_spaces' | 'fnb' | 'av'

function fmtDate(iso: string): string {
  const d = new Date(`${iso}T12:00:00Z`)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleDateString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC',
  })
}

function weekdaySummary(mask: string): string {
  const days = weekdaysFromMask(mask)
  if (days.length === 7) return 'Every day'
  if (days.length === 5 && [1, 2, 3, 4, 5].every(d => days.includes(d))) return 'Weekdays'
  if (days.length === 2 && days.includes(0) && days.includes(6)) return 'Weekends'
  return days.map(d => WEEKDAY_NAMES[d]).join(', ')
}

function strVal(form: FunctionFormData, key: string): string {
  const v = (form as Record<string, unknown>)[key]
  return typeof v === 'string' ? v : ''
}

const mutedStyle = { color: 'var(--jsp-muted)' }
const inkStyle = { color: 'var(--jsp-ink)' }
const labelPCls = 'text-sm font-medium mb-2'
const labelDtCls = 'text-[11px] font-semibold uppercase tracking-wide mb-0.5'

// ── Setup map & attachments ──────────────────────────────────────────────

type Attachment = {
  id: number
  filename: string
  mime_type: string
  size_bytes: number
  uploaded_by: string
  created_at: string
}

const MAX_ATTACHMENT_BYTES = 4 * 1024 * 1024 // matches the API's limit

function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${n} B`
}

// Reads a File as base64 (no "data:...;base64," prefix) for the JSON POST body.
function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = reader.result
      if (typeof result !== 'string') { reject(new Error('Could not read file')); return }
      const i = result.indexOf(',')
      resolve(i >= 0 ? result.slice(i + 1) : result)
    }
    reader.onerror = () => reject(new Error('Could not read file'))
    reader.readAsDataURL(file)
  })
}

// ── Presentational bits ──────────────────────────────────────────────────

function Field({
  label, required, hint, children,
}: {
  label: string
  required?: boolean
  hint?: string
  children: ReactNode
}) {
  return (
    <div>
      <label className="block text-sm font-medium mb-1.5" style={inkStyle}>
        {label}{required && <span style={{ color: 'var(--jsp-red)' }}> *</span>}
      </label>
      {children}
      {hint && <p className="mt-1 text-xs" style={mutedStyle}>{hint}</p>}
    </div>
  )
}

// Pill chip — used both as a multi-select item and as a single boolean toggle.
function Chip({
  label, active, onClick,
}: {
  label: string
  active: boolean
  onClick: () => void
}) {
  return (
    <button type="button" onClick={onClick} aria-pressed={active} className="jsp-chip" data-on={active}>
      {label}
    </button>
  )
}

// +/- quantity control, hard-capped at `max` (from FUNCTION_FORM_MAX).
function Stepper({
  label, value, max, onChange,
}: {
  label: string
  value?: string
  max: number
  onChange: (v: string) => void
}) {
  const safeMax = Math.max(0, max)
  const n = Math.min(safeMax, Math.max(0, parseInt(value || '0', 10) || 0))
  const btnCls = 'w-8 h-8 rounded-full border text-base font-semibold leading-none disabled:opacity-30 disabled:cursor-not-allowed transition-colors'
  const btnStyle = { borderColor: 'var(--jsp-line)', color: 'var(--jsp-ink)' }
  return (
    <div className="flex items-center justify-between gap-3">
      <div>
        <p className="text-sm font-medium" style={inkStyle}>{label}</p>
        <p className="text-[11px]" style={mutedStyle}>max {safeMax}</p>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <button type="button" disabled={n <= 0} onClick={() => onChange(String(n - 1))} className={btnCls} style={btnStyle} aria-label={`Fewer ${label}`}>−</button>
        <span className="w-6 text-center text-sm font-semibold tabular-nums" style={inkStyle}>{n}</span>
        <button type="button" disabled={n >= safeMax} onClick={() => onChange(String(n + 1))} className={btnCls} style={btnStyle} aria-label={`More ${label}`}>+</button>
      </div>
    </div>
  )
}

// Collapsible .jsp-card section — a chevron toggles open/closed; opens by
// default only when it already has data, or (Times & schedule) is required.
function Section({
  kicker, description, note, defaultOpen, children,
}: {
  kicker: string
  description?: string
  note?: string
  defaultOpen: boolean
  children: ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="jsp-card p-5 sm:p-6">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        className="w-full flex items-start justify-between gap-3 text-left"
      >
        <div>
          <p className="jsp-kicker">{kicker}</p>
          {description && <p className="mt-1.5 text-sm" style={mutedStyle}>{description}</p>}
          {note && <p className="mt-1 text-xs" style={mutedStyle}>{note}</p>}
        </div>
        <svg
          aria-hidden
          viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}
          className={`mt-1 w-5 h-5 shrink-0 transition-transform ${open ? 'rotate-180' : ''}`}
          style={mutedStyle}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {open && <div className="mt-5 flex flex-col gap-5">{children}</div>}
    </div>
  )
}

function FunctionFormInner() {
  const params = useSearchParams()
  const groupId = params.get('group') || ''
  const asParam = params.get('as') || ''

  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [group, setGroup] = useState<EventGroup | null>(null)
  const [wasComplete, setWasComplete] = useState(false)

  const [form, setForm] = useState<FunctionFormData>({})
  // Flips true on the first edit so a background cache refresh never clobbers
  // in-progress typing (the SWR "fresh data replaces it" step only applies
  // before the visitor has actually started filling anything in).
  const editedRef = useRef(false)

  const [saving, setSaving] = useState<'draft' | 'submit' | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [submitted, setSubmitted] = useState(false)

  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [attachmentsLoading, setAttachmentsLoading] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [attachmentError, setAttachmentError] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const patch = (p: Partial<FunctionFormData>) => {
    editedRef.current = true
    setForm(f => ({ ...f, ...p }))
  }
  const toggleBool = (key: BoolField) => {
    editedRef.current = true
    setForm(f => ({ ...f, [key]: !f[key] }))
  }
  const toggleIn = (key: ArrField, value: string) => {
    editedRef.current = true
    setForm(f => {
      const arr = f[key] ?? []
      return { ...f, [key]: arr.includes(value) ? arr.filter(v => v !== value) : [...arr, value] }
    })
  }

  // Load the group + any saved form. Stale-while-revalidate: a cached
  // snapshot (if any) renders immediately; the fresh fetch replaces it.
  useEffect(() => {
    if (!groupId) {
      setLoadError('No booking was specified. Open this page from one of your bookings.')
      setLoading(false)
      return
    }
    let cancelled = false
    const cacheKey = `ff:${groupId}`
    const q = new URLSearchParams({ group: groupId })
    if (asParam) q.set('as', asParam)
    const url = `/api/function-form?${q.toString()}`

    type Result = { group: EventGroup; form: FunctionFormRow | null }
    const applyFresh = (json: Result | null) => {
      if (cancelled || !json?.group) return
      setGroup(json.group)
      setWasComplete(json.form?.complete === 1)
      if (!editedRef.current) {
        if (json.form?.data) {
          try { setForm(JSON.parse(json.form.data) as FunctionFormData) } catch { setForm({}) }
        } else {
          setForm({})
        }
      }
    }

    cachedFetch<Result>(cacheKey, url, applyFresh)
      .then(json => {
        if (cancelled) return
        if (json?.group) applyFresh(json)
        else setLoadError('Could not load this booking. Open this page from one of your bookings.')
      })
      .catch(() => { if (!cancelled) setLoadError('Could not load this booking.') })
      .finally(() => { if (!cancelled) setLoading(false) })

    return () => { cancelled = true }
  }, [groupId, asParam])

  // Setup map & attachments — fetched once the booking itself is loaded.
  function fetchAttachments() {
    if (!groupId) return Promise.resolve()
    setAttachmentsLoading(true)
    const q = new URLSearchParams({ group: groupId })
    if (asParam) q.set('as', asParam)
    return fetch(`/api/function-form/attachments?${q.toString()}`)
      .then(res => res.json() as Promise<{ attachments?: Attachment[] }>)
      .then(json => setAttachments(json.attachments || []))
      .catch(() => setAttachments([]))
      .finally(() => setAttachmentsLoading(false))
  }

  useEffect(() => {
    if (loading || !groupId || !group) return
    void fetchAttachments()
    // Only re-run when the booking finishes loading, not on every cache refresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, groupId])

  async function handleFiles(fileList: FileList | null) {
    if (!fileList || fileList.length === 0) return
    setAttachmentError(null)
    const files = Array.from(fileList)
    const tooBig = files.find(f => f.size > MAX_ATTACHMENT_BYTES)
    if (tooBig) {
      setAttachmentError(`"${tooBig.name}" is too large — attachments are limited to 4MB.`)
      if (fileInputRef.current) fileInputRef.current.value = ''
      return
    }
    setUploading(true)
    try {
      for (const file of files) {
        const data_base64 = await readFileAsBase64(file)
        const url = asParam ? `/api/function-form/attachments?as=${encodeURIComponent(asParam)}` : '/api/function-form/attachments'
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            group_id: groupId, filename: file.name,
            mime_type: file.type || 'application/octet-stream', data_base64,
          }),
        })
        const json = await res.json().catch(() => ({})) as { ok?: boolean; error?: string }
        if (!res.ok || !json.ok) throw new Error(json.error || `Upload failed (${res.status})`)
      }
      await fetchAttachments()
    } catch (err) {
      setAttachmentError(err instanceof Error ? err.message : 'Upload failed')
    } finally {
      setUploading(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  async function handleRemoveAttachment(att: Attachment) {
    if (!confirm(`Remove "${att.filename}"?`)) return
    setAttachmentError(null)
    try {
      const q = new URLSearchParams({ id: String(att.id) })
      if (asParam) q.set('as', asParam)
      const res = await fetch(`/api/function-form/attachments?${q.toString()}`, { method: 'DELETE' })
      const json = await res.json().catch(() => ({})) as { ok?: boolean; error?: string }
      if (!res.ok || !json.ok) throw new Error(json.error || `Remove failed (${res.status})`)
      await fetchAttachments()
    } catch (err) {
      setAttachmentError(err instanceof Error ? err.message : 'Remove failed')
    }
  }

  async function save(complete: boolean) {
    setSaveError(null)
    setNotice(null)
    if (complete && !(form.staff_in_charge?.trim() && form.guest_count?.trim())) {
      setSaveError('Enter the staff in charge and expected guest count before submitting.')
      return
    }
    setSaving(complete ? 'submit' : 'draft')
    try {
      const url = asParam ? `/api/function-form?as=${encodeURIComponent(asParam)}` : '/api/function-form'
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ group_id: groupId, data: form, complete }),
      })
      const json = await res.json().catch(() => ({})) as { ok?: boolean; error?: string; complete?: boolean }
      if (!res.ok || !json.ok) {
        throw new Error(json.error || `Save failed (${res.status})`)
      }
      // Mutation done — drop the cached snapshot and warm it again for next time.
      const cacheKey = `ff:${groupId}`
      invalidateCache(cacheKey)
      const q = new URLSearchParams({ group: groupId })
      if (asParam) q.set('as', asParam)
      cachedFetch(cacheKey, `/api/function-form?${q.toString()}`).catch(() => undefined)

      setWasComplete(Boolean(json.complete))
      if (complete && json.complete) {
        setSubmitted(true)
      } else if (complete && !json.complete) {
        setNotice('Saved — but staff in charge and guest count are still needed before this counts as submitted.')
      } else {
        setNotice('Draft saved.')
      }
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Save failed')
    } finally {
      setSaving(null)
    }
  }

  const rooms = group ? Array.from(roomsInLocation(group.location)) : []
  const days = group
    ? expandGroupDates(group.date_from, group.date_to, weekdaysFromMask(group.weekday_mask))
    : []
  const singleDay = group ? group.date_from === group.date_to : true

  const butlersN = parseInt(form.butlers_qty || '0', 10) || 0
  const micsMax = FUNCTION_FORM_MAX.mics_total
  const wirelessN = Math.max(0, parseInt(form.mics_wireless_qty || '0', 10) || 0)
  const wiredN = Math.max(0, parseInt(form.mics_wired_qty || '0', 10) || 0)

  const canSubmit = Boolean(form.staff_in_charge?.trim() && form.guest_count?.trim())
  const requiredMissing = [
    !form.staff_in_charge?.trim() && 'Staff in charge',
    !form.guest_count?.trim() && 'Guest count',
  ].filter((x): x is string => Boolean(x))
  const requiredTotal = 2

  const hasExtra = (form.extra_spaces?.length ?? 0) > 0
    || !!form.gallery_open_beyond_hours || !!form.gallery_hours_note?.trim()
  const hasStaff = butlersN > 0 || !!form.ticket_takers || !!form.coat_check
    || !!form.box_office_early?.trim() || !!form.party_rentals || !!form.staff_notes?.trim()
  const hasFnb = form.reception === 'reception' || (form.fnb?.length ?? 0) > 0
    || !!form.dietary_restrictions?.trim() || !!form.fnb_notes?.trim()
  const hasAv = (form.av?.length ?? 0) > 0 || !!form.laptop || !!form.stream || !!form.av_tech_booked
    || !!form.stage_panels || !!form.waterfall || !!form.av_notes?.trim()
    || wirelessN > 0 || wiredN > 0 || QTY_SPECS.some(s => (parseInt(strVal(form, s.key) || '0', 10) || 0) > 0)
  const hasComments = !!form.additional_comments?.trim()

  // Memoized only so re-renders don't recompute defaultOpen mid-session for
  // sections already mounted — the values themselves are cheap either way.
  const defaults = useMemo(() => ({ hasExtra, hasStaff, hasFnb, hasAv, hasComments }), [hasExtra, hasStaff, hasFnb, hasAv, hasComments])

  const heroTitle = group?.event_name || 'Function form'
  const heroLede = group
    ? 'Everything your booking already knows is filled in below — this just covers the rest for the box office.'
    : loadError
      ? 'This booking could not be loaded.'
      : 'Loading your booking…'

  return (
    <PortalShell active="forms">
      <DevNotice />
      <PortalHero kicker="FUNCTION FORM" title={heroTitle} lede={heroLede} />

      {loading && (
        <div className="jsp-card p-6">
          <p className="text-sm" style={mutedStyle}>Loading booking…</p>
        </div>
      )}

      {!loading && (loadError || !group) && (
        <div className="jsp-card p-8 sm:p-10 text-center">
          <h2 className="text-lg font-semibold mb-2" style={inkStyle}>Booking not found</h2>
          <p className="text-sm mb-5" style={mutedStyle}>{loadError || 'This booking could not be loaded.'}</p>
          <a href="/my" className="jsp-btn inline-flex items-center justify-center">Go to My Bookings</a>
        </div>
      )}

      {!loading && !loadError && group && submitted && (
        <div className="jsp-card p-8 sm:p-10 text-center">
          <div
            className="mx-auto mb-4 w-12 h-12 rounded-full flex items-center justify-center"
            style={{ background: 'rgba(87,180,118,0.16)', color: '#2F7A4C' }}
          >
            <svg aria-hidden viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} className="w-6 h-6">
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
          </div>
          <h2 className="text-lg font-bold mb-2" style={inkStyle}>Function form submitted</h2>
          <p className="text-sm mb-6 max-w-md mx-auto" style={mutedStyle}>
            Confirmation is automatic once the box office checklist clears — no further action is needed for <b>{group.event_name}</b>.
          </p>
          <div className="flex flex-col sm:flex-row items-center justify-center gap-3">
            <a href="/my" className="jsp-btn inline-flex items-center justify-center">Back to My Bookings</a>
            <button type="button" onClick={() => setSubmitted(false)} className="jsp-btn-ghost inline-flex items-center justify-center">
              Back to the booking
            </button>
          </div>
        </div>
      )}

      {!loading && !loadError && group && !submitted && (
        <>
          <div className="flex flex-col gap-6 pb-32 sm:pb-28">
            {/* Booking summary — read-only, zero re-entry vs the paper form */}
            <div className="jsp-card p-5 sm:p-6">
              <p className="jsp-kicker">BOOKING SUMMARY</p>
              <p className="mt-2 text-xs italic" style={mutedStyle}>Pulled from your booking — nothing to re-enter.</p>
              <dl className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3 text-sm">
                <div>
                  <dt className={labelDtCls} style={mutedStyle}>Dates</dt>
                  <dd style={inkStyle}>
                    {singleDay ? fmtDate(group.date_from) : `${fmtDate(group.date_from)} – ${fmtDate(group.date_to)}`}
                    {!singleDay && ` · ${weekdaySummary(group.weekday_mask)}`}
                    {days.length > 1 && ` · ${days.length} days`}
                  </dd>
                </div>
                <div>
                  <dt className={labelDtCls} style={mutedStyle}>Event time</dt>
                  <dd style={inkStyle}>{formatTimeRange(group.event_start, group.event_end)}</dd>
                </div>
                <div>
                  <dt className={labelDtCls} style={mutedStyle}>Rooms</dt>
                  <dd style={inkStyle}>{rooms.length > 0 ? rooms.join(', ') : (group.location || 'Not set')}</dd>
                </div>
                <div>
                  <dt className={labelDtCls} style={mutedStyle}>Department</dt>
                  <dd style={inkStyle}>{group.department || 'Not set'}</dd>
                </div>
                <div className="sm:col-span-2">
                  <dt className={labelDtCls} style={mutedStyle}>Contact</dt>
                  <dd style={inkStyle}>
                    {[group.contact_name, group.email, group.phone].filter(Boolean).join(' · ') || 'Not set'}
                  </dd>
                </div>
              </dl>
            </div>

            {wasComplete && (
              <p className="-mt-2 text-xs rounded-xl border px-3 py-2" style={{ borderColor: 'var(--jsp-line)', background: 'var(--jsp-card)', color: 'var(--jsp-muted)' }}>
                You already submitted this form. Saving again updates the details on file.
              </p>
            )}

            {/* a. Times & schedule — required, always open */}
            <Section kicker="TIMES & SCHEDULE" description="Staffing, prep, and the run of show" defaultOpen>
              <Field label="Staff in charge" required>
                <input
                  type="text" className="jsp-input"
                  placeholder="Name of the JS staff member running this event"
                  value={form.staff_in_charge ?? ''} onChange={e => patch({ staff_in_charge: e.target.value })}
                />
              </Field>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <Field label="Prep time from" hint="1 hour minimum for each">
                  <input type="time" className="jsp-input" value={form.prep_time_from ?? ''} onChange={e => patch({ prep_time_from: e.target.value })} />
                </Field>
                <Field label="Clean-up to" hint="1 hour minimum for each">
                  <input type="time" className="jsp-input" value={form.clean_up_to ?? ''} onChange={e => patch({ clean_up_to: e.target.value })} />
                </Field>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <Field label="Check-in opens">
                  <input type="time" className="jsp-input" value={form.check_in_open ?? ''} onChange={e => patch({ check_in_open: e.target.value })} />
                </Field>
                <Field label="Doors open (AUD/MUR)">
                  <input type="time" className="jsp-input" value={form.doors_open ?? ''} onChange={e => patch({ doors_open: e.target.value })} />
                </Field>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <Field label="Run time">
                  <input type="text" className="jsp-input" placeholder="e.g. 3 hours" value={form.run_time ?? ''} onChange={e => patch({ run_time: e.target.value })} />
                </Field>
                <Field label="Guest count" required>
                  <input type="number" min={0} inputMode="numeric" className="jsp-input" placeholder="e.g. 120" value={form.guest_count ?? ''} onChange={e => patch({ guest_count: e.target.value })} />
                </Field>
              </div>
              <div className="flex flex-wrap gap-2">
                <Chip label="Intermission" active={!!form.intermission} onClick={() => toggleBool('intermission')} />
                <Chip label="Latecomers admitted" active={!!form.latecomer_admitted} onClick={() => toggleBool('latecomer_admitted')} />
              </div>
              <Field label="Sponsors / co-organizers">
                <input type="text" className="jsp-input" value={form.sponsors_co_organizers ?? ''} onChange={e => patch({ sponsors_co_organizers: e.target.value })} />
              </Field>
              <Field label="Dept./project codes">
                <input type="text" className="jsp-input" value={form.dept_project_codes ?? ''} onChange={e => patch({ dept_project_codes: e.target.value })} />
              </Field>
              <Field label="Schedule">
                <textarea
                  rows={4} className="jsp-input"
                  placeholder={'6 pm to 7 pm: VIP reception\n7 pm to 9 pm: General event'}
                  value={form.schedule ?? ''} onChange={e => patch({ schedule: e.target.value })}
                />
              </Field>
            </Section>

            {/* b. Extra spaces */}
            <Section kicker="EXTRA SPACES" description="Need more than the booked rooms?" defaultOpen={defaults.hasExtra}>
              <div>
                <div className="flex flex-wrap gap-2">
                  {EXTRA_SPACES_MAIN.map(opt => (
                    <Chip key={opt} label={opt} active={(form.extra_spaces ?? []).includes(opt)} onClick={() => toggleIn('extra_spaces', opt)} />
                  ))}
                </div>
                <div className="mt-4">
                  <p className="text-xs font-semibold uppercase tracking-wide" style={mutedStyle}>Language Center</p>
                  <div className="mt-1.5 flex flex-wrap gap-2">
                    {EXTRA_SPACES_LC.map(opt => (
                      <Chip key={opt} label={opt.replace('Language Center ', '')} active={(form.extra_spaces ?? []).includes(opt)} onClick={() => toggleIn('extra_spaces', opt)} />
                    ))}
                  </div>
                  <p className="mt-1.5 text-xs" style={mutedStyle}>Requires Language Center approval.</p>
                </div>
              </div>
              <div>
                <Chip label="Gallery open beyond booked hours" active={!!form.gallery_open_beyond_hours} onClick={() => toggleBool('gallery_open_beyond_hours')} />
                {form.gallery_open_beyond_hours && (
                  <div className="mt-3">
                    <Field label="Gallery hours note">
                      <input type="text" className="jsp-input" placeholder="e.g. Open 10 am–8 pm for this event" value={form.gallery_hours_note ?? ''} onChange={e => patch({ gallery_hours_note: e.target.value })} />
                    </Field>
                  </div>
                )}
              </div>
            </Section>

            {/* c. Staff & rentals */}
            <Section kicker="STAFF & RENTALS" description="Butlers, coat check, and rentals" defaultOpen={defaults.hasStaff}>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <Field label="Butlers" hint="Number needed">
                  <input type="number" min={0} inputMode="numeric" className="jsp-input" value={form.butlers_qty ?? ''} onChange={e => patch({ butlers_qty: e.target.value })} />
                </Field>
                {butlersN > 0 && (
                  <>
                    <Field label="Butlers from">
                      <input type="time" className="jsp-input" value={form.butlers_from ?? ''} onChange={e => patch({ butlers_from: e.target.value })} />
                    </Field>
                    <Field label="Butlers to">
                      <input type="time" className="jsp-input" value={form.butlers_to ?? ''} onChange={e => patch({ butlers_to: e.target.value })} />
                    </Field>
                  </>
                )}
              </div>
              <div className="flex flex-wrap gap-2">
                <Chip label="Ticket takers needed" active={!!form.ticket_takers} onClick={() => toggleBool('ticket_takers')} />
                <Chip label="Coat check needed" active={!!form.coat_check} onClick={() => toggleBool('coat_check')} />
              </div>
              {form.coat_check && (
                <div className="grid grid-cols-2 gap-4 sm:max-w-sm">
                  <Field label="Coat check from">
                    <input type="time" className="jsp-input" value={form.coat_check_from ?? ''} onChange={e => patch({ coat_check_from: e.target.value })} />
                  </Field>
                  <Field label="Coat check to">
                    <input type="time" className="jsp-input" value={form.coat_check_to ?? ''} onChange={e => patch({ coat_check_to: e.target.value })} />
                  </Field>
                </div>
              )}
              <Field label="Box office arrival" hint="Early or late, and what time">
                <input type="text" className="jsp-input" placeholder="e.g. 30 min early (5:00 PM)" value={form.box_office_early ?? ''} onChange={e => patch({ box_office_early: e.target.value })} />
              </Field>
              <div>
                <Chip label="Outside party rentals" active={!!form.party_rentals} onClick={() => toggleBool('party_rentals')} />
                <p className="mt-1.5 text-xs" style={mutedStyle}>Attach or email the rental details to the box office.</p>
              </div>
              <Field label="Staff notes">
                <textarea rows={3} className="jsp-input" value={form.staff_notes ?? ''} onChange={e => patch({ staff_notes: e.target.value })} />
              </Field>
            </Section>

            {/* d. Food & beverages */}
            <Section kicker="FOOD & BEVERAGES" description="Reception details" defaultOpen={defaults.hasFnb}>
              <div className="flex flex-wrap gap-2">
                <Chip label="No reception" active={form.reception === 'none'} onClick={() => patch({ reception: 'none' })} />
                <Chip label="Reception" active={form.reception === 'reception'} onClick={() => patch({ reception: 'reception' })} />
              </div>
              {form.reception === 'reception' && (
                <>
                  <div>
                    <p className={labelPCls} style={inkStyle}>Food & beverage</p>
                    <div className="flex flex-wrap gap-2">
                      {FNB_OPTIONS.map(opt => (
                        <Chip key={opt} label={opt} active={(form.fnb ?? []).includes(opt)} onClick={() => toggleIn('fnb', opt)} />
                      ))}
                    </div>
                  </div>
                  {(form.fnb ?? []).includes('Bento boxes') && (
                    <Field label="Bento quantity">
                      <input type="number" min={0} inputMode="numeric" className="jsp-input sm:max-w-[10rem]" value={form.bento_qty ?? ''} onChange={e => patch({ bento_qty: e.target.value })} />
                    </Field>
                  )}
                  {(form.fnb ?? []).includes('Senbei') && (
                    <Field label="Senbei location">
                      <input type="text" className="jsp-input" value={form.senbei_location ?? ''} onChange={e => patch({ senbei_location: e.target.value })} />
                    </Field>
                  )}
                  <Field label="Dietary restrictions">
                    <input type="text" className="jsp-input" placeholder="Allergies, vegetarian/vegan, kosher, halal…" value={form.dietary_restrictions ?? ''} onChange={e => patch({ dietary_restrictions: e.target.value })} />
                  </Field>
                  <Field label="F&B notes">
                    <textarea rows={3} className="jsp-input" value={form.fnb_notes ?? ''} onChange={e => patch({ fnb_notes: e.target.value })} />
                  </Field>
                </>
              )}
            </Section>

            {/* e. AV & equipment */}
            <Section
              kicker="AV & EQUIPMENT" description="Sound, video, and staging"
              note="Have a setup map or floor plan? Attach it below — no need to email it separately."
              defaultOpen={defaults.hasAv}
            >
              <div>
                <p className={labelPCls} style={inkStyle}>Equipment</p>
                <div className="flex flex-wrap gap-2">
                  {AV_OPTIONS.map(opt => (
                    <Chip key={opt} label={opt} active={(form.av ?? []).includes(opt)} onClick={() => toggleIn('av', opt)} />
                  ))}
                </div>
              </div>

              <div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <Stepper label="Wireless mics" value={form.mics_wireless_qty} max={micsMax - wiredN} onChange={v => patch({ mics_wireless_qty: v })} />
                  <Stepper label="Wired mics" value={form.mics_wired_qty} max={micsMax - wirelessN} onChange={v => patch({ mics_wired_qty: v })} />
                </div>
                <p className="mt-1.5 text-xs" style={mutedStyle}>{wirelessN + wiredN} of {micsMax} mics used, combined.</p>
              </div>

              <div>
                <p className={labelPCls} style={inkStyle}>Laptop</p>
                <div className="flex flex-wrap gap-2">
                  <Chip label="JS laptop" active={form.laptop === 'js'} onClick={() => patch({ laptop: 'js' })} />
                  <Chip label="Outside laptop" active={form.laptop === 'outside'} onClick={() => patch({ laptop: 'outside' })} />
                </div>
              </div>
              {!!form.laptop && (
                <div>
                  <p className={labelPCls} style={inkStyle}>Laptop location</p>
                  <div className="flex flex-wrap gap-2">
                    <Chip label="Lectern" active={form.laptop_location === 'lectern'} onClick={() => patch({ laptop_location: 'lectern' })} />
                    <Chip label="Table" active={form.laptop_location === 'table'} onClick={() => patch({ laptop_location: 'table' })} />
                    <Chip label="Soundbooth" active={form.laptop_location === 'soundbooth'} onClick={() => patch({ laptop_location: 'soundbooth' })} />
                  </div>
                </div>
              )}

              <div>
                <p className={labelPCls} style={inkStyle}>Streaming / recording</p>
                <div className="flex flex-wrap gap-2">
                  <Chip label="None" active={form.stream === 'none'} onClick={() => patch({ stream: 'none' })} />
                  <Chip label="Livestream (one-way)" active={form.stream === 'livestream'} onClick={() => patch({ stream: 'livestream' })} />
                  <Chip label="Hybrid (two-way)" active={form.stream === 'hybrid'} onClick={() => patch({ stream: 'hybrid' })} />
                  <Chip label="Record" active={form.stream === 'record'} onClick={() => patch({ stream: 'record' })} />
                </div>
              </div>

              <Chip label="AV tech booked" active={!!form.av_tech_booked} onClick={() => toggleBool('av_tech_booked')} />

              <div>
                <p className={labelPCls} style={inkStyle}>Quantities</p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-4">
                  {QTY_SPECS.map(spec => (
                    <Stepper
                      key={spec.key}
                      label={spec.label}
                      value={strVal(form, spec.key)}
                      max={FUNCTION_FORM_MAX[spec.key]}
                      onChange={v => patch({ [spec.key]: v } as unknown as Partial<FunctionFormData>)}
                    />
                  ))}
                </div>
              </div>

              <div>
                <p className={labelPCls} style={inkStyle}>Stage panels</p>
                <div className="flex flex-wrap gap-2">
                  <Chip label="Wood" active={form.stage_panels === 'wood'} onClick={() => patch({ stage_panels: 'wood' })} />
                  <Chip label="Black" active={form.stage_panels === 'black'} onClick={() => patch({ stage_panels: 'black' })} />
                  <Chip label="None" active={form.stage_panels === ''} onClick={() => patch({ stage_panels: '' })} />
                </div>
              </div>

              <div>
                <p className={labelPCls} style={inkStyle}>Waterfall</p>
                <div className="flex flex-wrap gap-2">
                  <Chip label="On" active={form.waterfall === 'on'} onClick={() => patch({ waterfall: 'on' })} />
                  <Chip label="Off" active={form.waterfall === 'off'} onClick={() => patch({ waterfall: 'off' })} />
                </div>
              </div>

              <Field label="AV notes">
                <textarea rows={3} className="jsp-input" value={form.av_notes ?? ''} onChange={e => patch({ av_notes: e.target.value })} />
              </Field>
            </Section>

            {/* e2. Setup map & attachments — replaces the paper form's "email House Activities" step */}
            <Section
              kicker="SETUP MAP & ATTACHMENTS" description="Floor plan or reference files"
              defaultOpen={attachments.length > 0}
            >
              <p className="text-sm" style={mutedStyle}>
                Attach a setup map, floor plan, or any reference file for House Activities.
              </p>

              {attachmentError && <p className="text-xs" style={{ color: 'var(--jsp-red)' }}>{attachmentError}</p>}

              {attachmentsLoading ? (
                <p className="text-sm" style={mutedStyle}>Loading attachments…</p>
              ) : attachments.length > 0 ? (
                <ul className="flex flex-col gap-2">
                  {attachments.map(att => (
                    <li
                      key={att.id}
                      className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 rounded-xl border px-3.5 py-2.5"
                      style={{ borderColor: 'var(--jsp-line)', background: 'var(--jsp-card)' }}
                    >
                      <div className="min-w-0">
                        <p className="text-sm font-medium truncate" style={inkStyle}>{att.filename}</p>
                        <p className="text-xs" style={mutedStyle}>{formatBytes(att.size_bytes)} · {att.uploaded_by}</p>
                      </div>
                      <div className="flex items-center gap-4 shrink-0">
                        <a
                          href={`/api/function-form/attachments/${att.id}`} target="_blank" rel="noopener noreferrer"
                          className="text-sm font-medium underline underline-offset-2"
                          style={{ color: 'var(--jsp-red)' }}
                        >
                          View
                        </a>
                        <button
                          type="button" onClick={() => { void handleRemoveAttachment(att) }}
                          className="text-sm font-medium"
                          style={mutedStyle}
                        >
                          Remove
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm" style={mutedStyle}>No files attached yet.</p>
              )}

              <div>
                <label
                  className={`jsp-btn-ghost inline-flex items-center gap-2 cursor-pointer ${uploading ? 'opacity-60 pointer-events-none' : ''}`}
                >
                  <svg aria-hidden viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="w-4 h-4 shrink-0">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M17.5 10.5l-6.6 6.6a3 3 0 01-4.24-4.24l7.07-7.07a2 2 0 012.83 2.83l-7.07 7.07a1 1 0 01-1.41-1.41l6.36-6.36" />
                  </svg>
                  {uploading ? 'Uploading…' : 'Upload a file'}
                  <input
                    ref={fileInputRef} type="file" accept="image/*,.pdf" multiple hidden
                    disabled={uploading}
                    onChange={e => { void handleFiles(e.target.files) }}
                  />
                </label>
              </div>
            </Section>

            {/* f. Additional comments */}
            <Section kicker="ADDITIONAL COMMENTS" description="Anything else the box office should know" defaultOpen={defaults.hasComments}>
              <textarea
                rows={4} className="jsp-input"
                placeholder="Anything else the box office should know…"
                value={form.additional_comments ?? ''} onChange={e => patch({ additional_comments: e.target.value })}
              />
            </Section>
          </div>

          {/* Sticky bottom action bar — always visible */}
          <div className="fixed inset-x-0 bottom-0 z-40 px-4 sm:px-6 pb-3 sm:pb-4 pointer-events-none">
            <div className="max-w-5xl mx-auto jsp-glass p-4 pointer-events-auto flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
              <div className="flex items-center gap-3 min-w-0">
                <div className="w-16 sm:w-24 h-1.5 rounded-full overflow-hidden shrink-0" style={{ background: 'var(--jsp-line)' }}>
                  <div
                    className="h-full rounded-full"
                    style={{ width: `${((requiredTotal - requiredMissing.length) / requiredTotal) * 100}%`, background: 'var(--jsp-red)' }}
                  />
                </div>
                <div className="min-w-0">
                  <p className="text-xs sm:text-sm font-medium truncate" style={inkStyle}>
                    {requiredMissing.length === 0
                      ? 'Ready to submit.'
                      : `${requiredMissing.length} required field${requiredMissing.length > 1 ? 's' : ''} left — ${requiredMissing.join(', ')}`}
                  </p>
                  {saveError && <p className="text-xs mt-0.5" style={{ color: 'var(--jsp-red)' }}>{saveError}</p>}
                  {notice && !saveError && <p className="text-xs mt-0.5" style={{ color: 'var(--jsp-green)' }}>{notice}</p>}
                </div>
              </div>
              <div className="flex gap-2 shrink-0">
                <button type="button" onClick={() => { void save(false) }} disabled={saving !== null} className="jsp-btn-ghost">
                  {saving === 'draft' ? 'Saving…' : 'Save draft'}
                </button>
                <button type="button" onClick={() => { void save(true) }} disabled={saving !== null || !canSubmit} className="jsp-btn">
                  {saving === 'submit' ? 'Submitting…' : 'Submit function form'}
                </button>
              </div>
            </div>
          </div>
        </>
      )}
    </PortalShell>
  )
}

export default function FunctionFormPage() {
  return (
    <Suspense fallback={<div className="min-h-screen" />}>
      <FunctionFormInner />
    </Suspense>
  )
}
