import type { Metadata } from 'next'
import { ConnectView } from '@/components/app/connect'
import { loadConnections } from '@/lib/ui/data'
import { pageContext } from '@/lib/ui/server'
import { revokeAiConnectionAction } from '../actions'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Connect your AI' }

export default async function ConnectPage() {
  const ctx = await pageContext('/app/connect')
  const [connections, user] = await Promise.all([loadConnections(ctx.services, ctx.user.id), ctx.services.users.get(ctx.user.id)])
  return <ConnectView mcpUrl={ctx.rt.mcpUrl} connections={connections} revoke={revokeAiConnectionAction} timezone={user.timezone} />
}
