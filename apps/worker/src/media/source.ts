// Reading a stored source video with ffmpeg. Remote storage (R2) is streamed through a short-lived
// presigned https URL (ffmpeg seeks with range requests, so a 60-second clip of a 4-hour source
// reads megabytes, not the whole file); local storages, and any streaming failure, fall back to
// downloading the object into the job's temp directory. Every input is probed first and must be an
// allowed container; later runs force that demuxer.

import { join } from 'node:path'
import { isLocalStorage } from '@app/storage'
import { JobAbortedError, PermanentJobError } from '../errors'
import type { WorkerContext } from '../types'
import { fileInput, urlInput, type MediaInput } from './ffmpeg'
import { MediaToolError } from './process'
import { probe, type ProbeResult } from './probe'

/** Lifetime of the presigned URL ffmpeg reads from. */
export const SOURCE_URL_TTL_SEC = 6 * 3600

export interface SourceOptions {
  /** Stream through a presigned URL (default: when the storage is not a local/memory one). */
  stream?: boolean | undefined
  /** File name for a downloaded copy inside `dir`. */
  fileName?: string
  probeTimeoutMs?: number
}

export function shouldStream(ctx: Pick<WorkerContext, 'storage'>, override?: boolean): boolean {
  return override ?? !isLocalStorage(ctx.storage)
}

export const UNSUPPORTED_SOURCE = 'This file type is not supported. Use an MP4, MOV, WebM or MKV video.'

function demuxerOf(result: ProbeResult): string {
  if (!result.demuxer) throw new PermanentJobError(UNSUPPORTED_SOURCE)
  return result.demuxer
}

/**
 * Runs `fn` with an ffmpeg input for the object at `key` and its probe. A streamed attempt that fails
 * inside ffmpeg/ffprobe is retried once from a downloaded copy.
 */
export async function withStoredSource<T>(
  ctx: WorkerContext,
  key: string,
  dir: string,
  options: SourceOptions,
  fn: (input: MediaInput, probed: ProbeResult) => Promise<T>,
): Promise<T> {
  const ffprobePath = ctx.config.FFPROBE_PATH
  const probeTimeoutMs = options.probeTimeoutMs ?? 120_000
  if (shouldStream(ctx, options.stream)) {
    const url = await ctx.storage.presignGet(key, SOURCE_URL_TTL_SEC)
    if (url.startsWith('https://')) {
      try {
        const probed = await probe(url, { ffprobePath, signal: ctx.signal, timeoutMs: probeTimeoutMs, inputArgs: urlInput(url).args })
        return await fn(urlInput(url, demuxerOf(probed)), probed)
      } catch (error) {
        if (error instanceof JobAbortedError || !(error instanceof MediaToolError)) throw error
        ctx.logger.warn('streaming the source failed; downloading it instead', { tool: error.tool, reason: error.reason })
      }
    }
  }
  if (ctx.signal?.aborted) throw new JobAbortedError()
  const path = join(dir, options.fileName ?? 'source.media')
  await ctx.storage.getToFile(key, path)
  const probed = await probe(path, { ffprobePath, signal: ctx.signal, timeoutMs: probeTimeoutMs })
  return fn(fileInput(path, demuxerOf(probed)), probed)
}
