// ffmpeg argument builders (pure, unit-tested): clip render (accurate cut, 9:16 reframe, burned-in
// ASS captions, H.264 + AAC, faststart), audio extraction for transcription, and the template-video
// slideshow (crossfades). Inputs always carry a protocol whitelist and, for sources, the demuxer
// found by ffprobe, so a crafted file cannot make ffmpeg open other files or URLs.

import { FFMPEG_BASE_ARGS } from './process'

export const CLIP_WIDTH = 1080
export const CLIP_HEIGHT = 1920

/** How ffmpeg reads one input: local file or (presigned) https URL, plus the forced demuxer. */
export interface MediaInput {
  path: string
  args: string[]
  remote: boolean
}

export const URL_INPUT_ARGS = [
  '-protocol_whitelist',
  'https,tls,tcp',
  '-reconnect',
  '1',
  '-reconnect_on_network_error',
  '1',
  '-reconnect_delay_max',
  '10',
  '-rw_timeout',
  '60000000',
] as const

export function fileInput(path: string, demuxer: string | null = null): MediaInput {
  return { path, args: ['-protocol_whitelist', 'file', ...(demuxer ? ['-f', demuxer] : [])], remote: false }
}

export function urlInput(url: string, demuxer: string | null = null): MediaInput {
  return { path: url, args: [...URL_INPUT_ARGS, ...(demuxer ? ['-f', demuxer] : [])], remote: true }
}

/** Seconds with millisecond precision, as ffmpeg expects ("12.345"). */
export function sec(ms: number): string {
  return (Math.max(0, Math.round(ms)) / 1000).toFixed(3)
}

/** Output frame rate: the source's, rounded and kept within what platforms accept (24–60), else 30. */
export function outputFps(sourceFps: number | null | undefined): number {
  if (!sourceFps || !Number.isFinite(sourceFps)) return 30
  return Math.min(60, Math.max(24, Math.round(sourceFps)))
}

export type Framing = 'crop' | 'blur'

/**
 * Landscape sources (and ones already ~9:16) are center-cropped to fill the frame; portrait,
 * square and narrow sources are fitted whole over a blurred, zoomed copy of themselves.
 */
export function chooseFraming(displayWidth: number, displayHeight: number): Framing {
  const aspect = displayWidth / displayHeight
  const target = CLIP_WIDTH / CLIP_HEIGHT
  if (Math.abs(aspect - target) / target < 0.03) return 'crop'
  return aspect > 1 ? 'crop' : 'blur'
}

const VIDEO_CODEC_ARGS = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-maxrate', '12M', '-bufsize', '24M']
const AUDIO_CODEC_ARGS = ['-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-ac', '2']
const OUTPUT_ARGS = ['-movflags', '+faststart', '-map_metadata', '-1', '-map_chapters', '-1', '-sn', '-dn']
const SILENCE = 'anullsrc=channel_layout=stereo:sample_rate=48000'

/** The clip filter graph: [0:v] → [v] at 1080×1920 (captions file name relative to ffmpeg's cwd). */
export function clipFilterGraph(options: { framing: Framing; fps: number; captionsFile?: string | null }): string {
  const { fps } = options
  const w = CLIP_WIDTH
  const h = CLIP_HEIGHT
  const subs = options.captionsFile ? `,ass=${options.captionsFile}` : ''
  // square pixels first (anamorphic sources), then frame rate
  const pre = `[0:v]scale='trunc(iw*sar/2)*2':ih,setsar=1,fps=${fps}`
  if (options.framing === 'crop') {
    return `${pre},crop=w='trunc(min(iw,ih*${w}/${h})/2)*2':h='trunc(min(ih,iw*${h}/${w})/2)*2',scale=${w}:${h}:flags=lanczos,setsar=1,format=yuv420p${subs}[v]`
  }
  const bw = w / 4
  const bh = h / 4
  return [
    `${pre},split=2[bg][fg]`,
    `[bg]scale=${bw}:${bh}:force_original_aspect_ratio=increase,crop=${bw}:${bh},boxblur=luma_radius=10:luma_power=2,scale=${w}:${h},setsar=1[bgb]`,
    `[fg]scale=${w}:${h}:force_original_aspect_ratio=decrease:force_divisible_by=2:flags=lanczos,setsar=1[fgs]`,
    `[bgb][fgs]overlay=x='(W-w)/2':y='(H-h)/2',format=yuv420p${subs}[v]`,
  ].join(';')
}

export interface ClipRenderArgs {
  input: MediaInput
  startMs: number
  durationMs: number
  hasAudio: boolean
  framing: Framing
  fps: number
  captionsFile?: string | null
  output: string
}

/** ffmpeg args for one clip. `-ss` before `-i` with re-encoding is frame-accurate. */
export function clipRenderArgs(o: ClipRenderArgs): string[] {
  const args: string[] = [...FFMPEG_BASE_ARGS, ...o.input.args, '-ss', sec(o.startMs), '-t', sec(o.durationMs), '-i', o.input.path]
  if (!o.hasAudio) args.push('-f', 'lavfi', '-t', sec(o.durationMs), '-i', SILENCE)
  args.push(
    '-filter_complex',
    clipFilterGraph({ framing: o.framing, fps: o.fps, captionsFile: o.captionsFile ?? null }),
    '-map',
    '[v]',
    '-map',
    o.hasAudio ? '0:a:0' : '1:a:0',
    ...VIDEO_CODEC_ARGS,
    '-g',
    String(o.fps * 2),
    ...AUDIO_CODEC_ARGS,
    '-t',
    sec(o.durationMs),
    ...OUTPUT_ARGS,
    o.output,
  )
  return args
}

/** 16 kHz mono MP3 (32 kbit/s: ~58 MB for 4 h) for the transcription engines. */
export function extractAudioArgs(o: { input: MediaInput; maxDurationMs: number; output: string }): string[] {
  return [
    ...FFMPEG_BASE_ARGS,
    ...o.input.args,
    '-i',
    o.input.path,
    '-map',
    '0:a:0',
    '-vn',
    '-sn',
    '-dn',
    '-ac',
    '1',
    '-ar',
    '16000',
    '-c:a',
    'libmp3lame',
    '-b:a',
    '32k',
    '-t',
    sec(o.maxDurationMs),
    '-map_metadata',
    '-1',
    o.output,
  ]
}


export interface SlideshowInput {
  /** Slide images (file names relative to ffmpeg's cwd, or absolute paths). */
  slides: Array<{ path: string; durationMs: number }>
  width: number
  height: number
  fps?: number
  /** Crossfade length (shortened for short slides). */
  transitionMs?: number
  /** Background audio (trimmed/padded to the video, faded out); silence when absent. */
  audio?: MediaInput | null
  output: string
}

export interface SlideshowPlan {
  /** One ffmpeg run per slide: the slide (crossfading in from the previous one) as a near-lossless segment. */
  segments: Array<{ args: string[]; output: string; frames: number }>
  /** Concat-demuxer list joining the segments. */
  concatList: string
  concatListFile: string
  /** Final run: joins the segments, adds audio, encodes H.264 + AAC with faststart. */
  finalArgs: string[]
  totalMs: number
  transitionMs: number
}

/**
 * Template video as a slideshow with crossfades, rendered slide by slide so memory stays flat
 * however many slides there are (a single xfade chain buffers every input). Slide i lasts exactly
 * its duration (frame counts are taken from the cumulative timeline, so nothing drifts); from the
 * second slide on, its first `transitionMs` crossfade from the previous slide.
 */
export function slideshowPlan(o: SlideshowInput): SlideshowPlan {
  const n = o.slides.length
  if (n === 0) throw new Error('A slideshow needs at least one slide.')
  const fps = o.fps ?? 30
  const shortest = Math.min(...o.slides.map((s) => s.durationMs))
  const t = n > 1 ? Math.max(0, Math.min(o.transitionMs ?? 500, Math.floor(shortest / 2))) : 0
  const totalMs = o.slides.reduce((sum, s) => sum + s.durationMs, 0)
  const scale = `scale=${o.width}:${o.height},setsar=1,format=yuv420p,fps=${fps}`
  const still = (path: string, ms: number) => ['-protocol_whitelist', 'file', '-f', 'image2', '-loop', '1', '-framerate', String(fps), '-t', sec(ms), '-i', path]
  const segmentCodec = ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '12', '-pix_fmt', 'yuv420p', '-an']

  const segments: SlideshowPlan['segments'] = []
  let cumulative = 0
  o.slides.forEach((slide, i) => {
    const startFrame = Math.round((cumulative * fps) / 1000)
    cumulative += slide.durationMs
    const frames = Math.max(1, Math.round((cumulative * fps) / 1000) - startFrame)
    const output = `seg-${String(i).padStart(3, '0')}.mp4`
    const lengthMs = Math.ceil((frames * 1000) / fps) + 200
    const prev = o.slides[i - 1]
    const args: string[] = [...FFMPEG_BASE_ARGS]
    if (i === 0 || !prev || t === 0) {
      args.push(...still(slide.path, lengthMs), '-filter_complex', `[0:v]${scale}[v]`)
    } else {
      args.push(
        ...still(prev.path, t + 200),
        ...still(slide.path, lengthMs),
        '-filter_complex',
        `[0:v]${scale}[a];[1:v]${scale}[b];[a][b]xfade=transition=fade:duration=${sec(t)}:offset=0[v]`,
      )
    }
    args.push('-map', '[v]', '-frames:v', String(frames), ...segmentCodec, '-r', String(fps), output)
    segments.push({ args, output, frames })
  })

  const concatListFile = 'segments.txt'
  const concatList = `${segments.map((s) => `file '${s.output}'`).join('\n')}\n`
  const finalArgs: string[] = [...FFMPEG_BASE_ARGS, '-protocol_whitelist', 'file', '-f', 'concat', '-safe', '1', '-i', concatListFile]
  if (o.audio) finalArgs.push(...o.audio.args, '-i', o.audio.path)
  else finalArgs.push('-f', 'lavfi', '-t', sec(totalMs), '-i', SILENCE)
  if (o.audio) {
    const fadeStart = Math.max(0, totalMs - 1000)
    finalArgs.push(
      '-filter_complex',
      `[1:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,apad,atrim=0:${sec(totalMs)},afade=t=out:st=${sec(fadeStart)}:d=1[a]`,
      '-map',
      '0:v:0',
      '-map',
      '[a]',
    )
  } else {
    finalArgs.push('-map', '0:v:0', '-map', '1:a:0')
  }
  finalArgs.push(...VIDEO_CODEC_ARGS, '-r', String(fps), '-g', String(fps * 2), ...AUDIO_CODEC_ARGS, '-t', sec(totalMs), ...OUTPUT_ARGS, o.output)
  return { segments, concatList, concatListFile, finalArgs, totalMs, transitionMs: t }
}
