# نشر Edge Functions بلا حاسوب — عبر GitHub Actions

هذا الملف **توثيق فقط**. يشرح كيفية نشر دوال Supabase Edge Functions
(`send-sms-hook`, `pos-intake`) من متصفح فقط — بلا طرفية، بلا تثبيت أي
برنامج، ويعمل من تابلت. آلية النشر نفسها: `.github/workflows/deploy-edge-
functions.yml`.

**النشر يدوي فقط — لا يعمل تلقائياً عند أي push.** عمداً: بعد إضافة الأسرار
(القسم ٣) تضغط أنت بنفسك "Run workflow" (القسم ٤) متى شئت، فلا يُنشَر شيء
قبل أن تتأكد من الأسرار وتقرّر التوقيت بنفسك.

**لا سرّ واحد موضوع في هذا المستودع.** كل ما يحتاجه الـ workflow يُقرأ من
أسرار مستودع GitHub (`secrets.*`) — قسم الإعداد التالي يشرح كيف تُضاف هذه
الأسرار مرة واحدة فقط.

---

## ١. إنشاء Supabase Access Token (مرة واحدة)

هذا توكن شخصي لحسابك في Supabase، لا علاقة له بأي فرع أو جهاز — يُستخدم فقط
ليستطيع GitHub Actions النشر نيابة عنك.

1. من متصفح الجوال/التابلت، افتح [supabase.com](https://supabase.com) وسجّل
   دخولك.
2. **Account → Access Tokens** (من صورة حسابك أعلى يمين اللوحة، أو مباشرة
   [supabase.com/dashboard/account/tokens](https://supabase.com/dashboard/account/tokens)).
3. **Generate new token** → أعطه اسماً واضحاً مثل `github-actions-deploy` →
   Generate.
4. **انسخ التوكن فوراً** — يظهر مرة واحدة فقط ولا يمكن استرجاعه لاحقاً (إن
   ضاع، كرّر الخطوة وأنشئ توكناً جديداً).

## ٢. إيجاد معرّف المشروع (Project Reference)

1. من لوحة Supabase، افتح مشروعك.
2. **Project Settings → General** → **Reference ID** (سلسلة من 20 حرفاً
   تقريباً، نفس الجزء الذي يسبق `.supabase.co` في رابط مشروعك، مثال:
   `jqddjswxsacejbqjeehw`).

## ٣. إضافة الأسرار في GitHub (مرة واحدة)

1. افتح هذا المستودع على [github.com](https://github.com) (أو تطبيق GitHub
   للجوال).
2. **Settings → Secrets and variables → Actions → New repository secret**.
3. أضف سرّين، كل واحد باسمه بالضبط (حساس لحالة الأحرف):

   | الاسم | القيمة |
   |---|---|
   | `SUPABASE_ACCESS_TOKEN` | التوكن من الخطوة ١ |
   | `SUPABASE_PROJECT_ID` | معرّف المشروع من الخطوة ٢ |

بعد حفظ السرّين، أي تشغيل لاحق للـ workflow (تلقائي أو يدوي) يقرأهما مباشرة
— لا حاجة لتكرار هذه الخطوة إلا إذا أعدت توليد التوكن.

## ٤. تشغيل النشر يدوياً من المتصفح

1. تبويب **Actions** في المستودع على GitHub.
2. اختر **"نشر Edge Functions"** من القائمة اليسرى.
3. **Run workflow** (زر أعلى يمين القائمة) → اختر فرع `main` → **Run
   workflow**.
4. تابع التقدّم بالضغط على التشغيل الذي بدأ لتوّه — علامة ✅ خضراء تعني نجاح
   نشر كلا الدالتين.

هذه هي الطريقة **الوحيدة** لتشغيل النشر — لا شيء يُنشَر تلقائياً عند أي
`push` أو دمج PR، حتى لو عدّلت كود الدالتين. شغّل هذه الخطوة بنفسك بعد كل
تعديل تريد نشره فعلياً.

## ٥. التحقق من نجاح النشر

- **Project Settings → Edge Functions** في لوحة Supabase: يجب أن تظهر
  `send-sms-hook` و`pos-intake` معاً بتاريخ آخر نشر حديث.
- أو من سجلّ التشغيل في تبويب Actions نفسه: كل خطوة نشر تطبع رابط الدالة
  المنشورة عند النجاح.

## لماذا verify_jwt معطَّل لكلتا الدالتين؟

بوابة Supabase الافتراضية تتحقق من أن رأس `Authorization` يحمل **JWT صادراً
من Supabase نفسها** قبل وصول الطلب لكود الدالة أصلاً، وترفض أي طلب غير ذلك
بـ401 — بصرف النظر عما يفعله كود الدالة. كلتا دالتينا تتوثّق بآليتها
الخاصة داخل الطلب نفسه، لا بـ JWT:

- **`pos-intake`**: يحمل `Authorization: Bearer <توكن الفرع>` — توكن عشوائي
  من `branch_pos_credentials`، لا JWT من Supabase إطلاقاً.
- **`send-sms-hook`**: يعتمد توقيع Standard Webhooks (`webhook-signature`
  وما يرافقه) لا رأس `Authorization` أصلاً.

لو بقي `verify_jwt` على الإعداد الافتراضي (مفعَّل)، كل طلب حقيقي من كاشير
فرع أو من Supabase Auth نفسها كان سيُرفَض بـ401 **قبل** أن يصل كود الدالة
ليتحقق من توقيعه/توكنه الخاص — أي عطل تام للمسارين معاً. لهذا:

- `supabase/config.toml` يضبط `verify_jwt = false` لكلتا الدالتين بشكل دائم
  (`[functions.pos-intake]`, `[functions.send-sms-hook]`).
- الـ workflow يمرّر `--no-verify-jwt` أيضاً مع كل أمر نشر، كتأكيد صريح لا
  يعتمد وحده على قراءة ملف الإعداد.

هذا **لا يعني غياب التوثيق** — فقط ينقله من بوابة Supabase العامة إلى تحقق
كل دالة الخاص (توكن الفرع المُجزَّأ، أو توقيع الـ Hook)، وهو بالضبط ما صُمِّم
عليه كود الدالتين من البداية.

## ملاحظات أمان

- `SUPABASE_ACCESS_TOKEN` يمنح صلاحية نشر على **كل** مشاريعك في Supabase —
  عامله كسرّ حسّاس. لا يُعرض في سجلّات Actions (GitHub يُخفي قيم الأسرار
  المُستخدَمة تلقائياً من أي مخرجات).
- `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` اللذين تحتاجهما الدالتان وقت
  التشغيل الفعلي (لا وقت النشر) يُحقنان تلقائياً من Supabase نفسها في كل
  دالة منشورة — لا علاقة لهما بهذين السرّين ولا يحتاجان إضافة يدوية (راجع
  تعليقات `supabase/functions/pos-intake/index.ts`).
- أسرار الدوال الأخرى (`SEND_SMS_HOOK_SECRET`, `UNIFONIC_APP_SID`,
  `UNIFONIC_SENDER_ID`) تبقى كما هي — تُضبط عبر `supabase secrets set` من
  لوحة Supabase نفسها أو طرفية بها Supabase CLI، لا علاقة لها بهذا الـ
  workflow (راجع `supabase-phone-otp-setup.md`).
- إن أردت إلغاء صلاحية النشر هذه لاحقاً: احذف التوكن من **Account → Access
  Tokens** في Supabase، ثم احذف السرّين من إعدادات GitHub.
