// Landing page, pricing table (must match @app/core/plans) and the login screen.

import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ADD_ONS, ADD_ON_KEYS, GB, PLANS, TRIAL, formatCents } from '@app/core/plans'
import { PLAN_TIERS, PLATFORMS, PLATFORM_LABELS } from '@app/core/types'
import { LoginView, LOGIN_ERROR_MESSAGES } from '@/components/app/login-view'
import { FAQ_ITEMS, LandingPage } from '@/components/marketing/landing'
import { PricingTable, planFeatures } from '@/components/marketing/pricing-table'
import { PRODUCT_NAME } from '@/lib/ui/brand'

function decode(html: string): string {
  return html.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
}

function planBlock(html: string, tier: string): string {
  const start = html.indexOf(`data-plan="${tier}"`)
  const end = html.indexOf('</li>', html.indexOf('</ul>', start))
  return html.slice(start, end)
}

describe('PricingTable', () => {
  const html = decode(renderToStaticMarkup(<PricingTable />))

  it('shows every plan with the price, brands, clipping hours and storage from @app/core/plans', () => {
    expect(PLAN_TIERS).toEqual(['starter', 'plus', 'pro'])
    for (const tier of PLAN_TIERS) {
      const plan = PLANS[tier]
      const block = planBlock(html, tier)
      expect(block).toContain(plan.name)
      expect(block).toContain(`data-testid="price">${formatCents(plan.priceCents)}<`)
      expect(block).toContain(`${plan.brands} brand${plan.brands === 1 ? '' : 's'}`)
      expect(block).toContain(`${plan.clipHours} clipping hours a month`)
      expect(block).toContain(`${plan.storageBytes / GB} GB media storage`)
    }
    // the product's published prices
    expect(planBlock(html, 'starter')).toContain('>$8<')
    expect(planBlock(html, 'plus')).toContain('>$15<')
    expect(planBlock(html, 'pro')).toContain('>$25<')
    expect(planFeatures('pro')).toContain('4 brands')
    expect(planFeatures('plus')).toContain('10 clipping hours a month')
  })

  it('lists the add-ons and the trial', () => {
    for (const key of ADD_ON_KEYS) {
      expect(html).toContain(ADD_ONS[key].name)
      expect(html).toContain(`${formatCents(ADD_ONS[key].priceCents)}/month each`)
    }
    expect(html).toContain('$3/month each')
    expect(html).toContain('$1/month each')
    expect(html).toContain(`free ${TRIAL.days}-day trial of ${PLANS[TRIAL.plan].name} with ${TRIAL.clipHours} clipping hour`)
  })

  it('every plan links to sign-up', () => {
    expect(html.match(/href="\/login"/g)?.length).toBe(3)
  })
})

describe('LandingPage', () => {
  const html = decode(renderToStaticMarkup(<LandingPage year={2026} />))

  it('explains the product and links to /login', () => {
    expect(html).toContain('Your AI runs your social media.')
    expect(html).toContain(PRODUCT_NAME)
    for (const ai of ['Claude', 'ChatGPT', 'Cursor']) expect(html).toContain(ai)
    expect(html).toContain('Long videos into shorts')
    expect(html).toContain('Writes in your voice')
    expect(html).toContain('Weekly review')
    expect(html).toContain('MCP')
    expect(html).toContain('href="/login"')
    expect(html).toContain('id="main"')
  })

  it('lists all nine platforms, the pricing and the FAQ', () => {
    expect(PLATFORMS).toHaveLength(9)
    for (const p of PLATFORMS) expect(html).toContain(PLATFORM_LABELS[p])
    expect(html).toContain('id="pricing"')
    for (const item of FAQ_ITEMS) {
      expect(html).toContain(item.q)
      expect(html).toContain(item.a)
    }
    expect(html).toContain('<summary')
  })

  it('loads no external fonts, scripts or images', () => {
    expect(html).not.toMatch(/(src|href)="https?:\/\//)
  })
})

describe('LoginView', () => {
  it('shows the magic-link form, passing ?next= through', () => {
    const html = renderToStaticMarkup(<LoginView next="/app/approvals?draft=abc" sent={false} error={null} devAuth={false} magicLink />)
    expect(html).toContain('action="/api/auth/magic-link"')
    expect(html).toContain('name="next" value="/app/approvals?draft=abc"')
    expect(html).not.toContain('/api/auth/dev-login')
  })

  it('shows the dev login only with DEV_AUTH, and the sent / error notices', () => {
    const html = renderToStaticMarkup(<LoginView next="/app" sent error="link_expired" devAuth magicLink={false} />)
    expect(html).toContain('action="/api/auth/dev-login"')
    expect(html).not.toContain('/api/auth/magic-link')
    expect(html).toContain('Check your email')
    expect(decode(html)).toContain(LOGIN_ERROR_MESSAGES.link_expired)
  })

  it('says when no sign-in method is configured', () => {
    const html = renderToStaticMarkup(<LoginView next="/app" sent={false} error={null} devAuth={false} magicLink={false} />)
    expect(html).toContain('Email sign-in is not configured')
    expect(html).not.toContain('<form')
  })
})
