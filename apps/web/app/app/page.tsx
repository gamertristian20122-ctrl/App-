import type { Metadata } from 'next'
import { OverviewView } from '@/components/app/overview'
import { loadOverview } from '@/lib/ui/data'
import { pageContext } from '@/lib/ui/server'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Overview' }

export default async function OverviewPage() {
  const ctx = await pageContext('/app')
  const data = await loadOverview(ctx.services, ctx.user.id, ctx.now)
  return <OverviewView data={data} />
}
