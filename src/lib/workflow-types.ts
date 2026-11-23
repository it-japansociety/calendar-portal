// Shared types + API contracts for Booking Workflow v2.
// These are THE contract between the API routes and the UI pages — change here
// only with matching changes on both sides.

export type GroupStatus =
  | 'draft' | 'queued' | 'creating' | 'active'
  | 'confirmed' | 'cancelled' | 'partial_error'

export interface EventGroup {
  group_id: string
  event_name: string
  department: string | null
  location: string | null          // comma-joined canonical room names
  description: string | null
  contact_name: string | null
  email: string | null
  phone: string | null
  count: number | null
  date_from: string                // YYYY-MM-DD
  date_to: string
  weekday_mask: string             // 7 chars, Sun..Sat, '1' = include
  event_start: string | null       // HH:MM 24h
  event_end: string | null
  hold_start: string | null
  hold_end: string | null
  doors_open: string | null
  check_in_time: string | null
  run_time: string | null
  status: GroupStatus
  created_by: string | null
  created_at: string
  updated_at: string
}

export interface SubmissionJob {
  id: number
  group_id: string
  form: 'event' | 'function'
  action: 'create' | 'edit' | 'release'
  event_date: string | null
  payload: string | null
  state: 'pending' | 'in_flight' | 'done' | 'failed'
  attempts: number
  last_error: string | null
  jotform_id: string | null
  created_at: string
  updated_at: string
}

export interface FunctionFormRow {
  id: number
  group_id: string
  jotform_id: string | null
  data: string                     // JSON string of FunctionFormData
  complete: number
  created_at: string
  updated_at: string
}

// Function form structure, transcribed from the box office's paper Function
// Form. Everything the BOOKING already knows (date, title, times, rooms,
// dept/contact) is NOT here — the page displays those read-only from the group.
export interface FunctionFormData {
  // Header block (only the parts the booking doesn't know)
  staff_in_charge?: string
  prep_time_from?: string          // HH:MM
  clean_up_to?: string             // HH:MM ("1 hour min. for each")
  check_in_open?: string           // HH:MM
  doors_open?: string              // AUD/MUR doors, HH:MM
  run_time?: string                // e.g. "3 hours"
  intermission?: boolean
  latecomer_admitted?: boolean
  sponsors_co_organizers?: string
  guest_count?: string
  dept_project_codes?: string
  schedule?: string                // start/end times: check-in, program, reception…

  // Extra spaces beyond the booked rooms (booked rooms shown read-only)
  extra_spaces?: string[]          // Coatroom, Gallery North/South/Bamboo, DR#1, DR#2, CL#1..3, Library, Teachers Lounge
  gallery_open_beyond_hours?: boolean
  gallery_hours_note?: string

  // Staff & rentals
  butlers_qty?: string
  butlers_from?: string
  butlers_to?: string
  ticket_takers?: boolean
  coat_check?: boolean
  coat_check_from?: string
  coat_check_to?: string
  box_office_early?: string        // early/late from time
  party_rentals?: boolean
  staff_notes?: string

  // Food & beverages
  reception?: 'none' | 'reception'
  fnb?: string[]                   // JS wine (red & white), Other wine, Sparkling/Champagne, JS beer, Other beer, Sake, Soda/Seltzer, Coffee service, Senbei, Bento boxes, Donated food/beverage, Catering
  bento_qty?: string
  senbei_location?: string
  dietary_restrictions?: string
  fnb_notes?: string

  // AV / equipment ("must include setup map")
  av?: string[]                    // Lectern, Projector & screen, Headset mic, Portable TV, Video camera, Extra wired internet, Outside projectionist, JS step & repeats, Piano, Simultaneous translation
  mics_wireless_qty?: string       // max 4 combined w/ wired
  mics_wired_qty?: string
  laptop?: 'js' | 'outside' | ''
  laptop_location?: 'lectern' | 'table' | 'soundbooth' | ''
  stream?: 'none' | 'livestream' | 'hybrid' | 'record'
  av_tech_booked?: boolean
  platforms_qty?: string           // max 4
  whiteboards_qty?: string         // max 2
  table_skirts_qty?: string        // max 4
  folding_screens_qty?: string     // max 4
  easels_qty?: string              // max 4
  stanchions_qty?: string          // max 5
  coat_racks_qty?: string          // max 5
  stage_panels?: 'wood' | 'black' | ''
  aud_rows_covered_qty?: string    // max 6
  waterfall?: 'on' | 'off' | ''
  av_notes?: string

  additional_comments?: string
}

// Equipment maxima from the paper form, enforced in the UI.
export const FUNCTION_FORM_MAX: Record<string, number> = {
  mics_total: 4, platforms_qty: 4, whiteboards_qty: 2, table_skirts_qty: 4,
  folding_screens_qty: 4, easels_qty: 4, stanchions_qty: 5, coat_racks_qty: 5,
  aud_rows_covered_qty: 6,
}

export interface RuleAction {
  id: number
  rule: string
  group_id: string | null
  event_id: number | null
  jotform_id: string | null
  detail: string | null
  before_status: string | null
  after_status: string | null
  dry_run: number
  actor: string
  undone: number
  created_at: string
}

// ── API contracts ─────────────────────────────────────────────────────────────
// POST /api/groups            body: CreateGroupRequest  -> { group_id, days: string[], jobs: number }
// GET  /api/groups?mine=1     -> { groups: GroupSummary[] }        (identity from getUserEmail)
// GET  /api/groups?id=...     -> { group, jobs, function_form, queue_position }
// PATCH /api/groups           body: { group_id, ...editable fields } -> { ok, jobs_enqueued }
// POST /api/groups/cancel     body: { group_id, dates?: string[] }  -> { ok, released: number }
// POST /api/queue/drain       body: { max?: number }   -> DrainResult (dry-run when settings.live_mode='0')
// POST /api/rules/run         body: { dry_run?: boolean } -> { actions: RuleAction[] }
// GET  /api/admin/queue       -> { groups: AdminQueueRow[] }
// POST /api/admin/action      body: { action: 'confirm'|'release'|'retry'|'undo', group_id?, rule_action_id?, on_behalf_of? }
// GET/POST /api/admin/settings -> { settings: Record<string,string> }

export interface CreateGroupRequest {
  event_name: string
  department: string
  locations: string[]              // canonical room names
  description?: string
  contact_name: string
  email: string
  phone?: string
  count?: number
  date_from: string
  date_to: string                  // = date_from for single day
  weekdays: number[]               // 0=Sun..6=Sat, days to include
  event_start?: string
  event_end?: string
  hold_start?: string
  hold_end?: string
  doors_open?: string
  check_in_time?: string
  run_time?: string
}

export interface GroupSummary extends EventGroup {
  days_total: number
  days_done: number
  days_failed: number
  function_form_complete: boolean
  missing_fields: string[]
  queue_position: number           // 0 = first / no contest
  competing_ahead: number
}

export interface DrainResult {
  drained: number
  done: number
  failed: number
  remaining: number
  live_mode: boolean
}

// Days a group expands to. Weekday mask + inclusive range, capped at 366.
export function expandGroupDates(date_from: string, date_to: string, weekdays: number[]): string[] {
  const out: string[] = []
  const d = new Date(`${date_from}T12:00:00Z`)
  const end = new Date(`${date_to}T12:00:00Z`).getTime()
  if (Number.isNaN(d.getTime()) || Number.isNaN(end)) return out
  const set = new Set(weekdays)
  while (d.getTime() <= end && out.length < 366) {
    if (set.has(d.getUTCDay())) out.push(d.toISOString().slice(0, 10))
    d.setUTCDate(d.getUTCDate() + 1)
  }
  return out
}

export function weekdayMaskFrom(weekdays: number[]): string {
  return Array.from({ length: 7 }, (_, i) => (weekdays.includes(i) ? '1' : '0')).join('')
}
export function weekdaysFromMask(mask: string): number[] {
  return mask.split('').map((c, i) => (c === '1' ? i : -1)).filter(i => i >= 0)
}

// Fields required before auto-confirm can fire (event side).
export const REQUIRED_EVENT_FIELDS: (keyof EventGroup)[] = [
  'event_name', 'department', 'location', 'contact_name', 'email',
  'event_start', 'event_end',
]
