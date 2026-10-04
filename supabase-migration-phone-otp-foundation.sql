-- ============================================================================
-- NOJ — migration: real phone verification, stage 1 (DB foundation only)
-- ============================================================================
-- First stage of replacing index.html's hardcoded DEMO_CODE with real SMS
-- OTP (Supabase Auth Phone OTP + a Send SMS Hook to Unifonic — decided in
-- chat). This file is schema + two functions, NOTHING ELSE: no Supabase Auth
-- dashboard config, no Send SMS Hook, no index.html change. The existing
-- claim_or_create_profile(p_phone) is NOT modified, NOT dropped, and is
-- still exactly as trusting of its p_phone parameter as it is today — it
-- stays callable so nothing breaks before stage 3 switches index.html over.
-- This file only ADDS a new, additive, currently-uncalled path next to it.
--
-- THE ACTUAL FIX THIS BUILDS TOWARD: claim_or_create_profile(p_phone) trusts
-- whatever phone string a client passes — anyone can claim/reclaim anyone
-- else's profile by typing their number, because index.html's "OTP" check
-- today is a client-side string compare against a hardcoded DEMO_CODE, not
-- a real SMS round-trip. claim_or_create_verified_profile() below takes NO
-- phone parameter at all: it derives the phone from auth.users.phone, which
-- only Supabase itself sets, and only after a real OTP SMS round-trip to
-- that exact device succeeds (via auth.updateUser({phone}) + auth.verifyOtp
-- on the SAME already-anonymous session — the supported "upgrade an
-- anonymous user" pattern, which keeps auth.uid() stable so profiles.
-- auth_user_id and every RLS policy keyed on it are undisturbed). Wired
-- into index.html in stage 3, once stage 2 has a real provider behind it.
--
-- LAYERED ABUSE PROTECTION (agreed in chat) — most of it is NOT SQL:
--   1. Send SMS Hook (stage 2) rejects any number that doesn't normalize to
--      a Saudi one BEFORE ever calling Unifonic — stops SMS-pumping fraud
--      toward expensive international premium numbers. Hook code, not here.
--   2. CAPTCHA (hCaptcha/Turnstile) on BOTH signInAnonymously and the OTP
--      request, configured in Supabase Auth settings — stops cheap
--      automated creation of unlimited anonymous sessions, which is what
--      makes a per-auth.uid() limit alone insufficient (an attacker who can
--      mint sessions for free simply mints a new one per attempt). Dashboard
--      config + an index.html captcha widget in stage 3, not here.
--   3. Supabase's own per-IP/per-phone rate limits (Auth settings) — a
--      blunt backstop underneath both of the above.
--   4. otp_requests below — a per-DEVICE (per auth.uid()) cap. With 1-3 in
--      place, this is deliberately NOT the primary defense (an attacker who
--      passed CAPTCHA once could still get 5 sends from that one session) —
--      it is the last, cheapest layer: it catches a single compromised or
--      scripted device cycling through many phone numbers from one session
--      AFTER it already cleared CAPTCHA and the IP limits, at zero marginal
--      cost (one small table, one function). Kept because it is still
--      strictly useful in combination with 1-3, not redundant with them.
--
-- ADDITIVE / SAFE: no existing table, column, row, or function is dropped
-- or altered. Run this ONCE, after supabase-migration-phone-format.sql
-- (needs normalize_sa_phone()) and supabase-migration-consent-privacy.sql
-- (needs profiles.phone_verified_at). Safe to run more than once.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. otp_requests: a per-device (auth.uid()) send counter. RLS enabled with
--    NO policies and no table grant to anon/authenticated at all — same
--    total lockout shape as branch_admin_pins/unclaimed_customers. The only
--    way in or out is record_otp_request() below.
-- ---------------------------------------------------------------------------
create table if not exists public.otp_requests (
  id uuid primary key default gen_random_uuid(),
  auth_user_id uuid not null references auth.users(id) on delete cascade,
  requested_at timestamptz not null default now()
);
alter table public.otp_requests enable row level security;

create index if not exists otp_requests_auth_user_time_idx
  on public.otp_requests(auth_user_id, requested_at);

-- record_otp_request(): called by the client right before EVERY attempt to
-- trigger a real OTP send (auth.updateUser({phone}) or auth.signInWithOtp),
-- in stage 3. Refuses once this device has sent 5 within the last hour.
-- The limit is a FIXED SERVER-SIDE CONSTANT, never a client-supplied
-- parameter — a function that let the caller choose its own rate limit
-- would not be a rate limit at all.
create or replace function public.record_otp_request() returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_count integer;
begin
  if v_uid is null then
    raise exception 'يجب إنشاء جلسة أولاً';
  end if;

  select count(*) into v_count from public.otp_requests
  where auth_user_id = v_uid and requested_at > now() - interval '1 hour';

  if v_count >= 5 then
    raise exception 'NOJ_OTP_RATE_LIMITED';
  end if;

  insert into public.otp_requests (auth_user_id) values (v_uid);
end;
$$;

grant execute on function public.record_otp_request() to authenticated;

-- ---------------------------------------------------------------------------
-- 2. claim_or_create_verified_profile(): the real fix. Takes NO parameters.
--    Derives the phone from auth.users (set only by Supabase itself after a
--    real OTP round-trip on THIS session), normalizes it with the same
--    normalize_sa_phone() every other phone in this codebase goes through
--    (also the de facto "Saudi numbers only" gate at the DB layer — a
--    non-Saudi-shaped number normalizes to NULL and is rejected here, same
--    as everywhere else normalize_sa_phone() is used), then delegates to
--    the EXISTING claim_or_create_profile(p_phone) for the actual
--    claim/create/reclaim logic — not duplicated, not reimplemented, so
--    fix-profile-reclaim.sql's behavior is reused exactly as-is, unchanged.
--    Finally stamps profiles.phone_verified_at (first-verified timestamp,
--    never overwritten once set) — the one thing claim_or_create_profile()
--    itself still does not and must not do, since IT still has no way to
--    know a phone was ever really verified.
-- ---------------------------------------------------------------------------
create or replace function public.claim_or_create_verified_profile()
returns public.profiles
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_raw_phone text;
  v_confirmed timestamptz;
  v_phone text;
  v_profile public.profiles;
begin
  if v_uid is null then
    raise exception 'يجب إنشاء جلسة أولاً';
  end if;

  select phone, phone_confirmed_at into v_raw_phone, v_confirmed
  from auth.users where id = v_uid;

  if v_confirmed is null or v_raw_phone is null then
    raise exception 'NOJ_PHONE_NOT_VERIFIED';
  end if;

  v_phone := public.normalize_sa_phone(v_raw_phone);
  if v_phone is null then
    raise exception 'رقم جوال غير صحيح';
  end if;

  select * into v_profile from public.claim_or_create_profile(v_phone);

  update public.profiles
  set phone_verified_at = coalesce(phone_verified_at, now())
  where id = v_profile.id
  returning * into v_profile;

  return v_profile;
end;
$$;

grant execute on function public.claim_or_create_verified_profile() to authenticated;
