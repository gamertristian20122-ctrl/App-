// Runs a /setup action for the owner: 404 for anyone else (the page does not exist for them),
// a per-owner rate limit, the action itself, an audit entry without secrets, and a refresh of the
// page. Server-only.

import { notFound } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import type { ActionResult } from '@/lib/ui/action-result'
import { failed } from '@/lib/ui/action-result'
import { currentUser } from '@/lib/ui/runtime'
import type { SetupActionId } from '@/lib/ui/setup'
import { getRuntime } from '../deps'
import { isOwner, ownerEmailOf } from '../owner'
import { hitRateLimit } from '../rate-limit'
import { SETUP_ACTION_HANDLERS } from './actions'
import { setupDepsFromRuntime } from './deps'
import { safeMessage } from './stripe'

export async function runSetupAction(id: SetupActionId): Promise<ActionResult> {
  const rt = await getRuntime()
  const user = await currentUser()
  if (!isOwner(user, ownerEmailOf(rt.config)) || !user) notFound()

  const limit = hitRateLimit('setupAction', user.id)
  if (!limit.ok) return failed(`Too many taps. Wait ${limit.retryAfterSec} seconds and try again.`)

  const deps = setupDepsFromRuntime(rt)
  let result: ActionResult
  let meta: Record<string, string | number | boolean> = {}
  try {
    const outcome = await SETUP_ACTION_HANDLERS[id](deps)
    meta = outcome.meta ?? {}
    result = { ok: outcome.ok, message: outcome.message, ...(outcome.issues && outcome.issues.length > 0 ? { issues: outcome.issues } : {}), at: Date.now() }
  } catch (error) {
    rt.log.warn('setup action failed', { action: id, error: error instanceof Error ? error.name : 'unknown' })
    result = failed(safeMessage(error))
  }
  try {
    await rt.services.audit.record(user.id, { actor: 'web', action: `setup.${id}`, subjectType: 'setup', subjectId: id, meta: { ok: result.ok, ...meta } })
  } catch (error) {
    rt.log.warn('setup audit failed', { action: id, error: error instanceof Error ? error.name : 'unknown' })
  }
  revalidatePath('/setup')
  return result
}
