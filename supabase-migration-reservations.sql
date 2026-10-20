-- ============================================================================
-- NOJ — migration: reservations ("حجوزات") for restaurants and services,
-- built ON the existing health appointments system — not a second system
-- ============================================================================
-- WHAT ALREADY EXISTED (supabase-migration-health-center.sql +
-- supabase-migration-lockdown-direct-writes.sql + merchant-features.sql):
--   - public.appointments: one row per customer booking (user_id, merchant_id,
--     scheduled_at, status confirmed/cancelled/done), RLS "select own
--     appointments" (a customer reads only their own rows), no client write
--     grant at all (lockdown);
--   - cancel_appointment(id): the customer cancels their own row;
--   - merchants.booking_enabled: the per-merchant "this merchant takes
--     bookings" flag that index.html already uses to show the booking section.
--
-- WHAT WAS HEALTH-SPECIFIC AND IS GENERALIZED HERE (additively):
--   1. clinic_id was NOT NULL — every booking had to be at a clinic. Now
--      nullable, and a new booking_kind column says what a row is:
--        'appointment' (health, the default — every existing row), 'table'
--        (restaurant: party_size), 'service' (services: service_type).
--      A shape CHECK keeps each kind honest: an appointment still REQUIRES a
--      clinic exactly as before; a table/service row has no clinic.
--   2. status had no "waiting for the merchant" value (health rows are
--      seeded already confirmed). 'pending' is added for reservations: the
--      customer requests, the merchant accepts (confirmed) or cancels.
--   3. there was NO create path at all (health booking in index.html is
--      still a demo toast — unchanged). create_reservation() is the first:
--      restaurant/services only, never for health.
--   4. cancel_appointment() only cancelled 'confirmed' rows; it now also
--      cancels 'pending' (a customer may withdraw a request). Health rows are
--      never 'pending', so for health its behaviour is literally unchanged.
--      Its body is IDENTICAL in supabase-migration-lockdown-direct-writes.sql
--      (db-tests compare prosrc after applying the files in either order), so
--      re-running the older file cannot take this back.
--   5. nothing let a merchant see bookings: merchant_list_reservations() and
--      merchant_set_reservation_status() (owner AND staff), and
--      merchant_set_booking_enabled() (owner only) for the existing flag.
--
-- MERCHANT CONTROLS (second round of PR ب):
--   6. merchant_services: the services merchant's OWN list (name, optional
--      price, active or not, booking open or not). It is the list the kiosk's
--      "خدماتنا" button shows, and the only thing a customer can book — no
--      free text. Owner manages it through merchant_save_service().
--   7. booking is opened/closed per unit: restaurant = its tables
--      (merchants.booking_enabled), services = the master switch
--      (merchants.booking_enabled) AND each service's booking_enabled.
--   8. cancellation policy per merchant (merchants.booking_cancel_allowed,
--      booking_cancel_cutoff_hours): enforced inside cancel_appointment() for
--      reservations; the merchant can ALWAYS cancel (merchant_set_
--      reservation_status ignores the policy). Owner sets it through
--      merchant_set_booking_policy().
--   9. new-booking alerts: a trigger writes one booking_alerts row per new
--      reservation (no customer data — just merchant + reservation id) when
--      merchants.booking_alerts_enabled is on; merchant.html listens to it
--      through Realtime (sound + counter on the tab). Owner or staff switch
--      it with merchant_set_booking_alerts(); old alert rows are purged
--      daily by pg_cron.
--
-- PRIVACY: the merchant sees, per reservation, the customer's profile name
-- and the LAST 4 digits of their phone only (enough to receive them at the
-- door, never the full number) — the customer chose to book with that
-- merchant. Health appointments never appear in these merchant RPCs.
--
-- Every function: SECURITY DEFINER, pinned search_path, identity re-derived
-- from auth.uid() (never a client-supplied profile id), explicit
-- `revoke execute ... from public, anon` then `grant ... to authenticated`.
--
-- ADDITIVE / SAFE / IDEMPOTENT: no row is modified (existing rows read
-- booking_kind='appointment' from the column default); constraints are only
-- widened. Run ONCE after supabase-migration-sector-owner-only.sql. Safe to
-- re-run.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. appointments: generalized, additively
-- ---------------------------------------------------------------------------
alter table public.appointments alter column clinic_id drop not null;
alter table public.appointments add column if not exists booking_kind text not null default 'appointment';
alter table public.appointments add column if not exists party_size integer;
alter table public.appointments add column if not exists service_type text;
alter table public.appointments add column if not exists note text;

-- the original inline CHECK (confirmed/cancelled/done) is auto-named
-- appointments_status_check; drop whatever status CHECK exists, whatever its
-- name, so 'pending' is never rejected by a leftover
do $$
declare r record;
begin
  for r in
    select conname from pg_constraint
    where conrelid = 'public.appointments'::regclass and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%status%'
  loop
    execute format('alter table public.appointments drop constraint %I', r.conname);
  end loop;
end $$;
alter table public.appointments add constraint appointments_status_check
  check (status in ('pending', 'confirmed', 'cancelled', 'done'));

alter table public.appointments drop constraint if exists appointments_booking_kind_chk;
alter table public.appointments add constraint appointments_booking_kind_chk
  check (booking_kind in ('appointment', 'table', 'service'));

-- (each disjunct spells out "is not null": a NULL inside a CHECK makes it
-- unknown, and unknown PASSES a CHECK)
alter table public.appointments drop constraint if exists appointments_kind_shape_chk;
alter table public.appointments add constraint appointments_kind_shape_chk check (
  (booking_kind = 'appointment' and clinic_id is not null and party_size is null and service_type is null)
  or (booking_kind = 'table' and clinic_id is null and party_size is not null and party_size between 1 and 50
      and service_type is null)
  or (booking_kind = 'service' and clinic_id is null and party_size is null
      and service_type is not null and char_length(service_type) between 1 and 80)
);

alter table public.appointments drop constraint if exists appointments_note_len_chk;
alter table public.appointments add constraint appointments_note_len_chk
  check (note is null or char_length(note) <= 300);

create index if not exists appointments_merchant_scheduled_idx on public.appointments (merchant_id, scheduled_at);

-- merchant-level booking settings (merchants is publicly readable already:
-- the app needs the cancel policy to hide its cancel button)
alter table public.merchants add column if not exists booking_cancel_allowed boolean not null default true;
alter table public.merchants add column if not exists booking_cancel_cutoff_hours integer not null default 0;
alter table public.merchants add column if not exists booking_alerts_enabled boolean not null default true;
alter table public.merchants drop constraint if exists merchants_booking_cancel_cutoff_chk;
alter table public.merchants add constraint merchants_booking_cancel_cutoff_chk
  check (booking_cancel_cutoff_hours between 0 and 168);

-- the services merchant's list ("خدماتنا")
create table if not exists public.merchant_services (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references public.merchants(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 80 and name = btrim(name)),
  price numeric(10,2) check (price is null or (price >= 0 and price <= 1000000)),
  is_active boolean not null default true,
  booking_enabled boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (merchant_id, name)
);
alter table public.merchant_services enable row level security;
-- customers and kiosks see a merchant's ACTIVE services (like clinics)
drop policy if exists "active services are publicly readable" on public.merchant_services;
create policy "active services are publicly readable"
  on public.merchant_services for select
  using (is_active);
-- the merchant's own members also see the inactive ones
drop policy if exists "merchant members read their services" on public.merchant_services;
create policy "merchant members read their services"
  on public.merchant_services for select
  using (exists (
    select 1 from public.merchant_members mm
    where mm.merchant_id = merchant_services.merchant_id and mm.auth_user_id = auth.uid()
  ));
revoke all on public.merchant_services from anon, authenticated;
grant select on public.merchant_services to anon, authenticated;

-- which service a reservation is for (service_type keeps the name as it was
-- when booked, so a later rename never rewrites history)
alter table public.appointments add column if not exists service_id uuid references public.merchant_services(id) on delete set null;

-- ---------------------------------------------------------------------------
-- 2. cancel_appointment(): also withdraws a 'pending' request, and applies the
--    merchant's cancellation policy to reservations (never to health).
--    IDENTICAL body in supabase-migration-lockdown-direct-writes.sql.
-- ---------------------------------------------------------------------------
create or replace function public.cancel_appointment(p_appointment_id uuid)
returns public.appointments
language plpgsql
security definer
set search_path = public
as $$
declare
  v_profile_id uuid;
  v_row public.appointments;
  v_policy jsonb;
begin
  select id into v_profile_id from public.profiles where auth_user_id = auth.uid();
  if v_profile_id is null then
    raise exception 'لم يتم العثور على ملفك الشخصي';
  end if;

  select * into v_row
  from public.appointments
  where id = p_appointment_id and user_id = v_profile_id
  for update;

  if v_row.id is null then
    raise exception 'الموعد غير موجود أو لا يخصّك';
  end if;

  -- 'pending' = a reservation request not yet accepted by the merchant
  -- (supabase-migration-reservations.sql); health appointments are never pending
  if v_row.status not in ('confirmed', 'pending') then
    raise exception 'لا يمكن إلغاء موعد ليس بحالة مؤكَّدة';
  end if;

  -- a reservation (table/service) follows its merchant's cancellation policy
  -- (merchants.booking_cancel_allowed / booking_cancel_cutoff_hours). Read
  -- through to_jsonb() so this SAME body also runs where those columns do not
  -- exist yet (supabase-migration-lockdown-direct-writes.sql alone): there a
  -- row has no booking_kind, i.e. it is a health appointment, unchanged.
  if coalesce(to_jsonb(v_row)->>'booking_kind', 'appointment') in ('table', 'service') then
    select to_jsonb(m) into v_policy from public.merchants m where m.id = v_row.merchant_id;
    if coalesce((v_policy->>'booking_cancel_allowed')::boolean, true) = false then
      raise exception 'NOJ_CANCEL_NOT_ALLOWED';
    end if;
    if v_row.scheduled_at < now() + make_interval(hours => coalesce((v_policy->>'booking_cancel_cutoff_hours')::integer, 0)) then
      raise exception 'NOJ_CANCEL_WINDOW_CLOSED';
    end if;
  end if;

  update public.appointments
  set status = 'cancelled'
  where id = p_appointment_id
  returning * into v_row;

  return v_row;
end;
$$;

revoke execute on function public.cancel_appointment(uuid) from public, anon;
grant execute on function public.cancel_appointment(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. create_reservation(): the customer requests a table / a service
-- ---------------------------------------------------------------------------
-- Rules (each failure is a NOJ_* code index.html translates):
--   - the caller has a (non-deleted) profile;
--   - the merchant's sector is restaurant (→ 'table', party_size 1..50
--     required) or services (→ 'service', p_service_id required: one of the
--     merchant's OWN services, active and open for booking, else
--     NOJ_SERVICE_NOT_AVAILABLE — its name is copied into service_type);
--     anything else, health included, is NOJ_BOOKING_NOT_AVAILABLE;
--   - merchants.booking_enabled is true (NOJ_BOOKING_DISABLED): the tables of
--     a restaurant / the master switch of a services merchant;
--   - scheduled_at is at least 15 minutes ahead and at most 90 days ahead
--     (NOJ_INVALID_BOOKING_TIME);
--   - optional note, trimmed, at most 300 chars (NOJ_INVALID_BOOKING_NOTE);
--   - at most 3 upcoming (pending/confirmed) reservations per customer per
--     merchant (NOJ_BOOKING_LIMIT) — serialized on the customer's profile row
--     so two concurrent requests cannot both slip under the limit.
-- The field that does not belong to the kind (p_service_id for a table,
-- party_size for a service) is ignored, not stored.
-- (the first draft of this file took a free-text p_service_type; never applied
-- live, dropped here in case a test database still has it)
drop function if exists public.create_reservation(uuid, timestamptz, integer, text, text);
create or replace function public.create_reservation(
  p_merchant_id uuid,
  p_scheduled_at timestamptz,
  p_party_size integer default null,
  p_service_id uuid default null,
  p_note text default null
)
returns public.appointments
language plpgsql
security definer
set search_path = public
as $$
declare
  v_profile_id uuid;
  v_merchant public.merchants;
  v_kind text;
  v_party integer;
  v_service public.merchant_services;
  v_note text;
  v_active integer;
  v_row public.appointments;
begin
  select id into v_profile_id from public.profiles
  where auth_user_id = auth.uid() and deleted_at is null;
  if v_profile_id is null then
    raise exception 'لم يتم العثور على ملفك الشخصي';
  end if;

  select * into v_merchant from public.merchants where id = p_merchant_id;
  if v_merchant.id is null then
    raise exception 'NOJ_MERCHANT_NOT_FOUND';
  end if;
  if v_merchant.sector_code = 'restaurant' then
    v_kind := 'table';
  elsif v_merchant.sector_code = 'services' then
    v_kind := 'service';
  else
    raise exception 'NOJ_BOOKING_NOT_AVAILABLE';
  end if;
  if not v_merchant.booking_enabled then
    raise exception 'NOJ_BOOKING_DISABLED';
  end if;

  if p_scheduled_at is null
     or p_scheduled_at < now() + interval '15 minutes'
     or p_scheduled_at > now() + interval '90 days' then
    raise exception 'NOJ_INVALID_BOOKING_TIME';
  end if;

  v_note := nullif(btrim(coalesce(p_note, '')), '');
  if v_note is not null and char_length(v_note) > 300 then
    raise exception 'NOJ_INVALID_BOOKING_NOTE';
  end if;

  if v_kind = 'table' then
    if p_party_size is null or p_party_size < 1 or p_party_size > 50 then
      raise exception 'NOJ_INVALID_PARTY_SIZE';
    end if;
    v_party := p_party_size;
  else
    select * into v_service from public.merchant_services
    where id = p_service_id and merchant_id = p_merchant_id and is_active and booking_enabled;
    if v_service.id is null then
      raise exception 'NOJ_SERVICE_NOT_AVAILABLE';
    end if;
  end if;

  perform 1 from public.profiles where id = v_profile_id for update;

  select count(*) into v_active
  from public.appointments
  where user_id = v_profile_id and merchant_id = p_merchant_id
    and booking_kind in ('table', 'service')
    and status in ('pending', 'confirmed')
    and scheduled_at >= now();
  if v_active >= 3 then
    raise exception 'NOJ_BOOKING_LIMIT';
  end if;

  insert into public.appointments (user_id, merchant_id, clinic_id, scheduled_at, status, booking_kind, party_size, service_id, service_type, note)
  values (v_profile_id, p_merchant_id, null, p_scheduled_at, 'pending', v_kind, v_party, v_service.id, v_service.name, v_note)
  returning * into v_row;

  return v_row;
end;
$$;

revoke execute on function public.create_reservation(uuid, timestamptz, integer, uuid, text) from public, anon;
grant execute on function public.create_reservation(uuid, timestamptz, integer, uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. merchant side (merchant.html "الحجوزات" tab)
-- ---------------------------------------------------------------------------
-- One reservation as the dashboard sees it — a closed list of keys: no
-- user_id, no profile id, no full phone.
create or replace function public.reservation_json_for_merchant(p_row public.appointments)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'id', p_row.id,
    'kind', p_row.booking_kind,
    'status', p_row.status,
    'scheduled_at', p_row.scheduled_at,
    'scheduled_at_riyadh', to_char(p_row.scheduled_at at time zone 'Asia/Riyadh', 'YYYY-MM-DD HH24:MI'),
    'party_size', p_row.party_size,
    'service_type', p_row.service_type,
    'note', p_row.note,
    'created_at', p_row.created_at,
    'customer_name', case when p.deleted_at is null then p.name end,
    'customer_phone_last4', case when p.deleted_at is null and p.phone ~ '^5[0-9]{8}$' then right(p.phone, 4) end
  )
  from (select 1) one
  left join public.profiles p on p.id = p_row.user_id;
$$;

revoke all on function public.reservation_json_for_merchant(public.appointments) from public, anon, authenticated, service_role;

-- Reservations of one merchant between two Riyadh calendar dates (inclusive;
-- default: today .. today + 90 days), soonest first, every status, at most
-- 300 rows. Owner or staff. Health appointments (booking_kind
-- 'appointment') are never returned. Also returns the merchant's
-- booking_enabled flag and sector, so the screen knows what to offer.
create or replace function public.merchant_list_reservations(
  p_merchant_id uuid,
  p_from date default null,
  p_to date default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_merchant public.merchants;
  v_from date := coalesce(p_from, public.riyadh_today());
  v_to date := coalesce(p_to, coalesce(p_from, public.riyadh_today()) + 90);
  v_rows jsonb;
begin
  if not exists (
    select 1 from public.merchant_members
    where merchant_id = p_merchant_id and auth_user_id = auth.uid()
  ) then
    raise exception 'لا تملك صلاحية على هذا التاجر';
  end if;
  if v_to < v_from then
    raise exception 'NOJ_INVALID_DATE_RANGE';
  end if;

  select * into v_merchant from public.merchants where id = p_merchant_id;

  select coalesce(jsonb_agg(public.reservation_json_for_merchant(a) order by a.scheduled_at, a.id), '[]'::jsonb)
  into v_rows
  from (
    select * from public.appointments
    where merchant_id = p_merchant_id
      and booking_kind in ('table', 'service')
      and scheduled_at >= v_from::timestamp at time zone 'Asia/Riyadh'
      and scheduled_at < (v_to + 1)::timestamp at time zone 'Asia/Riyadh'
    order by scheduled_at, id
    limit 300
  ) a;

  return jsonb_build_object(
    'booking_enabled', v_merchant.booking_enabled,
    'sector_code', v_merchant.sector_code,
    'cancel_allowed', v_merchant.booking_cancel_allowed,
    'cancel_cutoff_hours', v_merchant.booking_cancel_cutoff_hours,
    'alerts_enabled', v_merchant.booking_alerts_enabled,
    'from', v_from,
    'to', v_to,
    'rows', v_rows
  );
end;
$$;

revoke execute on function public.merchant_list_reservations(uuid, date, date) from public, anon;
grant execute on function public.merchant_list_reservations(uuid, date, date) to authenticated;

-- Accept (pending → confirmed) or cancel (pending/confirmed → cancelled) one
-- reservation. Owner or staff of the reservation's merchant. The customer's
-- cancellation policy does NOT apply here: the merchant can always cancel.
create or replace function public.merchant_set_reservation_status(p_reservation_id uuid, p_status text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.appointments;
begin
  if p_status is null or p_status not in ('confirmed', 'cancelled') then
    raise exception 'NOJ_INVALID_STATUS';
  end if;

  select * into v_row from public.appointments
  where id = p_reservation_id and booking_kind in ('table', 'service')
  for update;
  if v_row.id is null then
    raise exception 'NOJ_RESERVATION_NOT_FOUND';
  end if;

  if not exists (
    select 1 from public.merchant_members
    where merchant_id = v_row.merchant_id and auth_user_id = auth.uid()
  ) then
    raise exception 'لا تملك صلاحية على هذا التاجر';
  end if;

  if (p_status = 'confirmed' and v_row.status <> 'pending')
     or (p_status = 'cancelled' and v_row.status not in ('pending', 'confirmed')) then
    raise exception 'NOJ_INVALID_TRANSITION';
  end if;

  update public.appointments set status = p_status
  where id = p_reservation_id
  returning * into v_row;

  return public.reservation_json_for_merchant(v_row);
end;
$$;

revoke execute on function public.merchant_set_reservation_status(uuid, text) from public, anon;
grant execute on function public.merchant_set_reservation_status(uuid, text) to authenticated;

-- Turn bookings on/off for a merchant (the restaurant's tables / the services
-- master switch) — OWNER only, restaurant/services
-- only (the health flag keeps its own meaning and is not touched from here).
-- Turning it off cancels nothing: existing reservations stay listed for the
-- merchant (who can still accept/cancel them) and for the customer (who can
-- still cancel); it only stops NEW requests.
create or replace function public.merchant_set_booking_enabled(p_merchant_id uuid, p_enabled boolean)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sector text;
  v_enabled boolean;
begin
  if not exists (
    select 1 from public.merchant_members
    where merchant_id = p_merchant_id and auth_user_id = auth.uid() and role = 'owner'
  ) then
    raise exception 'لا تملك صلاحية على هذا التاجر';
  end if;
  if p_enabled is null then
    raise exception 'NOJ_INVALID_BOOKING_FLAG';
  end if;

  select sector_code into v_sector from public.merchants where id = p_merchant_id;
  if v_sector is null or v_sector not in ('restaurant', 'services') then
    raise exception 'NOJ_BOOKING_NOT_AVAILABLE';
  end if;

  update public.merchants set booking_enabled = p_enabled
  where id = p_merchant_id
  returning booking_enabled into v_enabled;

  return v_enabled;
end;
$$;

revoke execute on function public.merchant_set_booking_enabled(uuid, boolean) from public, anon;
grant execute on function public.merchant_set_booking_enabled(uuid, boolean) to authenticated;

-- Cancellation policy — OWNER only, restaurant/services only. p_cutoff_hours:
-- 0..168 (0 = until the reservation time itself).
create or replace function public.merchant_set_booking_policy(p_merchant_id uuid, p_cancel_allowed boolean, p_cutoff_hours integer)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sector text;
  v_row public.merchants;
begin
  if not exists (
    select 1 from public.merchant_members
    where merchant_id = p_merchant_id and auth_user_id = auth.uid() and role = 'owner'
  ) then
    raise exception 'لا تملك صلاحية على هذا التاجر';
  end if;
  if p_cancel_allowed is null or p_cutoff_hours is null or p_cutoff_hours < 0 or p_cutoff_hours > 168 then
    raise exception 'NOJ_INVALID_CANCEL_POLICY';
  end if;
  select sector_code into v_sector from public.merchants where id = p_merchant_id;
  if v_sector is null or v_sector not in ('restaurant', 'services') then
    raise exception 'NOJ_BOOKING_NOT_AVAILABLE';
  end if;

  update public.merchants
  set booking_cancel_allowed = p_cancel_allowed, booking_cancel_cutoff_hours = p_cutoff_hours
  where id = p_merchant_id
  returning * into v_row;

  return jsonb_build_object('cancel_allowed', v_row.booking_cancel_allowed, 'cancel_cutoff_hours', v_row.booking_cancel_cutoff_hours);
end;
$$;

revoke execute on function public.merchant_set_booking_policy(uuid, boolean, integer) from public, anon;
grant execute on function public.merchant_set_booking_policy(uuid, boolean, integer) to authenticated;

-- New-booking alerts on/off — owner OR staff (an operational switch, like
-- silencing a phone at the counter), saved per merchant.
create or replace function public.merchant_set_booking_alerts(p_merchant_id uuid, p_enabled boolean)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_enabled boolean;
begin
  if not exists (
    select 1 from public.merchant_members
    where merchant_id = p_merchant_id and auth_user_id = auth.uid()
  ) then
    raise exception 'لا تملك صلاحية على هذا التاجر';
  end if;
  if p_enabled is null then
    raise exception 'NOJ_INVALID_BOOKING_FLAG';
  end if;

  update public.merchants set booking_alerts_enabled = p_enabled
  where id = p_merchant_id
  returning booking_alerts_enabled into v_enabled;

  return v_enabled;
end;
$$;

revoke execute on function public.merchant_set_booking_alerts(uuid, boolean) from public, anon;
grant execute on function public.merchant_set_booking_alerts(uuid, boolean) to authenticated;

-- Add (p_service_id NULL) or edit one service — OWNER only, services merchants
-- only. Services are never deleted (reservations point at them): "مفعّلة" off
-- hides one everywhere; booking off keeps it listed but not bookable.
create or replace function public.merchant_save_service(
  p_merchant_id uuid,
  p_service_id uuid,
  p_name text,
  p_price numeric,
  p_is_active boolean,
  p_booking_enabled boolean
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sector text;
  v_name text := btrim(coalesce(p_name, ''));
  v_row public.merchant_services;
begin
  if not exists (
    select 1 from public.merchant_members
    where merchant_id = p_merchant_id and auth_user_id = auth.uid() and role = 'owner'
  ) then
    raise exception 'لا تملك صلاحية على هذا التاجر';
  end if;
  select sector_code into v_sector from public.merchants where id = p_merchant_id;
  if v_sector is null or v_sector <> 'services' then
    raise exception 'NOJ_SERVICES_NOT_AVAILABLE';
  end if;
  if char_length(v_name) < 1 or char_length(v_name) > 80 then
    raise exception 'NOJ_INVALID_SERVICE_NAME';
  end if;
  if p_price is not null and (p_price < 0 or p_price > 1000000) then
    raise exception 'NOJ_INVALID_SERVICE_PRICE';
  end if;
  if p_is_active is null or p_booking_enabled is null then
    raise exception 'NOJ_INVALID_BOOKING_FLAG';
  end if;

  begin
    if p_service_id is null then
      if (select count(*) from public.merchant_services where merchant_id = p_merchant_id) >= 100 then
        raise exception 'NOJ_SERVICE_LIMIT';
      end if;
      insert into public.merchant_services (merchant_id, name, price, is_active, booking_enabled, sort_order)
      values (p_merchant_id, v_name, round(p_price, 2), p_is_active, p_booking_enabled,
              coalesce((select max(sort_order) + 1 from public.merchant_services where merchant_id = p_merchant_id), 0))
      returning * into v_row;
    else
      update public.merchant_services
      set name = v_name, price = round(p_price, 2), is_active = p_is_active,
          booking_enabled = p_booking_enabled, updated_at = now()
      where id = p_service_id and merchant_id = p_merchant_id
      returning * into v_row;
      if v_row.id is null then
        raise exception 'NOJ_SERVICE_NOT_FOUND';
      end if;
    end if;
  exception when unique_violation then
    raise exception 'NOJ_SERVICE_NAME_TAKEN';
  end;

  return jsonb_build_object('id', v_row.id, 'name', v_row.name, 'price', v_row.price,
    'is_active', v_row.is_active, 'booking_enabled', v_row.booking_enabled, 'sort_order', v_row.sort_order);
end;
$$;

revoke execute on function public.merchant_save_service(uuid, uuid, text, numeric, boolean, boolean) from public, anon;
grant execute on function public.merchant_save_service(uuid, uuid, text, numeric, boolean, boolean) to authenticated;

-- ---------------------------------------------------------------------------
-- 5. new-booking alerts (merchant.html listens through Realtime)
-- ---------------------------------------------------------------------------
-- One row per new reservation, no customer data at all. Members of the
-- merchant read their own rows (that is also what Realtime checks before
-- delivering an INSERT); nobody writes except the trigger below.
create table if not exists public.booking_alerts (
  id bigint generated always as identity primary key,
  merchant_id uuid not null references public.merchants(id) on delete cascade,
  appointment_id uuid not null references public.appointments(id) on delete cascade,
  created_at timestamptz not null default now()
);
create index if not exists booking_alerts_merchant_created_idx on public.booking_alerts (merchant_id, created_at);
alter table public.booking_alerts enable row level security;
drop policy if exists "merchant members read their booking alerts" on public.booking_alerts;
create policy "merchant members read their booking alerts"
  on public.booking_alerts for select
  using (exists (
    select 1 from public.merchant_members mm
    where mm.merchant_id = booking_alerts.merchant_id and mm.auth_user_id = auth.uid()
  ));
revoke all on public.booking_alerts from anon, authenticated;
grant select on public.booking_alerts to authenticated;

create or replace function public.booking_alert_on_reservation_trg() returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.booking_kind in ('table', 'service')
     and exists (select 1 from public.merchants where id = new.merchant_id and booking_alerts_enabled) then
    insert into public.booking_alerts (merchant_id, appointment_id) values (new.merchant_id, new.id);
  end if;
  return null;
end;
$$;

revoke all on function public.booking_alert_on_reservation_trg() from public, anon, authenticated, service_role;

drop trigger if exists trg_booking_alert_on_reservation on public.appointments;
create trigger trg_booking_alert_on_reservation
after insert on public.appointments
for each row execute function public.booking_alert_on_reservation_trg();

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'booking_alerts'
    ) then
      alter publication supabase_realtime add table public.booking_alerts;
    end if;
  else
    raise notice 'supabase_realtime publication not found — expected on a local/plain Postgres test db; nothing to do.';
  end if;
end $$;

-- alerts are only "something just arrived" signals: keep a week
create or replace function public.purge_old_booking_alerts() returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_n integer;
begin
  delete from public.booking_alerts where created_at < now() - interval '7 days';
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

revoke all on function public.purge_old_booking_alerts() from public, anon, authenticated, service_role;

do $$
begin
  create extension if not exists pg_cron;
  if exists (select 1 from cron.job where jobname = 'purge-booking-alerts') then
    perform cron.unschedule('purge-booking-alerts');
  end if;
  perform cron.schedule('purge-booking-alerts', '17 3 * * *', $sql$select public.purge_old_booking_alerts();$sql$);
exception when others then
  raise notice 'pg_cron not available/enabled in this environment — enable it from the dashboard (Database → Extensions) and schedule purge_old_booking_alerts() daily there. (%)', sqlerrm;
end $$;
