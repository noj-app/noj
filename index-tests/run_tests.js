// NOJ — Playwright E2E tests for index.html (تطبيق نوج): the reservations
// screens for restaurants and services (supabase-migration-reservations.sql),
// the older health "مواعيدي" rows behaving as before, and real health booking
// (supabase-migration-health-appointments.sql, sections 16-21). Real Chromium,
// fake Supabase client (fake-supabase.js), zero live network — index.html is
// untouched except for the test hook it already has
// (window.__NOJ_SUPABASE_CLIENT__, see getSb()).
const { chromium } = require('playwright');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..');
const INDEX_URL = 'file://' + path.join(REPO_ROOT, 'index.html');
// the pre-installed Chromium: /opt/pw-browsers/chromium is the stable link (its build number changes
// between containers); NOJ_CHROMIUM_PATH overrides, and the old fixed path stays as a fallback.
const CHROMIUM_PATH = process.env.NOJ_CHROMIUM_PATH ||
  ['/opt/pw-browsers/chromium', '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].find((p) => require('fs').existsSync(p));
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
      merchant_services: [
        { id: 'svc-1', merchant_id: SERV, name: 'غسيل داخلي وخارجي', price: 45, is_active: true, booking_enabled: true, sort_order: 0 },
        { id: 'svc-2', merchant_id: SERV, name: 'تلميع', price: null, is_active: true, booking_enabled: true, sort_order: 1 },
        { id: 'svc-3', merchant_id: SERV, name: 'تظليل', price: 300, is_active: true, booking_enabled: false, sort_order: 2 },
        { id: 'svc-4', merchant_id: SERV, name: 'خدمة قديمة', price: 10, is_active: false, booking_enabled: true, sort_order: 3 },
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
  await page.addInitScript((s) => { window.__NOJ_SCENARIO__ = s; if (s.queuePollMs) window.__NOJ_QUEUE_POLL_MS__ = s.queuePollMs; }, scenario);
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
    // a page rule, not getComputedStyle: desktop Chromium's own UA sheet already makes date/time ltr,
    // the reversed placeholder only shows on Chrome Android — so the test checks our CSS sets it.
    const resDirs = await page.$$eval('#resDate,#resTime', (els) => els.map((e) => [...document.styleSheets].some((sh) => [...sh.cssRules].some((r) => r.style && r.style.direction === 'ltr' && e.matches(r.selectorText)))));
    check('2) خانتا التاريخ والوقت باتجاه ltr (لا "موي/رهش/ةنس" معكوسة على Chrome أندرويد)', resDirs.length === 2 && resDirs.every(Boolean));
    check('2) Safari (آيفون): dir="ltr" على خانتي التاريخ والوقت نفسيهما، وقاعدة تثبّت العنصر الداخلي للقيمة',
      (await page.$$eval('#resDate,#resTime', (els) => els.every((e) => e.getAttribute('dir') === 'ltr'))) && (await page.evaluate(() => [...document.styleSheets].some((sh) => [...sh.cssRules].some((r) => r.selectorText && r.selectorText.indexOf('-webkit-date-and-time-value') !== -1 && r.style.direction === 'ltr' && r.style.unicodeBidi === 'normal')))));
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
      a.p_party_size === 4 && a.p_service_id === null && a.p_note === 'قرب النافذة <b>x</b>');
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
    await page.waitForSelector('#resService', { timeout: 3000 });
    const opts = await page.$$eval('#resService option', (os) => os.map((o) => [o.value, o.textContent]));
    check('5) نموذج الخدمات: قائمة خدمات التاجر (لا نص حر ولا عدد أشخاص) — المفعّلة والمفتوحة للحجز فقط، بأسعارها',
      !(await page.$('#resParty')) && !(await page.$('input#resService')) &&
      JSON.stringify(opts) === JSON.stringify([['', 'اختر الخدمة'], ['svc-1', 'غسيل داخلي وخارجي — 45.00 ر.س'], ['svc-2', 'تلميع']]));
    const sq = (await page.evaluate(() => window.__TEST__.getQueries('merchant_services')))[0];
    check('5) الاستعلام: خدمات هذا التاجر المفعّلة والمفتوحة للحجز', sq && JSON.stringify(sq.filters.map((f) => [f.col, f.val])) === JSON.stringify([['merchant_id', SERV], ['is_active', true], ['booking_enabled', true]]));
    await page.fill('#resDate', riyadhDate(1));
    await page.fill('#resTime', '10:00');
    await page.click('#resSubmit');
    check('5) بلا خدمة مختارة: رسالة ولا نداء', /اختر الخدمة/.test(await page.textContent('#resErr')) && (await page.evaluate(() => window.__TEST__.getCalls('create_reservation'))).length === 0);
    await page.selectOption('#resService', 'svc-1');
    await page.click('#resSubmit');
    await page.waitForSelector('#resList');
    const c = (await page.evaluate(() => window.__TEST__.getCalls('create_reservation')))[0].args;
    check('5) الإرسال: معرّف الخدمة المختارة، بلا عدد أشخاص ولا ملاحظة', c.p_service_id === 'svc-1' && c.p_party_size === null && c.p_note === null && c.p_merchant_id === SERV && !('p_service_type' in c));
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
    // (كان توستاً تجريبياً حتى supabase-migration-health-appointments.sql — الحجز الحقيقي في 16-21 أدناه)
    check('10) الصحي: "حجز موعد جديد" يفتح نموذج الموعد الحقيقي (لا توست تجريبي)، بلا create_reservation',
      !!(await page.$('#apptForm')) && !/طلب حجز تجريبي/.test(await toastText(page)) && (await page.evaluate(() => window.__TEST__.getCalls('create_reservation'))).length === 0);
    await page.click('[data-cancel-appt="h-1"]');
    await page.waitForTimeout(200);
    check('10) الصحي: الإلغاء عبر cancel_appointment كما كان', (await page.evaluate(() => window.__TEST__.getCalls('cancel_appointment')))[0].args.p_appointment_id === 'h-1' && /تم إلغاء الموعد/.test(await toastText(page)));
    await openBooking(page, CAFE);
    check('11) المقهى بلا تغيير: الزر العام "احجز الآن" (توست تجريبي)، بلا نموذج حجز', !!(await page.$('[data-book="' + CAFE + '"]')) && !(await page.$('[data-toggle-res-form]')));
    await context.close();
  }

  // 12-15) سياسة الإلغاء (يحددها التاجر) وقائمة الخدمات
  {
    const sc = baseScenario();
    const rest = sc.tables.merchants.find((m) => m.id === REST);
    Object.assign(rest, { booking_cancel_allowed: true, booking_cancel_cutoff_hours: 24 });
    sc.tables.appointments.push(
      { id: 'r-far', user_id: PROFILE.id, merchant_id: REST, clinic_id: null, booking_kind: 'table', status: 'confirmed', scheduled_at: inDays(2), party_size: 2, service_type: null, note: null },
      { id: 'r-near', user_id: PROFILE.id, merchant_id: REST, clinic_id: null, booking_kind: 'table', status: 'pending', scheduled_at: inDays(0, 10), party_size: 4, service_type: null, note: null },
    );
    const { context, page } = await openApp(browser, sc);
    await openBooking(page, REST);
    await page.waitForSelector('[data-res-cancel-hint]', { timeout: 3000 }).catch(() => {});
    const far = await page.textContent('[data-res-row="r-far"]');
    const near = await page.textContent('[data-res-row="r-near"]');
    check('12) مهلة 24 ساعة: حجز بعد يومين له زر إلغاء ونص "حتى 24 ساعة قبل الموعد"؛ حجز بعد 10 ساعات بلا زر و"انتهت مهلة الإلغاء"',
      !!(await page.$('[data-cancel-res="r-far"]')) && /يمكن الإلغاء حتى 24 ساعة قبل الموعد/.test(far) &&
      !(await page.$('[data-cancel-res="r-near"]')) && /انتهت مهلة الإلغاء/.test(near));
    const pq = (await page.evaluate(() => window.__TEST__.getQueries('merchants'))).find((q) => /booking_cancel_allowed/.test(q.select || ''));
    check('12) سياسة الإلغاء تُقرأ من صف التاجر (قراءة منفصلة، أفضل جهد)', !!pq);
    await page.evaluate(() => { window.__NOJ_SCENARIO__.cancelError = 'NOJ_CANCEL_WINDOW_CLOSED'; });
    await page.click('[data-cancel-res="r-far"]');
    await page.waitForTimeout(200);
    check('13) رفض الخادم (المهلة انتهت أثناء فتح الصفحة): رسالة واضحة والحجز يبقى', /انتهت مهلة إلغاء هذا الحجز/.test(await toastText(page)) && !!(await page.$('[data-res-row="r-far"]')));
    await context.close();
  }
  {
    const sc = baseScenario();
    sc.tables.merchants.find((m) => m.id === REST).booking_cancel_allowed = false;
    sc.tables.appointments.push({ id: 'r-x2', user_id: PROFILE.id, merchant_id: REST, clinic_id: null, booking_kind: 'table', status: 'confirmed', scheduled_at: inDays(5), party_size: 2, service_type: null, note: null });
    const { context, page } = await openApp(browser, sc);
    await openBooking(page, REST);
    await page.waitForSelector('[data-res-cancel-hint]', { timeout: 3000 }).catch(() => {});
    check('14) التاجر منع الإلغاء: لا زر إلغاء، ونص "الإلغاء غير متاح لدى هذا المتجر"',
      !(await page.$('[data-cancel-res]')) && /الإلغاء غير متاح لدى هذا المتجر/.test(await page.textContent('[data-res-row="r-x2"]')));
    await context.close();
  }
  {
    const sc = baseScenario();
    sc.tables.merchant_services.forEach((v) => { v.booking_enabled = false; });
    const { context, page } = await openApp(browser, sc);
    await openBooking(page, SERV);
    await page.click('[data-toggle-res-form]');
    await page.waitForSelector('#resNoServices', { timeout: 3000 });
    check('15) لا خدمة مفتوحة للحجز: رسالة واضحة وبلا زر إرسال', /لا توجد خدمات متاحة للحجز حاليًا/.test(await page.textContent('#resNoServices')) && !(await page.$('#resSubmit')));
    await context.close();
  }
  {
    const { context, page } = await openApp(browser, baseScenario());
    await openBooking(page, SERV);
    await page.click('[data-toggle-res-form]');
    await page.waitForSelector('#resService', { timeout: 3000 });
    await page.fill('#resDate', riyadhDate(2));
    await page.fill('#resTime', '11:00');
    await page.selectOption('#resService', 'svc-1');
    // أغلق التاجر حجز هذه الخدمة بعد فتح النموذج
    await page.evaluate(() => { window.__NOJ_SCENARIO__.tables.merchant_services.find((v) => v.id === 'svc-1').booking_enabled = false; });
    await page.click('#resSubmit');
    await page.waitForSelector('#resErr', { timeout: 3000 });
    const opts = await page.$$eval('#resService option', (os) => os.map((o) => o.value));
    check('15) خدمة أُغلقت بعد فتح النموذج: رسالة "غير متاحة للحجز الآن" والقائمة تتحدّث (اختفت الخدمة)',
      /غير متاحة للحجز الآن/.test(await page.textContent('#resErr')) && JSON.stringify(opts) === JSON.stringify(['', 'svc-2']) && (await page.inputValue('#resTime')) === '11:00');
    await context.close();
  }

  // 16-21) المواعيد الصحية الحقيقية (supabase-migration-health-appointments.sql)
  const healthScenario = (extra) => {
    const sc = baseScenario(extra);
    sc.healthMerchantId = HEALTH;
    sc.clinics = [
      { clinic_id: 'c-1', clinic_name: 'عيادة الأسنان', doctor_name: 'د. سلطان', booking_enabled: true, now_serving: 3, waiting_count: 2, est_minutes: 10 },
      { clinic_id: 'c-2', clinic_name: 'عيادة الجلدية', doctor_name: 'د. نورة', booking_enabled: true, now_serving: 1, waiting_count: 0, est_minutes: 0 },
      { clinic_id: 'c-5', clinic_name: 'المختبر', doctor_name: null, booking_enabled: false, now_serving: null, waiting_count: 0, est_minutes: 0 },
    ];
    sc.tables.clinics = [
      { id: 'c-1', merchant_id: HEALTH, walk_in_enabled: false },
      { id: 'c-2', merchant_id: HEALTH, walk_in_enabled: true },
      { id: 'c-5', merchant_id: HEALTH, walk_in_enabled: true },
    ];
    return sc;
  };
  {
    const { context, page } = await openApp(browser, healthScenario(), 'America/New_York');
    await openBooking(page, HEALTH);
    await page.waitForSelector('#apptList', { timeout: 3000 });
    await page.click('[data-toggle-appt-picker]');
    const picker = await page.$$eval('[data-book-clinic]', (bs) => bs.map((b) => [b.getAttribute('data-book-clinic'), (b.querySelector('[data-clinic-mode]') || {}).textContent || '']));
    check('16) قائمة العيادات: المفتوحة للحجز فقط، مع نمط كل عيادة ("بموعد فقط" / "بموعد وبدون موعد")',
      JSON.stringify(picker) === JSON.stringify([['c-1', 'بموعد فقط'], ['c-2', 'بموعد وبدون موعد']]));
    await page.click('[data-book-clinic="c-1"]');
    await page.waitForSelector('#apptForm');
    check('17) اختيار عيادة يفتح نموذج الموعد: اسم العيادة والطبيب، التاريخ والوقت (ltr) وملاحظة',
      /عيادة الأسنان/.test(await page.textContent('#apptForm')) && /د\. سلطان/.test(await page.textContent('#apptForm')) &&
      !!(await page.$('#apptNote')) && (await page.getAttribute('#apptDate', 'min')) === riyadhDate(0) &&
      (await page.$$eval('#apptDate,#apptTime', (els) => els.every((e) => [...document.styleSheets].some((sh) => [...sh.cssRules].some((r) => r.style && r.style.direction === 'ltr' && e.matches(r.selectorText)))))));
    await page.click('#apptSubmit');
    check('17) بلا تاريخ/وقت: رسالة واضحة ولا نداء للخادم', /اختر التاريخ والوقت/.test(await page.textContent('#apptErr')) && (await page.evaluate(() => window.__TEST__.getCalls('create_appointment'))).length === 0);
    const day = riyadhDate(4);
    await page.fill('#apptDate', day);
    await page.fill('#apptTime', '09:30');
    await page.fill('#apptNote', '  ألم في الضرس  ');
    await page.click('#apptSubmit');
    await page.waitForSelector('#apptPendingList', { timeout: 3000 });
    const ca = await page.evaluate(() => window.__TEST__.getCalls('create_appointment'));
    check('17) الإرسال: create_appointment بالعيادة، والوقت بتوقيت الرياض (جهاز بتوقيت نيويورك)، والملاحظة مقصوصة — لا create_reservation',
      ca.length === 1 && ca[0].args.p_clinic_id === 'c-1' && ca[0].args.p_scheduled_at === new Date(day + 'T09:30:00+03:00').toISOString() &&
      ca[0].args.p_note === 'ألم في الضرس' && (await page.evaluate(() => window.__TEST__.getCalls('create_reservation'))).length === 0);
    const pend = await page.textContent('#apptPendingList');
    check('17) يظهر الموعد فوراً "بانتظار تأكيد العيادة" بوقت الرياض، مع رسالة تأكيد',
      /عيادة الأسنان/.test(pend) && /بانتظار تأكيد العيادة/.test(pend) && pend.includes(day.slice(8) + '/' + day.slice(5, 7) + ' - 9:30 ص') &&
      /بانتظار تأكيد العيادة/.test(await toastText(page)) && !(await page.$('#apptForm')));
    await page.click('[data-cancel-happt]');
    await page.waitForTimeout(200);
    const cc = await page.evaluate(() => window.__TEST__.getCalls('cancel_appointment'));
    check('18) إلغاء الطلب: نفس cancel_appointment، ويختفي السطر', cc.length === 1 && /^appt-new-/.test(cc[0].args.p_appointment_id) && !(await page.$('#apptPendingList')) && /تم إلغاء الموعد/.test(await toastText(page)));
    await context.close();
  }
  {
    const sc = healthScenario({ createAppointmentError: 'NOJ_CLINIC_BOOKING_CLOSED' });
    const { context, page } = await openApp(browser, sc);
    await openBooking(page, HEALTH);
    await page.waitForSelector('#apptList', { timeout: 3000 });
    await page.click('[data-toggle-appt-picker]');
    await page.click('[data-book-clinic="c-2"]');
    await page.fill('#apptDate', riyadhDate(2));
    await page.fill('#apptTime', '10:00');
    await page.click('#apptSubmit');
    await page.waitForSelector('#apptErr', { timeout: 3000 });
    check('18) عيادة أُغلق حجزها بعد فتح القائمة: رسالة واضحة والنموذج يبقى بقيمه', /لا تستقبل حجوزات الآن/.test(await page.textContent('#apptErr')) && (await page.inputValue('#apptTime')) === '10:00');
    await context.close();
  }
  {
    const sc = healthScenario();
    sc.tables.merchants.find((m) => m.id === HEALTH).booking_cancel_allowed = false;
    sc.tables.appointments.push(
      { id: 'h-app', user_id: PROFILE.id, merchant_id: HEALTH, clinic_id: 'c-2', booking_kind: 'appointment', status: 'confirmed', booked_in_app: true, scheduled_at: inDays(3), note: null, clinics: { name: 'عيادة الجلدية', doctor_name: 'د. نورة' } },
      { id: 'h-done', user_id: PROFILE.id, merchant_id: HEALTH, clinic_id: 'c-1', booking_kind: 'appointment', status: 'done', booked_in_app: true, scheduled_at: inDays(-5), attended_at: inDays(-5), note: null,
        clinics: { name: 'عيادة الأسنان', doctor_name: 'د. سلطان' }, invoices: { amount: 230, created_at: inDays(-5) }, queue_tickets: { ticket_number: 45 } });
    const { context, page } = await openApp(browser, sc);
    await openBooking(page, HEALTH);
    await page.waitForSelector('#apptHistory', { timeout: 3000 });
    const list = await page.textContent('#apptList');
    check('19) سياسة الإلغاء (نفس قواعد الحجوزات): موعد محجوز من التطبيق بلا زر إلغاء ومع السبب؛ الموعد الأقدم كما كان (تعديل/إلغاء)',
      /عيادة الجلدية/.test(list) && /مؤكَّد/.test(list) && /الإلغاء غير متاح/.test(list) && !(await page.$('[data-cancel-happt="h-app"]')) &&
      !!(await page.$('[data-edit-appt="h-1"]')) && !!(await page.$('[data-cancel-appt="h-1"]')));
    const hist = await page.textContent('#apptHistory');
    check('20) سجل المواعيد: الزيارة "حضر" مع رقم الدور والفاتورة المربوطة بها',
      /سجل المواعيد/.test(await appText(page)) && /حضر/.test(hist) && /رقم دورك: 45/.test(hist) && /الفاتورة: 230\.00 ر\.س/.test(hist));
    await context.close();
  }
  {
    // قبل تطبيق ملف المواعيد الصحية على الحي: القراءة الإضافية تفشل، والصفحة تبقى كما كانت
    const { context, page } = await openApp(browser, healthScenario({ failSelectContaining: 'booked_in_app' }));
    await openBooking(page, HEALTH);
    await page.waitForSelector('#apptList', { timeout: 3000 });
    await page.waitForTimeout(200);
    await page.click('[data-toggle-appt-picker]');
    check('21) قبل تطبيق الملف: قائمة المواعيد وزر الحجز يعملان، بلا سجل ولا خطأ ظاهر',
      /عيادة الأسنان/.test(await page.textContent('#apptList')) && (await page.$$('[data-book-clinic]')).length === 2 && !(await page.$('#apptHistory')));
    await context.close();
  }

  // 28-30) الأسماء الظاهرة للأقسام الستة (بقالة، تجزئة، مقهى، مطعم، صحي، خدمات) — القيم المخزّنة كما هي
  {
    const sc = baseScenario();
    sc.tables.invoices.push(inv('i-old', SERV, 'أخرى'));
    const { context, page } = await openApp(browser, sc);
    await page.evaluate(() => { S.tab = 'queue'; render(); });
    await page.waitForSelector('#bookList', { timeout: 3000 });
    const book = await page.textContent('#bookList');
    check('28) "احجز مسبقاً": صحي ومطعم ومقهى وخدمات — لا "صحة" ولا "مطاعم" ولا "مقاهي"',
      /صحي/.test(book) && /مطعم/.test(book) && /مقهى/.test(book) && /خدمات/.test(book) && !/صحة|مطاعم|مقاهي/.test(book));
    await page.fill('#bookQ', 'صحي');
    await page.waitForTimeout(100);
    check('28) البحث بالاسم الظاهر "صحي" يجد المركز الصحي', /مركز النور الطبي/.test(await page.textContent('#bookList')));
    await page.evaluate(() => { S.tab = 'invoices'; render(); });
    const invTxt = await page.textContent('#view');
    check('29) سجل الفواتير: شارات "مطعم/خدمات/صحي/مقهى"، و"أخرى" القديم يظهر "خدمات"',
      /مطعم/.test(invTxt) && /صحي/.test(invTxt) && /مقهى/.test(invTxt) && !/صحة|مطاعم|مقاهي|أخرى/.test(invTxt));
    await page.evaluate(() => { S.tab = 'spending'; render(); });
    const legend = await page.$$eval('.legend .lg b', (els) => els.map((e) => e.textContent));
    check('30) توزيع الإنفاق: الأسماء الستة المعتمدة، و"أخرى" القديم مجموع مع "خدمات" (لا تكرار)',
      legend.length > 0 && legend.filter((x) => x === 'خدمات').length === 1 && legend.includes('صحي') && legend.includes('مطعم') &&
      !legend.some((x) => /صحة|مطاعم|مقاهي|أخرى/.test(x)));
    check('30) القيم المخزّنة لم تتغيّر (category يبقى "مطاعم" و"أخرى"، type يبقى "صحة")',
      (await page.evaluate(() => INVOICES.some((i) => i.c === 'أخرى') && INVOICES.some((i) => i.c === 'مطاعم') && USER_MERCHANTS.some((m) => m.type === 'صحة'))));
    await context.close();
  }

  // 22-27) طابور العيادات الحي (supabase-migration-clinic-queue.sql): رقم دور حقيقي
  //        اليوم، "أمامك X" يتحدّث تلقائياً (Realtime على clinic_queue_state + استعلام احتياطي)
  const liveTicket = (over) => [Object.assign({ ticket_id: 'q-1', merchant_id: HEALTH, merchant_name: 'مركز النور الطبي', clinic_id: 'c-2',
    clinic_name: 'عيادة الجلدية', doctor_name: 'د. نورة', ticket_number: 7, status: 'waiting', ahead: 3, now_serving: 4 }, over || {})];
  const openQueue = async (page) => { await page.evaluate(() => { S.tab = 'queue'; render(); }); await page.waitForTimeout(100); };
  {
    const { context, page } = await openApp(browser, baseScenario({ myQueue: liveTicket() }));
    await openQueue(page);
    const card = (await page.$('[data-live-queue-card]')) ? await page.textContent('[data-live-queue-card]') : '';
    check('22) رقم دور حقيقي اليوم: بطاقة الدور بالرقم والعيادة وعدد من قبلك والرقم الحالي — بلا زر المحاكاة',
      /#7/.test(card) && /مركز النور الطبي - عيادة الجلدية/.test(card) && (await page.textContent('[data-q-ahead]')) === '3' &&
      (await page.textContent('[data-q-now]')) === '#4' && /يتحدّث تلقائياً/.test(card) && !(await page.$('#qbtn')));
    const chans = await page.evaluate(() => window.__TEST__.getChannels());
    check('22) يستمع لطابور عيادة التذكرة فقط (clinic_queue_state، clinic_id=eq.c-2) بعد setAuth صريح بتوكن الجلسة',
      chans.length === 1 && chans[0].filter.table === 'clinic_queue_state' && chans[0].filter.filter === 'clinic_id=eq.c-2' &&
      JSON.stringify(await page.evaluate(() => window.__TEST__.getSetAuthTokens())) === JSON.stringify(['fake']));
    await page.evaluate(() => { window.__NOJ_SCENARIO__.myQueue[0].ahead = 1; window.__NOJ_SCENARIO__.myQueue[0].now_serving = 6; window.__TEST__.pushQueueStateChange('c-2'); });
    await page.waitForFunction(() => document.querySelector('[data-q-ahead]') && document.querySelector('[data-q-ahead]').textContent === '1', null, { timeout: 3000 }).catch(() => {});
    check('23) تغيّر في الطابور (Realtime): "عدد الأشخاص قبلك" والرقم الحالي يتحدّثان تلقائياً بلا أي ضغطة',
      (await page.textContent('[data-q-ahead]')) === '1' && (await page.textContent('[data-q-now]')) === '#6');
    await page.evaluate(() => { window.__NOJ_SCENARIO__.myQueue[0].status = 'called'; window.__NOJ_SCENARIO__.myQueue[0].ahead = 0; window.__TEST__.pushQueueStateChange('c-2'); });
    await page.waitForSelector('[data-q-called]', { timeout: 3000 }).catch(() => {});
    check('24) نُودي على الرقم: "حان دورك الآن" مع اسم الطبيب', !!(await page.$('[data-q-called]')) && /حان دورك الآن/.test(await page.textContent('[data-live-queue-card]')) && /د\. نورة/.test(await page.textContent('[data-q-called]')));
    await page.evaluate(() => { window.__NOJ_SCENARIO__.myQueue = []; window.__TEST__.pushQueueStateChange('c-2'); });
    await page.waitForFunction(() => !document.querySelector('[data-live-queue-card]'), null, { timeout: 3000 }).catch(() => {});
    check('25) انتهى الدور (حضر/لم يحضر): تختفي بطاقة الدور الحي وتُغلق القناة',
      !(await page.$('[data-live-queue-card]')) && (await page.evaluate(() => window.__TEST__.getChannels()))[0].removed === true);
    await context.close();
  }
  {
    // القناة لا تعمل: الاستعلام الاحتياطي الدوري يحدّث الرقم
    const { context, page } = await openApp(browser, baseScenario({ myQueue: liveTicket(), channelStatus: 'CHANNEL_ERROR', queuePollMs: 150 }));
    await openQueue(page);
    await page.evaluate(() => { window.__NOJ_SCENARIO__.myQueue[0].ahead = 2; });
    await page.waitForFunction(() => document.querySelector('[data-q-ahead]') && document.querySelector('[data-q-ahead]').textContent === '2', null, { timeout: 3000 }).catch(() => {});
    check('26) انقطاع Realtime: الاستعلام الاحتياطي يحدّث "عدد الأشخاص قبلك" تلقائياً', (await page.textContent('[data-q-ahead]')) === '2');
    await context.close();
  }
  {
    // تغيّر عمداً (قرار: لا أرقام مختلقة): كان "صفحة الانتظار كما كانت (زر المحاكاة)". فشل القراءة ⇒ نفس الحالة الفارغة
    const { context, page } = await openApp(browser, baseScenario({ myQueueError: 'function get_my_queue_status() does not exist' }));
    await openQueue(page);
    check('27) بلا تذكرة حية / تعذّر القراءة: حالة فارغة "لا يوجد لديك رقم دور حالياً"، بلا زر محاكاة، بلا قناة',
      /لا يوجد لديك رقم دور حالياً/.test(await page.textContent('#queueEmpty')) && !(await page.$('#qbtn')) && !(await page.$('[data-live-queue-card]')) &&
      (await page.evaluate(() => window.__TEST__.getChannels())).length === 0);
    await context.close();
  }
  {
    // 27ب) لا تذكرة حية اليوم، وصف queue_tickets قديم "waiting" (رقم/موقع/وقت بلا مصدر حي) لا يظهر كأنه حالي
    const sc = baseScenario({ myQueue: [] });
    sc.tables.merchants.find((m) => m.id === HEALTH).queue_enabled = true;
    sc.clinics = sc.clinics.concat([{ clinic_id: 'c-2', clinic_name: 'عيادة الجلدية', doctor_name: 'د. نورة', booking_enabled: true, now_serving: 1, waiting_count: 0, est_minutes: 0 }]);
    sc.tables.queue_tickets = [{ user_id: PROFILE.id, ticket_number: 77, unit_name: 'عيادة قديمة', position: 3, est_minutes: 12, merchant_id: HEALTH, status: 'waiting', created_at: inDays(-9), merchants: { name: 'مركز النور الطبي' } }];
    const { context, page } = await openApp(browser, sc);
    await openQueue(page);
    const txt = await appText(page);
    check('27ب) الحالة الفارغة: لا رقم تجريبي ولا "أهدأ وقت لزيارة هذا الفرع" ولا وقت متوقع مختلق',
      !!(await page.$('#queueEmpty')) && !/أهدأ وقت|محاكاة|#77|#—|الوقت المتوقع/.test(txt) && !(await page.$('.qcard')));
    check('27ب) …وقسم "احجز مسبقاً" باقٍ للمتاجر التي تتيح الحجز', !!(await page.$('#bookList')));
    check('27ب) لا قراءة لـqueue_tickets القديمة إطلاقاً', (await page.evaluate(() => window.__TEST__.getQueries('queue_tickets'))).length === 0);
    // الوقت المتوقع في قائمة عيادات المركز: يظهر فقط حين يوجد تقدير فعلي (> 0)، لا "~0 دقيقة"
    await page.click('.nav button[data-tab="merchants"]');
    await page.click('[data-open-merchant="' + HEALTH + '"]');
    await page.waitForSelector('[data-open-section="queue"]', { timeout: 3000 });
    await page.click('[data-open-section="queue"]');
    await page.waitForFunction(() => /عيادة الأسنان/.test(document.getElementById('app').textContent) && /عيادة الجلدية/.test(document.getElementById('app').textContent), null, { timeout: 3000 }).catch(() => {});
    const qtxt = await appText(page);
    check('27ب) عيادات المركز: "~10 دقيقة" للعيادة التي لها تقدير، ولا "~0 دقيقة" لغيرها', /~10 دقيقة/.test(qtxt) && !/~0 دقيقة/.test(qtxt));
    await context.close();
  }

  // ===================== PR3: الرصيد الموحّد، القيد عند الاستبدال، الإرجاع، ولا أرقام مختلقة =====================
  // مفاتيح أشهر الرياض (الحالي والسابق) — الفواتير تُبنى نسبةً إليهما فلا يتعلق الاختبار بتاريخ التشغيل
  const riyadhMonth = (t) => { const p = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Riyadh', year: 'numeric', month: '2-digit' }).formatToParts(t); const g = {}; p.forEach((x) => { g[x.type] = x.value; }); return g.year + '-' + g.month; };
  const shiftMonth = (k, d) => { let y = +k.slice(0, 4), m = +k.slice(5, 7) - 1 + d; y += Math.floor(m / 12); m = ((m % 12) + 12) % 12; return y + '-' + String(m + 1).padStart(2, '0'); };
  const CUR = riyadhMonth(new Date()), PREV = shiftMonth(CUR, -1);
  const atMonth = (k, day) => new Date(k + '-' + String(day || 1).padStart(2, '0') + 'T12:00:00+03:00').toISOString();
  const riyadhDMY = (iso) => { const p = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Riyadh', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(iso)); const g = {}; p.forEach((x) => { g[x.type] = x.value; }); return g.day + '/' + g.month + '/' + g.year; };
  const invAt = (id, merchant, type, amount, at, extra) => Object.assign({ id, user_id: PROFILE.id, amount, category: type, items: [], created_at: at, merchant_id: merchant, merchants: { name: merchant === REST ? 'مطعم مذاق' : 'مقهى نجل', branch: null } }, extra || {});
  const REL1 = inDays(3), REL2 = inDays(6);
  function loyaltyScenario(over) {
    const sc = baseScenario(over);
    sc.tables.merchant_loyalty = [{ merchant_id: CAFE, user_id: PROFILE.id, points: 100, tier: 'برونزي', merchants: { name: 'مقهى نجل', type: 'مقاهي', branch: null, logo_color: null } }];
    sc.tables.rewards = [
      { id: 'rw-big', title: 'قهوة مجانية', cost_points: 120, merchant_id: CAFE, active: true, merchants: { name: 'مقهى نجل' } },
      { id: 'rw-small', title: 'كعكة', cost_points: 50, merchant_id: CAFE, active: true, merchants: { name: 'مقهى نجل' } },
    ];
    sc.tables.point_transactions = [
      { id: 'pt-1', user_id: PROFILE.id, merchant_id: CAFE, type: 'earn', points_delta: 25, intended_delta: null, status: 'pending', release_at: REL2, invoice_id: 'i-4', created_at: inDays(-1) },
      { id: 'pt-2', user_id: PROFILE.id, merchant_id: CAFE, type: 'earn', points_delta: 15, intended_delta: null, status: 'pending', release_at: REL1, invoice_id: 'i-4', created_at: inDays(-2) },
      { id: 'pt-3', user_id: PROFILE.id, merchant_id: CAFE, type: 'earn', points_delta: 30, intended_delta: null, status: 'cancelled', release_at: inDays(4), invoice_id: 'i-9', created_at: inDays(-3) },
      { id: 'pt-4', user_id: PROFILE.id, merchant_id: CAFE, type: 'refund_adjustment', points_delta: -20, intended_delta: -35, status: 'available', release_at: null, invoice_id: 'i-8', created_at: inDays(-4) },
      { id: 'pt-5', user_id: PROFILE.id, merchant_id: CAFE, type: 'redeem', points_delta: -50, intended_delta: null, status: 'available', release_at: null, invoice_id: null, created_at: inDays(-5) },
      { id: 'pt-6', user_id: PROFILE.id, merchant_id: CAFE, type: 'earn', points_delta: 170, intended_delta: null, status: 'available', release_at: null, invoice_id: 'i-7', created_at: inDays(-6) },
      // تاجر آخر: لا يدخل في رصيد المقهى
      { id: 'pt-x', user_id: PROFILE.id, merchant_id: REST, type: 'earn', points_delta: 999, intended_delta: null, status: 'pending', release_at: inDays(1), invoice_id: 'i-1', created_at: inDays(-1) },
    ];
    return sc;
  }
  async function openRewards(page, merchantId) {
    await page.click('.nav button[data-tab="loyalty"]');
    await page.click('[data-open-loyalty="' + merchantId + '"]');
    await page.waitForSelector('#rwHdrPts');
    await page.waitForSelector('#ptHist [data-pt-row], #ptHistEmpty, #ptHistErr', { timeout: 3000 }).catch(() => {});
  }
  {
    // 28-29) رقم واحد = المتاح (100) + المعلّق (15 + 25) = 140، بلا أي تفصيل أو ذكر للتعليق
    const { context, page } = await openApp(browser, loyaltyScenario({ redeemError: 'رصيد النقاط غير كافٍ لدى هذا التاجر' }));
    await page.click('.nav button[data-tab="loyalty"]');
    check('28) بطاقة الولاء: رصيد واحد موحّد 140 (المتاح 100 + المعلّق 40)', /140 نقطة/.test(await page.textContent('[data-open-loyalty="' + CAFE + '"]')));
    await page.click('[data-open-loyalty="' + CAFE + '"]');
    await page.waitForSelector('#rwHdrPts');
    check('28) صفحة مكافآت التاجر: نفس الرقم الموحّد 140', (await page.textContent('#rwHdrPts')).trim() === '140');
    const txt = await appText(page);
    check('28) لا تمييز ولا ذكر للتعليق في العرض (لا "معلّق"، ولا "يصبح متاحاً" قبل أي محاولة استبدال)', !/معل[ّ]?ق|تعليق|يصبح متاحاً/.test(txt));
    check('28) مكافأة 120 نقطة تبدو قابلة للاستبدال (الرصيد المعروض 140 يكفيها)', !(await page.$eval('[data-redeem="rw-big"]', (b) => b.disabled)));
    // 29) المتاح 100 لا يكفي: الخادم يرفض ⇒ رسالة القيد بتاريخ أقرب إتاحة (REL1 لا REL2)
    await page.click('[data-redeem="rw-big"]');
    await page.waitForSelector('#confirmRedeemBtn');
    await page.click('#confirmRedeemBtn');
    await page.waitForFunction(() => /يصبح متاحاً/.test(document.getElementById('toast-text').textContent), null, { timeout: 3000 }).catch(() => {});
    const t = await toastText(page);
    check('29) رفض الاستبدال لعدم كفاية المتاح: "جزء من نقاطك لدى مقهى نجل يصبح متاحاً للاستبدال في ' + riyadhDMY(REL1) + '" (أقرب تاريخ)',
      t === 'جزء من نقاطك لدى مقهى نجل يصبح متاحاً للاستبدال في ' + riyadhDMY(REL1));
    const q = (await page.evaluate(() => window.__TEST__.getQueries('point_transactions'))).filter((x) => x.select === 'release_at');
    check('29) تاريخ الإتاحة يُقرأ عند المحاولة فقط، لنفس التاجر وصفوفه المعلّقة',
      q.length === 1 && q[0].filters.some((f) => f.col === 'merchant_id' && f.val === CAFE) && q[0].filters.some((f) => f.col === 'status' && f.val === 'pending'));
    check('29) الرصيد المعروض لا يتغيّر بعد الرفض (140)', (await page.textContent('#rwHdrPts')).trim() === '140');
    await context.close();
  }
  {
    // 30) استبدال ناجح: redeem_reward تعيد المتاح الجديد (50) ⇒ المعروض 50 + 40 معلّق = 90
    const { context, page } = await openApp(browser, loyaltyScenario({ redeemPoints: 50 }));
    await openRewards(page, CAFE);
    await page.click('[data-redeem="rw-small"]');
    await page.click('#confirmRedeemBtn');
    await page.waitForFunction(() => document.getElementById('rwHdrPts') && document.getElementById('rwHdrPts').textContent.trim() === '90', null, { timeout: 3000 }).catch(() => {});
    check('30) استبدال ناجح: المعروض = المتاح الجديد 50 + المعلّق 40 = 90', (await page.textContent('#rwHdrPts')).trim() === '90' && /تم استبدال: كعكة/.test(await toastText(page)));
    await context.close();
  }
  {
    // 31) لا نقاط معلّقة: رفض عدم الكفاية ⇒ الرسالة العامة بلا تاريخ
    const sc = loyaltyScenario({ redeemError: 'رصيد النقاط غير كافٍ لدى هذا التاجر' });
    sc.tables.point_transactions = sc.tables.point_transactions.filter((r) => r.status !== 'pending');
    sc.tables.merchant_loyalty[0].points = 130;
    const { context, page } = await openApp(browser, sc);
    await openRewards(page, CAFE);
    check('31) بلا معلّق: الرصيد = المتاح وحده (130)', (await page.textContent('#rwHdrPts')).trim() === '130');
    await page.click('[data-redeem="rw-big"]');
    await page.click('#confirmRedeemBtn');
    await page.waitForFunction(() => /غير كافية/.test(document.getElementById('toast-text').textContent), null, { timeout: 3000 }).catch(() => {});
    check('31) …ورفض الخادم يعرض "غير كافية" بلا ذكر إتاحة لاحقة', /غير كافية/.test(await toastText(page)) && !/يصبح متاحاً/.test(await toastText(page)));
    await context.close();
  }
  {
    // 32) سجل النقاط: الكسب، الاستبدال، وسطرا الإرجاع (نقاط ملغاة، خصم بسبب إرجاع)
    const { context, page } = await openApp(browser, loyaltyScenario());
    await openRewards(page, CAFE);
    const rows = await page.$$eval('#ptHist [data-pt-row]', (els) => els.map((e) => ({ type: e.getAttribute('data-pt-row'), cancelled: e.hasAttribute('data-pt-cancelled'), text: e.textContent, amt: e.querySelector('[data-pt-amount]').textContent })));
    check('32) سجل النقاط: كل حركات هذا التاجر فقط (6)، الأحدث أولاً', rows.length === 6 && rows[0].amt === '+25 نقطة' && !rows.some((r) => /999/.test(r.text)));
    check('32) نقاط ملغاة بإرجاع (صف معلّق أُلغي): "نقاط ملغاة — فاتورة مُرجَعة"', rows.some((r) => r.cancelled && /نقاط ملغاة — فاتورة مُرجَعة/.test(r.text) && r.amt === 'ملغاة'));
    check('32) خصم بسبب إرجاع: سطر مستقل بالمخصوم فعلاً (−20)', rows.some((r) => r.type === 'refund_adjustment' && /خصم بسبب إرجاع/.test(r.text) && r.amt === '−20 نقطة'));
    check('32) الاستبدال والكسب: "استبدال مكافأة −50" و"نقاط فاتورة +170"', rows.some((r) => r.type === 'redeem' && r.amt === '−50 نقطة') && rows.some((r) => r.type === 'earn' && r.amt === '+170 نقطة'));
    check('32) الصفوف المعلّقة تظهر كسباً عادياً بلا تمييز', rows.filter((r) => r.type === 'earn' && !r.cancelled).every((r) => /نقاط فاتورة/.test(r.text)) && !/معل[ّ]?ق/.test(await page.textContent('#ptHist')));
    await context.close();
  }
  {
    // 32) السجل أفضل جهد: فشل قراءته لا يعطّل الصفحة
    const sc = loyaltyScenario({ failSelectContaining: 'intended_delta' });
    const { context, page } = await openApp(browser, sc);
    await openRewards(page, CAFE);
    check('32) تعذّر قراءة السجل: رسالة في قسمه فقط، والمكافآت والرصيد كما هي', !!(await page.$('#ptHistErr')) && (await page.textContent('#rwHdrPts')).trim() === '140' && !!(await page.$('[data-redeem="rw-small"]')));
    await context.close();
  }
  {
    // 33) الفواتير المُرجَعة: كاملة (status بلا refunded_amount = أقدم صيغة) وجزئية، مع الصافي
    const sc = baseScenario();
    sc.tables.invoices = [
      invAt('r-full', CAFE, 'مقاهي', 60, atMonth(CUR, 1), { status: 'refunded', refunded_amount: null }),
      invAt('r-part', CAFE, 'مقاهي', 50, atMonth(CUR, 1), { status: 'paid', refunded_amount: 20 }),
      invAt('r-none', CAFE, 'مقاهي', 40, atMonth(CUR, 1), { status: 'paid', refunded_amount: null }),
    ];
    const { context, page } = await openApp(browser, sc);
    await page.click('.tile[data-go="invoices"]');
    await page.waitForSelector('[data-inv="r-full"]');
    const badge = async (id) => { const el = await page.$('[data-inv="' + id + '"] [data-inv-refund]'); return el ? (await el.textContent()) : null; };
    check('33) فاتورة مُرجَعة بالكامل: شارة "مُرجَعة"، وجزئياً "مُرجَعة جزئياً"، وبلا إرجاع: لا شارة',
      (await badge('r-full')) === 'مُرجَعة' && (await badge('r-part')) === 'مُرجَعة جزئياً' && (await badge('r-none')) === null);
    await page.click('[data-inv="r-part"]');
    await page.waitForSelector('[data-inv-net]');
    check('33) تفاصيل الفاتورة الجزئية: المبلغ المُرجَع −20.00 والصافي 30.00', /المبلغ المُرجَع/.test(await page.textContent('[data-inv-refunded]')) && /−20\.00/.test(await page.textContent('[data-inv-refunded]')) && /30\.00/.test(await page.textContent('[data-inv-net]')));
    await page.click('#cls');
    await page.click('[data-inv="r-full"]');
    await page.waitForSelector('[data-inv-net]');
    check('33) تفاصيل المُرجَعة بالكامل: "مُرجَعة بالكامل" والصافي 0.00', /مُرجَعة بالكامل/.test(await page.textContent('[data-inv-refunded]')) && /0\.00/.test(await page.textContent('[data-inv-net]')));
    await page.click('#cls');
    await page.click('.nav button[data-tab="home"]');
    check('33) الإنفاق يُحسب بالصافي: هذا الشهر 0 + 30 + 40 = 70.00', (await page.getAttribute('#heroNum', 'data-target')) === '70');
    await context.close();
  }
  {
    // 34) الرئيسية: إنفاق هذا الشهر وتغيّره عن الشهر الماضي من الفواتير الفعلية، والمنحنى من أشهر حقيقية
    const sc = baseScenario();
    sc.tables.invoices = [
      invAt('c-1', CAFE, 'مقاهي', 100, atMonth(CUR, 1)), invAt('c-2', REST, 'مطاعم', 50, atMonth(CUR, 1)),
      invAt('p-1', CAFE, 'مقاهي', 100, atMonth(PREV, 15)),
      invAt('o-1', CAFE, 'مقاهي', 999, atMonth(shiftMonth(CUR, -9), 10)),
    ];
    const { context, page } = await openApp(browser, sc);
    await page.waitForSelector('#heroNum');
    check('34) "هذا الشهر" = فواتير الشهر الحالي فقط (150، لا كل الفواتير)', (await page.getAttribute('#heroNum', 'data-target')) === '150');
    check('34) التغيّر محسوب: 150 مقابل 100 ⇒ "أعلى من الشهر الماضي 50%"', /أعلى من الشهر الماضي\s*50%/.test(await page.textContent('.hero-delta')));
    check('34) المنحنى من بيانات حقيقية (شهران فيهما إنفاق) لا مسار ثابت', !!(await page.$('#heroSpark polyline')) && (await page.$$('.spark path')).length === 0);
    check('34) "فاتورة هذا الشهر" = عدد فواتير الشهر (2)', /^2 فاتورة هذا الشهر$/.test((await page.textContent('#homeInvCount')).trim()));
    check('34) لا قيمة 12% الثابتة', !/12%/.test(await appText(page)));
    // 38) تحليل المصروفات: أعمدة الأشهر الستة الحقيقية والملاحظات من الأرقام نفسها
    await page.click('.hero-btn');
    await page.waitForSelector('#trendBox');
    const bars = await page.$$eval('[data-trend-month]', (els) => els.map((e) => [e.getAttribute('data-trend-month'), e.getAttribute('title')]));
    check('38) الاتجاه الشهري: آخر ستة أشهر فعلية تنتهي بالشهر الحالي بمبالغها', bars.length === 6 && bars[5][0] === CUR && bars[5][1] === '150 ريال' && bars[4][0] === PREV && bars[4][1] === '100 ريال');
    const ins = await page.textContent('#insightsBox');
    check('38) "ماذا يقول NOJ؟" من الأرقام الفعلية (أعلى 50%، أكثر فئة مقهى 67%) بلا جمل ثابتة', /أعلى من الشهر الماضي بنسبة 50%/.test(ins) && /مقهى بنسبة 67%/.test(ins) && !/18%|43%|60 ريال/.test(ins));
    // 39) التقارير: ملخص الشهر الحالي + أكثر المتاجر زيارة بعدد الزيارات
    await page.click('.nav button[data-tab="reports"]');
    await page.waitForSelector('#monthSummary');
    check('39) ملخص الشهر: 150 ريال و2 فاتورة وأعلى فئة مقهى (67%)، بلا "وقت الانتظار الموفَّر"',
      /150 ريال/.test(await page.textContent('[data-rep-total]')) && (await page.textContent('[data-rep-count]')) === '2' && /مقهى \(67%\)/.test(await page.textContent('[data-rep-top]')) && !/الموفَّر|43%/.test(await appText(page)));
    check('39) أكثر المتاجر زيارة: بعدد الفواتير الفعلي', /1\. مقهى نجل\s*3 زيارات/.test(await page.textContent('#topMerchants')) && /2\. مطعم مذاق\s*1 زيارة/.test(await page.textContent('#topMerchants')));
    await context.close();
  }
  {
    // 35) لا إنفاق في الشهر الماضي ⇒ لا نسبة؛ شهر واحد فقط ⇒ لا منحنى
    const sc = baseScenario();
    sc.tables.invoices = [invAt('c-1', CAFE, 'مقاهي', 80, atMonth(CUR, 1))];
    const { context, page } = await openApp(browser, sc);
    await page.waitForSelector('#heroNum');
    check('35) بلا فواتير للشهر الماضي: لا سطر تغيّر إطلاقاً', !(await page.$('.hero-delta')) && (await page.getAttribute('#heroNum', 'data-target')) === '80');
    check('35) شهر واحد فيه إنفاق: لا منحنى', !(await page.$('.spark')));
    await context.close();
  }
  {
    // 35) فواتير قديمة فقط (يناير): هذا الشهر صفر، لا نسبة، لا منحنى، لا تحليل شهري ولا ملاحظات
    const { context, page } = await openApp(browser, baseScenario());
    await page.waitForSelector('#heroNum');
    check('35) فواتير قديمة فقط: هذا الشهر 0، بلا نسبة ولا منحنى، "0 فاتورة هذا الشهر"',
      (await page.getAttribute('#heroNum', 'data-target')) === '0' && !(await page.$('.hero-delta')) && !(await page.$('.spark')) && /^0 فاتورة هذا الشهر$/.test((await page.textContent('#homeInvCount')).trim()));
    // 36) لا تنبيهات مختلقة: لا قسم في الرئيسية، وصفحة التنبيهات حالة فارغة
    check('36) الرئيسية بلا قسم "التنبيهات" (لا أمثلة ثابتة)', !(await page.$('#homeAlerts')) && !/مطعم مذاق · 120\.50|بقي شخصان قبلك/.test(await appText(page)));
    await page.click('.hero-btn');
    await page.waitForSelector('.sec-head h2');
    check('35) تحليل المصروفات بلا بيانات حديثة: لا أعمدة شهرية ولا ملاحظات مختلقة', !(await page.$('#trendBox')) && !(await page.$('#insightsBox')) && !/مارس|أغسطس/.test(await appText(page)));
    await page.evaluate(() => { S.tab = 'alerts'; render(); });
    check('36) صفحة التنبيهات: حالة فارغة', /لا توجد تنبيهات/.test(await appText(page)));
    await page.evaluate(() => { S.tab = 'profile'; render(); });
    check('36) الملف الشخصي: لا بريد مختلق ولا "٤ متاجر محفوظة"، وفواتير الشهر 0', !/ahmed@noj\.app|٤ متاجر|المنزل، العمل/.test(await appText(page)) && (await page.textContent('[data-prof-count]')) === '0');
    await context.close();
  }
  {
    // 37) التحية: الاسم الافتراضي 'عميل NOJ' ليس اسماً ⇒ "مرحباً 👋"؛ اسم حقيقي ⇒ أول كلمة منه
    const { context, page } = await openApp(browser, baseScenario({ profile: Object.assign({}, PROFILE, { name: 'عميل NOJ' }) }));
    check('37) بلا اسم (عميل NOJ): "مرحباً 👋" بلا "عميل"', (await page.textContent('#greetTitle')).trim() === 'مرحباً 👋');
    await context.close();
    const b = await openApp(browser, baseScenario({ profile: Object.assign({}, PROFILE, { name: '' }) }));
    check('37) اسم فارغ: "مرحباً 👋"', (await b.page.textContent('#greetTitle')).trim() === 'مرحباً 👋');
    await b.context.close();
    const c = await openApp(browser, baseScenario({ profile: Object.assign({}, PROFILE, { name: 'سارة أحمد' }) }));
    check('37) اسم حقيقي: "مرحباً سارة 👋"', (await c.page.textContent('#greetTitle')).trim() === 'مرحباً سارة 👋');
    await c.context.close();
  }

  await browser.close();
  console.log('\n=== INDEX E2E SUMMARY:', pass, 'passed,', fail, 'failed ===');
  if (failures.length) console.log('Failures:', JSON.stringify(failures, null, 2));
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => { console.error('FATAL:', e); process.exit(1); });
