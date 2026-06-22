// XENO Game Store — dlpsgame.com catalog scrape + deep download-link resolver.
// All HTTP goes through the Rust `xeno_http_get` command (CSP/CORS-free, host
// allowlisted). Ported from the Python aio_games resolver.
import { invoke } from "@tauri-apps/api/core";

export interface GameEntry {
  name: string;
  platform: "PS5" | "PS4";
  coverUrl: string;
  pageUrl: string;
  altUrls?: string[];
  source?: "dlpsgame" | "pkggames" | "pspkg" | "superpsx" | "arabicps4";
}

export interface DownloadLink {
  label: string;
  url: string;
  host: string;
  kind: "terminal" | "landing" | "gateway";
}

/** Structured download bundle, dlpsgame-only. Each game on dlpsgame is laid
 *  out as one block per (titleId × region × base-version) with rich sub-
 *  sections (base game / each update with FW-compat tag / each DLC set) +
 *  password and language metadata. The flat DownloadLink[] view loses all
 *  of that structure; this bundle preserves it. */
export interface BundleMirror {
  host: string;
  url: string;
}
export interface BundleUpdate {
  version: string;
  compat?: string;
  mirrors: BundleMirror[];
}
export interface BundleDLC {
  label: string;
  mirrors: BundleMirror[];
}
export interface GameBundleVersion {
  titleId: string;
  region: string;
  baseVersion?: string;
  game?: { mirrors: BundleMirror[] };
  updates: BundleUpdate[];
  dlc: BundleDLC[];
  password?: string;
  languages?: string;
  voice?: string;
  subtitles?: string;
  credits?: string;
}
export interface GameDownloadBundle {
  versions: GameBundleVersion[];
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
      name: cleanGameTitle(m[2].replace(/\s+/g, " ").trim()),
      platform,
      coverUrl: m[3],
      pageUrl,
    });
  }
  return out;
}

/** Strip platform/version/region/type suffixes that game-site posts append to titles.
 *  Safe to call on already-clean names — acts as a no-op for clean inputs. */
function cleanGameTitle(raw: string): string {
  let s = raw.trim();
  // Bracket-wrapped version tags: [v1.00], [1.00.002], [v2.01.000]
  s = s.replace(/\s*\[\s*v?\d+[\d.]*\s*\]/gi, "");
  // Paren-wrapped version tags with v prefix: (v1.00), (v2.01.000)
  s = s.replace(/\s*\(\s*v\d+[\d.]*\s*\)/gi, "");
  // Inline version with v prefix at word/line boundary: "Game v1.00", "v1.003.001"
  s = s.replace(/\s+v\d+[\d.]*(?=\s|$)/gi, "");
  // Platform identifiers (standalone): PS4, PS5, PS4/PS5, (PS5), [PS4]
  s = s.replace(/\s*[\[(]?\s*PS[45](?:\/PS[45])?\s*[\])]?(?=\s|\/|$)/gi, "");
  // Type identifiers: [FPkg], (FPkg), [Fake PKG], trailing FPkg/PKG
  s = s.replace(/\s*[\[(]\s*(?:Fake\s+)?F?PKG\s*[\])]/gi, "");
  s = s.replace(/\s+(?:Fake\s+)?F?PKG(?=\s|$)/gi, "");
  // Region codes in parens: (EUR), (USA), (JPN), (ASIA), (KOR), (JAP), (PAL)
  s = s.replace(/\s*\((?:EUR|USA|JPN|ASIA|KOR|JAP|NTSC|PAL)\)/gi, "");
  // Console title IDs in parens: (CUSA12345), (PPSA12345)
  s = s.replace(/\s*\([A-Z]{4}\d{5}\b[^)]*\)/g, "");
  // Trailing punctuation / slash / whitespace
  s = s.replace(/[-:,\/\s]+$/, "").trim();
  return s.replace(/\s+/g, " ").trim();
}

/** Normalize a game title for cross-source deduplication.
 *  Calls cleanGameTitle first (strips versions/platform tags), then
 *  lowercases, removes remaining punctuation, drops leading articles. */
function normalizeTitle(name: string): string {
  return cleanGameTitle(name)
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

/** Turn a WP REST `posts` JSON page into game entries (name + page url + cover).
 *  Cover priority: 1) wp:featuredmedia embedded source_url  2) first wp-content
 *  img in content.rendered.  Requires the request to include _embed=wp:featuredmedia
 *  and _fields to include _embedded. */
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
    const name = cleanGameTitle(decodeEntities(title));
    if (!pageUrl || !name) continue;

    // 1) Featured image from _embed=wp:featuredmedia (most reliable cover source)
    type FM = Array<{ source_url?: string; media_details?: { sizes?: Record<string, { source_url?: string }> } }>;
    const embedded = (post?._embedded as { "wp:featuredmedia"?: FM }) ?? {};
    const fm = embedded["wp:featuredmedia"]?.[0];
    const featuredUrl =
      fm?.media_details?.sizes?.["medium_large"]?.source_url ??
      fm?.media_details?.sizes?.["medium"]?.source_url ??
      fm?.source_url ??
      "";

    // 2) Fallback: first wp-content image in the post content
    const content = (post?.content as { rendered?: string })?.rendered ?? "";
    const contentImg =
      content.match(
        /<img[^>]+src="(https?:\/\/[^"]+\/wp-content\/uploads\/[^"]+\.(?:jpg|jpeg|png|webp))"/i,
      )?.[1] ?? "";

    out.push({ name, platform, coverUrl: featuredUrl || contentImg, pageUrl });
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
  // Clean cached entries immediately so old dirty names normalize correctly.
  for (const g of existing ?? []) byUrl.set(g.pageUrl, { ...g, name: cleanGameTitle(g.name) });
  let emptyStreak = 0;
  for (let p = 1; p <= pages; p++) {
    onProgress?.(`Loading catalog… (${byUrl.size} games)`);
    let rows: GameEntry[] = [];
    try {
      const json = await httpGet(
        `${WP_API}?categories=${cat}&per_page=100&page=${p}&_embed=wp:featuredmedia&_fields=link,title,content,_embedded`,
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

  // Intra-source dedup: dlpsgame posts the same game at multiple versions, each
  // with a different URL and now a shared clean title. Collapse by normalizeTitle,
  // keeping the entry with cover art (or the first seen = newest from API sort).
  {
    const byNorm = new Map<string, GameEntry>();
    for (const g of byUrl.values()) {
      const norm = normalizeTitle(g.name);
      const ex = byNorm.get(norm);
      if (!ex || (!ex.coverUrl && g.coverUrl)) byNorm.set(norm, g);
    }
    byUrl.clear();
    for (const g of byNorm.values()) byUrl.set(g.pageUrl, g);
  }

  // Build normToKey for cross-source merging: same game from different sources
  // gets its URL added to altUrls (for multi-source link fetching) and its
  // cover merged in if the primary entry has none.
  const normToKey = new Map<string, string>(); // normalized title → primary pageUrl
  for (const [k, v] of byUrl) normToKey.set(normalizeTitle(v.name), k);

  const mergeExtra = (entries: GameEntry[]) => {
    let changed = false;
    for (const g of entries) {
      const norm = normalizeTitle(g.name);
      const existingKey = normToKey.get(norm);
      if (existingKey) {
        // Already in catalog — merge cover + track this source URL for link fetching
        const ex = byUrl.get(existingKey);
        if (ex) {
          let updated = false;
          if (!ex.coverUrl && g.coverUrl) { ex.coverUrl = g.coverUrl; updated = true; }
          if (g.pageUrl !== ex.pageUrl) {
            if (!ex.altUrls) ex.altUrls = [];
            if (!ex.altUrls.includes(g.pageUrl)) { ex.altUrls.push(g.pageUrl); updated = true; }
          }
          if (updated) changed = true;
        }
        continue;
      }
      normToKey.set(norm, g.pageUrl);
      byUrl.set(g.pageUrl, g);
      changed = true;
    }
    if (changed) onBatch?.([...byUrl.values()]);
  };

  if (platform === "PS5") {
    onProgress?.(`Adding pkg.games source… (${byUrl.size} games)`);
    try {
      mergeExtra(await scrapeFromPkgGames());
    } catch {
      /* best-effort */
    }
  }

  onProgress?.(`Adding pspkg.com source… (${byUrl.size} games)`);
  try {
    mergeExtra(await scrapeFromPspkg(platform));
  } catch {
    /* best-effort */
  }

  onProgress?.(`Adding superpsx.com source… (${byUrl.size} games)`);
  try {
    mergeExtra(await scrapeFromSuperpsx(platform));
  } catch {
    /* best-effort — never blocks the primary catalog */
  }

  onProgress?.(`Adding arabicps4games.com source… (${byUrl.size} games)`);
  try {
    mergeExtra(await scrapeFromArabicps4(platform));
  } catch {
    /* best-effort */
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
    const name = cleanGameTitle(m[2].trim());
    if (!name || seen.has(pageUrl)) continue;
    seen.add(pageUrl);
    out.push({ name, platform: "PS5", coverUrl: "", pageUrl, source: "pkggames" });
  }
  return out;
}

// --- pspkg.com PS4/PS5 catalog -------------------------------------------- //
// pspkg.com is Cloudflare-protected so we always route through jina.
// Catalog pages live at /ps4/ and /ps5/ with /page/N/ pagination.
async function scrapeFromPspkg(platform: "PS5" | "PS4"): Promise<GameEntry[]> {
  const pfx = platform.toLowerCase();
  const BASE_URL = `https://pspkg.com/${pfx}/`;

  const out: GameEntry[] = [];
  const seen = new Set<string>();

  for (let page = 1; page <= 80; page++) {
    const url = page === 1 ? BASE_URL : `${BASE_URL}page/${page}/`;
    let html = "";
    for (const useJina of [true, false]) {
      try {
        html = await httpGet(url, useJina);
        if (html.length > 500) break;
      } catch {
        continue;
      }
    }
    if (!html || html.length < 500) break;

    // Match every game detail link on this listing page.
    // Pattern: href="https://pspkg.com/ps4/download-SLUG-ps4-ID.html"
    const linkPattern = new RegExp(
      `href="(https://pspkg\\.com/${pfx}/download-([a-z0-9\\-]+)-${pfx}-\\d+\\.html)"`,
      "gi",
    );
    const matches = [...html.matchAll(linkPattern)];
    if (matches.length === 0) break;

    let added = 0;
    for (const m of matches) {
      const pageUrl = m[1];
      const slug = m[2];
      if (seen.has(pageUrl)) continue;
      seen.add(pageUrl);

      // Scan 600 chars after the link tag for a title string and cover image.
      const pos = m.index ?? 0;
      const chunk = html.slice(pos, pos + 600);

      // Title: look for alt="…" / title="…" or plain anchor text >…<
      let name = "";
      const titleMatches = [
        ...chunk.matchAll(/(?:alt|title)="([^"]{4,120})"/gi),
        ...chunk.matchAll(/>([^<]{4,80})</g),
      ];
      for (const tm of titleMatches) {
        const candidate = (tm[1] ?? "").trim();
        if (
          candidate.length >= 4 &&
          !/^(download|game|update|dlc|click|here|free|ps[45]|4gamer|password|region)/i.test(
            candidate,
          )
        ) {
          name = candidate;
          break;
        }
      }
      if (!name) {
        // Humanize slug: "call-of-duty-modern-warfare-3-ps4" → "Call Of Duty Modern Warfare 3"
        name = slug
          .replace(new RegExp(`-${pfx}$`, "i"), "")
          .replace(/-/g, " ")
          .replace(/\b\w/g, (c) => c.toUpperCase());
      }

      const imgMatch = chunk.match(
        /src="(https?:\/\/[^"]+\.(?:jpg|jpeg|png|webp))"/i,
      );
      const coverUrl = imgMatch ? imgMatch[1] : "";

      out.push({ name: cleanGameTitle(name), platform, coverUrl, pageUrl, source: "pspkg" });
      added++;
    }

    if (added === 0) break;
    if (added < 8 && page > 1) break;

    await new Promise((r) => setTimeout(r, 350));
  }

  return out;
}

// --- superpsx.com PS4/PS5 catalog ----------------------------------------- //
// superpsx.com uses the Pencil WordPress theme. Cover art is in a CSS lazy-load
// attribute `data-bgset` on the card anchor — NOT a standard <img src>. We try
// a direct Rust fetch first (different UA/IP from the browser); if blocked we
// fall through to jina rendering which executes the JS and surfaces the images.
// Pagination: /category/ps4/ps4-games-free/page/N/ (124 pages × 20 games)
//             /category/ps5/ps5-games/page/N/        (24 pages × 20 games)
async function scrapeFromSuperpsx(platform: "PS5" | "PS4"): Promise<GameEntry[]> {
  const BASE_URL =
    platform === "PS4"
      ? "https://www.superpsx.com/category/ps4/ps4-games-free/"
      : "https://www.superpsx.com/category/ps5/ps5-games/";
  const MAX_PAGES = platform === "PS4" ? 130 : 30;

  const seen = new Set<string>();
  const results: GameEntry[] = [];

  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = page === 1 ? BASE_URL : `${BASE_URL}page/${page}/`;
    let html = "";
    for (const useJina of [false, true]) {
      try {
        html = await httpGet(url, useJina);
        if (html.length > 500) break;
      } catch {
        continue;
      }
    }
    // First page: if both fetch strategies failed, give up immediately.
    if (!html || html.length < 500) {
      if (page === 1) break;
      continue;
    }

    const before = results.length;

    // --- Strategy A: raw HTML from a direct Rust fetch ---
    // The Pencil theme puts each card's cover URL in data-bgset and the title
    // in h2.penci-entry-title > a. We harvest both in one paired pass.
    //
    // data-bgset pattern: data-bgset="https://…/wp-content/uploads/….webp"
    // title+link pattern: class="…penci-entry-title…"><a href="URL">TITLE</a>
    const bgCovers = [...html.matchAll(
      /data-bgset="(https?:\/\/[^"]+\/wp-content\/uploads\/[^"]+\.(?:webp|jpg|jpeg|png))"/gi,
    )].map((m) => m[1]);

    const titleLinks = [...html.matchAll(
      /class="[^"]*penci-entry-title[^"]*"[\s\S]{0,300}?<a\s[^>]*href="(https?:\/\/(?:www\.)?superpsx\.com\/(?!category|tag|page\/|wp-|author|feed)[a-z0-9][a-z0-9-]*\/)"[^>]*>([^<]{2,120})<\/a>/gi,
    )];

    if (titleLinks.length > 0) {
      titleLinks.forEach((m, i) => {
        const pageUrl = m[1];
        if (seen.has(pageUrl)) return;
        seen.add(pageUrl);

        let name = decodeEntities(m[2]).trim();
        // "Hunting Simulator 2 PS4 [FPkg]" → "Hunting Simulator 2"
        name = name.replace(/\s*[\[(][^\])]*[\])]/g, "").trim();
        name = name.replace(/\s+(PS[45]|FPkg|fpkg|PKG)\b.*/i, "").trim();
        name = cleanGameTitle(name);

        results.push({
          name: name || cleanGameTitle(m[2].trim()),
          platform,
          coverUrl: bgCovers[i] ?? "",
          pageUrl,
          source: "superpsx",
        });
      });
    } else {
      // --- Strategy B: jina markdown ---
      // Jina renders lazy images, so data-bgset → normal <img> → markdown ![](url).
      // Game links appear as [Title](https://www.superpsx.com/slug/).
      const mdLinks = [...html.matchAll(
        /\[([^\]]{2,120})\]\((https?:\/\/(?:www\.)?superpsx\.com\/(?!category|tag|page\/|wp-|author|feed)[a-z0-9][a-z0-9-]*\/)\)/gi,
      )];
      const mdImgs = [...html.matchAll(
        /!\[[^\]]*\]\((https?:\/\/(?:www\.)?superpsx\.com\/wp-content\/uploads\/[^)]+\.(?:webp|jpg|jpeg|png))\)/gi,
      )].map((m) => m[1]);

      mdLinks.forEach((m, i) => {
        const pageUrl = m[2];
        if (seen.has(pageUrl)) return;
        // Skip navigation / category links that slip through
        if (/^(next|prev|previous|page|home|menu|read more|download|back)/i.test(m[1])) return;
        seen.add(pageUrl);

        let name = decodeEntities(m[1]).trim();
        name = name.replace(/\s*[\[(][^\])]*[\])]/g, "").trim();
        name = name.replace(/\s+(PS[45]|FPkg|fpkg|PKG)\b.*/i, "").trim();
        name = cleanGameTitle(name);

        results.push({
          name: name || cleanGameTitle(m[1].trim()),
          platform,
          coverUrl: mdImgs[i] ?? "",
          pageUrl,
          source: "superpsx",
        });
      });
    }

    if (results.length === before) break; // no new games — end of catalog
    await new Promise((r) => setTimeout(r, 350));
  }

  return results;
}

// ---- deep download-link resolver ---------------------------------------- //
const B64_GATEWAYS = [
  "shrinkearn", "shrinkme", "shrink", "ouo.io", "gplinks",
  "rocketlink", "clk.sh", "link1s",
  // arabicps4games.com ad-shorteners (opaque redirect, no embedded URL in path)
  "tii.la", "tpi.li", "exe.io", "cuty.io",
];
const LANDING_HOSTS = ["downloadgameps3.net", "downloadgameps4.net"];
const TERMINAL_HOSTS = [
  "1fichier", "mediafire", "mega.nz", "mega.co", "mega.io", "akirabox",
  "pixeldrain", "gofile", "buzzheavier", "rootz", "datanodes", "qiwi",
  "send.cm", "rocketfile", "fireload", "krakenfiles", "1cloudfile",
  "userscloud", "drive.google", "clicknupload", "vikingfile", "filecrypt",
  "downloadmy.link", // pkg.games RAR archives
  "filekeeper",      // superpsx.com primary host (filekeeper.net RAR direct links)
  "rapidgator", "uploadhaven", "hexupload", "uploadrar", "turbobit",
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
    // justpaste.it/redirect/SLUG/PERCENT_ENCODED_DEST — destination is in the path
    if (u.includes("justpaste.it/redirect/")) {
      const parts = new URL(u).pathname.split("/").filter(Boolean);
      // ["redirect", "SLUG", "https%3A%2F%2F..."]
      if (parts.length >= 3) {
        try { return decodeURIComponent(parts[2]); } catch {}
      }
    }
    const q = new URL(u).searchParams;
    // Add "s" for ouo.io?s=URL (plain URL, not base64) alongside the usual keys.
    for (const key of ["url", "u", "link", "id", "s"]) {
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
  // Fast path: if pageUrl itself encodes the destination (e.g., ouo.io?s=URL or
  // justpaste.it/redirect/SLUG/URL), decode it immediately and return synthetic HTML
  // so we never have to fetch the ad-redirect page at all.
  const quickDecode = decodeGateway(pageUrl);
  if (quickDecode && quickDecode !== pageUrl && quickDecode.startsWith("http")) {
    return `<a href="${quickDecode}">Direct Link</a>`;
  }

  // superpsx.com uses a two-hop redirect:
  //   game detail page → internal /dll-SLUG/ page → real filekeeper/1fichier links.
  // We must follow the hop ourselves before the link parser runs.
  if (pageUrl.includes("superpsx.com")) {
    let detailHtml = "";
    for (const useJina of [false, true]) {
      try {
        detailHtml = await httpGet(pageUrl, useJina);
        if (detailHtml.length > 500) break;
      } catch { continue; }
    }
    // Find the /dll-*/ redirect URL (appears in raw HTML and jina markdown).
    const dllMatch = detailHtml.match(
      /https?:\/\/(?:www\.)?superpsx\.com\/(dll-[a-z0-9-]+)\//i,
    );
    if (dllMatch) {
      const dllUrl = `https://www.superpsx.com/${dllMatch[1]}/`;
      for (const useJina of [false, true]) {
        try {
          const dllHtml = await httpGet(dllUrl, useJina);
          if (dllHtml.length > 200) return dllHtml;
        } catch { continue; }
      }
    }
    return detailHtml;
  }

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
  altUrls?: string[],
): Promise<DownloadLink[]> {
  // Fetch HTML for primary URL + all alt-source URLs in parallel, then merge results.
  const allUrls = [pageUrl, ...(altUrls ?? [])];
  const htmlBodies = await Promise.all(allUrls.map((u) => linksHtmlFor(u).catch(() => "")));

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

  for (const html of htmlBodies) {
    if (!html) continue;
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

/**
 * Fetch dlpsgame's RICH per-version structure: one block per (titleId × region
 * × version) with Game / Updates (each with FW-compat tag) / DLC sets / password
 * / language. The page's "Link Download" / "Link Mirror" accordions render
 * client-side from base64-encoded `data-payload` attrs — that's where all the
 * real link structure lives. We pull the post via the WP REST API (preserves
 * those attrs verbatim), decode each payload, and parse one version per attr.
 *
 * Returns null when the URL isn't a dlpsgame page or the post isn't reachable.
 * Mirror entries with no `<a>` (plain-text host names in the source — e.g.
 * "Lets" / "Mega" with no URL) are SKIPPED — they're not actionable for the
 * user. Mirror count per section will reflect only links we can actually
 * surface, not the count visible on dlpsgame.
 */
export async function fetchDownloadBundle(pageUrl: string): Promise<GameDownloadBundle | null> {
  if (!pageUrl.includes("dlpsgame.com")) return null;
  const slug = slugFromUrl(pageUrl);
  if (!slug) return null;

  const apiUrl = `https://dlpsgame.com/wp-json/wp/v2/posts?slug=${encodeURIComponent(slug)}&_fields=content`;
  let posts: Array<{ content: { rendered: string } }>;
  try {
    const txt = await httpGet(apiUrl, false);
    posts = JSON.parse(txt);
  } catch {
    return null;
  }
  if (!Array.isArray(posts) || posts.length === 0) return null;
  const rawHtml = posts[0]?.content?.rendered ?? "";
  if (!rawHtml) return null;
  // Decode HTML entities up front so the header regex sees actual en-dashes
  // and apostrophes instead of `&#8211;` / `&#8217;`. We have to keep ALL
  // index offsets stable between header search and payload search, so we
  // search the SAME decoded string for both.
  const html = htmlEntitiesDecode(rawHtml);

  // Pair each data-payload with the preceding version-header heading so we
  // know which titleId/region/version each block belongs to before parsing.
  // The page layout is: <h?>CUSA12345 - REGION (v1.23)</h?> … data-payload="…"
  const HEADER_RE =
    /((?:CUSA|PPSA|PCAS)\s*\d{5})\s*[-–—]\s*([A-Z]{2,4})(?:\s*\(\s*v([0-9]+(?:\.[0-9]+){0,3})\s*\))?/gi;
  const PAYLOAD_RE = /data-payload="([^"]+)"/g;
  type HeaderHit = { titleId: string; region: string; version?: string; idx: number };
  const headers: HeaderHit[] = [];
  let hm: RegExpExecArray | null;
  while ((hm = HEADER_RE.exec(html))) {
    headers.push({
      titleId: hm[1].replace(/\s+/g, "").toUpperCase(),
      region: hm[2].toUpperCase(),
      version: hm[3] || undefined,
      idx: hm.index,
    });
  }
  const versions: GameBundleVersion[] = [];
  let pm: RegExpExecArray | null;
  while ((pm = PAYLOAD_RE.exec(html))) {
    const payloadIdx = pm.index;
    // Closest preceding header is the owner of this payload.
    let header: HeaderHit | null = null;
    for (const h of headers) {
      if (h.idx < payloadIdx && (!header || h.idx > header.idx)) header = h;
    }
    let decodedHtml = "";
    try {
      decodedHtml = atob(pm[1].replace(/\s+/g, ""));
    } catch {
      continue;
    }
    const parsed = parseBundleVersionBlock(decodedHtml, header);
    if (parsed) versions.push(parsed);
  }
  if (versions.length === 0) return null;
  return { versions };
}

function htmlEntitiesDecode(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&apos;/g, "'");
}

/** Extract {host, url} for every <a> in a fragment, deduping by URL and
 *  passing each href through decodeGateway() so shortener links resolve to
 *  the real terminal URL (gofile/1fichier/mega/mediafire/etc.). */
function extractBundleMirrors(html: string): BundleMirror[] {
  const out: BundleMirror[] = [];
  const seen = new Set<string>();
  const re = /<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    let url = m[1].trim();
    const text = htmlEntitiesDecode(m[2].replace(/<[^>]+>/g, "")).trim();
    const decoded = decodeGateway(url);
    if (decoded) url = decoded;
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push({ host: text || hostOf(url), url });
  }
  return out;
}

function parseBundleVersionBlock(
  html: string,
  header: { titleId: string; region: string; version?: string } | null,
): GameBundleVersion | null {
  const decoded = htmlEntitiesDecode(html);
  // Pull title-id/region from inline if not in header
  const idM = decoded.match(
    /((?:C?USA|PPSA|PCAS)\d{5})\s*[-–—]\s*([A-Z]{2,4})/i,
  );
  const titleId = (header?.titleId || idM?.[1] || "").toUpperCase();
  const region = (header?.region || idM?.[2] || "").toUpperCase();
  if (!titleId) return null;
  const baseVersion =
    header?.version || decoded.match(/v([0-9]+(?:\.[0-9]+){0,3})/i)?.[1];

  // Walk each <p> block — that's how dlpsgame structures sections.
  const blocks: string[] = [];
  const pRe = /<p[^>]*>([\s\S]*?)<\/p>/g;
  let bm: RegExpExecArray | null;
  while ((bm = pRe.exec(decoded))) blocks.push(bm[1]);

  let game: { mirrors: BundleMirror[] } | undefined;
  const updates: BundleUpdate[] = [];
  const dlc: BundleDLC[] = [];
  let password: string | undefined;
  let languages: string | undefined;
  let voice: string | undefined;
  let subtitles: string | undefined;
  let credits: string | undefined;

  for (const raw of blocks) {
    // Plain-text view for label matching, but extract mirrors from raw <a>.
    const text = raw.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    if (!text) continue;

    // "Thank @..." credits line (only first one)
    if (!credits && /^Thank\b/i.test(text)) {
      credits = text;
      continue;
    }

    // "Game : ..."
    if (/^Game\s*:/i.test(text)) {
      const mirrors = extractBundleMirrors(raw);
      if (mirrors.length || !game) game = { mirrors };
      continue;
    }

    // "Update 1.37 (Fix 5.05/6.72/...) : Lets - ..."
    const upM = text.match(/^Update\s+([0-9]+(?:\.[0-9]+){0,3})\s*(\(([^)]+)\))?\s*:/i);
    if (upM) {
      updates.push({
        version: upM[1],
        compat: upM[3]?.trim() || undefined,
        mirrors: extractBundleMirrors(raw),
      });
      continue;
    }

    // "DLC v3 (20) : ..." / "DLC (18) : ..." / "DLC : ..."
    if (/^DLC\b[^:]*:/i.test(text)) {
      const label = text.slice(0, text.indexOf(":")).trim();
      const mirrors = extractBundleMirrors(raw);
      // Skip "DLC (NN) Contents : Here" — the Here link is a docs page, not a download.
      if (/contents\b/i.test(label)) continue;
      dlc.push({ label, mirrors });
      continue;
    }

    // Password (handle the common "Pasword" typo too)
    const pwM = text.match(/^P[a]?(?:as)?sw[o]rd\s*:\s*(\S[^,]*)/i);
    if (pwM && !password) {
      password = pwM[1].replace(/\s+\(.*$/, "").trim();
      continue;
    }

    // "Languages : ..." (single line)
    if (/^Languages?\s*:/i.test(text) && !/voice|subtitle/i.test(text)) {
      if (!languages) languages = text.replace(/^Languages?\s*:\s*/i, "").trim();
      continue;
    }

    // "Language (Voice) : English, Japanese" + sometimes followed by Menu & Subtitles
    const voiceM = text.match(/Language[s]?\s*\(\s*Voice\s*\)\s*:\s*([^]*?)(?=(?:Menu|Subtitles?)|$)/i);
    if (voiceM && !voice) voice = voiceM[1].replace(/[,\s]+$/, "").trim();
    const subM = text.match(/(?:Menu\s*&\s*Subtitles?|^Subtitles?)\s*:\s*(.+)$/i);
    if (subM && !subtitles) subtitles = subM[1].trim();
  }

  if (!game && updates.length === 0 && dlc.length === 0) return null;
  return {
    titleId,
    region,
    baseVersion,
    game,
    updates,
    dlc,
    password,
    languages,
    voice,
    subtitles,
    credits,
  };
}

// --- arabicps4games.com PS4/PS5 catalog ------------------------------------ //
// Three sections scraped:
//   PS4 direct: /0/ps4/index.html + indexpages2..11.html  (≈5,241 games, raw HTML)
//   PS5 direct: /0/ps5/index.html                         (≈94 games, JS-unescape obfuscated)
//   PS5 torrent: /0/ps5torrent/0/0/index.html             (≈146 games, raw HTML, covers)
//
// The site pads URL attribute values with whitespace — every extracted URL must
// be .trim()med. Cover art is served from i.postimg.cc.
// PS5 direct games link to justpaste.it pages; "Get links" fetches those via jina
// and the justpaste.it/redirect/ decoder in decodeGateway resolves the real mirrors.

/** Decode a JS unescape-obfuscated HTML block.
 *  The technique percent-encodes every byte of the real HTML; the page then calls
 *  the browser's unescape() at runtime. We replicate that decode in TypeScript. */
function decodeJsUnescape(html: string): string {
  const m = html.match(/unescape\('([^']{50,})'\)/);
  if (!m) return "";
  // Handle %XX sequences — replace byte-by-byte to avoid decodeURIComponent
  // throwing on malformed sequences that sometimes appear at the end.
  return m[1].replace(/%([0-9A-Fa-f]{2})/g, (_, h) =>
    String.fromCharCode(parseInt(h, 16)),
  );
}

/** Parse a card-grid listing page from arabicps4games.com into game entries.
 *  Each card has: primary link (video-tmb anchor), cover img (postimg.cc), and
 *  title + secondary link inside .card-body.  All URL values are whitespace-padded
 *  and must be trimmed.  Torrent titles carry "[PS5] … (PPSA12345) [1.00]"
 *  formatting that is stripped to the plain game name. */
function parseArabicCardHtml(html: string, platform: "PS5" | "PS4"): GameEntry[] {
  const out: GameEntry[] = [];
  const seen = new Set<string>();

  // Split on the card list-item boundary — each card is wrapped in <li>
  const cards = html.split("<li>").slice(1);

  for (const card of cards) {
    // Primary download link: the anchor that wraps the cover image (class="video-tmb")
    const m1Raw =
      card.match(/href="([^"]+)"[^>]*class="video-tmb"/i)?.[1] ??
      card.match(/class="video-tmb"[^>]*href="([^"]+)"/i)?.[1] ??
      "";
    const mirror1 = m1Raw.trim();
    if (!mirror1 || !mirror1.startsWith("http")) continue;

    // Cover image: first <img src="…"> in the card (always postimg.cc or similar)
    const coverRaw = card.match(/<img[^>]+src="([^"]+)"/i)?.[1]?.trim() ?? "";
    const coverUrl = coverRaw.startsWith("http") ? coverRaw : "";

    // Title: card-body anchor text BEFORE the <br> separator
    // Direct format:  "GAME TITLE   <br>(Download Link Mirror 2)"
    // Torrent format: "[PS5] Game Name (PPSA15716) [1.00]</a>"
    const titleRaw =
      card.match(/card-body[\s\S]{0,600}?<a[^>]*>([\s\S]{1,200}?)<br/i)?.[1] ??
      card.match(/card-body[\s\S]{0,600}?<a[^>]*>([^<]{2,120})<\/a>/i)?.[1] ??
      "";
    if (!titleRaw) continue;

    let name = titleRaw
      .replace(/<[^>]+>/g, "")
      .replace(/\s+/g, " ")
      .trim();

    // Strip torrent-section prefix "[PS5]" and suffix "(PPSA15716) [1.00]"
    name = name.replace(/^\[PS[45]\]\s*/i, "");
    name = name
      .replace(
        /\s*\((?:PPSA|CUSA|BCAS|BCES|BLES|NPEA|NPUB|BCEU|BLAS|BLUS)\d+\).*$/i,
        "",
      )
      .trim();
    name = name.replace(/\s*\[\d+\.\d+[^\]]*\]\s*$/i, "").trim();
    name = cleanGameTitle(name);

    if (!name || name.length < 2) continue;
    if (seen.has(mirror1)) continue;
    seen.add(mirror1);

    out.push({ name, platform, coverUrl, pageUrl: mirror1, source: "arabicps4" });
  }
  return out;
}

// ---- cover helpers / hydration ------------------------------------------ //

/** Minimal normalization used as keys in the extra-cover cache.
 *  Must be identical in xenoStore (write) and GameStore (read). */
export function coverNorm(s: string): string {
  return (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Batch-fetch covers from Wikipedia's pageimages API for games missing a cover.
 *  Sends up to 40 titles per request (~3 req/sec).
 *  Returns coverNorm(name) → Wikipedia thumbnail URL.
 *  Persist the result to localStorage("xeno.covers.extra"); GameStore passes the
 *  resolved URL into StoreCover as extraCoverUrl (stage-5 fallback). */
export async function hydrateCoversWikipedia(
  games: GameEntry[],
  signal?: AbortSignal,
  onProgress?: (done: number, total: number) => void,
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const todo = games.filter((g) => !g.coverUrl);
  const BATCH = 40; // keep under Wikipedia's 50-title limit

  for (let i = 0; i < todo.length; i += BATCH) {
    if (signal?.aborted) break;
    const batch = todo.slice(i, i + BATCH);

    // Appending the platform + "video game" guides Wikipedia to the most recent
    // release: "God of War PS4 video game" → 2018 article, not the PS2 original.
    const queries = batch.map((g) => `${g.name} ${g.platform} video game`);
    const titlesParam = queries.map((q) => q.replace(/\s+/g, "_")).join("|");

    try {
      const json = await httpGet(
        `https://en.wikipedia.org/w/api.php?action=query&titles=${encodeURIComponent(titlesParam)}&prop=pageimages&pithumbsize=400&redirects=1&format=json&pilimit=50`,
      );
      const data = JSON.parse(json) as {
        query?: {
          normalized?: Array<{ from: string; to: string }>;
          redirects?: Array<{ from: string; to: string }>;
          pages?: Record<
            string,
            { title?: string; thumbnail?: { source?: string }; missing?: "" }
          >;
        };
      };

      // Build a chain: query title (lowercase + underscored) → batch index.
      // Wikipedia's normalized + redirects arrays tell us the full mapping from
      // our queried title to the final article title.
      const chain = new Map<string, number>();
      for (let j = 0; j < queries.length; j++) {
        chain.set(queries[j].toLowerCase().replace(/\s+/g, "_"), j);
      }
      for (const n of data?.query?.normalized ?? []) {
        const idx = chain.get(n.from.toLowerCase().replace(/\s+/g, "_"));
        if (idx !== undefined) chain.set(n.to.toLowerCase().replace(/\s+/g, "_"), idx);
      }
      for (const r of data?.query?.redirects ?? []) {
        const idx = chain.get(r.from.toLowerCase().replace(/\s+/g, "_"));
        if (idx !== undefined) chain.set(r.to.toLowerCase().replace(/\s+/g, "_"), idx);
      }

      for (const page of Object.values(data?.query?.pages ?? {})) {
        if (!page.thumbnail?.source || page.missing !== undefined) continue;
        const titleKey = (page.title ?? "").toLowerCase().replace(/\s+/g, "_");

        // 1) Exact chain match (most reliable)
        const directIdx = chain.get(titleKey);
        if (directIdx !== undefined && directIdx < batch.length) {
          out[coverNorm(batch[directIdx].name)] = page.thumbnail.source;
          continue;
        }

        // 2) Fuzzy: strip disambiguation like "(2018 video game)" and compare
        const baseTitle = coverNorm((page.title ?? "").replace(/\s*\([^)]*\)\s*$/g, ""));
        for (const g of batch) {
          const gn = coverNorm(g.name);
          if (baseTitle && gn && (baseTitle === gn || baseTitle.includes(gn) || gn.includes(baseTitle))) {
            if (!out[gn]) out[gn] = page.thumbnail.source;
            break;
          }
        }
      }
    } catch {
      /* skip failed batch — network blip or JSON error; move on */
    }

    onProgress?.(Math.min(i + BATCH, todo.length), todo.length);
    await new Promise((r) => setTimeout(r, 350)); // ≈ 3 req/sec
  }

  return out;
}

async function scrapeFromArabicps4(platform: "PS5" | "PS4"): Promise<GameEntry[]> {
  const results: GameEntry[] = [];
  const seen = new Set<string>();

  const addEntries = (entries: GameEntry[]) => {
    for (const e of entries) {
      if (!seen.has(e.pageUrl)) {
        seen.add(e.pageUrl);
        results.push(e);
      }
    }
  };

  async function fetchPage(url: string): Promise<string> {
    for (const useJina of [false, true]) {
      try {
        const html = await httpGet(url, useJina);
        if (html.length > 500) return html;
      } catch { continue; }
    }
    return "";
  }

  if (platform === "PS4") {
    // PS4 direct section: raw HTML card grid across 11 paginated pages
    // index.html = page 1; indexpages2.html … indexpages11.html = pages 2–11
    for (let p = 1; p <= 11; p++) {
      const url =
        p === 1
          ? "https://arabicps4games.com/0/ps4/index.html"
          : `https://arabicps4games.com/0/ps4/indexpages${p}.html`;
      const html = await fetchPage(url);
      if (!html) break;
      const entries = parseArabicCardHtml(html, "PS4");
      if (entries.length === 0) break;
      addEntries(entries);
      await new Promise((r) => setTimeout(r, 350));
    }
  } else {
    // PS5 direct: single page, JS-unescape obfuscation, plain anchor list
    // Each entry: <a href="https://justpaste.it/SLUG" rel="nofollow">Game Title</a>
    // No covers on this section — StoreCover falls back to covers.json.
    const ps5Raw = await fetchPage("https://arabicps4games.com/0/ps5/index.html");
    const ps5Html = ps5Raw.length > 500 ? decodeJsUnescape(ps5Raw) || ps5Raw : "";
    if (ps5Html) {
      for (const m of ps5Html.matchAll(
        /<a\s[^>]*href="(https?:\/\/justpaste\.it\/[^"]+)"[^>]*rel="nofollow"[^>]*>([^<]+)<\/a>/gi,
      )) {
        const pageUrl = m[1].trim();
        const name = decodeEntities(m[2]).trim();
        if (!name || !pageUrl || seen.has(pageUrl)) continue;
        seen.add(pageUrl);
        results.push({ name, platform: "PS5", coverUrl: "", pageUrl, source: "arabicps4" });
      }
    }

    // PS5 torrent: raw HTML card grid with cover art — same card format as PS4 direct
    const ps5TorHtml = await fetchPage(
      "https://arabicps4games.com/0/ps5torrent/0/0/index.html",
    );
    if (ps5TorHtml) addEntries(parseArabicCardHtml(ps5TorHtml, "PS5"));
  }

  return results;
}
