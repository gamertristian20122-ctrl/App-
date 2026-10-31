import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { McpError } from '@modelcontextprotocol/sdk/types.js'
import { TOOL_NAMES, callTool } from '../src'
import {
  OTHER_UUID,
  approvedDraft,
  connect,
  createHarness,
  ctxFor,
  expectOk,
  expectToolError,
  image,
  resetHarness,
  structured,
  tenant,
  text,
  transcribedSource,
  type Harness,
} from './helpers'

let h: Harness
beforeAll(async () => {
  h = await createHarness()
})
afterAll(async () => {
  await h.db.close()
})
beforeEach(async () => {
  await resetHarness(h)
})

const APP_ONLY = ['approval_decide', 'approval_edit_variant']

describe('tools/list', () => {
  it('lists every tool with a title and explicit annotations, in a fixed order', async () => {
    const { userId } = await tenant(h)
    const c = await connect(h, userId)
    const { tools } = await c.client.listTools()
    expect(tools.map((t) => t.name)).toEqual([...TOOL_NAMES])
    expect(TOOL_NAMES).toEqual([
      'connect_account',
      'list_accounts',
      'create_draft',
      'list_drafts',
      'approve_draft',
      'schedule_post',
      'post_status',
      'get_transcript',
      'make_clips',
      'import_past_posts',
      'save_voice_profile',
      'render_carousel',
      'render_video',
      'get_analytics',
      'upload_media',
      'render_code_video',
      'publish_video',
      'approval_decide',
      'approval_edit_variant',
    ])
    for (const tool of tools) {
      expect(tool.name).toMatch(/^[a-z_]{1,64}$/)
      expect(tool.title, tool.name).toBeTruthy()
      expect(tool.description?.length ?? 0, tool.name).toBeGreaterThan(40)
      const a = tool.annotations
      expect(a?.title, tool.name).toBe(tool.title)
      expect(typeof a?.readOnlyHint, tool.name).toBe('boolean')
      expect(typeof a?.destructiveHint, tool.name).toBe('boolean')
      expect(typeof a?.idempotentHint, tool.name).toBe('boolean')
      expect(typeof a?.openWorldHint, tool.name).toBe('boolean')
      expect(a?.readOnlyHint === true || a?.destructiveHint !== undefined, tool.name).toBe(true)
      if (a?.readOnlyHint) expect(a.destructiveHint, tool.name).toBe(false)
      expect(tool.inputSchema.type, tool.name).toBe('object')
      expect(JSON.stringify(tool.inputSchema)).not.toContain('$schema')
      const visibility = (tool._meta?.ui as { visibility?: string[] } | undefined)?.visibility
      if (APP_ONLY.includes(tool.name)) {
        expect(visibility, tool.name).toEqual(['app'])
        expect(tool._meta?.['openai/visibility']).toBe('private')
        expect(a?.destructiveHint).toBe(true)
      } else {
        expect(visibility, tool.name).toBeUndefined()
      }
    }
    const byName = new Map(tools.map((t) => [t.name, t]))
    // the AI can only open the card; approving is the user's (app-only tools)
    expect(byName.get('approve_draft')?.annotations?.readOnlyHint).toBe(true)
    expect(byName.get('approve_draft')?._meta).toMatchObject({ ui: { resourceUri: 'ui://approval-card/v1' }, 'openai/outputTemplate': 'ui://approval-card/v1' })
    expect(byName.get('schedule_post')?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, openWorldHint: true })
    for (const name of ['list_accounts', 'list_drafts', 'post_status', 'get_transcript', 'get_analytics']) {
      expect(byName.get(name)?.annotations?.readOnlyHint, name).toBe(true)
    }
    // schemas come from core validation, with descriptions
    const create = byName.get('create_draft')?.inputSchema as { required?: string[]; properties: Record<string, { description?: string }> }
    expect(create.required).toEqual(expect.arrayContaining(['brandId', 'variants']))
    expect(create.properties.brandId?.description).toMatch(/list_accounts/)
    await c.close()
  })

  it('answers an unknown tool with a JSON-RPC error and non-object arguments with a tool error', async () => {
    const { userId } = await tenant(h)
    const c = await connect(h, userId)
    await expect(c.call('publish_now', {})).rejects.toBeInstanceOf(McpError)
    const bad = await callTool(c.ctx, 'list_drafts', ['not', 'an', 'object'])
    expectToolError(bad, 'validation', /JSON object/)
    await c.close()
  })

  it('hides unexpected errors behind a generic message and logs them redacted', async () => {
    const { userId } = await tenant(h)
    const broken = {
      ...h.services,
      drafts: {
        ...h.services.drafts,
        list: async () => {
          throw new Error('connect failed: password=hunter2 at db.internal:5432')
        },
      },
    } as typeof h.services
    const ctx = ctxFor(h, userId, { services: broken })
    const result = await callTool(ctx, 'list_drafts', {})
    const t = expectToolError(result, 'internal', /try again/)
    expect(t).not.toContain('hunter2')
    expect(t).not.toContain('db.internal')
    expect(ctx.log.text()).not.toContain('hunter2')
    expect(ctx.log.text()).toContain('mcp tool crashed')
  })
})

describe('connect_account / list_accounts', () => {
  it('returns a connect link, lists brands with accounts, and refuses other users\' brands', async () => {
    const { userId, brandId, accounts } = await tenant(h)
    const c = await connect(h, userId)
    const list = await c.call('list_accounts', {})
    expectOk(list)
    const brands = structured<{ brands: Array<{ id: string; name: string; accounts: Array<{ id: string; platform: string; status: string }> }> }>(list).brands
    expect(brands).toHaveLength(1)
    expect(brands[0]).toMatchObject({ id: brandId, name: 'Acme' })
    expect(brands[0]?.accounts.map((a) => a.id)).toEqual([accounts[0]?.id])
    expect(text(list)).toContain(brandId)
    expect(text(list)).toContain('@acme_instagram')
    expect(JSON.stringify(list)).not.toMatch(/providerProfileRef|userId/)

    const link = await c.call('connect_account', { brandId, platform: 'tiktok' })
    const t = expectOk(link)
    const data = structured<{ url: string; platform: string; brandId: string }>(link)
    expect(data).toMatchObject({ platform: 'tiktok', brandId })
    expect(data.url).toMatch(/^https?:\/\//)
    expect(t).toContain(data.url)
    expect(t).toMatch(/list_accounts/)
    // the user returns to the accounts page, which refreshes this brand's accounts (integration)
    const connectCall = h.provider.calls.filter((call) => call.method === 'createConnectLink').at(-1)
    const back = new URL(String((connectCall?.input as { redirectUrl?: string } | undefined)?.redirectUrl))
    expect(back.pathname).toBe('/app/accounts')
    expect(Object.fromEntries(back.searchParams)).toEqual({ brand: brandId, connected: 'tiktok' })
    // the brand now has a provider profile: list_accounts mirrors what the provider reports
    expectOk(await c.call('list_accounts', { brandId }))

    expectToolError(await c.call('connect_account', { brandId, platform: 'myspace' }), 'validation', /platform/)
    expectToolError(await c.call('list_accounts', { brandId: 'nope' }), 'validation', /brandId/)

    const other = await tenant(h)
    expectToolError(await c.call('connect_account', { brandId: other.brandId, platform: 'x' }), 'not_found', /list_accounts/)
    expectToolError(await c.call('list_accounts', { brandId: other.brandId }), 'not_found')
    await c.close()
  })
})

describe('create_draft / list_drafts', () => {
  it('saves a draft (never published) and points at approve_draft', async () => {
    const { userId, brandId } = await tenant(h, { platforms: ['instagram', 'x'] })
    const img = await image(h, userId, brandId)
    const c = await connect(h, userId)
    const result = await c.call('create_draft', {
      brandId,
      variants: [
        { platform: 'instagram', text: 'New drop today', mediaIds: [img.id] },
        { platform: 'x', text: 'New drop today' },
      ],
    })
    const t = expectOk(result)
    const draft = structured<{ draft: { id: string; status: string; ready: boolean; variants: Array<{ platform: string }> } }>(result).draft
    expect(draft.status).toBe('draft')
    expect(draft.ready).toBe(true)
    expect(draft.variants.map((v) => v.platform)).toEqual(['instagram', 'x'])
    expect(t).toContain('approve_draft')
    expect(t).toContain(draft.id)
    expect(t).toMatch(/not published/)

    const list = await c.call('list_drafts', { brandId })
    expectOk(list)
    expect(structured<{ drafts: Array<{ id: string }> }>(list).drafts.map((d) => d.id)).toEqual([draft.id])
    expectToolError(await c.call('list_drafts', { status: 'bogus' }), 'validation', /status/)
    await c.close()
  })

  it('reports platform limits with how much to cut, and refuses X links', async () => {
    const { userId, brandId } = await tenant(h)
    const c = await connect(h, userId)
    const long = await c.call('create_draft', { brandId, variants: [{ platform: 'x', text: 'a'.repeat(300) }] })
    const t = expectToolError(long, 'validation', /variants\.0\.text/)
    expect(t).toMatch(/20 over the limit of 280/)
    const issues = structured<{ error: { issues: Array<{ limit?: number; actual?: number }> } }>(long).error.issues
    expect(issues[0]).toMatchObject({ limit: 280, actual: 300 })

    const link = await c.call('create_draft', { brandId, variants: [{ platform: 'x', text: 'Read https://example.com/post' }] })
    expectToolError(link, 'validation', /Links are not supported in X posts/)
    expectToolError(await c.call('create_draft', { brandId, variants: [] }), 'validation', /variants/)
    await c.close()
  })

  it('refuses other users\' brands, media and drafts', async () => {
    const me = await tenant(h)
    const other = await tenant(h)
    const otherImage = await image(h, other.userId, other.brandId)
    const c = await connect(h, me.userId)
    expectToolError(await c.call('create_draft', { brandId: other.brandId, variants: [{ platform: 'instagram', text: 'hi' }] }), 'not_found')
    expectToolError(
      await c.call('create_draft', { brandId: me.brandId, variants: [{ platform: 'instagram', text: 'hi', mediaIds: [otherImage.id] }] }),
      'not_found',
    )
    await h.services.drafts.create(other.userId, { brandId: other.brandId, variants: [{ platform: 'instagram', text: 'theirs' }] })
    const mine = await c.call('list_drafts', {})
    expect(structured<{ drafts: unknown[] }>(mine).drafts).toHaveLength(0)
    expectToolError(await c.call('list_drafts', { brandId: other.brandId }), 'not_found')
    await c.close()
  })
})

describe('schedule_post / post_status', () => {
  it('schedules only approved drafts and reports post status', async () => {
    const { userId, brandId } = await tenant(h, { platforms: ['linkedin'] })
    const c = await connect(h, userId)
    const draft = await h.services.drafts.create(userId, { brandId, variants: [{ platform: 'linkedin', text: 'Hello' }] })
    const unapproved = await c.call('schedule_post', { draftId: draft.draft.id, at: '2026-11-03T15:00:00Z' })
    expectToolError(unapproved, 'conflict', /approve_draft/)

    const approved = await approvedDraft(h, userId, brandId, [{ platform: 'linkedin', text: 'Approved post' }])
    expectToolError(await c.call('schedule_post', { draftId: approved.draft.id, at: '2026-11-01T00:00:00Z' }), 'validation', /past/)
    expectToolError(await c.call('schedule_post', { draftId: approved.draft.id, at: 'tomorrow' }), 'validation', /at/)
    const scheduled = await c.call('schedule_post', { draftId: approved.draft.id, at: '2026-11-03T15:00:00-05:00' })
    const t = expectOk(scheduled)
    const posts = structured<{ posts: Array<{ id: string; status: string; scheduledFor: string; platform: string }> }>(scheduled).posts
    expect(posts).toHaveLength(1)
    expect(posts[0]).toMatchObject({ status: 'scheduled', platform: 'linkedin', scheduledFor: '2026-11-03T20:00:00.000Z' })
    expect(t).toContain('post_status')

    const byDraft = await c.call('post_status', { draftId: approved.draft.id })
    expectOk(byDraft)
    expect(structured<{ posts: Array<{ id: string }> }>(byDraft).posts.map((p) => p.id)).toEqual([posts[0]?.id])
    const byPost = await c.call('post_status', { postId: posts[0]?.id })
    expect(text(byPost)).toContain('scheduled')
    expectToolError(await c.call('post_status', {}), 'validation', /exactly one/)
    expectToolError(await c.call('post_status', { postId: posts[0]?.id, draftId: approved.draft.id }), 'validation')

    const other = await tenant(h)
    const o = await connect(h, other.userId)
    expectToolError(await o.call('schedule_post', { draftId: approved.draft.id, at: 'now' }), 'not_found')
    expectToolError(await o.call('post_status', { postId: posts[0]?.id }), 'not_found')
    expectToolError(await o.call('post_status', { draftId: approved.draft.id }), 'not_found')
    await c.close()
    await o.close()
  })

  it('suggests the next free slot when a platform cap is full', async () => {
    const { userId, brandId } = await tenant(h, { platforms: ['tiktok'] })
    const c = await connect(h, userId)
    const at = '2026-11-03T15:00:00Z'
    const video = await h.r.media.create(userId, {
      brandId,
      kind: 'video',
      origin: 'clip',
      status: 'ready',
      storageKey: `users/${userId}/clips/${OTHER_UUID}.mp4`,
      mimeType: 'video/mp4',
      bytes: 5_000_000,
      durationMs: 30_000,
      width: 1080,
      height: 1920,
    })
    let last = await c.call('schedule_post', { draftId: OTHER_UUID, at })
    expectToolError(last, 'not_found')
    for (let i = 0; i < 16; i += 1) {
      const d = await approvedDraft(h, userId, brandId, [
        { platform: 'tiktok', text: `clip ${i}`, mediaIds: [video.id], options: { privacyLevel: 'PUBLIC_TO_EVERYONE' } },
      ])
      last = await c.call('schedule_post', { draftId: d.draft.id, at })
      if (last.isError) break
    }
    const t = expectToolError(last, 'cap_reached', /earliest free slot/)
    expect(t).toMatch(/schedule_post again with at="/)
    expect(structured<{ error: { suggestedAt?: string } }>(last).error.suggestedAt).toBeTruthy()
    await c.close()
  })
})

describe('get_transcript / make_clips', () => {
  it('lists sources, returns timestamped segments and queues clips', async () => {
    const { userId, brandId } = await tenant(h)
    const media = await transcribedSource(h, userId, brandId)
    const c = await connect(h, userId)

    const sources = await c.call('get_transcript', {})
    expectOk(sources)
    expect(structured<{ sources: Array<{ id: string; clipSource: boolean }> }>(sources).sources).toEqual([
      expect.objectContaining({ id: media.id, clipSource: true }),
    ])
    expect(JSON.stringify(sources)).not.toContain('storageKey')

    const full = await c.call('get_transcript', { mediaId: media.id })
    const t = expectOk(full)
    expect(t).toContain('30000–60000 ms] Here is the hook nobody expects.')
    expect(t).toContain('make_clips')
    const range = await c.call('get_transcript', { mediaId: media.id, startMs: '0:30', endMs: '1:00' })
    expect(structured<{ transcript: { words?: unknown[] } }>(range).transcript.words?.length).toBeGreaterThan(0)
    const search = await c.call('get_transcript', { mediaId: media.id, query: 'hook' })
    expect(text(search)).toContain('1 matching segment')
    expectToolError(await c.call('get_transcript', { mediaId: media.id, startMs: 5000, endMs: 1000 }), 'validation', /endMs/)

    const clips = await c.call('make_clips', {
      mediaId: media.id,
      ranges: [{ startMs: 30_000, endMs: 60_000, title: 'The hook', hook: 'Nobody expects this' }],
    })
    expectOk(clips)
    const queued = structured<{ clips: Array<{ id: string; status: string; startMs: number }> }>(clips).clips
    expect(queued).toEqual([expect.objectContaining({ status: 'queued', startMs: 30_000 })])
    expect(text(clips)).toContain('approve_draft')
    const status = await c.call('post_status', { clipId: queued[0]?.id })
    expect(text(status)).toContain('queued')
    expectToolError(await c.call('make_clips', { mediaId: media.id, ranges: [{ startMs: 0, endMs: 1000 }] }), 'validation', /at least 3 s/)
    expectToolError(await c.call('make_clips', { mediaId: media.id, ranges: [{ startMs: 590_000, endMs: 620_000 }] }), 'validation')

    const other = await tenant(h)
    const o = await connect(h, other.userId)
    expectToolError(await o.call('get_transcript', { mediaId: media.id }), 'not_found')
    expectToolError(await o.call('make_clips', { mediaId: media.id, ranges: [{ startMs: 0, endMs: 30_000 }] }), 'not_found')
    expectToolError(await o.call('post_status', { clipId: queued[0]?.id }), 'not_found')
    expect(structured<{ sources: unknown[] }>(await o.call('get_transcript', {})).sources).toEqual([])
    await c.close()
    await o.close()
  })
})

describe('import_past_posts / save_voice_profile / get_analytics', () => {
  it('queues imports, saves voice versions and summarises analytics', async () => {
    const { userId, brandId } = await tenant(h)
    const c = await connect(h, userId)
    const imported = await c.call('import_past_posts', { brandId, limitPerPlatform: 20 })
    expectOk(imported)
    const jobs = structured<{ platforms: string[]; jobs: Array<{ id: string; type: string }> }>(imported)
    expect(jobs.platforms).toEqual(['instagram'])
    expect(jobs.jobs[0]?.type).toBe('import_past_posts')
    const jobStatus = await c.call('post_status', { jobId: jobs.jobs[0]?.id })
    expect(text(jobStatus)).toMatch(/import_past_posts\): queued/)
    expectToolError(await c.call('import_past_posts', { brandId, limitPerPlatform: 0 }), 'validation', /limitPerPlatform/)

    const saved = await c.call('save_voice_profile', { brandId, profile: { tone: 'Warm and direct', do: ['Use short sentences'] } })
    expect(expectOk(saved)).toMatch(/version 1/)
    const again = await c.call('save_voice_profile', { brandId, profile: { tone: 'Playful' }, source: 'mixed' })
    expect(structured<{ voiceProfile: { version: number } }>(again).voiceProfile.version).toBe(2)
    expectToolError(await c.call('save_voice_profile', { brandId, profile: { emoji_policy: 'always' } }), 'validation', /emoji_policy/)

    const analytics = await c.call('get_analytics', { brandId, days: 14 })
    expect(expectOk(analytics)).toMatch(/Acme .*last 14 days: 0 posts/)
    expectToolError(await c.call('get_analytics', { days: 0 }), 'validation', /days/)

    const other = await tenant(h)
    const o = await connect(h, other.userId)
    expectToolError(await o.call('import_past_posts', { brandId }), 'not_found')
    expectToolError(await o.call('save_voice_profile', { brandId, profile: {} }), 'not_found')
    expectToolError(await o.call('get_analytics', { brandId }), 'not_found')
    expectToolError(await o.call('post_status', { jobId: jobs.jobs[0]?.id }), 'not_found')
    await c.close()
    await o.close()
  })
})

describe('render_carousel / render_video', () => {
  it('queues template renders and refuses other users\' media', async () => {
    const { userId, brandId } = await tenant(h)
    const img = await image(h, userId, brandId)
    const c = await connect(h, userId)
    const carousel = await c.call('render_carousel', { brandId, slides: [{ heading: 'Tip 1', body: 'Do the thing' }, { imageMediaId: img.id }] })
    expect(expectOk(carousel)).toMatch(/2 slides carousel/)
    const job = structured<{ job: { id: string; type: string; status: string } }>(carousel).job
    expect(job).toMatchObject({ type: 'carousel_render', status: 'queued' })
    expect(text(await c.call('post_status', { jobId: job.id }))).toContain('carousel_render')
    // the worker finishes the render and makes the draft: post_status points the AI at it
    expect(expectOk(carousel)).toMatch(/approve_draft instead of creating another draft/)
    const fakeDraftId = '11111111-2222-4333-8444-555555555555'
    await h.db.query(`update public.jobs set status = 'succeeded', finished_at = now(), result = $2::jsonb where id = $1`, [
      job.id,
      JSON.stringify({ mediaIds: [img.id], draftId: fakeDraftId, platforms: ['instagram'] }),
    ])
    expect(text(await c.call('post_status', { jobId: job.id }))).toContain(`Its draft is ${fakeDraftId}: show it with approve_draft`)
    await h.db.query(`update public.jobs set result = $2::jsonb where id = $1`, [job.id, JSON.stringify({ mediaIds: [img.id], draftId: null })])
    expect(text(await c.call('post_status', { jobId: job.id }))).toMatch(/No draft was made/)

    const video = await c.call('render_video', { brandId, slides: [{ text: 'Hello', durationMs: 3000 }] })
    expect(structured<{ job: { type: string } }>(video).job.type).toBe('video_render')
    expectToolError(await c.call('render_carousel', { brandId, slides: [] }), 'validation', /slides/)
    expectToolError(await c.call('render_video', { brandId, slides: [{ text: 'x', durationMs: 15_000 }], aspect: '4:3' }), 'validation', /aspect/)

    const other = await tenant(h)
    const o = await connect(h, other.userId)
    expectToolError(await o.call('render_carousel', { brandId, slides: [{ heading: 'x' }] }), 'not_found')
    expectToolError(await o.call('render_video', { brandId: other.brandId, slides: [{ imageMediaId: img.id }] }), 'validation', /not found/)
    await c.close()
    await o.close()
  })
})

describe('review: tool paths to the playbook (the model cannot call prompts/get)', () => {
  /** A transcribed 2-hour source with 6-second segments (the reviewer's measurement). */
  async function longSource(userId: string, brandId: string) {
    const { media } = await h.services.media.registerDriveLink(userId, { brandId, url: 'https://drive.google.com/file/d/long/view', rightsAttested: true })
    await h.services.media.markIngested(userId, media.id, { durationMs: 7_200_000 })
    const segments = Array.from({ length: 1_200 }, (_, i) => ({ s: i * 6_000, e: (i + 1) * 6_000, t: `Segment ${i} says something worth hearing about the topic at hand, at some length.` }))
    const words = segments.flatMap((seg) => seg.t.split(' ').map((t, j) => ({ s: seg.s + j * 400, e: seg.s + (j + 1) * 400, t })))
    await h.services.transcripts.save(userId, media.id, {
      engine: 'fake',
      result: { language: 'en', durationMs: 7_200_000, text: segments.map((s) => s.t).join(' '), words, segments },
    })
    return media
  }

  it('get_transcript pages a long transcript within a budget, structuredContent included (was 150k + 135k characters)', async () => {
    const { userId, brandId } = await tenant(h)
    const media = await longSource(userId, brandId)
    const c = await connect(h, userId)
    const first = await c.call('get_transcript', { mediaId: media.id })
    const t = expectOk(first)
    expect(t.length).toBeLessThan(45_000)
    expect(JSON.stringify(first.structuredContent).length).toBeLessThan(80_000)
    const s = structured<{ transcript: { segments: Array<{ s: number }>; nextStartMs: number | null; words?: unknown } }>(first).transcript
    expect(s.words).toBeUndefined()
    expect(s.nextStartMs).toBeGreaterThan(0)
    expect(s.segments.at(-1)?.s).toBeLessThan(s.nextStartMs ?? 0)
    expect(t).toContain(`startMs: ${s.nextStartMs}`)
    expect(t).toMatch(/What makes a good clip/) // the pick_clips rules reach the model
    const next = structured<{ transcript: { segments: Array<{ s: number }> } }>(await c.call('get_transcript', { mediaId: media.id, startMs: s.nextStartMs }))
    expect(next.transcript.segments[0]?.s).toBe(s.nextStartMs)
    await c.close()
  })

  it('a short range prints word timings in the text (structuredContent is not in the model context)', async () => {
    const { userId, brandId } = await tenant(h)
    const media = await transcribedSource(h, userId, brandId)
    const c = await connect(h, userId)
    const ranged = await c.call('get_transcript', { mediaId: media.id, startMs: 30_000, endMs: 60_000 })
    const t = expectOk(ranged)
    expect(t).toMatch(/Word timings \(word@startMs\)/)
    expect(t).toMatch(/hook@\d+/)
    expect(structured<{ transcript: { words: unknown[] } }>(ranged).transcript.words.length).toBeGreaterThan(0)
    // a long range: no word timings, and the text says how to get them
    const wide = await c.call('get_transcript', { mediaId: media.id, startMs: 0, endMs: 600_000 })
    expect(text(wide)).toMatch(/range of 5 minutes or less/)
    expect(structured<{ transcript: { words?: unknown } }>(wide).transcript.words).toBeUndefined()
    await c.close()
  })

  it('get_transcript without arguments lists images and audio with ids too (review: no way to find them)', async () => {
    const { userId, brandId } = await tenant(h)
    const img = await image(h, userId, brandId)
    const audio = await h.r.media.create(userId, { brandId, kind: 'audio', origin: 'upload', status: 'ready', storageKey: `users/${userId}/uploads/a.mp3`, mimeType: 'audio/mpeg', bytes: 10, durationMs: 30_000 })
    const c = await connect(h, userId)
    const listed = await c.call('get_transcript', {})
    const t = expectOk(listed)
    expect(t).toContain(img.id)
    expect(t).toContain(audio.id)
    expect(t).toMatch(/render_carousel/)
    const s = structured<{ images: Array<{ id: string }>; audio: Array<{ id: string }> }>(listed)
    expect(s.images.map((m) => m.id)).toEqual([img.id])
    expect(s.audio.map((m) => m.id)).toEqual([audio.id])
    await c.close()
  })

  it('list_accounts with a brandId returns the writing brief and the full voice profile to merge into', async () => {
    const { userId, brandId } = await tenant(h, { platforms: ['linkedin'] })
    await h.services.voice.save(userId, { brandId, profile: { tone: 'Warm and direct', audience: 'Cafe owners', do: ['Use short sentences'] } })
    const c = await connect(h, userId)
    const res = await c.call('list_accounts', { brandId })
    const t = expectOk(res)
    expect(t).toMatch(/Tone: Warm and direct/)
    expect(t).toMatch(/Audience: Cafe owners/)
    expect(t).toMatch(/LinkedIn: text ≤/)
    expect(t).toMatch(/replaces the whole profile/)
    expect(structured<{ voiceProfile: { version: number; profile: { do: string[] } } }>(res).voiceProfile).toMatchObject({ version: 1, profile: { do: ['Use short sentences'] } })
    // the tool descriptions and instructions point at tools, not at prompts the model cannot load
    const { tools } = await c.client.listTools()
    for (const tool of tools) expect(tool.description, tool.name).not.toMatch(/load the write_post prompt|use the (pick_clips|weekly_review) prompt/i)
    expect(c.client.getInstructions()).not.toMatch(/use the write_post prompt|pick_clips prompt →|weekly_review prompt for/)
    await c.close()
  })

  it('get_analytics with a brandId adds the week-over-week review and the steps', async () => {
    const { userId, brandId } = await tenant(h)
    const c = await connect(h, userId)
    const res = await c.call('get_analytics', { brandId })
    const t = expectOk(res)
    expect(t).toMatch(/Last 7 days .* vs the previous 7 days/)
    expect(t).toMatch(/Propose exactly 3 concrete experiments/)
    expect(structured<{ weeklyReview: unknown }>(res).weeklyReview).toBeDefined()
    expect(text(await c.call('get_analytics', {}))).toMatch(/call get_analytics with its brandId/)
    await c.close()
  })

  it('account holds are worded neutrally in tool errors (no upgrade prompt; review: app guidelines)', async () => {
    const { userId, brandId } = await tenant(h)
    await h.r.brands.setStatus(userId, brandId, 'suspended')
    const c = await connect(h, userId)
    const t = expectToolError(await c.call('create_draft', { brandId, variants: [{ platform: 'instagram', text: 'hi' }] }), 'payment_required')
    expect(t).toMatch(/paused because the plan allows fewer brands/)
    expect(t).not.toMatch(/Upgrade|Choose a plan/i)
    await h.r.brands.setStatus(userId, brandId, 'active')
    await h.r.users.updateBilling(userId, { subscriptionStatus: 'canceled' })
    const held = expectToolError(await c.call('create_draft', { brandId, variants: [{ platform: 'instagram', text: 'hi' }] }), 'payment_required')
    expect(held).toMatch(/The subscription has ended/)
    expect(held).not.toMatch(/Choose a plan|Upgrade/i)
    await c.close()
  })
})
