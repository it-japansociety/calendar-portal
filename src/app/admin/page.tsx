'use client'

// Admin oversight console (dev stage, dry-run only), on the Workflow v2 glass
// design system. Stat-tile strip up top (awaiting / flags / failed jobs /
// legacy JotForm pending), then the approval queue (FCFS order, checklist
// pills, rule-flag chips, failed-job retry), the rule_actions activity log
// with undo, and the workflow settings card. "Run rules now" / "Drain queue"
// live in the queue section header with inline result summaries.
//
// Performance: the initial queue + settings GETs go through cachedFetch
// ('admin-queue' / 'admin-settings') so a cached snapshot paints instantly and
// fresh data replaces it; every mutation invalidates and refetches.
import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react'
import Shell, { useTheme, DryRunBanner } from '../../components/Shell'
import { cachedFetch, invalidateCache, writeCache } from '../../lib/client-cache'
import type { DrainResult, GroupStatus, GroupSummary, RuleAction } from '../../lib/workflow-types'

// Shape of GET /api/admin/queue (mirrors AdminQueueRow in that route).
interface FlagChip {
  id: number
  rule: string
  detail: string | null
  jotform_id: string | null
  created_at: string
}
interface FailedJob {
  id: number
  event_date: string | null
  last_error: string | null
}
interface AdminQueueRow extends GroupSummary {
  flags: FlagChip[]
  failed_jobs: FailedJob[]
  age_days: number
}
interface QueueResponse {
  groups: AdminQueueRow[]
  recent_actions: RuleAction[]
  legacy_pending_count: number
}
interface SettingsResponse {
  settings?: Record<string, string>
}

const FIELD_LABELS: Record<string, string> = {
  event_name: 'Event name',
  department: 'Department',
  location: 'Room(s)',
  contact_name: 'Contact name',
  email: 'Email',
  event_start: 'Start time',
  event_end: 'End time',
}

// The 5 known settings keys (migrations/0003_workflow.sql seeds these).
const SETTINGS_DEFAULTS: Record<string, string> = {
  live_mode: '0',
  hold_max_age_days: '30',
  near_date_days: '14',
  max_holds_per_contact: '10',
  email_enabled: '0',
}

function fmtDate(iso: string): string {
  const d = new Date(`${iso}T12:00:00Z`)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
}

// SQLite datetime('now') strings are UTC "YYYY-MM-DD HH:MM:SS".
function fmtTimestamp(ts: string): string {
  const d = new Date(`${ts.replace(' ', 'T')}Z`)
  if (Number.isNaN(d.getTime())) return ts
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

// Shared pill palettes (chips, badges, FCFS block).
function tones(isDark: boolean) {
  return {
    green: isDark ? 'bg-green-900/40 text-green-200 border-green-700/50' : 'bg-green-50 text-green-800 border-green-300',
    amber: isDark ? 'bg-amber-900/40 text-amber-200 border-amber-700/50' : 'bg-amber-50 text-amber-800 border-amber-300',
    red: isDark ? 'bg-red-900/40 text-red-200 border-red-700/50' : 'bg-red-50 text-red-800 border-red-300',
    gray: isDark ? 'bg-gray-800/60 text-gray-400 border-gray-700' : 'bg-gray-100 text-gray-600 border-gray-300',
  }
}

const PILL = 'inline-flex items-center text-xs font-semibold px-2.5 py-1 rounded-full border'

function StatusChip({ status, isDark }: { status: GroupStatus; isDark: boolean }) {
  const t = tones(isDark)
  const styles: Record<string, { label: string; cls: string }> = {
    queued: { label: 'Queued', cls: t.amber },
    creating: { label: 'Creating', cls: t.amber },
    active: { label: 'Pending approval', cls: t.amber },
    confirmed: { label: 'Confirmed', cls: t.green },
    cancelled: { label: 'Cancelled', cls: t.gray },
    partial_error: { label: 'Needs attention', cls: t.red },
    draft: { label: 'Draft', cls: t.gray },
  }
  const s = styles[status] ?? styles.draft
  return <span className={`shrink-0 ${PILL} ${s.cls}`}>{s.label}</span>
}

// Rule flags: red for hold_count, amber for hold_expiry, gray otherwise.
function RuleFlagChip({ flag, isDark }: { flag: FlagChip; isDark: boolean }) {
  const t = tones(isDark)
  const cls = flag.rule === 'hold_count' ? t.red : flag.rule === 'hold_expiry' ? t.amber : t.gray
  return (
    <span title={flag.detail ?? flag.rule} className={`${PILL} cursor-help ${cls}`}>
      {flag.rule.replace(/_/g, ' ')}
    </span>
  )
}

function StatTile({ label, value, tone, isDark }: {
  label: string
  value: number | null
  tone: 'neutral' | 'amber' | 'red'
  isDark: boolean
}) {
  const hot = value !== null && value > 0
  const numCls =
    tone === 'red' && hot ? (isDark ? 'text-red-300' : 'text-red-700')
      : tone === 'amber' && hot ? (isDark ? 'text-amber-300' : 'text-amber-700')
        : (isDark ? 'text-white' : 'text-gray-900')
  return (
    <div className="glass p-4">
      <div className={`text-2xl font-bold tabular-nums ${numCls}`}>{value ?? '—'}</div>
      <div className={`mt-1 text-xs font-semibold ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>{label}</div>
    </div>
  )
}

export default function AdminConsolePage() {
  const [isDark] = useTheme()
  // window.location.search captured after mount (null = not mounted yet);
  // appended to every API call so the ?as= dev identity carries through.
  const [search, setSearch] = useState<string | null>(null)
  const [data, setData] = useState<QueueResponse | null>(null)
  const [forbidden, setForbidden] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [sortBy, setSortBy] = useState<'age' | 'position'>('age')
  const [busy, setBusy] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  // Settings state (string values, matching the settings table).
  const [settings, setSettings] = useState<Record<string, string>>(SETTINGS_DEFAULTS)
  const [liveMode, setLiveMode] = useState(false)
  const [settingsToast, setSettingsToast] = useState<{ ok: boolean; text: string } | null>(null)

  // Operations results.
  const [rulesSummary, setRulesSummary] = useState<string | null>(null)
  const [drainSummary, setDrainSummary] = useState<string | null>(null)

  useEffect(() => { setSearch(window.location.search) }, [])

  // Endpoints here have no query params of their own, so appending the whole
  // location.search (starts with '?') is safe.
  const withId = useCallback((path: string) => `${path}${search ?? ''}`, [search])

  // Queue loader: cached snapshot paints immediately, fresh data replaces it
  // via onFresh. When there is no cache and the fetch fails, probe once with a
  // plain fetch so 403 (forbidden) and network errors keep distinct screens.
  const load = useCallback(async () => {
    if (search === null) return
    const snapshot = await cachedFetch<QueueResponse>('admin-queue', withId('/api/admin/queue'), fresh => {
      setData(fresh)
      setForbidden(false)
      setLoadError(null)
    })
    if (snapshot !== null) {
      setData(prev => prev ?? snapshot)
      return
    }
    try {
      const res = await fetch(withId('/api/admin/queue'))
      if (res.status === 403) {
        setForbidden(true)
        return
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const j = (await res.json()) as QueueResponse
      writeCache('admin-queue', j)
      setData(j)
      setForbidden(false)
      setLoadError(null)
    } catch {
      setLoadError('Could not load the admin queue. Check your connection and try again.')
    }
  }, [search, withId])

  useEffect(() => { load() }, [load])

  // Settings feed the dry-run banner and the settings form. Cached snapshot
  // first, fresh replaces; if everything fails, keep defaults (live_mode off)
  // so the banner shows anyway.
  const loadSettings = useCallback(async () => {
    if (search === null) return
    const apply = (j: SettingsResponse) => {
      const merged = { ...SETTINGS_DEFAULTS, ...(j.settings ?? {}) }
      setSettings(merged)
      setLiveMode(merged.live_mode === '1')
    }
    const snapshot = await cachedFetch<SettingsResponse>('admin-settings', withId('/api/admin/settings'), apply)
    if (snapshot !== null) apply(snapshot)
    else setLiveMode(false)
  }, [search, withId])

  useEffect(() => { loadSettings() }, [loadSettings])

  const sortedGroups = useMemo(() => {
    const gs = [...(data?.groups ?? [])]
    if (sortBy === 'position') {
      gs.sort((a, b) =>
        (a.queue_position - b.queue_position) ||
        (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0))
    }
    // 'age': the API already returns oldest-first.
    return gs
  }, [data, sortBy])

  // Header stat tiles.
  const stats = useMemo(() => {
    if (!data) return null
    return {
      awaiting: data.groups.filter(g => g.status !== 'confirmed' && g.status !== 'cancelled').length,
      flags: data.groups.reduce((n, g) => n + g.flags.length, 0),
      failed: data.groups.reduce((n, g) => n + g.failed_jobs.length, 0),
      legacy: data.legacy_pending_count,
    }
  }, [data])

  const refetchQueue = useCallback(() => {
    invalidateCache('admin-queue')
    load()
  }, [load])

  const postAction = async (
    key: string,
    body: { action: string; group_id?: string; rule_action_id?: number; on_behalf_of?: string },
  ) => {
    setBusy(key)
    setActionError(null)
    try {
      const res = await fetch(withId('/api/admin/action'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        let msg = `Action failed (HTTP ${res.status}).`
        try {
          const j = (await res.json()) as { error?: string }
          if (j.error) msg = j.error
        } catch { /* keep default message */ }
        setActionError(msg)
      }
    } catch {
      setActionError('Network error — the action may not have gone through.')
    } finally {
      setBusy(null)
      refetchQueue()
    }
  }

  const confirmGroup = (g: AdminQueueRow) =>
    postAction(`${g.group_id}:confirm`, { action: 'confirm', group_id: g.group_id })

  const confirmOnBehalf = (g: AdminQueueRow) => {
    const email = window.prompt(`Confirm "${g.event_name}" on behalf of which requester? Enter their email:`)
    if (!email || !email.trim()) return
    postAction(`${g.group_id}:confirm`, { action: 'confirm', group_id: g.group_id, on_behalf_of: email.trim() })
  }

  const releaseGroup = (g: AdminQueueRow) => {
    const ok = window.confirm(
      `Release "${g.event_name}"?\n\nEvery held date in this booking is released and the group is cancelled.`,
    )
    if (!ok) return
    postAction(`${g.group_id}:release`, { action: 'release', group_id: g.group_id })
  }

  const retryGroup = (g: AdminQueueRow) =>
    postAction(`${g.group_id}:retry`, { action: 'retry', group_id: g.group_id })

  const undoAction = (ra: RuleAction) =>
    postAction(`undo:${ra.id}`, { action: 'undo', rule_action_id: ra.id })

  const runRules = async () => {
    setBusy('rules')
    setRulesSummary(null)
    try {
      const res = await fetch(withId('/api/rules/run'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dry_run: true }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const j = (await res.json()) as { actions?: RuleAction[] }
      const actions = j.actions ?? []
      if (actions.length === 0) {
        setRulesSummary('Rules ran — nothing fired.')
      } else {
        const counts = new Map<string, number>()
        for (const a of actions) counts.set(a.rule, (counts.get(a.rule) ?? 0) + 1)
        const parts = Array.from(counts.entries()).map(([rule, n]) => `${rule.replace(/_/g, ' ')} x${n}`)
        setRulesSummary(`${actions.length} action(s) fired (dry run): ${parts.join(', ')}`)
      }
    } catch {
      setRulesSummary('Rules run failed — check the server logs.')
    } finally {
      setBusy(null)
      refetchQueue()
    }
  }

  const drainQueue = async () => {
    setBusy('drain')
    setDrainSummary(null)
    try {
      const res = await fetch(withId('/api/queue/drain'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const j = (await res.json()) as DrainResult
      setDrainSummary(
        `Drained ${j.drained} job(s) — ${j.done} done, ${j.failed} failed, ${j.remaining} remaining. ` +
        (j.live_mode ? 'LIVE mode.' : 'Dry run: local mirror rows only.'),
      )
    } catch {
      setDrainSummary('Drain failed — check the server logs.')
    } finally {
      setBusy(null)
      refetchQueue()
    }
  }

  const saveSettings = async () => {
    setBusy('settings')
    setSettingsToast(null)
    try {
      const res = await fetch(withId('/api/admin/settings'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          settings: {
            hold_max_age_days: settings.hold_max_age_days,
            near_date_days: settings.near_date_days,
            max_holds_per_contact: settings.max_holds_per_contact,
          },
        }),
      })
      if (!res.ok) {
        let msg = `Could not save settings (HTTP ${res.status}).`
        try {
          const j = (await res.json()) as { error?: string }
          if (j.error) msg = j.error
        } catch { /* keep default message */ }
        setSettingsToast({ ok: false, text: msg })
        return
      }
      setSettingsToast({ ok: true, text: 'Settings saved.' })
      invalidateCache('admin-settings')
      loadSettings()
    } catch {
      setSettingsToast({ ok: false, text: 'Network error — settings were not saved.' })
    } finally {
      setBusy(null)
    }
  }

  const t = tones(isDark)
  const subtle = isDark ? 'text-gray-400' : 'text-gray-500'
  const bodyText = isDark ? 'text-gray-300' : 'text-gray-700'
  const titleText = isDark ? 'text-white' : 'text-gray-900'
  const checkOk = isDark ? 'text-green-400' : 'text-green-600'
  const checkBad = isDark ? 'text-red-400' : 'text-red-600'
  const labelCls = `block text-xs font-semibold mb-1 ${subtle}`
  // Compact button sizing (inline style so it wins over the .v2-btn-* CSS).
  const smBtn: CSSProperties = { minHeight: '2.25rem', padding: '0.4rem 0.95rem', fontSize: '0.8rem' }
  const smDangerBtn: CSSProperties = { ...smBtn, color: isDark ? '#fca5a5' : '#b91c1c' }

  const sectionHeader = (kicker: string, title: string) => (
    <div className="mb-4">
      <p className="v2-kicker">{kicker}</p>
      <h2 className={`mt-1 text-xl font-bold ${titleText}`}>{title}</h2>
    </div>
  )

  if (forbidden) {
    return (
      <Shell title="Admin Console" isDark={isDark}>
        <DryRunBanner isDark={isDark} />
        <div className="glass p-10 text-center">
          <h2 className={`text-lg font-semibold mb-1 ${titleText}`}>Admins only</h2>
          <p className={`text-sm ${subtle}`}>
            This console is restricted to workflow admins. If you need access, contact IT.
          </p>
        </div>
      </Shell>
    )
  }

  return (
    <Shell title="Admin Console" isDark={isDark}>
      {!liveMode && <DryRunBanner isDark={isDark} />}

      {loadError && (
        <div className={`glass px-4 py-3 mb-6 text-sm flex items-center justify-between gap-3 ${
          isDark ? 'text-red-200' : 'text-red-800'
        }`}>
          <span>{loadError}</span>
          <button onClick={load} className="v2-btn-primary shrink-0" style={smBtn}>Retry</button>
        </div>
      )}

      {actionError && (
        <div className={`glass px-4 py-3 mb-6 text-sm ${isDark ? 'text-red-200' : 'text-red-800'}`}>
          {actionError}
        </div>
      )}

      {/* Stat tile strip */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-10">
        <StatTile label="Awaiting approval" value={stats?.awaiting ?? null} tone="neutral" isDark={isDark} />
        <StatTile label="Rule flags" value={stats?.flags ?? null} tone="amber" isDark={isDark} />
        <StatTile label="Failed jobs" value={stats?.failed ?? null} tone="red" isDark={isDark} />
        <StatTile label="Legacy JotForm pending" value={stats?.legacy ?? null} tone="neutral" isDark={isDark} />
      </div>

      {/* ── 1. Approval queue ─────────────────────────────────────────────── */}
      <section className="mb-12">
        <div className="flex flex-wrap items-end justify-between gap-3 mb-4">
          <div>
            <p className="v2-kicker">APPROVAL QUEUE</p>
            <h2 className={`mt-1 text-xl font-bold ${titleText}`}>Bookings awaiting action</h2>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button onClick={runRules} disabled={busy !== null} className="v2-btn-ghost" style={smBtn}>
              {busy === 'rules' ? 'Running rules…' : 'Run rules now'}
            </button>
            <button onClick={drainQueue} disabled={busy !== null} className="v2-btn-ghost" style={smBtn}>
              {busy === 'drain' ? 'Draining…' : 'Drain queue'}
            </button>
            <select
              aria-label="Sort queue"
              value={sortBy}
              onChange={e => setSortBy(e.target.value as 'age' | 'position')}
              className="v2-input"
              style={{ width: 'auto', minHeight: '2.25rem', padding: '0.35rem 0.6rem', fontSize: '0.8rem' }}
            >
              <option value="age">Oldest first</option>
              <option value="position">FCFS position</option>
            </select>
          </div>
        </div>

        {(rulesSummary || drainSummary) && (
          <div className={`mb-4 text-sm ${subtle}`}>
            {rulesSummary && <p>{rulesSummary}</p>}
            {drainSummary && <p className={rulesSummary ? 'mt-1' : ''}>{drainSummary}</p>}
          </div>
        )}

        {data === null && !loadError && <div className={`text-sm ${subtle}`}>Loading the queue…</div>}

        {data !== null && sortedGroups.length === 0 && (
          <div className="glass p-10 text-center">
            <p className={`text-sm ${subtle}`}>No bookings in the queue.</p>
          </div>
        )}

        <div className="space-y-4">
          {sortedGroups.map(g => {
            const missing = g.missing_fields ?? []
            const missingLabels = missing.map(f => FIELD_LABELS[f] ?? f)
            const detailsOk = missing.length === 0
            const singleDay = g.date_from === g.date_to
            const rowBusy = busy !== null && busy.startsWith(`${g.group_id}:`)
            const first = g.queue_position === 0
            return (
              <div key={g.group_id} className="glass p-5">
                <div className="flex items-start gap-4">
                  {/* FCFS position, prominent */}
                  <div
                    title={first ? 'First in line (FCFS)' : `${g.queue_position} booking(s) ahead in FCFS order`}
                    className={`shrink-0 w-12 h-12 rounded-xl border flex flex-col items-center justify-center ${first ? t.green : t.amber}`}
                  >
                    <span className="text-sm font-bold leading-none">{first ? '1st' : `+${g.queue_position}`}</span>
                    <span className="text-[9px] font-semibold uppercase tracking-wider mt-0.5">
                      {first ? 'FCFS' : 'ahead'}
                    </span>
                  </div>

                  <div className="min-w-0 flex-1">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <h3 className={`text-base font-semibold break-words ${titleText}`}>{g.event_name}</h3>
                        <p className={`text-sm ${subtle}`}>
                          {g.contact_name ?? 'No contact'}{g.email ? ` · ${g.email}` : ''}
                        </p>
                      </div>
                      <StatusChip status={g.status} isDark={isDark} />
                    </div>

                    <p className={`mt-1.5 text-sm ${subtle}`}>
                      {singleDay ? fmtDate(g.date_from) : `${fmtDate(g.date_from)} – ${fmtDate(g.date_to)}`}
                      {g.location && <> · {g.location}</>}
                      {' · '}days {g.days_done}/{g.days_total}
                      {' · '}{g.age_days}d old
                    </p>

                    {/* Checklist pills + rule flag chips */}
                    <div className="mt-2.5 flex flex-wrap gap-1.5">
                      <span
                        title={detailsOk ? 'All required event details present' : `Missing: ${missingLabels.join(', ')}`}
                        className={`${PILL} ${detailsOk ? t.green : t.red}`}
                      >
                        {detailsOk
                          ? 'Details complete'
                          : `Missing: ${missingLabels.slice(0, 2).join(', ')}${missingLabels.length > 2 ? ` +${missingLabels.length - 2}` : ''}`}
                      </span>
                      <span className={`${PILL} ${g.function_form_complete ? t.green : t.red}`}>
                        {g.function_form_complete ? 'Function form complete' : 'Function form pending'}
                      </span>
                      {g.flags.map(f => <RuleFlagChip key={f.id} flag={f} isDark={isDark} />)}
                    </div>

                    {/* Failed jobs alert, inline retry */}
                    {g.failed_jobs.length > 0 && (
                      <div className={`mt-3 rounded-xl border px-3 py-2.5 text-sm ${t.red}`}>
                        <div className="flex flex-wrap items-center justify-between gap-3">
                          <span className="font-semibold">{g.failed_jobs.length} failed job(s)</span>
                          <button
                            onClick={() => retryGroup(g)}
                            disabled={busy !== null}
                            className="v2-btn-primary shrink-0"
                            style={smBtn}
                          >
                            {busy === `${g.group_id}:retry` ? 'Retrying…' : 'Retry'}
                          </button>
                        </div>
                        <ul className="mt-1 space-y-0.5 text-xs">
                          {g.failed_jobs.slice(0, 3).map(j => (
                            <li key={j.id}>{j.event_date ?? 'no date'}: {j.last_error ?? 'unknown error'}</li>
                          ))}
                          {g.failed_jobs.length > 3 && <li>…and {g.failed_jobs.length - 3} more</li>}
                        </ul>
                      </div>
                    )}

                    {/* Row actions */}
                    {g.status !== 'confirmed' && (
                      <div className="mt-4 flex flex-wrap gap-2">
                        <button onClick={() => confirmGroup(g)} disabled={busy !== null} className="v2-btn-primary" style={smBtn}>
                          {rowBusy ? 'Working…' : 'Confirm (dev: local only)'}
                        </button>
                        <button onClick={() => releaseGroup(g)} disabled={busy !== null} className="v2-btn-ghost" style={smDangerBtn}>
                          Release
                        </button>
                        <button onClick={() => confirmOnBehalf(g)} disabled={busy !== null} className="v2-btn-ghost" style={smBtn}>
                          On behalf of…
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )
          })}
        </div>

        {data !== null && data.legacy_pending_count > 0 && (
          <p className={`mt-4 text-xs ${subtle}`}>
            {data.legacy_pending_count} pending booking{data.legacy_pending_count === 1 ? '' : 's'} made directly in
            JotForm are outside groups — manage those in JotForm.
          </p>
        )}
      </section>

      {/* ── 2. Activity log ───────────────────────────────────────────────── */}
      <section className="mb-12">
        {sectionHeader('ACTIVITY LOG', 'Recent rule and admin actions')}

        {data !== null && data.recent_actions.length === 0 && (
          <div className="glass p-10 text-center">
            <p className={`text-sm ${subtle}`}>No rule or admin actions logged yet.</p>
          </div>
        )}

        {data !== null && data.recent_actions.length > 0 && (
          <div className={`glass divide-y ${isDark ? 'divide-gray-700/60' : 'divide-gray-200/80'}`}>
            {data.recent_actions.map(ra => {
              const undoable = ra.undone === 0 && ra.rule !== 'undo' &&
                ra.before_status !== null && ra.before_status !== ''
              return (
                <div key={ra.id} className="px-4 py-3 flex flex-col sm:flex-row sm:items-center gap-2 sm:justify-between">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2 text-sm">
                      <span className={`font-semibold ${titleText}`}>{ra.rule.replace(/_/g, ' ')}</span>
                      {ra.dry_run === 1 && (
                        <span className={`text-xs font-semibold px-2 py-0.5 rounded-full border ${t.amber}`}>dry run</span>
                      )}
                      {ra.undone === 1 && (
                        <span className={`text-xs font-semibold px-2 py-0.5 rounded-full border ${t.gray}`}>undone</span>
                      )}
                      {ra.before_status && ra.after_status && (
                        <span className={`text-xs ${subtle}`}>{ra.before_status} → {ra.after_status}</span>
                      )}
                    </div>
                    <p className={`text-xs ${subtle}`}>
                      {ra.actor} · {fmtTimestamp(ra.created_at)}
                      {ra.detail && <> · {ra.detail}</>}
                    </p>
                  </div>
                  {undoable && (
                    <button
                      onClick={() => undoAction(ra)}
                      disabled={busy !== null}
                      className="v2-btn-ghost shrink-0 self-start sm:self-center"
                      style={smBtn}
                    >
                      {busy === `undo:${ra.id}` ? 'Undoing…' : 'Undo'}
                    </button>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </section>

      {/* ── 3. Settings ───────────────────────────────────────────────────── */}
      <section>
        {sectionHeader('SETTINGS', 'Workflow settings')}
        <div className="glass p-5 sm:p-6">
          <div className="space-y-5">
            <div className="space-y-3 opacity-60">
              <label className="flex items-center gap-3 cursor-not-allowed">
                <input type="checkbox" checked={settings.live_mode === '1'} disabled className="h-5 w-5 accent-red-600" />
                <span className={`text-sm ${bodyText}`}>
                  Live mode (send to JotForm)
                  <span className={`block text-xs ${subtle}`}>Locked off in dev stage.</span>
                </span>
              </label>
              <label className="flex items-center gap-3 cursor-not-allowed">
                <input type="checkbox" checked={settings.email_enabled === '1'} disabled className="h-5 w-5 accent-red-600" />
                <span className={`text-sm ${bodyText}`}>
                  Email notifications
                  <span className={`block text-xs ${subtle}`}>Locked off in dev stage.</span>
                </span>
              </label>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div>
                <label className={labelCls} htmlFor="hold-max-age">Hold max age (days)</label>
                <input
                  id="hold-max-age" type="number" min={0} className="v2-input"
                  value={settings.hold_max_age_days}
                  onChange={e => setSettings(s => ({ ...s, hold_max_age_days: e.target.value }))}
                />
              </div>
              <div>
                <label className={labelCls} htmlFor="near-date">Near-date window (days)</label>
                <input
                  id="near-date" type="number" min={0} className="v2-input"
                  value={settings.near_date_days}
                  onChange={e => setSettings(s => ({ ...s, near_date_days: e.target.value }))}
                />
              </div>
              <div>
                <label className={labelCls} htmlFor="max-holds">Max holds per contact</label>
                <input
                  id="max-holds" type="number" min={0} className="v2-input"
                  value={settings.max_holds_per_contact}
                  onChange={e => setSettings(s => ({ ...s, max_holds_per_contact: e.target.value }))}
                />
              </div>
            </div>
            <div className="flex flex-col sm:flex-row sm:items-center gap-3">
              <button onClick={saveSettings} disabled={busy !== null} className="v2-btn-primary self-start">
                {busy === 'settings' ? 'Saving…' : 'Save settings'}
              </button>
              {settingsToast && (
                <span className={`text-sm font-semibold ${settingsToast.ok ? checkOk : checkBad}`}>
                  {settingsToast.text}
                </span>
              )}
            </div>
          </div>
        </div>
      </section>
    </Shell>
  )
}
