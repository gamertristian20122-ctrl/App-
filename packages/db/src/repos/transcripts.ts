import type { TimedText, TranscriptEngine } from '@app/core/types'
import { camelRow, json } from '../sql'
import type { Db } from '../types'

export interface TranscriptRow {
  id: string
  userId: string
  mediaId: string
  engine: TranscriptEngine
  language: string | null
  durationMs: number
  text: string
  words: TimedText[]
  segments: TimedText[]
  createdAt: Date
  updatedAt: Date
}

const map = (row: Record<string, unknown> | null): TranscriptRow | null => (row ? camelRow<TranscriptRow>(row) : null)

export interface SaveTranscriptInput {
  mediaId: string
  engine: TranscriptEngine
  language?: string | null
  durationMs: number
  text: string
  words: readonly TimedText[]
  segments: readonly TimedText[]
}

/** Inserts the media's transcript or replaces it (one transcript per media). */
export async function save(db: Db, userId: string, input: SaveTranscriptInput): Promise<TranscriptRow> {
  const row = await db.one(
    `insert into public.transcripts as t (user_id, media_id, engine, language, duration_ms, text, words, segments)
     values ($1, $2, $3, $4, $5::int, $6, $7::text::jsonb, $8::text::jsonb)
     on conflict (media_id) do update set
       engine = excluded.engine, language = excluded.language, duration_ms = excluded.duration_ms,
       text = excluded.text, words = excluded.words, segments = excluded.segments
     where t.user_id = excluded.user_id
     returning *`,
    [
      userId,
      input.mediaId,
      input.engine,
      input.language ?? null,
      input.durationMs,
      input.text,
      json(input.words),
      json(input.segments),
    ],
  )
  if (!row) throw new Error('transcript belongs to another user')
  return map(row) as TranscriptRow
}

export async function getByMedia(db: Db, userId: string, mediaId: string): Promise<TranscriptRow | null> {
  return map(await db.one('select * from public.transcripts where media_id = $1 and user_id = $2', [mediaId, userId]))
}

export async function get(db: Db, userId: string, transcriptId: string): Promise<TranscriptRow | null> {
  return map(await db.one('select * from public.transcripts where id = $1 and user_id = $2', [transcriptId, userId]))
}
