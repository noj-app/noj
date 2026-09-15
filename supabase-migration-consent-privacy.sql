-- ============================================================================
-- NOJ — migration: consent records + right-to-erasure (PDPL)
-- ============================================================================
-- Requires supabase-migration-point-ledger.sql to already be applied (the
-- consent-enforcement trigger below is on public.point_transactions).
--
-- WHEN CONSENT IS ASKED — the flow this schema is built for:
--   claim_or_create_profile() (supabase-migration-fix-profile-reclaim.sql)
--   still creates a profiles row immediately on first phone entry, exactly
--   as it does today — a bare phone number with no purchase/points history
--   attached to it yet is not, by itself, processing that needs prior
--   consent. What DOES need it is the first time that profile actually
--   earns points at a merchant. The enforcement below is a real, structural
--   gate on that moment (a database trigger, not just a comment saying a
--   client should ask first) — it rejects any 'earn' transaction for a
--   profile with no active data_processing consent on file, regardless of
--   which future code path tries to insert one.
--
--   This file does not change claim_or_create_profile() and does not add
--   any UI — per this round's scope, no interface calls any of this yet.
--   The future consent screen only needs to insert one profile_consents
--   row (channel='app' or 'kiosk') before whatever flow first awards
--   points; everything else here already assumes that shape.
--
-- EVERY EXISTING PROFILE is grandfathered in below with a backfilled
-- consent row (channel='backfill') dated to its own created_at — otherwise
-- turning on the enforcement trigger would immediately block earning for
-- every profile that exists today, which is not the intent of this change.
--
-- RIGHT TO ERASURE: request_data_deletion() does not delete the profiles
-- row (point_transactions/merchant_loyalty/invoices reference it and must
-- stay intact for dispute review) — it scrubs the phone number in place and
-- sets deleted_at. data_deletion_requests.phone_hash is a one-way SHA-256
-- digest of the ORIGINAL number, captured at the moment of the request,
-- before the scrub — so if the same person contacts support later, hashing
-- the number they give you and comparing it to this stored hash confirms
-- they are who they say they are, without anyone ever needing to store or
-- display their real number again.
--
-- ADDITIVE / SAFE: no existing table/column/row is altered or dropped
-- (profiles gains two new nullable columns only). Run this ONCE, after
-- supabase-migration-point-ledger.sql. Safe to run more than once.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. profiles: two new nullable columns
-- ---------------------------------------------------------------------------
-- phone_verified_at: set only by a REAL verification step. Today's OTP
-- screen in index.html is a hardcoded demo code (DEMO_CODE = '1234', no
-- actual SMS provider) — this column is provisioned now but will correctly
-- stay null for practically everyone until a real OTP/SMS provider is wired
-- up. Nothing in this migration sets it to anything.
alter table public.profiles add column if not exists phone_verified_at timestamptz;

-- right-to-erasure marker; see request_data_deletion() below.
alter table public.profiles add column if not exists deleted_at timestamptz;

-- ---------------------------------------------------------------------------
-- 2. profile_consents
-- ---------------------------------------------------------------------------
create table if not exists public.profile_consents (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles(id) on delete cascade,
  -- null = platform-wide consent; set = specific to one merchant's program.
  merchant_id uuid references public.merchants(id) on delete cascade,
  consent_type text not null default 'data_processing'
    check (consent_type in ('data_processing', 'marketing')),
  -- which exact wording was agreed to — policy text changes over time, and
  -- this is how you prove what a specific person actually saw and accepted.
  text_version text not null,
  channel text not null check (channel in ('app', 'kiosk', 'backfill')),
  granted_at timestamptz not null default now(),
  revoked_at timestamptz
);

create index if not exists profile_consents_profile_id_idx on public.profile_consents(profile_id);

-- backfill: grandfather every existing profile in, dated to its own
-- created_at, so turning on the enforcement trigger below does not break
-- anything that already exists.
insert into public.profile_consents (profile_id, consent_type, text_version, channel, granted_at)
select p.id, 'data_processing', 'grandfathered-pre-consent-flow', 'backfill', p.created_at
from public.profiles p
where not exists (
  select 1 from public.profile_consents pc
  where pc.profile_id = p.id and pc.consent_type = 'data_processing'
);

alter table public.profile_consents enable row level security;

drop policy if exists "select own consents" on public.profile_consents;
create policy "select own consents"
  on public.profile_consents for select
  using (exists (
    select 1 from public.profiles p
    where p.id = profile_consents.profile_id and p.auth_user_id = auth.uid()
  ));

grant select on public.profile_consents to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. Enforcement: no 'earn' transaction without an active consent on file.
--    Deliberately scoped to type='earn' only — 'opening_balance'/'backfill'
--    rows predate this policy by definition, and 'redeem' presupposes a
--    balance that could only exist because an earlier earn already cleared
--    this same check.
-- ---------------------------------------------------------------------------
create or replace function public.check_consent_before_earn() returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.type = 'earn' and not exists (
    select 1 from public.profile_consents
    where profile_id = new.user_id
      and consent_type = 'data_processing'
      and revoked_at is null
  ) then
    raise exception 'لا يمكن تسجيل نقاط لعميل بلا موافقة مسجّلة على معالجة بياناته';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_check_consent_before_earn on public.point_transactions;
create trigger trg_check_consent_before_earn
before insert on public.point_transactions
for each row execute function public.check_consent_before_earn();

-- ---------------------------------------------------------------------------
-- 4. data_deletion_requests + request_data_deletion()
-- ---------------------------------------------------------------------------
create table if not exists public.data_deletion_requests (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles(id) on delete cascade,
  phone_hash text not null,
  requested_at timestamptz not null default now(),
  fulfilled_at timestamptz,
  note text
);

create index if not exists data_deletion_requests_profile_id_idx on public.data_deletion_requests(profile_id);

alter table public.data_deletion_requests enable row level security;
-- admin/service-role only for now: no policy is added for anon/authenticated
-- (no self-serve deletion UI exists yet), and no grant is issued to them
-- either — this table and the function below are reachable only with the
-- service role key or directly in the SQL editor until an admin surface
-- decides otherwise.

-- SECURITY DEFINER: must read/scrub a profiles row that does not
-- necessarily belong to the caller's own claimed session (this is an
-- admin/support action, not a customer self-service one — see above).
create or replace function public.request_data_deletion(p_profile_id uuid, p_note text default null)
returns public.data_deletion_requests
language plpgsql
security definer
set search_path = public
as $$
declare
  v_phone text;
  v_req public.data_deletion_requests;
begin
  select phone into v_phone
  from public.profiles
  where id = p_profile_id and deleted_at is null;

  if v_phone is null then
    raise exception 'ملف العميل غير موجود أو محذوف مسبقاً';
  end if;

  insert into public.data_deletion_requests (profile_id, phone_hash, note)
  values (p_profile_id, encode(digest(v_phone, 'sha256'), 'hex'), p_note)
  returning * into v_req;

  update public.profiles
  set phone = 'deleted-' || id::text, deleted_at = now()
  where id = p_profile_id;

  update public.data_deletion_requests
  set fulfilled_at = now()
  where id = v_req.id
  returning * into v_req;

  return v_req;
end;
$$;

-- deliberately no grant to anon/authenticated — service_role (or the SQL
-- editor, running as postgres) only, until an admin UI exists.
