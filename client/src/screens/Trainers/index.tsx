import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Target, Search, X, Zap, ZapOff, Download, Plug, PlugZap } from "lucide-react";

import { PageHeader, Button, EmptyState } from "../../components";
import { useConnectionStore } from "../../state/connection";
import { useGameCover } from "../../lib/covers";
import { listTrainers, cheatSync, type TrainerRow } from "../../lib/trainers";
import { attach, applyCheat, type AttachInfo } from "../../lib/ps5debug";

function playSfx(name: "on" | "off") {
  try {
    const a = new Audio(`/${name}.wav`);
    a.volume = 0.5;
    void a.play().catch(() => {});
  } catch {
    /* no audio */
  }
}

/**
 * XENO Trainers — the full local trainer library as ONE card per game. Multiple
 * trainer files for the same title (different versions / formats / modders) are
 * merged into a single showcase card; open it and pick the version on the side.
 * Covers via covers.json. Apply from My Games while the game runs (ps5debug soon).
 */
type Fmt = "ALL" | "JSON" | "SHN" | "MC4";
type Plat = "ALL" | "PS5" | "PS4";

interface Group {
  key: string;
  game: string;
  titleId: string;
  platform: "PS5" | "PS4";
  variants: TrainerRow[];
  cheatCount: number;
}

function platOf(titleId: string): "PS5" | "PS4" {
  return titleId.toUpperCase().startsWith("PPSA") ? "PS5" : "PS4";
}

function groupRows(rows: TrainerRow[]): Group[] {
  const m = new Map<string, Group>();
  for (const r of rows) {
    const key = (r.titleId || r.game).toUpperCase();
    let g = m.get(key);
    if (!g) {
      g = {
        key,
        game: r.game || r.titleId,
        titleId: r.titleId,
        platform: platOf(r.titleId),
        variants: [],
        cheatCount: 0,
      };
      m.set(key, g);
    }
    g.variants.push(r);
    if (!g.game && r.game) g.game = r.game;
  }
  for (const g of m.values()) {
    // best variant first (most cheats), tally the max cheat count
    g.variants.sort((a, b) => b.cheats.length - a.cheats.length);
    g.cheatCount = g.variants[0]?.cheats.length || 0;
  }
  return [...m.values()].sort((a, b) => a.game.toLowerCase().localeCompare(b.game.toLowerCase()));
}

export default function TrainersScreen() {
  const host = useConnectionStore((s) => s.host);
  const [rows, setRows] = useState<TrainerRow[]>([]);
  const [term, setTerm] = useState("");
  const [fmt, setFmt] = useState<Fmt>("ALL");
  const [plat, setPlat] = useState<Plat>("ALL");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [open, setOpen] = useState<Group | null>(null);

  const load = useCallback(async () => {
    setBusy(true);
    try {
      const list = await listTrainers();
      setRows(list);
      setStatus(list.length === 0 ? "No trainers yet — hit “Sync now”." : "");
    } finally {
      setBusy(false);
    }
  }, []);

  const sync = useCallback(async () => {
    setBusy(true);
    setStatus("Syncing cheats from the repos… (first run downloads a lot — give it a minute)");
    try {
      const r = await cheatSync(true);
      setStatus(`Synced ${r.total} cheat files. Loading…`);
      await load();
    } catch (e) {
      setStatus(`Sync failed: ${e}`);
      setBusy(false);
    }
  }, [load]);

  useEffect(() => {
    void (async () => {
      const list = await listTrainers();
      setRows(list);
      if (list.length === 0) void sync();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const groups = useMemo(() => {
    const t = term.trim().toLowerCase();
    const filtered = rows.filter((r) => {
      if (fmt !== "ALL" && r.format !== fmt) return false;
      if (plat !== "ALL" && platOf(r.titleId) !== plat) return false;
      if (t && !(`${r.game}`.toLowerCase().includes(t) || `${r.titleId}`.toLowerCase().includes(t)))
        return false;
      return true;
    });
    return groupRows(filtered);
  }, [rows, term, fmt, plat]);

  // Total games in the WHOLE library (ignores search/filters) — so the header
  // count + empty-search message never make a loaded 9k library look empty.
  const libraryCount = useMemo(
    () => new Set(rows.map((r) => (r.titleId || r.game).toUpperCase())).size,
    [rows],
  );

  const shown = groups.slice(0, 260);

  const chip = (active: boolean) =>
    `rounded-md px-2.5 py-1 text-xs font-semibold ${
      active ? "bg-[var(--color-gold)] text-[#1a1206]" : "bg-[var(--color-surface-3)] text-[var(--color-muted)]"
    }`;

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        icon={Target}
        title="Trainers"
        count={libraryCount}
        loading={busy}
        description="The full XENO trainer library — one card per game, all versions merged. Open one to pick a version and see its cheats. Apply from My Games while the game runs."
        right={
          <Button variant="primary" size="sm" leftIcon={<Download size={15} />} onClick={() => void sync()} disabled={busy}>
            Sync now
          </Button>
        }
      />

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="relative min-w-[220px] flex-1">
          <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-muted)]" />
          <input
            value={term}
            onChange={(e) => setTerm(e.target.value)}
            placeholder="Search game or CUSA/PPSA…"
            className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] py-2 pl-9 pr-3 text-sm outline-none focus:border-[var(--color-gold)]"
          />
        </div>
        <div className="flex items-center gap-1">
          {(["ALL", "PS5", "PS4"] as Plat[]).map((p) => (
            <button key={p} className={chip(plat === p)} onClick={() => setPlat(p)}>{p}</button>
          ))}
        </div>
        <div className="flex items-center gap-1">
          {(["ALL", "JSON", "SHN", "MC4"] as Fmt[]).map((f) => (
            <button key={f} className={chip(fmt === f)} onClick={() => setFmt(f)}>{f}</button>
          ))}
        </div>
      </div>

      {status && <div className="mb-2 text-xs text-[var(--color-muted)]">{status}</div>}

      <div className="min-h-0 flex-1 overflow-y-auto pr-1">
        {groups.length === 0 ? (
          <EmptyState
            icon={Target}
            title={busy ? "Working…" : rows.length === 0 ? "No trainers yet" : "No match"}
            message={
              busy
                ? "Syncing / loading…"
                : rows.length === 0
                  ? status || "Hit Sync now."
                  : `No trainer for “${term || "that filter"}”. Your library has ${libraryCount.toLocaleString()} games — try another name (e.g. Elden Ring, God of War, Spider-Man).`
            }
          />
        ) : (
          <>
            <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))" }}>
              {shown.map((g) => (
                <TrainerCard key={g.key} host={host} group={g} onOpen={() => setOpen(g)} />
              ))}
            </div>
            {groups.length > shown.length && (
              <div className="py-3 text-center text-xs text-[var(--color-muted)]">
                Showing {shown.length} of {groups.length} games — filter/search to narrow.
              </div>
            )}
          </>
        )}
      </div>

      {open && <CheatModal host={host} group={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

function TrainerCard({ host, group, onOpen }: { host: string; group: Group; onOpen: () => void }) {
  const cover = useGameCover(host, group.titleId, group.game);
  return (
    <button
      onClick={onOpen}
      className="group flex flex-col overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)] text-left transition hover:border-[var(--color-gold)]"
    >
      <div className="relative aspect-[3/4] w-full bg-[var(--color-surface-3)]">
        {cover ? (
          <img src={cover} alt="" className="h-full w-full object-cover" />
        ) : (
          <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-[var(--color-surface-3)] to-[var(--color-surface)] text-3xl font-black text-[var(--color-gold)]">
            {(group.game || group.titleId || "?").slice(0, 1).toUpperCase()}
          </div>
        )}
        <span className={`absolute left-1.5 top-1.5 rounded px-1.5 py-0.5 text-[9px] font-bold ${group.platform === "PS5" ? "bg-[var(--color-ps5-soft)] text-[var(--color-ps5)]" : "bg-[var(--color-ps4-soft)] text-[var(--color-ps4)]"}`}>
          {group.platform}
        </span>
        {group.variants.length > 1 && (
          <span className="absolute right-1.5 top-1.5 rounded-full bg-[var(--color-gold)] px-1.5 py-0.5 text-[9px] font-bold text-[#1a1206]">
            {group.variants.length} versions
          </span>
        )}
        <span className="absolute bottom-1.5 right-1.5 rounded-full bg-black/60 px-1.5 py-0.5 text-[9px] font-bold text-[var(--color-gold)]">
          {group.cheatCount} cheats
        </span>
      </div>
      <div className="p-2">
        <div className="line-clamp-2 text-xs font-semibold">{group.game || group.titleId}</div>
        <div className="text-[10px] text-[var(--color-muted)]">{group.titleId}</div>
      </div>
    </button>
  );
}

function CheatModal({ host, group, onClose }: { host: string; group: Group; onClose: () => void }) {
  const cover = useGameCover(host, group.titleId, group.game);
  const [sel, setSel] = useState(0);
  const variant = group.variants[sel] || group.variants[0];
  const [att, setAtt] = useState<AttachInfo | null>(null);
  const [attaching, setAttaching] = useState(false);
  const [on, setOn] = useState<Set<number>>(new Set());
  const [busyIdx, setBusyIdx] = useState<number | null>(null);
  const [detaching, setDetaching] = useState(false);
  // Serialize ALL memory writes — ps5debug is happiest with one write at a
  // time, so we never let two toggles (or a detach) overlap on the wire.
  const applying = busyIdx !== null || detaching;
  // Unmount guard: the modal can close mid-write (await in flight). Without
  // this, the post-await setState fires on an unmounted component (React warns
  // and the revert is silently lost). `alive.current` gates every setter.
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // reset toggles when switching version
  useEffect(() => setOn(new Set()), [sel]);

  const doAttach = async () => {
    if (!host?.trim()) {
      setAtt({ ok: false, pid: 0, message: "Connect a PS5 first (Connection tab)." });
      return;
    }
    setAttaching(true);
    try {
      const info = await attach(host);
      if (alive.current) setAtt(info);
    } catch (e) {
      if (alive.current) setAtt({ ok: false, pid: 0, message: String(e) });
    } finally {
      if (alive.current) setAttaching(false);
    }
  };

  /** Detach: turn every on-cheat back OFF (restores the game's original bytes),
   *  then drop the attached state. Reverts highest index first so the order
   *  mirrors how they'd be undone by hand. One failed revert doesn't abort the
   *  rest. */
  const doDetach = async () => {
    if (applying) return;
    setDetaching(true);
    try {
      if (att?.ok) {
        const indices = Array.from(on).sort((a, b) => b - a);
        for (const i of indices) {
          try {
            await applyCheat(host, variant.path, i, false);
          } catch {
            /* keep reverting the rest even if one fails */
          }
        }
      }
      if (on.size) playSfx("off");
      if (alive.current) {
        setOn(new Set());
        setAtt(null);
      }
    } finally {
      if (alive.current) setDetaching(false);
    }
  };

  const onToggle = async (i: number) => {
    // Serialize: ignore clicks while any write (toggle or detach) is in flight.
    if (applying) return;
    const enable = !on.has(i);
    playSfx(enable ? "on" : "off");
    setOn((p) => {
      const n = new Set(p);
      if (enable) n.add(i);
      else n.delete(i);
      return n;
    });
    if (att?.ok) {
      setBusyIdx(i);
      try {
        await applyCheat(host, variant.path, i, enable);
      } catch {
        // revert the optimistic toggle on failure
        if (alive.current)
          setOn((p) => {
            const n = new Set(p);
            if (enable) n.delete(i);
            else n.add(i);
            return n;
          });
      } finally {
        if (alive.current) setBusyIdx(null);
      }
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6" onClick={onClose}>
      <div
        className="relative flex max-h-[84vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="relative h-32 w-full overflow-hidden">
          {cover && <img src={cover} alt="" className="absolute inset-0 h-full w-full scale-110 object-cover opacity-70 blur-[1px]" />}
          <div className="absolute inset-0 bg-gradient-to-t from-[var(--color-surface)] via-[var(--color-surface)]/70 to-transparent" />
          <div className="relative flex h-full items-end justify-between gap-3 p-4">
            <div>
              <div className="text-lg font-bold drop-shadow">{group.game || group.titleId}</div>
              <div className="text-xs text-[var(--color-muted)]">
                {group.titleId} · {group.platform} · {group.variants.length} version{group.variants.length === 1 ? "" : "s"}
              </div>
            </div>
            <button onClick={onClose} className="text-[var(--color-muted)] hover:text-[var(--color-text)]"><X size={20} /></button>
          </div>
        </div>

        <div className="flex min-h-0 flex-1">
          {/* version selector — right-side rail (or top on a single variant) */}
          {group.variants.length > 1 && (
            <div className="w-44 shrink-0 space-y-1 overflow-y-auto border-r border-[var(--color-border)] p-2">
              <div className="px-1 pb-1 text-[10px] font-bold uppercase tracking-wide text-[var(--color-muted)]">Versions</div>
              {group.variants.map((v, i) => (
                <button
                  key={v.path}
                  onClick={() => setSel(i)}
                  className={`w-full rounded-lg border px-2 py-1.5 text-left text-[11px] transition ${
                    i === sel ? "border-[var(--color-gold)] bg-[var(--color-gold-soft)]" : "border-[var(--color-border)] hover:border-[var(--color-border-strong)]"
                  }`}
                >
                  <div className="font-semibold">{v.version ? `v${v.version}` : v.format}</div>
                  <div className="text-[10px] text-[var(--color-muted)]">
                    {v.format} · {v.cheats.length} cheats{v.modder ? ` · ${v.modder}` : ""}
                  </div>
                </button>
              ))}
            </div>
          )}

          <div className="min-h-0 flex-1 overflow-y-auto p-4">
            {/* attach bar — connect to ps5debug so the toggles write live */}
            <div className="mb-3 flex items-center gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-2">
              <span
                className={`h-2.5 w-2.5 shrink-0 rounded-full ${
                  att?.ok ? "bg-[var(--color-good)]" : "bg-[var(--color-bad)]"
                }`}
              />
              <span className="min-w-0 flex-1 truncate text-[11px] text-[var(--color-muted)]">
                {att ? att.message : "Not attached — click Attach to apply cheats live (game must be running)."}
              </span>
              <Button
                variant={att?.ok ? "ghost" : "primary"}
                size="sm"
                leftIcon={<Plug size={13} />}
                loading={attaching}
                disabled={detaching}
                onClick={() => void doAttach()}
              >
                {att?.ok ? "Re-attach" : "Attach"}
              </Button>
              {att?.ok && (
                <Button
                  variant="danger"
                  size="sm"
                  leftIcon={<PlugZap size={13} />}
                  loading={detaching}
                  disabled={busyIdx !== null}
                  onClick={() => void doDetach()}
                >
                  Detach
                </Button>
              )}
            </div>
            <p className="mb-2 text-[11px] text-[var(--color-muted)]">
              {variant.cheats.length} cheat{variant.cheats.length === 1 ? "" : "s"}
              {variant.version ? ` · v${variant.version}` : ""} · {variant.format}.{" "}
              {att?.ok
                ? "Toggle on/off — writes live to the game."
                : variant.format === "MC4"
                  ? "MC4 trainers don't support direct apply yet — use My Games."
                  : "Attach above, or toggle from My Games while the game runs."}
            </p>
            <div className="space-y-1">
              {variant.cheats.map((c, i) => {
                const isOn = on.has(i);
                return (
                  <button
                    key={i}
                    disabled={applying}
                    onClick={() => void onToggle(i)}
                    className={`flex w-full items-center justify-between gap-3 rounded-lg border px-3 py-2 text-left text-sm transition ${
                      isOn
                        ? "border-[var(--color-good)] bg-[var(--color-good-soft)]"
                        : "border-[var(--color-border)] bg-[var(--color-surface-2)]"
                    }`}
                  >
                    <span className="flex items-center gap-2">
                      {isOn ? (
                        <Zap size={15} className="text-[var(--color-good)]" />
                      ) : (
                        <ZapOff size={15} className="text-[var(--color-muted)]" />
                      )}
                      {c}
                    </span>
                    <span
                      className={`flex h-5 w-10 items-center rounded-full px-0.5 transition ${
                        isOn ? "justify-end bg-[var(--color-good)]" : "justify-start bg-[var(--color-bad)]"
                      }`}
                    >
                      <span className="h-4 w-4 rounded-full bg-white shadow" />
                    </span>
                  </button>
                );
              })}
              {variant.cheats.length === 0 && (
                <div className="py-6 text-center text-sm text-[var(--color-muted)]">No cheat names in this file.</div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
