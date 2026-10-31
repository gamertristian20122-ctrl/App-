// Test helpers: a recording fetch mock (no network, ever) and fixtures.

import { fixedClock } from '@app/core/testing'
import { UploadPostProvider, type UploadPostProviderOptions } from '../src/upload-post'

export const API_KEY = 'up_live_SECRET_key_0123456789abcdef'
export const BASE = 'https://api.upload-post.com'
export const NOW = '2026-10-31T12:00:00.000Z'

export interface RecordedRequest {
  url: URL
  method: string
  headers: Headers
  /** Parsed JSON body (JSON requests). */
  json: unknown
  /** Multipart body (form requests). */
  form: FormData | null
}

export interface MockReply {
  status?: number
  json?: unknown
  text?: string
  headers?: Record<string, string>
}

export type Responder = (req: RecordedRequest) => MockReply | Response | Error | Promise<MockReply | Response | Error>

export function mockFetch(handler: Responder | Array<MockReply | Response | Error>) {
  const calls: RecordedRequest[] = []
  const queue = Array.isArray(handler) ? [...handler] : null
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url)
    const headers = new Headers(init?.headers as Record<string, string> | undefined)
    const body = init?.body
    const req: RecordedRequest = {
      url,
      method: init?.method ?? 'GET',
      headers,
      json: typeof body === 'string' ? (JSON.parse(body) as unknown) : null,
      form: body instanceof FormData ? body : null,
    }
    calls.push(req)
    const reply = queue ? queue.shift() : await (handler as Responder)(req)
    if (reply === undefined) throw new Error(`mockFetch: no reply queued for ${req.method} ${url.pathname}`)
    if (reply instanceof Error) throw reply
    if (reply instanceof Response) return reply
    const text = reply.text ?? (reply.json === undefined ? '' : JSON.stringify(reply.json))
    return new Response(text === '' && (reply.status === 204 || reply.status === 304) ? null : text, {
      status: reply.status ?? 200,
      headers: { 'content-type': 'application/json', ...reply.headers },
    })
  }
  return { fetch, calls, last: () => calls[calls.length - 1] as RecordedRequest }
}

export function makeProvider(
  handler: Responder | Array<MockReply | Response | Error>,
  options: Partial<UploadPostProviderOptions> = {},
) {
  const m = mockFetch(handler)
  const provider = new UploadPostProvider({ apiKey: API_KEY, fetch: m.fetch, clock: fixedClock(NOW), ...options })
  return { provider, ...m }
}

/** Form fields as [key, value] pairs (string values only). */
export function formEntries(form: FormData | null): Array<[string, string]> {
  if (!form) return []
  const out: Array<[string, string]> = []
  form.forEach((v, k) => out.push([k, typeof v === 'string' ? v : '[file]']))
  return out
}

export function formObject(form: FormData | null): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {}
  for (const [k, v] of formEntries(form)) {
    const prev = out[k]
    if (prev === undefined) out[k] = v
    else out[k] = Array.isArray(prev) ? [...prev, v] : [prev, v]
  }
  return out
}

/** Everything an error could leak through: message, details, stack, cause, JSON. */
export function errorText(err: unknown): string {
  if (!(err instanceof Error)) return String(err)
  const parts = [err.message, err.stack ?? '', JSON.stringify(err), String((err as { cause?: unknown }).cause ?? '')]
  const details = (err as { details?: unknown }).details
  if (details !== undefined) parts.push(JSON.stringify(details))
  return parts.join('\n')
}

export async function catchError(p: Promise<unknown>): Promise<Error> {
  try {
    await p
  } catch (err) {
    return err as Error
  }
  throw new Error('expected the promise to reject')
}

export const MEDIA = 'https://media.example-r2.dev/brand/abc.mp4?X-Amz-Signature=deadbeef'
export const IMG1 = 'https://media.example-r2.dev/brand/1.jpg?X-Amz-Signature=aaa'
export const IMG2 = 'https://media.example-r2.dev/brand/2.jpg?X-Amz-Signature=bbb'
