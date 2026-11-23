// POST /api/rules/run — runs the rules engine on demand.
//
// Body: { dry_run?: boolean (default true), confirm_group_id?: string }
// When confirm_group_id is given, rule 1 (auto_confirm) is restricted to that
// group — the admin Confirm button calls this with dry_run:false so the
// confirmation is applied to the local mirror rows in the dev stage.
// Responds { actions, summary }.
import { getDB } from '@/lib/cloudflare'
import { getUserEmail } from '@/lib/identity'
import { runRules } from '@/lib/rules'

export async function POST(request: Request): Promise<Response> {
  let body: { dry_run?: boolean; confirm_group_id?: string } = {}
  try {
    body = await request.json() as { dry_run?: boolean; confirm_group_id?: string }
  } catch {
    // Empty/absent body is fine — defaults apply.
  }
  const dryRun = typeof body.dry_run === 'boolean' ? body.dry_run : true
  const confirmGroupId =
    typeof body.confirm_group_id === 'string' && body.confirm_group_id.trim() !== ''
      ? body.confirm_group_id.trim()
      : undefined

  let db: D1Database
  try {
    db = await getDB()
  } catch (err) {
    console.error(err)
    return Response.json({ error: 'Database not configured' }, { status: 503 })
  }

  try {
    // Dry sweeps stay attributed to the engine; a real application (admin
    // Confirm) is attributed to whoever triggered it, for the audit log.
    const actor = dryRun ? 'rules' : getUserEmail(request)
    const { actions, summary } = await runRules(db, { dryRun, confirmGroupId, actor })
    return Response.json({ actions, summary })
  } catch (err) {
    console.error('Rules run error', err)
    return Response.json({ error: 'Rules run failed' }, { status: 500 })
  }
}
