// Media handlers end to end on PGlite services + MemoryStorage + FakeTranscriber, with real ffmpeg
// fixtures generated at test time and a mocked fetch for cloud-drive links (no network).

import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { JobType } from '@app/core'
import { sha256Hex } from '@app/core/crypto'
import { SOURCE_URL_MESSAGES } from '@app/core/links'
import { createTestAccount } from '@app/db/testing'
import { sourceKey } from '@app/storage'
import { FakeTranscriber, transcriptionError } from '@app/transcription'
import { JobAbortedError, PermanentJobError } from '../../errors'
import type { Handler } from '../../types'
import { START, createWorkerHarness, jobRow, jobsOfType, makeRunner, resetWorkerHarness, tenant, type WorkerHarness } from '../../../test/helpers'
import { createClipRender } from '../clip-render'
import { DRIVE_MESSAGES, type FetchLike } from '../drive'
import { createMediaHandlers, mediaHandlers } from '../index'
import { INGEST_MESSAGES, createSourceIngest } from '../source-ingest'
import { TRANSCRIBE_MESSAGES, createTranscribe } from '../transcribe'
import { bytesOf, createFixtures, fileResponse, probeBytes, redirectResponse, type Fixtures } from './fixtures'

let h: WorkerHarness
let fx: Fixtures
beforeAll(async () => {
  ;[h, fx] = await Promise.all([createWorkerHarness(), createFixtures()])
}, 120_000)
afterAll(async () => {
  await h.db.close()
  await fx.cleanup()
})
beforeEach(async () => {
  await resetWorkerHarness(h)
  h.storage.clear()
  h.context.transcriber = new FakeTranscriber({ requireFile: true })
})

const ingest = createSourceIngest({ streamSources: false })
const transcribe = createTranscribe({ streamSources: false })
const clipRender = createClipRender({ streamSources: false })

/** A browser upload through the services (presign → bytes in storage → complete), as the web app does. */
async function upload(userId: string, path: string, contentType: string, options: { clipSource?: boolean; brandId?: string } = {}) {
  const bytes = await bytesOf(path)
  const clipSource = options.clipSource ?? true
  const created = await h.services.media.createUpload(
    userId,
    { filename: 'talk.mp4', contentType, bytes: bytes.byteLength, rightsAttested: clipSource, ...(options.brandId ? { brandId: options.brandId } : {}) },
    { purpose: clipSource ? 'clip_source' : 'post' },
  )
  await h.storage.putBytes(created.media.storageKey, bytes, contentType)
  const done = await h.services.media.completeUpload(userId, created.media.id)
  expect(done.ingestQueued).toBe(true)
  return { media: created.media, bytes }
}

async function ingested(userId: string, path = fx.landscape) {
  const { media } = await upload(userId, path, 'video/mp4')
  const outcome = await ingest(jobRow('source_ingest', { userId, mediaId: media.id }), h.context)
  expect(outcome).toMatchObject({ status: 'ready' })
  return h.services.media.getForWorker(userId, media.id)
}

async function transcribed(userId: string, path = fx.landscape) {
  const media = await ingested(userId, path)
  await transcribe(jobRow('transcribe', { userId, mediaId: media.id }), h.context)
  return media
}

const usage = (userId: string) => h.services.usage.balance(userId, 'clip_seconds')

describe('source_ingest (uploads)', () => {
  it('probes, hashes, promotes the upload to its source key, reserves clipping time and queues transcription', async () => {
    const t = await tenant(h, 'tiktok')
    const { media, bytes } = await upload(t.userId, fx.landscape, 'video/mp4', { brandId: t.brandId })
    const outcome = await ingest(jobRow('source_ingest', { userId: t.userId, mediaId: media.id }), h.context)
    expect(outcome).toMatchObject({ mediaId: media.id, status: 'ready', transcribe: true })

    const row = await h.services.media.getForWorker(t.userId, media.id)
    expect(row).toMatchObject({ status: 'ready', width: 640, height: 360, bytes: bytes.byteLength, sha256: sha256Hex(bytes), mimeType: 'video/mp4' })
    expect(row.durationMs).toBeGreaterThanOrEqual(3_900)
    expect(row.durationMs).toBeLessThanOrEqual(4_100)
    // immutable source key; the presigned-upload key is gone
    expect(row.storageKey).toBe(sourceKey(t.userId, media.id, 'mp4'))
    expect(h.storage.has(row.storageKey)).toBe(true)
    expect(h.storage.has(media.storageKey)).toBe(false)

    const balance = await usage(t.userId)
    expect(balance.reserved).toBe(Math.ceil((row.durationMs ?? 0) / 1000))
    expect(await jobsOfType(h, 'transcribe')).toHaveLength(1)

    // idempotent: a second run is a no-op (one reservation, one transcribe job)
    expect(await ingest(jobRow('source_ingest', { userId: t.userId, mediaId: media.id }), h.context)).toMatchObject({ status: 'ready', skipped: true })
    expect((await usage(t.userId)).reserved).toBe(balance.reserved)
    expect(await jobsOfType(h, 'transcribe')).toHaveLength(1)
  })

  it('keeps post videos (not clip sources) at their upload key and does not meter them', async () => {
    const t = await tenant(h)
    const { media } = await upload(t.userId, fx.portrait, 'video/mp4', { clipSource: false })
    expect(await ingest(jobRow('source_ingest', { userId: t.userId, mediaId: media.id }), h.context)).toMatchObject({ status: 'ready', transcribe: false })
    const row = await h.services.media.getForWorker(t.userId, media.id)
    expect(row).toMatchObject({ storageKey: media.storageKey, width: 480, height: 640, status: 'ready' })
    expect((await usage(t.userId)).reserved).toBe(0)
    expect(await jobsOfType(h, 'transcribe')).toHaveLength(0)
  })

  it('refuses files without a video stream and non-media files (media failed, nothing reserved)', async () => {
    const t = await tenant(h)
    const audio = await upload(t.userId, fx.audioOnly, 'video/mp4')
    expect(await ingest(jobRow('source_ingest', { userId: t.userId, mediaId: audio.media.id }), h.context)).toEqual({
      mediaId: audio.media.id,
      status: 'failed',
      error: INGEST_MESSAGES.noVideo,
    })
    const text = await upload(t.userId, fx.text, 'video/mp4')
    expect(await ingest(jobRow('source_ingest', { userId: t.userId, mediaId: text.media.id }), h.context)).toMatchObject({ status: 'failed', error: INGEST_MESSAGES.unreadable })
    for (const id of [audio.media.id, text.media.id]) expect((await h.services.media.get(t.userId, id)).status).toBe('failed')
    expect((await usage(t.userId)).reserved).toBe(0)
    expect(await jobsOfType(h, 'transcribe')).toHaveLength(0)
  })

  it('reports a refusal from services (not enough clipping time) as a failed media', async () => {
    const t = await tenant(h)
    const limit = (await usage(t.userId)).limit
    await h.services.usage.reserve(t.userId, { meter: 'clip_seconds', amount: limit - 1, idempotencyKey: `test:${randomUUID()}` })
    const { media } = await upload(t.userId, fx.landscape, 'video/mp4')
    const outcome = await ingest(jobRow('source_ingest', { userId: t.userId, mediaId: media.id }), h.context)
    expect(outcome).toMatchObject({ status: 'failed' })
    expect((outcome as { error: string }).error).toMatch(/clipping|hours|time|limit/i)
    expect((await h.services.media.get(t.userId, media.id)).status).toBe('failed')
  })

  it('fails the media for good when the uploaded object is missing', async () => {
    const t = await tenant(h)
    const { media } = await upload(t.userId, fx.landscape, 'video/mp4')
    await h.storage.delete(media.storageKey)
    expect(await ingest(jobRow('source_ingest', { userId: t.userId, mediaId: media.id }), h.context)).toMatchObject({ status: 'failed', error: INGEST_MESSAGES.missingUpload })
  })
})

describe('source_ingest (cloud-drive links)', () => {
  const driveLink = 'https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQr/view?usp=sharing'

  function mockFetch(responses: Array<Response | ((url: string) => Response)>) {
    const calls: string[] = []
    const fetch: FetchLike = async (url, init) => {
      calls.push(url)
      expect(init?.redirect).toBe('manual')
      const next = responses.shift()
      if (!next) throw new Error(`unexpected fetch of ${url}`)
      return typeof next === 'function' ? next(url) : next
    }
    return { fetch, calls }
  }

  it('downloads through allowed redirects, stores the file, clears the link and reserves', async () => {
    const t = await tenant(h)
    const { media } = await h.services.media.registerDriveLink(t.userId, { url: driveLink, rightsAttested: true })
    const bytes = await bytesOf(fx.landscape)
    const { fetch, calls } = mockFetch([redirectResponse('https://doc-0c-2g-docs.googleusercontent.com/docs/securesc/abc/file'), fileResponse(bytes, 'application/octet-stream')])
    const handler = createSourceIngest({ fetch, streamSources: false })
    expect(await handler(jobRow('source_ingest', { userId: t.userId, mediaId: media.id }), h.context)).toMatchObject({ status: 'ready', transcribe: true })

    expect(calls[0]).toBe('https://drive.usercontent.google.com/download?id=1AbCdEfGhIjKlMnOpQr&export=download&confirm=t')
    const row = await h.services.media.getForWorker(t.userId, media.id)
    expect(row).toMatchObject({ status: 'ready', sourceUrl: null, mimeType: 'video/mp4', width: 640, height: 360, sha256: sha256Hex(bytes) })
    expect(h.storage.getBytes(row.storageKey)?.byteLength).toBe(bytes.byteLength)
    expect((await usage(t.userId)).reserved).toBeGreaterThan(0)
  })

  it('refuses a YouTube link even if one reached the database, without fetching anything', async () => {
    const t = await tenant(h)
    const row = await h.r.media.create(t.userId, {
      kind: 'video',
      origin: 'drive_link',
      status: 'pending',
      storageKey: sourceKey(t.userId, randomUUID(), 'mp4'),
      sourceHost: 'drive.google.com',
      sourceUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      rightsAttestedAt: START,
    })
    const { fetch, calls } = mockFetch([])
    const outcome = await createSourceIngest({ fetch })(jobRow('source_ingest', { userId: t.userId, mediaId: row.id }), h.context)
    expect(outcome).toMatchObject({ status: 'failed', error: SOURCE_URL_MESSAGES.video_site_forbidden })
    expect(calls).toHaveLength(0)
    expect((await h.services.media.getForWorker(t.userId, row.id)).sourceUrl).toBeNull()
  })

  it('refuses a redirect to a disallowed host or to YouTube', async () => {
    const t = await tenant(h)
    const a = await h.services.media.registerDriveLink(t.userId, { url: 'https://www.dropbox.com/scl/fi/abc123/talk.mp4?rlkey=k&dl=0', rightsAttested: true })
    const first = mockFetch([redirectResponse('https://files.evil.example.net/talk.mp4')])
    expect(await createSourceIngest({ fetch: first.fetch })(jobRow('source_ingest', { userId: t.userId, mediaId: a.media.id }), h.context)).toMatchObject({
      status: 'failed',
      error: DRIVE_MESSAGES.badRedirect,
    })
    expect(first.calls).toEqual(['https://www.dropbox.com/scl/fi/abc123/talk.mp4?rlkey=k&dl=1'])

    const b = await h.services.media.registerDriveLink(t.userId, { url: driveLink, rightsAttested: true })
    const second = mockFetch([redirectResponse('https://m.youtube.com/watch?v=abc')])
    expect(await createSourceIngest({ fetch: second.fetch })(jobRow('source_ingest', { userId: t.userId, mediaId: b.media.id }), h.context)).toMatchObject({
      status: 'failed',
      error: SOURCE_URL_MESSAGES.video_site_forbidden,
    })
    expect((await usage(t.userId)).reserved).toBe(0)
  })

  it('refuses a drive file that is not a video', async () => {
    const t = await tenant(h)
    const { media } = await h.services.media.registerDriveLink(t.userId, { url: driveLink, rightsAttested: true })
    const { fetch } = mockFetch([fileResponse(await bytesOf(fx.audioOnly), 'audio/mpeg')])
    expect(await createSourceIngest({ fetch })(jobRow('source_ingest', { userId: t.userId, mediaId: media.id }), h.context)).toMatchObject({
      status: 'failed',
      error: INGEST_MESSAGES.noVideo,
    })
    expect(h.storage.keys(`users/${t.userId}/`)).toEqual([])
  })

  it('retries temporary download failures and gives up (media failed) on the last attempt', async () => {
    const t = await tenant(h)
    const { media } = await h.services.media.registerDriveLink(t.userId, { url: driveLink, rightsAttested: true })
    const busy = () => new Response('busy', { status: 503 })
    const handler = createSourceIngest({ fetch: mockFetch([busy, busy]).fetch })
    await expect(handler(jobRow('source_ingest', { userId: t.userId, mediaId: media.id }, { attempts: 1 }), h.context)).rejects.toThrow('busy')
    expect((await h.services.media.get(t.userId, media.id)).status).toBe('pending')
    await expect(handler(jobRow('source_ingest', { userId: t.userId, mediaId: media.id }, { attempts: 5, maxAttempts: 5 }), h.context)).rejects.toThrow()
    expect((await h.services.media.get(t.userId, media.id)).status).toBe('failed')
  })
})

describe('transcribe', () => {
  it('extracts audio, transcribes with the chain and settles the reservation', async () => {
    const t = await tenant(h)
    const media = await ingested(t.userId)
    const reserved = (await usage(t.userId)).reserved
    const fake = h.context.transcriber as FakeTranscriber
    const outcome = await transcribe(jobRow('transcribe', { userId: t.userId, mediaId: media.id, language: 'en' }), h.context)
    expect(outcome).toMatchObject({ mediaId: media.id, status: 'ready', engine: 'fake' })
    expect(fake.calls).toHaveLength(1)
    expect(fake.calls[0]?.filePath).toMatch(/audio\.mp3$/)
    expect(fake.calls[0]?.language).toBe('en')
    const row = await h.services.transcripts.getRow(t.userId, media.id)
    expect(row?.words.length).toBeGreaterThan(10)
    const balance = await usage(t.userId)
    expect(balance.settled).toBe(reserved)
    expect(balance.reserved).toBe(0)
    // a second run does nothing
    expect(await transcribe(jobRow('transcribe', { userId: t.userId, mediaId: media.id }), h.context)).toMatchObject({ status: 'skipped', reason: 'already_transcribed' })
    expect(fake.calls).toHaveLength(1)
  })

  it('a permanent engine failure releases the clipping time', async () => {
    const t = await tenant(h)
    const media = await ingested(t.userId)
    ;(h.context.transcriber as FakeTranscriber).failNext(transcriptionError('engine_failed', 'No speech was found.', { engine: 'fake' }))
    await expect(transcribe(jobRow('transcribe', { userId: t.userId, mediaId: media.id }), h.context)).rejects.toBeInstanceOf(PermanentJobError)
    const balance = await usage(t.userId)
    expect(balance.reserved).toBe(0)
    expect(balance.settled).toBe(0)
    expect((await h.services.transcripts.get(t.userId, { mediaId: media.id })).status).toBe('failed')
  })

  it('an outage retries without refunding, and the last attempt refunds', async () => {
    const t = await tenant(h)
    const media = await ingested(t.userId)
    const reserved = (await usage(t.userId)).reserved
    const fake = h.context.transcriber as FakeTranscriber
    fake.failNext(undefined, 2)
    await expect(transcribe(jobRow('transcribe', { userId: t.userId, mediaId: media.id }, { attempts: 1 }), h.context)).rejects.toMatchObject({ code: 'unavailable' })
    expect((await usage(t.userId)).reserved).toBe(reserved)
    await expect(transcribe(jobRow('transcribe', { userId: t.userId, mediaId: media.id }, { attempts: 5, maxAttempts: 5 }), h.context)).rejects.toBeInstanceOf(PermanentJobError)
    expect((await usage(t.userId)).reserved).toBe(0)
  })

  it('falls back to downloading the source when streaming it from a presigned URL fails', async () => {
    const t = await tenant(h)
    const media = await ingested(t.userId)
    // a presigned URL that cannot be reached (local, refused at once: no network involved)
    const storage = Object.create(h.storage) as typeof h.storage
    storage.presignGet = async () => 'https://127.0.0.1:1/bucket/source.mp4?X-Amz-Signature=secret'
    const ctx = { ...h.context, storage }
    const outcome = await createTranscribe({ streamSources: true })(jobRow('transcribe', { userId: t.userId, mediaId: media.id }), ctx)
    expect(outcome).toMatchObject({ status: 'ready' })
    const warning = h.logger.lines.find((l) => l.msg === 'streaming the source failed; downloading it instead')
    expect(warning).toBeDefined()
    expect(JSON.stringify(h.logger.lines)).not.toContain('secret')
  }, 60_000)

  it('a source without sound fails with a clear message and is refunded', async () => {
    const t = await tenant(h)
    const media = await ingested(t.userId, fx.silent)
    await expect(transcribe(jobRow('transcribe', { userId: t.userId, mediaId: media.id }), h.context)).rejects.toThrow(TRANSCRIBE_MESSAGES.noAudio)
    expect((await usage(t.userId)).reserved).toBe(0)
  })
})

describe('clip_render', () => {
  it('renders a 1080×1920 clip with captions and audio and creates a draft (no post) for the brand’s video platforms', async () => {
    const t = await tenant(h, 'tiktok')
    await createTestAccount(h.db, t.userId, t.brandId, { platform: 'instagram' })
    await createTestAccount(h.db, t.userId, t.brandId, { platform: 'threads', status: 'needs_reauth' })
    const source = await transcribed(t.userId)
    const [clip] = await h.services.clips.requestClips(t.userId, {
      mediaId: source.id,
      brandId: t.brandId,
      ranges: [{ startMs: 300, endMs: 3_800, title: 'The mistake', hook: 'Stop posting long videos once' }],
    })
    if (!clip) throw new Error('clip')
    const outcome = await clipRender(jobRow('clip_render', { userId: t.userId, clipId: clip.id }), h.context)
    expect(outcome).toMatchObject({ clipId: clip.id, status: 'ready', framing: 'crop', captions: true })

    const done = await h.services.clips.get(t.userId, clip.id)
    expect(done.status).toBe('ready')
    const output = await h.services.media.getForWorker(t.userId, done.outputMediaId ?? '')
    const probed = await probeBytes(h.storage.getBytes(output.storageKey) ?? new Uint8Array())
    expect(probed.video).toMatchObject({ width: 1080, height: 1920, codec: 'h264' })
    expect(probed.audio?.codec).toBe('aac')
    expect(probed.durationMs).toBeGreaterThanOrEqual(3_400)
    expect(probed.durationMs).toBeLessThanOrEqual(3_600)
    expect(output).toMatchObject({ origin: 'clip', parentMediaId: source.id, width: 1080, height: 1920 })

    const draft = await h.services.drafts.get(t.userId, done.draftId ?? '')
    expect(draft.draft.status).toBe('draft')
    expect(draft.draft.createdVia).toBe('worker')
    expect(draft.variants.map((v) => v.platform).sort()).toEqual(['instagram', 'tiktok'])
    for (const v of draft.variants) {
      expect(v.text).toBe('Stop posting long videos once')
      expect(v.mediaIds).toEqual([output.id])
    }
    const posts = await h.db.query(`select id from public.posts where user_id = $1`, [t.userId])
    expect(posts).toHaveLength(0)

    // re-running the job is a no-op
    expect(await clipRender(jobRow('clip_render', { userId: t.userId, clipId: clip.id }), h.context)).toMatchObject({ skipped: true, draftId: done.draftId })
  }, 60_000)

  it('fits portrait sources over a blurred fill and adds a silent track when the source has none', async () => {
    const t = await tenant(h, 'tiktok')
    const portrait = await transcribed(t.userId, fx.portrait)
    const [a] = await h.services.clips.requestClips(t.userId, { mediaId: portrait.id, ranges: [{ startMs: 0, endMs: 3_000 }], captionStyle: 'minimal' })
    expect(await clipRender(jobRow('clip_render', { userId: t.userId, clipId: a!.id }), h.context)).toMatchObject({ framing: 'blur', captions: true })

    // a silent source cannot be transcribed, so render a clip of it directly (no captions)
    const silent = await ingested(t.userId, fx.silent)
    await h.services.transcripts.save(t.userId, silent.id, {
      engine: 'fake',
      result: { language: 'en', durationMs: 4_000, text: '', words: [], segments: [] },
    })
    const [b] = await h.services.clips.requestClips(t.userId, { mediaId: silent.id, ranges: [{ startMs: 500, endMs: 3_500 }], captionStyle: 'none' })
    expect(await clipRender(jobRow('clip_render', { userId: t.userId, clipId: b!.id }), h.context)).toMatchObject({ captions: false })
    const clip = await h.services.clips.get(t.userId, b!.id)
    const out = await h.services.media.getForWorker(t.userId, clip.outputMediaId ?? '')
    const probed = await probeBytes(h.storage.getBytes(out.storageKey) ?? new Uint8Array())
    expect(probed.audio).not.toBeNull()
    expect(probed.video).toMatchObject({ width: 1080, height: 1920 })
  }, 60_000)

  it('stops on cancellation without failing the clip (the runner releases the job)', async () => {
    const t = await tenant(h)
    const source = await transcribed(t.userId)
    const [clip] = await h.services.clips.requestClips(t.userId, { mediaId: source.id, ranges: [{ startMs: 0, endMs: 3_000 }] })
    const controller = new AbortController()
    controller.abort()
    await expect(clipRender(jobRow('clip_render', { userId: t.userId, clipId: clip!.id }), { ...h.context, signal: controller.signal })).rejects.toBeInstanceOf(JobAbortedError)
    expect((await h.services.clips.get(t.userId, clip!.id)).status).toBe('rendering')
    // the next attempt renders it
    expect(await clipRender(jobRow('clip_render', { userId: t.userId, clipId: clip!.id }), h.context)).toMatchObject({ status: 'ready' })
  }, 60_000)

  it('marks the clip failed when its source file is gone', async () => {
    const t = await tenant(h)
    const source = await transcribed(t.userId)
    const [clip] = await h.services.clips.requestClips(t.userId, { mediaId: source.id, ranges: [{ startMs: 0, endMs: 3_000 }] })
    await h.storage.delete(source.storageKey)
    await expect(clipRender(jobRow('clip_render', { userId: t.userId, clipId: clip!.id }), h.context)).rejects.toBeInstanceOf(PermanentJobError)
    expect((await h.services.clips.get(t.userId, clip!.id)).status).toBe('failed')
  })
})

describe('runner integration', () => {
  it('upload → ingest → transcribe → clips → drafts through the real queue', async () => {
    const t = await tenant(h, 'youtube')
    const runner = makeRunner(h, createMediaHandlers({ streamSources: false }) as Partial<Record<JobType, Handler>>, { concurrency: 1 })
    const { media } = await upload(t.userId, fx.landscape, 'video/mp4', { brandId: t.brandId })
    expect(await runner.drain()).toBe(2) // source_ingest, then transcribe
    expect((await h.services.transcripts.get(t.userId, { mediaId: media.id })).status).toBe('ready')
    await h.services.clips.requestClips(t.userId, { mediaId: media.id, ranges: [{ startMs: 0, endMs: 3_200, title: 'The hook' }] })
    expect(await runner.drain()).toBe(1)
    const [job] = await jobsOfType(h, 'clip_render')
    expect(job?.status).toBe('succeeded')
    const drafts = await h.services.drafts.list(t.userId, {})
    expect(drafts.items).toHaveLength(1)
    expect(drafts.items[0]?.variants[0]).toMatchObject({ platform: 'youtube', title: 'The hook' })
  }, 90_000)

  it('exports a handler for every media job type', () => {
    expect(Object.keys(mediaHandlers).sort()).toEqual(['carousel_render', 'clip_render', 'source_ingest', 'transcribe', 'video_render'])
  })
})
