import { describe, expect, it } from 'vitest'
import { testConfig } from '@app/core/testing'
import * as transcription from '../src/index'
import {
  AssemblyAITranscriber,
  createTranscriberFromConfig,
  FakeTranscriber,
  FallbackTranscriber,
  WhisperTranscriber,
} from '../src/index'

describe('createTranscriberFromConfig', () => {
  it('creates the fake by default in tests', () => {
    expect(createTranscriberFromConfig(testConfig())).toBeInstanceOf(FakeTranscriber)
  })

  it('creates each engine and the chain', () => {
    const env = {
      WHISPER_URL: 'http://whisper:8000/v1',
      WHISPER_API_KEY: 'whisper-key-123',
      ASSEMBLYAI_API_KEY: 'aai-key-0123456789',
    }
    expect(createTranscriberFromConfig(testConfig({ ...env, TRANSCRIPTION_PROVIDER: 'whisper' }))).toBeInstanceOf(WhisperTranscriber)
    expect(createTranscriberFromConfig(testConfig({ ...env, TRANSCRIPTION_PROVIDER: 'assemblyai' }))).toBeInstanceOf(AssemblyAITranscriber)
    const chain = createTranscriberFromConfig(testConfig({ ...env, TRANSCRIPTION_PROVIDER: 'chain' }))
    expect(chain).toBeInstanceOf(FallbackTranscriber)
    expect((chain as FallbackTranscriber).engines.map((e) => e.name)).toEqual(['whisper', 'assemblyai'])
  })

  it('fails clearly when an engine is not configured', () => {
    const base = testConfig()
    expect(() => createTranscriberFromConfig({ ...base, TRANSCRIPTION_PROVIDER: 'whisper' })).toThrow(/WHISPER_URL/)
    expect(() => createTranscriberFromConfig({ ...base, TRANSCRIPTION_PROVIDER: 'assemblyai' })).toThrow(/ASSEMBLYAI_API_KEY/)
  })

  it('exports the public surface', () => {
    for (const name of [
      'WhisperTranscriber',
      'AssemblyAITranscriber',
      'FakeTranscriber',
      'createFallbackTranscriber',
      'transcribeWithEngine',
      'normalizeTranscript',
      'createTranscriberFromConfig',
      'transcriptionErrorReason',
      'isRetryableTranscriptionError',
    ]) {
      expect(transcription, name).toHaveProperty(name)
    }
  })
})
