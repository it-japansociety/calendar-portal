// Canonical bookable rooms, shared by the UI and the events API. JotForm's
// location field is free-form and very inconsistent — a single booking may list
// multiple rooms, comma-separated, using abbreviations ("AUD, MUR, FOY"), full
// names ("Auditorium, Murasae Room, Foyer"), or misspellings ("Murase Room").
// Each room lists the normalized alias tokens that should count as that room.
// `prefixes` catches tokens with trailing notes (e.g. "Foyer contingent on PA").
export const ROOMS: { name: string; aliases: string[]; prefixes?: string[] }[] = [
  { name: 'Auditorium',             aliases: ['aud', 'auditorium'], prefixes: ['auditorium'] },
  { name: 'Murasae Room',           aliases: ['mur', 'murasae room', 'murase room', 'murasae', 'murase'], prefixes: ['murasae', 'murase'] },
  { name: 'Foyer',                  aliases: ['foy', 'foyer'], prefixes: ['foyer'] },
  { name: 'Sony Room',              aliases: ['sony', 'sony room'], prefixes: ['sony room'] },
  { name: 'Sky Room',               aliases: ['sky', 'sky room'], prefixes: ['sky room'] },
  { name: 'Gallery',                aliases: ['gal', 'gallery', 'south gallery'], prefixes: ['gallery'] },
  { name: 'A-Level',                aliases: ['a-level', 'a level', 'alevel'] },
  { name: 'Pond',                   aliases: ['pond', 'lc pond'], prefixes: ['pond'] },
  { name: 'Atrium',                 aliases: ['atr', 'atro', 'atrium'], prefixes: ['atrium'] },
  { name: '3rd Fl Conference Room', aliases: ['3rd fl conference room', '3rd floor conference room'], prefixes: ['3rd fl conference', '3rd floor conference'] },
  { name: '4th Fl Conference Room', aliases: ['4th fl conference room', '4th floor conference room'], prefixes: ['4th fl conference', '4th floor conference'] },
  { name: 'Language Center',        aliases: ['lc'], prefixes: ['language center'] },
  { name: 'Online',                 aliases: ['online'], prefixes: ['online'] },
  { name: 'Offsite',                aliases: ['offsite'], prefixes: ['offsite'] },
]

export const ROOM_NAMES = ROOMS.map(r => r.name)

// Lowercase, trim, collapse whitespace, and tighten spaces around hyphens
// ("A- Level" -> "a-level") so alias matching is robust to formatting noise.
export function normalizeLoc(s: string): string {
  return s.toLowerCase().trim().replace(/\s*-\s*/g, '-').replace(/\s+/g, ' ')
}

// Set of canonical room names referenced by a raw (possibly multi-room) location string.
export function roomsInLocation(raw: string | null | undefined): Set<string> {
  const found = new Set<string>()
  if (!raw) return found
  const tokens = raw.split(',').map(normalizeLoc).filter(Boolean)
  for (const room of ROOMS) {
    if (tokens.some(t => room.aliases.includes(t) || (room.prefixes?.some(p => t.startsWith(p)) ?? false))) {
      found.add(room.name)
    }
  }
  return found
}

// Whether a raw location string includes at least one of the given canonical rooms.
export function locationMatchesAny(raw: string | null | undefined, rooms: string[]): boolean {
  if (rooms.length === 0) return true
  const found = roomsInLocation(raw)
  return rooms.some(r => found.has(r))
}
