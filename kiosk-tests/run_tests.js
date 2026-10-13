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

async function openKiosk(browser, { mode, scenario, pollMs }) {
  const context = await browser.newContext();
  const page = await context.newPage();
  // no live network at all — fail fast instead of waiting out real timeouts
  // (Turnstile script, the esm.sh supabase-js fallback import — never
  // actually reached since window.__NOJ_SUPABASE_CLIENT__ short-circuits
  // getSb(), but blocked defensively regardless).
  await page.route('**://challenges.cloudflare.com/**', (route) => route.abort());
  await page.route('**://esm.sh/**', (route) => route.abort());

  await page.addInitScript((settings) => {
    localStorage.setItem('noj_kiosk_settings', JSON.stringify(settings));
  }, { mode: mode });
  await page.addInitScript((s) => {
    window.__NOJ_SCENARIO__ = s;
  }, scenario);
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
    await context.close();
  }
  {
    const scenario = baseScenario({});
    const { context, page } = await openKiosk(browser, { mode: 'live', scenario });
    const devBtn = await page.$('#idleDevNext');
    check('6) زر "التالي (تجربة)" غائب تماماً في الوضع المباشر', devBtn === null);
    await context.close();
  }

  await browser.close();
  console.log('\n=== KIOSK E2E SUMMARY:', pass, 'passed,', fail, 'failed ===');
  if (failures.length) console.log('Failures:', JSON.stringify(failures, null, 2));
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => { console.error('FATAL:', e); process.exit(1); });
