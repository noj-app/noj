// NOJ — fake Supabase for index.html LOGIN tests. Models exactly the GoTrue
// rules the live incident depended on (no network):
//   - CAPTCHA (scenario.captchaEnabled): signInAnonymously and signInWithOtp
//     need a captchaToken, each token is accepted ONCE (400 captcha_failed on
//     a missing or already-used one). PUT /user (updateUser) checks no CAPTCHA.
//   - updateUser({phone}) on a phone another user already owns → 422 phone_exists.
//   - signInWithOtp({shouldCreateUser:false}) for an unknown phone → 422
//     otp_disabled "Signups not allowed for otp"; for a known one it sends an
//     'sms' code.
//   - verifyOtp must use the type the code was sent with ('sms' vs
//     'phone_change'), and phone_change needs the same session that asked for
//     it — otherwise "Token has expired or is invalid" / "User not found".
// The OTP is always 123456.
(function () {
  function build(scenario) {
    var users = scenario.users || {};          // '+9665…' → { id }
    var session = scenario.session || null;    // { user: { id, is_anonymous } }
    var usedCaptcha = {};
    var pending = null;                        // { phone, type, userId }
    var calls = [];
    var anonN = 0;
    function err(status, code, message) { return { data: { user: null, session: null }, error: { status: status, code: code, message: message } }; }
    function captchaOk(tok) {
      if (!scenario.captchaEnabled) return true;
      if (!tok || usedCaptcha[tok]) return false;
      usedCaptcha[tok] = true;
      return true;
    }
    var auth = {
      getSession: function () { return Promise.resolve({ data: { session: session } }); },
      signInAnonymously: function (args) {
        var tok = args && args.options && args.options.captchaToken;
        calls.push({ name: 'signInAnonymously', captchaToken: tok });
        if (!captchaOk(tok)) return Promise.resolve(err(400, 'captcha_failed', 'captcha protection: request disallowed (invalid-input-response)'));
        session = { user: { id: 'anon-' + (++anonN), is_anonymous: true }, access_token: 'a' };
        return Promise.resolve({ data: { session: session, user: session.user }, error: null });
      },
      signInWithOtp: function (args) {
        var o = args.options || {};
        calls.push({ name: 'signInWithOtp', phone: args.phone, shouldCreateUser: o.shouldCreateUser, captchaToken: o.captchaToken });
        if (!captchaOk(o.captchaToken)) return Promise.resolve(err(400, 'captcha_failed', 'captcha protection: request disallowed (invalid-input-response)'));
        if (!users[args.phone]) {
          if (o.shouldCreateUser === false) return Promise.resolve(err(422, 'otp_disabled', 'Signups not allowed for otp'));
          users[args.phone] = { id: 'user-new-' + args.phone.slice(-4) };
        }
        pending = { phone: args.phone, type: 'sms' };
        return Promise.resolve({ data: { user: null, session: null }, error: null });
      },
      updateUser: function (attrs, opts) {
        calls.push({ name: 'updateUser', phone: attrs.phone, captchaToken: opts && opts.captchaToken });
        if (!session) return Promise.resolve(err(401, 'no_authorization', 'no session'));
        var owner = users[attrs.phone];
        if (owner && owner.id !== session.user.id) return Promise.resolve(err(422, 'phone_exists', 'A user with this phone number has already been registered'));
        pending = { phone: attrs.phone, type: 'phone_change', userId: session.user.id };
        return Promise.resolve({ data: { user: session.user }, error: null });
      },
      verifyOtp: function (args) {
        calls.push({ name: 'verifyOtp', phone: args.phone, type: args.type, token: args.token });
        if (!pending || pending.phone !== args.phone || args.token !== '123456') return Promise.resolve(err(403, 'otp_expired', 'Token has expired or is invalid'));
        if (pending.type !== args.type) return Promise.resolve(err(403, 'otp_expired', 'Token has expired or is invalid'));
        if (pending.type === 'phone_change') {
          if (!session || session.user.id !== pending.userId) return Promise.resolve(err(404, 'user_not_found', 'User not found'));
          users[args.phone] = { id: session.user.id };
          session = { user: { id: session.user.id, is_anonymous: false, phone: args.phone }, access_token: 'b' };
        } else {
          session = { user: { id: users[args.phone].id, is_anonymous: false, phone: args.phone }, access_token: 'c' };
        }
        pending = null;
        return Promise.resolve({ data: { session: session, user: session.user }, error: null });
      },
      signOut: function () { session = null; return Promise.resolve({ error: null }); },
    };
    function builder(table) {
      var b = {
        select: function () { return b; }, eq: function () { return b; }, in: function () { return b; }, gte: function () { return b; },
        is: function () { return b; }, or: function () { return b; }, order: function () { return b; }, limit: function () { return b; },
        then: function (res, rej) {
          var data = table === 'profile_consents' ? [{ id: 'pc-1' }] : [];
          return Promise.resolve({ data: data, error: null }).then(res, rej);
        },
      };
      return b;
    }
    function rpc(name) {
      calls.push({ name: 'rpc:' + name, sessionUser: session && session.user.id });
      if (name === 'claim_or_create_verified_profile') {
        if (!session || session.user.is_anonymous) return Promise.resolve({ data: null, error: { message: 'NOJ_PHONE_NOT_VERIFIED' } });
        return Promise.resolve({ data: { id: 'profile-' + session.user.id, name: 'عميل', phone: session.user.phone, tier: 'برونزي' }, error: null });
      }
      return Promise.resolve({ data: null, error: null });
    }
    window.__TEST__ = {
      getCalls: function () { return JSON.parse(JSON.stringify(calls)); },
      getSessionUser: function () { return session && session.user; },
    };
    return { auth: auth, rpc: rpc, from: builder };
  }
  if (window.__NOJ_SCENARIO__) window.__NOJ_SUPABASE_CLIENT__ = build(window.__NOJ_SCENARIO__);
})();
