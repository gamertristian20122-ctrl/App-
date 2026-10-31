// HTML slides → PNG with playwright-core's Chromium (never "playwright install": the binary comes
// from the image). Pages are rendered with JavaScript disabled and every network request blocked
// (images are inlined as data: URIs), so slide content cannot fetch or run anything.

import { existsSync } from 'node:fs'
import { chromium, type Browser } from 'playwright-core'
import { JobAbortedError } from '../errors'
import { toolEnv } from './process'

export interface RenderSize {
  width: number
  height: number
}

export interface SlidePage {
  /** The document, or a loader (keeps at most one slide's inlined images in memory). */
  html: string | (() => Promise<string>)
  /** Absolute path of the image to write. */
  outPath: string
  /**
   * Output format (default png: lossless frames for ffmpeg). Carousels use jpeg: Instagram takes
   * JPEG only and TikTok photo posts JPEG/WebP (docs/research/platform-limits.md).
   */
  format?: 'png' | 'jpeg'
}

/** JPEG quality for carousel slides (flat colours and text stay crisp; ~150–400 KB at 1080×1350). */
export const SLIDE_JPEG_QUALITY = 92

/** Renders HTML documents to PNG files at a fixed viewport. */
export interface SlideRenderer {
  render(pages: readonly SlidePage[], size: RenderSize, signal?: AbortSignal): Promise<void>
}

/** The Chromium preinstalled in the dev/CI sandbox (playwright-core 1.63 → chromium-1243). */
export const SANDBOX_CHROMIUM_PATHS = ['/opt/pw-browsers/chromium-1243/chrome-linux64/chrome', '/opt/pw-browsers/chromium'] as const

/** The Chromium unavailable on this machine (no executable found, or it could not start). */
export class RendererUnavailableError extends Error {
  override readonly name = 'RendererUnavailableError'
}

/**
 * Chromium executable: CHROMIUM_PATH (config, then env) → playwright-core's own browser for its
 * version (PLAYWRIGHT_BROWSERS_PATH, e.g. /ms-playwright in the worker image) → the sandbox's
 * /opt/pw-browsers build. Returns null when none exists.
 */
export function resolveChromiumPath(configured?: string | null, env: NodeJS.ProcessEnv = process.env): string | null {
  const candidates: string[] = []
  if (configured) candidates.push(configured)
  if (env.CHROMIUM_PATH) candidates.push(env.CHROMIUM_PATH)
  try {
    candidates.push(chromium.executablePath())
  } catch {
    // no registry entry for this platform
  }
  candidates.push(...SANDBOX_CHROMIUM_PATHS)
  for (const path of candidates) if (path && existsSync(path)) return path
  return null
}

export interface ChromiumRendererOptions {
  executablePath?: string | null
  /** Per navigation / screenshot. Default 30 s. */
  timeoutMs?: number
  /** Browser start. Default 30 s. */
  launchTimeoutMs?: number
}

export function createChromiumRenderer(options: ChromiumRendererOptions = {}): SlideRenderer {
  const timeout = options.timeoutMs ?? 30_000
  return {
    async render(pages, size, signal) {
      if (signal?.aborted) throw new JobAbortedError()
      const executablePath = options.executablePath ?? resolveChromiumPath()
      if (!executablePath) throw new RendererUnavailableError('Chromium was not found. Set CHROMIUM_PATH.')
      let browser: Browser
      try {
        browser = await chromium.launch({
          executablePath,
          headless: true,
          timeout: options.launchTimeoutMs ?? 30_000,
          // the browser never sees the worker's secrets (database URL, API keys)
          env: toolEnv() as Record<string, string>,
          args: ['--disable-dev-shm-usage', '--font-render-hinting=none', '--disable-gpu', '--hide-scrollbars', '--mute-audio'],
        })
      } catch (error) {
        throw new RendererUnavailableError(`Chromium could not start: ${error instanceof Error ? error.message.split('\n')[0]?.slice(0, 200) : 'unknown error'}`)
      }
      const onAbort = () => void browser.close().catch(() => undefined)
      signal?.addEventListener('abort', onAbort, { once: true })
      try {
        const context = await browser.newContext({
          viewport: { width: size.width, height: size.height },
          deviceScaleFactor: 1,
          javaScriptEnabled: false,
          offline: true,
          locale: 'en-US',
        })
        await context.route('**/*', (route) => (route.request().url().startsWith('data:') ? route.continue() : route.abort()))
        for (const page of pages) {
          if (signal?.aborted) throw new JobAbortedError()
          const tab = await context.newPage()
          try {
            const html = typeof page.html === 'string' ? page.html : await page.html()
            await tab.setContent(html, { waitUntil: 'load', timeout })
            await tab.evaluate('document.fonts.ready.then(() => true)')
            const clip = { x: 0, y: 0, width: size.width, height: size.height }
            if (page.format === 'jpeg') {
              await tab.screenshot({ path: page.outPath, type: 'jpeg', quality: SLIDE_JPEG_QUALITY, animations: 'disabled', timeout, clip })
            } else {
              await tab.screenshot({ path: page.outPath, type: 'png', animations: 'disabled', timeout, clip })
            }
          } finally {
            await tab.close().catch(() => undefined)
          }
        }
      } catch (error) {
        if (signal?.aborted) throw new JobAbortedError()
        throw error
      } finally {
        signal?.removeEventListener('abort', onAbort)
        await browser.close().catch(() => undefined)
      }
    },
  }
}
