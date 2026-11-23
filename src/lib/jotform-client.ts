// JotForm API client for Booking Workflow v2. The qid map is the field
// contract with form 252113809267053 (verified during the JSSP bulk entry);
// the import route's debug mode lists live fields if the form ever changes.
import type { EventGroup } from './workflow-types'

export const EVENT_FORM_ID = '252113809267053'
// The function form gets its own JotForm form; unset until the box office
// creates it (the UI shows "not configured" and live fan-out skips it).
export const FUNCTION_FORM_ID = ''

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

// One JotForm submission body for one day of a group.
// qids: 3=Date 4=Day 5=Department 6=Event Name 8=Event Start 9=Event End
//       10=Location 11=Name 12=Status 18=Description 27=Hold Start 28=Hold End
//       29=Count 32=Doors Open 33=Check-In 34=Phone 35=Email 17=Run Time
export function buildEventSubmission(g: EventGroup, isoDate: string): Record<string, string> {
  const d = new Date(`${isoDate}T12:00:00Z`)
  const body: Record<string, string> = {
    'submission[3][month]': isoDate.slice(5, 7),
    'submission[3][day]': isoDate.slice(8, 10),
    'submission[3][year]': isoDate.slice(0, 4),
    'submission[4]': WEEKDAYS[d.getUTCDay()],
    'submission[6]': g.event_name,
    'submission[12]': 'Pending',
  }
  if (g.department)   body['submission[5]'] = g.department
  if (g.location)     body['submission[10]'] = g.location
  if (g.contact_name) body['submission[11]'] = g.contact_name
  if (g.email)        body['submission[35]'] = g.email
  if (g.description)  body['submission[18]'] = g.description
  if (g.count != null) body['submission[29]'] = String(g.count)
  const times: [string, string | null][] = [
    ['8', g.event_start], ['9', g.event_end],
    ['27', g.hold_start], ['28', g.hold_end],
  ]
  for (const [qid, t] of times) {
    if (t) {
      body[`submission[${qid}][hourSelect]`] = String(((parseInt(t) + 11) % 12) + 1)
      body[`submission[${qid}][minuteSelect]`] = t.slice(3, 5)
      body[`submission[${qid}][ampm]`] = parseInt(t) >= 12 ? 'PM' : 'AM'
    }
  }
  if (g.doors_open)    body['submission[32]'] = g.doors_open
  if (g.check_in_time) body['submission[33]'] = g.check_in_time
  if (g.run_time)      body['submission[17]'] = g.run_time
  return body
}

export async function createSubmission(
  apiKey: string, formId: string, body: Record<string, string>,
): Promise<string> {
  const res = await fetch(`https://api.jotform.com/form/${formId}/submissions?apiKey=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
  })
  const json = await res.json() as { responseCode: number; content?: { submissionID?: string }; message?: string }
  if (json.responseCode !== 200 || !json.content?.submissionID) {
    throw new Error(`JotForm create failed: ${json.responseCode} ${json.message || ''}`)
  }
  return json.content.submissionID
}

export async function editSubmission(
  apiKey: string, submissionId: string, fields: Record<string, string>,
): Promise<void> {
  const res = await fetch(`https://api.jotform.com/submission/${submissionId}?apiKey=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
  })
  const json = await res.json() as { responseCode: number; message?: string }
  if (json.responseCode !== 200) {
    throw new Error(`JotForm edit failed: ${json.responseCode} ${json.message || ''}`)
  }
}
