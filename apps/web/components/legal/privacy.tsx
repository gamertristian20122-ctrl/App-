// The privacy policy (/privacy): what we store, why, who processes it, how long we keep it, how to
// delete it. Specific to this product; values from the configuration (lib/ui/legal.ts).

import Link from 'next/link'
import { SOURCE_LIMITS } from '@app/core/plans'
import { PRODUCT_NAME } from '@/lib/ui/brand'
import type { LegalInfo } from '@/lib/ui/legal'
import { Entity, H2, LegalPage, List, P, SupportEmail } from './legal-page'

/** Who processes data for us, and what for (also listed in docs/LAUNCH-CHECKLIST.md). */
export const PROCESSORS: ReadonlyArray<{ name: string; purpose: string }> = [
  { name: 'Supabase', purpose: 'our database and email sign-in' },
  { name: 'Vercel', purpose: 'hosting for this website and the connection your AI assistant uses' },
  { name: 'Railway', purpose: 'background workers that publish posts and process videos' },
  { name: 'Cloudflare R2', purpose: 'storage for the videos, images and clips you upload or we make' },
  { name: 'Upload-Post', purpose: 'connecting your social accounts, publishing to them, and reading post statistics' },
  { name: 'Stripe', purpose: 'payments, subscriptions and invoices' },
  { name: 'AssemblyAI', purpose: 'turning speech in the videos you clip into text' },
  { name: 'Our email provider', purpose: 'sending sign-in links' },
]

export function PrivacyPolicy({ info }: { info: LegalInfo }) {
  return (
    <LegalPage
      title="Privacy policy"
      info={info}
      intro={
        <P>
          {PRODUCT_NAME} is provided by <Entity info={info} /> (“we”, “us”). This policy explains what we collect when you use {PRODUCT_NAME} on{' '}
          {info.appUrl} and through the AI assistants you connect to it, why we collect it, and what you can do about it. Questions:{' '}
          <SupportEmail info={info} subject="Privacy" />.
        </P>
      }
    >
      <H2 id="short">The short version</H2>
      <List
        items={[
          'We keep only what we need to run the service for you.',
          'We do not sell your data, show ads, or use tracking cookies.',
          'We do not train AI models on your content, and we do not run or pay for AI models.',
          'Your social media logins are held by Upload-Post, not by us.',
          'You can ask us to delete everything at any time.',
        ]}
      />

      <H2 id="what">What we store</H2>
      <List
        items={[
          <>
            <strong>Your account:</strong> your email address, an optional display name, your time zone, and sign-in records.
          </>,
          <>
            <strong>Brands and connected accounts:</strong> brand names and settings (including the Auto-post switch), and the names and handles of the
            social accounts you connect. We never see or store your social media passwords or login tokens: Upload-Post holds those connections for us.
          </>,
          <>
            <strong>Your content:</strong> drafts, captions, scheduled and published posts, approval history, your voice profile, and the captions and links of
            past posts you import (not their media).
          </>,
          <>
            <strong>Media:</strong> the videos, images and audio you upload or share from Google Drive, Dropbox or OneDrive, and the clips, carousels and videos we
            make from them.
          </>,
          <>
            <strong>Transcripts:</strong> the words spoken in videos you clip, with their timings.
          </>,
          <>
            <strong>Analytics:</strong> numbers such as views, likes, comments, shares and followers for your posts and accounts.
          </>,
          <>
            <strong>Usage and billing:</strong> your plan, subscription status, clipping hours used and similar counters, and your Stripe customer number.
            Card details go straight to Stripe; we never see them.
          </>,
          <>
            <strong>AI app connections:</strong> which AI apps you connected and when. The tokens those apps use to reach your account are random values we
            store only as one-way hashes, so nobody can read them back from our database.
          </>,
          <>
            <strong>Security records:</strong> a log of important actions (approvals, setting changes, connections) without passwords or keys, and server logs
            (which include IP addresses) kept for a short time by our hosting providers.
          </>,
        ]}
      />

      <H2 id="use">How we use it</H2>
      <P>
        Only to provide what you ask for: drafting, clipping, scheduling and publishing posts, showing you analytics, billing you, keeping the service secure,
        answering support requests, and meeting legal obligations. We do not use your data for advertising and we do not build profiles of you.
      </P>

      <H2 id="ai">AI assistants</H2>
      <P>
        You choose an AI assistant (for example Claude, ChatGPT or Cursor) and connect it to your account. It acts on your behalf with the access you give it
        on the consent screen, and you can disconnect it at any time on the Connect page. What you type into your assistant, and what our tools send back to
        it, is processed by that assistant’s provider under your agreement with them, not under this policy. We do not run or pay for AI models, and we do not
        use your content to train AI models. Nothing your assistant makes is published until you approve it, or until the Auto-post switch that you turned on
        for a brand approves it.
      </P>

      <H2 id="processors">Who processes data for us</H2>
      <P>These companies process data on our behalf, only to provide their service to us:</P>
      <List
        items={PROCESSORS.map((p) => (
          <>
            <strong>{p.name}</strong>: {p.purpose}.
          </>
        ))}
      />
      <P>
        Some of them store data in the United States or other countries; transfers rely on their standard contractual safeguards. When you publish, your
        post goes to the platforms you chose (TikTok, YouTube, Instagram, Facebook, Threads, X, LinkedIn, Pinterest or Bluesky), and their own policies apply
        to it there.
      </P>

      <H2 id="retention">How long we keep it</H2>
      <List
        items={[
          `Source videos you upload for clipping: deleted from storage ${SOURCE_LIMITS.retentionDays} days after upload, unless a draft or scheduled post still uses them.`,
          'Transcripts at AssemblyAI: deleted from AssemblyAI right after we receive them (we keep our copy with your account).',
          'Approval links expire after 24 hours. Sign-in tokens of AI apps expire on their own (access tokens after about an hour; refresh tokens after 30 days without use), and AI app registrations that are never used are deleted after 7 days.',
          'Everything else (account, brands, drafts, posts, clips, transcripts, analytics): kept while your account exists. If you cancel your plan, your data stays (read-only) so you can come back, until you ask us to delete it.',
          'Billing records: kept by Stripe and by us for as long as tax and accounting laws require.',
          'Backups and server logs: overwritten on our providers’ normal schedules.',
        ]}
      />

      <H2 id="delete">Deleting your data</H2>
      <P>
        Email <SupportEmail info={info} subject="Delete my account" /> from the address you sign in with and ask us to delete your account. We then disconnect
        your social accounts (deleting your brands’ Upload-Post profiles), delete your account and everything tied to it, and confirm by email, normally within
        30 days. You can ask for a copy of your data the same way. At any time you can also disconnect social accounts on the Accounts page and AI apps on the
        Connect page.
      </P>

      <H2 id="cookies">Cookies</H2>
      <P>
        We use only the cookies needed to keep you signed in, plus one that remembers which brand you selected. No advertising or analytics cookies, and no
        third-party trackers.
      </P>

      <H2 id="security">Security</H2>
      <P>
        Data travels over HTTPS and is encrypted at rest by our providers. Secrets we must keep are encrypted, and AI app tokens are stored only as hashes. No
        system is perfectly secure; if we learn of a breach that affects you, we will tell you.
      </P>

      <H2 id="age">Minimum age</H2>
      <P>
        {PRODUCT_NAME} is for people aged 18 or older (or the age of majority where you live). We do not knowingly collect data from children; if you think a
        child has given us data, contact us and we will delete it.
      </P>

      <H2 id="rights">Your rights</H2>
      <P>
        Depending on where you live (for example under the GDPR, the UK GDPR or California law), you may have the right to access, correct, delete or export
        your data, and to object to or restrict how we use it. Write to <SupportEmail info={info} subject="Privacy request" /> and we will answer within 30
        days. You can also complain to your local data protection authority. We do not sell or share personal information for targeted advertising.
      </P>

      <H2 id="changes">Changes to this policy</H2>
      <P>
        When we change this policy we update the date at the top. For important changes we tell you by email or in the app before they take effect.
      </P>

      <H2 id="contact">Contact</H2>
      <P>
        <Entity info={info} />, <SupportEmail info={info} subject="Privacy" />. More ways to reach us are on the <Link href="/contact" className="underline">contact page</Link>.
      </P>
    </LegalPage>
  )
}
