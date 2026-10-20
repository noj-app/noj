// NOJ — المصدر الوحيد لمنطق بناء حمولة محاكاة فاتورة الكاشير، يستخدمه كل من
// scripts/simulate-pos-invoice.js (الـ workflow والـ CLI يستدعيان هذا الملف
// نفسه، لا تطبيقين منفصلين) واختبار Deno
// supabase/functions/pos-intake/simulator-payload.test.ts (يمرّر نفس الحمولة
// فعلياً عبر المحوّل والتحقق الحقيقيين في pos-intake). وحدة ES نقية — بلا
// process/fetch/I.O — لتبقى قابلة للاستيراد من Node وDeno معاً بلا تحويل.
//
// القاعدة المحاسبية (قرار ثابت في CLAUDE.md): amount = إجمالي ما دفعه العميل
// فعلاً **شاملاً الضريبة**، وvat = جزء الضريبة المتضمَّن داخل amount (لا فوقه)،
// وتُحتسب النقاط على amount كاملاً. مثال بضريبة 15%: amount=115 → vat=15.
// vat >= amount مرفوض (نفس تحقق pos-intake).
//
// يجب أن يطابق هذا الملف عقد supabase/functions/pos-intake/intake.ts
// (genericAdapter) تماماً: external_ref إلزامي غير فارغ، amount/vat أرقام
// JS حقيقية لا نصوصاً، device_id يُحذف كلياً من الحمولة إن كان فارغاً (لا
// يُرسل كنص فارغ أبداً).

export function buildPosInvoicePayload({ amount, vat, deviceId, ci }) {
  const amountNum = Number(amount);
  if (!Number.isFinite(amountNum) || amountNum <= 0) {
    throw new Error('amount يجب أن يكون رقماً أكبر من صفر');
  }

  const vatNum = Number(vat ?? '0');
  if (!Number.isFinite(vatNum) || vatNum < 0) {
    throw new Error('vat يجب أن يكون رقماً صفراً أو أكبر');
  }
  if (vatNum >= amountNum) {
    throw new Error('vat يجب أن يكون أقل من amount (الضريبة جزء متضمَّن داخل المبلغ المدفوع لا فوقه)');
  }

  const externalRef = ci
    ? `sim-${ci.runNumber}-${Date.now()}`
    : `sim-cli-${Date.now()}`;

  const metadata = ci
    ? { source: 'github-actions-simulator', run_id: ci.runId, run_number: Number(ci.runNumber) }
    : { source: 'cli-simulator' };

  const body = { external_ref: externalRef, amount: amountNum, vat: vatNum, metadata };

  const trimmedDeviceId = (deviceId || '').trim();
  if (trimmedDeviceId) body.device_id = trimmedDeviceId;

  return body;
}

// إرجاع فاتورة سابقة (نفس نقطة pos-intake، type=refund — راجع عقد الإرجاع في
// supabase/functions/pos-intake/intake.ts). refund_ref فريد تلقائياً لكل
// تشغيل، فإعادة تشغيل الأداة تُنشئ إرجاعاً جديداً (لا تكرار لنفس الإرجاع)؛
// المبلغ شامل الضريبة كما في الفاتورة، والمجاميع التراكمية لا تتجاوز مبلغ
// الفاتورة (يرفضها الخادم).
export function buildPosRefundPayload({ refundOf, refundAmount, ci }) {
  const original = (refundOf || '').trim();
  if (!original) {
    throw new Error('refund_of (external_ref الفاتورة الأصلية) مطلوب');
  }
  const amountNum = Number(refundAmount);
  if (!Number.isFinite(amountNum) || amountNum <= 0) {
    throw new Error('refund_amount يجب أن يكون رقماً أكبر من صفر');
  }

  const refundRef = ci
    ? `sim-refund-${ci.runNumber}-${Date.now()}`
    : `sim-refund-cli-${Date.now()}`;

  const metadata = ci
    ? { source: 'github-actions-simulator', run_id: ci.runId, run_number: Number(ci.runNumber) }
    : { source: 'cli-simulator' };

  return { type: 'refund', external_ref: original, refund_ref: refundRef, refund_amount: amountNum, metadata };
}
