import type { Metadata } from 'next'
import { BillingView, type CheckoutNotice } from '@/components/app/billing'
import { loadBilling } from '@/lib/ui/data'
import { param } from '@/lib/ui/paths'
import { pageContext } from '@/lib/ui/server'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Billing' }

const NOTICES: readonly CheckoutNotice[] = ['success', 'canceled', 'has_subscription']

export default async function BillingPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams
  const ctx = await pageContext('/app/billing')
  const data = await loadBilling(ctx.services, ctx.user.id)
  const raw = param(sp, 'checkout')
  return <BillingView data={data} notice={NOTICES.find((n) => n === raw) ?? null} />
}
