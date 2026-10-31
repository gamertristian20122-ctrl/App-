import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createTestUser } from '@app/db/testing'
import { busiestWindowCount, exceedsCap, nextFreeSlot, parseJobPayload } from '../src'
import { HOUR, DAY, START, approvedDraft, connect, createHarness, expectAppError, resetHarness, tenant, type Harness } from './helpers'

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

describe('accounts', () => {
  it('connect link → sync mirrors the provider’s accounts', async () => {
    const { userId, brandId } = await tenant(h)
    const link = await h.s.accounts.connectLink(userId, { brandId, platform: 'tiktok' }, { redirectUrl: 'https://app.test/app/accounts' })
    expect(link.url).toContain('connect_status=success')
    const synced = await h.s.accounts.sync(userId, brandId)
    expect(synced.connected).toEqual(['tiktok'])
    expect(synced.accounts[0]).toMatchObject({ platform: 'tiktok', status: 'active', provider: 'fake' })
    expect(await h.s.accounts.list(userId, { brandId })).toHaveLength(1)

    // removed at the provider → disconnected here
    const brand = await h.s.brands.get(userId, brandId)
    await h.provider.disconnect({ profileRef: brand.providerProfileRef ?? '', platform: 'tiktok' })
    const again = await h.s.accounts.sync(userId, brandId)
    expect(again.disconnected).toEqual(['tiktok'])

    await expectAppError(h.s.accounts.connectLink(userId, { brandId, platform: 'tiktok' }, { redirectUrl: 'javascript:alert(1)' }), 'validation')
    await expectAppError(h.s.accounts.connectLink(userId, { brandId, platform: 'myspace' }), 'validation')
  })

  it('disconnect cancels scheduled posts; provider status changes apply', async () => {
    const { userId, brandId } = await tenant(h)
    await h.s.accounts.connectLink(userId, { brandId, platform: 'x' })
    const { accounts } = await h.s.accounts.sync(userId, brandId)
    const account = accounts[0]
    if (!account) throw new Error('account missing')
    const d = await approvedDraft(h, userId, brandId, [{ platform: 'x', text: 'hi' }])
    const [post] = await h.s.posts.schedule(userId, { draftId: d.draft.id, at: new Date(START.getTime() + HOUR).toISOString() })
    const updated = await h.s.accounts.applyProviderStatus(userId, brandId, 'x', 'needs_reauth')
    expect(updated?.status).toBe('needs_reauth')
    const disconnected = await h.s.accounts.disconnect(userId, account.id)
    expect(disconnected.status).toBe('disconnected')
    expect((await h.s.posts.get(userId, post?.id ?? '')).status).toBe('canceled')
    expect(await h.s.audit.list(userId, { action: 'account.disconnected' })).toHaveLength(1)
  })

  it('refuses other users’ brands and accounts; held users cannot connect', async () => {
    const a = await tenant(h)
    const b = await tenant(h)
    await h.s.accounts.connectLink(b.userId, { brandId: b.brandId, platform: 'x' })
    const { accounts } = await h.s.accounts.sync(b.userId, b.brandId)
    await expectAppError(h.s.accounts.connectLink(a.userId, { brandId: b.brandId, platform: 'x' }), 'not_found')
    await expectAppError(h.s.accounts.disconnect(a.userId, accounts[0]?.id ?? ''), 'not_found')
    await expectAppError(h.s.accounts.list(a.userId, { brandId: b.brandId }), 'not_found')
    await expectAppError(h.s.accounts.sync(a.userId, b.brandId), 'not_found')
    const held = await createTestUser(h.db, { subscriptionStatus: 'unpaid' })
    const brand = await h.r.brands.create(held.id, { name: 'Held' })
    await expectAppError(h.s.accounts.connectLink(held.id, { brandId: brand.id, platform: 'x' }), 'payment_required')
  })
})

describe('jobs', () => {
  it('validates payloads, claims, completes and fails with backoff', async () => {
    const { userId } = await tenant(h)
    await expectAppError(h.s.jobs.enqueue({ type: 'publish_post', payload: { userId, postId: 'nope' } as never }), 'validation')
    await expectAppError(h.s.jobs.enqueue({ type: 'mine_bitcoin' as never, payload: {} as never }), 'validation')
    const { job } = await h.s.jobs.enqueue({ type: 'cleanup', payload: {}, idempotencyKey: 'cleanup:1' })
    expect((await h.s.jobs.enqueue({ type: 'cleanup', payload: {}, idempotencyKey: 'cleanup:1' })).created).toBe(false)
    expect(job.payload).toEqual({ task: 'all' })

    const claimed = await h.s.jobs.claim({ workerId: 'w1', types: ['cleanup'], now: new Date(Date.now() + 1000) })
    expect(claimed.map((j) => j.id)).toEqual([job.id])
    expect(await h.s.jobs.claim({ workerId: 'w2', types: ['cleanup'], now: new Date(Date.now() + 1000) })).toHaveLength(0)
    const failed = await h.s.jobs.fail(job.id, 'w1', new Error('boom Bearer abcdef0123456789'))
    expect(failed?.status).toBe('failed')
    expect(failed?.lastError).toContain('[REDACTED]')
    const again = await h.s.jobs.claim({ workerId: 'w1', types: ['cleanup'], now: new Date(Date.now() + DAY) })
    expect(again).toHaveLength(1)
    const done = await h.s.jobs.complete(job.id, 'w1', { ok: true })
    expect(done?.status).toBe('succeeded')
    expect(parseJobPayload('cleanup', {})).toEqual({ task: 'all' })
    expect(() => parseJobPayload('clip_render', { userId })).toThrow(/clip_render job payload/)
  })

  it('release puts a running job back without using up its attempt; extendLease takes the app clock', async () => {
    const { job } = await h.s.jobs.enqueue({ type: 'cleanup', payload: {}, idempotencyKey: 'cleanup:release' })
    const now = new Date(Date.now() + 1000)
    const [claimed] = await h.s.jobs.claim({ workerId: 'w1', types: ['cleanup'], leaseSec: 60, now })
    expect(claimed?.attempts).toBe(1)
    expect(await h.s.jobs.extendLease(job.id, 'w2', 60, now)).toBe(false)
    expect(await h.s.jobs.extendLease(job.id, 'w1', 120, now)).toBe(true)
    const [row] = await h.db.query<{ locked_until: Date }>('select locked_until from public.jobs where id = $1', [job.id])
    expect(new Date(row?.locked_until ?? 0).getTime()).toBe(now.getTime() + 120_000)
    expect(await h.s.jobs.release(job.id, 'w2', now)).toBe(false)
    expect(await h.s.jobs.release(job.id, 'w1', now)).toBe(true)
    const [back] = await h.db.query<{ status: string; attempts: number; locked_by: string | null }>(
      'select status, attempts, locked_by from public.jobs where id = $1',
      [job.id],
    )
    expect(back).toEqual({ status: 'queued', attempts: 0, locked_by: null })
    expect(await h.s.jobs.release(job.id, 'w1', now)).toBe(false)
  })

  it('users can only see their own jobs', async () => {
    const a = await tenant(h)
    const b = await tenant(h)
    const res = await h.s.imports.importPastPosts(b.userId, { brandId: b.brandId }).catch((e: unknown) => e)
    expect(res).toBeInstanceOf(Error) // no accounts yet
    const { job } = await h.s.jobs.enqueue({ type: 'clip_render', payload: { userId: b.userId, clipId: '11111111-1111-4111-8111-111111111111' } })
    expect((await h.s.jobs.get(b.userId, job.id)).type).toBe('clip_render')
    await expectAppError(h.s.jobs.get(a.userId, job.id), 'not_found')
  })
})

describe('cap math', () => {
  const at = new Date(START.getTime() + 10 * HOUR)
  it('counts the busiest 24 h window containing the time, before or after it', () => {
    const before = Array.from({ length: 5 }, (_, i) => new Date(at.getTime() - (i + 1) * HOUR))
    const after = Array.from({ length: 5 }, (_, i) => new Date(at.getTime() + (i + 1) * HOUR))
    expect(busiestWindowCount(before, at)).toBe(6)
    expect(busiestWindowCount(after, at)).toBe(6)
    expect(busiestWindowCount([...before, ...after], at)).toBe(11)
    const far = [new Date(at.getTime() - DAY - 1), new Date(at.getTime() + DAY)]
    expect(busiestWindowCount(far, at)).toBe(1)
  })
  it('suggests the next free slot', () => {
    const youtube = Array.from({ length: 10 }, (_, i) => new Date(at.getTime() - 10 * HOUR + i * HOUR))
    expect(exceedsCap('youtube', youtube, at)).toBe(true)
    expect(nextFreeSlot('youtube', youtube, at)?.toISOString()).toBe(new Date(at.getTime() - 10 * HOUR + DAY).toISOString())
  })
})

describe('maintenance (system)', () => {
  it('cleanup deletes clip sources past the 30-day retention, keeps post videos, requeues due posts', async () => {
    const { userId, brandId } = await tenant(h)
    const { media: source } = await h.s.media.registerDriveLink(userId, { url: 'https://drive.google.com/file/d/1/view', rightsAttested: true })
    await h.s.media.markIngested(userId, source.id, { durationMs: 60_000 })
    await h.storage.putBytes(source.storageKey, new Uint8Array(10), 'video/mp4')
    const postVideo = await h.s.media.createUpload(userId, { filename: 'p.mp4', contentType: 'video/mp4', bytes: 10 })
    await connect(h, userId, brandId, 'x')
    const d = await approvedDraft(h, userId, brandId, [{ platform: 'x', text: 'due' }])
    const [due] = await h.s.posts.schedule(userId, { draftId: d.draft.id, at: new Date(START.getTime() + HOUR).toISOString() })
    await h.db.query(`delete from public.jobs where payload->>'postId' = $1`, [due?.id]) // its publish job was lost

    const later = new Date(Date.now() + 31 * DAY)
    const res = await h.s.maintenance.cleanup({ now: later })
    expect(res.deletedSources).toBe(1)
    expect(res.duePostsQueued).toBe(1)
    expect((await h.r.media.get(userId, source.id))?.status).toBe('deleted')
    await expectAppError(h.s.media.get(userId, source.id), 'not_found')
    expect(await h.storage.head(source.storageKey)).toBeNull()
    expect((await h.s.media.get(userId, postVideo.media.id)).status).toBe('pending')
  })

  it('cleanup releases clip time of sources that will never be transcribed (dead job, stale), never of transcribed ones', async () => {
    const { userId } = await tenant(h)
    const reg = async (durationMs: number) => {
      const { media } = await h.s.media.registerDriveLink(userId, { url: 'https://drive.google.com/file/d/1/view', rightsAttested: true })
      await h.s.media.markIngested(userId, media.id, { durationMs })
      return media
    }
    const dead = await reg(100_000)
    const slow = await reg(200_000)
    const done = await reg(300_000)
    const result = { language: 'en', durationMs: 300_000, text: 'ok', words: [{ s: 0, e: 300, t: 'ok' }], segments: [{ s: 0, e: 300, t: 'ok' }] }
    await h.s.transcripts.save(userId, done.id, { engine: 'fake', result })
    // the transcribe job of `dead` ran out of attempts without the worker reporting the failure
    await h.db.query(`update public.jobs set status = 'dead', finished_at = now() where idempotency_key = $1`, [`transcribe:${dead.id}`])
    expect((await h.s.usage.balance(userId)).used).toBe(600)

    const now = new Date()
    const first = await h.s.maintenance.cleanup({ now })
    expect(first.releasedReservations).toBe(1)
    expect((await h.s.usage.balance(userId)).used).toBe(500)
    expect((await h.s.audit.list(userId, { action: 'usage.reservation_released' }))[0]?.meta).toMatchObject({ reason: 'job_dead', seconds: 100 })

    // no transcript two days later: released too (a late transcript would still settle it)
    const later = await h.s.maintenance.cleanup({ now: new Date(now.getTime() + 3 * DAY) })
    expect(later.releasedReservations).toBe(1)
    expect(await h.s.usage.balance(userId)).toMatchObject({ used: 300, settled: 300, reserved: 0 })
    expect((await h.s.maintenance.cleanup({ now: new Date(now.getTime() + 3 * DAY) })).releasedReservations).toBe(0)
    void slow
  })

  it('retention cleanup is not starved by old post videos (they are never in the batch)', async () => {
    // regression: the stale-source query returned post videos too; they were skipped but filled
    // every batch, so clip sources behind them were never deleted
    const { userId } = await tenant(h)
    for (let i = 0; i < 3; i += 1) await h.s.media.createUpload(userId, { filename: `p${i}.mp4`, contentType: 'video/mp4', bytes: 10 })
    const { media: src } = await h.s.media.registerDriveLink(userId, { url: 'https://drive.google.com/file/d/2/view', rightsAttested: true })
    await h.s.media.markIngested(userId, src.id, { durationMs: 30_000 })
    const res = await h.s.maintenance.cleanup({ now: new Date(Date.now() + 31 * DAY), sourceBatch: 2 })
    expect(res.deletedSources).toBe(1)
    expect((await h.r.media.get(userId, src.id))?.status).toBe('deleted')
  })

  it('retention keeps a source that a live draft or a scheduled post still publishes (review)', async () => {
    const { userId, brandId } = await tenant(h)
    await connect(h, userId, brandId, 'youtube')
    const { media: src } = await h.s.media.registerDriveLink(userId, { brandId, url: 'https://drive.google.com/file/d/3/view', rightsAttested: true })
    await h.s.media.markIngested(userId, src.id, { durationMs: 120_000, width: 1920, height: 1080, mimeType: 'video/mp4' })
    await h.storage.putBytes(src.storageKey, new Uint8Array(10), 'video/mp4')
    const view = await h.s.drafts.create(userId, { brandId, variants: [{ platform: 'youtube', title: 'Full episode', text: 'The whole talk', mediaIds: [src.id] }] })

    const later = new Date(Date.now() + 31 * DAY)
    expect((await h.s.maintenance.cleanup({ now: later })).deletedSources).toBe(0)
    expect((await h.r.media.get(userId, src.id))?.status).toBe('ready')
    expect(await h.storage.head(src.storageKey)).not.toBeNull()

    // once the draft is archived the source is past retention and goes
    await h.s.drafts.archive(userId, view.draft.id)
    expect((await h.s.maintenance.cleanup({ now: later })).deletedSources).toBe(1)
    expect((await h.r.media.get(userId, src.id))?.status).toBe('deleted')
  })

  it('cleanup fails clips stuck queued/rendering whose render job died, freeing their slot (review)', async () => {
    const { userId, brandId } = await tenant(h)
    const { media: src } = await h.s.media.registerDriveLink(userId, { brandId, url: 'https://drive.google.com/file/d/4/view', rightsAttested: true })
    await h.s.media.markIngested(userId, src.id, { durationMs: 120_000 })
    const stuck = await h.r.clips.create(userId, { brandId, sourceMediaId: src.id, startMs: 0, endMs: 20_000 })
    await h.r.clips.update(userId, stuck.id, { status: 'rendering' })
    const dead = await h.s.jobs.enqueue({ type: 'clip_render', payload: { userId, clipId: stuck.id }, idempotencyKey: `clip_render:${stuck.id}` })
    await h.db.query(`update public.jobs set status = 'dead', finished_at = now() where id = $1`, [dead.job.id])
    const live = await h.r.clips.create(userId, { brandId, sourceMediaId: src.id, startMs: 20_000, endMs: 40_000 })
    await h.s.jobs.enqueue({ type: 'clip_render', payload: { userId, clipId: live.id }, idempotencyKey: `clip_render:${live.id}` })

    const res = await h.s.maintenance.cleanup({ now: new Date(Date.now() + HOUR) })
    expect(res.failedClips).toBe(1)
    expect(await h.s.clips.get(userId, stuck.id)).toMatchObject({ status: 'failed', error: expect.stringMatching(/Ask for this clip again/) })
    expect((await h.s.clips.get(userId, live.id)).status).toBe('queued')
    expect((await h.s.maintenance.cleanup({ now: new Date(Date.now() + HOUR) })).failedClips).toBe(0)
  })

  it('applies provider account status by profile ref', async () => {
    const { userId, brandId } = await tenant(h)
    await h.s.accounts.connectLink(userId, { brandId, platform: 'linkedin' })
    await h.s.accounts.sync(userId, brandId)
    const brand = await h.s.brands.get(userId, brandId)
    const row = await h.s.maintenance.applyProviderAccountStatus({ profileRef: brand.providerProfileRef ?? '', platform: 'linkedin', status: 'needs_reauth' })
    expect(row?.status).toBe('needs_reauth')
    expect(await h.s.maintenance.applyProviderAccountStatus({ profileRef: 'nobody', platform: 'linkedin', status: 'needs_reauth' })).toBeNull()
  })
})
