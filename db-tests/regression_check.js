const { Client } = require('pg');
const CONN = { host: '127.0.0.1', port: 5432, user: 'postgres', password: 'postgres', database: 'noj_test' };
let pass = 0, fail = 0;
function check(label, cond) { if (cond) { pass++; console.log('PASS -', label); } else { fail++; console.log('FAIL -', label); } }

(async () => {
  const c = new Client(CONN);
  await c.connect();
  const crypto = require('crypto');
  const uid = crypto.randomUUID();
  await c.query('insert into auth.users (id) values ($1)', [uid]);
  // claim_or_create_profile(text) is no longer reachable by a real client —
  // revoked from anon/authenticated (see CLAUDE.md: it trusted its phone
  // parameter blindly with no verification, found open on the live
  // project). Bind this session to the seeded demo profile directly, as
  // superuser, the same way that RPC used to internally — this check's
  // purpose is confirming the demo DATA survived migrations, not re-testing
  // that now-closed RPC (run_tests.js covers the closure itself).
  const demoProfile = await c.query(`update profiles set auth_user_id=$1 where phone='512345678' returning id, phone`, [uid]);
  check('existing app flow: the seeded demo profile is still there and binds correctly', demoProfile.rows[0].phone === '512345678');

  await c.query('set role authenticated');
  await c.query('select test.set_auth_uid($1)', [uid]);

  const ml = await c.query('select * from merchant_loyalty where user_id=$1', [demoProfile.rows[0].id]);
  check('existing app flow: merchant_loyalty rows still readable (untouched by migration)', ml.rows.length >= 3);

  const inv = await c.query('select * from invoices where user_id=$1', [demoProfile.rows[0].id]);
  check('existing app flow: invoices still readable', inv.rows.length > 0);

  const clinics = await c.query('select * from get_merchant_clinics($1)', ['20000000-0000-0000-0000-00000000000d']);
  check('existing app flow: get_merchant_clinics() RPC still works (health center)', clinics.rows.length === 5);

  const qstats = await c.query('select * from get_merchant_queue_stats($1)', ['20000000-0000-0000-0000-000000000001']);
  check('existing app flow: get_merchant_queue_stats() RPC still works', qstats.rows.length >= 1);

  const rewards = await c.query('select * from rewards where active = true');
  check('existing app flow: rewards catalog still readable', rewards.rows.length > 0);

  await c.end();
  console.log('\n=== REGRESSION SUMMARY:', pass, 'passed,', fail, 'failed ===');
  process.exit(fail > 0 ? 1 : 0);
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
