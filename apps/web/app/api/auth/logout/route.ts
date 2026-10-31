// Sign out: ends the Supabase session (best effort) and clears the dev and Supabase cookies.
// POST only (same-origin). Form posts are redirected to "/", other requests get JSON.

import { loadConfig } from '@app/core/config'
import { DEV_SESSION_COOKIE } from '@/lib/auth'
import { expireCookie, requestCookieNames } from '@/lib/server/cookies'
import { serverEnv } from '@/lib/server/deps'
import { crossOrigin, isFormPost, isSameOrigin, json, seeOther } from '@/lib/server/http'
import { routeSupabase } from '@/lib/server/supabase'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(req: Request): Promise<Response> {
  const config = loadConfig(serverEnv())
  if (!isSameOrigin(req, config.APP_URL)) return crossOrigin()

  const sb = routeSupabase(req)
  if (sb && sb.requestCookieNames.length > 0) {
    try {
      await sb.client.auth.signOut({ scope: 'local' })
    } catch {
      // The cookies are cleared below either way.
    }
  }
  const res = isFormPost(req) ? seeOther('/') : json({ signedOut: true })
  if (sb) sb.apply(res)
  const names = new Set(requestCookieNames(req).filter((n) => n.startsWith('sb-')))
  names.add(DEV_SESSION_COOKIE)
  for (const name of names) res.headers.append('set-cookie', expireCookie(name))
  return res
}
