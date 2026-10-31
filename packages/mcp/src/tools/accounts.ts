// connect_account, list_accounts: brands and the social accounts connected to them.

import { PLATFORM_LABELS } from '@app/core/types'
import { ConnectAccountInputSchema, ListAccountsInputSchema } from '@app/core/validation'
import { appUrl, type McpContext } from '../context'
import { listText, ok } from '../results'
import { accountView, brandView, type AccountRow, type BrandRow } from '../views'
import { READ_ONLY, type ToolDef } from './types'

const BRAND_ID = 'The brand id (from list_accounts).'

/**
 * Our accounts page as the provider's return URL (https, or http on localhost in development).
 * `brand` + `connected` make the page refresh that brand's accounts from the provider on return
 * (the same contract the web app's own Connect button uses).
 */
function returnUrl(ctx: McpContext, input: unknown): string | undefined {
  const base = appUrl(ctx)
  try {
    const u = new URL(base)
    const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1'
    if (u.protocol === 'https:' || (u.protocol === 'http:' && local)) {
      const back = new URL(`${base}/app/accounts`)
      const parsed = ConnectAccountInputSchema.safeParse(input)
      if (parsed.success) {
        back.searchParams.set('brand', parsed.data.brandId)
        back.searchParams.set('connected', parsed.data.platform)
      }
      return back.toString()
    }
  } catch {
    // no return URL
  }
  return undefined
}

export const connectAccount: ToolDef = {
  name: 'connect_account',
  title: 'Connect a social account',
  description:
    'Creates a secure link where the user connects one social account (TikTok, YouTube, Instagram, Facebook, Threads, X, LinkedIn, Pinterest or Bluesky) to a brand. ' +
    'Give the link to the user: they open it and sign in to the platform themselves. Never ask the user for passwords or API keys. ' +
    'Afterwards call list_accounts to confirm the account is active. One account per platform per brand.',
  input: ConnectAccountInputSchema,
  describe: { brandId: BRAND_ID, platform: 'The platform to connect.' },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  async run(ctx, args) {
    const redirectUrl = returnUrl(ctx, args)
    const link = await ctx.services.accounts.connectLink(ctx.userId, args, { via: 'mcp', ...(redirectUrl ? { redirectUrl } : {}) })
    const label = PLATFORM_LABELS[link.platform]
    return ok(
      [
        `Connect link for ${label} (expires ${link.expiresAt}):`,
        link.url,
        `Ask the user to open it and sign in to ${label}. When they are done, call list_accounts with brandId=${link.brandId} to confirm the account is active.`,
      ].join('\n'),
      { url: link.url, expiresAt: link.expiresAt, brandId: link.brandId, platform: link.platform },
    )
  },
}

async function refresh(ctx: McpContext, brand: BrandRow): Promise<boolean> {
  // Mirror the provider's view only for brands that already have a provider profile (no side effects otherwise).
  if (!brand.providerProfileRef || brand.status === 'archived') return true
  try {
    await ctx.services.accounts.sync(ctx.userId, brand.id, { via: 'mcp' })
    return true
  } catch (error) {
    ctx.log?.warn('list_accounts: account refresh failed', { brandId: brand.id, err: error instanceof Error ? error : String(error) })
    return false
  }
}

function accountLine(a: AccountRow): string {
  const name = a.handle ? `@${a.handle.replace(/^@/, '')}` : (a.displayName ?? 'account')
  return `  - ${PLATFORM_LABELS[a.platform]} ${name}: ${a.status} (accountId ${a.id})`
}

export const listAccounts: ToolDef = {
  name: 'list_accounts',
  title: 'List brands and connected accounts',
  description:
    'Lists the user\'s brands (with their ids and time zones) and the social accounts connected to each brand, with their status (active, pending, needs_reauth). ' +
    'Call this first to learn brand ids. Accounts that need attention can be reconnected with connect_account.',
  input: ListAccountsInputSchema,
  describe: { brandId: 'Only this brand (optional).' },
  annotations: { ...READ_ONLY, openWorldHint: true },
  async run(ctx, args) {
    const { services, userId } = ctx
    const brandId = typeof args.brandId === 'string' ? args.brandId : undefined
    const brands = brandId ? [await services.brands.get(userId, brandId)] : await services.brands.list(userId, { status: ['active', 'suspended'] })
    const stale: string[] = []
    for (const brand of brands) if (!(await refresh(ctx, brand))) stale.push(brand.name)
    const accounts = await services.accounts.list(userId, args)
    const live = accounts.filter((a) => a.status !== 'disconnected')
    const byBrand = brands.map((b) => ({ brand: b, accounts: live.filter((a) => a.brandId === b.id) }))

    if (brands.length === 0) {
      return ok('No brands yet. The user can create a brand in the web app, then connect accounts with connect_account.', { brands: [] })
    }
    const lines: string[] = []
    for (const { brand, accounts: list } of byBrand) {
      lines.push(`Brand "${brand.name}" (brandId ${brand.id}, ${brand.timezone}${brand.status === 'active' ? '' : `, ${brand.status}`}):`)
      if (list.length === 0) lines.push('  - no connected accounts yet (use connect_account)')
      else lines.push(...list.map(accountLine))
    }
    if (stale.length > 0) lines.push(`Could not refresh account status for ${listText(stale)} just now; showing the last known status.`)
    return ok(lines.join('\n'), {
      brands: byBrand.map(({ brand, accounts: list }) => ({ ...brandView(brand), accounts: list.map(accountView) })),
    })
  },
}
