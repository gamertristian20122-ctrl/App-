// Normalisation shared by every engine: raw timings (ms, possibly fractional, unsorted, overlapping)
// → TranscriptResult { language, durationMs, text, words: {s,e,t}[], segments: {s,e,t}[] } in integer ms,
// validated with TranscriptResultSchema from @app/core.
//
// Rules: words/segments are trimmed, empty ones dropped, sorted by start; e ≥ s; missing segments are
// built from words (sentence ends, pauses, length caps); missing words are spread over their segment
// in proportion to their length; durationMs = max(reported duration, last word/segment end);
// language = ISO 639 primary code ("english" → "en", "en_us" → "en"), "und" when unknown.

import type { TranscriptResult } from '@app/core/ports'
import type { TimedText } from '@app/core/types'
import { TranscriptResultSchema } from '@app/core/validation'
import { transcriptionError } from './errors'

export interface RawTiming {
  /** Start in ms (may be fractional). */
  start: number
  /** End in ms (may be fractional). */
  end: number
  text: string
}

export interface RawTranscript {
  language?: string | null
  durationMs?: number | null
  text?: string | null
  words?: RawTiming[] | null
  segments?: RawTiming[] | null
}

export interface SegmentOptions {
  /** Start a new segment after a pause this long (default 1200 ms). */
  maxGapMs?: number
  /** Close a segment once it is this long (default 12 s). */
  maxDurationMs?: number
  /** Close a segment after this many words (default 40). */
  maxWords?: number
}

const SENTENCE_END = /[.!?…。！？]["'”’)\]]*$/u

function cleanText(t: string): string {
  return t.replace(/\s+/g, ' ').trim()
}

function toTimed(items: RawTiming[] | null | undefined): TimedText[] {
  const out: TimedText[] = []
  for (const item of items ?? []) {
    if (!Number.isFinite(item.start) || !Number.isFinite(item.end)) continue
    const t = cleanText(item.text)
    if (!t) continue
    const s = Math.max(0, Math.round(item.start))
    const e = Math.max(s, Math.round(item.end))
    out.push({ s, e, t })
  }
  // Stable sort by start (engines occasionally emit slightly out-of-order words).
  return out.map((w, i) => [w, i] as const).sort((a, b) => a[0].s - b[0].s || a[1] - b[1]).map(([w]) => w)
}

/** Groups words into sentence-like segments. */
export function segmentsFromWords(words: TimedText[], options: SegmentOptions = {}): TimedText[] {
  const { maxGapMs = 1200, maxDurationMs = 12_000, maxWords = 40 } = options
  const segments: TimedText[] = []
  let current: TimedText[] = []
  const flush = () => {
    if (current.length === 0) return
    const first = current[0] as TimedText
    const last = current[current.length - 1] as TimedText
    const e = current.reduce((max, w) => (w.e > max ? w.e : max), last.e)
    segments.push({ s: first.s, e, t: current.map((w) => w.t).join(' ') })
    current = []
  }
  for (let i = 0; i < words.length; i++) {
    const w = words[i] as TimedText
    current.push(w)
    const next = words[i + 1]
    const first = current[0] as TimedText
    if (
      !next ||
      SENTENCE_END.test(w.t) ||
      next.s - w.e >= maxGapMs ||
      w.e - first.s >= maxDurationMs ||
      current.length >= maxWords
    ) {
      flush()
    }
  }
  flush()
  return segments
}

/** Spreads each segment's words over its time span in proportion to their length (for engines without word timings). */
export function wordsFromSegments(segments: TimedText[]): TimedText[] {
  const words: TimedText[] = []
  for (const seg of segments) {
    const tokens = seg.t.split(/\s+/).filter(Boolean)
    if (tokens.length === 0) continue
    const weights = tokens.map((t) => Math.max(1, [...t].length))
    const total = weights.reduce((a, b) => a + b, 0)
    const span = seg.e - seg.s
    let acc = 0
    tokens.forEach((t, i) => {
      const s = seg.s + Math.round((acc / total) * span)
      acc += weights[i] as number
      const e = seg.s + Math.round((acc / total) * span)
      words.push({ s, e: Math.max(s, e), t })
    })
  }
  return words
}

// Whisper reports languages by name (OpenAI) or by code (most self-hosted servers).
const WHISPER_LANGUAGE_CODES: Readonly<Record<string, string>> = {
  english: 'en', chinese: 'zh', german: 'de', spanish: 'es', russian: 'ru', korean: 'ko', french: 'fr',
  japanese: 'ja', portuguese: 'pt', turkish: 'tr', polish: 'pl', catalan: 'ca', dutch: 'nl', arabic: 'ar',
  swedish: 'sv', italian: 'it', indonesian: 'id', hindi: 'hi', finnish: 'fi', vietnamese: 'vi', hebrew: 'he',
  ukrainian: 'uk', greek: 'el', malay: 'ms', czech: 'cs', romanian: 'ro', danish: 'da', hungarian: 'hu',
  tamil: 'ta', norwegian: 'no', thai: 'th', urdu: 'ur', croatian: 'hr', bulgarian: 'bg', lithuanian: 'lt',
  latin: 'la', maori: 'mi', malayalam: 'ml', welsh: 'cy', slovak: 'sk', telugu: 'te', persian: 'fa',
  latvian: 'lv', bengali: 'bn', serbian: 'sr', azerbaijani: 'az', slovenian: 'sl', kannada: 'kn',
  estonian: 'et', macedonian: 'mk', breton: 'br', basque: 'eu', icelandic: 'is', armenian: 'hy',
  nepali: 'ne', mongolian: 'mn', bosnian: 'bs', kazakh: 'kk', albanian: 'sq', swahili: 'sw', galician: 'gl',
  marathi: 'mr', punjabi: 'pa', sinhala: 'si', khmer: 'km', shona: 'sn', yoruba: 'yo', somali: 'so',
  afrikaans: 'af', occitan: 'oc', georgian: 'ka', belarusian: 'be', tajik: 'tg', sindhi: 'sd',
  gujarati: 'gu', amharic: 'am', yiddish: 'yi', lao: 'lo', uzbek: 'uz', faroese: 'fo', 'haitian creole': 'ht',
  pashto: 'ps', turkmen: 'tk', nynorsk: 'nn', maltese: 'mt', sanskrit: 'sa', luxembourgish: 'lb',
  myanmar: 'my', burmese: 'my', tibetan: 'bo', tagalog: 'tl', malagasy: 'mg', assamese: 'as', tatar: 'tt',
  hawaiian: 'haw', lingala: 'ln', hausa: 'ha', bashkir: 'ba', javanese: 'jw', sundanese: 'su', cantonese: 'yue',
}

/** "English" → "en", "en_us" / "en-US" → "en", "yue" → "yue"; anything else → "und". */
export function normalizeLanguage(raw: string | null | undefined): string {
  const v = (raw ?? '').trim().toLowerCase()
  if (!v) return 'und'
  const byName = WHISPER_LANGUAGE_CODES[v]
  if (byName) return byName
  const m = /^([a-z]{2,3})(?:[-_][a-z0-9]{1,8})*$/.exec(v)
  return m ? (m[1] as string) : 'und'
}

/** Builds a validated TranscriptResult from raw engine output. */
export function normalizeTranscript(raw: RawTranscript, engine: string, options: SegmentOptions = {}): TranscriptResult {
  let words = toTimed(raw.words)
  let segments = toTimed(raw.segments)
  if (words.length === 0 && segments.length > 0) words = wordsFromSegments(segments)
  if (segments.length === 0 && words.length > 0) segments = segmentsFromWords(words, options)

  const text =
    cleanText(raw.text ?? '') || segments.map((s) => s.t).join(' ') || words.map((w) => w.t).join(' ')
  const reported = typeof raw.durationMs === 'number' && Number.isFinite(raw.durationMs) ? Math.max(0, Math.round(raw.durationMs)) : 0
  // reduce, not Math.max(...spread): a 4-hour source has ~40k words.
  const lastEnd = (items: TimedText[]) => items.reduce((max, i) => (i.e > max ? i.e : max), 0)
  const durationMs = Math.max(reported, lastEnd(words), lastEnd(segments))

  const result = TranscriptResultSchema.safeParse({
    language: normalizeLanguage(raw.language),
    durationMs,
    text,
    words,
    segments,
  })
  if (!result.success) {
    throw transcriptionError('malformed_response', 'The transcription engine returned an unusable transcript.', { engine })
  }
  return result.data
}
