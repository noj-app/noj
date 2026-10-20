-- ============================================================================
-- NOJ — migration: ONE sector per merchant (six sectors), mirrored everywhere
-- ============================================================================
-- Before this file a business's sector lived in two independent places that
-- could disagree:
--   - merchants.type          (Arabic label: invoice category, read by index.html)
--   - branch_settings.sector_code (English code: kiosk template, merchant.html)
-- e.g. "مركز النور الطبي" could be type 'صحة' while its branch said 'cafe'
-- (the column default), so the kiosk showed a café template for a clinic.
--
-- DECISION: the single source of truth is a new merchants.sector_code — one
-- of six fixed English codes:
--     grocery | retail | cafe | restaurant | medical | services
-- WHY THE MERCHANT, not the branch: everything that depends on the sector is
-- merchant-level — the points hold period (merchants.points_hold_days), the
-- invoice category stamped on every invoice, and what the customer app shows.
-- One business = one sector. The two existing columns stay (nothing that reads
-- them breaks) but can no longer diverge — both are DERIVED, enforced by
-- triggers, not by convention:
--   - merchants.type = a fixed Arabic label of sector_code. The four existing
--     labels are kept byte-for-byte ('بقالة','مقاهي','مطاعم','صحة') because
--     index.html uses them as identifiers (health booking/queue screens,
--     BOOKING_COPY) and every historical invoices.category holds them; the
--     two new sectors get 'تجزئة' and 'خدمات'. The singular display names of
--     the six sectors (بقالة/تجزئة/مقهى/مطعم/صحي/خدمات) are UI text in
--     merchant.html/kiosk.html, never stored. Writers that still set only
--     `type` (old seed files, manual SQL) keep working: the trigger maps the
--     label to its code.
--   - branch_settings.sector_code = a mirror of its merchant's sector_code.
--     It is forced on insert, re-mirrored to every branch when the merchant's
--     sector changes, and a write to it from the existing paths (kiosk
--     settings screen, merchant.html "إعدادات الفرع") is WRITE-THROUGH: it
--     changes the merchant's sector — so kiosk.html/merchant.html keep working
--     exactly as before with no client change, and the value can never drift.
--
-- DATA MIGRATION (labels → codes): بقالة→grocery, تجزئة/تسوق/متاجر→retail,
-- مقاهي/مقهى→cafe, مطاعم/مطعم→restaurant, صحة/صحي→medical, أخرى/خدمات→services,
-- anything else (free text) → services, now and for any later write. The only merchants.type that CHANGES is 'أخرى' →
-- 'خدمات' (the "other" bucket becomes the services sector). invoices are NOT
-- touched at all: an old invoice keeps category 'أخرى' (index.html keeps that
-- key as a legacy alias). Balances, points, ledger rows and invoices are not
-- read-modified-written by this file.
--
-- HOLD DAYS: merchant_default_hold_days() now understands the codes too —
-- grocery/retail = 7, every other sector = 0 (redefined identically in
-- supabase-migration-pending-points.sql, so re-running either file can never
-- revert it). When a merchant's sector changes, its points_hold_days FOLLOWS
-- the new sector's default only if it still equals the OLD sector's default
-- (i.e. nobody customized it); a value the owner set by hand is left alone
-- (merchant.html then only suggests the new default). This file does not
-- change any merchant's current points_hold_days, and existing pending ledger
-- rows keep their release_at (a later hold change is never retroactive).
--
-- NEW RPC: merchant_set_points_hold_days(merchant, days) — owner only, 0..365.
--
-- ADDITIVE / SAFE / IDEMPOTENT. Run ONCE after supabase-migration-pos-
-- refunds.sql. Safe to re-run: the backfills only touch rows still missing a
-- code / still differing from the mirror, which a first run already fixed.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Mapping helpers (internal, pure)
-- ---------------------------------------------------------------------------
create or replace function public.sector_code_from_type(p_type text)
returns text
language sql
immutable
set search_path = public
as $$
  select case
    when p_type in ('grocery', 'retail', 'cafe', 'restaurant', 'medical', 'services') then p_type
    when p_type = 'بقالة' then 'grocery'
    when p_type in ('تجزئة', 'تسوق', 'متاجر') then 'retail'
    when p_type in ('مقاهي', 'مقهى') then 'cafe'
    when p_type in ('مطاعم', 'مطعم') then 'restaurant'
    when p_type in ('صحة', 'صحي') then 'medical'
    when p_type in ('أخرى', 'خدمات') then 'services'
    else null
  end;
$$;

create or replace function public.sector_label(p_sector text)
returns text
language sql
immutable
set search_path = public
as $$
  select case p_sector
    when 'grocery' then 'بقالة'
    when 'retail' then 'تجزئة'
    when 'cafe' then 'مقاهي'
    when 'restaurant' then 'مطاعم'
    when 'medical' then 'صحة'
    when 'services' then 'خدمات'
  end;
$$;

-- identical body in supabase-migration-pending-points.sql (codes AND labels)
create or replace function public.merchant_default_hold_days(p_type text)
returns integer
language sql
immutable
set search_path = public
as $$
  select case when p_type in ('grocery', 'retail', 'بقالة', 'تجزئة', 'تسوق', 'متاجر') then 7 else 0 end;
$$;

revoke all on function public.sector_code_from_type(text) from public, anon, authenticated, service_role;
revoke all on function public.sector_label(text) from public, anon, authenticated, service_role;
revoke all on function public.merchant_default_hold_days(text) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. merchants.sector_code — backfill from type, then lock it down
-- ---------------------------------------------------------------------------
alter table public.merchants add column if not exists sector_code text;

update public.merchants
set sector_code = coalesce(public.sector_code_from_type(type), 'services')
where sector_code is null;

alter table public.merchants alter column sector_code set not null;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'merchants_sector_code_chk') then
    alter table public.merchants
      add constraint merchants_sector_code_chk
      check (sector_code in ('grocery', 'retail', 'cafe', 'restaurant', 'medical', 'services'));
  end if;
end $$;

-- the label follows the code (only 'أخرى' → 'خدمات' actually changes)
update public.merchants
set type = public.sector_label(sector_code)
where type is distinct from public.sector_label(sector_code);

-- ---------------------------------------------------------------------------
-- 3. branch_settings.sector_code — six codes, mirrored from the merchant
-- ---------------------------------------------------------------------------
alter table public.branch_settings drop constraint if exists branch_settings_sector_code_chk;
alter table public.branch_settings
  add constraint branch_settings_sector_code_chk
  check (sector_code in ('grocery', 'retail', 'cafe', 'restaurant', 'medical', 'services'));

update public.branch_settings bs
set sector_code = m.sector_code
from public.branches b
join public.merchants m on m.id = b.merchant_id
where b.id = bs.branch_id
  and bs.sector_code is distinct from m.sector_code;

-- ---------------------------------------------------------------------------
-- 4. Triggers that keep the three columns one value
-- ---------------------------------------------------------------------------
-- merchants BEFORE: derive type from sector_code (or sector_code from a
-- legacy type-only write), hold days follow a NON-customized default.
create or replace function public.merchants_sector_sync_trg() returns trigger
language plpgsql
set search_path = public
as $$
begin
  -- an unknown free-text label falls into 'services' (the old "أخرى" bucket),
  -- the same rule as the backfill above; an invalid CODE is still rejected by
  -- merchants_sector_code_chk.
  if tg_op = 'INSERT' then
    if new.sector_code is null then
      new.sector_code := coalesce(public.sector_code_from_type(new.type), 'services');
    end if;
  elsif new.sector_code is not distinct from old.sector_code
        and new.type is distinct from old.type then
    -- a writer changed only the label (manual SQL / legacy code)
    new.sector_code := coalesce(public.sector_code_from_type(new.type), 'services');
  end if;

  new.type := public.sector_label(new.sector_code);

  if tg_op = 'INSERT' then
    if new.points_hold_days = 0 then
      new.points_hold_days := public.merchant_default_hold_days(new.sector_code);
    end if;
  elsif new.sector_code is distinct from old.sector_code
        and new.points_hold_days = old.points_hold_days
        and old.points_hold_days = public.merchant_default_hold_days(old.sector_code) then
    new.points_hold_days := public.merchant_default_hold_days(new.sector_code);
  end if;

  return new;
end;
$$;

revoke all on function public.merchants_sector_sync_trg() from public, anon, authenticated, service_role;

drop trigger if exists trg_merchants_sector_sync on public.merchants;
create trigger trg_merchants_sector_sync
before insert or update of sector_code, type, points_hold_days on public.merchants
for each row execute function public.merchants_sector_sync_trg();

-- merchants AFTER: mirror the code to every branch's settings (except the
-- branch whose own write started this change — its row is mid-update).
create or replace function public.merchants_sector_mirror_trg() returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_origin uuid := nullif(current_setting('noj.sector_origin_branch', true), '')::uuid;
begin
  if new.sector_code is distinct from old.sector_code then
    update public.branch_settings bs
    set sector_code = new.sector_code
    from public.branches b
    where b.id = bs.branch_id
      and b.merchant_id = new.id
      and bs.sector_code is distinct from new.sector_code
      and (v_origin is null or bs.branch_id <> v_origin);
  end if;
  return null;
end;
$$;

revoke all on function public.merchants_sector_mirror_trg() from public, anon, authenticated, service_role;

drop trigger if exists trg_merchants_sector_mirror on public.merchants;
-- plain AFTER UPDATE (not "OF sector_code"): the code may be changed by the
-- BEFORE trigger above (a label-only write), which "OF" would not see.
create trigger trg_merchants_sector_mirror
after update on public.merchants
for each row execute function public.merchants_sector_mirror_trg();

-- branch_settings BEFORE: insert = copy the merchant's code; an update to a
-- different code = write-through to the merchant (kiosk settings screen and
-- merchant.html keep working unchanged). SECURITY DEFINER: the caller (a
-- paired kiosk device or merchant staff, through the existing RLS update
-- policies) has no write grant on merchants.
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

  if new.sector_code is distinct from v_sector then
    perform set_config('noj.sector_origin_branch', new.branch_id::text, true);
    update public.merchants set sector_code = new.sector_code where id = v_merchant_id;
    perform set_config('noj.sector_origin_branch', '', true);
  end if;

  return new;
end;
$$;

revoke all on function public.branch_settings_sector_sync_trg() from public, anon, authenticated, service_role;

drop trigger if exists trg_branch_settings_sector_sync on public.branch_settings;
create trigger trg_branch_settings_sector_sync
before insert or update of sector_code on public.branch_settings
for each row execute function public.branch_settings_sector_sync_trg();

-- ---------------------------------------------------------------------------
-- 5. merchant_set_points_hold_days() — owner only
-- ---------------------------------------------------------------------------
create or replace function public.merchant_set_points_hold_days(p_merchant_id uuid, p_days integer)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_days integer;
begin
  if not exists (
    select 1 from public.merchant_members
    where merchant_id = p_merchant_id and auth_user_id = auth.uid() and role = 'owner'
  ) then
    raise exception 'لا تملك صلاحية على هذا التاجر';
  end if;

  if p_days is null or p_days < 0 or p_days > 365 then
    raise exception 'NOJ_INVALID_HOLD_DAYS';
  end if;

  update public.merchants set points_hold_days = p_days
  where id = p_merchant_id
  returning points_hold_days into v_days;

  return v_days;
end;
$$;

revoke execute on function public.merchant_set_points_hold_days(uuid, integer) from public, anon, authenticated;
grant execute on function public.merchant_set_points_hold_days(uuid, integer) to authenticated;
