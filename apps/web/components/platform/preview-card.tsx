// Per-platform preview of one draft variant, shaped like the platform shows it: vertical video
// platforms put the media first, text platforms the post text, Pinterest a pin. Every card shows
// the account it posts through, the text length against the platform limit, and the issues
// (errors block approval; warnings are informational). Media are short-lived presigned URLs.

import { PLATFORM_LABELS, type Platform } from '@app/core/types'
import type { PreviewMedia, PreviewVariant } from '@app/services'
import type { ReactNode } from 'react'
import { Badge } from '@/components/ui/primitives'
import { cx } from '@/components/ui/styles'
import { formatDuration } from '@/lib/ui/format'
import { PlatformMark } from './platform-badge'

const UNIT_LABELS: Record<string, string> = {
  utf16: 'characters',
  graphemes: 'characters',
  utf8_bytes: 'bytes',
  x_weighted: 'characters (X counting)',
}

export function unitLabel(unit: string): string {
  return UNIT_LABELS[unit] ?? 'characters'
}

const VERTICAL: readonly Platform[] = ['tiktok', 'youtube', 'instagram']

function MediaTile({ m, vertical }: { m: PreviewMedia; vertical: boolean }) {
  const frame = vertical ? 'aspect-[9/16]' : 'aspect-square'
  if (m.url === null) {
    return (
      <div className={cx(frame, 'flex items-center justify-center rounded-lg bg-neutral-100 text-xs text-neutral-500 dark:bg-neutral-800')}>
        {m.status === 'failed' ? 'File failed' : 'Processing…'}
      </div>
    )
  }
  if (m.kind === 'video') {
    return (
      <div className="relative">
        <video
          src={m.url}
          controls
          muted
          playsInline
          preload="metadata"
          className={cx(frame, 'w-full rounded-lg bg-black object-contain')}
          aria-label={`Video${m.durationMs ? `, ${formatDuration(m.durationMs)}` : ''}`}
        />
        {m.durationMs ? (
          <span className="pointer-events-none absolute right-1.5 top-1.5 rounded bg-black/70 px-1.5 py-0.5 text-[10px] font-medium text-white">
            {formatDuration(m.durationMs)}
          </span>
        ) : null}
      </div>
    )
  }
  return (
    // Presigned media URLs are short-lived and never leak a referrer.
    // eslint-disable-next-line @next/next/no-img-element
    <img src={m.url} alt="Attached image" referrerPolicy="no-referrer" loading="lazy" className={cx(frame, 'w-full rounded-lg object-cover')} />
  )
}

export function LengthMeter({ used, max, unit }: { used: number; max: number; unit: string }) {
  if (max <= 0) return null
  const over = used > max
  const near = !over && used >= max * 0.9
  const pct = Math.min(100, Math.round((used / max) * 100))
  return (
    <div className="flex items-center gap-2" data-testid="length">
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-neutral-200 dark:bg-neutral-800" aria-hidden="true">
        <div className={cx('h-full', over ? 'bg-red-500' : near ? 'bg-amber-500' : 'bg-emerald-500')} style={{ width: `${pct}%` }} />
      </div>
      <span className={cx('shrink-0 text-xs tabular-nums', over ? 'font-semibold text-red-700 dark:text-red-300' : 'text-neutral-500')}>
        {used.toLocaleString('en-US')} / {max.toLocaleString('en-US')} {unitLabel(unit)}
        {over ? ` (${(used - max).toLocaleString('en-US')} over)` : ''}
      </span>
    </div>
  )
}

function accountLabel(v: PreviewVariant): { text: string; ok: boolean } {
  if (!v.account) return { text: 'No account connected', ok: false }
  const name = v.account.handle ? `@${v.account.handle.replace(/^@/, '')}` : (v.account.displayName ?? 'Connected account')
  return { text: name, ok: v.account.status === 'active' }
}

export function PreviewCard({ variant: v, children }: { variant: PreviewVariant; children?: ReactNode }) {
  const vertical = VERTICAL.includes(v.platform)
  const pin = v.platform === 'pinterest'
  const account = accountLabel(v)
  const errors = v.issues.filter((i) => i.severity === 'error')
  const warnings = v.issues.filter((i) => i.severity !== 'error')
  const media = v.media.length > 0 ? (
    <div className={cx('grid gap-2', v.media.length === 1 ? (vertical || pin ? 'mx-auto w-48 grid-cols-1' : 'grid-cols-1') : 'grid-cols-3')}>
      {v.media.map((m) => (
        <MediaTile key={m.id} m={m} vertical={vertical && v.media.length === 1} />
      ))}
    </div>
  ) : null

  return (
    <article
      aria-label={`${PLATFORM_LABELS[v.platform]} preview`}
      data-platform={v.platform}
      className={cx(
        'flex flex-col gap-3 rounded-xl border bg-white p-4 dark:bg-neutral-950',
        errors.length > 0 ? 'border-red-300 dark:border-red-900' : 'border-neutral-200 dark:border-neutral-800',
      )}
    >
      <header className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <PlatformMark platform={v.platform} />
          <div className="min-w-0">
            <p className="text-sm font-semibold">{v.label}</p>
            <p className={cx('truncate text-xs', account.ok ? 'text-neutral-500' : 'text-amber-700 dark:text-amber-300')}>{account.text}</p>
          </div>
        </div>
        {v.ready ? <Badge tone="success">Ready</Badge> : <Badge tone={errors.length > 0 ? 'danger' : 'warning'}>Needs attention</Badge>}
      </header>

      {vertical || pin ? media : null}
      {v.title ? <p className={cx('font-semibold', v.platform === 'youtube' ? 'text-base' : 'text-sm')}>{v.title}</p> : null}
      {v.text ? (
        <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">{v.text}</p>
      ) : (
        <p className="text-sm italic text-neutral-500">No text</p>
      )}
      {!vertical && !pin ? media : null}

      <LengthMeter used={v.length.used} max={v.length.max} unit={v.length.unit} />

      {errors.length > 0 || warnings.length > 0 ? (
        <ul className="space-y-1 text-xs">
          {errors.map((i, n) => (
            <li key={`e${n}`} className="flex gap-1.5 text-red-700 dark:text-red-300">
              <span aria-hidden="true">●</span>
              <span>
                <span className="sr-only">Error: </span>
                {i.message}
              </span>
            </li>
          ))}
          {warnings.map((i, n) => (
            <li key={`w${n}`} className="flex gap-1.5 text-amber-700 dark:text-amber-300">
              <span aria-hidden="true">●</span>
              <span>
                <span className="sr-only">Warning: </span>
                {i.message}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {children}
    </article>
  )
}
