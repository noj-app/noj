-- ============================================================================
-- NOJ — migration: timezone convention + day-boundary helper
-- ============================================================================
-- Nothing to migrate about STORAGE: every timestamp column in this schema
-- (public.*.created_at, updated_at, granted_at, etc.) is already
-- `timestamptz`, which Postgres always stores as a UTC instant internally
-- regardless of any session's local timezone setting — that part of "خزّن
-- UTC" was true before this file and needed no change.
--
-- What DID need addressing: any future "what day is it" logic — e.g.
-- resetting a clinic's queue_tickets.ticket_number back to 1 each morning —
-- must not silently use the database server's own session timezone (which
-- may be UTC, may be something else depending on hosting) to decide where
-- midnight falls. riyadh_today() below is the one place that decision is
-- made, so every future day-scoped feature computes "today" the same way.
--
-- NOTE: no such day-scoped feature exists yet in the current schema —
-- public.queue_tickets.ticket_number today is a plain integer with no
-- daily-reset logic at all (a pre-existing gap, not introduced by this
-- migration, and out of scope for this round). This file only adds the
-- helper function so that whichever future migration adds the reset job
-- has a single, already-agreed-upon definition of "today" to build on
-- instead of inventing its own.
--
-- ADDITIVE / SAFE: adds one new function, touches no table. Run this ONCE,
-- any time. Safe to run more than once.
-- ============================================================================

create or replace function public.riyadh_today() returns date
language sql
stable
as $$
  select (now() at time zone 'Asia/Riyadh')::date;
$$;
