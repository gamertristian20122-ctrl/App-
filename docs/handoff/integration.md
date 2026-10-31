# Integration: MCP + worker + web on the tested foundation

Owner: integrator. Scope: every package. Inputs: `mcp.md`, `worker-posting.md`, `worker-media.md`,
`web-backend.md`, `web-frontend.md` (this wave) and the earlier handoffs (already settled in
`foundation-verify.md`). Where this file disagrees with an older handoff, this file is newer.

## Checks (final)

| Command | Result |
| --- | --- |
| `pnpm install --frozen-lockfile` | up to date (no dependency added or changed) |
| `pnpm typecheck` | clean in all 9 projects |
| `pnpm lint` (boundaries) | passes |
| `pnpm -F @app/web build` | passes, **no warnings** (the Turbopack whole-project trace warning is gone) |
| `pnpm test` | core 268, db 177 (+11 real-Postgres skipped), posting 175, storage 88, transcription 59, services 123, mcp 42, worker 125, web 158 |

All five suites the agents reported were already green when integration started; nothing was
failing. The work below closes the cross-package gaps the agents could not close inside their own
paths, and adds tests that run the real chain end to end.

## Fixed

1. **Service errors misread across bundles (500 instead of 404/409)** — `packages/core/src/errors.ts`.
   `AppError` instances now carry a registry-wide brand (`Symbol.for('app.core.AppError')`);
   `isAppError` checks it and `AppError[Symbol.hasInstance]` uses it, so `isAppError(e)` and
   `e instanceof AppError` work when the services instance was built by another Next.js bundle. This
   fixes web-backend's `approve.ts`, `http.ts` (`errorResponse`, `isAppErrorCode`), the Stripe
   checkout route and every other `isAppError` caller at once. Look-alikes without the brand are
   still rejected. Test: `core/test/errors.test.ts` (a second module copy via `vi.resetModules`).
2. **Render drafts created twice** — the worker now creates the draft for `carousel_render` /
   `video_render`, but the MCP tools and server instructions told the AI to `create_draft` with the
   media ids. `render_carousel`, `render_video`, the instructions and `post_status` (jobId) now point
   at the job result's `draftId` (and only fall back to `create_draft` when it is null). Test:
   `mcp/test/tools.test.ts`.
3. **Carousels Instagram and TikTok would refuse** — carousels rendered PNG; Instagram takes JPEG
   only and TikTok photo posts JPEG/WebP (`docs/research/platform-limits.md`). Carousel slides are
   now JPEG (q92, `renderer.ts` `format: 'jpeg'`, `files.ts` `jpegDimensions`/`jpegSize`, key
   `.jpg`, `image/jpeg`); video frames stay PNG. Core `ImageRule.formats` adds a **warning** (never
   blocking) `image_format` for user images in other formats on Instagram/TikTok. Tests: real
   Chromium in `worker/src/media/__tests__/renders.test.ts`, `core/test/platforms.test.ts`.
4. **Posts stuck in `publishing` forever** (worker-posting request 3) — a worker crash on a publish
   job's last attempt (or a status chain that died) left nothing to settle the post.
   `services.posts.recoverStuckPublishing` (run by `maintenance.cleanup`, reported as
   `stuckPublishing`) finds `publishing` posts with no live publish/status job: without a request id
   it queues **one** resume `publish_post` per attempt (the worker republishes with the same
   idempotency key, so nothing posts twice); with a request id one final status check; if that job
   died too, the post fails with a clear message. DB: `maintenance.listStuckPublishingPosts`.
   Tests: `services/test/posts.test.ts`, worker runner test "a publish job that died mid-flight…".
5. **`posts.resumePublish`** (worker-posting request 3) — the approval/brand/account/media
   re-checks for an interrupted publish moved from the worker (`rebuildInput`) into services, so the
   rule lives once; the worker's resume path calls it.
6. **Late TikTok post id / URL dropped** (worker-posting request 4) — `posts.recordPublishStatus`
   on an already `published` post now fills a missing `providerPostId` / `postUrl` (never
   overwrites, keeps `published_at`, does not re-run metering or analytics). The worker's 24 h
   TikTok re-check and the Upload-Post webhook both benefit. Test: `services/test/posts.test.ts`.
7. **`jobs.release` / `extendLease(now)`** (worker-posting requests 1–2) — `@app/db`
   `jobs.release`, `services.jobs.release(jobId, workerId, now?)`, `services.jobs.extendLease(…, now?)`.
   `apps/worker/src/queue.ts` no longer runs SQL or repos directly.
8. **Clip-source promotion through services** (worker-media request 1) — `services.media.promoteSource`
   (only a pending uploaded clip source, only to its own `sourceKey`) + `@app/db`
   `media.moveStorageKey`; the worker's raw-SQL stand-in (`movePendingMediaKey`) is gone.
9. **`ObjectStorage.copy`** (worker-media request 3) — optional port method, implemented for R2
   (CopyObject ≤ 5 GB, UploadPartCopy in 1 GiB parts above) and the local drivers; in the shared
   storage contract + an R2 6 GB multipart-copy test. **Not used by ingest on purpose:** copying
   from the still-writable `uploads/` key would reopen the swap race the worker's re-upload of the
   probed and hashed local file closes. Use it where the source key is immutable.
10. **Cursor could not connect** (web-backend decision 1 / web-frontend request 5) — Cursor is a
    named target client (CLAUDE.md) and the Connect page documents it. `/oauth/register` now accepts
    the private-use schemes of supported desktop clients (`APP_REDIRECT_SCHEMES`: `cursor:`,
    `vscode:`, `vscode-insiders:`; RFC 8252, PKCE-bound); every other app scheme is still refused.
    The consent screen shows the "runs on your own computer" warning for these too. Tests:
    `web/test/api/oauth.test.ts`, `server-helpers.test.ts`.
11. **Accounts page did not refresh after connecting from the AI** — `connect_account` returned to
    `/app/accounts` without `brand`/`connected`, so the page never synced. The MCP return URL now
    matches the web button's (`?brand=<id>&connected=<platform>`). Test: `mcp/test/tools.test.ts`.
12. **Vercel bundle traced the whole repo** (web-backend request 4) — `findMigrationsDir`'s cwd
    walk has a `turbopackIgnore` comment; production never runs migrations at runtime (postgres URL
    path), so nothing needs the SQL files in the function bundle.

## End-to-end wiring (read and, where marked, tested through the real stack)

| Chain | Status |
| --- | --- |
| OAuth (DCR → consent → code + PKCE → token) → `/api/mcp` bearer check → real `@app/mcp` → services | **tested** (`web/test/api/mcp-e2e.test.ts`, no mocks): initialize, tools/list (14 v1 tools, titles + hints), list_accounts, create_draft (limit error "20 over the limit of 280"), schedule refused before approval, approve_draft (nonce only in `_meta`), guessed nonce refused, card nonce approves once, schedule_post → 2 posts + 2 publish jobs, post_status |
| `schedule_post` → `publish_post` job → worker → `PostingProvider` → `check_post_status` → published → analytics jobs | tested in worker (`publish.test.ts`, runner drain on PGlite + fake provider) |
| Crash mid-publish → cleanup job → resume with the same key → published once | **tested** (new worker test) |
| Upload (`/api/uploads` → PUT → complete) → `source_ingest` → `transcribe` → `make_clips` → `clip_render` → draft | tested per side (web uploads test; worker media runner drain with real ffmpeg) |
| `render_carousel` / `render_video` → job → worker render → draft → `post_status` points at `draftId` | tested per side (worker real Chromium; MCP text) |
| Web approval (`/app/approvals` card nonce, `/approve/[nonce]` link nonce) → `approvals.decide(via 'web')` | tested (web ui + api); link nonces refused over MCP (services + mcp tests) |
| Stripe Checkout (`client_reference_id` + `subscription_data.metadata.userId`) → webhook → `billing.applyStripeEvent` (re-fetches the subscription) → entitlements | tested (web stripe test, real signatures, fake API) |
| Upload-Post webhook → `posts.recordPublishStatus` / `maintenance.applyProviderAccountStatus` | tested (web webhooks test) |
| Job payloads | one schema set (`services` `JOB_PAYLOAD_SCHEMAS` via `parseJobPayload`) on both sides; every `JOB_TYPES` entry has a handler in its `JOB_GROUP` |

## Handoff requests: resolved / deferred

### mcp.md
1. `/api/mcp` route (token check, 401 + PRM, rate limit, CORS) — **resolved** (web-backend).
2. `/app/approvals?draft=<id>` opens the draft — **resolved** (web-frontend).
3. Workspace devDependencies instead of test aliases — **deferred** (no new deps; aliases work).
4. `media.listSources` — **deferred** (optional; `media.list` + `isClipSource` works).

### worker-posting.md
1. `jobs.release` — **resolved** (#7). 2. `extendLease(now)` — **resolved** (#7).
3. `posts.resumePublish` + stuck-publishing sweep — **resolved** (#4, #5).
4. Late post id/url on published posts — **resolved** (#6).
5. Time-based / env status-poll budget — **deferred**: the worker's `WORKER_SERVICES_OVERRIDES`
   (150 polls ≈ 24 h) is the only caller that passes `poll`, so behaviour is already right.
6. `cleanup` payload `task` ignored — **deferred** (every task always runs; cheap and idempotent).

### worker-media.md
1. `media.promoteSource` — **resolved** (#8). 2. Render drafts in services — **deferred**: the
   worker's `createRenderDraft` uses only public services (`drafts.list/create(via 'worker')`,
   `accounts.list`) and core `validateVariant`, so every rule still applies; move it when renders
   grow. 3. `ObjectStorage.copy` — **resolved** (#9, intentionally unused by ingest).
4. Fonts `rounded`/`condensed` — **deferred** (fall back to Noto Sans; add `fonts-noto-extra` when
   the Docker build can be verified). 5. Instagram JPEG / Bluesky size — **resolved** for
   carousels (#3); Bluesky's 1 MB is already enforced by `PLATFORM_RULES.bluesky.image.maxBytes`.
6. Captionless clips of silent videos — **deferred** (product decision). 7. zod in worker —
   **deferred** (no new deps; payloads already go through services' zod schemas).

### web-backend.md
1. zod in `apps/web` — **deferred** (no new deps; hand-written guards cover the few fields, services
   validate the rest with zod). 2. `MCP_ALLOWED_ORIGINS` — **deferred** (optional; only browser
   MCP clients need it). 3. Account-status lookup without profile / `wwwAuthenticate` path —
   **deferred** (optional; `accounts.sync` covers it). 4. Turbopack trace — **resolved** (#12).
5. `middleware.ts` → `proxy.ts` — **deferred** (works; `proxy` would move it off Edge).
6. Ops — **open, ops** (below). Decision 1 (Cursor) — **resolved** (#10).

### web-frontend.md
1. Core `isAppError` across bundles — **resolved** (#1). 2. Same bug in `approve.ts` / `http.ts` —
   **resolved** by #1 (no web change needed). 3. zod — **deferred** (as above). 4. R2 CORS — **open,
   ops** (below). 5. Cursor — **resolved** (#10). 6. `drafts.counts`, nonce reuse per queue view,
   `media.listSources` — **deferred** (optional; queue writes ≤ 10 nonce pairs per view, pruned
   daily by cleanup).

## Ops checklist before the first real-client test (not code)

- Vercel: `APP_URL`, `MCP_RESOURCE_URL` (default `APP_URL/api/mcp`), `DATABASE_URL`, `SESSION_SECRET`,
  Supabase keys, Stripe keys + `STRIPE_WEBHOOK_SECRET`, `UPLOAD_POST_*`, R2 keys, `CRON_SECRET`.
  Apply migrations with `pnpm -F @app/db migrate` against Supabase.
- Supabase Auth redirect allow-list: `${APP_URL}/auth/callback`.
- Stripe webhook: `${APP_URL}/api/stripe/webhook` with `checkout.session.completed`,
  `customer.subscription.created|updated|deleted`, `invoice.payment_failed`.
- Upload-Post webhook: `${APP_URL}/api/webhooks/upload-post` (events in `posting.md` request 5).
- R2 bucket CORS: allow `PUT` from `APP_URL` with `Content-Type`, expose `ETag`.
- Railway: two services from `apps/worker/railway.toml` (`WORKER_TYPES=posting` / `media`); set
  draining seconds in the service settings if `drainingSeconds` is not honoured.

## Remaining gaps

- Nothing has run against live Supabase, Stripe, Upload-Post, R2, Whisper/AssemblyAI, or a real
  Claude / ChatGPT / Cursor client; the Docker image has not been built (no daemon here). The
  approval card has only been exercised in `node:vm`.
- Whether Upload-Post converts PNG/WebP for Instagram/TikTok is unverified (we warn; carousels are JPEG).
- Rate limits and webhook de-duplication are per instance (no shared store).
