// Signed URLs for the local drivers (FsStorage, MemoryStorage). They mimic presigned R2 URLs closely
// enough that the upload/download code paths behave the same in dev and tests: an expiry, a signed
// content type, a signed exact length, HMAC-SHA256 over every parameter.
//
// URL contract (served by createLocalStorageHandler, mounted e.g. at /api/dev-storage/[...key]):
//   {baseUrl}/{key}?op=get&exp={unixSec}&sig={hex}
//   {baseUrl}/{key}?op=put&exp={unixSec}&ct={contentType}&len={bytes}&sig={hex}
//   {baseUrl}/{key}?op=part&exp={unixSec}&uid={uploadId}&pn={partNumber}&len={bytes}&sig={hex}
// sig = hex(HMAC-SHA256(secret, "v1\n" + op + "\n" + key + "\n" + exp + "\n" + ct + "\n" + len + "\n" + uid + "\n" + pn))
// with empty strings for absent fields.

import { z } from 'zod'
import { hmacSha256Hex, safeEqual } from '@app/core/crypto'
import type { Clock } from '@app/core/ports'
import { systemClock } from '@app/core/time'
import { storageError } from '../errors'
import { assertValidKey } from '../keys'

export const LOCAL_OPS = ['get', 'put', 'part'] as const
export type LocalOp = (typeof LOCAL_OPS)[number]

export interface LocalGrant {
  op: LocalOp
  key: string
  /** Expiry, unix seconds. */
  exp: number
  contentType?: string
  bytes?: number
  uploadId?: string
  partNumber?: number
}

export interface LocalSignerOptions {
  /** Absolute URL that serves the handler, without a trailing slash (e.g. http://localhost:3000/api/dev-storage). */
  baseUrl: string
  /** HMAC key shared by every process that signs or verifies (web + worker). At least 16 characters. */
  secret: string
  clock?: Clock
}

const QuerySchema = z.strictObject({
  op: z.enum(LOCAL_OPS),
  exp: z.string().regex(/^\d{1,12}$/).transform(Number),
  ct: z.string().max(127).optional(),
  len: z
    .string()
    .regex(/^\d{1,15}$/)
    .transform(Number)
    .optional(),
  uid: z.string().max(1024).optional(),
  pn: z
    .string()
    .regex(/^\d{1,5}$/)
    .transform(Number)
    .optional(),
  sig: z.string().regex(/^[0-9a-f]{64}$/),
})

export type VerifyFailure = 'bad_request' | 'forbidden' | 'expired'

export class LocalUrlSigner {
  readonly baseUrl: string
  readonly basePath: string
  private readonly secret: string
  private readonly clock: Clock

  constructor(options: LocalSignerOptions) {
    let url: URL
    try {
      url = new URL(options.baseUrl)
    } catch {
      throw storageError('invalid_input', 'Local storage base URL must be an absolute URL.')
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw storageError('invalid_input', 'Local storage base URL must be http(s).')
    }
    if (typeof options.secret !== 'string' || options.secret.length < 16) {
      throw storageError('invalid_input', 'Local storage signing secret must be at least 16 characters.')
    }
    url.search = ''
    url.hash = ''
    this.baseUrl = url.toString().replace(/\/+$/, '')
    this.basePath = url.pathname.replace(/\/+$/, '')
    this.secret = options.secret
    this.clock = options.clock ?? systemClock
  }

  nowSec(): number {
    return Math.floor(this.clock.now().getTime() / 1000)
  }

  private signature(g: LocalGrant): string {
    const canonical = [
      'v1',
      g.op,
      g.key,
      String(g.exp),
      g.contentType ?? '',
      g.bytes === undefined ? '' : String(g.bytes),
      g.uploadId ?? '',
      g.partNumber === undefined ? '' : String(g.partNumber),
    ].join('\n')
    return hmacSha256Hex(this.secret, canonical)
  }

  /** A signed URL for `grant` (valid for `ttlSec` from now). */
  sign(grant: Omit<LocalGrant, 'exp'>, ttlSec: number): string {
    const g: LocalGrant = { ...grant, exp: this.nowSec() + ttlSec }
    const params = new URLSearchParams()
    params.set('op', g.op)
    params.set('exp', String(g.exp))
    if (g.contentType !== undefined) params.set('ct', g.contentType)
    if (g.bytes !== undefined) params.set('len', String(g.bytes))
    if (g.uploadId !== undefined) params.set('uid', g.uploadId)
    if (g.partNumber !== undefined) params.set('pn', String(g.partNumber))
    params.set('sig', this.signature(g))
    const path = g.key.split('/').map(encodeURIComponent).join('/')
    return `${this.baseUrl}/${path}?${params.toString()}`
  }

  /** The key addressed by `url`, or null when the path is outside the base path or not a valid key. */
  keyFromUrl(url: URL): string | null {
    const prefix = `${this.basePath}/`
    if (!url.pathname.startsWith(prefix)) return null
    let key: string
    try {
      key = url.pathname.slice(prefix.length).split('/').map(decodeURIComponent).join('/')
    } catch {
      return null
    }
    try {
      return assertValidKey(key)
    } catch {
      return null
    }
  }

  /** Checks a request URL's signature and expiry. */
  verify(url: URL): { ok: true; grant: LocalGrant } | { ok: false; failure: VerifyFailure } {
    const key = this.keyFromUrl(url)
    if (!key) return { ok: false, failure: 'bad_request' }
    const raw: Record<string, string> = {}
    for (const [k, v] of url.searchParams) {
      if (k in raw) return { ok: false, failure: 'bad_request' }
      raw[k] = v
    }
    const q = QuerySchema.safeParse(raw)
    if (!q.success) return { ok: false, failure: 'bad_request' }
    const grant: LocalGrant = { op: q.data.op, key, exp: q.data.exp }
    if (q.data.ct !== undefined) grant.contentType = q.data.ct
    if (q.data.len !== undefined) grant.bytes = q.data.len
    if (q.data.uid !== undefined) grant.uploadId = q.data.uid
    if (q.data.pn !== undefined) grant.partNumber = q.data.pn
    if (!safeEqual(this.signature(grant), q.data.sig)) return { ok: false, failure: 'forbidden' }
    if (grant.exp < this.nowSec()) return { ok: false, failure: 'expired' }
    return { ok: true, grant }
  }
}
