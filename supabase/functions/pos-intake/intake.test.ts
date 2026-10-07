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
