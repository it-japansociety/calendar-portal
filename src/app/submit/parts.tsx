'use client'

// Presentational helpers for the Book a Space wizard (/submit).
// Kept separate so page.tsx stays focused on state and flow.
// Styling rides entirely on the Calendar Portal design system in globals.css
// (.jsp-card / .jsp-chip / .jsp-input / .jsp-btn* / .jsp-step / .jsp-kicker) —
// these helpers only add spacing, labels, and the review/progress layouts the
// system leaves to the page.
import type { ReactNode } from 'react'

// Tiny uppercase, letter-spaced field label — e.g. "EVENT NAME".
export function FieldLabel({ children }: { children: ReactNode }) {
  return (
    <span
      className="block text-[0.7rem] font-semibold uppercase tracking-wider mb-1.5"
      style={{ color: 'var(--jsp-muted)' }}
    >
      {children}
    </span>
  )
}

// A labelled control with an inline error (red) or a muted hint when there is none.
export function Field({ label, error, hint, children }: {
  label: string
  error?: string
  hint?: string
  children: ReactNode
}) {
  return (
    <div>
      <FieldLabel>{label}</FieldLabel>
      {children}
      {error
        ? <p className="mt-1.5 text-xs" style={{ color: 'var(--jsp-red)' }}>{error}</p>
        : hint
          ? <p className="mt-1.5 text-xs" style={{ color: 'var(--jsp-muted)' }}>{hint}</p>
          : null}
    </div>
  )
}

// Pill chip for departments / rooms / weekdays / single-day-vs-range — a thin
// wrapper over the design system's .jsp-chip, toggled with data-on.
export function Chip({ active, onClick, children }: {
  active: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button type="button" onClick={onClick} aria-pressed={active} data-on={active} className="jsp-chip">
      {children}
    </button>
  )
}

// Small heading at the top of a step's card content.
export function StepHeading({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div className="mb-6">
      <h2 className="text-lg sm:text-xl font-semibold" style={{ color: 'var(--jsp-ink)' }}>{title}</h2>
      {subtitle && <p className="mt-1 text-sm" style={{ color: 'var(--jsp-muted)' }}>{subtitle}</p>}
    </div>
  )
}

const STEP_LABELS = ['Event', 'Dates & times', 'Rooms & contact', 'Review']

// Four .jsp-step rails side by side — the top border is vermilion for
// done/current steps, --jsp-line for todo. Completed steps jump back on click.
export function Stepper({ step, onJump }: { step: number; onJump: (step: number) => void }) {
  return (
    <nav aria-label={`Step ${step} of 4`} className="mb-8">
      <ol className="flex flex-wrap gap-3">
        {STEP_LABELS.map((label, i) => {
          const n = i + 1
          const state = n < step ? 'done' : n === step ? 'current' : 'todo'
          const clickable = n < step
          return (
            <li key={label} className="flex-1 min-w-[6.5rem]">
              <button
                type="button"
                onClick={() => { if (clickable) onJump(n) }}
                disabled={!clickable}
                aria-current={state === 'current' ? 'step' : undefined}
                data-state={state}
                className={`jsp-step block w-full text-left ${clickable ? 'cursor-pointer' : 'cursor-default'}`}
              >
                <span className="jsp-step-label">{n} {label}</span>
              </button>
            </li>
          )
        })}
      </ol>
    </nav>
  )
}

// Soft vermilion-tinted strip — the date-range preview and the review step's
// expansion summary share this treatment (echoes .jsp-status-alert's tint).
export function ExpansionStrip({ children }: { children: ReactNode }) {
  return (
    <div
      className="rounded-xl px-4 py-2.5 text-sm font-medium"
      style={{ background: 'rgba(240, 30, 55, 0.09)', border: '1px solid rgba(240, 30, 55, 0.22)', color: 'var(--jsp-red)' }}
    >
      {children}
    </div>
  )
}

// One row of the review definition list: muted uppercase label left, value right.
export function ReviewRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div
      className="grid grid-cols-1 sm:grid-cols-[10rem_1fr] gap-0.5 sm:gap-4 py-2.5 border-b last:border-b-0"
      style={{ borderColor: 'var(--jsp-line)' }}
    >
      <dt className="text-[0.7rem] font-semibold uppercase tracking-wider pt-0.5" style={{ color: 'var(--jsp-muted)' }}>
        {label}
      </dt>
      <dd className="text-sm break-words" style={{ color: 'var(--jsp-ink)' }}>{value}</dd>
    </div>
  )
}

// Slim vermilion progress bar — used on the post-submit success card.
export function ProgressBar({ percent }: { percent: number }) {
  const clamped = Math.max(0, Math.min(100, percent))
  return (
    <div
      className="w-full h-2 rounded-full overflow-hidden"
      style={{ background: 'var(--jsp-line)' }}
      role="progressbar"
      aria-valuenow={Math.round(clamped)}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div
        className="h-full rounded-full transition-all duration-500"
        style={{ width: `${clamped}%`, background: 'var(--jsp-red)' }}
      />
    </div>
  )
}

// Back / Next-or-Submit footer row inside the step card. Back is a ghost pill
// on the left, the primary action a solid pill on the right (justify-between);
// on mobile both stack full-width with the primary action first.
export function FooterRow({
  showBack, onBack, onPrimary, primaryLabel, primaryDisabled, primaryTitle,
}: {
  showBack: boolean
  onBack: () => void
  onPrimary: () => void
  primaryLabel: string
  primaryDisabled: boolean
  primaryTitle?: string
}) {
  return (
    <div className="mt-8 flex flex-col-reverse sm:flex-row sm:items-center sm:justify-between gap-3">
      {showBack
        ? <button type="button" onClick={onBack} className="jsp-btn-ghost w-full sm:w-auto">Back</button>
        : <span className="hidden sm:block" aria-hidden />}
      <button
        type="button"
        onClick={onPrimary}
        disabled={primaryDisabled}
        title={primaryDisabled ? primaryTitle : undefined}
        className="jsp-btn w-full sm:w-auto sm:px-8"
      >
        {primaryLabel}
      </button>
    </div>
  )
}
