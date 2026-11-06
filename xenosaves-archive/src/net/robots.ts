import { FetchFailure, type HttpClient } from './http.js';

/**
 * Minimal robots.txt support for page crawling done by discovery connectors.
 * Rules: longest-match wins between Allow/Disallow for the most specific matching user-agent group.
 */
interface Group {
  agents: string[];
  rules: Array<{ allow: boolean; path: string }>;
  crawlDelaySec?: number;
}

export function parseRobots(text: string): Group[] {
  const groups: Group[] = [];
  let cur: Group | null = null;
  let lastWasAgent = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*/, '').trim();
    if (!line) continue;
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (field === 'user-agent') {
      if (!cur || !lastWasAgent) {
        cur = { agents: [], rules: [] };
        groups.push(cur);
      }
      cur.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!cur) continue;
    if (field === 'allow' || field === 'disallow') {
      if (field === 'disallow' && value === '') continue;
      cur.rules.push({ allow: field === 'allow', path: value });
    } else if (field === 'crawl-delay') {
      const n = Number(value);
      if (Number.isFinite(n)) cur.crawlDelaySec = n;
    }
  }
  return groups;
}

function pathMatches(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith('$');
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const re = new RegExp('^' + body.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + (anchored ? '$' : ''));
  return re.test(path);
}

export function robotsAllows(groups: Group[], userAgentToken: string, pathAndQuery: string): { allowed: boolean; crawlDelaySec?: number } {
  const ua = userAgentToken.toLowerCase();
  let group = groups.find((g) => g.agents.some((a) => a !== '*' && ua.includes(a)));
  if (!group) group = groups.find((g) => g.agents.includes('*'));
  if (!group) return { allowed: true };
  let best: { allow: boolean; len: number } | null = null;
  for (const r of group.rules) {
    if (pathMatches(r.path, pathAndQuery)) {
      const len = r.path.length;
      if (!best || len > best.len || (len === best.len && r.allow)) best = { allow: r.allow, len };
    }
  }
  return { allowed: best ? best.allow : true, crawlDelaySec: group.crawlDelaySec };
}

export class RobotsCache {
  private cache = new Map<string, { at: number; groups: Group[] | 'all-allowed' | 'all-denied' }>();
  constructor(private http: HttpClient, private uaToken = 'XenoSavesArchiveBot') {}

  async check(url: string): Promise<{ allowed: boolean; crawlDelaySec?: number }> {
    const u = new URL(url);
    const key = u.origin;
    let entry = this.cache.get(key);
    if (!entry || Date.now() - entry.at > 24 * 3600_000) {
      let groups: Group[] | 'all-allowed' | 'all-denied';
      try {
        const { text } = await this.http.getText(`${u.origin}/robots.txt`, { maxBytes: 512 * 1024 });
        groups = parseRobots(text);
      } catch (err) {
        // RFC 9309: 4xx => no restrictions; 5xx/unreachable => assume complete disallow.
        groups = err instanceof FetchFailure && (err.kind === 'dead-link' || err.kind === 'restricted' || err.kind === 'invalid') ? 'all-allowed' : 'all-denied';
      }
      entry = { at: Date.now(), groups };
      this.cache.set(key, entry);
    }
    if (entry.groups === 'all-allowed') return { allowed: true };
    if (entry.groups === 'all-denied') return { allowed: false };
    return robotsAllows(entry.groups, this.uaToken, u.pathname + u.search);
  }
}
