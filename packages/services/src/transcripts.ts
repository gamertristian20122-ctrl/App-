// Transcripts of clip sources: read (whole, a time range, or a text search for get_transcript /
// pick_clips) and the worker's save / fail, which settle or release the clipping time.

import { AppError } from '@app/core/errors'
import type { TimedText, TranscriptEngine } from '@app/core/types'
import { TRANSCRIPT_ENGINES } from '@app/core/types'
import { GetTranscriptInputSchema, TranscriptResultSchema } from '@app/core/validation'
import type { TranscriptRow } from '@app/db'
import { auditIn } from './audit'
import { conflict, errorMessage, fromZod, id, notFound, requireMedia, userIdOf, validation, withErrors, type Ctx } from './context'
import { isClipSource } from './media'
import { clipReserveKey, releaseIn, settleIn } from './usage'

export type TranscriptStatus = 'ready' | 'processing' | 'failed' | 'not_a_source'

export interface TranscriptMatch {
  /** Segment containing the match. */
  startMs: number
  endMs: number
  text: string
}

export interface TranscriptView {
  mediaId: string
  status: TranscriptStatus
  /** Shown when the transcript is not ready. */
  message?: string
  language: string | null
  durationMs: number | null
  /** Text of the requested range (whole transcript when no range). */
  text: string
  segments: TimedText[]
  /** Word timings of the requested range (only with a range, to keep responses small). */
  words?: TimedText[]
  /** Segments matching `query` (case-insensitive). */
  matches?: TranscriptMatch[]
  engine?: TranscriptEngine
}

/** Longest transcript text returned without a range (the AI can page with startMs/endMs). */
export const MAX_TRANSCRIPT_CHARS = 60_000

function overlaps(t: TimedText, startMs: number, endMs: number): boolean {
  return t.e > startMs && t.s < endMs
}

export function searchSegments(segments: readonly TimedText[], query: string, limit = 50): TranscriptMatch[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return []
  const out: TranscriptMatch[] = []
  for (const s of segments) {
    if (s.t.toLowerCase().includes(needle)) out.push({ startMs: s.s, endMs: s.e, text: s.t })
    if (out.length >= limit) break
  }
  return out
}

function viewOf(row: TranscriptRow, range: { startMs?: number; endMs?: number }, query?: string): TranscriptView {
  const hasRange = range.startMs !== undefined || range.endMs !== undefined
  const startMs = range.startMs ?? 0
  const endMs = range.endMs ?? Number.MAX_SAFE_INTEGER
  const segments = hasRange ? row.segments.filter((s) => overlaps(s, startMs, endMs)) : row.segments
  let text = hasRange ? segments.map((s) => s.t).join(' ') : row.text
  let truncated = false
  if (text.length > MAX_TRANSCRIPT_CHARS) {
    text = `${text.slice(0, MAX_TRANSCRIPT_CHARS)}…`
    truncated = true
  }
  return {
    mediaId: row.mediaId,
    status: 'ready',
    ...(truncated ? { message: 'The transcript is long; ask for a time range (startMs/endMs) to read the rest.' } : {}),
    language: row.language,
    durationMs: row.durationMs,
    text,
    segments,
    ...(hasRange ? { words: row.words.filter((w) => overlaps(w, startMs, endMs)) } : {}),
    ...(query ? { matches: searchSegments(row.segments, query) } : {}),
    engine: row.engine,
  }
}

export function createTranscriptsService(ctx: Ctx) {
  /** get_transcript: the whole transcript, a time range, and/or matches for a search phrase. */
  async function get(userId: string, input: unknown): Promise<TranscriptView> {
    const uid = userIdOf(userId)
    const data = fromZod(GetTranscriptInputSchema, input, 'Transcript request')
    const media = await requireMedia(ctx.repos, uid, data.mediaId)
    const empty = { mediaId: media.id, language: null, durationMs: media.durationMs, text: '', segments: [] }
    if (!isClipSource(media)) {
      return { ...empty, status: 'not_a_source', message: 'Only uploaded or linked videos marked as your own content are transcribed.' }
    }
    const row = await ctx.repos.transcripts.getByMedia(uid, media.id)
    if (row) {
      return viewOf(
        row,
        {
          ...(data.startMs !== undefined ? { startMs: data.startMs } : {}),
          ...(data.endMs !== undefined ? { endMs: data.endMs } : {}),
        },
        data.query,
      )
    }
    if (media.status === 'failed') return { ...empty, status: 'failed', message: 'This video could not be processed.' }
    const ledger = await ctx.repos.usage.listForSubject(uid, media.id)
    const released = ledger.some((e) => e.kind === 'release' && e.idempotencyKey === `${clipReserveKey(media.id)}:release`)
    if (released) return { ...empty, status: 'failed', message: 'Transcription failed. Upload the video again to retry.' }
    return { ...empty, status: 'processing', message: 'The transcript is being prepared. Try again in a few minutes.' }
  }

  return withErrors({
    get,

    /** The raw row (worker: captions need every word). */
    async getRow(userId: string, mediaId: string): Promise<TranscriptRow | null> {
      const uid = userIdOf(userId)
      const media = await requireMedia(ctx.repos, uid, mediaId)
      return ctx.repos.transcripts.getByMedia(uid, media.id)
    },

    /** Segments matching a phrase (case-insensitive). */
    async search(userId: string, mediaId: string, query: string): Promise<TranscriptMatch[]> {
      const view = await get(userId, { mediaId, query })
      if (view.status !== 'ready') throw conflict(view.message ?? 'The transcript is not ready.')
      return view.matches ?? []
    },

    /**
     * Worker (transcribe) result: validates and stores the transcript, then settles the source's
     * clipping-time reservation (charged once per source). Idempotent.
     */
    async save(userId: string, mediaId: string, input: { engine: string; result: unknown }): Promise<TranscriptRow> {
      const uid = userIdOf(userId)
      const engine = TRANSCRIPT_ENGINES.find((e) => e === input.engine)
      if (!engine) throw validation('Unknown transcription engine.')
      const result = fromZod(TranscriptResultSchema, input.result, 'Transcript')
      const media = await requireMedia(ctx.repos, uid, mediaId)
      if (!isClipSource(media)) throw validation('Only clip sources are transcribed.')
      if (media.status !== 'ready') throw conflict('The video is not ready.')
      return ctx.tx(async (r) => {
        const row = await r.transcripts.save(uid, {
          mediaId: media.id,
          engine,
          language: result.language,
          durationMs: result.durationMs,
          text: result.text,
          words: result.words,
          segments: result.segments,
        })
        const settled = await settleIn(r, uid, { reserveKey: clipReserveKey(media.id), subjectId: media.id })
        if (settled.created) {
          await auditIn(r, uid, {
            actor: 'worker',
            action: 'transcript.saved',
            subjectType: 'media',
            subjectId: media.id,
            meta: { engine, durationMs: result.durationMs, settledSeconds: settled.settled },
          })
        }
        return row
      })
    },

    /**
     * Worker: transcription failed for good. Releases the clipping time (auto-refund). Also works
     * after the user deleted the source mid-transcription.
     */
    async fail(userId: string, mediaId: string, error: unknown): Promise<{ released: number }> {
      const uid = userIdOf(userId)
      const media = await ctx.repos.media.get(uid, id(mediaId, 'Media'))
      if (!media) throw notFound('Media')
      return ctx.tx(async (r) => {
        const existing = await r.transcripts.getByMedia(uid, media.id)
        if (existing) throw new AppError('conflict', 'This video already has a transcript.')
        const result = await releaseIn(r, uid, { reserveKey: clipReserveKey(media.id), subjectId: media.id, note: 'transcription failed' })
        await auditIn(r, uid, {
          actor: 'worker',
          action: 'transcript.failed',
          subjectType: 'media',
          subjectId: media.id,
          meta: { reason: errorMessage(error, 'Transcription failed.').slice(0, 300), releasedSeconds: result.released },
        })
        return { released: result.released }
      })
    },
  })
}

export type TranscriptsService = ReturnType<typeof createTranscriptsService>
