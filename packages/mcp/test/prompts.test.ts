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
      ['brand_id', true],
      ['topic', true],
      ['platforms', false],
    ])
    expect(prompts.find((p) => p.name === 'pick_clips')?.arguments?.[0]).toMatchObject({ name: 'media_id', required: true })
    expect(prompts.find((p) => p.name === 'weekly_review')?.arguments?.[0]).toMatchObject({ name: 'brand_id', required: true })
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
    expect(t).toContain('[30000–60000 ms | 0:30.000–1:00.000] Here is the hook nobody expects.')
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
