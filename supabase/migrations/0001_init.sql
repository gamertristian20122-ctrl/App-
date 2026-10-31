-- 0001_init.sql: the v1 data model (docs/ARCHITECTURE.md "Data model").
--
-- Conventions
--   * One tenant = one user. Every tenant table carries user_id (cascade from users).
--   * Child rows reference parents through composite (id, user_id) foreign keys, so a row can
--     never point at another user's brand, draft, media or account, whatever the caller sends.
--   * "Restrict where history matters" uses ON DELETE NO ACTION: deleting the parent directly
--     fails, but whole-user or whole-brand cascades still work (checked at end of statement).
--   * RLS is enabled on every table. The browser (role authenticated) may only SELECT its own
--     rows from the tables listed in section 6; everything else is server-only.
--   * Helper and trigger functions live in schema private (not exposed by PostgREST) and all set
--     search_path = '' with fully qualified names.
--   * Custom SQLSTATEs raised by triggers (mirrored in packages/db/src/errors.ts):
--       P0A01 draft not approved for this post / publish
--       P0A02 immutable column changed
--       P0A03 invalid post status transition
--       P0A04 cross-reference mismatch (wrong draft, brand, platform or owner)
--       P0A05 append-only table
--       P0A06 invalid approval or draft state
--
-- Requires (Supabase provides them; the test harness installs stand-ins): schema auth with table
-- auth.users(id uuid) and function auth.uid(), and roles anon, authenticated, service_role.

create schema if not exists private;
revoke all on schema private from public;

-- ---------------------------------------------------------------------------------------------
-- 1. Enums (order mirrors packages/core/src/types.ts)
-- ---------------------------------------------------------------------------------------------

create type public.plan_tier as enum ('starter', 'plus', 'pro');
create type public.subscription_status as enum ('none', 'trialing', 'active', 'past_due', 'canceled', 'unpaid');
create type public.platform as enum (
  'tiktok', 'youtube', 'instagram', 'facebook', 'threads', 'x', 'linkedin', 'pinterest', 'bluesky'
);
create type public.brand_status as enum ('active', 'suspended', 'archived');
create type public.account_status as enum ('pending', 'active', 'disconnected', 'needs_reauth');
create type public.media_kind as enum ('video', 'image', 'audio', 'captions');
create type public.media_origin as enum ('upload', 'drive_link', 'clip', 'render');
create type public.media_status as enum ('pending', 'ready', 'failed', 'deleted');
create type public.clip_status as enum ('queued', 'rendering', 'ready', 'failed');
create type public.draft_status as enum ('draft', 'approved', 'rejected', 'archived');
create type public.post_status as enum ('scheduled', 'publishing', 'published', 'failed', 'canceled');
create type public.job_status as enum ('queued', 'running', 'succeeded', 'failed', 'dead');
create type public.usage_meter as enum ('clip_seconds', 'x_link_posts');
create type public.usage_kind as enum ('reserve', 'settle', 'release', 'adjust');
create type public.actor as enum ('web', 'mcp', 'worker', 'system');

-- ---------------------------------------------------------------------------------------------
-- 2. Generic helpers
-- ---------------------------------------------------------------------------------------------

create function private.set_updated_at() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create function private.forbid_update() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception '% is append-only: rows cannot be updated', tg_table_name using errcode = 'P0A05';
end;
$$;

-- Direct DELETEs are refused; deletes cascading from a parent (users) run at trigger depth > 1.
create function private.forbid_direct_delete() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if pg_trigger_depth() <= 1 then
    raise exception '% is append-only: rows cannot be deleted', tg_table_name using errcode = 'P0A05';
  end if;
  return old;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- 3. Tables
-- ---------------------------------------------------------------------------------------------

-- 1. users -------------------------------------------------------------------------------------
create table public.users (
  id uuid primary key references auth.users (id) on delete cascade,
  email text not null check (char_length(email) between 3 and 320 and position('@' in email) > 1),
  display_name text check (char_length(display_name) <= 200),
  timezone text not null default 'UTC' check (char_length(timezone) between 1 and 64),
  plan public.plan_tier,
  subscription_status public.subscription_status not null default 'none',
  trial_ends_at timestamptz,
  current_period_start timestamptz,
  current_period_end timestamptz,
  extra_brands integer not null default 0 check (extra_brands >= 0),
  extra_clip_hours integer not null default 0 check (extra_clip_hours >= 0),
  stripe_customer_id text unique check (char_length(stripe_customer_id) between 1 and 255),
  stripe_subscription_id text unique check (char_length(stripe_subscription_id) between 1 and 255),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint users_period_order check (
    current_period_start is null or current_period_end is null or current_period_end > current_period_start
  )
);

-- 2. brands ------------------------------------------------------------------------------------
create table public.brands (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 100),
  timezone text not null default 'UTC' check (char_length(timezone) between 1 and 64),
  status public.brand_status not null default 'active',
  -- Upload-Post profile username; unique when set (NULLs are distinct).
  provider_profile_ref text unique check (char_length(provider_profile_ref) between 1 and 255),
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint brands_id_user_key unique (id, user_id),
  constraint brands_archived_at check ((status = 'archived') = (archived_at is not null))
);
create index brands_user_idx on public.brands (user_id, created_at);
create index brands_user_active_idx on public.brands (user_id) where status = 'active';

-- 3. connected_accounts ------------------------------------------------------------------------
create table public.connected_accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id) on delete cascade,
  brand_id uuid not null,
  platform public.platform not null,
  provider text not null check (provider ~ '^[a-z][a-z0-9_]{1,31}$'),
  external_account_id text check (char_length(external_account_id) between 1 and 255),
  handle text check (char_length(handle) <= 255),
  display_name text check (char_length(display_name) <= 255),
  status public.account_status not null default 'pending',
  -- AES-256-GCM (packages/core crypto encryptBytes); only for future direct adapters. Never
  -- readable by the browser (column grants below).
  encrypted_credentials bytea,
  scopes text[] not null default '{}' check (cardinality(scopes) <= 100),
  connected_at timestamptz,
  last_synced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint connected_accounts_id_user_key unique (id, user_id),
  constraint connected_accounts_brand_fk foreign key (brand_id, user_id)
    references public.brands (id, user_id) on delete cascade
);
-- One live account per platform per brand (Upload-Post allows one per profile and platform).
create unique index connected_accounts_live_platform_uidx
  on public.connected_accounts (brand_id, platform)
  where status in ('pending', 'active', 'needs_reauth');
create index connected_accounts_user_idx on public.connected_accounts (user_id);
create index connected_accounts_brand_idx on public.connected_accounts (brand_id);

-- 4. media_assets ------------------------------------------------------------------------------
create table public.media_assets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id) on delete cascade,
  brand_id uuid,
  kind public.media_kind not null,
  origin public.media_origin not null,
  status public.media_status not null default 'pending',
  storage_key text not null unique check (char_length(storage_key) between 1 and 1024),
  mime_type text check (char_length(mime_type) between 1 and 255),
  bytes bigint check (bytes >= 0),
  duration_ms integer check (duration_ms >= 0),
  width integer check (width > 0),
  height integer check (height > 0),
  sha256 text check (sha256 ~ '^[0-9a-f]{64}$'),
  -- Drive links: host only (kept); the full URL lives in source_url until fetched, then nulled.
  source_host text,
  source_url text check (char_length(source_url) <= 4096 and source_url ~ '^https://'),
  rights_attested_at timestamptz,
  parent_media_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint media_assets_id_user_key unique (id, user_id),
  constraint media_assets_brand_fk foreign key (brand_id, user_id)
    references public.brands (id, user_id) on delete set null (brand_id),
  constraint media_assets_parent_fk foreign key (parent_media_id, user_id)
    references public.media_assets (id, user_id) on delete set null (parent_media_id),
  -- Own content only: drive links must come from the allowlisted cloud drives (never YouTube).
  constraint media_assets_drive_host check (
    (origin = 'drive_link') = (source_host is not null)
    and (source_host is null or source_host in (
      'drive.google.com', 'docs.google.com', 'dropbox.com', 'www.dropbox.com',
      'dl.dropboxusercontent.com', 'onedrive.live.com', '1drv.ms'
    ))
  ),
  constraint media_assets_source_url_origin check (source_url is null or origin = 'drive_link'),
  constraint media_assets_drive_rights check (origin <> 'drive_link' or rights_attested_at is not null),
  constraint media_assets_parent_not_self check (parent_media_id is null or parent_media_id <> id)
);
create index media_assets_user_idx on public.media_assets (user_id, created_at desc);
create index media_assets_brand_idx on public.media_assets (brand_id);
create index media_assets_parent_idx on public.media_assets (parent_media_id);
create index media_assets_cleanup_idx on public.media_assets (created_at) where status <> 'deleted';

-- 5. transcripts -------------------------------------------------------------------------------
create table public.transcripts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id) on delete cascade,
  media_id uuid not null unique,
  engine text not null check (engine in ('whisper', 'assemblyai', 'fake')),
  language text check (char_length(language) between 1 and 35),
  duration_ms integer not null check (duration_ms >= 0),
  text text not null,
  words jsonb not null default '[]' check (jsonb_typeof(words) = 'array'),
  segments jsonb not null default '[]' check (jsonb_typeof(segments) = 'array'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint transcripts_media_fk foreign key (media_id, user_id)
    references public.media_assets (id, user_id) on delete cascade
);
create index transcripts_user_idx on public.transcripts (user_id);

-- 6. clips -------------------------------------------------------------------------------------
create table public.clips (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id) on delete cascade,
  brand_id uuid not null,
  source_media_id uuid not null,
  start_ms integer not null check (start_ms >= 0),
  end_ms integer not null,
  title text check (char_length(title) <= 500),
  hook text check (char_length(hook) <= 2000),
  caption_style text not null default 'bold' check (caption_style in ('bold', 'minimal', 'karaoke', 'none')),
  status public.clip_status not null default 'queued',
  output_media_id uuid,
  draft_id uuid,
  error text check (char_length(error) <= 4000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint clips_id_user_key unique (id, user_id),
  constraint clips_range check (end_ms > start_ms),
  constraint clips_max_length check (end_ms - start_ms <= 180000),
  constraint clips_brand_fk foreign key (brand_id, user_id)
    references public.brands (id, user_id) on delete cascade,
  constraint clips_source_fk foreign key (source_media_id, user_id)
    references public.media_assets (id, user_id) on delete no action,
  constraint clips_output_fk foreign key (output_media_id, user_id)
    references public.media_assets (id, user_id) on delete set null (output_media_id)
  -- clips_draft_fk is added after drafts exists (circular reference).
);
create index clips_user_idx on public.clips (user_id, created_at desc);
create index clips_brand_idx on public.clips (brand_id);
create index clips_source_idx on public.clips (source_media_id, start_ms);
create index clips_output_idx on public.clips (output_media_id);
create index clips_draft_idx on public.clips (draft_id);

-- 7. drafts ------------------------------------------------------------------------------------
create table public.drafts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id) on delete cascade,
  brand_id uuid not null,
  status public.draft_status not null default 'draft',
  revision integer not null default 1 check (revision >= 1),
  content_hash text not null default '',
  created_via public.actor not null,
  source_clip_id uuid,
  approved_revision integer,
  approved_hash text,
  approved_at timestamptz,
  approved_via public.actor,
  rejected_reason text check (char_length(rejected_reason) <= 2000),
  notes text check (char_length(notes) <= 10000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint drafts_id_user_key unique (id, user_id),
  constraint drafts_brand_fk foreign key (brand_id, user_id)
    references public.brands (id, user_id) on delete cascade,
  constraint drafts_source_clip_fk foreign key (source_clip_id, user_id)
    references public.clips (id, user_id) on delete set null (source_clip_id),
  -- approved <=> every approved_* field is set, and the approval is for the current revision.
  constraint drafts_approval_fields check (
    (status = 'approved') = (
      approved_revision is not null and approved_hash is not null
      and approved_at is not null and approved_via is not null
    )
  ),
  constraint drafts_approval_current check (
    status <> 'approved' or (approved_revision = revision and approved_hash = content_hash)
  )
);
create index drafts_user_idx on public.drafts (user_id, status, created_at desc);
create index drafts_brand_idx on public.drafts (brand_id);
create index drafts_source_clip_idx on public.drafts (source_clip_id);

alter table public.clips
  add constraint clips_draft_fk foreign key (draft_id, user_id)
    references public.drafts (id, user_id) on delete set null (draft_id);

-- 8. draft_variants ----------------------------------------------------------------------------
create table public.draft_variants (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id) on delete cascade,
  draft_id uuid not null,
  platform public.platform not null,
  connected_account_id uuid,
  text text not null default '' check (char_length(text) <= 70000),
  title text check (char_length(title) <= 500),
  media_ids uuid[] not null default '{}'
    check (cardinality(media_ids) <= 35 and array_position(media_ids, null) is null),
  options jsonb not null default '{}' check (jsonb_typeof(options) = 'object'),
  has_link boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint draft_variants_id_user_key unique (id, user_id),
  constraint draft_variants_draft_platform_key unique (draft_id, platform),
  constraint draft_variants_draft_fk foreign key (draft_id, user_id)
    references public.drafts (id, user_id) on delete cascade,
  constraint draft_variants_account_fk foreign key (connected_account_id, user_id)
    references public.connected_accounts (id, user_id) on delete set null (connected_account_id)
);
create index draft_variants_user_idx on public.draft_variants (user_id);
create index draft_variants_account_idx on public.draft_variants (connected_account_id);

-- 9. posts -------------------------------------------------------------------------------------
create table public.posts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id) on delete cascade,
  brand_id uuid not null,
  draft_id uuid not null,
  variant_id uuid not null,
  connected_account_id uuid not null,
  platform public.platform not null,
  scheduled_for timestamptz not null,
  status public.post_status not null default 'scheduled',
  approved_revision integer not null check (approved_revision >= 1),
  provider text not null check (provider ~ '^[a-z][a-z0-9_]{1,31}$'),
  provider_request_id text check (char_length(provider_request_id) between 1 and 255),
  provider_post_id text check (char_length(provider_post_id) between 1 and 255),
  post_url text check (char_length(post_url) <= 2048),
  error text check (char_length(error) <= 4000),
  attempts integer not null default 0 check (attempts >= 0),
  published_at timestamptz,
  canceled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint posts_id_user_key unique (id, user_id),
  constraint posts_brand_fk foreign key (brand_id, user_id)
    references public.brands (id, user_id) on delete cascade,
  constraint posts_draft_fk foreign key (draft_id, user_id)
    references public.drafts (id, user_id) on delete no action,
  constraint posts_variant_fk foreign key (variant_id, user_id)
    references public.draft_variants (id, user_id) on delete no action,
  constraint posts_account_fk foreign key (connected_account_id, user_id)
    references public.connected_accounts (id, user_id) on delete no action,
  constraint posts_published_at check (status <> 'published' or published_at is not null),
  constraint posts_canceled_at check (status <> 'canceled' or canceled_at is not null)
);
-- One approval -> one publication per variant.
create unique index posts_active_variant_uidx on public.posts (variant_id)
  where status in ('scheduled', 'publishing', 'published');
-- Platform caps: rolling windows per connected account over active posts.
create index posts_account_window_idx on public.posts (connected_account_id, (coalesce(published_at, scheduled_for)))
  where status in ('scheduled', 'publishing', 'published');
create index posts_account_idx on public.posts (connected_account_id);
create index posts_due_idx on public.posts (scheduled_for) where status = 'scheduled';
create index posts_user_idx on public.posts (user_id, scheduled_for);
create index posts_brand_idx on public.posts (brand_id, scheduled_for);
create index posts_draft_idx on public.posts (draft_id);
create index posts_variant_idx on public.posts (variant_id);
create index posts_provider_request_idx on public.posts (provider_request_id) where provider_request_id is not null;

-- 10. voice_profiles ---------------------------------------------------------------------------
create table public.voice_profiles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id) on delete cascade,
  brand_id uuid not null,
  version integer not null check (version >= 1),
  profile jsonb not null check (jsonb_typeof(profile) = 'object'),
  source text not null check (source in ('manual', 'imported', 'mixed')),
  created_at timestamptz not null default now(),
  constraint voice_profiles_brand_version_key unique (brand_id, version),
  constraint voice_profiles_brand_fk foreign key (brand_id, user_id)
    references public.brands (id, user_id) on delete cascade
);
create index voice_profiles_user_idx on public.voice_profiles (user_id);

-- 11. past_posts -------------------------------------------------------------------------------
create table public.past_posts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id) on delete cascade,
  brand_id uuid not null,
  platform public.platform not null,
  external_post_id text not null check (char_length(external_post_id) between 1 and 255),
  text text check (char_length(text) <= 70000),
  media_type text check (char_length(media_type) <= 50),
  posted_at timestamptz,
  permalink text check (char_length(permalink) <= 2048),
  metrics jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint past_posts_id_user_key unique (id, user_id),
  constraint past_posts_external_key unique (brand_id, platform, external_post_id),
  constraint past_posts_brand_fk foreign key (brand_id, user_id)
    references public.brands (id, user_id) on delete cascade,
  constraint past_posts_metrics check (
    jsonb_typeof(metrics) = 'object'
    and not jsonb_path_exists(metrics,
      '$.keyvalue() ? (!(@.key like_regex "^(views|likes|comments|shares|saves|followers|reach|impressions)$") || @.value.type() != "number" || @.value < 0)')
  )
);
create index past_posts_user_idx on public.past_posts (user_id);
create index past_posts_brand_idx on public.past_posts (brand_id, posted_at desc);

-- 12. analytics_snapshots ----------------------------------------------------------------------
create table public.analytics_snapshots (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id) on delete cascade,
  brand_id uuid not null,
  platform public.platform not null,
  post_id uuid,
  past_post_id uuid,
  connected_account_id uuid,
  scope text not null check (scope in ('post', 'account')),
  captured_at timestamptz not null default now(),
  metrics jsonb not null,
  created_at timestamptz not null default now(),
  constraint analytics_snapshots_brand_fk foreign key (brand_id, user_id)
    references public.brands (id, user_id) on delete cascade,
  constraint analytics_snapshots_post_fk foreign key (post_id, user_id)
    references public.posts (id, user_id) on delete cascade,
  constraint analytics_snapshots_past_post_fk foreign key (past_post_id, user_id)
    references public.past_posts (id, user_id) on delete cascade,
  constraint analytics_snapshots_account_fk foreign key (connected_account_id, user_id)
    references public.connected_accounts (id, user_id) on delete set null (connected_account_id),
  constraint analytics_snapshots_scope check (
    case scope
      when 'post' then num_nonnulls(post_id, past_post_id) = 1
      else post_id is null and past_post_id is null
    end
  ),
  constraint analytics_snapshots_metrics check (
    jsonb_typeof(metrics) = 'object'
    and not jsonb_path_exists(metrics,
      '$.keyvalue() ? (!(@.key like_regex "^(views|likes|comments|shares|saves|followers|reach|impressions)$") || @.value.type() != "number" || @.value < 0)')
  )
);
create index analytics_snapshots_user_idx on public.analytics_snapshots (user_id);
create index analytics_snapshots_brand_idx on public.analytics_snapshots (brand_id, captured_at desc);
create index analytics_snapshots_post_idx on public.analytics_snapshots (post_id, captured_at desc);
create index analytics_snapshots_past_post_idx on public.analytics_snapshots (past_post_id, captured_at desc);
create index analytics_snapshots_account_idx on public.analytics_snapshots (connected_account_id, captured_at desc);

-- 13. usage_ledger (append-only) ---------------------------------------------------------------
-- Signed meaning of amount (always > 0 except adjust): reserve and settle consume, release
-- returns a reservation; adjust consumes when positive and returns when negative.
-- used = reserve - release + settle + adjust. Balance = limit - used for the period.
create table public.usage_ledger (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id) on delete cascade,
  meter public.usage_meter not null,
  kind public.usage_kind not null,
  amount integer not null,
  period_start timestamptz not null,
  subject_type text check (char_length(subject_type) between 1 and 64),
  subject_id uuid,
  idempotency_key text not null unique check (char_length(idempotency_key) between 1 and 255),
  note text check (char_length(note) <= 1000),
  created_at timestamptz not null default now(),
  constraint usage_ledger_amount check (case when kind = 'adjust' then amount <> 0 else amount > 0 end),
  constraint usage_ledger_subject check ((subject_type is null) = (subject_id is null))
);
create index usage_ledger_period_idx on public.usage_ledger (user_id, meter, period_start);
create index usage_ledger_subject_idx on public.usage_ledger (user_id, subject_id);

-- 14. jobs -------------------------------------------------------------------------------------
create table public.jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.users (id) on delete cascade,
  type text not null check (type ~ '^[a-z][a-z0-9_]{0,63}$'),
  payload jsonb not null default '{}' check (jsonb_typeof(payload) = 'object'),
  status public.job_status not null default 'queued',
  run_at timestamptz not null default now(),
  attempts integer not null default 0 check (attempts >= 0),
  max_attempts integer not null default 5 check (max_attempts between 1 and 100),
  locked_by text check (char_length(locked_by) between 1 and 255),
  locked_until timestamptz,
  last_error text check (char_length(last_error) <= 4000),
  idempotency_key text unique check (char_length(idempotency_key) between 1 and 255),
  result jsonb,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint jobs_running_lock check (status <> 'running' or (locked_by is not null and locked_until is not null)),
  constraint jobs_finished check ((status in ('succeeded', 'dead')) = (finished_at is not null))
);
create index jobs_status_run_at_idx on public.jobs (status, run_at);
create index jobs_claim_idx on public.jobs (type, run_at) where status in ('queued', 'failed');
create index jobs_stale_idx on public.jobs (locked_until) where status = 'running';
create index jobs_user_idx on public.jobs (user_id);

-- 15. oauth_clients ----------------------------------------------------------------------------
create table public.oauth_clients (
  client_id text primary key check (char_length(client_id) between 8 and 255),
  client_name text check (char_length(client_name) <= 255),
  redirect_uris text[] not null
    check (cardinality(redirect_uris) between 1 and 20 and array_position(redirect_uris, null) is null),
  token_endpoint_auth_method text not null default 'none' check (token_endpoint_auth_method = 'none'),
  created_at timestamptz not null default now(),
  last_used_at timestamptz
);

-- 16. oauth_codes ------------------------------------------------------------------------------
create table public.oauth_codes (
  code_hash text primary key check (code_hash ~ '^[0-9a-f]{64}$'),
  client_id text not null references public.oauth_clients (client_id) on delete cascade,
  user_id uuid not null references public.users (id) on delete cascade,
  redirect_uri text not null check (char_length(redirect_uri) between 1 and 2048),
  -- PKCE S256 only: BASE64URL(SHA256(verifier)) is 43 characters.
  code_challenge text not null check (code_challenge ~ '^[A-Za-z0-9_-]{43,128}$'),
  scope text not null check (char_length(scope) <= 255),
  resource text check (char_length(resource) <= 2048),
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);
create index oauth_codes_client_idx on public.oauth_codes (client_id);
create index oauth_codes_user_idx on public.oauth_codes (user_id);
create index oauth_codes_expires_idx on public.oauth_codes (expires_at);

-- 17. oauth_tokens -----------------------------------------------------------------------------
-- Only SHA-256 hashes of the random tokens are stored. A refresh token is rotated by revoking
-- it; presenting a revoked refresh token again is reuse and revokes the whole family.
create table public.oauth_tokens (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  kind text not null check (kind in ('access', 'refresh')),
  family_id uuid not null,
  client_id text not null references public.oauth_clients (client_id) on delete cascade,
  user_id uuid not null references public.users (id) on delete cascade,
  scope text not null check (char_length(scope) <= 255),
  resource text check (char_length(resource) <= 2048),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  last_used_at timestamptz,
  created_at timestamptz not null default now()
);
create index oauth_tokens_family_idx on public.oauth_tokens (family_id);
create index oauth_tokens_client_idx on public.oauth_tokens (client_id);
create index oauth_tokens_user_idx on public.oauth_tokens (user_id);
create index oauth_tokens_expires_idx on public.oauth_tokens (expires_at);

-- 18. approval_nonces --------------------------------------------------------------------------
create table public.approval_nonces (
  nonce_hash text primary key check (nonce_hash ~ '^[0-9a-f]{64}$'),
  user_id uuid not null references public.users (id) on delete cascade,
  draft_id uuid not null,
  revision integer not null check (revision >= 1),
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now(),
  constraint approval_nonces_draft_fk foreign key (draft_id, user_id)
    references public.drafts (id, user_id) on delete cascade
);
create index approval_nonces_user_idx on public.approval_nonces (user_id);
create index approval_nonces_draft_idx on public.approval_nonces (draft_id);
create index approval_nonces_expires_idx on public.approval_nonces (expires_at);

-- 19. stripe_events ----------------------------------------------------------------------------
create table public.stripe_events (
  id text primary key check (id ~ '^evt_[A-Za-z0-9_]{1,250}$'),
  type text not null check (char_length(type) between 1 and 255),
  processed_at timestamptz,
  created_at timestamptz not null default now()
);

-- 20. audit_log (append-only) ------------------------------------------------------------------
create table public.audit_log (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.users (id) on delete cascade,
  actor public.actor not null,
  action text not null check (action ~ '^[a-z][a-z0-9_.:-]{0,99}$'),
  subject_type text check (char_length(subject_type) between 1 and 64),
  subject_id text check (char_length(subject_id) between 1 and 255),
  meta jsonb not null default '{}',
  created_at timestamptz not null default now(),
  -- Never secrets: keys that look like credentials (same pattern as the redacting logger) are refused.
  constraint audit_log_meta check (
    jsonb_typeof(meta) = 'object'
    and not jsonb_path_exists(meta,
      'lax $.** ? (@.type() == "object").keyvalue() ? (@.key like_regex "token|secret|password|passwd|authorization|api[-_]?key|cookie|code_verifier|credential|private[-_]?key|signature|session[-_]?secret" flag "i")')
  )
);
create index audit_log_user_idx on public.audit_log (user_id, created_at desc);
create index audit_log_subject_idx on public.audit_log (subject_type, subject_id);

-- ---------------------------------------------------------------------------------------------
-- 4. updated_at and append-only triggers
-- ---------------------------------------------------------------------------------------------

create trigger users_updated_at before update on public.users
  for each row execute function private.set_updated_at();
create trigger brands_updated_at before update on public.brands
  for each row execute function private.set_updated_at();
create trigger connected_accounts_updated_at before update on public.connected_accounts
  for each row execute function private.set_updated_at();
create trigger media_assets_updated_at before update on public.media_assets
  for each row execute function private.set_updated_at();
create trigger transcripts_updated_at before update on public.transcripts
  for each row execute function private.set_updated_at();
create trigger clips_updated_at before update on public.clips
  for each row execute function private.set_updated_at();
create trigger drafts_updated_at before update on public.drafts
  for each row execute function private.set_updated_at();
create trigger draft_variants_updated_at before update on public.draft_variants
  for each row execute function private.set_updated_at();
create trigger posts_updated_at before update on public.posts
  for each row execute function private.set_updated_at();
create trigger past_posts_updated_at before update on public.past_posts
  for each row execute function private.set_updated_at();
create trigger jobs_updated_at before update on public.jobs
  for each row execute function private.set_updated_at();

create trigger usage_ledger_no_update before update on public.usage_ledger
  for each row execute function private.forbid_update();
create trigger usage_ledger_no_delete before delete on public.usage_ledger
  for each row execute function private.forbid_direct_delete();
create trigger audit_log_no_update before update on public.audit_log
  for each row execute function private.forbid_update();
create trigger audit_log_no_delete before delete on public.audit_log
  for each row execute function private.forbid_direct_delete();

-- ---------------------------------------------------------------------------------------------
-- 5. Domain triggers: clips, drafts, variants, posts
-- ---------------------------------------------------------------------------------------------

-- Clips may only be cut from the user's own source videos (uploads or drive links with rights).
create function private.clips_check_source() returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_src public.media_assets%rowtype;
begin
  if tg_op = 'UPDATE' and new.source_media_id = old.source_media_id
     and new.start_ms = old.start_ms and new.end_ms = old.end_ms then
    return new;
  end if;
  select * into v_src from public.media_assets m
   where m.id = new.source_media_id and m.user_id = new.user_id;
  if not found then
    return new; -- the foreign key reports the missing source
  end if;
  if v_src.kind <> 'video' or v_src.origin not in ('upload', 'drive_link') then
    raise exception 'clips need an uploaded or drive-linked source video' using errcode = 'P0A04';
  end if;
  if v_src.rights_attested_at is null then
    raise exception 'the source video has no rights attestation' using errcode = 'P0A04';
  end if;
  if v_src.duration_ms is not null and new.end_ms > v_src.duration_ms then
    raise exception 'clip end (% ms) is past the end of the source (% ms)', new.end_ms, v_src.duration_ms
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger clips_check_source before insert or update on public.clips
  for each row execute function private.clips_check_source();

-- Deterministic hash of a draft's publishable content: its brand plus every variant.
create function private.draft_content_hash(p_draft_id uuid, p_brand_id uuid) returns text
language sql
stable
set search_path = ''
as $$
  select encode(sha256(convert_to(jsonb_build_object(
    'brand_id', p_brand_id,
    'variants', coalesce((
      select jsonb_agg(jsonb_build_object(
          'platform', v.platform,
          'connected_account_id', v.connected_account_id,
          'text', v.text,
          'title', v.title,
          'media_ids', to_jsonb(v.media_ids),
          'options', v.options,
          'has_link', v.has_link
        ) order by v.platform)
        from public.draft_variants v
       where v.draft_id = p_draft_id
    ), '[]'::jsonb)
  )::text, 'UTF8')), 'hex')
$$;

-- True the first time a draft's content is touched in the current transaction (a transaction-local
-- setting remembers which drafts were touched). Revisions therefore bump once per transaction, and
-- not at all in the transaction that created the draft.
create function private.first_touch_in_tx(p_draft_id uuid) returns boolean
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_seen text := coalesce(current_setting('app.touched_drafts', true), '');
  v_id text := p_draft_id::text;
begin
  if position(v_id in v_seen) > 0 then
    return false;
  end if;
  perform set_config('app.touched_drafts', v_seen || v_id || ',', true);
  return true;
end;
$$;

-- Content changed: bump the revision (once per transaction), recompute the hash and drop any
-- approval. Dropping the approval cancels scheduled posts (drafts_after_update).
create function private.touch_draft(p_draft_id uuid) returns void
language plpgsql
set search_path = ''
as $$
declare
  v_first boolean := private.first_touch_in_tx(p_draft_id);
begin
  update public.drafts d
     set revision = case when v_first then d.revision + 1 else d.revision end,
         content_hash = private.draft_content_hash(d.id, d.brand_id),
         status = case when d.status = 'approved' then 'draft'::public.draft_status else d.status end
   where d.id = p_draft_id;
end;
$$;

create function private.drafts_before_insert() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status <> 'draft' then
    raise exception 'drafts are created with status draft (approval is a separate step)' using errcode = 'P0A06';
  end if;
  new.revision := 1;
  new.approved_revision := null;
  new.approved_hash := null;
  new.approved_at := null;
  new.approved_via := null;
  new.content_hash := private.draft_content_hash(new.id, new.brand_id);
  perform private.first_touch_in_tx(new.id);
  return new;
end;
$$;

create trigger drafts_before_insert before insert on public.drafts
  for each row execute function private.drafts_before_insert();

create function private.drafts_before_update() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.id <> old.id or new.user_id <> old.user_id or new.created_via <> old.created_via
     or new.created_at <> old.created_at then
    raise exception 'drafts.id, user_id, created_via and created_at cannot change' using errcode = 'P0A02';
  end if;
  -- Only the content triggers (nested, depth > 1) may move revision and content_hash.
  if pg_trigger_depth() = 1 and (new.revision <> old.revision or new.content_hash <> old.content_hash) then
    raise exception 'drafts.revision and content_hash are maintained by triggers' using errcode = 'P0A02';
  end if;

  -- Draft-level content edit: moving the draft to another brand.
  if new.brand_id <> old.brand_id then
    if exists (
      select 1 from public.draft_variants v
        join public.connected_accounts a on a.id = v.connected_account_id
       where v.draft_id = new.id and a.brand_id <> new.brand_id
    ) then
      raise exception 'a variant targets an account of another brand' using errcode = 'P0A04';
    end if;
    if private.first_touch_in_tx(new.id) then
      new.revision := old.revision + 1;
    end if;
    new.content_hash := private.draft_content_hash(new.id, new.brand_id);
    if new.status = 'approved' then
      new.status := 'draft';
    end if;
  end if;

  if new.status = 'approved' then
    if old.status <> 'approved'
       or new.approved_revision is distinct from old.approved_revision
       or new.approved_hash is distinct from old.approved_hash then
      if new.approved_revision is distinct from new.revision or new.approved_hash is distinct from new.content_hash then
        raise exception 'approval must name the current revision (%) and content hash', new.revision
          using errcode = 'P0A06';
      end if;
      if not exists (select 1 from public.draft_variants v where v.draft_id = new.id) then
        raise exception 'a draft without variants cannot be approved' using errcode = 'P0A06';
      end if;
      if new.approved_via is null then
        raise exception 'approved_via is required' using errcode = 'P0A06';
      end if;
      new.approved_at := coalesce(new.approved_at, now());
    end if;
  else
    new.approved_revision := null;
    new.approved_hash := null;
    new.approved_at := null;
    new.approved_via := null;
  end if;
  return new;
end;
$$;

create trigger drafts_before_update before update on public.drafts
  for each row execute function private.drafts_before_update();

-- Leaving 'approved' (edit, reject, archive) cancels posts that have not started publishing.
create function private.drafts_after_update() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  update public.posts p
     set status = 'canceled',
         canceled_at = now(),
         error = case
           when new.revision <> old.revision or new.content_hash <> old.content_hash
             then 'The draft changed after approval. Approve it again and reschedule.'
           else 'The draft is no longer approved.'
         end
   where p.draft_id = new.id and p.status = 'scheduled';
  return null;
end;
$$;

create trigger drafts_after_update after update on public.drafts
  for each row when (old.status = 'approved' and new.status <> 'approved')
  execute function private.drafts_after_update();

create function private.draft_variants_before_write() returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_brand uuid;
  v_account record;
begin
  if tg_op = 'UPDATE' and (new.draft_id <> old.draft_id or new.user_id <> old.user_id or new.created_at <> old.created_at) then
    raise exception 'draft_variants.draft_id, user_id and created_at cannot change' using errcode = 'P0A02';
  end if;

  if new.connected_account_id is not null
     and (tg_op = 'INSERT' or new.connected_account_id is distinct from old.connected_account_id
          or new.platform <> old.platform) then
    select d.brand_id into v_brand from public.drafts d where d.id = new.draft_id and d.user_id = new.user_id;
    select a.brand_id, a.platform into v_account
      from public.connected_accounts a
     where a.id = new.connected_account_id and a.user_id = new.user_id;
    if found and (v_account.brand_id <> v_brand or v_account.platform <> new.platform) then
      raise exception 'the connected account belongs to another brand or platform' using errcode = 'P0A04';
    end if;
  end if;

  -- (more than 35 items is left to the CHECK constraint, which reports it by name)
  if cardinality(new.media_ids) between 1 and 35
     and (tg_op = 'INSERT' or new.media_ids is distinct from old.media_ids) then
    if (select count(distinct t.m) from unnest(new.media_ids) as t(m)) <> cardinality(new.media_ids) then
      raise exception 'each media item may appear once per variant' using errcode = '23514';
    end if;
    if exists (
      select 1 from unnest(new.media_ids) as m(id)
       where not exists (
         select 1 from public.media_assets a where a.id = m.id and a.user_id = new.user_id
       )
    ) then
      raise exception 'a media item does not exist or belongs to another user' using errcode = 'P0A04';
    end if;
  end if;
  return new;
end;
$$;

create trigger draft_variants_before_write before insert or update on public.draft_variants
  for each row execute function private.draft_variants_before_write();

create function private.draft_variants_after_change() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    perform private.touch_draft(old.draft_id);
  else
    perform private.touch_draft(new.draft_id);
  end if;
  return null;
end;
$$;

create trigger draft_variants_after_insert after insert on public.draft_variants
  for each row execute function private.draft_variants_after_change();
create trigger draft_variants_after_update after update on public.draft_variants
  for each row
  when (
    (old.platform, old.connected_account_id, old.text, old.title, old.media_ids, old.options, old.has_link)
    is distinct from
    (new.platform, new.connected_account_id, new.text, new.title, new.media_ids, new.options, new.has_link)
  )
  execute function private.draft_variants_after_change();
create trigger draft_variants_after_delete after delete on public.draft_variants
  for each row execute function private.draft_variants_after_change();

-- A post can only be created for an approved draft at its current revision, for one of the
-- draft's variants, on an active account of the same brand and platform.
create function private.posts_before_insert() returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_draft public.drafts%rowtype;
  v_variant public.draft_variants%rowtype;
  v_account public.connected_accounts%rowtype;
  v_brand_status public.brand_status;
begin
  -- FOR SHARE: a concurrent edit of the draft waits until this insert commits; the edit then
  -- cancels the post (drafts_after_update).
  select * into v_draft from public.drafts d
   where d.id = new.draft_id and d.user_id = new.user_id
   for share;
  if not found then
    raise exception 'draft % not found', new.draft_id using errcode = 'P0A04';
  end if;
  if v_draft.status <> 'approved'
     or v_draft.approved_revision is distinct from v_draft.revision
     or new.approved_revision is distinct from v_draft.revision then
    raise exception 'draft % is not approved at revision % (status %, revision %, approved revision %)',
      new.draft_id, new.approved_revision, v_draft.status, v_draft.revision, v_draft.approved_revision
      using errcode = 'P0A01';
  end if;
  if new.brand_id <> v_draft.brand_id then
    raise exception 'post brand does not match the draft brand' using errcode = 'P0A04';
  end if;

  select * into v_variant from public.draft_variants v
   where v.id = new.variant_id and v.user_id = new.user_id;
  if not found or v_variant.draft_id <> new.draft_id then
    raise exception 'variant % does not belong to draft %', new.variant_id, new.draft_id using errcode = 'P0A04';
  end if;
  if v_variant.platform <> new.platform then
    raise exception 'post platform does not match the variant platform' using errcode = 'P0A04';
  end if;
  if v_variant.connected_account_id is not null and v_variant.connected_account_id <> new.connected_account_id then
    raise exception 'post account does not match the variant account' using errcode = 'P0A04';
  end if;

  select * into v_account from public.connected_accounts a
   where a.id = new.connected_account_id and a.user_id = new.user_id;
  if not found or v_account.brand_id <> new.brand_id or v_account.platform <> new.platform then
    raise exception 'the connected account belongs to another brand or platform' using errcode = 'P0A04';
  end if;
  if v_account.status <> 'active' then
    raise exception 'the connected account is %', v_account.status using errcode = 'P0A06';
  end if;

  select b.status into v_brand_status from public.brands b where b.id = new.brand_id;
  if v_brand_status <> 'active' then
    raise exception 'the brand is %', v_brand_status using errcode = 'P0A06';
  end if;

  if new.status <> 'scheduled' then
    raise exception 'posts are created with status scheduled' using errcode = 'P0A03';
  end if;
  new.attempts := 0;
  new.published_at := null;
  new.canceled_at := null;
  return new;
end;
$$;

create trigger posts_before_insert before insert on public.posts
  for each row execute function private.posts_before_insert();

-- Content is immutable after insert. Mutable: status, provider fields (provider,
-- provider_request_id, provider_post_id, post_url), scheduled_for, error, attempts,
-- published_at, canceled_at (and updated_at).
create function private.posts_before_update() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if (new.id, new.user_id, new.brand_id, new.draft_id, new.variant_id, new.connected_account_id,
      new.platform, new.approved_revision, new.created_at)
     is distinct from
     (old.id, old.user_id, old.brand_id, old.draft_id, old.variant_id, old.connected_account_id,
      old.platform, old.approved_revision, old.created_at) then
    raise exception 'post content is immutable; only status, provider fields, scheduled_for, error, attempts, published_at and canceled_at may change'
      using errcode = 'P0A02';
  end if;

  if new.status <> old.status then
    if not (
      (old.status = 'scheduled' and new.status in ('publishing', 'failed', 'canceled'))
      or (old.status = 'publishing' and new.status in ('published', 'failed', 'scheduled'))
      -- failed -> published: the provider confirmed late (webhook / status check) what we gave up on
      or (old.status = 'failed' and new.status in ('scheduled', 'canceled', 'published'))
    ) then
      raise exception 'post status cannot go from % to %', old.status, new.status using errcode = 'P0A03';
    end if;
    -- Nothing publishes without a current approval: a post may only (re)enter scheduled or
    -- publishing while its draft is approved at the post's revision.
    if new.status in ('publishing', 'scheduled') then
      if not exists (
        select 1 from public.drafts d
         where d.id = new.draft_id and d.status = 'approved'
           and d.revision = new.approved_revision and d.approved_revision = new.approved_revision
      ) then
        raise exception 'draft % is no longer approved at revision %', new.draft_id, new.approved_revision
          using errcode = 'P0A01';
      end if;
    end if;
    if new.status = 'published' and new.published_at is null then
      new.published_at := now();
    end if;
    if new.status = 'canceled' and new.canceled_at is null then
      new.canceled_at := now();
    end if;
  elsif old.status in ('published', 'canceled') and new.scheduled_for <> old.scheduled_for then
    raise exception 'a % post cannot be rescheduled', old.status using errcode = 'P0A03';
  end if;
  return new;
end;
$$;

create trigger posts_before_update before update on public.posts
  for each row execute function private.posts_before_update();

-- ---------------------------------------------------------------------------------------------
-- 6. Row level security and grants
-- ---------------------------------------------------------------------------------------------
-- The server connects with a privileged role (table owner) and is not subject to RLS. The browser
-- (Supabase role authenticated) can only read its own rows from the tables below; anon gets
-- nothing. Tables without a policy are deny-all for every non-owner role.

alter table public.users enable row level security;
alter table public.brands enable row level security;
alter table public.connected_accounts enable row level security;
alter table public.media_assets enable row level security;
alter table public.transcripts enable row level security;
alter table public.clips enable row level security;
alter table public.drafts enable row level security;
alter table public.draft_variants enable row level security;
alter table public.posts enable row level security;
alter table public.voice_profiles enable row level security;
alter table public.past_posts enable row level security;
alter table public.analytics_snapshots enable row level security;
alter table public.usage_ledger enable row level security;
alter table public.jobs enable row level security;
alter table public.oauth_clients enable row level security;
alter table public.oauth_codes enable row level security;
alter table public.oauth_tokens enable row level security;
alter table public.approval_nonces enable row level security;
alter table public.stripe_events enable row level security;
alter table public.audit_log enable row level security;

-- Supabase grants everything on new public tables to anon and authenticated by default.
revoke all on all tables in schema public from anon, authenticated;
revoke all on all functions in schema private from public, anon, authenticated;

grant select on
  public.users, public.brands, public.media_assets, public.transcripts, public.clips,
  public.drafts, public.draft_variants, public.posts, public.voice_profiles, public.past_posts,
  public.analytics_snapshots
  to authenticated;

-- Every column except encrypted_credentials.
grant select (
  id, user_id, brand_id, platform, provider, external_account_id, handle, display_name, status,
  scopes, connected_at, last_synced_at, created_at, updated_at
) on public.connected_accounts to authenticated;

create policy users_owner_select on public.users
  for select to authenticated using (id = (select auth.uid()));
create policy brands_owner_select on public.brands
  for select to authenticated using (user_id = (select auth.uid()));
create policy connected_accounts_owner_select on public.connected_accounts
  for select to authenticated using (user_id = (select auth.uid()));
create policy media_assets_owner_select on public.media_assets
  for select to authenticated using (user_id = (select auth.uid()));
create policy transcripts_owner_select on public.transcripts
  for select to authenticated using (user_id = (select auth.uid()));
create policy clips_owner_select on public.clips
  for select to authenticated using (user_id = (select auth.uid()));
create policy drafts_owner_select on public.drafts
  for select to authenticated using (user_id = (select auth.uid()));
create policy draft_variants_owner_select on public.draft_variants
  for select to authenticated using (user_id = (select auth.uid()));
create policy posts_owner_select on public.posts
  for select to authenticated using (user_id = (select auth.uid()));
create policy voice_profiles_owner_select on public.voice_profiles
  for select to authenticated using (user_id = (select auth.uid()));
create policy past_posts_owner_select on public.past_posts
  for select to authenticated using (user_id = (select auth.uid()));
create policy analytics_snapshots_owner_select on public.analytics_snapshots
  for select to authenticated using (user_id = (select auth.uid()));
-- No policies (deny): usage_ledger, jobs, oauth_clients, oauth_codes, oauth_tokens,
-- approval_nonces, stripe_events, audit_log.
