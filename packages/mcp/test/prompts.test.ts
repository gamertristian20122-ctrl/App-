import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { McpError, type GetPromptResult } from '@modelcontextprotocol/sdk/types.js'
import {
  DAY,
  HOUR,
  START,
  approvedDraft,
  connect,
  createHarness,
  image,
  resetHarness,
  structured,
  tenant,
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

function promptText(result: GetPromptResult): string {
  expect(result.messages).toHaveLength(1)
  const content = result.messages[0]?.content
  expect(content?.type).toBe('text')
  return (content as { text: string }).text
}

describe('prompts/list', () => {
  it('lists write_post, pick_clips and weekly_review with arguments', async () => {
    const { userId } = await tenant(h)
    const c = await connect(h, userId)
    const { prompts } = await c.client.listPrompts()
    expect(prompts.map((p) => p.name)).toEqual(['write_post', 'pick_clips', 'weekly_review'])
    const write = prompts.find((p) => p.name === 'write_post')
    expect(write?.title).toBeTruthy()
    expect(write?.arguments?.map((a) => [a.name, a.required ?? false])).toEqual([
      ['brand_id', false], // optional with one brand; a name works too (review: users never see ids)
      ['topic', true],
      ['platforms', false],
    ])
    expect(prompts.find((p) => p.name === 'pick_clips')?.arguments?.[0]).toMatchObject({ name: 'media_id', required: false })
    expect(prompts.find((p) => p.name === 'weekly_review')?.arguments?.[0]).toMatchObject({ name: 'brand_id', required: false })
    await c.close()
  })
})

describe('write_post', () => {
  it('embeds the latest voice profile, best past posts, platform rules and the house rules', async () => {
    const { userId, brandId } = await tenant(h, { platforms: ['instagram', 'linkedin'] })
    await h.services.voice.save(userId, { brandId, profile: { tone: 'Old tone' } })
    await h.services.voice.save(userId, {
      brandId,
      profile: { tone: 'Warm, plain-spoken', audience: 'Indie bakers', do: ['Lead with a question'], dont: ['No jargon'], emoji_policy: 'none' },
    })
    await h.services.imports.savePastPosts(userId, {
      brandId,
      platform: 'instagram',
      posts: [{ platform: 'instagram', externalPostId: 'p1', text: 'Our sourdough starter turned 5 today!', metrics: { likes: 120 } }],
    })
    const c = await connect(h, userId)
    const result = await c.client.getPrompt({ name: 'write_post', arguments: { brand_id: brandId, topic: 'Holiday opening hours', platforms: 'x, linkedin' } })
    const t = promptText(result)
    expect(t).toContain('Holiday opening hours')
    expect(t).toContain('Voice profile (version 2')
    expect(t).toContain('Warm, plain-spoken')
    expect(t).not.toContain('Old tone')
    expect(t).toContain('Lead with a question')
    expect(t).toContain('Emoji: none')
    expect(t).toContain('Our sourdough starter turned 5 today!')
    expect(t).toMatch(/- X: text ≤ 280 weighted characters .*NO links/)
    expect(t).toMatch(/- LinkedIn: text ≤ 3,000 characters/)
    expect(t).not.toMatch(/- Instagram: text ≤/)
    expect(t).toContain('Not connected yet: X')
    expect(t).toContain('create_draft')
    expect(t).toMatch(/Never publish or schedule on your own/)
    expect(t).toContain('approve_draft')

    // default platforms: the connected accounts
    const defaults = promptText(await c.client.getPrompt({ name: 'write_post', arguments: { brand_id: brandId, topic: 'News' } }))
    expect(defaults).toMatch(/Platforms: Instagram, LinkedIn\./)
    await c.close()
  })

  it('rejects bad arguments and other users\' brands with -32602', async () => {
    const { userId, brandId } = await tenant(h)
    const other = await tenant(h)
    const c = await connect(h, userId)
    const cases: Array<Record<string, string>> = [
      { brand_id: 'nope', topic: 'x' },
      { brand_id: brandId, topic: 'x', platforms: 'myspace' },
      { brand_id: other.brandId, topic: 'x' },
      { brand_id: brandId, topic: '   ' },
    ]
    for (const args of cases) {
      const error = await c.client.getPrompt({ name: 'write_post', arguments: args }).catch((e: unknown) => e)
      expect(error, JSON.stringify(args)).toBeInstanceOf(McpError)
      expect((error as McpError).code).toBe(-32602)
    }
    await c.close()
  })
})

describe('pick_clips', () => {
  it('embeds the transcript segments, the clip rules and how to call make_clips', async () => {
    const { userId, brandId } = await tenant(h)
    const media = await transcribedSource(h, userId, brandId)
    const c = await connect(h, userId)
    const t = promptText(await c.client.getPrompt({ name: 'pick_clips', arguments: { media_id: media.id, count: '3' } }))
    expect(t).toContain('best 3 short clips')
    expect(t).toContain('[0:30.000–1:00.000 | 30000–60000 ms] Here is the hook nobody expects.')
    expect(t).toMatch(/Hook in the first 3 seconds/)
    expect(t).toMatch(/20–90 seconds/)
    expect(t).toMatch(/Standalone/)
    expect(t).toContain(`make_clips { mediaId: "${media.id}"`)

    const other = await tenant(h)
    const o = await connect(h, other.userId)
    const error = await o.client.getPrompt({ name: 'pick_clips', arguments: { media_id: media.id } }).catch((e: unknown) => e)
    expect((error as McpError).code).toBe(-32602)
    await o.close()
    await c.close()
  })
})

describe('weekly_review', () => {
  it('embeds last 7 days vs the previous 7 and asks for 3 experiments with drafts', async () => {
    const { userId, brandId } = await tenant(h)
    h.clock.set(new Date(START.getTime() + 14 * DAY))
    const now = h.clock.now()
    async function publish(text: string, publishedAt: Date, metrics: Record<string, number>) {
      const img = await image(h, userId, brandId)
      const d = await approvedDraft(h, userId, brandId, [{ platform: 'instagram', text, mediaIds: [img.id] }])
      const [post] = await h.services.posts.schedule(userId, { draftId: d.draft.id, at: 'now' })
      if (!post) throw new Error('post missing')
      await h.r.posts.claimForPublish(userId, post.id)
      await h.r.posts.markPublished(userId, post.id, { publishedAt })
      await h.services.analytics.recordPostMetrics(userId, post.id, metrics, new Date(publishedAt.getTime() + DAY))
    }
    await publish('Last week post', new Date(now.getTime() - 10 * DAY), { likes: 10, views: 1000 })
    await publish('Behind the scenes reel', new Date(now.getTime() - 2 * DAY), { likes: 50, comments: 10, views: 5000 })
    await h.services.analytics.recordAccountMetrics(userId, { brandId, platform: 'instagram', metrics: { followers: 100 }, capturedAt: new Date(now.getTime() - 8 * DAY) })
    await h.services.analytics.recordAccountMetrics(userId, { brandId, platform: 'instagram', metrics: { followers: 130 }, capturedAt: new Date(now.getTime() - HOUR) })

    const c = await connect(h, userId)
    const t = promptText(await c.client.getPrompt({ name: 'weekly_review', arguments: { brand_id: brandId } }))
    expect(t).toContain('Last 7 days')
    expect(t).toContain('Posts: 1 (previous 1, +0%)')
    expect(t).toMatch(/This week: views 5,000, likes 50, comments 10/)
    expect(t).toMatch(/Previous week: views 1,000, likes 10/)
    expect(t).toMatch(/likes \+400%/)
    expect(t).toContain('Instagram 130 (+30)')
    expect(t).toContain('Behind the scenes reel')
    expect(t).toMatch(/exactly 3 concrete experiments/)
    expect(t).toMatch(/create_draft/)
    expect(t).toMatch(/Never schedule anything the user has not approved/)

    // get_analytics shows the same numbers
    const analytics = await c.call('get_analytics', { brandId })
    expect(structured<{ brands: Array<{ period: { posts: number } }> }>(analytics).brands[0]?.period.posts).toBe(1)

    const other = await tenant(h)
    const o = await connect(h, other.userId)
    const error = await o.client.getPrompt({ name: 'weekly_review', arguments: { brand_id: brandId } }).catch((e: unknown) => e)
    expect((error as McpError).code).toBe(-32602)
    await o.close()
    await c.close()
  })
})

describe('prompt arguments: names, defaults and completion (review: users had to paste UUIDs)', () => {
  it('write_post and weekly_review take a brand name or nothing (one brand); completion offers brand names', async () => {
    const { userId, brandId } = await tenant(h, { brandName: 'Acme Coffee' })
    const c = await connect(h, userId)
    const byName = promptText(await c.client.getPrompt({ name: 'write_post', arguments: { brand_id: 'acme coffee', topic: 'Sunday hours' } }))
    expect(byName).toContain(`brandId ${brandId}`)
    const byDefault = promptText(await c.client.getPrompt({ name: 'write_post', arguments: { topic: 'Sunday hours' } }))
    expect(byDefault).toContain(`brandId ${brandId}`)
    expect(promptText(await c.client.getPrompt({ name: 'weekly_review', arguments: {} }))).toContain(`brandId ${brandId}`)

    const done = await c.client.complete({ ref: { type: 'ref/prompt', name: 'write_post' }, argument: { name: 'brand_id', value: 'ac' } })
    expect(done.completion.values).toEqual(['Acme Coffee'])
    const none = await c.client.complete({ ref: { type: 'ref/prompt', name: 'weekly_review' }, argument: { name: 'brand_id', value: 'zz' } })
    expect(none.completion.values).toEqual([])
    expect(c.client.getServerCapabilities()?.completions).toBeDefined()
    await c.close()
  })

  it('with two brands and no brand_id, the error names the brands', async () => {
    const { userId } = await tenant(h, { brandName: 'One' })
    await h.services.users.get(userId)
    const { createTestBrand } = await import('@app/db/testing')
    await createTestBrand(h.db, userId, { name: 'Two' })
    const c = await connect(h, userId)
    const error = await c.client.getPrompt({ name: 'write_post', arguments: { topic: 'x' } }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(McpError)
    expect((error as McpError).message).toMatch(/"One", "Two"|"Two", "One"/)
    await c.close()
  })

  it('pick_clips defaults to the newest source video and completes source ids', async () => {
    const { userId, brandId } = await tenant(h)
    const media = await transcribedSource(h, userId, brandId)
    const c = await connect(h, userId)
    expect(promptText(await c.client.getPrompt({ name: 'pick_clips', arguments: {} }))).toContain(`from video ${media.id}`)
    const done = await c.client.complete({ ref: { type: 'ref/prompt', name: 'pick_clips' }, argument: { name: 'media_id', value: media.id.slice(0, 4) } })
    expect(done.completion.values).toEqual([media.id])
    await c.close()
  })

  it('pick_clips pages a long transcript instead of embedding all of it (review: 150k characters)', async () => {
    const { userId, brandId } = await tenant(h)
    const media = await longSource(userId, brandId)
    const c = await connect(h, userId)
    const t = promptText(await c.client.getPrompt({ name: 'pick_clips', arguments: { media_id: media.id } }))
    expect(t.length).toBeLessThan(50_000)
    expect(t).toMatch(/call get_transcript \{ mediaId: "[0-9a-f-]+", startMs: \d+ \} to read the rest/)
    await c.close()
  })
})

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
