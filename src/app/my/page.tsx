'use client'

// "My Bookings" — one card per event group (a group is ONE booking that fans
// out to per-day submissions). Lists status, checklist, queue position, and
// offers Edit / Cancel / Complete-function-form actions. The attention banner
// at the top is the follow-up surface the portal home links to — it surfaces
// every actionable item across all of the user's bookings in one place
// instead of making them scan card-by-card.
import { useCallback, useEffect, useMemo, useState } from 'react'
import PortalShell, { PortalHero, DevNotice } from '../../components/PortalShell'
import { ROOM_NAMES } from '../../lib/rooms'
import { weekdaysFromMask, type GroupSummary, type GroupStatus } from '../../lib/workflow-types'
import { cachedFetch, invalidateCache, writeCache } from '../../lib/client-cache'
import { formatTimeRange } from '../../lib/status'

const CACHE_KEY = 'my-groups'
const WEEKDAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

const FIELD_LABELS: Record<string, string> = {
  event_name: 'Event name',
  department: 'Department',
  location: 'Room(s)',
  contact_name: 'Contact name',
  email: 'Email',
  event_start: 'Start time',
  event_end: 'End time',
}

function fmtDate(iso: string): string {
  const d = new Date(`${iso}T12:00:00Z`)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
}

function weekdaySummary(mask: string): string {
  const days = weekdaysFromMask(mask)
  if (days.length === 7) return 'Every day'
  if (days.length === 5 && [1, 2, 3, 4, 5].every(d => days.includes(d))) return 'Weekdays'
  if (days.length === 2 && days.includes(0) && days.includes(6)) return 'Weekends'
  return days.map(d => WEEKDAY_NAMES[d]).join(', ')
}

// Status pill wording + tint, built from the design system's jsp-status modifiers.
function statusMeta(status: GroupStatus): { cls: string; label: string } {
  switch (status) {
    case 'confirmed': return { cls: 'jsp-status-confirmed', label: 'Confirmed' }
    case 'cancelled': return { cls: 'jsp-status-cancelled', label: 'Cancelled' }
    case 'partial_error': return { cls: 'jsp-status-alert', label: 'Needs attention' }
    default: return { cls: 'jsp-status-pending', label: 'Pending approval' } // draft, queued, creating, active
  }
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 12 12" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2.5 6.5L5 9l4.5-6" />
    </svg>
  )
}

function CrossIcon() {
  return (
    <svg viewBox="0 0 12 12" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <path d="M3 3l6 6M9 3l-6 6" />
    </svg>
  )
}

// Small checklist pill — green + check when satisfied, red + cross when not.
// Reuses the existing jsp-status modifiers (already dark-mode aware) rather
// than inventing new colors.
function ChecklistPill({ ok, label, title }: { ok: boolean; label: string; title?: string }) {
  return (
    <span title={title} className={`jsp-status ${ok ? 'jsp-status-confirmed' : 'jsp-status-alert'}`}>
      {ok ? <CheckIcon /> : <CrossIcon />}
      {label}
    </span>
  )
}

// ── Attention banner ────────────────────────────────────────────────────────
// One row per actionable item across every active booking (function form
// first, then missing event details, then failed days), capped at 3 with a
// "+N more" tail.
interface AttentionItem {
  key: string
  label: string
  description: string
  action: string
  href?: string
  onAction?: () => void
}

function AttentionRow({ item }: { item: AttentionItem }) {
  return (
    <div className="flex items-start justify-between gap-3 flex-wrap py-2">
      <p className="text-sm flex items-start gap-2.5 min-w-0">
        <span
          aria-hidden
          className="mt-[0.4rem] shrink-0"
          style={{ width: '0.4rem', height: '0.4rem', background: 'var(--jsp-red)', transform: 'rotate(45deg)', display: 'inline-block' }}
        />
        <span className="min-w-0">
          <strong className="font-semibold" style={{ color: 'var(--jsp-ink)' }}>{item.label}</strong>
          <span style={{ color: 'var(--jsp-muted)' }}> — {item.description}</span>
        </span>
      </p>
      {item.href ? (
        <a href={item.href} className="text-sm font-semibold shrink-0" style={{ color: 'var(--jsp-red)' }}>
          {item.action} →
        </a>
      ) : (
        <button type="button" onClick={item.onAction} className="text-sm font-semibold shrink-0" style={{ color: 'var(--jsp-red)' }}>
          {item.action} →
        </button>
      )}
    </div>
  )
}

function AttentionBanner({ items }: { items: AttentionItem[] }) {
  if (items.length === 0) return null
  const shown = items.slice(0, 3)
  const extra = items.length - shown.length
  return (
    <section
      className="mb-8 rounded-2xl border px-4 sm:px-5 py-1"
      style={{ background: 'rgba(240,30,55,0.07)', borderColor: 'rgba(240,30,55,0.25)' }}
    >
      {shown.map(item => <AttentionRow key={item.key} item={item} />)}
      {extra > 0 && (
        <p className="pb-2 text-xs" style={{ color: 'var(--jsp-muted)' }}>+{extra} more</p>
      )}
    </section>
  )
}

// ── Edit panel ──────────────────────────────────────────────────────────────
interface EditForm {
  event_name: string
  description: string
  event_start: string
  event_end: string
  hold_start: string
  hold_end: string
  rooms: string[]
  contact_name: string
  email: string
  phone: string
}

function editFormFrom(g: GroupSummary): EditForm {
  return {
    event_name: g.event_name ?? '',
    description: g.description ?? '',
    event_start: g.event_start ?? '',
    event_end: g.event_end ?? '',
    hold_start: g.hold_start ?? '',
    hold_end: g.hold_end ?? '',
    rooms: (g.location ?? '').split(',').map(s => s.trim()).filter(r => ROOM_NAMES.includes(r)),
    contact_name: g.contact_name ?? '',
    email: g.email ?? '',
    phone: g.phone ?? '',
  }
}

function EditPanel({
  group, search, onSaved, onClose,
}: {
  group: GroupSummary
  search: string
  onSaved: () => void
  onClose: () => void
}) {
  const [form, setForm] = useState<EditForm>(() => editFormFrom(group))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const set = (patch: Partial<EditForm>) => setForm(f => ({ ...f, ...patch }))
  const toggleRoom = (room: string) =>
    setForm(f => ({ ...f, rooms: f.rooms.includes(room) ? f.rooms.filter(r => r !== room) : [...f.rooms, room] }))

  const labelCls = 'block text-xs font-semibold mb-1'
  const labelStyle = { color: 'var(--jsp-muted)' } as const

  const save = async () => {
    setSaving(true)
    setError(null)
    try {
      const res = await fetch(`/api/groups${search ? `?${search.slice(1)}` : ''}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          group_id: group.group_id,
          event_name: form.event_name.trim(),
          description: form.description.trim() || null,
          event_start: form.event_start || null,
          event_end: form.event_end || null,
          hold_start: form.hold_start || null,
          hold_end: form.hold_end || null,
          location: form.rooms.join(', '),
          contact_name: form.contact_name.trim() || null,
          email: form.email.trim() || null,
          phone: form.phone.trim() || null,
        }),
      })
      if (!res.ok) {
        let msg = `Could not save changes (HTTP ${res.status}).`
        try {
          const j = (await res.json()) as { error?: string; message?: string }
          if (j.error || j.message) msg = j.error ?? j.message ?? msg
        } catch { /* keep default message */ }
        setError(msg)
        return
      }
      onSaved()
    } catch {
      setError('Network error — your changes were not saved. Please try again.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="jsp-card mt-4 p-5 space-y-4">
      <div>
        <label className={labelCls} style={labelStyle} htmlFor={`name-${group.group_id}`}>Event name</label>
        <input
          id={`name-${group.group_id}`}
          type="text"
          className="jsp-input"
          value={form.event_name}
          onChange={e => set({ event_name: e.target.value })}
        />
      </div>
      <div>
        <label className={labelCls} style={labelStyle} htmlFor={`desc-${group.group_id}`}>Description</label>
        <textarea
          id={`desc-${group.group_id}`}
          className="jsp-input"
          rows={3}
          value={form.description}
          onChange={e => set({ description: e.target.value })}
        />
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div>
          <label className={labelCls} style={labelStyle} htmlFor={`es-${group.group_id}`}>Event start</label>
          <input id={`es-${group.group_id}`} type="time" className="jsp-input" value={form.event_start} onChange={e => set({ event_start: e.target.value })} />
        </div>
        <div>
          <label className={labelCls} style={labelStyle} htmlFor={`ee-${group.group_id}`}>Event end</label>
          <input id={`ee-${group.group_id}`} type="time" className="jsp-input" value={form.event_end} onChange={e => set({ event_end: e.target.value })} />
        </div>
        <div>
          <label className={labelCls} style={labelStyle} htmlFor={`hs-${group.group_id}`}>Hold start</label>
          <input id={`hs-${group.group_id}`} type="time" className="jsp-input" value={form.hold_start} onChange={e => set({ hold_start: e.target.value })} />
        </div>
        <div>
          <label className={labelCls} style={labelStyle} htmlFor={`he-${group.group_id}`}>Hold end</label>
          <input id={`he-${group.group_id}`} type="time" className="jsp-input" value={form.hold_end} onChange={e => set({ hold_end: e.target.value })} />
        </div>
      </div>
      <div>
        <span className={labelCls} style={labelStyle}>Rooms</span>
        <div className="flex flex-wrap gap-2">
          {ROOM_NAMES.map(room => (
            <button
              key={room}
              type="button"
              onClick={() => toggleRoom(room)}
              className="jsp-chip"
              data-on={form.rooms.includes(room)}
            >
              {room}
            </button>
          ))}
        </div>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div>
          <label className={labelCls} style={labelStyle} htmlFor={`cn-${group.group_id}`}>Contact name</label>
          <input id={`cn-${group.group_id}`} type="text" className="jsp-input" value={form.contact_name} onChange={e => set({ contact_name: e.target.value })} />
        </div>
        <div>
          <label className={labelCls} style={labelStyle} htmlFor={`em-${group.group_id}`}>Email</label>
          <input id={`em-${group.group_id}`} type="email" className="jsp-input" value={form.email} onChange={e => set({ email: e.target.value })} />
        </div>
        <div>
          <label className={labelCls} style={labelStyle} htmlFor={`ph-${group.group_id}`}>Phone</label>
          <input id={`ph-${group.group_id}`} type="tel" className="jsp-input" value={form.phone} onChange={e => set({ phone: e.target.value })} />
        </div>
      </div>
      {error && (
        <div
          className="rounded-xl border px-3 py-2 text-sm"
          style={{ color: 'var(--jsp-red)', borderColor: 'rgba(240,30,55,0.3)', background: 'rgba(240,30,55,0.06)' }}
        >
          {error}
        </div>
      )}
      <div className="flex flex-col sm:flex-row gap-2">
        <button type="button" onClick={save} disabled={saving || !form.event_name.trim()} className="jsp-btn">
          {saving ? 'Saving…' : 'Save changes'}
        </button>
        <button type="button" onClick={onClose} disabled={saving} className="jsp-btn-ghost">
          Close
        </button>
      </div>
    </div>
  )
}

// ── Inline cancel confirmation (no modal) ───────────────────────────────────
function CancelPanel({
  group, cancelling, onConfirm, onClose,
}: {
  group: GroupSummary
  cancelling: boolean
  onConfirm: () => void
  onClose: () => void
}) {
  return (
    <div className="jsp-card mt-4 p-5 space-y-3" style={{ borderColor: 'rgba(240,30,55,0.3)' }}>
      <p className="jsp-kicker">Cancel booking</p>
      <p className="text-base font-semibold" style={{ color: 'var(--jsp-ink)' }}>
        Cancel &ldquo;{group.event_name}&rdquo;?
      </p>
      <ul className="text-sm space-y-1 list-disc list-inside" style={{ color: 'var(--jsp-muted)' }}>
        <li>Every held date in this booking is released</li>
        <li>The box office is notified of the cancellation</li>
      </ul>
      <p className="text-sm" style={{ color: 'var(--jsp-muted)' }}>
        You can always submit a new booking later.
      </p>
      <div className="flex flex-col sm:flex-row gap-2 pt-1">
        <button type="button" onClick={onConfirm} disabled={cancelling} className="jsp-btn">
          {cancelling ? 'Cancelling…' : 'Cancel booking'}
        </button>
        <button type="button" onClick={onClose} disabled={cancelling} className="jsp-btn-ghost">
          Keep booking
        </button>
      </div>
    </div>
  )
}

// ── Booking card ─────────────────────────────────────────────────────────────
function BookingCard({
  id, group: g, search, editing, cancelling, confirmingCancel, attachmentCount,
  onToggleEdit, onRequestCancel, onCloseCancel, onConfirmCancel, onSaved,
}: {
  id: string
  group: GroupSummary
  search: string
  editing: boolean
  cancelling: boolean
  confirmingCancel: boolean
  attachmentCount: number
  onToggleEdit: () => void
  onRequestCancel: () => void
  onCloseCancel: () => void
  onConfirmCancel: () => void
  onSaved: () => void
}) {
  const singleDay = g.date_from === g.date_to
  const missing = g.missing_fields ?? []
  const functionFormHref = `/function-form?group=${encodeURIComponent(g.group_id)}${search ? `&${search.slice(1)}` : ''}`
  const isCancelled = g.status === 'cancelled'
  const daysOk = g.days_done === g.days_total && g.days_failed === 0
  const daysBad = g.days_failed > 0
  const status = statusMeta(g.status)

  const metaParts = [
    singleDay ? fmtDate(g.date_from) : `${fmtDate(g.date_from)} – ${fmtDate(g.date_to)} · ${weekdaySummary(g.weekday_mask)}`,
    formatTimeRange(g.event_start, g.event_end),
    ...(g.location ? [g.location] : []),
    `${g.days_total} day${g.days_total === 1 ? '' : 's'}`,
  ]

  return (
    <div id={id} className="jsp-card p-5 sm:p-6 space-y-4">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <h2 className="jsp-display text-lg break-words">{g.event_name}</h2>
        <span className={`jsp-status ${status.cls} shrink-0`}>{status.label}</span>
      </div>

      <p className="text-sm" style={{ color: 'var(--jsp-muted)' }}>
        {metaParts.join(' · ')}
      </p>

      {g.competing_ahead > 0 && (
        <span
          title="Bookings are first-come-first-served: earlier requests for the same room and dates are processed before yours."
          className="jsp-status jsp-status-pending w-fit cursor-help"
        >
          {g.competing_ahead} ahead of you
        </span>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <ChecklistPill
          ok={missing.length === 0}
          label={missing.length === 0 ? 'Event details complete' : `${missing.length} field${missing.length === 1 ? '' : 's'} missing`}
          title={missing.length > 0 ? `Missing: ${missing.map(f => FIELD_LABELS[f] ?? f).join(', ')}` : undefined}
        />
        <ChecklistPill
          ok={g.function_form_complete}
          label={g.function_form_complete ? 'Function form on file' : 'Function form required'}
        />
        {attachmentCount > 0 && (
          <span className="text-xs" style={{ color: 'var(--jsp-muted)' }}>
            {attachmentCount} attachment{attachmentCount === 1 ? '' : 's'}
          </span>
        )}
        <ChecklistPill
          ok={daysOk}
          label={daysBad ? `${g.days_failed} of ${g.days_total} days failed` : `${g.days_done}/${g.days_total} days created`}
        />
      </div>

      <div className="flex flex-col sm:flex-row flex-wrap gap-2">
        {/* Function-form link is always present — label follows completeness. */}
        <a
          href={functionFormHref}
          className={`inline-flex items-center justify-center ${g.function_form_complete ? 'jsp-btn-ghost' : 'jsp-btn'}`}
        >
          {g.function_form_complete ? 'View function form' : 'Complete function form'}
        </a>
        {!isCancelled && (
          <>
            <button type="button" onClick={onToggleEdit} className="jsp-btn-ghost">
              {editing ? 'Close editor' : 'Edit'}
            </button>
            <button
              type="button"
              onClick={onRequestCancel}
              disabled={cancelling}
              className="jsp-btn-ghost"
              style={{ color: 'var(--jsp-red)' }}
            >
              {cancelling ? 'Cancelling…' : 'Cancel booking'}
            </button>
          </>
        )}
      </div>

      {editing && !isCancelled && (
        <EditPanel group={g} search={search} onSaved={onSaved} onClose={onToggleEdit} />
      )}
      {confirmingCancel && !isCancelled && (
        <CancelPanel group={g} cancelling={cancelling} onConfirm={onConfirmCancel} onClose={onCloseCancel} />
      )}
    </div>
  )
}

export default function MyBookingsPage() {
  // window.location.search, captured after mount (null = not mounted yet).
  // Passed through to every API call so the ?as= dev identity override works.
  const [search, setSearch] = useState<string | null>(null)
  const [groups, setGroups] = useState<GroupSummary[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [cancelling, setCancelling] = useState<string | null>(null)
  const [confirmingCancel, setConfirmingCancel] = useState<string | null>(null)
  const [attachmentCounts, setAttachmentCounts] = useState<Record<string, number>>({})

  useEffect(() => {
    setSearch(window.location.search)
  }, [])

  const passthru = useCallback(
    (base: string) => `${base}${search ? `&${search.slice(1)}` : ''}`,
    [search],
  )

  // Cached, instant-render load: the last snapshot (if any) renders right
  // away while a fresh copy is fetched in the background via onFresh.
  const load = useCallback(async () => {
    if (search === null) return
    const url = passthru('/api/groups?mine=1')
    const result = await cachedFetch<{ groups: GroupSummary[] }>(CACHE_KEY, url, fresh => {
      setGroups(fresh.groups ?? [])
      setLoadError(null)
    })
    if (result) {
      setGroups(result.groups ?? [])
      setLoadError(null)
    } else {
      setLoadError('Could not load your bookings. Check your connection and try again.')
      setGroups(g => g ?? [])
    }
  }, [search, passthru])

  useEffect(() => { load() }, [load])

  // Live progress: poll every 4s while any group is still being set up.
  // Polling is always fresh, so it bypasses the SWR cache — just fetch and
  // set state directly, keeping the cached snapshot warm for next time.
  const anyInFlight = (groups ?? []).some(g => g.status === 'queued' || g.status === 'creating')
  const pollRefresh = useCallback(async () => {
    if (search === null) return
    try {
      const res = await fetch(passthru('/api/groups?mine=1'))
      if (!res.ok) return
      const j = (await res.json()) as { groups: GroupSummary[] }
      setGroups(j.groups ?? [])
      writeCache(CACHE_KEY, j)
    } catch { /* transient poll error, ignore — next tick retries */ }
  }, [search, passthru])

  useEffect(() => {
    if (!anyInFlight) return
    const t = setInterval(pollRefresh, 4000)
    return () => clearInterval(t)
  }, [anyInFlight, pollRefresh])

  // Attachment counts, one small line per card when > 0. Fetched in a single
  // batch (Promise.all) once per distinct set of group ids, rather than a
  // per-card waterfall or a re-fetch on every 4s status poll.
  const groupIdsKey = useMemo(() => (groups ?? []).map(g => g.group_id).join(','), [groups])
  useEffect(() => {
    if (search === null || !groupIdsKey) return
    const ids = groupIdsKey.split(',')
    let cancelled = false
    Promise.all(
      ids.map(async id => {
        try {
          const res = await fetch(passthru(`/api/function-form/attachments?group=${encodeURIComponent(id)}`))
          if (!res.ok) return [id, 0] as const
          const j = (await res.json()) as { attachments?: unknown[] }
          return [id, j.attachments?.length ?? 0] as const
        } catch {
          return [id, 0] as const
        }
      }),
    ).then(entries => {
      if (!cancelled) setAttachmentCounts(prev => ({ ...prev, ...Object.fromEntries(entries) }))
    })
    return () => { cancelled = true }
  }, [groupIdsKey, search, passthru])

  const onSaved = useCallback(() => {
    setEditing(null)
    invalidateCache(CACHE_KEY)
    load()
  }, [load])

  const confirmCancel = async () => {
    const g = (groups ?? []).find(x => x.group_id === confirmingCancel)
    if (!g) { setConfirmingCancel(null); return }
    setCancelling(g.group_id)
    // Optimistic: show it cancelled right away, then refresh from the server.
    setGroups(gs => (gs ?? []).map(x => (x.group_id === g.group_id ? { ...x, status: 'cancelled' as GroupStatus } : x)))
    try {
      const res = await fetch(`/api/groups/cancel${search ? `?${search.slice(1)}` : ''}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ group_id: g.group_id }),
      })
      if (!res.ok) {
        let msg = `Cancel failed (HTTP ${res.status}).`
        try {
          const j = (await res.json()) as { error?: string }
          if (j.error) msg = j.error
        } catch { /* keep default message */ }
        window.alert(msg)
      }
    } catch {
      window.alert('Network error — the cancellation may not have gone through.')
    } finally {
      setCancelling(null)
      setConfirmingCancel(null)
      invalidateCache(CACHE_KEY)
      load()
    }
  }

  const scrollToBooking = (groupId: string) => {
    document.getElementById(`booking-${groupId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }
  const focusEdit = (groupId: string) => {
    setEditing(groupId)
    requestAnimationFrame(() => scrollToBooking(groupId))
  }

  const functionFormHref = useCallback((g: GroupSummary) =>
    `/function-form?group=${encodeURIComponent(g.group_id)}${search ? `&${search.slice(1)}` : ''}`, [search])

  // Every actionable item across all (non-cancelled) bookings, aggregated for
  // the attention banner: function form first, then missing details, then
  // any days that failed to create.
  const activeGroups = (groups ?? []).filter(g => g.status !== 'cancelled')
  const attentionItems: AttentionItem[] = []
  for (const g of activeGroups) {
    if (!g.function_form_complete) {
      attentionItems.push({
        key: `${g.group_id}-form`,
        label: 'Function form required',
        description: `the box office needs these details before ${g.event_name} can run.`,
        action: 'Complete form',
        href: functionFormHref(g),
      })
    }
  }
  for (const g of activeGroups) {
    const missing = g.missing_fields ?? []
    if (missing.length > 0) {
      attentionItems.push({
        key: `${g.group_id}-missing`,
        label: 'Event details incomplete',
        description: `${g.event_name} is missing ${missing.map(f => FIELD_LABELS[f] ?? f).join(', ')}.`,
        action: 'Edit',
        onAction: () => focusEdit(g.group_id),
      })
    }
  }
  for (const g of activeGroups) {
    if (g.days_failed > 0) {
      attentionItems.push({
        key: `${g.group_id}-failed`,
        label: 'Some days failed to create',
        description: `${g.event_name} — ${g.days_failed} of ${g.days_total} day${g.days_total === 1 ? '' : 's'} failed. Contact IT if this doesn't resolve on its own.`,
        action: 'View',
        onAction: () => scrollToBooking(g.group_id),
      })
    }
  }

  return (
    <PortalShell active="my">
      <DevNotice />
      <PortalHero
        kicker="MY BOOKINGS"
        title="Your requests"
        lede="Track, edit, or cancel — and see what still needs attention."
      />

      {groups === null && !loadError && (
        <p className="text-sm" style={{ color: 'var(--jsp-muted)' }}>Loading your bookings…</p>
      )}

      {loadError && (
        <div
          className="jsp-card px-4 py-3 mb-6 text-sm flex items-center justify-between gap-3"
          style={{ color: 'var(--jsp-red)' }}
        >
          <span>{loadError}</span>
          <button type="button" onClick={load} className="jsp-btn-ghost shrink-0">Retry</button>
        </div>
      )}

      {groups !== null && groups.length === 0 && !loadError && (
        <div className="jsp-card text-center py-16 px-6">
          <h2 className="jsp-display text-xl">No bookings yet</h2>
          <p className="mt-2 text-sm" style={{ color: 'var(--jsp-muted)' }}>
            When you book a space, it will show up here with live status.
          </p>
          <a href={`/submit${search ?? ''}`} className="jsp-btn mt-6 inline-flex items-center justify-center">
            Book a Space
          </a>
        </div>
      )}

      {groups !== null && groups.length > 0 && (
        <>
          <AttentionBanner items={attentionItems} />

          <div className="space-y-4">
            {groups.map(g => (
              <BookingCard
                key={g.group_id}
                id={`booking-${g.group_id}`}
                group={g}
                search={search ?? ''}
                editing={editing === g.group_id}
                cancelling={cancelling === g.group_id}
                confirmingCancel={confirmingCancel === g.group_id}
                attachmentCount={attachmentCounts[g.group_id] ?? 0}
                onToggleEdit={() => setEditing(e => (e === g.group_id ? null : g.group_id))}
                onRequestCancel={() => setConfirmingCancel(g.group_id)}
                onCloseCancel={() => setConfirmingCancel(null)}
                onConfirmCancel={confirmCancel}
                onSaved={onSaved}
              />
            ))}
          </div>
        </>
      )}
    </PortalShell>
  )
}
