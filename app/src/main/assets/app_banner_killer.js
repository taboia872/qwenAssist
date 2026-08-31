// Qwen app-promo banner killer — aggressive version.
// Strategy:
//   1. Inject a <style> with display:none !important on the stable IDs we
//      already know about (works even if page JS toggles inline display).
//   2. MutationObserver on <html>: for every added node, scan for any element
//      whose text matches the banner copy ("Official App provided by Qwen",
//      "Get the App", ...) and that has a small rectangular accessible
//      bounding box. Walk up to the outermost fixed/sticky/top-of-viewport
//      ancestor (the actual bar) and remove it.
//   3. Same logic runs via a pushState hook for SPA navigations.
//   4. If the banner lives inside an open ShadowRoot, injectStyle walks
//      into child shadow hosts so the !important rule applies there too.
//      (Closed shadow roots cannot be pierced from JS — if the banner is
//      closed-shadow, only removal of the host element itself will work,
//      which is covered by ancestor-climb removing the host.)
//
// PID-prefix "QAB" on every console tag for logcat diagnosis:
//   adb logcat -s qwenAssist:I QAB:D

(function () {
  if (window.__qwenAppBannerKillerInstalled) return;
  window.__qwenAppBannerKillerInstalled = true;

  var TAG = '[QAB]';
  function log(msg) { try { console.log(TAG + ' ' + msg); } catch (_) {} }

  // Stable IDs confirmed from the static page shell.
  var KNOWN_IDS = ['get-the-app', 'downLoad_app', 'low-version-browser'];

  // Text patterns that appear in the promo banner. Keep them tight so we
  // don't match random blog copy.
  var TEXT_PATTERNS = [
    'official app provided by qwen',
    'official app',
    'aplicativo oficial',
    'fornecido por qwen',
    'provided by qwen',
    'get the app',
    'download the app',
    'baixe o app',
    'baixar o app',
    'baixar o aplicativo'
  ];

  //style> covering known IDs; survives inline display toggles by page JS.
  var STYLE_TEXT =
    '#get-the-app,#downLoad_app,#low-version-browser{display:none!important;' +
    'visibility:hidden!important;height:0!important;overflow:hidden!important;' +
    'pointer-events:none!important}';
  var STYLE_EL_ID = '__qwenAppBannerKillerStyle';

  function injectStyle(target) {
    var root = target || document.head || document.documentElement;
    if (!root) return false;
    // In shadow roots, getElementById on host document won't find this style.
    // Mark on the root itself to avoid duplicates.
    if (root.__qwenAppBannerKillerStyled) return true;
    var s = (root.ownerDocument || document).createElement('style');
    s.id = STYLE_EL_ID;
    s.textContent = STYLE_TEXT;
    root.appendChild(s);
    root.__qwenAppBannerKillerStyled = true;
    log('style injected into ' +
        (root === document.head ? '<head>' :
         root === document.documentElement ? '<html>' :
         (root.host ? 'shadowRoot under <' + root.host.tagName + '>' : 'unknown')));
    return true;
  }

  // Walk all shadow roots currently in the tree and inject the style there too.
  function injectIntoShadowRoots() {
    var all = document.querySelectorAll('*');
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      if (el.shadowRoot) injectStyle(el.shadowRoot);
    }
  }

  // Match: text content looks like promo.
  function matchesPromoText(txt) {
    if (!txt) return false;
    var t = txt.toLowerCase();
    // Length cap: skip elements that contain the whole page text — we want
    // small banner-sized containers.
    if (t.length > 400) return false;
    for (var i = 0; i < TEXT_PATTERNS.length; i++) {
      if (t.indexOf(TEXT_PATTERNS[i]) !== -1) return true;
    }
    return false;
  }

  // Heuristic: an element "looks like a bar" if it's compact and either
  // fixed/sticky positioned or sits at the very top of the viewport.
  function looksLikeBar(el) {
    if (!el || el.nodeType !== 1) return false;
    // Skip the whole body / documentElement — they often contain everything.
    if (el === document.body || el === document.documentElement) return false;
    var r;
    try { r = el.getBoundingClientRect(); } catch (_) { return false; }
    if (!r || r.height === 0) return false;
    if (r.height > 200) return false;             // bars are small
    if (r.width < window.innerWidth * 0.6) return false; // and wide-ish
    var cs;
    try { cs = window.getComputedStyle(el); } catch (_) { return false; }
    var pos = (cs && cs.position) || '';
    var isFixedOrSticky = (pos === 'fixed' || pos === 'sticky');
    var isAtTop = (r.top >= 0 && r.top < 140);
    return isFixedOrSticky || isAtTop;
  }

  // Climb ancestors until the outermost "bar-like" container is found.
  // Cap at 8 levels to avoid walking to <body>.
  function outermostBar(el) {
    var cur = el;
    var best = null;
    for (var depth = 0; cur && cur !== document.body && depth < 8;
         cur = cur.parentElement, depth++) {
      if (looksLikeBar(cur)) best = cur;
      else if (best) break; // stop climbing once we leave the bar region
    }
    return best || (looksLikeBar(el) ? el : null);
  }

  function pruneById() {
    var removed = 0;
    for (var i = 0; i < KNOWN_IDS.length; i++) {
      var el = document.getElementById(KNOWN_IDS[i]);
      if (el && el.parentNode) { el.parentNode.removeChild(el); removed++; }
    }
    if (removed) log('pruned ' + removed + ' known-ID elements');
    return removed;
  }

  function pruneByText() {
    var removed = 0;
    // Scan visible text-bearing elements; skip huge subtrees by stopping
    // at elements whose innerText exceeds the cap (their innerText returns
    // concatenated text of all descendants).
    var stack = [document.body];
    var visited = 0;
    while (stack.length && visited < 4000) {
      var node = stack.pop();
      if (!node) continue;
      visited++;
      if (node.nodeType === 3) { // text node — use parent
        node = node.parentNode;
        if (!node) continue;
      }
      if (node.nodeType !== 1) continue;
      var el = node;
      var txt;
      try { txt = el.innerText || ''; } catch (_) { txt = ''; }
      if (!matchesPromoText(txt)) {
        // Recurse only if we haven't exceeded the text budget; if txt is
        // short yet doesn't match, children won't match either (parent
        // concatenates child text), so we can skip. But be safe: recursing
        // on small children is cheap.
        for (var c = el.firstElementChild; c; c = c.nextElementSibling) {
          stack.push(c);
        }
        continue;
      }
      // We've got a hit: find outermost bar ancestor and remove it.
      var victim = outermostBar(el);
      if (victim && victim.parentNode) {
        var descr = victim.tagName +
          (victim.id ? '#' + victim.id : '') +
          (victim.className && typeof victim.className === 'string'
            ? '.' + String(victim.className).split(/\s+/).slice(0,3).join('.') : '');
        try { victim.parentNode.removeChild(victim); removed++;
          log('removed banner: ' + descr);
        } catch (_) {}
        // Don't push children of an element we just removed.
        continue;
      }
      // No outermost bar — maybe the element itself *is* the bar but didn't
      // pass looksLikeBar (e.g. unusual CSS). Only remove if it's small on
      // its own; otherwise leave it (safer than nuking legitimate content).
      var rect;
      try { rect = el.getBoundingClientRect(); } catch (_) { rect = null; }
      if (rect && rect.height > 0 && rect.height < 200 && el.parentNode) {
        try { el.parentNode.removeChild(el); removed++;
          log('removed (no-ancestor path): ' + el.tagName +
              (el.id ? '#' + el.id : ''));
        } catch (_) {}
      }
    }
    return removed;
  }

  // One full pass. Idempotent.
  function prune(reason) {
    try {
      injectStyle(document.head);
      injectStyle(document.documentElement);
      injectIntoShadowRoots();
      var n = pruneById() + pruneByText();
      if (n > 0) log('prune(' + reason + ') removed ' + n + ' element(s)');
      return n;
    } catch (e) {
      log('prune error: ' + e);
      return 0;
    }
  }

  // Boot: run repeatedly for the first ~10s while the SPA hydrates.
  var bootAttempts = 0;
  var boot = setInterval(function () {
    bootAttempts++;
    prune('boot#' + bootAttempts);
    if (bootAttempts >= 200) clearInterval(boot); // 100 x 50ms = 10s
  }, 50);

  // MutationObserver for the whole document lifetime.
  var mo;
  try {
    mo = new MutationObserver(function (muts) {
      // Coalesce rapid bursts; still run because the cost is bounded by the
      // visited-node cap inside pruneByText.
      prune('mutation');
    });
  } catch (e) {
    log('MutationObserver unavailable: ' + e);
    return;
  }
  function attach() {
    if (document.documentElement) {
      try {
        mo.observe(document.documentElement, {childList: true, subtree: true});
      } catch (e) {
        log('observe error: ' + e);
      }
    } else {
      document.addEventListener('DOMContentLoaded', attach, {once: true});
    }
  }
  attach();

  // SPA navigation hooks (pushState + popstate).
  (function () {
    var _ps = history.pushState && history.pushState.bind(history);
    if (_ps) {
      history.pushState = function () {
        var r = _ps.apply(history, arguments);
        // Defer so the new view has a chance to insert its banner before we prune.
        setTimeout(function () { prune('pushState'); }, 0);
        setTimeout(function () { prune('pushState+250ms'); }, 250);
        return r;
      };
    }
    window.addEventListener('popstate', function () {
      setTimeout(function () { prune('popstate'); }, 0);
    });
  })();

  log('installed');
})();
