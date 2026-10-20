import { assertEquals } from 'jsr:@std/assert@1';
import { handlePosIntake, sha256Hex } from './intake.ts';
import type { IntakeDeps, PosTransactionRow } from './intake.ts';

const VALID_TOKEN = 'a-very-long-random-branch-token-value';
const BRANCH_ID = '11111111-1111-1111-1111-111111111111';
const DEVICE_ID = '22222222-2222-2222-2222-222222222222';
const OTHER_BRANCH_DEVICE_ID = '33333333-3333-3333-3333-333333333333';

function makeDeps(overrides: Partial<IntakeDeps> = {}): IntakeDeps {
  return {
    lookupBranchByTokenHash: async (hash) => {
      const validHash = await sha256Hex(VALID_TOKEN);
      return hash === validHash ? BRANCH_ID : null;
    },
    intakeTransaction: (args) => {
      if (args.deviceId === OTHER_BRANCH_DEVICE_ID) {
        return Promise.resolve({ ok: false, error: 'NOJ_DEVICE_NOT_IN_BRANCH' });
      }
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

function headers(token: string | null, vendor: string | null = null) {
  return {
    authorization: token ? `Bearer ${token}` : null,
    posVendor: vendor,
  };
}

Deno.test('handlePosIntake: valid token + valid payload succeeds', async () => {
  const body = JSON.stringify({ external_ref: 'INV-1', amount: 50 });
  const result = await handlePosIntake(body, headers(VALID_TOKEN), makeDeps());
  assertEquals(result.status, 200);
  const parsed = JSON.parse(result.body);
  assertEquals(parsed.ok, true);
  assertEquals(parsed.external_ref, 'INV-1');
});

Deno.test('handlePosIntake: missing Authorization header is rejected', async () => {
  const body = JSON.stringify({ external_ref: 'INV-2', amount: 50 });
  const result = await handlePosIntake(body, headers(null), makeDeps());
  assertEquals(result.status, 401);
});

Deno.test('handlePosIntake: wrong token is rejected, no DB insert attempted', async () => {
  let calls = 0;
  const deps = makeDeps({ intakeTransaction: (args) => { calls++; return Promise.resolve({ ok: true, row: { id: 'x', status: 'pending', external_ref: args.externalRef } }); } });
  const body = JSON.stringify({ external_ref: 'INV-3', amount: 50 });
  const result = await handlePosIntake(body, headers('wrong-token-entirely'), deps);
  assertEquals(result.status, 401);
  assertEquals(calls, 0);
});

Deno.test('handlePosIntake: re-posting the SAME external_ref returns the SAME transaction (idempotent)', async () => {
  const seen: Record<string, PosTransactionRow> = {};
  const deps = makeDeps({
    intakeTransaction: (args) => {
      if (!seen[args.externalRef]) {
        seen[args.externalRef] = { id: 'txn-fixed-id', status: 'pending', external_ref: args.externalRef };
      }
      // simulate the DB's no-op-upsert: always return the ORIGINAL row,
      // ignoring this call's (possibly different) amount.
      return Promise.resolve({ ok: true, row: seen[args.externalRef] });
    },
  });
  const first = await handlePosIntake(JSON.stringify({ external_ref: 'INV-DUP', amount: 50 }), headers(VALID_TOKEN), deps);
  const second = await handlePosIntake(JSON.stringify({ external_ref: 'INV-DUP', amount: 999 }), headers(VALID_TOKEN), deps);
  assertEquals(first.status, 200);
  assertEquals(second.status, 200);
  assertEquals(JSON.parse(first.body).transaction_id, JSON.parse(second.body).transaction_id);
});

Deno.test('handlePosIntake: device_id belonging to another branch is rejected with a clear 400', async () => {
  const body = JSON.stringify({ external_ref: 'INV-4', amount: 50, device_id: OTHER_BRANCH_DEVICE_ID });
  const result = await handlePosIntake(body, headers(VALID_TOKEN), makeDeps());
  assertEquals(result.status, 400);
});

Deno.test('handlePosIntake: device_id belonging to the SAME branch succeeds', async () => {
  const body = JSON.stringify({ external_ref: 'INV-5', amount: 50, device_id: DEVICE_ID });
  const result = await handlePosIntake(body, headers(VALID_TOKEN), makeDeps());
  assertEquals(result.status, 200);
});

Deno.test('handlePosIntake: zero/negative amount is rejected', async () => {
  const body = JSON.stringify({ external_ref: 'INV-6', amount: 0 });
  const result = await handlePosIntake(body, headers(VALID_TOKEN), makeDeps());
  assertEquals(result.status, 400);
});

Deno.test('handlePosIntake: missing external_ref is rejected', async () => {
  const body = JSON.stringify({ amount: 50 });
  const result = await handlePosIntake(body, headers(VALID_TOKEN), makeDeps());
  assertEquals(result.status, 400);
});

Deno.test('handlePosIntake: negative vat is rejected', async () => {
  const body = JSON.stringify({ external_ref: 'INV-7', amount: 50, vat: -1 });
  const result = await handlePosIntake(body, headers(VALID_TOKEN), makeDeps());
  assertEquals(result.status, 400);
});

Deno.test('handlePosIntake: vat == amount is rejected (الضريبة متضمَّنة داخل المبلغ، لا تساويه)', async () => {
  const body = JSON.stringify({ external_ref: 'INV-7a', amount: 50, vat: 50 });
  const result = await handlePosIntake(body, headers(VALID_TOKEN), makeDeps());
  assertEquals(result.status, 400);
});

Deno.test('handlePosIntake: vat > amount is rejected', async () => {
  const body = JSON.stringify({ external_ref: 'INV-7b', amount: 50, vat: 57.5 });
  const result = await handlePosIntake(body, headers(VALID_TOKEN), makeDeps());
  assertEquals(result.status, 400);
});

Deno.test('handlePosIntake: vat inclusive in amount (115 / 15) and vat just under amount are accepted', async () => {
  for (const [amount, vat] of [[115, 15], [50, 49.99], [10, 0]]) {
    const body = JSON.stringify({ external_ref: `INV-ok-${amount}-${vat}`, amount, vat });
    const result = await handlePosIntake(body, headers(VALID_TOKEN), makeDeps());
    assertEquals(result.status, 200, `amount=${amount} vat=${vat}`);
  }
});

Deno.test('handlePosIntake: DB-level NOJ_INVALID_VAT (defence in depth) maps to a clear 400, not 500', async () => {
  const deps = makeDeps({
    intakeTransaction: () => Promise.resolve({ ok: false, error: 'NOJ_INVALID_VAT' }),
  });
  const body = JSON.stringify({ external_ref: 'INV-7c', amount: 50, vat: 5 });
  const result = await handlePosIntake(body, headers(VALID_TOKEN), deps);
  assertEquals(result.status, 400);
});

Deno.test('handlePosIntake: malformed device_id (not a uuid) is rejected', async () => {
  const body = JSON.stringify({ external_ref: 'INV-8', amount: 50, device_id: 'not-a-uuid' });
  const result = await handlePosIntake(body, headers(VALID_TOKEN), makeDeps());
  assertEquals(result.status, 400);
});

Deno.test('handlePosIntake: oversized metadata is rejected', async () => {
  const body = JSON.stringify({ external_ref: 'INV-9', amount: 50, metadata: { note: 'x'.repeat(3000) } });
  const result = await handlePosIntake(body, headers(VALID_TOKEN), makeDeps());
  assertEquals(result.status, 400);
});

Deno.test('handlePosIntake: oversized request body is rejected before any parsing', async () => {
  const body = JSON.stringify({ external_ref: 'INV-10', amount: 50, metadata: { note: 'x'.repeat(20000) } });
  const result = await handlePosIntake(body, headers(VALID_TOKEN), makeDeps());
  assertEquals(result.status, 413);
});

Deno.test('handlePosIntake: unknown X-POS-Vendor is rejected', async () => {
  const body = JSON.stringify({ external_ref: 'INV-11', amount: 50 });
  const result = await handlePosIntake(body, headers(VALID_TOKEN, 'some-unknown-vendor'), makeDeps());
  assertEquals(result.status, 400);
});

Deno.test('handlePosIntake: explicit generic vendor works the same as default', async () => {
  const body = JSON.stringify({ external_ref: 'INV-12', amount: 50 });
  const result = await handlePosIntake(body, headers(VALID_TOKEN, 'generic'), makeDeps());
  assertEquals(result.status, 200);
});

Deno.test('handlePosIntake: non-JSON body is rejected cleanly', async () => {
  const result = await handlePosIntake('not json at all {{{', headers(VALID_TOKEN), makeDeps());
  assertEquals(result.status, 400);
});

Deno.test('handlePosIntake: a generic DB error surfaces as 500, not a crash', async () => {
  const deps = makeDeps({ intakeTransaction: () => Promise.resolve({ ok: false, error: 'some unexpected db error' }) });
  const body = JSON.stringify({ external_ref: 'INV-13', amount: 50 });
  const result = await handlePosIntake(body, headers(VALID_TOKEN), deps);
  assertEquals(result.status, 500);
});

Deno.test('sha256Hex: deterministic and distinct for different inputs', async () => {
  const a = await sha256Hex('token-a');
  const b = await sha256Hex('token-a');
  const c = await sha256Hex('token-b');
  assertEquals(a, b);
  assertEquals(a === c, false);
});

// ---------------------------------------------------------------------------
// Refunds (type: "refund") — same endpoint, same token
// ---------------------------------------------------------------------------
function makeRefundDeps(
  refund: IntakeDeps['intakeRefund'],
  overrides: Partial<IntakeDeps> = {},
): IntakeDeps {
  return makeDeps({ intakeRefund: refund, ...overrides });
}

const okRefund: NonNullable<IntakeDeps['intakeRefund']> = (args) =>
  Promise.resolve({
    ok: true,
    result: { outcome: 'points_deducted', refund_amount: args.refundAmount, replayed: false },
  });

Deno.test('refund: valid payload reaches intakeRefund with the right fields and returns 200', async () => {
  let seen: Record<string, unknown> | null = null;
  const deps = makeRefundDeps((args) => {
    seen = args as unknown as Record<string, unknown>;
    return okRefund(args);
  });
  const body = JSON.stringify({ type: 'refund', external_ref: 'INV-1', refund_ref: 'RF-1', refund_amount: 40.5 });
  const result = await handlePosIntake(body, headers(VALID_TOKEN), deps);
  assertEquals(result.status, 200);
  const parsed = JSON.parse(result.body);
  assertEquals(parsed.ok, true);
  assertEquals(parsed.refund.outcome, 'points_deducted');
  assertEquals(seen!.branchId, BRANCH_ID);
  assertEquals(seen!.externalRef, 'INV-1');
  assertEquals(seen!.refundRef, 'RF-1');
  assertEquals(seen!.refundAmount, 40.5);
  assertEquals(seen!.sourceAdapter, 'generic');
});

Deno.test('refund: a refund is NEVER treated as a new invoice (no intakeTransaction call)', async () => {
  let invoiceCalls = 0;
  const deps = makeRefundDeps(okRefund, {
    intakeTransaction: (args) => {
      invoiceCalls++;
      return Promise.resolve({ ok: true, row: { id: 'x', status: 'pending', external_ref: args.externalRef } });
    },
  });
  const body = JSON.stringify({ type: 'refund', external_ref: 'INV-1', refund_ref: 'RF-1', refund_amount: 10 });
  await handlePosIntake(body, headers(VALID_TOKEN), deps);
  assertEquals(invoiceCalls, 0);
});

Deno.test('refund: requires the bearer token like any intake (no token → 401, wrong token → 401, no DB call)', async () => {
  let calls = 0;
  const deps = makeRefundDeps((a) => { calls++; return okRefund(a); });
  const body = JSON.stringify({ type: 'refund', external_ref: 'INV-1', refund_ref: 'RF-1', refund_amount: 10 });
  assertEquals((await handlePosIntake(body, headers(null), deps)).status, 401);
  assertEquals((await handlePosIntake(body, headers('wrong-token-value'), deps)).status, 401);
  assertEquals(calls, 0);
});

Deno.test('refund: missing/invalid fields are rejected with 400 before any DB call', async () => {
  let calls = 0;
  const deps = makeRefundDeps((a) => { calls++; return okRefund(a); });
  const bad = [
    { type: 'refund', refund_ref: 'RF', refund_amount: 5 },                         // no external_ref
    { type: 'refund', external_ref: 'INV', refund_amount: 5 },                      // no refund_ref
    { type: 'refund', external_ref: 'INV', refund_ref: 'RF' },                      // no amount
    { type: 'refund', external_ref: 'INV', refund_ref: 'RF', refund_amount: 0 },    // zero
    { type: 'refund', external_ref: 'INV', refund_ref: 'RF', refund_amount: -3 },   // negative
    { type: 'refund', external_ref: 'INV', refund_ref: 'RF', refund_amount: '5' },  // string
    { type: 'refund', external_ref: 'INV', refund_ref: 'RF', refund_amount: 5, metadata: [1] },
    { type: 'refund', external_ref: 'INV', refund_ref: 'RF', refund_amount: 5, metadata: { x: 'y'.repeat(2500) } },
  ];
  for (const b of bad) {
    const r = await handlePosIntake(JSON.stringify(b), headers(VALID_TOKEN), deps);
    assertEquals(r.status, 400, JSON.stringify(b).slice(0, 80));
  }
  assertEquals(calls, 0);
});

Deno.test('refund: database errors map to clear statuses (404 / 400 / 409), unknown → 500', async () => {
  const cases: Array<[string, number]> = [
    ['NOJ_REFUND_ORIGINAL_NOT_FOUND', 404],
    ['NOJ_REFUND_EXCEEDS_AMOUNT', 400],
    ['NOJ_REFUND_NOT_APPLICABLE', 409],
    ['NOJ_INVALID_REFUND', 400],
    ['something unexpected', 500],
  ];
  for (const [err, status] of cases) {
    const deps = makeRefundDeps(() => Promise.resolve({ ok: false, error: err }));
    const body = JSON.stringify({ type: 'refund', external_ref: 'INV', refund_ref: 'RF', refund_amount: 5 });
    const r = await handlePosIntake(body, headers(VALID_TOKEN), deps);
    assertEquals(r.status, status, err);
  }
});

Deno.test('refund: unsupported vendor and a deployment without refund wiring fail cleanly', async () => {
  const body = JSON.stringify({ type: 'refund', external_ref: 'INV', refund_ref: 'RF', refund_amount: 5 });
  assertEquals((await handlePosIntake(body, headers(VALID_TOKEN, 'nope'), makeRefundDeps(okRefund))).status, 400);
  assertEquals((await handlePosIntake(body, headers(VALID_TOKEN), makeDeps())).status, 500);
});

Deno.test('invoices are unchanged: a body without type still goes to intakeTransaction; "type":"invoice"-like extras are ignored as before', async () => {
  const body = JSON.stringify({ external_ref: 'INV-9', amount: 50, type: 'sale' });
  const r = await handlePosIntake(body, headers(VALID_TOKEN), makeRefundDeps(okRefund));
  assertEquals(r.status, 200);
  assertEquals(JSON.parse(r.body).transaction_id, 'txn-INV-9');
});
