// End-to-end run of the whole product on this machine (pnpm e2e).
//
// Starts a real Postgres 16 with the Supabase stand-ins and our migrations, builds and starts the
// web app (next build + next start, DEV_AUTH=1, POSTING_PROVIDER=fake, STORAGE_DRIVER=fs,
// TRANSCRIPTION_PROVIDER=fake or a local Whisper stub) and the worker (WORKER_TYPES=all), then
// drives it like a person and an AI assistant would:
//
//   browser   dev login → create a brand → OAuth consent → drive-link refusal → screenshots
//   MCP       @modelcontextprotocol/sdk over Streamable HTTP with real OAuth (DCR, PKCE, consent,
//             code exchange, refresh): tools/list, accounts, drafts, approval card + nonce,
//             schedule → worker publishes via the fake provider, clips, carousel, voice, analytics
//   media     ffmpeg test video → /api/uploads presign → PUT → complete → ingest → transcript →
//             make_clips → 1080x1920 clips with audio → drafts; carousel → JPEG slides
//   auto-post the person turns on Auto-post on the Brands page; the AI sends a video
//             (upload_media → its curl command → publish_video) and the worker publishes it
//   security  /api/mcp without a token → 401 + WWW-Authenticate resource_metadata; refresh-token
//             reuse revokes the family
//
// Usage: pnpm e2e [--skip-build] [--whisper] [--keep] [--no-screenshots] [--schedule-delay=SEC]
// Needs: Postgres 15–17 binaries (E2E_PG_BIN), ffmpeg/ffprobe, Chromium for playwright-core
// (PLAYWRIGHT_BROWSERS_PATH, default /opt/pw-browsers). State lives in /tmp/e2e-pg and
// /tmp/e2e-run (E2E_PG_DIR, E2E_RUN_DIR); everything is stopped at the end unless --keep.

import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { startApp, type App } from './lib/app'
import { ensureBrowsersPath, playwright, type Browser, type BrowserContext, type Page } from './lib/deps'
import { makeTestVideo, probe } from './lib/media'
import { callOk, callTool, connectWithOAuth, structured, textOf, type McpSession, type ToolResult } from './lib/mcp'
import { startCallbackServer } from './lib/oauth'
import { onStop, run, stopAll } from './lib/procs'
import { assertHealthyPage, capture, openCardHarness, save, shots, SHOTS_DIR, watchPage } from './lib/screens'
import { assert, assertEqual, assertMatch, check, formatBytes, freePort, log, passed, REPO, sleep, waitFor } from './lib/util'

const { values: args } = parseArgs({
  options: {
    'skip-build': { type: 'boolean', default: false },
    whisper: { type: 'boolean', default: false },
    keep: { type: 'boolean', default: false },
    'no-screenshots': { type: 'boolean', default: false },
    'schedule-delay': { type: 'string', default: '60' },
  },
})

const RUN_DIR = process.env.E2E_RUN_DIR ?? '/tmp/e2e-run'
const PG_DIR = process.env.E2E_PG_DIR ?? '/tmp/e2e-pg'
const EMAIL = 'e2e@example.com'
const VIDEO_SECONDS = 20
const SCHEDULE_DELAY_SEC = Math.max(0, Number(args['schedule-delay']) || 0)
const SCREENSHOTS = !args['no-screenshots']
const V1_TOOLS = [
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
]
const CARD_URI = 'ui://approval-card/v1'

interface Ctx {
  app: App
  browser: Browser
  context: BrowserContext
  page: Page
  watcher: { errors: string[] }
  mcp: McpSession
  client: Client
  userId: string
  brandId: string
  /** Filled as the run goes. */
  textDraftId?: string
  scheduledFor?: Date
  sourceMediaId?: string
  clipIds: string[]
  clipDraftIds: string[]
  carouselDraftId?: string
  /** The publish_video draft the Auto-post rule posts. */
  autoDraftId?: string
}

const call = (ctx: Ctx, name: string, a: Record<string, unknown>) => callOk(ctx.client, name, a)

// ---------------------------------------------------------------------------------------------
// Browser: sign in and create a brand
// ---------------------------------------------------------------------------------------------

async function signIn(app: App, browser: Browser): Promise<{ context: BrowserContext; page: Page; watcher: { errors: string[] } }> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, baseURL: app.appUrl, locale: 'en-US', timezoneId: 'America/New_York' })
  const page = await context.newPage()
  const watcher = watchPage(page)
  if (SCREENSHOTS) {
    await capture(page, 'landing', '/', { watcher })
    await capture(page, 'login', '/login', { watcher, waitFor: '#dev-email' })
  } else {
    await page.goto('/login')
  }
  await page.locator('#dev-email').fill(EMAIL)
  await Promise.all([page.waitForURL(/\/app(\?|$)/, { timeout: 30_000 }), page.locator('#dev-email').press('Enter')])
  const cookies = await context.cookies()
  assert(
    cookies.some((c) => c.name === 'dev_session' && c.httpOnly),
    'the dev session cookie is missing or not httpOnly',
  )
  return { context, page, watcher }
}

async function createBrand(ctx: Pick<Ctx, 'app' | 'page' | 'watcher'>, userId: string): Promise<string> {
  const { page } = ctx
  await page.goto('/app/brands', { waitUntil: 'networkidle' })
  await page.locator('#brand-name').fill('Acme Studio')
  await page.getByRole('button', { name: 'Create brand' }).click()
  const row = await waitFor('the brand row', async () =>
    (await ctx.app.db.one<{ id: string }>(`select id from brands where user_id = $1 and name = 'Acme Studio'`, [userId])) ?? undefined,
  )
  await page.getByRole('heading', { name: 'Acme Studio' }).waitFor({ timeout: 15_000 })
  return row.id
}

// ---------------------------------------------------------------------------------------------
// MCP checks
// ---------------------------------------------------------------------------------------------

async function checkToolList(ctx: Ctx): Promise<void> {
  const { tools } = await ctx.client.listTools()
  const names = tools.map((t) => t.name)
  for (const name of V1_TOOLS) assert(names.includes(name), `tools/list lacks ${name}`)
  for (const t of tools) {
    assert(typeof t.title === 'string' && t.title.length > 0, `${t.name} has no title`)
    const a = t.annotations ?? {}
    assert(typeof a.readOnlyHint === 'boolean' || typeof a.destructiveHint === 'boolean', `${t.name} has neither readOnlyHint nor destructiveHint`)
    assert(t.inputSchema?.type === 'object', `${t.name} has no object input schema`)
  }
  const byName = new Map(tools.map((t) => [t.name, t]))
  for (const ro of ['list_accounts', 'list_drafts', 'approve_draft', 'post_status', 'get_transcript', 'get_analytics']) {
    assertEqual(byName.get(ro)?.annotations?.readOnlyHint, true, `${ro} readOnlyHint`)
  }
  assertEqual(byName.get('schedule_post')?.annotations?.destructiveHint, true, 'schedule_post destructiveHint')
  assertEqual(byName.get('publish_video')?.annotations?.destructiveHint, true, 'publish_video destructiveHint')
  assertEqual((byName.get('publish_video')?._meta as { ui?: { resourceUri?: string } } | undefined)?.ui?.resourceUri, CARD_URI, 'publish_video renders the card')
  const cardMeta = byName.get('approve_draft')?._meta as { ui?: { resourceUri?: string }; 'openai/outputTemplate'?: string } | undefined
  assertEqual(cardMeta?.ui?.resourceUri, CARD_URI, 'approve_draft _meta.ui.resourceUri')
  assertEqual(cardMeta?.['openai/outputTemplate'], CARD_URI, 'approve_draft openai/outputTemplate')
  for (const appOnly of ['approval_decide', 'approval_edit_variant']) {
    const vis = (byName.get(appOnly)?._meta as { ui?: { visibility?: string[] } } | undefined)?.ui?.visibility
    assert(Array.isArray(vis) && vis.length === 1 && vis[0] === 'app', `${appOnly} must be app-only (visibility ["app"])`)
  }
  log(`${tools.length} tools: ${names.join(', ')}`)

  const { prompts } = await ctx.client.listPrompts()
  for (const p of ['write_post', 'pick_clips', 'weekly_review']) assert(prompts.some((x) => x.name === p), `prompts/list lacks ${p}`)
  const { resources } = await ctx.client.listResources()
  assert(resources.some((r) => r.uri === CARD_URI), 'resources/list lacks the approval card')
  assertMatch(ctx.client.getInstructions() ?? '', /approve_draft/, 'server instructions')
}

async function checkRefresh(ctx: Ctx): Promise<void> {
  const before = ctx.mcp.provider.tokens()
  assert(before?.refresh_token, 'no refresh token')
  ctx.mcp.provider.corruptAccessToken()
  // the next request gets 401; the SDK refreshes with the refresh token and retries
  const client = await ctx.mcp.reconnect()
  await client.listTools()
  const after = ctx.mcp.provider.tokens()
  assert(after && after.access_token !== before.access_token && after.access_token !== 'expired-or-revoked-access-token', 'access token was not refreshed')
  assert(after.refresh_token && after.refresh_token !== before.refresh_token, 'refresh token was not rotated')
  assertEqual(ctx.mcp.provider.tokenHistory.length, 2, 'token responses (exchange + refresh)')
  ctx.client = client
}

async function connectAccounts(ctx: Ctx): Promise<void> {
  for (const platform of ['x', 'linkedin', 'instagram', 'tiktok']) {
    const r = await call(ctx, 'connect_account', { brandId: ctx.brandId, platform })
    const s = structured<{ url: string; platform: string }>(r)
    assertEqual(s.platform, platform, 'connect_account platform')
    // The fake provider connects at once and hands back the return URL (our accounts page);
    // Upload-Post would show its hosted connect page first and then redirect there.
    assert(s.url.startsWith(`${ctx.app.appUrl}/app/accounts?`) && s.url.includes(`connected=${platform}`), `connect link: ${s.url}`)
    if (platform === 'x') {
      // the person opens the link; the accounts page syncs the brand from the provider on return
      await ctx.page.goto(s.url, { waitUntil: 'networkidle' })
      await assertHealthyPage(ctx.page, 'accounts page after connecting', ctx.watcher)
      assertMatch(await ctx.page.locator('main').innerText(), /@\w+/, 'accounts page lists the connected X handle')
    }
  }
  const r = await call(ctx, 'list_accounts', {})
  const s = structured<{ brands: Array<{ id: string; accounts: Array<{ platform: string; status: string }> }> }>(r)
  const brand = s.brands.find((b) => b.id === ctx.brandId)
  assert(brand, 'list_accounts does not show the brand')
  for (const platform of ['x', 'linkedin', 'instagram', 'tiktok']) {
    const acct = brand.accounts.find((a) => a.platform === platform)
    assertEqual(acct?.status, 'active', `${platform} account status`)
  }
  assertMatch(textOf(r), /Acme Studio/, 'list_accounts text')
}

async function draftApproveSchedule(ctx: Ctx): Promise<void> {
  // An X variant with a link is refused with a message that says why and what to do
  const linked = await callTool(ctx.client, 'create_draft', {
    brandId: ctx.brandId,
    variants: [{ platform: 'x', text: 'New clips are live: https://example.com/clips' }],
  })
  assert(linked.isError, 'an X post with a link was accepted')
  const linkMessage = textOf(linked)
  assertMatch(linkMessage, /link/i, 'X link refusal mentions links')
  assertMatch(linkMessage, /\bX\b/, 'X link refusal names X')
  log(`X link refusal: ${linkMessage.split('\n').join(' | ').slice(0, 240)}`)

  const created = await call(ctx, 'create_draft', {
    brandId: ctx.brandId,
    notes: 'e2e text post',
    variants: [
      { platform: 'x', text: 'We cut long videos into vertical clips with captions. Approve once, post everywhere.' },
      { platform: 'linkedin', text: 'Long videos become vertical clips with burned-in captions, written in your own voice. Nothing posts without your approval.' },
    ],
  })
  const draft = structured<{ draft: { id: string; status: string; ready: boolean } }>(created).draft
  assertEqual(draft.status, 'draft', 'new draft status')
  assert(draft.ready, `draft is not ready: ${textOf(created)}`)
  ctx.textDraftId = draft.id

  // scheduling before approval is refused and points at approve_draft
  const early = await callTool(ctx.client, 'schedule_post', { draftId: draft.id, at: 'now' })
  assert(early.isError, 'an unapproved draft was scheduled')
  assertMatch(textOf(early), /approve_draft/, 'early schedule message')

  // approve_draft: the card nonce is only in _meta; resources/read returns the card HTML
  const card = await call(ctx, 'approve_draft', { draftId: draft.id })
  const meta = card._meta?.approvalCard as { nonce?: string; webUrl?: string; preview?: { variants?: unknown[] } } | undefined
  assert(meta?.nonce && meta.nonce.length >= 32, 'approve_draft _meta lacks the card nonce')
  const visible = JSON.stringify({ content: card.content, structuredContent: card.structuredContent })
  assert(!visible.includes(meta.nonce), 'the card nonce leaked into content/structuredContent (model-visible)')
  assertEqual(meta.preview?.variants?.length, 2, 'card preview variants')
  assertMatch(textOf(card), new RegExp(`/app/approvals\\?draft=${draft.id}`), 'web approval link in text')
  const res = await ctx.client.readResource({ uri: CARD_URI })
  const html = res.contents[0]
  assert(html && 'text' in html, 'approval card resource has no text')
  assertEqual(html.mimeType, 'text/html;profile=mcp-app', 'approval card mime type')
  assertMatch(String(html.text), /<html[\s>]/i, 'approval card HTML')
  assertMatch(String(html.text), /approval_decide/, 'card calls approval_decide')
  assert(!String(html.text).includes(meta.nonce), 'the card HTML embeds a nonce')

  // the AI cannot approve with a guessed nonce; the card's nonce approves exactly once
  const guessed = await callTool(ctx.client, 'approval_decide', { draftId: draft.id, nonce: 'a'.repeat(43), decision: 'approve' })
  assert(guessed.isError, 'a guessed nonce approved the draft')
  const decided = await call(ctx, 'approval_decide', { draftId: draft.id, nonce: meta.nonce, decision: 'approve' })
  assertEqual(structured<{ status: string }>(decided).status, 'approved', 'status after approval_decide')
  const reused = await callTool(ctx.client, 'approval_decide', { draftId: draft.id, nonce: meta.nonce, decision: 'approve' })
  assert(reused.isError, 'a used nonce was accepted again')

  // schedule a little ahead; the worker publishes it when due
  const at = new Date(Date.now() + SCHEDULE_DELAY_SEC * 1000)
  const scheduled = await call(ctx, 'schedule_post', { draftId: draft.id, at: SCHEDULE_DELAY_SEC === 0 ? 'now' : at.toISOString() })
  const posts = structured<{ posts: Array<{ platform: string; status: string; scheduledFor: string }> }>(scheduled).posts
  assertEqual(posts.map((p) => p.platform).sort().join(','), 'linkedin,x', 'scheduled platforms')
  assert(posts.every((p) => p.status === 'scheduled'), 'posts are not scheduled')
  ctx.scheduledFor = at
  const status = await call(ctx, 'post_status', { draftId: draft.id })
  assertMatch(textOf(status), /scheduled/, 'post_status before publishing')
}

async function waitPublished(ctx: Ctx): Promise<void> {
  const draftId = ctx.textDraftId as string
  const due = ctx.scheduledFor?.getTime() ?? Date.now()
  const posts = await waitFor(
    'the worker to publish the scheduled posts',
    async () => {
      const r = await call(ctx, 'post_status', { draftId })
      const list = structured<{ posts: Array<{ status: string; postUrl: string | null; publishedAt: string | null; platform: string; error: string | null }> }>(r).posts
      const failed = list.find((p) => p.status === 'failed')
      assert(!failed, `post failed: ${failed?.error}`)
      return list.length === 2 && list.every((p) => p.status === 'published') ? list : undefined
    },
    { timeoutMs: Math.max(0, due - Date.now()) + 120_000, intervalMs: 2_000 },
  )
  for (const p of posts) {
    assert(p.postUrl && /^https:\/\//.test(p.postUrl), `${p.platform} post has no URL`)
    assert(p.publishedAt && new Date(p.publishedAt).getTime() >= due - 1_000, `${p.platform} published before its time`)
  }
  const jobs = await ctx.app.db.query<{ type: string; status: string }>(
    `select j.type, j.status from jobs j join posts p on p.id::text = j.payload->>'postId'
      where j.user_id = $1 and p.draft_id = $2 and j.type in ('publish_post','check_post_status') order by j.created_at`,
    [ctx.userId, draftId],
  )
  assert(jobs.filter((j) => j.type === 'publish_post' && j.status === 'succeeded').length === 2, 'publish_post jobs did not succeed')
}

// ---------------------------------------------------------------------------------------------
// Auto-post: the person turns it on in the web app; the AI sends a video; the worker publishes it
// ---------------------------------------------------------------------------------------------

async function autoPostFlow(ctx: Ctx): Promise<void> {
  // The AI cannot turn Auto-post on (services refuse anything but the web app); the person does,
  // on the Brands page: switch on, TikTok + Instagram only, daily limit 3, TikTok privacy chosen.
  const { page } = ctx
  await page.goto('/app/brands', { waitUntil: 'networkidle' })
  const form = page.getByRole('form', { name: 'Auto-post for Acme Studio' })
  await form.waitFor({ timeout: 15_000 })
  assertMatch(await page.locator('main').innerText(), /When this is on, videos your AI sends are posted without asking you\. Platform limits still apply\./, 'Auto-post warning')
  await form.getByRole('switch').check()
  await form.getByLabel('TikTok', { exact: true }).check()
  await form.getByLabel('Instagram', { exact: true }).check()
  await form.getByLabel('Most auto-posts per day').fill('3')
  await form.getByLabel('Who can see auto-posted TikTok videos').selectOption('PUBLIC_TO_EVERYONE')
  await form.getByRole('button', { name: 'Save Auto-post' }).click()
  const brand = await waitFor('Auto-post to be saved', async () => {
    const row = await ctx.app.db.one<{ auto_post_enabled: boolean; platforms: string[]; auto_post_daily_max: number; auto_post_tiktok_privacy: string | null }>(
      `select auto_post_enabled, auto_post_platforms::text[] as platforms, auto_post_daily_max, auto_post_tiktok_privacy from brands where id = $1`,
      [ctx.brandId],
    )
    return row?.auto_post_enabled ? row : undefined
  })
  assertEqual([...brand.platforms].sort().join(','), 'instagram,tiktok', 'Auto-post platforms')
  assertEqual(brand.auto_post_tiktok_privacy, 'PUBLIC_TO_EVERYONE', 'Auto-post TikTok privacy')
  const audit = await ctx.app.db.one<{ actor: string }>(`select actor from audit_log where subject_id = $1 and action = 'brand.auto_post_enabled'`, [ctx.brandId])
  assertEqual(audit?.actor, 'web', 'Auto-post switch audit actor')
  const listed = structured<{ brands: Array<{ id: string; autoPost: { enabled: boolean } }> }>(await call(ctx, 'list_accounts', {}))
  assert(listed.brands.find((b) => b.id === ctx.brandId)?.autoPost.enabled === true, 'list_accounts shows Auto-post on (read-only)')

  // The AI (a coding assistant): upload_media → run its curl command → publish_video
  const file = join(RUN_DIR, 'auto-post.mp4')
  await makeTestVideo(file, 6)
  const bytes = statSync(file).size
  const up = await call(ctx, 'upload_media', { brandId: ctx.brandId, filename: 'auto-post.mp4', contentType: 'video/mp4', bytes })
  const upload = structured<{ mediaId: string; uploadUrl: string; headers: Record<string, string>; curl: string }>(up)
  assertMatch(upload.curl, /^curl --fail --silent --show-error -X PUT -H 'Content-Type: video\/mp4' --upload-file 'auto-post\.mp4' '/, 'upload_media curl command')
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/proxy/i.test(k))) as NodeJS.ProcessEnv
  await run('sh', ['-c', upload.curl], { cwd: RUN_DIR, env, timeoutMs: 60_000 })

  const published = await call(ctx, 'publish_video', {
    brandId: ctx.brandId,
    mediaId: upload.mediaId,
    caption: 'Six seconds of test pattern, posted by Auto-post.',
    title: 'Auto-post e2e',
    platforms: ['tiktok', 'instagram'],
    when: 'now',
  })
  const result = structured<{ draftId: string; outcome: string; autoPosted: boolean }>(published)
  // the upload is probed by the worker first; the rule decides when it is ready
  assert(result.outcome === 'waiting_for_media' || result.outcome === 'posted', `publish_video outcome: ${result.outcome}: ${textOf(published)}`)
  ctx.autoDraftId = result.draftId
  log(`publish_video: ${textOf(published).split('\n')[0]}`)
}

async function waitAutoPublished(ctx: Ctx): Promise<void> {
  const draftId = ctx.autoDraftId as string
  const posts = await waitFor(
    'the worker to publish the auto-posted video',
    async () => {
      const r = await call(ctx, 'post_status', { draftId })
      const list = structured<{ posts: Array<{ platform: string; status: string; postUrl: string | null; approvedVia: string; error: string | null }> }>(r).posts
      const failed = list.find((p) => p.status === 'failed')
      assert(!failed, `auto-posted ${failed?.platform} failed: ${failed?.error}`)
      return list.length === 2 && list.every((p) => p.status === 'published') ? list : undefined
    },
    { timeoutMs: 180_000, intervalMs: 2_000 },
  )
  assertEqual(posts.map((p) => p.platform).sort().join(','), 'instagram,tiktok', 'auto-posted platforms')
  assert(posts.every((p) => p.approvedVia === 'auto_post' && p.postUrl && /^https:\/\//.test(p.postUrl)), 'auto-posted posts carry approvedVia auto_post and a URL')
  const draft = await ctx.app.db.one<{ status: string; approved_via: string; auto_post_outcome: string }>(`select status, approved_via, auto_post_outcome from drafts where id = $1`, [draftId])
  assertEqual(draft?.approved_via, 'auto_post', 'draft approved via the Auto-post rule')
  assertEqual(draft?.auto_post_outcome, 'posted', 'Auto-post outcome')
  // the person sees it marked in the calendar
  await ctx.page.goto('/app/calendar', { waitUntil: 'networkidle' })
  assertMatch(await ctx.page.locator('main').innerText(), /Auto-posted/, 'calendar shows the Auto-posted badge')
}

// ---------------------------------------------------------------------------------------------
// Clip flow
// ---------------------------------------------------------------------------------------------

/** POST /api/uploads → PUT → POST /api/uploads/<id>/complete with the browser's session cookie. */
async function uploadVideo(ctx: Ctx, file: string, rightsAttested: boolean): Promise<{ status: number; body: Record<string, unknown> }> {
  const bytes = readFileSync(file)
  const origin = ctx.app.appUrl
  const created = await ctx.context.request.post('/api/uploads', {
    headers: { origin },
    data: { purpose: 'clip_source', brandId: ctx.brandId, filename: 'e2e-source.mp4', contentType: 'video/mp4', bytes: bytes.length, rightsAttested },
  })
  const body = (await created.json()) as Record<string, unknown>
  if (created.status() !== 201) return { status: created.status(), body }
  const upload = body.upload as { mode: string; url: string; headers: Record<string, string>; method: string }
  const media = body.media as { id: string; status: string }
  assertEqual(upload.mode, 'single', 'upload mode for a small file')
  assertEqual(media.status, 'pending', 'media status before upload')
  const put = await fetch(upload.url, { method: 'PUT', headers: upload.headers, body: bytes })
  assert(put.ok, `PUT to the presigned URL answered ${put.status}`)
  const done = await ctx.context.request.post(`/api/uploads/${media.id}/complete`, { headers: { origin }, data: {} })
  const doneBody = (await done.json()) as Record<string, unknown>
  assertEqual(done.status(), 200, `complete upload (${JSON.stringify(doneBody)})`)
  assertEqual(doneBody.ingestQueued, true, 'ingest queued after complete')
  return { status: 201, body: { ...doneBody, mediaId: media.id } }
}

async function clipFlow(ctx: Ctx): Promise<void> {
  const video = join(RUN_DIR, 'source.mp4')
  await makeTestVideo(video, VIDEO_SECONDS)
  const facts = await probe(video)
  assert(facts.hasAudio && facts.width === 1280, 'the generated test video is wrong')

  // without the rights checkbox a clip source is refused
  const refused = await uploadVideo(ctx, video, false)
  assertEqual(refused.status, 400, `upload without rights attestation (${JSON.stringify(refused.body)})`)
  assertMatch(JSON.stringify(refused.body), /rights|own/i, 'rights refusal message')

  const uploaded = await uploadVideo(ctx, video, true)
  const mediaId = uploaded.body.mediaId as string
  ctx.sourceMediaId = mediaId

  // ingest (probe + duration + clip-hours reserve) and transcription run in the worker
  const transcript = await waitFor(
    'ingest + transcription',
    async () => {
      const r = await callTool(ctx.client, 'get_transcript', { mediaId })
      if (r.isError) {
        assert(!/failed/i.test(textOf(r)), `transcript failed: ${textOf(r)}`)
        return undefined
      }
      const t = structured<{ transcript: { status: string; segments: Array<{ s: number; e: number; t: string }>; durationMs: number } }>(r).transcript
      assert(t.status !== 'failed', `transcription failed: ${textOf(r)}`)
      return t.status === 'ready' ? { t, text: textOf(r) } : undefined
    },
    { timeoutMs: 120_000, intervalMs: 1_500 },
  )
  assert(transcript.t.segments.length > 0, 'the transcript has no segments')
  assert(transcript.t.segments.every((seg) => seg.e <= VIDEO_SECONDS * 1000), 'transcript segments run past the end of the video')
  const engine = await ctx.app.db.one<{ engine: string }>(`select engine from transcripts where media_id = $1`, [mediaId])
  if (ctx.app.whisper) {
    assertEqual(engine?.engine, 'whisper', 'transcript engine')
    assert(ctx.app.whisper.requests >= 1, 'the worker never called the Whisper stub')
  } else {
    assertEqual(engine?.engine, 'fake', 'transcript engine')
  }
  assertMatch(transcript.text, /make_clips/, 'get_transcript tells the AI how to clip')
  const media = await ctx.app.db.one<{ duration_ms: number; status: string; width: number; height: number; storage_key: string }>(
    `select duration_ms, status, width, height, storage_key from media_assets where id = $1`,
    [mediaId],
  )
  assertEqual(media?.status, 'ready', 'source media status')
  assert(media && Math.abs(media.duration_ms - VIDEO_SECONDS * 1000) < 500, `source duration ${media?.duration_ms} ms`)
  assert(media.storage_key.includes('/sources/'), `source not promoted out of uploads/ (${media.storage_key})`)
  // listing sources without a mediaId
  const sources = await call(ctx, 'get_transcript', {})
  assertMatch(textOf(sources), new RegExp(mediaId), 'get_transcript lists the source')

  // the pick_clips prompt loads the transcript
  const prompt = await ctx.client.getPrompt({ name: 'pick_clips', arguments: { media_id: mediaId } })
  assert(prompt.messages.length > 0, 'pick_clips returned no messages')

  // two ranges → two clip_render jobs → two drafts (not posts)
  const made = await call(ctx, 'make_clips', {
    mediaId,
    brandId: ctx.brandId,
    captionStyle: 'bold',
    ranges: [
      { startMs: 1_000, endMs: 7_000, title: 'The one mistake', hook: 'Every creator makes this mistake' },
      { startMs: '00:09.000', endMs: '00:16.500', title: 'Post it more than once' },
    ],
  })
  const clips = structured<{ clips: Array<{ id: string; status: string; startMs: number; endMs: number }> }>(made).clips
  assertEqual(clips.length, 2, 'clips queued')
  assertEqual(clips[1]?.startMs, 9_000, 'timestamp string parsed to ms')
  ctx.clipIds = clips.map((c) => c.id)

  const ready = await waitFor(
    'both clips to render',
    async () => {
      const out: Array<{ id: string; draftId: string; outputMediaId: string }> = []
      for (const id of ctx.clipIds) {
        const r = await call(ctx, 'post_status', { clipId: id })
        const c = structured<{ clip: { status: string; draftId: string | null; outputMediaId: string | null; error: string | null } }>(r).clip
        assert(c.status !== 'failed', `clip ${id} failed: ${c.error}`)
        if (c.status === 'ready' && c.draftId && c.outputMediaId) out.push({ id, draftId: c.draftId, outputMediaId: c.outputMediaId })
      }
      return out.length === ctx.clipIds.length ? out : undefined
    },
    { timeoutMs: 240_000, intervalMs: 2_000 },
  )
  ctx.clipDraftIds = ready.map((c) => c.draftId)

  // the output: 1080x1920 with audio, fetched through the card's presigned preview URL
  const card = await call(ctx, 'approve_draft', { draftId: ready[0]?.draftId as string })
  const preview = (card._meta?.approvalCard as { preview: { variants: Array<{ platform: string; media: Array<{ url: string | null; kind: string; width: number | null; height: number | null }> }> } }).preview
  const platforms = preview.variants.map((v) => v.platform).sort()
  assert(platforms.includes('tiktok') && platforms.includes('instagram'), `clip draft platforms: ${platforms.join(', ')}`)
  const clipMedia = preview.variants[0]?.media[0]
  assert(clipMedia?.url, 'clip preview has no media URL')
  assertEqual(clipMedia.kind, 'video', 'clip media kind')
  const res = await fetch(clipMedia.url)
  assert(res.ok, `downloading the clip answered ${res.status}`)
  const clipFile = join(RUN_DIR, 'clip-1.mp4')
  writeFileSync(clipFile, Buffer.from(await res.arrayBuffer()))
  const out = await probe(clipFile)
  assertEqual(`${out.width}x${out.height}`, '1080x1920', 'clip resolution')
  assert(out.hasAudio, 'the clip has no audio stream')
  assert(Math.abs(out.durationSec - 6) < 0.5, `clip duration ${out.durationSec} s (expected ~6 s)`)

  // drafts, not posts
  for (const draftId of ctx.clipDraftIds) {
    const st = await call(ctx, 'post_status', { draftId })
    assertEqual(structured<{ posts: unknown[] }>(st).posts.length, 0, 'a clip draft already has posts')
  }
  const drafts = await call(ctx, 'list_drafts', { status: 'draft' })
  for (const draftId of ctx.clipDraftIds) assertMatch(textOf(drafts), new RegExp(draftId), 'list_drafts shows the clip draft')
  const posted = await ctx.app.db.one<{ n: number }>(`select count(*)::int as n from posts where draft_id = any($1::uuid[])`, [ctx.clipDraftIds])
  assertEqual(posted?.n, 0, 'posts created for clip drafts')

  // usage: the source's seconds are settled once (making two clips is not charged twice)
  const usage = await ctx.app.db.query<{ kind: string; amount: number }>(
    `select kind, amount from usage_ledger where user_id = $1 and meter = 'clip_seconds' order by created_at`,
    [ctx.userId],
  )
  const settled = usage.filter((u) => u.kind === 'settle').reduce((n, u) => n + u.amount, 0)
  assertEqual(settled, VIDEO_SECONDS, `settled clip seconds (${JSON.stringify(usage)})`)
}

// ---------------------------------------------------------------------------------------------
// Carousel, voice, analytics
// ---------------------------------------------------------------------------------------------

async function carouselFlow(ctx: Ctx): Promise<void> {
  const r = await call(ctx, 'render_carousel', {
    brandId: ctx.brandId,
    template: 'bold',
    aspect: '4:5',
    slides: [
      { heading: 'Stop posting long videos once', body: 'One episode is five clips waiting to happen.' },
      { heading: 'Hook first', body: 'The first three seconds decide everything.' },
      { heading: 'Your voice, every post', footer: 'acme.studio' },
    ],
  })
  const jobId = structured<{ job: { id: string } }>(r).job.id
  const result = await waitFor(
    'the carousel render',
    async () => {
      const s = await call(ctx, 'post_status', { jobId })
      const job = structured<{ job: { status: string; error: string | null; result: { mediaIds?: string[]; draftId?: string | null } | null } }>(s).job
      assert(job.status !== 'failed' && job.status !== 'dead', `carousel job ${job.status}: ${job.error}`)
      return job.status === 'succeeded' ? { job, text: textOf(s) } : undefined
    },
    { timeoutMs: 120_000, intervalMs: 1_500 },
  )
  const draftId = result.job.result?.draftId
  assert(draftId, `carousel produced no draft: ${result.text}`)
  assertEqual(result.job.result?.mediaIds?.length, 3, 'carousel slides')
  assertMatch(result.text, /approve_draft/, 'post_status points at approve_draft for the carousel draft')
  ctx.carouselDraftId = draftId

  const rows = await ctx.app.db.query<{ mime_type: string; width: number; height: number; status: string }>(
    `select mime_type, width, height, status from media_assets where id = any($1::uuid[])`,
    [result.job.result?.mediaIds],
  )
  for (const m of rows) {
    assertEqual(m.mime_type, 'image/jpeg', 'carousel slide type')
    assertEqual(`${m.width}x${m.height}`, '1080x1350', 'carousel slide size')
  }
  const card = await call(ctx, 'approve_draft', { draftId })
  const variants = (card._meta?.approvalCard as { preview: { variants: Array<{ platform: string; media: Array<{ url: string | null }> }> } }).preview.variants
  const url = variants[0]?.media[0]?.url
  assert(url, 'carousel preview has no media URL')
  const img = Buffer.from(await (await fetch(url)).arrayBuffer())
  assert(img[0] === 0xff && img[1] === 0xd8 && img[2] === 0xff, 'carousel slide is not a JPEG')
  const st = await call(ctx, 'post_status', { draftId })
  assertEqual(structured<{ posts: unknown[] }>(st).posts.length, 0, 'the carousel draft already has posts')
}

async function voiceAndAnalytics(ctx: Ctx): Promise<void> {
  await call(ctx, 'save_voice_profile', {
    brandId: ctx.brandId,
    profile: {
      tone: 'Direct, warm, a little playful.',
      audience: 'Solo creators and small video teams.',
      vocabulary: ['clips', 'hook', 'repurpose'],
      do: ['Lead with the problem', 'Use short sentences'],
      dont: ['Hype words', 'More than two hashtags'],
      emoji_policy: 'sparing',
      hashtag_policy: 'few',
      sample_posts: [{ platform: 'linkedin', text: 'One long video is five short clips you have not posted yet.' }],
    },
  })
  const prompt = await ctx.client.getPrompt({ name: 'write_post', arguments: { brand_id: ctx.brandId, platforms: 'x,linkedin', topic: 'our new clip feature' } })
  const promptText = JSON.stringify(prompt.messages)
  assertMatch(promptText, /Direct, warm/, 'write_post loads the voice profile')

  const imp = await call(ctx, 'import_past_posts', { brandId: ctx.brandId, platforms: ['x', 'linkedin'], limitPerPlatform: 10 })
  assertMatch(textOf(imp), /import/i, 'import_past_posts answer')
  await waitFor(
    'the past-post import',
    async () => {
      const row = await ctx.app.db.one<{ n: number }>(`select count(*)::int as n from past_posts where brand_id = $1`, [ctx.brandId])
      return row && row.n > 0 ? row.n : undefined
    },
    { timeoutMs: 60_000 },
  )
  const analytics = await call(ctx, 'get_analytics', { brandId: ctx.brandId, days: 7 })
  assert(textOf(analytics).length > 0, 'get_analytics returned nothing')
  const review = await ctx.client.getPrompt({ name: 'weekly_review', arguments: { brand_id: ctx.brandId } })
  assert(review.messages.length > 0, 'weekly_review returned no messages')
}

// ---------------------------------------------------------------------------------------------
// Browser checks: drive links, web approval, approval card in an MCP Apps host
// ---------------------------------------------------------------------------------------------

async function driveLinkRefused(ctx: Ctx): Promise<void> {
  const { page } = ctx
  await page.goto('/app/media', { waitUntil: 'networkidle' })
  const field = page.locator('#drive-url')
  await field.fill('https://www.youtube.com/watch?v=dQw4w9WgXcQ')
  const help = page.locator('#drive-url-help')
  await waitFor('the client-side refusal', async () => {
    const t = await help.innerText()
    return /youtube|video site|own/i.test(t) ? t : undefined
  })
  const submit = page.getByRole('button', { name: 'Add link' })
  assert(await submit.isDisabled(), 'Add link is enabled for a YouTube link')
  // the server refuses too: submit the form with the button forced on
  await page.locator('form[aria-label="Add a cloud-drive link"] input[name="rightsAttested"]').check()
  const before = await ctx.app.db.one<{ n: number }>(`select count(*)::int as n from media_assets where user_id = $1`, [ctx.userId])
  await submit.evaluate((b) => {
    ;(b as HTMLButtonElement).disabled = false
    ;(b as HTMLButtonElement).form?.requestSubmit(b as HTMLButtonElement)
  })
  const alert = page.locator('form[aria-label="Add a cloud-drive link"] [role="alert"], [role="status"]').filter({ hasText: /youtube|video site|own|not accepted|cannot/i })
  await alert.first().waitFor({ timeout: 15_000 })
  log(`server refusal: ${(await alert.first().innerText()).trim().slice(0, 200)}`)
  const after = await ctx.app.db.one<{ n: number }>(`select count(*)::int as n from media_assets where user_id = $1`, [ctx.userId])
  assertEqual(after?.n, before?.n, 'media rows after a refused YouTube link')
  await field.fill('')
}

async function webApproval(ctx: Ctx): Promise<void> {
  // the card nonce of the first clip draft, opened in the web app's one-click page
  const draftId = ctx.clipDraftIds[0] as string
  const card = await call(ctx, 'approve_draft', { draftId })
  const nonce = (card._meta?.approvalCard as { nonce: string }).nonce
  const { page, watcher } = ctx
  if (SCREENSHOTS) await capture(page, 'approve-nonce', `/approve/${nonce}`, { watcher, waitFor: 'main h1' })
  else await page.goto(`/approve/${nonce}`)
  // TikTok needs an explicit "who can see this" choice before the draft can be approved
  const approveButton = page.getByRole('button', { name: /^Approve/ }).first()
  assert(await approveButton.isDisabled(), 'Approve is enabled before choosing TikTok privacy')
  await page.locator('form[aria-label="TikTok privacy"] select').selectOption('FOLLOWER_OF_CREATOR')
  await Promise.all([page.waitForURL(/result=saved/, { timeout: 20_000 }), page.locator('form[aria-label="TikTok privacy"] button').click()])
  assert(!page.url().includes(nonce), 'the privacy edit did not move to a fresh nonce')
  await approveButton.click()
  await page.waitForURL(/result=approved/, { timeout: 20_000 })
  const privacy = await ctx.app.db.one<{ level: string }>(
    `select options->>'privacyLevel' as level from draft_variants where draft_id = $1 and platform = 'tiktok'`,
    [draftId],
  )
  assertEqual(privacy?.level, 'FOLLOWER_OF_CREATOR', 'TikTok privacy saved from the web page')
  const row = await ctx.app.db.one<{ status: string; approved_via: string }>(`select status, approved_via from drafts where id = $1`, [draftId])
  assertEqual(row?.status, 'approved', 'clip draft after web approval')
  assertEqual(row?.approved_via, 'web', 'approved_via')
}

async function cardHarness(ctx: Ctx): Promise<void> {
  const draftId = ctx.carouselDraftId as string
  const toolArgs = { draftId }
  const toolResult = await call(ctx, 'approve_draft', toolArgs)
  const res = await ctx.client.readResource({ uri: CARD_URI })
  const cardHtml = String((res.contents[0] as { text: string }).text)
  const page = await openCardHarness(ctx.context, { cardHtml, toolArgs, toolResult }, (name, a) => ctx.client.callTool({ name, arguments: a }))
  const watcher = watchPage(page)
  const frame = page.frameLocator('#card')
  await page.waitForFunction(() => (window as unknown as { __harnessState: { initialized: boolean } }).__harnessState.initialized, null, { timeout: 15_000 })
  await frame.getByRole('button', { name: /^Approve/ }).waitFor({ timeout: 15_000 })
  // the slide thumbnails load from the app's presigned media URLs (allowed by the card's CSP)
  await frame.locator('img').first().waitFor({ timeout: 15_000 })
  await waitFor('the slide thumbnails to load', async () => {
    const loaded = await frame.locator('img').evaluateAll((imgs) => imgs.every((i) => (i as HTMLImageElement).complete && (i as HTMLImageElement).naturalWidth > 0))
    return loaded ? true : undefined
  }, { timeoutMs: 15_000, intervalMs: 250 })
  await sleep(300)
  if (SCREENSHOTS) await save(page, 'approval-card')
  // TikTok privacy must be chosen in the card first (approval_edit_variant → a fresh nonce)
  const approve = frame.getByRole('button', { name: /^Approve/ })
  assert(await approve.isDisabled(), 'Approve is enabled before choosing TikTok privacy')
  await frame.getByRole('tab', { name: /TikTok/ }).click()
  await frame.locator('#tiktok-privacy').selectOption('PUBLIC_TO_EVERYONE')
  await waitFor('Approve to become enabled', async () => ((await approve.isEnabled()) ? true : undefined), { timeoutMs: 15_000, intervalMs: 250 })
  // the card's Approve button → tools/call approval_decide (nonce from _meta) → real server
  await approve.click()
  await frame.getByText(/approved/i).first().waitFor({ timeout: 15_000 })
  const state = await page.evaluate(() => (window as unknown as { __harnessState: { toolCalls: string[]; modelContext: unknown[] } }).__harnessState)
  assertEqual(state.toolCalls.join(','), 'approval_edit_variant,approval_decide', 'tool calls made by the card')
  assert(state.modelContext.length > 0, 'the card did not tell the model about the approval')
  const row = await ctx.app.db.one<{ status: string; approved_via: string }>(`select status, approved_via from drafts where id = $1`, [draftId])
  assertEqual(row?.status, 'approved', 'carousel draft after the card approval')
  assertEqual(row?.approved_via, 'mcp', 'approved_via')
  if (SCREENSHOTS) await save(page, 'approval-card-approved')
  if (watcher.errors.length > 0) throw new Error(`approval card harness: ${watcher.errors.join('; ')}`)
  await page.close()

  // schedule the approved carousel for tomorrow (an upcoming item on the calendar)
  const tomorrow = new Date(Date.now() + 26 * 3600_000).toISOString()
  await call(ctx, 'schedule_post', { draftId, at: tomorrow })
}

async function pageScreenshots(ctx: Ctx): Promise<void> {
  const { page, watcher } = ctx
  // approvals queue with the remaining pending clip draft
  await capture(page, 'app-approvals', '/app/approvals', { watcher })
  const queueText = await page.locator('main').innerText()
  assertMatch(queueText, /Awaiting approval[\s\S]*From a clip/, 'the approvals queue shows the pending clip draft')
  assertMatch(queueText, /Who can see this TikTok post/, 'the approvals queue offers the TikTok privacy choice')
  // the week view starts on Monday: show the whole week so today's posts are in the picture
  await capture(page, 'app-calendar', '/app/calendar', { watcher, fullPage: true })
  for (const [name, path] of [
    ['app-overview', '/app'],
    ['app-brands', '/app/brands'],
    ['app-accounts', '/app/accounts'],
    ['app-media', '/app/media'],
    ['app-clips', '/app/clips'],
    ['app-voice', '/app/voice'],
    ['app-analytics', '/app/analytics'],
    ['app-billing', '/app/billing'],
    ['app-connect', '/app/connect'],
  ] as const) {
    await capture(page, name, path, { watcher })
  }
  // overview shows the clip usage
  await page.goto('/app', { waitUntil: 'load' })
  const overview = await page.locator('main').innerText()
  // 20 s of source video used of the trial's 1 clipping hour
  assertMatch(overview, /Clipping hours\s*1 min of 1 h/, 'overview shows the clip usage')

  // landing page on a phone
  const mobile = await ctx.browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, baseURL: ctx.app.appUrl })
  const m = await mobile.newPage()
  const mw = watchPage(m)
  await capture(m, 'landing-mobile', '/', { watcher: mw })
  await mobile.close()
}

// ---------------------------------------------------------------------------------------------
// Security checks at the end (the last one revokes our tokens)
// ---------------------------------------------------------------------------------------------

async function securityChecks(ctx: Ctx): Promise<void> {
  const url = `${ctx.app.appUrl}/api/mcp`
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }
  const anon = await fetch(url, { method: 'POST', headers, body })
  assertEqual(anon.status, 401, '/api/mcp without a token')
  const challenge = anon.headers.get('www-authenticate') ?? ''
  assertMatch(challenge, /^Bearer /, 'WWW-Authenticate scheme')
  const m = /resource_metadata="([^"]+)"/.exec(challenge)
  assert(m, `WWW-Authenticate lacks resource_metadata: ${challenge}`)
  const prm = (await (await fetch(m[1] as string)).json()) as { resource?: string; authorization_servers?: string[] }
  assertEqual(prm.resource, url, 'protected resource metadata: resource')
  assertEqual(prm.authorization_servers?.[0], ctx.app.appUrl, 'protected resource metadata: authorization server')
  const asMeta = (await (await fetch(`${ctx.app.appUrl}/.well-known/oauth-authorization-server`)).json()) as { code_challenge_methods_supported?: string[]; registration_endpoint?: string }
  assert(asMeta.code_challenge_methods_supported?.includes('S256'), 'AS metadata lacks S256')
  assert(asMeta.registration_endpoint, 'AS metadata lacks registration_endpoint')

  // the proxy (formerly middleware) keeps the consent and approval pages out of frames and referrers
  for (const path of ['/oauth/authorize?response_type=code&client_id=nope', '/approve/not-a-real-nonce-but-long-enough']) {
    const res = await ctx.context.request.get(path, { maxRedirects: 0 })
    const h = res.headers()
    assertEqual(h['x-frame-options'], 'DENY', `${path} x-frame-options`)
    assertEqual(h['referrer-policy'], 'no-referrer', `${path} referrer-policy`)
    assertMatch(h['content-security-policy'] ?? '', /frame-ancestors 'none'/, `${path} frame-ancestors`)
  }
  const mcpHeaders = (await fetch(url, { method: 'POST', headers, body })).headers
  assert(mcpHeaders.get('x-frame-options') === null, 'the proxy touched /api/mcp')

  const bad = await fetch(url, { method: 'POST', headers: { ...headers, authorization: 'Bearer not-a-real-token' }, body })
  assertEqual(bad.status, 401, '/api/mcp with a made-up token')
  assertMatch(bad.headers.get('www-authenticate') ?? '', /invalid_token/, 'invalid_token error')

  // reusing a rotated refresh token is refused and revokes the whole token family
  const first = ctx.mcp.provider.tokenHistory[0]
  const clientId = ctx.mcp.provider.clientInformation()?.client_id as string
  const reuse = await fetch(`${ctx.app.appUrl}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: first?.refresh_token as string, client_id: clientId }),
  })
  assertEqual(reuse.status, 400, 'reused refresh token')
  assertEqual(((await reuse.json()) as { error?: string }).error, 'invalid_grant', 'reused refresh token error')
  const current = ctx.mcp.provider.tokens()?.access_token as string
  const revoked = await fetch(url, { method: 'POST', headers: { ...headers, authorization: `Bearer ${current}` }, body })
  assertEqual(revoked.status, 401, 'access token after refresh-token reuse (family revoked)')
}

// ---------------------------------------------------------------------------------------------

function tail(file: string, lines = 30): string {
  try {
    return readFileSync(file, 'utf8').trim().split('\n').slice(-lines).join('\n')
  } catch {
    return '(no log)'
  }
}

async function main(): Promise<void> {
  ensureBrowsersPath()
  let app: App | null = null
  let failed = false
  const shutdown = async (signal: string) => {
    log(`${signal}: stopping everything`)
    await stopAll()
    process.exit(130)
  }
  process.once('SIGINT', () => void shutdown('SIGINT'))
  process.once('SIGTERM', () => void shutdown('SIGTERM'))

  try {
    app = await check('infrastructure: postgres, migrations, web build + start, worker', () =>
      startApp({ runDir: RUN_DIR, pgDir: PG_DIR, skipBuild: Boolean(args['skip-build']), whisper: Boolean(args.whisper), videoSeconds: VIDEO_SECONDS }),
    )
    const browser = await playwright.chromium.launch({ headless: true })
    onStop('chromium', () => browser.close())
    const callback = await startCallbackServer(await freePort())
    onStop('oauth callback server', () => callback.close())

    const a = app
    const signed = await check('browser: landing, login, dev sign-in', () => signIn(a, browser))
    const userRow = await a.db.one<{ id: string; plan: string; subscription_status: string }>(`select id, plan, subscription_status from users where email = $1`, [EMAIL])
    assert(userRow, 'the dev login did not create the app user')
    assertEqual(userRow.subscription_status, 'trialing', 'new user starts a trial')
    const brandId = await check('browser: create a brand', () => createBrand({ app: a, page: signed.page, watcher: signed.watcher }, userRow.id))

    const mcp = await check('MCP: OAuth (DCR + PKCE + consent in Chromium + code exchange) and connect', () =>
      connectWithOAuth({
        appUrl: a.appUrl,
        callback,
        page: signed.page,
        onConsent: async (p) => {
          if (SCREENSHOTS) await capture(p, 'oauth-consent', null, { watcher: signed.watcher })
        },
      }),
    )
    const ctx: Ctx = { app: a, browser, ...signed, mcp, client: mcp.client, userId: userRow.id, brandId, clipIds: [], clipDraftIds: [] }

    await check('MCP: tools/list titles + hints, prompts, card resource', () => checkToolList(ctx))
    await check('MCP: refresh token (forced 401 → SDK refresh → rotation)', () => checkRefresh(ctx))
    await check('MCP: connect_account + list_accounts (fake provider)', () => connectAccounts(ctx))
    await check('MCP: create_draft (X link refused), approve_draft card + nonce, approval_decide, schedule_post', () => draftApproveSchedule(ctx))
    await check('auto-post: switch on in the web app, upload_media + curl, publish_video', () => autoPostFlow(ctx))
    await check('clips: upload → ingest → transcript → make_clips → 1080x1920 drafts, usage', () => clipFlow(ctx))
    await check('render_carousel → JPEG slides → draft', () => carouselFlow(ctx))
    await check('voice profile, write_post, import_past_posts, get_analytics, weekly_review', () => voiceAndAnalytics(ctx))
    await check(`worker publishes the scheduled post via the fake provider (scheduled +${SCHEDULE_DELAY_SEC}s)`, () => waitPublished(ctx))
    await check('auto-post: the worker publishes the video via the fake provider (approved via auto_post)', () => waitAutoPublished(ctx))
    await check('web: a YouTube drive link is refused (client and server)', () => driveLinkRefused(ctx))
    await check('approval card in an MCP Apps host harness (Approve → approval_decide)', () => cardHarness(ctx))
    await check('web: /approve/[nonce] one-click approval', () => webApproval(ctx))
    if (SCREENSHOTS) await check('screenshots of every page', () => pageScreenshots(ctx))
    await check('security: 401 + WWW-Authenticate, page headers, invalid token, refresh-token reuse', () => securityChecks(ctx))

    const health = (await (await fetch(a.workerHealthUrl)).json()) as { counts?: Record<string, number> }
    log(`worker counts: ${JSON.stringify(health.counts)}`)
    assertEqual(health.counts?.dead ?? 0, 0, 'dead jobs in the worker')
    const errors = readFileSync(a.logs.web, 'utf8').split('\n').filter((l) => /"level":"error"|⨯|Error:/.test(l))
    assert(errors.length === 0, `the web server logged errors:\n${errors.slice(0, 10).join('\n')}`)
  } catch (error) {
    failed = true
    process.stderr.write(`\nE2E FAILED: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`)
    if (app) {
      process.stderr.write(`\n--- web log (${app.logs.web}) ---\n${tail(app.logs.web)}\n`)
      process.stderr.write(`\n--- worker log (${app.logs.worker}) ---\n${tail(app.logs.worker)}\n`)
    }
  } finally {
    if (args.keep && !failed && app) {
      log(`--keep: web ${app.appUrl}, worker ${app.workerHealthUrl}, db ${app.dbUrl}. Ctrl-C stops everything.`)
      await new Promise(() => undefined)
    }
    await stopAll()
  }

  if (shots.length > 0) {
    const total = readdirSync(SHOTS_DIR)
      .filter((f) => f.endsWith('.png'))
      .reduce((n, f) => n + statSync(join(SHOTS_DIR, f)).size, 0)
    log(`${shots.length} screenshots in ${SHOTS_DIR.replace(`${REPO}/`, '')} (${formatBytes(total)} total)`)
  }
  log(`${passed.length} checks passed${failed ? ', then a check FAILED' : ''}`)
  for (const name of passed) log(`  ✔ ${name}`)
  process.exitCode = failed ? 1 : 0
}

void main()
