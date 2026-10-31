// RFC 7591 dynamic client registration for MCP clients (public clients, PKCE). Rate-limited per
// IP; redirect URIs must be https or http on a loopback host (lib/server/oauth.ts), then
// services.oauth.registerClient validates the rest.

import { oauthErrorResponse } from '@app/services'
import { getRuntime } from '@/lib/server/deps'
import { clientIp, json, preflight, PUBLIC_CORS, readBody, unavailable, withHeaders } from '@/lib/server/http'
import { redirectUriProblem } from '@/lib/server/oauth'
import { hitRateLimit, tooManyRequests } from '@/lib/server/rate-limit'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MAX_BODY = 16 * 1024

const oauthJson = (status: number, error: string, description: string) =>
  json({ error, error_description: description }, { status, headers: PUBLIC_CORS })

export async function POST(req: Request): Promise<Response> {
  const limit = hitRateLimit('oauthRegister', clientIp(req))
  if (!limit.ok) {
    return tooManyRequests(limit, { error: 'invalid_request', error_description: 'Too many registrations. Try again later.' }, PUBLIC_CORS)
  }
  const body = await readBody(req, MAX_BODY, { json: true, form: false })
  if (!body.ok) return withHeaders(body.response, PUBLIC_CORS)

  const uris = body.data.redirect_uris
  if (!Array.isArray(uris) || uris.length === 0) {
    return oauthJson(400, 'invalid_client_metadata', 'redirect_uris (1–10 URLs) is required.')
  }
  for (const uri of uris) {
    const problem = redirectUriProblem(uri)
    if (problem) return oauthJson(400, 'invalid_redirect_uri', problem)
  }

  let rt
  try {
    rt = await getRuntime()
  } catch {
    return withHeaders(unavailable(), PUBLIC_CORS)
  }
  try {
    const client = await rt.services.oauth.registerClient(body.data)
    return json(client, { status: 201, headers: PUBLIC_CORS })
  } catch (error) {
    const { status, body: errBody } = oauthErrorResponse(error)
    if (status >= 500) rt.log.error('oauth register failed', error instanceof Error ? error : { error: String(error) })
    return json(errBody, { status, headers: PUBLIC_CORS })
  }
}

export function OPTIONS(): Response {
  return preflight()
}
