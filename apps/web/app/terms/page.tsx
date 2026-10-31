// The terms of service, including subscriptions, cancellation and refunds. Values come from the
// environment; missing ones show "[set NAME]" placeholders (and /setup flags them).

import type { Metadata } from 'next'
import { TermsOfService } from '@/components/legal/terms'
import { serverEnv } from '@/lib/server/deps'
import { legalInfoFromEnv } from '@/lib/server/legal'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Terms of service' }

export default function TermsPage() {
  return <TermsOfService info={legalInfoFromEnv(serverEnv())} />
}
