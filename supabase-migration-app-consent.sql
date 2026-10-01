-- ============================================================================
-- NOJ — migration: in-app consent capture (grant_app_consent)
-- ============================================================================
-- supabase-migration-consent-privacy.sql already built the gate
-- (profile_consents + check_consent_before_earn trigger) and grandfathered
-- every profile that existed at the moment it ran. What it deliberately left
-- unbuilt — per its own comment, "no UI calls any of this yet" — is the one
-- thing a customer created AFTER that moment still needs: an actual way to
-- grant consent. This file is that function: the key for a door that has
-- existed since consent-privacy.sql, unused until now.
--
-- WHERE THIS IS CALLED FROM: index.html, once, the first time a profile with
-- no active data_processing consent opens the app — see the dismissible
-- sheet added there in this same change. Granting consent never blocks
-- entry to the app; declining only means no 'earn' transaction can be
-- recorded for this profile yet (already enforced independently by
-- check_consent_before_earn — this file does not change that enforcement,
-- only gives a customer a real way to satisfy it).
--
-- text_version is a FIXED, HARDCODED constant inside the function, not a
-- client-supplied parameter — the recorded version must always match what
-- the SERVER currently considers "the current policy text", never a stale
-- value a cached client happens to send. Bumping the policy wording later
-- means bumping this constant in a new migration, never trusting the caller
-- with it.
--
-- ADDITIVE / SAFE: no existing table, column, policy, or grant is touched
-- (profile_consents and its RLS already exist from consent-privacy.sql).
-- Run this ONCE, after supabase-migration-consent-privacy.sql. Safe to run
-- more than once.
-- ============================================================================

create or replace function public.grant_app_consent() returns public.profile_consents
language plpgsql
security definer
set search_path = public
as $$
declare
  v_profile_id uuid;
  v_row public.profile_consents;
  v_text_version constant text := 'app-consent-v1-2026-09';
begin
  select id into v_profile_id from public.profiles where auth_user_id = auth.uid();
  if v_profile_id is null then
    raise exception 'لم يتم العثور على ملفك الشخصي';
  end if;

  -- idempotent: a double-tap, a retry after a dropped connection, or calling
  -- this again once already consented must never create a second row or
  -- error — just hand back the existing, still-active consent.
  select * into v_row from public.profile_consents
  where profile_id = v_profile_id and consent_type = 'data_processing' and revoked_at is null;

  if found then
    return v_row;
  end if;

  insert into public.profile_consents (profile_id, consent_type, text_version, channel)
  values (v_profile_id, 'data_processing', v_text_version, 'app')
  returning * into v_row;

  return v_row;
end;
$$;

grant execute on function public.grant_app_consent() to anon, authenticated;
