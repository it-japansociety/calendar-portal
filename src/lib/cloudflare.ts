import { getCloudflareContext } from '@opennextjs/cloudflare'

export async function getDB(): Promise<D1Database> {
  const { env } = await getCloudflareContext()
  const db = (env as CloudflareEnv).DB
  if (!db) throw new Error('D1 binding DB is not configured in wrangler.jsonc')
  return db
}
