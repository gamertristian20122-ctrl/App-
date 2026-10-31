import { rm } from 'node:fs/promises'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AppError } from '@app/core/errors'
import { memoryLogger } from '@app/core/testing'
import { AssemblyAITranscriber } from '../src/assemblyai'
import { isRetryableTranscriptionError, transcriptionError, transcriptionErrorReason } from '../src/errors'
import { FakeTranscriber } from '../src/fake'
import { createFallbackTranscriber, transcribeWithEngine } from '../src/fallback'
import { WhisperTranscriber } from '../src/whisper'
import { ASSEMBLY_COMPLETED, json, tempAudio, virtualTime, WHISPER_VERBOSE } from './helpers'

let dir: string
let audio: string
beforeAll(async () => {
  const t = await tempAudio()
  dir = t.dir
  audio = t.path
})
afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('createFallbackTranscriber', () => {
  it('uses the first engine when it works', async () => {
    const whisper = new FakeTranscriber({ name: 'whisper', text: 'from whisper.' })
    const assembly = new FakeTranscriber({ name: 'assemblyai', text: 'from assembly.' })
    const chain = createFallbackTranscriber([whisper, assembly])
    const out = await chain.transcribeDetailed({ filePath: audio })
    expect(out.engine).toBe('whisper')
    expect(out.result.text).toBe('from whisper.')
    expect(out.attempts).toEqual([{ engine: 'whisper', ok: true, ms: expect.any(Number) }])
    expect(assembly.calls).toHaveLength(0)
    expect((await chain.transcribe({ filePath: audio })).text).toBe('from whisper.')
    expect(chain.name).toBe('chain')
  })

  it('falls back to the next engine and reports which one answered', async () => {
    const logger = memoryLogger()
    const whisper = new FakeTranscriber({ name: 'whisper' })
    whisper.failNext()
    const assembly = new FakeTranscriber({ name: 'assemblyai', text: 'from assembly.' })
    const out = await createFallbackTranscriber([whisper, assembly], { logger }).transcribeDetailed({ filePath: audio, language: 'en' })
    expect(out.engine).toBe('assemblyai')
    expect(out.result.text).toBe('from assembly.')
    expect(out.attempts.map((a) => [a.engine, a.ok, a.reason])).toEqual([
      ['whisper', false, 'engine_unavailable'],
      ['assemblyai', true, undefined],
    ])
    expect(assembly.calls).toEqual([{ filePath: audio, language: 'en' }])
    expect(logger.lines.find((l) => l.level === 'warn')).toMatchObject({ engine: 'whisper', next: 'assemblyai', reason: 'engine_unavailable' })
  })

  it('does not fall back on invalid input or cancellation', async () => {
    const assembly = new FakeTranscriber({ name: 'assemblyai' })
    const whisper = new FakeTranscriber({ name: 'whisper' })
    whisper.failNext(transcriptionError('input_invalid', 'The audio file to transcribe was not found.', { engine: 'whisper' }))
    const chain = createFallbackTranscriber([whisper, assembly])
    const err = await chain.transcribe({ filePath: audio }).catch((e: unknown) => e)
    expect(transcriptionErrorReason(err)).toBe('input_invalid')
    const aborted = await chain.transcribe({ filePath: audio, signal: AbortSignal.abort() }).catch((e: unknown) => e)
    expect(transcriptionErrorReason(aborted)).toBe('aborted')
    expect(assembly.calls).toHaveLength(0)
  })

  it('reports every attempt when all engines fail, keeping the last error code', async () => {
    const whisper = new FakeTranscriber({ name: 'whisper' })
    whisper.failNext()
    const assembly = new FakeTranscriber({ name: 'assemblyai' })
    assembly.failNext(transcriptionError('engine_failed', 'AssemblyAI could not transcribe this file: no audio.', { engine: 'assemblyai' }))
    const err = (await createFallbackTranscriber([whisper, assembly])
      .transcribe({ filePath: audio })
      .catch((e: unknown) => e)) as AppError
    expect(err).toBeInstanceOf(AppError)
    expect(err.code).toBe('bad_request')
    expect(err.message).toContain('no audio')
    expect(transcriptionErrorReason(err)).toBe('all_failed')
    expect((err.details?.attempts as Array<{ engine: string; reason: string }>).map((a) => [a.engine, a.reason])).toEqual([
      ['whisper', 'engine_unavailable'],
      ['assemblyai', 'engine_failed'],
    ])
    expect(isRetryableTranscriptionError(err)).toBe(true) // whisper was down; a later retry may work
  })

  it('wraps unexpected errors and honours a custom fallback rule', async () => {
    const boom = new FakeTranscriber({ name: 'whisper' })
    boom.failNext(new Error('kaboom'))
    const next = new FakeTranscriber({ name: 'assemblyai' })
    const never = createFallbackTranscriber([boom, next], { shouldFallBack: () => false })
    const err = await never.transcribe({ filePath: audio }).catch((e: unknown) => e)
    expect((err as Error).message).toBe('kaboom')
    expect(next.calls).toHaveLength(0)
    expect(() => createFallbackTranscriber([])).toThrow()
  })

  it('chains the real adapters: Whisper down → AssemblyAI answers', async () => {
    const time = virtualTime()
    const fetchMock = async (input: string | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input)
      if (url.startsWith('http://whisper')) return json({ error: { message: 'CUDA out of memory' } }, 503)
      if (url.endsWith('/v2/upload')) return json({ upload_url: 'https://cdn.assemblyai.com/upload/x' })
      if (url.endsWith('/v2/transcript') && init?.method === 'POST') return json({ id: 'tr_abc123', status: 'queued' })
      return json(ASSEMBLY_COMPLETED)
    }
    const chain = createFallbackTranscriber([
      new WhisperTranscriber({ url: 'http://whisper:8000', fetch: fetchMock }),
      new AssemblyAITranscriber({ apiKey: 'aai-key-0123456789', fetch: fetchMock, sleep: time.sleep, now: time.now }),
    ])
    const out = await transcribeWithEngine(chain, { filePath: audio })
    expect(out.engine).toBe('assemblyai')
    expect(out.attempts[0]).toMatchObject({ engine: 'whisper', ok: false, reason: 'engine_unavailable', code: 'unavailable' })
    expect(out.result.words).toHaveLength(6)
  })

  it('chains the real adapters: Whisper answers first', async () => {
    const fetchMock = async () => json(WHISPER_VERBOSE)
    const chain = createFallbackTranscriber([
      new WhisperTranscriber({ url: 'http://whisper:8000', fetch: fetchMock }),
      new AssemblyAITranscriber({ apiKey: 'aai-key-0123456789', fetch: async () => json({}, 500) }),
    ])
    expect((await chain.transcribeDetailed({ filePath: audio })).engine).toBe('whisper')
  })
})

describe('transcribeWithEngine', () => {
  it('reports the engine of a plain transcriber', async () => {
    const out = await transcribeWithEngine(new FakeTranscriber(), { filePath: audio })
    expect(out.engine).toBe('fake')
    expect(out.attempts).toHaveLength(1)
  })
})

describe('isRetryableTranscriptionError', () => {
  it('classifies reasons', () => {
    expect(isRetryableTranscriptionError(transcriptionError('timeout', 'x'))).toBe(true)
    expect(isRetryableTranscriptionError(transcriptionError('rate_limited', 'x'))).toBe(true)
    expect(isRetryableTranscriptionError(transcriptionError('input_invalid', 'x'))).toBe(false)
    expect(isRetryableTranscriptionError(transcriptionError('engine_failed', 'x'))).toBe(false)
    expect(isRetryableTranscriptionError(new Error('x'))).toBe(false)
  })
})
