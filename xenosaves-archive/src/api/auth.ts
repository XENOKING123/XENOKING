import crypto from 'node:crypto';
import type { Db } from '../db/pool.js';

export function sha256Hex(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex');
}

export function newApiKey(): string {
  return `xsa_${crypto.randomBytes(24).toString('base64url')}`;
}

export function extractKey(headers: Record<string, unknown>): string | null {
  const x = headers['x-api-key'];
  if (typeof x === 'string' && x) return x;
  const auth = headers['authorization'];
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) return auth.slice(7).trim();
  return null;
}

export async function lookupApiKey(db: Db, key: string | null): Promise<{ id: number; name: string; scopes: string[] } | null> {
  if (!key || !key.startsWith('xsa_') || key.length > 200) return null;
  const r = await db.query('select id, name, scopes from api_keys where key_hash = $1 and revoked_at is null', [sha256Hex(key)]);
  return r.rows[0] ?? null;
}

/** Constant-time admin token check. */
export function adminTokenOk(expected: string | undefined, presented: string | null): boolean {
  if (!expected || !presented) return false;
  const a = crypto.createHash('sha256').update(expected).digest();
  const b = crypto.createHash('sha256').update(presented).digest();
  return crypto.timingSafeEqual(a, b);
}

/** In-memory token bucket keyed by client (IP or API key). Per-process; put a CDN/WAF in front for global limits. */
export class RateLimiter {
  private buckets = new Map<string, { tokens: number; at: number }>();
  constructor(private capacity: number, private refillPerSec: number) {}
  take(key: string, cost = 1): boolean {
    const now = Date.now();
    const b = this.buckets.get(key) ?? { tokens: this.capacity, at: now };
    b.tokens = Math.min(this.capacity, b.tokens + ((now - b.at) / 1000) * this.refillPerSec);
    b.at = now;
    if (this.buckets.size > 100_000) this.buckets.clear();
    if (b.tokens < cost) {
      this.buckets.set(key, b);
      return false;
    }
    b.tokens -= cost;
    this.buckets.set(key, b);
    return true;
  }
}
