# Foundation summary: public API of the shared packages

For the next wave (MCP server, web app, worker). Generated from the TypeScript exports on
2026-10-31 after the foundation review (details and decisions: `foundation-verify.md`). Names and
signatures only; read the source doc comments for behaviour. `Platform`, `PlanTier`, `Actor`,
`JobType`, ... abbreviate the literal unions from `@app/core/types`.

## How to use the packages

```ts
// web (server code) / worker
import { createServicesFromEnv } from '@app/services'
const { services, config, db, provider, storage, transcriber, log, close } = await createServicesFromEnv(process.env)
// web: pass { withoutTranscriber: true }; tests: createServices({ db: await createTestDb(), provider: new FakePostingProvider({ clock }), storage: new MemoryStorage(), clock, config: { appUrl } })
```

Rules every caller relies on:

- **Business rules live in `@app/services`.** MCP tools, routes and job handlers parse transport
  details, call one service function, and map errors. Map `AppError` with `toErrorBody(err)`
  (`@app/core/errors`) for HTTP, and with `isError: true` + `err.message` for MCP tool results.
- **userId first.** Every user-facing function takes the signed-in user's id first and loads every
  other id with it: another user's id, a missing id and a malformed id are all `not_found`.
- **Inputs are `unknown`.** Pass tool arguments / request bodies straight through; services parse
  them with the core zod schemas and throw `AppError('validation', message, { issues })`.
- **`options.via`** (`'web' | 'mcp' | 'worker' | 'system'`) is recorded in the audit log. For
  approvals it is a security boundary (below).
- **MCP tool input schemas:** use the schemas in `@app/core/validation` (`z.toJSONSchema(schema, { io: 'input' })`).
  `ClipRequestSchema` now carries an optional `brandId` and at most 20 ranges.
- **Browser code** imports only browser-safe subpaths: `@app/core/{types,plans,platforms,validation,links,time,errors,log}`.

### Approvals (nothing publishes without a human)

- `approve_draft` (MCP): `services.drafts.preview(u, draftId)` + `services.approvals.issueNonce(u, draftId, { via: 'mcp' })`.
  Put `issued.nonce` **only** in the approval card's UI-only `_meta` (never in `content` or
  `structuredContent`). `issued.approveUrl` may be shown as text: it carries a separate `link`
  nonce that only the signed-in web app accepts.
- `approval_decide` / `approval_edit_variant` (app-only MCP tools): `approvals.decide(u, input, { via: 'mcp' })`,
  `approvals.editVariant(u, input, { via: 'mcp' })` (returns the next card nonce). `via` defaults to `'mcp'`
  (card nonces only).
- Web `/approve/[nonce]`: `approvals.verifyNonce(u, nonce)` then `approvals.decide(u, { draftId, nonce, decision }, { via: 'web' })`.
  The web queue: `approvals.issueNonce(u, draftId, { via: 'web' })` per card and the same `decide`. Always pass `{ via: 'web' }` from web routes.
- `via: 'worker' | 'system'` can never approve or reject (`forbidden`).

### OAuth for `/api/mcp` (new `services.oauth`)

| Route | Call |
| --- | --- |
| `GET /.well-known/oauth-authorization-server` | `oauth.authorizationServerMetadata()` |
| `GET /.well-known/oauth-protected-resource` (also `/.well-known/oauth-protected-resource/api/mcp`) | `oauth.protectedResourceMetadata()` |
| `POST /oauth/register` (JSON) | `oauth.registerClient(body)` → 201 JSON |
| `GET /oauth/authorize` | `oauth.validateAuthorizeRequest(query)` → consent page (sign in first). Error with `details.redirectTo` → redirect there; without → show the message |
| `POST /oauth/authorize` (consent form, signed in) | `oauth.authorize(user.id, params, 'approve' \| 'deny')` → redirect to `redirectTo` |
| `POST /oauth/token` (form-urlencoded) | `oauth.token(Object.fromEntries(new URLSearchParams(body)))` → JSON, `Cache-Control: no-store` |
| `POST /oauth/revoke` | `oauth.revoke(form)` → 200 always |
| `/api/mcp` | `oauth.verifyAccessToken(req.headers.get('authorization'))` → `{ userId, clientId, scopes }`; on error 401 + `WWW-Authenticate: oauth.wwwAuthenticate('invalid_token')` |

Map token/register/revoke errors with `oauthErrorResponse(err)` (`{ status, body: { error, error_description } }`).
Rate-limit `/oauth/register` and `/oauth/token` in the web layer.

### Worker job → service calls

`source_ingest`: `media.getForWorker` → download/copy → `media.markIngested(u, id, facts)` (or `media.markFailed`).
`transcribe`: `transcribeWithEngine(transcriber, { filePath, language })` → `transcripts.save(u, mediaId, { engine, result })`;
final failure → `transcripts.fail(u, mediaId, err)` (refund). `clip_render`: `clips.startRender` → ffmpeg → `storage.putFile(outputKey, …)` →
`clips.completeRender` (or `clips.failRender`). `publish_post`: `posts.preparePublish` → `provider.publish(plan.input)` →
`posts.recordPublishRequest` (throws → `posts.recordPublishError(u, id, err, { retryable: isRetryableProviderError(err), retryAfterMs })`).
`check_post_status`: `provider.getStatus` → `posts.recordPublishStatus`. `analytics_pull`, `import_past_posts`,
`carousel_render` / `video_render`, `cleanup` (`maintenance.cleanup()`; schedule it every 5–15 min): see `docs/handoff/services.md`.
Queue loop: `jobs.claim` → handler → `jobs.complete` / `jobs.fail(…, { permanent })`; payloads via `parseJobPayload(type, job.payload)`.

## `@app/services`: modules of `createServices(...)` / `createServicesFromEnv(...).services`

**users**
- `ensureUser(userId: string, input: { email: string; displayName?: string | null; timezone?: string; }) => Promise<UserRow>`
- `get(userId: string) => Promise<UserRow>`
- `getEntitlements(userId: string) => Promise<UserEntitlements>`
- `summary(userId: string) => Promise<UserSummary>`
- `updateProfile(userId: string, patch: { displayName?: string | null; timezone?: string; }) => Promise<UserRow>`

**brands**
- `create(userId: string, input: unknown, options?: { via?: Actor; }) => Promise<BrandRow>`
- `list(userId: string, options?: { status?: BrandStatus | (BrandStatus)[] | undefined; }) => Promise<BrandRow[]>`
- `get(userId: string, brandId: string) => Promise<BrandRow>`
- `update(userId: string, brandId: string, patch: unknown, options?: { via?: Actor; }) => Promise<BrandRow>`
- `archive(userId: string, brandId: string, options?: { via?: Actor; }) => Promise<BrandRow>`
- `restore(userId: string, brandId: string, options?: { via?: Actor; }) => Promise<BrandRow>`
- `reconcileLimit(userId: string, options?: { via?: Actor; }) => Promise<BrandLimitChange>`
- `ensureProviderProfile(userId: string, brandId: string) => Promise<BrandRow>`

**accounts**
- `connectLink(userId: string, input: unknown, options?: { redirectUrl?: string; via?: Actor; }) => Promise<ConnectLink>`
- `sync(userId: string, brandId: string, options?: { via?: Actor; }) => Promise<SyncResult>`
- `list(userId: string, input?: unknown) => Promise<AccountRow[]>`
- `get(userId: string, accountId: string) => Promise<AccountRow>`
- `disconnect(userId: string, accountId: string, options?: { via?: Actor; }) => Promise<AccountRow>`
- `applyProviderStatus(userId: string, brandId: string, platform: Platform, status: "active" | "pending" | "disconnected" | "needs_reauth") => Promise<AccountRow | null>`

**media**
- `createUpload(userId: string, input: unknown, options?: { purpose?: UploadPurpose; via?: Actor; }) => Promise<CreateUploadResult>`
- `completeUpload(userId: string, mediaId: string, input?: { uploadId?: string; parts?: unknown[]; }, options?: { via?: Actor; }) => Promise<{ media: MediaView; ingestQueued: boolean; }>`
- `registerDriveLink(userId: string, input: unknown, options?: { via?: Actor; }) => Promise<{ media: MediaView; }>`
- `get(userId: string, mediaId: string) => Promise<MediaView>`
- `getForWorker(userId: string, mediaId: string) => Promise<MediaRow>`
- `list(userId: string, input?: unknown) => Promise<{ items: MediaView[]; nextCursor: string | null; }>`
- `downloadUrl(userId: string, mediaId: string, ttlSec?: number) => Promise<{ url: string; expiresAt: string; }>`
- `remove(userId: string, mediaId: string, options?: { via?: Actor; }) => Promise<MediaView>`
- `markIngested(userId: string, mediaId: string, facts: { bytes?: number; durationMs?: number; width?: number; height?: number; mimeType?: string; sha256?: string; }) => Promise<IngestResult>`
- `markFailed(userId: string, mediaId: string, error: unknown) => Promise<MediaView>`

**transcripts**
- `get(userId: string, input: unknown) => Promise<TranscriptView>`
- `getRow(userId: string, mediaId: string) => Promise<TranscriptRow | null>`
- `search(userId: string, mediaId: string, query: string) => Promise<TranscriptMatch[]>`
- `save(userId: string, mediaId: string, input: { engine: string; result: unknown; }) => Promise<TranscriptRow>`
- `fail(userId: string, mediaId: string, error: unknown) => Promise<{ released: number; }>`

**clips**
- `requestClips(userId: string, input: unknown, options?: { brandId?: string; via?: Actor; }) => Promise<ClipRow[]>`
- `list(userId: string, input?: unknown) => Promise<ClipRow[]>`
- `get(userId: string, clipId: string) => Promise<ClipRow>`
- `startRender(userId: string, clipId: string) => Promise<RenderJobInput>`
- `completeRender(userId: string, clipId: string, output: { bytes: number; durationMs: number; width?: number; height?: number; mimeType?: string; sha256?: string; }) => Promise<{ clip: ClipRow; draft: DraftRow | null; }>`
- `failRender(userId: string, clipId: string, error: unknown) => Promise<ClipRow>`

**drafts**
- `approve(userId: string, input: unknown, options?: { via?: Actor; }) => Promise<DraftView>`
- `create(userId: string, input: unknown, options?: { via?: Actor; }) => Promise<DraftView>`
- `get(userId: string, draftId: string) => Promise<DraftView>`
- `list(userId: string, input?: unknown) => Promise<{ items: DraftSummary[]; nextCursor: string | null; }>`
- `preview(userId: string, draftId: string) => Promise<DraftPreview>`
- `updateVariant(userId: string, input: unknown, options?: { via?: Actor; }) => Promise<DraftView>`
- `editVariant(userId: string, input: unknown, options?: { via?: Actor; }) => Promise<DraftView>`
- `removeVariant(userId: string, input: unknown, options?: { via?: Actor; }) => Promise<DraftView>`
- `updateNotes(userId: string, input: unknown) => Promise<DraftRow>`
- `reject(userId: string, input: unknown, options?: { via?: Actor; }) => Promise<DraftRow>`
- `archive(userId: string, draftId: string, options?: { via?: Actor; }) => Promise<DraftRow>`
- `reopen(userId: string, draftId: string, options?: { via?: Actor; }) => Promise<DraftRow>`

**approvals**
- `issueNonce(userId: string, draftId: string, options?: { via?: Actor; }) => Promise<IssuedNonce>`
- `verifyNonce(userId: string, nonce: string, draftId?: string, options?: { via?: ApprovalVia; }) => Promise<NonceCheck>`
- `approve(userId: string, input: unknown, options?: { via?: Actor; }) => Promise<DraftView>`
- `reject(userId: string, input: unknown, options?: { via?: Actor; }) => Promise<DraftRow>`
- `decide(userId: string, input: unknown, options?: { via?: Actor; }) => Promise<{ decision: "reject" | "approve"; draft: DraftRow; }>`
- `editVariant(userId: string, input: unknown, options?: { via?: Actor; }) => Promise<{ draft: DraftView; nonce: IssuedNonce; }>`

**posts**
- `schedule(userId: string, input: unknown, options?: { via?: Actor; }) => Promise<PostRow[]>`
- `reschedule(userId: string, postId: string, atInput: string, options?: { via?: Actor; }) => Promise<PostRow>`
- `cancel(userId: string, postId: string, options?: { via?: Actor; reason?: string; }) => Promise<PostRow>`
- `get(userId: string, postId: string) => Promise<PostRow>`
- `status(userId: string, input: unknown) => Promise<PostRow[]>`
- `list(userId: string, input?: unknown) => Promise<PostRow[]>`
- `calendar(userId: string, input: unknown) => Promise<CalendarItem[]>`
- `preparePublish(userId: string, postId: string) => Promise<PublishPlan>`
- `recordPublishRequest(userId: string, postId: string, requestId: string) => Promise<PostRow>`
- `recordPublishStatus(userId: string, postId: string, status: PublishStatus, options?: { poll?: number; }) => Promise<StatusResult>`
- `recordPublishError(userId: string, postId: string, error: unknown, options?: { retryable?: boolean; retryAfterMs?: number; maxAttempts?: number; }) => Promise<PostRow>`
- `findByProviderRequest(providerRequestId: string, platform?: Platform) => Promise<PostRow[]>`
- `enqueueDue(now?: Date, limit?: number) => Promise<number>`
- `parsePostId(value: unknown) => string`

**voice**
- `save(userId: string, input: unknown, options?: { via?: Actor; }) => Promise<VoiceProfileView>`
- `get(userId: string, brandId: string) => Promise<VoiceProfileView | null>`
- `versions(userId: string, brandId: string, limit?: number) => Promise<VoiceProfileView[]>`
- `importedSamples(userId: string, brandId: string, input?: unknown) => Promise<VoiceSample[]>`

**imports**
- `importPastPosts(userId: string, input: unknown, options?: { via?: Actor; }) => Promise<ImportRequestResult>`
- `savePastPosts(userId: string, input: { brandId: string; platform: Platform; posts: unknown[]; }) => Promise<PastPostRow[]>`
- `summary(userId: string, brandId: string) => Promise<{ total: number; byPlatform: Partial<Record<Platform, number>>; }>`

**analytics**
- `summary(userId: string, input?: unknown) => Promise<BrandAnalytics[]>`
- `weeklyReview(userId: string, brandId: string) => Promise<WeeklyReview>`
- `recordPostMetrics(userId: string, postId: string, metrics: unknown, capturedAt?: Date) => Promise<SnapshotRow>`
- `recordAccountMetrics(userId: string, input: { brandId: string; platform: Platform; metrics: unknown; capturedAt?: Date; }) => Promise<SnapshotRow>`
- `enqueueDailyAccountPulls(now?: Date) => Promise<number>`

**usage**
- `balance(userId: string, meter?: UsageMeter) => Promise<UsageBalance>`
- `balances(userId: string) => Promise<Record<UsageMeter, UsageBalance>>`
- `reserve(userId: string, input: ReserveInput) => Promise<ReserveResult>`
- `settle(userId: string, input: SettleInput) => Promise<SettleResult>`
- `release(userId: string, input: { reserveKey: string; subjectId?: string; note?: string; }) => Promise<{ released: number; created: boolean; }>`
- `history(userId: string, options?: { meter?: UsageMeter; limit?: number; }) => Promise<LedgerRow[]>`

**billing**
- `applyStripeEvent(input: unknown, options?: ApplyStripeEventOptions) => Promise<StripeEventResult>`
- `checkoutParams(userId: string, input: unknown) => Promise<CheckoutParams>`
- `portalParams(userId: string) => Promise<{ customer: string; returnUrl: string; }>`
- `summary(userId: string) => Promise<{ user: UserRow; entitlements: UserEntitlements; monthlyPriceCents: number | null; }>`

**jobs**
- `enqueue<T extends JobType>(job: EnqueueJob<T>) => Promise<{ job: JobRow; created: boolean; }>`
- `claim(options: ClaimOptions) => Promise<JobRow[]>`
- `complete(jobId: string, workerId: string, result?: unknown) => Promise<JobRow | null>`
- `fail(jobId: string, workerId: string, error: unknown, options?: { retryInMs?: number; permanent?: boolean; now?: Date; }) => Promise<JobRow | null>`
- `extendLease(jobId: string, workerId: string, leaseSec: number) => Promise<boolean>`
- `requeueStale(now?: Date) => Promise<RequeueStaleResult>`
- `get(userId: string, jobId: string) => Promise<JobView>`
- `listForUser(userId: string, options?: { type?: JobType; limit?: number; }) => Promise<JobView[]>`
- `parsePayload<T extends JobType>(type: T, payload: unknown) => JobPayload<T>`
- `backoffMs(attempt: number) => number`

**renders**
- `requestCarousel(userId: string, input: unknown, options?: { via?: Actor; }) => Promise<JobView>`
- `requestVideo(userId: string, input: unknown, options?: { via?: Actor; }) => Promise<JobView>`
- `recordOutputs(userId: string, input: unknown) => Promise<MediaView[]>`

**oauth**
- `registerClient(input: unknown) => Promise<RegisteredClient>`
- `validateAuthorizeRequest(params: unknown) => Promise<AuthorizeRequest>`
- `authorize(userId: string, params: unknown, decision: "approve" | "deny") => Promise<{ redirectTo: string; }>`
- `token(input: unknown) => Promise<TokenResponse>`
- `revoke(input: unknown) => Promise<void>`
- `verifyAccessToken(authorization: string | null | undefined) => Promise<AccessContext>`
- `listConnections(userId: string) => Promise<OAuthConnection[]>`
- `revokeConnection(userId: string, familyId: string) => Promise<{ revoked: number; }>`
- `revokeAll(userId: string) => Promise<{ revoked: number; }>`
- `authorizationServerMetadata() => RFC 8414 document (issuer, endpoints, S256, auth method none, scopes)`
- `protectedResourceMetadata() => { resource: string; authorization_servers: string[]; scopes_supported: "social"[]; bearer_methods_supported: string[]; resource_name: string; }`
- `wwwAuthenticate(error?: "invalid_token") => string`

**audit**
- `record(userId: string, event: AuditEvent) => Promise<AuditRow>`
- `list(userId: string, options?: { subjectType?: string; subjectId?: string; action?: string; limit?: number; }) => Promise<AuditRow[]>`

**maintenance**
- `cleanup(options?: { now?: Date; sourceBatch?: number; }) => Promise<CleanupResult>`
- `applyProviderAccountStatus(input: { profileRef: string; platform: Platform; status: "active" | "pending" | "disconnected" | "needs_reauth"; }) => Promise<AccountRow | null>`

## Package exports

### `@app/core/types`

- `isPlatform(value: unknown) => value is Platform`
- `pickMetrics(input: unknown) => Partial<Record<MetricKey, number>>`
- Constants: `PLATFORMS`, `PlatformSchema`, `PLATFORM_LABELS`, `PLAN_TIERS`, `PlanTierSchema`, `SUBSCRIPTION_STATUSES`, `SubscriptionStatusSchema`, `BRAND_STATUSES`, `BrandStatusSchema`, `ACCOUNT_STATUSES`, `AccountStatusSchema`, `LIVE_ACCOUNT_STATUSES`, `MEDIA_KINDS`, `MediaKindSchema`, `MEDIA_ORIGINS`, `MediaOriginSchema`, `MEDIA_STATUSES`, `MediaStatusSchema`, `CLIP_STATUSES`, `ClipStatusSchema`, `DRAFT_STATUSES`, `DraftStatusSchema`, `POST_STATUSES`, `PostStatusSchema`, `ACTIVE_POST_STATUSES`, `JOB_STATUSES`, `JobStatusSchema`, `USAGE_METERS`, `UsageMeterSchema`, `USAGE_KINDS`, `UsageKindSchema`, `ACTORS`, `ActorSchema`, `PROVIDER_NAMES`, `TRANSCRIPT_ENGINES`, `VOICE_PROFILE_SOURCES`, `SNAPSHOT_SCOPES`, `OAUTH_TOKEN_KINDS`, `MCP_SCOPE`, `CONTENT_KINDS`, `JOB_TYPES`, `JobTypeSchema`, `WORKER_GROUPS`, `JOB_GROUP`, `METRIC_KEYS`, `MetricsSchema`, `TimedTextSchema`
- Types: `Platform`, `PlanTier`, `SubscriptionStatus`, `BrandStatus`, `AccountStatus`, `MediaKind`, `MediaOrigin`, `MediaStatus`, `ClipStatus`, `DraftStatus`, `PostStatus`, `JobStatus`, `UsageMeter`, `UsageKind`, `Actor`, `ProviderName`, `TranscriptEngine`, `VoiceProfileSource`, `SnapshotScope`, `OAuthTokenKind`, `ContentKind`, `JobType`, `WorkerGroup`, `JobRow`, `MetricKey`, `Metrics`, `TimedText`

### `@app/core/ports`

- Types: `ProviderAccount`, `PublishOptions`, `PublishInput`, `PublishState`, `PublishStatus`, `PastPostInput`, `PostingProvider`, `PresignedPut`, `ObjectHead`, `ObjectStorage`, `TranscriptResult`, `Transcriber`, `Clock`

### `@app/core/plans`

- `planFromLookupKey(lookupKey: string | null | undefined) => PlanTier | null`
- `addOnFromLookupKey(lookupKey: string | null | undefined) => "extra_brand" | "extra_clip_hour" | null`
- `entitlements(plan: PlanTier | null | undefined, addOns: Partial<AddOns> | null | undefined, status: SubscriptionStatus) => Entitlements`
- `monthlyPriceCents(plan: PlanTier, addOns?: Partial<AddOns>) => number`
- `formatCents(cents: number) => string`
- `clipHoursToSeconds(hours: number) => number`
- `secondsToClipHours(seconds: number) => number`
- Constants: `HOUR_SECONDS`, `GB`, `X_LINK_POSTS_PER_PLAN`, `PLANS`, `ADD_ON_KEYS`, `ADD_ONS`, `STRIPE_LOOKUP_KEYS`, `TRIAL`, `X_LINK_POST_COST_CENTS`, `SOURCE_LIMITS`, `NO_ADD_ONS`
- Types: `PlanDefinition`, `AddOnKey`, `AddOnDefinition`, `AddOns`, `Entitlements`

### `@app/core/platforms`

- `graphemeCount(text: string) => number`
- `utf8Bytes(text: string) => number`
- `utf16Units(text: string) => number`
- `xWeightedLength(text: string) => number`
- `measureText(text: string, unit: TextUnit) => number`
- `countInBusiestWindow(times: readonly Date[], at: Date, windowMs?: number) => number`
- `wouldExceedCap(platform: Platform, existing: readonly Date[], at: Date) => boolean`
- `countHashtags(text: string) => number`
- `countMentions(text: string) => number`
- `textLimitsFor(platform: Platform, options?: Readonly<Record<string, unknown>> | undefined) => readonly TextLimit[]`
- `validateVariant(platform: Platform, variant: VariantContent, ctx?: ValidateVariantContext) => ValidationIssue[]`
- `contentKindFor(media: readonly Pick<MediaFacts, "kind">[]) => "video" | "text" | "photos"`
- `blockingIssues(issues: readonly ValidationIssue[]) => ValidationIssue[]`
- Constants: `X_URL_LENGTH`, `X_MAX_WEIGHTED_LENGTH`, `X_LONG_TEXT_MAX`, `PLATFORM_RULES`, `CAPS_PER_24H`, `FACEBOOK_REELS_MAX_MS`, `YOUTUBE_SHORTS_MAX_MS`, `TEXT_ONLY_PLATFORMS`
- Types: `TextUnit`, `TextLimit`, `TitleRule`, `VideoRule`, `ImageRule`, `PlatformRules`, `MediaFacts`, `VariantContent`, `IssueSeverity`, `IssueField`, `IssueCode`, `ValidationIssue`, `ValidateVariantContext`

### `@app/core/validation`

- `cleanText(s: string) => string`
- `createScheduleAtSchema(clock?: Clock, maxDays?: number) => ZodSchema`
- `createScheduleInputSchema(clock?: Clock) => ZodSchema`
- `validateClipRanges(ranges: readonly Pick<{ startMs: number; endMs: number; title?: string; hook?: string; }, "startMs" | "endMs">[], durationMs: number) => RangeIssue[]`
- `mediaKindForMime(mime: string) => MediaKind | null`
- `textSchema(max: number) => ZodSchema`
- `lineSchema(min: number, max: number) => ZodSchema`
- `clipHoursLabel(seconds: number) => string`
- Constants: `IdSchema`, `TimezoneSchema`, `HttpsUrlSchema`, `PaginationSchema`, `TIKTOK_PRIVACY_LEVELS`, `PlatformOptionsSchemas`, `MAX_POST_TEXT`, `MAX_TITLE`, `MAX_MEDIA_PER_VARIANT`, `VariantInputSchema`, `DraftInputSchema`, `UpsertVariantInputSchema`, `EditVariantInputSchema`, `ListDraftsInputSchema`, `DraftRefSchema`, `RejectDraftInputSchema`, `SCHEDULE_MAX_DAYS`, `ScheduleAtSchema`, `ScheduleInputSchema`, `PostStatusInputSchema`, `MIN_CLIP_MS`, `MAX_CLIP_MS`, `MAX_CLIP_RANGES`, `CAPTION_STYLES`, `TimestampMsSchema`, `ClipRangeSchema`, `ClipRequestSchema`, `GetTranscriptInputSchema`, `TranscriptResultSchema`, `ALLOWED_MIME`, `MAX_UPLOAD_BYTES`, `UploadRequestSchema`, `DriveLinkInputSchema`, `EMOJI_POLICIES`, `HASHTAG_POLICIES`, `VoiceProfileSchema`, `SaveVoiceProfileInputSchema`, `RENDER_LIMITS`, `FONT_PRESETS`, `CAROUSEL_TEMPLATES`, `VIDEO_TEMPLATES`, `ThemeSchema`, `CarouselSlideSchema`, `RenderCarouselInputSchema`, `VideoSlideSchema`, `RenderVideoInputSchema`, `RENDER_SIZES`, `BrandInputSchema`, `BrandUpdateSchema`, `ConnectAccountInputSchema`, `ListAccountsInputSchema`, `ImportPastPostsInputSchema`, `GetAnalyticsInputSchema`
- Types: `PlatformOptions`, `VariantInput`, `DraftInput`, `UpsertVariantInput`, `EditVariantInput`, `ScheduleInput`, `CaptionStyle`, `ClipRange`, `ClipRequest`, `RangeIssue`, `VoiceProfile`, `SaveVoiceProfileInput`, `RenderCarouselInput`, `RenderVideoInput`

### `@app/core/links`

- `extractUrls(text: string) => UrlMatch[]`
- `hasLink(text: string) => boolean`
- `countUniqueLinks(text: string) => number`
- `isVideoSiteHost(host: string) => boolean`
- `checkSourceUrl(input: string) => SourceUrlCheck`
- `isAllowedDownloadHop(provider: "google_drive" | "dropbox" | "onedrive", input: string) => { ok: true; } | { ok: false; reason: SourceUrlRefusal; }`
- `redactUrl(input: string) => string`
- Constants: `DRIVE_PROVIDERS`, `DRIVE_HOSTS`, `DRIVE_DOWNLOAD_HOSTS`, `MAX_REDIRECT_HOPS`, `VIDEO_SITE_HOSTS`, `SOURCE_URL_MESSAGES`
- Types: `UrlMatch`, `DriveProvider`, `SourceUrlRefusal`, `SourceUrlCheck`

### `@app/core/crypto`

- `parseKeyRing(spec: string) => KeyRing`
- `createKeyRing(entries: readonly { version: string; key: Uint8Array<ArrayBufferLike>; }[]) => KeyRing`
- `generateKeySpec(version?: string) => string`
- `encrypt(ring: KeyRing, plaintext: string | Uint8Array<ArrayBufferLike>, aad?: string) => string`
- `decrypt(ring: KeyRing, sealed: string, aad?: string) => Buffer<ArrayBufferLike>`
- `decryptString(ring: KeyRing, sealed: string, aad?: string) => string`
- `encryptBytes(ring: KeyRing, plaintext: string | Uint8Array<ArrayBufferLike>, aad?: string) => Buffer<ArrayBufferLike>`
- `decryptBytes(ring: KeyRing, sealed: Uint8Array<ArrayBufferLike>, aad?: string) => Buffer<ArrayBufferLike>`
- `sealedKeyVersion(sealed: string | Uint8Array<ArrayBufferLike>) => string`
- `needsReencrypt(ring: KeyRing, sealed: string | Uint8Array<ArrayBufferLike>) => boolean`
- `reencrypt<T extends string | Uint8Array>(ring: KeyRing, sealed: T, aad?: string) => T`
- `sha256Hex(data: string | Uint8Array<ArrayBufferLike>) => string`
- `hmacSha256(key: string | Uint8Array<ArrayBufferLike>, data: string | Uint8Array<ArrayBufferLike>) => Buffer<ArrayBufferLike>`
- `hmacSha256Hex(key: string | Uint8Array<ArrayBufferLike>, data: string | Uint8Array<ArrayBufferLike>) => string`
- `randomToken(bytes?: number) => string`
- `safeEqual(a: string, b: string) => boolean`
- `uuidV5(name: string, namespace?: string) => string`
- Classes: `CryptoError`
- Constants: `KEY_BYTES`, `APP_UUID_NAMESPACE`
- Types: `KeyRing`

### `@app/core/log`

- `scrubString(input: string) => string`
- `redact<T = unknown>(value: T) => unknown`
- `isLogLevel(value: unknown) => value is "error" | "debug" | "info" | "warn"`
- `createLogger(options?: LoggerOptions) => Logger`
- Constants: `LOG_LEVELS`, `REDACTED`, `REDACT_KEY_PATTERN`, `silentLogger`
- Types: `LogLevel`, `LogFields`, `Logger`, `LogSink`, `LoggerOptions`

### `@app/core/hash`

- `stableStringify(value: unknown) => string`
- `contentHash(value: unknown) => string`

### `@app/core/errors`

- `isAppError(value: unknown) => value is AppError`
- `isErrorCode(value: unknown) => value is "bad_request" | "validation" | "unauthorized" | "forbidden" | "not_found" | "conflict" | "limit_exceeded" | "cap_reached" | "payment_required" | "rate_limited" | "unavailable" | "internal"`
- `ensure(condition: unknown, code: "bad_request" | "validation" | "unauthorized" | "forbidden" | "not_found" | "conflict" | "limit_exceeded" | "cap_reached" | "payment_required" | "rate_limited" | "unavailable" | "internal", message: string, details?: Readonly<Record<string, unknown>> | undefined) => asserts condition`
- `zodIssues(error: ZodError<unknown>) => FieldIssue[]`
- `fromZodError(error: ZodError<unknown>, what?: string) => AppError`
- `parseOrThrow<S extends z.ZodType>(schema: S, input: unknown, what?: string) => output<S>`
- `toErrorBody(error: unknown) => { status: number; body: ErrorBody; }`
- `notFound(what: string, details?: Readonly<Record<string, unknown>> | undefined) => AppError`
- `forbidden(message?: string, details?: Readonly<Record<string, unknown>> | undefined) => AppError`
- `conflict(message: string, details?: Readonly<Record<string, unknown>> | undefined) => AppError`
- `validationError(message: string, details?: Readonly<Record<string, unknown>> | undefined) => AppError`
- Classes: `AppError`
- Constants: `ERROR_CODES`, `HTTP_STATUS_BY_CODE`
- Types: `ErrorCode`, `ErrorDetails`, `FieldIssue`, `ErrorBody`

### `@app/core/config`

- `loadConfig(env?: Readonly<Record<string, string | undefined>>) => Config`
- `requireConfig<K extends keyof Config>(config: Config, keys: readonly K[]) => { [P in K]-?: NonNullable<Config[P]>; }`
- Constants: `ConfigSchema`, `CONFIG_KEYS`
- Types: `Config`, `ConfigKey`, `EnvSource`

### `@app/core/time`

- `fixedClock(at: string | number | Date) => Clock`
- `manualClock(start?: string | number | Date) => ManualClock`
- `isWithin(period: Period, at: Date) => boolean`
- `calendarMonthPeriod(at: Date) => Period`
- `usagePeriod(now: Date, subscriptionPeriod?: { start: Date | null; end: Date | null; } | null | undefined) => Period`
- `rollingWindow(end: Date, lengthMs?: number) => Period`
- `capQueryRange(at: Date, lengthMs?: number) => Period`
- `parseTimestampToMs(input: string) => number | null`
- `formatMs(ms: number) => string`
- `backoffMs(attempt: number, options?: BackoffOptions) => number`
- `addMs(date: Date, ms: number) => Date`
- `addDays(date: Date, days: number) => Date`
- `toIso(date: Date) => string`
- Constants: `SECOND_MS`, `MINUTE_MS`, `HOUR_MS`, `DAY_MS`, `ROLLING_24H_MS`, `systemClock`, `POST_METRIC_CHECKPOINTS_MS`
- Types: `ManualClock`, `Period`, `BackoffOptions`

### `@app/core/testing`

- `testKeyRing() => KeyRing`
- `testConfig(overrides?: Record<string, string | undefined>) => Config`
- `memoryLogger(level?: "error" | "debug" | "info" | "warn") => MemoryLogger`
- `fixedClock(at: string | number | Date) => Clock`
- `manualClock(start?: string | number | Date) => ManualClock`
- Constants: `TEST_TOKEN_ENCRYPTION_KEYS`, `TEST_SESSION_SECRET`
- Types: `CapturedLine`, `MemoryLogger`

### `@app/db`

- `createPostgresDb(url: string, options?: PostgresDbOptions) => Db`
- `createPgliteDb(dataDir?: string) => Promise<Db>`
- `wrapPglite(pg: PGlite) => Db`
- `migrate(db: Db, dir?: string, options?: MigrateOptions) => Promise<MigrateResult>`
- `readMigrations(dir: string) => MigrationFile[]`
- `findMigrationsDir(start?: string) => string`
- `installSupabaseShim(db: Db) => Promise<void>`
- `openDb(options: OpenDbOptions) => Promise<Db>`
- `normalizeDbError(error: unknown) => unknown`
- `isDbError(error: unknown, code?: string) => error is DbError`
- `isUniqueViolation(error: unknown, constraint?: string) => error is DbError`
- `isForeignKeyViolation(error: unknown, constraint?: string) => error is DbError`
- `isCheckViolation(error: unknown, constraint?: string) => error is DbError`
- `isRetryableDbError(error: unknown) => boolean`
- `dbErrorToAppError(error: unknown) => AppError | null`
- `json(value: unknown) => string`
- `stripSecretKeys(value: unknown, depth?: number) => unknown`
- `bindRepos(db: Db) => BoundRepos`
- Classes: `DbError`
- Constants: `SUPABASE_SHIM_SQL`, `PG_ERROR`, `APP_SQLSTATE`, `accounts (namespace)`, `analytics (namespace)`, `approvalNonces (namespace)`, `audit (namespace)`, `brands (namespace)`, `clips (namespace)`, `drafts (namespace)`, `jobs (namespace)`, `maintenance (namespace)`, `media (namespace)`, `oauth (namespace)`, `pastPosts (namespace)`, `posts (namespace)`, `stripeEvents (namespace)`, `transcripts (namespace)`, `usage (namespace)`, `users (namespace)`, `voice (namespace)`, `repos`
- Types: `Db`, `DbDriver`, `Row`, `PostgresDbOptions`, `MigrationFile`, `MigrateResult`, `MigrateOptions`, `OpenDbOptions`, `UserRow`, `EnsureUserInput`, `UserProfilePatch`, `UserBillingPatch`, `BrandRow`, `CreateBrandInput`, `ListBrandsOptions`, `UpdateBrandPatch`, `AccountRow`, `UpsertAccountInput`, `ListAccountsOptions`, `MediaRow`, `CreateMediaInput`, `ListMediaOptions`, `UpdateMediaPatch`, `TranscriptRow`, `SaveTranscriptInput`, `ClipRow`, `CaptionStyle`, `CreateClipInput`, `ListClipsOptions`, `UpdateClipPatch`, `DraftRow`, `VariantRow`, `DraftWithVariants`, `VariantInput`, `CreateDraftInput`, `ListDraftsOptions`, `UpdateVariantPatch`, `ApproveInput`, `PostRow`, `CreatePostInput`, `ListPostsOptions`, `VoiceProfileRow`, `PastPostRow`, `PastPostInput`, `ListPastPostsOptions`, `SnapshotRow`, `SnapshotInput`, `ListSnapshotsOptions`, `PostPerformanceRow`, `LedgerRow`, `LedgerInput`, `RecordResult`, `UsageTotals`, `ReserveResult`, `ListLedgerOptions`, `JobRow`, `EnqueueInput`, `EnqueueResult`, `ClaimInput`, `FailOptions`, `RequeueStaleResult`, `ListJobsOptions`, `OAuthClientRow`, `OAuthCodeRow`, `OAuthTokenRow`, `CreateCodeInput`, `CreateTokenInput`, `RefreshUseResult`, `ApprovalNonceRow`, `ApprovalNonceChannel`, `StripeEventRow`, `AuditRow`, `AuditInput`, `ListAuditOptions`, `BrandWithAccounts`, `OrphanedReservation`, `BoundRepos`

### `@app/db/testing`

- `createTestDb() => Promise<Db>`
- `resetTestDb(db: Db) => Promise<void>`
- `asUser<T>(db: Db, userId: string, fn: (db: Db) => Promise<T>) => Promise<T>`
- `asAnon<T>(db: Db, fn: (db: Db) => Promise<T>) => Promise<T>`
- `createTestUser(db: Db, options?: TestUserOptions) => Promise<UserRow>`
- `createTestBrand(db: Db, userId: string, options?: { name?: string; timezone?: string; status?: BrandStatus; providerProfileRef?: string | null; }) => Promise<BrandRow>`
- `createTestAccount(db: Db, userId: string, brandId: string, options?: { platform?: Platform; status?: "active" | "pending" | "needs_reauth"; provider?: string; handle?: string; }) => Promise<AccountRow>`
- `createTestMedia(db: Db, userId: string, options?: Partial<CreateMediaInput>) => Promise<MediaRow>`
- `createTestSourceVideo(db: Db, userId: string, options?: Partial<CreateMediaInput>) => Promise<MediaRow>`
- `createTestDraft(db: Db, userId: string, brandId: string, options?: { variants?: VariantInput[]; createdVia?: Actor; notes?: string | null; }) => Promise<DraftWithVariants>`
- `approveTestDraft(db: Db, userId: string, draftId: string, via?: Actor) => Promise<DraftRow>`
- `seedTenant(db: Db, options?: TestUserOptions & { platform?: Platform; }) => Promise<TestTenant>`
- `createTestScheduledPost(db: Db, tenant: TestTenant, options?: { scheduledFor?: Date; text?: string; }) => Promise<TestScheduledPost>`
- Types: `TestUserOptions`, `TestTenant`, `TestScheduledPost`

### `@app/posting`

- `createPostingProvider(options: CreatePostingProviderOptions) => PostingProvider`
- `createPostingProviderFromConfig(config: Pick<Config, "UPLOAD_POST_BASE_URL" | "POSTING_PROVIDER" | "UPLOAD_POST_API_KEY"> & Partial<Pick<Config, "UPLOAD_POST_PROFILE_PREFIX">>, deps?: PostingDeps) => PostingProvider`
- `webhookSecrets(value: string | null | undefined) => string[]`
- `accountsFromSocialAccounts(social: Record<string, unknown>) => ProviderAccount[]`
- `mapUploadStatus(body: { [x: string]: unknown; request_id?: string | null; job_id?: string | null; status?: string | null; message?: string | null; error?: string | null; completed?: number | null; total?: number | null; results?: unknown[] | null; }, platform: Platform | undefined, safe: SafeMessage) => PublishStatus`
- `normalizeMetrics(input: unknown) => Partial<Record<MetricKey, number>>`
- `parseUploadPostWebhook(input: VerifyWebhookInput) => UploadPostWebhookEvent`
- `parseUploadPostWebhookPayload(payload: unknown, deliveryId?: string | null) => UploadPostWebhookEvent`
- `platformFromRequestId(requestId: string, platforms: readonly (Platform)[]) => Platform | undefined`
- `profileRefForBrand(brandId: string, prefix?: string) => string`
- `requestIdFor(platform: Platform, idempotencyKey: string) => string`
- `signUploadPostWebhook(rawBody: string, secret: string, now?: Date) => Record<string, string>`
- `verifyUploadPostSignature(input: VerifyWebhookInput) => void`
- `providerError(reason: "not_found" | "conflict" | "cap_reached" | "rate_limited" | "provider_auth" | "provider_rejected" | "provider_unavailable", message: string, details: Omit<ProviderErrorDetails, "reason">) => AppError`
- `providerErrorReason(error: unknown) => "not_found" | "conflict" | "cap_reached" | "rate_limited" | "provider_auth" | "provider_rejected" | "provider_unavailable" | undefined`
- `retryAfterSeconds(error: unknown) => number | undefined`
- `isRetryableProviderError(error: unknown) => boolean`
- `safeProviderMessage(raw: unknown, options?: SafeMessageOptions) => string | null`
- `safeProviderCode(raw: unknown) => string | undefined`
- `parsePublishInput(input: unknown, opts?: ParsePublishOptions) => ParsedPublishInput`
- Classes: `UploadPostProvider`, `FakePostingProvider`
- Constants: `UPLOAD_POST_DEFAULT_BASE_URL`, `CONNECT_PAGE_PLATFORMS`, `WEBHOOK_HEADERS`, `WEBHOOK_TOLERANCE_SEC`, `MAX_WEBHOOK_BYTES`, `PROVIDER_ERROR_REASONS`, `ERROR_CODE_BY_REASON`, `TEXT_PLATFORMS`, `PHOTO_PLATFORMS`, `VIDEO_PLATFORMS`, `MAX_MEDIA_URLS`, `ProfileRefSchema`, `IdempotencyKeySchema`, `RequestIdSchema`, `RedirectUrlSchema`
- Types: `AccountStatusEvent`, `ConnectPageBranding`, `FetchLike`, `IgnoredEvent`, `ProviderDestination`, `UploadCompletedEvent`, `UploadPostProfile`, `UploadPostProviderOptions`, `UploadPostWebhookEvent`, `VerifyWebhookInput`, `WebhookHeaders`, `CreatePostingProviderOptions`, `PostingDeps`, `ProviderErrorReason`, `ProviderErrorDetails`, `SafeMessageOptions`, `ParsedPublishInput`, `ParsePublishOptions`, `FakeCall`, `FakeMethod`, `FakePostingProviderOptions`, `FakeUpload`

### `@app/storage`

- `createR2Client(config: R2StorageConfig) => S3Client`
- `r2Endpoint(config: Pick<R2StorageConfig, "accountId" | "endpoint">) => string`
- `mapS3Error(err: unknown, what: string) => AppError`
- `createLocalStorageHandler(backend: LocalBackend, options?: LocalStorageHandlerOptions) => (request: Request) => Promise<Response>`
- `parseRange(header: string | null, size: number) => { start: number; end: number; } | "invalid" | null`
- `normalizeExt(ext: unknown) => string`
- `userPrefix(userId: string) => string`
- `sourceKey(userId: string, mediaId: string, ext: string) => string`
- `uploadKey(userId: string, mediaId: string, ext: string) => string`
- `clipKey(userId: string, clipId: string, ext?: string) => string`
- `renderKey(userId: string, mediaId: string, ext: string) => string`
- `parseKey(key: string) => ParsedKey | null`
- `isKeyOwnedBy(key: string, userId: string) => boolean`
- `keyOwner(key: string) => string | null`
- `assertValidKey(key: unknown) => string`
- `extForMime(mime: string) => string | null`
- `mimeForExt(ext: string) => string | null`
- `storageError(reason: "not_found" | "invalid_key" | "invalid_input" | "too_large" | "storage_auth" | "storage_unavailable", message: string, extra?: { status?: number; cause?: unknown; } | undefined) => AppError`
- `storageErrorReason(error: unknown) => "not_found" | "invalid_key" | "invalid_input" | "too_large" | "storage_auth" | "storage_unavailable" | undefined`
- `planParts(totalBytes: number, partBytes?: number) => PartPlan[]`
- `supportsMultipart<T extends object>(storage: T) => storage is T & MultipartStorage`
- `checkUploadId(uploadId: unknown) => string`
- `checkPartNumber(partNumber: unknown) => number`
- `checkCompletedParts(parts: unknown) => CompletedPart[]`
- `normalizeEtag(etag: string) => string`
- `devStorageBaseUrl(appUrl: string) => string`
- `createStorageFromConfig(config: StorageConfig, deps?: StorageFactoryDeps) => AppStorage`
- `isLocalStorage(storage: unknown) => storage is LocalStorageBase`
- Classes: `R2Storage`, `LocalStorageBase`, `FsStorage`, `MemoryStorage`, `LocalUrlSigner`
- Constants: `MAX_SINGLE_PUT_BYTES`, `MAX_PRESIGN_TTL_SEC`, `DEFAULT_PUT_TTL_SEC`, `ContentTypeSchema`, `DEFAULT_MULTIPART_THRESHOLD_BYTES`, `KEY_AREAS`, `MAX_KEY_LENGTH`, `STORAGE_ERROR_REASONS`, `MIN_PART_BYTES`, `DEFAULT_PART_BYTES`, `MAX_PARTS`, `MAX_MULTIPART_BYTES`, `UploadIdSchema`, `PartNumberSchema`, `CompletedPartsSchema`, `DEV_STORAGE_PATH`, `DEV_STORAGE_FALLBACK_SECRET`
- Types: `R2StorageConfig`, `R2StorageDeps`, `S3Like`, `Presigner`, `LocalStorageOptions`, `LocalBackend`, `LocalObject`, `FsStorageOptions`, `MemoryStorageOptions`, `LocalGrant`, `LocalOp`, `LocalStorageHandlerOptions`, `KeyArea`, `ParsedKey`, `StorageErrorReason`, `PartPlan`, `CompletedPart`, `MultipartStorage`, `StorageDriverName`, `AppStorage`, `StorageConfig`, `StorageFactoryDeps`

### `@app/transcription`

- `audioContentType(filePath: string) => string`
- `whisperEndpoint(url: string) => string`
- `fakeWords(text: string, options?: Omit<FakeTranscriberOptions, "text" | "language" | "words" | "name" | "requireFile">) => TimedText[]`
- `createFallbackTranscriber(engines: readonly Transcriber[], options?: FallbackOptions) => FallbackTranscriber`
- `transcribeWithEngine(transcriber: Transcriber, input: TranscribeInput) => Promise<DetailedTranscription>`
- `transcriptionError(reason: "rate_limited" | "input_invalid" | "aborted" | "engine_auth" | "engine_rejected" | "engine_failed" | "engine_unavailable" | "malformed_response" | "timeout", message: string, extra?: TranscriptionErrorExtra) => AppError`
- `transcriptionErrorReason(error: unknown) => "rate_limited" | "input_invalid" | "aborted" | "engine_auth" | "engine_rejected" | "engine_failed" | "engine_unavailable" | "malformed_response" | "timeout" | "all_failed" | undefined`
- `shouldFallBack(error: unknown) => boolean`
- `isRetryableTranscriptionError(error: unknown) => boolean`
- `safeEngineMessage(raw: unknown, secrets?: readonly (string | undefined)[]) => string | null`
- `segmentsFromWords(words: TimedText[], options?: SegmentOptions) => TimedText[]`
- `wordsFromSegments(segments: TimedText[]) => TimedText[]`
- `normalizeLanguage(raw: string | null | undefined) => string`
- `normalizeTranscript(raw: RawTranscript, engine: string, options?: SegmentOptions) => TranscriptResult`
- `createTranscriberFromConfig(config: TranscriptionConfig, deps?: TranscriptionFactoryDeps) => Transcriber`
- Classes: `WhisperTranscriber`, `AssemblyAITranscriber`, `FakeTranscriber`, `FallbackTranscriber`
- Constants: `WhisperVerboseJsonSchema`, `WHISPER_DEFAULT_MAX_FILE_BYTES`, `WHISPER_DEFAULT_TIMEOUT_MS`, `AssemblyAITranscriptSchema`, `ASSEMBLYAI_DEFAULT_BASE_URL`, `FAKE_TRANSCRIPT_TEXT`, `TRANSCRIPTION_ERROR_REASONS`
- Types: `DetailedTranscriber`, `DetailedTranscription`, `FetchLike`, `Sleep`, `TranscribeInput`, `TranscriptionAttempt`, `WhisperOptions`, `AssemblyAIOptions`, `FakeTranscriberOptions`, `FallbackOptions`, `TranscriptionErrorReason`, `TranscriptionErrorExtra`, `RawTiming`, `RawTranscript`, `SegmentOptions`, `TranscriptionConfig`, `TranscriptionFactoryDeps`

### `@app/services`

- `createServices(deps: ServicesDeps) => Services`
- `translateError(error: unknown) => unknown`
- `resolveServicesConfig(partial?: Partial<ServicesConfig>) => ServicesConfig`
- `servicesConfigFromAppConfig(config: Config, env?: Readonly<Record<string, string | undefined>>) => ServicesConfig`
- `effectiveStatus(user: Pick<UserRow, "subscriptionStatus" | "trialEndsAt" | "stripeSubscriptionId">, now: Date) => SubscriptionStatus`
- `userEntitlements(user: UserRow, now: Date) => UserEntitlements`
- `isJobType(value: unknown) => value is JobType`
- `jobView(job: JobRow) => JobView`
- `parseJobPayload<T extends JobType>(type: T, payload: unknown) => JobPayload<T>`
- `accountProblem(platform: Platform, account: AccountRow | null) => string | null`
- `isClipSource(media: Pick<MediaRow, "kind" | "origin" | "rightsAttestedAt">) => boolean`
- `mediaView(row: MediaRow) => MediaView`
- `searchSegments(segments: readonly TimedText[], query: string, limit?: number) => TranscriptMatch[]`
- `channelsFor(via: Actor) => readonly ApprovalNonceChannel[]`
- `nonceError(reason: NonceProblem, details?: Record<string, unknown>) => AppError`
- `busiestWindowCount(times: readonly Date[], at: Date) => number`
- `exceedsCap(platform: Platform, times: readonly Date[], at: Date) => boolean`
- `nextFreeSlot(platform: Platform, times: readonly Date[], at: Date) => Date | null`
- `engagementScore(m: Partial<Record<MetricKey, number>>) => number`
- `clipReserveKey(mediaId: string) => string`
- `createServicesFromEnv(env?: Readonly<Record<string, string | undefined>>, options?: ServicesFromEnvOptions) => Promise<ServicesFromEnv>`
- `checkRedirectUri(raw: string) => string | null`
- `oauthErrorCode(error: unknown) => OAuthErrorCode`
- `oauthErrorResponse(error: unknown) => { status: number; body: { error: OAuthErrorCode; error_description: string; }; }`
- `pkceChallenge(verifier: string) => string`
- `redirectUriMatches(registered: string, requested: string) => boolean`
- Constants: `DEFAULT_SERVICES_CONFIG`, `PRICE_KEYS`, `STRIPE_PRICE_ENV`, `JOB_PAYLOAD_SCHEMAS`, `MAX_TRANSCRIPT_CHARS`, `HANDLED_STRIPE_EVENTS`, `STRIPE_STATUS_MAP`, `StripeEventSchema`, `StripeSubscriptionSchema`
- Types: `Services`, `ServicesDeps`, `Ctx`, `PriceKey`, `ServicesConfig`, `UserEntitlements`, `ClaimOptions`, `EnqueueJob`, `JobPayload`, `JobPayloadInput`, `JobView`, `ConnectLink`, `SyncResult`, `BrandLimitChange`, `CreateUploadResult`, `IngestFacts`, `IngestResult`, `MediaView`, `UploadPurpose`, `UploadTarget`, `TranscriptMatch`, `TranscriptStatus`, `TranscriptView`, `RenderJobInput`, `RenderOutput`, `DraftPreview`, `DraftSummary`, `DraftView`, `PreviewMedia`, `PreviewVariant`, `VariantAccount`, `VariantView`, `ApprovalVia`, `IssuedNonce`, `NonceCheck`, `NonceProblem`, `CalendarItem`, `PublishPlan`, `StatusResult`, `VoiceProfileView`, `VoiceSample`, `ImportRequestResult`, `BrandAnalytics`, `FollowerChange`, `PeriodTotals`, `PostPerformance`, `WeeklyReview`, `ReserveInput`, `ReserveResult`, `SettleInput`, `SettleResult`, `UsageBalance`, `ApplyStripeEventOptions`, `CheckoutLineItem`, `CheckoutParams`, `StripeEventInput`, `StripeEventResult`, `AuditEvent`, `CleanupResult`, `ServicesFromEnv`, `ServicesFromEnvOptions`, `AccessContext`, `AuthorizeRequest`, `OAuthConnection`, `OAuthErrorCode`, `RegisteredClient`, `TokenResponse`

## `@app/db` repositories (`bindRepos(db)` or `repo.fn(db, userId, ...)`)

Every function takes `db` first (pre-applied by `bindRepos`) and, except the system lookups
(`jobs.*`, `oauth.*`, `approvalNonces.findByHash`, `stripeEvents.*`, `users.findByStripe*`,
`brands.findByProviderProfileRef`, `posts.findByProviderRequest`, `maintenance.*`), `userId` second.
Prefer services; use repos directly only for things services do not cover.

- **accounts**: `upsertLive`, `get`, `findLive`, `list`, `setStatus`, `markSynced`, `setCredentials`, `getCredentials`
- **analytics**: `insert`, `listForBrand`, `latestForPosts`, `latestAccountSnapshots`, `postPerformance`
- **approvalNonces**: `create`, `get`, `findByHash`, `consume`
- **audit**: `record`, `list`
- **brands**: `create`, `get`, `findByProviderProfileRef`, `lockForUpdate`, `list`, `countActive`, `update`, `setStatus`, `setProviderProfileRef`, `suspendNewest`
- **clips**: `create`, `createMany`, `get`, `list`, `update`
- **drafts**: `create`, `get`, `lockForUpdate`, `getWithVariants`, `list`, `listVariants`, `listVariantsForDrafts`, `getVariant`, `upsertVariant`, `updateVariant`, `deleteVariant`, `approve`, `reject`, `archive`, `reopen`, `updateNotes`, `moveToBrand`, `remove`
- **jobs**: `enqueue`, `claim`, `complete`, `fail`, `extendLease`, `requeueStale`, `get`, `getByIdempotencyKey`, `listForUser`, `retry`
- **maintenance**: `deleteExpiredApprovalNonces`, `deleteExpiredOAuthCodes`, `deleteExpiredOAuthTokens`, `deleteUnusedOAuthClients`, `pruneFinishedJobs`, `listStaleSourceMedia`, `listDuePosts`, `listPublishedBetween`, `listBrandsForAnalytics`, `listOrphanedClipReservations`
- **media**: `create`, `get`, `getMany`, `findByStorageKey`, `list`, `update`, `storageBytes`
- **oauth**: `createClient`, `getClient`, `touchClient`, `createCode`, `consumeCode`, `getCode`, `createToken`, `findTokenByHash`, `findActiveToken`, `useRefreshToken`, `revokeToken`, `revokeFamily`, `revokeAllForUser`, `listActiveForUser`
- **pastPosts**: `upsert`, `upsertMany`, `get`, `list`, `count`
- **posts**: `create`, `get`, `list`, `countInWindow`, `activeTimesInRange`, `reschedule`, `cancel`, `claimForPublish`, `setProviderRequest`, `markPublished`, `markFailed`, `requeue`, `findByProviderRequest`
- **stripeEvents**: `record`, `get`, `markProcessed`, `lockUnprocessed`
- **transcripts**: `save`, `getByMedia`, `get`
- **usage**: `record`, `totals`, `reserveWithinLimit`, `listForSubject`, `list`
- **users**: `ensure`, `devEnsureAuthUser`, `get`, `lockForUpdate`, `updateProfile`, `updateBilling`, `findByStripeCustomerId`, `findByStripeSubscriptionId`, `remove`
- **voice**: `save`, `getLatest`, `getVersion`, `listVersions`
