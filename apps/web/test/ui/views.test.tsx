// Dashboard views rendered with react-dom/server from data loaded through the real loaders
// (PGlite-backed services).

import { renderToStaticMarkup } from 'react-dom/server'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { DRIVE_HOSTS, SOURCE_URL_MESSAGES } from '@app/core/links'
import { PLATFORMS, PLATFORM_LABELS } from '@app/core/types'
import { IDLE } from '@/lib/ui/action-result'
import { AccountsView } from '@/components/app/accounts'
import { AnalyticsView } from '@/components/app/analytics'
import { BillingView } from '@/components/app/billing'
import { BrandsView } from '@/components/app/brands'
import { CalendarView } from '@/components/app/calendar'
import { ClipsView } from '@/components/app/clips'
import { ConnectView, cursorConfig } from '@/components/app/connect'
import { MediaView } from '@/components/app/media'
import { OverviewView } from '@/components/app/overview'
import { VoiceView, samplesToText } from '@/components/app/voice'
import {
  loadAccounts,
  loadAnalytics,
  loadBilling,
  loadBrands,
  loadCalendar,
  loadClips,
  loadConnections,
  loadMedia,
  loadOverview,
  loadVoice,
} from '@/lib/ui/data'
import { PRODUCT_SLUG } from '@/lib/ui/brand'
import { createUiHarness, NOW, type UiHarness } from './harness'

vi.mock('next/navigation', () => ({ usePathname: () => '/app', useRouter: () => ({ refresh() {} }), redirect: vi.fn() }))

const noop = async () => IDLE
let h: UiHarness

function decode(html: string): string {
  return html.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
}

beforeAll(async () => {
  h = await createUiHarness()
})
afterAll(async () => {
  await h.close()
})

async function scheduledTenant() {
  const t = await h.tenant({ platforms: ['x', 'threads'] })
  const view = await h.services.drafts.create(t.userId, { brandId: t.brandId, variants: [{ platform: 'x', text: 'Calendar post text' }] }, { via: 'mcp' })
  const { nonce } = await h.services.approvals.issueNonce(t.userId, view.draft.id, { via: 'web' })
  await h.services.approvals.decide(t.userId, { draftId: view.draft.id, nonce, decision: 'approve' }, { via: 'web' })
  await h.services.posts.schedule(t.userId, { draftId: view.draft.id, at: '2026-11-03T14:30:00Z' }, { via: 'web' })
  await h.services.drafts.create(t.userId, { brandId: t.brandId, variants: [{ platform: 'threads', text: 'Waiting for approval' }] }, { via: 'mcp' })
  return t
}

describe('OverviewView', () => {
  it('shows meters, the approval queue and upcoming posts', async () => {
    const t = await scheduledTenant()
    const data = await loadOverview(h.services, t.userId, NOW)
    expect(data.awaiting).toHaveLength(1)
    expect(data.upcoming).toHaveLength(1)
    const html = decode(renderToStaticMarkup(<OverviewView data={data} />))
    expect(html).toContain('Clipping hours')
    expect(html).toContain('0 h of 20 h')
    expect(html).toContain('1 of 4')
    expect(html).toContain('Waiting for approval')
    expect(html).toContain(`/app/approvals?draft=${data.awaiting[0]?.draft.id}`)
    expect(html).toContain('Calendar post text')
    expect(html).toContain('<meter')
    // checklist: brand + accounts done, AI not connected yet
    expect(html).toContain('Add the server to Claude, ChatGPT or Cursor')
  })
})

describe('BrandsView', () => {
  it('shows the limit and disables creation at the limit', async () => {
    const t = await h.tenant({ plan: 'starter', platforms: ['x'] })
    const data = await loadBrands(h.services, t.userId)
    const html = decode(renderToStaticMarkup(<BrandsView data={data} actions={{ create: noop, update: noop, archive: noop, restore: noop, autoPost: noop }} />))
    expect(html).toContain('1 of 1')
    expect(html).toContain('You are using all 1 brand on your plan')
    expect(html).toMatch(/<button type="submit"[^>]*disabled=""[^>]*>Create brand<\/button>/)
    expect(html).toContain('Acme Studio')
    expect(html).toContain('1 connected account')
    expect(html).toContain('accounts are disconnected')
  })
})

describe('AccountsView', () => {
  it('lists all nine platforms with connect / disconnect', async () => {
    const t = await h.tenant({ platforms: ['instagram'] })
    const brand = await h.services.brands.get(t.userId, t.brandId)
    const { slots, connected } = await loadAccounts(h.services, t.userId, t.brandId)
    const html = decode(renderToStaticMarkup(<AccountsView brand={brand} slots={slots} connected={connected} actions={{ connect: noop, sync: noop, disconnect: noop }} />))
    for (const p of PLATFORMS) expect(html).toContain(PLATFORM_LABELS[p])
    expect(html).toContain('@acme_instagram')
    expect(html.match(/>Connect<span class="sr-only">/g)?.length).toBe(8)
    expect(html).toContain('Disconnect<span class="sr-only"> Instagram')
  })

  it('asks for a brand first', () => {
    const html = renderToStaticMarkup(<AccountsView brand={null} slots={[]} connected={0} actions={{ connect: noop, sync: noop, disconnect: noop }} />)
    expect(html).toContain('Create a brand first')
  })
})

describe('MediaView', () => {
  it('shows the upload form with the rights checkbox, allowed drive hosts and the YouTube refusal', async () => {
    const t = await h.tenant({ platforms: [] })
    const imageId = await h.image(t.userId, t.brandId)
    const page = await loadMedia(h.services, t.userId)
    const html = decode(
      renderToStaticMarkup(
        <MediaView items={page.items} nextCursor={null} brands={[{ id: t.brandId, name: 'Acme Studio' }]} defaultBrandId={t.brandId} actions={{ addDriveLink: noop, remove: noop }} />,
      ),
    )
    expect(html).toContain('I own this content or have the rights to use it.')
    expect(html).toContain('I own this video or have the rights to use it.')
    for (const host of Object.values(DRIVE_HOSTS).flat()) expect(html).toContain(host)
    expect(html).toContain(SOURCE_URL_MESSAGES.video_site_forbidden)
    expect(html).toContain('Image')
    expect(html).toContain('/api/dev-storage/')
    // review: the AI needs media ids for images and audio; the page shows them to copy
    expect(html).toContain('Media id (for your AI assistant)')
    expect(html).toContain(String(imageId))
  })
})

describe('CalendarView', () => {
  it('groups posts by day in the brand time zone', async () => {
    const t = await scheduledTenant()
    const data = await loadCalendar(h.services, t.userId, { view: 'week', anchorKey: '2026-11-02', brandId: t.brandId, timezone: 'America/New_York', includeCanceled: false, now: NOW })
    expect(data.days.map((d) => d.key)).toEqual(['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07', '2026-11-08'])
    expect(data.days[1]?.items).toHaveLength(1)
    const html = decode(
      renderToStaticMarkup(<CalendarView data={data} actions={{ reschedule: noop, cancel: noop }} brands={[{ id: t.brandId, name: 'Acme Studio' }]} brandFilter={t.brandId} includeCanceled={false} />),
    )
    expect(html).toContain('Tuesday, Nov 3')
    expect(html).toContain('9:30 AM')
    expect(html).toContain('Calendar post text')
    expect(html).toContain('Reschedule')
    expect(html).toContain('Cancel post')
    expect(html).toContain('Times are shown in America/New York.')

    const month = await loadCalendar(h.services, t.userId, { view: 'month', anchorKey: '2026-11-17', brandId: null, timezone: 'UTC', includeCanceled: true, now: NOW })
    expect(month.range.startKey).toBe('2026-11-01')
    expect(month.range.endKey).toBe('2026-12-01')
    expect(month.prevKey).toBe('2026-10-01')
    expect(month.total).toBe(1)
  })
})

describe('ConnectView', () => {
  it('shows the MCP URL and setup for Claude, ChatGPT and Cursor', async () => {
    const t = await h.tenant({ platforms: [] })
    const connections = await loadConnections(h.services, t.userId)
    const html = decode(renderToStaticMarkup(<ConnectView mcpUrl={h.ui.mcpUrl} connections={connections} revoke={noop} timezone="UTC" />))
    expect(html).toContain('http://localhost:3000/api/mcp')
    expect(html).toContain('Add custom connector')
    expect(html).toContain('Developer mode')
    expect(html).toContain('mcp.json')
    expect(JSON.parse(cursorConfig(h.ui.mcpUrl))).toEqual({ mcpServers: { [PRODUCT_SLUG]: { url: 'http://localhost:3000/api/mcp' } } })
    expect(html).toContain('No AI app connected yet')
  })
})

describe('BillingView', () => {
  it('offers checkout without a subscription and the portal with one', async () => {
    const trial = await h.tenant({ plan: 'starter', subscriptionStatus: 'trialing', trialEndsAt: new Date(NOW.getTime() + 3 * 86_400_000), platforms: [] })
    const data = await loadBilling(h.services, trial.userId)
    const html = decode(renderToStaticMarkup(<BillingView data={data} notice="canceled" />))
    expect(html).toContain('Starter (free trial)')
    expect(html).toContain('action="/api/stripe/checkout"')
    expect(html).toContain('name="extraBrands"')
    expect(html).toContain('name="extraClipHours"')
    expect(html).toContain('Checkout was canceled')
    expect(html).toContain('1 h of clipping a month')

    const paying = await h.tenant({ plan: 'plus', subscriptionStatus: 'active', stripeCustomerId: 'cus_test123', platforms: [] })
    await h.db.query(`update users set stripe_subscription_id = 'sub_test123', extra_brands = 1 where id = $1`, [paying.userId])
    const paid = await loadBilling(h.services, paying.userId)
    const html2 = decode(renderToStaticMarkup(<BillingView data={paid} notice={null} />))
    expect(html2).toContain('action="/api/stripe/portal"')
    expect(html2).not.toContain('action="/api/stripe/checkout"')
    expect(html2).toContain('$18/month')
  })
})

describe('VoiceView', () => {
  it('prefills the form and the JSON editor from the saved profile', async () => {
    const t = await h.tenant({ platforms: [] })
    await h.services.voice.save(
      t.userId,
      { brandId: t.brandId, profile: { tone: 'Dry humour', vocabulary: ['ship it'], sample_posts: [{ platform: 'x', text: 'We shipped.' }] } },
      { via: 'web' },
    )
    const brand = await h.services.brands.get(t.userId, t.brandId)
    const data = await loadVoice(h.services, t.userId, t.brandId)
    const html = decode(renderToStaticMarkup(<VoiceView brand={brand} data={data} actions={{ save: noop, saveJson: noop }} />))
    expect(html).toContain('Dry humour')
    expect(html).toContain('ship it')
    expect(html).toContain('[x] We shipped.')
    expect(html).toContain('"emoji_policy": "sparing"')
    expect(html).toContain('Version 1')
    expect(samplesToText([{ text: 'a' }, { platform: 'x', text: 'b' }])).toBe('a\n---\n[x] b')
  })
})

describe('ClipsView and AnalyticsView', () => {
  it('render their empty states', async () => {
    const t = await h.tenant({ platforms: [] })
    const clips = renderToStaticMarkup(<ClipsView data={await loadClips(h.services, t.userId)} requestClip={noop} />)
    expect(clips).toContain('No videos to clip yet')
    const brand = await h.services.brands.get(t.userId, t.brandId)
    const reviews = await loadAnalytics(h.services, t.userId, [brand])
    const html = decode(renderToStaticMarkup(<AnalyticsView reviews={reviews} showingAll={false} selectedBrandName={null} />))
    expect(html).toContain('Acme Studio')
    expect(html).toContain('No published posts in this period.')
    expect(renderToStaticMarkup(<AnalyticsView reviews={[]} showingAll={false} selectedBrandName={null} />)).toContain('No brands yet')
  })
})
