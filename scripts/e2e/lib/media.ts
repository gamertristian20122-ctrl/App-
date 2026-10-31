// ffmpeg / ffprobe helpers: a synthetic source video (test pattern + sine tone) and stream facts.

import { run } from './procs'

/** A 1280x720 H.264 + AAC test video of `seconds` (testsrc pattern + 440 Hz sine). */
export async function makeTestVideo(path: string, seconds: number, ffmpeg = 'ffmpeg'): Promise<void> {
  await run(ffmpeg, [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    `testsrc=duration=${seconds}:size=1280x720:rate=30`,
    '-f',
    'lavfi',
    '-i',
    `sine=frequency=440:duration=${seconds}`,
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-b:a',
    '96k',
    '-shortest',
    '-movflags',
    '+faststart',
    path,
  ])
}

export interface ProbeFacts {
  width: number | null
  height: number | null
  hasAudio: boolean
  hasVideo: boolean
  durationSec: number
  formatName: string
}

export async function probe(path: string, ffprobe = 'ffprobe'): Promise<ProbeFacts> {
  const r = await run(ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', path])
  const data = JSON.parse(r.stdout) as {
    streams?: Array<{ codec_type?: string; width?: number; height?: number }>
    format?: { duration?: string; format_name?: string }
  }
  const streams = data.streams ?? []
  const video = streams.find((s) => s.codec_type === 'video')
  return {
    width: video?.width ?? null,
    height: video?.height ?? null,
    hasVideo: Boolean(video),
    hasAudio: streams.some((s) => s.codec_type === 'audio'),
    durationSec: Number(data.format?.duration ?? 0),
    formatName: data.format?.format_name ?? '',
  }
}
