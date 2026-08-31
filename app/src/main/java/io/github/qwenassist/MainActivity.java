package io.github.qwenassist;

import static android.webkit.WebView.HitTestResult.IMAGE_TYPE;
import static android.webkit.WebView.HitTestResult.SRC_ANCHOR_TYPE;
import static android.webkit.WebView.HitTestResult.SRC_IMAGE_ANCHOR_TYPE;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.app.DownloadManager;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.Handler;
import android.util.Log;
import android.view.ContextMenu;
import android.view.KeyEvent;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.ConsoleMessage;
import android.webkit.CookieManager;
import android.webkit.URLUtil;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebStorage;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.EditText;
import android.widget.ImageButton;
import android.widget.LinearLayout;
import android.widget.Toast;

import androidx.webkit.URLUtilCompat;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;
import androidx.webkit.ScriptHandler;

import java.io.IOException;
import java.io.InputStream;
import java.util.Collections;
import java.util.Scanner;
import java.util.Set;

public class MainActivity extends Activity {

    private WebView chatWebView = null;
    private ImageButton btnMenuToggle = null;
    private ImageButton btnReload = null;
    private ImageButton btnClearData = null;
    private ImageButton btnSettings = null;
    private ImageButton btnAbout = null;
    private ImageButton btnFullscreen = null;
    private LinearLayout menuBar = null;
    private boolean menuVisible = false;
    private WebSettings chatWebSettings = null;
    private SharedPreferences prefs = null;
    private CookieManager chatCookieManager = null;
    private final Context context = this;
    private SwipeTouchListener swipeTouchListener;
    private static final String TAG = "qwenAssist";
    private static final String URL_TO_LOAD = "https://chat.qwen.ai/";
    // Domain whitelist for restricted mode. Subdomains of these are allowed.
    private static final String[] ALLOWED_DOMAINS = {
            "qwen.ai",             // chat.qwen.ai, pre-chat.qwen.ai (chat + API)
            "alicdn.com",          // o/g/assets/img.alicdn.com (static CDN, captcha frontend)
            "alibabacloud.com"       // Alibaba Cloud backend endpoints
            // NOTE: ALL Google domains are blocked by default (per user rule),
            // including googletagmanager.com analytics, until testing proves
            // something breaks without them.
    };

    private static boolean isAllowedDomain(String host) {
        if (host == null) return false;
        for (String d : ALLOWED_DOMAINS) {
            if (host.equals(d) || host.endsWith("." + d)) return true;
        }
        return false;
    }
    private static boolean restricted = true;
    private ScriptHandler loginWarningScriptHandler = null;
    private static boolean webrtcBlocked = true;
    private static boolean sensorsBlocked = true;
    private static boolean dntEnabled = true;
    private static boolean timezoneSpoofed = true;
    // desktopModeEnabled=false → mobile profile (default): mobile UA, 4 cores, 4GB, Adreno.
    // desktopModeEnabled=true  → desktop profile: desktop UA, 8 cores, 8GB, Intel GPU.
    private static boolean desktopModeEnabled = false;
    private static boolean fullscreenEnabled = false;
    private static String spoofedTimezone = "UTC";
    private Handler autoHideHandler = new Handler();
    private Runnable autoHideRunnable;

    private ValueCallback<Uri[]> mUploadMessage;
    private static final int FILE_CHOOSER_REQUEST_CODE = 1;

    // Script handles injected via addDocumentStartJavaScript (API-neutral via
    // androidx.webkit). Each is registered once after WebView configuration so
    // they fire before any page script on every navigation, matching notme's
    // document_start semantics. Fallback: evaluateJavascript in onPageStarted
    // on platforms where DOCUMENT_START_SCRIPT isn't supported.
    private ScriptHandler tzScriptHandler = null;
    private ScriptHandler hardeningScriptHandler = null;
    private static final Set<String> ALLOW_ALL_ORIGINS = Collections.singleton("*");

    // Pick a random timezone once per session if timezone spoofing is on.
    // Offset/DST are resolved at runtime by Intl.DateTimeFormat in the JS.
    private static String pickRandomTimezone() {
        String[] timezones = {
            "America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles",
            "America/Sao_Paulo", "America/Toronto", "America/Vancouver",
            "Europe/London", "Europe/Paris", "Europe/Berlin", "Europe/Madrid", "Europe/Rome",
            "Europe/Amsterdam", "Europe/Stockholm", "Europe/Warsaw", "Europe/Istanbul",
            "Asia/Tokyo", "Asia/Singapore", "Asia/Seoul", "Asia/Bangkok",
            "Asia/Dubai", "Asia/Kolkata", "Asia/Hong_Kong",
            "Australia/Sydney", "Australia/Melbourne"
        };
        return timezones[(int) (Math.random() * timezones.length)];
    }

    // Read a text asset into a String. Assets live in app/src/main/assets/.
    private String readAsset(String filename) {
        try (InputStream is = getAssets().open(filename)) {
            Scanner sc = new Scanner(is, "UTF-8").useDelimiter("\\A");
            return sc.hasNext() ? sc.next() : "";
        } catch (IOException e) {
            Log.e(TAG, "readAsset(" + filename + "): " + e.getMessage());
            return "";
        }
    }

    // Build the combined tz spoof script: payload prefix + tzspoof.js body.
    // The prefix injects window.__TA_SETTINGS__ that the JS reads and deletes.
    private String buildTzSpoofScript() {
        if (timezoneSpoofed && "UTC".equals(spoofedTimezone)) {
            spoofedTimezone = pickRandomTimezone();
        }
        String tz = timezoneSpoofed ? spoofedTimezone : "";
        String json = "{\"timezone\":\"" + tz + "\",\"tzEnabled\":" + timezoneSpoofed + "}";
        String js = readAsset("tzspoof.js");
        return "window.__TA_SETTINGS__ = " + json + ";\n" + js;
    }

    // Build the combined hardening script: payload prefix + hardening.js body.
    private String buildHardeningScript() {
        // Compute spoofed values once per profile — mobile by default
        // (desktopModeEnabled=false), desktop when the toggle is ON.
        int cores = desktopModeEnabled ? 8 : 4;
        int memory = desktopModeEnabled ? 8 : 4;
        String gpuVendor = desktopModeEnabled
            ? "Google Inc. (Intel)"
            : "Qualcomm";
        String gpuRenderer = desktopModeEnabled
            ? "ANGLE (Intel, Intel(R) UHD Graphics 630, OpenGL 4.1)"
            : "Adreno (TM) 650";

        String json = "{\"sensorsBlocked\":" + sensorsBlocked
            + ",\"dntEnabled\":" + dntEnabled
            + ",\"webrtcBlocked\":" + webrtcBlocked
            + ",\"spoofCores\":" + cores
            + ",\"spoofMemory\":" + memory
            + ",\"spoofGpuVendor\":\"" + gpuVendor + "\""
            + ",\"spoofGpuRenderer\":\"" + gpuRenderer + "\"}";
        String js = readAsset("hardening.js");
        return "window.__TA_SETTINGS__ = " + json + ";\n" + js;
    }

    // Combined hardening script for fallback injection via evaluateJavascript on
    // WebViews that don't support DOCUMENT_START_SCRIPT. Same content, prefixed
    // with javascript: so loadUrl accepts it.
    private String buildFallbackHardeningJS() {
        return "javascript:" + buildHardeningScript();
    }
    private String buildFallbackTzSpoofJS() {
        return "javascript:" + buildTzSpoofScript();
    }

    // Register or refresh the document_start scripts. Toggle changes in settings
    // call this so the new payload takes effect without re-reading the assets.
    private void installDocumentStartScripts() {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) return;
        // Remove previous handlers so we can re-register with a fresh payload
        // (the script source string is immutable post-registration, and toggles
        // can change the payload between settings rounds).
        if (tzScriptHandler != null) { tzScriptHandler.remove(); tzScriptHandler = null; }
        if (hardeningScriptHandler != null) { hardeningScriptHandler.remove(); hardeningScriptHandler = null; }
        try {
            hardeningScriptHandler = WebViewCompat.addDocumentStartJavaScript(
                chatWebView, buildHardeningScript(), ALLOW_ALL_ORIGINS);
        } catch (Exception e) { Log.w(TAG, "hardening script registration: " + e.getMessage()); }
        try {
            tzScriptHandler = WebViewCompat.addDocumentStartJavaScript(
                chatWebView, buildTzSpoofScript(), ALLOW_ALL_ORIGINS);
        } catch (Exception e) { Log.w(TAG, "tz spoof script registration: " + e.getMessage()); }
        try {
            loginWarningScriptHandler = WebViewCompat.addDocumentStartJavaScript(
                chatWebView, buildLoginWarningScript(), ALLOW_ALL_ORIGINS);
        } catch (Exception e) { Log.w(TAG, "login warning script registration: " + e.getMessage()); }
        try {
            WebViewCompat.addDocumentStartJavaScript(
                chatWebView, buildAppBannerKillerScript(), ALLOW_ALL_ORIGINS);
        } catch (Exception e) { Log.w(TAG, "app-banner killer registration: " + e.getMessage()); }
    }

    // Removes Qwen's "Get the App" promo bar that appears on mobile UAs.
    // The banner is rendered as <div id="get-the-app"> (mobile in-feed strip)
    // plus a fullscreen <div id="downLoad_app"> fallback when opening the
    // "unsupported system" page. Both have stable IDs, so we (a) hide them
    // with a !important style rule — survives page-side JS that flips
    // display back — and (b) prune any late-inserted clones via a
    // MutationObserver.
    private String buildAppBannerKillerScript() {
        return
          "(function(){" +
          "  if (window.__qwenAppBannerKillerInstalled) return;" +
          "  window.__qwenAppBannerKillerInstalled = true;" +
          "  var STYLE = '#get-the-app,#downLoad_app,#low-version-browser{display:none!important;visibility:hidden!important;height:0!important;overflow:hidden!important}';" +
          "  function injectStyle() {" +
          "    var root = document.head || document.documentElement;" +
          "    if (!root) return;" +
          "    if (document.getElementById('__qwenAppBannerKillerStyle')) return;" +
          "    var s = document.createElement('style');" +
          "    s.id = '__qwenAppBannerKillerStyle';" +
          "    s.textContent = STYLE;" +
          "    root.appendChild(s);" +
          "  }" +
          "  function prune() {" +
          "    ['get-the-app', 'downLoad_app', 'low-version-browser'].forEach(function(id){" +
          "      var el = document.getElementById(id);" +
          "      if (el && el.parentNode) el.parentNode.removeChild(el);" +
          "    });" +
          "  }" +
          "  injectStyle();" +
          "  // document_start scripts can fire before <head>/<body> exist — keep trying." +
          "  var early = setInterval(function(){" +
          "    injectStyle();" +
          "    if (document.body) { prune(); }" +
          "    if (document.getElementById('__qwenAppBannerKillerStyle') && document.body) clearInterval(early);" +
          "  }, 50);" +
          "  setTimeout(function(){ clearInterval(early); }, 10000);" +
          "  var mo = new MutationObserver(function(){ injectStyle(); prune(); });" +
          "  function attach() {" +
          "    if (document.documentElement) {" +
          "      mo.observe(document.documentElement, {childList:true, subtree:true});" +
          "      prune();" +
          "    } else { document.addEventListener('DOMContentLoaded', attach, {once:true}); }" +
          "  }" +
          "  attach();" +
          "  var _ps = history.pushState.bind(history);" +
          "  history.pushState = function(){ var r = _ps.apply(history, arguments); setTimeout(prune, 0); return r; };" +
          "})();\n";
    }

    // Injects a dismissible banner on Qwen auth pages warning that the login
    // flow may require temporarily disabling the domain whitelist (Settings →
    // "Block non-HTTPS traffic" toggle) because OAuth providers (Google etc.)
    // are blocked in restricted mode. The banner only appears on /login,
    // /sign-in, /sign-up, /auth, or /oauth paths while restricted=on; reads
    // the live restricted flag via a localStorage mirror updated by Java
    // before each navigation.
    private String buildLoginWarningScript() {
        String bannerText;
        try {
            bannerText = getString(R.string.login_whitelist_warning);
        } catch (Exception e) {
            bannerText = "Login may require temporarily disabling the domain whitelist (menu → Settings). Re-enable it after signing in.";
        }
        String escapedText = bannerText.replace("\\", "\\\\").replace("'", "\\'");
        return
          "(function(){" +
          "  try {" +
          "    if (window.__qwenLoginBannerInstalled) return;" +
          "    window.__qwenLoginBannerInstalled = true;" +
          "    function isLoginPath() {" +
          "      var p = (location.pathname || '').toLowerCase();" +
          "      return p.indexOf('login') !== -1 || p.indexOf('sign-in') !== -1 ||" +
          "             p.indexOf('signin') !== -1 || p.indexOf('sign-up') !== -1 ||" +
          "             p.indexOf('signup') !== -1 || p.indexOf('/auth') !== -1 ||" +
          "             p.indexOf('oauth') !== -1;" +
          "    }" +
          "    function restrictedOn() {" +
          "      try { return localStorage.getItem('__qwen_restricted') !== '0'; } catch(e) { return true; }" +
          "    }" +
          "    var banner = null;" +
          "    function removeBanner() { if (banner && banner.parentNode) banner.parentNode.removeChild(banner); banner = null; }" +
          "    function maybeShow() {" +
          "      if (!isLoginPath() || !restrictedOn()) { removeBanner(); return; }" +
          "      if (banner) return;" +
          "      banner = document.createElement('div');" +
          "      banner.setAttribute('style'," +
          "        'position:fixed;top:0;left:0;right:0;z-index:2147483647;'" +
          "        +'background:rgba(120,53,15,0.95);color:#FEF3C7;padding:10px 40px 10px 14px;'" +
          "        +'font:13px/1.4 -apple-system,sans-serif;text-align:center;'" +
          "        +'box-shadow:0 2px 8px rgba(0,0,0,0.4);border-bottom:1px solid rgba(255,255,255,0.2);');" +
          "      banner.textContent = '\\u26A0\\uFE0F ' + '" + escapedText + "';" +
          "      var close = document.createElement('button');" +
          "      close.textContent = '\\u00D7';" +
          "      close.setAttribute('style'," +
          "        'position:absolute;right:8px;top:50%;transform:translateY(-50%);'" +
          "        +'background:transparent;border:none;color:#FEF3C7;font-size:18px;cursor:pointer;padding:4px 8px;');" +
          "      close.addEventListener('click', removeBanner);" +
          "      banner.appendChild(close);" +
          "      (document.body || document.documentElement).appendChild(banner);" +
          "    }" +
          "    // Wait for body to exist, then check; also re-check on SPA navigations." +
          "    function schedule() {" +
          "      if (document.body) { maybeShow(); }" +
          "      else { document.addEventListener('DOMContentLoaded', maybeShow, {once:true}); }" +
          "    }" +
          "    schedule();" +
          "    var _pushState = history.pushState.bind(history);" +
          "    history.pushState = function() { var r = _pushState.apply(history, arguments); setTimeout(maybeShow, 0); return r; };" +
          "    window.addEventListener('popstate', function(){ setTimeout(maybeShow, 0); });" +
          "    // Other tabs shouldn't ever see this page, but if localStorage is" +
          "    // toggled mid-session, hide promptly." +
          "    setInterval(maybeShow, 2000);" +
          "  } catch(e) { /* banner is best-effort */ }" +
          "})();\n";
    }

    // Called by Java-side toggle changes so the banner script can read the
    // current "restricted" flag from page context (localStorage survives SPA
    // navigations within the same tab).
    private void syncRestrictedToPage() {
        if (chatWebView == null) return;
        chatWebView.evaluateJavascript(
            "try{localStorage.setItem('__qwen_restricted','" + (restricted ? "1" : "0") + "');}catch(e){}",
            null);
    }

    // True when addDocumentStartJavaScript is supported on this WebView — the
    // fallback (evaluateJavascript in onPageStarted) only runs when this is false.
    private boolean documentStartSupported() {
        return WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT);
    }

    @Override
    protected void onPause() {
        if (chatCookieManager != null) chatCookieManager.flush();
        swipeTouchListener = null;
        super.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();

        // Arrow tab click — toggle menu open/closed
        btnMenuToggle.setOnClickListener(v -> {
            if (menuVisible) {
                hideMenu();
            } else {
                showMenu();
            }
        });

        // Reload page
        btnReload.setOnClickListener(v -> {
            chatWebView.reload();
            hideMenu();
        });

        // Fullscreen toggle — hides/shows status bar via immersive mode
        btnFullscreen.setOnClickListener(v -> {
            fullscreenEnabled = !fullscreenEnabled;
            applyFullscreen();
            Toast.makeText(context,
                fullscreenEnabled ? "Fullscreen on" : "Fullscreen off",
                Toast.LENGTH_SHORT).show();
            hideMenu();
        });

        // Clear all data with confirmation dialog
        btnClearData.setOnClickListener(v -> {
            new AlertDialog.Builder(context)
                .setTitle(R.string.confirm_clear_title)
                .setMessage(R.string.confirm_clear_data)
                .setPositiveButton(R.string.confirm_yes, (dialog, which) -> {
                    resetChat();
                    Toast.makeText(context, R.string.data_cleared, Toast.LENGTH_SHORT).show();
                })
                .setNegativeButton(R.string.confirm_no, null)
                .show();
            hideMenu();
        });

        // Settings dialog — toggle privacy/security options
        btnSettings.setOnClickListener(v -> {
            String[] options = {
                "Block non-HTTPS traffic",
                "Block WebRTC",
                "Block Device Orientation/Motion",
                "Do Not Track (DNT)",
                "Spoof Timezone (random)",
                "Desktop mode (UA + hardware fingerprint)"
            };
            boolean[] checked = {restricted, webrtcBlocked, sensorsBlocked, dntEnabled, timezoneSpoofed, desktopModeEnabled};
            new AlertDialog.Builder(context)
                .setTitle("Settings")
                .setMultiChoiceItems(options, checked, (dialog, which, isChecked) -> {
                    if (which == 0) { restricted = isChecked; syncRestrictedToPage(); }
                    else if (which == 1) webrtcBlocked = isChecked;
                    else if (which == 2) sensorsBlocked = isChecked;
                    else if (which == 3) dntEnabled = isChecked;
                    else if (which == 4) {
                        timezoneSpoofed = isChecked;
                        if (!isChecked) spoofedTimezone = "UTC";
                    }
                    else if (which == 5) desktopModeEnabled = isChecked;
                })
                .setPositiveButton("Apply & Reload", (dialog, which) -> {
                    saveSettings();
                    chatWebSettings.setUserAgentString(modUserAgent());
                    // Re-register document_start scripts so the new toggle
                    // values take effect (the script body embeds the payload).
                    installDocumentStartScripts();
                    chatWebView.reload();
                })
                .setNegativeButton("Cancel", null)
                .show();
            hideMenu();
        });

        // About dialog
        btnAbout.setOnClickListener(v -> {
            new AlertDialog.Builder(context)
                .setTitle(R.string.about_title)
                .setMessage(R.string.about_message)
                .setPositiveButton(R.string.dialog_OK_button, null)
                .show();
            hideMenu();
        });

        swipeTouchListener = new SwipeTouchListener(context) {
            @Override
            public void onSwipeBottom() {
                if (!chatWebView.canScrollVertically(0)) {
                    showArrow();
                }
            }
            @Override
            public void onSwipeTop() {
                hideMenu();
                menuBar.setVisibility(View.GONE);
            }
        };

        chatWebView.setOnTouchListener(swipeTouchListener);
    }

    private void showArrow() {
        if (menuVisible) return;
        menuBar.setVisibility(View.VISIBLE);
        scheduleAutoHide();
    }

    private void scheduleAutoHide() {
        if (autoHideRunnable != null) autoHideHandler.removeCallbacks(autoHideRunnable);
        autoHideRunnable = () -> {
            if (!menuVisible) {
                menuBar.setVisibility(View.GONE);
            }
        };
        autoHideHandler.postDelayed(autoHideRunnable, 3000);
    }

    private int getArrowWidth() {
        ImageButton arrow = menuBar.findViewById(R.id.btnMenuToggleInner);
        return arrow.getWidth();
    }

    private void showMenu() {
        menuVisible = true;
        // Cancel auto-hide while menu is open
        if (autoHideRunnable != null) autoHideHandler.removeCallbacks(autoHideRunnable);
        // Show action buttons immediately (no fade)
        int[] viewIds = {R.id.btnReload, R.id.btnFullscreen, R.id.btnClearData, R.id.btnSettings, R.id.btnAbout};
        for (int viewId : viewIds) {
            View v = menuBar.findViewById(viewId);
            v.setAlpha(1f);
            v.setVisibility(View.VISIBLE);
        }
        // Measure full width now that all buttons are visible
        menuBar.measure(View.MeasureSpec.UNSPECIFIED, View.MeasureSpec.UNSPECIFIED);
        int fullWidth = menuBar.getMeasuredWidth();
        int arrowWidth = getArrowWidth();
        int slideDistance = fullWidth - arrowWidth;
        // Slide container left by exactly the distance that reveals all buttons
        menuBar.setTranslationX(slideDistance);
        menuBar.animate()
            .translationX(0f)
            .setDuration(500)
            .start();
    }

    private void hideMenu() {
        if (!menuVisible) return;
        menuVisible = false;
        // Measure current full width (all buttons visible)
        menuBar.measure(View.MeasureSpec.UNSPECIFIED, View.MeasureSpec.UNSPECIFIED);
        int fullWidth = menuBar.getMeasuredWidth();
        int arrowWidth = getArrowWidth();
        int slideDistance = fullWidth - arrowWidth;
        // Slide right by the distance that hides all buttons except the arrow
        menuBar.animate()
            .translationX(slideDistance)
            .setDuration(500)
            .withEndAction(() -> {
                int[] viewIds = {R.id.btnReload, R.id.btnFullscreen, R.id.btnClearData, R.id.btnSettings, R.id.btnAbout};
                for (int viewId : viewIds) {
                    View v = menuBar.findViewById(viewId);
                    v.setVisibility(View.GONE);
                }
                menuBar.setTranslationX(0f);
                // Start auto-hide countdown after menu closes
                scheduleAutoHide();
            })
            .start();
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        prefs = getSharedPreferences("qwenassist_prefs", Context.MODE_PRIVATE);
        loadSettings();

        // Separate WebView data directory for isolation (sandboxing)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            try {
                WebView.setDataDirectorySuffix("qwen_assist");
            } catch (Exception e) {
                Log.w(TAG, "setDataDirectorySuffix failed: " + e.getMessage());
            }
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            setTheme(android.R.style.Theme_DeviceDefault_DayNight);
        }
        getWindow().clearFlags(WindowManager.LayoutParams.FLAG_DRAWS_SYSTEM_BAR_BACKGROUNDS);
        requestWindowFeature(Window.FEATURE_NO_TITLE);
        super.onCreate(savedInstanceState);
        // Edge-to-edge window: app draws behind system bars. Insets are
        // applied as padding on the root layout — when bars are visible the
        // content sits below/above them; in fullscreen mode the bars hide,
        // insets go to zero, and the content expands automatically.
        androidx.core.view.WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
        getWindow().setStatusBarColor(android.graphics.Color.TRANSPARENT);
        getWindow().setNavigationBarColor(android.graphics.Color.TRANSPARENT);
        setContentView(R.layout.activity_main);

        final android.view.View rootView = findViewById(android.R.id.content);
        androidx.core.view.ViewCompat.setOnApplyWindowInsetsListener(rootView,
            (v, windowInsets) -> {
                androidx.core.graphics.Insets bars = windowInsets.getInsets(
                    androidx.core.view.WindowInsetsCompat.Type.systemBars());
                animatePadding(v, bars.left, bars.top, bars.right, bars.bottom);
                return windowInsets;
            });

        chatWebView = findViewById(R.id.chatWebView);
        // Detect when page is scrolled to top to reveal the arrow button
        chatWebView.getViewTreeObserver().addOnScrollChangedListener(() -> {
            if (!menuVisible && chatWebView.getScrollY() == 0) {
                showArrow();
            }
        });
        registerForContextMenu(chatWebView);
        btnMenuToggle = findViewById(R.id.btnMenuToggleInner);
        btnReload = findViewById(R.id.btnReload);
        btnClearData = findViewById(R.id.btnClearData);
        btnSettings = findViewById(R.id.btnSettings);
        btnAbout = findViewById(R.id.btnAbout);
        btnFullscreen = findViewById(R.id.btnFullscreen);
        menuBar = findViewById(R.id.menuBar);

        // Cookie security settings
        chatCookieManager = CookieManager.getInstance();
        chatCookieManager.setAcceptCookie(true);
        chatCookieManager.setAcceptThirdPartyCookies(chatWebView, true);

        chatWebView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onConsoleMessage(ConsoleMessage consoleMessage) {
                if (consoleMessage.message().contains("NotAllowedError: Write permission denied.")) {
                    Toast.makeText(context, R.string.error_copy, Toast.LENGTH_LONG).show();
                    return true;
                }
                return false;
            }

            @Override
            public boolean onShowFileChooser(WebView webView, ValueCallback<Uri[]> filePathCallback, FileChooserParams fileChooserParams) {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M && Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
                    if (checkSelfPermission(Manifest.permission.READ_EXTERNAL_STORAGE) != PackageManager.PERMISSION_GRANTED) {
                        requestPermissions(new String[]{Manifest.permission.READ_EXTERNAL_STORAGE}, 100);
                    }
                }
                if (mUploadMessage != null) {
                    mUploadMessage.onReceiveValue(null);
                    mUploadMessage = null;
                }

                mUploadMessage = filePathCallback;

                Intent intent = new Intent(Intent.ACTION_GET_CONTENT);
                intent.addCategory(Intent.CATEGORY_OPENABLE);
                intent.setType("*/*");
                startActivityForResult(intent, FILE_CHOOSER_REQUEST_CODE);
                return true;
            }

            @Override
            public void onPermissionRequest(final android.webkit.PermissionRequest request) {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                    if (request.getResources().length > 0 && request.getResources()[0].equals(android.webkit.PermissionRequest.RESOURCE_AUDIO_CAPTURE)) {
                        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
                            request.grant(request.getResources());
                        } else {
                            requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, 123);
                        }
                    } else {
                        request.deny();
                    }
                } else {
                    request.grant(request.getResources());
                }
            }
        });

        chatWebView.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
                super.onPageStarted(view, url, favicon);
                // Fallback for WebViews without DOCUMENT_START_SCRIPT support
                // (API 21-23 with an older WebView implementation). The primary
                // path installs the scripts once via addDocumentStartJavaScript
                // in onResume/_post_webview_config_, which fires before page
                // scripts; this is the legacy safety net.
                if (!documentStartSupported()) {
                    view.evaluateJavascript(buildFallbackHardeningJS(), null);
                    view.evaluateJavascript(buildFallbackTzSpoofJS(), null);
                }
            }

            @Override
            public void onPageCommitVisible(WebView view, String url) {
                super.onPageCommitVisible(view, url);
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                super.onPageFinished(view, url);
                if (chatCookieManager != null) {
                    chatCookieManager.flush();
                }
                // Keep the page-side mirror of the restricted flag fresh so
                // the login banner reflects the current setting without a
                // full reload.
                syncRestrictedToPage();
            }

            @Override
            public WebResourceResponse shouldInterceptRequest(final WebView view, WebResourceRequest request) {
                if (!restricted) return null;

                String urlStr = request.getUrl().toString();
                String scheme = request.getUrl().getScheme();

                // Allow blob:, data:, and about: schemes
                if (scheme != null && ("blob".equalsIgnoreCase(scheme) || "data".equalsIgnoreCase(scheme) || "about".equalsIgnoreCase(scheme))) {
                    return null;
                }

                if (urlStr.equals("about:blank")) {
                    return null;
                }

                if (scheme == null || !"https".equalsIgnoreCase(scheme)) {
                    Log.d(TAG, "[shouldInterceptRequest][NON-HTTPS] Blocked: " + urlStr);
                    return blockedResponse();
                }

                if (!isAllowedDomain(request.getUrl().getHost())) {
                    Log.d(TAG, "[shouldInterceptRequest][DOMAIN] Blocked: " + urlStr);
                    return blockedResponse();
                }

                return null;
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                if (!restricted) return false;

                String scheme = request.getUrl().getScheme();
                if (scheme != null && ("blob".equalsIgnoreCase(scheme) || "data".equalsIgnoreCase(scheme) || "about".equalsIgnoreCase(scheme))) {
                    return false;
                }

                if (request.getUrl().toString().equals("about:blank")) return false;

                if (scheme == null || !"https".equalsIgnoreCase(scheme)
                        || !isAllowedDomain(request.getUrl().getHost())) {
                    Log.d(TAG, "[shouldOverrideUrlLoading] Blocked: " + request.getUrl());
                    return true;
                }
                return false;
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request != null && request.isForMainFrame()) {
                    Log.w(TAG, "[onReceivedError] " + error.getErrorCode() + ": " + error.getDescription() + " @ " + request.getUrl());
                }
            }
        });

        chatWebView.setDownloadListener((url, userAgent, contentDisposition, mimetype, contentLength) -> {
            Uri source = Uri.parse(url);
            DownloadManager.Request request = new DownloadManager.Request(source);
            request.addRequestHeader("Cookie", CookieManager.getInstance().getCookie(url));
            request.addRequestHeader("Accept", "text/html, application/xhtml+xml, *" + "/" + "*");
            request.addRequestHeader("Accept-Language", "en-US,en;q=0.7,he;q=0.3");
            request.addRequestHeader("Referer", url);
            request.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
            String filename = URLUtilCompat.getFilenameFromContentDisposition(contentDisposition);
            if (filename == null) filename = URLUtilCompat.guessFileName(url, contentDisposition, mimetype);
            request.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, filename);
            Toast.makeText(this, getString(R.string.download) + "\n" + filename, Toast.LENGTH_SHORT).show();
            DownloadManager dm = (DownloadManager) getSystemService(DOWNLOAD_SERVICE);
            if (dm != null) dm.enqueue(request);
        });

        // Configure WebSettings for full local storage
        chatWebSettings = chatWebView.getSettings();
        chatWebSettings.setJavaScriptEnabled(true);
        chatWebSettings.setDomStorageEnabled(true);
        chatWebSettings.setDatabaseEnabled(true);
        chatWebSettings.setCacheMode(WebSettings.LOAD_DEFAULT);

        // Security / Hardening overrides
        chatWebSettings.setAllowContentAccess(true);
        chatWebSettings.setAllowFileAccess(true);
        chatWebSettings.setBuiltInZoomControls(false);
        chatWebSettings.setDisplayZoomControls(false);
        chatWebSettings.setSaveFormData(false);
        chatWebSettings.setGeolocationEnabled(false);
        chatWebSettings.setUserAgentString(modUserAgent());

        // Register document_start scripts (runs before any page script on every
        // navigation). The script source reflects current toggle state, so a
        // reload after Apply & Reapply picks up new settings. Falls back to
        // evaluateJavascript in onPageStarted when the feature isn't supported.
        installDocumentStartScripts();

        // Load with DNT header if enabled
        if (dntEnabled) {
            java.util.Map<String, String> extraHeaders = new java.util.HashMap<>();
            extraHeaders.put("DNT", "1");
            chatWebView.loadUrl(URL_TO_LOAD, extraHeaders);
        } else {
            chatWebView.loadUrl(URL_TO_LOAD);
        }
        // Start auto-hide countdown for arrow button
        scheduleAutoHide();
    }

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (event.getAction() == KeyEvent.ACTION_DOWN) {
            if (keyCode == KeyEvent.KEYCODE_BACK) {
                if (chatWebView.canGoBack() && !chatWebView.getUrl().equals("about:blank")) {
                    chatWebView.goBack();
                } else {
                    finish();
                }
                return true;
            }
        }
        return super.onKeyDown(keyCode, event);
    }

    public void resetChat() {
        chatWebView.clearCache(true);
        chatWebView.clearFormData();
        chatWebView.clearHistory();
        chatWebView.clearMatches();
        chatWebView.clearSslPreferences();
        chatCookieManager.removeSessionCookie();
        // removeAllCookies is async — only reload after cookies are actually gone,
        // otherwise the fresh page load can still send stale session cookies.
        chatCookieManager.removeAllCookies(value -> {
            CookieManager.getInstance().flush();
            WebStorage.getInstance().deleteAllData();
            chatWebView.loadUrl(URL_TO_LOAD);
        });
    }

    private void loadSettings() {
        restricted = prefs.getBoolean("restricted", true);
        webrtcBlocked = prefs.getBoolean("webrtcBlocked", true);
        sensorsBlocked = prefs.getBoolean("sensorsBlocked", true);
        dntEnabled = prefs.getBoolean("dntEnabled", true);
        timezoneSpoofed = prefs.getBoolean("timezoneSpoofed", true);
        desktopModeEnabled = prefs.getBoolean("desktopModeEnabled", false);
    }

    private void saveSettings() {
        prefs.edit()
                .putBoolean("restricted", restricted)
                .putBoolean("webrtcBlocked", webrtcBlocked)
                .putBoolean("sensorsBlocked", sensorsBlocked)
                .putBoolean("dntEnabled", dntEnabled)
                .putBoolean("timezoneSpoofed", timezoneSpoofed)
                .putBoolean("desktopModeEnabled", desktopModeEnabled)
                .apply();
    }

    // Blocked requests get an explicit 403 with a JSON body instead of 200 OK with
    // text/javascript and an empty body — the old response broke auth-provider JS
    // (e.g. Clerk) that called response.json() and got a parse error / null.
    private WebResourceResponse blockedResponse() {
        return new WebResourceResponse(
                "application/json", "UTF-8", 403, "Forbidden",
                Collections.singletonMap("Content-Type", "application/json"),
                new java.io.ByteArrayInputStream("{}".getBytes()));
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent intent) {
        super.onActivityResult(requestCode, resultCode, intent);
        if (requestCode == FILE_CHOOSER_REQUEST_CODE) {
            if (mUploadMessage == null) return;
            Uri[] result = null;
            if (resultCode == Activity.RESULT_OK && intent != null) {
                String dataString = intent.getDataString();
                if (dataString != null) {
                    result = new Uri[]{Uri.parse(dataString)};
                }
            }
            mUploadMessage.onReceiveValue(result);
            mUploadMessage = null;
        }
    }

    @Override
    public void onCreateContextMenu(ContextMenu menu, View v, ContextMenu.ContextMenuInfo menuInfo) {
        super.onCreateContextMenu(menu, v, menuInfo);
        WebView.HitTestResult result = chatWebView.getHitTestResult();
        if (result.getExtra() != null && (result.getType() == IMAGE_TYPE || result.getType() == SRC_IMAGE_ANCHOR_TYPE || result.getType() == SRC_ANCHOR_TYPE)) {
            String url = result.getExtra();
            ClipboardManager clipboard = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
            ClipData clip = ClipData.newPlainText(getString(R.string.app_name), url);
            clipboard.setPrimaryClip(clip);
            Toast.makeText(this, R.string.url_copied, Toast.LENGTH_SHORT).show();
        }
    }

    public String modUserAgent() {
        if (desktopModeEnabled) {
            // Generic Windows Chrome desktop UA — blends with desktop users
            return "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36";
        }
        // Default: generic mobile Chrome on Android (matches the dominant WebView population)
        return "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Mobile Safari/537.36";
    }

    private android.animation.ValueAnimator paddingAnimator;

    private void animatePadding(final android.view.View v,
                                final int targetLeft, final int targetTop,
                                final int targetRight, final int targetBottom) {
        // Cancel any in-flight animation and start from current padding
        if (paddingAnimator != null && paddingAnimator.isRunning()) {
            paddingAnimator.cancel();
        }
        final int startLeft = v.getPaddingLeft();
        final int startTop = v.getPaddingTop();
        final int startRight = v.getPaddingRight();
        final int startBottom = v.getPaddingBottom();
        if (startLeft == targetLeft && startTop == targetTop
                && startRight == targetRight && startBottom == targetBottom) {
            return; // nothing to do
        }
        paddingAnimator = android.animation.ValueAnimator.ofFloat(0f, 1f);
        paddingAnimator.setDuration(300);
        paddingAnimator.setInterpolator(new android.view.animation.DecelerateInterpolator());
        paddingAnimator.addUpdateListener(anim -> {
            float t = (Float) anim.getAnimatedValue();
            v.setPadding(
                (int)(startLeft   + (targetLeft   - startLeft)   * t),
                (int)(startTop    + (targetTop    - startTop)    * t),
                (int)(startRight  + (targetRight  - startRight)  * t),
                (int)(startBottom + (targetBottom - startBottom) * t));
        });
        paddingAnimator.start();
    }

    private void applyFullscreen() {
        // Edge-to-edge is set once in onCreate (decorFits=false + transparent bars).
        // The toggle only hides/shows the system bars — no layout flip-flop.
        androidx.core.view.WindowInsetsControllerCompat controller =
            androidx.core.view.WindowCompat.getInsetsController(
                getWindow(), getWindow().getDecorView());
        controller.setSystemBarsBehavior(
            androidx.core.view.WindowInsetsControllerCompat
                .BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
        if (fullscreenEnabled) {
            controller.hide(androidx.core.view.WindowInsetsCompat.Type.systemBars());
        } else {
            controller.show(androidx.core.view.WindowInsetsCompat.Type.systemBars());
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == 123) {
            if (grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
                Toast.makeText(context, "Microphone permission granted.", Toast.LENGTH_SHORT).show();
            } else {
                Toast.makeText(context, "Microphone permission denied.", Toast.LENGTH_SHORT).show();
            }
        }
        if (requestCode == 100) {
            if (grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
                Toast.makeText(context, "Storage permission granted.", Toast.LENGTH_SHORT).show();
            } else {
                Toast.makeText(context, "Storage permission denied.", Toast.LENGTH_SHORT).show();
            }
        }
    }
}