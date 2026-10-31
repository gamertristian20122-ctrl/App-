// The approval queue: loading drafts with per-platform previews and a web card nonce issued at
// render time, rendering previews with limits and media, and the approve / edit / reject /
// schedule actions (which only work with that nonce and go through services with via 'web').

import { renderToStaticMarkup } from 'react-dom/server'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { IDLE } from '@/lib/ui/action-result'
import { approveDraft, archiveDraft, cancelPost, editVariant, rejectDraft, reopenDraft, reschedulePost, scheduleDraft } from '@/lib/ui/actions/drafts'
import { loadApprovals } from '@/lib/ui/data'
import { ApprovalsView, defaultScheduleIso, type ApprovalActions } from '@/components/app/approvals'
import { createUiHarness, form, NOW, type UiHarness } from './harness'

vi.mock('next/navigation', () => ({ usePathname: () => '/app/approvals', useRouter: () => ({ refresh() {} }), redirect: vi.fn() }))

let h: UiHarness
let userId: string
let brandId: string

const noop = async () => IDLE
const actions: ApprovalActions = { approve: noop, reject: noop, edit: noop, schedule: noop, reopen: noop, archive: noop, cancelPost: noop }

beforeAll(async () => {
  h = await createUiHarness()
  const t = await h.tenant({ platforms: ['x', 'threads', 'instagram'] })
  userId = t.userId
  brandId = t.brandId
})
afterAll(async () => {
  await h.close()
})

async function draft(variants: unknown[], via: 'mcp' | 'web' = 'mcp') {
  const view = await h.services.drafts.create(userId, { brandId, variants }, { via })
  return view.draft.id
}

describe('loadApprovals', () => {
  it('lists pending drafts with previews and a web card nonce that verifies for the web only', async () => {
    const imageId = await h.image(userId, brandId)
    const id = await draft([
      { platform: 'x', text: 'Shipping day! Our new editor is live.' },
      { platform: 'instagram', text: 'New editor, who dis', mediaIds: [imageId] },
    ])
    const data = await loadApprovals(h.services, userId, { tab: 'pending' })
    const item = data.items.find((i) => i.preview.draft.id === id)
    expect(item).toBeDefined()
    if (!item) return
    expect(item.nonce).toMatch(/^[A-Za-z0-9_-]{22,}$/)
    expect(item.brandTimezone).toBe('America/New_York')
    const check = await h.services.approvals.verifyNonce(userId, item.nonce as string, id, { via: 'web' })
    expect(check.valid).toBe(true)
    // the instagram preview carries a presigned URL for the image
    const ig = item.preview.variants.find((v) => v.platform === 'instagram')
    expect(ig?.media[0]?.url).toMatch(/^http:\/\/localhost:3000\/api\/dev-storage\//)
  })

  it('puts a ?draft= deep link first and marks it focused; unknown ids are reported', async () => {
    const older = await draft([{ platform: 'threads', text: 'An older thought.' }])
    await draft([{ platform: 'threads', text: 'A newer thought.' }])
    const data = await loadApprovals(h.services, userId, { focusDraftId: older })
    expect(data.items[0]?.preview.draft.id).toBe(older)
    expect(data.items[0]?.focused).toBe(true)
    expect(data.items.filter((i) => i.focused)).toHaveLength(1)

    const missing = await loadApprovals(h.services, userId, { focusDraftId: '00000000-0000-4000-8000-000000000000' })
    expect(missing.focusMissing).toBe(true)
  })

  it("never shows another user's draft, even by deep link", async () => {
    const other = await h.tenant({ platforms: ['x'] })
    const theirs = (await h.services.drafts.create(other.userId, { brandId: other.brandId, variants: [{ platform: 'x', text: 'Private.' }] }, { via: 'mcp' })).draft.id
    const data = await loadApprovals(h.services, userId, { focusDraftId: theirs })
    expect(data.focusMissing).toBe(true)
    expect(data.items.some((i) => i.preview.draft.id === theirs)).toBe(false)
  })

  it('survives a garbage cursor', async () => {
    const data = await loadApprovals(h.services, userId, { cursor: '%%%not-a-cursor' })
    expect(data.items.length).toBeGreaterThan(0)
  })
})

describe('ApprovalsView', () => {
  it('renders each platform preview with its text, length vs the platform limit, media and the nonce', async () => {
    const imageId = await h.image(userId, brandId)
    const id = await draft([
      { platform: 'x', text: 'Rendering test for X.' },
      { platform: 'instagram', text: 'Rendering test for Instagram.', mediaIds: [imageId] },
    ])
    const data = await loadApprovals(h.services, userId, { focusDraftId: id })
    const item = data.items[0]
    if (!item) throw new Error('no item')
    const html = renderToStaticMarkup(<ApprovalsView data={data} actions={actions} now={NOW} brandFilter={null} />)
    expect(html).toContain('Rendering test for X.')
    expect(html).toContain('Rendering test for Instagram.')
    for (const v of item.preview.variants) {
      expect(v.length.max).toBeGreaterThan(0)
      expect(html).toContain(`${v.length.used.toLocaleString('en-US')} / ${v.length.max.toLocaleString('en-US')}`)
    }
    expect(html).toContain('aria-label="X preview"')
    expect(html).toContain('aria-label="Instagram preview"')
    expect(html).toContain('@acme_x')
    const url = item.preview.variants.find((v) => v.platform === 'instagram')?.media[0]?.url as string
    expect(html).toContain(`src="${url.replace(/&/g, '&amp;')}"`)
    expect(html.toLowerCase()).toContain('referrerpolicy="no-referrer"')
    expect(html).toContain(`name="nonce" value="${item.nonce}"`)
    expect(html).toContain('data-focused="true"')
    // ready: the Approve button is enabled
    expect(html).toMatch(/<button type="submit"[^>]*>Approve<\/button>/)
    expect(html).not.toMatch(/<button type="submit"[^>]*disabled=""[^>]*>Approve<\/button>/)
  })

  it('disables Approve and lists the problems when a platform is not ready', async () => {
    // TikTok needs a video and the account is not connected
    const id = await draft([{ platform: 'linkedin', text: 'No LinkedIn account is connected for this brand.' }])
    const data = await loadApprovals(h.services, userId, { focusDraftId: id })
    const item = data.items[0]
    expect(item?.preview.ready).toBe(false)
    const html = renderToStaticMarkup(<ApprovalsView data={data} actions={actions} now={NOW} brandFilter={null} />)
    expect(html).toContain('Connect your LinkedIn account to this brand first.')
    expect(html).toMatch(/<button type="submit"[^>]*disabled=""[^>]*>Approve<\/button>/)
    expect(html).toContain('No account connected')
  })

  it('shows an empty state and the missing-draft notice', () => {
    const html = renderToStaticMarkup(
      <ApprovalsView data={{ tab: 'pending', items: [], nextCursor: null, focusMissing: true }} actions={actions} now={NOW} brandFilter={null} />,
    )
    expect(html).toContain('You are all caught up')
    expect(html).toContain('That draft was not found')
  })
})

describe('approval actions', () => {
  async function queued(text = 'Ready to go.') {
    const id = await draft([{ platform: 'x', text }])
    const data = await loadApprovals(h.services, userId, { focusDraftId: id })
    const nonce = data.items[0]?.nonce
    if (!nonce) throw new Error('no nonce')
    return { id, nonce }
  }

  it('approves with the render-time nonce, once', async () => {
    const { id, nonce } = await queued()
    const result = await approveDraft(h.services, userId, form({ draftId: id, nonce }))
    expect(result.ok).toBe(true)
    expect((await h.services.drafts.get(userId, id)).draft.status).toBe('approved')
    const audit = await h.services.audit.list(userId, { subjectType: 'draft', subjectId: id, action: 'draft.approved' })
    expect(audit[0]?.actor).toBe('web')
    const again = await approveDraft(h.services, userId, form({ draftId: id, nonce }))
    expect(again.ok).toBe(false)
  })

  it('cannot approve without a valid nonce for that draft and user', async () => {
    const { id } = await queued()
    expect((await approveDraft(h.services, userId, form({ draftId: id }))).ok).toBe(false)
    expect((await approveDraft(h.services, userId, form({ draftId: id, nonce: 'x'.repeat(43) }))).ok).toBe(false)
    // a nonce for another draft
    const other = await queued('Another one.')
    const wrong = await approveDraft(h.services, userId, form({ draftId: id, nonce: other.nonce }))
    expect(wrong.ok).toBe(false)
    // another user presenting this user's nonce
    const stranger = await h.tenant({ platforms: ['x'] })
    const { nonce } = await queued('Third.')
    expect((await approveDraft(h.services, stranger.userId, form({ draftId: id, nonce }))).ok).toBe(false)
    expect((await h.services.drafts.get(userId, id)).draft.status).toBe('draft')
  })

  it('refuses to approve a draft that is not ready and says why', async () => {
    const id = await draft([{ platform: 'linkedin', text: 'Not connected.' }])
    const data = await loadApprovals(h.services, userId, { focusDraftId: id })
    const result = await approveDraft(h.services, userId, form({ draftId: id, nonce: data.items[0]?.nonce ?? '' }))
    expect(result.ok).toBe(false)
    expect(result.message).toContain('cannot be approved yet')
    expect(result.issues?.join(' ')).toContain('LinkedIn')
  })

  it('edits a variant (new revision) and the old nonce stops working', async () => {
    const { id, nonce } = await queued('Before the edit.')
    const edited = await editVariant(h.services, userId, form({ draftId: id, nonce, platform: 'x', text: 'After the edit.' }))
    expect(edited.ok).toBe(true)
    const view = await h.services.drafts.get(userId, id)
    expect(view.variants[0]?.text).toBe('After the edit.')
    expect(view.draft.revision).toBe(2)
    expect((await approveDraft(h.services, userId, form({ draftId: id, nonce }))).ok).toBe(false)
    // a fresh render issues a nonce for the new revision
    const fresh = await loadApprovals(h.services, userId, { focusDraftId: id })
    expect((await approveDraft(h.services, userId, form({ draftId: id, nonce: fresh.items[0]?.nonce ?? '' }))).ok).toBe(true)
  })

  it('refuses an edit that breaks the platform limit', async () => {
    const { id, nonce } = await queued()
    const result = await editVariant(h.services, userId, form({ draftId: id, nonce, platform: 'x', text: 'y'.repeat(400) }))
    expect(result.ok).toBe(false)
    expect((await h.services.drafts.get(userId, id)).variants[0]?.text).toBe('Ready to go.')
  })

  it('rejects with a reason, reopens and archives', async () => {
    const { id, nonce } = await queued()
    const rejected = await rejectDraft(h.services, userId, form({ draftId: id, nonce, reason: '  Too salesy  ' }))
    expect(rejected.ok).toBe(true)
    const row = (await h.services.drafts.get(userId, id)).draft
    expect(row.status).toBe('rejected')
    expect(row.rejectedReason).toBe('Too salesy')
    expect((await reopenDraft(h.services, userId, form({ draftId: id }))).ok).toBe(true)
    expect((await h.services.drafts.get(userId, id)).draft.status).toBe('draft')
    expect((await archiveDraft(h.services, userId, form({ draftId: id }))).ok).toBe(true)
    expect((await h.services.drafts.get(userId, id)).draft.status).toBe('archived')
  })

  it('schedules an approved draft in the given time zone, reschedules and cancels', async () => {
    const { id, nonce } = await queued('Scheduled post.')
    expect((await approveDraft(h.services, userId, form({ draftId: id, nonce }))).ok).toBe(true)
    // 2026-11-03 09:30 in New York (EST, UTC-5) = 14:30 UTC
    const scheduled = await scheduleDraft(h.services, userId, form({ draftId: id, when: '2026-11-03T09:30', tz: 'America/New_York' }))
    expect(scheduled).toMatchObject({ ok: true, message: 'Scheduled 1 post.' })
    const [post] = await h.services.posts.list(userId, { draftId: id })
    expect(post?.scheduledFor.toISOString()).toBe('2026-11-03T14:30:00.000Z')

    const moved = await reschedulePost(h.services, userId, form({ postId: post?.id, when: '2026-11-04T08:00', tz: 'Europe/Berlin' }))
    expect(moved.ok).toBe(true)
    expect((await h.services.posts.get(userId, post?.id as string)).scheduledFor.toISOString()).toBe('2026-11-04T07:00:00.000Z')

    expect((await reschedulePost(h.services, userId, form({ postId: post?.id, when: '2026-10-01T08:00', tz: 'UTC' }))).ok).toBe(false)
    expect((await cancelPost(h.services, userId, form({ postId: post?.id }))).ok).toBe(true)
    expect((await h.services.posts.get(userId, post?.id as string)).status).toBe('canceled')
  })

  it('will not schedule a draft that is not approved', async () => {
    const { id } = await queued()
    const result = await scheduleDraft(h.services, userId, form({ draftId: id, when: '2026-11-03T09:30', tz: 'UTC' }))
    expect(result.ok).toBe(false)
    expect(result.message).toContain('approved')
  })

  it('default schedule time is about an hour ahead on a quarter hour', () => {
    expect(defaultScheduleIso(new Date('2026-11-02T15:07:00Z'))).toBe('2026-11-02T16:15:00.000Z')
  })
})

describe('TikTok privacy (e2e regression: drafts from clips could not be approved anywhere)', () => {
  it('offers the choice in the queue, saves it with the card nonce, and then the draft can be approved', async () => {
    const t = await h.tenant({ platforms: ['tiktok'] })
    const imageId = await h.image(t.userId, t.brandId)
    // like the worker's clip/render drafts: no privacyLevel
    const view = await h.services.drafts.create(t.userId, { brandId: t.brandId, variants: [{ platform: 'tiktok', text: 'Swipe through', mediaIds: [imageId] }] }, { via: 'worker' })
    const draftId = view.draft.id
    const data = await loadApprovals(h.services, t.userId, { focusDraftId: draftId })
    const nonce = data.items[0]?.nonce ?? ''
    expect(data.items[0]?.preview.ready).toBe(false)
    const html = renderToStaticMarkup(<ApprovalsView data={data} actions={actions} now={NOW} brandFilter={null} />)
    expect(html).toContain('Who can see this TikTok post')
    expect(html).toContain('name="privacyLevel"')
    expect(html).toContain('Only me')

    const bad = await editVariant(h.services, t.userId, form({ draftId, nonce, platform: 'tiktok', privacyLevel: 'EVERYONE' }))
    expect(bad.ok).toBe(false)
    const saved = await editVariant(h.services, t.userId, form({ draftId, nonce, platform: 'tiktok', privacyLevel: 'PUBLIC_TO_EVERYONE' }))
    expect(saved.ok).toBe(true)
    expect(saved.message).toContain('who can see the TikTok post')
    const after = await h.services.drafts.get(t.userId, draftId)
    expect(after.variants[0]).toMatchObject({ text: 'Swipe through', options: { privacyLevel: 'PUBLIC_TO_EVERYONE' } })

    const fresh = await loadApprovals(h.services, t.userId, { focusDraftId: draftId })
    expect(fresh.items[0]?.preview.ready).toBe(true)
    expect((await approveDraft(h.services, t.userId, form({ draftId, nonce: fresh.items[0]?.nonce ?? '' }))).ok).toBe(true)
  })
})

describe('publishable options (review: a hidden first comment was approved unseen)', () => {
  it('the queue shows every option the variant publishes with', async () => {
    const imageId = await h.image(userId, brandId)
    const id = await draft([
      {
        platform: 'instagram',
        text: 'Big launch today!',
        mediaIds: [imageId],
        options: { firstComment: 'Get it here https://scam.example', collaborators: ['attacker'] },
      },
    ])
    const data = await loadApprovals(h.services, userId, { focusDraftId: id })
    const ig = data.items[0]?.preview.variants[0]
    expect(ig?.optionLines).toEqual([
      { key: 'collaborators', label: 'Collaborators (invited)', value: 'attacker' },
      { key: 'firstComment', label: 'First comment', value: 'Get it here https://scam.example' },
    ])
    const html = renderToStaticMarkup(<ApprovalsView data={data} actions={actions} now={NOW} brandFilter={null} />)
    expect(html).toContain('First comment')
    expect(html).toContain('Get it here https://scam.example')
    expect(html).toContain('Collaborators (invited)')
    expect(html).toContain('attacker')
  })
})

describe('OptionList (also used by /approve/[nonce])', () => {
  it('leaves out TikTok "Who can see" only where a picker shows it', async () => {
    const { OptionList } = await import('@/components/platform/preview-card')
    const v = {
      platform: 'tiktok' as const,
      optionLines: [
        { key: 'privacyLevel', label: 'Who can see', value: 'Everyone' },
        { key: 'brandContent', label: 'Paid partnership (branded content)', value: 'Yes' },
      ],
    } as unknown as Parameters<typeof OptionList>[0]['variant']
    const withPicker = renderToStaticMarkup(<OptionList variant={v} skipPrivacyPicker />)
    expect(withPicker).not.toContain('Who can see')
    expect(withPicker).toContain('Paid partnership (branded content)')
    expect(renderToStaticMarkup(<OptionList variant={v} />)).toContain('Who can see')
  })
})
