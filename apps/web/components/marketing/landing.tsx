// The marketing page sections (server components, static content; prices come from
// @app/core/plans through PricingTable).

import Link from 'next/link'
import type { ReactNode } from 'react'
import { PLANS, TRIAL, formatCents } from '@app/core/plans'
import { PLATFORMS, PLATFORM_LABELS } from '@app/core/types'
import { LegalLinks } from '@/components/legal/legal-links'
import { PlatformMark } from '@/components/platform/platform-badge'
import { Logo } from '@/components/ui/logo'
import { button, cx } from '@/components/ui/styles'
import { AI_CLIENTS, PRODUCT_DESCRIPTION, PRODUCT_NAME } from '@/lib/ui/brand'
import { PricingTable } from './pricing-table'

export function SiteHeader() {
  return (
    <header className="sticky top-0 z-30 border-b border-neutral-200/70 bg-white/85 backdrop-blur dark:border-neutral-800/70 dark:bg-neutral-950/85">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3 sm:px-6">
        <Logo />
        <nav aria-label="Main" className="flex items-center gap-1 text-sm sm:gap-4">
          <a href="#features" className="hidden rounded px-2 py-1 text-neutral-700 hover:text-neutral-950 sm:inline dark:text-neutral-300 dark:hover:text-white">
            Features
          </a>
          <a href="#pricing" className="hidden rounded px-2 py-1 text-neutral-700 hover:text-neutral-950 sm:inline dark:text-neutral-300 dark:hover:text-white">
            Pricing
          </a>
          <a href="#faq" className="hidden rounded px-2 py-1 text-neutral-700 hover:text-neutral-950 sm:inline dark:text-neutral-300 dark:hover:text-white">
            FAQ
          </a>
          <Link href="/login" className="rounded px-2 py-1 text-neutral-700 hover:text-neutral-950 dark:text-neutral-300 dark:hover:text-white">
            Sign in
          </Link>
          <Link href="/login" className={cx(button.primary, button.small)}>
            Start free
          </Link>
        </nav>
      </div>
    </header>
  )
}

function ChatMock() {
  return (
    <div aria-hidden="true" className="relative mx-auto w-full max-w-md rounded-2xl border border-neutral-200 bg-white p-4 shadow-xl dark:border-neutral-800 dark:bg-neutral-900">
      <div className="flex items-center gap-2 border-b border-neutral-100 pb-3 text-xs text-neutral-500 dark:border-neutral-800">
        <span className="h-2.5 w-2.5 rounded-full bg-red-400" />
        <span className="h-2.5 w-2.5 rounded-full bg-amber-400" />
        <span className="h-2.5 w-2.5 rounded-full bg-emerald-400" />
        <span className="ml-2">Your AI chat</span>
      </div>
      <div className="space-y-3 pt-3 text-sm">
        <p className="ml-auto w-fit max-w-[85%] rounded-2xl rounded-br-sm bg-indigo-600 px-3 py-2 text-white">
          Cut 5 shorts from this week&apos;s podcast and draft posts in my voice.
        </p>
        <div className="w-fit max-w-[90%] rounded-2xl rounded-bl-sm bg-neutral-100 px-3 py-2 dark:bg-neutral-800">
          Done. 5 vertical clips with captions are ready, each with posts for TikTok, YouTube Shorts and Instagram. Review them below.
        </div>
        <div className="rounded-xl border border-neutral-200 p-3 dark:border-neutral-700">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wide text-neutral-500">Approval card</span>
            <span className="flex gap-1">
              <PlatformMark platform="tiktok" size="sm" />
              <PlatformMark platform="youtube" size="sm" />
              <PlatformMark platform="instagram" size="sm" />
            </span>
          </div>
          <div className="mt-2 flex gap-3">
            <div className="h-24 w-14 shrink-0 rounded-md bg-gradient-to-b from-indigo-400 to-pink-400" />
            <div className="flex-1 space-y-1.5">
              <div className="h-2 w-full rounded bg-neutral-200 dark:bg-neutral-700" />
              <div className="h-2 w-5/6 rounded bg-neutral-200 dark:bg-neutral-700" />
              <div className="h-2 w-2/3 rounded bg-neutral-200 dark:bg-neutral-700" />
              <p className="pt-1 text-[11px] text-neutral-500">1,204 / 2,200 characters</p>
            </div>
          </div>
          <div className="mt-3 flex gap-2">
            <span className="flex-1 rounded-md bg-indigo-600 py-1.5 text-center text-xs font-medium text-white">Approve</span>
            <span className="flex-1 rounded-md border border-neutral-300 py-1.5 text-center text-xs dark:border-neutral-600">Edit</span>
            <span className="flex-1 rounded-md border border-neutral-300 py-1.5 text-center text-xs dark:border-neutral-600">Reject</span>
          </div>
        </div>
      </div>
    </div>
  )
}

export function Hero() {
  return (
    <section className="relative overflow-hidden">
      <div className="pointer-events-none absolute inset-x-0 -top-40 -z-10 h-96 bg-gradient-to-b from-indigo-100 to-transparent dark:from-indigo-950/40" aria-hidden="true" />
      <div className="mx-auto grid max-w-6xl items-center gap-12 px-4 py-16 sm:px-6 md:py-24 lg:grid-cols-2">
        <div>
          <p className="inline-flex items-center gap-2 rounded-full border border-indigo-200 bg-indigo-50 px-3 py-1 text-xs font-medium text-indigo-800 dark:border-indigo-900 dark:bg-indigo-950 dark:text-indigo-200">
            Works with {AI_CLIENTS.join(', ').replace(/, ([^,]*)$/, ' and $1')}
          </p>
          <h1 className="mt-5 text-4xl font-bold tracking-tight sm:text-5xl">
            Your AI runs your social media.
            <span className="block text-indigo-600 dark:text-indigo-400">We do the work.</span>
          </h1>
          <p className="mt-5 max-w-xl text-lg text-neutral-600 dark:text-neutral-300">{PRODUCT_DESCRIPTION}</p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Link href="/login" className={cx(button.primary, 'px-5 py-2.5 text-base')}>
              Start your {TRIAL.days}-day free trial
            </Link>
            <a href="#pricing" className={cx(button.secondary, 'px-5 py-2.5 text-base')}>
              See pricing
            </a>
          </div>
          <p className="mt-4 text-sm text-neutral-500">From {formatCents(PLANS.starter.priceCents)}/month. No card needed for the trial.</p>
        </div>
        <ChatMock />
      </div>
    </section>
  )
}

function Feature({ title, children, icon }: { title: string; children: ReactNode; icon: ReactNode }) {
  return (
    <li className="rounded-2xl border border-neutral-200 bg-white p-6 dark:border-neutral-800 dark:bg-neutral-900">
      <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-indigo-50 text-indigo-600 dark:bg-indigo-950 dark:text-indigo-300" aria-hidden="true">
        {icon}
      </div>
      <h3 className="mt-4 font-semibold">{title}</h3>
      <p className="mt-2 text-sm leading-relaxed text-neutral-600 dark:text-neutral-400">{children}</p>
    </li>
  )
}

const icon = (d: string) => (
  <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d={d} />
  </svg>
)

export function Features() {
  return (
    <section id="features" className="scroll-mt-20 border-t border-neutral-200 bg-neutral-50 py-20 dark:border-neutral-800 dark:bg-neutral-950">
      <div className="mx-auto max-w-6xl px-4 sm:px-6">
        <h2 className="text-3xl font-bold tracking-tight">Your AI does the thinking. {PRODUCT_NAME} does the work.</h2>
        <p className="mt-3 max-w-2xl text-neutral-600 dark:text-neutral-400">
          Add one URL to the AI app you already use. It gets tools to draft, clip, schedule and review, plus our playbook so every
          result is consistent.
        </p>
        <ul className="mt-10 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          <Feature title="Your AI drives it" icon={icon('M4 6h16M4 12h10M4 18h7m9-3 2 2-2 2m-4-4-2 2 2 2')}>
            {PRODUCT_NAME} is an MCP server: Claude, ChatGPT, Cursor and other AI apps call its tools. You never pay us for AI, and you
            keep the assistant you like.
          </Feature>
          <Feature title="Long videos into shorts" icon={icon('M4 5h11v14H4zM15 9l5-3v12l-5-3')}>
            Upload a podcast or stream, or share it from Google Drive, Dropbox or OneDrive. Your AI picks standalone moments with a hook;
            we cut vertical 9:16 clips with burned-in captions.
          </Feature>
          <Feature title="Writes in your voice" icon={icon('M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3zm7 9a7 7 0 0 1-14 0m7 7v2')}>
            Import your past posts and save a voice profile: tone, audience, words you use and avoid. Every draft is written from it.
          </Feature>
          <Feature title="Weekly review that learns" icon={icon('M4 19V9m6 10V5m6 14v-7m4 7H2')}>
            Each week your AI compares the last 7 days with the 7 before, finds what worked, and proposes three experiments for next week.
          </Feature>
          <Feature title="Nothing posts without you" icon={icon('m5 12 4 4L19 6')}>
            Every post and clip starts as a draft. Approve, edit or reject it from a card in your AI chat or the approval queue here.
          </Feature>
          <Feature title={`${PLATFORMS.length} platforms, one place`} icon={icon('M12 3v18M3 12h18M5.6 5.6l12.8 12.8M18.4 5.6 5.6 18.4')}>
            Schedule to every platform from one calendar. We respect each platform&apos;s limits and daily caps for you.
          </Feature>
        </ul>
      </div>
    </section>
  )
}

export function HowItWorks() {
  const steps = [
    { title: 'Connect your accounts', body: 'Create a brand and connect the social accounts it posts to. One click per platform.' },
    { title: 'Add us to your AI', body: 'Paste one URL into Claude, ChatGPT or Cursor and sign in. That is the whole setup.' },
    { title: 'Ask, approve, publish', body: '“Turn this video into five shorts.” Review the drafts, approve them, and they go out on schedule.' },
  ]
  return (
    <section className="py-20">
      <div className="mx-auto max-w-6xl px-4 sm:px-6">
        <h2 className="text-3xl font-bold tracking-tight">Set up in five minutes</h2>
        <ol className="mt-10 grid gap-6 md:grid-cols-3">
          {steps.map((s, i) => (
            <li key={s.title} className="relative rounded-2xl border border-neutral-200 p-6 dark:border-neutral-800">
              <span className="flex h-8 w-8 items-center justify-center rounded-full bg-indigo-600 text-sm font-bold text-white" aria-hidden="true">
                {i + 1}
              </span>
              <h3 className="mt-4 font-semibold">{s.title}</h3>
              <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-400">{s.body}</p>
            </li>
          ))}
        </ol>
        <div className="mt-12">
          <h3 className="text-sm font-semibold uppercase tracking-wide text-neutral-500">Publishes to</h3>
          <ul className="mt-4 flex flex-wrap gap-3" aria-label="Supported platforms">
            {PLATFORMS.map((p) => (
              <li key={p} className="inline-flex items-center gap-2 rounded-full border border-neutral-200 py-1.5 pl-1.5 pr-3 text-sm dark:border-neutral-800">
                <PlatformMark platform={p} size="sm" />
                {PLATFORM_LABELS[p]}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  )
}

export function Pricing() {
  return (
    <section id="pricing" className="scroll-mt-20 border-t border-neutral-200 bg-neutral-50 py-20 dark:border-neutral-800 dark:bg-neutral-950">
      <div className="mx-auto max-w-6xl px-4 sm:px-6">
        <div className="mx-auto max-w-2xl text-center">
          <h2 className="text-3xl font-bold tracking-tight">Simple pricing</h2>
          <p className="mt-3 text-neutral-600 dark:text-neutral-400">
            Pay for brands and clipping time, not for AI. Bring the AI app you already use.
          </p>
        </div>
        <div className="mt-12">
          <PricingTable />
        </div>
      </div>
    </section>
  )
}

export const FAQ_ITEMS: ReadonlyArray<{ q: string; a: string }> = [
  {
    q: 'Do I pay for AI usage?',
    a: `No. You use the AI app you already have (Claude, ChatGPT, Cursor or another MCP client). ${PRODUCT_NAME} never runs or bills for AI; your plan covers brands, clipping time and publishing.`,
  },
  {
    q: 'What is MCP, and how do I connect my AI?',
    a: 'MCP (Model Context Protocol) is an open standard that lets AI apps use tools. After you sign up, copy your server URL from the Connect page, add it as a connector in your AI app, and sign in once.',
  },
  {
    q: 'What counts as a clipping hour?',
    a: 'The length of each source video you clip from, counted once per video however many clips you make. A failed upload or transcription is refunded automatically. Unused hours do not roll over.',
  },
  {
    q: 'Can I clip YouTube videos?',
    a: 'Only your own content: upload the file, or share it from Google Drive, Dropbox or OneDrive. We do not download from YouTube or other video sites.',
  },
  {
    q: 'Will anything post without my approval?',
    a: 'No. Every post and clip is saved as a draft. It is published only after you approve it, in the approval card inside your AI chat or in the approval queue here. Your AI cannot approve on its own.',
  },
  {
    q: 'Which platforms are supported?',
    a: `${PLATFORMS.map((p) => PLATFORM_LABELS[p]).join(', ')}. One account per platform per brand.`,
  },
  {
    q: 'Can I post links on X?',
    a: 'Not yet. X posts that contain a link are turned off for now; links work on the other platforms.',
  },
  {
    q: 'Can I cancel any time?',
    a: 'Yes. Manage or cancel your plan from the billing page. Nothing is deleted when you cancel; your account becomes read-only.',
  },
]

export function Faq() {
  return (
    <section id="faq" className="scroll-mt-20 py-20">
      <div className="mx-auto max-w-3xl px-4 sm:px-6">
        <h2 className="text-3xl font-bold tracking-tight">Questions</h2>
        <div className="mt-8 divide-y divide-neutral-200 rounded-2xl border border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800">
          {FAQ_ITEMS.map((item) => (
            <details key={item.q} className="group p-5 [&_summary::-webkit-details-marker]:hidden">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-4 font-medium">
                {item.q}
                <span className="text-neutral-400 transition-transform group-open:rotate-45" aria-hidden="true">
                  +
                </span>
              </summary>
              <p className="mt-3 text-sm leading-relaxed text-neutral-600 dark:text-neutral-400">{item.a}</p>
            </details>
          ))}
        </div>
      </div>
    </section>
  )
}

export function FinalCta() {
  return (
    <section className="px-4 pb-20 sm:px-6">
      <div className="mx-auto max-w-6xl rounded-3xl bg-gradient-to-br from-indigo-600 to-fuchsia-600 px-6 py-14 text-center text-white">
        <h2 className="text-3xl font-bold tracking-tight">Let your AI handle the posting.</h2>
        <p className="mx-auto mt-3 max-w-xl text-indigo-100">
          Start a free {TRIAL.days}-day trial. Connect your accounts, add {PRODUCT_NAME} to your AI, and approve your first post today.
        </p>
        <Link
          href="/login"
          className="mt-8 inline-flex items-center rounded-lg bg-white px-5 py-2.5 font-semibold text-indigo-700 hover:bg-indigo-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
        >
          Get started free
        </Link>
      </div>
    </section>
  )
}

export function SiteFooter({ year }: { year: number }) {
  return (
    <footer className="border-t border-neutral-200 py-10 text-sm text-neutral-500 dark:border-neutral-800">
      <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-4 px-4 sm:flex-row sm:px-6">
        <p>
          © {year} {PRODUCT_NAME}
        </p>
        <nav aria-label="Footer" className="flex gap-5">
          <a href="#pricing" className="hover:text-neutral-900 dark:hover:text-white">
            Pricing
          </a>
          <a href="#faq" className="hover:text-neutral-900 dark:hover:text-white">
            FAQ
          </a>
          <Link href="/login" className="hover:text-neutral-900 dark:hover:text-white">
            Sign in
          </Link>
        </nav>
        <LegalLinks />
      </div>
    </footer>
  )
}

export function LandingPage({ year }: { year: number }) {
  return (
    <>
      <SiteHeader />
      <main id="main">
        <Hero />
        <Features />
        <HowItWorks />
        <Pricing />
        <Faq />
        <FinalCta />
      </main>
      <SiteFooter year={year} />
    </>
  )
}
