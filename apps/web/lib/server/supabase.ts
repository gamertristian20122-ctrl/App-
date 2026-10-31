// A Supabase Auth client for one route-handler request: reads the request's cookies and collects
// the cookies (and cache headers) Supabase wants to set, to copy onto the response. Server-only.

import { createServerClient, parseCookieHeader, type CookieOptions } from '@supabase/ssr'
import { loadConfig } from '@app/core/config'
import { serializeCookie, type CookieAttributes } from './cookies'
import { serverEnv, supabaseFetch } from './deps'

export interface RouteSupabase {
  client: ReturnType<typeof createServerClient>
  /** Copies the pending auth cookies and cache headers onto `res` (returns it). */
  apply(res: Response): Response
  /** Names of the Supabase cookies the request carried. */
  requestCookieNames: string[]
}

/** null when Supabase Auth is not configured. */
export function routeSupabase(req: Request): RouteSupabase | null {
  const config = loadConfig(serverEnv())
  if (!config.SUPABASE_URL || !config.SUPABASE_ANON_KEY) return null
  const jar = new Map<string, string>()
  for (const { name, value } of parseCookieHeader(req.headers.get('cookie') ?? '')) jar.set(name, value ?? '')
  const pending = new Map<string, { value: string; options: CookieOptions }>()
  const headers: Record<string, string> = {}
  const fetchImpl = supabaseFetch()
  const client = createServerClient(config.SUPABASE_URL, config.SUPABASE_ANON_KEY, {
    cookies: {
      getAll: () => [...jar].map(([name, value]) => ({ name, value })),
      setAll: (list, cacheHeaders) => {
        for (const { name, value, options } of list) {
          pending.set(name, { value, options })
          if (value) jar.set(name, value)
          else jar.delete(name)
        }
        Object.assign(headers, cacheHeaders ?? {})
      },
    },
    auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: true },
    ...(fetchImpl ? { global: { fetch: fetchImpl } } : {}),
  })
  return {
    client,
    requestCookieNames: [...jar.keys()].filter((n) => n.startsWith('sb-')),
    apply(res: Response): Response {
      for (const [name, { value, options }] of pending) {
        res.headers.append('set-cookie', serializeCookie(name, value, options as CookieAttributes))
      }
      for (const [k, v] of Object.entries(headers)) res.headers.set(k, v)
      return res
    },
  }
}
