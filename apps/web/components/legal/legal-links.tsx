// Links to the legal pages (Privacy, Terms, Contact), shown in every footer: the landing page,
// sign-in, the dashboard, the OAuth consent page and the legal pages themselves. Static.

import Link from 'next/link'
import { cx } from '@/components/ui/styles'
import { PRODUCT_NAME } from '@/lib/ui/brand'

export const LEGAL_LINKS = [
  { href: '/privacy', label: 'Privacy' },
  { href: '/terms', label: 'Terms' },
  { href: '/contact', label: 'Contact' },
] as const

export function LegalLinks({ className }: { className?: string }) {
  return (
    <nav aria-label="Legal" className={cx('flex flex-wrap items-center gap-x-5 gap-y-2', className)}>
      {LEGAL_LINKS.map((l) => (
        <Link key={l.href} href={l.href} className="hover:text-neutral-900 hover:underline dark:hover:text-white">
          {l.label}
        </Link>
      ))}
    </nav>
  )
}

/** A small footer: the product name and the legal links (dashboard, consent page, setup). */
export function LegalFooter({ className }: { className?: string }) {
  return (
    <footer className={cx('flex flex-col items-center gap-3 py-6 text-xs text-neutral-500 sm:flex-row sm:justify-center sm:gap-6', className)}>
      <span>{PRODUCT_NAME}</span>
      <LegalLinks />
    </footer>
  )
}
