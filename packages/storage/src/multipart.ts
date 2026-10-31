// Multipart uploads: needed above the single-PUT limit (sources may be up to 10 GB).
// R2 requires every part except the last to have the same size, so planParts() always produces
// uniform parts. Parts are uploaded with presigned PUTs (browser) or by putFile (worker); the
// uploader keeps each part's ETag response header and sends them to completeMultipartUpload.

import { z } from 'zod'
import type { PresignedPut } from '@app/core/ports'
import { storageError } from './errors'

/** S3 minimum for every part but the last. */
export const MIN_PART_BYTES = 5 * 1024 * 1024
/** Default part size: 10 GB → ~300 parts. */
export const DEFAULT_PART_BYTES = 32 * 1024 * 1024
export const MAX_PARTS = 10_000
/** Sanity cap for one multipart object (ARCHITECTURE caps sources at 10 GB). */
export const MAX_MULTIPART_BYTES = 50_000_000_000

export interface PartPlan {
  partNumber: number
  /** Inclusive start offset. */
  start: number
  /** Exclusive end offset. */
  end: number
  bytes: number
}

/** Splits `totalBytes` into uniform parts (the last may be shorter). Grows the part size if needed to stay within MAX_PARTS. */
export function planParts(totalBytes: number, partBytes: number = DEFAULT_PART_BYTES): PartPlan[] {
  if (!Number.isSafeInteger(totalBytes) || totalBytes < 1 || totalBytes > MAX_MULTIPART_BYTES) {
    throw storageError('invalid_input', 'Multipart uploads need a size between 1 byte and 50 GB.')
  }
  if (!Number.isSafeInteger(partBytes) || partBytes < MIN_PART_BYTES) {
    throw storageError('invalid_input', 'Parts must be at least 5 MiB.')
  }
  const size = Math.max(partBytes, Math.ceil(totalBytes / MAX_PARTS))
  const parts: PartPlan[] = []
  for (let start = 0, n = 1; start < totalBytes; start += size, n++) {
    const end = Math.min(totalBytes, start + size)
    parts.push({ partNumber: n, start, end, bytes: end - start })
  }
  return parts
}

export interface CompletedPart {
  partNumber: number
  /** The ETag response header of the part's PUT (quotes optional). */
  etag: string
}

/** Optional capability: R2, FsStorage and MemoryStorage all implement it. */
export interface MultipartStorage {
  createMultipartUpload(key: string, contentType: string): Promise<{ uploadId: string }>
  /** A presigned PUT for one part; the body must be exactly `bytes` long. Default TTL 1 hour. */
  presignUploadPart(key: string, uploadId: string, partNumber: number, bytes: number, ttlSec?: number): Promise<PresignedPut>
  completeMultipartUpload(key: string, uploadId: string, parts: CompletedPart[]): Promise<void>
  /** Idempotent: aborting an unknown upload is not an error. */
  abortMultipartUpload(key: string, uploadId: string): Promise<void>
}

export function supportsMultipart<T extends object>(storage: T): storage is T & MultipartStorage {
  const s = storage as Partial<MultipartStorage>
  return (
    typeof s.createMultipartUpload === 'function' &&
    typeof s.presignUploadPart === 'function' &&
    typeof s.completeMultipartUpload === 'function' &&
    typeof s.abortMultipartUpload === 'function'
  )
}

export const UploadIdSchema = z
  .string()
  .min(1)
  .max(1024)
  .regex(/^[A-Za-z0-9._~+/=-]+$/, 'Invalid upload id.')

export const PartNumberSchema = z.number().int().min(1).max(MAX_PARTS)

export const CompletedPartsSchema = z
  .array(
    z.strictObject({
      partNumber: PartNumberSchema,
      etag: z
        .string()
        .trim()
        .min(1)
        .max(256)
        .regex(/^(?:W\/)?"?[A-Za-z0-9._~+/=-]+"?$/, 'Invalid ETag.'),
    }),
  )
  .min(1)
  .max(MAX_PARTS)
  .superRefine((parts, ctx) => {
    for (let i = 1; i < parts.length; i++) {
      if ((parts[i] as CompletedPart).partNumber <= (parts[i - 1] as CompletedPart).partNumber) {
        ctx.addIssue({ code: 'custom', message: 'Parts must be listed in ascending order without duplicates.' })
        return
      }
    }
  })

export function checkUploadId(uploadId: unknown): string {
  const r = UploadIdSchema.safeParse(uploadId)
  if (!r.success) throw storageError('invalid_input', 'Invalid multipart upload id.')
  return r.data
}

export function checkPartNumber(partNumber: unknown): number {
  const r = PartNumberSchema.safeParse(partNumber)
  if (!r.success) throw storageError('invalid_input', `Part numbers must be 1–${MAX_PARTS}.`)
  return r.data
}

/** Validates the part list (it usually comes from a browser) and strips quotes from ETags. */
export function checkCompletedParts(parts: unknown): CompletedPart[] {
  const r = CompletedPartsSchema.safeParse(parts)
  if (!r.success) {
    throw storageError('invalid_input', r.error.issues[0]?.message ?? 'Invalid part list.')
  }
  return r.data.map((p) => ({ partNumber: p.partNumber, etag: normalizeEtag(p.etag) }))
}

export function normalizeEtag(etag: string): string {
  return etag.trim().replace(/^W\//, '').replace(/^"|"$/g, '')
}
