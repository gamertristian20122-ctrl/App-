// Analytics per brand: last 7 days vs the previous 7 (totals with change), per platform, top
// posts and followers. The same numbers feed the AI's weekly_review prompt.

import Link from 'next/link'
import { PLATFORM_LABELS, type Platform } from '@app/core/types'
import type { WeeklyReview } from '@app/services'
import { PlatformBadge } from '@/components/platform/platform-badge'
import { Card, EmptyState, LinkButton, PageHeader, Stat, type Tone } from '@/components/ui/primitives'
import { cx, link } from '@/components/ui/styles'
import { excerpt, formatChange, formatCount, formatDate } from '@/lib/ui/format'
import { safeExternalUrl } from '@/lib/ui/paths'

const METRICS = [
  { key: 'views', label: 'Views' },
  { key: 'likes', label: 'Likes' },
  { key: 'comments', label: 'Comments' },
  { key: 'shares', label: 'Shares' },
  { key: 'saves', label: 'Saves' },
] as const

function change(pct: number | null | undefined): { text: string; tone: Tone } | null {
  if (pct === undefined) return null
  if (pct === null) return { text: 'new', tone: 'neutral' }
  return { text: formatChange(pct), tone: pct > 0 ? 'success' : pct < 0 ? 'danger' : 'neutral' }
}

function BrandReview({ review }: { review: WeeklyReview }) {
  const platforms = Object.entries(review.current.byPlatform) as Array<[Platform, NonNullable<WeeklyReview['current']['byPlatform'][Platform]>]>
  return (
    <Card
      title={review.brand.name}
      description={`${formatDate(review.current.from, review.brand.timezone)} – ${formatDate(review.current.to, review.brand.timezone)} compared with the 7 days before`}
    >
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Stat label="Posts" value={formatCount(review.current.posts)} change={change(review.change.posts)} />
        {METRICS.map((m) => (
          <Stat key={m.key} label={m.label} value={formatCount(review.current.metrics[m.key] ?? 0)} change={change(review.change[m.key])} />
        ))}
      </dl>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <section aria-label="By platform">
          <h3 className="text-sm font-semibold">By platform</h3>
          {platforms.length === 0 ? (
            <p className="mt-2 text-sm text-neutral-500">No published posts in this period.</p>
          ) : (
            <div className="mt-2 overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="text-xs uppercase tracking-wide text-neutral-500">
                  <tr>
                    <th scope="col" className="py-2 pr-3 font-medium">Platform</th>
                    <th scope="col" className="py-2 pr-3 text-right font-medium">Posts</th>
                    <th scope="col" className="py-2 pr-3 text-right font-medium">Views</th>
                    <th scope="col" className="py-2 pr-3 text-right font-medium">Likes</th>
                    <th scope="col" className="py-2 text-right font-medium">Comments</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-neutral-200 dark:divide-neutral-800">
                  {platforms.map(([p, s]) => (
                    <tr key={p}>
                      <th scope="row" className="py-2 pr-3 font-normal">
                        <PlatformBadge platform={p} />
                      </th>
                      <td className="py-2 pr-3 text-right tabular-nums">{s.posts}</td>
                      <td className="py-2 pr-3 text-right tabular-nums">{formatCount(s.metrics.views ?? 0)}</td>
                      <td className="py-2 pr-3 text-right tabular-nums">{formatCount(s.metrics.likes ?? 0)}</td>
                      <td className="py-2 text-right tabular-nums">{formatCount(s.metrics.comments ?? 0)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section aria-label="Followers">
          <h3 className="text-sm font-semibold">Followers</h3>
          {review.followers.length === 0 ? (
            <p className="mt-2 text-sm text-neutral-500">No follower counts yet. They are collected daily.</p>
          ) : (
            <ul className="mt-2 space-y-1.5 text-sm">
              {review.followers.map((f) => (
                <li key={f.platform} className="flex items-center justify-between gap-3">
                  <PlatformBadge platform={f.platform} />
                  <span className="tabular-nums">
                    {formatCount(f.followers)}
                    {f.change !== null && f.change !== 0 ? (
                      <span className={cx('ml-2 text-xs', f.change > 0 ? 'text-emerald-700 dark:text-emerald-300' : 'text-red-700 dark:text-red-300')}>
                        {f.change > 0 ? '+' : '−'}
                        {formatCount(Math.abs(f.change))}
                      </span>
                    ) : null}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-4 text-xs text-neutral-500">
            Pipeline: {review.upcoming.scheduled} scheduled, {review.upcoming.drafts} drafts waiting.
          </p>
        </section>
      </div>

      <section aria-label="Top posts" className="mt-6">
        <h3 className="text-sm font-semibold">Top posts</h3>
        {review.topPosts.length === 0 ? (
          <p className="mt-2 text-sm text-neutral-500">Nothing published in the last 7 days.</p>
        ) : (
          <ol className="mt-2 space-y-2">
            {review.topPosts.map((p) => (
              <li key={p.postId} className="rounded-lg border border-neutral-200 p-3 text-sm dark:border-neutral-800">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <PlatformBadge platform={p.platform} />
                  <span className="text-xs text-neutral-500">{formatDate(p.publishedAt, review.brand.timezone)}</span>
                </div>
                <p className="mt-1">{excerpt(p.title ? `${p.title}: ${p.excerpt}` : p.excerpt, 160)}</p>
                <p className="mt-1 text-xs text-neutral-500">
                  {METRICS.map((m) => `${formatCount(p.metrics[m.key] ?? 0)} ${m.label.toLowerCase()}`).join(' · ')}
                  {safeExternalUrl(p.url) ? (
                    <>
                      {' · '}
                      <a href={safeExternalUrl(p.url) ?? undefined} target="_blank" rel="noopener noreferrer" className={link}>
                        View on {PLATFORM_LABELS[p.platform]}
                      </a>
                    </>
                  ) : null}
                </p>
              </li>
            ))}
          </ol>
        )}
      </section>
    </Card>
  )
}

export function AnalyticsView({ reviews, showingAll, selectedBrandName }: { reviews: WeeklyReview[]; showingAll: boolean; selectedBrandName: string | null }) {
  return (
    <>
      <PageHeader
        title="Analytics"
        description="The last 7 days against the 7 before. Ask your AI for a “weekly review” to get three experiments for next week."
        actions={
          selectedBrandName ? (
            <Link href={showingAll ? '/app/analytics' : '/app/analytics?brand=all'} className={link}>
              {showingAll ? `Only ${selectedBrandName}` : 'All brands'}
            </Link>
          ) : null
        }
      />
      {reviews.length === 0 ? (
        <EmptyState title="No brands yet" action={<LinkButton href="/app/brands" variant="primary">Create a brand</LinkButton>}>
          Analytics appear once a brand publishes posts.
        </EmptyState>
      ) : (
        <div className="space-y-6">
          {reviews.map((r) => (
            <BrandReview key={r.brand.id} review={r} />
          ))}
        </div>
      )}
    </>
  )
}
