// Test fixtures generated at test time with the real ffmpeg (testsrc + sine), plus small helpers.
// Nothing is checked in and nothing touches the network.

import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { probe, type ProbeResult } from '../probe'

const run = promisify(execFile)

export interface Fixtures {
  dir: string
  /** 640×360, 4 s, 30 fps, H.264 + AAC sine. */
  landscape: string
  /** 480×640 (3:4 portrait), 4 s, H.264 + AAC. */
  portrait: string
  /** 640×360, 4 s, video only. */
  silent: string
  /** 3 s sine, MP3, no video. */
  audioOnly: string
  /** 200×100 PNG. */
  image: string
  /** Plain text. */
  text: string
  cleanup(): Promise<void>
}

async function ffmpeg(args: string[]): Promise<void> {
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...args], { timeout: 60_000 })
}

export async function createFixtures(): Promise<Fixtures> {
  const dir = await mkdtemp(join(tmpdir(), 'media-fixtures-'))
  const f = (name: string) => join(dir, name)
  const video = (size: string, seconds: number, out: string, audio: boolean) =>
    ffmpeg([
      '-f',
      'lavfi',
      '-i',
      `testsrc=size=${size}:rate=30:duration=${seconds}`,
      ...(audio ? ['-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=48000:duration=${seconds}`] : []),
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-pix_fmt',
      'yuv420p',
      ...(audio ? ['-c:a', 'aac', '-shortest'] : []),
      out,
    ])
  await Promise.all([
    video('640x360', 4, f('landscape.mp4'), true),
    video('480x640', 4, f('portrait.mp4'), true),
    video('640x360', 4, f('silent.mp4'), false),
    ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=330:sample_rate=44100:duration=3', '-c:a', 'libmp3lame', '-b:a', '64k', f('audio.mp3')]),
    ffmpeg(['-f', 'lavfi', '-i', 'testsrc=size=200x100:rate=1:duration=1', '-frames:v', '1', f('image.png')]),
    writeFile(f('notes.txt'), 'this is not a video\n'.repeat(50)),
  ])
  return {
    dir,
    landscape: f('landscape.mp4'),
    portrait: f('portrait.mp4'),
    silent: f('silent.mp4'),
    audioOnly: f('audio.mp3'),
    image: f('image.png'),
    text: f('notes.txt'),
    cleanup: () => rm(dir, { recursive: true, force: true }),
  }
}

export async function bytesOf(path: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(path))
}

/** Writes stored bytes to a temp file and probes them. */
export async function probeBytes(bytes: Uint8Array, name = 'probe.mp4'): Promise<ProbeResult> {
  const dir = await mkdtemp(join(tmpdir(), 'media-probe-'))
  try {
    const path = join(dir, name)
    await writeFile(path, bytes)
    return await probe(path, { ffprobePath: 'ffprobe' })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/** PNG width/height straight from the bytes. */
export function pngDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  const b = Buffer.from(bytes)
  if (b.length < 24 || b.toString('ascii', 12, 16) !== 'IHDR') return null
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) }
}

/** A Response whose body streams `bytes` (for fetch mocks). */
export function fileResponse(bytes: Uint8Array, contentType = 'video/mp4', status = 200): Response {
  return new Response(new Blob([Buffer.from(bytes)]).stream(), { status, headers: { 'content-type': contentType, 'content-length': String(bytes.byteLength) } })
}

export function redirectResponse(location: string, status = 302): Response {
  return new Response(null, { status, headers: { location } })
}
