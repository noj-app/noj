# إعداد التحقق الحقيقي من رقم الجوال — خطوات يدوية في لوحة Supabase

هذا الملف **توثيق فقط**، لا يُشغَّل كـ migration. يرافق `supabase-migration-phone-otp-foundation.sql`
(المرحلة ١) والـ Edge Function في `supabase/functions/send-sms-hook/` (المرحلة ٢). الخطوات هنا
يدوية بالكامل ولا بديل لها من ملف SQL — تُنفَّذ مرة واحدة لكل مشروع Supabase (حي أو تجريبي)، بهذا
الترتيب تحديداً.

راجع أيضاً `CLAUDE.md` تحت "قرارات ثابتة" للقرار الكامل، ولا تُفعِّل شيئاً هنا على المشروع **الحي**
قبل اختبار المسار كاملاً على مشروع تجريبي أو بأرقام الاختبار (الخطوة ٤).

---

## ١. تفعيل Phone Auth

**Authentication → Providers → Phone**

- فعّل مزوّد الهاتف (Enable Phone provider).
- **لا تختر** أي مزوّد SMS مُدرَج افتراضياً (Twilio/MessageBird/Vonage/TextLocal) — سنستخدم Hook
  مخصصاً بدلاً منه (الخطوة التالية).
- اترك "Confirm phone number" مفعّلاً (الافتراضي) — هذا ما يجعل Supabase يصدر OTP أصلاً.

## ٢. ربط Send SMS Hook

**Authentication → Hooks → Send SMS hook**

- بعد نشر الدالة (`supabase functions deploy send-sms-hook`)، اختر نوع الـ Hook **HTTP**، والصق رابط
  الدالة المنشورة (يبدو عادة كـ `https://<project-ref>.supabase.co/functions/v1/send-sms-hook`).
- عند الحفظ، تعرض لك اللوحة **سرّ التوقيع (Hook Secret)** — يُعرض **مرة واحدة فقط**، انسخه فوراً.
  هذا هو `SEND_SMS_HOOK_SECRET` في الخطوة التالية.

## ٣. إضافة الأسرار (Edge Function Secrets)

عبر الطرفية (أو Project Settings → Edge Functions → Secrets):

```
supabase secrets set SEND_SMS_HOOK_SECRET=<السر من الخطوة ٢>
supabase secrets set UNIFONIC_APP_SID=<من لوحة حسابك في Unifonic>
supabase secrets set UNIFONIC_SENDER_ID=<اسم المرسل المسجَّل، مثال: NOJ>
```

**لا تضع أياً من هذه القيم في الكود أو المستودع أبداً** — الدالة تقرأها حصراً عبر `Deno.env.get(...)`
وقت التشغيل. `UNIFONIC_SENDER_ID` يحتاج موافقة Unifonic على تسجيل الاسم أولاً (إجراء تجاري منفصل قد
يأخذ عدة أيام — ابدأه بالتوازي مع هذه الخطوات، لا بعدها).

## ٤. أرقام الاختبار (Test OTP)

**Authentication → Settings → Phone Auth** (أو "Test OTP" / "Test phone numbers" حسب نسخة اللوحة
الحالية)

- أضف رقماً وهمياً غير حقيقي (مثال مقترح: `+966500000000`) مع رمز ثابت (مثال مقترح: `123456`).
- أي طلب OTP لهذا الرقم **لا يستدعي الـ Hook إطلاقاً ولا يُرسَل عبر Unifonic** — يُستخدم لاختبار
  مسار `updateUser`/`verifyOtp` و`claim_or_create_verified_profile()` كاملاً بتكلفة صفر، قبل وجود
  حساب Unifonic فعّال أصلاً.
- اختبار الـ Hook **نفسه** (التوقيع، الرفض قبل +966، استدعاء Unifonic) جرى محلياً عبر
  `deno test` (انظر `supabase/functions/send-sms-hook/hook.test.ts`) — أرقام الاختبار هنا لا تغطيه
  لأنها لا تصل إليه أصلاً.
- **⚠️ قبل الإتاحة العامة (مرحلة لاحقة): احذف كل رقم اختبار من هذه القائمة.** أي رقم يبقى هنا على
  المشروع الحي يتجاوز كل تحقق حقيقي للأبد لمن يعرفه.

## ٥. CAPTCHA

**Authentication → Settings → Bot and Abuse Protection** (أو "Attack Protection" حسب نسخة اللوحة)

- فعّل الحماية، واختر **hCaptcha** أو **Cloudflare Turnstile** (كلاهما مدعوم ومجاني للاستخدام
  الأساسي) — الصق Site Key + Secret Key من حساب المزوّد الذي تختاره.
- هذا يغطي `signInAnonymously` وطلب OTP معاً من جهة Supabase نفسها — الجزء المقابل في `index.html`
  (تضمين الودجت + تمرير التوكن) جزء من مرحلة لاحقة (تعديل `index.html`)، غير مشمول هنا.

## ٦. حدود المعدّل حسب IP

**Authentication → Rate Limits**

قيم مقترحة كبداية متحفظة (عدّلها لاحقاً حسب حجم الاستخدام الفعلي — راجع القيم الافتراضية الحالية في
لوحتك قبل التعديل، فقد تختلف تسميات الحقول بين نسخ اللوحة):

- **رسائل SMS/OTP لكل ساعة (لكل IP)**: ٣٠ كبداية.
- **طلبات تسجيل/دخول عامة لكل ساعة (لكل IP)**: اتركها على الافتراضي ما لم تُلاحَظ إساءة استخدام فعلية.

هذه الطبقة تعمل **تحت** CAPTCHA (الخطوة ٥) و**فوق** `otp_requests` (حدّ لكل جهاز، من المرحلة ١) —
الثلاث طبقات مكمّلة لا بديلة، كما وُثِّق في رأس `supabase-migration-phone-otp-foundation.sql`.

---

## الترتيب الكلي الموصى به

١ → ٢ → ٣ → **٤ أولاً على مشروع تجريبي أو بأرقام اختبار فقط** → ٥ → ٦ → تجربة محدودة بأرقام حقيقية
(أرقام فريق العمل) → حذف أرقام الاختبار (الخطوة ٤) → إتاحة عامة.
