// FakeTranscriber: deterministic transcripts for tests and local dev (TRANSCRIPTION_PROVIDER=fake).
// Words come from a fixture monologue (or your own text/words) with fixed timings, so clip ranges,
// captions and get_transcript paging can be asserted exactly. It never reads the file unless
// `requireFile` is set.

import { stat } from 'node:fs/promises'
import type { HealthCheckResult, TranscriptResult, Transcriber } from '@app/core/ports'
import type { TimedText } from '@app/core/types'
import { transcriptionError } from './errors'
import { normalizeTranscript } from './normalize'
import { checkInput, throwIfAborted, type TranscribeInput } from './shared'

/**
 * The default fixture: a creator talking about repurposing long videos, written with several
 * standalone moments that open with a hook (useful for pick_clips / make_clips in dev).
 */
export const FAKE_TRANSCRIPT_TEXT = [
  'Here is the mistake almost every creator makes with long videos.',
  'You spend ten hours editing one episode and then you post it exactly once.',
  'That is like cooking a feast and serving a single plate.',
  'So here is what I do instead.',
  'I take every long video and I cut it into five short clips, each one with its own hook.',
  'The first three seconds decide everything, so the hook has to come first.',
  'Nobody cares about your intro, nobody cares about your logo, they care about the problem you solve.',
  'Here is a simple test.',
  'If a clip still makes sense when someone scrolls into it with no context, it is a good clip.',
  'If it needs the previous five minutes to make sense, cut somewhere else.',
  'The second thing is consistency.',
  'Posting one great clip a month loses to posting one good clip every day.',
  'The algorithm rewards people who show up, and so does your audience.',
  'And the last thing, write the caption in your own voice.',
  'People can tell when a caption was written by a robot, and they scroll right past it.',
  'Try this for thirty days and look at your numbers.',
  'I promise you will never post a long video only once again.',
].join(' ')

export interface FakeTranscriberOptions {
  /** Text to "transcribe" (default FAKE_TRANSCRIPT_TEXT). Ignored when `words` is given. */
  text?: string
  /** Exact words to return (ms). Segments are built from them. */
  words?: TimedText[]
  /** Repeat the text this many times (longer sources). Default 1. */
  repeat?: number
  language?: string
  /** Time per word (default 320 ms) and gap after it (default 80 ms). */
  wordMs?: number
  gapMs?: number
  /** Extra pause after a sentence end (default 400 ms). */
  sentencePauseMs?: number
  /** Silence before the first word (default 500 ms) and after the last (default 1000 ms). */
  leadInMs?: number
  tailMs?: number
  /** Check that the input file exists (default false). */
  requireFile?: boolean
  /** Name reported as the engine (default 'fake'). Tests of the fallback chain use 'whisper'/'assemblyai'. */
  name?: string
}

/** Deterministic word timings for `text`. */
export function fakeWords(text: string, options: Omit<FakeTranscriberOptions, 'text' | 'words' | 'language' | 'requireFile' | 'name'> = {}): TimedText[] {
  const { repeat = 1, wordMs = 320, gapMs = 80, sentencePauseMs = 400, leadInMs = 500 } = options
  const tokens = text.split(/\s+/).filter(Boolean)
  const words: TimedText[] = []
  let t = leadInMs
  for (let r = 0; r < Math.max(1, Math.floor(repeat)); r++) {
    for (const token of tokens) {
      words.push({ s: t, e: t + wordMs, t: token })
      t += wordMs + gapMs
      if (/[.!?]$/.test(token)) t += sentencePauseMs
    }
  }
  return words
}

export class FakeTranscriber implements Transcriber {
  readonly name: string
  /** Every input received, in order (for assertions). */
  readonly calls: Array<{ filePath: string; language?: string }> = []
  private readonly options: FakeTranscriberOptions
  private failures: Error[] = []

  constructor(options: FakeTranscriberOptions = {}) {
    this.options = options
    this.name = options.name ?? 'fake'
  }

  /** The next call(s) throw `error` (default: an engine_unavailable AppError). */
  failNext(error?: Error, times = 1): void {
    for (let i = 0; i < times; i++) {
      this.failures.push(error ?? transcriptionError('engine_unavailable', `${this.name} is unavailable (scripted).`, { engine: this.name }))
    }
  }

  /** Healthy unless a failure is scripted (failNext), which it reports without consuming it. */
  async healthCheck(): Promise<HealthCheckResult> {
    if (this.failures.length > 0) return { ok: false, detail: `${this.name} is unavailable (scripted).` }
    return { ok: true, detail: 'Test mode: fake transcripts (no real speech-to-text).' }
  }

  async transcribe(input: TranscribeInput): Promise<TranscriptResult> {
    const { filePath, language, signal } = checkInput(input, this.name)
    this.calls.push(language ? { filePath, language } : { filePath })
    throwIfAborted(signal, this.name)
    if (this.options.requireFile) {
      const ok = await stat(filePath).then((s) => s.isFile() && s.size > 0, () => false)
      if (!ok) throw transcriptionError('input_invalid', 'The audio file to transcribe was not found.', { engine: this.name })
    }
    const failure = this.failures.shift()
    if (failure) throw failure

    const words = this.options.words ?? fakeWords(this.options.text ?? FAKE_TRANSCRIPT_TEXT, this.options)
    const lastEnd = words.reduce((m, w) => Math.max(m, w.e), 0)
    return normalizeTranscript(
      {
        language: this.options.language ?? language ?? 'en',
        durationMs: lastEnd + (this.options.tailMs ?? 1000),
        words: words.map((w) => ({ start: w.s, end: w.e, text: w.t })),
      },
      this.name,
    )
  }
}
