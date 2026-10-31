-- 0004_auto_post.sql: the brand's Auto-post switch, rule-based approval, AI uploads and URL imports
-- (docs/plans/02-auto-post.md).
--
-- The migrator applies each file in its own transaction. A value added with ALTER TYPE ... ADD VALUE
-- cannot be USED in the transaction that adds it ("unsafe use of new value"), so nothing below
-- names 'auto_post' or 'url_import' as an enum literal: constraints list the older values instead,
-- trigger conditions compare ::text, and plpgsql bodies are only resolved when they first run.
--
-- actor 'auto_post'       drafts.approved_via / audit_log.actor when the brand's Auto-post rule (not a
--                         person) approved a draft. Only @app/services sets it, and only while the
--                         brand's switch is on (enforced again by drafts_auto_post_guard below).
-- media_origin 'url_import' a finished video or image fetched from an https link an AI sent
--                         (post media, never a clip source); the link lives in source_url until it
--                         is fetched, then it is nulled (like drive links).

alter type public.actor add value if not exists 'auto_post';
alter type public.media_origin add value if not exists 'url_import';

-- 1. brands: the Auto-post switch (changed only by the person, in the web app) --------------------
alter table public.brands
  add column auto_post_enabled boolean not null default false,
  -- empty = every connected platform
  add column auto_post_platforms public.platform[] not null default '{}'
    constraint brands_auto_post_platforms check (cardinality(auto_post_platforms) <= 9),
  -- videos approved by the rule per brand in any rolling 24 h
  add column auto_post_daily_max integer not null default 3
    constraint brands_auto_post_daily_max check (auto_post_daily_max between 1 and 25),
  -- TikTok requires the person to choose who can see a post; the Auto-post form asks once
  add column auto_post_tiktok_privacy text
    constraint brands_auto_post_tiktok_privacy check (auto_post_tiktok_privacy in (
      'PUBLIC_TO_EVERYONE', 'MUTUAL_FOLLOW_FRIENDS', 'FOLLOWER_OF_CREATOR', 'SELF_ONLY'
    )),
  add column auto_post_updated_at timestamptz;

-- 2. drafts: what the rule was asked and what it decided (it decides once per draft) -------------
alter table public.drafts
  -- 'now' | 'best' | an ISO time; set when an AI or worker asked for the draft to be auto-posted
  add column auto_post_when text
    constraint drafts_auto_post_when check (char_length(auto_post_when) between 3 and 40),
  add column auto_post_requested_at timestamptz,
  add column auto_post_decided_at timestamptz,
  add column auto_post_outcome text
    constraint drafts_auto_post_outcome check (auto_post_outcome in (
      'posted', 'switch_off', 'platform_not_allowed', 'daily_max', 'not_ready', 'cap_reached', 'skipped'
    )),
  add column auto_post_note text
    constraint drafts_auto_post_note check (char_length(auto_post_note) <= 1000),
  add constraint drafts_auto_post_decision check (
    (auto_post_decided_at is null) = (auto_post_outcome is null)
    and (auto_post_decided_at is null or auto_post_requested_at is not null)
    and ((auto_post_requested_at is null) = (auto_post_when is null))
  );
-- daily max: rule approvals per brand in the last 24 h
create index drafts_auto_posted_idx on public.drafts (brand_id, auto_post_decided_at)
  where auto_post_outcome = 'posted';
-- media ready → drafts still waiting for the rule
create index drafts_auto_post_waiting_idx on public.drafts (user_id)
  where auto_post_requested_at is not null and auto_post_decided_at is null;

-- Defense in depth: only a draft an AI or the worker made, of a brand whose switch is on, can be
-- approved by the rule. (The service checks this first; this catches a bug that skipped it.)
create function private.drafts_auto_post_guard() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if not exists (
    select 1 from public.brands b
     where b.id = new.brand_id and b.user_id = new.user_id and b.auto_post_enabled and b.status = 'active'
  ) then
    raise exception 'Auto-post is off for this brand' using errcode = 'P0A06';
  end if;
  if new.created_via::text not in ('mcp', 'worker') then
    raise exception 'the Auto-post rule only approves drafts made by an AI or the worker' using errcode = 'P0A06';
  end if;
  return new;
end;
$$;

create trigger drafts_auto_post_guard before update on public.drafts
  for each row
  when (new.approved_via::text = 'auto_post' and new.approved_via is distinct from old.approved_via)
  execute function private.drafts_auto_post_guard();

-- 3. posts: who approved what was scheduled (copied from the draft at insert, then immutable) ------
alter table public.posts
  add column approved_via public.actor;

create function private.posts_approved_via() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    select d.approved_via into new.approved_via
      from public.drafts d
     where d.id = new.draft_id and d.user_id = new.user_id;
  else
    new.approved_via := old.approved_via;
  end if;
  return new;
end;
$$;

-- named to run after posts_before_insert / posts_before_update (triggers fire in name order)
create trigger posts_set_approved_via before insert or update on public.posts
  for each row execute function private.posts_approved_via();

-- 4. media_assets: URL imports keep their host (and the link until fetched) ----------------------
-- Same rules as before for the old origins; 'url_import' (any origin not listed) needs a host.
alter table public.media_assets drop constraint media_assets_drive_host;
alter table public.media_assets add constraint media_assets_drive_host check (
  (origin <> 'drive_link' or source_host in (
    'drive.google.com', 'docs.google.com', 'dropbox.com', 'www.dropbox.com',
    'dl.dropboxusercontent.com', 'onedrive.live.com', '1drv.ms'
  ))
  and ((origin in ('upload', 'clip', 'render')) = (source_host is null))
);
alter table public.media_assets add constraint media_assets_source_host_length check (char_length(source_host) between 1 and 253);
alter table public.media_assets drop constraint media_assets_source_url_origin;
alter table public.media_assets add constraint media_assets_source_url_origin check (
  source_url is null or origin not in ('upload', 'clip', 'render')
);

-- New tables must repeat what 0001 did for every table (Supabase grants new tables to anon and
-- authenticated by default). This migration adds no table; the new columns inherit their tables'
-- privileges and RLS (brands: owner-only SELECT for authenticated, as before).
