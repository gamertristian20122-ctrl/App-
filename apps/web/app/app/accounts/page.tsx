// Connected accounts of the selected brand (?brand=<id> overrides the switcher). Coming back from
// the hosted connect page (?connected=<platform>) refreshes the brand's accounts from the provider.

import type { Metadata } from 'next'
import { PLATFORM_LABELS, isPlatform } from '@app/core/types'
import { AccountsView } from '@/components/app/accounts'
import { loadAccounts } from '@/lib/ui/data'
import { asAppError } from '@/lib/ui/errors'
import { param } from '@/lib/ui/paths'
import { pageContext } from '@/lib/ui/server'
import { connectAccountAction, disconnectAccountAction, syncAccountsAction } from '../actions'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Accounts' }

export default async function AccountsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams
  const ctx = await pageContext('/app/accounts', param(sp, 'brand'))
  const brand = ctx.brand
  let notice: { tone: 'success' | 'warning' | 'danger'; text: string } | null = null
  const returned = param(sp, 'connected')
  if (brand && isPlatform(returned)) {
    try {
      const result = await ctx.services.accounts.sync(ctx.user.id, brand.id, { via: 'web' })
      const live = result.accounts.find((a) => a.platform === returned && a.status !== 'disconnected')
      notice = live
        ? { tone: 'success', text: `${PLATFORM_LABELS[returned]} is connected.` }
        : { tone: 'warning', text: `${PLATFORM_LABELS[returned]} is not connected yet. If you finished connecting, press Refresh in a moment.` }
    } catch (error) {
      notice = { tone: 'danger', text: asAppError(error)?.message ?? 'We could not check your accounts. Try Refresh.' }
    }
  }
  const { slots, connected } = brand ? await loadAccounts(ctx.services, ctx.user.id, brand.id) : { slots: [], connected: 0 }
  return (
    <AccountsView
      brand={brand}
      slots={slots}
      connected={connected}
      notice={notice}
      actions={{ connect: connectAccountAction, sync: syncAccountsAction, disconnect: disconnectAccountAction }}
    />
  )
}
