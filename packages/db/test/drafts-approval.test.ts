import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { APP_SQLSTATE } from '../src/errors'
import * as drafts from '../src/repos/drafts'
import * as posts from '../src/repos/posts'
import {
  approveTestDraft,
  createTestAccount,
  createTestBrand,
  createTestDb,
  createTestDraft,
  createTestMedia,
  createTestScheduledPost,
  seedTenant,
} from '../src/testing'
import type { Db } from '../src/types'
import { expectDbError } from './helpers'

let db: Db
beforeAll(async () => {
  db = await createTestDb()
})
afterAll(async () => {
  await db.close()
})

const get = async (userId: string, draftId: string) => {
  const d = await drafts.get(db, userId, draftId)
  if (!d) throw new Error('draft missing')
  return d
}

describe('draft revision and content hash', () => {
  it('starts at revision 1 with a hash over brand + variants; the creating transaction does not bump', async () => {
    const { user, brand } = await seedTenant(db)
    const empty = await createTestDraft(db, user.id, brand.id, { variants: [] })
    expect(empty.draft.revision).toBe(1)
    expect(empty.draft.status).toBe('draft')
    expect(empty.draft.contentHash).toMatch(/^[0-9a-f]{64}$/)

    const withVariants = await createTestDraft(db, user.id, brand.id, {
      variants: [
        { platform: 'instagram', text: 'one' },
        { platform: 'x', text: 'two' },
        { platform: 'tiktok', text: 'three' },
      ],
    })
    expect(withVariants.draft.revision).toBe(1)
    expect(withVariants.variants.map((v) => v.platform)).toEqual(['instagram', 'x', 'tiktok'])
    expect(withVariants.draft.contentHash).not.toBe(empty.draft.contentHash)
  })

  it('computes the same hash for the same content and a different one for any change', async () => {
    const { user, brand } = await seedTenant(db)
    const m = await createTestMedia(db, user.id)
    const content = [
      { platform: 'x' as const, text: 'same', options: { longTextMode: 'thread' } },
      { platform: 'instagram' as const, text: 'same', mediaIds: [m.id] },
    ]
    const a = await createTestDraft(db, user.id, brand.id, { variants: content })
    const b = await createTestDraft(db, user.id, brand.id, { variants: [...content].reverse() })
    expect(a.draft.contentHash).toBe(b.draft.contentHash)
    const c = await createTestDraft(db, user.id, brand.id, { variants: [content[0]!, { ...content[1]!, text: 'Same' }] })
    expect(c.draft.contentHash).not.toBe(a.draft.contentHash)
    const brand2 = await createTestBrand(db, user.id)
    const d = await createTestDraft(db, user.id, brand2.id, { variants: content })
    expect(d.draft.contentHash).not.toBe(a.draft.contentHash)
  })

  it('bumps the revision once per transaction on variant insert, update and delete', async () => {
    const { user, brand } = await seedTenant(db)
    const { draft, variants } = await createTestDraft(db, user.id, brand.id)
    const v = variants[0]!

    await drafts.upsertVariant(db, user.id, draft.id, { platform: 'x', text: 'new variant' })
    const r2 = await get(user.id, draft.id)
    expect(r2.revision).toBe(2)
    expect(r2.contentHash).not.toBe(draft.contentHash)

    await drafts.updateVariant(db, user.id, v.id, { text: 'edited' })
    const r3 = await get(user.id, draft.id)
    expect(r3.revision).toBe(3)

    await drafts.deleteVariant(db, user.id, draft.id, 'x')
    const r4 = await get(user.id, draft.id)
    expect(r4.revision).toBe(4)

    // several changes in one transaction: one bump
    await db.tx(async (tx) => {
      await drafts.updateVariant(tx, user.id, v.id, { text: 'a' })
      await drafts.upsertVariant(tx, user.id, draft.id, { platform: 'threads', text: 'b' })
      await drafts.updateVariant(tx, user.id, v.id, { title: 'c' })
    })
    const r5 = await get(user.id, draft.id)
    expect(r5.revision).toBe(5)
  })

  it('does not bump when nothing about the content changes (same values, notes, updated_at)', async () => {
    const { user, brand } = await seedTenant(db)
    const { draft, variants } = await createTestDraft(db, user.id, brand.id, {
      variants: [{ platform: 'instagram', text: 'stable', options: { shareToFeed: true } }],
    })
    await drafts.upsertVariant(db, user.id, draft.id, { platform: 'instagram', text: 'stable', options: { shareToFeed: true } })
    await drafts.updateVariant(db, user.id, variants[0]!.id, { text: 'stable' })
    await drafts.updateNotes(db, user.id, draft.id, 'internal note')
    const after = await get(user.id, draft.id)
    expect(after.revision).toBe(1)
    expect(after.contentHash).toBe(draft.contentHash)
    expect(after.notes).toBe('internal note')
  })

  it('forgets a rolled-back savepoint: the next change still bumps', async () => {
    const { user, brand } = await seedTenant(db)
    const { draft, variants } = await createTestDraft(db, user.id, brand.id)
    await db.tx(async (tx) => {
      await expect(
        tx.tx(async (sp) => {
          await drafts.updateVariant(sp, user.id, variants[0]!.id, { text: 'in savepoint' })
          throw new Error('roll back')
        }),
      ).rejects.toThrow('roll back')
      await drafts.updateVariant(tx, user.id, variants[0]!.id, { text: 'after savepoint' })
    })
    const after = await get(user.id, draft.id)
    expect(after.revision).toBe(2)
  })

  it('refuses direct writes to revision and content_hash, and changes to identity columns', async () => {
    const { user, brand } = await seedTenant(db)
    const { draft } = await createTestDraft(db, user.id, brand.id)
    await expectDbError(db.query('update public.drafts set revision = 7 where id = $1', [draft.id]), APP_SQLSTATE.immutable)
    await expectDbError(db.query(`update public.drafts set content_hash = 'x' where id = $1`, [draft.id]), APP_SQLSTATE.immutable)
    await expectDbError(db.query(`update public.drafts set created_via = 'web' where id = $1`, [draft.id]), APP_SQLSTATE.immutable)
    await expectDbError(
      db.query(`insert into public.drafts (user_id, brand_id, created_via, status) values ($1, $2, 'mcp', 'approved')`, [user.id, brand.id]),
      APP_SQLSTATE.invalidState,
    )
    // a forced revision on insert is ignored
    const row = await db.one<{ revision: number }>(
      `insert into public.drafts (user_id, brand_id, created_via, revision) values ($1, $2, 'mcp', 9) returning revision`,
      [user.id, brand.id],
    )
    expect(row?.revision).toBe(1)
  })
})

describe('approval', () => {
  it('approves at the current revision and records the approved hash, time and actor', async () => {
    const { user, brand } = await seedTenant(db)
    const { draft } = await createTestDraft(db, user.id, brand.id)
    const approved = await drafts.approve(db, user.id, draft.id, { revision: 1, via: 'web' })
    expect(approved).toMatchObject({
      status: 'approved',
      approvedRevision: 1,
      approvedHash: draft.contentHash,
      approvedVia: 'web',
    })
    expect(approved?.approvedAt).toBeInstanceOf(Date)
    // approving again (already approved) is a no-op
    expect(await drafts.approve(db, user.id, draft.id, { revision: 1, via: 'web' })).toBeNull()
  })

  it('returns null for a stale revision or another user', async () => {
    const a = await seedTenant(db)
    const b = await seedTenant(db)
    const { draft } = await createTestDraft(db, a.user.id, a.brand.id)
    await drafts.upsertVariant(db, a.user.id, draft.id, { platform: 'x', text: 'edit' })
    expect(await drafts.approve(db, a.user.id, draft.id, { revision: 1, via: 'web' })).toBeNull()
    expect(await drafts.approve(db, b.user.id, draft.id, { revision: 2, via: 'web' })).toBeNull()
    expect((await drafts.approve(db, a.user.id, draft.id, { revision: 2, via: 'mcp' }))?.status).toBe('approved')
  })

  it('refuses approvals that do not match the current revision and hash, lack variants or an actor', async () => {
    const { user, brand } = await seedTenant(db)
    const { draft } = await createTestDraft(db, user.id, brand.id)
    const approveSql = (revision: number, hash: string, via: string | null) =>
      db.query(
        `update public.drafts set status = 'approved', approved_revision = $2, approved_hash = $3,
                approved_via = $4::public.actor where id = $1`,
        [draft.id, revision, hash, via],
      )
    await expectDbError(approveSql(2, draft.contentHash, 'web'), APP_SQLSTATE.invalidState)
    await expectDbError(approveSql(1, 'f'.repeat(64), 'web'), APP_SQLSTATE.invalidState)
    await expectDbError(approveSql(1, draft.contentHash, null), APP_SQLSTATE.invalidState)
    const empty = await createTestDraft(db, user.id, brand.id, { variants: [] })
    expect(empty.variants).toHaveLength(0)
    await expectDbError(drafts.approve(db, user.id, empty.draft.id, { revision: 1, via: 'web' }), APP_SQLSTATE.invalidState)
    // approved_at defaults to now()
    await approveSql(1, draft.contentHash, 'web')
    expect((await get(user.id, draft.id)).approvedAt).toBeInstanceOf(Date)
  })

  it('drops the approval when content changes: variant update, insert or delete', async () => {
    const { user, brand } = await seedTenant(db)
    for (const change of ['update', 'insert', 'delete'] as const) {
      const { draft, variants } = await createTestDraft(db, user.id, brand.id, {
        variants: [
          { platform: 'instagram', text: 'a' },
          { platform: 'x', text: 'b' },
        ],
      })
      await approveTestDraft(db, user.id, draft.id)
      if (change === 'update') await drafts.updateVariant(db, user.id, variants[0]!.id, { text: 'changed' })
      if (change === 'insert') await drafts.upsertVariant(db, user.id, draft.id, { platform: 'threads', text: 'new' })
      if (change === 'delete') await drafts.deleteVariant(db, user.id, draft.id, 'x')
      const after = await get(user.id, draft.id)
      expect(after, change).toMatchObject({
        status: 'draft',
        revision: 2,
        approvedRevision: null,
        approvedHash: null,
        approvedAt: null,
        approvedVia: null,
      })
    }
  })

  it('treats moving to another brand as a content change, and refuses it while a variant targets an old-brand account', async () => {
    const { user, brand, account } = await seedTenant(db)
    const brand2 = await createTestBrand(db, user.id)
    const plain = await createTestDraft(db, user.id, brand.id)
    await approveTestDraft(db, user.id, plain.draft.id)
    const moved = await drafts.moveToBrand(db, user.id, plain.draft.id, brand2.id)
    expect(moved).toMatchObject({ brandId: brand2.id, status: 'draft', revision: 2, approvedRevision: null })
    expect(moved?.contentHash).not.toBe(plain.draft.contentHash)

    const pinned = await createTestDraft(db, user.id, brand.id, {
      variants: [{ platform: 'instagram', text: 'pinned', connectedAccountId: account.id }],
    })
    await expectDbError(drafts.moveToBrand(db, user.id, pinned.draft.id, brand2.id), APP_SQLSTATE.mismatch)
  })

  it('keeps the approval for non-content edits and clears approval fields on reject/archive', async () => {
    const { user, brand } = await seedTenant(db)
    const { draft } = await createTestDraft(db, user.id, brand.id)
    await approveTestDraft(db, user.id, draft.id)
    await drafts.updateNotes(db, user.id, draft.id, 'remember to boost')
    expect((await get(user.id, draft.id)).status).toBe('approved')
    const rejected = await drafts.reject(db, user.id, draft.id, 'tone is off')
    expect(rejected).toMatchObject({ status: 'rejected', rejectedReason: 'tone is off', approvedRevision: null, approvedHash: null })
    // a rejected draft can be approved again (same revision) and the reason is cleared
    const again = await drafts.approve(db, user.id, draft.id, { revision: 1, via: 'web' })
    expect(again).toMatchObject({ status: 'approved', rejectedReason: null })
    const archived = await drafts.archive(db, user.id, draft.id)
    expect(archived).toMatchObject({ status: 'archived', approvedRevision: null })
    expect(await drafts.approve(db, user.id, draft.id, { revision: 1, via: 'web' })).toBeNull()
    expect((await drafts.reopen(db, user.id, draft.id))?.status).toBe('draft')
  })
})

describe('leaving approval cancels scheduled posts', () => {
  it('cancels scheduled posts (not publishing ones) when the draft is edited, rejected or archived', async () => {
    for (const action of ['edit', 'reject', 'archive'] as const) {
      const tenant = await seedTenant(db)
      const x = await createTestAccount(db, tenant.user.id, tenant.brand.id, { platform: 'x' })
      const { draft, variant, post } = await createTestScheduledPost(db, tenant)
      // add a second variant (this edit cancels the first post), approve, schedule both again
      const xVariant = await db.tx(async (tx) => {
        await drafts.upsertVariant(tx, tenant.user.id, draft.id, { platform: 'x', text: 'x text', connectedAccountId: x.id })
        return (await drafts.listVariants(tx, tenant.user.id, draft.id)).find((v) => v.platform === 'x')!
      })
      const current = await approveTestDraft(db, tenant.user.id, draft.id)
      // the edit above canceled the first post; schedule both again at the new revision
      expect((await posts.get(db, tenant.user.id, post.id))?.status).toBe('canceled')
      const p1 = await posts.create(db, tenant.user.id, {
        brandId: tenant.brand.id,
        draftId: draft.id,
        variantId: variant.id,
        connectedAccountId: tenant.account.id,
        platform: 'instagram',
        scheduledFor: new Date(Date.now() + 3_600_000),
        approvedRevision: current.revision,
        provider: 'fake',
      })
      const p2 = await posts.create(db, tenant.user.id, {
        brandId: tenant.brand.id,
        draftId: draft.id,
        variantId: xVariant.id,
        connectedAccountId: x.id,
        platform: 'x',
        scheduledFor: new Date(Date.now() + 60_000),
        approvedRevision: current.revision,
        provider: 'fake',
      })
      expect(await posts.claimForPublish(db, tenant.user.id, p2.id)).not.toBeNull()

      if (action === 'edit') await drafts.updateVariant(db, tenant.user.id, variant.id, { text: 'typo fix' })
      if (action === 'reject') await drafts.reject(db, tenant.user.id, draft.id, 'no')
      if (action === 'archive') await drafts.archive(db, tenant.user.id, draft.id)

      const after1 = await posts.get(db, tenant.user.id, p1.id)
      expect(after1?.status, action).toBe('canceled')
      expect(after1?.canceledAt).toBeInstanceOf(Date)
      expect(after1?.error).toMatch(action === 'edit' ? /changed after approval/ : /no longer approved/)
      expect((await posts.get(db, tenant.user.id, p2.id))?.status, action).toBe('publishing')
    }
  })

  it('leaves other drafts\' posts alone', async () => {
    const tenant = await seedTenant(db)
    const one = await createTestScheduledPost(db, tenant, { text: 'one' })
    const twoDraft = await createTestDraft(db, tenant.user.id, tenant.brand.id, { variants: [{ platform: 'instagram', text: 'two' }] })
    await approveTestDraft(db, tenant.user.id, twoDraft.draft.id)
    await drafts.updateVariant(db, tenant.user.id, twoDraft.variants[0]!.id, { text: 'two edited' })
    expect((await posts.get(db, tenant.user.id, one.post.id))?.status).toBe('scheduled')
  })
})
