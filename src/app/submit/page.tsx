'use client'

// Book a Space — the flagship 4-step booking wizard for Booking Workflow v2.
// A single state object drives all steps so Back never loses anything; on
// submit it POSTs /api/groups (contract in src/lib/workflow-types.ts) and then
// polls GET /api/groups?id= to show the per-day fan-out live.
import { useEffect, useMemo, useState } from 'react'
import PortalShell, { DevNotice } from '../../components/PortalShell'
import { expandGroupDates } from '../../lib/workflow-types'
import type { CreateGroupRequest, GroupSummary, SubmissionJob } from '../../lib/workflow-types'
import { ROOM_NAMES } from '../../lib/rooms'
import { DEPT_LEGEND } from '../../lib/departments'
import { formatTime12 } from '../../lib/status'
import { cachedFetch, invalidateCache } from '../../lib/client-cache'
import {
  Chip, ExpansionStrip, Field, FooterRow, ProgressBar, ReviewRow, StepHeading, Stepper,
} from './parts'

const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const ALL_WEEKDAYS = [0, 1, 2, 3, 4, 5, 6]
const DEFAULT_EMAIL = 'it@japansociety.org'
// Canonical department values (departments.ts keeps DEPT_LEGEND in sync with
// the house color sheet / JotForm's Department field).
const DEPARTMENTS = DEPT_LEGEND.map(d => d.dept)

type Mode = 'single' | 'range'

interface FormState {
  event_name: string
  department: string
  description: string
  count: string          // raw input; parsed on submit
  mode: Mode
  date_from: string
  date_to: string
  weekdays: number[]     // 0=Sun..6=Sat, used in range mode
  event_start: string
  event_end: string
  hold_start: string
  hold_end: string
  doors_open: string
  check_in_time: string
  run_time: string
  locations: string[]
  contact_name: string
  email: string
  phone: string
}

const EMPTY_FORM: FormState = {
  event_name: '', department: '', description: '', count: '',
  mode: 'single', date_from: '', date_to: '', weekdays: [1, 2, 3, 4, 5],
  event_start: '', event_end: '',
  hold_start: '', hold_end: '', doors_open: '', check_in_time: '', run_time: '',
  locations: [], contact_name: '', email: '', phone: '',
}

// "2026-10-03" -> "Oct 3"
function fmtShort(iso: string): string {
  const d = new Date(`${iso}T12:00:00Z`)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
}

// "2026-10-03" -> "Sat, Oct 3, 2026"
function fmtDay(iso: string): string {
  const d = new Date(`${iso}T12:00:00Z`)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleDateString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC',
  })
}

// Exact matching-day count (early-out just past the 366 cap) so we can tell a
// too-long booking apart from one expandGroupDates would silently truncate.
function countMatchingDays(from: string, to: string, weekdays: number[]): number {
  const d = new Date(`${from}T12:00:00Z`)
  const endMs = new Date(`${to}T12:00:00Z`).getTime()
  if (Number.isNaN(d.getTime()) || Number.isNaN(endMs)) return 0
  const set = new Set(weekdays)
  let n = 0
  let guard = 0
  while (d.getTime() <= endMs && guard < 5000) {
    if (set.has(d.getUTCDay())) {
      n++
      if (n > 366) return n
    }
    d.setUTCDate(d.getUTCDate() + 1)
    guard++
  }
  return n
}

function step1Errors(f: FormState): Record<string, string> {
  const e: Record<string, string> = {}
  if (!f.event_name.trim()) e.event_name = 'Give the event a name.'
  if (!f.department) e.department = 'Pick a department.'
  if (f.count.trim()) {
    const n = Number(f.count)
    if (!Number.isInteger(n) || n < 1) e.count = 'Expected count must be a whole number, 1 or more.'
  }
  return e
}

function step2Errors(f: FormState): Record<string, string> {
  const e: Record<string, string> = {}
  if (!f.date_from) e.date_from = f.mode === 'range' ? 'Pick the first day.' : 'Pick a date.'
  if (f.mode === 'range') {
    if (!f.date_to) e.date_to = 'Pick the last day.'
    else if (f.date_from && f.date_to < f.date_from) e.date_to = "The last day can't be before the first day."
    if (f.weekdays.length === 0) e.weekdays = 'Pick at least one weekday.'
  }
  if (!f.event_start) e.event_start = 'Pick a start time.'
  if (!f.event_end) e.event_end = 'Pick an end time.'
  else if (f.event_start && f.event_end <= f.event_start) e.event_end = 'The end time must be after the start time.'
  if (Object.keys(e).length === 0) {
    const to = f.mode === 'single' ? f.date_from : f.date_to
    const wds = f.mode === 'single' ? ALL_WEEKDAYS : f.weekdays
    const n = countMatchingDays(f.date_from, to, wds)
    if (n === 0) e.days = 'No days in this range match the weekdays you picked.'
    else if (n > 366) e.days = 'That adds up to more than 366 days — please book a shorter range.'
  }
  return e
}

function step3Errors(f: FormState): Record<string, string> {
  const e: Record<string, string> = {}
  if (f.locations.length === 0) e.locations = 'Pick at least one room.'
  if (!f.contact_name.trim()) e.contact_name = 'Enter a contact name.'
  if (!f.email.trim() || !/^[^@\s]+@[^@\s]+$/.test(f.email.trim())) e.email = 'Enter a valid email address.'
  return e
}

interface PollResponse {
  group?: Partial<GroupSummary>
  jobs?: SubmissionJob[]
  queue_position?: number
  competing_ahead?: number
}

export default function SubmitPage() {
  const [asParam, setAsParam] = useState<string | null>(null)

  const [step, setStep] = useState(1)
  const [form, setForm] = useState<FormState>(EMPTY_FORM)
  const [touched, setTouched] = useState<Record<string, boolean>>({})
  const [showMoreTimes, setShowMoreTimes] = useState(false)

  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState('')
  const [submitted, setSubmitted] = useState<{ group_id: string; days_total: number } | null>(null)
  const [progress, setProgress] = useState({ done: 0, failed: 0, total: 0, competing_ahead: 0 })
  const [pollDone, setPollDone] = useState(false)

  const touch = (k: string) => setTouched(t => (t[k] ? t : { ...t, [k]: true }))
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => {
    setForm(f => ({ ...f, [k]: v }))
    touch(k as string)
  }

  // Read the dev-identity override and prefill contact fields from the
  // requester's most recent booking. The GET goes through cachedFetch — a
  // cached snapshot (if any) paints immediately and the fresh copy replaces
  // it in the background.
  useEffect(() => {
    let cancelled = false
    let as: string | null = null
    try { as = new URLSearchParams(window.location.search).get('as') } catch { /* no-op */ }
    if (as) setAsParam(as)
    const q = as ? `&as=${encodeURIComponent(as)}` : ''

    void (async () => {
      const applyPrefill = (j: { groups?: GroupSummary[] }) => {
        if (cancelled) return
        const g = j.groups?.[0]
        setForm(f => ({
          ...f,
          contact_name: f.contact_name || g?.contact_name || '',
          email: f.email || g?.email || as || DEFAULT_EMAIL,
          phone: f.phone || g?.phone || '',
        }))
      }
      const snapshot = await cachedFetch<{ groups?: GroupSummary[] }>(
        'my-groups-prefill', `/api/groups?mine=1${q}`, applyPrefill,
      )
      if (snapshot !== null) applyPrefill(snapshot)
      else if (!cancelled) setForm(f => ({ ...f, email: f.email || as || DEFAULT_EMAIL }))
    })()

    return () => { cancelled = true }
  }, [])

  // Effective range + weekdays (single day = the whole week mask over one day).
  const effTo = form.mode === 'single' ? form.date_from : form.date_to
  const effWeekdays = form.mode === 'single' ? ALL_WEEKDAYS : form.weekdays
  const days = useMemo(() => {
    if (!form.date_from || !effTo || effTo < form.date_from) return []
    return expandGroupDates(form.date_from, effTo, effWeekdays)
  }, [form.date_from, effTo, effWeekdays])

  const previewText = useMemo(() => {
    if (days.length === 0) return ''
    const first = days.slice(0, 3).map(fmtShort)
    const weekdayLabel = form.mode === 'range' && form.weekdays.length > 0 && form.weekdays.length < 7
      ? ` · ${form.weekdays.map(i => WEEKDAY_LABELS[i]).join('–')}`
      : ''
    if (days.length === 1) return `1 day · ${fmtDay(days[0])}`
    if (days.length <= 3) return `${days.length} days${weekdayLabel} · ${first.join(', ')}`
    return `${days.length} days${weekdayLabel} · ${fmtShort(days[0])} – ${fmtShort(days[days.length - 1])}`
  }, [days, form.mode, form.weekdays])

  const errors = useMemo<Record<string, string>>(() => {
    if (step === 1) return step1Errors(form)
    if (step === 2) return step2Errors(form)
    if (step === 3) return step3Errors(form)
    return {}
  }, [step, form])
  const stepValid = Object.keys(errors).length === 0
  const allValid =
    Object.keys(step1Errors(form)).length === 0 &&
    Object.keys(step2Errors(form)).length === 0 &&
    Object.keys(step3Errors(form)).length === 0
  const err = (k: string) => (touched[k] ? errors[k] : undefined)

  const goNext = () => {
    if (!stepValid) return
    setStep(s => Math.min(4, s + 1))
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }
  const goBack = (to?: number) => {
    setStep(s => Math.max(1, to ?? s - 1))
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  const toggleRoom = (name: string) => {
    setForm(f => ({
      ...f,
      locations: f.locations.includes(name)
        ? f.locations.filter(r => r !== name)
        : [...f.locations, name],
    }))
    touch('locations')
  }
  const toggleWeekday = (i: number) => {
    setForm(f => ({
      ...f,
      weekdays: f.weekdays.includes(i)
        ? f.weekdays.filter(w => w !== i)
        : [...f.weekdays, i].sort((a, b) => a - b),
    }))
    touch('weekdays')
  }

  const handleSubmit = async () => {
    if (!allValid || submitting) return
    setSubmitting(true)
    setSubmitError('')
    const body: CreateGroupRequest = {
      event_name: form.event_name.trim(),
      department: form.department,
      locations: form.locations,
      contact_name: form.contact_name.trim(),
      email: form.email.trim(),
      date_from: form.date_from,
      date_to: effTo,
      weekdays: effWeekdays,
    }
    if (form.description.trim()) body.description = form.description.trim()
    if (form.phone.trim()) body.phone = form.phone.trim()
    if (form.count.trim() && Number.isInteger(Number(form.count))) body.count = Number(form.count)
    if (form.event_start) body.event_start = form.event_start
    if (form.event_end) body.event_end = form.event_end
    if (form.hold_start) body.hold_start = form.hold_start
    if (form.hold_end) body.hold_end = form.hold_end
    if (form.doors_open) body.doors_open = form.doors_open
    if (form.check_in_time) body.check_in_time = form.check_in_time
    if (form.run_time.trim()) body.run_time = form.run_time.trim()
    try {
      const res = await fetch(`/api/groups${asParam ? `?as=${encodeURIComponent(asParam)}` : ''}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        let msg = `The booking could not be submitted (error ${res.status}). Please try again.`
        try {
          const j = await res.json() as { error?: string }
          if (j.error) msg = j.error
        } catch { /* keep the generic message */ }
        throw new Error(msg)
      }
      const j = await res.json() as { group_id: string; days: string[]; jobs: number }
      invalidateCache('my-groups')
      setProgress({ done: 0, failed: 0, total: j.days?.length ?? days.length, competing_ahead: 0 })
      setSubmitted({ group_id: j.group_id, days_total: j.days?.length ?? days.length })
      window.scrollTo({ top: 0 })
    } catch (e) {
      setSubmitError(e instanceof Error ? e.message : 'Something went wrong — please try again.')
    } finally {
      setSubmitting(false)
    }
  }

  // Live progress: poll the group every 1.5s until every day job settled.
  // This is already-fresh data by nature (it's a live in-flight status), so
  // it stays a plain fetch rather than going through the snapshot cache.
  useEffect(() => {
    if (!submitted || pollDone) return
    let stopped = false
    let inFlight = false
    const tick = async () => {
      if (inFlight) return
      inFlight = true
      try {
        const res = await fetch(
          `/api/groups?id=${encodeURIComponent(submitted.group_id)}${asParam ? `&as=${encodeURIComponent(asParam)}` : ''}`,
        )
        if (!res.ok) return
        const j = await res.json() as PollResponse
        if (stopped) return
        const eventJobs = (j.jobs ?? []).filter(x => x.form === 'event' && x.action === 'create')
        let total = eventJobs.length
        let done = eventJobs.filter(x => x.state === 'done').length
        let failed = eventJobs.filter(x => x.state === 'failed').length
        if (total === 0 && typeof j.group?.days_total === 'number') {
          total = j.group.days_total
          done = j.group.days_done ?? 0
          failed = j.group.days_failed ?? 0
        }
        if (total === 0) total = submitted.days_total
        const competing_ahead = j.competing_ahead ?? j.group?.competing_ahead ?? j.queue_position ?? j.group?.queue_position ?? 0
        setProgress({ done, failed, total, competing_ahead })
        if (total > 0 && done + failed >= total) setPollDone(true)
      } catch { /* transient — keep polling */ } finally {
        inFlight = false
      }
    }
    tick()
    const iv = setInterval(tick, 1500)
    return () => { stopped = true; clearInterval(iv) }
  }, [submitted, pollDone, asParam])

  const asSuffix = asParam ? `&as=${encodeURIComponent(asParam)}` : ''
  const asOnly = asParam ? `?as=${encodeURIComponent(asParam)}` : ''
  const processed = progress.done + progress.failed
  const percent = progress.total > 0 ? (processed / progress.total) * 100 : 0

  const dash = '—'
  const whenText = form.mode === 'single'
    ? (form.date_from ? fmtDay(form.date_from) : dash)
    : `${form.date_from ? fmtDay(form.date_from) : dash} – ${form.date_to ? fmtDay(form.date_to) : dash} · ${
        form.weekdays.map(i => WEEKDAY_LABELS[i]).join(', ') || 'no weekdays'}`
  const reviewRows: { label: string; value: string }[] = [
    { label: 'Event name', value: form.event_name.trim() || dash },
    { label: 'Department', value: form.department || dash },
    { label: 'Expected count', value: form.count.trim() || dash },
    { label: 'Description', value: form.description.trim() || dash },
    { label: 'When', value: whenText },
    { label: 'Event time', value: form.event_start && form.event_end ? `${formatTime12(form.event_start)} – ${formatTime12(form.event_end)}` : dash },
    { label: 'Hold', value: form.hold_start || form.hold_end ? `${formatTime12(form.hold_start) || dash} – ${formatTime12(form.hold_end) || dash}` : dash },
    { label: 'Doors open', value: form.doors_open ? formatTime12(form.doors_open) : dash },
    { label: 'Check-in', value: form.check_in_time ? formatTime12(form.check_in_time) : dash },
    { label: 'Run time', value: form.run_time.trim() || dash },
    { label: 'Rooms', value: form.locations.join(', ') || dash },
    { label: 'Contact', value: form.contact_name.trim() || dash },
    { label: 'Email', value: form.email.trim() || dash },
    { label: 'Phone', value: form.phone.trim() || dash },
  ]

  const primaryLabel = step < 4
    ? 'Next'
    : (submitting ? 'Submitting…' : `Submit request${days.length > 1 ? ` (${days.length} days)` : ''}`)
  const primaryDisabled = step < 4 ? !stepValid : (!allValid || submitting)

  return (
    <PortalShell active="book">
      <DevNotice />

      <div className="max-w-2xl mx-auto">
        {submitted ? (
          <div className="jsp-card p-6 sm:p-8 text-center">
            <p className="jsp-kicker">Booking submitted</p>
            <h1 className="jsp-display text-2xl sm:text-3xl mt-2">Request received</h1>
            <p className="mt-3 text-xs uppercase tracking-wider" style={{ color: 'var(--jsp-muted)' }}>
              Booking reference
            </p>
            <p className="mt-1 font-mono text-lg tracking-widest" style={{ color: 'var(--jsp-red)' }}>
              {submitted.group_id.slice(0, 8)}
            </p>
            <p className="mt-1 text-xs" style={{ color: 'var(--jsp-muted)' }}>
              Keep this handy — it also appears in My Bookings.
            </p>

            {progress.competing_ahead > 0 && (
              <p className="mt-5 text-sm font-medium" style={{ color: '#8A6410' }}>
                {progress.competing_ahead} request{progress.competing_ahead === 1 ? '' : 's'} ahead of you for these dates.
              </p>
            )}

            <div className="mt-6 text-left">
              <div className="flex items-baseline justify-between mb-2">
                <span className="text-sm font-medium" style={{ color: 'var(--jsp-ink)' }}>
                  {pollDone ? 'Daily bookings created' : `Creating ${processed} of ${progress.total} days…`}
                </span>
                <span className="text-sm tabular-nums" style={{ color: 'var(--jsp-muted)' }}>
                  {processed} / {progress.total}
                </span>
              </div>
              <ProgressBar percent={percent} />
              <p className="mt-2 text-xs" style={{ color: 'var(--jsp-muted)' }}>
                {pollDone
                  ? progress.failed > 0
                    ? `${progress.done} booked, ${progress.failed} hit a problem — the team will take a look.`
                    : `All ${progress.total} day${progress.total === 1 ? ' is' : 's are'} in.`
                  : 'Working through your dates — this updates automatically.'}
              </p>
            </div>

            <div className="mt-7 flex flex-col gap-3">
              <a
                href={`/function-form?group=${encodeURIComponent(submitted.group_id)}${asSuffix}`}
                className="jsp-btn w-full"
              >
                Complete the function form
              </a>
              <a href={`/my${asOnly}`} className="jsp-btn-ghost w-full">
                Go to My Bookings
              </a>
            </div>
          </div>
        ) : (
          <>
            <div className="text-center mb-8">
              <p className="jsp-kicker">Book a space</p>
              <h1 className="jsp-display text-3xl sm:text-4xl mt-2">New booking request</h1>
              <p className="mt-3 text-sm sm:text-base max-w-lg mx-auto" style={{ color: 'var(--jsp-muted)' }}>
                One request can cover a single day or a whole series.
              </p>
            </div>

            <Stepper step={step} onJump={goBack} />

            <div className="jsp-card p-6 sm:p-8">
              {step === 1 && (
                <>
                  <StepHeading title="Event details" subtitle="What are you booking space for?" />
                  <div className="flex flex-col gap-5">
                    <Field label="Event name" error={err('event_name')}>
                      <input
                        type="text"
                        value={form.event_name}
                        onChange={e => set('event_name', e.target.value)}
                        onBlur={() => touch('event_name')}
                        placeholder="e.g. Spring Gala Rehearsal"
                        className="jsp-input"
                      />
                    </Field>
                    <Field label="Department" error={err('department')}>
                      <div className="flex flex-wrap gap-2">
                        {DEPARTMENTS.map(d => (
                          <Chip key={d} active={form.department === d} onClick={() => set('department', d)}>
                            {d}
                          </Chip>
                        ))}
                      </div>
                    </Field>
                    <Field label="Expected head count" error={err('count')} hint="Optional.">
                      <input
                        type="number"
                        inputMode="numeric"
                        min={1}
                        value={form.count}
                        onChange={e => set('count', e.target.value)}
                        onBlur={() => touch('count')}
                        placeholder="e.g. 120"
                        className="jsp-input"
                      />
                    </Field>
                    <Field label="Description" hint="Optional — anything the operations team should know.">
                      <textarea
                        value={form.description}
                        onChange={e => set('description', e.target.value)}
                        rows={3}
                        placeholder="Setup notes, purpose, special requirements…"
                        className="jsp-input"
                      />
                    </Field>
                  </div>
                </>
              )}

              {step === 2 && (
                <>
                  <StepHeading title="Dates & times" subtitle="One day, or a repeating series across a range." />
                  <div className="flex flex-col gap-5">
                    <Field label="When">
                      <div className="flex flex-wrap gap-2">
                        <Chip active={form.mode === 'single'} onClick={() => set('mode', 'single')}>Single day</Chip>
                        <Chip active={form.mode === 'range'} onClick={() => set('mode', 'range')}>Date range</Chip>
                      </div>
                    </Field>

                    {form.mode === 'single' ? (
                      <Field label="Date" error={err('date_from')}>
                        <input
                          type="date"
                          value={form.date_from}
                          onChange={e => set('date_from', e.target.value)}
                          onBlur={() => touch('date_from')}
                          className="jsp-input"
                        />
                      </Field>
                    ) : (
                      <>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                          <Field label="First day" error={err('date_from')}>
                            <input
                              type="date"
                              value={form.date_from}
                              onChange={e => set('date_from', e.target.value)}
                              onBlur={() => touch('date_from')}
                              className="jsp-input"
                            />
                          </Field>
                          <Field label="Last day" error={err('date_to')}>
                            <input
                              type="date"
                              value={form.date_to}
                              onChange={e => set('date_to', e.target.value)}
                              onBlur={() => touch('date_to')}
                              className="jsp-input"
                            />
                          </Field>
                        </div>
                        <Field label="On these weekdays" error={err('weekdays')}>
                          <div className="flex flex-wrap gap-2">
                            {WEEKDAY_LABELS.map((label, i) => (
                              <Chip key={label} active={form.weekdays.includes(i)} onClick={() => toggleWeekday(i)}>
                                {label}
                              </Chip>
                            ))}
                          </div>
                        </Field>
                      </>
                    )}

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      <Field label="Event start" error={err('event_start')}>
                        <input
                          type="time"
                          value={form.event_start}
                          onChange={e => set('event_start', e.target.value)}
                          onBlur={() => touch('event_start')}
                          className="jsp-input"
                        />
                      </Field>
                      <Field label="Event end" error={err('event_end')}>
                        <input
                          type="time"
                          value={form.event_end}
                          onChange={e => set('event_end', e.target.value)}
                          onBlur={() => touch('event_end')}
                          className="jsp-input"
                        />
                      </Field>
                    </div>

                    <div>
                      <button
                        type="button"
                        onClick={() => setShowMoreTimes(s => !s)}
                        aria-expanded={showMoreTimes}
                        className="text-sm font-semibold"
                        style={{ color: 'var(--jsp-red)' }}
                      >
                        {showMoreTimes ? 'Fewer times' : 'More times'}
                        {!showMoreTimes && (
                          <span className="ml-1.5 font-normal" style={{ color: 'var(--jsp-muted)' }}>
                            — hold, doors, check-in, run time
                          </span>
                        )}
                      </button>
                      {showMoreTimes && (
                        <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-4">
                          <Field label="Hold start" hint="When the space itself is reserved.">
                            <input type="time" value={form.hold_start}
                              onChange={e => set('hold_start', e.target.value)} className="jsp-input" />
                          </Field>
                          <Field label="Hold end">
                            <input type="time" value={form.hold_end}
                              onChange={e => set('hold_end', e.target.value)} className="jsp-input" />
                          </Field>
                          <Field label="Doors open">
                            <input type="time" value={form.doors_open}
                              onChange={e => set('doors_open', e.target.value)} className="jsp-input" />
                          </Field>
                          <Field label="Check-in">
                            <input type="time" value={form.check_in_time}
                              onChange={e => set('check_in_time', e.target.value)} className="jsp-input" />
                          </Field>
                          <Field label="Run time">
                            <input type="text" value={form.run_time} placeholder="e.g. 90 min"
                              onChange={e => set('run_time', e.target.value)} className="jsp-input" />
                          </Field>
                        </div>
                      )}
                    </div>

                    {errors.days ? (
                      <p className="text-xs" style={{ color: 'var(--jsp-red)' }}>{errors.days}</p>
                    ) : previewText ? (
                      <ExpansionStrip>{previewText}</ExpansionStrip>
                    ) : null}
                  </div>
                </>
              )}

              {step === 3 && (
                <>
                  <StepHeading title="Rooms & contact" subtitle="Where it happens, and who to reach about it." />
                  <div className="flex flex-col gap-5">
                    <Field label="Rooms" error={err('locations')} hint="Tap every room the booking needs.">
                      <div className="flex flex-wrap gap-2">
                        {ROOM_NAMES.map(name => (
                          <Chip key={name} active={form.locations.includes(name)} onClick={() => toggleRoom(name)}>
                            {name}
                          </Chip>
                        ))}
                      </div>
                    </Field>
                    <Field label="Contact name" error={err('contact_name')}>
                      <input
                        type="text"
                        value={form.contact_name}
                        onChange={e => set('contact_name', e.target.value)}
                        onBlur={() => touch('contact_name')}
                        placeholder="Who should the team reach out to?"
                        className="jsp-input"
                      />
                    </Field>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      <Field label="Email" error={err('email')}>
                        <input
                          type="email"
                          value={form.email}
                          onChange={e => set('email', e.target.value)}
                          onBlur={() => touch('email')}
                          placeholder="name@japansociety.org"
                          className="jsp-input"
                        />
                      </Field>
                      <Field label="Phone" hint="Optional.">
                        <input
                          type="tel"
                          value={form.phone}
                          onChange={e => set('phone', e.target.value)}
                          placeholder="(212) 555-0100"
                          className="jsp-input"
                        />
                      </Field>
                    </div>
                  </div>
                </>
              )}

              {step === 4 && (
                <>
                  <StepHeading title="Review & submit" subtitle="Double-check everything — you can go back to any step." />

                  {previewText && <div className="mb-5"><ExpansionStrip>{previewText}</ExpansionStrip></div>}

                  <dl>
                    {reviewRows.map(r => (
                      <ReviewRow key={r.label} label={r.label} value={r.value} />
                    ))}
                  </dl>

                  {submitError && (
                    <div
                      className="mt-4 rounded-xl border px-4 py-2.5 text-sm"
                      style={{ borderColor: 'rgba(240,30,55,0.35)', background: 'rgba(240,30,55,0.08)', color: 'var(--jsp-red)' }}
                    >
                      {submitError}
                    </div>
                  )}
                </>
              )}

              <FooterRow
                showBack={step > 1}
                onBack={() => goBack()}
                onPrimary={step < 4 ? goNext : handleSubmit}
                primaryLabel={primaryLabel}
                primaryDisabled={primaryDisabled}
                primaryTitle={step < 4 ? 'Fill in the highlighted fields to continue.' : undefined}
              />
            </div>
          </>
        )}
      </div>
    </PortalShell>
  )
}
