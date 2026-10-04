// NOJ — thin Unifonic SMS client used by the Send SMS hook.
//
// CONFIRM BEFORE FIRST REAL SEND: this mirrors Unifonic's commonly
// documented "Send SMS" REST endpoint and response shape from general
// knowledge of their API, not a verified-live test against a real account —
// Unifonic's exact field names/response shape should be checked against
// their current API reference (and a real sandbox send) before this ever
// runs against a live phone, same as any third-party API integrated without
// live credentials in hand.

export interface UnifonicConfig {
  appSid: string;
  senderId: string;
  baseUrl?: string; // overridable for testing; defaults to Unifonic's REST endpoint
}

export interface SendSmsResult {
  ok: boolean;
  error?: string;
}

export async function sendViaUnifonic(
  phoneE164: string,
  message: string,
  config: UnifonicConfig,
): Promise<SendSmsResult> {
  const url = config.baseUrl ?? 'https://el.cloud.unifonic.com/rest/SMS/messages';

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        AppSid: config.appSid,
        SenderID: config.senderId,
        Recipient: phoneE164,
        Body: message,
        responseType: 'JSON',
      }),
    });

    const data = await res.json().catch(() => null);
    // Unifonic's documented convention: {"success": true, ...} on success,
    // {"success": false, "errorCode": ..., "message": "..."} on failure.
    if (res.ok && data && data.success === true) {
      return { ok: true };
    }
    return { ok: false, error: data?.message ?? `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'network error' };
  }
}
