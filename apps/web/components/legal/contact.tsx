// The contact page (/contact): support, account deletion and data requests, billing, copyright
// notices and security reports, all through SUPPORT_EMAIL.

import Link from 'next/link'
import { PRODUCT_NAME } from '@/lib/ui/brand'
import type { LegalInfo } from '@/lib/ui/legal'
import { Entity, H2, LegalPage, List, P, SupportEmail } from './legal-page'

export function ContactPage({ info }: { info: LegalInfo }) {
  return (
    <LegalPage
      title="Contact"
      info={info}
      intro={
        <P>
          {PRODUCT_NAME} is provided by <Entity info={info} />. Write to <SupportEmail info={info} /> and we answer within two business days.
        </P>
      }
    >
      <H2 id="support">Help with the product</H2>
      <P>
        Email <SupportEmail info={info} subject="Support" /> from the address you sign in with, and tell us what you tried and what happened. A screenshot
        helps.
      </P>

      <H2 id="account">Deleting your account or getting a copy of your data</H2>
      <P>
        Email <SupportEmail info={info} subject="Delete my account" /> from the address you sign in with. We confirm by email when it is done. Details are in the{' '}
        <Link href="/privacy#delete" className="underline">
          privacy policy
        </Link>
        .
      </P>

      <H2 id="billing">Billing</H2>
      <P>
        You can change or cancel your plan yourself on the Billing page (Manage billing). For invoices or a problem with a charge, write to{' '}
        <SupportEmail info={info} subject="Billing" />. Our cancellation and refund rules are in the{' '}
        <Link href="/terms#subscriptions" className="underline">
          terms
        </Link>
        .
      </P>

      <H2 id="copyright">Copyright and takedown notices</H2>
      <P>
        If content published through {PRODUCT_NAME} uses your work without permission, send a notice to <SupportEmail info={info} subject="Copyright notice" />{' '}
        with:
      </P>
      <List
        items={[
          'your name, postal address, phone number and email address;',
          'the work you own, and a link to (or description of) the content you believe infringes it;',
          'a statement that you believe in good faith that the use is not authorized by you, your agent or the law;',
          'a statement that your notice is accurate and that you are the owner or authorized to act for the owner;',
          'your physical or electronic signature.',
        ]}
      />

      <H2 id="security">Security reports</H2>
      <P>
        Found a security problem? Write to <SupportEmail info={info} subject="Security" /> with the details. Please give us a chance to fix it before you tell
        anyone else.
      </P>
    </LegalPage>
  )
}
