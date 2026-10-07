// NOJ — pos-intake entrypoint (real Deno.serve + real Supabase service-role
// client). All logic lives in intake.ts so it can be unit-tested without a
// live database — this file is intentionally thin.
//
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected automatically by
// Supabase into every deployed Edge Function (no `supabase secrets set`
// needed for these two specifically) — confirm with `supabase secrets list`
// if they are ever missing. The service-role key bypasses RLS entirely,
// which is why branch_pos_credentials/intake_pos_transaction() can stay
// completely unreachable by anon/authenticated (see supabase-migration-
// pos-intake.sql) while still being reachable from here.

import { createClient } from 'npm:@supabase/supabase-js@2';
import { handlePosIntake } from './intake.ts';

const supabaseUrl = Deno.env.get('SUPABASE_URL');
const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

Deno.serve(async (req: Request) => {
  const rawBody = await req.text();
  const headers = {
    authorization: req.headers.get('authorization'),
    posVendor: req.headers.get('x-pos-vendor'),
  };

  if (!supabaseUrl || !serviceRoleKey) {
    console.error('pos-intake: missing SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY');
    return new Response(
      JSON.stringify({ ok: false, error: 'الخدمة غير مُهيَّأة' }),
      { status: 500, headers: { 'content-type': 'application/json' } },
    );
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey);

  const result = await handlePosIntake(rawBody, headers, {
    lookupBranchByTokenHash: async (tokenHash) => {
      const { data, error } = await supabase
        .from('branch_pos_credentials')
        .select('branch_id')
        .eq('token_hash', tokenHash)
        .maybeSingle();
      if (error || !data) return null;
      return data.branch_id as string;
    },
    intakeTransaction: async (args) => {
      const { data, error } = await supabase.rpc('intake_pos_transaction', {
        p_branch_id: args.branchId,
        p_device_id: args.deviceId,
        p_external_ref: args.externalRef,
        p_amount: args.amount,
        p_vat: args.vat,
        p_source_adapter: args.sourceAdapter,
        p_metadata: args.metadata,
      });
      if (error) {
        return { ok: false, error: error.message };
      }
      return { ok: true, row: data };
    },
  });

  return new Response(result.body, {
    status: result.status,
    headers: { 'content-type': 'application/json' },
  });
});
