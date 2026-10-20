const { Client } = require('pg');
const { execSync } = require('child_process');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

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
    'supabase-migration-pos-transactions.sql', 'supabase-migration-pos-transactions-realtime.sql',
    'supabase-migration-phone-otp-foundation.sql',
    'supabase-migration-pos-intake.sql',
    'supabase-migration-merchant-admin-controls.sql',
    'supabase-migration-pos-connections.sql',
    'supabase-migration-merchant-invoices.sql',
    'supabase-migration-pos-vat-inclusive.sql',
    'supabase-migration-pending-points.sql',
    'supabase-migration-pos-refunds.sql',
    'supabase-migration-unified-sectors.sql',
  ].map(f => path.join(REPO_ROOT, f));
  // a byte-level snapshot of everything the sector unification must NOT touch,
  // taken right before that migration runs (checked in section 21e)
  const SECTOR_SNAPSHOT_SQL = {
    invoices: `select id, user_id, pending_phone, merchant_id, branch_id, amount, vat, category, points_earned, status, refunded_amount, created_at from invoices order by id`,
    ledger: `select * from point_transactions order by id`,
    loyalty: `select user_id, merchant_id, points, tier from merchant_loyalty order by user_id, merchant_id`,
    merchants: `select id, name, type, points_hold_days, points_rate from merchants order by id`,
  };
  let preSectorSnapshot = null, postSectorSnapshot = null;
  for (const f of filesFromPhoneFormat) {
    if (f.endsWith('supabase-migration-unified-sectors.sql')) {
      preSectorSnapshot = {};
      for (const [k, q] of Object.entries(SECTOR_SNAPSHOT_SQL)) {
        preSectorSnapshot[k] = (await admin(c => c.query(q))).rows;
      }
      preSectorSnapshot.branchSectors = (await admin(c => c.query(`select branch_id, sector_code from branch_settings order by branch_id`))).rows;
    }
    execSync(`su postgres -c "psql -q -v ON_ERROR_STOP=1 -d noj_test -f '${f}'"`, { stdio: 'pipe' });
    if (f.endsWith('supabase-migration-unified-sectors.sql')) {
      postSectorSnapshot = {};
      for (const [k, q] of Object.entries(SECTOR_SNAPSHOT_SQL)) {
        postSectorSnapshot[k] = (await admin(c => c.query(q))).rows;
      }
    }
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

    // ---- merchant_members: a plain SELECT of one's own membership row —
    //      exactly the query merchant.html's checkAccess() runs on login (no
    //      RPC involved, just RLS + the existing grant). adminUid is the
    //      owner who approved pairing above; strangerAdminUid belongs to a
    //      DIFFERENT merchant (OTHER_MERCHANT) entirely. ----
    const ownMembership = await asUser(adminUid, c => c.query('select merchant_id, role from merchant_members where auth_user_id=$1', [adminUid]));
    check('merchant_members RLS: an owner can select their OWN membership row directly', ownMembership.rows.length === 1 && ownMembership.rows[0].merchant_id === MATAM && ownMembership.rows[0].role === 'owner');
    const plainCustomerUid = crypto.randomUUID();
    await admin(c => c.query('insert into auth.users (id) values ($1)', [plainCustomerUid]));
    const noMembership = await asUser(plainCustomerUid, c => c.query('select merchant_id, role from merchant_members where auth_user_id=$1', [plainCustomerUid]));
    check('merchant_members RLS: a session with no membership row at all gets zero rows (not an error)', noMembership.rows.length === 0);
    const crossMerchantRead = await asUser(adminUid, c => c.query('select merchant_id from merchant_members where auth_user_id=$1', [strangerAdminUid]));
    check('merchant_members RLS: one owner cannot read a DIFFERENT merchant\'s member row by guessing its auth_user_id', crossMerchantRead.rows.length === 0);

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
    check('kiosk_claim_pos_transaction: the REGISTERED-customer invoice carries branch_id = the claiming device\'s branch', invRowPos1.rows[0].branch_id === BRANCH);
    check('invoices.refunded_amount is NULL on a fresh invoice (nothing reads it yet)', invRowPos1.rows[0].refunded_amount === null);

    const posTxn1After = await admin(c => c.query('select * from pos_transactions where id=$1', [posTxn1.rows[0].id]));
    check('kiosk_claim_pos_transaction: pos_transactions.status is applied', posTxn1After.rows[0].status === 'applied');
    check('kiosk_claim_pos_transaction: pos_transactions.invoice_id links back to the invoice, no customer_phone column exists at all', posTxn1After.rows[0].invoice_id === posRow1.invoice_id);

    const reclaimAttempt = await asUser(kioskUid, async c => {
      try { await c.query('select * from kiosk_claim_pos_transaction($1,$2)', [posTxn1.rows[0].id, '512345678']); return 'ok'; }
      catch (e) { return 'fail:' + e.message; }
    });
    check('kiosk_claim_pos_transaction: an already-applied transaction cannot be claimed again', reclaimAttempt !== 'ok' && /NOJ_TRANSACTION_NOT_PENDING/.test(reclaimAttempt));

    // ---- accounting rule: points are computed on the WHOLE amount (VAT included), never on amount - vat ----
    const vatInc = await admin(c => c.query(
      `select * from intake_pos_transaction($1,$2,$3,$4,$5,$6,$7)`, [BRANCH, null, 'POS-VAT-INCLUSIVE', '115.00', '15.00', 'generic', null]
    ));
    const vatIncClaim = await asUser(kioskUid, c => c.query('select * from kiosk_claim_pos_transaction($1,$2)', [vatInc.rows[0].id, '512345678']));
    check('accounting rule: points = round(115.00 × rate) — computed on the gross total, NOT on 100 (amount − vat)',
      vatIncClaim.rows[0].added_points === Math.round(115 * RATE));
    const vatIncInv = await admin(c => c.query('select amount, vat from invoices where id=$1', [vatIncClaim.rows[0].invoice_id]));
    check('accounting rule: the invoice stores amount = 115.00 (gross) and vat = 15.00 (contained portion)', Number(vatIncInv.rows[0].amount) === 115 && Number(vatIncInv.rows[0].vat) === 15);

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
    check('kiosk_claim_pos_transaction: the UNREGISTERED-customer invoice carries branch_id too', pendingInvRow1.rows[0].branch_id === BRANCH);

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

    // =========================================================================
    // 13ب) current_device_branch_id()/current_device_id() + the inline
    //      branch_settings device policies now all check is_active and
    //      revoked_at is null — a revoked device loses branch_settings AND
    //      pos_transactions access, not just the write-path RPCs
    //      (kiosk_earn_points etc.) that already checked both. A dedicated
    //      device/user here, not kioskUid — kioskUid stays a going concern
    //      for every later section in this file (issue_branch_pos_token,
    //      verify_admin_pin...).
    // =========================================================================
    const revokedKioskUid = crypto.randomUUID();
    await admin(c => c.query('insert into auth.users (id) values ($1)', [revokedKioskUid]));
    const revokedReq = await asUser(revokedKioskUid, c => c.query('select * from request_device_pairing()'));
    await asUser(adminUid, c => c.query('select * from approve_device_pairing($1,$2)', [revokedReq.rows[0].pairing_code, BRANCH]));

    const beforeRevokeSettings = await asUser(revokedKioskUid, c => c.query('select * from branch_settings where branch_id=$1', [BRANCH]));
    check('revocation: a freshly-paired, active device CAN read its own branch_settings (sanity check before revoking)', beforeRevokeSettings.rows.length === 1);
    const beforeRevokePos = await asUser(revokedKioskUid, c => c.query('select id from pos_transactions where branch_id=$1', [BRANCH]));
    check('revocation: a freshly-paired, active device CAN read its branch\'s pos_transactions (sanity check before revoking)', beforeRevokePos.rows.length >= 1);

    await admin(c => c.query('update devices set is_active=false where auth_user_id=$1', [revokedKioskUid]));

    const afterRevokeSettings = await asUser(revokedKioskUid, c => c.query('select * from branch_settings where branch_id=$1', [BRANCH]));
    check('revocation: is_active=false — the device can no longer read branch_settings at all', afterRevokeSettings.rows.length === 0);
    const afterRevokePos = await asUser(revokedKioskUid, c => c.query('select id from pos_transactions where branch_id=$1', [BRANCH]));
    check('revocation: is_active=false — the device can no longer read pos_transactions at all', afterRevokePos.rows.length === 0);
    const afterRevokeBranchId = await asUser(revokedKioskUid, c => c.query('select current_device_branch_id() as b'));
    check('revocation: current_device_branch_id() returns NULL for a revoked device', afterRevokeBranchId.rows[0].b === null);
    const afterRevokeDeviceId = await asUser(revokedKioskUid, c => c.query('select current_device_id() as d'));
    check('revocation: current_device_id() returns NULL for a revoked device', afterRevokeDeviceId.rows[0].d === null);

    // re-activate, then revoke via revoked_at instead — the OTHER half of
    // the "is_active and revoked_at is null" predicate, same assertions.
    await admin(c => c.query('update devices set is_active=true, revoked_at=null where auth_user_id=$1', [revokedKioskUid]));
    const reactivatedSettings = await asUser(revokedKioskUid, c => c.query('select * from branch_settings where branch_id=$1', [BRANCH]));
    check('revocation: re-activating (is_active=true, revoked_at=null) restores branch_settings access', reactivatedSettings.rows.length === 1);

    await admin(c => c.query('update devices set revoked_at=now() where auth_user_id=$1', [revokedKioskUid]));
    const revokedAtSettings = await asUser(revokedKioskUid, c => c.query('select * from branch_settings where branch_id=$1', [BRANCH]));
    check('revocation: revoked_at set (is_active still true) ALSO blocks branch_settings access', revokedAtSettings.rows.length === 0);
    const revokedAtPos = await asUser(revokedKioskUid, c => c.query('select id from pos_transactions where branch_id=$1', [BRANCH]));
    check('revocation: revoked_at set ALSO blocks pos_transactions access', revokedAtPos.rows.length === 0);

    // kioskUid (used by every later section in this file) is untouched and
    // still fully active — this block only ever acted on revokedKioskUid.
    const kioskUidStillWorks = await asUser(kioskUid, c => c.query('select * from branch_settings where branch_id=$1', [BRANCH]));
    check('revocation: the UNRELATED, still-active paired device (kioskUid) is completely unaffected', kioskUidStillWorks.rows.length === 1);

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

  // =========================================================================
  // 18) MERCHANT DASHBOARD ADMIN CONTROLS (owner-only): merchant_set_admin_
  //     pin() + merchant_issue_pos_token() (supabase-migration-merchant-
  //     admin-controls.sql). Fresh fixtures in this block, independent of
  //     section 9-17's closed scope above — branches.id === merchants.id
  //     per the branches-devices auto-mirror backfill (confirmed in section
  //     15 above), so BRANCH can just be MATAM directly, no extra query.
  // =========================================================================
  {
    const sha256Hex = (s) => crypto.createHash('sha256').update(s).digest('hex');
    const BRANCH = MATAM;
    const OTHER_MERCHANT = '20000000-0000-0000-0000-000000000002'; // بنده

    const ownerUid = crypto.randomUUID();
    await admin(c => c.query('insert into auth.users (id) values ($1)', [ownerUid]));
    await admin(c => c.query(`insert into merchant_members (merchant_id, auth_user_id, role) values ($1,$2,'owner')`, [MATAM, ownerUid]));

    const staffUid = crypto.randomUUID();
    await admin(c => c.query('insert into auth.users (id) values ($1)', [staffUid]));
    await admin(c => c.query(`insert into merchant_members (merchant_id, auth_user_id, role) values ($1,$2,'staff')`, [MATAM, staffUid]));

    const strangerOwnerUid = crypto.randomUUID();
    await admin(c => c.query('insert into auth.users (id) values ($1)', [strangerOwnerUid]));
    await admin(c => c.query(`insert into merchant_members (merchant_id, auth_user_id, role) values ($1,$2,'owner')`, [OTHER_MERCHANT, strangerOwnerUid]));

    // a real paired device of BRANCH, to confirm merchant_set_admin_pin()'s
    // write is actually usable through verify_admin_pin() the way a real
    // kiosk would call it — not just that a row changed somewhere.
    const pinKioskUid = crypto.randomUUID();
    await admin(c => c.query('insert into auth.users (id) values ($1)', [pinKioskUid]));
    await admin(c => c.query(`insert into devices (auth_user_id, branch_id, is_active) values ($1,$2,true)`, [pinKioskUid, BRANCH]));

    // ---- merchant_set_admin_pin() ----
    const staffPinAttempt = await asUser(staffUid, async c => {
      try { await c.query('select merchant_set_admin_pin($1,$2)', [BRANCH, '1234']); return 'ok'; }
      catch (e) { return 'fail:' + e.message; }
    });
    check('merchant_set_admin_pin: a STAFF member (not owner) of this branch\'s own merchant is rejected',
      staffPinAttempt !== 'ok' && /لا تملك صلاحية/.test(staffPinAttempt));

    const strangerPinAttempt = await asUser(strangerOwnerUid, async c => {
      try { await c.query('select merchant_set_admin_pin($1,$2)', [BRANCH, '1234']); return 'ok'; }
      catch (e) { return 'fail:' + e.message; }
    });
    check('merchant_set_admin_pin: an OWNER of a DIFFERENT merchant is rejected',
      strangerPinAttempt !== 'ok' && /لا تملك صلاحية/.test(strangerPinAttempt));

    const badFormatAttempts = await Promise.all(['12', 'abcd', '12345', ''].map(bad =>
      asUser(ownerUid, async c => {
        try { await c.query('select merchant_set_admin_pin($1,$2)', [BRANCH, bad]); return 'ok'; }
        catch (e) { return 'fail:' + e.message; }
      })
    ));
    check('merchant_set_admin_pin: a non-4-digit PIN is rejected in every malformed shape tried',
      badFormatAttempts.every(r => r !== 'ok'));

    const ownerSetPin = await asUser(ownerUid, async c => {
      try { const res = await c.query('select merchant_set_admin_pin($1,$2) as r', [BRANCH, '4321']); return { ok: true, value: res.rows[0].r }; }
      catch (e) { return { ok: false, message: e.message }; }
    });
    check('merchant_set_admin_pin: the rightful OWNER sets a PIN successfully', ownerSetPin.ok === true);
    // psql/node-pg represent a void return as an empty string, never the
    // PIN itself — this is the actual observed shape (confirmed locally),
    // not an assumption.
    check('merchant_set_admin_pin: returns VOID — the PIN value never comes back in the result', ownerSetPin.value === '');

    const verifyRight = await asUser(pinKioskUid, c => c.query('select verify_admin_pin($1,$2) as ok', [BRANCH, '4321']));
    check('merchant_set_admin_pin: the PIN it set is immediately usable through the REAL verify_admin_pin() path', verifyRight.rows[0].ok === true);
    const verifyWrong = await asUser(pinKioskUid, c => c.query('select verify_admin_pin($1,$2) as ok', [BRANCH, '0000']));
    check('merchant_set_admin_pin: a different PIN does not verify', verifyWrong.rows[0].ok === false);

    // seed a prior lockout, then confirm a fresh merchant_set_admin_pin()
    // clears it — an owner who forgot a locked-out PIN isn't stuck waiting.
    await admin(c => c.query(
      `insert into admin_pin_attempts (branch_id, fail_count, window_started_at, locked_until) values ($1,5,now(),now() + interval '15 minutes')
       on conflict (branch_id) do update set fail_count=5, window_started_at=now(), locked_until=now() + interval '15 minutes'`,
      [BRANCH]
    ));
    await asUser(ownerUid, c => c.query('select merchant_set_admin_pin($1,$2)', [BRANCH, '7777']));
    const attemptsAfterPinChange = await admin(c => c.query('select 1 from admin_pin_attempts where branch_id=$1', [BRANCH]));
    check('merchant_set_admin_pin: setting a new PIN clears any prior lockout/attempts row for this branch', attemptsAfterPinChange.rows.length === 0);
    const lockedPinNowWorks = await asUser(pinKioskUid, c => c.query('select verify_admin_pin($1,$2) as ok', [BRANCH, '7777']));
    check('merchant_set_admin_pin: the branch is no longer locked out after the PIN change', lockedPinNowWorks.rows[0].ok === true);

    // ---- merchant_issue_pos_token() ----
    const staffTokenAttempt = await asUser(staffUid, async c => {
      try { await c.query('select merchant_issue_pos_token($1)', [BRANCH]); return 'ok'; }
      catch (e) { return 'fail:' + e.message; }
    });
    check('merchant_issue_pos_token: a STAFF member is rejected',
      staffTokenAttempt !== 'ok' && /لا تملك صلاحية/.test(staffTokenAttempt));

    const strangerTokenAttempt = await asUser(strangerOwnerUid, async c => {
      try { await c.query('select merchant_issue_pos_token($1)', [BRANCH]); return 'ok'; }
      catch (e) { return 'fail:' + e.message; }
    });
    check('merchant_issue_pos_token: an OWNER of a DIFFERENT merchant is rejected',
      strangerTokenAttempt !== 'ok' && /لا تملك صلاحية/.test(strangerTokenAttempt));

    const ownerToken1 = await asUser(ownerUid, c => c.query('select merchant_issue_pos_token($1) as t', [BRANCH]));
    const rawMToken1 = ownerToken1.rows[0].t;
    check('merchant_issue_pos_token: the rightful OWNER issues a non-trivial raw token', typeof rawMToken1 === 'string' && rawMToken1.length >= 32);
    const mCred1 = await admin(c => c.query('select token_hash from branch_pos_credentials where branch_id=$1', [BRANCH]));
    check('merchant_issue_pos_token: stores only the sha256 HASH, via the delegated issue_branch_pos_token()', mCred1.rows[0].token_hash === sha256Hex(rawMToken1));

    const ownerToken2 = await asUser(ownerUid, c => c.query('select merchant_issue_pos_token($1) as t', [BRANCH]));
    const rawMToken2 = ownerToken2.rows[0].t;
    check('merchant_issue_pos_token: rotation (calling again) produces a DIFFERENT raw token', rawMToken2 !== rawMToken1);
    const mCred2 = await admin(c => c.query('select token_hash from branch_pos_credentials where branch_id=$1', [BRANCH]));
    check('merchant_issue_pos_token: rotation replaces the stored hash (old token no longer matches)',
      mCred2.rows[0].token_hash === sha256Hex(rawMToken2) && mCred2.rows[0].token_hash !== sha256Hex(rawMToken1));
    check('merchant_issue_pos_token: still exactly one row for this branch (upsert, not a second row)',
      (await admin(c => c.query('select count(*) from branch_pos_credentials where branch_id=$1', [BRANCH]))).rows[0].count === '1');

    // ---- general lockdown: neither function grants EXECUTE to anon ----
    const anonCanSetPin = await admin(c => c.query(
      `select has_function_privilege('anon', 'merchant_set_admin_pin(uuid,text)', 'EXECUTE') as can`
    ));
    check('merchant_set_admin_pin: anon is NOT granted EXECUTE at all', anonCanSetPin.rows[0].can === false);
    const anonCanIssueToken = await admin(c => c.query(
      `select has_function_privilege('anon', 'merchant_issue_pos_token(uuid)', 'EXECUTE') as can`
    ));
    check('merchant_issue_pos_token: anon is NOT granted EXECUTE at all', anonCanIssueToken.rows[0].can === false);
  }

  // =========================================================================
  // 19) POS CONNECTIONS (stage 0): pos_connections status mirror,
  //     record_pos_connection_event(), and the additive side effects on
  //     issue_branch_pos_token / merchant_issue_pos_token / intake_pos_
  //     transaction — plus invoices.refunded_amount and the idempotent
  //     backfill. Fresh fixtures on OTHER_MERCHANT's branch (branches.id ===
  //     merchants.id), independent of every earlier block's scope.
  // =========================================================================
  {
    const B2 = '20000000-0000-0000-0000-000000000002'; // بنده (merchant id === branch id)
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');
    const conn = (provider) => admin(c => c.query('select * from pos_connections where branch_id=$1 and provider=$2', [B2, provider]));

    const ownerUid2 = crypto.randomUUID();
    await admin(c => c.query('insert into auth.users (id) values ($1)', [ownerUid2]));
    await admin(c => c.query(`insert into merchant_members (merchant_id, auth_user_id, role) values ($1,$2,'owner')`, [B2, ownerUid2]));
    const staffUid2 = crypto.randomUUID();
    await admin(c => c.query('insert into auth.users (id) values ($1)', [staffUid2]));
    await admin(c => c.query(`insert into merchant_members (merchant_id, auth_user_id, role) values ($1,$2,'staff')`, [B2, staffUid2]));
    const otherMerchantOwner = crypto.randomUUID();
    await admin(c => c.query('insert into auth.users (id) values ($1)', [otherMerchantOwner]));
    await admin(c => c.query(`insert into merchant_members (merchant_id, auth_user_id, role) values ($1,$2,'owner')`, [MATAM, otherMerchantOwner]));
    const plainUid2 = crypto.randomUUID();
    await admin(c => c.query('insert into auth.users (id) values ($1)', [plainUid2]));

    await admin(c => c.query('delete from pos_connections where branch_id=$1', [B2]));

    // ---- lockdown of the internal writer ----
    const writerPriv = await admin(c => c.query(
      `select has_function_privilege('anon', 'record_pos_connection_event(uuid,text,text,text)', 'EXECUTE') as anon_can,
              has_function_privilege('authenticated', 'record_pos_connection_event(uuid,text,text,text)', 'EXECUTE') as auth_can,
              has_function_privilege('service_role', 'record_pos_connection_event(uuid,text,text,text)', 'EXECUTE') as svc_can`
    ));
    check('record_pos_connection_event: NO role (anon/authenticated/service_role) can execute it directly',
      writerPriv.rows[0].anon_can === false && writerPriv.rows[0].auth_can === false && writerPriv.rows[0].svc_can === false);
    const writerAsOwner = await asUser(ownerUid2, async c => {
      try { await c.query(`select record_pos_connection_event($1,'generic','token_issued','token_issued')`, [B2]); return 'ok'; }
      catch (e) { return 'fail:' + e.message; }
    });
    check('record_pos_connection_event: a merchant owner calling it directly is refused (permission denied)', writerAsOwner !== 'ok' && /permission denied/.test(writerAsOwner));

    // ---- issue_branch_pos_token: same return + the connection row ----
    const t1 = await admin(c => c.query('select issue_branch_pos_token($1) as t', [B2]));
    const raw1 = t1.rows[0].t;
    check('issue_branch_pos_token (stage 0): still returns the raw token, hash stored exactly as before',
      typeof raw1 === 'string' && raw1.length >= 32 &&
      (await admin(c => c.query('select token_hash from branch_pos_credentials where branch_id=$1', [B2]))).rows[0].token_hash === sha(raw1));
    const c1 = await conn('generic');
    check('issue_branch_pos_token: wrote exactly one pos_connections row (generic / token_issued / connected)',
      c1.rows.length === 1 && c1.rows[0].kind === 'token_issued' && c1.rows[0].status === 'connected' && c1.rows[0].connected_at !== null);
    check('issue_branch_pos_token: no invoice has arrived yet, last_invoice_at is NULL', c1.rows[0].last_invoice_at === null);

    // rotation: still one row, connected_at restarts, a prior error clears
    await admin(c => c.query(`update pos_connections set status='error', last_error='boom' where id=$1`, [c1.rows[0].id]));
    await sleep(30);
    const t2 = await admin(c => c.query('select issue_branch_pos_token($1) as t', [B2]));
    const c2 = await conn('generic');
    check('issue_branch_pos_token: rotation yields a different token', t2.rows[0].t !== raw1);
    check('issue_branch_pos_token: rotation keeps exactly ONE connection row, status back to connected, error cleared, connected_at advanced',
      c2.rows.length === 1 && c2.rows[0].status === 'connected' && c2.rows[0].last_error === null &&
      new Date(c2.rows[0].connected_at) > new Date(c1.rows[0].connected_at));

    // merchant_issue_pos_token (untouched function) is covered via delegation
    await admin(c => c.query('delete from pos_connections where branch_id=$1', [B2]));
    const mt = await asUser(ownerUid2, c => c.query('select merchant_issue_pos_token($1) as t', [B2]));
    check('merchant_issue_pos_token: still returns a token for the owner', typeof mt.rows[0].t === 'string' && mt.rows[0].t.length >= 32);
    check('merchant_issue_pos_token: the connection row is written too, via issue_branch_pos_token (function itself unmodified)',
      (await conn('generic')).rows.length === 1);
    const staffTok = await asUser(staffUid2, async c => {
      try { await c.query('select merchant_issue_pos_token($1)', [B2]); return 'ok'; }
      catch (e) { return 'fail:' + e.message; }
    });
    check('merchant_issue_pos_token: a staff member is STILL refused (owner-only behaviour unchanged)', staffTok !== 'ok' && /لا تملك صلاحية/.test(staffTok));

    // ---- intake_pos_transaction: last_invoice_at ----
    const intake = (ref, adapter) => asServiceRole(c => c.query(
      'select * from intake_pos_transaction($1,$2,$3,$4,$5,$6,$7)', [B2, null, ref, '25.00', '1.25', adapter || 'generic', null]
    ));
    const i1 = await intake('CONN-1');
    check('intake_pos_transaction (stage 0): still returns the pending row exactly as before', i1.rows[0].status === 'pending' && Number(i1.rows[0].amount) === 25);
    const afterI1 = await conn('generic');
    check('intake_pos_transaction: a NEW invoice sets last_invoice_at', afterI1.rows[0].last_invoice_at !== null);
    await sleep(40);
    const i1retry = await intake('CONN-1');
    const afterRetry = await conn('generic');
    check('intake_pos_transaction: an idempotent re-post returns the SAME row id', i1retry.rows[0].id === i1.rows[0].id);
    check('intake_pos_transaction: an idempotent re-post is NOT a new invoice — last_invoice_at unchanged',
      afterRetry.rows[0].last_invoice_at.getTime() === afterI1.rows[0].last_invoice_at.getTime());
    await intake('CONN-2');
    const afterI2 = await conn('generic');
    check('intake_pos_transaction: a second genuinely new invoice moves last_invoice_at forward',
      afterI2.rows[0].last_invoice_at > afterI1.rows[0].last_invoice_at);

    // a branch that never went through token issuing still gets a row on its first invoice
    await admin(c => c.query('delete from pos_connections where branch_id=$1', [B2]));
    await intake('CONN-3');
    const created = await conn('generic');
    check('intake_pos_transaction: first invoice for a branch with no connection row creates it (token_issued / connected / last_invoice_at set)',
      created.rows.length === 1 && created.rows[0].kind === 'token_issued' && created.rows[0].status === 'connected' && created.rows[0].last_invoice_at !== null);

    // ---- best-effort isolation: a failing status write must NEVER fail an intake ----
    await admin(c => c.query(`alter table pos_connections add constraint tmp_conn_fail_chk check (provider <> 'failtest')`));
    const failIntake = await asServiceRole(async c => {
      try { const r = await c.query('select * from intake_pos_transaction($1,$2,$3,$4,$5,$6,$7)', [B2, null, 'CONN-FAIL', '9.00', '0', 'failtest', null]); return { ok: true, row: r.rows[0] }; }
      catch (e) { return { ok: false, msg: e.message }; }
    });
    await admin(c => c.query('alter table pos_connections drop constraint tmp_conn_fail_chk'));
    check('intake_pos_transaction: when the connection write fails, the invoice intake STILL succeeds', failIntake.ok === true && failIntake.row.status === 'pending');
    check('intake_pos_transaction: the pos_transactions row really exists after the swallowed failure',
      (await admin(c => c.query(`select 1 from pos_transactions where branch_id=$1 and external_ref='CONN-FAIL'`, [B2]))).rows.length === 1);
    check('intake_pos_transaction: and no half-written connection row was left behind', (await conn('failtest')).rows.length === 0);

    // ---- RLS: who can read pos_connections ----
    const ownerRead = await asUser(ownerUid2, c => c.query('select * from pos_connections where branch_id=$1', [B2]));
    check('pos_connections RLS: the merchant OWNER can read their branch connections', ownerRead.rows.length >= 1);
    const staffRead = await asUser(staffUid2, c => c.query('select * from pos_connections where branch_id=$1', [B2]));
    check('pos_connections RLS: a merchant STAFF member can read them too (status is not a secret)', staffRead.rows.length >= 1);
    const strangerRead = await asUser(otherMerchantOwner, c => c.query('select * from pos_connections where branch_id=$1', [B2]));
    check('pos_connections RLS: an owner of a DIFFERENT merchant sees zero rows', strangerRead.rows.length === 0);
    const plainRead = await asUser(plainUid2, c => c.query('select * from pos_connections where branch_id=$1', [B2]));
    check('pos_connections RLS: a session with no membership sees zero rows', plainRead.rows.length === 0);
    const writeAttempts = await asUser(ownerUid2, async c => {
      const out = [];
      for (const q of [
        [`insert into pos_connections (branch_id, provider, kind) values ($1,'x','oauth')`, [B2]],
        [`update pos_connections set status='error' where branch_id=$1`, [B2]],
        [`delete from pos_connections where branch_id=$1`, [B2]],
      ]) {
        try { await c.query(q[0], q[1]); out.push('ok'); } catch (e) { out.push('fail:' + e.message); }
      }
      return out;
    });
    check('pos_connections: even the OWNER has no insert/update/delete grant — every write goes through the definer function',
      writeAttempts.every(r => r !== 'ok' && /permission denied/.test(r)));
    const secretCols = await admin(c => c.query(
      `select column_name from information_schema.columns where table_name='pos_connections' and column_name ~* '(token|secret|hash|key)'`
    ));
    check('pos_connections holds NO secret-looking column at all', secretCols.rows.length === 0);

    // ---- invoices.refunded_amount ----
    const invForRefund = await admin(c => c.query(
      `insert into invoices (user_id, merchant_id, amount, vat, category, points_earned, status, source)
       values ($1,$2,100,0,'x',0,'paid','pos') returning id`,
      [DEMO_PROFILE, MATAM]
    )).catch(() => null);
    if (invForRefund) {
      const ok1 = await admin(c => c.query('update invoices set refunded_amount=40 where id=$1 returning refunded_amount', [invForRefund.rows[0].id]));
      check('invoices.refunded_amount: a partial refund amount (0..amount) is accepted', Number(ok1.rows[0].refunded_amount) === 40);
      const bad = [-1, 100.01];
      for (const v of bad) {
        const r = await admin(async c => { try { await c.query('update invoices set refunded_amount=$1 where id=$2', [v, invForRefund.rows[0].id]); return 'ok'; } catch (e) { return 'fail'; } });
        check(`invoices.refunded_amount: ${v} is rejected by the CHECK constraint`, r === 'fail');
      }
    } else {
      check('invoices.refunded_amount tests: fixture invoice could be created', false);
    }

    // ---- backfill + idempotency: re-run the whole migration file against a "legacy-looking" state ----
    const legacyInv = await admin(c => c.query(`select i.id, pt.branch_id from invoices i join pos_transactions pt on pt.invoice_id = i.id where i.source='pos' limit 1`));
    await admin(c => c.query('update invoices set branch_id=null where id=$1', [legacyInv.rows[0].id]));
    await admin(c => c.query('delete from pos_connections'));
    execSync(`su postgres -c "psql -q -v ON_ERROR_STOP=1 -d noj_test -f '${path.join(REPO_ROOT, 'supabase-migration-pos-connections.sql')}'"`, { stdio: 'pipe' });
    const restored = await admin(c => c.query('select branch_id from invoices where id=$1', [legacyInv.rows[0].id]));
    check('backfill: a POS invoice with NULL branch_id is restored from its pos_transactions row (re-running the migration is safe)', restored.rows[0].branch_id === legacyInv.rows[0].branch_id);
    const nullable = await admin(c => c.query(
      `select count(*)::int as n from invoices i
       where i.branch_id is null and (select count(*) from branches b where b.merchant_id = i.merchant_id) = 1`
    ));
    check('backfill: no invoice of a single-branch merchant is left with a NULL branch_id', nullable.rows[0].n === 0);
    const credCount = await admin(c => c.query('select count(*)::int as n from branch_pos_credentials'));
    const connCount = await admin(c => c.query(`select count(*)::int as n from pos_connections where provider='generic' and kind='token_issued'`));
    check('backfill: every branch that already holds a token gets a connected pos_connections row', connCount.rows[0].n === credCount.rows[0].n && credCount.rows[0].n > 0);
    const backfilledLast = await admin(c => c.query(
      `select c.last_invoice_at, (select max(received_at) from pos_transactions where branch_id=c.branch_id and source_adapter='generic') as m
       from pos_connections c where c.branch_id=$1`, [B2]));
    check('backfill: last_invoice_at is derived from the real pos_transactions history', backfilledLast.rows[0].last_invoice_at.getTime() === backfilledLast.rows[0].m.getTime());
    const rerun = execSync(`su postgres -c "psql -q -v ON_ERROR_STOP=1 -d noj_test -f '${path.join(REPO_ROOT, 'supabase-migration-pos-connections.sql')}'"`, { stdio: 'pipe' });
    check('migration is idempotent: a second run succeeds with no error', rerun !== null);
    const connCount2 = await admin(c => c.query(`select count(*)::int as n from pos_connections`));
    check('migration is idempotent: a second run creates no duplicate connection rows', connCount2.rows[0].n === connCount.rows[0].n);
  }

  // =========================================================================
  // 20) merchant_list_invoices() (supabase-migration-merchant-invoices.sql):
  //     the merchant dashboard's read-only invoices report. Fresh merchants
  //     so every total is deterministic (the seeded merchants already carry
  //     invoices of their own).
  // =========================================================================
  {
    const newMerchant = async (name) => (await admin(c => c.query(
      `insert into merchants (name, type, logo_color) values ($1,'x','#000000') returning id`, [name]
    ))).rows[0].id;
    const M1 = await newMerchant('تاجر فواتير');
    const M2 = await newMerchant('تاجر آخر للفواتير');
    const BA = M1; // auto-mirrored branch (branches.id === merchants.id)
    const BB = (await admin(c => c.query(`insert into branches (merchant_id, name) values ($1,'فرع ب') returning id`, [M1]))).rows[0].id;
    const B_OTHER = M2;

    const mkUser = async (merchantId, role) => {
      const uid = crypto.randomUUID();
      await admin(c => c.query('insert into auth.users (id) values ($1)', [uid]));
      if (merchantId) await admin(c => c.query(`insert into merchant_members (merchant_id, auth_user_id, role) values ($1,$2,$3)`, [merchantId, uid, role]));
      return uid;
    };
    const ownerU = await mkUser(M1, 'owner');
    const staffU = await mkUser(M1, 'staff');
    const otherOwnerU = await mkUser(M2, 'owner');
    const customerU = await mkUser(null);

    const UNREG = '569990001';
    await admin(c => c.query('insert into unclaimed_customers (phone) values ($1) on conflict do nothing', [UNREG]));
    const inv = (merchant, branch, ts, amount, vat, pts, source, opts = {}) => admin(c => c.query(
      `insert into invoices (user_id, pending_phone, merchant_id, branch_id, amount, vat, category, points_earned, status, source, refunded_amount, created_at)
       values ($1,$2,$3,$4,$5,$6,'x',$7,$8,$9,$10,$11)`,
      [opts.unreg ? null : DEMO_PROFILE, opts.unreg ? UNREG : null, merchant, branch, amount, vat, pts, opts.status || 'paid', source, opts.refunded ?? null, ts]
    ));
    // Riyadh is UTC+3 all year (no DST)
    await inv(M1, BA, '2026-03-10T06:00:00Z', 100, 15, 10, 'pos');                    // 09:00 Riyadh, Mar 10, registered
    await inv(M1, BA, '2026-03-10T20:30:00Z', 50, 7.5, 5, 'pos', { unreg: true });     // 23:30 Riyadh, Mar 10, unregistered
    await inv(M1, BB, '2026-03-10T21:30:00Z', 200, 30, 20, 'pos', { refunded: 40 });   // 00:30 Riyadh, MAR 11 (still Mar 10 in UTC)
    await inv(M1, null, '2026-03-09T09:00:00Z', 80, 12, 8, 'manual');                  // legacy, branch NULL
    await inv(M1, BA, '2026-03-10T07:00:00Z', 999, 0, 99, 'demo');                     // demo
    await inv(M1, BA, '2026-03-12T09:00:00Z', 60, 9, 6, 'pos', { status: 'refunded' }); // refunded status, refunded_amount NULL
    await inv(M2, B_OTHER, '2026-03-10T06:00:00Z', 5000, 750, 500, 'pos');             // another merchant

    const call = (uid, args) => asUser(uid, async c => {
      try {
        const r = await c.query('select merchant_list_invoices($1,$2::date,$3::date,$4::uuid,$5::boolean,$6::integer,$7::integer) as r',
          [args.m, args.from, args.to, args.b ?? null, args.demo ?? false, args.limit ?? 25, args.offset ?? 0]);
        return { ok: true, r: r.rows[0].r };
      } catch (e) { return { ok: false, msg: e.message }; }
    });
    const num = (x) => Number(x);

    // ---- authorization ----
    const asStaff = await call(staffU, { m: M1, from: '2026-03-09', to: '2026-03-12' });
    check('merchant_list_invoices: a STAFF member can read their own merchant\'s invoices', asStaff.ok === true);
    const asOwner = await call(ownerU, { m: M1, from: '2026-03-09', to: '2026-03-12' });
    check('merchant_list_invoices: the OWNER can too', asOwner.ok === true);
    const crossMerchant = await call(ownerU, { m: M2, from: '2026-03-09', to: '2026-03-12' });
    check('merchant_list_invoices: an owner naming ANOTHER merchant is rejected (never trusts the parameter)', crossMerchant.ok === false && /لا تملك صلاحية/.test(crossMerchant.msg));
    const otherOwn = await call(otherOwnerU, { m: M2, from: '2026-03-10', to: '2026-03-10' });
    check('merchant_list_invoices: the other merchant sees only its own invoice (isolation)', otherOwn.ok && otherOwn.r.summary.count === 1 && num(otherOwn.r.summary.sales) === 5000);
    const asCustomer = await call(customerU, { m: M1, from: '2026-03-09', to: '2026-03-12' });
    check('merchant_list_invoices: a session with NO membership is rejected', asCustomer.ok === false && /لا تملك صلاحية/.test(asCustomer.msg));
    const foreignBranch = await call(ownerU, { m: M1, from: '2026-03-09', to: '2026-03-12', b: B_OTHER });
    check('merchant_list_invoices: a branch of ANOTHER merchant is rejected, not silently empty', foreignBranch.ok === false && /لا تملك صلاحية/.test(foreignBranch.msg));
    const nullMerchant = await call(ownerU, { m: null, from: '2026-03-09', to: '2026-03-12' });
    check('merchant_list_invoices: a NULL merchant is rejected', nullMerchant.ok === false);
    const priv = await admin(c => c.query(
      `select has_function_privilege('anon', 'merchant_list_invoices(uuid,date,date,uuid,boolean,integer,integer)', 'EXECUTE') as anon_can,
              has_function_privilege('authenticated', 'merchant_list_invoices(uuid,date,date,uuid,boolean,integer,integer)', 'EXECUTE') as auth_can`));
    check('merchant_list_invoices: anon is NOT granted EXECUTE, authenticated is', priv.rows[0].anon_can === false && priv.rows[0].auth_can === true);

    // ---- date window in Riyadh time ----
    const mar10 = await call(ownerU, { m: M1, from: '2026-03-10', to: '2026-03-10' });
    check('Riyadh day window: Mar 10 holds exactly the two invoices made on the 10th Riyadh time (not the 00:30 Mar 11 one that is still Mar 10 in UTC)',
      mar10.ok && mar10.r.summary.count === 2 && num(mar10.r.summary.sales) === 150);
    check('Riyadh day window: totals — vat 22.5, refunded 0, net 150', num(mar10.r.summary.vat) === 22.5 && num(mar10.r.summary.refunded) === 0 && num(mar10.r.summary.net) === 150);
    const mar11 = await call(ownerU, { m: M1, from: '2026-03-11', to: '2026-03-11' });
    check('Riyadh day window: the 00:30 Riyadh invoice belongs to Mar 11 with its refund (200 − 40 = 160)',
      mar11.ok && mar11.r.summary.count === 1 && num(mar11.r.summary.sales) === 200 && num(mar11.r.summary.refunded) === 40 && num(mar11.r.summary.net) === 160);
    check('created_at_riyadh is formatted in Riyadh time', mar11.r.rows[0].created_at_riyadh === '2026-03-11 00:30');

    // ---- full range: totals, legacy NULL branch, demo, refunded status ----
    const all = await call(ownerU, { m: M1, from: '2026-03-09', to: '2026-03-12' });
    check('totals: count = 5 (demo excluded by default; the NULL-branch legacy invoice INCLUDED)', all.r.summary.count === 5);
    check('totals: sales 490, vat 73.5', num(all.r.summary.sales) === 490 && num(all.r.summary.vat) === 73.5);
    check('totals: refunded 100 (a 40 partial + a status=refunded invoice with NULL refunded_amount counted as fully refunded), net 390',
      num(all.r.summary.refunded) === 100 && num(all.r.summary.net) === 390);
    const legacyRow = all.r.rows.find(r => r.branch_id === null);
    check('legacy invoice with branch_id NULL is returned with branch_id/branch_name null (the UI labels it غير محدد)', !!legacyRow && legacyRow.branch_name === null && num(legacyRow.amount) === 80);
    const demoOn = await call(ownerU, { m: M1, from: '2026-03-09', to: '2026-03-12', demo: true });
    check('p_include_demo=true adds the demo invoice (count 6, sales 1489)', demoOn.r.summary.count === 6 && num(demoOn.r.summary.sales) === 1489);
    check('demo invoices are absent from rows by default', !all.r.rows.some(r => r.source === 'demo'));

    // ---- branch filter ----
    const onlyBA = await call(ownerU, { m: M1, from: '2026-03-09', to: '2026-03-12', b: BA });
    check('branch filter: one branch counts only its invoices (3) and DROPS the NULL-branch legacy one', onlyBA.r.summary.count === 3 && num(onlyBA.r.summary.sales) === 210 && !onlyBA.r.rows.some(r => r.branch_id === null));
    const onlyBB = await call(ownerU, { m: M1, from: '2026-03-09', to: '2026-03-12', b: BB });
    check('branch filter: the other branch has its own single invoice, with its branch name', onlyBB.r.summary.count === 1 && onlyBB.r.rows[0].branch_name === 'فرع ب');

    // ---- privacy of the payload ----
    const keys = new Set(all.r.rows.flatMap(r => Object.keys(r)));
    const forbidden = ['user_id', 'pending_phone', 'phone', 'profile_id', 'customer_id', 'external_ref', 'items'];
    check('payload carries NO customer identifier or phone key at all', forbidden.every(k => !keys.has(k)));
    check('payload carries exactly the documented keys',
      JSON.stringify([...keys].sort()) === JSON.stringify(['amount','branch_id','branch_name','created_at_riyadh','customer_status','id','points_earned','refunded_amount','source','status','vat']));
    check('customer_status distinguishes registered / unregistered and nothing else',
      all.r.rows.every(r => ['registered', 'unregistered'].includes(r.customer_status)) && all.r.rows.some(r => r.customer_status === 'unregistered') && all.r.rows.some(r => r.customer_status === 'registered'));
    check('the unregistered customer\'s phone never appears anywhere in the JSON', !JSON.stringify(all.r).includes(UNREG));

    // ---- pagination ----
    const p1 = await call(ownerU, { m: M1, from: '2026-03-09', to: '2026-03-12', limit: 2, offset: 0 });
    const p2 = await call(ownerU, { m: M1, from: '2026-03-09', to: '2026-03-12', limit: 2, offset: 2 });
    const p3 = await call(ownerU, { m: M1, from: '2026-03-09', to: '2026-03-12', limit: 2, offset: 4 });
    check('pagination: totals describe the WHOLE period, not the page (count 5 on every page)', [p1, p2, p3].every(p => p.r.summary.count === 5 && num(p.r.summary.sales) === 490));
    check('pagination: 2 + 2 + 1 rows, has_more true/true/false', p1.r.rows.length === 2 && p2.r.rows.length === 2 && p3.r.rows.length === 1 && p1.r.has_more === true && p2.r.has_more === true && p3.r.has_more === false);
    const ids = [...p1.r.rows, ...p2.r.rows, ...p3.r.rows].map(r => r.id);
    check('pagination: pages are disjoint and together equal the unpaged list, newest first',
      new Set(ids).size === 5 && JSON.stringify(ids) === JSON.stringify(all.r.rows.map(r => r.id)));
    const stamps = all.r.rows.map(r => r.created_at_riyadh);
    check('rows are ordered newest first', JSON.stringify(stamps) === JSON.stringify([...stamps].sort().reverse()));
    const clampedLow = await call(ownerU, { m: M1, from: '2026-03-09', to: '2026-03-12', limit: 0 });
    check('p_limit below 1 is clamped to 1', clampedLow.r.limit === 1 && clampedLow.r.rows.length === 1);
    const clampedHigh = await call(ownerU, { m: M1, from: '2026-03-09', to: '2026-03-12', limit: 100000 });
    check('p_limit above 100 is clamped to 100', clampedHigh.r.limit === 100);
    const negOffset = await call(ownerU, { m: M1, from: '2026-03-09', to: '2026-03-12', offset: -5 });
    check('a negative offset is treated as 0', negOffset.r.offset === 0 && negOffset.r.rows.length === 5);

    // ---- empty period / bad input ----
    const empty = await call(ownerU, { m: M1, from: '2026-01-01', to: '2026-01-02' });
    check('an empty period returns zero totals and no rows (not an error)', empty.ok && empty.r.summary.count === 0 && num(empty.r.summary.sales) === 0 && num(empty.r.summary.net) === 0 && empty.r.rows.length === 0 && empty.r.has_more === false);
    const badRange = await call(ownerU, { m: M1, from: '2026-03-12', to: '2026-03-09' });
    check('to < from is rejected', badRange.ok === false);
    const nullFrom = await call(ownerU, { m: M1, from: null, to: '2026-03-09' });
    check('a NULL date is rejected', nullFrom.ok === false);

    // ---- read-only: nothing the function does changes data ----
    const before = await admin(c => c.query('select count(*)::int as n, coalesce(sum(amount),0) as s from invoices where merchant_id=$1', [M1]));
    await call(ownerU, { m: M1, from: '2026-03-09', to: '2026-03-12' });
    const after = await admin(c => c.query('select count(*)::int as n, coalesce(sum(amount),0) as s from invoices where merchant_id=$1', [M1]));
    check('the function is read-only (invoices unchanged)', before.rows[0].n === after.rows[0].n && before.rows[0].s === after.rows[0].s);
    const idx = await admin(c => c.query(`select 1 from pg_indexes where indexname='invoices_merchant_created_idx'`));
    check('the (merchant_id, created_at desc) index exists', idx.rows.length === 1);
  }

  // =========================================================================
  // 21) VAT-INCLUSIVE ACCOUNTING RULE in intake_pos_transaction()
  //     (supabase-migration-pos-vat-inclusive.sql): amount = total paid incl.
  //     VAT, vat = the portion contained in it, 0 <= vat < amount.
  // =========================================================================
  {
    const B3 = '20000000-0000-0000-0000-000000000002'; // any existing branch
    // Section 19 re-ran pos-connections.sql (idempotency test), which redefines intake_pos_transaction() back to its
    // older body — re-apply this migration (twice: also proves it is idempotent) so we test the real final state.
    for (let i = 0; i < 2; i++) {
      execSync(`su postgres -c "psql -q -v ON_ERROR_STOP=1 -d noj_test -f '${path.join(REPO_ROOT, 'supabase-migration-pos-vat-inclusive.sql')}'"`, { stdio: 'pipe' });
    }
    const run = (ref, amount, vat) => asServiceRole(async c => {
      try { const r = await c.query('select * from intake_pos_transaction($1,$2,$3,$4,$5,$6,$7)', [B3, null, ref, amount, vat, 'generic', null]); return { ok: true, row: r.rows[0] }; }
      catch (e) { return { ok: false, msg: e.message }; }
    });
    const vatOk = await run('VAT-OK', '115.00', '15.00');
    check('VAT rule: amount=115 / vat=15 (15% contained in the total) is accepted and stored as given', vatOk.ok && Number(vatOk.row.amount) === 115 && Number(vatOk.row.vat) === 15);
    check('VAT rule: vat = 0 is accepted', (await run('VAT-ZERO', '50.00', '0')).ok === true);
    check('VAT rule: vat just below amount is accepted (49.99 of 50)', (await run('VAT-EDGE', '50.00', '49.99')).ok === true);
    const eq = await run('VAT-EQ', '50.00', '50.00');
    check('VAT rule: vat == amount is rejected with NOJ_INVALID_VAT', eq.ok === false && /NOJ_INVALID_VAT/.test(eq.msg));
    const gt = await run('VAT-GT', '50.00', '57.50');
    check('VAT rule: vat > amount (tax added on top by mistake) is rejected with NOJ_INVALID_VAT', gt.ok === false && /NOJ_INVALID_VAT/.test(gt.msg));
    const neg = await run('VAT-NEG', '50.00', '-1');
    check('VAT rule: a negative vat is rejected with NOJ_INVALID_VAT', neg.ok === false && /NOJ_INVALID_VAT/.test(neg.msg));
    check('VAT rule: a rejected intake leaves NO row behind',
      (await admin(c => c.query(`select count(*)::int as n from pos_transactions where external_ref in ('VAT-EQ','VAT-GT','VAT-NEG')`))).rows[0].n === 0);
    const zeroAmt = await run('VAT-ZERO-AMT', '0', '0');
    check('VAT rule: amount = 0 still fails on the ORIGINAL amount>0 CHECK, not on NOJ_INVALID_VAT (error unchanged for it)',
      zeroAmt.ok === false && !/NOJ_INVALID_VAT/.test(zeroAmt.msg) && /check|amount/i.test(zeroAmt.msg));
    // idempotent re-post of an already-stored ref still returns the original row (validation applies to the NEW values only)
    const repost = await run('VAT-OK', '115.00', '15.00');
    check('VAT rule: re-posting an existing external_ref still returns the same row (idempotency intact)', repost.ok && repost.row.id === vatOk.row.id);
    const noAuthRole = await asUser(crypto.randomUUID(), async c => {
      try { await c.query('select * from intake_pos_transaction($1,$2,$3,$4,$5,$6,$7)', [B3, null, 'VAT-CLIENT', '10', '1', 'generic', null]); return 'ok'; }
      catch (e) { return 'fail:' + e.message; }
    });
    check('VAT rule: the function is still unreachable by a client role (grants unchanged)', noAuthRole !== 'ok' && /permission denied/.test(noAuthRole));
  }

  // =========================================================================
  // 21b) PENDING POINTS MODEL (supabase-migration-pending-points.sql, PR1):
  //      merchants.points_hold_days, point_transactions.status/release_at,
  //      apply_points_earn(), release_pending_points(), balance reads.
  // =========================================================================
  {
    const GROCER = '20000000-0000-0000-0000-000000000002'; // بنده (type 'بقالة' → 7 days by default); branch id = merchant id
    const MIGRATION = path.join(REPO_ROOT, 'supabase-migration-pending-points.sql');
    const rateRow = await admin(c => c.query('select points_rate from merchants where id=$1', [GROCER]));
    const GRATE = Number(rateRow.rows[0].points_rate);

    // ---- A) defaults + schema ----
    const holds = await admin(c => c.query('select id, type, points_hold_days from merchants'));
    const holdOf = (id) => holds.rows.find(r => r.id === id).points_hold_days;
    check('hold days: the grocery merchant (type بقالة) got 7 by default from its type', holdOf(GROCER) === 7);
    check('hold days: restaurant / cafe / medical / other merchants got 0 (immediate)',
      holdOf('20000000-0000-0000-0000-000000000001') === 0 && holdOf('20000000-0000-0000-0000-000000000003') === 0 &&
      holdOf('20000000-0000-0000-0000-00000000000d') === 0 && holdOf('20000000-0000-0000-0000-00000000000c') === 0);

    const newG = await admin(c => c.query(`insert into merchants (name, type, logo_color) values ('تجربة بقالة','بقالة','#000000') returning id, points_hold_days`));
    const newC = await admin(c => c.query(`insert into merchants (name, type, logo_color) values ('تجربة مقهى','مقاهي','#000000') returning id, points_hold_days`));
    const newX = await admin(c => c.query(`insert into merchants (name, type, logo_color, points_hold_days) values ('تجربة صريح','مقاهي','#000000', 3) returning id, points_hold_days`));
    check('hold days: a NEW grocery merchant is derived to 7, a new cafe to 0', newG.rows[0].points_hold_days === 7 && newC.rows[0].points_hold_days === 0);
    check('hold days: an explicit non-zero value on insert is kept as given', newX.rows[0].points_hold_days === 3);
    await admin(c => c.query('delete from merchants where id = any($1)', [[newG.rows[0].id, newC.rows[0].id, newX.rows[0].id]]));

    const badHold = async (v) => admin(async c => { try { await c.query('update merchants set points_hold_days=$1 where id=$2', [v, GROCER]); return 'ok'; } catch (e) { return 'fail:' + e.message; } });
    check('hold days: a negative value is rejected', (await badHold(-1)) !== 'ok');
    check('hold days: a value above 365 is rejected', (await badHold(400)) !== 'ok');

    // the migration re-run must never overwrite what an owner set since
    await admin(c => c.query('update merchants set points_hold_days = 3 where id=$1', [GROCER]));
    execSync(`su postgres -c "psql -q -v ON_ERROR_STOP=1 -d noj_test -f '${MIGRATION}'"`, { stdio: 'pipe' });
    check('migration is idempotent AND does not overwrite an owner-edited points_hold_days (3 stays 3)', holdOf(GROCER) !== undefined &&
      (await admin(c => c.query('select points_hold_days from merchants where id=$1', [GROCER]))).rows[0].points_hold_days === 3);
    await admin(c => c.query('update merchants set points_hold_days = 7 where id=$1', [GROCER]));

    const cols = await admin(c => c.query(`select column_name, column_default, is_nullable from information_schema.columns
      where table_schema='public' and table_name='point_transactions' and column_name in ('status','release_at')`));
    const colOf = (n) => cols.rows.find(r => r.column_name === n);
    check('point_transactions.status defaults to available (NOT NULL) and release_at is nullable',
      /available/.test(colOf('status').column_default) && colOf('status').is_nullable === 'NO' && colOf('release_at').is_nullable === 'YES');
    const legacy = await admin(c => c.query(`select count(*)::int as n from point_transactions where status <> 'available' or release_at is not null`));
    check('every point_transactions row that existed before this model reads available/release_at NULL (no backfill needed)', legacy.rows[0].n === 0);

    const SOME_USER = (await admin(c => c.query('select user_id from point_transactions limit 1'))).rows[0].user_id;
    const rawInsert = (status, release) => admin(async c => {
      try {
        await c.query(`insert into point_transactions (user_id, merchant_id, type, points_delta, source, status, release_at) values ($1,$2,'earn',1,'system',$3,$4)`,
          [SOME_USER, GROCER, status, release]);
        return 'ok';
      } catch (e) { return 'fail:' + e.message; }
    });
    check('point_transactions: a pending row WITHOUT release_at is rejected', (await rawInsert('pending', null)) !== 'ok');
    check('point_transactions: an unknown status is rejected', (await rawInsert('bogus', null)) !== 'ok');
    check('point_transactions: cancelled is an accepted status (used by refunds in the next PR)', (await rawInsert('cancelled', null)) === 'ok');
    await admin(c => c.query(`delete from point_transactions where status = 'cancelled' and source = 'system'`));

    // ---- fixtures: a paired kiosk at the grocer + registered/unregistered customers ----
    const ownerUid = crypto.randomUUID();
    await admin(c => c.query('insert into auth.users (id) values ($1)', [ownerUid]));
    await admin(c => c.query(`insert into merchant_members (merchant_id, auth_user_id, role) values ($1,$2,'owner')`, [GROCER, ownerUid]));
    const kUid = crypto.randomUUID();
    await admin(c => c.query('insert into auth.users (id) values ($1)', [kUid]));
    const kReq = await asUser(kUid, c => c.query('select * from request_device_pairing()'));
    await asUser(ownerUid, c => c.query('select * from approve_device_pairing($1,$2)', [kReq.rows[0].pairing_code, GROCER]));

    const makeCustomer = async (phone, verified) => {
      const u = crypto.randomUUID();
      await admin(c => c.query('insert into auth.users (id) values ($1)', [u]));
      const p = await admin(c => c.query(`insert into profiles (phone, auth_user_id, phone_verified_at) values ($1,$2,$3) returning id`, [phone, u, verified ? new Date() : null]));
      await admin(c => c.query(`insert into profile_consents (profile_id, consent_type, text_version, channel) values ($1,'data_processing','v1','kiosk')`, [p.rows[0].id]));
      return { uid: u, id: p.rows[0].id, phone };
    };
    const reg = await makeCustomer('544400001', true);
    const txn = async (ref, amount) => (await admin(c => c.query(
      `insert into pos_transactions (branch_id, amount, vat, external_ref) values ($1,$2,0,$3) returning id`, [GROCER, amount, ref]))).rows[0].id;
    const claim = async (id, phone) => (await asUser(kUid, c => c.query('select * from kiosk_claim_pos_transaction($1,$2)', [id, phone]))).rows[0];
    const avail = async (u) => (await admin(c => c.query('select coalesce((select points from merchant_loyalty where user_id=$1 and merchant_id=$2),-1) as p', [u, GROCER]))).rows[0].p;
    const lookup = async (phone) => Number((await asUser(kUid, c => c.query('select kiosk_lookup_customer_points($1) as p', [phone]))).rows[0].p);

    // ---- B) registered customer at a hold>0 merchant ----
    const c1 = await claim(await txn('PP-1', '100.00'), reg.phone);
    const pts1 = Math.round(100 * GRATE);
    check('hold>0 claim: the kiosk still gets added_points = round(amount × rate) (shows "+X نقطة")', c1.added_points === pts1 && c1.is_registered === true);
    check('hold>0 claim: merchant_loyalty.points (AVAILABLE) is NOT increased — row exists at 0', (await avail(reg.id)) === 0);
    const led1 = await admin(c => c.query(`select pt.*, (pt.release_at = i.created_at + interval '7 days') as on_invoice_date
      from point_transactions pt join invoices i on i.id = pt.invoice_id where pt.invoice_id = $1`, [c1.invoice_id]));
    check('hold>0 claim: exactly one ledger row, type earn, status pending, points_delta = full amount of points',
      led1.rows.length === 1 && led1.rows[0].type === 'earn' && led1.rows[0].status === 'pending' && led1.rows[0].points_delta === pts1);
    check('hold>0 claim: release_at = the INVOICE date + 7 days', led1.rows[0].on_invoice_date === true);
    check('hold>0 claim: invoices.points_earned records the full points while pending',
      (await admin(c => c.query('select points_earned from invoices where id=$1', [c1.invoice_id]))).rows[0].points_earned === pts1);
    check('kiosk_lookup_customer_points returns available + pending (the one honest number)', (await lookup(reg.phone)) === pts1);

    const c2 = await claim(await txn('PP-2', '40.00'), reg.phone);
    const pts2 = Math.round(40 * GRATE);
    check('second claim: prev_points already counts the first invoice\'s pending points', c2.prev_points === pts1 && c2.total_points === pts1 + pts2);
    check('lookup = both pending invoices, still 0 available', (await lookup(reg.phone)) === pts1 + pts2 && (await avail(reg.id)) === 0);

    // redeem_reward spends from AVAILABLE only: displayed balance covers it, available does not
    const rewardId = crypto.randomUUID();
    await admin(c => c.query(`insert into rewards (id, merchant_id, title, cost_points, active) values ($1,$2,'مكافأة معلّقة',$3,true)`, [rewardId, GROCER, pts1]));
    const redeemEarly = await asUser(reg.uid, async c => { try { await c.query('select redeem_reward($1)', [rewardId]); return 'ok'; } catch (e) { return 'fail:' + e.message; } });
    check('redeem_reward refuses while the points are only pending (spends available only), with its original message',
      redeemEarly !== 'ok' && /رصيد النقاط غير كافٍ/.test(redeemEarly));

    // ---- release_pending_points ----
    const releasedNone = await admin(c => c.query('select release_pending_points() as n'));
    check('release_pending_points: nothing is due yet → releases 0 and changes nothing', Number(releasedNone.rows[0].n) === 0 && (await avail(reg.id)) === 0);

    await admin(c => c.query(`update point_transactions set release_at = now() - interval '1 minute' where invoice_id = $1`, [c1.invoice_id]));
    const releasedOne = await admin(c => c.query('select release_pending_points() as n'));
    check('release_pending_points: only the due row is released (1), the not-yet-due one stays pending',
      Number(releasedOne.rows[0].n) === 1 && (await avail(reg.id)) === pts1 &&
      (await admin(c => c.query(`select status from point_transactions where invoice_id=$1`, [c2.invoice_id]))).rows[0].status === 'pending');
    check('lookup is unchanged by a release (no double counting): still pts1 + pts2', (await lookup(reg.phone)) === pts1 + pts2);

    const releasedAgain = await admin(c => c.query('select release_pending_points() as n'));
    check('release_pending_points is idempotent: a second run releases 0 and the balance does not move', Number(releasedAgain.rows[0].n) === 0 && (await avail(reg.id)) === pts1);

    const redeemOk = await asUser(reg.uid, async c => { try { await c.query('select redeem_reward($1)', [rewardId]); return 'ok'; } catch (e) { return 'fail:' + e.message; } });
    check('redeem_reward succeeds once the points are released and available', redeemOk === 'ok' && (await avail(reg.id)) === 0);

    const poorClient = await asUser(reg.uid, async c => { try { await c.query('select release_pending_points()'); return 'ok'; } catch (e) { return 'fail:' + e.message; } });
    const poorSvc = await asServiceRole(async c => { try { await c.query('select release_pending_points()'); return 'ok'; } catch (e) { return 'fail:' + e.message; } });
    const poorApply = await asUser(reg.uid, async c => { try { await c.query(`select apply_points_earn($1,$2,null,null,null,5,1,'pos',now())`, [reg.id, GROCER]); return 'ok'; } catch (e) { return 'fail:' + e.message; } });
    check('release_pending_points / apply_points_earn are unreachable by a client and by service_role (no grant at all)',
      /permission denied/.test(poorClient) && /permission denied/.test(poorSvc) && /permission denied/.test(poorApply));

    // ---- C) unregistered customer: the hold clock is the INVOICE date, not the claim date ----
    const UNREG = '544400002';
    const u1 = await claim(await txn('PP-U1', '100.00'), UNREG); // will be 30 days old → hold long over
    const u2 = await claim(await txn('PP-U2', '60.00'), UNREG);  // will be 3 days old → pending, 4 days left
    const um = await claim(await txn('PP-U3', '20.00'), UNREG);  // will be moved to a hold=0 merchant below
    check('unregistered claims return is_registered=false and store NO ledger rows yet',
      u1.is_registered === false && (await admin(c => c.query('select count(*)::int as n from point_transactions where invoice_id = any($1)', [[u1.invoice_id, u2.invoice_id, um.invoice_id]]))).rows[0].n === 0);
    await admin(c => c.query(`update invoices set created_at = now() - interval '30 days' where id=$1`, [u1.invoice_id]));
    await admin(c => c.query(`update invoices set created_at = now() - interval '3 days' where id=$1`, [u2.invoice_id]));
    await admin(c => c.query(`update invoices set merchant_id = $2 where id=$1`, [um.invoice_id, '20000000-0000-0000-0000-000000000001']));
    const late = await makeCustomer(UNREG, true);
    const claimedN = await asUser(late.uid, c => c.query('select claim_unclaimed_invoices() as n'));
    check('claim_unclaimed_invoices still transfers every pending invoice of the verified phone (3)', Number(claimedN.rows[0].n) === 3);
    const lr = await admin(c => c.query(`select pt.invoice_id, pt.status, pt.release_at, pt.points_delta, pt.merchant_id,
      (pt.release_at = i.created_at + interval '7 days') as on_invoice_date, (pt.release_at > now() + interval '3 days 23 hours' and pt.release_at < now() + interval '4 days 1 hour') as about_4_days
      from point_transactions pt join invoices i on i.id = pt.invoice_id where pt.user_id = $1`, [late.id]));
    const byInv = (id) => lr.rows.find(r => r.invoice_id === id);
    check('late registration, 30-day-old invoice: the hold is long over → available at once (release_at NULL)',
      byInv(u1.invoice_id).status === 'available' && byInv(u1.invoice_id).release_at === null);
    check('late registration, 3-day-old invoice: pending, release_at = INVOICE date + 7d (≈4 days away), NOT claim time + 7d',
      byInv(u2.invoice_id).status === 'pending' && byInv(u2.invoice_id).on_invoice_date === true && byInv(u2.invoice_id).about_4_days === true);
    check('late registration, invoice of a hold=0 merchant: available at once', byInv(um.invoice_id).status === 'available');
    const lateLoyalty = await admin(c => c.query('select merchant_id, points from merchant_loyalty where user_id=$1', [late.id]));
    const lp = (m) => (lateLoyalty.rows.find(r => r.merchant_id === m) || {}).points;
    check('late registration: AVAILABLE balance at the grocer = only the 30-day-old invoice\'s points; the pending one is not in it',
      lp(GROCER) === Math.round(100 * GRATE));
    check('late registration: the loyalty row for the hold=0 merchant gets its points at once', lp('20000000-0000-0000-0000-000000000001') === byInv(um.invoice_id).points_delta);
    check('late registration: unclaimed_customers anchor row removed, invoices moved to the real profile',
      (await admin(c => c.query('select 1 from unclaimed_customers where phone=$1', [UNREG]))).rows.length === 0 &&
      (await admin(c => c.query('select count(*)::int as n from invoices where user_id=$1 and pending_phone is null', [late.id]))).rows[0].n === 3);

    // ---- E) kiosk_earn_points (demo) goes through the same function ----
    await admin(c => c.query(`update branch_settings set demo_earn_enabled=true where branch_id=$1`, [GROCER]));
    const demo = (await asUser(kUid, c => c.query('select * from kiosk_earn_points($1,$2,$3)', [reg.phone, '50.00', null]))).rows[0];
    const demoLed = await admin(c => c.query('select status, source, release_at from point_transactions where invoice_id=$1', [demo.invoice_id]));
    check('kiosk_earn_points at a hold>0 merchant records a pending row (same shared function), available balance untouched',
      demoLed.rows[0].status === 'pending' && demoLed.rows[0].source === 'demo' && demoLed.rows[0].release_at !== null && (await avail(reg.id)) === 0);
    check('kiosk_earn_points: prev/total include pending (prev = the still-pending second invoice)', demo.prev_points === pts2 && demo.total_points === pts2 + Math.round(50 * GRATE));

    // ---- F) hold=0 merchant: bit-for-bit the old behavior ----
    const zeroHold = await admin(c => c.query(`select points_hold_days from merchants where id='20000000-0000-0000-0000-000000000001'`));
    check('hold=0 merchant (مطعم مذاق) really is 0 — its claims stay immediate (covered by sections 13/16 unchanged)', zeroHold.rows[0].points_hold_days === 0);
    const pendingAtZero = await admin(c => c.query(`select count(*)::int as n from point_transactions where status='pending' and merchant_id='20000000-0000-0000-0000-000000000001'`));
    check('no pending row exists anywhere for a hold=0 merchant', pendingAtZero.rows[0].n === 0);
  }

  // =========================================================================
  // 21c) POS REFUNDS (supabase-migration-pos-refunds.sql, PR2):
  //      intake_pos_refund(), refund_adjustment ledger type, pos_refunds,
  //      claim_unclaimed_invoices() with refunded invoices.
  // =========================================================================
  {
    const GROCER = '20000000-0000-0000-0000-000000000002';
    for (const f of ['supabase-migration-pending-points.sql', 'supabase-migration-pos-refunds.sql', 'supabase-migration-pos-refunds.sql']) {
      // earlier sections re-ran older migrations (idempotency tests) → re-apply to test the real final state;
      // the refunds file is applied twice on purpose: it must be idempotent
      execSync(`su postgres -c "psql -q -v ON_ERROR_STOP=1 -d noj_test -f '${path.join(REPO_ROOT, f)}'"`, { stdio: 'pipe' });
    }
    const GRATE = Number((await admin(c => c.query('select points_rate from merchants where id=$1', [GROCER]))).rows[0].points_rate);
    await admin(c => c.query('update merchants set points_hold_days = 7 where id=$1', [GROCER]));

    // ---- fixtures ----
    const ownerUid = crypto.randomUUID();
    await admin(c => c.query('insert into auth.users (id) values ($1)', [ownerUid]));
    await admin(c => c.query(`insert into merchant_members (merchant_id, auth_user_id, role) values ($1,$2,'owner')`, [GROCER, ownerUid]));
    const kUid = crypto.randomUUID();
    await admin(c => c.query('insert into auth.users (id) values ($1)', [kUid]));
    const kReq = await asUser(kUid, c => c.query('select * from request_device_pairing()'));
    await asUser(ownerUid, c => c.query('select * from approve_device_pairing($1,$2)', [kReq.rows[0].pairing_code, GROCER]));

    let phoneSeq = 0;
    const nextPhone = () => '5445' + String(++phoneSeq).padStart(5, '0');
    const makeCustomer = async (phone, verified = true) => {
      const u = crypto.randomUUID();
      await admin(c => c.query('insert into auth.users (id) values ($1)', [u]));
      const p = await admin(c => c.query(`insert into profiles (phone, auth_user_id, phone_verified_at) values ($1,$2,$3) returning id`, [phone, u, verified ? new Date() : null]));
      await admin(c => c.query(`insert into profile_consents (profile_id, consent_type, text_version, channel) values ($1,'data_processing','v1','kiosk')`, [p.rows[0].id]));
      return { uid: u, id: p.rows[0].id, phone };
    };
    let refSeq = 0;
    const newInvoice = async (phone, amount) => {
      const ref = 'RF-INV-' + (++refSeq);
      const t = await admin(c => c.query(`insert into pos_transactions (branch_id, amount, vat, external_ref) values ($1,$2,0,$3) returning id`, [GROCER, amount, ref]));
      const cl = (await asUser(kUid, c => c.query('select * from kiosk_claim_pos_transaction($1,$2)', [t.rows[0].id, phone]))).rows[0];
      return { ref, txnId: t.rows[0].id, invoiceId: cl.invoice_id, points: cl.added_points };
    };
    let rfSeq = 0;
    const refund = async (ref, amount, refundRef) => asServiceRole(async c => {
      try { const r = await c.query('select intake_pos_refund($1,$2,$3,$4,$5,$6) as r', [GROCER, ref, refundRef === undefined ? 'RFND-' + (++rfSeq) : refundRef, amount, 'generic', null]); return { ok: true, r: r.rows[0].r }; }
      catch (e) { return { ok: false, msg: e.message }; }
    });
    const avail = async (u) => (await admin(c => c.query('select coalesce((select points from merchant_loyalty where user_id=$1 and merchant_id=$2),-1) as p', [u, GROCER]))).rows[0].p;
    const inv = async (id) => (await admin(c => c.query('select status, refunded_amount, points_earned, user_id from invoices where id=$1', [id]))).rows[0];
    const ledger = async (invoiceId) => (await admin(c => c.query('select * from point_transactions where invoice_id=$1 order by created_at, type desc', [invoiceId]))).rows;
    const releaseNow = async (invoiceId) => {
      await admin(c => c.query(`update point_transactions set release_at = now() - interval '1 minute' where invoice_id=$1 and status='pending'`, [invoiceId]));
      await admin(c => c.query('select release_pending_points()'));
    };
    const lookup = async (kPhone) => Number((await asUser(kUid, c => c.query('select kiosk_lookup_customer_points($1) as p', [kPhone]))).rows[0].p);

    // ---- schema / constraints ----
    const refundRowInsert = (delta, intended) => admin(async c => {
      const cust = (await c.query('select id from profiles limit 1')).rows[0].id;
      try {
        await c.query(`insert into point_transactions (user_id, merchant_id, type, points_delta, intended_delta, source) values ($1,$2,'refund_adjustment',$3,$4,'pos')`, [cust, GROCER, delta, intended]);
        return 'ok';
      } catch (e) { return 'fail:' + e.message; }
    });
    check('ledger: refund_adjustment with a POSITIVE points_delta is rejected', (await refundRowInsert(5, 5)) !== 'ok');
    check('ledger: refund_adjustment WITHOUT intended_delta is rejected', (await refundRowInsert(-5, null)) !== 'ok');
    check('ledger: refund_adjustment whose applied deduction exceeds the intended one is rejected', (await refundRowInsert(-5, -3)) !== 'ok');
    check('ledger: a valid refund_adjustment (applied -3 of intended -5) is accepted', (await refundRowInsert(-3, -5)) === 'ok');
    await admin(c => c.query(`delete from point_transactions where type='refund_adjustment' and source='pos' and invoice_id is null`));
    const oldTypes = await admin(async c => {
      try { await c.query(`insert into point_transactions (user_id, merchant_id, type, points_delta, source) select id, $1, 'earn', -4, 'system' from profiles limit 1`, [GROCER]); return 'ok'; }
      catch (e) { return 'fail:' + e.message; }
    });
    check('ledger: the original rule is intact — a NEGATIVE earn is still rejected', oldTypes !== 'ok');

    // ---- A) refund INSIDE the hold period: pending row edited / cancelled, balance never touched ----
    const a = await makeCustomer(nextPhone());
    const a1 = await newInvoice(a.phone, '100.00');
    const rA1 = await refund(a1.ref, '100.00');
    const lA1 = (await ledger(a1.invoiceId))[0];
    check('hold refund (full): outcome pending_points_cancelled, ledger row cancelled, AVAILABLE balance untouched (0)',
      rA1.ok && rA1.r.outcome === 'pending_points_cancelled' && lA1.status === 'cancelled' && (await avail(a.id)) === 0);
    check('hold refund (full): points_cancelled equals the invoice\'s points; displayed balance (available+pending) is back to 0',
      rA1.r.points_cancelled === a1.points && (await lookup(a.phone)) === 0);
    const iA1 = await inv(a1.invoiceId);
    check('hold refund (full): invoice status refunded, refunded_amount = 100.00', iA1.status === 'refunded' && Number(iA1.refunded_amount) === 100);
    check('hold refund: NO refund_adjustment row exists — nothing was ever credited, so nothing is taken back',
      (await ledger(a1.invoiceId)).every(r => r.type === 'earn'));

    const a2 = await newInvoice(a.phone, '200.00');
    const r1 = await refund(a2.ref, '50.00'), r2 = await refund(a2.ref, '50.00');
    const rowAfter2 = (await ledger(a2.invoiceId))[0];
    check('hold refund (partial ×2): row stays pending with points_delta = round(points × remaining share)',
      r1.r.outcome === 'pending_points_reduced' && rowAfter2.status === 'pending' && rowAfter2.points_delta === Math.round(a2.points * 100 / 200));
    const iA2 = await inv(a2.invoiceId);
    check('hold refund (partial): invoice stays paid with refunded_amount = 100.00 (partial ≠ refunded)', iA2.status === 'paid' && Number(iA2.refunded_amount) === 100);
    const r3 = await refund(a2.ref, '100.00');
    check('hold refund (partial ×2 then the rest): cancelled, and the TOTAL cancelled over the three events == the invoice\'s points exactly',
      r3.r.outcome === 'pending_points_cancelled' && r1.r.points_cancelled + r2.r.points_cancelled + r3.r.points_cancelled === a2.points);

    // ---- B) refund AFTER the hold: deduct, never below zero, record the shortfall ----
    const b = await makeCustomer(nextPhone());
    const b1 = await newInvoice(b.phone, '100.00');
    await releaseNow(b1.invoiceId);
    check('setup: points released to available', (await avail(b.id)) === b1.points);
    const rB1 = await refund(b1.ref, '40.00');
    const intendedB1 = b1.points - Math.round(b1.points * 60 / 100);
    const adj = (await ledger(b1.invoiceId)).find(r => r.type === 'refund_adjustment');
    check('post-hold partial refund: a NEW immutable refund_adjustment row, points_delta = -(proportional share), nothing unrecovered',
      rB1.r.outcome === 'points_deducted' && adj && adj.points_delta === -intendedB1 && adj.intended_delta === -intendedB1 && rB1.r.points_unrecovered === 0);
    check('post-hold partial refund: merchant_loyalty.points reduced by exactly that share; the original earn row is untouched',
      (await avail(b.id)) === b1.points - intendedB1 && (await ledger(b1.invoiceId)).find(r => r.type === 'earn').points_delta === b1.points &&
      (await ledger(b1.invoiceId)).find(r => r.type === 'earn').status === 'available');
    check('post-hold refund row carries the rate snapshot of the original earn and the pos source', adj.source === 'pos' && Number(adj.points_rate_applied) === GRATE && adj.external_ref !== null);

    // customer spends points BEFORE the refund arrives → clamp at zero, remember the difference
    const c = await makeCustomer(nextPhone());
    const c1 = await newInvoice(c.phone, '100.00');
    await releaseNow(c1.invoiceId);
    const leave = Math.min(10, c1.points);
    const rewardId = crypto.randomUUID();
    await admin(c => c.query(`insert into rewards (id, merchant_id, title, cost_points, active) values ($1,$2,'مكافأة قبل الإرجاع',$3,true)`, [rewardId, GROCER, c1.points - leave]));
    if (c1.points - leave > 0) await asUser(c.uid, cl => cl.query('select redeem_reward($1)', [rewardId]));
    const availBefore = await avail(c.id);
    const rC1 = await refund(c1.ref, '100.00');
    const adjC = (await ledger(c1.invoiceId)).find(r => r.type === 'refund_adjustment');
    check('spent-before-refund: balance is clamped at ZERO, never negative', (await avail(c.id)) === 0 && availBefore === leave);
    check('spent-before-refund: applied = what was left; intended = the full share; the difference is recorded in the SAME row',
      adjC.points_delta === -leave && adjC.intended_delta === -c1.points && rC1.r.points_deducted === leave && rC1.r.points_unrecovered === c1.points - leave);
    const unrec = await admin(c => c.query(`select coalesce(sum(intended_delta - points_delta),0)::int as n from point_transactions where type='refund_adjustment' and invoice_id=$1`, [c1.invoiceId]));
    check('unrecovered points are readable from point_transactions alone (sum(intended_delta - points_delta))', unrec.rows[0].n === -(c1.points - leave));

    // a hold=0 merchant: same deduction rules, no pending step
    await admin(c => c.query('update merchants set points_hold_days = 0 where id=$1', [GROCER]));
    const d = await makeCustomer(nextPhone());
    const d1 = await newInvoice(d.phone, '60.00');
    check('hold=0: the earn is available at once (PR1 behaviour intact)', (await avail(d.id)) === d1.points && (await ledger(d1.invoiceId))[0].status === 'available');
    const rD1 = await refund(d1.ref, '60.00');
    check('hold=0 full refund: points deducted straight from available down to 0 via refund_adjustment', rD1.r.outcome === 'points_deducted' && (await avail(d.id)) === 0 && rD1.r.points_unrecovered === 0);
    await admin(c => c.query('update merchants set points_hold_days = 7 where id=$1', [GROCER]));

    // ---- C) unregistered customer ----
    const UF = nextPhone(), UP = nextPhone();
    const uFull = await newInvoice(UF, '100.00');
    const uPart = await newInvoice(UP, '100.00');
    const rUF = await refund(uFull.ref, '100.00');
    const rUP = await refund(uPart.ref, '40.00');
    check('unregistered refund: outcome unclaimed_marked, invoice marked, no points moved (none existed)',
      rUF.r.outcome === 'unclaimed_marked' && (await inv(uFull.invoiceId)).status === 'refunded' && rUF.r.points_cancelled === 0 && rUF.r.points_deducted === 0);
    const lateF = await makeCustomer(UF), lateP = await makeCustomer(UP);
    const nF = await asUser(lateF.uid, c => c.query('select claim_unclaimed_invoices() as n'));
    const nP = await asUser(lateP.uid, c => c.query('select claim_unclaimed_invoices() as n'));
    check('claim_unclaimed_invoices still moves the fully-refunded invoice (history kept) …', Number(nF.rows[0].n) === 1 && (await inv(uFull.invoiceId)).user_id === lateF.id);
    check('… but it earns NO points (no ledger row, available 0, displayed 0)',
      (await ledger(uFull.invoiceId)).length === 0 && (await avail(lateF.id)) <= 0 && (await lookup(lateF.phone)) === 0);
    const pRow = (await ledger(uPart.invoiceId))[0];
    check('a PARTIALLY refunded unclaimed invoice earns proportionally fewer points on registration (60% of them), still on the invoice-date hold',
      Number(nP.rows[0].n) === 1 && pRow && pRow.points_delta === Math.round(uPart.points * 60 / 100) && pRow.status === 'pending');

    // ---- D) idempotency / limits / not found ----
    const e = await makeCustomer(nextPhone());
    const e1 = await newInvoice(e.phone, '100.00');
    const first = await refund(e1.ref, '30.00', 'RFND-IDEM');
    const stateBefore = JSON.stringify([await avail(e.id), (await inv(e1.invoiceId)), await ledger(e1.invoiceId)]);
    const replay = await refund(e1.ref, '30.00', 'RFND-IDEM');
    const replayDifferent = await refund(e1.ref, '99.00', 'RFND-IDEM');
    check('replay: the same refund_ref returns the stored result with replayed=true',
      first.r.replayed === false && replay.ok && replay.r.replayed === true && replay.r.outcome === first.r.outcome && replay.r.refunded_total === first.r.refunded_total);
    check('replay: even with a different amount nothing is applied twice (invoice, balance and ledger unchanged), one pos_refunds row',
      replayDifferent.ok && replayDifferent.r.replayed === true &&
      JSON.stringify([await avail(e.id), (await inv(e1.invoiceId)), await ledger(e1.invoiceId)]) === stateBefore &&
      (await admin(c => c.query(`select count(*)::int as n from pos_refunds where refund_ref='RFND-IDEM'`))).rows[0].n === 1);
    const over = await refund(e1.ref, '80.00');
    check('over-refund (30 + 80 > 100) is rejected with NOJ_REFUND_EXCEEDS_AMOUNT and changes nothing',
      !over.ok && /NOJ_REFUND_EXCEEDS_AMOUNT/.test(over.msg) && Number((await inv(e1.invoiceId)).refunded_amount) === 30);
    const exact = await refund(e1.ref, '70.00');
    const again = await refund(e1.ref, '0.01');
    check('refunding exactly the rest succeeds (invoice → refunded); one more cent is rejected',
      exact.ok && exact.r.invoice_status === 'refunded' && !again.ok && /NOJ_REFUND_EXCEEDS_AMOUNT/.test(again.msg));
    const zero = await refund(e1.ref, '0'), neg = await refund(e1.ref, '-5'), noRef = await refund(e1.ref, '5', '');
    check('zero / negative amount and an empty refund_ref are rejected (NOJ_INVALID_REFUND)', [zero, neg, noRef].every(x => !x.ok && /NOJ_INVALID_REFUND/.test(x.msg)));
    const nf = await refund('NO-SUCH-INVOICE', '5.00');
    const otherBranch = await asServiceRole(async c => {
      try { await c.query('select intake_pos_refund($1,$2,$3,$4,$5,$6)', ['20000000-0000-0000-0000-000000000001', e1.ref, 'RFND-X', '5', 'generic', null]); return 'ok'; }
      catch (er) { return 'fail:' + er.message; }
    });
    check('unknown original → NOJ_REFUND_ORIGINAL_NOT_FOUND; the same ref under ANOTHER branch is also not found (branch-scoped)',
      !nf.ok && /NOJ_REFUND_ORIGINAL_NOT_FOUND/.test(nf.msg) && /NOJ_REFUND_ORIGINAL_NOT_FOUND/.test(otherBranch));

    // legacy invoice: status refunded, refunded_amount NULL (the value existed before the column) = fully refunded
    const l = await makeCustomer(nextPhone());
    const l1 = await newInvoice(l.phone, '50.00');
    await admin(c => c.query(`update invoices set status='refunded', refunded_amount=null where id=$1`, [l1.invoiceId]));
    const legacy = await refund(l1.ref, '1.00');
    check('legacy "refunded" invoice with NULL refunded_amount counts as fully refunded: any further refund is rejected', !legacy.ok && /NOJ_REFUND_EXCEEDS_AMOUNT/.test(legacy.msg));

    // ---- E) refund BEFORE the customer ever claimed ----
    const mkTxn = async (ref, amount, status) => (await admin(c => c.query(`insert into pos_transactions (branch_id, amount, vat, external_ref, status) values ($1,$2,0,$3,$4) returning id`, [GROCER, amount, ref, status]))).rows[0].id;
    const t1 = await mkTxn('RF-UNCLAIMED-1', '80.00', 'pending');
    const partialEarly = await refund('RF-UNCLAIMED-1', '20.00');
    check('partial refund of a still-claimable transaction is rejected (NOJ_REFUND_NOT_APPLICABLE) and the transaction stays pending',
      !partialEarly.ok && /NOJ_REFUND_NOT_APPLICABLE/.test(partialEarly.msg) &&
      (await admin(c => c.query('select status from pos_transactions where id=$1', [t1]))).rows[0].status === 'pending');
    const fullEarly = await refund('RF-UNCLAIMED-1', '80.00');
    const claimAfter = await asUser(kUid, async cl => { try { await cl.query('select * from kiosk_claim_pos_transaction($1,$2)', [t1, nextPhone()]); return 'ok'; } catch (er) { return 'fail:' + er.message; } });
    check('full refund before the claim cancels the transaction: it can no longer be claimed (NOJ_TRANSACTION_NOT_PENDING)',
      fullEarly.ok && fullEarly.r.outcome === 'cancelled_before_claim' && /NOJ_TRANSACTION_NOT_PENDING/.test(claimAfter));
    const t2 = await mkTxn('RF-EXPIRED-1', '30.00', 'expired');
    const expiredRefund = await refund('RF-EXPIRED-1', '30.00');
    check('refund of an already-expired, never-claimed transaction: recorded (outcome no_invoice), nothing to reverse', expiredRefund.ok && expiredRefund.r.outcome === 'no_invoice');

    // ---- F) concurrency ----
    const g = await makeCustomer(nextPhone());
    const g1 = await newInvoice(g.phone, '100.00');
    const race = await Promise.all([refund(g1.ref, '60.00', 'RACE-A'), refund(g1.ref, '60.00', 'RACE-B')]);
    check('two concurrent refunds of 60 on a 100 invoice: exactly one wins, the other is rejected, total never exceeds the invoice',
      race.filter(x => x.ok).length === 1 && race.filter(x => !x.ok && /NOJ_REFUND_EXCEEDS_AMOUNT/.test(x.msg)).length === 1 &&
      Number((await inv(g1.invoiceId)).refunded_amount) === 60);
    const h = await makeCustomer(nextPhone());
    const h1 = await newInvoice(h.phone, '100.00');
    const same = await Promise.all([refund(h1.ref, '40.00', 'RACE-SAME'), refund(h1.ref, '40.00', 'RACE-SAME')]);
    check('two concurrent copies of the SAME refund_ref: applied once, the other is a replay',
      same.every(x => x.ok) && same.filter(x => x.r.replayed).length === 1 && Number((await inv(h1.invoiceId)).refunded_amount) === 40);

    // ---- G) access / reporting / regression ----
    const clientCall = await asUser(a.uid, async cl => { try { await cl.query(`select intake_pos_refund($1,'x','y',1,'generic',null)`, [GROCER]); return 'ok'; } catch (er) { return 'fail:' + er.message; } });
    const clientTable = await asUser(a.uid, async cl => { try { await cl.query('select * from pos_refunds'); return 'ok'; } catch (er) { return 'fail:' + er.message; } });
    const clientInsert = await asUser(a.uid, async cl => { try { await cl.query(`insert into pos_refunds (branch_id, external_ref, refund_ref, refund_amount, outcome, result) values ($1,'x','y',1,'x','{}')`, [GROCER]); return 'ok'; } catch (er) { return 'fail:' + er.message; } });
    check('intake_pos_refund and pos_refunds are unreachable by a client role (no execute, no select, no insert)',
      /permission denied/.test(clientCall) && /permission denied/.test(clientTable) && /permission denied/.test(clientInsert));

    const rep = await asUser(ownerUid, c => c.query(`select merchant_list_invoices($1, '2020-01-01', (now() at time zone 'Asia/Riyadh')::date + 1, null, false, 100, 0) as r`, [GROCER]));
    const expectedRefunded = await admin(c => c.query(`select coalesce(sum(case when status='refunded' and refunded_amount is null then amount else coalesce(refunded_amount,0) end),0)::numeric as n
      from invoices where merchant_id=$1 and source <> 'demo'`, [GROCER]));
    check('merchant_list_invoices: the "refunded" summary reflects the refunds recorded here (full and partial)',
      Number(rep.rows[0].r.summary.refunded) === Number(expectedRefunded.rows[0].n) && Number(expectedRefunded.rows[0].n) > 0);

    check('redeem_reward is untouched by this file (still defined only by the ledger migration, same body)',
      (await admin(c => c.query(`select count(*)::int as n from pg_proc where proname='redeem_reward'`))).rows[0].n === 1);
    check('every pending ledger row still has a release_at (PR1 invariant)',
      (await admin(c => c.query(`select count(*)::int as n from point_transactions where status='pending' and release_at is null`))).rows[0].n === 0);
    check('no merchant_loyalty balance is negative anywhere after all the refunds',
      (await admin(c => c.query(`select count(*)::int as n from merchant_loyalty where points < 0`))).rows[0].n === 0);
  }

  // =========================================================================
  // 21d) PARTIAL / FULL REFUND OF AN UNREGISTERED CUSTOMER'S INVOICE, THEN THEY
  //      REGISTER (claim_unclaimed_invoices) — the exact live scenario: amount
  //      115 (vat 15), refund 50. Points must be reduced by the refunded share,
  //      and the total removed must equal the invoice's points EXACTLY.
  // =========================================================================
  {
    const GROCER = '20000000-0000-0000-0000-000000000002';
    const applyAll = (order) => {
      for (const f of order) execSync(`su postgres -c "psql -q -v ON_ERROR_STOP=1 -d noj_test -f '${path.join(REPO_ROOT, f)}'"`, { stdio: 'pipe' });
    };
    // earlier sections re-ran older files; bring the DB to the real final state first
    applyAll(['supabase-migration-pending-points.sql', 'supabase-migration-pos-refunds.sql']);
    const origRate = (await admin(c => c.query('select points_rate from merchants where id=$1', [GROCER]))).rows[0].points_rate;

    const ownerUid = crypto.randomUUID();
    await admin(c => c.query('insert into auth.users (id) values ($1)', [ownerUid]));
    await admin(c => c.query(`insert into merchant_members (merchant_id, auth_user_id, role) values ($1,$2,'owner')`, [GROCER, ownerUid]));
    const kUid = crypto.randomUUID();
    await admin(c => c.query('insert into auth.users (id) values ($1)', [kUid]));
    const kReq = await asUser(kUid, c => c.query('select * from request_device_pairing()'));
    await asUser(ownerUid, c => c.query('select * from approve_device_pairing($1,$2)', [kReq.rows[0].pairing_code, GROCER]));

    let seq = 0;
    const phone = () => '5446' + String(++seq).padStart(5, '0');
    const newUnregInvoice = async (ph, amount, vat) => {
      const ref = 'CL-' + (++seq);
      const t = await admin(c => c.query(`insert into pos_transactions (branch_id, amount, vat, external_ref) values ($1,$2,$3,$4) returning id`, [GROCER, amount, vat, ref]));
      const cl = (await asUser(kUid, c => c.query('select * from kiosk_claim_pos_transaction($1,$2)', [t.rows[0].id, ph]))).rows[0];
      return { ref, invoiceId: cl.invoice_id, points: cl.added_points };
    };
    const refund = (ref, amt) => asServiceRole(async c => {
      const r = await c.query('select intake_pos_refund($1,$2,$3,$4,$5,$6) as r', [GROCER, ref, 'CLR-' + (++seq), amt, 'generic', null]);
      return r.rows[0].r;
    });
    const register = async (ph) => {
      const u = crypto.randomUUID();
      await admin(c => c.query('insert into auth.users (id) values ($1)', [u]));
      const p = await admin(c => c.query(`insert into profiles (phone, auth_user_id, phone_verified_at) values ($1,$2,now()) returning id`, [ph, u]));
      await admin(c => c.query(`insert into profile_consents (profile_id, consent_type, text_version, channel) values ($1,'data_processing','v1','kiosk')`, [p.rows[0].id]));
      await asUser(u, c => c.query('select claim_unclaimed_invoices()'));
      return { uid: u, id: p.rows[0].id };
    };
    const earnRows = async (invoiceId) => (await admin(c => c.query(`select * from point_transactions where invoice_id=$1 order by created_at`, [invoiceId]))).rows;

    // ---- the live scenario, rate 1.0: 115 points earned, refund 50, register → 65 ----
    await admin(c => c.query('update merchants set points_rate = 1.0 where id=$1', [GROCER]));
    const p1 = phone();
    const i1 = await newUnregInvoice(p1, '115.00', '15.00');
    const r1 = await refund(i1.ref, '50.00');
    const inv1 = (await admin(c => c.query('select points_earned, refunded_amount from invoices where id=$1', [i1.invoiceId]))).rows[0];
    check('live scenario: 115 (vat 15) unregistered, refund 50 → unclaimed_marked, refunded_amount 50, points_earned still 115 (the original record is immutable)',
      i1.points === 115 && r1.outcome === 'unclaimed_marked' && Number(inv1.refunded_amount) === 50 && inv1.points_earned === 115);
    const reg1 = await register(p1);
    const rows1 = await earnRows(i1.invoiceId);
    check('live scenario: on registration the customer gets 65 points (not 115) — one earn row of 65, pending on the invoice-date hold',
      rows1.length === 1 && rows1[0].points_delta === 65 && rows1[0].status === 'pending');
    check('live scenario: displayed balance = 65, AVAILABLE = 0 until the hold ends',
      (await admin(c => c.query(`select coalesce((select points from merchant_loyalty where user_id=$1 and merchant_id=$2),0) + coalesce((select sum(points_delta) from point_transactions where user_id=$1 and merchant_id=$2 and status='pending'),0) as n`, [reg1.id, GROCER]))).rows[0].n == 65);

    // ---- full refund of an unregistered invoice → zero points ----
    const p2 = phone();
    const i2 = await newUnregInvoice(p2, '115.00', '15.00');
    await refund(i2.ref, '115.00');
    const reg2 = await register(p2);
    check('full refund of an unregistered invoice, then registration → ZERO points (no ledger row), invoice moved and shown refunded',
      (await earnRows(i2.invoiceId)).length === 0 &&
      (await admin(c => c.query('select user_id, status from invoices where id=$1', [i2.invoiceId]))).rows[0].status === 'refunded' &&
      (await admin(c => c.query('select user_id from invoices where id=$1', [i2.invoiceId]))).rows[0].user_id === reg2.id);

    // ---- exactness with a rate that makes the shares non-integers (0.37 → 43 points on 115) ----
    await admin(c => c.query('update merchants set points_rate = 0.37 where id=$1', [GROCER]));
    const p3 = phone();
    const i3 = await newUnregInvoice(p3, '115.00', '15.00');
    check('setup: rate 0.37 on 115 earns 43 points', i3.points === 43);
    await refund(i3.ref, '50.00');                       // before registration
    const reg3 = await register(p3);                     // gets round(43 × 65/115) = 24
    const claimedPts = (await earnRows(i3.invoiceId))[0].points_delta;
    const removedBeforeClaim = i3.points - claimedPts;   // the part never awarded
    const s2 = await refund(i3.ref, '30.00');            // after registration: pending row reduced
    const s3 = await refund(i3.ref, '35.00');            // the rest → cancelled
    const finalRow = (await earnRows(i3.invoiceId))[0];
    check('exact division: awarded at registration = round(43 × 65/115) = 24', claimedPts === 24);
    check('exact division: never-awarded (19) + cancelled after registration (11 + 13) == the invoice\'s 43 points EXACTLY',
      removedBeforeClaim + s2.points_cancelled + s3.points_cancelled === i3.points && removedBeforeClaim === 19 && s2.points_cancelled === 11 && s3.points_cancelled === 13);
    check('exact division: the ledger row ends cancelled; nothing was taken from the available balance (pending path only)',
      finalRow.status === 'cancelled' && (await admin(c => c.query('select coalesce(points,0) as p from merchant_loyalty where user_id=$1 and merchant_id=$2', [reg3.id, GROCER]))).rows[0].p === 0);

    // ---- the claim function must stay refund-aware whatever order the migration files are re-applied in ----
    const defOf = async () => (await admin(c => c.query(`select prosrc from pg_proc where proname='claim_unclaimed_invoices'`))).rows[0].prosrc;
    applyAll(['supabase-migration-pos-refunds.sql', 'supabase-migration-pending-points.sql']);
    const defPendingLast = await defOf();
    applyAll(['supabase-migration-pending-points.sql', 'supabase-migration-pos-refunds.sql']);
    const defRefundsLast = await defOf();
    check('claim_unclaimed_invoices has the IDENTICAL, refund-aware body whichever of the two files is applied last',
      defPendingLast === defRefundsLast && /v_refunded/.test(defPendingLast));
    applyAll(['supabase-migration-pos-refunds.sql', 'supabase-migration-pending-points.sql']);
    const p4 = phone();
    const i4 = await newUnregInvoice(p4, '115.00', '15.00');
    await refund(i4.ref, '50.00');
    await register(p4);
    check('after re-applying pending-points.sql LAST, a partially refunded unregistered invoice still earns the reduced points (not the full ones)',
      (await earnRows(i4.invoiceId))[0].points_delta === Math.round(43 * 65 / 115));

    await admin(c => c.query('update merchants set points_rate = $2 where id=$1', [GROCER, origRate]));
  }

  // =========================================================================
  // 21e) ONE SECTOR PER MERCHANT (supabase-migration-unified-sectors.sql):
  //      merchants.sector_code is the source; merchants.type and
  //      branch_settings.sector_code are derived and can never diverge.
  // =========================================================================
  {
    const SECTORS = ['grocery', 'retail', 'cafe', 'restaurant', 'medical', 'services'];
    const MIG = path.join(REPO_ROOT, 'supabase-migration-unified-sectors.sql');
    const apply = (f) => execSync(`su postgres -c "psql -q -v ON_ERROR_STOP=1 -d noj_test -f '${path.join(REPO_ROOT, f)}'"`, { stdio: 'pipe' });
    const tryQ = (sql, params) => admin(async c => { try { const r = await c.query(sql, params); return { ok: true, r }; } catch (e) { return { ok: false, msg: e.message }; } });
    const merchantRow = async (id) => (await admin(c => c.query('select id, type, sector_code, points_hold_days from merchants where id=$1', [id]))).rows[0];
    const branchSectors = async (merchantId) => (await admin(c => c.query(
      `select bs.sector_code from branch_settings bs join branches b on b.id = bs.branch_id where b.merchant_id=$1 order by b.created_at, b.id`, [merchantId]))).rows.map(r => r.sector_code);
    const divergent = async () => (await admin(c => c.query(
      `select count(*)::int as n from branch_settings bs join branches b on b.id=bs.branch_id join merchants m on m.id=b.merchant_id
       where bs.sector_code <> m.sector_code or m.type <> public.sector_label(m.sector_code)`))).rows[0].n;

    // ---- A) the data migration, measured against the snapshot taken just before it ran ----
    const pre = preSectorSnapshot;
    const preType = (id) => (pre.merchants.find(m => m.id === id) || {}).type;
    const seeded = {
      '20000000-0000-0000-0000-000000000001': ['restaurant', 'مطاعم'],
      '20000000-0000-0000-0000-000000000002': ['grocery', 'بقالة'],
      '20000000-0000-0000-0000-000000000003': ['cafe', 'مقاهي'],
      '20000000-0000-0000-0000-00000000000d': ['medical', 'صحة'],
      '20000000-0000-0000-0000-00000000000c': ['services', 'خدمات'],
    };
    let mapOk = true;
    for (const [id, [code, label]] of Object.entries(seeded)) {
      const m = await merchantRow(id);
      if (!m || m.sector_code !== code || m.type !== label) mapOk = false;
    }
    check('migration: صحة→medical, مقاهي→cafe, مطاعم→restaurant, بقالة→grocery, أخرى→services', mapOk);
    check('migration: the services merchant was "أخرى" before it', preType('20000000-0000-0000-0000-00000000000c') === 'أخرى');
    const post = postSectorSnapshot;
    check('NO retroactive effect: every invoice is byte-identical across the migration (amount, vat, category — "أخرى" included — points, status, refunds)',
      JSON.stringify(post.invoices) === JSON.stringify(pre.invoices) && pre.invoices.length > 0);
    check('NO retroactive effect: every ledger row and every loyalty balance is byte-identical across the migration',
      JSON.stringify(post.ledger) === JSON.stringify(pre.ledger) && JSON.stringify(post.loyalty) === JSON.stringify(pre.loyalty) && pre.loyalty.length > 0);
    check('the old "أخرى" invoice keeps its category (index.html keeps that key as a legacy alias)',
      post.invoices.some(r => r.id === '40000013-0000-0000-0000-000000000013' && r.category === 'أخرى'));
    check('NO retroactive effect: every merchant kept its points_hold_days and points_rate; only the label "أخرى" changed (→ خدمات)',
      pre.merchants.length === post.merchants.length && pre.merchants.every((p, i) => {
        const n = post.merchants[i];
        return n.id === p.id && n.points_hold_days === p.points_hold_days && n.points_rate === p.points_rate &&
          (p.type === 'أخرى' ? n.type === 'خدمات' : n.type === p.type);
      }));
    check('migration: before it some branches disagreed with their merchant (default "cafe"); after it none do',
      pre.branchSectors.length > 0 && (await divergent()) === 0);

    // ---- B) derivation on every write path ----
    const ins = async (cols, vals) => (await admin(c => c.query(
      `insert into merchants (name, logo_color${cols ? ', ' + cols : ''}) values ('تجربة قسم', '#000000'${vals ? ', ' + vals : ''}) returning id, type, sector_code, points_hold_days`))).rows[0];
    const r1 = await ins("type", "'تجزئة'");
    const r2 = await ins("type", "'مقهى'");
    const r3 = await ins("sector_code", "'services'");
    const r4 = await ins("type", "'مواصلات'");
    const r5 = await ins("sector_code, type", "'medical', 'مطاعم'");
    check('insert with a type label: تجزئة → retail (label kept), hold 7 by default', r1.sector_code === 'retail' && r1.type === 'تجزئة' && r1.points_hold_days === 7);
    check('insert with a singular label: مقهى → cafe, label normalized to مقاهي, hold 0', r2.sector_code === 'cafe' && r2.type === 'مقاهي' && r2.points_hold_days === 0);
    check('insert with only a sector code: services → type خدمات, hold 0', r3.sector_code === 'services' && r3.type === 'خدمات' && r3.points_hold_days === 0);
    check('insert with an unknown free-text label: falls into services (the old "أخرى" bucket)', r4.sector_code === 'services' && r4.type === 'خدمات');
    check('insert with both: the CODE wins, the label is derived from it (no disagreement can be stored)', r5.sector_code === 'medical' && r5.type === 'صحة');
    check('a new merchant\'s auto-created branch settings get the merchant\'s sector, not the "cafe" default',
      JSON.stringify(await branchSectors(r1.id)) === '["retail"]');
    await admin(c => c.query(`update merchants set type='صحة' where id=$1`, [r3.id]));
    check('a legacy write of ONLY the label moves the code with it (and the branch mirror)', (await merchantRow(r3.id)).sector_code === 'medical' && JSON.stringify(await branchSectors(r3.id)) === '["medical"]');
    const badCode = await tryQ(`update merchants set sector_code='bogus' where id=$1`, [r3.id]);
    const badBranch = await tryQ(`update branch_settings set sector_code='bogus' where branch_id=(select id from branches where merchant_id=$1 limit 1)`, [r3.id]);
    check('an invalid sector CODE is rejected on merchants and on branch_settings', !badCode.ok && !badBranch.ok && (await merchantRow(r3.id)).sector_code === 'medical');

    // ---- C) one merchant, two branches: mirror + write-through from every existing path ----
    const multi = r1.id;
    await admin(c => c.query(`insert into branches (merchant_id, name) values ($1, 'الفرع الثاني')`, [multi]));
    check('a SECOND branch is created with the merchant\'s sector too', JSON.stringify(await branchSectors(multi)) === '["retail","retail"]');
    await admin(c => c.query(`update merchants set sector_code='cafe' where id=$1`, [multi]));
    check('changing the merchant\'s sector re-mirrors EVERY branch', JSON.stringify(await branchSectors(multi)) === '["cafe","cafe"]' && (await merchantRow(multi)).type === 'مقاهي');

    const branchA = (await admin(c => c.query('select id from branches where merchant_id=$1 order by created_at, id limit 1', [multi]))).rows[0].id;
    const owner = crypto.randomUUID(), staff = crypto.randomUUID(), kUid = crypto.randomUUID(), strangerK = crypto.randomUUID();
    for (const u of [owner, staff, kUid, strangerK]) await admin(c => c.query('insert into auth.users (id) values ($1)', [u]));
    await admin(c => c.query(`insert into merchant_members (merchant_id, auth_user_id, role) values ($1,$2,'owner'),($1,$3,'staff')`, [multi, owner, staff]));
    const kReq = await asUser(kUid, c => c.query('select * from request_device_pairing()'));
    await asUser(owner, c => c.query('select * from approve_device_pairing($1,$2)', [kReq.rows[0].pairing_code, branchA]));

    const kioskWrite = await asUser(kUid, c => c.query(`update branch_settings set sector_code='services', biz_name='اسم' where branch_id=$1`, [branchA]));
    check('kiosk settings screen path (device RLS update): the save succeeds and is WRITE-THROUGH to the merchant',
      kioskWrite.rowCount === 1 && (await merchantRow(multi)).sector_code === 'services' && (await merchantRow(multi)).type === 'خدمات');
    check('… and the OTHER branch follows (one merchant, one sector)', JSON.stringify(await branchSectors(multi)) === '["services","services"]');
    const staffWrite = await asUser(staff, c => c.query(`update branch_settings set sector_code='restaurant' where branch_id=$1`, [branchA]));
    check('merchant.html path (staff RLS update): write-through too', staffWrite.rowCount === 1 && (await merchantRow(multi)).sector_code === 'restaurant' && JSON.stringify(await branchSectors(multi)) === '["restaurant","restaurant"]');
    const sameWrite = await asUser(kUid, c => c.query(`update branch_settings set sector_code='restaurant', biz_slogan='س' where branch_id=$1`, [branchA]));
    check('a save that re-sends the SAME sector (every kiosk save does) changes nothing else', sameWrite.rowCount === 1 && (await merchantRow(multi)).sector_code === 'restaurant');
    const foreign = await asUser(strangerK, c => c.query(`update branch_settings set sector_code='medical' where branch_id=$1`, [branchA]));
    check('an unpaired / foreign session matches zero rows and cannot touch the merchant\'s sector', foreign.rowCount === 0 && (await merchantRow(multi)).sector_code === 'restaurant');
    const clientMerchant = await asUser(owner, async c => { try { const r = await c.query(`update merchants set sector_code='medical' where id=$1`, [multi]); return 'rows:' + r.rowCount; } catch (e) { return 'fail:' + e.message; } });
    check('even the owner cannot write merchants directly (only through the branch settings path / RPC)', clientMerchant !== 'rows:1' && (await merchantRow(multi)).sector_code === 'restaurant');

    // ---- D) hold days follow a NON-customized default only; owner RPC ----
    await admin(c => c.query(`update merchants set sector_code='grocery' where id=$1`, [multi]));
    check('restaurant (0, default) → grocery: hold FOLLOWS the new default (7)', (await merchantRow(multi)).points_hold_days === 7);
    await admin(c => c.query(`update merchants set sector_code='cafe' where id=$1`, [multi]));
    check('grocery (7, default) → cafe: hold follows back to 0', (await merchantRow(multi)).points_hold_days === 0);
    await admin(c => c.query(`update merchants set sector_code='retail' where id=$1`, [multi]));
    const rpc = (uid, days, mid = multi) => asUser(uid, async c => { try { const r = await c.query('select merchant_set_points_hold_days($1,$2) as d', [mid, days]); return { ok: true, d: r.rows[0].d }; } catch (e) { return { ok: false, msg: e.message }; } });
    const set3 = await rpc(owner, 3);
    check('owner sets a custom hold (3) via merchant_set_points_hold_days', set3.ok && set3.d === 3 && (await merchantRow(multi)).points_hold_days === 3);
    await asUser(kUid, c => c.query(`update branch_settings set sector_code='cafe' where branch_id=$1`, [branchA]));
    check('a CUSTOMIZED hold (3) is NOT overwritten when the sector changes (retail → cafe), from any path', (await merchantRow(multi)).points_hold_days === 3 && (await merchantRow(multi)).sector_code === 'cafe');
    const set0 = await rpc(owner, 0);
    await admin(c => c.query(`update merchants set sector_code='grocery' where id=$1`, [multi]));
    check('once the owner puts it back to the sector default (0), it follows sector changes again (→ 7)', set0.ok && (await merchantRow(multi)).points_hold_days === 7);
    const staffRpc = await rpc(staff, 5);
    const otherOwner = crypto.randomUUID();
    await admin(c => c.query('insert into auth.users (id) values ($1)', [otherOwner]));
    await admin(c => c.query(`insert into merchant_members (merchant_id, auth_user_id, role) values ('20000000-0000-0000-0000-000000000001',$1,'owner')`, [otherOwner]));
    const otherRpc = await rpc(otherOwner, 5);
    const kioskRpc = await rpc(kUid, 5);
    check('merchant_set_points_hold_days is owner-only: staff, another merchant\'s owner and a kiosk are refused',
      [staffRpc, otherRpc, kioskRpc].every(x => !x.ok && /لا تملك صلاحية/.test(x.msg)) && (await merchantRow(multi)).points_hold_days === 7);
    const big = await rpc(owner, 366), neg = await rpc(owner, -1), nul = await rpc(owner, null);
    check('hold days outside 0..365 (or null) are rejected with NOJ_INVALID_HOLD_DAYS', [big, neg, nul].every(x => !x.ok && /NOJ_INVALID_HOLD_DAYS/.test(x.msg)));
    const grocerPending = async () => JSON.stringify((await admin(c => c.query(`select id, release_at, points_delta, status from point_transactions where merchant_id='20000000-0000-0000-0000-000000000002' and status='pending' order by id`))).rows);
    const pendingBefore = await grocerPending();
    await admin(c => c.query(`update merchants set points_hold_days = 30 where id='20000000-0000-0000-0000-000000000002'`));
    check('changing a hold period is never retroactive: existing pending rows keep their release_at', pendingBefore !== '[]' && (await grocerPending()) === pendingBefore);
    await admin(c => c.query(`update merchants set points_hold_days = 7 where id='20000000-0000-0000-0000-000000000002'`));

    // ---- E) the hold default rule, in both files, and in merchant.html ----
    const hd = async (v) => (await admin(c => c.query('select merchant_default_hold_days($1) as d', [v]))).rows[0].d;
    let hdOk = true;
    for (const s of SECTORS) if ((await hd(s)) !== (s === 'grocery' || s === 'retail' ? 7 : 0)) hdOk = false;
    for (const [l, d] of [['بقالة', 7], ['تجزئة', 7], ['مقاهي', 0], ['مطاعم', 0], ['صحة', 0], ['خدمات', 0]]) if ((await hd(l)) !== d) hdOk = false;
    check('merchant_default_hold_days: grocery/retail = 7, every other sector = 0 (codes and labels)', hdOk);
    const src = async () => (await admin(c => c.query(`select prosrc from pg_proc where proname='merchant_default_hold_days'`))).rows[0].prosrc;
    apply('supabase-migration-pending-points.sql');
    const a1 = await src();
    apply('supabase-migration-unified-sectors.sql');
    check('merchant_default_hold_days has the IDENTICAL body in pending-points.sql and unified-sectors.sql (either order)', a1 === (await src()));
    const html = fs.readFileSync(path.join(REPO_ROOT, 'merchant.html'), 'utf8');
    const holdConst = html.match(/var SECTOR_HOLD_DEFAULTS=(\{[^}]*\})/);
    const labelConst = html.match(/var SECTOR_LABELS=(\{[^}]*\})/);
    const uiHold = holdConst ? Function('return ' + holdConst[1])() : {};
    const uiLabels = labelConst ? Function('return ' + labelConst[1])() : {};
    let uiOk = JSON.stringify(Object.keys(uiLabels).sort()) === JSON.stringify([...SECTORS].sort()) && JSON.stringify(Object.keys(uiHold).sort()) === JSON.stringify([...SECTORS].sort());
    for (const s of SECTORS) if (uiHold[s] !== (await hd(s))) uiOk = false;
    check('merchant.html offers exactly the six sectors and suggests the SAME default hold as the server for each', uiOk);

    const idx = fs.readFileSync(path.join(REPO_ROOT, 'index.html'), 'utf8');
    const catSrc = idx.match(/const CAT=(\{[^\n]*\});/);
    const CATMAP = catSrc ? Function('return ' + catSrc[1])() : {};
    const pBlock = idx.slice(idx.indexOf('const P={'), idx.indexOf('function ic('));
    const icons = new Set([...pBlock.matchAll(/^ (\w+):'/gm)].map(m => m[1]));
    const labels = (await admin(c => c.query(`select public.sector_label(s) as l from unnest($1::text[]) s`, [SECTORS]))).rows.map(r => r.l);
    check('index.html CAT has an entry (colour + an icon that exists) for every label the server can produce, plus the legacy "أخرى"',
      [...labels, 'أخرى'].every(l => CATMAP[l] && /^#[0-9A-Fa-f]{6}$/.test(CATMAP[l].c) && icons.has(CATMAP[l].i)) &&
      CATMAP['تجزئة'] && CATMAP['خدمات'] && CATMAP['تجزئة'].c !== CATMAP['بقالة'].c);

    // ---- F) access to the internals ----
    const internals = ['sector_code_from_type(text)', 'sector_label(text)', 'merchants_sector_sync_trg()', 'merchants_sector_mirror_trg()', 'branch_settings_sector_sync_trg()'];
    const priv = await admin(c => c.query(`select bool_or(has_function_privilege(r, ('public.' || f)::regprocedure, 'execute')) as any
      from unnest($1::text[]) f, unnest(array['anon','authenticated']) r`, [internals]));
    const rpcPriv = await admin(c => c.query(`select has_function_privilege('anon','public.merchant_set_points_hold_days(uuid,integer)','execute') as anon,
      has_function_privilege('authenticated','public.merchant_set_points_hold_days(uuid,integer)','execute') as authed`));
    check('the sector helpers and trigger functions are not executable by anon/authenticated; the RPC is authenticated-only',
      priv.rows[0].any === false && rpcPriv.rows[0].anon === false && rpcPriv.rows[0].authed === true);

    // ---- H) re-running the migration changes nothing ----
    const snap = async () => {
      const o = {};
      for (const [k, q] of Object.entries(SECTOR_SNAPSHOT_SQL)) o[k] = (await admin(c => c.query(q))).rows;
      o.bs = (await admin(c => c.query('select branch_id, sector_code from branch_settings order by branch_id'))).rows;
      return JSON.stringify(o);
    };
    const s1 = await snap();
    apply('supabase-migration-unified-sectors.sql');
    check('migration is idempotent: a re-run changes no invoice, ledger row, balance, merchant or branch setting', s1 === (await snap()));
    check('end state: no branch disagrees with its merchant, no merchant label disagrees with its code', (await divergent()) === 0);

    await admin(c => c.query('delete from merchants where id = any($1)', [[r1.id, r2.id, r3.id, r4.id, r5.id]]));
  }

  // =========================================================================
  // 22) GENERAL LOCKDOWN INVARIANT: no SECURITY DEFINER function in `public`
  //     grants EXECUTE to anon, period — not scoped to any specific function
  //     list. Catches exactly the kind of gap the per-function checks above
  //     missed: cancel_appointment() had anon granted BY NAME and nobody
  //     noticed until a live audit; current_device_id(), kiosk_claim_pos_
  //     transaction(), claim_unclaimed_invoices(), record_otp_request(),
  //     approve_device_pairing(), claim_or_create_verified_profile() were
  //     never granted to anon by name but still had PUBLIC's own separate
  //     implicit grant left unrevoked — anon inherits whatever PUBLIC has.
  //     Any function added later without this invariant in mind fails here
  //     immediately, instead of waiting for the next live audit.
  // =========================================================================
  {
    // explicit allow-list — empty on purpose. Add a function name here only
    // with a comment explaining exactly why anon genuinely needs it; do not
    // add anything Supabase itself creates outside this repo's migration
    // files (e.g. rls_auto_enable, seen live but never defined here — not
    // reachable in this local test DB at all, so it cannot appear below
    // regardless, but the exclusion is named here for anyone reading this
    // later and wondering why the list isn't literally empty-empty).
    const ALLOWED_ANON_FUNCTIONS = [];

    const anonOpen = await admin(c => c.query(`
      select p.proname, pg_get_function_identity_arguments(p.oid) as args
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
        and p.prosecdef = true
        and has_function_privilege('anon', p.oid, 'EXECUTE')
      order by p.proname
    `));
    const unexpected = anonOpen.rows.filter(r => !ALLOWED_ANON_FUNCTIONS.includes(r.proname));
    if (unexpected.length) console.log('  unexpected anon-reachable SECURITY DEFINER functions:', JSON.stringify(unexpected));
    check('GENERAL LOCKDOWN: no SECURITY DEFINER function in public grants EXECUTE to anon, except the explicit allow-list (currently empty)',
      unexpected.length === 0);
  }

  console.log('\n=== SUMMARY:', pass, 'passed,', fail, 'failed ===');
  if (failures.length) console.log('Failures:', JSON.stringify(failures, null, 2));
  process.exit(fail > 0 ? 1 : 0);
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
