// Test helpers: an in-memory S3 stand-in (the `send` of an S3Client) and a shared ObjectStorage contract.

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { ObjectStorage } from '@app/core/ports'
import { clipKey, renderKey, sourceKey, uploadKey } from '../src/keys'
import { MAX_PRESIGN_TTL_SEC, MAX_SINGLE_PUT_BYTES } from '../src/validate'

export const USER = '11111111-1111-4111-8111-111111111111'
export const OTHER_USER = '22222222-2222-4222-8222-222222222222'
export const MEDIA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
export const MEDIA2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

export async function tempDir(prefix = 'storage-test-'): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix))
}

async function collect(body: unknown): Promise<Uint8Array> {
  if (body instanceof Uint8Array) return new Uint8Array(body)
  if (typeof body === 'string') return new TextEncoder().encode(body)
  const chunks: Buffer[] = []
  for await (const chunk of body as AsyncIterable<Buffer | Uint8Array | string>) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk))
  }
  return new Uint8Array(Buffer.concat(chunks))
}

export class S3Error extends Error {
  readonly $metadata: { httpStatusCode: number }
  readonly $response = { headers: { 'x-secret-echo': 'should-not-leak' }, body: 'raw' }
  constructor(name: string, status: number) {
    super(`${name} happened`)
    this.name = name
    this.$metadata = { httpStatusCode: status }
  }
}

interface FakeObject {
  body: Uint8Array
  contentType?: string
}

/**
 * A minimal in-memory S3 that understands the commands R2Storage sends. `send` is a vi.fn, so tests
 * can inspect calls (`send.mock.calls[i][0]` is the command; `.constructor.name` and `.input`).
 */
export function createFakeS3() {
  const objects = new Map<string, FakeObject>()
  const uploads = new Map<string, { key: string; contentType?: string; parts: Map<number, Uint8Array> }>()
  let uploadSeq = 0
  const failures: Array<{ command: string; error: Error; times: number }> = []

  const send = vi.fn(async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
    const name = command.constructor.name
    const failure = failures.find((f) => f.command === name && f.times > 0)
    if (failure) {
      failure.times--
      throw failure.error
    }
    const input = command.input
    const key = String(input.Key)
    switch (name) {
      case 'PutObjectCommand': {
        const body = await collect(input.Body)
        if (input.ContentLength !== undefined && input.ContentLength !== body.byteLength) throw new S3Error('IncompleteBody', 400)
        objects.set(key, { body, contentType: input.ContentType as string | undefined })
        return { ETag: '"etag"' }
      }
      case 'GetObjectCommand': {
        const obj = objects.get(key)
        if (!obj) throw new S3Error('NoSuchKey', 404)
        return { Body: Readable.from([Buffer.from(obj.body)]), ContentLength: obj.body.byteLength, ContentType: obj.contentType }
      }
      case 'HeadObjectCommand': {
        const obj = objects.get(key)
        if (!obj) throw new S3Error('NotFound', 404)
        return { ContentLength: obj.body.byteLength, ContentType: obj.contentType }
      }
      case 'DeleteObjectCommand':
        objects.delete(key)
        return {}
      case 'CreateMultipartUploadCommand': {
        const id = `upload-${++uploadSeq}`
        uploads.set(id, { key, contentType: input.ContentType as string | undefined, parts: new Map() })
        return { UploadId: id }
      }
      case 'UploadPartCommand': {
        const upload = uploads.get(String(input.UploadId))
        if (!upload) throw new S3Error('NoSuchUpload', 404)
        const body = await collect(input.Body)
        if (input.ContentLength !== body.byteLength) throw new S3Error('IncompleteBody', 400)
        upload.parts.set(Number(input.PartNumber), body)
        return { ETag: `"part-${String(input.PartNumber)}"` }
      }
      case 'CompleteMultipartUploadCommand': {
        const upload = uploads.get(String(input.UploadId))
        if (!upload) throw new S3Error('NoSuchUpload', 404)
        const parts = (input.MultipartUpload as { Parts: Array<{ PartNumber: number; ETag: string }> }).Parts
        const buffers: Buffer[] = []
        for (const p of parts) {
          const data = upload.parts.get(p.PartNumber)
          if (!data || p.ETag !== `"part-${p.PartNumber}"`) throw new S3Error('InvalidPart', 400)
          buffers.push(Buffer.from(data))
        }
        objects.set(upload.key, { body: new Uint8Array(Buffer.concat(buffers)), contentType: upload.contentType })
        uploads.delete(String(input.UploadId))
        return {}
      }
      case 'AbortMultipartUploadCommand': {
        if (!uploads.delete(String(input.UploadId))) throw new S3Error('NoSuchUpload', 404)
        return {}
      }
      default:
        throw new Error(`fake S3: unsupported ${name}`)
    }
  })

  return {
    send,
    objects,
    uploads,
    failNext(command: string, error: Error, times = 1) {
      failures.push({ command, error, times })
    },
    commands: () => send.mock.calls.map((c) => (c[0] as { constructor: { name: string } }).constructor.name),
  }
}

/** Behaviour every ObjectStorage driver must share. */
export function objectStorageContract(name: string, make: () => Promise<ObjectStorage> | ObjectStorage) {
  describe(`${name}: ObjectStorage contract`, () => {
    let storage: ObjectStorage
    let dir: string

    beforeAll(async () => {
      storage = await make()
      dir = await tempDir('contract-')
    })
    afterAll(async () => {
      await rm(dir, { recursive: true, force: true })
    })

    it('stores bytes and reads them back to a file', async () => {
      const key = renderKey(USER, MEDIA, 'png')
      const bytes = new Uint8Array([137, 80, 78, 71, 1, 2, 3])
      await storage.putBytes(key, bytes, 'image/png')
      expect(await storage.head(key)).toEqual({ bytes: 7, contentType: 'image/png' })
      const out = join(dir, 'nested', 'deeper', 'out.png')
      await storage.getToFile(key, out)
      expect(new Uint8Array(await readFile(out))).toEqual(bytes)
    })

    it('uploads a local file', async () => {
      const src = join(dir, 'clip.mp4')
      await writeFile(src, Buffer.from('fake mp4 bytes'))
      const key = clipKey(USER, MEDIA)
      await storage.putFile(key, src, 'video/mp4')
      expect(await storage.head(key)).toEqual({ bytes: 14, contentType: 'video/mp4' })
    })

    it('overwrites an existing key', async () => {
      const key = uploadKey(USER, MEDIA2, 'jpg')
      await storage.putBytes(key, new Uint8Array([1, 2, 3]), 'image/jpeg')
      await storage.putBytes(key, new Uint8Array([9]), 'image/jpeg')
      expect(await storage.head(key)).toEqual({ bytes: 1, contentType: 'image/jpeg' })
    })

    it('stores empty objects', async () => {
      const key = uploadKey(USER, MEDIA, 'vtt')
      await storage.putBytes(key, new Uint8Array(0), 'text/vtt')
      expect(await storage.head(key)).toEqual({ bytes: 0, contentType: 'text/vtt' })
    })

    it('returns null from head for a missing key and deletes idempotently', async () => {
      const key = sourceKey(USER, MEDIA2, 'mov')
      expect(await storage.head(key)).toBeNull()
      await storage.delete(key)
      await storage.putBytes(key, new Uint8Array([1]), 'video/quicktime')
      await storage.delete(key)
      expect(await storage.head(key)).toBeNull()
      await storage.delete(key)
    })

    it('fails getToFile with not_found for a missing key and leaves no file', async () => {
      const out = join(dir, 'missing.mp4')
      await expect(storage.getToFile(sourceKey(OTHER_USER, MEDIA, 'mp4'), out)).rejects.toMatchObject({
        code: 'not_found',
        details: { reason: 'not_found' },
      })
      await expect(readFile(out)).rejects.toThrow()
    })

    it('rejects keys outside the users/{id}/ layout everywhere', async () => {
      for (const bad of ['secrets.txt', `users/${USER}/../x.mp4`, `users/${USER}/.hidden`, `users/not-a-uuid/a.mp4`, '']) {
        await expect(storage.putBytes(bad, new Uint8Array([1]), 'video/mp4')).rejects.toMatchObject({ code: 'validation' })
        await expect(storage.head(bad)).rejects.toMatchObject({ code: 'validation' })
        await expect(storage.delete(bad)).rejects.toMatchObject({ code: 'validation' })
        await expect(storage.presignGet(bad, 60)).rejects.toMatchObject({ code: 'validation' })
        await expect(storage.presignPut(bad, 'video/mp4', 10)).rejects.toMatchObject({ code: 'validation' })
      }
    })

    it('validates presign inputs', async () => {
      const key = uploadKey(USER, MEDIA, 'mp4')
      await expect(storage.presignPut(key, 'not a mime', 10)).rejects.toMatchObject({ code: 'validation' })
      await expect(storage.presignPut(key, 'video/mp4', 0)).rejects.toMatchObject({ code: 'validation' })
      await expect(storage.presignPut(key, 'video/mp4', 1.5)).rejects.toMatchObject({ code: 'validation' })
      await expect(storage.presignPut(key, 'video/mp4', MAX_SINGLE_PUT_BYTES + 1)).rejects.toMatchObject({
        details: { reason: 'too_large' },
      })
      await expect(storage.presignGet(key, 0)).rejects.toMatchObject({ code: 'validation' })
      await expect(storage.presignGet(key, MAX_PRESIGN_TTL_SEC + 1)).rejects.toMatchObject({ code: 'validation' })
      const put = await storage.presignPut(key, 'Video/MP4', 10)
      expect(put.headers).toEqual({ 'Content-Type': 'video/mp4' })
      expect(put.url).toMatch(/^https?:\/\//)
      expect(await storage.presignGet(key, 60)).toMatch(/^https?:\/\//)
    })

    it('rejects a missing local file in putFile', async () => {
      await expect(storage.putFile(uploadKey(USER, MEDIA, 'mp4'), join(dir, 'nope.mp4'), 'video/mp4')).rejects.toMatchObject({
        code: 'validation',
      })
    })
  })
}
