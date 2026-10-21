// NOJ — Playwright tests for index.html (تطبيق نوج) LOGIN, after a live bug: a
// customer whose number already has an account could not log in from a new
// device (tablet: PUT /user 422 phone_exists → POST /otp 400 captcha_failed;
// iPhone: PUT /user 200 → POST /verify "User not found"). Real Chromium, fake
// Turnstile (fake-turnstile.js) and fake Supabase Auth (fake-auth-supabase.js,
// which enforces one-time CAPTCHA tokens and the sms/phone_change verify types).
const { chromium } = require('playwright');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..');
const INDEX_URL = 'file://' + path.join(REPO_ROOT, 'index.html');
const CHROMIUM_PATH = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

let pass = 0, fail = 0;
const failures = [];
function check(label, cond) {
  if (cond) { pass++; console.log('PASS -', label); }
  else { fail++; failures.push(label); console.log('FAIL -', label); }
}

const PHONE = '+966500000000'; // the live test number (OTP 123456)
const EXISTING = { [PHONE]: { id: 'user-existing' } };

async function openAuth(browser, scenario, opts) {
  const context = await browser.newContext({ timezoneId: 'Asia/Riyadh' });
  const page = await context.newPage();
  await page.route(/^https?:\/\//, (route) => route.abort());
  await page.addInitScript((s) => { window.__NOJ_SCENARIO__ = s; }, Object.assign({ captchaEnabled: true }, scenario));
  if (opts && opts.waitMs) await page.addInitScript((ms) => { window.__NOJ_TURNSTILE_WAIT_MS__ = ms; }, opts.waitMs);
  await page.addInitScript({ path: path.join(__dirname, 'fake-turnstile.js') });
  await page.addInitScript({ path: path.join(__dirname, 'fake-auth-supabase.js') });
  await page.goto(INDEX_URL);
  await page.waitForSelector('#ph', { timeout: 8000 });
  await page.waitForTimeout(150); // the widget renders while the customer types
  return { context, page };
}
async function sendCode(page, phoneText) {
  await page.fill('#ph', phoneText);
  await page.click('#send');
  return page.waitForSelector('[data-otp="0"]', { timeout: 15000 }).then(() => true, () => false);
}
async function enterCode(page, digits) {
  const boxes = await page.$$('[data-otp]');
  if (boxes.length < digits.length) return false; // never reached the code screen
  for (let i = 0; i < digits.length; i++) await boxes[i].fill(digits[i]);
  return page.waitForFunction(() => typeof S !== 'undefined' && S.dataLoading === false && document.getElementById('app').style.display === '' && document.getElementById('auth').style.display === 'none', null, { timeout: 8000 }).then(() => true, () => false);
}
const calls = (page) => page.evaluate(() => window.__TEST__.getCalls());
const names = (cs) => cs.map((c) => c.name);
const tokensSent = (cs) => cs.filter((c) => c.captchaToken).map((c) => c.captchaToken);
const allDistinct = (a) => new Set(a).size === a.length;

(async () => {
  const browser = await chromium.launch({ executablePath: CHROMIUM_PATH });

  // 1) new customer (no account for this number), fresh device: anonymous session → upgraded
  {
    const { context, page } = await openAuth(browser, { users: {} });
    const reached = await sendCode(page, '500000000');
    let cs = await calls(page);
    check('1) عميل جديد: يصل لشاشة الرمز', reached);
    check('1) الترتيب: جلسة مجهولة ← حدّ الإرسال ← فحص الحساب (shouldCreateUser:false) ← updateUser للرقم',
      JSON.stringify(names(cs)) === JSON.stringify(['signInAnonymously', 'rpc:record_otp_request', 'signInWithOtp', 'updateUser']) &&
      !!cs[3] && cs[2].shouldCreateUser === false && cs[3].phone === PHONE);
    check('1) كل طلب يحتاج CAPTCHA أخذ رمزاً مختلفاً، وupdateUser لم يستهلك رمزاً', tokensSent(cs).length === 2 && allDistinct(tokensSent(cs)) && !!cs[3] && !cs[3].captchaToken);
    const ok = await enterCode(page, '123456');
    cs = await calls(page);
    const v = cs.find((c) => c.name === 'verifyOtp');
    check('1) التحقق بنوع phone_change (نفس مسار الإرسال) على الجلسة المجهولة نفسها، ثم الدخول', ok && !!v && v.type === 'phone_change' &&
      (await page.evaluate(() => (window.__TEST__.getSessionUser() || {}).id)) === 'anon-1');
    check('1) بعد الدخول: claim_or_create_verified_profile ثم claim_unclaimed_invoices', names(cs).indexOf('rpc:claim_or_create_verified_profile') !== -1 &&
      names(cs).indexOf('rpc:claim_unclaimed_invoices') > names(cs).indexOf('rpc:claim_or_create_verified_profile'));
    await context.close();
  }

  // 2) existing customer from a NEW device (no session yet) — the iPhone case
  {
    const { context, page } = await openAuth(browser, { users: Object.assign({}, EXISTING) });
    const reached = await sendCode(page, '500000000');
    let cs = await calls(page);
    check('2) عميل موجود من جهاز جديد: يصل لشاشة الرمز', reached);
    check('2) لا updateUser إطلاقاً — signInWithOtp مباشرة (shouldCreateUser:false) برمز جديد',
      !names(cs).includes('updateUser') && cs.filter((c) => c.name === 'signInWithOtp').length === 1 && allDistinct(tokensSent(cs)));
    const ok = await enterCode(page, '123456');
    cs = await calls(page);
    check('2) التحقق بنوع sms فيدخل حسابه الموجود نفسه (لا "User not found")', ok && (cs.find((c) => c.name === 'verifyOtp') || {}).type === 'sms' &&
      (await page.evaluate(() => (window.__TEST__.getSessionUser() || {}).id)) === 'user-existing');
    const i1 = names(cs).indexOf('rpc:claim_or_create_verified_profile'), i2 = names(cs).indexOf('rpc:claim_unclaimed_invoices');
    check('2) فواتير الرقم لا تضيع: claim_or_create_verified_profile ثم claim_unclaimed_invoices بجلسة الحساب الموجود',
      i1 !== -1 && i2 > i1 && cs[i2].sessionUser === 'user-existing');
    await context.close();
  }

  // 3) existing customer, the device ALREADY has an anonymous session — the tablet case
  {
    const { context, page } = await openAuth(browser, { users: Object.assign({}, EXISTING), session: { user: { id: 'anon-old', is_anonymous: true }, access_token: 'x' } });
    const reached = await sendCode(page, '500000000');
    const cs = await calls(page);
    check('3) جهاز عليه جلسة مجهولة مسبقاً + رقم موجود: يصل لشاشة الرمز (لا captcha_failed)', reached);
    check('3) لا جلسة مجهولة جديدة ولا updateUser: طلب CAPTCHA واحد فقط (/otp) برمز لم يُستخدم',
      JSON.stringify(names(cs)) === JSON.stringify(['rpc:record_otp_request', 'signInWithOtp']) && tokensSent(cs).length === 1);
    check('3) …ويدخل بنوع sms', (await enterCode(page, '123456')) && ((await calls(page)).find((c) => c.name === 'verifyOtp') || {}).type === 'sms');
    await context.close();
  }

  // 4) Arabic(-Indic) digits in the phone and the code
  {
    const { context, page } = await openAuth(browser, { users: Object.assign({}, EXISTING) });
    await page.fill('#ph', '٥٠٠٠٠٠٠٠٠');
    check('4) خانة الجوال تحوّل الأرقام العربية إلى إنجليزية فوراً', (await page.inputValue('#ph')) === '500000000');
    await page.fill('#ph', '۵۰۰۰۰۰۰۰۰');
    check('4) …والفارسية أيضاً', (await page.inputValue('#ph')) === '500000000');
    await page.click('#send');
    await page.waitForSelector('[data-otp="0"]', { timeout: 15000 }).catch(() => {});
    check('4) الرقم المُرسَل للخادم بأرقام إنجليزية', ((await calls(page)).find((c) => c.name === 'signInWithOtp') || {}).phone === PHONE);
    const ok = await enterCode(page, '١٢٣٤٥٦');
    check('4) خانة الرمز تحوّل الأرقام العربية، والتحقق ينجح بـ 123456', ok && ((await calls(page)).find((c) => c.name === 'verifyOtp') || {}).token === '123456');
    await context.close();
  }
  // 5) every send request uses a different Turnstile token — even resends, even a slow widget
  {
    const { context, page } = await openAuth(browser, { users: Object.assign({}, EXISTING) });
    await sendCode(page, '500000000');
    await page.evaluate(() => resendOtp());
    await page.waitForTimeout(300);
    await page.evaluate(() => resendOtp());
    await page.waitForTimeout(300);
    const cs = await calls(page);
    const otps = cs.filter((c) => c.name === 'signInWithOtp');
    check('5) إعادة الإرسال (مسار sms) مرتين: ثلاثة طلبات /otp بثلاثة رموز مختلفة، وكلها نجحت (لا رمز مستهلَك)',
      otps.length === 3 && allDistinct(tokensSent(cs)) && tokensSent(cs).length === 4 && otps.every((c) => c.shouldCreateUser === false) && !names(cs).includes('updateUser'));
    await context.close();
  }
  {
    const { context, page } = await openAuth(browser, { users: {} });
    await sendCode(page, '500000000');
    await page.evaluate(() => resendOtp());
    await page.waitForTimeout(300);
    const cs = await calls(page);
    check('5) إعادة الإرسال لعميل جديد تبقى على مسار phone_change (updateUser، بلا استهلاك رمز)',
      cs.filter((c) => c.name === 'updateUser').length === 2 && cs.filter((c) => c.name === 'signInWithOtp').length === 1);
    check('5) …والتحقق بعدها بنوع phone_change', (await enterCode(page, '123456')) && ((await calls(page)).find((c) => c.name === 'verifyOtp') || {}).type === 'phone_change');
    await context.close();
  }
  {
    // Managed mode can take seconds to issue a token after reset — longer than the old 2.5 s wait
    const { context, page } = await openAuth(browser, { users: Object.assign({}, EXISTING), turnstileVerifyMs: 3500 });
    await page.waitForTimeout(3700);
    const reached = await sendCode(page, '500000000');
    const cs = await calls(page);
    check('5) ودجت بطيء (3.5 ثانية لكل رمز بعد reset): الانتظار يكفي، طلبا CAPTCHA برمزين مختلفين، ويصل لشاشة الرمز',
      reached && tokensSent(cs).length === 2 && allDistinct(tokensSent(cs)));
    await context.close();
  }
  {
    // a widget that hands back the SAME token after reset: it is never sent twice
    const { context, page } = await openAuth(browser, { users: Object.assign({}, EXISTING), turnstileRepeatAfterReset: true }, { waitMs: 600 });
    await page.fill('#ph', '500000000');
    await page.click('#send');
    await page.waitForTimeout(1500);
    const cs = await calls(page);
    check('5) رمز مكرَّر من الودجت لا يُرسَل مرتين أبداً (يُرسَل الطلب بلا رمز فيُرفض برسالة واضحة)',
      allDistinct(tokensSent(cs)) && cs.filter((c) => c.name === 'signInWithOtp').length === 1 && !(cs.find((c) => c.name === 'signInWithOtp') || {}).captchaToken &&
      /أكمل التحقق الأمني/.test(await page.textContent('#auth')));
    await context.close();
  }

  await browser.close();
  console.log('\n=== INDEX AUTH E2E SUMMARY:', pass, 'passed,', fail, 'failed ===');
  if (failures.length) console.log('Failures:', JSON.stringify(failures, null, 2));
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => { console.error('FATAL:', e); process.exit(1); });
