# اختبارات هجرات Supabase

اختبارات محلية لملفات `supabase-migration-*.sql` في جذر الريبو — لا تحتاج مشروع Supabase حي، وتعمل ضد نسخة محلية عادية من Postgres 16. `00_auth_stub.sql` يحاكي شيئين توفّرهما منصة Supabase نفسها كبنية تحتية جاهزة: مخطط `auth` الأدنى (`auth.users`, `auth.uid()`)، و**منح EXECUTE الافتراضي** الذي تطبّقه Supabase تلقائياً على `anon`/`authenticated`/`service_role` بالاسم مباشرة لكل دالة جديدة في `public` (`auto_expose_new_tables`، مؤكَّد عبر `supabase init`) — محاكاة هذا الجزء تحديداً أضيفت بعد أن وُجدت عدة دوال `SECURITY DEFINER` مفتوحة فعلياً على المشروع الحي رغم اجتيازها لكل الاختبارات المحلية القديمة؛ بدونها، نسيان `revoke` صريح لدالة حسّاسة كان سينجح محلياً ويبقى مفتوحاً على الحي بصمت. راجع CLAUDE.md ("دوال SECURITY DEFINER") للتفصيل الكامل.

**لا تُشغَّل هذه الاختبارات تلقائياً في أي مكان بعد — تُشغَّل يدوياً فقط.**

## المتطلبات

- Postgres 16 يعمل محلياً (منفذ 5432)، ودور `postgres` بصلاحية superuser.
- دورا `anon` و`authenticated` موجودان مسبقاً في الـ cluster (بلا صلاحية دخول) — إن لم يكونا موجودين، أنشئهما أولاً:
  ```
  create role anon; create role authenticated;
  ```
  (`service_role` لا يحتاج هذه الخطوة — `00_auth_stub.sql` ينشئه تلقائياً إن لم يكن موجوداً.)
- Node.js + الحزم في `package.json` (`npm install`).

## التشغيل

```
cd db-tests
npm install
npm test
```

هذا يشغّل ثلاثة ملفات بالتتابع:

1. `run_tests.js` — يعيد بناء قاعدة بيانات `noj_test` من الصفر (يحذفها إن كانت موجودة)، يطبّق `supabase-schema.sql` وكل ملفات الهجرة بترتيبها الموثّق في الجدول أعلى هذا المستودع، ثم يشغّل تأكيدات تغطي: التسابق عند الاستبدال، سلامة `redeem_reward()`/`cancel_appointment()` كـ`SECURITY DEFINER`، ازدواج فاتورة POS، توحيد صيغة الجوال، تطبيق الموافقة قبل تسجيل نقاط، المزامنة التلقائية بين `merchants`/`branches`/`branch_settings`، طلب حذف البيانات، التحقق الحقيقي من الجوال (`record_otp_request`/`claim_or_create_verified_profile`)، نقطة استقبال POS (`issue_branch_pos_token`/`intake_pos_transaction`)، و**قفل الصلاحيات**: أن كل دالة `SECURITY DEFINER` حسّاسة (`request_data_deletion`, `issue_branch_pos_token`, `intake_pos_transaction`, `purge_expired_unclaimed_customers`, `claim_or_create_profile`) غير قابلة للاستدعاء من `authenticated`/`anon` إطلاقاً (أو من `service_role` فقط حين يلزم)، أن `merchant_members` محمي من الإدراج المباشر، وأن `verify_admin_pin` يربط المستدعي بفرعه فعلياً ويطبّق حدّ محاولات (5 خلال 15 دقيقة).
2. `run_lockdown_tests.js` — يعيد بناء قاعدة بيانات `noj_test` من جديد (بملفات القاعدة + ملف القفل الأمني وحدهما، بلا عائلة الفروع/السجل) ليتحقق أن الإصلاح الأمني يعمل بمعزل تام عن بقية هذا الفرع: فشل التحديث المباشر على الجداول الأربعة حتى لصاحب الصف نفسه، سلامة `redeem_reward()` والتسابق بعد تحويلها لـ`SECURITY DEFINER`، تحقق الملكية في `cancel_appointment()`، ومقاومة فعلية لتلاعب `search_path`.
3. `regression_check.js` — يتحقق أن المسارات الحالية التي يعتمد عليها `index.html` فعلاً (بيانات العميل التجريبي المزروع، `merchant_loyalty`, `invoices`, `get_merchant_clinics`, `get_merchant_queue_stats`, `rewards`) ما زالت تعمل بعد تطبيق كل الملفات. لا يستدعي `claim_or_create_profile(text)` بعد الآن (أُغلقت أمام أي عميل حقيقي — راجع CLAUDE.md)؛ يربط جلسته بالملف التجريبي مباشرة كمسؤول بدل ذلك.

## ملاحظة مهمة

هذه الاختبارات تعمل ضد Postgres عادي، وليس ضد Supabase الفعلي — `00_auth_stub.sql` يحاكي فقط الحد الأدنى (`auth.users`, `auth.uid()`) الذي توفّره منصة Supabase نفسها كبنية تحتية جاهزة. **لا تُطبَّق أي ملفات هجرة على مشروع Supabase حقيقي إلا بعد مراجعتها والموافقة عليها صراحة.**
