// What the dashboard pages and server actions run against: the signed-in user and the services
// (lib/services.ts), plus the app/MCP URLs and the clock. Tests install a PGlite-backed runtime and
// a user with setUiOverridesForTests, so pages' data loaders and actions run without Next.js.
// Server-only.

import type { Logger } from '@app/core/log'
import type { Services } from '@app/services'
import { redirect } from 'next/navigation'
import { getCurrentUser, type CurrentUser } from '@/lib/auth'
import { getServicesRuntime } from '@/lib/services'

export interface UiRuntime {
  services: Services
  /** Public base URL, no trailing slash. */
  appUrl: string
  /** The MCP server URL users paste into their AI app. */
  mcpUrl: string
  now(): Date
  log: Logger
}

interface Overrides {
  runtime?: UiRuntime
  /** Signed-in user for tests (null = signed out). */
  user?: CurrentUser | null
}

const KEY = Symbol.for('app.web.ui.overrides')

function holder(): { overrides: Overrides | null } {
  const g = globalThis as typeof globalThis & { [KEY]?: { overrides: Overrides | null } }
  g[KEY] ??= { overrides: null }
  return g[KEY]
}

/** Tests only. */
export function setUiOverridesForTests(overrides: Overrides | null): void {
  holder().overrides = overrides
}

export async function getUiRuntime(): Promise<UiRuntime> {
  const o = holder().overrides
  if (o?.runtime) return o.runtime
  const rt = await getServicesRuntime()
  return {
    services: rt.services,
    appUrl: rt.config.APP_URL,
    mcpUrl: rt.config.MCP_RESOURCE_URL ?? `${rt.config.APP_URL}/api/mcp`,
    now: () => rt.clock.now(),
    log: rt.log,
  }
}

export async function currentUser(): Promise<CurrentUser | null> {
  const o = holder().overrides
  if (o && o.user !== undefined) return o.user
  return getCurrentUser()
}

/** The signed-in user, or a redirect to /login that comes back to `nextPath`. */
export async function requireSignedIn(nextPath: string): Promise<CurrentUser> {
  const user = await currentUser()
  if (!user) redirect(`/login?next=${encodeURIComponent(nextPath)}`)
  return user
}
