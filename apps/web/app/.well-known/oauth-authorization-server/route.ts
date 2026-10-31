// RFC 8414 authorization server metadata (issuer = APP_URL, so no path suffix). OIDC discovery
// (/.well-known/openid-configuration) is not served: we are not an OpenID provider, and MCP
// clients try RFC 8414 first.

import { preflight } from '@/lib/server/http'
import { authorizationServerMetadataResponse } from '@/lib/server/metadata'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export function GET(): Promise<Response> {
  return authorizationServerMetadataResponse()
}

export function OPTIONS(): Response {
  return preflight()
}
