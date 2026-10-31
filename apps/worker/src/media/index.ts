import type { Handler } from '../types'

/** Handlers for the "media" worker group (source_ingest, transcribe, clip_render, carousel_render, video_render). */
export const mediaHandlers: Record<string, Handler> = {}
