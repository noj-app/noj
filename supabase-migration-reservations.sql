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

-- ---------------------------------------------------------------------------
-- 2. cancel_appointment(): also withdraws a 'pending' request.
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
--     required) or services (→ 'service', service_type 1..80 chars required);
--     anything else, health included, is NOJ_BOOKING_NOT_AVAILABLE;
--   - merchants.booking_enabled is true (NOJ_BOOKING_DISABLED);
--   - scheduled_at is at least 15 minutes ahead and at most 90 days ahead
--     (NOJ_INVALID_BOOKING_TIME);
--   - optional note, trimmed, at most 300 chars (NOJ_INVALID_BOOKING_NOTE);
--   - at most 3 upcoming (pending/confirmed) reservations per customer per
--     merchant (NOJ_BOOKING_LIMIT) — serialized on the customer's profile row
--     so two concurrent requests cannot both slip under the limit.
-- The field that does not belong to the kind (service_type for a table,
-- party_size for a service) is ignored, not stored.
create or replace function public.create_reservation(
  p_merchant_id uuid,
  p_scheduled_at timestamptz,
  p_party_size integer default null,
  p_service_type text default null,
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
  v_service text;
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
    v_service := nullif(btrim(coalesce(p_service_type, '')), '');
    if v_service is null or char_length(v_service) > 80 then
      raise exception 'NOJ_INVALID_SERVICE_TYPE';
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

  insert into public.appointments (user_id, merchant_id, clinic_id, scheduled_at, status, booking_kind, party_size, service_type, note)
  values (v_profile_id, p_merchant_id, null, p_scheduled_at, 'pending', v_kind, v_party, v_service, v_note)
  returning * into v_row;

  return v_row;
end;
$$;

revoke execute on function public.create_reservation(uuid, timestamptz, integer, text, text) from public, anon;
grant execute on function public.create_reservation(uuid, timestamptz, integer, text, text) to authenticated;

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
    'from', v_from,
    'to', v_to,
    'rows', v_rows
  );
end;
$$;

revoke execute on function public.merchant_list_reservations(uuid, date, date) from public, anon;
grant execute on function public.merchant_list_reservations(uuid, date, date) to authenticated;

-- Accept (pending → confirmed) or cancel (pending/confirmed → cancelled) one
-- reservation. Owner or staff of the reservation's merchant.
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

-- Turn bookings on/off for a merchant — OWNER only, restaurant/services
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
