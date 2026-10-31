import { describe, expect, it } from 'vitest'
import { TranscriptResultSchema } from '@app/core/validation'
import { normalizeLanguage, normalizeTranscript, segmentsFromWords, wordsFromSegments } from '../src/normalize'

describe('normalizeTranscript', () => {
  it('rounds to integer ms, trims, drops empty words, sorts and fixes inverted times', () => {
    const r = normalizeTranscript(
      {
        language: 'English',
        durationMs: 2000.4,
        words: [
          { start: 900.6, end: 1200.2, text: ' world. ' },
          { start: 100.4, end: 500.5, text: ' Hello' },
          { start: 1300, end: 1250, text: 'again' },
          { start: 1400, end: 1500, text: '   ' },
          { start: Number.NaN, end: 10, text: 'nan' },
          { start: -5, end: 40, text: 'neg' },
        ],
      },
      'test',
    )
    expect(r.words).toEqual([
      { s: 0, e: 40, t: 'neg' },
      { s: 100, e: 501, t: 'Hello' },
      { s: 901, e: 1200, t: 'world.' },
      { s: 1300, e: 1300, t: 'again' },
    ])
    expect(r.language).toBe('en')
    expect(r.durationMs).toBe(2000)
    expect(r.text).toBe('neg Hello world. again')
    expect(TranscriptResultSchema.safeParse(r).success).toBe(true)
  })

  it('takes the duration from the last word when the engine under-reports it', () => {
    const r = normalizeTranscript({ durationMs: 1000, words: [{ start: 0, end: 1500, text: 'long' }] }, 'test')
    expect(r.durationMs).toBe(1500)
    expect(r.language).toBe('und')
  })

  it('builds segments from words and words from segments', () => {
    const fromWords = normalizeTranscript({ words: [{ start: 0, end: 100, text: 'Hi.' }, { start: 200, end: 300, text: 'Bye.' }] }, 't')
    expect(fromWords.segments).toEqual([
      { s: 0, e: 100, t: 'Hi.' },
      { s: 200, e: 300, t: 'Bye.' },
    ])
    const fromSegments = normalizeTranscript({ segments: [{ start: 0, end: 1000, text: 'ab abcd' }], text: '' }, 't')
    expect(fromSegments.words.map((w) => w.t)).toEqual(['ab', 'abcd'])
    expect(fromSegments.words[0]).toEqual({ s: 0, e: 333, t: 'ab' })
    expect(fromSegments.words[1]).toEqual({ s: 333, e: 1000, t: 'abcd' })
    expect(fromSegments.text).toBe('ab abcd')
  })

  it('accepts an empty transcript (silent video)', () => {
    const r = normalizeTranscript({ text: '', words: [], segments: [], durationMs: 5000, language: 'en' }, 't')
    expect(r).toEqual({ language: 'en', durationMs: 5000, text: '', words: [], segments: [] })
  })

  it('handles very long transcripts', () => {
    const words = Array.from({ length: 60_000 }, (_, i) => ({ start: i * 400, end: i * 400 + 300, text: i % 10 === 9 ? 'end.' : 'word' }))
    const r = normalizeTranscript({ words }, 't')
    expect(r.words).toHaveLength(60_000)
    expect(r.segments).toHaveLength(6_000)
    expect(r.durationMs).toBe(59_999 * 400 + 300)
  })
})

describe('segmentsFromWords', () => {
  const w = (s: number, t: string) => ({ s, e: s + 100, t })

  it('splits on sentence ends, long pauses, word and duration caps', () => {
    expect(segmentsFromWords([w(0, 'One'), w(150, 'two.'), w(300, 'Three')]).map((s) => s.t)).toEqual(['One two.', 'Three'])
    expect(segmentsFromWords([w(0, 'a'), w(5000, 'b')]).map((s) => s.t)).toEqual(['a', 'b'])
    expect(segmentsFromWords([w(0, 'a'), w(150, 'b'), w(300, 'c')], { maxWords: 2 }).map((s) => s.t)).toEqual(['a b', 'c'])
    expect(segmentsFromWords([w(0, 'a'), w(11_950, 'b'), w(12_100, 'c')], { maxGapMs: 99_999 }).map((s) => s.t)).toEqual([
      'a b',
      'c',
    ])
    expect(segmentsFromWords([w(0, '"Really?"'), w(150, 'Yes')]).map((s) => s.t)).toEqual(['"Really?"', 'Yes'])
    expect(segmentsFromWords([])).toEqual([])
  })
})

describe('wordsFromSegments', () => {
  it('spreads words over the segment in proportion to their length', () => {
    const words = wordsFromSegments([{ s: 1000, e: 2000, t: 'a bbb' }])
    expect(words).toEqual([
      { s: 1000, e: 1250, t: 'a' },
      { s: 1250, e: 2000, t: 'bbb' },
    ])
    expect(wordsFromSegments([{ s: 0, e: 0, t: '' }])).toEqual([])
  })
})

describe('normalizeLanguage', () => {
  it('maps names and regional codes to ISO 639 primary codes', () => {
    expect(normalizeLanguage('english')).toBe('en')
    expect(normalizeLanguage('Spanish')).toBe('es')
    expect(normalizeLanguage('haitian creole')).toBe('ht')
    expect(normalizeLanguage('en_us')).toBe('en')
    expect(normalizeLanguage('pt-BR')).toBe('pt')
    expect(normalizeLanguage('yue')).toBe('yue')
    expect(normalizeLanguage('')).toBe('und')
    expect(normalizeLanguage(null)).toBe('und')
    expect(normalizeLanguage('klingonese')).toBe('und')
  })
})
