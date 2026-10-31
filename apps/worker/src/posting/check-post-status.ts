// check_post_status: asks the provider how a submitted post is doing and hands the answer to
// services.posts.recordPublishStatus: published → url / platform post id stored, analytics pulls at
// +24h/+48h/+7d/+30d queued (and X-link metering); failed → failed with the provider's safe
// message; pending → the next poll is queued with backoff (the worker's budget covers ~24 h, then
// the post fails with a clear message).

import { isAppError, type PublishStatus } from '@app/core'
import { isRetryableProviderError, providerErrorReason } from '@app/posting'
import { safeErrorMessage } from '../errors'
import type { Handler } from '../types'
import { payloadOf } from './payload'

/** A provider 404 this early may just be the provider catching up; later it means "never registered". */
const NOT_FOUND_GRACE_POLLS = 2

export interface StatusCheckResult {
  postId: string
  action: 'skip' | 'recorded' | 'republish' | 'failed'
  state?: PublishStatus['state']
  status: string
  nextPollAt?: string
}

export const checkPostStatus: Handler = async (job, ctx): Promise<StatusCheckResult> => {
  const { userId, postId, poll } = payloadOf('check_post_status', job)
  const { services } = ctx
  const post = await services.posts.get(userId, postId)
  // a webhook (or an earlier poll) already settled it
  if (post.status !== 'publishing' || !post.providerRequestId) return { postId, action: 'skip', status: post.status }

  let status: PublishStatus
  try {
    status = await ctx.provider.getStatus(post.providerRequestId)
  } catch (error) {
    const reason = providerErrorReason(error)
    if (reason === 'not_found' && poll > NOT_FOUND_GRACE_POLLS) {
      // the upload never registered: put the post back for a fresh publish attempt
      const row = await services.posts.recordPublishError(userId, postId, error, { retryable: true })
      ctx.logger.warn('provider has no record of the upload; publishing again', { postId, status: row.status })
      return { postId, action: row.status === 'failed' ? 'failed' : 'republish', status: row.status }
    }
    if (reason === 'not_found' || !isAppError(error) || isRetryableProviderError(error)) {
      // a failed poll counts as "still pending": the next poll is queued with backoff (bounded budget)
      ctx.logger.warn('status check failed; polling again later', { postId, poll, error: safeErrorMessage(error) })
      status = { state: 'pending' }
    } else {
      const row = await services.posts.recordPublishError(userId, postId, error, { retryable: false })
      return { postId, action: 'failed', status: row.status }
    }
  }

  const result = await services.posts.recordPublishStatus(userId, postId, status, { poll })
  if (result.post.status === 'published') ctx.logger.info('post published', { postId, platform: result.post.platform })
  else if (result.post.status === 'failed') ctx.logger.warn('post failed', { postId, platform: result.post.platform })
  return {
    postId,
    action: 'recorded',
    state: status.state,
    status: result.post.status,
    ...(result.nextPollAt ? { nextPollAt: result.nextPollAt.toISOString() } : {}),
  }
}
