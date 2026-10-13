#!/usr/bin/env node
// NOJ — محاكاة فاتورة كاشير من سطر الأوامر، لمطوّر لديه حاسوب (مقابل
// .github/workflows/simulate-pos-invoice.yml الذي يعمل بلا حاسوب من
// متصفح). نفس منطق الإرسال بالضبط: POST واحدة إلى pos-intake بالحمولة
// الموحّدة، X-POS-Vendor: generic، external_ref فريد تلقائياً. لا اعتماديات
// خارجية — يستخدم fetch العامة في Node 18+ فقط.
//
// الاستخدام:
//   NOJ_TEST_POS_TOKEN=<توكن الفرع> SUPABASE_PROJECT_ID=<معرّف المشروع> \
//     node scripts/simulate-pos-invoice.js --amount 125.50 [--vat 0] [--device-id <uuid>]
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

  const amount = Number(args.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    console.error('--amount مطلوب، ويجب أن يكون رقماً أكبر من صفر.');
    process.exit(1);
  }
  const vat = Number(args.vat);
  if (!Number.isFinite(vat) || vat < 0) {
    console.error('--vat يجب أن يكون رقماً صفراً أو أكبر.');
    process.exit(1);
  }

  const externalRef = `sim-cli-${Date.now()}`;
  const body = {
    external_ref: externalRef,
    amount,
    vat,
    metadata: { source: 'cli-simulator' },
  };
  const deviceId = (args.deviceId || '').trim();
  if (deviceId) body.device_id = deviceId;

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
