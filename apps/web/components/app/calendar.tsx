// Calendar: a week or month of scheduled / published posts grouped by day (in the brand's time
// zone, or the account's for "all brands"), with reschedule and cancel.

import Link from 'next/link'
import { PlatformBadge } from '@/components/platform/platform-badge'
import { ActionForm, SubmitButton, type FormAction } from '@/components/ui/action-form'
import { Card, EmptyState, LinkButton, PageHeader, StatusPill } from '@/components/ui/primitives'
import { button, cx, link } from '@/components/ui/styles'
import type { CalendarData, CalendarEntry } from '@/lib/ui/data'
import { excerpt, formatTime, plural } from '@/lib/ui/format'
import { safeExternalUrl, withQuery } from '@/lib/ui/paths'
import { formatDayKey, formatMonthOfKey } from '@/lib/ui/time'
import { DateTimeField } from './fields'

export interface CalendarActions {
  reschedule: FormAction
  cancel: FormAction
}

function Entry({ entry, timezone, showBrand, actions }: { entry: CalendarEntry; timezone: string; showBrand: boolean; actions: CalendarActions }) {
  const { post } = entry
  const editable = post.status === 'scheduled'
  return (
    <li className="rounded-lg border border-neutral-200 p-3 dark:border-neutral-800">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <time className="text-sm font-semibold tabular-nums" dateTime={post.scheduledFor.toISOString()}>
          {formatTime(post.scheduledFor, timezone)}
        </time>
        <PlatformBadge platform={post.platform} />
        <StatusPill status={post.status} />
        {showBrand ? <span className="text-xs text-neutral-500">{entry.brandName}</span> : null}
      </div>
      <p className="mt-1.5 text-sm text-neutral-700 dark:text-neutral-300">{excerpt(entry.title ? `${entry.title}: ${entry.text}` : entry.text, 200)}</p>
      {post.status === 'failed' && post.error ? <p className="mt-1 text-xs text-red-700 dark:text-red-300">{post.error}</p> : null}
      <div className="mt-2 flex flex-wrap items-center gap-3 text-xs">
        <Link href={`/app/approvals?draft=${post.draftId}`} className={link}>
          Open draft
        </Link>
        {safeExternalUrl(post.postUrl) ? (
          <a href={safeExternalUrl(post.postUrl) ?? undefined} target="_blank" rel="noopener noreferrer" className={link}>
            View on {post.platform === 'x' ? 'X' : 'platform'}
          </a>
        ) : null}
        {editable ? (
          <details className="w-full">
            <summary className="cursor-pointer select-none font-medium text-indigo-700 dark:text-indigo-300">Reschedule</summary>
            <ActionForm action={actions.reschedule} className="mt-2 flex flex-wrap items-end gap-3">
              <input type="hidden" name="postId" value={post.id} />
              <DateTimeField id={`move-${post.id}`} label="New time" defaultIso={post.scheduledFor.toISOString()} serverTimeZone={entry.brandTimezone} />
              <SubmitButton variant="secondary" pendingLabel="Moving…">
                Move
              </SubmitButton>
            </ActionForm>
          </details>
        ) : null}
        {post.status === 'scheduled' || post.status === 'failed' ? (
          <ActionForm action={actions.cancel} confirm="Cancel this post? It will not be published.">
            <input type="hidden" name="postId" value={post.id} />
            <SubmitButton variant="ghost" className="px-2 py-1 text-xs text-red-700 dark:text-red-300" pendingLabel="Canceling…">
              Cancel post
            </SubmitButton>
          </ActionForm>
        ) : null}
      </div>
    </li>
  )
}

export function CalendarView({
  data,
  actions,
  brands,
  brandFilter,
  includeCanceled,
}: {
  data: CalendarData
  actions: CalendarActions
  brands: Array<{ id: string; name: string }>
  /** Brand id, or 'all'. */
  brandFilter: string
  includeCanceled: boolean
}) {
  const href = (q: Record<string, string | null>) =>
    withQuery('/app/calendar', { view: data.view, date: data.range.startKey, brand: brandFilter, canceled: includeCanceled ? '1' : null, ...q })
  const label =
    data.view === 'month'
      ? formatMonthOfKey(data.range.startKey)
      : `${formatDayKey(data.range.startKey)} – ${formatDayKey(data.range.days[data.range.days.length - 1] ?? data.range.startKey)}`
  const visibleDays = data.view === 'week' ? data.days : data.days.filter((d) => d.items.length > 0)
  const showBrand = brandFilter === 'all'

  return (
    <>
      <PageHeader
        title="Calendar"
        description={`Times are shown in ${data.timezone.replace(/_/g, ' ')}.`}
        actions={
          <div className="inline-flex rounded-lg border border-neutral-300 p-0.5 dark:border-neutral-700" role="group" aria-label="View">
            {(['week', 'month'] as const).map((v) => (
              <Link
                key={v}
                href={href({ view: v })}
                aria-current={data.view === v ? 'page' : undefined}
                className={cx('rounded-md px-3 py-1.5 text-sm font-medium', data.view === v ? 'bg-indigo-600 text-white' : 'text-neutral-700 dark:text-neutral-300')}
              >
                {v === 'week' ? 'Week' : 'Month'}
              </Link>
            ))}
          </div>
        }
      />

      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Link href={href({ date: data.prevKey })} className={cx(button.secondary, button.small)} aria-label={`Previous ${data.view}`}>
            ←
          </Link>
          <Link href={href({ date: data.todayKey })} className={cx(button.secondary, button.small)}>
            Today
          </Link>
          <Link href={href({ date: data.nextKey })} className={cx(button.secondary, button.small)} aria-label={`Next ${data.view}`}>
            →
          </Link>
          <h2 className="ml-2 text-lg font-semibold" aria-live="polite">
            {label}
          </h2>
        </div>
        <nav aria-label="Brand filter" className="flex flex-wrap gap-2 text-sm">
          {[{ id: 'all', name: 'All brands' }, ...brands].map((b) => (
            <Link
              key={b.id}
              href={href({ brand: b.id })}
              aria-current={brandFilter === b.id ? 'true' : undefined}
              className={cx('rounded-full px-3 py-1', brandFilter === b.id ? 'bg-neutral-900 text-white dark:bg-white dark:text-neutral-900' : 'bg-neutral-100 dark:bg-neutral-800')}
            >
              {b.name}
            </Link>
          ))}
          <Link href={href({ canceled: includeCanceled ? null : '1' })} className="rounded-full px-3 py-1 text-neutral-600 underline dark:text-neutral-400">
            {includeCanceled ? 'Hide canceled' : 'Show canceled'}
          </Link>
        </nav>
      </div>

      {data.total === 0 && data.view === 'month' ? (
        <EmptyState title="Nothing this month" action={<LinkButton href="/app/approvals?tab=approved">Schedule approved drafts</LinkButton>}>
          Approved drafts you schedule show up here.
        </EmptyState>
      ) : (
        <div className="space-y-4">
          {visibleDays.map((day) => (
            <Card key={day.key} as="section" className={day.key === data.todayKey ? 'border-indigo-300 dark:border-indigo-800' : undefined}>
              <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold">
                {formatDayKey(day.key)}
                {day.key === data.todayKey ? <span className="rounded-full bg-indigo-600 px-2 py-0.5 text-xs text-white">Today</span> : null}
                <span className="font-normal text-neutral-500">· {plural(day.items.length, 'post')}</span>
              </h3>
              {day.items.length === 0 ? (
                <p className="text-sm text-neutral-500">Nothing scheduled.</p>
              ) : (
                <ul className="space-y-2">
                  {day.items.map((entry) => (
                    <Entry key={entry.post.id} entry={entry} timezone={data.timezone} showBrand={showBrand} actions={actions} />
                  ))}
                </ul>
              )}
            </Card>
          ))}
        </div>
      )}
    </>
  )
}
