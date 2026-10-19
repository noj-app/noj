// NOJ — يمرّر هذا الاختبار الحمولة التي تبنيها أداة محاكاة فاتورة الكاشير
// فعلياً (scripts/pos-invoice-payload.mjs، المصدر الوحيد الذي يستخدمه كل من
// .github/workflows/simulate-pos-invoice.yml وscripts/simulate-pos-invoice.js)
// عبر المحوّل والتحقق الحقيقيين في pos-intake (handlePosIntake) — لا حمولة
// يدوية مكتوبة هنا قد تنحرف عمّا تبنيه الأداة فعلياً. هذا تحديداً يمنع تكرار
// عطل سابق: الحمولة التي بناها الـ workflow كانت تفتقد external_ref بصمت
// (متغيّر bash غير مُصدَّر لم يصل لعملية node الفرعية) رغم اجتياز أي اختبار
// يفحص شكل الحمولة يدوياً بمعزل عن pos-intake الحقيقي.
import { assertEquals } from 'jsr:@std/assert@1';
import { handlePosIntake, sha256Hex } from './intake.ts';
import type { IntakeDeps, PosTransactionRow } from './intake.ts';
import { buildPosInvoicePayload } from '../../../scripts/pos-invoice-payload.mjs';

const VALID_TOKEN = 'a-very-long-random-branch-token-value';
const BRANCH_ID = '11111111-1111-1111-1111-111111111111';

function makeDeps(overrides: Partial<IntakeDeps> = {}): IntakeDeps {
  return {
    lookupBranchByTokenHash: async (hash) => {
      const validHash = await sha256Hex(VALID_TOKEN);
      return hash === validHash ? BRANCH_ID : null;
    },
    intakeTransaction: (args) => {
      const row: PosTransactionRow = {
        id: 'txn-' + args.externalRef,
        status: 'pending',
        external_ref: args.externalRef,
      };
      return Promise.resolve({ ok: true, row });
    },
    ...overrides,
  };
}

function headers(token: string | null, vendor: string | null = 'generic') {
  return {
    authorization: token ? `Bearer ${token}` : null,
    posVendor: vendor,
  };
}

Deno.test('simulator payload (CLI، بلا CI): يمرّ عبر pos-intake الحقيقي بنجاح', async () => {
  const payload = buildPosInvoicePayload({ amount: '125.50', vat: '0', deviceId: '', ci: null });
  const body = JSON.stringify(payload);
  const result = await handlePosIntake(body, headers(VALID_TOKEN), makeDeps());
  assertEquals(result.status, 200);
  const parsed = JSON.parse(result.body);
  assertEquals(parsed.ok, true);
  assertEquals(parsed.external_ref, payload.external_ref);
});

Deno.test('simulator payload (GitHub Actions، بمعرّفات تشغيل): يمرّ عبر pos-intake الحقيقي بنجاح', async () => {
  const payload = buildPosInvoicePayload({
    amount: '150',
    vat: '22.50',
    deviceId: '',
    ci: { runId: '123456789', runNumber: '7' },
  });
  const body = JSON.stringify(payload);
  const result = await handlePosIntake(body, headers(VALID_TOKEN), makeDeps());
  assertEquals(result.status, 200);
  const parsed = JSON.parse(result.body);
  assertEquals(parsed.ok, true);
  assertEquals(parsed.external_ref, payload.external_ref);
});

Deno.test('simulator payload: external_ref دائماً موجود وغير فارغ (العطل الحي السابق كان يُسقطه بصمت)', async () => {
  const payload = buildPosInvoicePayload({ amount: '10', vat: '0', deviceId: '', ci: { runId: '1', runNumber: '1' } });
  assertEquals(typeof payload.external_ref, 'string');
  assertEquals((payload.external_ref as string).length > 0, true);
  const body = JSON.stringify(payload);
  const result = await handlePosIntake(body, headers(VALID_TOKEN), makeDeps());
  assertEquals(result.status, 200);
});

Deno.test('simulator payload: device_id فارغ يُحذف كلياً من الحمولة، لا يُرسَل كنص فارغ', async () => {
  const payload = buildPosInvoicePayload({ amount: '10', vat: '0', deviceId: '   ', ci: null });
  assertEquals(Object.prototype.hasOwnProperty.call(payload, 'device_id'), false);
  const body = JSON.stringify(payload);
  const result = await handlePosIntake(body, headers(VALID_TOKEN), makeDeps());
  assertEquals(result.status, 200);
});

Deno.test('simulator payload: device_id محدَّد (UUID) يصل كما هو، ويُقبَل', async () => {
  const deviceId = '22222222-2222-2222-2222-222222222222';
  const payload = buildPosInvoicePayload({ amount: '10', vat: '0', deviceId, ci: null }) as Record<string, unknown>;
  assertEquals(payload.device_id, deviceId);
  const body = JSON.stringify(payload);
  const result = await handlePosIntake(body, headers(VALID_TOKEN), makeDeps());
  assertEquals(result.status, 200);
});

Deno.test('simulator payload: amount وvat أرقام JS حقيقية لا نصوصاً، كما يشترط المحوّل العام', async () => {
  const payload = buildPosInvoicePayload({ amount: '125.50', vat: '22.50', deviceId: '', ci: null });
  assertEquals(typeof payload.amount, 'number');
  assertEquals(typeof payload.vat, 'number');
});

Deno.test('simulator payload: amount صفر أو سالب يُرفَض قبل أي اتصال بـ pos-intake', () => {
  let threw = false;
  try {
    buildPosInvoicePayload({ amount: '0', vat: '0', deviceId: '', ci: null });
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
});

Deno.test('simulator payload: vat سالب يُرفَض قبل أي اتصال بـ pos-intake', () => {
  let threw = false;
  try {
    buildPosInvoicePayload({ amount: '10', vat: '-1', deviceId: '', ci: null });
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
});

Deno.test('simulator payload: vat >= amount يُرفَض (القاعدة المحاسبية: الضريبة متضمَّنة داخل المبلغ)', () => {
  for (const [amount, vat] of [['10', '10'], ['10', '11']]) {
    let threw = false;
    try {
      buildPosInvoicePayload({ amount, vat, deviceId: '', ci: null });
    } catch {
      threw = true;
    }
    assertEquals(threw, true, `amount=${amount} vat=${vat}`);
  }
});

Deno.test('simulator payload: 115 شاملاً 15 ضريبة يمرّ عبر pos-intake الحقيقي', async () => {
  const payload = buildPosInvoicePayload({ amount: '115', vat: '15', deviceId: '', ci: null });
  const result = await handlePosIntake(JSON.stringify(payload), headers(VALID_TOKEN), makeDeps());
  assertEquals(result.status, 200);
});
