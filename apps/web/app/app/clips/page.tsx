import type { Metadata } from 'next'
import { ClipsView } from '@/components/app/clips'
import { loadClips } from '@/lib/ui/data'
import { isId } from '@/lib/ui/form'
import { param } from '@/lib/ui/paths'
import { pageContext } from '@/lib/ui/server'
import { requestClipAction } from '../actions'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Clips' }

export default async function ClipsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams
  const ctx = await pageContext('/app/clips')
  const source = param(sp, 'source')
  const data = await loadClips(ctx.services, ctx.user.id, {
    sourceId: isId(source) ? source.toLowerCase() : null,
    query: param(sp, 'q') ?? null,
  })
  return <ClipsView data={data} requestClip={requestClipAction} />
}
