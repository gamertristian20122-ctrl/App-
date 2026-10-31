// Supabase magic-link landing: exchanges the PKCE code (or verifies a token_hash link) for a
// session, stores the session cookies, creates the app user (trial starts once) and sends the
// browser to `next` (a same-site path only).

import type { EmailOtpType } from '@supabase/supabase-js'
import { normalizeEmail } from '@/lib/auth'
import { getRuntime } from '@/lib/server/deps'
import { safeNext, seeOther } from '@/lib/server/http'
import { ensureSignedInUser } from '@/lib/server/session'
import { routeSupabase } from '@/lib/server/supabase'
import { enumField, stringField } from '@/lib/server/validate'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const OTP_TYPES = ['magiclink', 'email', 'signup', 'invite', 'email_change'] as const

const toLogin = (reason: string, next: string) => `/login?error=${reason}&next=${encodeURIComponent(next)}`

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url)
  const get = (k: string) => url.searchParams.get(k) ?? undefined
  const nextField = stringField(get('next'), { max: 2048, optional: true })
  const next = safeNext(nextField.ok ? nextField.value : undefined)
  const code = stringField(get('code'), { min: 1, max: 512, optional: true })
  const tokenHash = stringField(get('token_hash'), { min: 1, max: 512, optional: true })
  const type = get('type') === undefined ? ({ ok: true, value: undefined } as const) : enumField(get('type'), OTP_TYPES)
  if (!code.ok || !tokenHash.ok || !type.ok) return seeOther(toLogin('link_invalid', next))
  // Supabase redirects here with ?error=... when the link is expired or was already used.
  if (url.searchParams.has('error')) return seeOther(toLogin('link_expired', next))
  const q = { code: code.value, token_hash: tokenHash.value, type: type.value }

  const sb = routeSupabase(req)
  if (!sb) return seeOther(toLogin('not_configured', next))

  let user: { id: string; email?: string | undefined } | null = null
  try {
    if (q.code) {
      const { data, error } = await sb.client.auth.exchangeCodeForSession(q.code)
      if (!error) user = data.user
    } else if (q.token_hash && q.type) {
      const { data, error } = await sb.client.auth.verifyOtp({ token_hash: q.token_hash, type: q.type as EmailOtpType })
      if (!error) user = data.user
    }
  } catch {
    user = null
  }
  if (!user?.email) return sb.apply(seeOther(toLogin('link_invalid', next)))

  try {
    const rt = await getRuntime()
    await ensureSignedInUser(rt, { id: user.id, email: normalizeEmail(user.email) }, { devLogin: false })
  } catch {
    return sb.apply(seeOther(toLogin('unavailable', next)))
  }
  return sb.apply(seeOther(next))
}
