import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { backoffMs } from '@app/core/time'
import * as jobs from '../src/repos/jobs'
import * as usage from '../src/repos/usage'
import { createTestDb, createTestUser, resetTestDb } from '../src/testing'
import type { Db } from '../src/types'

let db: Db
beforeAll(async () => {
  db = await createTestDb()
})
afterAll(async () => {
  await db.close()
})

const OCT = new Date('2026-10-01T00:00:00Z')
const NOV = new Date('2026-11-01T00:00:00Z')

describe('usage ledger', () => {
  it('records idempotently by key and sums reserve/release/settle/adjust per meter and period', async () => {
    const user = await createTestUser(db)
    const media = randomUUID()
    const reserve = await usage.record(db, user.id, {
      meter: 'clip_seconds',
      kind: 'reserve',
      amount: 3600,
      periodStart: OCT,
      subjectType: 'media',
      subjectId: media,
      idempotencyKey: `clip_seconds:reserve:${media}`,
    })
    expect(reserve.created).toBe(true)
    const dup = await usage.record(db, user.id, {
      meter: 'clip_seconds',
      kind: 'reserve',
      amount: 9999,
      periodStart: OCT,
      idempotencyKey: `clip_seconds:reserve:${media}`,
    })
    expect(dup.created).toBe(false)
    expect(dup.entry.id).toBe(reserve.entry.id)
    expect(dup.entry.amount).toBe(3600)

    expect(await usage.totals(db, user.id, 'clip_seconds', OCT)).toEqual({
      reserved: 3600,
      released: 0,
      settled: 0,
      adjusted: 0,
      outstanding: 3600,
      used: 3600,
    })
    // settle = release the reservation + settle the actual amount
    await db.tx(async (tx) => {
      await usage.record(tx, user.id, { meter: 'clip_seconds', kind: 'release', amount: 3600, periodStart: OCT, subjectType: 'media', subjectId: media, idempotencyKey: `clip_seconds:release:${media}` })
      await usage.record(tx, user.id, { meter: 'clip_seconds', kind: 'settle', amount: 3540, periodStart: OCT, subjectType: 'media', subjectId: media, idempotencyKey: `clip_seconds:settle:${media}` })
    })
    await usage.record(db, user.id, { meter: 'clip_seconds', kind: 'adjust', amount: -40, periodStart: OCT, idempotencyKey: `goodwill:${user.id}`, note: 'support credit' })
    expect(await usage.totals(db, user.id, 'clip_seconds', OCT)).toEqual({
      reserved: 3600,
      released: 3600,
      settled: 3540,
      adjusted: -40,
      outstanding: 0,
      used: 3500,
    })
    // other meters and periods are separate
    await usage.record(db, user.id, { meter: 'x_link_posts', kind: 'settle', amount: 1, periodStart: OCT, idempotencyKey: `x:${randomUUID()}` })
    await usage.record(db, user.id, { meter: 'clip_seconds', kind: 'reserve', amount: 60, periodStart: NOV, idempotencyKey: `n:${randomUUID()}` })
    expect((await usage.totals(db, user.id, 'x_link_posts', OCT)).used).toBe(1)
    expect((await usage.totals(db, user.id, 'clip_seconds', NOV)).used).toBe(60)
    expect((await usage.totals(db, user.id, 'clip_seconds', OCT)).used).toBe(3500)

    expect((await usage.listForSubject(db, user.id, media)).map((e) => e.kind)).toEqual(['reserve', 'settle', 'release'])
    expect((await usage.list(db, user.id, { meter: 'clip_seconds', periodStart: OCT })).length).toBe(4)
    expect((await usage.list(db, user.id)).length).toBe(6)
  })

  it('refuses an idempotency key that belongs to another user', async () => {
    const a = await createTestUser(db)
    const b = await createTestUser(db)
    const key = `shared:${randomUUID()}`
    await usage.record(db, a.id, { meter: 'clip_seconds', kind: 'reserve', amount: 1, periodStart: OCT, idempotencyKey: key })
    await expect(usage.record(db, b.id, { meter: 'clip_seconds', kind: 'reserve', amount: 1, periodStart: OCT, idempotencyKey: key })).rejects.toThrow(
      /another user/,
    )
    expect((await usage.totals(db, b.id, 'clip_seconds', OCT)).used).toBe(0)
  })

  it('reserveWithinLimit reserves only within the limit and is idempotent', async () => {
    const user = await createTestUser(db)
    const limit = 4 * 3600
    const r1 = await usage.reserveWithinLimit(db, user.id, { meter: 'clip_seconds', amount: 3 * 3600, periodStart: OCT, limit, idempotencyKey: `r1:${user.id}` })
    expect(r1).toMatchObject({ ok: true, created: true, used: 3 * 3600 })
    const r2 = await usage.reserveWithinLimit(db, user.id, { meter: 'clip_seconds', amount: 3600 + 1, periodStart: OCT, limit, idempotencyKey: `r2:${user.id}` })
    expect(r2).toEqual({ ok: false, used: 3 * 3600, limit })
    const r3 = await usage.reserveWithinLimit(db, user.id, { meter: 'clip_seconds', amount: 3600, periodStart: OCT, limit, idempotencyKey: `r3:${user.id}` })
    expect(r3).toMatchObject({ ok: true, used: limit })
    // replay of r1 returns the existing entry without a new limit check
    const replay = await usage.reserveWithinLimit(db, user.id, { meter: 'clip_seconds', amount: 3 * 3600, periodStart: OCT, limit, idempotencyKey: `r1:${user.id}` })
    expect(replay).toMatchObject({ ok: true, created: false })
    expect((await usage.totals(db, user.id, 'clip_seconds', OCT)).used).toBe(limit)
  })
})

describe('jobs queue', () => {
  beforeEach(async () => {
    await resetTestDb(db)
  })

  it('enqueues with defaults and is idempotent by key', async () => {
    const user = await createTestUser(db)
    const first = await jobs.enqueue(db, { type: 'transcribe', userId: user.id, payload: { mediaId: 'm1' }, idempotencyKey: 'transcribe:m1' })
    expect(first.created).toBe(true)
    expect(first.job).toMatchObject({ type: 'transcribe', status: 'queued', attempts: 0, maxAttempts: 5, payload: { mediaId: 'm1' }, userId: user.id, result: null })
    const second = await jobs.enqueue(db, { type: 'transcribe', payload: { mediaId: 'other' }, idempotencyKey: 'transcribe:m1' })
    expect(second).toMatchObject({ created: false, job: { id: first.job.id, payload: { mediaId: 'm1' } } })
    const noKey1 = await jobs.enqueue(db, { type: 'cleanup' })
    const noKey2 = await jobs.enqueue(db, { type: 'cleanup' })
    expect(noKey1.job.id).not.toBe(noKey2.job.id)
    expect((await jobs.getByIdempotencyKey(db, 'transcribe:m1'))?.id).toBe(first.job.id)
    expect((await jobs.listForUser(db, user.id)).map((j) => j.id)).toEqual([first.job.id])
    expect(await jobs.listForUser(db, user.id, { status: 'running' })).toEqual([])
  })

  it('claims due jobs of the requested types in run_at order, never twice, skipping future ones', async () => {
    const now = new Date('2026-11-01T12:00:00Z')
    const mk = (type: string, minutesAgo: number) => jobs.enqueue(db, { type, runAt: new Date(now.getTime() - minutesAgo * 60_000) })
    const late = await mk('publish_post', 1)
    const early = await mk('publish_post', 10)
    const middle = await mk('check_post_status', 5)
    await mk('clip_render', 20) // another worker group
    await mk('publish_post', -5) // in the future

    const firstBatch = await jobs.claim(db, { types: ['publish_post', 'check_post_status'], workerId: 'posting-1', leaseSec: 60, limit: 2, now })
    expect(firstBatch.map((j) => j.id)).toEqual([early.job.id, middle.job.id])
    for (const job of firstBatch) {
      expect(job).toMatchObject({ status: 'running', attempts: 1, lockedBy: 'posting-1' })
      expect(job.lockedUntil?.getTime()).toBe(now.getTime() + 60_000)
    }
    const second = await jobs.claim(db, { types: ['publish_post', 'check_post_status'], workerId: 'posting-2', leaseSec: 60, limit: 5, now })
    expect(second.map((j) => j.id)).toEqual([late.job.id])
    expect(await jobs.claim(db, { types: ['publish_post', 'check_post_status'], workerId: 'posting-2', leaseSec: 60, now })).toEqual([])
    expect(await jobs.claim(db, { types: [], workerId: 'x', leaseSec: 60, now })).toEqual([])
    const media = await jobs.claim(db, { types: ['clip_render'], workerId: 'media-1', leaseSec: 600, now })
    expect(media.length).toBe(1)
    // the future job becomes due later
    const later = await jobs.claim(db, { types: ['publish_post'], workerId: 'posting-1', leaseSec: 60, now: new Date(now.getTime() + 10 * 60_000) })
    expect(later.length).toBe(1)
  })

  it('hands every job to exactly one of several workers (cross-session SKIP LOCKED: postgres.test.ts)', async () => {
    const ids = new Set<string>()
    for (let i = 0; i < 10; i++) ids.add((await jobs.enqueue(db, { type: 'publish_post' })).job.id)
    const claimed = await Promise.all(
      Array.from({ length: 5 }, (_, w) => jobs.claim(db, { types: ['publish_post'], workerId: `w${w}`, leaseSec: 30, limit: 3 })),
    )
    const all = claimed.flat().map((j) => j.id)
    expect(new Set(all).size).toBe(all.length)
    expect(new Set(all)).toEqual(ids)
  })

  it('complete requires the lease holder', async () => {
    await jobs.enqueue(db, { type: 'cleanup' })
    const [job] = await jobs.claim(db, { types: ['cleanup'], workerId: 'w1', leaseSec: 30 })
    expect(await jobs.complete(db, job!.id, 'w2', { ok: true })).toBeNull()
    const done = await jobs.complete(db, job!.id, 'w1', { deleted: 3 })
    expect(done).toMatchObject({ status: 'succeeded', result: { deleted: 3 }, lockedBy: null, lockedUntil: null })
    expect(done?.finishedAt).toBeInstanceOf(Date)
    expect(await jobs.complete(db, job!.id, 'w1')).toBeNull()
  })

  it('fail retries with backoff, then goes dead after max_attempts; permanent failures die at once', async () => {
    const now = new Date('2026-11-01T00:00:00Z')
    const { job } = await jobs.enqueue(db, { type: 'analytics_pull', maxAttempts: 2, runAt: now })
    const [c1] = await jobs.claim(db, { types: ['analytics_pull'], workerId: 'w', leaseSec: 30, now })
    expect(await jobs.fail(db, job.id, 'other-worker', 'nope', { now })).toBeNull()
    const f1 = await jobs.fail(db, c1!.id, 'w', 'HTTP 503', { now })
    expect(f1).toMatchObject({ status: 'failed', attempts: 1, lastError: 'HTTP 503', lockedBy: null, finishedAt: null })
    expect(f1?.runAt.getTime()).toBe(now.getTime() + backoffMs(1))
    // not due before the backoff elapses
    expect(await jobs.claim(db, { types: ['analytics_pull'], workerId: 'w', leaseSec: 30, now })).toEqual([])
    const retryAt = new Date(now.getTime() + backoffMs(1))
    const [c2] = await jobs.claim(db, { types: ['analytics_pull'], workerId: 'w', leaseSec: 30, now: retryAt })
    expect(c2?.attempts).toBe(2)
    const f2 = await jobs.fail(db, c2!.id, 'w', 'HTTP 503 again', { now: retryAt, retryInMs: 1000 })
    expect(f2).toMatchObject({ status: 'dead', attempts: 2, lastError: 'HTTP 503 again' })
    expect(f2?.finishedAt).toBeInstanceOf(Date)
    expect(await jobs.claim(db, { types: ['analytics_pull'], workerId: 'w', leaseSec: 30, now: new Date(retryAt.getTime() + 86_400_000) })).toEqual([])

    const { job: p } = await jobs.enqueue(db, { type: 'publish_post' })
    await jobs.claim(db, { types: ['publish_post'], workerId: 'w', leaseSec: 30 })
    const dead = await jobs.fail(db, p.id, 'w', 'validation failed: '.padEnd(5000, 'x'), { permanent: true })
    expect(dead?.status).toBe('dead')
    expect(dead?.lastError?.length).toBe(4000)
    // manual retry resets the budget
    const retried = await jobs.retry(db, p.id)
    expect(retried).toMatchObject({ status: 'queued', attempts: 0, finishedAt: null, lastError: null })
  })

  it('custom retry delay is honoured', async () => {
    const now = new Date('2026-11-02T00:00:00Z')
    await jobs.enqueue(db, { type: 'publish_post', runAt: now })
    const [c] = await jobs.claim(db, { types: ['publish_post'], workerId: 'w', leaseSec: 30, now })
    const f = await jobs.fail(db, c!.id, 'w', 'cap reached', { now, retryInMs: 3_600_000 })
    expect(f?.runAt.toISOString()).toBe('2026-11-02T01:00:00.000Z')
  })

  it('extends leases for the holder and requeues stale running jobs (or kills them when out of attempts)', async () => {
    const now = new Date('2026-11-03T00:00:00Z')
    const { job: a } = await jobs.enqueue(db, { type: 'clip_render', runAt: now })
    const { job: b } = await jobs.enqueue(db, { type: 'clip_render', runAt: now, maxAttempts: 1 })
    const { job: c } = await jobs.enqueue(db, { type: 'clip_render', runAt: now })
    await jobs.claim(db, { types: ['clip_render'], workerId: 'm1', leaseSec: 60, limit: 3, now })
    expect(await jobs.extendLease(db, c.id, 'm1', 600, now)).toBe(true)
    expect(await jobs.extendLease(db, c.id, 'm2', 600, now)).toBe(false)

    const later = new Date(now.getTime() + 120_000)
    expect(await jobs.requeueStale(db, later)).toEqual({ requeued: 1, dead: 1 })
    expect(await jobs.get(db, a.id)).toMatchObject({ status: 'failed', lockedBy: null, lastError: 'lease expired (worker stopped)' })
    expect((await jobs.get(db, b.id))?.status).toBe('dead')
    expect((await jobs.get(db, c.id))?.status).toBe('running')
    // the requeued job is claimable right away, by another worker
    const [again] = await jobs.claim(db, { types: ['clip_render'], workerId: 'm2', leaseSec: 60, now: later })
    expect(again).toMatchObject({ id: a.id, attempts: 2, lockedBy: 'm2' })
    // the original worker lost the lease
    expect(await jobs.complete(db, a.id, 'm1')).toBeNull()
  })
})
