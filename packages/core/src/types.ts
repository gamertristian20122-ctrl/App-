import { z } from 'zod'

// Every list below mirrors a Postgres enum (or a CHECKed text column) in supabase/migrations.
// Keep the order identical to the SQL definition.

export const PLATFORMS = [
  'tiktok',
  'youtube',
  'instagram',
  'facebook',
  'threads',
  'x',
  'linkedin',
  'pinterest',
  'bluesky',
] as const
export type Platform = (typeof PLATFORMS)[number]
export const PlatformSchema = z.enum(PLATFORMS)

export const PLATFORM_LABELS: Readonly<Record<Platform, string>> = {
  tiktok: 'TikTok',
  youtube: 'YouTube',
  instagram: 'Instagram',
  facebook: 'Facebook',
  threads: 'Threads',
  x: 'X',
  linkedin: 'LinkedIn',
  pinterest: 'Pinterest',
  bluesky: 'Bluesky',
}

export function isPlatform(value: unknown): value is Platform {
  return typeof value === 'string' && (PLATFORMS as readonly string[]).includes(value)
}

export const PLAN_TIERS = ['starter', 'plus', 'pro'] as const
export type PlanTier = (typeof PLAN_TIERS)[number]
export const PlanTierSchema = z.enum(PLAN_TIERS)

export const SUBSCRIPTION_STATUSES = ['none', 'trialing', 'active', 'past_due', 'canceled', 'unpaid'] as const
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number]
export const SubscriptionStatusSchema = z.enum(SUBSCRIPTION_STATUSES)

export const BRAND_STATUSES = ['active', 'suspended', 'archived'] as const
export type BrandStatus = (typeof BRAND_STATUSES)[number]
export const BrandStatusSchema = z.enum(BRAND_STATUSES)

export const ACCOUNT_STATUSES = ['pending', 'active', 'disconnected', 'needs_reauth'] as const
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number]
export const AccountStatusSchema = z.enum(ACCOUNT_STATUSES)
/** Statuses covered by the one-account-per-platform-per-brand unique index. */
export const LIVE_ACCOUNT_STATUSES = ['pending', 'active', 'needs_reauth'] as const satisfies readonly AccountStatus[]

export const MEDIA_KINDS = ['video', 'image', 'audio', 'captions'] as const
export type MediaKind = (typeof MEDIA_KINDS)[number]
export const MediaKindSchema = z.enum(MEDIA_KINDS)

export const MEDIA_ORIGINS = ['upload', 'drive_link', 'clip', 'render'] as const
export type MediaOrigin = (typeof MEDIA_ORIGINS)[number]
export const MediaOriginSchema = z.enum(MEDIA_ORIGINS)

export const MEDIA_STATUSES = ['pending', 'ready', 'failed', 'deleted'] as const
export type MediaStatus = (typeof MEDIA_STATUSES)[number]
export const MediaStatusSchema = z.enum(MEDIA_STATUSES)

export const CLIP_STATUSES = ['queued', 'rendering', 'ready', 'failed'] as const
export type ClipStatus = (typeof CLIP_STATUSES)[number]
export const ClipStatusSchema = z.enum(CLIP_STATUSES)

export const DRAFT_STATUSES = ['draft', 'approved', 'rejected', 'archived'] as const
export type DraftStatus = (typeof DRAFT_STATUSES)[number]
export const DraftStatusSchema = z.enum(DRAFT_STATUSES)

export const POST_STATUSES = ['scheduled', 'publishing', 'published', 'failed', 'canceled'] as const
export type PostStatus = (typeof POST_STATUSES)[number]
export const PostStatusSchema = z.enum(POST_STATUSES)
/** Statuses covered by the one-active-post-per-variant unique index; also what platform caps count. */
export const ACTIVE_POST_STATUSES = ['scheduled', 'publishing', 'published'] as const satisfies readonly PostStatus[]

export const JOB_STATUSES = ['queued', 'running', 'succeeded', 'failed', 'dead'] as const
export type JobStatus = (typeof JOB_STATUSES)[number]
export const JobStatusSchema = z.enum(JOB_STATUSES)

export const USAGE_METERS = ['clip_seconds', 'x_link_posts'] as const
export type UsageMeter = (typeof USAGE_METERS)[number]
export const UsageMeterSchema = z.enum(USAGE_METERS)

export const USAGE_KINDS = ['reserve', 'settle', 'release', 'adjust'] as const
export type UsageKind = (typeof USAGE_KINDS)[number]
export const UsageKindSchema = z.enum(USAGE_KINDS)

export const ACTORS = ['web', 'mcp', 'worker', 'system'] as const
export type Actor = (typeof ACTORS)[number]
export const ActorSchema = z.enum(ACTORS)

// CHECKed text columns (not Postgres enums).

export const PROVIDER_NAMES = ['upload_post', 'fake'] as const
export type ProviderName = (typeof PROVIDER_NAMES)[number]

export const TRANSCRIPT_ENGINES = ['whisper', 'assemblyai', 'fake'] as const
export type TranscriptEngine = (typeof TRANSCRIPT_ENGINES)[number]

export const VOICE_PROFILE_SOURCES = ['manual', 'imported', 'mixed'] as const
export type VoiceProfileSource = (typeof VOICE_PROFILE_SOURCES)[number]

export const SNAPSHOT_SCOPES = ['post', 'account'] as const
export type SnapshotScope = (typeof SNAPSHOT_SCOPES)[number]

export const OAUTH_TOKEN_KINDS = ['access', 'refresh'] as const
export type OAuthTokenKind = (typeof OAUTH_TOKEN_KINDS)[number]

/** The single OAuth scope our MCP server issues. */
export const MCP_SCOPE = 'social'

/** What a post publishes; chosen from the variant's media. */
export const CONTENT_KINDS = ['text', 'video', 'photos'] as const
export type ContentKind = (typeof CONTENT_KINDS)[number]

// Jobs

export const JOB_TYPES = [
  'publish_post',
  'check_post_status',
  'source_ingest',
  'transcribe',
  'clip_render',
  'carousel_render',
  'video_render',
  'analytics_pull',
  'import_past_posts',
  'cleanup',
] as const
export type JobType = (typeof JOB_TYPES)[number]
export const JobTypeSchema = z.enum(JOB_TYPES)

/** Worker groups selected by WORKER_TYPES (Railway runs one service per group from the same image). */
export const WORKER_GROUPS = ['posting', 'media'] as const
export type WorkerGroup = (typeof WORKER_GROUPS)[number]

export const JOB_GROUP: Readonly<Record<JobType, WorkerGroup>> = {
  publish_post: 'posting',
  check_post_status: 'posting',
  analytics_pull: 'posting',
  import_past_posts: 'posting',
  cleanup: 'posting',
  source_ingest: 'media',
  transcribe: 'media',
  clip_render: 'media',
  carousel_render: 'media',
  video_render: 'media',
}

/** A row of the `jobs` table as the DB layer returns it (camelCase, Date for timestamptz). */
export interface JobRow {
  id: string
  userId: string | null
  type: string
  payload: Record<string, unknown>
  status: JobStatus
  runAt: Date
  attempts: number
  maxAttempts: number
  lockedBy: string | null
  lockedUntil: Date | null
  lastError: string | null
  idempotencyKey: string | null
  result: unknown
  finishedAt: Date | null
  createdAt: Date
  updatedAt: Date
}

// Metrics (analytics_snapshots.metrics, past_posts.metrics): numbers only.

export const METRIC_KEYS = [
  'views',
  'likes',
  'comments',
  'shares',
  'saves',
  'followers',
  'reach',
  'impressions',
] as const
export type MetricKey = (typeof METRIC_KEYS)[number]
export type Metrics = Partial<Record<MetricKey, number>>

const metricValue = z.number().finite().min(0)
export const MetricsSchema = z.strictObject({
  views: metricValue.optional(),
  likes: metricValue.optional(),
  comments: metricValue.optional(),
  shares: metricValue.optional(),
  saves: metricValue.optional(),
  followers: metricValue.optional(),
  reach: metricValue.optional(),
  impressions: metricValue.optional(),
})

/** Keeps only known metric keys holding finite, non-negative numbers (for third-party payloads). */
export function pickMetrics(input: unknown): Metrics {
  const out: Metrics = {}
  if (input === null || typeof input !== 'object') return out
  const record = input as Record<string, unknown>
  for (const key of METRIC_KEYS) {
    const raw = record[key]
    const value = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) out[key] = value
  }
  return out
}

/** A word or segment with start/end in milliseconds (transcripts.words / segments). */
export interface TimedText {
  s: number
  e: number
  t: string
}
export const TimedTextSchema = z.strictObject({
  s: z.number().int().min(0),
  e: z.number().int().min(0),
  t: z.string(),
})
