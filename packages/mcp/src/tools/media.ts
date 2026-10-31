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
import { excerpt, ok, plural } from '../results'
import { clipView, jobViewForModel, mediaViewForModel } from '../views'
import { READ_ONLY, type ToolDef } from './types'

const TIMESTAMP = 'Milliseconds (number), or a timestamp string like "01:23.500" or "83.5s".'

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

function transcriptText(t: TranscriptView): string {
  if (t.status !== 'ready') return `Transcript of ${t.mediaId}: ${t.status}. ${t.message ?? ''}`.trim()
  const head = `Transcript of ${t.mediaId} (${t.language ?? 'unknown language'}, ${formatMs(t.durationMs ?? 0)} long).`
  const lines = [head]
  if (t.matches) {
    lines.push(t.matches.length === 0 ? 'No segment matches the query.' : `${plural(t.matches.length, 'matching segment')}:`)
    lines.push(...t.matches.map((m) => `${range(m.startMs, m.endMs)} ${m.text}`))
  } else {
    lines.push(...t.segments.map((s) => `${range(s.s, s.e)} ${s.t}`))
  }
  if (t.message) lines.push(t.message)
  lines.push('Use these millisecond ranges with make_clips (startMs/endMs). Ask for a range (startMs/endMs) to get word timings.')
  return lines.join('\n')
}

export const getTranscript: ToolDef = {
  name: 'get_transcript',
  title: 'Get a video transcript',
  description:
    'Returns the timestamped transcript of one of the user\'s source videos (segments with start/end in milliseconds), optionally only a time range (with word timings) or the segments matching a search query. ' +
    'Without mediaId it lists the user\'s source videos and their ids. Use the pick_clips prompt to choose clip moments.',
  input: GetTranscriptToolSchema,
  describe: {
    mediaId: 'The source video id. Omit to list the user\'s source videos.',
    startMs: `Start of the range. ${TIMESTAMP}`,
    endMs: `End of the range. ${TIMESTAMP}`,
    query: 'Only segments containing this text (case-insensitive).',
  },
  annotations: READ_ONLY,
  async run(ctx, args) {
    if (args.mediaId === undefined) {
      const page = await ctx.services.media.list(ctx.userId, { kind: 'video', limit: 50 })
      const sources = page.items.filter((m) => isClipSource(m) && m.status !== 'deleted')
      if (sources.length === 0) {
        return ok(
          'No source videos yet. The user uploads a video they own (or adds a Google Drive / Dropbox / OneDrive link) on the Media page of the web app; YouTube links are not accepted.',
          { sources: [] },
        )
      }
      const lines = sources.map((m) => `- ${m.id}: ${m.status}${m.durationMs ? `, ${formatMs(m.durationMs)}` : ''}, added ${m.createdAt.toISOString()}`)
      return ok(`${plural(sources.length, 'source video')} (newest first):\n${lines.join('\n')}\nCall get_transcript with one of these mediaIds.`, {
        sources: sources.map(mediaViewForModel),
      })
    }
    const t = await ctx.services.transcripts.get(ctx.userId, args)
    const { text: _text, ...rest } = t
    return ok(transcriptText(t), { transcript: rest })
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
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  async run(ctx, args) {
    const clips = await ctx.services.clips.requestClips(ctx.userId, args, { via: 'mcp' })
    const lines = clips.map((c) => `- ${c.id}: ${range(c.startMs, c.endMs)}${c.title ? ` "${excerpt(c.title, 60)}"` : ''} (${c.status})`)
    return ok(
      [
        `Queued ${plural(clips.length, 'clip')} for rendering (9:16, captions: ${clips[0]?.captionStyle ?? 'bold'}):`,
        ...lines,
        'Each clip becomes a draft when it is ready (usually a few minutes). Check with post_status (clipId) or list_drafts, then show it with approve_draft.',
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
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  async run(ctx, args) {
    const job = await ctx.services.renders.requestCarousel(ctx.userId, args, { via: 'mcp' })
    const slides = Array.isArray(args.slides) ? args.slides.length : 0
    return ok(
      `Rendering a ${plural(slides, 'slide')} carousel (job ${job.id}, ${job.status}). Check with post_status jobId=${job.id}. When it succeeds its result has a draftId (a draft already made with the images): show it with approve_draft instead of creating another draft. Only if draftId is null, attach the media ids to a draft with create_draft.`,
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
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  async run(ctx, args) {
    const job = await ctx.services.renders.requestVideo(ctx.userId, args, { via: 'mcp' })
    return ok(
      `Rendering the video (job ${job.id}, ${job.status}). Check with post_status jobId=${job.id}. When it succeeds its result has a draftId (a draft already made with the video): show it with approve_draft instead of creating another draft. Only if draftId is null, attach the media id to a draft with create_draft.`,
      { job: jobViewForModel(job) },
    )
  },
}
