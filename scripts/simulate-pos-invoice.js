#!/usr/bin/env node
// NOJ — محاكاة فاتورة كاشير: نقطة الدخول الوحيدة فعلياً، يستدعيها كل من
// مطوّر لديه حاسوب مباشرة، و.github/workflows/simulate-pos-invoice.yml (بلا
// أي إعادة تنفيذ للمنطق داخل YAML — الـ workflow يستدعي هذا الملف نفسه عبر
// node scripts/simulate-pos-invoice.js، فلا يوجد تطبيقان منفصلان قد يختلفان).
// بناء الحمولة نفسه في pos-invoice-payload.mjs (وحدة نقية، تُختبَر مباشرة في
// supabase/functions/pos-intake/simulator-payload.test.ts عبر Deno). لا
// اعتماديات خارجية — يستخدم fetch العامة في Node 18+ فقط.
//
// الاستخدام:
//   NOJ_TEST_POS_TOKEN=<توكن الفرع> SUPABASE_PROJECT_ID=<معرّف المشروع> \
//     node scripts/simulate-pos-invoice.js --amount 125.50 [--vat 0] [--device-id <uuid>]
//
// يكتشف تلقائياً أنه يعمل داخل GitHub Actions (GITHUB_ACTIONS=true، تضبطها
// منصة Actions نفسها لكل خطوة، لا حاجة لتمريرها يدوياً) ليضع external_ref
// ومعرّفات التشغيل المناسبة بدل القيم الافتراضية لتشغيل مطوّر محلي.
//
// لا يطبع التوكن أبداً تحت أي ظرف.

function parseArgs(argv) {
  const out = { amount: null, vat: '0', deviceId: '' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--amount') out.amount = argv[++i];
    else if (a === '--vat') out.vat = argv[++i];
    else if (a === '--device-id') out.deviceId = argv[++i];
    else {
      console.error(`معامل غير معروف: ${a}`);
      process.exit(1);
    }
  }
  return out;
}

async function main() {
  // import() ديناميكي لا import ثابت: يعمل من ملف CommonJS عادي (.js، بلا
  // "type": "module" في أي package.json) على أي إصدار Node 18+، بخلاف
  // import الثابت الذي يعتمد على اكتشاف صيغة ESM التلقائي (ميزة أحدث، غير
  // مضمونة على كل إصدار Node مثبَّت مسبقاً على عدّاد GitHub Actions).
  const { buildPosInvoicePayload } = await import('./pos-invoice-payload.mjs');

  const args = parseArgs(process.argv.slice(2));

  const token = process.env.NOJ_TEST_POS_TOKEN;
  const projectId = process.env.SUPABASE_PROJECT_ID;

  if (!token) {
    console.error('متغيّر البيئة NOJ_TEST_POS_TOKEN مطلوب (توكن فرع الاختبار).');
    process.exit(1);
  }
  if (!projectId) {
    console.error('متغيّر البيئة SUPABASE_PROJECT_ID مطلوب.');
    process.exit(1);
  }
  if (!args.amount) {
    console.error('--amount مطلوب.');
    process.exit(1);
  }

  const ci = process.env.GITHUB_ACTIONS === 'true'
    ? { runId: process.env.GITHUB_RUN_ID, runNumber: process.env.GITHUB_RUN_NUMBER }
    : null;

  let body;
  try {
    body = buildPosInvoicePayload({ amount: args.amount, vat: args.vat, deviceId: args.deviceId, ci });
  } catch (err) {
    console.error(err.message || String(err));
    process.exit(1);
  }

  const url = `https://${projectId}.supabase.co/functions/v1/pos-intake`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'X-POS-Vendor': 'generic',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const json = await res.json().catch(() => ({}));

  console.log('حالة الاستجابة:', res.status);
  if (json.transaction_id) console.log('معرّف العملية:', json.transaction_id);
  if (json.status) console.log('الحالة:', json.status);
  if (json.external_ref) console.log('external_ref:', json.external_ref);
  if (json.ok === false && json.error) console.log('رسالة الخطأ:', json.error);

  if (!res.ok) process.exit(1);
}

main().catch((err) => {
  console.error('خطأ غير متوقع:', err.message || err);
  process.exit(1);
});
