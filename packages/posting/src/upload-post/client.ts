// Thin typed HTTP client for Upload-Post. Injected fetch (tests pass a mock), API key in the
// Authorization header only, every non-2xx mapped to a provider AppError (see ../errors.ts).
// Nothing here ever logs or throws the key, request headers or media URLs.

import type { Logger } from '@app/core/log'
import { providerError, safeProviderCode, safeProviderMessage, type ProviderErrorReason } from '../errors'
import { DEFAULT_TIMEOUT_MS, UPLOAD_POST_DEFAULT_BASE_URL, rewriteProviderText } from './constants'

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export interface UploadPostClientOptions {
  apiKey: string
  baseUrl?: string
  fetch?: FetchLike
  timeoutMs?: number
  logger?: Logger
  /** Milliseconds since the epoch (tests inject a clock). */
  now?: () => number
}

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE'

export interface RequestOptions {
  method: HttpMethod
  /** Path below the base URL, starting with "/api/". */
  path: string
  query?: Record<string, string | number | undefined>
  json?: unknown
  /** Multipart fields, in order (repeated keys allowed, e.g. "photos[]"). */
  form?: ReadonlyArray<readonly [string, string]>
  headers?: Record<string, string>
  /** Statuses returned to the caller instead of being mapped to errors (e.g. 404 on idempotent deletes). */
  passStatuses?: readonly number[]
}

export interface ClientResponse {
  status: number
  body: unknown
}

const PROVIDER = 'upload_post' as const
/** Ignore rate-limit resets further away than this (protects against misread headers). */
const MAX_LOCAL_BLOCK_MS = 15 * 60 * 1000
/** Default wait when the provider says "too many" without saying how long. */
const DEFAULT_RETRY_AFTER_SEC = 60
/** Default wait when an account's rolling-24h cap is full (the scheduler re-checks +1h). */
const DEFAULT_CAP_RETRY_AFTER_SEC = 3_600

type Json = Record<string, unknown>

function asRecord(value: unknown): Json | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : null
}

function normaliseBaseUrl(raw: string): string {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error('Upload-Post base URL is not a valid URL.')
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('Upload-Post base URL must be http(s).')
  if (url.username || url.password || url.search || url.hash) throw new Error('Upload-Post base URL must be a plain origin/path.')
  return url.toString().replace(/\/+$/, '')
}

export class UploadPostClient {
  readonly baseUrl: string
  private readonly apiKey: string
  private readonly fetchFn: FetchLike
  private readonly timeoutMs: number
  private readonly logger: Logger | undefined
  private readonly now: () => number
  private rate: { remaining: number; resetAtMs: number } | null = null

  constructor(options: UploadPostClientOptions) {
    if (typeof options.apiKey !== 'string' || options.apiKey.trim() === '') {
      throw new Error('UPLOAD_POST_API_KEY is required for the Upload-Post provider.')
    }
    this.apiKey = options.apiKey.trim()
    this.baseUrl = normaliseBaseUrl(options.baseUrl ?? UPLOAD_POST_DEFAULT_BASE_URL)
    this.fetchFn = options.fetch ?? ((input, init) => globalThis.fetch(input, init))
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.logger = options.logger
    this.now = options.now ?? Date.now
  }

  /** Safe version of a provider message (URLs, secrets and dashboard directions removed). */
  safeMessage(raw: unknown): string | null {
    return safeProviderMessage(raw, { secrets: [this.apiKey], rewrite: rewriteProviderText })
  }

  /** Last seen X-RateLimit state (for metrics / debugging). */
  rateLimitState(): { remaining: number; resetAt: string } | null {
    return this.rate ? { remaining: this.rate.remaining, resetAt: new Date(this.rate.resetAtMs).toISOString() } : null
  }

  async request(options: RequestOptions): Promise<ClientResponse> {
    this.checkLocalRateLimit()

    const url = new URL(this.baseUrl + options.path)
    for (const [k, v] of Object.entries(options.query ?? {})) {
      if (v !== undefined) url.searchParams.set(k, String(v))
    }

    const headers: Record<string, string> = {
      Accept: 'application/json',
      ...options.headers,
      Authorization: `Apikey ${this.apiKey}`,
    }
    let body: RequestInit['body']
    if (options.form) {
      const form = new FormData()
      for (const [k, v] of options.form) form.append(k, v)
      body = form
    } else if (options.json !== undefined) {
      headers['Content-Type'] = 'application/json'
      body = JSON.stringify(options.json)
    }

    const started = this.now()
    let res: Response
    try {
      res = await this.fetchFn(url.toString(), {
        method: options.method,
        headers,
        body,
        signal: AbortSignal.timeout(this.timeoutMs),
        redirect: 'error',
      })
    } catch (err) {
      const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')
      this.logger?.warn('upload_post.network_error', {
        method: options.method,
        path: options.path,
        error: err instanceof Error ? err.name : 'unknown',
      })
      throw providerError(
        'provider_unavailable',
        timedOut ? 'The posting service did not answer in time. Please try again shortly.' : 'Could not reach the posting service. Please try again shortly.',
        { provider: PROVIDER },
      )
    }

    this.recordRateLimit(res.headers)
    const parsed = await readBody(res)
    this.logger?.debug('upload_post.response', {
      method: options.method,
      path: options.path,
      status: res.status,
      ms: this.now() - started,
    })

    if (options.passStatuses?.includes(res.status)) return { status: res.status, body: parsed.json }

    if (res.status >= 200 && res.status < 300) {
      if (!parsed.ok) {
        throw providerError('provider_unavailable', 'The posting service returned an unreadable response. Please try again shortly.', {
          provider: PROVIDER,
          status: res.status,
          providerCode: 'invalid_response',
        })
      }
      const record = asRecord(parsed.json)
      if (record && record.success === false) {
        throw this.mapError(400, record, res.headers, res.status)
      }
      return { status: res.status, body: parsed.json }
    }

    const error = this.mapError(res.status, asRecord(parsed.json) ?? {}, res.headers)
    this.logger?.warn('upload_post.error', {
      method: options.method,
      path: options.path,
      status: res.status,
      reason: error.details?.reason,
      providerCode: error.details?.providerCode,
    })
    throw error
  }

  /** Maps a non-2xx (or a 2xx with success:false) to a provider AppError. Exported for tests via the class. */
  mapError(status: number, body: Json, headers: Headers, reportedStatus = status) {
    const rawMessage = body.message ?? body.error ?? body.detail
    const message = this.safeMessage(rawMessage)
    const providerCode = safeProviderCode(body.error_code ?? body.code ?? body.error_type)
    const base = { provider: PROVIDER, status: reportedStatus, ...(providerCode ? { providerCode } : {}) }
    const make = (reason: ProviderErrorReason, msg: string, extra: { retryAfterSec?: number } = {}) =>
      providerError(reason, msg, { ...base, ...extra })

    if (status === 401) {
      return make('provider_auth', 'The posting service refused our credentials. We are on it; please try again later.')
    }
    if (status === 403) {
      if (providerCode === 'post_not_owned') {
        return make('provider_rejected', 'That post does not belong to a connected account.')
      }
      if (providerCode === 'PROFILE_LIMIT_REACHED' || providerCode === 'PROFILE_BLOCKED') {
        return make('provider_auth', 'The posting service cannot take more brands right now. We are on it; please try again later.')
      }
      return make('provider_auth', 'The posting service refused this request for our account. We are on it; please try again later.')
    }
    if (status === 404) {
      return make('not_found', message ? `Not found at the posting service: ${message}` : 'Not found at the posting service.')
    }
    if (status === 409) {
      const inUse = providerCode === 'IDEMPOTENCY_KEY_IN_USE'
      return make(
        'conflict',
        inUse ? 'This post is already being sent. Please check again in a few seconds.' : (message ?? 'The posting service reported a conflict.'),
        inUse ? { retryAfterSec: 5 } : {},
      )
    }
    if (status === 429) {
      const violations = Array.isArray(body.violations) ? body.violations.map(asRecord).filter((v): v is Json => v !== null) : []
      const cap = violations.find((v) => v.type === 'hard_cap')
      if (cap) {
        const capMessage = this.safeMessage(cap.message)
        return make('cap_reached', capMessage ? `Daily posting limit reached: ${capMessage}` : 'This account reached its daily posting limit.', {
          retryAfterSec: retryAfterFrom(headers, body, this.now(), DEFAULT_CAP_RETRY_AFTER_SEC),
        })
      }
      if (violations.length > 0) {
        const first = this.safeMessage(violations[0]?.message) ?? message
        return make('provider_rejected', first ? `The posting service rejected the post: ${first}` : 'The posting service rejected the post.')
      }
      return make('rate_limited', 'The posting service is busy. Please try again shortly.', {
        retryAfterSec: retryAfterFrom(headers, body, this.now(), DEFAULT_RETRY_AFTER_SEC),
      })
    }
    if (status >= 400 && status < 500) {
      return make('provider_rejected', message ? `The posting service rejected the request: ${message}` : 'The posting service rejected the request.')
    }
    // 5xx (whose messages carry technical details) and anything unexpected
    return make('provider_unavailable', 'The posting service is having trouble. Please try again shortly.')
  }

  private checkLocalRateLimit(): void {
    if (!this.rate) return
    const now = this.now()
    if (this.rate.remaining > 0 || now >= this.rate.resetAtMs) return
    throw providerError('rate_limited', 'The posting service is busy. Please try again shortly.', {
      provider: PROVIDER,
      retryAfterSec: Math.max(1, Math.ceil((this.rate.resetAtMs - now) / 1000)),
    })
  }

  private recordRateLimit(headers: Headers): void {
    const remaining = Number(headers.get('x-ratelimit-remaining') ?? NaN)
    const reset = Number(headers.get('x-ratelimit-reset') ?? NaN)
    if (!Number.isFinite(remaining) || !Number.isFinite(reset)) return
    const resetAtMs = reset < 1e12 ? reset * 1000 : reset
    const now = this.now()
    if (resetAtMs - now > MAX_LOCAL_BLOCK_MS) {
      this.rate = null
      return
    }
    this.rate = { remaining, resetAtMs }
  }
}

async function readBody(res: Response): Promise<{ ok: boolean; json: unknown }> {
  let text: string
  try {
    text = await res.text()
  } catch {
    return { ok: false, json: null }
  }
  if (text.trim() === '') return { ok: true, json: null }
  try {
    return { ok: true, json: JSON.parse(text) as unknown }
  } catch {
    return { ok: false, json: null }
  }
}

/** Seconds to wait: Retry-After (seconds or HTTP date), body.retry_after, X-RateLimit-Reset, else `fallback`. */
export function retryAfterFrom(headers: Headers, body: Json, nowMs: number, fallback: number): number {
  const clamp = (n: number) => Math.min(86_400, Math.max(1, Math.ceil(n)))
  const header = headers.get('retry-after')
  if (header) {
    if (/^\d+(\.\d+)?$/.test(header.trim())) return clamp(Number(header))
    const at = Date.parse(header)
    if (Number.isFinite(at)) return clamp((at - nowMs) / 1000)
  }
  const fromBody = typeof body.retry_after === 'string' ? Number(body.retry_after) : body.retry_after
  if (typeof fromBody === 'number' && Number.isFinite(fromBody) && fromBody > 0) return clamp(fromBody)
  const reset = Number(headers.get('x-ratelimit-reset') ?? NaN)
  if (Number.isFinite(reset)) {
    const resetMs = reset < 1e12 ? reset * 1000 : reset
    if (resetMs > nowMs) return clamp((resetMs - nowMs) / 1000)
  }
  return fallback
}
