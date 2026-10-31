// Connected social accounts: connect links (hosted by the posting provider), sync from the
// provider, list, disconnect. One live account per platform per brand (Upload-Post constraint).

import { z } from 'zod'
import { PLATFORM_LABELS, type AccountStatus, type Actor, type Platform } from '@app/core/types'
import { ConnectAccountInputSchema, ListAccountsInputSchema } from '@app/core/validation'
import type { AccountRow, BoundRepos, BrandRow } from '@app/db'
import { auditIn } from './audit'
import { fromZod, requireAccount, requireActiveBrand, requireBrand, requireUser, userIdOf, validation, withErrors, type Ctx } from './context'
import { requireCanCreate, userEntitlements } from './entitlements'

const RedirectSchema = z
  .string()
  .trim()
  .max(2048)
  .refine((s) => {
    try {
      const u = new URL(s)
      return u.protocol === 'https:' || (u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1'))
    } catch {
      return false
    }
  }, 'Must be an https URL.')

export interface ConnectLink {
  url: string
  expiresAt: string
  brandId: string
  platform: Platform
}

export interface SyncResult {
  accounts: AccountRow[]
  connected: Platform[]
  disconnected: Platform[]
}

/** The account a variant publishes through: the pinned one, or the brand's live account for its platform. */
export async function resolveAccountIn(
  r: BoundRepos,
  userId: string,
  brandId: string,
  variant: { platform: Platform; connectedAccountId: string | null },
): Promise<AccountRow | null> {
  if (variant.connectedAccountId) {
    const account = await r.accounts.get(userId, variant.connectedAccountId)
    if (!account || account.brandId !== brandId || account.platform !== variant.platform) return null
    return account
  }
  return r.accounts.findLive(userId, brandId, variant.platform)
}

export function accountProblem(platform: Platform, account: AccountRow | null): string | null {
  const label = PLATFORM_LABELS[platform]
  if (!account || account.status === 'disconnected') return `Connect your ${label} account to this brand first.`
  if (account.status === 'needs_reauth') return `The ${label} account needs to be reconnected.`
  if (account.status === 'pending') return `The ${label} account is still connecting. Finish connecting it first.`
  return null
}

export function createAccountsService(ctx: Ctx) {
  /** The brand's provider profile, created on demand. */
  async function profileFor(userId: string, brand: BrandRow): Promise<string> {
    const { profileRef } = await ctx.provider.ensureProfile({
      brandId: brand.id,
      profileRef: brand.providerProfileRef,
      displayName: brand.name,
    })
    if (profileRef !== brand.providerProfileRef) await ctx.repos.brands.setProviderProfileRef(userId, brand.id, profileRef)
    return profileRef
  }

  async function syncBrand(userId: string, brand: BrandRow, actor: Actor): Promise<SyncResult> {
    const profileRef = await profileFor(userId, brand)
    const remote = await ctx.provider.listAccounts(profileRef)
    return ctx.tx(async (r) => {
      const connected: Platform[] = []
      const disconnected: Platform[] = []
      const seen = new Set<Platform>()
      for (const acc of remote) {
        seen.add(acc.platform)
        const existing = await r.accounts.findLive(userId, brand.id, acc.platform)
        if (acc.status === 'disconnected') {
          if (existing) {
            await r.accounts.setStatus(userId, existing.id, 'disconnected')
            disconnected.push(acc.platform)
          }
          continue
        }
        const status: 'pending' | 'active' | 'needs_reauth' = acc.status
        const row = await r.accounts.upsertLive(userId, {
          brandId: brand.id,
          platform: acc.platform,
          provider: ctx.provider.name,
          externalAccountId: acc.externalId,
          handle: acc.handle,
          displayName: acc.displayName,
          status,
        })
        if (!existing || existing.status !== row.status) connected.push(acc.platform)
      }
      // live accounts the provider no longer reports were disconnected on the provider side
      const live = await r.accounts.list(userId, { brandId: brand.id, status: ['pending', 'active', 'needs_reauth'] })
      for (const account of live) {
        if (seen.has(account.platform)) continue
        await r.accounts.setStatus(userId, account.id, 'disconnected')
        disconnected.push(account.platform)
      }
      if (connected.length > 0 || disconnected.length > 0) {
        await auditIn(r, userId, {
          actor,
          action: 'accounts.synced',
          subjectType: 'brand',
          subjectId: brand.id,
          meta: { connected, disconnected },
        })
      }
      const accounts = await r.accounts.list(userId, { brandId: brand.id })
      return { accounts, connected, disconnected }
    })
  }

  return withErrors({
    /**
     * A link to the provider's hosted connect page for one platform. The account appears after
     * the user finishes there and `sync` runs (redirect back, webhook, or the next list).
     */
    async connectLink(userId: string, input: unknown, options: { redirectUrl?: string; via?: Actor } = {}): Promise<ConnectLink> {
      const uid = userIdOf(userId)
      const data = fromZod(ConnectAccountInputSchema, input, 'Connect request')
      const redirectUrl = options.redirectUrl === undefined ? undefined : fromZod(RedirectSchema, options.redirectUrl, 'Redirect URL')
      const user = await requireUser(ctx.repos, uid)
      requireCanCreate(userEntitlements(user, ctx.now()))
      const brand = await requireActiveBrand(ctx.repos, uid, data.brandId)
      const profileRef = await profileFor(uid, brand)
      const link = await ctx.provider.createConnectLink({
        profileRef,
        platforms: [data.platform],
        ...(redirectUrl ? { redirectUrl } : {}),
      })
      await auditIn(ctx.repos, uid, {
        actor: options.via ?? 'web',
        action: 'account.connect_link',
        subjectType: 'brand',
        subjectId: brand.id,
        meta: { platform: data.platform },
      })
      return { url: link.url, expiresAt: link.expiresAt, brandId: brand.id, platform: data.platform }
    },

    /** Pulls the brand's accounts from the provider and mirrors them. */
    async sync(userId: string, brandId: string, options: { via?: Actor } = {}): Promise<SyncResult> {
      const uid = userIdOf(userId)
      const brand = await requireBrand(ctx.repos, uid, brandId)
      if (brand.status === 'archived') throw validation('This brand is archived.')
      return syncBrand(uid, brand, options.via ?? 'system')
    },

    async list(userId: string, input: unknown = {}): Promise<AccountRow[]> {
      const uid = userIdOf(userId)
      const data = fromZod(ListAccountsInputSchema, input ?? {}, 'Filter')
      if (data.brandId) await requireBrand(ctx.repos, uid, data.brandId)
      return ctx.repos.accounts.list(uid, data.brandId ? { brandId: data.brandId } : {})
    },

    async get(userId: string, accountId: string): Promise<AccountRow> {
      return requireAccount(ctx.repos, userIdOf(userId), accountId)
    },

    /**
     * Disconnects an account at the provider and here. Its scheduled posts are canceled (they
     * could not publish). Idempotent.
     */
    async disconnect(userId: string, accountId: string, options: { via?: Actor } = {}): Promise<AccountRow> {
      const uid = userIdOf(userId)
      const account = await requireAccount(ctx.repos, uid, accountId)
      if (account.status === 'disconnected') return account
      const brand = await requireBrand(ctx.repos, uid, account.brandId)
      if (brand.providerProfileRef) {
        await ctx.provider.disconnect({ profileRef: brand.providerProfileRef, platform: account.platform })
      }
      return ctx.tx(async (r) => {
        const scheduled = await r.posts.list(uid, { connectedAccountId: account.id, status: 'scheduled', limit: 1000 })
        for (const post of scheduled) await r.posts.cancel(uid, post.id, 'The account was disconnected.')
        const row = await r.accounts.setStatus(uid, account.id, 'disconnected')
        await auditIn(r, uid, {
          actor: options.via ?? 'web',
          action: 'account.disconnected',
          subjectType: 'connected_account',
          subjectId: account.id,
          meta: { platform: account.platform, canceledPosts: scheduled.length },
        })
        return row ?? account
      })
    },

    /**
     * Provider webhook (account_status): set the status of the brand's live account for a
     * platform. Callers must verify the webhook first and resolve the brand from its profile ref.
     */
    async applyProviderStatus(userId: string, brandId: string, platform: Platform, status: AccountStatus): Promise<AccountRow | null> {
      const uid = userIdOf(userId)
      const brand = await requireBrand(ctx.repos, uid, brandId)
      if (status === 'active' || status === 'pending') {
        // a (re)connection: pull the full account details
        const result = await syncBrand(uid, brand, 'system')
        return result.accounts.find((a) => a.platform === platform && a.status !== 'disconnected') ?? null
      }
      const live = await ctx.repos.accounts.findLive(uid, brand.id, platform)
      if (!live) return null
      return ctx.tx(async (r) => {
        const row = await r.accounts.setStatus(uid, live.id, status)
        await auditIn(r, uid, {
          actor: 'system',
          action: 'account.status_changed',
          subjectType: 'connected_account',
          subjectId: live.id,
          meta: { platform, status },
        })
        return row
      })
    },
  })
}

export type AccountsService = ReturnType<typeof createAccountsService>
