-- ============================================================================
-- NOJ — Supabase schema, RLS policies, RPC functions, and demo seed data
-- ============================================================================
-- Run this whole file once in the Supabase SQL Editor (or via the CLI) on a
-- fresh project. It is safe to re-run: every object is dropped first.
--
-- After running this file, you must also enable "Anonymous Sign-ins" under
-- Authentication → Sign In / Providers in the Supabase dashboard — the app
-- relies on it (see README.md, "إعداد Supabase" section, for the full list
-- of manual steps and why anonymous auth is required here).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 0. Clean slate (safe to re-run)
-- ---------------------------------------------------------------------------
drop function if exists public.redeem_reward(uuid);
drop function if exists public.claim_or_create_profile(text);
drop table if exists public.redemptions;
drop table if exists public.rewards;
drop table if exists public.queue_tickets;
drop table if exists public.invoices;
drop table if exists public.merchants;
drop table if exists public.profiles;

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- 1. Tables
-- ---------------------------------------------------------------------------

-- profiles: one row per NOJ customer.
--
-- `auth_user_id` is not part of the column list the product spec asked for,
-- but it is the minimal addition needed to make RLS genuinely enforce
-- "no user can read another user's data" while the app's login stays the
-- demo phone+OTP flow (no real SMS provider). It links a profile to a real,
-- anonymous Supabase Auth session (see claim_or_create_profile below) — the
-- one thing Postgres RLS can actually check per request via auth.uid().
-- Without it, RLS would have nothing legitimate to key on and would either
-- block everyone or be security theatre.
create table public.profiles (
  id uuid primary key default gen_random_uuid(),
  auth_user_id uuid unique references auth.users(id) on delete set null,
  phone text unique not null,
  name text not null default 'عميل NOJ',
  loyalty_points integer not null default 0 check (loyalty_points >= 0),
  tier text not null default 'برونزي' check (tier in ('برونزي','فضي','ذهبي','بلاتيني')),
  created_at timestamptz not null default now()
);

-- merchants: the businesses connected to NOJ.
create table public.merchants (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  branch text,
  type text not null,        -- matches an invoices.category value, e.g. 'مطاعم'
  logo_color text not null,  -- hex color used to tint the merchant's icon in the UI
  created_at timestamptz not null default now()
);

-- invoices: one row per purchase.
create table public.invoices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  merchant_id uuid not null references public.merchants(id) on delete restrict,
  amount numeric(10,2) not null check (amount >= 0),
  vat numeric(10,2) not null default 0 check (vat >= 0),
  category text not null,
  items jsonb not null default '[]'::jsonb,
  points_earned integer not null default 0,
  status text not null default 'paid' check (status in ('paid','pending','refunded')),
  created_at timestamptz not null default now()
);

-- queue_tickets: smart-waiting tickets.
create table public.queue_tickets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  merchant_id uuid not null references public.merchants(id) on delete cascade,
  ticket_number integer not null,
  unit_name text,
  position integer not null default 0,
  est_minutes integer not null default 0,
  status text not null default 'waiting' check (status in ('waiting','called','done','cancelled')),
  created_at timestamptz not null default now()
);

-- rewards: a merchant's loyalty catalog.
create table public.rewards (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references public.merchants(id) on delete cascade,
  title text not null,
  cost_points integer not null check (cost_points > 0),
  active boolean not null default true,
  created_at timestamptz not null default now()
);

-- redemptions: history of rewards a user has claimed.
create table public.redemptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  reward_id uuid not null references public.rewards(id) on delete restrict,
  redeemed_at timestamptz not null default now()
);

create index invoices_user_id_idx on public.invoices(user_id);
create index invoices_created_at_idx on public.invoices(created_at desc);
create index queue_tickets_user_id_idx on public.queue_tickets(user_id);
create index redemptions_user_id_idx on public.redemptions(user_id);
create index profiles_auth_user_id_idx on public.profiles(auth_user_id);
create index profiles_phone_idx on public.profiles(phone);

-- ---------------------------------------------------------------------------
-- 2. Row Level Security — no user can ever read or change another user's data
-- ---------------------------------------------------------------------------
alter table public.profiles enable row level security;
alter table public.merchants enable row level security;
alter table public.invoices enable row level security;
alter table public.queue_tickets enable row level security;
alter table public.rewards enable row level security;
alter table public.redemptions enable row level security;

-- profiles: a session can only ever see/change the profile it has claimed
-- (auth_user_id = auth.uid()). The update policy additionally allows
-- claiming an *unclaimed* seeded profile (auth_user_id is null) — but only
-- to set it to the caller's own uid (see the with check clause), never to
-- someone else's. In practice the app calls claim_or_create_profile()
-- instead of touching this table directly, but these policies still apply
-- to that function's internal queries and to any direct client call.
create policy "select own profile"
  on public.profiles for select
  using (auth_user_id = auth.uid());

create policy "claim or update own profile"
  on public.profiles for update
  using (auth_user_id = auth.uid() or auth_user_id is null)
  with check (auth_user_id = auth.uid());

create policy "insert own profile"
  on public.profiles for insert
  with check (auth_user_id = auth.uid());

-- merchants & active rewards: public catalog data, readable by anyone,
-- writable by no one from the client (no insert/update/delete policies).
create policy "merchants are publicly readable"
  on public.merchants for select
  using (true);

create policy "active rewards are publicly readable"
  on public.rewards for select
  using (active = true);

-- invoices: only the rows belonging to the caller's own claimed profile.
create policy "select own invoices"
  on public.invoices for select
  using (exists (
    select 1 from public.profiles p
    where p.id = invoices.user_id and p.auth_user_id = auth.uid()
  ));

-- queue_tickets: only the caller's own tickets; updatable so the demo's
-- "simulate queue update" can persist if ever wired to write back.
create policy "select own queue tickets"
  on public.queue_tickets for select
  using (exists (
    select 1 from public.profiles p
    where p.id = queue_tickets.user_id and p.auth_user_id = auth.uid()
  ));

create policy "update own queue tickets"
  on public.queue_tickets for update
  using (exists (
    select 1 from public.profiles p
    where p.id = queue_tickets.user_id and p.auth_user_id = auth.uid()
  ));

-- redemptions: the caller can see and create only their own.
create policy "select own redemptions"
  on public.redemptions for select
  using (exists (
    select 1 from public.profiles p
    where p.id = redemptions.user_id and p.auth_user_id = auth.uid()
  ));

create policy "insert own redemptions"
  on public.redemptions for insert
  with check (exists (
    select 1 from public.profiles p
    where p.id = redemptions.user_id and p.auth_user_id = auth.uid()
  ));

grant usage on schema public to anon, authenticated;
grant select, insert, update on public.profiles to anon, authenticated;
grant select on public.merchants to anon, authenticated;
grant select on public.invoices to anon, authenticated;
grant select, update on public.queue_tickets to anon, authenticated;
grant select on public.rewards to anon, authenticated;
grant select, insert on public.redemptions to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. RPC functions
-- ---------------------------------------------------------------------------

-- claim_or_create_profile: called right after the demo OTP succeeds and an
-- anonymous Supabase Auth session exists. It:
--   1. returns the profile already claimed by this auth session, if any;
--   2. otherwise claims an unclaimed seeded profile matching p_phone
--      (this is how the demo phone number below reveals its seeded data);
--   3. otherwise creates a brand-new, empty profile for this phone.
-- SECURITY DEFINER is required here: an anonymous session cannot see an
-- *unclaimed* profile under the RLS policies above (by design — you can
-- only ever read your own claimed row), so the lookup-and-claim in step 2
-- has to run with elevated rights. The function itself only ever assigns
-- auth_user_id := auth.uid() of the caller, so it cannot be used to claim
-- someone else's session, and search_path is pinned to prevent hijacking.
create or replace function public.claim_or_create_profile(p_phone text)
returns public.profiles
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_profile public.profiles;
begin
  if v_uid is null then
    raise exception 'يجب تسجيل الدخول أولاً';
  end if;

  select * into v_profile from public.profiles where auth_user_id = v_uid;
  if found then
    return v_profile;
  end if;

  select * into v_profile from public.profiles
  where phone = p_phone and auth_user_id is null
  limit 1;

  if found then
    update public.profiles set auth_user_id = v_uid
    where id = v_profile.id
    returning * into v_profile;
    return v_profile;
  end if;

  insert into public.profiles (phone, auth_user_id)
  values (p_phone, v_uid)
  returning * into v_profile;
  return v_profile;
end;
$$;

grant execute on function public.claim_or_create_profile(text) to anon, authenticated;

-- redeem_reward: atomically checks the reward is active and the caller's
-- own profile has enough points, deducts them, and records the redemption
-- — all in one transaction so two rapid clicks (or two tabs) can never
-- double-spend the same points. SECURITY INVOKER (the default) is used
-- deliberately here, unlike claim_or_create_profile: it runs with the
-- caller's own RLS context, which is enough since the caller is only ever
-- touching their own already-claimed row.
create or replace function public.redeem_reward(p_reward_id uuid)
returns public.profiles
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_profile public.profiles;
  v_cost integer;
begin
  select cost_points into v_cost
  from public.rewards
  where id = p_reward_id and active = true;

  if v_cost is null then
    raise exception 'المكافأة غير متاحة';
  end if;

  select * into v_profile
  from public.profiles
  where auth_user_id = auth.uid()
  for update;

  if v_profile.id is null then
    raise exception 'لم يتم العثور على ملفك الشخصي';
  end if;

  if v_profile.loyalty_points < v_cost then
    raise exception 'رصيد النقاط غير كافٍ';
  end if;

  update public.profiles
  set loyalty_points = loyalty_points - v_cost
  where id = v_profile.id
  returning * into v_profile;

  insert into public.redemptions (user_id, reward_id)
  values (v_profile.id, p_reward_id);

  return v_profile;
end;
$$;

grant execute on function public.redeem_reward(uuid) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. Seed data — matches the numbers already shown in index.html exactly
-- ---------------------------------------------------------------------------
-- Log in with phone 512345678 (code 1234) to claim this exact demo profile:
-- 1,250 loyalty points, tier 'ذهبي', 18 invoices this month totaling
-- 2,850.00 SAR split 35% مطاعم / 25% بقالة / 15% مقاهي / 12% مواصلات / 13%
-- أخرى — identical to the percentages the approved design already showed
-- with its old static mock data. Any other phone number just gets a fresh,
-- empty profile.

insert into public.profiles (id, phone, name, loyalty_points, tier, auth_user_id) values
  ('11111111-1111-1111-1111-111111111111', '512345678', 'أحمد الذبياني', 1250, 'ذهبي', null);

insert into public.merchants (id, name, branch, type, logo_color) values
  ('20000000-0000-0000-0000-000000000001', 'مطعم مذاق',      'فرع العليا', 'مطاعم',   '#7C5CE6'),
  ('20000000-0000-0000-0000-000000000002', 'بنده',           'الياسمين',   'بقالة',   '#3B82F6'),
  ('20000000-0000-0000-0000-000000000003', 'ستاربكس',        'النخيل',     'مقاهي',   '#22A87A'),
  ('20000000-0000-0000-0000-000000000004', 'صيدلية النهدي',  null,         'أخرى',    '#64748B'),
  ('20000000-0000-0000-0000-000000000005', 'أوبر',           null,         'مواصلات', '#F59E0B'),
  ('20000000-0000-0000-0000-000000000006', 'مقهى بارز',      null,         'مقاهي',   '#22A87A'),
  ('20000000-0000-0000-0000-000000000007', 'برجر بوينت',     null,         'مطاعم',   '#7C5CE6'),
  ('20000000-0000-0000-0000-000000000008', 'كارفور',         null,         'بقالة',   '#3B82F6'),
  ('20000000-0000-0000-0000-000000000009', 'كوستا',          null,         'مقاهي',   '#22A87A'),
  ('2000000a-0000-0000-0000-00000000000a', 'كريم',           null,         'مواصلات', '#F59E0B'),
  ('2000000b-0000-0000-0000-00000000000b', 'صيدلية الدواء',  null,         'أخرى',    '#64748B');

insert into public.invoices (id, user_id, merchant_id, amount, vat, category, items, points_earned, status, created_at) values
  ('40000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', '20000000-0000-0000-0000-000000000001', 120.50, 15.72, 'مطاعم',
    '[{"n":"برياني دجاج","p":45},{"n":"عصير مشمش","p":12},{"n":"حمص وسلطة","p":18},{"n":"خبز تنور","p":5},{"n":"رسوم خدمة","p":40.5}]'::jsonb,
    12, 'paid', '2025-05-20 13:30:00+03'),
  ('40000000-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111', '20000000-0000-0000-0000-000000000002', 214.00, 27.91, 'بقالة',
    '[{"n":"خضار وفواكه","p":62},{"n":"منتجات ألبان","p":48},{"n":"مواد تنظيف","p":39},{"n":"مخبوزات","p":25},{"n":"متنوع","p":40}]'::jsonb,
    21, 'paid', '2025-05-19 18:10:00+03'),
  ('40000000-0000-0000-0000-000000000003', '11111111-1111-1111-1111-111111111111', '20000000-0000-0000-0000-000000000003', 38.00, 4.96, 'مقاهي',
    '[{"n":"قهوة لاتيه كبير","p":24},{"n":"كرواسون","p":14}]'::jsonb,
    3, 'paid', '2025-05-18 09:05:00+03'),
  ('40000000-0000-0000-0000-000000000004', '11111111-1111-1111-1111-111111111111', '20000000-0000-0000-0000-000000000004', 67.00, 8.74, 'أخرى',
    '[{"n":"فيتامينات","p":45},{"n":"مستلزمات شخصية","p":22}]'::jsonb,
    6, 'paid', '2025-05-17 20:45:00+03'),
  ('40000000-0000-0000-0000-000000000005', '11111111-1111-1111-1111-111111111111', '20000000-0000-0000-0000-000000000005', 29.00, 3.78, 'مواصلات',
    '[{"n":"رحلة - المكتب للمنزل","p":29}]'::jsonb,
    2, 'paid', '2025-05-16 17:20:00+03'),
  ('40000000-0000-0000-0000-000000000006', '11111111-1111-1111-1111-111111111111', '20000000-0000-0000-0000-000000000006', 22.00, 2.87, 'مقاهي',
    '[{"n":"كابتشينو","p":16},{"n":"ماء","p":6}]'::jsonb,
    2, 'paid', '2025-05-15 08:15:00+03'),
  ('40000000-0000-0000-0000-000000000007', '11111111-1111-1111-1111-111111111111', '20000000-0000-0000-0000-000000000001', 310.00, 40.43, 'مطاعم',
    '[{"n":"وجبة عائلية","p":310}]'::jsonb,
    31, 'paid', '2025-05-14 19:30:00+03'),
  ('40000000-0000-0000-0000-000000000008', '11111111-1111-1111-1111-111111111111', '20000000-0000-0000-0000-000000000007', 275.50, 35.93, 'مطاعم',
    '[{"n":"وجبات برجر","p":275.5}]'::jsonb,
    27, 'paid', '2025-05-13 13:00:00+03'),
  ('40000000-0000-0000-0000-000000000009', '11111111-1111-1111-1111-111111111111', '20000000-0000-0000-0000-000000000001', 292.00, 38.09, 'مطاعم',
    '[{"n":"عشاء عمل","p":292}]'::jsonb,
    29, 'paid', '2025-05-12 20:00:00+03'),
  ('4000000a-0000-0000-0000-00000000000a', '11111111-1111-1111-1111-111111111111', '20000000-0000-0000-0000-000000000002', 258.00, 33.65, 'بقالة',
    '[{"n":"مشتريات أسبوعية","p":258}]'::jsonb,
    25, 'paid', '2025-05-11 16:40:00+03'),
  ('4000000b-0000-0000-0000-00000000000b', '11111111-1111-1111-1111-111111111111', '20000000-0000-0000-0000-000000000008', 240.00, 31.30, 'بقالة',
    '[{"n":"مشتريات منزلية","p":240}]'::jsonb,
    24, 'paid', '2025-05-10 11:15:00+03'),
  ('4000000c-0000-0000-0000-00000000000c', '11111111-1111-1111-1111-111111111111', '20000000-0000-0000-0000-000000000003', 145.00, 18.91, 'مقاهي',
    '[{"n":"مشروبات وحلا","p":145}]'::jsonb,
    14, 'paid', '2025-05-09 10:20:00+03'),
  ('4000000d-0000-0000-0000-00000000000d', '11111111-1111-1111-1111-111111111111', '20000000-0000-0000-0000-000000000006', 98.00, 12.78, 'مقاهي',
    '[{"n":"قهوة ومعجنات","p":98}]'::jsonb,
    9, 'paid', '2025-05-08 09:50:00+03'),
  ('4000000e-0000-0000-0000-00000000000e', '11111111-1111-1111-1111-111111111111', '20000000-0000-0000-0000-000000000009', 125.00, 16.30, 'مقاهي',
    '[{"n":"مشروبات باردة","p":125}]'::jsonb,
    12, 'paid', '2025-05-07 15:10:00+03'),
  ('4000000f-0000-0000-0000-00000000000f', '11111111-1111-1111-1111-111111111111', '20000000-0000-0000-0000-000000000005', 180.00, 23.48, 'مواصلات',
    '[{"n":"رحلات متعددة","p":180}]'::jsonb,
    18, 'paid', '2025-05-06 21:00:00+03'),
  ('40000010-0000-0000-0000-000000000010', '11111111-1111-1111-1111-111111111111', '2000000a-0000-0000-0000-00000000000a', 133.00, 17.35, 'مواصلات',
    '[{"n":"رحلات متعددة","p":133}]'::jsonb,
    13, 'paid', '2025-05-05 12:30:00+03'),
  ('40000011-0000-0000-0000-000000000011', '11111111-1111-1111-1111-111111111111', '20000000-0000-0000-0000-000000000004', 155.00, 20.22, 'أخرى',
    '[{"n":"أدوية ومستلزمات","p":155}]'::jsonb,
    15, 'paid', '2025-05-04 14:45:00+03'),
  ('40000012-0000-0000-0000-000000000012', '11111111-1111-1111-1111-111111111111', '2000000b-0000-0000-0000-00000000000b', 148.00, 19.30, 'أخرى',
    '[{"n":"أدوية","p":148}]'::jsonb,
    14, 'paid', '2025-05-03 10:00:00+03');

insert into public.queue_tickets (id, user_id, merchant_id, ticket_number, unit_name, position, est_minutes, status) values
  ('50000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', '20000000-0000-0000-0000-000000000001', 47, 'فرع العليا', 5, 12, 'waiting');

insert into public.rewards (id, merchant_id, title, cost_points, active) values
  ('30000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000003', 'قهوة مجانية', 200, true),
  ('30000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000001', 'خصم 15% على الطلب القادم', 350, true),
  ('30000000-0000-0000-0000-000000000003', '20000000-0000-0000-0000-000000000005', 'توصيل مجاني على أي رحلة', 150, true),
  ('30000000-0000-0000-0000-000000000004', '20000000-0000-0000-0000-000000000002', 'حلوى مجانية مع أي طلب', 100, true);
