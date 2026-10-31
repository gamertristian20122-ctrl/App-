// Contact: support, account deletion, billing, copyright notices and security reports, all through
// SUPPORT_EMAIL (a "[set SUPPORT_EMAIL]" placeholder until it is set).

import type { Metadata } from 'next'
import { ContactPage as Contact } from '@/components/legal/contact'
import { serverEnv } from '@/lib/server/deps'
import { legalInfoFromEnv } from '@/lib/server/legal'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Contact' }

export default function ContactPage() {
  return <Contact info={legalInfoFromEnv(serverEnv())} />
}
