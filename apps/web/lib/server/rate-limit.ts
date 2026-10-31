// In-memory fixed-window rate limits (per server instance; best effort on Vercel, where each
// instance keeps its own counters). Enough to blunt client-registration floods and token
// guessing; a shared limiter would need the database or a KV store.
//
// Limits are generous on purpose: Claude and ChatGPT reach us from a few shared egress IPs, so a
// per-IP limit counts many of our users together.

import { errorJson } from './http'

export const RATE_LIMITS = {
  /** POST /oauth/register per IP. */
  oauthRegister: { limit: 30, windowMs: 60_000 },
  /** POST /oauth/token per IP. */
  oauthToken: { limit: 300, windowMs: 60_000 },
  /** POST /oauth/revoke per IP. */
  oauthRevoke: { limit: 300, windowMs: 60_000 },
  /** /api/mcp per user. */
  mcp: { limit: 240, windowMs: 60_000 },
  /** POST /api/auth/magic-link per IP. */
  magicLink: { limit: 5, windowMs: 60_000 },
  /** POST /api/auth/dev-login per IP. */
  devLogin: { limit: 30, windowMs: 60_000 },
} as const

export type RateLimitName = keyof typeof RATE_LIMITS

export interface RateLimitResult {
  ok: boolean
  remaining: number
  retryAfterSec: number
}

const MAX_KEYS = 20_000
const KEY = Symbol.for('app.web.rateLimits')

type Windows = Map<string, { start: number; count: number }>

function windows(): Windows {
  const g = globalThis as typeof globalThis & { [KEY]?: Windows }
  g[KEY] ??= new Map()
  return g[KEY]
}

function prune(map: Windows, now: number): void {
  for (const [k, w] of map) {
    const name = k.slice(0, k.indexOf(':')) as RateLimitName
    const windowMs = RATE_LIMITS[name]?.windowMs ?? 60_000
    if (now - w.start >= windowMs) map.delete(k)
  }
  // Still too many live keys (a flood of distinct IPs): drop the oldest half.
  if (map.size > MAX_KEYS) {
    let drop = Math.floor(map.size / 2)
    for (const k of map.keys()) {
      if (drop-- <= 0) break
      map.delete(k)
    }
  }
}

/** Counts one hit for `key` under limit `name`. */
export function hitRateLimit(name: RateLimitName, key: string, now: number = Date.now()): RateLimitResult {
  const { limit, windowMs } = RATE_LIMITS[name]
  const map = windows()
  if (map.size > MAX_KEYS) prune(map, now)
  const id = `${name}:${key}`
  let w = map.get(id)
  if (!w || now - w.start >= windowMs) {
    w = { start: now, count: 0 }
    map.set(id, w)
  }
  w.count += 1
  const retryAfterSec = Math.max(1, Math.ceil((w.start + windowMs - now) / 1000))
  return { ok: w.count <= limit, remaining: Math.max(0, limit - w.count), retryAfterSec }
}

/** A 429 response with Retry-After. `body` defaults to our `{ error: { code, message } }` shape. */
export function tooManyRequests(result: RateLimitResult, body?: unknown, headers: Record<string, string> = {}): Response {
  const retry = { 'retry-after': String(result.retryAfterSec), ...headers }
  if (body !== undefined) {
    return new Response(JSON.stringify(body), {
      status: 429,
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...retry },
    })
  }
  return errorJson(429, 'rate_limited', 'Too many requests. Please wait a moment and try again.', retry)
}

/** Tests only: forget every counter. */
export function resetRateLimitsForTests(): void {
  windows().clear()
}
