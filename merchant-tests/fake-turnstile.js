// NOJ — fake Cloudflare Turnstile widget for merchant.html Playwright tests.
// Real network to challenges.cloudflare.com is blocked in every test
// (page.route abort) — without this file, window.turnstile never exists, so
// merchant.html's own getTurnstileToken()-equivalent flow always times out
// and captchaToken is always null/undefined in every existing test. That is
// exactly how the live bug (captcha rejected despite Turnstile showing
// success) went untested: no test ever exercised a real CAPTCHA-accepting-a-
// token path, or a widget that completes BEFORE the user acts, at all.
//
// window.turnstile.render(el, {sitekey, callback, 'error-callback'}) here
// "verifies" after scenario.turnstileVerifyMs (default 30ms) and calls
// callback(token) with a fresh, unique token each time — including after
// .reset(id), simulating Managed mode's real async, re-verify-on-reset
// behavior. Driven entirely by window.__NOJ_SCENARIO__ (the same scenario
// object fake-supabase.js reads), so a single scenario controls both.
(function () {
  function buildFakeTurnstile(scenario) {
    var nextToken = 1;
    var nextWidgetId = 1;
    var widgets = {};
    var issuedTokens = [];
    var renderCount = 0;
    var verifyMs = scenario.turnstileVerifyMs == null ? 30 : scenario.turnstileVerifyMs;

    function scheduleVerify(id) {
      var w = widgets[id];
      if (!w) return;
      clearTimeout(w.timer);
      w.timer = setTimeout(function () {
        if (!widgets[id]) return; // removed meanwhile
        var token = 'tok-' + (nextToken++);
        issuedTokens.push(token);
        w.callback(token);
      }, verifyMs);
    }

    window.turnstile = {
      render: function (el, opts) {
        var id = nextWidgetId++;
        renderCount++;
        widgets[id] = { callback: opts.callback, errorCallback: opts['error-callback'] };
        scheduleVerify(id);
        return id;
      },
      remove: function (id) { delete widgets[id]; },
      reset: function (id) { scheduleVerify(id); },
    };

    window.__TEST_TURNSTILE__ = {
      getRenderCount: function () { return renderCount; },
      getIssuedTokens: function () { return issuedTokens.slice(); },
    };
  }

  if (window.__NOJ_SCENARIO__) buildFakeTurnstile(window.__NOJ_SCENARIO__);
})();
