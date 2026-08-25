# Anti-Fingerprinting Strategies for Android WebView Wrappers

> **Status**: Reference document. Read-only — do not edit during forks.
> **Audience**: Developers building site-specific WebView wrapper apps derived from testAssist.
> **Scope**: Android WebView (Chromium) on API 21+, with `androidx.webkit:webkit:1.12.1+`.
> **Last updated**: 2026-08-03

This document catalogs the techniques, limitations, and trade-offs involved in
spoofing browser fingerprint signals from inside an Android WebView wrapper. It
is the distilled result of empirical testing on browserleaks.com, source
analysis of creepjs (`src/lies/index.ts`, 953 lines) and fingerprintjs, and
study of the reference implementation `deafenken/notme`.

---

## 1. The two injection surfaces

WebView offers two fundamentally different ways to run hardening JavaScript:

| Surface | Timing | Frame coverage | API |
|---|---|---|---|
| `view.loadUrl("javascript:…")` in `WebViewClient` callbacks | After page load (`onPageStarted`, `onPageCommitVisible`, `onPageFinished`) | Main frame only | `android.webkit.WebView` |
| `WebViewCompat.addDocumentStartJavaScript(view, script, originRules)` | `document_start` — before any page script | All frames whose origin matches `originRules` (including `about:blank`) | `androidx.webkit.WebViewCompat` |

### When to use which

- **`loadUrl`**: Safe, well-understood, runs late. Good for tasteful post-load
  hardening that does not need to beat page scripts to the punch. Does **not**
  cover iframes. Does **not** cover `about:blank` documents. Never crashes the
  WebView's internal selection/search controllers because it never runs in the
  transient documents those controllers create.
- **`addDocumentStartJavaScript`**: Powerful — runs before page scripts, covers
  child frames. But it also runs in **every** document, including the transient
  `about:blank` that Chromium creates when inflating a text-selection
  `ActionMode`. Mutating shared native prototypes (`Date.prototype.constructor`,
  `Intl.DateTimeFormat.prototype.constructor`) in that transient document can
  corrupt V8 native-context state and crash the app with
  `Resources$NotFoundException` in `DeviceFormFactor` /
  `SelectionPopupControllerImpl`. See §3 for the guard.

### Recommended hybrid

Use `addDocumentStartJavaScript` for coverage, but put an early-out guard at the
top of each injected script (§3). This preserves the document_start timing for
real pages while leaving the transient selection document untouched.

---

## 2. The iframe.contentWindow problem

### Why `addDocumentStartJavaScript` alone is not enough

A fingerprinting page can create an iframe with `sandbox="allow-same-origin"`
(no `allow-scripts`) and `src=""` (about:blank). Example — browserleaks.com:

```html
<iframe id="sandboxed" sandbox="allow-same-origin" style="display:none"></iframe>
```

When the user clicks "iframe.contentWindow", browserleaks reads:

```js
const t = document.getElementById('sandboxed').contentWindow;
const b = 'iframe' == e && M(t) ? t : window;
const s = b.screen, c = b.navigator, i = new b.Date;
```

Because `sandbox` lacks `allow-scripts`, **no script runs inside the iframe** —
neither `addDocumentStartJavaScript` nor anything else. The `contentWindow` is
still accessible to the parent (same origin via `allow-same-origin`), so the
page reads the pristine native values: real `hardwareConcurrency`, real
`deviceMemory`, real `Date.getTimezoneOffset()`, real
`Intl.DateTimeFormat().resolvedOptions().timeZone`.

### The `HTMLIFrameElement.prototype.contentWindow` getter hook

The robust fix is to monkey-patch the `contentWindow` getter on
`HTMLIFrameElement.prototype` so that every access returns a `contentWindow`
whose native surfaces have been overridden by the parent's spoofed versions.

Empirically validated on browserleaks.com (Debian Chromium 150):

```js
// Inside hardening.js, after the main overrides:
(function patchIframeContentWindow() {
  const desc = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'contentWindow');
  if (!desc || !desc.get || desc.get.__ta_patch) return;
  const realGet = desc.get;

  function applyOverrides(cw) {
    if (!cw || cw.__ta_patched) return;
    try {
      // navigator props
      Object.defineProperty(cw.navigator, 'hardwareConcurrency', { get: () => 4, configurable: true });
      Object.defineProperty(cw.navigator, 'deviceMemory', { get: () => 4, configurable: true });
    } catch (_) {}
    // Date — delegate to parent's overridden Date so prototype methods see our spoof
    try {
      const PD = window.Date;
      const newD = function Date(...args) {
        if (new.target) return Reflect.construct(PD, args, new.target);
        return PD(...args);
      };
      newD.prototype = PD.prototype; newD.now = PD.now; newD.UTC = PD.UTC; newD.parse = PD.parse;
      Object.defineProperty(cw, 'Date', { value: newD, configurable: true, writable: true });
    } catch (_) {}
    // Intl.DateTimeFormat — same delegation pattern
    try {
      const PDTF = Intl.DateTimeFormat;
      const newDTF = function DateTimeFormat(...args) {
        if (new.target) return Reflect.construct(PDTF, args, new.target);
        return PDTF(...args);
      };
      newDTF.prototype = PDTF.prototype;
      if (PDTF.supportedLocalesOf) newDTF.supportedLocalesOf = PDTF.supportedLocalesOf.bind(PDTF);
      Object.defineProperty(cw.Intl, 'DateTimeFormat', { value: newDTF, configurable: true, writable: true });
    } catch (_) {}
    // WebRTC
    try {
      if (S.webrtcBlocked) {
        cw.RTCPeerConnection = function () { throw new Error('WebRTC disabled'); };
      }
    } catch (_) {}
    try { Object.defineProperty(cw, '__ta_patched', { value: true, configurable: true }); } catch (_) {}
  }

  const patched = function contentWindow() {
    const cw = realGet.call(this);
    if (cw) try { applyOverrides(cw); } catch (_) {}
    return cw;
  };
  try { Object.defineProperty(patched, '__ta_patch', { value: true }); } catch (_) {}
  Object.defineProperty(HTMLIFrameElement.prototype, 'contentWindow', {
    configurable: true,
    get: patched,
  });
})();
```

### Why this works

- `new cw.Date()` calls our wrapper, which `Reflect.construct`s the parent's
  (already-overridden) `Date`. The resulting instance has the parent's
  `Date.prototype`, so `getTimezoneOffset()`, `getHours()`, `toString()`,
  `toLocaleString()` all return spoofed values.
- `cw.navigator.hardwareConcurrency` reads the getter we installed on
  `cw.navigator`.
- `cw.Intl.DateTimeFormat().resolvedOptions().timeZone` returns the spoofed
  timezone because the wrapper delegates to the parent's wrapped `Intl`.
- Works even on dynamically-created iframes — every `iframe.contentWindow`
  access re-applies the overrides.

### Known limitations of this hook

1. **Cross-origin iframes** — `contentWindow` access from the parent is
   blocked by the Same-Origin Policy. The getter throws or returns null;
   `applyOverrides` is never called. For cross-origin iframes, the only
   coverage is `addDocumentStartJavaScript` injecting inside the iframe (which
   works, since the iframe's own scripts run in that realm and see the
   overrides on their own `window`).
2. **Sandboxed iframes without `allow-same-origin`** — Same story: parent
   can't touch `contentWindow`. Falls back to in-iframe injection.
3. **CreepJS detects this hook** — see §5. The hook changes the shape of
   `HTMLIFrameElement.prototype.contentWindow` and `Function.prototype.toString`
   returns a non-native string. CreepJS catches this and flags it as a lie.
   FingerprintJS does not.
4. **Workers** — `Worker` scopes have their own `navigator`. The `contentWindow`
   hook does not cover them. See §6.

---

## 3. The `about:blank` guard (text-selection crash fix)

`addDocumentStartJavaScript` runs in **every** document, including the
transient `about:blank` Chromium creates when inflating a text-selection
`ActionMode`. Scripts that rewrite native prototype constructors
(`Date.prototype.constructor`, `Intl.DateTimeFormat.prototype.constructor`)
corrupt V8 native-context state shared across realms, crashing
`SelectionPopupControllerImpl` → `DeviceFormFactor` with
`Resources$NotFoundException`.

### Guard (add at the top of each injected IIFE)

```js
// --- BEGIN GUARD: skip on about:blank / initial empty documents ---
// addDocumentStartJavaScript runs on EVERY document including the transient
// about:blank the WebView creates when building a text-selection ActionMode.
// Mutating Date/Intl native prototypes there corrupts shared native state
// the selection controller relies on. Bail before any rewrite.
try {
  var loc = location && location.href ? location.href : '';
  if (loc === 'about:blank' || loc === '' || loc === 'about:srcdoc') return;
  if (typeof document !== 'undefined' && document.URL &&
      (document.URL === 'about:blank' || document.URL === '')) return;
} catch (_) {}
// --- END GUARD ---
```

Place this after reading `window.__TA_SETTINGS__` but before any prototype
mutation. The real page (`https://chat.tinfoil.sh/…`) still gets the full
hardening; the transient selection document is left untouched.

### Belt-and-suspenders

If the guard alone does not resolve the crash, also downgrade the `constructor`
rewrites on `tzspoof.js` lines 308-311 and 325-327:

```js
// before:
Object.defineProperty(RealDate.prototype, 'constructor', { value: DateProxy, configurable: true, writable: true });
// after (less destructive):
Object.defineProperty(RealDate.prototype, 'constructor', { value: DateProxy, configurable: false, writable: false });
```

Prefer the guard first; only add this if the crash persists.

---

## 4. Worker scope coverage

CreepJS creates a dedicated `Worker` and compares `navigator.hardwareConcurrency`
and `navigator.deviceMemory` between the main thread and the worker. If the
override is only on the main `window`, the values diverge and `lied=true`.

### How to cover workers

`addDocumentStartJavaScript` does **not** inject into `Worker` scopes. Options:

1. **Patch `Worker` constructor** to inject overrides into the worker's script:
   ```js
   const RealWorker = Worker;
   Worker = function Worker(url, options) {
     // Prepend the hardening + tzspoof source to the worker's script
     // (only works for same-origin classic scripts; module workers and
     // cross-origin workers need a different approach — see notme content-inject.js lines 756-795)
     ...
     return Reflect.construct(RealWorker, [wrappedUrl, options], new.target);
   };
   Worker.prototype = RealWorker.prototype;
   ```
   The `notme` repo performs this in `content-inject.js` `installWorkerPatch`.
   Porting it is non-trivial.

2. **Accept the divergence** — fingerprintjs does not detect it; creepjs does
   but the impact is a `lies` flag, not a fingerprint leak. If your target
   site doesn't use creepjs-style worker consistency checks, you may skip this.

---

## 5. CreepJS "lies" detection — what it checks and how to defeat it

CreepJS (`src/lies/index.ts`, 953 lines) runs a `queryLies` battery of ~15
verifications per API on the `PHANTOM_DARKNESS` iframe window. Any one failure
marks the API as "lied".

### The 15 verifications

For each target API function `apiFunction` on a prototype (`Date.prototype.getTimezoneOffset`, `Navigator.prototype.hardwareConcurrency`, `HTMLIFrameElement.prototype.contentWindow` getter, etc.):

1. **`failed toString`** — `Function.prototype.toString.call(apiFn)` does not match one of:
   - `function NAME() { [native code] }`
   - `function get NAME() { [native code] }`
   - `function () { [native code] }`
   - (plus multiline newline variants of each)
2. **`failed toString.toString`** — same `toString` check on `apiFn.toString` itself.
3. **`failed illegal error`** — `obj.prototype[name]` accessed as a value should throw `TypeError` for getters.
4. **`failed call/apply/new instance interface error`** — `apiFn.call(proto)` / `apiFn.apply(proto)` / `new apiFn()` should throw in some cases.
5. **`failed class extends error`** — `class Fake extends apiFn {}` should throw on non-WebKit.
6. **`failed null conversion error`** — `Object.setPrototypeOf(apiFn, null).toString()`.
7. **`failed object toString error`** — `Object.create(apiFn).toString()` and `Object.create(new Proxy(apiFn, {})).toString()` with stack frame inspection.
8. **`failed at incompatible proxy error`** — `apiFn.arguments; apiFn.caller` (Gecko strict mode).
9. **`failed at toString incompatible proxy error`** — same for `apiFn.toString.arguments/caller`.
10. **`failed at too much recursion error`** — `Object.setPrototypeOf(apiFn, Object.create(apiFn)).toString()`.
11. **`failed "prototype" in function`** — `'prototype' in apiFn` (native getters don't expose `prototype`).
12. **`failed descriptor`** — `getOwnPropertyDescriptor(apiFn, 'arguments' | 'caller' | 'prototype' | 'toString')` is truthy.
13. **`failed own property`** — `apiFn.hasOwnProperty('arguments' | 'caller' | 'prototype' | 'toString')`.
14. **`failed descriptor keys`** — `Object.keys(Object.getOwnPropertyDescriptors(apiFn)).sort() !== 'length,name'`.
15. **`failed own property names`** — `Object.getOwnPropertyNames(apiFn).sort() !== 'length,name'`.

Plus Proxy-specific checks (chain cycle, reflect set proto, instanceof) when
`toString` is the target or when other lies are already detected.

### What it takes to pass

An override function must simultaneously:

- Return `[native code]` from `Function.prototype.toString.call(fn)`.
- Have own-property names exactly `['length', 'name']` — no `arguments`,
  `caller`, `prototype`, `toString`.
- Throw the right `TypeError`s in the right contexts (illegal invocation,
  null receiver, strict-mode `arguments`/`caller` access).
- Not leave Proxy footprints (chain cycle, set proto, instanceof).

This is exactly what `notme`'s `makeMethod()` + `finishCtor()` +
`spoofedNames` Map + `Function.prototype.toString` patch achieve. Porting those
from `notme/content-inject.js` lines 113-160 is the proven path.

### APIs creepjs verifies (target list)

`Date` (all local getters/setters/toString/toLocale*), `Intl.DateTimeFormat`
(format, formatRange, formatToParts, resolvedOptions), `Intl.RelativeTimeFormat`,
`Navigator` (~28 props including hardwareConcurrency, deviceMemory, userAgent,
platform, vendor, language, languages, maxTouchPoints, appVersion, oscpu,
buildID, plugins, mimeTypes, webdriver), `Math` (18 trig functions),
`Screen` (all props), `HTMLCanvasElement`, `HTMLElement` (client/offset/scroll
dimensions), `HTMLIFrameElement` (contentDocument, contentWindow),
`CanvasRenderingContext2D` (getImageData, fillText, measureText, etc.),
`WebGLRenderingContext` / `WebGL2RenderingContext` (bufferData, getParameter,
readPixels), `MediaDevices` (enumerateDevices, getDisplayMedia, getUserMedia),
`Permissions` (query), `AnalyserNode`, `AudioBuffer`, `BiquadFilterNode`,
`Document`, `Element`, `Node`, `FontFace`, `CSSStyleDeclaration`,
`DOMRect`, `Range`, `IntersectionObserverEntry`, `OffscreenCanvas`,
`StorageManager`, `SVGRect`, `SVGTextContentElement`, `TextMetrics`,
`speechSynthesis`, `String.fromCodePoint`, `GPU`/`GPUAdapter`.

### Hashes (resistance module)

`src/resistance/index.ts` computes `hashMini(prototypeLies['HTMLIFrameElement.contentWindow'])`
and matches against known extension signatures (Trace, CyDec, CanvasBlocker,
NoScript, JShelter, Puppeteer-extra, etc.). Even if you bypass all 15 lies
checks, an unusual hash may still mark you as "unknown wrapper".

---

## 6. FingerprintJS — what it does and does not detect

FingerprintJS is a **hasher**, not a **detector**. It reads component values and
hashes them into a `visitorId`. It does not flag overrides.

### iframe usage

FingerprintJS uses `withIframe()` (`src/utils/dom.ts`) **only** for isolated
DOM measurement (font widths, font preferences on Android Chrome/Firefox).
It does **not** compare `iframe.contentWindow` values against the main window
to detect overrides. A faked `contentWindow` would simply produce slightly
different (but stable) font measurements — folded into the hash without
comment.

### What it reads (main scope)

All `src/sources/*` — timezone, hardwareConcurrency, deviceMemory,
screen_resolution, screen_frame, audio (OfflineAudioContext), canvas, webgl,
color preferences, math (same 18 trig), touch support, plugins, vendor,
userAgentData, sessionStorage/localStorage/indexedDB, cookiesEnabled,
languages, osCpu, cpuClass, platform, applePay, audioBaseLatency,
dateTimeLocale, pdfViewerEnabled, architecture.

### Practical implication

A WebView wrapper that returns plausible, **consistent** values (even if
false) will produce a stable visitor id with no "lied" flag. The only failure
mode is returning invalid values (e.g. `Intl.DateTimeFormat().resolvedOptions().timeZone`
returning a non-IANA string), which destabilizes the hash.

---

## 7. Summary: coverage matrix

| Technique | browserleaks iframe | creepJS lies | creepJS worker consistency | fingerprintJS | Cross-origin iframe |
|---|---|---|---|---|---|
| `addDocumentStartJavaScript` only | ❌ Misses sandboxed iframes | ⚠️ Detects overrides unless notme-style makeMethod ported | ❌ Doesn't inject into Worker | ✅ Passes (stable values) | ✅ Injects in all frames |
| `addDocumentStartJavaScript` + `contentWindow` hook | ✅ Covers sandboxed same-origin | ⚠️ Still detected unless toString spoofed | ❌ Same | ✅ | ⚠️ Cross-origin iframes rely on in-frame injection only |
| Full notme port (makeMethod + Worker patch + toString spoof) | ✅ | ✅ Likely passes | ✅ | ✅ | ✅ |
| `loadUrl("javascript:…")` post-load (v1.3.1 approach) | ❌ | ⚠️ Detected | ❌ | ✅ | ❌ Main frame only |

---

## 8. Fork decision guide

If you're forking testAssist for a specific site, pick the layer of cover you
need:

### Minimal (most sites, including Tinfoil-like chat wrappers)
- `addDocumentStartJavaScript` with the `about:blank` guard (§3).
- Main-window overrides: `navigator.hardwareConcurrency`,
  `navigator.deviceMemory`, `Date` surface, `Intl.DateTimeFormat`,
  `WebGLRenderingContext.getParameter` (GPU), `RTCPeerConnection`
  (if site doesn't need WebRTC), Battery API, sensors, geolocation.
- This defeats browserleaks main-window tests, fingerprintjs, and most
  heuristic fingerprinting.

### Medium (sites that test iframe.contentWindow like browserleaks)
- Add the `HTMLIFrameElement.prototype.contentWindow` getter hook (§2).
- Cover `navigator`, `Date`, `Intl.DateTimeFormat`, `RTCPeerConnection` on
  the returned `contentWindow`.

### Maximum (anti-detection against creepjs-level adversaries)
- Port `makeMethod()`, `finishCtor()`, `spoofedNames` Map, and
  `Function.prototype.toString` patch from `notme/content-inject.js` (lines
  113-160, 384-403).
- Port the `Worker` constructor patch (`notme/content-inject.js` lines
  756-795) to cover worker scopes.
- Apply the same overrides in `iframe.contentWindow` *and* `Worker` realms,
  not just the main window.

---

## 9. References

- `deafenken/notme` — `content-inject.js` (MAIN-world injector, 837 lines),
  `lib/timezone.js` (IANA DST helpers), `lib/tzdata.js`. The reference
  implementation. https://github.com/deafenken/notme
- `AbrahamJuliot/creepjs` — `src/lies/index.ts` (953 lines, lies detector),
  `src/navigator/index.ts` (worker consistency), `src/timezone/index.ts`
  (offset history + IANA binary search), `src/resistance/index.ts`
  (extension hash signatures). https://github.com/AbrahamJuliot/creepjs
- `fingerprintjs/fingerprintjs` — `src/utils/dom.ts` (`withIframe`),
  `src/sources/*` (entropy sources). https://github.com/fingerprintjs/fingerprintjs
- browserleaks.com/javascript — empirical test case for `iframe.contentWindow`
  leaks. The `#sandboxed` iframe is `sandbox="allow-same-origin"` with
  `src=""`. Reads `b.navigator`, `b.Date`, `b.Intl.DateTimeFormat`, `b.screen`,
  `b.AudioContext`, `b.speechSynthesis`, `b.innerWidth/Height`.
