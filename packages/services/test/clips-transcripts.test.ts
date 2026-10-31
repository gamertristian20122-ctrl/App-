import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createTestBrand, createTestUser } from '@app/db/testing'
import { FAKE_TRANSCRIPT_TEXT, fakeWords } from '@app/transcription'
import { connect, createHarness, expectAppError, resetHarness, tenant, video, type Harness } from './helpers'

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

/** A transcribed 10-minute clip source (drive link → ingest → transcript). */
async function transcribedSource(userId: string, brandId: string | null) {
  const { media } = await h.s.media.registerDriveLink(userId, {
    ...(brandId ? { brandId } : {}),
    url: 'https://drive.google.com/file/d/xyz/view',
    rightsAttested: true,
  })
  await h.s.media.markIngested(userId, media.id, { durationMs: 600_000, width: 1920, height: 1080 })
  const words = fakeWords(FAKE_TRANSCRIPT_TEXT)
  const segments = [
    { s: 0, e: 30_000, t: 'The first segment talks about pricing.' },
    { s: 30_000, e: 60_000, t: 'Here is the hook nobody expects.' },
    { s: 60_000, e: 600_000, t: 'The rest of the talk.' },
  ]
  await h.s.transcripts.save(userId, media.id, {
    engine: 'fake',
    result: { language: 'en', durationMs: 600_000, text: segments.map((s) => s.t).join(' '), words, segments },
  })
  return media
}

describe('transcripts.get', () => {
  it('returns the whole transcript, a range, and search matches', async () => {
    const { userId, brandId } = await tenant(h)
    const media = await transcribedSource(userId, brandId)
    const all = await h.s.transcripts.get(userId, { mediaId: media.id })
    expect(all).toMatchObject({ status: 'ready', language: 'en', durationMs: 600_000, engine: 'fake' })
    expect(all.segments).toHaveLength(3)
    expect(all.words).toBeUndefined()

    const range = await h.s.transcripts.get(userId, { mediaId: media.id, startMs: '0:30', endMs: '1:00' })
    expect(range.segments.map((s) => s.t)).toEqual(['Here is the hook nobody expects.'])
    expect(range.words?.length).toBeGreaterThan(0)

    const search = await h.s.transcripts.search(userId, media.id, 'HOOK')
    expect(search).toEqual([{ startMs: 30_000, endMs: 60_000, text: 'Here is the hook nobody expects.' }])
    await expectAppError(h.s.transcripts.get(userId, { mediaId: media.id, startMs: 5_000, endMs: 1_000 }), 'validation')
  })

  it('reports processing / not a source, and refuses other users', async () => {
    const { userId } = await tenant(h)
    const { media } = await h.s.media.registerDriveLink(userId, { url: 'https://drive.google.com/x', rightsAttested: true })
    expect((await h.s.transcripts.get(userId, { mediaId: media.id })).status).toBe('processing')
    const clipOut = await video(h, userId)
    expect((await h.s.transcripts.get(userId, { mediaId: clipOut.id })).status).toBe('not_a_source')
    const other = await tenant(h)
    await expectAppError(h.s.transcripts.get(other.userId, { mediaId: media.id }), 'not_found')
    await expectAppError(h.s.transcripts.save(userId, media.id, { engine: 'gpt', result: {} }), 'validation')
  })
})

describe('clips.requestClips', () => {
  it('validates ranges and queues one render job per clip', async () => {
    const { userId, brandId } = await tenant(h)
    const media = await transcribedSource(userId, brandId)
    const clips = await h.s.clips.requestClips(userId, {
      mediaId: media.id,
      ranges: [
        { startMs: '0:30', endMs: '1:00', title: 'The hook', hook: 'Nobody expects this' },
        { startMs: 120_000, endMs: 150_000 },
        { startMs: 120_000, endMs: 150_000 }, // duplicate in the same request
      ],
    })
    expect(clips).toHaveLength(2)
    expect(clips[0]).toMatchObject({ startMs: 30_000, endMs: 60_000, status: 'queued', brandId, captionStyle: 'bold' })
    expect(await h.s.jobs.listForUser(userId, { type: 'clip_render' })).toHaveLength(2)
    // clipping is free once the source is charged
    expect((await h.s.usage.balance(userId)).used).toBe(600)

    await expectAppError(h.s.clips.requestClips(userId, { mediaId: media.id, ranges: [{ startMs: 590_000, endMs: 620_000 }] }), 'validation', /end of the video/)
    await expectAppError(h.s.clips.requestClips(userId, { mediaId: media.id, ranges: [{ startMs: 0, endMs: 181_000 }] }), 'validation', /180/)
    await expectAppError(h.s.clips.requestClips(userId, { mediaId: media.id, ranges: [{ startMs: 0, endMs: 1_000 }] }), 'validation', /at least 3/)
    const many = Array.from({ length: 21 }, (_, i) => ({ startMs: i * 10_000, endMs: i * 10_000 + 5_000 }))
    await expectAppError(h.s.clips.requestClips(userId, { mediaId: media.id, ranges: many }), 'validation', /at most 20/)
  })

  it('limits active clips per source to 60', async () => {
    const { userId, brandId } = await tenant(h)
    const media = await transcribedSource(userId, brandId)
    const batch = (offset: number) => Array.from({ length: 20 }, (_, i) => ({ startMs: (offset + i) * 5_000, endMs: (offset + i) * 5_000 + 4_000 }))
    await h.s.clips.requestClips(userId, { mediaId: media.id, ranges: batch(0) })
    await h.s.clips.requestClips(userId, { mediaId: media.id, ranges: batch(20) })
    await h.s.clips.requestClips(userId, { mediaId: media.id, ranges: batch(40) })
    const err = await expectAppError(h.s.clips.requestClips(userId, { mediaId: media.id, ranges: batch(60).slice(0, 1) }), 'limit_exceeded')
    expect(err.details).toMatchObject({ limit: 60, remaining: 0 })
  })

  it('needs a transcribed own source, an active brand and clipping rights', async () => {
    const { userId, brandId } = await tenant(h)
    const { media } = await h.s.media.registerDriveLink(userId, { url: 'https://drive.google.com/x', rightsAttested: true })
    await expectAppError(h.s.clips.requestClips(userId, { mediaId: media.id, ranges: [{ startMs: 0, endMs: 5_000 }] }), 'conflict', /processing/)
    await h.s.media.markIngested(userId, media.id, { durationMs: 60_000 })
    await expectAppError(h.s.clips.requestClips(userId, { mediaId: media.id, ranges: [{ startMs: 0, endMs: 5_000 }] }), 'conflict', /transcript/)
    const post = await video(h, userId, brandId)
    await expectAppError(h.s.clips.requestClips(userId, { mediaId: post.id, ranges: [{ startMs: 0, endMs: 5_000 }] }), 'validation', /own/)

    const source = await transcribedSource(userId, brandId)
    await h.r.users.updateBilling(userId, { subscriptionStatus: 'past_due' })
    await expectAppError(h.s.clips.requestClips(userId, { mediaId: source.id, ranges: [{ startMs: 0, endMs: 5_000 }] }), 'payment_required')
    await h.r.users.updateBilling(userId, { subscriptionStatus: 'active' })

    const other = await tenant(h)
    await expectAppError(h.s.clips.requestClips(other.userId, { mediaId: source.id, ranges: [{ startMs: 0, endMs: 5_000 }] }), 'not_found')
    await expectAppError(h.s.clips.requestClips(userId, { mediaId: source.id, ranges: [{ startMs: 0, endMs: 5_000 }] }, { brandId: other.brandId }), 'not_found')
  })

  it('a source without a brand needs a brand choice when the user has several', async () => {
    const user = await createTestUser(h.db, { plan: 'plus' })
    const b1 = await createTestBrand(h.db, user.id)
    await createTestBrand(h.db, user.id)
    const media = await transcribedSource(user.id, null)
    await expectAppError(h.s.clips.requestClips(user.id, { mediaId: media.id, ranges: [{ startMs: 0, endMs: 5_000 }] }), 'validation', /brand/)
    const clips = await h.s.clips.requestClips(user.id, { mediaId: media.id, ranges: [{ startMs: 0, endMs: 5_000 }] }, { brandId: b1.id })
    expect(clips[0]?.brandId).toBe(b1.id)
  })
})

describe('clip rendering (worker) → draft that still needs approval', () => {
  it('startRender gives clip-relative words; completeRender creates output media and a draft', async () => {
    const { userId, brandId } = await tenant(h)
    await connect(h, userId, brandId, 'tiktok')
    await connect(h, userId, brandId, 'youtube')
    await connect(h, userId, brandId, 'x')
    const media = await transcribedSource(userId, brandId)
    const [clip] = await h.s.clips.requestClips(userId, { mediaId: media.id, ranges: [{ startMs: 30_000, endMs: 60_000, title: 'Hook', hook: 'Watch this' }] })
    if (!clip) throw new Error('clip missing')

    const job = await h.s.clips.startRender(userId, clip.id)
    expect(job.clip.status).toBe('rendering')
    expect(job.outputKey).toBe(`users/${userId}/clips/${clip.id}.mp4`)
    expect(job.words.length).toBeGreaterThan(0)
    expect(job.words.every((w) => w.s >= 0 && w.e <= 30_000)).toBe(true)

    const { clip: done, draft } = await h.s.clips.completeRender(userId, clip.id, { bytes: 4_000_000, durationMs: 30_000 })
    expect(done).toMatchObject({ status: 'ready', draftId: draft?.id })
    expect(draft).toMatchObject({ status: 'draft', createdVia: 'worker', sourceClipId: clip.id })
    const view = await h.s.drafts.get(userId, draft?.id ?? '')
    expect(view.variants.map((v) => v.platform)).toEqual(['tiktok', 'youtube', 'x'])
    expect(view.variants.find((v) => v.platform === 'youtube')?.title).toBe('Hook')
    // still needs a human: not approved, and TikTok needs its privacy choice first
    expect(view.ready).toBe(false)
    await expectAppError(h.s.posts.schedule(userId, { draftId: draft?.id, at: 'now' }), 'conflict')
    // replay is idempotent
    expect((await h.s.clips.completeRender(userId, clip.id, { bytes: 4_000_000, durationMs: 30_000 })).draft?.id).toBe(draft?.id)
    const out = await h.s.media.get(userId, done.outputMediaId ?? '')
    expect(out).toMatchObject({ origin: 'clip', kind: 'video', parentMediaId: media.id })
  })

  it('failRender marks the clip failed; other users cannot touch it', async () => {
    const { userId, brandId } = await tenant(h)
    const media = await transcribedSource(userId, brandId)
    const [clip] = await h.s.clips.requestClips(userId, { mediaId: media.id, ranges: [{ startMs: 0, endMs: 5_000 }] })
    const other = await tenant(h)
    await expectAppError(h.s.clips.get(other.userId, clip?.id ?? ''), 'not_found')
    await expectAppError(h.s.clips.completeRender(other.userId, clip?.id ?? '', { bytes: 1, durationMs: 1 }), 'not_found')
    const failed = await h.s.clips.failRender(userId, clip?.id ?? '', new Error('ffmpeg exited 1'))
    expect(failed).toMatchObject({ status: 'failed', error: 'ffmpeg exited 1' })
    expect(await h.s.clips.list(userId, { sourceMediaId: media.id, status: 'failed' })).toHaveLength(1)
  })
})
