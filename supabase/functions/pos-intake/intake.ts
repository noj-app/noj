// NOJ — POS invoice intake endpoint, testable core.
//
// A branch's own cashier/POS system POSTs one invoice here with a per-branch
// bearer token. This file holds all the logic that can be tested without a
// live database (token→branch lookup and the actual insert are both
// injected dependencies) — index.ts is the thin real entrypoint that wires
// a real Supabase service-role client to this.
//
// CONTRACT:
//   Headers:
//     Authorization: Bearer <branch token>   (required)
//     X-POS-Vendor: <name>                   (optional, default "generic")
//   Body (JSON):
//     { "external_ref": "<string, required>",
//       "amount": <number > 0, required — the TOTAL the customer actually
//                  paid, INCLUDING VAT>,
//       "vat": <number, 0 <= vat < amount, optional, default 0 — the VAT
//              portion already CONTAINED in amount, not added on top of it>,
//       "device_id": "<uuid, optional>",
//       "metadata": {<object, optional, size-capped>} }
//   Response: {"ok": true, "transaction_id": "...", "status": "pending",
//     "external_ref": "..."} on success, {"ok": false, "error": "..."} with
//     a 4xx/5xx status otherwise. NEVER a customer phone number anywhere —
//     none exists at intake time, the customer enters it later at the kiosk.
//
// REFUNDS (same endpoint, same token, same X-POS-Vendor): a body with
// "type": "refund" is a refund of an invoice sent earlier, not a new invoice:
//     { "type": "refund",
//       "external_ref": "<the ORIGINAL invoice's external_ref, required>",
//       "refund_ref": "<unique id of THIS refund event, required — a retried
//                      webhook re-sends the same refund_ref and is never
//                      applied twice>",
//       "refund_amount": <number > 0, required — the amount handed back to the
//                        customer, INCLUDING VAT; cumulative refunds can never
//                        exceed the invoice amount>,
//       "metadata": {<object, optional, size-capped>} }
//   Response: {"ok": true, "refund": {outcome, invoice_id, refund_amount,
//     refunded_total, invoice_status, points_cancelled, points_deducted,
//     points_unrecovered, replayed}}. All logic lives in intake_pos_refund()
//     (supabase-migration-pos-refunds.sql), the single refund entry point for
//     every adapter. No "type" (or any other value) = an invoice, exactly as
//     before.
//
// ACCOUNTING RULE (fixed decision, CLAUDE.md): amount is the gross total
// paid; vat is the part of that total that is VAT. Loyalty points are
// computed on the whole amount (VAT included). A vendor adapter must map its
// "total paid" figure to amount — never its pre-tax subtotal, and never
// subtotal + vat summed a second time. vat >= amount is rejected: a tax
// portion cannot be the whole payment or exceed it (also enforced inside
// intake_pos_transaction(), the single choke point every adapter ends at).
//
// Re-posting the SAME external_ref for the SAME branch returns the ORIGINAL
// transaction unchanged (idempotent) — never a duplicate row, never an
// error, and never silently merges a retry's (possibly different) amount
// into an already-pending or already-claimed row. Enforced in
// intake_pos_transaction() (supabase-migration-pos-intake.sql), not here.
//
// NEVER logs the bearer token or its hash anywhere.

const MAX_BODY_BYTES = 10_000; // 10KB — a single invoice payload has no business being larger
const MAX_EXTERNAL_REF_LENGTH = 200;
const MAX_METADATA_JSON_LENGTH = 2000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface RequestHeaders {
  authorization: string | null;
  posVendor: string | null;
}

export interface NormalizedPayload {
  externalRef: string;
  amount: number;
  vat: number;
  deviceId: string | null;
  metadata: Record<string, unknown> | null;
}

export interface PosTransactionRow {
  id: string;
  status: string;
  external_ref: string | null;
}

export interface IntakeResult {
  ok: boolean;
  row?: PosTransactionRow;
  error?: string;
}

export interface IntakeDeps {
  lookupBranchByTokenHash: (tokenHash: string) => Promise<string | null>;
  intakeTransaction: (args: {
    branchId: string;
    deviceId: string | null;
    externalRef: string;
    amount: number;
    vat: number;
    sourceAdapter: string;
    metadata: Record<string, unknown> | null;
  }) => Promise<IntakeResult>;
  // optional so a deployment/test that only handles invoices stays valid
  intakeRefund?: (args: {
    branchId: string;
    externalRef: string;
    refundRef: string;
    refundAmount: number;
    sourceAdapter: string;
    metadata: Record<string, unknown> | null;
  }) => Promise<RefundResult>;
}

export interface NormalizedRefund {
  externalRef: string;
  refundRef: string;
  refundAmount: number;
  metadata: Record<string, unknown> | null;
}

export interface RefundResult {
  ok: boolean;
  result?: Record<string, unknown>;
  error?: string;
}

export interface HandlerResult {
  status: number;
  body: string;
}

function errorResult(status: number, message: string): HandlerResult {
  return { status, body: JSON.stringify({ ok: false, error: message }) };
}

export async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * The "generic" adapter: the body must already be in NOJ's normalized
 * shape. Vendor-specific adapters (added later, one per POS system) would
 * instead translate THEIR native payload shape into this same
 * NormalizedPayload — the rest of the pipeline never changes.
 */
function genericAdapter(raw: unknown): NormalizedPayload {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('حمولة غير صالحة');
  }
  const r = raw as Record<string, unknown>;

  if (typeof r.external_ref !== 'string' || r.external_ref.length === 0) {
    throw new Error('external_ref مطلوب');
  }
  if (r.external_ref.length > MAX_EXTERNAL_REF_LENGTH) {
    throw new Error('external_ref أطول من المسموح');
  }

  if (typeof r.amount !== 'number' || !Number.isFinite(r.amount) || r.amount <= 0) {
    throw new Error('amount يجب أن يكون رقماً أكبر من صفر');
  }

  let vat = 0;
  if (r.vat !== undefined && r.vat !== null) {
    if (typeof r.vat !== 'number' || !Number.isFinite(r.vat) || r.vat < 0) {
      throw new Error('vat يجب أن يكون رقماً صفراً أو أكبر');
    }
    vat = r.vat;
  }
  if (vat >= r.amount) {
    throw new Error('vat يجب أن يكون أقل من amount (الضريبة جزء متضمَّن داخل المبلغ المدفوع لا فوقه)');
  }

  let deviceId: string | null = null;
  if (r.device_id !== undefined && r.device_id !== null) {
    if (typeof r.device_id !== 'string' || !UUID_RE.test(r.device_id)) {
      throw new Error('device_id غير صالح');
    }
    deviceId = r.device_id;
  }

  let metadata: Record<string, unknown> | null = null;
  if (r.metadata !== undefined && r.metadata !== null) {
    if (typeof r.metadata !== 'object' || Array.isArray(r.metadata)) {
      throw new Error('metadata يجب أن يكون كائناً');
    }
    const json = JSON.stringify(r.metadata);
    if (json.length > MAX_METADATA_JSON_LENGTH) {
      throw new Error('metadata أكبر من المسموح');
    }
    metadata = r.metadata as Record<string, unknown>;
  }

  return { externalRef: r.external_ref, amount: r.amount, vat, deviceId, metadata };
}

function genericRefundAdapter(raw: unknown): NormalizedRefund {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('حمولة غير صالحة');
  }
  const r = raw as Record<string, unknown>;

  if (typeof r.external_ref !== 'string' || r.external_ref.length === 0) {
    throw new Error('external_ref مطلوب (مرجع الفاتورة الأصلية)');
  }
  if (r.external_ref.length > MAX_EXTERNAL_REF_LENGTH) {
    throw new Error('external_ref أطول من المسموح');
  }
  if (typeof r.refund_ref !== 'string' || r.refund_ref.length === 0) {
    throw new Error('refund_ref مطلوب (معرّف عملية الإرجاع نفسها)');
  }
  if (r.refund_ref.length > MAX_EXTERNAL_REF_LENGTH) {
    throw new Error('refund_ref أطول من المسموح');
  }
  if (typeof r.refund_amount !== 'number' || !Number.isFinite(r.refund_amount) || r.refund_amount <= 0) {
    throw new Error('refund_amount يجب أن يكون رقماً أكبر من صفر');
  }

  let metadata: Record<string, unknown> | null = null;
  if (r.metadata !== undefined && r.metadata !== null) {
    if (typeof r.metadata !== 'object' || Array.isArray(r.metadata)) {
      throw new Error('metadata يجب أن يكون كائناً');
    }
    if (JSON.stringify(r.metadata).length > MAX_METADATA_JSON_LENGTH) {
      throw new Error('metadata أكبر من المسموح');
    }
    metadata = r.metadata as Record<string, unknown>;
  }

  return { externalRef: r.external_ref, refundRef: r.refund_ref, refundAmount: r.refund_amount, metadata };
}

const ADAPTERS: Record<string, (raw: unknown) => NormalizedPayload> = {
  generic: genericAdapter,
};

const REFUND_ADAPTERS: Record<string, (raw: unknown) => NormalizedRefund> = {
  generic: genericRefundAdapter,
};

const REFUND_ERRORS: Record<string, [number, string]> = {
  NOJ_REFUND_ORIGINAL_NOT_FOUND: [404, 'الفاتورة الأصلية غير موجودة لهذا الفرع'],
  NOJ_REFUND_EXCEEDS_AMOUNT: [400, 'مجموع المبالغ المُرجَعة يتجاوز مبلغ الفاتورة'],
  NOJ_REFUND_NOT_APPLICABLE: [409, 'إرجاع جزئي لعملية لم يُطالَب بها بعد — أعد المحاولة بعد أن يُدخل العميل رقمه'],
  NOJ_INVALID_REFUND: [400, 'بيانات الإرجاع غير صالحة'],
};

export async function handlePosIntake(
  rawBody: string,
  headers: RequestHeaders,
  deps: IntakeDeps,
): Promise<HandlerResult> {
  if (rawBody.length > MAX_BODY_BYTES) {
    return errorResult(413, 'حجم الطلب أكبر من المسموح');
  }

  const auth = headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    return errorResult(401, 'رمز الدخول مفقود');
  }
  const token = auth.slice('Bearer '.length).trim();
  if (!token) {
    return errorResult(401, 'رمز الدخول مفقود');
  }

  const tokenHash = await sha256Hex(token);
  const branchId = await deps.lookupBranchByTokenHash(tokenHash);
  if (!branchId) {
    return errorResult(401, 'رمز الدخول غير صالح');
  }

  const vendor = headers.posVendor || 'generic';
  const adapter = ADAPTERS[vendor];
  if (!adapter) {
    return errorResult(400, `مزوّد كاشير غير مدعوم: ${vendor}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch (e) {
    return errorResult(400, e instanceof Error ? e.message : 'حمولة غير صالحة');
  }

  if (typeof parsed === 'object' && parsed !== null && (parsed as Record<string, unknown>).type === 'refund') {
    return await handleRefund(parsed, branchId, vendor, deps);
  }

  let payload: NormalizedPayload;
  try {
    payload = adapter(parsed);
  } catch (e) {
    return errorResult(400, e instanceof Error ? e.message : 'حمولة غير صالحة');
  }

  const result = await deps.intakeTransaction({
    branchId,
    deviceId: payload.deviceId,
    externalRef: payload.externalRef,
    amount: payload.amount,
    vat: payload.vat,
    sourceAdapter: vendor,
    metadata: payload.metadata,
  });

  if (!result.ok || !result.row) {
    if (result.error === 'NOJ_DEVICE_NOT_IN_BRANCH') {
      return errorResult(400, 'الجهاز المحدَّد لا يتبع هذا الفرع');
    }
    if (result.error === 'NOJ_INVALID_VAT') {
      return errorResult(400, 'vat يجب أن يكون أقل من amount (الضريبة جزء متضمَّن داخل المبلغ المدفوع لا فوقه)');
    }
    console.error('pos-intake: insert failed for branch ending in', branchId.slice(-6), result.error);
    return errorResult(500, 'تعذّر تسجيل العملية، حاول مرة أخرى');
  }

  return {
    status: 200,
    body: JSON.stringify({
      ok: true,
      transaction_id: result.row.id,
      status: result.row.status,
      external_ref: result.row.external_ref,
    }),
  };
}

async function handleRefund(
  parsed: unknown,
  branchId: string,
  vendor: string,
  deps: IntakeDeps,
): Promise<HandlerResult> {
  const refundAdapter = REFUND_ADAPTERS[vendor];
  if (!refundAdapter) {
    return errorResult(400, `مزوّد كاشير غير مدعوم للإرجاع: ${vendor}`);
  }
  if (!deps.intakeRefund) {
    console.error('pos-intake: refund requested but intakeRefund is not wired');
    return errorResult(500, 'الخدمة غير مُهيَّأة للإرجاع');
  }

  let refund: NormalizedRefund;
  try {
    refund = refundAdapter(parsed);
  } catch (e) {
    return errorResult(400, e instanceof Error ? e.message : 'حمولة غير صالحة');
  }

  const result = await deps.intakeRefund({
    branchId,
    externalRef: refund.externalRef,
    refundRef: refund.refundRef,
    refundAmount: refund.refundAmount,
    sourceAdapter: vendor,
    metadata: refund.metadata,
  });

  if (!result.ok || !result.result) {
    const known = result.error ? REFUND_ERRORS[result.error] : undefined;
    if (known) return errorResult(known[0], known[1]);
    console.error('pos-intake: refund failed for branch ending in', branchId.slice(-6), result.error);
    return errorResult(500, 'تعذّر تسجيل الإرجاع، حاول مرة أخرى');
  }

  return { status: 200, body: JSON.stringify({ ok: true, refund: result.result }) };
}
