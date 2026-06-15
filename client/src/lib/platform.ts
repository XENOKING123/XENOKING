// Lightweight platform detection for gating mobile-specific behavior.
//
// Dependency-free (reads navigator.userAgent) so it works inside the
// Tauri webview and in jsdom unit tests without pulling the Tauri OS
// plugin. Mirrors lib/diagnosticBundle.ts, which already reads
// navigator.userAgent the same defensive way.
//
// Used to branch file/folder pickers: desktop uses native dialogs that
// return real paths; Android's scoped storage can't, so we open an
// in-app browser backed by real-path commands instead.

function ua(): string {
  if (typeof navigator === "undefined") return "";
  return navigator.userAgent || "";
}

export function isAndroid(): boolean {
  return /android/i.test(ua());
}

export function isIOS(): boolean {
  const s = ua();
  // iPadOS 13+ reports as Mac; the touch-points check disambiguates.
  return (
    /iphone|ipad|ipod/i.test(s) ||
    (/Macintosh/.test(s) &&
      typeof navigator !== "undefined" &&
      (navigator as Navigator & { maxTouchPoints?: number }).maxTouchPoints !==
        undefined &&
      ((navigator as Navigator & { maxTouchPoints?: number }).maxTouchPoints ??
        0) > 1)
  );
}

export function isMobile(): boolean {
  return isAndroid() || isIOS();
}
