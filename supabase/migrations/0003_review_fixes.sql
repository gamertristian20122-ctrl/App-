-- 0003_review_fixes.sql: columns for the review fixes (docs/REVIEW.md).
--
-- posts.canceled_by: who canceled the post. A cancel by the person in the web app ('web')
--   withdraws the approval for that variant: the AI cannot schedule the same approval again
--   (services.posts.schedule refuses unless the person schedules it from the web app or approves
--   the draft again). System cancels (account disconnected, brand archived, draft edited) leave
--   it null.
-- oauth_codes.family_id: the token family an authorization code was redeemed for, so a second
--   redemption of the same code revokes those tokens (OAuth 2.1 §4.1.3).

alter table public.posts
  add column canceled_by public.actor;

alter table public.oauth_codes
  add column family_id uuid;

-- New tables must repeat what 0001 did for every table (Supabase grants new tables to anon and
-- authenticated by default). This migration adds no table; the columns inherit their tables'
-- privileges and RLS.
