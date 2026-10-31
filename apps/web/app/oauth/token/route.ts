// OAuth 2.1 token endpoint: authorization_code (PKCE S256, resource = our MCP URL) and
// refresh_token (rotated on every use; a reused refresh token revokes its whole family).
// Form-encoded per RFC 6749 (JSON is tolerated). Errors are RFC 6749 §5.2 JSON. Never logs tokens.

import { oauthErrorResponse } from '@app/services'
import { getRuntime } from '@/lib/server/deps'
import { clientIp, json, preflight, PUBLIC_CORS, readBody, unavailable, withHeaders } from '@/lib/server/http'
import { hitRateLimit, tooManyRequests } from '@/lib/server/rate-limit'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MAX_BODY = 16 * 1024
const HEADERS = { ...PUBLIC_CORS, 'cache-control': 'no-store', pragma: 'no-cache' }

/** client_id from HTTP Basic auth (some public clients send "client_id:" there). */
function basicClientId(req: Request): string | undefined {
  const match = /^Basic\s+([A-Za-z0-9+/=]+)$/i.exec(req.headers.get('authorization')?.trim() ?? '')
  if (!match?.[1]) return undefined
  try {
    const decoded = Buffer.from(match[1], 'base64').toString('utf8')
    const id = decodeURIComponent(decoded.split(':')[0] ?? '')
    return id || undefined
  } catch {
    return undefined
  }
}

export async function POST(req: Request): Promise<Response> {
  const limit = hitRateLimit('oauthToken', clientIp(req))
  if (!limit.ok) {
    return tooManyRequests(limit, { error: 'invalid_request', error_description: 'Too many requests. Try again shortly.' }, HEADERS)
  }
  const body = await readBody(req, MAX_BODY)
  if (!body.ok) {
    return json({ error: 'invalid_request', error_description: 'Send the token request as application/x-www-form-urlencoded.' }, { status: body.response.status === 413 ? 413 : 400, headers: HEADERS })
  }
  const input: Record<string, unknown> = { ...body.data }
  if (input.client_id === undefined) {
    const id = basicClientId(req)
    if (id) input.client_id = id
  }

  let rt
  try {
    rt = await getRuntime()
  } catch {
    return withHeaders(unavailable(), HEADERS)
  }
  try {
    const tokens = await rt.services.oauth.token(input)
    return json(tokens, { headers: HEADERS })
  } catch (error) {
    const { status, body: errBody } = oauthErrorResponse(error)
    if (status >= 500) rt.log.error('oauth token failed', error instanceof Error ? error : { error: String(error) })
    return json(errBody, { status, headers: HEADERS })
  }
}

export function OPTIONS(): Response {
  return preflight()
}
