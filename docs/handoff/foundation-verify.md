# Foundation verification: review, fixes and decisions

Owner: foundation reviewer. Scope: `packages/**`, `supabase/**`, `scripts/**`, root config. The
public API map for the next wave is in `foundation-summary.md`. The earlier handoffs
(`scaffold.md`, `db.md`, `posting.md`, `storage-transcription.md`, `services.md`) still describe
each package; where this file disagrees, this file is newer.

## Checks

| Command | Result |
| --- | --- |
| `pnpm install --frozen-lockfile` | failed at first (lockfile missing services' new deps); `pnpm install --offline` added exactly those 4 entries; frozen install now passes |
| `pnpm typecheck` | clean in all 9 projects |
| `pnpm test` | core 265, db 177 (+11 real-Postgres tests skipped without a server), posting 175, storage 84, transcription 59, services 116, web 9 |
| `pnpm lint` | boundary check passes |
| `TEST_PG_URL=… pnpm test:pg` (new) | on a local Postgres 16: db 188/188 (incl. the 11 cross-session tests), services 116/116 |

One run of the real-Postgres db suite (the first, right after the server started) had a single
failure that did not reproduce in 7 later runs; probably first-run contention. Watch for it in CI.

## Bugs fixed (each has a regression test)

1. **Approval bypass through the web approve link** (`packages/services/src/approvals.ts`,
   `supabase/migrations/0002_approval_nonce_channel.sql`, `packages/db/src/repos/approvalNonces.ts`).
   `approveUrl` embedded the card nonce, and ARCHITECTURE lets `approve_draft` show that URL as text
   to clients without MCP Apps. The AI could read it and call the app-only `approval_decide` tool
   itself. Nonces now have a `channel`: `issueNonce` returns a `card` nonce (UI-only `_meta`, web
   queue buttons) and a separate `link` nonce inside `approveUrl`. `link` nonces are accepted only
   with `via: 'web'`; `via` defaults to `'mcp'` (fail closed); `worker`/`system` can never approve.
   Refusal reason `wrong_channel`. Tests: `drafts-approvals.test.ts` ("plain-text approve link…",
   "card nonce works…"), `repos-auth.test.ts` (channel binding).
2. **Rolling-24h cap missed bursts right after the post time** (`packages/core/src/platforms.ts`).
   `countInBusiestWindow` never tried the window that starts at the new post, so 15 TikTok posts in
   the hour after `at` (and none before) counted as 1. Services had a local workaround; core is now
   correct, so `wouldExceedCap` is safe to use anywhere. Test: `platforms.test.ts`.
3. **Clip-time reservation leaks (user charged for work never done)**
   (`services/src/media.ts`, `transcripts.ts`, `maintenance.ts`, `db/src/repos/maintenance.ts`).
   Deleting a source after ingest but before its transcript kept the reservation; `transcripts.fail`
   refused deleted media; a transcribe job that died without reporting kept it until period end.
   Now: delete releases when no transcript exists, `fail` works on deleted media, and
   `maintenance.cleanup` releases reservations whose media failed/was deleted, whose transcribe job
   is dead, or that have no transcript after 48 h (`releasedReservations`; a late transcript still
   settles, so nothing is lost). Tests: `media-usage.test.ts`, `accounts-jobs.test.ts`.
4. **30-day source retention starved by post videos** (`db/src/repos/maintenance.ts`).
   `listStaleSourceMedia` returned post videos too; the service skipped them but they filled every
   batch, so clip sources behind them were never deleted (R2 cost grows). The query now returns
   clip sources only (rights attested). Test: `accounts-jobs.test.ts` (fails without the fix).
5. **Unbounded provider profiles** (`services/src/brands.ts`). Archived brands kept their
   Upload-Post profile; profiles are a paid, hard-limited resource (25 on Professional), so
   archive/create loops on a 1-brand plan could exhaust them for every customer. `brands.archive` now
   deletes the profile (best effort, retried by the next archive call) and marks the brand's accounts
   disconnected; restore + connect recreates it (same deterministic username). Tests:
   `users-brands.test.ts`.
6. **Stale invoice put the current subscription on hold** (`services/src/billing.ts`).
   `invoice.payment_failed` of an older subscription matched the user by customer id and set
   `past_due`. It is now ignored when it names another subscription. Test: `billing.test.ts`.
7. **Lockfile**: frozen installs failed (services' deps). Regenerated offline; no new packages.
8. **Migration test collided with real 0002** (`db/test/migrations.test.ts`): temp migrations now use
   versions 0090/0100/0101.

## Additions (requests from the handoffs, and gaps the next wave would hit)

- **`services.oauth`** (`packages/services/src/oauth.ts`, 13 tests): the OAuth 2.1 AS logic the web
  app needs for `/api/mcp` (ARCHITECTURE puts the AS in the web app but had no service for it):
  DCR (public clients; https, loopback http and app-scheme redirect URIs), authorize with PKCE S256
  and `resource` = our MCP URL (RFC 8707), loopback redirects matched on any port (Claude Code),
  `iss` in the authorization response, code exchange, refresh rotation with reuse → family revoked,
  RFC 7009 revocation, `verifyAccessToken` (audience + scope checked), connected-apps list/revoke,
  RFC 8414 / RFC 9728 metadata, the `WWW-Authenticate` value and `oauthErrorResponse`. Cleanup
  deletes registered clients that never connected after 7 days (`deletedOAuthClients`).
- **Core config** (scaffold/services/posting requests): optional `STRIPE_PRICE_STARTER|PLUS|PRO|EXTRA_BRAND|EXTRA_CLIP_HOUR`
  (validated `price_…`) and `UPLOAD_POST_PROFILE_PREFIX`, documented in `.env.example`. Services
  read them from `Config` (raw env still works); `createPostingProviderFromConfig` reads the prefix.
- **Core validation** (services request 3): `MAX_CLIP_RANGES` = 20 (product limit) with the message
  "Ask for at most 20 clips at a time."; `ClipRequestSchema` accepts an optional `brandId`, which
  `clips.requestClips` uses (so `make_clips` can take the schema as is).
- **DB** (services request 5): `brands.findByProviderProfileRef` (system lookup, used by the
  Upload-Post account webhook instead of raw SQL), `maintenance.listOrphanedClipReservations`,
  `maintenance.deleteUnusedOAuthClients`.
- **`pnpm test:pg`** (`scripts/test-postgres.mjs`; db request): runs the db and services suites
  against a real Postgres given by `TEST_PG_URL` (throwaway databases per test file).
- Services config gained `mcpResourceUrl`, `oauthAccessTokenTtlSec`, `oauthRefreshTokenTtlSec`,
  `oauthCodeTtlSec` (from `MCP_RESOURCE_URL`, `OAUTH_*_TTL_SEC`).

## Decisions (where ARCHITECTURE is silent)

1. Approval nonces are channel-bound (above). One `issueNonce` call writes two rows (card + link)
   with the same draft, revision and 24 h expiry.
2. Archiving a brand releases its provider profile and disconnects its accounts (cost and the
   provider's profile limit beat "instant restore"). Suspended brands (downgrade) keep theirs.
3. Orphaned clip reservations are released after 48 h without a transcript (or immediately when
   the media is gone or its transcribe job is dead).
4. OAuth: opaque random tokens (hashes stored), access 1 h, refresh 30 d rotated on every use,
   codes 5 min, single scope `social`. `redirect_uri` on the token request is optional (PKCE binds
   the code) but must match exactly when sent. A missing `resource` defaults to our MCP URL; any
   other value is `invalid_target`. CIMD (client ID metadata documents) is not implemented; DCR is
   the only registration path (Claude and ChatGPT fall back to it).
5. Registered OAuth clients without codes/tokens are deleted after 7 days.

## Requests to other owners

- **MCP (`packages/mcp`)**: `approve_draft` must call `approvals.issueNonce(u, id, { via: 'mcp' })`, put
  `nonce` only in the card's UI-only `_meta`, and may show `approveUrl` as text. The app-only tools
  call `approvals.decide` / `approvals.editVariant` with `{ via: 'mcp' }`. Use `ClipRequestSchema` for
  `make_clips` (it now includes `brandId`). Authenticate with `services.oauth.verifyAccessToken`.
- **Web (`apps/web`)**: mount the OAuth routes on `services.oauth` (table in `foundation-summary.md`);
  pass `{ via: 'web' }` on every approval call; rate-limit `/oauth/register` and `/oauth/token`;
  serve PRM at both `/.well-known/oauth-protected-resource` and `…/oauth-protected-resource/api/mcp`.
  Brand archive copy should say that accounts are disconnected and must be reconnected on restore.
- **Worker (`apps/worker`)**: run `maintenance.cleanup()` regularly (it now also refunds orphaned
  reservations and prunes OAuth clients); call `transcripts.fail` on a final transcription failure.
  Extend `WorkerContext` with the services fields (services request 6).
- **CI** (not set up yet): run `pnpm install --frozen-lockfile && pnpm typecheck && pnpm test && pnpm lint`,
  plus `pnpm test:pg` with a Postgres 15/17 service container (`TEST_PG_URL`).

## Still open

- Nothing ran against live Supabase, Upload-Post, R2, Whisper or AssemblyAI (no credentials).
- Upload-Post assumptions listed in `posting.md` ("Not verified") still stand.
- Platform caps are per process for the provider's own rate-limit gate (no shared limiter).
- Usage periods fall back to the calendar month while a Stripe renewal webhook is late; a user could
  get a fresh allowance for those hours (minor).
- A refresh-token retry after a lost response revokes the family (OAuth 2.1 behaviour); the user
  reconnects the AI app.
- DCR registration and token endpoints need rate limiting in the web layer.
