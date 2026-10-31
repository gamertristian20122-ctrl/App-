// Dashboard overview: usage meters, setup checklist, drafts awaiting approval, upcoming posts.

import Link from 'next/link'
import { PLATFORM_LABELS } from '@app/core/types'
import { PlatformMark } from '@/components/platform/platform-badge'
import { Card, EmptyState, LinkButton, Meter, PageHeader, StatusPill } from '@/components/ui/primitives'
import { link } from '@/components/ui/styles'
import type { OverviewData } from '@/lib/ui/data'
import { excerpt, formatClipHours, formatDate, formatDateTime, plural } from '@/lib/ui/format'

export function UsageMeters({ data }: { data: Pick<OverviewData, 'clip' | 'brandsActive' | 'brandsLimit' | 'entitlements'> }) {
  const { clip } = data
  return (
    <div className="grid gap-6 sm:grid-cols-2">
      <Meter
        label="Clipping hours"
        used={clip.used}
        limit={clip.limit}
        display={`${formatClipHours(clip.used)} of ${formatClipHours(clip.limit)}`}
        hint={
          <>
            {clip.reserved > 0 ? `${formatClipHours(clip.reserved)} held for videos being processed. ` : null}
            Resets {formatDate(clip.period.end)}.
          </>
        }
      />
      <Meter
        label="Brands"
        kind="slots"
        used={data.brandsActive}
        limit={data.brandsLimit}
        display={`${data.brandsActive} of ${data.brandsLimit}`}
        hint={data.entitlements.trial ? 'Trial: 1 brand.' : 'Add brands from the billing page.'}
      />
    </div>
  )
}

function Checklist({ data }: { data: OverviewData }) {
  const steps = [
    { done: data.brandsActive > 0, label: 'Create a brand', href: '/app/brands' },
    { done: data.liveAccounts > 0, label: 'Connect your social accounts', href: '/app/accounts' },
    { done: data.aiConnections > 0, label: 'Add the server to Claude, ChatGPT or Cursor', href: '/app/connect' },
  ]
  if (steps.every((s) => s.done)) return null
  return (
    <Card title="Get set up" description="Three steps and your AI can start drafting.">
      <ol className="space-y-2">
        {steps.map((s, i) => (
          <li key={s.label} className="flex items-center gap-3 text-sm">
            <span
              aria-hidden="true"
              className={
                s.done
                  ? 'flex h-6 w-6 items-center justify-center rounded-full bg-emerald-600 text-xs font-bold text-white'
                  : 'flex h-6 w-6 items-center justify-center rounded-full border border-neutral-300 text-xs font-semibold dark:border-neutral-700'
              }
            >
              {s.done ? '✓' : i + 1}
            </span>
            {s.done ? (
              <span className="text-neutral-500 line-through">
                {s.label}
                <span className="sr-only"> (done)</span>
              </span>
            ) : (
              <Link href={s.href} className={link}>
                {s.label}
              </Link>
            )}
          </li>
        ))}
      </ol>
    </Card>
  )
}

export function OverviewView({ data }: { data: OverviewData }) {
  return (
    <>
      <PageHeader title="Overview" description="What needs you today, and how much of your plan you have used." />
      <div className="space-y-6">
        <Checklist data={data} />
        <Card title="Usage this period">
          <UsageMeters data={data} />
        </Card>

        <div className="grid gap-6 xl:grid-cols-2">
          <Card
            title="Waiting for your approval"
            actions={data.awaiting.length > 0 ? <LinkButton href="/app/approvals">Open queue</LinkButton> : null}
          >
            {data.awaiting.length === 0 ? (
              <EmptyState title="Nothing to approve">Ask your AI for a post or a few clips; drafts land here first.</EmptyState>
            ) : (
              <ul className="divide-y divide-neutral-200 dark:divide-neutral-800">
                {data.awaiting.map(({ draft, variants, brandName }) => (
                  <li key={draft.id} className="py-3">
                    <Link href={`/app/approvals?draft=${draft.id}`} className="group block">
                      <div className="flex items-center justify-between gap-3">
                        <span className="flex items-center gap-1">
                          {variants.map((v) => (
                            <PlatformMark key={v.platform} platform={v.platform} size="sm" />
                          ))}
                          <span className="sr-only">{variants.map((v) => PLATFORM_LABELS[v.platform]).join(', ')}</span>
                        </span>
                        <span className="text-xs text-neutral-500">{brandName}</span>
                      </div>
                      <p className="mt-1 text-sm group-hover:underline">{excerpt(variants[0]?.title || variants[0]?.text || 'Untitled draft', 120)}</p>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
            {data.awaitingMore ? <p className="mt-3 text-xs text-neutral-500">More drafts are waiting in the queue.</p> : null}
          </Card>

          <Card title="Coming up" description="Scheduled in the next 14 days." actions={<LinkButton href="/app/calendar">Calendar</LinkButton>}>
            {data.upcoming.length === 0 ? (
              <EmptyState title="Nothing scheduled">Approve a draft, then schedule it here or ask your AI to.</EmptyState>
            ) : (
              <ul className="divide-y divide-neutral-200 dark:divide-neutral-800">
                {data.upcoming.map(({ post, text, title, brandName }) => (
                  <li key={post.id} className="flex items-start gap-3 py-3">
                    <PlatformMark platform={post.platform} />
                    <div className="min-w-0 flex-1">
                      <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                        <time dateTime={post.scheduledFor.toISOString()}>{formatDateTime(post.scheduledFor, data.timezone)}</time>
                        <StatusPill status={post.status} />
                      </p>
                      <p className="truncate text-sm text-neutral-600 dark:text-neutral-400">{excerpt(title || text, 100)}</p>
                      <p className="text-xs text-neutral-500">
                        {PLATFORM_LABELS[post.platform]} · {brandName}
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
        <p className="text-xs text-neutral-500">
          {plural(data.liveAccounts, 'connected account')} · {plural(data.aiConnections, 'connected AI app')}
        </p>
      </div>
    </>
  )
}
