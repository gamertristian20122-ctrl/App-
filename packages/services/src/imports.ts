// Imports: import_past_posts queues one job per connected account; the worker pages the provider
// and stores captions + metrics (never media) through savePastPosts. They feed the voice profile
// and the weekly review.

import { z } from 'zod'
import { pickMetrics, PLATFORMS, type Actor, type Platform } from '@app/core/types'
import { ImportPastPostsInputSchema } from '@app/core/validation'
import type { PastPostRow } from '@app/db'
import { auditIn } from './audit'
import { fromZod, requireActiveBrand, requireBrand, requireUser, userIdOf, validation, withErrors, type Ctx } from './context'
import { requireCanCreate, userEntitlements } from './entitlements'
import { enqueueJob, jobView, type JobView } from './jobs'

const PastPostSchema = z.object({
  platform: z.enum(PLATFORMS),
  externalPostId: z.string().trim().min(1).max(255),
  text: z.string().max(70_000).nullish(),
  mediaType: z.string().max(50).nullish(),
  postedAt: z.string().max(64).nullish(),
  permalink: z.string().max(2048).nullish(),
  metrics: z.unknown().optional(),
})

const SaveSchema = z.object({
  brandId: z.string(),
  platform: z.enum(PLATFORMS),
  posts: z.array(PastPostSchema).max(500),
})

export interface ImportRequestResult {
  jobs: JobView[]
  platforms: Platform[]
}

function cleanText(s: string | null | undefined): string | null {
  if (s === null || s === undefined) return null
  // eslint-disable-next-line no-control-regex
  return s.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
}

function safeDate(value: string | null | undefined): Date | null {
  if (!value) return null
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? null : d
}

function safePermalink(value: string | null | undefined): string | null {
  if (!value) return null
  try {
    const u = new URL(value)
    return u.protocol === 'https:' ? u.toString() : null
  } catch {
    return null
  }
}

export function createImportsService(ctx: Ctx) {
  return withErrors({
    /** import_past_posts: one job per active connected account of the brand (optionally some platforms). */
    async importPastPosts(userId: string, input: unknown, options: { via?: Actor } = {}): Promise<ImportRequestResult> {
      const uid = userIdOf(userId)
      const data = fromZod(ImportPastPostsInputSchema, input, 'Import request')
      return ctx.tx(async (r) => {
        const user = await requireUser(r, uid)
        requireCanCreate(userEntitlements(user, ctx.now()))
        const brand = await requireActiveBrand(r, uid, data.brandId)
        const accounts = (await r.accounts.list(uid, { brandId: brand.id, status: 'active' })).filter(
          (a) => !data.platforms || data.platforms.includes(a.platform),
        )
        if (accounts.length === 0) {
          throw validation(
            data.platforms ? 'None of those platforms is connected to this brand.' : 'Connect an account to this brand first.',
          )
        }
        const bucket = Math.floor(ctx.now().getTime() / ctx.config.importDedupeWindowMs)
        const jobs: JobView[] = []
        for (const account of accounts) {
          const { job } = await enqueueJob(r, {
            type: 'import_past_posts',
            payload: { userId: uid, brandId: brand.id, accountId: account.id, platform: account.platform, limit: data.limitPerPlatform },
            idempotencyKey: `import_past_posts:${account.id}:${bucket}`,
          })
          jobs.push(jobView(job))
        }
        await auditIn(r, uid, {
          actor: options.via ?? 'mcp',
          action: 'imports.requested',
          subjectType: 'brand',
          subjectId: brand.id,
          meta: { platforms: accounts.map((a) => a.platform), limit: data.limitPerPlatform },
        })
        return { jobs, platforms: accounts.map((a) => a.platform) }
      })
    },

    /** Worker: stores one page of imported posts (captions and metrics only). */
    async savePastPosts(userId: string, input: { brandId: string; platform: Platform; posts: unknown[] }): Promise<PastPostRow[]> {
      const uid = userIdOf(userId)
      const data = fromZod(SaveSchema, input, 'Imported posts')
      const brand = await requireBrand(ctx.repos, uid, data.brandId)
      const posts = data.posts.filter((p) => p.platform === data.platform)
      return ctx.repos.pastPosts.upsertMany(
        uid,
        brand.id,
        posts.map((p) => ({
          platform: p.platform,
          externalPostId: p.externalPostId,
          text: cleanText(p.text),
          mediaType: p.mediaType ?? null,
          postedAt: safeDate(p.postedAt),
          permalink: safePermalink(p.permalink),
          metrics: pickMetrics(p.metrics),
        })),
      )
    },

    /** How many posts were imported per platform. */
    async summary(userId: string, brandId: string): Promise<{ total: number; byPlatform: Partial<Record<Platform, number>> }> {
      const uid = userIdOf(userId)
      const brand = await requireBrand(ctx.repos, uid, brandId)
      const rows = await ctx.repos.pastPosts.list(uid, brand.id, { limit: 1000 })
      const byPlatform: Partial<Record<Platform, number>> = {}
      for (const row of rows) byPlatform[row.platform] = (byPlatform[row.platform] ?? 0) + 1
      return { total: await ctx.repos.pastPosts.count(uid, brand.id), byPlatform }
    },
  })
}

export type ImportsService = ReturnType<typeof createImportsService>
