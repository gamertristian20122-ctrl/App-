// /setup as a page: OWNER_EMAIL unset → only the "set OWNER_EMAIL" message; anyone but the owner
// (signed out included) → 404; the owner → the checklist with the fake services (TEST MODE banner,
// statuses, one-tap fixes, copy buttons, no secrets). The dashboard shows a Setup link to the owner
// only, and a footer with the legal links.

import { renderToStaticMarkup } from 'react-dom/server'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { SetupView } from '@/components/setup/setup-view'
import { setupAccess, isOwner, ownerEmailOf } from '@/lib/server/owner'
import { setUiOverridesForTests } from '@/lib/ui/runtime'
import type { SetupReport } from '@/lib/ui/setup'
import { agoText } from '@/lib/ui/setup'
import { createHarness, type Harness } from '../api/harness'
import { createUiHarness, type UiHarness } from '../ui/harness'
import { createFakeStripe } from './fake-stripe'

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => undefined, set: () => undefined, getAll: () => [] }) }))
vi.mock('next/navigation', () => ({
  usePathname: () => '/app',
  useRouter: () => ({ refresh() {} }),
  notFound: () => {
    throw Object.assign(new Error('NEXT_HTTP_ERROR_FALLBACK;404'), { digest: 'NEXT_HTTP_ERROR_FALLBACK;404' })
  },
  redirect: (url: string) => {
    throw Object.assign(new Error('NEXT_REDIRECT'), { digest: `NEXT_REDIRECT;replace;${url};307;` })
  },
}))

const decode = (html: string) => html.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
const SESSION = 'test-session-secret-0123456789abcdef'
const STRIPE_KEY = 'sk_test_pagekey_SECRET_0123456789'

let h: Harness
beforeAll(async () => {
  h = await createHarness({ env: { OWNER_EMAIL: 'owner@example.com', STRIPE_SECRET_KEY: STRIPE_KEY } })
})
afterAll(async () => {
  setUiOverridesForTests(null)
  await h.close()
})
beforeEach(() => {
  h.install({ stripeAdmin: createFakeStripe().api })
})

async function renderSetup(): Promise<string> {
  const { default: SetupPage } = await import('@/app/setup/page')
  return decode(renderToStaticMarkup(await SetupPage()))
}

describe('owner gating', () => {
  it('matches OWNER_EMAIL case-insensitively and never without it', () => {
    expect(ownerEmailOf({ OWNER_EMAIL: ' Owner@Example.COM ' })).toBe('owner@example.com')
    expect(ownerEmailOf({})).toBeNull()
    expect(isOwner({ email: 'OWNER@example.com' }, 'owner@example.com')).toBe(true)
    expect(isOwner({ email: 'other@example.com' }, 'owner@example.com')).toBe(false)
    expect(isOwner(null, 'owner@example.com')).toBe(false)
    expect(isOwner({ email: 'owner@example.com' }, null)).toBe(false)
    expect(setupAccess(null, null)).toEqual({ kind: 'unset' })
    expect(setupAccess(null, 'owner@example.com')).toEqual({ kind: 'denied' })
  })

  it('is a 404 for another user and for a signed-out visitor', async () => {
    setUiOverridesForTests({ user: { id: '00000000-0000-4000-8000-000000000001', email: 'someone@example.com' } })
    await expect(renderSetup()).rejects.toMatchObject({ digest: 'NEXT_HTTP_ERROR_FALLBACK;404' })
    setUiOverridesForTests({ user: null })
    await expect(renderSetup()).rejects.toMatchObject({ digest: 'NEXT_HTTP_ERROR_FALLBACK;404' })
  })

  it('only explains how to set OWNER_EMAIL when it is unset', async () => {
    const { createServicesFromEnv } = await import('@app/services')
    const { silentLogger } = await import('@app/core/log')
    const rt = await createServicesFromEnv({ ...h.env, OWNER_EMAIL: '' }, { db: h.db, clock: h.clock, logger: silentLogger, withoutTranscriber: true })
    h.install({ runtime: rt })
    setUiOverridesForTests({ user: null })
    const html = await renderSetup()
    expect(html).toContain('Setup is locked')
    expect(html).toContain('OWNER_EMAIL')
    expect(html).toContain('Environment Variables')
    expect(html).not.toContain('Launch setup')
  })
})

describe('the owner’s checklist', () => {
  it('renders every group with the fake services, the TEST MODE banner and the fixes, without secrets', async () => {
    const owner = await h.createUser('owner@example.com')
    setUiOverridesForTests({ user: { id: owner.id, email: 'Owner@Example.com' } })
    const html = await renderSetup()
    expect(html).toContain('Launch setup')
    expect(html).toContain('TEST MODE: posts are not really published.')
    for (const title of ['Basics', 'Database', 'Sign-in', 'File storage', 'Posting', 'Billing (Stripe)', 'Transcription', 'Workers (Railway)', 'Email and legal pages', 'Connect your AI']) {
      expect(html).toContain(`>${title}<`)
    }
    expect(html).toContain('data-check="database.migrations" data-status="ok"')
    expect(html).toContain('data-check="workers.posting" data-status="unset"')
    expect(html).toContain('Create missing products and prices')
    expect(html).toContain('Set up billing portal')
    expect(html).toContain('Copy MCP URL')
    expect(html).toContain('http://localhost:3000/api/mcp')
    expect(html).toContain('href="/privacy"')
    for (const secret of [STRIPE_KEY, SESSION, 'cron-secret-0123456789abcdef', 'whsec_test_0123456789abcdef', 'upload-post-webhook-secret-0123']) {
      expect(html).not.toContain(secret)
    }
  })
})

describe('SetupView', () => {
  const noop = async () => ({ ok: true, message: '', at: 0 })
  const report: SetupReport = {
    generatedAt: '2026-11-02T15:00:00.000Z',
    testMode: false,
    appEnv: 'production',
    counts: { ok: 1, attention: 1, unset: 1 },
    groups: [
      {
        id: 'storage',
        title: 'File storage',
        checks: [
          { id: 'storage.bucket', title: 'File storage (Cloudflare R2)', status: 'ok', summary: 'Bucket media is reachable.' },
          {
            id: 'storage.cors',
            title: 'Browser uploads (CORS)',
            status: 'attention',
            summary: 'No CORS rule allows https://app.example.com.',
            fix: 'Tap “Fix storage CORS”.',
            action: { id: 'fix_storage_cors', label: 'Fix storage CORS', note: 'Allows uploads.' },
            copies: [{ label: 'Copy CORS policy', value: '[{"AllowedOrigins":["https://app.example.com"]}]' }],
          },
          { id: 'legal.support_email', title: 'Support email', status: 'unset', summary: 'SUPPORT_EMAIL is not set.' },
        ],
      },
    ],
  }

  it('shows statuses, how to fix, the button and the copy button; no test banner in live mode', () => {
    const html = decode(
      renderToStaticMarkup(
        <SetupView report={report} ownerEmail="owner@example.com" actions={{ fix_storage_cors: noop, create_stripe_catalog: noop, create_stripe_webhook: noop, setup_billing_portal: noop }} />,
      ),
    )
    expect(html).toContain('Only you (owner@example.com) can see this page')
    expect(html).not.toContain('TEST MODE')
    expect(html).toContain('>OK<')
    expect(html).toContain('>Needs attention<')
    expect(html).toContain('>Not set<')
    expect(html).toContain('How to fix: </span>Tap “Fix storage CORS”.')
    expect(html).toContain('<button type="submit"')
    expect(html).toContain('Fix storage CORS')
    expect(html).toContain('Copy CORS policy')
    expect(html).toContain('1 OK')
    expect(html).toContain('1 need attention')
  })

  it('says how long ago in plain words', () => {
    expect(agoText(1)).toBe('1 second ago')
    expect(agoText(42)).toBe('42 seconds ago')
    expect(agoText(300)).toBe('5 minutes ago')
    expect(agoText(7200)).toBe('2 hours ago')
    expect(agoText(3 * 86_400)).toBe('3 days ago')
  })
})

describe('dashboard navigation and footer', () => {
  let ui: UiHarness
  beforeAll(async () => {
    ui = await createUiHarness()
  })
  afterAll(async () => {
    await ui.close()
  })

  async function layoutFor(email: string, ownerEmail: string | null) {
    const t = await ui.tenant({ email })
    setUiOverridesForTests({ runtime: { ...ui.ui, ownerEmail }, user: { id: t.userId, email } })
    const { default: AppLayout } = await import('@/app/app/layout')
    return decode(renderToStaticMarkup(await AppLayout({ children: <p>child</p> })))
  }

  it('links to /setup for the owner only, and shows the legal links', async () => {
    const owner = await layoutFor('boss@example.com', 'boss@example.com')
    expect(owner).toContain('href="/setup"')
    for (const href of ['/privacy', '/terms', '/contact']) expect(owner).toContain(`href="${href}"`)
    const member = await layoutFor('member@example.com', 'boss@example.com')
    expect(member).not.toContain('href="/setup"')
    expect(member).toContain('href="/privacy"')
    const nobody = await layoutFor('solo@example.com', null)
    expect(nobody).not.toContain('href="/setup"')
  })
})
