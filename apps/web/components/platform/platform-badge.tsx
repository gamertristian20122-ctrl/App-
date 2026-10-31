// Platform marks and badges (no external logos or fonts: a coloured monogram per platform).

import { PLATFORM_LABELS, type Platform } from '@app/core/types'
import { cx } from '@/components/ui/styles'

export const PLATFORM_STYLE: Readonly<Record<Platform, { mark: string; className: string }>> = {
  tiktok: { mark: 'Tt', className: 'bg-neutral-950 text-white ring-neutral-700' },
  youtube: { mark: 'YT', className: 'bg-red-600 text-white ring-red-700' },
  instagram: { mark: 'Ig', className: 'bg-gradient-to-br from-amber-400 via-pink-500 to-purple-600 text-white ring-pink-600' },
  facebook: { mark: 'f', className: 'bg-blue-600 text-white ring-blue-700' },
  threads: { mark: '@', className: 'bg-neutral-900 text-white ring-neutral-700' },
  x: { mark: 'X', className: 'bg-black text-white ring-neutral-700' },
  linkedin: { mark: 'in', className: 'bg-sky-700 text-white ring-sky-800' },
  pinterest: { mark: 'P', className: 'bg-red-700 text-white ring-red-800' },
  bluesky: { mark: 'bs', className: 'bg-sky-500 text-white ring-sky-600' },
}

/** A small monogram tile. Decorative: pair it with the platform name. */
export function PlatformMark({ platform, size = 'md' }: { platform: Platform; size?: 'sm' | 'md' | 'lg' }) {
  const s = PLATFORM_STYLE[platform]
  const dims = size === 'sm' ? 'h-5 w-5 text-[10px]' : size === 'lg' ? 'h-10 w-10 text-sm' : 'h-7 w-7 text-xs'
  return (
    <span aria-hidden="true" className={cx('inline-flex shrink-0 items-center justify-center rounded-md font-bold ring-1 ring-inset', dims, s.className)}>
      {s.mark}
    </span>
  )
}

export function PlatformBadge({ platform, className }: { platform: Platform; className?: string }) {
  return (
    <span className={cx('inline-flex items-center gap-1.5 text-sm font-medium', className)}>
      <PlatformMark platform={platform} size="sm" />
      {PLATFORM_LABELS[platform]}
    </span>
  )
}
