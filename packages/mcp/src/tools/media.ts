// Clipping and rendering: get_transcript, make_clips, render_carousel, render_video.
// Clips are cut from the user's own uploads / drive links (never YouTube); renders are templates
// (HTML slides → images, slides + captions → MP4), not AI image or video generation.

import { z } from 'zod'
import { formatMs } from '@app/core/time'
import {
  CAPTION_STYLES,
  ClipRequestSchema,
  GetTranscriptInputSchema,
  IdSchema,
  RenderCarouselInputSchema,
  RenderVideoInputSchema,
} from '@app/core/validation'
import { isClipSource, type TranscriptView } from '@app/services'
import { pageSegments, pickClipsRules, wordTimings, WORD_RANGE_MAX_MS } from '../playbook'
import { excerpt, ok, plural } from '../results'
import { clipView, jobViewForModel, mediaViewForModel } from '../views'
import type { McpContext } from '../context'
import { autoPublishNote } from './publish'
import { READ_ONLY, type ToolDef } from './types'

const TIMESTAMP = 'Milliseconds (number), or a timestamp string like "01:23.500" or "83.5s".'

const AUTO_PUBLISH =
  'Optional { platforms?, when?: "now" | "best" | ISO time }: when the render finishes, its draft goes through the brand\'s Auto-post rule (posted automatically only if the user turned Auto-post on in the web app; otherwise it waits for approval).'

/** Tools that can publish through autoPublish touch the outside world. */
const RENDER_ANNOTATIONS = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } as const

/** get_transcript without mediaId lists the user's clip sources (so the AI can find the id). */
const GetTranscriptToolSchema = z
  .strictObject({ ...GetTranscriptInputSchema.shape, mediaId: IdSchema.optional() })
  .refine((v) => v.startMs === undefined || v.endMs === undefined || v.endMs > v.startMs, {
    message: 'endMs must be after startMs.',
    path: ['endMs'],
  })

function range(s: number, e: number): string {
  return `[${formatMs(s)}–${formatMs(e)} | ${s}–${e} ms]`
}

interface TranscriptPage {
  text: string
  structured: Record<string, unknown>
}

/**
 * The model-facing transcript: segments within a text budget (with nextStartMs to page), word
 * timings ("word@startMs") for short ranges, and the clip-picking rules on the first page. The
 * structured copy holds only what the text shows, so a long video never floods the context.
 */
function transcriptPage(t: TranscriptView, args: { startMs?: number | undefined; endMs?: number | undefined; query?: string | undefined }): TranscriptPage {
  const base = { mediaId: t.mediaId, status: t.status, language: t.language, durationMs: t.durationMs, ...(t.engine ? { engine: t.engine } : {}) }
  if (t.status !== 'ready') {
    const text = `Transcript of ${t.mediaId}: ${t.status}. ${t.message ?? ''}`.trim()
    return { text, structured: { ...base, ...(t.message ? { message: t.message } : {}), segments: [] } }
  }
  const lines = [`Transcript of ${t.mediaId} (${t.language ?? 'unknown language'}, ${formatMs(t.durationMs ?? 0)} long).`]
  if (t.matches) {
    lines.push(t.matches.length === 0 ? 'No segment matches the query.' : `${plural(t.matches.length, 'matching segment')}:`)
    lines.push(...t.matches.map((m) => `${range(m.startMs, m.endMs)} ${m.text}`))
    lines.push('Use these millisecond ranges with make_clips (startMs/endMs), or read around a match with get_transcript { mediaId, startMs, endMs }.')
    return { text: lines.join('\n'), structured: { ...base, matches: t.matches } }
  }
  const ranged = args.startMs !== undefined || args.endMs !== undefined
  const page = pageSegments(t.segments)
  if (ranged) lines.push(`Segments from ${formatMs(args.startMs ?? 0)}${args.endMs !== undefined ? ` to ${formatMs(args.endMs)}` : ''}:`)
  lines.push(...page.lines)
  const structured: Record<string, unknown> = { ...base, segments: page.shown, nextStartMs: page.nextStartMs }
  if (page.nextStartMs !== null) {
    lines.push(`More follows. Call get_transcript { mediaId: "${t.mediaId}", startMs: ${page.nextStartMs} } for the next part.`)
  }
  const span = (args.endMs ?? Number.MAX_SAFE_INTEGER) - (args.startMs ?? 0)
  if (ranged && t.words && span <= WORD_RANGE_MAX_MS) {
    const words = wordTimings(t.words)
    lines.push(`Word timings (word@startMs)${words.complete ? '' : ', first part only (ask for a narrower range for the rest)'}:`, words.text || '(no words in this range)')
    structured.words = words.shown
  } else if (ranged) {
    lines.push(`For word timings, ask for a range of ${WORD_RANGE_MAX_MS / 60_000} minutes or less.`)
  } else {
    lines.push('', ...pickClipsRules(t.mediaId), '')
  }
  lines.push('Use these millisecond ranges with make_clips (startMs/endMs).')
  return { text: lines.join('\n'), structured }
}

/** The no-argument listing: source videos (to transcribe and clip) and ready images / audio / other videos. */
async function mediaLibrary(ctx: McpContext) {
  const [videos, images, audio] = await Promise.all([
    ctx.services.media.list(ctx.userId, { kind: 'video', limit: 50 }),
    ctx.services.media.list(ctx.userId, { kind: 'image', status: 'ready', limit: 50 }),
    ctx.services.media.list(ctx.userId, { kind: 'audio', status: 'ready', limit: 20 }),
  ])
  const sources = videos.items.filter((m) => isClipSource(m) && m.status !== 'deleted')
  const otherVideos = videos.items.filter((m) => !isClipSource(m) && m.status === 'ready')
  return { sources, otherVideos, images: images.items, audio: audio.items }
}

export const getTranscript: ToolDef = {
  name: 'get_transcript',
  title: 'Get a video transcript',
  description:
    'Returns the timestamped transcript of one of the user\'s source videos (segments with start/end in milliseconds) with the rules for picking clips. Long transcripts come in parts: call again with startMs = nextStartMs. ' +
    'A range of 5 minutes or less (startMs/endMs) adds word timings for precise cuts; query returns only the matching segments. ' +
    'Without mediaId it lists the user\'s media library with ids: source videos (to clip), and ready images, audio and other videos (for create_draft mediaIds, render_carousel imageMediaId, render_video imageMediaId / audioMediaId).',
  input: GetTranscriptToolSchema,
  describe: {
    mediaId: 'The source video id. Omit to list the user\'s media (videos, images, audio) with their ids.',
    startMs: `Start of the range. ${TIMESTAMP}`,
    endMs: `End of the range. ${TIMESTAMP}`,
    query: 'Only segments containing this text (case-insensitive).',
  },
  annotations: READ_ONLY,
  async run(ctx, args) {
    if (args.mediaId === undefined) {
      const lib = await mediaLibrary(ctx)
      const total = lib.sources.length + lib.otherVideos.length + lib.images.length + lib.audio.length
      if (total === 0) {
        return ok(
          'No media yet. The user uploads a video they own (or adds a Google Drive / Dropbox / OneDrive link), images or audio on the Media page of the web app; YouTube links are not accepted.',
          { sources: [], images: [], audio: [], videos: [] },
        )
      }
      const line = (m: (typeof lib.sources)[number]) =>
        `- ${m.id}: ${m.status}${m.durationMs ? `, ${formatMs(m.durationMs)}` : ''}${m.width && m.height ? `, ${m.width}×${m.height}` : ''}, added ${m.createdAt.toISOString()}`
      const parts: string[] = []
      if (lib.sources.length > 0) {
        parts.push(`${plural(lib.sources.length, 'source video')} to transcribe and clip (newest first):`, ...lib.sources.map(line), 'Call get_transcript with one of these mediaIds.')
      } else {
        parts.push('No source videos to clip yet (the user uploads one on the Media page and confirms they own it).')
      }
      if (lib.images.length > 0) parts.push(`${plural(lib.images.length, 'image')} (create_draft mediaIds, render_carousel / render_video imageMediaId):`, ...lib.images.map(line))
      if (lib.audio.length > 0) parts.push(`${plural(lib.audio.length, 'audio file')} (render_video audioMediaId):`, ...lib.audio.map(line))
      if (lib.otherVideos.length > 0) parts.push(`${plural(lib.otherVideos.length, 'other video')} (clips and renders, for create_draft mediaIds):`, ...lib.otherVideos.map(line))
      return ok(parts.join('\n'), {
        sources: lib.sources.map(mediaViewForModel),
        images: lib.images.map(mediaViewForModel),
        audio: lib.audio.map(mediaViewForModel),
        videos: lib.otherVideos.map(mediaViewForModel),
      })
    }
    const t = await ctx.services.transcripts.get(ctx.userId, args)
    // the raw args may carry "01:23.500" style timestamps: use the parsed milliseconds
    const parsed = GetTranscriptToolSchema.safeParse(args)
    const q = parsed.success ? parsed.data : {}
    const page = transcriptPage(t, { startMs: q.startMs, endMs: q.endMs, query: q.query })
    return ok(page.text, { transcript: page.structured })
  },
}

export const makeClips: ToolDef = {
  name: 'make_clips',
  title: 'Cut vertical clips from a video',
  description:
    'Cuts vertical 9:16 clips with burned-in captions from one of the user\'s transcribed source videos, at the millisecond ranges you choose from get_transcript (3–180 s each, up to 20 per request). ' +
    'Rendering runs in the background; each finished clip becomes a draft for approval (see list_drafts, or post_status with clipId). Clipping time is charged once per source video.',
  input: ClipRequestSchema,
  describe: {
    mediaId: 'The source video id (from get_transcript).',
    brandId: 'The brand the clip drafts are for (default: the video\'s brand, or the only brand).',
    ranges: `The clips: { startMs, endMs, title?, hook? }. ${TIMESTAMP} Pick complete thoughts that hook in the first 3 seconds.`,
    captionStyle: `Caption look: ${CAPTION_STYLES.join(', ')} (default bold).`,
    autoPublish: `${AUTO_PUBLISH} Applies to each clip's draft.`,
  },
  annotations: RENDER_ANNOTATIONS,
  async run(ctx, args) {
    const clips = await ctx.services.clips.requestClips(ctx.userId, args, { via: 'mcp' })
    const lines = clips.map((c) => `- ${c.id}: ${range(c.startMs, c.endMs)}${c.title ? ` "${excerpt(c.title, 60)}"` : ''} (${c.status})`)
    const note = await autoPublishNote(ctx, clips[0]?.brandId, args.autoPublish)
    return ok(
      [
        `Queued ${plural(clips.length, 'clip')} for rendering (9:16, captions: ${clips[0]?.captionStyle ?? 'bold'}):`,
        ...lines,
        'Each clip becomes a draft when it is ready (usually a few minutes). Check with post_status (clipId) or list_drafts, then show it with approve_draft.',
        ...(note ? [note] : []),
      ].join('\n'),
      { clips: clips.map(clipView) },
    )
  },
}

export const renderCarousel: ToolDef = {
  name: 'render_carousel',
  title: 'Render a carousel from a template',
  description:
    'Renders carousel slides (heading, body, footer, optional image media id) into images with one of our HTML templates (minimal, bold, quote, list, photo). ' +
    'This is template rendering, not AI image generation. Runs in the background: check with post_status (jobId). When it succeeds the result has the image media ids and a draftId: a draft already made for the brand\'s connected accounts that take images. Show that draft with approve_draft (edit its text first if needed); do not create a second draft. Only when draftId is null, attach the media ids to a new draft with create_draft.',
  input: RenderCarouselInputSchema,
  describe: {
    brandId: 'The brand id (from list_accounts).',
    template: 'Slide template.',
    aspect: '4:5 (1080×1350, default), 1:1 or 9:16.',
    theme: 'Colours (hex) and font preset.',
    slides: '1–20 slides: { heading?, body?, footer?, imageMediaId? }.',
    autoPublish: AUTO_PUBLISH,
  },
  annotations: RENDER_ANNOTATIONS,
  async run(ctx, args) {
    const job = await ctx.services.renders.requestCarousel(ctx.userId, args, { via: 'mcp' })
    const slides = Array.isArray(args.slides) ? args.slides.length : 0
    const note = await autoPublishNote(ctx, args.brandId, args.autoPublish)
    return ok(
      `Rendering a ${plural(slides, 'slide')} carousel (job ${job.id}, ${job.status}). Check with post_status jobId=${job.id}. When it succeeds its result has a draftId (a draft already made with the images): show it with approve_draft instead of creating another draft. Only if draftId is null, attach the media ids to a draft with create_draft.${note ? `\n${note}` : ''}`,
      { job: jobViewForModel(job) },
    )
  },
}

export const renderVideo: ToolDef = {
  name: 'render_video',
  title: 'Render a video from a template',
  description:
    'Renders a short template video (text slides, quote or captioned images, optional background audio media id, up to 180 s) to MP4. ' +
    'This is template rendering, not AI video generation. Runs in the background: check with post_status (jobId). When it succeeds the result has the video media id and a draftId: a draft already made for the brand\'s connected video accounts. Show that draft with approve_draft; do not create a second draft. Only when draftId is null, attach the media id to a new draft with create_draft.',
  input: RenderVideoInputSchema,
  describe: {
    brandId: 'The brand id (from list_accounts).',
    template: 'Video template.',
    aspect: '9:16 (default), 1:1 or 16:9.',
    theme: 'Colours (hex) and font preset.',
    slides: '1–35 slides: { text?, imageMediaId?, durationMs (1000–15000, default 5000) }.',
    audioMediaId: 'Background audio media id (optional).',
    captions: 'Burn the slide text in as captions (default true).',
    autoPublish: AUTO_PUBLISH,
  },
  annotations: RENDER_ANNOTATIONS,
  async run(ctx, args) {
    const job = await ctx.services.renders.requestVideo(ctx.userId, args, { via: 'mcp' })
    const note = await autoPublishNote(ctx, args.brandId, args.autoPublish)
    return ok(
      `Rendering the video (job ${job.id}, ${job.status}). Check with post_status jobId=${job.id}. When it succeeds its result has a draftId (a draft already made with the video): show it with approve_draft instead of creating another draft. Only if draftId is null, attach the media id to a draft with create_draft.${note ? `\n${note}` : ''}`,
      { job: jobViewForModel(job) },
    )
  },
}
