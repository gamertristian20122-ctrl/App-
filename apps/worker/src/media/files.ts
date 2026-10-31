// Scratch files for media jobs: one private temp directory per job under ctx.tmpDir, always
// removed afterwards (try/finally), plus streaming sha256 / size helpers for large files.

import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, mkdtemp, open, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'

/** Runs fn with a fresh directory under `root` and deletes the directory afterwards, whatever happens. */
export async function withTempDir<T>(root: string, prefix: string, fn: (dir: string) => Promise<T>): Promise<T> {
  await mkdir(root, { recursive: true, mode: 0o700 })
  const safePrefix = prefix.replace(/[^a-z0-9_-]/gi, '').slice(0, 30) || 'job'
  const dir = await mkdtemp(join(root, `${safePrefix}-`))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
}

/** sha256 (hex) and size of a file, streamed. */
export async function hashFile(path: string, signal?: AbortSignal): Promise<{ sha256: string; bytes: number }> {
  const hash = createHash('sha256')
  let bytes = 0
  const stream = createReadStream(path, signal ? { signal } : {})
  for await (const chunk of stream) {
    const buf = chunk as Buffer
    bytes += buf.length
    hash.update(buf)
  }
  return { sha256: hash.digest('hex'), bytes }
}

export async function fileSize(path: string): Promise<number> {
  return (await stat(path)).size
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** Width and height from a PNG's IHDR chunk, or null when the file is not a PNG. */
export async function pngSize(path: string): Promise<{ width: number; height: number } | null> {
  const handle = await open(path, 'r')
  try {
    const head = Buffer.alloc(24)
    const { bytesRead } = await handle.read(head, 0, 24, 0)
    if (bytesRead < 24 || !head.subarray(0, 8).equals(PNG_SIGNATURE) || head.toString('ascii', 12, 16) !== 'IHDR') return null
    return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) }
  } finally {
    await handle.close()
  }
}

/** Width and height from a JPEG's SOF marker (baseline or progressive), or null when not found in `buf`. */
export function jpegDimensions(buf: Uint8Array): { width: number; height: number } | null {
  const b = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength)
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null
  let i = 2
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) return null
    const marker = b[i + 1] as number
    if (marker === 0xff) {
      i += 1
      continue
    }
    // SOF0–SOF15 except DHT (C4), JPG (C8) and DAC (CC)
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) }
    }
    if (marker === 0xd9 || marker === 0xda) return null
    i += 2 + b.readUInt16BE(i + 2)
  }
  return null
}

/** jpegDimensions of a file (the SOF marker sits in the first 256 KB of any sane JPEG). */
export async function jpegSize(path: string): Promise<{ width: number; height: number } | null> {
  const handle = await open(path, 'r')
  try {
    const buf = Buffer.alloc(256 * 1024)
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0)
    return jpegDimensions(buf.subarray(0, bytesRead))
  } finally {
    await handle.close()
  }
}
