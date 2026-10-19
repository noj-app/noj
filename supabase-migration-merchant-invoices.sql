-- ============================================================================
-- NOJ — migration: merchant dashboard "الفواتير" screen — merchant_list_invoices()
-- ============================================================================
-- A READ-ONLY report function for merchant.html (owner AND staff). One
-- SECURITY DEFINER RPC instead of direct table access, because invoices'
-- own RLS ("select own invoices", supabase-schema.sql) is "a customer reads
-- their own rows" — a merchant must never get a policy on invoices, since
-- every column there (user_id, pending_phone) points at a customer. This
-- function returns ONLY what the dashboard needs and structurally cannot
-- leak a customer: no phone number, no pending_phone, no user_id, no
-- profile data — each invoice carries just a customer STATUS
-- ('registered' | 'unregistered').
--
-- AUTHORIZATION (never trusts a parameter alone):
--   - auth.uid() must be a row in merchant_members for p_merchant_id
--     (owner or staff — no role distinction, same as the devices screen).
--     A parameter naming someone else's merchant is rejected, not filtered.
--   - if p_branch_id is given it must belong to p_merchant_id.
--
-- FILTERS: p_from/p_to are Riyadh calendar dates, inclusive — the window is
-- [p_from 00:00 Asia/Riyadh, (p_to + 1) 00:00 Asia/Riyadh), converted to
-- instants, so an invoice at 00:30 Riyadh time on the 11th is on the 11th
-- even though that is still the 10th in UTC (the same single definition of
-- "a day" as riyadh_today() in supabase-migration-timezone.sql).
-- p_branch_id NULL = all branches. OLDER invoices may have branch_id NULL
-- (invoices.branch_id arrived with supabase-migration-pos-connections.sql;
-- merchants with several branches were deliberately left NULL by its
-- backfill rather than guessed): with "all branches" they are INCLUDED in
-- the rows and in every total, with branch_id/branch_name NULL for the UI to
-- label "غير محدد"; they only drop out when one specific branch is chosen.
-- source='demo' invoices are excluded unless p_include_demo is true.
--
-- TOTALS cover the WHOLE filtered period (not just the returned page):
-- count, sales (sum of amount), vat, refunded, net (= sales - refunded).
-- An invoice whose status is 'refunded' but whose refunded_amount is still
-- NULL (the status value has existed since the first schema, long before
-- refunded_amount) is counted as fully refunded rather than silently as a
-- full sale.
--
-- PAGINATION: newest first (created_at desc, id desc — a stable total
-- order), p_limit clamped to 1..100, p_offset >= 0, has_more in the result.
--
-- GRANTS: revoke from public AND anon explicitly, grant to authenticated
-- only (CLAUDE.md rule for every new SECURITY DEFINER function).
--
-- ADDITIVE / SAFE: one new function and one new index; no table, column or
-- existing function is touched. Run ONCE, after supabase-migration-pos-
-- connections.sql (needs invoices.branch_id/refunded_amount). Safe to run
-- more than once.
-- ============================================================================

create index if not exists invoices_merchant_created_idx
  on public.invoices (merchant_id, created_at desc);

create or replace function public.merchant_list_invoices(
  p_merchant_id uuid,
  p_from date,
  p_to date,
  p_branch_id uuid default null,
  p_include_demo boolean default false,
  p_limit integer default 25,
  p_offset integer default 0
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_from_ts timestamptz;
  v_to_ts timestamptz;
  v_limit integer;
  v_offset integer;
  v_summary jsonb;
  v_rows jsonb;
begin
  if auth.uid() is null
     or p_merchant_id is null
     or not exists (
       select 1 from public.merchant_members mm
       where mm.merchant_id = p_merchant_id and mm.auth_user_id = auth.uid()
     )
  then
    raise exception 'لا تملك صلاحية على هذا التاجر';
  end if;

  if p_branch_id is not null and not exists (
    select 1 from public.branches b
    where b.id = p_branch_id and b.merchant_id = p_merchant_id
  ) then
    raise exception 'لا تملك صلاحية على هذا الفرع';
  end if;

  if p_from is null or p_to is null or p_to < p_from then
    raise exception 'فترة غير صحيحة';
  end if;

  v_from_ts := p_from::timestamp at time zone 'Asia/Riyadh';
  v_to_ts := (p_to + 1)::timestamp at time zone 'Asia/Riyadh';
  v_limit := least(greatest(coalesce(p_limit, 25), 1), 100);
  v_offset := greatest(coalesce(p_offset, 0), 0);

  with base as (
    select i.id, i.created_at, i.branch_id, i.amount, i.vat, i.points_earned,
           i.source, i.status,
           (i.user_id is not null) as is_registered,
           case when i.status = 'refunded' and i.refunded_amount is null
                then i.amount
                else coalesce(i.refunded_amount, 0) end as eff_refunded
    from public.invoices i
    where i.merchant_id = p_merchant_id
      and i.created_at >= v_from_ts
      and i.created_at < v_to_ts
      and (p_branch_id is null or i.branch_id = p_branch_id)
      and (p_include_demo or i.source is distinct from 'demo')
  ),
  page as (
    select * from base
    order by created_at desc, id desc
    limit v_limit offset v_offset
  )
  select
    (select jsonb_build_object(
        'count', count(*),
        'sales', coalesce(sum(amount), 0),
        'vat', coalesce(sum(vat), 0),
        'refunded', coalesce(sum(eff_refunded), 0),
        'net', coalesce(sum(amount - eff_refunded), 0)
      ) from base),
    (select coalesce(jsonb_agg(
        jsonb_build_object(
          'id', p.id,
          'created_at_riyadh', to_char(p.created_at at time zone 'Asia/Riyadh', 'YYYY-MM-DD HH24:MI'),
          'branch_id', p.branch_id,
          'branch_name', b.name,
          'amount', p.amount,
          'vat', p.vat,
          'points_earned', p.points_earned,
          'source', p.source,
          'status', p.status,
          'refunded_amount', p.eff_refunded,
          'customer_status', case when p.is_registered then 'registered' else 'unregistered' end
        ) order by p.created_at desc, p.id desc
      ), '[]'::jsonb)
     from page p left join public.branches b on b.id = p.branch_id)
  into v_summary, v_rows;

  return jsonb_build_object(
    'summary', v_summary,
    'rows', v_rows,
    'limit', v_limit,
    'offset', v_offset,
    'has_more', (v_offset + v_limit) < (v_summary->>'count')::integer
  );
end;
$$;

revoke all on function public.merchant_list_invoices(uuid, date, date, uuid, boolean, integer, integer)
  from public, anon, authenticated;
grant execute on function public.merchant_list_invoices(uuid, date, date, uuid, boolean, integer, integer)
  to authenticated;
