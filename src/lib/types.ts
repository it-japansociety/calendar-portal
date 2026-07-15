export type EventStatus =
  | 'Released'
  | 'Confirmed'
  | 'Contingent'
  | 'Pending'
  | 'Cancelled'
  | 'TBD'
  | 'Other'

export interface CalendarEvent {
  id: number
  event_name: string
  department: string | null
  location: string | null
  event_date: string        // YYYY-MM-DD
  day_of_week: string | null
  event_start: string       // HH:MM 24h
  event_end: string
  hold_start: string | null
  hold_end: string | null
  doors_open: string | null
  check_in_time: string | null
  run_time: string | null
  contact_name: string
  email: string
  phone: string | null
  description: string | null
  attachment_url: string | null
  status: EventStatus
  count: number | null
  jotform_id: string | null
  submitted_at: string | null   // JotForm's created_at (when the form was submitted)
  is_archived: number
  archived_at: string | null
  created_at: string
  updated_at: string
}

export type EventInsert = Omit<CalendarEvent, 'id' | 'is_archived' | 'archived_at' | 'created_at' | 'updated_at' | 'submitted_at'>

export interface EventsQueryParams {
  date_from?: string
  date_to?: string
  status?: string           // comma-separated for multiple
  department?: string
  location?: string
  include_archived?: boolean
  page?: number
  page_size?: number
}

export interface AvailabilityConflict {
  id: number
  event_name: string
  location: string | null
  event_start: string
  event_end: string
  status: string
}

export interface AvailabilityResult {
  date: string
  start_time: string | null
  end_time: string | null
  is_available: boolean
  conflicts: AvailabilityConflict[]
}

export interface PaginatedEvents {
  data: CalendarEvent[]
  pagination: {
    page: number
    page_size: number
    total: number
  }
}
