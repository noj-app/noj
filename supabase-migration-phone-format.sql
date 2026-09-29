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
-- SAFE, BUT NOT PURELY ADDITIVE: normalize_sa_phone() is new, and the CHECK
-- constraint mostly FORMALIZES a shape every existing row already has — with
-- one deliberate exception (see section 2 below): a profile with phone = ''
-- (an empty string, from a guest session that never got a real number) is
-- normalized to NULL, and profiles.phone is relaxed from `not null` to
-- nullable to make that representation possible and permanent. No row with
-- a real 9-digit phone is ever touched. Run this ONCE, after
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
-- 2. A real, pre-existing row on the live project surfaced a gap the first
--    version of this file did not account for: profiles.phone was `not
--    null` (supabase-schema.sql), yet claim_or_create_profile() is
--    reachable with an empty phone string — index.html's loginAndLoad(A.phone)
--    runs on every app boot with an existing session (Store K.SESSION=true),
--    and A.phone silently stays '' if K.PHONE was never saved or was lost
--    from localStorage. That inserts a profile with phone = '' — NOT sql
--    NULL (impossible under the old `not null`, confirmed against the
--    live row), an empty STRING, which the original check below rejected
--    outright (`'' !~ '^5[0-9]{8}$'` is a definite false, not unknown).
--
--    '' is also the wrong representation to special-case around: it is a
--    real, matchable value. A SECOND guest session hitting the same path
--    would have claim_or_create_profile()'s `where phone = p_phone limit 1`
--    lookup find the FIRST guest's '' row and silently REBIND it — two
--    unrelated visitors merged onto one profile, no error, no trace. NULL
--    is the correct representation of "not provided yet": equality with
--    NULL never matches (not even NULL = NULL), so two NULL-phone guests
--    can never collide this way, and a plain UNIQUE constraint already
--    treats every NULL as distinct from every other (the same property
--    already relied on for invoices.external_ref in
--    supabase-migration-point-ledger.sql) — so relaxing the column to
--    nullable does not reopen the "same phone, two rows" problem this
--    whole file exists to prevent.
--
--    This does not by itself change what claim_or_create_profile() passes
--    in — that function is untouched here, out of this file's scope, and a
--    future call with p_phone = '' would now simply be REJECTED by the
--    constraint below (a loud, visible error) instead of silently
--    succeeding or merging two visitors — a strict improvement, though not
--    a full fix of that call site.
-- ---------------------------------------------------------------------------

-- the column must accept NULL before anything can be set to it — drop
-- `not null` FIRST, then normalize any existing empty-string placeholder to
-- NULL. Scrubbed/deleted profiles (phone = 'deleted-<uuid>') are never
-- empty and are untouched by this update.
alter table public.profiles alter column phone drop not null;

update public.profiles set phone = null where phone = '';

-- ---------------------------------------------------------------------------
-- 3. Guarantee the shape at the table level. A deleted/scrubbed profile's
--    phone is deliberately NOT in this shape (request_data_deletion() sets
--    it to a 'deleted-<uuid>' tombstone) — the constraint only applies
--    while deleted_at is still null. NULL is explicitly allowed: a profile
--    created before its owner ever typed a real number (see above) — '' is
--    NOT allowed, and neither is any other malformed value.
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'profiles_phone_format_chk') then
    alter table public.profiles
      add constraint profiles_phone_format_chk
      check (deleted_at is not null or phone is null or phone ~ '^5[0-9]{8}$');
  end if;
end $$;
