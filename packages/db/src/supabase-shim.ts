import type { Db } from './types'

/**
 * Stand-ins for what Supabase provides, for PGlite (tests and local dev without Supabase):
 * roles anon / authenticated / service_role, schema auth with auth.users and auth.uid(), and
 * Supabase's default privileges (everything on new public tables to anon and authenticated), so
 * tests prove the migration revokes them. Never run this against a real Supabase database.
 */
export const SUPABASE_SHIM_SQL = `
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
end
$$;

create schema if not exists auth;

create table if not exists auth.users (
  id uuid primary key,
  email text
);

-- Same definition as Supabase's auth.uid().
create or replace function auth.uid() returns uuid
language sql
stable
as $fn$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$fn$;

grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;
grant usage on schema public to anon, authenticated, service_role;

alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
`

export async function installSupabaseShim(db: Db): Promise<void> {
  await db.exec(SUPABASE_SHIM_SQL)
}
