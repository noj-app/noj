// NOJ — fake Supabase client for index.html (تطبيق نوج) Playwright tests,
// injected via window.__NOJ_SUPABASE_CLIENT__ (the test hook getSb() in
// index.html already honours). No live network: every sb.auth/.rpc/.from call
// index.html makes at boot and on the booking screens is answered here from
// window.__NOJ_SCENARIO__ (plain JSON set by the test before this file runs).
// Evaluated INSIDE the page — plain dependency-free browser JS.
(function () {
  function buildFakeSupabase(scenario) {
    var tables = scenario.tables || {};
    var calls = [];
    var queries = [];

    function matches(row, f) {
      if (f.op === 'eq') return row[f.col] === f.val;
      if (f.op === 'in') return f.vals.indexOf(row[f.col]) !== -1;
      if (f.op === 'gte') return String(row[f.col]) >= String(f.val);
      if (f.op === 'is') return (row[f.col] == null) === (f.val === null);
      return true;
    }
    function makeBuilder(table) {
      var filters = [], limitN = null, selectStr = null, orderCol = null, asc = true;
      var builder = {
        select: function (s) { selectStr = s; return builder; },
        eq: function (col, val) { filters.push({ op: 'eq', col: col, val: val }); return builder; },
        in: function (col, vals) { filters.push({ op: 'in', col: col, vals: vals }); return builder; },
        gte: function (col, val) { filters.push({ op: 'gte', col: col, val: val }); return builder; },
        is: function (col, val) { filters.push({ op: 'is', col: col, val: val }); return builder; },
        or: function () { return builder; },
        order: function (col, o) { orderCol = col; asc = !o || o.ascending !== false; return builder; },
        limit: function (n) { limitN = n; return builder; },
        then: function (resolve, reject) {
          queries.push({ table: table, select: selectStr, filters: filters.slice() });
          if ((scenario.failTables || []).indexOf(table) !== -1) {
            return Promise.resolve({ data: null, error: { message: 'boom' } }).then(resolve, reject);
          }
          var rows = (tables[table] || []).filter(function (r) { return filters.every(function (f) { return matches(r, f); }); });
          if (orderCol) rows = rows.slice().sort(function (a, b) { var x = a[orderCol], y = b[orderCol]; return (x < y ? -1 : x > y ? 1 : 0) * (asc ? 1 : -1); });
          if (limitN != null) rows = rows.slice(0, limitN);
          return Promise.resolve({ data: JSON.parse(JSON.stringify(rows)), error: null }).then(resolve, reject);
        },
      };
      return builder;
    }

    var SECTOR_OF = { 'مطاعم': 'restaurant', 'خدمات': 'services' };
    function rpc(name, args) {
      calls.push({ name: name, args: args });
      if (name === 'claim_or_create_verified_profile') return Promise.resolve({ data: scenario.profile, error: null });
      if (name === 'claim_unclaimed_invoices') return Promise.resolve({ data: null, error: null });
      if (name === 'get_merchant_clinics') return Promise.resolve({ data: scenario.clinics || [], error: null });
      if (name === 'get_merchant_queue_stats') return Promise.resolve({ data: [], error: null });
      if (name === 'create_reservation') {
        if (scenario.createReservationError) return Promise.resolve({ data: null, error: { message: scenario.createReservationError } });
        var m = (tables.merchants || []).find(function (x) { return x.id === args.p_merchant_id; });
        var sector = m && SECTOR_OF[m.type];
        if (!sector) return Promise.resolve({ data: null, error: { message: 'NOJ_BOOKING_NOT_AVAILABLE' } });
        if (!m.booking_enabled) return Promise.resolve({ data: null, error: { message: 'NOJ_BOOKING_DISABLED' } });
        var svc = null;
        if (sector === 'services') {
          svc = (tables.merchant_services || []).find(function (v) { return v.id === args.p_service_id && v.merchant_id === m.id && v.is_active && v.booking_enabled; });
          if (!svc) return Promise.resolve({ data: null, error: { message: 'NOJ_SERVICE_NOT_AVAILABLE' } });
        }
        var row = {
          id: 'res-new-' + calls.length, user_id: scenario.profile.id, merchant_id: m.id, clinic_id: null,
          scheduled_at: args.p_scheduled_at, status: 'pending', created_at: new Date().toISOString(),
          booking_kind: sector === 'restaurant' ? 'table' : 'service',
          party_size: sector === 'restaurant' ? args.p_party_size : null,
          service_id: svc ? svc.id : null, service_type: svc ? svc.name : null, note: args.p_note,
        };
        (tables.appointments = tables.appointments || []).push(row);
        return Promise.resolve({ data: JSON.parse(JSON.stringify(row)), error: null });
      }
      if (name === 'cancel_appointment') {
        if (scenario.cancelError) return Promise.resolve({ data: null, error: { message: scenario.cancelError } });
        var a = (tables.appointments || []).find(function (x) { return x.id === args.p_appointment_id; });
        if (!a || ['pending', 'confirmed'].indexOf(a.status) === -1) return Promise.resolve({ data: null, error: { message: 'لا يمكن إلغاء موعد ليس بحالة مؤكَّدة' } });
        a.status = 'cancelled';
        return Promise.resolve({ data: JSON.parse(JSON.stringify(a)), error: null });
      }
      return Promise.resolve({ data: null, error: null });
    }

    var client = {
      auth: {
        getSession: function () { return Promise.resolve({ data: { session: { user: { id: 'auth-1' }, access_token: 'fake' } } }); },
        signOut: function () { return Promise.resolve({ error: null }); },
      },
      rpc: rpc,
      from: function (table) { return makeBuilder(table); },
    };
    window.__TEST__ = {
      getCalls: function (name) { return calls.filter(function (c) { return !name || c.name === name; }); },
      getQueries: function (table) { return queries.filter(function (q) { return q.table === table; }); },
      getTable: function (t) { return JSON.parse(JSON.stringify(tables[t] || [])); },
    };
    return client;
  }
  if (window.__NOJ_SCENARIO__) window.__NOJ_SUPABASE_CLIENT__ = buildFakeSupabase(window.__NOJ_SCENARIO__);
})();
