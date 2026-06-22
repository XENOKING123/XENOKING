// XENO Trainers/Cheats — client for CheatRunner, the on-console web cheat
// engine (http://<ps5-ip>:9999). Open API, CORS *, no auth. All requests go
// through the Rust `cheatrunner_get` / `cheatrunner_icon` commands (CSP-free,
// icons returned as data: URIs). Field parsing is defensive because the raw
// CheatRunner JSON varies by build.
import { invoke } from "@tauri-apps/api/core";

export interface CRGame {
  titleId: string;
  name: string;
  platform: "PS5" | "PS4" | "APP";
  version: string;
  running: boolean;
  hasCheat: boolean;
  isApp: boolean;
}

export interface CRCheat {
  index: number;
  name: string;
  state: boolean;
}

async function crGet(ip: string, path: string): Promise<unknown> {
  const text = await invoke<string>("cheatrunner_get", { ip, path });
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function platformOf(tid: string): "PS5" | "PS4" | "APP" {
  const t = (tid || "").toUpperCase();
  if (t.startsWith("PPSA")) return "PS5";
  if (t.startsWith("CUSA")) return "PS4";
  return "APP";
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function pick(o: any, ...keys: string[]): any {
  for (const k of keys) if (o?.[k] !== undefined && o[k] !== null) return o[k];
  return undefined;
}

export async function listGames(ip: string): Promise<CRGame[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const d: any = await crGet(ip, "/api/games");
  const arr: unknown[] = Array.isArray(d) ? d : (d?.games ?? d?.list ?? []);
  return arr
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .map((g: any) => {
      const rawId = String(pick(g, "title_id", "titleId", "id", "titleid", "cusa") ?? "");
      const titleId = rawId.split("_")[0];
      return {
        titleId,
        name: String(pick(g, "name", "title", "app_name") ?? titleId),
        platform: platformOf(titleId),
        version: String(pick(g, "version", "app_ver", "ver") ?? ""),
        running: Boolean(pick(g, "running", "isRunning", "active", "is_running")),
        hasCheat: Boolean(pick(g, "has_cheat", "hasCheat", "cheat", "has_trainer")),
        isApp: Boolean(pick(g, "is_app", "isApp")),
      } as CRGame;
    })
    .filter((g) => g.titleId);
}

export async function cheatState(ip: string, titleId: string): Promise<CRCheat[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const d: any = await crGet(
    ip,
    `/api/cheats/state?titleId=${encodeURIComponent(titleId)}&debug=1`,
  );
  const arr: unknown[] = Array.isArray(d) ? d : (d?.cheats ?? d?.state ?? d?.mods ?? []);
  return arr
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .map((c: any, i: number) => ({
      index: Number(pick(c, "index", "idx", "i") ?? i),
      name: String(pick(c, "name", "text", "title") ?? `Cheat ${i + 1}`),
      state: Boolean(pick(c, "state", "on", "enabled", "active")),
    }))
    .filter((c) => c.name);
}

export async function toggleCheat(
  ip: string,
  titleId: string,
  index: number,
  on: boolean,
): Promise<void> {
  await crGet(
    ip,
    `/api/cheats/toggle?titleId=${encodeURIComponent(titleId)}&index=${index}&on=${on ? 1 : 0}`,
  );
}

export async function disableAll(ip: string, titleId: string): Promise<void> {
  await crGet(ip, `/api/cheats/disable-all?titleId=${encodeURIComponent(titleId)}`);
}

/** Launch a game on the console (CheatRunner /launch). */
export async function launchGame(ip: string, titleId: string): Promise<boolean> {
  for (const path of [
    `/launch?titleId=${encodeURIComponent(titleId)}`,
    `/api/launch?titleId=${encodeURIComponent(titleId)}`,
  ]) {
    try {
      await crGet(ip, path);
      return true;
    } catch {
      /* try next */
    }
  }
  return false;
}

/** Close / kill the running game (best-effort across known endpoints). */
export async function closeGame(ip: string, titleId: string): Promise<boolean> {
  for (const path of [
    `/api/kill?titleId=${encodeURIComponent(titleId)}`,
    `/kill?titleId=${encodeURIComponent(titleId)}`,
    `/api/close?titleId=${encodeURIComponent(titleId)}`,
    `/close?titleId=${encodeURIComponent(titleId)}`,
  ]) {
    try {
      await crGet(ip, path);
      return true;
    } catch {
      /* try next */
    }
  }
  return false;
}

export async function gameIcon(ip: string, id: string): Promise<string | null> {
  try {
    return await invoke<string>("cheatrunner_icon", { ip, id });
  } catch {
    return null;
  }
}

/** Quick reachability probe — true if CheatRunner answers on :9999. */
export async function cheatRunnerUp(ip: string): Promise<boolean> {
  try {
    await crGet(ip, "/api/state");
    return true;
  } catch {
    return false;
  }
}

/**
 * Rewrite a local cheat-file basename so CheatRunner's `is_safe_filename`
 * accepts it: only `[A-Za-z0-9._-]` survive; the extension is forced lowercase;
 * `.ShnExt` / `.SHNEXT` is remapped to `.shn` (CheatRunner only accepts
 * `.json` / `.shn` / `.mc4`). Leaves the title-id and version intact so the
 * daemon's filename-matching keeps working.
 */
export function sanitizeCheatFilename(name: string): string {
  const lastDot = name.lastIndexOf(".");
  const stem = lastDot >= 0 ? name.slice(0, lastDot) : name;
  let ext = lastDot >= 0 ? name.slice(lastDot + 1).toLowerCase() : "";
  if (ext === "shnext") ext = "shn";
  // Strip illegal chars; collapse runs of underscores; trim leading/trailing dots.
  const safeStem = stem
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^[._]+|[._]+$/g, "");
  return ext ? `${safeStem}.${ext}` : safeStem;
}

/**
 * Push a local cheat file (json / shn / mc4) to the PS5's
 * `/data/cheatrunner/cheats/{format}/` via CheatRunner's `POST
 * /api/cheats/upload`. Returns the daemon's JSON response body.
 * Throws a friendly Error on validation / network failure.
 */
export async function uploadCheatFile(
  ip: string,
  localPath: string,
  filenameHint?: string,
): Promise<string> {
  const base = filenameHint ?? localPath.replace(/^.*[\\/]/, "");
  const filename = sanitizeCheatFilename(base);
  return await invoke<string>("cheatrunner_upload", {
    ip,
    filename,
    localPath,
  });
}

/**
 * "Attach"-equivalent for CheatRunner. CR has no real attach step — once the
 * game is running and CR has cheats loaded, /api/cheats/state returns mods.
 * This launches the game (if not running) and polls until cheats appear.
 * Returns { ok, cheats, launched } so the UI can render the right outcome.
 */
export async function attachCheatRunner(
  ip: string,
  titleId: string,
  opts?: { running?: boolean; timeoutMs?: number; intervalMs?: number },
): Promise<{ ok: boolean; cheats: number; launched: boolean; message: string }> {
  const timeout = opts?.timeoutMs ?? 9000;
  const interval = opts?.intervalMs ?? 750;
  let launched = false;
  if (!opts?.running) {
    try {
      launched = await launchGame(ip, titleId);
    } catch {
      /* CR will still answer state; launch is best-effort */
    }
  }
  const deadline = Date.now() + timeout;
  let lastCount = 0;
  while (Date.now() < deadline) {
    try {
      const state = await cheatState(ip, titleId);
      lastCount = state.length;
      if (state.length > 0) {
        return {
          ok: true,
          cheats: state.length,
          launched,
          message: `CheatRunner has ${state.length} cheat${state.length === 1 ? "" : "s"} loaded`,
        };
      }
    } catch {
      /* keep polling */
    }
    await new Promise((r) => setTimeout(r, interval));
  }
  return {
    ok: false,
    cheats: lastCount,
    launched,
    message: launched
      ? "Game launched but CheatRunner has no cheats for it yet — install one below."
      : "CheatRunner has no cheats for this game yet — install one below.",
  };
}

/** Trigger CheatRunner's own repo-mirror to pull cheats from configured sources
 *  (hencollection / ps5cheats / goldhen / henppsa / all) onto the PS5 itself. */
export async function cheatRepoSync(
  ip: string,
  source: "all" | "hencollection" | "ps5cheats" | "goldhen" | "henppsa" = "all",
  overwrite = false,
): Promise<string> {
  return await invoke<string>("cheatrunner_get", {
    ip,
    path: `/api/cheats/repo/download?source=${source}&overwrite=${overwrite ? 1 : 0}`,
  });
}

/** Poll CheatRunner's repo-mirror status; returns the raw JSON response. */
export async function cheatRepoSyncStatus(ip: string): Promise<string> {
  return await invoke<string>("cheatrunner_get", {
    ip,
    path: "/api/cheats/repo/download/status",
  });
}
