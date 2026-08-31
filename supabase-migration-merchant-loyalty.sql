-- ============================================================================
-- NOJ — migration: per-merchant loyalty points
-- ============================================================================
-- Fixes a real bug: loyalty points were stored as ONE aggregated balance on
-- profiles.loyalty_points, shared across every merchant. That meant points
-- earned at a coffee shop could be redeemed for a reward at a clinic —
-- merchants do not actually share a points pool. This migration adds a
-- proper per-(user, merchant) balance table and repoints redeem_reward at
-- it, instead of the old shared column.
--
-- This file is ADDITIVE ONLY:
--   - no existing table is dropped
--   - no existing row is deleted or modified
--   - profiles.loyalty_points and profiles.tier are left in place untouched
--     (index.html no longer reads or writes them after this migration —
--     they're just unused now; drop them yourself later if you want to,
--     this migration deliberately does not)
--
-- Run this ONCE in the Supabase SQL Editor, AFTER supabase-schema.sql has
-- already been applied. It is also safe to run more than once (every
-- statement is idempotent) — it will not duplicate the seed rows or error
-- on a second run.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Table: one row per (user, merchant) balance
-- ---------------------------------------------------------------------------
create table if not exists public.merchant_loyalty (
  user_id uuid not null references public.profiles(id) on delete cascade,
  merchant_id uuid not null references public.merchants(id) on delete cascade,
  points integer not null default 0 check (points >= 0),
  tier text not null default 'برونزي' check (tier in ('برونزي','فضي','ذهبي','بلاتيني')),
  updated_at timestamptz not null default now(),
  primary key (user_id, merchant_id)
);

create index if not exists merchant_loyalty_user_id_idx on public.merchant_loyalty(user_id);

-- ---------------------------------------------------------------------------
-- 2. RLS — same pattern as every other per-user table in supabase-schema.sql:
--    a session can only ever see/touch the rows belonging to the profile it
--    has claimed (profiles.auth_user_id = auth.uid()).
-- ---------------------------------------------------------------------------
alter table public.merchant_loyalty enable row level security;

drop policy if exists "select own merchant loyalty" on public.merchant_loyalty;
create policy "select own merchant loyalty"
  on public.merchant_loyalty for select
  using (exists (
    select 1 from public.profiles p
    where p.id = merchant_loyalty.user_id and p.auth_user_id = auth.uid()
  ));

-- update (not insert/delete) is granted directly because redeem_reward()
-- below runs SECURITY INVOKER — it executes with the caller's own RLS
-- context, deducting points from a row that must already exist (seeded, or
-- created by whatever future process awards points from a real purchase).
drop policy if exists "update own merchant loyalty" on public.merchant_loyalty;
create policy "update own merchant loyalty"
  on public.merchant_loyalty for update
  using (exists (
    select 1 from public.profiles p
    where p.id = merchant_loyalty.user_id and p.auth_user_id = auth.uid()
  ));

grant select, update on public.merchant_loyalty to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. Replace redeem_reward(): now deducts from the caller's balance at the
--    SPECIFIC merchant that owns the reward (via rewards.merchant_id, which
--    already existed), instead of the old shared profiles.loyalty_points
--    column. The function's return type changes (public.merchant_loyalty
--    instead of public.profiles), so the old function must be dropped first
--    — `create or replace` cannot change a return type in place. Dropping a
--    function definition does not touch any table data.
--
--    Still SECURITY INVOKER, for the same reason noted in
--    supabase-schema.sql: the caller only ever reads/writes their own
--    already-claimed rows, which RLS enforces on its own.
-- ---------------------------------------------------------------------------
drop function if exists public.redeem_reward(uuid);

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

  -- unchanged: redemptions still just records reward_id, which already
  -- identifies the merchant via rewards.merchant_id.
  insert into public.redemptions (user_id, reward_id)
  values (v_profile_id, p_reward_id);

  return v_row;
end;
$$;

grant execute on function public.redeem_reward(uuid) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. Seed per-merchant balances for the existing demo profile (phone
--    512345678 / id 11111111-1111-1111-1111-111111111111), so the demo
--    shows realistic, INDEPENDENT per-merchant balances instead of the old
--    single shared 1,250-point pool. Chosen so at least one merchant with
--    each active reward has enough points to redeem it, to demonstrate the
--    feature. Adjust freely — these numbers are not derived from anything.
-- ---------------------------------------------------------------------------
insert into public.merchant_loyalty (user_id, merchant_id, points, tier) values
  ('11111111-1111-1111-1111-111111111111', '20000000-0000-0000-0000-000000000001', 420, 'ذهبي'),    -- مطعم مذاق
  ('11111111-1111-1111-1111-111111111111', '20000000-0000-0000-0000-000000000002', 260, 'فضي'),     -- بنده
  ('11111111-1111-1111-1111-111111111111', '20000000-0000-0000-0000-000000000003', 240, 'فضي'),     -- ستاربكس
  ('11111111-1111-1111-1111-111111111111', '20000000-0000-0000-0000-000000000004', 85,  'برونزي'),  -- صيدلية النهدي
  ('11111111-1111-1111-1111-111111111111', '20000000-0000-0000-0000-000000000005', 175, 'فضي'),     -- أوبر
  ('11111111-1111-1111-1111-111111111111', '20000000-0000-0000-0000-000000000006', 40,  'برونزي'),  -- مقهى بارز
  ('11111111-1111-1111-1111-111111111111', '20000000-0000-0000-0000-000000000007', 95,  'برونزي'),  -- برجر بوينت
  ('11111111-1111-1111-1111-111111111111', '20000000-0000-0000-0000-000000000008', 130, 'فضي'),     -- كارفور
  ('11111111-1111-1111-1111-111111111111', '20000000-0000-0000-0000-000000000009', 60,  'برونزي'),  -- كوستا
  ('11111111-1111-1111-1111-111111111111', '2000000a-0000-0000-0000-00000000000a', 55,  'برونزي'),  -- كريم
  ('11111111-1111-1111-1111-111111111111', '2000000b-0000-0000-0000-00000000000b', 45,  'برونزي')   -- صيدلية الدواء
on conflict (user_id, merchant_id) do nothing;
