# Architecture (v1, lean)

This is the build contract for v1. It replaces the long plan in `docs/plans/01-database-schema.md` (kept for reference; its research and decisions still apply). Research notes with sources live in `docs/research/`.

Principles: one tenant = one user (no teams in v1). Business logic lives once, in `@app/services`; the MCP server, the web app and the workers are thin shells around it. Every external system sits behind a port (interface) with a fake for tests and local dev.

## Repo layout

```
package.json, pnpm-workspace.yaml, tsconfig.base.json, vitest.workspace.ts
supabase/migrations/        SQL migrations (source of truth for the schema)
packages/core/              pure TS: types, ports (interfaces), plans, platform rules, validation (zod), crypto, redacting logger, content hash, errors
packages/db/                Db interface, postgres.js + PGlite drivers, migrator, test harness, repositories
packages/services/          business operations (drafts, approvals, scheduling, brands, accounts, media, clips, voice, analytics, billing, usage)
packages/posting/           PostingProvider implementations: upload-post/ (the ONLY code that may call Upload-Post) and fake/
packages/storage/           ObjectStorage implementations: r2 (S3 API) and memory/fs fake
packages/transcription/     Transcriber implementations: whisper (self-hosted, OpenAI-compatible HTTP), assemblyai (fallback), fake, and a fallback chain
packages/mcp/               MCP server: tools, prompts, approval-card UI resource; transport-agnostic createMcpServer(ctx)
apps/web/                   Next.js (App Router) on Vercel: marketing + dashboard UI, /api/mcp, OAuth 2.1 AS, Stripe, uploads, approvals
apps/worker/                Railway worker: job runner + handlers (publish, status, ingest, transcribe, clip render, carousel render, video render, analytics, import)
```

Packages export TypeScript source (`"exports": {".": "./src/index.ts"}`); Next uses `transpilePackages`; the worker runs with `tsx`. Package names: `@app/core`, `@app/db`, `@app/services`, `@app/posting`, `@app/storage`, `@app/transcription`, `@app/mcp`, `@app/web`, `@app/worker`.

## Conventions

- TypeScript strict, `noUncheckedIndexedAccess`. ESM everywhere. zod v4 for every external input.
- Tests: Vitest. DB tests run on PGlite (in-process Postgres) using the real migrations. External HTTP is never hit in tests: every adapter takes an injected `fetch`, tests pass a mock.
- IDs: `uuid` (`gen_random_uuid()`). Times: `timestamptz`, ISO strings at the edges. Money: integer cents.
- Never log secrets: use `createLogger()` from `@app/core`, which redacts keys matching /token|secret|password|authorization|api[-_]?key|cookie|code_verifier/i at any depth and Bearer strings.
- Tenancy: every repository and service function takes `userId` and scopes every query by it. RLS is enabled on every table as defense in depth (owner-only policies for the `authenticated` role; server code connects with a privileged role).
- Errors: services throw `AppError(code, message, details?)` with codes like `not_found`, `forbidden`, `validation`, `limit_exceeded`, `conflict`, `cap_reached`, `payment_required`. MCP tools and routes map them to tool errors / HTTP statuses.

## Data model (supabase/migrations)

Enums: `plan_tier` (starter, plus, pro), `subscription_status` (none, trialing, active, past_due, canceled, unpaid), `platform` (tiktok, youtube, instagram, facebook, threads, x, linkedin, pinterest, bluesky), `brand_status` (active, suspended, archived), `account_status` (pending, active, disconnected, needs_reauth), `media_kind` (video, image, audio, captions), `media_origin` (upload, drive_link, clip, render), `media_status` (pending, ready, failed, deleted), `clip_status` (queued, rendering, ready, failed), `draft_status` (draft, approved, rejected, archived), `post_status` (scheduled, publishing, published, failed, canceled), `job_status` (queued, running, succeeded, failed, dead), `usage_meter` (clip_seconds, x_link_posts), `usage_kind` (reserve, settle, release, adjust), `actor` (web, mcp, worker, system).

Tables (all have `created_at`; mutable ones have `updated_at` maintained by trigger):

1. `users` — id (= auth.users.id), email, display_name, timezone, plan `plan_tier` null, subscription_status, trial_ends_at, current_period_start, current_period_end, extra_brands int ≥0, extra_clip_hours int ≥0, stripe_customer_id unique, stripe_subscription_id unique.
2. `brands` — id, user_id, name, timezone, status, provider_profile_ref (Upload-Post profile username, unique when not null), archived_at. Partial index on (user_id) where status='active'.
3. `connected_accounts` — id, user_id, brand_id, platform, provider ('upload_post'|'fake'|future), external_account_id, handle, display_name, status, encrypted_credentials bytea null (only for future direct adapters; AES-256-GCM), scopes text[], connected_at, last_synced_at. Unique (brand_id, platform) where status in ('pending','active','needs_reauth') — one account per platform per brand (Upload-Post constraint).
4. `media_assets` — id, user_id, brand_id null, kind, origin, status, storage_key unique, mime_type, bytes bigint, duration_ms, width, height, sha256, source_host (for drive links: host only; full URL kept in `source_url` until fetched, then nulled), rights_attested_at (required for clip sources), parent_media_id (clip/render lineage).
5. `transcripts` — id, user_id, media_id unique, engine ('whisper'|'assemblyai'|'fake'), language, duration_ms, text, words jsonb ([{s,e,t}] ms), segments jsonb.
6. `clips` — id, user_id, brand_id, source_media_id, start_ms, end_ms (CHECK end>start, length ≤ 180000), title, hook, caption_style text, status, output_media_id null, draft_id null, error. 
7. `drafts` — id, user_id, brand_id, status, revision int (starts 1), content_hash text, created_via `actor`, source_clip_id null, approved_revision int null, approved_hash text null, approved_at, approved_via `actor`, rejected_reason, notes.
8. `draft_variants` — id, user_id, draft_id, platform, connected_account_id null, text, title, media_ids uuid[], options jsonb, has_link bool. Unique (draft_id, platform). Any insert/update/delete of a variant, or update of draft content, bumps `drafts.revision`, recomputes `content_hash`, and resets status from approved → draft (trigger). 
9. `posts` — id, user_id, brand_id, draft_id, variant_id, connected_account_id, platform, scheduled_for, status, approved_revision int, provider, provider_request_id, provider_post_id, post_url, error, attempts int, published_at, canceled_at. Trigger: INSERT requires the draft to be `approved` with `approved_revision = revision` (= the post's approved_revision); otherwise raises. Unique active post per variant (partial unique index where status in ('scheduled','publishing','published')).
10. `voice_profiles` — id, user_id, brand_id, version int, profile jsonb (validated by zod in core: tone, audience, vocabulary, do, dont, emoji_policy, hashtag_policy, sample_posts[]), source ('manual'|'imported'|'mixed'). Unique (brand_id, version). Latest version is active.
11. `past_posts` — id, user_id, brand_id, platform, external_post_id, text, media_type, posted_at, permalink, metrics jsonb. Unique (brand_id, platform, external_post_id).
12. `analytics_snapshots` — id, user_id, brand_id, platform, post_id null, past_post_id null, connected_account_id null, scope ('post'|'account'), captured_at, metrics jsonb (views, likes, comments, shares, saves, followers, reach, impressions — numbers only).
13. `usage_ledger` — id, user_id, meter, kind, amount int (positive; reserve/settle consume, release returns), period_start timestamptz, subject_type, subject_id, idempotency_key unique, note. Balance = limit − (settled + outstanding reserves) for the current period.
14. `jobs` — id, user_id null, type text, payload jsonb, status, run_at, attempts, max_attempts (default 5), locked_by, locked_until, last_error, idempotency_key unique null, result jsonb, finished_at. Index (status, run_at). Claim with `FOR UPDATE SKIP LOCKED`.
15. `oauth_clients` — client_id text PK, client_name, redirect_uris text[], token_endpoint_auth_method ('none'), created_at, last_used_at.
16. `oauth_codes` — code_hash PK, client_id, user_id, redirect_uri, code_challenge, scope, resource, expires_at, used_at.
17. `oauth_tokens` — id, token_hash unique, kind ('access'|'refresh'), family_id, client_id, user_id, scope, resource, expires_at, revoked_at, last_used_at. Tokens are random 32-byte strings; only SHA-256 hashes are stored. Refresh tokens rotate; reuse of a rotated refresh token revokes the family.
18. `approval_nonces` — nonce_hash PK, user_id, draft_id, revision, expires_at, used_at. One-time nonce embedded (UI-only `_meta`) in the approval card and in web approve links.
19. `stripe_events` — id text PK (Stripe event id), type, processed_at.
20. `audit_log` — id, user_id, actor, action, subject_type, subject_id, meta jsonb (never secrets).

## Plans and metering (`packages/core/src/plans.ts` — single source of truth)

| Plan | Price | Brands | Clip hours/mo | X link posts/mo | Storage |
| --- | --- | --- | --- | --- | --- |
| starter | $8 | 1 | 4 | 0 | 50 GB |
| plus | $15 | 2 | 10 | 0 | 100 GB |
| pro | $25 | 4 | 20 | 0 | 200 GB |

Add-ons: extra brand $3/mo, extra clip hour $1/mo (recurring Stripe quantities). Limits = plan + add-ons. Trial: 7 days of Starter with 1 clip hour.

- Clipping hours = seconds of source video, reserved when a source is ingested (duration known), settled when its transcript is saved, released if ingest/transcription fails. Charged once per source video; making more clips from the same source is free. No rollover.
- X link posts: metered per published X post containing a URL (`x_link_posts`). Upload-Post strips links on X unless a paid add-on is bought (~$0.38/post), so the default allowance is 0: validation rejects an X variant containing a link with a clear message. Changing the constant enables it.
- Brand limit: creating/unarchiving a brand locks the user row and counts active brands.
- Periods: Stripe `current_period_start/end`; without a subscription (trial) the period is the calendar month in UTC.

## Platform rules (`packages/core/src/platforms.ts`)

Text limits, media rules and caps per platform from `docs/research/platform-limits.md` and `upload-post.md`. Caps (rolling 24h, per connected account, counted over posts in publishing/published plus scheduled in the window): instagram 50 (Upload-Post caps below the platform's 100; we enforce the lower), tiktok 15, threads 250, youtube 10 (quota-driven, conservative), x 20, others 25. `schedule_post` rejects a time that would exceed the cap; the worker re-checks at dispatch and reschedules +1h when full.

## Ports (`packages/core/src/ports.ts`)

```ts
interface PostingProvider {
  readonly name: 'upload_post' | 'fake'
  ensureProfile(i: { brandId: string; profileRef?: string | null; displayName: string }): Promise<{ profileRef: string }>
  createConnectLink(i: { profileRef: string; platforms: Platform[]; redirectUrl?: string }): Promise<{ url: string; expiresAt: string }>
  listAccounts(profileRef: string): Promise<ProviderAccount[]>        // { platform, externalId, handle, displayName, status }
  disconnect(i: { profileRef: string; platform: Platform }): Promise<void>
  deleteProfile(profileRef: string): Promise<void>
  publish(i: PublishInput): Promise<{ requestId: string }>           // { profileRef, platform, kind: 'text'|'video'|'photos', text, title?, mediaUrls, options, idempotencyKey }
  getStatus(requestId: string): Promise<PublishStatus>               // { state: 'pending'|'published'|'failed', postId?, url?, error? }
  getPostMetrics(i: { requestId?: string; platformPostId?: string; platform: Platform; profileRef: string }): Promise<Metrics>
  getAccountMetrics(i: { profileRef: string; platforms: Platform[] }): Promise<Array<{ platform: Platform; metrics: Metrics }>>
  listPastPosts(i: { profileRef: string; platform: Platform; cursor?: string; limit?: number }): Promise<{ posts: PastPostInput[]; nextCursor?: string }>
}
interface ObjectStorage { presignPut(key, contentType, maxBytes): Promise<{ url; headers }>; presignGet(key, ttlSec): Promise<string>; putFile(key, path, contentType): Promise<void>; putBytes(key, bytes, contentType): Promise<void>; getToFile(key, path): Promise<void>; head(key): Promise<{ bytes: number; contentType: string } | null>; delete(key): Promise<void> }
interface Transcriber { readonly name: string; transcribe(i: { filePath: string; language?: string }): Promise<TranscriptResult> } // { language, durationMs, text, words: {s,e,t}[], segments: {s,e,t}[] }
interface Clock { now(): Date }
```

## Services (`packages/services`) — the only place business rules live

`createServices({ db, provider, storage, clock, config })` returns modules; every function takes `userId` first:
users (ensureUser, getEntitlements), brands (create, list, update, archive), accounts (connectLink, sync, list, disconnect), media (createUpload → presigned PUT, completeUpload, registerDriveLink [allowlisted hosts: drive.google.com, docs.google.com, dropbox.com, dl.dropboxusercontent.com, onedrive.live.com, 1drv.ms; anything YouTube-like is refused], get), transcripts (get, segment search), clips (requestClips → validates ranges against transcript/duration, creates clips + jobs), drafts (create, list, get, updateVariant, approve(nonce), reject, archive, preview), approvals (issueNonce, verifyNonce), posts (schedule, cancel, status, list, calendar), voice (save, get, importedSamples), imports (importPastPosts → job), analytics (summary for get_analytics and weekly_review), usage (reserve, settle, release, balance), billing (applyStripeEvent, checkoutParams), jobs (enqueue, claim, complete, fail with backoff).

## MCP (`packages/mcp`)

Streamable HTTP, stateless, mounted at `/api/mcp` in the web app. Auth: OAuth 2.1 bearer tokens issued by our own AS in the web app (DCR + PKCE S256, resource indicators; Protected Resource Metadata at `/.well-known/oauth-protected-resource`, AS metadata at `/.well-known/oauth-authorization-server`; 401 with `WWW-Authenticate: Bearer resource_metadata=...`). Scope: `social` (single scope).

Tools (every tool has `title` and `readOnlyHint` or `destructiveHint`, plus `idempotentHint`/`openWorldHint` where true): `connect_account`, `list_accounts`, `create_draft`, `list_drafts`, `approve_draft` (read-only: renders the approval card; returns a web approval link for clients without MCP Apps), `schedule_post`, `post_status`, `get_transcript`, `make_clips`, `import_past_posts`, `save_voice_profile`, `render_carousel`, `render_video`, `get_analytics`. App-only tools (`_meta.ui.visibility: ["app"]`), called by the card's buttons with the one-time nonce from the card's UI-only `_meta`: `approval_decide` (approve | reject), `approval_edit_variant`. The AI can never approve by itself.

Prompts: `write_post` (loads the brand's voice profile + platform rules), `pick_clips` (rules for standalone moments with a hook), `weekly_review` (loads last 7 days of analytics vs previous 7).

MCP App: `ui://approval-card/v1` (`text/html;profile=mcp-app`), self-contained HTML/JS, per-platform preview, Approve / Edit / Reject. Also sets `openai/outputTemplate` for ChatGPT compatibility.

## Web app (`apps/web`)

Supabase Auth (magic link) for humans; `DEV_AUTH=1` enables a local email-only login for development and tests. Pages: `/` (landing + pricing), `/login`, `/app` (overview + usage), `/app/approvals` (queue with per-platform preview; approve/edit/reject), `/app/calendar`, `/app/brands`, `/app/accounts`, `/app/media` (uploads, rights checkbox), `/app/clips`, `/app/voice`, `/app/analytics`, `/app/billing`, `/app/connect` (how to add the MCP server to Claude/ChatGPT/Cursor), `/oauth/authorize` (consent), `/approve/[nonce]` (one-click web approval). API: `/api/mcp`, `/oauth/register|token|revoke`, `/.well-known/*`, `/api/stripe/webhook`, `/api/stripe/checkout`, `/api/stripe/portal`, `/api/uploads` (presign + complete), `/api/webhooks/upload-post`, `/api/cron/*` (Vercel cron → enqueue analytics jobs). Every route has a test.

## Worker (`apps/worker`)

One process, `WORKER_TYPES` env selects handlers (Railway runs `posting` and `media` services from the same image). Loop: claim → run handler → complete/fail (exponential backoff, dead after max_attempts). Handlers: `publish_post`, `check_post_status`, `source_ingest`, `transcribe`, `clip_render` (ffmpeg: cut, 9:16 crop/scale to 1080×1920, burned-in captions from transcript words via ASS), `carousel_render` (Playwright renders HTML slides → 1080×1350 PNGs), `video_render` (template video: slides + captions → MP4 via ffmpeg), `analytics_pull`, `import_past_posts`, `cleanup` (expired nonces/codes, old sources). Dockerfile installs ffmpeg + Chromium.

## Product decisions (defaults; change in `plans.ts` / config)

X links off by default (above). Instagram cap 50/24h. Clip hours charged once per source, no rollover, auto-refund on failure. Upgrades immediate; downgrades at period end; downgrade below brand count suspends newest brands (nothing deleted). `past_due` keeps approved posts publishing but blocks new clipping/rendering; `canceled`/`unpaid` holds everything. 7-day Starter trial. One account per platform per brand. Rescheduling an approved post needs no re-approval (audited). One approval → one publication per variant. Source videos ≤ 4 h and ≤ 10 GB; source files deleted from R2 30 days after upload. Analytics: account totals daily; post metrics at 24h, 48h, 7d, 30d.
