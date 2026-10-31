import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as drafts from '../src/repos/drafts'
import * as posts from '../src/repos/posts'
import {
  approveTestDraft,
  createTestAccount,
  createTestDb,
  createTestDraft,
  createTestMedia,
  createTestScheduledPost,
  createTestUser,
  seedTenant,
  type TestTenant,
} from '../src/testing'
import type { Db } from '../src/types'
import { HOUR, tick } from './helpers'

let db: Db
beforeAll(async () => {
  db = await createTestDb()
})
afterAll(async () => {
  await db.close()
})

const T0 = new Date('2026-11-10T12:00:00Z')
const at = (hours: number) => new Date(T0.getTime() + hours * HOUR)

async function schedule(tenant: TestTenant, when: Date): Promise<posts.PostRow> {
  return (await createTestScheduledPost(db, tenant, { scheduledFor: when })).post
}

describe('drafts repo', () => {
  it('creates with variants, lists newest first with filters, fetches variants for many drafts', async () => {
    const { user, brand } = await seedTenant(db)
    const img = await createTestMedia(db, user.id)
    const a = await drafts.create(db, user.id, {
      brandId: brand.id,
      createdVia: 'mcp',
      notes: 'from claude',
      variants: [
        { platform: 'instagram', text: 'pic', mediaIds: [img.id], options: { shareToFeed: true } },
        { platform: 'x', text: 'see https://example.com', hasLink: true },
      ],
    })
    expect(a.draft).toMatchObject({ createdVia: 'mcp', notes: 'from claude', revision: 1 })
    expect(a.variants[0]).toMatchObject({ platform: 'instagram', mediaIds: [img.id], options: { shareToFeed: true }, hasLink: false })
    expect(a.variants[1]).toMatchObject({ platform: 'x', hasLink: true, title: null, connectedAccountId: null })
    await tick()
    const b = await drafts.create(db, user.id, { brandId: brand.id, createdVia: 'web' })
    await approveTestDraft(db, user.id, a.draft.id)

    expect((await drafts.list(db, user.id)).map((d) => d.id)).toEqual([b.draft.id, a.draft.id])
    expect((await drafts.list(db, user.id, { status: 'approved' })).map((d) => d.id)).toEqual([a.draft.id])
    expect((await drafts.list(db, user.id, { status: ['draft', 'rejected'], brandId: brand.id })).map((d) => d.id)).toEqual([b.draft.id])
    expect((await drafts.list(db, user.id, { limit: 1 })).length).toBe(1)
    expect((await drafts.list(db, user.id, { before: new Date(Date.now() + HOUR) })).length).toBe(2)
    const many = await drafts.listVariantsForDrafts(db, user.id, [a.draft.id, b.draft.id])
    expect(many.map((v) => v.platform)).toEqual(['instagram', 'x'])
    expect(await drafts.listVariantsForDrafts(db, user.id, [])).toEqual([])
    const full = await drafts.getWithVariants(db, user.id, a.draft.id)
    expect(full?.variants.length).toBe(2)
    expect(await drafts.getWithVariants(db, (await createTestUser(db)).id, a.draft.id)).toBeNull()
    expect((await drafts.getVariant(db, user.id, a.variants[0]!.id))?.id).toBe(a.variants[0]!.id)
    expect(await drafts.updateVariant(db, user.id, a.variants[0]!.id, {})).toMatchObject({ id: a.variants[0]!.id })
    const edited = await drafts.updateVariant(db, user.id, a.variants[0]!.id, { mediaIds: [], options: { mediaType: 'REELS' }, hasLink: false })
    expect(edited).toMatchObject({ mediaIds: [], options: { mediaType: 'REELS' } })
    const locked = await db.tx((tx) => drafts.lockForUpdate(tx, user.id, a.draft.id))
    expect(locked?.revision).toBe(2)
  })

  it('upserts variants by platform (last wins) and creates nothing when one variant is invalid', async () => {
    const { user, brand } = await seedTenant(db)
    await expect(
      drafts.create(db, user.id, {
        brandId: brand.id,
        createdVia: 'mcp',
        variants: [{ platform: 'x', text: 'ok' }, { platform: 'x', text: 'duplicate platform' }],
      }),
    ).resolves.toMatchObject({ variants: [{ text: 'ok' }, { text: 'duplicate platform' }] })
    // the second x variant replaced the first (upsert by platform): still one row
    const [only] = await drafts.list(db, user.id)
    expect((await drafts.listVariants(db, user.id, only!.id)).map((v) => v.text)).toEqual(['duplicate platform'])
    await expect(
      drafts.create(db, user.id, {
        brandId: brand.id,
        createdVia: 'mcp',
        variants: [{ platform: 'x', text: 'ok' }, { platform: 'tiktok', mediaIds: ['00000000-0000-0000-0000-000000000000'] }],
      }),
    ).rejects.toThrow()
    expect((await drafts.list(db, user.id)).length).toBe(1)
  })
})

describe('posts repo', () => {
  it('lists posts by window, status, brand and draft in calendar order', async () => {
    const tenant = await seedTenant(db)
    const p1 = await schedule(tenant, at(5))
    const p2 = await schedule(tenant, at(1))
    const p3 = await schedule(tenant, at(30))
    await posts.cancel(db, tenant.user.id, p3.id)
    const { user } = tenant
    expect((await posts.list(db, user.id)).map((p) => p.id)).toEqual([p2.id, p1.id, p3.id])
    expect((await posts.list(db, user.id, { from: at(0), to: at(24) })).map((p) => p.id)).toEqual([p2.id, p1.id])
    expect((await posts.list(db, user.id, { status: 'canceled' })).map((p) => p.id)).toEqual([p3.id])
    expect((await posts.list(db, user.id, { draftId: p1.draftId })).map((p) => p.id)).toEqual([p1.id])
    expect((await posts.list(db, user.id, { brandId: tenant.brand.id, connectedAccountId: tenant.account.id })).length).toBe(3)
    const other = await createTestUser(db)
    expect(await posts.list(db, other.id)).toEqual([])
    expect(await posts.get(db, other.id, p1.id)).toBeNull()
  })

  it('countInWindow / activeTimesInRange count active posts per account by publish-or-schedule time', async () => {
    const tenant = await seedTenant(db, { platform: 'tiktok' })
    const { user, account } = tenant
    const inWindow = [await schedule(tenant, at(0)), await schedule(tenant, at(3)), await schedule(tenant, at(23.5))]
    await schedule(tenant, at(24)) // outside [at(0), at(24))
    await schedule(tenant, at(-0.5)) // before the window
    const canceled = await schedule(tenant, at(2))
    await posts.cancel(db, user.id, canceled.id)
    const failed = await schedule(tenant, at(4))
    await posts.markFailed(db, user.id, failed.id, 'boom')
    // published posts count at published_at, not scheduled_for
    const early = await schedule(tenant, at(-5))
    await posts.claimForPublish(db, user.id, early.id)
    await posts.markPublished(db, user.id, early.id, { publishedAt: at(1) })
    // another account of the same user does not count
    const yt = await createTestAccount(db, user.id, tenant.brand.id, { platform: 'youtube' })
    await schedule({ ...tenant, account: yt }, at(1))

    expect(await posts.countInWindow(db, user.id, account.id, at(0), at(24))).toBe(inWindow.length + 1)
    const times = await posts.activeTimesInRange(db, user.id, account.id, at(0), at(24))
    expect(times.map((t) => t.toISOString())).toEqual([at(0), at(1), at(3), at(23.5)].map((d) => d.toISOString()))
    expect(await posts.countInWindow(db, user.id, yt.id, at(0), at(24))).toBe(1)
    const other = await createTestUser(db)
    expect(await posts.countInWindow(db, other.id, account.id, at(0), at(24))).toBe(0)
  })

  it('finds posts by provider request id for webhooks', async () => {
    const tenant = await seedTenant(db)
    const p = await schedule(tenant, at(1))
    await posts.claimForPublish(db, tenant.user.id, p.id)
    await posts.setProviderRequest(db, tenant.user.id, p.id, { providerRequestId: `req-${p.id}`, provider: 'upload_post' })
    expect((await posts.findByProviderRequest(db, 'upload_post', `req-${p.id}`)).map((r) => r.id)).toEqual([p.id])
    expect((await posts.findByProviderRequest(db, 'upload_post', `req-${p.id}`, 'instagram')).length).toBe(1)
    expect(await posts.findByProviderRequest(db, 'upload_post', `req-${p.id}`, 'x')).toEqual([])
    expect(await posts.findByProviderRequest(db, 'fake', `req-${p.id}`)).toEqual([])
  })

  it('reschedule only moves scheduled posts', async () => {
    const tenant = await seedTenant(db)
    const p = await schedule(tenant, at(1))
    expect((await posts.reschedule(db, tenant.user.id, p.id, at(2)))?.scheduledFor.toISOString()).toBe(at(2).toISOString())
    await posts.claimForPublish(db, tenant.user.id, p.id)
    expect(await posts.reschedule(db, tenant.user.id, p.id, at(3))).toBeNull()
  })

  it('a re-approved draft can be scheduled again after its post was canceled by an edit', async () => {
    const tenant = await seedTenant(db)
    const created = await createTestDraft(db, tenant.user.id, tenant.brand.id)
    const approved = await approveTestDraft(db, tenant.user.id, created.draft.id)
    const input = {
      brandId: tenant.brand.id,
      draftId: approved.id,
      variantId: created.variants[0]!.id,
      connectedAccountId: tenant.account.id,
      platform: 'instagram' as const,
      scheduledFor: at(1),
      approvedRevision: approved.revision,
      provider: 'fake',
    }
    const first = await posts.create(db, tenant.user.id, input)
    await drafts.updateVariant(db, tenant.user.id, created.variants[0]!.id, { text: 'v2' })
    expect((await posts.get(db, tenant.user.id, first.id))?.status).toBe('canceled')
    const again = await approveTestDraft(db, tenant.user.id, created.draft.id)
    const second = await posts.create(db, tenant.user.id, { ...input, approvedRevision: again.revision })
    expect(second.approvedRevision).toBe(2)
  })
})
