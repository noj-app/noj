-- ============================================================================
-- NOJ — migration: remove مواصلات + duplicate demo merchants
-- ============================================================================
-- Trims the demo dataset down to exactly one merchant per active sector —
-- مطعم مذاق (مطاعم), بنده (بقالة), ستاربكس (مقاهي), غسيل السيارات السريع
-- (أخرى), ومركز النور الطبي (صحة) — and removes مواصلات entirely (not on
-- the product roadmap right now). This is the RETROACTIVE cleanup for a
-- project that already ran supabase-schema.sql / supabase-migration-
-- merchant-loyalty.sql / supabase-migration-merchant-features.sql before
-- this change: those three files have ALSO been edited so a brand-new
-- project seeded from scratch already comes out this way — if you have
-- NOT seeded a live project yet, you do not need this file at all, just
-- run the (now-updated) files you'd normally run.
--
-- Removed merchants (and everything that referenced them):
--   أوبر، كريم                              — مواصلات (dropped entirely)
--   مقهى بارز، كوستا                        — دوپليكيت مقاهي (كُنّ ستاربكس)
--   برجر بوينت                              — دوپليكيت مطاعم (كُنّ مطعم مذاق)
--   كارفور                                  — دوپليكيت بقالة (كُنّ بنده)
--   صيدلية النهدي، صيدلية الدواء            — دوپليكيت أخرى (كُنّ غسيل السيارات)
--
-- Kept, untouched: مطعم مذاق، بنده، ستاربكس، غسيل السيارات السريع، مركز
-- النور الطبي (+ كل عياداته ومواعيده وبيانات انتظاره).
--
-- ADDITIVE-SAFE IN INTENT BUT NOT IN EFFECT: this migration deliberately
-- DELETES rows (the opposite of every other migration in this repo) —
-- that is the whole point of a demo-data cleanup. It only ever touches
-- the specific merchant IDs listed below; it never touches مطعم مذاق,
-- بنده, ستاربكس, غسيل السيارات السريع, مركز النور الطبي, or any of the
-- health center's clinics/appointments/queue_tickets. Safe to run more
-- than once (every statement is a plain DELETE — a second run simply
-- deletes 0 rows). Run this ONCE in the Supabase SQL Editor, after
-- supabase-schema.sql and supabase-migration-merchant-loyalty.sql (order
-- relative to the other migration files does not matter).
-- ============================================================================

-- invoices reference merchants with `on delete restrict`, so they must be
-- removed before the merchants themselves.
delete from public.invoices where merchant_id in (
  '20000000-0000-0000-0000-000000000004', -- صيدلية النهدي
  '20000000-0000-0000-0000-000000000005', -- أوبر
  '20000000-0000-0000-0000-000000000006', -- مقهى بارز
  '20000000-0000-0000-0000-000000000007', -- برجر بوينت
  '20000000-0000-0000-0000-000000000008', -- كارفور
  '20000000-0000-0000-0000-000000000009', -- كوستا
  '2000000a-0000-0000-0000-00000000000a', -- كريم
  '2000000b-0000-0000-0000-00000000000b'  -- صيدلية الدواء
);

-- rewards/merchant_loyalty cascade on merchant delete already, but deleted
-- explicitly too for clarity about exactly what this migration removes.
delete from public.rewards where merchant_id in (
  '20000000-0000-0000-0000-000000000005'  -- أوبر ("توصيل مجاني على أي رحلة")
);

delete from public.merchant_loyalty where merchant_id in (
  '20000000-0000-0000-0000-000000000004', -- صيدلية النهدي
  '20000000-0000-0000-0000-000000000005', -- أوبر
  '20000000-0000-0000-0000-000000000006', -- مقهى بارز
  '20000000-0000-0000-0000-000000000007', -- برجر بوينت
  '20000000-0000-0000-0000-000000000008', -- كارفور
  '20000000-0000-0000-0000-000000000009', -- كوستا
  '2000000a-0000-0000-0000-00000000000a', -- كريم
  '2000000b-0000-0000-0000-00000000000b'  -- صيدلية الدواء
);

delete from public.merchants where id in (
  '20000000-0000-0000-0000-000000000004', -- صيدلية النهدي
  '20000000-0000-0000-0000-000000000005', -- أوبر
  '20000000-0000-0000-0000-000000000006', -- مقهى بارز
  '20000000-0000-0000-0000-000000000007', -- برجر بوينت
  '20000000-0000-0000-0000-000000000008', -- كارفور
  '20000000-0000-0000-0000-000000000009', -- كوستا
  '2000000a-0000-0000-0000-00000000000a', -- كريم
  '2000000b-0000-0000-0000-00000000000b'  -- صيدلية الدواء
);
