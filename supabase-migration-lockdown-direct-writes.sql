-- ============================================================================
-- NOJ — SECURITY FIX: no direct client UPDATE on any value-bearing table
-- ============================================================================
-- THE BUG: public.merchant_loyalty's UPDATE policy (added in
-- supabase-migration-merchant-loyalty.sql) has a USING clause that checks
-- ROW OWNERSHIP but no WITH CHECK constraining the NEW VALUE of `points`.
-- Any signed-in session (including the anonymous one every visitor gets
-- automatically) can therefore set their own balance to anything at all —
-- via the browser console, using the exact same public anon key already
-- embedded in index.html's own source — completely bypassing
-- redeem_reward() and the point_transactions ledger it writes to. A ledger
-- sitting on top of a balance that can be rewritten directly is worse than
-- no ledger: it looks authoritative while proving nothing.
--
-- The identical shape of bug (an UPDATE policy that checks who, never what)
-- exists on three more tables. Severity, and what this file does about
-- each, confirmed by reading index.html itself (grep for every `.update(`
-- call in the whole file — there is exactly ONE, on appointments):
--
--   merchant_loyalty — HIGH (redeemable value). No legitimate client write
--     path exists (redeem_reward already fully owns writing to it) — grant
--     removed entirely, no replacement needed on the client side.
--   appointments — HIGH (a real clinic will rely on this). ONE real client
--     write exists today: cancelling an appointment
--     (`sb.from('appointments').update({status:'cancelled'})...` in
--     index.html). Grant removed; replaced by cancel_appointment() below.
--     index.html is updated in this same change to call it instead.
--   profiles.phone (+ phone_verified_at, deleted_at) — HIGH (phone is the
--     customer's identity key at the kiosk; once phone_verified_at exists,
--     a client-rewritten phone would carry a verification stamp for a
--     number that was never actually verified). No existing code updates
--     profiles directly at all (confirmed — claim_or_create_profile, the
--     only thing that ever touches these columns, is already SECURITY
--     DEFINER and is unaffected by revoking the client-facing grant).
--     Grant removed entirely, no replacement needed.
--   queue_tickets — LOWER, still fixed for the same reason. Its UPDATE
--     policy was never actually used by any client code (confirmed — zero
--     `.update(` calls touch it; it was added for a "simulate queue
--     update" feature that was never wired up). Grant removed, no
--     replacement needed.
--
-- THE FIX, one principle for all four: SECURITY DEFINER functions execute
-- with their OWNER's privileges (here, postgres — a superuser, which owns
-- every table and therefore bypasses RLS and grants on it regardless of
-- what anon/authenticated are given). So: revoke the client's direct
-- UPDATE grant and drop the permissive policy on all four tables: no
-- policy is needed to let a function write rows it doesn't need the
-- caller's own permission to touch. Every legitimate write becomes a
-- narrow SECURITY DEFINER function that re-derives the caller's identity
-- from auth.uid() itself (never trusts a client-supplied id) and validates
-- whatever business rule applied before.
--
-- SEARCH_PATH DISCIPLINE: every SECURITY DEFINER function below (including
-- redeem_reward, converted from SECURITY INVOKER here) pins
-- `set search_path = public` explicitly. A SECURITY DEFINER function
-- without a pinned search_path is a well-known privilege-escalation
-- vector (a caller could set their own search_path to shadow an unqualified
-- table/function name with one of their own before calling it) — exactly
-- the kind of bug this file exists to close, not reopen.
--
-- redeem_reward() was originally SECURITY INVOKER on purpose ("the caller
-- only ever touches their own already-claimed row" — supabase-migration-
-- merchant-loyalty.sql's own comment). That reasoning is exactly what this
-- vulnerability disproves: the same grant that lets the function's own
-- UPDATE succeed under the caller's identity ALSO lets the caller issue
-- that UPDATE directly, with no function in between at all. Converting it
-- to SECURITY DEFINER here removes the need for that grant to exist.
--
-- ADDITIVE IN STRUCTURE, BUT THIS FILE CHANGES LIVE BEHAVIOR: unlike every
-- other supabase-migration-*.sql file in this repo, this one intentionally
-- REVOKES a grant and DROPS a policy that the live app currently relies on
-- for redeem_reward's own internal write. redeem_reward's SECURITY
-- DEFINER conversion in this same file is what keeps it working — the two
-- changes must be applied together, not one without the other.
--
-- REQUIRES: supabase-schema.sql, supabase-migration-merchant-loyalty.sql,
-- supabase-migration-health-center.sql already applied (the tables this
-- file locks down are defined there). Independent of every
-- supabase-migration-branches-devices.sql-family file — this fix does not
-- touch or require any of that work. Safe to run more than once.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. merchant_loyalty (HIGH)
-- ---------------------------------------------------------------------------
drop policy if exists "update own merchant loyalty" on public.merchant_loyalty;
revoke update on public.merchant_loyalty from anon, authenticated;

create or replace function public.redeem_reward(p_reward_id uuid)
returns public.merchant_loyalty
language plpgsql
security definer
set search_path = public
as $$
declare
  v_profile_id uuid;
  v_merchant_id uuid;
  v_cost integer;
  v_row public.merchant_loyalty;
begin
  select merchant_id, cost_points into v_merchant_id, v_cost
  from public.rewards
  where id = p_reward_id and active = true;

  if v_merchant_id is null then
    raise exception 'المكافأة غير متاحة';
  end if;

  select id into v_profile_id
  from public.profiles
  where auth_user_id = auth.uid();

  if v_profile_id is null then
    raise exception 'لم يتم العثور على ملفك الشخصي';
  end if;

  select * into v_row
  from public.merchant_loyalty
  where user_id = v_profile_id and merchant_id = v_merchant_id
  for update;

  if v_row.user_id is null then
    raise exception 'لا يوجد رصيد نقاط لديك لدى هذا التاجر';
  end if;

  if v_row.points < v_cost then
    raise exception 'رصيد النقاط غير كافٍ لدى هذا التاجر';
  end if;

  update public.merchant_loyalty
  set points = points - v_cost, updated_at = now()
  where user_id = v_profile_id and merchant_id = v_merchant_id
  returning * into v_row;

  insert into public.redemptions (user_id, reward_id)
  values (v_profile_id, p_reward_id);

  -- point_transactions may not exist yet on a project that has not applied
  -- supabase-migration-point-ledger.sql — this fix must not require it.
  if to_regclass('public.point_transactions') is not null then
    insert into public.point_transactions
      (user_id, merchant_id, type, points_delta, reward_id, source)
    values
      (v_profile_id, v_merchant_id, 'redeem', -v_cost, p_reward_id, 'app_session');
  end if;

  return v_row;
end;
$$;

grant execute on function public.redeem_reward(uuid) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. appointments (HIGH) — cancel_appointment() replaces the one direct
--    client update index.html performs today.
-- ---------------------------------------------------------------------------
drop policy if exists "update own appointments" on public.appointments;
revoke update on public.appointments from anon, authenticated;

create or replace function public.cancel_appointment(p_appointment_id uuid)
returns public.appointments
language plpgsql
security definer
set search_path = public
as $$
declare
  v_profile_id uuid;
  v_row public.appointments;
begin
  select id into v_profile_id from public.profiles where auth_user_id = auth.uid();
  if v_profile_id is null then
    raise exception 'لم يتم العثور على ملفك الشخصي';
  end if;

  select * into v_row
  from public.appointments
  where id = p_appointment_id and user_id = v_profile_id
  for update;

  if v_row.id is null then
    raise exception 'الموعد غير موجود أو لا يخصّك';
  end if;

  if v_row.status <> 'confirmed' then
    raise exception 'لا يمكن إلغاء موعد ليس بحالة مؤكَّدة';
  end if;

  update public.appointments
  set status = 'cancelled'
  where id = p_appointment_id
  returning * into v_row;

  return v_row;
end;
$$;

grant execute on function public.cancel_appointment(uuid) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. profiles.phone / phone_verified_at / deleted_at (HIGH)
-- ---------------------------------------------------------------------------
-- No existing code updates profiles directly at all — claim_or_create_
-- profile() (the only thing that ever writes these columns) is already
-- SECURITY DEFINER and is completely unaffected by revoking the
-- client-facing grant below. This is a zero-risk removal today; if a real
-- "let a customer edit their own display name" feature is ever built, it
-- gets its own narrow function, same as everything else in this file —
-- not a blanket UPDATE grant that also reopens phone/deleted_at.
drop policy if exists "claim or update own profile" on public.profiles;
revoke update on public.profiles from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. queue_tickets (fixed for the same reason, lower real-world severity —
--    this policy was never actually used by any client code)
-- ---------------------------------------------------------------------------
drop policy if exists "update own queue tickets" on public.queue_tickets;
revoke update on public.queue_tickets from anon, authenticated;
