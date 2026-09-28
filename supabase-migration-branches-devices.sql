-- ============================================================================
-- NOJ — migration: branches + devices + per-branch kiosk settings
-- ============================================================================
-- Adds the structure needed to move kiosk.html's settings (merchant name,
-- logo, sector, card toggles, menu images, dark mode...) from the browser's
-- localStorage into Supabase, and to let a merchant pair one or more
-- physical tablets.
--
-- DECISION (approved 2026-09): public.merchants stays EXACTLY as it is —
-- one flat row per physical location, as index.html already reads it.
-- Nothing new here reads or writes public.merchants' existing columns, and
-- no existing row/column is touched. Instead:
--
--   - public.branches is a new table, ONE ROW PER EXISTING MERCHANT ROW,
--     auto-created below (backfill) and kept auto-synced for every FUTURE
--     merchants insert/update via a trigger — never a manual step.
--   - Every new table this file adds (devices, branch_settings) and every
--     future migration (point_transactions, etc.) reference branches.id,
--     never merchants.id directly.
--
-- Why: this makes "a merchant can have more than one real branch" a change
-- to DATA later (insert more branches rows under the same merchant_id) —
-- not a change to any code that already shipped against branches.id. If
-- that day comes, the auto-sync trigger below is simply left in place for
-- merchants that still want 1 branch = 1 merchant row, and additional
-- branches are inserted by hand (or by a future onboarding flow) for the
-- ones that don't.
--
-- ADDITIVE / SAFE: no existing table, column, or row is altered or dropped.
-- Run this ONCE in the Supabase SQL Editor, after supabase-schema.sql and
-- every existing supabase-migration-*.sql. Safe to run more than once.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. branches — mirrors public.merchants today; independent rows later
-- ---------------------------------------------------------------------------
create table if not exists public.branches (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references public.merchants(id) on delete cascade,
  name text not null,
  created_at timestamptz not null default now()
);

create index if not exists branches_merchant_id_idx on public.branches(merchant_id);

-- Backfill: one branches row per EXISTING merchants row. The branch's id is
-- deliberately set equal to the merchant's own id — not a new random uuid —
-- so this first, auto-mirrored branch has an obvious, stable identity
-- ("the branches row for merchant X is just id = X") for as long as a
-- merchant has exactly one branch. Any SECOND branch added later (under the
-- option-B future) gets its own fresh random id like any normal insert.
insert into public.branches (id, merchant_id, name, created_at)
select m.id, m.id, coalesce(m.branch, m.name), m.created_at
from public.merchants m
where not exists (select 1 from public.branches b where b.id = m.id);

-- Keep it that way automatically for every future merchants row — "لا تترك
-- المزامنة يدوية". Fires on insert (mirror a brand-new merchant) and on
-- update of name/branch (keep the label in sync); never touches anything
-- else about the merchants row itself.
create or replace function public.sync_branch_from_merchant() returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    insert into public.branches (id, merchant_id, name, created_at)
    values (new.id, new.id, coalesce(new.branch, new.name), new.created_at)
    on conflict (id) do nothing;
  elsif tg_op = 'UPDATE' then
    update public.branches
    set name = coalesce(new.branch, new.name)
    where id = new.id;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_sync_branch_from_merchant on public.merchants;
create trigger trg_sync_branch_from_merchant
after insert or update of name, branch on public.merchants
for each row execute function public.sync_branch_from_merchant();

-- ---------------------------------------------------------------------------
-- 2. branch_settings — one row per branch, replaces kiosk.html's
--    localStorage. Every branch always has exactly one settings row,
--    auto-created the moment the branch itself exists (below), regardless
--    of whether that branch came from the merchants-mirror above or a real
--    second-branch insert later.
-- ---------------------------------------------------------------------------
create table if not exists public.branch_settings (
  branch_id uuid primary key references public.branches(id) on delete cascade,
  dark_mode boolean not null default false,
  show_menu_btn boolean not null default true,
  card_toggles jsonb not null default '{}'::jsonb,
  menu_images jsonb not null default '[]'::jsonb,
  pos_mode text not null default 'demo' check (pos_mode in ('demo','live')),
  updated_at timestamptz not null default now()
);

create or replace function public.ensure_branch_settings() returns trigger
language plpgsql
set search_path = public
as $$
begin
  insert into public.branch_settings (branch_id) values (new.id)
  on conflict (branch_id) do nothing;
  return new;
end;
$$;

drop trigger if exists trg_ensure_branch_settings on public.branches;
create trigger trg_ensure_branch_settings
after insert on public.branches
for each row execute function public.ensure_branch_settings();

-- backfill for the branches rows inserted above, earlier in this same file,
-- before the trigger existed to catch them.
insert into public.branch_settings (branch_id)
select id from public.branches b
where not exists (select 1 from public.branch_settings s where s.branch_id = b.id);

-- ---------------------------------------------------------------------------
-- 3. devices — one row per paired physical tablet
-- ---------------------------------------------------------------------------
create table if not exists public.devices (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references public.branches(id) on delete cascade,
  label text not null default 'تابلت',
  pairing_code text unique,
  is_active boolean not null default true,
  revoked_at timestamptz,
  -- hashed, never the plaintext refresh secret itself — see the device-auth
  -- design note in the RLS section below for why a short-lived JWT +
  -- long-lived hashed refresh token is the intended shape, not one static
  -- long-lived JWT.
  refresh_token_hash text,
  last_seen_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists devices_branch_id_idx on public.devices(branch_id);

-- ---------------------------------------------------------------------------
-- 4. merchant_members — maps a real Supabase Auth user to the merchant(s)
--    they administer. Needed for the RLS policies below even before any
--    dashboard UI exists to sign such users up; provisioning a row here is
--    an admin/service-role action for now (no self-serve signup yet).
-- ---------------------------------------------------------------------------
create table if not exists public.merchant_members (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references public.merchants(id) on delete cascade,
  auth_user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'owner' check (role in ('owner','staff')),
  created_at timestamptz not null default now(),
  unique (merchant_id, auth_user_id)
);

create index if not exists merchant_members_auth_user_id_idx on public.merchant_members(auth_user_id);

-- ---------------------------------------------------------------------------
-- 5. RLS — merchant staff can only ever see/touch their own merchant's
--    branches/settings/devices. Devices themselves do not authenticate as a
--    normal Supabase Auth user yet (see file header) — that access/refresh
--    JWT design is DEFERRED, so there is deliberately no device-side policy
--    here yet. Nothing in this file grants a device any access at all.
-- ---------------------------------------------------------------------------
alter table public.branches enable row level security;
alter table public.branch_settings enable row level security;
alter table public.devices enable row level security;
alter table public.merchant_members enable row level security;

drop policy if exists "merchant staff can select their branches" on public.branches;
create policy "merchant staff can select their branches"
  on public.branches for select
  using (exists (
    select 1 from public.merchant_members mm
    where mm.merchant_id = branches.merchant_id and mm.auth_user_id = auth.uid()
  ));

drop policy if exists "merchant staff can select their branch settings" on public.branch_settings;
create policy "merchant staff can select their branch settings"
  on public.branch_settings for select
  using (exists (
    select 1 from public.branches b
    join public.merchant_members mm on mm.merchant_id = b.merchant_id
    where b.id = branch_settings.branch_id and mm.auth_user_id = auth.uid()
  ));

drop policy if exists "merchant staff can update their branch settings" on public.branch_settings;
create policy "merchant staff can update their branch settings"
  on public.branch_settings for update
  using (exists (
    select 1 from public.branches b
    join public.merchant_members mm on mm.merchant_id = b.merchant_id
    where b.id = branch_settings.branch_id and mm.auth_user_id = auth.uid()
  ));

drop policy if exists "merchant staff can select their devices" on public.devices;
create policy "merchant staff can select their devices"
  on public.devices for select
  using (exists (
    select 1 from public.branches b
    join public.merchant_members mm on mm.merchant_id = b.merchant_id
    where b.id = devices.branch_id and mm.auth_user_id = auth.uid()
  ));

drop policy if exists "merchant staff can manage their devices" on public.devices;
create policy "merchant staff can manage their devices"
  on public.devices for update
  using (exists (
    select 1 from public.branches b
    join public.merchant_members mm on mm.merchant_id = b.merchant_id
    where b.id = devices.branch_id and mm.auth_user_id = auth.uid()
  ));

drop policy if exists "members can see their own memberships" on public.merchant_members;
create policy "members can see their own memberships"
  on public.merchant_members for select
  using (auth_user_id = auth.uid());

grant usage on schema public to anon, authenticated;
grant select on public.branches to anon, authenticated;
grant select, update on public.branch_settings to anon, authenticated;
grant select, update on public.devices to anon, authenticated;
grant select on public.merchant_members to anon, authenticated;
