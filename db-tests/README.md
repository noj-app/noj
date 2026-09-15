# اختبارات هجرات Supabase

اختبارات محلية لملفات `supabase-migration-*.sql` في جذر الريبو — لا تحتاج مشروع Supabase حي، وتعمل ضد نسخة محلية عادية من Postgres 16 (المعادلة الوحيدة المطلوبة: مخطط `auth` الأدنى الذي توفّره منصة Supabase نفسها، مُحاكى هنا في `00_auth_stub.sql`).

**لا تُشغَّل هذه الاختبارات تلقائياً في أي مكان بعد — تُشغَّل يدوياً فقط.**

## المتطلبات

- Postgres 16 يعمل محلياً (منفذ 5432)، ودور `postgres` بصلاحية superuser.
- دورا `anon` و`authenticated` موجودان مسبقاً في الـ cluster (بلا صلاحية دخول) — إن لم يكونا موجودين، أنشئهما أولاً:
  ```
  create role anon; create role authenticated;
  ```
- Node.js + الحزم في `package.json` (`npm install`).

## التشغيل

```
cd db-tests
npm install
npm test
```

هذا يشغّل:
1. `run_tests.js` — يعيد بناء قاعدة بيانات `noj_test` من الصفر (يحذفها إن كانت موجودة)، يطبّق `supabase-schema.sql` وكل ملفات الهجرة الموجودة بترتيبها الموثّق، ثم الملفات الستة الجديدة، ثم يشغّل 30 تأكيداً تغطي: التسابق عند الاستبدال (استدعاءان متزامنان حقيقيان لـ`redeem_reward()`)، ازدواج فاتورة POS (قيد `unique(merchant_id, external_ref)`)، توحيد صيغة الجوال (`normalize_sa_phone()` + قيد الشكل)، تطبيق الموافقة قبل تسجيل نقاط، المزامنة التلقائية بين `merchants`/`branches`/`branch_settings`، طلب حذف البيانات (بصمة الجوال + تمويه الرقم)، وسياسات RLS الجديدة.
2. `regression_check.js` — يتحقق أن المسارات الحالية التي يعتمد عليها `index.html` فعلاً (`claim_or_create_profile`, `merchant_loyalty`, `invoices`, `get_merchant_clinics`, `get_merchant_queue_stats`, `rewards`) ما زالت تعمل بعد تطبيق الملفات الستة الجديدة.

## ملاحظة مهمة

هذه الاختبارات تعمل ضد Postgres عادي، وليس ضد Supabase الفعلي — `00_auth_stub.sql` يحاكي فقط الحد الأدنى (`auth.users`, `auth.uid()`) الذي توفّره منصة Supabase نفسها كبنية تحتية جاهزة. **لا تُطبَّق أي ملفات هجرة على مشروع Supabase حقيقي إلا بعد مراجعتها والموافقة عليها صراحة.**
