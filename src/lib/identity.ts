// Requester identity. In production Cloudflare Access injects the verified
// email; locally (and until Access fronts every route) we fall back to a dev
// identity so the flow is walkable. NEVER trust the ?as= override in live mode
// — it exists for local walkthroughs only.
export function getUserEmail(request: Request): string {
  const header = request.headers.get('Cf-Access-Authenticated-User-Email')
  if (header) return header.toLowerCase()
  const url = new URL(request.url)
  const dev = url.searchParams.get('as')
  if (dev && /^[^@\s]+@[^@\s]+$/.test(dev)) return dev.toLowerCase()
  return 'it@japansociety.org'
}

export function isAdmin(email: string): boolean {
  // Placeholder until the Access admin group is wired (P2): IT only.
  return ['it@japansociety.org', 'mbalan@japansociety.org'].includes(email)
}
