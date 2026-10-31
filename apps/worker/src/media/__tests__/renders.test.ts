// carousel_render (real Chromium through playwright-core; skipped with a message when it cannot
// launch) and video_render (cards from a stand-in renderer so ffmpeg is always exercised, plus the
// real renderer when available). PGlite services + MemoryStorage; no network.

import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createTestAccount } from '@app/db/testing'
import { PermanentJobError } from '../../errors'
import { createWorkerHarness, image, jobRow, resetWorkerHarness, tenant, type WorkerHarness } from '../../../test/helpers'
import { createChromiumRenderer, resolveChromiumPath, type SlideRenderer } from '../renderer'
import { createCarouselRender, createVideoRender } from '../renders'
import { jpegDimensions } from '../files'
import { bytesOf, createFixtures, probeBytes, type Fixtures } from './fixtures'

const run = promisify(execFile)

/** Why Chromium cannot render here (null when it can). */
async function chromiumProblem(): Promise<string | null> {
  const path = resolveChromiumPath()
  if (!path) return 'no Chromium executable found (set CHROMIUM_PATH)'
  const dir = await mkdtemp(join(tmpdir(), 'chromium-check-'))
  try {
    await createChromiumRenderer({ executablePath: path, launchTimeoutMs: 20_000 }).render([{ html: '<p>ok</p>', outPath: join(dir, 'ok.png') }], { width: 64, height: 64 })
    return null
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

const chromiumIssue = await chromiumProblem()
if (chromiumIssue) console.warn(`[media renders] Chromium tests skipped: ${chromiumIssue}`)

/** Stand-in renderer: solid PNG cards made with ffmpeg (exercises video_render without Chromium). */
const ffmpegCards: SlideRenderer = {
  async render(pages, size) {
    for (const [i, page] of pages.entries()) {
      if (typeof page.html !== 'string') await page.html()
      await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `color=c=0x${(i * 40 + 30).toString(16).padStart(2, '0')}3060:s=${size.width}x${size.height}:d=1`, '-frames:v', '1', page.outPath])
    }
  },
}

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
})

async function pngImage(userId: string, brandId: string) {
  const row = await image(h, userId, brandId)
  await h.storage.putBytes(row.storageKey, await bytesOf(fx.image), 'image/png')
  await h.db.query(`update public.media_assets set mime_type = 'image/png' where id = $1`, [row.id])
  return row
}

async function audioMedia(userId: string) {
  const bytes = await bytesOf(fx.audioOnly)
  const storageKey = `users/${userId}/uploads/${crypto.randomUUID()}.mp3`
  await h.storage.putBytes(storageKey, bytes, 'audio/mpeg')
  return h.r.media.create(userId, { kind: 'audio', origin: 'upload', status: 'ready', storageKey, mimeType: 'audio/mpeg', bytes: bytes.byteLength, durationMs: 3_000 })
}

describe.skipIf(chromiumIssue !== null)('carousel_render (Chromium)', () => {
  it('renders 1080×1350 PNG slides, records them and drafts photo variants for the brand', async () => {
    const t = await tenant(h, 'instagram')
    await createTestAccount(h.db, t.userId, t.brandId, { platform: 'x' })
    await createTestAccount(h.db, t.userId, t.brandId, { platform: 'youtube' }) // no photos on YouTube
    const photo = await pngImage(t.userId, t.brandId)
    const input = {
      brandId: t.brandId,
      template: 'minimal',
      theme: { background: '#101820', foreground: '#f2f2f2', accent: '#fee715', font: 'sans' },
      slides: [
        { heading: '3 mistakes creators make', body: 'Swipe to see them all', footer: '@acme' },
        { heading: 'Posting once', body: 'Cut every long video into five clips.\nEach with its own hook.', imageMediaId: photo.id },
        { heading: 'Follow for more', footer: '@acme' },
      ],
    }
    const job = await h.services.renders.requestCarousel(t.userId, input)
    const queued = await h.r.jobs.get(job.id)
    const outcome = (await createCarouselRender()(queued!, h.context)) as { mediaIds: string[]; draftId: string; platforms: string[] }
    expect(outcome.mediaIds).toHaveLength(3)
    expect(outcome.platforms.sort()).toEqual(['instagram', 'x'])

    for (const id of outcome.mediaIds) {
      const media = await h.services.media.getForWorker(t.userId, id)
      expect(media).toMatchObject({ kind: 'image', origin: 'render', status: 'ready', mimeType: 'image/jpeg', width: 1080, height: 1350 })
      expect(media.storageKey).toMatch(/\.jpg$/)
      expect(media.storageKey).toMatch(new RegExp(`^users/${t.userId}/renders/`))
      expect(jpegDimensions(h.storage.getBytes(media.storageKey) ?? new Uint8Array())).toEqual({ width: 1080, height: 1350 })
    }
    const draft = await h.services.drafts.get(t.userId, outcome.draftId)
    expect(draft.draft).toMatchObject({ status: 'draft', createdVia: 'worker' })
    for (const v of draft.variants) {
      expect(v.mediaIds).toEqual(outcome.mediaIds)
      // heading and body stay on separate lines (e2e: they used to run together into one sentence)
      expect(v.text).toBe('3 mistakes creators make\nSwipe to see them all')
    }
    expect(draft.draft.notes).toBe('Carousel: 3 mistakes creators make Swipe to see them all')

    // a retried job overwrites the same objects and reuses the draft
    const again = (await createCarouselRender()(queued!, h.context)) as { mediaIds: string[]; draftId: string }
    expect(again.mediaIds).toEqual(outcome.mediaIds)
    expect(again.draftId).toBe(outcome.draftId)
    expect((await h.services.drafts.list(t.userId, {})).items).toHaveLength(1)
  }, 60_000)

  it('honours the aspect ratio and makes no draft without connected accounts', async () => {
    const t = await tenant(h, 'instagram')
    await h.db.query(`update public.connected_accounts set status = 'disconnected' where user_id = $1`, [t.userId])
    const job = await h.services.renders.requestCarousel(t.userId, { brandId: t.brandId, aspect: '1:1', template: 'bold', slides: [{ heading: 'Square' }] })
    const outcome = (await createCarouselRender()((await h.r.jobs.get(job.id))!, h.context)) as { mediaIds: string[]; draftId: string | null; draftReason: string }
    expect(outcome).toMatchObject({ draftId: null, draftReason: 'no_accounts' })
    const media = await h.services.media.getForWorker(t.userId, outcome.mediaIds[0]!)
    expect(jpegDimensions(h.storage.getBytes(media.storageKey) ?? new Uint8Array())).toEqual({ width: 1080, height: 1080 })
  }, 60_000)
})

describe('video_render', () => {
  it('turns slides into a 1080×1920 MP4 of the summed duration and drafts video variants', async () => {
    const t = await tenant(h, 'tiktok')
    const job = await h.services.renders.requestVideo(t.userId, {
      brandId: t.brandId,
      slides: [
        { text: 'Stop posting long videos once', durationMs: 1_500 },
        { text: 'Cut them into clips', durationMs: 1_200 },
        { text: 'Post one a day', durationMs: 1_300 },
      ],
    })
    const outcome = (await createVideoRender({ renderer: ffmpegCards })((await h.r.jobs.get(job.id))!, h.context)) as {
      mediaIds: string[]
      draftId: string
      durationMs: number
    }
    expect(outcome.mediaIds).toHaveLength(1)
    expect(outcome.durationMs).toBeGreaterThanOrEqual(3_950)
    expect(outcome.durationMs).toBeLessThanOrEqual(4_100)
    const media = await h.services.media.getForWorker(t.userId, outcome.mediaIds[0]!)
    expect(media).toMatchObject({ kind: 'video', origin: 'render', mimeType: 'video/mp4', width: 1080, height: 1920 })
    const probed = await probeBytes(h.storage.getBytes(media.storageKey) ?? new Uint8Array())
    expect(probed.video).toMatchObject({ width: 1080, height: 1920, codec: 'h264' })
    expect(probed.audio?.codec).toBe('aac')
    expect(Math.abs((probed.durationMs ?? 0) - 4_000)).toBeLessThanOrEqual(100)
    const draft = await h.services.drafts.get(t.userId, outcome.draftId)
    expect(draft.variants.map((v) => v.platform)).toEqual(['tiktok'])
    expect(draft.variants[0]?.text).toBe('Stop posting long videos once')
  }, 60_000)

  it('mixes in background audio and refuses audio that is not the user’s', async () => {
    const t = await tenant(h, 'tiktok')
    const audio = await audioMedia(t.userId)
    const job = await h.services.renders.requestVideo(t.userId, {
      brandId: t.brandId,
      aspect: '16:9',
      audioMediaId: audio.id,
      slides: [
        { text: 'One', durationMs: 2_000 },
        { text: 'Two', durationMs: 2_000 },
      ],
    })
    const row = (await h.r.jobs.get(job.id))!
    const outcome = (await createVideoRender({ renderer: ffmpegCards })(row, h.context)) as { mediaIds: string[] }
    const media = await h.services.media.getForWorker(t.userId, outcome.mediaIds[0]!)
    const probed = await probeBytes(h.storage.getBytes(media.storageKey) ?? new Uint8Array())
    expect(probed.video).toMatchObject({ width: 1920, height: 1080 })
    expect(probed.audio).not.toBeNull()

    await h.storage.delete(audio.storageKey)
    await h.db.query(`update public.media_assets set status = 'deleted' where id = $1`, [audio.id])
    await expect(createVideoRender({ renderer: ffmpegCards })({ ...row, id: crypto.randomUUID() }, h.context)).rejects.toBeInstanceOf(PermanentJobError)
  }, 60_000)

  it('keeps the rendered media when the draft is refused (brand archived meanwhile)', async () => {
    const t = await tenant(h, 'tiktok')
    const job = await h.services.renders.requestVideo(t.userId, { brandId: t.brandId, slides: [{ text: 'Only slide', durationMs: 3_000 }] })
    await h.services.brands.archive(t.userId, t.brandId)
    const outcome = (await createVideoRender({ renderer: ffmpegCards })((await h.r.jobs.get(job.id))!, h.context)) as Record<string, unknown>
    expect(outcome).toMatchObject({ draftId: null, draftReason: 'draft_refused' })
    expect(outcome.mediaIds).toHaveLength(1)
  }, 60_000)

  it.skipIf(chromiumIssue !== null)('renders real cards with Chromium (image slide with a caption)', async () => {
    const t = await tenant(h, 'tiktok')
    const photo = await pngImage(t.userId, t.brandId)
    const job = await h.services.renders.requestVideo(t.userId, {
      brandId: t.brandId,
      template: 'captioned_images',
      slides: [
        { text: 'A caption over a photo', imageMediaId: photo.id, durationMs: 1_500 },
        { text: 'And a text card', durationMs: 1_500 },
      ],
    })
    const outcome = (await createVideoRender()((await h.r.jobs.get(job.id))!, h.context)) as { mediaIds: string[]; durationMs: number }
    expect(Math.abs(outcome.durationMs - 3_000)).toBeLessThanOrEqual(100)
  }, 60_000)
})
