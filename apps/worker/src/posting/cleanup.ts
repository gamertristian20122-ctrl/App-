// cleanup: services.maintenance.cleanup (expired nonces / OAuth codes and tokens, old finished jobs,
// clip sources past retention, stale leases, lost publish jobs, orphaned clip-time reservations).

import type { CleanupResult } from '@app/services'
import type { Handler } from '../types'
import { payloadOf } from './payload'

export const cleanup: Handler = async (job, ctx): Promise<CleanupResult> => {
  payloadOf('cleanup', job)
  const result = await ctx.services.maintenance.cleanup({ now: ctx.clock.now() })
  // (the logger redacts keys like "expiredTokens", so the expiry counts are summed)
  const { expiredNonces, expiredCodes, expiredTokens, ...rest } = result
  ctx.logger.info('cleanup finished', { ...rest, expiredAuthRows: expiredNonces + expiredCodes + expiredTokens })
  return result
}
