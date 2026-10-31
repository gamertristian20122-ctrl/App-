// @app/services: every business rule lives here. The MCP server, the web app and the workers are
// thin shells around createServices({ db, provider, storage, clock, config, log }).
// Every user-facing function takes the signed-in user's id first and checks that every id it
// receives belongs to that user (other users' ids → not_found). Errors are AppErrors.

export { createServices, type Services } from './services'
export type { ServicesDeps, Ctx } from './context'
export { translateError } from './context'
export {
  DEFAULT_SERVICES_CONFIG,
  PRICE_KEYS,
  STRIPE_PRICE_ENV,
  resolveServicesConfig,
  servicesConfigFromAppConfig,
  type PriceKey,
  type ServicesConfig,
} from './config'
export { effectiveStatus, userEntitlements, type UserEntitlements } from './entitlements'
export {
  JOB_PAYLOAD_SCHEMAS,
  isJobType,
  jobView,
  parseJobPayload,
  type ClaimOptions,
  type EnqueueJob,
  type JobPayload,
  type JobPayloadInput,
  type JobView,
} from './jobs'
export { accountProblem, type ConnectLink, type SyncResult } from './accounts'
export type { BrandLimitChange } from './brands'
export { isClipSource, mediaView, type CreateUploadResult, type IngestFacts, type IngestResult, type MediaView, type UploadPurpose, type UploadTarget } from './media'
export { MAX_TRANSCRIPT_CHARS, searchSegments, type TranscriptMatch, type TranscriptStatus, type TranscriptView } from './transcripts'
export type { RenderJobInput, RenderOutput } from './clips'
export type { DraftPreview, DraftSummary, DraftView, PreviewMedia, PreviewVariant, VariantAccount, VariantView } from './drafts'
export { channelsFor, nonceError, type ApprovalVia, type IssuedNonce, type NonceCheck, type NonceProblem } from './approvals'
export { busiestWindowCount, exceedsCap, nextFreeSlot, type CalendarItem, type PublishPlan, type ResumePlan, type StatusResult } from './posts'
export { engagementScore, type VoiceProfileView, type VoiceSample } from './voice'
export type { ImportRequestResult } from './imports'
export type { BrandAnalytics, FollowerChange, PeriodTotals, PostPerformance, WeeklyReview } from './analytics'
export { clipReserveKey, type ReserveInput, type ReserveResult, type SettleInput, type SettleResult, type UsageBalance } from './usage'
export {
  HANDLED_STRIPE_EVENTS,
  STRIPE_STATUS_MAP,
  StripeEventSchema,
  StripeSubscriptionSchema,
  type ApplyStripeEventOptions,
  type CheckoutLineItem,
  type CheckoutParams,
  type StripeEventInput,
  type StripeEventResult,
} from './billing'
export type { AuditEvent } from './audit'
export type { CleanupResult } from './maintenance'
export { createServicesFromEnv, type ServicesFromEnv, type ServicesFromEnvOptions } from './wiring'
export {
  checkRedirectUri,
  oauthErrorCode,
  oauthErrorResponse,
  pkceChallenge,
  redirectUriMatches,
  type AccessContext,
  type AuthorizeRequest,
  type OAuthConnection,
  type OAuthErrorCode,
  type RegisteredClient,
  type TokenResponse,
} from './oauth'
