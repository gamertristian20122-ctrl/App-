import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { bindRepos } from '../src/repos'
import * as accounts from '../src/repos/accounts'
import * as analytics from '../src/repos/analytics'
import * as audit from '../src/repos/audit'
import * as brands from '../src/repos/brands'
import * as clips from '../src/repos/clips'
import * as media from '../src/repos/media'
import * as pastPosts from '../src/repos/pastPosts'
import * as posts from '../src/repos/posts'
import * as transcripts from '../src/repos/transcripts'
import * as users from '../src/repos/users'
import * as voice from '../src/repos/voice'
import {
  createTestBrand,
  createTestDb,
  createTestMedia,
  createTestScheduledPost,
  createTestSourceVideo,
  createTestUser,
  seedTenant,
} from '../src/testing'
import type { Db } from '../src/types'
import { hoursFromNow, tick } from './helpers'

let db: Db
beforeAll(async () => {
  db = await createTestDb()
})
afterAll(async () => {
  await db.close()
})

describe('users repo', () => {
  it('ensure creates once and refreshes the email; profile and billing patches; lookups by Stripe ids', async () => {
    const id = randomUUID()
    await users.devEnsureAuthUser(db, id, 'first@example.test')
    const created = await users.ensure(db, id, { email: 'first@example.test', displayName: 'First' })
    expect(created).toMatchObject({ id, email: 'first@example.test', displayName: 'First', timezone: 'UTC', plan: null, subscriptionStatus: 'none', extraBrands: 0 })
    const again = await users.ensure(db, id, { email: 'second@example.test', displayName: 'Ignored' })
    expect(again).toMatchObject({ email: 'second@example.test', displayName: 'First' })
    expect(await users.updateProfile(db, id, {})).toMatchObject({ id })
    expect(await users.updateProfile(db, id, { timezone: 'Europe/Berlin', displayName: null })).toMatchObject({
      timezone: 'Europe/Berlin',
      displayName: null,
    })
    const start = new Date('2026-10-01T00:00:00Z')
    const end = new Date('2026-11-01T00:00:00Z')
    const billed = await users.updateBilling(db, id, {
      plan: 'plus',
      subscriptionStatus: 'active',
      currentPeriodStart: start,
      currentPeriodEnd: end,
      extraBrands: 2,
      extraClipHours: 5,
      stripeCustomerId: `cus_${id}`,
      stripeSubscriptionId: `sub_${id}`,
    })
    expect(billed).toMatchObject({ plan: 'plus', extraBrands: 2, extraClipHours: 5 })
    expect(billed?.currentPeriodStart?.toISOString()).toBe(start.toISOString())
    expect((await users.findByStripeCustomerId(db, `cus_${id}`))?.id).toBe(id)
    expect((await users.findByStripeSubscriptionId(db, `sub_${id}`))?.id).toBe(id)
    expect(await users.findByStripeCustomerId(db, 'cus_missing')).toBeNull()
    expect(await users.updateBilling(db, id, { plan: null, stripeSubscriptionId: null })).toMatchObject({ plan: null, stripeSubscriptionId: null })
    const locked = await db.tx((tx) => users.lockForUpdate(tx, id))
    expect(locked?.id).toBe(id)
    expect(await users.get(db, randomUUID())).toBeNull()
  })
})

describe('brands repo', () => {
  it('creates, lists, counts active, archives and suspends the newest beyond a limit', async () => {
    const user = await createTestUser(db)
    const one = await brands.create(db, user.id, { name: 'One', timezone: 'America/New_York' })
    await tick()
    const two = await brands.create(db, user.id, { name: 'Two' })
    await tick()
    const three = await brands.create(db, user.id, { name: 'Three' })
    expect(one).toMatchObject({ status: 'active', timezone: 'America/New_York', archivedAt: null })
    expect(await brands.countActive(db, user.id)).toBe(3)
    const archived = await brands.setStatus(db, user.id, two.id, 'archived')
    expect(archived?.archivedAt).toBeInstanceOf(Date)
    expect(await brands.countActive(db, user.id)).toBe(2)
    expect((await brands.list(db, user.id)).map((b) => b.name)).toEqual(['One', 'Two', 'Three'])
    expect((await brands.list(db, user.id, { status: 'active' })).map((b) => b.name)).toEqual(['One', 'Three'])
    expect((await brands.list(db, user.id, { status: ['archived', 'suspended'] })).map((b) => b.name)).toEqual(['Two'])
    const unarchived = await brands.setStatus(db, user.id, two.id, 'active')
    expect(unarchived?.archivedAt).toBeNull()
    const suspended = await brands.suspendNewest(db, user.id, 1)
    expect(suspended.map((b) => b.id).sort()).toEqual([two.id, three.id].sort())
    expect(await brands.countActive(db, user.id)).toBe(1)
    expect(await brands.update(db, user.id, one.id, { name: 'Renamed' })).toMatchObject({ name: 'Renamed' })
    expect((await brands.setProviderProfileRef(db, user.id, one.id, `ref-${one.id}`))?.providerProfileRef).toBe(`ref-${one.id}`)
  })

  it('scopes every call by user', async () => {
    const a = await createTestUser(db)
    const b = await createTestUser(db)
    const brand = await brands.create(db, a.id, { name: 'Mine' })
    expect(await brands.get(db, b.id, brand.id)).toBeNull()
    expect(await brands.update(db, b.id, brand.id, { name: 'Stolen' })).toBeNull()
    expect(await brands.setStatus(db, b.id, brand.id, 'archived')).toBeNull()
    expect(await brands.list(db, b.id)).toEqual([])
    expect((await brands.get(db, a.id, brand.id))?.name).toBe('Mine')
  })
})

describe('accounts repo', () => {
  it('upserts the live account per brand/platform, lists without credentials, stores ciphertext', async () => {
    const { user, brand } = await seedTenant(db)
    const pending = await accounts.upsertLive(db, user.id, { brandId: brand.id, platform: 'linkedin', provider: 'upload_post', status: 'pending' })
    expect(pending).toMatchObject({ status: 'pending', connectedAt: null, hasCredentials: false, scopes: [] })
    const active = await accounts.upsertLive(db, user.id, {
      brandId: brand.id,
      platform: 'linkedin',
      provider: 'upload_post',
      status: 'active',
      handle: '@me',
      externalAccountId: 'li-1',
      scopes: ['w_member_social'],
    })
    expect(active.id).toBe(pending.id)
    expect(active).toMatchObject({ status: 'active', handle: '@me', externalAccountId: 'li-1', scopes: ['w_member_social'] })
    expect(active.connectedAt).toBeInstanceOf(Date)
    expect((await accounts.findLive(db, user.id, brand.id, 'linkedin'))?.id).toBe(active.id)
    expect((await accounts.list(db, user.id, { brandId: brand.id })).map((a) => a.platform).sort()).toEqual(['instagram', 'linkedin'])
    expect((await accounts.list(db, user.id, { platform: 'linkedin' })).length).toBe(1)
    expect((await accounts.list(db, user.id, { status: ['disconnected'] })).length).toBe(0)

    expect(await accounts.getCredentials(db, user.id, active.id)).toBeNull()
    expect(await accounts.setCredentials(db, user.id, active.id, new Uint8Array([9, 8, 7]))).toBe(true)
    expect(Array.from((await accounts.getCredentials(db, user.id, active.id)) ?? [])).toEqual([9, 8, 7])
    const listed = await accounts.get(db, user.id, active.id)
    expect(listed?.hasCredentials).toBe(true)
    expect(listed).not.toHaveProperty('encryptedCredentials')

    const other = await createTestUser(db)
    expect(await accounts.getCredentials(db, other.id, active.id)).toBeNull()
    expect(await accounts.setCredentials(db, other.id, active.id, null)).toBe(false)

    const disconnected = await accounts.setStatus(db, user.id, active.id, 'disconnected')
    expect(disconnected?.status).toBe('disconnected')
    expect(await accounts.findLive(db, user.id, brand.id, 'linkedin')).toBeNull()
    const fresh = await accounts.upsertLive(db, user.id, { brandId: brand.id, platform: 'linkedin', provider: 'upload_post', status: 'pending' })
    expect(fresh.id).not.toBe(active.id)
    await accounts.markSynced(db, user.id, fresh.id, new Date('2026-10-30T00:00:00Z'))
    expect((await accounts.get(db, user.id, fresh.id))?.lastSyncedAt?.toISOString()).toBe('2026-10-30T00:00:00.000Z')
  })
})

describe('media, transcripts and clips repos', () => {
  it('creates, lists (hiding deleted), updates media and reports storage bytes', async () => {
    const { user, brand } = await seedTenant(db)
    const img = await createTestMedia(db, user.id, { brandId: brand.id, bytes: 5_000_000_000 })
    expect(img.bytes).toBe(5_000_000_000)
    const vid = await createTestSourceVideo(db, user.id)
    const drive = await media.create(db, user.id, {
      kind: 'video',
      origin: 'drive_link',
      storageKey: `sources/${randomUUID()}`,
      sourceHost: 'www.dropbox.com',
      sourceUrl: 'https://www.dropbox.com/s/abc/video.mp4?dl=0',
      rightsAttestedAt: new Date(),
    })
    expect(drive).toMatchObject({ status: 'pending', sourceHost: 'www.dropbox.com' })
    const fetched = await media.update(db, user.id, drive.id, { status: 'ready', sourceUrl: null, durationMs: 120_000, bytes: 123 })
    expect(fetched).toMatchObject({ status: 'ready', sourceUrl: null, sourceHost: 'www.dropbox.com', durationMs: 120_000, bytes: 123 })
    await media.update(db, user.id, img.id, { status: 'deleted' })
    expect((await media.list(db, user.id)).map((m) => m.id).sort()).toEqual([vid.id, drive.id].sort())
    expect((await media.list(db, user.id, { status: 'deleted' })).map((m) => m.id)).toEqual([img.id])
    expect((await media.list(db, user.id, { kind: 'video', origin: 'drive_link' })).map((m) => m.id)).toEqual([drive.id])
    expect((await media.list(db, user.id, { limit: 1 })).length).toBe(1)
    expect((await media.getMany(db, user.id, [img.id, vid.id, randomUUID()])).length).toBe(2)
    expect(await media.getMany(db, user.id, [])).toEqual([])
    expect((await media.findByStorageKey(db, user.id, vid.storageKey))?.id).toBe(vid.id)
    expect(await media.storageBytes(db, user.id)).toBe(50_000_000 + 123)
    const other = await createTestUser(db)
    expect(await media.get(db, other.id, vid.id)).toBeNull()
    expect(await media.getMany(db, other.id, [vid.id])).toEqual([])
  })

  it('saves one transcript per media (replacing it) with words and segments', async () => {
    const user = await createTestUser(db)
    const vid = await createTestSourceVideo(db, user.id)
    const first = await transcripts.save(db, user.id, {
      mediaId: vid.id,
      engine: 'whisper',
      language: 'en',
      durationMs: 600_000,
      text: 'hello world',
      words: [
        { s: 0, e: 400, t: 'hello' },
        { s: 450, e: 900, t: 'world' },
      ],
      segments: [{ s: 0, e: 900, t: 'hello world' }],
    })
    expect(first.words).toEqual([
      { s: 0, e: 400, t: 'hello' },
      { s: 450, e: 900, t: 'world' },
    ])
    const second = await transcripts.save(db, user.id, { mediaId: vid.id, engine: 'assemblyai', durationMs: 600_000, text: 'again', words: [], segments: [] })
    expect(second.id).toBe(first.id)
    expect(second).toMatchObject({ engine: 'assemblyai', text: 'again', language: null })
    expect((await transcripts.getByMedia(db, user.id, vid.id))?.text).toBe('again')
    expect((await transcripts.get(db, user.id, first.id))?.id).toBe(first.id)
    const other = await createTestUser(db)
    expect(await transcripts.getByMedia(db, other.id, vid.id)).toBeNull()
    await expect(
      transcripts.save(db, other.id, { mediaId: vid.id, engine: 'fake', durationMs: 1, text: 'x', words: [], segments: [] }),
    ).rejects.toThrow()
  })

  it('creates clips in one transaction (all or nothing), lists and updates them', async () => {
    const { user, brand } = await seedTenant(db)
    const src = await createTestSourceVideo(db, user.id)
    const created = await clips.createMany(db, user.id, [
      { brandId: brand.id, sourceMediaId: src.id, startMs: 0, endMs: 30_000, title: 'One', hook: 'Wait for it' },
      { brandId: brand.id, sourceMediaId: src.id, startMs: 60_000, endMs: 90_000, captionStyle: 'karaoke' },
    ])
    expect(created.map((c) => c.status)).toEqual(['queued', 'queued'])
    expect(created[1]?.captionStyle).toBe('karaoke')
    await expect(
      clips.createMany(db, user.id, [
        { brandId: brand.id, sourceMediaId: src.id, startMs: 100_000, endMs: 110_000 },
        { brandId: brand.id, sourceMediaId: src.id, startMs: 0, endMs: 200_000 },
      ]),
    ).rejects.toThrow()
    expect((await clips.list(db, user.id, { sourceMediaId: src.id })).length).toBe(2)
    const out = await createTestMedia(db, user.id, { kind: 'video', origin: 'clip', parentMediaId: src.id })
    const ready = await clips.update(db, user.id, created[0]!.id, { status: 'ready', outputMediaId: out.id })
    expect(ready).toMatchObject({ status: 'ready', outputMediaId: out.id })
    const failed = await clips.update(db, user.id, created[1]!.id, { status: 'failed', error: 'e'.repeat(5000) })
    expect(failed?.error?.length).toBe(4000)
    expect((await clips.list(db, user.id, { status: 'ready' })).map((c) => c.id)).toEqual([created[0]!.id])
    expect((await clips.list(db, user.id, { brandId: brand.id, status: ['ready', 'failed'] })).length).toBe(2)
    expect(await clips.get(db, (await createTestUser(db)).id, created[0]!.id)).toBeNull()
  })
})

describe('voice, past posts, analytics and audit repos', () => {
  it('versions voice profiles per brand; latest is active', async () => {
    const { user, brand } = await seedTenant(db)
    expect(await voice.getLatest(db, user.id, brand.id)).toBeNull()
    const v1 = await voice.save(db, user.id, brand.id, { profile: { tone: 'warm' }, source: 'manual' })
    const v2 = await voice.save(db, user.id, brand.id, { profile: { tone: 'punchy' }, source: 'mixed' })
    expect([v1?.version, v2?.version]).toEqual([1, 2])
    expect((await voice.getLatest(db, user.id, brand.id))?.profile).toEqual({ tone: 'punchy' })
    expect((await voice.getVersion(db, user.id, brand.id, 1))?.source).toBe('manual')
    expect((await voice.listVersions(db, user.id, brand.id)).map((v) => v.version)).toEqual([2, 1])
    const brand2 = await createTestBrand(db, user.id)
    expect((await voice.save(db, user.id, brand2.id, { profile: {}, source: 'imported' }))?.version).toBe(1)
    const other = await createTestUser(db)
    expect(await voice.save(db, other.id, brand.id, { profile: {}, source: 'manual' })).toBeNull()
    expect(await voice.getLatest(db, other.id, brand.id)).toBeNull()
  })

  it('upserts past posts by (brand, platform, external id) and keeps metrics unless given', async () => {
    const { user, brand } = await seedTenant(db)
    const first = await pastPosts.upsert(db, user.id, brand.id, {
      platform: 'x',
      externalPostId: '123',
      text: 'old tweet',
      postedAt: new Date('2026-09-01T00:00:00Z'),
      metrics: { likes: 5 },
    })
    const again = await pastPosts.upsert(db, user.id, brand.id, { platform: 'x', externalPostId: '123', permalink: 'https://x.com/a/status/123' })
    expect(again.id).toBe(first.id)
    expect(again).toMatchObject({ text: 'old tweet', metrics: { likes: 5 }, permalink: 'https://x.com/a/status/123' })
    const updated = await pastPosts.upsert(db, user.id, brand.id, { platform: 'x', externalPostId: '123', metrics: { likes: 9, views: 100 } })
    expect(updated.metrics).toEqual({ likes: 9, views: 100 })
    const batch = await pastPosts.upsertMany(db, user.id, brand.id, [
      { platform: 'instagram', externalPostId: 'a', postedAt: new Date('2026-10-01T00:00:00Z') },
      { platform: 'instagram', externalPostId: 'b', postedAt: new Date('2026-10-05T00:00:00Z') },
    ])
    expect(batch.length).toBe(2)
    expect(await pastPosts.count(db, user.id, brand.id)).toBe(3)
    expect((await pastPosts.list(db, user.id, brand.id, { platform: 'instagram' })).map((p) => p.externalPostId)).toEqual(['b', 'a'])
    expect((await pastPosts.list(db, user.id, brand.id, { since: new Date('2026-10-02T00:00:00Z') })).map((p) => p.externalPostId)).toEqual(['b'])
    expect((await pastPosts.get(db, user.id, first.id))?.externalPostId).toBe('123')
  })

  it('stores snapshots and summarises post performance for a window', async () => {
    const tenant = await seedTenant(db)
    const { user, brand } = tenant
    const s1 = await createTestScheduledPost(db, tenant, { text: 'first' })
    await posts.claimForPublish(db, user.id, s1.post.id)
    await posts.markPublished(db, user.id, s1.post.id, { publishedAt: new Date('2026-10-20T10:00:00Z'), postUrl: 'https://ig/p/1' })
    await analytics.insert(db, user.id, { brandId: brand.id, platform: 'instagram', scope: 'post', postId: s1.post.id, capturedAt: new Date('2026-10-21T10:00:00Z'), metrics: { views: 100 } })
    await analytics.insert(db, user.id, { brandId: brand.id, platform: 'instagram', scope: 'post', postId: s1.post.id, capturedAt: new Date('2026-10-22T10:00:00Z'), metrics: { views: 250, likes: 10 } })
    await analytics.insert(db, user.id, { brandId: brand.id, platform: 'instagram', scope: 'account', connectedAccountId: tenant.account.id, capturedAt: new Date('2026-10-21T00:00:00Z'), metrics: { followers: 1000 } })
    await analytics.insert(db, user.id, { brandId: brand.id, platform: 'instagram', scope: 'account', capturedAt: new Date('2026-10-22T00:00:00Z'), metrics: { followers: 1010 } })

    const perf = await analytics.postPerformance(db, user.id, brand.id, new Date('2026-10-19T00:00:00Z'), new Date('2026-10-26T00:00:00Z'))
    expect(perf).toHaveLength(1)
    expect(perf[0]).toMatchObject({ postId: s1.post.id, platform: 'instagram', text: 'first', postUrl: 'https://ig/p/1', metrics: { views: 250, likes: 10 } })
    expect(await analytics.postPerformance(db, user.id, brand.id, new Date('2026-10-26T00:00:00Z'), new Date('2026-11-02T00:00:00Z'))).toEqual([])

    const latest = await analytics.latestForPosts(db, user.id, [s1.post.id])
    expect(latest.map((s) => s.metrics)).toEqual([{ views: 250, likes: 10 }])
    expect((await analytics.latestAccountSnapshots(db, user.id, brand.id)).map((s) => s.metrics)).toEqual([{ followers: 1010 }])
    expect(
      (await analytics.latestAccountSnapshots(db, user.id, brand.id, new Date('2026-10-21T12:00:00Z'))).map((s) => s.metrics),
    ).toEqual([{ followers: 1000 }])
    const window = await analytics.listForBrand(db, user.id, brand.id, { scope: 'post', from: new Date('2026-10-22T00:00:00Z') })
    expect(window.map((s) => s.metrics)).toEqual([{ views: 250, likes: 10 }])
    expect((await analytics.listForBrand(db, user.id, brand.id, { platform: ['x'] })).length).toBe(0)
    const other = await createTestUser(db)
    expect(await analytics.latestForPosts(db, other.id, [s1.post.id])).toEqual([])
    expect(await analytics.postPerformance(db, other.id, brand.id, new Date(0), hoursFromNow(1))).toEqual([])
  })

  it('records audit entries and lists them per user', async () => {
    const user = await createTestUser(db)
    await audit.record(db, { userId: user.id, actor: 'mcp', action: 'draft.created', subjectType: 'draft', subjectId: 'd1' })
    await tick()
    await audit.record(db, { userId: user.id, actor: 'web', action: 'post.rescheduled', subjectType: 'post', subjectId: 'p1', meta: { from: 'a', to: 'b' } })
    await audit.record(db, { actor: 'system', action: 'cleanup.ran' })
    expect((await audit.list(db, user.id)).map((r) => r.action)).toEqual(['post.rescheduled', 'draft.created'])
    expect((await audit.list(db, user.id, { subjectType: 'post', subjectId: 'p1' }))[0]?.meta).toEqual({ from: 'a', to: 'b' })
    expect((await audit.list(db, user.id, { action: 'draft.created' })).length).toBe(1)
  })
})

describe('bindRepos', () => {
  it('pre-applies the db handle, also inside a transaction', async () => {
    const user = await createTestUser(db)
    const r = bindRepos(db)
    const brand = await r.brands.create(user.id, { name: 'Bound' })
    expect((await r.brands.get(user.id, brand.id))?.name).toBe('Bound')
    await expect(
      db.tx(async (tx) => {
        const t = bindRepos(tx)
        await t.brands.update(user.id, brand.id, { name: 'Inside tx' })
        expect((await t.brands.get(user.id, brand.id))?.name).toBe('Inside tx')
        throw new Error('rollback')
      }),
    ).rejects.toThrow('rollback')
    expect((await r.brands.get(user.id, brand.id))?.name).toBe('Bound')
    expect(typeof r.jobs.claim).toBe('function')
    expect(typeof r.maintenance.listDuePosts).toBe('function')
  })
})
