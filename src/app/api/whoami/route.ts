import { getDB } from '@/lib/cloudflare'
import { getUserEmail } from '@/lib/identity'

// GET /api/whoami — the logged-in identity, for personalizing the portal
// ("Hi Max"). Name is best-effort: the most recent booking's contact_name for
// this email, falling back to a title-cased guess from the email's local part.
export async function GET(request: Request): Promise<Response> {
  const email = getUserEmail(request)

  let name = email.split('@')[0].split(/[._]/).map(
    s => s.charAt(0).toUpperCase() + s.slice(1)
  ).join(' ')

  try {
    const db = await getDB()
    const row = await db.prepare(`
      SELECT contact_name FROM event_groups
      WHERE email = ? AND contact_name IS NOT NULL AND contact_name != ''
      ORDER BY created_at DESC LIMIT 1
    `).bind(email).first<{ contact_name: string }>()
    if (row?.contact_name) name = row.contact_name.split(' ')[0]
  } catch {
    // best-effort only
  }

  return Response.json({ email, name })
}
