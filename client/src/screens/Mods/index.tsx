import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Puzzle, ExternalLink, Search, X, Star, Download, Upload, Trash2,
  AlertTriangle, CheckCircle2, FileArchive, Layers, Loader2,
} from "lucide-react";
import { open as openExternal } from "@tauri-apps/plugin-shell";

import { PageHeader, Button, EmptyState } from "../../components";
import { useConnectionStore, PS5_PAYLOAD_PORT } from "../../state/connection";
import { pickPath } from "../../lib/pickPath";
import { pushNotification } from "../../state/notifications";
import {
  modsExtractAndInspect,
  modsListStaged,
  modsRemoveStaged,
  modsActiveLoad,
  modsActiveSave,
  startTransferDir,
  jobStatus,
  type ModManifest,
  type ModStagedSummary,
} from "../../api/ps5";
import {
  CATALOG,
  TITLE_ID_ER,
  modById,
  type CatalogMod,
  type ModCategory,
} from "./catalog";

/**
 * XENO Mods — v3.2.27 Phase 1.
 *
 * Browse the curated Elden Ring mod catalog or drop in your own Nexus zip;
 * the import flow extracts + categorizes each file (regulation.bin /
 * chr/* / parts/* / msg/* etc.), then `Stage to PS5` pushes the whole
 * tree to /data/xeno_mods/CUSA18000/<mod_id>/ via the engine's
 * transfer_dir job.
 *
 * The on-console daemon (`xenoking-modloader.elf`, v3.2.28) reads from
 * that folder and nullfs-overlays each file onto /app0/ at game launch.
 * Until it ships, "Stage to PS5" lands the bytes correctly but the
 * overlay doesn't apply in-game — clearly noted in the UI.
 */

type View = "browse" | "my-mods";

const CATEGORY_LABEL: Record<ModCategory, string> = {
  anime: "Anime",
  balance: "Balance",
  visuals: "Visuals",
  audio: "Audio",
  movesets: "Movesets",
  cosmetic: "Cosmetic",
  gameplay: "Gameplay",
  other: "Other",
};

const CATEGORY_TINT: Record<ModCategory, string> = {
  anime: "#FAC775",
  balance: "#5DCAA5",
  visuals: "#85B7EB",
  audio: "#AFA9EC",
  movesets: "#F0997B",
  cosmetic: "#AFA9EC",
  gameplay: "#5DCAA5",
  other: "#D3D1C7",
};

export default function ModsScreen() {
  const host = useConnectionStore((s) => s.host);
  const [view, setView] = useState<View>("browse");
  const [term, setTerm] = useState("");
  const [filterCat, setFilterCat] = useState<ModCategory | "all">("all");
  const [selected, setSelected] = useState<CatalogMod | null>(null);
  const [staged, setStaged] = useState<ModStagedSummary[]>([]);
  const [active, setActive] = useState<Set<string>>(new Set());
  const [pendingImport, setPendingImport] = useState<ModManifest | null>(null);
  const [importing, setImporting] = useState(false);
  const [pushingId, setPushingId] = useState<string | null>(null);
  const [pushProgress, setPushProgress] = useState<{ done: number; total: number } | null>(null);
  const [pushError, setPushError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [list, st] = await Promise.all([modsListStaged(), modsActiveLoad()]);
      setStaged(list);
      setActive(new Set(st.active));
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error("[mods] refresh:", e);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const filtered = useMemo(() => {
    const t = term.trim().toLowerCase();
    return CATALOG.filter((m) => {
      if (filterCat !== "all" && m.category !== filterCat) return false;
      if (t) {
        const hay = `${m.title} ${m.author} ${m.tags.join(" ")} ${m.short}`.toLowerCase();
        if (!hay.includes(t)) return false;
      }
      return true;
    });
  }, [term, filterCat]);

  const isStaged = (modId: string) => staged.some((s) => s.mod_id === modId);
  const isActive = (modId: string) => active.has(modId);

  const importZip = useCallback(
    async (modId?: string, modTitle?: string) => {
      if (importing) return;
      const path = await pickPath({
        mode: "file",
        title: "Pick a Nexus mod zip",
        filters: [{ name: "Mod zip", extensions: ["zip"] }],
      });
      if (!path) return;
      setImporting(true);
      try {
        const manifest = await modsExtractAndInspect(path, modId, modTitle);
        setPendingImport(manifest);
      } catch (e) {
        pushNotification("error", "Import failed", { body: String(e) });
      } finally {
        setImporting(false);
      }
    },
    [importing],
  );

  const stageToPs5 = useCallback(
    async (manifest: ModManifest) => {
      if (!host?.trim()) {
        pushNotification("warning", "No PS5 connected", {
          body: "Set your console IP on the Connection tab first.",
        });
        return;
      }
      if (pushingId) return;
      setPushingId(manifest.mod_id);
      setPushProgress({ done: 0, total: manifest.total_files });
      setPushError(null);
      try {
        const dest = `/data/xeno_mods/${manifest.title_id}/${manifest.mod_id}`;
        // The engine's transfer_dir expects an `<ip>:<port>` addr — the
        // FTX2 transfer runtime listens on PS5_PAYLOAD_PORT (9113). Passing
        // a bare IP made the engine return immediately with a 400 and the
        // toast was rendering behind the modal so the click looked silent.
        const transferAddr = `${host.trim()}:${PS5_PAYLOAD_PORT}`;
        const jobId = await startTransferDir(manifest.staged_dir, dest, transferAddr);
        // Poll until the engine finishes streaming. JobSnapshot uses
        // `status` ∈ {running, done, failed} and a per-file counter
        // (`files_processing`) plus a byte counter (`bytes_sent` /
        // `total_bytes`) for fine-grained progress.
        // eslint-disable-next-line no-constant-condition
        while (true) {
          await new Promise((r) => setTimeout(r, 700));
          const snap = await jobStatus(jobId).catch(() => null);
          if (!snap) continue;
          const done = Number(snap.files_processing ?? 0);
          const total = manifest.total_files;
          setPushProgress({ done, total });
          if (snap.status === "done") break;
          if (snap.status === "failed") {
            throw new Error(`transfer failed (job ${jobId})`);
          }
        }
        // Mark active automatically — user can toggle off later.
        const nextActive = new Set(active);
        nextActive.add(manifest.mod_id);
        setActive(nextActive);
        await modsActiveSave({ title_id: manifest.title_id, active: [...nextActive] });
        await refresh();
        pushNotification("success", "Staged to PS5", {
          body: `${manifest.title} — ${manifest.total_files} files written to ${dest}. The xenoking-modloader daemon (v3.2.28) will mount them on next game launch.`,
        });
        setPendingImport(null);
      } catch (e) {
        const msg = String(e);
        setPushError(msg);
        pushNotification("error", "Push to PS5 failed", { body: msg });
      } finally {
        setPushingId(null);
        setPushProgress(null);
      }
    },
    [host, pushingId, active, refresh],
  );

  const toggleActive = useCallback(
    async (modId: string) => {
      const next = new Set(active);
      if (next.has(modId)) next.delete(modId);
      else next.add(modId);
      setActive(next);
      try {
        await modsActiveSave({ title_id: TITLE_ID_ER, active: [...next] });
      } catch (e) {
        pushNotification("error", "Couldn't save state", { body: String(e) });
      }
    },
    [active],
  );

  const removeStaged = useCallback(
    async (modId: string) => {
      const ok = window.confirm(`Remove ${modId} from local staging? PS5 copy isn't touched.`);
      if (!ok) return;
      try {
        await modsRemoveStaged(modId);
        const next = new Set(active);
        next.delete(modId);
        setActive(next);
        await modsActiveSave({ title_id: TITLE_ID_ER, active: [...next] });
        await refresh();
      } catch (e) {
        pushNotification("error", "Remove failed", { body: String(e) });
      }
    },
    [active, refresh],
  );

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        icon={Puzzle}
        title="Mods"
        count={`${CATALOG.length} curated · ${staged.length} staged`}
        description="XENOKING-curated Elden Ring mods plus drop-in Nexus zips. Files stage to /data/xeno_mods/CUSA18000/ — the xenoking-modloader daemon (v3.2.28) mounts them as nullfs overlays at game launch."
        right={
          <Button
            variant="primary"
            size="sm"
            leftIcon={<Upload size={14} />}
            onClick={() => void importZip()}
            loading={importing}
          >
            Import zip
          </Button>
        }
      />

      {/* Tabs + filters */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1">
          {(["browse", "my-mods"] as const).map((v) => (
            <button
              key={v}
              className={`rounded-md px-2.5 py-1 text-xs font-semibold ${
                view === v
                  ? "bg-[var(--color-gold)] text-[#1a1206]"
                  : "bg-[var(--color-surface-3)] text-[var(--color-muted)]"
              }`}
              onClick={() => setView(v)}
            >
              {v === "browse" ? "Browse" : `My Mods (${staged.length})`}
            </button>
          ))}
        </div>

        {view === "browse" && (
          <>
            <div className="relative min-w-[200px] flex-1">
              <Search
                size={14}
                className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--color-muted)]"
              />
              <input
                value={term}
                onChange={(e) => setTerm(e.target.value)}
                placeholder="Search mods, authors, tags…"
                className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] py-1.5 pl-7 pr-3 text-xs outline-none focus:border-[var(--color-gold)]"
              />
            </div>
            <div className="flex items-center gap-1">
              {(["all", "movesets", "anime", "cosmetic", "balance", "visuals"] as const).map((c) => (
                <button
                  key={c}
                  className={`rounded-md px-2 py-1 text-[11px] font-semibold ${
                    filterCat === c
                      ? "bg-[var(--color-gold)] text-[#1a1206]"
                      : "bg-[var(--color-surface-3)] text-[var(--color-muted)]"
                  }`}
                  onClick={() => setFilterCat(c)}
                >
                  {c === "all" ? "All" : CATEGORY_LABEL[c]}
                </button>
              ))}
            </div>
          </>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto pr-1">
        {view === "browse" ? (
          filtered.length === 0 ? (
            <EmptyState
              icon={Puzzle}
              title="No mods match"
              message="Try a different filter or import a Nexus zip directly."
            />
          ) : (
            <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))" }}>
              {filtered.map((m) => (
                <CatalogCard
                  key={m.id}
                  mod={m}
                  staged={isStaged(m.id)}
                  active={isActive(m.id)}
                  onOpen={() => setSelected(m)}
                  onToggle={() => void toggleActive(m.id)}
                />
              ))}
            </div>
          )
        ) : staged.length === 0 ? (
          <EmptyState
            icon={Puzzle}
            title="Nothing staged yet"
            message="Browse the catalog and Import a zip, or drop a Nexus zip directly via the Import button."
          />
        ) : (
          <div className="space-y-2">
            {staged.map((s) => {
              const cat = modById(s.mod_id);
              const on = isActive(s.mod_id);
              return (
                <div
                  key={s.mod_id}
                  className="flex items-center gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] p-3"
                >
                  <Layers size={20} className="shrink-0 text-[var(--color-gold)]" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-semibold">
                      {cat?.title ?? s.mod_id}
                    </div>
                    <div className="text-[11px] text-[var(--color-muted)]">
                      {s.file_count} files · {(s.total_bytes / 1024 / 1024).toFixed(1)} MB · {s.staged_dir}
                    </div>
                  </div>
                  <span
                    className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold ${
                      on
                        ? "bg-[var(--color-good-soft)] text-[var(--color-good)]"
                        : "bg-[var(--color-surface-3)] text-[var(--color-muted)]"
                    }`}
                  >
                    {on ? <CheckCircle2 size={11} /> : null}
                    {on ? "Active" : "Inactive"}
                  </span>
                  <Button variant="ghost" size="sm" onClick={() => void toggleActive(s.mod_id)}>
                    {on ? "Disable" : "Enable"}
                  </Button>
                  <Button
                    variant="danger"
                    size="sm"
                    leftIcon={<Trash2 size={13} />}
                    onClick={() => void removeStaged(s.mod_id)}
                  >
                    Remove
                  </Button>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {selected && (
        <DetailModal
          mod={selected}
          staged={isStaged(selected.id)}
          active={isActive(selected.id)}
          onClose={() => setSelected(null)}
          onImport={() => void importZip(selected.id, selected.title)}
          onToggleActive={() => void toggleActive(selected.id)}
          importing={importing}
        />
      )}

      {pendingImport && (
        <ConfirmStageModal
          manifest={pendingImport}
          host={host}
          pushing={pushingId === pendingImport.mod_id}
          progress={pushProgress}
          error={pushError}
          onCancel={() => { setPendingImport(null); setPushError(null); }}
          onPush={() => void stageToPs5(pendingImport)}
        />
      )}
    </div>
  );
}

// ─── Catalog card ───────────────────────────────────────────────────────

function CatalogCard({
  mod, staged, active, onOpen, onToggle,
}: {
  mod: CatalogMod;
  staged: boolean;
  active: boolean;
  onOpen: () => void;
  onToggle: () => void;
}) {
  const tint = CATEGORY_TINT[mod.category];
  return (
    <div
      className="flex flex-col overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)] transition hover:border-[var(--color-gold)]"
    >
      <button
        className="relative block aspect-[4/3] w-full overflow-hidden"
        style={{ background: tint }}
        onClick={onOpen}
        aria-label={`Open ${mod.title}`}
      >
        <img
          src={mod.coverUrl}
          alt=""
          className="absolute inset-0 h-full w-full object-cover"
          onError={(e) => ((e.currentTarget.style.display = "none"))}
        />
        <span className="absolute right-2 top-2 inline-flex items-center gap-1 rounded-full bg-black/55 px-2 py-0.5 text-[10px] font-bold text-white">
          <Star size={10} className="text-[var(--color-gold)]" />
          {mod.endorsements.toLocaleString()}
        </span>
        {(staged || active) && (
          <span
            className={`absolute left-2 top-2 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold ${
              active
                ? "bg-[var(--color-good)] text-white"
                : "bg-[var(--color-gold)] text-[#1a1206]"
            }`}
          >
            <CheckCircle2 size={10} />
            {active ? "Active" : "Staged"}
          </span>
        )}
      </button>
      <div className="flex flex-1 flex-col gap-2 p-3">
        <button onClick={onOpen} className="text-left">
          <div className="line-clamp-2 text-sm font-semibold leading-tight">{mod.title}</div>
          <div className="mt-0.5 text-[11px] text-[var(--color-muted)]">
            by {mod.author} · v{mod.version}
          </div>
        </button>
        <div className="line-clamp-3 text-[11px] text-[var(--color-muted)]">{mod.short}</div>
        <div className="flex flex-wrap gap-1">
          <span
            className="rounded px-1.5 py-0.5 text-[10px] font-bold"
            style={{ background: `${tint}33`, color: "var(--color-text)" }}
          >
            {CATEGORY_LABEL[mod.category]}
          </span>
          {mod.tags.slice(0, 2).map((t) => (
            <span key={t} className="rounded bg-[var(--color-surface-3)] px-1.5 py-0.5 text-[10px] text-[var(--color-muted)]">
              {t}
            </span>
          ))}
        </div>
        <div className="mt-auto flex gap-1.5">
          {staged ? (
            <Button
              variant={active ? "danger" : "primary"}
              size="sm"
              leftIcon={<CheckCircle2 size={13} />}
              onClick={onToggle}
            >
              {active ? "Disable" : "Enable"}
            </Button>
          ) : (
            <Button
              variant="primary"
              size="sm"
              leftIcon={<Download size={13} />}
              onClick={onOpen}
            >
              Install
            </Button>
          )}
          <Button variant="ghost" size="sm" leftIcon={<ExternalLink size={12} />} onClick={() => void openExternal(mod.url)}>
            Nexus
          </Button>
        </div>
      </div>
    </div>
  );
}

// ─── Detail modal ───────────────────────────────────────────────────────

function DetailModal({
  mod, staged, active, onClose, onImport, onToggleActive, importing,
}: {
  mod: CatalogMod;
  staged: boolean;
  active: boolean;
  onClose: () => void;
  onImport: () => void;
  onToggleActive: () => void;
  importing: boolean;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6" onClick={onClose}>
      <div
        className="relative flex max-h-[88vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="relative h-48 w-full overflow-hidden" style={{ background: CATEGORY_TINT[mod.category] }}>
          <img
            src={mod.coverUrl}
            alt=""
            className="absolute inset-0 h-full w-full object-cover opacity-80"
            onError={(e) => ((e.currentTarget.style.display = "none"))}
          />
          <div className="absolute inset-0 bg-gradient-to-t from-[var(--color-surface)] via-[var(--color-surface)]/40 to-transparent" />
          <div className="relative flex h-full items-end justify-between gap-3 p-4">
            <div>
              <div className="text-xl font-bold drop-shadow">{mod.title}</div>
              <div className="text-xs text-[var(--color-muted)]">
                by {mod.author} · v{mod.version} · {CATEGORY_LABEL[mod.category]} · {mod.fileSize} · {mod.endorsements.toLocaleString()}★
              </div>
            </div>
            <button onClick={onClose} className="text-[var(--color-muted)] hover:text-[var(--color-text)]">
              <X size={20} />
            </button>
          </div>
        </div>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-5 text-sm">
          {mod.ps5Note && (
            <div className="flex items-start gap-2 rounded-lg border border-[var(--color-warn)]/40 bg-[var(--color-warn-soft)] px-3 py-2 text-[12px] text-[var(--color-warn)]">
              <AlertTriangle size={14} className="mt-0.5 shrink-0" />
              <span>{mod.ps5Note}</span>
            </div>
          )}

          <div>
            <div className="mb-1 text-[10px] font-bold uppercase tracking-wide text-[var(--color-gold)]">About</div>
            <p className="whitespace-pre-line text-[13px] leading-relaxed text-[var(--color-text-soft)]">
              {mod.long}
            </p>
          </div>

          <div>
            <div className="mb-1 text-[10px] font-bold uppercase tracking-wide text-[var(--color-gold)]">
              What it replaces ({mod.whatItReplaces.length})
            </div>
            <div className="space-y-1">
              {mod.whatItReplaces.map((r) => (
                <div key={r.gamePath} className="rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2.5 py-1.5 text-[11px]">
                  <code className="text-[var(--color-gold)]">{r.gamePath}</code>
                  <div className="text-[11px] text-[var(--color-muted)]">{r.what}</div>
                </div>
              ))}
            </div>
          </div>

          <div>
            <div className="mb-1 text-[10px] font-bold uppercase tracking-wide text-[var(--color-gold)]">How to use</div>
            <p className="whitespace-pre-line text-[13px] leading-relaxed text-[var(--color-text-soft)]">{mod.howToUse}</p>
          </div>

          {(mod.conflictsWith.length > 0 || mod.requires.length > 0) && (
            <div className="grid grid-cols-2 gap-3">
              {mod.conflictsWith.length > 0 && (
                <div>
                  <div className="mb-1 text-[10px] font-bold uppercase tracking-wide text-[var(--color-bad)]">Conflicts</div>
                  <div className="space-y-1">
                    {mod.conflictsWith.map((id) => (
                      <div key={id} className="rounded bg-[var(--color-bad-soft)] px-2 py-1 text-[11px] text-[var(--color-bad)]">
                        {modById(id)?.title ?? id}
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {mod.requires.length > 0 && (
                <div>
                  <div className="mb-1 text-[10px] font-bold uppercase tracking-wide text-[var(--color-warn)]">Requires</div>
                  <div className="space-y-1">
                    {mod.requires.map((id) => (
                      <div key={id} className="rounded bg-[var(--color-warn-soft)] px-2 py-1 text-[11px] text-[var(--color-warn)]">
                        {modById(id)?.title ?? id}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        <div className="flex gap-2 border-t border-[var(--color-border)] p-3">
          <Button
            variant="secondary"
            size="sm"
            leftIcon={<ExternalLink size={14} />}
            onClick={() => void openExternal(mod.url)}
          >
            Download on Nexus
          </Button>
          <Button
            variant="primary"
            size="sm"
            leftIcon={<FileArchive size={14} />}
            onClick={onImport}
            loading={importing}
          >
            {staged ? "Re-import zip" : "Import zip"}
          </Button>
          {staged && (
            <Button
              variant={active ? "danger" : "primary"}
              size="sm"
              leftIcon={<CheckCircle2 size={14} />}
              onClick={onToggleActive}
            >
              {active ? "Disable" : "Enable"}
            </Button>
          )}
          <div className="flex-1" />
          <Button variant="ghost" size="sm" onClick={onClose}>Close</Button>
        </div>
      </div>
    </div>
  );
}

// ─── Stage confirmation modal ───────────────────────────────────────────

function ConfirmStageModal({
  manifest, host, pushing, progress, error, onCancel, onPush,
}: {
  manifest: ModManifest;
  host: string;
  pushing: boolean;
  progress: { done: number; total: number } | null;
  error: string | null;
  onCancel: () => void;
  onPush: () => void;
}) {
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  const dest = `/data/xeno_mods/${manifest.title_id}/${manifest.mod_id}`;
  const byCategory = useMemo(() => {
    const groups: Record<string, typeof manifest.files> = {};
    for (const f of manifest.files) {
      (groups[f.file_type] ||= []).push(f);
    }
    return groups;
  }, [manifest.files]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6" onClick={pushing ? undefined : onCancel}>
      <div
        className="relative flex max-h-[82vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="border-b border-[var(--color-border)] p-4">
          <div className="text-lg font-bold">Stage to PS5</div>
          <div className="text-xs text-[var(--color-muted)]">
            {manifest.title} · {manifest.total_files} files · {(manifest.total_bytes / 1024 / 1024).toFixed(1)} MB
          </div>
          <div className="mt-1 text-[11px] text-[var(--color-muted)]">
            Destination: <code className="text-[var(--color-gold)]">{dest}</code>
          </div>
        </div>

        <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-4 text-[12px]">
          {error && (
            <div className="flex items-start gap-2 rounded-lg border border-[var(--color-bad)]/60 bg-[var(--color-bad-soft)] px-3 py-2 text-[var(--color-bad)]">
              <AlertTriangle size={14} className="mt-0.5 shrink-0" />
              <div className="min-w-0 flex-1">
                <div className="font-semibold">Push to PS5 failed</div>
                <div className="mt-0.5 break-words text-[11px]">{error}</div>
                <div className="mt-1 text-[10px] opacity-80">
                  Check: PS5 helper is loaded (Connection tab · green dot), the helper is on the
                  current FW (12.40), and {host || "your PS5 IP"}:9113 is reachable.
                </div>
              </div>
            </div>
          )}
          {manifest.conflict_paths.length > 0 && (
            <div className="flex items-start gap-2 rounded-lg border border-[var(--color-warn)]/40 bg-[var(--color-warn-soft)] px-3 py-2 text-[var(--color-warn)]">
              <AlertTriangle size={14} className="mt-0.5 shrink-0" />
              <div>
                <div className="font-semibold">{manifest.conflict_paths.length} conflict-risk file{manifest.conflict_paths.length === 1 ? "" : "s"}</div>
                <div className="mt-0.5 text-[11px]">
                  This mod touches regulation.bin or chr/c0000 animations. Other mods that modify the same files will be silently overridden — pick ONE per category.
                </div>
              </div>
            </div>
          )}
          {Object.entries(byCategory).map(([type, files]) => (
            <details key={type} className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-2" open={files.length <= 6}>
              <summary className="flex cursor-pointer items-center gap-2 text-[11px] font-bold uppercase tracking-wide text-[var(--color-gold)]">
                <span>{type}</span>
                <span className="text-[var(--color-muted)]">({files.length})</span>
              </summary>
              <div className="mt-2 space-y-1">
                {files.map((f) => (
                  <div key={f.zip_path} className="rounded bg-[var(--color-surface)] px-2 py-1">
                    <code className="text-[var(--color-gold)] text-[11px]">{f.game_path}</code>
                    <div className="text-[10px] text-[var(--color-muted)]">{f.replaces_item} · {(f.size_bytes / 1024).toFixed(0)} KB</div>
                  </div>
                ))}
              </div>
            </details>
          ))}
        </div>

        {progress && (
          <div className="border-t border-[var(--color-border)] px-4 py-2">
            <div className="flex items-center justify-between text-[11px]">
              <span className="text-[var(--color-muted)]">Streaming to PS5…</span>
              <span className="font-mono">{progress.done} / {progress.total}</span>
            </div>
            <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-[var(--color-surface-3)]">
              <div
                className="h-full bg-[var(--color-gold)] transition-all"
                style={{ width: `${progress.total ? (100 * progress.done) / progress.total : 0}%` }}
              />
            </div>
          </div>
        )}

        <div className="flex gap-2 border-t border-[var(--color-border)] p-3">
          <Button variant="ghost" size="sm" onClick={onCancel} disabled={pushing}>
            Cancel
          </Button>
          <div className="flex-1" />
          <Button
            variant="primary"
            size="sm"
            leftIcon={pushing ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />}
            onClick={onPush}
            disabled={pushing || !host?.trim()}
          >
            {pushing ? "Streaming…" : !host?.trim() ? "No PS5 host" : "Stage to PS5"}
          </Button>
        </div>
      </div>
    </div>
  );
}
