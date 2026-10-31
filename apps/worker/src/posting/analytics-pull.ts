// analytics_pull: metric snapshots into analytics_snapshots through services.analytics.
// - post scope (queued by services at +24h/+48h/+7d/+30d after publishing): provider.getPostMetrics
//   → recordPostMetrics. At the 24 h checkpoint TikTok posts are re-checked for their late post id.
// - account scope (queued daily per active brand by the scheduler): provider.getAccountMetrics for
//   the brand's active accounts → recordAccountMetrics per platform.
// Empty answers (the provider has no numbers) are not stored.

import { pickMetrics, type Platform } from '@app/core'
import { DAY_MS } from '@app/core/time'
import { safeErrorMessage } from '../errors'
import type { Handler, WorkerContext } from '../types'
import { payloadOf } from './payload'

export interface AnalyticsResult {
  scope: 'post' | 'account'
  action: 'recorded' | 'skip' | 'empty'
  reason?: string
  /** Account scope: platforms with a snapshot. */
  platforms?: Platform[]
}

export const analyticsPull: Handler = async (job, ctx): Promise<AnalyticsResult> => {
  const payload = payloadOf('analytics_pull', job)
  if (payload.scope === 'post') return pullPost(ctx, payload.userId, payload.postId, payload.checkpointMs)
  return pullAccount(ctx, payload.userId, payload.brandId)
}

const hasNumbers = (metrics: unknown) => Object.keys(pickMetrics(metrics)).length > 0

async function pullPost(ctx: WorkerContext, userId: string, postId: string, checkpointMs: number | undefined): Promise<AnalyticsResult> {
  const { services, provider } = ctx
  let post = await services.posts.get(userId, postId)
  if (post.status !== 'published') return { scope: 'post', action: 'skip', reason: post.status }
  const brand = await services.brands.get(userId, post.brandId)
  const profileRef = brand.providerProfileRef
  if (!profileRef) return { scope: 'post', action: 'skip', reason: 'no_profile' }

  // TikTok can confirm the real post id / URL up to 24 h late, and no webhook fires for it.
  if (post.platform === 'tiktok' && checkpointMs === DAY_MS && post.providerRequestId) {
    try {
      const status = await provider.getStatus(post.providerRequestId)
      if (status.state === 'published') post = (await services.posts.recordPublishStatus(userId, postId, status)).post
    } catch (error) {
      ctx.logger.warn('late TikTok status check failed', { postId, error: safeErrorMessage(error) })
    }
  }

  if (!post.providerRequestId && !post.providerPostId) return { scope: 'post', action: 'skip', reason: 'no_reference' }
  const metrics = await provider.getPostMetrics({
    ...(post.providerRequestId ? { requestId: post.providerRequestId } : {}),
    ...(post.providerPostId ? { platformPostId: post.providerPostId } : {}),
    platform: post.platform,
    profileRef,
  })
  if (!hasNumbers(metrics)) return { scope: 'post', action: 'empty' }
  await services.analytics.recordPostMetrics(userId, postId, metrics, ctx.clock.now())
  return { scope: 'post', action: 'recorded' }
}

async function pullAccount(ctx: WorkerContext, userId: string, brandId: string): Promise<AnalyticsResult> {
  const { services, provider } = ctx
  const brand = await services.brands.get(userId, brandId)
  if (brand.status !== 'active') return { scope: 'account', action: 'skip', reason: brand.status }
  const profileRef = brand.providerProfileRef
  if (!profileRef) return { scope: 'account', action: 'skip', reason: 'no_profile' }
  const accounts = await services.accounts.list(userId, { brandId })
  const platforms = [...new Set(accounts.filter((a) => a.status === 'active').map((a) => a.platform))]
  if (platforms.length === 0) return { scope: 'account', action: 'skip', reason: 'no_accounts' }

  const answers = await provider.getAccountMetrics({ profileRef, platforms })
  const capturedAt = ctx.clock.now()
  const recorded: Platform[] = []
  for (const answer of Array.isArray(answers) ? answers : []) {
    // only platforms we asked for, once each, and only real numbers
    if (!answer || !platforms.includes(answer.platform) || recorded.includes(answer.platform)) continue
    if (!hasNumbers(answer.metrics)) continue
    await services.analytics.recordAccountMetrics(userId, { brandId, platform: answer.platform, metrics: answer.metrics, capturedAt })
    recorded.push(answer.platform)
  }
  return { scope: 'account', action: recorded.length > 0 ? 'recorded' : 'empty', platforms: recorded }
}
