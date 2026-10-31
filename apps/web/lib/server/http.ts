// Small HTTP helpers shared by the route handlers: JSON responses, error mapping (AppError →
// status + neutral message), bounded body reading, same-origin checks for cookie-authenticated
// POSTs, safe "next" redirects, client IP and CORS. Server-only.

import { AppError, toErrorBody } from '@app/core/errors'
import type { Logger } from '@app/core/log'

export const NO_STORE = { 'cache-control': 'no-store' } as const

/** A JSON response (no-store by default: our API answers are per user). */
export function json(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json; charset=utf-8', ...NO_STORE, ...init.headers },
  })
}

/**
 * Maps any error to a JSON error response: AppError → its status and neutral message (details
 * included, never secrets); anything else → 500 with a generic message, logged (redacted).
 */
export function errorResponse(error: unknown, log?: Logger, headers: Record<string, string> = {}): Response {
  const { status, body } = toErrorBody(error)
  if (status >= 500 && log) {
    log.error('request failed', error instanceof Error ? error : { error: String(error) })
  }
  return json(body, { status, headers })
}

/** `{ error: { code, message } }` for errors raised by the web layer itself. */
export function errorJson(status: number, code: string, message: string, headers: Record<string, string> = {}): Response {
  return json({ error: { code, message } }, { status, headers })
}

export const tooLarge = () => errorJson(413, 'bad_request', 'The request body is too large.')

/**
 * Reads the body as text, refusing more than `maxBytes` (declared or actual). Returns null when
 * the body is too large.
 */
export async function readBodyText(req: Request, maxBytes: number): Promise<string | null> {
  const declared = Number(req.headers.get('content-length') ?? Number.NaN)
  if (Number.isFinite(declared) && declared > maxBytes) return null
  if (!req.body) return ''
  const reader = req.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined)
      return null
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

export type ParsedBody =
  | { ok: true; kind: 'json' | 'form'; data: Record<string, unknown> }
  | { ok: false; response: Response }

function mediaType(req: Request): string {
  return (req.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? ''
}

/** True when the request body is an HTML form post (answer with redirects instead of JSON). */
export function isFormPost(req: Request): boolean {
  const t = mediaType(req)
  return t === 'application/x-www-form-urlencoded' || t === 'multipart/form-data'
}

/**
 * Parses a JSON object or an application/x-www-form-urlencoded body (single values; a repeated
 * form key keeps its first value). Anything else → 415; malformed → 400; too large → 413.
 */
export async function readBody(req: Request, maxBytes: number, accept: { json?: boolean; form?: boolean } = { json: true, form: true }): Promise<ParsedBody> {
  const type = mediaType(req)
  const isJson = type === 'application/json' || type.endsWith('+json')
  const isForm = type === 'application/x-www-form-urlencoded'
  if ((isJson && accept.json === false) || (isForm && accept.form === false) || (!isJson && !isForm)) {
    return { ok: false, response: errorJson(415, 'bad_request', 'Unsupported content type.') }
  }
  const text = await readBodyText(req, maxBytes)
  if (text === null) return { ok: false, response: tooLarge() }
  if (isForm) {
    const data: Record<string, unknown> = {}
    for (const [k, v] of new URLSearchParams(text)) if (!(k in data)) data[k] = v
    return { ok: true, kind: 'form', data }
  }
  if (text.trim() === '') return { ok: true, kind: 'json', data: {} }
  try {
    const parsed: unknown = JSON.parse(text)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, response: errorJson(400, 'bad_request', 'The request body must be a JSON object.') }
    }
    return { ok: true, kind: 'json', data: parsed as Record<string, unknown> }
  } catch {
    return { ok: false, response: errorJson(400, 'bad_request', 'The request body is not valid JSON.') }
  }
}

/**
 * CSRF guard for cookie-authenticated POSTs: the Origin (or, without it, Sec-Fetch-Site) must
 * be our own. Requests without either header (curl, server-to-server) are allowed: they carry no
 * ambient browser cookies of a victim.
 */
export function isSameOrigin(req: Request, appUrl: string): boolean {
  const origin = req.headers.get('origin')
  if (origin) {
    if (origin === 'null') return false
    const allowed = new Set<string>()
    try {
      allowed.add(new URL(appUrl).origin)
      allowed.add(new URL(req.url).origin)
    } catch {
      return false
    }
    return allowed.has(origin)
  }
  const site = req.headers.get('sec-fetch-site')
  return site === null || site === 'same-origin' || site === 'none'
}

export const crossOrigin = () => errorJson(403, 'forbidden', 'Cross-site requests are not allowed.')

/**
 * A safe post-login destination: a same-site relative path ("/app/..."), never "//host",
 * "/\\host", a scheme or control characters. Anything else → `fallback`.
 */
export function safeNext(raw: unknown, fallback = '/app'): string {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 2048) return fallback
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\') || /[\u0000-\u001f\u007f]/.test(raw)) return fallback
  try {
    const base = 'http://next.invalid'
    const url = new URL(raw, base)
    if (url.origin !== base) return fallback
    return `${url.pathname}${url.search}${url.hash}`
  } catch {
    return fallback
  }
}

/** The client IP for rate limiting (Vercel sets x-forwarded-for / x-real-ip). */
export function clientIp(req: Request): string {
  const forwarded = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
  const ip = forwarded || req.headers.get('x-real-ip')?.trim() || 'unknown'
  return ip.slice(0, 64)
}

/** Copies a response with extra headers (responses from other code may have immutable headers). */
export function withHeaders(res: Response, headers: Record<string, string>): Response {
  if (Object.keys(headers).length === 0) return res
  const merged = new Headers(res.headers)
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === 'vary' && merged.has('vary')) merged.set('vary', `${merged.get('vary')}, ${v}`)
    else merged.set(k, v)
  }
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: merged })
}

/**
 * CORS for public, cookie-less OAuth endpoints (metadata, registration, token, revocation):
 * browser-based MCP clients (e.g. MCP Inspector) call them cross-origin. No credentials.
 */
export const PUBLIC_CORS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'authorization, content-type, mcp-protocol-version',
  'access-control-max-age': '86400',
}

export function preflight(headers: Record<string, string> = PUBLIC_CORS): Response {
  return new Response(null, { status: 204, headers })
}

/** 303 See Other to a same-site path or an absolute URL. */
export function seeOther(location: string, headers: Record<string, string> = {}): Response {
  return new Response(null, { status: 303, headers: { location, ...NO_STORE, ...headers } })
}

/** The runtime failed to start (configuration or database): a neutral 503. */
export function unavailable(): Response {
  return errorJson(503, 'unavailable', 'The service is temporarily unavailable. Please try again in a minute.')
}

export function isAppErrorCode(error: unknown, code: AppError['code']): boolean {
  return error instanceof AppError && error.code === code
}
