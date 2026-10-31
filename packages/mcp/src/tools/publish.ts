// The "AI made a video" pipeline: upload_media (a coding AI PUTs the finished file, or any AI
// sends an https link to it), render_code_video (a chat AI sends an HTML animation; we render the
// MP4) and publish_video (video + caption → draft → posted automatically when the user turned the
// brand's Auto-post switch on in the web app, otherwise the approval card). The rule itself lives in
// @app/services (autoPost); the switch can only be changed in the web app.

import { z } from 'zod'
import { CODE_VIDEO_LIMITS, IdSchema, PublishVideoInputSchema, RenderCodeVideoInputSchema } from '@app/core/validation'
import type { AutoPostResult } from '@app/services'
import { APPROVAL_CARD_URI, APPROVAL_META_KEY } from '../constants'
import type { McpContext } from '../context'
import { listText, ok, plural } from '../results'
import { jobViewForModel, mediaViewForModel, postView, previewView } from '../views'
import { cardMeta, modelPreview, postLine, previewLines, webApprovalUrl } from './drafts'
import type { ToolDef } from './types'

/** POSIX shell single-quoting (the AI pastes the command into a shell). */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/** A ready-to-run curl command that PUTs `file` to a presigned URL with the signed headers. */
export function curlCommand(file: string, url: string, headers: Readonly<Record<string, string>>): string {
  const h = Object.entries(headers).map(([k, v]) => `-H ${shellQuote(`${k}: ${v}`)}`)
  return ['curl --fail --silent --show-error -X PUT', ...h, `--upload-file ${shellQuote(file)}`, shellQuote(url)].join(' ')
}

/** One line on what happens to an autoPublish request, given the brand's switch (read-only for the AI). */
export async function autoPublishNote(ctx: McpContext, brandId: unknown, autoPublish: unknown): Promise<string | null> {
  if (!autoPublish || typeof brandId !== 'string') return null
  const brand = await ctx.services.brands.get(ctx.userId, brandId).catch(() => null)
  if (!brand) return null
  return brand.autoPostEnabled
    ? `Auto-post is on for ${brand.name}: when the render finishes, its draft is posted automatically if it passes the checks (platform list, daily limit ${brand.autoPostDailyMax}, platform rules and caps); otherwise it waits for approval.`
    : `Auto-post is off for ${brand.name}: the draft will wait for the user's approval (show it with approve_draft). Only the user can turn Auto-post on, in the web app.`
}

// ---------------------------------------------------------------------------------------------
// upload_media
// ---------------------------------------------------------------------------------------------

const UploadMediaToolSchema = z
  .strictObject({
    brandId: IdSchema.optional(),
    kind: z.enum(['video', 'image', 'audio']).optional(),
    filename: z.string().trim().min(1).max(1024).optional(),
    contentType: z.string().trim().min(1).max(127).optional(),
    bytes: z.number().int().min(1).optional(),
    sourceUrl: z.string().trim().min(1).max(2048).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.sourceUrl !== undefined) {
      if (v.filename !== undefined || v.contentType !== undefined || v.bytes !== undefined) {
        ctx.addIssue({ code: 'custom', path: ['sourceUrl'], message: 'Give either sourceUrl, or filename + contentType + bytes (not both).' })
      }
      if (v.kind === 'audio') ctx.addIssue({ code: 'custom', path: ['kind'], message: 'A sourceUrl import takes a video or an image.' })
      return
    }
    for (const key of ['filename', 'contentType', 'bytes'] as const) {
      if (v[key] === undefined) ctx.addIssue({ code: 'custom', path: [key], message: `${key} is required (or give sourceUrl instead).` })
    }
  })

export const uploadMedia: ToolDef = {
  name: 'upload_media',
  title: 'Upload a finished video or image',
  description:
    'Sends a finished file you made (video, image or audio) to the user\'s media library, to post with publish_video or create_draft. ' +
    'Coding assistants with a shell (Claude Code, Cursor, Codex): call this with filename (the local path), contentType (e.g. video/mp4) and bytes (the exact size, e.g. from `wc -c < file`), then run the returned `curl` command from the directory you named the file from (it PUTs the file to a one-hour upload URL; do not change its headers), then call publish_video with the mediaId. ' +
    'Assistants without a shell: give sourceUrl instead, an https link to a finished video or image that you or another tool rendered; we download it. Links to YouTube, TikTok, Instagram, X, Facebook, Vimeo, Twitch or other video sites are refused: only post videos the user made. ' +
    'Files are post media only (not clip sources: videos to clip are added by the user in the web app).',
  input: UploadMediaToolSchema,
  describe: {
    brandId: 'The brand the file is for (optional; from list_accounts).',
    kind: 'video, image or audio (default: from contentType; video for sourceUrl).',
    filename: 'Local path of the file the curl command uploads, e.g. "out/final.mp4".',
    contentType: 'MIME type: video/mp4, video/quicktime, video/webm, image/jpeg, image/png, image/webp, audio/mpeg, ...',
    bytes: 'Exact file size in bytes (the upload must match it). At most 5 GB.',
    sourceUrl: 'Instead of uploading: an https link to the finished video or image (no video-site links).',
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  async run(ctx, args) {
    if (typeof args.sourceUrl === 'string') {
      const { media } = await ctx.services.media.importFromUrl(
        ctx.userId,
        { url: args.sourceUrl, kind: args.kind ?? 'video', ...(typeof args.brandId === 'string' ? { brandId: args.brandId } : {}) },
        { via: 'mcp' },
      )
      return ok(
        [
          `Fetching the ${media.kind} from ${media.sourceHost ?? 'the link'} (media ${media.id}, ${media.status}).`,
          `Next: call publish_video with mediaId=${media.id}. It is posted (or shown for approval) once the file is fetched and checked; if the link cannot be downloaded, publish_video and post_status say why.`,
        ].join('\n'),
        { mediaId: media.id, status: media.status, kind: media.kind, origin: media.origin, host: media.sourceHost, media: mediaViewForModel(media) },
      )
    }
    const res = await ctx.services.media.createAiUpload(ctx.userId, args, { via: 'mcp' })
    if (res.upload.mode !== 'single') throw new Error('AI uploads are single PUTs')
    const file = String(args.filename)
    const curl = curlCommand(file, res.upload.url, res.upload.headers)
    return ok(
      [
        `Upload URL ready for media ${res.media.id} (${res.media.kind}, ${plural(res.upload.bytes, 'byte')}, valid until ${res.upload.expiresAt}).`,
        'Run this command (it uploads the file with an HTTP PUT; keep the headers exactly as they are):',
        curl,
        `Then call publish_video with mediaId=${res.media.id} and a caption (or create_draft with mediaIds). The file is checked (size and type) when it is first used.`,
      ].join('\n'),
      {
        mediaId: res.media.id,
        uploadUrl: res.upload.url,
        method: 'PUT',
        headers: res.upload.headers,
        expiresAt: res.upload.expiresAt,
        bytes: res.upload.bytes,
        curl,
        media: mediaViewForModel(res.media),
      },
    )
  },
}

// ---------------------------------------------------------------------------------------------
// render_code_video
// ---------------------------------------------------------------------------------------------

const AUTO_PUBLISH_DESCRIBE =
  'Optional { platforms?, when?: "now" | "best" | ISO time }: when the render finishes, its draft goes through the brand\'s Auto-post rule (posted automatically only if the user turned Auto-post on in the web app; otherwise it waits for approval).'

export const renderCodeVideo: ToolDef = {
  name: 'render_code_video',
  title: 'Render a video from HTML',
  description:
    'Renders an animation you write as ONE self-contained HTML document into an MP4 (H.264, 1–60 s, 24 or 30 fps) for posting. ' +
    'Everything must be inline (CSS, JS, fonts and images as small data: URIs): every network request is blocked. The page is 1080×1920 (9:16, default), 1080×1080 (1:1) or 1920×1080 (16:9). ' +
    'Make it deterministic: define window.seek = (ms) => { /* draw the frame at ms */ } (it may return a Promise); we call it for every frame. Without seek, CSS animations and the Web Animations API are stepped frame by frame and timers, requestAnimationFrame and Date run on a virtual clock. ' +
    `At most ${CODE_VIDEO_LIMITS.maxHtmlBytes / 1000} KB of HTML. Optional background audio (audioMediaId from upload_media), title and caption for the draft. ` +
    'Runs in the background: check post_status with the jobId; the result has the video media id and a draftId (show it with approve_draft, or set autoPublish).',
  input: RenderCodeVideoInputSchema,
  describe: {
    brandId: 'The brand id (from list_accounts).',
    html: 'A complete, self-contained HTML document (no external URLs).',
    durationMs: 'Length in milliseconds (1000–60000).',
    fps: '24 or 30 (default 30).',
    aspect: '9:16 (1080×1920, default), 1:1 (1080×1080) or 16:9 (1920×1080).',
    audioMediaId: 'Background audio media id (optional; e.g. from upload_media).',
    title: 'Title for platforms that use one (YouTube).',
    caption: 'Post text for the draft.',
    autoPublish: AUTO_PUBLISH_DESCRIBE,
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  async run(ctx, args) {
    const job = await ctx.services.renders.requestCodeVideo(ctx.userId, args, { via: 'mcp' })
    const seconds = typeof args.durationMs === 'number' ? args.durationMs / 1000 : 0
    const note = await autoPublishNote(ctx, args.brandId, args.autoPublish)
    return ok(
      [
        `Rendering a ${seconds} s video from your HTML (job ${job.id}, ${job.status}). Check with post_status jobId=${job.id}.`,
        'When it succeeds its result has the video media id and a draftId (a draft already made for the brand\'s connected video accounts).',
        note ?? 'Show that draft with approve_draft (or call publish_video with the media id to use Auto-post).',
      ].join('\n'),
      { job: jobViewForModel(job) },
    )
  },
}

// ---------------------------------------------------------------------------------------------
// publish_video
// ---------------------------------------------------------------------------------------------

const PUBLISH_TOOL_META = {
  ui: { resourceUri: APPROVAL_CARD_URI },
  'openai/outputTemplate': APPROVAL_CARD_URI,
  'openai/widgetAccessible': true,
  'openai/toolInvocation/invoking': 'Sending the video…',
  'openai/toolInvocation/invoked': 'Video sent',
} as const

function outcomeLine(result: AutoPostResult): string {
  return result.outcome === 'waiting_for_media' ? `Waiting: ${result.message}` : `Not posted yet: ${result.message}`
}

export const publishVideo: ToolDef = {
  name: 'publish_video',
  title: 'Publish a finished video',
  description:
    'One call to post a finished video (a mediaId from upload_media, render_code_video, render_video or a clip) with its caption to the brand\'s connected video platforms (TikTok, YouTube, Instagram, Facebook, LinkedIn, X, Threads, Pinterest, Bluesky). ' +
    'It saves a draft, then: if the user turned on Auto-post for the brand in the web app (and the platform list, daily limit, platform rules and caps allow it) it is approved by that rule and scheduled ("now" = the next minute, "best" = the platform\'s default slot in the brand\'s time zone, or an ISO time); otherwise it shows the approval card (and a web link) so the user approves, edits or rejects it, and says why it was not posted. ' +
    'You cannot turn Auto-post on: only the user can, in the web app. X posts may not contain links.',
  input: PublishVideoInputSchema,
  describe: {
    brandId: 'The brand id (from list_accounts).',
    mediaId: 'The video media id (from upload_media, or a render or clip).',
    caption: 'The post text for every platform (write it in the brand\'s voice: list_accounts with the brandId has the brief).',
    title: 'Title for platforms that have one (YouTube requires it). Default: the caption\'s first line.',
    overrides: 'Per-platform text/title, e.g. { "youtube": { "title": "..." }, "x": { "text": "..." } }.',
    platforms: 'Only these platforms (default: every connected platform that takes videos).',
    when: '"now" (default: the next minute), "best" (the platform\'s usual best slot in the brand\'s time zone) or an ISO 8601 time with offset.',
  },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  meta: { ...PUBLISH_TOOL_META },
  async run(ctx, args) {
    const { services, userId } = ctx
    const res = await services.autoPost.publishVideo(userId, args, { via: 'mcp' })
    const draftId = res.draft.draft.id
    const preview = await services.drafts.preview(userId, draftId)
    const webUrl = webApprovalUrl(ctx, draftId)
    const auto = res.autoPost
    const base = { draftId, autoPosted: auto.autoPosted, outcome: auto.outcome, approvalUrl: webUrl, preview: modelPreview(preview) }
    if (auto.autoPosted) {
      return ok(
        [
          `Posted automatically: ${auto.message}`,
          ...auto.posts.map(postLine),
          `Check progress with post_status (draftId=${draftId}).`,
        ].join('\n'),
        { ...base, message: auto.message, posts: auto.posts.map(postView) },
        // the card shows the approved draft (no nonce: there is nothing left to approve)
        { [APPROVAL_META_KEY]: { webUrl, preview: previewView(preview), autoPosted: true } },
      )
    }
    const nonce = await services.approvals.issueNonce(userId, draftId, { via: 'mcp' })
    const platforms = listText(preview.variants.map((v) => v.label))
    return ok(
      [
        outcomeLine(auto),
        `Showing the approval card for draft ${draftId} (${preview.brand.name}: ${platforms}). The user approves, edits or rejects it there.`,
        ...previewLines(preview),
        ...preview.problems.map((p) => `- ${p}`),
        `If the card does not appear, ask the user to review it in the web app: ${webUrl}`,
        auto.outcome === 'waiting_for_media'
          ? `Check later with post_status (draftId=${draftId}).`
          : 'After the user approves, call schedule_post with this draftId.',
      ].join('\n'),
      { ...base, reason: auto.message, status: preview.draft.status },
      cardMeta(preview, nonce, webUrl),
    )
  },
}
