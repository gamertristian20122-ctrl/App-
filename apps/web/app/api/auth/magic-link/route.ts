// Sends a Supabase magic link (PKCE: the code verifier cookie is set on this response, so the
// link must be opened in the same browser). The link lands on /auth/callback?next=... .
// Rate-limited per IP. Form posts are redirected to /login?sent=1, other requests get JSON.

import { loadConfig } from '@app/core/config'
import { isValidEmail, normalizeEmail } from '@/lib/auth'
import { serverEnv } from '@/lib/server/deps'
import { clientIp, crossOrigin, errorJson, isSameOrigin, json, readBody, safeNext, seeOther } from '@/lib/server/http'
import { hitRateLimit, tooManyRequests } from '@/lib/server/rate-limit'
import { routeSupabase } from '@/lib/server/supabase'
import { stringField } from '@/lib/server/validate'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(req: Request): Promise<Response> {
  const config = loadConfig(serverEnv())
  if (!isSameOrigin(req, config.APP_URL)) return crossOrigin()
  const limit = hitRateLimit('magicLink', clientIp(req))
  if (!limit.ok) return tooManyRequests(limit)

  const body = await readBody(req, 4096)
  if (!body.ok) return body.response
  const rawEmail = stringField(body.data.email, { max: 254, trim: true })
  const rawNext = stringField(body.data.next, { max: 2048, optional: true })
  if (!rawEmail.ok || !rawNext.ok || !isValidEmail(rawEmail.value)) return errorJson(400, 'validation', 'Enter a valid email address.')
  const next = safeNext(rawNext.value)

  const sb = routeSupabase(req)
  if (!sb) return errorJson(503, 'unavailable', 'Email sign-in is not configured.')
  const redirectTo = `${config.APP_URL}/auth/callback?next=${encodeURIComponent(next)}`
  let failed: { status?: number } | null = null
  try {
    const { error } = await sb.client.auth.signInWithOtp({
      email: normalizeEmail(rawEmail.value),
      options: { emailRedirectTo: redirectTo, shouldCreateUser: true },
    })
    if (error) failed = { status: error.status }
  } catch {
    failed = {}
  }
  if (failed) {
    if (failed.status === 429) return errorJson(429, 'rate_limited', 'Too many sign-in emails. Please wait a minute and try again.')
    return errorJson(502, 'unavailable', 'We could not send the sign-in email. Please try again.')
  }
  const res = body.kind === 'form' ? seeOther(`/login?sent=1&next=${encodeURIComponent(next)}`) : json({ sent: true })
  return sb.apply(res)
}
