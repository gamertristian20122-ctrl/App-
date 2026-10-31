// RFC 9728 protected resource metadata for /api/mcp (root form).

import { preflight } from '@/lib/server/http'
import { protectedResourceMetadataResponse } from '@/lib/server/metadata'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export function GET(): Promise<Response> {
  return protectedResourceMetadataResponse()
}

export function OPTIONS(): Response {
  return preflight()
}
