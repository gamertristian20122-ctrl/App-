// Supabase session refresh + security headers for the consent/approval pages (Next.js 16 "proxy",
// formerly middleware.ts; it runs on the Node.js runtime). The logic is in
// lib/server/edge-session.ts, which stays Edge-safe. Machine endpoints (/api/mcp, /oauth/token,
// webhooks, crons) are excluded by the matcher and again in code.

import type { NextRequest } from 'next/server'
import { handleEdgeRequest } from '@/lib/server/edge-session'

export function proxy(request: NextRequest) {
  return handleEdgeRequest(request, {
    supabaseUrl: process.env.SUPABASE_URL,
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY,
  })
}

export const config = {
  matcher: [
    '/((?!api/mcp|api/stripe/webhook|api/webhooks/|api/cron/|api/dev-storage/|oauth/token|oauth/register|oauth/revoke|\\.well-known/|auth/callback|_next/static|_next/image|favicon\\.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)',
  ],
}
