import { assertEquals } from 'jsr:@std/assert@1';
import { buildOtpMessage, handleSendSmsHook, normalizeSaPhone, verifyWebhookSignature } from './hook.ts';

const TEST_SECRET = 'whsec_dGVzdC1zZWNyZXQta2V5LWZvci1ub2otdW5pdC10ZXN0cw=='; // arbitrary, test-only

async function sign(body: string, id: string, timestamp: string, secret: string): Promise<string> {
  const clean = secret.replace(/^v1,/, '').replace(/^whsec_/, '');
  const keyBytes = Uint8Array.from(atob(clean), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('raw', keyBytes as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sigBuffer = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${id}.${timestamp}.${body}`));
  const sigBytes = new Uint8Array(sigBuffer);
  let bin = '';
  for (const b of sigBytes) bin += String.fromCharCode(b);
  return `v1,${btoa(bin)}`;
}

function samplePayload(phone = '966512345678', otp = '482913') {
  return JSON.stringify({ user: { phone }, sms: { otp } });
}

// ---------------------------------------------------------------------------
// normalizeSaPhone() — mirrors public.normalize_sa_phone() exactly
// ---------------------------------------------------------------------------
Deno.test('normalizeSaPhone: accepts country-code form (no +)', () => {
  assertEquals(normalizeSaPhone('966512345678'), '512345678');
});
Deno.test('normalizeSaPhone: accepts country-code form (with +)', () => {
  assertEquals(normalizeSaPhone('+966512345678'), '512345678');
});
Deno.test('normalizeSaPhone: accepts leading-zero local form', () => {
  assertEquals(normalizeSaPhone('0512345678'), '512345678');
});
Deno.test('normalizeSaPhone: accepts bare 9-digit form', () => {
  assertEquals(normalizeSaPhone('512345678'), '512345678');
});
Deno.test('normalizeSaPhone: rejects a non-Saudi E.164 number (e.g. Egypt)', () => {
  assertEquals(normalizeSaPhone('201001234567'), null);
});
Deno.test('normalizeSaPhone: rejects garbage input', () => {
  assertEquals(normalizeSaPhone('abc'), null);
});
Deno.test('normalizeSaPhone: rejects empty/undefined', () => {
  assertEquals(normalizeSaPhone(''), null);
  assertEquals(normalizeSaPhone(undefined), null);
});

Deno.test('buildOtpMessage: short Arabic message containing the exact code', () => {
  const msg = buildOtpMessage('135790');
  assertEquals(msg.includes('135790'), true);
  // one UCS-2 SMS segment is 70 chars — keep real margin, not just "fits".
  assertEquals(msg.length <= 70, true);
});

// ---------------------------------------------------------------------------
// verifyWebhookSignature()
// ---------------------------------------------------------------------------
Deno.test('verifyWebhookSignature: accepts a correctly-signed request', async () => {
  const body = samplePayload();
  const id = 'msg_test_1';
  const ts = String(Math.floor(Date.now() / 1000));
  const signature = await sign(body, id, ts, TEST_SECRET);
  const ok = await verifyWebhookSignature(body, { id, timestamp: ts, signature }, TEST_SECRET);
  assertEquals(ok, true);
});

Deno.test('verifyWebhookSignature: rejects a wrong secret', async () => {
  const body = samplePayload();
  const id = 'msg_test_2';
  const ts = String(Math.floor(Date.now() / 1000));
  const signature = await sign(body, id, ts, 'whsec_d3Jvbmctc2VjcmV0LWVudGlyZWx5LWRpZmZlcmVudA==');
  const ok = await verifyWebhookSignature(body, { id, timestamp: ts, signature }, TEST_SECRET);
  assertEquals(ok, false);
});

Deno.test('verifyWebhookSignature: rejects a tampered body (signature no longer matches)', async () => {
  const body = samplePayload();
  const id = 'msg_test_3';
  const ts = String(Math.floor(Date.now() / 1000));
  const signature = await sign(body, id, ts, TEST_SECRET);
  const tamperedBody = samplePayload('966599999999');
  const ok = await verifyWebhookSignature(tamperedBody, { id, timestamp: ts, signature }, TEST_SECRET);
  assertEquals(ok, false);
});

Deno.test('verifyWebhookSignature: rejects a request with no signature headers at all', async () => {
  const body = samplePayload();
  const ok = await verifyWebhookSignature(body, { id: null, timestamp: null, signature: null }, TEST_SECRET);
  assertEquals(ok, false);
});

Deno.test('verifyWebhookSignature: rejects a replayed/expired timestamp outside the tolerance window', async () => {
  const body = samplePayload();
  const id = 'msg_test_old';
  const oldTs = String(Math.floor(Date.now() / 1000) - 3600); // an hour old
  const signature = await sign(body, id, oldTs, TEST_SECRET);
  const ok = await verifyWebhookSignature(body, { id, timestamp: oldTs, signature }, TEST_SECRET);
  assertEquals(ok, false);
});

// ---------------------------------------------------------------------------
// handleSendSmsHook() — the 4 scenarios asked for: success, provider
// failure, non-Saudi number, wrong signature.
// ---------------------------------------------------------------------------
async function signedHeaders(body: string, secret = TEST_SECRET) {
  const id = 'msg_' + crypto.randomUUID();
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = await sign(body, id, timestamp, secret);
  return { id, timestamp, signature };
}

Deno.test('handleSendSmsHook: success path returns 200 and calls the provider exactly once', async () => {
  const body = samplePayload('966512345678', '111222');
  const headers = await signedHeaders(body);
  let calls = 0;
  let sentMessage = '';
  const result = await handleSendSmsHook(body, headers, {
    secret: TEST_SECRET,
    sendSms: (phone, message) => {
      calls++;
      sentMessage = message;
      assertEquals(phone, '+966512345678');
      return Promise.resolve({ ok: true });
    },
  });
  assertEquals(result.status, 200);
  assertEquals(calls, 1);
  assertEquals(sentMessage.includes('111222'), true);
});

Deno.test('handleSendSmsHook: provider failure surfaces as a 500 with the documented error shape', async () => {
  const body = samplePayload();
  const headers = await signedHeaders(body);
  const result = await handleSendSmsHook(body, headers, {
    secret: TEST_SECRET,
    sendSms: () => Promise.resolve({ ok: false, error: 'simulated Unifonic outage' }),
  });
  assertEquals(result.status, 500);
  const parsed = JSON.parse(result.body);
  assertEquals(typeof parsed.error.http_code, 'number');
  assertEquals(typeof parsed.error.message, 'string');
});

Deno.test('handleSendSmsHook: a non-Saudi phone is rejected and the provider is NEVER called', async () => {
  const body = samplePayload('201001234567'); // Egypt
  const headers = await signedHeaders(body);
  let calls = 0;
  const result = await handleSendSmsHook(body, headers, {
    secret: TEST_SECRET,
    sendSms: () => {
      calls++;
      return Promise.resolve({ ok: true });
    },
  });
  assertEquals(result.status, 400);
  assertEquals(calls, 0);
});

Deno.test('handleSendSmsHook: an unsigned/wrongly-signed request is rejected and the provider is NEVER called', async () => {
  const body = samplePayload();
  let calls = 0;
  const result = await handleSendSmsHook(
    body,
    { id: 'msg_x', timestamp: String(Math.floor(Date.now() / 1000)), signature: 'v1,bm90LXRoZS1yaWdodC1zaWc=' },
    {
      secret: TEST_SECRET,
      sendSms: () => {
        calls++;
        return Promise.resolve({ ok: true });
      },
    },
  );
  assertEquals(result.status, 401);
  assertEquals(calls, 0);
});

Deno.test('handleSendSmsHook: missing user/sms fields in an otherwise validly-signed body is rejected', async () => {
  const body = JSON.stringify({ user: {}, sms: {} });
  const headers = await signedHeaders(body);
  const result = await handleSendSmsHook(body, headers, {
    secret: TEST_SECRET,
    sendSms: () => Promise.resolve({ ok: true }),
  });
  assertEquals(result.status, 400);
});
