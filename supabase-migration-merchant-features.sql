-- ============================================================================
-- NOJ — migration: merchant feature flags + aggregate queue stats
-- ============================================================================
-- Adds what the "متاجري" (My Merchants) tab and its per-merchant detail page
-- need, beyond what index.html could already read from Supabase:
--
--   1. Two per-MERCHANT capability flags: booking_enabled, queue_enabled.
--      Whether a merchant runs a loyalty program was already inferable from
--      data (a merchant_loyalty row existing for a user), but "does this
--      merchant let customers pre-book" and "does this merchant run a live
--      smart queue" are properties of the merchant itself — independent of
--      any one customer's history — and there was nowhere to store that.
--      A feature a merchant hasn't turned on must not appear on its page at
--      all; these flags are exactly what lets the client decide that.
--
--   2. get_merchant_queue_stats(): an aggregate, privacy-safe view of how
--      many people are currently waiting at a merchant, broken down by
--      unit/clinic. The existing queue_tickets RLS policy ("select own
--      queue tickets") deliberately lets a customer see only their OWN
--      ticket rows — correct, since a ticket row identifies a specific
--      customer. This RPC is SECURITY DEFINER so it can read across every
--      customer's rows for one merchant, but it only ever returns a GROUPED
--      COUNT per unit — never an individual row, never a user_id, never a
--      ticket_number that isn't the caller's own — so nothing private is
--      exposed through it.
--
--   3. One additional demo merchant + invoice (no merchant_loyalty row for
--      it), purely so the existing seeded demo profile (phone 512345678)
--      has a concrete, ready-to-click example of "a merchant with invoices
--      but no loyalty program" sitting next to "مطعم مذاق" (which has
--      loyalty + rewards + booking + a live queue) — the exact contrast
--      asked for when testing "افتح متجرًا لديه ولاء وآخر بلا ولاء". This
--      does not touch or remove anything already seeded.
--
-- ADDITIVE / SAFE: no existing table is dropped, no existing row is deleted
-- or modified except giving two existing merchants their new flags (see
-- below — a column default, not data loss). Run this ONCE in the Supabase
-- SQL Editor, after supabase-schema.sql (any order relative to the other
-- supabase-migration-*.sql files in this repo). Safe to run more than once.
-- ============================================================================

alter table public.merchants add column if not exists booking_enabled boolean not null default false;
alter table public.merchants add column if not exists queue_enabled boolean not null default false;

-- Demo seed: مطعم مذاق already has a seeded queue ticket (#47) in
-- supabase-schema.sql — turn both flags on for it and for the other
-- مطاعم-type merchant, so "متاجري" has a concrete example of a merchant
-- offering booking + a live queue. Every other seeded merchant keeps both
-- flags at their default false — no booking/queue section shown for them,
-- per the "a feature a merchant hasn't activated must not appear at all"
-- requirement.
update public.merchants set booking_enabled = true, queue_enabled = true
where id in (
  '20000000-0000-0000-0000-000000000001', -- مطعم مذاق
  '20000000-0000-0000-0000-000000000007'  -- برجر بوينت
);

-- ---------------------------------------------------------------------------
-- get_merchant_queue_stats: aggregate waiting-count per unit/clinic for one
-- merchant. See rationale in the file header above.
-- ---------------------------------------------------------------------------
create or replace function public.get_merchant_queue_stats(p_merchant_id uuid)
returns table(unit_name text, waiting_count bigint)
language sql
security definer
set search_path = public
stable
as $$
  select coalesce(unit_name, 'عام') as unit_name, count(*) as waiting_count
  from public.queue_tickets
  where merchant_id = p_merchant_id and status = 'waiting'
  group by unit_name
  order by waiting_count desc;
$$;

grant execute on function public.get_merchant_queue_stats(uuid) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Demo contrast merchant: invoices but no loyalty program at all — sits
-- next to مطعم مذاق (loyalty + rewards + booking + queue) in the demo
-- profile's "متاجري" list so both ends of the feature-toggling behavior are
-- directly clickable without needing to construct a scenario by hand.
-- ---------------------------------------------------------------------------
insert into public.merchants (id, name, branch, type, logo_color, booking_enabled, queue_enabled) values
  ('20000000-0000-0000-0000-00000000000c', 'غسيل السيارات السريع', null, 'أخرى', '#64748B', false, false)
on conflict (id) do nothing;

insert into public.invoices (id, user_id, merchant_id, amount, vat, category, items, points_earned, status, created_at) values
  ('40000013-0000-0000-0000-000000000013', '11111111-1111-1111-1111-111111111111', '20000000-0000-0000-0000-00000000000c', 45.00, 5.87, 'أخرى',
    '[{"n":"غسيل خارجي وداخلي","p":45}]'::jsonb, 0, 'paid', '2025-05-02 09:00:00+03')
on conflict (id) do nothing;
-- deliberately NO merchant_loyalty row inserted for this merchant — that is
-- exactly what makes "متاجري" hide its loyalty section for it.
