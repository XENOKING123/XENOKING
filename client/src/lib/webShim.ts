// XENO TOOL Web — Tauri IPC shim. MUST be imported FIRST in main.tsx.
//
// The app calls `invoke()` from many modules: most go through our logged
// wrapper (invokeLogged.ts → webBridge), but a couple dozen import
// `invoke` straight from "@tauri-apps/api/core". In a plain browser those
// raw calls hit `window.__TAURI_INTERNALS__.invoke`, which doesn't exist,
// and throw "Cannot read properties of undefined (reading 'invoke')".
//
// So when there's no real Tauri (a browser tab serving XENO TOOL Web),
// we install a minimal `__TAURI_INTERNALS__` whose `invoke` forwards to
// the HTTP bridge. Now EVERY invoke — wrapped or raw — routes correctly,
// and unmapped commands get the bridge's clean "not available in web yet"
// error instead of an undefined crash.
//
// Detection: real Tauri injects `__TAURI_INTERNALS__` before app JS runs,
// so if it's absent here we're in the browser. We also set `__XENO_WEB__`
// as the marker the rest of the app checks (since after this runs,
// `__TAURI_INTERNALS__` is present in both worlds).
import { webInvoke } from "./webBridge";

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
    __TAURI__?: unknown;
    __XENO_WEB__?: boolean;
  }
}

if (typeof window !== "undefined" && !("__TAURI_INTERNALS__" in window)) {
  window.__XENO_WEB__ = true;
  // Minimal surface: `invoke` (the one thing the whole command layer needs)
  // plus `transformCallback` (touched by Channel/event APIs) as a no-op so
  // those don't crash on import.
  let cbId = 0;
  window.__TAURI_INTERNALS__ = {
    invoke: (cmd: string, args?: Record<string, unknown>) => webInvoke(cmd, args),
    transformCallback: (cb: unknown) => {
      // Tauri registers callbacks on window so the backend can call them;
      // in web mode no backend pushes events, so just hand back an id.
      cbId += 1;
      const id = cbId;
      (window as unknown as Record<string, unknown>)[`_${id}`] = cb;
      return id;
    },
    convertFileSrc: (p: string) => p,
    // Window/Webview APIs read these; provide the single "main" window so
    // getCurrentWindow()/getCurrentWebview() don't crash on import.
    metadata: {
      currentWindow: { label: "main" },
      currentWebview: { windowLabel: "main", label: "main" },
    },
    plugins: {},
  } as unknown;
}
