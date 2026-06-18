// XENO Game Store — dlpsgame.com catalog scrape + deep download-link resolver.
// All HTTP goes through the Rust `xeno_http_get` command (CSP/CORS-free, host
// allowlisted). Ported from the Python aio_games resolver.
import { invoke } from "@tauri-apps/api/core";

export interface GameEntry {
  name: string;
  platform: "PS5" | "PS4";
  coverUrl: string;
  pageUrl: string;
  source?: "dlpsgame" | "pkggames";
}

export interface DownloadLink {
  label: string;
  url: string;
  host: string;
  kind: "terminal" | "landing" | "gateway";
}

const BASE = "https://dlpsgame.com";
const CATEGORY: Record<string, string> = {
  PS5: "/category/ps5/",
  PS4: "/category/ps4/",
};

async function httpGet(url: string, jina = false): Promise<string> {
  return await invoke<string>("xeno_http_get", { url, jina });
}

/** Fetch a cover image through the Rust proxy and return a data: URI.
 *  Used as a fallback when the browser's direct <img> load fails due to
 *  Cloudflare hotlink protection or a host not in CSP img-src. */
export async function fetchCoverImage(url: string): Promise<string> {
  return await invoke<string>("xeno_image_fetch", { url });
}

// one listing post block: title-link href + text, then the first <img src>
const POST_RE =
  /<div class="post bar hentry">[\s\S]*?<a href="(https?:\/\/[^"]+)"[^>]*>([^<]+)<\/a>[\s\S]*?<img[^>]+src="(https?:\/\/[^"]+)"/gi;

function parsePosts(html: string, platform: "PS5" | "PS4"): GameEntry[] {
  const out: GameEntry[] = [];
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  POST_RE.lastIndex = 0;
  while ((m = POST_RE.exec(html))) {
    const pageUrl = m[1];
    if (seen.has(pageUrl)) continue;
    seen.add(pageUrl);
    out.push({
      name: m[2].replace(/\s+/g, " ").trim(),
      platform,
      coverUrl: m[3],
      pageUrl,
    });
  }
  return out;
}

/** Normalize a game title for cross-source deduplication.
 *  Strips punctuation, collapses whitespace, drops leading articles. */
function normalizeTitle(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^(the|a|an) /, "");
}

export async function scrapePage(
  platform: "PS5" | "PS4",
  page: number,
): Promise<GameEntry[]> {
  const cat = CATEGORY[platform];
  const url = page <= 1 ? `${BASE}${cat}` : `${BASE}${cat}page/${page}/`;
  // Try a direct fetch first; if it comes back empty (a transient 403 / a
  // Cloudflare challenge), retry through the jina proxy which JS-renders the
  // page and passes the challenge. This stops one hiccup from looking like the
  // end of the catalog.
  for (const jina of [false, true]) {
    let html = "";
    try {
      html = await httpGet(url, jina);
    } catch {
      continue;
    }
    const out = parsePosts(html, platform);
    if (out.length) return out;
  }
  return [];
}

// dlpsgame is WordPress — its public REST API lists the WHOLE catalog (with
// covers) far faster + more completely than scraping category pages. Category
// ids from /wp-json/wp/v2/categories.
const WP_API = "https://dlpsgame.com/wp-json/wp/v2/posts";
const CAT_ID: Record<"PS5" | "PS4", number> = { PS5: 63019, PS4: 4370 };

function decodeEntities(s: string): string {
  return (s || "")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ");
}

/** Turn a WP REST `posts` JSON page into game entries (name + page url +
 *  cover from the first content image). */
function postsFromApi(json: string, platform: "PS5" | "PS4"): GameEntry[] {
  let arr: unknown;
  try {
    arr = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  const out: GameEntry[] = [];
  for (const post of arr as Array<Record<string, unknown>>) {
    const pageUrl = typeof post?.link === "string" ? post.link : "";
    const title = (post?.title as { rendered?: string })?.rendered ?? "";
    const name = decodeEntities(title).trim();
    if (!pageUrl || !name) continue;
    const content = (post?.content as { rendered?: string })?.rendered ?? "";
    const m = content.match(
      /<img[^>]+src="(https:\/\/dlpsgame\.com\/wp-content\/uploads\/[^"]+\.(?:jpg|jpeg|png|webp))"/i,
    );
    out.push({ name, platform, coverUrl: m ? m[1] : "", pageUrl });
  }
  return out;
}

export async function scrapeCatalog(
  platform: "PS5" | "PS4",
  pages: number,
  onProgress?: (msg: string) => void,
  existing?: GameEntry[],
  onBatch?: (all: GameEntry[]) => void,
): Promise<GameEntry[]> {
  // Pull the WHOLE catalog from dlpsgame's WordPress REST API (≈667 PS5 /
  // ≈6,386 PS4 games, covers included, no Cloudflare gate). Falls back to the
  // rendered category page for any page the API can't serve. `onBatch`
  // persists progress live so a long pull survives interruption.
  const cat = CAT_ID[platform];
  const byUrl = new Map<string, GameEntry>();
  for (const g of existing ?? []) byUrl.set(g.pageUrl, g);
  let emptyStreak = 0;
  for (let p = 1; p <= pages; p++) {
    onProgress?.(`Loading catalog… (${byUrl.size} games)`);
    let rows: GameEntry[] = [];
    try {
      const json = await httpGet(
        `${WP_API}?categories=${cat}&per_page=100&page=${p}&_fields=link,title,content`,
      );
      rows = postsFromApi(json, platform);
    } catch {
      rows = [];
    }
    // API hiccup → best-effort fall back to the rendered category page.
    if (rows.length === 0) rows = await scrapePage(platform, p);
    if (rows.length === 0) {
      if (++emptyStreak >= 2) break;
    } else {
      emptyStreak = 0;
      const before = byUrl.size;
      for (const g of rows) byUrl.set(g.pageUrl, g);
      if (byUrl.size !== before) onBatch?.([...byUrl.values()]);
      if (rows.length < 100) break; // last API page (full pages are 100)
    }
    await new Promise((r) => setTimeout(r, 250));
  }

  // Build a normalized-title dedupe set so extra sources only add new games.
  const seenNorm = new Set<string>();
  for (const g of byUrl.values()) seenNorm.add(normalizeTitle(g.name));

  if (platform === "PS5") {
    const addExtra = (entries: GameEntry[]) => {
      const before = byUrl.size;
      for (const g of entries) {
        const norm = normalizeTitle(g.name);
        if (seenNorm.has(norm)) continue;
        seenNorm.add(norm);
        byUrl.set(g.pageUrl, g);
      }
      if (byUrl.size !== before) onBatch?.([...byUrl.values()]);
    };

    onProgress?.(`Adding extra sources… (${byUrl.size} games)`);
    try {
      addExtra(await scrapeFromPkgGames());
    } catch {
      /* extra source is best-effort — never blocks the primary catalog */
    }
  }

  return [...byUrl.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// --- pkg.games PS5 catalog ------------------------------------------------ //
// Single static-HTML page lists ~500 PS5 games as a plain <ul>.
// No cover art on the list page; the StoreCover component shows the title
// initial until the user opens a game and a WP cover loads from the detail page.
async function scrapeFromPkgGames(): Promise<GameEntry[]> {
  const LIST_URL = "https://pkg.games/ps5-game-list/";
  let html = "";
  for (const useJina of [false, true]) {
    try {
      html = await httpGet(LIST_URL, useJina);
      if (html.length > 500) break;
    } catch {
      continue;
    }
  }
  if (!html) return [];

  const out: GameEntry[] = [];
  const seen = new Set<string>();
  // Pattern: href="https://pkg.games/ps5/[slug]/" followed by link text.
  const ENTRY_RE = /href="(https:\/\/pkg\.games\/ps5\/[a-z0-9\-\/]+?\/)"[^>]*>\s*([^<]+)/gi;
  for (const m of html.matchAll(ENTRY_RE)) {
    const pageUrl = m[1];
    const name = m[2].trim();
    if (!name || seen.has(pageUrl)) continue;
    seen.add(pageUrl);
    out.push({ name, platform: "PS5", coverUrl: "", pageUrl, source: "pkggames" });
  }
  return out;
}

// ---- deep download-link resolver ---------------------------------------- //
const B64_GATEWAYS = [
  "shrinkearn", "shrinkme", "shrink", "ouo.io", "gplinks",
  "rocketlink", "clk.sh", "link1s",
];
const LANDING_HOSTS = ["downloadgameps3.net", "downloadgameps4.net"];
const TERMINAL_HOSTS = [
  "1fichier", "mediafire", "mega.nz", "mega.co", "mega.io", "akirabox",
  "pixeldrain", "gofile", "buzzheavier", "rootz", "datanodes", "qiwi",
  "send.cm", "rocketfile", "fireload", "krakenfiles", "1cloudfile",
  "userscloud", "drive.google", "clicknupload", "vikingfile", "filecrypt",
  "downloadmy.link", // pkg.games RAR archives
];

function hostOf(u: string): string {
  try {
    return new URL(u).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

function decodeGateway(u: string): string | null {
  try {
    const q = new URL(u).searchParams;
    for (const key of ["url", "u", "link", "id"]) {
      const raw = q.get(key);
      if (!raw) continue;
      if (raw.startsWith("http")) return raw;
      try {
        const pad = "=".repeat((4 - (raw.length % 4)) % 4);
        const dec = atob(raw.replace(/-/g, "+").replace(/_/g, "/") + pad);
        if (dec.startsWith("http")) return dec;
      } catch {
        /* not base64 */
      }
    }
  } catch {
    /* bad url */
  }
  return null;
}

function anchors(html: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const hrefRe = /href="(https?:\/\/[^"#]+)"[^>]*>([^<]{0,80})/gi;
  const mdRe = /\[([^\]]{0,80})\]\((https?:\/\/[^)\s]+)\)/g;
  let m: RegExpExecArray | null;
  while ((m = hrefRe.exec(html))) out.push([m[2].trim(), m[1]]);
  while ((m = mdRe.exec(html))) out.push([m[1].trim(), m[2]]);
  return out;
}

// dlpsgame hides the real links in a base64 `data-payload` attr that its JS
// decodes client-side. The WP API content carries it verbatim, so we decode it
// directly (reliable) instead of hoping the proxy renders the JS accordion.
function slugFromUrl(u: string): string {
  try {
    return new URL(u).pathname.replace(/\/+$/, "").split("/").pop() || "";
  } catch {
    return "";
  }
}
// "Guide Download" / "Tool Download" help links sit on every game page — they're
// monetization/help pages, never the actual download. Drop them.
const EXCLUDE_URL_RE = /guide-download-game|guide-download|tool-download/i;
const EXCLUDE_LABEL_RE = /guide\s*download|tool\s*download|jdownload/i;

async function linksHtmlFor(pageUrl: string): Promise<string> {
  // 1) WP API content's base64 `data-payload` (reliable — always present).
  //    Only for dlpsgame URLs — other sources (pkg.games) have their own slugs
  //    that could collide with an unrelated dlpsgame post, so we skip straight
  //    to rendering their page.
  const slug = pageUrl.includes("dlpsgame.com") ? slugFromUrl(pageUrl) : "";
  if (slug) {
    try {
      const json = await httpGet(
        `https://dlpsgame.com/wp-json/wp/v2/posts?slug=${slug}&_fields=content`,
      );
      const arr = JSON.parse(json) as Array<{ content?: { rendered?: string } }>;
      const content = arr?.[0]?.content?.rendered ?? "";
      const m = content.match(/data-payload="([A-Za-z0-9+/=]+)"/);
      if (m) {
        try {
          return atob(m[1]);
        } catch {
          /* not valid base64 — fall through */
        }
      }
    } catch {
      /* API miss — fall through to the rendered page */
    }
  }
  // 2) fallback: render the page through the proxy.
  try {
    return await httpGet(pageUrl, true);
  } catch {
    return "";
  }
}

export async function fetchDownloadLinks(
  pageUrl: string,
  deep = true,
): Promise<DownloadLink[]> {
  const html = await linksHtmlFor(pageUrl);
  if (!html) return [];
  const seen = new Set<string>();
  const out: DownloadLink[] = [];
  const landing: Array<[string, string]> = [];
  const add = (label: string, url: string, kind: DownloadLink["kind"]) => {
    const u = url.trim().replace(/\)+$/, "");
    if (!u || seen.has(u)) return;
    seen.add(u);
    const host = hostOf(u);
    out.push({ label: (label || host).slice(0, 70) || host, url: u, host, kind });
  };

  for (let [label, url] of anchors(html)) {
    // Skip the per-game "Guide Download" / "Tool Download" help links.
    if (EXCLUDE_URL_RE.test(url) || EXCLUDE_LABEL_RE.test(label)) continue;
    let host = hostOf(url);
    // Decode a gateway-embedded real URL from ANY anchor — link shorteners pack
    // the real destination as a base64 `url=`/`u=`/`link=` param, so we never
    // have to sit through their ad-gate. Works for gateways NOT in our known
    // list too, so new shorteners resolve automatically.
    const dest = decodeGateway(url);
    if (dest) {
      url = dest;
      host = hostOf(url);
    }
    if (TERMINAL_HOSTS.some((t) => host.includes(t))) add(label, url, "terminal");
    else if (LANDING_HOSTS.some((l) => host.includes(l))) {
      landing.push([label, url]);
      add(label, url, "landing");
    } else if (B64_GATEWAYS.some((g) => host.includes(g))) add(label, url, "gateway");
  }

  if (deep && landing.length) {
    for (const [label, lurl] of landing.slice(0, 8)) {
      let lhtml = "";
      try {
        lhtml = await httpGet(lurl, true);
      } catch {
        continue;
      }
      for (const [, url2] of anchors(lhtml)) {
        const h2 = hostOf(url2);
        if (TERMINAL_HOSTS.some((t) => h2.includes(t))) {
          const tag = h2.split(".")[0];
          add(label ? `${label} · ${tag}` : tag, url2, "terminal");
        }
      }
    }
  }
  const order = { terminal: 0, landing: 1, gateway: 2 } as const;
  out.sort((a, b) => order[a.kind] - order[b.kind]);
  return out;
}
