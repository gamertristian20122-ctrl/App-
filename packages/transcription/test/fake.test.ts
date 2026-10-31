import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { TranscriptResultSchema } from '@app/core/validation'
import { transcriptionErrorReason } from '../src/errors'
import { FAKE_TRANSCRIPT_TEXT, FakeTranscriber, fakeWords } from '../src/fake'
import { tempAudio } from './helpers'

describe('FakeTranscriber', () => {
  it('returns the same deterministic transcript every time', async () => {
    const t = new FakeTranscriber()
    const a = await t.transcribe({ filePath: '/any/file.mp4' })
    const b = await t.transcribe({ filePath: '/other/file.mp4', language: 'en' })
    expect(a).toEqual(b)
    expect(TranscriptResultSchema.safeParse(a).success).toBe(true)
    expect(a.language).toBe('en')
    expect(a.text).toBe(FAKE_TRANSCRIPT_TEXT)
    expect(a.words[0]).toEqual({ s: 500, e: 820, t: 'Here' })
    expect(a.words[1]).toEqual({ s: 900, e: 1220, t: 'is' })
    expect(a.segments[0]?.t).toBe('Here is the mistake almost every creator makes with long videos.')
    expect(a.segments.length).toBe(17)
    expect(a.durationMs).toBe((a.words.at(-1)?.e ?? 0) + 1000)
    expect(a.durationMs).toBeGreaterThan(90_000)
    expect(t.calls).toEqual([{ filePath: '/any/file.mp4' }, { filePath: '/other/file.mp4', language: 'en' }])
    expect(t.name).toBe('fake')
  })

  it('uses custom text, words, repeat and language', async () => {
    const r1 = await new FakeTranscriber({ text: 'One. Two.', repeat: 2, language: 'de' }).transcribe({ filePath: 'x' })
    expect(r1.words.map((w) => w.t)).toEqual(['One.', 'Two.', 'One.', 'Two.'])
    expect(r1.language).toBe('de')
    expect(r1.words[1]).toEqual({ s: 1300, e: 1620, t: 'Two.' })
    const words = [
      { s: 0, e: 100, t: 'a' },
      { s: 100, e: 200, t: 'b.' },
    ]
    const r2 = await new FakeTranscriber({ words, tailMs: 0 }).transcribe({ filePath: 'x' })
    expect(r2.words).toEqual(words)
    expect(r2.durationMs).toBe(200)
    expect(fakeWords('a b', { wordMs: 10, gapMs: 0, leadInMs: 0 })).toEqual([
      { s: 0, e: 10, t: 'a' },
      { s: 10, e: 20, t: 'b' },
    ])
  })

  it('can fail on demand and check the file', async () => {
    const t = new FakeTranscriber({ name: 'whisper', requireFile: true })
    t.failNext()
    const { dir, path } = await tempAudio()
    try {
      await expect(t.transcribe({ filePath: path })).rejects.toMatchObject({ details: { reason: 'engine_unavailable', engine: 'whisper' } })
      expect((await t.transcribe({ filePath: path })).words.length).toBeGreaterThan(0)
      const err = await t.transcribe({ filePath: join(dir, 'missing.mp3') }).catch((e: unknown) => e)
      expect(transcriptionErrorReason(err)).toBe('input_invalid')
      const aborted = await t.transcribe({ filePath: path, signal: AbortSignal.abort() }).catch((e: unknown) => e)
      expect(transcriptionErrorReason(aborted)).toBe('aborted')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
