// Input checks shared by every driver (callers are our own services, but a bad value must fail loudly
// and identically in dev, tests and production).

import { z } from 'zod'
import { storageError } from './errors'
import { assertValidKey } from './keys'

/**
 * Largest object one PUT may carry. Cloudflare R2 documents 5 GiB for a single-part upload with a
 * footnote of 4.995 GiB; we stay below both at 5 GB (10^9). Larger files go through multipart
 * (putFile does this automatically; browser uploads use the multipart presign methods).
 */
export const MAX_SINGLE_PUT_BYTES = 5_000_000_000

/** SigV4 presigned URLs live at most 7 days (R2 and S3). */
export const MAX_PRESIGN_TTL_SEC = 7 * 24 * 3600

/** Default lifetime of a presigned PUT: long enough to start a slow upload (the signature is checked when the request starts). */
export const DEFAULT_PUT_TTL_SEC = 3600

/** A bare MIME type (no parameters), lower-cased. */
export const ContentTypeSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(127)
  .regex(/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/, 'Invalid content type.')

export function checkKey(key: unknown): string {
  return assertValidKey(key)
}

export function checkContentType(contentType: unknown): string {
  const r = ContentTypeSchema.safeParse(contentType)
  if (!r.success) throw storageError('invalid_input', 'Content type must be a MIME type such as video/mp4.')
  return r.data
}

/** Exact byte count of a presigned single PUT (1 … MAX_SINGLE_PUT_BYTES). */
export function checkPutBytes(bytes: unknown): number {
  if (typeof bytes !== 'number' || !Number.isSafeInteger(bytes) || bytes < 1) {
    throw storageError('invalid_input', 'Upload size must be a positive whole number of bytes.')
  }
  if (bytes > MAX_SINGLE_PUT_BYTES) {
    throw storageError('too_large', 'Files over 5 GB must be uploaded in parts (multipart upload).')
  }
  return bytes
}

export function checkTtl(ttlSec: unknown): number {
  if (typeof ttlSec !== 'number' || !Number.isInteger(ttlSec) || ttlSec < 1 || ttlSec > MAX_PRESIGN_TTL_SEC) {
    throw storageError('invalid_input', `Link lifetime must be 1–${MAX_PRESIGN_TTL_SEC} seconds.`)
  }
  return ttlSec
}

export function checkBytesValue(bytes: unknown): Uint8Array {
  if (!(bytes instanceof Uint8Array)) throw storageError('invalid_input', 'Object body must be bytes.')
  return bytes
}

export function checkLocalPath(path: unknown): string {
  if (typeof path !== 'string' || path.length === 0 || path.includes('\0')) {
    throw storageError('invalid_input', 'A local file path is required.')
  }
  return path
}
