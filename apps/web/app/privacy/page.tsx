// The privacy policy. Values (who provides the service, support email, effective date) come from
// the environment; missing ones show "[set NAME]" placeholders (and /setup flags them).

import type { Metadata } from 'next'
import { PrivacyPolicy } from '@/components/legal/privacy'
import { serverEnv } from '@/lib/server/deps'
import { legalInfoFromEnv } from '@/lib/server/legal'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Privacy policy' }

export default function PrivacyPage() {
  return <PrivacyPolicy info={legalInfoFromEnv(serverEnv())} />
}
