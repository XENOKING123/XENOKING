// MUST be first: installs the browser Tauri-IPC shim (XENO TOOL Web) so
// every invoke() — including raw @tauri-apps/api/core ones — routes to the
// HTTP bridge instead of crashing. No-op inside the real Tauri app.
import "./lib/webShim";
import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import { RootErrorBoundary } from "./components";
// Import the theme + lang stores before the first render so their
// module-load side effects (setting <html data-theme> + <html lang dir>)
// complete before React paints.
import "./state/theme";
import "./state/uiScale";
import "./state/lang";
import "./index.css";
import "./themes.css";
import {
  installUserConfigMirror,
  hydrateFromUserConfig,
} from "./state/userConfig";
import { installConsoleCapture, installDiskLogSink, log } from "./state/logs";
import { installEngineLogBridge } from "./state/engineLogBridge";
import { installEngineStartupEvents } from "./state/engineStartupEvents";
import { installAccidentalReloadGuard } from "./lib/preventAccidentalReload";

// Capture console.error / warn + unhandled promise rejections into
// the in-app log store before any other module runs — that way the
// Log tab shows *everything* that happens after app boot, including
// bugs in our own initialization code.
installConsoleCapture();
// Persist the unified log (frontend + engine bridge + console + payload
// events) to ~/.ps5upload/logs/ so a bug report can package a time window
// even after a crash. Best-effort; no-ops outside Tauri. See state/logs.ts.
installDiskLogSink();
log.info("app", "ps5upload client booting");
installEngineStartupEvents();

// Auto-collect a detailed diagnostic report to ~/.ps5upload/crash-reports/
// whenever the app surfaces an error (error-level notification) or the React
// tree crashes. Wired right after console capture so the very first errors
// are covered. Best-effort + debounced; see lib/crashReporter.ts.
import("./lib/crashReporter").then((m) => m.initCrashReporter());

// Mirror engine sidecar log lines into the Log tab. Without this, the
// engine's diagnostic output (reconcile progress, transfer retries,
// command errors) only reaches the dev terminal during `tauri dev` —
// packaged users would see nothing when something goes wrong.
installEngineLogBridge();

// Start mirroring stores to ~/.ps5upload/settings.json on every change,
// and then hydrate from that file (asynchronously) if the user has a
// pre-existing or hand-edited copy. Mirror runs regardless of whether
// hydration finds a file — that way a fresh install starts writing
// immediately.
installUserConfigMirror();
// Fire-and-forget: if the Tauri command isn't registered yet (dev mode
// first launch before compile), the inner call silently no-ops.
void hydrateFromUserConfig();

// Suppress the WebView's right-click menu (Back/Reload/Inspect) so a stray
// click can't restart the app out from under a running transfer/install;
// reload keyboard shortcuts are additionally blocked in production. No-op on
// non-Tauri / Android. See preventAccidentalReload.ts for the dev/prod split.
installAccidentalReloadGuard();

// XENO-AIO web ELF: if this UI is being served by the on-console ELF,
// auto-connect to the local PS5 so the user lands on a live app with no
// manual "enter IP + connect" step. No-ops in the desktop/mobile apps
// and on the PC host server. Fire-and-forget before first paint.
import("./lib/webAutoConnect").then((m) => void m.webAutoConnect());

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <RootErrorBoundary>
      {/* react-router-dom 7 makes the former v7_startTransition /
          v7_relativeSplatPath future flags the default behavior, so the
          `future` prop is gone. */}
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </RootErrorBoundary>
  </React.StrictMode>
);

// The XENO launch splash (painted in index.html) self-manages its own
// timing (4s energy bar + fade-out), exactly like the old splash.py. As a
// safety net, force-remove it after 7s in case its inline timer never ran.
window.setTimeout(() => {
  document.getElementById("xeno-splash")?.remove();
}, 7000);

// Daily cheat/trainer auto-update — pulls every one of the 6 GitHub cheat repos
// once per 24h in the background, so the trainer library is always fresh without
// the user pressing Sync. Runs ~12s after boot (let the engine settle first).
window.setTimeout(() => {
  void (async () => {
    try {
      const KEY = "xeno.lastCheatSync";
      const last = Number(window.localStorage.getItem(KEY) || 0);
      if (Date.now() - last > 24 * 60 * 60 * 1000) {
        const { cheatSync } = await import("./lib/trainers");
        log.info("cheats", "daily auto-sync: pulling 6 cheat repos…");
        const r = await cheatSync(true);
        window.localStorage.setItem(KEY, String(Date.now()));
        log.info("cheats", `daily auto-sync done — ${r.total} cheat files`);
      }
    } catch {
      /* offline / engine not ready — retries next launch */
    }
  })();
}, 12000);
