// render_code_video: an HTML animation the AI wrote → MP4. Chromium (playwright-core; never
// "playwright install": the binary comes from the image) loads the page with JavaScript on but no
// way out: every request except data: and blob: is aborted (the page itself is served by the route
// handler), WebSockets are closed, service workers blocked, DNS points nowhere, and there is no file
// access (the page's origin is a made-up http host). Frames are deterministic:
//   - window.seek(ms) when the page defines it (sync or async), called for every frame;
//   - otherwise every document animation (CSS animations/transitions, Web Animations) is paused and
//     set to the frame's time, while Playwright's clock drives timers, requestAnimationFrame and Date.
// Each frame is a JPEG screenshot piped into ffmpeg (image2pipe) → H.264 yuv420p + AAC (the given
// audio, padded/trimmed, or silence), faststart. Hard timeouts on load, every frame, the encode and
// the whole render; a crashed page fails the job; the temp directory is always removed.

import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core'
import { JobAbortedError, PermanentJobError } from '../errors'
import type { MediaInput } from './ffmpeg'
import { MediaToolError, startTool, toolEnv } from './process'
import { RendererUnavailableError, resolveChromiumPath } from './renderer'

/** The page URL (fulfilled by our route; the .invalid TLD never resolves anywhere). */
export const CODE_PAGE_URL = 'http://render.invalid/'

/** Fixed start of the virtual clock (Date.now() in the page at frame 0). */
export const CODE_CLOCK_START = Date.UTC(2026, 0, 1, 0, 0, 0)

export const CODE_FRAME_JPEG_QUALITY = 90

export const CODE_VIDEO_MESSAGES = {
  crashed: 'The page crashed while rendering. Simplify the animation (fewer elements or smaller images) and try again.',
  loadTimeout: 'The page did not finish loading in time. Make it self-contained and lighter.',
  frameTimeout: 'A frame took too long to draw (window.seek or the page\'s scripts are too slow, or never finish).',
  tooSlow: 'The video took too long to render. Make it shorter or lighter.',
  pageFailed: 'The page failed while rendering. Check the HTML: it must be self-contained and draw each frame quickly.',
  badOutput: 'The video did not come out right.',
} as const

export interface CodeVideoTimeouts {
  /** Browser start. */
  launchMs: number
  /** Loading the page (DOMContentLoaded + load + fonts). */
  loadMs: number
  /** One frame: clock step, seek and screenshot. */
  frameMs: number
  /** The whole render (frames + encode). */
  totalMs: number
}

export const DEFAULT_CODE_VIDEO_TIMEOUTS: Readonly<CodeVideoTimeouts> = Object.freeze({
  launchMs: 30_000,
  loadMs: 20_000,
  frameMs: 15_000,
  totalMs: 15 * 60_000,
})

export interface CodeVideoRenderInput {
  html: string
  width: number
  height: number
  fps: number
  durationMs: number
  /** Background audio (padded or trimmed to the video), or null for silence. */
  audio: MediaInput | null
  /** Output MP4 file name inside `cwd`. */
  output: string
  cwd: string
  ffmpegPath: string
  executablePath?: string | null
  signal?: AbortSignal | undefined
  timeouts?: Partial<CodeVideoTimeouts>
}

export interface CodeVideoRenderResult {
  frames: number
  /** The page defined window.seek (frames came from it). */
  usedSeek: boolean
  /** Requests the page tried that were blocked (network, files). */
  blockedRequests: number
  /** Uncaught errors in the page (it still rendered). */
  pageErrors: number
}

/** ffmpeg arguments: JPEG frames on stdin (+ audio or silence) → H.264 yuv420p + AAC, faststart. */
export function codeVideoEncodeArgs(o: { fps: number; frames: number; width: number; height: number; audio: MediaInput | null; output: string }): string[] {
  const seconds = (o.frames / o.fps).toFixed(3)
  const audioIn = o.audio ? [...o.audio.args, '-i', o.audio.path] : ['-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000']
  return [
    '-hide_banner',
    '-nostats',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'image2pipe',
    '-framerate',
    String(o.fps),
    '-c:v',
    'mjpeg',
    '-i',
    'pipe:0',
    ...audioIn,
    '-filter_complex',
    `[0:v]scale=${o.width}:${o.height}:flags=lanczos,setsar=1,format=yuv420p[v];[1:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,apad,atrim=0:${seconds}[a]`,
    '-map',
    '[v]',
    '-map',
    '[a]',
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '20',
    '-pix_fmt',
    'yuv420p',
    '-r',
    String(o.fps),
    '-frames:v',
    String(o.frames),
    '-c:a',
    'aac',
    '-b:a',
    '128k',
    '-t',
    seconds,
    '-movflags',
    '+faststart',
    o.output,
  ]
}

/** Pauses every document animation at the frame's time (first seen at `t` = starts at `t`). */
const SYNC_ANIMATIONS = `(t) => {
  const seen = window.__codeVideoSeen || (window.__codeVideoSeen = new WeakMap());
  let n = 0;
  for (const a of document.getAnimations({ subtree: true })) {
    let start = seen.get(a);
    if (start === undefined) { start = t; seen.set(a, start); }
    try { a.pause(); a.currentTime = Math.max(0, t - start); n++; } catch (e) { /* finished or detached */ }
  }
  return n;
}`

/** Starts window.seek(t) without awaiting it in the page (its timers may need the clock to move). */
const START_SEEK = `(t) => {
  window.__codeVideoSeek = 'pending';
  Promise.resolve().then(() => window.seek(t)).then(
    () => { window.__codeVideoSeek = 'done' },
    (e) => { window.__codeVideoSeek = 'done'; window.__codeVideoSeekError = String(e && e.message || e).slice(0, 200) },
  );
}`

/** Fake-clock steps (ms) given to a pending seek (zero-delay timers, then rAF ticks). */
const SEEK_STEPS = [0, 1, 1, 2, 4, 8, 16]

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new PermanentJobError(message)), Math.max(1, ms))
    }),
  ]).finally(() => clearTimeout(timer))
}

/** Content-Security-Policy for the page: inline code and data:/blob: assets only, no network. */
const PAGE_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline' 'unsafe-eval' data: blob:",
  "style-src 'unsafe-inline' data:",
  'img-src data: blob:',
  'font-src data:',
  'media-src data: blob:',
  "connect-src 'none'",
  "frame-src 'none'",
  "worker-src blob:",
  "form-action 'none'",
  "base-uri 'none'",
].join('; ')

async function lockDown(context: BrowserContext, html: string, onBlocked: () => void): Promise<void> {
  await context.route('**/*', async (route) => {
    const url = route.request().url()
    if (url === CODE_PAGE_URL && route.request().isNavigationRequest()) {
      await route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', headers: { 'content-security-policy': PAGE_CSP }, body: html })
      return
    }
    if (url.startsWith('data:') || url.startsWith('blob:')) {
      await route.continue()
      return
    }
    onBlocked()
    await route.abort('blockedbyclient')
  })
  await context.routeWebSocket(/.*/, (ws) => {
    onBlocked()
    void ws.close()
  })
}

/**
 * Renders the HTML frame by frame and encodes the MP4 (`input.output` in `input.cwd`). Throws
 * PermanentJobError (the page's fault: crash, timeouts), RendererUnavailableError (no Chromium),
 * MediaToolError (ffmpeg) or JobAbortedError.
 */
export async function renderCodeVideo(input: CodeVideoRenderInput): Promise<CodeVideoRenderResult> {
  const timeouts = { ...DEFAULT_CODE_VIDEO_TIMEOUTS, ...input.timeouts }
  const { signal } = input
  if (signal?.aborted) throw new JobAbortedError()
  const executablePath = input.executablePath ?? resolveChromiumPath()
  if (!executablePath) throw new RendererUnavailableError('Chromium was not found. Set CHROMIUM_PATH.')
  const frames = Math.max(1, Math.round((input.durationMs / 1000) * input.fps))
  const frameMs = 1000 / input.fps

  let browser: Browser
  try {
    browser = await chromium.launch({
      executablePath,
      headless: true,
      timeout: timeouts.launchMs,
      env: toolEnv() as Record<string, string>,
      args: [
        '--disable-dev-shm-usage',
        '--font-render-hinting=none',
        '--disable-gpu',
        '--hide-scrollbars',
        '--mute-audio',
        // nothing resolves and nothing is proxied anywhere real: belt and braces behind the route block
        '--host-resolver-rules=MAP * ~NOTFOUND',
        '--proxy-server=http://127.0.0.1:9',
        '--proxy-bypass-list=<-loopback>',
        '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
        '--disable-background-networking',
        '--disable-component-update',
        '--disable-sync',
        '--no-first-run',
      ],
    })
  } catch (error) {
    throw new RendererUnavailableError(`Chromium could not start: ${error instanceof Error ? error.message.split('\n')[0]?.slice(0, 200) : 'unknown error'}`)
  }

  let blocked = 0
  let pageErrors = 0
  let crashed = false
  const encoder = startTool(input.ffmpegPath, codeVideoEncodeArgs({ fps: input.fps, frames, width: input.width, height: input.height, audio: input.audio, output: input.output }), {
    cwd: input.cwd,
    signal,
    timeoutMs: timeouts.totalMs,
  })
  const onAbort = () => void browser.close().catch(() => undefined)
  signal?.addEventListener('abort', onAbort, { once: true })
  const overall = setTimeout(() => void browser.close().catch(() => undefined), timeouts.totalMs)
  const started = Date.now()
  try {
    const context = await browser.newContext({
      viewport: { width: input.width, height: input.height },
      deviceScaleFactor: 1,
      javaScriptEnabled: true,
      serviceWorkers: 'block',
      acceptDownloads: false,
      bypassCSP: false,
      locale: 'en-US',
      timezoneId: 'UTC',
      reducedMotion: 'no-preference',
    })
    await lockDown(context, input.html, () => {
      blocked += 1
    })
    // a minute early, so pausing at the start moves forward (the clock never goes back)
    await context.clock.install({ time: CODE_CLOCK_START - 60_000 })
    // requests the page's CSP refused never reach the route: count them too
    await context.addInitScript('window.__codeVideoBlocked = 0; document.addEventListener("securitypolicyviolation", () => { window.__codeVideoBlocked++ }, true);')
    const page: Page = await context.newPage()
    context.on('page', (p) => {
      // popups (window.open) are closed at once
      if (p !== page) void p.close().catch(() => undefined)
    })
    page.on('crash', () => {
      crashed = true
    })
    page.on('pageerror', () => {
      pageErrors += 1
    })
    page.on('dialog', (d) => void d.dismiss().catch(() => undefined))
    // our own frame timeout fires first (a clear, permanent error); this only stops a stuck call
    page.setDefaultTimeout(timeouts.frameMs + 5_000)
    await withTimeout(
      (async () => {
        await page.clock.pauseAt(CODE_CLOCK_START)
        await page.goto(CODE_PAGE_URL, { waitUntil: 'load', timeout: timeouts.loadMs })
        await page.evaluate('document.fonts ? document.fonts.ready.then(() => true) : true')
      })(),
      timeouts.loadMs + 1_000,
      CODE_VIDEO_MESSAGES.loadTimeout,
    )
    const usedSeek = (await page.evaluate('typeof window.seek === "function"')) === true

    // virtual time (ms since frame 0) the page's clock has reached
    let clockMs = 0
    const seekTo = async (t: number): Promise<void> => {
      await page.evaluate(`(${START_SEEK})(${t})`)
      let step = 0
      while ((await page.evaluate('window.__codeVideoSeek')) !== 'done') {
        if (crashed) throw new PermanentJobError(CODE_VIDEO_MESSAGES.crashed)
        const ms = SEEK_STEPS[step]
        step += 1
        if (ms !== undefined) {
          // let the seek's own timers / animation frames run (the next frame catches the clock up)
          await page.clock.runFor(ms)
          clockMs += ms
        } else {
          // it waits on something real (image decode, fonts): give it real time
          await new Promise((resolve) => setTimeout(resolve, 5))
        }
      }
    }

    for (let i = 0; i < frames; i++) {
      if (signal?.aborted) throw new JobAbortedError()
      if (crashed) throw new PermanentJobError(CODE_VIDEO_MESSAGES.crashed)
      if (Date.now() - started > timeouts.totalMs) throw new PermanentJobError(CODE_VIDEO_MESSAGES.tooSlow)
      const t = Math.round(i * frameMs)
      const shot = await withTimeout(
        (async () => {
          if (t > clockMs) {
            await page.clock.runFor(t - clockMs)
            clockMs = t
          }
          await page.evaluate(`(${SYNC_ANIMATIONS})(${t})`)
          if (usedSeek) await seekTo(t)
          return page.screenshot({ type: 'jpeg', quality: CODE_FRAME_JPEG_QUALITY, clip: { x: 0, y: 0, width: input.width, height: input.height }, caret: 'hide', animations: 'allow' })
        })(),
        timeouts.frameMs,
        CODE_VIDEO_MESSAGES.frameTimeout,
      )
      await encoder.write(shot)
    }
    const refused = Number(await page.evaluate('window.__codeVideoBlocked || 0').catch(() => 0)) || 0
    await browser.close().catch(() => undefined)
    await encoder.finish()
    return { frames, usedSeek, blockedRequests: blocked + refused, pageErrors }
  } catch (error) {
    encoder.kill()
    if (signal?.aborted) throw new JobAbortedError()
    if (crashed) throw new PermanentJobError(CODE_VIDEO_MESSAGES.crashed)
    if (error instanceof PermanentJobError || error instanceof MediaToolError || error instanceof JobAbortedError) throw error
    // the browser was closed by the overall timer, or Playwright reported the page/target gone
    if (Date.now() - started >= timeouts.totalMs) throw new PermanentJobError(CODE_VIDEO_MESSAGES.tooSlow)
    // anything else came from the page (its scripts, a runaway timer loop): retrying cannot help
    const reason = error instanceof Error ? (error.message.split('\n')[0] ?? '').slice(0, 160) : ''
    throw new PermanentJobError(`${CODE_VIDEO_MESSAGES.pageFailed}${reason ? ` (${reason})` : ''}`)
  } finally {
    clearTimeout(overall)
    signal?.removeEventListener('abort', onAbort)
    await browser.close().catch(() => undefined)
  }
}
