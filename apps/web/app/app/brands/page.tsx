import type { Metadata } from 'next'
import { BrandsView } from '@/components/app/brands'
import { loadBrands } from '@/lib/ui/data'
import { pageContext } from '@/lib/ui/server'
import { archiveBrandAction, autoPostAction, createBrandAction, restoreBrandAction, updateBrandAction } from '../actions'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Brands' }

export default async function BrandsPage() {
  const ctx = await pageContext('/app/brands')
  const data = await loadBrands(ctx.services, ctx.user.id)
  return (
    <BrandsView
      data={data}
      actions={{ create: createBrandAction, update: updateBrandAction, archive: archiveBrandAction, restore: restoreBrandAction, autoPost: autoPostAction }}
    />
  )
}
