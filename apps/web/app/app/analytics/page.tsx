import type { Metadata } from 'next'
import { AnalyticsView } from '@/components/app/analytics'
import { loadAnalytics } from '@/lib/ui/data'
import { param } from '@/lib/ui/paths'
import { pageContext } from '@/lib/ui/server'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Analytics' }

export default async function AnalyticsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams
  const ctx = await pageContext('/app/analytics')
  const showingAll = param(sp, 'brand') === 'all'
  const brands = showingAll ? ctx.brands.filter((b) => b.status === 'active') : ctx.brand ? [ctx.brand] : []
  const reviews = await loadAnalytics(ctx.services, ctx.user.id, brands)
  return <AnalyticsView reviews={reviews} showingAll={showingAll} selectedBrandName={ctx.brands.length > 1 ? (ctx.brand?.name ?? null) : null} />
}
