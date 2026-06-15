import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  Star,
  Send,
  FolderOpen,
  RefreshCw,
  Rocket,
  CheckCircle2,
  XCircle,
  Loader2,
  FolderSearch,
} from "lucide-react";

import { Button } from "../../components";
import { pickPath } from "../../lib/pickPath";
import { sendPayload } from "../../api/ps5";
import { useConnectionStore, PS5_LOADER_PORT } from "../../state/connection";
import { pushNotification } from "../../state/notifications";

/**
 * Favorites tab of the Payloads screen — point it at YOUR folder of payloads,
 * star the ones you reach for, and inject all your favorites with one click.
 *
 * Self-contained (no props): reads the console IP from the connection store,
 * lists a chosen local folder via the `local_list_dir` command, and sends each
 * file through the same `sendPayload` path the Send tab and Connection screen
 * use. The chosen folder + the starred set persist in localStorage, so it
 * remembers your setup across launches.
 *
 * "Inject all favorites" fires the starred payloads sequentially with a short
 * gap between each (loaders dislike being hammered) and reports per-file
 * success/failure. Each file goes to the loader port typical for its extension
 * (.js→50000, .lua→9026, .jar→9025, .elf/.bin→9021) so a mixed favorites set
 * just works.
 */

const FOLDER_KEY = "xeno.payloads_folder";
const FAVS_KEY = "xeno.payloads_favorites";
const PAYLOAD_EXTS = ["elf", "bin", "js", "lua", "jar"];
const INJECT_GAP_MS = 350;

interface LocalEntry {
  name: string;
  path: string;
  is_dir: boolean;
  size: number;
}

type RowState =
  | { kind: "idle" }
  | { kind: "sending" }
  | { kind: "sent" }
  | { kind: "failed"; error: string };

function extOf(path: string): string {
  const m = path.toLowerCase().match(/\.([a-z0-9]+)$/);
  return m ? m[1] : "";
}

/** Loader port typical for a payload's extension (mirrors the Send tab). */
function portForPath(path: string): number {
  switch (extOf(path)) {
    case "js":
      return 50000;
    case "lua":
      return 9026;
    case "jar":
      return 9025;
    default:
      return PS5_LOADER_PORT; // .elf / .bin / unknown
  }
}

function prettySize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function fileName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

function loadFavs(): Set<string> {
  try {
    const raw = window.localStorage.getItem(FAVS_KEY);
    const arr = raw ? (JSON.parse(raw) as string[]) : [];
    return new Set(Array.isArray(arr) ? arr : []);
  } catch {
    return new Set();
  }
}

function saveFavs(s: Set<string>) {
  try {
    window.localStorage.setItem(FAVS_KEY, JSON.stringify([...s]));
  } catch {
    /* best-effort */
  }
}

export default function FavoritesPanel() {
  const host = useConnectionStore((s) => s.host);
  const [folder, setFolder] = useState<string | null>(() => {
    try {
      return window.localStorage.getItem(FOLDER_KEY);
    } catch {
      return null;
    }
  });
  const [entries, setEntries] = useState<LocalEntry[]>([]);
  const [favs, setFavs] = useState<Set<string>>(() => loadFavs());
  const [loading, setLoading] = useState(false);
  const [scanErr, setScanErr] = useState("");
  const [rowState, setRowState] = useState<Record<string, RowState>>({});
  const [injecting, setInjecting] = useState(false);
  const [injectProgress, setInjectProgress] = useState<{ done: number; total: number } | null>(null);

  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const scan = useCallback(async (dir: string) => {
    setLoading(true);
    setScanErr("");
    try {
      const all = await invoke<LocalEntry[]>("local_list_dir", { path: dir });
      const payloads = all.filter((e) => !e.is_dir && PAYLOAD_EXTS.includes(extOf(e.name)));
      if (alive.current) setEntries(payloads);
    } catch (e) {
      if (alive.current) {
        setEntries([]);
        setScanErr(e instanceof Error ? e.message : String(e));
      }
    } finally {
      if (alive.current) setLoading(false);
    }
  }, []);

  // Scan the saved folder on mount.
  useEffect(() => {
    if (folder) void scan(folder);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const chooseFolder = async () => {
    let picked: string | null;
    try {
      picked = await pickPath({ mode: "folder", title: "Choose your payloads folder" });
    } catch (e) {
      pushNotification("warning", "Couldn't open folder picker", {
        body: e instanceof Error ? e.message : String(e),
      });
      return;
    }
    if (typeof picked !== "string") return;
    setFolder(picked);
    try {
      window.localStorage.setItem(FOLDER_KEY, picked);
    } catch {
      /* best-effort */
    }
    void scan(picked);
  };

  const toggleFav = (path: string) => {
    setFavs((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      saveFavs(next);
      return next;
    });
  };

  /** Send one payload; updates that row's status. Returns true on success. */
  const sendOne = useCallback(
    async (path: string): Promise<boolean> => {
      if (!host?.trim()) {
        setRowState((s) => ({ ...s, [path]: { kind: "failed", error: "Connect a PS5 first" } }));
        return false;
      }
      setRowState((s) => ({ ...s, [path]: { kind: "sending" } }));
      try {
        await sendPayload(host.trim(), path, portForPath(path));
        if (alive.current) setRowState((s) => ({ ...s, [path]: { kind: "sent" } }));
        return true;
      } catch (e) {
        if (alive.current)
          setRowState((s) => ({
            ...s,
            [path]: { kind: "failed", error: e instanceof Error ? e.message : String(e) },
          }));
        return false;
      }
    },
    [host],
  );

  const favPaths = useMemo(
    () => entries.filter((e) => favs.has(e.path)).map((e) => e.path),
    [entries, favs],
  );

  const injectAll = async () => {
    if (injecting) return;
    if (!host?.trim()) {
      pushNotification("warning", "No PS5 connected", { body: "Set your console IP on the Connection screen first." });
      return;
    }
    if (favPaths.length === 0) return;
    setInjecting(true);
    let ok = 0;
    let fail = 0;
    for (let i = 0; i < favPaths.length; i++) {
      if (!alive.current) break;
      setInjectProgress({ done: i, total: favPaths.length });
      const success = await sendOne(favPaths[i]);
      if (success) ok++;
      else fail++;
      // Small gap so the loader isn't hammered. Skip after the last one.
      if (i < favPaths.length - 1) {
        await new Promise((r) => setTimeout(r, INJECT_GAP_MS));
      }
    }
    if (alive.current) {
      setInjectProgress({ done: favPaths.length, total: favPaths.length });
      setInjecting(false);
      pushNotification(fail === 0 ? "success" : "warning", "Inject all favorites", {
        body: `${ok} sent${fail ? `, ${fail} failed` : ""}.`,
      });
    }
  };

  return (
    <div className="space-y-4">
      {/* folder + connection bar */}
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] p-3">
        <FolderSearch size={16} className="shrink-0 text-[var(--color-muted)]" />
        <span className="min-w-0 flex-1 truncate text-xs text-[var(--color-muted)]">
          {folder ? folder : "No folder chosen — pick the folder where you keep your payloads."}
        </span>
        <Button variant="secondary" size="sm" leftIcon={<FolderOpen size={14} />} onClick={() => void chooseFolder()}>
          {folder ? "Change folder" : "Choose folder"}
        </Button>
        {folder && (
          <Button
            variant="ghost"
            size="sm"
            leftIcon={<RefreshCw size={14} className={loading ? "animate-spin" : ""} />}
            onClick={() => void scan(folder)}
            disabled={loading}
          >
            Rescan
          </Button>
        )}
      </div>

      {!host?.trim() && (
        <div className="rounded-lg border border-[var(--color-warn)]/50 bg-[var(--color-surface-2)] px-3 py-2 text-xs text-[var(--color-muted)]">
          No PS5 connected — set your console IP on the Connection screen, then come back to inject.
        </div>
      )}

      {/* favorites bar */}
      <section className="rounded-lg border border-[var(--color-gold)]/40 bg-[var(--color-surface-2)] p-4">
        <header className="mb-2 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Star size={15} className="fill-[var(--color-gold)] text-[var(--color-gold)]" />
            <h2 className="text-sm font-semibold">Favorites ({favPaths.length})</h2>
          </div>
          <Button
            variant="primary"
            size="sm"
            leftIcon={<Rocket size={14} />}
            loading={injecting}
            disabled={favPaths.length === 0 || !host?.trim()}
            onClick={() => void injectAll()}
          >
            {injecting && injectProgress
              ? `Injecting ${injectProgress.done}/${injectProgress.total}…`
              : "Inject all favorites"}
          </Button>
        </header>
        {favPaths.length === 0 ? (
          <p className="text-xs text-[var(--color-muted)]">
            Star payloads below to add them here, then inject them all at once.
          </p>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {favPaths.map((p) => (
              <span
                key={p}
                className="inline-flex items-center gap-1 rounded-full border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-0.5 text-[11px]"
                title={p}
              >
                <Star size={10} className="fill-[var(--color-gold)] text-[var(--color-gold)]" />
                {fileName(p)}
              </span>
            ))}
          </div>
        )}
      </section>

      {/* full list */}
      <section className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] p-4">
        <header className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold">
            Payloads in folder{entries.length ? ` (${entries.length})` : ""}
          </h2>
        </header>

        {loading ? (
          <div className="flex items-center justify-center gap-2 py-8 text-sm text-[var(--color-muted)]">
            <Loader2 size={16} className="animate-spin" /> Scanning…
          </div>
        ) : scanErr ? (
          <div className="rounded-md border border-[var(--color-bad)] bg-[var(--color-surface-3)] p-3 text-xs text-[var(--color-bad)]">
            Couldn't read that folder: {scanErr}
          </div>
        ) : entries.length === 0 ? (
          <div className="rounded-md border border-dashed border-[var(--color-border)] p-6 text-center text-xs text-[var(--color-muted)]">
            {folder
              ? "No .elf / .bin / .js / .lua / .jar files in this folder. Choose a different folder."
              : "Choose a folder above to list your payloads."}
          </div>
        ) : (
          <ul className="grid gap-1.5">
            {entries.map((e) => {
              const isFav = favs.has(e.path);
              const st = rowState[e.path] ?? { kind: "idle" };
              return (
                <li
                  key={e.path}
                  className="flex items-center gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2"
                >
                  <button
                    type="button"
                    onClick={() => toggleFav(e.path)}
                    title={isFav ? "Unstar" : "Star as favorite"}
                    className="shrink-0 rounded p-1 hover:bg-[var(--color-surface-3)]"
                  >
                    <Star
                      size={16}
                      className={
                        isFav
                          ? "fill-[var(--color-gold)] text-[var(--color-gold)]"
                          : "text-[var(--color-muted)]"
                      }
                    />
                  </button>
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-mono text-xs">{e.name}</div>
                    <div className="text-[10px] text-[var(--color-muted)]">
                      {prettySize(e.size)} · port {portForPath(e.path)}
                    </div>
                  </div>
                  {st.kind === "sent" && <CheckCircle2 size={15} className="shrink-0 text-[var(--color-good)]" />}
                  {st.kind === "failed" && (
                    <span title={st.error} className="shrink-0">
                      <XCircle size={15} className="text-[var(--color-bad)]" />
                    </span>
                  )}
                  <Button
                    variant="secondary"
                    size="sm"
                    leftIcon={
                      st.kind === "sending" ? (
                        <Loader2 size={13} className="animate-spin" />
                      ) : (
                        <Send size={13} />
                      )
                    }
                    disabled={st.kind === "sending" || injecting || !host?.trim()}
                    onClick={() => void sendOne(e.path)}
                  >
                    Send
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
