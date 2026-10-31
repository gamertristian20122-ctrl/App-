// analytics_pull, import_past_posts and cleanup handlers on PGlite services with the fake provider.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { PastPostInput } from '@app/core'
import { DAY_MS } from '@app/core/time'
import { createTestAccount, createTestBrand, createTestUser } from '@app/db/testing'
import { analyticsPull } from '../src/posting/analytics-pull'
import { cleanup } from '../src/posting/cleanup'
import { IMPORT_PAGE_SIZE, importPastPosts } from '../src/posting/import-past-posts'
import { postingHandlers } from '../src/posting'
import type { Handler } from '../src/types'
import { MINUTE, START, createWorkerHarness, getJob, jobRow, jobsOfType, makeRunner, resetWorkerHarness, scheduledPost, seedPublishedPost, tenant, type WorkerHarness } from './helpers'

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

const PROFILE = 'fake_brand_acme'

async function brandWithProfile(platforms: Array<'instagram' | 'x' | 'tiktok'>, extra: { inactive?: 'x' | 'tiktok' } = {}) {
  const user = await createTestUser(h.db)
  const brand = await createTestBrand(h.db, user.id, { name: 'Acme', providerProfileRef: PROFILE })
  const accounts = []
  for (const platform of platforms) accounts.push(await createTestAccount(h.db, user.id, brand.id, { platform }))
  if (extra.inactive) await createTestAccount(h.db, user.id, brand.id, { platform: extra.inactive, status: 'needs_reauth' })
  return { userId: user.id, brandId: brand.id, accounts }
}

const snapshots = (scope: 'post' | 'account') =>
  h.db.query<{ platform: string; metrics: Record<string, number>; post_id: string | null }>(
    `select platform, metrics, post_id from public.analytics_snapshots where scope = $1 order by platform`,
    [scope],
  )

describe('analytics_pull', () => {
  it('stores post metrics for a published post', async () => {
    const t = await brandWithProfile(['x'])
    const account = t.accounts[0]
    if (!account) throw new Error('account')
    const post = await seedPublishedPost(h, t.userId, t.brandId, account.id, 'x', START)
    h.provider.setPostMetrics(post.providerRequestId ?? '', { views: 1200, likes: 80, comments: 4 })
    const result = await analyticsPull(jobRow('analytics_pull', { scope: 'post', userId: t.userId, postId: post.id, checkpointMs: DAY_MS }), h.context)
    expect(result).toMatchObject({ scope: 'post', action: 'recorded' })
    const [snap] = await snapshots('post')
    expect(snap).toMatchObject({ platform: 'x', post_id: post.id, metrics: { views: 1200, likes: 80, comments: 4 } })
    const call = h.provider.calls.find((c) => c.method === 'getPostMetrics')?.input
    expect(call).toMatchObject({ requestId: post.providerRequestId, platformPostId: post.providerPostId, platform: 'x', profileRef: PROFILE })
  })

  it('re-checks TikTok posts at the 24 h checkpoint', async () => {
    const t = await brandWithProfile(['tiktok'])
    const account = t.accounts[0]
    if (!account) throw new Error('account')
    const post = await seedPublishedPost(h, t.userId, t.brandId, account.id, 'tiktok', START)
    await analyticsPull(jobRow('analytics_pull', { scope: 'post', userId: t.userId, postId: post.id, checkpointMs: DAY_MS }), h.context)
    expect(h.provider.calls.some((c) => c.method === 'getStatus' && c.input === post.providerRequestId)).toBe(true)
    h.provider.calls.length = 0
    await analyticsPull(jobRow('analytics_pull', { scope: 'post', userId: t.userId, postId: post.id, checkpointMs: 2 * DAY_MS }), h.context)
    expect(h.provider.calls.some((c) => c.method === 'getStatus')).toBe(false)
  })

  it('skips posts that are not published and does not store empty answers', async () => {
    const t = await brandWithProfile(['x'])
    const account = t.accounts[0]
    if (!account) throw new Error('account')
    const post = await seedPublishedPost(h, t.userId, t.brandId, account.id, 'x', START)
    h.provider.setPostMetrics(post.providerRequestId ?? '', {})
    expect(await analyticsPull(jobRow('analytics_pull', { scope: 'post', userId: t.userId, postId: post.id }), h.context)).toMatchObject({ action: 'empty' })
    expect(await snapshots('post')).toHaveLength(0)

    const other = await tenant(h, 'x')
    const { post: pending } = await scheduledPost(h, other, { platform: 'x', text: 'Not out yet' })
    expect(await analyticsPull(jobRow('analytics_pull', { scope: 'post', userId: other.userId, postId: pending.id }), h.context)).toMatchObject({
      action: 'skip',
      reason: 'scheduled',
    })
    expect(h.provider.calls.filter((c) => c.method === 'getPostMetrics')).toHaveLength(1)
  })

  it('stores daily account totals for the brand’s active accounts only', async () => {
    const t = await brandWithProfile(['instagram', 'x'], { inactive: 'tiktok' })
    h.provider.setAccountMetrics(PROFILE, 'instagram', { followers: 1500, reach: 9000 })
    h.provider.setAccountMetrics(PROFILE, 'x', { followers: 300 })
    const result = await analyticsPull(jobRow('analytics_pull', { scope: 'account', userId: t.userId, brandId: t.brandId }), h.context)
    expect(result).toMatchObject({ scope: 'account', action: 'recorded' })
    const call = h.provider.calls.find((c) => c.method === 'getAccountMetrics')?.input as { platforms: string[] }
    expect([...call.platforms].sort()).toEqual(['instagram', 'x'])
    const rows = await snapshots('account')
    expect(rows.map((r) => [r.platform, r.metrics])).toEqual([
      ['instagram', { followers: 1500, reach: 9000 }],
      ['x', { followers: 300 }],
    ])
  })

  it('skips brands without a provider profile or accounts', async () => {
    const t = await tenant(h, 'instagram')
    expect(await analyticsPull(jobRow('analytics_pull', { scope: 'account', userId: t.userId, brandId: t.brandId }), h.context)).toMatchObject({
      action: 'skip',
      reason: 'no_profile',
    })
    const bare = await brandWithProfile([])
    expect(await analyticsPull(jobRow('analytics_pull', { scope: 'account', userId: bare.userId, brandId: bare.brandId }), h.context)).toMatchObject({
      action: 'skip',
      reason: 'no_accounts',
    })
  })

  it('retries when the provider is down (through the runner)', async () => {
    const t = await brandWithProfile(['instagram'])
    const { job } = await h.services.jobs.enqueue({ type: 'analytics_pull', payload: { scope: 'account', userId: t.userId, brandId: t.brandId } })
    h.provider.failNext('getAccountMetrics')
    await makeRunner(h, { analytics_pull: postingHandlers.analytics_pull as Handler }).drain()
    const row = await getJob(h, job.id)
    expect(row.status).toBe('failed')
    expect(row.lastError).toMatch(/unavailable/)
  })
})

describe('import_past_posts', () => {
  const pastPosts = (n: number): PastPostInput[] =>
    Array.from({ length: n }, (_, i) => ({
      platform: 'instagram',
      externalPostId: `ig-${i}`,
      text: `Post number ${i}`,
      mediaType: 'IMAGE',
      postedAt: new Date(START.getTime() - (i + 1) * 3_600_000).toISOString(),
      permalink: `https://fake-posting.invalid/instagram/p/ig-${i}`,
      metrics: { likes: i },
    }))
  const count = async () => Number((await h.db.query<{ n: string }>('select count(*)::text as n from public.past_posts'))[0]?.n)

  it('pages through the provider and stores captions and metrics, idempotently', async () => {
    const t = await brandWithProfile(['instagram'])
    const account = t.accounts[0]
    if (!account) throw new Error('account')
    h.provider.setPastPosts(PROFILE, 'instagram', pastPosts(150))
    const payload = { userId: t.userId, brandId: t.brandId, accountId: account.id, platform: 'instagram', limit: 120 }
    const first = await importPastPosts(jobRow('import_past_posts', payload), h.context)
    expect(first).toMatchObject({ action: 'imported', pages: 2, fetched: 120, saved: 120 })
    const listCalls = h.provider.calls.filter((c) => c.method === 'listPastPosts').map((c) => c.input as { cursor?: string; limit: number })
    expect(listCalls).toEqual([
      { profileRef: PROFILE, platform: 'instagram', limit: IMPORT_PAGE_SIZE },
      { profileRef: PROFILE, platform: 'instagram', cursor: 'o:100', limit: 20 },
    ])
    expect(await count()).toBe(120)
    // a second run (job retry or re-import) updates instead of duplicating
    await importPastPosts(jobRow('import_past_posts', payload), h.context)
    expect(await count()).toBe(120)
  })

  it('stops at the last page', async () => {
    const t = await brandWithProfile(['instagram'])
    const account = t.accounts[0]
    if (!account) throw new Error('account')
    h.provider.setPastPosts(PROFILE, 'instagram', pastPosts(7))
    const result = await importPastPosts(jobRow('import_past_posts', { userId: t.userId, brandId: t.brandId, accountId: account.id, platform: 'instagram', limit: 50 }), h.context)
    expect(result).toMatchObject({ pages: 1, fetched: 7, saved: 7 })
  })

  it('skips inactive accounts and refuses mismatched ones', async () => {
    const t = await brandWithProfile(['instagram'], { inactive: 'x' })
    const inactive = (await h.services.accounts.list(t.userId, { brandId: t.brandId })).find((a) => a.platform === 'x')
    if (!inactive) throw new Error('account')
    expect(await importPastPosts(jobRow('import_past_posts', { userId: t.userId, brandId: t.brandId, accountId: inactive.id, platform: 'x', limit: 10 }), h.context)).toMatchObject({
      action: 'skip',
      reason: 'account_inactive',
    })
    await expect(
      importPastPosts(jobRow('import_past_posts', { userId: t.userId, brandId: t.brandId, accountId: inactive.id, platform: 'instagram', limit: 10 }), h.context),
    ).rejects.toThrow(/does not belong/)
  })

  it('runs from the queue job that services create', async () => {
    const t = await brandWithProfile(['instagram'])
    h.provider.setPastPosts(PROFILE, 'instagram', pastPosts(3))
    const requested = await h.services.imports.importPastPosts(t.userId, { brandId: t.brandId, limitPerPlatform: 10 })
    expect(requested.jobs).toHaveLength(1)
    await makeRunner(h, { import_past_posts: postingHandlers.import_past_posts as Handler }).drain()
    const [job] = await jobsOfType(h, 'import_past_posts')
    expect(job).toMatchObject({ status: 'succeeded', result: { saved: 3 } })
    expect(await count()).toBe(3)
  })
})

describe('cleanup', () => {
  it('runs services maintenance (e.g. requeues expired leases)', async () => {
    const { job } = await h.services.jobs.enqueue({ type: 'analytics_pull', payload: { scope: 'account', userId: (await createTestUser(h.db)).id, brandId: '22222222-2222-4222-8222-222222222222' }, runAt: START })
    await h.queue.claim({ workerId: 'gone', types: ['analytics_pull'], leaseSec: 30, limit: 1 })
    h.clock.advance(10 * MINUTE)
    const result = await cleanup(jobRow('cleanup', { task: 'all' }), h.context)
    expect(result).toMatchObject({ requeuedJobs: 1 })
    expect((await getJob(h, job.id)).status).toBe('failed')
  })
})
