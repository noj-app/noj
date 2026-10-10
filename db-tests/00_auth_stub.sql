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

-- real Supabase's auth.users carries these natively; stubbed here (additive,
-- nullable, no existing row affected) only once a migration under test
-- actually reads them (supabase-migration-phone-otp-foundation.sql) — before
-- that, no test needed them.
alter table auth.users add column if not exists phone text;
alter table auth.users add column if not exists phone_confirmed_at timestamptz;

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

-- service_role: the role Supabase Edge Functions use via the service-role
-- key (e.g. pos-intake/index.ts). Not pre-created by the one-time cluster
-- setup in db-tests/README.md (only anon/authenticated are) — created here,
-- idempotently, so no extra manual step is needed.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role;
  end if;
end $$;

-- Supabase's own platform bootstrap applies a default-privilege EXECUTE
-- grant to anon/authenticated/service_role directly (by role name, not via
-- the PUBLIC pseudo-role) on every NEW function created in `public` from
-- then on — confirmed via a fresh `supabase init`'s generated config.toml
-- (`auto_expose_new_tables`, default true). This is NOT vanilla Postgres
-- behavior: a plain `CREATE FUNCTION` on an ordinary cluster grants EXECUTE
-- to PUBLIC only. Without replicating it here, a migration file that
-- forgets an explicit `revoke ... from anon, authenticated` on a sensitive
-- SECURITY DEFINER function would pass every local test while staying wide
-- open on the real, hosted project — exactly what happened to
-- request_data_deletion()/issue_branch_pos_token()/intake_pos_transaction()/
-- purge_expired_unclaimed_customers()/claim_or_create_profile(text), caught
-- only by manual review on the live database, never by this test suite.
-- Applied once here, BEFORE any migration file runs, AS the `postgres` role
-- (the same role every migration file also runs as via `su postgres -c
-- psql ...`), so it covers every function any of them creates from this
-- point on — exactly mirroring the live timeline.
alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
