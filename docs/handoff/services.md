# Services handoff: `@app/services`

Owner: services agent. Covers `packages/services/**`, `apps/web/lib/services.ts` and `apps/worker/src/context.ts`. Requests for changes elsewhere are at the end.

`@app/services` is the only home of business rules. The MCP server, the web app and the workers are thin shells around it: they parse transport details (HTTP, MCP, job rows), call one service function, and map `AppError`s to responses.

## What exists

| Path | What |
| --- | --- |
| `src/services.ts` | `createServices({ db, provider, storage, clock?, config?, log? })` → the modules below |
| `src/wiring.ts` | `createServicesFromEnv(env, options)` → `{ services, config, db, provider, storage, transcriber, clock, log, close }`; `openDbFromConfig`, `pgliteDirFromUrl` |
| `src/config.ts` | `ServicesConfig` (defaults in `DEFAULT_SERVICES_CONFIG`), `resolveServicesConfig`, `servicesConfigFromAppConfig(config, env)`, `STRIPE_PRICE_ENV` |
| `src/context.ts` | `Ctx`, `withErrors` (DbError → AppError), ownership guards (`requireBrand`, `requireDraft`, …), `errorMessage` (scrubbed) |
| `src/entitlements.ts` | `userEntitlements(user, now)` (plan + add-ons + status + trial + usage period), `effectiveStatus`, `requireCanCreate`, `requireCanProcessMedia` |
| `src/users.ts` `brands.ts` `accounts.ts` `media.ts` `transcripts.ts` `clips.ts` `drafts.ts` `approvals.ts` `posts.ts` `voice.ts` `imports.ts` `analytics.ts` `usage.ts` `billing.ts` `jobs.ts` `renders.ts` `audit.ts` `maintenance.ts` | one module each |
| `apps/web/lib/services.ts` | `getServices()`, `getServicesRuntime()` (cached on `globalThis`, retried after a failed build), `setServicesRuntimeForTests()` |
| `apps/worker/src/context.ts` | `createWorkerContext(env, { workerId?, signal?, fetch?, … })` → `WorkerContext & { services, provider, storage, transcriber, config, db, log, tmpDir, close }` (`FullWorkerContext`) |

Dependencies added to `packages/services/package.json`: `@app/posting`, `@app/storage`, `@app/transcription` (workspace) and `zod ^4.6.7` (already in the lockfile for other packages). Links were created by hand in `packages/services/node_modules`; see Requests (lockfile).

## Using it

```ts
// web (server only)
import { getServices } from '@/lib/services'
const s = await getServices()
const view = await s.drafts.create(user.id, body, { via: 'web' })

// worker
import { createWorkerContext } from './context'
const ctx = await createWorkerContext(process.env)      // ctx.services, ctx.provider, ctx.storage, ctx.transcriber, ctx.tmpDir, ctx.log …

// tests
const s = createServices({ db: await createTestDb(), provider: new FakePostingProvider({ clock }), storage: new MemoryStorage(), clock, config: { appUrl: 'https://app.test' } })
```

- `createServicesFromEnv` runs `loadConfig(env)`. Database: `DATABASE_URL=postgres://…` → postgres.js; `DATABASE_URL=pglite:<dir>` (or `pglite:` / `pglite:memory`) → local PGlite with migrations (refused when `APP_ENV=production`); no `DATABASE_URL` → PGlite at `PGLITE_DATA_DIR`. Provider from `POSTING_PROVIDER` (+ optional `UPLOAD_POST_PROFILE_PREFIX`), storage from `STORAGE_DRIVER`, transcriber from `TRANSCRIPTION_PROVIDER` (the web passes `withoutTranscriber: true`). Every adapter takes `options.fetch` (tests pass a mock). `close()` closes the pool.
- The web's dev-storage route must serve the same storage instance: `(await getServicesRuntime()).storage`.
- Optional env (not in core config): `STRIPE_PRICE_STARTER|PLUS|PRO|EXTRA_BRAND|EXTRA_CLIP_HOUR` (Stripe price ids, `price_…`), `UPLOAD_POST_PROFILE_PREFIX`.

## Conventions every caller relies on

- **userId first.** Every user-facing function takes the signed-in user's id first. Every id it receives (brand, draft, media, account, post, clip, job, nonce) is loaded with that user's id; another user's id, a missing id and a malformed id all give `not_found` (no existence oracle).
- **Inputs are `unknown`.** Functions parse their input with the core zod schemas (`DraftInputSchema`, `createScheduleInputSchema(clock)`, `ClipRequestSchema`, `UploadRequestSchema`, `DriveLinkInputSchema`, …). Pass tool/route input straight through; failures are `AppError('validation', message, { issues })`.
- **`options.via`** (`'web' | 'mcp' | 'worker' | 'system'`) is recorded in the audit log and on drafts (`created_via`, `approved_via`). Defaults: MCP-ish functions `'mcp'`, web-ish `'web'`.
- **Errors** are `AppError` (`toErrorBody()` / `.status`): `validation` 400, `not_found` 404, `conflict` 409, `forbidden` 403 (bad/used/expired nonce), `limit_exceeded` 403 (details: `limit`, `used`, `remaining`, `requested`), `cap_reached` 429 (details: `platform`, `cap`, `suggestedAt`), `payment_required` 402 (held / past_due), `unauthorized` 401 (no app user row). Database errors are translated (`withErrors`). Messages are neutral and safe to show to users and AIs.
- **Dates** are `Date` objects in results (rows are camelCase from `@app/db`). Media results are `MediaView` (the drive share link `sourceUrl` is never returned except by `media.getForWorker`).

## Module reference

### users
- `ensureUser(userId, { email, displayName?, timezone? })` — creates the app user (auth user must exist: with DEV_AUTH on PGlite call `users.devEnsureAuthUser` from `@app/db` first) and starts the **7-day Starter trial once** (status `trialing`, `trial_ends_at`). Later calls refresh the email. Call it at sign-in / auth callback, not on every request.
- `get`, `getEntitlements(userId)` → `UserEntitlements` (`plan, status, trial, trialExpired, brands, clipSeconds, xLinkPosts, storageBytes, canPublish, canCreate, canProcessMedia, period {start,end}, trialEndsAt, addOns`), `summary`, `updateProfile`.

### brands
- `create(userId, BrandInput, {via})` — locks the user row, counts active brands, refuses with `limit_exceeded` above plan + `extra_brands`; then best-effort creates the provider profile (retried lazily by `accounts.connectLink`).
- `list(userId, {status?})`, `get`, `update(userId, brandId, BrandUpdate)`, `archive` (cancels the brand's scheduled posts; accounts stay connected), `restore` (archived/suspended → active, limit-checked), `reconcileLimit` (downgrade: suspend newest active brands above the limit; upgrade: restore oldest suspended), `ensureProviderProfile`.
- A **suspended** brand refuses new work with `payment_required`; publishing for it is deferred.

### accounts
- `connectLink(userId, { brandId, platform }, { redirectUrl? })` → `{ url, expiresAt, brandId, platform }` (provider-hosted page; `redirectUrl` must be https or localhost).
- `sync(userId, brandId)` → `{ accounts, connected[], disconnected[] }` — mirrors `provider.listAccounts`; call it when the user returns from the connect page and from the account webhook.
- `list(userId, { brandId? })`, `get`, `disconnect(userId, accountId)` (provider disconnect + cancels the account's scheduled posts), `applyProviderStatus(userId, brandId, platform, status)`.

### media
- `createUpload(userId, UploadRequest, { purpose?: 'post' | 'clip_source' })` → `{ media, upload }`. `upload` is `{ mode: 'single', method: 'PUT', url, headers, bytes, expiresAt }`, or above 5 GB `{ mode: 'multipart', uploadId, partBytes, parts: [{ partNumber, bytes, url, headers }] }`. Checks type/size (core), the storage allowance, the brand. **Clip sources need `purpose: 'clip_source'`, a video and `rightsAttested: true`** (that sets `rights_attested_at`); `canProcessMedia` is required for them.
- `completeUpload(userId, mediaId, { uploadId?, parts? })` — completes multipart if given, then `head()`s the object: size and type must equal what was declared (else the object is deleted and the media fails). Images → `ready`. Videos/audio → `source_ingest` job (`ingestQueued: true`). Idempotent once ready.
- `registerDriveLink(userId, { url, rightsAttested: true, brandId? })` — only https links on Google Drive / Dropbox / OneDrive hosts (`checkSourceUrl`); YouTube and other video sites → `validation` with `details.reason = 'video_site_forbidden'`, other hosts `host_not_allowed`, http `not_https`. Creates a pending `drive_link` video (key `users/{u}/sources/{uuid}.mp4`) and a `source_ingest` job. We never download YouTube.
- `get`, `list(userId, { brandId?, kind?, status?, limit?, cursor? })`, `downloadUrl(userId, mediaId, ttlSec?)`, `remove` (deletes the file, keeps the row as `deleted`, releases a pending source's reservation).
- Worker: `getForWorker(userId, mediaId)` (full row incl. `sourceUrl`), `markIngested(userId, mediaId, { durationMs, bytes, width, height, mimeType, sha256 })`, `markFailed(userId, mediaId, error)`.

### transcripts
- `get(userId, GetTranscriptInput)` → `TranscriptView` `{ status: 'ready'|'processing'|'failed'|'not_a_source', message?, language, durationMs, text, segments, words? (only with a range), matches? (with query), engine }`. Text over 60 000 chars is truncated with a message asking for a range.
- `search(userId, mediaId, query)`, `getRow` (worker captions).
- Worker: `save(userId, mediaId, { engine, result })` validates with `TranscriptResultSchema`, stores, **settles** the clip-seconds reservation (idempotent). `fail(userId, mediaId, error)` **releases** it (auto-refund).

### clips
- `requestClips(userId, ClipRequest, { brandId? })` — own transcribed source only (`isClipSource`, status ready, transcript present), ranges 3–180 s inside the duration, **≤ 20 ranges per request**, **≤ 60 queued/rendering/ready clips per source**, `canProcessMedia`. Brand: option → source's brand → the user's only active brand (else `validation`). Duplicate ranges in one request are dropped. One `clip_render` job per clip. Clipping is free once the source is charged.
- `list`, `get`.
- Worker: `startRender(userId, clipId)` → `{ clip, source, words (clip-relative ms), outputKey }` (marks rendering); `completeRender(userId, clipId, { bytes, durationMs, width?, height?, mimeType?, sha256? })` → creates the output media (`origin clip`, parent = source) and **a draft** (`created_via worker`, `source_clip_id`) with a variant for each active connected video platform of the brand that accepts the clip (title = clip title/hook for platforms with titles). The draft still needs approval. `failRender(userId, clipId, error)`.

### drafts
- `create(userId, DraftInput, {via})` → `DraftView` — every variant validated by core `validateVariant` with media facts (text limits per unit, media counts/kinds/durations/sizes, **X links refused while the allowance is 0**), media must be the user's (not deleted/failed), a pinned `connectedAccountId` must be the brand's account for that platform. `has_link` is computed. Revision 1; `content_hash` by the DB trigger.
- `DraftView = { draft, variants: VariantView[], ready, problems[] }`; each `VariantView` adds `issues` (publish strictness: warnings and errors), `account { id, handle, displayName, status } | null`, `ready`.
- `get`, `list(userId, ListDraftsInput)` → `{ items: { draft, variants }[], nextCursor }`, `preview(userId, draftId)` → `DraftPreview` (per platform: label, text, title, options, media with presigned URLs, account, issues, ready, `length { used, max, unit }`).
- `updateVariant(userId, { draftId, variant })` (add/replace a platform), `editVariant(userId, { draftId, platform, text?, title? })`, `removeVariant(userId, { draftId, platform })`, `updateNotes` (no revision bump). Content edits bump the revision (DB), drop an approval and the DB cancels the old revision's scheduled posts; editing a rejected draft reopens it. Archived drafts are read-only.
- `reject(userId, { draftId, reason? })`, `archive`, `reopen`. `drafts.approve` is `approvals.approve`.

### approvals (nothing publishes without a human)
- `issueNonce(userId, draftId)` → `{ nonce, draftId, revision, expiresAt, approveUrl }` — 256-bit random token, only its SHA-256 is stored, bound to the draft **and its current revision**, expires after **24 h**. Show the nonce only to the human: MCP puts it in the approval card's UI-only `_meta` (never in `content`/`structuredContent` the model sees); the web embeds it in its buttons. `approveUrl` = `${APP_URL}/approve/${nonce}`.
- `verifyNonce(userId, nonce, draftId?)` → `{ valid, reason?: 'invalid'|'used'|'expired'|'wrong_draft'|'stale', draftId, revision, expiresAt }` without using it (for `/approve/[nonce]`).
- `approve(userId, { draftId, nonce }, {via})` — in one transaction: consumes the nonce (unused, unexpired, this user's, this draft), locks the draft, requires `revision == nonce.revision` (else `conflict`, `reason: 'stale'`), entitlements, then **every variant must pass publish validation, have ready media and an active connected account** (else `validation` listing issues; the nonce is not used up). Audited (`draft.approved`). **There is no approval path without a valid nonce.**
- `reject(userId, { draftId, nonce, reason? })`, `decide(userId, { draftId, nonce, decision: 'approve'|'reject', reason? })` (approval_decide / web buttons).
- `editVariant(userId, { draftId, nonce, platform, text?, title? })` (approval_edit_variant) → `{ draft, nonce }`: the card's nonce must be valid for the current revision; the edit bumps the revision, the old nonce is used up and a new one is returned for the card.

### posts
- `schedule(userId, { draftId, at, platforms? }, {via})` → `PostRow[]` — only drafts approved at their current revision (`conflict`, `reason: 'not_approved'`); `at` is ISO with offset or `"now"` (≤ 120 days, not past); one post per (selected) variant through the pinned/live account, which must be active; **caps**: every rolling-24 h window containing `at` per connected account (instagram 50, tiktok 15, youtube 10, x 20, pinterest 20, threads 50, others 25) → `cap_reached` with `suggestedAt`; a `publish_post` job at `run_at = at`. Scheduling an already-scheduled variant moves it (no re-approval, audited `post.rescheduled`); a published variant → `conflict` (one approval → one publication). The user row is locked so concurrent schedules cannot exceed a cap.
- `reschedule(userId, postId, at)`, `cancel(userId, postId)` (scheduled/failed only), `get`, `status(userId, { postId } | { draftId })`, `list`, `calendar(userId, { from, to, brandId?, status? })` (≤ 93 days) → `{ post, text, title }[]`.
- Worker: see "publish cycle" below. Also `findByProviderRequest(requestId, platform?)` (webhook lookup, system) and `enqueueDue(now)` (sweeper, system).
- Exported helpers: `busiestWindowCount`, `exceedsCap`, `nextFreeSlot`.

### voice / imports / analytics
- `voice.save(userId, { brandId, profile, source? })` (new version, `VoiceProfileSchema`), `voice.get(userId, brandId)` → latest `VoiceProfileView | null`, `versions`, `importedSamples(userId, brandId, { limit?, platform? })` (imported posts with text, best engagement first) — `write_post` should load `get` + `importedSamples`.
- `imports.importPastPosts(userId, { brandId, platforms?, limitPerPlatform })` → `{ jobs, platforms }`: one `import_past_posts` job per active account, deduplicated per account per hour. Worker: `imports.savePastPosts(userId, { brandId, platform, posts })` (captions + metrics only; non-https permalinks and bad dates dropped). `imports.summary`.
- `analytics.summary(userId, { brandId?, platform?, days })` → per brand `{ period: PeriodTotals, topPosts, followers[] }` (every active brand when no brandId). `analytics.weeklyReview(userId, brandId)` → last 7 d vs previous 7 d: totals, % change per metric, top 3 / bottom 3 posts, follower change, cadence by weekday/hour (brand time zone), upcoming scheduled + open drafts, voice version, imported count. Score = views·0.01 + likes + 2·comments + 3·shares + 2·saves (`engagementScore`).
- Worker: `analytics.recordPostMetrics(userId, postId, metrics, capturedAt?)`, `analytics.recordAccountMetrics(userId, { brandId, platform, metrics, capturedAt? })`. Cron: `analytics.enqueueDailyAccountPulls(now?)` (system; one job per brand per day).

### renders
- `renders.requestCarousel(userId, RenderCarouselInput)` / `requestVideo(userId, RenderVideoInput)` → `JobView` (`canProcessMedia`; referenced media must be the user's ready images/audio). Poll `jobs.get(userId, jobId)`; the worker completes the job with `{ mediaIds }`.
- Worker: `renders.recordOutputs(userId, { brandId, outputs: [{ storageKey, kind, mimeType, bytes, width?, height?, durationMs? }] })` — keys must be `renderKey(userId, …)`; idempotent per key.

### usage
- `balance(userId, meter = 'clip_seconds')` → `{ meter, limit, used, settled, reserved, remaining, period }`, `balances(userId)`, `history`.
- `reserve(userId, { meter, amount, idempotencyKey, subjectType?, subjectId? })` → `limit_exceeded` with `details.remaining` when too small; `payment_required` when clipping is not allowed (past_due, held). `settle(userId, { reserveKey, amount? })` writes release + settle in the reservation's own period; `release(userId, { reserveKey })`. Idempotent by key (`clipReserveKey(mediaId)` for sources).

### billing
- `applyStripeEvent(event, { fetchSubscription? })` → `{ status: 'processed'|'ignored'|'duplicate'|'unmatched', eventId, type, userId?, billing?, brands? }`. Idempotent via `stripe_events` (record → lock → apply → mark processed in one transaction). Handles `checkout.session.completed` (links customer + subscription by `client_reference_id`/`metadata.userId`), `customer.subscription.created|updated|deleted` (plan from the plan item's `price.lookup_key` or configured price id, add-on quantities, status map `incomplete→none`, `incomplete_expired→canceled`, `paused→unpaid`, period from the **item** (`2025-03-31.basil`) or the subscription, `trial_end`), `invoice.payment_failed` (active/trialing → past_due). After a change, the brand limit is reconciled (downgrade suspends newest brands; upgrade restores). Events of an old subscription never override the current one. Other types → `ignored` (processed).
- **Web route:** verify the signature on the raw body, then `applyStripeEvent(event, { fetchSubscription: (id) => stripe.subscriptions.retrieve(id) })` (order-independent processing). Answer 2xx for processed/ignored/duplicate; answer **non-2xx for `unmatched`** so Stripe retries (it stays unprocessed).
- `checkoutParams(userId, { plan, extraBrands?, extraClipHours? })` → `{ mode, lineItems: [{ lookupKey, price | null, quantity }], clientReferenceId, customer, customerEmail, metadata, subscriptionData: { metadata: { userId } }, successUrl, cancelUrl, allowPromotionCodes, monthlyPriceCents }`. When `price` is null, resolve the lookup key with `stripe.prices.list({ lookup_keys })`. Refuses (`conflict`, `details.portal`) when a subscription exists: plan changes go through the portal. Configure the portal so downgrades apply at period end (product rule) and upgrades immediately.
- `portalParams(userId)` → `{ customer, returnUrl }`, `summary(userId)`.

### jobs
- `JOB_PAYLOAD_SCHEMAS` / `parseJobPayload(type, payload)` — payload per type: `publish_post {userId, postId}`, `check_post_status {userId, postId, poll}`, `source_ingest {userId, mediaId}`, `transcribe {userId, mediaId, language?}`, `clip_render {userId, clipId}`, `carousel_render {userId, brandId, input}`, `video_render {userId, brandId, input}`, `analytics_pull {scope:'post', userId, postId, checkpointMs?} | {scope:'account', userId, brandId}`, `import_past_posts {userId, brandId, accountId, platform, limit}`, `cleanup {task}`.
- `enqueue({ type, payload, runAt?, maxAttempts?, idempotencyKey? })` (validated), `claim({ workerId, types, leaseSec?, limit?, now? })`, `complete(jobId, workerId, result?)`, `fail(jobId, workerId, error, { retryInMs?, permanent? })` (message scrubbed of secrets), `extendLease`, `requeueStale`, `get(userId, jobId)` / `listForUser` → `JobView`.

### maintenance (system-level; verify origin first)
- `cleanup({ now? })` → counts: expired approval nonces / OAuth codes (1 day after expiry) and tokens (30 days), finished jobs older than 14 days, **clip-source files older than 30 days** (file deleted, row `deleted`; post videos are kept), stale leases, lost publish jobs (`posts.enqueueDue`). Run it from the `cleanup` job (cron every ~5–15 min is fine).
- `applyProviderAccountStatus({ profileRef, platform, status })` — Upload-Post `account_status` webhook → the owning brand's account (null when no brand has that profile).

### audit
- `record(userId, { actor, action, subjectType?, subjectId?, meta? })`, `list(userId, filters)`. Actions written by services: `user.trial_started`, `brand.created|updated|archived|restored|suspended`, `account.connect_link|disconnected|status_changed`, `accounts.synced`, `media.upload_started|uploaded|drive_link_registered|ingested|failed|deleted|retention_deleted`, `transcript.saved|failed`, `clips.requested`, `clip.ready|failed`, `draft.created|edited|rejected|archived|reopened|approved`, `approval.nonce_issued`, `post.scheduled|rescheduled|canceled|submitted|published|failed|cap_deferred|retry_scheduled`, `voice.saved`, `imports.requested`, `render.requested`, `billing.subscription_synced|checkout_completed|payment_failed`.

## Worker flows (one service call per step)

| Job | Handler |
| --- | --- |
| `source_ingest` | `m = services.media.getForWorker(u, mediaId)`. Drive link: download `m.sourceUrl` following redirects only through `isAllowedDownloadHop` (≤ `MAX_REDIRECT_HOPS`), stream to `tmpDir`, `storage.putFile(m.storageKey, …)`. Upload: `storage.getToFile(m.storageKey, …)`. ffprobe → `services.media.markIngested(u, mediaId, { durationMs, bytes, width, height, mimeType, sha256 })`. A refusal comes back as `{ error }` (media failed; complete the job). Permanent download/probe failure → `media.markFailed`. |
| `transcribe` | `getForWorker` → extract mono audio capped at the duration → `transcribeWithEngine(transcriber, …)` → `services.transcripts.save(u, mediaId, { engine, result })`. Non-retryable failure (or the last attempt) → `services.transcripts.fail(u, mediaId, err)` (refund). |
| `clip_render` | `services.clips.startRender(u, clipId)` → `{ clip, source, words, outputKey }` → ffmpeg (cut, 9:16 1080×1920, ASS captions from `words` unless `captionStyle === 'none'`) → `storage.putFile(outputKey, …, 'video/mp4')` → `services.clips.completeRender(u, clipId, { bytes, durationMs, width, height })`. Final failure → `clips.failRender`. |
| `publish_post` | `plan = services.posts.preparePublish(u, postId)`. `publish` → `provider.publish(plan.input)` → `posts.recordPublishRequest(u, postId, requestId)`; on throw → `posts.recordPublishError(u, postId, err, { retryable: isRetryableProviderError(err), retryAfterMs: retryAfterSeconds(err) * 1000 })`. `skip` with `reason 'not_due'` → optionally `jobs.fail(job, worker, 'not due', { retryInMs: retryAt − now })`; other skips/deferred/failed → complete the job (services already queued what is needed). |
| `check_post_status` | `post = services.posts.get(u, postId)`; `status = provider.getStatus(post.providerRequestId)` → `services.posts.recordPublishStatus(u, postId, status, { poll })` (queues the next poll with backoff, or fails after 60 polls). `not_found` from the provider → treat as retryable publish error. |
| `analytics_pull` | post scope: `posts.get` + `brands.get` → `provider.getPostMetrics({ requestId, platformPostId, platform, profileRef })` → `analytics.recordPostMetrics`. At the 24 h checkpoint also `getStatus` again for TikTok and `recordPublishStatus` (late URL). account scope: `accounts.list(u, { brandId })` active platforms → `provider.getAccountMetrics` → `analytics.recordAccountMetrics` per platform. |
| `import_past_posts` | `brands.get` → page `provider.listPastPosts({ profileRef, platform, cursor, limit })` until `limit` → `imports.savePastPosts(u, { brandId, platform, posts })` per page. |
| `carousel_render` / `video_render` | `parseJobPayload(type, job.payload)` → render → `storage.putFile(renderKey(u, uuid, ext), …)` → `renders.recordOutputs(u, { brandId, outputs })` → complete the job with `{ mediaIds }`. |
| `cleanup` | `services.maintenance.cleanup()`. |

The loop: `jobs.claim` → handler → `jobs.complete` / `jobs.fail` (backoff; `permanent: true` for validation errors), plus `jobs.requeueStale()` periodically.

## Web flows

- **Sign-in:** `users.ensureUser(id, { email })` (DEV_AUTH on PGlite: `users.devEnsureAuthUser` from `@app/db` first; never on Supabase).
- **Uploads (`/api/uploads`):** `media.createUpload(u, body, { purpose })` → browser PUTs (or multipart parts, keeping each `ETag`) → `media.completeUpload(u, mediaId, { uploadId?, parts? })`. The media page's rights checkbox sets `rightsAttested` and `purpose: 'clip_source'`.
- **Approval queue / `/approve/[nonce]`:** `approvals.verifyNonce(u, nonce)` → `drafts.preview(u, draftId)`; buttons call `approvals.decide(u, { draftId, nonce, decision, reason? }, { via: 'web' })`; quick edits `approvals.editVariant` (returns the next nonce). For the queue list: `drafts.list(u, { status: 'draft' })` and `approvals.issueNonce(u, draftId, { via: 'web' })` per rendered card.
- **Upload-Post webhook:** after `parseUploadPostWebhook`: `upload_completed` → `posts.findByProviderRequest(requestId)` → `posts.recordPublishStatus(post.userId, post.id, status)`; `account_status` → `maintenance.applyProviderAccountStatus({ profileRef, platform, status })` (when `profileRef` is null, resync instead).
- **Cron (`/api/cron/*`):** `jobs.enqueue({ type: 'cleanup', payload: {}, idempotencyKey: 'cleanup:<yyyy-mm-ddThh:mm-bucket>' })` and `analytics.enqueueDailyAccountPulls()`.
- **Stripe:** see billing.

## MCP tool → service

`connect_account` → `accounts.connectLink` (+ `accounts.sync` in `list_accounts`); `list_accounts` → `accounts.list`; `create_draft` → `drafts.create(…, { via: 'mcp' })`; `list_drafts` → `drafts.list`; `approve_draft` → `drafts.preview` + `approvals.issueNonce` (nonce only in UI `_meta`; text fallback = `approveUrl`, which still requires the human to sign in); `approval_decide` → `approvals.decide`; `approval_edit_variant` → `approvals.editVariant`; `schedule_post` → `posts.schedule`; `post_status` → `posts.status`; `get_transcript` → `transcripts.get`; `make_clips` → `clips.requestClips`; `import_past_posts` → `imports.importPastPosts`; `save_voice_profile` → `voice.save`; `render_carousel` / `render_video` → `renders.request*` (+ `jobs.get`); `get_analytics` → `analytics.summary`. Prompts: `write_post` → `voice.get` + `voice.importedSamples` + core `PLATFORM_RULES`; `weekly_review` → `analytics.weeklyReview`; `pick_clips` → `transcripts.get`.

## Decisions (where ARCHITECTURE / the task were silent)

1. **Approval nonce TTL = 24 h** (task), even though `APPROVAL_NONCE_TTL_SEC` defaults to 7 days: `servicesConfigFromAppConfig` uses `min(env, 24 h)`. A failed approval (validation, missing account) does not use the nonce up; a revision change makes it permanently stale.
2. **Clip source = video with `rights_attested_at`** (origin upload or drive link). Uploads set the attestation only with `purpose: 'clip_source'`, so a post video is never metered or transcribed. Clips require the transcript (the source is charged when transcribed; a failed transcription is refunded, so it cannot be clipped).
3. **Metering:** reserve `ceil(durationMs / 1000)` seconds at ingest (`clip_seconds:reserve:<mediaId>`), settle the reserved amount when the transcript is saved, release on failure/deletion. Settling an already released reservation still records the consumption (the work happened). `x_link_posts` is recorded (no limit check) when an X post with a link publishes (never today: links are refused).
4. **Entitlement gates:** reads always work. `canCreate` gates brands, connections, uploads, drafts, edits, approvals, scheduling, imports, voice saves. `canProcessMedia` gates clip sources, ingest reservations, clips and renders (blocked while `past_due`). Publishing re-checks `canPublish` at dispatch: held accounts (canceled / unpaid / trial over) are retried every 6 h instead of publishing; nothing is canceled or deleted.
5. **In-app trial expiry:** `trialing` with a passed `trial_ends_at` and no Stripe subscription counts as `none`. With a Stripe subscription, Stripe's status is trusted.
6. **Brands:** downgrade suspends the newest active brands; any later reconcile with room restores the oldest suspended ones (users never suspend brands themselves). Held accounts are not reconciled (nothing flips while canceled). Archiving cancels the brand's scheduled posts and keeps its provider profile and accounts.
7. **Caps:** the scheduler checks every 24 h window containing `at` (core's `countInBusiestWindow` misses windows starting at `at`; services add that candidate — see Requests). At dispatch the post's own time is excluded and a full cap moves the post +1 h (`post.cap_deferred`).
8. **Publish jobs** are keyed `publish_post:<postId>:<scheduledFor ms>`, so a moved post gets a new job and the stale one skips (`not_due`). The worker double-checks due time (30 s early tolerance).
9. **Retryable provider errors** requeue the post (provider `retryAfter`, else backoff) up to 5 attempts; then it fails with the provider's safe message. Status polls back off from 15 s to 10 min, at most 60 polls.
10. **Storage keys** use a fresh UUID, not the media id (the media repo assigns ids on insert). Drive-link sources are stored as `…/sources/{uuid}.mp4` whatever the container; the real type is recorded at ingest.
11. **Clip drafts** get one variant per active connected platform that accepts the clip (validated with media facts); TikTok/Pinterest still need their required options before approval. Without connected accounts the draft has no variants (the user adds them).
12. **Stripe:** plans map by price `lookup_key` (core `planFromLookupKey`), else by configured price ids. Subscription period from the plan item (basil API). `unmatched` events stay unprocessed for Stripe's retry.
13. **Analytics score** heuristic (see analytics). Weekly review's "bottom" is empty with 3 or fewer posts.
14. **Imports** are deduplicated per account per hour (job idempotency key).

## Tests

`pnpm -F @app/services test` — 9 files, 95 tests on PGlite with `FakePostingProvider`, `MemoryStorage` and a manual clock; no network. Typecheck clean for `@app/services`, `@app/worker` and `@app/web`; boundary check passes.

Covered: trial start/expiry, entitlements per status; brand limit (incl. concurrent creates), archive/restore, downgrade suspend / upgrade restore; uploads (presigned PUT through the dev-storage handler, size/type mismatch, storage allowance, multipart plan, rights attestation); drive-link allowlist and refusal of YouTube/youtu.be/m.youtube/vimeo/other hosts/http; ingest metering (reserve, limit_exceeded with remaining, 4 h limit, settle once, release/refund, period from the users row vs calendar month, past_due/canceled); transcript ranges and search; clip validation (end of video, 180 s, 3 s, ≤ 20, ≤ 60 active, needs transcript, brand choice, past_due) and render → draft that still needs approval; draft validation (X links, X length, YouTube title, mixed media, Instagram video length), pagination, revision bumps, preview, reject/archive/reopen; **approval invariants** (no nonce, garbage nonce, reused nonce, expired, other user's nonce, wrong draft, stale after edit, publish validation, active account, needs_reauth, nonce edit → new nonce, decide reject); **edit after approval → scheduled post canceled and schedule refused until re-approved**; scheduling (per variant, platforms filter, past/far times, move vs re-publish), caps (burst before and after `at`, suggestion, other accounts unaffected), reschedule/cancel/status/calendar; publish cycle (stale job skip, claim once, request, pending poll, published → analytics jobs, failure, poll budget, retryable requeue, held deferral, cap deferral at dispatch, disconnected account); Stripe (created/updated/deleted, idempotency, downgrade/upgrade brands, stale subscription ignored, payment_failed, checkout + fetcher, price-id config, unmatched/ignored/invalid), checkout/portal params; jobs (payload validation, claim/fail/complete, secret scrubbing, cross-tenant); voice versions; imports (dedupe, page save sanitising); analytics summary + weekly review; renders; maintenance cleanup + provider status; wiring from env (PGlite, Upload-Post selection without network, invalid config, production refusal). **Cross-tenant ids are refused with `not_found` in every module.**

## Gaps

- `apps/worker/src/context.ts` and `apps/web/lib/services.ts` have no tests of their own (their test folders belong to the worker/web owners); `createServicesFromEnv`, which they wrap, is tested.
- Cross-session locking (two Postgres connections) is not exercised: PGlite has one session. The brand limit, caps and nonce consumption rely on row locks that the db package tested on real Postgres.
- A transcribe job that dies without the worker calling `transcripts.fail` leaves its reservation outstanding until the period ends (no "dead jobs" query in the repos; see Requests).
- Stripe events are applied from the payload unless the route passes `fetchSubscription`; pass it.

## Requests

1. **Root (lockfile):** `packages/services/package.json` now depends on `@app/posting`, `@app/storage`, `@app/transcription` (workspace) and `zod ^4.6.7` (same version already locked). Please run `pnpm install --offline --lockfile-only` (or `pnpm install`) so `pnpm-lock.yaml` records them; a frozen-lockfile install fails until then. `node_modules` links were created by hand.
2. **Core (`platforms.ts`):** `countInBusiestWindow(times, at)` only tries window starts at `at − 24h + 1` and at existing posts ≤ `at`, so it misses the window that starts at `at` (posts after it). Add `t` to the candidate starts (see `busiestWindowCount` in `packages/services/src/posts.ts`); `wouldExceedCap` then becomes correct and services can switch back.
3. **Core (`validation.ts`):** `MAX_CLIP_RANGES` is 30; the product limit is 20 per request (services enforce 20 via `maxClipsPerRequest`). Consider lowering the constant so the MCP schema advertises 20.
4. **Core (`config.ts`):** add optional `STRIPE_PRICE_STARTER|PLUS|PRO|EXTRA_BRAND|EXTRA_CLIP_HOUR` and `UPLOAD_POST_PROFILE_PREFIX` (services read them from the raw env today) and document them in `.env.example`.
5. **DB (repos):** `brands.findByProviderProfileRef(db, ref)` (system lookup for the Upload-Post webhook; services use one raw `select` until then); optional `id` in `media.create` (so keys can use the media id); `jobs.listDead(type, since)` (to refund reservations of dead transcribe jobs).
6. **Worker owner:** extend `WorkerContext` in `src/types.ts` with the fields of `WorkerServicesContext` (or type handlers with `FullWorkerContext` from `src/context.ts`).
7. **Web owner:** mount the Stripe, Upload-Post and cron routes as described above; answer non-2xx for `unmatched` Stripe events.
