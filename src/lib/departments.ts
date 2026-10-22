// Department color coding for the calendar view, from the house color sheet.
// Keys are the canonical Department values on the JotForm form. Departments
// without an assigned color fall back to neutral gray.
export type DeptColor = { bg: string; text: string; border?: string; bold?: boolean }

export const DEPT_COLORS: Record<string, DeptColor> = {
  'Education & Family':     { bg: '#FCF6A5', text: '#1f2937' },                     // Edu — pale yellow
  'Language Center':        { bg: '#D2722B', text: '#1f2937' },                     // Lang — orange
  'Rentals':                { bg: '#F1A983', text: '#1f2937' },                     // Rentals — salmon
  'Film':                   { bg: '#ffffff', text: '#FF00FF', border: '#9ca3af' },  // Film — magenta on white
  'C&C':                    { bg: '#6D8BE8', text: '#1f2937' },                     // C&C — blue
  'Office of the President':{ bg: '#9E93AE', text: '#1f2937' },                     // OoP — gray purple
  'PA':                     { bg: '#90EE90', text: '#1f2937' },                     // PA — light green
  'Building Services':      { bg: '#B9B383', text: '#1f2937' },                     // Building — khaki
  'Gallery':                { bg: '#F983F9', text: '#1f2937' },                     // Gallery — pink
  'Holiday':                { bg: '#FB2018', text: '#000000', bold: true },         // HOLIDAY — red, bold
  'B&P':                    { bg: '#A8CBEE', text: '#1f2937' },                     // B&P — light blue
  'Development':            { bg: '#AC9DC7', text: '#1f2937' },                     // Dev — light purple
}

export const DEPT_FALLBACK: DeptColor = { bg: '#E5E7EB', text: '#1f2937', border: '#9ca3af' }

// Department values drift, so the same department reaches us under several
// spellings. The form's labels were abbreviated at some point — Performing
// Arts became PA, Business & Policy became B&P, Culture & Community became
// C&C — and submissions made before that still carry the long form. HOLIDAY
// is also typed in caps about as often as not.
//
// Looking colors up on the exact string left every one of those rows gray:
// 11 active HOLIDAY bookings rendered neutral instead of the red the color
// sheet calls for, and the long-form stragglers lost their swatch entirely.
// Resolve to a canonical name first, the way rooms.ts resolves room aliases.
const CANONICAL_BY_LOWER = new Map(
  Object.keys(DEPT_COLORS).map(k => [k.toLowerCase(), k] as const),
)

// Long-form labels that predate the abbreviations on the form.
const DEPT_ALIASES: Record<string, string> = {
  'performing arts':     'PA',
  'business & policy':   'B&P',
  'business and policy': 'B&P',
  'culture & community': 'C&C',
  'culture and community': 'C&C',
  'education and family': 'Education & Family',
}

// The name a department should be grouped and colored under. Unknown values
// are returned trimmed but otherwise untouched, so a department nobody has
// mapped yet still reads correctly — it just gets the fallback swatch.
export function canonicalDept(department?: string | null): string {
  const value = (department || '').trim()
  if (!value) return ''
  const key = value.toLowerCase().replace(/\s+/g, ' ')
  return DEPT_ALIASES[key] || CANONICAL_BY_LOWER.get(key) || value
}

// Every distinct department in a comma-joined value, canonicalised.
// "Development, Performing Arts" -> ["Development", "PA"]
export function deptsIn(department?: string | null): string[] {
  const seen = new Set<string>()
  for (const part of (department || '').split(',')) {
    const name = canonicalDept(part)
    if (name) seen.add(name)
  }
  return [...seen]
}

// D1 stores multi-select departments comma-joined ("Education & Family, PA");
// color by the first one that has an assigned swatch.
export function deptColorFor(department?: string | null): DeptColor {
  if (!department) return DEPT_FALLBACK
  for (const part of deptsIn(department)) {
    if (DEPT_COLORS[part]) return DEPT_COLORS[part]
  }
  return DEPT_FALLBACK
}

// Legend entries in the order of the house color sheet.
export const DEPT_LEGEND: { label: string; dept: string }[] = [
  { label: 'Edu',      dept: 'Education & Family' },
  { label: 'Lang',     dept: 'Language Center' },
  { label: 'Rentals',  dept: 'Rentals' },
  { label: 'Film',     dept: 'Film' },
  { label: 'C&C',      dept: 'C&C' },
  { label: 'OoP',      dept: 'Office of the President' },
  { label: 'PA',       dept: 'PA' },
  { label: 'Building', dept: 'Building Services' },
  { label: 'Gallery',  dept: 'Gallery' },
  { label: 'Holiday',  dept: 'Holiday' },
  { label: 'B&P',      dept: 'B&P' },
  { label: 'Dev',      dept: 'Development' },
]
