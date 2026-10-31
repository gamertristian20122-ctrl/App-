// Voice and analytics: import_past_posts, save_voice_profile, get_analytics.

import { PLATFORM_LABELS } from '@app/core/types'
import { GetAnalyticsInputSchema, ImportPastPostsInputSchema, SaveVoiceProfileInputSchema } from '@app/core/validation'
import type { BrandAnalytics } from '@app/services'
import { excerpt, listText, ok, plural } from '../results'
import { metricsText, followersText, WEEKLY_REVIEW_STEPS, weeklyReviewText } from '../playbook'
import { jobViewForModel } from '../views'
import { READ_ONLY, type ToolDef } from './types'

export const importPastPosts: ToolDef = {
  name: 'import_past_posts',
  title: 'Import past posts',
  description:
    'Imports the brand\'s recent posts (captions and metrics) from its connected accounts in the background. ' +
    'They become voice samples (list_accounts with the brandId shows the best ones) and the baseline for get_analytics. Repeating within an hour does nothing new.',
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
        'Check with post_status (jobId). Imported posts become voice samples (list_accounts with the brandId) and the analytics baseline.',
      { platforms: result.platforms, jobs: result.jobs.map(jobViewForModel) },
    )
  },
}

export const saveVoiceProfile: ToolDef = {
  name: 'save_voice_profile',
  title: 'Save the brand voice profile',
  description:
    'Saves a new version of the brand\'s voice profile (tone, audience, vocabulary, do and don\'t rules, emoji and hashtag policy, sample posts). ' +
    'It replaces the WHOLE active profile (older versions are kept): to change or add one rule, first read the current profile with list_accounts { brandId } and send it complete with your change. Build it from the user\'s answers and imported posts.',
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
    return ok(`Saved voice profile version ${view.version} for brand ${view.brandId}. list_accounts { brandId } and the write_post prompt now use it.`, {
      voiceProfile: { brandId: view.brandId, version: view.version, source: view.source, profile: view.profile, createdAt: view.createdAt },
    })
  },
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
    'With a brandId (and the default 7 days) it adds the weekly review: the last 7 days against the previous 7, top and weakest posts, posting cadence and the pipeline, with the steps for proposing experiments.',
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
    const text = summaries.map((s) => brandText(s, days)).join('\n\n')
    // the weekly review (week over week) for one brand: the model cannot load the weekly_review prompt
    if (typeof args.brandId === 'string' && days === 7 && args.platform === undefined) {
      const review = await ctx.services.analytics.weeklyReview(ctx.userId, args.brandId)
      return ok([text, '', weeklyReviewText(review), '', ...WEEKLY_REVIEW_STEPS].join('\n'), { days, brands: summaries, weeklyReview: review })
    }
    return ok(`${text}\n\nFor a week-over-week review of one brand, call get_analytics with its brandId.`, { days, brands: summaries })
  },
}

export { followersText, metricsText } from '../playbook'
