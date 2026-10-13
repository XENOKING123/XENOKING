/*
 * XENO STORE — web/dev-server-ext-b.mjs: mock routes for the Phase 2 web features (part B).
 * Loaded by dev-server.mjs (every dev-server-ext-*.mjs is). Endpoints follow SPEC §17.5, §17.6, §17.13–§17.20:
 *   GET  /api/stats                                   lifetime download statistics
 *   GET|POST /api/setup/check                         readiness checklist (+ status.setup summary)
 *   GET  /api/payloads · POST /api/payloads/{id}/install|launch     companion payloads (console jobs)
 *   GET  /api/homebrew-dirs · POST /api/homebrew-dirs/delete        ghost icon cleaner
 *   POST /api/uninstall
 *   POST /api/library/transfer|launch|uninstall · GET /api/library/usage · POST /api/library/usage/clean
 *   POST /api/saves/backup|restore|transfer · GET /api/saves/backups · GET /api/saves/jobs[/{id}] · POST …/cancel
 *   GET  /api/accounts · POST /api/accounts/{slot}/activate|clear · POST /api/accounts/reboot
 *   GET  /api/mdns
 *   GET  /api/queue (adds groups + summary.restMode + a virtual scheduled job) · POST /api/queue/{id}/startnow
 *   fallbacks for /api/debrid, /api/saves/users and /api/saves?user= when part A's mock is absent
 * Seeds: an install set paused at its update step, a downloading install set, turbo results on the running job,
 * a debrid job, a copy job, a backup job, a ZIP being extracted, a scheduled job, Phase 2 settings defaults.
 */
import { randomBytes } from 'node:crypto';

export function register({ route, state }) {
  const { ApiError, sleep, now, hash32, GB, MiB, log } = state;
  const MB = 1e6;
  const args = state.args;
  const iso = (secAgo) => new Date(Date.now() - secAgo * 1000).toISOString();
  const rid = (p) => p + '_' + randomBytes(3).toString('hex');
  const basename = (p) => String(p || '').replace(/\/+$/, '').split('/').pop();
  const IMAGE = ['exfat', 'ffpfsc', 'ffpkg', 'ffpfs'];
  const games = () => state.catalog.games.filter((g) => g.platform === 'PS5' || g.platform === 'PS4');
  const titleOf = (titleId) => games().find((g) => (g.titleIds || []).indexOf(titleId) >= 0) || null;

  /* ============================== console-side jobs (cx_jobs): backups, payload downloads ============================== */
  const cxJobs = [];
  function cxStart(type, title, total, rate, onDone, result) {
    const j = { id: rid('cx'), type, title, state: 'queued', message: '', error: '', errorCode: '', done: 0, total, percent: 0, createdAt: now(), startedAt: 0, finishedAt: 0, result: result || {}, _rate: rate, _onDone: onDone, _cancel: false };
    cxJobs.push(j); if (cxJobs.length > 60) cxJobs.shift();
    return j;
  }
  const pubCx = (j) => ({ id: j.id, type: j.type, title: j.title, state: j.state, message: j.message, error: j.error, errorCode: j.errorCode, done: Math.round(j.done), total: j.total, percent: j.percent, createdAt: j.createdAt, startedAt: j.startedAt, finishedAt: j.finishedAt, result: j.result });
  let lastCx = Date.now();
  setInterval(() => {
    const t = Date.now(), dt = (t - lastCx) / 1000; lastCx = t;
    const running = cxJobs.filter((j) => j.state === 'running');
    if (!running.length) { const q = cxJobs.find((j) => j.state === 'queued'); if (q) { q.state = 'running'; q.startedAt = now(); q.message = q.type === 'backup' ? 'Zipping save files…' : 'Downloading…'; } }
    for (const j of cxJobs) {
      if (j.state !== 'running') continue;
      if (j._cancel) { j.state = 'cancelled'; j.finishedAt = now(); j.message = 'Cancelled'; continue; }
      j.done = Math.min(j.total, j.done + j._rate * dt);
      j.percent = j.total ? Math.round(j.done / j.total * 100) : 0;
      if (j.done >= j.total) { j.state = 'done'; j.percent = 100; j.finishedAt = now(); j.message = j.type === 'backup' ? 'Backup written' : 'SHA-256 verified'; if (j._onDone) { try { j._onDone(j); } catch (e) { log('error', 'cx job onDone: ' + e.message); } } }
    }
    tickExtras(t, dt);
  }, 250);
  route('GET', /^\/api\/saves\/jobs$/, () => ({ ok: true, jobs: cxJobs.map(pubCx) }));
  route('GET', /^\/api\/saves\/jobs\/([^/]+)$/, (q, body, m) => { const j = cxJobs.find((x) => x.id === m[1]); if (!j) throw new ApiError(404, 'not_found', 'No such job'); return { ok: true, job: pubCx(j) }; });
  route('POST', /^\/api\/saves\/jobs\/([^/]+)\/cancel$/, (q, body, m) => { const j = cxJobs.find((x) => x.id === m[1]); if (!j || (j.state !== 'running' && j.state !== 'queued')) throw new ApiError(404, 'not_found', 'No such running job'); j._cancel = true; if (j.state === 'queued') { j.state = 'cancelled'; j.finishedAt = now(); } return { ok: true, job: pubCx(j) }; });

  /* ============================== stats (§17.5) ============================== */
  const statsBase = { totalBytes: 2.1e12, totalJobs: 148, bestSpeed: 94e6, avgSpeed: 41e6, totalSeconds: 51000, since: now() - 86400 * 61 };
  route('GET', /^\/api\/stats$/, () => {
    const done = state.jobs.filter((j) => (j.state === 'done' || j.state === 'installed' || j.state === 'extracted') && j.type !== 'copy');
    const byProvider = { 'Archive.org': { bytes: 1.62e12, jobs: 96, bestSpeed: 94e6 }, 'Real-Debrid': { bytes: 3.1e11, jobs: 21, bestSpeed: 88e6 }, 'pkg-zone': { bytes: 4.2e9, jobs: 19, bestSpeed: 36e6 }, 'XENO mirrors': { bytes: 1.64e11, jobs: 12, bestSpeed: 72e6 } };
    for (const j of done) { const p = j.provider || 'other'; byProvider[p] = byProvider[p] || { bytes: 0, jobs: 0, bestSpeed: 0 }; }
    return { ok: true, v: 1, ...statsBase, totalBytes: statsBase.totalBytes + done.reduce((n, j) => n + (j.total || 0), 0), totalJobs: statsBase.totalJobs + done.length, byProvider, updatedAt: now() };
  });

  /* ============================== setup checklist (§17.6) ============================== */
  const PAYLOADS_URL = 'https://raw.githubusercontent.com/XENOKING123/XENOKING/main/xeno-store/updates/payloads.json';
  const setup = { checked: false, at: 0, checks: [] };
  const shadowOk = () => args.includes('--shadowmount-ok');
  function runChecks() {
    const root = state.defaultRoot();
    const sm = payloads.find((p) => p.id === 'shadowmount-plus');
    setup.checks = [
      { id: 'shadowmount', ok: shadowOk(), optional: false, detail: shadowOk() ? 'ShadowMountPlus answers on 127.0.0.1:10101 (v1.03)' : 'Nothing answers on 127.0.0.1:10101', fix: shadowOk() ? '' : 'Start ShadowMountPlus (it mounts exFAT/FFPFSC images from homebrew/). With a copy on the console you can launch it from here.', action: !shadowOk() && sm && sm.installed ? 'launch' : (!shadowOk() ? 'install' : ''), actionId: !shadowOk() ? 'shadowmount-plus' : '' },
      { id: 'dpi', ok: true, optional: false, detail: 'Package installer daemon answers on 127.0.0.1:9040', fix: '' },
      { id: 'etahen', ok: false, optional: true, detail: 'No etaHEN DPI on 127.0.0.1:12800', fix: 'Optional second installer path. Send etaHEN before XENO STORE to use it as a fallback.', action: '', actionId: '' },
      { id: 'internet', ok: true, optional: false, detail: 'raw.githubusercontent.com answered in 184 ms', fix: '' },
      { id: 'drive', ok: !!root && root.writable, optional: false, detail: root ? `${root.label} (${root.path}) is writable` : 'No default drive', fix: root && root.writable ? '' : 'Pick a writable default drive in Settings → Downloads.' },
      { id: 'space', ok: !!root && root.free > 20 * GB, optional: false, detail: root ? `${(root.free / GB).toFixed(0)} GB free on ${root.label}` : '', fix: root && root.free > 20 * GB ? '' : 'Free up space in Library → Disk analyzer or pick another drive.' },
      { id: 'firmware', ok: true, optional: false, detail: 'Firmware 13.60 — FPKG installs work with the etaHEN chain', fix: '' },
      { id: 'payload-manager', ok: false, optional: true, detail: 'XENO STORE is not in Payload Manager\'s auto-start list', fix: 'Add the XENOKING source URL below in Payload Manager and enable auto-start so the store loads on every boot.' }
    ];
    setup.checked = true; setup.at = now();
    log('info', `setup check: ${setup.checks.filter((c) => c.ok).length}/${setup.checks.length} ok`);
  }
  const setupSummary = () => ({ checked: setup.checked, ok: setup.checks.filter((c) => c.ok).length, total: setup.checks.length || 8, failing: setup.checks.filter((c) => !c.ok).map((c) => c.id), at: setup.at });
  route('GET', /^\/api\/setup\/check$/, async () => { if (!setup.checked) { await sleep(500); runChecks(); } return { ok: true, checks: setup.checks, payloadsUrl: PAYLOADS_URL, fw: '13.60', summary: setupSummary() }; });
  route('POST', /^\/api\/setup\/check$/, async () => { await sleep(900); runChecks(); return { ok: true, checks: setup.checks, payloadsUrl: PAYLOADS_URL, fw: '13.60', summary: setupSummary() }; });

  /* ============================== companion payloads (§17.16, §17.18) ============================== */
  const payloads = [
    { id: 'shadowmount-plus', name: 'ShadowMountPlus', version: '1.03', kind: 'shadowmount', url: 'https://github.com/XENOKING123/XENOKING/releases/download/companions/ShadowMountPlus-1.03.elf', sha256: 'a1'.repeat(32), notes: 'Mounts exFAT / FFPFSC dumps from homebrew/ and shows them on the home screen.', homepage: 'https://github.com/XENOKING123/XENOKING', size: 412 * 1024, installed: true, installedVersion: '1.02' },
    { id: 'etahen-dpi-helper', name: 'etaHEN DPI helper', version: '2.1', kind: 'dpi', url: 'https://github.com/XENOKING123/XENOKING/releases/download/companions/dpi-helper-2.1.elf', sha256: 'b2'.repeat(32), notes: 'Package installer daemon on :9040 for firmwares where AppInstUtil refuses direct installs.', homepage: '', size: 96 * 1024, installed: false, installedVersion: '' },
    { id: 'kstuff', name: 'kstuff', version: '1.2.0', kind: 'kernel', url: 'https://github.com/XENOKING123/XENOKING/releases/download/companions/kstuff-1.2.0.elf', sha256: 'c3'.repeat(32), notes: 'Kernel patches for FPKG and save mounting; load it once per boot.', homepage: '', size: 1.1 * MB, installed: true, installedVersion: '1.2.0' },
    { id: 'np-fake-signin', name: 'NP fake sign-in', version: '1.0', kind: 'np-signin', url: 'https://github.com/earthonion/np-fake-signin/releases/download/v1.0/np-fake-signin.elf', sha256: 'd4'.repeat(32), notes: 'Pretends PSN is signed in so trophies pop offline. Activate the profile first.', homepage: 'https://github.com/earthonion/np-fake-signin', size: 48 * 1024, installed: false, installedVersion: '' },
    { id: 'np-fake-signout', name: 'NP fake sign-out', version: '1.0', kind: 'np-signout', url: 'https://github.com/earthonion/np-fake-signin/releases/download/v1.0/np-fake-signout.elf', sha256: 'e5'.repeat(32), notes: 'Reverts the fake sign-in.', homepage: 'https://github.com/earthonion/np-fake-signin', size: 44 * 1024, installed: false, installedVersion: '' },
    { id: 'ps5-app-dumper', name: 'App dumper', version: '1.1', kind: 'dumper', url: 'https://github.com/XENOKING123/XENOKING/releases/download/companions/app-dumper-1.1.elf', sha256: 'f6'.repeat(32), notes: 'Dumps an installed game to an image on a USB drive (exFAT).', homepage: '', size: 220 * 1024, installed: true, installedVersion: '1.1' },
    { id: 'garlic-save-manager', name: 'Garlic Save Manager', version: '0.9.4', kind: 'saves', url: 'https://github.com/XENOKING123/XENOKING/releases/download/companions/garlic-0.9.4.elf', sha256: '07'.repeat(32), notes: 'Save re-signing worker on :8082 (ELF Arsenal / garlicsaves.com).', homepage: 'https://garlicsaves.com', size: 2.4 * MB, installed: false, installedVersion: '' }
  ];
  const loaderAvailable = () => !args.includes('--no-loader');
  const pubPayload = (p) => ({ id: p.id, name: p.name, version: p.version, url: p.url, sha256: p.sha256, notes: p.notes, kind: p.kind, homepage: p.homepage, size: Math.round(p.size), installed: p.installed, localPath: p.installed ? `/data/xeno-store/payloads/${p.id}.elf` : '', localSize: p.installed ? Math.round(p.size) : 0, installedVersion: p.installed ? p.installedVersion : '', updateAvailable: p.installed && !!p.installedVersion && p.installedVersion !== p.version });
  route('GET', /^\/api\/payloads$/, () => ({ ok: true, payloads: payloads.map(pubPayload), loaderPort: 9021, loaderAvailable: loaderAvailable(), feedFetchedAt: now() - 7200, note: 'Payloads are downloaded to the console (sha256 checked) and sent to the local ELF loader on :9021. XENO STORE never loads code in-process.' }));
  route('POST', /^\/api\/payloads\/([^/]+)\/install$/, (q, body, m) => {
    const p = payloads.find((x) => x.id === m[1]); if (!p) throw new ApiError(404, 'not_found', 'Unknown payload');
    const job = cxStart('payload', `${p.name} v${p.version}`, Math.round(p.size), Math.max(60 * 1024, p.size / 2.2), () => { p.installed = true; p.installedVersion = p.version; }, { id: p.id, localPath: `/data/xeno-store/payloads/${p.id}.elf`, sha256: p.sha256, size: Math.round(p.size), verified: true });
    log('info', `payload download queued: ${p.id}`);
    return { ok: true, job: pubCx(job) };
  });
  route('POST', /^\/api\/payloads\/([^/]+)\/launch$/, async (q, body, m) => {
    const p = payloads.find((x) => x.id === m[1]); if (!p) throw new ApiError(404, 'not_found', 'Unknown payload');
    if (!p.installed) throw new ApiError(409, 'not_installed', `${p.name} is not on the console yet — download it first`);
    if (!loaderAvailable()) throw new ApiError(503, 'loader_unavailable', 'No ELF loader answers on 127.0.0.1:9021 — start etaHEN or another loader first');
    await sleep(350);
    log('info', `payload sent to :9021: ${p.id} (${Math.round(p.size)} bytes)`);
    if (p.id === 'shadowmount-plus') args.push('--shadowmount-ok');
    return { ok: true, id: p.id, bytes: Math.round(p.size), port: 9021, sent: true };
  });

  /* ============================== ghost icon cleaner (§17.16) ============================== */
  let hbDirs = [
    { name: 'XENO-STORE', title: 'XENO STORE', size: 4.9 * MB, hasEboot: true, hasIcon: true, isXenoStore: true, mtime: now() - 86400 * 2 },
    { name: 'ShadowMountPlus', title: 'ShadowMountPlus', size: 1.3 * MB, hasEboot: true, hasIcon: true, isXenoStore: false, mtime: now() - 86400 * 30 },
    { name: 'PPSA01234', title: '', size: 12 * 1024, hasEboot: false, hasIcon: false, isXenoStore: false, mtime: now() - 86400 * 90 },
    { name: 'Old-Dump-Tool', title: 'Old Dump Tool', size: 640 * 1024, hasEboot: false, hasIcon: true, isXenoStore: false, mtime: now() - 86400 * 200 },
    { name: 'RetroArch', title: 'RetroArch', size: 96 * MB, hasEboot: true, hasIcon: true, isXenoStore: false, mtime: now() - 86400 * 12 }
  ];
  route('GET', /^\/api\/homebrew-dirs$/, async () => { await sleep(300); return { ok: true, dirs: hbDirs.map((d) => ({ name: d.name, path: `/data/homebrew/${d.name}`, title: d.title, size: Math.round(d.size), hasEboot: d.hasEboot, hasIcon: d.hasIcon, isXenoStore: d.isXenoStore, mtime: d.mtime })), root: '/data/homebrew', note: 'ShadowMountPlus registers every folder here as a home-screen icon; deleting a folder removes its icon on the next scan.' }; });
  route('POST', /^\/api\/homebrew-dirs\/delete$/, async (q, body) => {
    const name = String(body.name || '');
    if (!name || name.indexOf('/') >= 0 || name[0] === '.') throw new ApiError(400, 'bad_request', 'invalid folder name');
    if (body.confirm !== name) throw new ApiError(400, 'confirm_required', 'repeat the folder name in "confirm" to delete it');
    const i = hbDirs.findIndex((d) => d.name === name); if (i < 0) throw new ApiError(404, 'not_found', 'folder no longer exists');
    await sleep(400); hbDirs.splice(i, 1); log('info', `homebrew-dirs: deleted /data/homebrew/${name}`);
    return { ok: true, deleted: name };
  });

  /* ============================== uninstall (§17.16) ============================== */
  route('POST', /^\/api\/uninstall$/, async (q, body) => {
    const sel = { data: !!body.data, homebrew: !!body.homebrew, payloadManager: !!body.payloadManager, downloads: !!body.downloads };
    if (!sel.data && !sel.homebrew && !sel.payloadManager && !sel.downloads) throw new ApiError(400, 'bad_request', 'Nothing selected: pass data, homebrew, payloadManager and/or downloads');
    await sleep(900);
    const removed = [], kept = [], failed = [];
    (sel.data ? removed : kept).push('/data/xeno-store/');
    (sel.homebrew ? removed : kept).push('/data/homebrew/XENO-STORE/');
    if (sel.payloadManager) removed.push('/data/etaHEN/payloads/xeno-store.elf'); else kept.push('/data/etaHEN/payloads/xeno-store.elf');
    for (const r of state.roots) { if (sel.downloads) { removed.push(`${r.path}/xeno-store/`); removed.push(`${r.path}/homebrew/`); } else kept.push(`${r.path}/xeno-store/ (downloads)`); }
    if (sel.data && args.includes('--uninstall-fail')) { failed.push('/data/xeno-store/log.txt'); }
    log('warn', `uninstall: removed ${removed.length}, kept ${kept.length} (mock keeps running)`);
    return { ok: true, removed, kept, failed, removedCount: removed.length, failedCount: failed.length, stopping: true };
  });

  /* ============================== library: transfer, launch, uninstall, usage (§17.16, §17.20) ============================== */
  function fileSizeFor(path) {
    const j = state.jobs.find((x) => x.path === path); if (j) return j.total || 0;
    const x = hash32(path); return Math.round((8 + (x % 70)) * GB);
  }
  route('POST', /^\/api\/library\/transfer$/, (q, body) => {
    const path = String(body.path || ''); if (!path.startsWith('/')) throw new ApiError(400, 'bad_request', 'path is required');
    const srcRoot = state.roots.find((r) => path.startsWith(r.path + '/')); if (!srcRoot) throw new ApiError(400, 'bad_request', 'path is not on a known drive');
    const to = state.rootOf(body.toRoot); if (!to || !to.writable) throw new ApiError(400, 'root_unavailable', 'That drive is not available');
    if (to.path === srcRoot.path) throw new ApiError(400, 'same_drive', 'Source and destination are the same drive');
    const size = fileSizeFor(path);
    if (to.free - state.unfinishedOn(to.path) < size + 256 * MiB) throw new ApiError(400, 'no_space', 'Not enough free space on the destination drive');
    const name = basename(path), ext = (name.split('.').pop() || '').toLowerCase();
    const src = state.jobs.find((x) => x.path === path);
    const g = (src && state.gamesById.get(src.gameId)) || { id: 'local', slug: 'local', title: name, platform: 'PS5', titleIds: [], cover: '' };
    const job = state.makeJob(g, { id: '', url: 'file://' + path, filename: name, format: ext.toUpperCase() === 'EXFAT' ? 'exFAT' : ext.toUpperCase(), sizeBytes: size, provider: 'Local file', sourceId: 'local', mirrors: [] }, { root: to.path, type: 'copy', autoInstall: false, verify: 'size' });
    job.path = `${to.path}/${IMAGE.indexOf(ext) >= 0 ? 'homebrew' : (ext === 'pkg' || ext === 'fpkg') ? 'xeno-store/pkg' : 'xeno-store/files'}/${name}`;
    job.srcPath = path; job.move = !!body.move; job.connections = 1; job.segments = [[0, size, 0]]; job.cover = src ? src.cover : ''; job.title = src ? src.title : name;
    state.jobs.push(job);
    log('info', `${body.move ? 'move' : 'copy'} queued: ${path} → ${to.path}`);
    return { ok: true, job: state.publicJob(job) };
  });
  route('POST', /^\/api\/library\/launch$/, async (q, body) => {
    const tid = String(body.titleId || ''); if (!/^(PPSA|CUSA)\d{5}$/.test(tid)) throw new ApiError(400, 'bad_request', 'titleId must look like PPSA12345 / CUSA12345');
    if (!state.installedTitles.some((it) => it.titleId === tid)) throw new ApiError(404, 'not_installed', `${tid} is not installed`);
    await sleep(300); const g = titleOf(tid);
    log('info', `launch ${tid} (simulated)`);
    return { ok: true, titleId: tid, launched: true, simulated: true, title: g ? g.title : '' };
  });
  const unTokens = new Map();
  route('POST', /^\/api\/library\/uninstall$/, async (q, body) => {
    const tid = String(body.titleId || ''); if (!/^(PPSA|CUSA)\d{5}$/.test(tid)) throw new ApiError(400, 'bad_request', 'titleId must look like PPSA12345 / CUSA12345');
    const i = state.installedTitles.findIndex((it) => it.titleId === tid); if (i < 0) throw new ApiError(404, 'not_installed', `${tid} is not installed`);
    const tok = unTokens.get(tid);
    if (!body.token || !tok || tok.token !== body.token || tok.expires < now()) {
      const token = randomBytes(8).toString('hex'); unTokens.set(tid, { token, expires: now() + 60 });
      const g = titleOf(tid);
      return { ok: true, confirmRequired: true, token, expiresIn: 60, titleId: tid, title: g ? g.title : '', message: `Uninstall ${tid} and its saves stay on the console? Send the token back within 60 s to confirm.` };
    }
    unTokens.delete(tid); await sleep(700);
    state.installedTitles.splice(i, 1);
    log('info', `uninstalled ${tid} (simulated)`);
    return { ok: true, titleId: tid, uninstalled: true, simulated: true };
  });
  function usageFor(root) {
    const jobs = state.jobs.filter((j) => j.root === root.path);
    const done = jobs.filter((j) => j.state === 'done' || j.state === 'installed' || j.state === 'extracted');
    const sum = (pred) => done.filter(pred).reduce((n, j) => n + (j.total || 0), 0);
    const x = hash32(root.path);
    const games = root.path === '/data' ? state.installedTitles.length * 38 * GB : 0;
    const dumps = sum((j) => IMAGE.indexOf(String(j.format).toLowerCase()) >= 0 && j.type !== 'copy') + (root.path === '/mnt/usb0' ? 3 * 41 * GB : 0);
    const packages = sum((j) => /pkg$/i.test(j.format));
    const files = sum((j) => /zip|rar|7z/i.test(j.format)) + (root.path === '/mnt/ext0' ? 184 * MiB : 0);
    const saves = backups.filter((b) => b.root === root.path).reduce((n, b) => n + b.size, 0);
    const partialsList = jobs.filter((j) => j.written > 0 && ['paused', 'failed', 'cancelled'].indexOf(j.state) >= 0).map((j) => ({ path: j.path + '.xpart', size: Math.round(j.written), mtime: j.addedAt, jobId: j.id }));
    if (root.path === '/mnt/ext0') partialsList.push({ path: '/mnt/ext0/homebrew/PPSA02020 Orphaned Download.ffpfsc.xpart', size: Math.round(6.4 * GB), mtime: now() - 86400 * 9 });
    const partials = partialsList.reduce((n, p) => n + p.size, 0);
    const used = Math.max(0, root.total - root.free);
    return { path: root.path, label: root.label, kind: root.kind, free: Math.round(root.free), total: Math.round(root.total), used: Math.round(used), default: !!root.default, categories: { games: Math.round(games), dumps: Math.round(dumps), packages: Math.round(packages), files: Math.round(files), saves: Math.round(saves), partials: Math.round(partials), xenoTotal: Math.round(dumps + packages + files + saves + partials) }, partials: partialsList, _x: x };
  }
  route('GET', /^\/api\/library\/usage$/, async () => { await sleep(600); return { ok: true, roots: state.roots.map((r) => { const u = usageFor(r); delete u._x; return u; }), scannedAt: now() }; });
  route('POST', /^\/api\/library\/usage\/clean$/, async (q, body) => {
    const root = body.root ? state.rootOf(body.root) : null;
    if (body.root && !root) throw new ApiError(422, 'root_unavailable', 'Unknown drive');
    await sleep(500);
    const removed = [], skipped = []; let freed = 0;
    for (const j of state.jobs) {
      if (root && j.root !== root.path) continue;
      if (!(j.written > 0)) continue;
      if (['paused', 'failed', 'cancelled'].indexOf(j.state) < 0) { if (['downloading', 'connecting'].indexOf(j.state) >= 0) skipped.push(j.path + '.xpart'); continue; }
      const r = state.rootOf(j.root); if (r) r.free += j.written; freed += j.written;
      removed.push(j.path + '.xpart'); j.written = 0; j.segments.forEach((s) => { s[2] = s[0]; }); j.state = 'cancelled'; j.message = 'Partial file removed by Clean up partials'; state.jlog(j, 'partial removed by clean-up');
    }
    if (!root || root.path === '/mnt/ext0') { removed.push('/mnt/ext0/homebrew/PPSA02020 Orphaned Download.ffpfsc.xpart'); freed += 6.4 * GB; const r = state.rootOf('/mnt/ext0'); if (r) r.free += 6.4 * GB; }
    log('info', `clean partials: ${removed.length} removed, ${(freed / GB).toFixed(1)} GB freed`);
    return { ok: true, removed, skipped, removedCount: removed.length, freed: Math.round(freed) };
  });

  /* ============================== saves hub (§17.17) ============================== */
  const USERS = [{ id: 268435456, name: 'XENOKING', foreground: true }, { id: 268435457, name: 'Guest', foreground: false }];
  const userOf = (id) => USERS.find((u) => String(u.id) === String(id)) || null;
  const backupRoot = () => { const s = state.settings.saves && state.settings.saves.backupRoot; return (s && state.rootOf(s)) || state.defaultRoot(); };
  const stamp = (secAgo) => { const d = new Date(Date.now() - secAgo * 1000); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`; };
  const backups = [];
  function addBackup(user, tid, kind, size, secAgo, pre, rootPath) {
    const g = titleOf(tid);
    const name = `${tid}_${kind}_${stamp(secAgo)}${pre ? '.pre-restore' : ''}.zip`;
    const root = rootPath || backupRoot().path;
    const b = { path: `${root}/xeno-store/saves/${user.name}/${name}`, name, user: user.name, root, titleId: tid, title: g ? g.title : '', cover: g ? g.cover : '', gameId: g ? g.id : '', kind, size: Math.round(size), mtime: now() - secAgo, preRestore: !!pre };
    backups.unshift(b); return b;
  }
  function saveSize(tid, uid) { const x = hash32(tid + uid); return Math.round((0.3 + (x % 50) / 10) * MB) * (1 + (x % 3)); }
  function seedBackups() {
    const inst = state.installedTitles.filter((it) => /^PPSA/.test(it.titleId));
    if (inst[0]) addBackup(USERS[0], inst[0].titleId, 'ps5', saveSize(inst[0].titleId, USERS[0].id), 86400 * 3, false);
    if (inst[1]) addBackup(USERS[0], inst[1].titleId, 'ps5', saveSize(inst[1].titleId, USERS[0].id), 86400 * 10, false, '/mnt/ext0');
    if (inst[1]) addBackup(USERS[0], inst[1].titleId, 'ps5', saveSize(inst[1].titleId, USERS[0].id) - 20000, 86400 * 1, true);
    if (inst[2]) addBackup(USERS[1], inst[2].titleId, 'ps5', saveSize(inst[2].titleId, USERS[1].id), 3600 * 5, false);
    addBackup(USERS[0], 'CUSA00572', 'ps4', 2.4 * MB, 86400 * 40, false);
  }
  function savesOf(user) {
    return state.installedTitles.filter((it) => /^PPSA/.test(it.titleId)).map((it) => {
      const x = hash32(it.titleId + user.id), g = state.gamesById.get(it.gameId);
      const dirs = Array.from({ length: 1 + (x % 3) }, (_, i) => ({ name: i === 0 ? 'SAVEDATA00' : `SAVEDATA0${i}`, size: Math.round((0.3 + (x % 50) / 10) * MB) + i * 200000, mtime: now() - (x % 20) * 86400 - i * 3600 }));
      return { titleId: it.titleId, gameId: it.gameId, title: it.title || (g ? g.title : ''), cover: it.cover || (g ? g.cover : ''), path: `/user/home/${user.id.toString(16)}/savedata_prospero/${it.titleId}`, size: dirs.reduce((n, d) => n + d.size, 0), mtime: dirs[0].mtime, kind: 'ps5', version: `01.00${x % 6}.000`, region: ['EUR', 'USA', 'JPN'][x % 3], dirs, installed: true };
    });
  }
  route('POST', /^\/api\/saves\/backup$/, (q, body) => {
    const user = userOf(body.user) || USERS[0];
    if (body.all) {
      const ids = savesOf(user).map((s) => cxStart('backup', `${s.title || s.titleId} · save backup`, s.size, Math.max(400000, s.size / 1.8), (j) => { const b = addBackup(user, s.titleId, 'ps5', s.size, 0, false); j.result = { zipPath: b.path, titleId: s.titleId, kind: 'ps5', files: 3 + (hash32(s.titleId) % 4), bytes: s.size, size: s.size }; }).id);
      log('info', `backup all: ${ids.length} jobs for ${user.name}`);
      return { ok: true, jobs: ids, started: ids.length };
    }
    const tid = String(body.titleId || ''); if (!/^(PPSA|CUSA)\d{5}$/.test(tid)) throw new ApiError(400, 'bad_request', 'titleId must look like PPSA12345 / CUSA12345');
    const s = savesOf(user).find((x) => x.titleId === tid); if (!s) throw new ApiError(404, 'not_found', `${user.name} has no save for ${tid}`);
    const job = cxStart('backup', `${s.title || tid} · save backup`, s.size, Math.max(400000, s.size / 2.5), (j) => { const b = addBackup(user, tid, 'ps5', s.size, 0, false); j.result = { zipPath: b.path, titleId: tid, kind: 'ps5', files: 3 + (hash32(tid) % 4), bytes: s.size, size: s.size }; log('info', `backup written: ${b.path}`); });
    return { ok: true, job: pubCx(job) };
  });
  route('GET', /^\/api\/saves\/backups$/, async () => { await sleep(250); return { ok: true, backups: backups.map((b) => ({ ...b })), count: backups.length }; });
  route('POST', /^\/api\/saves\/restore$/, async (q, body) => {
    const user = userOf(body.user); if (!user) throw new ApiError(400, 'bad_user', 'Pick a console profile');
    const b = backups.find((x) => x.path === body.zipPath); if (!b) throw new ApiError(404, 'not_found', 'That backup is not in the list — refresh the backups');
    await sleep(900);
    const pre = addBackup(user, b.titleId, b.kind, Math.max(100000, b.size - 15000), 0, true);
    log('info', `restore ${b.name} → ${user.name} (pre-backup ${pre.name})`);
    return { ok: true, titleId: b.titleId, kind: b.kind, path: `/user/home/${user.id.toString(16)}/${b.kind === 'ps4' ? 'savedata' : 'savedata_prospero'}/${b.titleId}`, preBackup: pre.path, tier: 'native', style: body.overwrite ? 'replace' : 'merge', files: 3 + (hash32(b.titleId) % 4), bytes: b.size };
  });
  route('POST', /^\/api\/saves\/transfer$/, async (q, body) => {
    const from = userOf(body.fromUser), to = userOf(body.toUser);
    if (!from || !to) throw new ApiError(400, 'bad_user', 'Pick two console profiles');
    if (from.id === to.id) throw new ApiError(400, 'bad_request', 'Source and destination profile are the same');
    const tid = String(body.titleId || ''); const s = savesOf(from).find((x) => x.titleId === tid); if (!s) throw new ApiError(404, 'not_found', `${from.name} has no save for ${tid}`);
    await sleep(800);
    const hadDest = hash32(tid + to.id) % 2 === 0;
    const pre = hadDest ? addBackup(to, tid, 'ps5', Math.max(100000, s.size - 40000), 0, true) : null;
    log('info', `transfer ${tid}: ${from.name} → ${to.name}${body.move ? ' (move)' : ''}`);
    return { ok: true, fromUser: from.id, toUser: to.id, titleId: tid, kind: 'ps5', path: `/user/home/${to.id.toString(16)}/savedata_prospero/${tid}`, bytes: s.size, preBackup: pre ? pre.path : '', moved: !!body.move, note: 'Saves are sealed to this console: same-console transfers work; saves from another console need re-signing.' };
  });
  /* fallbacks when part A's mock is not loaded (first registered route wins, so these are inert otherwise) */
  route('GET', /^\/api\/saves\/users$/, () => ({ ok: true, users: USERS }));
  route('GET', /^\/api\/saves$/, async (q) => { const user = userOf(q.user) || USERS[0]; await sleep(300); return { ok: true, user: { id: user.id, name: user.name }, saves: savesOf(user), count: savesOf(user).length }; });

  /* ============================== accounts (§17.18) ============================== */
  const slots = Array.from({ length: 16 }, (_, i) => ({ slot: i + 1, name: '', id: '0x0', type: '', flags: 0, derivedId: '' }));
  const fnv = (name) => { let x = 0xcbf29ce484222325n; for (const c of Buffer.from(name)) { x ^= BigInt(c); x = (x * 0x100000001b3n) & 0xffffffffffffffffn; } return '0x' + x.toString(16).padStart(16, '0'); };
  Object.assign(slots[0], { name: 'XENOKING', id: '0x5d1f3a9c7b2e4f10', type: 'local', flags: 0x1, derivedId: fnv('XENOKING') });
  Object.assign(slots[1], { name: 'Guest', id: '0x0', type: 'local', flags: 0, derivedId: fnv('Guest') });
  Object.assign(slots[2], { name: 'Kid', id: '0x0', type: 'local', flags: 0, derivedId: fnv('Kid') });
  const pubSlot = (s) => ({ slot: s.slot, name: s.name, id: s.id, type: s.type, flags: s.flags, empty: !s.name, activated: !!s.name && s.id !== '0x0' && (s.flags & 0x1) !== 0, foreground: s.name === 'XENOKING', derivedId: s.derivedId });
  route('GET', /^\/api\/accounts$/, async () => { await sleep(200); return { ok: true, slots: slots.map(pubSlot), users: USERS, foregroundUser: { id: USERS[0].id, name: USERS[0].name }, supported: !args.includes('--no-registry'), simulated: true }; });
  route('POST', /^\/api\/accounts\/(\d+)\/activate$/, async (q, body, m) => {
    const s = slots[Number(m[1]) - 1]; if (!s || !s.name) throw new ApiError(404, 'not_found', 'Empty slot');
    const id = String(body.id || '').trim();
    if (id && !/^(0x)?[0-9a-f]{1,16}$/i.test(id)) throw new ApiError(400, 'bad_request', 'id must be a hex account id');
    await sleep(500);
    s.id = id ? (id.startsWith('0x') ? id : '0x' + id) : s.derivedId; s.flags |= 0x1;
    log('info', `account slot ${s.slot} (${s.name}) activated with ${s.id}`);
    return { ok: true, slot: pubSlot(s), rebootRequired: true };
  });
  route('POST', /^\/api\/accounts\/(\d+)\/clear$/, async (q, body, m) => {
    const s = slots[Number(m[1]) - 1]; if (!s || !s.name) throw new ApiError(404, 'not_found', 'Empty slot');
    await sleep(300); s.id = '0x0'; s.flags &= ~0x1;
    return { ok: true, slot: pubSlot(s), rebootRequired: true };
  });
  route('POST', /^\/api\/accounts\/reboot$/, () => { log('warn', 'reboot requested (mock keeps running)'); return { ok: true, rebooting: true, simulated: true }; });

  /* ============================== mDNS (§17.19) ============================== */
  const mdnsStatus = () => { const on = !state.settings.general || state.settings.general.mdns !== false; const ip = state.HOST === '0.0.0.0' ? '192.168.1.20' : state.HOST; return { enabled: on, running: on, names: ['xeno.local', 'xenostore.local'], ip, port: 5353, url: `http://xeno.local:${state.PORT}/`, error: '' }; };
  route('GET', /^\/api\/mdns$/, () => ({ ok: true, ...mdnsStatus() }));

  /* ============================== debrid fallback (part A owns the live one) ============================== */
  const dbServices = [{ id: 'realdebrid', name: 'Real-Debrid', connected: true, user: 'xenoking', expires: iso(-40 * 86400), hosts: ['1fichier.com', 'mediafire.com', 'gofile.io', 'pixeldrain.com'] }, { id: 'alldebrid', name: 'AllDebrid', connected: false, user: '', expires: '', hosts: [] }, { id: 'torbox', name: 'TorBox', connected: false, user: '', expires: '', hosts: [] }, { id: 'premiumize', name: 'Premiumize', connected: false, user: '', expires: '', hosts: [] }];
  route('GET', /^\/api\/debrid$/, () => ({ ok: true, services: dbServices }));
  route('PUT', /^\/api\/debrid$/, async (q, body) => { const s = dbServices.find((x) => x.id === body.service); if (!s) throw new ApiError(400, 'bad_service', 'Unknown debrid service'); if (String(body.apiKey || '').length < 8) throw new ApiError(400, 'bad_key', `${s.name} rejected that API key`); await sleep(500); s.connected = true; s.user = 'user_' + hash32(String(body.apiKey)).toString(36).slice(0, 6); s.expires = iso(-30 * 86400); return { ok: true, service: s }; });
  route('DELETE', /^\/api\/debrid\/([^/]+)$/, (q, body, m) => { const s = dbServices.find((x) => x.id === m[1]); if (!s) throw new ApiError(404, 'not_found', 'Unknown debrid service'); s.connected = false; s.user = ''; s.expires = ''; return { ok: true }; });

  /* ============================== queue: groups, rest-mode pill, scheduled jobs, start now ============================== */
  const virtual = [];   /* scheduled jobs that the base simulation must not start */
  const ACTIVE = ['connecting', 'downloading', 'verifying', 'installing', 'extracting'];
  function restPill() {
    const s = state.settings.downloads || {};
    const downloading = state.jobs.some((j) => j.state === 'downloading');
    if (downloading && s.keepAwake !== false) return 'Console stays awake while downloading';
    if (s.restModeAutoResume !== false) return 'Rest mode allowed — downloads resume on wake';
    return 'Rest mode allowed — downloads wait for Resume after a wake-up';
  }
  function summary(all) {
    const s = { active: 0, queued: 0, paused: 0, failed: 0, done: 0, speed: 0, remaining: 0, eta: 0, keepAwake: false };
    for (const j of all) {
      if (ACTIVE.indexOf(j.state) >= 0) s.active++;
      else if (j.state === 'queued') s.queued++; else if (j.state === 'paused') s.paused++; else if (j.state === 'failed') s.failed++; else if (j.state === 'done' || j.state === 'installed' || j.state === 'extracted') s.done++;
      if (j.state === 'downloading') s.speed += j.speed || 0;
      if (['connecting', 'downloading', 'queued', 'paused', 'failed'].indexOf(j.state) >= 0) s.remaining += Math.max(0, (j.total || 0) - (j.written || 0));
    }
    s.speed = Math.round(s.speed); s.eta = s.speed > 0 ? Math.round(s.remaining / s.speed) : 0;
    s.keepAwake = (state.settings.downloads.keepAwake !== false) && all.some((j) => j.state === 'downloading');
    s.restMode = restPill();
    return s;
  }
  function groupStatuses(all) {
    const out = [];
    for (const j of all) {
      if (!j.group || out.some((g) => g.id === j.group)) continue;
      const members = all.filter((x) => x.group === j.group).sort((a, b) => (a.groupOrder || 0) - (b.groupOrder || 0));
      const st = { id: j.group, gameId: j.gameId, title: j.title, total: 0, downloaded: 0, installed: 0, failed: 0, pending: 0, status: '', pausedAt: '', pausedJobId: '' };
      let cancelled = 0, installing = 0;
      for (const m of members) {
        st.total++;
        const installFailed = (m.state === 'done' || m.state === 'installing') && m.install && m.install.state === 'failed';
        if (m.state === 'cancelled') { cancelled++; continue; }
        if (m.state === 'failed' || installFailed) { st.failed++; if (!st.pausedJobId) { st.pausedAt = `${m.kind || 'game'}: ${m.filename || m.title}`; st.pausedJobId = m.id; } }
        if (['done', 'installed', 'extracted', 'installing', 'extracting'].indexOf(m.state) >= 0) st.downloaded++;
        if (m.state === 'installed') st.installed++;
        if (m.state === 'done' && m.install && m.install.state === 'pending') st.pending++;
        if (m.state === 'installing') installing = 1;
      }
      st.status = st.failed ? 'paused' : (st.total - cancelled === 0) ? 'cancelled' : (st.downloaded < st.total - cancelled) ? 'downloading' : (installing || st.pending) ? 'installing' : 'installed';
      out.push(st);
    }
    return out;
  }
  route('GET', /^\/api\/queue$/, (q) => {
    const all = state.jobs.map((j) => state.publicJob(j, q.history === '1')).concat(virtual.map((v) => ({ ...v })));
    return { ok: true, jobs: all, summary: summary(all), groups: groupStatuses(all) };
  });
  route('POST', /^\/api\/queue\/([^/]+)\/startnow$/, (q, body, m) => {
    const vi = virtual.findIndex((v) => v.id === m[1]);
    if (vi >= 0) {
      const v = virtual[vi]; const hit = state.releaseIndex.get(v.releaseId); const g = state.gamesById.get(v.gameId);
      if (!hit || !g) throw new ApiError(404, 'not_found', 'No such download');
      const job = state.makeJob(g, hit.r, { root: v.root }); job.startNow = true; job.scheduledFor = v.scheduledFor; job.message = 'Started outside the schedule';
      virtual.splice(vi, 1); state.jobs.push(job); state.jlog(job, 'start now: schedule window ignored for this download');
      return { ok: true, job: state.publicJob(job) };
    }
    const j = state.jobs.find((x) => x.id === m[1]); if (!j) throw new ApiError(404, 'not_found', 'No such download');
    if (j.state !== 'queued') throw new ApiError(409, 'bad_state', 'Only queued downloads can start now');
    j.startNow = true; j.message = 'Started outside the schedule'; state.jlog(j, 'start now');
    return { ok: true, job: state.publicJob(j) };
  });
  /* the virtual scheduled job answers the usual row actions without ever entering the simulation */
  route('POST', /^\/api\/queue\/(j_sched[0-9a-f]+)\/(pause|resume|cancel|retry|remove|restart|install|verify|move)$/, (q, body, m) => {
    const vi = virtual.findIndex((v) => v.id === m[1]); if (vi < 0) throw new ApiError(404, 'not_found', 'No such download');
    const v = virtual[vi];
    if (m[2] === 'cancel') { v.state = 'cancelled'; v.message = 'Cancelled by user'; v.scheduledFor = ''; }
    else if (m[2] === 'remove') { virtual.splice(vi, 1); }
    else if (m[2] === 'restart' || m[2] === 'resume' || m[2] === 'retry') { v.state = 'queued'; v.message = ''; }
    else if (m[2] === 'pause') { v.state = 'paused'; v.message = 'Paused by user'; }
    return { ok: true, job: { ...v } };
  });
  route('GET', /^\/api\/queue\/(j_sched[0-9a-f]+)\/log$/, (q, body, m) => ({ ok: true, lines: [`[${new Date().toISOString().slice(11, 19)}] queued → waits for the download window (${(state.settings.downloads.scheduleStart || '22:00')}–${(state.settings.downloads.scheduleEnd || '07:00')})`] }));

  /* ============================== status extras ============================== */
  state.statusExtra.push(() => ({ setup: setupSummary(), mdns: mdnsStatus(), consoleJobs: cxJobs.filter((j) => j.state === 'running' || j.state === 'queued').length }));

  /* ============================== extraction + install-set simulation ============================== */
  function tickExtras(t, dt) {
    const s = state.settings.downloads || {};
    for (const j of state.jobs) {
      /* ZIP archives: extract after the download when the setting is on (§17.19) */
      if (j.state === 'done' && j.type !== 'copy' && String(j.format).toUpperCase() === 'ZIP' && (j.kind || 'game') !== 'save' && s.extractZip !== false && !(j.extract && j.extract.state)) {
        j.state = 'extracting'; j.phase = 'extracting';
        j.extract = { state: 'extracting', dir: `${j.root}/homebrew/${j.filename.replace(/\.zip$/i, '')}/`, message: 'Extracting 1 of 12 files', files: 12, bytes: 0, archiveDeleted: false };
        j._extractUntil = t + 6000; j._extractStart = t;
        state.jlog(j, 'extracting 12 files → ' + j.extract.dir);
      }
      if (j.state === 'extracting' && j._extractUntil) {
        const p = Math.min(1, (t - j._extractStart) / (j._extractUntil - j._extractStart));
        j.extract.message = `Extracting ${Math.max(1, Math.min(12, Math.ceil(p * 12)))} of 12 files`; j.extract.bytes = Math.round(p * j.total);
        if (t >= j._extractUntil) { j.state = 'extracted'; j.phase = ''; j.extract.state = 'extracted'; j.extract.message = ''; j.extract.bytes = j.total; j.extract.archiveDeleted = s.deleteArchiveAfterExtract !== false; j.finishedAt = now(); state.jlog(j, `extracted 12 file(s)${j.extract.archiveDeleted ? ', archive deleted' : ''}`); }
      }
      /* install sets: once every member is downloaded, install pending members one at a time in groupOrder */
      if (j.group && j.state === 'done' && j.install && j.install.state === 'pending') {
        const members = state.jobs.filter((x) => x.group === j.group);
        const allDown = members.every((x) => ['done', 'installed', 'installing', 'extracted', 'cancelled'].indexOf(x.state) >= 0);
        const earlierOpen = members.some((x) => (x.groupOrder || 0) < (j.groupOrder || 0) && x.state !== 'installed' && x.state !== 'cancelled');
        const busy = members.some((x) => x.state === 'installing');
        if (allDown && !earlierOpen && !busy && s.autoInstallSets !== false) { state.startInstall(j); state.jlog(j, 'install set: installing ' + (j.kind || 'game') + ' step'); }
      }
    }
  }

  /* ============================== seeding (deferred: the base module declares its state after loading extensions) ============================== */
  setTimeout(seed, 0);
  function seed() {
    try { seedSettings(); seedJobs(); seedBackups(); } catch (e) { log('error', 'ext-b seed failed: ' + (e.stack || e)); }
  }
  function seedSettings() {
    const st = state.settings;
    Object.assign(st.general, { largeText: false, highContrast: false, safeMode: false, screensaver: true, screensaverMinutes: 3, controllerSwapConfirm: false, mdns: true });
    Object.assign(st.downloads, { preferFormat: 'auto', turboStart: true, autoInstallSets: true, installOrder: 'game,backport,update,dlc', restModeAutoResume: true, extractZip: true, deleteArchiveAfterExtract: true, scheduleStart: st.downloads.scheduleStart || '', scheduleEnd: st.downloads.scheduleEnd || '' });
    st.debrid = st.debrid || { realdebrid: { apiKey: 'rd-mock-key-7f3a9c2e' }, alldebrid: { apiKey: '' }, torbox: { apiKey: '' }, premiumize: { apiKey: '' }, preferred: 'auto' };
    st.catalog.featuredUrl = st.catalog.featuredUrl || ''; st.catalog.messagesUrl = st.catalog.messagesUrl || ''; st.catalog.companionsUrl = st.catalog.companionsUrl || ''; st.catalog.savesBackendUrl = st.catalog.savesBackendUrl || '';
    st.saves = st.saves || { backupRoot: '', autoBackup: true, indexUrls: ['https://raw.githubusercontent.com/XENOKING123/XENOKING/main/xeno-store/updates/saves.json'], backend: { kind: 'github', url: '', anonKey: '', bucket: 'ps5-saves', garlicFunction: 'garlic-savedb' }, uploadHost: 'pixeldrain', uploadEndpoint: '', submitEndpoint: '', nickname: '' };
    st.browse = st.browse || { presets: [] };
  }
  function seedJobs() {
    const jobs = state.jobs;
    const used = new Set(jobs.map((j) => j.gameId));
    /* leave the most popular titles alone: part A's keyboard walk needs untouched cards at the start of the Trending rail */
    const pool = games().filter((g) => g.platform === 'PS5' && !used.has(g.id)).sort((a, b) => (b.popularity || 0) - (a.popularity || 0)).slice(30);
    const direct = (g) => (g.releases || []).find((r) => r.sourceId === 'archive' && r.sizeBytes > 0 && (r.kind || 'game') === 'game' && r.format !== 'PAGE');
    const kindRel = (g, k) => (g.releases || []).find((r) => r.kind === k && r.format !== 'PAGE');
    const withSet = pool.filter((g) => direct(g) && kindRel(g, 'update') && kindRel(g, 'dlc'));
    const take = (pred) => { const i = pool.findIndex((g) => (!pred || pred(g)) && !used.has(g.id)); if (i < 0) return null; const g = pool[i]; used.add(g.id); return g; };
    /* 1. turbo results on the running download */
    const running = jobs.find((j) => j.state === 'downloading');
    if (running) {
      if (running.mirrors.length < 2) running.mirrors.push(`https://mirror.xeno-store.example/${encodeURIComponent(running.filename)}`, `https://dl.pkg-mirror.example/ps5/${encodeURIComponent(running.filename)}`);
      running.turbo = { done: true, picked: running.url, tested: [{ url: running.url, ms: 212, mbps: 48.3, status: 206, bytes: 1048576 }, { url: running.mirrors[0], ms: 480, mbps: 21.7, status: 206, bytes: 1048576 }, { url: running.mirrors[1], ms: 1340, mbps: 6.2, status: 206, bytes: 1048576 }] };
      running.peakSpeed = 94e6;
      state.jlog(running, 'turbo start: 3 mirrors raced, kept ' + running.url);
    }
    /* 2. install set paused at its update step (game installed, update's install failed, DLC waiting) */
    let g = withSet.find((x) => !used.has(x.id));
    if (g) {
      used.add(g.id);
      const group = 'g_' + randomBytes(3).toString('hex');
      const base = direct(g), upd = kindRel(g, 'update'), dlc = kindRel(g, 'dlc');
      const mk = (r, kind, order) => state.makeJob(g, { ...r, format: 'PKG', filename: `${(g.titleIds || [])[0] || 'PPSA00000'} ${g.title}${kind === 'game' ? '' : ' [' + kind.toUpperCase() + (r.version ? ' ' + r.version : '') + ']'}.pkg` }, { root: '/data', kind, group, groupOrder: order, autoInstall: true });
      const j1 = mk(base, 'game', 0), j2 = mk(upd, 'update', 1), j3 = mk(dlc, 'dlc', 2);
      j1.state = 'installed'; j1.written = j1.total; j1.segments.forEach((s) => { s[2] = s[1]; }); j1.finishedAt = now() - 5400; j1.install = { state: 'installed', message: 'Installed', contentId: `EP0001-${j1.titleId}_00-XENOSTOREMOCK000` };
      j2.state = 'done'; j2.written = j2.total; j2.segments.forEach((s) => { s[2] = s[1]; }); j2.finishedAt = now() - 3600; j2.install = { state: 'failed', message: 'AppInstUtil returned 0x80990015 (package rejected)', contentId: '' }; j2.errorCode = ''; state.jlog(j2, 'install failed: 0x80990015 — install set paused');
      j3.state = 'done'; j3.written = j3.total; j3.segments.forEach((s) => { s[2] = s[1]; }); j3.finishedAt = now() - 3000; j3.install = { state: 'pending', message: 'Waits for the update step', contentId: '' };
      jobs.push(j1, j2, j3);
      log('info', `seeded install set ${group} (paused at update) for ${g.title}`);
    }
    /* 3. install set still downloading (game 55 %, update + DLC queued behind it) */
    g = withSet.find((x) => !used.has(x.id));
    if (g) {
      used.add(g.id);
      const group = 'g_' + randomBytes(3).toString('hex');
      const base = direct(g), upd = kindRel(g, 'update'), dlc = kindRel(g, 'dlc');
      const mk = (r, kind, order) => state.makeJob(g, { ...r, format: 'PKG', filename: `${(g.titleIds || [])[0] || 'PPSA00000'} ${g.title}${kind === 'game' ? '' : ' [' + kind.toUpperCase() + (r.version ? ' ' + r.version : '') + ']'}.pkg` }, { root: '/mnt/ext0', kind, group, groupOrder: order, autoInstall: true });
      const j1 = mk(base, 'game', 0), j2 = mk(upd, 'update', 1), j3 = mk(dlc, 'dlc', 2);
      j1.state = 'downloading'; j1.startedAt = now() - 900; j1.attempts = 1; j1.written = Math.floor(j1.total * 0.55);
      let left = j1.written; j1.segments.forEach((s) => { const take2 = Math.min(s[1] - s[0], left); s[2] = s[0] + take2; left -= take2; });
      j1.speedHistory = Array.from({ length: 60 }, (_, i) => 38e6 + 10e6 * Math.sin(i / 4) + Math.random() * 5e6); j1.speed = j1.speedHistory[59];
      j1.install = { state: 'pending', message: '', contentId: '' }; j2.install = { state: 'pending', message: '', contentId: '' }; j3.install = { state: 'pending', message: '', contentId: '' };
      jobs.push(j1, j2, j3);
      log('info', `seeded install set ${group} (downloading) for ${g.title}`);
    }
    /* 4. a download unrestricted by Real-Debrid, paused */
    g = take((x) => direct(x));
    if (g) {
      const r = direct(g); const j = state.makeJob(g, r, { root: '/data' });
      j.via = 'Real-Debrid'; j.viaService = 'realdebrid'; j.viaRequested = 'auto'; j.provider = '1fichier'; j.url = `https://cdn.real-debrid.example/d/${randomBytes(5).toString('hex')}/${encodeURIComponent(r.filename || j.filename)}`;
      j.state = 'paused'; j.written = Math.floor(j.total * 0.18); j.segments.forEach((s) => { s[2] = Math.min(s[1], s[0] + Math.floor((s[1] - s[0]) * 0.18)); }); j.message = 'Paused by user'; j.attempts = 1; j.connections = 16;
      jobs.push(j); state.jlog(j, 'link unrestricted by Real-Debrid (16 connections)');
    }
    /* 5. copy between drives, running */
    const srcJob = jobs.find((j) => (j.state === 'done' || j.state === 'installed') && j.type !== 'copy' && j.root !== '/mnt/ext0' && /exfat|ffpfsc/i.test(j.format)) || null;
    const srcPath = srcJob ? srcJob.path : '/mnt/usb0/homebrew/PPSA04029 Cyberpunk 2077.exfat';
    const cg = srcJob ? state.gamesById.get(srcJob.gameId) : (take((x) => direct(x)) || games()[0]);
    if (cg) {
      const name = basename(srcPath), size = srcJob ? srcJob.total : Math.round(54 * GB);
      const cj = state.makeJob(cg, { id: '', url: 'file://' + srcPath, filename: name, format: name.split('.').pop().toUpperCase() === 'EXFAT' ? 'exFAT' : name.split('.').pop().toUpperCase(), sizeBytes: size, provider: 'Local file', sourceId: 'local', mirrors: [] }, { root: '/mnt/ext0', type: 'copy', autoInstall: false, verify: 'size' });
      cj.path = `/mnt/ext0/homebrew/${name}`; cj.srcPath = srcPath; cj.move = false; cj.connections = 1; cj.segments = [[0, size, Math.floor(size * 0.3)]]; cj.written = Math.floor(size * 0.3); cj.state = 'downloading'; cj.startedAt = now() - 300; cj.attempts = 1;
      cj.speedHistory = Array.from({ length: 60 }, () => 180e6 + Math.random() * 30e6); cj.speed = 190e6; cj.cover = srcJob ? srcJob.cover : cg.cover; cj.title = srcJob ? srcJob.title : cg.title;
      jobs.push(cj); state.jlog(cj, `copy ${srcPath} → ${cj.path} (8 MiB chunks, fdatasync)`);
    }
    /* 6. a finished save backup in the queue */
    const inst = state.installedTitles[0];
    if (inst) {
      const bg = state.gamesById.get(inst.gameId) || { id: inst.gameId, slug: 'save', title: inst.title, platform: 'PS5', titleIds: [inst.titleId], cover: inst.cover };
      const bj = state.makeJob(bg, { id: '', url: `file:///user/home/10000000/savedata_prospero/${inst.titleId}`, filename: `${inst.titleId}_ps5_${stamp(1800)}.zip`, format: 'ZIP', sizeBytes: 12.4 * MB, provider: 'Save data', sourceId: 'saves', mirrors: [] }, { root: '/data', type: 'backup', autoInstall: false, verify: 'none', kind: 'save' });
      bj.path = `/data/xeno-store/saves/XENOKING/${bj.filename}`; bj.state = 'done'; bj.written = bj.total; bj.segments = [[0, bj.total, bj.total]]; bj.finishedAt = now() - 1800; bj.titleId = inst.titleId; bj.title = inst.title || bg.title; bj.extract = { state: 'idle' };
      jobs.push(bj);
    }
    /* 7. a ZIP game archive being extracted right now */
    g = take((x) => direct(x));
    if (g) {
      const r = direct(g); const name = `${(g.titleIds || [])[0] || 'PPSA00000'} ${g.title} [FFPFSC].zip`;
      const zj = state.makeJob(g, { ...r, format: 'ZIP', filename: name, sizeBytes: Math.round(Math.max(4 * GB, (r.sizeBytes || 20 * GB) * 0.6)) }, { root: '/mnt/ext0', autoInstall: false, verify: 'size' });
      zj.state = 'extracting'; zj.written = zj.total; zj.segments.forEach((s) => { s[2] = s[1]; }); zj.finishedAt = now() - 60; zj.phase = 'extracting';
      zj.extract = { state: 'extracting', dir: `/mnt/ext0/homebrew/${name.replace(/\.zip$/i, '')}/`, message: 'Extracting 4 of 12 files', files: 12, bytes: Math.round(zj.total * 0.3), archiveDeleted: false };
      zj._extractStart = Date.now() - 2000; zj._extractUntil = Date.now() + 14000;
      jobs.push(zj); state.jlog(zj, 'download complete → extracting on the console');
    }
    /* 8. scheduled download (virtual: never enters the simulation until Start now) */
    g = take((x) => direct(x));
    if (g) {
      const r = direct(g);
      const root = state.rootOf('/mnt/ext0') || state.defaultRoot();
      virtual.push({ id: 'j_sched' + randomBytes(2).toString('hex'), gameId: g.id, title: g.title, titleId: (g.titleIds || [])[0] || '', platform: g.platform, cover: g.cover, releaseId: r.id, format: r.format, provider: r.provider || '', sourceId: r.sourceId || '', url: r.url, mirrors: (r.mirrors || []).slice(), filename: r.filename, root: root.path, rootLabel: root.label, path: `${root.path}/homebrew/${r.filename}`, state: 'queued', phase: '', message: 'Scheduled for 22:00', error: '', errorCode: '', total: r.sizeBytes || 0, written: 0, speed: 0, eta: 0, connections: 8, segments: [], sha256: '', sha256Expected: r.sha256 || '', verified: false, verify: 'size', addedAt: now() - 120, startedAt: 0, finishedAt: 0, attempts: 0, nextRetryAt: 0, priority: 9, autoInstall: false, install: { state: 'idle', message: '', contentId: '' }, resumable: true, etag: '', lastModified: '', type: 'download', group: '', groupOrder: 0, kind: 'game', via: '', turbo: { done: false, picked: '', tested: [] }, scheduledFor: '22:00', startNow: false, srcPath: '', move: false, extract: { state: 'idle' } });
      if (!state.settings.downloads.scheduleStart) { state.settings.downloads.scheduleStart = '22:00'; state.settings.downloads.scheduleEnd = '07:00'; }
    }
    log('info', `ext-b: seeded ${jobs.length} queue entries + ${virtual.length} scheduled, ${payloads.length} companion payloads`);
  }
}
