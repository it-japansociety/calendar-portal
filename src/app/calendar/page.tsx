'use client'

// Standalone calendar route. CalendarView owns the whole page body (header
// with the FullCalendar-driven title + view controls, the filter card, the
// calendar itself, and the event detail modal) because the view-switcher and
// prev/next/today controls are wired straight to FullCalendar's own ref.
import PortalShell from '../../components/PortalShell'
import CalendarView from '../../components/CalendarView'

export default function CalendarPage() {
  return (
    <PortalShell active="calendar" wide>
      <CalendarView />
    </PortalShell>
  )
}
