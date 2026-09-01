-- ============================================================================
-- NOJ — migration: fix profile re-claiming across anonymous sessions
-- ============================================================================
-- Root cause of "loyalty page shows no merchant balances even after running
-- supabase-migration-merchant-loyalty.sql": claim_or_create_profile() could
-- only ever bind a phone number to ONE anonymous auth session, permanently.
--
-- Reproduced and confirmed directly against Postgres (not just read from the
-- code): the demo phone 512345678 is claimed by whichever anonymous session
-- logs in with it FIRST. Every later login with that same phone number —
-- after "مسح البيانات" (which calls auth.signOut(), ending that anonymous
-- identity for good), a different browser/incognito window, or simply an
-- expired anonymous session token — arrives with a NEW auth.uid(). The old
-- function's step 2 only matched a profile "where phone = p_phone AND
-- auth_user_id is null", so it never matched the already-claimed demo row;
-- step 3 then tried to INSERT a second profile with the same phone number,
-- which profiles.phone's UNIQUE constraint rejects. That raised exception
-- propagates out of loginAndLoad()'s try/catch as a failed login, and the
-- new anonymous session ends up with NO profile at all — hence an empty
-- loyalty page (and, in that specific failure path, an empty everything
-- else too, with the generic "تعذّر الاتصال بالخادم" toast).
--
-- This is not just a demo inconvenience: it's a real authentication bug —
-- ANY customer, not only the demo phone, would be unable to log back into
-- their own account after signing out once, on any phone number.
--
-- THE FIX: claim_or_create_profile() now re-binds any EXISTING profile for
-- that phone number to the current session, regardless of who claimed it
-- before. A phone number typed at the (demo) OTP step is the real identity
-- here — logging in again with the same phone should always reconnect to
-- the SAME account and its history, never fork a new empty one and never
-- crash. This works for literally any phone number, not a hardcoded ID —
-- it is what makes the seeded demo data (phone 512345678, and the balances
-- from supabase-migration-merchant-loyalty.sql) reliably reachable no
-- matter how many times or from how many sessions someone logs in with it,
-- AND fixes the same class of bug for every other user.
--
-- ADDITIVE / SAFE: only replaces one function's body (same signature, same
-- return type public.profiles — no DROP needed). No table is touched, no
-- row is deleted or modified by running this file. Safe to run more than
-- once. Run this ONCE in the Supabase SQL Editor, after supabase-schema.sql
-- (and, if you want the per-merchant loyalty feature working too,
-- supabase-migration-merchant-loyalty.sql — either order relative to that
-- one is fine).
-- ============================================================================

create or replace function public.claim_or_create_profile(p_phone text)
returns public.profiles
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_profile public.profiles;
begin
  if v_uid is null then
    raise exception 'يجب تسجيل الدخول أولاً';
  end if;

  -- already bound to this exact session? nothing to do.
  select * into v_profile from public.profiles where auth_user_id = v_uid;
  if found then
    return v_profile;
  end if;

  -- any existing profile for this phone — claimed or not, by this session
  -- or a previous (possibly now-orphaned) one — is re-bound to the CURRENT
  -- session. Re-authenticating with the same phone must always land back
  -- on the same account and keep its invoices/queue/loyalty history; it
  -- must never be blocked because some earlier anonymous session happened
  -- to claim it first.
  select * into v_profile from public.profiles
  where phone = p_phone
  limit 1;

  if found then
    update public.profiles set auth_user_id = v_uid
    where id = v_profile.id
    returning * into v_profile;
    return v_profile;
  end if;

  -- truly new phone number: fresh, independent, empty profile (unaffected
  -- by this fix — still starts with zero invoices/points everywhere, which
  -- is correct).
  insert into public.profiles (phone, auth_user_id)
  values (p_phone, v_uid)
  returning * into v_profile;
  return v_profile;
end;
$$;
