// The remote MCP endpoint (Streamable HTTP, stateless). Verifies the OAuth bearer token issued by
// our own authorization server (audience = our MCP URL), then hands the untouched Request to
// @app/mcp. A missing or invalid token gets 401 + WWW-Authenticate pointing at the protected
// resource metadata, which is how MCP clients discover how to sign in.

import { handleMcpRequest } from '@app/mcp'
import { oauthErrorCode, type AccessContext } from '@app/services'
import { getRuntime } from '@/lib/server/deps'
import { errorJson, json, preflight, unavailable, withHeaders } from '@/lib/server/http'
import { mcpAllowedOrigins, mcpCorsHeaders } from '@/lib/server/mcp'
import { mcpChallenge } from '@/lib/server/oauth'
import { hitRateLimit, tooManyRequests } from '@/lib/server/rate-limit'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

async function handle(req: Request): Promise<Response> {
  let rt
  try {
    rt = await getRuntime()
  } catch {
    return unavailable()
  }
  const { services, config, log } = rt
  const cors = mcpCorsHeaders(req, config)

  const challenge = (error?: 'invalid_token', description?: string) =>
    json(
      error
        ? { error, error_description: description ?? 'The access token is invalid or expired.' }
        : { error: 'unauthorized', error_description: 'Sign in to use this MCP server.' },
      { status: 401, headers: { 'www-authenticate': mcpChallenge(config, error), ...cors } },
    )

  const authorization = req.headers.get('authorization')
  if (!authorization || !/^Bearer\s+\S/i.test(authorization)) return challenge()

  let access: AccessContext
  try {
    access = await services.oauth.verifyAccessToken(authorization)
  } catch (error) {
    if (oauthErrorCode(error) === 'invalid_token') return challenge('invalid_token')
    // A database or configuration problem must not look like a bad token (clients would re-auth).
    log.error('mcp token verification failed', error instanceof Error ? error : { error: String(error) })
    return withHeaders(unavailable(), cors)
  }

  const limit = hitRateLimit('mcp', access.userId)
  if (!limit.ok) return tooManyRequests(limit, undefined, cors)

  try {
    const res = await handleMcpRequest(req, {
      services,
      userId: access.userId,
      baseUrl: config.APP_URL,
      log: log.child({ route: 'mcp' }),
      allowedOrigins: mcpAllowedOrigins(config),
    })
    return withHeaders(res, cors)
  } catch (error) {
    log.error('mcp request crashed', error instanceof Error ? error : { error: String(error) })
    return withHeaders(errorJson(500, 'internal', 'Something went wrong on our side. Please try again in a minute.'), cors)
  }
}

export const GET = handle
export const POST = handle
export const DELETE = handle

export async function OPTIONS(req: Request): Promise<Response> {
  let rt
  try {
    rt = await getRuntime()
  } catch {
    return unavailable()
  }
  return preflight(mcpCorsHeaders(req, rt.config, true))
}
