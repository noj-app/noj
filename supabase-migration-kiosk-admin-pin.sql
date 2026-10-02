-- ============================================================================
-- NOJ — migration: kiosk admin PIN verification (branch_admin_pins)
-- ============================================================================
-- DOCUMENTS A CHANGE ALREADY APPLIED MANUALLY to the live Supabase project —
-- kiosk.html's verifyPin() already calls this verify_admin_pin() RPC (that
-- client-side change already shipped separately). This file exists so the
-- live schema is reproducible from the files in this repo — it is NOT meant
-- to be run against the live project again as a new change. It is written
-- idempotently (if not exists / create or replace) so re-running it is
-- harmless either way.
--
-- WHY A SEPARATE TABLE, NOT A COLUMN ON branch_settings: branch_settings
-- already grants SELECT to the paired device itself (so the kiosk can read
-- its own display settings) — a pin_hash column there would be readable,
-- even hashed, by the one party that must never be able to read it.
-- branch_admin_pins has RLS enabled with NO policies at all, and no grant to
-- anon/authenticated on the table itself either: this makes the table
-- completely unreachable from the client regardless of role. The only way
-- in or out is verify_admin_pin() itself, which bypasses RLS as SECURITY
-- DEFINER and only ever returns a boolean, never the hash.
--
-- NO PIN VALUE OR HASH IS STORED IN THIS FILE. Provisioning a branch's PIN
-- (inserting into branch_admin_pins with crypt(p_pin, gen_salt('bf'))) is a
-- separate, deliberately out-of-repo administrative action.
--
-- ADDITIVE / SAFE: no existing table, column, or row is touched. Safe to run
-- more than once.
-- ============================================================================

create extension if not exists pgcrypto with schema extensions;

create table if not exists public.branch_admin_pins (
  branch_id uuid primary key references public.branches(id) on delete cascade,
  pin_hash text not null
);

-- RLS enabled, deliberately with NO policies — see header. No table-level
-- grant to anon/authenticated either; verify_admin_pin() is the only path.
alter table public.branch_admin_pins enable row level security;

create or replace function public.verify_admin_pin(p_branch_id uuid, p_pin text)
returns boolean
language sql
security definer
set search_path = public, extensions
as $$
  select exists (
    select 1 from public.branch_admin_pins
    where branch_id = p_branch_id
      and pin_hash = crypt(p_pin, pin_hash)
  );
$$;

grant execute on function public.verify_admin_pin(uuid, text) to anon, authenticated;
