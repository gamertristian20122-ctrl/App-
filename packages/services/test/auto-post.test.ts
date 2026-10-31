// The Auto-post rule (services/autopost.ts), the switch (brands.setAutoPost, web only), AI uploads
// (media.createAiUpload, completion on first use), URL imports (media.importFromUrl) and the
// autoPublish requests of renders and make_clips.

import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createTestAccount, createTestDraft } from '@app/db/testing'
import { DAY, HOUR, OTHER_UUID, START, browserPut, connect, createHarness, expectAppError, resetHarness, seedPost, tenant, video, type Harness } from './helpers'

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

const ON: { enabled: boolean; platforms: string[]; dailyMax: number; tiktokPrivacy: string | null } = { enabled: true, platforms: [], dailyMax: 3, tiktokPrivacy: null }

/** A tenant with connected video accounts and a ready vertical video. */
async function setup(platforms: Array<'instagram' | 'tiktok' | 'youtube' | 'x' | 'linkedin'> = ['instagram']) {
  const t = await tenant(h)
  const accounts = []
  for (const p of platforms) accounts.push(await connect(h, t.userId, t.brandId, p))
  const media = await video(h, t.userId, t.brandId)
  return { ...t, accounts, media }
}

async function turnOn(userId: string, brandId: string, settings: Partial<typeof ON> = {}) {
  return h.s.brands.setAutoPost(userId, brandId, { ...ON, ...settings }, { via: 'web' })
}

describe('brands.setAutoPost (the switch)', () => {
  it('only the web app may change it; the change is audited', async () => {
    const t = await tenant(h)
    for (const via of ['mcp', 'worker', 'system', 'auto_post', undefined] as const) {
      await expectAppError(h.s.brands.setAutoPost(t.userId, t.brandId, ON, via ? { via } : {}), 'forbidden', /web app/)
    }
    expect((await h.s.brands.get(t.userId, t.brandId)).autoPostEnabled).toBe(false)
    const row = await turnOn(t.userId, t.brandId, { platforms: ['tiktok', 'instagram'], dailyMax: 5, tiktokPrivacy: 'FOLLOWER_OF_CREATOR' })
    expect(row).toMatchObject({ autoPostEnabled: true, autoPostPlatforms: ['tiktok', 'instagram'], autoPostDailyMax: 5, autoPostTiktokPrivacy: 'FOLLOWER_OF_CREATOR' })
    expect(row.autoPostUpdatedAt?.toISOString()).toBe(START.toISOString())
    const audit = await h.s.audit.list(t.userId, { subjectId: t.brandId })
    expect(audit[0]).toMatchObject({ actor: 'web', action: 'brand.auto_post_enabled' })
    await h.s.brands.setAutoPost(t.userId, t.brandId, { enabled: false }, { via: 'web' })
    expect((await h.s.audit.list(t.userId, { subjectId: t.brandId }))[0]?.action).toBe('brand.auto_post_disabled')
  })

  it('validates the settings and refuses other users\' brands', async () => {
    const t = await tenant(h)
    await expectAppError(turnOn(t.userId, t.brandId, { dailyMax: 0 }), 'validation', /at least 1/)
    await expectAppError(turnOn(t.userId, t.brandId, { dailyMax: 26 }), 'validation')
    await expectAppError(turnOn(t.userId, t.brandId, { platforms: ['myspace'] }), 'validation')
    const other = await tenant(h)
    await expectAppError(turnOn(t.userId, other.brandId), 'not_found')
    await expectAppError(turnOn(t.userId, OTHER_UUID), 'not_found')
    expect((await h.s.brands.get(other.userId, other.brandId)).autoPostEnabled).toBe(false)
  })
})

describe('the publish rule (publish_video)', () => {
  it('switch off: the draft waits for approval and says why', async () => {
    const t = await setup()
    const res = await h.s.autoPost.publishVideo(t.userId, { brandId: t.brandId, mediaId: t.media.id, caption: 'Launch day' })
    expect(res.autoPost).toMatchObject({ outcome: 'switch_off', autoPosted: false, posts: [] })
    expect(res.autoPost.message).toMatch(/Auto-post is off for Acme/)
    expect(res.draft.draft).toMatchObject({ status: 'draft', createdVia: 'mcp', autoPostOutcome: 'switch_off', autoPostWhen: 'now' })
    expect(res.draft.variants.map((v) => v.platform)).toEqual(['instagram'])
    expect(await h.s.posts.list(t.userId, { draftId: res.draft.draft.id })).toEqual([])
    // decided once: turning the switch on later does not post this draft
    await turnOn(t.userId, t.brandId)
    expect((await h.s.autoPost.requestForDraft(t.userId, res.draft.draft.id, {}, { via: 'worker' })).outcome).toBe('switch_off')
  })

  it('switch on: approved via auto_post and scheduled at the next minute (caps checked, publish job queued)', async () => {
    const t = await setup(['instagram', 'youtube'])
    await turnOn(t.userId, t.brandId)
    h.clock.set(new Date('2026-11-02T12:00:20.000Z'))
    const res = await h.s.autoPost.publishVideo(t.userId, { brandId: t.brandId, mediaId: t.media.id, caption: 'Behind the scenes\nof our launch' })
    expect(res.autoPost.outcome).toBe('posted')
    expect(res.autoPost.autoPosted).toBe(true)
    expect(res.draft.draft).toMatchObject({ status: 'approved', approvedVia: 'auto_post', autoPostOutcome: 'posted' })
    const posts = res.autoPost.posts
    expect(posts.map((p) => p.platform).sort()).toEqual(['instagram', 'youtube'])
    for (const p of posts) {
      expect(p).toMatchObject({ status: 'scheduled', approvedVia: 'auto_post' })
      expect(p.scheduledFor.toISOString()).toBe('2026-11-02T12:01:00.000Z')
    }
    // YouTube got a title from the caption's first line
    expect(res.draft.variants.find((v) => v.platform === 'youtube')?.title).toBe('Behind the scenes')
    const jobs = await h.s.jobs.listForUser(t.userId, { type: 'publish_post' })
    expect(jobs).toHaveLength(2)
    const audit = await h.s.audit.list(t.userId, { subjectId: res.draft.draft.id })
    expect(audit.some((a) => a.actor === 'auto_post' && a.action === 'draft.approved')).toBe(true)
  })

  it('"best" uses the platform slot in the brand time zone; an ISO time is kept', async () => {
    const t = await setup()
    await turnOn(t.userId, t.brandId)
    await h.s.brands.update(t.userId, t.brandId, { timezone: 'America/New_York' })
    const best = await h.s.autoPost.publishVideo(t.userId, { brandId: t.brandId, mediaId: t.media.id, caption: 'a', when: 'best' })
    expect(best.autoPost.posts[0]?.scheduledFor.toISOString()).toBe('2026-11-02T16:00:00.000Z') // 11:00 in New York
    const iso = await h.s.autoPost.publishVideo(t.userId, { brandId: t.brandId, mediaId: t.media.id, caption: 'b', when: '2026-11-03T10:00:00-05:00' })
    expect(iso.autoPost.posts[0]?.scheduledFor.toISOString()).toBe('2026-11-03T15:00:00.000Z')
    await expectAppError(h.s.autoPost.publishVideo(t.userId, { brandId: t.brandId, mediaId: t.media.id, caption: 'c', when: '2020-01-01T00:00:00Z' }), 'validation', /past/)
  })

  it('platform not on the Auto-post list: waits', async () => {
    const t = await setup(['instagram', 'youtube'])
    await turnOn(t.userId, t.brandId, { platforms: ['instagram'] })
    const res = await h.s.autoPost.publishVideo(t.userId, { brandId: t.brandId, mediaId: t.media.id, caption: 'a' })
    expect(res.autoPost).toMatchObject({ outcome: 'platform_not_allowed', autoPosted: false })
    expect(res.autoPost.message).toMatch(/covers Instagram only; this draft also targets YouTube/)
    // asking only for the allowed platform posts
    const only = await h.s.autoPost.publishVideo(t.userId, { brandId: t.brandId, mediaId: t.media.id, caption: 'a', platforms: ['instagram'] })
    expect(only.autoPost.outcome).toBe('posted')
  })

  it('daily max: counts rule approvals per brand over a rolling 24 h', async () => {
    const t = await setup()
    await turnOn(t.userId, t.brandId, { dailyMax: 2 })
    const send = () => h.s.autoPost.publishVideo(t.userId, { brandId: t.brandId, mediaId: t.media.id, caption: 'a' })
    expect((await send()).autoPost.outcome).toBe('posted')
    h.clock.advance(HOUR)
    expect((await send()).autoPost.outcome).toBe('posted')
    const third = await send()
    expect(third.autoPost.outcome).toBe('daily_max')
    expect(third.autoPost.message).toMatch(/already posted 2 drafts .* daily limit is 2/)
    expect(third.draft.draft.status).toBe('draft')
    h.clock.advance(DAY - HOUR + 60_000)
    expect((await send()).autoPost.outcome).toBe('posted')
  })

  it('platform caps are enforced exactly as schedule_post does ("now" refuses, "best" moves on)', async () => {
    const t = await setup(['instagram'])
    await turnOn(t.userId, t.brandId, { dailyMax: 25 })
    const account = t.accounts[0]
    if (!account) throw new Error('account')
    for (let i = 0; i < 50; i++) await seedPost(h, t.userId, t.brandId, account.id, 'instagram', new Date(START.getTime() + 2 * 60_000 + i * 1000))
    const now = await h.s.autoPost.publishVideo(t.userId, { brandId: t.brandId, mediaId: t.media.id, caption: 'a' })
    expect(now.autoPost.outcome).toBe('cap_reached')
    expect(now.autoPost.message).toMatch(/Instagram allows 50 posts per account in any 24 hours/)
    expect(now.draft.draft.status).toBe('draft')
    const best = await h.s.autoPost.publishVideo(t.userId, { brandId: t.brandId, mediaId: t.media.id, caption: 'b', when: 'best' })
    expect(best.autoPost.outcome).toBe('posted')
    expect(best.autoPost.posts[0]?.scheduledFor.getTime()).toBeGreaterThan(START.getTime() + DAY)
  })

  it('the X link rule still applies (refused before anything is posted)', async () => {
    const t = await setup(['x'])
    await turnOn(t.userId, t.brandId)
    await expectAppError(
      h.s.autoPost.publishVideo(t.userId, { brandId: t.brandId, mediaId: t.media.id, caption: 'Watch https://example.com/launch' }),
      'validation',
      /X: Links are not supported/,
    )
    expect((await h.s.drafts.list(t.userId)).items).toHaveLength(0)
  })

  it('TikTok posts only with the privacy the person chose in the Auto-post settings', async () => {
    const t = await setup(['tiktok'])
    await turnOn(t.userId, t.brandId)
    const missing = await h.s.autoPost.publishVideo(t.userId, { brandId: t.brandId, mediaId: t.media.id, caption: 'a' })
    expect(missing.autoPost.outcome).toBe('not_ready')
    expect(missing.autoPost.message).toMatch(/Choose who can see auto-posted TikTok videos/)
    await turnOn(t.userId, t.brandId, { tiktokPrivacy: 'PUBLIC_TO_EVERYONE' })
    const ok = await h.s.autoPost.publishVideo(t.userId, { brandId: t.brandId, mediaId: t.media.id, caption: 'b' })
    expect(ok.autoPost.outcome).toBe('posted')
    expect(ok.draft.variants[0]?.options).toMatchObject({ privacyLevel: 'PUBLIC_TO_EVERYONE' })
    expect(ok.draft.draft).toMatchObject({ status: 'approved', revision: 2, approvedRevision: 2 })
  })

  it('validation problems found at publish strictness keep the draft waiting (e.g. a plan on hold)', async () => {
    const t = await setup()
    await turnOn(t.userId, t.brandId)
    await h.db.query(`update public.users set subscription_status = 'past_due' where id = $1`, [t.userId])
    const ok = await h.s.autoPost.publishVideo(t.userId, { brandId: t.brandId, mediaId: t.media.id, caption: 'a' })
    // past_due may still create and publish
    expect(ok.autoPost.outcome).toBe('posted')
    await h.db.query(`update public.users set subscription_status = 'canceled' where id = $1`, [t.userId])
    await expectAppError(h.s.autoPost.publishVideo(t.userId, { brandId: t.brandId, mediaId: t.media.id, caption: 'a' }), 'payment_required')
  })

  it('refuses other users\' ids, non-video media and platforms that are not connected', async () => {
    const t = await setup(['instagram'])
    const other = await setup(['instagram'])
    await expectAppError(h.s.autoPost.publishVideo(t.userId, { brandId: other.brandId, mediaId: t.media.id, caption: 'a' }), 'not_found')
    await expectAppError(h.s.autoPost.publishVideo(t.userId, { brandId: t.brandId, mediaId: other.media.id, caption: 'a' }), 'not_found')
    await expectAppError(h.s.autoPost.publishVideo(t.userId, { brandId: t.brandId, mediaId: t.media.id, caption: 'a', platforms: ['youtube'] }), 'validation', /YouTube is not connected/)
    const img = await h.r.media.create(t.userId, { kind: 'image', origin: 'upload', status: 'ready', storageKey: `users/${t.userId}/uploads/${randomUUID()}.jpg`, mimeType: 'image/jpeg', bytes: 10 })
    await expectAppError(h.s.autoPost.publishVideo(t.userId, { brandId: t.brandId, mediaId: img.id, caption: 'a' }), 'validation', /takes a video/)
    const otherDraft = await createTestDraft(h.db, other.userId, other.brandId)
    await expectAppError(h.s.autoPost.requestForDraft(t.userId, otherDraft.draft.id, {}), 'not_found')
  })

  it('only AI/worker drafts, only AI/worker requests', async () => {
    const t = await setup()
    await turnOn(t.userId, t.brandId)
    const web = await createTestDraft(h.db, t.userId, t.brandId, { createdVia: 'web', variants: [{ platform: 'instagram', text: 'hi', mediaIds: [t.media.id] }] })
    expect((await h.s.autoPost.requestForDraft(t.userId, web.draft.id, {}, { via: 'worker' })).outcome).toBe('skipped')
    const ai = await createTestDraft(h.db, t.userId, t.brandId, { createdVia: 'mcp', variants: [{ platform: 'instagram', text: 'hi', mediaIds: [t.media.id] }] })
    await expectAppError(h.s.autoPost.requestForDraft(t.userId, ai.draft.id, {}, { via: 'web' }), 'forbidden')
    const posted = await h.s.autoPost.requestForDraft(t.userId, ai.draft.id, { when: 'now' }, { via: 'worker' })
    expect(posted.outcome).toBe('posted')
    // idempotent (a retried job gets the same answer, nothing is scheduled twice)
    const again = await h.s.autoPost.requestForDraft(t.userId, ai.draft.id, { when: 'now' }, { via: 'worker' })
    expect(again).toMatchObject({ outcome: 'posted', autoPosted: true })
    expect(again.posts.map((p) => p.id)).toEqual(posted.posts.map((p) => p.id))
    expect(await h.s.autoPost.status(t.userId, ai.draft.id)).toMatchObject({ outcome: 'posted' })
    expect(await h.s.autoPost.status(t.userId, web.draft.id)).toMatchObject({ outcome: 'skipped' })
  })
})

describe('AI uploads and processing', () => {
  it('upload_media: a presigned PUT for post media (never a clip source), completed on first use', async () => {
    const t = await setup(['instagram'])
    const body = new Uint8Array(4096).fill(1)
    const up = await h.s.media.createAiUpload(t.userId, { brandId: t.brandId, filename: 'renders/final cut.mp4', contentType: 'video/mp4', bytes: body.length })
    expect(up.upload.mode).toBe('single')
    expect(up.media).toMatchObject({ kind: 'video', origin: 'upload', status: 'pending', rightsAttestedAt: null })
    // not uploaded yet: publish_video says what to do
    await expectAppError(h.s.autoPost.publishVideo(t.userId, { brandId: t.brandId, mediaId: up.media.id, caption: 'a' }), 'validation', /not been uploaded yet/)
    if (up.upload.mode !== 'single') throw new Error('single')
    expect((await browserPut(h.storage, up.upload.url, up.upload.headers, body)).status).toBe(200)

    await turnOn(t.userId, t.brandId)
    const res = await h.s.autoPost.publishVideo(t.userId, { brandId: t.brandId, mediaId: up.media.id, caption: 'Made with code' })
    expect(res.autoPost.outcome).toBe('waiting_for_media')
    expect(res.autoPost.message).toMatch(/still processing/)
    expect(res.draft.draft.autoPostDecidedAt).toBeNull()
    expect(await h.s.jobs.listForUser(t.userId, { type: 'source_ingest' })).toHaveLength(1)
    // the worker probes it: the rule decides in the same transaction
    await h.s.media.markIngested(t.userId, up.media.id, { durationMs: 12_000, width: 1080, height: 1920 })
    const after = await h.s.autoPost.status(t.userId, res.draft.draft.id)
    expect(after).toMatchObject({ outcome: 'posted', autoPosted: true })
    expect(after?.posts).toHaveLength(1)
    // no clipping time was charged for post media
    expect((await h.s.usage.balance(t.userId, 'clip_seconds')).used).toBe(0)
  })

  it('the rule re-checks the switch when the file is ready', async () => {
    const t = await setup(['instagram'])
    const up = await h.s.media.createAiUpload(t.userId, { filename: 'a.mp4', contentType: 'video/mp4', bytes: 10 })
    await h.storage.putBytes(up.media.storageKey, new Uint8Array(10), 'video/mp4')
    await turnOn(t.userId, t.brandId)
    const res = await h.s.autoPost.publishVideo(t.userId, { brandId: t.brandId, mediaId: up.media.id, caption: 'a' })
    expect(res.autoPost.outcome).toBe('waiting_for_media')
    await h.s.brands.setAutoPost(t.userId, t.brandId, { enabled: false }, { via: 'web' })
    await h.s.media.markIngested(t.userId, up.media.id, { durationMs: 5_000 })
    expect(await h.s.autoPost.status(t.userId, res.draft.draft.id)).toMatchObject({ outcome: 'switch_off' })
  })

  it('create_draft also completes a pending AI upload, and refuses a wrong size', async () => {
    const t = await setup(['instagram'])
    const up = await h.s.media.createAiUpload(t.userId, { filename: 'a.jpg', contentType: 'image/jpeg', bytes: 100 })
    await h.storage.putBytes(up.media.storageKey, new Uint8Array(100), 'image/jpeg')
    const view = await h.s.drafts.create(t.userId, { brandId: t.brandId, variants: [{ platform: 'instagram', text: 'pic', mediaIds: [up.media.id] }] })
    expect(view.ready).toBe(true)
    expect((await h.s.media.get(t.userId, up.media.id)).status).toBe('ready')
    const bad = await h.s.media.createAiUpload(t.userId, { filename: 'b.jpg', contentType: 'image/jpeg', bytes: 100 })
    await h.storage.putBytes(bad.media.storageKey, new Uint8Array(99), 'image/jpeg')
    await expectAppError(
      h.s.drafts.create(t.userId, { brandId: t.brandId, variants: [{ platform: 'instagram', text: 'pic', mediaIds: [bad.media.id] }] }),
      'validation',
      /declared 100 bytes, received 99/,
    )
    await expectAppError(h.s.media.createAiUpload(t.userId, { filename: 'a.mp4', contentType: 'video/mp4', bytes: 10, kind: 'image' }), 'validation')
  })
})

describe('media.importFromUrl', () => {
  it('refuses video-platform hosts and private addresses before anything is stored', async () => {
    const t = await tenant(h)
    for (const url of [
      'https://www.youtube.com/watch?v=abc',
      'https://youtu.be/abc',
      'https://www.tiktok.com/@a/video/1',
      'https://www.instagram.com/reel/x/',
      'https://www.facebook.com/watch?v=1',
      'https://x.com/a/status/1',
      'https://twitter.com/a/status/1',
      'https://vimeo.com/1',
      'https://www.twitch.tv/videos/1',
    ]) {
      await expectAppError(h.s.media.importFromUrl(t.userId, { url }), 'validation', /video sites are not accepted/)
    }
    for (const url of ['https://127.0.0.1/a.mp4', 'https://10.0.0.8/a.mp4', 'https://[::1]/a.mp4', 'https://169.254.169.254/latest', 'https://localhost/a.mp4', 'http://cdn.example.com/a.mp4']) {
      await expectAppError(h.s.media.importFromUrl(t.userId, { url }), 'validation')
    }
    expect((await h.s.media.list(t.userId)).items).toEqual([])
  })

  it('queues a url_import job for a public https link; post media, no clipping time, link dropped after ingest', async () => {
    const t = await tenant(h)
    const { media } = await h.s.media.importFromUrl(t.userId, { url: 'https://cdn.example.com/renders/final.mp4?sig=1', brandId: t.brandId })
    expect(media).toMatchObject({ origin: 'url_import', status: 'pending', kind: 'video', sourceHost: 'cdn.example.com', rightsAttestedAt: null })
    expect('sourceUrl' in media).toBe(false)
    const jobs = await h.s.jobs.listForUser(t.userId, { type: 'url_import' })
    expect(jobs).toHaveLength(1)
    expect((await h.s.media.getForWorker(t.userId, media.id)).sourceUrl).toBe('https://cdn.example.com/renders/final.mp4?sig=1')
    const done = await h.s.media.markIngested(t.userId, media.id, { durationMs: 9_000, width: 1080, height: 1920, mimeType: 'video/mp4' })
    expect(done).toMatchObject({ transcribe: false, media: { status: 'ready' } })
    expect((await h.s.media.getForWorker(t.userId, media.id)).sourceUrl).toBeNull()
    expect((await h.s.usage.balance(t.userId, 'clip_seconds')).used).toBe(0)
    // clip sources still need the web rights checkbox: an imported video cannot be clipped
    await expectAppError(h.s.clips.requestClips(t.userId, { mediaId: media.id, ranges: [{ startMs: 0, endMs: 5_000 }] }), 'validation', /rights/)
  })

  it('limits links waiting to be fetched and refuses another user\'s brand', async () => {
    const t = await tenant(h)
    for (let i = 0; i < 5; i++) await h.s.media.importFromUrl(t.userId, { url: `https://cdn.example.com/${i}.mp4` })
    await expectAppError(h.s.media.importFromUrl(t.userId, { url: 'https://cdn.example.com/6.mp4' }), 'limit_exceeded')
    const other = await tenant(h)
    await expectAppError(h.s.media.importFromUrl(other.userId, { url: 'https://cdn.example.com/a.mp4', brandId: t.brandId }), 'not_found')
  })
})

describe('autoPublish on renders and clips', () => {
  it('render_code_video: validated, queued with its input, a few at a time per user', async () => {
    const t = await tenant(h)
    const input = { brandId: t.brandId, html: '<div>hi</div>', durationMs: 3_000, autoPublish: { when: 'best' } }
    const job = await h.s.renders.requestCodeVideo(t.userId, input)
    expect(job).toMatchObject({ type: 'code_video_render', status: 'queued' })
    const row = await h.r.jobs.get(job.id)
    expect(row?.payload).toMatchObject({ userId: t.userId, brandId: t.brandId, input: { html: '<div>hi</div>', durationMs: 3_000, fps: 30, aspect: '9:16', autoPublish: { when: 'best' } } })
    await expectAppError(h.s.renders.requestCodeVideo(t.userId, { ...input, durationMs: 61_000 }), 'validation')
    await expectAppError(h.s.renders.requestCodeVideo(t.userId, { ...input, autoPublish: { when: '2020-01-01T00:00:00Z' } }), 'validation', /past/)
    await expectAppError(h.s.renders.requestCodeVideo(t.userId, { ...input, audioMediaId: OTHER_UUID }), 'validation', /not found/)
    await h.s.renders.requestCodeVideo(t.userId, input)
    await h.s.renders.requestCodeVideo(t.userId, input)
    await expectAppError(h.s.renders.requestCodeVideo(t.userId, input), 'limit_exceeded', /still rendering/)
    const other = await tenant(h)
    await expectAppError(h.s.renders.requestCodeVideo(other.userId, input), 'not_found')
  })

  it('render_video and make_clips carry autoPublish to the worker', async () => {
    const t = await tenant(h)
    const job = await h.s.renders.requestVideo(t.userId, { brandId: t.brandId, slides: [{ text: 'a' }], autoPublish: { platforms: ['tiktok'] } })
    expect((await h.r.jobs.get(job.id))?.payload).toMatchObject({ input: { autoPublish: { platforms: ['tiktok'], when: 'now' } } })
    const source = await h.r.media.create(t.userId, {
      kind: 'video',
      origin: 'upload',
      status: 'ready',
      storageKey: `users/${t.userId}/sources/${randomUUID()}.mp4`,
      durationMs: 60_000,
      rightsAttestedAt: START,
    })
    await h.r.transcripts.save(t.userId, { mediaId: source.id, engine: 'fake', language: 'en', durationMs: 60_000, text: 'hi', words: [], segments: [] })
    const clips = await h.s.clips.requestClips(t.userId, { mediaId: source.id, brandId: t.brandId, ranges: [{ startMs: 0, endMs: 5_000 }], autoPublish: { when: 'best' } })
    const jobs = await h.s.jobs.listForUser(t.userId, { type: 'clip_render' })
    const payload = (await h.r.jobs.get(jobs[0]?.id ?? ''))?.payload
    expect(payload).toMatchObject({ clipId: clips[0]?.id, autoPublish: { when: 'best' } })
  })

  it('completeRender can limit the clip draft to the requested platforms', async () => {
    const t = await tenant(h)
    await connect(h, t.userId, t.brandId, 'instagram')
    await createTestAccount(h.db, t.userId, t.brandId, { platform: 'youtube' })
    const source = await h.r.media.create(t.userId, { kind: 'video', origin: 'upload', status: 'ready', storageKey: `users/${t.userId}/sources/${randomUUID()}.mp4`, durationMs: 60_000, rightsAttestedAt: START })
    const clip = (await h.r.clips.createMany(t.userId, [{ brandId: t.brandId, sourceMediaId: source.id, startMs: 0, endMs: 5_000, title: 'T', hook: 'H' }]))[0]
    if (!clip) throw new Error('clip')
    const done = await h.s.clips.completeRender(t.userId, clip.id, { bytes: 10, durationMs: 5_000 }, { platforms: ['youtube'] })
    const draft = await h.s.drafts.get(t.userId, done.draft?.id ?? '')
    expect(draft.variants.map((v) => v.platform)).toEqual(['youtube'])
  })
})
