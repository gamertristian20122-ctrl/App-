import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createTestUser } from '@app/db/testing'
import { clipReserveKey } from '../src'
import { sourceKey } from '@app/storage'
import { DAY, OTHER_UUID, browserPut, createHarness, expectAppError, resetHarness, tenant, type Harness } from './helpers'

let h: Harness
beforeAll(async () => {
  h = await createHarness()
})
afterAll(async () => {
  await h.db.close()
})
beforeEach(async () => {
  await resetHarness(h)
})

const MB = 1_000_000

describe('media.createUpload / completeUpload', () => {
  it('presigns an exact-size PUT and makes an image ready after the head check', async () => {
    const { userId, brandId } = await tenant(h)
    const body = new Uint8Array(1234).fill(7)
    const res = await h.s.media.createUpload(userId, { brandId, filename: 'pic.png', contentType: 'image/png', bytes: body.length })
    expect(res.upload.mode).toBe('single')
    expect(res.media).toMatchObject({ status: 'pending', kind: 'image', origin: 'upload' })
    expect(res.media.storageKey.startsWith(`users/${userId}/uploads/`)).toBe(true)
    expect('sourceUrl' in res.media).toBe(false)

    // not uploaded yet
    await expectAppError(h.s.media.completeUpload(userId, res.media.id), 'validation', /not been uploaded/)
    if (res.upload.mode !== 'single') throw new Error('single upload expected')
    const put = await browserPut(h.storage, res.upload.url, res.upload.headers, body)
    expect(put.status).toBe(200)

    const done = await h.s.media.completeUpload(userId, res.media.id)
    expect(done).toMatchObject({ ingestQueued: false, media: { status: 'ready', bytes: 1234 } })
    // idempotent
    expect((await h.s.media.completeUpload(userId, res.media.id)).media.status).toBe('ready')
  })

  it('queues source_ingest for a video and records the rights attestation for clip sources', async () => {
    const { userId } = await tenant(h)
    const res = await h.s.media.createUpload(
      userId,
      { filename: 'talk.mp4', contentType: 'video/mp4', bytes: 2_000, rightsAttested: true },
      { purpose: 'clip_source' },
    )
    expect(res.media.rightsAttestedAt).not.toBeNull()
    await h.storage.putBytes(res.media.storageKey, new Uint8Array(2_000), 'video/mp4')
    const done = await h.s.media.completeUpload(userId, res.media.id)
    expect(done.ingestQueued).toBe(true)
    expect(done.media.status).toBe('pending')
    const jobs = await h.s.jobs.listForUser(userId, { type: 'source_ingest' })
    expect(jobs).toHaveLength(1)
  })

  it('requires the rights attestation and a video for clip sources', async () => {
    const { userId } = await tenant(h)
    await expectAppError(
      h.s.media.createUpload(userId, { filename: 'a.mp4', contentType: 'video/mp4', bytes: 10 }, { purpose: 'clip_source' }),
      'validation',
      /own this video/,
    )
    await expectAppError(
      h.s.media.createUpload(userId, { filename: 'a.png', contentType: 'image/png', bytes: 10, rightsAttested: true }, { purpose: 'clip_source' }),
      'validation',
    )
    // a post video without the attestation is fine (it is not a clip source)
    const res = await h.s.media.createUpload(userId, { filename: 'a.mp4', contentType: 'video/mp4', bytes: 10 })
    expect(res.media.rightsAttestedAt).toBeNull()
  })

  it('rejects unsupported types, oversize files and size mismatches', async () => {
    const { userId } = await tenant(h)
    await expectAppError(h.s.media.createUpload(userId, { filename: 'x.svg', contentType: 'image/svg+xml', bytes: 10 }), 'validation')
    await expectAppError(h.s.media.createUpload(userId, { filename: 'x.png', contentType: 'image/png', bytes: 30 * MB }), 'validation')
    const res = await h.s.media.createUpload(userId, { filename: 'x.png', contentType: 'image/png', bytes: 100 })
    await h.storage.putBytes(res.media.storageKey, new Uint8Array(99), 'image/png')
    await expectAppError(h.s.media.completeUpload(userId, res.media.id), 'validation', /size/)
    expect((await h.s.media.get(userId, res.media.id)).status).toBe('failed')
    expect(await h.storage.head(res.media.storageKey)).toBeNull()
  })

  it('enforces the storage allowance', async () => {
    const { userId } = await tenant(h)
    await h.r.media.create(userId, { kind: 'video', origin: 'upload', status: 'ready', storageKey: `users/${userId}/uploads/big.mp4`, bytes: 49_999_999_000 })
    const err = await expectAppError(h.s.media.createUpload(userId, { filename: 'a.png', contentType: 'image/png', bytes: 2_000 }), 'limit_exceeded')
    expect(err.details).toMatchObject({ remaining: 1_000 })
  })

  it('uses multipart above 5 GB', async () => {
    const { userId } = await tenant(h)
    const res = await h.s.media.createUpload(
      userId,
      { filename: 'long.mp4', contentType: 'video/mp4', bytes: 6_000_000_000, rightsAttested: true },
      { purpose: 'clip_source' },
    )
    expect(res.upload.mode).toBe('multipart')
    if (res.upload.mode !== 'multipart') return
    expect(res.upload.parts.length).toBeGreaterThan(100)
    expect(res.upload.parts.reduce((n, p) => n + p.bytes, 0)).toBe(6_000_000_000)
  })

  it('refuses another user’s media and brand ids', async () => {
    const a = await tenant(h)
    const b = await tenant(h)
    const res = await h.s.media.createUpload(b.userId, { filename: 'x.png', contentType: 'image/png', bytes: 10 })
    await expectAppError(h.s.media.get(a.userId, res.media.id), 'not_found')
    await expectAppError(h.s.media.completeUpload(a.userId, res.media.id), 'not_found')
    await expectAppError(h.s.media.createUpload(a.userId, { brandId: b.brandId, filename: 'x.png', contentType: 'image/png', bytes: 10 }), 'not_found')
  })
})

describe('media.registerDriveLink', () => {
  it('accepts allowlisted drive hosts and queues the download', async () => {
    const { userId, brandId } = await tenant(h)
    const res = await h.s.media.registerDriveLink(userId, {
      brandId,
      url: 'https://drive.google.com/file/d/abc123/view?usp=sharing',
      rightsAttested: true,
    })
    expect(res.media).toMatchObject({ origin: 'drive_link', sourceHost: 'drive.google.com', status: 'pending', kind: 'video' })
    expect('sourceUrl' in res.media).toBe(false)
    expect(res.media.storageKey.startsWith(`users/${userId}/sources/`)).toBe(true)
    const row = await h.s.media.getForWorker(userId, res.media.id)
    expect(row.sourceUrl).toContain('drive.google.com')
    expect(await h.s.jobs.listForUser(userId, { type: 'source_ingest' })).toHaveLength(1)
    const second = await tenant(h)
    for (const url of ['https://www.dropbox.com/s/x/v.mp4?dl=0', 'https://1drv.ms/v/s!abc', 'https://onedrive.live.com/?id=1']) {
      await h.s.media.registerDriveLink(second.userId, { url, rightsAttested: true })
    }
  })

  it('refuses links before any download when no clipping time or storage is left, or too many are pending (review)', async () => {
    const { userId } = await tenant(h) // starter: 4 h, 50 GB
    // three pending at most
    for (let i = 0; i < 3; i++) await h.s.media.registerDriveLink(userId, { url: `https://drive.google.com/file/d/${i}/view`, rightsAttested: true })
    const busy = await expectAppError(h.s.media.registerDriveLink(userId, { url: 'https://drive.google.com/file/d/9/view', rightsAttested: true }), 'limit_exceeded', /still being downloaded/)
    expect(busy.details).toMatchObject({ pending: 3, limit: 3 })

    const noTime = await tenant(h)
    await h.s.usage.reserve(noTime.userId, { meter: 'clip_seconds', amount: 14_400, idempotencyKey: 'manual:all' })
    const err = await expectAppError(h.s.media.registerDriveLink(noTime.userId, { url: 'https://drive.google.com/file/d/1/view', rightsAttested: true }), 'limit_exceeded', /No clipping time/)
    expect(err.details).toMatchObject({ meter: 'clip_seconds', remaining: 0 })

    const full = await tenant(h)
    await h.r.media.create(full.userId, { kind: 'video', origin: 'upload', status: 'ready', storageKey: `users/${full.userId}/uploads/big.mp4`, bytes: 50_000_000_000 })
    await expectAppError(h.s.media.registerDriveLink(full.userId, { url: 'https://drive.google.com/file/d/1/view', rightsAttested: true }), 'limit_exceeded', /storage is full/)
    expect(await h.s.jobs.listForUser(noTime.userId, { type: 'source_ingest' })).toHaveLength(0)
    expect(await h.s.jobs.listForUser(full.userId, { type: 'source_ingest' })).toHaveLength(0)
  })

  it('refuses YouTube and every other host, and http', async () => {
    const { userId } = await tenant(h)
    for (const url of [
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      'https://youtu.be/dQw4w9WgXcQ',
      'https://m.youtube.com/shorts/abc',
      'http://youtube.com/watch?v=1',
      'https://vimeo.com/123',
    ]) {
      const err = await expectAppError(h.s.media.registerDriveLink(userId, { url, rightsAttested: true }), 'validation', /own videos/)
      expect(err.details).toMatchObject({ reason: 'video_site_forbidden' })
    }
    const other = await expectAppError(h.s.media.registerDriveLink(userId, { url: 'https://example.com/v.mp4', rightsAttested: true }), 'validation')
    expect(other.details).toMatchObject({ reason: 'host_not_allowed' })
    const http = await expectAppError(h.s.media.registerDriveLink(userId, { url: 'http://drive.google.com/x', rightsAttested: true }), 'validation')
    expect(http.details).toMatchObject({ reason: 'not_https' })
    await expectAppError(h.s.media.registerDriveLink(userId, { url: 'https://drive.google.com/x' }), 'validation')
    expect(await h.r.media.list(userId)).toHaveLength(0)
    expect(await h.s.jobs.listForUser(userId)).toHaveLength(0)
  })

  it('is blocked while past_due (no new clipping)', async () => {
    const user = await createTestUser(h.db, { subscriptionStatus: 'past_due' })
    await expectAppError(h.s.media.registerDriveLink(user.id, { url: 'https://drive.google.com/x', rightsAttested: true }), 'payment_required')
  })
})

describe('media.markIngested + usage metering', () => {
  async function source(userId: string) {
    const res = await h.s.media.registerDriveLink(userId, { url: 'https://drive.google.com/file/d/1/view', rightsAttested: true })
    return res.media
  }

  it('reserves the source seconds, nulls the link and queues transcription', async () => {
    const { userId } = await tenant(h) // starter: 4 h
    const media = await source(userId)
    const res = await h.s.media.markIngested(userId, media.id, { durationMs: 600_500, bytes: 50 * MB, width: 1920, height: 1080, mimeType: 'video/mp4' })
    expect(res.transcribe).toBe(true)
    expect(res.media).toMatchObject({ status: 'ready', durationMs: 600_500 })
    expect((await h.s.media.getForWorker(userId, media.id)).sourceUrl).toBeNull()
    const balance = await h.s.usage.balance(userId)
    expect(balance).toMatchObject({ limit: 14_400, reserved: 601, used: 601, remaining: 13_799 })
    expect(await h.s.jobs.listForUser(userId, { type: 'transcribe' })).toHaveLength(1)
    // idempotent
    expect((await h.s.media.markIngested(userId, media.id, { durationMs: 600_500 })).transcribe).toBe(false)
    expect((await h.s.usage.balance(userId)).used).toBe(601)
  })

  it('refuses a source when the remaining balance is too small (details.remaining) and fails the media', async () => {
    const { userId } = await tenant(h)
    const first = await source(userId)
    await h.s.media.markIngested(userId, first.id, { durationMs: 3 * 3_600_000 })
    const second = await source(userId)
    const res = await h.s.media.markIngested(userId, second.id, { durationMs: 2 * 3_600_000 })
    expect(res.error).toMatch(/Not enough clipping time/)
    expect(res.media.status).toBe('failed')
    expect((await h.s.usage.balance(userId)).used).toBe(3 * 3_600)
    const err = await expectAppError(
      h.s.usage.reserve(userId, { meter: 'clip_seconds', amount: 7_200, idempotencyKey: 'manual:test' }),
      'limit_exceeded',
    )
    expect(err.details).toMatchObject({ remaining: 3_600, requested: 7_200, limit: 14_400 })
  })

  it('re-checks storage with the real size and deletes the file of a refused or failed source (review)', async () => {
    const { userId } = await tenant(h)
    await h.r.media.create(userId, { kind: 'video', origin: 'upload', status: 'ready', storageKey: `users/${userId}/uploads/big.mp4`, bytes: 45_000_000_000 })
    const media = await source(userId)
    await h.storage.putBytes(media.storageKey, new Uint8Array([1, 2, 3]), 'video/mp4')
    const res = await h.s.media.markIngested(userId, media.id, { durationMs: 60_000, bytes: 10_000_000_000 })
    expect(res.error).toMatch(/storage is full/)
    expect(res.media.status).toBe('failed')
    expect(await h.storage.head(media.storageKey)).toBeNull()
    expect((await h.s.usage.balance(userId)).used).toBe(0)

    // refused for clipping time: the file goes too
    const other = await tenant(h)
    await h.s.usage.reserve(other.userId, { meter: 'clip_seconds', amount: 14_000, idempotencyKey: 'manual:most' })
    const m2 = await source(other.userId)
    await h.storage.putBytes(m2.storageKey, new Uint8Array([1]), 'video/mp4')
    expect((await h.s.media.markIngested(other.userId, m2.id, { durationMs: 3_600_000, bytes: MB })).error).toMatch(/Not enough clipping time/)
    expect(await h.storage.head(m2.storageKey)).toBeNull()

    // the worker gave up: markFailed deletes the stored file as well
    const m3 = await source(other.userId)
    await h.storage.putBytes(m3.storageKey, new Uint8Array([1]), 'video/mp4')
    expect((await h.s.media.markFailed(other.userId, m3.id, new Error('unreadable'))).status).toBe('failed')
    expect(await h.storage.head(m3.storageKey)).toBeNull()
  })

  it('refuses sources over 4 hours', async () => {
    const { userId } = await tenant(h)
    const media = await source(userId)
    const res = await h.s.media.markIngested(userId, media.id, { durationMs: 4 * 3_600_000 + 1 })
    expect(res.error).toMatch(/4 hours/)
    expect((await h.s.usage.balance(userId)).used).toBe(0)
  })

  it('settles on transcript save (once) and releases on failure', async () => {
    const { userId } = await tenant(h)
    const a = await source(userId)
    await h.s.media.markIngested(userId, a.id, { durationMs: 120_000 })
    const result = { language: 'en', durationMs: 120_000, text: 'hello world', words: [{ s: 0, e: 500, t: 'hello' }, { s: 600, e: 1000, t: 'world' }], segments: [{ s: 0, e: 1000, t: 'hello world' }] }
    await h.s.transcripts.save(userId, a.id, { engine: 'fake', result })
    await h.s.transcripts.save(userId, a.id, { engine: 'fake', result }) // replay
    expect(await h.s.usage.balance(userId)).toMatchObject({ settled: 120, reserved: 0, used: 120 })

    const b = await source(userId)
    await h.s.media.markIngested(userId, b.id, { durationMs: 60_000 })
    expect((await h.s.usage.balance(userId)).used).toBe(180)
    expect(await h.s.transcripts.fail(userId, b.id, new Error('engine down'))).toEqual({ released: 60 })
    expect(await h.s.transcripts.fail(userId, b.id, 'again')).toEqual({ released: 0 })
    expect(await h.s.usage.balance(userId)).toMatchObject({ used: 120, reserved: 0 })
    const view = await h.s.transcripts.get(userId, { mediaId: b.id })
    expect(view.status).toBe('failed')
  })

  it('usage reserve/settle/release math and idempotency', async () => {
    const { userId } = await tenant(h)
    const r1 = await h.s.usage.reserve(userId, { meter: 'clip_seconds', amount: 1_000, idempotencyKey: 'k:1' })
    expect(r1.created).toBe(true)
    const again = await h.s.usage.reserve(userId, { meter: 'clip_seconds', amount: 1_000, idempotencyKey: 'k:1' })
    expect(again.created).toBe(false)
    expect((await h.s.usage.balance(userId)).used).toBe(1_000)
    // settle less than reserved: the rest returns
    const s1 = await h.s.usage.settle(userId, { reserveKey: 'k:1', amount: 400 })
    expect(s1).toEqual({ settled: 400, released: 1_000, created: true })
    expect((await h.s.usage.settle(userId, { reserveKey: 'k:1', amount: 400 })).created).toBe(false)
    expect(await h.s.usage.balance(userId)).toMatchObject({ used: 400, settled: 400, reserved: 0, remaining: 14_000 })
    // release after settle is a no-op
    expect((await h.s.usage.release(userId, { reserveKey: 'k:1' })).released).toBe(0)
    // a release then
    await h.s.usage.reserve(userId, { meter: 'clip_seconds', amount: 500, idempotencyKey: 'k:2' })
    expect((await h.s.usage.release(userId, { reserveKey: 'k:2' })).released).toBe(500)
    expect((await h.s.usage.balance(userId)).used).toBe(400)
    await expectAppError(h.s.usage.settle(userId, { reserveKey: 'k:unknown' }), 'validation')
    await expectAppError(h.s.usage.reserve(userId, { meter: 'clip_seconds', amount: -5, idempotencyKey: 'k:3' }), 'validation')
  })

  it('periods: Stripe period from the users row, otherwise the UTC calendar month', async () => {
    const user = await createTestUser(h.db, {
      currentPeriodStart: new Date('2026-10-20T00:00:00Z'),
      currentPeriodEnd: new Date('2026-11-20T00:00:00Z'),
    })
    expect((await h.s.usage.balance(user.id)).period.start.toISOString()).toBe('2026-10-20T00:00:00.000Z')
    await h.s.usage.reserve(user.id, { meter: 'clip_seconds', amount: 100, idempotencyKey: 'p:1' })
    // next period: a fresh allowance
    await h.r.users.updateBilling(user.id, { currentPeriodStart: new Date('2026-11-20T00:00:00Z'), currentPeriodEnd: new Date('2026-12-20T00:00:00Z') })
    h.clock.set('2026-11-25T00:00:00Z')
    expect((await h.s.usage.balance(user.id)).used).toBe(0)
    const noSub = await createTestUser(h.db)
    expect((await h.s.usage.balance(noSub.id)).period.start.toISOString()).toBe('2026-11-01T00:00:00.000Z')
  })

  it('an in-app trial meters over the trial, so crossing the 1st gives no second hour (review)', async () => {
    h.clock.set('2026-10-28T12:00:00Z')
    const user = await createTestUser(h.db, { plan: 'starter', subscriptionStatus: 'trialing', trialEndsAt: new Date('2026-11-04T12:00:00Z') })
    await h.s.usage.reserve(user.id, { meter: 'clip_seconds', amount: 3_600, idempotencyKey: 'trial:1' })
    h.clock.set('2026-11-01T09:00:00Z')
    const balance = await h.s.usage.balance(user.id)
    expect(balance).toMatchObject({ used: 3_600, remaining: 0 })
    expect(balance.period.start.toISOString()).toBe('2026-10-28T12:00:00.000Z')
    await expectAppError(h.s.usage.reserve(user.id, { meter: 'clip_seconds', amount: 60, idempotencyKey: 'trial:2' }), 'limit_exceeded')
  })

  it('a stale Stripe period (late renewal webhook) rolls forward instead of opening a calendar month (review)', async () => {
    h.clock.set('2026-11-10T00:00:00Z')
    const user = await createTestUser(h.db, { plan: 'pro', currentPeriodStart: new Date('2026-10-12T00:00:00Z'), currentPeriodEnd: new Date('2026-11-12T00:00:00Z') })
    h.clock.set('2026-11-13T00:00:00Z') // the renewal webhook has not arrived yet
    await h.s.usage.reserve(user.id, { meter: 'clip_seconds', amount: 72_000, idempotencyKey: 'pro:all' })
    // the webhook arrives: same period start, so the 20 h already reserved still count
    await h.r.users.updateBilling(user.id, { currentPeriodStart: new Date('2026-11-12T00:00:00Z'), currentPeriodEnd: new Date('2026-12-12T00:00:00Z') })
    expect(await h.s.usage.balance(user.id)).toMatchObject({ used: 72_000, remaining: 0 })
  })

  it('past_due blocks reservations; canceled holds them', async () => {
    const pastDue = await createTestUser(h.db, { subscriptionStatus: 'past_due' })
    await expectAppError(h.s.usage.reserve(pastDue.id, { meter: 'clip_seconds', amount: 10, idempotencyKey: 'x:1' }), 'payment_required', /payment/)
    const canceled = await createTestUser(h.db, { subscriptionStatus: 'canceled' })
    await expectAppError(h.s.usage.reserve(canceled.id, { meter: 'clip_seconds', amount: 10, idempotencyKey: 'x:2' }), 'payment_required')
  })

  it('deleting a ready source before its transcript exists gives the time back; a transcribed one stays charged', async () => {
    // regression: only `pending` sources were refunded on delete, and transcripts.fail refused a
    // deleted source, so the reservation of a deleted-before-transcription source leaked
    const { userId } = await tenant(h)
    const a = await source(userId)
    await h.s.media.markIngested(userId, a.id, { durationMs: 90_000 })
    expect((await h.s.usage.balance(userId)).used).toBe(90)
    await h.s.media.remove(userId, a.id)
    expect(await h.s.usage.balance(userId)).toMatchObject({ used: 0, reserved: 0 })
    // the in-flight transcribe job then fails: no error, nothing released twice
    expect(await h.s.transcripts.fail(userId, a.id, new Error('file gone'))).toEqual({ released: 0 })
    expect((await h.s.usage.balance(userId)).used).toBe(0)

    const b = await source(userId)
    await h.s.media.markIngested(userId, b.id, { durationMs: 60_000 })
    const result = { language: 'en', durationMs: 60_000, text: 'hi', words: [{ s: 0, e: 400, t: 'hi' }], segments: [{ s: 0, e: 400, t: 'hi' }] }
    await h.s.transcripts.save(userId, b.id, { engine: 'fake', result })
    await h.s.media.remove(userId, b.id)
    expect(await h.s.usage.balance(userId)).toMatchObject({ used: 60, settled: 60, reserved: 0 })
  })

  it('deleting a pending clip source releases its reservation', async () => {
    const { userId } = await tenant(h)
    const res = await h.s.media.createUpload(userId, { filename: 'a.mp4', contentType: 'video/mp4', bytes: 10, rightsAttested: true }, { purpose: 'clip_source' })
    await h.s.usage.reserve(userId, { meter: 'clip_seconds', amount: 50, idempotencyKey: clipReserveKey(res.media.id), subjectType: 'media', subjectId: res.media.id })
    await h.s.media.remove(userId, res.media.id)
    expect((await h.s.usage.balance(userId)).used).toBe(0)
    h.clock.advance(DAY)
  })
})

describe('media.promoteSource (worker ingest)', () => {
  it('moves a pending clip-source upload to its own sources/ key only', async () => {
    const { userId } = await tenant(h)
    const res = await h.s.media.createUpload(userId, { filename: 'a.mp4', contentType: 'video/mp4', bytes: 10, rightsAttested: true }, { purpose: 'clip_source' })
    const from = res.media.storageKey
    expect(from).toContain('/uploads/')
    const to = sourceKey(userId, res.media.id, 'mp4')
    await expectAppError(h.s.media.promoteSource(userId, res.media.id, from, sourceKey(userId, OTHER_UUID, 'mp4')), 'validation')
    await expectAppError(h.s.media.promoteSource(userId, res.media.id, from, from), 'validation')
    const moved = await h.s.media.promoteSource(userId, res.media.id, from, to)
    expect(moved?.storageKey).toBe(to)
    // a second move from the old key finds nothing (raced / already moved)
    expect(await h.s.media.promoteSource(userId, res.media.id, from, to)).toBeNull()
    // other users and post videos cannot
    const other = await tenant(h)
    await expectAppError(h.s.media.promoteSource(other.userId, res.media.id, to, to), 'not_found')
    const post = await h.s.media.createUpload(userId, { filename: 'b.mp4', contentType: 'video/mp4', bytes: 10 }, { purpose: 'post' })
    await expectAppError(h.s.media.promoteSource(userId, post.media.id, post.media.storageKey, sourceKey(userId, post.media.id, 'mp4')), 'validation')
  })
})
