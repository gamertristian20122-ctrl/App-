// Proxy (formerly middleware) logic, kept Edge-safe (imports only next/server and @supabase/ssr, never @app/*):
// - refreshes an expiring Supabase session once per navigation and writes the rotated cookies to
//   both the downstream request and the response (Server Components cannot set cookies);
// - adds anti-framing / no-referrer headers to the consent and approval pages;
// - never touches the MCP endpoint, the OAuth token/registration endpoints, webhooks or crons.

import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'

/** Paths the middleware leaves alone (machine-to-machine endpoints and assets). */
export const SKIP_PREFIXES = [
  '/api/mcp',
  '/api/stripe/webhook',
  '/api/webhooks/',
  '/api/cron/',
  '/api/dev-storage/',
  '/oauth/token',
  '/oauth/register',
  '/oauth/revoke',
  '/.well-known/',
  '/auth/callback',
  '/_next/',
] as const

export function shouldSkip(pathname: string): boolean {
  return SKIP_PREFIXES.some((p) => pathname.startsWith(p))
}

/** Pages that carry one-time tokens or grant access: never framed, never send a Referer. */
export function isSensitivePage(pathname: string): boolean {
  return pathname === '/oauth/authorize' || pathname.startsWith('/approve/')
}

const SECURITY_HEADERS: Record<string, string> = {
  'x-frame-options': 'DENY',
  'content-security-policy': "frame-ancestors 'none'",
  'referrer-policy': 'no-referrer',
}

export interface EdgeSessionDeps {
  supabaseUrl?: string | undefined
  supabaseAnonKey?: string | undefined
  fetch?: typeof fetch
}

export async function handleEdgeRequest(request: NextRequest, deps: EdgeSessionDeps = {}): Promise<NextResponse> {
  const { pathname } = request.nextUrl
  if (shouldSkip(pathname)) return NextResponse.next()

  let response = NextResponse.next({ request })
  const hasSession = request.cookies.getAll().some((c) => c.name.startsWith('sb-'))
  if (deps.supabaseUrl && deps.supabaseAnonKey && hasSession) {
    const supabase = createServerClient(deps.supabaseUrl, deps.supabaseAnonKey, {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll: (cookies, headers) => {
          for (const { name, value } of cookies) request.cookies.set(name, value)
          response = NextResponse.next({ request })
          for (const { name, value, options } of cookies) response.cookies.set(name, value, options)
          for (const [k, v] of Object.entries(headers ?? {})) response.headers.set(k, v)
        },
      },
      ...(deps.fetch ? { global: { fetch: deps.fetch } } : {}),
    })
    try {
      // Refreshes the session when the access token expired; verifies it otherwise.
      await supabase.auth.getClaims()
    } catch {
      // Treated as signed out downstream.
    }
  }
  if (isSensitivePage(pathname)) {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) response.headers.set(k, v)
  }
  return response
}
