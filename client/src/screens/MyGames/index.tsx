import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Gamepad2, RefreshCw, Search, X, Zap, ZapOff, Play, Square, Upload } from "lucide-react";

import { PageHeader, Button, EmptyState } from "../../components";
import { useConnectionStore } from "../../state/connection";
import {
  listGames,
  cheatState,
  toggleCheat,
  disableAll,
  launchGame,
  closeGame,
  uploadCheatFile,
  type CRGame,
  type CRCheat,
} from "../../lib/cheatRunner";
import { friendlyCheatRunnerError } from "../../lib/cheatErrors";
import { useGameCover } from "../../lib/covers";
import { listTrainers, type TrainerRow } from "../../lib/trainers";

/**
 * XENO My Games / Trainers — CheatRunner (:9999). Lists installed games with
 * covers, Play / Cheats / Close. The Cheats dialog pulls live cheats from
 * CheatRunner (toggle live) and, if the console has none for that game, falls
 * back to showing the cheats from the synced local trainer library.
 */
function playSfx(name: "on" | "off") {
  try {
    const a = new Audio(`/${name}.wav`);
    a.volume = 0.5;
    void a.play().catch(() => {});
  } catch {
    /* no audio */
  }
}

export default function MyGamesScreen() {
  const host = useConnectionStore((s) => s.host);
  const [games, setGames] = useState<CRGame[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [term, setTerm] = useState("");
  const [cheatsFor, setCheatsFor] = useState<CRGame | null>(null);

  const refresh = useCallback(async () => {
    if (!host?.trim()) {
      setErr("Connect a PS5 first (Connection tab).");
      setGames([]);
      return;
    }
    setBusy(true);
    setErr("");
    try {
      const list = await listGames(host);
      list.sort(
        (a, b) =>
          Number(b.running) - Number(a.running) ||
          Number(b.hasCheat) - Number(a.hasCheat) ||
          a.name.localeCompare(b.name),
      );
      setGames(list);
      if (list.length === 0) setErr("CheatRunner returned no games. Is it running on the PS5?");
    } catch (e) {
      setErr(`CheatRunner not reachable on ${host}:9999 — load it on the PS5, then Refresh. (${e})`);
      setGames([]);
    } finally {
      setBusy(false);
    }
  }, [host]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const filtered = useMemo(() => {
    const t = term.trim().toLowerCase();
    return t
      ? games.filter((g) => g.name.toLowerCase().includes(t) || g.titleId.toLowerCase().includes(t))
      : games;
  }, [games, term]);

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        icon={Gamepad2}
        title="My Games"
        count={filtered.length}
        loading={busy}
        description="Installed games from CheatRunner (:9999). Play, open Cheats to toggle trainers, or close a running game."
        right={
          <Button
            variant="secondary"
            size="sm"
            leftIcon={<RefreshCw size={15} />}
            onClick={() => void refresh()}
            disabled={busy}
          >
            Refresh
          </Button>
        }
      />

      <div className="relative mb-3">
        <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-muted)]" />
        <input
          value={term}
          onChange={(e) => setTerm(e.target.value)}
          placeholder="Search your games…"
          className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] py-2 pl-9 pr-3 text-sm outline-none focus:border-[var(--color-accent)]"
        />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto pr-1">
        {filtered.length === 0 ? (
          <EmptyState
            icon={Gamepad2}
            title={busy ? "Loading…" : "No games"}
            message={busy ? "Asking CheatRunner…" : err || "Nothing to show yet."}
          />
        ) : (
          <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(184px, 1fr))" }}>
            {filtered.map((g) => (
              <GameCard key={g.titleId} host={host} game={g} onCheats={() => setCheatsFor(g)} />
            ))}
          </div>
        )}
      </div>

      {cheatsFor && <CheatsDialog host={host} game={cheatsFor} onClose={() => setCheatsFor(null)} />}
    </div>
  );
}

function GameCard({ host, game, onCheats }: { host: string; game: CRGame; onCheats: () => void }) {
  const cover = useGameCover(host, game.titleId, game.name);
  const [running, setRunning] = useState(game.running);
  const chipCls =
    game.platform === "PS5"
      ? "bg-[var(--color-ps5-soft)] text-[var(--color-ps5)]"
      : "bg-[var(--color-ps4-soft)] text-[var(--color-ps4)]";

  return (
    <div className="flex flex-col overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)]">
      <div className="relative aspect-[3/4] w-full bg-[var(--color-surface-3)]">
        {cover ? (
          <img src={cover} alt={game.name} className="h-full w-full object-cover" />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-3xl text-[var(--color-muted)]">🎮</div>
        )}
        {running && (
          <span className="absolute left-2 top-2 rounded-full bg-[var(--color-good-soft)] px-2 py-0.5 text-[10px] font-bold uppercase text-[var(--color-good)]">
            ● running
          </span>
        )}
      </div>
      <div className="flex flex-1 flex-col gap-2 p-2">
        <div className="line-clamp-2 text-xs font-semibold">{game.name}</div>
        <div className="flex items-center gap-1.5">
          <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${chipCls}`}>{game.titleId}</span>
        </div>
        <div className="mt-auto flex gap-1.5">
          <Button
            variant="secondary"
            size="sm"
            leftIcon={<Play size={13} />}
            onClick={() => {
              void launchGame(host, game.titleId).then((ok) => ok && setRunning(true));
            }}
          >
            Play
          </Button>
          <Button variant="primary" size="sm" leftIcon={<Zap size={13} />} onClick={onCheats}>
            Cheats
          </Button>
          {running && (
            <Button
              variant="ghost"
              size="sm"
              title="Close game"
              onClick={() => {
                void closeGame(host, game.titleId).then((ok) => ok && setRunning(false));
              }}
            >
              <Square size={13} />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

function CheatsDialog({ host, game, onClose }: { host: string; game: CRGame; onClose: () => void }) {
  const cover = useGameCover(host, game.titleId, game.name);
  const [cheats, setCheats] = useState<CRCheat[] | null>(null);
  // Local-library matches we could push to the console. JSON > SHN > MC4 ordered
  // so the user gets the most readable / most likely-to-apply variant on top.
  const [localMatches, setLocalMatches] = useState<TrainerRow[] | null>(null);
  const [err, setErr] = useState("");
  const [pending, setPending] = useState<number | null>(null);
  const [installingPath, setInstallingPath] = useState<string | null>(null);
  // Unmount guard so a toggle that resolves after the dialog closes doesn't
  // setState on an unmounted component.
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    setErr("");
    setLocalMatches(null);
    try {
      const live = await cheatState(host, game.titleId);
      if (!alive.current) return;
      if (live.length > 0) {
        setCheats(live);
        return;
      }
      throw new Error("empty");
    } catch (e) {
      if (!alive.current) return;
      // No cheats on the console yet — find candidates in our local library so
      // the user can push one with one click instead of FTPing it by hand.
      setCheats([]);
      try {
        const all = await listTrainers();
        if (!alive.current) return;
        const tid = game.titleId.toUpperCase();
        const norm = (s: string) => (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
        const gname = norm(game.name);
        const matches = all.filter((t: TrainerRow) => {
          if (t.titleId.toUpperCase() === tid) return true;
          if (gname.length > 2 && norm(t.game) === gname) return true;
          if (gname.length > 4) {
            const tn = norm(t.game);
            if (tn && (tn.includes(gname) || gname.includes(tn))) return true;
          }
          return false;
        });
        const fmtRank: Record<string, number> = { JSON: 0, SHN: 1, MC4: 2, XML: 3 };
        matches.sort(
          (a, b) =>
            (fmtRank[a.format] ?? 9) - (fmtRank[b.format] ?? 9) ||
            b.cheats.length - a.cheats.length,
        );
        if (matches.length > 0) {
          setLocalMatches(matches);
        } else {
          // Surface the underlying CheatRunner error if that's why we got here.
          setErr(
            (e instanceof Error && e.message !== "empty"
              ? friendlyCheatRunnerError(e, "state") + " "
              : "") +
              `No cheats for ${game.titleId} on the console or in the local library.`,
          );
        }
      } catch (e2) {
        if (alive.current) setErr(friendlyCheatRunnerError(e2, "state"));
      }
    }
  }, [host, game.titleId, game.name]);

  /** Push a local cheat file to the PS5 via CheatRunner /api/cheats/upload,
   *  then re-query so the live-cheats branch takes over with real toggles
   *  that actually write to the running game. */
  const installToConsole = useCallback(
    async (row: TrainerRow) => {
      if (installingPath) return;
      setInstallingPath(row.path);
      setErr("");
      try {
        await uploadCheatFile(host, row.path);
        // small delay — CheatRunner scans the dir on next /state hit, but a
        // breath helps when the console is sluggish.
        await new Promise((r) => setTimeout(r, 250));
        if (alive.current) await load();
      } catch (e) {
        if (alive.current) setErr(friendlyCheatRunnerError(e, "upload"));
      } finally {
        if (alive.current) setInstallingPath(null);
      }
    },
    [host, installingPath, load],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const onToggle = async (c: CRCheat) => {
    // Serialize: one toggle at a time so rapid clicks can't interleave.
    if (pending !== null) return;
    const next = !c.state;
    setPending(c.index);
    playSfx(next ? "on" : "off");
    setCheats((cur) => (cur ? cur.map((x) => (x.index === c.index ? { ...x, state: next } : x)) : cur));
    try {
      await toggleCheat(host, game.titleId, c.index, next);
    } catch (e) {
      if (alive.current) {
        setCheats((cur) => (cur ? cur.map((x) => (x.index === c.index ? { ...x, state: c.state } : x)) : cur));
        setErr(friendlyCheatRunnerError(e, "toggle"));
      }
    } finally {
      if (alive.current) setPending(null);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6" onClick={onClose}>
      <div
        className="relative flex max-h-[82vh] w-full max-w-xl flex-col overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* game cover header background */}
        <div className="relative h-40 w-full overflow-hidden">
          {cover && (
            <img src={cover} alt="" className="absolute inset-0 h-full w-full scale-110 object-cover opacity-70 blur-[1px]" />
          )}
          <div className="absolute inset-0 bg-gradient-to-t from-[var(--color-surface)] via-[var(--color-surface)]/70 to-transparent" />
          <div className="relative flex h-full items-end justify-between gap-3 p-4">
            <div>
              <div className="text-lg font-bold drop-shadow">{game.name}</div>
              <div className="text-xs text-[var(--color-muted)]">
                {game.titleId} · {game.platform}
                {!game.running && <span className="text-[var(--color-warn)]"> · not running</span>}
              </div>
            </div>
            <button onClick={onClose} className="text-[var(--color-muted)] hover:text-[var(--color-text)]">
              <X size={20} />
            </button>
          </div>
        </div>

        <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto p-4">
          {cheats === null && (
            <div className="py-8 text-center text-sm text-[var(--color-muted)]">Loading cheats…</div>
          )}
          {/* live cheats — toggle on the running game */}
          {cheats?.map((c) => (
            <button
              key={c.index}
              disabled={pending === c.index}
              onClick={() => void onToggle(c)}
              className={`flex w-full items-center justify-between gap-3 rounded-lg border px-3 py-2 text-left text-sm transition ${
                c.state
                  ? "border-[var(--color-good)] bg-[var(--color-good-soft)]"
                  : "border-[var(--color-bad)]/50 bg-[var(--color-bad-soft)]"
              }`}
            >
              <span className="flex items-center gap-2">
                {c.state ? <Zap size={15} className="text-[var(--color-good)]" /> : <ZapOff size={15} className="text-[var(--color-bad)]" />}
                {c.name}
              </span>
              {/* red/green pill switch */}
              <span
                className={`flex h-5 w-10 items-center rounded-full px-0.5 transition ${
                  c.state ? "justify-end bg-[var(--color-good)]" : "justify-start bg-[var(--color-bad)]"
                }`}
              >
                <span className="h-4 w-4 rounded-full bg-white shadow" />
              </span>
            </button>
          ))}
          {/* Local-library candidates — push to PS5 with one click so CheatRunner
              loads them, then this dialog flips to the live-toggle view above. */}
          {localMatches && localMatches.length > 0 && (
            <>
              <div className="pt-1 text-[11px] font-semibold uppercase tracking-wide text-[var(--color-gold)]">
                ◆ Install to console ({localMatches.length} found)
              </div>
              <p className="text-[11px] text-[var(--color-muted)]">
                CheatRunner has no cheats loaded for this game yet. Pick a variant below to push it to{" "}
                <code className="text-[var(--color-text)]">/data/cheatrunner/cheats/</code>; the toggles
                will appear automatically once it's there.
              </p>
              {localMatches.map((row) => {
                const filename = row.path.replace(/^.*[\\/]/, "");
                const installing = installingPath === row.path;
                const anyInstalling = installingPath !== null;
                return (
                  <div
                    key={row.path}
                    className="flex items-center justify-between gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-2 text-sm"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="rounded bg-[var(--color-surface-3)] px-1.5 py-0.5 text-[10px] font-bold uppercase">
                          {row.format}
                        </span>
                        <span className="truncate" title={filename}>
                          {filename}
                        </span>
                      </div>
                      <div className="mt-0.5 text-[10px] text-[var(--color-muted)]">
                        {row.cheats.length > 0
                          ? `${row.cheats.length} cheat${row.cheats.length === 1 ? "" : "s"}`
                          : "cheat names embedded on console"}
                        {row.version ? ` · v${row.version}` : ""}
                        {row.modder ? ` · ${row.modder}` : ""}
                      </div>
                    </div>
                    <Button
                      variant={installing ? "ghost" : "primary"}
                      size="sm"
                      leftIcon={<Upload size={13} />}
                      loading={installing}
                      disabled={anyInstalling}
                      onClick={() => void installToConsole(row)}
                    >
                      {installing ? "Sending…" : "Install"}
                    </Button>
                  </div>
                );
              })}
            </>
          )}
          {cheats?.length === 0 && !localMatches && err && (
            <div className="py-6 text-center text-sm text-[var(--color-muted)]">{err}</div>
          )}
          {err && (cheats?.length || (localMatches && localMatches.length > 0)) && (
            <div className="mt-2 rounded border border-[var(--color-bad)]/40 bg-[var(--color-bad-soft)] px-3 py-2 text-[11px] text-[var(--color-bad)]">
              {err}
            </div>
          )}
        </div>

        <div className="flex gap-2 border-t border-[var(--color-border)] p-3">
          <Button variant="secondary" size="sm" onClick={() => void load()}>Reload</Button>
          <Button
            variant="danger"
            size="sm"
            leftIcon={<ZapOff size={14} />}
            onClick={() => void disableAll(host, game.titleId).then(() => { playSfx("off"); void load(); })}
            disabled={!cheats?.length}
          >
            Disable all
          </Button>
          <div className="flex-1" />
          <Button variant="ghost" size="sm" onClick={onClose}>Close</Button>
        </div>
      </div>
    </div>
  );
}
