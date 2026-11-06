import { describe, expect, it } from 'vitest';
import { classifyStatus } from '../../src/net/http.js';
import { filenameFromContentDisposition } from '../../src/net/download.js';
import { backoffMs, HostLimiter, parseRetryAfter, Semaphore } from '../../src/net/ratelimit.js';
import { parseRobots, robotsAllows } from '../../src/net/robots.js';

describe('failure classification', () => {
  it.each([
    [200, null], [206, null], [404, 'dead-link'], [410, 'dead-link'], [401, 'restricted'], [403, 'restricted'], [402, 'restricted'],
    [451, 'restricted'], [429, 'transient'], [500, 'transient'], [503, 'transient'], [408, 'transient'], [400, 'invalid'],
  ])('%i → %s', (s, k) => expect(classifyStatus(s)).toBe(k));
});

describe('backoff', () => {
  it('grows exponentially with jitter and caps', () => {
    const r = () => 0.5;
    expect(backoffMs(1, { baseMs: 1000, rand: r })).toBe(1000);
    expect(backoffMs(3, { baseMs: 1000, rand: r })).toBe(4000);
    expect(backoffMs(30, { baseMs: 1000, maxMs: 60_000, rand: r })).toBe(60_000);
  });
  it('honours Retry-After when longer', () => {
    expect(backoffMs(1, { baseMs: 1000, retryAfterMs: 90_000, rand: () => 0.5 })).toBe(90_000);
    expect(parseRetryAfter('120')).toBe(120_000);
    expect(parseRetryAfter(new Date(Date.now() + 60_000).toUTCString())).toBeGreaterThan(50_000);
    expect(parseRetryAfter(null)).toBeUndefined();
  });
});

describe('HostLimiter', () => {
  it('caps concurrency per host and spaces request starts', async () => {
    const lim = new HostLimiter({ default: { concurrency: 2, minIntervalMs: 50 } });
    let active = 0;
    let peak = 0;
    const starts: number[] = [];
    await Promise.all(
      Array.from({ length: 6 }, async () => {
        const release = await lim.acquire('h');
        starts.push(Date.now());
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 20));
        active--;
        release();
      }),
    );
    expect(peak).toBeLessThanOrEqual(2);
    starts.sort((a, b) => a - b);
    for (let i = 1; i < starts.length; i++) expect(starts[i] - starts[i - 1]).toBeGreaterThanOrEqual(45);
  });
});

describe('Semaphore', () => {
  it('limits concurrency and can be resized', async () => {
    const s = new Semaphore(1);
    const r1 = await s.acquire();
    let got = false;
    const p = s.acquire().then((r) => {
      got = true;
      return r;
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(got).toBe(false);
    r1();
    (await p)();
    s.setPermits(3);
    expect(s.available).toBe(3);
  });
});

describe('robots.txt', () => {
  const groups = parseRobots(`User-agent: *\nDisallow: /downloads/\nAllow: /downloads/public/\nCrawl-delay: 5\n\nUser-agent: XenoSavesArchiveBot\nDisallow: /private\n`);
  it('uses the most specific group and longest match', () => {
    expect(robotsAllows(groups, 'XenoSavesArchiveBot/0.1', '/private/x').allowed).toBe(false);
    expect(robotsAllows(groups, 'XenoSavesArchiveBot/0.1', '/downloads/x').allowed).toBe(true);
    expect(robotsAllows(groups, 'OtherBot', '/downloads/x').allowed).toBe(false);
    expect(robotsAllows(groups, 'OtherBot', '/downloads/public/x').allowed).toBe(true);
    expect(robotsAllows(groups, 'OtherBot', '/x').crawlDelaySec).toBe(5);
  });
  it('supports * and $ patterns', () => {
    const g = parseRobots('User-agent: *\nDisallow: /*.zip$\n');
    expect(robotsAllows(g, 'a', '/a/b.zip').allowed).toBe(false);
    expect(robotsAllows(g, 'a', '/a/b.zip?x=1').allowed).toBe(true);
  });
});

describe('content-disposition', () => {
  it('parses plain and RFC 5987 filenames', () => {
    expect(filenameFromContentDisposition('attachment; filename="save file.zip"')).toBe('save file.zip');
    expect(filenameFromContentDisposition("attachment; filename*=UTF-8''%E3%82%BB%E3%83%BC%E3%83%96.zip")).toBe('セーブ.zip');
    expect(filenameFromContentDisposition(null)).toBeUndefined();
  });
});
