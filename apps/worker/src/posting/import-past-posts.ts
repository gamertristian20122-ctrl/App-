// import_past_posts: pages provider.listPastPosts for one connected account and stores captions and
// metrics (never media) through services.imports.savePastPosts. Idempotent: past posts are
// upserted on (brand, platform, external post id), so a re-run or a re-import updates rows instead
// of duplicating them.

import type { PastPostInput } from '@app/core'
import { PermanentJobError, throwIfAborted } from '../errors'
import type { Handler } from '../types'
import { payloadOf } from './payload'

/** Posts asked for per page (adapters cap this further per platform). */
export const IMPORT_PAGE_SIZE = 100
/** Safety stop against a provider that keeps returning cursors. */
export const IMPORT_MAX_PAGES = 50

export interface ImportResult {
  action: 'imported' | 'skip'
  reason?: string
  pages: number
  fetched: number
  saved: number
}

export const importPastPosts: Handler = async (job, ctx): Promise<ImportResult> => {
  const { userId, brandId, accountId, platform, limit } = payloadOf('import_past_posts', job)
  const { services, provider } = ctx
  const brand = await services.brands.get(userId, brandId)
  const account = await services.accounts.get(userId, accountId)
  if (account.brandId !== brand.id || account.platform !== platform) {
    throw new PermanentJobError('The connected account does not belong to this import.')
  }
  const skip = (reason: string): ImportResult => ({ action: 'skip', reason, pages: 0, fetched: 0, saved: 0 })
  if (account.status !== 'active') return skip('account_inactive')
  const profileRef = brand.providerProfileRef
  if (!profileRef) return skip('no_profile')

  let cursor: string | undefined
  const seenCursors = new Set<string>()
  let pages = 0
  let fetched = 0
  let saved = 0
  while (fetched < limit && pages < IMPORT_MAX_PAGES) {
    throwIfAborted(ctx.signal)
    const page = await provider.listPastPosts({
      profileRef,
      platform,
      ...(cursor ? { cursor } : {}),
      limit: Math.min(IMPORT_PAGE_SIZE, limit - fetched),
    })
    pages += 1
    const posts: PastPostInput[] = (Array.isArray(page?.posts) ? page.posts : []).slice(0, limit - fetched)
    if (posts.length > 0) {
      const rows = await services.imports.savePastPosts(userId, { brandId: brand.id, platform, posts })
      saved += rows.length
    }
    fetched += posts.length
    const next = page?.nextCursor
    if (!next || posts.length === 0 || seenCursors.has(next)) break
    seenCursors.add(next)
    cursor = next
  }
  ctx.logger.info('past posts imported', { brandId: brand.id, platform, pages, fetched, saved })
  return { action: 'imported', pages, fetched, saved }
}
