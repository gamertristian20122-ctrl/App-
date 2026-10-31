// MemoryStorage: an in-process ObjectStorage for tests (and STORAGE_DRIVER=memory). Presigned URLs
// are signed exactly like FsStorage's, so tests can push them through createLocalStorageHandler.

import { createHash, randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { ObjectHead } from '@app/core/ports'
import { storageError } from '../errors'
import { checkBytesValue, checkContentType, checkKey, checkLocalPath } from '../validate'
import { collectExact, LocalStorageBase, type LocalObject, type LocalStorageOptions, type StoredPart } from './base'

export interface MemoryObject {
  bytes: Uint8Array
  contentType: string
  etag: string
}

export interface MemoryStorageOptions extends Partial<LocalStorageOptions> {}

const DEFAULT_MEMORY_BASE_URL = 'http://localhost:3000/api/dev-storage'
const DEFAULT_MEMORY_SECRET = 'memory-storage-test-secret'

function md5(bytes: Uint8Array): string {
  return createHash('md5').update(bytes).digest('hex')
}

export class MemoryStorage extends LocalStorageBase {
  readonly driver = 'memory' as const
  private readonly objects = new Map<string, MemoryObject>()
  private readonly uploads = new Map<string, { key: string; contentType: string; parts: Map<number, Uint8Array> }>()

  constructor(options: MemoryStorageOptions = {}) {
    super({
      ...options,
      baseUrl: options.baseUrl ?? DEFAULT_MEMORY_BASE_URL,
      signingSecret: options.signingSecret ?? DEFAULT_MEMORY_SECRET,
    })
  }

  // --- ObjectStorage ----------------------------------------------------------

  async putBytes(key: string, bytes: Uint8Array, contentType: string): Promise<void> {
    const k = checkKey(key)
    const ct = checkContentType(contentType)
    const copy = new Uint8Array(checkBytesValue(bytes))
    this.objects.set(k, { bytes: copy, contentType: ct, etag: md5(copy) })
  }

  async putFile(key: string, path: string, contentType: string): Promise<void> {
    const k = checkKey(key)
    const ct = checkContentType(contentType)
    let data: Buffer
    try {
      data = await readFile(checkLocalPath(path))
    } catch (err) {
      throw storageError('invalid_input', 'The local file could not be read.', { cause: err })
    }
    await this.putBytes(k, new Uint8Array(data), ct)
  }

  async getToFile(key: string, path: string): Promise<void> {
    const obj = this.objects.get(checkKey(key))
    if (!obj) throw storageError('not_found', 'The file was not found in storage.')
    const target = checkLocalPath(path)
    await mkdir(dirname(target), { recursive: true })
    const tmp = `${target}.part-${randomBytes(6).toString('hex')}`
    await writeFile(tmp, obj.bytes)
    await rename(tmp, target)
  }

  async head(key: string): Promise<ObjectHead | null> {
    const obj = this.objects.get(checkKey(key))
    return obj ? { bytes: obj.bytes.byteLength, contentType: obj.contentType } : null
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(checkKey(key))
  }

  // --- test helpers -------------------------------------------------------------

  /** A copy of the stored bytes, or null. */
  getBytes(key: string): Uint8Array | null {
    const obj = this.objects.get(key)
    return obj ? new Uint8Array(obj.bytes) : null
  }

  has(key: string): boolean {
    return this.objects.has(key)
  }

  keys(prefix = ''): string[] {
    return [...this.objects.keys()].filter((k) => k.startsWith(prefix)).sort()
  }

  /** Open multipart uploads (for asserting aborts in tests). */
  openUploads(): string[] {
    return [...this.uploads.keys()]
  }

  clear(): void {
    this.objects.clear()
    this.uploads.clear()
  }

  // --- LocalBackend -----------------------------------------------------------------

  async receivePut(key: string, contentType: string, body: AsyncIterable<Uint8Array>, bytes: number): Promise<{ etag: string }> {
    const data = await collectExact(body, bytes)
    const etag = md5(data)
    this.objects.set(checkKey(key), { bytes: data, contentType: checkContentType(contentType), etag })
    return { etag }
  }

  async receivePart(
    key: string,
    uploadId: string,
    partNumber: number,
    body: AsyncIterable<Uint8Array>,
    bytes: number,
  ): Promise<{ etag: string }> {
    const upload = this.uploads.get(uploadId)
    if (!upload || upload.key !== key) throw storageError('not_found', 'This upload does not exist or has already been completed.')
    const data = await collectExact(body, bytes)
    upload.parts.set(partNumber, data)
    return { etag: md5(data) }
  }

  async openObject(key: string): Promise<LocalObject | null> {
    const obj = this.objects.get(key)
    if (!obj) return null
    const bytes = obj.bytes
    return {
      bytes: bytes.byteLength,
      contentType: obj.contentType,
      async *read(start: number, end: number) {
        yield bytes.subarray(start, end)
      },
    }
  }

  // --- multipart primitives -------------------------------------------------------

  protected async mpuCreate(key: string, contentType: string): Promise<{ uploadId: string }> {
    const uploadId = `mem-${randomBytes(12).toString('hex')}`
    this.uploads.set(uploadId, { key, contentType, parts: new Map() })
    return { uploadId }
  }

  protected async mpuGet(key: string, uploadId: string): Promise<{ contentType: string; parts: StoredPart[] } | null> {
    const upload = this.uploads.get(uploadId)
    if (!upload || upload.key !== key) return null
    return {
      contentType: upload.contentType,
      parts: [...upload.parts].map(([partNumber, data]) => ({ partNumber, bytes: data.byteLength, etag: md5(data) })),
    }
  }

  protected async mpuComplete(key: string, uploadId: string, contentType: string, parts: StoredPart[]): Promise<void> {
    const upload = this.uploads.get(uploadId)
    if (!upload) throw storageError('not_found', 'This upload does not exist or has already been completed.')
    const total = parts.reduce((n, p) => n + p.bytes, 0)
    const out = new Uint8Array(total)
    let offset = 0
    for (const p of parts) {
      const data = upload.parts.get(p.partNumber) as Uint8Array
      out.set(data, offset)
      offset += data.byteLength
    }
    this.uploads.delete(uploadId)
    this.objects.set(key, { bytes: out, contentType, etag: `${md5(out)}-${parts.length}` })
  }

  protected async mpuAbort(key: string, uploadId: string): Promise<void> {
    const upload = this.uploads.get(uploadId)
    if (upload && upload.key === key) this.uploads.delete(uploadId)
  }
}
