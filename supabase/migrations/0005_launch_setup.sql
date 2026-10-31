-- 0005: launch setup (docs/LAUNCH-ON-PHONE.md, the owner's /setup page).
--
-- 1. app_settings: a few deployment-wide values the owner's /setup actions create, for example the
--    Stripe webhook signing secret (Stripe shows it only once, when the endpoint is created). Secret
--    values are stored encrypted by the app (AES-256-GCM with TOKEN_ENCRYPTION_KEYS; `encrypted`
--    says so). Server-only: RLS on, no policies, no grants to anon / authenticated.
-- 2. worker_heartbeats: each Railway worker upserts its row every minute, so /setup can say
--    "posting worker last seen 20 seconds ago" or "not running". Server-only as well.

-- 1. app_settings -------------------------------------------------------------------------------
create table public.app_settings (
  key text primary key check (key ~ '^[a-z][a-z0-9_.:-]{0,99}$'),
  value text not null check (char_length(value) between 1 and 8192),
  encrypted boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger app_settings_updated_at before update on public.app_settings
  for each row execute function private.set_updated_at();

-- 2. worker_heartbeats ----------------------------------------------------------------------------
create table public.worker_heartbeats (
  worker_id text primary key check (char_length(worker_id) between 1 and 200),
  -- the worker groups this process runs (WORKER_TYPES)
  types text[] not null check (
    cardinality(types) between 1 and 2 and types <@ array['posting', 'media']::text[]
  ),
  last_seen_at timestamptz not null default now(),
  version text check (char_length(version) between 1 and 100),
  started_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create index worker_heartbeats_last_seen_idx on public.worker_heartbeats (last_seen_at desc);

-- Row level security and grants: server-only, like stripe_events and audit_log (0001 section 6).
-- Supabase grants new public tables to anon and authenticated by default; take that back.
alter table public.app_settings enable row level security;
alter table public.worker_heartbeats enable row level security;
revoke all on public.app_settings from anon, authenticated;
revoke all on public.worker_heartbeats from anon, authenticated;
-- No policies (deny): app_settings, worker_heartbeats.
