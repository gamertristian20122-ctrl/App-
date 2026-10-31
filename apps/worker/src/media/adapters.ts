// Thin local stand-ins for service functions the media worker needs but @app/services does not
// offer yet (requests in docs/handoff/worker-media.md). Each one is small, scoped by userId and
// delegates every rule it can to services/core; replace them when the services land.

import type { Platform } from '@app/core/types'
import { PLATFORM_RULES, blockingIssues, validateVariant, type MediaFacts } from '@app/core/platforms'
import type { MediaView } from '@app/services'
import type { WorkerContext } from '../types'

export interface RenderDraftInput {
  brandId: string
  /** The rendered media, in order (all images for a carousel, one video for a template video). */
  media: readonly MediaView[]
  kind: 'photos' | 'video'
  text: string
  title: string
  notes: string
  /** Only these platforms (an autoPublish request's list); default: every connected one that takes the media. */
  platforms?: readonly Platform[] | undefined
}

export interface RenderDraftResult {
  draftId: string | null
  platforms: Platform[]
  /** An existing draft with these media was reused (job retry). */
  reused: boolean
  /** Why no draft was created. */
  reason?: 'no_accounts' | 'no_platform_accepts' | 'draft_refused'
  /** Safe message for draft_refused. */
  message?: string
}

function factsOf(m: MediaView): MediaFacts {
  return { kind: m.kind, bytes: m.bytes, durationMs: m.durationMs, width: m.width, height: m.height, mimeType: m.mimeType }
}

function cleanTitle(title: string, max: number, forbidden?: string): string {
  let out = title.replace(/\s+/g, ' ').trim()
  if (forbidden) out = [...out].filter((ch) => !forbidden.includes(ch)).join('')
  return [...out].slice(0, max).join('').trim()
}

/**
 * Request 2: a draft (never a post) for rendered media, with one variant per active connected
 * account of the brand whose platform takes this media (checked with core validateVariant, like
 * services' clip drafts). It goes through services.drafts.create, so every draft rule applies and a
 * human still approves it. A retried job reuses the draft it already created.
 */
export async function createRenderDraft(ctx: Pick<WorkerContext, 'services'>, userId: string, input: RenderDraftInput): Promise<RenderDraftResult> {
  const { services } = ctx
  const first = input.media[0]
  if (!first) return { draftId: null, platforms: [], reused: false, reason: 'no_platform_accepts' }

  const recent = await services.drafts.list(userId, { brandId: input.brandId, limit: 50 })
  for (const item of recent.items) {
    if (item.variants.some((v) => v.mediaIds.includes(first.id))) {
      return { draftId: item.draft.id, platforms: item.variants.map((v) => v.platform), reused: true }
    }
  }

  const accounts = (await services.accounts.list(userId, { brandId: input.brandId })).filter((a) => a.status === 'active')
  if (accounts.length === 0) return { draftId: null, platforms: [], reused: false, reason: 'no_accounts' }

  const mediaIds = input.media.map((m) => m.id)
  const facts = input.media.map(factsOf)
  const seen = new Set<Platform>()
  const variants: Array<{ platform: Platform; text: string; title?: string; mediaIds: string[] }> = []
  for (const account of accounts) {
    const platform = account.platform
    if (seen.has(platform)) continue
    if (input.platforms && !input.platforms.includes(platform)) continue
    seen.add(platform)
    const rules = PLATFORM_RULES[platform]
    if (input.kind === 'photos' ? !rules.image : !rules.video) continue
    const title = rules.title ? cleanTitle(input.title, rules.title.max, rules.title.forbidden) : ''
    const content = { text: input.text, ...(title ? { title } : {}), mediaIds }
    if (blockingIssues(validateVariant(platform, content, { media: facts })).length > 0) continue
    variants.push({ platform, text: input.text, ...(title ? { title } : {}), mediaIds })
  }
  if (variants.length === 0) return { draftId: null, platforms: [], reused: false, reason: 'no_platform_accepts' }

  const view = await services.drafts.create(
    userId,
    { brandId: input.brandId, variants, ...(input.notes ? { notes: input.notes.slice(0, 2_000) } : {}) },
    { via: 'worker' },
  )
  return { draftId: view.draft.id, platforms: variants.map((v) => v.platform), reused: false }
}
