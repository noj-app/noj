-- ============================================================================
-- NOJ — migration: POS connections (status mirror) + invoices.branch_id /
-- refunded_amount — "المرحلة صفر" of the unified POS-connection model
-- ============================================================================
-- Implements stage 0 of the model documented in CLAUDE.md ("نموذج اتصال
-- الفرع بنظام الكاشير"), with NO dependency on any external provider:
--
--   1. public.pos_connections — one row per (branch, provider), the
--      NON-SECRET status/metadata a merchant dashboard reads: provider,
--      kind ('token_issued' = we issue the branch token / 'oauth' = a
--      provider issues us one, later), status, last invoice time, last
--      error. It holds NO secret of any kind. branch_pos_credentials (the
--      token HASH vault) is NOT touched by this file in any way.
--   2. Three EXISTING functions gain ONE additive side effect each — same
--      inputs, same return values, same errors, same grants:
--        - issue_branch_pos_token(): records the connection row after a
--          successful issue/rotation. merchant_issue_pos_token() delegates
--          to it (supabase-migration-merchant-admin-controls.sql), so the
--          dashboard path is covered by this one change, with no edit to
--          that function.
--        - intake_pos_transaction(): bumps pos_connections.last_invoice_at
--          when a NEW transaction row is genuinely inserted (an idempotent
--          re-post of the same external_ref is NOT a new invoice and leaves
--          the timestamp alone).
--        - kiosk_claim_pos_transaction(): writes invoices.branch_id in both
--          of its paths (registered customer / unregistered phone).
--      The two connection-status writes are BEST-EFFORT by design: wrapped
--      in a sub-transaction that downgrades any failure to a WARNING, so a
--      status-mirror problem can never fail a token issue or — far more
--      importantly — a real invoice intake. Status is a convenience for the
--      dashboard; the invoice path must not depend on it.
--   3. public.invoices gains branch_id (nullable FK, backfilled) and
--      refunded_amount (nullable, CHECKed 0..amount). Nothing reads
--      refunded_amount yet — it exists so the upcoming refunds/invoices
--      stages don't have to retrofit the table. Existing rows keep NULL.
--
-- NOT in this file (deliberately): the point_transactions type/source enum
-- expansion for refunds, listed under stage 0 in the design. It has no
-- consumer until the refunds stage, and it means rewriting CHECK
-- constraints on the points ledger — so it ships WITH the refunds stage
-- where it is used and tested together, not as an unused ledger change now.
-- kiosk_earn_points() (demo-only, no longer called by kiosk.html) is also
-- left untouched: its invoices keep branch_id NULL (source='demo'), which
-- the nullable column permits.
--
-- pos_connections is written ONLY through record_pos_connection_event()
-- below. There is deliberately no client write grant or policy yet: the
-- owner-only connect/disconnect actions arrive later as SECURITY DEFINER
-- RPCs, matching how every other sensitive write in this codebase works.
--
-- ADDITIVE / SAFE: no existing table, column or row is dropped; existing
-- functions are replaced by supersets of themselves. Run this ONCE, after
-- supabase-migration-pos-intake.sql and supabase-migration-pos-transactions.sql
-- (and supabase-migration-merchant-admin-controls.sql). Safe to run more
-- than once.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. pos_connections
-- ---------------------------------------------------------------------------
create table if not exists public.pos_connections (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references public.branches(id) on delete cascade,
  provider text not null check (char_length(provider) between 1 and 40),
  kind text not null check (kind in ('token_issued', 'oauth')),
  status text not null default 'disconnected'
    check (status in ('connected', 'disconnected', 'expired', 'error')),
  external_branch_id text,
  last_invoice_at timestamptz,
  last_error text,
  connected_at timestamptz,
  disconnected_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (branch_id, provider)
);

alter table public.pos_connections enable row level security;

-- Merchant staff (owner or staff) read the status of their own merchant's
-- branches — same shape as "merchant staff can select their branch
-- settings". No insert/update/delete policy and no such grant: all writes
-- go through record_pos_connection_event().
drop policy if exists "merchant staff can select their pos connections" on public.pos_connections;
create policy "merchant staff can select their pos connections"
  on public.pos_connections for select
  using (exists (
    select 1 from public.branches b
    join public.merchant_members mm on mm.merchant_id = b.merchant_id
    where b.id = pos_connections.branch_id and mm.auth_user_id = auth.uid()
  ));

grant select on public.pos_connections to authenticated;

-- ---------------------------------------------------------------------------
-- 2. record_pos_connection_event(): the single writer of pos_connections.
--    Internal only — called from the two functions below (SECURITY DEFINER
--    callers run as the owner role, which bypasses EXECUTE grants), so it is
--    locked to every client role, service_role included.
--      'token_issued'     — connect / rotate: status becomes 'connected',
--                           connected_at restarts, any prior error clears.
--      'invoice_received' — a new invoice arrived: last_invoice_at = now(),
--                           status 'connected', error cleared. Creates the
--                           row if the branch never went through issuing
--                           (kind defaults to the caller's p_kind).
-- ---------------------------------------------------------------------------
create or replace function public.record_pos_connection_event(
  p_branch_id uuid,
  p_provider text,
  p_kind text,
  p_event text
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_event = 'token_issued' then
    insert into public.pos_connections
      (branch_id, provider, kind, status, connected_at, disconnected_at, last_error)
    values
      (p_branch_id, p_provider, p_kind, 'connected', now(), null, null)
    on conflict (branch_id, provider) do update
    set kind = excluded.kind,
        status = 'connected',
        connected_at = now(),
        disconnected_at = null,
        last_error = null,
        updated_at = now();
  elsif p_event = 'invoice_received' then
    insert into public.pos_connections
      (branch_id, provider, kind, status, connected_at, last_invoice_at)
    values
      (p_branch_id, p_provider, p_kind, 'connected', now(), now())
    on conflict (branch_id, provider) do update
    set last_invoice_at = now(),
        status = 'connected',
        last_error = null,
        updated_at = now();
  else
    raise exception 'unknown pos connection event: %', p_event;
  end if;
end;
$$;

revoke all on function public.record_pos_connection_event(uuid, text, text, text)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. issue_branch_pos_token(): body identical to supabase-migration-pos-
--    intake.sql, plus the best-effort connection-row write after the token
--    is stored. Return value, errors and grants unchanged.
-- ---------------------------------------------------------------------------
create or replace function public.issue_branch_pos_token(p_branch_id uuid)
returns text
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_token text;
  v_hash text;
begin
  if not exists (select 1 from public.branches where id = p_branch_id) then
    raise exception 'الفرع غير موجود';
  end if;

  v_token := encode(gen_random_bytes(32), 'hex');
  v_hash := encode(digest(v_token, 'sha256'), 'hex');

  insert into public.branch_pos_credentials (branch_id, token_hash, created_at)
  values (p_branch_id, v_hash, now())
  on conflict (branch_id) do update set token_hash = excluded.token_hash, created_at = now();

  begin
    perform public.record_pos_connection_event(p_branch_id, 'generic', 'token_issued', 'token_issued');
  exception when others then
    raise warning 'pos_connections update failed after token issue: %', sqlerrm;
  end;

  return v_token;
end;
$$;

revoke all on function public.issue_branch_pos_token(uuid) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. intake_pos_transaction(): body identical to supabase-migration-pos-
--    intake.sql, plus the best-effort last_invoice_at bump — only when the
--    row was inserted by THIS call (received_at defaults to now(), which is
--    constant within one call's transaction; a retry of an existing
--    external_ref finds an older received_at and bumps nothing).
-- ---------------------------------------------------------------------------
create or replace function public.intake_pos_transaction(
  p_branch_id uuid,
  p_device_id uuid,
  p_external_ref text,
  p_amount numeric,
  p_vat numeric,
  p_source_adapter text,
  p_metadata jsonb
) returns public.pos_transactions
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.pos_transactions;
begin
  if p_device_id is not null and not exists (
    select 1 from public.devices where id = p_device_id and branch_id = p_branch_id
  ) then
    raise exception 'NOJ_DEVICE_NOT_IN_BRANCH';
  end if;

  insert into public.pos_transactions
    (branch_id, device_id, external_ref, amount, vat, source_adapter, metadata)
  values
    (p_branch_id, p_device_id, p_external_ref, p_amount, coalesce(p_vat, 0), p_source_adapter, p_metadata)
  on conflict (branch_id, external_ref)
  -- لمسة بلا تأثير فعلي (تعيد branch_id لنفسه) — كما في النسخة الأصلية: فقط
  -- لتفعيل RETURNING على الصف الموجود مسبقاً كما هو؛ لا تُدمَج قيم إعادة
  -- الإرسال في صف قد يكون تجاوز حالة pending فعلاً.
  do update set branch_id = excluded.branch_id
  returning * into v_row;

  if v_row.received_at = now() then
    begin
      perform public.record_pos_connection_event(p_branch_id, p_source_adapter, 'token_issued', 'invoice_received');
    exception when others then
      raise warning 'pos_connections update failed after intake: %', sqlerrm;
    end;
  end if;

  return v_row;
end;
$$;

revoke all on function public.intake_pos_transaction(uuid, uuid, text, numeric, numeric, text, jsonb) from public, anon, authenticated;
grant execute on function public.intake_pos_transaction(uuid, uuid, text, numeric, numeric, text, jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- 5. invoices.branch_id / refunded_amount
-- ---------------------------------------------------------------------------
alter table public.invoices
  add column if not exists branch_id uuid references public.branches(id) on delete set null;

alter table public.invoices
  add column if not exists refunded_amount numeric(10,2);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'invoices_refunded_amount_chk') then
    alter table public.invoices
      add constraint invoices_refunded_amount_chk
      check (refunded_amount is null or (refunded_amount >= 0 and refunded_amount <= amount));
  end if;
end $$;

create index if not exists invoices_branch_id_idx
  on public.invoices(branch_id) where branch_id is not null;

-- Backfill (idempotent — only rows still NULL):
--   a) every POS invoice knows its exact branch through the pos_transactions
--      row that created it (both the registered and the unregistered path
--      set pos_transactions.invoice_id);
--   b) any other invoice of a merchant with exactly ONE branch belongs to
--      that branch; a merchant with several branches is left NULL rather
--      than guessed.
update public.invoices i
set branch_id = pt.branch_id
from public.pos_transactions pt
where pt.invoice_id = i.id and i.branch_id is null;

update public.invoices i
set branch_id = b.id
from public.branches b
where i.branch_id is null
  and b.merchant_id = i.merchant_id
  and (select count(*) from public.branches b2 where b2.merchant_id = i.merchant_id) = 1;

-- ---------------------------------------------------------------------------
-- 6. kiosk_claim_pos_transaction(): body identical to supabase-migration-
--    pos-transactions.sql, plus branch_id in BOTH invoices inserts
--    (registered customer / unregistered phone). Nothing else changes.
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

    update public.merchant_loyalty
    set points = points + v_added, updated_at = now()
    where user_id = v_profile_id and merchant_id = v_merchant.id;

    insert into public.invoices (user_id, merchant_id, branch_id, amount, vat, category, points_earned, status, source, external_ref)
    values (v_profile_id, v_merchant.id, v_branch.id, v_txn.amount, v_txn.vat, v_merchant.type, v_added, 'paid', 'pos', v_txn.external_ref)
    returning id into v_invoice_id;

    insert into public.point_transactions
      (user_id, merchant_id, branch_id, device_id, type, points_delta, points_rate_applied, invoice_id, source)
    values
      (v_profile_id, v_merchant.id, v_branch.id, v_device.id, 'earn', v_added,
       coalesce(v_merchant.points_rate, 0), v_invoice_id, 'pos');

    update public.pos_transactions
    set status = 'applied', applied_at = now(), invoice_id = v_invoice_id
    where id = v_txn.id;

    return query select true, v_profile_id, v_prev, v_added, v_prev + v_added, v_invoice_id;
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
-- 7. Backfill pos_connections for branches that ALREADY hold a token, so
--    the dashboard shows them as connected from day one (idempotent).
-- ---------------------------------------------------------------------------
insert into public.pos_connections (branch_id, provider, kind, status, connected_at, last_invoice_at)
select c.branch_id, 'generic', 'token_issued', 'connected', c.created_at,
       (select max(pt.received_at) from public.pos_transactions pt
        where pt.branch_id = c.branch_id and pt.source_adapter = 'generic')
from public.branch_pos_credentials c
on conflict (branch_id, provider) do nothing;
