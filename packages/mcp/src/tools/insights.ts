// Voice and analytics: import_past_posts, save_voice_profile, get_analytics.

import { PLATFORM_LABELS, type Metrics } from '@app/core/types'
import { GetAnalyticsInputSchema, ImportPastPostsInputSchema, SaveVoiceProfileInputSchema } from '@app/core/validation'
import type { BrandAnalytics, FollowerChange } from '@app/services'
import { excerpt, listText, ok, plural } from '../results'
import { jobViewForModel } from '../views'
import { READ_ONLY, type ToolDef } from './types'

export const importPastPosts: ToolDef = {
  name: 'import_past_posts',
  title: 'Import past posts',
  description:
    'Imports the brand\'s recent posts (captions and metrics) from its connected accounts in the background. ' +
    'They become voice samples for the write_post prompt and context for weekly_review. Repeating within an hour does nothing new.',
  input: ImportPastPostsInputSchema,
  describe: {
    brandId: 'The brand id (from list_accounts).',
    platforms: 'Only these platforms (default: every connected account).',
    limitPerPlatform: 'Posts per platform (1–200, default 50).',
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  async run(ctx, args) {
    const result = await ctx.services.imports.importPastPosts(ctx.userId, args, { via: 'mcp' })
    if (result.platforms.length === 0) {
      return ok('This brand has no active connected accounts to import from. Connect one with connect_account first.', { jobs: [], platforms: [] })
    }
    return ok(
      `Importing past posts from ${listText(result.platforms.map((p) => PLATFORM_LABELS[p]))} in the background (${plural(result.jobs.length, 'job')}: ${result.jobs.map((j) => j.id).join(', ')}). ` +
        'Check with post_status (jobId). Imported posts feed the write_post prompt and weekly_review.',
      { platforms: result.platforms, jobs: result.jobs.map(jobViewForModel) },
    )
  },
}

export const saveVoiceProfile: ToolDef = {
  name: 'save_voice_profile',
  title: 'Save the brand voice profile',
  description:
    'Saves a new version of the brand\'s voice profile (tone, audience, vocabulary, do and don\'t rules, emoji and hashtag policy, sample posts). ' +
    'It replaces the active profile (older versions are kept). Build it from the user\'s answers and imported posts; the write_post prompt loads it.',
  input: SaveVoiceProfileInputSchema,
  describe: {
    brandId: 'The brand id (from list_accounts).',
    profile:
      'The profile: { tone, audience, vocabulary[], do[], dont[], emoji_policy (none|sparing|moderate|heavy), hashtag_policy (none|few|moderate|many), sample_posts[{ platform?, text }] }.',
    source: 'manual (from the user), imported (from past posts) or mixed.',
  },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  async run(ctx, args) {
    const view = await ctx.services.voice.save(ctx.userId, args, { via: 'mcp' })
    return ok(`Saved voice profile version ${view.version} for brand ${view.brandId}. The write_post prompt now uses it.`, {
      voiceProfile: { brandId: view.brandId, version: view.version, source: view.source, profile: view.profile, createdAt: view.createdAt },
    })
  },
}

const METRIC_ORDER: readonly (keyof Metrics)[] = ['views', 'impressions', 'reach', 'likes', 'comments', 'shares', 'saves']

export function metricsText(m: Metrics): string {
  const parts = METRIC_ORDER.filter((k) => typeof m[k] === 'number').map((k) => `${k} ${(m[k] as number).toLocaleString('en-US')}`)
  return parts.length > 0 ? parts.join(', ') : 'no metrics yet'
}

export function followersText(f: readonly FollowerChange[]): string {
  const parts = f
    .filter((x) => x.followers !== null)
    .map((x) => `${PLATFORM_LABELS[x.platform]} ${x.followers?.toLocaleString('en-US')}${x.change !== null ? ` (${x.change >= 0 ? '+' : ''}${x.change})` : ''}`)
  return parts.length > 0 ? parts.join(', ') : 'no follower data yet'
}

function brandText(a: BrandAnalytics, days: number): string {
  const lines = [
    `${a.brand.name} (brandId ${a.brand.id}), last ${plural(days, 'day')}: ${plural(a.period.posts, 'post')}; ${metricsText(a.period.metrics)}.`,
    `Followers: ${followersText(a.followers)}.`,
  ]
  if (a.topPosts.length > 0) {
    lines.push('Top posts:')
    for (const p of a.topPosts.slice(0, 5)) {
      lines.push(`- ${PLATFORM_LABELS[p.platform]} "${excerpt(p.excerpt, 60)}": ${metricsText(p.metrics)}${p.url ? ` ${p.url}` : ''}`)
    }
  }
  return lines.join('\n')
}

export const getAnalytics: ToolDef = {
  name: 'get_analytics',
  title: 'Get analytics',
  description:
    'Summarises published-post metrics (views, likes, comments, shares, saves) and follower counts per brand over the last N days (default 7), with the top posts. ' +
    'Use the weekly_review prompt for a week-over-week review with experiments.',
  input: GetAnalyticsInputSchema,
  describe: {
    brandId: 'Only this brand (default: every active brand).',
    platform: 'Only this platform (optional).',
    days: 'Days to look back (1–90, default 7).',
  },
  annotations: READ_ONLY,
  async run(ctx, args) {
    const summaries = await ctx.services.analytics.summary(ctx.userId, args)
    const days = typeof args.days === 'number' ? args.days : 7
    if (summaries.length === 0) return ok('No active brands to report on.', { brands: [] })
    return ok(summaries.map((s) => brandText(s, days)).join('\n\n'), { days, brands: summaries })
  },
}
