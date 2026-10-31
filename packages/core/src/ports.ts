// Ports: every external system sits behind one of these interfaces, with a fake for tests and local dev.
// Shapes follow docs/ARCHITECTURE.md ("Ports").

import type {
  AccountStatus,
  ContentKind,
  Metrics,
  Platform,
  ProviderName,
  TimedText,
} from './types'

// ---------------------------------------------------------------------------
// Posting (Upload-Post today; direct platform adapters later)
// ---------------------------------------------------------------------------

/** A social account connected to a provider profile (one per platform per profile). */
export interface ProviderAccount {
  platform: Platform
  /** The platform's stable account id (e.g. TikTok open_id, YouTube channel id). */
  externalId: string
  handle: string | null
  displayName: string | null
  status: AccountStatus
}

/** Per-platform publish options, already validated by `PlatformOptionsSchemas` in validation.ts. */
export type PublishOptions = Readonly<Record<string, unknown>>

export interface PublishInput {
  profileRef: string
  platform: Platform
  kind: ContentKind
  text: string
  title?: string
  /** Short-lived HTTPS URLs (e.g. presigned R2 GETs) the provider downloads from. */
  mediaUrls: string[]
  options: PublishOptions
  /** Stable per post; the provider dedupes retries with it. */
  idempotencyKey: string
}

export type PublishState = 'pending' | 'published' | 'failed'

export interface PublishStatus {
  state: PublishState
  postId?: string
  url?: string
  error?: string
}

/** One historical post read back from a platform (input for the `past_posts` table). */
export interface PastPostInput {
  platform: Platform
  externalPostId: string
  text: string | null
  mediaType: string | null
  /** ISO 8601 timestamp. */
  postedAt: string | null
  permalink: string | null
  metrics: Metrics
}

export interface PostingProvider {
  readonly name: ProviderName
  ensureProfile(i: { brandId: string; profileRef?: string | null; displayName: string }): Promise<{ profileRef: string }>
  createConnectLink(i: {
    profileRef: string
    platforms: Platform[]
    redirectUrl?: string
  }): Promise<{ url: string; expiresAt: string }>
  listAccounts(profileRef: string): Promise<ProviderAccount[]>
  disconnect(i: { profileRef: string; platform: Platform }): Promise<void>
  deleteProfile(profileRef: string): Promise<void>
  publish(i: PublishInput): Promise<{ requestId: string }>
  getStatus(requestId: string): Promise<PublishStatus>
  getPostMetrics(i: {
    requestId?: string
    platformPostId?: string
    platform: Platform
    profileRef: string
  }): Promise<Metrics>
  getAccountMetrics(i: {
    profileRef: string
    platforms: Platform[]
  }): Promise<Array<{ platform: Platform; metrics: Metrics }>>
  listPastPosts(i: {
    profileRef: string
    platform: Platform
    cursor?: string
    limit?: number
  }): Promise<{ posts: PastPostInput[]; nextCursor?: string }>
}

// ---------------------------------------------------------------------------
// Object storage (Cloudflare R2 via the S3 API; memory/fs fakes)
// ---------------------------------------------------------------------------

export interface PresignedPut {
  url: string
  /** Headers the uploader must send with the PUT (e.g. Content-Type). */
  headers: Record<string, string>
}

export interface ObjectHead {
  bytes: number
  contentType: string
}

export interface ObjectStorage {
  presignPut(key: string, contentType: string, maxBytes: number): Promise<PresignedPut>
  presignGet(key: string, ttlSec: number): Promise<string>
  putFile(key: string, path: string, contentType: string): Promise<void>
  putBytes(key: string, bytes: Uint8Array, contentType: string): Promise<void>
  getToFile(key: string, path: string): Promise<void>
  head(key: string): Promise<ObjectHead | null>
  delete(key: string): Promise<void>
}

// ---------------------------------------------------------------------------
// Transcription (self-hosted Whisper first, AssemblyAI fallback)
// ---------------------------------------------------------------------------

export interface TranscriptResult {
  language: string
  durationMs: number
  text: string
  /** Word timings in ms. */
  words: TimedText[]
  /** Segment (sentence/phrase) timings in ms. */
  segments: TimedText[]
}

export interface Transcriber {
  readonly name: string
  transcribe(i: { filePath: string; language?: string }): Promise<TranscriptResult>
}

// ---------------------------------------------------------------------------
// Clock
// ---------------------------------------------------------------------------

export interface Clock {
  now(): Date
}
