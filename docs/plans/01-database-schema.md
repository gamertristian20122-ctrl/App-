# Step 1 plan: database schema

**Status:** final plan, waiting for owner approval (house rule: plan before coding).
**Date:** 2026-10-31. **Build-order step:** 1 of 8.

## 1. Summary and scope

**What step 1 delivers**
- The Postgres schema on Supabase: 28 tables and 2 views in schema `app`; helpers, trigger functions and internal functions in schema `private`; enums, row-level security, column grants and 40 callable SQL functions (7.1).
- Five TypeScript packages: `@app/shared` (enums, zod schemas, validators, price catalog, platform rules), `@app/db` (Kysely client, request context, repositories), `@app/crypto`, `@app/log` and `@app/env`.
- `scripts/dev-seed.ts`: a demo user, a workspace and a Pro comp, so steps 2–7 can run without Stripe.
- Tests: pgTAP for the catalog, constraints, RLS and metering; Vitest for the data access layer (DAL), validators, crypto, logging and concurrency (section 8).

**What it does not deliver:** HTTP routes and MCP tools (7.0), workers, the Upload-Post adapter, Stripe integration, R2 presigning and any UI. Section 9 lists what each later step adds on top of this schema.

**Design rules**
1. The database enforces every rule that must hold for every writer: tenant isolation, the approval gate, quotas, caps and state machines. Application code validates first; the database is the backstop.
2. Prices, plan limits and platform limits live in code (`@app/shared`), as CLAUDE.md requires ("enforce in code"). The database receives computed numbers, and mirrors platform caps so the dispatcher can enforce them inside its own transaction.
3. Nothing reaches a platform without a human approval of the exact content, target account and destination. One approval authorises one publication (Q19).
4. v1 stores no platform tokens. Upload-Post holds them [V].
5. Every feature that costs us compute or money is metered: brands, clipping hours (and the render allowance derived from them), storage, and X link posts (section 4).

**Notation**
- **[V]**: checked against the vendor's official documentation on or before 2026-10-31.
- **[V\*]**: taken from Upload-Post's documentation or a secondary source only.
- **[U]**: unverified; must be checked before anything relies on it.
- **Decision**: a resolved disagreement. This plan merges three candidate plans (A, B and C) as ruled by three judges (cost, security and forward-compatibility), followed by a critic round. Critic issues are cited as C1–C48; the appendix "Review notes" records how each was handled.

## 2. Repository layout and conventions

### 2.1 Layout

```
apps/web                 Next.js on Vercel (step 8; also hosts the MCP endpoint in step 3)
apps/worker              Railway workers (step 2 onwards)
packages/shared          @app/shared   pure TypeScript + zod, no I/O
packages/db              @app/db       Kysely client, context helpers, repositories
packages/crypto          @app/crypto   envelope encryption, token hashing
packages/log             @app/log      pino with redaction
packages/env             @app/env      zod-validated environment
packages/posting         PostingProvider + Upload-Post adapter (step 2; the only place that may reference Upload-Post)
supabase/config.toml
supabase/migrations/     immutable once merged (MIG-21)
supabase/tests/          pgTAP: 00_catalog, 10_*, 20_rls_*, 30_metering
supabase/tests/fixtures/ grants.expected, definer-allowlist.json, drive-hosts.json, revision-hash.json
scripts/                 dev-seed.ts, set-db-role-password.ts, db-local-login-roles.sql,
                         check-banned-deps.ts, check-migrations-immutable.ts
```

### 2.2 Toolchain

- pnpm workspaces; Node 22 LTS; TypeScript with `strict`, `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`.
- zod 4 (`.strict()` objects everywhere), Kysely with `kysely-codegen`, node-postgres.
- Vitest (unit, integration, meta projects), msw, fast-check; pgTAP through `supabase test db`; the Supabase CLI is pinned.
- ESLint with import-boundary rules (MIG-23): `upload-post` only in `packages/posting`; `pg` and `kysely` only in `packages/db`.

### 2.3 Migrations

Files are named `<timestamp>_<nn>_<name>.sql`. Step 1 ships, in order:

1. `roles_schemas`: schemas `app` and `private`; NOLOGIN roles and the two LOGIN roles (no passwords); `ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA app, private REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC` (C36); extension `btree_gist`; drop `pg_graphql`.
2. `enums`
3. `private_helpers`
4. `tenancy_billing` (3.3)
5. `brands_accounts_secrets` (3.4)
6. `usage` (3.5)
7. `jobs_media_clipping` (3.6, 3.7)
8. `voice_drafts_approvals` (3.8, 3.9)
9. `posts` (3.10)
10. `imports_analytics` (3.11)
11. `inbox_audit` (3.12)
12. `views` (3.13)
13. `functions_user`, `functions_worker`, `functions_system` (7.1)
14. `rls_grants` (6.3)
15. `seed_platform_rules` (3.3)

### 2.4 Notation used in section 3

- Every table lives in `app`. `id` means `id uuid PRIMARY KEY DEFAULT gen_random_uuid()` unless a `bigint IDENTITY` key is stated.
- **[B]** (brand-scoped): `workspace_id uuid NOT NULL`, `brand_id uuid NOT NULL`, FK `(workspace_id, brand_id) → brands(workspace_id, id) ON DELETE CASCADE`, and `UNIQUE (brand_id, id)` as the target of brand-checked child FKs. Every reference between brand-scoped rows carries `brand_id` (written `FK (brand_id, x_id) → t(brand_id, id)`), so no row can point into another brand (I5). Workspace-level references are written `FK (workspace_id, x_id) → t(workspace_id, id)`.
- **[ts]**: `created_at` and `updated_at`, both `timestamptz NOT NULL DEFAULT now()`, plus the `private.touch_updated_at()` trigger. **[c]**: `created_at` only.
- `col?` is nullable; every other column is NOT NULL.
- `text ≤N` means CHECK `char_length BETWEEN 1 AND N`. `obj ≤N KB` means CHECK `jsonb_typeof = 'object' AND octet_length(col::text) ≤ N × 1024`; `arr ≤N KB` is the same for arrays.
- `error_code?` is `text` CHECK `~ '^[a-z0-9_]{1,64}$'`. `error_message?` is `text ≤2000`, passed through `scrubSecrets` before it is written.
- `ON DELETE SET NULL (col)` uses the Postgres 15+ column list, so the tenant column of a composite FK is never nulled.
- Every timestamp is `timestamptz` (MIG-17). Money is integer cents; durations are integers whose name carries the unit (`_ms`, `_seconds`).
- jsonb payloads carry `schema_version` and are validated by a zod schema in `@app/shared` before they are written. The database checks only shape and size.
- Enums are Postgres enums mirrored by `as const` arrays (VAL-17). A new value is `ALTER TYPE … ADD VALUE` in a new migration.

## 3. Data model

### 3.1 Schemas and tables

- `app`: the 28 tables, 2 views and the callable functions. `private`: helpers used by constraints and policies, trigger functions and internal functions. `public`: empty.
- Extensions: `btree_gist` (exclusion constraints). `gen_random_uuid()` and `sha256()` are built in. `pg_graphql` is dropped (6.5).

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

| Enum | Values |
|---|---|
| `platform` | tiktok, youtube, instagram, facebook, threads, x, linkedin, pinterest, bluesky |
| `posting_provider` | upload_post |
| `via` | web, mcp, mcp_app |
| `approval_channel` | web, mcp_app (`mcp_app` is refused by `decide_variants` until step 4 enables it; I3) |
| `entitlement_status` | active, grace, inactive |
| `brand_status` | active, suspended, archived |
| `brand_suspended_reason` | plan_limit, billing, admin |
| `profile_status` | pending, active, deleting, deleted |
| `connection_status` | connected, reauth_required, disconnected |
| `secret_owner_kind` | connected_account |
| `secret_purpose` | platform_credential |
| `usage_meter` | clip_seconds, render_seconds, x_link_posts |
| `ledger_kind` | period_open, grant, bonus, reserve, settle, release, expire, adjust |
| `job_kind` | media_verify, source_ingest, transcribe, clip_render, render_carousel, render_video, import_past_posts, sync_accounts |
| `job_status` | queued, running, succeeded, failed, canceled |
| `media_kind` | video, audio, image, document, data |
| `media_purpose` | clip_source, post_media, render_output, derived |
| `media_origin` | upload, cloud_drive, clip_render, template_render, derived |
| `media_status` | pending_upload, verifying, ready, failed, deleted |
| `source_origin` | upload, cloud_drive_link |
| `drive_provider` | google_drive, dropbox, onedrive |
| `source_status` | pending, fetching, probing, ready, failed, deleted |
| `transcription_engine` | whisper, assemblyai |
| `transcript_status` | pending, running, completed, failed |
| `clip_status` | proposed, rendering, ready, failed, discarded |
| `voice_source` | manual, from_imports, edited |
| `draft_origin` | web, mcp, clip, render |
| `draft_status` | active, archived |
| `variant_status` | editing, pending_approval, approved, rejected |
| `content_kind` | text, image, carousel, video, document |
| `x_link_handling` | keep, strip |
| `approval_decision` | approved, rejected |
| `post_status` | scheduled, held, publishing, submitted, published, inbox_fallback, failed, unknown, needs_attention, canceled, skipped (11 values, 121 pairs in CON-49) |
| `post_status_reason` | brand_inactive, billing_inactive, reauth_required, account_disconnected, cap_reached, x_link_quota_exhausted, link_detection_mismatch, content_hash_mismatch, approval_revoked, user_canceled, provider_rejected, provider_error, provider_rate_limited, duplicate_skipped, too_many_attempts, stuck_publishing, staff_action |
| `attempt_outcome` | accepted, published, inbox_fallback, failed, retryable, rate_limited, unknown |
| `metric_window` | day, lifetime, rolling_30d |
| `metric_checkpoint` | h24, h48, d7, d30 |
| `inbound_source` | upload_post, stripe |

### 3.3 Tenancy, billing and platform rules

**`workspaces`**: one per user in v1. Teams later add `workspace_members` and change one helper (9).
- `id`
- `owner_user_id uuid` UNIQUE, FK → `auth.users(id) ON DELETE RESTRICT`
- `name text` ≤80
- `timezone text` default `'UTC'`. Trigger `private.assert_timezone`: the value must exist in `pg_timezone_names`.
- [ts]
- Created only by `app.ensure_workspace()`, which also inserts the `workspace_billing` row.
- Trigger: BEFORE DELETE `private.guard_external_resources` (3.4).

**`workspace_billing`**: the Stripe mirror and the computed entitlements, 1–1 with `workspaces`. Written only by `app.apply_entitlements` (plus the all-zero row inserted by `ensure_workspace`).
- `workspace_id uuid PK`, FK → `workspaces ON DELETE CASCADE`
- **Stripe mirror:**
  - `stripe_customer_id text?` UNIQUE, CHECK `~ '^cus_[A-Za-z0-9]+$'`
  - `stripe_subscription_id text?` UNIQUE, CHECK `~ '^sub_[A-Za-z0-9]+$'`
  - `subscription_status text?` ≤32 (Stripe's value, unmapped)
  - `base_lookup_key text?` ≤64
  - `extra_brand_qty int`, `extra_clip_hour_qty int`: default 0, ≥0
  - `stripe_period_start?`, `stripe_period_end?`, CHECK end > start
  - `cancel_at_period_end bool` default false, `trial_end?`
  - `snapshot_at?`: when the subscription was fetched
- **Comp** (staff grants): `comp_brands int`, `comp_clip_seconds bigint`, `comp_render_seconds bigint`, `comp_x_link_posts int`, all default 0 and ≥0; `comp_reason text?` ≤200; `comp_set_by text?` ≤64; `comp_until?`. CHECK: every comp value is 0, or both reason and setter are set.
- **Computed** (from `computeEntitlements`, 4.2):
  - `entitlement_status entitlement_status` default `'inactive'`
  - `brand_limit int`, `clip_seconds_limit bigint`, `render_seconds_limit bigint`, `x_link_posts_limit int`, `storage_bytes_limit bigint`: default 0, ≥0
  - `ent_period_start?`, `ent_period_end?`: both null or both set, end > start; set whenever the status isn't `inactive`
  - `entitlements_version int` default 0
- [ts]

**`platform_rules`**: the database mirror of `PLATFORM_RULES` (MIG-19). Written only by migrations; `claim_post` and `save_variant_revision` read it.
- PK `(provider, platform)`
- `cap_max_posts int` > 0, `cap_max_video_posts int?` > 0, `cap_window_seconds int` > 0
- `max_attempts smallint` default 25, CHECK 1–100: claims allowed per generation before the post fails (C38)
- `supports jsonb`: an object with one boolean per `content_kind`
- `carousel_min smallint?`, `carousel_max smallint?`: both null, or `2 ≤ min ≤ max ≤ 35`
- `requires_title bool`, `supports_first_comment bool`
- `source text` ≤200 (the documentation reference)
- `updated_at`

Seed for `upload_post` (window 86,400 s everywhere; caps are explained in 4.8):

| Platform | Cap | Video cap | text | image | carousel | video | document | Title required |
|---|---|---|---|---|---|---|---|---|
| instagram | 50 | – | no | yes | 2–10 [V] | yes | no | no |
| tiktok | 15 | – | no | yes | 2–35 [V] | yes | no | no |
| youtube | 30 | – | no | no | – | yes | no | yes |
| facebook | 25 | – | yes | yes | 2–10 [U] | yes | no | no |
| threads | 50 | – | yes | yes | 2–20 [V] | yes | no | no |
| x | 20 | – | yes | yes | 2–4 [V] | yes | no | no |
| linkedin | 150 | – | yes | yes | 2–20 [U] | yes | yes | no |
| pinterest | 20 | – | no | yes | 2–5 [V\*] | yes | no | no |
| bluesky | 100 [U] | 25 | yes | yes | 2–4 [V] | yes | no | no |

`supports_first_comment` is filled from Upload-Post's parameter reference when the migration is written [V\*]; MIG-19 keeps code and table identical.

### 3.4 Brands, provider profiles, connected accounts and secrets

**`brands`**
- `id`, `workspace_id` FK → `workspaces ON DELETE CASCADE`; UNIQUE `(workspace_id, id)` (the target of every [B] FK)
- `name text` ≤80; UNIQUE `(workspace_id, lower(name)) WHERE status <> 'archived'`
- `timezone text` (`assert_timezone`; defaults to the workspace's)
- `style jsonb` default `'{}'`, obj ≤16 KB (`BrandStyleV1`)
- `logo_asset_id uuid?`, FK `(id, logo_asset_id) → media_assets(brand_id, id) ON DELETE SET NULL (logo_asset_id)`
- `status brand_status` default `'active'`, `suspended_reason brand_suspended_reason?`, `suspended_at?`, `archived_at?`
- [ts]
- CHECKs: `(status = 'suspended') = (suspended_reason IS NOT NULL)`; `(suspended_reason IS NULL) = (suspended_at IS NULL)`; `(status = 'archived') = (archived_at IS NOT NULL)`
- INDEX `(logo_asset_id)`
- **Triggers:**
  - `private.enforce_brand_limit` (4.3): BEFORE INSERT, and BEFORE UPDATE OF status when the row becomes `active`.
  - User writes are web-only: an INSERT or UPDATE from a user context with `via ≠ 'web'` raises `AP009` (C35). The system context (inside `apply_entitlements`) may change `status` only.
  - User transitions: active → archived; archived → active; suspended (`plan_limit` only) → active. System transitions: active → suspended; suspended → active. Anything else raises `AP004`.
  - `workspace_id` is immutable.
  - `private.sync_brand_profile` (AFTER INSERT, AFTER UPDATE OF status): when the brand becomes active it ensures a usable provider profile, creating a pending one if needed; when the brand is archived it schedules profile deletion after 7 days, and when it is suspended, after 30 days (Q10); reactivation clears a pending deletion.
  - Audit: `brand.created`, `brand.status_changed`.

**`provider_profiles`**: one Upload-Post user profile per brand [V].
- `id`, [B]
- `provider posting_provider` default `'upload_post'`
- `profile_ref text` UNIQUE, CHECK `~ '^b_[0-9a-f]{32}$'`. Set by trigger from a fresh random UUID; immutable; never reused. It is the name we send to Upload-Post, so it reveals nothing about the tenant.
- `status profile_status` default `'pending'`. Transitions: pending → active or deleting; active → deleting; deleting → deleted.
- `delete_after?`: set by `sync_brand_profile`, cleared on reactivation
- `deleted_at?`, CHECK `(status = 'deleted') = (deleted_at IS NOT NULL)`
- [ts]
- UNIQUE `(brand_id) WHERE status IN ('pending','active')`: one usable profile per brand
- INDEX `(workspace_id, created_at) WHERE status <> 'deleted'` (churn guard), `(delete_after) WHERE delete_after IS NOT NULL AND status IN ('pending','active')` (deletion sweep)
- Writes: inserted by trigger only; the worker updates `status` and `deleted_at`.

**`connected_accounts`**
- `id`, [B]
- `provider_profile_id uuid`, FK `(brand_id, provider_profile_id) → provider_profiles(brand_id, id) ON DELETE CASCADE`
- `provider posting_provider`, `platform platform`
- `provider_account_id text` ≤256: the platform's stable account ID, as reported by Upload-Post
- `handle text?` ≤256, `display_name text?` ≤256, `avatar_url text?` CHECK `~ '^https://'` ≤2048
- `status connection_status` default `'connected'`, `status_reason text?` ≤200
- `capabilities jsonb` default `'[]'`, arr ≤16 KB: the Pages, organisations or boards this login can post to
- `destination jsonb` default `'{}'`, obj ≤4 KB (`DestinationV1`). This is **only the default** that `save_variant_revision` copies into new revisions; publishing always uses the revision's copy (C1).
- `credential_secret_id uuid?`, FK `(workspace_id, credential_secret_id) → encrypted_secrets(workspace_id, id) ON DELETE SET NULL (credential_secret_id)`; CHECK `provider <> 'upload_post' OR credential_secret_id IS NULL`
- `connected_at` default now(), `disconnected_at?`, `last_synced_at?`, [ts]
- CHECK `(status = 'disconnected') = (disconnected_at IS NOT NULL)`
- UNIQUE `(brand_id, id, platform)` and `(brand_id, id, platform, provider)`: FK targets
- UNIQUE `(brand_id, platform) WHERE status <> 'disconnected'`: one live account per platform per brand (Q9)
- UNIQUE `(workspace_id, provider, platform, provider_account_id) WHERE status <> 'disconnected'`: a real account is live in at most one brand of a workspace. Other workspaces may connect it too; platform caps are shared by identity (4.8; C48).
- UNIQUE `(provider_profile_id, platform, provider_account_id)`: one row per identity per profile, so a reconnect reactivates the existing row instead of creating a new one (C5)
- INDEX `(provider, platform, provider_account_id)`, `(credential_secret_id)`
- Immutable: `workspace_id`, `brand_id`, `provider_profile_id`, `provider`, `platform`, `provider_account_id`.
- **Writes.** There is no user INSERT. `app.upsert_connected_accounts` (worker) applies a provider snapshot:
  1. Same profile, platform and identity: update handle, name, avatar and capabilities. If the row was disconnected or needed re-auth, reactivate it (first disconnecting any live row of the same identity in another brand, as in case 3) and re-arm its held future posts (the `release_holds` rule, 4.8).
  2. A live row on the same (brand, platform) with a different identity: disconnect it (`identity_changed`) and insert the new row.
  3. The same identity live in another brand of this workspace: disconnect that row (`account_moved`) and insert the new row here.
  4. Rows missing from the snapshot: `reauth_required` or `disconnected`, as the provider reports.
- The only user UPDATE is `destination`: web-only, needs `accounts:connect`, and is audited as `account.destination_changed` (C1).

**`encrypted_secrets`**
- `id uuid PK`, chosen by the caller because it is part of the AAD (6.6)
- `workspace_id` FK → `workspaces ON DELETE CASCADE`; UNIQUE `(workspace_id, id)`
- `owner_kind secret_owner_kind`, `owner_id uuid`, `purpose secret_purpose`
- `alg text` CHECK `= 'A256GCM+RSA-OAEP-256'`
- `key_version int` > 0
- `wrapped_dek bytea` CHECK `octet_length = 384` (RSA-3072)
- `iv bytea` (12 bytes), `auth_tag bytea` (16 bytes), `ciphertext bytea` (1 B to 64 KB)
- `created_at`, `rotated_at?`, `last_used_at?`, `expires_at?`
- UNIQUE `(owner_kind, owner_id, purpose)`; INDEX `(key_version)`
- Triggers: the owner must exist in the same workspace; owner, purpose and workspace are immutable; audit `secret.stored` and `secret.rewrapped`.
- v1 stores nothing here (6.6). `app_user` has no privileges on this table at all; only workers insert (C35).

**External-resource guard** (C34). `private.guard_external_resources` runs BEFORE DELETE on `workspaces` and `brands`. It raises `AP004 external_resources_live` while any `provider_profiles` row in scope isn't `deleted`, or any `media_assets` row in scope is `verifying`, `ready` or `failed` (their R2 objects still exist). The step-8 purge deletes the Upload-Post profiles and R2 objects first and records that, then deletes the rows. Any other delete path fails loudly instead of orphaning platform tokens and files.

### 3.5 Usage metering

**`usage_balances`**: one row per (workspace, meter, period). Provider pool rows have `workspace_id` NULL.
- `id bigint IDENTITY PK`
- `workspace_id uuid?`, FK → `workspaces ON DELETE CASCADE`
- `pool_key text?` CHECK `~ '^[a-z_]+:[a-z_]+$'`; CHECK `(workspace_id IS NULL) = (pool_key IS NOT NULL)`
- `meter usage_meter`
- `period_start`, `period_end`, CHECK end > start
- `granted`, `granted_target_hwm`, `bonus`, `safety_margin`, `consumed`, `reserved`: all `bigint`, default 0, ≥0. `granted_target_hwm` is the highest entitlement target already granted in this period (C33).
- CHECK `reserved + consumed <= granted + bonus`
- [ts]
- UNIQUE `(workspace_id, meter, period_start)` and `(pool_key, meter, period_start)`
- EXCLUDE USING gist `(workspace_id WITH =, meter WITH =, tstzrange(period_start, period_end) WITH &&) WHERE (workspace_id IS NOT NULL)`, and the same for `pool_key`
- Trigger: `granted` and `granted_target_hwm` never decrease, except inside `app.meter_adjust`, which sets a transaction-local flag. No runtime role has any privilege beyond SELECT.

**`usage_ledger`**: the append-only journal. A balance always equals the fold of its rows (MET-18).
- `id bigint IDENTITY PK`; UNIQUE `(workspace_id, id)` (FK target)
- `workspace_id uuid?`, FK → `workspaces ON DELETE CASCADE` (NULL for pool rows)
- `balance_id bigint`, FK → `usage_balances(id) ON DELETE CASCADE`
- `meter usage_meter`, `kind ledger_kind`
- `amount bigint`, with sign rules per kind:
  - `period_open`, `grant`: ≥0; `bonus`, `reserve`: >0; `adjust`: ≠0
  - `settle`: from 0 to the reservation's amount (the consumed part; the rest returns to the balance)
  - `release`, `expire`: exactly the reservation's amount
- `reservation_id bigint?`, FK → `usage_ledger(id)`; CHECK `(kind IN ('settle','release','expire')) = (reservation_id IS NOT NULL)`
- `idempotency_key text` UNIQUE, ≤200
- `subject_type text?` CHECK IN (`transcript`, `clip`, `job`, `post`), `subject_id uuid?`
- `expires_at?`, `resolved_at?`: `reserve` rows only
- `actor text` ≤80 (`user:<uuid>`, `worker:<name>`, `system:<name>`, `staff:<name>`), `note text?` ≤500
- `created_at`
- UNIQUE `(reservation_id) WHERE reservation_id IS NOT NULL`: exactly one resolution per reservation
- INDEX `(balance_id)`, `(workspace_id, created_at DESC)`, `(subject_type, subject_id)`, `(expires_at) WHERE kind = 'reserve' AND resolved_at IS NULL`
- Append-only, with two exceptions on `reserve` rows: `expires_at` may only increase while the reservation is unresolved (`meter_extend`), and `resolved_at` is set once, by the resolution.

### 3.6 Jobs

**`jobs`**: the outbox. Each row is created in the same transaction as the state change that needs it; step 2 relays rows to pg-boss.
- `id`, [B]; UNIQUE `(workspace_id, id)`
- `kind job_kind`, `status job_status` default `'queued'`
- `parent_job_id uuid?`, FK `(workspace_id, parent_job_id) → jobs(workspace_id, id) ON DELETE SET NULL (parent_job_id)`
- `input jsonb`, obj ≤32 KB with `schema_version` (`JobInputEnvelope`). Validated parameters only: never share URLs, prompts or conversation text.
- `input_hash bytea` (32 bytes), computed by trigger as `sha256(convert_to(input::text, 'UTF8'))`
- `idempotency_key text?` ≤200
- `reservation_id bigint?`, FK `(workspace_id, reservation_id) → usage_ledger(workspace_id, id)`: the render reservation of `render_carousel` and `render_video` jobs (4.5)
- `progress smallint?` 0–100, `result jsonb?` obj ≤32 KB
- `error_code?`, `error_message?`
- `attempts int` default 0, CHECK 0–50; `queue_job_id text?` ≤128
- `heartbeat_at?`, `started_at?`, `finished_at?`
- `created_by_user_id uuid?`, `created_via via?`, [ts]
- CHECK `(status IN ('succeeded','failed','canceled')) = (finished_at IS NOT NULL)`
- UNIQUE `(brand_id, kind, input_hash) WHERE status IN ('queued','running')`; UNIQUE `(workspace_id, kind, idempotency_key) WHERE idempotency_key IS NOT NULL`
- INDEX `(workspace_id, brand_id, created_at DESC)`, `(parent_job_id)`, `(reservation_id)`, `(heartbeat_at) WHERE status = 'running'`, `(created_at) WHERE status = 'queued'`, `(workspace_id, kind) WHERE status IN ('queued','running')` (in-flight caps)
- State machine: queued → running, canceled or failed; running → succeeded, failed, canceled, or queued (a retry; `attempts + 1`).
- **Terminal cascade** (C3). AFTER UPDATE to `failed` or `canceled`, the definer trigger `private.on_job_terminal` fails the job's live subjects and returns their metering:
  - `transcribe`: its `pending` or `running` transcripts become `failed` (`job_failed` or `job_canceled`). Their reservation is released unless another live attempt row shares it.
  - `clip_render`: its `proposed` or `rendering` clips become `failed`; their render reservations are released.
  - `media_verify`, `source_ingest`: the asset becomes `failed`; linked sources in `pending`, `fetching` or `probing` become `failed`.
  - `render_carousel`, `render_video`: the job's reservation is released.
  - Nothing cascades on `succeeded`; the completion functions have already resolved everything.
- **Stale jobs:** `app.fail_stale_jobs` (system) fails running jobs whose heartbeat is older than a threshold (`heartbeat_lost`) and queued jobs older than another (`queue_timeout`). The cascade above then runs. Step 2 schedules it every 5 minutes with 15 minutes and 24 hours.
- **Who creates jobs** (7.1): `register_source` (`source_ingest`), `complete_upload` (`media_verify`), `request_transcription` and `fail_transcript` (`transcribe`), `request_clips` (`clip_render`), and `create_job` (`render_*`, `import_past_posts`, `sync_accounts`). Workers never insert jobs.

### 3.7 Media, sources, transcripts and clips

**`media_assets`**: one stored file.
- `id`, [B]
- `kind media_kind`, `purpose media_purpose`, `origin media_origin`
- `status media_status` default `'pending_upload'`
- `filename text` ≤128, CHECK `~ '^[A-Za-z0-9][A-Za-z0-9._ -]*$'` and no `..`
- `mime_type text` ≤100. CHECK that kind and MIME agree: video → `video/*`, audio → `audio/*`, image → `image/*`, document → `application/pdf`, data → `application/json`.
- `declared_bytes bigint?` > 0. Required for origins `upload` and `cloud_drive`. At most 10 GiB for video and audio (Q13), 50 MB for images, 100 MB for documents.
- `upload_id text?` ≤1024: the R2 multipart upload ID, used above 100 MB (a single R2 PUT is limited to about 5 GB [V\*]; C12)
- `upload_key text GENERATED ALWAYS AS (CASE WHEN origin = 'upload' THEN 'stg/' || workspace_id || '/' || id END) STORED`: the key in the **staging bucket** that presigned PUTs target
- `r2_key text GENERATED ALWAYS AS ('ws/' || workspace_id || '/b/' || brand_id || '/' || <seg> || '/' || id || '/' || filename) STORED`, where `<seg>` is `src` (clip_source), `med` (post_media), `out` (render_output) or `drv` (derived). It lives in the **media bucket**, which only Railway workers can write, so no presigned URL can ever overwrite a verified object (C26, C45).
- `bytes bigint?`, `sha256 bytea?` (32 bytes), `width int?`, `height int?`, `duration_ms int?`: measured by the worker on the immutable copy. Duration is measured by decoding packet timestamps, never read from container headers (C26).
- `produced_by_job_id uuid?`, FK `(workspace_id, …) → jobs ON DELETE SET NULL (produced_by_job_id)`
- `ready_at?`, `deleted_at?`, [ts]
- **Checks:**
  - `status <> 'ready' OR (bytes IS NOT NULL AND sha256 IS NOT NULL AND ready_at IS NOT NULL)`
  - `status <> 'ready' OR kind NOT IN ('video','audio') OR duration_ms IS NOT NULL`
  - `(status = 'deleted') = (deleted_at IS NOT NULL)`
  - `origin NOT IN ('upload','cloud_drive') OR declared_bytes IS NOT NULL`
  - `declared_bytes IS NULL OR bytes IS NULL OR bytes <= declared_bytes`
  - `upload_id IS NULL OR origin = 'upload'`
  - Purpose and origin agree: `clip_source` comes from `upload` or `cloud_drive`; `cloud_drive` is always `clip_source`; `render_output` comes from `clip_render` or `template_render`; `(purpose = 'derived') = (origin = 'derived')`.
- INDEX `(workspace_id, brand_id, created_at DESC)`, `(produced_by_job_id)`, `(workspace_id) WHERE status IN ('pending_upload','verifying','ready') AND origin IN ('upload','cloud_drive')` (storage sum), `(status, updated_at) WHERE status IN ('pending_upload','verifying')` (stale sweep)
- **Triggers:**
  - User inserts: origin is forced to `upload` and status to `pending_upload`; purpose must be `clip_source` or `post_media`; the caller needs `drafts:write` or `clips:write` (C35); the brand must be writable (`AP010`; C18).
  - Storage quota (4.6), BEFORE INSERT for origins `upload` and `cloud_drive`.
  - Generated keys can't be supplied. Identity, kind, purpose, origin and filename are immutable. `bytes`, `sha256`, `width`, `height` and `duration_ms` are immutable once the asset is ready.
  - State machine: pending_upload → verifying, failed or deleted; verifying → ready or failed; ready → deleted; failed → deleted.
  - An asset referenced by `revision_media`, by a source that isn't deleted, or by a clip that isn't discarded can't move to `deleted`. The only exception is the step-8 purge function, which deletes a whole workspace's objects; it runs as the table owner, which the trigger recognises by `current_user = 'postgres'` (runtime roles never are).
- **Upload flow:** `createUploadAsset` (user INSERT) → the app presigns PUTs, or multipart parts, for `upload_key` → `app.complete_upload(asset)` moves the asset to `verifying` and creates a `media_verify` job in the same transaction (C4) → the worker copies the object to `r2_key` in the media bucket, hashes and probes the copy, and marks the asset ready. The staging bucket's lifecycle rule deletes objects and aborts incomplete multipart uploads after 1 day (step 5).

**`source_media`**: a video the user owns and wants to clip.
- `id`, [B]
- `origin source_origin`
- `drive_provider drive_provider?`
- `origin_url text?` ≤2048: the normalized share URL. It isn't readable by `app_user` (column grants), is never copied into `jobs.input` or logs, and is set to NULL once the fetch has finished or failed (C41).
- `origin_host text?` ≤253
- `media_asset_id uuid?`, FK `(brand_id, …) → media_assets ON DELETE SET NULL (media_asset_id)`
- `job_id uuid?`, FK `(workspace_id, …) → jobs ON DELETE SET NULL (job_id)`: the ingest or verify job (C4)
- `title text?` ≤300
- `status source_status` default `'pending'`
- `duration_ms int?` CHECK 1–14,400,000 (4 hours, Q13), copied from the asset
- `probe jsonb?` obj ≤16 KB (codecs, frame rate, dimensions, audio streams)
- `ownership_attested_at timestamptz`, `attested_by_user_id uuid`
- `error_code?`, `error_message?`
- [ts], `deleted_at?`
- **Checks:**
  - `(origin = 'upload') = (origin_host IS NULL AND drive_provider IS NULL)`
  - `origin = 'cloud_drive_link' OR origin_url IS NULL`
  - `origin <> 'cloud_drive_link' OR status NOT IN ('pending','fetching') OR origin_url IS NOT NULL`
  - `origin_url IS NULL OR origin_url ~ '^https://[a-z0-9.-]+(/|\?|#|$)'`. The URL must be normalized: lowercase host, `https` only, no userinfo, no port. This closes C's `https://drive.google.com@youtube.com/…` hole.
  - `origin_url IS NULL OR origin_host = substring(origin_url FROM '^https://([a-z0-9.-]+)')`
  - `origin_host IS NULL OR NOT private.is_youtube_host(origin_host)`
  - `origin_host IS NULL OR private.is_allowed_drive_host(drive_provider, origin_host)`
  - `status <> 'ready' OR (media_asset_id IS NOT NULL AND duration_ms IS NOT NULL)`
  - `(status = 'deleted') = (deleted_at IS NOT NULL)`
- INDEX `(workspace_id, brand_id, created_at DESC)`, `(media_asset_id)`, `(job_id)`
- **Created only by `app.register_source`** (C4), which:
  - requires `clips:write`, a writable brand (`AP010`) and `p_attest = true` (`AP007`);
  - for uploads, requires an asset of purpose `clip_source` and kind video or audio in the same brand. The source starts as `pending`, `probing` or `ready` to match the asset's status;
  - for drive links, stores the URL, host and provider (the CHECKs re-validate them), checks storage headroom, and creates the `source_ingest` job in the same transaction;
  - writes `source.attested` to the audit log.
- **Triggers:**
  - The referenced asset must be of kind `video` or `audio`, purpose `clip_source`, origin `upload` or `cloud_drive`. Renders can never become sources.
  - `attested_by_user_id` is forced to the caller, and `ownership_attested_at` to `now()`. Both are immutable.
  - `origin_url` may only change to NULL.
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
- `engine transcription_engine`, `engine_model text?` ≤100
- `status transcript_status` default `'pending'`
- `is_reuse bool` default false, immutable (C2)
- `language text?` CHECK `~ '^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$'`
- `duration_ms int?`, `segment_count int?`
- `words_asset_id uuid?`, FK `(brand_id, …) → media_assets ON DELETE SET NULL (words_asset_id)`. Word-level JSON lives in R2 (purpose `derived`), for burned-in captions.
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
  - Leaving `proposed` or `rendering` for `failed` or `discarded` releases the render reservation (a definer trigger). The render worker skips clips discarded while their job runs.
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
- `created_by_user_id uuid?`, `created_via via?`, `oauth_client_id text?` ≤512 (renamed from `mcp_client_id`, so the same name is used everywhere; C20)
- `last_activity_at timestamptz` default now(): bumped by `save_variant_revision`, `submit_variants`, `decide_variants`, `schedule_variant`, `reschedule_post`, `cancel_post` and `retry_post`, so lists sort by real activity (C17)
- [ts]
- CHECK `((status='archived') = (archived_at IS NOT NULL))`
- INDEX `(workspace_id, brand_id, last_activity_at DESC, id)`, `(source_clip_id)`, `(source_job_id)`, `(voice_profile_id)`
- **Triggers:**
  - On user insert, `origin` is forced from `via` (`web` → `web`; `mcp` or `mcp_app` → `mcp`), and `created_by_user_id`, `created_via` and `oauth_client_id` are forced from `private.ctx()`. Supplied values are overwritten (C20).
  - `clip` and `render` origins can be inserted only by definer functions (`complete_clip`, `complete_render`), which set the actor columns to NULL and `created_via` to NULL.
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
- `media_asset_id uuid`, FK `(brand_id, …) → media_assets(brand_id, id)` NO ACTION. The asset must be `ready` and of purpose `post_media`, `render_output` or `clip_source`, never `derived`.
- `role text` default `'item'`, CHECK IN (`item`, `cover`, `thumbnail`, `captions`)
- `alt_text text?` ≤1000
- PK `(revision_id, position)`. INDEX `(media_asset_id)`, `(brand_id)`.
- No runtime role has any grant. Only `app.save_variant_revision` writes rows. Append-only.

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
    - After `published`, only `platform_post_id`, `post_url` and `needs_id_followup` may change, because TikTok's post ID can arrive up to 24 h late [V].
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

- **Repeated outcomes** (C39). `app.record_post_outcome` returns `already_applied`, without raising, when the reported outcome equals the post's current terminal state. In that case it only applies the late columns (`platform_post_id`, `post_url`, `needs_id_followup`). A webhook and a reconcile poll can therefore report the same result twice.
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
- `actor_kind text` CHECK IN (`user`, `worker`, `system`)
- `actor_user_id uuid?`, `actor_worker text?` ≤64
- `via via?`, `oauth_client_id text?` ≤512, `request_id text?` ≤128
- `action text` CHECK `~ '^[a-z_]+\.[a-z_]+$'`
- `subject_type text` ≤64, `subject_id text` ≤128
- `details jsonb` default `'{}'`, obj ≤8 KB (IDs and enums only, never content or secrets)
- INDEX `(workspace_id, occurred_at DESC)`, `(subject_type, subject_id)`
- **Actions:** `brand.created`, `brand.status_changed`, `account.status_changed`, `account.destination_changed`, `source.attested`, `approval.decided`, `approval.superseded`, `post.status_changed`, `post.rescheduled`, `entitlement.changed`, `voice_profile.saved`, `secret.stored`, `secret.rewrapped`, `usage.bonus_granted`, `usage.adjusted`, `pool.period_set`.

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
- Context helpers (`private.ctx`, `uid`, `via`, `ctx_workspace_id`, `user_workspace_ids`, `user_brand_ids`, `has_scope`, `require_scope`) are described in section 6.2.
- Trigger functions: `private.touch_updated_at()`, `private.append_only()`, `private.assert_reservation()`, `private.assert_timezone()`, `private.enforce_brand_limit()`, `private.sync_brand_profile()`, `private.guard_external_resources()`, `private.on_job_terminal()`, `private.audit()`.
- **Grants** (C36): the CHECK helpers and the context helpers are executed with the caller's privileges (Postgres checks EXECUTE when it evaluates a CHECK expression or a policy), so EXECUTE on them is granted to `app_user` and `app_worker`. Internal functions (`meter_reserve`, `ensure_current_balance`, `compute_revision_hash`, …) are SECURITY INVOKER with no grants; they run as `postgres` only when a definer function calls them. Trigger functions have no grants.

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
- The period comes from the base plan's subscription item [V]. A comp-only workspace uses the UTC calendar month.
- `applyBilling(SystemTx, ws, snapshot)` (step 8 calls it after re-fetching the subscription, so event order doesn't matter [V]) computes the numbers and calls `app.apply_entitlements(ws, billing, entitlements, effective_at)`. `effective_at` is the time of the Stripe change that produced the snapshot (the event's `created`), clamped into the period. In one transaction, the function:
  1. locks `workspaces` FOR NO KEY UPDATE;
  2. decides whether the snapshot's period start equals the stored `ent_period_start` (**same period**) or not (**new period**: a renewal, a first subscription, or a renewal that also carries a scheduled downgrade);
  3. same period only: ensures the current-period balances exist, created from the *stored* entitlements;
  4. writes the mirror and computed columns and bumps `entitlements_version`;
  5. same period: grants any increase above the period's high-water mark, pro rata from `effective_at` (4.4). New period: nothing is carried over; the new period's balances open at the *new* grant. A renewal that also applies a Pro → Starter downgrade therefore gives 14,400 s, not Pro's 72,000 (C32);
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
   - the profiles created since `ent_period_start` number ≥ `brand_limit + 2`.

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
     - `private.ensure_current_balance` lazily creates the period row from entitlements with `INSERT … ON CONFLICT DO NOTHING` (which also absorbs the exclusion constraint) and writes a `period_open` ledger row. It takes no workspace lock, so it fits any lock order (C44).
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
  - `app.meter_expire_reservations` is a reconciler, not a blind timer. For each unresolved reservation past `expires_at` it checks the subject:
    - live with a fresh job heartbeat (under 15 minutes old): extend and skip;
    - live with a stale or missing heartbeat: fail the job, whose terminal cascade (3.6) releases the reservation;
    - finished but unsettled (`completed` transcript, `ready` clip, `succeeded` job, `published` post): settle with the recorded actual;
    - `failed`, `discarded`, `canceled`: release, with ledger kind `expire`.
    - Posts in `publishing`, `submitted`, `unknown` or `needs_attention` are live and are never expired.
  - **Late completion:** if `complete_transcript` finds its reservation already resolved (possible only after a bug or a manual action), it takes a fresh reservation for the same amount (key `transcribe:<id>:late`) and settles it. If the quota no longer allows that, the transcript fails with `reservation_lost`. Work is never recorded as free.
- **Settle** (`app.complete_transcript`, which calls `app.meter_settle`):
  - Inserts a `settle` row (the unique `reservation_id` index prevents a second resolution) and sets the reserve row's `resolved_at`.
  - Sets `reserved -= amount` and `consumed += least(actual, amount)` on the **reservation's own balance**, even if the period has since rolled over.
  - A charge can never exceed its reservation (security judge).
- **Fallback engine:** when Whisper fails, `app.fail_transcript(…, fallback => 'assemblyai')` marks the row failed and opens a new attempt row, with a new job, that reuses the same reservation. When the last attempt fails, the reservation is released.
- **Cancel and crashes:** `cancel_job`, the stale-job sweep and job failure all go through the terminal cascade (3.6), so a transcript can't stay `pending` or `running` forever and block its source and its content index (C3).
- **Periods:**
  - Anchored to the Stripe item period. There is **no rollover** (Q3).
  - If `now() ≥ ent_period_end` and the renewal sync hasn't landed yet, the reserve returns `no_active_plan`. The user sees a neutral "usage period is renewing" message, and an hourly step-2 sweep re-fetches stale subscriptions. **Decision:** B's approach, not C's guessed next period, because the guess can drift from Stripe.
  - Comp-only workspaces roll forward automatically by UTC month.
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
- **Settle:** `complete_clip` settles the measured output duration; `complete_render` settles the measured total. Neither can exceed the reservation.
- **Release:** failure, discard and cancel (the clip trigger and the job terminal cascade). TTL and reconciliation work as in 4.4.
- **Fair-use caps** (`AP019 fair_use_limit`): at most 30 ranges per `make_clips` request (VAL-12); at most 60 active clips per source; at most 3 render jobs (`clip_render`, `render_carousel`, `render_video`) queued or running per workspace.
- Clip renders don't consume `clip_seconds`; Q2 is unchanged.

### 4.6 Storage

User files cost R2 storage every month, so they are capped per workspace (C35; Q22).
- **Limit:** `storage_bytes_limit` from the catalog (50, 100 or 200 GB).
- **Counted:** the sum of `COALESCE(bytes, declared_bytes)` over the workspace's assets with origin `upload` or `cloud_drive` and status `pending_upload`, `verifying` or `ready`. Renders and derived files are bounded by the render allowance and by retention instead.
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

   If either reservation fails, the sub-block rolls both back, and the post becomes `held/x_link_quota_exhausted`. **A link is never stripped silently.**
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
   - Account not connected → `held/reauth_required` or `held/account_disconnected`.
   - Each of these holds sets `not_before = NULL`; the post waits for an event.
9. Count posts with the same (provider, platform, `provider_account_id`), in any workspace, with `dispatched_at > now() - window` and status in {publishing, submitted, unknown, published, inbox_fallback, needs_attention}. Bluesky video posts are also counted separately against `cap_max_video_posts`. The function returns only an outcome, never another tenant's rows. If the count is at or over the cap:
   - set `held/cap_reached` with `not_before` = the oldest counted `dispatched_at` + window;
   - return `deferred`.
10. Make the X link reservations (4.7).
11. Set `publishing`, `dispatched_at = now()`, `attempt_count + 1`, `provider_request_id = idempotency_key` and `claimed_by`, and write the audit row.
12. Return `claimed` with a payload built **only** from the revision:
    - text, options and `x_link_handling`;
    - media R2 keys and sha256s, in order;
    - the revision's `destination` (never the account's current value; C1) and the profile's `profile_ref`.

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
| Save a revision, decide, schedule | `drafts` then `draft_variants` row locks | Never approved with a mismatched latest revision; one live post per variant (plus the partial unique index) |
| Schedule an approval | `posts_one_per_approval` partial unique index | One publication per approval |
| Claim | identity advisory lock, then account row, then post row | Exactly one claimer; the cap is never exceeded for a real account |
| X link pool | conditional UPDATE on the pool row | The pool never goes negative |
| Transcribe the same content | partial unique index on `(brand_id, content_sha256) WHERE NOT is_reuse` | Charged once per content |
| Request clips | source row FOR UPDATE | At most 60 active clips per source |
| Webhooks, jobs | unique constraints | At-least-once delivery has an exactly-once effect |

## 5. Invariants

| # | Invariant | Where | Mechanism | Why there |
|---|---|---|---|---|
| I1 | No post exists without a live approval of the exact revision, account and destination it publishes, and no approval publishes twice | DB | `posts.approval_id` NOT NULL with the composite FK `(variant, approval, revision, account)`; a BEFORE INSERT gate (approved, not superseded, latest revision, brand active, account connected, entitlement active or grace); `posts_one_per_approval`; the claim re-verifies | It holds for every writer, including future admin tools, and an FK can't be forgotten |
| I2 | Approved content can't change | DB (+ app in step 2) | Revisions and revision media are append-only; the hash is computed in the DB over the account, the destination and media sha256; media bytes, sha256 and duration are frozen once ready; `r2_key` is generated, immutable, and in a bucket only workers can write (uploads land in a separate staging bucket); a new revision supersedes the approval; a live post locks the variant (`AP008`); the claim recomputes the hash and sends the revision's destination; step 2 checks the R2 object's sha256 before uploading | The app could compute a wrong hash; the DB computes it itself |
| I3 | A model can't approve on its own | DB + app | `approval_channel` has no `mcp` value; the channel, decider and client come from `private.ctx()`, never from parameters; in step 1 `decide_variants` accepts only `web`. Step 4 enables `mcp_app` only together with a human-presence check verified on Claude and ChatGPT (Q23) | The DB can't tell a human from a model holding the same token, and `visibility: ["app"]` is a host hint the server can't verify (C22) |
| I4 | Every post and clip starts as a draft | DB | Posts reference revisions only; a clip can't be `ready` without a draft (`source_clip_id`); renders become drafts through `complete_render`; clip and render media reach a platform only through a revision | Structural |
| I5 | Tenant and brand isolation | DB | Composite FKs on every child, including the revision → variant and snapshot → post links; brand-scoped RLS; workers scoped by `ctx.workspace_id`; functions return the same `AP001` for missing and cross-tenant rows | Defends against handler bugs and injected IDs |
| I6 | MCP tokens are limited to their brands and scopes, and fail closed | DB (+ app mints tokens in step 3) | `private.user_brand_ids()` intersects `ctx.brand_ids`; an MCP context without `brand_ids` or scopes sees nothing; scope predicates sit in policies and functions; web sessions get an explicit full scope set | No missing claim can widen access |
| I7 | Brand limit and profile churn guard | DB | Trigger with a workspace row lock; active brands ≤ limit; live profiles ≤ limit + 1; profile creations ≤ limit + 2 per period; brand writes web-only | Must hold under concurrency, whoever the caller is |
| I8 | Clip hours and render seconds are never overdrawn or overcharged, and work never outruns its charge | DB + worker | Conditional UPDATE; CHECK `reserved + consumed ≤ granted + bonus`; settle capped; `granted` monotonic; increases prorated above a high-water mark; reservations reconciled, never blindly expired; workers process at most the reserved seconds of a hash-verified copy whose duration was decoded | Strongest guarantee available; property-tested |
| I9 | Platform caps per real account | DB | `claim_post` with an advisory lock on (provider, platform, `provider_account_id`) and a rolling count across rows and workspaces from `platform_rules` | Many dispatcher workers may run at once, and account rows change on reconnect |
| I10 | X link posts are metered and never silently stripped | DB + app | Keep/strip decision before approval; one pair of reservations per claim; release when a claim ends without acceptance; coarse DB checks on text and `link_url`; `twitter-text` detection when saving and again before publishing | Precise detection needs a library; the DB catches obvious misses |
| I11 | Users clip only their own content | DB + app | No URL origin for media; normalized `origin_url` with no userinfo or port; host equals the URL host; allowlist CHECK; YouTube denied; attestation forced to the caller; sources must be uploads or drive files; `origin_url` unreadable by users and cleared after the fetch; no downloader dependencies (MIG-22); the step-5 fetcher checks every redirect hop against a per-provider download list and the YouTube denylist, refuses IP literals and private addresses, and caps hops | Defence in depth; an allowlist beats a denylist |
| I12 | Valid timestamps and clip ranges | DB + app | zod requires an offset on ISO instants; scheduling must be ≥ now − 60 s and ≤ 365 days ahead (function plus CHECK against `scheduled_set_at`); clips 3–600 s with a CHECK, and end ≤ source duration by trigger | The AI's input is validated twice |
| I13 | Text fits platform limits in the right unit | App (DB coarse ceilings) | Validators per unit (graphemes, UTF-8 bytes, UTF-16, X weighted) produce `validated_ok`; approval requires `validated_ok` (`AP007`) | Grapheme and weighted counting is impractical in SQL |
| I14 | State machines are valid | DB | Transition triggers on posts, jobs, clips, transcripts, sources, media, variants, profiles and brands | Covers every writer |
| I15 | Publishing never posts twice | DB + app | Claim only from scheduled or held; a crash becomes `unknown` and is reconciled, never re-posted; the Idempotency-Key is a per-generation generated column [V]; repeated outcomes are `already_applied`; late webhooks for earlier generations are matched through `post_attempts`; a claim limit ends retry loops | Delivery is at-least-once |
| I16 | Who approved what, and when | DB | Append-only approvals; trigger-only `audit_events` | App code can't skip it |
| I17 | Only accounts verified by Upload-Post exist; account identity is fixed | DB | No user INSERT; immutable identity columns; reconnecting the same identity reactivates its row; an identity change or a move creates a new row; one live row per real account per workspace | Prevents account squatting and keeps history in one place |
| I18 | Secrets are encrypted; plaintext never reaches SQL | App (DB shape CHECKs) | `@app/crypto` seals before insert; IV and tag length CHECKs; `app_user` has no privilege on the table | The DB must never hold keys |
| I19 | Storage and in-flight work are bounded per workspace | DB | Storage sum under the workspace lock; ≤20 pending uploads; ≤3 render jobs in flight; ≤60 active clips per source | Costs per user must stay well below the price |
| I20 | Deleting a brand or workspace never orphans external resources | DB | `guard_external_resources` requires deleted Upload-Post profiles and deleted R2 objects before the rows can go | Profiles hold the user's platform tokens and occupy paid slots |

## 6. Security

### 6.1 Roles and connections

| Role | Attributes | Used by | Notes |
|---|---|---|---|
| `postgres` | Supabase owner | Migrations only | Owns all tables and definer functions. Table owners are exempt from RLS because we never `FORCE` it (MIG-08 asserts `relforcerowsecurity = false`) |
| `app_api` | LOGIN NOINHERIT; member of `app_user`, `app_ingest` | Vercel (web, MCP, webhook routes), via the transaction pooler on 6543 with prepared statements off [V] | Has no privileges until it runs `SET LOCAL ROLE` |
| `app_worker_login` | LOGIN NOINHERIT; member of `app_worker`, `app_system` | Railway workers, via the session pooler on 5432 (avoids IPv6 `ENETUNREACH`) [V] | |
| `app_user` | NOLOGIN | User context | No BYPASSRLS |
| `app_worker` | NOLOGIN | Worker context scoped to one workspace | No BYPASSRLS; RLS uses `ctx.workspace_id` and fails closed |
| `app_system` | NOLOGIN | Cross-tenant scans | No table privileges; EXECUTE on system definer functions, which return IDs only |
| `app_ingest` | NOLOGIN | Webhook routes | INSERT on `inbound_events` plus `SELECT(id)` only |
| `anon`, `authenticated`, `service_role` | Supabase | — | No USAGE on `app` or `private` |

- **Decision:** B's role model (security and forward judges) over A's single BYPASSRLS `app_backend` (cost judge).
  - What it guarantees: the internet-facing tier holds no credential that bypasses RLS, runs cross-tenant system functions, or opens secrets (private keys live on Railway only, 6.6).
  - What it does **not** guarantee (C24): `app_api` builds the request context, so a compromised Vercel deployment could set any user's `sub` and act as that user, one user at a time. An earlier draft claimed otherwise; that claim is withdrawn.
  - Mitigations: Vercel holds no Supabase service-role key (account deletion runs on a Railway worker; see the last bullet of this section), so it can't list users; every write is audited with its request ID; and `private.ctx()` is the single choke point, so identity resolution can later move into the database without changing any policy (9, step 3).
  - The cost judge's main worry, untested Supavisor custom-role support, is covered by a staging smoke test. Whether Supavisor accepts custom login roles (`app_api.<ref>`) is **[U]**. If it doesn't, the fallback is direct connections: the IPv4 add-on or Railway's IPv6.
- C's `media_worker` role is dropped; the clip and render workers use `app_worker`.
- **Passwords** are never in migrations. Hosted passwords are set by `scripts/set-db-role-password.ts`; local ones by `scripts/db-local-login-roles.sql`.
- The **service-role key** is not used by the app. Step 8 uses it in one Railway worker job, for Auth admin user deletion; it is never deployed to Vercel (C24).

### 6.2 Request context and helpers

`@app/db` opens a transaction, runs `SET LOCAL ROLE <role>`, then calls `set_config('app.ctx', <json>, true)` and sets the timeouts. The context JSON depends on the caller:

| Context | JSON |
|---|---|
| User | `{"sub","via":"web\|mcp\|mcp_app","scopes":[…],"brand_ids":[…]?,"oauth_client_id"?,"request_id"}` |
| Worker | `{"worker","workspace_id","request_id","job_id"?}` |
| System | `{"system","request_id"}` |

- `via` is set by server code from the authentication mechanism: a cookie session means `web`, an MCP bearer token means `mcp`, and an app-only tool handler means `mcp_app`. A token can't choose it.
- The JSON is built in one place, `withUser` / `withWorker` / `withSystem`, from a typed and zod-validated context object; handlers never assemble it (DAL-04).
- Web contexts carry the explicit full scope list.
- Because the settings are transaction-local, a pooled connection never carries context into the next request (DAL-02).

Helpers live in `private`. They are STABLE SECURITY DEFINER with `search_path=''`, and EXECUTE is granted only to `app_user` and `app_worker`.

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
create policy wrk on app.<t> for all to app_worker
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
| workspaces | `id` ∈ ws | fn `ensure_workspace` | `name`, `timezone` (ws/web) | — | R | fn |
| workspace_billing | ws/web | — | — | — | R | fn `apply_entitlements` |
| platform_rules | all rows | — | — | — | R | — |
| brands | `id` ∈ `user_brand_ids()` | `workspace_id`, `name`, `timezone`, `style` (web only, by trigger) | `name`, `timezone`, `style`, `logo_asset_id`, `status` (web only; status trigger-limited) | — | R | fn `apply_entitlements` (suspend, reactivate), `resolve_profile_ref` |
| provider_profiles | br | — | — | — | R; U(`status`, `deleted_at`) | fn `resolve_profile_ref` |
| connected_accounts | br | — | `destination` (ws/web, `accounts:connect`; audited) | — | R + fn upsert/status | — |
| encrypted_secrets | **none** | **none** | — | — | R; I; U(`wrapped_dek`, `key_version`, `rotated_at`, `last_used_at`, `expires_at`, `ciphertext`, `iv`, `auth_tag`) | fn `secrets_for_rewrap` |
| usage_balances | ws (pool rows invisible: `workspace_id` null) | — | — | — | R + fn | fn |
| usage_ledger | ws/web | — | — | — | R + fn | fn |
| jobs | br | fn | fn `cancel_job` | — | R; U(`status`, `progress`, `result`, `error_*`, `attempts`, `queue_job_id`, `heartbeat_at`, `started_at`, `finished_at`) | fn `fail_stale_jobs` |
| media_assets | br, `status ≠ deleted` | `id`, `workspace_id`, `brand_id`, `kind`, `purpose`, `filename`, `mime_type`, `declared_bytes`, `upload_id` (`drafts:write` or `clips:write`; origin forced to `upload`, status `pending_upload`) | fn `complete_upload` | — | R; I (non-upload origins); U(`status`, `bytes`, `sha256`, `width`, `height`, `duration_ms`, `ready_at`, `deleted_at`) | — |
| source_media | br, every column **except `origin_url`** | fn `register_source` | `title` (`clips:write`) | — | R (including `origin_url`); U(`status`, `media_asset_id`, `job_id`, `duration_ms`, `probe`, `origin_url` → NULL only, `error_*`, `deleted_at`) | — |
| transcripts | br | fn `request_transcription` | — | — | R; U(`engine_model`, `language`, `duration_ms`, `segment_count`, `words_asset_id`, `job_id`, `status`→running) + fn complete/fail | — |
| transcript_segments | br | — | — | — | R; I (while running) | — |
| clips | br | fn `request_clips` | `status` (→discarded only; `clips:write`) | — | R; U(`status`, `output_asset_id`, `thumbnail_asset_id`, `error_*`, `ready_at`, `job_id`) + fn `complete_clip` | — |
| voice_profiles | br | fn `save_voice_profile` | — | — | R | — |
| drafts | br | `workspace_id`, `brand_id`, `label`, `notes`, `voice_profile_id` (`drafts:write`; origin and actor columns forced) | `label`, `notes`, `status`, `archived_at` (`drafts:write`) | own, when it has no posts (FK) | R | — |
| draft_variants | br | `workspace_id`, `brand_id`, `draft_id`, `platform` (`drafts:write`) | — | own, while editing with no posts | R | — |
| variant_revisions | br | fn `save_variant_revision` | — | — | R | — |
| revision_media | br | — | — | — | R | — |
| approvals | br | fn `decide_variants` | — | — | R | — |
| posts | br | fn `schedule_variant` | fn reschedule/cancel/retry | — | R + fn claim/outcome | fn `list_due_posts`, `mark_stuck_publishing_unknown`, `release_holds` |
| post_attempts | br | — | — | — | R; I; U(`finished_at`, `outcome`, `http_status`, `error_*`, `response_summary`, `provider_*`) | — |
| imported_posts | br | — | `excluded_from_voice` (`voice:write`) | — | R; I; U(metadata columns) | — |
| account_metric_snapshots | br/an | — | — | — | R; I; U | — |
| post_metric_snapshots | br/an | — | — | — | R; I | — |
| inbound_events | none | — | — | — | — | system: fn; ingest: INSERT(`source`, `event_id`, `event_type`, `object_ref`, `provider_profile_ref`, `payload`, `livemode`, `signed_at`) + SELECT(`id`) |
| audit_events | ws/web | — | — | — | — | — (trigger function only) |

Notes:
- `imported_posts.matched_post_id` is set only by the matching triggers (3.11), never by a grant.
- System changes to `brands.status` (suspend, reactivate) happen only inside `apply_entitlements`; no worker or system grant writes brand columns directly.

The full role × object × privilege set is checked against the fixture `supabase/tests/fixtures/grants.expected` (MIG-09).

### 6.4 SECURITY DEFINER rules

1. `set search_path = ''`, and every name is schema-qualified. The function is owned by `postgres` (the table owner).
2. The actor, `via`, scopes and brand scope come only from `private.ctx()`. Parameters are never trusted for identity.
3. Each target row is resolved under the caller's predicate (`user_brand_ids` or `ctx_workspace_id`) and locked. Missing and foreign rows raise the same `AP001`.
4. Role, `via` and scope are checked before any side effect.
5. **EXECUTE** (C36). The first migration runs `ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA app, private REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC`, so no function is ever callable by PUBLIC. Each callable function is then granted to exactly one runtime role; the context and CHECK helpers to exactly `app_user` and `app_worker`; internal and trigger functions to nobody. `supabase/tests/fixtures/definer-allowlist.json` records the grantee set of every function in both schemas (MIG-11, MIG-24, FN-01/02/04).
6. Internal functions (`meter_reserve`, `ensure_current_balance`, `compute_revision_hash`, …) are SECURITY INVOKER. They run as `postgres` only when a definer function calls them, so a runtime role can never reach them with another tenant's IDs.
7. No dynamic SQL.

**Decision:** 40 callable definer functions (15 user, 11 worker, 14 system). Plain CRUD (brand rename, draft and variant creation, the account's default destination, discard, archive) goes through grants, RLS and triggers. Functions are used only where atomicity, a DB-computed value, metering or an untrusted caller requires them. This meets the cost judge halfway.

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
  - `SECRETS_KEY_CURRENT` and `SECRETS_PUBLIC_KEY_V<n>` (SPKI PEM) are on Vercel and Railway. `SECRETS_PRIVATE_KEY_V<n>` (PKCS8) is on **Railway only**.
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
- `redactUrl()` strips query strings.
- `scrubSecrets()` runs on every stored error message (C42). It removes `Bearer …` and `Apikey …` values, `token=` and `code=` parameters, PEM blocks, JWT-shaped strings (`eyJ[\w-]+\.[\w-]+\.[\w-]*`), `X-Amz-*`, `sig=`, `signature=` and `rlkey=` values, and the query string of every URL it finds.
- The error serializer masks connection strings.
- Rule: log IDs, counts and lengths, never content.

**Retention:**
- `inbound_events`: 30 days.
- `audit_events`: 13 months.
- Everything else: section 10 Q10.

## 7. Interfaces delivered in this step

### 7.0 No HTTP routes or MCP tools

- Every route and tool needs the step-3 auth design (OAuth resource server, token-to-context mapping) before it can be built or tested honestly.
- Step 1 delivers the SQL API, the DAL, shared schemas, and `scripts/dev-seed.ts` (a demo user, a workspace and a Pro comp, so steps 2–7 can run without Stripe).
- Testing from Claude and ChatGPT starts in step 2.
- **Tool mapping fixed now** (binding on steps 3–5; C10):
  - `get_transcript`: `readOnlyHint: true`. Returns the transcript (paged by time) or its status. It never registers a source and never charges.
  - `make_clips`: `readOnlyHint: false`, `destructiveHint: false`. Given a source (an uploaded asset or a drive link) and no ranges, it registers the source (`register_source`) and reports the clipping seconds a transcription will cost; with `confirm: true` it calls `request_transcription`. Given a completed transcript and ranges, it calls `request_clips` and reports the render seconds used.
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
     returns table(source_id uuid, job_id uuid)        -- [clips:write]; AP007 without attestation; AP010; AP018; AP003 (storage)
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
     returns table(job_id uuid, deduplicated boolean) -- render_* [drafts:write] (reserves render_seconds; AP019),
                                                    -- import_past_posts [voice:write], sync_accounts [accounts:connect]; other kinds AP009
app.cancel_job(p_job uuid) returns void              -- the scope of the job's kind; runs the terminal cascade
app.save_voice_profile(p_brand uuid, p_content jsonb, p_source app.voice_source, p_note text default null,
     p_based_on uuid default null, p_imported_ids uuid[] default '{}') returns uuid    -- [voice:write]; foreign imported IDs → AP001
```

Every user function that writes to a brand calls `private.assert_brand_writable` (4.3). Functions that change a draft's state bump `drafts.last_activity_at`, locking the draft before its variant (4.9).

**Worker functions** (`app_worker`; scoped to `ctx.workspace_id`):

```sql
app.claim_post(p_post uuid, p_worker text) returns table(outcome text, not_before timestamptz, payload jsonb)
     -- claimed | deferred | not_due | not_claimable | held | canceled | failed
app.record_post_outcome(p_post uuid, p_outcome jsonb) returns text   -- applied | already_applied; settles or releases X-link reservations
app.upsert_connected_accounts(p_profile uuid, p_accounts jsonb) returns setof uuid
     -- reactivates the same identity; handles identity_changed and account_moved; re-arms held posts
app.set_account_status(p_account uuid, p_status app.connection_status, p_reason text) returns void
app.complete_transcript(p_transcript uuid, p_result jsonb) returns void   -- settles; re-reserves if the reservation was lost
app.fail_transcript(p_transcript uuid, p_error_code text,
     p_fallback app.transcription_engine default null) returns uuid      -- fallback row (same reservation) or release
app.complete_clip(p_clip uuid, p_output uuid, p_thumbnail uuid default null) returns uuid
     -- creates the clip draft (no variants); settles render seconds
app.complete_render(p_job uuid, p_outputs uuid[]) returns uuid
     -- outputs must be ready, in the job's brand and produced by the job; creates the render draft (no variants); settles (C9)
app.meter_settle(p_reservation bigint, p_actual bigint) returns text   -- settled|already_settled|already_released
app.meter_release(p_reservation bigint, p_reason text) returns text
app.meter_extend(p_reservation bigint, p_until timestamptz) returns timestamptz   -- never shortens; refuses resolved reservations
```

**System functions** (`app_system`; cross-tenant; return IDs):

```sql
app.list_due_posts(p_limit int) returns table(post_id uuid, workspace_id uuid, due_at timestamptz)
app.mark_stuck_publishing_unknown(p_older_than interval) returns setof uuid
app.resolve_profile_ref(p_ref text) returns table(workspace_id uuid, brand_id uuid, provider_profile_id uuid)
app.apply_entitlements(p_ws uuid, p_billing jsonb, p_entitlements jsonb, p_effective_at timestamptz) returns jsonb
app.release_holds(p_ws uuid) returns int
app.meter_expire_reservations(p_limit int default 500) returns int      -- the reconciler of 4.4
app.meter_grant_bonus(p_ws uuid, p_meter app.usage_meter, p_amount bigint, p_key text, p_actor text, p_note text) returns void
app.meter_adjust(p_ws uuid, p_meter app.usage_meter, p_delta_consumed bigint, p_key text, p_actor text, p_note text) returns void
app.set_pool_period(p_pool_key text, p_meter app.usage_meter, p_start timestamptz, p_end timestamptz,
     p_granted bigint, p_margin bigint) returns void
app.claim_inbound_events(p_limit int) returns table(id uuid, source app.inbound_source, workspace_id uuid)
app.mark_inbound_processed(p_id uuid, p_error text default null) returns void
app.purge_inbound_events(p_older_than interval) returns int
app.secrets_for_rewrap(p_below_version int, p_limit int) returns table(id uuid, workspace_id uuid)
app.fail_stale_jobs(p_heartbeat_older_than interval, p_queued_older_than interval) returns setof uuid
```

**Internal** (SECURITY INVOKER, no grants): `private.meter_reserve`, `private.ensure_current_balance`, `private.compute_revision_hash`, `private.release_subject_reservations`, `private.assert_brand_writable`, `private.cap_lock_key`, `private.reservation_ttl`. Trigger functions have no grants either.

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
  multipartThresholdBytes: number; maxSourceDurationMs: number; maxPendingUploads: number };
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

// schemas/*.ts (zod 4, .strict())
export const VariantOptionsSchema;   // discriminated by platform, schema_version 1 (tiktok privacy_level required,
                                     // branded content ≠ private; x long_text_mode 'thread'|'single_post'; pinterest board)
export const CreateDraftInput, AddVariantsInput, SaveRevisionInput /* content.destination?: DestinationV1 */, DestinationV1,
  BrandStyleV1, CaptionStyleV1, ClipRenderSpecV1, VoiceProfileContentV1, JobInputEnvelope, RenderCarouselInputV1,
  RenderVideoInputV1, ClipRangeSchema, ClipRequestSchema /* ≤30 ranges */, IsoInstantSchema /* offset required */,
  ScheduleAtSchema /* ≥ now−60s, ≤ 365 d */, UploadRequestSchema /* kind, purpose, filename, mime, declaredBytes */,
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
export type Via = 'web' | 'mcp' | 'mcp_app';
export interface UserCtx   { kind: 'user'; userId: UserId; via: Via; scopes: readonly Scope[]; brandIds?: readonly BrandId[];
                             oauthClientId?: string; requestId: string }   // zod: brandIds required when via ≠ 'web'
export interface WorkerCtx { kind: 'worker'; worker: 'queue'|'clipper'|'renderer'; workspaceId: WorkspaceId; requestId: string; jobId?: JobId }
export interface SystemCtx { kind: 'system'; name: 'dispatcher'|'billing'|'sweeper'|'inbound'; requestId: string }
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
  - `markAssetFailed(tx: WorkerTx, id, code)`
- **`sources.ts`**
  - `registerUploadSource(tx: UserTx, i: { brandId; mediaAssetId; title?; attest: true })` (calls `register_source`)
  - `registerDriveSource(tx: UserTx, i: { brandId; url; title?; attest: true })` (uses `parseDriveUrl`, then `register_source`)
  - `getSource(tx: UserTx, id)`, `listSources(tx: UserTx, brandId)` (never select `origin_url`)
  - `getSourceForFetch(tx: WorkerTx, id)` (the only read of `origin_url`)
  - `updateSourceProbe(tx: WorkerTx, id, f)`
  - `setSourceStatus(tx: WorkerTx, id, s, err?)` (clears `origin_url` on leaving `fetching`)
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
  - `heartbeat(tx: WorkerTx, id)` (sets `heartbeat_at` and extends the job's open reservations with `meter_extend`)
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
  - `grantBonus(tx: SystemTx, i)`, `adjust(tx: SystemTx, i)`
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
- **`testing/fixtures.ts`** (dev-only export): `createTestUser`, `seedWorld`, `seedBrand`, `seedAccount`, `seedReadyMedia`, `seedReadySource`, `seedApprovedVariant`, `seedPost`, `setComp`, `markExternalResourcesDeleted`.

## 8. Tests

### 8.1 How tests run

**Locally:**

| Command | What it does |
|---|---|
| `pnpm db:start` | `supabase start -x studio,imgproxy,mailpit,edge-runtime,logflare,vector,realtime,storage-api` (exact service names vary with the CLI version **[U]**; the CLI is pinned) |
| `pnpm db:reset` | `supabase db reset && psql -f scripts/db-local-login-roles.sql` |
| `pnpm test:db` | `supabase test db` (pgTAP; every file is `BEGIN … ROLLBACK`) |
| `pnpm test` | Vitest `unit` and `meta` |
| `pnpm test:int` | Vitest `integration` against the local stack, connecting as `app_api` and `app_worker_login` |
| `pnpm db:types` | `kysely-codegen` |

**CI** (`.github/workflows/ci.yml`; both jobs are required for merge):
- **`static`:** install, `tsc -b`, eslint (including the boundary fixtures), `check-banned-deps`, `check-migrations-immutable`, `pnpm test`.
- **`db`:**
  1. Pinned `supabase/setup-cli`.
  2. `db:start` and `db:reset`.
  3. `supabase db lint --level warning`.
  4. `supabase test db`.
  5. `pnpm db:types && git diff --exit-code`.
  6. `pnpm test:int`, including the EXP and concurrency tests.

**Test conventions:**
- Integration tests create random tenants per test.
- Concurrency tests commit on N separate connections, each holding its transaction open with `pg_sleep(0.05)` so the calls really overlap. They clean up with `tests.purge_workspace`, run as `postgres`, which marks external resources deleted before deleting (3.4).
- Each concurrency test runs `CONC_ROUNDS` times (default 5). **Decision:** fewer than B's 20, but not dropped (cost judge versus security judge).
- msw runs with `onUnhandledRequest: 'error'`; localhost is passed through.

**Step-1 acceptance:**
- CI is green.
- `supabase db push --dry-run` against staging is clean.
- `pnpm db:smoke:staging` connects through Supavisor as both custom login roles and completes a `withUser` and `withWorker` round trip.

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
| MIG-11 | Every SECURITY DEFINER function has `search_path=''`, is owned by `postgres` and is in the allowlist. Every function in `app` and `private` has exactly the grantee set the allowlist records: one runtime role for callable functions, `app_user` and `app_worker` for the context and CHECK helpers, none for internal and trigger functions |
| MIG-12 | Every view has `security_invoker=true` |
| MIG-13 | For every FK, some index's leading column is the FK's first column other than `workspace_id` and `brand_id` (or its first column, when it has no other); the index is either not partial or partial only on `<that column> IS NOT NULL` |
| MIG-14 | Tenant tables have `workspace_id NOT NULL` (except the pool-capable usage tables, `inbound_events`, `audit_events` and `platform_rules`); brand tables have the composite brand FK |
| MIG-15 | Every table with `updated_at` has the touch trigger |
| MIG-16 | Append-only triggers exist on `variant_revisions`, `revision_media`, `approvals`, `usage_ledger`, `voice_profiles`, `transcript_segments` and `audit_events`. The only updates they allow are `approvals.superseded_*` once, `voice_profiles.is_active` true → false, and on `usage_ledger` reserve rows an increase of `expires_at` and a single `resolved_at` |
| MIG-17 | No `timestamp without time zone` columns |
| MIG-18 | Role shapes match 6.1: login roles are NOINHERIT with the exact memberships; no runtime role has SUPERUSER, BYPASSRLS, CREATEROLE or CREATEDB |
| MIG-19 | (Vitest) `app.platform_rules` rows equal `PLATFORM_RULES` |
| MIG-20 | (Vitest TOML parse) `[api].schemas` excludes `app` and `private` |
| MIG-21 | (CI) Merged migration files are unchanged compared with `origin/main` |
| MIG-22 | (CI) No `package.json` lists `ytdl-core`, `@distube/ytdl-core`, `yt-dlp*`, `youtube-dl*`, `play-dl` or `youtubei.js` |
| MIG-23 | (ESLint fixtures) Importing `upload-post` outside `packages/posting`, or `pg` / `kysely` outside `packages/db`, fails lint |
| MIG-24 | No function in `app` or `private` is executable by PUBLIC, including one created by a test migration after the first (default privileges); every internal function is SECURITY INVOKER (C36) |

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
| CON-07 | Status consistency checks hold (suspended needs a reason and timestamp; archived needs `archived_at`) |
| CON-08 | A web user can go active→archived, archived→active and suspended(`plan_limit`)→active; a user moving to suspended gets `AP004`; an MCP context inserting or updating any brand column gets `AP009`; the system can suspend; `workspace_id` is immutable |
| CON-09 | Inserting a brand creates a pending `provider_profiles` row whose ref matches `^b_[0-9a-f]{32}$` |
| CON-10 | The ref is immutable (`AP004`), unique and never reused; at most one pending or active profile per brand; profile transitions outside 3.4 raise `AP004` |
| CON-11 | Archiving a brand sets its profile's `delete_after` to now + 7 days and suspending it to now + 30 days; reactivation clears it; reactivating a brand whose profile is deleting or deleted creates a new pending profile with a new ref |
| CON-12 | A second live account for the same (brand, platform) is rejected; it is allowed after the first is disconnected; upserting the same identity under the same profile reactivates the existing row instead of inserting one |
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
| CON-20 | `ready` requires bytes, sha256 and `ready_at`; ready video or audio requires a duration; a kind/MIME mismatch (video with `image/png`) is rejected; an upload without `declared_bytes`, a video over 10 GiB, `bytes > declared_bytes`, and purpose/origin mismatches are rejected |
| CON-21 | A user insert of a render origin, with status ≠ `pending_upload`, with purpose `render_output` or `derived`, or without `drafts:write` or `clips:write`, is rejected; media referenced by a revision, a live source or an active clip can't move to `deleted` as `app_worker`, but can as the table owner (purge) |
| CON-22 | Sources with these hosts are rejected: `youtube.com`, `www.youtube.com`, `m.youtube.com`, `music.youtube.com`, `youtu.be`, `www.youtube-nocookie.com`, `r1.googlevideo.com`, `i.ytimg.com` |
| CON-23 | `https://drive.google.com@youtube.com/watch?v=x`, `https://drive.google.com:443/file/d/x`, `HTTPS://DRIVE.GOOGLE.COM/x` and `http://drive.google.com/x` are rejected; `https://drive.google.com/file/d/x` is accepted; an `origin_host` that differs from the URL host is rejected; the worker can set `origin_url` to NULL and never set it again |
| CON-24 | `google_drive` with a dropbox host, `www.googleapis.com`, `graph.microsoft.com` and `example.com` are rejected; `contoso-my.sharepoint.com` is accepted for `onedrive`; uses the shared host fixture |
| CON-25 | A direct `app_user` INSERT into `source_media` raises 42501; `register_source` without attestation gives `AP007`; an upload with a URL is rejected; a drive link without URL, host or provider is rejected; a supplied `attested_by_user_id` is overwritten with the caller |
| CON-26 | A source asset that is a render, a derived file or an image is rejected; `register_source` with a YouTube URL gives `AP018`; `ready` requires an asset and a duration; the source state machine holds |

**Transcripts and clips**

| ID | Asserts |
|---|---|
| CON-27 | One non-failed transcript per source (allowed again after failure); one non-failed original per (brand, sha256); `reservation_id` must be a `clip_seconds` `reserve` row in the same workspace (a settle row or another workspace is rejected); `is_reuse` is immutable; with one original and two reuse rows, hard-deleting the original's source (as `postgres`) succeeds and the reuse rows stay `is_reuse` (C2) |
| CON-28 | Transcript state machine; `completed` requires `completed_at`; a reuse row must be `completed` |
| CON-29 | Segments with end ≤ start are rejected; inserts are allowed only while `running`; update or delete after `completed` raises |
| CON-30 | 2,999 ms and 600,001 ms are rejected, 3,000 and 600,000 accepted; an end beyond the source duration raises; aspect ≠ 9:16 is rejected; another source's transcript fails the FK; a duplicate active range is rejected (allowed after discard); a 61st active clip on one source gives `AP019` |
| CON-31 | `ready` requires an output and a draft with `source_clip_id`; a user may only set `discarded` (anything else raises `AP004`); leaving `proposed` or `rendering` for `failed` or `discarded` releases the render reservation |

**Voice**

| ID | Asserts |
|---|---|
| CON-32 | A save creates version n+1 as active and deactivates n; one active version per brand; content over 64 KB or not an object is rejected; updating content raises; only `is_active` true→false is allowed; an imported-post ID from another brand gives `AP001` |

**Drafts, revisions, approvals**

| ID | Asserts |
|---|---|
| CON-33 | One variant per platform; platform is immutable |
| CON-34 | A revision whose account is on another platform or brand fails the FK; a revision whose `brand_id` differs from its variant's fails the FK; revisions and revision media are immutable (UPDATE raises `AP004`, direct DELETE raises); `app_user` has no grant on `revision_media` |
| CON-35 | A stale `p_expected_revision` raises `AP006`; revision numbers are sequential |
| CON-36 | Saving with unready media raises `AP013`; `content_kind` is derived; an X body with `https://` and `contains_link=false` is rejected; an X revision with `link_url` and `contains_link=false` is rejected; `x_link_handling` only on X with links; `validated_ok` must equal `validation.ok`; an unsupported kind (text to Instagram, document to X) or an out-of-range carousel count raises `AP007`; a destination outside the account's capabilities raises `AP007`; an omitted destination copies the account's default |
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
| CON-50 | After `published`, only `platform_post_id`, `post_url` and `needs_id_followup` change; lineage columns, including `provider_account_id`, are immutable |
| CON-51 | `published` needs `published_at`; `canceled` needs `canceled_at`; held, failed, needs_attention, canceled and skipped need `status_reason`; dispatched statuses need `dispatched_at` and `provider_request_id` |
| CON-52 | `retry_post` works only from `failed`, requires a live approval and bumps the generation; `cancel_post` refuses publishing, submitted and unknown |
| CON-53 | Rescheduling works only from scheduled or held, needs no re-approval, updates `scheduled_set_at`, and writes `post.rescheduled` |
| CON-54 | `post_attempts` is unique on (post, generation, `attempt_no`); `outcome` and `finished_at` are consistent |

**Imports, analytics, jobs, inbox, audit, usage**

| ID | Asserts |
|---|---|
| CON-55 | `imported_posts` is unique on (brand, platform, `provider_account_id`, `platform_post_id`), so an import through a new account row of the same identity updates instead of duplicating; the platform must match the account; `thumbnail_url` must be https; `matched_post_id` is set on insert when our post exists, and later when our post's `platform_post_id` arrives |
| CON-56 | Post snapshots have exactly one parent and one row per checkpoint; a snapshot whose account differs from its post's or imported post's fails the FK; metrics are non-negative; account snapshots are unique per (brand, provider, platform, `provider_account_id`, date, `metric_window`) |
| CON-57 | Job state machine; finished statuses need `finished_at`; `input` needs `schema_version` and a size bound; a duplicate active (brand, kind, `input_hash`) is rejected (allowed after finish); `idempotency_key` is unique per (workspace, kind) |
| CON-58 | `inbound_events` is unique on (source, `event_id`); a Stripe payload must be null; Stripe IDs need the `evt_` prefix |
| CON-59 | Brand creation, brand status, approve, post transition, account status, destination change, entitlement change, voice save, bonus and adjust, and secret store each write exactly one audit row, with actor, `via` and client taken from the context; no runtime role can insert, update or delete audit rows |
| CON-60 | `usage_balances`: `reserved + consumed > granted + bonus` raises; negatives raise; lowering `granted` or `granted_target_hwm` outside `meter_adjust` raises; overlapping periods for the same (workspace, meter) are rejected; two pool rows with the same (pool, meter, period) are rejected |
| CON-61 | `usage_ledger`: UPDATE raises, except an increase of a reserve row's `expires_at` and a single `resolved_at`; a direct DELETE raises; a workspace cascade works; a second resolution for a reservation is rejected; the sign rules for each kind hold |
| CON-62 | `updated_at` is touched on every [ts] table |

**Cascades and lifecycles**

| ID | Asserts |
|---|---|
| CON-63 | Deleting a workspace raises `AP004` while any profile isn't `deleted` or any asset is `verifying`, `ready` or `failed`; once those are marked, the delete removes its rows from every tenant table, leaves the other workspace's rows, and keeps audit rows (C34) |
| CON-64 | A brand hard delete (as system) is guarded the same way, then cascades through every brand table, including posts and approvals (the NO ACTION FKs are satisfied at statement end) |
| CON-65 | A draft with posts can't be deleted; a draft without posts can; media referenced by `revision_media` can't be hard-deleted |
| CON-66 | Job terminal cascade (C3): canceling or failing a `transcribe` job fails its pending or running transcripts and releases their reservation (unless a live fallback row shares it); a `clip_render` job fails its proposed or rendering clips and releases their render reservations; a `media_verify` or `source_ingest` job fails the asset and its pending, fetching or probing sources; a `render_*` job releases its reservation |
| CON-67 | Drafts inserted by a user context get `created_by_user_id`, `created_via` and `oauth_client_id` from the context, and `origin` from `via`, whatever was supplied; `last_activity_at` can't be written by `app_user` (C20) |
| CON-68 | For a suspended and for an archived brand, `register_source`, `complete_upload`, a media insert, `request_transcription`, `request_clips`, `create_job` (every kind), a draft insert, `save_variant_revision`, `decide_variants` and `schedule_variant` each raise `AP010`; reads, draft archiving, post cancellation and clip discards still work (C18) |
| CON-69 | `record_post_outcome` reporting the current terminal state returns `already_applied` without raising and applies a late `platform_post_id`; a different terminal state still raises `AP004` (C39) |
| CON-70 | `complete_upload` moves the asset to `verifying` and creates exactly one `media_verify` job in the same transaction; `register_source` for a drive link creates exactly one `source_ingest` job and stores it in `source_media.job_id`; an upload source follows its asset (pending → probing → ready) (C4) |

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
- `ub` (web)
- `worker(A)`, `worker(B)`, `worker(none)`
- `system`, `ingest`

**Battery:**

| ID | Assertion |
|---|---|
| ISO-1 | `anon` select raises 42501 |
| ISO-2 | `ua` sees 0 rows of B; `ub` sees 0 rows of A |
| ISO-3 | `ua/mcp[A1]` sees A1 rows and 0 A2 rows (workspace-level tables show only WS-A) |
| ISO-4 | `ua/mcp-nobrand` sees 0 rows (fails closed) |
| ISO-5 | A `ub` INSERT that references A's workspace or brand fails (42501, FK error or `AP001`) |
| ISO-6 | A `ub` UPDATE or DELETE of A's rows affects 0 rows or raises 42501 |
| ISO-7 | `worker(B)` and `worker(none)` see and change 0 A rows; `worker(A)` sees only A |
| ISO-8 | On function-only and system tables, a direct write by `ua` to its own rows raises 42501 |
| ISO-9 | `ua/mcp-noread` sees 0 rows of read-scoped tables |

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
| RLS-X11 | `app_user` selecting `source_media.origin_url` raises 42501, even on its own rows; `worker(A)` can read it |

**Function battery:**

| ID | Asserts |
|---|---|
| FN-01 | Every user-callable definer function in the allowlist, called by `ub` with A's IDs, raises `AP001` with no side effects (row counts and audit unchanged); the test iterates the allowlist |
| FN-02 | Every worker function called by `worker(B)` with A's IDs raises `AP001` |
| FN-03 | A cross-tenant ID and a random UUID raise identical errors |
| FN-04 | Every internal and trigger function, called directly by `app_user`, `app_worker`, `app_system` or `app_ingest`, raises 42501 (C36) |

### 8.5 Metering, limits, caps, X links and concurrency (pgTAP `30_metering` + Vitest)

**Entitlements and periods**

| ID | Asserts |
|---|---|
| MET-01 | `apply_entitlements` writes the mirror and computed columns, bumps the version, writes `entitlement.changed`, and is idempotent |
| MET-02 | The first reserve lazily opens a balance with the granted amount and period from `workspace_billing`, plus a `period_open` row |
| MET-03 | A comp-only workspace uses the UTC month and rolls over automatically |
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
| MET-17 | A bonus grant is idempotent; an `adjust` credit lowers `consumed`, never below 0 |
| MET-18 | After a scripted sequence, the ledger fold equals the balance |
| MET-19 | A second source with the same sha256 in the same brand reuses the transcript (an `is_reuse` row, same reservation, segments copied, no new ledger rows); an in-flight duplicate gives `AP017`; another brand is charged |
| MET-20 | A failed Whisper attempt opens a fallback row sharing the reservation; the final failure releases it |
| MET-21 | A trialing subscription has its clip seconds capped at the trial value and its render seconds at 3 × that |

**Brand limit and profiles**

| ID | Asserts |
|---|---|
| MET-22 | Starter: the second brand gives `AP002`; `extra_brand` × 1 allows it; archived and suspended brands don't count; unarchiving over the limit gives `AP002`; inactive entitlements give `AP015` |
| MET-23 | After `limit + 2` profile creations in the period, the next brand creation gives `AP016`; with `limit + 1` profiles not yet deleted, creating a brand gives `AP016` while reactivating a suspended brand that still has its profile succeeds; repeated archive and reactivate cycles can't exceed these bounds (C31) |
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
| MET-34 | `keep` with an allowance of 0 gives `held/x_link_quota_exhausted` and writes no ledger rows |
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
| MET-42 | Reconciler: past `expires_at`, a running transcript with a fresh heartbeat is extended, not released; with a stale heartbeat its job fails and the reservation is released; a completed but unsettled one is settled; a failed one is released as `expire`; posts in publishing, submitted, unknown or needs_attention are never expired (C27) |
| MET-43 | `cancel_job` while transcribing fails the transcript and releases the reservation; a new `request_transcription` on the same source then succeeds (C3) |
| MET-44 | Late completion after a release re-reserves and settles; with no quota left the transcript fails with `reservation_lost` |
| MET-45 | One snapshot that both renews the period and applies Pro → Starter opens the new period at 14,400 s; the old period's balance is untouched (C32) |
| MET-46 | Within one period, adding 2 h, removing them and adding 3 h grants only up to the 3 h target (prorated once), not 5 h (C33) |
| MET-47 | Render meter: `request_clips` reserves the sum of range seconds; `complete_clip` settles the measured duration; discard or failure releases; an exhausted allowance gives `AP003` with no clips inserted; `render_carousel` reserves 5 s per slide; a 4th in-flight render job gives `AP019` (C7, C30) |
| MET-48 | Storage: an upload that would exceed `storage_bytes_limit` gives `AP003` (meter `storage`); marking an asset deleted frees the space; the 21st pending upload gives `AP019`; a drive fetch counts toward the limit (C35) |
| MET-49 | A post claimed `max_attempts` times in one generation becomes `failed/too_many_attempts` on the next claim; `retry_post` resets the count (C38) |

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
| CONC-18 | 20 parallel `request_clips` of one 600 s range each against 3,600 render seconds: exactly 6 succeed |
| CONC-19 | 60 due Instagram posts spread over two account rows of the same identity in two workspaces, claimed in parallel: exactly 50 claimed |
| CONC-20 | 10 parallel uploads whose declared sizes together exceed the storage limit: the counted sum never exceeds it |
| CONC-21 | `save_variant_revision`, `archiveDraft` and `schedule_variant` racing on one draft never deadlock beyond the DAL's retries (lock order drafts → draft_variants) |

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
| LOG-04 | `scrubSecrets` removes Bearer and Apikey values, `token=` and `code=` parameters, PEM blocks, JWTs, `X-Amz-Signature` / `X-Amz-Credential`, `sig=`, `signature=` and `rlkey=` values, and URL query strings (C42); a `post_attempts.error_message` written through the DAL is scrubbed |
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
| VAL-15 | `computeEntitlements`: status mapping, plan plus add-ons, trial caps, comps, unknown keys reported in `unknownLookupKeys`, comp-only UTC month |
| VAL-16 | Every platform has a rule; Instagram 50 ≤ the brief's 100; TikTok 15; X 20; no cap above the brief's figure; `maxAttempts` is 25 everywhere |
| VAL-17 | TypeScript enum arrays equal the `pg_enum` labels (integration) |
| VAL-18 | No `DomainError` user message contains `upgrade`, `buy`, `purchase`, `pricing` or `$` (OpenAI policy [V]) |
| VAL-19 | `VariantOptionsSchema` is strict per platform; `DestinationV1`, `BrandStyleV1`, `CaptionStyleV1`, `ClipRenderSpecV1`, `VoiceProfileContentV1`, `RenderCarouselInputV1` (≤35 slides), `RenderVideoInputV1` (≤180 s) and `UploadRequestSchema` (size caps by kind) bounds hold; `JobInputEnvelope` requires `schema_version`; normalized metrics reject negatives and keep unknown keys in `extra`; `ProviderAccountSnapshot` parses Upload-Post doc sample fixtures |
| VAL-20 | `UPLOAD_LIMITS` and `RENDER_LIMITS` equal the numbers in 3.7, 4.5 and 4.6, and the DB constants used by triggers (integration parity) |

### 8.9 Data API exposure (Vitest against the local Supabase HTTP API)

| ID | Asserts |
|---|---|
| EXP-01 | REST requests for each `app` table, with the anon key and with a signed-in user's JWT, return not-found and no data |
| EXP-02 | A GraphQL introspection request returns a 404 or no app types |
| EXP-03 | `/rest/v1/rpc/claim_post` returns not found |

## 9. Deferred to later steps

**Step 2: PostingProvider, Upload-Post adapter, job queue**
- **pg-boss:** install the `pgboss` schema by migration, owned and granted to `app_worker`. Queues: `post.dispatch` (a cron tick over `list_due_posts`, with `key_strict_fifo` per account [V]), `reconcile.unknown`, `accounts.sync`, `inbound.process`, `reservations.sweep` (`meter_expire_reservations`), `jobs.stale` (`fail_stale_jobs` every 5 minutes with 15 minutes and 24 hours), `profiles.delete`, `inbound.prune`, `clip.process`, `render.*`, `analytics.pull`.
- **Outbox:** `jobs` is the outbox. Step 2 picks either a relay worker or granting `app_user` INSERT on `pgboss.job` inside `withUser`.
- **`PostingProvider`** in `packages/posting` (the only place that may reference Upload-Post):
  - send `show_calendar:false` and `disable_inbox_fallback=true`;
  - send `async_upload=true` from workers only;
  - Idempotency-Key and `request_id` come from `posts.idempotency_key` [V];
  - media handover: either stream the bytes from the media bucket (verifying sha256 on the way), or pass a short-lived presigned GET of the media-bucket key. Both are safe because only workers can write that bucket (C45).
- **Rate limiting and batching:** a global outbound token bucket that honours `X-RateLimit-*` [V]; `posts.dispatch_group_id` as an additive nullable column if multi-platform batching is adopted.
- **Before calling the provider:** verify each R2 object's sha256 against the payload, and re-detect links with twitter-text.
- **Follow-ups:** reconcile `unknown` posts by `request_id`; poll for TikTok's late post IDs (`needs_id_followup`); inbound processing falls back to `post_attempts` for earlier generations (`findPostByProviderRef`).
- **Profiles:** provision and delete profiles (pending → active; delete once `delete_after` passes, through an additive system function `app.list_profiles_due_for_deletion`); alert on `PROFILE_LIMIT_REACHED` [V].
- **Account sync after a connect webhook:** an additive system function that enqueues `sync_accounts` for a profile; `connect_account` uses `assert_brand_writable`.
- **Webhook routes:** HMAC check, 5-minute skew limit, then `recordInboundEvent` [V].
- **Logger:** wire `REDACT_PATHS` and `redactDeep` into every service.

**Step 3: MCP server and OAuth**
- An `oauth` schema: clients (CIMD plus DCR fallback), hashed auth codes, grants with `brand_ids` and scopes, refresh-token families with reuse detection, and signing keys whose private keys are sealed with `@app/crypto`.
- Map tokens to `UserCtx`, including `via`, scopes and `oauthClientId`.
- Tool annotations and the `get_transcript` / `make_clips` split as fixed in 7.0.
- **Evaluate in-database identity resolution** (C24): the context would carry only an opaque credential, and `private.ctx()` would look up its hash. This helps only if token and session issuance also moves off the internet-facing tier, because whoever mints credentials can mint them for anyone; it is an evaluation, not a commitment.
- Optional prefixed public IDs at the MCP boundary.
- The tool handlers, using the validators from step 1.

**Step 4: approval card**
- App-only `decide` tools that call `decide_variants` under `via='mcp_app'`.
- `decide_variants` starts accepting `mcp_app` only in the same migration that adds a human-presence check, and only after it is verified on Claude and ChatGPT (I3, Q23). The candidate is an `approval_challenges` table (nonce hash, revision, user, ≤10-minute TTL, `used_at`) whose nonce is never returned in a tool result, after checking whether hosts forward `_meta` or `structuredContent` to the model **[U]**. **Decision:** deferred rather than built now (2 of 3 judges), because its premise is unverified; until then the card's Approve and Reject buttons open the web confirmation.
- A web approval-queue fallback link.

**Step 5: clip worker**
- **R2:** two buckets. The staging bucket takes presigned PUTs and multipart uploads from the web app (above 100 MB); its lifecycle rule deletes objects and aborts incomplete multipart uploads after 1 day. The media bucket is written only by Railway workers (C12, C45).
- **`media_verify`:** copy staging → `r2_key`; compute bytes and sha256 from the copy; measure duration by decoding (packet timestamps, not container headers); `markAssetReady`. An integration test uses a mis-headered MKV fixture (C26).
- **Drive fetcher** (C8, C46): check every hop with `isAllowedDownloadHop` and the YouTube denylist; refuse IP literals and DNS results in private, loopback or link-local ranges (SSRF); at most 5 hops; compare `Content-Length` with the storage headroom and abort beyond the declared size; msw fixtures replay real redirect chains; clear `origin_url` when done.
- **Transcription:** verify the copy's sha256, feed at most the reserved seconds (`ffmpeg -t`), heartbeat through `jobs.heartbeat` (which calls `meter_extend`). Whisper with an AssemblyAI fallback.
- A `cloud_drive_connections` table (as an owner kind in `encrypted_secrets`) if drive pickers are used.
- Media retention sweepers (Q10), with an additive system function listing assets due for deletion.

**Step 6:** finalise `VoiceProfileContentV1`, the import pipeline and the `write_post` prompt.

**Step 7:**
- `render_templates` and `weekly_reviews` tables; the render worker reports through `complete_render`.
- The analytics pull cadence (Q16) over the `posts (published_at)` index, and per-post analytics within Upload-Post's 100-per-5-minute limit [V]. Whether that limit is per account or per profile is **[U]**.
- Prune non-checkpoint snapshots.

**Step 8:**
- Stripe Checkout, portal and webhook routes; the catalog-to-Stripe sync script.
- Configure every decrease (fewer add-ons, plan downgrades) to take effect at period end with no proration credit, and pass `effective_at` to `applyBilling` (C33).
- An hourly re-fetch of stale periods.
- Account deletion and purge, run by a Railway worker that holds the service-role key (C24): delete the Upload-Post profiles, then the R2 prefixes in both buckets, mark both done, then delete the workspace (the guard of 3.4 checks the order), then the auth user.
- Retention purges.
- Billing Meters, if X links are ever billed.

**Later:** teams (`workspace_members` plus a helper change), a direct X or Meta adapter (`ALTER TYPE posting_provider ADD VALUE`, encrypted credentials), a KMS key provider, a `client_file` media origin (Q21), and partitioning `audit_events` and `post_metric_snapshots`.

## 10. Open questions for the owner

1. **X posts with links.** Upload-Post strips links unless we buy its add-on: $19 a month for 50 link posts shared across all customers, about $0.38 each [V\*]. The brief's $0.20 is only available through a future direct X adapter.
   - *Default:* allowance 0 on every plan and no add-on. An X variant with a link must be marked "strip", with a warning on the card. Revisit when a direct adapter exists (for example Plus 5 and Pro 15 a month).
2. **What counts as a clipping hour?**
   - *Default:* seconds of source video, charged once per unique video per brand when it is first transcribed. Re-clipping doesn't use clipping hours (rendering uses the render allowance, Q20). Failed jobs are refunded automatically.
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
    - *Default:* one "I own or have the rights to this video" checkbox per source, recorded against the user who ticks it.
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

**Input note.** The plan text handed to this round began part-way through `source_media`'s checks. Sections 1, 2 and 3.1–3.7 were therefore rebuilt from every reference in the rest of the plan and from the brief (table list, notation, column names used by later sections, the platform-rules seed, the role and function inventory). The owner should review them with the same care as the rest.

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
- New error code `AP019 fair_use_limit`; new callable functions `register_source`, `complete_upload`, `complete_render`, `meter_extend` and `fail_stale_jobs` (40 in total).
