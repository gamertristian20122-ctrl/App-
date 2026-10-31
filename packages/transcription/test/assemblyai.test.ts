import { rm } from 'node:fs/promises'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { memoryLogger } from '@app/core/testing'
import { TranscriptResultSchema } from '@app/core/validation'
import { AssemblyAITranscriber, type AssemblyAIOptions } from '../src/assemblyai'
import { transcriptionErrorReason } from '../src/errors'
import { ASSEMBLY_COMPLETED, hang, json, mockFetch, tempAudio, virtualTime, type Responder } from './helpers'

const KEY = 'aai-secret-key-0123456789abcdef'
const BASE = 'https://api.assemblyai.com'
const UPLOAD_URL = 'https://cdn.assemblyai.com/upload/f756988d-47e2'
let dir: string
let audio: string

beforeAll(async () => {
  const t = await tempAudio('source.m4a', 'fake m4a payload')
  dir = t.dir
  audio = t.path
})
afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function failure(p: Promise<unknown>) {
  return p.then(
    () => {
      throw new Error('expected a failure')
    },
    (e: unknown) => e as Error & { code?: string; details?: Record<string, unknown> },
  )
}

const uploaded = () => json({ upload_url: UPLOAD_URL })
const created = (status = 'queued') => json({ id: 'tr_abc123', status })
const deleted = () => json({ id: 'tr_abc123', status: 'completed' })

function make(responders: Array<Responder | Response>, options: Partial<AssemblyAIOptions> = {}) {
  const m = mockFetch(responders)
  const time = virtualTime()
  const logger = memoryLogger()
  const t = new AssemblyAITranscriber({ apiKey: KEY, fetch: m.fetch, sleep: time.sleep, now: time.now, logger, ...options })
  return { t, m, time, logger }
}

describe('AssemblyAITranscriber', () => {
  it('uploads, creates, polls with backoff, normalises and deletes the transcript', async () => {
    const { t, m, time, logger } = make([
      uploaded(),
      created(),
      json({ id: 'tr_abc123', status: 'queued' }),
      json({ id: 'tr_abc123', status: 'processing' }),
      json(ASSEMBLY_COMPLETED),
      deleted(),
    ])
    const result = await t.transcribe({ filePath: audio })

    const [upload, create, ...rest] = m.calls
    expect(upload!.url).toBe(`${BASE}/v2/upload`)
    expect(upload!.method).toBe('POST')
    expect(upload!.headers.authorization).toBe(KEY)
    expect(upload!.headers['content-type']).toBe('application/octet-stream')
    expect(await (upload!.init.body as Blob).text()).toBe('fake m4a payload')

    expect(create!.url).toBe(`${BASE}/v2/transcript`)
    expect(JSON.parse(create!.init.body as string)).toEqual({
      audio_url: UPLOAD_URL,
      punctuate: true,
      format_text: true,
      language_detection: true,
    })
    expect(rest.map((c) => `${c.method} ${c.url}`)).toEqual([
      `GET ${BASE}/v2/transcript/tr_abc123`,
      `GET ${BASE}/v2/transcript/tr_abc123`,
      `GET ${BASE}/v2/transcript/tr_abc123`,
      `DELETE ${BASE}/v2/transcript/tr_abc123`,
    ])
    expect(time.sleeps).toEqual([3000, 4500, 6750])

    expect(result.language).toBe('en')
    expect(result.durationMs).toBe(3400) // audio_duration 3 s is rounded; the last word ends later
    expect(result.text).toBe('Hello world. This is a test.')
    expect(result.words[0]).toEqual({ s: 100, e: 420, t: 'Hello' })
    expect(result.segments).toEqual([
      { s: 100, e: 900, t: 'Hello world.' },
      { s: 1500, e: 3400, t: 'This is a test.' },
    ])
    expect(TranscriptResultSchema.safeParse(result).success).toBe(true)
    expect(logger.text()).not.toContain(KEY)
  })

  it('sends a language code and speech models when given, and the EU base URL', async () => {
    const { t, m } = make([uploaded(), created(), json(ASSEMBLY_COMPLETED), deleted()], {
      baseUrl: 'https://api.eu.assemblyai.com/',
      speechModels: ['universal-2'],
      deleteAfter: true,
    })
    await t.transcribe({ filePath: audio, language: 'en-US' })
    expect(m.calls[0]!.url).toBe('https://api.eu.assemblyai.com/v2/upload')
    expect(JSON.parse(m.calls[1]!.init.body as string)).toEqual({
      audio_url: UPLOAD_URL,
      punctuate: true,
      format_text: true,
      language_code: 'en_us',
      speech_models: ['universal-2'],
    })
  })

  it('reports an engine failure with a safe message and still deletes', async () => {
    const { t, m } = make([
      uploaded(),
      created(),
      json({ id: 'tr_abc123', status: 'error', error: `Transcoding failed. File does not appear to contain audio. key=${KEY}` }),
      deleted(),
    ])
    const err = await failure(t.transcribe({ filePath: audio }))
    expect(transcriptionErrorReason(err)).toBe('engine_failed')
    expect(err.code).toBe('bad_request')
    expect(err.message).toContain('does not appear to contain audio')
    expect(err.message).not.toContain(KEY)
    expect(m.calls.at(-1)!.method).toBe('DELETE')
  })

  it('fails immediately when the create call already reports an error', async () => {
    const { t } = make([uploaded(), json({ id: 'tr_abc123', status: 'error', error: 'Unsupported language' }), deleted()])
    const err = await failure(t.transcribe({ filePath: audio }))
    expect(transcriptionErrorReason(err)).toBe('engine_failed')
    expect(err.message).toContain('Unsupported language')
  })

  it('times out after the overall limit and cleans up', async () => {
    const polls = Array.from({ length: 50 }, () => json({ id: 'tr_abc123', status: 'processing' }))
    const { t, m, time } = make([uploaded(), created(), ...polls, deleted()], { timeoutMs: 60_000, deleteAfter: true })
    const err = await failure(t.transcribe({ filePath: audio }))
    expect(transcriptionErrorReason(err)).toBe('timeout')
    expect(time.sleeps.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(60_000)
    expect(m.calls.at(-1)!.method).toBe('DELETE')
  })

  it('tolerates transient poll failures and honours Retry-After on 429', async () => {
    const { t, time } = make([
      uploaded(),
      created(),
      json({ error: 'busy' }, 503),
      () => Promise.reject(new TypeError('fetch failed')),
      json({ error: 'Too many requests' }, 429, { 'retry-after': '20' }),
      json(ASSEMBLY_COMPLETED),
      deleted(),
    ])
    const r = await t.transcribe({ filePath: audio })
    expect(r.words).toHaveLength(6)
    expect(time.sleeps).toEqual([3000, 4500, 6750, 20_000])
  })

  it('gives up after too many consecutive poll failures', async () => {
    const { t } = make([uploaded(), created(), json({}, 500), json({}, 500), json({}, 500), deleted()], { maxPollFailures: 2 })
    const err = await failure(t.transcribe({ filePath: audio }))
    expect(transcriptionErrorReason(err)).toBe('engine_unavailable')
  })

  it('maps upload errors and stops there', async () => {
    const { t, m } = make([json({ error: 'Invalid API key' }, 401)])
    const err = await failure(t.transcribe({ filePath: audio }))
    expect(transcriptionErrorReason(err)).toBe('engine_auth')
    expect(m.calls).toHaveLength(1)
    expect(err.message).not.toContain(KEY)
  })

  it.each([
    ['upload without upload_url', [json({ url: 'x' })]],
    ['upload with a non-URL', [json({ upload_url: 'not a url' })]],
    ['create without id', [uploaded(), json({ status: 'queued' })]],
    ['create with an odd id', [uploaded(), json({ id: '../../etc', status: 'queued' })]],
    ['poll with words of the wrong type', [uploaded(), created(), json({ ...ASSEMBLY_COMPLETED, words: [{ text: 'x', start: '1', end: 2 }] }), deleted()]],
    ['poll for another transcript', [uploaded(), created(), json({ ...ASSEMBLY_COMPLETED, id: 'other' }), deleted()]],
    ['poll that is not JSON', [uploaded(), created(), new Response('<html>', { status: 200 }), deleted()]],
  ])('rejects a malformed response: %s', async (_name, responders) => {
    const { t } = make(responders as Response[])
    const err = await failure(t.transcribe({ filePath: audio }))
    expect(transcriptionErrorReason(err)).toBe('malformed_response')
  })

  it('stops polling when the caller aborts', async () => {
    const controller = new AbortController()
    const { t, m } = make(
      [
        uploaded(),
        created(),
        () => {
          controller.abort()
          return json({ id: 'tr_abc123', status: 'processing' })
        },
        deleted(),
      ],
      {},
    )
    const err = await failure(t.transcribe({ filePath: audio, signal: controller.signal }))
    expect(transcriptionErrorReason(err)).toBe('aborted')
    expect(m.calls.at(-1)!.method).toBe('DELETE')
  })

  it('times out a hanging upload', async () => {
    const { t } = make([hang], { uploadTimeoutMs: 20 })
    expect(transcriptionErrorReason(await failure(t.transcribe({ filePath: audio })))).toBe('timeout')
  })

  it('skips deletion when disabled and survives a failed delete', async () => {
    const a = make([uploaded(), created(), json(ASSEMBLY_COMPLETED)], { deleteAfter: false })
    await a.t.transcribe({ filePath: audio })
    expect(a.m.calls.some((c) => c.method === 'DELETE')).toBe(false)

    const b = make([uploaded(), created(), json(ASSEMBLY_COMPLETED), json({ error: 'nope' }, 400)])
    await b.t.transcribe({ filePath: audio })
    expect(b.logger.lines.some((l) => l.msg === 'assemblyai transcript delete failed')).toBe(true)
  })

  it('validates its configuration', () => {
    expect(() => new AssemblyAITranscriber({ apiKey: '' })).toThrow()
    expect(() => new AssemblyAITranscriber({ apiKey: KEY, baseUrl: 'http://api.assemblyai.com' })).toThrow()
    expect(() => new AssemblyAITranscriber({ apiKey: KEY, baseUrl: 'nope' })).toThrow()
    expect(() => new AssemblyAITranscriber({ apiKey: KEY, baseUrl: 'http://localhost:9999' })).not.toThrow()
  })
})
