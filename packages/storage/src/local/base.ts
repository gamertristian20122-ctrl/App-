// Shared behaviour of the local drivers (FsStorage, MemoryStorage): signed URLs, input checks and the
// multipart rules, so both behave like R2 from the caller's point of view.

import type { Clock, ObjectHead, ObjectStorage, PresignedPut } from '@app/core/ports'
import { storageError } from '../errors'
import {
  checkCompletedParts,
  checkPartNumber,
  checkUploadId,
  MIN_PART_BYTES,
  type CompletedPart,
  type MultipartStorage,
} from '../multipart'
import { checkContentType, checkKey, checkPutBytes, checkTtl, DEFAULT_PUT_TTL_SEC } from '../validate'
import { LocalUrlSigner } from './signing'

export interface LocalStorageOptions {
  /** Absolute URL where createLocalStorageHandler is mounted, e.g. http://localhost:3000/api/dev-storage. */
  baseUrl: string
  /** HMAC key for the signed URLs; every process that signs or serves them needs the same value (≥ 16 chars). */
  signingSecret: string
  clock?: Clock
  /** Lifetime of presigned PUT URLs (default 3600 s). */
  putTtlSec?: number
  /** Minimum size of every multipart part but the last (default 5 MiB, as on S3/R2). Tests may lower it. */
  minPartBytes?: number
}

/** A readable object, as the HTTP handler needs it. */
export interface LocalObject {
  bytes: number
  contentType: string
  /** Body bytes [start, end). */
  read(start: number, end: number): AsyncIterable<Uint8Array>
}

/** What createLocalStorageHandler needs from a driver. */
export interface LocalBackend {
  readonly signer: LocalUrlSigner
  /** Stores a presigned PUT body; rejects bodies that are not exactly `bytes` long. */
  receivePut(key: string, contentType: string, body: AsyncIterable<Uint8Array>, bytes: number): Promise<{ etag: string }>
  /** Stores one multipart part; rejects bodies that are not exactly `bytes` long. */
  receivePart(
    key: string,
    uploadId: string,
    partNumber: number,
    body: AsyncIterable<Uint8Array>,
    bytes: number,
  ): Promise<{ etag: string }>
  openObject(key: string): Promise<LocalObject | null>
}

export interface StoredPart {
  partNumber: number
  bytes: number
  etag: string
}

export abstract class LocalStorageBase implements ObjectStorage, MultipartStorage, LocalBackend {
  abstract readonly driver: 'fs' | 'memory'
  readonly signer: LocalUrlSigner
  protected readonly putTtlSec: number
  protected readonly minPartBytes: number

  constructor(options: LocalStorageOptions) {
    this.signer = new LocalUrlSigner({ baseUrl: options.baseUrl, secret: options.signingSecret, clock: options.clock })
    this.putTtlSec = checkTtl(options.putTtlSec ?? DEFAULT_PUT_TTL_SEC)
    this.minPartBytes = options.minPartBytes ?? MIN_PART_BYTES
    if (!Number.isSafeInteger(this.minPartBytes) || this.minPartBytes < 1) {
      throw storageError('invalid_input', 'minPartBytes must be a positive integer.')
    }
  }

  // --- ObjectStorage ----------------------------------------------------------

  async presignPut(key: string, contentType: string, maxBytes: number): Promise<PresignedPut> {
    const k = checkKey(key)
    const ct = checkContentType(contentType)
    const bytes = checkPutBytes(maxBytes)
    return {
      url: this.signer.sign({ op: 'put', key: k, contentType: ct, bytes }, this.putTtlSec),
      headers: { 'Content-Type': ct },
    }
  }

  async presignGet(key: string, ttlSec: number): Promise<string> {
    return this.signer.sign({ op: 'get', key: checkKey(key) }, checkTtl(ttlSec))
  }

  abstract putFile(key: string, path: string, contentType: string): Promise<void>
  abstract putBytes(key: string, bytes: Uint8Array, contentType: string): Promise<void>
  abstract getToFile(key: string, path: string): Promise<void>
  abstract head(key: string): Promise<ObjectHead | null>
  abstract delete(key: string): Promise<void>

  // --- MultipartStorage ---------------------------------------------------------

  async createMultipartUpload(key: string, contentType: string): Promise<{ uploadId: string }> {
    return this.mpuCreate(checkKey(key), checkContentType(contentType))
  }

  async presignUploadPart(
    key: string,
    uploadId: string,
    partNumber: number,
    bytes: number,
    ttlSec: number = this.putTtlSec,
  ): Promise<PresignedPut> {
    const k = checkKey(key)
    const uid = checkUploadId(uploadId)
    const pn = checkPartNumber(partNumber)
    const len = checkPutBytes(bytes)
    return { url: this.signer.sign({ op: 'part', key: k, uploadId: uid, partNumber: pn, bytes: len }, checkTtl(ttlSec)), headers: {} }
  }

  async completeMultipartUpload(key: string, uploadId: string, parts: CompletedPart[]): Promise<void> {
    const k = checkKey(key)
    const uid = checkUploadId(uploadId)
    const wanted = checkCompletedParts(parts)
    const upload = await this.mpuGet(k, uid)
    if (!upload) throw storageError('not_found', 'This upload does not exist or has already been completed.')
    const stored = new Map(upload.parts.map((p) => [p.partNumber, p]))
    const chosen: StoredPart[] = []
    for (const p of wanted) {
      const s = stored.get(p.partNumber)
      if (!s || s.etag !== p.etag) {
        throw storageError('invalid_input', `Part ${p.partNumber} is missing or its ETag does not match.`)
      }
      chosen.push(s)
    }
    // R2 rule: every part except the last has the same size, at least the minimum part size.
    const first = chosen[0] as StoredPart
    for (let i = 0; i < chosen.length - 1; i++) {
      const p = chosen[i] as StoredPart
      if (p.bytes < this.minPartBytes || p.bytes !== first.bytes) {
        throw storageError('invalid_input', 'All parts except the last must have the same size (at least 5 MiB).')
      }
    }
    if ((chosen[chosen.length - 1] as StoredPart).bytes > first.bytes) {
      throw storageError('invalid_input', 'The last part may not be larger than the others.')
    }
    await this.mpuComplete(k, uid, upload.contentType, chosen)
  }

  async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    await this.mpuAbort(checkKey(key), checkUploadId(uploadId))
  }

  // --- LocalBackend (used by the HTTP handler; key/grant already verified) --------

  abstract receivePut(key: string, contentType: string, body: AsyncIterable<Uint8Array>, bytes: number): Promise<{ etag: string }>
  abstract receivePart(
    key: string,
    uploadId: string,
    partNumber: number,
    body: AsyncIterable<Uint8Array>,
    bytes: number,
  ): Promise<{ etag: string }>
  abstract openObject(key: string): Promise<LocalObject | null>

  // --- driver primitives -----------------------------------------------------------

  protected abstract mpuCreate(key: string, contentType: string): Promise<{ uploadId: string }>
  protected abstract mpuGet(key: string, uploadId: string): Promise<{ contentType: string; parts: StoredPart[] } | null>
  protected abstract mpuComplete(key: string, uploadId: string, contentType: string, parts: StoredPart[]): Promise<void>
  protected abstract mpuAbort(key: string, uploadId: string): Promise<void>
}

/** Collects at most `exact` bytes and fails unless the body is exactly that long. */
export async function collectExact(body: AsyncIterable<Uint8Array>, exact: number): Promise<Uint8Array> {
  const chunks: Uint8Array[] = []
  let total = 0
  for await (const chunk of body) {
    total += chunk.byteLength
    if (total > exact) throw lengthMismatch()
    chunks.push(chunk)
  }
  if (total !== exact) throw lengthMismatch()
  const out = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) {
    out.set(c, offset)
    offset += c.byteLength
  }
  return out
}

export function lengthMismatch() {
  return storageError('invalid_input', 'The upload is not the size that was declared.')
}
