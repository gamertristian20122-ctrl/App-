// Supabase session refresh + security headers for the consent/approval pages. The logic is in
// lib/server/edge-session.ts (Edge-safe). Next.js 16 calls this convention "proxy"; middleware.ts
// still works (Edge runtime). Machine endpoints (/api/mcp, /oauth/token, webhooks, crons) are
// excluded by the matcher and again in code.

import type { NextRequest } from 'next/server'
import { handleEdgeRequest } from '@/lib/server/edge-session'

export function middleware(request: NextRequest) {
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
