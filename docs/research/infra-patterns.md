# Best-practices research: data layer, queue, billing, metering, encryption, testing

Labels: **[V]** means I saw it in the cited source. **[U]** means it comes from memory or is my own design opinion. Sources are listed at the end. No repo files were changed.

---

## (a) Multi-tenant schema and RLS

**Recommendation: `profiles` 1:1 with `auth.users`, plus a `workspaces` tenant table from day one.**

- Create `public.profiles(id uuid primary key references auth.users on delete cascade)`. Fill it from an `after insert on auth.users` trigger that is `security definer set search_path = ''`. Supabase warns that a failing trigger "could block signups" [V][3]. Keep the trigger minimal.
- Add a `workspaces` table now, even though v1 has one owner. It is both the billing tenant and the brand owner. Pair it with `workspace_members(workspace_id, user_id, role)`. Brands, connected accounts, drafts, posts, clips, voice profiles, analytics snapshots and usage all carry a **denormalised `workspace_id`**, so every policy is one indexed column check. This makes adding teammates later a data change, not a schema rewrite [U].
- Policy shape: `create policy ... to authenticated using (workspace_id = any (array(select private.user_workspace_ids())))`.
  - `private.user_workspace_ids()` is a `security definer`, `stable` function in a **non-exposed schema** that reads `workspace_members where user_id = (select auth.uid())`.
- RLS performance figures from Supabase's own guide, all [V][2]:
  - Wrap `auth.uid()` and other helper functions in `(select …)` so they run once as an initPlan: 179ms down to 9ms, and 178,000ms down to 12ms for a role function.
  - Use the `any(array(select fn()))` form for team membership: 173,000ms down to 16ms.
  - Write joins as `team_id in (select team_id from members where user_id = …)` rather than the reverse: 9,000ms down to 20ms.
  - Add `to authenticated`.
  - Index every column a policy filters on. A column counts as indexed only if it is the **first** column of a btree index [V][1].
  - Also filter explicitly in your queries. Supabase's advice is "Do not rely on RLS for filtering but only for security" [V][2].
- Functions are not protected by RLS. Revoke `execute` from `public`, then grant it explicitly to `authenticated` for the helper functions that policies call [V][4]. Expose only an API schema and keep helpers in `private` [V][4].
- **Workers and the service role:**
  - The secret (service-role) key has `bypassrls`, but only when the request carries no user token [V][1].
  - Railway workers should connect with a plain Postgres URL as a dedicated login role with explicit grants, not the all-powerful key everywhere [U].
  - Every job payload carries `workspace_id`, and the worker re-checks ownership [U].
- **MCP server:** run user-scoped work inside a transaction that does `set local role authenticated` and sets `request.jwt.claims` to the user's id, so RLS still protects you if a tool handler has a bug. Drizzle documents exactly this pattern [V][7].
- **Connections:**
  - Supabase direct connections are IPv6-only unless you buy the IPv4 add-on [V][5]. Railway users report `ENETUNREACH` errors, fixed either with Railway's opt-in outbound IPv6 setting or by using the **session pooler on port 5432** [V forum][6].
  - Vercel functions should use the transaction pooler on port 6543 with prepared statements turned off [V][5].
  - Transaction mode loses LISTEN/NOTIFY and advisory locks [V][5].

## (b) Job queue

**Recommendation: pg-boss v12 for every queue, on Railway, over the session pooler or a direct connection.**

| Need | pg-boss | graphile-worker | Supabase Queues (pgmq) | Custom SKIP LOCKED |
|---|---|---|---|---|
| Delayed/scheduled jobs | `startAfter` (Date, ISO or interval) [V][10] | `run_at` [U] | integer `delay` seconds [V][12] | build it yourself |
| Retries/backoff | `retryLimit`, `retryDelay`, `retryBackoff`, `retryDelayMax` [V][9] | exponential, default 25 attempts over ~3 days [V][11] | none in the API; only visibility timeout and `read_ct` [V][12] | build it yourself |
| Dead-letter | `deadLetter` queue [V][9] | permanently failed jobs [U] | archive table [V][12] | build it yourself |
| Cron | Cron and RRULE schedules [V][8] | crontab with backfill [V][11] | separate `pg_cron` [U] | build it yourself |
| Dedup/concurrency | `singletonKey`; policies `singleton`, `stately`, `exclusive`, `key_strict_fifo` [V][9] | `job_key` with replace / `preserve_run_at` / `unsafe_dedupe` [V][11] | FIFO message groups [V][12] | build it yourself |
| Enqueue in your own transaction | `db` adapter; the insert "commits or rolls back with your transaction" [V][10] | `add_job` from SQL or triggers [V][11] | SQL `send` [V][12] | yes |
| Observability | dashboard and OpenTelemetry [V][8] | SQL tables [U] | queue and archive tables [V][12] | build it yourself |

Why pg-boss:
- It covers every row of the table out of the box.
- Its `key_strict_fifo` policy lets you **serialise jobs per connected account** [V][9].
- Transactional enqueue gives you an outbox for free: approving a draft and scheduling its job commit atomically [U].
- Requirements: Node 22.12+ and Postgres 13+ [V][8]. The current docs show 12.38.0 [V][8].
- Supabase evaluated replacing its own storage-service fork with upstream pg-boss 12. That PR was closed in favour of another approach, so read it as a signal of maturity only [V][13].
- graphile-worker is the runner-up. Its LISTEN/NOTIFY gives sub-3ms pickup, but that needs session or connection mode [V][11]. Scheduled posts don't need millisecond latency.
- pgmq is too low-level here: you would rebuild retries, cron and dead-letter handling yourself.

Queue layout [U]:
- `post.publish`: `startAfter = scheduled_at`, 3 retries with backoff, `key_strict_fifo` keyed by `connected_account_id`.
- `clip.process`: a separate Railway service, concurrency 1–2, long `expireInSeconds` and a heartbeat.
- `render.carousel` / `render.video`: the headless-browser service.
- `analytics.pull`: a cron fan-out job.
- `stripe.event`.

**Idempotency** (delivery is at-least-once) [U]:
- The `posts` row, not the queue, is the source of truth.
- Claim the post with `update posts set status='publishing' where id=$1 and status='scheduled' returning`.
- If the worker crashes mid-call, move the post to `unknown` and reconcile it through `post_status`. Never re-post blindly.
- Enforce platform caps at dispatch time: count published posts per account in a rolling 24h window (Instagram 100, TikTok 15). If the account is over the cap, re-enqueue with a later `startAfter`.

## (c) Mirroring Stripe

**Recommendation: a small mirror that is overwritten from fresh API reads, plus an event-dedupe table.**

Tables:
- `billing_customers(workspace_id pk, stripe_customer_id unique)`
- `subscriptions(id 'sub_…' pk, workspace_id, status, cancel_at_period_end, cancel_at, canceled_at, trial_end, raw jsonb, synced_at)`
- `subscription_items(id 'si_…' pk, subscription_id, price_id, price_lookup_key, quantity, current_period_start, current_period_end)`
  - The billing period lives **on items**: since `2025-03-31.basil`, subscription-level `current_period_*` fields are gone [V][16].
- `stripe_events(id 'evt_…' pk, type, received_at, processed_at, error)`

Webhook handling:
- Verify the signature against the **raw body** (`await req.text()` in a Next.js route) [V][14].
- `insert … on conflict do nothing` on the event id, enqueue `stripe.event`, and return 2xx quickly [V][14].
- Stripe doesn't guarantee event order and says not to use `created` for ordering. Track event ids to catch duplicates [V][14].
- So the processor **re-retrieves the subscription** from the API and upserts it. Processing is then order-independent and replay-safe [V: Stripe recommends retrieving the latest object][14].
- Stripe retries for up to 3 days in live mode [V][14].

Add-ons and plans:
- Add-ons are licensed prices with quantities on the same subscription: `extra_brand` at $3 per unit and `extra_clip_hour` at $1 per unit. Quantity changes prorate [V][15].
- Limits: classic billing mode allows 20 items per subscription, flexible mode 100 [V][15].
- Map plans by **price `lookup_key`** (`starter`, `plus`, `pro`, `extra_brand`, `extra_clip_hour`) [U].
- Expose a SQL view `workspace_entitlements` (`brand_limit = plan.brands + extra_brand.qty`, and likewise for clip hours) that every limit check reads [U].

## (d) Usage metering

**Recommendation: an append-only ledger (the audit trail) plus a per-period balance row (fast, atomic checks), updated in one transaction.**

- `usage_balances(workspace_id, meter, period_start, granted, reserved, consumed)` and `usage_ledger(id, workspace_id, meter, period_start, kind grant|reserve|settle|release|adjust, amount, job_id, idempotency_key unique)`.
- Store **seconds**, not hours.
- The period comes from the subscription item's `current_period_start` [V field location][16]. Create the balance row lazily [U].
- **Reserve** in one statement [U]:

  ```sql
  update usage_balances
     set reserved = reserved + $n
   where workspace_id = $w and meter = 'clip_seconds' and period_start = $p
     and granted - consumed - reserved >= $n
  returning *;
  ```

  Zero rows means the quota is exhausted. The row lock serialises concurrent requests, so there is no read-then-write race.
- Reserve the ffprobe-measured source duration before enqueueing, in the same transaction as the pg-boss insert.
- **Settle** on success: `reserved -= est, consumed += actual`. **Release** on failure or dead-letter. A cron sweeper releases reservations older than the job's expiry.
- Meter transcription once per source video, not per clip [U, product call].
- **Brand limits:** a `before insert on brands` trigger that `select … for update`s the workspace row, counts active brands and compares against `workspace_entitlements`. It is enforced in the database whichever caller inserts (MCP, web or worker) [U].
  - On downgrade, mark extra brands `suspended`; never delete them.
- **X link posts:**
  - Detect links server-side on the final text.
  - After a confirmed publish, insert a ledger row with `idempotency_key = 'x_link:'||post_id`.
  - Start with internal cost tracking only [U].
  - If you later bill for them, use Billing Meters. Legacy usage records were removed in `2025-03-31.basil` [V][17].
  - Send meter events from a job with `identifier = ledger.id`. Stripe dedupes identifiers for at least 24h [V][18].
  - Timestamps must be within the past 35 days [V][18].
  - Live mode allows 1,000 calls/s and one concurrent call per customer per meter, so pre-aggregate [V][18].

## (e) Encrypting third-party tokens

**Recommendation: application-level AES-256-GCM envelope encryption. Do not use pgsodium. Keep Vault for a few infrastructure secrets only.**

- Supabase says pgsodium "will be deprecated" and not to use it. Vault doesn't depend on pgsodium and is unaffected [V][19].
- Vault uses libsodium authenticated encryption, and the key never sits in the database [V][20]. But secrets are decrypted **inside Postgres** through the `vault.decrypted_secrets` view, so any privileged SQL path reads plaintext [V][20]. Supabase also holds the key [V][20]. That suits a few cron or webhook secrets, not per-user OAuth tokens [U].
- **Which tokens we hold:** Upload-Post "handles the OAuth exchange and token storage" for social accounts [V][22].
  - In v1 we store only the Upload-Post profile id.
  - Our Upload-Post API key lives in env vars, never in the database.
  - Tokens we *do* encrypt: cloud-drive refresh tokens, and future direct-platform adapters.
- **Design:**
  - Columns: `ciphertext, iv(12B), auth_tag, key_version, wrapped_dek`.
  - AAD = `table:column:row_id:workspace_id`, so ciphertexts can't be swapped between rows [U].
  - The KEK lives in a KMS (or a 32-byte env secret to start) and is never stored in Postgres. OWASP backs GCM, DEK/KEK separation, keeping keys apart from data, and having rotation code ready [V][21].
  - **Rotation:** use a keyring keyed by `key_version`. New writes use the current key, and a background job re-wraps DEKs [U].
- **Tokens we issue** (MCP OAuth codes, access and refresh tokens, API keys):
  - Generate 256-bit random values and store only `sha256` (or HMAC with a server pepper). Show a prefix and the last 4 characters.
  - Slow password hashes are unnecessary for high-entropy tokens.
  - Rotate refresh tokens and detect reuse [U].
  - Configure logger redaction paths so tokens never reach logs [U].

## (f) Testing and types

**Recommendation: the Supabase CLI local stack is the single test database. Use pgTAP for schema and RLS, and Vitest for application integration tests.**

- **CI:** `supabase start` then `supabase test db` in GitHub Actions. Isolate each test with `begin`/`rollback`, cover anon and authenticated users, and include negative cases [V][23].
- **Helpers:** basejump `supabase_test_helpers` provides `tests.create_supabase_user`, `tests.authenticate_as`, `tests.clear_authentication` and `tests.rls_enabled` [V][24]. Pin the version, because signatures differ between forks [V][24].
- **What pgTAP covers:**
  - Every table has RLS enabled.
  - Cross-workspace reads and writes fail.
  - The brand-limit trigger rejects one insert over the limit.
  - The reserve statement can't overdraw.
- **Vitest against the same stack** (direct Postgres URL) covers:
  - Repositories, pg-boss handlers and concurrent `Promise.all` reservations.
  - Stripe webhooks with signed fixture payloads.
  - External HTTP mocked, as the house rules require [U].
- **PGlite** bundles pgcrypto and pg_trgm. pgTAP and pgmq are separate packages, and pg_cron isn't listed [V][25]. It also lacks Supabase's `auth` schema and roles [U], so use it only for fast pure-SQL unit tests if at all.
- **Testcontainers** duplicates what the CLI stack already provides [U].
- **Types and schema:**
  - SQL migrations in `supabase/migrations` are the source of truth, because policies, triggers and functions are SQL-heavy.
  - `supabase gen types typescript --local > database.types.ts` feeds `createClient<Database>` in Next.js [V][26].
  - CI fails if regenerating the types produces a diff [U].
  - Workers and the MCP server need real transactions (reserve plus enqueue, the claim+role pattern), which supabase-js can't do. Use **Kysely + kysely-codegen** over `pg` there [U].
  - Pass the Kysely transaction to pg-boss's `db` adapter [V adapter exists][10].
  - Drizzle's Supabase RLS helpers are good [V][7], but Drizzle-owned migrations would compete with the SQL migrations as a second source of truth [U].

---

**Sources**
[1] https://supabase.com/docs/guides/database/postgres/row-level-security · [2] https://supabase.com/docs/guides/troubleshooting/rls-performance-and-best-practices-Z5Jjwv · [3] https://supabase.com/docs/guides/auth/managing-user-data · [4] https://supabase.com/docs/guides/api/securing-your-api · [5] https://supabase.com/docs/guides/database/connecting-to-postgres · [6] https://station.railway.com/questions/supabase-error-connect-enetunreach-9efd356d · [7] https://orm.drizzle.team/docs/rls · [8] https://github.com/timgit/pg-boss , https://pgboss.io/ · [9] https://raw.githubusercontent.com/timgit/pg-boss/master/docs/api/queues.md · [10] https://pgboss.io/api/jobs · [11] https://worker.graphile.org/docs , https://worker.graphile.org/docs/faq , https://worker.graphile.org/docs/job-key · [12] https://supabase.com/docs/guides/queues , https://supabase.com/docs/guides/queues/api , https://github.com/pgmq/pgmq · [13] https://github.com/supabase/storage/pull/1198 · [14] https://docs.stripe.com/webhooks · [15] https://docs.stripe.com/billing/subscriptions/quantities · [16] https://docs.stripe.com/changelog/basil/2025-03-31/deprecate-subscription-current-period-start-and-end · [17] https://docs.stripe.com/changelog/basil/2025-03-31/deprecate-legacy-usage-based-billing · [18] https://docs.stripe.com/billing/subscriptions/usage-based/recording-usage-api , https://docs.stripe.com/api/billing/meter-event/create · [19] https://supabase.com/docs/guides/database/extensions/pgsodium · [20] https://supabase.com/docs/guides/database/vault · [21] https://cheatsheetseries.owasp.org/cheatsheets/Cryptographic_Storage_Cheat_Sheet.html · [22] https://docs.upload-post.com/api/connect-api/ · [23] https://supabase.com/docs/guides/local-development/testing/overview · [24] https://supabase.com/docs/guides/local-development/testing/pgtap-extended , https://database.dev/raminder/supabase_test_helpers · [25] https://pglite.dev/extensions/ · [26] https://supabase.com/docs/guides/api/rest/generating-types
