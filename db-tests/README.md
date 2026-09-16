# اختبارات إصلاح القفل الأمني (lockdown)

اختبارات محلية لـ `supabase-migration-lockdown-direct-writes.sql` — لا تحتاج مشروع Supabase حي، وتعمل ضد نسخة محلية عادية من Postgres 16 (المعادلة الوحيدة المطلوبة: مخطط `auth` الأدنى الذي توفّره منصة Supabase نفسها، مُحاكى هنا في `00_auth_stub.sql`).

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

يعيد `run_lockdown_tests.js` بناء قاعدة بيانات `noj_test` من الصفر (يحذفها إن كانت موجودة)، يطبّق `supabase-schema.sql` وملفات الهجرة القائمة (merchant-features، merchant-loyalty، health-center، fix-profile-reclaim، cleanup-demo-data) ثم `supabase-migration-lockdown-direct-writes.sql`، ثم يشغّل 14 تأكيداً تغطي:

- فشل أي تحديث مباشر (UPDATE) من العميل على `merchant_loyalty` و`appointments` و`profiles` و`queue_tickets`، حتى من صاحب الصف نفسه.
- أن `redeem_reward()` ما زالت تعمل، وما زالت آمنة من التسابق (race condition)، بعد تحويلها إلى SECURITY DEFINER.
- أن `cancel_appointment()` تعمل لصاحب الموعد، وتفشل لمن يحاول إلغاء موعد غيره أو إلغاء موعد أُلغي مسبقاً.
- أن تثبيت `search_path` داخل الدوال يصمد أمام محاولة تلاعب فعلية (جدول وهمي في مخطط يتحكم به المهاجم).

## ملاحظة مهمة

هذه الاختبارات تعمل ضد Postgres عادي، وليس ضد Supabase الفعلي. **لا تُطبَّق أي ملفات هجرة على مشروع Supabase حقيقي إلا بعد مراجعتها والموافقة عليها صراحة.**
