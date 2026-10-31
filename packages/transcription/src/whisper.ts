// WhisperTranscriber: a self-hosted, OpenAI-compatible Whisper server (e.g. speaches /
// faster-whisper-server, whisper.cpp server in OpenAI mode, or OpenAI itself).
//
// POST {WHISPER_URL}/v1/audio/transcriptions (multipart/form-data)
//   file, model, response_format=verbose_json, timestamp_granularities[]=word,
//   timestamp_granularities[]=segment, temperature=0, language (optional, ISO 639-1)
//   Authorization: Bearer <WHISPER_API_KEY> (only when a key is configured)
// Response (verbose_json): { text, language, duration (s), segments: [{start, end, text, words?}], words: [{word, start, end}] }
// Times are seconds; we convert to ms. Servers that only return segments get word timings spread
// over each segment; a response with neither is rejected as malformed.
//
// WHISPER_URL may be the server root (https://whisper.internal) or end in /v1 (as .env.example
// describes); both work. A full .../audio/transcriptions URL is used as is.

import { z } from 'zod'
import type { Logger } from '@app/core/log'
import type { HealthCheckResult, TranscriptResult, Transcriber } from '@app/core/ports'
import { transcriptionError } from './errors'
import { normalizeTranscript, type RawTiming } from './normalize'
import { checkInput, fetchWithTimeout, httpError, openAudioFile, probeStatus, readJson, type FetchLike, type TranscribeInput } from './shared'

export interface WhisperOptions {
  /** Base URL of the server (WHISPER_URL). */
  url: string
  /** Optional bearer key (WHISPER_API_KEY). Never logged. */
  apiKey?: string
  /** Model name the server expects (WHISPER_MODEL, default "whisper-1"). */
  model?: string
  /** Whole-request timeout (default 60 min: long sources on a busy GPU). */
  timeoutMs?: number
  /** Largest file we send (default 1 GB). The worker should send compressed mono audio, not video. */
  maxFileBytes?: number
  fetch?: FetchLike
  logger?: Logger
}

export const WHISPER_DEFAULT_TIMEOUT_MS = 60 * 60_000
export const WHISPER_DEFAULT_MAX_FILE_BYTES = 1_000_000_000

const ENGINE = 'whisper'

const Seconds = z.union([z.number(), z.string().regex(/^\d+(?:\.\d+)?$/).transform(Number)])

const WordSchema = z.looseObject({ word: z.string(), start: Seconds, end: Seconds })
const SegmentSchema = z.looseObject({
  start: Seconds,
  end: Seconds,
  text: z.string(),
  words: z.array(WordSchema).nullish(),
})
export const WhisperVerboseJsonSchema = z.looseObject({
  text: z.string(),
  language: z.string().nullish(),
  duration: Seconds.nullish(),
  words: z.array(WordSchema).nullish(),
  segments: z.array(SegmentSchema).nullish(),
})

/** Resolves the transcription endpoint from WHISPER_URL. */
export function whisperEndpoint(url: string): string {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    throw transcriptionError('input_invalid', 'WHISPER_URL must be an absolute URL.', { engine: ENGINE })
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw transcriptionError('input_invalid', 'WHISPER_URL must be http(s).', { engine: ENGINE })
  }
  u.search = ''
  u.hash = ''
  const base = u.toString().replace(/\/+$/, '')
  if (/\/audio\/transcriptions$/.test(base)) return base
  if (/\/v1$/.test(base)) return `${base}/audio/transcriptions`
  return `${base}/v1/audio/transcriptions`
}

const sec = (v: number) => v * 1000

export class WhisperTranscriber implements Transcriber {
  readonly name = ENGINE
  private readonly endpoint: string
  private readonly apiKey: string | undefined
  private readonly model: string
  private readonly timeoutMs: number
  private readonly maxFileBytes: number
  private readonly fetchFn: FetchLike
  private readonly logger: Logger | undefined

  constructor(options: WhisperOptions) {
    this.endpoint = whisperEndpoint(options.url)
    this.apiKey = options.apiKey || undefined
    this.model = options.model?.trim() || 'whisper-1'
    this.timeoutMs = options.timeoutMs ?? WHISPER_DEFAULT_TIMEOUT_MS
    this.maxFileBytes = options.maxFileBytes ?? WHISPER_DEFAULT_MAX_FILE_BYTES
    this.fetchFn = options.fetch ?? ((input, init) => fetch(input, init))
    this.logger = options.logger
  }

  /**
   * Is the server reachable (and does it accept WHISPER_API_KEY)? GET {base}/v1/models, the
   * cheapest call OpenAI-compatible servers offer. A 404 still proves the server answers. Never throws.
   */
  async healthCheck(): Promise<HealthCheckResult> {
    const url = this.endpoint.replace(/\/audio\/transcriptions$/, '/models')
    const headers: Record<string, string> = { accept: 'application/json' }
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`
    const status = await probeStatus(this.fetchFn, url, headers)
    if (status === null) return { ok: false, detail: 'The Whisper server could not be reached at WHISPER_URL.' }
    if (status === 401 || status === 403) return { ok: false, detail: 'The Whisper server refused WHISPER_API_KEY.' }
    if (status >= 500) return { ok: false, detail: `The Whisper server answered with an error (HTTP ${status}).` }
    return { ok: true, detail: 'The Whisper server answered.' }
  }

  async transcribe(input: TranscribeInput): Promise<TranscriptResult> {
    const { filePath, language, signal } = checkInput(input, ENGINE)
    const file = await openAudioFile(filePath, this.maxFileBytes, ENGINE)

    const form = new FormData()
    form.append('file', file.blob, file.name)
    form.append('model', this.model)
    form.append('response_format', 'verbose_json')
    form.append('timestamp_granularities[]', 'word')
    form.append('timestamp_granularities[]', 'segment')
    form.append('temperature', '0')
    // Whisper takes ISO 639-1 codes without region.
    if (language) form.append('language', language.split('_')[0] as string)

    const headers: Record<string, string> = { accept: 'application/json' }
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`

    const started = Date.now()
    this.logger?.info('whisper transcription started', { bytes: file.bytes, language: language ?? 'auto' })
    const res = await fetchWithTimeout(
      this.fetchFn,
      this.endpoint,
      { method: 'POST', headers, body: form },
      { timeoutMs: this.timeoutMs, signal, engine: ENGINE },
    )
    if (!res.ok) throw await httpError(res, ENGINE, [this.apiKey])

    const parsed = WhisperVerboseJsonSchema.safeParse(await readJson(res))
    if (!parsed.success) {
      throw transcriptionError('malformed_response', 'The Whisper server returned an unexpected response (verbose_json expected).', {
        engine: ENGINE,
      })
    }
    const body = parsed.data
    let words: RawTiming[] = (body.words ?? []).map((w) => ({ start: sec(w.start), end: sec(w.end), text: w.word }))
    if (words.length === 0) {
      // faster-whisper style: words nested in segments.
      words = (body.segments ?? []).flatMap((s) => (s.words ?? []).map((w) => ({ start: sec(w.start), end: sec(w.end), text: w.word })))
    }
    const segments: RawTiming[] = (body.segments ?? []).map((s) => ({ start: sec(s.start), end: sec(s.end), text: s.text }))
    if (words.length === 0 && segments.length === 0 && body.text.trim() !== '') {
      throw transcriptionError('malformed_response', 'The Whisper server returned text without timestamps.', { engine: ENGINE })
    }
    const result = normalizeTranscript(
      {
        language: body.language ?? language ?? null,
        durationMs: body.duration == null ? null : sec(body.duration),
        text: body.text,
        words,
        segments,
      },
      ENGINE,
    )
    this.logger?.info('whisper transcription finished', {
      ms: Date.now() - started,
      durationMs: result.durationMs,
      words: result.words.length,
      language: result.language,
    })
    return result
  }
}
