// AssemblyAITranscriber: the hosted fallback (https://www.assemblyai.com/docs/api-reference).
//
// 1. POST {base}/v2/upload                 raw bytes (application/octet-stream) → { upload_url }
// 2. POST {base}/v2/transcript             { audio_url, punctuate, format_text, language_code | language_detection }
//                                          → { id, status }
// 3. GET  {base}/v2/transcript/{id}        poll with backoff until status is completed | error
//                                          (60 requests/min per key+transcript; 429 → Retry-After)
// 4. DELETE {base}/v2/transcript/{id}      best effort, so the user's words do not stay at AssemblyAI
// Auth: header `authorization: <API key>` (no scheme). EU: base https://api.eu.assemblyai.com.
// Word timings (`words[].start/end`) are ms; `audio_duration` is seconds. Segments are built from
// words (AssemblyAI returns punctuated text, so sentence ends are reliable).

import { z } from 'zod'
import type { Logger } from '@app/core/log'
import type { TranscriptResult, Transcriber } from '@app/core/ports'
import { isAppError } from '@app/core/errors'
import { safeEngineMessage, transcriptionError } from './errors'
import { normalizeTranscript } from './normalize'
import {
  checkInput,
  fetchWithTimeout,
  httpError,
  openAudioFile,
  readJson,
  realSleep,
  retryAfterSec,
  throwIfAborted,
  type FetchLike,
  type Sleep,
  type TranscribeInput,
} from './shared'

export const ASSEMBLYAI_DEFAULT_BASE_URL = 'https://api.assemblyai.com'

export interface AssemblyAIOptions {
  /** ASSEMBLYAI_API_KEY. Never logged. */
  apiKey: string
  /** ASSEMBLYAI_BASE_URL (default https://api.assemblyai.com; EU: https://api.eu.assemblyai.com). */
  baseUrl?: string
  /** speech_models to request; omitted → AssemblyAI's default. */
  speechModels?: string[]
  /** First poll delay (default 3 s); grows ×1.5 per poll up to maxPollIntervalMs. */
  pollIntervalMs?: number
  /** Longest poll delay (default 15 s). */
  maxPollIntervalMs?: number
  /** Overall limit from upload to result (default 60 min). */
  timeoutMs?: number
  /** Per-request limit for create/poll/delete (default 60 s). */
  requestTimeoutMs?: number
  /** Limit for the upload request (default 30 min). */
  uploadTimeoutMs?: number
  /** Consecutive failed polls (network/5xx) tolerated before giving up (default 5). */
  maxPollFailures?: number
  /** Largest file we upload (default 2.2 GB). */
  maxFileBytes?: number
  /** Delete the transcript at AssemblyAI after reading it (default true). */
  deleteAfter?: boolean
  fetch?: FetchLike
  logger?: Logger
  /** Injected for tests. */
  sleep?: Sleep
  now?: () => number
}

const ENGINE = 'assemblyai'

const UploadSchema = z.looseObject({ upload_url: z.url() })
const IdSchema = z.string().min(1).max(200).regex(/^[A-Za-z0-9_-]+$/)
const CreatedSchema = z.looseObject({ id: IdSchema, status: z.string(), error: z.string().nullish() })
const WordSchema = z.looseObject({ text: z.string(), start: z.number(), end: z.number(), confidence: z.number().nullish() })
export const AssemblyAITranscriptSchema = z.looseObject({
  id: IdSchema,
  status: z.string(),
  error: z.string().nullish(),
  text: z.string().nullish(),
  words: z.array(WordSchema).nullish(),
  audio_duration: z.number().nullish(),
  language_code: z.string().nullish(),
})
type AssemblyAITranscript = z.output<typeof AssemblyAITranscriptSchema>

function normalizeBase(url: string): string {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    throw transcriptionError('input_invalid', 'ASSEMBLYAI_BASE_URL must be an absolute URL.', { engine: ENGINE })
  }
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && /^(localhost|127\.0\.0\.1)$/.test(u.hostname))) {
    throw transcriptionError('input_invalid', 'ASSEMBLYAI_BASE_URL must be https.', { engine: ENGINE })
  }
  u.search = ''
  u.hash = ''
  return u.toString().replace(/\/+$/, '')
}

export class AssemblyAITranscriber implements Transcriber {
  readonly name = ENGINE
  private readonly apiKey: string
  private readonly base: string
  private readonly speechModels: string[] | undefined
  private readonly pollIntervalMs: number
  private readonly maxPollIntervalMs: number
  private readonly timeoutMs: number
  private readonly requestTimeoutMs: number
  private readonly uploadTimeoutMs: number
  private readonly maxPollFailures: number
  private readonly maxFileBytes: number
  private readonly deleteAfter: boolean
  private readonly fetchFn: FetchLike
  private readonly logger: Logger | undefined
  private readonly sleep: Sleep
  private readonly now: () => number

  constructor(options: AssemblyAIOptions) {
    if (!options.apiKey || options.apiKey.trim().length < 8) {
      throw transcriptionError('input_invalid', 'ASSEMBLYAI_API_KEY is missing.', { engine: ENGINE })
    }
    this.apiKey = options.apiKey.trim()
    this.base = normalizeBase(options.baseUrl ?? ASSEMBLYAI_DEFAULT_BASE_URL)
    this.speechModels = options.speechModels?.length ? [...options.speechModels] : undefined
    this.pollIntervalMs = Math.max(1, options.pollIntervalMs ?? 3_000)
    this.maxPollIntervalMs = Math.max(this.pollIntervalMs, options.maxPollIntervalMs ?? 15_000)
    this.timeoutMs = options.timeoutMs ?? 60 * 60_000
    this.requestTimeoutMs = options.requestTimeoutMs ?? 60_000
    this.uploadTimeoutMs = options.uploadTimeoutMs ?? 30 * 60_000
    this.maxPollFailures = options.maxPollFailures ?? 5
    this.maxFileBytes = options.maxFileBytes ?? 2_200_000_000
    this.deleteAfter = options.deleteAfter ?? true
    this.fetchFn = options.fetch ?? ((input, init) => fetch(input, init))
    this.logger = options.logger
    this.sleep = options.sleep ?? realSleep
    this.now = options.now ?? Date.now
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { authorization: this.apiKey, accept: 'application/json', ...extra }
  }

  private malformed(what: string) {
    return transcriptionError('malformed_response', `AssemblyAI returned an unexpected ${what} response.`, { engine: ENGINE })
  }

  async transcribe(input: TranscribeInput): Promise<TranscriptResult> {
    const { filePath, language, signal } = checkInput(input, ENGINE)
    const file = await openAudioFile(filePath, this.maxFileBytes, ENGINE)
    const started = this.now()
    const deadline = started + this.timeoutMs
    this.logger?.info('assemblyai transcription started', { bytes: file.bytes, language: language ?? 'auto' })

    // 1. upload
    const uploadRes = await fetchWithTimeout(
      this.fetchFn,
      `${this.base}/v2/upload`,
      { method: 'POST', headers: this.headers({ 'content-type': 'application/octet-stream' }), body: file.blob },
      { timeoutMs: this.uploadTimeoutMs, signal, engine: ENGINE },
    )
    if (!uploadRes.ok) throw await httpError(uploadRes, ENGINE, [this.apiKey])
    const upload = UploadSchema.safeParse(await readJson(uploadRes))
    if (!upload.success) throw this.malformed('upload')

    // 2. create
    const body: Record<string, unknown> = { audio_url: upload.data.upload_url, punctuate: true, format_text: true }
    if (language) body.language_code = language
    else body.language_detection = true
    if (this.speechModels) body.speech_models = this.speechModels
    const createRes = await fetchWithTimeout(
      this.fetchFn,
      `${this.base}/v2/transcript`,
      { method: 'POST', headers: this.headers({ 'content-type': 'application/json' }), body: JSON.stringify(body) },
      { timeoutMs: this.requestTimeoutMs, signal, engine: ENGINE },
    )
    if (!createRes.ok) throw await httpError(createRes, ENGINE, [this.apiKey])
    const created = CreatedSchema.safeParse(await readJson(createRes))
    if (!created.success) throw this.malformed('create')
    const id = created.data.id

    // 3. poll
    try {
      const done = created.data.status === 'error' ? null : await this.poll(id, deadline, signal)
      if (!done || done.status === 'error') {
        const reason = safeEngineMessage(done?.error ?? created.data.error, [this.apiKey])
        throw transcriptionError('engine_failed', `AssemblyAI could not transcribe this file${reason ? `: ${reason}` : '.'}`, {
          engine: ENGINE,
        })
      }
      const result = normalizeTranscript(
        {
          language: done.language_code ?? language ?? null,
          durationMs: done.audio_duration == null ? null : done.audio_duration * 1000,
          text: done.text ?? '',
          words: (done.words ?? []).map((w) => ({ start: w.start, end: w.end, text: w.text })),
        },
        ENGINE,
      )
      this.logger?.info('assemblyai transcription finished', {
        ms: this.now() - started,
        durationMs: result.durationMs,
        words: result.words.length,
        language: result.language,
      })
      return result
    } finally {
      // 4. cleanup (also after errors and timeouts; AssemblyAI refuses deleting a queued job, which is fine).
      if (this.deleteAfter) await this.deleteTranscript(id)
    }
  }

  private async poll(id: string, deadline: number, signal: AbortSignal | undefined): Promise<AssemblyAITranscript> {
    let delay = this.pollIntervalMs
    let failures = 0
    for (;;) {
      throwIfAborted(signal, ENGINE)
      if (this.now() + delay > deadline) {
        throw transcriptionError('timeout', 'AssemblyAI did not finish the transcript in time.', { engine: ENGINE })
      }
      try {
        await this.sleep(delay, signal)
      } catch {
        throwIfAborted(signal, ENGINE)
      }
      delay = Math.min(this.maxPollIntervalMs, Math.round(delay * 1.5))

      let res: Response
      try {
        res = await fetchWithTimeout(
          this.fetchFn,
          `${this.base}/v2/transcript/${encodeURIComponent(id)}`,
          { method: 'GET', headers: this.headers() },
          { timeoutMs: this.requestTimeoutMs, signal, engine: ENGINE },
        )
      } catch (err) {
        if (isAppError(err) && (err.details?.reason === 'engine_unavailable' || err.details?.reason === 'timeout')) {
          if (++failures > this.maxPollFailures) throw err
          continue
        }
        throw err
      }
      if (res.status === 429) {
        await res.body?.cancel().catch(() => {})
        const wait = retryAfterSec(res)
        if (wait !== undefined) delay = Math.max(delay, Math.min(wait * 1000, this.maxPollIntervalMs * 4))
        continue
      }
      if (res.status >= 500) {
        await res.body?.cancel().catch(() => {})
        if (++failures > this.maxPollFailures) throw await httpError(res, ENGINE, [this.apiKey])
        continue
      }
      if (!res.ok) throw await httpError(res, ENGINE, [this.apiKey])
      failures = 0
      const parsed = AssemblyAITranscriptSchema.safeParse(await readJson(res))
      if (!parsed.success || parsed.data.id !== id) throw this.malformed('transcript')
      const t = parsed.data
      if (t.status === 'completed' || t.status === 'error') return t
      // queued / processing / anything new: keep polling
    }
  }

  private async deleteTranscript(id: string): Promise<void> {
    try {
      const res = await fetchWithTimeout(
        this.fetchFn,
        `${this.base}/v2/transcript/${encodeURIComponent(id)}`,
        { method: 'DELETE', headers: this.headers() },
        { timeoutMs: this.requestTimeoutMs, engine: ENGINE },
      )
      await res.body?.cancel().catch(() => {})
      if (!res.ok) this.logger?.warn('assemblyai transcript delete failed', { status: res.status })
    } catch {
      this.logger?.warn('assemblyai transcript delete failed', { status: 'network' })
    }
  }
}
