-- ============================================================================
-- NOJ — migration: admin PIN lockdown (branch binding + attempt rate limit)
-- ============================================================================
-- Redefines verify_admin_pin() from supabase-migration-kiosk-admin-pin.sql.
-- That original version trusted p_branch_id as a bare parameter with no
-- check at all on who was asking, and had no limit whatsoever on how many
-- PINs could be tried — a 4-digit PIN (10,000 combinations) is brute-
-- forceable in minutes over a direct RPC call that bypasses kiosk.html's
-- own UI entirely. Two independent fixes, both required:
--
--   1. BRANCH BINDING: the caller must be an active device of EXACTLY the
--      branch it is asking about (current_device_branch_id() = p_branch_id,
--      supabase-migration-kiosk-balance-lookup.sql). kiosk.html's own
--      verifyPin() already only ever sends its OWN DEVICE.branchId
--      (confirmed by reading the file), so this changes nothing for any
--      legitimate kiosk — it only stops a DIFFERENT session (a customer, or
--      any other kiosk) from trying PINs against a branch that is not its
--      own.
--   2. RATE LIMIT: admin_pin_attempts tracks failures per branch, same
--      total-lockout RLS shape as branch_admin_pins itself (enabled, no
--      policies, no grant — reachable only through verify_admin_pin()). 5
--      wrong PINs within a rolling 15-minute window locks that branch out
--      for 15 minutes (raises 'NOJ_PIN_LOCKED', a distinct error code
--      kiosk.html matches on to show a different message than "wrong PIN").
--      A correct PIN always clears the counter immediately.
--
-- Also fixes the SAME "revoke from public is not enough" gap documented in
-- supabase-migration-pos-intake.sql: the original grant was `to anon,
-- authenticated`, but nothing in kiosk.html ever calls this before
-- bootKiosk()'s own signInAnonymously() completes, so anon is dropped here
-- too (see supabase-migration-app-consent.sql for the same reasoning).
--
-- Requires supabase-migration-kiosk-admin-pin.sql (branch_admin_pins,
-- verify_admin_pin's original definition) and supabase-migration-kiosk-
-- balance-lookup.sql (current_device_branch_id()) first.
--
-- ADDITIVE / SAFE: no existing table/column/row is dropped. Safe to run
-- more than once.
-- ============================================================================

create table if not exists public.admin_pin_attempts (
  branch_id uuid primary key references public.branches(id) on delete cascade,
  fail_count integer not null default 0,
  window_started_at timestamptz not null default now(),
  locked_until timestamptz
);

-- RLS enabled, deliberately with NO policies and NO grant to anon/
-- authenticated — same total lockout shape as branch_admin_pins. The only
-- access path is verify_admin_pin() itself (SECURITY DEFINER).
alter table public.admin_pin_attempts enable row level security;

create or replace function public.verify_admin_pin(p_branch_id uuid, p_pin text)
returns boolean
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_attempts public.admin_pin_attempts;
  v_ok boolean;
  v_window_expired boolean;
  v_new_count integer;
begin
  -- the caller must be an active device of EXACTLY this branch — never
  -- trust p_branch_id as a bare client-supplied value (see file header).
  if public.current_device_branch_id() is distinct from p_branch_id then
    raise exception 'NOJ_PIN_WRONG_BRANCH';
  end if;

  select * into v_attempts
  from public.admin_pin_attempts
  where branch_id = p_branch_id
  for update;

  if v_attempts.locked_until is not null and v_attempts.locked_until > now() then
    raise exception 'NOJ_PIN_LOCKED';
  end if;

  v_window_expired := v_attempts.branch_id is null
    or v_attempts.window_started_at < now() - interval '15 minutes';

  select exists (
    select 1 from public.branch_admin_pins
    where branch_id = p_branch_id and pin_hash = crypt(p_pin, pin_hash)
  ) into v_ok;

  if v_ok then
    -- correct PIN always clears any prior failure history for this branch.
    delete from public.admin_pin_attempts where branch_id = p_branch_id;
    return true;
  end if;

  v_new_count := case when v_window_expired then 1 else v_attempts.fail_count + 1 end;

  insert into public.admin_pin_attempts (branch_id, fail_count, window_started_at, locked_until)
  values (
    p_branch_id,
    v_new_count,
    case when v_window_expired then now() else v_attempts.window_started_at end,
    case when v_new_count >= 5 then now() + interval '15 minutes' else null end
  )
  on conflict (branch_id) do update
  set fail_count = excluded.fail_count,
      window_started_at = excluded.window_started_at,
      locked_until = excluded.locked_until;

  return false;
end;
$$;

-- revoke from public alone is not enough on a hosted Supabase project (see
-- the auto_expose_new_tables note in supabase-migration-pos-intake.sql) —
-- anon/authenticated must be named explicitly. authenticated only, not
-- anon: kiosk.html always signs in anonymously (authenticated-role JWT)
-- before this screen is reachable at all.
revoke all on function public.verify_admin_pin(uuid, text) from public, anon, authenticated;
grant execute on function public.verify_admin_pin(uuid, text) to authenticated;
