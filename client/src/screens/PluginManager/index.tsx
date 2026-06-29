import { useCallback, useEffect, useRef, useState } from "react";
import {
  Puzzle,
  RefreshCw,
  X,
  ChevronDown,
  ChevronRight,
  Loader2,
  Shield,
} from "lucide-react";

import { useConnectionStore } from "../../state/connection";
import { procListGet, shellRun, type ProcEntry } from "../../api/ps5";
import {
  PageHeader,
  EmptyState,
  ErrorCard,
  Button,
  ConnectionGate,
} from "../../components";
import { useConfirm } from "../../components/ConfirmDialog";
import { pushNotification } from "../../state/notifications";
import { useTr } from "../../state/lang";
import { mgmtAddr } from "../../lib/addr";

// ── Known homebrew process registry ──────────────────────────────────────────

interface PluginInfo {
  label: string;
  desc: string;
  closeable: boolean;
  badge: string;
}

const PLUGIN_MAP: Record<string, PluginInfo> = {
  shadowmountplus: { label: "ShadowMount+",  desc: "PS5 game mod/patch mounter via unionfs",         closeable: true,  badge: "📂" },
  shadowmount:     { label: "ShadowMount+",  desc: "PS5 game mod/patch mounter via unionfs",         closeable: true,  badge: "📂" },
  kstuff:          { label: "kstuff",         desc: "Kernel exploit patches & privilege scaffolding", closeable: false, badge: "⚙️" },
  cheatrunner:     { label: "CheatRunner",   desc: "In-game cheat engine by maj0r",                  closeable: true,  badge: "🎯" },
  nanodns:         { label: "nanoDNS",       desc: "DNS override for PS Store redirect",             closeable: true,  badge: "🌐" },
  goldhen:         { label: "GoldHEN",       desc: "PS5 jailbreak framework",                        closeable: false, badge: "🔓" },
  mira:            { label: "Mira",          desc: "Mira homebrew framework",                        closeable: false, badge: "🔧" },
  elfloader:       { label: "ELF Loader",    desc: "ELF payload loader daemon",                      closeable: true,  badge: "📦" },
  ftpd:            { label: "FTP Server",    desc: "FTP daemon for remote file access",              closeable: true,  badge: "🖥" },
  ftpdaemon:       { label: "FTP Server",    desc: "FTP daemon for remote file access",              closeable: true,  badge: "🖥" },
  ps5debug:        { label: "ps5-debug",     desc: "Process debugger and memory patcher",            closeable: true,  badge: "🔬" },
  libdebug:        { label: "libdebug",      desc: "Debug library daemon",                           closeable: true,  badge: "🔬" },
  ps5upload:       { label: "XENO Payload",  desc: "XENO TOOL payload — powers this app",            closeable: false, badge: "🧨" },
  "payload.elf":   { label: "XENO Payload",  desc: "XENO TOOL payload — powers this app",            closeable: false, badge: "🧨" },
  payload2:        { label: "XENO Payload",  desc: "XENO TOOL payload — powers this app",            closeable: false, badge: "🧨" },
  etahen:          { label: "etaHEN",        desc: "etaHEN jailbreak exploit",                       closeable: false, badge: "🔓" },
  "hen.elf":       { label: "HEN",           desc: "Homebrew enabler",                               closeable: false, badge: "🔓" },
};

function matchPlugin(name: string): PluginInfo | null {
  const lower = name.toLowerCase();
  for (const [key, info] of Object.entries(PLUGIN_MAP)) {
    if (lower.includes(key.toLowerCase())) return info;
  }
  return null;
}

const SYSTEM_PREFIXES = [
  "idle", "init", "kernel", "vm_", "swi", "intr", "xpt_", "sctp",
  "crypto", "geom", "md", "camwork", "syncer", "pagedaemon", "bufdaemon",
  "vmdaemon", "pagezero",
];
function isSystemProcess(name: string) {
  const l = name.toLowerCase();
  return !name || l.startsWith("[") || SYSTEM_PREFIXES.some((p) => l.startsWith(p));
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface ProcRow extends ProcEntry {
  plugin: PluginInfo | null;
}

const AUTO_REFRESH_MS = 3000;

// ── Main screen ───────────────────────────────────────────────────────────────

export default function PluginManagerScreen() {
  const tr = useTr();
  const host = useConnectionStore((s) => s.host);
  const addr = host ? mgmtAddr(host) : "";

  const [rows, setRows]               = useState<ProcRow[]>([]);
  const [loading, setLoading]         = useState(false);
  const [error, setError]             = useState<string | null>(null);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [showAll, setShowAll]         = useState(false);
  const [killing, setKilling]         = useState<number | null>(null);
  const intervalRef                   = useRef<ReturnType<typeof setInterval> | null>(null);
  const { confirm, dialog }           = useConfirm();

  const load = useCallback(async () => {
    if (!addr) return;
    setLoading(true);
    try {
      const result = await procListGet(addr);
      setRows(
        (result.procs ?? []).map((p) => ({ ...p, plugin: matchPlugin(p.name) })),
      );
      setError(result.ok ? null : (result.error ?? "Process list walk failed"));
      setLastRefresh(new Date());
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [addr]);

  useEffect(() => { if (addr) load(); }, [addr, load]);

  useEffect(() => {
    if (intervalRef.current) clearInterval(intervalRef.current);
    if (autoRefresh && addr) {
      intervalRef.current = setInterval(load, AUTO_REFRESH_MS);
    }
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, [autoRefresh, addr, load]);

  const killProc = useCallback(
    async (pid: number, name: string) => {
      const ok = await confirm({
        title: `Kill: ${name}`,
        message: `Send SIGKILL to PID ${pid}. The process will terminate immediately. You can restart it from the Payloads screen.`,
        confirmLabel: "Kill",
        destructive: true,
      });
      if (!ok) return;
      setKilling(pid);
      try {
        await shellRun(addr, `kill -9 ${pid}`);
        pushNotification("success", `Killed ${name} (PID ${pid})`);
        await load();
      } catch (e) {
        pushNotification("error", `Kill failed: ${String(e)}`);
      } finally {
        setKilling(null);
      }
    },
    [addr, confirm, load],
  );

  const known  = rows.filter((r) => r.plugin !== null);
  const others = rows.filter((r) => r.plugin === null && !isSystemProcess(r.name));

  return (
    <div className="p-6">
      <PageHeader
        icon={Puzzle}
        title={tr("plugin_manager", undefined, "Plugin Manager")}
        description={tr(
          "plugin_manager_desc",
          undefined,
          "View and kill running homebrew plugins on your PS5. Auto-refreshes every 3 s.",
        )}
        right={
          <div className="flex items-center gap-2">
            {lastRefresh && (
              <span className="text-[11px] text-[var(--text-muted)]">
                {lastRefresh.toLocaleTimeString()}
              </span>
            )}
            <Button
              variant={autoRefresh ? "primary" : "secondary"}
              size="sm"
              onClick={() => setAutoRefresh((v) => !v)}
            >
              {autoRefresh ? "⏸ Auto" : "▶ Auto"}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              leftIcon={
                loading ? (
                  <Loader2 size={13} className="animate-spin" />
                ) : (
                  <RefreshCw size={13} />
                )
              }
              onClick={load}
              disabled={loading}
            >
              Refresh
            </Button>
          </div>
        }
      />

      {dialog}

      <ConnectionGate>
        <div className="mx-auto max-w-2xl space-y-6">
          {error && <ErrorCard title="Process list failed" detail={error} />}

          {/* Known plugins */}
          <section>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]">
              Recognised Plugins ({known.length})
            </p>
            {known.length === 0 && !loading && (
              <EmptyState message="No recognised homebrew plugins running." />
            )}
            <div className="space-y-2">
              {known.map((row) => (
                <PluginRow
                  key={row.pid}
                  row={row}
                  plugin={row.plugin!}
                  killing={killing}
                  onKill={killProc}
                />
              ))}
            </div>
          </section>

          {/* Other user processes (hidden by default) */}
          {others.length > 0 && (
            <section>
              <button
                onClick={() => setShowAll((v) => !v)}
                className="flex items-center gap-1 text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors mb-2"
              >
                {showAll ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                {showAll ? "Hide" : "Show"} {others.length} other user processes
              </button>
              {showAll && (
                <div className="space-y-1">
                  {others.map((row) => (
                    <OtherRow
                      key={row.pid}
                      row={row}
                      killing={killing}
                      onKill={killProc}
                    />
                  ))}
                </div>
              )}
            </section>
          )}

          {loading && rows.length === 0 && (
            <EmptyState message="Loading processes…" />
          )}
        </div>
      </ConnectionGate>
    </div>
  );
}

// ── Plugin row ────────────────────────────────────────────────────────────────

function PluginRow({
  row,
  plugin,
  killing,
  onKill,
}: {
  row: ProcRow;
  plugin: PluginInfo;
  killing: number | null;
  onKill: (pid: number, name: string) => void;
}) {
  const isKilling = killing === row.pid;
  return (
    <div className="flex items-start justify-between rounded-xl border border-[var(--border)] bg-[var(--card)] p-3 gap-3">
      <div className="flex items-start gap-3 min-w-0">
        <span className="text-xl leading-none mt-0.5 select-none">{plugin.badge}</span>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold text-sm text-[var(--text-primary)]">
              {plugin.label}
            </span>
            <span className="font-mono text-[10px] bg-[var(--surface)] text-[var(--text-muted)] px-1.5 py-0.5 rounded">
              PID {row.pid}
            </span>
            <span className="font-mono text-[10px] text-[var(--text-muted)] hidden sm:block">
              {row.name}
            </span>
          </div>
          <p className="mt-0.5 text-xs text-[var(--text-muted)]">{plugin.desc}</p>
        </div>
      </div>
      <div className="shrink-0">
        {plugin.closeable ? (
          <Button
            variant="danger"
            size="sm"
            leftIcon={
              isKilling ? <Loader2 size={11} className="animate-spin" /> : <X size={11} />
            }
            onClick={() => onKill(row.pid, plugin.label)}
            disabled={killing !== null}
          >
            Kill
          </Button>
        ) : (
          <span className="flex items-center gap-1 rounded border border-[var(--border)] px-2 py-1 text-[11px] text-[var(--text-muted)]">
            <Shield size={11} /> Protected
          </span>
        )}
      </div>
    </div>
  );
}

// ── Generic process row (compact) ─────────────────────────────────────────────

function OtherRow({
  row,
  killing,
  onKill,
}: {
  row: ProcRow;
  killing: number | null;
  onKill: (pid: number, name: string) => void;
}) {
  const isKilling = killing === row.pid;
  return (
    <div className="flex items-center justify-between rounded-lg border border-[var(--border)] bg-[var(--card)] px-3 py-2 gap-2">
      <div className="flex items-center gap-2 min-w-0">
        <span className="font-mono text-xs text-[var(--text-primary)] truncate">{row.name}</span>
        <span className="font-mono text-[10px] text-[var(--text-muted)]">PID {row.pid}</span>
      </div>
      <Button
        variant="ghost"
        size="sm"
        leftIcon={
          isKilling ? <Loader2 size={11} className="animate-spin" /> : <X size={11} />
        }
        onClick={() => onKill(row.pid, row.name)}
        disabled={killing !== null}
      >
        Kill
      </Button>
    </div>
  );
}
