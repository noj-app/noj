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
  // 4b) grant_app_consent(): the actual key for the door consent-privacy.sql
  //     built but never gave any UI a way to open — index.html now calls
  //     this after every login for a profile with no active consent.
  // =========================================================================
  {
    const consentUid = crypto.randomUUID();
    await admin(c => c.query('insert into auth.users (id) values ($1)', [consentUid]));
    const prof = await asUser(consentUid, c => c.query('select * from claim_or_create_profile($1) as p', ['522222220']));
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
    await asUser(otherConsentUid, c => c.query('select claim_or_create_profile($1)', ['522222221']));
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
    const newCustProf = await asUser(newCustUid, c => c.query('select * from claim_or_create_profile($1) as p', ['588888888']));
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
    await asUser(noBalanceUid, c => c.query('select claim_or_create_profile($1)', ['533333330']));
    const zeroBalanceRes = await asUser(kioskUid, c => c.query('select kiosk_lookup_customer_points($1) as points', ['533333330']));
    check('kiosk_lookup_customer_points: a registered customer with NO merchant_loyalty row at this merchant returns 0, not an error', Number(zeroBalanceRes.rows[0].points) === 0);

    // branches RLS: only a device paired to THIS branch may read it.
    const ownBranchRead = await asUser(kioskUid, c => c.query('select id from branches where id=$1', [BRANCH]));
    check('branches RLS: the paired device can select its own branch', ownBranchRead.rows.length === 1);
    const foreignBranchRead = await asUser(unpairedUid, c => c.query('select id from branches where id=$1', [BRANCH]));
    check('branches RLS: an unpaired device cannot select this branch', foreignBranchRead.rows.length === 0);
  }

  console.log('\n=== SUMMARY:', pass, 'passed,', fail, 'failed ===');
  if (failures.length) console.log('Failures:', JSON.stringify(failures, null, 2));
  process.exit(fail > 0 ? 1 : 0);
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
