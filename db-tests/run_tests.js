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

// Pure test-setup convenience: stays on the superuser 'postgres' role (so
// it is NEVER blocked by a revoke on a now-locked-down function — most
// test cases don't care HOW a fixture profile gets created), but still
// sets the auth.uid() claim so functions like claim_or_create_profile()
// that read it internally behave correctly. Never use this to assert that
// a function IS reachable by a real client — that must go through asUser()
// (authenticated, no BYPASSRLS) or asServiceRole() below instead.
async function adminAsUser(uid, fn) {
  const c = new Client(CONN);
  await c.connect();
  await c.query('select test.set_auth_uid($1)', [uid]);
  try { return await fn(c); } finally { await c.end(); }
}

// Simulates the pos-intake Edge Function's real caller: Supabase's
// service_role, used via SUPABASE_SERVICE_ROLE_KEY, never carries a user
// JWT (no auth.uid() involved) — only intake_pos_transaction() is granted
// to it.
async function asServiceRole(fn) {
  const c = new Client(CONN);
  await c.connect();
  await c.query('set role service_role');
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
  const filesBeforePhoneFormat = [
    path.join(__dirname, '00_auth_stub.sql'),
    ...[
      'supabase-schema.sql', 'supabase-migration-merchant-features.sql',
      'supabase-migration-merchant-loyalty.sql', 'supabase-migration-health-center.sql',
      'supabase-migration-fix-profile-reclaim.sql', 'supabase-migration-cleanup-demo-data.sql',
      'supabase-migration-lockdown-direct-writes.sql',
      'supabase-migration-branches-devices.sql', 'supabase-migration-point-ledger.sql',
      'supabase-migration-loyalty-rate-expiry.sql', 'supabase-migration-consent-privacy.sql',
      'supabase-migration-app-consent.sql',
    ].map(f => path.join(REPO_ROOT, f)),
  ];
  for (const f of filesBeforePhoneFormat) {
    execSync(`su postgres -c "psql -q -v ON_ERROR_STOP=1 -d noj_test -f '${f}'"`, { stdio: 'pipe' });
  }

  // reproduce, BEFORE phone-format.sql ever runs, the exact live incident:
  // a guest-session profile whose phone is an empty string (not SQL NULL —
  // profiles.phone is still `not null` at this point in the chain), created
  // by claim_or_create_profile() when index.html's loginAndLoad(A.phone)
  // runs with a lost/never-saved A.phone. phone-format.sql must normalize
  // this to NULL and succeed, not error like it did on the live project.
  const uidNoPhone = crypto.randomUUID();
  await admin(c => c.query('insert into auth.users (id) values ($1)', [uidNoPhone]));
  await admin(c => c.query(`insert into profiles (phone, auth_user_id) values ('', $1)`, [uidNoPhone]));

  const filesFromPhoneFormat = [
    'supabase-migration-phone-format.sql', 'supabase-migration-timezone.sql',
    'supabase-migration-kiosk-device-auth.sql', 'supabase-migration-kiosk-balance-lookup.sql',
    'supabase-migration-kiosk-admin-pin.sql', 'supabase-migration-admin-pin-lockdown.sql',
    'supabase-migration-pos-transactions.sql', 'supabase-migration-phone-otp-foundation.sql',
    'supabase-migration-pos-intake.sql',
  ].map(f => path.join(REPO_ROOT, f));
  for (const f of filesFromPhoneFormat) {
    execSync(`su postgres -c "psql -q -v ON_ERROR_STOP=1 -d noj_test -f '${f}'"`, { stdio: 'pipe' });
  }
  console.log('Rebuild done.\n');

  // =========================================================================
  // 0) THE LIVE INCIDENT: a pre-existing empty-string phone must survive
  //    phone-format.sql (normalized to NULL, not rejected), and the
  //    now-nullable, still-unique column must not let a SECOND blank-phone
  //    guest collide with the first one.
  // =========================================================================
  {
    const row = await admin(c => c.query(
      `select phone, phone is null as is_null from profiles where auth_user_id = $1`,
      [uidNoPhone]
    ));
    check('phone-format: a pre-existing empty-string phone is normalized to NULL, not rejected', row.rows[0].is_null === true);

    let secondBlankGuestOk = null;
    try {
      await admin(c => c.query(`insert into profiles (phone, auth_user_id) values (null, null)`));
      secondBlankGuestOk = 'ok';
    } catch (e) { secondBlankGuestOk = 'fail:' + e.message; }
    check('phone-format: a SECOND blank-phone profile does not collide with the first (NULL <> NULL under UNIQUE)', secondBlankGuestOk === 'ok');

    let emptyStringRejected = null;
    try {
      await admin(c => c.query(`insert into profiles (phone, auth_user_id) values ('', null)`));
      emptyStringRejected = 'ok';
    } catch (e) { emptyStringRejected = 'fail:' + e.message; }
    check('phone-format: a NEW empty-string phone is now rejected outright (loud failure, not silent merge)', emptyStringRejected !== 'ok' && /profiles_phone_format_chk/.test(emptyStringRejected));

    const nullChecks = await admin(c => c.query(`select normalize_sa_phone(null) as n1, normalize_sa_phone('') as n2`));
    check('normalize_sa_phone(NULL) returns NULL without erroring', nullChecks.rows[0].n1 === null);
    check("normalize_sa_phone('') returns NULL without erroring", nullChecks.rows[0].n2 === null);
  }

  const MATAM = '20000000-0000-0000-0000-000000000001'; // مطعم مذاق
  const DEMO_PROFILE = '11111111-1111-1111-1111-111111111111';

  // =========================================================================
  // 1) RACE CONDITION on redemption: two concurrent redeem_reward() calls for
  //    the same profile+merchant where the balance covers exactly ONE.
  // =========================================================================
  {
    const uid = crypto.randomUUID();
    await admin(c => c.query('insert into auth.users (id) values ($1)', [uid]));
    await adminAsUser(uid, c => c.query('select claim_or_create_profile($1)', ['512345678']));
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
    await adminAsUser(uid2, c => c.query('select claim_or_create_profile($1)', ['577777777']));

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
  // 4b) grant_app_consent(): the actual key for the door consent-privacy.sql
  //     built but never gave any UI a way to open — index.html now calls
  //     this after every login for a profile with no active consent.
  // =========================================================================
  {
    const consentUid = crypto.randomUUID();
    await admin(c => c.query('insert into auth.users (id) values ($1)', [consentUid]));
    const prof = await adminAsUser(consentUid, c => c.query('select * from claim_or_create_profile($1) as p', ['522222220']));
    const pid = prof.rows[0].id;

    let earnBeforeConsent = null;
    try {
      await admin(c => c.query(
        `insert into point_transactions (user_id, merchant_id, type, points_delta, source) values ($1,$2,'earn',10,'kiosk_manual')`,
        [pid, MATAM]
      ));
      earnBeforeConsent = 'ok';
    } catch (e) { earnBeforeConsent = 'fail:' + e.message; }
    check('grant_app_consent: a brand-new profile has no consent yet, earn is rejected', earnBeforeConsent !== 'ok');

    const grantRes = await asUser(consentUid, c => c.query('select * from grant_app_consent()'));
    const granted = grantRes.rows[0];
    check('grant_app_consent: records consent_type=data_processing, channel=app', granted.consent_type === 'data_processing' && granted.channel === 'app');
    check('grant_app_consent: text_version is the fixed server-side constant', granted.text_version === 'app-consent-v1-2026-09');

    let earnAfterConsent = null;
    try {
      await admin(c => c.query(
        `insert into point_transactions (user_id, merchant_id, type, points_delta, source) values ($1,$2,'earn',10,'kiosk_manual')`,
        [pid, MATAM]
      ));
      earnAfterConsent = 'ok';
    } catch (e) { earnAfterConsent = 'fail:' + e.message; }
    check('grant_app_consent: earn now succeeds for this same profile', earnAfterConsent === 'ok');

    const grantAgain = await asUser(consentUid, c => c.query('select * from grant_app_consent()'));
    check('grant_app_consent: calling it again returns the SAME existing row (idempotent)', grantAgain.rows[0].id === granted.id);
    const consentCount = await admin(c => c.query('select count(*) from profile_consents where profile_id=$1', [pid]));
    check('grant_app_consent: no duplicate consent row was created on the second call', Number(consentCount.rows[0].count) === 1);

    // a second, unrelated profile granting its own consent must get its OWN
    // row — never shared with or affecting the first profile's.
    const otherConsentUid = crypto.randomUUID();
    await admin(c => c.query('insert into auth.users (id) values ($1)', [otherConsentUid]));
    await adminAsUser(otherConsentUid, c => c.query('select claim_or_create_profile($1)', ['522222221']));
    const otherGrant = await asUser(otherConsentUid, c => c.query('select * from grant_app_consent()'));
    check('grant_app_consent: a different profile gets its own separate consent row', otherGrant.rows[0].id !== granted.id);
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
    const profA = await adminAsUser(uidA, c => c.query('select * from claim_or_create_profile($1) as p', ['555555555']));
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
    await adminAsUser(uidB, c => c.query('select * from claim_or_create_profile($1) as p', ['566666666']));
    const otherRows = await asUser(uidB, c => c.query('select * from point_transactions where points_delta=77'));
    check('RLS: a DIFFERENT session cannot see someone else\'s point_transactions row', otherRows.rows.length === 0);
  }

  // =========================================================================
  // 9) KIOSK DEVICE PAIRING
  // =========================================================================
  {
    const branchRow = await admin(c => c.query('select id, merchant_id from branches where merchant_id=$1', [MATAM]));
    const BRANCH = branchRow.rows[0].id;

    const kioskUid = crypto.randomUUID();
    await admin(c => c.query('insert into auth.users (id) values ($1)', [kioskUid]));
    const req1 = await asUser(kioskUid, c => c.query('select * from request_device_pairing()'));
    check('pairing: request_device_pairing() creates an unpaired device with a 6-digit code',
      /^[0-9]{6}$/.test(req1.rows[0].pairing_code) && req1.rows[0].branch_id === null);

    const req2 = await asUser(kioskUid, c => c.query('select * from request_device_pairing()'));
    check('pairing: calling request_device_pairing() again returns the SAME device row, same code (not stale yet)',
      req2.rows[0].id === req1.rows[0].id && req2.rows[0].pairing_code === req1.rows[0].pairing_code);

    // a merchant_member for a DIFFERENT merchant must not be able to approve
    // pairing onto MATAM's branch.
    const strangerAdminUid = crypto.randomUUID();
    await admin(c => c.query('insert into auth.users (id) values ($1)', [strangerAdminUid]));
    const OTHER_MERCHANT = '20000000-0000-0000-0000-000000000002'; // بنده
    await admin(c => c.query(
      `insert into merchant_members (merchant_id, auth_user_id, role) values ($1,$2,'owner')`,
      [OTHER_MERCHANT, strangerAdminUid]
    ));
    const strangerApprove = await asUser(strangerAdminUid, async c => {
      try { await c.query('select * from approve_device_pairing($1,$2)', [req1.rows[0].pairing_code, BRANCH]); return 'ok'; }
      catch (e) { return 'fail:' + e.message; }
    });
    check('pairing: a merchant_member of a DIFFERENT merchant cannot approve pairing onto this branch',
      strangerApprove !== 'ok' && /لا تملك صلاحية/.test(strangerApprove));

    const adminUid = crypto.randomUUID();
    await admin(c => c.query('insert into auth.users (id) values ($1)', [adminUid]));
    await admin(c => c.query(
      `insert into merchant_members (merchant_id, auth_user_id, role) values ($1,$2,'owner')`,
      [MATAM, adminUid]
    ));
    const approveRes = await asUser(adminUid, c => c.query('select * from approve_device_pairing($1,$2)', [req1.rows[0].pairing_code, BRANCH]));
    check('pairing: the rightful merchant_member approves pairing successfully', approveRes.rows[0].branch_id === BRANCH);
    check('pairing: the pairing_code is cleared after approval', approveRes.rows[0].pairing_code === null);

    const reapprove = await asUser(adminUid, async c => {
      try { await c.query('select * from approve_device_pairing($1,$2)', [req1.rows[0].pairing_code, BRANCH]); return 'ok'; }
      catch (e) { return 'fail:' + e.message; }
    });
    check('pairing: the SAME code cannot be approved twice (already consumed)', reapprove !== 'ok');

    const req3 = await asUser(kioskUid, c => c.query('select * from request_device_pairing()'));
    check('pairing: after approval, request_device_pairing() now returns branch_id set', req3.rows[0].branch_id === BRANCH);

    // RLS: the paired device sees its own devices row and its own branch's
    // settings; a totally different device sees neither.
    const ownDevice = await asUser(kioskUid, c => c.query('select * from devices where auth_user_id=$1', [kioskUid]));
    check('pairing RLS: the device can select its own devices row', ownDevice.rows.length === 1);
    const ownSettings = await asUser(kioskUid, c => c.query('select * from branch_settings where branch_id=$1', [BRANCH]));
    check('pairing RLS: the device can select its own branch_settings row', ownSettings.rows.length === 1);

    const otherKioskUid = crypto.randomUUID();
    await admin(c => c.query('insert into auth.users (id) values ($1)', [otherKioskUid]));
    await asUser(otherKioskUid, c => c.query('select * from request_device_pairing()'));
    const foreignDevice = await asUser(otherKioskUid, c => c.query('select * from devices where auth_user_id=$1', [kioskUid]));
    check('pairing RLS: a DIFFERENT device cannot see this device\'s row', foreignDevice.rows.length === 0);
    const foreignSettings = await asUser(otherKioskUid, c => c.query('select * from branch_settings where branch_id=$1', [BRANCH]));
    check('pairing RLS: an unpaired device cannot see this branch\'s settings', foreignSettings.rows.length === 0);

    // =========================================================================
    // 10) branch_settings: sector_code / biz_logo size CHECK constraints,
    //     and the device's own RLS-scoped UPDATE of its settings.
    // =========================================================================
    let badSector = null;
    try {
      await admin(c => c.query(`update branch_settings set sector_code='not-a-sector' where branch_id=$1`, [BRANCH]));
      badSector = 'ok';
    } catch (e) { badSector = 'fail:' + e.message; }
    check('branch_settings: an invalid sector_code is rejected', badSector !== 'ok');

    const okSectorUpdate = await asUser(kioskUid, async c => {
      try { await c.query(`update branch_settings set sector_code='restaurant' where branch_id=$1`, [BRANCH]); return 'ok'; }
      catch (e) { return 'fail:' + e.message; }
    });
    check('branch_settings: the paired device can update its OWN branch settings directly', okSectorUpdate === 'ok');

    // RLS silently filters rows an UPDATE's USING clause excludes (no
    // exception — 0 rows affected), unlike the grant-level rejections
    // above, so this must check rowCount / the actual value, not a thrown
    // error.
    const foreignUpdateRes = await asUser(otherKioskUid, c => c.query(`update branch_settings set sector_code='medical' where branch_id=$1`, [BRANCH]));
    check('branch_settings: an unpaired/different device\'s update matches ZERO rows (RLS-filtered)', foreignUpdateRes.rowCount === 0);
    const stillRestaurant = await admin(c => c.query('select sector_code from branch_settings where branch_id=$1', [BRANCH]));
    check('branch_settings: sector_code is untouched by the foreign device\'s no-op update', stillRestaurant.rows[0].sector_code === 'restaurant');

    let oversizedLogo = null;
    try {
      await admin(c => c.query(`update branch_settings set biz_logo=$1 where branch_id=$2`, ['x'.repeat(700001), BRANCH]));
      oversizedLogo = 'ok';
    } catch (e) { oversizedLogo = 'fail:' + e.message; }
    check('branch_settings: a biz_logo over ~500KB is rejected', oversizedLogo !== 'ok');

    let okLogo = null;
    try {
      await admin(c => c.query(`update branch_settings set biz_logo=$1 where branch_id=$2`, ['x'.repeat(700000), BRANCH]));
      okLogo = 'ok';
    } catch (e) { okLogo = 'fail:' + e.message; }
    check('branch_settings: a biz_logo at/under the limit is accepted', okLogo === 'ok');

    // =========================================================================
    // 11) kiosk_earn_points(): off by default, gated per-branch, tags
    //     everything 'demo', never auto-creates a stranger's profile.
    // =========================================================================
    const deviceRow = await admin(c => c.query('select id from devices where auth_user_id=$1', [kioskUid]));
    const DEVICE_ID = deviceRow.rows[0].id;

    const disabledAttempt = await asUser(kioskUid, async c => {
      try { await c.query('select * from kiosk_earn_points($1,$2,$3)', ['512345678', '100', null]); return 'ok'; }
      catch (e) { return 'fail:' + e.message; }
    });
    check('kiosk_earn_points: refuses to run while demo_earn_enabled is false (the default)',
      disabledAttempt !== 'ok' && /الوضع التجريبي/.test(disabledAttempt));

    await admin(c => c.query(`update branch_settings set demo_earn_enabled=true where branch_id=$1`, [BRANCH]));

    const strangerPhone = await asUser(kioskUid, async c => {
      try { await c.query('select * from kiosk_earn_points($1,$2,$3)', ['511111110', '50', null]); return 'ok'; }
      catch (e) { return 'fail:' + e.message; }
    });
    check('kiosk_earn_points: an unregistered phone is rejected, never auto-creates a profile',
      strangerPhone !== 'ok' && /NOJ_CUSTOMER_NOT_FOUND/.test(strangerPhone));
    const strangerCreated = await admin(c => c.query(`select 1 from profiles where phone='511111110'`));
    check('kiosk_earn_points: no profile row was created for the rejected stranger phone', strangerCreated.rows.length === 0);

    const rateRow = await admin(c => c.query('select points_rate from merchants where id=$1', [MATAM]));
    const RATE = Number(rateRow.rows[0].points_rate);
    const balBefore = await admin(c => c.query(
      'select points from merchant_loyalty where user_id=$1 and merchant_id=$2', [DEMO_PROFILE, MATAM]
    ));
    const prevBalance = balBefore.rows[0].points;

    const earnRes = await asUser(kioskUid, c => c.query(
      'select * from kiosk_earn_points($1,$2,$3)', ['512345678', '100.00', null]
    ));
    const row = earnRes.rows[0];
    const expectedAdded = Math.round(100 * RATE);
    check('kiosk_earn_points: prev_points matches the balance before this call', row.prev_points === prevBalance);
    check('kiosk_earn_points: added_points = round(amount * merchants.points_rate)', row.added_points === expectedAdded);
    check('kiosk_earn_points: total_points = prev + added', row.total_points === prevBalance + expectedAdded);

    const balAfter = await admin(c => c.query(
      'select points from merchant_loyalty where user_id=$1 and merchant_id=$2', [DEMO_PROFILE, MATAM]
    ));
    check('kiosk_earn_points: merchant_loyalty.points was actually updated to match', balAfter.rows[0].points === row.total_points);

    const ptRow = await admin(c => c.query(
      `select * from point_transactions where invoice_id=$1`, [row.invoice_id]
    ));
    check('kiosk_earn_points: point_transactions row is tagged source=demo, not a real source', ptRow.rows[0].source === 'demo');
    check('kiosk_earn_points: point_transactions.branch_id/device_id match this device', ptRow.rows[0].branch_id === BRANCH && ptRow.rows[0].device_id === DEVICE_ID);
    check('kiosk_earn_points: points_rate_applied is a permanent snapshot of merchants.points_rate', Number(ptRow.rows[0].points_rate_applied) === RATE);

    const invRow = await admin(c => c.query(`select * from invoices where id=$1`, [row.invoice_id]));
    check('kiosk_earn_points: invoices row is tagged source=demo too', invRow.rows[0].source === 'demo');
    check('kiosk_earn_points: invoices.category defaults to merchants.type when no category given', invRow.rows[0].category !== null);

    // a brand-new customer at this merchant (no prior merchant_loyalty row at
    // all) must start from 0, not error out.
    const newCustUid = crypto.randomUUID();
    await admin(c => c.query('insert into auth.users (id) values ($1)', [newCustUid]));
    const newCustProf = await adminAsUser(newCustUid, c => c.query('select * from claim_or_create_profile($1) as p', ['588888888']));
    // a brand-new profile is NOT grandfathered (that only covers profiles
    // that already existed when consent-privacy.sql ran) — give it real
    // consent first, same as any other 'earn' path requires.
    await admin(c => c.query(
      `insert into profile_consents (profile_id, consent_type, text_version, channel) values ($1,'data_processing','v1','kiosk')`,
      [newCustProf.rows[0].id]
    ));
    const firstEarn = await asUser(kioskUid, c => c.query(
      'select * from kiosk_earn_points($1,$2,$3)', ['588888888', '20.00', null]
    ));
    check('kiosk_earn_points: a customer with NO prior balance at this merchant starts from 0', firstEarn.rows[0].prev_points === 0);

    const badAmount = await asUser(kioskUid, async c => {
      try { await c.query('select * from kiosk_earn_points($1,$2,$3)', ['512345678', '0', null]); return 'ok'; }
      catch (e) { return 'fail:' + e.message; }
    });
    check('kiosk_earn_points: a zero/negative amount is rejected', badAmount !== 'ok');

    // an unpaired device (never approved) must be refused entirely.
    const unpairedUid = crypto.randomUUID();
    await admin(c => c.query('insert into auth.users (id) values ($1)', [unpairedUid]));
    await asUser(unpairedUid, c => c.query('select * from request_device_pairing()'));
    const unpairedAttempt = await asUser(unpairedUid, async c => {
      try { await c.query('select * from kiosk_earn_points($1,$2,$3)', ['512345678', '10', null]); return 'ok'; }
      catch (e) { return 'fail:' + e.message; }
    });
    check('kiosk_earn_points: an unpaired device is refused entirely', unpairedAttempt !== 'ok' && /غير مقارَن/.test(unpairedAttempt));

    // =========================================================================
    // 12) kiosk_lookup_customer_points(): the READ-only path kiosk.html uses
    //     to show a real previous balance (stage د) — no demo_earn_enabled
    //     gate (reading isn't the risk writing fake amounts is), but still
    //     device-authenticated, and still never auto-creates anyone.
    // =========================================================================
    const unpairedLookup = await asUser(unpairedUid, async c => {
      try { await c.query('select kiosk_lookup_customer_points($1)', ['512345678']); return 'ok'; }
      catch (e) { return 'fail:' + e.message; }
    });
    check('kiosk_lookup_customer_points: an unpaired device is refused entirely', unpairedLookup !== 'ok' && /غير مقارَن/.test(unpairedLookup));

    // a genuinely unregistered visitor (anon key -> self-signed-in anonymous
    // session, but NEVER called request_device_pairing() at all — no devices
    // row exists for this auth_user_id whatsoever, not even an unpaired one)
    // must be refused identically. This is the exact scenario raised about
    // "can anyone with the public anon key query any phone's balance?" —
    // empirical proof, not just code-reading, that they cannot.
    const strangerSessionUid = crypto.randomUUID();
    await admin(c => c.query('insert into auth.users (id) values ($1)', [strangerSessionUid]));
    const trueStrangerLookup = await asUser(strangerSessionUid, async c => {
      try { await c.query('select kiosk_lookup_customer_points($1)', ['512345678']); return 'ok'; }
      catch (e) { return 'fail:' + e.message; }
    });
    check('kiosk_lookup_customer_points: a session with NO devices row at all (never paired, never even requested) is refused — proves the public anon key alone grants nothing', trueStrangerLookup !== 'ok' && /غير مقارَن/.test(trueStrangerLookup));

    const strangerLookup = await asUser(kioskUid, async c => {
      try { await c.query('select kiosk_lookup_customer_points($1)', ['511111110']); return 'ok'; }
      catch (e) { return 'fail:' + e.message; }
    });
    check('kiosk_lookup_customer_points: an unregistered phone raises NOJ_CUSTOMER_NOT_FOUND', strangerLookup !== 'ok' && /NOJ_CUSTOMER_NOT_FOUND/.test(strangerLookup));
    const strangerStillAbsent = await admin(c => c.query(`select 1 from profiles where phone='511111110'`));
    check('kiosk_lookup_customer_points: no profile row was created for the rejected stranger phone', strangerStillAbsent.rows.length === 0);

    const realBalance = await admin(c => c.query('select points from merchant_loyalty where user_id=$1 and merchant_id=$2', [DEMO_PROFILE, MATAM]));
    const lookupRes = await asUser(kioskUid, c => c.query('select kiosk_lookup_customer_points($1) as points', ['512345678']));
    check('kiosk_lookup_customer_points: returns the REAL current balance (matches merchant_loyalty exactly)', Number(lookupRes.rows[0].points) === realBalance.rows[0].points);

    const noBalanceUid = crypto.randomUUID();
    await admin(c => c.query('insert into auth.users (id) values ($1)', [noBalanceUid]));
    await adminAsUser(noBalanceUid, c => c.query('select claim_or_create_profile($1)', ['533333330']));
    const zeroBalanceRes = await asUser(kioskUid, c => c.query('select kiosk_lookup_customer_points($1) as points', ['533333330']));
    check('kiosk_lookup_customer_points: a registered customer with NO merchant_loyalty row at this merchant returns 0, not an error', Number(zeroBalanceRes.rows[0].points) === 0);

    // branches RLS: only a device paired to THIS branch may read it.
    const ownBranchRead = await asUser(kioskUid, c => c.query('select id from branches where id=$1', [BRANCH]));
    check('branches RLS: the paired device can select its own branch', ownBranchRead.rows.length === 1);
    const foreignBranchRead = await asUser(unpairedUid, c => c.query('select id from branches where id=$1', [BRANCH]));
    check('branches RLS: an unpaired device cannot select this branch', foreignBranchRead.rows.length === 0);

    // =========================================================================
    // 13) POS invoice intake (stage 1): pos_transactions +
    //     kiosk_claim_pos_transaction() + claim_unclaimed_invoices(). The
    //     kiosk never sends an amount — only a transaction id + phone.
    // =========================================================================
    const posTxn1 = await admin(c => c.query(
      `insert into pos_transactions (branch_id, amount, vat, external_ref) values ($1,$2,$3,$4) returning id`,
      [BRANCH, '75.00', '3.75', 'POS-TEST-1']
    ));
    const balBeforePos = await admin(c => c.query(
      'select points from merchant_loyalty where user_id=$1 and merchant_id=$2', [DEMO_PROFILE, MATAM]
    ));
    const prevBalancePos = balBeforePos.rows[0].points;

    const claimRes1 = await asUser(kioskUid, c => c.query(
      'select * from kiosk_claim_pos_transaction($1,$2)', [posTxn1.rows[0].id, '512345678']
    ));
    const posRow1 = claimRes1.rows[0];
    check('kiosk_claim_pos_transaction: a registered phone returns is_registered=true', posRow1.is_registered === true);
    check('kiosk_claim_pos_transaction: profile_id matches the registered customer', posRow1.profile_id === DEMO_PROFILE);
    const expectedAddedPos = Math.round(75 * RATE);
    check('kiosk_claim_pos_transaction: added_points = round(amount * points_rate), amount came from the table, not the caller', posRow1.added_points === expectedAddedPos);
    check('kiosk_claim_pos_transaction: prev_points matches the balance before this call', posRow1.prev_points === prevBalancePos);

    const balAfterPos = await admin(c => c.query(
      'select points from merchant_loyalty where user_id=$1 and merchant_id=$2', [DEMO_PROFILE, MATAM]
    ));
    check('kiosk_claim_pos_transaction: merchant_loyalty.points actually updated to match', balAfterPos.rows[0].points === posRow1.total_points);

    const invRowPos1 = await admin(c => c.query('select * from invoices where id=$1', [posRow1.invoice_id]));
    check('kiosk_claim_pos_transaction: invoice.vat came from pos_transactions.vat, not zero', Number(invRowPos1.rows[0].vat) === 3.75);
    check('kiosk_claim_pos_transaction: invoice.source = pos', invRowPos1.rows[0].source === 'pos');
    check('kiosk_claim_pos_transaction: invoice.external_ref threaded through from pos_transactions', invRowPos1.rows[0].external_ref === 'POS-TEST-1');

    const posTxn1After = await admin(c => c.query('select * from pos_transactions where id=$1', [posTxn1.rows[0].id]));
    check('kiosk_claim_pos_transaction: pos_transactions.status is applied', posTxn1After.rows[0].status === 'applied');
    check('kiosk_claim_pos_transaction: pos_transactions.invoice_id links back to the invoice, no customer_phone column exists at all', posTxn1After.rows[0].invoice_id === posRow1.invoice_id);

    const reclaimAttempt = await asUser(kioskUid, async c => {
      try { await c.query('select * from kiosk_claim_pos_transaction($1,$2)', [posTxn1.rows[0].id, '512345678']); return 'ok'; }
      catch (e) { return 'fail:' + e.message; }
    });
    check('kiosk_claim_pos_transaction: an already-applied transaction cannot be claimed again', reclaimAttempt !== 'ok' && /NOJ_TRANSACTION_NOT_PENDING/.test(reclaimAttempt));

    // ---- unregistered customer path ----
    const UNREG_PHONE = '566677788';
    const posTxn2 = await admin(c => c.query(
      `insert into pos_transactions (branch_id, amount, vat, external_ref) values ($1,$2,$3,$4) returning id`,
      [BRANCH, '40.00', '2.00', 'POS-TEST-2']
    ));
    const claimRes2 = await asUser(kioskUid, c => c.query(
      'select * from kiosk_claim_pos_transaction($1,$2)', [posTxn2.rows[0].id, UNREG_PHONE]
    ));
    const posRow2 = claimRes2.rows[0];
    check('kiosk_claim_pos_transaction: an unregistered phone returns is_registered=false, not rejected', posRow2.is_registered === false);
    check('kiosk_claim_pos_transaction: profile_id is null for an unregistered phone', posRow2.profile_id === null);
    check('kiosk_claim_pos_transaction: added_points is still computed for an unregistered phone', posRow2.added_points === Math.round(40 * RATE));

    const unclaimedRow1 = await admin(c => c.query('select * from unclaimed_customers where phone=$1', [UNREG_PHONE]));
    check('unclaimed_customers: a row is created on the first unregistered invoice', unclaimedRow1.rows.length === 1);
    const firstLastInvoiceAt = unclaimedRow1.rows[0].last_invoice_at;

    const pendingInvRow1 = await admin(c => c.query('select * from invoices where id=$1', [posRow2.invoice_id]));
    check('invoices: the unregistered invoice has pending_phone set and user_id null', pendingInvRow1.rows[0].pending_phone === UNREG_PHONE && pendingInvRow1.rows[0].user_id === null);

    // a second invoice for the same unregistered phone must bump last_invoice_at, not duplicate the row.
    await new Promise(r => setTimeout(r, 50));
    const posTxn3 = await admin(c => c.query(
      `insert into pos_transactions (branch_id, amount, vat, external_ref) values ($1,$2,$3,$4) returning id`,
      [BRANCH, '15.00', '0.75', 'POS-TEST-3']
    ));
    await asUser(kioskUid, c => c.query('select * from kiosk_claim_pos_transaction($1,$2)', [posTxn3.rows[0].id, UNREG_PHONE]));
    const unclaimedRow2 = await admin(c => c.query('select * from unclaimed_customers where phone=$1', [UNREG_PHONE]));
    check('unclaimed_customers: still exactly one row for the same phone (on conflict update, not duplicate)', unclaimedRow2.rows.length === 1);
    check('unclaimed_customers: last_invoice_at is bumped by a second invoice, not left at the first', unclaimedRow2.rows[0].last_invoice_at.getTime() > firstLastInvoiceAt.getTime());

    // ---- claim_unclaimed_invoices(): must refuse until phone_verified_at is set ----
    const claimantUid = crypto.randomUUID();
    await admin(c => c.query('insert into auth.users (id) values ($1)', [claimantUid]));
    const claimantProf = await adminAsUser(claimantUid, c => c.query('select * from claim_or_create_profile($1) as p', [UNREG_PHONE]));
    // a brand-new profile has no consent yet — the SAME check_consent_
    // before_earn() trigger that gates a live kiosk earn also fires on the
    // 'earn' rows claim_unclaimed_invoices() itself inserts (it is just
    // another INSERT into point_transactions, no special-casing anywhere),
    // discovered by actually running this, not by reading the function.
    // Give it real consent first, same prerequisite any other earn needs.
    await admin(c => c.query(
      `insert into profile_consents (profile_id, consent_type, text_version, channel) values ($1,'data_processing','v1','app')`,
      [claimantProf.rows[0].id]
    ));

    const refusedClaim = await asUser(claimantUid, async c => {
      try { await c.query('select claim_unclaimed_invoices()'); return 'ok'; }
      catch (e) { return 'fail:' + e.message; }
    });
    check('claim_unclaimed_invoices: refuses to transfer while phone_verified_at is null (no real OTP exists yet)',
      refusedClaim !== 'ok' && /NOJ_PHONE_NOT_VERIFIED/.test(refusedClaim));

    const stillPending = await admin(c => c.query(`select count(*) from invoices where pending_phone=$1`, [UNREG_PHONE]));
    check('claim_unclaimed_invoices: nothing was transferred by the refused attempt', Number(stillPending.rows[0].count) === 2);

    // simulate a real OTP provider having verified this phone — nothing in
    // this codebase sets phone_verified_at yet; this stands in for that
    // future, separate piece of work.
    await admin(c => c.query(`update profiles set phone_verified_at=now() where auth_user_id=$1`, [claimantUid]));

    const claimCountRes = await asUser(claimantUid, c => c.query('select claim_unclaimed_invoices() as n'));
    check('claim_unclaimed_invoices: transfers exactly the 2 pending invoices once verified', Number(claimCountRes.rows[0].n) === 2);

    const claimantProfile = await admin(c => c.query('select id from profiles where auth_user_id=$1', [claimantUid]));
    const transferredInvoices = await admin(c => c.query(
      `select * from invoices where merchant_id=$1 and external_ref in ('POS-TEST-2','POS-TEST-3')`, [MATAM]
    ));
    check('claim_unclaimed_invoices: both invoices now belong to the real profile, pending_phone cleared',
      transferredInvoices.rows.every(r => r.user_id === claimantProfile.rows[0].id && r.pending_phone === null));

    const claimantBalance = await admin(c => c.query(
      'select points from merchant_loyalty where user_id=$1 and merchant_id=$2', [claimantProfile.rows[0].id, MATAM]
    ));
    const expectedTransferredPoints = Math.round(40 * RATE) + Math.round(15 * RATE);
    check('claim_unclaimed_invoices: merchant_loyalty balance equals the sum of both invoices\' points', claimantBalance.rows[0].points === expectedTransferredPoints);

    const transferredPtRows = await admin(c => c.query(
      `select * from point_transactions where user_id=$1 and merchant_id=$2 and source='pos'`, [claimantProfile.rows[0].id, MATAM]
    ));
    check('claim_unclaimed_invoices: a point_transactions ledger row exists per transferred invoice', transferredPtRows.rows.length === 2);

    const unclaimedGone = await admin(c => c.query('select 1 from unclaimed_customers where phone=$1', [UNREG_PHONE]));
    check('claim_unclaimed_invoices: the unclaimed_customers anchor row is deleted after a successful claim', unclaimedGone.rows.length === 0);

    // ---- RLS: a device only ever sees its own branch's pos_transactions,
    //      and unclaimed_customers is unreachable by anyone at all ----
    const ownPosRead = await asUser(kioskUid, c => c.query('select id from pos_transactions where branch_id=$1', [BRANCH]));
    check('pos_transactions RLS: the paired device can select its own branch\'s rows', ownPosRead.rows.length >= 1);
    const foreignPosRead = await asUser(unpairedUid, c => c.query('select id from pos_transactions where branch_id=$1', [BRANCH]));
    check('pos_transactions RLS: an unpaired device cannot select this branch\'s pos_transactions', foreignPosRead.rows.length === 0);

    const deviceReadUnclaimed = await asUser(kioskUid, async c => {
      try { await c.query('select * from unclaimed_customers'); return 'ok'; }
      catch (e) { return 'fail:' + e.message; }
    });
    check('unclaimed_customers: no table grant at all, not just RLS — even a paired device is flatly refused (same lockout shape as branch_admin_pins)',
      deviceReadUnclaimed !== 'ok' && /permission denied/.test(deviceReadUnclaimed));

    // ---- device_id targeting: a transaction pinned to ONE device is
    //      invisible/unclaimable to a DIFFERENT device on the SAME branch ----
    const kioskUid2 = crypto.randomUUID();
    await admin(c => c.query('insert into auth.users (id) values ($1)', [kioskUid2]));
    const pairReq2 = await asUser(kioskUid2, c => c.query('select * from request_device_pairing()'));
    await asUser(adminUid, c => c.query('select * from approve_device_pairing($1,$2)', [pairReq2.rows[0].pairing_code, BRANCH]));

    const posTxnTargeted = await admin(c => c.query(
      `insert into pos_transactions (branch_id, device_id, amount, external_ref) values ($1,$2,$3,$4) returning id`,
      [BRANCH, DEVICE_ID, '10.00', 'POS-TEST-TARGETED']
    ));
    const otherDeviceRead = await asUser(kioskUid2, c => c.query('select id from pos_transactions where id=$1', [posTxnTargeted.rows[0].id]));
    check('pos_transactions RLS: a transaction pinned to device A is invisible to device B on the same branch', otherDeviceRead.rows.length === 0);
    const otherDeviceClaim = await asUser(kioskUid2, async c => {
      try { await c.query('select * from kiosk_claim_pos_transaction($1,$2)', [posTxnTargeted.rows[0].id, '512345678']); return 'ok'; }
      catch (e) { return 'fail:' + e.message; }
    });
    check('kiosk_claim_pos_transaction: device B cannot claim a transaction pinned to device A', otherDeviceClaim !== 'ok' && /NOJ_TRANSACTION_NOT_FOUND/.test(otherDeviceClaim));
    const ownDeviceClaim = await asUser(kioskUid, c => c.query('select * from kiosk_claim_pos_transaction($1,$2)', [posTxnTargeted.rows[0].id, '512345678']));
    check('kiosk_claim_pos_transaction: device A (the pinned device) CAN claim its own targeted transaction', ownDeviceClaim.rows[0].is_registered === true);

    const posTxnBroadcast = await admin(c => c.query(
      `insert into pos_transactions (branch_id, amount, external_ref) values ($1,$2,$3) returning id`,
      [BRANCH, '5.00', 'POS-TEST-BROADCAST']
    ));
    const broadcastRead = await asUser(kioskUid2, c => c.query('select id from pos_transactions where id=$1', [posTxnBroadcast.rows[0].id]));
    check('pos_transactions RLS: a transaction with no device_id is visible to ANY device on the branch', broadcastRead.rows.length === 1);

    // ---- expired transaction: the time check is the authority, not the column ----
    const posTxnExpired = await admin(c => c.query(
      `insert into pos_transactions (branch_id, amount, external_ref, expires_at) values ($1,$2,$3, now() - interval '1 minute') returning id`,
      [BRANCH, '8.00', 'POS-TEST-EXPIRED']
    ));
    const expiredClaim = await asUser(kioskUid, async c => {
      try { await c.query('select * from kiosk_claim_pos_transaction($1,$2)', [posTxnExpired.rows[0].id, '512345678']); return 'ok'; }
      catch (e) { return 'fail:' + e.message; }
    });
    check('kiosk_claim_pos_transaction: an expired pending transaction is rejected', expiredClaim !== 'ok' && /NOJ_TRANSACTION_EXPIRED/.test(expiredClaim));
    const expiredRowAfter = await admin(c => c.query('select status from pos_transactions where id=$1', [posTxnExpired.rows[0].id]));
    check('kiosk_claim_pos_transaction: the expired row\'s status is NOT rewritten (removed dead code — a write right before raise exception is always rolled back)', expiredRowAfter.rows[0].status === 'pending');

    // NOTE on points_rate NULL handling: attempted to test this directly
    // (update merchants set points_rate=null) and discovered merchants.
    // points_rate is `not null default 1.0` with `check (points_rate > 0)`
    // (supabase-migration-loyalty-rate-expiry.sql) — the database itself
    // rejects a NULL before any function ever runs, so this path cannot
    // actually be reached today. coalesce(v_merchant.points_rate, 0) in
    // kiosk_claim_pos_transaction() is kept as cheap, harmless defensive
    // coding (guards against a future schema relaxation of that
    // constraint), not a fix for a currently-reachable bug — reported as
    // such rather than leaving an untestable/misleading assertion in place.

    // =========================================================================
    // 14) Real phone verification, stage 1: otp_requests (record_otp_request)
    //     + claim_or_create_verified_profile(). The OLD claim_or_create_
    //     profile(p_phone) must stay completely unchanged — nothing calls
    //     the new path yet (index.html wiring is a later stage).
    // =========================================================================
    const verifiedCustUid = crypto.randomUUID();
    await admin(c => c.query('insert into auth.users (id) values ($1)', [verifiedCustUid]));

    const unverifiedAttempt = await asUser(verifiedCustUid, async c => {
      try { await c.query('select * from claim_or_create_verified_profile()'); return 'ok'; }
      catch (e) { return 'fail:' + e.message; }
    });
    check('claim_or_create_verified_profile: refuses a session whose auth.users.phone_confirmed_at is still null',
      unverifiedAttempt !== 'ok' && /NOJ_PHONE_NOT_VERIFIED/.test(unverifiedAttempt));

    // simulate what ONLY Supabase Auth itself can do: a real OTP round-trip
    // succeeded for this exact session (auth.updateUser + auth.verifyOtp,
    // a later stage) — stored in Supabase's own E.164-without-'+' convention.
    await admin(c => c.query(
      `update auth.users set phone=$1, phone_confirmed_at=now() where id=$2`,
      ['966599999991', verifiedCustUid]
    ));

    const verifiedRes = await asUser(verifiedCustUid, c => c.query('select * from claim_or_create_verified_profile()'));
    const verifiedProfile = verifiedRes.rows[0];
    check('claim_or_create_verified_profile: creates a profile with the NORMALIZED phone (no country code), not the raw auth.users value', verifiedProfile.phone === '599999991');
    check('claim_or_create_verified_profile: phone_verified_at is stamped', verifiedProfile.phone_verified_at !== null);

    await new Promise(r => setTimeout(r, 50));
    const verifiedRes2 = await asUser(verifiedCustUid, c => c.query('select * from claim_or_create_verified_profile()'));
    const verifiedProfile2 = verifiedRes2.rows[0];
    check('claim_or_create_verified_profile: calling it again returns the SAME profile, not a duplicate', verifiedProfile2.id === verifiedProfile.id);
    check('claim_or_create_verified_profile: phone_verified_at is the FIRST stamp, never overwritten on a later call', verifiedProfile2.phone_verified_at.getTime() === verifiedProfile.phone_verified_at.getTime());

    // a session whose phone_confirmed_at IS set but whose phone is not a
    // Saudi number must still be rejected — normalize_sa_phone() is the de
    // facto "Saudi numbers only" gate at the DB layer, independent of
    // whatever the SMS hook checks before even sending.
    const nonSaudiUid = crypto.randomUUID();
    await admin(c => c.query('insert into auth.users (id, phone, phone_confirmed_at) values ($1,$2,now())', [nonSaudiUid, '971501234567']));
    const nonSaudiAttempt = await asUser(nonSaudiUid, async c => {
      try { await c.query('select * from claim_or_create_verified_profile()'); return 'ok'; }
      catch (e) { return 'fail:' + e.message; }
    });
    check('claim_or_create_verified_profile: a verified but non-Saudi phone is still rejected (normalize_sa_phone is the Saudi-only gate)',
      nonSaudiAttempt !== 'ok' && /رقم جوال غير صحيح/.test(nonSaudiAttempt));

    // the OLD function's BODY must stay completely untouched: still trusts
    // its parameter, and critically still never stamps phone_verified_at —
    // proving the two paths are properly separated, not silently merged.
    // Called via adminAsUser (superuser, bypasses the revoke below) because
    // this checks the function's LOGIC, not its client-reachability — that
    // is the separate, dedicated assertion right after this one.
    const oldPathUid = crypto.randomUUID();
    await admin(c => c.query('insert into auth.users (id) values ($1)', [oldPathUid]));
    const oldPathRes = await adminAsUser(oldPathUid, c => c.query('select * from claim_or_create_profile($1)', ['599999992']));
    check('claim_or_create_profile (OLD path): body still works completely unchanged, trusting its parameter as before', oldPathRes.rows[0].phone === '599999992');
    check('claim_or_create_profile (OLD path): phone_verified_at stays NULL — this path never verifies anything', oldPathRes.rows[0].phone_verified_at === null);

    // THE FIX: unlike the body above, the function must no longer be
    // reachable by a real authenticated client at all — this is the exact
    // function that was found open on the live project (see CLAUDE.md).
    const oldPathAsRealClient = await asUser(oldPathUid, async c => {
      try { await c.query('select claim_or_create_profile($1)', ['599999993']); return 'ok'; }
      catch (e) { return 'fail:' + e.message; }
    });
    check('claim_or_create_profile: no grant to authenticated at all any more — unreachable from any real client',
      oldPathAsRealClient !== 'ok' && /permission denied/.test(oldPathAsRealClient));

    // ---- record_otp_request(): per-device cap, defense-in-depth layer ----
    const otpDeviceUid = crypto.randomUUID();
    await admin(c => c.query('insert into auth.users (id) values ($1)', [otpDeviceUid]));
    for (let i = 0; i < 5; i++) {
      const r = await asUser(otpDeviceUid, async c => {
        try { await c.query('select record_otp_request()'); return 'ok'; }
        catch (e) { return 'fail:' + e.message; }
      });
      check('record_otp_request: request #' + (i + 1) + ' within the hourly cap succeeds', r === 'ok');
    }
    const sixthAttempt = await asUser(otpDeviceUid, async c => {
      try { await c.query('select record_otp_request()'); return 'ok'; }
      catch (e) { return 'fail:' + e.message; }
    });
    check('record_otp_request: the 6th request within the same hour is rejected', sixthAttempt !== 'ok' && /NOJ_OTP_RATE_LIMITED/.test(sixthAttempt));

    const otherDeviceOtp = await asUser(unpairedUid, async c => {
      try { await c.query('select record_otp_request()'); return 'ok'; }
      catch (e) { return 'fail:' + e.message; }
    });
    check('record_otp_request: a DIFFERENT device has its own independent counter, unaffected by the first device\'s cap', otherDeviceOtp === 'ok');

    const otpTableDirectRead = await asUser(otpDeviceUid, async c => {
      try { await c.query('select * from otp_requests'); return 'ok'; }
      catch (e) { return 'fail:' + e.message; }
    });
    check('otp_requests: no table grant at all — unreachable directly by any client, same lockout shape as unclaimed_customers/branch_admin_pins',
      otpTableDirectRead !== 'ok' && /permission denied/.test(otpTableDirectRead));

    // =========================================================================
    // 15) POS invoice intake, stage 2: issue_branch_pos_token() +
    //     intake_pos_transaction(). The pos-intake Edge Function itself is
    //     tested separately via `deno test` (supabase/functions/pos-intake/
    //     intake.test.ts) — this covers only the SQL side.
    // =========================================================================
    const sha256Hex = (s) => crypto.createHash('sha256').update(s).digest('hex');

    const token1 = await admin(c => c.query('select issue_branch_pos_token($1) as t', [BRANCH]));
    const rawToken1 = token1.rows[0].t;
    check('issue_branch_pos_token: returns a non-trivial raw token', typeof rawToken1 === 'string' && rawToken1.length >= 32);

    const cred1 = await admin(c => c.query('select token_hash from branch_pos_credentials where branch_id=$1', [BRANCH]));
    check('issue_branch_pos_token: stores only the HASH, matching sha256(token) computed independently (SQL digest() and Node crypto agree)',
      cred1.rows[0].token_hash === sha256Hex(rawToken1));

    // re-issuing (rotation) replaces the hash — the old token's hash no
    // longer matches the stored row.
    const token2 = await admin(c => c.query('select issue_branch_pos_token($1) as t', [BRANCH]));
    const rawToken2 = token2.rows[0].t;
    check('issue_branch_pos_token: rotation produces a DIFFERENT raw token', rawToken2 !== rawToken1);
    const cred2 = await admin(c => c.query('select token_hash from branch_pos_credentials where branch_id=$1', [BRANCH]));
    check('issue_branch_pos_token: rotation replaces the stored hash (old token hash no longer matches)',
      cred2.rows[0].token_hash === sha256Hex(rawToken2) && cred2.rows[0].token_hash !== sha256Hex(rawToken1));
    check('issue_branch_pos_token: still exactly one row for this branch (upsert, not a second row)',
      (await admin(c => c.query('select count(*) from branch_pos_credentials where branch_id=$1', [BRANCH]))).rows[0].count === '1');

    // --- intake_pos_transaction(): the only way a row enters pos_transactions ---
    const intake1 = await admin(c => c.query(
      `select * from intake_pos_transaction($1,$2,$3,$4,$5,$6,$7)`,
      [BRANCH, null, 'POS-INTAKE-1', '42.00', '2.10', 'generic', JSON.stringify({ till: 'A1' })]
    ));
    const row1 = intake1.rows[0];
    check('intake_pos_transaction: creates a pending row with the given amount/vat', Number(row1.amount) === 42 && Number(row1.vat) === 2.1 && row1.status === 'pending');
    check('intake_pos_transaction: source_adapter stored as given', row1.source_adapter === 'generic');

    // idempotent re-post: SAME external_ref, DIFFERENT amount — must return
    // the ORIGINAL row completely unchanged, not a second row, not a merge.
    const intake1Retry = await admin(c => c.query(
      `select * from intake_pos_transaction($1,$2,$3,$4,$5,$6,$7)`,
      [BRANCH, null, 'POS-INTAKE-1', '999.00', '0', 'generic', null]
    ));
    const row1Retry = intake1Retry.rows[0];
    check('intake_pos_transaction: re-posting the same external_ref returns the SAME row id', row1Retry.id === row1.id);
    check('intake_pos_transaction: the retry\'s different amount is NOT merged in — original amount preserved', Number(row1Retry.amount) === 42);
    const posCountForRef = await admin(c => c.query(`select count(*) from pos_transactions where branch_id=$1 and external_ref=$2`, [BRANCH, 'POS-INTAKE-1']));
    check('intake_pos_transaction: no duplicate row was created by the retry', posCountForRef.rows[0].count === '1');

    // device_id must belong to the SAME branch being posted to.
    const otherBranchDeviceUid = crypto.randomUUID();
    await admin(c => c.query('insert into auth.users (id) values ($1)', [otherBranchDeviceUid]));
    const otherBranchDevice = await admin(c => c.query(
      `insert into devices (auth_user_id, branch_id, is_active) values ($1,$2,true) returning id`,
      [otherBranchDeviceUid, OTHER_MERCHANT] // branches.id == merchants.id per the branches-devices backfill
    ));

    const wrongBranchDeviceAttempt = await admin(async c => {
      try { await c.query(`select * from intake_pos_transaction($1,$2,$3,$4,$5,$6,$7)`,
        [BRANCH, otherBranchDevice.rows[0].id, 'POS-INTAKE-2', '10.00', '0', 'generic', null]); return 'ok'; }
      catch (e) { return 'fail:' + e.message; }
    });
    check('intake_pos_transaction: a device_id belonging to a DIFFERENT branch is rejected (NOJ_DEVICE_NOT_IN_BRANCH)',
      wrongBranchDeviceAttempt !== 'ok' && /NOJ_DEVICE_NOT_IN_BRANCH/.test(wrongBranchDeviceAttempt));

    const rightBranchDeviceIntake = await admin(c => c.query(
      `select * from intake_pos_transaction($1,$2,$3,$4,$5,$6,$7)`,
      [BRANCH, DEVICE_ID, 'POS-INTAKE-3', '10.00', '0', 'generic', null]
    ));
    check('intake_pos_transaction: a device_id belonging to the SAME branch succeeds', rightBranchDeviceIntake.rows[0].device_id === DEVICE_ID);

    const badAmountIntake = await admin(async c => {
      try { await c.query(`select * from intake_pos_transaction($1,$2,$3,$4,$5,$6,$7)`,
        [BRANCH, null, 'POS-INTAKE-4', '0', '0', 'generic', null]); return 'ok'; }
      catch (e) { return 'fail:' + e.message; }
    });
    check('intake_pos_transaction: a zero amount is rejected by the existing CHECK constraint (stage 1, unchanged)', badAmountIntake !== 'ok');

    // --- lockdown: neither function nor the credentials table is reachable by any client role ---
    const issueTokenAsDevice = await asUser(kioskUid, async c => {
      try { await c.query('select issue_branch_pos_token($1)', [BRANCH]); return 'ok'; }
      catch (e) { return 'fail:' + e.message; }
    });
    check('issue_branch_pos_token: no grant to authenticated at all — unreachable from any client', issueTokenAsDevice !== 'ok' && /permission denied/.test(issueTokenAsDevice));

    const intakeAsDevice = await asUser(kioskUid, async c => {
      try { await c.query(`select * from intake_pos_transaction($1,$2,$3,$4,$5,$6,$7)`, [BRANCH, null, 'POS-INTAKE-5', '10.00', '0', 'generic', null]); return 'ok'; }
      catch (e) { return 'fail:' + e.message; }
    });
    check('intake_pos_transaction: no grant to authenticated at all — unreachable from any client (only the Edge Function\'s service-role client calls it)', intakeAsDevice !== 'ok' && /permission denied/.test(intakeAsDevice));

    // ...but IS reachable by service_role — the actual role pos-intake's
    // Edge Function client authenticates as (SUPABASE_SERVICE_ROLE_KEY).
    // Confirms the grant added alongside the anon/authenticated revoke
    // actually serves its purpose, not just that access got narrower.
    const intakeAsServiceRole = await asServiceRole(c => c.query(
      `select * from intake_pos_transaction($1,$2,$3,$4,$5,$6,$7)`,
      [BRANCH, null, 'POS-INTAKE-SERVICE-ROLE', '10.00', '0', 'generic', null]
    ));
    check('intake_pos_transaction: IS reachable by service_role, exactly the role the Edge Function uses', intakeAsServiceRole.rows[0].status === 'pending');

    const credsDirectRead = await asUser(kioskUid, async c => {
      try { await c.query('select * from branch_pos_credentials'); return 'ok'; }
      catch (e) { return 'fail:' + e.message; }
    });
    check('branch_pos_credentials: no table grant at all — unreachable directly, same lockout shape as branch_admin_pins/unclaimed_customers/otp_requests',
      credsDirectRead !== 'ok' && /permission denied/.test(credsDirectRead));

    // =========================================================================
    // 16) PRIVILEGE LOCKDOWN follow-up: functions found reachable by
    //     anon/authenticated on the LIVE project despite a `revoke ... from
    //     public` (or no revoke at all) — root cause confirmed and now
    //     simulated locally too (00_auth_stub.sql): Supabase's own bootstrap
    //     grants EXECUTE to anon/authenticated/service_role BY NAME on
    //     every new function in `public`, not via the PUBLIC pseudo-role.
    // =========================================================================

    // --- request_data_deletion(): admin/SQL-editor only, had NO revoke at
    //     all before this fix — the single most dangerous function found
    //     (any authenticated session could irreversibly scrub ANY profile).
    const victimForDeletionTest = await admin(c => c.query(`insert into profiles (phone) values ('599999994') returning id`));
    const deletionAsClient = await asUser(kioskUid, async c => {
      try { await c.query('select request_data_deletion($1)', [victimForDeletionTest.rows[0].id]); return 'ok'; }
      catch (e) { return 'fail:' + e.message; }
    });
    check('request_data_deletion: no grant to authenticated at all — unreachable from any client',
      deletionAsClient !== 'ok' && /permission denied/.test(deletionAsClient));
    const victimUntouched = await admin(c => c.query('select deleted_at from profiles where id=$1', [victimForDeletionTest.rows[0].id]));
    check('request_data_deletion: the targeted profile is untouched after the rejected attempt', victimUntouched.rows[0].deleted_at === null);

    // --- purge_expired_unclaimed_customers(): cron/SQL-editor only, also
    //     had NO revoke at all before this fix.
    const purgeAsClient = await asUser(kioskUid, async c => {
      try { await c.query('select purge_expired_unclaimed_customers()'); return 'ok'; }
      catch (e) { return 'fail:' + e.message; }
    });
    check('purge_expired_unclaimed_customers: no grant to authenticated at all — unreachable from any client',
      purgeAsClient !== 'ok' && /permission denied/.test(purgeAsClient));

    // --- merchant_members: RLS-only lockout (no INSERT policy at all) must
    //     actually hold — a customer/kiosk session must never be able to
    //     make itself an "owner" of some merchant it has no real relation
    //     to (which would then let it approve_device_pairing() onto that
    //     merchant's branches).
    const selfAddAsMember = await asUser(unpairedUid, async c => {
      try { await c.query(`insert into merchant_members (merchant_id, auth_user_id, role) values ($1,$2,'owner')`, [MATAM, unpairedUid]); return 'ok'; }
      catch (e) { return 'fail:' + e.message; }
    });
    check('merchant_members: a client cannot INSERT itself as a member of any merchant (RLS: no INSERT policy at all)',
      selfAddAsMember !== 'ok' && /permission denied|policy/i.test(selfAddAsMember));
    const noSelfMembership = await admin(c => c.query('select 1 from merchant_members where merchant_id=$1 and auth_user_id=$2', [MATAM, unpairedUid]));
    check('merchant_members: no row was created by the rejected self-insert attempt', noSelfMembership.rows.length === 0);

    // --- anon: batch-confirm every function this PR narrowed from "anon,
    //     authenticated" down to "authenticated" no longer grants anon
    //     EXECUTE at all (has_function_privilege avoids ten more RPC round
    //     trips for what is really one fact per function).
    const anonStillGranted = await admin(c => c.query(`
      select proname, has_function_privilege('anon', p.oid, 'EXECUTE') as anon_can
      from pg_proc p
      where p.pronamespace = 'public'::regnamespace
        and p.proname in (
          'grant_app_consent', 'get_merchant_clinics', 'current_device_branch_id',
          'kiosk_lookup_customer_points', 'request_device_pairing', 'kiosk_earn_points',
          'get_merchant_queue_stats', 'redeem_reward', 'verify_admin_pin'
        )
    `));
    check('anon: none of the functions narrowed to authenticated-only still grant EXECUTE to anon',
      anonStillGranted.rows.length === 9 && anonStillGranted.rows.every(r => r.anon_can === false));

    // =========================================================================
    // 17) verify_admin_pin(): branch binding (current_device_branch_id())
    //     and the new per-branch rate limit (5 failures / 15 minutes).
    // =========================================================================
    const PIN_PLAIN = '1234';
    // unqualified crypt()/gen_salt() — resolves via the connection's default
    // search_path (public locally, where pgcrypto lands when supabase-
    // schema.sql installs it with no explicit schema; extensions on a real
    // Supabase project, which pre-creates that schema itself). Matches how
    // verify_admin_pin() itself resolves them (set search_path = public,
    // extensions covers both, in whichever order each actually exists).
    await admin(c => c.query(
      `insert into branch_admin_pins (branch_id, pin_hash) values ($1, crypt($2, gen_salt('bf')))`,
      [BRANCH, PIN_PLAIN]
    ));

    const attemptsDirectRead = await asUser(kioskUid, async c => {
      try { await c.query('select * from admin_pin_attempts'); return 'ok'; }
      catch (e) { return 'fail:' + e.message; }
    });
    check('admin_pin_attempts: no table grant at all — unreachable directly, same lockout shape as branch_admin_pins',
      attemptsDirectRead !== 'ok' && /permission denied/.test(attemptsDirectRead));

    const correctPinAsOwnDevice = await asUser(kioskUid, c => c.query('select verify_admin_pin($1,$2) as ok', [BRANCH, PIN_PLAIN]));
    check('verify_admin_pin: the branch\'s own paired device verifying its OWN branch\'s correct PIN succeeds', correctPinAsOwnDevice.rows[0].ok === true);

    const wrongBranchAttempt = await asUser(kioskUid, async c => {
      try { await c.query('select verify_admin_pin($1,$2)', [OTHER_MERCHANT, PIN_PLAIN]); return 'ok'; }
      catch (e) { return 'fail:' + e.message; }
    });
    check('verify_admin_pin: a device tries a DIFFERENT branch\'s PIN than the one it is paired to — rejected (NOJ_PIN_WRONG_BRANCH)',
      wrongBranchAttempt !== 'ok' && /NOJ_PIN_WRONG_BRANCH/.test(wrongBranchAttempt));

    const nonDeviceAttempt = await asUser(claimantUid, async c => {
      try { await c.query('select verify_admin_pin($1,$2)', [BRANCH, PIN_PLAIN]); return 'ok'; }
      catch (e) { return 'fail:' + e.message; }
    });
    check('verify_admin_pin: a plain customer session (no devices row at all) is rejected the same way',
      nonDeviceAttempt !== 'ok' && /NOJ_PIN_WRONG_BRANCH/.test(nonDeviceAttempt));

    // rate limit: 4 wrong PINs must still return false (not lock yet); the
    // 5th crosses the threshold and locks the branch for subsequent tries —
    // even with the CORRECT PIN now.
    for (let i = 0; i < 4; i++) {
      const r = await asUser(kioskUid, c => c.query('select verify_admin_pin($1,$2) as ok', [BRANCH, '0000']));
      check(`verify_admin_pin: wrong-PIN attempt #${i + 1} returns false, not locked yet`, r.rows[0].ok === false);
    }
    const fifthWrong = await asUser(kioskUid, async c => {
      try { const r = await c.query('select verify_admin_pin($1,$2) as ok', [BRANCH, '0000']); return { ok: true, val: r.rows[0].ok }; }
      catch (e) { return { ok: false, msg: e.message }; }
    });
    check('verify_admin_pin: the 5th wrong PIN within the window still returns false (not an exception) — it is what TRIGGERS the lock',
      fifthWrong.ok === true && fifthWrong.val === false);

    const lockedAttemptEvenWithCorrectPin = await asUser(kioskUid, async c => {
      try { await c.query('select verify_admin_pin($1,$2)', [BRANCH, PIN_PLAIN]); return 'ok'; }
      catch (e) { return 'fail:' + e.message; }
    });
    check('verify_admin_pin: once locked, even the CORRECT PIN is rejected (NOJ_PIN_LOCKED) until the lock expires',
      lockedAttemptEvenWithCorrectPin !== 'ok' && /NOJ_PIN_LOCKED/.test(lockedAttemptEvenWithCorrectPin));

    const otherBranchAttempts = await admin(c => c.query('select 1 from admin_pin_attempts where branch_id=$1', [OTHER_MERCHANT]));
    check('verify_admin_pin: a DIFFERENT branch has no lockout row at all — the rate limit is per-branch, not global/shared', otherBranchAttempts.rows.length === 0);

    // simulate the 15-minute lock having expired (no real-time wait in a
    // test) — the correct PIN must succeed again and clear the row entirely.
    await admin(c => c.query(`update admin_pin_attempts set locked_until = now() - interval '1 second' where branch_id=$1`, [BRANCH]));
    const afterLockExpires = await asUser(kioskUid, c => c.query('select verify_admin_pin($1,$2) as ok', [BRANCH, PIN_PLAIN]));
    check('verify_admin_pin: once the lock window has passed, the correct PIN succeeds again', afterLockExpires.rows[0].ok === true);
    const attemptsClearedAfterSuccess = await admin(c => c.query('select 1 from admin_pin_attempts where branch_id=$1', [BRANCH]));
    check('verify_admin_pin: a successful verification clears the attempts row entirely', attemptsClearedAfterSuccess.rows.length === 0);

    // window reset: a failure window older than 15 minutes must reset the
    // counter to 1 on the next wrong PIN, not keep accumulating toward an
    // instant re-lock. The row was just cleared by the success above, so
    // seed it directly to set up this "stale window" scenario precisely.
    await admin(c => c.query(
      `insert into admin_pin_attempts (branch_id, fail_count, window_started_at, locked_until) values ($1,4, now() - interval '16 minutes', null)
       on conflict (branch_id) do update set fail_count=4, window_started_at=now() - interval '16 minutes', locked_until=null`,
      [BRANCH]
    ));
    const afterWindowExpired = await asUser(kioskUid, c => c.query('select verify_admin_pin($1,$2) as ok', [BRANCH, '0000']));
    check('verify_admin_pin: a wrong PIN after the 15-minute window has passed resets the counter to 1, not 5', afterWindowExpired.rows[0].ok === false);
    const attemptsAfterReset = await admin(c => c.query('select fail_count, locked_until from admin_pin_attempts where branch_id=$1', [BRANCH]));
    check('verify_admin_pin: fail_count reset to 1 (not accumulated to 5), and not locked',
      attemptsAfterReset.rows[0].fail_count === 1 && attemptsAfterReset.rows[0].locked_until === null);
  }

  console.log('\n=== SUMMARY:', pass, 'passed,', fail, 'failed ===');
  if (failures.length) console.log('Failures:', JSON.stringify(failures, null, 2));
  process.exit(fail > 0 ? 1 : 0);
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
