# QwenAssist

**QwenAssist** is a privacy-hardened Android WebView wrapper for **Qwen Chat** (https://chat.qwen.ai/), based on testAssist.

---

## Features

- **Domain whitelist mode** (restricted mode, on by default): only `qwen.ai`, `alicdn.com`, `alibabacloud.com` and `googletagmanager.com` are allowed; other domains and non-HTTPS schemes are blocked.
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
