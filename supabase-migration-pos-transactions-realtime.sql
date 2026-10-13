-- ============================================================================
-- NOJ — migration: Realtime on pos_transactions (stage 3 — kiosk live capture)
-- ============================================================================
-- Adds public.pos_transactions to Supabase's `supabase_realtime` publication
-- so kiosk.html can subscribe to new pending POS invoices the instant
-- pos-intake inserts them (Postgres Changes, INSERT only), instead of
-- waiting for the manual "التالي (تجربة)" demo button. kiosk.html still
-- falls back to polling every 10 seconds whenever the Realtime channel is
-- disconnected (see startLiveFallbackPoll() in kiosk.html) — this file only
-- has to make the INSERT event deliverable at all.
--
-- RLS stays the authority over WHO can read a row, exactly as before: the
-- existing "device can select its branch pos transactions" policy
-- (supabase-migration-pos-transactions.sql) already scopes every row to the
-- paired device's own branch. Supabase's Postgres Changes feed evaluates
-- that same RLS policy per subscribing connection (not just at publish
-- time) — this has not been exercised against a live Realtime server from
-- this sandbox (no outbound path to one here), so confirm once after
-- deploying: a device must receive INSERTs for its OWN branch only, never
-- another branch's, even if the subscribing client's own `filter` option
-- were tampered with. kiosk.html's channel `filter` (branch_id=eq.<uuid>)
-- is a courtesy narrowing for bandwidth, not the security boundary — RLS is.
--
-- `supabase_realtime` is a publication Supabase creates by default on every
-- hosted project; it does not exist on a plain local Postgres (db-tests),
-- so this file skips silently there instead of erroring, same defensive
-- pattern as the pg_cron block in supabase-migration-pos-transactions.sql.
--
-- ADDITIVE / SAFE: no existing table/column/row/function is touched. Safe
-- to run more than once. Requires supabase-migration-pos-transactions.sql
-- first (pos_transactions itself, and its RLS policy).
-- ============================================================================

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'pos_transactions'
    ) then
      alter publication supabase_realtime add table public.pos_transactions;
    end if;
  else
    raise notice 'supabase_realtime publication not found — expected on a local/plain Postgres test db (Supabase creates it by default on every hosted project, so this is never missing there); nothing to do here in that case.';
  end if;
end $$;
