// Burned-in captions for vertical clips: transcript words (clip-relative ms) → an ASS subtitle file
// for ffmpeg's `ass` filter (libass). Lines of 2–4 words, broken at sentence ends, long pauses and
// a character budget; each word gets its own event so the spoken word is highlighted. Text sits in
// the platform safe area (above TikTok/Reels captions and buttons, clear of the right-hand rail).
// Fonts come from the worker image (fonts-noto-core; fontconfig falls back to DejaVu elsewhere).

import type { TimedText } from '@app/core/types'
import type { CaptionStyle } from '@app/core/validation'

export const CAPTION_FONT = 'Noto Sans'

export interface CaptionLine {
  startMs: number
  endMs: number
  words: TimedText[]
}

export interface GroupOptions {
  maxWords?: number
  minWords?: number
  maxChars?: number
  /** A pause longer than this ends the line. */
  maxGapMs?: number
}

interface StyleSpec {
  fontSize: number
  bold: boolean
  maxChars: number
  /** ASS colours (&HAABBGGRR). */
  primary: string
  outline: string
  back: string
  borderStyle: 1 | 3
  outlineWidth: number
  shadow: number
  /** How the spoken word stands out: only the current word, every word spoken so far, or none. */
  highlight: 'current' | 'progressive' | 'none'
  highlightColour: string
  /** Scale (%) of the highlighted word. */
  highlightScale: number
}

/** Safe area for 1080×1920: bottom ~28% (captions, buttons) and right ~11% (action rail) stay clear. */
export const SAFE_MARGINS = { left: 110, right: 150, bottom: 540 } as const

const WHITE = '&H00FFFFFF'
const BLACK = '&H00000000'
const YELLOW = '&H0000E5FF'
const GREEN = '&H0055E07A'

const STYLES: Readonly<Record<Exclude<CaptionStyle, 'none'>, StyleSpec>> = {
  bold: {
    fontSize: 84,
    bold: true,
    maxChars: 18,
    primary: WHITE,
    outline: BLACK,
    back: '&H80000000',
    borderStyle: 1,
    outlineWidth: 6,
    shadow: 2,
    highlight: 'current',
    highlightColour: YELLOW,
    highlightScale: 108,
  },
  karaoke: {
    fontSize: 84,
    bold: true,
    maxChars: 18,
    primary: WHITE,
    outline: BLACK,
    back: '&H80000000',
    borderStyle: 1,
    outlineWidth: 6,
    shadow: 2,
    highlight: 'progressive',
    highlightColour: GREEN,
    highlightScale: 100,
  },
  minimal: {
    fontSize: 62,
    bold: false,
    maxChars: 26,
    primary: WHITE,
    // BorderStyle 3: OutlineColour is the box behind the text
    outline: '&H66000000',
    back: '&H00000000',
    borderStyle: 3,
    outlineWidth: 14,
    shadow: 0,
    highlight: 'none',
    highlightColour: WHITE,
    highlightScale: 100,
  },
}

/** Word text safe for an ASS event: no override braces, backslashes or control characters. */
export function cleanWord(text: string): string {
  return text
    .replace(/[\u0000-\u001f\u007f{}\\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40)
}

const SENTENCE_END = /[.!?…;:]["')\]]*$/
const CLAUSE_END = /[,]["')\]]*$/

/** Groups words into caption lines of 2–4 words (fewer only at pauses, sentence ends or the end). */
export function groupCaptionLines(input: readonly TimedText[], options: GroupOptions = {}): CaptionLine[] {
  const maxWords = options.maxWords ?? 4
  const minWords = options.minWords ?? 2
  const maxChars = options.maxChars ?? 18
  const maxGapMs = options.maxGapMs ?? 600
  const words = input
    .map((w) => ({ s: Math.max(0, Math.round(w.s)), e: Math.max(0, Math.round(w.e)), t: cleanWord(w.t) }))
    .filter((w) => w.t !== '' && w.e > w.s)
    .sort((a, b) => a.s - b.s)

  const lines: CaptionLine[] = []
  let current: TimedText[] = []
  let chars = 0
  const flush = () => {
    if (current.length === 0) return
    const first = current[0] as TimedText
    const last = current[current.length - 1] as TimedText
    lines.push({ startMs: first.s, endMs: last.e, words: current })
    current = []
    chars = 0
  }
  for (const [i, word] of words.entries()) {
    const next = words[i + 1]
    const pause = next ? next.s - word.e > maxGapMs : true
    const sentence = SENTENCE_END.test(word.t)
    const extra = (current.length > 0 ? 1 : 0) + word.t.length
    // a word that closes the phrase may stretch the budget a little rather than sit alone
    const budget = pause || sentence ? maxChars + 6 : maxChars
    if (current.length > 0 && (current.length >= maxWords || (chars + extra > budget && current.length >= minWords) || chars + extra > maxChars + 6)) {
      flush()
    }
    current.push(word)
    chars += (current.length > 1 ? 1 : 0) + word.t.length
    const clause = CLAUSE_END.test(word.t) && current.length >= minWords
    if (pause || sentence || clause) flush()
  }
  flush()
  return lines
}

/** ASS timestamp h:mm:ss.cc */
export function assTime(ms: number): string {
  const cs = Math.max(0, Math.floor(ms / 10))
  const h = Math.floor(cs / 360_000)
  const m = Math.floor((cs % 360_000) / 6_000)
  const s = Math.floor((cs % 6_000) / 100)
  const c = cs % 100
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(c).padStart(2, '0')}`
}

/** Line display times: stay up until the next line when the gap is short, linger briefly otherwise. */
function lineTimes(lines: CaptionLine[], durationMs: number): Array<{ start: number; end: number }> {
  return lines.map((line, i) => {
    const next = lines[i + 1]
    const linger = line.endMs + 250
    const end = next && next.startMs - line.endMs < 500 ? next.startMs : next ? Math.min(linger, next.startMs) : linger
    return { start: Math.min(line.startMs, durationMs), end: Math.min(Math.max(end, line.startMs + 300), durationMs) }
  })
}

function lineText(words: readonly TimedText[], active: number, spec: StyleSpec): string {
  return words
    .map((w, i) => {
      const on = spec.highlight === 'current' ? i === active : spec.highlight === 'progressive' ? i <= active : false
      if (!on) return w.t
      const scale = spec.highlightScale !== 100 ? `\\fscx${spec.highlightScale}\\fscy${spec.highlightScale}` : ''
      return `{\\1c${spec.highlightColour}&${scale}}${w.t}{\\r}`
    })
    .join(' ')
}

export interface AssOptions {
  style: CaptionStyle
  /** Clip length (ms): nothing is shown after it. */
  durationMs: number
  width?: number
  height?: number
  font?: string
}

/** The ASS document for `words` (clip-relative ms), or null when there is nothing to show. */
export function buildAss(words: readonly TimedText[], options: AssOptions): string | null {
  if (options.style === 'none') return null
  const spec = STYLES[options.style]
  const lines = groupCaptionLines(words, { maxChars: spec.maxChars })
  if (lines.length === 0) return null
  const width = options.width ?? 1080
  const height = options.height ?? 1920
  const scale = width / 1080
  const font = (options.font ?? CAPTION_FONT).replace(/[,\r\n]/g, ' ')
  const style = [
    'Caption',
    font,
    Math.round(spec.fontSize * scale),
    spec.primary,
    spec.primary,
    spec.outline,
    spec.back,
    spec.bold ? -1 : 0,
    0,
    0,
    0,
    100,
    100,
    0,
    0,
    spec.borderStyle,
    Math.round(spec.outlineWidth * scale),
    Math.round(spec.shadow * scale),
    2,
    Math.round(SAFE_MARGINS.left * scale),
    Math.round(SAFE_MARGINS.right * scale),
    Math.round(SAFE_MARGINS.bottom * (height / 1920)),
    1,
  ].join(',')

  const events: string[] = []
  const times = lineTimes(lines, options.durationMs)
  for (const [li, line] of lines.entries()) {
    const { start, end } = times[li] as { start: number; end: number }
    if (end <= start) continue
    if (spec.highlight === 'none') {
      events.push(`Dialogue: 0,${assTime(start)},${assTime(end)},Caption,,0,0,0,,${lineText(line.words, -1, spec)}`)
      continue
    }
    for (const [wi, word] of line.words.entries()) {
      const next = line.words[wi + 1]
      const ws = wi === 0 ? start : Math.max(start, word.s)
      const we = next ? Math.min(end, next.s) : end
      if (assTime(we) === assTime(ws) || we <= ws) continue
      events.push(`Dialogue: 0,${assTime(ws)},${assTime(we)},Caption,,0,0,0,,${lineText(line.words, wi, spec)}`)
    }
  }
  if (events.length === 0) return null

  return [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${width}`,
    `PlayResY: ${height}`,
    'WrapStyle: 0',
    'ScaledBorderAndShadow: yes',
    'YCbCr Matrix: TV.709',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: ${style}`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    ...events,
    '',
  ].join('\n')
}
