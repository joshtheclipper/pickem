// Applies the player's color mode ('dark' | 'light' | 'system') before the
// page paints. Loaded synchronously in <head> on every page. The choice
// lives on the account (see /api/auth/theme); localStorage only remembers
// it on this device so there's no flash while /api/auth/me loads, and
// requireLogin() in api.js re-syncs it from the server.
(function () {
  var KEY = 'pickem-theme';
  var BARS = { dark: '#12171c', light: '#ffffff' };
  var mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: light)') : null;

  function resolve(pref) {
    if (pref === 'system') return mq && mq.matches ? 'light' : 'dark';
    return pref === 'light' ? 'light' : 'dark';
  }

  function paint(pref) {
    var mode = resolve(pref);
    document.documentElement.setAttribute('data-theme', mode);
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', BARS[mode]);
  }

  var pref = 'dark';
  try { pref = localStorage.getItem(KEY) || 'dark'; } catch (e) { /* storage blocked */ }

  window.pickemTheme = {
    pref: pref,
    set: function (p) {
      this.pref = p;
      try { localStorage.setItem(KEY, p); } catch (e) { /* storage blocked */ }
      paint(p);
    },
  };
  paint(pref);

  if (mq) {
    var onChange = function () { if (window.pickemTheme.pref === 'system') paint('system'); };
    if (mq.addEventListener) mq.addEventListener('change', onChange);
    else if (mq.addListener) mq.addListener(onChange);
  }
  // The <meta> tag sits after this script, so repaint once it's parsed.
  document.addEventListener('DOMContentLoaded', function () { paint(window.pickemTheme.pref); });
})();
