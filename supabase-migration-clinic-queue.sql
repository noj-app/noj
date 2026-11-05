-- ============================================================================
-- NOJ — migration: the clinic queue ("طابور العيادات")
-- ============================================================================
-- Builds on supabase-migration-health-appointments.sql WITHOUT touching its
-- appointment logic: link_invoice_to_appointment(), its trigger,
-- kiosk_appointment_checkin() and every other function of that file are not
-- redefined here.
--
-- WHAT THIS FILE ADDS (additively — the only existing rows touched are
-- queue_tickets whose new clinic_id is filled from their clinic name):
--   1. clinics.pos_unit_code: the clinic's code in the merchant's cashier
--      system, unique inside the merchant (case-insensitive). Set by the
--      OWNER through merchant_set_clinic_pos_code().
--   2. A patient WITHOUT an appointment that day gets a queue number when
--      the cashier sent that code with the invoice: pos-intake carries the
--      body's "unit_code" inside pos_transactions.metadata.unit_code (no new
--      parameter on intake_pos_transaction()). When the patient enters their
--      phone on شاشة نوج and the POS invoice is created for a registered
--      customer at a medical merchant, a SECOND invoice trigger — firing after
--      the appointment trigger of #112 — issues a ticket in that clinic's
--      queue, but only if: no appointment was linked to this invoice, the code
--      matches one of the merchant's clinics, and that clinic takes walk-ins
--      ("بموعد وبدون موعد" / walk_in_enabled). Appointment-only clinics, a
--      missing or unknown code: the invoice is recorded, no number. Never a
--      failed invoice: best-effort, any error is a WARNING.
--   3. The day's queue for the merchant: merchant_clinic_queue() (owner AND
--      staff; patient name + last 4 digits only), merchant_queue_call_next()
--      and merchant_queue_set_ticket_status() ("انتهى" = done, "لم يحضر" =
--      no_show — a new ticket status).
--   4. Live "أمامك X": clinic_queue_state — ONE aggregate row per clinic (the
--      day, now serving, waiting count; no customer data) kept up to date by a
--      trigger on queue_tickets and published to Realtime. The app and the
--      dashboard listen to it and re-read through get_my_queue_status() /
--      merchant_clinic_queue() (with a polling fallback).
--   5. kiosk_queue_checkin(txn): what شاشة نوج shows for a walk-in ticket
--      (clinic, doctor, number, ahead) — the walk-in twin of #112's
--      kiosk_appointment_checkin(), which is left as it is.
--
-- Queue numbers: one queue per clinic per Riyadh day, shared by appointment
-- arrivals (#112) and walk-ins — the same numbering rule (largest number of
-- the day + 1) under the same advisory lock key, so the two paths never hand
-- out the same number.
--
-- GRANTS (Supabase stops auto-granting new public tables, Oct 30 2026): the
-- one new table, clinic_queue_state, is granted HERE, minimally: SELECT to
-- authenticated (an aggregate any signed-in session — app or kiosk — may read,
-- like get_merchant_clinics()), nothing to anon, nothing to service_role, no
-- write grant to anyone (only the trigger writes it). New columns on existing
-- tables ride on their existing grants.
--
-- Every function: SECURITY DEFINER, pinned search_path, identity from
-- auth.uid(); client RPCs `revoke ... from public, anon` then `grant ... to
-- authenticated`, internal helpers revoked from every role.
--
-- Run ONCE after supabase-migration-explicit-table-grants.sql. Safe to re-run.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. columns
-- ---------------------------------------------------------------------------
alter table public.clinics add column if not exists pos_unit_code text;
alter table public.clinics drop constraint if exists clinics_pos_unit_code_chk;
alter table public.clinics add constraint clinics_pos_unit_code_chk check (
  pos_unit_code is null or (char_length(pos_unit_code) between 1 and 40 and pos_unit_code = btrim(pos_unit_code))
);
create unique index if not exists clinics_merchant_pos_unit_code_key
  on public.clinics (merchant_id, lower(pos_unit_code)) where pos_unit_code is not null;

alter table public.queue_tickets add column if not exists clinic_id uuid references public.clinics(id) on delete set null;
alter table public.queue_tickets add column if not exists invoice_id uuid references public.invoices(id) on delete set null;
alter table public.queue_tickets add column if not exists called_at timestamptz;
alter table public.queue_tickets add column if not exists finished_at timestamptz;
create unique index if not exists queue_tickets_invoice_id_key on public.queue_tickets (invoice_id) where invoice_id is not null;
create index if not exists queue_tickets_clinic_created_idx on public.queue_tickets (clinic_id, created_at);

-- "لم يحضر": a new ticket status. Drop whatever status CHECK exists (the
-- original inline one is auto-named), then the full set of values.
do $$
declare r record;
begin
  for r in
    select conname from pg_constraint
    where conrelid = 'public.queue_tickets'::regclass and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%status%'
  loop
    execute format('alter table public.queue_tickets drop constraint %I', r.conname);
  end loop;
end $$;
alter table public.queue_tickets add constraint queue_tickets_status_check
  check (status in ('waiting', 'called', 'done', 'cancelled', 'no_show'));

-- every ticket of a clinic queue knows its clinic: tickets created by #112's
-- arrival function carry only unit_name (the clinic name) — resolve it here
-- instead of changing that function
create or replace function public.queue_ticket_resolve_clinic_trg() returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.clinic_id is null and new.unit_name is not null then
    select id into new.clinic_id from public.clinics
    where merchant_id = new.merchant_id and name = new.unit_name
    order by sort_order, id
    limit 1;
  end if;
  return new;
end;
$$;
revoke all on function public.queue_ticket_resolve_clinic_trg() from public, anon, authenticated, service_role;
drop trigger if exists trg_queue_ticket_resolve_clinic on public.queue_tickets;
create trigger trg_queue_ticket_resolve_clinic
before insert on public.queue_tickets
for each row execute function public.queue_ticket_resolve_clinic_trg();

-- ---------------------------------------------------------------------------
-- 2. clinic_queue_state: the live, customer-free aggregate per clinic
-- ---------------------------------------------------------------------------
create table if not exists public.clinic_queue_state (
  clinic_id uuid primary key references public.clinics(id) on delete cascade,
  merchant_id uuid not null references public.merchants(id) on delete cascade,
  day date not null,
  now_serving integer,
  waiting_count integer not null default 0,
  updated_at timestamptz not null default now()
);
create index if not exists clinic_queue_state_merchant_idx on public.clinic_queue_state (merchant_id);
alter table public.clinic_queue_state enable row level security;
drop policy if exists "signed-in sessions read the clinic queue aggregate" on public.clinic_queue_state;
create policy "signed-in sessions read the clinic queue aggregate"
  on public.clinic_queue_state for select
  to authenticated
  using (true);
-- explicit, minimal grants (no default grants for new tables): read for
-- authenticated only; nobody writes but the trigger below
revoke all on public.clinic_queue_state from public, anon, authenticated, service_role;
grant select on public.clinic_queue_state to authenticated;

-- recompute one clinic's row for today (Riyadh); internal
create or replace function public.refresh_clinic_queue_state(p_clinic_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_merchant uuid;
  v_day date := public.riyadh_today();
  v_now integer;
  v_waiting integer;
begin
  select merchant_id into v_merchant from public.clinics where id = p_clinic_id;
  if v_merchant is null then
    return;
  end if;
  select max(ticket_number) filter (where status in ('called', 'done')),
         count(*) filter (where status = 'waiting')
  into v_now, v_waiting
  from public.queue_tickets
  where clinic_id = p_clinic_id and (created_at at time zone 'Asia/Riyadh')::date = v_day;

  insert into public.clinic_queue_state (clinic_id, merchant_id, day, now_serving, waiting_count, updated_at)
  values (p_clinic_id, v_merchant, v_day, v_now, coalesce(v_waiting, 0), now())
  on conflict (clinic_id) do update
    set merchant_id = excluded.merchant_id, day = excluded.day, now_serving = excluded.now_serving,
        waiting_count = excluded.waiting_count, updated_at = excluded.updated_at;
end;
$$;
revoke all on function public.refresh_clinic_queue_state(uuid) from public, anon, authenticated, service_role;

-- best-effort: the aggregate is a convenience for screens, never a reason for a
-- ticket insert/update to fail
create or replace function public.queue_ticket_state_trg() returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  begin
    if tg_op in ('INSERT', 'UPDATE') and new.clinic_id is not null then
      perform public.refresh_clinic_queue_state(new.clinic_id);
    end if;
    if tg_op in ('UPDATE', 'DELETE') and old.clinic_id is not null
       and (tg_op = 'DELETE' or old.clinic_id is distinct from new.clinic_id) then
      perform public.refresh_clinic_queue_state(old.clinic_id);
    end if;
  exception when others then
    raise warning 'NOJ clinic queue state not refreshed: %', sqlerrm;
  end;
  return null;
end;
$$;
revoke all on function public.queue_ticket_state_trg() from public, anon, authenticated, service_role;
drop trigger if exists trg_queue_ticket_state on public.queue_tickets;
create trigger trg_queue_ticket_state
after insert or update or delete on public.queue_tickets
for each row execute function public.queue_ticket_state_trg();

-- tickets issued before this file (e.g. #112 arrivals earlier today) learn
-- their clinic the same way the BEFORE INSERT trigger above does; only rows
-- whose clinic_id is still NULL are touched, so a re-run changes nothing.
-- The state trigger fills clinic_queue_state for them on the way.
update public.queue_tickets t
set clinic_id = c.id
from public.clinics c
where t.clinic_id is null and t.unit_name is not null
  and c.merchant_id = t.merchant_id and c.name = t.unit_name
  and c.id = (select c2.id from public.clinics c2
              where c2.merchant_id = t.merchant_id and c2.name = t.unit_name
              order by c2.sort_order, c2.id limit 1);

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'clinic_queue_state'
    ) then
      alter publication supabase_realtime add table public.clinic_queue_state;
    end if;
  else
    raise notice 'supabase_realtime publication not found — expected on a local/plain Postgres test db; nothing to do.';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 3. walk-in tickets from the cashier's clinic code
-- ---------------------------------------------------------------------------
-- Internal. Issues the walk-in ticket for one POS invoice, or returns NULL
-- when there is nothing to issue (see the header for every case).
create or replace function public.issue_walk_in_ticket(p_invoice_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_inv public.invoices;
  v_sector text;
  v_code text;
  v_clinic public.clinics;
  v_day date;
  v_number integer;
  v_position integer;
  v_ticket uuid;
begin
  select * into v_inv from public.invoices where id = p_invoice_id;
  if v_inv.id is null or v_inv.user_id is null or v_inv.source is distinct from 'pos' then
    return null;
  end if;
  select sector_code into v_sector from public.merchants where id = v_inv.merchant_id;
  if v_sector is distinct from 'medical' then
    return null;
  end if;
  -- the patient's appointment of the day decides (supabase-migration-health-appointments.sql)
  if exists (select 1 from public.appointments where invoice_id = v_inv.id) then
    return null;
  end if;
  if exists (select 1 from public.queue_tickets where invoice_id = v_inv.id) then
    return null;
  end if;

  select nullif(btrim(t.metadata->>'unit_code'), '') into v_code
  from public.pos_transactions t
  where t.branch_id = v_inv.branch_id and t.external_ref = v_inv.external_ref;
  if v_code is null then
    return null;
  end if;

  select * into v_clinic from public.clinics
  where merchant_id = v_inv.merchant_id and lower(pos_unit_code) = lower(v_code);
  if v_clinic.id is null or not v_clinic.walk_in_enabled then
    return null;
  end if;

  v_day := (v_inv.created_at at time zone 'Asia/Riyadh')::date;

  -- the SAME lock key and numbering rule as #112's appointment arrivals: one
  -- queue per clinic per day, never a shared number
  perform pg_advisory_xact_lock(hashtextextended('noj-queue|' || v_inv.merchant_id::text || '|' || coalesce(v_clinic.name, ''), 0));

  select coalesce(max(ticket_number), 0) + 1 into v_number
  from public.queue_tickets
  where merchant_id = v_inv.merchant_id and unit_name is not distinct from v_clinic.name
    and (created_at at time zone 'Asia/Riyadh')::date = v_day;
  select count(*) + 1 into v_position
  from public.queue_tickets
  where merchant_id = v_inv.merchant_id and unit_name is not distinct from v_clinic.name
    and status = 'waiting' and (created_at at time zone 'Asia/Riyadh')::date = v_day;

  insert into public.queue_tickets (user_id, merchant_id, ticket_number, unit_name, position, est_minutes, status, clinic_id, invoice_id)
  values (v_inv.user_id, v_inv.merchant_id, v_number, v_clinic.name, v_position, 0, 'waiting', v_clinic.id, v_inv.id)
  returning id into v_ticket;

  return v_ticket;
end;
$$;
revoke all on function public.issue_walk_in_ticket(uuid) from public, anon, authenticated, service_role;

-- AFTER INSERT on invoices, named so it fires AFTER #112's
-- trg_invoice_appointment_checkin (same timing, alphabetical order): by then a
-- matching appointment, if any, is already linked to this invoice.
create or replace function public.invoice_walk_in_queue_trg() returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.user_id is not null and new.source = 'pos' then
    begin
      perform public.issue_walk_in_ticket(new.id);
    exception when others then
      raise warning 'NOJ walk-in queue number skipped for invoice %: %', new.id, sqlerrm;
    end;
  end if;
  return null;
end;
$$;
revoke all on function public.invoice_walk_in_queue_trg() from public, anon, authenticated, service_role;
drop trigger if exists trg_invoice_walk_in_queue on public.invoices;
create trigger trg_invoice_walk_in_queue
after insert on public.invoices
for each row execute function public.invoice_walk_in_queue_trg();

-- What شاشة نوج shows for a WALK-IN ticket of a transaction THIS device just
-- applied (last 30 minutes). NULL when there is none. No name, no phone.
create or replace function public.kiosk_queue_checkin(p_transaction_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_device public.devices;
  v_txn public.pos_transactions;
  v_ticket public.queue_tickets;
  v_clinic public.clinics;
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

  select * into v_ticket from public.queue_tickets where invoice_id = v_txn.invoice_id;
  if v_ticket.id is null then
    return null;
  end if;
  select * into v_clinic from public.clinics where id = v_ticket.clinic_id;
  select count(*) into v_ahead from public.queue_tickets
  where clinic_id = v_ticket.clinic_id and status = 'waiting' and ticket_number < v_ticket.ticket_number
    and (created_at at time zone 'Asia/Riyadh')::date = (v_ticket.created_at at time zone 'Asia/Riyadh')::date;

  return jsonb_build_object(
    'clinic_name', v_clinic.name,
    'doctor_name', v_clinic.doctor_name,
    'queue_number', v_ticket.ticket_number,
    'ahead', v_ahead
  );
end;
$$;
revoke execute on function public.kiosk_queue_checkin(uuid) from public, anon;
grant execute on function public.kiosk_queue_checkin(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. the customer's live tickets (تطبيق نوج)
-- ---------------------------------------------------------------------------
-- The caller's own clinic tickets of today that are still waiting or called,
-- with how many waiting patients are ahead and the number now being served.
-- Aggregates only — never another patient's ticket.
create or replace function public.get_my_queue_status()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_profile_id uuid;
  v_rows jsonb;
begin
  select id into v_profile_id from public.profiles where auth_user_id = auth.uid() and deleted_at is null;
  if v_profile_id is null then
    return '[]'::jsonb;
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
      'ticket_id', t.id,
      'merchant_id', t.merchant_id,
      'merchant_name', m.name,
      'clinic_id', t.clinic_id,
      'clinic_name', c.name,
      'doctor_name', c.doctor_name,
      'ticket_number', t.ticket_number,
      'status', t.status,
      'ahead', case when t.status = 'waiting' then (
          select count(*) from public.queue_tickets o
          where o.clinic_id = t.clinic_id and o.status = 'waiting' and o.ticket_number < t.ticket_number
            and (o.created_at at time zone 'Asia/Riyadh')::date = (t.created_at at time zone 'Asia/Riyadh')::date
        ) else 0 end,
      'now_serving', (
          select max(o.ticket_number) from public.queue_tickets o
          where o.clinic_id = t.clinic_id and o.status in ('called', 'done')
            and (o.created_at at time zone 'Asia/Riyadh')::date = (t.created_at at time zone 'Asia/Riyadh')::date
        )
    ) order by t.created_at desc), '[]'::jsonb)
  into v_rows
  from public.queue_tickets t
  join public.clinics c on c.id = t.clinic_id
  join public.merchants m on m.id = t.merchant_id
  where t.user_id = v_profile_id
    and t.status in ('waiting', 'called')
    and (t.created_at at time zone 'Asia/Riyadh')::date = public.riyadh_today();

  return v_rows;
end;
$$;
revoke execute on function public.get_my_queue_status() from public, anon;
grant execute on function public.get_my_queue_status() to authenticated;

-- ---------------------------------------------------------------------------
-- 5. merchant side (merchant.html "الطابور" tab, medical merchants)
-- ---------------------------------------------------------------------------
-- One ticket as the dashboard sees it — a closed list of keys: the patient's
-- name and the LAST 4 digits of the phone only.
create or replace function public.queue_ticket_json_for_merchant(p_row public.queue_tickets)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'id', p_row.id,
    'clinic_id', p_row.clinic_id,
    'ticket_number', p_row.ticket_number,
    'status', p_row.status,
    'kind', case when exists (select 1 from public.appointments a where a.queue_ticket_id = p_row.id) then 'appointment' else 'walk_in' end,
    'created_at_riyadh', to_char(p_row.created_at at time zone 'Asia/Riyadh', 'HH24:MI'),
    'called_at_riyadh', to_char(p_row.called_at at time zone 'Asia/Riyadh', 'HH24:MI'),
    'customer_name', case when p.deleted_at is null then p.name end,
    'customer_phone_last4', case when p.deleted_at is null and p.phone ~ '^5[0-9]{8}$' then right(p.phone, 4) end
  )
  from (select 1) one
  left join public.profiles p on p.id = p_row.user_id;
$$;
revoke all on function public.queue_ticket_json_for_merchant(public.queue_tickets) from public, anon, authenticated, service_role;

-- Today's queue of every clinic of one medical merchant. Owner or staff.
create or replace function public.merchant_clinic_queue(p_merchant_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_sector text;
  v_day date := public.riyadh_today();
  v_clinics jsonb;
begin
  if not exists (
    select 1 from public.merchant_members
    where merchant_id = p_merchant_id and auth_user_id = auth.uid()
  ) then
    raise exception 'لا تملك صلاحية على هذا التاجر';
  end if;
  select sector_code into v_sector from public.merchants where id = p_merchant_id;
  if v_sector is distinct from 'medical' then
    raise exception 'NOJ_BOOKING_NOT_AVAILABLE';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
      'id', c.id,
      'name', c.name,
      'doctor_name', c.doctor_name,
      'booking_enabled', c.booking_enabled,
      'walk_in_enabled', c.walk_in_enabled,
      'pos_unit_code', c.pos_unit_code,
      'now_serving', (select max(t.ticket_number) from public.queue_tickets t
                      where t.clinic_id = c.id and t.status in ('called', 'done')
                        and (t.created_at at time zone 'Asia/Riyadh')::date = v_day),
      'done_count', (select count(*) from public.queue_tickets t
                     where t.clinic_id = c.id and t.status = 'done'
                       and (t.created_at at time zone 'Asia/Riyadh')::date = v_day),
      'no_show_count', (select count(*) from public.queue_tickets t
                        where t.clinic_id = c.id and t.status = 'no_show'
                          and (t.created_at at time zone 'Asia/Riyadh')::date = v_day),
      'tickets', (select coalesce(jsonb_agg(public.queue_ticket_json_for_merchant(t) order by t.ticket_number), '[]'::jsonb)
                  from public.queue_tickets t
                  where t.clinic_id = c.id and t.status in ('waiting', 'called')
                    and (t.created_at at time zone 'Asia/Riyadh')::date = v_day)
    ) order by c.sort_order, c.name), '[]'::jsonb)
  into v_clinics
  from public.clinics c
  where c.merchant_id = p_merchant_id;

  return jsonb_build_object('day', v_day, 'clinics', v_clinics);
end;
$$;
revoke execute on function public.merchant_clinic_queue(uuid) from public, anon;
grant execute on function public.merchant_clinic_queue(uuid) to authenticated;

-- "نداء التالي": the lowest waiting number of the clinic today → called.
-- Owner or staff. NOJ_QUEUE_EMPTY when nobody is waiting.
create or replace function public.merchant_queue_call_next(p_clinic_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_clinic public.clinics;
  v_row public.queue_tickets;
begin
  select * into v_clinic from public.clinics where id = p_clinic_id;
  if v_clinic.id is null then
    raise exception 'NOJ_CLINIC_NOT_FOUND';
  end if;
  if not exists (
    select 1 from public.merchant_members
    where merchant_id = v_clinic.merchant_id and auth_user_id = auth.uid()
  ) then
    raise exception 'لا تملك صلاحية على هذا التاجر';
  end if;

  select * into v_row from public.queue_tickets
  where clinic_id = p_clinic_id and status = 'waiting'
    and (created_at at time zone 'Asia/Riyadh')::date = public.riyadh_today()
  order by ticket_number, created_at
  limit 1
  for update skip locked;
  if v_row.id is null then
    raise exception 'NOJ_QUEUE_EMPTY';
  end if;

  update public.queue_tickets set status = 'called', called_at = now()
  where id = v_row.id
  returning * into v_row;

  return public.queue_ticket_json_for_merchant(v_row);
end;
$$;
revoke execute on function public.merchant_queue_call_next(uuid) from public, anon;
grant execute on function public.merchant_queue_call_next(uuid) to authenticated;

-- "انتهى" (called → done) and "لم يحضر" (called/waiting → no_show), today's
-- tickets of the caller's own clinics only. Owner or staff.
create or replace function public.merchant_queue_set_ticket_status(p_ticket_id uuid, p_status text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.queue_tickets;
  v_merchant uuid;
begin
  if p_status is null or p_status not in ('done', 'no_show') then
    raise exception 'NOJ_INVALID_STATUS';
  end if;

  select * into v_row from public.queue_tickets where id = p_ticket_id for update;
  if v_row.id is null or v_row.clinic_id is null then
    raise exception 'NOJ_TICKET_NOT_FOUND';
  end if;
  select merchant_id into v_merchant from public.clinics where id = v_row.clinic_id;
  if not exists (
    select 1 from public.merchant_members
    where merchant_id = v_merchant and auth_user_id = auth.uid()
  ) then
    raise exception 'لا تملك صلاحية على هذا التاجر';
  end if;

  if (p_status = 'done' and v_row.status <> 'called')
     or (p_status = 'no_show' and v_row.status not in ('called', 'waiting')) then
    raise exception 'NOJ_INVALID_TRANSITION';
  end if;

  update public.queue_tickets set status = p_status, finished_at = now()
  where id = p_ticket_id
  returning * into v_row;

  return public.queue_ticket_json_for_merchant(v_row);
end;
$$;
revoke execute on function public.merchant_queue_set_ticket_status(uuid, text) from public, anon;
grant execute on function public.merchant_queue_set_ticket_status(uuid, text) to authenticated;

-- The clinic's code in the cashier system — OWNER only, medical merchants
-- only. Empty/NULL clears it. Unique inside the merchant, case-insensitive
-- (NOJ_UNIT_CODE_TAKEN); 1..40 characters (NOJ_INVALID_UNIT_CODE).
create or replace function public.merchant_set_clinic_pos_code(p_clinic_id uuid, p_code text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_clinic public.clinics;
  v_sector text;
  v_code text := nullif(btrim(coalesce(p_code, '')), '');
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
  select sector_code into v_sector from public.merchants where id = v_clinic.merchant_id;
  if v_sector is distinct from 'medical' then
    raise exception 'NOJ_BOOKING_NOT_AVAILABLE';
  end if;
  if v_code is not null and char_length(v_code) > 40 then
    raise exception 'NOJ_INVALID_UNIT_CODE';
  end if;

  begin
    update public.clinics set pos_unit_code = v_code
    where id = p_clinic_id
    returning * into v_clinic;
  exception when unique_violation then
    raise exception 'NOJ_UNIT_CODE_TAKEN';
  end;

  return jsonb_build_object('id', v_clinic.id, 'name', v_clinic.name, 'pos_unit_code', v_clinic.pos_unit_code);
end;
$$;
revoke execute on function public.merchant_set_clinic_pos_code(uuid, text) from public, anon;
grant execute on function public.merchant_set_clinic_pos_code(uuid, text) to authenticated;
