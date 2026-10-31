// Bucket checks for /setup: HeadBucket, Get/PutBucketCors on R2 (mocked S3 client), the same
// methods on the local drivers, and the CORS policy helpers.

import { describe, expect, it, vi } from 'vitest'
import {
  corsPolicyJson,
  corsProblems,
  originOf,
  supportsBucketAdmin,
  uploadCorsRule,
  withUploadCorsRule,
  type CorsRule,
} from '../src/bucket'
import { createStorageFromConfig } from '../src/factory'
import { MemoryStorage } from '../src/local/memory'
import { R2Storage } from '../src/r2'
import { storageErrorReason } from '../src/errors'
import { S3Error } from './helpers'

const SECRET = 'r2-secret-access-key-do-not-leak-0123456789'
const APP = 'https://app.example.com'

function r2(send: (command: { constructor: { name: string }; input: Record<string, unknown> }) => Promise<unknown>) {
  const client = { send: vi.fn(send) }
  return { client, storage: new R2Storage({ accountId: 'abc123', accessKeyId: 'AKIA', secretAccessKey: SECRET, bucket: 'media-bucket' }, { client }) }
}

describe('CORS helpers', () => {
  it('builds the upload rule for the app origin (path and trailing slash dropped)', () => {
    expect(originOf('https://app.example.com/some/path/')).toBe(APP)
    expect(uploadCorsRule(`${APP}/`)).toEqual({
      allowedOrigins: [APP],
      allowedMethods: ['PUT', 'GET', 'HEAD'],
      allowedHeaders: ['content-type'],
      exposeHeaders: ['ETag'],
      maxAgeSeconds: 3600,
    })
    expect(() => originOf('not a url')).toThrow()
  })

  it('finds what a policy lacks for browser uploads', () => {
    expect(corsProblems([uploadCorsRule(APP)], APP)).toEqual([])
    expect(corsProblems([], APP)).toEqual([`No CORS rule allows ${APP}.`])
    expect(corsProblems([{ ...uploadCorsRule('https://other.example.com') }], APP)).toHaveLength(1)
    const weak: CorsRule = { allowedOrigins: [APP], allowedMethods: ['GET'], allowedHeaders: [], exposeHeaders: [] }
    expect(corsProblems([weak], APP)).toEqual([
      'The CORS rule does not allow PUT.',
      'The CORS rule does not allow the Content-Type header.',
      'The CORS rule does not expose the ETag header (needed for large uploads).',
    ])
    const wildcard: CorsRule = { allowedOrigins: ['https://*.example.com'], allowedMethods: ['PUT', 'GET'], allowedHeaders: ['*'], exposeHeaders: ['etag'] }
    expect(corsProblems([wildcard], APP)).toEqual([])
    expect(corsProblems([{ ...wildcard, allowedOrigins: ['*'] }], APP)).toEqual([])
  })

  it('adds our rule and keeps rules for other origins', () => {
    const other: CorsRule = { allowedOrigins: ['https://staging.example.com', APP], allowedMethods: ['GET'], allowedHeaders: [], exposeHeaders: [] }
    const merged = withUploadCorsRule([other], APP)
    expect(merged).toEqual([{ ...other, allowedOrigins: ['https://staging.example.com'] }, uploadCorsRule(APP)])
    expect(withUploadCorsRule([uploadCorsRule(APP)], APP)).toEqual([uploadCorsRule(APP)])
  })

  it('prints the policy the way the Cloudflare dashboard takes it', () => {
    expect(JSON.parse(corsPolicyJson([uploadCorsRule(APP)]))).toEqual([
      { AllowedOrigins: [APP], AllowedMethods: ['PUT', 'GET', 'HEAD'], AllowedHeaders: ['content-type'], ExposeHeaders: ['ETag'], MaxAgeSeconds: 3600 },
    ])
  })
})

describe('R2Storage bucket checks', () => {
  it('HeadBucket on the configured bucket', async () => {
    const { client, storage } = r2(async () => ({}))
    await storage.headBucket()
    const command = client.send.mock.calls[0]?.[0]
    expect(command?.constructor.name).toBe('HeadBucketCommand')
    expect(command?.input).toEqual({ Bucket: 'media-bucket' })
  })

  it('maps refused credentials and a missing bucket without leaking the secret', async () => {
    const denied = r2(async () => {
      throw new S3Error('AccessDenied', 403)
    })
    const err = await denied.storage.headBucket().catch((e: unknown) => e as Error)
    expect(storageErrorReason(err)).toBe('storage_auth')
    expect(JSON.stringify(err)).not.toContain(SECRET)
    const missing = r2(async () => {
      throw new S3Error('NoSuchBucket', 404)
    })
    expect(storageErrorReason(await missing.storage.headBucket().catch((e: unknown) => e))).toBe('not_found')
  })

  it('reads CORS rules, and no configuration as []', async () => {
    const { storage } = r2(async () => ({
      CORSRules: [{ AllowedOrigins: [APP], AllowedMethods: ['PUT', 'GET'], AllowedHeaders: ['content-type'], ExposeHeaders: ['ETag'], MaxAgeSeconds: 600 }],
    }))
    expect(await storage.getBucketCors()).toEqual([
      { allowedOrigins: [APP], allowedMethods: ['PUT', 'GET'], allowedHeaders: ['content-type'], exposeHeaders: ['ETag'], maxAgeSeconds: 600 },
    ])
    const none = r2(async () => {
      throw new S3Error('NoSuchCORSConfiguration', 404)
    })
    expect(await none.storage.getBucketCors()).toEqual([])
    const denied = r2(async () => {
      throw new S3Error('AccessDenied', 403)
    })
    expect(storageErrorReason(await denied.storage.getBucketCors().catch((e: unknown) => e))).toBe('storage_auth')
  })

  it('writes CORS rules (validated first)', async () => {
    const { client, storage } = r2(async () => ({}))
    await storage.putBucketCors([uploadCorsRule(APP)])
    const command = client.send.mock.calls[0]?.[0]
    expect(command?.constructor.name).toBe('PutBucketCorsCommand')
    expect(command?.input).toEqual({
      Bucket: 'media-bucket',
      CORSConfiguration: {
        CORSRules: [{ AllowedOrigins: [APP], AllowedMethods: ['PUT', 'GET', 'HEAD'], AllowedHeaders: ['content-type'], ExposeHeaders: ['ETag'], MaxAgeSeconds: 3600 }],
      },
    })
    await expect(storage.putBucketCors([])).rejects.toMatchObject({ code: 'validation' })
    await expect(storage.putBucketCors([{ ...uploadCorsRule(APP), allowedMethods: ['PATCH'] }])).rejects.toMatchObject({ code: 'validation' })
    expect(client.send).toHaveBeenCalledTimes(1)
  })
})

describe('local drivers', () => {
  it('support the same checks (CORS kept in memory)', async () => {
    const storage = new MemoryStorage({ baseUrl: 'http://localhost:3000/api/dev-storage', signingSecret: 'local-signing-secret-0123' })
    expect(supportsBucketAdmin(storage)).toBe(true)
    await storage.headBucket()
    expect(await storage.getBucketCors()).toEqual([])
    await storage.putBucketCors([uploadCorsRule(APP)])
    expect(corsProblems(await storage.getBucketCors(), APP)).toEqual([])
  })

  it('every factory driver exposes the bucket checks', () => {
    const base = { APP_URL: APP, SESSION_SECRET: undefined, STORAGE_FS_DIR: '/tmp/x', R2_ACCOUNT_ID: 'abc', R2_ACCESS_KEY_ID: 'a', R2_SECRET_ACCESS_KEY: 'b', R2_BUCKET: 'media-bucket', R2_ENDPOINT: undefined }
    for (const driver of ['r2', 'memory'] as const) {
      expect(supportsBucketAdmin(createStorageFromConfig({ ...base, STORAGE_DRIVER: driver }, { s3Client: { send: async () => ({}) } }))).toBe(true)
    }
    expect(supportsBucketAdmin({ head: async () => null })).toBe(false)
  })
})
