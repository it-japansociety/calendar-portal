'use client'

// Stale-while-revalidate fetch cache: pages render instantly from the last
// snapshot (sessionStorage) while a fresh copy loads in the background.
// Usage:
//   const data = await cachedFetch<T>('my-groups', '/api/groups?mine=1', fresh => setState(fresh))
// - Returns the cached value immediately when one exists (and still triggers
//   the background refresh, delivering it via onFresh).
// - Returns the network value when no cache exists yet.
// Cache is per-tab (sessionStorage) so nothing stale outlives a session, and
// every read/write is try/catch-guarded (private windows, quota).

const PREFIX = 'v2cache:'

export function readCache<T>(key: string): T | null {
  try {
    const raw = sessionStorage.getItem(PREFIX + key)
    return raw ? (JSON.parse(raw) as T) : null
  } catch { return null }
}

export function writeCache(key: string, value: unknown): void {
  try { sessionStorage.setItem(PREFIX + key, JSON.stringify(value)) } catch { /* full/blocked */ }
}

export async function cachedFetch<T>(
  key: string,
  url: string,
  onFresh?: (fresh: T) => void,
): Promise<T | null> {
  const cached = readCache<T>(key)
  const refresh = fetch(url)
    .then(r => (r.ok ? (r.json() as Promise<T>) : null))
    .then(fresh => {
      if (fresh != null) {
        writeCache(key, fresh)
        onFresh?.(fresh)
      }
      return fresh
    })
    .catch(() => null)
  if (cached != null) return cached
  return refresh
}

export function invalidateCache(key: string): void {
  try { sessionStorage.removeItem(PREFIX + key) } catch { /* noop */ }
}
