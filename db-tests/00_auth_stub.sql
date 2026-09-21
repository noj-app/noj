-- Minimal stand-in for Supabase's built-in `auth` schema, just enough to
-- test RLS/RPC logic locally against a plain Postgres 16 instance.
-- auth.uid() in real Supabase reads a JWT claim exposed as the Postgres
-- session setting 'request.jwt.claims'; here we emulate the same contract
-- with a settable session variable so tests can impersonate any user.

create schema if not exists auth;

create table if not exists auth.users (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now()
);

create or replace function auth.uid() returns uuid
language sql stable
as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;

-- real Supabase projects already grant anon/authenticated USAGE on schema
-- `auth` (and EXECUTE on auth.uid()) as part of the platform's own
-- bootstrap — not something any project migration file grants itself. This
-- stub replicates that pre-existing platform grant so SECURITY INVOKER
-- functions that call auth.uid() (e.g. redeem_reward) behave identically
-- under local testing to how they behave on real Supabase.
grant usage on schema auth to anon, authenticated;
grant execute on function auth.uid() to anon, authenticated;

create schema if not exists test;

-- test helper: impersonate a given auth.users id for the rest of the session
create or replace function test.set_auth_uid(p_uid uuid) returns void
language sql
as $$
  select set_config('request.jwt.claim.sub', p_uid::text, false);
$$;

grant usage on schema test to anon, authenticated;
grant execute on function test.set_auth_uid(uuid) to anon, authenticated;
