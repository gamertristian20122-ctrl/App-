// FsStorage: ObjectStorage on a local directory (local development, STORAGE_DRIVER=fs).
// Presigned URLs point at `baseUrl` (the web app's /api/dev-storage route, served by
// createLocalStorageHandler), signed with HMAC so they expire and pin type and size like R2's.
//
// Layout under `dir`:
//   objects/<key>            object bytes
//   meta/<key>.json          { contentType, bytes, etag }
//   multipart/<uploadId>/    info.json + <partNumber>.part (+ .json with size and etag)
//   tmp/                     in-flight writes (renamed into place when complete)

import { createHash, randomBytes } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { z } from 'zod'
import type { ObjectHead } from '@app/core/ports'
import { storageError } from '../errors'
import { mimeForExt } from '../keys'
import { checkBytesValue, checkContentType, checkKey, checkLocalPath } from '../validate'
import { lengthMismatch, LocalStorageBase, type LocalObject, type LocalStorageOptions, type StoredPart } from './base'

export interface FsStorageOptions extends LocalStorageOptions {
  /** Root directory (created on demand). */
  dir: string
}

const MetaSchema = z.object({
  contentType: z.string().min(1).max(127),
  bytes: z.number().int().min(0),
  etag: z.string().max(80).optional(),
})

const UploadInfoSchema = z.object({ key: z.string(), contentType: z.string() })
const PartInfoSchema = z.object({ bytes: z.number().int().min(0), etag: z.string() })

function isNotFound(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

/** Reads [start, end) of a file; the stream is opened on first iteration. */
async function* lazyRead(path: string, start?: number, end?: number): AsyncGenerator<Uint8Array> {
  const stream = start === undefined ? createReadStream(path) : createReadStream(path, { start, end: (end as number) - 1 })
  for await (const chunk of stream) yield chunk as Uint8Array
}

async function readJson<T>(path: string, schema: z.ZodType<T>): Promise<T | null> {
  try {
    const parsed = schema.safeParse(JSON.parse(await readFile(path, 'utf8')))
    return parsed.success ? parsed.data : null
  } catch (err) {
    if (isNotFound(err) || err instanceof SyntaxError) return null
    throw err
  }
}

export class FsStorage extends LocalStorageBase {
  readonly driver = 'fs' as const
  readonly dir: string

  constructor(options: FsStorageOptions) {
    super(options)
    if (typeof options.dir !== 'string' || options.dir.length === 0) {
      throw storageError('invalid_input', 'FsStorage needs a directory.')
    }
    this.dir = resolve(options.dir)
  }

  // --- paths (keys are validated, and every path is re-checked to stay under dir) -----

  private inside(...parts: string[]): string {
    const p = resolve(this.dir, ...parts)
    if (p !== this.dir && !p.startsWith(this.dir + sep)) throw storageError('invalid_key', 'Storage key escapes the storage directory.')
    return p
  }

  private objectPath(key: string): string {
    return this.inside('objects', ...key.split('/'))
  }

  private metaPath(key: string): string {
    return this.inside('meta', ...`${key}.json`.split('/'))
  }

  private uploadDir(uploadId: string): string {
    if (!/^[0-9a-f]{32}$/.test(uploadId)) throw storageError('not_found', 'This upload does not exist or has already been completed.')
    return this.inside('multipart', uploadId)
  }

  private async tmpPath(): Promise<string> {
    const dir = this.inside('tmp')
    await mkdir(dir, { recursive: true })
    return join(dir, randomBytes(12).toString('hex'))
  }

  /** Streams `body` into a temp file, enforcing an exact length; returns the temp path and MD5. */
  private async spool(body: AsyncIterable<Uint8Array>, exact?: number): Promise<{ tmp: string; bytes: number; etag: string }> {
    const tmp = await this.tmpPath()
    const hash = createHash('md5')
    let bytes = 0
    async function* counted() {
      for await (const chunk of body) {
        bytes += chunk.byteLength
        if (exact !== undefined && bytes > exact) throw lengthMismatch()
        hash.update(chunk)
        yield chunk
      }
    }
    try {
      await pipeline(counted, createWriteStream(tmp))
      if (exact !== undefined && bytes !== exact) throw lengthMismatch()
    } catch (err) {
      await rm(tmp, { force: true })
      throw err
    }
    return { tmp, bytes, etag: hash.digest('hex') }
  }

  private async commit(key: string, tmp: string, contentType: string, bytes: number, etag: string): Promise<void> {
    const target = this.objectPath(key)
    const metaTarget = this.metaPath(key)
    await mkdir(dirname(target), { recursive: true })
    await mkdir(dirname(metaTarget), { recursive: true })
    await rename(tmp, target)
    const metaTmp = await this.tmpPath()
    await writeFile(metaTmp, JSON.stringify({ contentType, bytes, etag }))
    await rename(metaTmp, metaTarget)
  }

  // --- ObjectStorage ----------------------------------------------------------

  async putBytes(key: string, bytes: Uint8Array, contentType: string): Promise<void> {
    const k = checkKey(key)
    const ct = checkContentType(contentType)
    const data = checkBytesValue(bytes)
    const tmp = await this.tmpPath()
    await writeFile(tmp, data)
    await this.commit(k, tmp, ct, data.byteLength, createHash('md5').update(data).digest('hex'))
  }

  async putFile(key: string, path: string, contentType: string): Promise<void> {
    const k = checkKey(key)
    const ct = checkContentType(contentType)
    const source = checkLocalPath(path)
    try {
      if (!(await stat(source)).isFile()) throw new Error('not a file')
    } catch {
      throw storageError('invalid_input', 'The local file could not be read.')
    }
    let spooled: { tmp: string; bytes: number; etag: string }
    try {
      // The stream is created only when the pipeline starts reading, so an open error is not orphaned.
      spooled = await this.spool(lazyRead(source))
    } catch (err) {
      if (isNotFound(err)) throw storageError('invalid_input', 'The local file could not be read.')
      throw err
    }
    await this.commit(k, spooled.tmp, ct, spooled.bytes, spooled.etag)
  }

  async getToFile(key: string, path: string): Promise<void> {
    const source = this.objectPath(checkKey(key))
    const target = checkLocalPath(path)
    await mkdir(dirname(resolve(target)), { recursive: true })
    const tmp = `${target}.part-${randomBytes(6).toString('hex')}`
    try {
      await copyFile(source, tmp)
    } catch (err) {
      await rm(tmp, { force: true })
      if (isNotFound(err)) throw storageError('not_found', 'The file was not found in storage.')
      throw err
    }
    await rename(tmp, target)
  }

  async head(key: string): Promise<ObjectHead | null> {
    const k = checkKey(key)
    let size: number
    try {
      const s = await stat(this.objectPath(k))
      if (!s.isFile()) return null
      size = s.size
    } catch (err) {
      if (isNotFound(err)) return null
      throw err
    }
    const meta = await readJson(this.metaPath(k), MetaSchema)
    const ext = k.split('.').pop() ?? ''
    return { bytes: size, contentType: meta?.contentType ?? mimeForExt(ext) ?? 'application/octet-stream' }
  }

  async delete(key: string): Promise<void> {
    const k = checkKey(key)
    await rm(this.objectPath(k), { force: true })
    await rm(this.metaPath(k), { force: true })
  }

  // --- LocalBackend -----------------------------------------------------------------

  async receivePut(key: string, contentType: string, body: AsyncIterable<Uint8Array>, bytes: number): Promise<{ etag: string }> {
    const k = checkKey(key)
    const ct = checkContentType(contentType)
    const spooled = await this.spool(body, bytes)
    await this.commit(k, spooled.tmp, ct, spooled.bytes, spooled.etag)
    return { etag: spooled.etag }
  }

  async receivePart(
    key: string,
    uploadId: string,
    partNumber: number,
    body: AsyncIterable<Uint8Array>,
    bytes: number,
  ): Promise<{ etag: string }> {
    const dir = this.uploadDir(uploadId)
    const info = await readJson(join(dir, 'info.json'), UploadInfoSchema)
    if (!info || info.key !== key) throw storageError('not_found', 'This upload does not exist or has already been completed.')
    const spooled = await this.spool(body, bytes)
    await rename(spooled.tmp, join(dir, `${partNumber}.part`))
    await writeFile(join(dir, `${partNumber}.json`), JSON.stringify({ bytes: spooled.bytes, etag: spooled.etag }))
    return { etag: spooled.etag }
  }

  async openObject(key: string): Promise<LocalObject | null> {
    const head = await this.head(key)
    if (!head) return null
    const path = this.objectPath(key)
    return {
      bytes: head.bytes,
      contentType: head.contentType,
      read: (start: number, end: number) => (end <= start ? (async function* () {})() : lazyRead(path, start, end)),
    }
  }

  // --- multipart primitives -------------------------------------------------------

  protected async mpuCreate(key: string, contentType: string): Promise<{ uploadId: string }> {
    const uploadId = randomBytes(16).toString('hex')
    const dir = this.uploadDir(uploadId)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'info.json'), JSON.stringify({ key, contentType }))
    return { uploadId }
  }

  protected async mpuGet(key: string, uploadId: string): Promise<{ contentType: string; parts: StoredPart[] } | null> {
    let dir: string
    try {
      dir = this.uploadDir(uploadId)
    } catch {
      return null
    }
    const info = await readJson(join(dir, 'info.json'), UploadInfoSchema)
    if (!info || info.key !== key) return null
    const parts: StoredPart[] = []
    for (const name of await readdir(dir)) {
      const m = /^(\d+)\.json$/.exec(name)
      if (!m) continue
      const part = await readJson(join(dir, name), PartInfoSchema)
      if (part) parts.push({ partNumber: Number(m[1]), bytes: part.bytes, etag: part.etag })
    }
    return { contentType: info.contentType, parts: parts.sort((a, b) => a.partNumber - b.partNumber) }
  }

  protected async mpuComplete(key: string, uploadId: string, contentType: string, parts: StoredPart[]): Promise<void> {
    const dir = this.uploadDir(uploadId)
    const files = parts.map((p) => join(dir, `${p.partNumber}.part`))
    async function* concat() {
      for (const f of files) yield* lazyRead(f)
    }
    const spooled = await this.spool(concat())
    await this.commit(key, spooled.tmp, contentType, spooled.bytes, `${spooled.etag}-${parts.length}`)
    await rm(dir, { recursive: true, force: true })
  }

  protected async mpuAbort(key: string, uploadId: string): Promise<void> {
    let dir: string
    try {
      dir = this.uploadDir(uploadId)
    } catch {
      return
    }
    const info = await readJson(join(dir, 'info.json'), UploadInfoSchema)
    if (info && info.key === key) await rm(dir, { recursive: true, force: true })
  }
}
