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
  verify_admin_pin(p_branch_id, p_pin) تربط المستدعي بفرعه فعلياً (current_device_branch_id() = p_branch_id
  — لا ثقة بمعامل الفرع وحده، نفس مبدأ عدم الثقة بمعاملات العميل في كل مكان آخر) وتطبّق حدّ محاولات فاشلة
  لكل فرع عبر admin_pin_attempts (5 خلال 15 دقيقة ثم إيقاف مؤقت 15 دقيقة، RLS بلا أي سياسة كبقية جداول
  الأقفال) — بلا هذين، رمز من 4 أرقام قابل للتخمين الكامل (10,000 احتمال) عبر RPC مباشر يتجاوز واجهة
  الكشك كلياً، ولأي فرع لا فرع الجهاز المستدعي فقط. راجع supabase-migration-admin-pin-lockdown.sql.
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
  create_profile(p_phone) القديمة تبقى معرَّفة (لا تُحذف، لتبقى بنية المشروع قابلة لإعادة الإنشاء من
  الصفر) لكن **أُغلقت تماماً أمام anon/authenticated/service_role** (راجع البند التالي) — كانت تثق
  بمعاملها بلا أي تحقق، فتسمح لأي جلسة بامتلاك أي رقم جوال تذكره. الدالة الموثوقة الوحيدة لتسجيل دخول
  حقيقي هي claim_or_create_verified_profile() — بلا معامل، تشتق الرقم من auth.users (لا تثق بأي رقم
  يُمرَّر من العميل أبداً) وتضبط phone_verified_at بنفسها.
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
- **رمز Turnstile يُستهلَك مرة واحدة فقط** لدى Cloudflare/Supabase — مؤكَّد عملياً على الموقع الحي (Safari
  على iOS، بعد تفعيل CAPTCHA تجريبياً): تمرير نفس الرمز في نداء captchaToken ثانٍ لنفس التدفق
  (signInAnonymously ثم updateUser مثلاً) يفشل بصمت ("تعذّر الاتصال بالخادم")، رغم أن Turnstile نفسه
  يُظهر نجاحاً. الإصلاح في index.html: freshTurnstileToken() تطلب رمزاً جديداً قبل كل نداء على حدة
  (لا رمز واحد يُعاد استخدامه)، تُستدعى في sendOtp() (حتى ثلاث مرات: signInAnonymously، updateUser،
  signInWithOtp عند الحاجة) وresendOtp(). kiosk.html لم يكن به استهلاك مزدوج فعلياً (نداء captchaToken
  واحد فقط لكل bootKiosk())، لكن أُصلح احتمال فشل صامت آخر: زر "إعادة المحاولة" يستدعي bootKiosk() من
  جديد على نفس حاوية الودجت دون إزالة الودجت السابق أولاً — الآن يُزال عبر turnstile.remove() قبل كل
  render() جديد. CAPTCHA تبقى غير مُفعَّلة في لوحة Supabase حتى تُختبَر هذه الإصلاحات فعلياً (أرقام
  الاختبار) قبل أي تفعيل حي جديد.
- الأكشاك: متصفح Chrome عادي فقط — لا متصفح تطبيق Google، ولا وضع التصفح المتخفي. السبب: هذان
  الوضعان قد لا يُبقيان تخزين المتصفح بين مرات التشغيل، فيحتاج الجهاز حل CAPTCHA عند كل إقلاع بدل مرة
  واحدة فقط عند الإقران الأول.
- Allow manual linking (Authentication → Providers في Supabase) يجب تفعيله — مُعطَّل افتراضياً،
  وclaim_or_create_verified_profile() بالكامل مبني على updateUser({phone})+verifyOtp لترقية الجلسة
  المجهولة، وهذا بالضبط المسار الذي يشترطه توثيق Supabase الرسمي لهذا الإعداد (راجع
  supabase-phone-otp-setup.md للتفصيل، بما فيه تضارب ملحوظ بين صفحتين رسميتين حول نطاقه الدقيق).
- **دوال SECURITY DEFINER الجديدة: revoke from public وحده لا يكفي أبداً، وreplace لا يكفي أيضاً.**
  اكتُشف (فحص يدوي على المشروع الحي، ثم تأكيد محلي) أن Supabase يمنح EXECUTE افتراضياً لـ anon
  وauthenticated وservice_role **بالاسم مباشرة** على كل دالة جديدة في public عند إنشائها (راجع
  auto_expose_new_tables، مؤكَّد عبر supabase init) — لا عبر PUBLIC، فـ revoke ... from public لا
  يمسّهم إطلاقاً. وجدت هذه الثغرة فعلياً مفتوحة على المشروع الحي في: issue_branch_pos_token،
  intake_pos_transaction (كلتاهما كانتا بـ revoke from public فقط)، وrequest_data_deletion،
  purge_expired_unclaimed_customers، claim_or_create_profile(text) (الثلاثة الأخيرة بلا أي revoke
  إطلاقاً) — أخطرها request_data_deletion: كانت تسمح لأي جلسة authenticated (عميل أو كشك) بحذف/تمويه
  ملف أي عميل آخر فوراً بمجرد معرفة معرّفه.
  **طبقة ثانية منفصلة تماماً**: create function عادية تمنح EXECUTE لـ PUBLIC تلقائياً (سلوك Postgres
  الأساسي، لا علاقة له بـ Supabase) — هذا منفصل عن منحة anon/authenticated المذكورة أعلاه، وكلاهما يمنح
  الوصول بشكل مستقل. مجرد حذف anon من سطر grant لاحق (بدل عمل revoke صريح) لا يزيل أي منحة موجودة
  مسبقاً من PUBLIC أو من منحة Supabase الافتراضية — اكتُشف هذا أثناء محاولة "سحب anon" من دوال مثل
  redeem_reward وkiosk_earn_points، حين ظلّت قابلة للتنفيذ رغم تعديل سطر الـ grant.
  **القاعدة الثابتة لأي دالة SECURITY DEFINER جديدة من الآن فصاعداً**: صرّح بالـ revoke دائماً، لا تكتفِ
  بصياغة الـ grant. دالة مقفلة تماماً (SQL Editor/service_role فقط): `revoke all on function ... from
  public, anon, authenticated [, service_role];`. دالة عميل عادية تحتاج authenticated فقط (لا anon —
  كل جلسة في التطبيق والكشك تمرّ أولاً بـ signInAnonymously، فلا يوجد استدعاء حقيقي بدور anon الخام):
  `revoke execute on function ... from public, anon;` ثم `grant execute on function ... to
  authenticated;`. راجع supabase-migration-pos-intake.sql (القسم المُحدَّث) لأمثلة فعلية، وsupabase-
  edge-functions-deploy.md/db-tests/00_auth_stub.sql لكيفية محاكاة منحة Supabase الافتراضية محلياً
  (أضيفت بعد أن اجتازت هذه الدوال كل الاختبارات المحلية القديمة رغم كونها مفتوحة فعلياً على الحي).
