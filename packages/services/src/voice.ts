// Voice profiles: versioned per brand (the latest version is active). write_post loads the profile
// plus sample posts (manual samples and imported past posts) so every AI writes in the brand's voice.

import { z } from 'zod'
import type { Actor, Metrics, Platform } from '@app/core/types'
import { PlatformSchema } from '@app/core/types'
import { SaveVoiceProfileInputSchema, VoiceProfileSchema, type VoiceProfile } from '@app/core/validation'
import type { VoiceProfileRow } from '@app/db'
import { auditIn } from './audit'
import { conflict, fromZod, notFound, requireBrand, requireUser, userIdOf, withErrors, type Ctx } from './context'
import { requireCanCreate, userEntitlements } from './entitlements'

export interface VoiceProfileView {
  brandId: string
  version: number
  source: VoiceProfileRow['source']
  profile: VoiceProfile
  createdAt: Date
}

export interface VoiceSample {
  platform: Platform
  text: string
  postedAt: Date | null
  permalink: string | null
  metrics: Metrics
}

/** Engagement score used to rank samples and posts (views count lightly; interactions more). */
export function engagementScore(m: Metrics): number {
  return (m.views ?? 0) * 0.01 + (m.likes ?? 0) + 2 * (m.comments ?? 0) + 3 * (m.shares ?? 0) + 2 * (m.saves ?? 0)
}

function viewOf(row: VoiceProfileRow): VoiceProfileView {
  const parsed = VoiceProfileSchema.safeParse(row.profile)
  return {
    brandId: row.brandId,
    version: row.version,
    source: row.source,
    profile: parsed.success ? parsed.data : VoiceProfileSchema.parse({}),
    createdAt: row.createdAt,
  }
}

const SamplesSchema = z.strictObject({
  limit: z.number().int().min(1).max(50).default(20),
  platform: PlatformSchema.optional(),
})

export function createVoiceService(ctx: Ctx) {
  return withErrors({
    /** save_voice_profile: stores a new version (validated; previous versions are kept). */
    async save(userId: string, input: unknown, options: { via?: Actor } = {}): Promise<VoiceProfileView> {
      const uid = userIdOf(userId)
      const data = fromZod(SaveVoiceProfileInputSchema, input, 'Voice profile')
      return ctx.tx(async (r) => {
        const user = await requireUser(r, uid)
        requireCanCreate(userEntitlements(user, ctx.now()))
        const brand = await requireBrand(r, uid, data.brandId)
        if (brand.status === 'archived') throw conflict('This brand is archived.')
        const row = await r.voice.save(uid, brand.id, { profile: data.profile as Record<string, unknown>, source: data.source })
        if (!row) throw notFound('Brand')
        await auditIn(r, uid, {
          actor: options.via ?? 'mcp',
          action: 'voice.saved',
          subjectType: 'brand',
          subjectId: brand.id,
          meta: { version: row.version, source: row.source },
        })
        return viewOf(row)
      })
    },

    /** The active (latest) profile, or null when the brand has none yet. */
    async get(userId: string, brandId: string): Promise<VoiceProfileView | null> {
      const uid = userIdOf(userId)
      const brand = await requireBrand(ctx.repos, uid, brandId)
      const row = await ctx.repos.voice.getLatest(uid, brand.id)
      return row ? viewOf(row) : null
    },

    async versions(userId: string, brandId: string, limit = 20): Promise<VoiceProfileView[]> {
      const uid = userIdOf(userId)
      const brand = await requireBrand(ctx.repos, uid, brandId)
      return (await ctx.repos.voice.listVersions(uid, brand.id, limit)).map(viewOf)
    },

    /** Imported past posts with text, best performing first (examples for write_post). */
    async importedSamples(userId: string, brandId: string, input: unknown = {}): Promise<VoiceSample[]> {
      const uid = userIdOf(userId)
      const data = fromZod(SamplesSchema, input ?? {}, 'Samples request')
      const brand = await requireBrand(ctx.repos, uid, brandId)
      const rows = await ctx.repos.pastPosts.list(uid, brand.id, {
        ...(data.platform ? { platform: data.platform } : {}),
        limit: 500,
      })
      return rows
        .filter((p) => (p.text ?? '').trim() !== '')
        .sort((a, b) => engagementScore(b.metrics) - engagementScore(a.metrics))
        .slice(0, data.limit)
        .map((p) => ({ platform: p.platform, text: p.text ?? '', postedAt: p.postedAt, permalink: p.permalink, metrics: p.metrics }))
    },
  })
}

export type VoiceService = ReturnType<typeof createVoiceService>
