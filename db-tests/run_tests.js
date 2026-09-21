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
  // IMPORTANT: the 'postgres' login role owns every table (it ran the
  // migrations) and is also superuser/BYPASSRLS — either fact alone means
  // RLS policies are silently skipped for it, exactly like they are for
  // Supabase's own service_role. To actually exercise RLS the way a real
  // anon/authenticated API request would, switch the session's effective
  // role to 'authenticated' (non-owner, no BYPASSRLS) before setting the
  // JWT claim, mirroring how PostgREST authenticates as one role and then
  // SET ROLEs per request.
  await c.query('set role authenticated');
  await c.query('select test.set_auth_uid($1)', [uid]);
  try { return await fn(c); } finally { await c.end(); }
}

async function admin(fn) {
  const c = new Client(CONN);
  await c.connect();
  try { return await fn(c); } finally { await c.end(); }
}

(async () => {
  // ---------------------------------------------------------------------
  // rebuild the test database from scratch: bootstrap schema once, then
  // apply the six new migration files, exactly like a fresh project would.
  // ---------------------------------------------------------------------
  console.log('Rebuilding noj_test from scratch...');
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
      'supabase-migration-branches-devices.sql', 'supabase-migration-point-ledger.sql',
      'supabase-migration-loyalty-rate-expiry.sql', 'supabase-migration-consent-privacy.sql',
      'supabase-migration-phone-format.sql', 'supabase-migration-timezone.sql',
    ].map(f => path.join(REPO_ROOT, f)),
  ];
  for (const f of files) {
    execSync(`su postgres -c "psql -q -v ON_ERROR_STOP=1 -d noj_test -f '${f}'"`, { stdio: 'pipe' });
  }
  console.log('Rebuild done.\n');

  const MATAM = '20000000-0000-0000-0000-000000000001'; // مطعم مذاق
  const DEMO_PROFILE = '11111111-1111-1111-1111-111111111111';

  // =========================================================================
  // 1) RACE CONDITION on redemption: two concurrent redeem_reward() calls for
  //    the same profile+merchant where the balance covers exactly ONE.
  // =========================================================================
  {
    const uid = crypto.randomUUID();
    await admin(c => c.query('insert into auth.users (id) values ($1)', [uid]));
    await asUser(uid, c => c.query('select claim_or_create_profile($1)', ['512345678']));
    // demo profile already has a merchant_loyalty row at مطعم مذاق from the
    // seed (420 points). Reset it to exactly 300 so a 250-cost reward can be
    // redeemed exactly once, never twice.
    await admin(c => c.query(
      `update merchant_loyalty set points = 300 where user_id=$1 and merchant_id=$2`,
      [DEMO_PROFILE, MATAM]
    ));
    const rewardId = crypto.randomUUID();
    await admin(c => c.query(
      `insert into rewards (id, merchant_id, title, cost_points, active) values ($1,$2,'مكافأة اختبار التسابق',250,true)`,
      [rewardId, MATAM]
    ));
    const before = await admin(c => c.query('select count(*) from point_transactions where user_id=$1 and merchant_id=$2 and type=\'redeem\'', [DEMO_PROFILE, MATAM]));

    const attempt = () => asUser(uid, async c => {
      try { await c.query('select redeem_reward($1)', [rewardId]); return 'ok'; }
      catch (e) { return 'fail:' + e.message; }
    });
    const [r1, r2] = await Promise.all([attempt(), attempt()]);
    console.log('  concurrent redemption results:', r1, '|', r2);
    const okCount = [r1, r2].filter(r => r === 'ok').length;
    check('race: exactly one of two concurrent redemptions succeeds', okCount === 1);

    const balRes = await admin(c => c.query('select points from merchant_loyalty where user_id=$1 and merchant_id=$2', [DEMO_PROFILE, MATAM]));
    const finalPoints = balRes.rows[0].points;
    console.log('  final balance:', finalPoints);
    check('race: final balance is 300-250=50, not negative, not double-deducted', finalPoints === 50);

    const afterLedger = await admin(c => c.query(
      `select count(*) from point_transactions where user_id=$1 and merchant_id=$2 and type='redeem' and reward_id=$3`,
      [DEMO_PROFILE, MATAM, rewardId]
    ));
    check('race: exactly one redeem ledger row was written (not two, not zero)', Number(afterLedger.rows[0].count) === 1);
  }

  // =========================================================================
  // 1b) After merging the lockdown fix (#73) with this branch's own ledger
  //     work: redeem_reward() must end up SECURITY DEFINER with search_path
  //     pinned (point-ledger.sql's own create-or-replace, applied after
  //     lockdown's, is what actually wins — this guards against either file
  //     silently regressing the other back to SECURITY INVOKER), the client
  //     still cannot UPDATE merchant_loyalty directly, and cannot INSERT a
  //     fabricated ledger row directly either (the whole reason the old
  //     "insert own redeem transactions" policy was removed).
  // =========================================================================
  {
    const funcRow = await admin(c => c.query(
      `select prosecdef, proconfig from pg_proc where proname = 'redeem_reward'`
    ));
    check('merged: redeem_reward() is SECURITY DEFINER', funcRow.rows[0].prosecdef === true);
    check('merged: redeem_reward() has search_path pinned to public',
      (funcRow.rows[0].proconfig || []).some(c => c === 'search_path=public'));

    const uid2 = crypto.randomUUID();
    await admin(c => c.query('insert into auth.users (id) values ($1)', [uid2]));
    await asUser(uid2, c => c.query('select claim_or_create_profile($1)', ['577777777']));

    let directUpdate = null;
    try {
      await asUser(uid2, c => c.query(`update merchant_loyalty set points=999999 where merchant_id=$1`, [MATAM]));
      directUpdate = 'ok';
    } catch (e) { directUpdate = 'fail:' + e.message; }
    check('merged: client still cannot UPDATE merchant_loyalty directly', directUpdate !== 'ok' && /permission denied/i.test(directUpdate));

    let directLedgerInsert = null;
    try {
      const prof = await admin(c => c.query(`select id from profiles where auth_user_id=$1`, [uid2]));
      await asUser(uid2, c => c.query(
        `insert into point_transactions (user_id, merchant_id, type, points_delta, source) values ($1,$2,'redeem',-1,'app_session')`,
        [prof.rows[0].id, MATAM]
      ));
      directLedgerInsert = 'ok';
    } catch (e) { directLedgerInsert = 'fail:' + e.message; }
    check('merged: client cannot INSERT a fabricated redeem row into point_transactions directly', directLedgerInsert !== 'ok' && /permission denied/i.test(directLedgerInsert));
  }

  // =========================================================================
  // 2) POS INVOICE DUPLICATION (idempotency via unique(merchant_id, external_ref))
  // =========================================================================
  {
    const ref = 'POS-DUPLICATE-TEST-001';
    let first = null, second = null;
    try {
      await admin(c => c.query(
        `insert into invoices (user_id, merchant_id, amount, vat, category, source, external_ref) values ($1,$2,100,13,'مطاعم','pos',$3)`,
        [DEMO_PROFILE, MATAM, ref]
      ));
      first = 'ok';
    } catch (e) { first = 'fail:' + e.message; }
    try {
      await admin(c => c.query(
        `insert into invoices (user_id, merchant_id, amount, vat, category, source, external_ref) values ($1,$2,100,13,'مطاعم','pos',$3)`,
        [DEMO_PROFILE, MATAM, ref]
      ));
      second = 'ok';
    } catch (e) { second = 'fail:' + e.message; }
    console.log('  first insert:', first, '| retried duplicate insert:', second);
    check('POS idempotency: first invoice with a given external_ref succeeds', first === 'ok');
    check('POS idempotency: retried webhook with the SAME external_ref is rejected (unique violation)', second !== 'ok' && /unique|duplicate/i.test(second));

    // sanity: two DIFFERENT merchants may reuse the same external_ref (POS ids
    // are only unique within one merchant's own system), and NULL external_ref
    // (non-POS invoices) never collides with anything.
    let crossMerchantOk = null;
    const OTHER_MERCHANT = '20000000-0000-0000-0000-000000000002'; // بنده
    try {
      await admin(c => c.query(
        `insert into invoices (user_id, merchant_id, amount, vat, category, source, external_ref) values ($1,$2,50,6.5,'بقالة','pos',$3)`,
        [DEMO_PROFILE, OTHER_MERCHANT, ref]
      ));
      crossMerchantOk = 'ok';
    } catch (e) { crossMerchantOk = 'fail:' + e.message; }
    check('POS idempotency: the SAME external_ref is fine for a DIFFERENT merchant', crossMerchantOk === 'ok');
  }

  // =========================================================================
  // 3) PHONE NORMALIZATION
  // =========================================================================
  {
    const cases = [
      ['0512345678', '512345678'],
      ['+966512345678', '512345678'],
      ['966512345678', '512345678'],
      ['512345678', '512345678'],
      ['05 1234 5678', '512345678'],
      ['abc', null],
      ['12345', null],
      ['612345678', null], // does not start with 5 -> not a valid SA mobile
    ];
    for (const [input, expected] of cases) {
      const res = await admin(c => c.query('select normalize_sa_phone($1) as v', [input]));
      const got = res.rows[0].v;
      check(`normalize_sa_phone(${JSON.stringify(input)}) = ${JSON.stringify(expected)}`, got === expected);
    }

    // the CHECK constraint itself: a malformed phone must never reach the table.
    let badInsert = null;
    try {
      await admin(c => c.query(`insert into profiles (phone) values ('12345')`));
      badInsert = 'ok';
    } catch (e) { badInsert = 'fail:' + e.message; }
    check('profiles.phone CHECK constraint rejects a malformed number', badInsert !== 'ok' && /constraint|check/i.test(badInsert));

    let goodInsert = null;
    try {
      await admin(c => c.query(`insert into profiles (phone) values ('599999999')`));
      goodInsert = 'ok';
    } catch (e) { goodInsert = 'fail:' + e.message; }
    check('profiles.phone CHECK constraint accepts a correctly-shaped number', goodInsert === 'ok');
  }

  // =========================================================================
  // 4) CONSENT ENFORCEMENT before any 'earn' transaction
  // =========================================================================
  {
    const newProfile = await admin(c => c.query(
      `insert into profiles (phone) values ('533333333') returning id`
    ));
    const pid = newProfile.rows[0].id;

    let earnNoConsent = null;
    try {
      await admin(c => c.query(
        `insert into point_transactions (user_id, merchant_id, type, points_delta, source) values ($1,$2,'earn',10,'kiosk_manual')`,
        [pid, MATAM]
      ));
      earnNoConsent = 'ok';
    } catch (e) { earnNoConsent = 'fail:' + e.message; }
    check('consent: earn transaction WITHOUT a consent row is rejected', earnNoConsent !== 'ok' && /موافقة/.test(earnNoConsent));

    await admin(c => c.query(
      `insert into profile_consents (profile_id, consent_type, text_version, channel) values ($1,'data_processing','v1','kiosk')`,
      [pid]
    ));

    let earnWithConsent = null;
    try {
      await admin(c => c.query(
        `insert into point_transactions (user_id, merchant_id, type, points_delta, source) values ($1,$2,'earn',10,'kiosk_manual')`,
        [pid, MATAM]
      ));
      earnWithConsent = 'ok';
    } catch (e) { earnWithConsent = 'fail:' + e.message; }
    check('consent: earn transaction WITH an active consent row succeeds', earnWithConsent === 'ok');

    // existing demo profile (grandfathered) must already be able to earn too
    let earnGrandfathered = null;
    try {
      await admin(c => c.query(
        `insert into point_transactions (user_id, merchant_id, type, points_delta, source) values ($1,$2,'earn',5,'kiosk_manual')`,
        [DEMO_PROFILE, MATAM]
      ));
      earnGrandfathered = 'ok';
    } catch (e) { earnGrandfathered = 'fail:' + e.message; }
    check('consent: pre-existing (grandfathered) profile can still earn', earnGrandfathered === 'ok');
  }

  // =========================================================================
  // 5) BRANCHES auto-mirror (no manual sync)
  // =========================================================================
  {
    const newMerchantId = crypto.randomUUID();
    await admin(c => c.query(
      `insert into merchants (id, name, branch, type, logo_color) values ($1,'تاجر اختبار','فرع اختبار','بقالة','#111111')`,
      [newMerchantId]
    ));
    const b = await admin(c => c.query('select * from branches where id=$1', [newMerchantId]));
    check('branches: a new merchants row automatically gets a mirrored branches row (same id)', b.rows.length === 1 && b.rows[0].name === 'فرع اختبار');

    const bs = await admin(c => c.query('select * from branch_settings where branch_id=$1', [newMerchantId]));
    check('branch_settings: a new branch automatically gets a settings row with sane defaults', bs.rows.length === 1 && bs.rows[0].dark_mode === false && bs.rows[0].pos_mode === 'demo');

    await admin(c => c.query(`update merchants set branch='فرع محدَّث' where id=$1`, [newMerchantId]));
    const b2 = await admin(c => c.query('select name from branches where id=$1', [newMerchantId]));
    check('branches: renaming a merchant\'s branch label keeps the mirrored branches.name in sync', b2.rows[0].name === 'فرع محدَّث');
  }

  // =========================================================================
  // 6) DATA DELETION REQUEST — phone hash captured, phone scrubbed, audit kept
  // =========================================================================
  {
    const victim = await admin(c => c.query(`insert into profiles (phone) values ('544444444') returning id, phone`));
    const pid = victim.rows[0].id;
    const originalPhone = victim.rows[0].phone;
    const expectedHash = crypto.createHash('sha256').update(originalPhone).digest('hex');

    const req = await admin(c => c.query('select * from request_data_deletion($1, $2) as r', [pid, 'طلب اختباري']));
    const row = req.rows[0];
    check('deletion: phone_hash matches sha256 of the ORIGINAL phone number', row.phone_hash === expectedHash);
    check('deletion: request is marked fulfilled', row.fulfilled_at !== null);

    const scrubbed = await admin(c => c.query('select phone, deleted_at from profiles where id=$1', [pid]));
    check('deletion: profiles.phone is scrubbed (no longer the real number)', scrubbed.rows[0].phone !== originalPhone && scrubbed.rows[0].phone.startsWith('deleted-'));
    check('deletion: profiles.deleted_at is set', scrubbed.rows[0].deleted_at !== null);

    // the row itself must still exist (referential integrity for old ledger rows)
    const stillThere = await admin(c => c.query('select count(*) from profiles where id=$1', [pid]));
    check('deletion: the profile ROW is NOT deleted (still referenceable by old transactions)', Number(stillThere.rows[0].count) === 1);
  }

  // =========================================================================
  // 7) OPENING BALANCE backfill sanity: ledger sum matches stored balance
  // =========================================================================
  {
    const check1 = await admin(c => c.query(`
      select ml.user_id, ml.merchant_id, ml.points as stored_balance,
             coalesce((select sum(pt.points_delta) from point_transactions pt
                       where pt.user_id=ml.user_id and pt.merchant_id=ml.merchant_id
                       and pt.type='opening_balance'), 0) as ledger_opening
      from merchant_loyalty ml
      where ml.merchant_id = $1 and ml.user_id = $2
    `, [MATAM, DEMO_PROFILE]));
    // NOTE: this specific (user, merchant) pair had its balance mutated by the
    // race-condition test above (reset to 300, then redeemed to 50) — so we
    // only assert the opening_balance row itself equals what it was backfilled
    // from (420, the original seed value), not that it still equals the
    // CURRENT balance (which legitimately changed since).
    check('ledger: opening_balance backfill row recorded the ORIGINAL seeded balance (420)', Number(check1.rows[0].ledger_opening) === 420);
  }

  // =========================================================================
  // 8) RLS: a session can only see its OWN point_transactions
  // =========================================================================
  {
    const uidA = crypto.randomUUID();
    await admin(c => c.query('insert into auth.users (id) values ($1)', [uidA]));
    const profA = await asUser(uidA, c => c.query('select * from claim_or_create_profile($1) as p', ['555555555']));
    const pidA = profA.rows[0].id;
    await admin(c => c.query(
      `insert into profile_consents (profile_id, consent_type, text_version, channel) values ($1,'data_processing','v1','app')`,
      [pidA]
    ));
    await admin(c => c.query(
      `insert into point_transactions (user_id, merchant_id, type, points_delta, source) values ($1,$2,'earn',77,'app_session')`,
      [pidA, MATAM]
    ));

    const ownRows = await asUser(uidA, c => c.query('select * from point_transactions where points_delta=77'));
    check('RLS: a claimed session CAN see its own point_transactions row', ownRows.rows.length === 1);

    // a second, unrelated session must not see it
    const uidB = crypto.randomUUID();
    await admin(c => c.query('insert into auth.users (id) values ($1)', [uidB]));
    await asUser(uidB, c => c.query('select * from claim_or_create_profile($1) as p', ['566666666']));
    const otherRows = await asUser(uidB, c => c.query('select * from point_transactions where points_delta=77'));
    check('RLS: a DIFFERENT session cannot see someone else\'s point_transactions row', otherRows.rows.length === 0);
  }

  console.log('\n=== SUMMARY:', pass, 'passed,', fail, 'failed ===');
  if (failures.length) console.log('Failures:', JSON.stringify(failures, null, 2));
  process.exit(fail > 0 ? 1 : 0);
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
