const { Client } = require('pg');
const { execSync } = require('child_process');
const crypto = require('crypto');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..');
const CONN = { host: '127.0.0.1', port: 5432, user: 'postgres', password: 'postgres', database: 'noj_test' };
let pass = 0, fail = 0;
const failures = [];
function check(label, cond) {
  if (cond) { pass++; console.log('PASS -', label); }
  else { fail++; failures.push(label); console.log('FAIL -', label); }
}

async function asUser(uid, fn) {
  const c = new Client(CONN);
  await c.connect();
  await c.query('set role authenticated');
  await c.query('select test.set_auth_uid($1)', [uid]);
  try { return await fn(c); } finally { await c.end(); }
}
async function admin(fn) {
  const c = new Client(CONN);
  await c.connect();
  try { return await fn(c); } finally { await c.end(); }
}
async function newClaimedUser(phone) {
  const uid = crypto.randomUUID();
  await admin(c => c.query('insert into auth.users (id) values ($1)', [uid]));
  const prof = await asUser(uid, c => c.query('select * from claim_or_create_profile($1) as p', [phone]));
  return { uid, profileId: prof.rows[0].id };
}

(async () => {
  console.log('Rebuilding noj_test from scratch (base schema + lockdown fix, NOT the branches/ledger family)...');
  execSync(`su postgres -c "psql -q -c 'drop database if exists noj_test;'"`);
  execSync(`su postgres -c "psql -q -c 'create database noj_test;'"`);
  execSync(`su postgres -c "psql -q -c \\"alter role postgres password 'postgres';\\""`);
  // 00_auth_stub.sql lives in this directory; every supabase-*.sql file
  // being tested lives at the repo root, exactly as committed.
  const files = [
    path.join(__dirname, '00_auth_stub.sql'),
    ...[
      'supabase-schema.sql', 'supabase-migration-merchant-features.sql',
      'supabase-migration-merchant-loyalty.sql', 'supabase-migration-health-center.sql',
      'supabase-migration-fix-profile-reclaim.sql', 'supabase-migration-cleanup-demo-data.sql',
      'supabase-migration-lockdown-direct-writes.sql',
    ].map(f => path.join(REPO_ROOT, f)),
  ];
  for (const f of files) {
    execSync(`su postgres -c "psql -q -v ON_ERROR_STOP=1 -d noj_test -f '${f}'"`, { stdio: 'pipe' });
  }
  console.log('Rebuild done.\n');

  const MATAM = '20000000-0000-0000-0000-000000000001'; // مطعم مذاق
  const CLINIC = '21000000-0000-0000-0000-000000000001';
  const HEALTH_MERCHANT = '20000000-0000-0000-0000-00000000000d';

  const alice = await newClaimedUser('561111111');
  const bob = await newClaimedUser('562222222');

  // seed a merchant_loyalty row for alice, an appointment for alice, and a
  // queue ticket for alice, to have real rows to attack.
  await admin(c => c.query(
    `insert into merchant_loyalty (user_id, merchant_id, points) values ($1,$2,100) on conflict (user_id, merchant_id) do update set points=100`,
    [alice.profileId, MATAM]
  ));
  const apptId = crypto.randomUUID();
  await admin(c => c.query(
    `insert into appointments (id, user_id, merchant_id, clinic_id, scheduled_at, status) values ($1,$2,$3,$4, now() + interval '1 day', 'confirmed')`,
    [apptId, alice.profileId, HEALTH_MERCHANT, CLINIC]
  ));
  const ticketId = crypto.randomUUID();
  await admin(c => c.query(
    `insert into queue_tickets (id, user_id, merchant_id, ticket_number, status) values ($1,$2,$3,99,'waiting')`,
    [ticketId, alice.profileId, MATAM]
  ));

  // =========================================================================
  // 1) DIRECT UPDATE on all four tables must fail for the OWNING user
  //    themselves (not just for a stranger) — the whole point is that
  //    OWNERSHIP is no longer sufficient to write the value directly.
  // =========================================================================
  async function attemptDirectUpdate(uid, sql, params) {
    try { await asUser(uid, c => c.query(sql, params)); return 'ok'; }
    catch (e) { return 'fail:' + e.message; }
  }

  const r1 = await attemptDirectUpdate(alice.uid, `update merchant_loyalty set points=999999 where user_id=$1 and merchant_id=$2`, [alice.profileId, MATAM]);
  console.log('  direct update merchant_loyalty (as owner):', r1);
  check('LOCKDOWN: owner cannot directly UPDATE merchant_loyalty.points', r1 !== 'ok' && /permission denied|policy/i.test(r1));

  const r2 = await attemptDirectUpdate(alice.uid, `update appointments set status='confirmed' where id=$1`, [apptId]);
  console.log('  direct update appointments (as owner):', r2);
  check('LOCKDOWN: owner cannot directly UPDATE appointments.status', r2 !== 'ok' && /permission denied|policy/i.test(r2));

  const r3 = await attemptDirectUpdate(alice.uid, `update profiles set phone='599999999' where id=$1`, [alice.profileId]);
  console.log('  direct update profiles.phone (as owner):', r3);
  check('LOCKDOWN: owner cannot directly UPDATE profiles.phone', r3 !== 'ok' && /permission denied|policy/i.test(r3));

  const r4 = await attemptDirectUpdate(alice.uid, `update queue_tickets set status='done' where id=$1`, [ticketId]);
  console.log('  direct update queue_tickets (as owner):', r4);
  check('LOCKDOWN: owner cannot directly UPDATE queue_tickets.status', r4 !== 'ok' && /permission denied|policy/i.test(r4));

  // confirm the balance/appointment/ticket are UNCHANGED after the failed attempts
  const mlAfter = await admin(c => c.query('select points from merchant_loyalty where user_id=$1 and merchant_id=$2', [alice.profileId, MATAM]));
  check('LOCKDOWN: merchant_loyalty.points is untouched (still 100) after the failed attempt', mlAfter.rows[0].points === 100);
  const apptAfter = await admin(c => c.query('select status from appointments where id=$1', [apptId]));
  check('LOCKDOWN: appointments.status is untouched (still confirmed) after the failed attempt', apptAfter.rows[0].status === 'confirmed');

  // =========================================================================
  // 2) LEGITIMATE paths still work
  // =========================================================================
  const rewardId = crypto.randomUUID();
  await admin(c => c.query(
    `insert into rewards (id, merchant_id, title, cost_points, active) values ($1,$2,'مكافأة اختبار القفل',60,true)`,
    [rewardId, MATAM]
  ));
  const redeemRes = await asUser(alice.uid, async c => {
    try { const r = await c.query('select * from redeem_reward($1)', [rewardId]); return { ok: true, points: r.rows[0].points }; }
    catch (e) { return { ok: false, msg: e.message }; }
  });
  console.log('  redeem_reward (legit path):', JSON.stringify(redeemRes));
  check('legit path: redeem_reward() still works after SECURITY DEFINER conversion', redeemRes.ok && redeemRes.points === 40);

  // =========================================================================
  // 3) cancel_appointment(): works for the owner, fails for someone else's
  // =========================================================================
  const bobApptId = crypto.randomUUID();
  await admin(c => c.query(
    `insert into appointments (id, user_id, merchant_id, clinic_id, scheduled_at, status) values ($1,$2,$3,$4, now() + interval '2 days', 'confirmed')`,
    [bobApptId, bob.profileId, HEALTH_MERCHANT, CLINIC]
  ));

  const stealCancel = await asUser(alice.uid, async c => {
    try { await c.query('select * from cancel_appointment($1)', [bobApptId]); return 'ok'; }
    catch (e) { return 'fail:' + e.message; }
  });
  console.log('  alice tries to cancel BOB\'s appointment:', stealCancel);
  check('cancel_appointment: cannot cancel a DIFFERENT profile\'s appointment', stealCancel !== 'ok' && (/لا يخصّك|not found|null/i.test(stealCancel) || stealCancel.startsWith('fail:')));

  const bobApptStillConfirmed = await admin(c => c.query('select status from appointments where id=$1', [bobApptId]));
  check('cancel_appointment: bob\'s appointment is untouched after alice\'s failed attempt', bobApptStillConfirmed.rows[0].status === 'confirmed');

  const ownCancel = await asUser(alice.uid, async c => {
    try { const r = await c.query('select * from cancel_appointment($1)', [apptId]); return { ok: true, status: r.rows[0].status }; }
    catch (e) { return { ok: false, msg: e.message }; }
  });
  console.log('  alice cancels her OWN appointment:', JSON.stringify(ownCancel));
  check('cancel_appointment: owner CAN cancel their own appointment', ownCancel.ok && ownCancel.status === 'cancelled');

  const doubleCancel = await asUser(alice.uid, async c => {
    try { await c.query('select * from cancel_appointment($1)', [apptId]); return 'ok'; }
    catch (e) { return 'fail:' + e.message; }
  });
  check('cancel_appointment: cannot cancel an already-cancelled appointment again', doubleCancel !== 'ok');

  // =========================================================================
  // 4) redeem_reward RACE CONDITION safety survives the SECURITY DEFINER
  //    conversion (this is the whole point of re-testing it, not assuming).
  // =========================================================================
  await admin(c => c.query(`update merchant_loyalty set points=300 where user_id=$1 and merchant_id=$2`, [alice.profileId, MATAM]));
  const raceRewardId = crypto.randomUUID();
  await admin(c => c.query(
    `insert into rewards (id, merchant_id, title, cost_points, active) values ($1,$2,'مكافأة اختبار التسابق 2',250,true)`,
    [raceRewardId, MATAM]
  ));
  const attempt = () => asUser(alice.uid, async c => {
    try { await c.query('select redeem_reward($1)', [raceRewardId]); return 'ok'; }
    catch (e) { return 'fail:' + e.message; }
  });
  const [ra, rb] = await Promise.all([attempt(), attempt()]);
  console.log('  concurrent redemptions after SECURITY DEFINER conversion:', ra, '|', rb);
  const okCount = [ra, rb].filter(r => r === 'ok').length;
  check('redeem_reward after SECURITY DEFINER conversion: exactly one of two concurrent redemptions succeeds', okCount === 1);
  const finalBal = await admin(c => c.query('select points from merchant_loyalty where user_id=$1 and merchant_id=$2', [alice.profileId, MATAM]));
  check('redeem_reward after SECURITY DEFINER conversion: final balance is 300-250=50, not negative/double-deducted', finalBal.rows[0].points === 50);

  // =========================================================================
  // 5) search_path hijack cannot affect a SECURITY DEFINER function: create
  //    a decoy object in a schema the attacker controls, put it FIRST in
  //    their own session's search_path, and confirm redeem_reward still
  //    resolves public.rewards/public.merchant_loyalty — never the decoy —
  //    because `set search_path = public` inside the function pins it
  //    regardless of the CALLER's own search_path setting.
  // =========================================================================
  await admin(c => c.query(`create schema if not exists evil`));
  await admin(c => c.query(`grant usage, create on schema evil to authenticated`));
  const hijackResult = await asUser(alice.uid, async c => {
    await c.query(`set search_path = evil, public`);
    // a decoy "rewards" table that would make any UNqualified reference to
    // "rewards" resolve here first, if search_path pinning inside the
    // function did not protect against it.
    await c.query(`create table if not exists evil.rewards (id uuid, merchant_id uuid, title text, cost_points int, active boolean)`);
    await c.query(`insert into evil.rewards values ($1, $2, 'مكافأة مزيفة', 1, true)`, [raceRewardId, MATAM]);
    try {
      const r = await c.query('select * from redeem_reward($1)', [raceRewardId]);
      return { ok: true, points: r.rows[0].points };
    } catch (e) { return { ok: false, msg: e.message }; }
  });
  console.log('  search_path hijack attempt result:', JSON.stringify(hijackResult));
  // with only 50 points left (from the race test above) and the REAL
  // rewards row costing 250, a real redeem_reward must still refuse for
  // insufficient balance — if it had been fooled into reading evil.rewards
  // (cost_points=1) instead, it would have wrongly succeeded.
  check('search_path pinning: redeem_reward ignores a same-named decoy table in the caller\'s search_path', !hijackResult.ok && /غير كافٍ/.test(hijackResult.msg));

  console.log('\n=== LOCKDOWN SUMMARY:', pass, 'passed,', fail, 'failed ===');
  if (failures.length) console.log('Failures:', JSON.stringify(failures, null, 2));
  process.exit(fail > 0 ? 1 : 0);
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
