-- ============================================================================
-- NOJ — migration: merchant dashboard admin controls (PIN + POS token, owner-only)
-- ============================================================================
-- Stage 2 of merchant.html — lets a merchant OWNER (never staff) set this
-- branch's kiosk admin PIN and rotate its POS bearer token, from the
-- dashboard instead of Supabase Studio. Both wrap EXISTING, already-tested
-- machinery (branch_admin_pins/admin_pin_attempts from supabase-migration-
-- admin-pin-lockdown.sql, branch_pos_credentials/issue_branch_pos_token()
-- from supabase-migration-pos-intake.sql) — neither underlying table nor
-- issue_branch_pos_token() itself is modified by this file.
--
-- OWNER-ONLY, enforced TWICE (defense in depth, same pattern as every other
-- owner-only action already in this codebase):
--   1. merchant.html hides both sections entirely from a 'staff' member.
--   2. Both functions below re-derive the caller's role from merchant_members
--      themselves (auth.uid(), never a client-supplied claim) and reject
--      anything other than role='owner' for the merchant that owns
--      p_branch_id — identical join shape to approve_device_pairing()'s
--      existing branch-ownership check (supabase-migration-kiosk-device-
--      auth.sql), with role added. A 'staff' member calling either RPC
--      directly (bypassing the UI entirely) is rejected exactly the same as
--      a non-member stranger, with the same message — approve_device_
--      pairing() doesn't distinguish "not a member" from "member of a
--      different merchant" either, so this isn't a new ambiguity.
--
-- revoke from public AND anon explicitly, not just public — see the
-- auto_expose_new_tables note in supabase-migration-pos-intake.sql (CLAUDE.md
-- has the fuller incident writeup): Supabase grants anon/authenticated
-- EXECUTE by name on every new public function, independent of PUBLIC's own
-- separate implicit grant from plain CREATE FUNCTION. Both must be revoked
-- explicitly, every time, for every new SECURITY DEFINER function — grant to
-- authenticated only (merchant.html sessions are always real authenticated
-- users via Phone OTP, never anonymous — see merchant.html's own header
-- comment), never anon.
--
-- ADDITIVE / SAFE: no existing table, column, row, or function is altered or
-- dropped. Run this ONCE, after supabase-migration-admin-pin-lockdown.sql and
-- supabase-migration-pos-intake.sql. Safe to run more than once.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. merchant_set_admin_pin(): sets/replaces this branch's kiosk admin PIN.
--    Never returns the PIN (returns void) — same "write-only" shape as the
--    underlying branch_admin_pins table itself (no SELECT grant to anyone,
--    not even the owner who just set it). Resets admin_pin_attempts for this
--    branch on every successful change, so an owner who forgot a locked-out
--    PIN can simply set a new one instead of waiting out the 15-minute lock.
-- ---------------------------------------------------------------------------
create or replace function public.merchant_set_admin_pin(p_branch_id uuid, p_pin text)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if p_pin !~ '^[0-9]{4}$' then
    raise exception 'الرمز يجب أن يكون 4 أرقام بالضبط';
  end if;

  if not exists (
    select 1 from public.branches b
    join public.merchant_members mm on mm.merchant_id = b.merchant_id
    where b.id = p_branch_id and mm.auth_user_id = auth.uid() and mm.role = 'owner'
  ) then
    raise exception 'لا تملك صلاحية على هذا الفرع';
  end if;

  insert into public.branch_admin_pins (branch_id, pin_hash)
  values (p_branch_id, crypt(p_pin, gen_salt('bf')))
  on conflict (branch_id) do update set pin_hash = excluded.pin_hash;

  -- رمز جديد = صفحة جديدة تماماً لتاريخ محاولات هذا الفرع — لا داعي لإبقاء
  -- أي محاولات فاشلة سابقة (أو قفل مؤقت قائم) معلّقة ضد رمز لم يعد موجوداً.
  delete from public.admin_pin_attempts where branch_id = p_branch_id;
end;
$$;

revoke all on function public.merchant_set_admin_pin(uuid, text) from public, anon, authenticated;
grant execute on function public.merchant_set_admin_pin(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 2. merchant_issue_pos_token(): issues/rotates this branch's POS bearer
--    token from the dashboard. Delegates the actual generation to the
--    EXISTING issue_branch_pos_token() (untouched, still callable from
--    Supabase Studio's SQL Editor in its own right) after confirming
--    ownership — safe to call despite that function's own `revoke all ...
--    from ... authenticated`: a SECURITY DEFINER function's internal calls
--    run as its OWNER role (here, the same migration-running role that owns
--    every function in this repo), which bypasses EXECUTE grants entirely —
--    exactly the privilege-escalation mechanism SECURITY DEFINER exists for
--    in Postgres, not a loophole specific to this file. This keeps token
--    generation defined in exactly ONE place (supabase-migration-pos-
--    intake.sql) instead of a second, independently-maintained copy that
--    could drift from it (see the pos-invoice simulator postmortem in
--    CLAUDE.md for exactly this kind of drift happening once already).
-- ---------------------------------------------------------------------------
create or replace function public.merchant_issue_pos_token(p_branch_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (
    select 1 from public.branches b
    join public.merchant_members mm on mm.merchant_id = b.merchant_id
    where b.id = p_branch_id and mm.auth_user_id = auth.uid() and mm.role = 'owner'
  ) then
    raise exception 'لا تملك صلاحية على هذا الفرع';
  end if;

  return public.issue_branch_pos_token(p_branch_id);
end;
$$;

revoke all on function public.merchant_issue_pos_token(uuid) from public, anon, authenticated;
grant execute on function public.merchant_issue_pos_token(uuid) to authenticated;
