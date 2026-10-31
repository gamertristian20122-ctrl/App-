// Small presentational building blocks shared by every dashboard page (server components; no
// state). Accessible by default: headings, landmarks, live regions for notices, real <meter>s.

import Link from 'next/link'
import type { ReactNode } from 'react'
import { percentOf } from '@/lib/ui/format'
import { button, card, cx } from './styles'

export function PageHeader({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {description ? <p className="mt-1 max-w-2xl text-sm text-neutral-600 dark:text-neutral-400">{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
    </header>
  )
}

export function Card({ children, className, as = 'section', title, description, actions, id }: {
  children: ReactNode
  className?: string
  as?: 'section' | 'div' | 'article'
  title?: ReactNode
  description?: ReactNode
  actions?: ReactNode
  id?: string
}) {
  const Tag = as
  return (
    <Tag id={id} className={cx(card, className)}>
      {title || actions ? (
        <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
          <div>
            {title ? <h2 className="text-base font-semibold">{title}</h2> : null}
            {description ? <p className="mt-0.5 text-sm text-neutral-600 dark:text-neutral-400">{description}</p> : null}
          </div>
          {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
        </div>
      ) : null}
      {children}
    </Tag>
  )
}

export type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger'

const BADGE_TONES: Record<Tone, string> = {
  neutral: 'bg-neutral-100 text-neutral-700 ring-neutral-200 dark:bg-neutral-800 dark:text-neutral-300 dark:ring-neutral-700',
  info: 'bg-indigo-50 text-indigo-700 ring-indigo-200 dark:bg-indigo-950 dark:text-indigo-300 dark:ring-indigo-900',
  success: 'bg-emerald-50 text-emerald-700 ring-emerald-200 dark:bg-emerald-950 dark:text-emerald-300 dark:ring-emerald-900',
  warning: 'bg-amber-50 text-amber-800 ring-amber-200 dark:bg-amber-950 dark:text-amber-300 dark:ring-amber-900',
  danger: 'bg-red-50 text-red-700 ring-red-200 dark:bg-red-950 dark:text-red-300 dark:ring-red-900',
}

export function Badge({ tone = 'neutral', children, className }: { tone?: Tone; children: ReactNode; className?: string }) {
  return (
    <span className={cx('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset', BADGE_TONES[tone], className)}>
      {children}
    </span>
  )
}

const STATUS_TONES: Record<string, Tone> = {
  active: 'success',
  ready: 'success',
  published: 'success',
  approved: 'success',
  succeeded: 'success',
  scheduled: 'info',
  publishing: 'info',
  queued: 'info',
  rendering: 'info',
  pending: 'warning',
  processing: 'warning',
  draft: 'warning',
  trialing: 'info',
  needs_reauth: 'warning',
  suspended: 'warning',
  past_due: 'warning',
  failed: 'danger',
  rejected: 'danger',
  unpaid: 'danger',
  canceled: 'neutral',
  disconnected: 'neutral',
  archived: 'neutral',
  deleted: 'neutral',
  none: 'neutral',
}

const STATUS_LABELS: Record<string, string> = {
  needs_reauth: 'Needs reconnecting',
  past_due: 'Payment failed',
  trialing: 'Trial',
  draft: 'Awaiting approval',
  none: 'No plan',
}

export function statusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status.charAt(0).toUpperCase() + status.slice(1).replace(/_/g, ' ')
}

export function StatusPill({ status, label }: { status: string; label?: string }) {
  return <Badge tone={STATUS_TONES[status] ?? 'neutral'}>{label ?? statusLabel(status)}</Badge>
}

const NOTICE_TONES: Record<Exclude<Tone, 'neutral'>, string> = {
  info: 'border-indigo-200 bg-indigo-50 text-indigo-900 dark:border-indigo-900 dark:bg-indigo-950 dark:text-indigo-100',
  success: 'border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-100',
  warning: 'border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-100',
  danger: 'border-red-200 bg-red-50 text-red-900 dark:border-red-900 dark:bg-red-950 dark:text-red-100',
}

export function Notice({ tone = 'info', title, children, action, className }: {
  tone?: Exclude<Tone, 'neutral'>
  title?: ReactNode
  children?: ReactNode
  action?: ReactNode
  className?: string
}) {
  return (
    <div
      role={tone === 'danger' ? 'alert' : 'status'}
      className={cx('flex flex-col gap-2 rounded-lg border px-4 py-3 text-sm sm:flex-row sm:items-center sm:justify-between', NOTICE_TONES[tone], className)}
    >
      <div>
        {title ? <p className="font-semibold">{title}</p> : null}
        {children ? <div className={title ? 'mt-0.5' : undefined}>{children}</div> : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  )
}

export function EmptyState({ title, children, action, icon }: { title: string; children?: ReactNode; action?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="flex flex-col items-center rounded-xl border border-dashed border-neutral-300 px-6 py-10 text-center dark:border-neutral-700">
      {icon ? <div className="mb-3 text-neutral-400" aria-hidden="true">{icon}</div> : null}
      <p className="font-medium">{title}</p>
      {children ? <div className="mt-1 max-w-md text-sm text-neutral-600 dark:text-neutral-400">{children}</div> : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  )
}

export function LinkButton({ href, children, variant = 'secondary', className }: {
  href: string
  children: ReactNode
  variant?: 'primary' | 'secondary' | 'ghost'
  className?: string
}) {
  return (
    <Link href={href} className={cx(button[variant], className)}>
      {children}
    </Link>
  )
}

/** Bar colour: allowances (clip hours) warn at 80 % and are red when used up; slots (brands) are only red when over. */
export function meterTone(used: number, limit: number, kind: 'allowance' | 'slots' = 'allowance'): string {
  if (kind === 'slots') return used > limit ? 'bg-red-500' : 'bg-indigo-600'
  const pct = percentOf(used, limit)
  return pct >= 100 ? 'bg-red-500' : pct >= 80 ? 'bg-amber-500' : 'bg-indigo-600'
}

/**
 * A labelled usage meter: "1.5 h of 4 h". Uses <meter> (exposed to assistive technology) and a
 * styled bar (see meterTone: using every brand slot is normal, not an error).
 */
export function Meter({ label, used, limit, display, hint, kind = 'allowance' }: {
  label: string
  used: number
  limit: number
  /** "1.5 h of 4 h" */
  display: string
  hint?: ReactNode
  kind?: 'allowance' | 'slots'
}) {
  const pct = percentOf(used, limit)
  const tone = meterTone(used, limit, kind)
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <span className="font-medium">{label}</span>
        <span className="tabular-nums text-neutral-600 dark:text-neutral-400">{display}</span>
      </div>
      <meter className="sr-only" min={0} max={Math.max(limit, used, 1)} value={used} aria-label={label}>
        {display}
      </meter>
      <div className="mt-2 h-2 overflow-hidden rounded-full bg-neutral-200 dark:bg-neutral-800" aria-hidden="true">
        <div className={cx('h-full rounded-full', tone)} style={{ width: `${pct}%` }} />
      </div>
      {hint ? <p className="mt-1.5 text-xs text-neutral-500 dark:text-neutral-400">{hint}</p> : null}
    </div>
  )
}

export function Stat({ label, value, change, hint }: { label: string; value: ReactNode; change?: { text: string; tone: Tone } | null; hint?: ReactNode }) {
  return (
    <div className="rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
      <dt className="text-xs font-medium uppercase tracking-wide text-neutral-500">{label}</dt>
      <dd className="mt-1 flex items-baseline gap-2">
        <span className="text-2xl font-semibold tabular-nums">{value}</span>
        {change ? <Badge tone={change.tone}>{change.text}</Badge> : null}
      </dd>
      {hint ? <p className="mt-1 text-xs text-neutral-500">{hint}</p> : null}
    </div>
  )
}

/** Tabs rendered as links (server navigation), with aria-current on the active one. */
export function TabLinks({ tabs, active, label }: { tabs: Array<{ key: string; label: ReactNode; href: string }>; active: string; label: string }) {
  return (
    <nav aria-label={label} className="mb-5 border-b border-neutral-200 dark:border-neutral-800">
      <ul className="-mb-px flex flex-wrap gap-4">
        {tabs.map((t) => (
          <li key={t.key}>
            <Link
              href={t.href}
              aria-current={t.key === active ? 'page' : undefined}
              className={cx(
                'inline-flex items-center gap-2 border-b-2 px-1 pb-2 text-sm font-medium',
                t.key === active
                  ? 'border-indigo-600 text-indigo-700 dark:text-indigo-300'
                  : 'border-transparent text-neutral-600 hover:border-neutral-300 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-100',
              )}
            >
              {t.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  )
}
