import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { memoryLogger } from '@app/core/testing'
import { TranscriptResultSchema } from '@app/core/validation'
import { transcriptionErrorReason } from '../src/errors'
import { WhisperTranscriber, whisperEndpoint } from '../src/whisper'
import { hang, json, mockFetch, tempAudio, WHISPER_VERBOSE } from './helpers'

const KEY = 'whisper-secret-key-0123456789'
let dir: string
let audio: string

beforeAll(async () => {
  const t = await tempAudio('episode.mp3', 'fake mp3 payload')
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

describe('whisperEndpoint', () => {
  it('accepts a root URL, a /v1 URL or the full endpoint', () => {
    expect(whisperEndpoint('http://whisper:8000')).toBe('http://whisper:8000/v1/audio/transcriptions')
    expect(whisperEndpoint('http://whisper:8000/')).toBe('http://whisper:8000/v1/audio/transcriptions')
    expect(whisperEndpoint('https://w.example.com/v1')).toBe('https://w.example.com/v1/audio/transcriptions')
    expect(whisperEndpoint('https://w.example.com/v1/')).toBe('https://w.example.com/v1/audio/transcriptions')
    expect(whisperEndpoint('https://w.example.com/v1/audio/transcriptions')).toBe('https://w.example.com/v1/audio/transcriptions')
    expect(whisperEndpoint('https://w.example.com/proxy?x=1')).toBe('https://w.example.com/proxy/v1/audio/transcriptions')
    expect(() => whisperEndpoint('not a url')).toThrow()
    expect(() => whisperEndpoint('ftp://x')).toThrow()
  })
})

describe('WhisperTranscriber', () => {
  it('posts the file as multipart verbose_json with word and segment timestamps', async () => {
    const m = mockFetch([json(WHISPER_VERBOSE)])
    const logger = memoryLogger()
    const t = new WhisperTranscriber({ url: 'http://whisper:8000/v1', apiKey: KEY, model: 'large-v3', fetch: m.fetch, logger })
    const result = await t.transcribe({ filePath: audio, language: 'en-US' })

    expect(m.calls).toHaveLength(1)
    const call = m.calls[0]!
    expect(call.url).toBe('http://whisper:8000/v1/audio/transcriptions')
    expect(call.method).toBe('POST')
    expect(call.headers.authorization).toBe(`Bearer ${KEY}`)
    const form = call.init.body as FormData
    expect(form).toBeInstanceOf(FormData)
    expect(form.get('model')).toBe('large-v3')
    expect(form.get('response_format')).toBe('verbose_json')
    expect(form.getAll('timestamp_granularities[]')).toEqual(['word', 'segment'])
    expect(form.get('language')).toBe('en')
    expect(form.get('temperature')).toBe('0')
    const file = form.get('file') as File
    expect(file.name).toBe('episode.mp3')
    expect(file.type).toBe('audio/mpeg')
    expect(await file.text()).toBe('fake mp3 payload')

    expect(result).toEqual({
      language: 'en',
      durationMs: 4250,
      text: 'Hello world. This is a test.',
      words: [
        { s: 0, e: 420, t: 'Hello' },
        { s: 420, e: 900, t: 'world.' },
        { s: 1500, e: 1700, t: 'This' },
        { s: 1700, e: 1820, t: 'is' },
        { s: 1820, e: 1900, t: 'a' },
        { s: 1900, e: 2400, t: 'test.' },
      ],
      segments: [
        { s: 0, e: 900, t: 'Hello world.' },
        { s: 1500, e: 2400, t: 'This is a test.' },
      ],
    })
    expect(TranscriptResultSchema.safeParse(result).success).toBe(true)
    expect(logger.text()).not.toContain(KEY)
    expect(logger.lines.map((l) => l.msg)).toEqual(['whisper transcription started', 'whisper transcription finished'])
  })

  it('sends no Authorization header and no language when not configured', async () => {
    const m = mockFetch([json(WHISPER_VERBOSE)])
    await new WhisperTranscriber({ url: 'http://whisper:8000', fetch: m.fetch }).transcribe({ filePath: audio })
    expect(m.calls[0]!.headers.authorization).toBeUndefined()
    const form = m.calls[0]!.init.body as FormData
    expect(form.get('language')).toBeNull()
    expect(form.get('model')).toBe('whisper-1')
  })

  it('reads words nested in segments (faster-whisper servers) and language codes', async () => {
    const body = {
      text: 'Hola mundo.',
      language: 'es',
      duration: '2.5',
      segments: [
        {
          start: 0.1,
          end: 1.2,
          text: ' Hola mundo.',
          words: [
            { word: ' Hola', start: 0.1, end: 0.5, probability: 0.9 },
            { word: ' mundo.', start: 0.5, end: 1.2, probability: 0.9 },
          ],
        },
      ],
    }
    const m = mockFetch([json(body)])
    const r = await new WhisperTranscriber({ url: 'http://w', fetch: m.fetch }).transcribe({ filePath: audio })
    expect(r.language).toBe('es')
    expect(r.durationMs).toBe(2500)
    expect(r.words).toEqual([
      { s: 100, e: 500, t: 'Hola' },
      { s: 500, e: 1200, t: 'mundo.' },
    ])
  })

  it('spreads words over segments when the server returns no word timings', async () => {
    const m = mockFetch([json({ text: 'one two', language: 'en', duration: 2, segments: [{ start: 0, end: 1, text: 'one two' }] })])
    const r = await new WhisperTranscriber({ url: 'http://w', fetch: m.fetch }).transcribe({ filePath: audio })
    expect(r.words).toEqual([
      { s: 0, e: 500, t: 'one' },
      { s: 500, e: 1000, t: 'two' },
    ])
  })

  it('accepts a silent file', async () => {
    const m = mockFetch([json({ text: '', language: 'en', duration: 3, segments: [], words: [] })])
    const r = await new WhisperTranscriber({ url: 'http://w', fetch: m.fetch }).transcribe({ filePath: audio })
    expect(r).toEqual({ language: 'en', durationMs: 3000, text: '', words: [], segments: [] })
  })

  it.each([
    ['plain text (response_format ignored)', new Response('Hello world', { status: 200 })],
    ['json without text', json({ language: 'en' })],
    ['words with string times that are not numbers', json({ text: 'x', words: [{ word: 'x', start: 'soon', end: 1 }] })],
    ['text without timestamps', json({ text: 'Hello there' })],
    ['an array', json([1, 2, 3])],
  ])('rejects a malformed response: %s', async (_name, response) => {
    const m = mockFetch([response])
    const err = await failure(new WhisperTranscriber({ url: 'http://w', fetch: m.fetch }).transcribe({ filePath: audio }))
    expect(err.code).toBe('unavailable')
    expect(transcriptionErrorReason(err)).toBe('malformed_response')
    expect(err.details?.engine).toBe('whisper')
  })

  it('maps HTTP errors without leaking the key', async () => {
    const cases: Array<[Response, string, string]> = [
      [json({ error: { message: `Invalid key ${KEY}` } }, 401), 'engine_auth', 'unavailable'],
      [json({ error: 'slow down' }, 429, { 'retry-after': '7' }), 'rate_limited', 'rate_limited'],
      [json({ detail: 'too big' }, 413), 'engine_rejected', 'bad_request'],
      [json({ detail: `bad model; key=${KEY} see https://docs.example.com/x?token=abc` }, 400), 'engine_rejected', 'bad_request'],
      [new Response('<html>oops</html>', { status: 502 }), 'engine_unavailable', 'unavailable'],
    ]
    for (const [response, reason, code] of cases) {
      const m = mockFetch([response])
      const err = await failure(new WhisperTranscriber({ url: 'http://w', apiKey: KEY, fetch: m.fetch }).transcribe({ filePath: audio }))
      expect(transcriptionErrorReason(err)).toBe(reason)
      expect(err.code).toBe(code)
      expect(JSON.stringify({ message: err.message, details: err.details })).not.toContain(KEY)
      expect(err.message).not.toContain('https://')
      if (reason === 'rate_limited') expect(err.details?.retryAfterSec).toBe(7)
    }
  })

  it('times out', async () => {
    const m = mockFetch([hang])
    const err = await failure(new WhisperTranscriber({ url: 'http://w', fetch: m.fetch, timeoutMs: 20 }).transcribe({ filePath: audio }))
    expect(transcriptionErrorReason(err)).toBe('timeout')
  })

  it('stops when the caller aborts', async () => {
    const m = mockFetch([hang])
    const controller = new AbortController()
    const p = new WhisperTranscriber({ url: 'http://w', fetch: m.fetch }).transcribe({ filePath: audio, signal: controller.signal })
    setTimeout(() => controller.abort(), 5)
    expect(transcriptionErrorReason(await failure(p))).toBe('aborted')
    const m2 = mockFetch([])
    const err = await failure(new WhisperTranscriber({ url: 'http://w', fetch: m2.fetch }).transcribe({ filePath: audio, signal: AbortSignal.abort() }))
    expect(transcriptionErrorReason(err)).toBe('aborted')
    expect(m2.fetch).not.toHaveBeenCalled()
  })

  it('maps network failures to engine_unavailable', async () => {
    const m = mockFetch([() => Promise.reject(new TypeError('fetch failed'))])
    const err = await failure(new WhisperTranscriber({ url: 'http://w', fetch: m.fetch }).transcribe({ filePath: audio }))
    expect(transcriptionErrorReason(err)).toBe('engine_unavailable')
  })

  it('validates the input before calling the server', async () => {
    const m = mockFetch([])
    const t = new WhisperTranscriber({ url: 'http://w', fetch: m.fetch, maxFileBytes: 5 })
    expect(transcriptionErrorReason(await failure(t.transcribe({ filePath: join(dir, 'missing.mp3') })))).toBe('input_invalid')
    expect(transcriptionErrorReason(await failure(t.transcribe({ filePath: '' })))).toBe('input_invalid')
    expect(transcriptionErrorReason(await failure(t.transcribe({ filePath: audio, language: 'english please' })))).toBe('input_invalid')
    expect(transcriptionErrorReason(await failure(t.transcribe({ filePath: dir })))).toBe('input_invalid')
    const empty = join(dir, 'empty.mp3')
    await writeFile(empty, '')
    expect(transcriptionErrorReason(await failure(t.transcribe({ filePath: empty })))).toBe('input_invalid')
    // Too large for this engine: rejected, so the chain can try the next one.
    expect(transcriptionErrorReason(await failure(t.transcribe({ filePath: audio })))).toBe('engine_rejected')
    expect(m.fetch).not.toHaveBeenCalled()
  })
})
