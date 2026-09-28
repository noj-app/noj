-- ============================================================================
-- NOJ — migration: canonical phone number format
-- ============================================================================
-- Requires supabase-migration-consent-privacy.sql to already be applied
-- (the CHECK constraint below references profiles.deleted_at).
--
-- THE GAP THIS CLOSES: profiles.phone is stored exactly as index.html's
-- kiosk-free customer app sends it — 9 digits, no country code, no leading
-- zero (e.g. '512345678'). That is the ONLY writer today, so today's data
-- is already consistent by accident, not by any enforced rule. The moment
-- a second writer exists (a kiosk entering a number on its own pad, a
-- future POS integration) and normalizes differently — with a leading 0,
-- with +966, with spaces — the same real person would silently fork into
-- two unrelated profiles rows, splitting their points between "two
-- accounts" that are actually one.
--
-- THE FIX: one canonical function every future writer should call before
-- ever comparing against or inserting into profiles.phone, plus a CHECK
-- constraint that makes the canonical shape a hard guarantee at the
-- database level, not just a convention someone has to remember.
--
-- ADDITIVE / SAFE: normalize_sa_phone() is new; the CHECK constraint only
-- FORMALIZES a shape every existing row already has (verified below — this
-- file raises an exception and changes nothing if that is not true, rather
-- than silently rejecting rows). Run this ONCE, after
-- supabase-migration-consent-privacy.sql. Safe to run more than once.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. normalize_sa_phone(): accepts any of the common shapes a Saudi mobile
--    number gets typed in — with country code (9665XXXXXXXX / +9665...),
--    with a leading zero (05XXXXXXXX), or already bare (5XXXXXXXX) — and
--    returns the one canonical 9-digit form, or NULL if the input does not
--    match any of them (caller's responsibility to reject/ask again).
-- ---------------------------------------------------------------------------
create or replace function public.normalize_sa_phone(p_raw text) returns text
language sql
immutable
as $$
  select case
    when regexp_replace(coalesce(p_raw, ''), '[^0-9]', '', 'g') ~ '^9665[0-9]{8}$'
      then substring(regexp_replace(p_raw, '[^0-9]', '', 'g') from 4)
    when regexp_replace(coalesce(p_raw, ''), '[^0-9]', '', 'g') ~ '^05[0-9]{8}$'
      then substring(regexp_replace(p_raw, '[^0-9]', '', 'g') from 2)
    when regexp_replace(coalesce(p_raw, ''), '[^0-9]', '', 'g') ~ '^5[0-9]{8}$'
      then regexp_replace(p_raw, '[^0-9]', '', 'g')
    else null
  end;
$$;

-- ---------------------------------------------------------------------------
-- 2. Guarantee the shape at the table level. A deleted/scrubbed profile's
--    phone is deliberately NOT in this shape (request_data_deletion() sets
--    it to a 'deleted-<uuid>' tombstone) — the constraint only applies
--    while deleted_at is still null.
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'profiles_phone_format_chk') then
    alter table public.profiles
      add constraint profiles_phone_format_chk
      check (deleted_at is not null or phone ~ '^5[0-9]{8}$');
  end if;
end $$;
