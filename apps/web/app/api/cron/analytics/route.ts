// Vercel Cron (daily): enqueue one account-analytics pull per active brand (idempotent per brand
// per day). The worker's own scheduler does the same; this is the backup.

import { getRuntime } from '@/lib/server/deps'
import { checkCronAuth } from '@/lib/server/cron'
import { errorResponse, json, unavailable } from '@/lib/server/http'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

async function handle(req: Request): Promise<Response> {
  let rt
  try {
    rt = await getRuntime()
  } catch {
    return unavailable()
  }
  const denied = checkCronAuth(req, rt.config.CRON_SECRET)
  if (denied) return denied
  try {
    const enqueued = await rt.services.analytics.enqueueDailyAccountPulls(rt.clock.now())
    return json({ ok: true, enqueued })
  } catch (error) {
    return errorResponse(error, rt.log)
  }
}

export const GET = handle
export const POST = handle
