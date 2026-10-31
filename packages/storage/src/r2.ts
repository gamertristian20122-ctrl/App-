// R2Storage: ObjectStorage on Cloudflare R2 through its S3-compatible API.
//
// - Endpoint https://<accountId>.r2.cloudflarestorage.com (or R2_ENDPOINT), region "auto", path-style.
// - Checksums only WHEN_REQUIRED: newer SDKs otherwise add x-amz-checksum-crc32 (of an empty body) to
//   presigned PUT URLs, which breaks browser uploads.
// - Presigned PUT signs Content-Type AND Content-Length (the SDK leaves Content-Type unsigned by default),
//   so R2 rejects an upload of another type or size with 403 SignatureDoesNotMatch. S3/R2 presigned PUTs
//   cannot express "at most N bytes" (R2 has no POST policy), so the signed length is exact: pass the
//   declared file size as maxBytes, and HEAD the object after upload.
// - putFile switches to multipart above `multipartThresholdBytes` (sources may be up to 10 GB; one PUT
//   is limited to ~5 GB on R2), with uniform parts as R2 requires.
// - Errors become AppError with details.reason (see errors.ts). SDK errors are never attached whole:
//   they carry raw responses.

import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, rename, rm, stat } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import { Readable } from 'node:stream'
import type { ReadableStream as NodeReadableStream } from 'node:stream/web'
import { pipeline } from 'node:stream/promises'
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CopyObjectCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetBucketCorsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutBucketCorsCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
  UploadPartCopyCommand,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import type { Logger } from '@app/core/log'
import type { ObjectHead, ObjectStorage, PresignedPut } from '@app/core/ports'
import { checkCorsRules, type BucketAdmin, type CorsRule } from './bucket'
import { storageError } from './errors'
import {
  checkCompletedParts,
  checkPartNumber,
  checkUploadId,
  DEFAULT_PART_BYTES,
  MIN_PART_BYTES,
  planParts,
  type CompletedPart,
  type MultipartStorage,
  type PartPlan,
} from './multipart'
import {
  checkBytesValue,
  checkContentType,
  checkKey,
  checkLocalPath,
  checkPutBytes,
  checkTtl,
  DEFAULT_PUT_TTL_SEC,
  MAX_SINGLE_PUT_BYTES,
} from './validate'

export interface R2StorageConfig {
  /** Cloudflare account id; used to build the endpoint when `endpoint` is not given. */
  accountId?: string
  /** Override, e.g. https://<accountId>.eu.r2.cloudflarestorage.com for EU jurisdiction buckets. */
  endpoint?: string
  accessKeyId: string
  secretAccessKey: string
  bucket: string
  /** Lifetime of presigned PUT URLs (default 3600 s). */
  putTtlSec?: number
  /** putFile uses multipart above this size (default 100 MiB). */
  multipartThresholdBytes?: number
  /** Part size for putFile's multipart uploads (default 32 MiB). */
  partBytes?: number
  /** Parts uploaded in parallel by putFile (default 4). */
  partConcurrency?: number
}

/** The slice of S3Client that R2Storage uses (tests pass `{ send: vi.fn() }`). */
export interface S3Like {
  send(command: unknown): Promise<unknown>
}

export type Presigner = (
  command: PutObjectCommand | GetObjectCommand | UploadPartCommand,
  options: { expiresIn: number; signableHeaders?: Set<string> },
) => Promise<string>

export interface R2StorageDeps {
  /** Sends every non-presign request. Default: a real S3Client built from the config. */
  client?: S3Like
  /** Presigns URLs (local computation, no network). Default: getSignedUrl with a real S3Client. */
  presign?: Presigner
  logger?: Logger
}

export const DEFAULT_MULTIPART_THRESHOLD_BYTES = 100 * 1024 * 1024

export function r2Endpoint(config: Pick<R2StorageConfig, 'accountId' | 'endpoint'>): string {
  if (config.endpoint) {
    let url: URL
    try {
      url = new URL(config.endpoint)
    } catch {
      throw storageError('invalid_input', 'R2 endpoint must be an absolute https URL.')
    }
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && /^(localhost|127\.0\.0\.1)$/.test(url.hostname))) {
      throw storageError('invalid_input', 'R2 endpoint must be an absolute https URL.')
    }
    return url.toString().replace(/\/+$/, '')
  }
  const id = config.accountId?.trim() ?? ''
  if (!/^[A-Za-z0-9]{1,64}$/.test(id)) throw storageError('invalid_input', 'R2 account id is missing or invalid.')
  return `https://${id}.r2.cloudflarestorage.com`
}

/** Builds the S3Client R2Storage uses by default. */
export function createR2Client(config: R2StorageConfig): S3Client {
  return new S3Client({
    region: 'auto',
    endpoint: r2Endpoint(config),
    forcePathStyle: true,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
    maxAttempts: 3,
  })
}

interface S3ErrorShape {
  name?: unknown
  Code?: unknown
  $metadata?: { httpStatusCode?: unknown }
}

const NOT_FOUND_NAMES = new Set(['NotFound', 'NoSuchKey', 'NoSuchUpload', 'NoSuchBucket'])
const AUTH_NAMES = new Set(['AccessDenied', 'InvalidAccessKeyId', 'SignatureDoesNotMatch', 'Unauthorized', 'Forbidden', 'CredentialsProviderError'])
const INPUT_NAMES = new Set(['InvalidPart', 'InvalidPartOrder', 'EntityTooSmall', 'InvalidArgument', 'InvalidRequest', 'BadDigest', 'IncompleteBody'])

/** Maps an S3/R2 SDK error to AppError without leaking the raw response. */
export function mapS3Error(err: unknown, what: string) {
  const e = (err ?? {}) as S3ErrorShape
  const name = typeof e.name === 'string' ? e.name : typeof e.Code === 'string' ? e.Code : 'Error'
  const status = typeof e.$metadata?.httpStatusCode === 'number' ? e.$metadata.httpStatusCode : undefined
  const cause = new Error(`${name}${status === undefined ? '' : ` (HTTP ${status})`}`)
  if (NOT_FOUND_NAMES.has(name) || status === 404) {
    return storageError('not_found', `${what}: not found in storage.`, { status, cause })
  }
  if (AUTH_NAMES.has(name) || status === 401 || status === 403) {
    return storageError('storage_auth', 'Storage refused our credentials. Please try again later.', { status, cause })
  }
  if (name === 'EntityTooLarge') return storageError('too_large', `${what}: the file is too large.`, { status, cause })
  if (INPUT_NAMES.has(name)) return storageError('invalid_input', `${what}: storage rejected the request (${name}).`, { status, cause })
  return storageError('storage_unavailable', 'Storage is temporarily unavailable. Please try again in a minute.', { status, cause })
}

function toNodeReadable(body: unknown): Readable {
  if (body instanceof Readable) return body
  if (body instanceof Uint8Array || typeof body === 'string') return Readable.from([body])
  const b = body as { transformToWebStream?: () => unknown; getReader?: unknown } | null
  if (b && typeof b.getReader === 'function') return Readable.fromWeb(b as NodeReadableStream<Uint8Array>)
  if (b && typeof b.transformToWebStream === 'function') {
    return Readable.fromWeb(b.transformToWebStream() as NodeReadableStream<Uint8Array>)
  }
  if (b && Symbol.asyncIterator in (b as object)) return Readable.from(b as AsyncIterable<Uint8Array>)
  throw storageError('storage_unavailable', 'Storage returned an unreadable response.')
}

export class R2Storage implements ObjectStorage, MultipartStorage, BucketAdmin {
  readonly driver = 'r2' as const
  readonly bucket: string
  private readonly client: S3Like
  private readonly presigner: Presigner
  private readonly logger: Logger | undefined
  private readonly putTtlSec: number
  private readonly threshold: number
  private readonly partBytes: number
  private readonly concurrency: number

  constructor(config: R2StorageConfig, deps: R2StorageDeps = {}) {
    if (!config.bucket || !/^[a-z0-9][a-z0-9.-]{1,62}$/.test(config.bucket)) {
      throw storageError('invalid_input', 'R2 bucket name is missing or invalid.')
    }
    if (!config.accessKeyId || !config.secretAccessKey) {
      throw storageError('invalid_input', 'R2 access key id and secret are required.')
    }
    this.bucket = config.bucket
    let real: S3Client | undefined
    const getReal = () => (real ??= createR2Client(config))
    r2Endpoint(config) // validate eagerly
    this.client = deps.client ?? getReal()
    this.presigner =
      deps.presign ?? ((command, options) => getSignedUrl(getReal(), command as PutObjectCommand, options))
    this.logger = deps.logger
    this.putTtlSec = checkTtl(config.putTtlSec ?? DEFAULT_PUT_TTL_SEC)
    this.partBytes = Math.max(MIN_PART_BYTES, config.partBytes ?? DEFAULT_PART_BYTES)
    this.threshold = Math.min(MAX_SINGLE_PUT_BYTES, Math.max(1, config.multipartThresholdBytes ?? DEFAULT_MULTIPART_THRESHOLD_BYTES))
    this.concurrency = Math.min(16, Math.max(1, Math.floor(config.partConcurrency ?? 4)))
  }

  private async send<T>(command: unknown, what: string): Promise<T> {
    try {
      return (await this.client.send(command)) as T
    } catch (err) {
      throw mapS3Error(err, what)
    }
  }

  // --- presigning -------------------------------------------------------------

  async presignPut(key: string, contentType: string, maxBytes: number): Promise<PresignedPut> {
    const k = checkKey(key)
    const ct = checkContentType(contentType)
    const bytes = checkPutBytes(maxBytes)
    const command = new PutObjectCommand({ Bucket: this.bucket, Key: k, ContentType: ct, ContentLength: bytes })
    const url = await this.presigner(command, {
      expiresIn: this.putTtlSec,
      signableHeaders: new Set(['content-type', 'content-length']),
    })
    return { url, headers: { 'Content-Type': ct } }
  }

  async presignGet(key: string, ttlSec: number): Promise<string> {
    const command = new GetObjectCommand({ Bucket: this.bucket, Key: checkKey(key) })
    return this.presigner(command, { expiresIn: checkTtl(ttlSec) })
  }

  // --- object operations ---------------------------------------------------------

  async putBytes(key: string, bytes: Uint8Array, contentType: string): Promise<void> {
    const k = checkKey(key)
    const ct = checkContentType(contentType)
    const body = checkBytesValue(bytes)
    if (body.byteLength > MAX_SINGLE_PUT_BYTES) throw storageError('too_large', 'Use putFile for files over 5 GB.')
    await this.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: k, Body: body, ContentType: ct, ContentLength: body.byteLength }),
      'Upload',
    )
  }

  async putFile(key: string, path: string, contentType: string): Promise<void> {
    const k = checkKey(key)
    const ct = checkContentType(contentType)
    const source = checkLocalPath(path)
    let size: number
    try {
      const s = await stat(source)
      if (!s.isFile()) throw new Error('not a file')
      size = s.size
    } catch {
      throw storageError('invalid_input', 'The local file could not be read.')
    }
    if (size <= this.threshold) {
      await this.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: k,
          Body: size === 0 ? new Uint8Array(0) : createReadStream(source),
          ContentType: ct,
          ContentLength: size,
        }),
        'Upload',
      )
      return
    }
    await this.putFileMultipart(k, source, size, ct)
  }

  private async putFileMultipart(key: string, source: string, size: number, contentType: string): Promise<void> {
    const { uploadId } = await this.createMultipartUpload(key, contentType)
    try {
      const plan = planParts(size, this.partBytes)
      const done: CompletedPart[] = []
      let next = 0
      let failed = false
      const worker = async () => {
        while (!failed && next < plan.length) {
          const part = plan[next++] as PartPlan
          const out = await this.send<{ ETag?: string }>(
            new UploadPartCommand({
              Bucket: this.bucket,
              Key: key,
              UploadId: uploadId,
              PartNumber: part.partNumber,
              Body: createReadStream(source, { start: part.start, end: part.end - 1 }),
              ContentLength: part.bytes,
            }),
            'Upload part',
          )
          if (!out?.ETag) throw storageError('storage_unavailable', 'Storage did not confirm an uploaded part.')
          done.push({ partNumber: part.partNumber, etag: out.ETag })
        }
      }
      await Promise.all(
        Array.from({ length: Math.min(this.concurrency, plan.length) }, () =>
          worker().catch((err: unknown) => {
            failed = true // the other workers stop taking parts
            throw err
          }),
        ),
      )
      done.sort((a, b) => a.partNumber - b.partNumber)
      await this.completeMultipartUpload(key, uploadId, done)
    } catch (err) {
      await this.abortMultipartUpload(key, uploadId).catch((abortErr: unknown) => {
        this.logger?.warn('r2 multipart abort failed', { key, err: abortErr instanceof Error ? abortErr.message : 'unknown' })
      })
      throw err
    }
  }

  async getToFile(key: string, path: string): Promise<void> {
    const k = checkKey(key)
    const target = resolve(checkLocalPath(path))
    const out = await this.send<{ Body?: unknown }>(new GetObjectCommand({ Bucket: this.bucket, Key: k }), 'Download')
    if (!out?.Body) throw storageError('storage_unavailable', 'Storage returned an empty response.')
    await mkdir(dirname(target), { recursive: true })
    const tmp = `${target}.part-${randomBytes(6).toString('hex')}`
    try {
      await pipeline(toNodeReadable(out.Body), createWriteStream(tmp))
      await rename(tmp, target)
    } catch (err) {
      await rm(tmp, { force: true })
      // Local file-system errors (ENOSPC, EACCES…) are ours, not the storage service's.
      const code = (err as { code?: unknown } | null)?.code
      if (typeof code === 'string' && /^E[A-Z]+$/.test(code) && code !== 'ECONNRESET' && code !== 'ETIMEDOUT') throw err
      throw storageError('storage_unavailable', 'The download from storage was interrupted.', {
        cause: new Error(err instanceof Error ? err.name : 'Error'),
      })
    }
  }

  async head(key: string): Promise<ObjectHead | null> {
    const k = checkKey(key)
    try {
      const out = (await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: k }))) as {
        ContentLength?: number
        ContentType?: string
      }
      return { bytes: out?.ContentLength ?? 0, contentType: out?.ContentType ?? 'application/octet-stream' }
    } catch (err) {
      const mapped = mapS3Error(err, 'Lookup')
      if (mapped.code === 'not_found') return null
      throw mapped
    }
  }

  async delete(key: string): Promise<void> {
    const k = checkKey(key)
    try {
      await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: k }))
    } catch (err) {
      const mapped = mapS3Error(err, 'Delete')
      if (mapped.code !== 'not_found') throw mapped
    }
  }

  /**
   * Server-side copy: CopyObject up to 5 GB, UploadPartCopy (multipart) above. No bytes pass
   * through this process (the worker promotes a 10 GB upload without re-uploading it).
   */
  async copy(fromKey: string, toKey: string): Promise<void> {
    const from = checkKey(fromKey)
    const to = checkKey(toKey)
    if (from === to) return
    const head = await this.head(from)
    if (!head) throw storageError('not_found', 'The object to copy does not exist.')
    const copySource = `${this.bucket}/${from.split('/').map(encodeURIComponent).join('/')}`
    if (head.bytes <= MAX_SINGLE_PUT_BYTES) {
      await this.send(
        new CopyObjectCommand({ Bucket: this.bucket, Key: to, CopySource: copySource, ContentType: head.contentType, MetadataDirective: 'REPLACE' }),
        'Copy',
      )
      return
    }
    const { uploadId } = await this.createMultipartUpload(to, head.contentType)
    try {
      // copy parts can be up to 5 GB; 1 GiB parts keep the request count low
      const plan = planParts(head.bytes, Math.max(this.partBytes, 1024 * 1024 * 1024))
      const done: CompletedPart[] = []
      for (const part of plan) {
        const out = await this.send<{ CopyPartResult?: { ETag?: string } }>(
          new UploadPartCopyCommand({
            Bucket: this.bucket,
            Key: to,
            UploadId: uploadId,
            PartNumber: part.partNumber,
            CopySource: copySource,
            CopySourceRange: `bytes=${part.start}-${part.end - 1}`,
          }),
          'Copy part',
        )
        const etag = out?.CopyPartResult?.ETag
        if (!etag) throw storageError('storage_unavailable', 'Storage did not confirm a copied part.')
        done.push({ partNumber: part.partNumber, etag })
      }
      await this.completeMultipartUpload(to, uploadId, done)
    } catch (err) {
      await this.abortMultipartUpload(to, uploadId).catch(() => undefined)
      throw err
    }
  }

  // --- bucket checks (/setup) -------------------------------------------------------
  // A bucket-scoped "Object Read & Write" R2 token may be refused the CORS calls (they need
  // "Admin Read & Write"); callers report that as storage_auth and show the manual steps.

  async headBucket(): Promise<void> {
    await this.send(new HeadBucketCommand({ Bucket: this.bucket }), 'Bucket')
  }

  async getBucketCors(): Promise<CorsRule[]> {
    let out: { CORSRules?: Array<Record<string, unknown>> }
    try {
      out = (await this.client.send(new GetBucketCorsCommand({ Bucket: this.bucket }))) as typeof out
    } catch (err) {
      const e = (err ?? {}) as S3ErrorShape
      const name = typeof e.name === 'string' ? e.name : typeof e.Code === 'string' ? e.Code : ''
      if (name === 'NoSuchCORSConfiguration') return []
      throw mapS3Error(err, 'Bucket CORS')
    }
    const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
    return (out?.CORSRules ?? []).map((r) => ({
      allowedOrigins: strings(r.AllowedOrigins),
      allowedMethods: strings(r.AllowedMethods),
      allowedHeaders: strings(r.AllowedHeaders),
      exposeHeaders: strings(r.ExposeHeaders),
      ...(typeof r.MaxAgeSeconds === 'number' ? { maxAgeSeconds: r.MaxAgeSeconds } : {}),
    }))
  }

  async putBucketCors(rules: CorsRule[]): Promise<void> {
    const checked = checkCorsRules(rules)
    await this.send(
      new PutBucketCorsCommand({
        Bucket: this.bucket,
        CORSConfiguration: {
          CORSRules: checked.map((r) => ({
            AllowedOrigins: r.allowedOrigins,
            AllowedMethods: r.allowedMethods,
            AllowedHeaders: r.allowedHeaders,
            ExposeHeaders: r.exposeHeaders,
            ...(r.maxAgeSeconds !== undefined ? { MaxAgeSeconds: r.maxAgeSeconds } : {}),
          })),
        },
      }),
      'Bucket CORS',
    )
  }

  // --- multipart --------------------------------------------------------------------

  async createMultipartUpload(key: string, contentType: string): Promise<{ uploadId: string }> {
    const out = await this.send<{ UploadId?: string }>(
      new CreateMultipartUploadCommand({ Bucket: this.bucket, Key: checkKey(key), ContentType: checkContentType(contentType) }),
      'Upload',
    )
    if (!out?.UploadId) throw storageError('storage_unavailable', 'Storage did not start the upload.')
    return { uploadId: out.UploadId }
  }

  async presignUploadPart(
    key: string,
    uploadId: string,
    partNumber: number,
    bytes: number,
    ttlSec: number = this.putTtlSec,
  ): Promise<PresignedPut> {
    const command = new UploadPartCommand({
      Bucket: this.bucket,
      Key: checkKey(key),
      UploadId: checkUploadId(uploadId),
      PartNumber: checkPartNumber(partNumber),
      ContentLength: checkPutBytes(bytes),
    })
    const url = await this.presigner(command, { expiresIn: checkTtl(ttlSec), signableHeaders: new Set(['content-length']) })
    return { url, headers: {} }
  }

  async completeMultipartUpload(key: string, uploadId: string, parts: CompletedPart[]): Promise<void> {
    const list = checkCompletedParts(parts)
    await this.send(
      new CompleteMultipartUploadCommand({
        Bucket: this.bucket,
        Key: checkKey(key),
        UploadId: checkUploadId(uploadId),
        MultipartUpload: { Parts: list.map((p) => ({ PartNumber: p.partNumber, ETag: `"${p.etag}"` })) },
      }),
      'Upload',
    )
  }

  async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    const command = new AbortMultipartUploadCommand({ Bucket: this.bucket, Key: checkKey(key), UploadId: checkUploadId(uploadId) })
    try {
      await this.client.send(command)
    } catch (err) {
      const mapped = mapS3Error(err, 'Abort upload')
      if (mapped.code !== 'not_found') throw mapped
    }
  }
}
