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
-- which profiles.phone's UNIQUE constraint rejects.
--
-- SECOND BUG, found and reproduced after a report that the loyalty page was
-- STILL empty even after the first fix below was applied and the database
-- itself was confirmed correct (11 merchant_loyalty rows tied to profile
-- '11111111-1111-1111-1111-111111111111' / phone 512345678). The first
-- version of this file's fix re-bound an existing profile by phone number,
-- but its very first check —
--   select * into v_profile from public.profiles where auth_user_id = v_uid;
--   if found then return v_profile; end if;
-- — returned WHATEVER profile this browser's anonymous session was already
-- bound to, WITHOUT checking that its phone matches the phone just entered.
-- index.html's loginAndLoad() calls sb.auth.getSession() first and only
-- calls signInAnonymously() if none is found — so a plain "تسجيل الخروج"
-- (which never calls auth.signOut(), only "مسح البيانات" does) leaves the
-- SAME anonymous auth.uid() persisted in the browser across logins. If that
-- uid had ever been bound to some other profile (e.g. an earlier test with
-- a blank/placeholder phone), every future login — even typing the correct
-- demo phone — kept returning that same stale, wrong profile forever,
-- because this first check won unconditionally before the phone was ever
-- looked at.
--
-- Reproduced directly: one fixed auth.uid() first claims a blank-phone
-- profile, then (same uid, no new session) calls
-- claim_or_create_profile('512345678') — it incorrectly kept returning the
-- blank-phone profile and saw 0 merchant_loyalty rows, even though the
-- 512345678 profile and its 11 seeded balances were sitting right there.
--
-- This is not just a demo inconvenience: it's a real authentication bug —
-- ANY customer, not only the demo phone, could get permanently stuck on the
-- wrong profile after signing out (or simply testing a different phone
-- number in the same browser session) once.
--
-- THE FIX: claim_or_create_profile() now requires auth_user_id AND phone to
-- both match before trusting an existing binding. Whenever they don't (a
-- different phone was just entered than whatever this session was bound to
-- before), it first releases that stale binding — auth_user_id is UNIQUE,
-- so the old row must be unbound before a different row can take this
-- session — then resolves purely by phone: any existing profile for that
-- phone (claimed by someone else before, unclaimed, or nobody) is bound to
-- the current session. Logging in with a phone number must always land on
-- THAT phone's own account and history, never on whatever this browser
-- session happened to be attached to previously. This works for literally
-- any phone number, not a hardcoded ID.
--
-- ADDITIVE / SAFE: only replaces one function's body (same signature, same
-- return type public.profiles — no DROP needed). No table is touched, no
-- row is deleted by running this file (a stale profile's auth_user_id may
-- be set back to null, which is exactly the "unclaimed" state it should be
-- in). Safe to run more than once. Run this ONCE in the Supabase SQL
-- Editor, after supabase-schema.sql (and, if you want the per-merchant
-- loyalty feature working too, supabase-migration-merchant-loyalty.sql —
-- either order relative to that one is fine). If you already ran an
-- earlier version of this same file, just run this one again — it's the
-- same function, replaced in place.
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

  -- already bound to THIS session AND this exact phone? nothing to do.
  -- (checking phone here too is the whole fix: a stale binding to some
  -- OTHER phone must never win just because it matches auth_user_id.)
  select * into v_profile from public.profiles
  where auth_user_id = v_uid and phone = p_phone;
  if found then
    return v_profile;
  end if;

  -- this session's auth_user_id might already be bound to a DIFFERENT
  -- phone's profile (stale, from an earlier login/test in this same
  -- browser). auth_user_id is unique, so that binding must be released
  -- first, or re-binding the correct profile below would collide with it.
  update public.profiles set auth_user_id = null
  where auth_user_id = v_uid;

  -- any existing profile for the phone just presented — claimed by
  -- someone/something else before, unclaimed, or nobody — is (re)bound to
  -- this session now. Logging in with a phone number must always resolve
  -- to THAT phone's own account and history, never fork a new empty one
  -- and never get stuck on a stale binding.
  select * into v_profile from public.profiles
  where phone = p_phone
  limit 1;

  if found then
    update public.profiles set auth_user_id = v_uid
    where id = v_profile.id
    returning * into v_profile;
    return v_profile;
  end if;

  -- truly new phone number: fresh, independent, empty profile — still
  -- starts with zero invoices/points everywhere, which is correct.
  insert into public.profiles (phone, auth_user_id)
  values (p_phone, v_uid)
  returning * into v_profile;
  return v_profile;
end;
$$;
