// NOJ — Send SMS Hook entrypoint (real Deno.serve + real secrets + real
// Unifonic call). All actual logic lives in hook.ts/unifonic.ts so it can be
// unit-tested without a live request or live credentials — this file is
// intentionally thin: wire real inputs in, call the tested core, return
// what it says.
//
// Secrets (set via `supabase secrets set`, NEVER committed, NEVER hardcoded):
//   SEND_SMS_HOOK_SECRET — the signing secret Supabase gives you when you
//     register this function as the project's Send SMS hook.
//   UNIFONIC_APP_SID     — Unifonic account app/sender credential.
//   UNIFONIC_SENDER_ID   — the REGISTERED Arabic sender name (e.g. "NOJ").
// See supabase-phone-otp-setup.md for the manual dashboard steps.

import { handleSendSmsHook } from './hook.ts';
import { sendViaUnifonic } from './unifonic.ts';

Deno.serve(async (req: Request) => {
  const rawBody = await req.text();
  const headers = {
    id: req.headers.get('webhook-id'),
    timestamp: req.headers.get('webhook-timestamp'),
    signature: req.headers.get('webhook-signature'),
  };

  const secret = Deno.env.get('SEND_SMS_HOOK_SECRET');
  const unifonicAppSid = Deno.env.get('UNIFONIC_APP_SID');
  const unifonicSenderId = Deno.env.get('UNIFONIC_SENDER_ID');

  if (!secret || !unifonicAppSid || !unifonicSenderId) {
    console.error('send-sms-hook: missing required secret(s) — check `supabase secrets list`');
    return new Response(
      JSON.stringify({ error: { http_code: 500, message: 'الخدمة غير مُهيَّأة' } }),
      { status: 500, headers: { 'content-type': 'application/json' } },
    );
  }

  const result = await handleSendSmsHook(rawBody, headers, {
    secret,
    sendSms: (phone, message) => sendViaUnifonic(phone, message, { appSid: unifonicAppSid, senderId: unifonicSenderId }),
  });

  return new Response(result.body, {
    status: result.status,
    headers: { 'content-type': 'application/json' },
  });
});
