// publish_post: publishes one approved, due post through the PostingProvider.
//
// services.posts.preparePublish decides (and audits) everything rule-based: approval at the post's
// stored revision, entitlements, brand and account state, the platform cap at dispatch time (full →
// moved +1 h, not failed), media readiness and presigned GET URLs; when the post may go out it is
// claimed (scheduled → publishing, attempts + 1). This handler then calls provider.publish with the
// idempotency key `post:<postId>:<attempt>` and stores the request id (recordPublishRequest also
// queues the first check_post_status). X-link metering happens in services when the post publishes.
//
// Ambiguous provider failures (outage, timeout, key in flight) may have created the upload, so the
// post stays `publishing` and this job is retried: the retry finds the post publishing without a
// request id and publishes again with the SAME key (same attempt), so the provider returns the
// original upload instead of posting twice. Clear refusals go to services.posts.recordPublishError
// (retryable ones are rescheduled with a new attempt; others fail the post with a safe message).

import { AppError, isAppError, type JobRow, type PublishInput } from '@app/core'
import type { PostRow } from '@app/db'
import { isRetryableProviderError, providerErrorReason, retryAfterSeconds } from '@app/posting'
import { DEFAULT_BACKOFF, RetryJobError, retryDelayMs, safeErrorMessage, type BackoffPolicy } from '../errors'
import type { Handler, WorkerContext } from '../types'
import { payloadOf } from './payload'

/** Unclear outcomes are retried patiently (1, 2, 4, 8 min, with jitter) before the post is failed. */
const AMBIGUOUS_RETRY_BACKOFF: BackoffPolicy = { ...DEFAULT_BACKOFF, baseMs: 60_000 }

/** Idempotency key for a publish attempt (stable across retries of the same attempt). */
export function publishIdempotencyKey(postId: string, attempt: number): string {
  return `post:${postId}:${Math.max(1, Math.floor(attempt))}`
}

export interface PublishResult {
  postId: string
  action: 'submitted' | 'skip' | 'deferred' | 'failed' | 'retry_scheduled'
  reason?: string
  status?: PostRow['status']
  until?: string
}

export const publishPost: Handler = async (job, ctx): Promise<PublishResult> => {
  const { userId, postId } = payloadOf('publish_post', job)
  const plan = await ctx.services.posts.preparePublish(userId, postId)
  switch (plan.action) {
    case 'publish':
      return submit(job, ctx, userId, plan.post, plan.input)
    case 'skip':
      if (plan.reason === 'not_scheduled' && wasInterrupted(plan.post)) return resume(job, ctx, userId, plan.post)
      return { postId, action: 'skip', reason: plan.reason, status: plan.post.status }
    case 'deferred':
      ctx.logger.info('publish deferred', { postId, reason: plan.reason, until: plan.until.toISOString() })
      return { postId, action: 'deferred', reason: plan.reason, until: plan.until.toISOString(), status: plan.post.status }
    case 'failed':
      ctx.logger.warn('post not publishable', { postId, reason: plan.reason })
      return { postId, action: 'failed', reason: plan.reason, status: plan.post.status }
  }
}

/** Claimed for publishing, but no provider request was recorded (crash, lost response, outage). */
function wasInterrupted(post: PostRow): boolean {
  return post.status === 'publishing' && !post.providerRequestId
}

async function submit(job: JobRow, ctx: WorkerContext, userId: string, post: PostRow, base: PublishInput): Promise<PublishResult> {
  const input: PublishInput = { ...base, idempotencyKey: publishIdempotencyKey(post.id, post.attempts) }
  let requestId: string
  try {
    ;({ requestId } = await ctx.provider.publish(input))
  } catch (error) {
    return onPublishError(job, ctx, userId, post, error)
  }
  const row = await ctx.services.posts.recordPublishRequest(userId, post.id, requestId)
  ctx.logger.info('post submitted', { postId: post.id, platform: post.platform, attempt: post.attempts })
  return { postId: post.id, action: 'submitted', status: row.status }
}

async function onPublishError(job: JobRow, ctx: WorkerContext, userId: string, post: PostRow, error: unknown): Promise<PublishResult> {
  const reason = providerErrorReason(error)
  const ambiguous = !isAppError(error) || reason === 'provider_unavailable' || reason === 'conflict'
  const after = retryAfterSeconds(error)
  if (ambiguous && job.attempts < job.maxAttempts) {
    ctx.logger.warn('publish outcome unknown; retrying with the same key', { postId: post.id, error: safeErrorMessage(error) })
    const delay = after !== undefined ? after * 1_000 : retryDelayMs(job.attempts, AMBIGUOUS_RETRY_BACKOFF)
    throw new RetryJobError(safeErrorMessage(error, 'Publishing failed.'), delay, { cause: error })
  }
  // Never show internal error text to users: unknown errors become a neutral provider outage.
  const shown = isAppError(error) ? error : new AppError('unavailable', 'The posting service could not be reached.')
  const row = await ctx.services.posts.recordPublishError(userId, post.id, shown, {
    retryable: !ambiguous && isRetryableProviderError(error),
    ...(after !== undefined ? { retryAfterMs: after * 1_000 } : {}),
  })
  ctx.logger.warn('publish refused', { postId: post.id, reason: reason ?? 'error', status: row.status })
  return { postId: post.id, action: row.status === 'failed' ? 'failed' : 'retry_scheduled', ...(reason ? { reason } : {}), status: row.status }
}

/**
 * The post was claimed by an earlier run that never recorded the provider's answer.
 * services.posts.resumePublish rebuilds the input under the same checks as preparePublish
 * (approval at the stored revision, brand, account, media; problems fail the post) and the worker
 * publishes again with the same attempt's key: the provider dedupes it if the first request got through.
 */
async function resume(job: JobRow, ctx: WorkerContext, userId: string, post: PostRow): Promise<PublishResult> {
  const plan = await ctx.services.posts.resumePublish(userId, post.id)
  if (plan.action === 'skip') return { postId: post.id, action: 'skip', reason: plan.reason, status: plan.post.status }
  if (plan.action === 'failed') {
    ctx.logger.warn('interrupted publish not resumed', { postId: post.id, status: plan.post.status })
    return { postId: post.id, action: 'failed', reason: 'resume', status: plan.post.status }
  }
  ctx.logger.info('resuming an interrupted publish', { postId: post.id, attempt: plan.post.attempts })
  return submit(job, ctx, userId, plan.post, plan.input)
}
