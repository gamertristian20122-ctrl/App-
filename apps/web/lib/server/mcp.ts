// /api/mcp transport glue: which browser origins may call the MCP endpoint (the @app/mcp handler
// enforces the same list as its DNS-rebinding check) and the CORS headers for them. Claude,
// ChatGPT and Cursor call from their servers or native apps without an Origin header; browser
// tools such as MCP Inspector send one. Server-only.

import type { Config } from '@app/core/config'

/** MCP Inspector's default local origins (allowed outside production only). */
const DEV_BROWSER_CLIENT_ORIGINS = ['http://localhost:6274', 'http://127.0.0.1:6274']

/** Extra origins accepted besides the app's own (passed to handleMcpRequest as allowedOrigins). */
export function mcpAllowedOrigins(config: Pick<Config, 'APP_ENV'>): string[] {
  return config.APP_ENV === 'production' ? [] : [...DEV_BROWSER_CLIENT_ORIGINS]
}

const ALLOW_HEADERS = [
  'authorization',
  'content-type',
  'accept',
  'mcp-protocol-version',
  'mcp-method',
  'mcp-name',
  'mcp-session-id',
  'last-event-id',
].join(', ')

const EXPOSE_HEADERS = ['www-authenticate', 'mcp-protocol-version', 'mcp-session-id'].join(', ')

function originOf(value: string): string | null {
  try {
    return new URL(value).origin
  } catch {
    return null
  }
}

/** CORS headers for a request (empty when it has no Origin or the origin is not allowed). */
export function mcpCorsHeaders(req: Request, config: Pick<Config, 'APP_URL' | 'APP_ENV'>, preflight = false): Record<string, string> {
  const origin = req.headers.get('origin')
  if (!origin) return {}
  const allowed = new Set([config.APP_URL, ...mcpAllowedOrigins(config)].map(originOf).filter((o): o is string => o !== null))
  if (!allowed.has(origin)) return preflight ? { vary: 'Origin' } : {}
  const headers: Record<string, string> = {
    'access-control-allow-origin': origin,
    'access-control-expose-headers': EXPOSE_HEADERS,
    vary: 'Origin',
  }
  if (preflight) {
    headers['access-control-allow-methods'] = 'GET, POST, DELETE, OPTIONS'
    headers['access-control-allow-headers'] = ALLOW_HEADERS
    headers['access-control-max-age'] = '86400'
  }
  return headers
}
