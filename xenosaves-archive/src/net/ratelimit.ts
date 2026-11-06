/**
 * Per-host politeness: a concurrency cap plus a minimum interval between request starts.
 * Hosts not listed fall back to the default (conservative) profile.
 */
export interface HostProfile {
  concurrency: number;
  minIntervalMs: number;
}

export const DEFAULT_HOST_PROFILES: Record<string, HostProfile> = {
  default: { concurrency: 1, minIntervalMs: 2000 },
  'raw.githubusercontent.com': { concurrency: 4, minIntervalMs: 250 },
  'github.com': { concurrency: 2, minIntervalMs: 1000 },
  'objects.githubusercontent.com': { concurrency: 4, minIntervalMs: 250 },
  'api.github.com': { concurrency: 1, minIntervalMs: 1000 },
  'www.mediafire.com': { concurrency: 1, minIntervalMs: 5000 },
  'download.mediafire.com': { concurrency: 1, minIntervalMs: 5000 },
  'drive.google.com': { concurrency: 1, minIntervalMs: 3000 },
  'drive.usercontent.google.com': { concurrency: 1, minIntervalMs: 3000 },
  'www.googleapis.com': { concurrency: 2, minIntervalMs: 1000 },
  'www.dropbox.com': { concurrency: 1, minIntervalMs: 3000 },
  'api.onedrive.com': { concurrency: 1, minIntervalMs: 3000 },
  'mega.nz': { concurrency: 1, minIntervalMs: 5000 },
  'archive.org': { concurrency: 2, minIntervalMs: 1000 },
};

export class HostLimiter {
  private active = new Map<string, number>();
  private lastStart = new Map<string, number>();
  private waiters = new Map<string, Array<() => void>>();
  constructor(private profiles: Record<string, HostProfile> = DEFAULT_HOST_PROFILES) {}

  profile(host: string): HostProfile {
    return this.profiles[host] ?? this.profiles.default ?? { concurrency: 1, minIntervalMs: 1000 };
  }

  async acquire(host: string): Promise<() => void> {
    const p = this.profile(host);
    for (;;) {
      const active = this.active.get(host) ?? 0;
      if (active < p.concurrency) {
        this.active.set(host, active + 1);
        break;
      }
      await new Promise<void>((resolve) => {
        const q = this.waiters.get(host) ?? [];
        q.push(resolve);
        this.waiters.set(host, q);
      });
    }
    // spacing between request starts — reserve our slot before sleeping so concurrent callers queue up
    const now = Date.now();
    const slot = Math.max(now, (this.lastStart.get(host) ?? 0) + p.minIntervalMs);
    this.lastStart.set(host, slot);
    if (slot > now) await new Promise((r) => setTimeout(r, slot - now));
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active.set(host, (this.active.get(host) ?? 1) - 1);
      const q = this.waiters.get(host);
      const next = q?.shift();
      if (next) next();
    };
  }
}

/** Simple counting semaphore for global worker concurrency. */
export class Semaphore {
  private waiting: Array<() => void> = [];
  private max: number;
  constructor(private permits: number) {
    this.max = permits;
  }
  setPermits(n: number) {
    this.permits += n - this.max;
    this.max = n;
    while (this.permits > 0 && this.waiting.length) {
      this.permits--;
      this.waiting.shift()!();
    }
  }
  get available() {
    return this.permits;
  }
  async acquire(): Promise<() => void> {
    if (this.permits > 0) {
      this.permits--;
    } else {
      await new Promise<void>((r) => this.waiting.push(r));
    }
    let done = false;
    return () => {
      if (done) return;
      done = true;
      const next = this.waiting.shift();
      if (next) next();
      else this.permits++;
    };
  }
}

/** Exponential backoff with jitter; honours a server-provided Retry-After when larger. */
export function backoffMs(attempt: number, opts: { baseMs?: number; maxMs?: number; retryAfterMs?: number; rand?: () => number } = {}): number {
  const base = opts.baseMs ?? 30_000;
  const max = opts.maxMs ?? 6 * 3600_000;
  const raw = Math.min(max, base * 2 ** Math.max(0, attempt - 1));
  const jitter = 0.8 + (opts.rand ?? Math.random)() * 0.4;
  return Math.max(Math.round(raw * jitter), opts.retryAfterMs ?? 0);
}

export function parseRetryAfter(v: string | null | undefined, now = Date.now()): number | undefined {
  if (!v) return undefined;
  const secs = Number(v);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const t = Date.parse(v);
  return Number.isFinite(t) ? Math.max(0, t - now) : undefined;
}
