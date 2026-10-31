// Who is signed in.
// - Production: Supabase Auth (magic link) via @supabase/ssr cookies, when SUPABASE_URL is set.
// - Development/tests: DEV_AUTH=1 enables an email-only login. The session is an HMAC-signed cookie
//   (SESSION_SECRET) holding the email; the user id is a deterministic UUID derived from it.
// Server-only module (uses node:crypto through @app/core).

import { type EnvSource, hmacSha256, loadConfig, safeEqual, uuidV5 } from '@app/core'
import { createServerClient, parseCookieHeader } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'

export interface CurrentUser {
  id: string
  email: string
}

export const DEV_SESSION_COOKIE = 'dev_session'
export const DEV_SESSION_TTL_SEC = 30 * 24 * 60 * 60

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

export function isValidEmail(email: string): boolean {
  const e = normalizeEmail(email)
  return e.length <= 254 && EMAIL_RE.test(e)
}

/** The stable user id for a dev-login email. */
export function devUserId(email: string): string {
  return uuidV5(`dev-user:${normalizeEmail(email)}`)
}

/** Signed cookie value "<payload>.<hmac>" where payload = base64url({ email, exp }). */
export function signDevSession(
  email: string,
  secret: string,
  now: Date = new Date(),
  ttlSec: number = DEV_SESSION_TTL_SEC,
): string {
  if (!isValidEmail(email)) throw new Error('Invalid email address.')
  const payload = Buffer.from(
    JSON.stringify({ email: normalizeEmail(email), exp: Math.floor(now.getTime() / 1000) + ttlSec }),
    'utf8',
  ).toString('base64url')
  return `${payload}.${hmacSha256(secret, payload).toString('base64url')}`
}

/** Returns the user for a valid, unexpired dev session cookie; otherwise null. */
export function verifyDevSession(
  value: string | null | undefined,
  secret: string,
  now: Date = new Date(),
): CurrentUser | null {
  if (!value || value.length > 2048) return null
  const dot = value.lastIndexOf('.')
  if (dot <= 0) return null
  const payload = value.slice(0, dot)
  const sig = value.slice(dot + 1)
  if (!safeEqual(sig, hmacSha256(secret, payload).toString('base64url'))) return null
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { email?: unknown; exp?: unknown }
    if (typeof data.email !== 'string' || typeof data.exp !== 'number') return null
    if (data.exp * 1000 <= now.getTime() || !isValidEmail(data.email)) return null
    return { id: devUserId(data.email), email: normalizeEmail(data.email) }
  } catch {
    return null
  }
}

export interface SessionCookie {
  name: string
  value: string
  options: { httpOnly: true; sameSite: 'lax'; secure: boolean; path: '/'; maxAge: number }
}

/** The cookie a dev-login route should set. Throws unless DEV_AUTH is on. */
export function createDevSessionCookie(email: string, env: EnvSource = process.env, now: Date = new Date()): SessionCookie {
  const config = loadConfig(env)
  if (!config.DEV_AUTH || !config.SESSION_SECRET) throw new Error('Dev login is disabled.')
  return {
    name: DEV_SESSION_COOKIE,
    value: signDevSession(email, config.SESSION_SECRET, now),
    options: {
      httpOnly: true,
      sameSite: 'lax',
      secure: config.APP_URL.startsWith('https://'),
      path: '/',
      maxAge: DEV_SESSION_TTL_SEC,
    },
  }
}

interface CookieJar {
  getAll(): { name: string; value: string }[]
  setAll?(cookies: { name: string; value: string; options: Record<string, unknown> }[]): void
}

export interface AuthDeps {
  env?: EnvSource
  /** fetch used by the Supabase client (tests inject a mock). */
  fetch?: typeof fetch
  now?: Date
}

async function resolveUser(jar: CookieJar, deps: AuthDeps): Promise<CurrentUser | null> {
  const config = loadConfig(deps.env ?? process.env)
  const all = jar.getAll()
  if (config.DEV_AUTH && config.SESSION_SECRET) {
    const dev = verifyDevSession(all.find((c) => c.name === DEV_SESSION_COOKIE)?.value, config.SESSION_SECRET, deps.now)
    if (dev) return dev
  }
  if (!config.SUPABASE_URL || !config.SUPABASE_ANON_KEY) return null
  // Skip the network round-trip when there is no Supabase session cookie at all.
  if (!all.some((c) => c.name.startsWith('sb-'))) return null
  const supabase = createServerClient(config.SUPABASE_URL, config.SUPABASE_ANON_KEY, {
    cookies: {
      getAll: () => all,
      setAll: (list) => {
        try {
          jar.setAll?.(list.map(({ name, value, options }) => ({ name, value, options: { ...options } })))
        } catch {
          // Server Components cannot set cookies; the session is refreshed on the next route/handler call.
        }
      },
    },
    auth: { persistSession: true, autoRefreshToken: false, detectSessionInUrl: false },
    ...(deps.fetch ? { global: { fetch: deps.fetch } } : {}),
  })
  const { data, error } = await supabase.auth.getUser()
  if (error || !data.user || !data.user.email) return null
  return { id: data.user.id, email: normalizeEmail(data.user.email) }
}

/** The signed-in user in a Server Component, Server Action or Route Handler; null when signed out. */
export async function getCurrentUser(deps: AuthDeps = {}): Promise<CurrentUser | null> {
  const store = await cookies()
  return resolveUser(
    {
      getAll: () => store.getAll().map(({ name, value }) => ({ name, value })),
      setAll: (list) => {
        for (const { name, value, options } of list) store.set(name, value, options)
      },
    },
    deps,
  )
}

/** Like getCurrentUser() but redirects to /login when signed out. */
export async function requireUser(deps: AuthDeps = {}): Promise<CurrentUser> {
  const user = await getCurrentUser(deps)
  if (!user) redirect('/login')
  return user
}

/** The signed-in user for a plain Request (route handlers, tests). Never sets cookies. */
export async function getUserFromRequest(req: Request, deps: AuthDeps = {}): Promise<CurrentUser | null> {
  const header = req.headers.get('cookie') ?? ''
  const parsed = header ? parseCookieHeader(header).map(({ name, value }) => ({ name, value: value ?? '' })) : []
  return resolveUser({ getAll: () => parsed }, deps)
}
