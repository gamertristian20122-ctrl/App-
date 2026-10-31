// @app/transcription: Transcriber implementations — self-hosted Whisper (OpenAI-compatible HTTP),
// AssemblyAI (fallback), a deterministic fake — and the fallback chain. Server-only.
// Results are TranscriptResult { language, durationMs, text, words: {s,e,t}[], segments: {s,e,t}[] } in ms.

export * from './errors'
export * from './normalize'
export {
  audioContentType,
  HEALTH_CHECK_TIMEOUT_MS,
  type HealthCheckResult,
  type DetailedTranscriber,
  type DetailedTranscription,
  type FetchLike,
  type Sleep,
  type TranscribeInput,
  type TranscriptionAttempt,
} from './shared'
export { WhisperTranscriber, whisperEndpoint, WhisperVerboseJsonSchema, WHISPER_DEFAULT_MAX_FILE_BYTES, WHISPER_DEFAULT_TIMEOUT_MS } from './whisper'
export type { WhisperOptions } from './whisper'
export { AssemblyAITranscriber, AssemblyAITranscriptSchema, ASSEMBLYAI_DEFAULT_BASE_URL } from './assemblyai'
export type { AssemblyAIOptions } from './assemblyai'
export { FakeTranscriber, fakeWords, FAKE_TRANSCRIPT_TEXT } from './fake'
export type { FakeTranscriberOptions } from './fake'
export { FallbackTranscriber, createFallbackTranscriber, engineHealth, transcribeWithEngine } from './fallback'
export type { EngineHealth, FallbackOptions } from './fallback'
export * from './factory'
