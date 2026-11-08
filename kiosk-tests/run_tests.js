// NOJ — Playwright E2E tests for kiosk.html stage 3 (live POS capture).
// Real Chromium (pre-cached in this environment), fake Supabase client
// (fake-supabase.js), zero live network — kiosk.html itself is untouched
// except for two test-only hooks it already documents in its own comments
// (window.__NOJ_SUPABASE_CLIENT__, window.__NOJ_POLL_MS__).
const { chromium } = require('playwright');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..');
const KIOSK_URL = 'file://' + path.join(REPO_ROOT, 'kiosk.html');
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

async function openKiosk(browser, { mode, scenario, pollMs, dbMode, localMode, preStorage, waitFor }) {
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
  if (preStorage) {
    // مرة واحدة فقط (لا عند كل تحميل) كي لا يُعاد زرع المفتاح القديم بعد ترحيله
    await page.addInitScript((kv) => {
      if (sessionStorage.getItem('__seeded')) return;
      sessionStorage.setItem('__seeded', '1');
      Object.keys(kv).forEach((k) => localStorage.setItem(k, kv[k]));
    }, preStorage);
  }
  await page.addInitScript((s) => {
    window.__NOJ_SCENARIO__ = s;
  }, scenarioWithMode);
  if (pollMs) {
    await page.addInitScript((ms) => { window.__NOJ_POLL_MS__ = ms; }, pollMs);
  }
  await page.addInitScript({ path: FAKE_SB_PATH });

  await page.goto(KIOSK_URL);
  await page.waitForSelector(waitFor || '.idle', { timeout: 5000 });
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
    // النقاط المعلّقة (مدة التعليق للبقالة/التجزئة) لا تُذكر في شاشة نوج إطلاقاً: "+X نقطة" فقط
    const okText = await page.innerText('body').catch(() => '');
    check('2) شاشة النجاح بلا أي ذكر لتعليق النقاط أو مدته (لا "معلّق" ولا "تعليق" ولا "متاحاً للاستبدال")', !/معل[ّ]?ق|تعليق|متاح(اً|ة)? للاستبدال|يصبح متاح/.test(okText));
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
    // قراءة لحاق واحدة فقط عند الاشتراك (لا شيء معلّق هنا) — لا استطلاع دوري
    check('7) القناة SUBSCRIBED: قراءة لحاق واحدة عند الاشتراك فقط، لا استطلاع دوري', pollBefore === 1);
    await page.evaluate((row) => window.__TEST__.pushRealtimeInsert(row), {
      id: 'txn-7', branch_id: 'branch-1', amount: '33.00', vat: '0',
      status: 'pending', expires_at: new Date(Date.now() + 5 * 60000).toISOString(),
    });
    const reached = await waitForCheckout(page);
    check('7) العملية وصلت والقناة لا تزال SUBSCRIBED', reached);
    const amountText = reached ? await page.textContent('.inv-chip b') : '';
    check('7) المبلغ صحيح (33.00)', /33\.00/.test(amountText));
    const pollAfter = await page.evaluate(() => window.__TEST__.getPollCount());
    check('7) لم يُستدعَ أي استعلام بعد الاشتراك — الالتقاط عبر Realtime فعلياً لا عبر poll', pollAfter === pollBefore);
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

  // 27) زر "خدماتنا" = قائمة خدمات التاجر نفسها (merchant_services)
  {
    const sc = sectorScenario('services', { merchantRow: { name: 'غسيل', type: 'خدمات', points_rate: 1, booking_enabled: true }, services: [
      { merchant_id: 'merchant-1', name: 'تلميع', price: null, is_active: true, sort_order: 1 },
      { merchant_id: 'merchant-1', name: 'غسيل داخلي', price: 45, is_active: true, sort_order: 0 },
      { merchant_id: 'merchant-1', name: 'خدمة قديمة', price: 10, is_active: false, sort_order: 2 },
      { merchant_id: 'merchant-other', name: 'خدمة تاجر آخر', price: 1, is_active: true, sort_order: 0 },
    ] });
    const { context, page } = await openKiosk(browser, { mode: 'demo', scenario: sc });
    await page.click('#idleMenuBtn');
    await page.waitForSelector('#svcList', { timeout: 2000 }).catch(() => {});
    const rows = await page.$$eval('#svcList .svc-row', (rs) => rs.map((r) => r.textContent));
    check('27) "خدماتنا" يعرض قائمة خدمات التاجر المفعّلة بترتيبها وأسعارها (لا غير المفعّلة ولا خدمات تاجر آخر)',
      JSON.stringify(rows) === JSON.stringify(['غسيل داخلي45.00 ر.س', 'تلميع']));
    await page.click('#menuClose');
    await context.close();
  }
  {
    const sc = sectorScenario('restaurant', { services: [{ merchant_id: 'merchant-1', name: 'x', price: 1, is_active: true, sort_order: 0 }] });
    const { context, page } = await openKiosk(browser, { mode: 'demo', scenario: sc });
    check('27) المطعم لا يقرأ قائمة الخدمات أصلاً (زر "المنيو" بلا تغيير)', (await page.evaluate(() => window.__TEST__.getServicesQueries())) === 0);
    await context.close();
  }

  // =========================================================================
  // 28-31) الصحي في الوضع المباشر: المريض الذي له موعد اليوم يأخذ رقم دوره من
  //        حجزه، وتظهر بطاقة موعده (supabase-migration-health-appointments.sql)
  // =========================================================================
  const medicalLive = (extra) => baseScenario(Object.assign({
    merchantRow: { name: 'مركز النور الطبي', type: 'صحة', points_rate: 0 },
    branchSettingsRow: {
      sector_code: 'medical', biz_name: 'مركز النور الطبي', biz_branch: 'فرع الملقا',
      biz_slogan: '', biz_logo: '', show_menu_btn: false, menu_images: [], card_toggles: {}, dark_mode: false,
    },
    claimResults: { 'txn-m': { row: { is_registered: true, profile_id: 'p1', prev_points: 0, added_points: 0, total_points: 0, invoice_id: 'inv-m' } } },
  }, extra || {}));
  const pushTxn = (page, id) => page.evaluate((row) => window.__TEST__.pushRealtimeInsert(row), {
    id, branch_id: 'branch-1', amount: '230.00', vat: '30.00', status: 'pending', expires_at: new Date(Date.now() + 5 * 60000).toISOString(),
  });
  {
    const sc = medicalLive({ checkins: { 'txn-m': { data: { clinic_name: 'عيادة الأسنان', doctor_name: 'د. سارة القحطاني', scheduled_time_riyadh: '10:30', queue_number: 45, ahead: 2 } } } });
    const { context, page } = await openKiosk(browser, { mode: 'live', scenario: sc });
    await pushTxn(page, 'txn-m');
    check('28) الصحي (مباشر): وصلت فاتورة المريض', await waitForCheckout(page));
    await enterPhoneAndConfirm(page, '512345678');
    await page.waitForSelector('.ok', { timeout: 4000 });
    const okText = await page.textContent('.ok');
    check('28) بعد إدخال الرقم: يُطلب ما ربطه الخادم لهذه العملية بالذات (kiosk_appointment_checkin)',
      JSON.stringify(await page.evaluate(() => window.__TEST__.getCheckinCalls())) === JSON.stringify(['txn-m']));
    check('29) بطاقة الموعد: العيادة والطبيب ووقت الموعد', !!(await page.$('[data-live-appt]')) && /موعدك/.test(okText) && /عيادة الأسنان/.test(okText) && /د\. سارة القحطاني/.test(okText) && /10:30/.test(okText));
    check('29) رقم الدور الحقيقي من الحجز ("رقم دورك" 45، أمامك 2) — لا رقم القالب التجريبي',
      (await page.textContent('[data-live-queue]')).includes('45') && /رقم دورك/.test(await page.textContent('[data-live-queue]')) && /أمامك 2/.test(await page.textContent('[data-live-queue]')));
    await context.close();
  }
  {
    // لا موعد اليوم: شاشة النجاح كما كانت تماماً (فاتورتك فقط، بلا رقم دور)
    const { context, page } = await openKiosk(browser, { mode: 'live', scenario: medicalLive({ checkins: {} }) });
    await pushTxn(page, 'txn-m');
    await waitForCheckout(page);
    await enterPhoneAndConfirm(page, '512345678');
    await page.waitForSelector('.ok', { timeout: 4000 });
    check('30) مريض بلا موعد اليوم: نجاح عادي بلا بطاقة موعد ولا رقم دور', !(await page.$('[data-live-appt]')) && !(await page.$('[data-live-queue]')) && !(await page.$('.ok .tno')) && /تم الربط بنجاح/.test(await page.textContent('.ok')));
    await context.close();
  }
  {
    // القراءة تفشل أو تتأخر: لا تمنع شاشة النجاح (الربط تمّ في الخادم أصلاً)
    const { context, page } = await openKiosk(browser, { mode: 'live', scenario: medicalLive({ checkinError: 'boom' }) });
    await pushTxn(page, 'txn-m');
    await waitForCheckout(page);
    await enterPhoneAndConfirm(page, '512345678');
    const shown = await page.waitForSelector('.ok', { timeout: 4000 }).then(() => true, () => false);
    check('31) تعذّر قراءة الموعد: شاشة النجاح تظهر كالمعتاد بلا بطاقة موعد', shown && !(await page.$('[data-live-appt]')));
    await context.close();
  }
  {
    // غير الصحي: لا يُطلب شيء إضافي إطلاقاً (المطعم كما كان)
    const sc = baseScenario({ claimResults: { 'txn-r': { row: { is_registered: true, profile_id: 'p1', prev_points: 10, added_points: 5, total_points: 15, invoice_id: 'inv-r' } } } });
    const { context, page } = await openKiosk(browser, { mode: 'live', scenario: sc });
    await pushTxn(page, 'txn-r');
    await waitForCheckout(page);
    await enterPhoneAndConfirm(page, '512345678');
    await page.waitForSelector('.ok', { timeout: 4000 });
    check('31) قطاع غير صحي: لا نداء kiosk_appointment_checkin ولا بطاقة موعد', (await page.evaluate(() => window.__TEST__.getCheckinCalls())).length === 0 && !(await page.$('[data-live-appt]')));
    check('35) قطاع غير صحي: لا نداء kiosk_queue_checkin ولا بطاقة "عيادتك"', (await page.evaluate(() => window.__TEST__.getQueueCheckinCalls())).length === 0 && !(await page.$('[data-live-walkin]')));
    await context.close();
  }

  // =========================================================================
  // 32-35) طابور العيادات (supabase-migration-clinic-queue.sql): مريض بلا موعد
  //        اليوم أرسل الكاشير رمز عيادته "بموعد وبدون موعد" ⇒ رقم دور حقيقي
  // =========================================================================
  {
    const sc = medicalLive({ checkins: {}, queueCheckins: { 'txn-m': { data: { clinic_name: 'عيادة الجلدية', doctor_name: 'د. خالد العمر', queue_number: 7, ahead: 3 } } } });
    const { context, page } = await openKiosk(browser, { mode: 'live', scenario: sc });
    await pushTxn(page, 'txn-m');
    await waitForCheckout(page);
    await enterPhoneAndConfirm(page, '512345678');
    await page.waitForSelector('[data-live-queue]', { timeout: 4000 }).catch(() => {});
    const okText = await page.textContent('.ok');
    check('32) بلا موعد اليوم: يُطلب الموعد أولاً ثم رقم الدور بلا موعد لهذه العملية بالذات (kiosk_queue_checkin)',
      JSON.stringify(await page.evaluate(() => window.__TEST__.getCheckinCalls())) === JSON.stringify(['txn-m']) &&
      JSON.stringify(await page.evaluate(() => window.__TEST__.getQueueCheckinCalls())) === JSON.stringify(['txn-m']));
    check('33) بطاقة "عيادتك" (العيادة والطبيب، بلا وقت موعد) لا "موعدك"',
      !!(await page.$('[data-live-walkin]')) && !(await page.$('[data-live-appt]')) && /عيادتك/.test(okText) && !/موعدك/.test(okText) &&
      /عيادة الجلدية/.test(okText) && /د\. خالد العمر/.test(okText));
    const qt = (await page.$('[data-live-queue]')) ? await page.textContent('[data-live-queue]') : '';
    check('33) رقم الدور الحقيقي في طابور العيادة ("رقم دورك" 7، أمامك 3)', qt.includes('7') && /رقم دورك/.test(qt) && /أمامك 3/.test(qt));
    await context.close();
  }
  {
    // له موعد اليوم: الموعد يحدّد العيادة (#112) — لا يُطلب رقم بلا موعد أصلاً
    const sc = medicalLive({
      checkins: { 'txn-m': { data: { clinic_name: 'عيادة الأسنان', doctor_name: 'د. سارة القحطاني', scheduled_time_riyadh: '10:30', queue_number: 45, ahead: 2 } } },
      queueCheckins: { 'txn-m': { data: { clinic_name: 'عيادة الجلدية', doctor_name: 'x', queue_number: 99, ahead: 0 } } },
    });
    const { context, page } = await openKiosk(browser, { mode: 'live', scenario: sc });
    await pushTxn(page, 'txn-m');
    await waitForCheckout(page);
    await enterPhoneAndConfirm(page, '512345678');
    await page.waitForSelector('.ok', { timeout: 4000 });
    check('34) له موعد اليوم: بطاقة الموعد ورقمه فقط، بلا نداء kiosk_queue_checkin',
      (await page.evaluate(() => window.__TEST__.getQueueCheckinCalls())).length === 0 && !!(await page.$('[data-live-appt]')) &&
      !(await page.$('[data-live-walkin]')) && (await page.textContent('[data-live-queue]')).includes('45'));
    await context.close();
  }
  {
    // لا رمز / رمز غير معروف / عيادة "بموعد فقط" / تعذّرت القراءة: نجاح عادي بلا رقم
    const { context, page } = await openKiosk(browser, { mode: 'live', scenario: medicalLive({ checkins: {}, queueCheckinError: 'boom' }) });
    await pushTxn(page, 'txn-m');
    await waitForCheckout(page);
    await enterPhoneAndConfirm(page, '512345678');
    const shown = await page.waitForSelector('.ok', { timeout: 4000 }).then(() => true, () => false);
    check('35) بلا رقم دور (أو تعذّرت القراءة): شاشة النجاح كالمعتاد بلا بطاقة ولا رقم',
      shown && !(await page.$('[data-live-walkin]')) && !(await page.$('[data-live-queue]')) && /تم الربط بنجاح/.test(await page.textContent('.ok')));
    await context.close();
  }
  {
    // عميل غير مسجَّل: لا رقم دور (الخادم لا يعطيه) ولا نداء أصلاً
    const sc = medicalLive({ claimResults: { 'txn-m': { row: { is_registered: false, prev_points: 0, added_points: 0, total_points: 0 } } },
      queueCheckins: { 'txn-m': { data: { clinic_name: 'عيادة الجلدية', doctor_name: 'x', queue_number: 7, ahead: 0 } } } });
    const { context, page } = await openKiosk(browser, { mode: 'live', scenario: sc });
    await pushTxn(page, 'txn-m');
    await waitForCheckout(page);
    await enterPhoneAndConfirm(page, '512345678');
    await page.waitForSelector('.ok', { timeout: 4000 }).catch(() => {});
    check('35) عميل غير مسجَّل: لا نداء kiosk_queue_checkin ولا بطاقة "عيادتك"',
      (await page.evaluate(() => window.__TEST__.getQueueCheckinCalls())).length === 0 && !(await page.$('[data-live-walkin]')));
    await context.close();
  }

  // =========================================================================
  // 36-38) فاتورة وصلت والشاشة مطفأة / غير مربوطة / القناة منقطعة: تظهر عند
  //        عودة الشاشة ما دامت معلّقة وضمن صلاحيتها (expires_at)، ولا أقدم.
  // =========================================================================
  const validTxn = (id, amount) => ({ id, branch_id: 'branch-1', amount, vat: '0', status: 'pending', expires_at: new Date(Date.now() + 4 * 60000).toISOString() });
  {
    const { context, page } = await openKiosk(browser, { mode: 'live', scenario: baseScenario({ pendingTxns: [validTxn('txn-off', '64.00')] }), waitFor: '.idle, .nfc' });
    const reached = await waitForCheckout(page, 3000);
    check('36) فاتورة وصلت والشاشة مطفأة: تظهر عند إقلاعها (معلّقة وضمن صلاحيتها)', reached && /64\.00/.test(await page.textContent('.inv-chip b')));
    await context.close();
  }
  {
    const expired = { id: 'txn-old', branch_id: 'branch-1', amount: '99.00', vat: '0', status: 'pending', expires_at: new Date(Date.now() - 60000).toISOString() };
    const { context, page } = await openKiosk(browser, { mode: 'live', scenario: baseScenario({ pendingTxns: [expired] }) });
    await sleep(300);
    check('36) فاتورة انتهت صلاحيتها لا تظهر عند الإقلاع (تبقى شاشة الانتظار)', !(await page.$('.nfc')) && !!(await page.$('.idle')));
    await context.close();
  }
  {
    const sc = baseScenario({ deviceRow: { id: 'device-1', branch_id: null, pairing_code: '482913' }, pendingTxns: [] });
    const { context, page } = await openKiosk(browser, { mode: 'live', scenario: sc });
    check('37) جهاز غير مربوط: شاشة رمز الربط', /482913/.test(await page.textContent('#screen')));
    await page.evaluate((row) => {
      window.__NOJ_SCENARIO__.deviceRow = { id: 'device-1', branch_id: 'branch-1', pairing_code: null };
      window.__TEST__.setPendingTxns([row]);
    }, validTxn('txn-pair', '58.00'));
    await page.click('#pairingRecheckBtn');
    const reached = await waitForCheckout(page, 3000);
    check('37) بعد ربط الشاشة: تبدأ الاستماع، وتظهر الفاتورة التي وصلت قبل الربط',
      reached && /58\.00/.test(await page.textContent('.inv-chip b')) && (await page.evaluate(() => window.__TEST__.getChannelCreateCount())) >= 1);
    await context.close();
  }
  {
    const sc = baseScenario({ deviceRow: { id: 'device-1', branch_id: null, pairing_code: '482913' }, pendingTxns: [] });
    const { context, page } = await openKiosk(browser, { mode: 'live', scenario: sc });
    await page.evaluate(() => { window.__NOJ_SCENARIO__.deviceRow = { id: 'device-1', branch_id: 'branch-1', pairing_code: null }; });
    await page.click('#pairingRecheckBtn');
    await page.waitForFunction(() => window.__TEST__.getChannelCreateCount() >= 1, null, { timeout: 3000 }).catch(() => {});
    await sleep(100);
    await page.evaluate((row) => window.__TEST__.pushRealtimeInsert(row), validTxn('txn-rt', '21.00'));
    check('37) بعد الربط من شاشة الرمز: فاتورة جديدة تصل عبر Realtime بلا إعادة تحميل', await waitForCheckout(page, 3000));
    await context.close();
  }
  {
    const { context, page } = await openKiosk(browser, { mode: 'live', scenario: baseScenario({ pendingTxns: [] }) });
    await page.evaluate(() => window.__TEST__.setChannelStatus('CHANNEL_ERROR'));
    await page.evaluate((row) => window.__TEST__.setPendingTxns([row]), validTxn('txn-gap', '37.00'));
    await page.evaluate(() => window.__TEST__.setChannelStatus('SUBSCRIBED'));
    const reached = await waitForCheckout(page, 3000);
    check('38) عودة القناة بعد انقطاع: تلتقط فوراً ما وصل أثناء الانقطاع', reached && /37\.00/.test(await page.textContent('.inv-chip b')));
    await context.close();
  }

  // =========================================================================
  // 39-40) جلسة الشاشة في مفتاح تخزين خاص بها (لا يمسّها تطبيق نوج في نفس المتصفح)
  // =========================================================================
  const LEGACY = 'sb-jqddjswxsacejbqjeehw-auth-token', KIOSK_KEY = 'sb-noj-kiosk-auth';
  const sess = (anon) => JSON.stringify({ access_token: 'a', refresh_token: 'r', expires_at: 1, user: { id: anon ? 'device-auth-1' : 'customer-1', is_anonymous: anon } });
  {
    const { context, page } = await openKiosk(browser, { mode: 'live', scenario: baseScenario({}) });
    const consts = await page.evaluate(() => [KIOSK_STORAGE_KEY, LEGACY_SB_STORAGE_KEY]);
    const src = require('fs').readFileSync(path.join(__dirname, '..', 'kiosk.html'), 'utf8');
    check('39) مفتاح جلسة الشاشة خاص بها، والقديم هو الافتراضي الفعلي لـsupabase-js، وcreateClient يستعمل الخاص',
      consts[0] === KIOSK_KEY && consts[1] === LEGACY && /createClient\(SUPABASE_URL,SUPABASE_KEY,\{auth:\{storageKey:KIOSK_STORAGE_KEY\}\}\)/.test(src));
    await context.close();
  }
  {
    const { context, page } = await openKiosk(browser, { mode: 'live', scenario: baseScenario({}), preStorage: { [LEGACY]: sess(true) } });
    const st = await page.evaluate((k) => [localStorage.getItem(k[0]), localStorage.getItem(k[1])], [KIOSK_KEY, LEGACY]);
    check('40) شاشة مربوطة اليوم (جلسة مجهولة في المفتاح القديم): تُنقل لمفتاحها الخاص وتُحذف من القديم — لا إعادة ربط',
      st[0] === sess(true) && st[1] === null);
    await context.close();
  }
  {
    const { context, page } = await openKiosk(browser, { mode: 'live', scenario: baseScenario({}), preStorage: { [LEGACY]: sess(false) } });
    const st = await page.evaluate((k) => [localStorage.getItem(k[0]), localStorage.getItem(k[1])], [KIOSK_KEY, LEGACY]);
    check('40) جلسة عميل سجّل دخوله (غير مجهولة) في المفتاح القديم: لا تُمَس ولا تنتقل للشاشة', st[0] === null && st[1] === sess(false));
    await context.close();
  }
  {
    const mine = JSON.stringify({ access_token: 'k', user: { id: 'device-auth-1', is_anonymous: true } });
    const { context, page } = await openKiosk(browser, { mode: 'live', scenario: baseScenario({}), preStorage: { [KIOSK_KEY]: mine, [LEGACY]: sess(true) } });
    const st = await page.evaluate((k) => [localStorage.getItem(k[0]), localStorage.getItem(k[1])], [KIOSK_KEY, LEGACY]);
    check('40) للشاشة جلستها الخاصة أصلاً: لا ترحيل ولا مساس بالمفتاح الافتراضي (جلسة تطبيق نوج)', st[0] === mine && st[1] === sess(true));
    await context.close();
  }

  await browser.close();

  console.log('\n=== KIOSK E2E SUMMARY:', pass, 'passed,', fail, 'failed ===');
  if (failures.length) console.log('Failures:', JSON.stringify(failures, null, 2));
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => { console.error('FATAL:', e); process.exit(1); });
