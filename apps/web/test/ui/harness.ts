// Shared setup for the dashboard tests: PGlite-backed services built from a test environment (fake
// posting provider, in-memory storage, a manual clock at a fixed time), installed through the
// lib/ui/runtime test seam. Nothing here touches the network.

import { manualClock, type ManualClock } from '@app/core/time'
import { silentLogger } from '@app/core/log'
import type { Db } from '@app/db'
import { createTestAccount, createTestBrand, createTestDb, createTestUser, type TestUserOptions } from '@app/db/testing'
import type { Platform } from '@app/core/types'
import { createServicesFromEnv, type Services, type ServicesFromEnv } from '@app/services'
import { setUiOverridesForTests, type UiRuntime } from '@/lib/ui/runtime'

export const BASE = 'http://localhost:3000'
/** Monday 2 November 2026, 15:00 UTC. */
export const NOW = new Date('2026-11-02T15:00:00.000Z')

export interface UiHarness {
  rt: ServicesFromEnv
  services: Services
  db: Db
  clock: ManualClock
  ui: UiRuntime
  /** A user (default: Pro, active) with a brand and active accounts on `platforms`. */
  tenant(options?: TestUserOptions & { platforms?: Platform[]; brandName?: string }): Promise<{ userId: string; email: string; brandId: string }>
  /** Signs `user` in for lib/ui/runtime (null = signed out). */
  signIn(user: { id: string; email: string } | null): void
  /** A ready image uploaded through services (stored in memory storage). */
  image(userId: string, brandId?: string): Promise<string>
  close(): Promise<void>
}

export async function createUiHarness(): Promise<UiHarness> {
  const env = {
    APP_ENV: 'test',
    NODE_ENV: 'test',
    APP_URL: BASE,
    DEV_AUTH: '1',
    SESSION_SECRET: 'test-session-secret-0123456789abcdef',
    STORAGE_DRIVER: 'memory',
    POSTING_PROVIDER: 'fake',
    TRANSCRIPTION_PROVIDER: 'fake',
    LOG_LEVEL: 'error',
  }
  const db = await createTestDb()
  const clock = manualClock(NOW)
  const rt = await createServicesFromEnv(env, { db, clock, logger: silentLogger, withoutTranscriber: true })
  const ui: UiRuntime = { services: rt.services, appUrl: BASE, mcpUrl: `${BASE}/api/mcp`, now: () => clock.now(), log: silentLogger }
  setUiOverridesForTests({ runtime: ui, user: null })
  let n = 0
  return {
    rt,
    services: rt.services,
    db,
    clock,
    ui,
    async tenant(options = {}) {
      n += 1
      const email = options.email ?? `user${n}-${Math.random().toString(36).slice(2, 8)}@example.com`
      const user = await createTestUser(db, { plan: 'pro', subscriptionStatus: 'active', ...options, email })
      const brand = await createTestBrand(db, user.id, { name: options.brandName ?? 'Acme Studio', timezone: 'America/New_York' })
      for (const platform of options.platforms ?? ['x', 'threads', 'instagram']) {
        await createTestAccount(db, user.id, brand.id, { platform, handle: `acme_${platform}` })
      }
      return { userId: user.id, email: user.email, brandId: brand.id }
    },
    signIn(user) {
      setUiOverridesForTests({ runtime: ui, user })
    },
    async image(userId, brandId) {
      const { media } = await rt.services.media.createUpload(
        userId,
        { filename: 'photo.jpg', contentType: 'image/jpeg', bytes: 2048, ...(brandId ? { brandId } : {}) },
        { purpose: 'post', via: 'web' },
      )
      await rt.storage.putBytes(media.storageKey, new Uint8Array(2048), 'image/jpeg')
      await rt.services.media.completeUpload(userId, media.id, {}, { via: 'web' })
      return media.id
    },
    async close() {
      setUiOverridesForTests(null)
      await db.close()
    },
  }
}

/** FormData from a plain object (arrays become repeated fields). */
export function form(values: Record<string, string | string[] | undefined>): FormData {
  const fd = new FormData()
  for (const [k, v] of Object.entries(values)) {
    if (v === undefined) continue
    for (const item of Array.isArray(v) ? v : [v]) fd.append(k, item)
  }
  return fd
}
