-- ============================================================================
-- NOJ — migration: pending points model (CLAUDE.md 6-أ) — PR1: data model only
-- ============================================================================
-- Points are earned immediately on every invoice, but for merchants with a
-- hold period (merchants.points_hold_days > 0) they are PENDING — counted in
-- the balance the customer sees, not yet redeemable — until
-- invoice date + hold_days. Nothing here ever makes a balance negative.
--
-- WHAT THIS FILE ADDS
--   1. merchants.points_hold_days (integer, default 0) with an initial value
--      derived from merchants.type at migration time (grocery/retail → 7,
--      everything else → 0), and the same derivation for NEW merchants.
--      A merchant-level data setting, not a code constant. NOTE: it is
--      merchants.type (the invoice category), NOT branch_settings.sector_code
--      (a kiosk display classification at branch level — unrelated).
--   2. point_transactions.status ('available'|'pending'|'cancelled', default
--      'available') and release_at. Every row that exists BEFORE this file
--      reads status='available'/release_at=NULL through the column DEFAULT —
--      no UPDATE, no backfill: existing balances stay exactly as they are.
--   3. apply_points_earn(): the ONE internal function that records an earn.
--      kiosk_claim_pos_transaction(), claim_unclaimed_invoices() and
--      kiosk_earn_points() all call it instead of each carrying its own
--      copy of the balance/ledger logic. hold_days = 0 → identical to the
--      previous behavior (available ledger row + merchant_loyalty.points
--      immediately). hold_days > 0 → a 'pending' ledger row with release_at
--      = ORIGINAL INVOICE DATE + hold_days (never the claim time: an
--      unregistered customer who registers weeks later does not restart the
--      clock; if the date has already passed the points are simply
--      available at once) and merchant_loyalty.points is NOT touched.
--   4. release_pending_points(): converts due pending rows to available and
--      adds them to merchant_loyalty.points. Scheduled with pg_cron every 15
--      minutes (pure internal accounting, no external call → pg_cron, per the
--      rule in CLAUDE.md). Idempotent: only touches rows that are due.
--   5. kiosk_lookup_customer_points() returns available + pending, so the
--      number is right even if the scheduled job is late or paused. (Every
--      status='pending' row counts, due or not: a due row is not in
--      merchant_loyalty.points until the job converts it, so counting it
--      here cannot double count.)
--
-- WHAT IS DELIBERATELY UNTOUCHED
--   - redeem_reward(): not redefined here at all. It spends from
--     merchant_loyalty.points only = the AVAILABLE balance.
--   - Refunds (intake_pos_refund, the 'refund_adjustment' ledger type,
--     excluding refunded invoices from claim_unclaimed_invoices) — PR2.
--   - index.html / merchant.html / kiosk.html — later PRs / not touched.
--
-- ADDITIVE / SAFE / IDEMPOTENT: new columns have defaults, the three existing
-- functions keep their signatures, return types and grants. Run ONCE, after
-- supabase-migration-merchant-invoices.sql / pos-vat-inclusive.sql. Safe to
-- run more than once (the hold-days backfill runs only when the column is
-- first created, so it can never overwrite a value an owner has since set).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. merchants.points_hold_days
-- ---------------------------------------------------------------------------
create or replace function public.merchant_default_hold_days(p_type text)
returns integer
language sql
immutable
set search_path = public
as $$
  select case when p_type in ('بقالة', 'تجزئة', 'تسوق', 'متاجر') then 7 else 0 end;
$$;

revoke all on function public.merchant_default_hold_days(text) from public, anon, authenticated, service_role;

do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'merchants' and column_name = 'points_hold_days'
  ) then
    alter table public.merchants add column points_hold_days integer not null default 0;
    -- first-time derivation only; re-running the file never reaches this branch
    update public.merchants set points_hold_days = public.merchant_default_hold_days(type);
  end if;
end $$;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'merchants_points_hold_days_chk') then
    alter table public.merchants
      add constraint merchants_points_hold_days_chk check (points_hold_days between 0 and 365);
  end if;
end $$;

-- New merchants: derive from type unless the insert supplied a non-zero value.
-- (An explicit 0 on insert is indistinguishable from the column default, so it
-- is derived too; an owner can still set 0 afterwards with a plain UPDATE.)
create or replace function public.merchants_default_hold_days_trg() returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.points_hold_days = 0 then
    new.points_hold_days := public.merchant_default_hold_days(new.type);
  end if;
  return new;
end;
$$;

revoke all on function public.merchants_default_hold_days_trg() from public, anon, authenticated, service_role;

drop trigger if exists trg_merchants_default_hold_days on public.merchants;
create trigger trg_merchants_default_hold_days
before insert on public.merchants
for each row execute function public.merchants_default_hold_days_trg();

-- ---------------------------------------------------------------------------
-- 2. point_transactions.status / release_at
-- ---------------------------------------------------------------------------
alter table public.point_transactions
  add column if not exists status text not null default 'available';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'point_transactions_status_chk') then
    alter table public.point_transactions
      add constraint point_transactions_status_chk check (status in ('available', 'pending', 'cancelled'));
  end if;
end $$;

alter table public.point_transactions
  add column if not exists release_at timestamptz null;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'point_transactions_pending_release_chk') then
    alter table public.point_transactions
      add constraint point_transactions_pending_release_chk check (status <> 'pending' or release_at is not null);
  end if;
end $$;

-- the only rows the scheduled job and the balance reads ever look at
create index if not exists point_transactions_pending_idx
  on public.point_transactions (release_at)
  where status = 'pending';

-- ---------------------------------------------------------------------------
-- 3. apply_points_earn() — the single place an earn is recorded.
--    Locked for every role: only the SECURITY DEFINER functions below call it.
-- ---------------------------------------------------------------------------
create or replace function public.apply_points_earn(
  p_user_id uuid,
  p_merchant_id uuid,
  p_branch_id uuid,
  p_device_id uuid,
  p_invoice_id uuid,
  p_points integer,
  p_rate numeric,
  p_source text,
  p_invoice_at timestamptz
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_hold integer;
  v_release timestamptz;
  v_pending boolean := false;
begin
  select coalesce(points_hold_days, 0) into v_hold from public.merchants where id = p_merchant_id;

  if coalesce(v_hold, 0) > 0 then
    v_release := p_invoice_at + make_interval(days => v_hold);
    v_pending := v_release > now();
  end if;

  if v_pending then
    -- the merchant must still appear in the customer's loyalty list, but the
    -- AVAILABLE balance is untouched until release_pending_points() runs
    insert into public.merchant_loyalty (user_id, merchant_id, points)
    values (p_user_id, p_merchant_id, 0)
    on conflict (user_id, merchant_id) do nothing;

    insert into public.point_transactions
      (user_id, merchant_id, branch_id, device_id, type, points_delta, points_rate_applied,
       invoice_id, source, status, release_at)
    values
      (p_user_id, p_merchant_id, p_branch_id, p_device_id, 'earn', p_points, p_rate,
       p_invoice_id, p_source, 'pending', v_release);
  else
    insert into public.merchant_loyalty (user_id, merchant_id, points)
    values (p_user_id, p_merchant_id, p_points)
    on conflict (user_id, merchant_id)
    do update set points = public.merchant_loyalty.points + excluded.points, updated_at = now();

    insert into public.point_transactions
      (user_id, merchant_id, branch_id, device_id, type, points_delta, points_rate_applied,
       invoice_id, source)
    values
      (p_user_id, p_merchant_id, p_branch_id, p_device_id, 'earn', p_points, p_rate,
       p_invoice_id, p_source);
  end if;
end;
$$;

revoke all on function public.apply_points_earn(uuid, uuid, uuid, uuid, uuid, integer, numeric, text, timestamptz)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. release_pending_points() — pending → available once due.
-- ---------------------------------------------------------------------------
create or replace function public.release_pending_points() returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_released integer;
begin
  with due as (
    update public.point_transactions
    set status = 'available'
    where status = 'pending' and release_at <= now()
    returning user_id, merchant_id, points_delta
  ),
  per as (
    select user_id, merchant_id, sum(points_delta)::integer as pts
    from due
    group by user_id, merchant_id
  ),
  bump as (
    insert into public.merchant_loyalty (user_id, merchant_id, points)
    select user_id, merchant_id, pts from per
    on conflict (user_id, merchant_id)
    do update set points = public.merchant_loyalty.points + excluded.points, updated_at = now()
    returning 1
  )
  select count(*)::integer into v_released from due;

  return v_released;
end;
$$;

revoke all on function public.release_pending_points() from public, anon, authenticated, service_role;

-- Same defensive pattern as the purge job in supabase-migration-pos-
-- transactions.sql: pg_cron may need enabling from the dashboard (Database →
-- Extensions) or be absent locally; the function works standalone either way.
do $$
begin
  create extension if not exists pg_cron;

  if exists (select 1 from cron.job where jobname = 'release-pending-points') then
    perform cron.unschedule('release-pending-points');
  end if;
  perform cron.schedule(
    'release-pending-points',
    '*/15 * * * *',
    $sql$select public.release_pending_points();$sql$
  );
exception when others then
  raise notice 'pg_cron not available/enabled in this environment — enable it from the dashboard (Database → Extensions) and schedule release_pending_points() every 15 minutes there. (%)', sqlerrm;
end $$;

-- ---------------------------------------------------------------------------
-- 5. kiosk_claim_pos_transaction(): same checks/flow as supabase-migration-
--    pos-connections.sql; the balance + ledger step now goes through
--    apply_points_earn(), and prev/total shown to the kiosk include pending.
--    (Pending is 0 for hold_days = 0 merchants → identical numbers as before.)
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
  v_pending integer;
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

    select coalesce(sum(points_delta), 0)::integer into v_pending from public.point_transactions
    where user_id = v_profile_id and merchant_id = v_merchant.id and status = 'pending';

    insert into public.invoices (user_id, merchant_id, branch_id, amount, vat, category, points_earned, status, source, external_ref)
    values (v_profile_id, v_merchant.id, v_branch.id, v_txn.amount, v_txn.vat, v_merchant.type, v_added, 'paid', 'pos', v_txn.external_ref)
    returning id into v_invoice_id;

    perform public.apply_points_earn(
      v_profile_id, v_merchant.id, v_branch.id, v_device.id, v_invoice_id,
      v_added, coalesce(v_merchant.points_rate, 0), 'pos', now());

    update public.pos_transactions
    set status = 'applied', applied_at = now(), invoice_id = v_invoice_id
    where id = v_txn.id;

    return query select true, v_profile_id, v_prev + v_pending, v_added, v_prev + v_pending + v_added, v_invoice_id;
  else
    insert into public.unclaimed_customers (phone, last_invoice_at) values (v_phone, now())
    on conflict (phone) do update set last_invoice_at = now();

    insert into public.invoices (pending_phone, merchant_id, branch_id, amount, vat, category, points_earned, status, source, external_ref)
    values (v_phone, v_merchant.id, v_branch.id, v_txn.amount, v_txn.vat, v_merchant.type, v_added, 'paid', 'pos', v_txn.external_ref)
    returning id into v_invoice_id;

    update public.pos_transactions
    set status = 'applied', applied_at = now(), invoice_id = v_invoice_id
    where id = v_txn.id;

    return query select false, null::uuid, null::integer, v_added, null::integer, v_invoice_id;
  end if;
end;
$$;

revoke execute on function public.kiosk_claim_pos_transaction(uuid, text) from public, anon;
grant execute on function public.kiosk_claim_pos_transaction(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 6. claim_unclaimed_invoices(): same checks and result as before (moves every
--    invoice saved under the caller's own VERIFIED phone, one earn per
--    invoice, then drops the unclaimed row). The set-based CTE became a loop
--    so each invoice goes through apply_points_earn() with ITS OWN original
--    created_at — that is what keeps the hold clock on the invoice date.
--    Ledger rows keep NULL branch/rate exactly like the previous version.
--    REFUND-AWARE ON PURPOSE (same body as supabase-migration-pos-refunds.sql,
--    which owns the refund logic): an invoice partially refunded while its
--    customer was still unregistered earns round(points × remaining share),
--    a fully refunded one earns nothing. The body is deliberately IDENTICAL
--    in both files — this function is redefined by whichever file runs last,
--    so re-running THIS file after the refunds one must not silently revert
--    it to a version that grants the full points. db-tests assert the two
--    bodies stay identical in either order.
-- ---------------------------------------------------------------------------
create or replace function public.claim_unclaimed_invoices() returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_profile public.profiles;
  v_phone text;
  v_claimed_count integer := 0;
  v_refunded numeric;
  v_points integer;
  r record;
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

  for r in
    select id, merchant_id, points_earned, created_at, amount, status, refunded_amount
    from public.invoices
    where pending_phone = v_phone
    order by created_at, id
    for update
  loop
    update public.invoices
    set user_id = v_profile.id, pending_phone = null
    where id = r.id;

    v_refunded := case when r.status = 'refunded' then r.amount else coalesce(r.refunded_amount, 0) end;

    if v_refunded = 0 then
      perform public.apply_points_earn(
        v_profile.id, r.merchant_id, null, null, r.id,
        r.points_earned, null, 'pos', r.created_at);
    else
      v_points := case when v_refunded >= r.amount then 0
                       else round(r.points_earned::numeric * (r.amount - v_refunded) / r.amount)::integer end;
      if v_points > 0 then
        perform public.apply_points_earn(
          v_profile.id, r.merchant_id, null, null, r.id,
          v_points, null, 'pos', r.created_at);
      end if;
    end if;

    v_claimed_count := v_claimed_count + 1;
  end loop;

  delete from public.unclaimed_customers where phone = v_phone;

  return v_claimed_count;
end;
$$;

revoke execute on function public.claim_unclaimed_invoices() from public, anon;
grant execute on function public.claim_unclaimed_invoices() to authenticated;

-- ---------------------------------------------------------------------------
-- 7. kiosk_earn_points() (demo): same as supabase-migration-kiosk-device-
--    auth.sql, balance/ledger step through apply_points_earn().
-- ---------------------------------------------------------------------------
create or replace function public.kiosk_earn_points(p_phone text, p_amount numeric, p_category text default null)
returns table(profile_id uuid, prev_points integer, added_points integer, total_points integer, invoice_id uuid)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_device public.devices;
  v_branch public.branches;
  v_settings public.branch_settings;
  v_merchant public.merchants;
  v_phone text;
  v_profile_id uuid;
  v_added integer;
  v_prev integer;
  v_pending integer;
  v_invoice_id uuid;
begin
  select * into v_device from public.devices
  where auth_user_id = auth.uid() and is_active and revoked_at is null;

  if v_device.id is null or v_device.branch_id is null then
    raise exception 'الجهاز غير مقارَن بفرع بعد';
  end if;

  select * into v_settings from public.branch_settings where branch_id = v_device.branch_id;
  if not coalesce(v_settings.demo_earn_enabled, false) then
    raise exception 'الوضع التجريبي لاحتساب النقاط غير مُفعَّل لهذا الفرع';
  end if;

  select * into v_branch from public.branches where id = v_device.branch_id;
  select * into v_merchant from public.merchants where id = v_branch.merchant_id;

  v_phone := public.normalize_sa_phone(p_phone);
  if v_phone is null then
    raise exception 'رقم جوال غير صحيح';
  end if;

  if p_amount is null or p_amount <= 0 then
    raise exception 'مبلغ غير صالح';
  end if;

  select id into v_profile_id from public.profiles where phone = v_phone and deleted_at is null;
  if v_profile_id is null then
    raise exception 'NOJ_CUSTOMER_NOT_FOUND';
  end if;

  v_added := round(p_amount * v_merchant.points_rate)::integer;

  insert into public.merchant_loyalty (user_id, merchant_id, points)
  values (v_profile_id, v_merchant.id, 0)
  on conflict (user_id, merchant_id) do nothing;

  select points into v_prev from public.merchant_loyalty
  where user_id = v_profile_id and merchant_id = v_merchant.id
  for update;

  select coalesce(sum(points_delta), 0)::integer into v_pending from public.point_transactions
  where user_id = v_profile_id and merchant_id = v_merchant.id and status = 'pending';

  insert into public.invoices (user_id, merchant_id, amount, vat, category, points_earned, status, source)
  values (v_profile_id, v_merchant.id, p_amount, 0, coalesce(p_category, v_merchant.type), v_added, 'paid', 'demo')
  returning id into v_invoice_id;

  perform public.apply_points_earn(
    v_profile_id, v_merchant.id, v_branch.id, v_device.id, v_invoice_id,
    v_added, v_merchant.points_rate, 'demo', now());

  return query select v_profile_id, v_prev + v_pending, v_added, v_prev + v_pending + v_added, v_invoice_id;
end;
$$;

revoke execute on function public.kiosk_earn_points(text, numeric, text) from public, anon;
grant execute on function public.kiosk_earn_points(text, numeric, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 8. kiosk_lookup_customer_points(): available + pending (see header, item 5).
-- ---------------------------------------------------------------------------
create or replace function public.kiosk_lookup_customer_points(p_phone text)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_device public.devices;
  v_branch public.branches;
  v_phone text;
  v_profile_id uuid;
  v_points integer;
  v_pending integer;
begin
  select * into v_device from public.devices
  where auth_user_id = auth.uid() and is_active and revoked_at is null;

  if v_device.id is null or v_device.branch_id is null then
    raise exception 'الجهاز غير مقارَن بفرع بعد';
  end if;

  select * into v_branch from public.branches where id = v_device.branch_id;

  v_phone := public.normalize_sa_phone(p_phone);
  if v_phone is null then
    raise exception 'رقم جوال غير صحيح';
  end if;

  select id into v_profile_id from public.profiles where phone = v_phone and deleted_at is null;
  if v_profile_id is null then
    raise exception 'NOJ_CUSTOMER_NOT_FOUND';
  end if;

  select points into v_points from public.merchant_loyalty
  where user_id = v_profile_id and merchant_id = v_branch.merchant_id;

  select coalesce(sum(points_delta), 0)::integer into v_pending from public.point_transactions
  where user_id = v_profile_id and merchant_id = v_branch.merchant_id and status = 'pending';

  return coalesce(v_points, 0) + v_pending;
end;
$$;

revoke execute on function public.kiosk_lookup_customer_points(text) from public, anon;
grant execute on function public.kiosk_lookup_customer_points(text) to authenticated;
