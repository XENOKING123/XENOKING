/*
 * XENO STORE — web/dev-server-ext-a.mjs: mock routes for the Phase 2 web features (part A).
 * Loaded by dev-server.mjs (every dev-server-ext-*.mjs is). Endpoints follow SPEC §17.2, §17.5, §17.13,
 * §17.14, §17.21 and §17.22.7:
 *   GET  /api/game/enrich?id=        GET /api/game/best?id=
 *   GET  /api/debrid · PUT /api/debrid · DELETE /api/debrid/{service}
 *   POST /api/queue/set              (install sets: base + update/dlc/backport as one group)
 *   GET  /api/homebrew[?refresh=1]   (+ HOMEBREW catalog entries, covers through /api/image)
 *   GET  /api/saves/store · POST /api/saves/store/{id}/install|download · GET /api/saves/engine
 *   GET  /api/saves/users · GET /api/saves?user= · POST /api/saves/export|upload|submit · GET /api/saves/installed-version
 *   /api/status extras: featured (hero/rows/banner/homebrew), messages, savesEngine
 */
import { randomBytes, createHash } from 'node:crypto';

export function register({ route, state }) {
  const { catalog, ApiError, sleep, now, hash32, GB, log } = state;
  const MB = 1e6;
  const tier = state.argValue('--saves-tier', 'native');
  const iso = (secAgo) => new Date(Date.now() - secAgo * 1000).toISOString();
  const sha = (s) => createHash('sha256').update(String(s)).digest('hex');
  const semver = (a, b) => { const pa = String(a || '').split('.'), pb = String(b || '').split('.'); for (let i = 0; i < Math.max(pa.length, pb.length); i++) { const x = parseInt(pa[i] || '0', 10) || 0, y = parseInt(pb[i] || '0', 10) || 0; if (x !== y) return x < y ? -1 : 1; } return 0; };
  const games = () => catalog.games.filter((g) => g.platform === 'PS5' || g.platform === 'PS4');

  /* ============================== debrid (§17.14) ============================== */
  const services = [
    { id: 'realdebrid', name: 'Real-Debrid', connected: !state.args.includes('--no-debrid'), user: 'xenoking', expires: iso(-40 * 86400), hosts: ['1fichier.com', 'mediafire.com', 'gofile.io', 'pixeldrain.com', 'buzzheavier.com'] },
    { id: 'alldebrid', name: 'AllDebrid', connected: false, user: '', expires: '', hosts: ['1fichier.com', 'mediafire.com', 'pixeldrain.com'] },
    { id: 'torbox', name: 'TorBox', connected: false, user: '', expires: '', hosts: ['1fichier.com', 'gofile.io'] },
    { id: 'premiumize', name: 'Premiumize', connected: false, user: '', expires: '', hosts: ['1fichier.com', 'mediafire.com'] }
  ];
  globalThis.XS_MOCK_DEBRID = services;
  const pubService = (s) => ({ id: s.id, name: s.name, connected: s.connected, user: s.user, expires: s.expires, hosts: s.hosts, apiKeyMasked: s.connected ? '••••••••' + hash32(s.id).toString(16).slice(0, 4) : '' });
  route('GET', /^\/api\/debrid$/, () => ({ ok: true, services: services.map(pubService) }));
  route('PUT', /^\/api\/debrid$/, async (q, body) => {
    const s = services.find((x) => x.id === body.service); if (!s) throw new ApiError(400, 'bad_service', 'Unknown debrid service');
    const key = String(body.apiKey || ''); if (key.length < 8) throw new ApiError(400, 'bad_key', `${s.name} rejected that API key`);
    await sleep(600); s.connected = true; s.user = 'user_' + hash32(key).toString(36).slice(0, 6); s.expires = iso(-30 * 86400); log('info', `debrid: ${s.name} connected`);
    return { ok: true, service: pubService(s) };
  });
  route('DELETE', /^\/api\/debrid\/([^/]+)$/, (q, body, m) => { const s = services.find((x) => x.id === m[1]); if (!s) throw new ApiError(404, 'not_found', 'Unknown debrid service'); s.connected = false; s.user = ''; s.expires = ''; return { ok: true }; });

  /* ============================== homebrew (§17.21) ============================== */
  const HB = [
    ['ps5-ftp', 'FTP Server', 'Tool', 'Sony-Hacks', '1.4.2', true], ['etahen-payload-mgr', 'Payload Manager', 'Tool', 'itsPLK', '2.0.1', true], ['shadowmount-plus', 'ShadowMountPlus', 'Tool', 'Scene Team', '1.03', true],
    ['retroarch-ps5', 'RetroArch', 'Emulator', 'libretro', '1.19.1', true], ['ppsspp-ps5', 'PPSSPP', 'Emulator', 'hrydgard', '1.17.1', true], ['duckstation-ps5', 'DuckStation', 'Emulator', 'stenzek', '0.1.7', true],
    ['flycast-ps5', 'Flycast', 'Emulator', 'flyinghead', '2.3', true], ['dolphin-ps4', 'Dolphin', 'Emulator', 'dolphin-emu', '5.0-19', false], ['mgba-ps5', 'mGBA', 'Emulator', 'endrift', '0.10.3', true],
    ['snes9x-ps5', 'Snes9x', 'Emulator', 'snes9xgit', '1.63', true], ['scummvm-ps5', 'ScummVM', 'Emulator', 'ScummVM Team', '2.8.1', true], ['mupen64-ps4', 'Mupen64Plus', 'Emulator', 'mupen64plus', '2.6.0', false],
    ['itemzflow', 'ItemzFlow', 'Tool', 'LightningMods', '1.26', true], ['ps5-backup-tool', 'Backup Tool', 'Tool', 'XENOKING', '1.1.0', true], ['xeno-tool-ps5', 'XENO TOOL', 'Tool', 'XENOKING', '3.2.0', true],
    ['ps5-dumper', 'App Dumper', 'Tool', 'idlesauce', '1.1', true], ['save-mounter-ps5', 'Save Mounter', 'Tool', 'ChendoChap', '1.5', true], ['garlic-saves', 'Garlic Save Manager', 'Tool', 'garlicsaves', '0.9.4', true],
    ['moonlight-ps5', 'Moonlight', 'Media', 'moonlight-stream', '1.0.1', true], ['vlc-ps4', 'VLC', 'Media', 'VideoLAN', '3.0.1', false], ['kodi-ps4', 'Kodi', 'Media', 'XBMC', '18.9', false],
    ['ps5-browser', 'Web Browser', 'Utility', 'Scene Team', '1.0', true], ['ps5-file-manager', 'File Manager', 'Utility', 'Scene Team', '2.2', true], ['remote-pkg-installer', 'Remote PKG Installer', 'Utility', 'flatz', '1.0.3', false],
    ['doom-ps5', 'Doom (Chocolate)', 'Game', 'chocolate-doom', '3.1.0', true], ['quake-ps5', 'Quake (vkQuake)', 'Game', 'Novum', '1.31', true], ['openlara-ps4', 'OpenLara', 'Game', 'XProger', '0.9', false],
    ['srb2-ps5', 'Sonic Robo Blast 2', 'Game', 'STJr', '2.2.13', true], ['cannonball-ps5', 'Cannonball', 'Game', 'djyt', '0.35', true], ['openttd-ps4', 'OpenTTD', 'Game', 'OpenTTD', '14.1', false],
    ['nethack-ps5', 'NetHack', 'Game', 'NetHack DevTeam', '3.7', true], ['pcsx2-ps5', 'PCSX2', 'Emulator', 'PCSX2 Team', '2.1.0', true], ['xemu-ps5', 'xemu', 'Emulator', 'xemu-project', '0.7.1', true],
    ['melonds-ps5', 'melonDS', 'Emulator', 'Arisotura', '0.9.5', true], ['citra-ps4', 'Citra', 'Emulator', 'Citra Team', 'nightly-2104', false], ['ps5-media-player', 'Media Player', 'Media', 'XENOKING', '1.0.2', true],
    ['ps5-screenshot-tool', 'Screenshot Tool', 'Utility', 'Scene Team', '1.0', true], ['ftp-sync', 'FTP Sync', 'Utility', 'XENOKING', '0.8', true], ['ps5-theme-mgr', 'Theme Manager', 'Utility', 'Scene Team', '1.2', true],
    ['pico8-ps5', 'PICO-8 Player', 'Game', 'fake08', '0.0.2', true], ['ps5-netcat', 'Netcat Loader', 'Tool', 'Scene Team', '1.0', true], ['uae4all-ps4', 'UAE4All (Amiga)', 'Emulator', 'Cpasjuste', '2.1', false]
  ];
  const apps = HB.map(([id, title, category, author, version, ps5], i) => {
    const x = hash32(id);
    const sizePs5 = Math.round((12 + (x % 180)) * MB), sizePs4 = Math.round((10 + ((x >>> 2) % 150)) * MB);
    const releases = [];
    if (ps5) releases.push({ id: `hb-${id}-ps5`, platform: 'PS5', url: `https://pkg-zone.com/download/ps5/${id}/latest`, filename: `${id}-ps5-v${version}.pkg`, format: 'PKG', kind: 'app', sizeBytes: sizePs5, version, provider: 'pkg-zone', sourceId: 'pkgzone', mirrors: [], sha256: '', md5: '', sha1: '', region: '', titleId: '', verifiedAt: '', consoleVerified: false, compat: '', password: '', notes: '', browserUrl: `https://pkg-zone.com/details/${id}`, addedAt: iso((x % 400) * 86400).slice(0, 10) });
    releases.push({ id: `hb-${id}-ps4`, platform: 'PS4', url: `https://pkg-zone.com/download/ps4/${id}/latest`, filename: `${id}-ps4-v${version}.pkg`, format: 'PKG', kind: 'app', sizeBytes: sizePs4, version, provider: 'pkg-zone', sourceId: 'pkgzone', mirrors: [], sha256: '', md5: '', sha1: '', region: '', titleId: '', verifiedAt: '', consoleVerified: false, compat: '', password: '', notes: '', browserUrl: `https://pkg-zone.com/details/${id}`, addedAt: iso((x % 400) * 86400).slice(0, 10) });
    const installedVersion = i === 1 ? '1.9.0' : i === 3 ? '1.19.1' : i === 14 ? '3.1.0' : '';
    return {
      id: `hb-${id}`, pkgId: id, title, category, author, version, supportsPs5: ps5, cover: `https://pkg-zone.com/images/${id}/cover.png`, details: `https://pkg-zone.com/details/${id}`,
      description: `${title} by ${author} — ${category.toLowerCase()} for the PS5 homebrew scene, packaged on pkg-zone.com.\n\nInstall it from XENO STORE: the PKG is downloaded to your default drive and installed with the console's package installer. ${ps5 ? 'A native PS5 build is available.' : 'Only a PS4 build is listed; it runs through backwards compatibility.'}`,
      changelog: `v${version}\n- Faster startup\n- Fixes reported on pkg-zone\n- ${ps5 ? 'PS5 build updated' : 'PS4 build refreshed'}`,
      size: ps5 ? sizePs5 : sizePs4, downloads: 500 + (x % 9000), updatedAt: iso((x % 400) * 86400 + 3600).slice(0, 10), releases, installedVersion, titleId: i === 14 ? 'XENO00001' : ''
    };
  });
  /* HOMEBREW catalog entries (§17.21: "become catalog entries with platform:"HOMEBREW"") */
  for (const a of apps) {
    catalog.games.push({ id: a.id, slug: a.pkgId, title: a.title, platform: 'HOMEBREW', titleIds: a.titleId ? [a.titleId] : [], region: '', genres: [], tagline: '', description: a.description, publisher: a.author, developer: a.author, author: a.author, category: a.category, supportsPs5: a.supportsPs5,
      releaseDate: '', addedAt: a.updatedAt, cover: a.cover, coverFallback: '', hero: '', heroFallback: '', artworkLayout: 'tall', tint: '#1a2a5a', sizeMin: Math.min(...a.releases.map((r) => r.sizeBytes)), sizeMax: Math.max(...a.releases.map((r) => r.sizeBytes)), featured: 0, popularity: 0, verified: false, compat: [], releases: a.releases, details: a.details, changelog: a.changelog, version: a.version });
  }
  state.imageMap.push([/^https:\/\/pkg-zone\.com\/images\/([^/]+)\/cover\.png$/, (m) => { const a = apps.find((x) => x.pkgId === m[1]); return state.mockArt(a ? a.id : m[1], 'icon', 'APP'); }]);
  route('GET', /^\/api\/homebrew$/, async (q) => {
    if (q.refresh === '1') { await sleep(900); log('info', 'homebrew: pkg-zone listing refreshed (mock)'); }
    return { ok: true, source: 'pkg-zone', cached: q.refresh !== '1', updatedAt: iso(q.refresh === '1' ? 0 : 2 * 86400), apps: apps.map((a) => ({ ...a })) };
  });

  /* ============================== /api/status extras (§17.1, §17.7, §17.22) ============================== */
  const featuredPool = () => games().filter((g) => g.platform === 'PS5' && g.cover).sort((a, b) => (b.popularity || 0) - (a.popularity || 0));
  state.statusExtra.push(() => {
    const pool = featuredPool();
    const ids = (from, n) => pool.slice(from, from + n).map((g) => g.id);
    return {
      featured: {
        hero: ids(0, 4),
        rows: [
          { title: { en: 'Staff picks', es: 'Selección del equipo', de: 'Team-Favoriten' }, ids: ids(4, 14) },
          { title: { en: 'Couch co-op weekend', es: 'Fin de semana cooperativo' }, ids: games().filter((g) => (g.features || []).indexOf('Co-op') >= 0).slice(0, 14).map((g) => g.id) }
        ],
        banner: state.args.includes('--featured-banner') ? { text: { en: 'New: community saves and backports are live in XENO STORE 1.0' }, url: 'https://github.com/XENOKING123/XENOKING' } : null,
        homebrew: ['hb-etahen-payload-mgr', 'hb-shadowmount-plus', 'hb-xeno-tool-ps5', 'hb-retroarch-ps5', 'hb-ps5-ftp', 'hb-itemzflow', 'hb-garlic-saves', 'hb-ppsspp-ps5']
      },
      messages: [{ id: 'm-2026-10-13', ts: now() - 3600, texts: { en: 'Catalog sync is back on a 6-hour schedule — report dead links from any game page.', es: 'La sincronización del catálogo vuelve cada 6 horas — reporta enlaces rotos desde la página del juego.' }, url: 'https://github.com/XENOKING123/XENOKING/issues' }],
      savesEngine: { tier, detail: tier === 'native' ? 'libSceSaveData.sprx resolved (host simulation)' : tier === 'garlic' ? 'Garlic Save Manager answering on 127.0.0.1:8082' : 'SaveData API unavailable — raw copy of /user/home/<uid>/savedata_prospero' }
    };
  });

  /* ============================== enrichment + best version (§17.2, §17.5) ============================== */
  route('GET', /^\/api\/game\/enrich$/, async (q) => {
    const g = state.gamesById.get(String(q.id || '')); if (!g) throw new ApiError(404, 'not_found', 'Unknown game');
    await sleep(250 + (hash32(g.id) % 400));
    if (!state.PHASE2) return { ok: true, cached: false, screenshots: [], about: '', developer: '', metacritic: null, features: [], languages: [] };
    return { ok: true, cached: hash32(g.id) % 2 === 0, screenshots: g.screenshots || [], about: g.about || '', developer: g.developer || '', publisher: g.publisher || '', metacritic: g.metacritic === undefined ? null : g.metacritic, features: g.features || [], languages: g.languages || [], ageRating: g.ageRating === undefined ? null : g.ageRating, releaseDate: g.releaseDate || '', hltb: hash32(g.id) % 3 ? 8 + (hash32(g.id) % 60) : null, players: hash32(g.id) % 4 === 0 ? '1-4' : '1' };
  });
  const fwNum = (s) => { const m = /(\d+)(?:\.(\d+))?/.exec(String(s || '')); return m ? parseFloat(m[1] + '.' + (m[2] || '0')) : 0; };
  const FW = 13.6;
  function bestOf(g) {
    const srcKind = (r) => (catalog.sources.find((s) => s.id === r.sourceId) || { kind: 'direct' }).kind;
    const pref = String(state.settings.downloads.preferFormat || 'auto').toUpperCase();
    const rank = (r) => [r.kind === 'update' || r.kind === 'dlc' ? 2 : r.kind === 'backport' ? 1 : 0, fwNum(r.requiresFw || r.compat) > FW ? 1 : 0, r.format === 'PAGE' ? 3 : srcKind(r) === 'direct' ? 0 : srcKind(r) === 'browser' ? 1 : 2, r.verifiedAt || r.consoleVerified || r.sha256 ? 0 : 1, pref !== 'AUTO' && String(r.format).toUpperCase() === pref ? 0 : 1];
    const rs = g.releases.slice().sort((a, b) => { const ra = rank(a), rb = rank(b); for (let i = 0; i < ra.length; i++) if (ra[i] !== rb[i]) return ra[i] - rb[i]; return semver(b.version, a.version) || ((a.sizeBytes || Infinity) - (b.sizeBytes || Infinity)); });
    const r = rs[0]; if (!r) return null;
    const reasons = [];
    if (fwNum(r.requiresFw || r.compat) <= FW) reasons.push({ code: 'compat', vars: { fw: '13.60' } });
    if (r.format !== 'PAGE' && srcKind(r) === 'direct') reasons.push({ code: r.verifiedAt ? 'verified' : 'direct' });
    if (r.sha256) reasons.push({ code: 'hash' });
    const same = rs.filter((x) => x.kind === r.kind);
    if (r.version && same.every((x) => semver(x.version, r.version) <= 0)) reasons.push({ code: 'newest', vars: { v: r.version } });
    if (r.sizeBytes && same.length > 1 && same.every((x) => !x.sizeBytes || x.sizeBytes >= r.sizeBytes)) reasons.push({ code: 'smallest', vars: { size: (r.sizeBytes / GB).toFixed(1) + ' GB' } });
    if (pref !== 'AUTO' && String(r.format).toUpperCase() === pref) reasons.push({ code: 'preferred', vars: { format: r.format } });
    if (same.length === 1) reasons.push({ code: 'onlyOne' });
    return { release: r, reasons, alternatives: rs.slice(1, 4).map((x) => x.id) };
  }
  route('GET', /^\/api\/game\/best$/, async (q) => {
    const g = state.gamesById.get(String(q.id || '')); if (!g) throw new ApiError(404, 'not_found', 'Unknown game');
    await sleep(200);
    const b = bestOf(g); if (!b) throw new ApiError(404, 'no_release', 'No downloads listed for this game');
    return { ok: true, fw: '13.60', releaseId: b.release.id, release: b.release, reasons: b.reasons, alternatives: b.alternatives };
  });

  /* ============================== install sets (§17.13) ============================== */
  route('POST', /^\/api\/queue\/set$/, (q, body) => {
    const g = state.gamesById.get(String(body.gameId || '')); if (!g) throw new ApiError(400, 'bad_release', 'Unknown game');
    const root = state.rootOf(body.root || state.settings.downloads.defaultRoot); if (!root || !root.writable) throw new ApiError(400, 'root_unavailable', 'That drive is not available');
    const items = Array.isArray(body.items) ? body.items : []; if (!items.length) throw new ApiError(400, 'bad_request', 'items[] is required');
    const order = String(state.settings.downloads.installOrder || 'game,backport,update,dlc').split(',').map((s) => s.trim());
    const group = 'g_' + randomBytes(3).toString('hex');
    const made = [];
    let total = 0;
    const resolved = items.map((it) => { const hit = state.releaseIndex.get(String(it.releaseId || '')); if (!hit) throw new ApiError(400, 'bad_release', `Unknown release ${it.releaseId}`); if (hit.r.format === 'PAGE') throw new ApiError(400, 'bad_release', 'A page cannot be queued'); total += hit.r.sizeBytes || 0; return { hit, kind: it.kind || hit.r.kind || 'game' }; });
    if (root.free - state.unfinishedOn(root.path) < total + 256 * 1024 * 1024) throw new ApiError(400, 'no_space', 'Not enough free space on that drive for the whole set');
    resolved.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
    resolved.forEach(({ hit, kind }, i) => {
      const job = state.makeJob(hit.g, hit.r, { root: root.path, connections: body.connections, verify: body.verify === 'none' ? 'none' : undefined, autoInstall: body.autoInstall, via: body.via, kind, group, groupOrder: i });
      const dup = state.jobs.find((j) => j.path === job.path && ['queued', 'connecting', 'downloading', 'verifying', 'paused', 'failed', 'installing'].indexOf(j.state) >= 0);
      if (dup) { if (!body.overwrite) throw new ApiError(409, 'already_queued', `${hit.r.filename || hit.r.id} is already in the queue`); state.jobs.splice(state.jobs.indexOf(dup), 1); }
      state.jobs.push(job); made.push(job);
      state.jlog(job, `install set ${group} step ${i + 1}/${resolved.length} (${kind})`);
    });
    log('info', `queued install set ${group}: ${made.length} jobs for ${g.title}`);
    return { ok: true, group, jobs: made.map((j) => state.publicJob(j)) };
  });

  /* ============================== Save Data Store (§17.22) ============================== */
  const USERS = [{ id: 268435456, name: 'XENOKING', foreground: true }, { id: 268435457, name: 'Guest', foreground: false }];
  const CATS = ['starter', 'platinum', 'checkpoint', 'modded', 'chapter', 'other'];
  const NAMES = { starter: ['Maxed starter — all weapons', 'NG+ ready, max money', 'Fresh start, every skill unlocked'], platinum: ['100% Platinum', 'All trophies — post-game', 'Platinum, every collectible'], checkpoint: ['Final boss checkpoint', 'Right before the hardest trophy', 'Secret boss, fully geared'], modded: ['Modded inventory (999 items)', 'Glitched out-of-bounds save', 'Infinite resources (modded)'], chapter: ['Chapter 4 start', 'Act 2 — mid game', 'Chapter 9, no side quests'], other: ['Speedrun practice save', 'Photo mode showcase', 'Co-op lobby ready'] };
  let saves = null;
  let installedVersions = null;
  function installedMap() {
    if (installedVersions) return installedVersions;
    installedVersions = new Map();
    for (const it of state.installedTitles) { const x = hash32(it.titleId); installedVersions.set(it.titleId, { version: `01.00${x % 6}.000`, region: ['EUR', 'USA', 'JPN'][x % 3] }); }
    return installedVersions;
  }
  function buildSaves() {
    if (saves) return saves;
    saves = [];
    const inst = state.installedTitles.map((it) => state.gamesById.get(it.gameId)).filter((g) => g && g.platform === 'PS5');
    const pool = inst.concat(games().filter((g) => g.platform === 'PS5' && (g.titleIds || []).length && inst.indexOf(g) < 0).sort((a, b) => (b.popularity || 0) - (a.popularity || 0)).slice(0, 26));
    let n = 0;
    for (const g of pool) {
      const x = hash32(g.id), tid = g.titleIds[0];
      const count = inst.indexOf(g) >= 0 ? 3 + (x % 3) : 1 + (x % 3);
      const iv = installedMap().get(tid);
      for (let i = 0; i < count; i++) {
        const cat = CATS[(x + i) % CATS.length];
        const y = hash32(g.id + i);
        const versions = iv ? [iv.version, iv.version, `01.00${(parseInt(iv.version.slice(3, 4), 10) + 1) % 10}.000`, `01.00${Math.max(0, parseInt(iv.version.slice(3, 4), 10) - 1)}.000`] : ['01.002.000', '01.004.000', '01.000.000', ''];
        const otherRegion = i === 2 && (g.titleIds[1] || y % 4 === 0);
        saves.push({
          id: 'sv_' + y.toString(16).padStart(8, '0'), titleId: otherRegion ? (g.titleIds[1] || tid.replace(/\d{2}$/, (m) => String(99 - Number(m)).padStart(2, '0'))) : tid, gameId: g.id, title: g.title, category: cat,
          name: NAMES[cat][y % 3], description: `${NAMES[cat][y % 3]} for ${g.title}. Made on a retail console with the game fully updated at the time. Load it from the in-game menu after installing; it carries no account data.`,
          author: ['nova', 'kai_ps5', 'xeno_fan', 'sakura', 'bitwise', 'mariano', 'lina'][y % 7], gameVersion: versions[y % versions.length], region: otherRegion ? 'USA' : (iv ? iv.region : ['EUR', 'USA', 'JPN'][y % 3]), dirName: y % 3 ? 'SAVEDATA00' : `SAVEDATA0${y % 5}`,
          size: Math.round((0.4 + (y % 80) / 10) * MB), sha256: sha('save:' + y), url: `https://pixeldrain.com/api/file/${y.toString(36)}`, mirror: '', format: y % 5 === 0 ? 'garlic-zip' : 'xeno-save-zip', source: y % 5 === 0 ? 'garlic' : 'xeno',
          createdAt: iso((y % 60) * 86400 + (y % 3600)), downloads: y % 900, status: 'published', tags: [['ng+', 'max money'], ['platinum', 'trophies'], ['boss', 'checkpoint'], ['modded'], ['chapter'], ['speedrun']][(y >> 1) % 6], screenshot: '',
          cover: `https://xenoking.supabase.co/storage/v1/object/sign/ps5-saves/${tid}/${y.toString(36)}-cover.png?token=mock`
        });
        n++;
      }
    }
    log('info', `saves: ${n} community saves generated for ${pool.length} games`);
    return saves;
  }
  state.imageMap.push([/^https:\/\/xenoking\.supabase\.co\/storage\/v1\/object\/sign\/ps5-saves\/([^/]+)\/([^/?]+)-cover\.png/, (m) => { const s = buildSaves().find((x) => x.titleId === m[1] && x.url.endsWith('/' + m[2])); return state.mockArt(s ? s.gameId : m[1], 'icon', 'SAVE'); }]);
  function compat(s) {
    const g = state.gamesById.get(s.gameId);
    const installed = state.installedTitles.find((it) => (g && g.titleIds.indexOf(it.titleId) >= 0) || it.titleId === s.titleId);
    if (!installed) return { status: 'notInstalled', installedVersion: '' };
    if (installed.titleId !== s.titleId) return { status: 'region', installedVersion: installedMap().get(installed.titleId).version, installedTitleId: installed.titleId };
    const iv = installedMap().get(installed.titleId);
    if (!s.gameVersion || !iv) return { status: 'unknown', installedVersion: iv ? iv.version : '' };
    const c = semver(s.gameVersion, iv.version);
    return { status: c === 0 ? 'ok' : c > 0 ? 'update' : 'newer', installedVersion: iv.version };
  }
  const pubSave = (s) => ({ ...s, compat: compat(s) });
  route('GET', /^\/api\/saves\/store$/, async (q) => {
    await sleep(300);
    let list = buildSaves().filter((s) => s.status === 'published');
    if (q.titleId || q.gameId) { const g = q.gameId ? state.gamesById.get(q.gameId) : null; list = list.filter((s) => s.titleId === q.titleId || (g && s.gameId === g.id) || (q.gameId && s.gameId === q.gameId)); }
    if (q.category) list = list.filter((s) => s.category === q.category);
    if (q.q) { const needle = String(q.q).toLowerCase(); list = list.filter((s) => (s.title + ' ' + s.name + ' ' + s.titleId + ' ' + s.author).toLowerCase().indexOf(needle) >= 0); }
    return { ok: true, backend: ['github', 'supabase'], saves: list.map(pubSave) };
  });
  route('GET', /^\/api\/saves\/engine$/, () => ({ ok: true, tier, detail: tier === 'native' ? 'libSceSaveData.sprx resolved (host simulation)' : tier === 'garlic' ? 'Garlic Save Manager answering on 127.0.0.1:8082' : 'SaveData API unavailable — raw copy, same console only' }));
  route('GET', /^\/api\/saves\/users$/, () => ({ ok: true, users: USERS }));
  route('GET', /^\/api\/saves\/installed-version$/, (q) => { const it = state.installedTitles.find((x) => x.titleId === q.titleId); const iv = it ? installedMap().get(it.titleId) : null; return { ok: true, titleId: q.titleId || '', installed: !!it, version: iv ? iv.version : '', region: iv ? iv.region : '' }; });
  route('GET', /^\/api\/saves$/, async (q) => {
    const user = USERS.find((u) => String(u.id) === String(q.user)) || USERS[0];
    await sleep(400);
    const list = state.installedTitles.filter((it) => /^PPSA/.test(it.titleId)).map((it) => {
      const x = hash32(it.titleId + user.id), g = state.gamesById.get(it.gameId), iv = installedMap().get(it.titleId);
      const dirs = Array.from({ length: 1 + (x % 3) }, (_, i) => ({ name: i === 0 ? 'SAVEDATA00' : `SAVEDATA0${i}`, size: Math.round((0.3 + (x % 50) / 10) * MB) + i * 200000, mtime: now() - (x % 20) * 86400 - i * 3600 }));
      return { titleId: it.titleId, gameId: it.gameId, title: it.title || (g ? g.title : ''), cover: it.cover || (g ? g.cover : ''), path: `/user/home/${user.id.toString(16)}/savedata_prospero/${it.titleId}`, size: dirs.reduce((n, d) => n + d.size, 0), mtime: dirs[0].mtime, kind: 'ps5', version: iv ? iv.version : '', region: iv ? iv.region : '', dirs };
    });
    return { ok: true, user: user.id, saves: list };
  });
  const saveJob = (s, type, root) => {
    const g = state.gamesById.get(s.gameId) || { id: s.gameId, slug: s.titleId.toLowerCase(), title: s.title, platform: 'PS5', titleIds: [s.titleId], cover: '' };
    const safe = (s.title || s.titleId).replace(/[^\w\s.-]/g, '').trim().slice(0, 60);
    const job = state.makeJob(g, { id: s.id, url: s.url, filename: `${s.titleId} ${safe} - ${s.name.replace(/[^\w\s.-]/g, '').slice(0, 40)}.zip`, format: 'ZIP', sizeBytes: s.size, sha256: s.sha256, provider: s.source === 'garlic' ? 'Garlic Save DB' : 'XENO community', sourceId: 'saves', mirrors: s.mirror ? [s.mirror] : [] }, { root: root.path, verify: 'sha256', type, kind: 'save' });
    job.path = `${root.path}/xeno-store/saves/${type === 'save-install' ? 'incoming' : 'community'}/${safe}/${job.filename}`;
    job.cover = s.cover; job.connections = 2; job.segments = [[0, job.total, 0]];
    return job;
  };
  route('POST', /^\/api\/saves\/store\/([^/]+)\/install$/, async (q, body, m) => {
    const s = buildSaves().find((x) => x.id === m[1]); if (!s) throw new ApiError(404, 'not_found', 'Unknown save');
    const user = USERS.find((u) => String(u.id) === String(body.user)); if (!user) throw new ApiError(400, 'bad_user', 'Pick a console profile');
    const root = state.defaultRoot();
    const job = saveJob(s, 'save-install', root);
    job.message = body.backupFirst ? `Backs up the current save of ${s.titleId} first` : '';
    job.install = { state: 'idle', message: '', contentId: '' };
    state.jobs.push(job); s.downloads++;
    log('info', `save install queued: ${s.name} (${s.titleId}) for ${user.name}${body.backupFirst ? ' with backup' : ''}`);
    return { ok: true, job: state.publicJob(job), engine: tier };
  });
  route('POST', /^\/api\/saves\/store\/([^/]+)\/download$/, (q, body, m) => {
    const s = buildSaves().find((x) => x.id === m[1]); if (!s) throw new ApiError(404, 'not_found', 'Unknown save');
    const root = state.defaultRoot();
    const job = saveJob(s, 'save-download', root); state.jobs.push(job); s.downloads++;
    return { ok: true, job: state.publicJob(job) };
  });
  route('POST', /^\/api\/saves\/export$/, async (q, body) => {
    const tid = String(body.titleId || ''); if (!/^PPSA\d{5}$/.test(tid)) throw new ApiError(400, 'bad_title', 'PS5 title IDs only (PPSA)');
    const dir = String(body.dirName || 'SAVEDATA00'); if (!/^[\w.-]{1,32}$/.test(dir)) throw new ApiError(400, 'bad_dir', 'Bad save folder name');
    await sleep(1200);
    const it = state.installedTitles.find((x) => x.titleId === tid); const iv = installedMap().get(tid) || { version: '', region: '' };
    const x = hash32(tid + dir);
    const files = ['SAVEDATA.bin', 'profile.dat', 'slot0.sav', 'sce_sys/param.sfo', 'sce_sys/icon0.png'].slice(0, 3 + (x % 3)).map((p, i) => ({ path: p, size: 4096 + ((x >> i) % 2000000), sha256: sha(tid + dir + p) }));
    const size = files.reduce((n, f) => n + f.size, 0);
    const zipPath = `/data/xeno-store/saves/export/${tid}_${dir}_${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')}.zip`;
    log('info', `save export: ${tid}/${dir} → ${zipPath} (${files.length} files, ${size} bytes, engine ${tier})`);
    return { ok: true, zipPath, size, sha256: sha(zipPath), engine: tier, manifest: { titleId: tid, dirName: dir, gameVersion: iv.version, region: iv.region, files, accountIdStripped: true, createdBy: `XENO STORE ${state.VERSION}`, title: it ? it.title : '' } };
  });
  route('POST', /^\/api\/saves\/upload$/, async (q, body) => {
    const zipPath = String(body.zipPath || ''); if (!zipPath.startsWith('/data/xeno-store/saves/')) throw new ApiError(400, 'bad_path', 'Only exported zips can be uploaded');
    const host = ['pixeldrain', 'catbox', 'custom'].indexOf(body.host) >= 0 ? body.host : 'pixeldrain';
    await sleep(2000);
    const id = randomBytes(5).toString('hex');
    const url = host === 'pixeldrain' ? `https://pixeldrain.com/api/file/${id}` : host === 'catbox' ? `https://files.catbox.moe/${id}.zip` : `${state.settings.saves && state.settings.saves.uploadEndpoint ? state.settings.saves.uploadEndpoint : 'https://example.invalid/files'}/${id}.zip`;
    log('info', `save upload: ${zipPath} → ${url}`);
    return { ok: true, url, host, sha256: sha(zipPath), size: 1200000 + (hash32(zipPath) % 9000000) };
  });
  route('POST', /^\/api\/saves\/submit$/, async (q, body) => {
    const tid = String(body.titleId || ''); if (!/^PPSA\d{5}$/.test(tid)) throw new ApiError(400, 'bad_title', 'PS5 title IDs only (PPSA)');
    if (!body.name || !String(body.name).trim()) throw new ApiError(400, 'bad_request', 'A name is required');
    if (CATS.indexOf(body.category) < 0) throw new ApiError(400, 'bad_request', 'Pick a category');
    if (!body.nickname || !String(body.nickname).trim()) throw new ApiError(400, 'bad_request', 'A nickname is required');
    if (String(body.description || '').length > 300) throw new ApiError(400, 'bad_request', 'Description over 300 characters');
    await sleep(500);
    const x = hash32(JSON.stringify(body) + Date.now());
    const g = state.gamesById.get(body.gameId) || state.gamesById.get((state.installedTitles.find((it) => it.titleId === tid) || {}).gameId);
    const record = { id: 'sv_' + x.toString(16).padStart(8, '0'), titleId: tid, gameId: g ? g.id : (body.gameId || ''), title: body.title || (g ? g.title : tid), category: body.category, name: String(body.name).trim().slice(0, 80), description: String(body.description || '').trim(), author: String(body.nickname).trim().slice(0, 32), gameVersion: body.gameVersion || '', region: body.region || '', dirName: body.dirName || 'SAVEDATA00', size: Number(body.size) || 0, sha256: body.sha256 || '', url: body.url || '', mirror: '', format: 'xeno-save-zip', source: 'xeno', createdAt: new Date().toISOString(), downloads: 0, status: 'pending', tags: Array.isArray(body.tags) ? body.tags.slice(0, 10) : [], screenshot: '', cover: '' };
    buildSaves().push(record);
    const json = JSON.stringify({ titleId: record.titleId, gameId: record.gameId, title: record.title, category: record.category, name: record.name, description: record.description, tags: record.tags, author: record.author, gameVersion: record.gameVersion, region: record.region, dirName: record.dirName, size: record.size, sha256: record.sha256, url: record.url }, null, 2);
    const issueUrl = `https://github.com/XENOKING123/XENOKING/issues/new?template=save-submission.md&title=${encodeURIComponent('[save] ' + record.title + ' — ' + record.name)}&body=${encodeURIComponent('```json\n' + json + '\n```')}`;
    log('info', `save submitted: ${record.name} (${tid}) by ${record.author} → GitHub issue`);
    return { ok: true, backend: 'github', status: 'pending', id: record.id, issueUrl };
  });
}
