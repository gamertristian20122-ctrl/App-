// The terms of service (/terms), including "Subscriptions, cancellation and refunds". Prices and
// limits come from @app/core/plans; values from the configuration (lib/ui/legal.ts).

import Link from 'next/link'
import { ADD_ONS, PLANS, TRIAL, formatCents } from '@app/core/plans'
import { PLAN_TIERS } from '@app/core/types'
import { PRODUCT_NAME } from '@/lib/ui/brand'
import type { LegalInfo } from '@/lib/ui/legal'
import { Entity, H2, LegalPage, List, P, SupportEmail, Value } from './legal-page'

export const REFUNDS_HEADING = 'Subscriptions, cancellation and refunds'

export function TermsOfService({ info }: { info: LegalInfo }) {
  const plans = PLAN_TIERS.map((t) => `${PLANS[t].name} ${formatCents(PLANS[t].priceCents)}`).join(', ')
  return (
    <LegalPage
      title="Terms of service"
      info={info}
      intro={
        <P>
          These terms are an agreement between you and <Entity info={info} /> (“we”, “us”), the provider of {PRODUCT_NAME}. By creating an account or using{' '}
          {PRODUCT_NAME}, including through an AI assistant connected to it, you agree to them. If you use it for a company, you agree for that company. Please
          also read our <Link href="/privacy" className="underline">privacy policy</Link>.
        </P>
      }
    >
      <H2 id="service">The service</H2>
      <P>
        {PRODUCT_NAME} gives the AI assistant you already use (for example Claude, ChatGPT or Cursor) tools to draft posts, cut long videos into short clips,
        schedule and publish to social platforms, and review results. Publishing and statistics go through our partner Upload-Post. The website is where you
        approve drafts, see the calendar, connect accounts and manage billing.
      </P>

      <H2 id="accounts">Your account</H2>
      <List
        items={[
          'You must be at least 18 years old (or the age of majority where you live).',
          'Give a real email address and keep access to it secure: anyone who can open your sign-in emails can use your account.',
          'You are responsible for what happens in your account, including what the AI apps you connect do with the access you gave them.',
        ]}
      />

      <H2 id="content">Your content</H2>
      <P>
        You keep all rights to your content. You give us permission to store, process (for example transcribe, cut, caption and render) and send it to the
        platforms you choose, only to run the service for you. You confirm you have the rights needed for everything you upload and publish.
      </P>

      <H2 id="acceptable-use">Acceptable use</H2>
      <List
        items={[
          <>
            <strong>Only your own content.</strong> Upload and clip only videos you own or have permission to use. Do not repost other people’s videos. We do not
            download from YouTube or other video sites.
          </>,
          <>
            <strong>Follow each platform’s rules.</strong> TikTok, YouTube, Instagram, Facebook, Threads, X, LinkedIn, Pinterest and Bluesky each have terms and
            community guidelines (including rules on spam, automation, branded content and labelling AI-made content). You must follow them.
          </>,
          'No illegal, infringing, hateful, harassing, sexually exploitative, deceptive or misleading content; no spam, fake engagement or impersonation.',
          'No malware, no attempts to break into, overload, probe or reverse engineer the service, and no reselling it without our written permission.',
        ]}
      />

      <H2 id="approvals">Approvals, AI assistants and Auto-post</H2>
      <P>
        Nothing is published until it is approved: by you (in the approval card or on the website), or by a brand’s Auto-post switch. Only you can turn
        Auto-post on, on the website. While it is on, videos your AI assistant sends for that brand are published without asking you each time, within the
        platforms, daily limit and settings you chose and each platform’s own limits. <strong>You are responsible for everything published from your
        account, whether you approved it yourself or Auto-post did.</strong> Your AI assistant is made by another company; review what it writes before you
        approve it.
      </P>

      <H2 id="third-parties">Other services</H2>
      <P>
        The service depends on social platforms, Upload-Post, AI assistants, Stripe and hosting providers. Their terms apply to your use of them. Platforms can
        change their rules, limit or remove posts, or suspend accounts, and we are not responsible for that.
      </P>

      <H2 id="plans">Plans and limits</H2>
      <P>
        Plans: {plans} per month. Each plan has a number of brands and clipping hours per month (see the pricing on our home page); add-ons cost{' '}
        {formatCents(ADD_ONS.extra_brand.priceCents)} per extra brand and {formatCents(ADD_ONS.extra_clip_hour.priceCents)} per extra clipping hour per month.
        Clipping hours measure the length of each source video you clip, counted once per video; unused hours do not roll over. New accounts get a free{' '}
        {TRIAL.days}-day trial with {PLANS[TRIAL.plan].name} limits and {TRIAL.clipHours} clipping hour, with no card needed; it ends on its own.
      </P>

      <H2 id="subscriptions">{REFUNDS_HEADING}</H2>
      <List
        items={[
          <>
            <strong>Monthly, renewing automatically.</strong> Plans and add-ons are billed monthly in advance, in US dollars, through Stripe, and renew
            automatically every month until you cancel.
          </>,
          <>
            <strong>Cancel any time</strong> from Billing → Manage billing (the Stripe billing portal). Cancelling stops the next renewal: you keep access until
            the end of the period you already paid for, and you are not charged again.
          </>,
          <>
            <strong>No refunds for partial months</strong> or unused clipping hours, unless the law requires one. If something went wrong with a charge, write to{' '}
            <SupportEmail info={info} subject="Billing" /> and we will look at it.
          </>,
          'Plan changes: an upgrade applies right away and you pay the prorated difference; a downgrade also applies right away with a prorated credit. If you then have more brands than your plan allows, the newest are paused (nothing is deleted).',
          'Failed payments: posts you already approved keep publishing for a while, but new clipping and rendering pause. If payment is not fixed, your account is put on hold (read-only; nothing is deleted).',
          'Price changes: we tell you at least 30 days in advance; new prices apply from your next billing period. Prices do not include taxes unless stated.',
        ]}
      />

      <H2 id="copyright">Copyright complaints</H2>
      <P>
        If you believe content published through {PRODUCT_NAME} infringes your copyright, send a notice to <SupportEmail info={info} subject="Copyright notice" />{' '}
        (what to include is on the <Link href="/contact" className="underline">contact page</Link>). We remove infringing content we host and close the
        accounts of repeat infringers.
      </P>

      <H2 id="changes">Changes to the service</H2>
      <P>
        We keep improving {PRODUCT_NAME}, so features may change, be added or be removed. We give reasonable notice before important changes that affect
        you. We aim for the service to be available at all times but do not guarantee it, and we may pause it for maintenance.
      </P>

      <H2 id="ending">Ending the agreement</H2>
      <P>
        You can stop using {PRODUCT_NAME} and ask us to delete your account at any time. We may suspend or close an account that breaks these terms, puts others
        at risk, or where the law requires it; where we reasonably can, we warn you first. What happens to your data is described in the privacy policy.
      </P>

      <H2 id="disclaimer">No guarantees</H2>
      <P>
        The service is provided “as is”. We do not promise any reach, engagement or results, that a platform will accept a post, or that a post goes out at an
        exact minute.
      </P>

      <H2 id="liability">Limitation of liability</H2>
      <P>
        To the extent the law allows, we are not liable for indirect, incidental, special, consequential or punitive damages, or for lost profits, revenue,
        data or goodwill, or for what social platforms, AI assistants or other third parties do. Our total liability for any claim is limited to the greater
        of the amount you paid us in the 12 months before the claim and 50 US dollars. Nothing in these terms limits liability that cannot be limited by law.
      </P>

      <H2 id="indemnity">Your responsibility to us</H2>
      <P>
        If someone makes a claim against us because of your content or because you broke these terms, you will cover the reasonable costs of that claim.
      </P>

      <H2 id="law">Governing law</H2>
      <P>
        These terms are governed by the laws of <Value info={info} field="LEGAL_JURISDICTION" text={info.jurisdiction} />, and disputes go to the courts there,
        except where the consumer law of the place you live gives you the right to bring a claim at home.
      </P>

      <H2 id="updates">Changes to these terms</H2>
      <P>
        When we change these terms we update the date at the top and, for important changes, tell you by email or in the app before they take effect. If you
        keep using {PRODUCT_NAME} after that, the new terms apply; if you do not agree, cancel before they take effect.
      </P>

      <H2 id="contact">Contact</H2>
      <P>
        <Entity info={info} />, <SupportEmail info={info} />.
      </P>
    </LegalPage>
  )
}
