# Database handoff: `supabase/migrations` + `@app/db`

Owner: database agent. Covers `supabase/**` and `packages/db/**`. Other agents: put requests for changes here under "Requests".

## What exists

| Path | What |
| --- | --- |
| `supabase/migrations/0001_init.sql` | The whole v1 data model: 15 enums, 20 tables, constraints, indexes, triggers, RLS, grants. **Frozen from now on:** the migrator stores checksums, so schema changes go in `0002_*.sql` and later files. |
| `packages/db/src/types.ts` | `Db` interface |
| `packages/db/src/postgres.ts` | `createPostgresDb(url, { max, idleTimeoutSec, connectTimeoutSec, ssl })` (postgres.js 3.4, `prepare: false` for the Supabase pooler) |
| `packages/db/src/pglite.ts` | `createPgliteDb(dataDir?)` (`undefined`/`"memory"` = in memory), `wrapPglite(pg)` |
| `packages/db/src/migrate.ts` | `migrate(db, dir?)`, `readMigrations(dir)`, `findMigrationsDir()` |
| `packages/db/src/supabase-shim.ts` | `installSupabaseShim(db)`: roles anon/authenticated/service_role, `auth.users`, `auth.uid()`, Supabase's default grants. PGlite only, never on Supabase. |
| `packages/db/src/open.ts` | `openDb({ url, poolMax, pgliteDataDir })`: postgres.js when `url` is set, otherwise local PGlite with the shim and migrations applied |
| `packages/db/src/cli.ts` | `pnpm -F @app/db migrate [--local-shim]` (reads `DATABASE_URL`, else `PGLITE_DATA_DIR`) |
| `packages/db/src/errors.ts` | `DbError`, `PG_ERROR`, `APP_SQLSTATE`, `isUniqueViolation` etc., `dbErrorToAppError` |
| `packages/db/src/repos/*.ts` | Repositories (below) |
| `packages/db/src/testing.ts` | `@app/db/testing`: `createTestDb`, `resetTestDb`, `asUser`, `asAnon`, seed helpers |

## Using it

```ts
import { openDb, drafts, posts, bindRepos, type Db } from '@app/db'
const db = await openDb({ url: config.DATABASE_URL, poolMax: config.DATABASE_POOL_MAX, pgliteDataDir: config.PGLITE_DATA_DIR })
await db.tx(async (tx) => {
  const r = bindRepos(tx)                 // or call drafts.get(tx, userId, id)
  const d = await r.drafts.get(userId, draftId)
})
```

- `Db`: `query<T>(sql, params?) → T[]`, `one<T>() → T | null`, `exec(script)` (multi-statement, no params), `tx(fn)` (nested calls use savepoints), `close()`, `driver`.
- Inside `db.tx(fn)`, use only the handle passed to `fn`. On PGlite, a query on the outer `db` waits for the transaction to end, so it deadlocks.
- Repositories are plain functions: `(db, userId, ...)`. Namespaces: `users, brands, accounts, media, transcripts, clips, drafts, posts, voice, pastPosts, analytics, usage, jobs, oauth, approvalNonces, stripeEvents, audit, maintenance`. `bindRepos(db)` pre-applies `db`.
- Rows are camelCase with `Date` for timestamps. Row types are exported (`DraftRow`, `VariantRow`, `PostRow`, `JobRow`, …). `JobRow` comes from `@app/core`.
- Errors from both drivers become `DbError { code, constraint, table, column, detail }`. Query parameters are never kept, because they can hold secrets. `dbErrorToAppError(err)` maps errors to `AppError`: unique → conflict, FK → not_found, check → validation, P0A01/02/03/05/06 → conflict, P0A04 → validation, 42501 → forbidden.

### Writing raw SQL (both drivers must behave the same)

- jsonb parameter: pass `JSON.stringify(v)` (or `json(v)` from `@app/db`) and cast `$1::text::jsonb`. postgres.js would JSON-encode an already-encoded string a second time.
- Enum-array parameter: `$1::text[]::public.platform[]`. postgres.js cannot serialise arrays of custom enum types; `uuid[]` and `text[]` work directly.
- `int8`/`count(*)`: both drivers return a JS number when the value is safe and a BigInt otherwise. Prefer `count(*)::int`.
- PGlite's clock has millisecond resolution, so rows inserted in the same millisecond share `created_at`. Don't rely on `created_at` ordering for those in tests (the test helper `tick()` waits 3 ms).

## Schema decisions (where ARCHITECTURE was silent)

1. **Tenant integrity.** Every child references its parent through a composite `(id, user_id)` FK, so a row can never point at another user's brand, draft, media or account, whatever a service passes. Nullable composite FKs use `ON DELETE SET NULL (col)` (Postgres 15+; Supabase is 15/17).
2. **ON DELETE.** `user_id` cascades everywhere (and `users.id` cascades from `auth.users`). "Restrict where history matters" is `NO ACTION`: posts → drafts / variants / connected_accounts, and clips → source media. You can't delete those parents directly, but deleting a whole user or brand still cascades, because the check runs at end of statement. Media → brand, variant → account, snapshot → account, clip → output/draft and draft → source clip use SET NULL. Brands are archived, not deleted.
3. **Draft revision.** Starts at 1 and bumps **once per transaction** that changes content. Content means a variant insert/update/delete (columns platform, connected_account_id, text, title, media_ids, options, has_link) or the draft's `brand_id`; `notes` is not content. The transaction that creates the draft doesn't bump, so a draft created with 3 variants is at revision 1. A transaction-local setting (`app.touched_drafts`) implements this, and it follows savepoint rollbacks. `revision` and `content_hash` can only be written by the triggers (P0A02).
4. **content_hash** = SHA-256 of `jsonb {brand_id, variants:[… ordered by platform]}`, computed in SQL. It is not meant to match `@app/core` `contentHash()`.
5. **Approval.** `status='approved'` ⇔ every `approved_*` is set, with `approved_revision = revision` and `approved_hash = content_hash` (CHECK plus trigger, P0A06). You can't approve a draft that has no variants. Drafts are inserted only as `draft`. Any status other than approved clears `approved_*`. `drafts.approve(db, userId, id, { revision, via })` returns null if the revision moved or the draft is archived or already approved; it is allowed from `draft` or `rejected`.
6. **Content edits after approval** reset approved → draft (as specified). The spec doesn't cover rejected drafts: editing one keeps it `rejected`. Call `drafts.reopen` if the service wants it back in the queue.
7. **Leaving `approved` cancels posts.** When a draft leaves `approved` (edit, reject, archive), its `scheduled` posts become `canceled` with an explanatory `error`. Posts already `publishing` are left alone, and `failed` posts stay failed. The rule: a post can only *enter* `scheduled` or `publishing` while its draft is approved at the post's `approved_revision` (P0A01). So to publish edited content, approve again and schedule again.
8. **Post insert** (trigger, P0A01/P0A04/P0A06/P0A03). The draft must be the user's and approved at `revision = approved_revision = NEW.approved_revision`. The variant must belong to that draft and have the same platform, plus the same account if the variant pins one. The account must be the user's, on the draft's brand and platform, with status `active`. The brand must be `active`. The status must be `scheduled`. The insert takes `FOR SHARE` on the draft row, so a concurrent edit waits and then cancels the new post (tested on real Postgres).
9. **Post immutability.** Only `status, provider, provider_request_id, provider_post_id, post_url, error, attempts, scheduled_for, published_at, canceled_at` (and `updated_at`) may change. Allowed transitions: scheduled → publishing | failed | canceled; publishing → published | failed | scheduled; failed → scheduled | canceled | published (late provider confirmation, no re-post). `published_at`/`canceled_at` are filled automatically. Published and canceled posts can't be rescheduled.
10. **Variants.** `media_ids` must be the user's media, with no duplicates and at most 35 (`MAX_MEDIA_PER_VARIANT`); `text` ≤ 70,000 and `title` ≤ 500 (the core caps). A pinned account must be on the draft's brand and the variant's platform. `has_link` is set by services (`hasLink()` from core).
11. **Clips.** `end_ms > start_ms`, length ≤ 180,000 ms, and inside the source's `duration_ms` when it is known. The source must be the user's `video` with origin `upload`/`drive_link` and `rights_attested_at` set (P0A04). The 3-second minimum is left to core validation.
12. **Own content only.** `media_assets.source_host` is required for, and only allowed on, `drive_link` media. It must be one of the 7 hosts in `DRIVE_HOSTS`, so YouTube and other video sites are rejected by a CHECK. Drive links need `rights_attested_at`, and `source_url` must be https and only exists on drive links.
13. **Usage ledger** (append-only: UPDATE and direct DELETE raise P0A05; user cascades still work). `amount > 0`, except `adjust`, which may be negative but not 0. `used = settle + (reserve − release) + adjust` per (user, meter, `period_start` exact match). To settle, write a `release` of the reservation plus a `settle` of the actual amount, in one transaction. `usage.reserveWithinLimit` locks the user row, checks `used + amount ≤ limit` and inserts; it is idempotent by key.
14. **Jobs.** `failed` means "retry pending" (`run_at` pushed back by `backoffMs(attempts)` from core, or by `retryInMs`). `dead` means out of attempts (or `permanent`). `claim` takes `queued` + `failed` jobs with `run_at <= now`, orders them by `run_at, created_at`, uses `FOR UPDATE SKIP LOCKED`, increments `attempts` and sets the lease. `complete`/`fail`/`extendLease` require the lease holder (`locked_by`). `requeueStale` handles expired leases. All of these accept `now` for tests.
15. **Audit meta** may not contain credential-like keys (same pattern as `REDACT_KEY_PATTERN`) at any depth (CHECK). `audit.record` strips them first.
16. **Metrics jsonb** (`analytics_snapshots`, `past_posts`): an object holding only the 8 `METRIC_KEYS` with non-negative numbers (CHECK).
17. **OAuth.** Only hex SHA-256 hashes are stored for codes, tokens and nonces (CHECK). `code_challenge` must look like S256. `token_endpoint_auth_method` can only be `none`. Refresh rotation: `oauth.useRefreshToken(hash)` atomically revokes the presented token and returns it; the caller issues the new pair in the same `familyId`. Presenting it again returns `reused` and revokes the family.
18. **Stripe events.** `stripeEvents.record` (insert-or-get), then `lockUnprocessed` in a transaction, then `markProcessed`. A failed attempt stays unprocessed, so Stripe's retry runs it again.
19. **updated_at** exists on the mutable tables (users, brands, connected_accounts, media_assets, transcripts, clips, drafts, draft_variants, posts, past_posts, jobs). voice_profiles, analytics_snapshots, the ledger, audit, nonces, stripe events and oauth tables have only `created_at` (+ `used_at` / `revoked_at` / `last_used_at` / `processed_at`).
20. **Text CHECKs** bound every free-text column (names ≤ 100, errors ≤ 4,000, …), and repos truncate errors and notes before writing.

## RLS and roles

- RLS is enabled on all 20 tables and on `schema_migrations`. `authenticated` gets **SELECT only**, through one policy per table (`user_id = (select auth.uid())`; on users, `id = …`). That covers users, brands, connected_accounts (column grant: every column except `encrypted_credentials`, so clients must list columns rather than `select *`), media_assets, transcripts, clips, drafts, draft_variants, posts, voice_profiles, past_posts and analytics_snapshots.
- No policies and no grants (deny) on usage_ledger, jobs, oauth_*, approval_nonces, stripe_events, audit_log and schema_migrations. `anon` gets nothing.
- The migration revokes Supabase's default "grant all to anon, authenticated". **Future migrations must do the same for each new table** (`revoke all on public.<t> from anon, authenticated` + `enable row level security`); the test shim reproduces Supabase's default grants, so the RLS tests catch a missed revoke.
- Helper and trigger functions live in schema `private`, with execute revoked from public; every function sets `search_path = ''`. None are SECURITY DEFINER.
- **The server must connect as the table owner** (Supabase `postgres`, through the pooler). A future restricted role would need `usage on schema private` and `execute` on its functions, because triggers call them.

## Tests (`pnpm -F @app/db test`)

10 files and 176 tests on PGlite, plus 11 tests in `test/postgres.test.ts`. Those run on real Postgres only when `TEST_DATABASE_URL` is set (a throwaway database is created and dropped). They cover the postgres.js driver contract, cross-session `SKIP LOCKED`, concurrent queue draining, `reserveWithinLimit` under concurrency, the draft-edit vs post-insert race, revision semantics and RLS.

- With `APP_DB_TEST_POSTGRES_URL=postgres://…/postgres`, **every** `createTestDb()` becomes a throwaway database on that server. The whole suite (187 tests) passed this way on Postgres 16 and found the enum-array issue above. Recommended for CI with a Supabase-version Postgres.
- `createTestDb()` takes about 0.3 s: the migrated template is built once per process and cached on disk in `$TMPDIR/app-db-test-template/<checksum>.tar` (`APP_DB_TEST_CACHE=0` disables the cache). `resetTestDb(db)` truncates every table (milliseconds), for one database per file. Always `await db.close()`.
- Seeds: `createTestUser` (auth + app user; plan starter, active), `createTestBrand`, `createTestAccount` (active, provider `fake`), `createTestMedia` (ready image), `createTestSourceVideo` (ready, rights-attested, 10 min), `createTestDraft`, `approveTestDraft`, `seedTenant` (user + brand + active Instagram account), `createTestScheduledPost`.
- `asUser(db, userId, fn)` / `asAnon(db, fn)` run `fn` as the Supabase role with JWT claims. They restore the role afterwards, so they are safe inside an outer transaction.

## Functions that are not scoped by userId (by design)

`jobs.*` (queue; `enqueue` takes an optional `userId`, `listForUser` is scoped); `oauth.*` (lookup by hash); `approvalNonces.findByHash`; `stripeEvents.*`; `users.findByStripeCustomerId/SubscriptionId`; `posts.findByProviderRequest` (Upload-Post webhook: verify the webhook first); `maintenance.*` (cron/cleanup: expired nonces/codes/tokens, finished jobs, stale source videos, due posts, published-between, brands for analytics). Never pass user input to them.

## Notes for other agents

- **Services:**
  - Brand limit: in one transaction, `users.lockForUpdate`, then `brands.countActive`, then compare with `entitlements()` and call `brands.create` or `setStatus('active')`. Downgrades use `brands.suspendNewest(userId, keep)`.
  - Caps: `posts.activeTimesInRange(userId, accountId, capQueryRange(at))` then core `wouldExceedCap`; `posts.countInWindow` also exists.
  - Approve: `approvalNonces.consume`, then `drafts.approve({ revision: nonce.revision })`. A null result means the draft changed.
  - Map errors with `dbErrorToAppError`.
- **Worker:**
  - Publish: `posts.claimForPublish(userId, postId)`. A null result means the post was canceled, already claimed or is no longer approved; skip it.
  - Then `setProviderRequest`, then `markPublished` or `markFailed`. When a cap is full, use `requeue(…, at + 1h)`, which returns null if the draft is no longer approved.
  - Queue loop: `jobs.claim`, then `complete` or `fail`, plus a periodic `jobs.requeueStale()`.
- **Web:**
  - With `DEV_AUTH` on PGlite, call `users.devEnsureAuthUser(db, id, email)` before `users.ensure(db, id, { email })`. With Supabase Auth only `users.ensure` is needed (auth.users is Supabase's).
  - Browser reads through supabase-js are possible (SELECT-only RLS), but `connected_accounts` needs an explicit column list.
- **Ops:**
  - Run `DATABASE_URL=<session pooler or direct URL> pnpm -F @app/db migrate` before deploying. It takes an advisory lock and is safe to run concurrently. It refuses a database without the `auth` schema; for a plain local Postgres, add `--local-shim` to install the Supabase stand-ins first.
  - Runtime pools can use the transaction pooler (port 6543).
  - Local dev without `DATABASE_URL` uses PGlite at `PGLITE_DATA_DIR`. Only one process can open that directory, so the web app and the worker can't share it; run them against a local Postgres or Supabase instead.

## Gaps

- PGlite has a single session, so cross-session locking is only covered by `postgres.test.ts`, which is skipped unless `TEST_DATABASE_URL` is set.
- Not tested against a live Supabase project (pooler, real `auth` schema). The shim mirrors Supabase's `auth.uid()` and default grants.
- No `supabase gen types` output; repos expose hand-written row types.

## Requests

- (root/CI owner) Run `pnpm -F @app/db test` once more with `TEST_DATABASE_URL` and `APP_DB_TEST_POSTGRES_URL` pointing at a Postgres 15/17 service container, so the real-Postgres paths stay covered.
