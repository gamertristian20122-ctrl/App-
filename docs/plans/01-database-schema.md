# Step 1 plan: database schema and data access layer

**Status:** final plan, waiting for owner approval (house rule: plan before coding).
**Date:** 2026-10-31. **Build-order step:** 1 of 8.

## 1. Summary

- **What step 1 delivers:**
  - 28 tables and 2 views in a private `app` schema.
  - 42 callable SQL functions (7.1), plus the triggers and helpers that enforce approval, metering, platform caps and the own-content rule inside the database.
  - Five TypeScript packages: `@app/shared`, `@app/db`, `@app/crypto`, `@app/log` and `@app/env`.
  - `scripts/dev-seed.ts`: two demo tenants (user, workspace, Pro comp, brands, an active fake provider profile and fake connected accounts), and `scripts/dev-approve.ts`, which records a web-context approval. Steps 2–7 can then run, and cross-tenant isolation can be checked by hand from a second MCP client, without Stripe or the step-8 web app (R3).
  - pgTAP and Vitest suites with CI.
  - No HTTP routes and no MCP tools. Section 7 explains why. Workers, the Upload-Post adapter, Stripe, R2 presigning and the UI come in later steps (section 9).
- **How the three plans were merged:**
  - The brief's score map splits each plan across two keys. Summed, the totals are B-integrity 20, C-evolution 20 and A-lean 18. I broke the B/C tie in favour of **C-evolution** as the base. C's structure needed the fewest structural changes: per-platform revisions, jobs, source media, analytics lineage and a provider dimension. B's best ideas are rules that drop into C's tables: the context-derived actor, fail-closed scopes, capped settle, monotonic grants, worker scoping and the role model.
  - Every judge "graft" is applied except where grafts conflict. In that case I follow two of the three judges (cost, security and forward-compatibility) and break ties with the house rules. Each such call is marked **Decision** where it appears.
  - A critic round followed. Its issues are cited as C1–C48 where they changed the plan; the appendix "Review notes" records how each was handled. Ideas recovered afterwards from the three candidate designs are cited as R1–R11 (appendix, "Recovered design ideas"). Fixes from a final verification review are cited as V1–V34 (appendix, "Verification fixes").
- **Nothing publishes without approval:**
  - Each platform variant has immutable revisions.
  - The database computes a `content_hash` that covers the text, options, target account, provider account ID, the destination (Page, organisation or board; C1) and every media file's sha256.
  - A post can only exist by pointing, through a composite FK, at a live approval of exactly that revision and account. One approval authorises one publication (C6, Q19).
  - The approval channel comes from the verified request context. The enum has no `mcp` value, so a model-visible tool cannot approve, and step 1 accepts only `web` decisions (C23, Q23).
  - The claim re-verifies the approval and recomputes the hash just before dispatch.
- **Metering:**
  - Plans live in a code constant (`PRICE_CATALOG`, with versioned lookup keys). Computed entitlements are mirrored per workspace.
  - Clipping hours, render seconds (3 × clip seconds; C7) and X link posts use a two-table ledger: a balance per period plus an append-only ledger. All changes are conditional `UPDATE`s with idempotency keys. Storage is capped per workspace (C35).
  - A settle can never charge more than its reservation. Granted amounts never shrink within a period, and upgrades are granted pro rata above the period's high-water mark (C33). Reservations are reconciled against their subject, never blindly expired (C3, C27).
  - The brand limit is a trigger that locks the workspace row, plus a churn guard on live Upload-Post profiles (C31).
- **Platform caps and the X link pool:**
  - Caps are the lower of the native platform cap and Upload-Post's cap. Instagram is therefore **50**, not the brief's 100.
  - Caps live in `app.platform_rules` (checked for parity with code) and are enforced inside `app.claim_post` under a lock on the real account identity, so a reconnect or move can't reset a window (C29).
  - X posts with a link need an explicit keep or strip choice before approval. "Keep" reserves from both the workspace allowance and the global Upload-Post pool, once per claim (C28). A link is never stripped silently.
- **Own content only:**
  - Media has no "downloaded URL" origin.
  - Cloud-drive URLs must be normalized, with no userinfo and no port. Their host must be on a per-provider allowlist and must match the URL. Users can't read the URL back, and a CHECK plus a trigger clear it whenever the source leaves `pending` or `fetching` (C41, V7); the fetcher re-checks every redirect hop (C8).
  - YouTube hosts are denied in a CHECK. Rights attestation is recorded against the verified caller and its channel; a source registered from an AI client also needs a standing attestation the user gave in the web app (V32).
  - CI blocks YouTube-downloader dependencies.
- **Security:**
  - Four login roles (Vercel; the Railway queue, media and billing services) and six privilege roles. No runtime role has BYPASSRLS. The clip and render workers, which process untrusted media in ffmpeg and a headless browser, can't reach billing, secrets, posting or cross-tenant scans (V22). What this does and doesn't guarantee is stated in 6.1 (C24).
  - RLS is brand-scoped and **fails closed** for MCP contexts that are missing `brand_ids` or scopes.
  - Nothing is exposed through Supabase's Data API, and no function is executable by PUBLIC (C36, V1).
  - Secrets use envelope encryption, and Vercel holds only public keys.
  - Media types are an explicit allowlist per kind and purpose (never SVG), with dimension, pixel and duration bounds (R1).
  - Stripe payloads are never stored, and logs are redacted.
- **Fact tags and open decisions:**
  - Tags: **[V]** = seen in the cited research source; **[V\*]** = secondary source only (Upload-Post docs or a third party); **[U]** = unverified, must be checked before anything relies on it.
  - The decisions that most shape the plan are X links (default: allowance 0, with "strip" preselected and a warning), the definition of a clipping hour, and the form of the hour add-on (section 10).

## 2. Repo scaffold & tooling

### 2.1 Layout

pnpm workspaces. Only `packages/{shared,db,crypto,log,env}`, `supabase/`, `scripts/` and CI get code in step 1. Every other directory gets a README stating its step.

```
App-/
├─ apps/
│  ├─ web/                 # step 8: Next.js on Vercel (calendar, approval queue, accounts, billing)
│  └─ mcp/                 # step 3: remote MCP server (Streamable HTTP + OAuth), deployed on Vercel
├─ workers/
│  ├─ queue/               # step 2: pg-boss dispatcher, Upload-Post adapter host
│  ├─ clipper/             # step 5: ffmpeg, Whisper / AssemblyAI
│  └─ renderer/            # step 7: headless-browser renders
├─ packages/
│  ├─ shared/              # @app/shared — enums, ids, catalog, platform rules, validators, zod schemas, errors
│  ├─ db/                  # @app/db — Kysely DAL, scoped transactions, generated types, test fixtures
│  ├─ crypto/              # @app/crypto — envelope encryption, token hashing
│  ├─ log/                 # @app/log — pino logger, redaction, scrubbers
│  ├─ env/                 # @app/env — zod env loading
│  ├─ posting/             # step 2: PostingProvider + Upload-Post adapter (README only now; the only place that may reference Upload-Post)
│  ├─ tsconfig/            # base tsconfig files
│  └─ eslint-config/       # flat config incl. import-boundary rules
├─ supabase/
│  ├─ config.toml
│  ├─ migrations/          # SQL migrations = source of truth; immutable once merged (MIG-21)
│  └─ tests/
│     ├─ database/         # pgTAP *.test.sql (00_catalog, 10_*, 20_rls_*, 30_metering), 00000_setup.sql
│     └─ fixtures/         # grants.expected, definer-allowlist.json, drive-hosts.json, revision-hash.json
├─ scripts/
│  ├─ db-local-login-roles.sql        # local passwords for the four login roles (6.1)
│  ├─ set-db-role-password.ts         # hosted: sets login passwords out of band
│  ├─ dev-seed.ts                     # 2 demo tenants: users, workspaces, Pro comps, brands, fake profiles/accounts (R3)
│  ├─ dev-approve.ts                  # dev-only: records a web-context approval (decide_variants) before step 8
│  ├─ check-migrations-immutable.ts
│  ├─ check-provider-boundary.ts      # no Upload-Post host or UPLOAD_POST_* outside packages/posting (R5)
│  └─ check-banned-deps.ts
├─ .github/workflows/ci.yml
├─ package.json  pnpm-workspace.yaml  .nvmrc  vitest.workspace.ts  eslint.config.js
```

### 2.2 Tooling

- **pnpm 10** workspaces. Packages run with `pnpm -r`; there is no Turborepo in step 1.
- **Node 24 LTS**, pinned in `.nvmrc` and `engines`. pg-boss needs Node 22.12 or later [V].
- **TypeScript 5.x** with project references (`tsc -b`). `packages/tsconfig/base.json` sets:
  - `"strict": true`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`
  - `noImplicitOverride`, `noImplicitReturns`, `noFallthroughCasesInSwitch`, `noPropertyAccessFromIndexSignature`
  - `verbatimModuleSyntax`, `"module": "NodeNext"`, `"target": "ES2023"`, `"isolatedModules": true`
- **Libraries:** zod 4, Kysely over node-postgres. The Supabase CLI is pinned. Objects are `.strict()` for AI and tool input and for our own jsonb schemas. Third-party payloads (Upload-Post, Stripe) are parsed with loose objects (`z.looseObject`) and mapped explicitly into typed columns, with unknown metric keys kept in `extra`, so a field a provider adds later can't break syncs, imports or analytics (V9).
- **Postgres major:** `supabase/config.toml` pins `[db] major_version = 17`, the hosted major **[U]** until the project exists. The plan relies on Postgres 15+ (`ON DELETE SET NULL (col)`, `NULLS NOT DISTINCT`), and the staging smoke test checks that `server_version_num` has the pinned major (8.1; R7).
- **DB types:**
  - `pnpm db:types` runs `kysely-codegen` against the local database, restricted to schema `app`, writing `packages/db/src/generated/db.ts`. The exact CLI flag names need checking at implementation **[U]**.
  - `supabase gen types` is not used: `app` is not exposed through the Data API, and the web app uses supabase-js only for Auth.
  - CI fails if regenerating the types produces a diff (MIG-03).
- **Test runners:**
  - **pgTAP** through `supabase test db`. Each file runs inside `BEGIN … ROLLBACK`. The basejump `supabase_test_helpers` are vendored at a pinned version [V], plus our own `tests.as_user / as_worker / as_media / as_system / as_billing / as_ingest / seed_world / purge_workspace` (the last runs as `postgres`, sets the workspace to `pending_deletion` and marks external resources deleted before deleting; 3.4, 3.7, 8.1).
  - **Vitest** in three projects:
    - `unit`: no I/O.
    - `integration`: runs against the local Supabase stack over direct Postgres connections as `app_api` and the three Railway logins (6.1).
    - `meta`: lint fixtures and parity checks.
  - **msw** with `onUnhandledRequest: 'error'`, so any unmocked HTTP call fails (house rule).
  - **fast-check** for the ledger property test.
- **Lint:** ESLint flat config.
  - typescript-eslint `strict-type-checked` plus `switch-exhaustiveness-check`. Its `no-floating-promises` and `no-misused-promises` rules matter here: an un-awaited query inside a `withUser` or `withWorker` callback would run after the transaction, and with it `SET LOCAL ROLE` and `app.ctx`, had ended (R7).
  - `no-console: error` everywhere except `scripts/`. All output goes through `@app/log`, because a `console.*` call would bypass its redaction (R6).
  - `no-restricted-imports` forbids `pg` and `kysely` outside `packages/db`, and the `upload-post` package outside `packages/posting`.
  - An import rule can't see string literals, so `scripts/check-provider-boundary.ts` fails on any Upload-Post host (`upload-post.com`, case-insensitive; `docs.upload-post.com` citations excepted) or `UPLOAD_POST_*` environment name in `apps/`, `workers/` or `packages/` outside `packages/posting` (R5). With the import rule it enforces the PostingProvider house rule (MIG-23).
  - `scripts/check-banned-deps.ts` fails on YouTube-downloader packages (MIG-22).

### 2.3 Migrations

Supabase CLI SQL files in `supabase/migrations`. Policies, triggers and functions are SQL-heavy, so SQL is the single source of truth and there is no ORM-owned migration tool. Files in order:

| File | Contents |
|---|---|
| `…_0001_schemas_roles.sql` | Drop `pg_graphql`; `CREATE EXTENSION btree_gist` (3.5); create the `app` and `private` schemas and the roles (no passwords; 6.1); revoke defaults, including the **global** `ALTER DEFAULT PRIVILEGES FOR ROLE postgres REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC`, with no `IN SCHEMA` (C36, V1). A per-schema form only adds to the global defaults and can't remove the built-in EXECUTE-to-PUBLIC grant. The extension is created first, so its functions keep their normal grants |
| `…_0002_enums.sql` | Enums |
| `…_0003_private_helpers.sql` | Only helpers that read no table: `ctx`, `uid`, `via`, `ctx_workspace_id`, `has_scope`, `require_scope`, the host checks, `cap_lock_key`, `reservation_ttl`, and the touch and append-only triggers (V8) |
| `…_0004_tenancy_billing_rules.sql` | Tenancy, billing mirror, `platform_rules` plus its seed |
| `…_0005_metering.sql` | Balances and ledger |
| `…_0006_brands_accounts_secrets.sql` | Brands, provider profiles, connected accounts, secrets, the external-resource guard |
| `…_0007_jobs_media_sources.sql` | Jobs, media, source media; adds the `brands.logo_asset_id` FK |
| `…_0008_transcripts_clips_voice.sql` | Transcripts, segments, clips, voice profiles |
| `…_0009_drafts_approvals_posts.sql` | Drafts, variants, revisions, approvals, posts, attempts |
| `…_0010_imports_analytics.sql` | Imported posts and metric snapshots |
| `…_0011_inbox_audit.sql` | Inbound events and audit |
| `…_0012_functions.sql` | The table-reading helpers of 3.14 (`user_workspace_ids`, `user_brand_ids`, `assert_brand_writable`, `current_period`, `release_subject_reservations`, …), then the SQL API functions (7.1) |
| `…_0013_rls_grants.sql` | First `REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA app, private FROM PUBLIC` (V1), then RLS policies and the per-role grants (6.3) |
| `…_0014_views.sql` | Views |

Merged migration files are immutable (MIG-21). A `LANGUAGE sql` function body is validated at `CREATE` time (`check_function_bodies` is on), so a SQL helper that reads a table must be created after that table; plpgsql bodies are resolved at run time. Every trigger function is plpgsql, so a trigger defined in 0004–0011 may call a helper that 0012 creates (V8).

## 3. Data model

### 3.1 Conventions

- **Schemas:** all tables live in `app`. Helper, trigger and internal functions live in `private`. `public` holds none of our objects. `tests` exists only in test runs.
- **Extensions:** `btree_gist`, for the `usage_balances` exclusion constraints (3.5). `pg_graphql` is dropped (6.5).
- **Keys:** `id uuid PK default gen_random_uuid()` unless stated otherwise (built-in; no pgcrypto needed). Hashes use the built-in `sha256(bytea)`.
- **Column macros:**
  - **[W]** = `workspace_id uuid NOT NULL → workspaces(id) ON DELETE CASCADE`.
  - **[B]** = `workspace_id uuid NOT NULL, brand_id uuid NOT NULL, FK (workspace_id, brand_id) → brands(workspace_id, id) ON DELETE CASCADE`, plus `UNIQUE (workspace_id, id)` and `UNIQUE (brand_id, id)` as composite FK targets. These make cross-tenant and cross-brand references impossible even with a guessed UUID.
  - References between brand-scoped rows carry `brand_id`, written `FK (brand_id, x_id) → t(brand_id, id)` (or `FK (brand_id, …)`), so no row can point into another brand (I5, C15). Workspace-level references are written `FK (workspace_id, x_id) → t(workspace_id, id)` (or `FK (workspace_id, …)`).
  - **[ts]** = `created_at, updated_at timestamptz NOT NULL default now()` plus the `private.touch_updated_at()` trigger. **[c]** = `created_at` only.
- **Notation:**
  - `?` means nullable; everything else is NOT NULL.
  - On text, `≤N` means `CHECK (char_length(col) <= N)`; a range such as `1–200` means `CHECK (char_length(col) BETWEEN 1 AND 200)`.
  - On jsonb, "obj ≤N KB" or "arr ≤N KB" means `CHECK (jsonb_typeof(col)='object'|'array' AND octet_length(col::text) <= N*1024)`.
  - `error_code?` is `text?` CHECK `~ '^[a-z0-9_]{1,64}$'`. `error_message?` is `text?` ≤2000, passed through `scrubSecrets` before it is written (6.7).
  - `ON DELETE SET NULL (col)` uses the Postgres 15+ column list, so the tenant column of a composite FK is never nulled.
  - Money is integer cents; durations are integers whose name carries the unit (`_ms`, `_seconds`).
  - jsonb payloads carry `schema_version` and are validated by a zod schema in `@app/shared` before they are written. The database checks only shape and size.
- **Actor columns** (`*_by_user_id`) are bare `uuid` with no FK, so history outlives user deletion. The only FK to `auth.users` is `workspaces.owner_user_id`.
- **Indexes:** every FK is backed by an index whose leading column is the FK's first column other than `workspace_id` and `brand_id`. The brand FK `(workspace_id, brand_id)` itself is backed by an index leading with `brand_id` or `workspace_id`; any other FK with no such column, by its first column (MIG-13). Indexes are listed below only when PK or UNIQUE constraints don't already cover them.
- **Append-only tables** (`variant_revisions`, `revision_media`, `approvals`, `usage_ledger`, `voice_profiles` content, `transcript_segments` after completion, `audit_events`) use `private.append_only()`:
  - A BEFORE UPDATE trigger raises `AP004`. The only updates allowed are `approvals.superseded_*` once, `voice_profiles.is_active` true → false, and, on `usage_ledger` reserve rows, an increase of `expires_at` and a single `resolved_at` (MIG-16).
  - A BEFORE DELETE trigger raises unless `pg_trigger_depth() > 1`, which allows deletes cascaded from a workspace or brand purge but not direct ones.
- **Timestamps:** all are `timestamptz` (MIG-17).
- **Tables** (exactly these 28; MIG-05):

| Group | Tables |
|---|---|
| Tenancy and billing (3.3) | `workspaces`, `workspace_billing`, `platform_rules` |
| Brands and accounts (3.4) | `brands`, `provider_profiles`, `connected_accounts`, `encrypted_secrets` |
| Metering (3.5) | `usage_balances`, `usage_ledger` |
| Jobs (3.6) | `jobs` |
| Media and clipping (3.7) | `media_assets`, `source_media`, `transcripts`, `transcript_segments`, `clips` |
| Voice (3.8) | `voice_profiles` |
| Content and approval (3.9) | `drafts`, `draft_variants`, `variant_revisions`, `revision_media`, `approvals` |
| Publishing (3.10) | `posts`, `post_attempts` |
| Imports and analytics (3.11) | `imported_posts`, `account_metric_snapshots`, `post_metric_snapshots` |
| Operations (3.12) | `inbound_events`, `audit_events` |

### 3.2 Enums

```
workspace_status        active | pending_deletion
brand_status            active | suspended | archived
posting_provider        upload_post                                   -- later: ADD VALUE 'x_direct', …
platform                tiktok | youtube | instagram | facebook | threads | x | linkedin | pinterest | bluesky
provider_profile_status pending | active | deleting | deleted
connection_status       connected | reauth_required | disconnected
via                     web | mcp | mcp_app | worker | system
approval_channel        web | mcp_app                                 -- deliberately no 'mcp'; decide_variants refuses
                                                                      -- mcp_app until step 4 enables it (I3, C23)
approval_decision       approved | rejected
subscription_status     trialing | active | past_due | unpaid | canceled | incomplete | incomplete_expired | paused
entitlement_status      active | grace | inactive
secret_purpose          cloud_drive_oauth | platform_oauth
secret_owner_kind       connected_account | cloud_drive_connection   -- owner table for the latter arrives in step 5
job_kind                media_verify | source_ingest | transcribe | clip_render | render_carousel | render_video |
                        import_past_posts | sync_accounts
job_status              queued | running | succeeded | partially_succeeded | failed | canceled
media_kind              video | image | audio | document | captions | transcript_words
media_purpose           clip_source | post_media | render_output | derived       -- picks the r2_key segment (C45)
media_origin            upload | cloud_drive | clip_render | carousel_render | video_render | thumbnail | transcode | transcription
media_status            pending_upload | verifying | ready | failed | deleted
source_origin           upload | cloud_drive_link
drive_provider          google_drive | dropbox | onedrive
source_status           pending | fetching | probing | ready | failed | deleted
transcription_engine    whisper_self_hosted | assemblyai
transcript_status       pending | running | completed | failed
clip_status             proposed | rendering | ready | failed | discarded
voice_source            manual | imported_posts | weekly_review | mcp
draft_origin            web | mcp | clip | render
draft_status            active | archived
variant_status          editing | pending_approval | approved | rejected
content_kind            text | image | carousel | video | document
x_link_handling         keep | strip
post_status             scheduled | held | publishing | submitted | published | inbox_fallback | unknown |
                        needs_attention | failed | skipped | canceled            -- 11 values, 121 pairs in CON-49
post_status_reason      cap_reached | rate_limited | reauth_required | account_disconnected | brand_inactive |
                        billing_inactive | provider_unavailable | provider_error | duplicate_content |
                        skipped_by_provider | in_tiktok_inbox | x_link_quota_exhausted | link_detection_mismatch |
                        content_hash_mismatch | media_integrity_failed | approval_revoked | user_canceled |
                        validation_failed | timeout | too_many_attempts
attempt_outcome         accepted | published | failed | retryable | rate_limited | cap_reached | duplicate | unknown
usage_meter             clip_seconds | render_seconds | x_link_posts
ledger_kind             period_open | grant | regrant | bonus | reserve | settle | release | expire | adjust
metric_window           day | rolling_30d | lifetime
metric_checkpoint       h1 | h24 | h48 | d7 | d30
inbound_source          upload_post | stripe
```

Each enum is mirrored as an `as const` array in `@app/shared/enums`, with a parity test (VAL-17). A new value is `ALTER TYPE … ADD VALUE` in a new migration.

Critic-round changes to the merged plan's enums:
- `job_kind`: `media_verify` is new and `source_ingest` replaces `fetch_source`, for the ingest jobs created by `complete_upload` and `register_source` (C4). `clip_render` replaces `make_clips` as the job that renders clips; it is one of the render jobs capped by 4.5 (C30) and failed by the terminal cascade (C3).
- `media_purpose` is new (C45). `media_status` gains `verifying` (C4).
- `usage_meter` gains `render_seconds` (C7, C30). Storage is not a ledger meter; it is a sum checked at insert (4.6).
- `post_status_reason` gains `too_many_attempts` (C38).

### 3.3 Tenancy, billing mirror, platform rules

**`workspaces`**: the tenant and billing unit, and the row that brand-limit, storage, in-flight render and entitlement changes lock (FOR NO KEY UPDATE; 4.9).
- `id`
- `owner_user_id uuid` → `auth.users(id)` **ON DELETE RESTRICT**. The step-8 deletion flow removes the workspace first, which also frees the Upload-Post profiles.
- `name text` default `'My workspace'`, CHECK `char_length(btrim(name)) BETWEEN 1 AND 80`
- `timezone text` default `'UTC'`. Trigger `private.assert_timezone`: the value must exist in `pg_timezone_names`.
- `status workspace_status` default `'active'`; `deletion_requested_at timestamptz?`. No step-1 function writes `pending_deletion`; only `postgres` can (`tests.purge_workspace` does, before purging). The step-8 deletion flow sets it and, in the same migration, makes the context helpers, `assert_brand_writable`, `sync_brand_profile` and `claim_post` refuse such a workspace, so new work can't race the purge (9; R8). The media delete guard keys its purge exception off this status (3.7; V30).
- `rights_attested_at timestamptz?`, `rights_attestation_version smallint?` (both set or both null): the standing "I only clip content I own or have rights to" attestation, given by the owner in the web app. Writable only through the ws/web UPDATE grant; a trigger stamps `now()`, requires the version to equal `RIGHTS_ATTESTATION_VERSION` (7.2), never allows clearing, and writes `workspace.rights_attested` to the audit log. `register_source` requires it for non-web callers (3.7; V32).
- [ts]
- UNIQUE `(owner_user_id)`: v1 has one workspace per user.
- CHECK `((status='pending_deletion') = (deletion_requested_at IS NOT NULL))`
- Created only by `app.ensure_workspace()`, which is idempotent and also inserts the `workspace_billing` row.
- Trigger: BEFORE DELETE `private.guard_external_resources` (3.4; C34).
- **Decision:** no `auth.users` trigger, because a failing trigger blocks signups [V]. No `profiles`, `workspace_members` or member roles in v1 (cost judge). Adding teams later means adding a members table and changing one helper, `private.user_workspace_ids()`.

**`workspace_billing`** (1:1 with the workspace): a flat mirror of exactly the Stripe facts we use, plus comps and the computed entitlements. Written only by `app.apply_entitlements` (plus the all-zero row inserted by `ensure_workspace`).
- `workspace_id uuid PK` → `workspaces ON DELETE CASCADE`
- **Stripe mirror:**
  - `stripe_customer_id text? UNIQUE`, CHECK `~ '^cus_[A-Za-z0-9]+$'`
  - `stripe_subscription_id text? UNIQUE`, CHECK `~ '^sub_[A-Za-z0-9]+$'`
  - `subscription_status subscription_status?`
  - `plan_lookup_key text?`, CHECK `~ '^[a-z][a-z0-9_]{2,63}$'`
  - `extra_brand_qty int` default 0, ≥0; `extra_clip_hour_qty int` default 0, ≥0
  - `period_start timestamptz?`, `period_end timestamptz?`, copied from the **base plan's subscription item**, since basil moved periods onto items [V]. CHECK both set or both null, and end > start.
  - `trial_end timestamptz?`, `cancel_at_period_end bool` default false, `livemode bool?`, `stripe_synced_at timestamptz?`
- **Comp** (lets steps 2–7 run before Stripe exists):
  - `comp_lookup_key text?` (same regex)
  - `comp_extra_brands`, `comp_extra_clip_hours`, `comp_x_link_posts` (int, default 0, ≥0)
  - `comp_expires_at?`: from then on `computeEntitlements` ignores the comp, and a comp-only workspace opens no new period (4.4; R10)
  - `comp_reason text?` (1–500), `comp_set_by text?` (1–100, `staff:<handle>`). `apply_entitlements` takes the setter from the system context's staff identity (7.4), never from a parameter (6.4 rule 2), and refuses to change comp values without one (`AP009`).
  - CHECK: any comp value set requires both `comp_reason` and `comp_set_by`.
  - Comp clip hours also raise the render allowance, which is always 3 × clip seconds (4.1, 4.5).
- **Computed** (written only by `app.apply_entitlements`, from `computeEntitlements`, 4.2):
  - `entitlement_status entitlement_status` default `'inactive'`
  - `brand_limit int` default 0, ≥0
  - `clip_seconds_per_period bigint` default 0, ≥0
  - `render_seconds_per_period bigint` default 0, ≥0 (C7)
  - `x_link_posts_per_period int` default 0, ≥0
  - `storage_bytes_limit bigint` default 0, ≥0 (C35; 4.6)
  - `ent_period_start?`, `ent_period_end?` (pair CHECK, end > start). For a comp-only workspace these hold the UTC month of the last apply and are not advanced; every rule that needs the current period (balances, the churn guard, `no_active_plan`) uses `private.current_period(ws)` instead (3.14; V16).
  - `entitlements_version int` default 0, `entitlements_computed_at?`
- `updated_at` plus the touch trigger.
- **Decision:** there are no Stripe customer, subscription, item or catalog tables. The cost judge grafted A's columns approach and the forward judge grafted item-level periods. One 1:1 row satisfies both. It is a separate row rather than columns on `workspaces` so that RLS can hide billing from MCP contexts.

**`platform_rules`**: reference data read by `app.claim_post` and `app.save_variant_revision`. Seeded by migration; parity with the code constant `PLATFORM_RULES` is tested (MIG-19). No runtime role can write it.
- `provider posting_provider`, `platform platform`; PK `(provider, platform)`
- `cap_max_posts int` > 0; `cap_max_video_posts int?` > 0; `cap_window_seconds int` default 86400, > 0
- `max_attempts smallint` default 25, CHECK 1–100: claims allowed per generation before the post becomes `failed/too_many_attempts` (C38)
- `supports_text`, `supports_image`, `supports_carousel`, `supports_video`, `supports_document` (bool)
- `min_carousel_items smallint?`, `max_carousel_items smallint?`. CHECK both are non-null exactly when `supports_carousel`, with `2 ≤ min ≤ max ≤ 35`.
- `requires_title bool` default false; `supports_first_comment bool`
- `source text` (1–500, a citation); `updated_at`
- Seed values (Upload-Post; effective caps are explained in 4.8):

  | platform | cap | video cap | text | image | carousel | video | doc | title req. | 1st comment |
  |---|---|---|---|---|---|---|---|---|---|
  | instagram | 50 [V] | – | no [V] | yes | 2–10 [V] | yes | no | no | yes [V] |
  | tiktok | 15 [V] | – | no [V] | yes | 2–35 [V native; U via Upload-Post] | yes | no | no | yes (needs `comments` capability) [V] |
  | youtube | 30 [V] | – | no [V] | no | – | yes | no | **yes** [V] | yes [V] |
  | facebook | 25 [V] | – | yes [V] | yes | 2–10 [U] | yes | no | no | yes [V] |
  | threads | 50 [V] | – | yes [V] | yes | 2–20 [V] | yes | no | no | yes [V] |
  | x | 20 (Professional) [V] | – | yes [V] | yes | 2–4 [V] | yes | no | no | yes [V] |
  | linkedin | 150 [V] | – | yes [V] | yes | 2–20 [V] | yes | **yes** [V] | no | yes [V] |
  | pinterest | 20 [V] | – | no [V] | yes | 2–5 [V\*] | yes [V\*] | no | no | no [V] |
  | bluesky | 100 (our ceiling) [U] | 25 [V] | yes [V] | yes | 2–4 [V] | yes | no | no | yes [V] |

  `max_attempts` is 25 for every platform (VAL-16).

### 3.4 Brands, provider profiles, connected accounts, secrets

**`brands`**
- `id`, `workspace_id` → `workspaces CASCADE`
- `name text`, CHECK `char_length(btrim(name)) BETWEEN 1 AND 80`
- `timezone text?` (null means use the workspace's; validated by `private.assert_timezone`)
- `status brand_status` default `'active'`
- `suspended_reason text?` CHECK IN (`plan_limit`, `billing`, `admin`); `suspended_at?`; `archived_at?`
- `style jsonb` default `'{}'`, obj ≤16 KB (zod `BrandStyleV1`; the brand kit for renders: colours, allowlisted font names and asset IDs only). CHECK `style::text !~* '(https?|file|data|javascript|ftp|blob):'`, so no font or background URL can make the step-7 headless renderer fetch anything (V24).
- `logo_asset_id uuid?`, FK `(id, logo_asset_id) → media_assets(brand_id, id) ON DELETE SET NULL (logo_asset_id)`, which pins the logo to this brand (V24). Added in migration 0007, after `media_assets` exists. A BEFORE INSERT/UPDATE trigger requires the asset to be `ready`, kind `image` and purpose `post_media` (`AP007`), so a failed, unverified or foreign-brand file can never reach the renderer as a logo.
- `created_by_user_id uuid?`; [ts]
- UNIQUE `(workspace_id, id)` (the target of every [B] FK)
- UNIQUE INDEX `(workspace_id, lower(btrim(name))) WHERE status <> 'archived'`
- CHECK `((status='suspended') = (suspended_reason IS NOT NULL AND suspended_at IS NOT NULL))`
- CHECK `((status='archived') = (archived_at IS NOT NULL))`
- INDEX `(workspace_id, status, created_at)`, `(logo_asset_id)` (MIG-13)
- **Triggers:**
  - `private.enforce_brand_limit`: BEFORE INSERT, and BEFORE UPDATE OF status when the row becomes `active` (section 4.3).
  - User writes are web-only: an INSERT or UPDATE from a user context with `via ≠ 'web'` raises `AP009` (C35). The system context (inside `apply_entitlements`) may change `status` and `suspended_reason` only. Users never write `suspended_reason`, `suspended_at` or `archived_at` (none is in a grant).
  - Status transition rules. A user may move active→archived, archived→active and suspended(`plan_limit`)→active. Only the system may suspend (active→suspended) or reactivate automatically (suspended→active). Anything else raises `AP004`.
  - Status stamps (V4), in the same BEFORE trigger, so the consistency CHECKs below always hold: entering `archived` sets `archived_at = now()` and leaving it clears it; entering `suspended` sets `suspended_at = now()` and requires `suspended_reason` (`AP004` otherwise); leaving `suspended` clears both.
  - `workspace_id` cannot change.
  - Timezone check.
  - `private.sync_brand_profile` (AFTER INSERT, AFTER UPDATE OF status; C31): when the brand becomes active it ensures a usable provider profile, creating a pending one if the brand has none in `pending` or `active` (so reactivating a brand whose profile is `deleting` or `deleted` gets a new profile and ref); when the brand is archived it schedules profile deletion after 7 days, and when it is suspended, after 30 days (Q10); reactivation clears a pending deletion.
  - Status changes are written to the audit log (`brand.created`, `brand.status_changed`).

**`provider_profiles`**: one Upload-Post user profile per brand [V].
- `id`, [B]
- `provider posting_provider` default `'upload_post'`
- `provider_profile_ref text` default `('b_' || replace(gen_random_uuid()::text,'-',''))`, CHECK `~ '^b_[0-9a-f]{32}$'`. Upload-Post usernames allow `[A-Za-z0-9_@-]` and can't be changed [V], so the ref is opaque and never derived from user data. It is the name we send to Upload-Post, so it reveals nothing about the tenant.
- `status provider_profile_status` default `'pending'`. The step-2 worker creates the profile at Upload-Post and moves it to `active`. Transitions: pending → active or deleting; active → deleting; deleting → deleted; anything else raises `AP004`. When a profile enters `deleting`, a definer AFTER UPDATE trigger sets all its live `connected_accounts` to `disconnected` with `status_reason = 'profile_deleted'` (audited), so no post can be claimed through a deleted profile and a later profile of the same brand can connect the same identity (V5). Their posts are held at their next claim (4.8).
- `delete_after timestamptz?`: set by `sync_brand_profile` (archived + 7 days, suspended + 30 days), cleared on reactivation (C31, Q10)
- `deleted_at?`; [ts]
- UNIQUE `(provider, provider_profile_ref)`: a ref is never reused, even after deletion.
- UNIQUE `(brand_id, provider) WHERE status IN ('pending','active')` (`pp_one_active_per_brand`): one usable profile per brand. A `deleting` profile may coexist with its replacement, so a reactivation never waits on Upload-Post (C31).
- UNIQUE `(brand_id, id, provider)` (FK target)
- CHECK `((status='deleted') = (deleted_at IS NOT NULL))`
- INDEX `(workspace_id, created_at)`, not partial, because the churn guard's per-period count must include `deleted` profiles (4.3; V15); `(delete_after) WHERE delete_after IS NOT NULL AND status IN ('pending','active')` (deletion sweep)
- Trigger: provider, ref, brand and workspace can't change. Rows are inserted only by `sync_brand_profile`; the worker updates `status` and `deleted_at`.
- **Decision:** this is a separate table (forward judge) rather than a ref on `brands` (cost judge). The tie is broken by a real need: deleting the profile of a long-suspended or archived brand to free the slot (Q10), then reactivating it, requires a new immutable ref.

**`connected_accounts`**: written only from data Upload-Post has verified. Users never insert them, because a forged `provider_account_id` could squat another person's account.
- `id`, [B]
- `provider_profile_id uuid`, `provider posting_provider`; FK `(brand_id, provider_profile_id, provider) → provider_profiles(brand_id, id, provider) ON DELETE CASCADE`
- `platform platform`
- `provider_account_id text` 1–256: the stable platform ID (TikTok open_id, Instagram user ID, YouTube channel ID) [V], as reported by Upload-Post
- `handle text?` ≤256, `display_name text?` ≤256, `avatar_url text?` CHECK `~ '^https://'` ≤2048
- `capabilities jsonb` default `'[]'`, arr ≤16 KB: an open-ended list [V] (for example TikTok's `comments`), including the Pages, organisations and boards this login can post to. `save_variant_revision` checks a revision's destination against it (C1); the cap is 16 KB rather than the merged plan's 4 KB so those lists fit.
- `platform_settings jsonb` default `'{}'`, obj ≤16 KB: cached TikTok creator info such as privacy levels and `max_video_post_duration_sec` [V]
- `destination jsonb` default `'{}'`, obj ≤4 KB (zod `DestinationV1`): Facebook `page_id`, LinkedIn organization URN, Pinterest board and section [V]. This is **only the default** that `save_variant_revision` copies into new revisions; publishing always uses the revision's copy (C1).
- `credential_secret_id uuid?`, FK `(workspace_id, credential_secret_id) → encrypted_secrets(workspace_id, id) ON DELETE SET NULL (credential_secret_id)`
- `status connection_status` default `'connected'`; `status_reason text?` ≤200
- `connected_at` default now(); `disconnected_at?`; `last_synced_at?`; `last_metrics_pulled_at?`; `import_cursor text?` ≤1000
- [ts]
- UNIQUE `(workspace_id, id)`, `(brand_id, id)`, `(brand_id, id, platform)`, `(brand_id, id, platform, provider)` (FK targets)
- UNIQUE `(brand_id, platform) WHERE status <> 'disconnected'` (`ca_one_live_per_brand_platform`; Q9)
- UNIQUE `(provider_profile_id, platform) WHERE status <> 'disconnected'`: one account per platform per profile [V]
- UNIQUE `(workspace_id, provider, platform, provider_account_id) WHERE status <> 'disconnected'`: a real account is live in at most one brand of a workspace. Other workspaces may connect it too, and platform caps are shared by identity (4.8). This replaces the merged plan's global uniqueness, which let whoever connected an account first block its real owner (C48).
- UNIQUE `(provider_profile_id, platform, provider_account_id)`: one row per identity per profile, so a reconnect reactivates the existing row instead of creating a new one (C5)
- CHECK `(provider <> 'upload_post' OR credential_secret_id IS NULL)`: Upload-Post holds the platform tokens [V]
- CHECK `((status='disconnected') = (disconnected_at IS NOT NULL))`
- INDEX `(provider_profile_id)`, `(credential_secret_id)`, `(brand_id, platform)`
- Trigger: provider, platform, `provider_account_id`, profile, brand and workspace can't change. Connecting a *different* account creates a new row, so approved posts can't silently go to another real account. Status changes are audited.
- **Writes.** There is no user INSERT. `app.upsert_connected_accounts` (worker) applies a provider snapshot for an `active` profile (V5):
  1. First, rows of this profile missing from the snapshot become `reauth_required` or `disconnected`, as the provider reports.
  2. Then, for each account in the snapshot, before inserting or reactivating, disconnect every **other** live row that would collide: one on the same (brand, platform) with a different identity (`identity_changed`), one with the same identity on an older profile of the same brand (`profile_replaced`), and one with the same identity in another brand of this workspace (`account_moved`). This general rule covers every ordering, so the partial unique indexes can't be hit.
  3. Same profile, platform and identity: update handle, name, avatar and capabilities. If the row was disconnected or needed re-auth, reactivate it and re-arm its held future posts (the `release_holds` rule, 4.8).
  4. Otherwise insert a new row.
- `app.set_account_status` (worker) applies a provider signal for one account, such as a disconnect webhook: it may set only `reauth_required` or `disconnected`, with `status_reason`. A return to `connected` happens only through `upsert_connected_accounts`, from a verified snapshot. Posts of the account are held at their next claim (4.8).
- The only user UPDATE is `destination`: web-only, needs `accounts:connect`, and is audited as `account.destination_changed` (C1).

**`encrypted_secrets`**: the generic store for tokens we must hold. **There are no rows in v1.** The first writer is step 5, and only if cloud-drive OAuth pickers are used.
- `id uuid PK`, generated in TypeScript before encryption so it can be bound into the AAD (6.6)
- [W]
- `purpose secret_purpose`; `owner_kind secret_owner_kind`; `owner_id uuid`
- `alg text` CHECK `= 'A256GCM+RSA-OAEP-256'`; `key_version int` > 0
- `wrapped_dek bytea` CHECK `octet_length BETWEEN 256 AND 1024`
- `iv bytea` (length = 12); `ciphertext bytea` (1–32,768 bytes); `auth_tag bytea` (length = 16)
- `granted_scopes text[]` default `'{}'`, cardinality ≤32
- `expires_at?`, [c], `rotated_at?`, `last_used_at?`
- UNIQUE `(workspace_id, id)`; UNIQUE `(owner_kind, owner_id, purpose)`
- INDEX `(key_version)`
- Trigger: workspace, purpose, `owner_kind` and `owner_id` can't change. For `owner_kind='connected_account'`, the owner must exist in the same workspace. Inserts and rewraps are audited (`secret.stored`, `secret.rewrapped`).
- `app_user` has no privileges on this table at all; only workers insert (C35).

**External-resource guard** (C34). `private.guard_external_resources` runs BEFORE DELETE on `workspaces` and `brands`. It raises `AP004 external_resources_live` while any `provider_profiles` row in scope isn't `deleted`, or any `media_assets` row in scope is `verifying`, `ready` or `failed` (their R2 objects still exist). The step-8 purge deletes the Upload-Post profiles and R2 objects first and records that, then deletes the rows. Any other delete path fails loudly instead of orphaning platform tokens and files.

### 3.5 Metering

**`usage_balances`**: one row per workspace, meter and billing period, plus global pool rows (`workspace_id NULL`).
- `id bigint GENERATED ALWAYS AS IDENTITY PK`
- `workspace_id uuid?` → `workspaces CASCADE`
- `pool_key text?`, CHECK `~ '^[a-z_]+:[a-z_]+$'` (e.g. `upload_post:x_links`)
- CHECK `((workspace_id IS NULL) = (pool_key IS NOT NULL))`
- `meter usage_meter`
- `period_start`, `period_end` (timestamptz), CHECK `period_end >= period_start`; equal only for a balance voided by `apply_entitlements` (an empty range overlaps nothing; 4.2, V3). `period_start` is immutable and `period_end` may only move earlier.
- `granted bigint` ≥0; `bonus bigint` default 0, ≥0; `safety_margin bigint` default 0, ≥0
- `granted_target_hwm bigint` default 0, ≥0: the highest entitlement target already granted in this period; mid-period increases grant only the part above it (C33, 4.4)
- `reserved bigint` default 0, ≥0; `consumed bigint` default 0, ≥0
- CHECK `(reserved + consumed <= granted + bonus)`
- `updated_at` plus the touch trigger
- UNIQUE NULLS NOT DISTINCT `(workspace_id, pool_key, meter, period_start)` (Postgres 15+)
- EXCLUDE USING gist `(workspace_id WITH =, meter WITH =, tstzrange(period_start, period_end) WITH &&) WHERE (workspace_id IS NOT NULL)`, and the same on `pool_key` for pool rows: no overlapping periods for the same (workspace or pool, meter)
- INDEX `(workspace_id, meter, period_start DESC)`; INDEX `(pool_key, meter, period_start DESC) WHERE pool_key IS NOT NULL`
- **Trigger:** BEFORE UPDATE: `granted` and `granted_target_hwm` never decrease, for any caller, including definer functions. There is no bypass flag: a custom setting such as `app.adjusting` can be set by any role with `set_config`, so it would guard nothing (V17). Corrections go through `consumed` (`app.meter_adjust`) or, for a pool, a higher `safety_margin`.
- No runtime role has any privilege beyond SELECT; every change goes through the metering functions.
- **Decision:** global rows here rather than a separate `provider_pools` table (cost judge), keeping the security judge's safety margin. The merged plan replaced the EXCLUDE constraint with an overlap trigger (cost judge), which relied on callers locking the `workspaces` row. `private.ensure_current_balance` now creates balances without that lock (C44), and only a constraint catches overlapping inserts from concurrent transactions, so the EXCLUDE constraint (`btree_gist`) is back. `INSERT … ON CONFLICT DO NOTHING` absorbs both the unique and the exclusion conflict (4.4). An absorbed insert is then re-read: if no balance exists for the expected `period_start`, `ensure_current_balance` raises `AP017` (`detail.reason = 'period_overlap'`, which the DAL logs as an alert) instead of continuing silently. Overlaps are prevented upstream, because `apply_entitlements` closes the old period before it opens a new one (4.2; V3).

**`usage_ledger`**: the append-only audit trail. A reservation *is* its `reserve` row, and a balance always equals the fold of its rows (MET-18).
- `id bigint IDENTITY PK`
- `balance_id bigint` → `usage_balances(id) ON DELETE CASCADE`
- `workspace_id uuid?` → `workspaces CASCADE` (NULL for pool rows). A trigger copies `workspace_id`, `meter` and `period_start` from the balance.
- `meter usage_meter`, `period_start timestamptz`; `kind ledger_kind`
- `delta_granted`, `delta_bonus`, `delta_reserved`, `delta_consumed` (bigint, default 0)
- `idempotency_key text? UNIQUE` (1–200). CHECK it is not null unless kind ∈ (settle, release, expire); those are kept idempotent by the unique `reservation_id` below.
- `reservation_id bigint?` → `usage_ledger(id) ON DELETE CASCADE`. CHECK `((kind IN ('settle','release','expire')) = (reservation_id IS NOT NULL))`.
- `expires_at timestamptz?`, CHECK `((kind='reserve') = (expires_at IS NOT NULL))`
- `resolved_at timestamptz?`, CHECK `(kind = 'reserve' OR resolved_at IS NULL)`: set once, by the resolution, so the reconciler can find unresolved reservations (C3, C27)
- `subject_type text?` CHECK IN (`source_media`, `transcript`, `clip`, `job`, `post`, `manual`); `subject_id uuid?`. The merged plan called these `ref_type`/`ref_id`; they are renamed to the names 3.10 and 4.4–4.5 use, and `clip` and `job` carry render reservations (C7, C30).
- `actor text` 1–100 (`system`, `stripe`, `user:<uuid>`, `worker:clipper`, `staff:<handle>`), always derived from `private.ctx()`, never from a parameter (R10); `note text?` ≤500; [c]
- **Sign CHECKs:**
  - reserve: `delta_reserved > 0`, others 0
  - settle: `delta_reserved < 0` and `0 ≤ delta_consumed ≤ -delta_reserved`
  - release / expire: `delta_reserved < 0`, `delta_consumed = 0`
  - period_open / grant / regrant: `delta_granted ≥ 0`
  - bonus: `delta_bonus > 0`
  - adjust: unrestricted
- UNIQUE `(workspace_id, id)` (FK target)
- UNIQUE `(reservation_id) WHERE reservation_id IS NOT NULL`: a reservation can have at most one resolution, so a settle and a release can never both apply.
- INDEX `(balance_id, created_at)`, `(expires_at) WHERE kind='reserve' AND resolved_at IS NULL` (the reconciler, 4.4), `(subject_type, subject_id)`
- Append-only, with two exceptions on `reserve` rows: `expires_at` may only increase while the reservation is unresolved (`app.meter_extend`), and `resolved_at` is set once, by the resolution (C3, C27).
- Referencing columns carry a trigger `private.assert_reservation()` with a rule per column (V2). In every case the row must be `kind='reserve'`:
  - `transcripts.reservation_id`: meter `clip_seconds`, same workspace;
  - `jobs.reservation_id` and `clips.render_reservation_id`: meter `render_seconds`, same workspace;
  - `posts.x_link_reservation_id`: meter `x_link_posts`, same workspace;
  - `posts.x_link_pool_reservation_id`: meter `x_link_posts`, on a balance with `workspace_id IS NULL AND pool_key = 'upload_post:x_links'`, with subject `('post', NEW.id)`. A pool row has no workspace, so the same-workspace rule can't apply to it.

### 3.6 Jobs

**`jobs`**: user-visible units of work and the outbox. Each row is created in the same transaction as the state change that needs it; pg-boss (step 2) only executes them.
- `id`, [B]
- `parent_job_id uuid?`, FK `(workspace_id, parent_job_id) → jobs(workspace_id, id) ON DELETE CASCADE`
- `kind job_kind`, `status job_status` default `'queued'`, `progress smallint` default 0, CHECK 0–100
- `input jsonb`: obj ≤64 KB, CHECK `input ? 'schema_version'` (`JobInputEnvelope`). Holds validated parameters only, never raw tool input, prompts, conversation text or drive share URLs (C41). Every media asset a job reads is listed in `input->'asset_ids'` (a uuid array, ≤50, CHECKed as an array); render inputs reference media only through it and have no URL-valued fields (V23).
- `input_hash bytea` (length 32). A trigger sets it to `sha256(convert_to(kind || ':' || input::text, 'UTF8'))`.
- `result jsonb?` ≤256 KB; `error_code?`; `error_message?` (scrubbed)
- `idempotency_key text?` 1–200
- `reservation_id bigint?`, FK `(workspace_id, reservation_id) → usage_ledger(workspace_id, id)`: the render reservation of `render_carousel` and `render_video` jobs (4.5; C30)
- `attempts int` default 0, 0–100; `queue_job_id text?` ≤64
- `processed_seconds bigint` default 0, ≥0: worker-written with each heartbeat (seconds of audio already fed to the engine for `transcribe`); it may only increase. A user cancel of a running transcription settles this much (4.4; V20).
- `requested_by_user_id uuid?`, `requested_via via`, `oauth_client_id text?` ≤512 (renamed from `mcp_client_id`; C20). The creating function sets them from `private.ctx()`; a job created inside a worker function (the fallback `transcribe` job of `fail_transcript`) records `worker`.
- [ts], `started_at?`, `finished_at?`, `heartbeat_at?`
- UNIQUE `(brand_id, kind, idempotency_key)`: per brand, so one brand-scoped client can't collide with, probe or receive another brand's jobs. On conflict `create_job` returns the existing job only if its `input_hash` matches, and raises `AP012` otherwise (V29).
- UNIQUE `(brand_id, kind, input_hash) WHERE status IN ('queued','running')`: duplicate AI tool calls dedupe
- CHECK `(status NOT IN ('succeeded','partially_succeeded','failed','canceled') OR finished_at IS NOT NULL)`
- INDEX `(workspace_id, brand_id, created_at DESC)`, `(parent_job_id)`, `(status, heartbeat_at) WHERE status='running'`, `(reservation_id)`, `(created_at) WHERE status = 'queued'` (stale sweep; C3), `(workspace_id, kind) WHERE status IN ('queued','running')` (in-flight render cap; C30; counted only under the `workspaces` row lock, V14)
- State machine trigger:
  - queued → running, canceled or failed
  - running → succeeded, partially_succeeded, failed, canceled, or queued (a retry; `attempts + 1`)
  - everything else is terminal
- **Terminal cascade** (C3, V6, V20). AFTER UPDATE to `failed` or `canceled`, the definer trigger `private.on_job_terminal` fails the job's live subjects and resolves their metering. `failed` (a worker or engine failure, a stale heartbeat, a queue timeout) is our fault and **releases** (Q2). `canceled` from `queued` releases too, since nothing ran. `canceled` from `running` was the user's choice after compute was spent, and **settles** what was processed; otherwise a user could cancel just before completion, repeat, and get unbounded transcription or rendering for free:
  - `transcribe`: its `pending` or `running` transcripts become `failed` (`job_failed` or `job_canceled`). The reservation is found through `transcripts.reservation_id`, not the ledger subject, because fallback attempts share it. It is resolved only if no other transcript with that `reservation_id` is `pending` or `running`: released, or, for a cancel while running, settled at `least(reserved, jobs.processed_seconds)`.
  - `clip_render`: on `failed`, its `proposed` or `rendering` clips become `failed`, which releases their render reservations. On `canceled`, they become `discarded` instead, so the clip trigger releases the `proposed` ones and settles the `rendering` ones in full (3.7).
  - `media_verify`, `source_ingest`: the asset becomes `failed`; linked sources in `pending`, `fetching` or `probing` become `failed` (which also clears `origin_url`; 3.7, V7).
  - `render_carousel`, `render_video`: the job's reservation is released, or, for a cancel while running, settled in full (≤180 s of output).
  - Nothing cascades on `succeeded` or `partially_succeeded`; the completion functions (and, for clips that failed individually, the clip trigger) have already resolved everything.
- **Stale jobs:** `app.fail_stale_jobs` (system) fails running jobs whose heartbeat is older than a threshold (`heartbeat_lost`) and queued jobs older than another (`queue_timeout`). The cascade above then runs. Step 2 schedules it every 5 minutes with 15 minutes and 24 hours.
- **Who creates jobs** (7.1): `register_source` (`source_ingest`), `complete_upload` (`media_verify`), `request_transcription` and `fail_transcript` (`transcribe`), `request_clips` (`clip_render`), and `create_job` (`render_*`, `import_past_posts`, `sync_accounts`). Workers have no INSERT grant on `jobs`.
- **Scope by kind** (used by `cancel_job` and `create_job`; V18): `transcribe`, `clip_render`, `source_ingest` → `clips:write`; `media_verify` → `drafts:write` or `clips:write`; `render_carousel`, `render_video` → `drafts:write`; `import_past_posts` → `voice:write`; `sync_accounts` → `accounts:connect`.

### 3.7 Media, sources, transcripts and clips

**`media_assets`**: every R2 object. Bytes never go into Postgres.
- `id`, [B]
- `kind media_kind`, `purpose media_purpose` (C45), `origin media_origin` (there is **no URL origin**), `status media_status` default `'pending_upload'`
- `filename text`, CHECK `~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'` and `position('..' in filename) = 0` (no slash, no leading dot and no `..`, so no path segments can escape the key; CON-18)
- `mime_type text`, CHECKed against an explicit allowlist per kind. There are no prefix wildcards (R1):
  - video → `video/mp4`, `video/quicktime`, `video/webm`, `video/x-matroska` (the last two never as `post_media`; see below)
  - image → `image/jpeg`, `image/png`, `image/webp`, `image/gif`. Never `image/svg+xml`: the step-7 headless-browser renderer loads logos and post images, and an SVG can run script or fetch `http://169.254.169.254/…` and `file:` URLs.
  - audio → `audio/mpeg`, `audio/wav`, `audio/mp4`
  - document → `application/pdf`, captions → `text/vtt`, transcript_words → `application/json`
  - Purpose narrows the list: `post_media` allows only the image types, `video/mp4`, `video/quicktime`, `application/pdf` and `text/vtt` (what the platforms accept), and `clip_source` only kinds video and audio. `save_variant_revision` applies the `post_media` list to every attached asset, whatever its purpose, so a WebM, MKV or audio clip source can't reach a platform through a revision (V11).
  - The same lists are exported as `ALLOWED_MIME` from `@app/shared` (7.2; parity in VAL-20). The step-5 verify worker compares magic bytes and ffprobe's `format_name` with the declared type (9).
- `declared_bytes bigint?` > 0. Required for origins `upload` and `cloud_drive`. At most 10 GiB for video and audio (Q13), 50 MB for images, 100 MB for documents.
- `upload_id text?` ≤1024: the R2 multipart upload ID, used above 100 MB (a single R2 PUT is limited to about 5 GB [V\*]; C12)
- `upload_key text GENERATED ALWAYS AS (CASE WHEN origin = 'upload' THEN 'stg/' || workspace_id || '/' || id END) STORED`: the key in the **staging bucket** that presigned PUTs target
- `r2_key text GENERATED ALWAYS AS ('ws/' || workspace_id || '/b/' || brand_id || '/' || <seg> || '/' || id || '/' || filename) STORED UNIQUE`, where `<seg>` is `src` (clip_source), `med` (post_media), `out` (render_output) or `drv` (derived). The key is computed by the server, can't be supplied, and embeds the asset's own ID; deleting a brand or workspace in R2 is one prefix delete per bucket. It lives in the **media bucket**, which only Railway workers can write, so no presigned URL can ever overwrite a verified object (C26, C45).
- `bytes bigint?` 1–10,737,418,240; `sha256 bytea?` (length 32); `width int?`, `height int?` (1–16,384), CHECK `width::bigint * height <= 50000000` (50 MP, so a few-KB decompression bomb can't become `ready`); `duration_ms int?` 1–43,200,000 (the same 12 h ceiling as `source_media`). All are measured by the worker on the immutable copy; duration by decoding packet timestamps, never read from container headers (C26); dimensions from the header before any full decode (R1).
- `produced_by_job_id uuid?`, FK `(workspace_id, …) → jobs ON DELETE SET NULL (produced_by_job_id)`
- `derived_from_asset_id uuid?`, FK `(workspace_id, …) → media_assets ON DELETE SET NULL (derived_from_asset_id)`
- `created_by_user_id uuid?`; [ts]; `ready_at?`; `deleted_at?`
- **Checks:**
  - `status <> 'ready' OR (bytes IS NOT NULL AND sha256 IS NOT NULL AND ready_at IS NOT NULL)`
  - `status <> 'ready' OR kind NOT IN ('video','audio') OR duration_ms IS NOT NULL`
  - `(status = 'deleted') = (deleted_at IS NOT NULL)`
  - `origin NOT IN ('upload','cloud_drive') OR declared_bytes IS NOT NULL`
  - `declared_bytes IS NULL OR bytes IS NULL OR bytes <= declared_bytes`
  - `upload_id IS NULL OR origin = 'upload'`
  - Purpose and origin agree: `upload` gives `clip_source` or `post_media`; `cloud_drive` is always `clip_source`; `clip_render`, `carousel_render`, `video_render` and `thumbnail` give `render_output`; `transcode` and `transcription` give `derived`.
- INDEX `(workspace_id, brand_id, created_at DESC)`, `(produced_by_job_id)`, `(derived_from_asset_id)`, `(brand_id, sha256) WHERE sha256 IS NOT NULL`, `(workspace_id) WHERE status IN ('pending_upload','verifying','ready','failed') AND origin IN ('upload','cloud_drive')` (storage sum; C35, V21), `(status, updated_at) WHERE status IN ('pending_upload','verifying')` (sweep of abandoned uploads, which otherwise hold storage and the 20-pending cap; C35)
- **Triggers:**
  - User inserts: origin is forced to `upload` and status to `pending_upload` (neither column is in the INSERT grant); purpose must be `clip_source` or `post_media`; the caller needs `drafts:write` or `clips:write` (C35); the brand must be writable (`AP010`; C18).
  - Storage quota (4.6), BEFORE INSERT for origins `upload` and `cloud_drive`.
  - Generated keys can't be supplied. Identity columns, kind, purpose, origin and `filename` can't change. `bytes`, `sha256`, `width`, `height` and `duration_ms` can't change once the asset is `ready`. This binds the approved bytes.
  - State machine: pending_upload → verifying, ready or failed; verifying → ready or failed; ready → deleted; failed → deleted. An `upload` reaches `ready` only through `verifying`, which only `complete_upload` enters (C4, C26); worker-written origins may go straight to `ready`.
  - An asset referenced by `revision_media`, by a source in `pending`, `fetching`, `probing` or `ready`, by a clip that isn't discarded, or by a brand's `logo_asset_id` can't move to `deleted` (V21, V24). The only exception is the purge of a whole workspace, recognised by data no runtime role can forge: the asset's workspace has `status = 'pending_deletion'`, which only `postgres` (and from step 8 the web-only deletion request) can set. `current_user = 'postgres'` is not used, because every definer function and definer trigger runs as `postgres` (V30).
  - AFTER UPDATE to `failed` (a definer trigger): sources linked to the asset in `pending`, `fetching` or `probing` become `failed` with the same `error_code`, so a failed verify can't leave a source `probing` forever (V13).
- **Upload flow:** `createUploadAsset` (user INSERT) → the app presigns PUTs, or multipart parts, for `upload_key`, each signing its `Content-Length` (the whole `declared_bytes`, or each part's length) → `app.complete_upload(asset)` moves the asset to `verifying` and creates a `media_verify` job in the same transaction (C4) → the worker HEADs the staging object and fails the asset without copying if it is larger than `declared_bytes`, sniffs magic bytes with a ranged GET, then copies the object to `r2_key` in the media bucket, hashes and probes the copy, and marks the asset ready. On any verify failure it deletes the media-bucket copy and moves the asset failed → deleted in the same step (V21). A `failed` asset counts toward storage until it is `deleted` (4.6). The staging bucket's lifecycle rule deletes objects and aborts incomplete multipart uploads after 1 day (step 5).

**`source_media`**: long videos the user owns, to be clipped.
- `id`, [B]
- `media_asset_id uuid?`, FK `(brand_id, media_asset_id) → media_assets(brand_id, id)` NO ACTION. Set at registration for uploads, and by the fetcher for drive links.
- `origin source_origin`; `drive_provider drive_provider?`
- `origin_url text?` ≤2048: the normalized share URL. **We store the URL** (forward judge), so the fetch and its retries don't depend on `jobs.input`. It isn't readable by `app_user` or by the media workers (column grants), is never copied into `jobs.input` or logs, and is NULL whenever the source is not `pending` or `fetching` (C41, V7): a CHECK enforces it, and the state-machine trigger sets `NEW.origin_url := NULL` on every other status, so every writer complies, including the definer job cascade.
- `origin_host text?`; `title text?` ≤300
- `job_id uuid?`, FK `(workspace_id, …) → jobs ON DELETE SET NULL (job_id)`: the ingest or verify job (C4)
- `ownership_attested_at timestamptz`; `attested_by_user_id uuid` (the trigger forces this to `private.uid()` on user insert); `attested_via via` (forced from `private.via()`, so a model-supplied attestation is recorded as such; V32)
- `duration_ms int?`, 1–43,200,000, copied from the asset. 12 h is a coarse DB ceiling; the product limit of 4 h is app config (`UPLOAD_LIMITS.maxSourceDurationMs`; Q13).
- `probe jsonb?`, obj ≤8 KB (sanitized ffprobe summary: codecs, frame rate, dimensions, audio streams)
- `status source_status` default `'pending'`; `error_code?`; `error_message?`
- [ts]; `deleted_at?`
- **Own-content CHECKs:**
  - `(origin = 'upload') = (origin_host IS NULL AND drive_provider IS NULL)`
  - `origin <> 'cloud_drive_link' OR (origin_host IS NOT NULL AND drive_provider IS NOT NULL)`
  - `origin = 'cloud_drive_link' OR origin_url IS NULL`
  - `origin <> 'cloud_drive_link' OR status NOT IN ('pending','fetching') OR origin_url IS NOT NULL`
  - `origin_url IS NULL OR status IN ('pending','fetching')` (V7)
  - `origin_url IS NULL OR origin_url ~ '^https://[a-z0-9.-]+(/|\?|#|$)'`. The URL must be normalized: lowercase host, `https` only, no userinfo, no port. This closes C's `https://drive.google.com@youtube.com/…` hole.
  - `origin_url IS NULL OR origin_host = substring(origin_url FROM '^https://([a-z0-9.-]+)')`
  - `origin_host IS NULL OR NOT private.is_youtube_host(origin_host)`
  - `origin_host IS NULL OR private.is_allowed_drive_host(drive_provider, origin_host)`
  - `status <> 'ready' OR (media_asset_id IS NOT NULL AND duration_ms IS NOT NULL)`
  - `(status = 'deleted') = (deleted_at IS NOT NULL)`
- INDEX `(workspace_id, brand_id, created_at DESC)`, `(media_asset_id)`, `(job_id)`
- **Created only by `app.register_source`** (C4), which:
  - requires `clips:write`, a writable brand (`AP010`) and `p_attest = true` (`AP007`);
  - when `via ≠ 'web'` (an AI client set `p_attest`), also requires the workspace's standing web attestation (`rights_attested_at` at the current `RIGHTS_ATTESTATION_VERSION`), and raises `AP009` otherwise, so the own-content evidence always rests on a human action in the web app (Q17; V32);
  - for uploads, requires an asset of purpose `clip_source` and kind video or audio in the same brand, and raises `AP013` if it is `failed` or `deleted` (V13). The source starts as `pending`, `probing` or `ready` to match the asset's status;
  - for drive links, stores the URL, host and provider (the CHECKs re-validate them), checks storage headroom, and creates the `source_ingest` job in the same transaction;
  - writes `source.attested` to the audit log.
- **Triggers:**
  - The referenced asset must be of kind `video` or `audio`, purpose `clip_source`, origin `upload` or `cloud_drive`. Renders can never become sources.
  - `attested_by_user_id` is forced to the caller, and `ownership_attested_at` to `now()`. Both are immutable.
  - `origin_url` may only change to NULL, and is forced to NULL whenever the new status is not `pending` or `fetching` (V7).
  - State machine:
    - pending → fetching, probing or failed
    - fetching → probing or failed
    - probing → ready or failed
    - ready → deleted
    - failed → deleted
  - `complete_upload` moves linked `pending` sources to `probing`; the verify worker marks them `ready` with the asset's measured duration.

**`transcripts`**: one row per engine attempt. Clipping is charged once per content, per brand.
- `id`, [B]
- `source_media_id uuid`, FK `(brand_id, source_media_id) → source_media(brand_id, id) ON DELETE CASCADE`
- `content_sha256 bytea` (32 bytes), copied from the source's media asset
- `engine transcription_engine`; `engine_model text` ≤100
- `status transcript_status` default `'pending'`
- `is_reuse bool` default false, immutable (C2)
- `language text?` CHECK `~ '^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$'`
- `duration_ms int?`, `segment_count int?`
- `words_asset_id uuid?`, FK `(brand_id, …) → media_assets ON DELETE SET NULL (words_asset_id)`. Word-level JSON lives in R2 (kind `transcript_words`, purpose `derived`), for burned-in captions.
- `reservation_id bigint`, FK `(workspace_id, reservation_id) → usage_ledger(workspace_id, id)`
- `reused_from_transcript_id uuid?`, FK `(brand_id, …) → transcripts(brand_id, id) ON DELETE SET NULL (reused_from_transcript_id)`: lineage only
- `job_id uuid?`, FK `(workspace_id, …) → jobs ON DELETE SET NULL (job_id)`
- `error_code?`, `error_message?`
- [ts], `completed_at?`
- UNIQUE `(source_media_id, id)`: the target for the clips FK
- UNIQUE `(source_media_id) WHERE status <> 'failed'`: one live transcript per source. A fallback engine is allowed after a failure.
- UNIQUE `(brand_id, content_sha256) WHERE status <> 'failed' AND NOT is_reuse`: at most one *original* transcript per content per brand. `is_reuse` is immutable, so deleting an original (which nulls `reused_from_transcript_id`) can't turn reuse rows into competing originals and break a purge (C2, C37).
- INDEX `(brand_id, content_sha256) WHERE status = 'completed'`, `(reservation_id)`, `(job_id)`, `(reused_from_transcript_id)`, `(words_asset_id)`
- CHECKs: `status <> 'completed' OR completed_at IS NOT NULL`; `NOT is_reuse OR status = 'completed'`; `is_reuse OR reused_from_transcript_id IS NULL`
- Triggers: `private.assert_reservation` (the reservation is a `reserve` row of meter `clip_seconds` in the same workspace). State machine: pending → running or failed; running → completed or failed.

**`transcript_segments`**: lets `get_transcript` page by time range.
- `workspace_id`, `brand_id` (FK as [B])
- `transcript_id uuid`, FK `(brand_id, transcript_id) → transcripts(brand_id, id) ON DELETE CASCADE`
- `idx int` ≥0
- `start_ms int` ≥0
- `end_ms int` CHECK `> start_ms`
- `text text` ≤5000
- `speaker text?` ≤64
- `confidence real?` CHECK 0–1
- PK `(transcript_id, idx)`. INDEX `(transcript_id, start_ms)`, `(brand_id)`.
- Trigger: rows can be inserted only while the parent is `running`, or by the reuse copy inside `app.request_transcription`. Append-only after the parent is `completed`.
- `app_user` sees segments only of a `completed` transcript: the SELECT policy adds `EXISTS (SELECT 1 FROM app.transcripts t WHERE t.id = transcript_id AND t.status = 'completed')`. A user can't read a partial transcript and then cancel to avoid the charge (V20).

**`clips`**: a proposed or rendered moment. Clips never publish directly.
- `id`, [B]
- `source_media_id uuid`, FK `(brand_id, …) → source_media ON DELETE CASCADE`
- `transcript_id uuid`, FK `(source_media_id, transcript_id) → transcripts(source_media_id, id) ON DELETE CASCADE`. The transcript must belong to the same source.
- `job_id uuid?`, FK `(workspace_id, …) → jobs ON DELETE SET NULL (job_id)`
- `render_reservation_id bigint?`, FK `(workspace_id, render_reservation_id) → usage_ledger(workspace_id, id)` (4.5)
- `start_ms int` ≥0, `end_ms int`. CHECK `end_ms - start_ms BETWEEN 3000 AND 600000`: TikTok's minimum is 3 s [V\*] and the API maximum is 10 min [V].
- `hook text?` ≤300, `title text?` ≤300, `rationale text?` ≤2000
- `aspect_ratio text` default `'9:16'`, CHECK `= '9:16'`
- `caption_style jsonb`, obj ≤4 KB (zod `CaptionStyleV1`)
- `render_spec jsonb`, obj ≤8 KB with `schema_version` (framing and crop)
- `status clip_status` default `'proposed'`
- `output_asset_id uuid?`, `thumbnail_asset_id uuid?`, FK `(brand_id, …) → media_assets ON DELETE SET NULL (col)`
- `created_by_user_id uuid?`, `created_via via`
- `error_code?`, `error_message?`
- [ts], `ready_at?`
- CHECK `(status <> 'ready' OR (output_asset_id IS NOT NULL AND ready_at IS NOT NULL))`
- UNIQUE `(source_media_id, start_ms, end_ms) WHERE status NOT IN ('failed','discarded')`
- INDEX `(source_media_id, start_ms)`, `(job_id)`, `(transcript_id)`, `(render_reservation_id)`, `(output_asset_id)`, `(thumbnail_asset_id)`, `(workspace_id, brand_id, created_at DESC)`
- **Triggers:**
  - `end_ms` must be ≤ the source's `duration_ms`, the source must be `ready`, and the transcript `completed`.
  - At most 60 active clips (not `failed` or `discarded`) per source; `request_clips` checks this under a lock on the source row (`AP019`; C30).
  - Status → `ready` requires a draft with `source_clip_id = id`. `app.complete_clip` creates that draft first, in the same transaction, and settles the render reservation with the measured output duration.
  - Render metering on leaving a live state (a definer trigger; V20): `proposed` → `failed` or `discarded`, and `rendering` → `failed`, release the render reservation (nothing ran, or the failure is ours); `rendering` → `discarded` settles it in full (≤600 s), because the render was already spent. The render worker skips clips discarded while their job runs.
  - A user may only move a clip to `discarded`.
  - State machine:
    - proposed → rendering, failed or discarded
    - rendering → ready, failed or discarded
    - ready → discarded
    - failed → discarded

### 3.8 Voice profiles

**`voice_profiles`**: versioned rows that are never overwritten. Each brand has exactly one active version.
- `id`, [B]
- `version int` ≥1, assigned under a lock on the brand row
- `is_active bool` default true
- `schema_version smallint` CHECK `= 1`
- `content jsonb` obj ≤64 KB (zod `VoiceProfileContentV1`)
- `source voice_source`
- `based_on_version_id uuid?`, FK `(brand_id, …) → voice_profiles(brand_id, id) ON DELETE SET NULL (based_on_version_id)`
- `source_imported_post_ids uuid[]` default `'{}'`, cardinality ≤200. `save_voice_profile` requires every ID to exist in `imported_posts` for the same brand and raises `AP001` otherwise (C47). The array is lineage only: IDs of imported posts deleted later simply stop resolving.
- `change_note text?` ≤1000
- `created_by_user_id uuid?`, `created_via via`, [c]
- UNIQUE `(brand_id, version)`; UNIQUE `(brand_id) WHERE is_active`; INDEX `(based_on_version_id)`
- Trigger: after insert, the only allowed change is `is_active` true → false.
- **Decision:** this takes B's single-table versioning and adds C's lineage columns. There is no separate versions table and no multiple named profiles (cost judge). History, source and draft lineage are kept (forward judge).

### 3.9 Drafts, variants, revisions, approvals

**`drafts`**: one content idea for one brand.
- `id`, [B]
- `label text?` ≤200, `notes text?` ≤4000
- `origin draft_origin`
- `source_clip_id uuid?`, FK `(brand_id, …) → clips ON DELETE SET NULL (source_clip_id)`; UNIQUE `(source_clip_id) WHERE source_clip_id IS NOT NULL`
- `source_job_id uuid?`, FK `(workspace_id, …) → jobs ON DELETE SET NULL (source_job_id)` (render lineage; set by `app.complete_render`)
- `voice_profile_id uuid?`, FK `(brand_id, …) → voice_profiles ON DELETE SET NULL (voice_profile_id)` (the exact version row used)
- `status draft_status` default `'active'`, `archived_at?`
- `created_by_user_id uuid?`, `created_via via` (always set: from the context, or `worker`), `oauth_client_id text?` ≤512 (renamed from `mcp_client_id`, so the same name is used everywhere; C20)
- `last_activity_at timestamptz` default now(): bumped by `save_variant_revision`, `submit_variants`, `decide_variants`, `schedule_variant`, `reschedule_post`, `cancel_post` and `retry_post`, so lists sort by real activity (C17)
- [ts]
- CHECK `((status='archived') = (archived_at IS NOT NULL))`
- INDEX `(workspace_id, brand_id, last_activity_at DESC, id)`, `(source_clip_id)`, `(source_job_id)`, `(voice_profile_id)`
- **Triggers:**
  - On user insert, `origin` is forced from `via` (`web` → `web`; `mcp` or `mcp_app` → `mcp`), and `created_by_user_id`, `created_via` and `oauth_client_id` are forced from `private.ctx()`. Supplied values are overwritten (C20).
  - `clip` and `render` origins can be inserted only by definer functions (`complete_clip`, `complete_render`), which set the actor columns to NULL and `created_via` to `worker`, as jobs do (3.6).
  - The brand must be writable (`AP010`; C18).
  - `last_activity_at` can't be written by `app_user`.
  - Archiving is refused while the draft has live posts (`AP008`).
- Worker-created drafts (clip and render origins) start with **no variants**. The user's AI adds platform variants afterwards with `drafts.addVariants` (7.4), whose first revisions reference the clip's output or the render's outputs (C9).

**`draft_variants`**: one per platform.
- `id`, [B]
- `draft_id`, FK `(brand_id, draft_id) → drafts(brand_id, id) ON DELETE CASCADE`
- `platform platform` (immutable)
- `status variant_status` default `'editing'` (changed only by functions)
- [ts]
- UNIQUE `(id, platform)`, `(draft_id, id, platform)`, `(brand_id, id, platform)` (C15); UNIQUE `(draft_id, platform)` (`dv_one_per_platform`)
- INDEX `(workspace_id, status, updated_at) WHERE status='pending_approval'` (the approval queue)
- The **current revision** is the highest `revision` for the variant. There is no circular `current_revision_id` FK (cost judge).
- Transitions:
  - editing → pending_approval
  - pending_approval → approved, rejected or editing
  - approved → editing, rejected, or approved (a re-approval, which supersedes the previous approval with `reapproved`; needed to publish the same content again, Q19)
  - rejected → editing or approved

**`variant_revisions`**: immutable content snapshots.
- `id`, [B]
- `variant_id uuid`, `platform platform`, FK `(brand_id, variant_id, platform) → draft_variants(brand_id, id, platform) ON DELETE CASCADE`. Carrying `brand_id` guarantees the revision's brand equals the variant's (C15).
- `revision int` > 0
- `connected_account_id uuid?`, FK `(brand_id, connected_account_id, platform) → connected_accounts(brand_id, id, platform)` NO ACTION. The target account is part of the content.
- `destination jsonb?` obj ≤4 KB (`DestinationV1`): the Page, organisation or board this revision publishes to. `save_variant_revision` copies the account's default when none is given and checks it against the account's `capabilities` (`AP007`). It is part of the content hash, and the claim payload uses it, never the account's live value (C1).
- `content_kind content_kind` (derived from the media by the save function)
- `body text` default `''`, CHECK `octet_length ≤ 100000`
- `title text?` ≤400
- `first_comment text?` CHECK `octet_length ≤ 20000`
- `link_url text?` CHECK `~ '^https://'` ≤2048
- `options jsonb`, obj ≤16 KB with `schema_version` (per-platform zod; X `long_text_mode`, TikTok `privacy_level`, …)
- `contains_link bool` default false, `x_link_handling x_link_handling?`
- `validation jsonb` obj ≤32 KB, `validated_ok bool`, `validator_version text` ≤32
- `content_hash bytea` (32 bytes), computed by the database
- `author_channel via`, `created_by_user_id uuid?`, [c]
- UNIQUE `(variant_id, revision)`, `(variant_id, id)`, `(id, connected_account_id)`
- CHECK `(destination IS NULL) = (connected_account_id IS NULL)`
- CHECK `(x_link_handling IS NULL OR (platform = 'x' AND contains_link))`
- CHECK `(validated_ok = COALESCE((validation->>'ok')::boolean, false))`
- Coarse X link guard (B): CHECK `(platform <> 'x' OR contains_link OR (body !~* '(https?://|www\.)' AND COALESCE(first_comment,'') !~* '(https?://|www\.)'))`
- CHECK `(platform <> 'x' OR link_url IS NULL OR contains_link)`: a link card is a link too (C40)
- INDEX `(variant_id, revision DESC)`, `(connected_account_id)`
- Append-only.

**`revision_media`**
- `revision_id uuid`, `workspace_id`, `brand_id`; FK `(brand_id, revision_id) → variant_revisions(brand_id, id) ON DELETE CASCADE`
- `position smallint` CHECK 0–34 (TikTok photo posts allow up to 35 [V])
- `media_asset_id uuid`, FK `(brand_id, …) → media_assets(brand_id, id)` NO ACTION. The asset must be `ready` and of purpose `post_media`, `render_output` or `clip_source`, never `derived`, and its MIME type must be in `ALLOWED_MIME.byPurpose.post_media` whatever its purpose (V11). A `render_output` asset is accepted only once it is released: it is the output or thumbnail of a `ready` clip, or was produced by a render job that `succeeded` or `partially_succeeded`. Workers register outputs as `ready` before `complete_clip` or `complete_render` settles, so without this rule a user could attach an output and then cancel the job to avoid the charge (V20).
- `role text` default `'item'`, CHECK IN (`item`, `cover`, `thumbnail`, `captions`). `save_variant_revision` requires `role = 'captions'` exactly when the asset's kind is `captions` (`AP007`), and captions tracks don't count toward `content_kind` (R9).
- `alt_text text?` ≤1000
- PK `(revision_id, position)`. INDEX `(media_asset_id)`, `(brand_id)`.
- No runtime role has an INSERT, UPDATE or DELETE grant; `app_user` has SELECT under **br** and workers have SELECT (6.3), so the UI and the approval card can list a revision's media (V10). Only `app.save_variant_revision` writes rows. Append-only.

**Canonical content hash** (`private.compute_revision_hash(revision uuid) → bytea`):
- It is `sha256(convert_to(jsonb_build_object(...)::text, 'UTF8'))` over:
  - `'v',1`
  - platform, `connected_account_id`, the account's `provider_account_id`, and the revision's `destination` (C1)
  - `content_kind`, body, title, `first_comment`, `link_url`, options
  - `contains_link`, `x_link_handling`
  - `'media'`: a `jsonb_agg` of `[position, media_asset_id, encode(sha256,'hex'), role, alt_text]` ordered by position
- jsonb text output is deterministic.
- Because the hash includes media sha256 values, it binds the approved bytes, not just the R2 keys (security judge). Because it includes the destination, changing the Page or board after approval breaks the hash.
- The fixture in `supabase/tests/fixtures/revision-hash.json` pins the exact hex (CON-37).

**`approvals`**: append-only record of who decided what, and how.
- `id`, [B]
- `variant_id`, FK `(brand_id, variant_id) → draft_variants(brand_id, id) ON DELETE CASCADE`
- `revision_id`, FK `(variant_id, revision_id) → variant_revisions(variant_id, id) ON DELETE CASCADE`
- `connected_account_id uuid?`, FK `(revision_id, connected_account_id) → variant_revisions(id, connected_account_id)`. This must equal the revision's account.
- CHECK `(decision = 'rejected' OR connected_account_id IS NOT NULL)`
- `decision approval_decision`
- `content_hash bytea` (32 bytes), copied from the revision after it is recomputed
- `decided_by_user_id uuid` (= `private.uid()`)
- `decided_via approval_channel` (from the context; only `web` is accepted until step 4, I3). `oauth_client_id text?` ≤512 (from the context).
- `reason text?` ≤1000
- `superseded_at?`, `superseded_reason text?` CHECK IN (`new_revision`, `rejected`, `reapproved`)
- [c]
- UNIQUE `(variant_id, id, revision_id, connected_account_id)`: the target for the posts FK
- UNIQUE `(variant_id) WHERE superseded_at IS NULL`: one decision in effect per variant
- CHECK `((superseded_at IS NULL) = (superseded_reason IS NULL))`
- INDEX `(revision_id)`, `(workspace_id, created_at DESC)`
- Append-only. The only allowed update sets `superseded_*` once, from null.
- An approval authorises **one** publication: `posts` allows one non-canceled, non-skipped post per approval (3.10). Posting the same content again needs a new decision (C6, C22; Q19).

### 3.10 Posts and attempts

**`posts`**: one publication of one approved revision to one connected account.
- **Lineage:**
  - `id`, [B]
  - `draft_id`, FK `(brand_id, draft_id) → drafts(brand_id, id)` NO ACTION
  - `variant_id`, `platform`, FK `(draft_id, variant_id, platform) → draft_variants(draft_id, id, platform)` NO ACTION
  - `revision_id`, `approval_id`, `connected_account_id`, FK `(variant_id, approval_id, revision_id, connected_account_id) → approvals(variant_id, id, revision_id, connected_account_id)` NO ACTION
  - `provider posting_provider`, FK `(brand_id, connected_account_id, platform, provider) → connected_accounts(brand_id, id, platform, provider)` NO ACTION
  - `provider_account_id text` ≤256: the account's real identity. Caps and import matching use it, so a reconnect or account move can't reset a cap window or break matching (C5, C29).
  - `content_kind`, `contains_link`, `x_link_handling`, `provider_account_id`: the gate trigger copies these from the revision and the account and ignores supplied values.
- **Scheduling and state:**
  - `scheduled_at timestamptz`, `not_before timestamptz?`
  - `scheduled_set_at timestamptz`: forced to `now()` by trigger whenever `scheduled_at` is set or changed (C13)
  - `status post_status` default `'scheduled'`, `status_reason post_status_reason?`
  - `generation int` default 1, CHECK 1–20
  - `idempotency_key text GENERATED ALWAYS AS ('pst_' || replace(id::text,'-','') || '_g' || generation) STORED UNIQUE`
  - `attempt_count int` default 0, CHECK 0–100: claims in the current generation; `retry_post` resets it
  - `dispatched_at?`, `claimed_by text?` ≤128
- **Provider results:**
  - `provider_request_id text?` ≤200, `provider_job_id text?` ≤200 (the current generation's; earlier ones stay in `post_attempts`)
  - `platform_post_id text?` ≤256
  - `post_url text?` CHECK `~ '^https://'` ≤2048
  - `published_at?`
  - `link_stripped bool` default false, `fallback_to_inbox bool` default false, `needs_id_followup bool` default false
  - `next_check_at timestamptz?`, `check_count smallint` default 0, CHECK 0–1000: per-post poll state for the step-2 follow-ups, so the poller backs off per post instead of re-querying every open post on every tick and spending the `X-RateLimit` budget (R2). `record_post_outcome` sets `next_check_at` when the post is left `submitted` or `unknown`, or with `needs_id_followup`, and clears it on any other final state. `mark_stuck_publishing_unknown` sets it to `now()`. `app.note_post_checked` records each poll. NULL means no poll is due.
  - `warnings jsonb` default `'[]'`, arr ≤16 KB
  - `last_error_code text?` `~ '^[a-z0-9_]{1,64}$'`, `last_error_message text?` ≤2000 (scrubbed)
- **Metering:**
  - `x_link_reservation_id bigint?`, FK `(workspace_id, …) → usage_ledger(workspace_id, id)`
  - `x_link_pool_reservation_id bigint?` → `usage_ledger(id)`
  - Both hold the **current claim's** reservations; the ledger keeps every earlier one (`subject_type = 'post'`).
- **Audit:** `scheduled_by_user_id uuid?`, `scheduled_via via`, `canceled_at?`, [ts]
- **Unique constraints:**
  - UNIQUE `(variant_id) WHERE status IN ('scheduled','held','publishing','submitted','unknown','needs_attention')`: one live post per variant
  - UNIQUE `(approval_id) WHERE status NOT IN ('canceled','skipped')` (`posts_one_per_approval`): one publication per approval. Retries reuse the same row through `generation` (C6, C22).
  - UNIQUE `(provider, provider_request_id, platform) WHERE provider_request_id IS NOT NULL`: platform is included so that batched multi-platform calls stay possible (forward judge)
  - UNIQUE `(brand_id, id, connected_account_id)`: the target of the post-snapshot FK (C15)
- **Indexes:**
  - `(COALESCE(not_before, scheduled_at)) WHERE status='scheduled' OR (status='held' AND not_before IS NOT NULL)`: the dispatcher scan
  - `(provider, platform, provider_account_id, dispatched_at) WHERE dispatched_at IS NOT NULL`: the cap window, by real identity (C29)
  - `(dispatched_at) WHERE status = 'publishing'` for `mark_stuck_publishing_unknown`, and `(next_check_at) WHERE next_check_at IS NOT NULL` for `list_posts_due_for_check`. Without them both cross-tenant sweeps scan the whole table (R2).
  - `(connected_account_id)`, `(workspace_id, brand_id, scheduled_at)`
  - `(brand_id, platform, provider_account_id, platform_post_id) WHERE platform_post_id IS NOT NULL`: import matching (C5)
  - `(brand_id, published_at) WHERE status IN ('published','inbox_fallback')` for `get_analytics` and `weekly_review`, and `(published_at) WHERE status IN ('published','inbox_fallback')` for the cross-tenant checkpoint puller (C19)
  - `(draft_id)`, `(variant_id)`, `(approval_id)`, `(revision_id)`
  - `(provider, provider_job_id) WHERE provider_job_id IS NOT NULL`
  - `(x_link_reservation_id)`, `(x_link_pool_reservation_id)`
- **Checks:**
  - `scheduled_at <= scheduled_set_at + interval '365 days'` [V] and `scheduled_at >= scheduled_set_at - interval '60 seconds'`. Anchoring to the last time the date was set, not to `created_at`, lets a post held for months be rescheduled (C13).
  - `status <> 'published' OR published_at IS NOT NULL`
  - `(status='canceled') = (canceled_at IS NOT NULL)`
  - `status NOT IN ('held','failed','needs_attention','canceled','skipped') OR status_reason IS NOT NULL`
  - `status NOT IN ('publishing','submitted','published','inbox_fallback','unknown','needs_attention') OR (dispatched_at IS NOT NULL AND provider_request_id IS NOT NULL)`
  - `NOT link_stripped OR contains_link`
- **Triggers:**
  - The BEFORE INSERT approval gate (I1, section 5).
  - BEFORE UPDATE:
    - Enforces the state machine.
    - Lineage columns can't change; `scheduled_set_at` is forced.
    - After `published`, only the late columns may change: `platform_post_id`, `post_url` and `needs_id_followup`, because TikTok's post ID can arrive up to 24 h late [V], plus the poll state `next_check_at` and `check_count` (R2).
  - AFTER UPDATE: writes the audit row. When `platform_post_id` becomes non-null, it links any matching `imported_posts` row (`matched_post_id`), so an import that ran before a late TikTok ID still gets matched (C5).
- **Allowed transitions.** Every other pair raises `AP004`.

  | From | To |
  |---|---|
  | scheduled | publishing, held, canceled, failed (attempt limit, `too_many_attempts`), scheduled (reschedule or defer) |
  | held | scheduled, publishing, held, canceled, failed (attempt limit) |
  | publishing | submitted, published, inbox_fallback, failed, unknown, needs_attention, skipped, held, scheduled (provider 429 before acceptance) |
  | submitted | published, inbox_fallback, failed, unknown, needs_attention |
  | unknown | submitted, published, inbox_fallback, failed, needs_attention (never back to scheduled, so nothing is re-posted blindly) |
  | needs_attention | published, failed, canceled |
  | failed | scheduled (only through `app.retry_post`: generation + 1, `attempt_count` reset), canceled |
  | published, inbox_fallback, skipped, canceled | terminal |

- **Repeated outcomes** (C39). `app.record_post_outcome` returns `already_applied`, without raising, when the reported outcome equals the post's current terminal state. In that case it only applies the late columns (`platform_post_id`, `post_url`, `needs_id_followup`) and the poll state. A webhook and a reconcile poll can therefore report the same result twice.
- **Leaving `publishing` without acceptance** (to `scheduled` on a 429, or to `held`) releases the claim's X-link reservations in the same transaction (4.7).

**`post_attempts`**
- `id`, [B]
- `post_id`, FK `(brand_id, post_id) → posts ON DELETE CASCADE`
- `attempt_no int` > 0, `generation int` > 0
- `idempotency_key text`, `client_request_id text` ≤200
- `provider_request_id?`, `provider_job_id?`
- `started_at` default now(), `finished_at?`
- `outcome attempt_outcome?`
- `http_status smallint?` CHECK 100–599
- `error_code?`, `error_message?` ≤2000 (scrubbed)
- `response_summary jsonb?`, obj ≤16 KB, never headers
- UNIQUE `(post_id, generation, attempt_no)`. INDEX `(client_request_id)`, `(provider_request_id) WHERE provider_request_id IS NOT NULL`, `(provider_job_id) WHERE provider_job_id IS NOT NULL` (C14).
- CHECK `((outcome IS NULL) = (finished_at IS NULL))`
- Inbound processing looks an Upload-Post request or job ID up on `posts` first and falls back to `post_attempts`, so a late webhook for an earlier generation (exactly how a double publish would show up) is matched rather than dropped (C14).

### 3.11 Imports and analytics

**`imported_posts`**: captions and metadata only. Media is never downloaded.
- `id`, [B]
- `connected_account_id`, `platform`, FK `(brand_id, connected_account_id, platform) → connected_accounts(brand_id, id, platform) ON DELETE CASCADE`: the account row that first imported it (immutable)
- `provider_account_id text` ≤256: copied from the account by trigger (C5)
- `platform_post_id text` ≤256
- `caption text?` (octet_length ≤100000)
- `media_type text?` ≤32
- `permalink text?` CHECK `~ '^https://'` ≤2048
- `thumbnail_url text?` CHECK `~ '^https://'` ≤2048 (a remote URL only)
- `posted_at?`
- `children jsonb` default `'[]'`, arr ≤32 KB
- `matched_post_id uuid?`, FK `(brand_id, …) → posts ON DELETE SET NULL (matched_post_id)`
- `import_job_id uuid?`, FK `(workspace_id, …) → jobs ON DELETE SET NULL (import_job_id)`
- `excluded_from_voice bool` default false
- `imported_at` default now(), `updated_at`
- UNIQUE `(brand_id, platform, provider_account_id, platform_post_id)`: deduplicates by the real account, so re-importing after a reconnect or a new profile adds nothing (C5)
- UNIQUE `(brand_id, id, connected_account_id)`: the target of the post-snapshot FK
- INDEX `(workspace_id, brand_id, posted_at DESC)`, `(connected_account_id)`, `(matched_post_id)`, `(import_job_id)`
- Trigger: on insert, and when `platform_post_id` changes, `matched_post_id` is set to our post with the same `(brand_id, platform, provider_account_id, platform_post_id)`. The `posts` AFTER UPDATE trigger does the reverse when our ID arrives later.

**`account_metric_snapshots`**
- `id bigint IDENTITY PK`, `workspace_id`, `brand_id`
- `connected_account_id`, `platform`, with the same FK as above (CASCADE)
- `provider_account_id text`: copied from the account by trigger
- `provider posting_provider`
- `metric_date date` (UTC)
- `metric_window metric_window`. Facebook's `rolling_30d` values are flagged so nobody sums them [V].
- `captured_at`
- `followers`, `reach`, `impressions`, `views`, `profile_views`, `likes`, `comments`, `shares`, `saves`, `watch_time_seconds`: all `bigint?` ≥0
- `metric_type text?` `~ '^[a-z_]{1,32}$'` [V]
- `extra jsonb` default `'{}'`, obj ≤32 KB
- UNIQUE `(brand_id, provider, platform, provider_account_id, metric_date, metric_window)`: one time series per real account, across reconnects (C5)
- INDEX `(brand_id, metric_date DESC)`, `(connected_account_id)`

**`post_metric_snapshots`**
- `id bigint IDENTITY PK`, `workspace_id`, `brand_id`, `connected_account_id`, `platform` (FK as above), `provider`
- `post_id uuid?`, FK `(brand_id, post_id, connected_account_id) → posts(brand_id, id, connected_account_id) ON DELETE CASCADE`
- `imported_post_id uuid?`, FK `(brand_id, imported_post_id, connected_account_id) → imported_posts(brand_id, id, connected_account_id) ON DELETE CASCADE`
- Both FKs include the account, so a snapshot can't carry another account's ID (C15).
- `captured_at`, `age_seconds int?` ≥0, `checkpoint metric_checkpoint?`
- `views`, `reach`, `impressions`, `likes`, `comments`, `shares`, `saves`, `watch_time_seconds`, `avg_watch_ms`: all `bigint?` ≥0
- `extra jsonb` default `'{}'`, obj ≤32 KB
- CHECK `num_nonnulls(post_id, imported_post_id) = 1`
- UNIQUE `(post_id, checkpoint) WHERE post_id IS NOT NULL AND checkpoint IS NOT NULL`, and the same for `imported_post_id`
- INDEX `(post_id, captured_at DESC)`, `(imported_post_id, captured_at DESC)`, `(brand_id, captured_at DESC)`, `(connected_account_id)`
- **Decision:** this is a time series (forward judge) rather than A's single `platform_posts` table with only the latest metrics, which the cost judge preferred. `weekly_review` is a product differentiator and needs to compare posts at the same age. The core metrics are typed columns and new metrics go in `extra`, so adding a metric needs no migration.

### 3.12 Inbox and audit

**`inbound_events`**: the deduplicating webhook inbox. A row is inserted only after the signature has been verified at the route.
- `id uuid PK`
- `source inbound_source`
- `event_id text` 1–200 (`X-Upload-Post-Delivery` [V] / `evt_…` [V]); CHECK `(source <> 'stripe' OR event_id ~ '^evt_')`
- `event_type text` ≤100
- `object_ref text?` ≤200 (request_id, job_id or `sub_…`)
- `provider_profile_ref text?` ≤64
- `workspace_id uuid?` → `workspaces ON DELETE SET NULL` (resolved during processing)
- `payload jsonb?`, obj ≤64 KB. CHECK `(source <> 'stripe' OR payload IS NULL)`: Stripe payloads are never stored, because the processor re-fetches from Stripe [V].
- `livemode bool?`, `signed_at?`, `received_at` default now(), `processed_at?`
- `attempts int` default 0, `last_error text?` ≤1000 (scrubbed)
- UNIQUE `(source, event_id)`
- INDEX `(received_at) WHERE processed_at IS NULL`, `(received_at)`, `(workspace_id)`

**`audit_events`**: written only by AFTER triggers through a definer trigger function. It has no FKs, so it survives purges for its retention period.
- `id bigint IDENTITY PK`, `occurred_at` default now()
- `workspace_id uuid?`, `brand_id uuid?`
- `actor_kind text` CHECK IN (`user`, `worker`, `system`, `staff`). `staff` is a system context that carries a staff handle (7.4; R10).
- `actor_user_id uuid?`, `actor_name text?` ≤100 (the worker name, or the staff handle)
- `via via?`, `oauth_client_id text?` ≤512, `request_id text?` ≤128
- `action text` CHECK `~ '^[a-z_]+\.[a-z_]+$'`
- `subject_type text` ≤64, `subject_id text` ≤128
- `details jsonb` default `'{}'`, obj ≤8 KB (IDs and enums only, never content or secrets)
- INDEX `(workspace_id, occurred_at DESC)`, `(subject_type, subject_id)`
- **Actions:** `brand.created`, `brand.status_changed`, `account.status_changed`, `account.destination_changed`, `workspace.rights_attested` (V32), `source.attested`, `approval.decided`, `approval.superseded`, `post.status_changed`, `post.rescheduled`, `entitlement.changed`, `voice_profile.saved`, `secret.stored`, `secret.rewrapped`, `usage.bonus_granted`, `usage.adjusted`, `pool.period_set`.

### 3.13 Views

Both views are `WITH (security_invoker = true)`, so RLS still applies.

- **`v_draft_summaries`** (for list_drafts, the approval queue and the card):
  - `draft_id`, `workspace_id`, `brand_id`, `label`, `origin`, `status`
  - `platforms platform[]`
  - `variant_counts jsonb`, keyed by variant status
  - `live_post_count`, `next_scheduled_at`
  - `review_state`: one of needs_review, editing, approved, rejected, scheduled, published
  - `last_activity_at`, `updated_at`
  - `list_drafts` pages by keyset on `(last_activity_at, id)`, served by the drafts index (C17).
- **`v_post_performance`** (for weekly_review): a UNION ALL of our published posts (`source='ours'`) and imported posts that have no `matched_post_id` (`source='imported'`), so nothing is counted twice.
  - Identity: `post_ref`, `workspace_id`, `brand_id`, `platform`, `connected_account_id`, `provider_account_id`, `content_kind`, `published_at`, and `publish_weekday` and `publish_hour` in the brand's timezone.
  - Lineage: `draft_id`, `draft_origin`, `source_clip_id`, `voice_profile_id`, `revision_number`, `contains_link`, `link_stripped`.
  - `human_edited`: true when a `web` or `mcp_app` revision follows an `mcp` revision.
  - Metrics: views, likes, comments, shares and saves at h24, h48 and d7, plus the latest values.

### 3.14 Private helpers used by constraints and policies

All of these are `search_path=''`.
- `private.is_youtube_host(text)` is IMMUTABLE. It matches `(^|\.)(youtube\.com|youtu\.be|youtube-nocookie\.com|googlevideo\.com|ytimg\.com)$`.
- `private.is_allowed_drive_host(drive_provider, text)` is IMMUTABLE. It covers the hosts a user may **paste**:
  - `google_drive`: `drive.google.com`, `docs.google.com`, `drive.usercontent.google.com`
  - `dropbox`: `www.dropbox.com`, `dropbox.com`, `dl.dropboxusercontent.com`
  - `onedrive`: `onedrive.live.com`, `1drv.ms`, `^[a-z0-9-]+(-my)?\.sharepoint\.com$`
  - The generic API hosts (`www.googleapis.com`, `graph.microsoft.com`) are deliberately left out (security judge). The same list is exported as `DRIVE_HOSTS` in `@app/shared`, and VAL-13 and CON-24 share one fixture.
  - The hosts a download may **redirect to** are a separate, wider list in code (`DRIVE_DOWNLOAD_HOSTS`, 7.2), used only by the step-5 fetcher (C8, C46).
- `private.assert_brand_writable(uuid)`: raises `AP010` unless the brand is `active` (C18).
- `private.cap_lock_key(posting_provider, platform, text) → bigint`: `hashtextextended('cap:' || provider || ':' || platform || ':' || provider_account_id, 0)`, the advisory-lock key for one real account (4.8).
- `private.reservation_ttl(seconds bigint) → interval`: `6 hours + 3 × seconds` (4.4).
- `private.current_period(ws uuid) → tstzrange` (V16): the effective billing period. It is the Stripe item period (`ent_period_start`, `ent_period_end`) when the workspace has a mirrored subscription period; otherwise, while a comp is in effect (`comp_expires_at` null or later than the month's start), the current UTC month; otherwise NULL. `ensure_current_balance`, the churn guard (4.3) and the `no_active_plan` rule (4.4) all use it, so a comp-only workspace's month advances without a sweep.
- `private.release_subject_reservations(subject_type text, subject_id uuid, reason text)`: releases every unresolved reservation of one subject. Used by the job terminal cascade for render jobs (3.6), the clip trigger (3.7) and the X-link releases of `record_post_outcome` and of claims that leave `publishing` without acceptance (4.7). Transcription reservations are never resolved by subject: fallback attempts share one reservation, so the cascade and the reconciler find it through `transcripts.reservation_id` (V6).
- Context helpers (`private.ctx`, `uid`, `via`, `ctx_workspace_id`, `user_workspace_ids`, `user_brand_ids`, `has_scope`, `require_scope`) are described in section 6.2.
- **Migration placement** (V8): helpers that read no table are created in 0003; `user_workspace_ids`, `user_brand_ids`, `assert_brand_writable`, `current_period` and `release_subject_reservations` read tables and are created in 0012 (2.3).
- Trigger functions: `private.touch_updated_at()`, `private.append_only()`, `private.assert_reservation()`, `private.assert_timezone()`, `private.enforce_brand_limit()`, `private.sync_brand_profile()`, `private.guard_external_resources()`, `private.on_job_terminal()`, `private.audit()`.
- **Grants** (C36): the CHECK helpers and the context helpers are executed with the caller's privileges (Postgres checks EXECUTE when it evaluates a CHECK expression or a policy), so EXECUTE on them is granted to `app_user`, `app_worker` and `app_media_worker` (6.1; V22). Internal functions (`meter_reserve`, `ensure_current_balance`, `compute_revision_hash`, `assert_brand_writable`, …) are SECURITY INVOKER with no grants; they run as `postgres` only when a definer function calls them. Trigger functions have no grants. A trigger function that reads or writes other tables or calls an internal function (`enforce_brand_limit`, `sync_brand_profile`, `guard_external_resources`, `on_job_terminal`, `audit`, the storage-quota, brand-writable and clip-release triggers) is therefore SECURITY DEFINER with `search_path=''`. A user's media or draft insert then never needs EXECUTE on `assert_brand_writable` or INSERT on `provider_profiles`.

### 3.15 ER overview

```
auth.users 1─1 workspaces 1─1 workspace_billing
workspaces 1─* usage_balances 1─* usage_ledger            (provider pools: usage_balances.workspace_id NULL)
workspaces 1─* brands 1─* provider_profiles 1─* connected_accounts ─0..1 encrypted_secrets
brands 1─* jobs (parent/child); jobs 1─* media_assets (produced_by); jobs *─0..1 usage_ledger (render reserve)
brands 1─* source_media ─0..1 media_assets; source_media ─0..1 jobs (ingest/verify)
source_media 1─* transcripts 1─* transcript_segments; transcripts *─1 usage_ledger (reserve)
source_media 1─* clips *─1 transcripts; clips ─ media_assets (output, thumbnail); clips *─0..1 usage_ledger (render)
clips 1─0..1 drafts (source_clip_id); jobs 1─* drafts (source_job_id, renders)
brands 1─* voice_profiles (versions) ─* drafts
drafts 1─* draft_variants 1─* variant_revisions 1─* revision_media *─1 media_assets
variant_revisions *─0..1 connected_accounts; variant_revisions 1─* approvals 1─0..1 posts (live or published) *─1 connected_accounts
posts 1─* post_attempts; posts ─0..2 usage_ledger (X-link reservations of the current claim)
connected_accounts 1─* imported_posts, account_metric_snapshots; posts | imported_posts 1─* post_metric_snapshots
imported_posts *─0..1 posts (matched by provider_account_id + platform_post_id)
platform_rules (provider, platform) — read by claim_post / save_variant_revision
inbound_events, audit_events — operational, FK-light
```

## 4. Plans, limits and metering

### 4.1 Single source of truth

- `packages/shared/src/billing/catalog.ts` exports `PRICE_CATALOG`, declared `as const satisfies readonly PriceCatalogEntry[]`. CLAUDE.md says plans are enforced in code.

  | lookup_key | kind | cents | brands | clip seconds | render seconds | storage | X link posts | trial clip seconds | current |
  |---|---|---|---|---|---|---|---|---|---|
  | `starter_v1` | plan | 800 | 1 | 14,400 | 43,200 | 50 GB | 0 | 3,600 | yes |
  | `plus_v1` | plan | 1,500 | 2 | 36,000 | 108,000 | 100 GB | 0 | 3,600 | yes |
  | `pro_v1` | plan | 2,500 | 4 | 72,000 | 216,000 | 200 GB | 0 | 3,600 | yes |
  | `addon_brand_v1` | add-on | 300 | 1 | 0 | 0 | 0 | 0 | – | yes |
  | `addon_clip_hour_v1` | add-on | 100 | 0 | 3,600 | 10,800 | 0 | 0 | – | yes |

  Render seconds are always 3 × clip seconds, so the render allowance is still "metered by clipping hours" as the brief asks (4.5). The X link, trial, render and storage values are recommended defaults (Q1, Q8, Q20, Q22). A trial's render seconds are 3 × its clip seconds (10,800).
- There is **no catalog table** (**Decision**: cost judge over forward judge, because the brief says "enforce in code" and this avoids a parity test).
  - Stripe prices are matched by `lookup_key`, never by price ID.
  - A price change adds a new versioned key (`plus_v2`). The old key stays in the constant with `isCurrent: false`, so existing subscribers keep their limits.
  - The database only receives *computed* numbers through `app.apply_entitlements`.
- `PLATFORM_RULES` (code) is mirrored to `app.platform_rules`, with a parity test (MIG-19). The claim needs the caps inside its own transaction, so they can't be passed in by a possibly-buggy caller (security and forward judges, against the cost judge).

### 4.2 Entitlements

- `computeEntitlements()` in `@app/shared` is pure TypeScript.
- **Subscription status mapping:**

  | Subscription status | Entitlement status |
  |---|---|
  | `active`, `trialing` | `active` |
  | `past_due` | `grace` (Q7) |
  | anything else, or no subscription | `inactive` |

- `brandLimit` = plan brands + `extra_brand_qty` + comp. Clip seconds, render seconds and X link posts are computed the same way; storage comes from the plan only.
- While `trialing`, clip seconds are capped at `trialClipSeconds` and render seconds at 3 × that.
- **Unknown lookup key** (C43): `computeEntitlements` reports it in `unknownLookupKeys`. If the subscription would otherwise be `active` or `grace`, `applyBilling` keeps the workspace's previous entitlements (it doesn't call `apply_entitlements`), logs an alert and returns `{ kept: true }`. One catalog mistake therefore can't suspend every brand of every paying user. An `inactive` mapping is applied normally.
- The period comes from the base plan's subscription item [V]. A comp-only workspace uses the UTC calendar month, computed at each use by `private.current_period(ws)` rather than stored (3.14; V16).
- `applyBilling(SystemTx, ws, snapshot)` (step 8 calls it after re-fetching the subscription, so event order doesn't matter [V]) computes the numbers and calls `app.apply_entitlements(ws, billing, entitlements, effective_at)`. `effective_at` is the time of the Stripe change that produced the snapshot (the event's `created`), clamped into the period. In one transaction, the function:
  1. locks `workspaces` FOR NO KEY UPDATE;
  2. decides whether the snapshot's period start equals the stored `ent_period_start` (**same period**) or not (**new period**: a renewal, a first subscription, or a renewal that also carries a scheduled downgrade);
  3. same period only: ensures the current-period balances exist, created from the *stored* entitlements;
  4. writes the mirror and computed columns and bumps `entitlements_version`;
  5. same period: grants any increase above the period's high-water mark, pro rata from `effective_at` (4.4). New period: nothing is carried over; the new period's balances open at the *new* grant. A renewal that also applies a Pro → Starter downgrade therefore gives 14,400 s, not Pro's 72,000 (C32). Before opening a new period, still under the workspace lock, it closes the old one (V3): every balance of the workspace that began before the new start and ends after it gets `period_end = new start`; a balance that already starts exactly at the new start is kept and topped up as in the same-period case; one that began after the new start (only a delayed snapshot crossing a comp-month boundary can cause this) is voided with `period_end = period_start`, and an alert is logged. Reservations on closed balances still settle there (4.4). Without this, the EXCLUDE constraint would silently absorb the new period whenever it overlaps the old one: a comp month followed by a mid-month subscription, an early trial conversion, or a cancel and resubscribe;
  6. suspends or reactivates brands (4.3) and holds or releases their posts;
  7. writes `entitlement.changed` to the audit log.

  Re-applying the same snapshot changes nothing, because grants are computed against `granted_target_hwm` and grant ledger keys include the target value.

### 4.3 Brand limit and profile churn guard (enforced in the database)

`private.enforce_brand_limit` runs BEFORE INSERT, and BEFORE UPDATE OF status when the row becomes `active`. It:
1. Raises `AP009` for a user context unless `private.via() = 'web'`, so brands are created and reactivated only in the web app (C35).
2. Runs `SELECT 1 FROM app.workspaces WHERE id = NEW.workspace_id FOR NO KEY UPDATE`. This serialises brand changes per workspace without blocking other workspaces, or FK checks.
3. Raises `AP015` (no active plan) if `entitlement_status = 'inactive'`.
4. Counts `active` brands, excluding `NEW.id`, and raises `AP002 brand_limit_reached` if the count is ≥ `brand_limit`. Archived and suspended brands don't count.
5. **Profile churn guard** (user contexts only; C31). If the brand will need a new provider profile (on insert, or on reactivation when it has no pending or active profile), it raises `AP016` when either:
   - the workspace's profiles that aren't yet `deleted` (pending, active or deleting) number ≥ `brand_limit + 1`; or
   - the profiles created since the start of `private.current_period(ws)`, **including `deleted` ones**, number ≥ `brand_limit + 2`. Counting deleted profiles is what stops create-and-delete churn; the `(workspace_id, created_at)` index is not partial so that it serves this count (V15, V16).

   Each profile occupies an Upload-Post slot (about $1–2 a month [V]), and our Upload-Post plan has 25 profiles in total (Q12), so live profiles are what must stay bounded. Counting brand insertions alone let create-archive-reactivate cycles add profiles without limit. Archiving schedules a profile's deletion after 7 days and suspension after 30 days (Q10), which frees slots. **Decision:** the guard is kept (security judge) against the cost judge's objection; the tie is broken by the house rule that costs must stay well below the price (Q14).

On plan changes:
- **Downgrade:** `apply_entitlements` suspends the newest active brands over the limit (`suspended_reason='plan_limit'`), moves their `scheduled` posts to `held/brand_inactive`, and schedules their profiles' deletion after 30 days.
- **Upgrade:** brands suspended for `plan_limit` are reactivated oldest first, then `app.release_holds` runs.
- Brands suspended for `billing` or `admin` reasons are never reactivated automatically.
- Nothing is ever deleted because of a limit; only Upload-Post profile slots are released.

**Suspended and archived brands are read-only** (C18). `private.assert_brand_writable` raises `AP010` in `register_source`, `complete_upload`, media uploads, `request_transcription`, `request_clips`, `create_job` (every kind, so renders, imports and account syncs too), draft inserts, `save_variant_revision`, `decide_variants` and `schedule_variant`. Reading, archiving drafts, canceling posts and discarding clips stay allowed. `connect_account` (step 2) uses the same helper.

### 4.4 Clipping hours (`clip_seconds`)

- **Unit:** seconds, computed as `ceil(source.duration_ms/1000)`. The duration is measured by the verify worker by decoding the immutable copy (packet timestamps), never read from container headers or taken from AI input (C26).
- **What is metered:** the source duration, **once per content (sha256) per brand**, when the source is first transcribed (Q2). Clip renders use the separate render allowance (4.5).
- **Work never outruns the charge** (C26). Transcription workers read only the immutable copy in the media bucket, verify its sha256 against the asset row before processing, and feed at most the reserved seconds of audio to Whisper or AssemblyAI (`ffmpeg -t <reserved_seconds>`). A mis-headered file, or a file swapped after probing, can't be transcribed beyond what was charged.
- **Reserve** (`app.request_transcription`, one transaction that also inserts the transcript and the job, acting as the outbox):
  1. Checks `clips:write`, that the brand is writable (`AP010`) and that the source is `ready` (`AP013`).
  2. If a `completed` transcript exists with the same `(brand_id, content_sha256)` (the original if it still exists, otherwise any reuse row), create a reuse row: status `completed`, `is_reuse = true`, `reused_from_transcript_id` set, the **same** `reservation_id`, segments copied in SQL. Nothing new is charged.
  3. Otherwise call `private.meter_reserve(ws, NULL, 'clip_seconds', n, 'transcribe:'||new_transcript_id, ttl => private.reservation_ttl(n), 'transcript', id)`:
     - `private.ensure_current_balance` lazily creates the row for `private.current_period(ws)` from entitlements with `INSERT … ON CONFLICT DO NOTHING` (which also absorbs the exclusion constraint) and writes a `period_open` ledger row. If the insert was absorbed and no row exists for that period's start, it raises `AP017` (`period_overlap`) instead of reserving against the wrong balance (V3). It takes no workspace lock, so it fits any lock order (C44).
     - `INSERT` the `reserve` ledger row `ON CONFLICT (idempotency_key) DO NOTHING`. A replay with the same workspace, meter and amount returns the original (`replayed`, or `replayed_resolved` if that reservation is already resolved). A mismatch raises `AP012`. A concurrent duplicate waits on the unique index, then replays.
     - Run the conditional update:

       ```sql
       UPDATE app.usage_balances SET reserved = reserved + $n
        WHERE id = $balance AND granted + bonus - safety_margin - consumed - reserved >= $n
       RETURNING …;
       ```

       Zero rows means the quota is used up.
     - The function returns an outcome (`reserved | replayed | replayed_resolved | quota_exceeded | no_active_plan`). `request_transcription` turns `quota_exceeded` into `AP003` and `no_active_plan` into `AP015`, which rolls back the whole transaction.
  4. Insert the transcript with `ON CONFLICT` on the original-content unique index. If an in-flight original for the same content exists, raise `AP017` ("an identical video is already being transcribed"). This happens inside a plpgsql sub-block, so the reservation rolls back with it.
- **Lifetime of a reservation** (C3, C27):
  - `expires_at = now() + 6 h + 3 × n s` (`private.reservation_ttl`), so a 4-hour source gets 18 hours. Worker heartbeats call `app.meter_extend(reservation, now() + 2 h)`, which only ever moves `expires_at` later.
  - `app.meter_expire_reservations` is a reconciler, not a blind timer. For each unresolved reservation past `expires_at` it checks the subject. For a `clip_seconds` reservation the subject is every transcript with that `reservation_id`, because fallback attempts share it (V6): it is live if any of them is `pending` or `running`, finished if any non-reuse one is `completed`, and dead otherwise.
    - live with a fresh job heartbeat (under 15 minutes old): extend and skip;
    - live with a stale or missing heartbeat: fail the job, whose terminal cascade (3.6) releases the reservation;
    - finished but unsettled (`completed` transcript, `ready` clip, `succeeded` job, `published` post): settle with the recorded actual;
    - a job canceled while running, or a clip discarded while rendering: settle as the cascade would (3.6; V20);
    - otherwise `failed`, `discarded`, `canceled`: release, with ledger kind `expire`.
    - Posts in `publishing`, `submitted`, `unknown` or `needs_attention` are live and are never expired.
  - **Late completion:** if `complete_transcript` finds its reservation already resolved (possible only after a bug or a manual action), it takes a fresh reservation for the same amount (key `transcribe:<id>:late`) and settles it. If the quota no longer allows that, the transcript fails with `reservation_lost`. Work is never recorded as free.
- **Settle** (`app.complete_transcript`, which calls `app.meter_settle`):
  - Inserts a `settle` row (the unique `reservation_id` index prevents a second resolution) and sets the reserve row's `resolved_at`.
  - Sets `reserved -= amount` and `consumed += least(actual, amount)` on the **reservation's own balance**, even if the period has since rolled over.
  - A charge can never exceed its reservation (security judge).
- **Fallback engine:** when Whisper fails, `app.fail_transcript(…, fallback => 'assemblyai')` marks the row failed and opens a new attempt row, with a new job, that reuses the same reservation. When the last attempt fails, the reservation is released.
- **Cancel and crashes:** `cancel_job`, the stale-job sweep and job failure all go through the terminal cascade (3.6), so a transcript can't stay `pending` or `running` forever and block its source and its content index (C3). Failures and stale jobs are refunded (Q2). A user cancel of a queued job is refunded; a user cancel of a running transcription is charged `least(reserved, processed_seconds)`, the audio already fed to the engine, so cancelling just before completion and repeating can't buy unbounded transcription (V20). Step 5 alerts on any workspace whose refunded seconds in a period exceed its grant.
- **Periods:**
  - Anchored to the Stripe item period. There is **no rollover** (Q3).
  - If `private.current_period(ws)` doesn't contain `now()` (for a subscription, `now() ≥ ent_period_end` and the renewal sync hasn't landed yet), the reserve returns `no_active_plan` (V16). The user sees a neutral "usage period is renewing" message, and an hourly step-2 sweep re-fetches stale subscriptions. **Decision:** B's approach, not C's guessed next period, because the guess can drift from Stripe.
  - Comp-only workspaces roll forward automatically by UTC month, but only while the comp lasts: `ensure_current_balance` opens no period that starts at or after `comp_expires_at`, so the reserve returns `no_active_plan` (R10). The step-8 hourly sweep also re-applies billing for workspaces whose comp has expired, so their entitlement status and brands follow (9).
- **Mid-period changes** (C33):
  - An *increase* (plan upgrade, more add-on hours, a comp) grants `Δ = new target − granted_target_hwm` when positive, prorated as `ceil(Δ × (period_end − t)/(period_end − period_start))`, where `t` is `effective_at` (the time of the Stripe change), not the processing time. The high-water mark then becomes the new target. Add, remove and add again within one period therefore grants only the part above the highest target already granted, and a late webhook doesn't under-grant. This also blocks "upgrade on day 29, burn the hours, downgrade" (security and forward judges, against the cost judge).
  - Decreases never lower the current period's `granted` (trigger); they apply from the next period. Step 8 configures the Stripe portal and API so that every decrease (fewer add-ons, a plan downgrade) is scheduled for period end with no proration credit; `applyBilling` alerts on any mid-period decrease that carries a credit.
  - Grant keys are `grant:{ws}:{meter}:{period_start}:{target_value}`, so repeated applies are idempotent.
  - One-time packs, if ever sold (Q4), use `app.meter_grant_bonus`, which grants in full into the `bonus` column.
- **Grace** (`past_due`): new clip and render reservations return `no_active_plan`. Claims and publishing continue (Q7).

### 4.5 Render allowance (`render_seconds`) and fair-use caps

Rendering (ffmpeg for clips; a headless browser plus an encode for `render_video`) is our heaviest Railway cost, so it is metered (C7, C30).
- **Allowance:** 3 rendered seconds per clipping second bought, from the plan, add-ons and comps (Q20). Starter gets 43,200 s (12 hours of output) a month.
- **Unit:** seconds of rendered output. A clip render costs the clip's length; `render_video` costs the requested output length (≤180 s); `render_carousel` costs 5 s per slide (≤35 slides).
- **Reserve:** `request_clips` reserves `ceil((end_ms − start_ms)/1000)` per clip (key `render:clip:<clip_id>`, subject `clip`) in the transaction that inserts the clips and the job. `create_job` reserves for `render_carousel` and `render_video` (key `render:job:<job_id>`, subject `job`). Same `meter_reserve`, same outcomes, `AP003` when exhausted.
- **Render inputs** (V23): `create_job` raises `AP001` unless every ID in `input->'asset_ids'` is a `ready` asset of the job's own brand with purpose `post_media`, `render_output` or `clip_source`. The renderer runs under a workspace-wide worker context, so without this a token scoped to brand A1 could have A2's media, or a failed and never-verified file, rendered into an A1 output. The renderer re-checks `brand_id` and `status` before loading anything, and step 7 runs Chromium with request interception that allows only presigned GETs of the job's own assets, so a template can't fetch a YouTube video, an internal host or a `file:` URL.
- **Settle:** `complete_clip` settles the measured output duration; `complete_render` settles the measured total. Neither can exceed the reservation.
- **Release:** worker failure, discard of a clip that hasn't started rendering, and cancel of a queued job. A discard while `rendering` or a user cancel of a running render job settles the reservation in full, because the compute was spent (3.6, 3.7; V20). TTL and reconciliation work as in 4.4.
- **Fair-use caps** (`AP019 fair_use_limit`): at most 30 ranges per `make_clips` request (VAL-12); at most 60 active clips per source; at most 3 render jobs (`clip_render`, `render_carousel`, `render_video`) queued or running per workspace. `request_clips` and `create_job` (render kinds) count in-flight render jobs only after locking the `workspaces` row FOR NO KEY UPDATE, first in the global lock order and before the source row, so parallel calls can't all see 2 in flight (V14).
- Clip renders don't consume `clip_seconds`; Q2 is unchanged.

### 4.6 Storage

User files cost R2 storage every month, so they are capped per workspace (C35; Q22).
- **Limit:** `storage_bytes_limit` from the catalog (50, 100 or 200 GB).
- **Counted:** the sum of `COALESCE(bytes, declared_bytes)` over the workspace's assets with origin `upload` or `cloud_drive` and status `pending_upload`, `verifying`, `ready` or `failed`. A failed asset may still have an object in the media bucket, so it counts until it is `deleted`; otherwise repeated mislabelled 10 GiB uploads would free the quota at once and leave uncounted bytes behind (V21). Renders and derived files are bounded by the render allowance and by retention instead.
- **Enforced** BEFORE INSERT on `media_assets` (user uploads and the worker's drive fetches), under the `workspaces` row lock (FOR NO KEY UPDATE): going over raises `AP003` with `detail.meter = 'storage'`. A workspace may also have at most 20 `pending_upload` assets (`AP019`).
- **Drive links:** `register_source` checks that headroom remains. The fetcher inserts the asset with the response's `Content-Length` as `declared_bytes` (or the 10 GiB cap when it is unknown) and aborts once the bytes read exceed it.
- Marking an asset `deleted` frees its space at once.

### 4.7 X posts with links

**Facts:**
- Upload-Post strips every URL from X posts unless we buy the X Links add-on: $19 a month for **50 link posts shared across our whole account**, about $0.38 each [V\*].
- After those 50, URLs are silently stripped until the next billing cycle [V\*].
- The brief's $0.20 is X's direct API price [V].

**How the database meters them:**
1. **Detection.** The app runs `twitter-text` URL extraction over the body and first comment, which catches bare `example.com`, and sets `contains_link` when a revision is saved. The coarse DB CHECKs (3.9) reject an X revision that matches `https?://|www\.` in its text, or has a `link_url`, but has `contains_link = false` (C40).
2. **Decision before approval.** An X revision with a link can't be approved until `x_link_handling` is set (`AP014`). The approval card shows "strip" (the links will be removed) or "keep" (uses metered allowance).
3. **At claim** (inside `app.claim_post`), for `keep`, in a plpgsql sub-transaction:
   - reserve 1 from the workspace `x_link_posts` balance, key `x_link:<post>:g<generation>:c<claim>`;
   - **then** reserve 1 from the pool row (`pool_key='upload_post:x_links'`), key `x_link_pool:<post>:g<generation>:c<claim>`, which also respects `safety_margin`;
   - `<claim>` is the claim's number within the generation (`attempt_count + 1`). A post can be claimed several times in one generation (a 429 defers it, a hold is released), and each claim needs its own live reservation; reusing a key would replay an already-released one (C28). `replayed_resolved` is therefore treated as a bug and raises;
   - the lock order is always workspace balance, then pool row.

   If either reservation fails, the sub-block rolls both back, and the post becomes `held/x_link_quota_exhausted` with `not_before = NULL`. **A link is never stripped silently.** The post waits for the user, who reschedules it once an allowance exists or saves a `strip` revision and approves it. `release_holds` doesn't cover this reason: its 1-hour staleness rule (4.8) would keep almost every such post held anyway (R11).
4. **Re-detection before publishing (step 2).** The worker re-runs `extractUrls` on the claimed payload before calling the provider. If the result disagrees with `contains_link`, it records `held/link_detection_mismatch` and releases both reservations (security judge).
5. **Outcome:**
   - `published` with `link_stripped = false`: settle both reservations.
   - Failed, canceled or stripped: release both.
   - Leaving `publishing` without acceptance (back to `scheduled` on a 429, or to `held`): release both in the same transaction; the next claim reserves afresh.
   - `strip` posts are claimed with no reservation and record `link_stripped = true`.
6. **Pool setup:** the pool row is created by staff through `app.set_pool_period` with Upload-Post's billing-cycle dates. Whether the cycle matches our invoice dates is **[U]**.
7. **Default allowance is 0** (Q1). `keep` posts are therefore held unless a comp grants an allowance. Billing X links to customers later would use Stripe Billing Meters with `identifier = usage_ledger.id` [V], which is deferred.

### 4.8 Platform caps (enforced in the database at dispatch)

**Effective cap** = min(brief rule, native cap, Upload-Post cap). Windows are rolling 24 h, matching Upload-Post's caps [V]. Caps are counted per **real account** (provider, platform, `provider_account_id`), across account rows and workspaces, so reconnecting, moving an account to another brand, or connecting it in a second workspace never resets or splits a window (C29, C48).

| Platform | Native cap | Upload-Post cap | Enforced |
|---|---|---|---|
| Instagram | 100 vs 50 (Meta's docs contradict themselves) [V] | 50 [V] | **50** (stricter than the brief's 100; Q11) |
| TikTok | ~15 per creator per day, shared across all apps [V] | 15 [V] | 15. Other apps' posts surface as a provider 429, which defers the post. |
| YouTube | 100 uploads/day per Google project [V] | 30 [V] | 30 |
| Facebook | Reels 30 per Page per 24 h [V] | 25 [V] | 25 |
| Threads | 250 per 24 h [V] | 50 [V] | 50 |
| X | 100/15 min per user; 10,000/24 h per app [V] | 10 / 20 / 30 by Upload-Post plan [V\*] | 20 (Professional; Q12) |
| LinkedIn | per member, resets at midnight UTC, numbers unpublished [V] | 150 [V] | 150 |
| Pinterest | 100 writes/min per user [V] | 20 [V] | 20 |
| Bluesky | ~11,666 creates/day [V] | 25 videos or 10 GB [V] | 25 video posts; 100 posts in total (our own ceiling [U]) |

`app.claim_post(post, worker)` runs these steps, in this order:
1. Read the post (workspace, account, identity, link handling) without a lock. Raise `AP001` unless it belongs to `ctx.workspace_id`.
2. For a `keep` post, run `private.ensure_current_balance` for `x_link_posts`. It takes no locks, so it can't invert the lock order (C44).
3. Take `pg_advisory_xact_lock(private.cap_lock_key(provider, platform, provider_account_id))`. This serialises claims for one real account across rows and workspaces (C29).
4. Lock the `connected_accounts` row FOR NO KEY UPDATE, then the post FOR UPDATE. FOR NO KEY UPDATE blocks status changes for the claim's duration but not the FK checks of inserts that reference the account (saves, schedules, imports, snapshots; C16).
5. Check the status:
   - If it isn't `scheduled`, or `held` with a `not_before`, return `not_claimable`.
   - If `COALESCE(not_before, scheduled_at) > now()`, return `not_due`.
6. If `attempt_count ≥ platform_rules.max_attempts`, set `failed/too_many_attempts` and return `failed`. A post that keeps getting 429s ends in a visible failure instead of looping forever (C38).
7. Re-verify the approval: the decision is `approved`, it isn't superseded, its revision is the variant's latest, and `approval.content_hash = revision.content_hash = private.compute_revision_hash(revision)`.
   - If it was superseded or rejected, the post becomes `canceled/approval_revoked`.
   - If the hash doesn't match, the post becomes `held/content_hash_mismatch`.
8. Check the rest:
   - Entitlements not `active` or `grace` → `held/billing_inactive`.
   - Brand not active → `held/brand_inactive`.
   - Account not connected → `held/reauth_required` or `held/account_disconnected`. The account's provider profile not `active` → `held/account_disconnected`, so nothing is dispatched with a deleting or deleted profile's ref (V5).
   - Each of these holds sets `not_before = NULL`; the post waits for an event.
9. Count posts with the same (provider, platform, `provider_account_id`), in any workspace, with `dispatched_at > now() - window` and status in {publishing, submitted, unknown, published, inbox_fallback, needs_attention}. Bluesky video posts are also counted separately against `cap_max_video_posts`. The function returns only an outcome, never another tenant's rows. If the count is at or over the cap:
   - set `held/cap_reached` with `not_before` = the oldest counted `dispatched_at` + window;
   - return `deferred`.
10. Make the X link reservations (4.7).
11. Set `publishing`, `dispatched_at = now()`, `attempt_count + 1`, `provider_request_id = idempotency_key` and `claimed_by`, and write the audit row.
12. Return `claimed` with a payload built **only** from the revision:
    - text, options and `x_link_handling`;
    - media R2 keys and sha256s, in order;
    - the revision's `destination` (never the account's current value; C1) and the profile's `provider_profile_ref`.

The claim clears `next_check_at`. `mark_stuck_publishing_unknown` moves `publishing` posts dispatched longer ago than its threshold to `unknown` and sets `next_check_at = now()`. `list_posts_due_for_check` returns IDs of posts whose `next_check_at` has passed, across workspaces, so the step-2 poller never needs a full scan (R2).

**`release_holds` rule** (used by `app.release_holds` and by account reactivation): a post held for `brand_inactive`, `billing_inactive`, `reauth_required` or `account_disconnected` goes back to `scheduled` if its `scheduled_at` is no more than 1 hour in the past; older ones stay held until the user reschedules them.

### 4.9 Concurrency

- **Global lock order:** workspaces → brands → drafts → draft_variants → account identity (advisory lock) → connected_accounts → posts → usage_balances (workspace) → usage_balances (pool). Every function follows it.
- Parent rows that are locked only to serialise work (`workspaces`, `brands`, `drafts`, `connected_accounts`) are locked FOR NO KEY UPDATE, which doesn't conflict with the FOR KEY SHARE locks taken by FK checks.
- Every quota change is a single conditional `UPDATE … RETURNING`; there is no read-then-write anywhere.
- All functions run at READ COMMITTED with explicit row locks. Every transaction sets `lock_timeout '2s'` and `statement_timeout '5s'` (30 s for workers). The DAL retries `40P01` (deadlock) up to 3 times.

| Operation | Serialisation point | Guarantee |
|---|---|---|
| Reserve usage (clip, render, X link) | conditional UPDATE on the balance row + unique `idempotency_key` | No overdraw; at most one reservation per key |
| Resolve a reservation | `UNIQUE (reservation_id)` on resolution rows | Exactly one of settle, release or expire |
| Create or activate a brand | `workspaces` row FOR NO KEY UPDATE | Active brands and live profiles never exceed their limits |
| Upload or fetch media | `workspaces` row FOR NO KEY UPDATE | Storage never exceeds the limit |
| Request clips or create a render job | `workspaces` row FOR NO KEY UPDATE, then (for clips) the source row | At most 3 render jobs in flight per workspace (V14) |
| Open a new billing period | `workspaces` row FOR NO KEY UPDATE in `apply_entitlements`, plus the EXCLUDE constraint | The old period is closed before the new one opens; no overlap is ever silently absorbed (V3) |
| Save a revision, decide, schedule | `drafts` then `draft_variants` row locks | Never approved with a mismatched latest revision; one live post per variant (plus the partial unique index) |
| Schedule an approval | `posts_one_per_approval` partial unique index | One publication per approval |
| Claim | identity advisory lock, then account row, then post row | Exactly one claimer; the cap is never exceeded for a real account |
| X link pool | conditional UPDATE on the pool row | The pool never goes negative |
| Transcribe the same content | partial unique index on `(brand_id, content_sha256) WHERE NOT is_reuse` | Charged once per content |
| Request clips (per source) | source row FOR UPDATE, after the workspace row | At most 60 active clips per source |
| Webhooks, jobs | unique constraints | At-least-once delivery has an exactly-once effect |

## 5. Invariants

| # | Invariant | Where | Mechanism | Why there |
|---|---|---|---|---|
| I1 | No post exists without a live approval of the exact revision, account and destination it publishes, and no approval publishes twice | DB | `posts.approval_id` NOT NULL with the composite FK `(variant, approval, revision, account)`; a BEFORE INSERT gate (approved, not superseded, latest revision, brand active, account connected, entitlement active or grace); `posts_one_per_approval`; the claim re-verifies | It holds for every writer, including future admin tools, and an FK can't be forgotten |
| I2 | Approved content can't change | DB (+ app in step 2) | Revisions and revision media are append-only; the hash is computed in the DB over the account, the destination and media sha256; media bytes, sha256 and duration are frozen once ready; `r2_key` is generated, immutable, and in a bucket only workers can write (uploads land in a separate staging bucket); a new revision supersedes the approval; a live post locks the variant (`AP008`); the claim recomputes the hash and sends the revision's destination; step 2 checks the R2 object's sha256 before uploading | The app could compute a wrong hash; the DB computes it itself |
| I3 | A model can't approve on its own | DB + app | `approval_channel` has no `mcp` value; the channel, decider and client come from `private.ctx()`, never from parameters; in step 1 `decide_variants` accepts only `web`. Step 4 enables `mcp_app` only together with a human-presence check verified on Claude and ChatGPT (Q23) | The DB can't tell a human from a model holding the same token, and `visibility: ["app"]` is a host hint the server can't verify (C22) |
| I4 | Every post and clip starts as a draft | DB | Posts reference revisions only; a clip can't be `ready` without a draft (`source_clip_id`); renders become drafts through `complete_render`; clip and render media reach a platform only through a revision | Structural |
| I5 | Tenant and brand isolation | DB | Composite FKs on every child, including the revision → variant and snapshot → post links; brand-scoped RLS; workers scoped by `ctx.workspace_id`; render inputs, logos and job idempotency keys checked against the brand (V23, V24, V29); functions return the same `AP001` for missing and cross-tenant rows | Defends against handler bugs and injected IDs |
| I6 | MCP tokens are limited to their brands and scopes, and fail closed | DB (+ app mints tokens in step 3) | `private.user_brand_ids()` intersects `ctx.brand_ids`; an MCP context without `brand_ids` or scopes sees nothing; scope predicates sit in policies and functions; web sessions get an explicit full scope set | No missing claim can widen access |
| I7 | Brand limit and profile churn guard | DB | Trigger with a workspace row lock; active brands ≤ limit; live profiles ≤ limit + 1; profile creations ≤ limit + 2 per period; brand writes web-only | Must hold under concurrency, whoever the caller is |
| I8 | Clip hours and render seconds are never overdrawn or overcharged, and work never outruns its charge | DB + worker | Conditional UPDATE; CHECK `reserved + consumed ≤ granted + bonus`; settle capped; `granted` monotonic; increases prorated above a high-water mark; reservations reconciled, never blindly expired; workers process at most the reserved seconds of a hash-verified copy whose duration was decoded; a user cancel or discard after work started is charged for it, and partial transcripts and unsettled render outputs can't be read or attached (V20) | Strongest guarantee available; property-tested |
| I9 | Platform caps per real account | DB | `claim_post` with an advisory lock on (provider, platform, `provider_account_id`) and a rolling count across rows and workspaces from `platform_rules` | Many dispatcher workers may run at once, and account rows change on reconnect |
| I10 | X link posts are metered and never silently stripped | DB + app | Keep/strip decision before approval; one pair of reservations per claim; release when a claim ends without acceptance; coarse DB checks on text and `link_url`; `twitter-text` detection when saving and again before publishing | Precise detection needs a library; the DB catches obvious misses |
| I11 | Users clip only their own content | DB + app | No URL origin for media; normalized `origin_url` with no userinfo or port; host equals the URL host; allowlist CHECK; YouTube denied; attestation forced to the caller and its channel, and a standing web attestation required for AI-registered sources (V32); sources must be uploads or drive files; `origin_url` unreadable by users and media workers and NULL outside `pending`/`fetching` by CHECK (V7); no downloader dependencies (MIG-22); the step-5 fetcher checks every redirect hop against a per-provider download list and the YouTube denylist, refuses IP literals and private addresses, and caps hops | Defence in depth; an allowlist beats a denylist |
| I12 | Valid timestamps and clip ranges | DB + app | zod requires an offset on ISO instants; scheduling must be ≥ now − 60 s and ≤ 365 days ahead (function plus CHECK against `scheduled_set_at`); clips 3–600 s with a CHECK, and end ≤ source duration by trigger | The AI's input is validated twice |
| I13 | Text fits platform limits in the right unit | App (DB coarse ceilings) | Validators per unit (graphemes, UTF-8 bytes, UTF-16, X weighted) produce `validated_ok`; approval requires `validated_ok` (`AP007`) | Grapheme and weighted counting is impractical in SQL |
| I14 | State machines are valid | DB | Transition triggers on posts, jobs, clips, transcripts, sources, media, variants, profiles and brands | Covers every writer |
| I15 | Publishing never posts twice | DB + app | Claim only from scheduled or held; a crash becomes `unknown` and is reconciled, never re-posted; the Idempotency-Key is a per-generation generated column [V]; repeated outcomes are `already_applied`; late webhooks for earlier generations are matched through `post_attempts`; a claim limit ends retry loops | Delivery is at-least-once |
| I16 | Who approved what, and when | DB | Append-only approvals; trigger-only `audit_events` | App code can't skip it |
| I17 | Only accounts verified by Upload-Post exist; account identity is fixed | DB | No user INSERT; immutable identity columns; reconnecting the same identity reactivates its row; an identity change or a move creates a new row; one live row per real account per workspace | Prevents account squatting and keeps history in one place |
| I18 | Secrets are encrypted; plaintext never reaches SQL | App (DB shape CHECKs) | `@app/crypto` seals before insert; IV and tag length CHECKs; `app_user` has no privilege on the table | The DB must never hold keys |
| I19 | Storage and in-flight work are bounded per workspace | DB | Storage sum (failed uploads included until deleted; V21) under the workspace lock; ≤20 pending uploads; ≤3 render jobs in flight, counted under the same lock (V14); ≤60 active clips per source | Costs per user must stay well below the price |
| I20 | Deleting a brand or workspace never orphans external resources | DB | `guard_external_resources` requires deleted Upload-Post profiles and deleted R2 objects before the rows can go | Profiles hold the user's platform tokens and occupy paid slots |

## 6. Security

### 6.1 Roles and connections

| Role | Attributes | Used by | Notes |
|---|---|---|---|
| `postgres` | Supabase owner | Migrations only | Owns all tables and definer functions. Table owners are exempt from RLS because we never `FORCE` it (MIG-08 asserts `relforcerowsecurity = false`) |
| `app_api` | LOGIN NOINHERIT; member of `app_user`, `app_ingest` | Vercel (web, MCP, webhook routes), via the transaction pooler on 6543 with prepared statements off [V] | Has no privileges until it runs `SET LOCAL ROLE` |
| `app_queue_login` | LOGIN NOINHERIT; member of `app_worker`, `app_system` | Railway queue service (dispatcher, sweepers, inbound processor) and the step-5 drive fetcher, via the session pooler on 5432 (avoids IPv6 `ENETUNREACH`) [V] | |
| `app_media_login` | LOGIN NOINHERIT; member of `app_media_worker` only | Railway clipper (ffmpeg, transcription) and renderer (headless browser) (V22) | Can't `SET ROLE` to `app_worker`, `app_system` or `app_billing` |
| `app_billing_login` | LOGIN NOINHERIT; member of `app_billing` only | Step-8 billing processor and staff scripts (V22) | |
| `app_user` | NOLOGIN | User context | No BYPASSRLS |
| `app_worker` | NOLOGIN | Worker context scoped to one workspace | No BYPASSRLS; RLS uses `ctx.workspace_id` and fails closed |
| `app_media_worker` | NOLOGIN | Media worker context scoped to one workspace (V22) | Same RLS predicate as `app_worker`; grants only on the job, media, source (never `origin_url`), transcript and clip columns it writes, SELECT on brands (style, logo); EXECUTE on the 5 media functions (7.1). No privilege on `encrypted_secrets`, `workspace_billing`, posts, accounts or `pgboss` beyond its own queues |
| `app_system` | NOLOGIN | Cross-tenant scans | No table privileges; EXECUTE on system definer functions, which return IDs only |
| `app_billing` | NOLOGIN | Billing and staff actions (V22) | No table privileges; the only role with EXECUTE on `apply_entitlements`, `meter_grant_bonus`, `meter_adjust` and `set_pool_period` |
| `app_ingest` | NOLOGIN | Webhook routes | INSERT on `inbound_events` plus `SELECT(id)` only |
| `anon`, `authenticated`, `service_role` | Supabase | — | No USAGE on `app` or `private` |

- **Decision:** B's role model (security and forward judges) over A's single BYPASSRLS `app_backend` (cost judge).
  - What it guarantees: the internet-facing tier holds no credential that bypasses RLS, runs cross-tenant system functions, or opens secrets (private keys live only in the Railway service that opens secrets, 6.6).
  - What it does **not** guarantee (C24): `app_api` builds the request context, so a compromised Vercel deployment could set any user's `sub` and act as that user, one user at a time. An earlier draft claimed otherwise; that claim is withdrawn.
  - Mitigations: Vercel holds no Supabase service-role key (account deletion runs on a Railway worker; see the last bullet of this section), so it can't list users; every write is audited with its request ID; and `private.ctx()` is the single choke point, so identity resolution can later move into the database without changing any policy (9, step 3).
  - The cost judge's main worry, untested Supavisor custom-role support, is covered by a staging smoke test. Whether Supavisor accepts custom login roles (`app_api.<ref>`) is **[U]**. If it doesn't, the fallback is direct connections: the IPv4 add-on or Railway's IPv6.
- **Decision (V22, reversing the merge's drop of C's `media_worker`):** Railway services get separate logins. The renderer feeds AI-supplied templates and user media to Chromium, the most exposed process we run. With one shared login, a renderer compromise could `SET ROLE app_system`, call `apply_entitlements` with any entitlements for any workspace, and read every workspace's `origin_url` and secrets. Now the media login reaches only media tables and functions; billing writes need `app_billing_login`; `origin_url` and secrets are reachable only from `app_queue_login`. Every worker login can still act in any workspace it names in its context; what the split bounds is which tables and functions each process can reach.
- **Passwords** are never in migrations. Hosted passwords are set by `scripts/set-db-role-password.ts`; local ones by `scripts/db-local-login-roles.sql`.
- The **service-role key** is not used by the app. Step 8 uses it in one Railway worker job, for Auth admin user deletion; it is never deployed to Vercel (C24).

### 6.2 Request context and helpers

`@app/db` opens a transaction, runs `SET LOCAL ROLE <role>`, then calls `set_config('app.ctx', <json>, true)` and sets the timeouts. The context JSON depends on the caller:

| Context | JSON |
|---|---|
| User | `{"sub","via":"web\|mcp\|mcp_app","scopes":[…],"brand_ids":[…]?,"oauth_client_id"?,"request_id"}` |
| Worker | `{"worker","workspace_id","request_id","job_id"?}`. Role `app_worker` for `queue`, `app_media_worker` for `clipper` and `renderer` (V22) |
| System | `{"system","request_id","staff"?}`. Role `app_system`, or `app_billing` for the `billing` and `staff` names (V22). `staff` is the handle of the person running a staff action (bonus, adjust, pool period, comp); ledger and audit actors come from it (R10) |

- `via` is set by server code from the authentication mechanism: a cookie session means `web`, an MCP bearer token means `mcp`, and an app-only tool handler means `mcp_app`. A token can't choose it.
- The JSON is built in one place, `withUser` / `withWorker` / `withSystem`, from a typed and zod-validated context object; handlers never assemble it (DAL-04).
- Web contexts carry the explicit full scope list.
- Because the settings are transaction-local, a pooled connection never carries context into the next request (DAL-02).

Helpers live in `private`. They are STABLE SECURITY DEFINER with `search_path=''`, and EXECUTE is granted only to `app_user`, `app_worker` and `app_media_worker`.

| Helper | Returns |
|---|---|
| `private.ctx()` | The context jsonb, or `'{}'` if unset |
| `private.uid()` | `ctx.sub` (no dependency on `auth.uid()`) |
| `private.via()` | `ctx.via` |
| `private.ctx_workspace_id()` | The worker's workspace; null means no rows |
| `private.user_workspace_ids()` | `uuid[]` of workspaces owned by `uid`. For `mcp` and `mcp_app` it is narrowed to the workspaces of `ctx.brand_ids`, and is **empty if `brand_ids` is missing** |
| `private.user_brand_ids()` | `uuid[]` of brands in those workspaces, intersected with `ctx.brand_ids` when `via ≠ web`. Empty if `brand_ids` is missing |
| `private.has_scope(text)` | Bool. False when scopes are absent, for every `via` |
| `private.require_scope(text)` | Raises `AP009` |

Policy patterns. Helper calls are wrapped in a subselect so they run once per statement as an initPlan [V]:

```sql
create policy sel on app.drafts for select to app_user
  using (brand_id = any ((select private.user_brand_ids())) and (select private.has_scope('content:read')));
create policy ins on app.drafts for insert to app_user
  with check (brand_id = any ((select private.user_brand_ids())) and (select private.has_scope('drafts:write')));
create policy wrk on app.<t> for all to app_worker   -- and to app_media_worker on its tables
  using (workspace_id = (select private.ctx_workspace_id()))
  with check (workspace_id = (select private.ctx_workspace_id()));
```

### 6.3 Per-table policy and grant matrix

**Key:**
- **br** = `brand_id ∈ user_brand_ids()` and `has_scope('content:read')`.
- **br/an** = the same, but with `analytics:read`.
- **ws** = `workspace_id ∈ user_workspace_ids()`.
- **ws/web** = ws and `via() = 'web'`.
- **fn** = possible only through a definer function (section 7.1); there is no table grant.
- A user INSERT or UPDATE also requires the scope shown.
- RLS is enabled on every table. Anything not listed is denied.

| Table | app_user SELECT | app_user INSERT (columns) | app_user UPDATE (columns) | app_user DELETE | app_worker (own workspace) | app_system / app_ingest |
|---|---|---|---|---|---|---|
| workspaces | `id` ∈ ws | fn `ensure_workspace` | `name`, `timezone`, `rights_attested_at`, `rights_attestation_version` (ws/web; the rights columns trigger-stamped, V32) | — | R | fn |
| workspace_billing | ws/web | — | — | — | R | billing: fn `apply_entitlements` |
| platform_rules | all rows | — | — | — | R | — |
| brands | `workspace_id` ∈ ws and (`via() = 'web'` or `id` ∈ `user_brand_ids()`) (V28) | `workspace_id`, `name`, `timezone`, `style`; WITH CHECK `workspace_id` ∈ ws and `via() = 'web'` (V28) | `name`, `timezone`, `style`, `logo_asset_id`, `status` (web only; status trigger-limited and trigger-stamped, V4) | — | R | billing: fn `apply_entitlements` (suspend, reactivate); system: fn `resolve_profile_ref` |
| provider_profiles | br | — | — | — | R; U(`status`, `deleted_at`) | fn `resolve_profile_ref` |
| connected_accounts | br | — | `destination` (ws/web, `accounts:connect`; audited) | — | R + fn upsert/status | — |
| encrypted_secrets | **none** | **none** | — | — | R; I; U(`wrapped_dek`, `key_version`, `rotated_at`, `last_used_at`, `expires_at`, `ciphertext`, `iv`, `auth_tag`) | fn `secrets_for_rewrap` |
| usage_balances | ws (pool rows invisible: `workspace_id` null) | — | — | — | R + fn | fn |
| usage_ledger | ws/web | — | — | — | R + fn | fn |
| jobs | br | fn | fn `cancel_job` | — | R; U(`status`, `progress`, `result`, `error_*`, `attempts`, `queue_job_id`, `heartbeat_at`, `started_at`, `finished_at`, `processed_seconds`) | fn `fail_stale_jobs` |
| media_assets | br, `status ≠ deleted` | `id`, `workspace_id`, `brand_id`, `kind`, `purpose`, `filename`, `mime_type`, `declared_bytes`, `upload_id` (`drafts:write` or `clips:write`; origin forced to `upload`, status `pending_upload`) | fn `complete_upload` | — | R; I (non-upload origins); U(`status`, `bytes`, `sha256`, `width`, `height`, `duration_ms`, `ready_at`, `deleted_at`) | — |
| source_media | br, every column **except `origin_url`** | fn `register_source` | `title` (`clips:write`) | — | R (including `origin_url`); U(`status`, `media_asset_id`, `job_id`, `duration_ms`, `probe`, `origin_url` → NULL only, `error_*`, `deleted_at`) | — |
| transcripts | br | fn `request_transcription` | — | — | R; U(`engine_model`, `language`, `duration_ms`, `segment_count`, `words_asset_id`, `job_id`, `status`→running) + fn complete/fail | — |
| transcript_segments | br, parent `completed` (V20) | — | — | — | R; I (while running) | — |
| clips | br | fn `request_clips` | `status` (→discarded only; `clips:write`) | — | R; U(`status`, `output_asset_id`, `thumbnail_asset_id`, `error_*`, `ready_at`, `job_id`) + fn `complete_clip` | — |
| voice_profiles | br | fn `save_voice_profile` | — | — | R | — |
| drafts | br | `workspace_id`, `brand_id`, `label`, `notes`, `voice_profile_id` (`drafts:write`; origin and actor columns forced) | `label`, `notes`, `status`, `archived_at` (`drafts:write`) | own, when it has no posts (FK) | R | — |
| draft_variants | br | `workspace_id`, `brand_id`, `draft_id`, `platform` (`drafts:write`) | — | own, while editing with no posts | R | — |
| variant_revisions | br | fn `save_variant_revision` | — | — | R | — |
| revision_media | br | — | — | — | R | — |
| approvals | br | fn `decide_variants` | — | — | R | — |
| posts | br | fn `schedule_variant` | fn reschedule/cancel/retry | — | R + fn claim/outcome/`note_post_checked` | fn `list_due_posts`, `list_posts_due_for_check`, `mark_stuck_publishing_unknown`, `release_holds` |
| post_attempts | br | — | — | — | R; I; U(`finished_at`, `outcome`, `http_status`, `error_*`, `response_summary`, `provider_*`) | — |
| imported_posts | br | — | `excluded_from_voice` (`voice:write`) | — | R; I; U(metadata columns) | — |
| account_metric_snapshots | br/an | — | — | — | R; I; U | — |
| post_metric_snapshots | br/an | — | — | — | R; I | — |
| inbound_events | none | — | — | — | — | system: fn; ingest: INSERT(`source`, `event_id`, `event_type`, `object_ref`, `provider_profile_ref`, `payload`, `livemode`, `signed_at`) + SELECT(`id`) |
| audit_events | ws/web | — | — | — | — | — (trigger function only) |

Notes:
- `imported_posts.matched_post_id` is set only by the matching triggers (3.11), never by a grant.
- System changes to `brands.status` and `suspended_reason` (suspend, reactivate) happen only inside `apply_entitlements`; no worker, system or billing grant writes brand columns directly. The brand SELECT policy is keyed on the workspace for web contexts, so `INSERT … RETURNING` of a new brand passes it; a predicate on `user_brand_ids()` alone can't see the row being inserted (V28).
- **`app_media_worker`** (V22) has the `app_worker` column's grants on `jobs`, `media_assets`, `transcripts`, `transcript_segments` and `clips`; on `source_media` the same minus `origin_url` (neither SELECT nor UPDATE); SELECT on `brands` (style and logo); and nothing on any other table, including `encrypted_secrets`, `workspace_billing`, `provider_profiles`, `connected_accounts`, `posts`, `post_attempts`, imports and snapshots. Drive fetches (`source_ingest`) therefore run under `app_queue_login`.
- **`app_billing`** has no table privileges; it executes the four billing functions (7.1).

The full role × object × privilege set is checked against the fixture `supabase/tests/fixtures/grants.expected` (MIG-09).

### 6.4 SECURITY DEFINER rules

1. `set search_path = ''`, and every name is schema-qualified. The function is owned by `postgres` (the table owner).
2. The actor, `via`, scopes and brand scope come only from `private.ctx()`. Parameters are never trusted for identity.
3. Each target row is resolved under the caller's predicate (`user_brand_ids` or `ctx_workspace_id`) and locked. Missing and foreign rows raise the same `AP001`.
4. Role, `via` and scope are checked before any side effect.
5. **EXECUTE** (C36, V1). The first migration runs the global `ALTER DEFAULT PRIVILEGES FOR ROLE postgres REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC`, without `IN SCHEMA`: per-schema default privileges can only add to the global defaults, and EXECUTE-to-PUBLIC is a global built-in default, so the per-schema form left every function executable by PUBLIC. Migration 0013 also runs `REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA app, private FROM PUBLIC` before its per-role GRANTs. Each callable function is then granted to exactly one runtime role; the context and CHECK helpers to exactly `app_user`, `app_worker` and `app_media_worker`; internal and trigger functions to nobody. `supabase/tests/fixtures/definer-allowlist.json` records the grantee set of every function in both schemas (MIG-11, MIG-24, FN-01/02/04).
6. Internal functions (`meter_reserve`, `ensure_current_balance`, `compute_revision_hash`, …) are SECURITY INVOKER. They run as `postgres` only when a definer function calls them, so a runtime role can never reach them with another tenant's IDs.
7. No dynamic SQL.

**Decision:** 42 callable definer functions (15 user, 7 worker, 5 media worker, 11 system, 4 billing; V22). Plain CRUD (brand rename, draft and variant creation, the account's default destination, discard, archive) goes through grants, RLS and triggers. Functions are used only where atomicity, a DB-computed value, metering or an untrusted caller requires them. This meets the cost judge halfway.

### 6.5 Data API exposure

- `supabase/config.toml` sets `[api] schemas = ["public"]`, and `public` is empty.
- `pg_graphql` is dropped. Whether it would otherwise expose `app` is **[U]**; EXP-02 checks.
- `anon`, `authenticated` and `service_role` have no USAGE on our schemas.
- Turning off the hosted Data API entirely is recommended if the toggle exists **[U]**.
- The browser uses supabase-js only for Auth.

### 6.6 Encryption at rest

- **Baseline:** Supabase and R2 encrypt disks at rest **[U: managed default]**.
- **Mechanism** (`@app/crypto`; B and C):
  - Each secret gets a random 32-byte DEK. The data is encrypted with AES-256-GCM (12-byte random IV, 16-byte tag).
  - The DEK is wrapped with **RSA-OAEP-256 under a 3072-bit KEK** at `key_version` n.
  - AAD = `secret:v1|<id>|<workspace_id>|<purpose>|<owner_kind>:<owner_id>`. Swapping ciphertexts between rows or tenants makes decryption fail.
- **Keys:**
  - `SECRETS_KEY_CURRENT` and `SECRETS_PUBLIC_KEY_V<n>` (SPKI PEM) are on Vercel and Railway. `SECRETS_PRIVATE_KEY_V<n>` (PKCS8) is deployed only to the Railway service that opens secrets (the step-5 drive fetcher, under `app_queue_login`), and never to the clipper or the renderer (V22).
  - The internet-facing tier can seal but never open. In v1 it can't even store a secret: only workers insert into `encrypted_secrets` (C35).
  - Keys never go into Postgres or Vault. pgsodium is being deprecated [V], and Vault decrypts inside the database [V].
  - A boot self-test seals and opens a canary for each key version.
  - Moving to a KMS later only means another `KeyProvider`.
- **Rotation:**
  1. Add v(n+1) and set it current.
  2. `app.secrets_for_rewrap` lists IDs. The worker rewraps each DEK in a workspace-scoped transaction; the ciphertext is untouched.
  3. Once no rows below v(n+1) remain, remove the vN private key.
  4. On compromise, also re-encrypt the data.
- **What v1 stores:** nothing. Upload-Post performs the platform OAuth exchange and keeps the tokens [V], so the "fewest scopes" rule is set by Upload-Post's apps [V]. For us it applies to our own OAuth scopes (step 3) and any drive pickers (step 5).
- **Drive share links** can carry access tokens (Dropbox `rlkey`, SharePoint and 1drv.ms share IDs). They are not sealed, so the database CHECKs can keep validating the URL (I11). Instead they are hidden from `app_user`, never copied into jobs or logs, and cleared as soon as the fetch ends (3.7; C41).
- **Tokens we issue** (step-3 codes and refresh tokens, any API keys): 256-bit random values. We store only `HMAC-SHA256(APP_TOKEN_PEPPER, token)` and display the prefix plus the last 4 characters. A pepper rotation verifies against both peppers.

### 6.7 Never stored, never logged, retention

**Never stored:**
- Platform OAuth tokens.
- The Upload-Post API key, the webhook secrets, Stripe keys, R2 keys, KEK private keys and database passwords (environment variables only).
- Upload-Post connect `access_url`s and profile JWTs (returned once, never cached).
- Raw Stripe payloads, webhook headers and signatures.
- Raw bearer tokens and card data.
- R2 presigned URLs.
- Drive share URLs once their fetch has ended.
- Media bytes in Postgres, imported posts' media, and anything from YouTube.
- Raw prompts or conversation text. `jobs.input` holds validated parameters only.

**Never logged** (`@app/log`, pino; C25):
- pino's redaction wildcards match exactly one level and have no recursive form [V\*], so `REDACT_PATHS` lists the real shapes explicitly:
  - `req.headers.authorization`, `req.headers.cookie`, `req.headers["stripe-signature"]`, `req.headers["x-upload-post-signature"]`, `res.headers["set-cookie"]`
  - `err.config.headers.authorization`, `err.config.headers.Authorization`, `err.request.headers.authorization`
  - `req.query.code`, `req.body.code` (a generic `*.code` would also hide SQLSTATE and errno codes)
  - one-level wildcards: `*.authorization`, `*.token`, `*.access_token`, `*.refresh_token`, `*.id_token`, `*.api_key`, `*.apiKey`, `*.secret`, `*.client_secret`, `*.password`, `*.code_verifier`, `*.access_url`, `*.signed_url`, `*.nonce`, `*.wrapped_dek`, `*.ciphertext`, `*.private_key`
- `redactDeep`, a pino `formatters.log` hook, walks every logged object to depth 8 and censors values whose key matches `REDACT_KEY_PATTERN` (`/authorization|cookie|token|secret|api_?key|password|signature|code_verifier|access_url|signed_url|rlkey|private_key|wrapped_dek|ciphertext/i`), and any string that looks like a bearer header or a JWT. It catches nested tool-call bodies and HTTP-client errors that the explicit paths miss.
- `redactUrl()` strips query strings, and for any host in `DRIVE_HOSTS` or `DRIVE_DOWNLOAD_HOSTS` everything after the host (`https://www.dropbox.com/…`), because drive share capabilities often sit in the path (`1drv.ms/v/s!…`, `dropbox.com/s/<key>/…`, `drive.google.com/file/d/<id>/…`, SharePoint `/:v:/g/personal/<user>/<token>`) (V27).
- `scrubSecrets()` runs on every stored error message (C42). It removes `Bearer …` and `Apikey …` values, `token=` and `code=` parameters, PEM blocks, JWT-shaped strings (`eyJ[\w-]+\.[\w-]+\.[\w-]*`), `X-Amz-*`, `sig=`, `signature=` and `rlkey=` values, the query string of every URL it finds, and the path of every drive-host URL, as `redactUrl` does (V27).
- The drive fetcher writes only an `error_code` for fetch failures and never puts a URL in `error_message` (V27).
- The error serializer masks connection strings.
- Rule: log IDs, counts and lengths, never content.

**Retention:**
- `inbound_events`: 30 days.
- `audit_events`: 13 months.
- Everything else: section 10 Q10.

## 7. Interfaces delivered in this step

### 7.0 No HTTP routes or MCP tools

- Every route and tool needs the step-3 auth design (OAuth resource server, token-to-context mapping) before it can be built or tested honestly.
- Step 1 delivers the SQL API, the DAL, shared schemas, and two dev-only scripts (R3). Both refuse to run when `APP_ENV=production`.
  - `scripts/dev-seed.ts` is idempotent. It creates 2 users, each with a workspace, the standing rights attestation (web context; V32), a Pro comp (via `applyBilling` under a staff `SystemCtx`) and 2 brands created through `withUser({ via: 'web' })`. Each brand gets an active fake provider profile (`setProviderProfileStatus`) and fake connected accounts on several platforms, written through `app.upsert_connected_accounts` under `withWorker`. The second tenant lets isolation be checked by hand from a second MCP client.
  - `scripts/dev-approve.ts` calls `decide_variants` in a web context for given revision IDs. Brand creation and approval are web-only (AP009, I3), so without these scripts nothing could be scheduled or approved from Claude or ChatGPT before the web pages exist (9, step 3).
- Testing from Claude and ChatGPT starts in step 2.
- **Tool mapping fixed now** (binding on steps 3–5; C10):
  - `get_transcript`: `readOnlyHint: true`. Returns the transcript (paged by time) or its status. It never registers a source and never charges.
  - `make_clips`: `readOnlyHint: false`, `destructiveHint: false`. Given a source (an uploaded asset or a drive link) and no ranges, it registers the source (`register_source`) and reports the clipping seconds a transcription will cost; with `confirm: true` it calls `request_transcription`. Registering from an AI client needs the workspace's standing web attestation; without it the tool returns the web link where the user gives it (V32). Given a completed transcript and ranges, it calls `request_clips` and reports the render seconds used.
  - `approve_draft`: shows the approval card or returns the web-queue link. The decision itself is taken in the web app until step 4 enables the card's buttons (I3, Q23).
  - Media for `create_draft` from AI clients follows Q21.

### 7.1 SQL API

**Error codes** (SQLSTATE class `AP`):

| Code | Meaning |
|---|---|
| AP001 | not_found (also used for cross-tenant rows) |
| AP002 | brand_limit_reached |
| AP003 | quota_exceeded (`detail.meter`: clip_seconds, render_seconds, x_link_posts or storage) |
| AP004 | invalid_transition / immutable / external_resources_live |
| AP005 | approval_required (none, rejected, superseded, or already used) |
| AP006 | stale_revision |
| AP007 | validation_failed |
| AP008 | variant_locked |
| AP009 | forbidden / insufficient_scope / wrong channel |
| AP010 | brand_inactive |
| AP011 | account_unavailable |
| AP012 | idempotency_conflict |
| AP013 | media_not_ready |
| AP014 | x_link_decision_required |
| AP015 | no_active_plan |
| AP016 | brand_churn_limit |
| AP017 | conflict |
| AP018 | forbidden_source |
| AP019 | fair_use_limit (in-flight renders, pending uploads, active clips per source) |

**User functions** (`app_user`; the scope required is in brackets):

```sql
app.ensure_workspace() returns uuid
app.register_source(p_brand uuid, p_origin app.source_origin, p_media_asset uuid default null,
     p_drive_provider app.drive_provider default null, p_url text default null,
     p_title text default null, p_attest boolean default false)
     returns table(source_id uuid, job_id uuid)        -- [clips:write]; AP007 without attestation; AP009 for a non-web caller
                                                    -- without the standing web attestation (V32); AP010; AP013 (failed or
                                                    -- deleted asset; V13); AP018; AP003 (storage)
app.complete_upload(p_asset uuid) returns uuid        -- [drafts:write or clips:write]; pending_upload → verifying + media_verify job
app.save_variant_revision(p_variant uuid, p_expected_revision int, p_account uuid, p_content jsonb,
     p_media jsonb, p_validation jsonb, p_contains_link boolean, p_x_link_handling app.x_link_handling)
     returns uuid                                   -- [drafts:write]; p_content = body, title, first_comment, link_url, options, destination?
                                                    -- AP006/AP007/AP008/AP010/AP013; computes hash; supersedes approval
app.submit_variants(p_variants uuid[]) returns void                                    -- [drafts:write]
app.decide_variants(p_revisions uuid[], p_decision app.approval_decision, p_reason text default null)
     returns setof uuid                             -- [posts:approve]; via = web only until step 4 (I3); atomic batch
app.schedule_variant(p_variant uuid, p_scheduled_at timestamptz) returns uuid          -- [posts:schedule]; AP005 if the approval was already used
app.reschedule_post(p_post uuid, p_scheduled_at timestamptz) returns void              -- [posts:schedule]
app.cancel_post(p_post uuid) returns void                                               -- [posts:schedule]
app.retry_post(p_post uuid) returns void                                                -- [posts:schedule]
app.request_transcription(p_source uuid)
     returns table(transcript_id uuid, job_id uuid, reservation_id bigint, reused boolean)  -- [clips:write]
app.request_clips(p_transcript uuid, p_ranges jsonb) returns table(job_id uuid, clip_ids uuid[])
                                                    -- [clips:write]; reserves render_seconds; AP003/AP019
app.create_job(p_brand uuid, p_kind app.job_kind, p_input jsonb, p_idempotency_key text default null)
     returns table(job_id uuid, deduplicated boolean) -- render_* [drafts:write] (reserves render_seconds; AP019 under the
                                                    -- workspace lock, V14; input asset_ids must be ready assets of p_brand,
                                                    -- else AP001, V23), import_past_posts [voice:write], sync_accounts
                                                    -- [accounts:connect]; other kinds AP009. A reused key returns the existing
                                                    -- job only with the same input_hash, else AP012 (V29)
app.cancel_job(p_job uuid) returns void              -- the scope of the job's kind (3.6 table; V18); runs the terminal cascade:
                                                    -- queued → release, running → settle what was processed (V20)
app.save_voice_profile(p_brand uuid, p_content jsonb, p_source app.voice_source, p_note text default null,
     p_based_on uuid default null, p_imported_ids uuid[] default '{}') returns uuid    -- [voice:write]; foreign imported IDs → AP001
```

Every user function that writes to a brand calls `private.assert_brand_writable` (4.3). Functions that change a draft's state bump `drafts.last_activity_at`, locking the draft before its variant (4.9).

**Worker functions** (`app_worker`, used by `app_queue_login`; scoped to `ctx.workspace_id`):

```sql
app.claim_post(p_post uuid, p_worker text) returns table(outcome text, not_before timestamptz, payload jsonb)
     -- claimed | deferred | not_due | not_claimable | held | canceled | failed
app.record_post_outcome(p_post uuid, p_outcome jsonb) returns text   -- applied | already_applied; settles or releases X-link reservations;
                                                                     -- sets or clears next_check_at
app.note_post_checked(p_post uuid, p_next_at timestamptz) returns void
     -- after a poll that changed nothing: check_count + 1, next_check_at = p_next_at (NULL stops polling); never changes status (R2)
app.upsert_connected_accounts(p_profile uuid, p_accounts jsonb) returns setof uuid
     -- active profiles only; disconnects colliding rows (identity_changed, profile_replaced, account_moved) before
     -- inserting or reactivating (V5); re-arms held posts
app.set_account_status(p_account uuid, p_status app.connection_status, p_reason text) returns void
app.meter_settle(p_reservation bigint, p_actual bigint) returns text   -- settled|already_settled|already_released
app.meter_release(p_reservation bigint, p_reason text) returns text
```

**Media worker functions** (`app_media_worker`, used by `app_media_login`; scoped to `ctx.workspace_id`; V22):

```sql
app.complete_transcript(p_transcript uuid, p_result jsonb) returns void   -- settles; re-reserves if the reservation was lost
app.fail_transcript(p_transcript uuid, p_error_code text,
     p_fallback app.transcription_engine default null) returns uuid      -- fallback row (same reservation) or release
app.complete_clip(p_clip uuid, p_output uuid, p_thumbnail uuid default null) returns uuid
     -- creates the clip draft (no variants); settles render seconds
app.complete_render(p_job uuid, p_outputs uuid[]) returns uuid
     -- outputs must be ready, in the job's brand and produced by the job; creates the render draft (no variants); settles (C9)
app.meter_extend(p_reservation bigint, p_until timestamptz) returns timestamptz   -- never shortens; refuses resolved reservations
```

**System functions** (`app_system`; cross-tenant; return IDs):

```sql
app.list_due_posts(p_limit int) returns table(post_id uuid, workspace_id uuid, due_at timestamptz)
app.mark_stuck_publishing_unknown(p_older_than interval) returns setof uuid   -- also sets next_check_at = now()
app.list_posts_due_for_check(p_limit int) returns table(post_id uuid, workspace_id uuid, due_at timestamptz)   -- R2
app.resolve_profile_ref(p_ref text) returns table(workspace_id uuid, brand_id uuid, provider_profile_id uuid)
app.release_holds(p_ws uuid) returns int
app.meter_expire_reservations(p_limit int default 500) returns int      -- the reconciler of 4.4
app.claim_inbound_events(p_limit int) returns table(id uuid, source app.inbound_source, workspace_id uuid)
app.mark_inbound_processed(p_id uuid, p_error text default null) returns void
app.purge_inbound_events(p_older_than interval) returns int
app.secrets_for_rewrap(p_below_version int, p_limit int) returns table(id uuid, workspace_id uuid)
app.fail_stale_jobs(p_heartbeat_older_than interval, p_queued_older_than interval) returns setof uuid
```

**Billing functions** (`app_billing` only, used by `app_billing_login`; cross-tenant; V22):

```sql
app.apply_entitlements(p_ws uuid, p_billing jsonb, p_entitlements jsonb, p_effective_at timestamptz) returns jsonb
     -- closes an overlapping old period before opening a new one (4.2; V3)
app.meter_grant_bonus(p_ws uuid, p_meter app.usage_meter, p_amount bigint, p_key text, p_note text) returns void
app.meter_adjust(p_ws uuid, p_meter app.usage_meter, p_delta_consumed bigint, p_key text, p_note text) returns void
     -- both: actor = ctx.staff (required), never a parameter (6.4 rule 2; R10); adjust changes consumed only (V17)
app.set_pool_period(p_pool_key text, p_meter app.usage_meter, p_start timestamptz, p_end timestamptz,
     p_granted bigint, p_margin bigint) returns void                    -- actor = ctx.staff (required); re-running it may
                                                                        -- raise granted or change the margin, never lower granted (V17)
```

**Internal** (SECURITY INVOKER, no grants): `private.meter_reserve`, `private.ensure_current_balance`, `private.current_period` (V16), `private.compute_revision_hash`, `private.release_subject_reservations`, `private.assert_brand_writable`, `private.cap_lock_key`, `private.reservation_ttl`. Trigger functions have no grants either.

### 7.2 `@app/shared` (pure TypeScript and zod, no I/O)

```ts
// enums.ts — one `as const` array + zod enum per PG enum
export const PLATFORMS = ['tiktok','youtube','instagram','facebook','threads','x','linkedin','pinterest','bluesky'] as const;
export type Platform = (typeof PLATFORMS)[number];   // likewise PostStatus, JobKind, UsageMeter, MediaPurpose, Via, …

// ids.ts
export type Id<B extends string> = string & { readonly __brand: B };
export type UserId = Id<'User'>; export type WorkspaceId = Id<'Workspace'>; export type BrandId = Id<'Brand'>;
// ConnectedAccountId, ProviderProfileId, MediaAssetId, SourceMediaId, TranscriptId, ClipId, JobId, DraftId,
// VariantId, RevisionId, ApprovalId, PostId, AttemptId, VoiceProfileId, SecretId
export type ReservationId = bigint & { readonly __brand: 'Reservation' };
export const zId: <B extends string>(b: B) => z.ZodType<Id<B>>;

// scopes.ts
export const SCOPES = ['content:read','drafts:write','posts:approve','posts:schedule','clips:write',
  'voice:write','analytics:read','accounts:connect'] as const;
export type Scope = (typeof SCOPES)[number];

// billing/catalog.ts
export interface PriceCatalogEntry { lookupKey: string; kind: 'plan'|'addon'; planCode?: 'starter'|'plus'|'pro';
  unitAmountCents: number; grantsBrands: number; grantsClipSeconds: number; grantsRenderSeconds: number;
  grantsStorageBytes: number; grantsXLinkPosts: number; trialClipSeconds?: number; isCurrent: boolean }
export const PRICE_CATALOG: readonly PriceCatalogEntry[];
export const RENDER_SECONDS_PER_CLIP_SECOND = 3;
export interface Entitlements { status: 'active'|'grace'|'inactive'; brandLimit: number; clipSecondsPerPeriod: number;
  renderSecondsPerPeriod: number; storageBytes: number; xLinkPostsPerPeriod: number;
  periodStart: Date | null; periodEnd: Date | null }
export interface CompInput { lookupKey: string | null; extraBrands: number; extraClipHours: number; xLinkPosts: number;
  expiresAt: Date | null; reason: string }                          // ignored once expiresAt ≤ now (R10)
export function computeEntitlements(i: { subscription?: StripeSubscriptionSnapshot; comp?: CompInput; now: Date }):
  { entitlements: Entitlements; unknownLookupKeys: string[] };

// platforms/rules.ts, limits.ts
export interface PlatformRule { capMaxPosts: number; capMaxVideoPosts: number | null; capWindowSeconds: number;
  maxAttempts: number; supports: Record<ContentKind, boolean>; carousel: { min: number; max: number } | null;
  requiresTitle: boolean; supportsFirstComment: boolean; source: string }
export const PLATFORM_RULES: Record<PostingProvider, Record<Platform, PlatformRule>>;   // = §3.3 seed
export const TEXT_LIMITS: Record<Platform, readonly TextLimit[]>;  // { field, max, unit: 'graphemes'|'utf8_bytes'|'utf16'|'x_weighted' }
export const MEDIA_LIMITS: Record<Platform, MediaLimit>;           // video min/max ms, bytes, image bytes
export const UPLOAD_LIMITS: { maxSourceBytes: number; maxImageBytes: number; maxDocumentBytes: number;
  multipartThresholdBytes: number; maxSourceDurationMs: number; maxPendingUploads: number;
  maxDimension: 16384; maxPixels: 50_000_000 };
export const ALLOWED_MIME: { byKind: Record<MediaKind, readonly string[]>;     // = the 3.7 CHECK lists; never image/svg+xml
  byPurpose: Partial<Record<MediaPurpose, readonly string[]>> };               // post_media narrowing (R1)
export const RENDER_LIMITS: { secondsPerSlide: 5; maxSlides: 35; maxVideoSeconds: 180;
  maxRangesPerRequest: 30; maxActiveClipsPerSource: 60; maxRenderJobsInFlight: 3 };

// text/count.ts
export function xWeightedLength(s: string): number;   // twitter-text, NFC
export function graphemeCount(s: string): number;      // Intl.Segmenter
export function utf8Bytes(s: string): number; export function utf16Units(s: string): number;
export function extractUrls(s: string): string[];      // twitter-text (bare domains count)

// validate/variant.ts
export function validateVariantContent(p: Platform, c: VariantContent,
  ctx: { media: MediaFacts[]; account?: AccountFacts }): ValidationReport;  // drives validated_ok + contains_link;
                                                                            // checks destination ∈ account capabilities

// own-content.ts
export const DRIVE_HOSTS: Record<DriveProvider, readonly (string | RegExp)[]>;          // hosts a user may paste (= 3.14)
export const DRIVE_DOWNLOAD_HOSTS: Record<DriveProvider, readonly (string | RegExp)[]>; // hosts a download may redirect to
export const MAX_REDIRECT_HOPS = 5;
export function parseDriveUrl(s: string): { ok: true; provider: DriveProvider; host: string; normalizedUrl: string }
  | { ok: false; reason: 'not_https'|'youtube_forbidden'|'host_not_allowed'|'has_credentials'|'has_port'|'ip_literal' };
export function isAllowedDownloadHop(provider: DriveProvider, url: string):
  { ok: true } | { ok: false; reason: 'not_https'|'youtube_forbidden'|'host_not_allowed'|'has_credentials'|'has_port'|'ip_literal' };

// rights.ts
export const RIGHTS_ATTESTATION_VERSION = 1;   // bump when the own-content wording changes; register_source then needs a new attestation (V32)

// schemas/*.ts (zod 4). .strict() for AI/tool input and our own jsonb; z.looseObject plus explicit mapping for
// third-party payloads: ProviderAccountSnapshot, StripeSubscriptionSnapshot, Normalized*Metrics (unknown keys → extra) (V9)
export const VariantOptionsSchema;   // discriminated by platform, schema_version 1 (tiktok privacy_level required,
                                     // branded content ≠ private; x long_text_mode 'thread'|'single_post'; pinterest board)
export const CreateDraftInput, AddVariantsInput, SaveRevisionInput /* content.destination?: DestinationV1 */, DestinationV1,
  BrandStyleV1 /* colours, allowlisted font names, asset IDs; no URLs (V24) */, CaptionStyleV1, ClipRenderSpecV1,
  VoiceProfileContentV1, JobInputEnvelope /* schema_version; asset_ids: uuid[] ≤50 (V23) */,
  RenderCarouselInputV1, RenderVideoInputV1 /* media only by asset ID; no URL-valued fields (V23) */, ClipRangeSchema, ClipRequestSchema /* ≤30 ranges */, IsoInstantSchema /* offset required */,
  ScheduleAtSchema /* ≥ now−60s, ≤ 365 d */, UploadRequestSchema /* kind, purpose, filename, mime ∈ ALLOWED_MIME, declaredBytes */,
  ProviderAccountSnapshot, StripeSubscriptionSnapshot, NormalizedAccountMetrics, NormalizedPostMetrics, ValidationReport;

// errors.ts
export type DomainErrorCode = 'not_found'|'brand_limit_reached'|'quota_exceeded'|'invalid_transition'|'approval_required'
  |'stale_revision'|'validation_failed'|'variant_locked'|'forbidden'|'brand_inactive'|'account_unavailable'
  |'idempotency_conflict'|'media_not_ready'|'x_link_decision_required'|'no_active_plan'|'brand_churn_limit'
  |'conflict'|'forbidden_source'|'fair_use_limit'|'internal';
export class DomainError extends Error { readonly code: DomainErrorCode; readonly userMessage: string;
  readonly detail?: Record<string, string | number> }   // neutral, actionable, no upsell
```

`DRIVE_DOWNLOAD_HOSTS` (C8, C46): Google `drive.google.com`, `docs.google.com`, `drive.usercontent.google.com`, `^doc-[a-z0-9-]+-docs\.googleusercontent\.com$`; Dropbox `www.dropbox.com`, `dropbox.com`, `dl.dropboxusercontent.com`, `^uc[a-z0-9_-]+\.dl\.dropboxusercontent\.com$`; OneDrive `onedrive.live.com`, `1drv.ms`, `api.onedrive.com`, `^[a-z0-9-]+\.files\.1drv\.com$`, `^[a-z0-9-]+(-my)?\.sharepoint\.com$`. The exact redirect chains are **[U]** until step 5 records them as msw fixtures.

**Text limits used by the validators** (`TEXT_LIMITS`):

| Platform | Limit | Source |
|---|---|---|
| X | 280 weighted characters (NFC; URL = 23; emoji and CJK = 2). Longer text needs `long_text_mode`. `single_post` allows up to 25,000 and works only for Premium accounts | [V] / [V\*] |
| Bluesky | 300 graphemes **and** 3,000 UTF-8 bytes | [V] |
| Threads | 500 UTF-8 bytes (Upload-Post's stricter rule); at most 5 unique links; topic tag 1–50 characters with no `.` or `&` | [V\*] / [V] |
| TikTok | Caption 2,200 UTF-16 units; photo post title 90 and description 4,000 | [V] |
| YouTube | Title ≤100 characters with no `<` or `>`, required; description 5,000 UTF-8 bytes; tags 500 characters including commas and quotes | [V] |
| Instagram | Caption 2,200 (unit not stated [U], so UTF-16 is used); 30 hashtags; 20 mentions | [V] |
| Facebook | 63,206 | [V\*] |
| LinkedIn | Commentary 3,000; title 400 UTF-16 units | [V\*] |
| Pinterest | Title 100, description 800, link 2,048, alt text 500 | [V] |
| First comment | Same as the platform's body limit | [U] |

**Video limits** (`MEDIA_LIMITS`):

| Platform | Limit | Source |
|---|---|---|
| TikTok | 3–600 s | [V\*] / [V] |
| Instagram Reels | 3 s–15 min, ≤300 MB | [V] |
| Facebook Reels | 3–90 s | [V] |
| YouTube Shorts | ≤3 min | [V] |
| X | 0.5 s–20 min | [V] |
| LinkedIn | 3 s–30 min | [V] |
| Pinterest | 4 s–15 min | [V\*] |
| Threads | ≤5 min | [V] |
| Bluesky | ≤300,000,000 bytes [V]; images ≤1 MB while posting through Upload-Post | [V\*] |

### 7.3 `@app/crypto`, `@app/log`, `@app/env`

```ts
// @app/crypto
export interface Keyring { readonly currentVersion: number; publicKey(v: number): KeyObject; privateKey(v: number): KeyObject | undefined }
export function loadKeyring(env: NodeJS.ProcessEnv, o: { requirePrivate: boolean }): Keyring;  // validates ≥3072-bit, runs self-test
export interface SealedSecret { alg: 'A256GCM+RSA-OAEP-256'; keyVersion: number; wrappedDek: Uint8Array;
  iv: Uint8Array; ciphertext: Uint8Array; authTag: Uint8Array }
export interface SecretAad { secretId: string; workspaceId: string; purpose: SecretPurpose; ownerKind: SecretOwnerKind; ownerId: string }
export function seal(k: Keyring, plaintext: Uint8Array, aad: SecretAad): SealedSecret;
export function open(k: Keyring, s: SealedSecret, aad: SecretAad): Uint8Array; // DecryptError | KeyNotFoundError | NoPrivateKeyError
export function rewrap(k: Keyring, s: SealedSecret): SealedSecret;             // DEK only
export function generateToken(prefix: string): { token: string; display: string };
export function hashToken(pepper: Buffer, token: string): Buffer;              // HMAC-SHA256
export function verifyTokenHash(pepper: Buffer, token: string, hash: Buffer): boolean;  // timingSafeEqual

// @app/log
export const REDACT_PATHS: readonly string[];          // explicit shapes (6.7)
export const REDACT_KEY_PATTERN: RegExp;
export function redactDeep(o: unknown, maxDepth?: number): unknown;   // used as formatters.log
export function createLogger(o: { service: string; level?: string }): Logger;
export function redactUrl(u: string): string;
export function scrubSecrets(s: string): string;

// @app/env
export function loadEnv<S extends z.ZodTypeAny>(schema: S): z.infer<S>;   // fails fast at boot
```

### 7.4 `@app/db`

```ts
export type Db = Kysely<DB>;
export function createDb(o: { connectionString: string; applicationName: string; max?: number }): Db;
export type UserVia = Extract<Via, 'web' | 'mcp' | 'mcp_app'>;   // Via (all 5 enum values) comes from @app/shared
export interface UserCtx   { kind: 'user'; userId: UserId; via: UserVia; scopes: readonly Scope[]; brandIds?: readonly BrandId[];
                             oauthClientId?: string; requestId: string }   // zod: brandIds required when via ≠ 'web'
export interface WorkerCtx { kind: 'worker'; worker: 'queue'|'clipper'|'renderer'; workspaceId: WorkspaceId; requestId: string; jobId?: JobId }
     // role: app_worker for 'queue', app_media_worker for 'clipper' and 'renderer' (V22). workspaceId is taken from app.jobs,
     // list_due_posts or resolve_profile_ref, never from a queue payload (V33)
export interface SystemCtx { kind: 'system'; name: 'dispatcher'|'billing'|'sweeper'|'inbound'|'staff'; requestId: string;
                             staff?: string }   // zod: staff handle required exactly when name = 'staff' (R10);
                                                // role app_billing for 'billing' and 'staff', app_system otherwise (V22)
export interface IngestCtx { kind: 'ingest'; source: InboundSource; requestId: string }
type Scoped<S extends string> = Transaction<DB> & { readonly __scope: S };
export type UserTx = Scoped<'user'>; export type WorkerTx = Scoped<'worker'>;
export type SystemTx = Scoped<'system'>; export type IngestTx = Scoped<'ingest'>;   // mutually non-assignable
export function withUser<T>(db: Db, c: UserCtx, fn: (tx: UserTx) => Promise<T>): Promise<T>;
export function withWorker<T>(db: Db, c: WorkerCtx, fn: (tx: WorkerTx) => Promise<T>): Promise<T>;
export function withSystem<T>(db: Db, c: SystemCtx, fn: (tx: SystemTx) => Promise<T>): Promise<T>;
export function withIngest<T>(db: Db, c: IngestCtx, fn: (tx: IngestTx) => Promise<T>): Promise<T>;
export function mapDbError(e: unknown): DomainError;   // AP0xx, 23503/23505/23514, 42501, 40P01 (retried ×3), 55P03
```

**Repository modules.** Each function validates its input with zod before any query, filters explicitly (it doesn't rely on RLS alone [V]), and throws `DomainError`.

- **`workspaces.ts`**
  - `ensureWorkspace(tx: UserTx): Promise<WorkspaceView>`
  - `getMyWorkspace(tx: UserTx)`
  - `updateWorkspace(tx: UserTx, p: { name?; timezone? })`
  - `attestRights(tx: UserTx)` (web contexts only; writes the current `RIGHTS_ATTESTATION_VERSION`; V32)
- **`billing.ts`**
  - `getEntitlements(tx: UserTx): Promise<Entitlements>`
  - `applyBilling(tx: SystemTx, ws: WorkspaceId, s: StripeSubscriptionSnapshot | null, o: { comp?: CompInput; effectiveAt: Date }): Promise<{ kept: boolean; unknownLookupKeys: string[]; suspendedBrandIds: BrandId[]; reactivatedBrandIds: BrandId[] }>`
- **`brands.ts`**
  - `createBrand(tx: UserTx, i: { name; timezone?; style? })`
  - `listBrands(tx: UserTx)`, `updateBrand(tx: UserTx, id, p)`, `archiveBrand(tx: UserTx, id)`, `reactivateBrand(tx: UserTx, id)` (web contexts only)
  - `setProviderProfileStatus(tx: WorkerTx, id: ProviderProfileId, s)`
  - `resolveProfileRef(tx: SystemTx, ref): Promise<{ workspaceId; brandId; providerProfileId } | null>`
- **`accounts.ts`**
  - `listConnectedAccounts(tx: UserTx, f: { brandId?; includeDisconnected? })`
  - `setDefaultDestination(tx: UserTx, id, d: DestinationV1)` (web contexts only)
  - `requestAccountSync(tx: UserTx, brandId): Promise<Job>`
  - `upsertFromProvider(tx: WorkerTx, profileId, snap: ProviderAccountSnapshot[]): Promise<ConnectedAccount[]>`
  - `setAccountStatus(tx: WorkerTx, id, s, reason?)`
- **`media.ts`**
  - `createUploadAsset(tx: UserTx, i: UploadRequest): Promise<{ asset: MediaAsset; uploadKey: string; multipart: boolean }>` (the caller presigns; step 5)
  - `completeUpload(tx: UserTx, id): Promise<{ jobId: JobId }>`
  - `registerGeneratedAsset(tx: WorkerTx, i)`
  - `markAssetReady(tx: WorkerTx, id, f: VerifiedMediaFacts)` (also readies linked `probing` sources)
  - `markAssetFailed(tx: WorkerTx, id, code)` (the asset trigger fails linked pending, fetching or probing sources with the same code, V13; after deleting the media-bucket copy the worker calls `markAssetDeleted`, V21)
  - `markAssetDeleted(tx: WorkerTx, id)`
- **`sources.ts`**
  - `registerUploadSource(tx: UserTx, i: { brandId; mediaAssetId; title?; attest: true })` (calls `register_source`)
  - `registerDriveSource(tx: UserTx, i: { brandId; url; title?; attest: true })` (uses `parseDriveUrl`, then `register_source`)
  - `getSource(tx: UserTx, id)`, `listSources(tx: UserTx, brandId)` (never select `origin_url`)
  - `getSourceForFetch(tx: WorkerTx, id)` (the only read of `origin_url`)
  - `updateSourceProbe(tx: WorkerTx, id, f)`
  - `setSourceStatus(tx: WorkerTx, id, s, err?)` (the trigger clears `origin_url` on every status other than `pending` and `fetching`; V7)
- **`transcripts.ts`**
  - `requestTranscription(tx: UserTx, sourceId): Promise<{ transcriptId; jobId: JobId | null; reservationId; reused: boolean }>`
  - `appendSegments(tx: WorkerTx, id, segs)`
  - `completeTranscript(tx: WorkerTx, id, r)`
  - `failTranscript(tx: WorkerTx, id, code, fallback?)`
  - `getTranscriptPage(tx: UserTx, sourceId, q: { fromMs?; toMs?; limit })`
- **`clips.ts`**
  - `requestClips(tx: UserTx, i: ClipRequest)`
  - `completeClip(tx: WorkerTx, id, out, thumb?): Promise<{ clip; draftId }>`
  - `failClip(tx: WorkerTx, id, err)`
  - `discardClip(tx: UserTx, id)`
- **`jobs.ts`**
  - `createJob(tx: UserTx, i): Promise<{ job; deduplicated }>`
  - `getJob(tx: UserTx, id)`, `cancelJob(tx: UserTx, id)`
  - `transitionJob(tx: WorkerTx, id, to, patch)`
  - `heartbeat(tx: WorkerTx, id, processedSeconds?)` (sets `heartbeat_at` and `processed_seconds`, V20; for media jobs also extends the job's open reservations with `meter_extend`)
  - `completeRender(tx: WorkerTx, jobId, outputs: MediaAssetId[]): Promise<{ draftId: DraftId }>`
  - `failStaleJobs(tx: SystemTx, o: { heartbeatOlderThanSec; queuedOlderThanSec })`
- **`voice.ts`**
  - `saveVoiceProfile(tx: UserTx, i)`
  - `getActiveVoiceProfile(tx: UserTx, brandId)`
  - `listVoiceProfileVersions(tx: UserTx, brandId)`
- **`drafts.ts`**
  - `createDraft(tx: UserTx, i: CreateDraftInput): Promise<DraftView>` (atomic: draft, variants and first revisions)
  - `addVariants(tx: UserTx, i: AddVariantsInput): Promise<DraftView>` (atomic; first revisions default to the clip's output or the render's outputs; C9)
  - `saveRevision(tx: UserTx, i: SaveRevisionInput): Promise<VariantRevision>` (runs `validateVariantContent`)
  - `submitForApproval(tx: UserTx, variantIds)`
  - `getDraft(tx: UserTx, id)`
  - `listDrafts(tx: UserTx, f, page)` (keyset on `last_activity_at, id`; reads `v_draft_summaries`)
  - `archiveDraft(tx: UserTx, id)`, `deleteDraft(tx: UserTx, id)`
- **`approvals.ts`**
  - `decide(tx: UserTx, i: { revisionIds; decision; reason? }): Promise<Approval[]>`
  - `listApprovals(tx: UserTx, draftId)`
- **`posts.ts`**
  - `scheduleVariant(tx: UserTx, i: { variantId; scheduledAt })`
  - `reschedulePost`, `cancelPost`, `retryPost` (all `UserTx`)
  - `getPostStatus(tx: UserTx, q: { postId? ; draftId? })`
  - `listCalendar(tx: UserTx, brandId, r)`
  - `listDuePosts(tx: SystemTx, limit)`
  - `claimPost(tx: WorkerTx, id, workerId): Promise<ClaimOutcome>`
  - `startAttempt(tx: WorkerTx, postId, clientRequestId)`
  - `finishAttempt(tx: WorkerTx, id, r)`
  - `recordOutcome(tx: WorkerTx, id, o: PublishOutcome): Promise<'applied' | 'already_applied'>`
  - `findPostByProviderRef(tx: WorkerTx, r: { requestId?; jobId? })` (posts first, then `post_attempts`; C14)
  - `markStuckUnknown(tx: SystemTx, olderThanSec)`
  - `listPostsDueForCheck(tx: SystemTx, limit)`, `notePostChecked(tx: WorkerTx, id, nextAt: Date | null)` (R2)
  - `releaseHolds(tx: SystemTx, ws)`
- **`imports.ts`**
  - `upsertImportedPosts(tx: WorkerTx, accountId, items)` (deduplicates by real account; matching by trigger)
  - `listImportedPostsForVoice(tx: UserTx, brandId, q)`
  - `setExcludedFromVoice(tx: UserTx, id, v)`
- **`analytics.ts`**
  - `upsertAccountSnapshots(tx: WorkerTx, rows)`
  - `insertPostSnapshots(tx: WorkerTx, rows)`
  - `getAnalytics(tx: UserTx, q)`
  - `getPostPerformance(tx: UserTx, q: { brandId; from; to })`
- **`usage.ts`**
  - `getUsageSummary(tx: UserTx)` (clip seconds, render seconds, storage, X link posts)
  - `settle(tx: WorkerTx, id, actual)`, `release(tx: WorkerTx, id, reason)`, `extend(tx: WorkerTx, id, until)`
  - `expireReservations(tx: SystemTx, limit)`
  - `setPoolPeriod(tx: SystemTx, i)`
  - `grantBonus(tx: SystemTx, i)`, `adjust(tx: SystemTx, i)` (all three need a staff `SystemCtx`; the actor comes from it)
- **`inbound.ts`**
  - `recordInboundEvent(tx: IngestTx, e): Promise<{ id; duplicate: boolean }>` (drops Stripe payloads)
  - `claimInbound(tx: SystemTx, limit)`, `markInboundProcessed(tx: SystemTx, id, err?)`, `purgeInbound(tx: SystemTx, olderThan)`
- **`secrets.ts`**
  - `storeSecret(tx: WorkerTx, k: Keyring, i): Promise<SecretId>`
  - `loadSecret(tx: WorkerTx, k: Keyring, id): Promise<Uint8Array>`
  - `listForRewrap(tx: SystemTx, belowVersion, limit)`
  - `rewrapSecret(tx: WorkerTx, k, id)`
- **`audit.ts`**
  - `listAuditEvents(tx: UserTx, f, page)`
- **`testing/fixtures.ts`** (dev-only export): `createTestUser`, `seedWorld`, `seedBrand`, `seedAccount`, `seedReadyMedia`, `seedReadySource`, `seedApprovedVariant`, `seedPost`, `setComp`, `markExternalResourcesDeleted` (as `postgres`; also sets the workspace to `pending_deletion`, V30).

## 8. Tests

### 8.1 How tests run

**Locally:**

| Command | What it does |
|---|---|
| `pnpm db:start` | `supabase start -x studio,imgproxy,mailpit,edge-runtime,logflare,vector,realtime,storage-api` (exact service names vary with the CLI version **[U]**; the CLI is pinned) |
| `pnpm db:reset` | `supabase db reset && psql -f scripts/db-local-login-roles.sql` |
| `pnpm test:db` | `supabase test db` (pgTAP; every file is `BEGIN … ROLLBACK`) |
| `pnpm test` | Vitest `unit` and `meta` |
| `pnpm test:int` | Vitest `integration` against the local stack, connecting as `app_api`, `app_queue_login`, `app_media_login` and `app_billing_login` |
| `pnpm db:types` | `kysely-codegen` |

**CI** (`.github/workflows/ci.yml`; both jobs are required for merge):
- **`static`:** install, `tsc -b`, eslint (including the boundary fixtures), `check-banned-deps`, `check-provider-boundary`, `check-migrations-immutable`, `pnpm test`.
- **`db`:**
  1. Pinned `supabase/setup-cli`.
  2. `db:start` and `db:reset`.
  3. `supabase db lint --level warning`.
  4. `supabase test db`.
  5. `pnpm db:types && git diff --exit-code`.
  6. `pnpm test:int`, including the EXP and concurrency tests.

**Test conventions:**
- Integration tests create random tenants per test.
- Concurrency tests commit on N separate connections, each holding its transaction open with `pg_sleep(0.05)` so the calls really overlap. They clean up with `tests.purge_workspace`, run as `postgres`, which sets the workspace to `pending_deletion` and marks external resources deleted before deleting (3.4, 3.7).
- Each concurrency test runs `CONC_ROUNDS` times (default 5). **Decision:** fewer than B's 20, but not dropped (cost judge versus security judge).
- msw runs with `onUnhandledRequest: 'error'`; localhost is passed through.

**Step-1 acceptance:**
- CI is green.
- `supabase db push --dry-run` against staging is clean.
- `pnpm db:smoke:staging` connects through Supavisor as every custom login role, completes a `withUser` and `withWorker` round trip, and checks that the server's major version equals `[db] major_version` in `config.toml` (R7).

### 8.2 Migrations and catalog (pgTAP `00_catalog` + CI)

| ID | Asserts |
|---|---|
| MIG-01 | `supabase db reset` from empty applies every migration |
| MIG-02 | `supabase db lint` is clean |
| MIG-03 | Regenerated Kysely types show no diff |
| MIG-04 | Schemas `app` and `private` exist; `public` has none of our objects; `pg_graphql` is absent |
| MIG-05 | The `app` tables equal exactly the 28-table list, and the views equal the 2 views (an unexpected table fails the build) |
| MIG-06 | `columns_are` / `col_type_is` for every table match the fixture |
| MIG-07 | Every enum's labels equal the expected list |
| MIG-08 | Every `app` table has RLS enabled and not forced |
| MIG-09 | The full grant matrix (table and column privileges) equals `grants.expected` |
| MIG-10 | `anon`, `authenticated` and `service_role` have no USAGE or privileges on `app` or `private` |
| MIG-11 | Every SECURITY DEFINER function has `search_path=''`, is owned by `postgres` and is in the allowlist. Every function in `app` and `private` has exactly the grantee set the allowlist records: one runtime role for callable functions, `app_user`, `app_worker` and `app_media_worker` for the context and CHECK helpers, none for internal and trigger functions; only `app_billing` can execute the four billing functions (V22) |
| MIG-12 | Every view has `security_invoker=true` |
| MIG-13 | For every FK, some index's leading column is the FK's first column other than `workspace_id` and `brand_id`. For the brand FK `(workspace_id, brand_id)` itself, an index leading with `brand_id` or `workspace_id` counts (so `transcript_segments`, `revision_media` and the snapshot tables are covered by their `brand_id` indexes); for any other FK with no such column, its first column. The index is either not partial or partial only on `<that column> IS NOT NULL` |
| MIG-14 | Tenant tables have `workspace_id NOT NULL` (except the pool-capable usage tables, `inbound_events`, `audit_events` and `platform_rules`); brand tables have the composite brand FK |
| MIG-15 | Every table with `updated_at` has the touch trigger |
| MIG-16 | Append-only triggers exist on `variant_revisions`, `revision_media`, `approvals`, `usage_ledger`, `voice_profiles`, `transcript_segments` and `audit_events`. The only updates they allow are `approvals.superseded_*` once, `voice_profiles.is_active` true → false, and on `usage_ledger` reserve rows an increase of `expires_at` and a single `resolved_at` |
| MIG-17 | No `timestamp without time zone` columns |
| MIG-18 | Role shapes match 6.1: login roles are NOINHERIT with the exact memberships; no runtime role has SUPERUSER, BYPASSRLS, CREATEROLE or CREATEDB; `app_media_login` can't `SET ROLE` to `app_worker`, `app_system` or `app_billing`, and `app_queue_login` can't `SET ROLE app_billing` (V22) |
| MIG-19 | (Vitest) `app.platform_rules` rows equal `PLATFORM_RULES` |
| MIG-20 | (Vitest TOML parse) `[api].schemas` excludes `app` and `private` |
| MIG-21 | (CI) Merged migration files are unchanged compared with `origin/main` |
| MIG-22 | (CI) No `package.json` lists `ytdl-core`, `@distube/ytdl-core`, `yt-dlp*`, `youtube-dl*`, `play-dl` or `youtubei.js` |
| MIG-23 | (ESLint and script fixtures) Importing `upload-post` outside `packages/posting`, or `pg` / `kysely` outside `packages/db`, fails lint; `check-provider-boundary` fails on a fixture outside `packages/posting` that contains `https://api.upload-post.com/` or reads `UPLOAD_POST_API_KEY`, and passes a `docs.upload-post.com` citation (R5); a `console.log` in `packages/` fails lint (R6); an un-awaited query inside a `withUser` callback fails lint (R7) |
| MIG-24 | No function in `app` or `private` is executable by PUBLIC (`has_function_privilege('public', f, 'execute')` is false for every one), including a SQL and a plpgsql function created by a test migration after the first, which checks that the global default-privilege revoke is in effect (V1); every internal function is SECURITY INVOKER (C36) |

### 8.3 Constraints and triggers (pgTAP `10_*`)

**Tenancy and billing**

| ID | Asserts |
|---|---|
| CON-01 | `ensure_workspace` is idempotent and creates a workspace plus a `workspace_billing` row (inactive, zeros); a second workspace for the same owner is rejected |
| CON-02 | An empty workspace name or one over 80 characters is rejected; `Mars/Base` is rejected and `Europe/Berlin` accepted (workspace and brand) |
| CON-03 | Deleting an `auth.users` row that owns a workspace is rejected (RESTRICT) |
| CON-04 | `workspace_billing`: wrong `cus_` / `sub_` prefixes, end ≤ start, negative quantities or limits (including render seconds and storage), and comp values without a reason and setter are all rejected |
| CON-05 | `platform_rules`: cap ≤ 0, `max_attempts` outside 1–100 and inconsistent carousel bounds are rejected; no runtime role can write |

**Brands, profiles, accounts, secrets**

| ID | Asserts |
|---|---|
| CON-06 | Brand name bounds; a case-insensitive duplicate among non-archived brands is rejected, an archived duplicate allowed, the same name in another workspace allowed |
| CON-07 | Status consistency checks hold (suspended needs a reason and timestamp; archived needs `archived_at`); the status trigger stamps `archived_at` and `suspended_at` on entry and clears them (and `suspended_reason`) on exit; a suspend without a reason raises `AP004`; `app_user` writing `archived_at`, `suspended_at` or `suspended_reason` directly raises 42501 (V4) |
| CON-08 | A web user can go active→archived, archived→active and suspended(`plan_limit`)→active, and each passes the CHECKs (V4); a user moving to suspended gets `AP004`; an MCP context inserting or updating any brand column gets `AP009`; the system can suspend with a reason; `workspace_id` is immutable |
| CON-09 | Inserting a brand creates a pending `provider_profiles` row whose ref matches `^b_[0-9a-f]{32}$` |
| CON-10 | The ref is immutable (`AP004`), unique and never reused; at most one pending or active profile per brand; profile transitions outside 3.4 raise `AP004` |
| CON-11 | Archiving a brand sets its profile's `delete_after` to now + 7 days and suspending it to now + 30 days; reactivation clears it; reactivating a brand whose profile is deleting or deleted creates a new pending profile with a new ref |
| CON-12 | A second live account for the same (brand, platform) is rejected; it is allowed after the first is disconnected; upserting the same identity under the same profile reactivates the existing row instead of inserting one; `set_account_status` can set `reauth_required` or `disconnected` but not `connected` (`AP004`). Profile replacement (V5): a profile entering `deleting` disconnects its accounts (`profile_deleted`) and audits it; after reactivation, upserting the same identity under the new profile inserts a new live row; with the old row forced live (as `postgres`), the upsert disconnects it (`profile_replaced`) instead of hitting a unique index; a snapshot that both drops an identity and adds another on the same platform succeeds in one call; a claim on an account whose profile isn't `active` is held |
| CON-13 | The same (provider, platform, `provider_account_id`) live in two brands of one workspace is rejected; live in two workspaces is allowed |
| CON-14 | A profile from another brand, or `workspace_id` A with a brand from B, fails the composite FK |
| CON-15 | Platform, `provider_account_id` and profile are immutable |
| CON-16 | `capabilities` must be an array and `destination` an object, within the size caps; `upload_post` with a credential is rejected; `disconnected_at` must be consistent with status; a `destination` update from an MCP context is denied, and a web update writes `account.destination_changed` |
| CON-17 | `encrypted_secrets`: a bad IV, tag or wrapped-DEK length, or an unknown `alg`, is rejected; owner, purpose and workspace are immutable; a duplicate (owner_kind, owner_id, purpose) is rejected; the owner must exist in the same workspace |

**Media and sources**

| ID | Asserts |
|---|---|
| CON-18 | `r2_key` equals `ws/<ws>/b/<brand>/<seg>/<id>/<filename>` with `<seg>` = src, med, out or drv by purpose; `upload_key` is `stg/<ws>/<id>` for uploads and NULL otherwise; supplying either raises; filenames containing `/` or `..`, with a leading `.`, or over 128 characters are rejected |
| CON-19 | Identity, purpose and filename are immutable; `bytes`, `sha256` and `duration_ms` are immutable once ready |
| CON-20 | `ready` requires bytes, sha256 and `ready_at`; ready video or audio requires a duration; a kind/MIME mismatch (video with `image/png`) is rejected; `image/svg+xml`, `image/tiff` and `video/x-msvideo` are rejected for every purpose, and `audio/mpeg`, `video/webm` or `video/x-matroska` for `post_media`, while `video/x-matroska` is accepted for `clip_source` (R1); width or height 16,385, more than 50 MP, and a duration over 12 h are rejected (R1); an upload without `declared_bytes`, a video over 10 GiB, `bytes > declared_bytes`, and purpose/origin mismatches are rejected |
| CON-21 | A user insert of a render origin, with status ≠ `pending_upload`, with purpose `render_output` or `derived`, or without `drafts:write` or `clips:write`, is rejected; the media state machine holds (an `upload` can't go from `pending_upload` to `ready` without `verifying`; `ready` can only become `deleted`); media referenced by a revision, a live source, an active clip or a brand logo can't move to `deleted` as `app_worker`, nor through a definer path running as `postgres` (V30), but can once the workspace is `pending_deletion` (purge); a failed asset whose source has failed can move to `deleted` (V21); marking an asset `failed` fails its pending, fetching or probing sources with the same `error_code` (V13) |
| CON-22 | Sources with these hosts are rejected: `youtube.com`, `www.youtube.com`, `m.youtube.com`, `music.youtube.com`, `youtu.be`, `www.youtube-nocookie.com`, `r1.googlevideo.com`, `i.ytimg.com` |
| CON-23 | `https://drive.google.com@youtube.com/watch?v=x`, `https://drive.google.com:443/file/d/x`, `HTTPS://DRIVE.GOOGLE.COM/x` and `http://drive.google.com/x` are rejected; `https://drive.google.com/file/d/x` is accepted; an `origin_host` that differs from the URL host is rejected; the worker can set `origin_url` to NULL and never set it again; a source with a URL in any status other than `pending` or `fetching` is rejected by the CHECK, and any move to such a status (including `failed` straight from `pending`) leaves `origin_url` NULL (V7) |
| CON-24 | `google_drive` with a dropbox host, `www.googleapis.com`, `graph.microsoft.com` and `example.com` are rejected; `contoso-my.sharepoint.com` is accepted for `onedrive`; uses the shared host fixture |
| CON-25 | A direct `app_user` INSERT into `source_media` raises 42501; `register_source` without attestation gives `AP007`; an upload with a URL is rejected; a drive link without URL, host or provider is rejected; a supplied `attested_by_user_id` is overwritten with the caller; `attested_via` equals the context's `via`; an `mcp` caller without the workspace's standing web attestation gets `AP009`, and succeeds once `attestRights` has run in a web context; an MCP context can't write the workspace's rights columns (V32) |
| CON-26 | A source asset that is a render, a derived file or an image is rejected; `register_source` with a failed or deleted asset gives `AP013` (V13); `register_source` with a YouTube URL gives `AP018`; `ready` requires an asset and a duration; the source state machine holds |

**Transcripts and clips**

| ID | Asserts |
|---|---|
| CON-27 | One non-failed transcript per source (allowed again after failure); one non-failed original per (brand, sha256); `reservation_id` must be a `clip_seconds` `reserve` row in the same workspace (a settle row, a `render_seconds` reserve or another workspace is rejected; V2); `is_reuse` is immutable; with one original and two reuse rows, hard-deleting the original's source (as `postgres`) succeeds and the reuse rows stay `is_reuse` (C2) |
| CON-28 | Transcript state machine; `completed` requires `completed_at`; a reuse row must be `completed` |
| CON-29 | Segments with end ≤ start are rejected; inserts are allowed only while `running`; update or delete after `completed` raises; `app_user` sees 0 segments of a `running` transcript and all of them once it is `completed`, while `worker(A)` sees them throughout (V20) |
| CON-30 | 2,999 ms and 600,001 ms are rejected, 3,000 and 600,000 accepted; an end beyond the source duration raises; aspect ≠ 9:16 is rejected; another source's transcript fails the FK; a duplicate active range is rejected (allowed after discard); a 61st active clip on one source gives `AP019` |
| CON-31 | `ready` requires an output and a draft with `source_clip_id`; transitions outside the 3.7 clip state machine raise `AP004`; a user may only set `discarded` (anything else raises `AP004`); `proposed` → `failed` or `discarded` and `rendering` → `failed` release the render reservation, while `rendering` → `discarded` settles it in full (V20) |

**Voice**

| ID | Asserts |
|---|---|
| CON-32 | A save creates version n+1 as active and deactivates n; one active version per brand; content over 64 KB or not an object is rejected; updating content raises; only `is_active` true→false is allowed; an imported-post ID from another brand gives `AP001` |

**Drafts, revisions, approvals**

| ID | Asserts |
|---|---|
| CON-33 | One variant per platform; platform is immutable; variant transitions outside 3.9 raise `AP004` |
| CON-34 | A revision whose account is on another platform or brand fails the FK; a revision whose `brand_id` differs from its variant's fails the FK; revisions and revision media are immutable (UPDATE raises `AP004`, direct DELETE raises); no runtime role has an INSERT, UPDATE or DELETE grant on `revision_media`, `app_user` can SELECT it under **br** and workers can SELECT it (V10) |
| CON-35 | A stale `p_expected_revision` raises `AP006`; revision numbers are sequential |
| CON-36 | Saving with unready media raises `AP013`; `content_kind` is derived; an X body with `https://` and `contains_link=false` is rejected; an X revision with `link_url` and `contains_link=false` is rejected; `x_link_handling` only on X with links; `validated_ok` must equal `validation.ok`; an unsupported kind (text to Instagram, document to X) or an out-of-range carousel count raises `AP007`; a destination outside the account's capabilities raises `AP007`; an omitted destination copies the account's default; a `captions` asset with role `item`, or a video with role `captions`, raises `AP007` (R9); a `video/webm` or `audio/mpeg` clip source attached to a revision raises `AP007` (V11); a `ready` render output of a clip still `rendering`, or of a render job still `running`, raises `AP013`, and is accepted once the clip is `ready` or the job has succeeded (V20) |
| CON-37 | `content_hash` equals the fixture hex; identical content gives an identical hash; changing the body, media order, media sha256, account, destination, alt text or options changes it |
| CON-38 | Saving while a live post exists raises `AP008`; saving supersedes the approval in effect (`new_revision`) and sets the variant to `editing` |
| CON-39 | Decide gates: not the latest revision → `AP006`; `validated_ok` false → `AP007`; no account, or a re-auth account → `AP011`; suspended brand → `AP010`; X link without handling → `AP014`; a stored hash tampered with as `postgres` (triggers disabled) → `AP006` |
| CON-40 | `via=mcp` raises `AP009`; `via=mcp_app` raises `AP009` in step 1, even with `posts:approve`; `web` succeeds; `decided_by`, `decided_via` and `oauth_client_id` equal the context (no parameter exists) |
| CON-41 | Approvals are append-only: updating the decision, hash or decider raises; a direct DELETE raises; `superseded_*` can be set once; one decision in effect per variant |
| CON-42 | A batch decision with one bad revision writes no approvals |
| CON-43 | Rejecting an approved variant supersedes the approval and cancels scheduled and held posts with `approval_revoked`; `publishing` posts are untouched |

**Posts and attempts**

| ID | Asserts |
|---|---|
| CON-44 | Scheduling with no approval or a rejection raises `AP005`; with a superseded approval, `AP005`; a direct INSERT as `postgres` using another revision's approval or another account fails the FK |
| CON-45 | `scheduled_at` earlier than now − 60 s or later than now + 365 d raises `AP007`; the CHECK enforces the window against `scheduled_set_at`; a post created 400 days ago and held since can be rescheduled to now + 30 d (C13) |
| CON-46 | Scheduling raises `AP010` for a suspended or archived brand, `AP011` for a re-auth or disconnected account, and `AP015` for inactive entitlements |
| CON-47 | A second live post for the same variant is rejected; after cancel, the same approval can be scheduled again; after publish, scheduling raises `AP005` (and a direct insert hits `posts_one_per_approval`); a re-approval of the same revision allows exactly one new post |
| CON-48 | `idempotency_key` is `pst_<hex>_g1`, can't be written, and becomes `_g2` after `retry_post`, which also resets `attempt_count` |
| CON-49 | Table-driven over all 121 (from, to) pairs: every pair outside 3.10 raises `AP004`, every allowed pair succeeds |
| CON-50 | After `published`, only `platform_post_id`, `post_url`, `needs_id_followup`, `next_check_at` and `check_count` change; lineage columns, including `provider_account_id`, are immutable |
| CON-51 | `published` needs `published_at`; `canceled` needs `canceled_at`; held, failed, needs_attention, canceled and skipped need `status_reason`; dispatched statuses need `dispatched_at` and `provider_request_id` |
| CON-52 | `retry_post` works only from `failed`, requires a live approval and bumps the generation; `cancel_post` refuses publishing, submitted and unknown |
| CON-53 | Rescheduling works only from scheduled or held, needs no re-approval, updates `scheduled_set_at`, and writes `post.rescheduled` |
| CON-54 | `post_attempts` is unique on (post, generation, `attempt_no`); `outcome` and `finished_at` are consistent |

**Imports, analytics, jobs, inbox, audit, usage**

| ID | Asserts |
|---|---|
| CON-55 | `imported_posts` is unique on (brand, platform, `provider_account_id`, `platform_post_id`), so an import through a new account row of the same identity updates instead of duplicating; the platform must match the account; `thumbnail_url` must be https; `matched_post_id` is set on insert when our post exists, and later when our post's `platform_post_id` arrives |
| CON-56 | Post snapshots have exactly one parent and one row per checkpoint; a snapshot whose account differs from its post's or imported post's fails the FK; metrics are non-negative; account snapshots are unique per (brand, provider, platform, `provider_account_id`, date, `metric_window`) |
| CON-57 | Job state machine; finished statuses need `finished_at`; `input` needs `schema_version` and a size bound; a duplicate active (brand, kind, `input_hash`) is rejected (allowed after finish); `idempotency_key` is unique per (brand, kind) (V29); `processed_seconds` can't decrease (V20); `input->'asset_ids'` must be an array of at most 50 |
| CON-58 | `inbound_events` is unique on (source, `event_id`); a Stripe payload must be null; Stripe IDs need the `evt_` prefix |
| CON-59 | Brand creation, brand status, approve, post transition, account status, destination change, entitlement change, voice save, bonus and adjust, and secret store each write exactly one audit row, with actor, `via` and client taken from the context; a bonus, adjust, pool period or comp change records `actor_kind = 'staff'` and the handle from the context, and without a staff handle raises `AP009` (R10); no runtime role can insert, update or delete audit rows |
| CON-60 | `usage_balances`: `reserved + consumed > granted + bonus` raises; negatives raise; lowering `granted` or `granted_target_hwm` raises for every caller, including `postgres` and with `app.adjusting` set by `set_config` (V17); `set_pool_period` lowering a pool's `granted` raises; `period_start` is immutable and `period_end` can only move earlier; overlapping periods for the same (workspace, meter) are rejected; two pool rows with the same (pool, meter, period) are rejected |
| CON-61 | `usage_ledger`: UPDATE raises, except an increase of a reserve row's `expires_at` and a single `resolved_at`; a direct DELETE raises; a workspace cascade works; a second resolution for a reservation is rejected; the sign rules for each kind hold |
| CON-62 | `updated_at` is touched on every [ts] table |

**Cascades and lifecycles**

| ID | Asserts |
|---|---|
| CON-63 | Deleting a workspace raises `AP004` while any profile isn't `deleted` or any asset is `verifying`, `ready` or `failed`; once those are marked, the delete removes its rows from every tenant table, leaves the other workspace's rows, and keeps audit rows (C34) |
| CON-64 | A brand hard delete, as `postgres` (the purge helper) after marking external resources deleted (V19), is guarded the same way, then cascades through every brand table, including posts and approvals (the NO ACTION FKs are satisfied at statement end) |
| CON-65 | A draft with posts can't be deleted; a draft without posts can; media referenced by `revision_media` can't be hard-deleted |
| CON-66 | Job terminal cascade (C3, V6, V20): failing a `transcribe` job, or canceling it while queued, fails its pending or running transcripts and releases their reservation, found through `transcripts.reservation_id` (unless another pending or running attempt shares it); canceling or stale-failing a **fallback** attempt's job resolves the shared reservation (it is not left held until expiry); canceling a running `transcribe` job settles `least(reserved, processed_seconds)`; a failed `clip_render` job fails its proposed or rendering clips and releases their render reservations, while a canceled one discards them (proposed released, rendering settled in full); a `media_verify` or `source_ingest` job fails the asset and its pending, fetching or probing sources, and a canceled or stale `source_ingest` leaves `origin_url` NULL (V7); a failed `render_*` job releases its reservation and one canceled while running settles it |
| CON-67 | Drafts inserted by a user context get `created_by_user_id`, `created_via` and `oauth_client_id` from the context, and `origin` from `via`, whatever was supplied; `last_activity_at` can't be written by `app_user` (C20) |
| CON-68 | For a suspended and for an archived brand, `register_source`, `complete_upload`, a media insert, `request_transcription`, `request_clips`, `create_job` (every kind), a draft insert, `save_variant_revision`, `decide_variants` and `schedule_variant` each raise `AP010`; reads, draft archiving, post cancellation and clip discards still work (C18) |
| CON-69 | `record_post_outcome` reporting the current terminal state returns `already_applied` without raising and applies a late `platform_post_id`; a different terminal state still raises `AP004` (C39) |
| CON-70 | `complete_upload` moves the asset to `verifying` and creates exactly one `media_verify` job in the same transaction; `register_source` for a drive link creates exactly one `source_ingest` job and stores it in `source_media.job_id`; an upload source follows its asset (pending → probing → ready) (C4) |
| CON-71 | Poll state (R2): `record_post_outcome` leaving a post `submitted` or `unknown`, or `published` with `needs_id_followup`, sets `next_check_at`, and any other final outcome clears it; `note_post_checked` increments `check_count` and moves `next_check_at` (NULL stops polling) without changing the status, also on a published post; `mark_stuck_publishing_unknown` sets `next_check_at = now()`; `list_posts_due_for_check` returns only due posts, across workspaces, as IDs only |
| CON-72 | Brand logo and style (V24): a logo from another brand fails the FK; a `failed`, `pending_upload`, video or `render_output` logo raises `AP007`; a logo asset can't move to `deleted` while referenced; deleting the asset row nulls only `logo_asset_id`; a `style` containing `https:`, `data:` or `file:` is rejected |
| CON-73 | Reservation references (V2): `posts.x_link_pool_reservation_id` accepts a `reserve` row of the `upload_post:x_links` pool with subject `('post', id)` and rejects a workspace reserve, another pool or another post's reservation; `posts.x_link_reservation_id` rejects a pool row and a `clip_seconds` reserve; `jobs.reservation_id` and `clips.render_reservation_id` accept only `render_seconds` reserves of their workspace |

### 8.4 RLS and cross-tenant isolation (pgTAP `20_rls_*`)

**Fixture world:**
- WS-A, owned by `ua`, with brands A1 and A2; WS-B, owned by `ub`, with brand B1.
- One row of every table per brand, one pool row, one inbound event, and audit rows.

**Personas:**
- `anon`
- `ua` (web, all scopes)
- `ua/mcp[A1]` (`mcp`, `brand_ids` [A1], all scopes except `posts:approve`)
- `ua/mcp-nobrand` (`mcp` with scopes but no `brand_ids`)
- `ua/mcp-noread` (`mcp`, [A1], no `content:read` or `analytics:read`)
- `ua/app[A1]` (`mcp_app`, with `posts:approve`)
- `ua/mcp[B1]` (`mcp`, `brand_ids` holding only another tenant's brand) and `ua/mcp[A1,B1]` (V34)
- `ub` (web)
- `worker(A)`, `worker(B)`, `worker(none)`, `media(A)`, `media(B)` (V22)
- `system`, `billing`, `ingest`

**Battery:**

| ID | Assertion |
|---|---|
| ISO-1 | `anon` select raises 42501 |
| ISO-2 | `ua` sees 0 rows of B; `ub` sees 0 rows of A |
| ISO-3 | `ua/mcp[A1]` sees A1 rows and 0 A2 rows (workspace-level tables show only WS-A) |
| ISO-4 | `ua/mcp-nobrand` sees 0 rows (fails closed) |
| ISO-5 | A `ub` INSERT that references A's workspace or brand fails (42501, FK error or `AP001`), including a brand inserted into WS-A (42501, by the brand INSERT `WITH CHECK`; V28) |
| ISO-6 | A `ub` UPDATE or DELETE of A's rows affects 0 rows or raises 42501 |
| ISO-7 | `worker(B)` and `worker(none)` see and change 0 A rows; `worker(A)` sees only A |
| ISO-8 | On function-only and system tables, a direct write by `ua` to its own rows raises 42501 |
| ISO-9 | `ua/mcp-noread` sees 0 rows of read-scoped tables |
| ISO-10 | Foreign brand IDs in a token (V34): `ua/mcp[B1]` sees 0 rows of every table and view, and `user_workspace_ids()` and `user_brand_ids()` are empty; `ua/mcp[A1,B1]` sees A1 rows only, `user_workspace_ids()` returns only WS-A; every user function in the allowlist called by either persona with B's IDs raises `AP001`. An implementation that derives workspaces from `ctx.brand_ids` without intersecting with ownership fails here |

**Coverage per table:**

| Table | Battery | Extras |
|---|---|---|
| workspaces | 1–7 | RLS-X3 |
| workspace_billing | 1, 2, 7, 8 | RLS-X2 |
| platform_rules | 1 | All users can read |
| brands | 1–7 | RLS-X8 |
| provider_profiles | 1–4, 7, 8, 9 | |
| connected_accounts | 1–4, 6, 7, 8, 9 | RLS-X4 |
| encrypted_secrets | — | RLS-X5 |
| usage_balances | 1, 2, 4, 7, 8 | RLS-X1 |
| usage_ledger | 1, 2, 7, 8 | RLS-X2 |
| jobs | 1–4, 7, 8, 9 | |
| media_assets | 1–7, 9 | RLS-X9 |
| source_media | 1–4, 6, 7, 8, 9 | RLS-X11 |
| transcripts | 1–4, 7, 8, 9 | |
| transcript_segments | 1–4, 7, 8, 9 | |
| clips | 1–4, 7, 8, 9 | |
| voice_profiles | 1–4, 7, 8, 9 | |
| drafts | 1–7, 9 | RLS-X7 |
| draft_variants | 1–7, 9 | |
| variant_revisions | 1–4, 7, 8, 9 | |
| revision_media | 1–4, 7, 8, 9 | |
| approvals | 1–4, 7, 8, 9 | |
| posts | 1–4, 7, 8, 9 | |
| post_attempts | 1–4, 7, 8, 9 | |
| imported_posts | 1–4, 7, 8, 9 | |
| account_metric_snapshots | 1–4, 7, 8, 9 | |
| post_metric_snapshots | 1–4, 7, 8, 9 | |
| inbound_events | — | RLS-X6 |
| audit_events | 1, 2, 7, 8 | RLS-X2 |
| v_draft_summaries, v_post_performance | — | RLS-X10 |

**Extras:**

| ID | Asserts |
|---|---|
| RLS-X1 | Pool rows are invisible to every user persona |
| RLS-X2 | `workspace_billing`, `usage_ledger` and `audit_events` return 0 rows to MCP personas |
| RLS-X3 | `ua` can update `name` and `timezone`; any other column raises 42501; MCP can't update |
| RLS-X4 | Only `destination` is updatable, only by `ua` (web) with `accounts:connect`; `handle` raises 42501; MCP personas update 0 rows |
| RLS-X5 | `app_user` SELECT and INSERT both raise 42501, even on its own workspace; `worker(A)` reads and inserts only A |
| RLS-X6 | `ingest` can INSERT and SELECT(`id`) only; `app_user` and `app_worker` are denied; `system` works only through functions |
| RLS-X7 | `ua/mcp[A1]` without `drafts:write` can't insert drafts, and can't insert a draft for A2 |
| RLS-X8 | Any MCP persona inserting or updating a brand gets `AP009` |
| RLS-X9 | Media with status `deleted` is hidden; a media insert without `drafts:write` or `clips:write` is denied |
| RLS-X10 | Views obey RLS (ISO-2 and ISO-3 hold through them) |
| RLS-X11 | `app_user` selecting `source_media.origin_url` raises 42501, even on its own rows; `worker(A)` can read it; `media(A)` gets 42501 (V22) |
| RLS-X12 | Media role (V22): `media(A)` reads and writes only A's rows of its tables, and gets 42501 on `encrypted_secrets`, `workspace_billing`, `posts`, `connected_accounts` and `provider_profiles`, and on every worker, system and billing function; `app_media_login` can't `SET ROLE app_system`; `system` can't execute the billing functions, while `billing` can |

**Function battery:**

| ID | Asserts |
|---|---|
| FN-01 | Every user-callable definer function in the allowlist, called by `ub` with A's IDs, raises `AP001` with no side effects (row counts and audit unchanged); the test iterates the allowlist |
| FN-02 | Every worker function called by `worker(B)`, and every media function called by `media(B)`, with A's IDs raises `AP001` |
| FN-03 | A cross-tenant ID and a random UUID raise identical errors |
| FN-04 | Every internal and trigger function, called directly by `app_user`, `app_worker`, `app_media_worker`, `app_system`, `app_billing` or `app_ingest`, raises 42501 (C36); so does every callable function called by a role other than its grantee, including a scratch role that has USAGE on both schemas and no other grant, which is what catches a leftover PUBLIC grant (V1) |
| FN-05 | Render inputs (V23): `ua/mcp[A1]` creating a `render_carousel` or `render_video` job whose `asset_ids` include an A2 asset, a B1 asset, a `failed` asset or a `derived` asset raises `AP001` with no job and no reservation |
| FN-06 | Job idempotency keys (V29): the same key and kind in A1 and A2 create two jobs; reusing an A1 key with a different input raises `AP012`; `create_job` never returns a job outside `user_brand_ids()` |

### 8.5 Metering, limits, caps, X links and concurrency (pgTAP `30_metering` + Vitest)

**Entitlements and periods**

| ID | Asserts |
|---|---|
| MET-01 | `apply_entitlements` writes the mirror and computed columns, bumps the version, writes `entitlement.changed`, and is idempotent |
| MET-02 | The first reserve lazily opens a balance with the granted amount and period from `workspace_billing`, plus a `period_open` row |
| MET-03 | A comp-only workspace uses the UTC month and rolls over automatically, with `ent_period_*` left unchanged (`private.current_period` advances; V16); once `comp_expires_at` is on or before the next month's start, no new period opens and the reserve gives `AP015` (R10) |
| MET-04 | No plan → `AP015`; `past_due` blocks clip and render reservations with `AP015` but claims still succeed |
| MET-05 | A period past its end with no renewal → `AP015`; after a new snapshot is applied, the reserve works |

**Reserve, settle, release**

| ID | Asserts |
|---|---|
| MET-06 | A reserve within the limit adds a ledger row with `expires_at` and increases `reserved` |
| MET-07 | Reserving exactly the remaining amount succeeds; remaining + 1 gives `AP003`, no ledger row and an unchanged balance |
| MET-08 | The same key replays the same reservation with no double count (`replayed`, or `replayed_resolved` once resolved); the same key with a different amount or workspace gives `AP012` |
| MET-09 | Settling less than the amount consumes the actual; settling more than the amount is capped at the amount |
| MET-10 | A second settle returns `already_settled`; settle after release returns `already_released`, and vice versa |
| MET-11 | The reconciler touches only unresolved reservations past `expires_at`, is idempotent, and acts per subject as 4.4 describes (see MET-42) |
| MET-12 | A settle after rollover lands in the reservation's own period |
| MET-13 | No rollover: unused P1 seconds are absent from P2 |
| MET-14 | Mid-period upgrade with `effective_at` at the period's midpoint (processed a day later) and +10 h grants +18,000 s; a repeated apply grants nothing more |
| MET-15 | Mid-period downgrade leaves `granted` unchanged; the next period is lower |
| MET-16 | 2 extra hours added mid-period are prorated; at the start of a period they give the full 7,200 s |
| MET-17 | A bonus grant is idempotent; an `adjust` credit lowers `consumed`, never below 0; the ledger `actor` is `staff:<handle>` from the context, and a context without a staff handle raises `AP009` (R10) |
| MET-18 | After a scripted sequence, the ledger fold equals the balance |
| MET-19 | A second source with the same sha256 in the same brand reuses the transcript (an `is_reuse` row, same reservation, segments copied, no new ledger rows); an in-flight duplicate gives `AP017`; another brand is charged |
| MET-20 | A failed Whisper attempt opens a fallback row sharing the reservation; the final failure releases it; completing the fallback settles it (V6) |
| MET-21 | A trialing subscription has its clip seconds capped at the trial value and its render seconds at 3 × that |

**Brand limit and profiles**

| ID | Asserts |
|---|---|
| MET-22 | Starter: the second brand gives `AP002`; `extra_brand` × 1 allows it; archived and suspended brands don't count; unarchiving over the limit gives `AP002`; inactive entitlements give `AP015` |
| MET-23 | After `limit + 2` profile creations in the period, the next brand creation gives `AP016`, also when some of those profiles were deleted mid-period (V15); with `limit + 1` profiles not yet deleted, creating a brand gives `AP016` while reactivating a suspended brand that still has its profile succeeds; repeated archive and reactivate cycles can't exceed these bounds (C31); for a comp-only workspace the per-period count restarts each UTC month, so it never becomes a permanent `AP016` (V16) |
| MET-24 | A downgrade suspends the newest brands (`plan_limit`), holds their posts (`brand_inactive`) and schedules their profiles' deletion; an upgrade reactivates the oldest first, `release_holds` re-arms future posts, and stale ones stay held |
| MET-25 | An MCP context creating a brand gets `AP009` |

**Caps and claims**

| ID | Asserts |
|---|---|
| MET-26 | A claim under the cap gives `publishing`, sets `dispatched_at`, increments `attempt_count`, sets `provider_request_id` to the idempotency key, and returns a payload taken only from the revision, including the revision's destination |
| MET-27 | Instagram: after 50 in the window, the 51st is `held/cap_reached` with `not_before` = oldest + 24 h; it succeeds once `dispatched_at` is backdated past the window |
| MET-28 | publishing, submitted, unknown, published, inbox_fallback and needs_attention are counted; failed, canceled and skipped are not |
| MET-29 | A post dispatched 24 h + 1 s ago is not counted |
| MET-30 | Caps are per real account: posts dispatched under another row of the same identity (reconnect under a new profile, `account_moved`, or another workspace) share the window; different identities don't (C29) |
| MET-31 | Bluesky's video cap of 25 is separate from the general cap of 100 |
| MET-32 | Claim rechecks: superseded approval → `canceled/approval_revoked`; hash mismatch → `held/content_hash_mismatch`; inactive brand, billing or account → held with that reason and `not_before = NULL`; not yet due → `not_due`; already publishing → `not_claimable` |
| MET-33 | A held post with a past `not_before` can be claimed again; one with a null `not_before` can't |

**X links**

| ID | Asserts |
|---|---|
| MET-34 | `keep` with an allowance of 0 gives `held/x_link_quota_exhausted` with `not_before = NULL` and writes no `reserve` rows (only the `period_open` row when the balance is new); `release_holds` leaves it held, and a reschedule after a comp grants an allowance claims it |
| MET-35 | `keep` with allowance and pool reserves both (workspace first); published with the link kept settles both; failed or stripped releases both |
| MET-36 | An exhausted pool leaves no workspace reservation behind |
| MET-37 | `safety_margin` is respected |
| MET-38 | Reservations are per claim: claim (g1, c1), a 429 back to `scheduled` releases both, the re-claim (g1, c2) reserves afresh, and publishing settles exactly one reservation per balance; a retry (g2) gets a new reservation (C28) |
| MET-39 | `strip` is claimed without a reservation; the outcome records `link_stripped = true` |
| MET-40 | `release_holds` after reconnecting an account re-arms future posts and leaves stale ones held |

**Reservation lifetime, renders, storage and retries**

| ID | Asserts |
|---|---|
| MET-41 | A reservation for n s expires at now + 6 h + 3n s; `meter_extend` moves it later and never earlier; extending a resolved reservation fails |
| MET-42 | Reconciler: past `expires_at`, a running transcript with a fresh heartbeat is extended, not released; with a stale heartbeat its job fails and the reservation is released; a completed but unsettled one is settled; a failed one is released as `expire`; a reservation whose first attempt failed but whose fallback attempt is running is treated as live, and one whose fallback completed is settled (V6); posts in publishing, submitted, unknown or needs_attention are never expired (C27) |
| MET-43 | `cancel_job` on a queued transcription releases the reservation; on a running one it fails the transcript and settles `least(reserved, processed_seconds)`; a new `request_transcription` on the same source then succeeds with a new reservation (C3, V20). Cancelling after segments exist: `app_user` can't read them, and the ledger shows the consumption. Discarding a `rendering` clip, or cancelling a running `render_video` job, after its output asset is `ready`: the output can't be attached to a revision, and the render reservation is settled in full (V20) |
| MET-44 | Late completion after a release re-reserves and settles; with no quota left the transcript fails with `reservation_lost` |
| MET-45 | One snapshot that both renews the period and applies Pro → Starter opens the new period at 14,400 s; the old period's balance is untouched (C32) |
| MET-46 | Within one period, adding 2 h, removing them and adding 3 h grants only up to the 3 h target (prorated once), not 5 h (C33) |
| MET-47 | Render meter: `request_clips` reserves the sum of range seconds; `complete_clip` settles the measured duration; discarding a proposed clip or a worker failure releases, discarding a rendering clip settles in full (V20); an exhausted allowance gives `AP003` with no clips inserted; `render_carousel` reserves 5 s per slide; a 4th in-flight render job gives `AP019` (C7, C30) |
| MET-48 | Storage: an upload that would exceed `storage_bytes_limit` gives `AP003` (meter `storage`); a `failed` upload keeps counting until it is `deleted`, and marking it deleted frees the space (V21); the 21st pending upload gives `AP019`; a drive fetch counts toward the limit (C35) |
| MET-49 | A post claimed `max_attempts` times in one generation becomes `failed/too_many_attempts` on the next claim; `retry_post` resets the count (C38) |
| MET-50 | Overlapping periods (V3): a comp-only workspace with a balance for [Nov 1, Dec 1) that subscribes on Nov 10 gets [Nov 10, Dec 10) opened at the new grant, and the old balance ends on Nov 10 with its open reservations still settling there; an early trial conversion and a cancel-then-resubscribe mid-period do the same; a delayed snapshot whose start precedes an already-opened comp month voids that month's balance and logs an alert; `ensure_current_balance` raises `AP017` when an insert is absorbed but no balance exists for the expected start |

**Concurrency** (Vitest; each runs `CONC_ROUNDS` times)

| ID | Asserts |
|---|---|
| CONC-01 | 50 parallel 600 s reserves against 3,600 s: exactly 6 succeed and 44 get `AP003`; `reserved = 3600`; the fold is correct |
| CONC-02 | 20 parallel reserves with the same key give 1 reservation, and every caller gets the same ID |
| CONC-03 | Settle, release and expire racing on one reservation produce exactly one resolution row |
| CONC-04 | Starter: 10 parallel `createBrand` calls produce exactly 1 brand |
| CONC-05 | Brand creation in two workspaces in parallel isn't serialized (both finish within a latency bound) |
| CONC-06 | 20 parallel claims of the same post: exactly 1 is claimed |
| CONC-07 | 60 due posts on one Instagram account, claimed in parallel: exactly 50 claimed and 10 `cap_reached` |
| CONC-08 | X pool of 1 with claims from two workspaces in parallel: exactly 1 pool reservation |
| CONC-09 | 5 parallel schedules of the same variant: 1 post, the others get `conflict` |
| CONC-10 | `decide` racing `save_variant_revision` (50 iterations): the invariant query "approval in effect ≠ latest revision while the variant is approved" returns 0 rows |
| CONC-11 | A claim racing a reject: either the claim wins (`publishing`, untouched by the reject) or the reject wins (`canceled`, and the claim is `not_claimable`) |
| CONC-12 | A claim racing an attempt to change a ready asset's sha256 or bytes: the change always fails, and the payload's sha256 values equal the hash inputs |
| CONC-13 | 10 parallel ingests of the same delivery give 1 row and 9 duplicates |
| CONC-14 | Parallel `request_transcription` on one source gives 1 transcript and 1 reservation; on two sources with the same sha256, 1 charge |
| CONC-15 | 10 parallel `saveVoiceProfile` calls give versions 1–10 with no gaps and one active version |
| CONC-16 | 10 parallel `save_variant_revision` calls with the same expected revision: exactly 1 succeeds and the rest get `AP006` |
| CONC-17 | fast-check, 50 runs over 4 connections, random grant, reserve, settle, release, extend and expire. Invariants: `reserved + consumed ≤ granted + bonus`; balance equals the ledger fold; at most one resolution per reservation |
| CONC-18 | 20 parallel `request_clips` of one 600 s range each against 1,200 render seconds: exactly 2 succeed and the rest get `AP003`, with no overdraw. The allowance is kept below the in-flight cap so the cap can't interfere (V14) |
| CONC-19 | 60 due Instagram posts spread over two account rows of the same identity in two workspaces, claimed in parallel: exactly 50 claimed |
| CONC-20 | 10 parallel uploads whose declared sizes together exceed the storage limit: the counted sum never exceeds it |
| CONC-21 | `save_variant_revision`, `archiveDraft` and `schedule_variant` racing on one draft never deadlock beyond the DAL's retries (lock order drafts → draft_variants) |
| CONC-22 | 10 parallel `create_job(render_video)` calls in one workspace with ample render seconds give exactly 3 jobs and 7 `AP019`; mixing in parallel `request_clips` on two sources still leaves at most 3 render jobs in flight (V14) |

### 8.6 Encryption and logging (Vitest)

| ID | Asserts |
|---|---|
| ENC-01 | Round trip for 1 B, 1 KB and 32 KB, UTF-8 and binary |
| ENC-02 | A fresh DEK and IV on every seal |
| ENC-03 | Tampering with the ciphertext, tag, IV or wrapped DEK raises `DecryptError` and releases no partial plaintext |
| ENC-04 | An AAD mismatch in any field (secretId, workspaceId, purpose, ownerKind, ownerId) raises `DecryptError` |
| ENC-05 | An unknown key version raises `KeyNotFoundError` |
| ENC-06 | A public-only keyring can seal but not open (`NoPrivateKeyError`) |
| ENC-07 | Keyring validation: keys under 3072 bits, malformed PEM, a missing current version, and a mismatched pair (boot self-test) all fail |
| ENC-08 | Rewrap v1→v2 leaves the ciphertext, IV and tag unchanged and sets `keyVersion = 2`; the secret decrypts after the v1 private key is removed; removing v1 before the rewrap makes v1 rows fail loudly |
| ENC-09 | (integration) `storeSecret` as `app_worker` sealing with a public-only keyring, then `loadSecret` as a worker with the private key, round-trips; a `postgres` scan finds no plaintext; `app_user` SELECT and INSERT raise 42501 |
| ENC-10 | Swapping ciphertext columns between two rows makes both fail |
| ENC-11 | Errors never contain key material or plaintext |
| ENC-12 | `hashToken` is deterministic per pepper and differs across peppers; `verifyTokenHash` is timing-safe; `generateToken` gives ≥256 bits with a display of prefix plus the last 4 characters |
| LOG-01 | Real shapes are censored (C25): a pino-http request with `Authorization: Bearer …`, cookies and both signature headers; a `set-cookie` response; an undici/fetch error carrying request headers; an MCP tool-call body with a token five levels deep; a SQLSTATE `err.code` stays visible |
| LOG-02 | A pg error containing a connection URL is logged with its credentials masked |
| LOG-03 | `redactUrl` strips presigned and connect-link query strings |
| LOG-04 | `scrubSecrets` removes Bearer and Apikey values, `token=` and `code=` parameters, PEM blocks, JWTs, `X-Amz-Signature` / `X-Amz-Credential`, `sig=`, `signature=` and `rlkey=` values, and URL query strings (C42); for drive hosts it and `redactUrl` also drop the path, with fixtures for `https://1drv.ms/v/s!Ab…`, `https://www.dropbox.com/s/<key>/x.mp4`, `https://drive.google.com/file/d/<id>/view` and a SharePoint `/:v:/g/personal/<user>/<token>` link (V27); a `post_attempts.error_message` written through the DAL is scrubbed |
| LOG-05 | `redactDeep` censors every key matching `REDACT_KEY_PATTERN` down to depth 8, survives cycles, and leaves non-secret fields untouched |

### 8.7 Data access layer (Vitest integration)

| ID | Asserts |
|---|---|
| DAL-01 | A raw query as `app_api` outside a `with*` helper raises 42501 (NOINHERIT) |
| DAL-02 | `withUser` sets role `app_user` and the context; after commit, on a pool of size 1, the next query sees `app_api` and an empty context |
| DAL-03 | A throw rolls everything back; two parallel contexts each see only their own data |
| DAL-04 | `UserCtx` validation: missing `via`, or an MCP context without `brandIds`, fails before any query; web gets the full scope set; `oauthClientId` reaches `ctx.oauth_client_id` |
| DAL-05 | Type tests: the four transaction types are not mutually assignable, and worker functions reject a `UserTx` |
| DAL-06 | `mapDbError` maps every AP code plus 23503, 23505, 23514, 42501 and 55P03; anything else becomes `internal` with no SQL text; the switch is exhaustive at the type level |
| DAL-07 | A 40P01 deadlock is retried up to 3 times |
| DAL-08 | A cross-tenant ID and a random ID produce the same `not_found` |
| DAL-09 | Invalid zod input fails with no database round trip (query spy) |
| DAL-10 | `createDraft` is atomic; one invalid variant rolls back everything; the returned `contentHash` equals the database's |
| DAL-11 | `saveRevision` runs the validator; a structural error gives `validated_ok = false`; a stale revision gives `stale_revision` |
| DAL-12 | `decide` records the decider, `via` and client from the context; a batch is atomic |
| DAL-13 | `scheduleVariant` uses the approved account; reschedule works only from scheduled or held; cancelling in flight is rejected; retry bumps the generation |
| DAL-14 | The `claimPost` payload is built only from the revision, the media keys and sha256s, the revision's destination and the profile ref; changing the account's default destination after approval leaves the claimed payload unchanged (C1) |
| DAL-15 | `recordOutcome` maps published, inbox_fallback, failed, retryable and rate_limited to the right statuses; a TikTok post published with a null post ID sets `needs_id_followup`; reporting the same terminal outcome twice returns `already_applied` |
| DAL-16 | `listDrafts` and `listCalendar` keyset pagination is stable; a tampered cursor gives a validation error; saving a revision moves the draft to the top of `listDrafts` |
| DAL-17 | `upsertFromProvider` inserts, updates the handle and avatar, reactivates a disconnected row of the same identity (re-arming its held future posts), and on `account_moved` or a new provider ID disconnects the old row in the same transaction |
| DAL-18 | `registerDriveSource` uses `parseDriveUrl` and `register_source`; a raw call that bypasses the parser still hits the CHECKs; no user-side read returns `origin_url` |
| DAL-19 | `requestTranscription` does the reserve, transcript and job in one transaction; `AP003` leaves nothing behind |
| DAL-20 | `getTranscriptPage` pages by time range |
| DAL-21 | `completeClip` creates a draft with origin `clip`, no variants, and marks the clip ready; `addVariants` then creates variants whose first revisions reference the clip's output |
| DAL-22 | `saveVoiceProfile` makes the new version active; `getActiveVoiceProfile` returns the latest |
| DAL-23 | `upsertImportedPosts` dedupes and sets `matched_post_id` when the platform post ID matches one of ours; re-importing after a reconnect adds no rows; a TikTok ID arriving after the import matches it |
| DAL-24 | `getPostPerformance` shows a clip-sourced post's lineage (`source_clip_id`, `voice_profile_id`, h48 metrics, `human_edited`), and imported rows as `source='imported'` |
| DAL-25 | `applyBilling` with a basil fixture reads the period from the items; an unknown lookup key on an active subscription keeps the previous entitlements and returns `kept: true` (C43); suspensions are returned |
| DAL-26 | `recordInboundEvent` returns new, then duplicate; Stripe payloads are dropped |
| DAL-27 | `getUsageSummary` shows limit, reserved, consumed, remaining and period end for clip and render seconds, storage used and its limit, and never pool rows |
| DAL-28 | Meta test: every exported repository function has a happy-path test and a cross-tenant `not_found` test |
| DAL-29 | msw guard: an unmocked `fetch` to an external host throws |
| DAL-30 | Repository return types match the zod output types (`expectTypeOf`) |
| DAL-31 | `createUploadAsset` returns the staging key and the multipart flag (over 100 MB); `completeUpload` creates the `media_verify` job atomically; both need `drafts:write` or `clips:write` |
| DAL-32 | `completeRender` accepts only ready outputs produced by the job in its brand, creates a `render` draft with `source_job_id`, and settles the job's reservation (C9) |
| DAL-33 | `findPostByProviderRef` finds a post by an earlier generation's request ID through `post_attempts` (C14) |
| DAL-34 | `heartbeat` sets `heartbeat_at` and extends the job's open reservations |
| DAL-35 | `dev-seed` refuses when `APP_ENV=production`; a second run changes nothing; it leaves two tenants, each with active brands, an active profile and connected accounts, and each user sees only its own brands; `dev-approve` records a `web` approval that `scheduleVariant` accepts (R3) |
| DAL-36 | `createBrand` in a web context returns the new row through `INSERT … RETURNING` (the brand SELECT policy admits it; V28); `listBrands` in an MCP context shows only the token's brands |

### 8.8 Shared validators and schemas (Vitest unit)

| ID | Asserts |
|---|---|
| VAL-01 | X: 280 weighted passes and 281 fails; a URL counts 23; emoji and CJK count 2; text is NFC-normalized; over 280 requires `long_text_mode` |
| VAL-02 | Bluesky: 300 graphemes pass and 301 fail; text under 300 graphemes but over 3,000 bytes fails |
| VAL-03 | Threads: 500 UTF-8 bytes; more than 5 unique links fails; topic tag rules |
| VAL-04 | TikTok: 2,200 UTF-16 units; `privacy_level` required; branded content can't be private; photo title 90 and description 4,000 |
| VAL-05 | YouTube: title ≤100, no `<` or `>`, required; description ≤5,000 bytes; tag budget of 500 |
| VAL-06 | Instagram: ≤2,200, ≤30 hashtags, ≤20 mentions; text-only fails; carousel ≤10 |
| VAL-07 | LinkedIn 3,000; Pinterest title 100, description 800, link 2,048, alt text 500, board required (in options or the revision's destination); Facebook 63,206 |
| VAL-08 | Content-kind support and carousel minimum and maximum follow `PLATFORM_RULES` |
| VAL-09 | Video duration bounds per platform from media facts (TikTok 3–600 s, Facebook Reels 3–90 s, YouTube Shorts ≤180 s, …) |
| VAL-10 | `extractUrls` finds bare `example.com`; `contains_link` is set (also for `link_url`); X with a link requires `x_link_handling` |
| VAL-11 | An ISO instant without an offset fails; `Z` and `+01:00` pass; the schedule window is enforced |
| VAL-12 | Clip ranges: integer ms, 3–600 s, at most 30; NaN, floats and negatives fail |
| VAL-13 | `parseDriveUrl` accepts Drive, Docs, usercontent, Dropbox, OneDrive, 1drv and SharePoint; it rejects YouTube variants with the own-content message, http, IP literals, userinfo, ports and look-alikes (`drive.google.com.evil.io`, punycode); uses the shared fixture with CON-24. `isAllowedDownloadHop` accepts the download hosts of 7.2 (for example `uc1a2b.dl.dropboxusercontent.com`, `x.files.1drv.com`) for their own provider only, and rejects YouTube, IP literals, userinfo, ports and other providers' hosts (C8, C46) |
| VAL-14 | `PRICE_CATALOG` matches the brief: 800/1500/2500 cents, 1/2/4 brands, 14,400/36,000/72,000 s, add-ons 300 and 100 cents; render seconds are 3 × clip seconds in every entry; storage is 50/100/200 GB |
| VAL-15 | `computeEntitlements`: status mapping, plan plus add-ons, trial caps, comps, an expired comp ignored (R10), unknown keys reported in `unknownLookupKeys`, comp-only UTC month |
| VAL-16 | Every platform has a rule; Instagram 50 ≤ the brief's 100; TikTok 15; X 20; no cap above the brief's figure; `maxAttempts` is 25 everywhere |
| VAL-17 | TypeScript enum arrays equal the `pg_enum` labels (integration) |
| VAL-18 | No `DomainError` user message contains `upgrade`, `buy`, `purchase`, `pricing` or `$` (OpenAI policy [V]) |
| VAL-19 | `VariantOptionsSchema` is strict per platform; `DestinationV1`, `BrandStyleV1`, `CaptionStyleV1`, `ClipRenderSpecV1`, `VoiceProfileContentV1`, `RenderCarouselInputV1` (≤35 slides), `RenderVideoInputV1` (≤180 s) and `UploadRequestSchema` (size caps by kind) bounds hold; `JobInputEnvelope` requires `schema_version`; normalized metrics reject negatives and keep unknown keys in `extra`; `ProviderAccountSnapshot` parses Upload-Post doc sample fixtures, and still parses them with an extra unknown field added, as does `StripeSubscriptionSnapshot` (loose objects for third-party payloads; V9) |
| VAL-20 | `UPLOAD_LIMITS` and `RENDER_LIMITS` equal the numbers in 3.7, 4.5 and 4.6, and the DB constants used by triggers; `ALLOWED_MIME` equals the `media_assets` MIME CHECK lists, and `UploadRequestSchema` rejects `image/svg+xml` (integration parity; R1) |

### 8.9 Data API exposure (Vitest against the local Supabase HTTP API)

| ID | Asserts |
|---|---|
| EXP-01 | REST requests for each `app` table, with the anon key and with a signed-in user's JWT, return not-found and no data |
| EXP-02 | A GraphQL introspection request returns a 404 or no app types |
| EXP-03 | `/rest/v1/rpc/claim_post` returns not found |

## 9. Deferred to later steps

**Step 2: PostingProvider, Upload-Post adapter, job queue**
- **pg-boss:** install the `pgboss` schema by migration, owned and granted to `app_worker`, with `app_media_worker` limited to its own queues (`clip.process`, `render.*`, `media.verify`) if pg-boss's schema allows it, otherwise the same grant (V22). Queues: `post.dispatch` (a cron tick over `list_due_posts`, with `key_strict_fifo` per account [V]), `reconcile.unknown`, `accounts.sync`, `inbound.process`, `reservations.sweep` (`meter_expire_reservations`), `jobs.stale` (`fail_stale_jobs` every 5 minutes with 15 minutes and 24 hours), `profiles.delete`, `inbound.prune`, `clip.process`, `render.*`, `analytics.pull`.
- **Outbox** (decided now; V33): `jobs` is the outbox, drained by a **relay**. An additive system function `app.list_queued_jobs(p_limit)` returns `(job_id, workspace_id, kind)` from `app.jobs`, and the relay enqueues those IDs. Workers build `WorkerCtx.workspaceId` only from `app.jobs` (or from `list_due_posts` / `resolve_profile_ref`), never from a queue payload, so a forged payload can't point a worker at another tenant. `app_user` gets no privilege in schema `pgboss`; step 2's MIG-09 fixture asserts it. Granting `app_user` INSERT on `pgboss.job` is rejected: any Vercel bug or injection could then enqueue work naming another tenant's IDs.
- **`PostingProvider`** in `packages/posting` (the only place that may reference Upload-Post):
  - send `show_calendar:false` and `disable_inbox_fallback=true`;
  - send `async_upload=true` from workers only;
  - Idempotency-Key and `request_id` come from `posts.idempotency_key` [V];
  - media handover: either stream the bytes from the media bucket (verifying sha256 on the way), or pass a short-lived presigned GET of the media-bucket key. Both are safe because only workers can write that bucket (C45).
- **Rate limiting and batching:** a global outbound token bucket that honours `X-RateLimit-*` [V]; `posts.dispatch_group_id` as an additive nullable column if multi-platform batching is adopted.
- **Before calling the provider:** verify each R2 object's sha256 against the payload, and re-detect links with twitter-text.
- **Follow-ups:** reconcile `unknown` and `submitted` posts by `request_id`, and poll for TikTok's late post IDs (`needs_id_followup`). Both are driven by `list_posts_due_for_check`, and each poll that changes nothing calls `note_post_checked` with a backed-off next time (R2). Inbound processing falls back to `post_attempts` for earlier generations (`findPostByProviderRef`).
- **Dev tenants:** a fake `PostingProvider` serves the dev-seed's profiles, which are listed in a dev-only environment allowlist that production ignores, so their posts never reach Upload-Post (R3).
- **Profiles:** provision and delete profiles (pending → active; delete once `delete_after` passes, through an additive system function `app.list_profiles_due_for_deletion`); alert on `PROFILE_LIMIT_REACHED` [V].
- **Account sync after a connect webhook:** an additive system function that enqueues `sync_accounts` for a profile; `connect_account` uses `assert_brand_writable`.
- **Webhook routes:** HMAC check, 5-minute skew limit, then `recordInboundEvent` [V]. The signature check lives in `packages/posting`, so routes never read `UPLOAD_POST_*` (R5).
- **Logger:** wire `REDACT_PATHS` and `redactDeep` into every service, and route unhandled-rejection handlers through `@app/log` (no `console.*`; R6).

**Step 3: MCP server and OAuth**
- An `oauth` schema: clients (CIMD plus DCR fallback), hashed auth codes, grants with `brand_ids` and scopes, refresh-token families with reuse detection, and signing keys whose private keys are sealed with `@app/crypto`.
- Map tokens to `UserCtx`, including `via`, scopes and `oauthClientId`.
- Tool annotations and the `get_transcript` / `make_clips` split as fixed in 7.0.
- **Evaluate in-database identity resolution** (C24): the context would carry only an opaque credential, and `private.ctx()` would look up its hash. This helps only if token and session issuance also moves off the internet-facing tier, because whoever mints credentials can mint them for anyone; it is an evaluation, not a commitment.
- Optional prefixed public IDs at the MCP boundary.
- The tool handlers, using the validators from step 1.
- **Minimal web pages, by the end of step 3** (R3): brand creation and the one-click approval confirmation that the approval-queue link opens (Q18, Q23). Brand writes and approvals are web-only, so the Claude and ChatGPT tests of steps 3–4 need them; `scripts/dev-approve.ts` covers the gap until then. The rest of the web app stays in step 8.

**Step 4: approval card**
- App-only `decide` tools that call `decide_variants` under `via='mcp_app'`.
- `decide_variants` starts accepting `mcp_app` only in the same migration that adds a human-presence check, and only after it is verified on Claude and ChatGPT (I3, Q23). The candidate is an `approval_challenges` table (nonce hash, revision, user, ≤10-minute TTL, `used_at`) whose nonce is never returned in a tool result, after checking whether hosts forward `_meta` or `structuredContent` to the model **[U]**. **Decision:** deferred rather than built now (2 of 3 judges), because its premise is unverified; until then the card's Approve and Reject buttons open the web confirmation.
- A web approval-queue fallback link.

**Step 5: clip worker**
- **R2:** two buckets. The staging bucket takes presigned PUTs and multipart uploads from the web app (above 100 MB); its lifecycle rule deletes objects and aborts incomplete multipart uploads after 1 day. The media bucket is written only by Railway workers (C12, C45).
- **`media_verify`** (runs under `app_media_login`): HEAD the staging object and fail without copying if it exceeds `declared_bytes`; sniff magic bytes with a ranged GET; only then copy staging → `r2_key`; on any later failure delete the copy and move the asset failed → deleted (V21); compute bytes and sha256 from the copy; compare magic bytes and ffprobe's `format_name` with the declared MIME type; read image dimensions from the header and refuse anything over `UPLOAD_LIMITS` before any full decode; measure duration by decoding (packet timestamps, not container headers); then `markAssetReady`, or `markAssetFailed('mime_mismatch' | 'dimensions_exceeded')` (R1). Integration tests use a mis-headered MKV, an SVG renamed `.png` and a tiny 40,000 × 40,000 PNG (C26).
- **Presigned uploads:** every PUT signs `Content-Length` (the whole `declared_bytes`, or each multipart part's length), so a client can't upload more than it declared (V21).
- **Drive fetcher** (C8, C46): runs under `app_queue_login`, the only login that can read `origin_url` and the only service holding `SECRETS_PRIVATE_KEY_V<n>` (V22); writes only an `error_code` on failure, never a URL (V27); check every hop with `isAllowedDownloadHop` and the YouTube denylist; refuse IP literals and DNS results in private, loopback or link-local ranges (SSRF); at most 5 hops; compare `Content-Length` with the storage headroom and abort beyond the declared size; msw fixtures replay real redirect chains; clear `origin_url` when done.
- **Transcription:** verify the copy's sha256, feed at most the reserved seconds (`ffmpeg -t`), heartbeat through `jobs.heartbeat` with the seconds fed so far (which calls `meter_extend`; V20). Whisper with an AssemblyAI fallback. Alert on any workspace whose refunded seconds in a period exceed its grant.
- A `cloud_drive_connections` table (as an owner kind in `encrypted_secrets`) if drive pickers are used.
- Media retention sweepers (Q10), with an additive system function listing assets due for deletion.

**Step 6:** finalise `VoiceProfileContentV1`, the import pipeline and the `write_post` prompt.

**Step 7:**
- `render_templates` and `weekly_reviews` tables; the render worker reports through `complete_render`.
- Renderer hardening (V22, V23, V24): runs under `app_media_login` with no secrets; re-checks that every asset in `asset_ids` and the brand logo is `ready` and of the job's brand before loading it; inserts all text as text nodes, never as HTML; runs Chromium with request interception that allows only presigned GETs of the job's own assets and blocks every other scheme and host.
- The analytics pull cadence (Q16) over the `posts (published_at)` index, and per-post analytics within Upload-Post's 100-per-5-minute limit [V]. Whether that limit is per account or per profile is **[U]**.
- Per-post pull state: an additive `next_metrics_at timestamptz?` on `posts` (added to the post-published exception list) and on `imported_posts`, each with a partial index `WHERE next_metrics_at IS NOT NULL`, so a checkpoint missed under the rate limit is retried and imported posts get a cross-tenant time index (R2).
- Prune non-checkpoint snapshots.
- Measure database growth per heavy user on staging, once snapshot volumes are real, and set a per-user size budget (R4).

**Step 8:**
- Stripe Checkout, portal and webhook routes; the catalog-to-Stripe sync script. Stripe inbound events are applied by a billing processor running as `app_billing_login`, separate from the queue service (V22).
- Configure every decrease (fewer add-ons, plan downgrades) to take effect at period end with no proration credit, and pass `effective_at` to `applyBilling` (C33).
- An hourly re-fetch of stale periods, which also re-applies billing for workspaces whose `comp_expires_at` has passed (an additive system function lists them; R10).
- Account deletion and purge, run by a Railway worker that holds the service-role key (C24). A web-only `app.request_workspace_deletion()` first sets `pending_deletion`. In the same migration, `user_workspace_ids()` returns nothing for non-web contexts of such a workspace; `assert_brand_writable`, `enforce_brand_limit`, `ensure_current_balance` and `register_source` refuse it; `claim_post` and `list_due_posts` skip or cancel its posts (a new `post_status_reason`); and `sync_brand_profile` creates no profiles (R8). The worker then deletes the Upload-Post profiles, then the R2 prefixes in both buckets, marks both done, deletes the workspace (the guard of 3.4 checks the order, and step 8 makes it also require `pending_deletion` for a workspace delete), then the auth user.
- Retention purges.
- Billing Meters, if X links are ever billed.

**Later:** teams (`workspace_members` plus a helper change), a direct X or Meta adapter (`ALTER TYPE posting_provider ADD VALUE`, encrypted credentials), a KMS key provider, a `client_file` media origin (Q21), and partitioning `audit_events` and `post_metric_snapshots`.

## 10. Open questions for the owner

1. **X posts with links.** Upload-Post strips links unless we buy its add-on: $19 a month for 50 link posts shared across all customers, about $0.38 each [V\*]. The brief's $0.20 is only available through a future direct X adapter.
   - *Default:* allowance 0 on every plan and no add-on. For an X variant with a link the choice stays explicit (`AP014` until it is set), and the card preselects "strip" with a warning. "Keep" can still be chosen, but such a post is held (`x_link_quota_exhausted`) until a comp grants an allowance and the user reschedules it (4.7). Revisit when a direct adapter exists (for example Plus 5 and Pro 15 a month).
2. **What counts as a clipping hour?**
   - *Default:* seconds of source video, charged once per unique video per brand when it is first transcribed. Re-clipping doesn't use clipping hours (rendering uses the render allowance, Q20). Jobs that fail on our side are refunded automatically, as are jobs cancelled before they start. A transcription the user cancels while it runs is charged for the audio already processed, and a render the user cancels or discards while it runs is charged in full, so cancel-and-retry can't buy free compute (V20).
3. **Rollover of unused hours.**
   - *Default:* none.
4. **Form of "+$1 per clipping hour".**
   - *Default:* a recurring monthly quantity on the subscription, granted pro rata when added mid-period. One-time packs could come later through bonus credits.
5. **Mid-period plan changes.**
   - *Default:* upgrades apply immediately and pro rata. Downgrades and add-on decreases are scheduled for period end, with no proration credit. Hours already granted are never taken back.
6. **Downgrade below the active brand count.**
   - *Default:* suspend the newest brands and hold their posts. The user can swap which brands stay active (in the web app). Nothing is deleted.
7. **Payment failure.**
   - *Default:* while `past_due`, approved posts keep publishing but new clipping and rendering are blocked. `unpaid` or `canceled` holds everything.
8. **Trial.**
   - *Default:* a 7-day Starter trial, card required, with 1 clipping hour (and 3 hours of render allowance). No free tier.
9. **Accounts per platform.** Upload-Post allows one per profile [V].
   - *Default:* one account per platform per brand. A second Instagram account means a second brand, which uses a brand slot.
10. **Retention after cancellation.**
    - *Default:*
      - Delete a brand's Upload-Post profile 7 days after the brand is archived, and 30 days after it is suspended or the workspace is cancelled (each slot costs about $1–2 a month [V]).
      - Purge workspace data 90 days after cancellation.
      - Delete source videos from R2 30 days after upload.
      - Keep clips and renders while a draft references them.
      - Keep analytics for 13 months.
11. **Instagram cap.** The brief says 100 a day; Upload-Post enforces 50 [V].
    - *Default:* enforce 50, and reword the rule as "the lower of the platform cap and the provider cap".
12. **Upload-Post plan at launch.** This sets the X daily cap (10/20/30) and the number of profiles [V].
    - *Default:* Professional ($50 a month, 25 profiles, X cap 20).
13. **Source upload limits.**
    - *Default:* 4 hours and 10 GB per file; files over 100 MB upload in parts.
14. **Brand churn guard.**
    - *Default:* at most (brand limit + 1) Upload-Post profiles alive at once, and at most (brand limit + 2) created per billing period.
15. **Does approval cover the posting time?**
    - *Default:* no. Approval covers content, the target account and its destination. Rescheduling doesn't need re-approval, but every change is audited and shown on the calendar.
16. **Analytics cadence**, which affects the provider's rate budget.
    - *Default:* account totals daily; per-post metrics at h24, h48, d7 and d30, then stop.
17. **Rights attestation.**
    - *Default:* one "I own or have the rights to this video" checkbox per source, recorded against the user who ticks it and the channel it came through. Because an AI client can set that flag without the user, sources registered from an AI client also require a standing attestation the user gave once in the web app (versioned; re-asked when the wording changes) (V32).
18. **AI clients without MCP Apps support.**
    - *Default:* approval only through the web queue (by link). There is no approval through a plain tool call.
19. **Does one approval authorise one publication?**
    - *Default:* yes. Posting the same approved content again needs a new approval. Canceled posts free the approval; retries of a failed post reuse it.
20. **Render allowance.** Rendering clips and template videos is our heaviest compute cost, and the brief meters features by clipping hours.
    - *Default:* 3 rendered seconds per clipping second bought (Starter: 12 hours of output a month); a carousel slide counts 5 s; at most 3 renders in progress per workspace and 60 active clips per source.
21. **Media for posts created from an AI chat.** Claude can't pass file bytes to a remote MCP server, and ChatGPT passes short-lived file URLs.
    - *Default:* `create_draft` returns a short-lived link to the web app's upload page, and the AI then references the uploaded file. Accepting ChatGPT file URLs from an allowlisted host (as post media only, never as clip sources) comes later.
22. **Storage limits.**
    - *Default:* 50 GB (Starter), 100 GB (Plus), 200 GB (Pro), counting uploads and fetched source videos; at most 20 uploads in progress at once.
23. **Approving inside the chat card.** The server can't tell a click in the card from a model calling the same tool.
    - *Default:* until a human-presence check is verified on Claude and ChatGPT (step 4), the card's Approve and Reject buttons open a one-click web confirmation; Edit works inside the card.

## Appendix: Review notes

**Input note.** The plan text handed to this round began part-way through `source_media`'s checks. Sections 1, 2 and 3.1–3.7 were therefore rebuilt from every reference in the rest of the plan and from the brief (table list, notation, column names used by later sections, the platform-rules seed, the role and function inventory). The owner should review them with the same care as the rest. A later reconcile pass restored those sections from the merged plan, keeping the critic fixes listed below and the names later sections use.

**Critic issues** (48 received; 3 duplicates merged with their originals). Verdict: **A** = applied; **A\*** = applied with part of the proposal rejected (reason given).

| # | Sev. | Issue | Verdict | What changed |
|---|---|---|---|---|
| C1 | blocker | Destination not in the hash; editable by MCP | A | `variant_revisions.destination` (hashed, used by the claim); account destination is a web-only, audited default (3.4, 3.9, 4.8); CON-16/36/37, DAL-14 |
| C2 | major | Reuse rows become originals on SET NULL | A | Immutable `is_reuse`; unique index uses it (3.7); CON-27 |
| C3 | major | Fixed 6 h TTL; stuck transcripts and clips | A | `reservation_ttl`, `meter_extend`, reconciler, job terminal cascade, `fail_stale_jobs` (3.6, 4.4); CON-66, MET-41–43. A settle can't follow an existing resolution, so a late completion re-reserves and settles, or fails with `reservation_lost` |
| C4 | major | No ingest jobs for sources and uploads | A | `register_source`, `complete_upload`, `source_media.job_id`, `verifying` status (3.7); CON-25/70, DAL-31 |
| C5 | major | Reconnects split identity | A | Reconnect reactivates the row; `provider_account_id` on posts, imports and snapshots; identity dedupe and two-way matching (3.4, 3.10, 3.11); CON-12/55, DAL-17/23 |
| C6 | major | One approval, unlimited publications | A | `posts_one_per_approval`; approved → approved re-approval; Q19; CON-47 |
| C7 | major | Renders unmetered | A | `render_seconds` meter (3 × clip seconds) in enum, catalog and entitlements; Q20 (4.5); MET-47 |
| C8 | major | Fetcher redirects leave the allowlist | A | Separate `DRIVE_DOWNLOAD_HOSTS` and `isAllowedDownloadHop`; SSRF and hop rules for step 5 (7.2, 9); VAL-13 |
| C9 | minor | No `complete_render`; worker drafts undefined | A | `app.complete_render`; worker drafts start with no variants; `drafts.addVariants` (3.9, 7.1, 7.4); DAL-21/32 |
| C10 | minor | `get_transcript` might charge | A | Tool mapping fixed in 7.0 |
| C11 | minor | No media path for AI-created drafts | A | Q21; a `client_file` origin later is additive (9) |
| C12 | minor | 10 GB vs the ~5 GB single PUT | A | Multipart (`upload_id`, `declared_bytes`), abort lifecycle (3.7, 9) |
| C13 | minor | 365-day CHECK anchored to creation | A | `scheduled_set_at` (3.10); CON-45 |
| C14 | minor | Earlier-generation request IDs unindexed | A | Partial indexes on `post_attempts`; fallback lookup (3.10, 7.4); DAL-33 |
| C15 | minor | Revision and snapshot FKs skip the tenant | A | Brand-carrying FKs and new UNIQUE targets (3.9, 3.10, 3.11); CON-34/56 |
| C16 | minor | Claim's FOR UPDATE blocks FK checks | A | FOR NO KEY UPDATE, extended to every serialisation-only parent lock (4.8, 4.9) |
| C17 | minor | `updated_at` misses child activity | A | `drafts.last_activity_at`, drafts before variants in the lock order (3.9, 4.9); DAL-16, CONC-21 |
| C18 | minor | Suspended brands still writable | A | `assert_brand_writable` on every write path; profile-based churn guard covers swaps; brand writes web-only (4.3); CON-68 |
| C19 | minor | No analytics indexes | A | `posts (brand_id, published_at)` and `(published_at)` partial indexes (3.10) |
| C20 | minor | Client-id naming; actor columns unforced | A | `oauth_client_id` everywhere; drafts trigger forces actor columns (3.9, 6.2); CON-67 |
| C21 | blocker | Destination (duplicate of C1) | A | Via C1 |
| C22 | blocker | Approvals never consumed | A\* | Via C6's partial unique index, which binds every writer. Rejected part: a new `published` supersede reason plus moving the variant back to `editing`; the index already blocks reuse, and the view already shows "published" |
| C23 | major | `mcp_app` approvals can't prove a human | A | `decide_variants` is web-only in step 1; step 4 enables `mcp_app` only with a verified human-presence check; Q23; CON-40 |
| C24 | major | `app_api` can impersonate any user | A\* | Took the critic's fallback: the false claim is withdrawn and the risk documented; the service-role key moves to Railway (6.1). Rejected part: in-database identity resolution in step 1, since Vercel also mints the credentials it would look up; recorded as a step-3 evaluation (9) |
| C25 | major | One-level redaction wildcards | A | Explicit header paths plus `redactDeep` (6.7, 7.3); LOG-01/05. Also dropped `*.code`, which hid SQLSTATE codes |
| C26 | major | Work not bounded by the charge | A | Staging vs immutable keys, decoded duration, sha256 check, `-t` bound (3.7, 4.4, 9) |
| C27 | major | Expiry while work is running | A | Reconciler never expires live subjects, including posts in flight; late completion handling (4.4); MET-42/44 |
| C28 | major | X-link key reused within a generation | A | Claim number in both keys; `replayed_resolved`; release when leaving `publishing` (4.7); MET-38 |
| C29 | major | Caps counted per account row | A | Identity column and index on posts; advisory lock per identity (4.8); MET-30, CONC-19 |
| C30 | major | Clip and render compute unbounded | A | With C7: reserve and settle in `request_clips`, `create_job`, `complete_*`; caps of 60 clips per source and 3 renders in flight (4.5); MET-47, CONC-18 |
| C31 | major | Profile growth beyond the churn guard | A | Live-profile cap (limit + 1) and creations per period (limit + 2); archive schedules deletion after 7 days (4.3, Q10, Q14); CON-11, MET-23 |
| C32 | major | Renewal + downgrade kept the old grant | A | Same-period vs new-period handling in `apply_entitlements` (4.2); MET-45 |
| C33 | major | Mid-period decreases and regrant delta | A | `granted_target_hwm`, `effective_at` proration, Stripe decreases at period end with an alert (3.5, 4.2, 4.4, 9); MET-14/46 |
| C34 | major | Cascades orphan profiles and R2 files | A | `guard_external_resources` trigger (3.4), chosen over a tombstone table to keep 28 tables; CON-63/64 |
| C35 | major | Unscoped writes; no storage quota | A | Media insert needs a write scope; storage cap and pending-upload cap (4.6); no `app_user` privileges on `encrypted_secrets`; brand writes web-only; MET-48, RLS-X5/X8/X9 |
| C36 | major | PUBLIC EXECUTE on internal functions | A | Default-privilege revoke, SECURITY INVOKER internals, grantee sets in the allowlist (2.3, 3.14, 6.4); MIG-11/24, FN-04. This also fixes the old MIG-11, which forbade the two grantees the context helpers need |
| C37 | minor | SET NULL on reuse lineage (duplicate of C2) | A | Via C2 |
| C38 | minor | `attempt_count` ceiling stalls posts | A | `max_attempts` → `failed/too_many_attempts`; reset on retry (3.3, 3.10, 4.8); MET-49 |
| C39 | minor | Repeated outcomes raise `AP004` | A | `already_applied` (3.10); CON-69, DAL-15 |
| C40 | minor | X CHECK ignores `link_url` | A | New CHECK (3.9); CON-36 |
| C41 | minor | Share URLs in plaintext | A\* | Hidden from `app_user`, never in jobs or logs, cleared after the fetch (3.7, 6.6); RLS-X11, CON-23. Rejected part: sealing the URL, which would remove the DB checks that close the userinfo and YouTube holes (I11) for a value that lives only minutes |
| C42 | minor | `scrubSecrets` misses presigned and JWT values | A | Wider scrub list (6.7); LOG-04 |
| C43 | minor | Unknown lookup key zeroes entitlements | A | Keep previous entitlements and alert (4.2); DAL-25 |
| C44 | minor | Balance creation inverts the claim's lock order | A | `ensure_current_balance` is lock-free and runs before the claim's locks (4.4, 4.8) |
| C45 | minor | Presigned PUT can overwrite approved bytes | A\* | Staging key and bucket separate from the immutable, worker-only media key with a purpose segment (3.7). Rejected part: forbidding URL handover to Upload-Post; a worker-only bucket makes a presigned GET safe, so step 2 may choose (9) |
| C46 | minor | Redirects vs allowlist (duplicate of C8) | A | Via C8, using a separate download list instead of widening the paste allowlist |
| C47 | minor | Voice profile accepts foreign imported IDs | A | Brand check in `save_voice_profile` (3.8); CON-32 |
| C48 | minor | Global account uniqueness blocks real owners | A | Uniqueness per workspace; caps shared by identity (3.4, 4.8); CON-13 |

**Other consistency fixes made while applying the above**
- Serialisation-only locks on `workspaces`, `brands`, `drafts` and `connected_accounts` are FOR NO KEY UPDATE, so they never block FK checks (4.9).
- MIG-13 now tests the FK's first non-tenant column, which the existing indexes satisfy; the old wording could not be met by composite tenant FKs.
- `post_attempts` is unique per (post, generation, attempt), because `attempt_count` resets on retry.
- The `brands` row of the grant matrix no longer gives workers a status grant; system status changes happen only inside `apply_entitlements`.
- New error code `AP019 fair_use_limit`; new callable functions `register_source`, `complete_upload`, `complete_render`, `meter_extend` and `fail_stale_jobs` (40 in total at that point; the recovered ideas below bring it to 42).

**Recovered design ideas** (11 ideas from the three candidate designs that the merge or the rebuild had lost, judged after the critic round). Verdict: **A** = applied; **A\*** = applied in part (the rejected part and the reason are given); **R** = rejected. Minors were applied only where they reduce cost or risk without adding meaningful complexity.

| # | Sev. | Idea | Verdict | What changed, or why not |
|---|---|---|---|---|
| R1 | major | MIME prefix CHECK accepts SVG and other types; no pixel or duration bound | A | Explicit MIME allowlist per kind, narrowed for `post_media`; never `image/svg+xml`. `video/x-matroska` is allowed for clip sources, so the existing mis-headered MKV fixture stays valid. A 50 MP pixel cap is added to the existing 1–16,384 bounds, and `duration_ms` is capped at 12 h, matching `source_media`. `ALLOWED_MIME` is exported with a parity test. Step-5 `media_verify` checks magic bytes, `format_name` and header dimensions before decoding (3.7, 7.2, 9); CON-20, VAL-20 |
| R2 | major | No poll state or sweep indexes on `posts`; no metrics-pull state | A\* | `posts.next_check_at` and `check_count`, exempt from the published freeze; partial indexes for the stuck-publishing sweep and the poll scan; worker `app.note_post_checked`; system `app.list_posts_due_for_check` (3.10, 4.8, 6.3, 7.1, 7.4, 9); CON-50, CON-71. Function count 40 → 42. Rejected part: `next_metrics_at` on `posts` and `imported_posts` now. Nothing reads it before step 7, and it is an additive nullable column plus a freeze-list change, recorded for step 7 (9) |
| R3 | major | Dev seed has no brands, accounts or second tenant; brand writes and approvals are web-only before the web app exists | A | `dev-seed.ts` creates 2 tenants with Pro comps, web-created brands, active fake profiles and fake accounts (via `upsert_connected_accounts`), and refuses production. New `dev-approve.ts`. A fake `PostingProvider` serves the seeded profiles in step 2. Minimal web pages for brand creation and approval confirmation are required by the end of step 3 (1, 2.1, 7.0, 9); DAL-35 |
| R4 | minor | No database size estimate or per-user budget | R | It measures cost rather than reducing it, and a CI fixture that guesses snapshot volumes would be brittle before step 7 fixes the cadence. The large tables already have retention (inbound 30 days, audit 13 months, snapshot pruning in step 7). A one-line step-7 task now measures growth on staging and sets the budget (9) |
| R5 | minor | Only the `upload-post` import is blocked; a raw `fetch` to Upload-Post would pass | A | `scripts/check-provider-boundary.ts` in the CI `static` job. It replaces the "URL constants" import rule, which ESLint can't enforce. Webhook signature checks live in `packages/posting` (2.2, 8.1, 9); MIG-23 |
| R6 | minor | `console.*` bypasses pino redaction | A | `no-console: error` outside `scripts/`; step 2 routes unhandled-rejection handlers through `@app/log` (2.2, 9); MIG-23 fixture. One lint line, and it closes a house-rule leak |
| R7 | minor | Toolchain settings lost in the rebuild | A\* | (a) Node 24 and (b) most tsconfig flags were already restored; `noImplicitReturns` added. (c) typescript-eslint `strict-type-checked` plus `switch-exhaustiveness-check`: un-awaited queries inside `with*` callbacks escape the transaction's role and context. (d) `[db] major_version = 17`, checked by the staging smoke test (2.2, 8.1); MIG-23. Rejected part: lowering `engines.node` to `>=22.12`, because the plan pins Node 24 on purpose |
| R8 | minor | `pending_deletion` has no behaviour | R | The enum, columns and CHECK were already restored by the reconcile pass. The behaviour (a web-only request function, helper and claim refusals, a new post reason) belongs to the step-8 deletion flow that sets the status, and adding it now means code and tests with no caller. 3.3 and step 8 now state exactly what step 8 must change, including the purge requiring the status (3.3, 9) |
| R9 | minor | `captions` role unusable without a captions media kind | A\* | The `captions` kind with `text/vtt` was already restored. Added one rule: role `captions` exactly when the asset kind is `captions`, and captions don't count toward `content_kind` (3.9); CON-36. Rejected part: SRT, an additive CHECK change when a step needs it |
| R10 | minor | `comp_expires_at` not enforced; staff identity passed as a parameter | A\* | A comp-only workspace opens no period at or after `comp_expires_at`, and `computeEntitlements` ignores an expired comp. Both stop free hours accruing forever. Staff identity now comes from `SystemCtx.staff`: `p_actor` was removed from `meter_grant_bonus` and `meter_adjust`, and the comp setter, ledger actor and audit `actor_kind = 'staff'` come from the context. This also fixes a contradiction with 6.4 rule 2 (3.3, 3.5, 3.12, 4.4, 6.2, 7.1, 7.2, 7.4); MET-03, MET-17, CON-59, VAL-15. The step-8 hourly sweep re-applies expired comps (9). Rejected part: B's append-only `entitlement_overrides` table, which would be a 29th table; the audit log already keeps comp history through `entitlement.changed` |
| R11 | minor | `x_link_quota_exhausted` holds wait forever; add `keep_if_available` | R | Waiting for the user is intended: the release rule's 1-hour staleness check would keep nearly every such post held even if released on a new period or grant. `keep_if_available` adds an enum value, a hash input and card copy, and publishes either version depending on a shared pool, for a default allowance of 0 (Q1). 4.7, Q1 and MET-34 now state the behaviour (`not_before = NULL`; the user reschedules or approves a `strip` revision) |

**Cross-reference fixes in the same pass**
- `@app/db` exported a three-value `Via` that clashed with `@app/shared`'s five-value enum type; it is now `UserVia` (7.4).
- `private.release_subject_reservations` was listed in 7.1 but never described; it is now in 3.14.
- 3.14 now states that trigger functions that touch other tables or call internal helpers are SECURITY DEFINER. Otherwise a user's media or draft insert would need EXECUTE on `assert_brand_writable`, which 7.1 lists as ungranted, and INSERT on `provider_profiles`.
- MIG-13 and 3.1 now accept a `brand_id`-leading index for the brand FK. This resolves the open item for `transcript_segments`, `revision_media` and the two snapshot tables without new indexes.
- `app.set_account_status` is now described (3.4): it can't move an account back to `connected`. CON-12 covers it.
- Worker-created drafts record `created_via = 'worker'`, as jobs do (3.9).
- MET-34 said "no ledger rows", but `ensure_current_balance` writes `period_open`; it now says no `reserve` rows.
- Q1 said a link "must be marked strip", which conflicted with 4.7's keep option and `AP014`. It now says the choice is explicit and the card preselects "strip"; section 1 matches.
- Invariant I14 now has explicit tests for the media, variant and clip state machines (CON-21, CON-33, CON-31).
- `CompInput` was used but never defined; it is now in 7.2.
- Section 1 and 6.4 counts: 28 tables, 2 views, 42 callable functions (15 user, 12 worker, 15 system), 5 packages.

**Verification fixes** (34 issues from independent reviewers of this plan; 4 were duplicates and are merged with their originals). Verdict: **A** = applied; **A\*** = applied with part of the proposal rejected (reason given). None was rejected outright.

| # | Sev. | Issue | Verdict | What changed, or why not |
|---|---|---|---|---|
| V1 | blocker | Per-schema `ALTER DEFAULT PRIVILEGES … REVOKE EXECUTE … FROM PUBLIC` is a no-op, so every function stayed PUBLIC-executable | A | Global form (no `IN SCHEMA`) in 0001, after `btree_gist`; `REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA app, private FROM PUBLIC` at the start of 0013 (2.3, 6.4 rule 5); MIG-24 checks `has_function_privilege('public', …)`; FN-04 adds a scratch role with schema USAGE only |
| V2 | major | `assert_reservation` demanded the same workspace for the global X-link pool reservation, so every `keep` claim would fail | A | One rule per column, with meter and (for the pool) `pool_key` and subject (3.5); CON-27, CON-73 |
| V3 | major | A new period overlapping the open balance was silently absorbed by `ON CONFLICT DO NOTHING` | A | `apply_entitlements` closes the old balance at the new start (or tops up one starting exactly there; voids one that began later, with `period_end >= period_start`) before opening the new period; `ensure_current_balance` raises `AP017 period_overlap` instead of continuing (3.5, 4.2, 4.4, 4.9); MET-50 |
| V4 | major | Brand status CHECKs couldn't be met: nothing stamped `archived_at`/`suspended_at`, and the system couldn't write `suspended_reason` | A | Status trigger stamps and clears them; the system may write `status` and `suspended_reason`; users never write them (3.4, 6.3); CON-07, CON-08 |
| V5 | major | Accounts of a deleting profile stayed `connected`; reconnecting under the new profile hit unique indexes; claims could use a deleted profile's ref | A | Profile → `deleting` disconnects its accounts (`profile_deleted`); general collision rule in `upsert_connected_accounts` (`identity_changed`, `profile_replaced`, `account_moved`), missing rows handled first; claims hold posts whose profile isn't `active` (3.4, 4.8, 7.1); CON-12. Includes V31 |
| V6 | major | Transcription reservations were resolved by subject (the first attempt), so fallback cancels left them held and the reconciler could expire a live fallback's reservation | A | Cascade and reconciler key on `transcripts.reservation_id` and treat it as live while any sharing attempt is pending or running (3.6, 3.14, 4.4); CON-66, MET-20, MET-42. The alternative subject `('source_media', id)` was not needed |
| V7 | minor | `origin_url` survived failures from `pending` (cascade, early fetcher failure) | A | CHECK `origin_url IS NULL OR status IN ('pending','fetching')`; the state-machine trigger nulls it on every other status, so the definer cascade complies (3.7); CON-23, CON-66. Includes V26 |
| V8 | minor | 0003 created SQL helpers reading tables that don't exist yet | A | 0003 holds only table-free helpers; table-reading helpers move to 0012; trigger functions are plpgsql (2.3, 3.14) |
| V9 | minor | `.strict()` everywhere would break on new third-party fields | A | Strict for AI input and our jsonb; loose objects plus explicit mapping for Upload-Post and Stripe payloads (2.2, 7.2); VAL-19 |
| V10 | minor | `revision_media` grants contradicted 6.3 and the ISO coverage | A | No write grant for any runtime role; `app_user` SELECT under br, workers SELECT (3.9); CON-34 |
| V11 | minor | WebM, MKV or audio clip sources could reach a platform through a revision | A | `save_variant_revision` applies the `post_media` MIME list to every attached asset (3.7, 3.9); CON-36. Chosen over dropping `clip_source` from revisions, which would block posting an mp4 source directly |
| V12 | minor | Failed assets keep R2 objects but stop counting | A | Merged with V21 |
| V13 | minor | A failed verify left linked sources `probing` forever; `register_source` accepted failed or deleted assets | A | AFTER UPDATE trigger on the asset fails linked live sources with the same code; `register_source` raises `AP013` (3.7, 7.1, 7.4); CON-21, CON-26 |
| V14 | minor | The 3-in-flight render cap had no serialisation point; CONC-18 contradicted it | A | `request_clips` and render `create_job` count under the `workspaces` row lock, before the source lock (3.6, 4.5, 4.9); CONC-18 rewritten below the cap; new CONC-22. Includes V25 |
| V15 | minor | The churn-guard index excluded the deleted profiles the per-period count needs | A | Non-partial `(workspace_id, created_at)`; the count includes deleted profiles (3.4, 4.3); MET-23 |
| V16 | minor | Comp-only periods never advanced `ent_period_*`, so the churn guard eventually blocked brand creation for good | A | `private.current_period(ws)` used by balances, the churn guard and `no_active_plan` (3.3, 3.14, 4.2–4.4); MET-03, MET-23 |
| V17 | minor | The `app.adjusting` bypass was unusable and forgeable | A | Dropped: `granted` and `granted_target_hwm` never decrease for any caller; `set_pool_period` can't lower `granted` (3.5, 7.1); CON-60 |
| V18 | minor | `cancel_job` scopes undefined for worker-created kinds | A | Kind → scope table (3.6, 7.1) |
| V19 | minor | CON-64 ran a brand delete "as system", which has no table privileges | A | Runs as `postgres` after marking external resources deleted |
| V20 | major | Cancelling or discarding running work refunded it in full, and partial transcripts and unsettled render outputs were readable and attachable | A\* | `jobs.processed_seconds`; a user cancel while running settles `least(reserved, processed_seconds)` for transcription and in full for renders (≤600 s per clip, ≤180 s per video); queued cancels and our failures still refund. Segments visible to users only once completed; a `render_output` is attachable only once its clip is ready or its job succeeded (3.6, 3.7, 3.9, 4.4, 4.5, Q2); CON-29/31/36/66, MET-43, MET-47. Rejected parts: per-second progress for renders (renders are short and bounded, so full settlement is simpler); moving output-asset inserts into `complete_*` (the revision gate is smaller and closes the same hole); a hard per-period cap on refunded seconds (refunds follow our own failures, so a cap would bill users for our outages; step 5 alerts instead) |
| V21 | major | Failed uploads freed quota while their bytes stayed in R2 | A | Failed upload and drive assets count until deleted (index predicate too); `media_verify` HEADs and sniffs before copying, and on failure deletes the copy and moves failed → deleted; presigned PUTs sign `Content-Length`; the delete guard now ignores failed sources (3.7, 4.6, 9); MET-48, CON-21. Includes V12 |
| V22 | major | One Railway login with `app_system` let a renderer compromise grant free plans cross-tenant and read every drive URL and secret | A | Logins split: `app_queue_login` (worker + system), `app_media_login` (new `app_media_worker`: media tables only, no `origin_url`, no secrets, 5 media functions), `app_billing_login` (new `app_billing`: the 4 billing functions only). The drive fetcher runs under the queue login, the only service with the private key, which resolves the reviewer's "no `origin_url` for the renderer" on a shared media role (1, 6.1–6.4, 6.6, 7.1, 7.4, 9); MIG-11, MIG-18, RLS-X11, RLS-X12, FN-02, FN-04. Functions: 15 user, 7 worker, 5 media worker, 11 system, 4 billing (still 42) |
| V23 | major | Render inputs could name another brand's or unverified assets, and templates could fetch arbitrary URLs | A\* | `JobInputEnvelope.asset_ids`; `create_job` requires ready assets of the job's brand (`AP001`); the renderer re-checks and runs Chromium with request interception limited to the job's own presigned GETs (3.6, 4.5, 7.2, 9); FN-05. Rejected part: CHECK `input::text !~* '(https?\|file\|data\|ftp\|javascript\|blob):'` on `jobs.input`, because carousel and video text legitimately contains URLs and phrases such as "data:"; asset-ID-only media and request interception close the same holes |
| V24 | major | Brand logos could point at another brand's, a video or a failed (unverified) asset; `style` allowed URLs | A | FK `(id, logo_asset_id) → media_assets(brand_id, id)`; trigger requires a ready `post_media` image; logos block deletion; CHECK bans URL schemes in `style` (3.4, 3.7, 7.2); CON-72 |
| V25 | minor | Render cap serialisation (duplicate of V14) | A | Via V14 |
| V26 | minor | `origin_url` not cleared by the cascade (duplicate of V7) | A | Via V7 |
| V27 | minor | Scrubbers kept drive capabilities that sit in the URL path | A | Drive-host URLs lose everything after the host; the fetcher stores only `error_code` (6.7, 9); LOG-04 |
| V28 | minor | Brand INSERT had no ownership predicate, and `INSERT … RETURNING` would fail the SELECT policy | A | INSERT `WITH CHECK` on owned workspace and `via = 'web'`; SELECT keyed on the workspace for web, on `user_brand_ids()` otherwise (6.3); ISO-5, DAL-36 |
| V29 | minor | Workspace-wide job idempotency keys leaked or collided across brands | A | UNIQUE `(brand_id, kind, idempotency_key)`; a reused key returns the job only with the same `input_hash`, else `AP012` (3.6, 7.1); CON-57, FN-06 |
| V30 | minor | The media delete guard's `current_user = 'postgres'` exception matched every definer path | A | Exception keyed on the workspace being `pending_deletion`, which runtime roles can't set; test helpers set it before purging (3.3, 3.7, 7.4); CON-21 |
| V31 | minor | Deleting profiles left accounts live (duplicate of V5) | A | Via V5 |
| V32 | minor | An AI client could produce the own-content attestation with no human action | A | `source_media.attested_via`; non-web `register_source` needs the workspace's standing, versioned web attestation (`rights_attested_at`, set through the existing ws/web UPDATE grant, so no new function) (3.3, 3.7, 7.0, 7.4, Q17); CON-25 |
| V33 | minor | Letting `app_user` INSERT into `pgboss.job` would let any Vercel bug enqueue cross-tenant work | A | Decided now: relay via an additive step-2 system function `app.list_queued_jobs`; worker contexts come only from `app.jobs` or system functions; `app_user` gets nothing in `pgboss` (7.4, 9) |
| V34 | minor | No persona carried a foreign brand ID | A | Personas `ua/mcp[B1]` and `ua/mcp[A1,B1]`; ISO-10 |

**Consistency fixes in the same pass**
- New columns: `workspaces.rights_attested_at` and `rights_attestation_version`, `source_media.attested_via`, `jobs.processed_seconds`. The table count stays 28.
- New tests: CON-72, CON-73, ISO-10, RLS-X12, FN-05, FN-06, MET-50, CONC-22, DAL-36. New DAL functions: `attestRights`, `markAssetDeleted`.
- The upload-flow, drive-fetcher, renderer and outbox notes for steps 2, 5, 7 and 8 match the role split (9).
- Superseded by V22: the "15 user, 12 worker, 15 system" count in the cross-reference list above, and the earlier decision that dropped C's `media_worker` role (6.1 now records the reversal).
