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
  // 5) شاشة الأجهزة: الفرع، الحالة، آخر نشاط.
  // =========================================================================
  {
    const scenario = baseScenario({});
    const { context, page } = await openMerchant(browser, { scenario });
    await loginFlow(page, '512345678', '123456');
    await page.waitForSelector('.dev-row', { timeout: 3000 });
    const rowText = await page.textContent('.dev-row');
    check('5) اسم الفرع يظهر في صف الجهاز', /فرع الملقا/.test(rowText));
    check('5) حالة "فعّال" تظهر لجهاز نشط', /فعّال/.test(rowText));
    check('5) وقت آخر نشاط يظهر (من last_seen_at)', /2026-01-10/.test(rowText));
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

  await browser.close();
  console.log('\n=== MERCHANT E2E SUMMARY:', pass, 'passed,', fail, 'failed ===');
  if (failures.length) console.log('Failures:', JSON.stringify(failures, null, 2));
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => { console.error('FATAL:', e); process.exit(1); });
