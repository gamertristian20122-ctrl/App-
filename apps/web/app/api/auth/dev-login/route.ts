// Local email-only login (DEV_AUTH=1; config refuses it in production). Creates the auth + app
// user on a local database, sets the signed dev session cookie and redirects (form posts) or
// answers JSON. 404 when DEV_AUTH is off.

import { loadConfig } from '@app/core/config'
import { createDevSessionCookie, devUserId, isValidEmail, normalizeEmail } from '@/lib/auth'
import { serializeCookie } from '@/lib/server/cookies'
import { getRuntime, serverEnv } from '@/lib/server/deps'
import { clientIp, crossOrigin, errorJson, errorResponse, isSameOrigin, json, readBody, safeNext, seeOther } from '@/lib/server/http'
import { hitRateLimit, tooManyRequests } from '@/lib/server/rate-limit'
import { ensureSignedInUser } from '@/lib/server/session'
import { stringField } from '@/lib/server/validate'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(req: Request): Promise<Response> {
  const env = serverEnv()
  const config = loadConfig(env)
  if (!config.DEV_AUTH) return errorJson(404, 'not_found', 'Not found.')
  if (!isSameOrigin(req, config.APP_URL)) return crossOrigin()
  const limit = hitRateLimit('devLogin', clientIp(req))
  if (!limit.ok) return tooManyRequests(limit)

  const body = await readBody(req, 4096)
  if (!body.ok) return body.response
  const rawEmail = stringField(body.data.email, { max: 254, trim: true })
  const rawNext = stringField(body.data.next, { max: 2048, optional: true })
  if (!rawEmail.ok || !rawNext.ok || !isValidEmail(rawEmail.value)) {
    return errorJson(400, 'validation', 'Enter a valid email address.')
  }
  const email = normalizeEmail(rawEmail.value)
  const user = { id: devUserId(email), email }
  const next = safeNext(rawNext.value)

  let rt
  try {
    rt = await getRuntime()
    await ensureSignedInUser(rt, user, { devLogin: true })
  } catch (error) {
    return errorResponse(error, rt?.log)
  }
  const cookie = createDevSessionCookie(email, env)
  const setCookie = serializeCookie(cookie.name, cookie.value, cookie.options)
  if (body.kind === 'form') return seeOther(next, { 'set-cookie': setCookie })
  return json({ user, next }, { headers: { 'set-cookie': setCookie } })
}
