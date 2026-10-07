# معمارية نوج

## مسار الفاتورة (معتمد)
1. كاشير المتجر (نظام POS الخاص بالمتجر) يُصدر الفاتورة.
2. تنتقل الفاتورة تلقائياً إلى نظام نوج (Supabase). — لم يُبنَ بعد.
3. تظهر على شاشة العميل (kiosk.html): المبلغ وطلب الجوال أو الرقم.
4. العميل يُدخل رقمه، فتُربط الفاتورة به، وتُحتسب النقاط، وتصل لتطبيق العميل (index.html).

## الأنظمة
- شاشة العميل: kiosk.html، على طاولة الكاشير.
- تطبيق العميل: index.html.
- لوحة التاجر: لإدارة الأجهزة والإعدادات والعملاء والتقارير، وليست جزءاً من مسار الفاتورة.

## قرارات ثابتة
- البيانات تأتي من كاشير المتجر مباشرة. لا إدخال يدوي ولا جهاز إضافي للموظف.
- الربط مع POS: نقطة استقبال موحّدة في نوج، ومحوّل لكل نظام كاشير. يُبنى المحوّل حين يُعرف نظام أول عميل.
  نقطة الاستقبال (مرحلة ٢، مبنية): Edge Function باسم pos-intake (supabase/functions/pos-intake/)،
  تستقبل POST من كاشير الفرع بتوثيق Authorization: Bearer <توكن الفرع> — التوكن عشوائي 256-بت، يُخزَّن
  hash-ه فقط (SHA-256، لا bcrypt: توكن عالي العشوائية لا يحتاج KDF بطيئة) في branch_pos_credentials
  (RLS مفعّل بلا أي سياسة ولا أي grant، نفس قفل branch_admin_pins — لا طريق إليه إلا من عميل service
  role داخل pos-intake نفسها). الحمولة الموحّدة: external_ref (إلزامي، لمنع التكرار)، amount (>0)، vat
  (>=0)، device_id (اختياري، يجب أن يتبع نفس الفرع)، metadata (اختياري ومحدود الحجم) — لا رقم جوال
  عميل في الحمولة أبداً، العميل يُدخله لاحقاً على الكشك. رأس X-POS-Vendor يوجّه لمحوّل من سجلّ
  ADAPTERS؛ الآن generic فقط. إعادة إرسال نفس external_ref لنفس الفرع (intake_pos_transaction()، عبر
  on conflict do update مصمَّم عمداً كلمسة بلا تأثير فعلي) تُرجع نفس pos_transactions.id دائماً بنجاح،
  ولا تُدمِج قيم إعادة الإرسال (قد تختلف) في صف قد يكون تجاوز حالة pending فعلاً. issue_branch_pos_
  token(p_branch_id) تُصدر/تُبدّل توكن فرع، تُشغَّل يدوياً من محرر SQL في Supabase فقط (بلا grant لـ
  anon أو authenticated، بلا ثقة بـ auth.uid()، نفس نمط PIN) — تُرجع التوكن الخام مرة واحدة فقط. راجع
  supabase-migration-pos-intake.sql للتفصيل الكامل.
- نشر Edge Functions: عبر .github/workflows/deploy-edge-functions.yml (GitHub Actions)، لا يحتاج
  حاسوباً — زر "Run workflow" من متصفح فقط، **يدوي حصراً** (workflow_dispatch، بلا أي تشغيل تلقائي
  عند push). يخدم send-sms-hook و pos-intake معاً. التوثيق عبر سرّين في إعدادات المستودع
  (SUPABASE_ACCESS_TOKEN، SUPABASE_PROJECT_ID) لا يُكتبان في الكود أبداً. كلتا الدالتين تُنشَر بـ
  verify_jwt=false (في supabase/config.toml دائماً، و--no-verify-jwt في كل أمر نشر كتأكيد إضافي) —
  بوابة Supabase الافتراضية ترفض أي طلب لا يحمل JWT صادراً منها قبل وصول كود الدالة، وكلتا الدالتين
  تتوثّق بآليتها الخاصة داخل الطلب (توكن الفرع لـ pos-intake، توقيع Standard Webhooks لـ
  send-sms-hook) لا بـ JWT. خطوات الإعداد اليدوية الكاملة في supabase-edge-functions-deploy.md.
- القيم في القالب T (invoiceAmount, ticket, ahead, doctorName, topCard) تجريبية حتى يُبنى الربط،
  وزر "التالي (تجربة)" هو المحفّز الوحيد حالياً. لا يُحذف قبل وجود محفّز حقيقي.
- رمز إعدادات الكشك يُتحقق منه في الخادم عبر verify_admin_pin وجدول branch_admin_pins. لا رموز في الكود أبداً.
- ملفات SQL: في جذر المستودع باسم supabase-migration-<وصف>.sql. أي تغيير على قاعدة البيانات الحية يُوثَّق بملف.
- الصلاحيات الحقيقية من سياسات RLS (devices و merchant_members)، والرمز السري قفل واجهة فقط.
- index.html يستخدم تحقق Supabase Phone OTP الحقيقي فعلياً (لا DEMO_CODE بعد الآن) — عبر updateUser/
  verifyOtp (ترقية الجلسة المجهولة القائمة) أو signInWithOtp (رقم مسجَّل مسبقاً بجهاز آخر). لا تشغيل
  حي فعلي قبل: مزوّد Unifonic حقيقي (المرحلة ٢) + اختباره على أرقام الاختبار أولاً (supabase-phone-
  otp-setup.md). حتى ذلك الحين، كل تحقق يمر عبر أرقام الاختبار فقط.
- العميل غير المسجَّل في مسار الفاتورة: فاتورته ونقاطه تُحفظ على رقمه المطبَّع (invoices.pending_phone +
  unclaimed_customers)، وتُحذف نهائياً بعد سنة من آخر فاتورة على ذلك الرقم إن لم يسجّل. نقلها لحسابه
  عند التسجيل (claim_unclaimed_invoices) يشترط profiles.phone_verified_at — لا يكفي كتابة الرقم فقط.
- التحقق من رقم الجوال: Supabase Phone OTP + Send SMS Hook إلى Unifonic (لا مزوّد عالمي مباشر). أرقام
  سعودية (+966) فقط — يُرفض أي رقم آخر قبل استدعاء المزوّد، وعند normalize_sa_phone() أيضاً. claim_or_
  create_profile(p_phone) القديمة تبقى كما هي (تثق بمعاملها، لا تضبط phone_verified_at). الدالة الموثوقة
  الوحيدة لتسجيل دخول حقيقي هي claim_or_create_verified_profile() — بلا معامل، تشتق الرقم من
  auth.users (لا تثق بأي رقم يُمرَّر من العميل أبداً) وتضبط phone_verified_at بنفسها.
- Edge Functions: في supabase/functions/<اسم>/ (بنية CLI الخاصة بـ Supabase، تختلف عمداً عن تسمية
  ملفات SQL المسطّحة في الجذر — ليست ملف migration). send-sms-hook هي أول دالة: تتحقق من توقيع
  Supabase (Standard Webhooks) قبل أي شيء، ترفض أي رقم ليس +966 قبل استدعاء Unifonic، ولا تُسجِّل
  الرمز أو الرقم كاملاً في أي سجل. المفاتيح (سر الـ hook، مفاتيح Unifonic) أسرار Edge Function فقط
  (supabase secrets set) — لا في الكود ولا في المستودع أبداً. خطوات لوحة Supabase اليدوية بترتيبها
  الصحيح (ربط الـ hook أولاً، الأسرار، تفعيل Phone Auth، Allow manual linking، أرقام الاختبار، مدة
  صلاحية الرمز، CAPTCHA، حدود IP) في supabase-phone-otp-setup.md.
- CAPTCHA: Cloudflare Turnstile بوضع Managed (لا hCaptcha)، في index.html و kiosk.html معاً —
  signInAnonymously محمية بنفس الإعداد على مستوى مشروع Supabase الواحد، فتفعيلها في Supabase يُطبَّق
  على إقران الأكشاك أيضاً لا index.html فقط. لا تُفعَّل في لوحة Supabase إلا بعد نشر الكودين معاً
  (راجع supabase-phone-otp-setup.md). TURNSTILE_SITE_KEY الآن المفتاح الحقيقي (widget بوضع Managed
  للنطاق noj-app.github.io) في كلا الملفين — Secret Key المقابل لم يُلصَق في Supabase بعد، فCAPTCHA
  نفسها لا تزال غير مُفعَّلة فعلياً حتى تلك الخطوة.
- الأكشاك: متصفح Chrome عادي فقط — لا متصفح تطبيق Google، ولا وضع التصفح المتخفي. السبب: هذان
  الوضعان قد لا يُبقيان تخزين المتصفح بين مرات التشغيل، فيحتاج الجهاز حل CAPTCHA عند كل إقلاع بدل مرة
  واحدة فقط عند الإقران الأول.
- Allow manual linking (Authentication → Providers في Supabase) يجب تفعيله — مُعطَّل افتراضياً،
  وclaim_or_create_verified_profile() بالكامل مبني على updateUser({phone})+verifyOtp لترقية الجلسة
  المجهولة، وهذا بالضبط المسار الذي يشترطه توثيق Supabase الرسمي لهذا الإعداد (راجع
  supabase-phone-otp-setup.md للتفصيل، بما فيه تضارب ملحوظ بين صفحتين رسميتين حول نطاقه الدقيق).
