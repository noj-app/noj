-- =============================================================================
-- NOJ — لوحة التاجر: ملخص المرتجعات ونقاطها غير المستردة (PR4، المرحلة الأولى)
-- =============================================================================
-- دالة قراءة واحدة جديدة لشاشة الفواتير في merchant.html: لكل فترة (تواريخ الرياض)
-- وفرع اختياري، ما وصل من عمليات إرجاع وما ترتّب عليها من نقاط:
--   refund_count        عدد عمليات الإرجاع (صفوف pos_refunds، إعادة الإرسال لا تُنشئ صفاً ثانياً)
--   refund_amount       مجموع المبالغ المُرجَعة (شاملة الضريبة)
--   points_cancelled    نقاط معلّقة أُلغيت/خُفِّضت قبل أن تُتاح للعميل (لم تمسّ رصيداً قط)
--   points_deducted     نقاط خُصمت فعلاً من رصيد متاح (refund_adjustment)
--   points_unrecovered  "نقاط غير مستردة من مرتجعات": ما كان يجب خصمه ولم يُخصم لأن العميل صرفه
--                       قبل وصول الإرجاع (الرصيد لا يصبح سالباً أبداً)
--
-- المصدر: public.pos_refunds — سجل لكل عملية إرجاع يكتبه intake_pos_refund() وحده، فيه الفرع
-- ووقت الوصول والنقاط الثلاث (نفس القيم المعادة لـpos-intake). القيم نفسها مشتقة من point_transactions
-- (points_unrecovered = intended_delta − points_delta لصف refund_adjustment)، لكن pos_refunds يحمل الفرع
-- ووقت الإرجاع مباشرة ويغطي الإرجاع قبل المطالبة وعلى فاتورة غير مسجَّلة (نقاطه صفر) — صف لكل عملية.
-- الفترة هنا بوقت **وصول الإرجاع** (لا تاريخ الفاتورة الأصلية): "ما أُرجع هذا الأسبوع".
--
-- الخصوصية: أرقام مجمَّعة فقط — لا معرّف فاتورة ولا عميل ولا مرجع. الجدول نفسه يبقى مقفلاً (لا grant
-- ولا سياسة) كما كان؛ الوصول عبر هذه الدالة فقط.
-- الصلاحية: عضو التاجر (مالك أو موظف) — نفس قاعدة merchant_list_invoices؛ تاجر آخر أو فرع لا يتبعه ⇒ رفض.
-- إضافي وidempotent: create or replace لدالة جديدة فقط، بلا أي تغيير على جدول أو دالة قائمة.
-- =============================================================================

create or replace function public.merchant_refunds_summary(
  p_merchant_id uuid,
  p_from date,
  p_to date,
  p_branch_id uuid default null
) returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_from_ts timestamptz;
  v_to_ts timestamptz;
  v_out jsonb;
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

  select jsonb_build_object(
    'refund_count', count(*),
    'refund_amount', coalesce(sum(r.refund_amount), 0),
    'points_cancelled', coalesce(sum(r.points_cancelled), 0),
    'points_deducted', coalesce(sum(r.points_deducted), 0),
    'points_unrecovered', coalesce(sum(r.points_unrecovered), 0)
  )
  into v_out
  from public.pos_refunds r
  join public.branches b on b.id = r.branch_id
  where b.merchant_id = p_merchant_id
    and (p_branch_id is null or r.branch_id = p_branch_id)
    and r.created_at >= v_from_ts
    and r.created_at < v_to_ts;

  return v_out;
end;
$$;

revoke execute on function public.merchant_refunds_summary(uuid, date, date, uuid) from public, anon;
grant execute on function public.merchant_refunds_summary(uuid, date, date, uuid) to authenticated;

-- فهرس إضافي لنافذة الفرع/الوقت (الجدول صغير اليوم، لكن الاستعلام يتكرر مع كل فتح لشاشة الفواتير)
create index if not exists pos_refunds_branch_created_idx on public.pos_refunds (branch_id, created_at);

-- -----------------------------------------------------------------------------
-- تحقق بعد التطبيق (استعلام واحد):
-- select p.proname,
--        has_function_privilege('anon', p.oid, 'execute') as anon_exec,
--        has_function_privilege('authenticated', p.oid, 'execute') as auth_exec,
--        (select count(*) from pg_indexes where indexname = 'pos_refunds_branch_created_idx') as idx
-- from pg_proc p where p.proname = 'merchant_refunds_summary';
-- المتوقع: صف واحد، anon_exec=false، auth_exec=true، idx=1.
-- -----------------------------------------------------------------------------
