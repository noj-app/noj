// NOJ — Playwright E2E tests for kiosk.html stage 3 (live POS capture).
// Real Chromium (pre-cached in this environment), fake Supabase client
// (fake-supabase.js), zero live network — kiosk.html itself is untouched
// except for two test-only hooks it already documents in its own comments
// (window.__NOJ_SUPABASE_CLIENT__, window.__NOJ_POLL_MS__).
const { chromium } = require('playwright');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..');
const KIOSK_URL = 'file://' + path.join(REPO_ROOT, 'kiosk.html');
const CHROMIUM_PATH = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const FAKE_SB_PATH = path.join(__dirname, 'fake-supabase.js');

let pass = 0, fail = 0;
const failures = [];
function check(label, cond) {
  if (cond) { pass++; console.log('PASS -', label); }
  else { fail++; failures.push(label); console.log('FAIL -', label); }
}

function baseScenario(overrides) {
  return Object.assign({
    deviceAuthId: 'device-auth-1',
    deviceRow: { id: 'device-1', branch_id: 'branch-1', pairing_code: null },
    branchRow: { merchant_id: 'merchant-1' },
    merchantRow: { name: 'مطعم تجريبي', type: 'مطاعم', points_rate: 1 },
    branchSettingsRow: {
      sector_code: 'restaurant', biz_name: 'مطعم تجريبي', biz_branch: 'فرع الاختبار',
      biz_slogan: '', biz_logo: '', show_menu_btn: false, menu_images: [], card_toggles: {}, dark_mode: false,
    },
    pendingTxns: [],
    claimResults: {},
    initialChannelStatus: 'SUBSCRIBED',
  }, overrides);
}

async function openKiosk(browser, { mode, scenario, pollMs, dbMode, localMode }) {
  const context = await browser.newContext();
  const page = await context.newPage();
  // no live network at all — fail fast instead of waiting out real timeouts
  // (Turnstile script, the esm.sh supabase-js fallback import — never
  // actually reached since window.__NOJ_SUPABASE_CLIENT__ short-circuits
  // getSb(), but blocked defensively regardless).
  await page.route('**://challenges.cloudflare.com/**', (route) => route.abort());
  await page.route('**://esm.sh/**', (route) => route.abort());

  // pos_mode على صف branch_settings هو المصدر الرسمي الآن (applyBranchSettingsToLocal
  // تكتب SETTINGS.mode منه في كل إقلاع) — افتراضياً يطابق mode (أغلب الاختبارات لا
  // تهتم بالفرق بين القيمة المحلية والمحفوظة)؛ dbMode/localMode يسمحان لاختبار محدَّد
  // بمحاكاة قيمتين مختلفتين عمداً (جهاز جديد محلياً demo، فرعه فعلياً live).
  const scenarioWithMode = Object.assign({}, scenario, {
    branchSettingsRow: Object.assign({}, scenario.branchSettingsRow, { pos_mode: dbMode || mode }),
  });

  await page.addInitScript((settings) => {
    localStorage.setItem('noj_kiosk_settings', JSON.stringify(settings));
  }, { mode: localMode || mode });
  await page.addInitScript((s) => {
    window.__NOJ_SCENARIO__ = s;
  }, scenarioWithMode);
  if (pollMs) {
    await page.addInitScript((ms) => { window.__NOJ_POLL_MS__ = ms; }, pollMs);
  }
  await page.addInitScript({ path: FAKE_SB_PATH });

  await page.goto(KIOSK_URL);
  await page.waitForSelector('.idle', { timeout: 5000 });
  return { context, page };
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function waitForCheckout(page, timeout) {
  try { await page.waitForSelector('.nfc', { timeout: timeout || 3000 }); return true; }
  catch (e) { return false; }
}
async function waitForIdle(page, timeout) {
  try { await page.waitForSelector('.idle', { timeout: timeout || 3000 }); return true; }
  catch (e) { return false; }
}

async function enterPhoneAndConfirm(page, phone) {
  await page.click('#openPad');
  await page.waitForSelector('#confirm');
  for (const digit of phone) {
    await page.click('[data-k="' + digit + '"]');
  }
  await page.click('#confirm');
}

async function openAdminSettingsViaPin(page, pin) {
  await page.evaluate(() => window.openPinScreen());
  await page.waitForSelector('#pinDots');
  for (const digit of pin) {
    await page.click('[data-pk="' + digit + '"]');
  }
  await page.waitForSelector('#adminBox', { timeout: 3000 });
}

(async () => {
  const browser = await chromium.launch({ executablePath: CHROMIUM_PATH });

  // =========================================================================
  // 1) وصول عملية حقيقية عبر Realtime — انتقال تلقائي من الانتظار إلى شاشة
  //    الطلب بمبلغها الحقيقي (لا invoiceAmount من القالب).
  // =========================================================================
  {
    const scenario = baseScenario({});
    const { context, page } = await openKiosk(browser, { mode: 'live', scenario });
    await page.evaluate((row) => window.__TEST__.pushRealtimeInsert(row), {
      id: 'txn-1', branch_id: 'branch-1', amount: '42.50', vat: '2.13',
      status: 'pending', expires_at: new Date(Date.now() + 5 * 60000).toISOString(),
    });
    const reached = await waitForCheckout(page);
    check('1) وصول عملية Realtime: ينتقل تلقائياً لشاشة الطلب', reached);
    const amountText = reached ? await page.textContent('.inv-chip b') : '';
    check('1) المبلغ المعروض هو المبلغ الحقيقي من العملية (42.50)، لا قيمة القالب الثابتة', /42\.50/.test(amountText));
    await context.close();
  }

  // =========================================================================
  // 2) عميل مسجّل — kiosk_claim_pos_transaction تُرجع is_registered=true
  //    ونقاطاً حقيقية.
  // =========================================================================
  {
    const scenario = baseScenario({
      claimResults: {
        'txn-2': { row: { is_registered: true, profile_id: 'p1', prev_points: 100, added_points: 42, total_points: 142, invoice_id: 'inv-1' } },
      },
    });
    const { context, page } = await openKiosk(browser, { mode: 'live', scenario });
    await page.evaluate((row) => window.__TEST__.pushRealtimeInsert(row), {
      id: 'txn-2', branch_id: 'branch-1', amount: '42.00', vat: '0',
      status: 'pending', expires_at: new Date(Date.now() + 5 * 60000).toISOString(),
    });
    check('2) وصلت العملية', await waitForCheckout(page));
    await enterPhoneAndConfirm(page, '512345678');
    await page.waitForSelector('.ok-in', { timeout: 3000 }).catch(() => {});
    const h2 = await page.textContent('.ok-in h2').catch(() => '');
    check('2) شاشة النجاح تظهر بعد ربط عميل مسجَّل', h2 === 'تم الربط بنجاح');
    const ptsText = await page.textContent('.g-pts-total').catch(() => '');
    check('2) إجمالي النقاط المعروض هو الرصيد الحقيقي من الخادم (142)، لا تقدير محلي', /142/.test(ptsText));
    const breakdown = await page.textContent('.g-pts-break').catch(() => '');
    check('2) تفصيل الرصيد يطابق الاستجابة الحقيقية (سابق 100 + مضاف 42)', /100/.test(breakdown) && /42/.test(breakdown));
    await context.close();
  }

  // =========================================================================
  // 3) عميل غير مسجَّل — رسالة حفظ واضحة بدل أي بطاقة نقاط/رصيد.
  // =========================================================================
  {
    const scenario = baseScenario({
      claimResults: {
        'txn-3': { row: { is_registered: false, profile_id: null, prev_points: null, added_points: 15, total_points: null, invoice_id: 'inv-2' } },
      },
    });
    const { context, page } = await openKiosk(browser, { mode: 'live', scenario });
    await page.evaluate((row) => window.__TEST__.pushRealtimeInsert(row), {
      id: 'txn-3', branch_id: 'branch-1', amount: '15.00', vat: '0',
      status: 'pending', expires_at: new Date(Date.now() + 5 * 60000).toISOString(),
    });
    check('3) وصلت العملية', await waitForCheckout(page));
    await enterPhoneAndConfirm(page, '599999999');
    await page.waitForSelector('.ok-in', { timeout: 3000 }).catch(() => {});
    const h2 = await page.textContent('.ok-in h2').catch(() => '');
    check('3) عميل غير مسجَّل: رسالة "حُفظت فاتورتك" بدل "تم الربط بنجاح"', h2 === 'حُفظت فاتورتك');
    const p = await page.textContent('.ok-in p').catch(() => '');
    check('3) الرسالة تذكر التسجيل في تطبيق NOJ لاستلام الفاتورة والنقاط', /سجّل/.test(p) && /NOJ/.test(p));
    const hasPtsCard = await page.$('.g-pts-total');
    check('3) لا بطاقة رصيد/نقاط مزيَّفة تظهر لعميل غير مسجَّل', hasPtsCard === null);
    await context.close();
  }

  // =========================================================================
  // 3ب) عملية ثانية تصل أثناء عرض الأولى: لا تقاطعها، وتُعرَض تلقائياً بعد
  //     انتهاء الأولى (من الطابور، عبر renderIdle→checkLiveQueueForNext).
  // =========================================================================
  {
    const scenario = baseScenario({
      claimResults: { 'txn-a': { row: { is_registered: true, profile_id: 'p', prev_points: 0, added_points: 5, total_points: 5, invoice_id: 'i' } } },
    });
    const { context, page } = await openKiosk(browser, { mode: 'live', scenario });
    await page.evaluate((row) => window.__TEST__.pushRealtimeInsert(row), {
      id: 'txn-a', branch_id: 'branch-1', amount: '10.00', vat: '0', status: 'pending',
      expires_at: new Date(Date.now() + 5 * 60000).toISOString(),
    });
    check('3ب) العملية A وصلت وتُعرَض', await waitForCheckout(page));
    await page.evaluate((row) => window.__TEST__.pushRealtimeInsert(row), {
      id: 'txn-b', branch_id: 'branch-1', amount: '20.00', vat: '0', status: 'pending',
      expires_at: new Date(Date.now() + 5 * 60000).toISOString(),
    });
    const amountStillA = await page.textContent('.inv-chip b');
    check('3ب) وصول عملية ثانية أثناء عرض الأولى لا يقاطعها (لا يزال مبلغ A ظاهراً)', /10\.00/.test(amountStillA));
    const queued = await page.evaluate(() => window.LIVE_TXN_QUEUE.map(function (r) { return r.id; }));
    check('3ب) العملية الثانية محفوظة في الطابور بانتظار دورها', queued.indexOf('txn-b') !== -1);

    await enterPhoneAndConfirm(page, '512345678');
    await page.waitForSelector('.ok-in', { timeout: 3000 }).catch(() => {});
    // بدل انتظار مؤقّت النجاح الفعلي (10 ثوانٍ حقيقية)، نستدعي نفس مسار
    // "العودة لشاشة الانتظار" الذي يستدعيه ذلك المؤقّت بالضبط عند انتهائه
    // (S.page='idle';render() — نفس الكود الحقيقي تماماً، فقط بلا الانتظار).
    await page.evaluate(() => { window.S.page = 'idle'; window.render(); });
    const showsB = await waitForCheckout(page, 2000);
    check('3ب) بعد انتهاء العملية الأولى، الثانية تُعرَض تلقائياً من الطابور', showsB);
    const amountB = showsB ? await page.textContent('.inv-chip b') : '';
    check('3ب) المبلغ المعروض الآن هو مبلغ العملية الثانية (20.00)', /20\.00/.test(amountB));
    await context.close();
  }

  // =========================================================================
  // 4) انتهاء الصلاحية قبل أي تفاعل — رجوع تلقائي لشاشة الانتظار، بلا أي
  //    محاولة ربط.
  // =========================================================================
  {
    const scenario = baseScenario({});
    const { context, page } = await openKiosk(browser, { mode: 'live', scenario });
    await page.evaluate((row) => window.__TEST__.pushRealtimeInsert(row), {
      id: 'txn-4', branch_id: 'branch-1', amount: '9.00', vat: '0',
      status: 'pending', expires_at: new Date(Date.now() + 1200).toISOString(),
    });
    check('4) وصلت العملية', await waitForCheckout(page));
    const backToIdle = await waitForIdle(page, 4000);
    check('4) بعد انتهاء صلاحية العملية (expires_at) يعود الجهاز تلقائياً لشاشة الانتظار', backToIdle);
    await context.close();
  }

  // =========================================================================
  // 5) انقطاع Realtime مع الاستعلام الاحتياطي — بعد فشل القناة، تُلتقَط
  //    عملية جديدة عبر الاستطلاع الدوري بدل البقاء معلَّقة للأبد.
  // =========================================================================
  {
    const scenario = baseScenario({ pendingTxns: [] });
    const { context, page } = await openKiosk(browser, { mode: 'live', scenario, pollMs: 300 });
    await page.evaluate(() => window.__TEST__.setChannelStatus('CHANNEL_ERROR'));
    await sleep(200);
    await page.evaluate((row) => window.__TEST__.setPendingTxns([row]), {
      id: 'txn-5', branch_id: 'branch-1', amount: '77.00', vat: '0',
      status: 'pending', expires_at: new Date(Date.now() + 5 * 60000).toISOString(),
    });
    const reached = await waitForCheckout(page, 3000);
    check('5) بعد انقطاع Realtime (CHANNEL_ERROR)، الاستعلام الاحتياطي الدوري يلتقط العملية', reached);
    const amountText = reached ? await page.textContent('.inv-chip b') : '';
    check('5) المبلغ المعروض من العملية الملتقَطة عبر الاستطلاع صحيح (77.00)', /77\.00/.test(amountText));
    await context.close();
  }

  // =========================================================================
  // 6) الوضع التجريبي لم يتغيّر إطلاقاً: زر "التالي (تجربة)" يعمل كما كان
  //    بمبلغ القالب الثابت، ويختفي تماماً في الوضع المباشر.
  // =========================================================================
  {
    const scenario = baseScenario({});
    const { context, page } = await openKiosk(browser, { mode: 'demo', scenario });
    const devBtn = await page.$('#idleDevNext');
    check('6) زر "التالي (تجربة)" ظاهر في الوضع التجريبي', devBtn !== null);
    await page.click('#idleDevNext');
    const reached = await waitForCheckout(page);
    check('6) الوضع التجريبي: الزر ينقل لشاشة الطلب كما كان', reached);
    const amountText = reached ? await page.textContent('.inv-chip b') : '';
    check('6) الوضع التجريبي: المبلغ المعروض هو قيمة القالب الثابتة (86.00 لمطعم مذاق)، لا أي قيمة عملية حقيقية', /86\.00/.test(amountText));
    // الوضع التجريبي لم يتغيّر: بطاقات okItems الإضافية (رقم طلبك — كان "رقم
    // طاولتك" قبل أن يصير المطعم كالمقهى تماماً، قرار معتمد) تبقى
    // ظاهرة في شاشة النجاح كما كانت قبل إخفائها في الوضع المباشر فقط.
    await enterPhoneAndConfirm(page, '512345678');
    await page.waitForSelector('.ok-in', { timeout: 3000 }).catch(() => {});
    const gotText = await page.textContent('.got').catch(() => '');
    check('6) الوضع التجريبي: بطاقة "رقم طلبك" لا تزال ظاهرة في شاشة النجاح (لم تُخفَ، فقط الوضع المباشر)', /رقم طلبك/.test(gotText) && !/رقم طاولتك/.test(gotText));
    await context.close();
  }
  {
    const scenario = baseScenario({});
    const { context, page } = await openKiosk(browser, { mode: 'live', scenario });
    const devBtn = await page.$('#idleDevNext');
    check('6) زر "التالي (تجربة)" غائب تماماً في الوضع المباشر', devBtn === null);
    await context.close();
  }

  // =========================================================================
  // 7) تأكيد أن العملية تصل عبر قناة Realtime نفسها لا عبر الاستعلام
  //    الاحتياطي — القناة SUBSCRIBED منذ البداية، فيجب ألا يُستدعى
  //    pollForPendingTxn() إطلاقاً (العدّاد المخصَّص في fake-supabase.js).
  // =========================================================================
  {
    const scenario = baseScenario({ initialChannelStatus: 'SUBSCRIBED' });
    const { context, page } = await openKiosk(browser, { mode: 'live', scenario });
    await sleep(100); // تأكيد استقرار حالة SUBSCRIBED قبل إرسال الحدث
    const pollBefore = await page.evaluate(() => window.__TEST__.getPollCount());
    check('7) القناة SUBSCRIBED: لا استعلام احتياطي قبل أي حدث', pollBefore === 0);
    await page.evaluate((row) => window.__TEST__.pushRealtimeInsert(row), {
      id: 'txn-7', branch_id: 'branch-1', amount: '33.00', vat: '0',
      status: 'pending', expires_at: new Date(Date.now() + 5 * 60000).toISOString(),
    });
    const reached = await waitForCheckout(page);
    check('7) العملية وصلت والقناة لا تزال SUBSCRIBED', reached);
    const amountText = reached ? await page.textContent('.inv-chip b') : '';
    check('7) المبلغ صحيح (33.00)', /33\.00/.test(amountText));
    const pollAfter = await page.evaluate(() => window.__TEST__.getPollCount());
    check('7) لم يُستدعَ الاستعلام الاحتياطي إطلاقاً — الالتقاط عبر Realtime فعلياً لا عبر poll', pollAfter === 0);
    await context.close();
  }

  // =========================================================================
  // 8) تشخيص الإعدادات: سطر حالة Realtime ووقت آخر حدث يظهر في شاشة
  //    إعدادات الجهاز بلا أي بيانات عميل.
  // =========================================================================
  {
    const scenario = baseScenario({ initialChannelStatus: 'SUBSCRIBED', adminPin: '1234' });
    const { context, page } = await openKiosk(browser, { mode: 'live', scenario });
    await sleep(100);
    await openAdminSettingsViaPin(page, '1234');
    const diagBefore = await page.textContent('#rtDiagLine').catch(() => '');
    check('8) سطر التشخيص يظهر حالة "متصل" قبل أي حدث', /متصل/.test(diagBefore));
    check('8) سطر التشخيص يظهر "لم يصل بعد" قبل أي حدث Realtime', /لم يصل بعد/.test(diagBefore));
    await page.evaluate((row) => window.__TEST__.pushRealtimeInsert(row), {
      id: 'txn-8', branch_id: 'branch-1', amount: '11.00', vat: '0',
      status: 'pending', expires_at: new Date(Date.now() + 5 * 60000).toISOString(),
    });
    await waitForCheckout(page);
    // سطر التشخيص يتحدَّث كل ثانيتين (startRtDiagTimer) — ننتظره بدل إعادة
    // بنائه يدوياً، للتأكد أن التحديث الدوري نفسه يعمل لا فقط العرض الأول.
    await page.waitForFunction(() => {
      var el = document.getElementById('rtDiagLine');
      return el && !/لم يصل بعد/.test(el.textContent);
    }, { timeout: 4000 }).catch(() => {});
    const diagAfter = await page.textContent('#rtDiagLine').catch(() => '');
    check('8) سطر التشخيص يُحدَّث بوقت آخر حدث Realtime فعلي بعد وصوله', !/لم يصل بعد/.test(diagAfter));
    check('8) سطر التشخيص لا يحتوي أي رقم جوال أو بيانات عميل', !/\d{9}/.test(diagAfter));
    await context.close();
  }

  // =========================================================================
  // 9) تجديد توكن الجلسة (TOKEN_REFRESHED): يُمرَّر التوكن الجديد لـ
  //    Realtime (realtime.setAuth) وتُعاد إعادة الاشتراك بقناة جديدة —
  //    لا الاعتماد وحده على الربط الداخلي الضمني في supabase-js.
  // =========================================================================
  {
    const scenario = baseScenario({ initialChannelStatus: 'SUBSCRIBED' });
    const { context, page } = await openKiosk(browser, { mode: 'live', scenario });
    await sleep(100);
    const channelsBefore = await page.evaluate(() => window.__TEST__.getChannelCreateCount());
    await page.evaluate(() => window.__TEST__.triggerTokenRefresh('fresh-token-123'));
    await sleep(100);
    const setAuthCalls = await page.evaluate(() => window.__TEST__.getSetAuthCalls());
    check('9) تجديد التوكن يُمرَّر فوراً لـ realtime.setAuth()', setAuthCalls.indexOf('fresh-token-123') !== -1);
    const channelsAfter = await page.evaluate(() => window.__TEST__.getChannelCreateCount());
    check('9) تجديد التوكن يُعيد إنشاء اشتراك Realtime من جديد (قناة جديدة)', channelsAfter > channelsBefore);
    // بعد إعادة الاشتراك، لا تزال العمليات الجديدة تصل بلا مشكلة
    await page.evaluate((row) => window.__TEST__.pushRealtimeInsert(row), {
      id: 'txn-9', branch_id: 'branch-1', amount: '19.00', vat: '0',
      status: 'pending', expires_at: new Date(Date.now() + 5 * 60000).toISOString(),
    });
    const reached = await waitForCheckout(page);
    check('9) العملية لا تزال تُلتقَط بعد إعادة الاشتراك', reached);
    await context.close();
  }

  // =========================================================================
  // 10) الوضع المباشر: شاشة النجاح لا تعرض "رقم دورك"/"موعدك القادم" (بلا
  //     مصدر حقيقي) — تبقى فقط "فاتورتك" ونقاط الولاء.
  // =========================================================================
  {
    const scenario = baseScenario({
      branchSettingsRow: {
        sector_code: 'medical', biz_name: 'مركز اختبار', biz_branch: 'فرع الاختبار',
        biz_slogan: '', biz_logo: '', show_menu_btn: false, menu_images: [], card_toggles: {}, dark_mode: false,
      },
      claimResults: { 'txn-10': { row: { is_registered: true, profile_id: 'p', prev_points: 0, added_points: 5, total_points: 5, invoice_id: 'i' } } },
    });
    const { context, page } = await openKiosk(browser, { mode: 'live', scenario });
    await page.evaluate((row) => window.__TEST__.pushRealtimeInsert(row), {
      id: 'txn-10', branch_id: 'branch-1', amount: '10.00', vat: '0', status: 'pending',
      expires_at: new Date(Date.now() + 5 * 60000).toISOString(),
    });
    check('10) وصلت العملية', await waitForCheckout(page));
    await enterPhoneAndConfirm(page, '512345678');
    await page.waitForSelector('.ok-in', { timeout: 3000 }).catch(() => {});
    const gotText = await page.textContent('.got').catch(() => '');
    check('10) "فاتورتك" لا تزال ظاهرة (حدث حقيقي)', /فاتورتك/.test(gotText));
    check('10) لا بطاقة "رقم طلبك"/"رقم دورك" (بلا مصدر حقيقي) في الوضع المباشر', !/رقم طلبك|رقم دورك/.test(gotText));
    check('10) لا بطاقة "موعدك القادم" في الوضع المباشر', !/موعدك القادم/.test(gotText));
    await context.close();
  }

  // =========================================================================
  // 11) تنظيف: قسم "الربط بنظام الكاشير" القديم (رمز الإقران الوهمي/اختبار
  //     الاتصال المزيَّف) أُزيل بالكامل من شاشة الإعدادات.
  // =========================================================================
  {
    const scenario = baseScenario({ adminPin: '1234' });
    const { context, page } = await openKiosk(browser, { mode: 'demo', scenario });
    await openAdminSettingsViaPin(page, '1234');
    const hasOldSection = await page.evaluate(() => {
      return !!(document.getElementById('fPairing') || document.getElementById('testConn') || document.getElementById('connBadge'));
    });
    check('11) لا أثر لعناصر القسم القديم (fPairing/testConn/connBadge) في شاشة الإعدادات', !hasOldSection);
    const adminBodyText = await page.textContent('.adm-body').catch(() => '');
    check('11) لا نص "الربط بنظام الكاشير"/"رمز الإقران" في شاشة الإعدادات', !/الربط بنظام الكاشير|رمز الإقران/.test(adminBodyText));
    await context.close();
  }

  // =========================================================================
  // 12) الوضع (demo/live) يُقرأ من صف الفرع (branch_settings.pos_mode) لا من
  //     localStorage وحده — جهاز جديد/مُعاد ضبطه (demo محلياً) يرث فعلياً
  //     وضع فرعه الحقيقي (live) من أول إقلاع ناجح.
  // =========================================================================
  {
    const scenario = baseScenario({});
    const { context, page } = await openKiosk(browser, { mode: 'demo', dbMode: 'live', localMode: 'demo', scenario });
    const devBtn = await page.$('#idleDevNext');
    check('12) جهاز جديد محلياً demo يرث فعلياً live من صف فرعه عند الإقلاع', devBtn === null);
    await context.close();
  }

  // =========================================================================
  // 13) حفظ الوضع من شاشة الإعدادات يكتبه فعلياً إلى branch_settings.pos_mode
  //     (لا محلياً فقط) — والوضع التجريبي لم يتغيّر (التبديل والحفظ يعملان
  //     كما كانا).
  // =========================================================================
  {
    const scenario = baseScenario({ adminPin: '1234' });
    const { context, page } = await openKiosk(browser, { mode: 'demo', scenario });
    await openAdminSettingsViaPin(page, '1234');
    await page.click('#adminMode button[data-m="live"]');
    await page.click('#adminSave');
    await page.waitForSelector('#adminBox', { state: 'detached', timeout: 3000 }).catch(() => {});
    const lastUpdate = await page.evaluate(() => window.__TEST__.getLastUpdate());
    check('13) الحفظ يكتب pos_mode=live فعلياً إلى branch_settings', !!lastUpdate && lastUpdate.table === 'branch_settings' && lastUpdate.payload.pos_mode === 'live');
    const devBtnAfter = await page.$('#idleDevNext');
    check('13) الشاشة الرئيسية تعكس الوضع المباشر فوراً بعد الحفظ (لا زر "التالي")', devBtnAfter === null);
    await context.close();
  }

  // =========================================================================
  // 14-20) الأقسام الستة وجدول الميزات (CLAUDE.md "جدول ميزات الكشك")
  // =========================================================================
  const sectorScenario = (code, extra) => baseScenario(Object.assign({
    branchSettingsRow: {
      sector_code: code, biz_name: '', biz_branch: '', biz_slogan: '', biz_logo: '',
      show_menu_btn: true, menu_images: [], card_toggles: {}, dark_mode: false,
    },
  }, extra || {}));
  const demoMain = async (code) => {
    const { context, page } = await openKiosk(browser, { mode: 'demo', scenario: sectorScenario(code) });
    const idleMenu = await page.$('#idleMenuBtn') ? await page.textContent('#idleMenuBtn') : null;
    await page.click('#idleDevNext');
    await waitForCheckout(page);
    const info = await page.evaluate(() => ({
      sector: S.t,
      right: (document.querySelector('.col.right') || {}).textContent || '',
      loyalty: !!document.getElementById('loyaltyCard'),
      loyaltyText: (document.getElementById('loyaltyCard') || {}).textContent || '',
      queue: !!document.getElementById('queueCard'),
      toggles: sectorCardToggles(S.t).map((x) => x.id),
    }));
    await context.close();
    return Object.assign(info, { idleMenu });
  };

  {
    const { context, page } = await openKiosk(browser, { mode: 'demo', scenario: sectorScenario('restaurant') });
    const keys = await page.evaluate(() => Object.keys(T));
    check('14) قوالب الكشك = الأقسام الستة (الأربعة القديمة بترتيبها ثم التجزئة والخدمات)',
      JSON.stringify(keys) === JSON.stringify(['medical', 'cafe', 'restaurant', 'grocery', 'retail', 'services']));
    const same = await page.evaluate(() => {
      const strip = (o) => { const c = Object.assign({}, o); ['key', 'switchLabel', 'category', 'biz', 'slogan'].forEach((k) => delete c[k]); return JSON.stringify(c); };
      return strip(T.retail) === strip(T.grocery) && JSON.stringify(sectorCardToggles('retail')) === JSON.stringify(sectorCardToggles('grocery'));
    });
    check('14) التجزئة = قالب البقالة تماماً (كل الميزات والبطاقات والمفاتيح؛ يختلف الاسم ونصوص العرض فقط)', same);
    await context.close();
  }

  const F = {};
  for (const code of ['grocery', 'retail', 'cafe', 'restaurant', 'medical', 'services']) F[code] = await demoMain(code);
  check('15) الكشك يُقلع بالقسم المحفوظ في branch_settings لكل الستة (retail/services مقبولان، لا رجوع للافتراضي)',
    Object.entries(F).every(([code, f]) => f.sector === code));
  check('15) "فاتورتك": لكل الأقسام', Object.values(F).every((f) => f.toggles[0] === 'invoiceArrived'));
  check('16) نقاط الولاء: لكل الأقسام ما عدا الصحي (يبقى كما هو)',
    ['grocery', 'retail', 'cafe', 'restaurant', 'services'].every((c) => F[c].loyalty && /نقاط مكتسبة/.test(F[c].loyaltyText) && F[c].toggles.includes('loyaltyPoints')) &&
    !F.medical.toggles.includes('loyaltyPoints') && !/نقاط مكتسبة/.test(F.medical.loyaltyText));
  check('17) "عروضنا": لكل الأقسام الستة (جديد للصحي)',
    Object.values(F).every((f) => /عروضنا/.test(f.right) && f.toggles.includes('offers')));
  check('17) الصحي يحتفظ ببطاقتي الموعد ونوع العيادة كما هما', /حجز موعدك القادم/.test(F.medical.right) && /نوع العيادة/.test(F.medical.loyaltyText) && F.medical.toggles.includes('nextAppt'));
  check('18) زر القائمة: مقهى ومطعم "المنيو"، خدمات "خدماتنا"، وبلا زر للبقالة والتجزئة والصحي',
    /المنيو/.test(F.cafe.idleMenu || '') && /المنيو/.test(F.restaurant.idleMenu || '') && /خدماتنا/.test(F.services.idleMenu || '') &&
    /قائمة الخدمات والأسعار/.test(F.services.idleMenu || '') && F.grocery.idleMenu === null && F.retail.idleMenu === null && F.medical.idleMenu === null);
  check('19) رقم الدور: مقهى ومطعم "رقم طلبك"، صحي "رقم دورك"؛ والبقالة والتجزئة والخدمات بلا رقم',
    /رقم طلبك/.test(F.cafe.right) && /رقم طلبك/.test(F.restaurant.right) && !/رقم طاولتك/.test(F.restaurant.right) && F.medical.queue && F.medical.toggles.includes('queueNumber') &&
    ['grocery', 'retail', 'services'].every((c) => !F[c].queue && !/رقم طلبك|رقم طاولتك|رقم دورك/.test(F[c].right) && F[c].toggles.length === 3));
  check('19) المواعيد والحجز ونوع العيادة للصحي فقط',
    Object.entries(F).every(([c, f]) => c === 'medical' || (!f.toggles.includes('nextAppt') && !/موعد|نوع العيادة/.test(f.right + f.loyaltyText))));
  check('19) المقهى والمطعم والبقالة بلا أي تغيير في مفاتيح بطاقاتها',
    JSON.stringify(F.cafe.toggles) === JSON.stringify(['invoiceArrived', 'loyaltyPoints', 'offers', 'orderNumber']) &&
    JSON.stringify(F.restaurant.toggles) === JSON.stringify(['invoiceArrived', 'loyaltyPoints', 'offers', 'orderNumber']) &&
    JSON.stringify(F.grocery.toggles) === JSON.stringify(['invoiceArrived', 'loyaltyPoints', 'offers']) &&
    JSON.stringify(F.medical.toggles) === JSON.stringify(['invoiceArrived', 'queueNumber', 'nextAppt', 'offers']));

  {
    const { context, page } = await openKiosk(browser, { mode: 'demo', scenario: sectorScenario('services', { adminPin: '1234' }) });
    await page.click('#idleMenuBtn');
    await page.waitForSelector('#menuOv', { timeout: 2000 }).catch(() => {});
    const empty = await page.textContent('#menuOv').catch(() => '');
    check('20) زر "خدماتنا" يفتح نفس عارض الصفحات (بلا ملف بعد: "لم تُرفَع قائمة الخدمات بعد")', /لم تُرفَع قائمة الخدمات بعد/.test(empty));
    await page.click('#menuClose');
    await openAdminSettingsViaPin(page, '1234');
    const adm = await page.textContent('.adm-body');
    check('20) إعدادات الجهاز لقسم الخدمات: "إظهار زر خدماتنا" و"ملف قائمة الخدمات والأسعار"', /إظهار زر خدماتنا/.test(adm) && /ملف قائمة الخدمات والأسعار/.test(adm));
    check('20) لا منتقي قسم في إعدادات شاشة نوج إطلاقاً (القسم من لوحة التاجر وللمالك فقط)', (await page.$('#adminSw')) === null && !/<h3>القطاع<\/h3>/.test(await page.innerHTML('.adm-body')));
    await context.close();
  }
  {
    const { context, page } = await openKiosk(browser, { mode: 'demo', scenario: sectorScenario('cafe', { adminPin: '1234' }) });
    await openAdminSettingsViaPin(page, '1234');
    const adm = await page.textContent('.adm-body');
    check('20) المقهى بلا تغيير: "إظهار زر المنيو" و"ملف المنيو"', /إظهار زر المنيو/.test(adm) && /ملف المنيو \(PDF أو صور\)/.test(adm));
    await context.close();
  }

  {
    const { context, page } = await openKiosk(browser, { mode: 'demo', scenario: sectorScenario('restaurant') });
    const same = await page.evaluate(() => ['ticketLabel', 'aheadWord', 'aheadSingular', 'aheadDual'].every((k) => T.restaurant[k] === T.cafe[k]) &&
      JSON.stringify(T.restaurant.okItems.slice(1)) === JSON.stringify(T.cafe.okItems.slice(1)));
    check('21) المطعم = المقهى تماماً في رقم الطلب (التسمية، صيغ "أمامك…"، وبطاقة شاشة النجاح)', same);
    check('21) عنوان الصفحة "شاشة نوج"', (await page.title()) === 'NOJ — شاشة نوج');
    await context.close();
  }
  {
    const { context, page } = await openKiosk(browser, { mode: 'demo', scenario: sectorScenario('medical', { adminPin: '1234' }) });
    await page.click('#idleDevNext');
    await waitForCheckout(page);
    const right = await page.textContent('.col.right');
    check('22) "تطبيق نوج" بدل "التطبيق" في النصوص الظاهرة', /الإلكترونية بتطبيق نوج/.test(right) && !/بالتطبيق/.test(right) &&
      await page.evaluate(() => T.medical.okItems.some((o) => o.s === 'احجزه من تطبيق نوج مباشرة')));
    await context.close();
  }
  {
    const { context, page } = await openKiosk(browser, { mode: 'demo', scenario: sectorScenario('cafe', { adminPin: '1234' }) });
    await openAdminSettingsViaPin(page, '1234');
    await page.fill('#fBizName', 'اسم جديد');
    await page.click('#adminSave');
    await page.waitForFunction(() => window.__TEST__.getLastUpdate() !== null, null, { timeout: 3000 }).catch(() => {});
    const upd = await page.evaluate(() => window.__TEST__.getLastUpdate());
    check('23) حفظ إعدادات شاشة نوج يكتب بقية الحقول ولا يرسل sector_code إطلاقاً (يقرأ القسم ولا يكتبه)',
      upd && upd.table === 'branch_settings' && upd.payload.biz_name === 'اسم جديد' && !('sector_code' in upd.payload));
    await context.close();
  }

  // =========================================================================
  // 24-26) "حجزك القادم" للمطعم والخدمات (supabase-migration-reservations.sql)
  // =========================================================================
  const bookingMain = async (code, bookingEnabled, cardToggles, type) => {
    const sc = sectorScenario(code, { merchantRow: { name: 'تاجر', type: type || 'مطاعم', points_rate: 1, booking_enabled: bookingEnabled } });
    if (cardToggles) sc.branchSettingsRow.card_toggles = cardToggles;
    const { context, page } = await openKiosk(browser, { mode: 'demo', scenario: sc });
    await page.click('#idleDevNext');
    await waitForCheckout(page);
    const info = await page.evaluate(() => ({
      right: (document.querySelector('.col.right') || {}).textContent || '',
      toggles: sectorCardToggles(S.t).map((x) => x.id),
    }));
    await context.close();
    return info;
  };
  {
    const r = await bookingMain('restaurant', true);
    const sv = await bookingMain('services', true, null, 'خدمات');
    check('24) مطعم فعّل الحجوزات: بطاقة "حجزك القادم" ظاهرة (احجز طاولتك…من تطبيق NOJ) ومفتاحها بعد بقية المفاتيح',
      /حجزك القادم/.test(r.right) && /احجز طاولتك أو ألغِ حجزك/.test(r.right) &&
      JSON.stringify(r.toggles) === JSON.stringify(['invoiceArrived', 'loyaltyPoints', 'offers', 'orderNumber', 'nextBooking']));
    check('24) خدمات فعّلت الحجوزات: نفس البطاقة بنص الخدمة',
      /حجزك القادم/.test(sv.right) && /احجز خدمتك أو ألغِ حجزك/.test(sv.right) &&
      JSON.stringify(sv.toggles) === JSON.stringify(['invoiceArrived', 'loyaltyPoints', 'offers', 'nextBooking']));
    const rOff = await bookingMain('restaurant', false);
    const svOff = await bookingMain('services', false, null, 'خدمات');
    check('25) تاجر لم يفعّل الحجوزات: لا بطاقة ولا مفتاح (لا مفتاح بلا بطاقة)',
      !/حجزك القادم/.test(rOff.right + svOff.right) && !rOff.toggles.includes('nextBooking') && !svOff.toggles.includes('nextBooking'));
    const rHidden = await bookingMain('restaurant', true, { nextBooking: false });
    check('25) مفتاح "حجزك القادم" في إعدادات الجهاز يخفي البطاقة', !/حجزك القادم/.test(rHidden.right) && rHidden.toggles.includes('nextBooking'));
    const med = await bookingMain('medical', true, null, 'صحة');
    const cafe = await bookingMain('cafe', true, null, 'مقاهي');
    const groc = await bookingMain('grocery', true, null, 'بقالة');
    check('26) الصحي بلا تغيير حتى مع booking_enabled: بطاقة الموعد نفسها ومفاتيحه نفسها، بلا "حجزك القادم"',
      /حجز موعدك القادم/.test(med.right) && !/حجزك القادم/.test(med.right) &&
      JSON.stringify(med.toggles) === JSON.stringify(['invoiceArrived', 'queueNumber', 'nextAppt', 'offers']));
    check('26) المقهى والبقالة بلا بطاقة حجز حتى مع booking_enabled (جدول الميزات)',
      !/حجزك القادم/.test(cafe.right + groc.right) && !cafe.toggles.includes('nextBooking') && !groc.toggles.includes('nextBooking'));
  }
  {
    const sc = sectorScenario('restaurant', { adminPin: '1234', merchantRow: { name: 'تاجر', type: 'مطاعم', points_rate: 1, booking_enabled: true } });
    const { context, page } = await openKiosk(browser, { mode: 'demo', scenario: sc });
    await openAdminSettingsViaPin(page, '1234');
    check('26) إعدادات الجهاز تعرض مفتاح "حجزك القادم" لمطعم فعّل الحجوزات', /حجزك القادم/.test(await page.textContent('.adm-body')));
    await context.close();
  }

  await browser.close();

  console.log('\n=== KIOSK E2E SUMMARY:', pass, 'passed,', fail, 'failed ===');
  if (failures.length) console.log('Failures:', JSON.stringify(failures, null, 2));
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => { console.error('FATAL:', e); process.exit(1); });
