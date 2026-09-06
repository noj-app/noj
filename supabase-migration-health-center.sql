-- ============================================================================
-- NOJ — migration: health-center clinics + appointments
-- ============================================================================
-- Adds what a full health-center merchant needs, beyond the generic
-- booking_enabled/queue_enabled flags added in
-- supabase-migration-merchant-features.sql:
--
--   1. clinics: gives a merchant's queue_tickets.unit_name a real identity
--      (a doctor's name, whether that specific clinic takes advance
--      bookings) instead of being a loose free-text string. Publicly
--      readable, like merchants/rewards — no per-customer data in it.
--
--   2. appointments: one row per customer booking at a clinic — real data
--      backing "مواعيدي" (المواعيد القادمة، مع إلغاء فعلي). RLS-protected
--      exactly like every other per-user table in this app.
--
--   3. get_merchant_clinics(): an aggregate, privacy-safe per-clinic queue
--      view for the "الانتظار الذكي" screen at a health center — same
--      SECURITY DEFINER rationale as get_merchant_queue_stats (grouped
--      counts only, never another customer's ticket row), but joined with
--      clinic identity and covering EVERY clinic, even ones nobody is
--      currently waiting at, so the screen shows the full picture
--      regardless of whether the caller has a ticket anywhere.
--
--   4. One demo merchant — "مركز النور الطبي" (فرع الملقا) — with 5
--      clinics, seeded queue_tickets so each clinic's stats differ (a
--      quick "متاحة/متوسطة/مزدحمة" spread to see all three states), and
--      one upcoming appointment for the existing demo profile so
--      "مواعيدي" has something real to show and cancel.
--
-- ADDITIVE / SAFE: no existing table is dropped, no existing row is deleted
-- or modified. Run this ONCE in the Supabase SQL Editor, after
-- supabase-schema.sql and supabase-migration-merchant-features.sql (any
-- order relative to supabase-migration-merchant-loyalty.sql or
-- supabase-migration-fix-profile-reclaim.sql). Safe to run more than once.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. clinics
-- ---------------------------------------------------------------------------
create table if not exists public.clinics (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references public.merchants(id) on delete cascade,
  name text not null,
  doctor_name text,
  booking_enabled boolean not null default false,
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists clinics_merchant_id_idx on public.clinics(merchant_id);

alter table public.clinics enable row level security;

-- publicly readable, like merchants/rewards — a clinic's name/doctor is not
-- customer data, every signed-in session may read the merchant's own list.
drop policy if exists "clinics are publicly readable" on public.clinics;
create policy "clinics are publicly readable"
  on public.clinics for select
  using (true);

grant select on public.clinics to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. appointments — one row per customer booking at a clinic
-- ---------------------------------------------------------------------------
create table if not exists public.appointments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  merchant_id uuid not null references public.merchants(id) on delete cascade,
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  scheduled_at timestamptz not null,
  status text not null default 'confirmed' check (status in ('confirmed','cancelled','done')),
  created_at timestamptz not null default now()
);

create index if not exists appointments_user_id_idx on public.appointments(user_id);

alter table public.appointments enable row level security;

-- same pattern as every other per-user table: a session can only ever
-- see/touch the rows belonging to the profile it has claimed.
drop policy if exists "select own appointments" on public.appointments;
create policy "select own appointments"
  on public.appointments for select
  using (exists (
    select 1 from public.profiles p
    where p.id = appointments.user_id and p.auth_user_id = auth.uid()
  ));

-- update (not insert/delete) is granted directly, same rationale as
-- merchant_loyalty's update policy: index.html cancels an appointment via a
-- plain client-side update (status='cancelled') running with the caller's
-- own RLS context — no SECURITY DEFINER function needed for a single-row,
-- single-owner mutation like this.
drop policy if exists "update own appointments" on public.appointments;
create policy "update own appointments"
  on public.appointments for update
  using (exists (
    select 1 from public.profiles p
    where p.id = appointments.user_id and p.auth_user_id = auth.uid()
  ));

grant select, update on public.appointments to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. get_merchant_clinics: clinic identity + live aggregate queue stats
-- ---------------------------------------------------------------------------
create or replace function public.get_merchant_clinics(p_merchant_id uuid)
returns table(
  clinic_id uuid,
  clinic_name text,
  doctor_name text,
  booking_enabled boolean,
  now_serving int,
  waiting_count bigint,
  est_minutes int
)
language sql
security definer
set search_path = public
stable
as $$
  select
    c.id,
    c.name,
    c.doctor_name,
    c.booking_enabled,
    (
      select max(t.ticket_number)
      from public.queue_tickets t
      where t.merchant_id = p_merchant_id and t.unit_name = c.name and t.status in ('called','done')
    ) as now_serving,
    coalesce((
      select count(*)
      from public.queue_tickets t
      where t.merchant_id = p_merchant_id and t.unit_name = c.name and t.status = 'waiting'
    ), 0) as waiting_count,
    coalesce((
      select max(t.est_minutes)
      from public.queue_tickets t
      where t.merchant_id = p_merchant_id and t.unit_name = c.name and t.status = 'waiting'
    ), 0) as est_minutes
  from public.clinics c
  where c.merchant_id = p_merchant_id
  order by c.sort_order;
$$;

grant execute on function public.get_merchant_clinics(uuid) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. Demo seed: مركز النور الطبي — فرع الملقا
-- ---------------------------------------------------------------------------
insert into public.merchants (id, name, branch, type, logo_color, booking_enabled, queue_enabled) values
  ('20000000-0000-0000-0000-00000000000d', 'مركز النور الطبي', 'فرع الملقا', 'صحة', '#0F6E6E', true, true)
on conflict (id) do nothing;

-- 5 clinics: 4 take advance booking, المختبر (lab) is walk-in queue only.
insert into public.clinics (id, merchant_id, name, doctor_name, booking_enabled, sort_order) values
  ('21000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-00000000000d', 'عيادة الأسنان', 'د. سارة القحطاني', true, 1),
  ('21000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-00000000000d', 'عيادة الجلدية', 'د. نورة العتيبي', true, 2),
  ('21000000-0000-0000-0000-000000000003', '20000000-0000-0000-0000-00000000000d', 'عيادة الباطنة', 'د. خالد المطيري', true, 3),
  ('21000000-0000-0000-0000-000000000004', '20000000-0000-0000-0000-00000000000d', 'عيادة العيون', 'د. منى الحربي', true, 4),
  ('21000000-0000-0000-0000-000000000005', '20000000-0000-0000-0000-00000000000d', 'المختبر', null, false, 5)
on conflict (id) do nothing;

-- demo invoice so "فواتيري" is active for this merchant
insert into public.invoices (id, user_id, merchant_id, amount, vat, category, items, points_earned, status, created_at) values
  ('40000014-0000-0000-0000-000000000014', '11111111-1111-1111-1111-111111111111', '20000000-0000-0000-0000-00000000000d', 250.00, 32.61, 'صحة',
    '[{"n":"كشف عام - عيادة الباطنة","p":250}]'::jsonb, 0, 'paid', '2025-05-10 09:00:00+03')
on conflict (id) do nothing;
-- deliberately no merchant_loyalty row for this merchant, and its rewards
-- table has none either — that is exactly what keeps "الولاء" hidden for it.

-- queue_tickets across the 4 bookable clinics, giving each a different
-- congestion level to see all three "متاحة/متوسطة/مزدحمة" states at once.
-- The dermatology ticket (#58) belongs to the demo profile itself, so it
-- becomes the customer's own highlighted ticket at the top of the list.
-- index.html always shows the MOST RECENTLY created 'waiting' ticket as
-- the customer's single global active ticket (app-wide simplification
-- predating this migration — see supabase-schema.sql's single seeded
-- ticket at مطعم مذاق), so every other row here is explicitly backdated
-- and the dermatology row given the latest created_at, guaranteeing it —
-- and not an arbitrary tie — wins that "most recent" selection and
-- correctly supersedes the older مطعم مذاق ticket as the active one.
insert into public.queue_tickets (id, user_id, merchant_id, ticket_number, unit_name, position, est_minutes, status, created_at) values
  -- عيادة الأسنان: "متاحة" (2 منتظرين) + رقمان تم نداؤهما فعليًا
  ('51000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', '20000000-0000-0000-0000-00000000000d', 40, 'عيادة الأسنان', 0, 5,  'done',    now() - interval '30 minutes'),
  ('51000000-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111', '20000000-0000-0000-0000-00000000000d', 41, 'عيادة الأسنان', 0, 5,  'done',    now() - interval '30 minutes'),
  ('51000000-0000-0000-0000-000000000003', '11111111-1111-1111-1111-111111111111', '20000000-0000-0000-0000-00000000000d', 42, 'عيادة الأسنان', 1, 8,  'waiting', now() - interval '30 minutes'),
  ('51000000-0000-0000-0000-000000000004', '11111111-1111-1111-1111-111111111111', '20000000-0000-0000-0000-00000000000d', 43, 'عيادة الأسنان', 2, 12, 'waiting', now() - interval '30 minutes'),
  -- عيادة الجلدية: تذكرة العميل نفسه (متاحة أيضًا، شخص واحد أمامه) — أحدث تذكرة
  ('51000000-0000-0000-0000-000000000005', '11111111-1111-1111-1111-111111111111', '20000000-0000-0000-0000-00000000000d', 57, 'عيادة الجلدية', 0, 6,  'done',    now() - interval '20 minutes'),
  ('51000000-0000-0000-0000-000000000006', '11111111-1111-1111-1111-111111111111', '20000000-0000-0000-0000-00000000000d', 58, 'عيادة الجلدية', 1, 10, 'waiting', now()),
  -- عيادة الباطنة: "مزدحمة" (7 منتظرين)
  ('51000000-0000-0000-0000-000000000007', '11111111-1111-1111-1111-111111111111', '20000000-0000-0000-0000-00000000000d', 20, 'عيادة الباطنة', 0, 5,  'done',    now() - interval '25 minutes'),
  ('51000000-0000-0000-0000-000000000008', '11111111-1111-1111-1111-111111111111', '20000000-0000-0000-0000-00000000000d', 21, 'عيادة الباطنة', 1, 10, 'waiting', now() - interval '25 minutes'),
  ('51000000-0000-0000-0000-000000000009', '11111111-1111-1111-1111-111111111111', '20000000-0000-0000-0000-00000000000d', 22, 'عيادة الباطنة', 2, 15, 'waiting', now() - interval '25 minutes'),
  ('5100000a-0000-0000-0000-00000000000a', '11111111-1111-1111-1111-111111111111', '20000000-0000-0000-0000-00000000000d', 23, 'عيادة الباطنة', 3, 20, 'waiting', now() - interval '25 minutes'),
  ('5100000b-0000-0000-0000-00000000000b', '11111111-1111-1111-1111-111111111111', '20000000-0000-0000-0000-00000000000d', 24, 'عيادة الباطنة', 4, 25, 'waiting', now() - interval '25 minutes'),
  ('5100000c-0000-0000-0000-00000000000c', '11111111-1111-1111-1111-111111111111', '20000000-0000-0000-0000-00000000000d', 25, 'عيادة الباطنة', 5, 30, 'waiting', now() - interval '25 minutes'),
  ('5100000d-0000-0000-0000-00000000000d', '11111111-1111-1111-1111-111111111111', '20000000-0000-0000-0000-00000000000d', 26, 'عيادة الباطنة', 6, 35, 'waiting', now() - interval '25 minutes'),
  ('5100000d-1000-0000-0000-00000000000e', '11111111-1111-1111-1111-111111111111', '20000000-0000-0000-0000-00000000000d', 27, 'عيادة الباطنة', 7, 40, 'waiting', now() - interval '25 minutes'),
  -- عيادة العيون: "متوسطة" (4 منتظرين)
  ('5100000e-0000-0000-0000-00000000000e', '11111111-1111-1111-1111-111111111111', '20000000-0000-0000-0000-00000000000d', 10, 'عيادة العيون', 0, 5,  'done',    now() - interval '15 minutes'),
  ('5100000f-0000-0000-0000-00000000000f', '11111111-1111-1111-1111-111111111111', '20000000-0000-0000-0000-00000000000d', 11, 'عيادة العيون', 1, 10, 'waiting', now() - interval '15 minutes'),
  ('51000010-0000-0000-0000-000000000010', '11111111-1111-1111-1111-111111111111', '20000000-0000-0000-0000-00000000000d', 12, 'عيادة العيون', 2, 15, 'waiting', now() - interval '15 minutes'),
  ('51000011-0000-0000-0000-000000000011', '11111111-1111-1111-1111-111111111111', '20000000-0000-0000-0000-00000000000d', 13, 'عيادة العيون', 3, 20, 'waiting', now() - interval '15 minutes'),
  ('51000012-0000-0000-0000-000000000012', '11111111-1111-1111-1111-111111111111', '20000000-0000-0000-0000-00000000000d', 14, 'عيادة العيون', 4, 25, 'waiting', now() - interval '15 minutes')
on conflict (id) do nothing;

-- one upcoming appointment for the demo profile, at عيادة الأسنان
insert into public.appointments (id, user_id, merchant_id, clinic_id, scheduled_at, status) values
  ('22000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', '20000000-0000-0000-0000-00000000000d', '21000000-0000-0000-0000-000000000001', now() + interval '2 days', 'confirmed')
on conflict (id) do nothing;
