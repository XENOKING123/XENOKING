// XENO game covers. Primary source: the bundled covers.json (game name →
// official PlayStation CDN cover URL — the same map the old tool used, ~1,300
// games, works offline/no console). Fallback: CheatRunner's /appdb/icon for
// installed games. Final fallback handled by the caller (letter tile).
import { useEffect, useRef, useState } from "react";
import { gameIcon } from "./cheatRunner";

let cache: Record<string, string> | null = null;
let loading: Promise<Record<string, string>> | null = null;

function norm(s: string): string {
  return (s || "")
    .toLowerCase()
    .replace(/[™®©]/g, "")
    .replace(/[:\-–—_]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function loadCovers(): Promise<Record<string, string>> {
  if (cache) return cache;
  if (!loading) {
    loading = fetch("/covers.json")
      .then((r) => r.json())
      .then((d) => {
        const out: Record<string, string> = {};
        const titles = (d && d.titles) || {};
        for (const k of Object.keys(titles)) {
          const v = titles[k];
          if (typeof v === "string" && v.startsWith("http")) out[norm(k)] = v;
        }
        cache = out;
        return out;
      })
      .catch(() => ({}) as Record<string, string>);
  }
  return loading;
}

/** Cover URL for a game by name (from covers.json), or null. */
export async function coverByName(game: string): Promise<string | null> {
  if (!game) return null;
  const map = await loadCovers();
  return map[norm(game)] || null;
}

/**
 * Resolve a game cover: covers.json by name first (offline, broad), then
 * CheatRunner's app DB by title id when connected. Returns null → caller shows
 * a letter tile.
 */
export function useGameCover(host: string, titleId: string, gameName: string): string | null {
  const [cover, setCover] = useState<string | null>(null);
  const tried = useRef("");
  useEffect(() => {
    const key = `${titleId}|${gameName}`;
    if (tried.current === key) return;
    tried.current = key;
    let cancelled = false;
    void (async () => {
      const byName = await coverByName(gameName);
      if (cancelled) return;
      if (byName) {
        setCover(byName);
        return;
      }
      if (host?.trim() && titleId) {
        const icon = await gameIcon(host, titleId);
        if (!cancelled && icon) setCover(icon);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [host, titleId, gameName]);
  return cover;
}
