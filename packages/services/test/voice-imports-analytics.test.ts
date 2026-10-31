import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { HOUR, DAY, START, approvedDraft, connect, createHarness, expectAppError, image, resetHarness, tenant, type Harness } from './helpers'

let h: Harness
beforeAll(async () => {
  h = await createHarness()
})
afterAll(async () => {
  await h.db.close()
})
beforeEach(async () => {
  await resetHarness(h)
})

describe('voice', () => {
  it('saves validated versions; the latest is active', async () => {
    const { userId, brandId } = await tenant(h)
    expect(await h.s.voice.get(userId, brandId)).toBeNull()
    const v1 = await h.s.voice.save(userId, { brandId, profile: { tone: 'warm', do: ['Use short sentences'] } })
    expect(v1).toMatchObject({ version: 1, source: 'manual', profile: { tone: 'warm', emoji_policy: 'sparing', hashtag_policy: 'few' } })
    const v2 = await h.s.voice.save(userId, { brandId, profile: { tone: 'bold', sample_posts: [{ platform: 'x', text: 'We ship.' }] }, source: 'mixed' })
    expect(v2.version).toBe(2)
    expect((await h.s.voice.get(userId, brandId))?.profile.tone).toBe('bold')
    expect(await h.s.voice.versions(userId, brandId)).toHaveLength(2)
    await expectAppError(h.s.voice.save(userId, { brandId, profile: { tone: 'x', emoji_policy: 'tons' } }), 'validation')
    await expectAppError(h.s.voice.save(userId, { brandId, profile: { secret_field: 1 } }), 'validation')
    const other = await tenant(h)
    await expectAppError(h.s.voice.save(other.userId, { brandId, profile: {} }), 'not_found')
    await expectAppError(h.s.voice.get(other.userId, brandId), 'not_found')
  })
})

describe('imports', () => {
  it('queues one job per active account (deduplicated within an hour) and stores pages', async () => {
    const { userId, brandId } = await tenant(h)
    await expectAppError(h.s.imports.importPastPosts(userId, { brandId }), 'validation', /Connect/)
    await connect(h, userId, brandId, 'instagram')
    await connect(h, userId, brandId, 'linkedin')
    const res = await h.s.imports.importPastPosts(userId, { brandId, limitPerPlatform: 20 })
    expect(res.platforms.sort()).toEqual(['instagram', 'linkedin'])
    const again = await h.s.imports.importPastPosts(userId, { brandId })
    expect(again.jobs.map((j) => j.id).sort()).toEqual(res.jobs.map((j) => j.id).sort())
    const only = await h.s.imports.importPastPosts(userId, { brandId, platforms: ['linkedin'] })
    expect(only.platforms).toEqual(['linkedin'])
    await expectAppError(h.s.imports.importPastPosts(userId, { brandId, platforms: ['tiktok'] }), 'validation')

    const saved = await h.s.imports.savePastPosts(userId, {
      brandId,
      platform: 'instagram',
      posts: [
        { platform: 'instagram', externalPostId: 'p1', text: 'Best\r\npost', postedAt: '2026-10-01T10:00:00+0000', permalink: 'https://instagram.com/p/1', metrics: { likes: 100, comments: '5', bogus: 9 } },
        { platform: 'instagram', externalPostId: 'p2', text: 'Meh', postedAt: 'not a date', permalink: 'javascript:alert(1)', metrics: { likes: 1 } },
        { platform: 'x', externalPostId: 'wrong-platform', text: 'skip' },
      ],
    })
    expect(saved).toHaveLength(2)
    expect(saved[0]).toMatchObject({ text: 'Best\npost', metrics: { likes: 100, comments: 5 } })
    expect(saved[1]).toMatchObject({ postedAt: null, permalink: null })
    const samples = await h.s.voice.importedSamples(userId, brandId, { limit: 1 })
    expect(samples.map((s) => s.text)).toEqual(['Best\npost'])
    expect(await h.s.imports.summary(userId, brandId)).toEqual({ total: 2, byPlatform: { instagram: 2 } })
  })
})

describe('analytics', () => {
  async function publish(userId: string, brandId: string, text: string, publishedAt: Date, metrics: Record<string, number>) {
    const img = await image(h, userId, brandId)
    const d = await approvedDraft(h, userId, brandId, [{ platform: 'instagram', text, mediaIds: [img.id] }])
    const [post] = await h.s.posts.schedule(userId, { draftId: d.draft.id, at: 'now' })
    if (!post) throw new Error('post missing')
    await h.r.posts.claimForPublish(userId, post.id)
    await h.r.posts.markPublished(userId, post.id, { publishedAt })
    await h.s.analytics.recordPostMetrics(userId, post.id, metrics, new Date(publishedAt.getTime() + DAY))
    return post
  }

  it('summary and weeklyReview compare the last 7 days with the previous 7', async () => {
    const { userId, brandId } = await tenant(h)
    await connect(h, userId, brandId, 'instagram')
    h.clock.set(new Date(START.getTime() + 14 * DAY))
    const now = h.clock.now()
    // previous week
    await publish(userId, brandId, 'old one', new Date(now.getTime() - 10 * DAY), { likes: 10, views: 1000 })
    // this week
    await publish(userId, brandId, 'great', new Date(now.getTime() - 2 * DAY), { likes: 50, comments: 10, views: 5000 })
    await publish(userId, brandId, 'ok', new Date(now.getTime() - 3 * DAY), { likes: 5, views: 100 })
    await publish(userId, brandId, 'fine', new Date(now.getTime() - 4 * DAY), { likes: 8 })
    await publish(userId, brandId, 'weak', new Date(now.getTime() - 5 * DAY), { likes: 1 })
    await h.s.analytics.recordAccountMetrics(userId, { brandId, platform: 'instagram', metrics: { followers: 100 }, capturedAt: new Date(now.getTime() - 8 * DAY) })
    await h.s.analytics.recordAccountMetrics(userId, { brandId, platform: 'instagram', metrics: { followers: 130 }, capturedAt: new Date(now.getTime() - HOUR) })

    const [summary] = await h.s.analytics.summary(userId, { brandId, days: 7 })
    expect(summary?.period.posts).toBe(4)
    expect(summary?.period.metrics).toMatchObject({ likes: 64, comments: 10, views: 5100 })
    expect(summary?.topPosts[0]?.excerpt).toBe('great')
    expect(summary?.followers).toEqual([{ platform: 'instagram', followers: 130, previous: 100, change: 30 }])

    const review = await h.s.analytics.weeklyReview(userId, brandId)
    expect(review.current.posts).toBe(4)
    expect(review.previous.posts).toBe(1)
    expect(review.change.posts).toBe(300)
    expect(review.change.likes).toBe(540)
    expect(review.topPosts.map((p) => p.excerpt)).toEqual(['great', 'fine', 'ok'])
    expect(review.bottomPosts.map((p) => p.excerpt)).toEqual(['weak', 'ok', 'fine'])
    expect(review.cadence.byWeekday.reduce((a, b) => a + b, 0)).toBe(4)
    expect(review.voiceProfileVersion).toBeNull()

    const other = await tenant(h)
    await expectAppError(h.s.analytics.weeklyReview(other.userId, brandId), 'not_found')
    await expectAppError(h.s.analytics.summary(userId, { days: 400 }), 'validation')
  })

  it('metrics only for published posts; daily account pulls are enqueued once per brand per day', async () => {
    const { userId, brandId } = await tenant(h)
    await connect(h, userId, brandId, 'x')
    const d = await approvedDraft(h, userId, brandId, [{ platform: 'x', text: 'hi' }])
    const [post] = await h.s.posts.schedule(userId, { draftId: d.draft.id, at: 'now' })
    await expectAppError(h.s.analytics.recordPostMetrics(userId, post?.id ?? '', { likes: 1 }), 'conflict')
    await h.s.brands.ensureProviderProfile(userId, brandId)
    expect(await h.s.analytics.enqueueDailyAccountPulls()).toBe(1)
    expect(await h.s.analytics.enqueueDailyAccountPulls()).toBe(0)
  })
})

describe('renders', () => {
  it('queues carousel/video renders with own media only and records outputs under renders/', async () => {
    const { userId, brandId } = await tenant(h)
    const img = await image(h, userId, brandId)
    const job = await h.s.renders.requestCarousel(userId, { brandId, slides: [{ heading: 'One' }, { imageMediaId: img.id }] })
    expect(job).toMatchObject({ type: 'carousel_render', status: 'queued' })
    const other = await tenant(h)
    const foreign = await image(h, other.userId, other.brandId)
    await expectAppError(h.s.renders.requestCarousel(userId, { brandId, slides: [{ imageMediaId: foreign.id }] }), 'validation', /not found/)
    await expectAppError(h.s.renders.requestVideo(userId, { brandId, slides: [{ text: 'a', durationMs: 15_000 }], audioMediaId: img.id }), 'validation', /audio/)
    await expectAppError(h.s.renders.requestVideo(userId, { brandId, slides: Array.from({ length: 13 }, () => ({ text: 'x', durationMs: 15_000 })) }), 'validation', /180/)
    const video = await h.s.renders.requestVideo(userId, { brandId, slides: [{ text: 'Hello' }] })
    expect(video.type).toBe('video_render')

    const key = `users/${userId}/renders/${'12345678-1234-4234-8234-123456789012'}.png`
    const outputs = await h.s.renders.recordOutputs(userId, { brandId, outputs: [{ storageKey: key, kind: 'image', mimeType: 'image/png', bytes: 1000, width: 1080, height: 1350 }] })
    expect(outputs[0]).toMatchObject({ origin: 'render', status: 'ready' })
    expect(await h.s.renders.recordOutputs(userId, { brandId, outputs: [{ storageKey: key, kind: 'image', mimeType: 'image/png', bytes: 1000 }] })).toHaveLength(1)
    await expectAppError(
      h.s.renders.recordOutputs(userId, { brandId, outputs: [{ storageKey: `users/${other.userId}/renders/12345678-1234-4234-8234-123456789012.png`, kind: 'image', mimeType: 'image/png', bytes: 1 }] }),
      'validation',
    )
    await h.r.users.updateBilling(userId, { subscriptionStatus: 'past_due' })
    await expectAppError(h.s.renders.requestCarousel(userId, { brandId, slides: [{ heading: 'One' }] }), 'payment_required')
  })
})
