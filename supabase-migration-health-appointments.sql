-- ============================================================================
-- NOJ — migration: real health appointments ("مواعيدي"), on the SAME booking
-- system as restaurant/services reservations (supabase-migration-reservations.sql)
-- ============================================================================
-- WHAT ALREADY EXISTED: public.appointments (booking_kind 'appointment' = a
-- clinic visit, clinic_id required), public.clinics (booking_enabled per
-- clinic), cancel_appointment(), booking_alerts, the cancellation policy
-- columns on merchants, and the privacy rule "the merchant sees the
-- customer's name + the last 4 digits of the phone, nothing else". Health
-- booking in index.html was still a demo toast.
--
-- WHAT THIS FILE ADDS (additively — no existing row is modified):
--   1. clinics.walk_in_enabled: each bookable clinic is "بموعد فقط" (false) or
--      "بموعد وبدون موعد" (true, the default — what every clinic did before).
--   2. appointments.booked_in_app (true only for rows created by
--      create_appointment below), invoice_id, attended_at, queue_ticket_id.
--      Every existing row reads booked_in_app=false from the default.
--   3. create_appointment(clinic, time, note): the customer books a clinic
--      from the app → a 'pending' row the clinic confirms (same flow as a
--      reservation). Same 15 min .. 90 days window, same 300-char note, same
--      limit of 3 upcoming per customer per merchant.
--   4. The SAME cancel/alert rules as reservations, for app bookings:
--      cancel_appointment() applies the merchant's policy to booked_in_app
--      rows too; merchant_set_booking_policy() now accepts a medical
--      merchant; the alert trigger also fires for booked_in_app rows. Rows
--      that existed before (booked_in_app=false) behave exactly as before.
--      These three function bodies are IDENTICAL in
--      supabase-migration-reservations.sql (and cancel_appointment also in
--      supabase-migration-lockdown-direct-writes.sql) — db-tests compare them,
--      so re-running an older file never takes this back.
--   5. Merchant side: merchant_list_appointments() (owner AND staff; name +
--      last 4 digits only), merchant_set_appointment_status() (owner AND
--      staff: accept / cancel), merchant_set_clinic_booking() (OWNER only:
--      open/close booking per clinic + walk-in mode).
--   6. Arrival through the cashier: when a POS invoice is linked to a
--      registered customer at a medical merchant (the patient entered their
--      phone on شاشة نوج — kiosk_claim_pos_transaction inserts the invoice),
--      a trigger links it to that customer's appointment of the same Riyadh
--      day at that merchant, marks the appointment 'done' ("حضر") and issues
--      the patient's queue number for that clinic (a queue_tickets row).
--      Best-effort: a failure here is a WARNING and never fails the invoice.
--      kiosk_appointment_checkin(txn) lets the kiosk show the appointment
--      card + the queue number right after the claim.
--
-- Grants (Supabase stops auto-granting new public tables, Oct 30 2026): this
-- file creates NO table; every new column is covered by the table-level
-- grants that already exist (appointments/clinics/queue_tickets select).
--
-- Every function: SECURITY DEFINER, pinned search_path, identity from
-- auth.uid(), explicit `revoke ... from public, anon` then `grant ... to
-- authenticated` (internal helpers: revoked from every role).
--
-- Run ONCE after supabase-migration-reservations.sql. Safe to re-run.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. columns
-- ---------------------------------------------------------------------------
alter table public.clinics add column if not exists walk_in_enabled boolean not null default true;

alter table public.appointments add column if not exists booked_in_app boolean not null default false;
alter table public.appointments add column if not exists invoice_id uuid references public.invoices(id) on delete set null;
alter table public.appointments add column if not exists attended_at timestamptz;
alter table public.appointments add column if not exists queue_ticket_id uuid references public.queue_tickets(id) on delete set null;
-- one invoice links to at most one appointment
create unique index if not exists appointments_invoice_id_key on public.appointments (invoice_id) where invoice_id is not null;
-- arrival data belongs to a clinic visit only
alter table public.appointments drop constraint if exists appointments_arrival_kind_chk;
alter table public.appointments add constraint appointments_arrival_kind_chk check (
  (invoice_id is null and attended_at is null and queue_ticket_id is null) or booking_kind = 'appointment'
);

-- ---------------------------------------------------------------------------
-- 2. cancel_appointment(): the merchant's policy now also covers app-booked
--    health appointments. IDENTICAL body in
--    supabase-migration-lockdown-direct-writes.sql and supabase-migration-reservations.sql.
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

  -- 'pending' = a request the merchant has not accepted yet (a reservation, or
  -- a health appointment booked from the app)
  if v_row.status not in ('confirmed', 'pending') then
    raise exception 'لا يمكن إلغاء موعد ليس بحالة مؤكَّدة';
  end if;

  -- a reservation (table/service) and a health appointment booked from the app
  -- (booked_in_app) follow the merchant's cancellation policy
  -- (merchants.booking_cancel_allowed / booking_cancel_cutoff_hours). Read
  -- through to_jsonb() so this SAME body also runs where those columns do not
  -- exist yet (supabase-migration-lockdown-direct-writes.sql alone): there a
  -- row has no booking_kind/booked_in_app, i.e. an older health appointment,
  -- unchanged.
  if coalesce(to_jsonb(v_row)->>'booking_kind', 'appointment') in ('table', 'service')
     or coalesce((to_jsonb(v_row)->>'booked_in_app')::boolean, false) then
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
-- 3. merchant_set_booking_policy(): restaurant, services AND medical.
--    IDENTICAL body in supabase-migration-reservations.sql.
-- ---------------------------------------------------------------------------
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
  -- medical: the policy applies to health appointments booked from the app
  -- (supabase-migration-health-appointments.sql)
  if v_sector is null or v_sector not in ('restaurant', 'services', 'medical') then
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

-- ---------------------------------------------------------------------------
-- 4. new-booking alert: also for a health appointment booked from the app.
--    IDENTICAL body in supabase-migration-reservations.sql (booked_in_app read
--    through to_jsonb so that file alone still works).
-- ---------------------------------------------------------------------------
create or replace function public.booking_alert_on_reservation_trg() returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if (new.booking_kind in ('table', 'service') or coalesce((to_jsonb(new)->>'booked_in_app')::boolean, false))
     and exists (select 1 from public.merchants where id = new.merchant_id and booking_alerts_enabled) then
    insert into public.booking_alerts (merchant_id, appointment_id) values (new.merchant_id, new.id);
  end if;
  return null;
end;
$$;

revoke all on function public.booking_alert_on_reservation_trg() from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 5. create_appointment(): the customer books a clinic from the app
-- ---------------------------------------------------------------------------
-- Rules (each failure is a NOJ_* code index.html translates):
--   - the caller has a (non-deleted) profile;
--   - the clinic exists (NOJ_CLINIC_NOT_FOUND) and belongs to a medical
--     merchant (else NOJ_BOOKING_NOT_AVAILABLE);
--   - merchants.booking_enabled (NOJ_BOOKING_DISABLED) and the clinic's own
--     booking_enabled (NOJ_CLINIC_BOOKING_CLOSED);
--   - 15 minutes .. 90 days ahead (NOJ_INVALID_BOOKING_TIME), note <= 300
--     chars (NOJ_INVALID_BOOKING_NOTE);
--   - at most 3 upcoming (pending/confirmed) health appointments per customer
--     per merchant (NOJ_BOOKING_LIMIT), serialized on the profile row.
create or replace function public.create_appointment(
  p_clinic_id uuid,
  p_scheduled_at timestamptz,
  p_note text default null
)
returns public.appointments
language plpgsql
security definer
set search_path = public
as $$
declare
  v_profile_id uuid;
  v_clinic public.clinics;
  v_merchant public.merchants;
  v_note text;
  v_active integer;
  v_row public.appointments;
begin
  select id into v_profile_id from public.profiles
  where auth_user_id = auth.uid() and deleted_at is null;
  if v_profile_id is null then
    raise exception 'لم يتم العثور على ملفك الشخصي';
  end if;

  select * into v_clinic from public.clinics where id = p_clinic_id;
  if v_clinic.id is null then
    raise exception 'NOJ_CLINIC_NOT_FOUND';
  end if;
  select * into v_merchant from public.merchants where id = v_clinic.merchant_id;
  if v_merchant.sector_code is distinct from 'medical' then
    raise exception 'NOJ_BOOKING_NOT_AVAILABLE';
  end if;
  if not v_merchant.booking_enabled then
    raise exception 'NOJ_BOOKING_DISABLED';
  end if;
  if not v_clinic.booking_enabled then
    raise exception 'NOJ_CLINIC_BOOKING_CLOSED';
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

  perform 1 from public.profiles where id = v_profile_id for update;

  select count(*) into v_active
  from public.appointments
  where user_id = v_profile_id and merchant_id = v_merchant.id
    and booking_kind = 'appointment'
    and status in ('pending', 'confirmed')
    and scheduled_at >= now();
  if v_active >= 3 then
    raise exception 'NOJ_BOOKING_LIMIT';
  end if;

  insert into public.appointments (user_id, merchant_id, clinic_id, scheduled_at, status, booking_kind, note, booked_in_app)
  values (v_profile_id, v_merchant.id, v_clinic.id, p_scheduled_at, 'pending', 'appointment', v_note, true)
  returning * into v_row;

  return v_row;
end;
$$;

revoke execute on function public.create_appointment(uuid, timestamptz, text) from public, anon;
grant execute on function public.create_appointment(uuid, timestamptz, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 6. merchant side (merchant.html "المواعيد" tab, medical merchants)
-- ---------------------------------------------------------------------------
-- One health appointment as the dashboard sees it — a closed list of keys:
-- the customer's name and the LAST 4 digits of the phone only (same rule as
-- reservations); no user_id, no profile id, no full phone.
create or replace function public.appointment_json_for_merchant(p_row public.appointments)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'id', p_row.id,
    'status', p_row.status,
    'scheduled_at', p_row.scheduled_at,
    'scheduled_at_riyadh', to_char(p_row.scheduled_at at time zone 'Asia/Riyadh', 'YYYY-MM-DD HH24:MI'),
    'clinic_id', p_row.clinic_id,
    'clinic_name', c.name,
    'doctor_name', c.doctor_name,
    'note', p_row.note,
    'booked_in_app', p_row.booked_in_app,
    'attended_at_riyadh', to_char(p_row.attended_at at time zone 'Asia/Riyadh', 'YYYY-MM-DD HH24:MI'),
    'queue_number', q.ticket_number,
    'invoice_amount', i.amount,
    'created_at', p_row.created_at,
    'customer_name', case when p.deleted_at is null then p.name end,
    'customer_phone_last4', case when p.deleted_at is null and p.phone ~ '^5[0-9]{8}$' then right(p.phone, 4) end
  )
  from (select 1) one
  left join public.profiles p on p.id = p_row.user_id
  left join public.clinics c on c.id = p_row.clinic_id
  left join public.queue_tickets q on q.id = p_row.queue_ticket_id
  left join public.invoices i on i.id = p_row.invoice_id;
$$;

revoke all on function public.appointment_json_for_merchant(public.appointments) from public, anon, authenticated, service_role;

-- Health appointments of one medical merchant between two Riyadh calendar
-- dates (inclusive; default today .. today + 90), soonest first, every status
-- (older rows booked outside the app included), at most 300. Owner or staff.
-- Also returns the clinics (booking + walk-in mode) and the merchant's
-- booking settings, so the screen knows what to offer.
create or replace function public.merchant_list_appointments(
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
  v_clinics jsonb;
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
  if v_merchant.sector_code is distinct from 'medical' then
    raise exception 'NOJ_BOOKING_NOT_AVAILABLE';
  end if;

  select coalesce(jsonb_agg(public.appointment_json_for_merchant(a) order by a.scheduled_at, a.id), '[]'::jsonb)
  into v_rows
  from (
    select * from public.appointments
    where merchant_id = p_merchant_id
      and booking_kind = 'appointment'
      and scheduled_at >= v_from::timestamp at time zone 'Asia/Riyadh'
      and scheduled_at < (v_to + 1)::timestamp at time zone 'Asia/Riyadh'
    order by scheduled_at, id
    limit 300
  ) a;

  select coalesce(jsonb_agg(jsonb_build_object(
      'id', c.id, 'name', c.name, 'doctor_name', c.doctor_name,
      'booking_enabled', c.booking_enabled, 'walk_in_enabled', c.walk_in_enabled
    ) order by c.sort_order, c.name), '[]'::jsonb)
  into v_clinics
  from public.clinics c where c.merchant_id = p_merchant_id;

  return jsonb_build_object(
    'booking_enabled', v_merchant.booking_enabled,
    'sector_code', v_merchant.sector_code,
    'cancel_allowed', v_merchant.booking_cancel_allowed,
    'cancel_cutoff_hours', v_merchant.booking_cancel_cutoff_hours,
    'alerts_enabled', v_merchant.booking_alerts_enabled,
    'from', v_from,
    'to', v_to,
    'clinics', v_clinics,
    'rows', v_rows
  );
end;
$$;

revoke execute on function public.merchant_list_appointments(uuid, date, date) from public, anon;
grant execute on function public.merchant_list_appointments(uuid, date, date) to authenticated;

-- Accept (pending → confirmed) or cancel (pending/confirmed → cancelled) one
-- health appointment. Owner or staff. The customer's cancellation policy does
-- NOT apply: the clinic can always cancel. "حضر" ('done') is never set here —
-- only by the patient's arrival through the cashier (section 7).
create or replace function public.merchant_set_appointment_status(p_appointment_id uuid, p_status text)
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
  where id = p_appointment_id and booking_kind = 'appointment'
  for update;
  if v_row.id is null then
    raise exception 'NOJ_APPOINTMENT_NOT_FOUND';
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
  where id = p_appointment_id
  returning * into v_row;

  return public.appointment_json_for_merchant(v_row);
end;
$$;

revoke execute on function public.merchant_set_appointment_status(uuid, text) from public, anon;
grant execute on function public.merchant_set_appointment_status(uuid, text) to authenticated;

-- Open/close booking for ONE clinic, and its walk-in mode ("بموعد فقط" when
-- p_walk_in_enabled is false) — OWNER only, medical merchants only. Closing
-- cancels nothing: existing appointments stay listed for both sides.
create or replace function public.merchant_set_clinic_booking(p_clinic_id uuid, p_booking_enabled boolean, p_walk_in_enabled boolean)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_clinic public.clinics;
  v_sector text;
begin
  select * into v_clinic from public.clinics where id = p_clinic_id;
  if v_clinic.id is null then
    raise exception 'NOJ_CLINIC_NOT_FOUND';
  end if;
  if not exists (
    select 1 from public.merchant_members
    where merchant_id = v_clinic.merchant_id and auth_user_id = auth.uid() and role = 'owner'
  ) then
    raise exception 'لا تملك صلاحية على هذا التاجر';
  end if;
  if p_booking_enabled is null or p_walk_in_enabled is null then
    raise exception 'NOJ_INVALID_BOOKING_FLAG';
  end if;
  select sector_code into v_sector from public.merchants where id = v_clinic.merchant_id;
  if v_sector is distinct from 'medical' then
    raise exception 'NOJ_BOOKING_NOT_AVAILABLE';
  end if;

  update public.clinics
  set booking_enabled = p_booking_enabled, walk_in_enabled = p_walk_in_enabled
  where id = p_clinic_id
  returning * into v_clinic;

  return jsonb_build_object('id', v_clinic.id, 'name', v_clinic.name, 'doctor_name', v_clinic.doctor_name,
    'booking_enabled', v_clinic.booking_enabled, 'walk_in_enabled', v_clinic.walk_in_enabled);
end;
$$;

revoke execute on function public.merchant_set_clinic_booking(uuid, boolean, boolean) from public, anon;
grant execute on function public.merchant_set_clinic_booking(uuid, boolean, boolean) to authenticated;

-- ---------------------------------------------------------------------------
-- 7. arrival through the cashier: invoice → that day's appointment, "حضر",
--    and the patient's queue number for the clinic
-- ---------------------------------------------------------------------------
-- Internal (no client, no service_role). Picks, for the invoice's customer at
-- the invoice's merchant, the not-yet-linked confirmed (else pending) health
-- appointment of the invoice's Riyadh day, closest to the invoice time. The
-- queue number is the next number of that clinic's queue for the day.
create or replace function public.link_invoice_to_appointment(p_invoice_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_inv public.invoices;
  v_sector text;
  v_appt public.appointments;
  v_clinic public.clinics;
  v_day date;
  v_number integer;
  v_position integer;
  v_ticket uuid;
begin
  select * into v_inv from public.invoices where id = p_invoice_id;
  if v_inv.id is null or v_inv.user_id is null then
    return null;
  end if;
  select sector_code into v_sector from public.merchants where id = v_inv.merchant_id;
  if v_sector is distinct from 'medical' then
    return null;
  end if;
  if exists (select 1 from public.appointments where invoice_id = v_inv.id) then
    return null;
  end if;

  v_day := (v_inv.created_at at time zone 'Asia/Riyadh')::date;

  select * into v_appt from public.appointments a
  where a.user_id = v_inv.user_id
    and a.merchant_id = v_inv.merchant_id
    and a.booking_kind = 'appointment'
    and a.status in ('confirmed', 'pending')
    and a.invoice_id is null
    and (a.scheduled_at at time zone 'Asia/Riyadh')::date = v_day
  order by (a.status = 'confirmed') desc, abs(extract(epoch from a.scheduled_at - v_inv.created_at)), a.id
  limit 1
  for update;
  if v_appt.id is null then
    return null;
  end if;

  select * into v_clinic from public.clinics where id = v_appt.clinic_id;

  -- one queue at a time per clinic: concurrent arrivals never share a number
  perform pg_advisory_xact_lock(hashtextextended('noj-queue|' || v_inv.merchant_id::text || '|' || coalesce(v_clinic.name, ''), 0));

  select coalesce(max(ticket_number), 0) + 1 into v_number
  from public.queue_tickets
  where merchant_id = v_inv.merchant_id and unit_name is not distinct from v_clinic.name
    and (created_at at time zone 'Asia/Riyadh')::date = v_day;
  select count(*) + 1 into v_position
  from public.queue_tickets
  where merchant_id = v_inv.merchant_id and unit_name is not distinct from v_clinic.name
    and status = 'waiting' and (created_at at time zone 'Asia/Riyadh')::date = v_day;

  insert into public.queue_tickets (user_id, merchant_id, ticket_number, unit_name, position, est_minutes, status)
  values (v_inv.user_id, v_inv.merchant_id, v_number, v_clinic.name, v_position, 0, 'waiting')
  returning id into v_ticket;

  update public.appointments
  set status = 'done', attended_at = now(), invoice_id = v_inv.id, queue_ticket_id = v_ticket
  where id = v_appt.id;

  return v_appt.id;
end;
$$;

revoke all on function public.link_invoice_to_appointment(uuid) from public, anon, authenticated, service_role;

-- Best-effort, like the POS connection mirror: anything going wrong here is a
-- WARNING inside a sub-transaction, never a failed invoice / failed claim.
create or replace function public.invoice_appointment_checkin_trg() returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.user_id is not null and new.source = 'pos' then
    begin
      perform public.link_invoice_to_appointment(new.id);
    exception when others then
      raise warning 'NOJ appointment check-in skipped for invoice %: %', new.id, sqlerrm;
    end;
  end if;
  return null;
end;
$$;

revoke all on function public.invoice_appointment_checkin_trg() from public, anon, authenticated, service_role;

drop trigger if exists trg_invoice_appointment_checkin on public.invoices;
create trigger trg_invoice_appointment_checkin
after insert on public.invoices
for each row execute function public.invoice_appointment_checkin_trg();

-- What شاشة نوج shows right after the patient entered their phone: the
-- appointment card and the queue number — for a transaction THIS device just
-- applied (last 30 minutes), only if it was linked to an appointment. No name,
-- no phone. Returns NULL when there is nothing to show.
create or replace function public.kiosk_appointment_checkin(p_transaction_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_device public.devices;
  v_txn public.pos_transactions;
  v_appt public.appointments;
  v_clinic public.clinics;
  v_ticket public.queue_tickets;
  v_ahead integer;
begin
  select * into v_device from public.devices
  where auth_user_id = auth.uid() and is_active and revoked_at is null;
  if v_device.id is null or v_device.branch_id is null then
    raise exception 'الجهاز غير مقارَن بفرع بعد';
  end if;

  select * into v_txn from public.pos_transactions where id = p_transaction_id;
  if v_txn.id is null
     or v_txn.branch_id <> v_device.branch_id
     or (v_txn.device_id is not null and v_txn.device_id <> v_device.id) then
    raise exception 'NOJ_TRANSACTION_NOT_FOUND';
  end if;
  if v_txn.status <> 'applied' or v_txn.invoice_id is null
     or v_txn.applied_at is null or v_txn.applied_at < now() - interval '30 minutes' then
    return null;
  end if;

  select * into v_appt from public.appointments where invoice_id = v_txn.invoice_id;
  if v_appt.id is null then
    return null;
  end if;
  select * into v_clinic from public.clinics where id = v_appt.clinic_id;
  select * into v_ticket from public.queue_tickets where id = v_appt.queue_ticket_id;

  if v_ticket.id is not null then
    select count(*) into v_ahead from public.queue_tickets
    where merchant_id = v_ticket.merchant_id and unit_name is not distinct from v_ticket.unit_name
      and status = 'waiting' and ticket_number < v_ticket.ticket_number
      and (created_at at time zone 'Asia/Riyadh')::date = (v_ticket.created_at at time zone 'Asia/Riyadh')::date;
  end if;

  return jsonb_build_object(
    'clinic_name', v_clinic.name,
    'doctor_name', v_clinic.doctor_name,
    'scheduled_at', v_appt.scheduled_at,
    'scheduled_time_riyadh', to_char(v_appt.scheduled_at at time zone 'Asia/Riyadh', 'HH24:MI'),
    'queue_number', v_ticket.ticket_number,
    'ahead', v_ahead
  );
end;
$$;

revoke execute on function public.kiosk_appointment_checkin(uuid) from public, anon;
grant execute on function public.kiosk_appointment_checkin(uuid) to authenticated;
