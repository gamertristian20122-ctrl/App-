// Builds the configured Transcriber from @app/core config (TRANSCRIPTION_PROVIDER = chain | whisper | assemblyai | fake).

import type { Config } from '@app/core/config'
import type { Logger } from '@app/core/log'
import type { Transcriber } from '@app/core/ports'
import { AssemblyAITranscriber, type AssemblyAIOptions } from './assemblyai'
import { transcriptionError } from './errors'
import { FakeTranscriber, type FakeTranscriberOptions } from './fake'
import { createFallbackTranscriber } from './fallback'
import type { FetchLike } from './shared'
import { WhisperTranscriber, type WhisperOptions } from './whisper'

export type TranscriptionConfig = Pick<
  Config,
  'TRANSCRIPTION_PROVIDER' | 'WHISPER_URL' | 'WHISPER_API_KEY' | 'WHISPER_MODEL' | 'ASSEMBLYAI_API_KEY' | 'ASSEMBLYAI_BASE_URL'
>

export interface TranscriptionFactoryDeps {
  fetch?: FetchLike
  logger?: Logger
  /** Extra engine options (timeouts, limits). */
  whisper?: Partial<WhisperOptions>
  assemblyai?: Partial<AssemblyAIOptions>
  fake?: FakeTranscriberOptions
}

function whisperFrom(config: TranscriptionConfig, deps: TranscriptionFactoryDeps): WhisperTranscriber {
  if (!config.WHISPER_URL) {
    throw transcriptionError('input_invalid', 'WHISPER_URL is required for Whisper transcription.', { engine: 'whisper' })
  }
  return new WhisperTranscriber({
    ...deps.whisper,
    url: config.WHISPER_URL,
    apiKey: config.WHISPER_API_KEY,
    model: config.WHISPER_MODEL,
    fetch: deps.fetch,
    logger: deps.logger?.child({ engine: 'whisper' }),
  })
}

function assemblyFrom(config: TranscriptionConfig, deps: TranscriptionFactoryDeps): AssemblyAITranscriber {
  if (!config.ASSEMBLYAI_API_KEY) {
    throw transcriptionError('input_invalid', 'ASSEMBLYAI_API_KEY is required for AssemblyAI transcription.', { engine: 'assemblyai' })
  }
  return new AssemblyAITranscriber({
    ...deps.assemblyai,
    apiKey: config.ASSEMBLYAI_API_KEY,
    baseUrl: config.ASSEMBLYAI_BASE_URL,
    fetch: deps.fetch,
    logger: deps.logger?.child({ engine: 'assemblyai' }),
  })
}

export function createTranscriberFromConfig(config: TranscriptionConfig, deps: TranscriptionFactoryDeps = {}): Transcriber {
  switch (config.TRANSCRIPTION_PROVIDER) {
    case 'fake':
      return new FakeTranscriber(deps.fake)
    case 'whisper':
      return whisperFrom(config, deps)
    case 'assemblyai':
      return assemblyFrom(config, deps)
    case 'chain':
      return createFallbackTranscriber([whisperFrom(config, deps), assemblyFrom(config, deps)], { logger: deps.logger })
    default:
      throw transcriptionError('input_invalid', 'Unknown TRANSCRIPTION_PROVIDER.')
  }
}
