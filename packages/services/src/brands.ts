// Brands: create / list / update / archive / restore, with the plan's brand limit enforced
// race-free (the user row is locked while counting active brands), and downgrade handling
// (suspend the newest brands above the limit; restore suspended ones when the limit grows).

import { AppError } from '@app/core/errors'
import { BrandInputSchema, BrandUpdateSchema } from '@app/core/validation'
import type { Actor, BrandStatus } from '@app/core/types'
import { BrandStatusSchema } from '@app/core/types'
import type { BoundRepos, BrandRow } from '@app/db'
import { auditIn } from './audit'
import { conflict, errorMessage, fromZod, requireBrand, requireUser, userIdOf, withErrors, type Ctx } from './context'
import { requireCanCreate, userEntitlements } from './entitlements'

export interface BrandLimitChange {
  suspended: BrandRow[]
  restored: BrandRow[]
  limit: number
}

/**
 * Applies the brand limit after a plan change (call inside a transaction): suspends the newest
 * active brands above the limit and restores the oldest suspended brands while there is room.
 * Held accounts (canceled / unpaid / trial over: limit 0 with no plan) are left as they are:
 * entitlements already block everything, and nothing should flip when they resubscribe.
 */
export async function reconcileBrandLimitIn(ctx: Ctx, r: BoundRepos, userId: string, actor: Actor): Promise<BrandLimitChange> {
  const user = await requireUser(r, userId, true)
  const ent = userEntitlements(user, ctx.now())
  if (ent.plan === null) return { suspended: [], restored: [], limit: ent.brands }
  const suspended = await r.brands.suspendNewest(userId, ent.brands)
  const restored: BrandRow[] = []
  if (suspended.length === 0) {
    let active = await r.brands.countActive(userId)
    const waiting = await r.brands.list(userId, { status: 'suspended' })
    for (const brand of waiting) {
      if (active >= ent.brands) break
      const row = await r.brands.setStatus(userId, brand.id, 'active')
      if (row) {
        restored.push(row)
        active += 1
      }
    }
  }
  for (const b of suspended) {
    await auditIn(r, userId, { actor, action: 'brand.suspended', subjectType: 'brand', subjectId: b.id, meta: { limit: ent.brands } })
  }
  for (const b of restored) {
    await auditIn(r, userId, { actor, action: 'brand.restored', subjectType: 'brand', subjectId: b.id, meta: { limit: ent.brands } })
  }
  return { suspended, restored, limit: ent.brands }
}

/** Locks the user row and checks there is room for one more active brand. */
async function requireBrandRoom(ctx: Ctx, r: BoundRepos, userId: string): Promise<void> {
  const user = await requireUser(r, userId, true)
  const ent = userEntitlements(user, ctx.now())
  requireCanCreate(ent)
  const active = await r.brands.countActive(userId)
  if (active >= ent.brands) {
    throw new AppError(
      'limit_exceeded',
      `Your plan allows ${ent.brands} active brand${ent.brands === 1 ? '' : 's'}. Archive a brand or add an extra brand to your plan.`,
      { limit: ent.brands, used: active, remaining: 0 },
    )
  }
}

export function createBrandsService(ctx: Ctx) {
  /** Best effort: creates the brand's posting-provider profile (retried lazily by accounts.connectLink). */
  async function ensureProfile(userId: string, brand: BrandRow): Promise<BrandRow> {
    try {
      const { profileRef } = await ctx.provider.ensureProfile({
        brandId: brand.id,
        profileRef: brand.providerProfileRef,
        displayName: brand.name,
      })
      if (profileRef !== brand.providerProfileRef) {
        return (await ctx.repos.brands.setProviderProfileRef(userId, brand.id, profileRef)) ?? brand
      }
      return brand
    } catch (error) {
      ctx.log.warn('brand profile not created yet', { brandId: brand.id, error: errorMessage(error) })
      return brand
    }
  }

  /** Deletes an archived brand's provider profile and mirrors that locally (best effort). */
  async function releaseProfile(userId: string, brand: BrandRow, actor: Actor): Promise<BrandRow> {
    const profileRef = brand.providerProfileRef
    if (!profileRef) return brand
    try {
      await ctx.provider.deleteProfile(profileRef)
    } catch (error) {
      ctx.log.warn('brand profile not released yet', { brandId: brand.id, error: errorMessage(error) })
      return brand
    }
    return ctx.tx(async (r) => {
      const current = await r.brands.lockForUpdate(userId, brand.id)
      // restored (or relinked) meanwhile: leave it alone; the next connect recreates the profile
      if (!current || current.status !== 'archived' || current.providerProfileRef !== profileRef) return current ?? brand
      const live = await r.accounts.list(userId, { brandId: brand.id, status: ['pending', 'active', 'needs_reauth'] })
      for (const account of live) await r.accounts.setStatus(userId, account.id, 'disconnected')
      const row = await r.brands.setProviderProfileRef(userId, brand.id, null)
      await auditIn(r, userId, {
        actor,
        action: 'brand.profile_released',
        subjectType: 'brand',
        subjectId: brand.id,
        meta: { disconnectedAccounts: live.length },
      })
      return row ?? current
    })
  }

  return withErrors({
    async create(userId: string, input: unknown, options: { via?: Actor } = {}): Promise<BrandRow> {
      const uid = userIdOf(userId)
      const data = fromZod(BrandInputSchema, input, 'Brand')
      const brand = await ctx.tx(async (r) => {
        await requireBrandRoom(ctx, r, uid)
        const created = await r.brands.create(uid, { name: data.name, timezone: data.timezone })
        await auditIn(r, uid, {
          actor: options.via ?? 'web',
          action: 'brand.created',
          subjectType: 'brand',
          subjectId: created.id,
        })
        return created
      })
      return ensureProfile(uid, brand)
    },

    async list(userId: string, options: { status?: BrandStatus | BrandStatus[] } = {}): Promise<BrandRow[]> {
      const uid = userIdOf(userId)
      const status = options.status === undefined ? undefined : fromZod(BrandStatusSchema.array(), [options.status].flat(), 'Status')
      return ctx.repos.brands.list(uid, status ? { status } : {})
    },

    async get(userId: string, brandId: string): Promise<BrandRow> {
      return requireBrand(ctx.repos, userIdOf(userId), brandId)
    },

    async update(userId: string, brandId: string, patch: unknown, options: { via?: Actor } = {}): Promise<BrandRow> {
      const uid = userIdOf(userId)
      const data = fromZod(BrandUpdateSchema, patch, 'Brand')
      const updated = await ctx.tx(async (r) => {
        const brand = await requireBrand(r, uid, brandId)
        const row = await r.brands.update(uid, brand.id, {
          ...(data.name !== undefined ? { name: data.name } : {}),
          ...(data.timezone !== undefined ? { timezone: data.timezone } : {}),
        })
        await auditIn(r, uid, { actor: options.via ?? 'web', action: 'brand.updated', subjectType: 'brand', subjectId: brand.id })
        return row ?? brand
      })
      if (data.name !== undefined && updated.providerProfileRef) return ensureProfile(uid, updated)
      return updated
    },

    /**
     * Archives a brand (its data is kept). Its scheduled posts are canceled. The posting-provider
     * profile is deleted (best effort) and its accounts marked disconnected: provider profiles are
     * a limited, paid resource, and keeping them would let archive/create loops grow them without
     * bound. Restoring the brand recreates the profile on the next connect; accounts are reconnected.
     */
    async archive(userId: string, brandId: string, options: { via?: Actor } = {}): Promise<BrandRow> {
      const uid = userIdOf(userId)
      const archived = await ctx.tx(async (r) => {
        const brand = await requireBrand(r, uid, brandId)
        if (brand.status === 'archived') return brand
        const scheduled = await r.posts.list(uid, { brandId: brand.id, status: 'scheduled', limit: 1000 })
        for (const post of scheduled) await r.posts.cancel(uid, post.id, 'The brand was archived.')
        const row = await r.brands.setStatus(uid, brand.id, 'archived')
        await auditIn(r, uid, {
          actor: options.via ?? 'web',
          action: 'brand.archived',
          subjectType: 'brand',
          subjectId: brand.id,
          meta: { canceledPosts: scheduled.length },
        })
        return row ?? brand
      })
      if (archived.status !== 'archived' || !archived.providerProfileRef) return archived
      return releaseProfile(uid, archived, options.via ?? 'web')
    },

    /** Restores an archived (or suspended) brand when the plan has room. */
    async restore(userId: string, brandId: string, options: { via?: Actor } = {}): Promise<BrandRow> {
      const uid = userIdOf(userId)
      return ctx.tx(async (r) => {
        const brand = await requireBrand(r, uid, brandId)
        if (brand.status === 'active') return brand
        await requireBrandRoom(ctx, r, uid)
        const row = await r.brands.setStatus(uid, brand.id, 'active')
        if (!row) throw conflict('The brand could not be restored.')
        await auditIn(r, uid, { actor: options.via ?? 'web', action: 'brand.restored', subjectType: 'brand', subjectId: brand.id })
        return row
      })
    },

    /** Re-applies the brand limit (after a plan change). */
    async reconcileLimit(userId: string, options: { via?: Actor } = {}): Promise<BrandLimitChange> {
      const uid = userIdOf(userId)
      return ctx.tx((r) => reconcileBrandLimitIn(ctx, r, uid, options.via ?? 'system'))
    },

    /** Makes sure the brand has a posting-provider profile (idempotent). */
    async ensureProviderProfile(userId: string, brandId: string): Promise<BrandRow> {
      const uid = userIdOf(userId)
      const brand = await requireBrand(ctx.repos, uid, brandId)
      return ensureProfile(uid, brand)
    },
  })
}

export type BrandsService = ReturnType<typeof createBrandsService>
