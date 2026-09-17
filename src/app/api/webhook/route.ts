// Retired. The webhook receiver moved to /api/webhook/<secret> — the shared
// secret is a path segment rather than a query parameter, because query
// strings leak into access logs, proxies and Referer headers far more readily.
// See src/app/api/webhook/[token]/route.ts for the live endpoint.
//
// This stub stays so that a stale JotForm configuration pointing at the old
// URL fails loudly (410) instead of silently succeeding or 404-ing into the
// Next.js catch-all.

export async function POST(): Promise<Response> {
  return Response.json(
    { error: 'This webhook URL is retired. Re-point JotForm at /api/webhook/<secret>.' },
    { status: 410 },
  )
}

export async function GET(): Promise<Response> {
  return Response.json(
    { error: 'This webhook URL is retired. Re-point JotForm at /api/webhook/<secret>.' },
    { status: 410 },
  )
}
