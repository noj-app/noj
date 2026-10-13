// NOJ — fake Supabase client for kiosk.html Playwright tests, injected into
// the page via window.__NOJ_SUPABASE_CLIENT__ (the same test hook kiosk.html
// already exposes for index.html-style testing — see getSb() in kiosk.html).
// No live network at all: every sb.auth/.rpc/.from/.channel call kiosk.html
// actually makes is answered here from window.__NOJ_SCENARIO__, plain JSON
// data the test sets via page.addInitScript BEFORE this file runs (so
// window.__NOJ_SUPABASE_CLIENT__ exists before kiosk.html's own bootKiosk()
// call at the bottom of the page). Evaluated INSIDE the browser page — plain
// dependency-free browser JS, no require/module here.
(function () {
  function buildFakeSupabase(scenario) {
    var state = { session: null, channelCb: null, channelStatusCb: null };

    function singleRowFor(table) {
      if (table === 'branches') return scenario.branchRow;
      if (table === 'merchants') return scenario.merchantRow;
      if (table === 'branch_settings') return scenario.branchSettingsRow;
      return null;
    }
    function matchesFilters(row, filters) {
      for (var i = 0; i < filters.length; i++) {
        var f = filters[i];
        if (f.op === 'eq' && row[f.col] !== f.val) return false;
        if (f.op === 'gt' && !(new Date(row[f.col]).getTime() > new Date(f.val).getTime())) return false;
      }
      return true;
    }
    function makeBuilder(table) {
      var filters = [], limitN = null, isUpdate = false;
      function resolveList() {
        if (table === 'pos_transactions') {
          var rows = (scenario.pendingTxns || []).filter(function (r) { return matchesFilters(r, filters); });
          if (limitN != null) rows = rows.slice(0, limitN);
          return Promise.resolve({ data: rows, error: null });
        }
        return Promise.resolve({ data: isUpdate ? null : [], error: null });
      }
      var builder = {
        select: function () { return builder; },
        eq: function (col, val) { filters.push({ op: 'eq', col: col, val: val }); return builder; },
        gt: function (col, val) { filters.push({ op: 'gt', col: col, val: val }); return builder; },
        order: function () { return builder; },
        limit: function (n) { limitN = n; return builder; },
        update: function () { isUpdate = true; return builder; },
        single: function () {
          var row = singleRowFor(table);
          return Promise.resolve(row ? { data: row, error: null } : { data: null, error: { message: 'not found' } });
        },
        maybeSingle: function () {
          return Promise.resolve({ data: singleRowFor(table) || null, error: null });
        },
        then: function (resolve, reject) { return resolveList().then(resolve, reject); },
      };
      return builder;
    }

    function rpc(name, args) {
      if (name === 'request_device_pairing') {
        return Promise.resolve({ data: scenario.deviceRow, error: null });
      }
      if (name === 'kiosk_claim_pos_transaction') {
        var result = (scenario.claimResults || {})[args.p_transaction_id];
        if (!result) return Promise.resolve({ data: null, error: { message: 'NOJ_TRANSACTION_NOT_FOUND' } });
        if (result.error) return Promise.resolve({ data: null, error: { message: result.error } });
        return Promise.resolve({ data: [result.row], error: null });
      }
      if (name === 'kiosk_lookup_customer_points') {
        return Promise.resolve({ data: scenario.loyaltyPoints != null ? scenario.loyaltyPoints : 0, error: null });
      }
      if (name === 'verify_admin_pin') {
        return Promise.resolve({ data: args.p_pin === (scenario.adminPin || '0000'), error: null });
      }
      return Promise.resolve({ data: null, error: { message: 'no handler for ' + name } });
    }

    var client = {
      auth: {
        getSession: function () { return Promise.resolve({ data: { session: state.session } }); },
        signInAnonymously: function () {
          state.session = { user: { id: scenario.deviceAuthId || 'device-auth-id' } };
          return Promise.resolve({ data: { session: state.session }, error: null });
        },
      },
      rpc: rpc,
      from: function (table) { return makeBuilder(table); },
      channel: function () {
        var ch = {
          on: function (event, opts, cb) { state.channelCb = cb; return ch; },
          subscribe: function (statusCb) {
            state.channelStatusCb = statusCb;
            setTimeout(function () { statusCb(scenario.initialChannelStatus || 'SUBSCRIBED'); }, 0);
            return ch;
          },
          unsubscribe: function () { state.channelCb = null; state.channelStatusCb = null; },
        };
        return ch;
      },
    };

    window.__TEST__ = {
      pushRealtimeInsert: function (row) { if (state.channelCb) state.channelCb({ new: row }); },
      setChannelStatus: function (status) { if (state.channelStatusCb) state.channelStatusCb(status); },
      setPendingTxns: function (rows) { scenario.pendingTxns = rows; },
      setClaimResult: function (txnId, result) {
        scenario.claimResults = scenario.claimResults || {};
        scenario.claimResults[txnId] = result;
      },
    };
    return client;
  }

  window.__NOJ_BUILD_FAKE_SUPABASE__ = buildFakeSupabase;
  if (window.__NOJ_SCENARIO__) {
    window.__NOJ_SUPABASE_CLIENT__ = buildFakeSupabase(window.__NOJ_SCENARIO__);
  }
})();
