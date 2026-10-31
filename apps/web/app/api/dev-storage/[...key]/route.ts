// Local object storage for development (STORAGE_DRIVER=fs, or memory in tests): serves the
// HMAC-signed presigned URLs that FsStorage/MemoryStorage issue (GET, HEAD, PUT). Uses the app's
// single storage instance. 404 whenever storage is R2 or the app runs in production.

import { createLocalStorageHandler, isLocalStorage } from '@app/storage'
import { getRuntime } from '@/lib/server/deps'
import { unavailable } from '@/lib/server/http'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const notFound = () => new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } })

async function handle(req: Request): Promise<Response> {
  let rt
  try {
    rt = await getRuntime()
  } catch {
    return unavailable()
  }
  const { config, storage, log } = rt
  if (config.APP_ENV === 'production' || config.STORAGE_DRIVER === 'r2' || !isLocalStorage(storage)) return notFound()
  return createLocalStorageHandler(storage, { logger: log.child({ route: 'dev-storage' }) })(req)
}

export const GET = handle
export const HEAD = handle
export const PUT = handle
