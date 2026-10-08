-- ============================================================================
-- NOJ — migration: POS invoice intake (stage 1 — schema + claim function)
-- ============================================================================
-- First stage of the POS-integration design agreed in chat: a cashier's own
-- point-of-sale system will eventually post an invoice's amount into
-- public.pos_transactions (a later stage adds the intake endpoint itself —
-- an Edge Function with per-branch auth, out of scope here). The kiosk then
-- shows that amount and asks only for the customer's phone — it NEVER sends
-- an amount itself. This file is schema + the one function that turns a
-- pending POS row into real points, nothing about kiosk.html or the intake
-- endpoint is touched.
--
-- DOES NOT TOUCH kiosk.html, index.html, or kiosk_earn_points() — that
-- function remains exactly as-is, the demo-only path gated by
-- branch_settings.demo_earn_enabled. kiosk_claim_pos_transaction() below is
-- fully additive and is the real-data path for later stages to call.
--
-- KEY DECISIONS (agreed in chat before writing this file):
--   - pos_transactions carries NO customer phone number at all — a device
--     reading its own branch's pending transactions must never see any
--     customer's phone. The link to a customer is made only through
--     invoices (invoice_id), which a device has no grant to read anyway.
--   - amount/vat come from the table only, never from a kiosk-supplied
--     parameter — kiosk_claim_pos_transaction(p_transaction_id, p_phone)
--     takes no amount parameter whatsoever.
--   - expired is enforced by comparing pos_transactions.expires_at to now()
--     INSIDE the function at claim time — the authority is the time check,
--     not the status column. An earlier draft tried to persist status=
--     'expired' with an UPDATE immediately before `raise exception` in the
--     same function call; that write is always rolled back along with
--     everything else the moment the exception propagates (one function
--     call = one transaction), so it was dead code. Removed rather than
--     worked around: correctness never depended on the column being
--     flipped promptly, only on the time check being re-evaluated on every
--     claim attempt.
--   - An unregistered phone is NOT rejected. Its invoice and computed
--     points are saved against the normalized phone (invoices.pending_phone
--     + public.unclaimed_customers, both completely unreachable by any
--     client — RLS enabled with ZERO policies and no table grant beyond
--     what Supabase's project-wide default already gives every table,
--     same lockout pattern as branch_admin_pins). claim_unclaimed_invoices()
--     transfers them to a real account later, but ONLY once
--     profiles.phone_verified_at is set.
--   - profiles.phone_verified_at is NEVER set by anything in this codebase
--     today (confirmed by reading supabase-migration-consent-privacy.sql's
--     own comment and grepping the whole repo) — index.html's OTP screen
--     is a hardcoded DEMO_CODE, not a real SMS check. claim_unclaimed_
--     invoices() therefore correctly refuses EVERY caller today, by design,
--     the same fail-closed shape as demo_earn_enabled defaulting off. This
--     is a real prerequisite, not a formality: wiring a genuine SMS/OTP
--     provider into index.html's login must happen before this feature can
--     transfer anything to anyone. See CLAUDE.md.
--   - Retention: public.unclaimed_customers.last_invoice_at (NOT first) is
--     the clock, bumped on every new pending invoice for that phone.
--     Deleting the anchor row (a year after the LAST invoice, by whichever
--     scheduled job eventually calls purge_expired_unclaimed_customers())
--     cascades to every invoices row still pointing at it via
--     invoices.pending_phone's own FK — permanent deletion, matching the
--     retention decision exactly.
--   - points_rate NULL is treated as 0 (coalesce) rather than left to
--     silently propagate NULL into a balance update. In practice
--     merchants.points_rate is `not null default 1.0` with `check
--     (points_rate > 0)` (supabase-migration-loyalty-rate-expiry.sql), so
--     this path cannot actually be reached today — confirmed by trying to
--     force it in testing and having the database itself reject the NULL
--     before this function ever runs. The coalesce is kept anyway as
--     cheap, harmless defensive coding against a future relaxation of that
--     constraint, not a fix for a currently-reachable bug.
--   - grant execute on every new function here is `to authenticated` only
--     (no anon): a kiosk device's anonymous Supabase Auth session is always
--     served as `authenticated` (it has a real JWT), exactly like every
--     other device-facing function already in this codebase.
--   - invoices.external_ref already exists (added by supabase-migration-
--     point-ledger.sql, with its own unique(merchant_id, external_ref)) —
--     nothing to add here; this file just threads pos_transactions.
--     external_ref through to it.
--
-- ADDITIVE / SAFE: no existing table, column, row, or function is dropped.
-- public.invoices.user_id goes from NOT NULL to nullable (needed for the
-- unregistered-customer path) — existing rows are untouched, all of them
-- already have a real user_id. Run this ONCE, after supabase-migration-
-- kiosk-balance-lookup.sql and supabase-migration-consent-privacy.sql
-- (needs profiles.phone_verified_at). Safe to run more than once.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. invoices: user_id becomes optional, pending_phone carries an
--    unregistered customer's normalized phone instead. Exactly one of the
--    two is ever set — enforced, not just conventional.
-- ---------------------------------------------------------------------------
alter table public.invoices alter column user_id drop not null;

create table if not exists public.unclaimed_customers (
  phone text primary key,
  last_invoice_at timestamptz not null default now()
);
alter table public.unclaimed_customers enable row level security;
-- RLS enabled with NO policies and no table grant beyond Supabase's own
-- project-wide default — unreachable from any client role, same lockout
-- shape as public.branch_admin_pins. The only way in or out is the two
-- SECURITY DEFINER functions below.

alter table public.invoices
  add column if not exists pending_phone text references public.unclaimed_customers(phone) on delete cascade;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'invoices_owner_xor_pending_chk') then
    alter table public.invoices
      add constraint invoices_owner_xor_pending_chk
      check ((user_id is not null) <> (pending_phone is not null));
  end if;
end $$;

create index if not exists invoices_pending_phone_idx
  on public.invoices(pending_phone) where pending_phone is not null;

-- ---------------------------------------------------------------------------
-- 2. pos_transactions: what a POS intake endpoint (a later stage) will
--    insert into. No customer phone number column — ever. device_id is
--    optional: null means "any kiosk in this branch may pick this up",
--    set means "only this specific kiosk/POS terminal".
-- ---------------------------------------------------------------------------
create table if not exists public.pos_transactions (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references public.branches(id) on delete cascade,
  device_id uuid references public.devices(id) on delete set null,
  invoice_id uuid references public.invoices(id) on delete set null,
  external_ref text,
  amount numeric(10,2) not null check (amount > 0),
  vat numeric(10,2) not null default 0 check (vat >= 0),
  status text not null default 'pending'
    check (status in ('pending','claimed','applied','expired','failed')),
  source_adapter text not null default 'generic',
  error_message text,
  metadata jsonb,
  received_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '5 minutes'),
  claimed_at timestamptz,
  applied_at timestamptz,
  unique (branch_id, external_ref)
);
alter table public.pos_transactions enable row level security;

-- Unlike branches/devices/branch_settings/merchant_members (granted to
-- anon, authenticated together in supabase-migration-branches-devices.sql),
-- this table is granted to `authenticated` only, matching point 6's rule
-- for every new grant in this file: a kiosk's anonymous Supabase Auth
-- session always carries a real JWT and is served as `authenticated`, so
-- `anon` buys nothing here. SELECT only — no insert/update/delete grant
-- for any client role; every write goes through
-- kiosk_claim_pos_transaction() below.
grant select on public.pos_transactions to authenticated;

create index if not exists pos_transactions_branch_status_idx
  on public.pos_transactions(branch_id, status);

-- current_device_id(): same bypass-RLS-recursion pattern as the existing
-- current_device_branch_id() (supabase-migration-kiosk-balance-lookup.sql)
-- — needed because the SELECT policy below has to check device_id against
-- the CALLING device's own id, and a naive subquery against devices here
-- would recurse through devices' own policy exactly like branches once did.
create or replace function public.current_device_id() returns uuid
language sql
security definer
set search_path = public
stable
as $$
  select id from public.devices where auth_user_id = auth.uid();
$$;

grant execute on function public.current_device_id() to authenticated;

drop policy if exists "device can select its branch pos transactions" on public.pos_transactions;
create policy "device can select its branch pos transactions"
  on public.pos_transactions for select
  using (
    branch_id = public.current_device_branch_id()
    and (device_id is null or device_id = public.current_device_id())
  );

-- No insert/update/delete policy for anon/authenticated at all — every
-- write to this table happens only through kiosk_claim_pos_transaction()
-- below (status transitions) or a future intake endpoint running as the
-- service role (initial inserts), never directly from a client.

-- ---------------------------------------------------------------------------
-- 3. kiosk_claim_pos_transaction(): the ONLY way a pending POS row becomes
--    real points. Takes a transaction id and a phone — nothing else. Reads
--    amount/vat from the row itself, never from the caller.
-- ---------------------------------------------------------------------------
create or replace function public.kiosk_claim_pos_transaction(p_transaction_id uuid, p_phone text)
returns table(
  is_registered boolean,
  profile_id uuid,
  prev_points integer,
  added_points integer,
  total_points integer,
  invoice_id uuid
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_device public.devices;
  v_txn    public.pos_transactions;
  v_branch public.branches;
  v_merchant public.merchants;
  v_phone  text;
  v_profile_id uuid;
  v_added  integer;
  v_prev   integer;
  v_invoice_id uuid;
begin
  select * into v_device from public.devices
  where auth_user_id = auth.uid() and is_active and revoked_at is null;

  if v_device.id is null or v_device.branch_id is null then
    raise exception 'الجهاز غير مقارَن بفرع بعد';
  end if;

  select * into v_txn from public.pos_transactions where id = p_transaction_id for update;

  if v_txn.id is null
     or v_txn.branch_id <> v_device.branch_id
     or (v_txn.device_id is not null and v_txn.device_id <> v_device.id)
  then
    raise exception 'NOJ_TRANSACTION_NOT_FOUND';
  end if;

  if v_txn.status = 'pending' and v_txn.expires_at < now() then
    raise exception 'NOJ_TRANSACTION_EXPIRED';
  end if;

  if v_txn.status <> 'pending' then
    raise exception 'NOJ_TRANSACTION_NOT_PENDING';
  end if;

  v_phone := public.normalize_sa_phone(p_phone);
  if v_phone is null then
    raise exception 'رقم جوال غير صحيح';
  end if;

  select * into v_branch   from public.branches  where id = v_device.branch_id;
  select * into v_merchant from public.merchants where id = v_branch.merchant_id;

  -- points_rate can be NULL (never set for this merchant) — treated as 0,
  -- never left to silently propagate NULL into a balance update below.
  v_added := round(v_txn.amount * coalesce(v_merchant.points_rate, 0))::integer;

  select id into v_profile_id from public.profiles where phone = v_phone and deleted_at is null;

  update public.pos_transactions
  set status = 'claimed', claimed_at = now()
  where id = v_txn.id;

  if v_profile_id is not null then
    insert into public.merchant_loyalty (user_id, merchant_id, points)
    values (v_profile_id, v_merchant.id, 0)
    on conflict (user_id, merchant_id) do nothing;

    select points into v_prev from public.merchant_loyalty
    where user_id = v_profile_id and merchant_id = v_merchant.id
    for update;

    update public.merchant_loyalty
    set points = points + v_added, updated_at = now()
    where user_id = v_profile_id and merchant_id = v_merchant.id;

    insert into public.invoices (user_id, merchant_id, amount, vat, category, points_earned, status, source, external_ref)
    values (v_profile_id, v_merchant.id, v_txn.amount, v_txn.vat, v_merchant.type, v_added, 'paid', 'pos', v_txn.external_ref)
    returning id into v_invoice_id;

    insert into public.point_transactions
      (user_id, merchant_id, branch_id, device_id, type, points_delta, points_rate_applied, invoice_id, source)
    values
      (v_profile_id, v_merchant.id, v_branch.id, v_device.id, 'earn', v_added,
       coalesce(v_merchant.points_rate, 0), v_invoice_id, 'pos');

    update public.pos_transactions
    set status = 'applied', applied_at = now(), invoice_id = v_invoice_id
    where id = v_txn.id;

    return query select true, v_profile_id, v_prev, v_added, v_prev + v_added, v_invoice_id;
  else
    -- unregistered customer: save the invoice and its computed points
    -- against the normalized phone, no profile, no device-readable trace.
    insert into public.unclaimed_customers (phone, last_invoice_at) values (v_phone, now())
    on conflict (phone) do update set last_invoice_at = now();

    insert into public.invoices (pending_phone, merchant_id, amount, vat, category, points_earned, status, source, external_ref)
    values (v_phone, v_merchant.id, v_txn.amount, v_txn.vat, v_merchant.type, v_added, 'paid', 'pos', v_txn.external_ref)
    returning id into v_invoice_id;

    update public.pos_transactions
    set status = 'applied', applied_at = now(), invoice_id = v_invoice_id
    where id = v_txn.id;

    return query select false, null::uuid, null::integer, v_added, null::integer, v_invoice_id;
  end if;
end;
$$;

grant execute on function public.kiosk_claim_pos_transaction(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. claim_unclaimed_invoices(): called from index.html right after a
--    customer logs in/registers — transfers every pending invoice saved
--    under THEIR OWN already-verified phone (never a client-supplied
--    phone — re-derived from the caller's own profile row) into their real
--    account. Refuses outright unless profiles.phone_verified_at is set —
--    which nothing in this codebase sets today, so this function correctly
--    refuses every caller until a real SMS/OTP provider is wired up. See
--    the file header and CLAUDE.md.
-- ---------------------------------------------------------------------------
create or replace function public.claim_unclaimed_invoices() returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_profile public.profiles;
  v_phone text;
  v_claimed_count integer;
begin
  select * into v_profile from public.profiles where auth_user_id = auth.uid() and deleted_at is null;
  if v_profile.id is null then
    raise exception 'الملف الشخصي غير موجود';
  end if;

  if v_profile.phone is null then
    return 0;
  end if;

  if v_profile.phone_verified_at is null then
    raise exception 'NOJ_PHONE_NOT_VERIFIED';
  end if;

  v_phone := v_profile.phone;

  -- one atomic statement: transfer the invoices, upsert the balance per
  -- merchant, and log the ledger entries — all from the SAME 'claimed' CTE
  -- output, so nothing can race in between and no invoice can be moved
  -- without its points, or vice versa.
  with claimed as (
    update public.invoices
    set user_id = v_profile.id, pending_phone = null
    where pending_phone = v_phone
    returning merchant_id, points_earned, id as invoice_id
  ),
  per_merchant as (
    select merchant_id, sum(points_earned) as pts
    from claimed
    group by merchant_id
  ),
  upsert_balance as (
    insert into public.merchant_loyalty (user_id, merchant_id, points)
    select v_profile.id, merchant_id, pts from per_merchant
    on conflict (user_id, merchant_id)
    do update set points = public.merchant_loyalty.points + excluded.points, updated_at = now()
    returning merchant_id
  ),
  logged as (
    insert into public.point_transactions (user_id, merchant_id, type, points_delta, invoice_id, source)
    select v_profile.id, merchant_id, 'earn', points_earned, invoice_id, 'pos'
    from claimed
    returning 1
  )
  select count(*) into v_claimed_count from claimed;

  delete from public.unclaimed_customers where phone = v_phone;

  return v_claimed_count;
end;
$$;

grant execute on function public.claim_unclaimed_invoices() to authenticated;

-- ---------------------------------------------------------------------------
-- 5. Retention: delete an unclaimed phone's data a year after its LAST
--    invoice (not its first) — cascades to every invoices row still
--    pointing at it via invoices.pending_phone's own FK.
-- ---------------------------------------------------------------------------
create or replace function public.purge_expired_unclaimed_customers() returns integer
language sql
security definer
set search_path = public
as $$
  with deleted as (
    delete from public.unclaimed_customers
    where last_invoice_at < now() - interval '1 year'
    returning phone
  )
  select count(*)::integer from deleted;
$$;

-- cron/SQL-editor only — no client should ever trigger this directly (its
-- own WHERE clause already prevents early deletion of non-expired rows, so
-- the practical impact of a client calling it is low, but it is still not
-- this function's job to run on anyone's request). Never had ANY grant or
-- revoke statement at all until now — on a hosted Supabase project that
-- means it was reachable by anon/authenticated by default from the moment
-- it was created (see the auto_expose_new_tables note on issue_branch_pos_
-- token() above), exactly as found on the live project. pg_cron's own
-- scheduled call below runs as the migration role (postgres, superuser),
-- which always bypasses grants — no service_role grant is needed for that.
revoke all on function public.purge_expired_unclaimed_customers() from public, anon, authenticated, service_role;

-- pg_cron may need enabling manually from the Supabase dashboard (Database
-- → Extensions) if this is rejected for lack of permission on the hosted
-- project — the same situation pgcrypto was in earlier in this project —
-- or may simply not be installed at all in a local test environment. The
-- function above still works standalone via a direct call either way;
-- only the automatic daily schedule depends on pg_cron being enabled, so
-- any failure here is caught and logged rather than aborting the file.
do $$
begin
  create extension if not exists pg_cron;

  if exists (select 1 from cron.job where jobname = 'purge-expired-unclaimed-customers') then
    perform cron.unschedule('purge-expired-unclaimed-customers');
  end if;
  perform cron.schedule(
    'purge-expired-unclaimed-customers',
    '0 3 * * *',
    $sql$select public.purge_expired_unclaimed_customers();$sql$
  );
exception when others then
  raise notice 'pg_cron not available/enabled in this environment — enable it manually from the Supabase dashboard (Database → Extensions) and schedule purge_expired_unclaimed_customers() there. (%)', sqlerrm;
end $$;
