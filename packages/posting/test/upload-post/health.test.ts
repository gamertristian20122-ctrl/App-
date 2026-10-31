// healthCheck(): the owner's /setup page asks the adapter whether the API key works. One cheap
// authenticated read (GET /api/uploadposts/users), never throws, never echoes the key.

import { describe, expect, it } from 'vitest'
import { FakePostingProvider } from '../../src/fake'
import { API_KEY, BASE, makeProvider } from '../helpers'

describe('UploadPostProvider.healthCheck', () => {
  it('reads the profile list with the API key and reports the count', async () => {
    const { provider, calls } = makeProvider([{ json: { success: true, profiles: [{ username: 'a' }, { username: 'b' }], limit: 25 } }])
    const result = await provider.healthCheck()
    expect(result).toEqual({ ok: true, detail: 'Upload-Post accepted the API key (2 of 25 profiles in use).' })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.method).toBe('GET')
    expect(calls[0]?.url.toString()).toBe(`${BASE}/api/uploadposts/users`)
    expect(calls[0]?.headers.get('authorization')).toBe(`Apikey ${API_KEY}`)
  })

  it('works when the response has no profile list', async () => {
    const { provider } = makeProvider([{ json: { success: true } }])
    expect(await provider.healthCheck()).toEqual({ ok: true, detail: 'Upload-Post accepted the API key.' })
    const one = makeProvider([{ json: { profiles: [{}] } }])
    expect((await one.provider.healthCheck()).detail).toContain('1 profile in use')
  })

  it.each([
    [401, /refused the API key/],
    [403, /refused the API key/],
    [429, /busy/],
    [503, /could not be reached/],
    [400, /unexpected/],
  ])('reports HTTP %s as not ok without throwing or leaking the key', async (status, message) => {
    const { provider } = makeProvider([{ status, json: { success: false, message: `bad key ${API_KEY}` } }])
    const result = await provider.healthCheck()
    expect(result.ok).toBe(false)
    expect(result.detail).toMatch(message)
    expect(JSON.stringify(result)).not.toContain(API_KEY)
  })

  it('reports a network failure as not ok', async () => {
    const { provider } = makeProvider([new TypeError('fetch failed')])
    expect(await provider.healthCheck()).toEqual({ ok: false, detail: 'Upload-Post could not be reached. Try again in a minute.' })
  })
})

describe('FakePostingProvider.healthCheck', () => {
  it('is healthy and says it is test mode, unless scripted to fail', async () => {
    const fake = new FakePostingProvider()
    const ok = await fake.healthCheck()
    expect(ok.ok).toBe(true)
    expect(ok.detail).toMatch(/Test mode/)
    fake.failNext('healthCheck')
    expect((await fake.healthCheck()).ok).toBe(false)
    expect(fake.calls.filter((c) => c.method === 'healthCheck')).toHaveLength(2)
  })
})
