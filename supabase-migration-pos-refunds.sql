-- ============================================================================
-- NOJ — migration: POS refunds (type A) — PR2 of "المرتجعات والنقاط المعلّقة"
-- ============================================================================
-- Builds on supabase-migration-pending-points.sql (PR1). Adds the single
-- refund entry point every adapter will end at, exactly like
-- intake_pos_transaction() is the single entry point for invoices:
--
--   intake_pos_refund(branch, original external_ref, refund_ref, amount,
--                     source_adapter, metadata) → jsonb result
--
-- WHAT A REFUND DOES (CLAUDE.md 6 / 6-أ — no balance is ever negative):
--   - The ORIGINAL is found by (branch, external_ref) in pos_transactions.
--   - invoices.refunded_amount is updated (cumulative); invoices.status becomes
--     'refunded' only when the whole amount has been refunded (a partial
--     refund leaves 'paid' + refunded_amount).
--   - Points are reversed in proportion to the refunded share of the invoice's
--     points_earned (exact across several partial refunds: total removed after
--     a full refund == points_earned, never off by rounding):
--       * ledger row still 'pending' (inside the hold): the SAME row is
--         edited — points_delta reduced, or status='cancelled' for a full
--         refund. No balance was ever credited for it, so nothing is
--         "taken back". (The one deliberate exception to ledger
--         immutability, justified in CLAUDE.md 6-أ.)
--       * ledger row 'available' (hold over, or a hold=0 merchant): a NEW
--         immutable row type='refund_adjustment' with a negative points_delta
--         equal to what could actually be deducted — merchant_loyalty.points
--         is reduced down to ZERO at most, never below. The deduction that
--         was intended but could not be taken (the customer already spent the
--         points) is kept in the same row: intended_delta (what should have
--         been deducted) vs points_delta (what was). unrecovered = intended -
--         applied, readable later from point_transactions alone.
--       * unregistered customer (invoice still on pending_phone): only the
--         invoice is marked; no points exist yet. claim_unclaimed_invoices()
--         below gives such an invoice proportionally fewer points — none if
--         fully refunded — when the customer registers later.
--     Points are proportioned from invoices.points_earned (== round(amount ×
--     rate at earn time)), not from the merchant's CURRENT rate, so a later
--     rate change cannot alter a refund; this also works for rows that came
--     through claim_unclaimed_invoices(), which stores no rate on the ledger.
--   - A refund that arrives before the customer ever claimed the transaction
--     (no invoice yet): a FULL refund cancels the pending transaction
--     (status 'failed', error_message 'NOJ_REFUNDED') so it can no longer be
--     claimed; a transaction that already expired/failed has nothing to
--     reverse (recorded only); a PARTIAL refund of a still-claimable
--     transaction is rejected (NOJ_REFUND_NOT_APPLICABLE) — the caller retries
--     once the customer has claimed it.
--   - Idempotency: pos_refunds is keyed by (branch, refund_ref). Re-sending the
--     same refund_ref returns the stored result with replayed=true and changes
--     nothing — a retried webhook can never refund twice.
--   - Over-refund is rejected (NOJ_REFUND_EXCEEDS_AMOUNT): cumulative refunds
--     can never exceed the invoice amount.
--
-- OTHER CHANGES IN THIS FILE
--   - point_transactions.type gains 'refund_adjustment' (points_delta <= 0);
--     new nullable column intended_delta (required, and <= points_delta, for
--     refund_adjustment rows). The two CHECK constraints are rebuilt
--     idempotently; every existing row satisfies them unchanged.
--   - claim_unclaimed_invoices(): fully refunded invoices are still moved to
--     the customer (so history shows them as refunded, nothing disappears
--     silently — and the unclaimed anchor delete cannot cascade them away)
--     but earn NO points; partially refunded ones earn proportionally fewer.
--     Invoices without any refund behave exactly as before.
--
-- ADDITIVE / SAFE / IDEMPOTENT: new table + function, one new nullable column,
-- two CHECKs rebuilt to a strict superset, one function redefined with the
-- same signature/grants. redeem_reward() and every earn path are untouched.
-- Run ONCE after supabase-migration-pending-points.sql. Safe to re-run.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. point_transactions: 'refund_adjustment' + intended_delta
-- ---------------------------------------------------------------------------
alter table public.point_transactions
  add column if not exists intended_delta integer null;

alter table public.point_transactions drop constraint if exists point_transactions_type_check;
alter table public.point_transactions
  add constraint point_transactions_type_check
  check (type in ('opening_balance', 'earn', 'redeem', 'adjust', 'refund_adjustment'));

alter table public.point_transactions drop constraint if exists point_transactions_sign_chk;
alter table public.point_transactions
  add constraint point_transactions_sign_chk check (
    (type = 'earn'   and points_delta >= 0) or
    (type = 'redeem' and points_delta <= 0) or
    (type = 'refund_adjustment' and points_delta <= 0) or
    (type in ('opening_balance', 'adjust'))
  );

alter table public.point_transactions drop constraint if exists point_transactions_refund_intended_chk;
alter table public.point_transactions
  add constraint point_transactions_refund_intended_chk check (
    type <> 'refund_adjustment' or (intended_delta is not null and intended_delta <= points_delta)
  );

-- ---------------------------------------------------------------------------
-- 2. pos_refunds: one row per refund event (idempotency + audit). Locked like
--    branch_pos_credentials: RLS on, no policy, no grant to any client role.
-- ---------------------------------------------------------------------------
create table if not exists public.pos_refunds (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references public.branches(id) on delete cascade,
  external_ref text not null,
  refund_ref text not null,
  refund_amount numeric(10,2) not null check (refund_amount > 0),
  invoice_id uuid references public.invoices(id) on delete set null,
  outcome text not null,
  points_cancelled integer not null default 0,
  points_deducted integer not null default 0,
  points_unrecovered integer not null default 0,
  source_adapter text not null default 'generic',
  metadata jsonb,
  result jsonb not null,
  created_at timestamptz not null default now(),
  unique (branch_id, refund_ref)
);
alter table public.pos_refunds enable row level security;
revoke all on table public.pos_refunds from public, anon, authenticated;

create index if not exists pos_refunds_invoice_idx on public.pos_refunds (invoice_id);

-- ---------------------------------------------------------------------------
-- 3. intake_pos_refund() — service_role only (called by pos-intake).
-- ---------------------------------------------------------------------------
create or replace function public.intake_pos_refund(
  p_branch_id uuid,
  p_external_ref text,
  p_refund_ref text,
  p_refund_amount numeric,
  p_source_adapter text,
  p_metadata jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_amt numeric(10,2);
  v_txn public.pos_transactions;
  v_prev jsonb;
  v_inv public.invoices;
  v_led public.point_transactions;
  v_loyal integer;
  v_before numeric(10,2);
  v_total numeric(10,2);
  v_rem_before integer;
  v_rem_after integer;
  v_intended integer := 0;
  v_applied integer := 0;
  v_outcome text;
  v_cancelled integer := 0;
  v_result jsonb;
  v_status text;
begin
  v_amt := round(p_refund_amount, 2);
  if v_amt is null or v_amt <= 0 or p_refund_ref is null or length(p_refund_ref) = 0
     or p_external_ref is null or length(p_external_ref) = 0
  then
    raise exception 'NOJ_INVALID_REFUND';
  end if;

  -- serializes every refund of the same original (and any concurrent replay)
  select * into v_txn from public.pos_transactions
  where branch_id = p_branch_id and external_ref = p_external_ref
  for update;

  if v_txn.id is null then
    raise exception 'NOJ_REFUND_ORIGINAL_NOT_FOUND';
  end if;

  select result into v_prev from public.pos_refunds
  where branch_id = p_branch_id and refund_ref = p_refund_ref;
  if v_prev is not null then
    return v_prev || jsonb_build_object('replayed', true);
  end if;

  if v_txn.invoice_id is null then
    -- ---- no invoice yet: the customer never entered a phone for it ----
    if v_amt > v_txn.amount then
      raise exception 'NOJ_REFUND_EXCEEDS_AMOUNT';
    end if;

    if v_txn.status in ('pending', 'claimed') then
      if v_amt < v_txn.amount then
        raise exception 'NOJ_REFUND_NOT_APPLICABLE';
      end if;
      update public.pos_transactions
      set status = 'failed', error_message = 'NOJ_REFUNDED'
      where id = v_txn.id;
      v_outcome := 'cancelled_before_claim';
    else
      v_outcome := 'no_invoice';
    end if;

    v_status := v_txn.status;
    v_result := jsonb_build_object(
      'outcome', v_outcome, 'invoice_id', null, 'refund_amount', v_amt,
      'refunded_total', v_amt, 'invoice_status', v_status,
      'points_cancelled', 0, 'points_deducted', 0, 'points_unrecovered', 0, 'replayed', false);
  else
    -- ---- an invoice exists ----
    select * into v_inv from public.invoices where id = v_txn.invoice_id for update;

    v_before := case when v_inv.status = 'refunded' then v_inv.amount
                     else coalesce(v_inv.refunded_amount, 0) end;
    v_total := v_before + v_amt;
    if v_total > v_inv.amount then
      raise exception 'NOJ_REFUND_EXCEEDS_AMOUNT';
    end if;

    update public.invoices
    set refunded_amount = v_total,
        status = case when v_total >= v_inv.amount then 'refunded' else v_inv.status end
    where id = v_inv.id;
    v_status := case when v_total >= v_inv.amount then 'refunded' else v_inv.status end;

    -- points still attached to this invoice before / after this refund
    v_rem_before := round(v_inv.points_earned::numeric * (v_inv.amount - v_before) / v_inv.amount)::integer;
    v_rem_after  := round(v_inv.points_earned::numeric * (v_inv.amount - v_total)  / v_inv.amount)::integer;
    v_intended   := v_rem_before - v_rem_after;
    v_outcome    := 'no_points_to_reverse';

    if v_inv.user_id is null then
      v_outcome := 'unclaimed_marked';
    else
      select * into v_led from public.point_transactions
      where invoice_id = v_inv.id and type = 'earn'
      order by created_at
      limit 1
      for update;

      if v_led.id is not null and v_led.status = 'pending' then
        update public.point_transactions
        set points_delta = v_rem_after,
            status = case when v_total >= v_inv.amount then 'cancelled' else 'pending' end
        where id = v_led.id;
        v_cancelled := v_intended;
        v_outcome := case when v_total >= v_inv.amount then 'pending_points_cancelled' else 'pending_points_reduced' end;

      elsif v_led.id is not null and v_led.status = 'available' and v_intended > 0 then
        select points into v_loyal from public.merchant_loyalty
        where user_id = v_inv.user_id and merchant_id = v_inv.merchant_id
        for update;

        v_applied := least(v_intended, greatest(coalesce(v_loyal, 0), 0));

        if v_applied > 0 then
          update public.merchant_loyalty
          set points = points - v_applied, updated_at = now()
          where user_id = v_inv.user_id and merchant_id = v_inv.merchant_id;
        end if;

        insert into public.point_transactions
          (user_id, merchant_id, branch_id, type, points_delta, intended_delta,
           points_rate_applied, invoice_id, source, external_ref)
        values
          (v_inv.user_id, v_inv.merchant_id, v_inv.branch_id, 'refund_adjustment',
           -v_applied, -v_intended, v_led.points_rate_applied, v_inv.id, 'pos', p_refund_ref);

        v_outcome := 'points_deducted';
      end if;
    end if;

    v_result := jsonb_build_object(
      'outcome', v_outcome, 'invoice_id', v_inv.id, 'refund_amount', v_amt,
      'refunded_total', v_total, 'invoice_status', v_status,
      'points_cancelled', v_cancelled, 'points_deducted', v_applied,
      'points_unrecovered', case when v_outcome = 'points_deducted' then v_intended - v_applied else 0 end,
      'replayed', false);
  end if;

  insert into public.pos_refunds
    (branch_id, external_ref, refund_ref, refund_amount, invoice_id, outcome,
     points_cancelled, points_deducted, points_unrecovered, source_adapter, metadata, result)
  values
    (p_branch_id, p_external_ref, p_refund_ref, v_amt, v_txn.invoice_id, v_outcome,
     (v_result->>'points_cancelled')::integer, (v_result->>'points_deducted')::integer,
     (v_result->>'points_unrecovered')::integer, coalesce(p_source_adapter, 'generic'), p_metadata, v_result);

  return v_result;
end;
$$;

revoke all on function public.intake_pos_refund(uuid, text, text, numeric, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.intake_pos_refund(uuid, text, text, numeric, text, jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- 4. claim_unclaimed_invoices(): identical to supabase-migration-pending-
--    points.sql except for refunds. An invoice with NO refund goes through
--    exactly the same call as before.
-- ---------------------------------------------------------------------------
create or replace function public.claim_unclaimed_invoices() returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_profile public.profiles;
  v_phone text;
  v_claimed_count integer := 0;
  v_refunded numeric;
  v_points integer;
  r record;
begin
  select * into v_profile from public.profiles where auth_user_id = auth.uid() and deleted_at is null;
  if v_profile.id is null then
    raise exception 'الملف الشخصي غير موجود';
  end if;

  if v_profile.phone is null then
    return 0;
  end if;

  if v_profile.phone_verified_at is null then
    raise exception 'NOJ_PHONE_NOT_VERIFIED';
  end if;

  v_phone := v_profile.phone;

  for r in
    select id, merchant_id, points_earned, created_at, amount, status, refunded_amount
    from public.invoices
    where pending_phone = v_phone
    order by created_at, id
    for update
  loop
    update public.invoices
    set user_id = v_profile.id, pending_phone = null
    where id = r.id;

    v_refunded := case when r.status = 'refunded' then r.amount else coalesce(r.refunded_amount, 0) end;

    if v_refunded = 0 then
      perform public.apply_points_earn(
        v_profile.id, r.merchant_id, null, null, r.id,
        r.points_earned, null, 'pos', r.created_at);
    else
      v_points := case when v_refunded >= r.amount then 0
                       else round(r.points_earned::numeric * (r.amount - v_refunded) / r.amount)::integer end;
      if v_points > 0 then
        perform public.apply_points_earn(
          v_profile.id, r.merchant_id, null, null, r.id,
          v_points, null, 'pos', r.created_at);
      end if;
    end if;

    v_claimed_count := v_claimed_count + 1;
  end loop;

  delete from public.unclaimed_customers where phone = v_phone;

  return v_claimed_count;
end;
$$;

revoke execute on function public.claim_unclaimed_invoices() from public, anon;
grant execute on function public.claim_unclaimed_invoices() to authenticated;
