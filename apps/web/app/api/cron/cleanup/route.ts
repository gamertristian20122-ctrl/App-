// Vercel Cron: enqueue a `cleanup` job (expired nonces/codes/tokens, old sources, stale leases,
// lost publish jobs, orphaned reservations), at most one per hour. The worker runs it.

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
    const hour = rt.clock.now().toISOString().slice(0, 13)
    const { job, created } = await rt.services.jobs.enqueue({
      type: 'cleanup',
      payload: { task: 'all' },
      idempotencyKey: `cleanup:web-cron:${hour}`,
    })
    return json({ ok: true, enqueued: created ? 1 : 0, jobId: job.id })
  } catch (error) {
    return errorResponse(error, rt.log)
  }
}

export const GET = handle
export const POST = handle
