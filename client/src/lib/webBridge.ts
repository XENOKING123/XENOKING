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
  /** Return the response body as a raw string instead of JSON-parsing it
   *  (e.g. CheatRunner passthrough, CHANGELOG.md markdown). */
  raw?: boolean;
  /** Post-process the parsed JSON into the shape the UI expects (e.g.
   *  build TrainerRow[] from the bundled cheatslist). */
  transform?: (json: unknown) => unknown;
  /** Compute the return value directly without any fetch (e.g. return a
   *  URL string the UI drops straight into <img src>). */
  value?: (a: Args) => unknown;
}

/** Build the desktop `list_trainers` TrainerRow[] shape from the bundled
 *  cheatslist.json (the offline catalog of every game that has cheats —
 *  title, version, modders, and the cheat names per format). This is what
 *  powers the Trainers + Title Search tabs in web mode; the 9,200 actual
 *  trainer files aren't needed to browse — applying happens via CheatRunner
 *  (My Games). */
function cheatslistToRows(json: unknown): unknown {
  const data = json as {
    entries?: Array<{
      id: string;
      version?: string;
      title?: string;
      creators?: string[];
      formats?: Record<string, { hasFile?: boolean; cheats?: string[] }>;
    }>;
  };
  const rows: Array<{
    game: string;
    titleId: string;
    version: string;
    format: string;
    modder: string;
    cheats: string[];
    path: string;
  }> = [];
  for (const e of data.entries ?? []) {
    const modder = (e.creators ?? []).join(", ");
    for (const [fmt, info] of Object.entries(e.formats ?? {})) {
      if (!info?.hasFile) continue;
      rows.push({
        game: e.title || e.id,
        titleId: e.id,
        version: e.version || "",
        format: fmt.toUpperCase(),
        modder,
        cheats: info.cheats ?? [],
        path: "",
      });
    }
  }
  return rows;
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
  // On-console ELF passthrough endpoints (proxied to the payload's mgmt
  // server). The host engine exposes the same paths.
  profile_info:        { method: "GET", path: () => "/api/ps5/profile/info" },
  saves_list:          { method: "GET", path: () => "/api/ps5/list-saves" },
  user_list_get:       { method: "GET", path: () => "/api/ps5/users" },
  power_telemetry_get: { method: "GET", path: () => "/api/ps5/power/telemetry" },
  screenshots_list:    { method: "GET", path: () => "/api/ps5/list-screenshots" },
  screenshot_list:     { method: "GET", path: () => "/api/ps5/list-screenshots" },
  // Cheats — the ELF forwards to CheatRunner's own HTTP daemon (:9999).
  // Returns CheatRunner's raw body; cheatRunner.ts parses it itself.
  cheatrunner_get:     { method: "GET", raw: true, path: (a) => `/api/cr/get?path=${encodeURIComponent(String(a?.path ?? "/"))}` },
  // Cheat game icon — return a URL the <img> loads; the ELF proxies the
  // image from CheatRunner's /appdb/icon. (No fetch here.)
  cheatrunner_icon:    { method: "GET", path: () => "", value: (a) => `/api/cr/icon?id=${encodeURIComponent(String(a?.id ?? ""))}` },
  // Changelog — served as the embedded CHANGELOG.md (raw markdown).
  changelog_load:      { method: "GET", raw: true, path: () => "/CHANGELOG.md" },
  // Payloads catalog — the curated homebrew list, generated from the Rust
  // const into a static JSON bundled in dist (and pullable from GitHub).
  payloads_catalog:    { method: "GET", path: () => "/payloads-catalog.json" },
  // Trainers + Title Search — built from the bundled cheatslist (every
  // game with cheats: title, version, modders, cheat names per format).
  list_trainers:       { method: "GET", path: () => "/cheatslist.json", transform: cheatslistToRows },
  // Profile writes — POST forwards the JSON body to the payload's frame.
  profile_set_username: { method: "POST", path: () => "/api/ps5/profile/set-username" },
  profile_rename_user:  { method: "POST", path: () => "/api/ps5/profile/rename-user" },
  profile_activate:     { method: "POST", path: () => "/api/ps5/profile/activate" },
  profile_clear_slot:   { method: "POST", path: () => "/api/ps5/profile/clear-slot" },
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
  // `__XENO_WEB__` is set by webShim.ts when there's no real Tauri. We use
  // it (not the absence of `__TAURI_INTERNALS__`) because the shim itself
  // installs a `__TAURI_INTERNALS__` to capture raw invoke() calls.
  return (
    typeof window !== "undefined" &&
    (window as unknown as { __XENO_WEB__?: boolean }).__XENO_WEB__ === true
  );
}

// ── On-console mode (served by XENO-AIO.elf) ─────────────────────────────
// When the UI is served by the on-console ELF, the server IS the PS5, so
// the connection is definitionally live — there's nothing to probe over
// the network. `webAutoConnect` records that here; the bridge then
// answers the connectivity probes (`payload_check`) synthetically so the
// AppShell poller keeps the console "up" instead of overwriting it
// "down". On the PC host server this stays null and probes run for real.
let consoleInfo: { ip: string; version: string | null } | null = null;

export function setOnConsole(info: { ip: string; version: string | null } | null): void {
  consoleInfo = info;
}
export function isOnConsole(): boolean {
  return consoleInfo !== null;
}

/** Synthetic responses for connectivity probes when on-console. Returns
 *  `undefined` for commands that should still go through the HTTP bridge. */
function onConsoleSynthetic(cmd: string): unknown | undefined {
  if (!consoleInfo) return undefined;
  if (cmd === "payload_check") {
    return {
      reachable: true,
      loaded: true,
      status: {
        version: consoleInfo.version ?? undefined,
        ucred_elevated: true,
        max_transfer_streams: 4,
      },
    };
  }
  return undefined;
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
  // Tauri's own plugin commands (events, window, webview, path, …) have no
  // backend in web mode. No-op them so `listen()`/window calls degrade
  // quietly instead of throwing and crashing a screen on mount.
  if (cmd.startsWith("plugin:")) return undefined as T;

  // On-console connectivity probes resolve synthetically — the server is
  // the PS5, so it's always reachable.
  const synth = onConsoleSynthetic(cmd);
  if (synth !== undefined) return synth as T;

  const route = ROUTES[cmd];
  if (!route) {
    throw new Error(`"${cmd}" isn't available in XENO TOOL Web yet`);
  }
  // Pure value routes resolve locally (no network) — e.g. an icon URL.
  if (route.value) return route.value(args) as T;
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
  if (route.raw) return text as unknown as T;
  const parsed = text ? JSON.parse(text) : undefined;
  return (route.transform ? route.transform(parsed) : parsed) as T;
}
