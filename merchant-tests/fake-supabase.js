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
    var state = {
      lastApproveCall: null, lastUpdateCall: null, usedCaptchaTokens: [],
      invoiceCalls: [], invoicesErrored: false,
      lastBranchSettingsUpdate: null, lastSetPinCall: null, lastIssuedPosToken: null, issuedPosTokenCount: 0
    };

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
        if (f.op === 'gt' && !(String(row[f.col]) > String(f.val))) return false;
      }
      return true;
    }

    function makeBuilder(table) {
      var filters = [], updatePayload = null, singleRequested = false;
      function resolveList() {
        if (updatePayload) {
          if (table === 'devices') {
            (scenario.devices || []).forEach(function (d) {
              if (matchesFilters(d, filters)) Object.assign(d, updatePayload);
            });
            state.lastUpdateCall = { table: table, payload: updatePayload, filters: filters.slice() };
          }
          if (table === 'branch_settings') {
            (scenario.branchSettings || []).forEach(function (s) {
              if (matchesFilters(s, filters)) {
                Object.assign(s, updatePayload);
                // trg_branch_settings_sector_sync (supabase-migration-sector-owner-only.sql):
                // المرآة للقراءة فقط — قيمة مختلفة عن قسم التاجر تُرفض.
                if (updatePayload.sector_code) state.branchSectorWriteAttempted = true;
              }
            });
            state.lastBranchSettingsUpdate = { payload: updatePayload, filters: filters.slice() };
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
        if (table === 'pos_connections') {
          if (scenario.posConnectionsError) return Promise.resolve({ data: null, error: { message: scenario.posConnectionsError } });
          var prows = (scenario.posConnections || []).filter(function (r) { return matchesFilters(r, filters); });
          return Promise.resolve({ data: prows, error: null });
        }
        if (table === 'branch_settings') {
          var srows = (scenario.branchSettings || []).filter(function (r) { return matchesFilters(r, filters); });
          return Promise.resolve({ data: srows, error: null });
        }
        if (table === 'merchant_services') {
          if (scenario.servicesError) return Promise.resolve({ data: null, error: { message: 'boom' } });
          var vrows = (scenario.services || []).filter(function (r) { return matchesFilters(r, filters); })
            .sort(function (a, b) { return a.sort_order - b.sort_order; })
            .map(function (r) { var o = Object.assign({}, r); delete o.merchant_id; return o; });
          return Promise.resolve({ data: vrows, error: null });
        }
        if (table === 'booking_alerts') {
          state.alertPolls = (state.alertPolls || 0) + 1;
          var arows = (scenario.bookingAlerts || []).filter(function (r) { return matchesFilters(r, filters); });
          return Promise.resolve({ data: arows, error: null });
        }
        return Promise.resolve({ data: [], error: null });
      }
      var builder = {
        select: function () { return builder; },
        eq: function (col, val) { filters.push({ op: 'eq', col: col, val: val }); return builder; },
        in: function (col, vals) { filters.push({ op: 'in', col: col, vals: vals }); return builder; },
        gt: function (col, val) { filters.push({ op: 'gt', col: col, val: val }); return builder; },
        order: function () { return builder; },
        update: function (payload) { updatePayload = payload; return builder; },
        single: function () { singleRequested = true; return builder; },
        then: function (resolve, reject) {
          return resolveList().then(function (res) {
            if (singleRequested && Array.isArray(res.data)) res = { data: res.data[0] || null, error: res.error };
            return res;
          }).then(resolve, reject);
        },
      };
      return builder;
    }

    // يحاكي التحقق الحقيقي داخل merchant_set_admin_pin()/merchant_issue_
    // pos_token() (supabase-migration-merchant-admin-controls.sql): يشتق
    // عضوية التاجر لفرع p_branch_id من scenario.merchantMembers/branches
    // نفسها التي يقرأها checkAccess()، لا افتراضاً منفصلاً — صف owner
    // فعلي مطلوب، لا يكفي أي عضو.
    function callerIsOwnerOfBranch(branchId) {
      var branch = (scenario.branches || []).find(function (b) { return b.id === branchId; });
      if (!branch) return false;
      var member = (scenario.merchantMembers || []).find(function (m) { return m.merchant_id === branch.merchant_id; });
      return !!member && member.role === 'owner';
    }

    // يحاكي trg_merchants_sector_sync عند merchant_set_sector (مالك فقط):
    // مدة التعليق تتبع افتراض القسم الجديد فقط إن كانت لا تزال تساوي افتراض
    // القسم القديم (لم تُعدَّل يدوياً).
    var HOLD_DEFAULTS = { grocery: 7, retail: 7, cafe: 0, restaurant: 0, medical: 0, services: 0 };
    function sectorWriteThrough(branchId, code) {
      var branch = (scenario.branches || []).find(function (b) { return b.id === branchId; });
      var m = branch && (scenario.merchants || []).find(function (x) { return x.id === branch.merchant_id; });
      if (!m || m.sector_code === code) return;
      if (typeof m.points_hold_days === 'number' && m.points_hold_days === HOLD_DEFAULTS[m.sector_code]) {
        m.points_hold_days = HOLD_DEFAULTS[code];
      }
      m.sector_code = code;
    }

    function rpc(name, args) {
      var isMemberOf = function (mid, ownerOnly) {
        return (scenario.merchantMembers || []).some(function (mm) { return mm.merchant_id === mid && (!ownerOnly || mm.role === 'owner'); });
      };
      var noAccess = { data: null, error: { message: 'لا تملك صلاحية على هذا التاجر' } };
      if (name === 'merchant_list_reservations') {
        (state.bookingListCalls = state.bookingListCalls || []).push(args);
        if (scenario.bookingsError) return Promise.resolve({ data: null, error: { message: 'boom' } });
        if (!isMemberOf(args.p_merchant_id)) return Promise.resolve(noAccess);
        var bm = (scenario.merchants || []).find(function (x) { return x.id === args.p_merchant_id; }) || {};
        var brows = (scenario.reservations || []).filter(function (r) { return r.merchant_id === args.p_merchant_id; })
          .map(function (r) { var o = Object.assign({}, r); delete o.merchant_id; return o; });
        return Promise.resolve({ data: { booking_enabled: !!bm.booking_enabled, sector_code: bm.sector_code,
          cancel_allowed: bm.booking_cancel_allowed !== false, cancel_cutoff_hours: bm.booking_cancel_cutoff_hours || 0,
          alerts_enabled: bm.booking_alerts_enabled !== false, rows: brows }, error: null });
      }
      if (name === 'merchant_set_booking_policy') {
        (state.policyCalls = state.policyCalls || []).push(args);
        if (!isMemberOf(args.p_merchant_id, true)) return Promise.resolve(noAccess);
        if (typeof args.p_cutoff_hours !== 'number' || args.p_cutoff_hours < 0 || args.p_cutoff_hours > 168) return Promise.resolve({ data: null, error: { message: 'NOJ_INVALID_CANCEL_POLICY' } });
        var pm = (scenario.merchants || []).find(function (x) { return x.id === args.p_merchant_id; });
        pm.booking_cancel_allowed = !!args.p_cancel_allowed; pm.booking_cancel_cutoff_hours = args.p_cutoff_hours;
        return Promise.resolve({ data: { cancel_allowed: pm.booking_cancel_allowed, cancel_cutoff_hours: pm.booking_cancel_cutoff_hours }, error: null });
      }
      if (name === 'merchant_set_booking_alerts') {
        (state.alertsCalls = state.alertsCalls || []).push(args);
        if (!isMemberOf(args.p_merchant_id, true)) return Promise.resolve(noAccess);
        var am = (scenario.merchants || []).find(function (x) { return x.id === args.p_merchant_id; });
        am.booking_alerts_enabled = !!args.p_enabled;
        return Promise.resolve({ data: am.booking_alerts_enabled, error: null });
      }
      if (name === 'merchant_save_service') {
        (state.serviceCalls = state.serviceCalls || []).push(args);
        if (!isMemberOf(args.p_merchant_id, true)) return Promise.resolve(noAccess);
        var list = (scenario.services = scenario.services || []);
        var nm = String(args.p_name || '').trim();
        if (list.some(function (v) { return v.merchant_id === args.p_merchant_id && v.name === nm && v.id !== args.p_service_id; })) {
          return Promise.resolve({ data: null, error: { message: 'NOJ_SERVICE_NAME_TAKEN' } });
        }
        var row;
        if (args.p_service_id) {
          row = list.find(function (v) { return v.id === args.p_service_id; });
          if (!row) return Promise.resolve({ data: null, error: { message: 'NOJ_SERVICE_NOT_FOUND' } });
        } else {
          row = { id: 'svc-new-' + list.length, merchant_id: args.p_merchant_id, sort_order: list.length };
          list.push(row);
        }
        Object.assign(row, { name: nm, price: args.p_price, is_active: args.p_is_active, booking_enabled: args.p_booking_enabled });
        var outRow = Object.assign({}, row); delete outRow.merchant_id;
        return Promise.resolve({ data: outRow, error: null });
      }
      if (name === 'merchant_set_reservation_status') {
        (state.bookingStatusCalls = state.bookingStatusCalls || []).push(args);
        var res = (scenario.reservations || []).find(function (r) { return r.id === args.p_reservation_id; });
        if (!res) return Promise.resolve({ data: null, error: { message: 'NOJ_RESERVATION_NOT_FOUND' } });
        if (!isMemberOf(res.merchant_id)) return Promise.resolve(noAccess);
        if ((args.p_status === 'confirmed' && res.status !== 'pending') || (args.p_status === 'cancelled' && ['pending', 'confirmed'].indexOf(res.status) === -1)) {
          return Promise.resolve({ data: null, error: { message: 'NOJ_INVALID_TRANSITION' } });
        }
        res.status = args.p_status;
        var out = Object.assign({}, res); delete out.merchant_id;
        return Promise.resolve({ data: out, error: null });
      }
      if (name === 'merchant_set_booking_enabled') {
        (state.bookingToggleCalls = state.bookingToggleCalls || []).push(args);
        if (!isMemberOf(args.p_merchant_id, true)) return Promise.resolve(noAccess);
        var tm = (scenario.merchants || []).find(function (x) { return x.id === args.p_merchant_id; });
        if (!tm || ['restaurant', 'services'].indexOf(tm.sector_code) === -1) return Promise.resolve({ data: null, error: { message: 'NOJ_BOOKING_NOT_AVAILABLE' } });
        tm.booking_enabled = !!args.p_enabled;
        return Promise.resolve({ data: tm.booking_enabled, error: null });
      }
      if (name === 'merchant_set_sector') {
        (state.sectorCalls = state.sectorCalls || []).push(args);
        var owner = (scenario.merchantMembers || []).some(function (mm) { return mm.merchant_id === args.p_merchant_id && mm.role === 'owner'; });
        if (!owner) return Promise.resolve({ data: null, error: { message: 'لا تملك صلاحية على هذا التاجر' } });
        if (scenario.sectorRpcError) return Promise.resolve({ data: null, error: { message: 'boom' } });
        if (!HOLD_DEFAULTS.hasOwnProperty(args.p_sector)) return Promise.resolve({ data: null, error: { message: 'NOJ_INVALID_SECTOR' } });
        var mr = (scenario.merchants || []).find(function (x) { return x.id === args.p_merchant_id; });
        if (mr) {
          (scenario.branches || []).filter(function (b) { return b.merchant_id === mr.id; }).forEach(function (b) {
            sectorWriteThrough(b.id, args.p_sector);
            var bs = (scenario.branchSettings || []).find(function (x) { return x.branch_id === b.id; });
            if (bs) bs.sector_code = args.p_sector;
          });
          mr.sector_code = args.p_sector;
        }
        return Promise.resolve({ data: { sector_code: args.p_sector, points_hold_days: mr ? mr.points_hold_days : null }, error: null });
      }
      if (name === 'merchant_set_points_hold_days') {
        (state.holdCalls = state.holdCalls || []).push(args);
        var isOwner = (scenario.merchantMembers || []).some(function (mm) { return mm.merchant_id === args.p_merchant_id && mm.role === 'owner'; });
        if (!isOwner) return Promise.resolve({ data: null, error: { message: 'لا تملك صلاحية على هذا التاجر' } });
        if (scenario.holdRpcError) return Promise.resolve({ data: null, error: { message: 'boom' } });
        if (typeof args.p_days !== 'number' || args.p_days < 0 || args.p_days > 365) {
          return Promise.resolve({ data: null, error: { message: 'NOJ_INVALID_HOLD_DAYS' } });
        }
        var mrow = (scenario.merchants || []).find(function (x) { return x.id === args.p_merchant_id; });
        if (mrow) mrow.points_hold_days = args.p_days;
        return Promise.resolve({ data: args.p_days, error: null });
      }
      if (name === 'merchant_list_invoices') {
        state.invoiceCalls.push(args);
        var delay = (scenario.invoicesDelays || [])[state.invoiceCalls.length - 1] || 0;
        var finish = function (v) {
          return delay ? new Promise(function (res) { setTimeout(function () { res(v); }, delay); }) : Promise.resolve(v);
        };
        if (scenario.invoicesError || (scenario.invoicesErrorOnce && !state.invoicesErrored)) {
          state.invoicesErrored = true;
          return finish({ data: null, error: { message: 'boom' } });
        }
        var member = (scenario.merchantMembers || []).some(function (m) { return m.merchant_id === args.p_merchant_id; });
        if (!member) return finish({ data: null, error: { message: 'لا تملك صلاحية على هذا التاجر' } });
        var all = (scenario.invoices || []).filter(function (r) {
          var day = r.created_at_riyadh.slice(0, 10);
          return day >= args.p_from && day <= args.p_to &&
            (!args.p_branch_id || r.branch_id === args.p_branch_id) &&
            (args.p_include_demo || r.source !== 'demo');
        }).sort(function (x, y) { return x.created_at_riyadh < y.created_at_riyadh ? 1 : -1; });
        var sum = function (k) { return all.reduce(function (t, r) { return t + Number(r[k] || 0); }, 0); };
        var off = args.p_offset || 0, lim = args.p_limit || 25;
        return finish({ data: {
          summary: { count: all.length, sales: sum('amount'), vat: sum('vat'), refunded: sum('refunded_amount'), net: sum('amount') - sum('refunded_amount') },
          rows: all.slice(off, off + lim), limit: lim, offset: off, has_more: off + lim < all.length
        }, error: null });
      }
      if (name === 'merchant_set_admin_pin') {
        if (!/^\d{4}$/.test(args.p_pin || '')) {
          return Promise.resolve({ data: null, error: { message: 'الرمز يجب أن يكون 4 أرقام بالضبط' } });
        }
        if (!callerIsOwnerOfBranch(args.p_branch_id)) {
          return Promise.resolve({ data: null, error: { message: 'لا تملك صلاحية على هذا الفرع' } });
        }
        state.lastSetPinCall = args;
        return Promise.resolve({ data: null, error: null });
      }
      if (name === 'merchant_issue_pos_token') {
        if (!callerIsOwnerOfBranch(args.p_branch_id)) {
          return Promise.resolve({ data: null, error: { message: 'لا تملك صلاحية على هذا الفرع' } });
        }
        state.issuedPosTokenCount++;
        (function () {
          var list = (scenario.posConnections = scenario.posConnections || []);
          var existing = list.find(function (r) { return r.branch_id === args.p_branch_id && r.provider === 'generic'; });
          if (existing) { existing.status = 'connected'; existing.last_error = null; }
          else list.push({ branch_id: args.p_branch_id, provider: 'generic', kind: 'token_issued', status: 'connected', last_invoice_at: null, last_error: null });
        })();
        var token = 'fake-pos-token-' + state.issuedPosTokenCount;
        state.lastIssuedPosToken = token;
        return Promise.resolve({ data: token, error: null });
      }
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
      realtime: { setAuth: function (t) { (state.setAuthCalls = state.setAuthCalls || []).push(t); } },
      channel: function (name) {
        var ch = { name: name, handlers: [], removed: false, statusCb: null };
        ch.on = function (type, filter, cb) { ch.handlers.push({ type: type, filter: filter, cb: cb }); return ch; };
        ch.subscribe = function (cb) {
          ch.statusCb = cb;
          setTimeout(function () { if (cb) cb(scenario.alertChannelStatus || 'SUBSCRIBED'); }, 10);
          return ch;
        };
        (state.channels = state.channels || []).push(ch);
        return ch;
      },
      removeChannel: function (ch) { ch.removed = true; return Promise.resolve('ok'); },
    };

    window.__TEST__ = {
      getLastApproveCall: function () { return state.lastApproveCall; },
      getLastUpdateCall: function () { return state.lastUpdateCall; },
      getDevices: function () { return scenario.devices || []; },
      getUsedCaptchaTokens: function () { return state.usedCaptchaTokens.slice(); },
      getInvoiceCalls: function () { return state.invoiceCalls.slice(); },
      getLastBranchSettingsUpdate: function () { return state.lastBranchSettingsUpdate; },
      getBranchSettings: function (branchId) { return (scenario.branchSettings || []).find(function (s) { return s.branch_id === branchId; }) || null; },
      getLastSetPinCall: function () { return state.lastSetPinCall; },
      getLastIssuedPosToken: function () { return state.lastIssuedPosToken; },
      getIssuedPosTokenCount: function () { return state.issuedPosTokenCount; },
      getHoldCalls: function () { return (state.holdCalls || []).slice(); },
      getSectorCalls: function () { return (state.sectorCalls || []).slice(); },
      branchSectorWriteAttempted: function () { return !!state.branchSectorWriteAttempted; },
      getChannels: function () { return (state.channels || []).map(function (c) { return { name: c.name, removed: c.removed, filter: c.handlers[0] && c.handlers[0].filter }; }); },
      emitBookingAlert: function (row) {
        (state.channels || []).forEach(function (c) {
          if (c.removed) return;
          c.handlers.forEach(function (h) {
            if (h.filter && h.filter.table === 'booking_alerts' && h.filter.filter === 'merchant_id=eq.' + row.merchant_id) h.cb({ new: row });
          });
        });
      },
      setChannelStatus: function (st) { (state.channels || []).forEach(function (c) { if (!c.removed && c.statusCb) c.statusCb(st); }); },
      getAlertPolls: function () { return state.alertPolls || 0; },
      getSetAuthCalls: function () { return (state.setAuthCalls || []).slice(); },
      getPolicyCalls: function () { return (state.policyCalls || []).slice(); },
      getAlertsCalls: function () { return (state.alertsCalls || []).slice(); },
      getServiceCalls: function () { return (state.serviceCalls || []).slice(); },
      getBookingListCalls: function () { return (state.bookingListCalls || []).slice(); },
      getBookingStatusCalls: function () { return (state.bookingStatusCalls || []).slice(); },
      getBookingToggleCalls: function () { return (state.bookingToggleCalls || []).slice(); },
      getMerchant: function (id) { return (scenario.merchants || []).find(function (m) { return m.id === id; }) || null; },
    };
    return client;
  }

  window.__NOJ_BUILD_FAKE_SUPABASE__ = buildFakeSupabase;
  window.__NOJ_MERCHANT_STORAGE_KEY__ = MERCHANT_STORAGE_KEY;
  if (window.__NOJ_SCENARIO__) {
    window.__NOJ_SUPABASE_CLIENT__ = buildFakeSupabase(window.__NOJ_SCENARIO__);
  }
})();
