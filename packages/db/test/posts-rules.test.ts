import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { APP_SQLSTATE, PG_ERROR } from '../src/errors'
import * as accounts from '../src/repos/accounts'
import * as brands from '../src/repos/brands'
import * as drafts from '../src/repos/drafts'
import * as posts from '../src/repos/posts'
import {
  approveTestDraft,
  createTestAccount,
  createTestDb,
  createTestDraft,
  createTestScheduledPost,
  seedTenant,
  type TestTenant,
} from '../src/testing'
import type { Db } from '../src/types'
import { expectDbError, hoursFromNow } from './helpers'

let db: Db
beforeAll(async () => {
  db = await createTestDb()
})
afterAll(async () => {
  await db.close()
})

/** An approved draft with one variant on the tenant's account, not yet scheduled. */
async function approvedDraft(tenant: TestTenant, variant: Partial<drafts.VariantInput> = {}) {
  const created = await createTestDraft(db, tenant.user.id, tenant.brand.id, {
    variants: [{ platform: tenant.account.platform, text: 'hello', ...variant }],
  })
  const draft = await approveTestDraft(db, tenant.user.id, created.draft.id)
  return { draft, variant: created.variants[0]! }
}

function postInput(tenant: TestTenant, d: { draft: drafts.DraftRow; variant: drafts.VariantRow }, overrides: Partial<posts.CreatePostInput> = {}) {
  return {
    brandId: tenant.brand.id,
    draftId: d.draft.id,
    variantId: d.variant.id,
    connectedAccountId: tenant.account.id,
    platform: tenant.account.platform,
    scheduledFor: hoursFromNow(1),
    approvedRevision: d.draft.revision,
    provider: 'fake',
    ...overrides,
  }
}

describe('posts insert requires an approved draft at the current revision', () => {
  it('accepts an approved draft at its revision', async () => {
    const tenant = await seedTenant(db)
    const d = await approvedDraft(tenant)
    const post = await posts.create(db, tenant.user.id, postInput(tenant, d))
    expect(post).toMatchObject({ status: 'scheduled', attempts: 0, approvedRevision: 1, platform: 'instagram' })
  })

  it('refuses an unapproved draft, a stale revision and a draft edited after approval', async () => {
    const tenant = await seedTenant(db)
    const created = await createTestDraft(db, tenant.user.id, tenant.brand.id)
    const unapproved = { draft: created.draft, variant: created.variants[0]! }
    await expectDbError(posts.create(db, tenant.user.id, postInput(tenant, unapproved)), APP_SQLSTATE.notApproved)

    const d = await approvedDraft(tenant)
    await expectDbError(posts.create(db, tenant.user.id, postInput(tenant, d, { approvedRevision: 2 })), APP_SQLSTATE.notApproved)
    await drafts.updateVariant(db, tenant.user.id, d.variant.id, { text: 'edited after approval' })
    await expectDbError(posts.create(db, tenant.user.id, postInput(tenant, d)), APP_SQLSTATE.notApproved)
    await expectDbError(posts.create(db, tenant.user.id, postInput(tenant, d, { approvedRevision: 2 })), APP_SQLSTATE.notApproved)
    const reapproved = await approveTestDraft(db, tenant.user.id, d.draft.id)
    const ok = await posts.create(db, tenant.user.id, postInput(tenant, { draft: reapproved, variant: d.variant }))
    expect(ok.approvedRevision).toBe(2)
  })

  it('refuses mismatched variant, platform, brand and account', async () => {
    const tenant = await seedTenant(db)
    const d = await approvedDraft(tenant)
    const other = await approvedDraft(tenant)
    await expectDbError(
      posts.create(db, tenant.user.id, postInput(tenant, d, { variantId: other.variant.id })),
      APP_SQLSTATE.mismatch,
    )
    const tiktok = await createTestAccount(db, tenant.user.id, tenant.brand.id, { platform: 'tiktok' })
    await expectDbError(
      posts.create(db, tenant.user.id, postInput(tenant, d, { platform: 'tiktok', connectedAccountId: tiktok.id })),
      APP_SQLSTATE.mismatch,
    )
    await expectDbError(posts.create(db, tenant.user.id, postInput(tenant, d, { connectedAccountId: tiktok.id })), APP_SQLSTATE.mismatch)
    const brand2 = await brands.create(db, tenant.user.id, { name: 'Second' })
    await expectDbError(posts.create(db, tenant.user.id, postInput(tenant, d, { brandId: brand2.id })), APP_SQLSTATE.mismatch)
    const ig2 = await createTestAccount(db, tenant.user.id, brand2.id, { platform: 'instagram' })
    await expectDbError(posts.create(db, tenant.user.id, postInput(tenant, d, { connectedAccountId: ig2.id })), APP_SQLSTATE.mismatch)
  })

  it('refuses another account than the one the variant pins', async () => {
    const tenant = await seedTenant(db)
    const d = await approvedDraft(tenant, { connectedAccountId: tenant.account.id })
    await accounts.setStatus(db, tenant.user.id, tenant.account.id, 'disconnected')
    const replacement = await createTestAccount(db, tenant.user.id, tenant.brand.id, { platform: 'instagram' })
    await expectDbError(
      posts.create(db, tenant.user.id, postInput(tenant, d, { connectedAccountId: replacement.id })),
      APP_SQLSTATE.mismatch,
    )
  })

  it('refuses inactive accounts and non-active brands', async () => {
    const tenant = await seedTenant(db)
    const d = await approvedDraft(tenant)
    await accounts.setStatus(db, tenant.user.id, tenant.account.id, 'needs_reauth')
    await expectDbError(posts.create(db, tenant.user.id, postInput(tenant, d)), APP_SQLSTATE.invalidState)
    await accounts.setStatus(db, tenant.user.id, tenant.account.id, 'active')
    await brands.setStatus(db, tenant.user.id, tenant.brand.id, 'suspended')
    await expectDbError(posts.create(db, tenant.user.id, postInput(tenant, d)), APP_SQLSTATE.invalidState)
  })

  it('refuses another user\'s draft and posts not created as scheduled', async () => {
    const a = await seedTenant(db)
    const b = await seedTenant(db)
    const d = await approvedDraft(a)
    await expectDbError(posts.create(db, b.user.id, postInput(a, d)), APP_SQLSTATE.mismatch)
    await expectDbError(
      db.query(
        `insert into public.posts (user_id, brand_id, draft_id, variant_id, connected_account_id, platform, scheduled_for, approved_revision, provider, status)
         values ($1, $2, $3, $4, $5, 'instagram', now(), 1, 'fake', 'published')`,
        [a.user.id, a.brand.id, d.draft.id, d.variant.id, a.account.id],
      ),
      APP_SQLSTATE.invalidTransition,
    )
  })

  it('allows one active post per variant (one approval -> one publication)', async () => {
    const tenant = await seedTenant(db)
    const d = await approvedDraft(tenant)
    const first = await posts.create(db, tenant.user.id, postInput(tenant, d))
    await expectDbError(posts.create(db, tenant.user.id, postInput(tenant, d)), PG_ERROR.uniqueViolation, 'posts_active_variant_uidx')
    await posts.cancel(db, tenant.user.id, first.id)
    const second = await posts.create(db, tenant.user.id, postInput(tenant, d))
    await posts.claimForPublish(db, tenant.user.id, second.id)
    await posts.markPublished(db, tenant.user.id, second.id, { providerPostId: 'ig_1' })
    await expectDbError(posts.create(db, tenant.user.id, postInput(tenant, d)), PG_ERROR.uniqueViolation, 'posts_active_variant_uidx')
  })
})

describe('posts are immutable except status and delivery fields', () => {
  it('refuses changes to content columns', async () => {
    const tenant = await seedTenant(db)
    const { post } = await createTestScheduledPost(db, tenant)
    const other = await approvedDraft(tenant)
    const changes: Array<[string, unknown]> = [
      ['draft_id', other.draft.id],
      ['variant_id', other.variant.id],
      ['connected_account_id', '00000000-0000-0000-0000-000000000000'],
      ['approved_revision', 5],
      ['brand_id', '00000000-0000-0000-0000-000000000000'],
      ['user_id', '00000000-0000-0000-0000-000000000000'],
    ]
    for (const [column, value] of changes) {
      await expectDbError(db.query(`update public.posts set ${column} = $2 where id = $1`, [post.id, value]), APP_SQLSTATE.immutable)
    }
    await expectDbError(db.query(`update public.posts set platform = 'x' where id = $1`, [post.id]), APP_SQLSTATE.immutable)
  })

  it('allows status, provider fields, scheduled_for, error, attempts, published_at and canceled_at', async () => {
    const tenant = await seedTenant(db)
    const { post } = await createTestScheduledPost(db, tenant)
    const at = hoursFromNow(5)
    const rescheduled = await posts.reschedule(db, tenant.user.id, post.id, at)
    expect(rescheduled?.scheduledFor.getTime()).toBe(at.getTime())
    await db.query(`update public.posts set error = 'x', attempts = 3, provider = 'upload_post' where id = $1`, [post.id])
    const claimed = await posts.claimForPublish(db, tenant.user.id, post.id)
    expect(claimed).toMatchObject({ status: 'publishing', attempts: 4, error: null })
    const withRequest = await posts.setProviderRequest(db, tenant.user.id, post.id, { providerRequestId: 'req-1' })
    expect(withRequest?.providerRequestId).toBe('req-1')
    const published = await posts.markPublished(db, tenant.user.id, post.id, { providerPostId: 'p-1', postUrl: 'https://instagram.com/p/1' })
    expect(published).toMatchObject({ status: 'published', providerPostId: 'p-1', postUrl: 'https://instagram.com/p/1' })
    expect(published?.publishedAt).toBeInstanceOf(Date)
    // a later webhook may still fill delivery fields
    const again = await posts.markPublished(db, tenant.user.id, post.id, { postUrl: 'https://instagram.com/p/1b' })
    expect(again?.postUrl).toBe('https://instagram.com/p/1b')
  })

  it('enforces the status graph', async () => {
    const tenant = await seedTenant(db)
    const { post } = await createTestScheduledPost(db, tenant)
    const setStatus = (status: string) => db.query(`update public.posts set status = $2::public.post_status where id = $1`, [post.id, status])
    await expectDbError(setStatus('published'), APP_SQLSTATE.invalidTransition)
    await setStatus('publishing')
    await setStatus('failed')
    await setStatus('scheduled') // retry
    await setStatus('publishing')
    await setStatus('published')
    for (const next of ['scheduled', 'publishing', 'failed', 'canceled']) {
      await expectDbError(setStatus(next), APP_SQLSTATE.invalidTransition)
    }
    await expectDbError(
      db.query(`update public.posts set scheduled_for = now() + interval '1 day' where id = $1`, [post.id]),
      APP_SQLSTATE.invalidTransition,
    )

    const second = await createTestScheduledPost(db, tenant)
    const canceled = await posts.cancel(db, tenant.user.id, second.post.id, 'not needed')
    expect(canceled).toMatchObject({ status: 'canceled', error: 'not needed' })
    expect(canceled?.canceledAt).toBeInstanceOf(Date)
    await expectDbError(
      db.query(`update public.posts set status = 'scheduled' where id = $1`, [second.post.id]),
      APP_SQLSTATE.invalidTransition,
    )
    expect(await posts.cancel(db, tenant.user.id, post.id)).toBeNull() // published cannot be canceled

    // a late provider confirmation turns a failed post into a published one (no re-post)
    const third = await createTestScheduledPost(db, tenant)
    await posts.claimForPublish(db, tenant.user.id, third.post.id)
    await posts.markFailed(db, tenant.user.id, third.post.id, 'status check timed out')
    const late = await posts.markPublished(db, tenant.user.id, third.post.id, { providerPostId: 'late-1' })
    expect(late).toMatchObject({ status: 'published', providerPostId: 'late-1', error: null })
  })

  it('only lets a post (re)enter scheduled or publishing while its draft is approved at its revision', async () => {
    const tenant = await seedTenant(db)
    const { draft, variant, post } = await createTestScheduledPost(db, tenant)
    await posts.claimForPublish(db, tenant.user.id, post.id)
    // the draft is edited while the post is publishing: the post is not canceled ...
    await drafts.updateVariant(db, tenant.user.id, variant.id, { text: 'edited mid-flight' })
    expect((await posts.get(db, tenant.user.id, post.id))?.status).toBe('publishing')
    // ... but it cannot go back to scheduled for a retry
    expect(await posts.requeue(db, tenant.user.id, post.id, hoursFromNow(1))).toBeNull()
    await expectDbError(
      db.query(`update public.posts set status = 'scheduled' where id = $1`, [post.id]),
      APP_SQLSTATE.notApproved,
    )
    const failed = await posts.markFailed(db, tenant.user.id, post.id, 'provider timeout')
    expect(failed).toMatchObject({ status: 'failed', error: 'provider timeout' })
    expect(await posts.requeue(db, tenant.user.id, post.id, hoursFromNow(1))).toBeNull()
    // re-approval at the new revision does not revive the old post (its approved revision is 1)
    await approveTestDraft(db, tenant.user.id, draft.id)
    expect(await posts.requeue(db, tenant.user.id, post.id, hoursFromNow(1))).toBeNull()
  })

  it('claimForPublish returns null for canceled, already claimed or unapproved posts', async () => {
    const tenant = await seedTenant(db)
    const a = await createTestScheduledPost(db, tenant)
    expect(await posts.claimForPublish(db, tenant.user.id, a.post.id)).not.toBeNull()
    expect(await posts.claimForPublish(db, tenant.user.id, a.post.id)).toBeNull()
    const b = await createTestScheduledPost(db, tenant)
    await posts.cancel(db, tenant.user.id, b.post.id)
    expect(await posts.claimForPublish(db, tenant.user.id, b.post.id)).toBeNull()
    const other = await seedTenant(db)
    const c = await createTestScheduledPost(db, tenant)
    expect(await posts.claimForPublish(db, other.user.id, c.post.id)).toBeNull()
    // requeue (cap full) moves it back to scheduled at a later time
    expect(await posts.claimForPublish(db, tenant.user.id, c.post.id)).not.toBeNull()
    const later = hoursFromNow(2)
    const requeued = await posts.requeue(db, tenant.user.id, c.post.id, later, 'cap reached')
    expect(requeued).toMatchObject({ status: 'scheduled', error: 'cap reached' })
    expect(requeued?.scheduledFor.getTime()).toBe(later.getTime())
  })
})
