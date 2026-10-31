// Server-action logic for brands, accounts, media, clips, voice and AI connections (PGlite-backed
// services, fake posting provider, memory storage), plus the action runner and the layout data.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { SOURCE_URL_MESSAGES } from '@app/core/links'
import { createTestSourceVideo } from '@app/db/testing'
import { AppError } from '@app/core/errors'
import { clipReserveKey } from '@app/services'
import { success } from '@/lib/ui/action-result'
import {
  addDriveLink,
  archiveBrand,
  connectAccount,
  createBrand,
  deleteMedia,
  disconnectAccount,
  requestClip,
  restoreBrand,
  revokeAiConnection,
  saveVoiceProfile,
  saveVoiceProfileJson,
  syncAccounts,
  updateBrand,
  voiceProfileFromForm,
} from '@/lib/ui/actions/settings'
import { billingBanner, loadAccounts, loadBrands, loadClips, loadMedia, loadShell, loadVoice, pickBrand } from '@/lib/ui/data'
import { createUiHarness, form, NOW, type UiHarness } from './harness'

const revalidatePath = vi.fn()
vi.mock('next/cache', () => ({ revalidatePath: (...args: unknown[]) => revalidatePath(...args) }))
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => undefined, set: () => undefined }) }))
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw Object.assign(new Error('NEXT_REDIRECT'), { digest: `NEXT_REDIRECT;replace;${url};307;` })
  },
}))

let h: UiHarness

beforeAll(async () => {
  h = await createUiHarness()
})
afterAll(async () => {
  await h.close()
})

describe('brands', () => {
  it('creates a brand within the plan limit and refuses one over it', async () => {
    const t = await h.tenant({ plan: 'starter', platforms: [] })
    const over = await createBrand(h.services, t.userId, form({ name: 'Second brand', timezone: 'Europe/Paris' }))
    expect(over.ok).toBe(false)
    expect(over.message).toContain('Your plan allows 1 active brand')

    const data = await loadBrands(h.services, t.userId)
    expect(data).toMatchObject({ activeCount: 1, limit: 1 })

    expect((await archiveBrand(h.services, t.userId, form({ brandId: t.brandId }))).ok).toBe(true)
    const created = await createBrand(h.services, t.userId, form({ name: '  Fresh Start ', timezone: 'Europe/Paris' }))
    expect(created).toMatchObject({ ok: true })
    const brands = await h.services.brands.list(t.userId, { status: 'active' })
    expect(brands.map((b) => [b.name, b.timezone])).toEqual([['Fresh Start', 'Europe/Paris']])

    // restoring the archived brand needs a free slot
    const restore = await restoreBrand(h.services, t.userId, form({ brandId: t.brandId }))
    expect(restore.ok).toBe(false)
  })

  it('renames, validates and scopes to the user', async () => {
    const t = await h.tenant({ platforms: [] })
    expect((await updateBrand(h.services, t.userId, form({ brandId: t.brandId, name: 'Renamed', timezone: 'Asia/Tokyo' }))).ok).toBe(true)
    expect(await h.services.brands.get(t.userId, t.brandId)).toMatchObject({ name: 'Renamed', timezone: 'Asia/Tokyo' })
    expect((await updateBrand(h.services, t.userId, form({ brandId: t.brandId, name: '', timezone: 'Mars/Olympus' }))).message).toBe('Nothing to change.')
    expect((await createBrand(h.services, t.userId, form({ name: '' }))).ok).toBe(false)
    const stranger = await h.tenant({ platforms: [] })
    expect((await updateBrand(h.services, stranger.userId, form({ brandId: t.brandId, name: 'Hijack' }))).ok).toBe(false)
    expect((await archiveBrand(h.services, t.userId, form({ brandId: 'not-an-id' }))).ok).toBe(false)
  })
})

describe('accounts', () => {
  it('creates a connect link that returns to the accounts page, syncs and disconnects', async () => {
    const t = await h.tenant({ platforms: [] })
    const { result, url } = await connectAccount(h.services, t.userId, form({ brandId: t.brandId, platform: 'tiktok' }), h.ui.appUrl)
    expect(result.ok).toBe(true)
    expect(url).toBeDefined()
    const back = new URL(url as string)
    expect(`${back.origin}${back.pathname}`).toBe('http://localhost:3000/app/accounts')
    expect(back.searchParams.get('brand')).toBe(t.brandId)
    expect(back.searchParams.get('connected')).toBe('tiktok')

    const synced = await syncAccounts(h.services, t.userId, form({ brandId: t.brandId }))
    expect(synced.ok).toBe(true)
    expect(synced.message).toContain('TikTok')
    const { slots, connected } = await loadAccounts(h.services, t.userId, t.brandId)
    expect(slots).toHaveLength(9)
    expect(connected).toBe(1)
    const tiktok = slots.find((s) => s.platform === 'tiktok')?.account
    expect(tiktok?.status).toBe('active')

    const gone = await disconnectAccount(h.services, t.userId, form({ accountId: tiktok?.id }))
    expect(gone.ok).toBe(true)
    expect((await loadAccounts(h.services, t.userId, t.brandId)).connected).toBe(0)
  })

  it('refuses bad input and other users', async () => {
    const t = await h.tenant({ platforms: [] })
    expect((await connectAccount(h.services, t.userId, form({ brandId: t.brandId, platform: 'myspace' }), h.ui.appUrl)).result.ok).toBe(false)
    const stranger = await h.tenant({ platforms: [] })
    const out = await connectAccount(h.services, stranger.userId, form({ brandId: t.brandId, platform: 'x' }), h.ui.appUrl)
    expect(out.result.ok).toBe(false)
    expect(out.url).toBeUndefined()
  })
})

describe('media', () => {
  it('refuses YouTube and unknown hosts, requires the rights confirmation, accepts a Drive link', async () => {
    const t = await h.tenant({ platforms: [] })
    const yt = await addDriveLink(h.services, t.userId, form({ url: 'https://www.youtube.com/watch?v=abc', rightsAttested: 'on' }))
    expect(yt).toMatchObject({ ok: false, message: SOURCE_URL_MESSAGES.video_site_forbidden })
    const other = await addDriveLink(h.services, t.userId, form({ url: 'https://example.com/video.mp4', rightsAttested: 'on' }))
    expect(other).toMatchObject({ ok: false, message: SOURCE_URL_MESSAGES.host_not_allowed })
    const noRights = await addDriveLink(h.services, t.userId, form({ url: 'https://drive.google.com/file/d/abc123/view' }))
    expect(noRights.ok).toBe(false)
    expect(noRights.message).toContain('rights')

    const ok = await addDriveLink(h.services, t.userId, form({ url: 'https://drive.google.com/file/d/abc123/view', rightsAttested: 'on', brandId: t.brandId }))
    expect(ok.ok).toBe(true)
    const { items } = await loadMedia(h.services, t.userId)
    expect(items).toHaveLength(1)
    expect(items[0]?.media).toMatchObject({ origin: 'drive_link', status: 'pending', sourceHost: 'drive.google.com' })
    expect(items[0]?.clipSource).toBe(true)
    expect(JSON.stringify(items)).not.toContain('abc123') // the share link is never echoed

    expect((await deleteMedia(h.services, t.userId, form({ mediaId: items[0]?.media.id }))).ok).toBe(true)
    expect((await loadMedia(h.services, t.userId)).items).toHaveLength(0)
  })

  it('gives ready images a short-lived thumbnail URL', async () => {
    const t = await h.tenant({ platforms: [] })
    await h.image(t.userId, t.brandId)
    const { items } = await loadMedia(h.services, t.userId)
    expect(items[0]?.thumbUrl).toMatch(/^http:\/\/localhost:3000\/api\/dev-storage\//)
  })
})

describe('clips', () => {
  it('loads sources and transcripts and queues a clip from the form', async () => {
    const t = await h.tenant({ platforms: [] })
    const source = await createTestSourceVideo(h.db, t.userId, { brandId: t.brandId, durationMs: 120_000 })
    // ingest reserves the clipping time; the transcript settles it
    await h.services.usage.reserve(t.userId, { meter: 'clip_seconds', amount: 120, idempotencyKey: clipReserveKey(source.id), subjectType: 'media', subjectId: source.id })
    await h.services.transcripts.save(t.userId, source.id, {
      engine: 'fake',
      result: {
        language: 'en',
        durationMs: 120_000,
        text: 'Hello world. The big idea is simple.',
        words: [],
        segments: [
          { s: 0, e: 4_000, t: 'Hello world.' },
          { s: 4_000, e: 9_000, t: 'The big idea is simple.' },
        ],
      },
    })
    const data = await loadClips(h.services, t.userId, { sourceId: source.id, query: 'big idea' })
    expect(data.selected?.id).toBe(source.id)
    expect(data.transcript?.status).toBe('ready')
    expect(data.transcript?.matches?.[0]?.text).toBe('The big idea is simple.')

    const bad = await requestClip(h.services, t.userId, form({ mediaId: source.id, start: '1:50', end: '3:00' }))
    expect(bad.ok).toBe(false)
    const ok = await requestClip(h.services, t.userId, form({ mediaId: source.id, start: '0:04', end: '0:30', title: 'The big idea', captionStyle: 'karaoke' }))
    expect(ok.ok).toBe(true)
    const clips = await h.services.clips.list(t.userId, { sourceMediaId: source.id })
    expect(clips[0]).toMatchObject({ startMs: 4_000, endMs: 30_000, title: 'The big idea', captionStyle: 'karaoke', status: 'queued' })
  })

  it('has nothing to show without clip sources', async () => {
    const t = await h.tenant({ platforms: [] })
    expect(await loadClips(h.services, t.userId)).toMatchObject({ sources: [], selected: null })
  })
})

describe('voice profile', () => {
  it('builds the profile from the form fields', () => {
    const profile = voiceProfileFromForm(
      form({
        tone: ' Warm and direct ',
        audience: 'Indie founders',
        vocabulary: 'ship\n\n  build in public \n',
        do: 'Short sentences',
        dont: 'Jargon\nHype',
        emoji_policy: 'none',
        hashtag_policy: 'nonsense',
        sample_posts: '[x] First sample\n---\nSecond sample\nwith two lines\n---\n[myspace] Third',
      }),
    )
    expect(profile).toEqual({
      tone: 'Warm and direct',
      audience: 'Indie founders',
      vocabulary: ['ship', 'build in public'],
      do: ['Short sentences'],
      dont: ['Jargon', 'Hype'],
      emoji_policy: 'none',
      hashtag_policy: 'few',
      sample_posts: [{ platform: 'x', text: 'First sample' }, { text: 'Second sample\nwith two lines' }, { text: '[myspace] Third' }],
    })
  })

  it('saves versions from the form and from JSON, validating both', async () => {
    const t = await h.tenant({ platforms: [] })
    const saved = await saveVoiceProfile(h.services, t.userId, form({ brandId: t.brandId, tone: 'Playful', vocabulary: 'yay' }))
    expect(saved).toMatchObject({ ok: true })
    expect(saved.message).toContain('version 1')

    expect((await saveVoiceProfileJson(h.services, t.userId, form({ brandId: t.brandId, json: '{nope' }))).message).toBe('That is not valid JSON.')
    expect((await saveVoiceProfileJson(h.services, t.userId, form({ brandId: t.brandId, json: '[1,2]' }))).ok).toBe(false)
    const invalid = await saveVoiceProfileJson(h.services, t.userId, form({ brandId: t.brandId, json: JSON.stringify({ emoji_policy: 'lots' }) }))
    expect(invalid.ok).toBe(false)
    const json = await saveVoiceProfileJson(h.services, t.userId, form({ brandId: t.brandId, json: JSON.stringify({ tone: 'Calm', hashtag_policy: 'none' }) }))
    expect(json.ok).toBe(true)

    const data = await loadVoice(h.services, t.userId, t.brandId)
    expect(data.profile?.version).toBe(2)
    expect(data.profile?.profile).toMatchObject({ tone: 'Calm', hashtag_policy: 'none' })
    expect(data.versions.map((v) => v.version)).toEqual([2, 1])

    const stranger = await h.tenant({ platforms: [] })
    expect((await saveVoiceProfile(h.services, stranger.userId, form({ brandId: t.brandId, tone: 'Hijack' }))).ok).toBe(false)
  })
})

describe('AI connections', () => {
  it('refuses to revoke a connection that is not the user’s', async () => {
    const t = await h.tenant({ platforms: [] })
    const result = await revokeAiConnection(h.services, t.userId, form({ familyId: '00000000-0000-4000-8000-000000000000' }))
    expect(result).toMatchObject({ ok: false, message: 'That connection was not found.' })
    expect((await revokeAiConnection(h.services, t.userId, form({}))).ok).toBe(false)
  })
})

describe('layout data', () => {
  it('picks the remembered brand when usable, else the first active one', async () => {
    const t = await h.tenant({ platforms: [] })
    const second = await h.services.brands.create(t.userId, { name: 'Second' }, { via: 'web' })
    const brands = await h.services.brands.list(t.userId)
    expect(pickBrand(brands, second.id)?.id).toBe(second.id)
    // Both brands can share a created_at timestamp, so "first" is whatever order list() returns.
    expect(pickBrand(brands, 'unknown')?.id).toBe(brands.find((b) => b.status === 'active')?.id)
    expect(pickBrand([], null)).toBeNull()
  })

  it('loads the shell with the approval count and a trial banner', async () => {
    const t = await h.tenant({ plan: 'starter', subscriptionStatus: 'trialing', trialEndsAt: new Date(NOW.getTime() + 5 * 86_400_000), platforms: ['x'] })
    await h.services.drafts.create(t.userId, { brandId: t.brandId, variants: [{ platform: 'x', text: 'One' }] }, { via: 'mcp' })
    const shell = await loadShell(h.services, { id: t.userId, email: t.email }, null, NOW)
    expect(shell.pendingApprovals).toBe(1)
    expect(shell.selectedBrand?.id).toBe(t.brandId)
    expect(shell.banner).toMatchObject({ tone: 'info', title: 'Free trial: 5 days left' })
  })

  it('billing banners cover every state', () => {
    const base = { trial: false, trialEndsAt: null, trialExpired: false, plan: 'starter' as const }
    expect(billingBanner({ ...base, status: 'active' }, NOW)).toBeNull()
    expect(billingBanner({ ...base, status: 'past_due' }, NOW)?.body).toContain('clipping and rendering are paused')
    expect(billingBanner({ ...base, status: 'unpaid' }, NOW)?.tone).toBe('danger')
    expect(billingBanner({ ...base, status: 'canceled' }, NOW)?.title).toBe('Your subscription has ended')
    expect(billingBanner({ ...base, status: 'none', plan: null }, NOW)?.title).toBe('Choose a plan to get started')
    expect(billingBanner({ ...base, status: 'none', trialExpired: true }, NOW)?.title).toBe('Your free trial has ended')
    expect(billingBanner({ ...base, status: 'trialing', trial: true, trialEndsAt: new Date(NOW.getTime() + 3_600_000) }, NOW)).toMatchObject({
      tone: 'warning',
      title: 'Your free trial ends today',
    })
  })
})

describe('runAction', () => {
  it('requires a session, maps errors to safe messages and refreshes the dashboard', async () => {
    const { runAction } = await import('@/lib/ui/server')
    h.signIn(null)
    expect(await runAction(async () => success('never'))).toMatchObject({ ok: false, message: 'Your session has ended. Sign in again.' })

    const t = await h.tenant({ platforms: [] })
    h.signIn({ id: t.userId, email: t.email })
    revalidatePath.mockClear()
    const seen: string[] = []
    expect(await runAction(async ({ userId }) => (seen.push(userId), success('done')))).toMatchObject({ ok: true, message: 'done' })
    expect(seen).toEqual([t.userId])
    expect(revalidatePath).toHaveBeenCalledWith('/app', 'layout')

    const leaked = await runAction(async () => {
      throw new Error('connect ECONNREFUSED postgres://admin:secret@db')
    })
    expect(leaked).toMatchObject({ ok: false, message: 'Something went wrong. Please try again.' })
    expect(JSON.stringify(leaked)).not.toContain('secret')

    const app = await runAction(async () => {
      throw new AppError('limit_exceeded', 'Over the limit.')
    })
    expect(app).toMatchObject({ ok: false, message: 'Over the limit.' })

    // redirects pass through
    const { redirect } = await import('next/navigation')
    await expect(runAction(async () => redirect('/elsewhere'))).rejects.toMatchObject({ digest: expect.stringContaining('NEXT_REDIRECT') })
    h.signIn(null)
  })
})
