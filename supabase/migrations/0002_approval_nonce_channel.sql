-- 0002_approval_nonce_channel.sql: bind each approval nonce to the channel it was issued for.
--
-- 'card': embedded only where the AI never sees it: the MCP approval card's UI-only _meta and the
--         buttons of the signed-in web approval queue. Accepted from the card's app-only MCP tools
--         (approval_decide / approval_edit_variant) and from the web app.
-- 'link': the one-click web link (APP_URL/approve/<nonce>) that approve_draft may return as plain
--         text for clients without MCP Apps. The AI can read that text, so a 'link' nonce is only
--         accepted by the signed-in web app (via = 'web'), never through MCP tools.
--
-- Existing rows default to 'card' (the only kind issued before this migration).

alter table public.approval_nonces
  add column channel text not null default 'card'
  constraint approval_nonces_channel check (channel in ('card', 'link'));

-- New tables must repeat what 0001 did for every table (Supabase grants new tables to anon and
-- authenticated by default). This migration adds no table; the column inherits the table's
-- privileges (none for anon/authenticated) and its RLS (enabled, no policy).
