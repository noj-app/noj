// NOJ — fake Cloudflare Turnstile for index.html auth tests (same model as
// merchant-tests/fake-turnstile.js): render() "verifies" after
// scenario.turnstileVerifyMs (default 30ms) and hands a NEW unique token to the
// callback, and so does reset(). scenario.turnstileRepeatAfterReset = true makes
// reset() hand back the SAME token again — the page must never send it twice.
(function () {
  function build(scenario) {
    var next = 1, nextId = 1, widgets = {}, issued = [], renders = 0;
    var verifyMs = scenario.turnstileVerifyMs == null ? 30 : scenario.turnstileVerifyMs;
    function verify(id, repeat) {
      var w = widgets[id];
      if (!w) return;
      clearTimeout(w.timer);
      w.timer = setTimeout(function () {
        if (!widgets[id]) return;
        var token = (repeat && w.last) ? w.last : 'tok-' + (next++);
        w.last = token;
        issued.push(token);
        w.callback(token);
      }, verifyMs);
    }
    window.turnstile = {
      render: function (el, opts) { var id = nextId++; renders++; widgets[id] = { callback: opts.callback }; verify(id, false); return id; },
      remove: function (id) { delete widgets[id]; },
      reset: function (id) { verify(id, !!scenario.turnstileRepeatAfterReset); },
    };
    window.__TEST_TURNSTILE__ = {
      getRenderCount: function () { return renders; },
      getIssuedTokens: function () { return issued.slice(); },
    };
  }
  if (window.__NOJ_SCENARIO__) build(window.__NOJ_SCENARIO__);
})();
