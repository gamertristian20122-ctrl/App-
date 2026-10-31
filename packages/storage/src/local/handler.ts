// HTTP handler for the local drivers' signed URLs (the dev stand-in for R2's presigned URLs).
// Framework-agnostic: (Request) => Promise<Response>. The web app mounts it at /api/dev-storage/[...key]
// for GET, HEAD and PUT, only when STORAGE_DRIVER is fs or memory.
//
//   GET/HEAD  op=get    → 200 with the bytes (single "Range: bytes=" ranges → 206), 404 when missing
//   PUT       op=put    → 200 + ETag; Content-Type must equal the signed type, the body must be exactly
//                         the signed length (as with R2, where both headers are part of the signature)
//   PUT       op=part   → 200 + ETag; body exactly the signed length
// Errors: 400 malformed URL/body, 403 bad signature or wrong Content-Type, 403 expired (like S3),
// 404 unknown object/upload, 405 wrong method for the URL, 500 anything else. Bodies are short plain text.

import { Readable } from 'node:stream'
import type { ReadableStream as NodeReadableStream } from 'node:stream/web'
import type { Logger } from '@app/core/log'
import { isAppError } from '@app/core/errors'
import { storageErrorReason } from '../errors'
import type { LocalBackend, LocalObject } from './base'

export interface LocalStorageHandlerOptions {
  logger?: Logger
}

function text(status: number, body: string, headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', ...headers } })
}

/** Parses a single "bytes=a-b" range; null = whole object, 'invalid' = unsatisfiable. */
export function parseRange(header: string | null, size: number): { start: number; end: number } | null | 'invalid' {
  if (!header) return null
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!m || (m[1] === '' && m[2] === '')) return null // multi-range or junk: serve everything (allowed by RFC 9110)
  if (m[1] === '') {
    const suffix = Number(m[2])
    if (suffix === 0) return 'invalid'
    return { start: Math.max(0, size - suffix), end: size }
  }
  const start = Number(m[1])
  const last = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1)
  if (start >= size || last < start) return 'invalid'
  return { start, end: last + 1 }
}

function toWebStream(obj: LocalObject, start: number, end: number): ReadableStream<Uint8Array> {
  return Readable.toWeb(Readable.from(obj.read(start, end))) as unknown as ReadableStream<Uint8Array>
}

function bodyIterable(request: Request): AsyncIterable<Uint8Array> {
  if (!request.body) return (async function* () {})()
  return Readable.fromWeb(request.body as unknown as NodeReadableStream<Uint8Array>)
}

export function createLocalStorageHandler(
  backend: LocalBackend,
  options: LocalStorageHandlerOptions = {},
): (request: Request) => Promise<Response> {
  const logger = options.logger
  return async (request: Request): Promise<Response> => {
    let url: URL
    try {
      url = new URL(request.url)
    } catch {
      return text(400, 'Bad request.')
    }
    const verified = backend.signer.verify(url)
    if (!verified.ok) {
      if (verified.failure === 'bad_request') return text(400, 'Malformed storage URL.')
      if (verified.failure === 'expired') return text(403, 'This link has expired.')
      return text(403, 'Invalid signature.')
    }
    const { grant } = verified
    const method = request.method.toUpperCase()

    try {
      if (grant.op === 'get') {
        if (method !== 'GET' && method !== 'HEAD') return text(405, 'Method not allowed.', { allow: 'GET, HEAD' })
        const obj = await backend.openObject(grant.key)
        if (!obj) return text(404, 'Not found.')
        const range = parseRange(request.headers.get('range'), obj.bytes)
        if (range === 'invalid') return text(416, 'Range not satisfiable.', { 'content-range': `bytes */${obj.bytes}` })
        const { start, end } = range ?? { start: 0, end: obj.bytes }
        const headers: Record<string, string> = {
          'content-type': obj.contentType,
          'content-length': String(end - start),
          'accept-ranges': 'bytes',
          'cache-control': 'private, max-age=0, no-store',
        }
        if (range) headers['content-range'] = `bytes ${start}-${end - 1}/${obj.bytes}`
        const status = range ? 206 : 200
        if (method === 'HEAD') return new Response(null, { status, headers })
        return new Response(toWebStream(obj, start, end), { status, headers })
      }

      if (method !== 'PUT') return text(405, 'Method not allowed.', { allow: 'PUT' })
      const bytes = grant.bytes
      if (bytes === undefined) return text(400, 'Malformed storage URL.')
      const declared = request.headers.get('content-length')
      if (declared !== null && declared.trim() !== String(bytes)) return text(403, 'Content-Length does not match the signed size.')

      if (grant.op === 'put') {
        const ct = (request.headers.get('content-type') ?? '').trim().toLowerCase()
        if (!grant.contentType || ct !== grant.contentType) return text(403, 'Content-Type does not match the signed type.')
        const { etag } = await backend.receivePut(grant.key, grant.contentType, bodyIterable(request), bytes)
        return new Response(null, { status: 200, headers: { etag: `"${etag}"` } })
      }

      if (grant.uploadId === undefined || grant.partNumber === undefined) return text(400, 'Malformed storage URL.')
      const { etag } = await backend.receivePart(grant.key, grant.uploadId, grant.partNumber, bodyIterable(request), bytes)
      return new Response(null, { status: 200, headers: { etag: `"${etag}"` } })
    } catch (err) {
      const reason = storageErrorReason(err)
      if (reason === 'not_found') return text(404, 'Not found.')
      if (reason === 'invalid_input' || reason === 'invalid_key' || reason === 'too_large') {
        return text(400, isAppError(err) ? err.message : 'Bad request.')
      }
      logger?.error('local storage request failed', { op: grant.op, err: err instanceof Error ? err : String(err) })
      return text(500, 'Storage error.')
    }
  }
}
