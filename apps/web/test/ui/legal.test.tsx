// The legal pages (/privacy, /terms, /contact): configured values, obvious placeholders when a
// value is missing, the content Stripe and the connector directories ask for, and the footer links
// on the landing page, sign-in, the dashboard and the OAuth consent page.

import { renderToStaticMarkup } from 'react-dom/server'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { SOURCE_LIMITS } from '@app/core/plans'
import { LoginView } from '@/components/app/login-view'
import { ContactPage } from '@/components/legal/contact'
import { PROCESSORS, PrivacyPolicy } from '@/components/legal/privacy'
import { REFUNDS_HEADING, TermsOfService } from '@/components/legal/terms'
import { LandingPage } from '@/components/marketing/landing'
import { setServerOverridesForTests } from '@/lib/server/deps'
import { legalInfoFromEnv } from '@/lib/server/legal'
import { formatEffectiveDate, legalInfo, placeholder } from '@/lib/ui/legal'
import { createHarness, type Harness } from '../api/harness'

vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => undefined, set: () => undefined, getAll: () => [] }) }))
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw Object.assign(new Error('NEXT_REDIRECT'), { digest: `NEXT_REDIRECT;replace;${url};307;` })
  },
}))

const decode = (html: string) => html.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')

const CONFIGURED = {
  LEGAL_ENTITY_NAME: 'Acme Studio LLC',
  SUPPORT_EMAIL: 'help@acme.example',
  LEGAL_JURISDICTION: 'the State of Delaware, United States',
  LEGAL_EFFECTIVE_DATE: '2026-11-01',
  APP_URL: 'https://app.acme.example',
}

const FOOTER = ['href="/privacy"', 'href="/terms"', 'href="/contact"']

describe('legalInfo', () => {
  it('uses configured values and formats the date', () => {
    const info = legalInfo(CONFIGURED)
    expect(info).toMatchObject({ entityName: 'Acme Studio LLC', supportEmail: 'help@acme.example', hasSupportEmail: true, effectiveDate: 'November 1, 2026', missing: [] })
    expect(formatEffectiveDate('2026-02-30')).toBe('2026-02-30')
    expect(formatEffectiveDate('soon')).toBe('soon')
  })

  it('shows "[set NAME]" for every missing value', () => {
    const info = legalInfo({})
    expect(info.missing).toEqual(['LEGAL_ENTITY_NAME', 'SUPPORT_EMAIL', 'LEGAL_JURISDICTION', 'LEGAL_EFFECTIVE_DATE'])
    expect(info.supportEmail).toBe('[set SUPPORT_EMAIL]')
    expect(info.hasSupportEmail).toBe(false)
    expect(placeholder('LEGAL_ENTITY_NAME')).toBe('[set LEGAL_ENTITY_NAME]')
  })

  it('reads the environment, and falls back to placeholders when the configuration is broken', () => {
    expect(legalInfoFromEnv(CONFIGURED).entityName).toBe('Acme Studio LLC')
    expect(legalInfoFromEnv({ ...CONFIGURED, LOG_LEVEL: 'shout' }).entityName).toBe('[set LEGAL_ENTITY_NAME]')
  })
})

describe('privacy policy', () => {
  it('names the provider, the data, the processors, retention, deletion, cookies, AI and age', () => {
    const html = decode(renderToStaticMarkup(<PrivacyPolicy info={legalInfo(CONFIGURED)} />))
    expect(html).toContain('Acme Studio LLC')
    expect(html).toContain('href="mailto:help@acme.example?subject=Privacy"')
    expect(html).toContain('November 1, 2026')
    for (const p of PROCESSORS) expect(html).toContain(p.name)
    for (const name of ['Supabase', 'Vercel', 'Railway', 'Cloudflare R2', 'Upload-Post', 'Stripe', 'AssemblyAI', 'email provider']) expect(html).toContain(name)
    expect(html).toContain('held by Upload-Post, not by us')
    expect(html).toContain('one-way hashes')
    expect(html).toContain('We do not train AI models')
    expect(html).toContain(`${SOURCE_LIMITS.retentionDays} days after upload`)
    expect(html).toContain('mailto:help@acme.example?subject=Delete%20my%20account')
    expect(html).toMatch(/only the cookies needed to keep you signed in/)
    expect(html).toContain('aged 18 or older')
    expect(html).not.toContain('[set ')
    for (const link of FOOTER) expect(html).toContain(link)
  })

  it('shows placeholders when nothing is configured', () => {
    const html = decode(renderToStaticMarkup(<PrivacyPolicy info={legalInfo({})} />))
    expect(html).toContain('[set LEGAL_ENTITY_NAME]')
    expect(html).toContain('[set SUPPORT_EMAIL]')
    expect(html).toContain('[set LEGAL_EFFECTIVE_DATE]')
    expect(html).not.toContain('mailto:')
  })
})

describe('terms of service', () => {
  it('covers subscriptions, cancellation and refunds, acceptable use, Auto-post, liability and governing law', () => {
    const html = decode(renderToStaticMarkup(<TermsOfService info={legalInfo(CONFIGURED)} />))
    expect(html).toContain(REFUNDS_HEADING)
    expect(html).toContain('renew automatically every month until you cancel')
    expect(html).toContain('Billing → Manage billing')
    expect(html).toContain('you keep access until the end of the period you already paid for')
    expect(html).toContain('No refunds for partial months')
    expect(html).toContain('Starter $8, Plus $15, Pro $25')
    expect(html).toContain('Only your own content.')
    expect(html).toContain('Do not repost other people’s videos')
    expect(html).toContain('Follow each platform’s rules.')
    expect(html).toContain('whether you approved it yourself or Auto-post did')
    expect(html).toContain('Limitation of liability')
    expect(html).toContain('the laws of the State of Delaware, United States')
    expect(html).toContain('at least 18 years old')
    expect(html).not.toContain('[set ')
  })

  it('shows placeholders when nothing is configured', () => {
    const html = decode(renderToStaticMarkup(<TermsOfService info={legalInfo({})} />))
    expect(html).toContain('the laws of <mark')
    expect(html).toContain('[set LEGAL_JURISDICTION]')
    expect(html).toContain('[set LEGAL_ENTITY_NAME]')
  })
})

describe('contact page', () => {
  it('lists support, deletion, billing, copyright and security contacts', () => {
    const html = decode(renderToStaticMarkup(<ContactPage info={legalInfo(CONFIGURED)} />))
    for (const subject of ['Support', 'Delete my account', 'Billing', 'Copyright notice', 'Security']) {
      expect(html).toContain(`mailto:help@acme.example?subject=${encodeURIComponent(subject)}`)
    }
    expect(html).toContain('good faith')
    expect(decode(renderToStaticMarkup(<ContactPage info={legalInfo({})} />))).toContain('[set SUPPORT_EMAIL]')
  })
})

describe('the routes read the environment', () => {
  afterAll(() => setServerOverridesForTests(null))

  it('/privacy, /terms and /contact render with configured values and with placeholders', async () => {
    const pages = [(await import('@/app/privacy/page')).default, (await import('@/app/terms/page')).default, (await import('@/app/contact/page')).default]
    setServerOverridesForTests({ env: CONFIGURED })
    for (const Page of pages) {
      const html = decode(renderToStaticMarkup(<Page />))
      expect(html).toContain('Acme Studio LLC')
      expect(html).not.toContain('[set ')
    }
    setServerOverridesForTests({ env: {} })
    for (const Page of pages) expect(decode(renderToStaticMarkup(<Page />))).toContain('[set SUPPORT_EMAIL]')
  })
})

describe('footer links', () => {
  it('on the landing page and the sign-in page', () => {
    const landing = renderToStaticMarkup(<LandingPage year={2026} />)
    const login = renderToStaticMarkup(<LoginView next="/app" sent={false} error={null} devAuth={false} magicLink />)
    for (const link of FOOTER) {
      expect(landing).toContain(link)
      expect(login).toContain(link)
    }
  })

  describe('on the OAuth consent page', () => {
    let h: Harness
    beforeAll(async () => {
      h = await createHarness()
    })
    afterAll(async () => {
      await h.close()
    })

    it('shows them under the request (here: an unknown app)', async () => {
      const { default: AuthorizePage } = await import('@/app/oauth/authorize/page')
      const html = decode(renderToStaticMarkup(await AuthorizePage({ searchParams: Promise.resolve({ response_type: 'code', client_id: 'unknown-client' }) })))
      expect(html).toContain('cannot be completed')
      for (const link of FOOTER) expect(html).toContain(link)
    })
  })
})
