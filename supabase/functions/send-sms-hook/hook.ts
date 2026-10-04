// NOJ — Send SMS Hook for Supabase Auth Phone OTP.
//
// Supabase Auth calls this Edge Function instead of its own built-in SMS
// providers whenever it needs to send a phone OTP (auth.updateUser({phone})
// or auth.signInWithOtp({phone}) — wired into index.html in a later stage).
// This file holds the testable core logic only (no Deno.serve, no real
// network/env access) so `deno test` can exercise every branch with mocked
// dependencies. index.ts is the thin real entrypoint that wires this to the
// actual request/response and real secrets.
//
// CONTRACT (Supabase "Send SMS hook", Standard Webhooks spec — confirm
// against Supabase's current Auth Hooks docs before first real deploy, in
// case the exact header/payload shape has moved since this was written):
//   - Request carries `webhook-id` / `webhook-timestamp` / `webhook-signature`
//     headers, signed over "{id}.{timestamp}.{raw body}" with HMAC-SHA256
//     using the hook secret Supabase gives you when you register the hook.
//   - Body: {"user":{"phone":"<E.164 digits, no '+'>", ...}, "sms":{"otp":"<code>"}}
//   - Success: HTTP 200. Failure: Supabase expects
//     {"error":{"http_code":<n>,"message":"<text>"}} so it can surface a
//     real error to the client instead of a generic one.
//
// NEVER logs the OTP or a full phone number anywhere (requirement from the
// design) — only a masked last-2-digits fragment, for support purposes.

const WEBHOOK_TOLERANCE_SECONDS = 5 * 60; // Standard Webhooks' own recommended replay window

export interface WebhookHeaders {
  id: string | null;
  timestamp: string | null;
  signature: string | null;
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Verifies a Standard-Webhooks-style signature. `secret` is the hook secret
 * as Supabase's dashboard shows it (commonly `whsec_<base64>`, sometimes
 * with a leading `v1,` — both optional prefixes are stripped defensively;
 * confirm the exact format shown in YOUR project before first real deploy).
 */
export async function verifyWebhookSignature(
  rawBody: string,
  headers: WebhookHeaders,
  secret: string,
  nowSeconds: () => number = () => Math.floor(Date.now() / 1000),
): Promise<boolean> {
  if (!headers.id || !headers.timestamp || !headers.signature) return false;
  if (!secret) return false;

  const timestamp = Number(headers.timestamp);
  if (!Number.isFinite(timestamp)) return false;
  if (Math.abs(nowSeconds() - timestamp) > WEBHOOK_TOLERANCE_SECONDS) return false;

  const cleanSecret = secret.replace(/^v1,/, '').replace(/^whsec_/, '');
  let keyBytes: Uint8Array;
  try {
    keyBytes = base64ToBytes(cleanSecret);
  } catch {
    return false;
  }

  const signedContent = `${headers.id}.${headers.timestamp}.${rawBody}`;
  const key = await crypto.subtle.importKey(
    'raw',
    keyBytes as BufferSource,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sigBuffer = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signedContent));
  const expected = bytesToBase64(new Uint8Array(sigBuffer));

  // webhook-signature can carry several space-separated "v1,<sig>" entries
  // (key rotation) — any one matching is enough.
  const candidates = headers.signature.split(' ').map((s) => s.split(',')[1]).filter(Boolean);
  return candidates.some((c) => timingSafeEqual(c, expected));
}

/**
 * Mirrors public.normalize_sa_phone() (supabase-migration-phone-format.sql)
 * exactly: accepts 9665XXXXXXXX / 05XXXXXXXX / 5XXXXXXXX in any punctuation,
 * returns the bare 9-digit form, or null — the Saudi-only gate, kept
 * independent of and ahead of whatever the DB layer itself already enforces.
 */
export function normalizeSaPhone(raw: string | null | undefined): string | null {
  const digits = (raw ?? '').replace(/[^0-9]/g, '');
  if (/^9665[0-9]{8}$/.test(digits)) return digits.slice(3);
  if (/^05[0-9]{8}$/.test(digits)) return digits.slice(1);
  if (/^5[0-9]{8}$/.test(digits)) return digits;
  return null;
}

export function buildOtpMessage(otp: string): string {
  return `رمز التحقق الخاص بك في نوج: ${otp}`;
}

function maskPhone(phone: string): string {
  return phone.length >= 2 ? '*'.repeat(phone.length - 2) + phone.slice(-2) : '**';
}

function errorResult(httpCode: number, message: string): HookResult {
  return { status: httpCode, body: JSON.stringify({ error: { http_code: httpCode, message } }) };
}

export interface HookResult {
  status: number;
  body: string;
}

export interface HookDeps {
  secret: string;
  sendSms: (phoneE164: string, message: string) => Promise<{ ok: boolean; error?: string }>;
  nowSeconds?: () => number;
}

export async function handleSendSmsHook(
  rawBody: string,
  headers: WebhookHeaders,
  deps: HookDeps,
): Promise<HookResult> {
  const verified = await verifyWebhookSignature(rawBody, headers, deps.secret, deps.nowSeconds);
  if (!verified) {
    console.error('send-sms-hook: rejected an unsigned/invalid-signature request');
    return errorResult(401, 'توقيع الطلب غير صالح');
  }

  let payload: { user?: { phone?: string }; sms?: { otp?: string } };
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return errorResult(400, 'حمولة الطلب غير صالحة');
  }

  const rawPhone = payload.user?.phone;
  const otp = payload.sms?.otp;
  if (!rawPhone || !otp) {
    return errorResult(400, 'بيانات ناقصة في الطلب');
  }

  const phone = normalizeSaPhone(rawPhone);
  if (!phone) {
    console.error('send-sms-hook: rejected a non-Saudi phone, no Unifonic call made');
    return errorResult(400, 'لا يمكن إرسال رمز تحقق إلا لرقم سعودي');
  }

  const result = await deps.sendSms('+966' + phone, buildOtpMessage(otp));
  if (!result.ok) {
    console.error('send-sms-hook: provider send failed for phone ending in', maskPhone(phone));
    return errorResult(500, 'تعذّر إرسال رسالة التحقق، حاول مرة أخرى');
  }

  return { status: 200, body: '{}' };
}
