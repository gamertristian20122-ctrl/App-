// Test harness for the worker: PGlite with the real migrations, FakePostingProvider, MemoryStorage,
// FakeTranscriber, a manual clock, a memory logger and the services with the worker's overrides.
// Nothing touches the network. Media-handler tests may reuse createWorkerHarness().

import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { JobRow, JobType, Platform } from '@app/core'
import { memoryLogger, testConfig, type MemoryLogger } from '@app/core/testing'
import { manualClock, type ManualClock } from '@app/core/time'
import { bindRepos, drafts as draftsRepo, type BoundRepos, type Db } from '@app/db'
import { createTestAccount, createTestBrand, createTestDb, createTestUser, resetTestDb, type TestUserOptions } from '@app/db/testing'
import { FakePostingProvider } from '@app/posting'
import { createServices, type Services } from '@app/services'
import { MemoryStorage } from '@app/storage'
import { FakeTranscriber } from '@app/transcription'
import { WORKER_SERVICES_OVERRIDES, type FullWorkerContext } from '../src/context'
import { createServicesQueue, type JobQueue } from '../src/queue'
import { Runner, type RunnerOptions } from '../src/runner'
import type { Handler } from '../src/types'

export const START = new Date('2026-11-02T12:00:00.000Z')
export const SECOND = 1_000
export const MINUTE = 60_000
export const HOUR = 3_600_000
export const DAY = 24 * HOUR

export interface WorkerHarness {
  db: Db
  r: BoundRepos
  clock: ManualClock
  provider: FakePostingProvider
  storage: MemoryStorage
  services: Services
  logger: MemoryLogger
  context: FullWorkerContext
  queue: JobQueue
}

export async function createWorkerHarness(): Promise<WorkerHarness> {
  const db = await createTestDb()
  const clock = manualClock(START)
  const provider = new FakePostingProvider({ clock })
  const storage = new MemoryStorage()
  const logger = memoryLogger('debug')
  const services = createServices({
    db,
    provider,
    storage,
    clock,
    config: { appUrl: 'https://app.test', ...WORKER_SERVICES_OVERRIDES },
    log: logger,
  })
  const config = testConfig({ WORKER_TYPES: 'all', WORKER_CONCURRENCY: '2', WORKER_POLL_INTERVAL_MS: '100' })
  const context: FullWorkerContext = {
    workerId: 'test-worker',
    logger,
    log: logger,
    clock,
    services,
    provider,
    storage,
    transcriber: new FakeTranscriber(),
    config,
    db,
    tmpDir: join(tmpdir(), 'app-worker-test'),
    close: async () => {},
  }
  return { db, r: bindRepos(db), clock, provider, storage, services, logger, context, queue: createServicesQueue({ services, db, clock }) }
}

/** Fresh state for each test (same database). */
export async function resetWorkerHarness(h: WorkerHarness): Promise<void> {
  await resetTestDb(h.db)
  h.clock.set(START)
  h.provider.reset()
  h.logger.lines.length = 0
}

/** A runner over the real queue with test-friendly timings (deterministic backoff: no jitter). */
export function makeRunner(h: WorkerHarness, handlers: Partial<Record<JobType, Handler>>, options: Partial<RunnerOptions> = {}): Runner {
  return new Runner({
    queue: h.queue,
    handlers,
    context: h.context,
    concurrency: 2,
    pollIntervalMs: 5,
    backoff: { baseMs: 30_000, maxMs: 6 * HOUR, jitter: 0 },
    shutdownGraceMs: 2_000,
    abortGraceMs: 500,
    ...options,
  })
}

/** A user (starter, active) with one active brand and one active account on `platform`. */
export async function tenant(h: WorkerHarness, platform: Platform = 'instagram', options: TestUserOptions = {}) {
  const user = await createTestUser(h.db, options)
  const brand = await createTestBrand(h.db, user.id, { name: 'Acme' })
  const account = await createTestAccount(h.db, user.id, brand.id, { platform })
  return { user, brand, account, userId: user.id, brandId: brand.id }
}

/** A ready uploaded image owned by the user (bytes stored in MemoryStorage). */
export async function image(h: WorkerHarness, userId: string, brandId: string | null = null) {
  const storageKey = `users/${userId}/uploads/${randomUUID()}.jpg`
  await h.storage.putBytes(storageKey, new Uint8Array([1, 2, 3]), 'image/jpeg')
  return h.r.media.create(userId, {
    brandId,
    kind: 'image',
    origin: 'upload',
    status: 'ready',
    storageKey,
    mimeType: 'image/jpeg',
    bytes: 3,
    width: 1080,
    height: 1350,
  })
}

/** Creates a draft through the services and approves it with a fresh nonce (as a human would). */
export async function approvedDraft(h: WorkerHarness, userId: string, brandId: string, variants: unknown[]) {
  const view = await h.services.drafts.create(userId, { brandId, variants })
  const nonce = await h.services.approvals.issueNonce(userId, view.draft.id, { via: 'web' })
  return h.services.approvals.approve(userId, { draftId: view.draft.id, nonce: nonce.nonce }, { via: 'web' })
}

/** An approved one-variant draft scheduled through services.posts.schedule (which queues publish_post). */
export async function scheduledPost(
  h: WorkerHarness,
  t: { userId: string; brandId: string },
  variant: Record<string, unknown>,
  at: string | Date = new Date(START.getTime() + HOUR),
) {
  const draft = await approvedDraft(h, t.userId, t.brandId, [variant])
  const [post] = await h.services.posts.schedule(t.userId, { draftId: draft.draft.id, at: at instanceof Date ? at.toISOString() : at }, { via: 'web' })
  if (!post) throw new Error('post missing')
  return { draft, post }
}

/** Seeds an approved one-variant draft and a published post directly (fills caps quickly). */
export async function seedPublishedPost(h: WorkerHarness, userId: string, brandId: string, accountId: string, platform: Platform, at: Date) {
  const created = await draftsRepo.create(h.db, userId, {
    brandId,
    createdVia: 'mcp',
    variants: [{ platform, text: `seeded ${randomUUID().slice(0, 8)}`, connectedAccountId: accountId }],
  })
  const draft = await draftsRepo.approve(h.db, userId, created.draft.id, { revision: created.draft.revision, via: 'web' })
  const variant = created.variants[0]
  if (!draft || !variant) throw new Error('seed failed')
  const post = await h.r.posts.create(userId, {
    brandId,
    draftId: draft.id,
    variantId: variant.id,
    connectedAccountId: accountId,
    platform,
    scheduledFor: at,
    approvedRevision: draft.revision,
    provider: 'fake',
  })
  await h.r.posts.claimForPublish(userId, post.id)
  await h.r.posts.setProviderRequest(userId, post.id, { providerRequestId: `fake_${platform}_${randomUUID().replace(/-/g, '').slice(0, 24)}` })
  const published = await h.r.posts.markPublished(userId, post.id, { publishedAt: at, providerPostId: `pp-${post.id.slice(0, 8)}` })
  if (!published) throw new Error('seed publish failed')
  return published
}

/** Every job of a type, oldest first. */
export async function jobsOfType(h: WorkerHarness, type: JobType): Promise<JobRow[]> {
  const rows = await h.db.query<{ id: string }>(`select id from public.jobs where type = $1 order by created_at, run_at, id`, [type])
  const out: JobRow[] = []
  for (const row of rows) {
    const job = await h.r.jobs.get(row.id)
    if (job) out.push(job)
  }
  return out
}

export async function getJob(h: WorkerHarness, id: string): Promise<JobRow> {
  const job = await h.r.jobs.get(id)
  if (!job) throw new Error('job missing')
  return job
}

/** A JobRow for calling a handler directly (attempt 1 of 5 unless overridden). */
export function jobRow(type: JobType, payload: Record<string, unknown>, overrides: Partial<JobRow> = {}): JobRow {
  const now = START
  return {
    id: randomUUID(),
    userId: typeof payload.userId === 'string' ? payload.userId : null,
    type,
    payload,
    status: 'running',
    runAt: now,
    attempts: 1,
    maxAttempts: 5,
    lockedBy: 'test-worker',
    lockedUntil: now,
    lastError: null,
    idempotencyKey: null,
    result: null,
    finishedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
}

/** A promise with its resolve function (to hold a handler open). */
export function deferred<T = void>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}
