// NOJ — Playwright E2E tests for index.html (تطبيق نوج): the reservations
// screens for restaurants and services (supabase-migration-reservations.sql),
// and that the health "مواعيدي" path stays exactly as it was. Real Chromium,
// fake Supabase client (fake-supabase.js), zero live network — index.html is
// untouched except for the test hook it already has
// (window.__NOJ_SUPABASE_CLIENT__, see getSb()).
const { chromium } = require('playwright');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..');
const INDEX_URL = 'file://' + path.join(REPO_ROOT, 'index.html');
const CHROMIUM_PATH = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const FAKE_SB_PATH = path.join(__dirname, 'fake-supabase.js');

let pass = 0, fail = 0;
const failures = [];
function check(label, cond) {
  if (cond) { pass++; console.log('PASS -', label); }
  else { fail++; failures.push(label); console.log('FAIL -', label); }
}

const PROFILE = { id: 'profile-1', name: 'سارة', phone: '561234567', tier: 'برونزي' };
const REST = 'm-rest', SERV = 'm-serv', HEALTH = 'm-health', CAFE = 'm-cafe', PAUSED = 'm-paused';
const inv = (id, merchant, type) => ({ id, user_id: PROFILE.id, amount: 50, category: type, items: [], created_at: '2026-01-05T10:00:00Z', merchant_id: merchant, merchants: { name: 'x', branch: null } });
const inDays = (d, h) => new Date(Date.now() + d * 86400000 + (h || 0) * 3600000).toISOString();
// "YYYY-MM-DD" in Asia/Riyadh, d days from now
function riyadhDate(d) {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Riyadh', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(Date.now() + d * 86400000));
  const g = {}; p.forEach((x) => { g[x.type] = x.value; });
  return g.year + '-' + g.month + '-' + g.day;
}

function baseScenario(over) {
  return Object.assign({
    profile: PROFILE,
    clinics: [{ clinic_id: 'c-1', clinic_name: 'عيادة الأسنان', doctor_name: 'د. سلطان', booking_enabled: true, now_serving: 3, waiting_count: 2, est_minutes: 10 }],
    tables: {
      invoices: [inv('i-1', REST, 'مطاعم'), inv('i-2', SERV, 'خدمات'), inv('i-3', HEALTH, 'صحة'), inv('i-4', CAFE, 'مقاهي'), inv('i-5', PAUSED, 'مطاعم')],
      queue_tickets: [], rewards: [], merchant_loyalty: [],
      profile_consents: [{ id: 'pc-1', profile_id: PROFILE.id, consent_type: 'data_processing', revoked_at: null }],
      merchants: [
        { id: REST, name: 'مطعم مذاق', branch: null, type: 'مطاعم', booking_enabled: true, queue_enabled: false },
        { id: SERV, name: 'غسيل السيارات', branch: null, type: 'خدمات', booking_enabled: true, queue_enabled: false },
        { id: HEALTH, name: 'مركز النور الطبي', branch: null, type: 'صحة', booking_enabled: true, queue_enabled: false },
        { id: CAFE, name: 'مقهى نجل', branch: null, type: 'مقاهي', booking_enabled: true, queue_enabled: false },
        { id: PAUSED, name: 'مطعم متوقف', branch: null, type: 'مطاعم', booking_enabled: false, queue_enabled: false },
      ],
      appointments: [
        { id: 'h-1', user_id: PROFILE.id, merchant_id: HEALTH, clinic_id: 'c-1', booking_kind: 'appointment', status: 'confirmed', scheduled_at: inDays(2), clinics: { name: 'عيادة الأسنان', doctor_name: 'د. سلطان' } },
      ],
    },
  }, over || {});
}

async function openApp(browser, scenario, timezoneId) {
  const context = await browser.newContext({ timezoneId: timezoneId || 'Asia/Riyadh' });
  const page = await context.newPage();
  await page.route(/^https?:\/\//, (route) => route.abort());
  await page.addInitScript(() => { localStorage.setItem('noj_session', 'true'); });
  await page.addInitScript((s) => { window.__NOJ_SCENARIO__ = s; }, scenario);
  await page.addInitScript({ path: FAKE_SB_PATH });
  await page.goto(INDEX_URL);
  await page.waitForFunction(() => typeof S !== 'undefined' && S.dataLoading === false && document.querySelector('.nav button[data-tab="merchants"]'), null, { timeout: 8000 });
  return { context, page };
}
async function openBooking(page, merchantId) {
  await page.click('.nav button[data-tab="merchants"]');
  await page.click('[data-open-merchant="' + merchantId + '"]');
  await page.waitForSelector('[data-open-section="booking"]', { timeout: 3000 });
  await page.click('[data-open-section="booking"]');
  await page.waitForTimeout(150);
}
const toastText = (page) => page.textContent('#toast-text');
const appText = (page) => page.textContent('#app');

(async () => {
  const browser = await chromium.launch({ executablePath: CHROMIUM_PATH });

  // 1-3) المطعم: قسم "حجوزات"، نموذج حجز طاولة، وإرسال حقيقي عبر create_reservation.
  //      جهاز العميل على توقيت نيويورك عمداً: الوقت المختار يبقى وقت المتجر (الرياض).
  {
    const { context, page } = await openApp(browser, baseScenario(), 'America/New_York');
    await page.click('.nav button[data-tab="merchants"]');
    await page.click('[data-open-merchant="' + REST + '"]');
    await page.waitForSelector('[data-open-section="booking"]');
    check('1) مطعم فعّل الحجوزات: قسم باسم "حجوزات" في صفحته', /حجوزات/.test(await page.textContent('[data-open-section="booking"]')));
    await page.click('[data-open-section="booking"]');
    await page.waitForSelector('#resEmpty');
    check('1) بلا حجوزات: حالة فارغة + زر "حجز طاولة جديد" (لا توست تجريبي)', /لا توجد حجوزات قادمة/.test(await page.textContent('#resEmpty')) && /حجز طاولة جديد/.test(await appText(page)));
    await page.click('[data-toggle-res-form]');
    await page.waitForSelector('#resForm');
    check('2) نموذج المطعم: التاريخ والوقت وعدد الأشخاص وملاحظة اختيارية (بلا نوع خدمة)',
      !!(await page.$('#resDate')) && !!(await page.$('#resTime')) && !!(await page.$('#resParty')) && !!(await page.$('#resNote')) && !(await page.$('#resService')));
    check('2) حدود التاريخ: من اليوم إلى 90 يوماً (بتوقيت الرياض)', (await page.getAttribute('#resDate', 'min')) === riyadhDate(0) && (await page.getAttribute('#resDate', 'max')) === riyadhDate(90));
    await page.click('#resSubmit');
    check('3) بلا تاريخ/وقت: رسالة واضحة ولا نداء للخادم', /اختر التاريخ والوقت/.test(await page.textContent('#resErr')) && (await page.evaluate(() => window.__TEST__.getCalls('create_reservation'))).length === 0);
    await page.fill('#resDate', riyadhDate(0));
    await page.fill('#resTime', '00:00');
    await page.click('#resSubmit');
    check('3) وقت مضى: رسالة الوقت ولا نداء', /بعد 15 دقيقة على الأقل/.test(await page.textContent('#resErr')) && (await page.evaluate(() => window.__TEST__.getCalls('create_reservation'))).length === 0);
    const day = riyadhDate(3);
    await page.fill('#resDate', day);
    await page.fill('#resTime', '20:00');
    await page.selectOption('#resParty', '4');
    await page.fill('#resNote', '  قرب النافذة <b>x</b>  ');
    await page.click('#resSubmit');
    await page.waitForSelector('#resList', { timeout: 3000 });
    const calls = await page.evaluate(() => window.__TEST__.getCalls('create_reservation'));
    const a = calls[0] && calls[0].args;
    check('3) الإرسال: create_reservation بمعرّف المتجر، والوقت المختار بتوقيت الرياض، و4 أشخاص، وملاحظة مقصوصة',
      calls.length === 1 && a.p_merchant_id === REST && a.p_scheduled_at === new Date(day + 'T20:00:00+03:00').toISOString() &&
      a.p_party_size === 4 && a.p_service_type === null && a.p_note === 'قرب النافذة <b>x</b>');
    const row = await page.textContent('#resList');
    check('3) يظهر الحجز فوراً "طاولة لـ 4 أشخاص" بحالة "بانتظار تأكيد المتجر"، مع رسالة تأكيد',
      /طاولة لـ 4 أشخاص/.test(row) && /بانتظار تأكيد المتجر/.test(row) && /بانتظار تأكيد المتجر/.test(await toastText(page)) && !(await page.$('#resForm')));
    check('3) وقت الحجز يُعرض بتوقيت المتجر (الرياض) لا توقيت الجهاز: ' + day.slice(8) + '/' + day.slice(5, 7) + ' - 8:00 م',
      row.includes(day.slice(8) + '/' + day.slice(5, 7) + ' - 8:00 م'));
    check('3) الملاحظة تُعرض نصاً (لا HTML)', /<b>x<\/b>/.test(row) && (await page.$('#resList b b')) === null);
    await context.close();
  }

  // 4) خطأ من الخادم: رسالة عربية والنموذج يبقى بقيمه
  {
    const { context, page } = await openApp(browser, baseScenario({ createReservationError: 'NOJ_BOOKING_LIMIT' }));
    await openBooking(page, REST);
    await page.click('[data-toggle-res-form]');
    await page.fill('#resDate', riyadhDate(2));
    await page.fill('#resTime', '19:30');
    await page.selectOption('#resParty', '3');
    await page.click('#resSubmit');
    await page.waitForSelector('#resErr');
    check('4) حد الحجوزات من الخادم: رسالة واضحة، والنموذج يبقى بقيمه لإعادة المحاولة',
      /3 حجوزات قادمة/.test(await page.textContent('#resErr')) && (await page.inputValue('#resTime')) === '19:30' && (await page.inputValue('#resParty')) === '3' && !(await page.$('#resList')));
    await context.close();
  }

  // 5) الخدمات: نوع الخدمة بدل عدد الأشخاص
  {
    const { context, page } = await openApp(browser, baseScenario());
    await openBooking(page, SERV);
    check('5) الخدمات: قسم "حجوزات" وزر "حجز خدمة جديد"', /حجوزات/.test(await appText(page)) && /حجز خدمة جديد/.test(await appText(page)));
    await page.click('[data-toggle-res-form]');
    check('5) نموذج الخدمات: نوع الخدمة بدل عدد الأشخاص', !!(await page.$('#resService')) && !(await page.$('#resParty')));
    await page.fill('#resDate', riyadhDate(1));
    await page.fill('#resTime', '10:00');
    await page.click('#resSubmit');
    check('5) نوع خدمة فارغ: رسالة ولا نداء', /اكتب نوع الخدمة/.test(await page.textContent('#resErr')) && (await page.evaluate(() => window.__TEST__.getCalls('create_reservation'))).length === 0);
    await page.fill('#resService', '  غسيل داخلي وخارجي ');
    await page.click('#resSubmit');
    await page.waitForSelector('#resList');
    const c = (await page.evaluate(() => window.__TEST__.getCalls('create_reservation')))[0].args;
    check('5) الإرسال: نوع الخدمة مقصوصاً، بلا عدد أشخاص ولا ملاحظة', c.p_service_type === 'غسيل داخلي وخارجي' && c.p_party_size === null && c.p_note === null && c.p_merchant_id === SERV);
    check('5) السطر يعرض نوع الخدمة', /غسيل داخلي وخارجي/.test(await page.textContent('#resList')));
    await context.close();
  }

  // 6-8) حجوزات قائمة: تُحمَّل عند الدخول، تُلغى عبر cancel_appointment، وتبقى ظاهرة إن أوقف التاجر الحجز
  {
    const sc = baseScenario();
    sc.tables.appointments.push(
      { id: 'r-1', user_id: PROFILE.id, merchant_id: REST, clinic_id: null, booking_kind: 'table', status: 'confirmed', scheduled_at: inDays(1), party_size: 2, service_type: null, note: null },
      { id: 'r-old', user_id: PROFILE.id, merchant_id: REST, clinic_id: null, booking_kind: 'table', status: 'confirmed', scheduled_at: inDays(-1), party_size: 5, service_type: null, note: null },
      { id: 'r-x', user_id: PROFILE.id, merchant_id: REST, clinic_id: null, booking_kind: 'table', status: 'cancelled', scheduled_at: inDays(4), party_size: 7, service_type: null, note: null },
      { id: 'r-p', user_id: PROFILE.id, merchant_id: PAUSED, clinic_id: null, booking_kind: 'table', status: 'pending', scheduled_at: inDays(3), party_size: 3, service_type: null, note: null },
      { id: 'r-only', user_id: PROFILE.id, merchant_id: 'm-new', clinic_id: null, booking_kind: 'service', status: 'pending', scheduled_at: inDays(5), party_size: null, service_type: 'تلميع', note: null },
    );
    sc.tables.merchants.push({ id: 'm-new', name: 'مركز التلميع', branch: null, type: 'خدمات', booking_enabled: true, queue_enabled: false });
    const { context, page } = await openApp(browser, sc);
    const q = (await page.evaluate(() => window.__TEST__.getQueries('appointments')))[0];
    check('6) الدخول يجلب حجوزات العميل القادمة فقط (طاولة/خدمة، بانتظار/مؤكَّد، من الآن)',
      !!q && JSON.stringify(q.filters.map((f) => [f.op, f.col])) === JSON.stringify([['eq', 'user_id'], ['in', 'booking_kind'], ['in', 'status'], ['gte', 'scheduled_at']]));
    await openBooking(page, REST);
    const list = await page.textContent('#resList');
    check('6) القائمة: الحجز المؤكَّد القادم فقط ("مؤكَّد")، بلا الماضي ولا الملغى', /طاولة لـ 2 شخصين/.test(list) && /مؤكَّد/.test(list) && !/5 أشخاص|7 أشخاص/.test(list));
    await page.click('[data-cancel-res="r-1"]');
    await page.waitForSelector('#resEmpty', { timeout: 3000 });
    const cc = await page.evaluate(() => window.__TEST__.getCalls('cancel_appointment'));
    check('7) "إلغاء" يستدعي cancel_appointment (نفس دالة مواعيد الصحي) ويزيل السطر', cc.length === 1 && cc[0].args.p_appointment_id === 'r-1' && /تم إلغاء الحجز/.test(await toastText(page)));
    await openBooking(page, PAUSED);
    const t = await appText(page);
    check('8) تاجر أوقف الحجوزات: الحجز القائم يبقى ظاهراً وقابلاً للإلغاء، بلا زر حجز جديد',
      /طاولة لـ 3 أشخاص/.test(t) && /بانتظار تأكيد المتجر/.test(t) && !!(await page.$('#resPaused')) && !(await page.$('[data-toggle-res-form]')) && !!(await page.$('[data-cancel-res="r-p"]')));
    await page.click('.nav button[data-tab="merchants"]');
    check('8) متجر لا علاقة للعميل به إلا حجز قائم يظهر في "متاجري"', !!(await page.$('[data-open-merchant="m-new"]')));
    await context.close();
  }
  {
    const sc = baseScenario();
    sc.tables.merchants.find((m) => m.id === PAUSED).booking_enabled = false;
    const { context, page } = await openApp(browser, sc);
    await page.click('.nav button[data-tab="merchants"]');
    await page.click('[data-open-merchant="' + PAUSED + '"]');
    await page.waitForTimeout(150);
    check('8) تاجر أوقف الحجوزات وبلا حجز قائم: لا قسم حجوزات أصلاً', (await page.$('[data-open-section="booking"]')) === null);
    await context.close();
  }

  // 9) فتح القسم يحدّث الحالة (المتجر قبل الطلب)
  {
    const sc = baseScenario();
    sc.tables.appointments.push({ id: 'r-2', user_id: PROFILE.id, merchant_id: REST, clinic_id: null, booking_kind: 'table', status: 'pending', scheduled_at: inDays(1), party_size: 2, service_type: null, note: null });
    const { context, page } = await openApp(browser, sc);
    await page.evaluate(() => { window.__NOJ_SCENARIO__.tables.appointments.find((a) => a.id === 'r-2').status = 'confirmed'; });
    await openBooking(page, REST);
    await page.waitForFunction(() => /مؤكَّد/.test((document.getElementById('resList') || {}).textContent || ''), null, { timeout: 3000 }).catch(() => {});
    check('9) فتح قسم الحجوزات يحدّث الحالة من الخادم (بانتظار ← مؤكَّد)', /مؤكَّد/.test(await page.textContent('#resList')) && !/بانتظار/.test(await page.textContent('#resList')));
    await context.close();
  }

  // 10-11) الصحي والمقهى بلا أي تغيير
  {
    const { context, page } = await openApp(browser, baseScenario());
    await page.click('.nav button[data-tab="merchants"]');
    await page.click('[data-open-merchant="' + HEALTH + '"]');
    await page.waitForSelector('[data-open-section="booking"]');
    check('10) الصحي: القسم باسمه "مواعيدي" كما كان', /مواعيدي/.test(await page.textContent('[data-open-section="booking"]')));
    await page.click('[data-open-section="booking"]');
    await page.waitForSelector('#apptList', { timeout: 3000 });
    const hq = (await page.evaluate(() => window.__TEST__.getQueries('appointments'))).find((x) => /clinics/.test(x.select || ''));
    check('10) الصحي: نفس استعلام المواعيد (clinics + confirmed) ونفس سطر الموعد بزري تعديل/إلغاء',
      hq && hq.select === 'id, scheduled_at, clinics(name, doctor_name)' && JSON.stringify(hq.filters.map((f) => [f.col, f.val])) === JSON.stringify([['merchant_id', HEALTH], ['user_id', PROFILE.id], ['status', 'confirmed']]) &&
      /عيادة الأسنان/.test(await page.textContent('#apptList')) && !!(await page.$('[data-edit-appt="h-1"]')) && !(await page.$('#resList, #resEmpty, [data-toggle-res-form]')));
    await page.click('[data-toggle-appt-picker]');
    await page.click('[data-book-clinic="c-1"]');
    check('10) الصحي: "حجز موعد جديد" يبقى توستاً تجريبياً، بلا create_reservation', /طلب حجز تجريبي/.test(await toastText(page)) && (await page.evaluate(() => window.__TEST__.getCalls('create_reservation'))).length === 0);
    await page.click('[data-cancel-appt="h-1"]');
    await page.waitForTimeout(200);
    check('10) الصحي: الإلغاء عبر cancel_appointment كما كان', (await page.evaluate(() => window.__TEST__.getCalls('cancel_appointment')))[0].args.p_appointment_id === 'h-1' && /تم إلغاء الموعد/.test(await toastText(page)));
    await openBooking(page, CAFE);
    check('11) المقهى بلا تغيير: الزر العام "احجز الآن" (توست تجريبي)، بلا نموذج حجز', !!(await page.$('[data-book="' + CAFE + '"]')) && !(await page.$('[data-toggle-res-form]')));
    await context.close();
  }

  await browser.close();
  console.log('\n=== INDEX E2E SUMMARY:', pass, 'passed,', fail, 'failed ===');
  if (failures.length) console.log('Failures:', JSON.stringify(failures, null, 2));
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => { console.error('FATAL:', e); process.exit(1); });
