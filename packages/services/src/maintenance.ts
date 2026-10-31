// System-level housekeeping (cron / the `cleanup` job) and webhook lookups. These functions are not
// user-scoped: never pass user input to them without verifying its origin first (webhook signature,
// cron secret).

import { z } from 'zod'
import { SOURCE_LIMITS } from '@app/core/plans'
import { DAY_MS, addMs } from '@app/core/time'
import { AccountStatusSchema, PLATFORMS, type AccountStatus, type Platform } from '@app/core/types'
import type { AccountRow } from '@app/db'
import type { AccountsService } from './accounts'
import { auditIn } from './audit'
import { errorMessage, fromZod, withErrors, type Ctx } from './context'
import { isClipSource } from './media'
import type { PostsService } from './posts'
import { releaseIn } from './usage'

export interface CleanupResult {
  expiredNonces: number
  expiredCodes: number
  expiredTokens: number
  prunedJobs: number
  deletedSources: number
  requeuedJobs: number
  deadJobs: number
  duePostsQueued: number
  /** Posts stuck in `publishing` whose job died: resumed (same idempotency key), re-checked, or failed. */
  stuckPublishing: { resumed: number; rechecked: number; failed: number }
  /** Clip-time reservations of sources that will never be transcribed, given back. */
  releasedReservations: number
  /** Registered OAuth clients that never got (or no longer hold) a code or token. */
  deletedOAuthClients: number
}

/** A reservation without a transcript for this long is released (a late transcript still settles it). */
export const ORPHAN_RESERVATION_AFTER_MS = 2 * DAY_MS

const ProviderStatusSchema = z.object({
  profileRef: z.string().trim().min(1).max(255),
  platform: z.enum(PLATFORMS),
  status: AccountStatusSchema,
})

export function createMaintenanceService(ctx: Ctx, deps: { accounts: AccountsService; posts: PostsService }) {
  return withErrors({
    /**
     * The `cleanup` job: expired nonces / OAuth codes / tokens, old finished jobs, clip-source
     * files past the 30-day retention (file deleted, row kept as `deleted`), stale job leases,
     * due posts whose publish job was lost, and posts stuck in `publishing` whose job died.
     */
    async cleanup(options: { now?: Date; sourceBatch?: number } = {}): Promise<CleanupResult> {
      const now = options.now ?? ctx.now()
      const r = ctx.repos
      const expiredNonces = await r.maintenance.deleteExpiredApprovalNonces(addMs(now, -DAY_MS))
      const expiredCodes = await r.maintenance.deleteExpiredOAuthCodes(addMs(now, -DAY_MS))
      // keep expired refresh-token families a while so a replayed token is still recognised
      const expiredTokens = await r.maintenance.deleteExpiredOAuthTokens(addMs(now, -30 * DAY_MS))
      const prunedJobs = await r.maintenance.pruneFinishedJobs(addMs(now, -14 * DAY_MS))
      const deletedOAuthClients = await r.maintenance.deleteUnusedOAuthClients(addMs(now, -7 * DAY_MS))

      let deletedSources = 0
      const stale = await r.maintenance.listStaleSourceMedia(addMs(now, -SOURCE_LIMITS.retentionDays * DAY_MS), options.sourceBatch ?? 100)
      for (const media of stale) {
        if (!isClipSource(media)) continue // post videos are kept while they may still publish
        try {
          await ctx.storage.delete(media.storageKey)
          await ctx.tx(async (tx) => {
            await tx.media.update(media.userId, media.id, { status: 'deleted', sourceUrl: null })
            await auditIn(tx, media.userId, {
              actor: 'system',
              action: 'media.retention_deleted',
              subjectType: 'media',
              subjectId: media.id,
              meta: { retentionDays: SOURCE_LIMITS.retentionDays },
            })
          })
          deletedSources += 1
        } catch (error) {
          ctx.log.warn('source cleanup failed', { mediaId: media.id, error: errorMessage(error) })
        }
      }

      const stale2 = await r.jobs.requeueStale(now)
      const duePostsQueued = await deps.posts.enqueueDue(now)
      const stuckPublishing = await deps.posts.recoverStuckPublishing(now)

      // Auto-refund: sources whose transcription will never finish (media failed/deleted, the
      // transcribe job died without reporting, or no transcript after a grace period).
      let releasedReservations = 0
      const orphans = await r.maintenance.listOrphanedClipReservations(addMs(now, -ORPHAN_RESERVATION_AFTER_MS))
      for (const orphan of orphans) {
        try {
          const released = await ctx.tx(async (tx) => {
            const result = await releaseIn(tx, orphan.userId, {
              reserveKey: orphan.reserveKey,
              subjectId: orphan.mediaId,
              note: `auto-refund: ${orphan.reason}`,
            })
            if (result.created) {
              await auditIn(tx, orphan.userId, {
                actor: 'system',
                action: 'usage.reservation_released',
                subjectType: 'media',
                subjectId: orphan.mediaId,
                meta: { reason: orphan.reason, seconds: result.released },
              })
            }
            return result.created
          })
          if (released) releasedReservations += 1
        } catch (error) {
          ctx.log.warn('reservation release failed', { mediaId: orphan.mediaId, error: errorMessage(error) })
        }
      }
      return {
        expiredNonces,
        expiredCodes,
        expiredTokens,
        prunedJobs,
        deletedSources,
        requeuedJobs: stale2.requeued,
        deadJobs: stale2.dead,
        duePostsQueued,
        stuckPublishing,
        releasedReservations,
        deletedOAuthClients,
      }
    },

    /**
     * Upload-Post webhook (account_status): applies a status change to the brand that owns the
     * provider profile. Returns null when no brand has that profile. Verify the webhook first.
     */
    async applyProviderAccountStatus(input: { profileRef: string; platform: Platform; status: AccountStatus }): Promise<AccountRow | null> {
      const data = fromZod(ProviderStatusSchema, input, 'Account status')
      const brand = await ctx.repos.brands.findByProviderProfileRef(data.profileRef)
      if (!brand) return null
      return deps.accounts.applyProviderStatus(brand.userId, brand.id, data.platform, data.status)
    },
  })
}

export type MaintenanceService = ReturnType<typeof createMaintenanceService>
