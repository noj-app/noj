# معمارية نوج

## مسار الفاتورة (معتمد — مبني بالكامل الآن)
1. كاشير المتجر (نظام POS الخاص بالمتجر) يُصدر الفاتورة.
2. تنتقل الفاتورة تلقائياً إلى نظام نوج (Supabase) عبر pos-intake (Edge Function، المرحلة ٢).
3. تظهر على شاشة العميل (kiosk.html) فور وصولها: المبلغ الحقيقي وطلب الجوال أو الرقم — التقاط
   مباشر عبر Realtime (مع استعلام احتياطي عند انقطاعه)، لا زر يدوي، في SETTINGS.mode==='live'
   (المرحلة ٣). الوضع التجريبي (demo) يبقى كما كان بزر "التالي (تجربة)" ومبالغ القالب الثابتة.
4. العميل يُدخل رقمه، فتُربط الفاتورة به (kiosk_claim_pos_transaction)، وتُحتسب النقاط، وتصل
   لتطبيق العميل (index.html). عميل غير مسجَّل: فاتورته ونقاطه تُحفظ على رقمه (راجع البند أدناه)
   مع رسالة واضحة بدل أي بيانات رصيد مزيَّفة.

## الأنظمة
- شاشة العميل: kiosk.html، على طاولة الكاشير.
- تطبيق العميل: index.html.
- لوحة التاجر: merchant.html، لإدارة الأجهزة والإعدادات والعملاء والتقارير، وليست جزءاً من مسار
  الفاتورة. المرحلة الأولى (مبنية): دخول برقم الجوال + شاشة الأجهزة فقط — راجع "لوحة التاجر" أدناه.

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
- الالتقاط المباشر في kiosk.html (المرحلة ٣، مبنية): في SETTINGS.mode==='live' فقط — pos_transactions
  مُضافة لـ publication الخاص بـ Realtime على Supabase (supabase-migration-pos-transactions-
  realtime.sql)، فيشترك الجهاز على عمليات INSERT لفرعه فور نجاح الإقران (startLiveTxnWatch)،
  بدل انتظار زر "التالي (تجربة)" (يختفي تماماً في الوضع المباشر، يبقى كما هو في التجريبي). استعلام
  احتياطي كل 10 ثوانٍ (أو window.__NOJ_POLL_MS__ للاختبار) عند انقطاع القناة، يتوقف فور عودتها.
  عملية ثانية تصل أثناء عرض أخرى تُحفظ في طابور (LIVE_TXN_QUEUE) لا تقاطعها — تُعرَض تلقائياً بمجرد
  العودة لشاشة الانتظار إن بقيت صالحة (renderIdle→checkLiveQueueForNext، نقطة واحدة تغطي كل مسارات
  العودة: نجاح الربط، انتهاء الصلاحية، أخطاء الربط). الربط نفسه عبر kiosk_claim_pos_transaction(id,
  phone) — الكشك لا يرسل المبلغ أبداً، يُقرأ من الصف نفسه. عميل غير مسجَّل (is_registered=false):
  رسالة "حُفظت فاتورتك" بدل أي بطاقة رصيد. أخطاء NOJ_TRANSACTION_EXPIRED/NOT_PENDING/NOT_FOUND،
  وانتهاء expires_at قبل أي تفاعل: رجوع تلقائي لشاشة الانتظار برسالة عربية عابرة (للأخطاء بعد محاولة
  ربط فعلية، لا للانتهاء الصامت أثناء عدم الانتباه). قيم تجريبية بلا مصدر حقيقي بعد (ticket/ahead/
  doctorName/topCard بنوع unit) تُخفى بالكامل في الوضع المباشر (لا تُعرض للعميل) — بطاقة نقاط الولاء
  (topCard بنوع points) تبقى، تعرض الآن تقديراً حقيقياً (معامل حقيقي × مبلغ حقيقي). kiosk_earn_points()
  تبقى معرَّفة ومُختبَرة في قاعدة البيانات لكن لم تعد تُستدعى من kiosk.html إطلاقاً — كانت مبنية على
  مبلغ قالب ثابت تجريبي، لم تعد له حاجة بعد وجود مبلغ حقيقي من pos-intake. اختبارات Playwright كاملة
  (Chromium حقيقي + عميل Supabase مزيَّف بالكامل، بلا شبكة حية) في kiosk-tests/.
  **تصليب بعد عطل حي (فاتورة محاكاة وصلت للكشك عبر الاستعلام الاحتياطي لا Realtime، بعد نحو دقيقة)**:
  راجعنا الترتيب الفعلي في bootKiosk/startLiveTxnWatch — الاشتراك يبدأ أصلاً بعد نجاح signInAnonymously/
  نجاح الإقران لا قبله، فهذا الترتيب لم يكن الخلل. الفجوتان الحقيقيتان المُصلَحتان: (1) لا شيء كان يُمرِّر
  توكن الجلسة لـ Realtime صراحة (sb.realtime.setAuth) — الاعتماد كان كلياً على الربط الداخلي الضمني في
  @supabase/supabase-js@2 (توقيته/وجوده بالضبط غير موثَّق وقد يختلف بين الإصدارات، وesm.sh في getSb()
  يجلب "@2" بلا رقم إصدار مثبَّت فيُعاد حلّه لأحدث نسخة بصمت)؛ الآن attachAuthListener(sb) (معلَّقة مرة
  واحدة فقط) تستدعي setAuth صراحة عند SIGNED_IN وTOKEN_REFRESHED معاً. (2) لا إعادة اشتراك فعلية عند
  تجديد التوكن — قناة مفتوحة مسبقاً قد لا "تُعيد التوثيق" تلقائياً لنفسها بتوكن جديد (تفصيل تطبيق داخلي
  في realtime-js لا تأكيد قاطعاً عليه من هذه البيئة بلا اتصال حي)، فأصبح TOKEN_REFRESHED يستدعي
  startLiveTxnWatch() من جديد (إعادة انضمام نظيفة بتوكن طازج، أضمن من الاعتماد على ذلك التفصيل).
  **تشخيص ميداني جديد**: شاشة إعدادات الجهاز (محمية بالرمز) تعرض الآن سطراً (بلا أي بيانات عميل): حالة
  قناة Realtime الحالية (LIVE_RT_STATUS، من نفس دالة status callback في startLiveTxnWatch) ووقت آخر
  حدث INSERT وصل فعلياً عبرها (LIVE_RT_LAST_EVENT_AT، يُفرَّق هنا عمداً عن وقت آخر poll احتياطي) —
  يتحدَّث كل ثانيتين بينما الشاشة مفتوحة (startRtDiagTimer/stopRtDiagTimer). **لم يُتحقَّق بشكل قاطع من
  هذه البيئة** (بلا اتصال حي بمشروع Supabase فعلي، نفس القيد المذكور أصلاً في تعليق supabase-migration-
  pos-transactions-realtime.sql) ما إذا كانت سياسة SELECT المبنية على current_device_branch_id/
  current_device_id تُقيَّم بشكل صحيح داخل مسار تفويض Realtime لـ postgres_changes تحديداً — الدليل
  غير المباشر المتاح فعلاً (الاستعلام الاحتياطي التقط العملية خلال نحو دقيقة، لا أن تبقى معلَّقة للأبد)
  يرجّح عطلاً عابراً في الاتصال الأول (مع برهة إقلاع GitHub Actions نفسها) أعاد تشغيله الاستعلام
  الاحتياطي كما صُمِّم، لا فشلاً صامتاً دائماً في RLS (فشل RLS الصامت يعني القناة تبقى SUBSCRIBED للأبد
  بلا أي حدث يصل أصلاً، ولن يبدأ الاستعلام الاحتياطي حينها إطلاقاً — انظر startLiveFallbackPoll، لا
  يُستدعى إلا من حالة CHANNEL_ERROR/TIMED_OUT/CLOSED). استخدم سطر التشخيص الجديد في أي تشغيل مباشر قادم
  للمحاكاة: إن بقيت الحالة "متصل" باستمرار وتحدَّث "آخر حدث وصل" خلال ثوانٍ من إرسال الفاتورة، فالاتصال
  سليم فعلاً والتأخير السابق كان عابراً؛ إن تكرر التنقّل بين "متصل"/"منقطع"، فالمشكلة اتصال حقيقي يحتاج
  تدقيقاً إضافياً من لوحة Supabase نفسها (لا يُصلَح من كود العميل وحده). شاشة النجاح في الوضع المباشر:
  عناصر okItems بعد الأول (فاتورتك) — رقم دورك/رقم طلبك/موعدك القادم، بلا مصدر حقيقي بعد لأي قطاع — كانت
  تظهر رغم إخفاء نظيراتها (ticket/ahead/topCard نوع unit) في leftCol سابقاً؛ أُخفيت هذه أيضاً الآن في
  success() حين SETTINGS.mode==='live'، فيبقى فقط "فاتورتك" (حدث حقيقي) وبطاقة نقاط الولاء (رصيد حقيقي).
- **إصلاح أمني: جهاز مُلغى (is_active=false أو revoked_at محدَّد) كان يبقى قادراً على قراءة branch_
  settings وpos_transactions.** اكتُشف أثناء تصميم شاشة "لوحة التاجر" المستقبلية لإلغاء جهاز: current_
  device_branch_id() وcurrent_device_id() (supabase-migration-kiosk-balance-lookup.sql وsupabase-
  migration-pos-transactions.sql) كانتا الاستثناءين الوحيدين بين كل دوال سياق الجهاز — kiosk_lookup_
  customer_points/kiosk_earn_points/kiosk_claim_pos_transaction تتحقق جميعها من `is_active and
  revoked_at is null` عند كل استدعاء، لكن هاتين الدالتين (المُستخدَمتين في سياسات RLS القراءة لـ
  branches/branch_settings/pos_transactions، وفي ربط الفرع داخل verify_admin_pin) لم تكونا تتحققان من
  أي منهما إطلاقاً — فجهاز مُلغى بسياسة RLS فقط (بلا حذف صف auth.users) يبقى قادراً على قراءة إعدادات
  فرعه وعملياته، رغم عجزه فعلاً عن الكتابة (المسارات الكاتبة كانت محصَّنة أصلاً). أُصلحتا لتضيفا نفس
  الشرط. سياستا branch_settings الخاصتان بالجهاز ("device can select/update its own branch settings"،
  supabase-migration-kiosk-device-auth.sql) كانتا تكرران استعلام devices داخلياً بمعزل عن current_
  device_branch_id() (لا تستخدمانها، فهذا الملف يُشغَّل قبل تعريفها في السلسلة) ولم تتحققا من الشرط
  أيضاً — أُضيف نفس الشرط إليهما مباشرة (inline، لا عبر الدالة، لعدم كسر ترتيب السلسلة). verify_admin_
  pin() تستفيد تلقائياً (جهاز مُلغى يحاول فتح الإعدادات الآن يُرفض بـNOJ_PIN_WRONG_BRANCH، رسالة موجودة
  أصلاً في kiosk.html). سياسة "device can select its own row" على devices نفسها (قراءة الجهاز لصفّه
  الخاص فقط، لا فرعه) لم تُمسّ عمداً — لا تسرّب شيئاً عابراً للفروع أصلاً، وخارج نطاق هذا الإصلاح. كل
  الاختبارات القديمة (176 قبل هذا الإصلاح) اجتازت دون تغيير — الكشك الفعّال لا يتأثر إطلاقاً، فقط الجهاز
  المُلغى تحديداً.
- نشر Edge Functions: عبر .github/workflows/deploy-edge-functions.yml (GitHub Actions)، لا يحتاج
  حاسوباً — زر "Run workflow" من متصفح فقط، **يدوي حصراً** (workflow_dispatch، بلا أي تشغيل تلقائي
  عند push). يخدم send-sms-hook و pos-intake معاً. التوثيق عبر سرّين في إعدادات المستودع
  (SUPABASE_ACCESS_TOKEN، SUPABASE_PROJECT_ID) لا يُكتبان في الكود أبداً. كلتا الدالتين تُنشَر بـ
  verify_jwt=false (في supabase/config.toml دائماً، و--no-verify-jwt في كل أمر نشر كتأكيد إضافي) —
  بوابة Supabase الافتراضية ترفض أي طلب لا يحمل JWT صادراً منها قبل وصول كود الدالة، وكلتا الدالتين
  تتوثّق بآليتها الخاصة داخل الطلب (توكن الفرع لـ pos-intake، توقيع Standard Webhooks لـ
  send-sms-hook) لا بـ JWT. خطوات الإعداد اليدوية الكاملة في supabase-edge-functions-deploy.md.
- محاكاة فاتورة كاشير (المرحلة ٤، لاختبار المسار كاملاً بلا كاشير حقيقي ولا حاسوب): workflow
  .github/workflows/simulate-pos-invoice.yml (workflow_dispatch فقط، بمدخلات amount إلزامي وvat
  وdevice_id اختياريان) يرسل POST واحدة إلى pos-intake بنفس الحمولة الموحّدة وX-POS-Vendor: generic —
  فلا فرق من جهة الخادم بين فاتورة محاكاة وفاتورة كاشير حقيقي، فالاختبار يغطي المسار الفعلي بالكامل.
  external_ref فريد تلقائياً (sim-<رقم التشغيل>-<الوقت>)، وmetadata.source='github-actions-simulator'
  يميّزها (source_adapter نفسه يبقى 'generic'، مُحدَّد بقيمة رأس X-POS-Vendor الثابتة، فلا يصلح
  للتمييز). التوثيق بسر NOJ_TEST_POS_TOKEN (توكن فرع اختبار حقيقي من issue_branch_pos_token، لا يُطبع
  في أي خطوة من الـ workflow إطلاقاً — تُطبع فقط حالة الاستجابة ومعرّف العملية)، ورابط الدالة من
  SUPABASE_PROJECT_ID الموجود مسبقاً.
  **مصدر حقيقة واحد لبناء الحمولة**: scripts/pos-invoice-payload.mjs (وحدة ES نقية، بلا process/fetch)
  — يستوردها كل من scripts/simulate-pos-invoice.js (سكربت CLI اختياري للمطورين، Node 18+ بلا
  اعتماديات) واختبار Deno supabase/functions/pos-intake/simulator-payload.test.ts، والـ workflow نفسه
  لا يعيد بناء الحمولة بمنطق منفصل بل يستدعي scripts/simulate-pos-invoice.js مباشرة (actions/setup-node
  لضمان Node معروف الإصدار؛ import() ديناميكي في السكربت لا import ثابت، ليعمل كملف CommonJS عادي بلا
  الاعتماد على اكتشاف ESM التلقائي غير المضمون على كل إصدار Node). **سبب هذا التصميم**: عطل حي اكتُشف
  فعلياً — التصميم الأول كرّر منطق بناء الحمولة مباشرة داخل YAML (bash يحسب external_ref كمتغيّر عادي
  غير مُصدَّر، ثم يمرّره لعملية node -e فرعية)، فوصل amount/vat بسلامة (كانا عبر env: في YAML) لكن
  external_ref لم يصل إطلاقاً (JSON.stringify يُسقط الحقل undefined بصمت بدل أن يفشل)، فرفض pos-intake
  الطلب بـ"external_ref مطلوب". عقد pos-intake نفسه (supabase/functions/pos-intake/intake.ts) سليم ولم
  يُعدَّل — العطل كان فقط في تكرار منطق بناء الحمولة بتطبيقين قد ينحرفان عن بعضهما. اختبار Deno الجديد
  يمرّر نفس الحمولة التي تبنيها buildPosInvoicePayload() فعلياً عبر handlePosIntake الحقيقية (لا حمولة
  يدوية معزولة عن الأداة الفعلية)، ليمنع تكرار هذا النوع من الانحراف مستقبلاً.
  خطوات الإعداد والاختبار اليدوي الكاملة بالترتيب في supabase-pos-simulator.md.
- تنظيف بعد اكتمال ربط الكاشير: قسم "الربط بنظام الكاشير" في شاشة إعدادات الكشك (حقل "رمز الإقران" من
  6 أرقام مُدخَل يدوياً + زر "اختبار الاتصال") كان محاكاة بالكامل من مرحلة ما قبل بناء الربط الحقيقي —
  بلا أي اتصال شبكة أو RPC حقيقي (زر الاختبار كان يضبط posConnected=true محلياً بعد setTimeout وهمي
  فقط)، ولا علاقة له بإقران الجهاز الحقيقي (request_device_pairing/pairingCodeLive، شاشة "pairing"
  منفصلة تماماً). أُزيل كلياً من kiosk.html (الحقل، الزر، pairingCode/posConnected من DEFAULT_SETTINGS،
  updateConnBadge()، CSS الخاص بـ.conn-badge/.spinner/@keyframes spin غير المستخدَم بعده).
  وضع الكشك (demo/live) أصبح يُقرأ ويُكتَب فعلياً من/إلى branch_settings.pos_mode — **عمود كان موجوداً
  أصلاً** منذ supabase-migration-branches-devices.sql (`pos_mode text not null default 'demo' check
  (pos_mode in ('demo','live'))`) ومحمياً بسياسة تعديل كانت موجودة أصلاً أيضاً ("device can update its
  own branch settings"، supabase-migration-kiosk-device-auth.sql) — **لا migration جديد ولا تعديل RLS
  كانا لازمين إطلاقاً**، فقط kiosk.html لم يكن يقرأ pos_mode أو يكتبه؛ الوضع كان محلياً بحتاً
  (localStorage)، فأي جهاز جديد أو مُعاد ضبطه يبدأ تجريبياً دوماً بصرف النظر عن وضع بقية أجهزة الفرع.
  الآن applyBranchSettingsToLocal() (تُستدعى في كل إقلاع ناجح) تكتب SETTINGS.mode من row.pos_mode —
  فجهاز جديد يرث وضع فرعه تلقائياً؛ وزر "حفظ" في الإعدادات يكتب pos_mode:DRAFT.mode ضمن نفس تحديث
  branch_settings الموجود أصلاً لبقية الحقول. تحقَّق محلياً (db-tests) أن سياسة الجهاز تسمح فعلاً
  بتحديث pos_mode دون أي تعديل. اختبارات Playwright جديدة (kiosk-tests) تغطي: غياب القسم المحذوف
  كلياً، أن جهازاً demo محلياً يرث live من صف فرعه عند الإقلاع، وأن الحفظ يكتب pos_mode فعلياً.
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
  **جولة فحص حي ثانية** (بعد تطبيق ما سبق) وجدت 7 دوال أخرى لم تكن ضمن أي قائمة فحص سابقة — cancel_
  appointment (كانت تمنح anon صراحة، فاتها الفحص الأول لأنه لم يشمل كل الدوال)، وcurrent_device_id،
  kiosk_claim_pos_transaction، claim_unclaimed_invoices، record_otp_request، approve_device_pairing،
  claim_or_create_verified_profile (هذه الستّ لم تُمنَح anon بالاسم إطلاقاً، لكن منحة PUBLIC الضمنية
  من create function وحدها كانت تكفي ليَرى anon نفسه قادراً على تنفيذها — has_function_privilege
  يتحقق من منحة PUBLIC أيضاً، لا من منحة الدور المُسمّى فقط). **الدرس الأهم**: فحص قائمة دوال محدَّدة
  يدوياً غير موثوق أبداً — أُضيف اختبار عام غير مرتبط بأي قائمة أسماء (run_tests.js وrun_lockdown_
  tests.js): يستعلم كل دالة SECURITY DEFINER في public فعلياً ويتحقق أن لا واحدة منها تمنح anon
  التنفيذ، باستثناء قائمة سماح صريحة (فارغة حالياً) — هذا الاختبار نفسه كشف ثغرة ثامنة أثناء كتابته
  (redeem_reward في سلسلة القفل الأمني المصغّرة التي يستخدمها run_lockdown_tests.js، منفصلة عن سلسلة
  التشغيل الكاملة). rls_auto_enable تبقى استثناءً معروفاً (من Supabase نفسها، غير موجودة في أي ملف هنا
  ولا في قاعدة الاختبار المحلية، فلا تظهر في نتيجة هذا الاستعلام أصلاً) — لا تُضَف لقائمة السماح، ولا
  تُمَس.
- لوحة التاجر (merchant.html، المرحلة الأولى — دخول + شاشة الأجهزة): ملف قائم بذاته منفصل تماماً عن
  index.html/kiosk.html، منشور على نفس GitHub Pages. دخول **برقم الجوال فقط** (Supabase Phone OTP،
  signInWithOtp ثم verifyOtp مباشرة) **لا ترقية جلسة مجهولة إطلاقاً** — خلافاً لـ index.html، لا تصفّح
  قبل تسجيل الدخول هنا أصلاً فلا داعي لذلك التعقيد. Turnstile بنفس المفتاح العام ونفس نمط freshTurnstileToken
  (رمز طازج قبل كل signInWithOtp على حدة، لا verifyOtp نفسها). **storageKey مخصَّص**
  (sb-noj-merchant-auth) مختلف تماماً عن المفتاح الافتراضي الذي يعتمده index.html/kiosk.html (مُشتق من
  رابط المشروع فقط، لا من مسار الصفحة) — الثلاثة من نفس الأصل (origin) على GitHub Pages فـlocalStorage
  مشترك فعلياً بينها؛ تاجر قد يكون عميلاً مسجَّلاً بنفس رقمه على نفس الجهاز، فبلا storageKey مستقل كان
  الدخول للوحة سيستبدل جلسة الكشك/التطبيق بصمت. بعد الدخول: التحقق من merchant_members لـ auth.uid()
  الفعلي فقط (select merchant_id, role from merchant_members — سياسة RLS وgrant موجودان أصلاً، بلا أي
  دالة جديدة) — صف غير موجود = "لا تملك صلاحية وصول" بلا أي بيانات، خطأ اتصال فعلي = رسالة منفصلة "تعذّر
  التحقق" مع زر إعادة محاولة (لا نفس رسالة "لا صلاحية" القاطعة لمعلومة لم تصل أصلاً). **لا إنشاء profile
  ولا صف merchant_members من هذه الصفحة تحت أي ظرف** — أول حساب مالك لكل تاجر يُربَط يدوياً من محرر SQL
  (عملية نادرة، مرة لكل تاجر، راجع supabase-merchant-dashboard-setup.md)، تماماً كنمط merchant_members
  الحالي (لا self-serve signup بعد). جلسة Supabase نفسها تدوم بمدتها الطبيعية (لا تُقصَّر من الكود)؛
  مؤقت خمول 30 دقيقة على جانب العميل فقط (أطول من 60 ثانية كشك الإعدادات، لأن هذا جهاز شخصي لا شاشة
  عامة) — window.__NOJ_IDLE_MS__ اختبار فقط لتقصيره، نفس نمط window.__NOJ_POLL_MS__ في kiosk.html.
  شاشة الأجهزة: قائمة أجهزة فروع التاجر (الفرع، الحالة فعّال/مُلغى، آخر نشاط من devices.last_seen_at إن
  وُجد — يُكتَب مرة واحدة فقط عند الاعتماد حالياً، لا يتحدَّث بنشاط حي لاحق، فهذا تاريخ آخر اعتماد/إقران
  لا نشاطاً لحظياً). اعتماد كشك جديد: رمز الإقران الظاهر على شاشة الكشك + اختيار الفرع، عبر
  approve_device_pairing() **الموجودة أصلاً بالكامل** (مصمَّمة صراحة لتكون واجهة إدارة مستقبلية طبقة
  رقيقة فوقها، راجع تعليقها في supabase-migration-kiosk-device-auth.sql) — بلا أي تعديل عليها. إلغاء
  جهاز: تحديث مباشر (is_active=false, revoked_at=now()) عبر سياسة RLS "merchant staff can manage their
  devices" **الموجودة أصلاً** (مالك أو موظف، بلا تمييز) — بلا أي دالة جديدة، خلف نافذة تأكيد (لا تنفيذ
  بالضغطة الأولى). المالك والموظف مسموح لهما كلاهما بكل إجراءات شاشة الأجهزة — لا تمييز دور في هذه
  المرحلة (التمييز يبدأ من مراحل لاحقة: توكن POS ورمز PIN للمالك فقط، حسب التصميم المعتمد). 30 اختبار
  Playwright جديد (merchant-tests/) يغطي: دخول ناجح/فاشل، لا صلاحية (صف مفقود مقابل خطأ اتصال فعلي —
  حالتان مختلفتان متعمَّداً)، قائمة الأجهزة، اعتماد ناجح/فاشل، إلغاء (تأكيد/تراجع/تنفيذ فعلي)، **عزل
  الجلسات** (مفتاح تخزين تطبيق/كشك آخر مزروع قبل الدخول يبقى بلا أي تغيير حرفي بعد دخول كامل للوحة —
  الدليل الحقيقي الوحيد المقبول لهذا الادّعاء، لا افتراضاً)، مؤقت الخمول، واستعادة جلسة محفوظة بعد إعادة
  التحميل. 3 اختبارات db-tests جديدة تؤكد نفس استعلام merchant_members الذي تستخدمه الصفحة فعلاً (مالك
  يقرأ عضويته، جلسة بلا عضوية تُعيد صفراً لا خطأ، لا تسريب عبر تخمين auth_user_id لمالك آخر). خطوات
  الإعداد الكاملة بالترتيب (رقم اختبار ثانٍ منفصل عن رقم اختبار العميل، ربطه يدوياً كمالك لـ"مركز النور
  الطبي") في supabase-merchant-dashboard-setup.md.
