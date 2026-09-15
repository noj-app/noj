-- ============================================================================
-- NOJ — migration: point_transactions (the auditable ledger)
-- ============================================================================
-- public.merchant_loyalty.points is a balance with no history — it cannot
-- answer "why does this customer have 260 points" when they dispute it with
-- a merchant. This file adds the ledger and wires the one existing function
-- that changes a balance (redeem_reward) to write to it in the SAME
-- transaction, so the ledger and the balance can never drift apart.
--
-- Requires supabase-migration-branches-devices.sql to already be applied
-- (point_transactions.branch_id/device_id reference it).
--
-- ADDITIVE / SAFE: no existing table/column/row is altered or dropped.
-- redeem_reward()'s signature and return type are unchanged (create or
-- replace in place, no drop needed). Run this ONCE, after
-- supabase-migration-branches-devices.sql. Safe to run more than once.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. point_transactions
-- ---------------------------------------------------------------------------
create table if not exists public.point_transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  merchant_id uuid not null references public.merchants(id) on delete cascade,
  -- where it physically happened — nullable because most existing/near-term
  -- earning still comes through invoices with no branch granularity, and
  -- because a merchant with exactly one branch gets no real benefit from
  -- requiring it. Filled in once kiosks post directly.
  branch_id uuid references public.branches(id) on delete set null,
  device_id uuid references public.devices(id) on delete set null,
  type text not null check (type in ('opening_balance','earn','redeem','adjust')),
  points_delta integer not null,
  -- the merchant's points_rate AT THE MOMENT this row was created — a
  -- permanent snapshot, so changing merchants.points_rate later can never
  -- change what an old transaction says it used. Nullable: redeem/adjust
  -- rows don't have a "rate" (nothing was converted from an amount).
  points_rate_applied numeric(10,4),
  invoice_id uuid references public.invoices(id) on delete set null,
  reward_id uuid references public.rewards(id) on delete set null,
  source text not null default 'system'
    check (source in ('system','backfill','kiosk_manual','app_session','pos','admin')),
  -- for future POS integration: the POS's own id for whatever event created
  -- this row, so a retried webhook can be recognized and skipped instead of
  -- double-counting. Uniqueness is enforced per-merchant on invoices (see
  -- below), not here — a single POS event can still touch one
  -- point_transactions row.
  external_ref text,
  created_at timestamptz not null default now(),
  -- accounting sanity: earning is never negative, redemption is never
  -- positive. opening_balance/adjust may be either sign (a correction can
  -- go either way).
  constraint point_transactions_sign_chk check (
    (type = 'earn'   and points_delta >= 0) or
    (type = 'redeem' and points_delta <= 0) or
    (type in ('opening_balance', 'adjust'))
  )
);

create index if not exists point_transactions_user_merchant_idx
  on public.point_transactions(user_id, merchant_id);
create index if not exists point_transactions_merchant_id_idx
  on public.point_transactions(merchant_id);
create index if not exists point_transactions_created_at_idx
  on public.point_transactions(created_at desc);

-- ---------------------------------------------------------------------------
-- 2. Backfill: one opening_balance row per EXISTING merchant_loyalty row, so
--    no balance starts from an unexplained void. Guarded by a NOT EXISTS
--    check (point_transactions.id has no natural business key to conflict
--    on) so re-running this file never duplicates these rows.
-- ---------------------------------------------------------------------------
insert into public.point_transactions
  (user_id, merchant_id, type, points_delta, source, created_at)
select ml.user_id, ml.merchant_id, 'opening_balance', ml.points, 'backfill', ml.updated_at
from public.merchant_loyalty ml
where not exists (
  select 1 from public.point_transactions pt
  where pt.user_id = ml.user_id
    and pt.merchant_id = ml.merchant_id
    and pt.type = 'opening_balance'
);

-- ---------------------------------------------------------------------------
-- 3. RLS — same "only your own claimed profile's rows" pattern as every
--    other per-user table in this app.
-- ---------------------------------------------------------------------------
alter table public.point_transactions enable row level security;

drop policy if exists "select own point transactions" on public.point_transactions;
create policy "select own point transactions"
  on public.point_transactions for select
  using (exists (
    select 1 from public.profiles p
    where p.id = point_transactions.user_id and p.auth_user_id = auth.uid()
  ));

-- redeem_reward() below is SECURITY INVOKER (deliberately — see its own
-- comment), so its ledger insert runs with the CALLER's own privileges and
-- needs a real grant + policy, same as the existing "insert own
-- redemptions" policy on public.redemptions already does for that table.
-- Scoped to type='redeem' ONLY, and only for the caller's own claimed
-- profile: a client can never insert an 'earn'/'opening_balance'/'adjust'
-- row this way, and a 'redeem' row here still requires whatever future
-- function/trigger validates the balance — this policy only says WHO may
-- attempt the insert, not that it is unconditionally trusted.
drop policy if exists "insert own redeem transactions" on public.point_transactions;
create policy "insert own redeem transactions"
  on public.point_transactions for insert
  with check (
    type = 'redeem'
    and exists (
      select 1 from public.profiles p
      where p.id = point_transactions.user_id and p.auth_user_id = auth.uid()
    )
  );

-- no update/delete policy for anon/authenticated at all, and no insert
-- policy for any other transaction type: 'earn'/'opening_balance'/'adjust'
-- rows are written only by a SECURITY DEFINER function or an admin/service
-- role, never directly by client code.
grant select, insert on public.point_transactions to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. redeem_reward(): unchanged signature/behavior from the customer's
--    point of view, but now writes the ledger row in the SAME transaction
--    as the balance deduction — one commits, or neither does.
-- ---------------------------------------------------------------------------
create or replace function public.redeem_reward(p_reward_id uuid)
returns public.merchant_loyalty
language plpgsql
security invoker
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

  insert into public.point_transactions
    (user_id, merchant_id, type, points_delta, reward_id, source)
  values
    (v_profile_id, v_merchant_id, 'redeem', -v_cost, p_reward_id, 'app_session');

  return v_row;
end;
$$;

grant execute on function public.redeem_reward(uuid) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 5. Idempotency for future POS invoices: a POS retrying a webhook must
--    never double-count the same invoice. external_ref/source do not exist
--    on invoices yet (added here, both nullable — every existing row simply
--    has neither, which is correct: we don't know how they were created).
--    Postgres treats each NULL as distinct under a plain UNIQUE constraint,
--    so this is a no-op for all current data and only bites once POS
--    integration starts populating both columns.
-- ---------------------------------------------------------------------------
alter table public.invoices add column if not exists source text check (source in ('manual','pos'));
alter table public.invoices add column if not exists external_ref text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'invoices_merchant_external_ref_uniq') then
    alter table public.invoices
      add constraint invoices_merchant_external_ref_uniq unique (merchant_id, external_ref);
  end if;
end $$;
