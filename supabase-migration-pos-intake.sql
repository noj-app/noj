-- ============================================================================
-- NOJ — migration: POS invoice intake (stage 2 — intake endpoint schema)
-- ============================================================================
-- Second stage of the POS-integration plan (stage 1 was supabase-migration-
-- pos-transactions.sql: the pos_transactions table + kiosk_claim_pos_
-- transaction()). This file adds exactly what a branch's own POS/cashier
-- system needs to authenticate and post an invoice: a per-branch bearer
-- token (hashed, never stored or logged raw) and the one SECURITY DEFINER
-- function the pos-intake Edge Function calls to insert a row.
--
-- DOES NOT TOUCH kiosk.html, index.html, or anything from stage 1 — the
-- pos_transactions table and kiosk_claim_pos_transaction() are untouched.
--
-- KEY DECISIONS (agreed in chat before writing this file):
--   - Per-branch bearer token, SHA-256 hashed at rest — same "unreachable
--     except through one narrow function" lockdown shape as
--     branch_admin_pins: RLS enabled, ZERO policies, ZERO grant. A 256-bit
--     random token has enough entropy that a fast hash (not bcrypt/crypt's
--     deliberately-slow KDF) is appropriate — unlike a 4-6 digit human PIN,
--     there is nothing short/guessable here for a slow hash to protect
--     against.
--   - issue_branch_pos_token(): a superuser-invoked maintenance function
--     (run directly in Supabase Studio's SQL Editor, same operational
--     pattern as provisioning a branch_admin_pins PIN) — NOT a client-
--     facing RPC. No grant to anon/authenticated at all, and auth.uid()
--     is never consulted (the SQL Editor carries no real JWT context,
--     confirmed empirically earlier in this project for approve_device_
--     pairing()). Returns the raw token exactly once; only the hash is
--     ever persisted.
--   - intake_pos_transaction(): the only way a row enters pos_transactions
--     from outside. Runs with the Edge Function's service-role client
--     (bypasses RLS same as any service-role call), but the function
--     itself still validates device_id belongs to the claimed branch —
--     defense in depth, never trusting the caller's own branch/device
--     pairing claim implicitly. Idempotent on (branch_id, external_ref):
--     a retried request returns the ORIGINAL row completely unchanged
--     (via `do update set branch_id = excluded.branch_id` — a genuine
--     no-op touch that only exists to make `returning` work on conflict),
--     never merges in a retry's possibly-different amount/vat — a replayed
--     or buggy resend must never retroactively alter an already-pending
--     (or worse, already-claimed) transaction's amount.
--   - amount/vat/external_ref validation lives in BOTH the Edge Function
--     (fast, friendly 400 before any DB round-trip) and the existing
--     pos_transactions CHECK constraints (authoritative backstop,
--     unchanged from stage 1) — not duplicated schema, just two layers.
--
-- ADDITIVE / SAFE: no existing table/column/row/function is dropped.
-- Run this ONCE, after supabase-migration-pos-transactions.sql. Safe to
-- run more than once.
-- ============================================================================

create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------------------
-- 1. branch_pos_credentials: one bearer token per branch, hashed. RLS
--    enabled with NO policies and NO grant to anon/authenticated at all —
--    same total lockout shape as branch_admin_pins/unclaimed_customers/
--    otp_requests. The only way in or out is the two functions below.
-- ---------------------------------------------------------------------------
create table if not exists public.branch_pos_credentials (
  branch_id uuid primary key references public.branches(id) on delete cascade,
  token_hash text not null,
  created_at timestamptz not null default now()
);
alter table public.branch_pos_credentials enable row level security;

create unique index if not exists branch_pos_credentials_token_hash_idx
  on public.branch_pos_credentials(token_hash);

-- ---------------------------------------------------------------------------
-- 2. issue_branch_pos_token(): run manually from Supabase Studio's SQL
--    Editor by an administrator — `select issue_branch_pos_token('<branch
--    uuid>');` — to provision or rotate a branch's token. Returns the raw
--    token ONCE; copy it immediately, it is never retrievable again (only
--    its hash is stored). Re-running for the same branch rotates it (the
--    old token stops working instantly).
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

  return v_token;
end;
$$;

-- لا grant لـ anon أو authenticated إطلاقاً — تُشغَّل فقط من محرر SQL في
-- Supabase Studio كمسؤول، تماماً كتزويد رمز PIN في branch_admin_pins.
-- revoke from public وحده لا يكفي على مشروع Supabase حي: Supabase يمنح
-- anon وauthenticated تنفيذاً افتراضياً بالاسم مباشرة (لا عبر PUBLIC) على
-- أي دالة جديدة في public (راجع auto_expose_new_tables)، فيبقى الـ revoke
-- من public وحده بلا أثر فعلي على هذين الدورين تحديداً — هذا بالضبط ما
-- أبقى هذه الدالة مفتوحة على المشروع الحي حتى اكتُشف يدوياً. راجع CLAUDE.md.
revoke all on function public.issue_branch_pos_token(uuid) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. intake_pos_transaction(): called ONLY by the pos-intake Edge Function
--    using its service-role client (after it resolves branch_id itself by
--    hashing the presented bearer token and looking it up in
--    branch_pos_credentials — that lookup happens in the Edge Function,
--    not here, since this function trusts its caller's branch_id argument
--    the same way every service-role call in this codebase does).
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
  -- لمسة بلا تأثير فعلي (تعيد branch_id لنفسه) — فقط لتفعيل RETURNING على
  -- الصف الموجود مسبقاً كما هو تماماً؛ لا تُدمَج قيم إعادة الإرسال (amount/
  -- vat/metadata) في صف قد يكون تجاوز حالة pending فعلاً.
  do update set branch_id = excluded.branch_id
  returning * into v_row;

  return v_row;
end;
$$;

-- لا grant لـ anon أو authenticated — لا يُستدعى إلا من pos-intake عبر
-- عميل service role (يتجاوز RLS أصلاً)، فهذا القفل دفاع إضافي لا أكثر.
-- revoke from public وحده لا يكفي (نفس تعليل issue_branch_pos_token أعلاه:
-- anon/authenticated يُمنحان تنفيذاً افتراضياً بالاسم مباشرة من Supabase،
-- لا عبر PUBLIC) — هذا بالضبط ما أبقى هذه الدالة مفتوحة فعلياً على المشروع
-- الحي حتى اكتُشف يدوياً. grant صريح لـ service_role وحده: هذا هو الدور
-- الذي يستخدمه عميل pos-intake/index.ts فعلياً (SUPABASE_SERVICE_ROLE_KEY).
revoke all on function public.intake_pos_transaction(uuid, uuid, text, numeric, numeric, text, jsonb) from public, anon, authenticated;
grant execute on function public.intake_pos_transaction(uuid, uuid, text, numeric, numeric, text, jsonb) to service_role;
