# Worker handoff: runner + posting handlers (`apps/worker`)

Owner: worker-posting agent. Covers `apps/worker/**` except `apps/worker/src/media/**` (media agent).
Requests for other owners are at the end.

## What exists

| Path | What |
| --- | --- |
| `src/main.ts` | Process entrypoint (`pnpm -F @app/worker start`, Docker `CMD`): `startWorker(process.env)`, SIGTERM/SIGINT → graceful stop, hard exit before Railway's SIGKILL |
| `src/worker.ts` | `startWorker(env, options)` → `{ context, registry, runner, scheduler, health, stop() }`; `shutdownGraceMs(env)` (from `RAILWAY_DEPLOYMENT_DRAINING_SECONDS`, default 25 s) |
| `src/context.ts` | `createWorkerContext(env)` → `FullWorkerContext` (services built with `WORKER_SERVICES_OVERRIDES`: status-poll budget 150 ≈ 24 h); logger name `worker` |
| `src/types.ts` | `WorkerContext` (now complete: `services, provider, storage, transcriber, config, db, tmpDir, logger/log, clock, workerId, signal?`), `Handler` |
| `src/runner.ts` | `Runner`: claim (enabled types only) → handler → complete/fail; concurrency; lease renewal; stale-lease sweep; graceful shutdown; `drain()` for tests; `status()` for health |
| `src/queue.ts` | `JobQueue` port + `createServicesQueue({ services, db, clock })` (services.jobs + two small adapters, see Requests 1–2) |
| `src/errors.ts` | `PermanentJobError` (→ dead now), `RetryJobError(msg, retryInMs)`, `JobAbortedError`, `throwIfAborted(signal)`, `classifyFailure`, `retryDelayMs` (exponential, 25 % jitter, 30 s → 6 h) |
| `src/registry.ts` | `buildRegistry(groups, { posting, media })`: per job type, the handler of its `JOB_GROUP`; others ignored with a warning; missing ones listed (never claimed, so they wait) |
| `src/scheduler.ts` | `Scheduler` (posting group only): every minute ensures `cleanup:hourly:<UTC hour>`, `analytics.enqueueDailyAccountPulls` once per UTC day, `posts.enqueueDue` every 5 min. DB idempotency keys make replicas safe |
| `src/health.ts` | `startHealthServer({ port, status })`: `GET/HEAD /health` (`/healthz`, `/`) → 200 `{ ok, state, lastClaimAt, lastPollAt, active, … }` while running, 503 while starting/draining. No worker id or secrets |
| `src/posting/*.ts` | Handlers `publish_post`, `check_post_status`, `analytics_pull`, `import_past_posts`, `cleanup` (`postingHandlers`) |
| `Dockerfile`, `Dockerfile.dockerignore` | Railway image (below) |
| `railway.toml` | Config-as-code shared by the two Railway services (posting / media), set apart by `WORKER_TYPES` |
| `test/*.test.ts`, `test/helpers.ts` | 62 tests on PGlite + FakePostingProvider + MemoryStorage + manual clock (no network) |

## Runner behaviour

- Claims only job types that have a handler in an enabled group (`WORKER_TYPES`), `limit` = free slots (`WORKER_CONCURRENCY`), with `now` from the app clock. Polls every `WORKER_POLL_INTERVAL_MS` while the queue is empty; claim errors back off up to 30 s.
- Lease 120 s, renewed every 40 s while a handler runs. If a renewal finds the job gone (requeued by another worker's sweep), the handler's `ctx.signal` aborts and its outcome is dropped.
- Failure: `PermanentJobError` and `AppError` codes `validation | bad_request | not_found | forbidden | unauthorized` → `dead` at once; otherwise `failed` with retry delay = `RetryJobError.retryInMs` › provider `retryAfterSec` › exponential backoff with jitter. `dead` after `max_attempts` (queue). Errors stored/logged scrubbed.
- Stale leases are requeued at start and every 60 s (`services.jobs.requeueStale`).
- Shutdown (SIGTERM): stop claiming → wait up to the grace period for running jobs → abort their signals → wait 5 s → release still-running jobs (`running → queued`, attempt not used up). A handler that settles after its job was released is ignored.
- Logs: JSON lines through `@app/core` `createLogger` (redacting), per job `jobId`, `jobType`, `attempt`, duration.

## Posting handlers

- **publish_post** → `services.posts.preparePublish` (approval at the stored revision, entitlements, account, media, platform cap at dispatch → moved +1 h, presigned GET URLs, claim → `publishing`). Then `provider.publish` with idempotency key **`post:<postId>:<attempt>`** (attempt = `posts.attempts` after the claim) → `posts.recordPublishRequest` (stores request id, queues the first `check_post_status`).
  - Unclear provider failures (`provider_unavailable`, `conflict`, non-AppError) may have created the upload, so the post **stays `publishing`** and the job retries (1, 2, 4, 8 min). The retry sees "publishing without a request id", rebuilds the input (re-verifying the approval at the stored revision) and publishes again with the **same** key, so the provider dedupes. On the job's last attempt the post fails with a safe message.
  - The same resume path recovers a worker that died between claim and `recordPublishRequest`.
  - Clear refusals → `posts.recordPublishError` (`retryable` = rate limit / provider cap / auth → rescheduled, next claim = new attempt = new key; others → failed with the provider's safe message).
  - X-link metering, audit, analytics checkpoints: services (`onPublished`).
- **check_post_status** → `provider.getStatus` → `posts.recordPublishStatus(…, { poll })`. Published → url/post id, analytics pulls at +24h/+48h/+7d/+30d; failed → failed with safe error; pending → next poll with backoff (15 s ×2 up to 10 min; 150 polls ≈ 24 h, then failed). A failed status call counts as pending. A provider 404 after poll 2 → `recordPublishError(retryable)` (fresh publish attempt). Posts already settled (webhook) are skipped.
- **analytics_pull** post scope: `getPostMetrics({ requestId, platformPostId, platform, profileRef })` → `analytics.recordPostMetrics`; TikTok at the 24 h checkpoint also re-checks `getStatus` (see Request 4). Account scope: active accounts of an active brand → `getAccountMetrics` → `analytics.recordAccountMetrics` per platform asked for. Empty answers are not stored. Provider errors retry via the runner.
- **import_past_posts** → pages `listPastPosts` (100 per page, ≤ 50 pages, stops on no cursor / empty page / repeated cursor / `limit`) → `imports.savePastPosts` per page. Idempotent (upsert on brand + platform + external id). Checks the account belongs to the brand/platform (else permanent) and is active (else skipped).
- **cleanup** → `services.maintenance.cleanup({ now })`.

## Deploy (Railway)

- Image: `mcr.microsoft.com/playwright:v1.63.0-noble` (matches `playwright-core` 1.63.0; Chromium under `/ms-playwright`, `PLAYWRIGHT_BROWSERS_PATH` set) + `ffmpeg`, `tini` (PID 1, reaps Chromium children), `fonts-noto-core`, `fonts-noto-mono`, `fonts-noto-color-emoji`, `fonts-dejavu-core`. `pnpm install --frozen-lockfile --prod --filter "@app/worker..."` in a deps stage; runs as `pwuser`; app files root-owned (read-only); `MEDIA_TMP_DIR=/tmp/worker-media`; `CMD node --import tsx src/main.ts` (workdir `/app/apps/worker`).
- Build from the repo root: `docker build -f apps/worker/Dockerfile .` (BuildKit uses `apps/worker/Dockerfile.dockerignore`).
- Two Railway services, both with config path `apps/worker/railway.toml`, root directory `/`: `worker-posting` (`WORKER_TYPES=posting`) and `worker-media` (`WORKER_TYPES=media`, `WORKER_CONCURRENCY=1`). Healthcheck `/health` on `$PORT`; `drainingSeconds = 120` (the worker reads `RAILWAY_DEPLOYMENT_DRAINING_SECONDS` and finishes ~10 s before the kill).
- Both services need the full app env (config validation requires the transcription settings even on the posting service in production).

## For the media agent (`src/media/**`)

- Type handlers as `Handler` from `../types`; `ctx` has `services, provider, storage, transcriber, config, db, tmpDir, clock, logger, signal`.
- Call `throwIfAborted(ctx.signal)` (from `../errors`) between long steps / kill ffmpeg on abort and throw `JobAbortedError`: the runner releases the job at shutdown instead of failing it. Throw `PermanentJobError` for input that can never work; anything else retries with backoff.
- Leases renew automatically; no heartbeat needed. Results returned are stored in `jobs.result` (renders: `{ mediaIds }`).
- `mediaHandlers` keys must be media-group types (`source_ingest`, `transcribe`, `clip_render`, `carousel_render`, `video_render`); others are ignored with a warning.
- Tests: `test/helpers.ts` `createWorkerHarness()` / `makeRunner()` / `jobRow()` give a PGlite context with fakes.
- Need more apt packages or fonts (e.g. `fonts-noto-cjk`)? Ask here; the Dockerfile is in this agent's paths.

## Decisions

1. **Entrypoint is `src/main.ts`** (as `pnpm start`); `src/index.ts` stays the package's export barrel, so importing it never starts a worker.
2. **Idempotency key `post:<id>:<attempt>`**, with unclear outcomes retried under the same attempt (above), so a crash or timeout never double-posts and a clear refusal can be retried cleanly.
3. **Status-poll budget 24 h** via `WORKER_SERVICES_OVERRIDES.statusPollMaxPolls = 150` (services default 60 ≈ 9 h). Only worker-side calls pass `poll`.
4. **Scheduler in the worker** (posting group) rather than only Vercel cron: hourly cleanup, daily account analytics, 5-minute lost-publish sweep. Web cron routes can stay as a backup (different keys; both are harmless).
5. zod is not a worker dependency: payloads go through `parseJobPayload` (services' zod schemas), env through `loadConfig`; `RAILWAY_DEPLOYMENT_DRAINING_SECONDS` is parsed with a strict digit check.

## Verified / not verified

- `pnpm -F @app/worker typecheck` clean; `pnpm -F @app/worker test`: 6 files, 62 tests. `pnpm lint` (boundaries) passes.
- Smoke run of `node --import tsx src/main.ts` (PGlite, fakes, `WORKER_TYPES=posting`): health 200, scheduler's cleanup job ran, SIGTERM → clean exit 0.
- **Not verified:** the Docker build (no Docker daemon here); the Playwright image's Node major (22 or 24; both satisfy `engines >= 22`); Railway accepting `drainingSeconds` in config-as-code (if not, set "Draining seconds" in the service settings); BuildKit per-Dockerfile ignore support on Railway (without it the build context is just larger).

## Requests

1. **DB (`packages/db/src/repos/jobs.ts`):** add `release(db, jobId, workerId, now?)` (running → queued, `attempts − 1`, lease cleared) and expose it as `services.jobs.release`. The worker runs that one `update` itself in `src/queue.ts` until then.
2. **Services (`jobs.extendLease`):** accept an optional `now` (app clock) like `claim`/`fail`/`requeueStale`. The worker calls `@app/db` `jobs.extendLease(db, …, now)` directly meanwhile.
3. **Services (posts):** add `posts.resumePublish(userId, postId)` returning the `PublishInput` for a post that is `publishing` without `provider_request_id` (same checks as `preparePublish` minus the claim). The worker rebuilds it in `src/posting/publish-post.ts` (`rebuildInput`) meanwhile. Also: a maintenance sweep for posts stuck in `publishing` with no request id whose publish job is dead (e.g. older than 1 h → `recordPublishError`), since nothing else recovers them.
4. **Services (`posts.recordPublishStatus`):** on an already `published` post, store a late `postId`/`url` (TikTok confirms up to 24 h late; the worker re-checks at the 24 h checkpoint but today the call is a no-op for published posts).
5. **Services (config):** make the status-poll budget time-based or env-configurable (24 h per the task); the worker overrides `statusPollMaxPolls` meanwhile.
6. **Services (`maintenance.cleanup`):** the `cleanup` job payload's `task` (`all | expired | sources`) is ignored; either honour it or drop it from `JOB_PAYLOAD_SCHEMAS`.
