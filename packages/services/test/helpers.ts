// Test harness: a PGlite database with the real migrations, fakes for every port, a manual clock
// and the services. Nothing touches the network.

import { randomUUID } from 'node:crypto'
import { expect } from 'vitest'
import { AppError, type ErrorCode } from '@app/core/errors'
import { manualClock, type ManualClock } from '@app/core/time'
import type { Platform } from '@app/core/types'
import { bindRepos, drafts as draftsRepo, type BoundRepos, type Db } from '@app/db'
import {
  createTestAccount,
  createTestBrand,
  createTestDb,
  createTestUser,
  resetTestDb,
  type TestUserOptions,
} from '@app/db/testing'
import { FakePostingProvider } from '@app/posting'
import { MemoryStorage, createLocalStorageHandler } from '@app/storage'
import { createServices, type Services } from '../src'

export const START = new Date('2026-11-02T12:00:00.000Z')
export const HOUR = 3_600_000
export const DAY = 24 * HOUR

export interface Harness {
  db: Db
  r: BoundRepos
  clock: ManualClock
  provider: FakePostingProvider
  storage: MemoryStorage
  s: Services
}

export async function createHarness(): Promise<Harness> {
  const db = await createTestDb()
  const clock = manualClock(START)
  const provider = new FakePostingProvider({ clock })
  const storage = new MemoryStorage()
  const s = createServices({ db, provider, storage, clock, config: { appUrl: 'https://app.test' } })
  return { db, r: bindRepos(db), clock, provider, storage, s }
}

/** Fresh state for each test (same database). */
export async function resetHarness(h: Harness): Promise<void> {
  await resetTestDb(h.db)
  h.clock.set(START)
  h.provider.reset()
}

/** Asserts that `promise` rejects with an AppError of `code`; returns it. */
export async function expectAppError(promise: Promise<unknown>, code: ErrorCode, message?: RegExp): Promise<AppError> {
  let caught: unknown
  try {
    await promise
  } catch (error) {
    caught = error
  }
  expect(caught, `expected AppError ${code}`).toBeInstanceOf(AppError)
  const err = caught as AppError
  expect(err.code, `${err.code}: ${err.message}`).toBe(code)
  if (message) expect(err.message).toMatch(message)
  return err
}

/** A user (starter, active by default) with one active brand. */
export async function tenant(h: Harness, options: TestUserOptions = {}) {
  const user = await createTestUser(h.db, options)
  const brand = await createTestBrand(h.db, user.id, { name: 'Acme' })
  return { user, brand, userId: user.id, brandId: brand.id }
}

export async function connect(h: Harness, userId: string, brandId: string, platform: Platform = 'instagram') {
  return createTestAccount(h.db, userId, brandId, { platform })
}

/** A ready uploaded image owned by the user. */
export async function image(h: Harness, userId: string, brandId: string | null = null) {
  return h.r.media.create(userId, {
    brandId,
    kind: 'image',
    origin: 'upload',
    status: 'ready',
    storageKey: `users/${userId}/uploads/${randomUUID()}.jpg`,
    mimeType: 'image/jpeg',
    bytes: 200_000,
    width: 1080,
    height: 1350,
  })
}

/** A ready rendered vertical video (clip output) owned by the user. */
export async function video(h: Harness, userId: string, brandId: string | null = null, durationMs = 30_000) {
  return h.r.media.create(userId, {
    brandId,
    kind: 'video',
    origin: 'clip',
    status: 'ready',
    storageKey: `users/${userId}/clips/${randomUUID()}.mp4`,
    mimeType: 'video/mp4',
    bytes: 5_000_000,
    durationMs,
    width: 1080,
    height: 1920,
  })
}

/** Creates a draft through the service and approves it with a fresh nonce. */
export async function approvedDraft(
  h: Harness,
  userId: string,
  brandId: string,
  variants: unknown[] = [{ platform: 'instagram', text: 'Hello world', mediaIds: [] }],
) {
  const view = await h.s.drafts.create(userId, { brandId, variants })
  const nonce = await h.s.approvals.issueNonce(userId, view.draft.id)
  const approved = await h.s.approvals.approve(userId, { draftId: view.draft.id, nonce: nonce.nonce })
  return approved
}

/** Seeds an approved one-variant draft + scheduled post directly through the repositories (fast, for caps). */
export async function seedPost(h: Harness, userId: string, brandId: string, accountId: string, platform: Platform, at: Date, text = 'seeded') {
  const created = await draftsRepo.create(h.db, userId, {
    brandId,
    createdVia: 'mcp',
    variants: [{ platform, text: `${text} ${randomUUID().slice(0, 8)}`, connectedAccountId: accountId }],
  })
  const draft = await draftsRepo.approve(h.db, userId, created.draft.id, { revision: created.draft.revision, via: 'web' })
  if (!draft) throw new Error('seed approve failed')
  const variant = created.variants[0]
  if (!variant) throw new Error('variant missing')
  return h.r.posts.create(userId, {
    brandId,
    draftId: draft.id,
    variantId: variant.id,
    connectedAccountId: accountId,
    platform,
    scheduledFor: at,
    approvedRevision: draft.revision,
    provider: 'fake',
  })
}

/** Simulates the browser PUT to a presigned MemoryStorage URL. */
export async function browserPut(storage: MemoryStorage, url: string, headers: Record<string, string>, body: Uint8Array): Promise<Response> {
  const handler = createLocalStorageHandler(storage)
  return handler(new Request(url, { method: 'PUT', headers, body }))
}

export const OTHER_UUID = '99999999-9999-4999-8999-999999999999'
