// Packages the e2e script borrows from the workspace without adding dependencies:
// - @modelcontextprotocol/sdk (apps/web's copy) is imported directly; scripts/e2e/tsconfig.json maps
//   its subpaths for both tsc and tsx.
// - playwright-core (apps/worker's copy, the same build the renderer uses) is CommonJS, so it is
//   loaded with require() from the worker package; the types come from the same copy.

import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import type * as Playwright from 'playwright-core'
import { REPO } from './util'

const requireFromWorker = createRequire(join(REPO, 'apps/worker/package.json'))

export const playwright = requireFromWorker('playwright-core') as typeof Playwright

/** Where playwright-core finds Chromium: PLAYWRIGHT_BROWSERS_PATH, else the sandbox's /opt/pw-browsers. */
export function ensureBrowsersPath(): void {
  if (!process.env.PLAYWRIGHT_BROWSERS_PATH && existsSync('/opt/pw-browsers')) {
    process.env.PLAYWRIGHT_BROWSERS_PATH = '/opt/pw-browsers'
  }
}

export type { Browser, BrowserContext, Page } from 'playwright-core'
