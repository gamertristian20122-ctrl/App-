import { readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { manualClock } from '@app/core/testing'
import type { ManualClock } from '@app/core/time'
import { uploadKey, sourceKey, clipKey } from '../src/keys'
import { FsStorage } from '../src/local/fs'
import { MemoryStorage } from '../src/local/memory'
import { createLocalStorageHandler, parseRange } from '../src/local/handler'
import type { LocalStorageBase } from '../src/local/base'
import { MEDIA, MEDIA2, OTHER_USER, USER, objectStorageContract, tempDir } from './helpers'

const BASE = 'http://localhost:3000/api/dev-storage'
const SECRET = 'local-test-secret-0123456789'

let fsRoot: string
beforeAll(async () => {
  fsRoot = await tempDir('fs-storage-')
})
afterAll(async () => {
  await rm(fsRoot, { recursive: true, force: true })
})

objectStorageContract('MemoryStorage', () => new MemoryStorage())
objectStorageContract('FsStorage', () => new FsStorage({ dir: join(fsRoot, 'contract'), baseUrl: BASE, signingSecret: SECRET }))

type Make = (clock: ManualClock) => Promise<LocalStorageBase>

const drivers: Array<[string, Make]> = [
  ['MemoryStorage', async (clock) => new MemoryStorage({ baseUrl: BASE, signingSecret: SECRET, clock, minPartBytes: 4 })],
  [
    'FsStorage',
    async (clock) =>
      new FsStorage({ dir: join(fsRoot, String(Math.random()).slice(2)), baseUrl: BASE, signingSecret: SECRET, clock, minPartBytes: 4 }),
  ],
]

const enc = (s: string) => new TextEncoder().encode(s)

for (const [name, make] of drivers) {
  describe(`${name}: signed URLs and the HTTP handler`, () => {
    let clock: ManualClock
    let storage: LocalStorageBase
    let handle: (r: Request) => Promise<Response>

    beforeEach(async () => {
      clock = manualClock('2026-10-31T12:00:00Z')
      storage = await make(clock)
      handle = createLocalStorageHandler(storage)
    })

    async function put(url: string, body: string, headers: Record<string, string>) {
      return handle(new Request(url, { method: 'PUT', body: enc(body), headers }))
    }

    it('uploads through a presigned PUT and downloads through a presigned GET', async () => {
      const key = uploadKey(USER, MEDIA, 'mp4')
      const { url, headers } = await storage.presignPut(key, 'video/mp4', 11)
      expect(url.startsWith(`${BASE}/users/${USER}/uploads/${MEDIA}.mp4?`)).toBe(true)
      const res = await put(url, 'hello world', headers)
      expect(res.status).toBe(200)
      expect(res.headers.get('etag')).toMatch(/^"[0-9a-f]{32}"$/)
      expect(await storage.head(key)).toEqual({ bytes: 11, contentType: 'video/mp4' })

      const getUrl = await storage.presignGet(key, 300)
      const got = await handle(new Request(getUrl))
      expect(got.status).toBe(200)
      expect(got.headers.get('content-type')).toBe('video/mp4')
      expect(got.headers.get('content-length')).toBe('11')
      expect(await got.text()).toBe('hello world')

      const head = await handle(new Request(getUrl, { method: 'HEAD' }))
      expect(head.status).toBe(200)
      expect(head.headers.get('content-length')).toBe('11')
      expect(await head.text()).toBe('')
    })

    it('serves byte ranges', async () => {
      const key = clipKey(USER, MEDIA)
      await storage.putBytes(key, enc('0123456789'), 'video/mp4')
      const url = await storage.presignGet(key, 60)
      const r1 = await handle(new Request(url, { headers: { range: 'bytes=2-5' } }))
      expect(r1.status).toBe(206)
      expect(r1.headers.get('content-range')).toBe('bytes 2-5/10')
      expect(await r1.text()).toBe('2345')
      const r2 = await handle(new Request(url, { headers: { range: 'bytes=-3' } }))
      expect(await r2.text()).toBe('789')
      const r3 = await handle(new Request(url, { headers: { range: 'bytes=7-' } }))
      expect(await r3.text()).toBe('789')
      const r4 = await handle(new Request(url, { headers: { range: 'bytes=20-30' } }))
      expect(r4.status).toBe(416)
    })

    it('enforces the signed content type', async () => {
      const { url } = await storage.presignPut(uploadKey(USER, MEDIA, 'mp4'), 'video/mp4', 5)
      expect((await put(url, 'hello', { 'content-type': 'text/html' })).status).toBe(403)
      expect((await put(url, 'hello', {})).status).toBe(403)
      expect(await storage.head(uploadKey(USER, MEDIA, 'mp4'))).toBeNull()
    })

    it('enforces the signed length exactly', async () => {
      const key = uploadKey(USER, MEDIA, 'mp4')
      const { url, headers } = await storage.presignPut(key, 'video/mp4', 5)
      expect((await put(url, 'hello world', { ...headers, 'content-length': '11' })).status).toBe(403) // header mismatch
      expect((await put(url, 'hello world', headers)).status).toBe(400) // body longer than signed
      const tooLong = await handle(
        new Request(url, { method: 'PUT', headers, body: new Blob([enc('hello world')]).stream(), duplex: 'half' } as RequestInit),
      )
      expect(tooLong.status).toBe(400)
      const tooShort = await handle(
        new Request(url, { method: 'PUT', headers, body: new Blob([enc('hey')]).stream(), duplex: 'half' } as RequestInit),
      )
      expect(tooShort.status).toBe(400)
      expect(await storage.head(key)).toBeNull()
    })

    it('rejects expired, tampered and wrong-method requests', async () => {
      const key = uploadKey(USER, MEDIA, 'mp4')
      const { url, headers } = await storage.presignPut(key, 'video/mp4', 5)

      const tamperedKey = url.replace(`users/${USER}`, `users/${OTHER_USER}`)
      expect((await put(tamperedKey, 'hello', headers)).status).toBe(403)
      const tamperedLen = url.replace('len=5', 'len=6')
      expect((await put(tamperedLen, 'hello!', headers)).status).toBe(403)
      expect((await put(url.replace(/sig=[0-9a-f]+/, 'sig=nothex'), 'hello', headers)).status).toBe(400)
      expect((await put(`${url}&extra=1`, 'hello', headers)).status).toBe(400)
      expect((await put(url.replace('/api/dev-storage/', '/api/other/'), 'hello', headers)).status).toBe(400)
      expect((await handle(new Request(url))).status).toBe(405)

      const getUrl = await storage.presignGet(key, 60)
      expect((await put(getUrl, 'hello', headers)).status).toBe(405)

      clock.advance(3601_000)
      expect((await put(url, 'hello', headers)).status).toBe(403)
      expect(await (await put(url, 'hello', headers)).text()).toMatch(/expired/)
    })

    it('returns 404 for a missing object', async () => {
      const url = await storage.presignGet(sourceKey(USER, MEDIA2, 'mp4'), 60)
      expect((await handle(new Request(url))).status).toBe(404)
    })

    it('rejects URLs whose path is not a valid key', async () => {
      const res = await handle(new Request(`${BASE}/etc/passwd?op=get&exp=99999999999&sig=${'0'.repeat(64)}`))
      expect(res.status).toBe(400)
      const res2 = await handle(new Request(`${BASE}/users/${USER}/..%2F..%2Fx?op=get&exp=99999999999&sig=${'0'.repeat(64)}`))
      expect(res2.status).toBe(400)
    })

    it('runs a multipart upload through presigned part URLs', async () => {
      const key = sourceKey(USER, MEDIA, 'mp4')
      const { uploadId } = await storage.createMultipartUpload(key, 'video/mp4')
      const chunks = ['aaaa', 'bbbb', 'cc']
      const parts = []
      for (const [i, chunk] of chunks.entries()) {
        const p = await storage.presignUploadPart(key, uploadId, i + 1, chunk.length)
        const res = await handle(new Request(p.url, { method: 'PUT', body: enc(chunk), headers: p.headers }))
        expect(res.status).toBe(200)
        parts.push({ partNumber: i + 1, etag: res.headers.get('etag') as string })
      }
      expect(await storage.head(key)).toBeNull()
      await storage.completeMultipartUpload(key, uploadId, parts)
      expect(await storage.head(key)).toEqual({ bytes: 10, contentType: 'video/mp4' })
      const got = await handle(new Request(await storage.presignGet(key, 60)))
      expect(await got.text()).toBe('aaaabbbbcc')
      await expect(storage.completeMultipartUpload(key, uploadId, parts)).rejects.toMatchObject({ code: 'not_found' })
    })

    it('rejects bad part lists and non-uniform parts', async () => {
      const key = sourceKey(USER, MEDIA2, 'mp4')
      const { uploadId } = await storage.createMultipartUpload(key, 'video/mp4')
      const etags: string[] = []
      for (const [i, chunk] of ['aaaa', 'bbbbb', 'c'].entries()) {
        const p = await storage.presignUploadPart(key, uploadId, i + 1, chunk.length)
        const res = await handle(new Request(p.url, { method: 'PUT', body: enc(chunk) }))
        etags.push(res.headers.get('etag') as string)
      }
      const list = etags.map((etag, i) => ({ partNumber: i + 1, etag }))
      await expect(storage.completeMultipartUpload(key, uploadId, list)).rejects.toMatchObject({ code: 'validation' })
      await expect(storage.completeMultipartUpload(key, uploadId, [list[1]!, list[0]!])).rejects.toMatchObject({
        code: 'validation',
      })
      await expect(
        storage.completeMultipartUpload(key, uploadId, [{ partNumber: 1, etag: '"0000"' }]),
      ).rejects.toMatchObject({ code: 'validation' })
      await expect(storage.completeMultipartUpload(key, uploadId, [])).rejects.toMatchObject({ code: 'validation' })
      await storage.abortMultipartUpload(key, uploadId)
      await storage.abortMultipartUpload(key, uploadId) // idempotent
      await expect(storage.completeMultipartUpload(key, uploadId, [list[0]!])).rejects.toMatchObject({ code: 'not_found' })
      const p = await storage.presignUploadPart(key, uploadId, 1, 4)
      expect((await handle(new Request(p.url, { method: 'PUT', body: enc('aaaa') }))).status).toBe(404)
    })

    it('validates multipart inputs', async () => {
      const key = sourceKey(USER, MEDIA, 'mp4')
      await expect(storage.presignUploadPart(key, 'bad id!', 1, 10)).rejects.toMatchObject({ code: 'validation' })
      await expect(storage.presignUploadPart(key, 'abc', 0, 10)).rejects.toMatchObject({ code: 'validation' })
      await expect(storage.presignUploadPart(key, 'abc', 10_001, 10)).rejects.toMatchObject({ code: 'validation' })
      await expect(storage.createMultipartUpload(key, 'nope')).rejects.toMatchObject({ code: 'validation' })
    })
  })
}

describe('FsStorage specifics', () => {
  it('keeps objects under objects/<key> with a metadata sidecar', async () => {
    const dir = join(fsRoot, 'layout')
    const storage = new FsStorage({ dir, baseUrl: BASE, signingSecret: SECRET })
    const key = uploadKey(USER, MEDIA, 'png')
    await storage.putBytes(key, enc('png!'), 'image/png')
    expect(await readFile(join(dir, 'objects', ...key.split('/')), 'utf8')).toBe('png!')
    const meta = JSON.parse(await readFile(join(dir, 'meta', ...`${key}.json`.split('/')), 'utf8'))
    expect(meta).toMatchObject({ contentType: 'image/png', bytes: 4 })
    // Without the sidecar the type falls back to the extension.
    await rm(join(dir, 'meta'), { recursive: true })
    expect(await storage.head(key)).toEqual({ bytes: 4, contentType: 'image/png' })
    await storage.delete(key)
    await expect(stat(join(dir, 'objects', ...key.split('/')))).rejects.toThrow()
  })

  it('streams putFile and getToFile for larger files', async () => {
    const dir = join(fsRoot, 'large')
    const storage = new FsStorage({ dir, baseUrl: BASE, signingSecret: SECRET })
    const src = join(fsRoot, 'large-src.bin')
    const data = Buffer.alloc(3 * 1024 * 1024, 7)
    await writeFile(src, data)
    const key = sourceKey(USER, MEDIA, 'mp4')
    await storage.putFile(key, src, 'video/mp4')
    const out = join(fsRoot, 'large-out', 'x.mp4')
    await storage.getToFile(key, out)
    expect((await readFile(out)).equals(data)).toBe(true)
  })

  it('requires a directory, an absolute base URL and a long enough secret', () => {
    expect(() => new FsStorage({ dir: '', baseUrl: BASE, signingSecret: SECRET })).toThrow()
    expect(() => new FsStorage({ dir: fsRoot, baseUrl: '/api/dev-storage', signingSecret: SECRET })).toThrow()
    expect(() => new FsStorage({ dir: fsRoot, baseUrl: 'ftp://x/y', signingSecret: SECRET })).toThrow()
    expect(() => new FsStorage({ dir: fsRoot, baseUrl: BASE, signingSecret: 'short' })).toThrow()
  })

  it('shares signed URLs between instances with the same secret (web + worker)', async () => {
    const dir = join(fsRoot, 'shared')
    const worker = new FsStorage({ dir, baseUrl: BASE, signingSecret: SECRET })
    const web = new FsStorage({ dir, baseUrl: BASE, signingSecret: SECRET })
    const key = clipKey(USER, MEDIA)
    await worker.putBytes(key, enc('clip'), 'video/mp4')
    const res = await createLocalStorageHandler(web)(new Request(await worker.presignGet(key, 60)))
    expect(await res.text()).toBe('clip')
    const other = new FsStorage({ dir, baseUrl: BASE, signingSecret: 'another-secret-0123456789' })
    expect((await createLocalStorageHandler(other)(new Request(await worker.presignGet(key, 60)))).status).toBe(403)
  })
})

describe('MemoryStorage helpers', () => {
  it('exposes stored bytes and keys for assertions', async () => {
    const storage = new MemoryStorage()
    const key = uploadKey(USER, MEDIA, 'jpg')
    const bytes = enc('jpeg')
    await storage.putBytes(key, bytes, 'image/jpeg')
    bytes[0] = 0 // stored copy is independent
    expect(new TextDecoder().decode(storage.getBytes(key) as Uint8Array)).toBe('jpeg')
    expect(storage.has(key)).toBe(true)
    expect(storage.keys(`users/${USER}/`)).toEqual([key])
    const { uploadId } = await storage.createMultipartUpload(key, 'image/jpeg')
    expect(storage.openUploads()).toEqual([uploadId])
    storage.clear()
    expect(storage.keys()).toEqual([])
    expect(storage.openUploads()).toEqual([])
  })
})

describe('parseRange', () => {
  it('handles the single-range forms', () => {
    expect(parseRange(null, 10)).toBeNull()
    expect(parseRange('bytes=0-0', 10)).toEqual({ start: 0, end: 1 })
    expect(parseRange('bytes=5-100', 10)).toEqual({ start: 5, end: 10 })
    expect(parseRange('bytes=-100', 10)).toEqual({ start: 0, end: 10 })
    expect(parseRange('bytes=-0', 10)).toBe('invalid')
    expect(parseRange('bytes=10-', 10)).toBe('invalid')
    expect(parseRange('bytes=0-1,3-4', 10)).toBeNull()
    expect(parseRange('items=0-1', 10)).toBeNull()
  })
})
