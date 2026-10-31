import type { Metadata } from 'next'
import { MediaView } from '@/components/app/media'
import { loadMedia } from '@/lib/ui/data'
import { isServiceError } from '@/lib/ui/errors'
import { param } from '@/lib/ui/paths'
import { pageContext } from '@/lib/ui/server'
import { addDriveLinkAction, deleteMediaAction } from '../actions'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Media', referrer: 'no-referrer' }

export default async function MediaPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams
  const ctx = await pageContext('/app/media')
  const cursor = param(sp, 'cursor')
  let page
  try {
    page = await loadMedia(ctx.services, ctx.user.id, { cursor: cursor && cursor.length <= 100 ? cursor : null })
  } catch (error) {
    if (!isServiceError(error) || !cursor) throw error
    page = await loadMedia(ctx.services, ctx.user.id)
  }
  const brands = ctx.brands.filter((b) => b.status === 'active').map((b) => ({ id: b.id, name: b.name }))
  return (
    <MediaView
      items={page.items}
      nextCursor={page.nextCursor}
      brands={brands}
      defaultBrandId={ctx.brand?.status === 'active' ? ctx.brand.id : null}
      actions={{ addDriveLink: addDriveLinkAction, remove: deleteMediaAction }}
    />
  )
}
