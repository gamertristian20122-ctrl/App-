// Browser uploads: presign (validation through services.media), the local dev-storage PUT/GET,
// and completion (size/type check, ingest job for videos).

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { GET as storageGet, PUT as storagePut } from '@/app/api/dev-storage/[...key]/route'
import { POST as complete } from '@/app/api/uploads/[id]/complete/route'
import { POST as createUpload } from '@/app/api/uploads/route'
import { BASE, createHarness, params, readJson, request, type Harness } from './harness'

let h: Harness
let user: { id: string; email: string }
let cookie: string

beforeAll(async () => {
  h = await createHarness()
  user = await h.createUser('uploader@example.com')
  cookie = h.cookie(user.email)
})
afterAll(async () => {
  await h.close()
})

interface Created {
  media: { id: string; status: string; kind: string; rightsAttestedAt: string | null }
  upload: { mode: string; method: string; url: string; headers: Record<string, string>; bytes: number }
}

const start = (json: unknown, extra: { cookie?: string; headers?: Record<string, string> } = {}) =>
  createUpload(request('/api/uploads', { json, cookie: extra.cookie ?? cookie, ...(extra.headers ? { headers: extra.headers } : {}) }))

describe('POST /api/uploads', () => {
  it('needs a signed-in, same-origin request', async () => {
    expect((await start({ filename: 'a.png', contentType: 'image/png', bytes: 10 }, { cookie: '' })).status).toBe(401)
    expect((await start({ filename: 'a.png', contentType: 'image/png', bytes: 10 }, { headers: { origin: 'https://evil.example' } })).status).toBe(403)
  })

  it('validates type, size, purpose and the rights attestation', async () => {
    const cases: Array<[unknown, number]> = [
      [{ filename: 'a.svg', contentType: 'image/svg+xml', bytes: 10 }, 400],
      [{ filename: 'a.png', contentType: 'image/png', bytes: 0 }, 400],
      [{ filename: 'a.png', contentType: 'image/png', bytes: 10, extra: true }, 400],
      [{ filename: 'a/b.png', contentType: 'image/png', bytes: 10 }, 400],
      [{ filename: 'a.mp4', contentType: 'video/mp4', bytes: 20_000_000_000 }, 400],
      [{ purpose: 'clip_source', filename: 'a.mp4', contentType: 'video/mp4', bytes: 1000 }, 400],
      [{ purpose: 'clip_source', filename: 'a.png', contentType: 'image/png', bytes: 1000, rightsAttested: true }, 400],
      [{ purpose: 'backup', filename: 'a.png', contentType: 'image/png', bytes: 10 }, 400],
    ]
    for (const [body, status] of cases) {
      const res = await start(body)
      expect(res.status, JSON.stringify(body)).toBe(status)
      expect((await readJson<{ error: { code: string } }>(res)).error.code).toBe('validation')
    }
    const form = await createUpload(request('/api/uploads', { form: { filename: 'a.png' }, cookie }))
    expect(form.status).toBe(415)
  })

  it('presigns a PUT, accepts the upload through dev storage and completes it', async () => {
    const bytes = new TextEncoder().encode('fake png bytes')
    const res = await start({ filename: 'photo.png', contentType: 'image/png', bytes: bytes.byteLength })
    expect(res.status).toBe(201)
    const created = await readJson<Created>(res)
    expect(created.media).toMatchObject({ status: 'pending', kind: 'image' })
    expect(created.upload).toMatchObject({ mode: 'single', method: 'PUT', bytes: bytes.byteLength })
    expect(created.upload.url.startsWith(`${BASE}/api/dev-storage/users/${user.id}/uploads/`)).toBe(true)

    // completing before the bytes arrive fails without breaking the upload
    let done = await complete(request(`/api/uploads/${created.media.id}/complete`, { json: {}, cookie }), params({ id: created.media.id }))
    expect(done.status).toBe(400)

    // the browser PUT, through the dev-storage route
    const put = await storagePut(new Request(created.upload.url, { method: 'PUT', headers: created.upload.headers, body: bytes }))
    expect(put.status).toBe(200)
    const get = await storageGet(new Request(created.upload.url.replace('op=put', 'op=get')))
    expect(get.status).toBe(403) // the PUT signature does not grant reads

    done = await complete(request(`/api/uploads/${created.media.id}/complete`, { json: {}, cookie }), params({ id: created.media.id }))
    expect(done.status).toBe(200)
    expect(await readJson(done)).toMatchObject({ media: { id: created.media.id, status: 'ready' }, ingestQueued: false })
  })

  it('queues ingest for a rights-attested clip source', async () => {
    const bytes = new Uint8Array(2048)
    const res = await start({ purpose: 'clip_source', filename: 'talk.mp4', contentType: 'video/mp4', bytes: bytes.byteLength, rightsAttested: true })
    expect(res.status).toBe(201)
    const created = await readJson<Created>(res)
    expect(created.media.rightsAttestedAt).not.toBeNull()
    await storagePut(new Request(created.upload.url, { method: 'PUT', headers: created.upload.headers, body: bytes }))
    const done = await complete(request(`/api/uploads/${created.media.id}/complete`, { json: {}, cookie }), params({ id: created.media.id }))
    expect(done.status).toBe(200)
    expect(await readJson(done)).toMatchObject({ ingestQueued: true })
  })

  it('refuses a body that does not match the declared size, and other users', async () => {
    const res = await start({ filename: 'x.png', contentType: 'image/png', bytes: 100 })
    const created = await readJson<Created>(res)
    const wrong = await storagePut(new Request(created.upload.url, { method: 'PUT', headers: created.upload.headers, body: new Uint8Array(50) }))
    expect(wrong.status).toBeGreaterThanOrEqual(400)

    const other = await h.createUser('other-uploader@example.com')
    const done = await complete(request(`/api/uploads/${created.media.id}/complete`, { json: {}, cookie: h.cookie(other.email) }), params({ id: created.media.id }))
    expect(done.status).toBe(404)
    const malformed = await complete(request('/api/uploads/not-a-uuid/complete', { json: {}, cookie }), params({ id: 'not-a-uuid' }))
    expect(malformed.status).toBe(404)
  })
})

describe('/api/dev-storage', () => {
  it('rejects unsigned and tampered URLs', async () => {
    const malformed = await storageGet(request(`/api/dev-storage/users/${user.id}/uploads/x.png?op=get&exp=9999999999&sig=00`))
    expect(malformed.status).toBe(400)
    const forged = await storageGet(request(`/api/dev-storage/users/${user.id}/uploads/x.png?op=get&exp=9999999999&sig=${'ab'.repeat(32)}`))
    expect(forged.status).toBe(403)
  })

  it('is 404 unless storage is local and the app is not in production', async () => {
    h.install({ runtime: { ...h.rt, storage: { presignPut: async () => ({ url: '', headers: {} }) } as never } })
    expect((await storageGet(request(`/api/dev-storage/users/${user.id}/uploads/x.png`))).status).toBe(404)
    h.install({ runtime: { ...h.rt, config: { ...h.rt.config, APP_ENV: 'production' } } })
    expect((await storageGet(request(`/api/dev-storage/users/${user.id}/uploads/x.png`))).status).toBe(404)
    h.install()
  })
})
