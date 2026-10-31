// @app/db: the Db interface, postgres.js + PGlite drivers, the migrator and the repositories.
// Test helpers live in "@app/db/testing".

export type { Db, DbDriver, Row } from './types'
export { createPostgresDb, type PostgresDbOptions } from './postgres'
export { createPgliteDb, wrapPglite } from './pglite'
export {
  migrate,
  readMigrations,
  findMigrationsDir,
  appliedMigrationNames,
  migrationStatus,
  type MigrationFile,
  type MigrateResult,
  type MigrateOptions,
  type MigrationStatus,
} from './migrate'
export { MIGRATION_NAMES } from './migration-names'
export { installSupabaseShim, SUPABASE_SHIM_SQL } from './supabase-shim'
export { openDb, type OpenDbOptions } from './open'
export {
  DbError,
  PG_ERROR,
  APP_SQLSTATE,
  normalizeDbError,
  isDbError,
  isUniqueViolation,
  isForeignKeyViolation,
  isCheckViolation,
  isRetryableDbError,
  dbErrorToAppError,
} from './errors'
export { json, stripSecretKeys } from './sql'

export * from './repos'

export type { UserRow, EnsureUserInput, UserProfilePatch, UserBillingPatch } from './repos/users'
export type { AutoPostPatch, BrandRow, CreateBrandInput, ListBrandsOptions, UpdateBrandPatch } from './repos/brands'
export { platformList } from './repos/_mappers'
export type { AccountRow, UpsertAccountInput, ListAccountsOptions } from './repos/accounts'
export type { MediaRow, CreateMediaInput, ListMediaOptions, UpdateMediaPatch } from './repos/media'
export type { TranscriptRow, SaveTranscriptInput } from './repos/transcripts'
export type { ClipRow, CaptionStyle, CreateClipInput, ListClipsOptions, UpdateClipPatch } from './repos/clips'
export type {
  DraftRow,
  VariantRow,
  DraftWithVariants,
  VariantInput,
  CreateDraftInput,
  ListDraftsOptions,
  UpdateVariantPatch,
  ApproveInput,
} from './repos/drafts'
export type { PostRow, CreatePostInput, ListPostsOptions } from './repos/posts'
export type { VoiceProfileRow } from './repos/voice'
export type { PastPostRow, PastPostInput, ListPastPostsOptions } from './repos/pastPosts'
export type { SnapshotRow, SnapshotInput, ListSnapshotsOptions, PostPerformanceRow } from './repos/analytics'
export type { LedgerRow, LedgerInput, RecordResult, UsageTotals, ReserveResult, ListLedgerOptions } from './repos/usage'
export type { JobRow, EnqueueInput, EnqueueResult, ClaimInput, FailOptions, RequeueStaleResult, ListJobsOptions } from './repos/jobs'
export type {
  OAuthClientRow,
  OAuthCodeRow,
  OAuthTokenRow,
  CreateCodeInput,
  CreateTokenInput,
  RefreshUseResult,
} from './repos/oauth'
export type { ApprovalNonceRow, ApprovalNonceChannel } from './repos/approvalNonces'
export type { StripeEventRow } from './repos/stripeEvents'
export type { AuditRow, AuditInput, ListAuditOptions } from './repos/audit'
export type { AppSettingRow } from './repos/appSettings'
export type { BeatInput, HeartbeatRow, WorkerGroupName } from './repos/workerHeartbeats'
export type { BrandWithAccounts, OrphanedReservation } from './repos/maintenance'
