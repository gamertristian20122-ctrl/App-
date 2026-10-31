import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { testConfig, TEST_SESSION_SECRET } from '@app/core/testing'
import * as storageModule from '../src/index'
import {
  createLocalStorageHandler,
  createStorageFromConfig,
  DEV_STORAGE_FALLBACK_SECRET,
  devStorageBaseUrl,
  FsStorage,
  isLocalStorage,
  MemoryStorage,
  R2Storage,
  supportsMultipart,
  uploadKey,
} from '../src/index'
import { createFakeS3, MEDIA, tempDir, USER } from './helpers'

describe('createStorageFromConfig', () => {
  it('creates MemoryStorage for the test config, with URLs on the dev-storage route', async () => {
    const storage = createStorageFromConfig(testConfig())
    expect(storage).toBeInstanceOf(MemoryStorage)
    expect(storage.driver).toBe('memory')
    expect(isLocalStorage(storage)).toBe(true)
    expect(supportsMultipart(storage)).toBe(true)
    const { url } = await storage.presignPut(uploadKey(USER, MEDIA, 'mp4'), 'video/mp4', 3)
    expect(url.startsWith('http://localhost:3000/api/dev-storage/users/')).toBe(true)
  })

  it('creates FsStorage in the configured directory, signing with SESSION_SECRET', async () => {
    const dir = await tempDir('factory-')
    try {
      const config = testConfig({ STORAGE_DRIVER: 'fs', STORAGE_FS_DIR: join(dir, 'store'), APP_URL: 'http://127.0.0.1:4000/' })
      const storage = createStorageFromConfig(config)
      expect(storage).toBeInstanceOf(FsStorage)
      expect((storage as FsStorage).dir).toBe(join(dir, 'store'))
      const key = uploadKey(USER, MEDIA, 'mp4')
      const { url, headers } = await storage.presignPut(key, 'video/mp4', 3)
      expect(url.startsWith('http://127.0.0.1:4000/api/dev-storage/')).toBe(true)
      // A second instance (another process) with the same config accepts the URL.
      const web = new FsStorage({ dir: join(dir, 'store'), baseUrl: devStorageBaseUrl(config.APP_URL), signingSecret: TEST_SESSION_SECRET })
      const res = await createLocalStorageHandler(web)(new Request(url, { method: 'PUT', headers, body: new Uint8Array([1, 2, 3]) }))
      expect(res.status).toBe(200)
      expect(await storage.head(key)).toEqual({ bytes: 3, contentType: 'video/mp4' })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('falls back to a dev-only signing secret without SESSION_SECRET', async () => {
    const storage = createStorageFromConfig(testConfig({ DEV_AUTH: '0', SESSION_SECRET: undefined }))
    const other = new MemoryStorage({ signingSecret: DEV_STORAGE_FALLBACK_SECRET })
    const url = await storage.presignGet(uploadKey(USER, MEDIA, 'mp4'), 60)
    expect((await createLocalStorageHandler(other)(new Request(url))).status).toBe(404) // signature ok, object missing
  })

  it('creates R2Storage from the R2 variables', async () => {
    const config = testConfig({
      STORAGE_DRIVER: 'r2',
      R2_ACCOUNT_ID: 'acct42',
      R2_ACCESS_KEY_ID: 'AKIATEST',
      R2_SECRET_ACCESS_KEY: 'secret-value-123',
      R2_BUCKET: 'my-bucket',
    })
    const s3 = createFakeS3()
    const storage = createStorageFromConfig(config, { s3Client: s3 })
    expect(storage).toBeInstanceOf(R2Storage)
    expect(isLocalStorage(storage)).toBe(false)
    const url = new URL(await storage.presignGet(uploadKey(USER, MEDIA, 'mp4'), 60))
    expect(url.host).toBe('acct42.r2.cloudflarestorage.com')
    expect(url.pathname.startsWith('/my-bucket/users/')).toBe(true)
    await storage.putBytes(uploadKey(USER, MEDIA, 'mp4'), new Uint8Array([1]), 'video/mp4')
    expect(s3.send).toHaveBeenCalledTimes(1)
  })

  it('fails clearly when R2 variables are missing', () => {
    const config = { ...testConfig(), STORAGE_DRIVER: 'r2' as const }
    expect(() => createStorageFromConfig(config)).toThrow(/R2 storage is not configured/)
  })

  it('exports the public surface', () => {
    for (const name of [
      'sourceKey',
      'clipKey',
      'renderKey',
      'uploadKey',
      'R2Storage',
      'FsStorage',
      'MemoryStorage',
      'createLocalStorageHandler',
      'createStorageFromConfig',
      'planParts',
      'storageErrorReason',
    ]) {
      expect(storageModule, name).toHaveProperty(name)
    }
  })
})

describe('planParts', () => {
  it('splits into uniform parts and grows parts to stay under 10,000', async () => {
    const { planParts, MIN_PART_BYTES, MAX_PARTS } = storageModule
    const plan = planParts(2 * MIN_PART_BYTES + 1, MIN_PART_BYTES)
    expect(plan.map((p) => p.bytes)).toEqual([MIN_PART_BYTES, MIN_PART_BYTES, 1])
    expect(plan[2]).toMatchObject({ partNumber: 3, start: 2 * MIN_PART_BYTES, end: 2 * MIN_PART_BYTES + 1 })
    const huge = planParts(49_000_000_000, MIN_PART_BYTES)
    expect(huge.length).toBeLessThanOrEqual(MAX_PARTS)
    expect(new Set(huge.slice(0, -1).map((p) => p.bytes)).size).toBe(1)
    expect(huge.reduce((n, p) => n + p.bytes, 0)).toBe(49_000_000_000)
    expect(() => planParts(0)).toThrow()
    expect(() => planParts(10, 1024)).toThrow()
    expect(planParts(10)).toEqual([{ partNumber: 1, start: 0, end: 10, bytes: 10 }])
  })
})
