// Screenshots of the real pages (docs/screenshots/*.png) with a health check on each: the page
// answered < 400, rendered with our stylesheet, shows no error screen and threw no browser errors.

import { mkdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { BrowserContext, Page } from './deps'
import type { ToolResult } from './mcp'
import { assert, log, REPO } from './util'

export const SHOTS_DIR = join(REPO, 'docs/screenshots')

export interface Shot {
  name: string
  path: string
  bytes: number
  url: string
}

export const shots: Shot[] = []

const ERROR_SCREENS = [
  /Application error: a (server|client)-side exception has occurred/i,
  /Internal Server Error/,
  /This page could not be found/i,
  /Unhandled Runtime Error/i,
  /Something went wrong/i,
]

/** Collects uncaught page errors and console errors per page (attach once). */
export function watchPage(page: Page): { errors: string[] } {
  const state = { errors: [] as string[] }
  page.on('pageerror', (e) => state.errors.push(`pageerror: ${e.message}`))
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return
    const text = msg.text()
    // media previews of the fake provider's https://*.invalid URLs never load; that is expected
    if (/net::ERR_NAME_NOT_RESOLVED|\.invalid\//.test(text)) return
    state.errors.push(`console: ${text}`)
  })
  return state
}

/** Asserts the current page is a healthy, styled page (not an error screen). */
export async function assertHealthyPage(page: Page, what: string, watcher?: { errors: string[] }): Promise<void> {
  const text = await page.locator('body').innerText()
  for (const re of ERROR_SCREENS) assert(!re.test(text), `${what}: shows an error screen (${re})`)
  const styled = await page.evaluate(() => {
    const sheets = Array.from(document.styleSheets).filter((s) => {
      try {
        return s.cssRules.length > 0
      } catch {
        return false
      }
    }).length
    const font = getComputedStyle(document.body).fontFamily
    return { sheets, font }
  })
  assert(styled.sheets > 0, `${what}: no stylesheet loaded`)
  assert(!/^"?Times/i.test(styled.font), `${what}: body falls back to the browser default font (${styled.font})`)
  if (watcher && watcher.errors.length > 0) {
    const errors = watcher.errors.splice(0)
    throw new Error(`${what}: browser errors:\n  ${errors.join('\n  ')}`)
  }
}

/** Opens `path`, checks it, saves docs/screenshots/<name>.png (viewport only). */
export async function capture(page: Page, name: string, path: string | null, options: { watcher?: { errors: string[] }; waitFor?: string; fullPage?: boolean } = {}): Promise<Shot> {
  if (path !== null) {
    const res = await page.goto(path, { waitUntil: 'load' })
    assert(res && res.status() < 400, `${name}: ${path} answered ${res?.status()}`)
    // pages with <video preload="metadata"> keep a media request open, so "network idle" may never
    // come; give images and fonts a moment instead of waiting for it
    await page.waitForLoadState('networkidle', { timeout: 3_000 }).catch(() => undefined)
  }
  if (options.waitFor) await page.locator(options.waitFor).first().waitFor({ timeout: 15_000 })
  await page.evaluate(() => document.fonts.ready)
  await assertHealthyPage(page, name, options.watcher)
  return save(page, name, options.fullPage ?? false)
}

export async function save(page: Page, name: string, fullPage = false): Promise<Shot> {
  mkdirSync(SHOTS_DIR, { recursive: true })
  const file = join(SHOTS_DIR, `${name}.png`)
  await page.screenshot({ path: file, fullPage, animations: 'disabled' })
  const bytes = statSync(file).size
  const shot = { name, path: file, bytes, url: page.url() }
  shots.push(shot)
  log(`screenshot ${name}.png (${Math.round(bytes / 1024)} KB)`)
  return shot
}

export interface HarnessData {
  cardHtml: string
  toolArgs: Record<string, unknown>
  toolResult: ToolResult
}

/**
 * Loads scripts/e2e/card-harness.html (an MCP Apps host) with the approval card HTML and an
 * approve_draft result. Tool calls from the card go to `callTool` (the real MCP server).
 */
export async function openCardHarness(context: BrowserContext, data: HarnessData, callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>): Promise<Page> {
  const page = await context.newPage()
  await page.exposeFunction('e2eCallTool', callTool)
  const template = readFileSync(join(REPO, 'scripts/e2e/card-harness.html'), 'utf8')
  // JSON inside <script>: escape "<" so card HTML cannot close the script element
  const json = JSON.stringify(data).replace(/</g, '\\u003c')
  await page.setContent(template.replace('/*__DATA__*/', `window.__HARNESS__ = ${json};`), { waitUntil: 'load' })
  return page
}
