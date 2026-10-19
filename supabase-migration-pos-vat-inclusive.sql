-- ============================================================================
-- NOJ — migration: VAT-inclusive accounting rule enforced in intake_pos_transaction()
-- ============================================================================
-- FIXED ACCOUNTING DECISION (CLAUDE.md, "القاعدة المحاسبية للمبلغ والضريبة"):
--   - amount (pos_transactions / invoices) = the TOTAL the customer actually
--     paid, INCLUDING VAT.
--   - vat = the VAT portion already CONTAINED in amount, not added on top.
--   - loyalty points are computed on the whole amount (VAT included) —
--     kiosk_claim_pos_transaction() already does exactly that
--     (round(amount * points_rate), it never reads vat), so it is NOT
--     touched by this file.
--
-- This file adds the one missing check: 0 <= vat < amount. It lives in
-- intake_pos_transaction() because that is the single choke point EVERY
-- adapter ends at (the pos-intake generic adapter today, a Foodics webhook
-- adapter later, which will call this function directly and never pass
-- through pos-intake's own validation). pos-intake/intake.ts validates the
-- same rule first so a generic-adapter caller gets a clean 400 without a
-- database round trip; this is the guarantee that holds for the rest.
--
-- Applied only when amount > 0: a zero/negative amount keeps being rejected
-- by pos_transactions' original CHECK (amount > 0), exactly as before, with
-- its original error — this check does not change which error those inputs
-- produce. vat NULL is treated as 0 (the function already coalesces it).
--
-- ADDITIVE / SAFE: the function body is identical to the current definition
-- (supabase-migration-pos-connections.sql: intake + best-effort
-- last_invoice_at bump) plus the validation; same signature, return type and
-- grants. No table or column is touched, no stored row is re-examined — rows
-- already in pos_transactions are left exactly as they are. Run ONCE, after
-- supabase-migration-pos-connections.sql. Safe to run more than once.
-- ============================================================================

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
  if p_amount is not null and p_amount > 0
     and (coalesce(p_vat, 0) < 0 or coalesce(p_vat, 0) >= p_amount)
  then
    raise exception 'NOJ_INVALID_VAT';
  end if;

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
