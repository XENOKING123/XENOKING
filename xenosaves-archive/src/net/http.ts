import { Agent, EnvHttpProxyAgent, fetch as ufetch, type Dispatcher, type Response } from 'undici';
import { assertPublicDns, assertSafeUrl, guardedLookup, UnsafeUrlError } from './ssrf.js';
import { HostLimiter, parseRetryAfter } from './ratelimit.js';

export type FailureKind =
  | 'dead-link'      // 404/410 — gone; permanent
  | 'restricted'     // 401/403/451, login/captcha/quota/password interstitials — never bypassed
  | 'transient'      // 429/5xx/network — retry with backoff
  | 'too-large'      // exceeds configured limits — permanent
  | 'invalid'        // malformed response / unsafe destination — permanent
  | 'unsafe';

export class FetchFailure extends Error {
  constructor(
    public kind: FailureKind,
    message: string,
    public status?: number,
    public retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'FetchFailure';
  }
}

export function classifyStatus(status: number): FailureKind | null {
  if (status >= 200 && status < 300) return null;
  if (status === 404 || status === 410) return 'dead-link';
  if (status === 401 || status === 403 || status === 451 || status === 402) return 'restricted';
  if (status === 408 || status === 425 || status === 429 || status >= 500) return 'transient';
  return 'invalid';
}

export interface HttpOptions {
  userAgent: string;
  timeoutMs: number;
  maxRedirects: number;
  allowPrivateNetwork: boolean;
  limiter?: HostLimiter;
}

export interface RequestInit2 {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
  /** Skip the per-host limiter (used when the caller already holds a slot). */
  noLimit?: boolean;
}

export class HttpClient {
  readonly dispatcher: Dispatcher;
  readonly limiter: HostLimiter;
  readonly viaProxy: boolean;
  constructor(public opts: HttpOptions) {
    this.limiter = opts.limiter ?? new HostLimiter();
    this.viaProxy = Boolean(process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY);
    this.dispatcher = this.viaProxy
      ? new EnvHttpProxyAgent()
      : new Agent({ connect: { lookup: guardedLookup(opts.allowPrivateNetwork) as any }, connections: 64 });
  }

  /**
   * Fetch with SSRF validation on every hop, manual redirect following, per-host politeness and a timeout.
   * Returns the final response (body unconsumed) and the final URL.
   */
  async request(url: string, init: RequestInit2 = {}): Promise<{ res: Response; finalUrl: string; release: () => void }> {
    let current = url;
    for (let hop = 0; hop <= this.opts.maxRedirects; hop++) {
      const u = assertSafeUrl(current, { allowPrivate: this.opts.allowPrivateNetwork });
      await assertPublicDns(u.hostname, { allowPrivate: this.opts.allowPrivateNetwork });
      const release = init.noLimit ? () => {} : await this.limiter.acquire(u.host);
      const timeout = AbortSignal.timeout(this.opts.timeoutMs);
      const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
      let res: Response;
      try {
        res = await ufetch(u, {
          method: init.method ?? 'GET',
          headers: { 'user-agent': this.opts.userAgent, accept: '*/*', ...(init.headers ?? {}) },
          body: init.body,
          redirect: 'manual',
          signal,
          dispatcher: this.dispatcher,
        });
      } catch (err) {
        release();
        if (err instanceof UnsafeUrlError || (err as any)?.cause instanceof UnsafeUrlError) {
          throw new FetchFailure('unsafe', (err as Error).message);
        }
        throw new FetchFailure('transient', `network error for ${u.host}: ${(err as any)?.cause?.message ?? (err as Error).message}`);
      }
      if ([301, 302, 303, 307, 308].includes(res.status)) {
        const loc = res.headers.get('location');
        await res.body?.cancel().catch(() => {});
        release();
        if (!loc) throw new FetchFailure('invalid', `redirect without location from ${u.host}`);
        current = new URL(loc, u).toString();
        if (res.status === 303) init = { ...init, method: 'GET', body: undefined };
        continue;
      }
      return { res, finalUrl: u.toString(), release };
    }
    throw new FetchFailure('invalid', `too many redirects for ${url}`);
  }

  /** Convenience: GET text with size cap; throws FetchFailure on non-2xx. */
  async getText(url: string, opts: { maxBytes?: number; headers?: Record<string, string> } = {}): Promise<{ text: string; finalUrl: string; contentType: string }> {
    const { res, finalUrl, release } = await this.request(url, { headers: opts.headers });
    try {
      const kind = classifyStatus(res.status);
      if (kind) {
        await res.body?.cancel().catch(() => {});
        throw new FetchFailure(kind, `HTTP ${res.status} for ${url}`, res.status, parseRetryAfter(res.headers.get('retry-after')));
      }
      const max = opts.maxBytes ?? 10 * 1024 * 1024;
      const chunks: Buffer[] = [];
      let total = 0;
      for await (const chunk of res.body as any as AsyncIterable<Uint8Array>) {
        total += chunk.byteLength;
        if (total > max) throw new FetchFailure('too-large', `response from ${url} exceeds ${max} bytes`);
        chunks.push(Buffer.from(chunk));
      }
      return { text: Buffer.concat(chunks).toString('utf8'), finalUrl, contentType: res.headers.get('content-type') ?? '' };
    } finally {
      release();
    }
  }

  async getJson<T = unknown>(url: string, headers?: Record<string, string>): Promise<T> {
    const { text } = await this.getText(url, { headers: { accept: 'application/json', ...(headers ?? {}) } });
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new FetchFailure('invalid', `invalid JSON from ${url}`);
    }
  }
}
