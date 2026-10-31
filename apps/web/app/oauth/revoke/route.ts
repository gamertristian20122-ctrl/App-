// RFC 7009 token revocation: always 200 for a well-formed request (unknown tokens included);
// revoking a refresh token ends its whole family.

import { oauthErrorResponse } from '@app/services'
import { getRuntime } from '@/lib/server/deps'
import { clientIp, json, preflight, PUBLIC_CORS, readBody, unavailable, withHeaders } from '@/lib/server/http'
import { hitRateLimit, tooManyRequests } from '@/lib/server/rate-limit'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MAX_BODY = 8 * 1024
const HEADERS = { ...PUBLIC_CORS, 'cache-control': 'no-store' }

export async function POST(req: Request): Promise<Response> {
  const limit = hitRateLimit('oauthRevoke', clientIp(req))
  if (!limit.ok) return tooManyRequests(limit, { error: 'invalid_request', error_description: 'Too many requests.' }, HEADERS)
  const body = await readBody(req, MAX_BODY)
  if (!body.ok) return json({ error: 'invalid_request', error_description: 'Malformed revocation request.' }, { status: 400, headers: HEADERS })

  let rt
  try {
    rt = await getRuntime()
  } catch {
    return withHeaders(unavailable(), HEADERS)
  }
  try {
    await rt.services.oauth.revoke(body.data)
    return new Response(null, { status: 200, headers: HEADERS })
  } catch (error) {
    const { status, body: errBody } = oauthErrorResponse(error)
    if (status >= 500) rt.log.error('oauth revoke failed', error instanceof Error ? error : { error: String(error) })
    return json(errBody, { status: status >= 500 ? 503 : status, headers: HEADERS })
  }
}

export function OPTIONS(): Response {
  return preflight()
}
