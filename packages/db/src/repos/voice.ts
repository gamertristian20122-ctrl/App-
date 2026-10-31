import type { VoiceProfileSource } from '@app/core/types'
import { camelRow, camelRows, json } from '../sql'
import type { Db } from '../types'

export interface VoiceProfileRow {
  id: string
  userId: string
  brandId: string
  version: number
  /** Validated by core VoiceProfileSchema before saving. */
  profile: Record<string, unknown>
  source: VoiceProfileSource
  createdAt: Date
}

const map = (row: Record<string, unknown> | null): VoiceProfileRow | null => (row ? camelRow<VoiceProfileRow>(row) : null)

/**
 * Saves a new version (previous version + 1) of the brand's voice profile. The brand row is
 * locked so concurrent saves get consecutive versions. Returns null if the brand is not the user's.
 */
export async function save(
  db: Db,
  userId: string,
  brandId: string,
  input: { profile: Record<string, unknown>; source: VoiceProfileSource },
): Promise<VoiceProfileRow | null> {
  return db.tx(async (tx) => {
    const brand = await tx.one('select id from public.brands where id = $1 and user_id = $2 for update', [brandId, userId])
    if (!brand) return null
    const row = await tx.one(
      `insert into public.voice_profiles (user_id, brand_id, version, profile, source)
       select $1, $2, coalesce(max(version), 0) + 1, $3::text::jsonb, $4
         from public.voice_profiles where brand_id = $2
       returning *`,
      [userId, brandId, json(input.profile), input.source],
    )
    return map(row)
  })
}

/** The active (latest) version. */
export async function getLatest(db: Db, userId: string, brandId: string): Promise<VoiceProfileRow | null> {
  return map(
    await db.one(
      'select * from public.voice_profiles where brand_id = $1 and user_id = $2 order by version desc limit 1',
      [brandId, userId],
    ),
  )
}

export async function getVersion(db: Db, userId: string, brandId: string, version: number): Promise<VoiceProfileRow | null> {
  return map(
    await db.one('select * from public.voice_profiles where brand_id = $1 and user_id = $2 and version = $3::int', [
      brandId,
      userId,
      version,
    ]),
  )
}

/** Newest first. */
export async function listVersions(db: Db, userId: string, brandId: string, limit = 20): Promise<VoiceProfileRow[]> {
  const rows = await db.query(
    'select * from public.voice_profiles where brand_id = $1 and user_id = $2 order by version desc limit $3',
    [brandId, userId, Math.max(1, Math.min(200, limit))],
  )
  return camelRows<VoiceProfileRow>(rows)
}
