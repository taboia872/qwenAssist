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

    // DeviceOrientation / DeviceMotion — spoof with fixed "device lying flat" values.
    // Blocking these APIs outright breaks Qwen's new-chat page (it waits for an
    // orientation event during init, then never renders). Instead, keep the APIs
    // functional and emit one synthetic event with neutral values shortly after
    // load, so event listeners resolve and the page continues rendering.
    if (S.sensorsBlocked) {
      function fireSensorEvents() {
        try {
          var orientEvent;
          try {
            orientEvent = new DeviceOrientationEvent('deviceorientation', {
              alpha: 0, beta: 90, gamma: 0, absolute: false
            });
          } catch (e) {
            // Fallback for browsers without the constructor
            orientEvent = document.createEvent('Event');
            orientEvent.initEvent('deviceorientation', true, false);
            orientEvent.alpha = 0; orientEvent.beta = 90; orientEvent.gamma = 0;
            orientEvent.absolute = false;
          }
          window.dispatchEvent(orientEvent);
        } catch (_) {}
        try {
          var motionEvent;
          try {
            motionEvent = new DeviceMotionEvent('devicemotion', {
              acceleration: {x: 0, y: 0, z: 0},
              accelerationIncludingGravity: {x: 0, y: 0, z: 9.8},
              rotationRate: {alpha: 0, beta: 0, gamma: 0},
              interval: 16
            });
          } catch (e) {
            motionEvent = document.createEvent('Event');
            motionEvent.initEvent('devicemotion', true, false);
            motionEvent.acceleration = {x:0,y:0,z:0};
            motionEvent.accelerationIncludingGravity = {x:0,y:0,z:9.8};
            motionEvent.rotationRate = {alpha:0,beta:0,gamma:0};
            motionEvent.interval = 16;
          }
          window.dispatchEvent(motionEvent);
        } catch (_) {}
      }
      // Fire once after the page has had a chance to install its listeners.
      // Re-fire a few times in case the page subscribes late (Qwen does this
      // when creating a new chat — navigation to /c/<id> rebinds listeners).
      if (document.readyState === 'complete' || document.readyState === 'interactive') {
        setTimeout(fireSensorEvents, 150);
      } else {
        window.addEventListener('DOMContentLoaded', function () { setTimeout(fireSensorEvents, 150); }, {once: true});
      }
      setTimeout(fireSensorEvents, 800);   // catch late subscribers
      setTimeout(fireSensorEvents, 2000);  // catch very late subscribers

      // requestPermission must exist and resolve "granted" for iOS-style checks
      if (window.DeviceOrientationEvent && typeof DeviceOrientationEvent.requestPermission === 'function') {
        DeviceOrientationEvent.requestPermission = function () { return Promise.resolve('granted'); };
      }
      if (window.DeviceMotionEvent && typeof DeviceMotionEvent.requestPermission === 'function') {
        DeviceMotionEvent.requestPermission = function () { return Promise.resolve('granted'); };
      }
    }

    // Vibration — no-op but report success (mobile web apps check result)
    if (navigator.vibrate) navigator.vibrate = function () { return true; };

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
