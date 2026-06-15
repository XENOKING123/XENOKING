import { useCallback, useEffect, useMemo, useState } from "react";
import { ShoppingCart, Search, Download, RefreshCw, X, Copy, ExternalLink } from "lucide-react";
import { open as openExternal } from "@tauri-apps/plugin-shell";

import { PageHeader, Button, EmptyState } from "../../components";
import {
  scrapeCatalog,
  fetchDownloadLinks,
  type GameEntry,
  type DownloadLink,
} from "../../lib/xenoStore";

/**
 * XENO Game Store — browse the dlpsgame.com PS4/PS5 catalog with covers,
 * search, and a deep download-link resolver. All HTTP runs through the Rust
 * `xeno_http_get` command (CSP/CORS-free). Catalog is cached in localStorage
 * so reopening is instant; "Get links" resolves the real mirror hosts (cracks
 * the base64 ad-gateways) and lists them for one-click open/copy.
 */
type Platform = "PS5" | "PS4";
const CACHE_KEY = (p: Platform) => `xeno.store.catalog.${p}`;

function loadCache(p: Platform): GameEntry[] {
  try {
    return JSON.parse(localStorage.getItem(CACHE_KEY(p)) || "[]");
  } catch {
    return [];
  }
}
function saveCache(p: Platform, games: GameEntry[]) {
  try {
    localStorage.setItem(CACHE_KEY(p), JSON.stringify(games));
  } catch {
    /* quota — ignore */
  }
}

const KIND_LABEL: Record<DownloadLink["kind"], { label: string; cls: string }> = {
  terminal: { label: "direct file", cls: "text-[var(--color-good)]" },
  landing: { label: "mirror page", cls: "text-[var(--color-accent)]" },
  gateway: { label: "ad-gate (manual)", cls: "text-[var(--color-warn)]" },
};

export default function GameStoreScreen() {
  const [platform, setPlatform] = useState<Platform>("PS5");
  const [games, setGames] = useState<GameEntry[]>(() => loadCache("PS5"));
  const [term, setTerm] = useState("");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [linksFor, setLinksFor] = useState<GameEntry | null>(null);
  const [links, setLinks] = useState<DownloadLink[] | null>(null);
  const [linksBusy, setLinksBusy] = useState(false);

  const scrape = useCallback(
    async (p: Platform, pages: number) => {
      if (busy) return;
      setBusy(true);
      setStatus(`Scraping ${p}…`);
      try {
        // merge with what's cached so each scrape ADDS rather than replaces.
        // Persist + show each batch as it arrives so a long (30+ page) scrape
        // surfaces games live and survives interruption.
        const fresh = await scrapeCatalog(
          p,
          pages,
          (m) => setStatus(m),
          loadCache(p),
          (all) => {
            saveCache(p, all);
            setGames(all);
          },
        );
        if (fresh.length) {
          saveCache(p, fresh);
          setGames(fresh);
        }
        setStatus(`${fresh.length} ${p} games cached.`);
      } catch (e) {
        setStatus(`Scrape failed: ${e}`);
      } finally {
        setBusy(false);
      }
    },
    [busy],
  );

  // load cache on platform switch; auto-scrape if empty
  useEffect(() => {
    const cached = loadCache(platform);
    setGames(cached);
    if (cached.length === 0) void scrape(platform, 150);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [platform]);

  const filtered = useMemo(() => {
    const t = term.trim().toLowerCase();
    return t ? games.filter((g) => g.name.toLowerCase().includes(t)) : games;
  }, [games, term]);

  const getLinks = useCallback(async (g: GameEntry) => {
    setLinksFor(g);
    setLinks(null);
    setLinksBusy(true);
    try {
      const items = await fetchDownloadLinks(g.pageUrl);
      setLinks(items);
    } catch {
      setLinks([]);
    } finally {
      setLinksBusy(false);
    }
  }, []);

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        icon={ShoppingCart}
        title="Game Store"
        count={filtered.length}
        loading={busy}
        description="Browse the PS4/PS5 catalog, then Get links for the real download mirrors. Drop a downloaded .pkg in Install Package to send it to your PS5."
        right={
          <div className="flex items-center gap-2">
            {(["PS5", "PS4"] as Platform[]).map((p) => (
              <button
                key={p}
                onClick={() => setPlatform(p)}
                className={`rounded-md px-3 py-1.5 text-sm font-semibold ${
                  platform === p
                    ? "bg-[var(--color-accent)] text-[var(--color-accent-contrast)]"
                    : "bg-[var(--color-surface-3)] text-[var(--color-muted)]"
                }`}
              >
                {p}
              </button>
            ))}
            <Button
              variant="secondary"
              size="sm"
              leftIcon={<RefreshCw size={15} />}
              onClick={() => scrape(platform, 150)}
              disabled={busy}
            >
              Scrape ALL
            </Button>
          </div>
        }
      />

      <div className="mb-3 flex items-center gap-2">
        <div className="relative flex-1">
          <Search
            size={16}
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-muted)]"
          />
          <input
            value={term}
            onChange={(e) => setTerm(e.target.value)}
            placeholder={`Search ${platform} games…`}
            className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] py-2 pl-9 pr-3 text-sm outline-none focus:border-[var(--color-accent)]"
          />
        </div>
        {status && <span className="text-xs text-[var(--color-muted)]">{status}</span>}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto pr-1">
        {filtered.length === 0 ? (
          <EmptyState
            icon={ShoppingCart}
            title={busy ? "Loading catalog…" : "No games yet"}
            message={
              busy ? "Pulling the latest catalog…" : "Hit “Scrape more” to pull the catalog."
            }
          />
        ) : (
          <div
            className="grid gap-3"
            style={{ gridTemplateColumns: "repeat(auto-fill, minmax(168px, 1fr))" }}
          >
            {filtered.map((g) => (
              <div
                key={g.pageUrl}
                className="flex flex-col overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)]"
              >
                <img
                  src={g.coverUrl}
                  alt={g.name}
                  loading="lazy"
                  className="aspect-[3/4] w-full cursor-pointer object-cover"
                  onClick={() => void openExternal(g.pageUrl)}
                  onError={(e) => {
                    (e.target as HTMLImageElement).style.visibility = "hidden";
                  }}
                />
                <div className="flex flex-1 flex-col gap-2 p-2">
                  <div className="line-clamp-2 text-xs font-semibold">{g.name}</div>
                  <Button
                    variant="primary"
                    size="sm"
                    leftIcon={<Download size={14} />}
                    onClick={() => void getLinks(g)}
                    className="mt-auto"
                  >
                    Get links
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {linksFor && (
        <LinksModal
          game={linksFor}
          links={links}
          busy={linksBusy}
          onClose={() => setLinksFor(null)}
        />
      )}
    </div>
  );
}

function LinksModal({
  game,
  links,
  busy,
  onClose,
}: {
  game: GameEntry;
  links: DownloadLink[] | null;
  busy: boolean;
  onClose: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6"
      onClick={onClose}
    >
      <div
        className="flex max-h-[80vh] w-full max-w-2xl flex-col rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-2 flex items-start justify-between gap-3">
          <div>
            <div className="text-lg font-bold">{game.name}</div>
            <div className="text-xs text-[var(--color-muted)]">
              {busy
                ? "Resolving the real mirrors…"
                : `${links?.length ?? 0} link(s) · ${game.platform}`}
            </div>
          </div>
          <button onClick={onClose} className="text-[var(--color-muted)] hover:text-[var(--color-text)]">
            <X size={20} />
          </button>
        </div>
        <p className="mb-3 text-[11px] text-[var(--color-muted)]">
          <b className="text-[var(--color-good)]">direct file</b> = the real download ·{" "}
          <b className="text-[var(--color-accent)]">mirror page</b> = a host list ·{" "}
          <b className="text-[var(--color-warn)]">ad-gate</b> = needs a manual click. Some hosts
          (mega/1fichier/rootz) still need one click on their own page.
        </p>

        <div className="min-h-0 flex-1 space-y-2 overflow-y-auto">
          {busy && <div className="py-8 text-center text-sm text-[var(--color-muted)]">Resolving…</div>}
          {!busy && links && links.length === 0 && (
            <div className="py-6 text-center text-sm text-[var(--color-muted)]">
              Couldn’t resolve links headlessly — open the game page in your browser instead.
            </div>
          )}
          {!busy &&
            links?.map((it) => (
              <div
                key={it.url}
                className="flex items-center gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-2"
              >
                <span className={`text-[11px] font-semibold ${KIND_LABEL[it.kind].cls}`}>
                  {KIND_LABEL[it.kind].label}
                </span>
                <span className="min-w-0 flex-1 truncate text-sm">
                  <b>{it.host}</b>{" "}
                  <span className="text-[11px] text-[var(--color-muted)]">{it.label}</span>
                </span>
                <Button variant="primary" size="sm" onClick={() => void openExternal(it.url)}>
                  Open
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => void navigator.clipboard.writeText(it.url)}
                  leftIcon={<Copy size={14} />}
                >
                  Copy
                </Button>
              </div>
            ))}
        </div>

        <div className="mt-3 flex gap-2">
          <Button
            variant="secondary"
            onClick={() => void navigator.clipboard.writeText((links || []).map((l) => l.url).join("\n"))}
            disabled={!links?.length}
          >
            Copy all
          </Button>
          <Button
            variant="ghost"
            leftIcon={<ExternalLink size={15} />}
            onClick={() => void openExternal(game.pageUrl)}
          >
            Open game page
          </Button>
          <div className="flex-1" />
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
        </div>
      </div>
    </div>
  );
}
