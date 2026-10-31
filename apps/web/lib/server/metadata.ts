// The discovery documents MCP clients read before signing in (served from app/.well-known/*):
// RFC 9728 protected resource metadata and RFC 8414 authorization server metadata. The content
// comes from services.oauth; these handlers add caching and CORS. Server-only.

import { getRuntime } from './deps'
import { json, PUBLIC_CORS, unavailable } from './http'

const CACHE = { 'cache-control': 'public, max-age=300' }

export async function protectedResourceMetadataResponse(): Promise<Response> {
  try {
    const { services } = await getRuntime()
    return json(services.oauth.protectedResourceMetadata(), { headers: { ...CACHE, ...PUBLIC_CORS } })
  } catch {
    return unavailable()
  }
}

export async function authorizationServerMetadataResponse(): Promise<Response> {
  try {
    const { services } = await getRuntime()
    return json(services.oauth.authorizationServerMetadata(), { headers: { ...CACHE, ...PUBLIC_CORS } })
  } catch {
    return unavailable()
  }
}
