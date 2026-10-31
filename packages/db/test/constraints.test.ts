import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { APP_SQLSTATE, PG_ERROR } from '../src/errors'
import * as accounts from '../src/repos/accounts'
import * as audit from '../src/repos/audit'
import * as brands from '../src/repos/brands'
import * as clips from '../src/repos/clips'
import * as drafts from '../src/repos/drafts'
import * as media from '../src/repos/media'
import * as usage from '../src/repos/usage'
import * as users from '../src/repos/users'
import {
  createTestAccount,
  createTestBrand,
  createTestDb,
  createTestDraft,
  createTestMedia,
  createTestScheduledPost,
  createTestSourceVideo,
  createTestUser,
  seedTenant,
} from '../src/testing'
import type { Db } from '../src/types'
import { expectDbError, tick } from './helpers'

let db: Db
beforeAll(async () => {
  db = await createTestDb()
})
afterAll(async () => {
  await db.close()
})

describe('users', () => {
  it('requires a matching auth.users row and cascades when it is deleted', async () => {
    const id = randomUUID()
    await expectDbError(users.ensure(db, id, { email: 'nobody@example.test' }), PG_ERROR.foreignKeyViolation)
    const user = await createTestUser(db)
    const brand = await createTestBrand(db, user.id)
    await db.query('delete from auth.users where id = $1', [user.id])
    expect(await users.get(db, user.id)).toBeNull()
    expect(await brands.get(db, user.id, brand.id)).toBeNull()
  })

  it('checks add-on quantities, email shape, period order and unique Stripe ids', async () => {
    const user = await createTestUser(db)
    await expectDbError(users.updateBilling(db, user.id, { extraBrands: -1 }), PG_ERROR.checkViolation, 'users_extra_brands_check')
    await expectDbError(users.updateBilling(db, user.id, { extraClipHours: -1 }), PG_ERROR.checkViolation, 'users_extra_clip_hours_check')
    await expectDbError(users.updateProfile(db, user.id, { email: 'not-an-email' }), PG_ERROR.checkViolation, 'users_email_check')
    await expectDbError(
      users.updateBilling(db, user.id, { currentPeriodStart: new Date('2026-02-01'), currentPeriodEnd: new Date('2026-01-01') }),
      PG_ERROR.checkViolation,
      'users_period_order',
    )
    await users.updateBilling(db, user.id, { stripeCustomerId: `cus_${user.id}` })
    const other = await createTestUser(db)
    await expectDbError(
      users.updateBilling(db, other.id, { stripeCustomerId: `cus_${user.id}` }),
      PG_ERROR.uniqueViolation,
      'users_stripe_customer_id_key',
    )
  })

  it('maintains updated_at on update', async () => {
    const user = await createTestUser(db)
    await db.query(`update public.users set updated_at = now() - interval '1 day' where id = $1`, [user.id])
    const before = await users.get(db, user.id)
    // The trigger overrides the back-dated value above with now(), so on a fast real Postgres both
    // updates can land in the same millisecond (the Date we compare): wait a few ms first.
    await tick()
    const after = await users.updateProfile(db, user.id, { displayName: 'New name' })
    expect(after?.updatedAt.getTime()).toBeGreaterThanOrEqual(before?.createdAt.getTime() ?? 0)
    expect(after?.updatedAt.getTime()).not.toBe(before?.updatedAt.getTime())
  })
})

describe('brands and accounts', () => {
  it('keeps archived_at in step with status and refuses blank names', async () => {
    const user = await createTestUser(db)
    const brand = await createTestBrand(db, user.id)
    await expectDbError(
      db.query(`update public.brands set status = 'archived' where id = $1`, [brand.id]),
      PG_ERROR.checkViolation,
      'brands_archived_at',
    )
    await expectDbError(brands.create(db, user.id, { name: '   ' }), PG_ERROR.checkViolation, 'brands_name_check')
  })

  it('makes provider_profile_ref unique when set', async () => {
    const a = await createTestUser(db)
    const b = await createTestUser(db)
    const ref = `profile-${randomUUID()}`
    await createTestBrand(db, a.id, { providerProfileRef: ref })
    await createTestBrand(db, b.id, { providerProfileRef: null })
    await createTestBrand(db, b.id, { providerProfileRef: null })
    await expectDbError(createTestBrand(db, b.id, { providerProfileRef: ref }), PG_ERROR.uniqueViolation, 'brands_provider_profile_ref_key')
  })

  it('allows one live account per platform per brand, any number of disconnected ones', async () => {
    const { user, brand, account } = await seedTenant(db, { platform: 'tiktok' })
    const insert = (status: string) =>
      db.query(
        `insert into public.connected_accounts (user_id, brand_id, platform, provider, status)
         values ($1, $2, 'tiktok', 'fake', $3::public.account_status)`,
        [user.id, brand.id, status],
      )
    await expectDbError(insert('pending'), PG_ERROR.uniqueViolation, 'connected_accounts_live_platform_uidx')
    await expectDbError(insert('needs_reauth'), PG_ERROR.uniqueViolation, 'connected_accounts_live_platform_uidx')
    await insert('disconnected')
    await insert('disconnected')
    await accounts.setStatus(db, user.id, account.id, 'disconnected')
    await insert('pending')
    // other platforms and other brands are independent
    await createTestAccount(db, user.id, brand.id, { platform: 'youtube' })
    const brand2 = await createTestBrand(db, user.id)
    await createTestAccount(db, user.id, brand2.id, { platform: 'tiktok' })
  })

  it('refuses an account on another user\'s brand (composite foreign key)', async () => {
    const a = await seedTenant(db)
    const b = await createTestUser(db)
    await expectDbError(
      accounts.upsertLive(db, b.id, { brandId: a.brand.id, platform: 'x', provider: 'fake', status: 'active' }),
      PG_ERROR.foreignKeyViolation,
      'connected_accounts_brand_fk',
    )
    await expectDbError(
      accounts.upsertLive(db, a.user.id, { brandId: a.brand.id, platform: 'x', provider: 'Upload-Post!', status: 'active' }),
      PG_ERROR.checkViolation,
      'connected_accounts_provider_check',
    )
  })
})

describe('media_assets', () => {
  it('accepts drive links only from allowlisted drive hosts, with rights attested', async () => {
    const user = await createTestUser(db)
    const base = {
      kind: 'video' as const,
      origin: 'drive_link' as const,
      storageKey: `test/${randomUUID()}.mp4`,
      sourceUrl: 'https://drive.google.com/file/d/abc/view',
      rightsAttestedAt: new Date(),
    }
    await media.create(db, user.id, { ...base, sourceHost: 'drive.google.com' })
    for (const host of ['www.youtube.com', 'youtu.be', 'youtube.com', 'vimeo.com', 'example.com']) {
      await expectDbError(
        media.create(db, user.id, { ...base, storageKey: `test/${randomUUID()}`, sourceHost: host }),
        PG_ERROR.checkViolation,
        'media_assets_drive_host',
      )
    }
    await expectDbError(
      media.create(db, user.id, { ...base, storageKey: `test/${randomUUID()}`, sourceHost: 'dropbox.com', rightsAttestedAt: null }),
      PG_ERROR.checkViolation,
      'media_assets_drive_rights',
    )
    await expectDbError(
      media.create(db, user.id, { ...base, storageKey: `test/${randomUUID()}`, sourceHost: null }),
      PG_ERROR.checkViolation,
      'media_assets_drive_host',
    )
    await expectDbError(
      media.create(db, user.id, { ...base, storageKey: `test/${randomUUID()}`, sourceHost: '1drv.ms', sourceUrl: 'http://1drv.ms/x' }),
      PG_ERROR.checkViolation,
      'media_assets_source_url_check',
    )
    await expectDbError(
      media.create(db, user.id, { kind: 'video', origin: 'upload', storageKey: `test/${randomUUID()}`, sourceHost: 'drive.google.com' }),
      PG_ERROR.checkViolation,
      'media_assets_drive_host',
    )
  })

  it('keeps storage keys unique and numbers non-negative', async () => {
    const user = await createTestUser(db)
    const m = await createTestMedia(db, user.id)
    await expectDbError(createTestMedia(db, user.id, { storageKey: m.storageKey }), PG_ERROR.uniqueViolation, 'media_assets_storage_key_key')
    await expectDbError(createTestMedia(db, user.id, { bytes: -1 }), PG_ERROR.checkViolation, 'media_assets_bytes_check')
    await expectDbError(createTestMedia(db, user.id, { durationMs: -5 }), PG_ERROR.checkViolation, 'media_assets_duration_ms_check')
    await expectDbError(createTestMedia(db, user.id, { width: 0 }), PG_ERROR.checkViolation, 'media_assets_width_check')
    await expectDbError(createTestMedia(db, user.id, { sha256: 'xyz' }), PG_ERROR.checkViolation, 'media_assets_sha256_check')
  })

  it('nulls brand_id (not user_id) when the brand is deleted, and refuses another user\'s parent', async () => {
    const { user, brand } = await seedTenant(db)
    const m = await createTestMedia(db, user.id, { brandId: brand.id })
    await db.query('delete from public.brands where id = $1', [brand.id])
    const after = await media.get(db, user.id, m.id)
    expect(after?.brandId).toBeNull()
    expect(after?.userId).toBe(user.id)
    const other = await createTestUser(db)
    await expectDbError(createTestMedia(db, other.id, { parentMediaId: m.id }), PG_ERROR.foreignKeyViolation, 'media_assets_parent_fk')
  })
})

describe('clips', () => {
  it('checks end > start, at most 180 s, and within the source duration', async () => {
    const { user, brand } = await seedTenant(db)
    const src = await createTestSourceVideo(db, user.id, { durationMs: 600_000 })
    const clip = (startMs: number, endMs: number) => clips.create(db, user.id, { brandId: brand.id, sourceMediaId: src.id, startMs, endMs })
    await clip(0, 180_000)
    await expectDbError(clip(5_000, 5_000), PG_ERROR.checkViolation, 'clips_range')
    await expectDbError(clip(10_000, 5_000), PG_ERROR.checkViolation, 'clips_range')
    await expectDbError(clip(0, 180_001), PG_ERROR.checkViolation, 'clips_max_length')
    await expectDbError(clip(-1, 1_000), PG_ERROR.checkViolation, 'clips_start_ms_check')
    await expectDbError(clip(590_000, 601_000), PG_ERROR.checkViolation)
    await expectDbError(
      clips.create(db, user.id, { brandId: brand.id, sourceMediaId: src.id, startMs: 0, endMs: 1000, captionStyle: 'neon' as never }),
      PG_ERROR.checkViolation,
      'clips_caption_style_check',
    )
  })

  it('clips only rights-attested source videos the user owns', async () => {
    const { user, brand } = await seedTenant(db)
    const image = await createTestMedia(db, user.id)
    await expectDbError(
      clips.create(db, user.id, { brandId: brand.id, sourceMediaId: image.id, startMs: 0, endMs: 1000 }),
      APP_SQLSTATE.mismatch,
    )
    const noRights = await createTestSourceVideo(db, user.id, { rightsAttestedAt: null })
    await expectDbError(
      clips.create(db, user.id, { brandId: brand.id, sourceMediaId: noRights.id, startMs: 0, endMs: 1000 }),
      APP_SQLSTATE.mismatch,
    )
    const rendered = await createTestSourceVideo(db, user.id, { origin: 'render' })
    await expectDbError(
      clips.create(db, user.id, { brandId: brand.id, sourceMediaId: rendered.id, startMs: 0, endMs: 1000 }),
      APP_SQLSTATE.mismatch,
    )
    const other = await seedTenant(db)
    const foreign = await createTestSourceVideo(db, other.user.id)
    await expectDbError(
      clips.create(db, user.id, { brandId: brand.id, sourceMediaId: foreign.id, startMs: 0, endMs: 1000 }),
      PG_ERROR.foreignKeyViolation,
      'clips_source_fk',
    )
  })

  it('restricts deleting a source video that has clips (history), but cascades from the user', async () => {
    const { user, brand } = await seedTenant(db)
    const src = await createTestSourceVideo(db, user.id)
    await clips.create(db, user.id, { brandId: brand.id, sourceMediaId: src.id, startMs: 0, endMs: 5_000 })
    await expectDbError(db.query('delete from public.media_assets where id = $1', [src.id]), PG_ERROR.foreignKeyViolation, 'clips_source_fk')
    await users.remove(db, user.id)
    expect(await media.get(db, user.id, src.id)).toBeNull()
  })
})

describe('draft_variants', () => {
  it('is unique per draft and platform and bounds text, title and media', async () => {
    const { user, brand } = await seedTenant(db)
    const { draft } = await createTestDraft(db, user.id, brand.id)
    await expectDbError(
      db.query(`insert into public.draft_variants (user_id, draft_id, platform) values ($1, $2, 'instagram')`, [user.id, draft.id]),
      PG_ERROR.uniqueViolation,
      'draft_variants_draft_platform_key',
    )
    await expectDbError(
      drafts.upsertVariant(db, user.id, draft.id, { platform: 'x', text: 'a'.repeat(70_001) }),
      PG_ERROR.checkViolation,
      'draft_variants_text_check',
    )
    await expectDbError(
      drafts.upsertVariant(db, user.id, draft.id, { platform: 'youtube', title: 't'.repeat(501) }),
      PG_ERROR.checkViolation,
      'draft_variants_title_check',
    )
    const ids = Array.from({ length: 36 }, () => randomUUID())
    await expectDbError(
      drafts.upsertVariant(db, user.id, draft.id, { platform: 'tiktok', mediaIds: ids }),
      PG_ERROR.checkViolation,
      'draft_variants_media_ids_check',
    )
    await expectDbError(
      db.query(`insert into public.draft_variants (user_id, draft_id, platform, options) values ($1, $2, 'x', '[]'::jsonb)`, [
        user.id,
        draft.id,
      ]),
      PG_ERROR.checkViolation,
      'draft_variants_options_check',
    )
  })

  it('refuses media of another user, duplicate media, and accounts of another brand or platform', async () => {
    const a = await seedTenant(db)
    const b = await seedTenant(db)
    const { draft } = await createTestDraft(db, a.user.id, a.brand.id)
    const foreignMedia = await createTestMedia(db, b.user.id)
    await expectDbError(
      drafts.upsertVariant(db, a.user.id, draft.id, { platform: 'x', mediaIds: [foreignMedia.id] }),
      APP_SQLSTATE.mismatch,
    )
    await expectDbError(drafts.upsertVariant(db, a.user.id, draft.id, { platform: 'x', mediaIds: [randomUUID()] }), APP_SQLSTATE.mismatch)
    const mine = await createTestMedia(db, a.user.id)
    await expectDbError(
      drafts.upsertVariant(db, a.user.id, draft.id, { platform: 'x', mediaIds: [mine.id, mine.id] }),
      PG_ERROR.checkViolation,
    )
    // a.account is instagram on a.brand: wrong platform for an x variant
    await expectDbError(
      drafts.upsertVariant(db, a.user.id, draft.id, { platform: 'x', connectedAccountId: a.account.id }),
      APP_SQLSTATE.mismatch,
    )
    // account of another brand of the same user
    const brand2 = await createTestBrand(db, a.user.id)
    const otherBrandAccount = await createTestAccount(db, a.user.id, brand2.id, { platform: 'x' })
    await expectDbError(
      drafts.upsertVariant(db, a.user.id, draft.id, { platform: 'x', connectedAccountId: otherBrandAccount.id }),
      APP_SQLSTATE.mismatch,
    )
    // account of another user
    await expectDbError(
      drafts.upsertVariant(db, a.user.id, draft.id, { platform: 'instagram', connectedAccountId: b.account.id }),
      PG_ERROR.foreignKeyViolation,
      'draft_variants_account_fk',
    )
    // variant on another user's draft
    await expectDbError(drafts.upsertVariant(db, b.user.id, draft.id, { platform: 'x' }), PG_ERROR.foreignKeyViolation, 'draft_variants_draft_fk')
  })

  it('cannot be moved to another draft', async () => {
    const { user, brand } = await seedTenant(db)
    const one = await createTestDraft(db, user.id, brand.id)
    const two = await createTestDraft(db, user.id, brand.id, { variants: [] })
    await expectDbError(
      db.query('update public.draft_variants set draft_id = $1 where id = $2', [two.draft.id, one.variants[0]?.id]),
      APP_SQLSTATE.immutable,
    )
  })
})

describe('restrict where history matters', () => {
  it('refuses deleting a draft, variant or account that a post references, but deleting the user cascades', async () => {
    const tenant = await seedTenant(db)
    const { draft, variant, post } = await createTestScheduledPost(db, tenant)
    await expectDbError(drafts.remove(db, tenant.user.id, draft.id), PG_ERROR.foreignKeyViolation, 'posts_draft_fk')
    await expectDbError(
      drafts.deleteVariant(db, tenant.user.id, draft.id, variant.platform),
      PG_ERROR.foreignKeyViolation,
      'posts_variant_fk',
    )
    await expectDbError(
      db.query('delete from public.connected_accounts where id = $1', [tenant.account.id]),
      PG_ERROR.foreignKeyViolation,
      'posts_account_fk',
    )
    // deleting the brand takes drafts, variants, accounts and posts together
    await db.query('delete from public.brands where id = $1', [tenant.brand.id])
    expect(await db.one('select id from public.posts where id = $1', [post.id])).toBeNull()

    const t2 = await seedTenant(db)
    const s2 = await createTestScheduledPost(db, t2)
    await usage.record(db, t2.user.id, {
      meter: 'clip_seconds',
      kind: 'reserve',
      amount: 60,
      periodStart: new Date('2026-10-01T00:00:00Z'),
      idempotencyKey: `k-${randomUUID()}`,
    })
    await audit.record(db, { userId: t2.user.id, actor: 'web', action: 'test.event' })
    expect(await users.remove(db, t2.user.id)).toBe(true)
    expect(await db.one('select id from public.posts where id = $1', [s2.post.id])).toBeNull()
    expect(await db.one('select id from public.usage_ledger where user_id = $1', [t2.user.id])).toBeNull()
    expect(await db.one('select id from public.audit_log where user_id = $1', [t2.user.id])).toBeNull()
  })
})

describe('append-only tables', () => {
  it('refuses UPDATE and direct DELETE on usage_ledger and audit_log', async () => {
    const user = await createTestUser(db)
    const { entry } = await usage.record(db, user.id, {
      meter: 'clip_seconds',
      kind: 'reserve',
      amount: 10,
      periodStart: new Date('2026-10-01T00:00:00Z'),
      idempotencyKey: `k-${randomUUID()}`,
    })
    await expectDbError(db.query('update public.usage_ledger set amount = 1 where id = $1', [entry.id]), APP_SQLSTATE.appendOnly)
    await expectDbError(db.query('delete from public.usage_ledger where id = $1', [entry.id]), APP_SQLSTATE.appendOnly)
    const row = await audit.record(db, { userId: user.id, actor: 'mcp', action: 'draft.created' })
    await expectDbError(db.query(`update public.audit_log set action = 'x' where id = $1`, [row.id]), APP_SQLSTATE.appendOnly)
    await expectDbError(db.query('delete from public.audit_log where id = $1', [row.id]), APP_SQLSTATE.appendOnly)
  })

  it('checks ledger amounts and subject pairs', async () => {
    const user = await createTestUser(db)
    const base = { meter: 'clip_seconds' as const, periodStart: new Date('2026-10-01T00:00:00Z') }
    for (const kind of ['reserve', 'settle', 'release'] as const) {
      await expectDbError(
        usage.record(db, user.id, { ...base, kind, amount: 0, idempotencyKey: `k-${randomUUID()}` }),
        PG_ERROR.checkViolation,
        'usage_ledger_amount',
      )
      await expectDbError(
        usage.record(db, user.id, { ...base, kind, amount: -5, idempotencyKey: `k-${randomUUID()}` }),
        PG_ERROR.checkViolation,
        'usage_ledger_amount',
      )
    }
    await usage.record(db, user.id, { ...base, kind: 'adjust', amount: -5, idempotencyKey: `k-${randomUUID()}` })
    await expectDbError(
      usage.record(db, user.id, { ...base, kind: 'adjust', amount: 0, idempotencyKey: `k-${randomUUID()}` }),
      PG_ERROR.checkViolation,
      'usage_ledger_amount',
    )
    await expectDbError(
      usage.record(db, user.id, { ...base, kind: 'reserve', amount: 5, subjectType: 'media', idempotencyKey: `k-${randomUUID()}` }),
      PG_ERROR.checkViolation,
      'usage_ledger_subject',
    )
  })

  it('refuses credential-like keys in audit meta at any depth (the repo strips them first)', async () => {
    const user = await createTestUser(db)
    const insert = (meta: unknown) =>
      db.query(`insert into public.audit_log (user_id, actor, action, meta) values ($1, 'web', 'x.y', $2::text::jsonb)`, [
        user.id,
        JSON.stringify(meta),
      ])
    await expectDbError(insert({ access_token: 'abc' }), PG_ERROR.checkViolation, 'audit_log_meta')
    await expectDbError(insert({ nested: { list: [{ apiKey: 'abc' }] } }), PG_ERROR.checkViolation, 'audit_log_meta')
    await expectDbError(insert({ Authorization: 'Bearer x' }), PG_ERROR.checkViolation, 'audit_log_meta')
    await expectDbError(insert([1, 2]), PG_ERROR.checkViolation, 'audit_log_meta')
    await insert({ draftId: randomUUID(), platforms: ['x', 'tiktok'], nested: { revision: 3 } })
    const row = await audit.record(db, {
      userId: user.id,
      actor: 'worker',
      action: 'post.published',
      meta: { postId: 'p1', refresh_token: 'nope', deep: { password: 'x', ok: true } },
    })
    expect(row.meta).toEqual({ postId: 'p1', deep: { ok: true } })
    await expectDbError(audit.record(db, { actor: 'web', action: 'Bad Action!' }), PG_ERROR.checkViolation, 'audit_log_action_check')
  })
})

describe('metrics, jobs, oauth and stripe checks', () => {
  it('accepts only known, non-negative numeric metrics', async () => {
    const { user, brand } = await seedTenant(db)
    const insert = (metrics: unknown) =>
      db.query(
        `insert into public.analytics_snapshots (user_id, brand_id, platform, scope, metrics)
         values ($1, $2, 'instagram', 'account', $3::text::jsonb)`,
        [user.id, brand.id, JSON.stringify(metrics)],
      )
    await insert({ views: 10, likes: 0, followers: 1234.5 })
    await insert({})
    await expectDbError(insert({ views: -1 }), PG_ERROR.checkViolation, 'analytics_snapshots_metrics')
    await expectDbError(insert({ views: '10' }), PG_ERROR.checkViolation, 'analytics_snapshots_metrics')
    await expectDbError(insert({ clicks: 1 }), PG_ERROR.checkViolation, 'analytics_snapshots_metrics')
    await expectDbError(insert({ views: { n: 1 } }), PG_ERROR.checkViolation, 'analytics_snapshots_metrics')
    await expectDbError(insert([1]), PG_ERROR.checkViolation, 'analytics_snapshots_metrics')
    await expectDbError(
      db.query(
        `insert into public.past_posts (user_id, brand_id, platform, external_post_id, metrics)
         values ($1, $2, 'x', 'e1', '{"likes": -2}'::jsonb)`,
        [user.id, brand.id],
      ),
      PG_ERROR.checkViolation,
      'past_posts_metrics',
    )
  })

  it('ties snapshot scope to its subject', async () => {
    const tenant = await seedTenant(db)
    const { post } = await createTestScheduledPost(db, tenant)
    const insert = (scope: string, postId: string | null) =>
      db.query(
        `insert into public.analytics_snapshots (user_id, brand_id, platform, scope, post_id, metrics)
         values ($1, $2, 'instagram', $3, $4, '{}'::jsonb)`,
        [tenant.user.id, tenant.brand.id, scope, postId],
      )
    await insert('post', post.id)
    await expectDbError(insert('post', null), PG_ERROR.checkViolation, 'analytics_snapshots_scope')
    await expectDbError(insert('account', post.id), PG_ERROR.checkViolation, 'analytics_snapshots_scope')
    await expectDbError(insert('weekly', null), PG_ERROR.checkViolation, 'analytics_snapshots_scope_check')
  })

  it('checks job shape and lock consistency', async () => {
    await expectDbError(db.query(`insert into public.jobs (type) values ('Bad Type')`), PG_ERROR.checkViolation, 'jobs_type_check')
    await expectDbError(db.query(`insert into public.jobs (type, max_attempts) values ('x', 0)`), PG_ERROR.checkViolation, 'jobs_max_attempts_check')
    await expectDbError(db.query(`insert into public.jobs (type, status) values ('x', 'running')`), PG_ERROR.checkViolation, 'jobs_running_lock')
    await expectDbError(db.query(`insert into public.jobs (type, status) values ('x', 'succeeded')`), PG_ERROR.checkViolation, 'jobs_finished')
    await expectDbError(db.query(`insert into public.jobs (type, payload) values ('x', '[]'::jsonb)`), PG_ERROR.checkViolation, 'jobs_payload_check')
    const key = `job-${randomUUID()}`
    await db.query(`insert into public.jobs (type, idempotency_key) values ('x', $1)`, [key])
    await expectDbError(db.query(`insert into public.jobs (type, idempotency_key) values ('x', $1)`, [key]), PG_ERROR.uniqueViolation, 'jobs_idempotency_key_key')
  })

  it('stores only hex hashes for oauth codes, tokens and nonces, and S256-shaped challenges', async () => {
    const user = await createTestUser(db)
    const clientId = `client-${randomUUID()}`
    await db.query(`insert into public.oauth_clients (client_id, redirect_uris) values ($1, array['https://claude.ai/cb'])`, [clientId])
    await expectDbError(
      db.query(`insert into public.oauth_clients (client_id, redirect_uris) values ($1, '{}')`, [`c-${randomUUID()}`]),
      PG_ERROR.checkViolation,
      'oauth_clients_redirect_uris_check',
    )
    await expectDbError(
      db.query(`insert into public.oauth_clients (client_id, redirect_uris, token_endpoint_auth_method) values ($1, array['https://x/cb'], 'client_secret_basic')`, [
        `c-${randomUUID()}`,
      ]),
      PG_ERROR.checkViolation,
      'oauth_clients_token_endpoint_auth_method_check',
    )
    const code = (hash: string, challenge: string) =>
      db.query(
        `insert into public.oauth_codes (code_hash, client_id, user_id, redirect_uri, code_challenge, scope, expires_at)
         values ($1, $2, $3, 'https://claude.ai/cb', $4, 'social', now() + interval '1 minute')`,
        [hash, clientId, user.id, challenge],
      )
    await expectDbError(code('plain-code', 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM'), PG_ERROR.checkViolation, 'oauth_codes_code_hash_check')
    await expectDbError(code('a'.repeat(64), 'short'), PG_ERROR.checkViolation, 'oauth_codes_code_challenge_check')
    await code('a'.repeat(64), 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM')
    await expectDbError(
      db.query(
        `insert into public.oauth_tokens (token_hash, kind, family_id, client_id, user_id, scope, expires_at)
         values ('not-a-hash', 'access', gen_random_uuid(), $1, $2, 'social', now())`,
        [clientId, user.id],
      ),
      PG_ERROR.checkViolation,
      'oauth_tokens_token_hash_check',
    )
    await expectDbError(
      db.query(
        `insert into public.oauth_tokens (token_hash, kind, family_id, client_id, user_id, scope, expires_at)
         values ($3, 'id_token', gen_random_uuid(), $1, $2, 'social', now())`,
        [clientId, user.id, 'b'.repeat(64)],
      ),
      PG_ERROR.checkViolation,
      'oauth_tokens_kind_check',
    )
    await expectDbError(
      db.query(`insert into public.stripe_events (id, type) values ('not_an_event', 'invoice.paid')`),
      PG_ERROR.checkViolation,
      'stripe_events_id_check',
    )
  })
})
