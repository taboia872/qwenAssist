# QwenAssist

<p align="center">
  <img src="docs/icon.png" width="128" alt="QwenAssist icon">
</p>

**QwenAssist** is a privacy-hardened Android WebView wrapper for **Qwen Chat** (https://chat.qwen.ai/), based on testAssist.

> ⚠️ **Login:** the restricted-mode domain whitelist blocks Google/Microsoft OAuth endpoints. When you reach the Qwen sign-in page, the app shows a banner reminding you to temporarily disable the whitelist (`menu → Settings → "Block non-HTTPS traffic"`), complete the login, then re-enable it.

---

## Features

- **Domain whitelist mode** (restricted mode, on by default): only `qwen.ai`, `alicdn.com`, `alibabacloud.com` and `googletagmanager.com` are allowed; other domains and non-HTTPS schemes are blocked.
- **Login whitelist banner**: a dismissible in-page banner appears on `/login`, `/sign-in`, `/sign-up`, `/auth` and `/oauth` paths whenever the whitelist is enabled, warning that signing in may require temporarily turning the restriction off.
- **App-promo bar killer**: a `MutationObserver` strips Qwen's "Download the app" promo bar shown to mobile UAs — any fixed/sticky (or top-of-viewport) element linking to `play.google.com` / `apps.apple.com` / `itunes.apple.com` or containing "Download the app" / "Get the app" style copy is removed as soon as it's inserted, including across SPA navigations.
- **Timezone spoofing** (IANA-aware, DST-correct): full `Date` surface override + `Intl.DateTimeFormat` injection, random timezone per session.
- **Hardware fingerprint hardening**: `hardwareConcurrency` → 4, `deviceMemory` → 4, WebGL GPU → generic Intel, WebRTC blocked (toggleable).
- **Sensor blocking**: DeviceOrientation/DeviceMotion neutralised (3 layers).
- **Do Not Track**: `navigator.doNotTrack = '1'` + `DNT: 1` header on the main request.
- **Generic desktop Chrome User-Agent** (no architecture leak).
- **Glassmorphism slide menu** with URL bar, reload, clear data, settings dialog and about.
- WebView metrics opt-out; session data persisted via IndexedDB/LocalStorage.

## Build

APKs are built via GitHub Actions (ARM64 local builds are not possible — AAPT2 is x86_64-only). Push to `main` for a debug APK artifact; push a tag `v*` to create a release with the APK attached.

## License

GPL-3.0 — based on testAssist / gptassist by @woheller69.
