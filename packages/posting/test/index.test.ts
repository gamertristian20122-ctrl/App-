import { describe, expect, it } from 'vitest'
import { testConfig } from '@app/core/testing'
import {
  FakePostingProvider,
  UploadPostProvider,
  createPostingProvider,
  createPostingProviderFromConfig,
  PROVIDER_ERROR_REASONS,
  ERROR_CODE_BY_REASON,
} from '../src'
import { API_KEY, mockFetch } from './helpers'

describe('createPostingProvider', () => {
  it('builds the fake', () => {
    const p = createPostingProvider({ kind: 'fake' })
    expect(p).toBeInstanceOf(FakePostingProvider)
    expect(p.name).toBe('fake')
  })

  it('builds the Upload-Post adapter with injected fetch', async () => {
    const m = mockFetch([{ json: { profile: { username: 'brand_x', social_accounts: {} } } }])
    const p = createPostingProvider({ kind: 'upload_post', apiKey: API_KEY, fetch: m.fetch })
    expect(p).toBeInstanceOf(UploadPostProvider)
    expect(p.name).toBe('upload_post')
    expect(await p.listAccounts('brand_x')).toEqual([])
    expect(m.calls).toHaveLength(1)
  })

  it('throws for an unknown kind', () => {
    expect(() => createPostingProvider({ kind: 'nope' } as never)).toThrow(/Unknown posting provider/)
  })
})

describe('createPostingProviderFromConfig', () => {
  it('defaults to the fake', () => {
    expect(createPostingProviderFromConfig(testConfig())).toBeInstanceOf(FakePostingProvider)
  })

  it('passes FAKE_POSTING_CONNECT_ALL to the fake provider', async () => {
    const provider = createPostingProviderFromConfig(testConfig({ FAKE_POSTING_CONNECT_ALL: '1' }))
    expect(await provider.listAccounts('fake_brand_x')).toHaveLength(9)
  })

  it('uses UPLOAD_POST_API_KEY and UPLOAD_POST_BASE_URL', async () => {
    const m = mockFetch([{ json: { profile: { username: 'b', social_accounts: {} } } }])
    const config = testConfig({ POSTING_PROVIDER: 'upload_post', UPLOAD_POST_API_KEY: API_KEY, UPLOAD_POST_BASE_URL: 'https://proxy.test' })
    const p = createPostingProviderFromConfig(config, { fetch: m.fetch })
    expect(p).toBeInstanceOf(UploadPostProvider)
    await p.listAccounts('b')
    expect(m.last().url.origin).toBe('https://proxy.test')
  })

  it('reads UPLOAD_POST_PROFILE_PREFIX from config (deps override it)', async () => {
    const brandId = '0b6a1f0e-1c2d-4e3f-8a9b-0c1d2e3f4a5b'
    const config = testConfig({ POSTING_PROVIDER: 'upload_post', UPLOAD_POST_API_KEY: API_KEY, UPLOAD_POST_PROFILE_PREFIX: 'stg_' })
    const m = mockFetch([{ status: 201, json: {} }, { status: 201, json: {} }])
    const fromConfig = createPostingProviderFromConfig(config, { fetch: m.fetch })
    expect((await fromConfig.ensureProfile({ brandId, displayName: 'A' })).profileRef).toBe(`stg_${brandId}`)
    const overridden = createPostingProviderFromConfig(config, { fetch: m.fetch, profilePrefix: 'dev_' })
    expect((await overridden.ensureProfile({ brandId, displayName: 'A' })).profileRef).toBe(`dev_${brandId}`)
  })
})

describe('error reasons', () => {
  it('every reason maps to a core error code', () => {
    for (const r of PROVIDER_ERROR_REASONS) expect(ERROR_CODE_BY_REASON[r]).toBeTruthy()
    expect(ERROR_CODE_BY_REASON.provider_auth).toBe('unavailable')
  })
})
