#!/usr/bin/env node
/*
 * XENO STORE — web/dev-server.mjs (Node 18+, no dependencies)
 *
 * Serves web/dist/index.html plus a MOCK of the whole HTTP API (SPEC §6) with
 * realistic fake state, so the UI can be developed and tested without a console:
 *   - catalog: catalog/xeno-catalog.json when it exists, otherwise the BlackBox
 *     snapshot (+ the dlpsgame snapshot) converted to the §10 schema on the fly
 *   - simulated downloads that progress over time (segments, speed history,
 *     verify, PKG auto-install, retry countdown), pause/resume/cancel/restart…
 *   - storage roots with live free space, settings persistence in memory,
 *     favorites/collections/recent, library scan, status, update check, pairing
 *
 * Usage: node web/dev-server.mjs [--port 9095] [--host 127.0.0.1]
 *          [--art local|remote|none]   cover art: generated SVGs (works offline),
 *                                      the catalog's CDN URLs, or broken URLs
 *          [--speed 1.5]               download speed multiplier
 *          [--update]                  pretend a newer payload is available
 *          [--no-downloads]            simulate a firmware without sceHttp (downloadsAvailable:false)
 *          [--acknowledged]            skip the first-run wizard (sources.acknowledged = true)
 *          [--catalog PATH] [--dist PATH]
 */
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { createHash, randomBytes } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '..');
const args = process.argv.slice(2);
const argValue = (name, dflt) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : dflt; };
const PORT = Number(argValue('--port', 9095));
const HOST = argValue('--host', '127.0.0.1');
const ART = argValue('--art', 'local');
const SPEED_MULT = Number(argValue('--speed', 1)) || 1;
const UPDATE_AVAILABLE = args.includes('--update');
const DOWNLOADS_AVAILABLE = !args.includes('--no-downloads');
const DIST = resolve(argValue('--dist', join(here, 'dist', 'index.html')));
const VERSION = (() => { try { return readFileSync(join(ROOT, 'VERSION'), 'utf8').trim(); } catch (e) { return '1.0.0'; } })();
const MiB = 1024 * 1024, GB = 1e9;
const now = () => Math.floor(Date.now() / 1000);

/* ============================================================ log ============================================================ */
const logLines = [];
function log(level, msg) {
  const t = new Date();
  const line = `[${t.toISOString().slice(11, 19)}] ${level.padEnd(5)} ${msg}`;
  logLines.push(line);
  if (logLines.length > 400) logLines.shift();
  if (level !== 'debug') console.log(line);
}

/* ============================================================ catalog ============================================================ */
const hash32 = (s) => { let x = 2166136261; for (let i = 0; i < s.length; i++) { x ^= s.charCodeAt(i); x = Math.imul(x, 16777619) >>> 0; } return x; };
const normTitle = (t) => String(t || '').toLowerCase().replace(/[™®©]/g, '').replace(/\b(deluxe|ultimate|gold|complete|standard|definitive|digital|goty|game of the year|edition|remastered|bundle)\b/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
const slugify = (t) => normTitle(t).replace(/\s+/g, '-').replace(/^-+|-+$/g, '') || 'game';
const platformOf = (r) => (r.platform && /ps4/i.test(r.platform)) || /^CUSA/i.test(r.titleId || '') ? 'PS4' : 'PS5';
const REGION_MAP = { EU: 'EUR', EUR: 'EUR', US: 'USA', USA: 'USA', JP: 'JPN', JPN: 'JPN', ASIA: 'ASIA', AS: 'ASIA' };
const regionOf = (r) => { if (r.region) return REGION_MAP[String(r.region).toUpperCase()] || String(r.region).toUpperCase().slice(0, 4); const m = /\b(EUR|USA|JPN|ASIA)\b|\[(EU|US|JP)\]/i.exec(r.filename || ''); return m ? REGION_MAP[(m[1] || m[2]).toUpperCase()] || '' : ''; };
const compatOf = (name) => { const m = /\b(\d{1,2}\.(?:xx|\d\d))\b/i.exec(name || ''); return m ? m[1] : ''; };
const kindOf = (r) => /\b(update|patch)\b/i.test(r.filename || '') ? 'update' : /\bdlc\b/i.test(r.filename || '') ? 'dlc' : 'game';

function convertSnapshots() {
  const bbPath = join(ROOT, 'catalog', 'snapshots', 'blackbox', 'catalog.json');
  const dlPath = join(ROOT, 'catalog', 'snapshots', 'xeno-dlpsgame', 'catalog.json');
  const srcPath = join(ROOT, 'catalog', 'sources.json');
  const revPath = join(ROOT, 'catalog', 'snapshots', 'blackbox', 'revision.json');
  const bb = existsSync(bbPath) ? JSON.parse(readFileSync(bbPath, 'utf8')) : [];
  const dl = existsSync(dlPath) ? JSON.parse(readFileSync(dlPath, 'utf8')) : [];
  const sources = existsSync(srcPath) ? JSON.parse(readFileSync(srcPath, 'utf8')).sources : [];
  const revision = existsSync(revPath) ? (JSON.parse(readFileSync(revPath, 'utf8')).revision || 1) : 1;
  const games = new Map();
  const byKey = new Map();   // normalized title|platform → game (for merging the page sources)
  const srcById = {}; sources.forEach((s) => { srcById[s.id] = s; });

  for (const r of bb) {
    const platform = platformOf(r);
    const slug = (r.gameId || slugify(r.title)).replace(/-ps[45]$/i, '');
    const id = `${slug}-${platform.toLowerCase()}`;
    let g = games.get(id);
    if (!g) {
      g = { id, slug, title: r.title, platform, titleIds: [], region: regionOf(r), genres: r.genre ? [r.genre] : [], tagline: r.tagline || '', description: r.description || '',
        publisher: r.publisher || '', developer: '', releaseDate: r.releaseDate || '', addedAt: (r.addedAt || '').slice(0, 10), cover: r.cover || '', coverFallback: r.coverFallback || '',
        hero: r.hero || '', heroFallback: r.heroFallback || '', artworkLayout: r.artworkLayout || 'wide', tint: '#' + ((hash32(r.title) & 0x3f3f7f) | 0x101040).toString(16).padStart(6, '0'),
        sizeMin: 0, sizeMax: 0, featured: 0, popularity: 0, verified: false, compat: [], releases: [] };
      games.set(id, g); byKey.set(normTitle(r.title) + '|' + platform, g);
    }
    if (r.titleId && g.titleIds.indexOf(r.titleId) < 0) g.titleIds.push(r.titleId);
    if (!g.cover && r.cover) g.cover = r.cover;
    if (!g.hero && r.hero) g.hero = r.hero;
    const sourceId = srcById[r.sourceId] ? r.sourceId : (r.browserUrl ? 'vikingfile' : 'archive');
    const rel = { id: r.id, titleId: r.titleId || '', region: regionOf(r), version: r.version || '', format: r.format || 'FFPFSC', kind: kindOf(r), provider: r.provider || (srcById[sourceId] || {}).name || sourceId,
      sourceId, filename: r.filename || '', url: r.url || '', browserUrl: r.browserUrl || '', mirrors: [], sizeBytes: Number(r.sizeBytes) || 0, sha256: r.sha256 || '', md5: '', sha1: '',
      verifiedAt: (r.sourceCheckedAt || '').slice(0, 10), consoleVerified: !!r.consoleVerified, compat: compatOf(r.filename), password: '', notes: '', addedAt: (r.addedAt || '').slice(0, 10) };
    if (!g.releases.some((x) => x.url === rel.url)) g.releases.push(rel);
    const c = compatOf(r.filename); if (c && g.compat.indexOf(c) < 0) g.compat.push(c);
    if (rel.verifiedAt && sourceId === 'archive') g.verified = true;
    /* BlackBox carries no hashes; the real pipeline reads md5/sha1/sha256 from archive.org metadata. The mock
       gives verified archive releases a deterministic stand-in so the hash-dependent UI paths can be exercised. */
    if (sourceId === 'archive' && r.sourceCheckedAt) rel.sha256 = createHash('sha256').update('xeno-mock:' + rel.url).digest('hex');
    if (r.homeOrder > 0) g.featured = g.featured ? Math.min(g.featured, r.homeOrder) : r.homeOrder;
    g.popularity += (r.pickOrder ? 10 / r.pickOrder : 0) + (r.homeOrder ? 20 / r.homeOrder : 0) + 1;
  }
  /* dlpsgame snapshot: PAGE releases merged into the same game when the title matches */
  for (const p of dl) {
    const platform = /ps4/i.test(p.platform || '') ? 'PS4' : 'PS5';
    const key = normTitle(p.name) + '|' + platform;
    let g = byKey.get(key);
    if (!g) {
      const slug = slugify(p.name); const id = `${slug}-${platform.toLowerCase()}`;
      if (games.has(id)) g = games.get(id);
      else {
        g = { id, slug, title: p.name, platform, titleIds: [], region: '', genres: [], tagline: '', description: '', publisher: '', developer: '', releaseDate: '', addedAt: '2026-10-01',
          cover: p.cover_url || '', coverFallback: '', hero: '', heroFallback: '', artworkLayout: 'tall', tint: '#1a2a5a', sizeMin: 0, sizeMax: 0, featured: 0, popularity: 0.5, verified: false, compat: [], releases: [] };
        games.set(id, g); byKey.set(key, g);
      }
    }
    if (p.page_url && !g.releases.some((x) => x.url === p.page_url)) {
      g.releases.push({ id: 'dlpsgame-' + hash32(p.page_url).toString(36), titleId: g.titleIds[0] || '', region: '', version: '', format: 'PAGE', kind: 'page', provider: 'DLPSGAME', sourceId: 'dlpsgame',
        filename: '', url: p.page_url, browserUrl: p.page_url, mirrors: [], sizeBytes: 0, sha256: '', md5: '', sha1: '', verifiedAt: '', consoleVerified: false, compat: '', password: 'DLPSGAME.COM', notes: '', addedAt: '2026-10-01' });
    }
  }
  const genreSet = new Set();
  const list = [...games.values()];
  for (const g of list) {
    const sizes = g.releases.map((r) => r.sizeBytes).filter((n) => n > 0);
    g.sizeMin = sizes.length ? Math.min(...sizes) : 0; g.sizeMax = sizes.length ? Math.max(...sizes) : 0;
    g.genres.forEach((x) => genreSet.add(x));
    g.popularity = Math.round(g.popularity * 100) / 100;
    /* a couple of mirrors for verified direct releases so the speed test / failover UI has something to show */
    g.releases.forEach((r) => { if (r.sourceId === 'archive' && r.url) r.mirrors = [r.url.replace('https://archive.org/download/', 'https://ia800.us.archive.org/0/items/')]; });
  }
  list.sort((a, b) => (a.title < b.title ? -1 : a.title > b.title ? 1 : 0));
  return { schemaVersion: 1, revision, generatedAt: new Date().toISOString(), name: 'XENO STORE Catalog (dev mock)', sources, genres: [...genreSet].sort(), games: list };
}

const catalogPath = resolve(argValue('--catalog', join(ROOT, 'catalog', 'xeno-catalog.json')));
let catalog;
if (existsSync(catalogPath)) { catalog = JSON.parse(readFileSync(catalogPath, 'utf8')); log('info', `catalog: ${catalogPath} (revision ${catalog.revision}, ${catalog.games.length} games)`); }
else { catalog = convertSnapshots(); log('info', `catalog: converted from snapshots (${catalog.games.length} games, ${catalog.games.reduce((n, g) => n + g.releases.length, 0)} releases)`); }
if (ART !== 'remote') {
  for (const g of catalog.games) {
    const base = ART === 'local' ? `/mockart/${encodeURIComponent(g.id)}` : `https://art.invalid/${encodeURIComponent(g.id)}`;
    g.cover = base + '/cover.svg'; g.hero = base + '/hero.svg'; g.coverFallback = ''; g.heroFallback = '';
  }
}
const gamesById = new Map(catalog.games.map((g) => [g.id, g]));
const releaseIndex = new Map();
for (const g of catalog.games) for (const r of g.releases) releaseIndex.set(r.id, { g, r });
const catalogJson = JSON.stringify(catalog);
const catalogEtag = `"r${catalog.revision}-${createHash('sha256').update(catalogJson).digest('hex').slice(0, 10)}"`;
const catalogGz = gzipSync(catalogJson);

/* ============================================================ state ============================================================ */
const startedAt = now();
const settings = {
  v: 1,
  general: { language: 'auto', theme: 'xeno-gold', cardSize: 'm', reduceMotion: false, sounds: true, hints: true, showPs4: true, adultFilter: false },
  downloads: { defaultRoot: '/data', connections: 8, concurrentJobs: 1, maxBytesPerSec: 0, verifyHashes: true, autoInstallPkg: true, shadowMountScan: true, keepAwake: true, retryMax: 8, allowInsecureTls: false, scheduleStart: '', scheduleEnd: '' },
  sources: { enabled: { archive: true, vikingfile: true, dlpsgame: true, other: true }, acknowledged: args.includes('--acknowledged') },
  catalog: { autoRefresh: true, url: 'https://raw.githubusercontent.com/XENOKING123/XENOKING/main/xeno-store/catalog/xeno-catalog.json', revisionUrl: 'https://raw.githubusercontent.com/XENOKING123/XENOKING/main/xeno-store/catalog/revision.json', lastCheck: startedAt - 3600 },
  notifications: { toasts: true, onComplete: true, onFail: true, onInstall: true },
  updates: { autoCheck: true, feed: 'https://raw.githubusercontent.com/XENOKING123/XENOKING/main/xeno-store/updates/payloads.json', lastCheck: 0 },
  pairing: { pin: '' }
};
const roots = [
  { path: '/data', label: 'Internal', kind: 'internal', free: 412.6 * GB, total: 825 * GB, writable: true, default: true },
  { path: '/mnt/ext0', label: 'M.2 SSD', kind: 'm2', free: 1483 * GB, total: 2000 * GB, writable: true, default: false },
  { path: '/mnt/usb0', label: 'USB (WD 4TB)', kind: 'usb', free: 912.3 * GB, total: 4000 * GB, writable: true, default: false },
  { path: '/mnt/usb1', label: 'USB (read-only)', kind: 'usb', free: 1.2 * GB, total: 64 * GB, writable: false, default: false }
];
let favorites = [];
let collections = [{ id: 'wishlist', name: 'Wishlist', icon: 'star', ids: [] }];
let recent = [];
const jobs = [];
const jobLogs = new Map();
const extraFiles = [];      // library files not tied to a job (orphans, archives)
let lastScan = null;
let libraryAllow = new Set();

const deepMerge = (dst, src) => { for (const k of Object.keys(src)) { if (src[k] && typeof src[k] === 'object' && !Array.isArray(src[k])) { if (!dst[k] || typeof dst[k] !== 'object') dst[k] = {}; deepMerge(dst[k], src[k]); } else dst[k] = src[k]; } return dst; };
const rootOf = (p) => roots.find((r) => r.path === p) || null;
const defaultRoot = () => roots.find((r) => r.default) || roots[0];
const pathFor = (root, format, filename) => {
  const f = String(format || '').toLowerCase();
  const cat = ['exfat', 'ffpfsc', 'ffpkg', 'ffpfs'].indexOf(f) >= 0 ? 'homebrew' : (f === 'pkg' || f === 'fpkg') ? 'xeno-store/pkg' : 'xeno-store/files';
  return `${root}/${cat}/${filename}`;
};
const jlog = (job, msg) => { const a = jobLogs.get(job.id) || []; a.push(`[${new Date().toISOString().slice(11, 19)}] ${msg}`); if (a.length > 200) a.shift(); jobLogs.set(job.id, a); log('debug', `${job.id} ${msg}`); };
const unfinishedOn = (rootPath) => jobs.filter((j) => j.root === rootPath && ['queued', 'connecting', 'downloading', 'verifying', 'paused', 'failed'].indexOf(j.state) >= 0).reduce((n, j) => n + Math.max(0, (j.total || 0) - (j.written || 0)), 0);

function planSegments(total, connections) {
  if (!total) return [];
  const chunk = Math.max(16 * MiB, Math.ceil(total / connections));
  const segs = [];
  for (let s = 0; s < total; s += chunk) segs.push([s, Math.min(total, s + chunk), s]);
  return segs;
}
function makeJob(g, r, opts) {
  const root = rootOf(opts.root) || defaultRoot();
  const filename = opts.filename || r.filename || `${(g.titleIds || [])[0] || g.slug} ${g.title}.${String(opts.format || r.format).toLowerCase()}`;
  const format = String(opts.format || r.format || 'FFPFSC');
  const total = opts.total !== undefined ? opts.total : (r.sizeBytes || 0);
  const job = {
    id: 'j_' + randomBytes(3).toString('hex'), gameId: g.id, title: g.title, titleId: (g.titleIds || [])[0] || r.titleId || '', platform: g.platform, cover: g.cover || '',
    releaseId: r.id || '', format: format.toUpperCase() === 'EXFAT' ? 'exFAT' : format, provider: r.provider || '', sourceId: r.sourceId || '', url: opts.url || r.url, mirrors: (r.mirrors || []).slice(),
    filename, root: root.path, rootLabel: root.label, path: pathFor(root.path, format, filename),
    state: 'queued', phase: '', message: '', error: '', errorCode: '', total, written: 0, speed: 0, eta: 0,
    connections: Math.max(1, Math.min(16, Number(opts.connections) || settings.downloads.connections)), segments: [],
    sha256: '', sha256Expected: r.sha256 || '', verified: false, verify: opts.verify || (r.sha256 && settings.downloads.verifyHashes ? 'sha256' : 'size'),
    addedAt: now(), startedAt: 0, finishedAt: 0, attempts: 0, nextRetryAt: 0, priority: jobs.filter((j) => j.state === 'queued').length,
    autoInstall: opts.autoInstall !== undefined ? !!opts.autoInstall : settings.downloads.autoInstallPkg, install: { state: 'idle', message: '', contentId: '' },
    resumable: true, etag: '', lastModified: '', speedHistory: []
  };
  job.segments = planSegments(job.total, job.connections);
  jlog(job, `queued → ${job.path} (${job.connections} connections, verify=${job.verify})`);
  return job;
}

/* ---- seed: a believable queue so every Downloads tab has something to show ---- */
function seedQueue() {
  /* popular titles first so the seeded queue looks like a real one, never the same game twice */
  const pool = catalog.games.slice().sort((a, b) => (b.popularity || 0) - (a.popularity || 0));
  const used = new Set();
  const direct = (g) => g.releases.find((r) => r.sourceId === 'archive' && r.sizeBytes > 0);
  const pick = (pred) => { const g = pool.find((x) => !used.has(x) && direct(x) && pred(x)); if (g) used.add(g); return g; };
  const big = pick((g) => g.platform === 'PS5' && g.sizeMax > 60 * GB);
  const mid = pick((g) => g.platform === 'PS5' && g.sizeMax > 20 * GB && g.sizeMax < 60 * GB);
  const small = pick((g) => g.sizeMax > 2 * GB && g.sizeMax < 8 * GB);
  const ps4 = pick((g) => g.platform === 'PS4');
  const other = [pick(() => true), pick(() => true), pick((g) => g.platform === 'PS5'), pick(() => true)];
  if (big) { const j = makeJob(big, direct(big), { root: '/data' }); j.state = 'downloading'; j.startedAt = now() - 1800; j.attempts = 1; j.written = Math.floor(j.total * 0.37);
    let left = j.written; j.segments.forEach((s) => { const take = Math.min(s[1] - s[0], left); s[2] = s[0] + take; left -= take; }); j.speedHistory = Array.from({ length: 60 }, (_, i) => 50e6 + 18e6 * Math.sin(i / 5) + Math.random() * 8e6); j.speed = j.speedHistory[59]; jobs.push(j); }
  if (mid) { const j = makeJob(mid, direct(mid), { root: '/mnt/ext0' }); jobs.push(j); }
  if (small) { const j = makeJob(small, direct(small), { root: '/data' }); j.state = 'paused'; j.written = Math.floor(j.total * 0.62); j.segments.forEach((s) => { s[2] = Math.min(s[1], s[0] + Math.floor((s[1] - s[0]) * 0.62)); }); j.message = 'Stopped when XENO STORE closed'; j.attempts = 1; jobs.push(j); }
  if (other[0]) { const j = makeJob(other[0], direct(other[0]), { root: '/data' }); j.state = 'failed'; j.errorCode = 'provider_page'; j.error = 'provider_page'; j.message = 'Switched to mirror 1 after HTTP 403 on the primary link.'; j.attempts = 3; j.nextRetryAt = now() + 45; j.written = Math.floor(j.total * 0.08); jobs.push(j); jlog(j, 'HTTP 403 on primary → trying mirror 1'); jlog(j, 'mirror 1 answered text/html → provider_page'); }
  if (ps4) { const j = makeJob(ps4, direct(ps4), { root: '/mnt/usb0', format: 'PKG', filename: `${(ps4.titleIds || [])[0] || 'CUSA00000'} ${ps4.title} [PKG].pkg` }); j.state = 'done'; j.written = j.total; j.segments.forEach((s) => { s[2] = s[1]; }); j.finishedAt = now() - 600; j.verified = true; j.autoInstall = false; jobs.push(j); }
  if (other[1]) { const j = makeJob(other[1], direct(other[1]), { root: '/mnt/ext0' }); j.state = 'done'; j.written = j.total; j.segments.forEach((s) => { s[2] = s[1]; }); j.finishedAt = now() - 7200; jobs.push(j); }
  if (other[2]) { const j = makeJob(other[2], direct(other[2]), { root: '/data', format: 'PKG', filename: `${(other[2].titleIds || [])[0] || 'PPSA00000'} ${other[2].title}.pkg` }); j.state = 'installed'; j.written = j.total; j.segments.forEach((s) => { s[2] = s[1]; }); j.finishedAt = now() - 86400; j.install = { state: 'installed', message: 'Installed', contentId: `EP0001-${j.titleId || 'PPSA00000'}_00-XENOSTOREMOCK000` }; jobs.push(j); }
  if (other[3]) { const j = makeJob(other[3], direct(other[3]), { root: '/data' }); j.state = 'cancelled'; j.written = Math.floor(j.total * 0.21); j.message = 'Cancelled by user'; jobs.push(j); }
  /* orphan files on the drives */
  const orphan = catalog.games.filter((g) => (g.titleIds || []).length && g.platform === 'PS5').slice(10, 13);
  orphan.forEach((g, i) => extraFiles.push({ path: `/mnt/usb0/homebrew/${g.titleIds[0]} ${g.title}.exfat`, name: `${g.titleIds[0]} ${g.title}.exfat`, size: g.sizeMax || (30 + i * 11) * GB, mtime: now() - 86400 * (3 + i), format: 'exfat', root: '/mnt/usb0', titleId: g.titleIds[0], gameId: g.id, title: g.title, cover: g.cover, partial: false }));
  extraFiles.push({ path: '/mnt/ext0/xeno-store/files/PS5 Save Pack 2026.zip', name: 'PS5 Save Pack 2026.zip', size: 184 * 1024 * 1024, mtime: now() - 86400 * 20, format: 'zip', root: '/mnt/ext0', partial: false });
}
seedQueue();
const installedTitles = catalog.games.filter((g) => (g.titleIds || []).length).slice(20, 26).map((g) => ({ titleId: g.titleIds[0], gameId: g.id, title: g.title, cover: g.cover, path: `/user/app/${g.titleIds[0]}` }));
jobs.filter((j) => j.state === 'installed').forEach((j) => { if (j.titleId && !installedTitles.some((x) => x.titleId === j.titleId)) installedTitles.unshift({ titleId: j.titleId, gameId: j.gameId, title: j.title, cover: j.cover, path: `/user/app/${j.titleId}` }); });

/* ============================================================ simulation ============================================================ */
let lastTick = Date.now(), lastSample = Date.now();
function tick() {
  const t = Date.now(), dt = (t - lastTick) / 1000; lastTick = t;
  const sample = t - lastSample >= 1000; if (sample) lastSample = t;
  const maxJobs = Math.max(1, Math.min(4, settings.downloads.concurrentJobs || 1));
  const retryMax = settings.downloads.retryMax || 8;
  /* retry timers */
  for (const j of jobs) if (j.state === 'failed' && j.nextRetryAt && now() >= j.nextRetryAt) {
    if (j.attempts >= retryMax) { j.nextRetryAt = 0; continue; }
    j.state = 'queued'; j.nextRetryAt = 0; j.message = `Retry ${j.attempts + 1} of ${retryMax}`; jlog(j, 'retry timer elapsed → queued');
  }
  /* start queued jobs while slots are free */
  const active = () => jobs.filter((j) => ['connecting', 'downloading', 'verifying'].indexOf(j.state) >= 0).length;
  const queued = jobs.filter((j) => j.state === 'queued').sort((a, b) => (a.priority - b.priority) || (a.addedAt - b.addedAt));
  for (const j of queued) {
    if (active() >= maxJobs) break;
    j.state = 'connecting'; j.phase = 'Probing Range support'; j.startedAt = j.startedAt || now(); j.attempts++; j._connectUntil = t + 900 + Math.random() * 900; jlog(j, `connecting (attempt ${j.attempts})`);
  }
  for (const j of jobs) {
    if (j.state === 'connecting' && t >= j._connectUntil) {
      if (/fail|broken/i.test(j.url) && j.attempts < 3) { fail(j, 'provider_page', 'The host returned a web page instead of the file.'); continue; }
      if (/404/.test(j.url)) { fail(j, 'not_found', 'HTTP 404 from the host.'); continue; }
      if (!j.total) j.total = (12 + Math.random() * 30) * GB, j.segments = planSegments(j.total, j.connections);
      if (!j.segments.length) j.segments = planSegments(j.total, j.connections);
      j.state = 'downloading'; j.phase = ''; j.message = j.mirrors.length && j.attempts > 1 ? `Using mirror 1 of ${j.mirrors.length}` : ''; j.etag = '"' + randomBytes(6).toString('hex') + '"'; jlog(j, `206 Partial Content, ${j.connections} segments, total ${j.total}`);
    }
    if (j.state === 'downloading') {
      const base = (j.platform === 'PS4' ? 38e6 : 62e6) * SPEED_MULT;
      const limit = settings.downloads.maxBytesPerSec || Infinity;
      const target = Math.min(limit, base * (0.75 + 0.5 * Math.abs(Math.sin(t / 7000 + hash32(j.id) % 7))) * (1 + (Math.random() - 0.5) * 0.2));
      j.speed = j.speed ? j.speed * 0.85 + target * 0.15 : target;
      let budget = j.speed * dt;
      const open = j.segments.filter((s) => s[2] < s[1]).slice(0, j.connections);
      if (!open.length) { finishDownload(j); continue; }
      const per = budget / open.length;
      for (const s of open) { const take = Math.min(per, s[1] - s[2]); s[2] += take; budget -= take; }
      const root = rootOf(j.root);
      const before = j.written;
      j.written = Math.min(j.total, Math.round(j.segments.reduce((n, s) => n + (s[2] - s[0]), 0)));
      if (root) root.free = Math.max(0, root.free - (j.written - before));
      if (root && root.free < 256 * MiB) { fail(j, 'no_space', 'The drive is full.'); continue; }
      j.eta = j.speed > 0 ? Math.round((j.total - j.written) / j.speed) : 0;
      if (sample) { j.speedHistory.push(Math.round(j.speed)); if (j.speedHistory.length > 60) j.speedHistory.shift(); }
      if (j.written >= j.total) finishDownload(j);
    }
    if (j.state === 'verifying') {
      j.written = Math.min(j.total, j.written + 450e6 * dt);
      if (j.written >= j.total) { j.written = j.total; j.verified = true; j.sha256 = j.sha256Expected; jlog(j, 'sha256 OK'); complete(j); }
    }
    if (j.state === 'installing' && t >= j._installUntil) {
      j.state = 'installed'; j.install = { state: 'installed', message: 'Installed', contentId: j.install.contentId }; j.phase = ''; jlog(j, 'installed');
      if (j.titleId && !installedTitles.some((x) => x.titleId === j.titleId)) installedTitles.unshift({ titleId: j.titleId, gameId: j.gameId, title: j.title, cover: j.cover, path: `/user/app/${j.titleId}` });
    }
    if (j.state === 'done' && j._verifyOnly && t >= j._verifyOnly) { j._verifyOnly = 0; j.verified = true; j.sha256 = j.sha256Expected; j.phase = ''; jlog(j, 'manual verify: sha256 OK'); }
  }
}
function fail(j, code, message) { j.state = 'failed'; j.errorCode = code; j.error = code; j.message = message; j.speed = 0; j.phase = ''; const back = [5, 15, 45, 120, 300][Math.min(4, j.attempts - 1)]; j.nextRetryAt = code === 'no_space' ? 0 : now() + back; jlog(j, `failed: ${code} — ${message} (retry in ${back}s)`); }
function finishDownload(j) {
  j.written = j.total; j.segments.forEach((s) => { s[2] = s[1]; }); j.speed = 0; j.eta = 0;
  if (j.verify === 'sha256' && j.sha256Expected) { j.state = 'verifying'; j.phase = 'Computing SHA-256'; j.written = 0; jlog(j, 'download complete → verifying'); return; }
  complete(j);
}
function complete(j) {
  j.state = 'done'; j.phase = ''; j.finishedAt = now(); j.message = ''; jlog(j, `done (${j.total} bytes) → ${j.path}`);
  log('info', `toast: ✓ ${j.title} downloaded (${(j.total / GB).toFixed(1)} GB)`);
  if ((j.format === 'PKG' || j.format === 'FPKG') && j.autoInstall) startInstall(j);
}
function startInstall(j) { j.state = 'installing'; j.phase = 'sceAppInstUtilInstallByPackage'; j.install = { state: 'installing', message: 'Installing package…', contentId: `EP0001-${j.titleId || 'PPSA00000'}_00-XENOSTOREMOCK000` }; j._installUntil = Date.now() + 3000; jlog(j, 'install started (AppInstUtil local path)'); }
setInterval(tick, 250);

/* ============================================================ API helpers ============================================================ */
const publicJob = (j, history) => { const o = {}; for (const k of Object.keys(j)) if (k[0] !== '_' && (history || k !== 'speedHistory')) o[k] = j[k]; return o; };
function summary() {
  const s = { active: 0, queued: 0, paused: 0, failed: 0, done: 0, speed: 0, remaining: 0, eta: 0, keepAwake: false };
  for (const j of jobs) {
    if (['connecting', 'downloading', 'verifying', 'installing'].indexOf(j.state) >= 0) s.active++;
    else if (j.state === 'queued') s.queued++; else if (j.state === 'paused') s.paused++; else if (j.state === 'failed') s.failed++; else if (j.state === 'done' || j.state === 'installed') s.done++;
    if (j.state === 'downloading') s.speed += j.speed;
    if (['connecting', 'downloading', 'queued', 'paused', 'failed'].indexOf(j.state) >= 0) s.remaining += Math.max(0, (j.total || 0) - (j.written || 0));
  }
  s.speed = Math.round(s.speed); s.eta = s.speed > 0 ? Math.round(s.remaining / s.speed) : 0;
  s.keepAwake = settings.downloads.keepAwake && jobs.some((j) => j.state === 'downloading');
  return s;
}
class ApiError extends Error { constructor(status, code, message) { super(message); this.status = status; this.code = code; } }
const findJob = (id) => { const j = jobs.find((x) => x.id === id); if (!j) throw new ApiError(404, 'not_found', 'No such download'); return j; };

/* ============================================================ routes (method + regex → handler) ============================================================ */
const routes = [];
const route = (method, pattern, handler) => routes.push({ method, pattern, handler });

route('GET', /^\/api\/status$/, () => ({
  ok: true, app: 'XENO STORE', version: VERSION, build: 'dev-mock', platform: 'host', fw: '13.60', ip: HOST === '0.0.0.0' ? '192.168.1.20' : HOST, port: PORT, uptime: now() - startedAt,
  downloadsAvailable: DOWNLOADS_AVAILABLE,
  catalog: { revision: catalog.revision, games: catalog.games.length, releases: catalog.games.reduce((n, g) => n + g.releases.length, 0), source: existsSync(catalogPath) ? 'embedded' : 'cached', updatedAt: catalog.generatedAt },
  queue: summary(), storage: roots,
  update: { available: UPDATE_AVAILABLE, latest: UPDATE_AVAILABLE ? bump(VERSION) : VERSION, current: VERSION, notes: UPDATE_AVAILABLE ? 'Faster segmented downloads, new themes, bug fixes.' : '' },
  notices: args.includes('--notice') ? [{ id: 'welcome-1', text: 'Welcome to the XENO STORE preview — tell us what you think on GitHub.' }] : []
}));
const bump = (v) => v.replace(/(\d+)$/, (m) => String(Number(m) + 1));
route('GET', /^\/api\/log$/, (q) => ({ ok: true, lines: logLines.slice(-Math.max(1, Math.min(400, Number(q.lines) || 200))) }));
route('POST', /^\/api\/system\/toast$/, (q, body) => { log('info', `toast: ${body.text || ''}`); return { ok: true }; });
route('POST', /^\/api\/system\/stop$/, () => { log('warn', 'stop requested (mock keeps running)'); return { ok: true }; });
route('GET', /^\/api\/update\/check$/, () => { settings.updates.lastCheck = now(); return { ok: true, current: VERSION, latest: UPDATE_AVAILABLE ? bump(VERSION) : VERSION, url: `https://github.com/XENOKING123/XENOKING/releases/download/xeno-store-v${bump(VERSION)}/xeno-store.elf`, sha256: 'c0ffee'.repeat(10) + 'abcd', notes: UPDATE_AVAILABLE ? 'Faster segmented downloads, new themes, bug fixes.' : '', available: UPDATE_AVAILABLE }; });
route('POST', /^\/api\/update\/apply$/, async () => { await sleep(1500); log('info', 'update staged at /data/xeno-store/xeno-store.elf'); return { ok: true, path: '/data/xeno-store/xeno-store.elf', restartRequired: true }; });

route('GET', /^\/api\/catalog\/info$/, () => ({ ok: true, revision: catalog.revision, generatedAt: catalog.generatedAt, games: catalog.games.length, releases: catalog.games.reduce((n, g) => n + g.releases.length, 0), sources: catalog.sources, embeddedRevision: catalog.revision, cachedRevision: 0 }));
route('POST', /^\/api\/catalog\/refresh$/, async () => { await sleep(800); settings.catalog.lastCheck = now(); log('info', 'catalog refresh: already current'); return { ok: true, updated: false, revision: catalog.revision }; });
route('GET', /^\/api\/catalog\/search$/, (q) => {
  const needle = String(q.q || '').toLowerCase().trim(); const limit = Math.max(1, Math.min(200, Number(q.limit) || 50));
  const items = [];
  for (const g of catalog.games) { if (q.platform && g.platform !== q.platform) continue; if (needle && (g.title + ' ' + (g.titleIds || []).join(' ') + ' ' + g.publisher).toLowerCase().indexOf(needle) < 0) continue; items.push({ id: g.id, title: g.title, platform: g.platform, titleIds: g.titleIds, cover: g.cover, sizeMax: g.sizeMax, verified: g.verified }); if (items.length >= limit) break; }
  return { ok: true, items };
});
route('POST', /^\/api\/links\/check$/, async (q, body) => {
  const urls = (body.urls || []).slice(0, 8);
  await sleep(600 + urls.length * 150);
  const results = urls.map((url, i) => { let size = 0; for (const { r } of releaseIndex.values()) if (r.url === url || (r.mirrors || []).indexOf(url) >= 0) size = r.sizeBytes; const ok = !/fail|broken|404/i.test(url); const ms = Math.round(80 + Math.random() * 320 + i * 40); return { url, status: ok ? 206 : 404, size: ok ? size || Math.round(20 * GB) : 0, acceptRanges: ok, finalUrl: url, ms, bytesPerSec: ok ? Math.round((40 + Math.random() * 60) * 1e6) : 0 }; });
  return { ok: true, results };
});
route('POST', /^\/api\/links\/resolve$/, async (q, body) => {
  const url = String(body.url || ''); let host = ''; try { host = new URL(url).hostname; } catch (e) { throw new ApiError(400, 'bad_url', 'Enter a full http(s) URL'); }
  await sleep(900);
  if (/dlpsgame\.com$/.test(host)) { const slug = url.replace(/\/+$/, '').split('/').pop(); return { ok: true, links: [{ url: `https://1fichier.com/?${hash32(slug).toString(36)}`, label: `${slug}-part1.rar`, host: '1fichier.com', size: 48 * GB }, { url: `https://vikingfile.com/f/${hash32(slug + 'v').toString(36)}`, label: `${slug}.ffpfsc`, host: 'vikingfile.com', size: 47.2 * GB }, { url: `https://archive.org/download/${slug}/${slug}.ffpfsc`, label: `${slug}.ffpfsc`, host: 'archive.org', size: 47.2 * GB }] }; }
  if (/archive\.org$/.test(host)) { const id = url.split('/').filter(Boolean)[3] || 'item'; return { ok: true, links: [{ url: `https://archive.org/download/${id}/${id}.ffpfsc`, label: `${id}.ffpfsc`, host: 'archive.org', size: 31.5 * GB }] }; }
  return { ok: true, links: [] };
});

route('GET', /^\/api\/queue$/, (q) => ({ ok: true, jobs: jobs.map((j) => publicJob(j, q.history === '1')), summary: summary() }));
route('POST', /^\/api\/queue$/, (q, body) => {
  if (!DOWNLOADS_AVAILABLE) throw new ApiError(503, 'downloads_unavailable', 'Downloads are unavailable on this firmware');
  const root = rootOf(body.root || settings.downloads.defaultRoot);
  if (!root || !root.writable) throw new ApiError(400, 'root_unavailable', 'That drive is not available');
  let g = gamesById.get(body.gameId), r = null;
  if (body.releaseId) { const hit = releaseIndex.get(body.releaseId); if (!hit) throw new ApiError(400, 'bad_release', 'Unknown release'); g = g || hit.g; r = hit.r; }
  if (!g) throw new ApiError(400, 'bad_release', 'Unknown game');
  if (!r && !body.url) throw new ApiError(400, 'bad_release', 'A release id or a direct url is required');
  if (body.url && !/^https?:\/\/[^\s@]+$/i.test(body.url)) throw new ApiError(400, 'bad_url', 'Only http(s) links without credentials are accepted');
  const opts = { root: root.path, connections: body.connections, verify: body.verify, autoInstall: body.autoInstall, url: body.url, filename: body.filename, format: body.format || (r && r.format) };
  if (body.url && (!r || r.format === 'PAGE')) { r = { id: r ? r.id : '', url: body.url, filename: body.filename || body.url.split('/').pop(), format: body.format || 'FFPFSC', sizeBytes: 0, sha256: '', provider: safeHost(body.url), sourceId: r ? r.sourceId : 'other', mirrors: [] }; opts.total = r.sizeBytes; }
  if (r.format === 'PAGE') throw new ApiError(400, 'bad_release', 'That entry is a web page, not a file — use Enter file link');
  const job = makeJob(g, r, opts);
  const dup = jobs.find((j) => j.path === job.path);
  if (dup && ['queued', 'connecting', 'downloading', 'verifying', 'paused', 'failed', 'installing'].indexOf(dup.state) >= 0) throw new ApiError(409, 'already_queued', 'This file is already in the queue');
  if (dup && (dup.state === 'done' || dup.state === 'installed') && !body.overwrite) throw new ApiError(409, 'exists', 'The file already exists on the drive');
  if (root.free - unfinishedOn(root.path) < job.total + 256 * MiB) throw new ApiError(400, 'no_space', 'Not enough free space on that drive');
  if (dup && body.overwrite) jobs.splice(jobs.indexOf(dup), 1);
  jobs.push(job);
  log('info', `queued ${job.id}: ${job.title} (${job.format}, ${(job.total / GB).toFixed(1)} GB) → ${job.path}`);
  return { ok: true, job: publicJob(job) };
});
const safeHost = (u) => { try { return new URL(u).hostname; } catch (e) { return ''; } };
route('POST', /^\/api\/queue\/clear$/, (q, body) => { const states = body.states || ['done', 'cancelled', 'failed']; let removed = 0; for (let i = jobs.length - 1; i >= 0; i--) if (states.indexOf(jobs[i].state) >= 0) { jobs.splice(i, 1); removed++; } log('info', `queue cleared: ${removed} entries`); return { ok: true, removed }; });
route('GET', /^\/api\/queue\/([^/]+)\/log$/, (q, body, m) => { findJob(m[1]); return { ok: true, lines: jobLogs.get(m[1]) || [] }; });
route('POST', /^\/api\/queue\/([^/]+)\/url$/, (q, body, m) => { const j = findJob(m[1]); if (!/^https?:\/\//i.test(body.url || '')) throw new ApiError(400, 'bad_url', 'Only http(s) links are accepted'); j.url = body.url; j.provider = safeHost(body.url); j.errorCode = ''; j.error = ''; j.message = 'Link replaced — resuming'; j.nextRetryAt = 0; j.attempts = 0; if (j.state !== 'downloading') j.state = 'queued'; jlog(j, `url replaced: ${body.url}`); return { ok: true, job: publicJob(j) }; });
route('POST', /^\/api\/queue\/([^/]+)\/(pause|resume|cancel|retry|remove|restart|install|verify|move)$/, (q, body, m) => {
  const j = findJob(m[1]); const a = m[2];
  const resetProgress = () => { j.written = 0; j.speed = 0; j.eta = 0; j.segments = planSegments(j.total, j.connections); j.speedHistory = []; const root = rootOf(j.root); if (root) root.free += j._freed || 0; };
  switch (a) {
    case 'pause': if (['queued', 'connecting', 'downloading'].indexOf(j.state) < 0) throw new ApiError(409, 'bad_state', 'This download cannot be paused'); j.state = 'paused'; j.speed = 0; j.eta = 0; j.message = 'Paused by user'; jlog(j, 'paused'); break;
    case 'resume': if (j.state !== 'paused') throw new ApiError(409, 'bad_state', 'Only paused downloads can be resumed'); j.state = 'queued'; j.message = ''; j.errorCode = ''; j.error = ''; jlog(j, 'resumed → queued'); break;
    case 'retry': if (j.state !== 'failed') throw new ApiError(409, 'bad_state', 'Only failed downloads can be retried'); j.state = 'queued'; j.nextRetryAt = 0; j.message = ''; j.errorCode = ''; j.error = ''; jlog(j, 'manual retry → queued'); break;
    case 'cancel': if (['done', 'installed', 'cancelled'].indexOf(j.state) >= 0) throw new ApiError(409, 'bad_state', 'Nothing to cancel'); j.state = 'cancelled'; j.speed = 0; j.eta = 0; j.nextRetryAt = 0; j.message = 'Cancelled by user'; if (body.deleteFiles) { const root = rootOf(j.root); if (root) root.free += j.written; j.written = 0; j.segments = planSegments(j.total, j.connections); } jlog(j, 'cancelled'); break;
    case 'restart': if (['downloading', 'connecting'].indexOf(j.state) >= 0) throw new ApiError(409, 'bad_state', 'Pause it first'); { const root = rootOf(j.root); if (root) root.free += j.written; } resetProgress(); j.state = 'queued'; j.attempts = 0; j.nextRetryAt = 0; j.message = ''; j.errorCode = ''; j.error = ''; j.finishedAt = 0; j.verified = false; j.install = { state: 'idle', message: '', contentId: '' }; jlog(j, 'restart from zero → queued'); break;
    case 'install': if (j.state !== 'done' || (j.format !== 'PKG' && j.format !== 'FPKG')) throw new ApiError(409, 'bad_state', 'Only finished packages can be installed'); startInstall(j); break;
    case 'verify': if (j.state !== 'done' && j.state !== 'installed') throw new ApiError(409, 'bad_state', 'Only finished downloads can be verified'); if (!j.sha256Expected) throw new ApiError(400, 'no_hash', 'The catalog has no hash for this file'); j.phase = 'Computing SHA-256'; j._verifyOnly = Date.now() + 2500; jlog(j, 'manual verify started'); break;
    case 'move': { const dir = body.direction; const qd = jobs.filter((x) => x.state === 'queued').sort((p, s) => (p.priority - s.priority) || (p.addedAt - s.addedAt)); const i = qd.indexOf(j); if (i < 0) throw new ApiError(409, 'bad_state', 'Only queued downloads can be reordered'); qd.splice(i, 1); const at = dir === 'top' ? 0 : dir === 'bottom' ? qd.length : dir === 'up' ? Math.max(0, i - 1) : Math.min(qd.length, i + 1); qd.splice(at, 0, j); qd.forEach((x, k) => { x.priority = k; }); jlog(j, `moved ${dir}`); break; }
    case 'remove': { if (['downloading', 'connecting', 'verifying', 'installing'].indexOf(j.state) >= 0) throw new ApiError(409, 'bad_state', 'Pause or cancel it first'); if (body.deleteFiles) { const root = rootOf(j.root); if (root) root.free += j.written; } jobs.splice(jobs.indexOf(j), 1); jobLogs.delete(j.id); log('info', `removed ${j.id}${body.deleteFiles ? ' + files' : ''}`); return { ok: true, job: publicJob(j) }; }
  }
  return { ok: true, job: publicJob(j) };
});
route('GET', /^\/api\/space$/, (q) => { const root = rootOf(q.root || settings.downloads.defaultRoot); if (!root) throw new ApiError(400, 'root_unavailable', 'Unknown drive'); const bytes = Number(q.bytes) || 0; const afterQueue = root.free - unfinishedOn(root.path); const afterThis = afterQueue - bytes; return { ok: true, root: root.path, free: Math.round(root.free), afterQueue: Math.round(afterQueue), afterThis: Math.round(afterThis), fits: afterThis >= 256 * MiB }; });

route('GET', /^\/api\/storage$/, () => ({ ok: true, roots: roots.map((r) => ({ ...r, free: Math.round(r.free), total: Math.round(r.total) })) }));
route('POST', /^\/api\/storage\/default$/, (q, body) => { const root = rootOf(body.root); if (!root || !root.writable) throw new ApiError(400, 'root_unavailable', 'That drive cannot be the default'); roots.forEach((r) => { r.default = r === root; }); settings.downloads.defaultRoot = root.path; log('info', `default root → ${root.path}`); return { ok: true }; });
route('GET', /^\/api\/library$/, async (q) => {
  if (q.scan === '1' || !lastScan) { await sleep(q.scan === '1' ? 700 : 0); lastScan = now(); }
  const files = [];
  for (const j of jobs) {
    if (['done', 'installed'].indexOf(j.state) >= 0) files.push({ path: j.path, name: j.filename, size: j.total, mtime: j.finishedAt || j.addedAt, format: j.format.toLowerCase(), root: j.root, titleId: j.titleId, gameId: j.gameId, title: j.title, cover: j.cover, partial: false, jobId: j.id });
    else if (j.written > 0 && j.state !== 'queued') files.push({ path: j.path + '.xpart', name: j.filename + '.xpart', size: j.written, mtime: j.addedAt, format: 'xpart', root: j.root, titleId: j.titleId, gameId: j.gameId, title: j.title, cover: j.cover, partial: true, jobId: j.id });
  }
  files.push(...extraFiles);
  libraryAllow = new Set(files.map((f) => f.path));
  return { ok: true, files, installed: installedTitles, scannedAt: lastScan };
});
route('POST', /^\/api\/library\/delete$/, (q, body) => { if (!libraryAllow.has(body.path)) throw new ApiError(403, 'not_allowed', 'Only files from the last scan can be deleted'); const i = extraFiles.findIndex((f) => f.path === body.path); if (i >= 0) { const f = extraFiles[i]; const root = rootOf(f.root); if (root) root.free += f.size; extraFiles.splice(i, 1); } const j = jobs.find((x) => x.path === body.path || x.path + '.xpart' === body.path); if (j) { const root = rootOf(j.root); if (root) root.free += j.written; jobs.splice(jobs.indexOf(j), 1); } log('info', `deleted ${body.path}`); return { ok: true }; });
route('POST', /^\/api\/library\/install$/, (q, body) => { if (!libraryAllow.has(body.path)) throw new ApiError(403, 'not_allowed', 'Only scanned packages can be installed'); const f = [...extraFiles, ...jobs.map((j) => ({ path: j.path, name: j.filename, size: j.total, gameId: j.gameId, title: j.title, cover: j.cover, titleId: j.titleId, format: j.format }))].find((x) => x.path === body.path); if (!f || !/pkg$/i.test(f.path)) throw new ApiError(400, 'bad_request', 'Not a package'); const g = gamesById.get(f.gameId) || { id: f.gameId || 'local', title: f.title || f.name, platform: /CUSA/.test(f.titleId || '') ? 'PS4' : 'PS5', titleIds: f.titleId ? [f.titleId] : [], cover: f.cover || '', slug: 'local' }; const job = makeJob(g, { id: '', url: 'file://' + f.path, filename: f.name, format: 'PKG', sizeBytes: f.size, provider: 'Local file', sourceId: 'local' }, { root: f.path.split('/').slice(0, 2).join('/') }); job.state = 'done'; job.written = job.total; job.autoInstall = true; jobs.push(job); startInstall(job); return { ok: true, job: publicJob(job) }; });
route('POST', /^\/api\/shadowmount\/scan$/, async () => { await sleep(400); log('info', 'ShadowMount scan requested'); return { ok: true, available: !args.includes('--no-shadowmount'), status: args.includes('--no-shadowmount') ? 'connection refused' : 'scan queued' }; });

route('GET', /^\/api\/settings$/, () => ({ ok: true, ...settings }));
route('PUT', /^\/api\/settings$/, (q, body) => { const b = { ...body }; delete b.ok; delete b.$etag; deepMerge(settings, b); settings.downloads.connections = Math.max(1, Math.min(16, Number(settings.downloads.connections) || 8)); settings.downloads.concurrentJobs = Math.max(1, Math.min(4, Number(settings.downloads.concurrentJobs) || 1)); if (settings.downloads.defaultRoot && rootOf(settings.downloads.defaultRoot)) roots.forEach((r) => { r.default = r.path === settings.downloads.defaultRoot; }); log('info', `settings updated: ${Object.keys(b).join(', ')}`); return { ok: true, settings }; });
route('GET', /^\/api\/favorites$/, () => ({ ok: true, ids: favorites }));
route('PUT', /^\/api\/favorites$/, (q, body) => { favorites = (body.ids || []).filter((id) => typeof id === 'string'); return { ok: true, ids: favorites }; });
route('POST', /^\/api\/favorites\/toggle$/, (q, body) => { const id = String(body.id || ''); const i = favorites.indexOf(id); if (i >= 0) favorites.splice(i, 1); else favorites.push(id); return { ok: true, favorite: i < 0 }; });
route('GET', /^\/api\/collections$/, () => ({ ok: true, collections }));
route('PUT', /^\/api\/collections$/, (q, body) => { collections = (body.collections || []).map((c) => ({ id: String(c.id || ''), name: String(c.name || ''), icon: String(c.icon || 'folder'), ids: (c.ids || []).filter((x) => typeof x === 'string') })); return { ok: true, collections }; });
route('GET', /^\/api\/recent$/, () => ({ ok: true, ids: recent }));
route('POST', /^\/api\/recent$/, (q, body) => { const id = String(body.id || ''); recent = [id].concat(recent.filter((x) => x !== id)).slice(0, 30); return { ok: true, ids: recent }; });
route('GET', /^\/api\/export$/, () => ({ ok: true, exportedAt: new Date().toISOString(), version: VERSION, settings, favorites: { ids: favorites }, collections: { collections }, recent: { ids: recent } }));
route('POST', /^\/api\/import$/, (q, body) => { if (body.settings) deepMerge(settings, body.settings); if (body.favorites && body.favorites.ids) favorites = body.favorites.ids.slice(); if (body.collections && body.collections.collections) collections = body.collections.collections; if (body.recent && body.recent.ids) recent = body.recent.ids.slice(); log('info', 'settings imported'); return { ok: true }; });
route('GET', /^\/api\/pair$/, () => ({ ok: true, url: `http://${HOST === '0.0.0.0' ? '192.168.1.20' : HOST}:${PORT}/`, ip: HOST === '0.0.0.0' ? '192.168.1.20' : HOST, port: PORT }));

/* ============================================================ static ============================================================ */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const logoPath = join(here, 'src', 'logo.jpg');
const iconPath = [join(ROOT, 'homebrew', 'sce_sys', 'icon0.png')].find((p) => existsSync(p)) || null;
function mockArt(id, kind) {
  const g = gamesById.get(id);
  const title = g ? g.title : id;
  const hue = hash32(title) % 360, hue2 = (hue + 40) % 360;
  const words = title.replace(/[^\w\s:'-]/g, '').split(/\s+/).filter(Boolean);
  const lines = []; let cur = '';
  for (const w of words) { if ((cur + ' ' + w).trim().length > (kind === 'hero' ? 26 : 14)) { if (cur) lines.push(cur); cur = w; } else cur = (cur + ' ' + w).trim(); }
  if (cur) lines.push(cur);
  const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const W = kind === 'hero' ? 1600 : 600, H = kind === 'hero' ? 900 : 800;
  const fs = kind === 'hero' ? 78 : 54;
  /* hero art keeps its title small and in the far corner: the real UI draws the title over the art */
  const text = kind === 'hero'
    ? ''
    : lines.slice(0, 4).map((l, i) => `<text x="${W / 2}" y="${H / 2 + (i - (lines.length - 1) / 2) * fs * 1.15}" text-anchor="middle" font-family="Inter, Segoe UI, Arial, sans-serif" font-weight="800" font-size="${fs}" fill="#fff" fill-opacity=".92">${esc(l)}</text>`).join('');
  const plat = g ? `<rect x="${kind === 'hero' ? 80 : 30}" y="30" width="${g.platform === 'PS4' ? 92 : 92}" height="40" rx="8" fill="${g.platform === 'PS4' ? '#8a94b3' : '#2f7cf6'}"/><text x="${(kind === 'hero' ? 80 : 30) + 46}" y="58" text-anchor="middle" font-family="Inter, Arial, sans-serif" font-weight="900" font-size="24" fill="#fff">${g.platform}</text>` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue},60%,42%)"/><stop offset="1" stop-color="hsl(${hue2},55%,16%)"/></linearGradient><radialGradient id="r" cx="${kind === 'hero' ? '75%' : '50%'}" cy="30%" r="60%"><stop offset="0" stop-color="#fff" stop-opacity=".22"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient></defs><rect width="${W}" height="${H}" fill="url(#g)"/><rect width="${W}" height="${H}" fill="url(#r)"/><circle cx="${W * 0.8}" cy="${H * 0.25}" r="${H * 0.28}" fill="hsl(${hue2},70%,60%)" fill-opacity=".18"/>${plat}${text}<text x="${W - 30}" y="${H - 24}" text-anchor="end" font-family="Inter, Arial, sans-serif" font-weight="700" font-size="20" fill="#fff" fill-opacity=".45">MOCK ART · XENO STORE</text></svg>`;
}

function send(res, status, body, headers) {
  const h = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, X-XENO-PIN', ...headers };
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
  h['Content-Length'] = buf.length;
  res.writeHead(status, h); res.end(buf);
}
const sendJson = (res, status, obj) => send(res, status, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
const readBody = (req) => new Promise((resolve, reject) => { const chunks = []; let n = 0; req.on('data', (c) => { n += c.length; if (n > 1024 * 1024) { reject(new ApiError(413, 'too_large', 'Request body over 1 MiB')); req.destroy(); } chunks.push(c); }); req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8'))); req.on('error', reject); });

let distCache = { mtime: 0, html: null, gz: null, etag: '' };
function dist() {
  if (!existsSync(DIST)) return null;
  const mtime = statSync(DIST).mtimeMs;
  if (mtime !== distCache.mtime) { const html = readFileSync(DIST); distCache = { mtime, html, gz: gzipSync(html), etag: '"' + createHash('sha256').update(html).digest('hex').slice(0, 16) + '"' }; }
  return distCache;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const path = url.pathname;
  const q = Object.fromEntries(url.searchParams.entries());
  const acceptGz = /\bgzip\b/.test(req.headers['accept-encoding'] || '');
  try {
    if (req.method === 'OPTIONS') return send(res, 204, '', {});
    if (path.indexOf('..') >= 0 || /[\x00-\x1f]/.test(path)) throw new ApiError(400, 'bad_path', 'Invalid path');
    if (path === '/' || path === '/index.html') {
      const d = dist(); if (!d) return send(res, 503, 'web/dist/index.html is missing — run: node web/build.mjs', { 'Content-Type': 'text/plain' });
      if (req.headers['if-none-match'] === d.etag) return send(res, 304, '', { ETag: d.etag });
      return send(res, 200, acceptGz ? d.gz : d.html, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', ETag: d.etag, ...(acceptGz ? { 'Content-Encoding': 'gzip' } : {}) });
    }
    if (path === '/catalog.json') {
      if (req.headers['if-none-match'] === catalogEtag) return send(res, 304, '', { ETag: catalogEtag });
      return send(res, 200, acceptGz ? catalogGz : catalogJson, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache', ETag: catalogEtag, ...(acceptGz ? { 'Content-Encoding': 'gzip' } : {}) });
    }
    if (path === '/logo.jpg') return existsSync(logoPath) ? send(res, 200, readFileSync(logoPath), { 'Content-Type': 'image/jpeg', 'Cache-Control': 'max-age=86400' }) : send(res, 404, 'no logo', { 'Content-Type': 'text/plain' });
    if (path === '/icon.png') { if (iconPath) return send(res, 200, readFileSync(iconPath), { 'Content-Type': 'image/png', 'Cache-Control': 'max-age=86400' }); if (existsSync(logoPath)) return send(res, 200, readFileSync(logoPath), { 'Content-Type': 'image/jpeg', 'Cache-Control': 'max-age=86400' }); }
    if (path === '/manifest.webmanifest') return send(res, 200, JSON.stringify({ name: 'XENO STORE', short_name: 'XENO', start_url: '/', display: 'standalone', background_color: '#060b1c', theme_color: '#060b1c', icons: [{ src: '/icon.png', sizes: '512x512', type: 'image/png' }] }), { 'Content-Type': 'application/manifest+json', 'Cache-Control': 'max-age=3600' });
    let m;
    if ((m = /^\/i18n\/([a-zA-Z-]+)\.json$/.exec(path))) { const p = join(here, 'src', 'i18n', m[1] + '.json'); if (existsSync(p)) return send(res, 200, readFileSync(p), { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'max-age=3600' }); throw new ApiError(404, 'not_found', 'No such locale'); }
    if ((m = /^\/mockart\/([^/]+)\/(cover|hero)\.svg$/.exec(path))) return send(res, 200, mockArt(decodeURIComponent(m[1]), m[2]), { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'max-age=86400' });
    if (path.indexOf('/api/') === 0) {
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const mm = r.pattern.exec(path); if (!mm) continue;
        let body = {};
        if (req.method !== 'GET') { const raw = await readBody(req); if (raw) { try { body = JSON.parse(raw); } catch (e) { throw new ApiError(400, 'bad_json', 'Body is not valid JSON'); } } }
        if (req.method !== 'GET' && settings.pairing.pin && req.headers['x-xeno-pin'] !== settings.pairing.pin && !(path === '/api/settings' && body.pairing)) throw new ApiError(401, 'pin_required', 'This console needs the PIN');
        const out = await r.handler(q, body, mm, req);
        return sendJson(res, 200, out);
      }
      throw new ApiError(404, 'not_found', `No route for ${req.method} ${path}`);
    }
    throw new ApiError(404, 'not_found', 'Not found');
  } catch (err) {
    if (err instanceof ApiError) return sendJson(res, err.status, { ok: false, error: err.code, message: err.message });
    log('error', `${req.method} ${path}: ${err.stack || err}`);
    return sendJson(res, 500, { ok: false, error: 'internal', message: String(err.message || err) });
  }
});
server.listen(PORT, HOST, () => {
  log('info', `XENO STORE dev server → http://${HOST}:${PORT}/  (art=${ART}, speed×${SPEED_MULT}${UPDATE_AVAILABLE ? ', update available' : ''}${DOWNLOADS_AVAILABLE ? '' : ', downloads unavailable'})`);
  if (!existsSync(DIST)) log('warn', 'web/dist/index.html not found — run `node web/build.mjs` first');
});
