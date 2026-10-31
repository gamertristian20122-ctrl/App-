// The fallback chain: try each engine in order (Whisper first, then AssemblyAI) and report which one
// produced the transcript. Input errors and cancellation stop the chain (another engine cannot help).

import { AppError, isAppError } from '@app/core/errors'
import type { Logger } from '@app/core/log'
import type { HealthCheckResult, TranscriptResult, Transcriber } from '@app/core/ports'
import { shouldFallBack, transcriptionErrorReason } from './errors'
import type { DetailedTranscriber, DetailedTranscription, TranscribeInput, TranscriptionAttempt } from './shared'

export interface FallbackOptions {
  logger?: Logger
  /** Override when to move on to the next engine (default: shouldFallBack from errors.ts). */
  shouldFallBack?: (error: unknown, engine: string) => boolean
  now?: () => number
}

export class FallbackTranscriber implements Transcriber, DetailedTranscriber {
  readonly name = 'chain'
  readonly engines: readonly Transcriber[]
  private readonly logger: Logger | undefined
  private readonly decide: (error: unknown, engine: string) => boolean
  private readonly now: () => number

  constructor(engines: readonly Transcriber[], options: FallbackOptions = {}) {
    if (engines.length === 0) throw new AppError('internal', 'The transcription chain needs at least one engine.')
    this.engines = [...engines]
    this.logger = options.logger
    this.decide = options.shouldFallBack ?? ((err) => shouldFallBack(err))
    this.now = options.now ?? Date.now
  }

  async transcribe(input: TranscribeInput): Promise<TranscriptResult> {
    return (await this.transcribeDetailed(input)).result
  }

  /** Every engine's health check; ok only when all of them are (a broken first engine still costs time). */
  async healthCheck(): Promise<HealthCheckResult> {
    const results = await Promise.all(this.engines.map((e) => engineHealth(e)))
    return {
      ok: results.every((r) => r.ok),
      detail: results.map((r) => `${engineLabelFor(r.engine)}: ${r.detail ?? (r.ok ? 'OK' : 'not OK')}`).join(' '),
    }
  }

  async transcribeDetailed(input: TranscribeInput): Promise<DetailedTranscription> {
    const attempts: TranscriptionAttempt[] = []
    let lastError: unknown
    for (const [i, engine] of this.engines.entries()) {
      const started = this.now()
      try {
        const inner = await transcribeWithEngine(engine, input)
        attempts.push(...inner.attempts.map((a) => ({ ...a })))
        if (i > 0) this.logger?.info('transcription fallback succeeded', { engine: inner.engine, attempts: attempts.length })
        return { engine: inner.engine, result: inner.result, attempts }
      } catch (err) {
        lastError = err
        const reason = transcriptionErrorReason(err)
        const nested = isAppError(err) && reason === 'all_failed' ? (err.details?.attempts as TranscriptionAttempt[] | undefined) : undefined
        if (nested) attempts.push(...nested)
        else {
          attempts.push({
            engine: engine.name,
            ok: false,
            code: isAppError(err) ? err.code : 'internal',
            reason: reason ?? 'unknown',
            message: isAppError(err) ? err.message : 'Unexpected error.',
            ms: this.now() - started,
          })
        }
        const next = this.engines[i + 1]
        if (!next || !this.decide(err, engine.name)) break
        this.logger?.warn('transcription engine failed, trying the next one', {
          engine: engine.name,
          next: next.name,
          reason: reason ?? 'unknown',
          code: isAppError(err) ? err.code : 'internal',
        })
      }
    }
    // Keep the last error's code (a user-facing "no audio" stays bad_request) and list every attempt.
    // A single attempt (no fallback happened) rethrows the original error unchanged.
    if (attempts.length === 1) throw lastError
    const last = isAppError(lastError) ? lastError : undefined
    throw new AppError(
      last?.code ?? 'unavailable',
      last?.message ?? 'Transcription failed. Please try again later.',
      { reason: 'all_failed', attempts },
      { cause: lastError },
    )
  }
}

/** createFallbackTranscriber([whisper, assemblyai]) */
export function createFallbackTranscriber(engines: readonly Transcriber[], options: FallbackOptions = {}): FallbackTranscriber {
  return new FallbackTranscriber(engines, options)
}

function hasDetailed(t: Transcriber): t is Transcriber & DetailedTranscriber {
  return typeof (t as Partial<DetailedTranscriber>).transcribeDetailed === 'function'
}

/**
 * Runs any Transcriber and says which engine produced the result (the value for transcripts.engine;
 * every Transcriber in this package is named after a TRANSCRIPT_ENGINES value, the chain reports the
 * engine that answered). The worker should always call this instead of transcribe().
 */
export async function transcribeWithEngine(transcriber: Transcriber, input: TranscribeInput): Promise<DetailedTranscription> {
  if (hasDetailed(transcriber)) return transcriber.transcribeDetailed(input)
  const started = Date.now()
  const result = await transcriber.transcribe(input)
  const engine = transcriber.name
  return { engine, result, attempts: [{ engine, ok: true, ms: Date.now() - started }] }
}

/** One engine's health (engines without a healthCheck count as healthy). Never throws. */
export interface EngineHealth extends HealthCheckResult {
  engine: string
}

export async function engineHealth(engine: Transcriber): Promise<EngineHealth> {
  if (typeof engine.healthCheck !== 'function') return { engine: engine.name, ok: true, detail: 'No health check available.' }
  try {
    return { engine: engine.name, ...(await engine.healthCheck()) }
  } catch {
    return { engine: engine.name, ok: false, detail: 'The health check failed unexpectedly.' }
  }
}

function engineLabelFor(engine: string): string {
  return engine === 'assemblyai' ? 'AssemblyAI' : engine === 'whisper' ? 'Whisper' : engine
}
