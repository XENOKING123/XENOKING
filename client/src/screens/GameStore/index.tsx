import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ShoppingCart, Search, Download, RefreshCw, X, Copy, ExternalLink } from "lucide-react";
import { open as openExternal } from "@tauri-apps/plugin-shell";

import { PageHeader, Button, EmptyState } from "../../components";
import {
  scrapeCatalog,
  fetchDownloadLinks,
  fetchDownloadBundle,
  fetchCoverImage,
  hydrateCoversWikipedia,
  coverNorm,
  type GameEntry,
  type DownloadLink,
  type GameDownloadBundle,
} from "../../lib/xenoStore";
import { coverByName } from "../../lib/covers";

/**
 * XENO Game Store — browse the dlpsgame.com PS4/PS5 catalog with covers,
 * search, and a deep download-link resolver. All HTTP runs through the Rust
 * `xeno_http_get` command (CSP/CORS-free). Catalog is cached in localStorage
 * so reopening is instant; "Get links" resolves the real mirror hosts (cracks
 * the base64 ad-gateways) and lists them for one-click open/copy.
 */
type Platform = "PS5" | "PS4";
const CACHE_KEY = (p: Platform) => `xeno.store.catalog.${p}`;
const EXTRA_COVERS_KEY = "xeno.covers.extra";

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
function loadExtraCovers(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(EXTRA_COVERS_KEY) || "{}");
  } catch {
    return {};
  }
}
function saveExtraCovers(map: Record<string, string>) {
  try {
    localStorage.setItem(EXTRA_COVERS_KEY, JSON.stringify(map));
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
  const [bundle, setBundle] = useState<GameDownloadBundle | null>(null);
  const [linksBusy, setLinksBusy] = useState(false);
  // Extra covers resolved by Wikipedia hydration (persisted in localStorage).
  const [extraCovers, setExtraCovers] = useState<Record<string, string>>(loadExtraCovers);
  const hydrateAbort = useRef<AbortController | null>(null);

  const scrape = useCallback(
    async (p: Platform, pages: number) => {
      if (busy) return;
      setBusy(true);
      setStatus(`Scraping ${p}…`);
      try {
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

        // Auto-hydrate covers for games that still have no cover art.
        // Wikipedia batch API: 40 titles/request ≈ 3 req/sec → ~30 s for 3 k games.
        const uncovered = fresh.filter((g) => !g.coverUrl);
        if (uncovered.length > 0) {
          hydrateAbort.current?.abort();
          hydrateAbort.current = new AbortController();
          const ab = hydrateAbort.current;
          setStatus(`Fetching covers for ${uncovered.length} games…`);
          void hydrateCoversWikipedia(uncovered, ab.signal, (done, total) => {
            if (!ab.signal.aborted) setStatus(`Covers ${done}/${total}…`);
          }).then((newCovers) => {
            if (ab.signal.aborted) return;
            setExtraCovers((prev) => {
              const merged = { ...prev, ...newCovers };
              saveExtraCovers(merged);
              return merged;
            });
            setStatus(`Done — ${fresh.length} games, +${Object.keys(newCovers).length} covers.`);
          });
        }
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
    setBundle(null);
    setLinksBusy(true);
    // Fetch both in parallel. The structured bundle is the rich view (one
    // block per titleId/region/version with Game / each Update / each DLC and
    // mirror hosts). The flat list is the fallback for non-dlpsgame sources
    // and for dlpsgame pages whose bundle returns null (or for the rare
    // alt-source URLs the bundle parser doesn't cover).
    const [bundleRes, linksRes] = await Promise.allSettled([
      fetchDownloadBundle(g.pageUrl),
      fetchDownloadLinks(g.pageUrl, true, g.altUrls),
    ]);
    if (bundleRes.status === "fulfilled" && bundleRes.value && bundleRes.value.versions.length > 0) {
      setBundle(bundleRes.value);
    }
    if (linksRes.status === "fulfilled") {
      setLinks(linksRes.value);
    } else {
      setLinks([]);
    }
    setLinksBusy(false);
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
                <StoreCover name={g.name} coverUrl={g.coverUrl} extraCoverUrl={extraCovers[coverNorm(g.name)]} />
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
          bundle={bundle}
          busy={linksBusy}
          onClose={() => setLinksFor(null)}
        />
      )}
    </div>
  );
}

/** Game cover — five-stage fallback:
 *  1. Direct <img> of scraped coverUrl (no-referrer, bypasses hotlink checks).
 *  2. Rust proxy for scraped URL (handles Cloudflare 403 / CSP img-src blocks).
 *  3. covers.json PlayStation CDN lookup by name (~1,300 bundled entries).
 *  4. Rust proxy for that CDN URL.
 *  5. Wikipedia-hydrated cover (extraCoverUrl, resolved after scrape, stage-5 new).
 *  Falls back to the letter-tile placeholder only when all five stages fail. */
function StoreCover({ name, coverUrl, extraCoverUrl }: { name: string; coverUrl: string; extraCoverUrl?: string }) {
  const [src, setSrc] = useState(coverUrl || extraCoverUrl || "");
  const [failed, setFailed] = useState(false);
  const tried = useRef(new Set<string>());

  useEffect(() => {
    tried.current.clear();
    setFailed(false);
    setSrc(coverUrl || "");
    if (!coverUrl) {
      // No scraped cover: try covers.json, then extra (Wikipedia) cover.
      void coverByName(name).then((u) => {
        if (u) setSrc(u);
        else if (extraCoverUrl) setSrc(extraCoverUrl);
      });
    }
  }, [coverUrl, name, extraCoverUrl]);

  const handleError = useCallback(() => {
    const failing = src;

    // All prior attempts exhausted for this URL → try next fallback.
    if (!failing || tried.current.has(failing)) {
      if (extraCoverUrl && !tried.current.has(extraCoverUrl)) {
        tried.current.add(extraCoverUrl);
        setSrc(extraCoverUrl);
      } else {
        setFailed(true);
      }
      return;
    }
    tried.current.add(failing);

    fetchCoverImage(failing)
      .then((data) => setSrc(data))
      .catch(() => {
        if (failing === coverUrl && coverUrl) {
          // Scraped URL (direct + proxy) failed → try covers.json CDN.
          coverByName(name)
            .then((u) => {
              if (u && !tried.current.has(u)) setSrc(u);
              else if (extraCoverUrl && !tried.current.has(extraCoverUrl)) setSrc(extraCoverUrl);
              else setFailed(true);
            })
            .catch(() => {
              if (extraCoverUrl && !tried.current.has(extraCoverUrl)) setSrc(extraCoverUrl);
              else setFailed(true);
            });
        } else if (extraCoverUrl && !tried.current.has(extraCoverUrl)) {
          // covers.json CDN URL (direct + proxy) also failed → Wikipedia cover.
          setSrc(extraCoverUrl);
        } else {
          setFailed(true);
        }
      });
  }, [src, coverUrl, name, extraCoverUrl]);

  return (
    <div className="relative aspect-[3/4] w-full bg-[var(--color-surface-3)]">
      <div className="absolute inset-0 flex items-center justify-center bg-gradient-to-br from-[var(--color-surface-3)] to-[var(--color-surface)] text-3xl font-black text-[var(--color-accent)]">
        {(name || "?").slice(0, 1).toUpperCase()}
      </div>
      {!failed && src && (
        <img
          src={src}
          alt={name}
          loading="lazy"
          referrerPolicy="no-referrer"
          className="absolute inset-0 h-full w-full object-cover"
          onError={handleError}
        />
      )}
    </div>
  );
}

function LinksModal({
  game,
  links,
  bundle,
  busy,
  onClose,
}: {
  game: GameEntry;
  links: DownloadLink[] | null;
  bundle: GameDownloadBundle | null;
  busy: boolean;
  onClose: () => void;
}) {
  // When the bundle parsed successfully (dlpsgame pages with at least one
  // block of Game/Updates/DLC mirrors), prefer the structured view — it shows
  // per-version blocks with credits, password, languages, and the mirror set
  // for the base game + each update + each DLC pack. Falls back to the flat
  // list for non-dlpsgame sources or empty bundles.
  const showBundle =
    !!bundle &&
    bundle.versions.some(
      (v) =>
        (v.game?.mirrors.length ?? 0) > 0 ||
        v.updates.some((u) => u.mirrors.length > 0) ||
        v.dlc.some((d) => d.mirrors.length > 0),
    );
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
                : showBundle
                  ? `${bundle!.versions.length} version block(s) · ${game.platform}`
                  : `${links?.length ?? 0} link(s) · ${game.platform}`}
            </div>
          </div>
          <button onClick={onClose} className="text-[var(--color-muted)] hover:text-[var(--color-text)]">
            <X size={20} />
          </button>
        </div>

        {!showBundle && (
          <p className="mb-2 text-[11px] text-[var(--color-muted)]">
            <b className="text-[var(--color-good)]">direct file</b> = the real download ·{" "}
            <b className="text-[var(--color-accent)]">mirror page</b> = a host list ·{" "}
            <b className="text-[var(--color-warn)]">ad-gate</b> = needs a manual click. We decode the
            ad-gate links automatically — some hosts (mega/1fichier/rootz) still need one click on
            their own page.
          </p>
        )}

        {!showBundle && (
          <div className="mb-3 flex items-center gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-2 text-xs">
            <span className="text-[var(--color-muted)]">Extract password:</span>
            <code className="font-semibold text-[var(--color-good)]">DLPSGAME.COM</code>
            <Button
              variant="ghost"
              size="sm"
              leftIcon={<Copy size={12} />}
              onClick={() => void navigator.clipboard.writeText("DLPSGAME.COM")}
            >
              Copy
            </Button>
            <span className="text-[10px] text-[var(--color-muted)]">
              — the .zip/.rar archives are password-protected with this.
            </span>
          </div>
        )}

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto">
          {busy && <div className="py-8 text-center text-sm text-[var(--color-muted)]">Resolving…</div>}

          {/* RICH STRUCTURED VIEW — one panel per (titleId × region × version),
              with Game / each Update / each DLC and all extracted mirror hosts. */}
          {!busy &&
            showBundle &&
            bundle!.versions.map((v, vi) => (
              <BundleVersionPanel key={`${v.titleId}-${v.region}-${vi}`} version={v} />
            ))}

          {/* Fallback flat list (non-dlpsgame sources, or empty bundles). */}
          {!busy && !showBundle && links && links.length === 0 && (
            <div className="py-6 text-center text-sm text-[var(--color-muted)]">
              Couldn’t resolve links headlessly — open the game page in your browser instead.
            </div>
          )}
          {!busy &&
            !showBundle &&
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

/** One panel per dlpsgame version block — titleId · region · version on top,
 *  credits + password + languages as metadata, then Game / each Update / each
 *  DLC pack with mirror chips that open the URL in the user's browser with one
 *  click. Each chip is the mirror's host name as it appears on dlpsgame
 *  (Mediafire, Akia, Viki, 1File, Buznew, Root, Rano, Mega, …) so the user
 *  picks the host they trust. */
function BundleVersionPanel({
  version: v,
}: {
  version: import("../../lib/xenoStore").GameBundleVersion;
}) {
  const langLine = v.languages
    ? v.languages
    : [v.voice && `Voice: ${v.voice}`, v.subtitles && `Subtitles: ${v.subtitles}`]
        .filter(Boolean)
        .join(" · ");
  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)] p-3">
      <div className="mb-2 flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="rounded bg-[var(--color-surface-3)] px-1.5 py-0.5 text-[10px] font-bold uppercase">
          {v.titleId}
        </span>
        <span className="rounded bg-[var(--color-accent-soft)] px-1.5 py-0.5 text-[10px] font-bold uppercase text-[var(--color-accent)]">
          {v.region}
        </span>
        {v.baseVersion && (
          <span className="text-sm font-semibold text-[var(--color-good)]">v{v.baseVersion}</span>
        )}
        {v.credits && (
          <span className="text-[10px] text-[var(--color-muted)]">· {v.credits}</span>
        )}
      </div>

      {(v.password || langLine) && (
        <div className="mb-2 flex flex-wrap items-center gap-2 rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 text-[11px]">
          {v.password && (
            <>
              <span className="text-[var(--color-muted)]">password:</span>
              <code className="font-semibold text-[var(--color-good)]">{v.password}</code>
              <button
                title="Copy password"
                className="text-[var(--color-muted)] hover:text-[var(--color-text)]"
                onClick={() => void navigator.clipboard.writeText(v.password!)}
              >
                <Copy size={11} />
              </button>
            </>
          )}
          {langLine && (
            <span className="text-[var(--color-muted)]">{langLine}</span>
          )}
        </div>
      )}

      {v.game && v.game.mirrors.length > 0 && (
        <BundleSection label="Game" mirrors={v.game.mirrors} />
      )}

      {v.updates.length > 0 && (
        <div className="mt-2">
          <div className="mb-1 text-[10px] font-bold uppercase tracking-wide text-[var(--color-gold)]">
            ◆ Updates ({v.updates.length})
          </div>
          <div className="space-y-1.5">
            {v.updates.map((u, ui) => (
              <div key={ui} className="rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5">
                <div className="mb-1 text-[11px]">
                  <b>{u.version}</b>
                  {u.compat && <span className="text-[var(--color-muted)]"> · {u.compat}</span>}
                </div>
                {u.mirrors.length > 0 ? (
                  <MirrorChips mirrors={u.mirrors} />
                ) : (
                  <span className="text-[10px] text-[var(--color-muted)]">no extracted mirrors</span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {v.dlc.length > 0 && (
        <div className="mt-2 space-y-1.5">
          {v.dlc.map((d, di) => (
            <BundleSection key={di} label={d.label} mirrors={d.mirrors} />
          ))}
        </div>
      )}
    </div>
  );
}

function BundleSection({ label, mirrors }: { label: string; mirrors: Array<{ host: string; url: string }> }) {
  return (
    <div className="mt-2">
      <div className="mb-1 text-[10px] font-bold uppercase tracking-wide text-[var(--color-gold)]">
        ◆ {label}
      </div>
      <MirrorChips mirrors={mirrors} />
    </div>
  );
}

function MirrorChips({ mirrors }: { mirrors: Array<{ host: string; url: string; indirect?: boolean }> }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {mirrors.map((m, i) =>
        m.indirect ? (
          // Plain-text mirror — no direct link in the payload. Opens the game
          // page so the user can grab the link manually.
          <button
            key={i}
            title={`No direct link extracted — opens game page to find ${m.host} link`}
            onClick={() => void openExternal(m.url)}
            className="inline-flex items-center gap-1 rounded-full border border-dashed border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-1 text-[11px] font-semibold text-[var(--color-muted)] opacity-70 hover:border-[var(--color-warn)] hover:text-[var(--color-warn)]"
          >
            {m.host}
            <ExternalLink size={10} />
          </button>
        ) : (
          <button
            key={i}
            title={m.url}
            onClick={() => void openExternal(m.url)}
            className="inline-flex items-center gap-1 rounded-full border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2.5 py-1 text-[11px] font-semibold hover:border-[var(--color-accent)] hover:bg-[var(--color-accent-soft)] hover:text-[var(--color-accent)]"
          >
            {m.host}
            <ExternalLink size={10} />
          </button>
        ),
      )}
    </div>
  );
}
