// Applies a verified Upload-Post webhook event through services (the route verifies first).
// - upload_completed: the post(s) behind the provider request id get the final status
//   (published / failed). "pending" is ignored: the worker keeps polling.
// - account_status: the owning brand's account status (by the provider profile).
// Deliveries are de-duplicated per instance by X-Upload-Post-Delivery (the operations are
// idempotent anyway). Server-only.

import type { UploadPostWebhookEvent } from '@app/posting'
import type { ServicesFromEnv } from '@app/services'

const SEEN_KEY = Symbol.for('app.web.uploadPostDeliveries')
const MAX_SEEN = 5_000

function seen(): Set<string> {
  const g = globalThis as typeof globalThis & { [SEEN_KEY]?: Set<string> }
  g[SEEN_KEY] ??= new Set()
  return g[SEEN_KEY]
}

export interface WebhookOutcome {
  type: UploadPostWebhookEvent['type'] | 'duplicate'
  applied: number
}

export async function applyUploadPostEvent(rt: ServicesFromEnv, event: UploadPostWebhookEvent): Promise<WebhookOutcome> {
  const { services, log } = rt
  if (event.deliveryId) {
    const set = seen()
    if (set.has(event.deliveryId)) return { type: 'duplicate', applied: 0 }
    if (set.size >= MAX_SEEN) set.clear()
    set.add(event.deliveryId)
  }

  if (event.type === 'upload_completed') {
    if (event.status.state === 'pending' || !event.requestId) return { type: event.type, applied: 0 }
    const posts = await services.posts.findByProviderRequest(event.requestId, event.platform ?? undefined)
    let applied = 0
    for (const post of posts) {
      try {
        await services.posts.recordPublishStatus(post.userId, post.id, event.status)
        applied += 1
      } catch (error) {
        log.warn('upload-post webhook: status not applied', { postId: post.id, error: error instanceof Error ? error.message : String(error) })
      }
    }
    return { type: event.type, applied }
  }

  if (event.type === 'account_status') {
    if (!event.platform) return { type: event.type, applied: 0 }
    if (!event.profileRef) {
      // No profile on the event (seen on reauth_required): the next accounts.sync picks it up.
      log.info('upload-post webhook: account event without profile', { platform: event.platform, event: event.event })
      return { type: event.type, applied: 0 }
    }
    const row = await services.maintenance.applyProviderAccountStatus({
      profileRef: event.profileRef,
      platform: event.platform,
      status: event.accountStatus,
    })
    return { type: event.type, applied: row ? 1 : 0 }
  }

  return { type: event.type, applied: 0 }
}

/** Tests only. */
export function resetUploadPostDeliveriesForTests(): void {
  seen().clear()
}
