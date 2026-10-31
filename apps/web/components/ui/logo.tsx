import Link from 'next/link'
import { PRODUCT_NAME } from '@/lib/ui/brand'
import { cx } from './styles'

/** The product mark (inline SVG, no external asset) and name. */
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true" className={cx('h-7 w-7', className)}>
      <defs>
        <linearGradient id="logo-g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#6366f1" />
          <stop offset="1" stopColor="#ec4899" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="8" fill="url(#logo-g)" />
      <path d="M12 9.5v13l10.5-6.5z" fill="#fff" />
    </svg>
  )
}

export function Logo({ href = '/', className }: { href?: string; className?: string }) {
  return (
    <Link href={href} className={cx('inline-flex items-center gap-2 font-semibold tracking-tight', className)}>
      <LogoMark />
      <span>{PRODUCT_NAME}</span>
    </Link>
  )
}
