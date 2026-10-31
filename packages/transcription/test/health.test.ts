// Health checks for the owner's /setup page: one cheap authenticated call per engine (mocked
// fetch), never throwing and never echoing a key.

import { describe, expect, it } from 'vitest'
import { AssemblyAITranscriber } from '../src/assemblyai'
import { checkTranscriptionHealth, type TranscriptionConfig } from '../src/factory'
import { FakeTranscriber } from '../src/fake'
import { createFallbackTranscriber } from '../src/fallback'
import { WhisperTranscriber } from '../src/whisper'
import { json, mockFetch } from './helpers'

const AAI_KEY = 'aai-secret-key-0123456789abcdef'
const WHISPER_KEY = 'whisper-secret-key-0123456789'

const networkDown = () => {
  throw new TypeError('fetch failed')
}

describe('AssemblyAITranscriber.healthCheck', () => {
  it('lists one transcript with the key (free, starts nothing)', async () => {
    const m = mockFetch([json({ transcripts: [] })])
    const t = new AssemblyAITranscriber({ apiKey: AAI_KEY, fetch: m.fetch })
    expect(await t.healthCheck()).toEqual({ ok: true, detail: 'AssemblyAI accepted the API key.' })
    expect(m.calls[0]?.url).toBe('https://api.assemblyai.com/v2/transcript?limit=1')
    expect(m.calls[0]?.method).toBe('GET')
    expect(m.calls[0]?.headers.authorization).toBe(AAI_KEY)
  })

  it.each([
    [json({ error: 'Authentication error' }, 401), /refused ASSEMBLYAI_API_KEY/],
    [json({ error: 'busy' }, 429), /busy/],
    [json({ error: 'oops' }, 500), /HTTP 500/],
  ])('reports failures without the key (%#)', async (response, message) => {
    const m = mockFetch([response])
    const result = await new AssemblyAITranscriber({ apiKey: AAI_KEY, fetch: m.fetch }).healthCheck()
    expect(result.ok).toBe(false)
    expect(result.detail).toMatch(message)
    expect(JSON.stringify(result)).not.toContain(AAI_KEY)
  })

  it('reports an unreachable API', async () => {
    const m = mockFetch([networkDown])
    expect(await new AssemblyAITranscriber({ apiKey: AAI_KEY, fetch: m.fetch }).healthCheck()).toEqual({ ok: false, detail: 'AssemblyAI could not be reached.' })
  })
})

describe('WhisperTranscriber.healthCheck', () => {
  it('asks the models endpoint next to the transcription endpoint, with the bearer key', async () => {
    const m = mockFetch([json({ data: [] })])
    const t = new WhisperTranscriber({ url: 'http://whisper.railway.internal:8000/v1', apiKey: WHISPER_KEY, fetch: m.fetch })
    expect(await t.healthCheck()).toEqual({ ok: true, detail: 'The Whisper server answered.' })
    expect(m.calls[0]?.url).toBe('http://whisper.railway.internal:8000/v1/models')
    expect(m.calls[0]?.headers.authorization).toBe(`Bearer ${WHISPER_KEY}`)
  })

  it('counts a 404 as reachable, and reports refused keys, errors and an unreachable server', async () => {
    const make = (r: Response | (() => never)) => new WhisperTranscriber({ url: 'https://whisper.example', fetch: mockFetch([r]).fetch })
    expect((await make(new Response('nope', { status: 404 })).healthCheck()).ok).toBe(true)
    expect(await make(new Response('', { status: 401 })).healthCheck()).toEqual({ ok: false, detail: 'The Whisper server refused WHISPER_API_KEY.' })
    expect((await make(new Response('', { status: 502 })).healthCheck()).detail).toContain('HTTP 502')
    expect(await make(networkDown).healthCheck()).toEqual({ ok: false, detail: 'The Whisper server could not be reached at WHISPER_URL.' })
  })
})

describe('fake and chain', () => {
  it('the fake is healthy and says so; a scripted failure is reported', async () => {
    const fake = new FakeTranscriber()
    expect((await fake.healthCheck()).detail).toMatch(/Test mode/)
    fake.failNext()
    expect((await fake.healthCheck()).ok).toBe(false)
  })

  it('the chain is ok only when every engine is', async () => {
    const whisper = new FakeTranscriber({ name: 'whisper' })
    const assembly = new FakeTranscriber({ name: 'assemblyai' })
    const chain = createFallbackTranscriber([whisper, assembly])
    expect((await chain.healthCheck()).ok).toBe(true)
    whisper.failNext()
    const result = await chain.healthCheck()
    expect(result.ok).toBe(false)
    expect(result.detail).toMatch(/^Whisper: .*unavailable.* AssemblyAI: /)
  })
})

describe('checkTranscriptionHealth (from config)', () => {
  const base: TranscriptionConfig = {
    TRANSCRIPTION_PROVIDER: 'assemblyai',
    WHISPER_URL: undefined,
    WHISPER_API_KEY: undefined,
    WHISPER_MODEL: 'whisper-1',
    ASSEMBLYAI_API_KEY: AAI_KEY,
    ASSEMBLYAI_BASE_URL: undefined,
  }

  it('checks only AssemblyAI for TRANSCRIPTION_PROVIDER=assemblyai', async () => {
    const m = mockFetch([json({ transcripts: [] })])
    expect(await checkTranscriptionHealth(base, { fetch: m.fetch })).toEqual([{ engine: 'assemblyai', ok: true, detail: 'AssemblyAI accepted the API key.' }])
  })

  it('checks both engines for chain, and reports a missing setting by name', async () => {
    const m = mockFetch([json({ data: [] }), json({ transcripts: [] })])
    const both = await checkTranscriptionHealth({ ...base, TRANSCRIPTION_PROVIDER: 'chain', WHISPER_URL: 'https://whisper.example/v1' }, { fetch: m.fetch })
    expect(both.map((e) => [e.engine, e.ok])).toEqual([
      ['whisper', true],
      ['assemblyai', true],
    ])
    const missing = await checkTranscriptionHealth({ ...base, TRANSCRIPTION_PROVIDER: 'chain' }, { fetch: mockFetch([json({})]).fetch })
    expect(missing[0]).toMatchObject({ engine: 'whisper', ok: false, detail: expect.stringContaining('WHISPER_URL') })
  })

  it('reports the fake engine as test mode', async () => {
    const [fake] = await checkTranscriptionHealth({ ...base, TRANSCRIPTION_PROVIDER: 'fake' })
    expect(fake).toMatchObject({ engine: 'fake', ok: true })
  })
})
