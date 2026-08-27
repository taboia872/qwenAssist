/* qwenAssist — hardening (non-TZ) injected at document_start.
 *
 * Covers: battery, device sensors, vibration, connection, geolocation, DNT,
 * hardwareConcurrency, deviceMemory, WebGL GPU spoof, WebRTC block. Reads
 * window.__TA_SETTINGS__ { sensorsBlocked, dntEnabled, webrtcBlocked } injected
 * by the Android host before this script runs and deletes it so the page can't
 * probe it. Settings are the single source of truth — toggles in the popup
 * re-inject this script with a fresh payload, no inline booleans here.
 */
(function () {
  'use strict';

  var S = window.__TA_SETTINGS__ || {};
  try { delete window.__TA_SETTINGS__; } catch (_) {}

  try {
    // Battery API
    if (navigator.getBattery) {
      navigator.getBattery = function () { return Promise.reject(new Error('Battery API disabled')); };
    }

    // DeviceOrientation / DeviceMotion — conditional on sensorsBlocked
    if (S.sensorsBlocked) {
      if (window.DeviceOrientationEvent) {
        DeviceOrientationEvent.prototype.addEventListener = function () {};
        DeviceOrientationEvent.prototype.dispatchEvent = function () { return false; };
        Object.defineProperty(window, 'DeviceOrientationEvent', { value: undefined, configurable: false, writable: false });
      }
      if (window.ondeviceorientation) window.ondeviceorientation = null;
      Object.defineProperty(window, 'ondeviceorientation', { get: function () { return null; }, set: function () {}, configurable: true });
      if (window.DeviceMotionEvent) {
        DeviceMotionEvent.prototype.addEventListener = function () {};
        DeviceMotionEvent.prototype.dispatchEvent = function () { return false; };
        Object.defineProperty(window, 'DeviceMotionEvent', { value: undefined, configurable: false, writable: false });
      }
      if (window.ondevicemotion) window.ondevicemotion = null;
      Object.defineProperty(window, 'ondevicemotion', { get: function () { return null; }, set: function () {}, configurable: true });
      var origAddEventListener = window.addEventListener.bind(window);
      window.addEventListener = function (type, listener, options) {
        if (type === 'deviceorientation' || type === 'devicemotion' || type === 'deviceorientationabsolute') return;
        return origAddEventListener(type, listener, options);
      };
    }

    // Vibration
    if (navigator.vibrate) navigator.vibrate = function () { return false; };

    // Network connection info
    if (navigator.connection) Object.defineProperty(navigator, 'connection', { value: undefined });

    // Geolocation — report as disabled
    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition = function (s, e) { if (e) e({ code: 1, message: 'Geolocation disabled' }); };
      navigator.geolocation.watchPosition = function () { return 0; };
    }

    // Do Not Track
    if (S.dntEnabled) {
      Object.defineProperty(navigator, 'doNotTrack', { get: function () { return '1'; }, configurable: true });
    }

    // CPU cores — spoof so the app doesn't leak the real SoC core count
    Object.defineProperty(navigator, 'hardwareConcurrency', {
      get: function () { return S.spoofCores || 4; }, configurable: true });
    // Device memory (GB)
    Object.defineProperty(navigator, 'deviceMemory', {
      get: function () { return S.spoofMemory || 4; }, configurable: true });

    // WebGL — spoof GPU vendor and renderer to keep the chipset private
    (function () {
      var vendor = String(S.spoofGpuVendor || 'Qualcomm');
      var renderer = String(S.spoofGpuRenderer || 'Adreno (TM) 650');
      var getParameter = WebGLRenderingContext.prototype.getParameter;
      WebGLRenderingContext.prototype.getParameter = function (param) {
        if (param === 37445) return vendor;
        if (param === 37446) return renderer;
        return getParameter.call(this, param);
      };
      if (window.WebGL2RenderingContext) {
        var getParameter2 = WebGL2RenderingContext.prototype.getParameter;
        WebGL2RenderingContext.prototype.getParameter = function (param) {
          if (param === 37445) return vendor;
          if (param === 37446) return renderer;
          return getParameter2.call(this, param);
        };
      }
    })();

    // WebRTC — if blocked, disable RTCPeerConnection entirely
    if (S.webrtcBlocked && window.RTCPeerConnection) {
      window.RTCPeerConnection = function () { throw new Error('WebRTC disabled'); };
    }

    // ─── iframe.contentWindow leak coverage ───────────────────────────────
    // Fingerprinting sites (browserleaks.com) create a sandboxed iframe:
    //   <iframe sandbox="allow-same-origin" src="" style="display:none">
    // Without allow-scripts, no script runs inside the iframe — not even
    // addDocumentStartJavaScript. But allow-same-origin lets the parent
    // access and modify contentWindow. browserleaks then reads:
    //   iframe.contentWindow.navigator.hardwareConcurrency  → real value
    //   new iframe.contentWindow.Date().getTimezoneOffset()  → real TZ
    //   iframe.contentWindow.Intl.DateTimeFormat().resolvedOptions().timeZone
    //
    // Fix: hook the HTMLIFrameElement.prototype.contentWindow getter so every
    // access returns a contentWindow with the parent's overrides applied.
    // Covers navigator, Date (delegated to parent's overridden DateProxy),
    // Intl.DateTimeFormat, and RTCPeerConnection. Works on dynamically
    // created iframes too. Validated on browserleaks.com.
    //
    // Limitations: cross-origin iframes (SOP blocks parent access) fall back
    // to addDocumentStartJavaScript in-frame injection. creepjs detects this
    // hook; fingerprintjs does not.
    (function patchIframeContentWindow() {
      var d = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'contentWindow');
      if (!d || !d.get || d.get.__ta_patch) return;
      var realGet = d.get;

      function applyOverrides(cw) {
        if (!cw || cw.__ta_patched) return;
        try {
          Object.defineProperty(cw.navigator, 'hardwareConcurrency',
            { get: function () { return S.spoofCores || 4; }, configurable: true });
          Object.defineProperty(cw.navigator, 'deviceMemory',
            { get: function () { return S.spoofMemory || 4; }, configurable: true });
        } catch (_) {}
        // Date — delegate to the parent's overridden Date so instances inherit
        // from parent.Date.prototype (which has getTimezoneOffset, getHours,
        // toString, toLocaleString, etc. all spoofed by tzspoof.js).
        // NB: simply patching cw.Date.prototype.getTimezoneOffset does NOT
        // work — new cw.Date() instances get the V8 intrinsic prototype, not
        // cw.Date.prototype. Replacing cw.Date itself is the only way.
        try {
          var PD = window.Date;
          var newD = function Date() {
            if (new.target) return Reflect.construct(PD, arguments, new.target);
            return PD.apply(null, arguments);
          };
          newD.prototype = PD.prototype;
          newD.now = PD.now; newD.UTC = PD.UTC; newD.parse = PD.parse;
          Object.defineProperty(cw, 'Date', { value: newD, configurable: true, writable: true });
        } catch (_) {}
        // Intl.DateTimeFormat — same delegation pattern
        try {
          var PDTF = Intl.DateTimeFormat;
          var newDTF = function DateTimeFormat() {
            if (new.target) return Reflect.construct(PDTF, arguments, new.target);
            return PDTF.apply(null, arguments);
          };
          newDTF.prototype = PDTF.prototype;
          if (PDTF.supportedLocalesOf) newDTF.supportedLocalesOf = PDTF.supportedLocalesOf.bind(PDTF);
          Object.defineProperty(cw.Intl, 'DateTimeFormat',
            { value: newDTF, configurable: true, writable: true });
        } catch (_) {}
        // WebRTC — if blocked in parent, block in iframe too
        try {
          if (S.webrtcBlocked && cw.RTCPeerConnection) {
            cw.RTCPeerConnection = function () { throw new Error('WebRTC disabled'); };
          }
        } catch (_) {}
        try { Object.defineProperty(cw, '__ta_patched', { value: true, configurable: true }); } catch (_) {}
      }

      var patched = function contentWindow() {
        var cw = realGet.call(this);
        if (cw) try { applyOverrides(cw); } catch (_) {}
        return cw;
      };
      try { Object.defineProperty(patched, '__ta_patch', { value: true }); } catch (_) {}
      Object.defineProperty(HTMLIFrameElement.prototype, 'contentWindow', {
        configurable: true,
        get: patched,
      });
    })();
  } catch (e) {
    console.log('Hardening error:', e);
  }
})();
