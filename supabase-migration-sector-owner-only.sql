-- ============================================================================
-- NOJ — migration: the merchant's sector is changed by its OWNER only
-- ============================================================================
-- supabase-migration-unified-sectors.sql made merchants.sector_code the single
-- source and branch_settings.sector_code its mirror — with WRITE-THROUGH: any
-- write to a branch's sector (kiosk settings screen, merchant staff) changed
-- the merchant's sector. New decision: the sector is chosen from the merchant
-- dashboard, by the owner, and nowhere else.
--
--   1. merchant_set_sector(merchant, sector) — owner only; the ONLY way to
--      change a merchant's sector from a client. The hold-days rule of
--      unified-sectors.sql is unchanged (a non-customized hold follows the new
--      sector's default; a customized one is left alone) — it lives in the
--      merchants trigger, so it applies to this RPC exactly as before.
--   2. branch_settings.sector_code stays a read-only mirror:
--      - insert: copied from the merchant (unchanged);
--      - an update that keeps the merchant's current value: allowed, a no-op
--        (every kiosk save used to re-send it, and an old kiosk page still
--        loaded on a tablet keeps doing so until it reloads — its other
--        settings must keep saving);
--      - an update to a DIFFERENT value: REJECTED (NOJ_SECTOR_OWNER_ONLY).
--   WHY REJECT, NOT IGNORE SILENTLY: an ignored write "succeeds", so the
--   client keeps showing a sector the server does not have (an old kiosk would
--   switch its template locally and silently revert on its next boot). A
--   rejection is honest — the caller sees the save failed and why — and it
--   cannot hide a privilege problem. The only clients that could still send a
--   different value are old cached pages; the current kiosk.html no longer
--   sends sector_code at all and merchant.html uses the RPC.
--   3. The merchants → branches mirror no longer needs the "origin branch"
--      exclusion (nothing writes through any more); simplified.
--
-- The same two trigger-function bodies are now also in supabase-migration-
-- unified-sectors.sql (identical, compared by db-tests) so re-running that
-- older file can never bring write-through back.
--
-- ADDITIVE / SAFE / IDEMPOTENT: no table, column or row changes; one new RPC,
-- two function bodies replaced. Run ONCE after supabase-migration-unified-
-- sectors.sql. Safe to re-run.
-- ============================================================================

create or replace function public.merchants_sector_mirror_trg() returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.sector_code is distinct from old.sector_code then
    update public.branch_settings bs
    set sector_code = new.sector_code
    from public.branches b
    where b.id = bs.branch_id
      and b.merchant_id = new.id
      and bs.sector_code is distinct from new.sector_code;
  end if;
  return null;
end;
$$;

revoke all on function public.merchants_sector_mirror_trg() from public, anon, authenticated, service_role;

create or replace function public.branch_settings_sector_sync_trg() returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_merchant_id uuid;
  v_sector text;
begin
  select b.merchant_id, m.sector_code into v_merchant_id, v_sector
  from public.branches b
  join public.merchants m on m.id = b.merchant_id
  where b.id = new.branch_id;

  if v_merchant_id is null then
    return new;
  end if;

  if tg_op = 'INSERT' then
    new.sector_code := v_sector;
    return new;
  end if;

  -- read-only mirror: re-sending the current value is fine, changing it is
  -- the owner's job (merchant_set_sector)
  if new.sector_code is distinct from v_sector then
    raise exception 'NOJ_SECTOR_OWNER_ONLY';
  end if;

  return new;
end;
$$;

revoke all on function public.branch_settings_sector_sync_trg() from public, anon, authenticated, service_role;

create or replace function public.merchant_set_sector(p_merchant_id uuid, p_sector text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.merchants;
begin
  if not exists (
    select 1 from public.merchant_members
    where merchant_id = p_merchant_id and auth_user_id = auth.uid() and role = 'owner'
  ) then
    raise exception 'لا تملك صلاحية على هذا التاجر';
  end if;

  if p_sector is null or p_sector not in ('grocery', 'retail', 'cafe', 'restaurant', 'medical', 'services') then
    raise exception 'NOJ_INVALID_SECTOR';
  end if;

  update public.merchants set sector_code = p_sector
  where id = p_merchant_id
  returning * into v_row;

  return jsonb_build_object('sector_code', v_row.sector_code, 'points_hold_days', v_row.points_hold_days);
end;
$$;

revoke execute on function public.merchant_set_sector(uuid, text) from public, anon, authenticated;
grant execute on function public.merchant_set_sector(uuid, text) to authenticated;
