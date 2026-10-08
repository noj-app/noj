-- ============================================================================
-- NOJ — migration: kiosk real balance lookup (kiosk_lookup_customer_points)
-- ============================================================================
-- Discovered while wiring kiosk.html itself (stage د, the actual UI
-- connection): a kiosk device's own Supabase Auth session is NOT the
-- customer's — profiles/merchant_loyalty's existing RLS ("own row only",
-- auth_user_id = auth.uid()) correctly blocks a device from reading a
-- stranger's profile or balance via a plain SELECT, by the exact same
-- design that already protects one customer's data from every OTHER
-- customer. A device needs its own narrow, purpose-built read path — the
-- same SECURITY DEFINER pattern already used for kiosk_earn_points
-- (supabase-migration-kiosk-device-auth.sql), applied to a read instead of
-- a write.
--
-- Also discovered: public.branches had NO device-scoped SELECT policy at
-- all — supabase-migration-kiosk-device-auth.sql added one for devices and
-- branch_settings, but not branches itself, so a paired device could not
-- even read its own branch's merchant_id (needed to look up
-- merchants.points_rate). Added below, same pattern as the existing device
-- policies in that file.
--
-- kiosk_lookup_customer_points() is READ-ONLY and carries NO
-- demo_earn_enabled gate (unlike kiosk_earn_points) — showing an existing,
-- real balance is not the risk that writing a fabricated amount is; the
-- gate stays exactly where it already is, on the write path only. It
-- raises the same NOJ_CUSTOMER_NOT_FOUND sentinel kiosk_earn_points already
-- uses, so kiosk.html catches both with one pattern.
--
-- ADDITIVE / SAFE: no existing table, column, or policy is altered or
-- dropped. Run this ONCE, after supabase-migration-kiosk-device-auth.sql.
-- Safe to run more than once.
-- ============================================================================

drop policy if exists "device can select its own branch" on public.branches;
-- A raw `exists (select 1 from devices ...)` here would recurse forever:
-- devices' own "merchant staff can select their devices" policy (from
-- supabase-migration-branches-devices.sql) queries branches, so evaluating
-- THIS policy's subquery against devices would re-trigger devices' policy,
-- which re-queries branches, which re-evaluates this policy... Postgres
-- correctly detects this as infinite recursion (confirmed by hitting it
-- while testing, not by reasoning alone) and refuses the whole query.
-- The standard fix: a SECURITY DEFINER helper whose OWN internal query
-- bypasses RLS entirely (runs as the function owner), so it never
-- re-triggers devices' policy in the first place — breaking the cycle.
create or replace function public.current_device_branch_id() returns uuid
language sql
security definer
set search_path = public
stable
as $$
  select branch_id from public.devices where auth_user_id = auth.uid();
$$;

-- authenticated only, not anon — every kiosk session signs in anonymously
-- (authenticated-role JWT) before any query touches branches/devices, so no
-- genuine anon-role evaluation of this RLS-policy helper ever happens. Also
-- revokes PUBLIC's own separate implicit grant from plain `create
-- function` — see the fuller note on claim_or_create_profile(text) in
-- supabase-schema.sql.
revoke execute on function public.current_device_branch_id() from public, anon;
grant execute on function public.current_device_branch_id() to authenticated;

drop policy if exists "device can select its own branch" on public.branches;
create policy "device can select its own branch"
  on public.branches for select
  using (id = public.current_device_branch_id());

create or replace function public.kiosk_lookup_customer_points(p_phone text)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_device public.devices;
  v_branch public.branches;
  v_phone text;
  v_profile_id uuid;
  v_points integer;
begin
  select * into v_device from public.devices
  where auth_user_id = auth.uid() and is_active and revoked_at is null;

  if v_device.id is null or v_device.branch_id is null then
    raise exception 'الجهاز غير مقارَن بفرع بعد';
  end if;

  select * into v_branch from public.branches where id = v_device.branch_id;

  v_phone := public.normalize_sa_phone(p_phone);
  if v_phone is null then
    raise exception 'رقم جوال غير صحيح';
  end if;

  select id into v_profile_id from public.profiles where phone = v_phone and deleted_at is null;
  if v_profile_id is null then
    raise exception 'NOJ_CUSTOMER_NOT_FOUND';
  end if;

  select points into v_points from public.merchant_loyalty
  where user_id = v_profile_id and merchant_id = v_branch.merchant_id;

  return coalesce(v_points, 0);
end;
$$;

-- authenticated only, not anon — see the note on current_device_branch_id()
-- above in this same file.
revoke execute on function public.kiosk_lookup_customer_points(text) from public, anon;
grant execute on function public.kiosk_lookup_customer_points(text) to authenticated;
