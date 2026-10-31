import { readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { memoryLogger } from '@app/core/testing'
import { clipKey, renderKey, sourceKey, uploadKey } from '../src/keys'
import { mapS3Error, R2Storage, r2Endpoint, type R2StorageConfig } from '../src/r2'
import { MIN_PART_BYTES } from '../src/multipart'
import { createFakeS3, MEDIA, objectStorageContract, S3Error, tempDir, USER } from './helpers'

const SECRET_KEY = 'r2-secret-access-key-do-not-leak-0123456789'
const CONFIG: R2StorageConfig = {
  accountId: 'abc123def456',
  accessKeyId: 'AKIAR2TESTKEY',
  secretAccessKey: SECRET_KEY,
  bucket: 'media-bucket',
}

let dir: string
beforeAll(async () => {
  dir = await tempDir('r2-test-')
})
afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

objectStorageContract('R2Storage (fake S3)', () => new R2Storage(CONFIG, { client: createFakeS3() }))

function make(overrides: Partial<R2StorageConfig> = {}) {
  const s3 = createFakeS3()
  const storage = new R2Storage({ ...CONFIG, ...overrides }, { client: s3 })
  return { s3, storage }
}

describe('R2Storage presigning (local signing, no network)', () => {
  it('presigns a PUT that pins Content-Type and Content-Length', async () => {
    const { s3, storage } = make()
    const key = uploadKey(USER, MEDIA, 'mp4')
    const put = await storage.presignPut(key, 'video/mp4', 123_456)
    const url = new URL(put.url)
    expect(url.origin).toBe('https://abc123def456.r2.cloudflarestorage.com')
    expect(url.pathname).toBe(`/media-bucket/${key}`)
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe('content-length;content-type;host')
    expect(url.searchParams.get('X-Amz-Expires')).toBe('3600')
    expect(url.searchParams.get('X-Amz-Credential')).toMatch(/^AKIAR2TESTKEY\/\d{8}\/auto\/s3\/aws4_request$/)
    expect(url.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/)
    // No checksum of an empty body (would break browser uploads).
    expect([...url.searchParams.keys()].some((k) => k.toLowerCase().includes('checksum'))).toBe(false)
    expect(put.url).not.toContain(SECRET_KEY)
    expect(put.headers).toEqual({ 'Content-Type': 'video/mp4' })
    expect(s3.send).not.toHaveBeenCalled()
  })

  it('presigns a GET with the requested lifetime', async () => {
    const { storage } = make()
    const url = new URL(await storage.presignGet(clipKey(USER, MEDIA), 7200))
    expect(url.searchParams.get('X-Amz-Expires')).toBe('7200')
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe('host')
    expect(url.searchParams.get('x-id')).toBe('GetObject')
  })

  it('presigns multipart parts that pin Content-Length', async () => {
    const { storage } = make()
    const p = await storage.presignUploadPart(sourceKey(USER, MEDIA, 'mp4'), 'upload-abc', 3, MIN_PART_BYTES, 600)
    const url = new URL(p.url)
    expect(url.searchParams.get('partNumber')).toBe('3')
    expect(url.searchParams.get('uploadId')).toBe('upload-abc')
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe('content-length;host')
    expect(url.searchParams.get('X-Amz-Expires')).toBe('600')
    expect(p.headers).toEqual({})
  })

  it('uses the endpoint override and the configured PUT lifetime', async () => {
    const { storage } = make({ endpoint: 'https://abc.eu.r2.cloudflarestorage.com/', putTtlSec: 900 })
    const url = new URL((await storage.presignPut(renderKey(USER, MEDIA, 'png'), 'image/png', 10)).url)
    expect(url.host).toBe('abc.eu.r2.cloudflarestorage.com')
    expect(url.searchParams.get('X-Amz-Expires')).toBe('900')
  })

  it('accepts an injected presigner', async () => {
    const presign = vi.fn(async () => 'https://signed.example/x')
    const storage = new R2Storage(CONFIG, { client: createFakeS3(), presign })
    expect(await storage.presignGet(clipKey(USER, MEDIA), 60)).toBe('https://signed.example/x')
    expect(presign).toHaveBeenCalledWith(expect.objectContaining({ input: expect.objectContaining({ Bucket: 'media-bucket' }) }), {
      expiresIn: 60,
    })
  })
})

describe('R2Storage configuration', () => {
  it('builds the endpoint from the account id', () => {
    expect(r2Endpoint({ accountId: 'abc123' })).toBe('https://abc123.r2.cloudflarestorage.com')
    expect(r2Endpoint({ endpoint: 'http://localhost:9000' })).toBe('http://localhost:9000')
    expect(() => r2Endpoint({})).toThrow()
    expect(() => r2Endpoint({ accountId: 'evil.com/x' })).toThrow()
    expect(() => r2Endpoint({ endpoint: 'http://example.com' })).toThrow()
    expect(() => r2Endpoint({ endpoint: 'not a url' })).toThrow()
  })

  it('rejects missing credentials and invalid bucket names', () => {
    expect(() => new R2Storage({ ...CONFIG, bucket: '' })).toThrow()
    expect(() => new R2Storage({ ...CONFIG, bucket: 'Bad_Bucket' })).toThrow()
    expect(() => new R2Storage({ ...CONFIG, accessKeyId: '' })).toThrow()
    expect(() => new R2Storage({ ...CONFIG, secretAccessKey: '' })).toThrow()
  })
})

describe('R2Storage requests (mocked S3 client)', () => {
  it('sends PutObject with type and length', async () => {
    const { s3, storage } = make()
    const key = renderKey(USER, MEDIA, 'png')
    await storage.putBytes(key, new Uint8Array([1, 2, 3]), 'image/png')
    const command = s3.send.mock.calls[0]?.[0] as { constructor: { name: string }; input: Record<string, unknown> }
    expect(command.constructor.name).toBe('PutObjectCommand')
    expect(command.input).toMatchObject({ Bucket: 'media-bucket', Key: key, ContentType: 'image/png', ContentLength: 3 })
  })

  it('maps HEAD 404 to null and other failures to AppErrors without secrets', async () => {
    const { s3, storage } = make()
    expect(await storage.head(clipKey(USER, MEDIA))).toBeNull()

    s3.failNext('HeadObjectCommand', new S3Error('AccessDenied', 403))
    const denied = await storage.head(clipKey(USER, MEDIA)).catch((e: unknown) => e)
    expect(denied).toMatchObject({ code: 'unavailable', details: { reason: 'storage_auth', status: 403 } })

    s3.failNext('HeadObjectCommand', new S3Error('InternalError', 500))
    const down = await storage.head(clipKey(USER, MEDIA)).catch((e: unknown) => e)
    expect(down).toMatchObject({ code: 'unavailable', details: { reason: 'storage_unavailable', status: 500 } })
    const serialized = JSON.stringify(down) + String((down as Error).cause)
    expect(serialized).not.toContain('should-not-leak')
    expect(serialized).not.toContain(SECRET_KEY)
  })

  it('treats deleting a missing object as success but surfaces outages', async () => {
    const { s3, storage } = make()
    s3.failNext('DeleteObjectCommand', new S3Error('NoSuchKey', 404))
    await storage.delete(clipKey(USER, MEDIA))
    s3.failNext('DeleteObjectCommand', new S3Error('ServiceUnavailable', 503))
    await expect(storage.delete(clipKey(USER, MEDIA))).rejects.toMatchObject({ details: { reason: 'storage_unavailable' } })
  })

  it('downloads web-stream and transformToWebStream bodies', async () => {
    const send = vi.fn()
    const storage = new R2Storage(CONFIG, { client: { send } })
    send.mockResolvedValueOnce({ Body: new Blob([new TextEncoder().encode('web stream')]).stream() })
    await storage.getToFile(clipKey(USER, MEDIA), join(dir, 'a.mp4'))
    expect(await readFile(join(dir, 'a.mp4'), 'utf8')).toBe('web stream')

    send.mockResolvedValueOnce({ Body: { transformToWebStream: () => new Blob(['sdk mixin']).stream() } })
    await storage.getToFile(clipKey(USER, MEDIA), join(dir, 'b.mp4'))
    expect(await readFile(join(dir, 'b.mp4'), 'utf8')).toBe('sdk mixin')

    send.mockResolvedValueOnce({ Body: undefined })
    await expect(storage.getToFile(clipKey(USER, MEDIA), join(dir, 'c.mp4'))).rejects.toMatchObject({
      details: { reason: 'storage_unavailable' },
    })
  })

  it('removes the partial file when a download breaks', async () => {
    const send = vi.fn()
    const storage = new R2Storage(CONFIG, { client: { send } })
    async function* broken() {
      yield Buffer.from('partial')
      throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })
    }
    send.mockResolvedValueOnce({ Body: Readable.from(broken()) })
    const target = join(dir, 'broken.mp4')
    await expect(storage.getToFile(clipKey(USER, MEDIA), target)).rejects.toMatchObject({
      details: { reason: 'storage_unavailable' },
    })
    await expect(stat(target)).rejects.toThrow()
  })

  it('uploads large files in uniform parts and completes in order', async () => {
    const { s3, storage } = make({ multipartThresholdBytes: 1024, partBytes: MIN_PART_BYTES, partConcurrency: 2 })
    const src = join(dir, 'big.bin')
    const size = 2 * MIN_PART_BYTES + 1234
    const data = Buffer.alloc(size)
    for (let i = 0; i < size; i += 4096) data[i] = i % 251
    await writeFile(src, data)
    const key = sourceKey(USER, MEDIA, 'mp4')
    await storage.putFile(key, src, 'video/mp4')

    expect(s3.commands()).toEqual([
      'CreateMultipartUploadCommand',
      'UploadPartCommand',
      'UploadPartCommand',
      'UploadPartCommand',
      'CompleteMultipartUploadCommand',
    ])
    const parts = s3.send.mock.calls
      .map((c) => c[0] as { constructor: { name: string }; input: Record<string, unknown> })
      .filter((c) => c.constructor.name === 'UploadPartCommand')
      .map((c) => c.input.ContentLength)
    expect(parts.sort()).toEqual([1234, MIN_PART_BYTES, MIN_PART_BYTES].sort())
    expect(Buffer.from(s3.objects.get(key)?.body as Uint8Array).equals(data)).toBe(true)
    expect(s3.objects.get(key)?.contentType).toBe('video/mp4')
  })

  it('aborts the multipart upload when a part fails', async () => {
    const logger = memoryLogger()
    const s3 = createFakeS3()
    const storage = new R2Storage({ ...CONFIG, multipartThresholdBytes: 1024, partBytes: MIN_PART_BYTES }, { client: s3, logger })
    const src = join(dir, 'big2.bin')
    await writeFile(src, Buffer.alloc(MIN_PART_BYTES + 10))
    s3.failNext('UploadPartCommand', new S3Error('InternalError', 500))
    await expect(storage.putFile(sourceKey(USER, MEDIA, 'mp4'), src, 'video/mp4')).rejects.toMatchObject({
      details: { reason: 'storage_unavailable' },
    })
    expect(s3.commands()).toContain('AbortMultipartUploadCommand')
    expect(s3.uploads.size).toBe(0)
    expect(logger.text()).not.toContain(SECRET_KEY)
  })

  it('runs the browser multipart flow (create → parts → complete) and validates part lists', async () => {
    const { s3, storage } = make()
    const key = sourceKey(USER, MEDIA, 'mov')
    const { uploadId } = await storage.createMultipartUpload(key, 'video/quicktime')
    // Simulate the browser PUTs with direct UploadPart calls on the fake.
    await s3.send({ constructor: { name: 'UploadPartCommand' }, input: { Key: key, UploadId: uploadId, PartNumber: 1, Body: Buffer.from('ab'), ContentLength: 2 } } as never)
    await s3.send({ constructor: { name: 'UploadPartCommand' }, input: { Key: key, UploadId: uploadId, PartNumber: 2, Body: Buffer.from('c'), ContentLength: 1 } } as never)
    await expect(storage.completeMultipartUpload(key, uploadId, [{ partNumber: 2, etag: 'x' }, { partNumber: 1, etag: 'y' }])).rejects.toMatchObject({
      code: 'validation',
    })
    await storage.completeMultipartUpload(key, uploadId, [
      { partNumber: 1, etag: '"part-1"' },
      { partNumber: 2, etag: 'part-2' },
    ])
    expect(new TextDecoder().decode(s3.objects.get(key)?.body)).toBe('abc')
    // Aborting an upload that no longer exists is fine.
    await storage.abortMultipartUpload(key, uploadId)
  })

  it('rejects a missing local file before sending', async () => {
    const { s3, storage } = make()
    await expect(storage.putFile(clipKey(USER, MEDIA), join(dir, 'missing.mp4'), 'video/mp4')).rejects.toMatchObject({
      code: 'validation',
    })
    expect(s3.send).not.toHaveBeenCalled()
  })
})

describe('R2Storage copy above 5 GB (UploadPartCopy)', () => {
  it('copies in ranged parts and completes the multipart upload', async () => {
    const s3 = createFakeS3()
    const storage = new R2Storage(CONFIG, { client: s3 })
    const from = uploadKey(USER, MEDIA, 'mp4')
    // pretend the object is 6 GB: HeadObject reports the size, the copy reads ranges of the stored bytes
    await storage.putBytes(from, new Uint8Array([1, 2, 3]), 'video/mp4')
    const real = s3.send.getMockImplementation()
    if (!real) throw new Error('no fake implementation')
    const big = 6 * 1024 ** 3
    s3.send.mockImplementation(async (command) => {
      if (command.constructor.name === 'HeadObjectCommand') return { ContentLength: big, ContentType: 'video/mp4' }
      return real(command)
    })
    await storage.copy(from, sourceKey(USER, MEDIA, 'mp4'))
    const names = s3.send.mock.calls.map(([c]) => (c as { constructor: { name: string } }).constructor.name)
    expect(names.filter((n) => n === 'UploadPartCopyCommand')).toHaveLength(6)
    expect(names).toContain('CompleteMultipartUploadCommand')
    expect(names).not.toContain('CopyObjectCommand')
    const ranges = s3.send.mock.calls
      .map(([c]) => c as { constructor: { name: string }; input: { CopySourceRange?: string } })
      .filter((c) => c.constructor.name === 'UploadPartCopyCommand')
      .map((c) => c.input.CopySourceRange)
    expect(ranges[0]).toBe(`bytes=0-${1024 ** 3 - 1}`)
    expect(ranges[5]).toBe(`bytes=${5 * 1024 ** 3}-${big - 1}`)
  })
})

describe('mapS3Error', () => {
  it('classifies SDK errors', () => {
    expect(mapS3Error(new S3Error('NoSuchKey', 404), 'x').details).toMatchObject({ reason: 'not_found' })
    expect(mapS3Error(new S3Error('SignatureDoesNotMatch', 403), 'x').details).toMatchObject({ reason: 'storage_auth' })
    expect(mapS3Error(new S3Error('EntityTooLarge', 400), 'x').details).toMatchObject({ reason: 'too_large' })
    expect(mapS3Error(new S3Error('InvalidPart', 400), 'x').details).toMatchObject({ reason: 'invalid_input' })
    expect(mapS3Error(new Error('ECONNREFUSED'), 'x').details).toMatchObject({ reason: 'storage_unavailable' })
    expect(mapS3Error(undefined, 'x').details).toMatchObject({ reason: 'storage_unavailable' })
  })
})
