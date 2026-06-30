// XENO TOOL Web — browser bridge.
//
// The desktop/mobile apps run inside a Tauri webview, where `invoke()`
// dispatches over Tauri IPC to the Rust command layer. XENO TOOL Web
// runs the SAME React bundle in a plain browser (served by the engine
// at `host-ip:6969`), where there is no Tauri IPC. This module maps the
// `invoke()` command names the UI uses onto the engine's HTTP API so
// the exact same screens work over `fetch()` instead.
//
// The engine serves this UI same-origin, so every call is a RELATIVE
// path — no host/port juggling, no CORS. Commands that don't have an
// engine route yet throw a clear, catchable error so screens degrade
// gracefully (an error card) instead of white-screening.

type Args = Record<string, unknown> | undefined;

interface Route {
  method: "GET" | "POST";
  /** Build the request path (with query string) from the invoke args. */
  path: (a: Args) => string;
  /** For POST: the JSON body. Defaults to the raw args object. */
  body?: (a: Args) => unknown;
}

/** Build a `?k=v&…` query string, skipping null/undefined values. */
function q(params: Record<string, unknown>): string {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) u.set(k, String(v));
  }
  const s = u.toString();
  return s ? `?${s}` : "";
}

// Command → engine-route table. Seeded with the read-mostly PS5 ops the
// engine already exposes (Dashboard / Hardware / Installed Apps / Plugin
// Manager / Volumes). Extend this as more engine routes are wired; every
// entry added here lights up the matching screen in web mode.
const ROUTES: Record<string, Route> = {
  engine_version:     { method: "GET", path: () => "/api/version" },
  ps5_status:         { method: "GET", path: (a) => `/api/ps5/status${q({ addr: a?.addr })}` },
  ps5_hw_info:        { method: "GET", path: (a) => `/api/ps5/hw/info${q({ addr: a?.addr })}` },
  ps5_hw_temps:       { method: "GET", path: (a) => `/api/ps5/hw/temps${q({ addr: a?.addr, extended: a?.extended })}` },
  ps5_hw_power:       { method: "GET", path: (a) => `/api/ps5/hw/power${q({ addr: a?.addr })}` },
  ps5_hw_storage:     { method: "GET", path: (a) => `/api/ps5/hw/storage${q({ addr: a?.addr })}` },
  ps5_apps_installed: { method: "GET", path: (a) => `/api/ps5/apps/installed${q({ addr: a?.addr })}` },
  proc_list_get:      { method: "GET", path: (a) => `/api/ps5/proc/list${q({ addr: a?.addr })}` },
  ps5_volumes:        { method: "GET", path: (a) => `/api/ps5/volumes${q({ addr: a?.addr })}` },
  ps5_list_dir:       { method: "GET", path: (a) => `/api/ps5/list-dir${q({ addr: a?.addr, path: a?.path })}` },
  ps5_syslog_tail:    { method: "GET", path: (a) => `/api/ps5/syslog/tail${q({ addr: a?.addr })}` },
  // Write ops the engine already exposes (POST, body = args).
  app_launch:         { method: "POST", path: () => "/api/ps5/app/launch" },
  ps5_fs_delete:      { method: "POST", path: () => "/api/ps5/fs/delete" },
  ps5_fs_mkdir:       { method: "POST", path: () => "/api/ps5/fs/mkdir" },
};

/**
 * True when running as XENO TOOL Web — a plain browser with no Tauri
 * IPC. The Tauri desktop AND mobile webviews both inject
 * `__TAURI_INTERNALS__`, so this is false there and the normal IPC path
 * is used unchanged. Only a real browser tab (the engine-served web UI)
 * returns true.
 */
export function isWebMode(): boolean {
  return (
    typeof window !== "undefined" &&
    !("__TAURI_INTERNALS__" in window) &&
    !("__TAURI__" in window)
  );
}

/** Commands with a known engine route — used by callers that want to
 *  feature-detect before invoking (optional). */
export function webSupports(cmd: string): boolean {
  return cmd in ROUTES;
}

/**
 * Execute a UI `invoke()` over the engine's HTTP API. Throws a clear,
 * catchable Error for commands not yet mapped so the calling screen can
 * show an error state instead of crashing.
 */
export async function webInvoke<T>(cmd: string, args?: Args): Promise<T> {
  const route = ROUTES[cmd];
  if (!route) {
    throw new Error(`"${cmd}" isn't available in XENO TOOL Web yet`);
  }
  const init: RequestInit = { method: route.method };
  if (route.method === "POST") {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(route.body ? route.body(args) : args ?? {});
  }
  const res = await fetch(route.path(args), init);
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`${cmd} → HTTP ${res.status}${detail ? `: ${detail}` : ""}`);
  }
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}
