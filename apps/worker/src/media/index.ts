// Handlers for the "media" worker group: source_ingest, transcribe, clip_render, carousel_render,
// video_render. Business rules (metering, limits, drafts, approval) stay in @app/services; these
// handlers move bytes, run ffmpeg/ffprobe/Chromium and report results through service calls.

import type { Handler } from '../types'
import { createClipRender } from './clip-render'
import type { MediaHandlerOptions } from './options'
import { createCarouselRender, createVideoRender } from './renders'
import { createSourceIngest } from './source-ingest'
import { createTranscribe } from './transcribe'

/** Media handlers with injectable dependencies (fetch, renderer, streaming, limits) for tests and tooling. */
export function createMediaHandlers(options: MediaHandlerOptions = {}): Record<string, Handler> {
  return {
    source_ingest: createSourceIngest(options),
    transcribe: createTranscribe(options),
    clip_render: createClipRender(options),
    carousel_render: createCarouselRender(options),
    video_render: createVideoRender(options),
  }
}

/** Handlers for the "media" worker group (source_ingest, transcribe, clip_render, carousel_render, video_render). */
export const mediaHandlers: Record<string, Handler> = createMediaHandlers()

export { buildAss, groupCaptionLines } from './captions'
export { directDownloadUrl, downloadDriveFile, IngestRefusal, TransientDownloadError } from './drive'
export { chooseFraming, clipRenderArgs, extractAudioArgs, slideshowPlan } from './ffmpeg'
export { DEFAULT_TIMEOUTS, isRetryableMediaError, type MediaHandlerOptions } from './options'
export { parseProbe, probe, type ProbeResult } from './probe'
export { createChromiumRenderer, resolveChromiumPath, RendererUnavailableError, type SlideRenderer } from './renderer'
