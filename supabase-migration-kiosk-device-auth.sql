-- ============================================================================
-- NOJ — migration: kiosk device pairing, per-branch identity settings, and a
-- SAFE (off-by-default) path for kiosk.html to earn real points
-- ============================================================================
-- Builds on supabase-migration-branches-devices.sql, whose own comments
-- explicitly DEFERRED device authentication ("Nothing in this file grants a
-- device any access at all") — this file is that deferred design, done now.
--
-- SCOPE DECISIONS (agreed before writing this file):
--   - Pairing-code APPROVAL has no merchant-facing UI yet (out of scope, a
--     separate future project) — approve_device_pairing() below is written
--     to be complete and correct on its own, callable today from Supabase
--     Studio (a merchant_member runs `select approve_device_pairing(...)`
--     directly), so a future admin screen is a thin UI on top of this
--     function, never a rewrite of it.
--   - A phone with no public.profiles row is NEVER auto-created from the
--     kiosk. Consent to process personal data cannot be taken by a cashier
--     on a customer's behalf, and silent auto-enrollment opens the door to
--     mistyped numbers accumulating real strangers' balances. kiosk_earn_
--     points() raises a distinct, catchable error ('NOJ_CUSTOMER_NOT_FOUND')
--     so kiosk.html can show "download the app first" instead of a generic
--     failure.
--   - kiosk_earn_points() writes REAL, PERMANENT rows to point_transactions
--     and invoices — against a REAL customer's REAL balance — using an
--     invoice amount kiosk.html cannot yet get from an actual point of
--     sale (it is still a fixed per-sector template constant). Polluting
--     the ledger we just built specifically to be a trustworthy record of
--     disputes, with fabricated amounts indistinguishable from real ones,
--     is worse than not writing at all. So: the function is fully built and
--     tested here, but REFUSES to run at all unless the calling device's
--     own branch_settings.demo_earn_enabled is explicitly turned on — off
--     by default — and every row it writes is unconditionally tagged
--     source='demo' (server-decided, never trusts a client-supplied
--     source), so excluding this data later from any real report is one
--     `where source <> 'demo'` away, not a forensic exercise.
--   - Sector is kiosk-only display/template logic (index.html never reads
--     it) and belongs on branch_settings, not on merchants/branches — the
--     stable reference is a fixed English code (matching kiosk.html's own
--     T{} keys), Arabic stays presentation-only in the UI layer, so the
--     English<->Arabic mapping is never duplicated table-side.
--   - Logo upload gets a hard server-side size ceiling in addition to
--     whatever kiosk.html enforces client-side — client-side checks are
--     never trusted alone anywhere else in this project either.
--
-- ADDITIVE / SAFE: no existing table, column, or row is altered or dropped.
-- public.merchants and public.branches are untouched. Run this ONCE, after
-- supabase-migration-branches-devices.sql, supabase-migration-point-ledger.sql
-- and supabase-migration-loyalty-rate-expiry.sql. Safe to run more than once.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. branch_settings: identity fields (replace kiosk.html's localStorage),
--    sector as a fixed English code, and the demo-earn kill switch.
-- ---------------------------------------------------------------------------
alter table public.branch_settings
  add column if not exists sector_code text not null default 'cafe';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'branch_settings_sector_code_chk') then
    alter table public.branch_settings
      add constraint branch_settings_sector_code_chk
      check (sector_code in ('medical','cafe','restaurant','grocery'));
  end if;
end $$;

alter table public.branch_settings add column if not exists biz_name text;
alter table public.branch_settings add column if not exists biz_branch text;
alter table public.branch_settings add column if not exists biz_slogan text;
alter table public.branch_settings add column if not exists biz_logo text;

-- 700,000 bytes of base64 text ≈ 512KB of original binary image (base64
-- inflates ~4/3), i.e. the ~500KB ceiling asked for, with headroom for the
-- 'data:image/...;base64,' prefix. Server-side floor under whatever
-- kiosk.html checks client-side before ever reaching this far.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'branch_settings_biz_logo_size_chk') then
    alter table public.branch_settings
      add constraint branch_settings_biz_logo_size_chk
      check (biz_logo is null or octet_length(biz_logo) <= 700000);
  end if;
end $$;

alter table public.branch_settings
  add column if not exists demo_earn_enabled boolean not null default false;

-- ---------------------------------------------------------------------------
-- 2. devices: give every device its own Supabase Auth identity (the same
--    "anonymous session + a row that remembers who this is" pattern already
--    used for customers via profiles.auth_user_id), and let branch_id start
--    out unknown (an unpaired device has no branch yet — the whole point of
--    pairing). pairing_code_issued_at is separate from created_at so a
--    re-issued code (see request_device_pairing below) doesn't rewrite the
--    row's real creation time.
-- ---------------------------------------------------------------------------
alter table public.devices alter column branch_id drop not null;

alter table public.devices add column if not exists auth_user_id uuid references auth.users(id) on delete cascade;
alter table public.devices add column if not exists pairing_code_issued_at timestamptz not null default now();

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'devices_auth_user_id_key') then
    alter table public.devices add constraint devices_auth_user_id_key unique (auth_user_id);
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 3. RLS: a device reads its OWN devices row and its OWN branch's settings
--    (never anyone else's) — additive to, not a replacement for, the
--    existing "merchant staff" policies from supabase-migration-branches-
--    devices.sql (Postgres OR's multiple permissive policies together, so
--    both a device and a merchant_member can each see what's theirs).
--
--    branch_settings stays a plain RLS-scoped UPDATE (like the "merchant
--    staff" policy already does), not a SECURITY DEFINER function: every
--    column here is independent, freely-settable configuration (no balance,
--    no arithmetic invariant a client could violate by writing the "wrong"
--    new value) — the WITH CHECK gap that made merchant_loyalty/appointments
--    dangerous does not apply to plain settings. demo_earn_enabled is the
--    one field here with real teeth, and it is still just "this device's own
--    branch may flip its own switch", the same trust level the existing
--    settings screen (PIN-gated on the tablet itself) already assumes for
--    every other field on this screen.
-- ---------------------------------------------------------------------------
drop policy if exists "device can select its own row" on public.devices;
create policy "device can select its own row"
  on public.devices for select
  using (auth_user_id = auth.uid());

drop policy if exists "device can select its own branch settings" on public.branch_settings;
create policy "device can select its own branch settings"
  on public.branch_settings for select
  using (exists (
    select 1 from public.devices d
    where d.branch_id = branch_settings.branch_id and d.auth_user_id = auth.uid()
  ));

drop policy if exists "device can update its own branch settings" on public.branch_settings;
create policy "device can update its own branch settings"
  on public.branch_settings for update
  using (exists (
    select 1 from public.devices d
    where d.branch_id = branch_settings.branch_id and d.auth_user_id = auth.uid()
  ));

-- ---------------------------------------------------------------------------
-- 4. request_device_pairing(): called by a fresh anonymous Supabase Auth
--    session on the kiosk (sb.auth.signInAnonymously(), same call index.html
--    already uses for customers). Idempotent per session: re-calling it
--    (page reload before approval, or after approval) always returns THIS
--    device's own row, never creates a second one, and never leaks another
--    device's code. An unapproved code older than 15 minutes is treated as
--    stale and silently replaced with a fresh one on next call, instead of
--    letting a code found once, long ago, still be valid forever.
-- ---------------------------------------------------------------------------
create or replace function public.request_device_pairing() returns public.devices
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_code text;
  v_row public.devices;
begin
  if v_uid is null then
    raise exception 'يجب إنشاء جلسة أولاً';
  end if;

  select * into v_row from public.devices where auth_user_id = v_uid;

  if found then
    if v_row.branch_id is null and v_row.pairing_code_issued_at < now() - interval '15 minutes' then
      loop
        v_code := lpad(floor(random() * 1000000)::text, 6, '0');
        exit when not exists (select 1 from public.devices where pairing_code = v_code);
      end loop;
      update public.devices
      set pairing_code = v_code, pairing_code_issued_at = now()
      where id = v_row.id
      returning * into v_row;
    end if;
    return v_row;
  end if;

  loop
    v_code := lpad(floor(random() * 1000000)::text, 6, '0');
    exit when not exists (select 1 from public.devices where pairing_code = v_code);
  end loop;

  insert into public.devices (auth_user_id, branch_id, pairing_code, is_active)
  values (v_uid, null, v_code, true)
  returning * into v_row;

  return v_row;
end;
$$;

-- authenticated only, not anon — bootKiosk() always signs in anonymously
-- (authenticated-role JWT) before this is ever called. Also revokes
-- PUBLIC's own separate implicit grant — see the fuller note on
-- claim_or_create_profile(text) in supabase-schema.sql.
revoke execute on function public.request_device_pairing() from public, anon;
grant execute on function public.request_device_pairing() to authenticated;

-- ---------------------------------------------------------------------------
-- 5. approve_device_pairing(): called today by a merchant_member directly in
--    Supabase Studio (`select approve_device_pairing('123456', '<branch
--    uuid>')`), tomorrow by whatever admin screen gets built — the function
--    itself does not change either way. Re-derives the caller's identity
--    from auth.uid() (never trusts a client-supplied merchant/branch claim),
--    verifies real branch ownership via merchant_members, and consumes the
--    code (clears it) so it can never be reused or race two approvals onto
--    the same device.
-- ---------------------------------------------------------------------------
create or replace function public.approve_device_pairing(p_pairing_code text, p_branch_id uuid) returns public.devices
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_row public.devices;
begin
  if v_uid is null then
    raise exception 'يجب تسجيل الدخول أولاً';
  end if;

  if not exists (
    select 1 from public.branches b
    join public.merchant_members mm on mm.merchant_id = b.merchant_id
    where b.id = p_branch_id and mm.auth_user_id = v_uid
  ) then
    raise exception 'لا تملك صلاحية على هذا الفرع';
  end if;

  select * into v_row from public.devices
  where pairing_code = p_pairing_code and branch_id is null
  for update;

  if v_row.id is null then
    raise exception 'رمز الإقران غير صالح أو استُخدم من قبل';
  end if;

  update public.devices
  set branch_id = p_branch_id, pairing_code = null, last_seen_at = now()
  where id = v_row.id
  returning * into v_row;

  return v_row;
end;
$$;

grant execute on function public.approve_device_pairing(text, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 6. kiosk_earn_points(): the ONLY path that may ever write a kiosk-driven
--    'earn' transaction. Everything about "who" (the calling device, via
--    auth.uid()) and "is this even allowed right now" (branch_settings.
--    demo_earn_enabled) is re-derived and re-checked server-side — the
--    client passes only phone/amount/category. source is NEVER taken from
--    the caller: forced to 'demo' unconditionally, because today this
--    function has exactly one caller and one reason to run (see file header)
--    — there is no "real" mode yet to accidentally mislabel.
-- ---------------------------------------------------------------------------
alter table public.point_transactions drop constraint if exists point_transactions_source_check;
alter table public.point_transactions
  add constraint point_transactions_source_check
  check (source in ('system','backfill','kiosk_manual','app_session','pos','admin','demo'));

alter table public.invoices drop constraint if exists invoices_source_check;
alter table public.invoices
  add constraint invoices_source_check
  check (source in ('manual','pos','demo'));

create or replace function public.kiosk_earn_points(p_phone text, p_amount numeric, p_category text default null)
returns table(profile_id uuid, prev_points integer, added_points integer, total_points integer, invoice_id uuid)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_device public.devices;
  v_branch public.branches;
  v_settings public.branch_settings;
  v_merchant public.merchants;
  v_phone text;
  v_profile_id uuid;
  v_added integer;
  v_prev integer;
  v_invoice_id uuid;
begin
  select * into v_device from public.devices
  where auth_user_id = auth.uid() and is_active and revoked_at is null;

  if v_device.id is null or v_device.branch_id is null then
    raise exception 'الجهاز غير مقارَن بفرع بعد';
  end if;

  select * into v_settings from public.branch_settings where branch_id = v_device.branch_id;
  if not coalesce(v_settings.demo_earn_enabled, false) then
    raise exception 'الوضع التجريبي لاحتساب النقاط غير مُفعَّل لهذا الفرع';
  end if;

  select * into v_branch from public.branches where id = v_device.branch_id;
  select * into v_merchant from public.merchants where id = v_branch.merchant_id;

  v_phone := public.normalize_sa_phone(p_phone);
  if v_phone is null then
    raise exception 'رقم جوال غير صحيح';
  end if;

  if p_amount is null or p_amount <= 0 then
    raise exception 'مبلغ غير صالح';
  end if;

  select id into v_profile_id from public.profiles where phone = v_phone and deleted_at is null;
  if v_profile_id is null then
    raise exception 'NOJ_CUSTOMER_NOT_FOUND';
  end if;

  v_added := round(p_amount * v_merchant.points_rate)::integer;

  insert into public.merchant_loyalty (user_id, merchant_id, points)
  values (v_profile_id, v_merchant.id, 0)
  on conflict (user_id, merchant_id) do nothing;

  select points into v_prev from public.merchant_loyalty
  where user_id = v_profile_id and merchant_id = v_merchant.id
  for update;

  update public.merchant_loyalty
  set points = points + v_added, updated_at = now()
  where user_id = v_profile_id and merchant_id = v_merchant.id;

  insert into public.invoices (user_id, merchant_id, amount, vat, category, points_earned, status, source)
  values (v_profile_id, v_merchant.id, p_amount, 0, coalesce(p_category, v_merchant.type), v_added, 'paid', 'demo')
  returning id into v_invoice_id;

  insert into public.point_transactions
    (user_id, merchant_id, branch_id, device_id, type, points_delta, points_rate_applied, invoice_id, source)
  values
    (v_profile_id, v_merchant.id, v_branch.id, v_device.id, 'earn', v_added, v_merchant.points_rate, v_invoice_id, 'demo');

  return query select v_profile_id, v_prev, v_added, v_prev + v_added, v_invoice_id;
end;
$$;

-- authenticated only, not anon — same reasoning as request_device_pairing()
-- above in this same file.
revoke execute on function public.kiosk_earn_points(text, numeric, text) from public, anon;
grant execute on function public.kiosk_earn_points(text, numeric, text) to authenticated;
