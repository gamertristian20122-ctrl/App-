// publish_post + check_post_status through the runner, on PGlite services with the fake provider.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { POST_METRIC_CHECKPOINTS_MS } from '@app/core/time'
import { jobs as jobsRepo } from '@app/db'
import { providerError } from '@app/posting'
import { STATUS_POLL_BUDGET } from '../src/context'
import { postingHandlers, publishIdempotencyKey } from '../src/posting'
import { checkPostStatus } from '../src/posting/check-post-status'
import { publishPost } from '../src/posting/publish-post'
import type { Handler } from '../src/types'
import {
  DAY,
  HOUR,
  SECOND,
  START,
  createWorkerHarness,
  getJob,
  image,
  jobRow,
  jobsOfType,
  makeRunner,
  resetWorkerHarness,
  scheduledPost,
  seedPublishedPost,
  tenant,
  type WorkerHarness,
} from './helpers'

let h: WorkerHarness
beforeAll(async () => {
  h = await createWorkerHarness()
})
afterAll(async () => {
  await h.db.close()
})
beforeEach(async () => {
  await resetWorkerHarness(h)
})

const at = (ms: number) => new Date(START.getTime() + ms)
const handlers = postingHandlers as Partial<Record<'publish_post' | 'check_post_status', Handler>>
const runner = () => makeRunner(h, { publish_post: handlers.publish_post, check_post_status: handlers.check_post_status }, { concurrency: 1 })
const publishCalls = () => h.provider.calls.filter((c) => c.method === 'publish').map((c) => c.input as { idempotencyKey: string; mediaUrls: string[] })

describe('publish_post', () => {
  it('publishes a due post, stores the request id and polls until published', async () => {
    const t = await tenant(h, 'instagram')
    const img = await image(h, t.userId, t.brandId)
    const { post } = await scheduledPost(h, t, { platform: 'instagram', text: 'Launch day', mediaIds: [img.id] })
    const r = runner()

    // not due yet
    expect(await r.drain()).toBe(0)
    h.clock.advance(HOUR)
    expect(await r.drain()).toBe(1)
    let row = await h.services.posts.get(t.userId, post.id)
    expect(row).toMatchObject({ status: 'publishing', attempts: 1 })
    expect(row.providerRequestId).toMatch(/^fake_instagram_/)
    const [call] = publishCalls()
    expect(call?.idempotencyKey).toBe(publishIdempotencyKey(post.id, 1))
    expect(call?.idempotencyKey).toBe(`post:${post.id}:1`)
    expect(call?.mediaUrls).toHaveLength(1)
    const [publishJob] = await jobsOfType(h, 'publish_post')
    expect(publishJob).toMatchObject({ status: 'succeeded', result: { postId: post.id, action: 'submitted', status: 'publishing' } })

    // first status poll after 15 s
    const [check] = await jobsOfType(h, 'check_post_status')
    expect(check?.runAt.toISOString()).toBe(at(HOUR + 15 * SECOND).toISOString())
    h.clock.advance(15 * SECOND)
    expect(await r.drain()).toBe(1)
    row = await h.services.posts.get(t.userId, post.id)
    expect(row.status).toBe('published')
    expect(row.postUrl).toContain('fake-posting.invalid/instagram/')
    expect(row.providerPostId).toBeTruthy()

    // metrics pulls at +24h, +48h, +7d, +30d
    const pulls = await jobsOfType(h, 'analytics_pull')
    expect(pulls.map((j) => j.runAt.getTime() - (row.publishedAt?.getTime() ?? 0)).sort((a, b) => a - b)).toEqual([...POST_METRIC_CHECKPOINTS_MS])
    expect(pulls.every((j) => j.payload.scope === 'post' && j.payload.postId === post.id)).toBe(true)
  })

  it('does not publish a post whose draft changed after approval (scheduled post canceled)', async () => {
    const t = await tenant(h, 'x')
    const { post, draft } = await scheduledPost(h, t, { platform: 'x', text: 'Original text' })
    await h.services.drafts.editVariant(t.userId, { draftId: draft.draft.id, platform: 'x', text: 'Edited after approval' })
    h.clock.advance(HOUR)
    await runner().drain()
    expect(publishCalls()).toHaveLength(0)
    expect((await h.services.posts.get(t.userId, post.id)).status).toBe('canceled')
  })

  it('re-verifies the approval at the stored revision before claiming', async () => {
    const t = await tenant(h, 'x')
    const { post, draft } = await scheduledPost(h, t, { platform: 'x', text: 'Original text' })
    // even if the post were still scheduled (the cancel trigger missed it), the changed draft blocks it
    await h.db.exec('alter table public.drafts disable trigger drafts_after_update')
    try {
      await h.services.drafts.editVariant(t.userId, { draftId: draft.draft.id, platform: 'x', text: 'Edited after approval' })
    } finally {
      await h.db.exec('alter table public.drafts enable trigger drafts_after_update')
    }
    expect((await h.services.posts.get(t.userId, post.id)).status).toBe('scheduled')
    h.clock.advance(HOUR)
    const result = await publishPost(jobRow('publish_post', { userId: t.userId, postId: post.id }), h.context)
    expect(result).toMatchObject({ action: 'skip', reason: 'not_approved' })
    expect(publishCalls()).toHaveLength(0)
    expect((await h.services.posts.get(t.userId, post.id)).status).toBe('scheduled')
  })

  it('reschedules +1 h (not failed) when the platform cap is full at dispatch', async () => {
    const t = await tenant(h, 'x')
    const { post } = await scheduledPost(h, t, { platform: 'x', text: 'Capped' }, 'now')
    // the cap (x: 20 per 24 h) filled up after scheduling
    for (let i = 0; i < 20; i++) await seedPublishedPost(h, t.userId, t.brandId, t.account.id, 'x', new Date(START.getTime() - HOUR + i * SECOND))
    await runner().drain()
    expect(publishCalls()).toHaveLength(0)
    const row = await h.services.posts.get(t.userId, post.id)
    expect(row.status).toBe('scheduled')
    expect(row.scheduledFor.toISOString()).toBe(at(HOUR).toISOString())
    const jobs = await jobsOfType(h, 'publish_post')
    expect(jobs.some((j) => j.status === 'queued' && j.runAt.toISOString() === at(HOUR).toISOString())).toBe(true)
    expect(jobs.find((j) => j.status === 'succeeded')?.result).toMatchObject({ action: 'deferred', reason: 'cap' })
  })

  it('retries an unclear provider failure with the same key, then fails the post', async () => {
    const t = await tenant(h, 'x')
    const { post } = await scheduledPost(h, t, { platform: 'x', text: 'Outage' }, 'now')
    for (let i = 0; i < 5; i++) h.provider.failNextPublish()
    const r = runner()
    for (let i = 0; i < 5; i++) {
      expect(await r.drain()).toBe(1)
      h.clock.advance(DAY)
    }
    const keys = publishCalls().map((c) => c.idempotencyKey)
    expect(keys).toHaveLength(5)
    expect(new Set(keys)).toEqual(new Set([`post:${post.id}:1`]))
    const row = await h.services.posts.get(t.userId, post.id)
    expect(row).toMatchObject({ status: 'failed', attempts: 1 })
    expect(row.error).toContain('unavailable')
    const [job] = await jobsOfType(h, 'publish_post')
    expect(job).toMatchObject({ status: 'succeeded', attempts: 5, result: { action: 'failed' } })
  })

  it('a retried unclear failure that succeeds publishes once', async () => {
    const t = await tenant(h, 'x')
    const { post } = await scheduledPost(h, t, { platform: 'x', text: 'Blip' }, 'now')
    h.provider.failNextPublish()
    const r = runner()
    await r.drain()
    expect((await h.services.posts.get(t.userId, post.id)).status).toBe('publishing')
    h.clock.advance(HOUR)
    await r.drain()
    const row = await h.services.posts.get(t.userId, post.id)
    expect(row.status).toBe('publishing')
    expect(row.providerRequestId).toBeTruthy()
    expect(h.provider.uploads.size).toBe(1)
    expect(publishCalls().map((c) => c.idempotencyKey)).toEqual([`post:${post.id}:1`, `post:${post.id}:1`])
  })

  it('resumes after a crash between claim and request without posting twice', async () => {
    const t = await tenant(h, 'instagram')
    const img = await image(h, t.userId, t.brandId)
    const { post } = await scheduledPost(h, t, { platform: 'instagram', text: 'Crash', mediaIds: [img.id] }, 'now')
    // a worker claimed the post and sent it, then died before recording the request id
    const plan = await h.services.posts.preparePublish(t.userId, post.id)
    if (plan.action !== 'publish') throw new Error('expected publish')
    await h.provider.publish({ ...plan.input, idempotencyKey: publishIdempotencyKey(post.id, plan.post.attempts) })
    expect(h.provider.uploads.size).toBe(1)

    const result = await publishPost(jobRow('publish_post', { userId: t.userId, postId: post.id }, { attempts: 2 }), h.context)
    expect(result).toMatchObject({ action: 'submitted' })
    expect(h.provider.uploads.size).toBe(1)
    const resumed = publishCalls()[1]
    expect(resumed?.idempotencyKey).toBe(`post:${post.id}:1`)
    expect(resumed?.mediaUrls).toHaveLength(1)
    const row = await h.services.posts.get(t.userId, post.id)
    expect(row.providerRequestId).toBeTruthy()
    expect(await jobsOfType(h, 'check_post_status')).toHaveLength(1)
  })

  it('a publish job that died mid-flight is recovered by the cleanup job and published once (integration)', async () => {
    const t = await tenant(h, 'instagram')
    const img = await image(h, t.userId, t.brandId)
    const { post } = await scheduledPost(h, t, { platform: 'instagram', text: 'Died', mediaIds: [img.id] }, 'now')
    // the worker claimed and sent the post, then crashed on the job's last attempt: the lease sweep
    // marks the job dead and nothing would ever settle the post
    const plan = await h.services.posts.preparePublish(t.userId, post.id)
    if (plan.action !== 'publish') throw new Error('expected publish')
    await h.provider.publish({ ...plan.input, idempotencyKey: publishIdempotencyKey(post.id, plan.post.attempts) })
    await h.db.query(`update public.jobs set status = 'dead', finished_at = now() where payload->>'postId' = $1`, [post.id])

    const r = makeRunner(h, { ...handlers, cleanup: (postingHandlers as Record<string, Handler>).cleanup }, { concurrency: 1 })
    await h.services.jobs.enqueue({ type: 'cleanup', payload: { task: 'all' }, idempotencyKey: 'cleanup:test-recover' })
    await r.drain() // cleanup → queues a resume publish_post → resumed with the same key
    await r.drain()
    expect(h.provider.uploads.size).toBe(1)
    expect(publishCalls().map((c) => c.idempotencyKey)).toEqual([`post:${post.id}:1`, `post:${post.id}:1`])
    h.clock.advance(15 * SECOND)
    await r.drain()
    expect((await h.services.posts.get(t.userId, post.id)).status).toBe('published')
  })

  it('does not resume an interrupted publish whose draft changed meanwhile', async () => {
    const t = await tenant(h, 'x')
    const { post, draft } = await scheduledPost(h, t, { platform: 'x', text: 'Before' }, 'now')
    const plan = await h.services.posts.preparePublish(t.userId, post.id)
    expect(plan.action).toBe('publish')
    await h.services.drafts.editVariant(t.userId, { draftId: draft.draft.id, platform: 'x', text: 'After' })
    const result = await publishPost(jobRow('publish_post', { userId: t.userId, postId: post.id }), h.context)
    expect(result).toMatchObject({ action: 'failed', reason: 'resume' })
    expect(publishCalls()).toHaveLength(0)
    const row = await h.services.posts.get(t.userId, post.id)
    expect(row.status).toBe('failed')
    expect(row.error).toMatch(/changed after it was approved/)
  })

  it('reschedules a clear retryable refusal as a new attempt with a new key', async () => {
    const t = await tenant(h, 'x')
    const { post } = await scheduledPost(h, t, { platform: 'x', text: 'Busy' }, 'now')
    h.provider.failNextPublish(providerError('rate_limited', 'Too many requests.', { provider: 'fake', status: 429, retryAfterSec: 120 }))
    const r = runner()
    await r.drain()
    let row = await h.services.posts.get(t.userId, post.id)
    expect(row).toMatchObject({ status: 'scheduled', attempts: 1 })
    expect(row.scheduledFor.toISOString()).toBe(at(120 * SECOND).toISOString())
    h.clock.advance(120 * SECOND)
    await r.drain()
    row = await h.services.posts.get(t.userId, post.id)
    expect(row).toMatchObject({ status: 'publishing', attempts: 2 })
    expect(publishCalls().map((c) => c.idempotencyKey)).toEqual([`post:${post.id}:1`, `post:${post.id}:2`])
  })

  it('fails the post on a definite refusal with the provider’s safe message', async () => {
    const t = await tenant(h, 'x')
    const { post } = await scheduledPost(h, t, { platform: 'x', text: 'Rejected' }, 'now')
    h.provider.failNextPublish(providerError('provider_rejected', 'Duplicate content on this account.', { provider: 'fake', status: 400 }))
    await runner().drain()
    const row = await h.services.posts.get(t.userId, post.id)
    expect(row).toMatchObject({ status: 'failed', error: 'Duplicate content on this account.' })
    const [job] = await jobsOfType(h, 'publish_post')
    expect(job?.status).toBe('succeeded')
  })

  it('sends an invalid payload to dead', async () => {
    const { job } = await jobsRepo.enqueue(h.db, { type: 'publish_post', payload: { userId: 'nope' } })
    await runner().drain()
    expect((await getJob(h, job.id)).status).toBe('dead')
  })
})

describe('check_post_status', () => {
  async function submitted(platform: 'x' | 'instagram' = 'x') {
    const t = await tenant(h, platform)
    const { post } = await scheduledPost(h, t, { platform, text: 'Polling' }, 'now')
    await publishPost(jobRow('publish_post', { userId: t.userId, postId: post.id }), h.context)
    const row = await h.services.posts.get(t.userId, post.id)
    if (!row.providerRequestId) throw new Error('not submitted')
    return { t, post: row, requestId: row.providerRequestId }
  }
  const check = (userId: string, postId: string, poll: number) => checkPostStatus(jobRow('check_post_status', { userId, postId, poll }), h.context)

  it('re-enqueues pending posts with backoff', async () => {
    const { t, post, requestId } = await submitted()
    h.provider.delayStatus(2, requestId)
    const first = await check(t.userId, post.id, 1)
    expect(first).toMatchObject({ action: 'recorded', state: 'pending', status: 'publishing', nextPollAt: at(30 * SECOND).toISOString() })
    const second = await check(t.userId, post.id, 2)
    expect(second).toMatchObject({ state: 'pending', nextPollAt: at(60 * SECOND).toISOString() })
    const third = await check(t.userId, post.id, 3)
    expect(third).toMatchObject({ state: 'published', status: 'published' })
    const polls = await jobsOfType(h, 'check_post_status')
    expect(polls.map((j) => j.payload.poll)).toEqual([1, 2, 3])
  })

  it('marks the post failed with the provider’s safe error', async () => {
    const t = await tenant(h, 'x')
    const { post } = await scheduledPost(h, t, { platform: 'x', text: 'Will fail' }, 'now')
    h.provider.failNextUpload('The platform flagged this post as spam.')
    await publishPost(jobRow('publish_post', { userId: t.userId, postId: post.id }), h.context)
    const result = await check(t.userId, post.id, 1)
    expect(result).toMatchObject({ state: 'failed', status: 'failed' })
    expect((await h.services.posts.get(t.userId, post.id)).error).toBe('The platform flagged this post as spam.')
  })

  it('keeps polling for about 24 h (worker budget), then fails the post', async () => {
    const { t, post, requestId } = await submitted()
    h.provider.delayStatus(1_000, requestId)
    // beyond the services default of 60 polls, still pending
    expect(await check(t.userId, post.id, 61)).toMatchObject({ state: 'pending', status: 'publishing' })
    expect(await check(t.userId, post.id, STATUS_POLL_BUDGET)).toMatchObject({ state: 'pending', status: 'failed' })
    expect((await h.services.posts.get(t.userId, post.id)).error).toMatch(/did not confirm/)
  })

  it('skips posts a webhook already settled', async () => {
    const { t, post, requestId } = await submitted()
    await h.services.posts.recordPublishStatus(t.userId, post.id, await h.provider.getStatus(requestId))
    const before = h.provider.calls.length
    expect(await check(t.userId, post.id, 1)).toMatchObject({ action: 'skip', status: 'published' })
    expect(h.provider.calls.length).toBe(before)
  })

  it('treats a failed status call as pending', async () => {
    const { t, post } = await submitted()
    h.provider.failNext('getStatus')
    const result = await check(t.userId, post.id, 1)
    expect(result).toMatchObject({ state: 'pending', status: 'publishing' })
    expect((await jobsOfType(h, 'check_post_status')).map((j) => j.payload.poll)).toContain(2)
  })

  it('publishes again when the provider never registered the upload', async () => {
    const { t, post } = await submitted()
    const notFound = () => providerError('not_found', 'The posting service has no record of this upload.', { provider: 'fake', status: 404 })
    // early 404s are treated as the provider catching up
    h.provider.failNext('getStatus', notFound())
    expect(await check(t.userId, post.id, 1)).toMatchObject({ state: 'pending' })
    h.provider.failNext('getStatus', notFound())
    const result = await check(t.userId, post.id, 3)
    expect(result).toMatchObject({ action: 'republish', status: 'scheduled' })
    const row = await h.services.posts.get(t.userId, post.id)
    expect(row.scheduledFor.getTime()).toBeGreaterThan(START.getTime())
  })
})
