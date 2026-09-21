-- ============================================================================
-- NOJ — migration: per-merchant points rate + points expiry policy
-- ============================================================================
-- Two independent additions, both plain nullable/defaulted columns on the
-- existing public.merchants table (same pattern already used for
-- booking_enabled/queue_enabled in supabase-migration-merchant-features.sql):
--
--   1. points_rate — how many points one riyal earns for this merchant.
--      Defaults to 1.0 (today's implicit behavior for every merchant).
--      Changing it going forward affects nothing about past transactions:
--      point_transactions.points_rate_applied (added in
--      supabase-migration-point-ledger.sql) is a permanent per-row snapshot
--      of whatever rate was in effect when that specific row was created —
--      no code path ever recomputes an old row's points from the CURRENT
--      merchants.points_rate.
--
--   2. points_expiry_days — business decision made now even though the
--      actual expiry job is not built yet (see below): null means "points
--      never expire" (every current merchant's behavior, unchanged). A
--      merchant can set a real value from day one so it can be published
--      in the program's terms — launching with "points never expire" and
--      silently adding expiry later is the thing to avoid, not the column.
--      No backfill/recompute of existing balances is needed to add this
--      column: point_transactions.created_at (already in the ledger) is
--      all a future expiry job needs to work out which old earn-rows have
--      aged past a merchant's policy — nothing about adding the column
--      itself touches any balance.
--
-- ADDITIVE / SAFE: only adds two new nullable/defaulted columns to
-- public.merchants; no existing column, row, or code path is touched. Run
-- this ONCE, any time after supabase-schema.sql. Safe to run more than once.
-- ============================================================================

alter table public.merchants
  add column if not exists points_rate numeric(10,4) not null default 1.0;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'merchants_points_rate_positive_chk') then
    alter table public.merchants
      add constraint merchants_points_rate_positive_chk check (points_rate > 0);
  end if;
end $$;

alter table public.merchants
  add column if not exists points_expiry_days integer;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'merchants_points_expiry_days_positive_chk') then
    alter table public.merchants
      add constraint merchants_points_expiry_days_positive_chk
      check (points_expiry_days is null or points_expiry_days > 0);
  end if;
end $$;
