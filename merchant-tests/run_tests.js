// NOJ — Playwright E2E tests for merchant.html (stage 1 — devices screen).
// Real Chromium (pre-cached in this environment), fake Supabase client
// (fake-supabase.js), zero live network — merchant.html itself is untouched
// except for the two test-only hooks it documents in its own comments
// (window.__NOJ_SUPABASE_CLIENT__, window.__NOJ_IDLE_MS__).
const { chromium } = require('playwright');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..');
const MERCHANT_URL = 'file://' + path.join(REPO_ROOT, 'merchant.html');
const CHROMIUM_PATH = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const FAKE_SB_PATH = path.join(__dirname, 'fake-supabase.js');
const FAKE_TURNSTILE_PATH = path.join(__dirname, 'fake-turnstile.js');

// نفس القيمة الحرفية في merchant.html (MERCHANT_STORAGE_KEY) وfake-supabase.js
// (MERCHANT_STORAGE_KEY) — الاختبار "0) storageKey" أدناه يتحقق أن الثلاثة
// متطابقة فعلياً، لا فقط مفترَضة كذلك.
const EXPECTED_STORAGE_KEY = 'sb-noj-merchant-auth';
// محاكاة مفتاح localStorage الافتراضي الذي يستخدمه supabase-js نفسه
// (sb-<project-ref>-auth-token) — ما كانت ستستخدمه index.html/kiosk.html
// الحقيقيان على نفس المشروع، بلا storageKey مخصَّص (راجع CLAUDE.md).
const OTHER_APP_STORAGE_KEY = 'sb-jqddjswxsacejbqjeehw-auth-token';
const OTHER_APP_SESSION_JSON = JSON.stringify({ fake: 'kiosk-or-index-session', untouched: true });

let pass = 0, fail = 0;
const failures = [];
function check(label, cond) {
  if (cond) { pass++; console.log('PASS -', label); }
  else { fail++; failures.push(label); console.log('FAIL -', label); }
}

function baseScenario(overrides) {
  return Object.assign({
    authUserId: 'merchant-auth-1',
    validOtp: '123456',
    validPairingCode: '123456',
    merchantMembers: [{ merchant_id: 'merchant-1', role: 'owner' }],
    merchants: [{ id: 'merchant-1', name: 'مركز النور الطبي' }],
    branches: [{ id: 'branch-1', merchant_id: 'merchant-1', name: 'فرع الملقا' }],
    devices: [
      { id: 'device-1', branch_id: 'branch-1', label: 'تابلت الكاشير', is_active: true, revoked_at: null, last_seen_at: '2026-01-10T08:00:00Z', created_at: '2026-01-10T08:00:00Z' },
    ],
    branchSettings: [
      { branch_id: 'branch-1', sector_code: 'medical', biz_name: 'مركز النور', biz_branch: 'فرع الملقا', biz_slogan: 'رعايتك أولويتنا', biz_logo: '', pos_mode: 'demo' },
    ],
  }, overrides);
}

async function openMerchant(browser, { scenario, idleMs, preSeedOtherApp }) {
  const context = await browser.newContext();
  const page = await context.newPage();
  // no live network at all — fail fast instead of waiting out real timeouts
  // (Turnstile script, the esm.sh supabase-js fallback import — never
  // actually reached since window.__NOJ_SUPABASE_CLIENT__ short-circuits
  // getSb(), but blocked defensively regardless).
  await page.route('**://challenges.cloudflare.com/**', (route) => route.abort());
  await page.route('**://esm.sh/**', (route) => route.abort());

  if (preSeedOtherApp) {
    await page.addInitScript((kv) => {
      localStorage.setItem(kv.key, kv.val);
    }, { key: OTHER_APP_STORAGE_KEY, val: OTHER_APP_SESSION_JSON });
  }
  await page.addInitScript((s) => { window.__NOJ_SCENARIO__ = s; }, scenario);
  if (idleMs) {
    await page.addInitScript((ms) => { window.__NOJ_IDLE_MS__ = ms; }, idleMs);
  }
  await page.addInitScript({ path: FAKE_SB_PATH });
  // fake-turnstile.js يقرأ window.__NOJ_SCENARIO__ عند التنفيذ أيضاً — مُسجَّل
  // بعد تعيين السيناريو أعلاه، نفس شرط fake-supabase.js تماماً.
  await page.addInitScript({ path: FAKE_TURNSTILE_PATH });

  await page.goto(MERCHANT_URL);
  await page.waitForSelector('#ph', { timeout: 5000 });
  return { context, page };
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function loginFlow(page, phone, otp) {
  await page.fill('#ph', phone);
  await page.click('#send');
  await page.waitForSelector('[data-otp="0"]', { timeout: 3000 });
  const boxes = await page.$$('[data-otp]');
  for (let i = 0; i < otp.length; i++) {
    await boxes[i].fill(otp[i]);
  }
  await page.waitForTimeout(250); // auto-verify fires 180ms after the last digit
}

(async () => {
  const browser = await chromium.launch({ executablePath: CHROMIUM_PATH });

  // =========================================================================
  // 0) ثبات storageKey: نفس القيمة الحرفية في merchant.html وfake-supabase.js
  //    معاً — لا افتراض، تحقق فعلي.
  // =========================================================================
  {
    const scenario = baseScenario({});
    const { context, page } = await openMerchant(browser, { scenario });
    const realConst = await page.evaluate(() => MERCHANT_STORAGE_KEY);
    check('0) ثابت MERCHANT_STORAGE_KEY في merchant.html يطابق القيمة المتوقَّعة', realConst === EXPECTED_STORAGE_KEY);
    await context.close();
  }

  // =========================================================================
  // 1) دخول ناجح: رقم جوال صحيح + رمز صحيح → شاشة الأجهزة.
  // =========================================================================
  {
    const scenario = baseScenario({});
    const { context, page } = await openMerchant(browser, { scenario });
    await loginFlow(page, '512345678', '123456');
    await page.waitForSelector('.topbar', { timeout: 3000 });
    check('1) الدخول الناجح ينقل لشاشة اللوحة', await page.$('.topbar') !== null);
    const merchantName = await page.textContent('.merchant-name').catch(() => '');
    check('1) اسم التاجر يظهر في الترويسة', /مركز النور الطبي/.test(merchantName));
    await context.close();
  }

  // =========================================================================
  // 2) دخول برمز خاطئ: رسالة خطأ واضحة، يبقى على شاشة الرمز.
  // =========================================================================
  {
    const scenario = baseScenario({});
    const { context, page } = await openMerchant(browser, { scenario });
    await loginFlow(page, '512345678', '000000');
    const err = await page.textContent('.auth-body .err').catch(() => '');
    check('2) رمز خاطئ: رسالة خطأ عربية واضحة', /رمز التحقق غير صحيح/.test(err));
    check('2) لا ينتقل للوحة برمز خاطئ', await page.$('.topbar') === null);
    await context.close();
  }

  // =========================================================================
  // 3) لا صلاحية: دخول ناجح لكن بلا صف merchant_members → شاشة "لا تملك
  //    صلاحية وصول"، بلا أي بيانات.
  // =========================================================================
  {
    const scenario = baseScenario({ merchantMembers: [] });
    const { context, page } = await openMerchant(browser, { scenario });
    await loginFlow(page, '512345678', '123456');
    await page.waitForSelector('.noaccess-box', { timeout: 3000 });
    const h2 = await page.textContent('.noaccess-box h2').catch(() => '');
    check('3) صف merchant_members غير موجود: شاشة "لا تملك صلاحية وصول"', h2 === 'لا تملك صلاحية وصول');
    check('3) لا تظهر شاشة اللوحة إطلاقاً', await page.$('.topbar') === null);
    await context.close();
  }

  // =========================================================================
  // 4) خطأ اتصال فعلي عند التحقق من الصلاحية — رسالة مختلفة ("تعذّر
  //    التحقق") مع زر إعادة محاولة، لا ادّعاء "لا تملك صلاحية" قاطع.
  // =========================================================================
  {
    const scenario = baseScenario({ merchantMembersError: 'connection reset' });
    const { context, page } = await openMerchant(browser, { scenario });
    await loginFlow(page, '512345678', '123456');
    await page.waitForSelector('.noaccess-box', { timeout: 3000 });
    const h2 = await page.textContent('.noaccess-box h2').catch(() => '');
    check('4) خطأ اتصال فعلي: رسالة "تعذّر التحقق" لا "لا تملك صلاحية"', h2 === 'تعذّر التحقق');
    check('4) زر "إعادة المحاولة" ظاهر', await page.$('#noAccessRetry') !== null);
    await context.close();
  }

  // =========================================================================
  // 5) شاشة الأجهزة: الفرع، الحالة، تاريخ الاعتماد. التسمية "تاريخ
  //    الاعتماد" (لا "آخر نشاط") لأن last_seen_at يُكتَب مرة واحدة فقط عند
  //    الاعتماد ولا يتحدَّث بنشاط حي لاحق — راجع CLAUDE.md.
  // =========================================================================
  {
    const scenario = baseScenario({});
    const { context, page } = await openMerchant(browser, { scenario });
    await loginFlow(page, '512345678', '123456');
    await page.waitForSelector('.dev-row', { timeout: 3000 });
    const rowText = await page.textContent('.dev-row');
    check('5) اسم الفرع يظهر في صف الجهاز', /فرع الملقا/.test(rowText));
    check('5) حالة "فعّال" تظهر لجهاز نشط', /فعّال/.test(rowText));
    check('5) التسمية الصادقة "تاريخ الاعتماد" تظهر (لا "آخر نشاط")', /تاريخ الاعتماد/.test(rowText) && !/آخر نشاط/.test(rowText));
    check('5) تاريخ الاعتماد الفعلي يظهر (من last_seen_at)', /2026-01-10/.test(rowText));
    await context.close();
  }

  // =========================================================================
  // 6) اعتماد كشك جديد: رمز صحيح + فرع → الجهاز يظهر في القائمة فوراً.
  // =========================================================================
  {
    const scenario = baseScenario({ validPairingCode: '654321', newDeviceId: 'device-new' });
    const { context, page } = await openMerchant(browser, { scenario });
    await loginFlow(page, '512345678', '123456');
    await page.waitForSelector('.dev-row');
    await page.fill('#pairCode', '654321');
    await page.click('#approveBtn');
    await page.waitForFunction(() => document.querySelectorAll('.dev-row').length === 2, { timeout: 3000 }).catch(() => {});
    const rows = await page.$$('.dev-row');
    check('6) اعتماد ناجح: جهاز جديد يظهر في القائمة (إجمالي صفّين الآن)', rows.length === 2);
    const call = await page.evaluate(() => window.__TEST__.getLastApproveCall());
    check('6) approve_device_pairing استُدعيت بالرمز والفرع الصحيحين', call && call.p_pairing_code === '654321' && call.p_branch_id === 'branch-1');
    await context.close();
  }

  // =========================================================================
  // 7) اعتماد برمز خاطئ: رسالة خطأ واضحة، لا جهاز جديد يُضاف.
  // =========================================================================
  {
    const scenario = baseScenario({ validPairingCode: '654321' });
    const { context, page } = await openMerchant(browser, { scenario });
    await loginFlow(page, '512345678', '123456');
    await page.waitForSelector('.dev-row');
    await page.fill('#pairCode', '111111');
    await page.click('#approveBtn');
    await page.waitForSelector('.form-warn', { timeout: 3000 }).catch(() => {});
    const warn = await page.textContent('.form-warn').catch(() => '');
    check('7) رمز إقران خاطئ: رسالة خطأ واضحة', /رمز الإقران غير صالح/.test(warn));
    const rows = await page.$$('.dev-row');
    check('7) لا جهاز جديد أُضيف', rows.length === 1);
    await context.close();
  }

  // =========================================================================
  // 8) إلغاء جهاز: تأكيد قبل التنفيذ — الإلغاء لا يحدث بمجرد الضغط الأول.
  // =========================================================================
  {
    const scenario = baseScenario({});
    const { context, page } = await openMerchant(browser, { scenario });
    await loginFlow(page, '512345678', '123456');
    await page.waitForSelector('[data-revoke]');
    await page.click('[data-revoke]');
    await page.waitForSelector('#revokeOv', { timeout: 2000 });
    check('8) نافذة تأكيد تظهر قبل أي تنفيذ', await page.$('#revokeOv') !== null);
    const stillActiveBefore = await page.textContent('.badge');
    check('8) الجهاز لا يزال "فعّال" قبل تأكيد الإلغاء', /فعّال/.test(stillActiveBefore));

    await page.click('#revokeCancel');
    check('8) التراجع يغلق النافذة بلا أي تغيير', await page.$('#revokeOv') === null);
    const stillActiveAfterCancel = await page.textContent('.badge');
    check('8) الجهاز يبقى "فعّال" بعد التراجع', /فعّال/.test(stillActiveAfterCancel));

    await page.click('[data-revoke]');
    await page.waitForSelector('#revokeOv', { timeout: 2000 });
    await page.click('#revokeConfirm');
    await page.waitForFunction(() => {
      var b = document.querySelector('.badge');
      return b && /مُلغى/.test(b.textContent);
    }, { timeout: 3000 }).catch(() => {});
    const badgeAfter = await page.textContent('.badge').catch(() => '');
    check('8) تأكيد الإلغاء يحدِّث الحالة إلى "مُلغى" فعلياً', /مُلغى/.test(badgeAfter));
    check('8) زر "إلغاء" يختفي لجهاز مُلغى', await page.$('[data-revoke]') === null);
    const updateCall = await page.evaluate(() => window.__TEST__.getLastUpdateCall());
    check('8) التحديث الفعلي يضبط is_active=false وrevoked_at', updateCall && updateCall.payload.is_active === false && !!updateCall.payload.revoked_at);
    await context.close();
  }

  // =========================================================================
  // 9) عزل الجلسات: الدخول للوحة لا يمسّ أي جلسة تخص الكشك/التطبيق على نفس
  //    المتصفح — تُفحَص القيمة الفعلية في localStorage قبل/بعد تسجيل الدخول
  //    الكامل، لا افتراضاً.
  // =========================================================================
  {
    const scenario = baseScenario({});
    const { context, page } = await openMerchant(browser, { scenario, preSeedOtherApp: true });

    const otherBefore = await page.evaluate((k) => localStorage.getItem(k), OTHER_APP_STORAGE_KEY);
    check('9) قبل الدخول: مفتاح تخزين تطبيق/كشك آخر موجود كما زُرع تماماً', otherBefore === OTHER_APP_SESSION_JSON);
    const merchantBefore = await page.evaluate((k) => localStorage.getItem(k), EXPECTED_STORAGE_KEY);
    check('9) قبل الدخول: لا جلسة للوحة التاجر بعد', merchantBefore === null);

    await loginFlow(page, '512345678', '123456');
    await page.waitForSelector('.topbar', { timeout: 3000 });

    const otherAfter = await page.evaluate((k) => localStorage.getItem(k), OTHER_APP_STORAGE_KEY);
    check('9) بعد دخول كامل للوحة: مفتاح تخزين التطبيق/الكشك الآخر لم يتغيّر حرفياً', otherAfter === OTHER_APP_SESSION_JSON);
    const merchantAfter = await page.evaluate((k) => localStorage.getItem(k), EXPECTED_STORAGE_KEY);
    check('9) بعد الدخول: جلسة اللوحة الآن موجودة تحت مفتاحها الخاص', !!merchantAfter && JSON.parse(merchantAfter).user.id === 'merchant-auth-1');

    await context.close();
  }

  // =========================================================================
  // 10) مؤقت الخمول: بعد انتهاء المهلة (مختصَرة للاختبار)، تسجيل خروج
  //     تلقائي والعودة لشاشة الدخول.
  // =========================================================================
  {
    const scenario = baseScenario({});
    const { context, page } = await openMerchant(browser, { scenario, idleMs: 400 });
    await loginFlow(page, '512345678', '123456');
    await page.waitForSelector('.topbar', { timeout: 3000 });
    await sleep(700);
    await page.waitForSelector('#ph', { timeout: 3000 }).catch(() => {});
    check('10) بعد انتهاء مهلة الخمول: عودة تلقائية لشاشة الدخول', await page.$('#ph') !== null);
    check('10) شاشة اللوحة تختفي بعد الخروج التلقائي', await page.$('.topbar') === null);
    await context.close();
  }

  // =========================================================================
  // 11) جلسة محفوظة مسبقاً: إعادة تحميل الصفحة بجلسة صالحة تنتقل مباشرة
  //     للوحة بلا إعادة إدخال الرمز.
  // =========================================================================
  {
    const scenario = baseScenario({});
    const { context, page } = await openMerchant(browser, { scenario });
    await loginFlow(page, '512345678', '123456');
    await page.waitForSelector('.topbar', { timeout: 3000 });
    await page.reload();
    await page.waitForSelector('.topbar', { timeout: 3000 }).catch(() => {});
    check('11) إعادة تحميل الصفحة بجلسة محفوظة: دخول تلقائي بلا رمز', await page.$('.topbar') !== null);
    await context.close();
  }

  // =========================================================================
  // 12) اختبار ارتداد لعطل السباق الحقيقي: ودجت Turnstile يُنجز تحققه قبل أي
  //     تفاعل (turnstileVerifyMs طويل عمداً، 5000)، ثم يُضغط "إرسال رمز
  //     التحقق" — إن عاد renderAuth() التدميري (bug الأصلي) لأي سبب، سيُعاد
  //     إنشاء الودجت ويُفقَد الرمز الجاهز فعلياً، فتتجاوز getRenderCount()
  //     الواحد ولن يكتمل الانتقال خلال مهلة freshTurnstileToken (2500ms) —
  //     هذا بالضبط العطل الحي المُصلَح (CLAUDE.md).
  // =========================================================================
  {
    const scenario = baseScenario({ captchaEnabled: true, turnstileVerifyMs: 5000 });
    const { context, page } = await openMerchant(browser, { scenario });
    await page.waitForTimeout(5300); // الودجت الأول ينجز تحققه فعلاً قبل أي تفاعل
    await page.fill('#ph', '512345678');
    const startedAt = Date.now();
    await page.click('#send');
    await page.waitForSelector('[data-otp="0"]', { timeout: 3000 }).catch(() => {});
    const elapsedMs = Date.now() - startedAt;
    check('12) ينتقل فعلاً لشاشة الرمز (استُخدم الرمز الجاهز، لا رفض captcha لانتهاء المهلة)', await page.$('[data-otp="0"]') !== null);
    check('12) الانتقال يحدث بسرعة (إعادة استخدام الرمز الجاهز فعلاً، لا انتظار 5 ثوانٍ جديدة)', elapsedMs < 3000);
    // renderCount=2 متوقَّع فعلاً (الإقلاع + انتقال شاشة الرمز الشرعي)؛ عودة
    // العطل القديم تعني renderAuth() تدميرية إضافية أثناء sendOtp() نفسها
    // (3 عمليات رندر، وبلا وصول لشاشة الرمز أصلاً — الفحص السابق يغطيها فعلاً).
    const renderCount = await page.evaluate(() => window.__TEST_TURNSTILE__.getRenderCount());
    check('12) ودجت Turnstile رُسم مرتين فقط (الإقلاع + انتقال الشاشة)، بلا renderAuth() تدميري أثناء الإرسال', renderCount === 2);
    await context.close();
  }

  // =========================================================================
  // 13) إعادة الإرسال من شاشة الرمز (resendOtp، بتجاوز العد التنازلي عبر نداء
  //     مباشر — لا حاجة لـ hook جديد لهذا الاختبار وحده) تحصل على رمز
  //     Turnstile ثانٍ مختلف فعلياً عن رمز الإرسال الأول، وتنجح مع CAPTCHA
  //     مفعّلة — ارتداد لعطل غياب #turnstile-container في شاشة الرمز (كان
  //     يعني captchaToken فارغاً دائماً هناك، راجع CLAUDE.md).
  // =========================================================================
  {
    const scenario = baseScenario({ captchaEnabled: true });
    const { context, page } = await openMerchant(browser, { scenario });
    await page.fill('#ph', '512345678');
    await page.click('#send');
    await page.waitForSelector('[data-otp="0"]', { timeout: 3000 });
    await page.evaluate(() => resendOtp());
    await page.waitForFunction(() => window.__TEST__.getUsedCaptchaTokens().length >= 2, { timeout: 3000 }).catch(() => {});
    const used = await page.evaluate(() => window.__TEST__.getUsedCaptchaTokens());
    check('13) resendOtp() من شاشة الرمز يحصل على رمز Turnstile ثانٍ مختلف عن رمز الإرسال الأول', used.length === 2 && used[0] !== used[1]);
    const toastText = await page.textContent('#toast-text').catch(() => '');
    check('13) إعادة الإرسال تنجح فعلياً (لا رفض captcha) رغم تفعيل CAPTCHA', /تم إرسال الرمز مرة أخرى/.test(toastText));
    await context.close();
  }

  // =========================================================================
  // 14) تحقق من بنية الاختبار نفسها (fake-supabase.js): استهلاك رمز Turnstile
  //     مرة واحدة فعلياً — أول استخدام ينجح، إعادة استخدام نفس الرمز تُرفض،
  //     ورمز مفقود كلياً يُرفض أيضاً عند captchaEnabled. بلا هذا، اختبارا 12
  //     و13 قد ينجحان لسبب خاطئ لو كانت محاكاة الاستهلاك نفسها معطوبة.
  // =========================================================================
  {
    const scenario = baseScenario({ captchaEnabled: true });
    const { context, page } = await openMerchant(browser, { scenario });
    const results = await page.evaluate(async () => {
      var sb = window.__NOJ_SUPABASE_CLIENT__;
      var r1 = await sb.auth.signInWithOtp({ phone: '+966512345678', options: { captchaToken: 'dup-token' } });
      var r2 = await sb.auth.signInWithOtp({ phone: '+966512345678', options: { captchaToken: 'dup-token' } });
      var r3 = await sb.auth.signInWithOtp({ phone: '+966512345678', options: {} });
      return { e1: r1.error, e2: r2.error, e3: r3.error };
    });
    check('14) أول استخدام لرمز Turnstile ينجح', !results.e1);
    check('14) إعادة استخدام نفس الرمز تُرفض (محاكاة استهلاك مرة واحدة فعلياً)', !!results.e2 && /captcha/i.test(results.e2.message));
    check('14) رمز مفقود كلياً يُرفض أيضاً عند تفعيل CAPTCHA', !!results.e3 && /captcha/i.test(results.e3.message));
    await context.close();
  }

  // =========================================================================
  // 15) إعدادات الفرع: تعرض القيم الحقيقية الحالية للفرع المختار (اسم،
  //     فرع نصي، شعار فرعي، قطاع، وضع) من branch_settings — لا قيم فارغة
  //     أو افتراضية رغم وجود بيانات محفوظة فعلاً.
  // =========================================================================
  {
    const scenario = baseScenario({});
    const { context, page } = await openMerchant(browser, { scenario });
    await loginFlow(page, '512345678', '123456');
    await page.waitForSelector('#fBizName', { timeout: 3000 });
    check('15) حقل الاسم يعرض القيمة المحفوظة فعلياً', await page.inputValue('#fBizName') === 'مركز النور');
    check('15) حقل الفرع النصي يعرض القيمة المحفوظة فعلياً', await page.inputValue('#fBizBranch') === 'فرع الملقا');
    check('15) حقل الشعار الفرعي يعرض القيمة المحفوظة فعلياً', await page.inputValue('#fBizSlogan') === 'رعايتك أولويتنا');
    check('15) زر القطاع الصحيح (طبي) مُحدَّد', await page.$eval('#sectorSw button[data-sector="medical"]', (b) => b.classList.contains('on')));
    check('15) زر الوضع الصحيح (تجريبي) مُحدَّد', await page.$eval('#modeSw button[data-mode="demo"]', (b) => b.classList.contains('on')));
    await context.close();
  }

  // =========================================================================
  // 16) حفظ إعدادات الفرع: يكتب كل الحقول الصحيحة فعلياً إلى branch_settings
  //     (سطر واحد، لا افتراضاً) — تغيير الاسم والقطاع ثم الحفظ.
  // =========================================================================
  {
    const scenario = baseScenario({});
    const { context, page } = await openMerchant(browser, { scenario });
    await loginFlow(page, '512345678', '123456');
    await page.waitForSelector('#fBizName', { timeout: 3000 });
    await page.fill('#fBizName', 'مركز النور الطبي الجديد');
    await page.click('#sectorSw button[data-sector="cafe"]');
    await page.click('#settingsSaveBtn');
    await page.waitForFunction(() => window.__TEST__.getLastBranchSettingsUpdate() !== null, { timeout: 3000 }).catch(() => {});
    const update = await page.evaluate(() => window.__TEST__.getLastBranchSettingsUpdate());
    check('16) الحفظ يستهدف الفرع الصحيح فعلياً', update && update.filters.some((f) => f.col === 'branch_id' && f.val === 'branch-1'));
    check('16) الحفظ يكتب الاسم الجديد فعلياً', update && update.payload.biz_name === 'مركز النور الطبي الجديد');
    const sc16 = await page.evaluate(() => window.__TEST__.getSectorCalls());
    check('16) القسم الجديد يُحفظ عبر merchant_set_sector للمالك (لا عبر branch_settings)',
      update && !('sector_code' in update.payload) && sc16.length === 1 && sc16[0].p_merchant_id === 'merchant-1' && sc16[0].p_sector === 'cafe');
    check('16) الحفظ يكتب pos_mode (لم يتغيّر هنا، لا يزال تجريبي)', update && update.payload.pos_mode === 'demo');
    await context.close();
  }

  // =========================================================================
  // 17) تحويل الوضع: الضغط على "مباشر" يفتح تنبيه تأكيد أولاً — لا يتغيّر
  //     الوضع المختار فعلياً إلا بعد التأكيد الصريح. التراجع يبقيه كما كان.
  // =========================================================================
  {
    const scenario = baseScenario({});
    const { context, page } = await openMerchant(browser, { scenario });
    await loginFlow(page, '512345678', '123456');
    await page.waitForSelector('#modeSw', { timeout: 3000 });
    await page.click('#modeSw button[data-mode="live"]');
    await page.waitForSelector('#modeConfirmOv', { timeout: 2000 });
    check('17) الضغط على وضع مختلف يفتح تنبيه تأكيد', await page.$('#modeConfirmOv') !== null);
    check('17) الوضع المختار في DRAFT لم يتغيّر بعد قبل التأكيد', await page.$eval('#modeSw button[data-mode="demo"]', (b) => b.classList.contains('on')));

    await page.click('#modeConfirmCancel');
    check('17) التراجع يغلق التنبيه بلا أي تغيير', await page.$('#modeConfirmOv') === null);
    check('17) الوضع يبقى تجريبياً بعد التراجع', await page.$eval('#modeSw button[data-mode="demo"]', (b) => b.classList.contains('on')));

    await page.click('#modeSw button[data-mode="live"]');
    await page.waitForSelector('#modeConfirmOv', { timeout: 2000 });
    await page.click('#modeConfirmOk');
    check('17) التأكيد يطبّق الوضع الجديد فعلياً في DRAFT', await page.$eval('#modeSw button[data-mode="live"]', (b) => b.classList.contains('on')));

    await page.click('#settingsSaveBtn');
    await page.waitForFunction(() => {
      var u = window.__TEST__.getLastBranchSettingsUpdate();
      return u && u.payload.pos_mode === 'live';
    }, { timeout: 3000 }).catch(() => {});
    const update = await page.evaluate(() => window.__TEST__.getLastBranchSettingsUpdate());
    check('17) الحفظ بعد التأكيد يكتب pos_mode=live فعلياً', update && update.payload.pos_mode === 'live');
    await context.close();
  }

  // =========================================================================
  // 18) رفع الشعار: نفس قيود kiosk.html بالضبط (صيغة صورة فقط، 500 كيلوبايت
  //     كحد أقصى) — صورة صالحة تُقبل، ملف غير صورة يُرفض، صورة كبيرة تُرفض.
  // =========================================================================
  {
    const scenario = baseScenario({});
    const { context, page } = await openMerchant(browser, { scenario });
    await loginFlow(page, '512345678', '123456');
    // #fBizLogo مخفي عمداً (style="display:none"، زر "اختيار صورة" يفتحه) —
    // state:'attached' لا 'visible' الافتراضية، فPlaywright يرفض الانتظار
    // على عنصر مخفي بصرياً رغم أن setInputFiles يعمل عليه دون أي مشكلة.
    await page.waitForSelector('#fBizLogo', { state: 'attached', timeout: 3000 });

    const tinyPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
    await page.setInputFiles('#fBizLogo', { name: 'logo.png', mimeType: 'image/png', buffer: tinyPng });
    await page.waitForSelector('#logoPreview img', { timeout: 2000 }).catch(() => {});
    check('18) صورة صالحة وصغيرة: المعاينة تُحدَّث بصورة فعلية', await page.$('#logoPreview img') !== null);
    check('18) لا رسالة تحذير لصورة صالحة', (await page.textContent('#logoWarn')) === '');

    const notAnImage = Buffer.from('hello world');
    await page.setInputFiles('#fBizLogo', { name: 'notes.txt', mimeType: 'text/plain', buffer: notAnImage });
    check('18) ملف ليس صورة: رسالة رفض واضحة', /الرجاء اختيار ملف صورة صحيح/.test(await page.textContent('#logoWarn')));

    const oversized = Buffer.alloc(600 * 1024, 1);
    await page.setInputFiles('#fBizLogo', { name: 'big.png', mimeType: 'image/png', buffer: oversized });
    check('18) صورة أكبر من 500 كيلوبايت: رسالة رفض واضحة', /الحد الأقصى 500 كيلوبايت/.test(await page.textContent('#logoWarn')));
    // الصورة الصالحة السابقة تبقى محفوظة في DRAFT — الرفض لا يمسحها.
    check('18) الرفض لا يمسح الصورة الصالحة المُحمَّلة سابقاً', await page.$('#logoPreview img') !== null);

    await context.close();
  }

  // =========================================================================
  // 19) رمز إعدادات الكشك وتوكن ربط الكاشير: قسمان للمالك فقط — غائبان
  //     كلياً عن واجهة موظف (staff)، رغم أن نفس الفرع والتاجر.
  // =========================================================================
  {
    const scenario = baseScenario({ merchantMembers: [{ merchant_id: 'merchant-1', role: 'staff' }] });
    const { context, page } = await openMerchant(browser, { scenario });
    await loginFlow(page, '512345678', '123456');
    await page.waitForSelector('#fBizName', { timeout: 3000 });
    check('19) قسم رمز إعدادات الكشك غائب كلياً عن واجهة الموظف', await page.$('#pinInput') === null);
    check('19) قسم توكن ربط الكاشير غائب كلياً عن واجهة الموظف', await page.$('#posTokenIssueBtn') === null);
    await context.close();
  }

  // =========================================================================
  // 20) رمز إعدادات الكشك (مالك): حفظ رمز صحيح يستدعي الدالة بالفرع والرمز
  //     الصحيحين، يمسح الحقل فوراً (لا يُعرض الرمز أبداً بعد الحفظ)، ويعرض
  //     رسالة نجاح. رمز غير صحيح الصيغة يُرفض قبل أي نداء للخادم إطلاقاً.
  // =========================================================================
  {
    const scenario = baseScenario({});
    const { context, page } = await openMerchant(browser, { scenario });
    await loginFlow(page, '512345678', '123456');
    await page.waitForSelector('#pinInput', { timeout: 3000 });

    await page.fill('#pinInput', '12');
    await page.click('#pinSaveBtn');
    // '#pinInput ~ .form-warn' لا '.card .form-warn' عمداً — قسم الشعار في
    // بطاقة إعدادات الفرع يحمل #logoWarn.form-warn فارغاً دوماً (مُحدَّث
    // مباشرة من JS لا عبر renderApp())، فهو أول .form-warn في ترتيب DOM
    // وكان يُطابَق خطأً بدل تحذير رمز PIN الفعلي.
    check('20) رمز من رقمين فقط: رسالة رفض واضحة', /4 أرقام بالضبط/.test(await page.textContent('#pinInput ~ .form-warn')));
    check('20) لا نداء للخادم عند رفض الصيغة محلياً', await page.evaluate(() => window.__TEST__.getLastSetPinCall()) === null);

    await page.fill('#pinInput', '9876');
    await page.click('#pinSaveBtn');
    await page.waitForFunction(() => window.__TEST__.getLastSetPinCall() !== null, { timeout: 3000 });
    const call = await page.evaluate(() => window.__TEST__.getLastSetPinCall());
    check('20) الحفظ يستدعي merchant_set_admin_pin بالفرع والرمز الصحيحين', call && call.p_branch_id === 'branch-1' && call.p_pin === '9876');
    check('20) الحقل يُمسَح فوراً بعد الحفظ — لا يُعرض الرمز أبداً', await page.inputValue('#pinInput') === '');
    check('20) رسالة نجاح تظهر', /تم حفظ الرمز بنجاح/.test(await page.textContent('body')));
    await context.close();
  }

  // =========================================================================
  // 21) توكن ربط الكاشير (مالك): يتطلب تأكيداً قبل الإصدار — التراجع لا
  //     يستدعي الخادم إطلاقاً. التأكيد يُصدر التوكن ويعرضه مرة واحدة، وزر
  //     النسخ موجود.
  // =========================================================================
  {
    const scenario = baseScenario({});
    const { context, page } = await openMerchant(browser, { scenario });
    await loginFlow(page, '512345678', '123456');
    await page.waitForSelector('#posTokenIssueBtn', { timeout: 3000 });

    await page.click('#posTokenIssueBtn');
    await page.waitForSelector('#posTokenConfirmOv', { timeout: 2000 });
    await page.click('#posTokenConfirmCancel');
    check('21) التراجع يغلق التنبيه بلا أي نداء للخادم', await page.evaluate(() => window.__TEST__.getIssuedPosTokenCount()) === 0);
    check('21) لا توكن معروض بعد التراجع', await page.$('#posTokenValue') === null);

    await page.click('#posTokenIssueBtn');
    await page.waitForSelector('#posTokenConfirmOv', { timeout: 2000 });
    await page.click('#posTokenConfirmOk');
    await page.waitForSelector('#posTokenValue', { timeout: 3000 });
    const shown = await page.textContent('#posTokenValue');
    const issued = await page.evaluate(() => window.__TEST__.getLastIssuedPosToken());
    check('21) التوكن المعروض يطابق التوكن الصادر فعلياً من الخادم', shown === issued);
    check('21) زر النسخ ظاهر مع التوكن', await page.$('#posTokenCopyBtn') !== null);
    await context.close();
  }

  // =========================================================================
  // 22) دفاع في العمق: دالتا merchant_set_admin_pin/merchant_issue_pos_token
  //     ترفضان الموظف حتى عند استدعائهما مباشرة (تجاوز الواجهة كلياً عبر
  //     page.evaluate) — لا تكفي إخفاء الأقسام في الواجهة وحده.
  // =========================================================================
  {
    const scenario = baseScenario({ merchantMembers: [{ merchant_id: 'merchant-1', role: 'staff' }] });
    const { context, page } = await openMerchant(browser, { scenario });
    await loginFlow(page, '512345678', '123456');
    await page.waitForSelector('#fBizName', { timeout: 3000 });
    const results = await page.evaluate(async () => {
      var sb = window.__NOJ_SUPABASE_CLIENT__;
      var r1 = await sb.rpc('merchant_set_admin_pin', { p_branch_id: 'branch-1', p_pin: '1234' });
      var r2 = await sb.rpc('merchant_issue_pos_token', { p_branch_id: 'branch-1' });
      return { e1: r1.error, e2: r2.error };
    });
    check('22) merchant_set_admin_pin ترفض موظفاً حتى عند النداء المباشر', !!results.e1 && /لا تملك صلاحية/.test(results.e1.message));
    check('22) merchant_issue_pos_token ترفض موظفاً حتى عند النداء المباشر', !!results.e2 && /لا تملك صلاحية/.test(results.e2.message));
    await context.close();
  }

  // =========================================================================
  // 23) تبديل فرع الإعدادات (تاجر بأكثر من فرع): يحمِّل إعدادات الفرع الجديد
  //     فعلياً، ويُسقط أي رمز توكن POS معروض من الفرع السابق فوراً — لا يبقى
  //     توكن فرع آخر ظاهراً وهماً أنه يخص الفرع المختار حديثاً.
  // =========================================================================
  {
    const scenario = baseScenario({
      branches: [
        { id: 'branch-1', merchant_id: 'merchant-1', name: 'فرع الملقا' },
        { id: 'branch-2', merchant_id: 'merchant-1', name: 'فرع العليا' },
      ],
      branchSettings: [
        { branch_id: 'branch-1', sector_code: 'medical', biz_name: 'مركز النور', biz_branch: 'فرع الملقا', biz_slogan: '', biz_logo: '', pos_mode: 'demo' },
        { branch_id: 'branch-2', sector_code: 'cafe', biz_name: 'مركز النور', biz_branch: 'فرع العليا', biz_slogan: '', biz_logo: '', pos_mode: 'live' },
      ],
    });
    const { context, page } = await openMerchant(browser, { scenario });
    await loginFlow(page, '512345678', '123456');
    await page.waitForSelector('#posTokenIssueBtn', { timeout: 3000 });

    await page.click('#posTokenIssueBtn');
    await page.click('#posTokenConfirmOk');
    await page.waitForSelector('#posTokenValue', { timeout: 3000 });
    check('23) توكن الفرع الأول ظاهر قبل التبديل', await page.$('#posTokenValue') !== null);

    await page.selectOption('#settingsBranchSelect', 'branch-2');
    await page.waitForFunction(() => document.getElementById('fBizBranch') && document.getElementById('fBizBranch').value === 'فرع العليا', { timeout: 3000 });
    check('23) حقل الفرع النصي يعكس بيانات الفرع الثاني فعلياً', await page.inputValue('#fBizBranch') === 'فرع العليا');
    check('23) زر الوضع الصحيح للفرع الثاني (مباشر) مُحدَّد', await page.$eval('#modeSw button[data-mode="live"]', (b) => b.classList.contains('on')));
    check('23) توكن الفرع الأول لم يعد معروضاً بعد التبديل للفرع الثاني', await page.$('#posTokenValue') === null);
    await context.close();
  }

  // =========================================================================
  // 24) حالة اتصال الكاشير (قراءة فقط من pos_connections) داخل قسم توكن POS:
  //     بلا صف = "غير متصل بعد"؛ صف متصل بفاتورة = الحالة + وقت آخر فاتورة؛
  //     حالة غير متصل (منتهي/خطأ) تُعرض بصدق؛ وفشل القراءة لا يعطّل القسم
  //     (زر الإصدار يبقى يعمل) ولا يعرض حالة مختلَقة.
  // =========================================================================
  {
    // بلا صف
    const { context, page } = await openMerchant(browser, { scenario: baseScenario({}) });
    await loginFlow(page, '512345678', '123456');
    await page.waitForSelector('#posConnStatus', { timeout: 3000 });
    check('24) فرع بلا اتصال مسجَّل: "غير متصل بعد"', /غير متصل بعد/.test(await page.textContent('#posConnStatus')));
    // إصدار التوكن ينتج صف اتصال، فتتحوّل الحالة إلى "متصل" فوراً
    await page.click('#posTokenIssueBtn');
    await page.click('#posTokenConfirmOk');
    await page.waitForSelector('#posTokenValue', { timeout: 3000 });
    const afterIssue = await page.textContent('#posConnStatus');
    check('24) بعد إصدار التوكن: الحالة "متصل" (قراءة جديدة بعد الإصدار)', /متصل/.test(afterIssue) && !/غير متصل/.test(afterIssue));
    check('24) لم تصل فاتورة بعد: عبارة صادقة لا وقت مختلَق', /لم تصل أي فاتورة بعد/.test(afterIssue));
    await context.close();
  }
  {
    const scenario = baseScenario({ posConnections: [
      { branch_id: 'branch-1', provider: 'generic', kind: 'token_issued', status: 'connected', last_invoice_at: '2026-02-03T10:15:00Z', last_error: null },
    ] });
    const { context, page } = await openMerchant(browser, { scenario });
    await loginFlow(page, '512345678', '123456');
    await page.waitForSelector('#posConnStatus', { timeout: 3000 });
    const t = await page.textContent('#posConnStatus');
    check('24) صف متصل: الحالة "متصل" مع وقت آخر فاتورة فعلي', /متصل/.test(t) && /آخر فاتورة وصلت: 2026-02-03/.test(t));
    await context.close();
  }
  {
    const scenario = baseScenario({ posConnections: [
      { branch_id: 'branch-1', provider: 'generic', kind: 'token_issued', status: 'expired', last_invoice_at: null, last_error: 'انتهت الصلاحية' },
    ] });
    const { context, page } = await openMerchant(browser, { scenario });
    await loginFlow(page, '512345678', '123456');
    await page.waitForSelector('#posConnStatus', { timeout: 3000 });
    const t = await page.textContent('#posConnStatus');
    check('24) حالة منتهية: تُعرض "منتهي الصلاحية" لا "متصل"', /منتهي الصلاحية/.test(t) && !/^متصل/.test(t.trim()));
    check('24) آخر خطأ مسجَّل يظهر للمالك', /انتهت الصلاحية/.test(t));
    await context.close();
  }
  {
    const scenario = baseScenario({ posConnectionsError: 'boom' });
    const { context, page } = await openMerchant(browser, { scenario });
    await loginFlow(page, '512345678', '123456');
    await page.waitForSelector('#posTokenIssueBtn', { timeout: 3000 });
    check('24) فشل قراءة الاتصالات: لا حالة مختلَقة تُعرض', await page.$('#posConnStatus') === null);
    check('24) وزر إصدار التوكن يبقى يعمل (القسم لم يتعطل)', await page.$('#posTokenIssueBtn') !== null);
    await context.close();
  }
  {
    // الموظف: القسم كله غائب (لا الحالة ولا الزر) — سلوك المرحلة الثانية لم يتغيّر
    const scenario = baseScenario({ merchantMembers: [{ merchant_id: 'merchant-1', role: 'staff' }], posConnections: [
      { branch_id: 'branch-1', provider: 'generic', kind: 'token_issued', status: 'connected', last_invoice_at: null, last_error: null },
    ] });
    const { context, page } = await openMerchant(browser, { scenario });
    await loginFlow(page, '512345678', '123456');
    await page.waitForSelector('#fBizName', { timeout: 3000 });
    check('24) الموظف لا يرى قسم التوكن ولا حالته إطلاقاً', await page.$('#posConnStatus') === null && await page.$('#posTokenIssueBtn') === null);
    await context.close();
  }

  // =========================================================================
  // 25-33) شاشة الفواتير (قراءة فقط عبر merchant_list_invoices)
  // =========================================================================
  const riyadhToday = () => {
    const g = {};
    new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Riyadh', year: 'numeric', month: '2-digit', day: '2-digit' })
      .formatToParts(new Date()).forEach((p) => { g[p.type] = p.value; });
    return g.year + '-' + g.month + '-' + g.day;
  };
  const addDays = (iso, n) => { const p = iso.split('-'); return new Date(Date.UTC(+p[0], +p[1] - 1, +p[2] + n)).toISOString().slice(0, 10); };
  const TODAY = riyadhToday();
  const inv = (id, day, time, branchId, branchName, amount, vat, pts, source, extra) => Object.assign({
    id, created_at_riyadh: day + ' ' + time, branch_id: branchId, branch_name: branchName, amount, vat,
    points_earned: pts, source, status: 'paid', refunded_amount: 0, customer_status: 'registered',
  }, extra || {});
  const invScenario = (rows, over) => baseScenario(Object.assign({
    branches: [
      { id: 'branch-1', merchant_id: 'merchant-1', name: 'فرع الملقا' },
      { id: 'branch-2', merchant_id: 'merchant-1', name: 'فرع العليا' },
    ],
    invoices: rows,
  }, over || {}));
  const openInvoices = async (scenario) => {
    const o = await openMerchant(browser, { scenario });
    await loginFlow(o.page, '512345678', '123456');
    await o.page.waitForSelector('#viewTabs', { timeout: 3000 });
    return o;
  };
  const calls = (page) => page.evaluate(() => window.__TEST__.getInvoiceCalls());

  // 25) التبويب: الواجهة الحالية بلا تغيير (الإدارة افتراضياً، بلا نداء فواتير)؛ فتح الفواتير يطلب اليوم فقط.
  {
    const { context, page } = await openInvoices(invScenario([
      inv('a', TODAY, '10:15', 'branch-1', 'فرع الملقا', 1234.5, 185.18, 123, 'pos'),
    ]));
    check('25) الافتراضي بعد الدخول: شاشة الإدارة كما كانت (الأجهزة ظاهرة، لا فواتير)', await page.$('.dev-row') !== null && await page.$('#invPresets') === null);
    check('25) لا نداء merchant_list_invoices قبل فتح التبويب', (await calls(page)).length === 0);
    await page.click('#viewTabs [data-view="invoices"]');
    await page.waitForSelector('#invCards', { timeout: 3000 });
    const c = await calls(page);
    check('25) فتح الفواتير: نداء واحد، التاجر الصحيح، اليوم بتوقيت الرياض للطرفين',
      c.length === 1 && c[0].p_merchant_id === 'merchant-1' && c[0].p_from === TODAY && c[0].p_to === TODAY);
    check('25) كل الفروع (p_branch_id=null)، بلا فواتير تجريبية، صفحة 25 من الإزاحة 0',
      c[0].p_branch_id === null && c[0].p_include_demo === false && c[0].p_limit === 25 && c[0].p_offset === 0);
    check('25) اختصار "اليوم" هو المحدَّد', await page.$eval('#invPresets [data-preset="today"]', (b) => b.classList.contains('on')));
    await page.click('#viewTabs [data-view="manage"]');
    check('25) الرجوع للإدارة: الأجهزة وإعدادات الفرع كما كانت', await page.$('.dev-row') !== null && await page.$('#settingsSaveBtn') !== null);
    await context.close();
  }

  // 26) البطاقات والقائمة: أرقام إنجليزية، ريال بخانتين، "غير محدد" للفرع الفارغ، حالة العميل بلا أي هوية.
  {
    const rows = [
      inv('a', TODAY, '10:15', 'branch-1', 'فرع الملقا', 1234.5, 185.18, 123, 'pos'),
      inv('b', TODAY, '09:00', null, null, 80, 12, 8, 'manual', { customer_status: 'unregistered' }),
      inv('c', TODAY, '08:00', 'branch-2', 'فرع العليا', 200, 30, 20, 'pos', { refunded_amount: 40 }),
    ];
    const { context, page } = await openInvoices(invScenario(rows));
    await page.click('#viewTabs [data-view="invoices"]');
    await page.waitForSelector('#invCards', { timeout: 3000 });
    const cards = await page.textContent('#invCards');
    check('26) بطاقة العدد = 3 (الفاتورة بلا فرع محسوبة)', (await page.textContent('#invCount')).trim() === '3');
    check('26) إجمالي المبيعات 1,514.50 ر.س بخانتين وأرقام إنجليزية', /1,514\.50/.test(cards));
    check('26) الضريبة 227.18، المسترد 40.00، الصافي 1,474.50', /227\.18/.test(cards) && /40\.00/.test(cards) && /1,474\.50/.test(cards));
    check('26) لا أرقام عربية-هندية في الشاشة', !/[٠-٩]/.test(await page.textContent('#app')));
    const list = await page.textContent('#invList');
    check('26) الفاتورة بلا فرع تظهر تحت "غير محدد" ولا تسقط', /غير محدد/.test(list));
    check('26) اسم الفرع والمصدر يظهران ("كاشير"/"يدوي")', /فرع الملقا/.test(list) && /كاشير/.test(list) && /يدوي/.test(list));
    check('26) حالة العميل: "مسجَّل" و"غير مسجَّل بعد"', /مسجَّل/.test(list) && /غير مسجَّل بعد/.test(list));
    check('26) المسترد يظهر على الفاتورة المُرجَعة فقط', (await page.$$('#invList .inv-nums .ref')).length === 1);
    check('26) الأحدث أولاً (10:15 قبل 09:00 قبل 08:00)', list.indexOf('10:15') < list.indexOf('09:00') && list.indexOf('09:00') < list.indexOf('08:00'));
    await context.close();
  }

  // 27) الاختصارات: آخر 7 أيام، الشهر الحالي، فترة مخصصة (مع تحقق من المدخلات).
  {
    const { context, page } = await openInvoices(invScenario([inv('a', TODAY, '10:00', 'branch-1', 'فرع الملقا', 10, 1.5, 1, 'pos')]));
    await page.click('#viewTabs [data-view="invoices"]');
    await page.waitForSelector('#invCards', { timeout: 3000 });
    await page.click('#invPresets [data-preset="7d"]');
    await page.waitForFunction(() => window.__TEST__.getInvoiceCalls().length === 2);
    let c = await calls(page);
    check('27) آخر 7 أيام: من اليوم−6 إلى اليوم', c[1].p_from === addDays(TODAY, -6) && c[1].p_to === TODAY);
    await page.waitForSelector('#invCards');
    await page.click('#invPresets [data-preset="month"]');
    await page.waitForFunction(() => window.__TEST__.getInvoiceCalls().length === 3);
    c = await calls(page);
    check('27) الشهر الحالي: من أول الشهر إلى اليوم', c[2].p_from === TODAY.slice(0, 8) + '01' && c[2].p_to === TODAY);
    await page.waitForSelector('#invCards');
    await page.click('#invPresets [data-preset="custom"]');
    await page.waitForSelector('#invFrom');
    check('27) الفترة المخصصة: لا نداء جديد قبل "تطبيق"', (await calls(page)).length === 3);
    await page.fill('#invFrom', '2026-02-10');
    await page.fill('#invTo', '2026-02-01');
    await page.click('#invApply');
    check('27) نهاية قبل البداية: رسالة واضحة بلا نداء', /قبل تاريخ البداية/.test(await page.textContent('#app')) && (await calls(page)).length === 3);
    await page.fill('#invFrom', '2026-02-01');
    await page.fill('#invTo', '2026-02-10');
    await page.click('#invApply');
    await page.waitForFunction(() => window.__TEST__.getInvoiceCalls().length === 4);
    c = await calls(page);
    check('27) تطبيق فترة مخصصة صحيحة: التاريخان المُدخلان يُرسَلان كما هما', c[3].p_from === '2026-02-01' && c[3].p_to === '2026-02-10');
    await context.close();
  }

  // 28) فلتر الفرع: الفرع المحدد يُرسَل، "كل الفروع" ترسل null، والفاتورة بلا فرع تظهر مع الكل فقط.
  {
    const rows = [
      inv('a', TODAY, '10:00', 'branch-1', 'فرع الملقا', 100, 15, 10, 'pos'),
      inv('b', TODAY, '09:00', 'branch-2', 'فرع العليا', 50, 7.5, 5, 'pos'),
      inv('c', TODAY, '08:00', null, null, 80, 12, 8, 'manual'),
    ];
    const { context, page } = await openInvoices(invScenario(rows));
    await page.click('#viewTabs [data-view="invoices"]');
    await page.waitForSelector('#invCards');
    check('28) كل الفروع: 3 فواتير بينها غير المحدد', (await page.textContent('#invCount')).trim() === '3' && /غير محدد/.test(await page.textContent('#invList')));
    await page.selectOption('#invBranch', 'branch-2');
    await page.waitForFunction(() => window.__TEST__.getInvoiceCalls().length === 2);
    await page.waitForFunction(() => document.getElementById('invCount') && document.getElementById('invCount').textContent.trim() === '1');
    const c = await calls(page);
    check('28) اختيار فرع: p_branch_id = معرّفه', c[1].p_branch_id === 'branch-2');
    check('28) فرع محدد: لا تظهر الفاتورة بلا فرع', !/غير محدد/.test(await page.textContent('#invList')) && /فرع العليا/.test(await page.textContent('#invList')));
    await page.selectOption('#invBranch', '');
    await page.waitForFunction(() => window.__TEST__.getInvoiceCalls().length === 3);
    check('28) الرجوع لكل الفروع: p_branch_id = null', (await calls(page))[2].p_branch_id === null);
    await context.close();
  }

  // 29) الحالة الفارغة.
  {
    const { context, page } = await openInvoices(invScenario([]));
    await page.click('#viewTabs [data-view="invoices"]');
    await page.waitForSelector('#invEmpty', { timeout: 3000 });
    check('29) لا فواتير: رسالة "لا فواتير في هذه الفترة"', /لا فواتير في هذه الفترة/.test(await page.textContent('#invEmpty')));
    check('29) المجاميع تظهر أصفاراً بخانتين (لا تختفي)', (await page.textContent('#invCount')).trim() === '0' && /0\.00/.test(await page.textContent('#invCards')));
    await context.close();
  }

  // 30) الترقيم: 25 أولاً ثم "تحميل المزيد" يلحق الباقي بلا تكرار، والمجاميع تبقى لكل الفترة.
  {
    const rows = [];
    for (let i = 0; i < 30; i++) rows.push(inv('r' + i, TODAY, '10:' + String(59 - i).padStart(2, '0'), 'branch-1', 'فرع الملقا', 10, 1.5, 1, 'pos'));
    const { context, page } = await openInvoices(invScenario(rows));
    await page.click('#viewTabs [data-view="invoices"]');
    await page.waitForSelector('#invMore', { timeout: 3000 });
    check('30) الصفحة الأولى 25 فاتورة والعدد الكلي 30', (await page.$$('#invList .inv-row')).length === 25 && (await page.textContent('#invCount')).trim() === '30');
    await page.click('#invMore');
    await page.waitForFunction(() => document.querySelectorAll('#invList .inv-row').length === 30);
    const c = await calls(page);
    check('30) "تحميل المزيد" يطلب الإزاحة 25 بنفس الفلاتر', c.length === 2 && c[1].p_offset === 25 && c[1].p_from === TODAY);
    check('30) بعد التحميل 30 صفاً بلا تكرار، والزر يختفي', (await page.$('#invMore')) === null && new Set(await page.$$eval('#invList .inv-top b', (els) => els.map((e) => e.textContent))).size === 30);
    check('30) المجاميع لم تتغيّر بعد تحميل المزيد (كل الفترة)', (await page.textContent('#invCount')).trim() === '30' && /300\.00/.test(await page.textContent('#invCards')));
    await context.close();
  }

  // 31) الخطأ: رسالة + إعادة محاولة تعمل؛ ولا بيانات مختلَقة.
  {
    const { context, page } = await openInvoices(invScenario([inv('a', TODAY, '10:00', 'branch-1', 'فرع الملقا', 10, 1.5, 1, 'pos')], { invoicesErrorOnce: true }));
    await page.click('#viewTabs [data-view="invoices"]');
    await page.waitForSelector('#invErr', { timeout: 3000 });
    check('31) فشل التحميل: رسالة واضحة بلا مجاميع مختلَقة', /تعذّر تحميل الفواتير/.test(await page.textContent('#invErr')) && await page.$('#invCards') === null);
    await page.click('#invRetry');
    await page.waitForSelector('#invCards', { timeout: 3000 });
    check('31) إعادة المحاولة تنجح وتعرض المجاميع', (await page.textContent('#invCount')).trim() === '1');
    await context.close();
  }

  // 32) رد متأخر لطلب أقدم لا يطغى على الأحدث (تبديل اختصار سريع).
  {
    const rows = [
      inv('t', TODAY, '10:00', 'branch-1', 'فرع الملقا', 100, 15, 10, 'pos'),
      inv('w', addDays(TODAY, -3), '10:00', 'branch-1', 'فرع الملقا', 7, 1, 1, 'pos'),
    ];
    const { context, page } = await openInvoices(invScenario(rows, { invoicesDelays: [600, 0] }));
    await page.click('#viewTabs [data-view="invoices"]');
    await page.waitForSelector('#invLoading');
    await page.click('#invPresets [data-preset="7d"]');
    await page.waitForSelector('#invCards', { timeout: 3000 });
    await page.waitForTimeout(900);
    check('32) بعد وصول الرد القديم المتأخر تبقى نتيجة "آخر 7 أيام" (فاتورتان) لا "اليوم" (واحدة)', (await page.textContent('#invCount')).trim() === '2');
    await context.close();
  }

  // 33) الموظف والمالك كلاهما يريان الفواتير؛ وتبديل التاجر يعيد التحميل لتاجره.
  {
    const staff = await openInvoices(invScenario([inv('a', TODAY, '10:00', 'branch-1', 'فرع الملقا', 10, 1.5, 1, 'pos')], { merchantMembers: [{ merchant_id: 'merchant-1', role: 'staff' }] }));
    await staff.page.click('#viewTabs [data-view="invoices"]');
    await staff.page.waitForSelector('#invCards', { timeout: 3000 });
    check('33) الموظف يرى شاشة الفواتير كاملة', (await staff.page.textContent('#invCount')).trim() === '1');
    await staff.context.close();

    const two = invScenario([inv('a', TODAY, '10:00', 'branch-1', 'فرع الملقا', 10, 1.5, 1, 'pos')], {
      merchantMembers: [{ merchant_id: 'merchant-1', role: 'owner' }, { merchant_id: 'merchant-2', role: 'owner' }],
      merchants: [{ id: 'merchant-1', name: 'مركز النور الطبي' }, { id: 'merchant-2', name: 'تاجر ثانٍ' }],
    });
    const { context, page } = await openInvoices(two);
    await page.click('#viewTabs [data-view="invoices"]');
    await page.waitForSelector('#invCards', { timeout: 3000 });
    await page.selectOption('#merchantSelect', 'merchant-2');
    await page.waitForFunction(() => window.__TEST__.getInvoiceCalls().length === 2, null, { timeout: 4000 });
    check('33) تبديل التاجر وهو على تبويب الفواتير: نداء جديد بمعرّف التاجر الجديد', (await calls(page))[1].p_merchant_id === 'merchant-2');
    await context.close();
  }

  // =========================================================================
  // 34-40) الأقسام الستة + مدة تعليق النقاط (supabase-migration-unified-sectors.sql)
  // =========================================================================
  const holdScenario = (merchant, extra) => baseScenario(Object.assign({
    merchants: [Object.assign({ id: 'merchant-1', name: 'مركز النور الطبي', sector_code: 'medical', points_hold_days: 0 }, merchant || {})],
    branchSettings: [{ branch_id: 'branch-1', sector_code: (merchant && merchant.sector_code) || 'medical', biz_name: 'مركز النور', biz_branch: 'فرع الملقا', biz_slogan: '', biz_logo: '', pos_mode: 'demo' }],
  }, extra || {}));
  const openSettings = async (scenario) => {
    const { context, page } = await openMerchant(browser, { scenario });
    await loginFlow(page, '512345678', '123456');
    await page.waitForSelector('#sectorSw', { timeout: 3000 });
    return { context, page };
  };
  const saveAndWait = async (page) => {
    await page.click('#settingsSaveBtn');
    await page.waitForFunction(() => !document.querySelector('#settingsSaveBtn .spinner'), null, { timeout: 3000 }).catch(() => {});
    await page.waitForTimeout(150);
  };

  {
    const { context, page } = await openSettings(holdScenario());
    const btns = await page.$$eval('#sectorSw button', (bs) => bs.map((b) => [b.getAttribute('data-sector'), b.textContent]));
    check('34) الأقسام الستة بالترتيب وبأسمائها: بقالة، تجزئة، مقهى، مطعم، صحي، خدمات',
      JSON.stringify(btns) === JSON.stringify([['grocery', 'بقالة'], ['retail', 'تجزئة'], ['cafe', 'مقهى'], ['restaurant', 'مطعم'], ['medical', 'صحي'], ['services', 'خدمات']]));
    check('35) المالك يرى حقل مدة تعليق النقاط بقيمة الخادم الفعلية (0)', await page.inputValue('#fHoldDays') === '0');
    await context.close();
  }
  {
    const { context, page } = await openSettings(holdScenario({}, { merchantMembers: [{ merchant_id: 'merchant-1', role: 'staff' }] }));
    check('35) الموظف لا يرى حقل مدة التعليق إطلاقاً (للمالك فقط)', (await page.$('#fHoldDays')) === null);
    await context.close();
  }
  {
    // غير معدَّلة يدوياً (صحي = 0 = افتراضه): تتبع افتراض القسم الجديد
    const { context, page } = await openSettings(holdScenario());
    await page.click('#sectorSw button[data-sector="grocery"]');
    check('36) مدة غير معدَّلة يدوياً: تغيير القسم إلى بقالة يضع افتراضه (7) في الحقل', await page.inputValue('#fHoldDays') === '7');
    check('36) …مع تنبيه واضح بأن الافتراض سيُطبَّق', /ستُطبَّق المدة الافتراضية لقسم بقالة: 7 أيام/.test(await page.textContent('#holdHint')));
    await page.click('#sectorSw button[data-sector="medical"]');
    check('36) الرجوع للقسم الأصلي يعيد القيمة الأصلية (0)', await page.inputValue('#fHoldDays') === '0');
    await page.click('#sectorSw button[data-sector="retail"]');
    await saveAndWait(page);
    const upd = await page.evaluate(() => window.__TEST__.getLastBranchSettingsUpdate());
    const m = await page.evaluate(() => window.__TEST__.getMerchant('merchant-1'));
    const holdCalls = await page.evaluate(() => window.__TEST__.getHoldCalls());
    check('36) الحفظ يغيّر القسم (retail) عبر merchant_set_sector والخادم يطبّق افتراضه (7) — بلا نداء إضافي لتعيين المدة',
      upd && !('sector_code' in upd.payload) && m.sector_code === 'retail' && m.points_hold_days === 7 && holdCalls.length === 0 &&
      (await page.evaluate(() => window.__TEST__.getSectorCalls())).length === 1);
    check('36) بعد الحفظ يعرض الحقل القيمة الفعلية (7)', await page.inputValue('#fHoldDays') === '7');
    await context.close();
  }
  {
    // معدَّلة يدوياً (بقالة بمدة 3 ≠ 7): لا تتغيّر تلقائياً، الافتراض الجديد اقتراح فقط
    const { context, page } = await openSettings(holdScenario({ sector_code: 'grocery', points_hold_days: 3 }));
    await page.click('#sectorSw button[data-sector="cafe"]');
    check('37) مدة معدَّلة يدوياً (3): تغيير القسم لا يغيّرها في الحقل', await page.inputValue('#fHoldDays') === '3');
    const hint = await page.textContent('#holdHint');
    check('37) …ويظهر افتراض القسم الجديد كاقتراح فقط، مع زر لتطبيقه', /المدة الافتراضية لقسم مقهى: بلا تعليق/.test(hint) && /عدّلتها يدوياً فلن تتغيّر تلقائياً/.test(hint) && (await page.$('#useDefaultHold')) !== null);
    await saveAndWait(page);
    const m = await page.evaluate(() => window.__TEST__.getMerchant('merchant-1'));
    check('37) الحفظ بلا ضغط الزر: القسم يتغيّر والمدة المعدَّلة يدوياً تبقى 3 (بلا نداء تعيين)',
      m.sector_code === 'cafe' && m.points_hold_days === 3 && (await page.evaluate(() => window.__TEST__.getHoldCalls())).length === 0);
    await context.close();
  }
  {
    const { context, page } = await openSettings(holdScenario({ sector_code: 'grocery', points_hold_days: 3 }));
    await page.click('#sectorSw button[data-sector="cafe"]');
    await page.click('#useDefaultHold');
    check('37) زر "استخدام المدة الافتراضية" يضع افتراض القسم الجديد (0) في الحقل', await page.inputValue('#fHoldDays') === '0');
    await saveAndWait(page);
    const calls = await page.evaluate(() => window.__TEST__.getHoldCalls());
    check('37) …والحفظ يستدعي merchant_set_points_hold_days بالقيمة المختارة للتاجر الصحيح',
      calls.length === 1 && calls[0].p_merchant_id === 'merchant-1' && calls[0].p_days === 0 && (await page.evaluate(() => window.__TEST__.getMerchant('merchant-1'))).points_hold_days === 0);
    await context.close();
  }
  {
    const { context, page } = await openSettings(holdScenario());
    await page.fill('#fHoldDays', '14');
    await saveAndWait(page);
    const calls = await page.evaluate(() => window.__TEST__.getHoldCalls());
    check('38) تعديل المدة يدوياً (14) في نفس القسم: نداء واحد بالقيمة الصحيحة', calls.length === 1 && calls[0].p_days === 14);
    await context.close();
  }
  {
    const { context, page } = await openSettings(holdScenario());
    await page.fill('#fHoldDays', '400');
    await page.click('#settingsSaveBtn');
    await page.waitForTimeout(200);
    const err = await page.textContent('#app');
    check('38) قيمة خارج 0..365 تُرفض محلياً برسالة واضحة، بلا أي حفظ ولا نداء',
      /من 0 إلى 365/.test(err) && (await page.evaluate(() => window.__TEST__.getLastBranchSettingsUpdate())) === null && (await page.evaluate(() => window.__TEST__.getHoldCalls())).length === 0);
    await context.close();
  }
  {
    const { context, page } = await openSettings(holdScenario({}, { holdRpcError: true }));
    await page.fill('#fHoldDays', '5');
    await saveAndWait(page);
    check('39) فشل حفظ المدة يظهر برسالة صريحة (الإعدادات الأخرى حُفظت)', /تعذّر حفظ مدة تعليق النقاط/.test(await page.textContent('#app')) && (await page.evaluate(() => window.__TEST__.getLastBranchSettingsUpdate())) !== null);
    check('39) …والقيمة المطلوبة تبقى في الحقل لإعادة المحاولة', await page.inputValue('#fHoldDays') === '5');
    await context.close();
  }
  {
    const multi = holdScenario({}, {
      branches: [{ id: 'branch-1', merchant_id: 'merchant-1', name: 'فرع الملقا' }, { id: 'branch-2', merchant_id: 'merchant-1', name: 'فرع العليا' }],
    });
    multi.branchSettings.push({ branch_id: 'branch-2', sector_code: 'medical', biz_name: 'مركز النور', biz_branch: 'فرع العليا', biz_slogan: '', biz_logo: '', pos_mode: 'demo' });
    const { context, page } = await openSettings(multi);
    check('40) تاجر بأكثر من فرع: تنبيه أن القسم واحد لكل الفروع', /القسم واحد للتاجر: تغييره يُطبَّق على كل الفروع/.test(await page.textContent('#app')));
    await context.close();
  }
  {
    const { context, page } = await openSettings(holdScenario({}, { merchantMembers: [{ merchant_id: 'merchant-1', role: 'staff' }] }));
    const direct = await page.evaluate(async () => (await window.__NOJ_SUPABASE_CLIENT__.rpc('merchant_set_points_hold_days', { p_merchant_id: 'merchant-1', p_days: 30 })).error);
    check('40) دفاع في العمق: نداء مباشر للدالة بجلسة موظف يُرفض', direct && /لا تملك صلاحية/.test(direct.message));
    await context.close();
  }

  // =========================================================================
  // 41-43) القسم للمالك فقط (supabase-migration-sector-owner-only.sql) + "شاشة نوج"
  // =========================================================================
  {
    const { context, page } = await openSettings(holdScenario({}, { merchantMembers: [{ merchant_id: 'merchant-1', role: 'staff' }] }));
    const states = await page.$$eval('#sectorSw button', (bs) => bs.map((b) => [b.getAttribute('data-sector'), b.disabled, b.classList.contains('on')]));
    check('41) الموظف يرى القسم الحالي (صحي) مُحدَّداً، وكل أزرار القسم معطَّلة، مع تنبيه "للمالك فقط"',
      states.length === 6 && states.every((x) => x[1] === true) && states.find((x) => x[0] === 'medical')[2] === true &&
      /تغيير القسم للمالك فقط/.test(await page.textContent('#sectorOwnerOnly')));
    await page.evaluate(() => document.querySelector('#sectorSw button[data-sector="cafe"]').click());
    await page.fill('#fBizName', 'اسم الموظف');
    await page.click('#settingsSaveBtn');
    await page.waitForTimeout(250);
    const upd = await page.evaluate(() => window.__TEST__.getLastBranchSettingsUpdate());
    check('41) حفظ الموظف يحفظ بقية الحقول، ولا يغيّر القسم ولا يستدعي merchant_set_sector',
      upd && upd.payload.biz_name === 'اسم الموظف' && !('sector_code' in upd.payload) &&
      (await page.evaluate(() => window.__TEST__.getSectorCalls())).length === 0 &&
      (await page.evaluate(() => window.__TEST__.getMerchant('merchant-1'))).sector_code === 'medical');
    const direct = await page.evaluate(async () => (await window.__NOJ_SUPABASE_CLIENT__.rpc('merchant_set_sector', { p_merchant_id: 'merchant-1', p_sector: 'cafe' })).error);
    check('41) دفاع في العمق: نداء merchant_set_sector مباشرة بجلسة موظف يُرفض', direct && /لا تملك صلاحية/.test(direct.message));
    await context.close();
  }
  {
    const { context, page } = await openSettings(holdScenario());
    await page.fill('#fBizSlogan', 'شعار');
    await saveAndWait(page);
    check('42) المالك يحفظ بلا تغيير القسم: لا نداء merchant_set_sector إطلاقاً', (await page.evaluate(() => window.__TEST__.getSectorCalls())).length === 0 && (await page.evaluate(() => window.__TEST__.branchSectorWriteAttempted())) === false);
    await context.close();
  }
  {
    const { context, page } = await openSettings(holdScenario({}, { sectorRpcError: true }));
    await page.click('#sectorSw button[data-sector="cafe"]');
    await saveAndWait(page);
    check('42) فشل تغيير القسم يظهر برسالة صريحة (بقية الإعدادات حُفظت)', /تعذّر تغيير القسم/.test(await page.textContent('#app')));
    await context.close();
  }
  {
    const { context, page } = await openSettings(holdScenario());
    const txt = await page.textContent('#app');
    check('43) لوحة التاجر تسمّي الجهاز "شاشة نوج" (اعتماد/رمز إعدادات/رمز الإقران)، بلا "كشك"',
      /اعتماد شاشة نوج جديدة/.test(txt) && /رمز إعدادات شاشة نوج/.test(txt) && /الظاهر على شاشة نوج/.test(txt) && !/كشك|أكشاك/.test(txt));
    await context.close();
  }

  await browser.close();
  console.log('\n=== MERCHANT E2E SUMMARY:', pass, 'passed,', fail, 'failed ===');
  if (failures.length) console.log('Failures:', JSON.stringify(failures, null, 2));
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => { console.error('FATAL:', e); process.exit(1); });
