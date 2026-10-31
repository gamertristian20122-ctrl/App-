import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createTestBrand, createTestUser } from '@app/db/testing'
import { users as usersRepo } from '@app/db'
import { DAY, START, createHarness, expectAppError, resetHarness, tenant, type Harness, OTHER_UUID } from './helpers'

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

describe('users', () => {
  it('ensureUser creates the user once and starts the 7-day Starter trial', async () => {
    const id = '0f0f0f0f-0000-4000-8000-000000000001'
    await usersRepo.devEnsureAuthUser(h.db, id, 'new@example.test')
    const user = await h.s.users.ensureUser(id, { email: 'New@Example.test' })
    expect(user.email).toBe('new@example.test')
    expect(user.subscriptionStatus).toBe('trialing')
    expect(user.plan).toBe('starter')
    expect(user.trialEndsAt?.getTime()).toBe(START.getTime() + 7 * DAY)

    const ent = await h.s.users.getEntitlements(id)
    expect(ent).toMatchObject({ trial: true, brands: 1, clipSeconds: 3_600, canCreate: true, canProcessMedia: true })

    // a second sign-in does not restart the trial
    h.clock.advance(2 * DAY)
    const again = await h.s.users.ensureUser(id, { email: 'new@example.test' })
    expect(again.trialEndsAt?.getTime()).toBe(START.getTime() + 7 * DAY)
    const audit = await h.s.audit.list(id, { action: 'user.trial_started' })
    expect(audit).toHaveLength(1)
  })

  it('an ended trial holds everything', async () => {
    const id = '0f0f0f0f-0000-4000-8000-000000000002'
    await usersRepo.devEnsureAuthUser(h.db, id, 'trial@example.test')
    await h.s.users.ensureUser(id, { email: 'trial@example.test' })
    h.clock.advance(8 * DAY)
    const ent = await h.s.users.getEntitlements(id)
    expect(ent).toMatchObject({ trialExpired: true, canCreate: false, brands: 0, clipSeconds: 0 })
    await expectAppError(h.s.brands.create(id, { name: 'Late' }), 'payment_required', /trial has ended/)
  })

  it('rejects invalid input and unknown users', async () => {
    await expectAppError(h.s.users.ensureUser('not-a-uuid', { email: 'a@b.c' }), 'unauthorized')
    const { userId } = await tenant(h)
    await expectAppError(h.s.users.ensureUser(userId, { email: 'nope' }), 'validation')
    await expectAppError(h.s.users.get(OTHER_UUID), 'unauthorized')
  })

  it('entitlements follow plan, add-ons and status', async () => {
    const plus = await createTestUser(h.db, { plan: 'plus', extraBrands: 2, extraClipHours: 3 })
    expect(await h.s.users.getEntitlements(plus.id)).toMatchObject({ brands: 4, clipSeconds: 13 * 3_600, canProcessMedia: true })
    const pastDue = await createTestUser(h.db, { plan: 'pro', subscriptionStatus: 'past_due' })
    expect(await h.s.users.getEntitlements(pastDue.id)).toMatchObject({ brands: 4, canCreate: true, canProcessMedia: false, canPublish: true })
    const canceled = await createTestUser(h.db, { plan: 'pro', subscriptionStatus: 'canceled' })
    expect(await h.s.users.getEntitlements(canceled.id)).toMatchObject({ brands: 0, canCreate: false, canPublish: false })
  })

  it('updates the profile with validation', async () => {
    const { userId } = await tenant(h)
    const user = await h.s.users.updateProfile(userId, { timezone: 'Europe/Berlin', displayName: 'Ann' })
    expect(user).toMatchObject({ timezone: 'Europe/Berlin', displayName: 'Ann' })
    await expectAppError(h.s.users.updateProfile(userId, { timezone: 'Mars/Base' }), 'validation')
  })
})

describe('brands', () => {
  it('enforces the brand limit (starter = 1, + extra brands)', async () => {
    const user = await createTestUser(h.db, { plan: 'starter' })
    const first = await h.s.brands.create(user.id, { name: 'One' })
    expect(first.status).toBe('active')
    expect(first.providerProfileRef).toBe(`fake_brand_${first.id}`)
    const err = await expectAppError(h.s.brands.create(user.id, { name: 'Two' }), 'limit_exceeded')
    expect(err.details).toMatchObject({ limit: 1, used: 1, remaining: 0 })

    await h.r.users.updateBilling(user.id, { extraBrands: 1 })
    await h.s.brands.create(user.id, { name: 'Two' })
    await expectAppError(h.s.brands.create(user.id, { name: 'Three' }), 'limit_exceeded')
  })

  it('is race-free: concurrent creates never exceed the limit', async () => {
    const user = await createTestUser(h.db, { plan: 'plus' }) // 2 brands
    const results = await Promise.allSettled(Array.from({ length: 5 }, (_, i) => h.s.brands.create(user.id, { name: `B${i}` })))
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2)
    expect(await h.r.brands.countActive(user.id)).toBe(2)
  })

  it('validates names and time zones', async () => {
    const user = await createTestUser(h.db)
    await expectAppError(h.s.brands.create(user.id, { name: '' }), 'validation')
    await expectAppError(h.s.brands.create(user.id, { name: 'X', timezone: 'Nowhere/City' }), 'validation')
    await expectAppError(h.s.brands.create(user.id, { name: 'X', extra: true }), 'validation')
  })

  it('archives (canceling scheduled posts) and restores within the limit', async () => {
    const { userId, brandId } = await tenant(h)
    const archived = await h.s.brands.archive(userId, brandId)
    expect(archived.status).toBe('archived')
    await h.s.brands.create(userId, { name: 'Replacement' })
    await expectAppError(h.s.brands.restore(userId, brandId), 'limit_exceeded')
    await h.r.users.updateBilling(userId, { extraBrands: 1 })
    expect((await h.s.brands.restore(userId, brandId)).status).toBe('active')
  })

  it('archiving deletes the provider profile (a paid, limited resource); restore + connect recreates it', async () => {
    // regression: archived brands kept their provider profile, so archive/create loops could grow
    // provider profiles without bound (each costs money and the plan has a hard profile limit)
    const { userId } = await tenant(h)
    await h.r.users.updateBilling(userId, { plan: 'plus' })
    const brand = await h.s.brands.create(userId, { name: 'Side project' })
    const ref = brand.providerProfileRef
    expect(ref).toBe(`fake_brand_${brand.id}`)
    await h.s.accounts.connectLink(userId, { brandId: brand.id, platform: 'x' })
    await h.s.accounts.sync(userId, brand.id)
    expect((await h.s.accounts.list(userId, { brandId: brand.id })).map((a) => a.status)).toEqual(['active'])

    const archived = await h.s.brands.archive(userId, brand.id)
    expect(archived).toMatchObject({ status: 'archived', providerProfileRef: null })
    expect(h.provider.calls.some((c) => c.method === 'deleteProfile' && c.input === ref)).toBe(true)
    expect((await h.s.accounts.list(userId, { brandId: brand.id })).map((a) => a.status)).toEqual(['disconnected'])
    expect((await h.s.audit.list(userId, { action: 'brand.profile_released' })).length).toBe(1)

    const restored = await h.s.brands.restore(userId, brand.id)
    expect(restored).toMatchObject({ status: 'active', providerProfileRef: null })
    await h.s.accounts.connectLink(userId, { brandId: brand.id, platform: 'x' })
    expect((await h.s.brands.get(userId, brand.id)).providerProfileRef).toBe(ref)
  })

  it('archive still succeeds when the provider cannot delete the profile (retried on the next archive call)', async () => {
    const { userId, brandId } = await tenant(h)
    const before = await h.s.brands.ensureProviderProfile(userId, brandId)
    h.provider.failNext('deleteProfile')
    const archived = await h.s.brands.archive(userId, brandId)
    expect(archived).toMatchObject({ status: 'archived', providerProfileRef: before.providerProfileRef })
    expect((await h.s.brands.archive(userId, brandId)).providerProfileRef).toBeNull()
  })

  it('refuses other users’ brands with not_found', async () => {
    const a = await tenant(h)
    const b = await tenant(h)
    await expectAppError(h.s.brands.get(a.userId, b.brandId), 'not_found')
    await expectAppError(h.s.brands.update(a.userId, b.brandId, { name: 'Mine now' }), 'not_found')
    await expectAppError(h.s.brands.archive(a.userId, b.brandId), 'not_found')
    await expectAppError(h.s.brands.get(a.userId, 'garbage'), 'not_found')
    expect((await h.s.brands.get(b.userId, b.brandId)).name).toBe('Acme')
  })

  it('downgrade suspends the newest brands; an upgrade restores them', async () => {
    const user = await createTestUser(h.db, { plan: 'pro' })
    const brands = []
    for (const name of ['Oldest', 'Middle', 'Newer', 'Newest']) {
      brands.push(await createTestBrand(h.db, user.id, { name }))
      await new Promise((r) => setTimeout(r, 3))
    }
    await h.r.users.updateBilling(user.id, { plan: 'plus' })
    const change = await h.s.brands.reconcileLimit(user.id)
    expect(change.suspended.map((b) => b.name).sort()).toEqual(['Newer', 'Newest'])
    expect(await h.r.brands.countActive(user.id)).toBe(2)
    // a suspended brand cannot take new work
    await expectAppError(h.s.drafts.create(user.id, { brandId: brands[3]?.id, variants: [{ platform: 'x', text: 'hi' }] }), 'payment_required')

    await h.r.users.updateBilling(user.id, { plan: 'pro' })
    const up = await h.s.brands.reconcileLimit(user.id)
    expect(up.restored).toHaveLength(2)
    expect(await h.r.brands.countActive(user.id)).toBe(4)
  })

  it('leaves brands alone when the account is held (canceled)', async () => {
    const user = await createTestUser(h.db, { plan: 'plus' })
    await createTestBrand(h.db, user.id)
    await createTestBrand(h.db, user.id)
    await h.r.users.updateBilling(user.id, { subscriptionStatus: 'canceled' })
    const change = await h.s.brands.reconcileLimit(user.id)
    expect(change.suspended).toHaveLength(0)
    expect(await h.r.brands.countActive(user.id)).toBe(2)
  })
})
