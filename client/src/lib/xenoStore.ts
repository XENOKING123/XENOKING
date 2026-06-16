// XENO Game Store — dlpsgame.com catalog scrape + deep download-link resolver.
// All HTTP goes through the Rust `xeno_http_get` command (CSP/CORS-free, host
// allowlisted). Ported from the Python aio_games resolver.
import { invoke } from "@tauri-apps/api/core";

export interface GameEntry {
  name: string;
  platform: "PS5" | "PS4";
  coverUrl: string;
  pageUrl: string;
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

export async function scrapeCatalog(
  platform: "PS5" | "PS4",
  pages: number,
  onProgress?: (msg: string) => void,
  existing?: GameEntry[],
  onBatch?: (all: GameEntry[]) => void,
): Promise<GameEntry[]> {
  // Walk the WHOLE category, merging with what we already have. dlpsgame has
  // 30+ pages per platform; each page already retries via the jina proxy, so we
  // only conclude we hit the real end after FOUR consecutive empty pages (not
  // 2 — that quit early on a single transient block and left ~60 games). A
  // jittered delay keeps the site from rate-limiting. `onBatch` lets the caller
  // persist progress so a long scrape survives interruption.
  const byUrl = new Map<string, GameEntry>();
  for (const g of existing ?? []) byUrl.set(g.pageUrl, g);
  let emptyStreak = 0;
  for (let p = 1; p <= pages; p++) {
    onProgress?.(`Scraping ${platform} page ${p}… (${byUrl.size} games so far)`);
    const rows = await scrapePage(platform, p);
    if (rows.length === 0) {
      emptyStreak += 1;
      if (emptyStreak >= 4) break;
    } else {
      emptyStreak = 0;
      const before = byUrl.size;
      for (const g of rows) byUrl.set(g.pageUrl, g);
      if (byUrl.size !== before) onBatch?.([...byUrl.values()]);
    }
    await new Promise((r) => setTimeout(r, 500 + Math.floor(Math.random() * 500)));
  }
  return [...byUrl.values()].sort((a, b) => a.name.localeCompare(b.name));
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

export async function fetchDownloadLinks(
  pageUrl: string,
  deep = true,
): Promise<DownloadLink[]> {
  let html = "";
  try {
    html = await httpGet(pageUrl, true); // via jina proxy (JS render + CF)
  } catch {
    return [];
  }
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
