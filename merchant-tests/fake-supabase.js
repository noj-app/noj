// NOJ — fake Supabase client for merchant.html Playwright tests, injected via
// window.__NOJ_SUPABASE_CLIENT__ (same test hook pattern as kiosk-tests/
// index-tests would use — see getSb() in merchant.html). No live network at
// all: every sb.auth/.rpc/.from call merchant.html actually makes is answered
// here from window.__NOJ_SCENARIO__. Evaluated INSIDE the browser page — plain
// dependency-free browser JS, no require/module here.
//
// Session persistence here deliberately uses REAL browser localStorage (under
// a configurable key, MERCHANT_STORAGE_KEY by default — matching merchant.
// html's own constant) rather than pure in-memory JS state like kiosk-tests'
// fake client does — this is the one thing the session-isolation test
// actually needs to verify for real: that merchant.html's session lands under
// its OWN distinct storage key, never touching whatever key index.html/
// kiosk.html's real supabase-js session would use on the same origin.
(function () {
  var MERCHANT_STORAGE_KEY = 'sb-noj-merchant-auth';

  function buildFakeSupabase(scenario) {
    var storageKey = scenario.storageKey || MERCHANT_STORAGE_KEY;
    var state = { lastApproveCall: null, lastUpdateCall: null, usedCaptchaTokens: [] };

    function readSession() {
      try {
        var raw = localStorage.getItem(storageKey);
        return raw ? JSON.parse(raw) : null;
      } catch (e) { return null; }
    }
    function writeSession(session) {
      try { localStorage.setItem(storageKey, JSON.stringify(session)); } catch (e) {}
    }
    function clearSession() {
      try { localStorage.removeItem(storageKey); } catch (e) {}
    }

    function matchesFilters(row, filters) {
      for (var i = 0; i < filters.length; i++) {
        var f = filters[i];
        if (f.op === 'eq' && row[f.col] !== f.val) return false;
        if (f.op === 'in' && f.vals.indexOf(row[f.col]) === -1) return false;
      }
      return true;
    }

    function makeBuilder(table) {
      var filters = [], updatePayload = null;
      function resolveList() {
        if (updatePayload) {
          if (table === 'devices') {
            (scenario.devices || []).forEach(function (d) {
              if (matchesFilters(d, filters)) Object.assign(d, updatePayload);
            });
            state.lastUpdateCall = { table: table, payload: updatePayload, filters: filters.slice() };
          }
          return Promise.resolve({ data: null, error: null });
        }
        if (table === 'merchant_members') {
          if (scenario.merchantMembersError) return Promise.resolve({ data: null, error: { message: scenario.merchantMembersError } });
          return Promise.resolve({ data: scenario.merchantMembers || [], error: null });
        }
        if (table === 'merchants') {
          var rows = (scenario.merchants || []).filter(function (r) { return matchesFilters(r, filters); });
          return Promise.resolve({ data: rows, error: null });
        }
        if (table === 'branches') {
          var brows = (scenario.branches || []).filter(function (r) { return matchesFilters(r, filters); });
          return Promise.resolve({ data: brows, error: null });
        }
        if (table === 'devices') {
          var drows = (scenario.devices || []).filter(function (r) { return matchesFilters(r, filters); });
          return Promise.resolve({ data: drows, error: null });
        }
        return Promise.resolve({ data: [], error: null });
      }
      var builder = {
        select: function () { return builder; },
        eq: function (col, val) { filters.push({ op: 'eq', col: col, val: val }); return builder; },
        in: function (col, vals) { filters.push({ op: 'in', col: col, vals: vals }); return builder; },
        order: function () { return builder; },
        update: function (payload) { updatePayload = payload; return builder; },
        then: function (resolve, reject) { return resolveList().then(resolve, reject); },
      };
      return builder;
    }

    function rpc(name, args) {
      if (name === 'approve_device_pairing') {
        state.lastApproveCall = args;
        if (args.p_pairing_code !== (scenario.validPairingCode || '123456')) {
          return Promise.resolve({ data: null, error: { message: 'رمز الإقران غير صالح أو استُخدم من قبل' } });
        }
        if (scenario.approveOwnershipError) {
          return Promise.resolve({ data: null, error: { message: 'لا تملك صلاحية على هذا الفرع' } });
        }
        var row = {
          id: scenario.newDeviceId || 'new-device-1',
          branch_id: args.p_branch_id,
          label: 'تابلت',
          pairing_code: null,
          is_active: true,
          revoked_at: null,
          last_seen_at: new Date().toISOString(),
          created_at: new Date().toISOString(),
        };
        (scenario.devices = scenario.devices || []).push(row);
        return Promise.resolve({ data: row, error: null });
      }
      return Promise.resolve({ data: null, error: { message: 'no handler for ' + name } });
    }

    var client = {
      auth: {
        getSession: function () { return Promise.resolve({ data: { session: readSession() } }); },
        signInWithOtp: function (args) {
          if (scenario.otpSendShouldFail) return Promise.resolve({ error: { message: 'send failed' } });
          // محاكاة واقعية لرفض CAPTCHA من Supabase — فقط حين captchaEnabled
          // (سيناريوهات لا تحتاج هذا التفصيل تبقى كما كانت، بلا أي تحقق).
          // رمز Turnstile يُستهلَك مرة واحدة فعلياً لدى Cloudflare/Supabase
          // (راجع CLAUDE.md) — usedCaptchaTokens هنا يحاكي ذلك: نفس الرمز
          // المُرسَل مرتين يُرفض في المرة الثانية، تماماً كالحي.
          if (scenario.captchaEnabled) {
            var token = args.options && args.options.captchaToken;
            if (!token) {
              return Promise.resolve({ error: { message: 'captcha verification process failed' } });
            }
            if (state.usedCaptchaTokens.indexOf(token) !== -1) {
              return Promise.resolve({ error: { message: 'captcha verification process failed' } });
            }
            state.usedCaptchaTokens.push(token);
          }
          scenario.__pendingPhone = args.phone;
          return Promise.resolve({ data: {}, error: null });
        },
        verifyOtp: function (args) {
          if (args.token !== (scenario.validOtp || '123456')) {
            return Promise.resolve({ data: null, error: { message: 'توكن غير صحيح' } });
          }
          var session = { user: { id: scenario.authUserId || 'merchant-auth-id' }, access_token: 'fake-token' };
          writeSession(session);
          return Promise.resolve({ data: { session: session }, error: null });
        },
        signOut: function () { clearSession(); return Promise.resolve({ error: null }); },
      },
      rpc: rpc,
      from: function (table) { return makeBuilder(table); },
    };

    window.__TEST__ = {
      getLastApproveCall: function () { return state.lastApproveCall; },
      getLastUpdateCall: function () { return state.lastUpdateCall; },
      getDevices: function () { return scenario.devices || []; },
      getUsedCaptchaTokens: function () { return state.usedCaptchaTokens.slice(); },
    };
    return client;
  }

  window.__NOJ_BUILD_FAKE_SUPABASE__ = buildFakeSupabase;
  window.__NOJ_MERCHANT_STORAGE_KEY__ = MERCHANT_STORAGE_KEY;
  if (window.__NOJ_SCENARIO__) {
    window.__NOJ_SUPABASE_CLIENT__ = buildFakeSupabase(window.__NOJ_SCENARIO__);
  }
})();
