// Qwen mobile promo banner killer.
// The banner is rendered as
//   <div class="share-logo-content">     ← wrapper (height ~70px, top=0)
//     <div class="share-logo">
//       <div class="share-logo-mobile">  ← "Official App provided by Qwen"
//       <div class="share-logo-right">   ← "Download App" button
//
// Earlier selectors (#get-the-app etc.) were WRONG — those IDs only exist in
// a different code path (low-version-browser splash). The live banner uses
// stable BEM classes on divs with position:static, so position heuristics
// also wouldn't catch it. The CSS layer below is the primary defense; the
// MutationObserver re-injects the style if the page strips it, and prunes
// any late-inserted clones (e.g. the banner can re-appear after login or
// on route changes).

(function () {
  if (window.__qwenAppBannerKillerInstalled) return;
  window.__qwenAppBannerKillerInstalled = true;

  var TAG = '[QAB]';
  function log(m) { try { console.log(TAG + ' ' + m); } catch (_) {} }

  var SELECTORS = [
    '.share-logo-content',
    '.share-logo',
    '.share-logo-mobile',
    '.share-logo-right',
    '.share-logo-button'
  ];

  var STYLE_TEXT = SELECTORS.join(',') +
      '{display:none!important;visibility:hidden!important;height:0!important;' +
      'overflow:hidden!important;pointer-events:none!important}';
  var STYLE_ID = '__qwenAppBannerKillerStyle';

  function injectStyle(root) {
    var tgt = root || document.head || document.documentElement;
    if (!tgt) return false;
    if (tgt.__qabStyled) return true;
    var s = (tgt.ownerDocument || document).createElement('style');
    s.id = STYLE_ID;
    s.textContent = STYLE_TEXT;
    tgt.appendChild(s);
    tgt.__qabStyled = true;
    log('style injected in ' + (tgt === document.head ? '<head>' : tgt === document.documentElement ? '<html>' : 'shadow'));
    return true;
  }

  // Walk all open shadow roots and inject the style there too.
  function injectIntoShadowRoots() {
    var all = document.querySelectorAll('*');
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      if (el.shadowRoot && !el.shadowRoot.__qabStyled) injectStyle(el.shadowRoot);
    }
  }

  function pruneClones() {
    var n = 0;
    for (var i = 0; i < SELECTORS.length; i++) {
      var els = document.querySelectorAll(SELECTORS[i]);
      for (var j = 0; j < els.length; j++) {
        var el = els[j];
        // Only remove the wrapper itself (.share-logo-content) — children of
        // a display:none parent are already hidden, removing them is no-op.
        if (SELECTORS[i] === '.share-logo-content' && el.parentNode) {
          try { el.parentNode.removeChild(el); n++; } catch (_) {}
        }
      }
    }
    if (n > 0) log('pruned ' + n + ' banner element(s)');
    return n;
  }

  function sweep(reason) {
    try {
      injectStyle(document.head);
      injectStyle(document.documentElement);
      injectIntoShadowRoots();
      pruneClones();
    } catch (e) { log('sweep error: ' + e); }
  }

  // Hot loop for the first 10s (covers hydration + React re-mounts).
  var ticks = 0;
  var boot = setInterval(function () {
    ticks++;
    sweep('boot#' + ticks);
    if (ticks >= 200) clearInterval(boot);
  }, 50);

  // Long-lived MutationObserver for SPA re-renders.
  var mo;
  try {
    mo = new MutationObserver(function () { sweep('mutation'); });
    var attach = function () {
      if (document.documentElement) {
        try { mo.observe(document.documentElement, { childList: true, subtree: true }); }
        catch (e) { log('observe: ' + e); }
      } else {
        document.addEventListener('DOMContentLoaded', attach, { once: true });
      }
    };
    attach();
  } catch (e) { log('MutationObserver unavailable: ' + e); }

  // SPA navigation hooks.
  var _ps = history.pushState && history.pushState.bind(history);
  if (_ps) {
    history.pushState = function () {
      var r = _ps.apply(history, arguments);
      setTimeout(function () { sweep('pushState'); }, 0);
      setTimeout(function () { sweep('pushState+250ms'); }, 250);
      return r;
    };
  }
  window.addEventListener('popstate', function () {
    setTimeout(function () { sweep('popstate'); }, 0);
  });

  log('installed (class-selector based)');
})();
