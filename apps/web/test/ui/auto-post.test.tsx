// Auto-post in the web app: the Brands page switch (server action, owner only, via 'web'), the
// "Auto-posted" badge in the calendar and the approval queue, and the Connect page's Claude Code
// command and pipeline explanation. PGlite-backed services, fake provider, memory storage.

import { randomUUID } from 'node:crypto'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { IDLE } from '@/lib/ui/action-result'
import { setAutoPost } from '@/lib/ui/actions/settings'
import { loadApprovals, loadBrands, loadCalendar, loadConnections } from '@/lib/ui/data'
import { ApprovalsView, type ApprovalActions } from '@/components/app/approvals'
import { AUTO_POST_WARNING, BrandsView } from '@/components/app/brands'
import { CalendarView } from '@/components/app/calendar'
import { ConnectView, claudeCodeCommand } from '@/components/app/connect'
import { PRODUCT_SLUG } from '@/lib/ui/brand'
import { createUiHarness, form, NOW, type UiHarness } from './harness'

const revalidatePath = vi.fn()
vi.mock('next/cache', () => ({ revalidatePath: (...args: unknown[]) => revalidatePath(...args) }))
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => undefined, set: () => undefined }) }))
vi.mock('next/navigation', () => ({ usePathname: () => '/app', useRouter: () => ({ refresh() {} }), redirect: vi.fn() }))

const noop = async () => IDLE
const approvalActions: ApprovalActions = { approve: noop, reject: noop, edit: noop, schedule: noop, reopen: noop, archive: noop, cancelPost: noop }

let h: UiHarness
beforeAll(async () => {
  h = await createUiHarness()
})
afterAll(async () => {
  await h.close()
})

function decode(html: string): string {
  return html.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
}

async function readyVideo(userId: string, brandId: string) {
  const { bindRepos } = await import('@app/db')
  return bindRepos(h.db).media.create(userId, {
    brandId,
    kind: 'video',
    origin: 'render',
    status: 'ready',
    storageKey: `users/${userId}/renders/${randomUUID()}.mp4`,
    mimeType: 'video/mp4',
    bytes: 1_000,
    durationMs: 12_000,
    width: 1080,
    height: 1920,
  })
}

describe('Auto-post switch (server action)', () => {
  it('turns Auto-post on and off for the signed-in owner, with platforms, daily limit and TikTok privacy', async () => {
    const t = await h.tenant({ platforms: ['tiktok', 'youtube'] })
    const on = await setAutoPost(h.services, t.userId, form({ brandId: t.brandId, enabled: 'on', platforms: ['tiktok', 'youtube', 'nonsense'], dailyMax: '5', tiktokPrivacy: 'FOLLOWER_OF_CREATOR' }))
    expect(on).toMatchObject({ ok: true })
    expect(on.message).toContain('Auto-post is on for “Acme Studio” (TikTok, YouTube, up to 5 a day)')
    expect(await h.services.brands.get(t.userId, t.brandId)).toMatchObject({
      autoPostEnabled: true,
      autoPostPlatforms: ['tiktok', 'youtube'],
      autoPostDailyMax: 5,
      autoPostTiktokPrivacy: 'FOLLOWER_OF_CREATOR',
    })
    const audit = await h.services.audit.list(t.userId, { subjectId: t.brandId })
    expect(audit[0]).toMatchObject({ actor: 'web', action: 'brand.auto_post_enabled' })

    const off = await setAutoPost(h.services, t.userId, form({ brandId: t.brandId, dailyMax: '5' }))
    expect(off.message).toContain('Auto-post is off')
    expect((await h.services.brands.get(t.userId, t.brandId)).autoPostEnabled).toBe(false)
  })

  it('is owner only: another user\'s brand is not found and nothing changes', async () => {
    const owner = await h.tenant({ platforms: ['tiktok'] })
    const intruder = await h.tenant({ platforms: [] })
    const r = await setAutoPost(h.services, intruder.userId, form({ brandId: owner.brandId, enabled: 'on', dailyMax: '3' }))
    expect(r.ok).toBe(false)
    expect(r.message).toMatch(/not found/i)
    expect((await h.services.brands.get(owner.userId, owner.brandId)).autoPostEnabled).toBe(false)
    // and the AI's channel can never flip it
    await expect(h.services.brands.setAutoPost(owner.userId, owner.brandId, { enabled: true }, { via: 'mcp' })).rejects.toMatchObject({ code: 'forbidden' })
  })

  it('validates the daily limit and needs a brand', async () => {
    const t = await h.tenant({ platforms: [] })
    expect(await setAutoPost(h.services, t.userId, form({ brandId: t.brandId, enabled: 'on', dailyMax: '0' }))).toMatchObject({ ok: false })
    expect(await setAutoPost(h.services, t.userId, form({ brandId: t.brandId, enabled: 'on', dailyMax: 'lots' }))).toMatchObject({ ok: false })
    expect(await setAutoPost(h.services, t.userId, form({ enabled: 'on' }))).toMatchObject({ ok: false, message: expect.stringMatching(/out of date/) })
  })
})

describe('Auto-post in the pages', () => {
  it('the Brands page shows the switch, the platforms, the daily limit and the warning', async () => {
    const t = await h.tenant({ platforms: ['tiktok'] })
    await h.services.brands.setAutoPost(t.userId, t.brandId, { enabled: true, platforms: ['tiktok'], dailyMax: 4 }, { via: 'web' })
    const data = await loadBrands(h.services, t.userId)
    expect(data.platformsByBrand[t.brandId]).toEqual(['tiktok'])
    const html = decode(renderToStaticMarkup(<BrandsView data={data} actions={{ create: noop, update: noop, archive: noop, restore: noop, autoPost: noop }} />))
    expect(html).toContain(AUTO_POST_WARNING)
    expect(html).toContain('On: posts without asking')
    const tag = (re: RegExp) => html.match(re)?.[0] ?? ''
    const toggle = tag(/<input[^>]*name="enabled"[^>]*>/)
    expect(toggle).toContain('type="checkbox"')
    expect(toggle).toContain('role="switch"')
    expect(toggle).toContain('checked=""')
    expect(tag(/<input[^>]*name="platforms"[^>]*value="tiktok"[^>]*>/)).toContain('checked=""')
    expect(tag(/<input[^>]*name="platforms"[^>]*value="youtube"[^>]*>/)).not.toContain('checked')
    expect(html).toContain('(not connected)')
    const max = tag(/<input[^>]*name="dailyMax"[^>]*>/)
    for (const attr of ['min="1"', 'max="25"', 'value="4"']) expect(max).toContain(attr)
    expect(html).toContain('Who can see auto-posted TikTok videos')
    expect(html).toContain('Save Auto-post')
  })

  it('the calendar and the approval queue mark posts the rule approved as Auto-posted', async () => {
    const t = await h.tenant({ platforms: ['youtube'] })
    await h.services.brands.setAutoPost(t.userId, t.brandId, { enabled: true }, { via: 'web' })
    const media = await readyVideo(t.userId, t.brandId)
    const res = await h.services.autoPost.publishVideo(t.userId, { brandId: t.brandId, mediaId: media.id, caption: 'Auto launch', when: '2026-11-03T14:30:00Z' }, { via: 'mcp' })
    expect(res.autoPost.outcome).toBe('posted')
    // a person-approved post for contrast
    const manual = await h.services.drafts.create(t.userId, { brandId: t.brandId, variants: [{ platform: 'youtube', text: 'Manual', title: 'Manual', mediaIds: [media.id] }] }, { via: 'mcp' })
    const { nonce } = await h.services.approvals.issueNonce(t.userId, manual.draft.id, { via: 'web' })
    await h.services.approvals.decide(t.userId, { draftId: manual.draft.id, nonce, decision: 'approve' }, { via: 'web' })
    await h.services.posts.schedule(t.userId, { draftId: manual.draft.id, at: '2026-11-04T14:30:00Z' }, { via: 'web' })

    const cal = await loadCalendar(h.services, t.userId, { view: 'week', anchorKey: '2026-11-02', brandId: t.brandId, timezone: 'UTC', includeCanceled: false, now: NOW })
    const html = decode(renderToStaticMarkup(<CalendarView data={cal} actions={{ reschedule: noop, cancel: noop }} brands={[{ id: t.brandId, name: 'Acme Studio' }]} brandFilter={t.brandId} includeCanceled={false} />))
    expect(html.match(/Auto-posted/g)).toHaveLength(1)
    expect(html).toContain('Auto launch')

    const approved = await loadApprovals(h.services, t.userId, { tab: 'approved', brandId: t.brandId })
    const queue = decode(renderToStaticMarkup(<ApprovalsView data={approved} actions={approvalActions} now={NOW} brandFilter={null} />))
    // the auto-posted draft: a badge on the card and on its post; the manual one has none
    expect(queue.match(/Auto-posted/g)?.length).toBe(2)
  })

  it('a draft the rule did not post says why in the queue', async () => {
    const t = await h.tenant({ platforms: ['youtube'] })
    const media = await readyVideo(t.userId, t.brandId)
    await h.services.autoPost.publishVideo(t.userId, { brandId: t.brandId, mediaId: media.id, caption: 'Waits' }, { via: 'mcp' })
    const pending = await loadApprovals(h.services, t.userId, { tab: 'pending', brandId: t.brandId })
    const html = decode(renderToStaticMarkup(<ApprovalsView data={pending} actions={approvalActions} now={NOW} brandFilter={null} />))
    expect(html).toContain('Not auto-posted: Auto-post is off for this brand.')
  })

  it('the Connect page has the Claude Code command and explains the auto pipeline', async () => {
    const t = await h.tenant({ platforms: [] })
    const html = decode(renderToStaticMarkup(<ConnectView mcpUrl={h.ui.mcpUrl} connections={await loadConnections(h.services, t.userId)} revoke={noop} timezone="UTC" />))
    expect(claudeCodeCommand(h.ui.mcpUrl)).toBe(`claude mcp add --transport http ${PRODUCT_SLUG} http://localhost:3000/api/mcp`)
    expect(html).toContain('claude mcp add --transport http clipcast http://localhost:3000/api/mcp')
    expect(html).toContain('publish_video')
    expect(html).toContain('Only you can turn Auto-post on')
  })
})
