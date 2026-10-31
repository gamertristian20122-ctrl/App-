// ffprobe (JSON) → the facts the worker needs: duration, streams, display size (rotation applied),
// frame rate, container. ffprobe's output is parsed defensively (every field checked), and only an
// allowlist of containers is accepted: playlists (HLS), concat scripts, image sequences and the
// like are refused, because ffmpeg would follow the files or URLs they reference.

import { MediaToolError, runTool } from './process'

export interface VideoStreamInfo {
  codec: string
  /** Coded size. */
  width: number
  height: number
  /** Size as displayed (rotation applied): what the viewer sees and what we store. */
  displayWidth: number
  displayHeight: number
  /** Clockwise display rotation (0, 90, 180, 270). */
  rotation: number
  /** Average frames per second, when known. */
  fps: number | null
}

export interface AudioStreamInfo {
  codec: string
  sampleRate: number | null
  channels: number | null
}

export interface ProbeResult {
  /** ffprobe's format_name, e.g. "mov,mp4,m4a,3gp,3g2,mj2". */
  formatName: string
  /** The demuxer to force (`-f`) on later ffmpeg runs; null when the container is not accepted. */
  demuxer: string | null
  durationMs: number | null
  /** MIME type for the container/codecs, when we can tell. */
  mimeType: string | null
  video: VideoStreamInfo | null
  audio: AudioStreamInfo | null
}

/** Containers we read, by ffprobe format_name → the demuxer name for `-f`. */
const DEMUXERS: Readonly<Record<string, string>> = {
  'mov,mp4,m4a,3gp,3g2,mj2': 'mov',
  'matroska,webm': 'matroska',
  avi: 'avi',
  mpegts: 'mpegts',
  mp3: 'mp3',
  wav: 'wav',
  ogg: 'ogg',
  aac: 'aac',
  flac: 'flac',
}

const WEBM_VIDEO = new Set(['vp8', 'vp9', 'av1'])
const WEBM_AUDIO = new Set(['opus', 'vorbis'])

function obj(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value.slice(0, 200) : null
}

function num(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN
  return Number.isFinite(n) ? n : null
}

function posInt(value: unknown, max = 100_000): number | null {
  const n = num(value)
  return n !== null && Number.isInteger(n) && n > 0 && n <= max ? n : null
}

/** "30000/1001" → 29.97; "0/0" → null. */
export function parseRate(value: unknown): number | null {
  const s = str(value)
  if (!s) return null
  const [a, b] = s.split('/')
  const n = num(a)
  const d = b === undefined ? 1 : num(b)
  if (n === null || d === null || d === 0) return null
  const rate = n / d
  return rate > 0 && rate < 1_000 ? rate : null
}

function rotationOf(stream: Record<string, unknown>): number {
  let raw: number | null = null
  const sideData = Array.isArray(stream.side_data_list) ? stream.side_data_list : []
  for (const entry of sideData) {
    const sd = obj(entry)
    if (sd && num(sd.rotation) !== null) raw = num(sd.rotation)
  }
  if (raw === null) raw = num(obj(stream.tags)?.rotate)
  if (raw === null) return 0
  // ffprobe reports the display matrix rotation counter-clockwise (e.g. -90 for a phone held upright)
  const normalized = ((Math.round(raw / 90) * 90) % 360 + 360) % 360
  return normalized
}

function mimeFor(formatName: string, format: Record<string, unknown>, video: VideoStreamInfo | null, audio: AudioStreamInfo | null): string | null {
  switch (formatName) {
    case 'mov,mp4,m4a,3gp,3g2,mj2': {
      const brand = (str(obj(format.tags)?.major_brand) ?? '').trim().toLowerCase()
      if (!video) return 'audio/mp4'
      return brand === 'qt' ? 'video/quicktime' : 'video/mp4'
    }
    case 'matroska,webm': {
      const webm = (!video || WEBM_VIDEO.has(video.codec)) && (!audio || WEBM_AUDIO.has(audio.codec))
      if (!video) return webm ? 'audio/webm' : 'audio/x-matroska'
      return webm ? 'video/webm' : 'video/x-matroska'
    }
    case 'avi':
      return 'video/x-msvideo'
    case 'mpegts':
      return 'video/mp2t'
    case 'mp3':
      return 'audio/mpeg'
    case 'wav':
      return 'audio/wav'
    case 'ogg':
      return video ? 'video/ogg' : 'audio/ogg'
    case 'aac':
      return 'audio/aac'
    case 'flac':
      return 'audio/flac'
    default:
      return null
  }
}

/** Parses `ffprobe -print_format json -show_format -show_streams` output. Throws on garbage. */
export function parseProbe(json: string): ProbeResult {
  let data: unknown
  try {
    data = JSON.parse(json)
  } catch {
    throw new MediaToolError('ffprobe returned unreadable output.', 'exit', 'ffprobe', 0, '')
  }
  const root = obj(data)
  const format = obj(root?.format) ?? {}
  const streams = (Array.isArray(root?.streams) ? root.streams : []).map(obj).filter((s): s is Record<string, unknown> => s !== null)
  const formatName = str(format.format_name) ?? 'unknown'

  let video: VideoStreamInfo | null = null
  let audio: AudioStreamInfo | null = null
  let longestStreamMs: number | null = null
  for (const stream of streams) {
    const type = str(stream.codec_type)
    const seconds = num(stream.duration)
    if (seconds !== null && seconds > 0) longestStreamMs = Math.max(longestStreamMs ?? 0, Math.round(seconds * 1000))
    if (type === 'video' && !video) {
      // cover art in audio files is a "video" stream with attached_pic = 1: not a video
      if (num(obj(stream.disposition)?.attached_pic) === 1) continue
      const width = posInt(stream.width)
      const height = posInt(stream.height)
      if (!width || !height) continue
      const rotation = rotationOf(stream)
      const swap = rotation === 90 || rotation === 270
      video = {
        codec: str(stream.codec_name) ?? 'unknown',
        width,
        height,
        displayWidth: swap ? height : width,
        displayHeight: swap ? width : height,
        rotation,
        fps: parseRate(stream.avg_frame_rate) ?? parseRate(stream.r_frame_rate),
      }
    } else if (type === 'audio' && !audio) {
      audio = {
        codec: str(stream.codec_name) ?? 'unknown',
        sampleRate: posInt(stream.sample_rate, 1_000_000),
        channels: posInt(stream.channels, 64),
      }
    }
  }

  const formatSeconds = num(format.duration)
  const durationMs = formatSeconds !== null && formatSeconds > 0 ? Math.round(formatSeconds * 1000) : longestStreamMs
  const demuxer = DEMUXERS[formatName] ?? null
  return { formatName, demuxer, durationMs, mimeType: demuxer ? mimeFor(formatName, format, video, audio) : null, video, audio }
}

export interface ProbeOptions {
  ffprobePath: string
  signal?: AbortSignal | undefined
  timeoutMs?: number
  /** Input options placed before -i (e.g. protocol whitelist, forced demuxer). */
  inputArgs?: readonly string[]
}

/** Probes a local file or a URL (with the right inputArgs). */
export async function probe(input: string, options: ProbeOptions): Promise<ProbeResult> {
  const args = [
    '-v',
    'error',
    '-print_format',
    'json',
    '-show_format',
    '-show_streams',
    ...(options.inputArgs ?? ['-protocol_whitelist', 'file']),
    '-i',
    input,
  ]
  const { stdout } = await runTool(options.ffprobePath, args, {
    signal: options.signal,
    timeoutMs: options.timeoutMs ?? 120_000,
    captureStdout: true,
  })
  return parseProbe(stdout)
}
