// Migration 0004 (Auto-post): brand defaults (off), enum arrays, the rule's draft bookkeeping, the
// guard that only a switched-on brand's AI/worker drafts can be approved via 'auto_post', the
// posts.approved_via copy, and URL-import media constraints.

import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import * as brands from '../src/repos/brands'
import * as drafts from '../src/repos/drafts'
import * as media from '../src/repos/media'
import * as posts from '../src/repos/posts'
import { platformList } from '../src/repos/_mappers'
import { approveTestDraft, createTestDb, createTestDraft, resetTestDb, seedTenant } from '../src/testing'
import type { Db } from '../src/types'
import { expectDbError } from './helpers'

let db: Db
beforeAll(async () => {
  db = await createTestDb()
})
afterAll(async () => {
  await db.close()
})
beforeEach(async () => {
  await resetTestDb(db)
})

const enableAutoPost = (userId: string, brandId: string, platforms: string[] = []) =>
  brands.setAutoPost(db, userId, brandId, { enabled: true, platforms: platforms as never, dailyMax: 3, tiktokPrivacy: null, updatedAt: new Date() })

describe('0004 auto post: brands', () => {
  it('is applied and new brands start with Auto-post off (every platform, 3 per day)', async () => {
    const applied = await db.query<{ version: string }>(`select version from public.schema_migrations where version = '0004'`)
    expect(applied).toHaveLength(1)
    const t = await seedTenant(db)
    expect(t.brand).toMatchObject({ autoPostEnabled: false, autoPostPlatforms: [], autoPostDailyMax: 3, autoPostTiktokPrivacy: null, autoPostUpdatedAt: null })
  })

  it('stores the settings (platform[] round-trips) and checks the bounds', async () => {
    const t = await seedTenant(db)
    const row = await brands.setAutoPost(db, t.user.id, t.brand.id, {
      enabled: true,
      platforms: ['tiktok', 'youtube'],
      dailyMax: 25,
      tiktokPrivacy: 'SELF_ONLY',
      updatedAt: new Date('2026-11-02T12:00:00Z'),
    })
    expect(row).toMatchObject({ autoPostEnabled: true, autoPostPlatforms: ['tiktok', 'youtube'], autoPostDailyMax: 25, autoPostTiktokPrivacy: 'SELF_ONLY' })
    expect((await brands.list(db, t.user.id))[0]?.autoPostPlatforms).toEqual(['tiktok', 'youtube'])
    const base = { enabled: true, platforms: [] as never[], tiktokPrivacy: null, updatedAt: new Date() }
    await expectDbError(brands.setAutoPost(db, t.user.id, t.brand.id, { ...base, dailyMax: 0 }), '23514', 'brands_auto_post_daily_max')
    await expectDbError(brands.setAutoPost(db, t.user.id, t.brand.id, { ...base, dailyMax: 26 }), '23514', 'brands_auto_post_daily_max')
    await expectDbError(brands.setAutoPost(db, t.user.id, t.brand.id, { ...base, dailyMax: 3, tiktokPrivacy: 'EVERYONE' }), '23514', 'brands_auto_post_tiktok_privacy')
    await expectDbError(brands.setAutoPost(db, t.user.id, t.brand.id, { ...base, dailyMax: 3, platforms: ['myspace'] as never[] }), '22P02')
  })

  it('reads enum arrays in both driver formats', () => {
    expect(platformList(['x', 'tiktok', 'nope'])).toEqual(['x', 'tiktok'])
    expect(platformList('{x,tiktok}')).toEqual(['x', 'tiktok'])
    expect(platformList('{}')).toEqual([])
    expect(platformList(null)).toEqual([])
  })
})

describe('0004 auto post: drafts and posts', () => {
  it('records one request and one decision per draft, and counts rule approvals per brand', async () => {
    const t = await seedTenant(db)
    const { draft } = await createTestDraft(db, t.user.id, t.brand.id)
    expect(draft).toMatchObject({ autoPostWhen: null, autoPostRequestedAt: null, autoPostDecidedAt: null, autoPostOutcome: null })
    // a decision needs a request
    expect(await drafts.decideAutoPost(db, t.user.id, draft.id, { outcome: 'posted', note: null, at: new Date() })).toBeNull()
    const requested = await drafts.requestAutoPost(db, t.user.id, draft.id, { when: 'now', at: new Date('2026-11-02T12:00:00Z') })
    expect(requested).toMatchObject({ autoPostWhen: 'now' })
    // the first request wins
    expect(await drafts.requestAutoPost(db, t.user.id, draft.id, { when: 'best', at: new Date() })).toMatchObject({ autoPostWhen: 'now' })
    const decided = await drafts.decideAutoPost(db, t.user.id, draft.id, { outcome: 'daily_max', note: 'limit', at: new Date() })
    expect(decided).toMatchObject({ autoPostOutcome: 'daily_max', autoPostNote: 'limit' })
    // decided once
    expect(await drafts.decideAutoPost(db, t.user.id, draft.id, { outcome: 'posted', note: null, at: new Date() })).toBeNull()
    await expectDbError(
      db.query(`update public.drafts set auto_post_outcome = 'maybe' where id = $1`, [draft.id]),
      '23514',
      'drafts_auto_post_outcome',
    )
    await expectDbError(db.query(`update public.drafts set auto_post_outcome = null where id = $1`, [draft.id]), '23514', 'drafts_auto_post_decision')

    const other = await createTestDraft(db, t.user.id, t.brand.id)
    await drafts.requestAutoPost(db, t.user.id, other.draft.id, { when: 'now', at: new Date() })
    await drafts.decideAutoPost(db, t.user.id, other.draft.id, { outcome: 'posted', note: null, at: new Date() })
    expect(await drafts.countAutoPostedSince(db, t.user.id, t.brand.id, new Date(Date.now() - 86_400_000))).toBe(1)
    expect(await drafts.countAutoPostedSince(db, t.user.id, t.brand.id, new Date(Date.now() + 60_000))).toBe(0)
  })

  it('lists drafts waiting for the rule by attached media', async () => {
    const t = await seedTenant(db)
    const video = await media.create(db, t.user.id, { kind: 'video', origin: 'upload', status: 'pending', storageKey: `users/${t.user.id}/uploads/${randomUUID()}.mp4` })
    const { draft } = await createTestDraft(db, t.user.id, t.brand.id, { variants: [{ platform: 'instagram', text: 'v', mediaIds: [video.id] }] })
    expect(await drafts.listAwaitingAutoPost(db, t.user.id, video.id)).toEqual([])
    await drafts.requestAutoPost(db, t.user.id, draft.id, { when: 'now', at: new Date() })
    expect((await drafts.listAwaitingAutoPost(db, t.user.id, video.id)).map((d) => d.id)).toEqual([draft.id])
    const other = await seedTenant(db)
    expect(await drafts.listAwaitingAutoPost(db, other.user.id, video.id)).toEqual([])
  })

  it("refuses 'auto_post' approval unless the brand's switch is on and an AI or the worker made the draft", async () => {
    const t = await seedTenant(db)
    const ai = await createTestDraft(db, t.user.id, t.brand.id, { createdVia: 'mcp' })
    await expectDbError(drafts.approve(db, t.user.id, ai.draft.id, { revision: ai.draft.revision, via: 'auto_post' }), 'P0A06')
    await enableAutoPost(t.user.id, t.brand.id)
    const web = await createTestDraft(db, t.user.id, t.brand.id, { createdVia: 'web' })
    await expectDbError(drafts.approve(db, t.user.id, web.draft.id, { revision: web.draft.revision, via: 'auto_post' }), 'P0A06')
    const approved = await drafts.approve(db, t.user.id, ai.draft.id, { revision: ai.draft.revision, via: 'auto_post' })
    expect(approved).toMatchObject({ status: 'approved', approvedVia: 'auto_post' })
    // a person's approval is not affected by the switch
    expect(await approveTestDraft(db, t.user.id, web.draft.id, 'web')).toMatchObject({ approvedVia: 'web' })
  })

  it('copies who approved the draft into the post, and keeps it', async () => {
    const t = await seedTenant(db)
    await enableAutoPost(t.user.id, t.brand.id)
    const created = await createTestDraft(db, t.user.id, t.brand.id, {
      createdVia: 'worker',
      variants: [{ platform: 'instagram', text: 'auto', connectedAccountId: t.account.id }],
    })
    const draft = await approveTestDraft(db, t.user.id, created.draft.id, 'auto_post')
    const variant = created.variants[0]
    if (!variant) throw new Error('variant missing')
    const post = await posts.create(db, t.user.id, {
      brandId: t.brand.id,
      draftId: draft.id,
      variantId: variant.id,
      connectedAccountId: t.account.id,
      platform: 'instagram',
      scheduledFor: new Date(Date.now() + 60_000),
      approvedRevision: draft.revision,
      provider: 'fake',
    })
    expect(post.approvedVia).toBe('auto_post')
    await db.query(`update public.posts set approved_via = 'web' where id = $1`, [post.id])
    expect((await posts.get(db, t.user.id, post.id))?.approvedVia).toBe('auto_post')
  })
})

describe('0004 media: URL imports', () => {
  it('needs a host for url_import, keeps the old rules for the other origins', async () => {
    const t = await seedTenant(db)
    const key = () => `users/${t.user.id}/uploads/${randomUUID()}.mp4`
    const row = await media.create(db, t.user.id, {
      kind: 'video',
      origin: 'url_import',
      storageKey: key(),
      sourceHost: 'cdn.example.org',
      sourceUrl: 'https://cdn.example.org/render.mp4',
    })
    expect(row).toMatchObject({ origin: 'url_import', status: 'pending', sourceHost: 'cdn.example.org', rightsAttestedAt: null })
    await expectDbError(media.create(db, t.user.id, { kind: 'video', origin: 'url_import', storageKey: key() }), '23514', 'media_assets_drive_host')
    await expectDbError(
      media.create(db, t.user.id, { kind: 'video', origin: 'upload', storageKey: key(), sourceHost: 'cdn.example.org' }),
      '23514',
      'media_assets_drive_host',
    )
    await expectDbError(
      media.create(db, t.user.id, { kind: 'video', origin: 'upload', storageKey: key(), sourceUrl: 'https://cdn.example.org/a.mp4' }),
      '23514',
      'media_assets_source_url_origin',
    )
    await expectDbError(
      media.create(db, t.user.id, { kind: 'video', origin: 'drive_link', storageKey: key(), sourceHost: 'cdn.example.org', rightsAttestedAt: new Date() }),
      '23514',
      'media_assets_drive_host',
    )
    await expectDbError(
      media.create(db, t.user.id, { kind: 'video', origin: 'drive_link', storageKey: key(), rightsAttestedAt: new Date() }),
      '23514',
      'media_assets_drive_host',
    )
    const drive = await media.create(db, t.user.id, {
      kind: 'video',
      origin: 'drive_link',
      storageKey: key(),
      sourceHost: 'drive.google.com',
      sourceUrl: 'https://drive.google.com/file/d/abc/view',
      rightsAttestedAt: new Date(),
    })
    expect(drive.origin).toBe('drive_link')
  })
})
