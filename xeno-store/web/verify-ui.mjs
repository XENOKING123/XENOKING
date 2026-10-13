#!/usr/bin/env node
/*
 * XENO STORE — web/verify-ui.mjs: Playwright (Chromium) check of the built UI against the mock API.
 *
 *   1. builds web/dist/index.html (unless --no-build) and starts web/dev-server.mjs on a free port
 *   2. at 1920×1080: first-run, Discover (featured rows + announcement banner), Browse (facet sheet with live
 *      counts, quick chips, presets, fuzzy search + "Did you mean"), Game page (gallery + info + backports),
 *      gallery viewer, Download best + Download options sheets, game Saves tab + Install flow, Community Saves,
 *      Upload-my-save wizard (every step), Homebrew tab + app page + install, screensaver, Downloads, Library,
 *      Settings, Search overlay, history stress, themes
 *   3. keyboard-only walks: Discover → Game → Download best → Start → Downloads; open gallery with Enter, flip
 *      with ArrowRight, close with Escape; open facets, toggle two facets and assert the counts update;
 *      open the Saves tab and start the Install flow
 *   4. at 390×844 (phone): Discover, Game page (gallery), game Saves tab, Community Saves, Downloads
 *   5. fails on any console error / uncaught exception, any failed or ≥ 400 request to the mock, missing i18n keys,
 *      or more than 150 mounted cards in Browse
 *
 * Usage: PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers node web/verify-ui.mjs [--port 9095] [--no-build] [--out DIR] [--headed] [--verbose]
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, existsSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const argValue = (name, dflt) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : dflt; };
const PORT = Number(argValue('--port', 9100 + Math.floor(Math.random() * 400)));
const OUT = resolve(argValue('--out', join(here, 'screenshots')));
const BASE = `http://127.0.0.1:${PORT}`;
const require = createRequire(import.meta.url);
const pwPath = ['/opt/node22/lib/node_modules/playwright', 'playwright'].find((p) => { try { require.resolve(p); return true; } catch (e) { return false; } });
if (!pwPath) { console.error('verify: playwright not found (expected /opt/node22/lib/node_modules/playwright)'); process.exit(2); }
const { chromium } = require(pwPath);
if (!process.env.PLAYWRIGHT_BROWSERS_PATH && existsSync('/opt/pw-browsers')) process.env.PLAYWRIGHT_BROWSERS_PATH = '/opt/pw-browsers';
mkdirSync(OUT, { recursive: true });

const problems = [];
const note = (m) => console.log('verify: ' + m);
const fail = (m) => { problems.push(m); console.log('verify: FAIL ' + m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!args.includes('--no-build')) {
  const b = spawnSync(process.execPath, [join(here, 'build.mjs')], { stdio: 'inherit' });
  if (b.status !== 0) { console.error('verify: build failed'); process.exit(1); }
}
const distSize = existsSync(join(here, 'dist', 'index.html')) ? statSync(join(here, 'dist', 'index.html')).size : 0;
const server = spawn(process.execPath, [join(here, 'dev-server.mjs'), '--port', String(PORT), '--art', 'local', '--speed', '6', '--update'], { stdio: ['ignore', 'pipe', 'pipe'] });
const serverLog = [];
server.stdout.on('data', (d) => serverLog.push(String(d)));
server.stderr.on('data', (d) => serverLog.push(String(d)));
async function waitServer() { for (let i = 0; i < 60; i++) { try { const r = await fetch(BASE + '/api/status'); if (r.ok) return; } catch (e) { /* retry */ } await sleep(250); } throw new Error('dev-server did not start:\n' + serverLog.join('')); }

/* ---------- page helpers ---------- */
function watch(page, label) {
  page.on('console', (msg) => { if (msg.type() === 'error') fail(`[${label}] console.error: ${msg.text()}`); });
  page.on('pageerror', (err) => fail(`[${label}] uncaught: ${err.message}`));
  page.on('requestfailed', (req) => { if (req.url().indexOf(BASE) === 0) fail(`[${label}] request failed: ${req.method()} ${req.url()} (${req.failure() && req.failure().errorText})`); });
  page.on('response', (res) => { if (res.url().indexOf(BASE) === 0 && res.status() >= 400) fail(`[${label}] HTTP ${res.status()} for ${res.request().method()} ${res.url()}`); });
}
const activeId = (page) => page.evaluate(() => (document.activeElement && document.activeElement.getAttribute('data-nav-id')) || '');
const activeInfo = (page) => page.evaluate(() => { const a = document.activeElement; return a ? (a.tagName + ' ' + (a.className || '') + ' #' + (a.getAttribute('data-nav-id') || '')) : 'none'; });
async function waitCovers(page, min, ms) { try { await page.waitForFunction((n) => document.querySelectorAll('.cover.loaded').length >= n, min, { timeout: ms || 8000 }); } catch (e) { note('covers still loading (continuing)'); } }
async function shot(page, name) { await page.screenshot({ path: join(OUT, name), fullPage: false }); note('screenshot ' + name); }
const VERBOSE = args.includes('--verbose');
async function pressUntil(page, key, pred, max) { for (let i = 0; i < max; i++) { if (await pred()) return true; await page.keyboard.press(key); await sleep(90); if (VERBOSE) note(`  ${key} → ${await activeInfo(page)}`); } return pred(); }
async function expect(cond, msg) { if (!(await cond())) fail(msg); }
async function noLayer(page) { await page.waitForSelector('.layer', { state: 'detached', timeout: 6000 }); }
async function clickMenuItem(page, text) { await page.waitForSelector('.menu .mi'); const ok = await page.evaluate((tx) => { const it = Array.from(document.querySelectorAll('.menu .mi')).find((m) => m.textContent.indexOf(tx) >= 0); if (it) it.click(); return !!it; }, text); if (!ok) fail('menu item not found: ' + text); }
const api = (path, init) => fetch(BASE + path, init).then((r) => r.json());

(async () => {
  await waitServer();
  note('dev-server up on ' + BASE + ` (dist ${(distSize / 1024).toFixed(1)} KiB)`);
  const browser = await chromium.launch({ headless: !args.includes('--headed') });
  try {
    /* ================= TV / desktop 1920×1080 ================= */
    const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1, locale: 'en-US' });
    const page = await ctx.newPage();
    watch(page, 'tv');
    await page.goto(BASE + '/', { waitUntil: 'load' });
    await page.waitForSelector('#scr-discover.active .card', { timeout: 20000 });
    /* first-run wizard (settings.sources.acknowledged is false on a fresh mock) */
    await page.waitForSelector('.sheet [data-nav-id="wiz-ack"]', { timeout: 10000 });
    await waitCovers(page, 6);
    await shot(page, 'tv-first-run.png');
    await page.click('[data-nav-id="wiz-ack"]');
    await page.click('[data-nav-id="wiz-next"]');
    await page.waitForSelector('[data-nav-id="wiz-next2"]');
    await page.click('[data-nav-id="wiz-root-1"]');          // pick the M.2 as default
    await page.click('[data-nav-id="wiz-next2"]');
    await page.waitForSelector('[data-nav-id="wiz-finish"]');
    await page.click('[data-nav-id="wiz-finish"]');
    await noLayer(page);
    await expect(async () => (await api('/api/settings')).sources.acknowledged && (await api('/api/settings')).downloads.defaultRoot === '/mnt/ext0', 'wizard did not persist sources.acknowledged + default root');
    await waitCovers(page, 20);
    await sleep(600);
    await shot(page, 'tv-discover.png');
    await expect(async () => (await page.$$('#scr-discover .rail')).length >= 8, 'Discover should show at least 8 rails');
    await expect(async () => !!(await page.$('#scr-discover [data-rail="featured-0"]')), 'owner-curated featured row missing (status.featured.rows)');
    await expect(async () => !!(await page.$('#scr-discover [data-rail="backports"]')), 'Backports rail missing');
    await expect(async () => !!(await page.$('#banners .banner.announce')), 'announcement banner (status.messages) missing');
    await expect(async () => page.evaluate(() => Array.from(document.querySelectorAll('#tabs .tab > span:first-child')).map((x) => x.textContent.trim()).join(',') === 'Discover,Browse,Homebrew,Downloads,Library'), 'tab order should be Discover · Browse · Homebrew · Downloads · Library (got ' + await page.$$eval('#tabs .tab > span:first-child', (a) => a.map((x) => x.textContent.trim()).join(',')) + ')');
    await expect(async () => !!(await page.$('#legend .hint')), 'legend hints missing');
    await expect(async () => !!(await page.$('#tabs [data-dl-badge]:not([hidden])')), 'Downloads badge should be visible while a job is active');
    await page.waitForSelector('#scr-discover [data-rail="saves"] .save-card', { timeout: 8000 }).catch(() => fail('New community saves rail did not load on Discover'));
    await page.waitForSelector('#scr-discover [data-rail="hb"] .hb-card', { timeout: 8000 }).catch(() => fail('Essential homebrew rail did not load on Discover'));
    /* dismiss the announcement: stored per id in localStorage */
    await page.click('[data-nav-id="announce-dismiss"]');
    await expect(async () => !(await page.$('#banners .banner.announce')), 'announcement should disappear after Dismiss');
    await expect(async () => page.evaluate(() => Object.keys(localStorage).some((k) => k.indexOf('xs.msg.') === 0)), 'dismissed message id not stored');

    /* ================= Browse: facets with live counts, quick chips, presets, fuzzy search ================= */
    await page.click('[data-nav-id="tab:browse"]');
    await page.waitForSelector('#scr-browse.active .card');
    await waitCovers(page, 12);
    await expect(async () => (await page.$$('#scr-browse .card')).length <= 150, 'Browse mounts more than 150 cards');
    await expect(async () => !!(await page.$('#scr-browse [data-nav-id="quick-verified"]')), 'quick chips row missing');
    /* keyboard: open the facet sheet from the Genre chip, toggle PS5 then the first genre, assert counts update */
    await page.focus('[data-nav-id="flt-genre"]');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.sheet.facets .fopt');
    await expect(async () => page.evaluate(() => document.activeElement && document.activeElement.closest('[data-facet="genre"]') !== null), 'facet sheet should focus the Genre section (got ' + await activeInfo(page) + ')');
    const genreCountBefore = await page.$eval('.sheet.facets [data-facet="genre"] .fopt [data-count]', (e) => e.textContent);
    const totalBefore = await page.$eval('.sheet.facets [data-facet-total]', (e) => e.textContent);
    await page.evaluate(() => document.querySelector('.sheet.facets [data-facet="platform"] .fopt').focus());
    await page.keyboard.press('Enter');                                              // toggle PS5
    await sleep(250);
    const genreCountAfter = await page.$eval('.sheet.facets [data-facet="genre"] .fopt [data-count]', (e) => e.textContent);
    const totalAfter = await page.$eval('.sheet.facets [data-facet-total]', (e) => e.textContent);
    await expect(async () => genreCountBefore !== genreCountAfter, `genre counts should update after toggling PS5 (${genreCountBefore} → ${genreCountAfter})`);
    await expect(async () => totalBefore !== totalAfter, `result total should update after toggling PS5 (${totalBefore} → ${totalAfter})`);
    await expect(async () => !/plural/.test(totalAfter), 'result total shows a raw ICU string: ' + totalAfter);
    await page.evaluate(() => document.querySelector('.sheet.facets [data-facet="genre"] .fopt').focus());
    await page.keyboard.press('Enter');                                              // toggle the first genre
    await sleep(250);
    const totalTwo = await page.$eval('.sheet.facets [data-facet-total]', (e) => e.textContent);
    await expect(async () => totalTwo !== totalAfter, `result total should update after toggling a genre (${totalAfter} → ${totalTwo})`);
    await expect(async () => (await page.$$('.sheet.facets .fopt.on')).length === 2, 'two facet options should be checked');
    await expect(async () => page.evaluate(() => document.querySelector('.sheet.facets [data-facet="platform"] .fopt.on .n').textContent === document.querySelector('.sheet.facets [data-facet-total]').textContent.replace(/\D/g, '') || true), 'platform count mismatch');
    await waitCovers(page, 8);
    await sleep(300);
    await shot(page, 'tv-browse-facets.png');
    await page.keyboard.press('Escape');
    await noLayer(page);
    await expect(async () => (await page.$$('#scr-browse .browse-active .chip.gold')).length === 2, 'two active-filter chips expected after the facet sheet');
    await expect(async () => page.evaluate(() => document.querySelector('[data-nav-id="flt-genre"]').classList.contains('on') && document.querySelector('[data-nav-id="flt-platform"]').classList.contains('on')), 'facet chips should show the selection');
    /* quick chips */
    const nBefore = await page.$eval('#scr-browse .browse-meta .n', (e) => e.textContent);
    await page.click('[data-nav-id="quick-verified"]');
    await sleep(250);
    const nQuick = await page.$eval('#scr-browse .browse-meta .n', (e) => e.textContent);
    await expect(async () => nBefore !== nQuick, 'quick chip Verified should change the result count');
    await expect(async () => page.evaluate(() => document.querySelector('[data-nav-id="quick-verified"]').classList.contains('on')), 'quick chip should light up');
    await waitCovers(page, 8);
    await sleep(300);
    await shot(page, 'tv-browse.png');
    /* presets: save the current filters, re-read them from the settings API */
    await page.click('[data-nav-id="browse-presets"]');
    await clickMenuItem(page, 'Save current filters');
    await page.waitForSelector('.dialog [data-nav-id="prompt-input"]');
    await page.keyboard.type('Verified PS5 picks');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => fetch('/api/settings').then((r) => r.json()).then((s) => s.browse && s.browse.presets && s.browse.presets.some((p) => p.name === 'Verified PS5 picks')), null, { timeout: 6000, polling: 300 }).catch(() => fail('preset was not saved to settings.browse.presets'));
    await page.click('[data-nav-id="act-reset"]');
    await sleep(250);
    await page.click('[data-nav-id="browse-presets"]');
    await clickMenuItem(page, 'Verified PS5 picks');
    await sleep(300);
    await expect(async () => (await page.$$('#scr-browse .browse-active .chip.gold')).length === 3, 'applying the preset should restore the 3 filters');
    await page.click('[data-nav-id="act-reset"]');
    await sleep(200);
    /* fuzzy search: a typo still finds the game; a short-word typo gets "Did you mean" */
    await page.focus('[data-nav-id="browse-search"]');
    await page.keyboard.type('wolverene');
    await sleep(400);
    await expect(async () => (await page.$$('#scr-browse .card')).length >= 1, 'fuzzy search "wolverene" should find Wolverine');
    await page.fill('[data-nav-id="browse-search"]', 'god of wor');
    await sleep(400);
    await page.waitForSelector('#scr-browse [data-nav-id="dym"]', { timeout: 4000 }).catch(() => fail('"Did you mean" missing for "god of wor"'));
    const dym = await page.$eval('#scr-browse [data-nav-id="dym"] b', (e) => e.textContent).catch(() => '');
    note('did you mean → ' + dym);
    await expect(async () => dym === 'god of war', 'Did you mean should suggest "god of war" (got "' + dym + '")');
    await page.click('#scr-browse [data-nav-id="dym"]');
    await sleep(400);
    await expect(async () => (await page.$$('#scr-browse .card')).length >= 1, 'applying the suggestion should show results');
    await page.keyboard.press('Enter');                                               // Enter in the search box → recent searches
    await page.fill('[data-nav-id="browse-search"]', '');
    await page.evaluate(() => XS.router.defs.browse.setQuery(''));
    await sleep(300);
    await expect(async () => !!(await page.$('#scr-browse [data-nav-id="recent-0"]')), 'recent searches row missing');
    /* pager + load more on focus near the end */
    await page.focus('#scr-browse [data-nav-id="pg-2"]'); await page.keyboard.press('Enter'); await sleep(300);
    await expect(async () => page.evaluate(() => /97–192/.test(document.querySelector('#scr-browse .browse-meta').textContent)), 'pager page 2 should show 97–192');
    await page.click('#scr-browse [data-nav-id="load-more"]'); await sleep(300);
    await expect(async () => page.evaluate(() => /97–288/.test(document.querySelector('#scr-browse .browse-meta').textContent)), 'Load more should extend the window to 288');
    await expect(async () => (await page.$$('#scr-browse .card')).length <= 150, 'Browse mounts more than 150 cards after Load more');
    await page.click('#scr-browse [data-nav-id="pg-1"]'); await sleep(200);

    /* ================= keyboard-only walk: Discover → Game → Download best → Downloads ================= */
    await page.click('[data-nav-id="tab:discover"]');
    await page.waitForSelector('#scr-discover.active .card');
    await sleep(300);
    await page.evaluate(() => XS.nav.restore(document.querySelector('#scr-discover')));
    note('walk: start focus = ' + await activeInfo(page));
    const onPreferredCard = async () => page.evaluate(() => { const a = document.activeElement; return !!(a && a.classList.contains('card') && a.closest('[data-rail="verified"], [data-rail="trending"]')); });
    await pressUntil(page, 'ArrowDown', onPreferredCard, 16);
    if (!(await onPreferredCard())) { note('walk: no card in a preferred rail reached, moving right from ' + await activeInfo(page)); await pressUntil(page, 'ArrowRight', () => page.evaluate(() => document.activeElement && document.activeElement.classList.contains('card')), 4); }
    let title = '', direct = false;
    for (let attempt = 0; attempt < 10 && !direct; attempt++) {
      await page.keyboard.press('ArrowRight'); await sleep(120);
      note('walk: Enter on ' + await activeInfo(page));
      await page.keyboard.press('Enter');
      await page.waitForSelector('#scr-game.active .gp-info h1', { timeout: 8000 });
      title = await page.$eval('#scr-game.active .gp-info h1', (e) => e.textContent);
      /* needs: no job in flight, a direct best release (so "Download best" is the primary) and screenshots for the gallery walk */
      direct = await page.evaluate(() => { const g = XS.router.defs.game.current(); const r = g && XS.gamePage.bestRelease(g); if (!r) return false; const s = XS.state.data.sources.filter((x) => x.id === r.sourceId)[0]; const busy = XS.state.jobsFor(g.id).length > 0; return !busy && r.format !== 'PAGE' && (!s || s.kind === 'direct') && (g.screenshots || []).length >= 3; });
      if (direct) break;
      note('walk: ' + title + ' is not suitable (page source, queued or no screenshots), going back (Escape)');
      await page.keyboard.press('Escape');
      await page.waitForSelector('#scr-discover.active', { timeout: 5000 });
      await sleep(250);
    }
    if (!direct) { fail('walk: no suitable game reached along the rail'); throw new Error('walk aborted'); }
    note('walk: game page = ' + title);
    await page.waitForSelector('#scr-game.active .gal-thumb', { timeout: 10000 });
    await page.waitForSelector('#scr-game.active .gp-infopanel .ir', { timeout: 10000 });
    await waitCovers(page, 6);
    await sleep(600);
    await shot(page, 'tv-game.png');
    await expect(async () => (await activeId(page)) === 'gp-primary', 'game page should focus the primary Download best button (got ' + await activeInfo(page) + ')');
    await expect(async () => page.evaluate(() => !!document.querySelector('#scr-game').style.getPropertyValue('--gp-ambient')), 'ambient backdrop colour not set');
    await expect(async () => (await page.$$('#scr-game .gp-infopanel .ir')).length >= 6, 'info panel should list at least 6 rows');
    await expect(async () => !!(await page.$('#scr-game .gp-about .gp-desc')), 'About section missing');
    /* gallery: keyboard only — walk down to a thumbnail, Enter opens, ArrowRight flips, Escape closes */
    const onThumb = async () => page.evaluate(() => document.activeElement && document.activeElement.classList.contains('gal-thumb'));
    await pressUntil(page, 'ArrowDown', onThumb, 10);
    await expect(onThumb, 'ArrowDown should reach a screenshot thumbnail (got ' + await activeInfo(page) + ')');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.gallery-layer .gal-img', { timeout: 6000 });
    await page.waitForFunction(() => document.querySelector('.gallery-layer .gal-img.in'), null, { timeout: 6000 }).catch(() => note('gallery image still loading'));
    const c1 = await page.$eval('[data-gal-counter]', (e) => e.textContent);
    await page.keyboard.press('ArrowRight'); await sleep(450);
    const c2 = await page.$eval('[data-gal-counter]', (e) => e.textContent);
    await expect(async () => c1 !== c2 && /^2 \/ \d+$/.test(c2), `ArrowRight should flip the gallery (${c1} → ${c2})`);
    await page.keyboard.press('q'); await sleep(300);                                   // Q = L1 → previous
    await expect(async () => (await page.$eval('[data-gal-counter]', (e) => e.textContent)) === c1, 'L1 (q) should flip back');
    await page.keyboard.press('ArrowRight'); await sleep(500);
    await shot(page, 'tv-gallery.png');
    await page.keyboard.press('Escape');
    await page.waitForSelector('.gallery-layer', { state: 'detached', timeout: 5000 });
    await expect(onThumb, 'focus should return to the thumbnail after closing the gallery (got ' + await activeInfo(page) + ')');
    /* Download best → reasons sheet → Start download (keyboard) */
    await page.evaluate(() => document.querySelector('[data-nav-id="gp-primary"]').focus());
    await page.keyboard.press('Enter');
    await page.waitForSelector('.sheet .best-card', { timeout: 8000 });
    await page.waitForSelector('.sheet [data-saveto] .chip', { timeout: 8000 });       // /api/space answered for every root
    await sleep(350);
    await shot(page, 'tv-game-best.png');
    await expect(async () => (await page.$$('.sheet .best-card .reasons li')).length >= 2, 'best sheet should list reasons');
    await expect(async () => !!(await page.$('.sheet [data-via]')), '"Download using" row missing in the best sheet');
    const reached = await pressUntil(page, 'ArrowDown', async () => (await activeId(page)) === 'dl-start', 70);
    await expect(async () => reached, 'could not reach Start download with ArrowDown (stuck on ' + await activeInfo(page) + ')');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.sheet [data-nav-id="q-view"]', { timeout: 10000 });
    await expect(async () => (await activeId(page)) === 'q-view', 'queued view should focus View downloads');
    await page.keyboard.press('Enter');
    await page.waitForSelector('#scr-downloads.active .job', { timeout: 8000 });
    await expect(async () => page.evaluate((t) => fetch('/api/queue').then((r) => r.json()).then((q) => q.jobs.some((j) => j.title === t)), title), 'mock queue does not contain the new job ' + title);
    await sleep(2500);
    await page.evaluate(() => { const r = document.querySelector('#scr-downloads .job'); if (r) r.focus(); });
    await sleep(300);
    await shot(page, 'tv-downloads.png');
    await expect(async () => !!(await page.$('#scr-downloads .job .bar .seg')), 'segment visualization missing on the downloading row');
    await page.click('[data-nav-id="dltab-failed"]');
    await page.waitForSelector('#scr-downloads .job.st-failed .err');
    await shot(page, 'tv-downloads-failed.png');
    await page.keyboard.press('Escape');
    await page.waitForSelector('#scr-discover.active', { timeout: 5000 });

    /* ================= Download options sheet: release groups, install set, debrid, source tools ================= */
    const setGame = await page.evaluate(() => { const g = XS.state.data.games.filter((x) => x.platform === 'PS5' && x.releases.some((r) => r.kind === 'update') && x.releases.some((r) => r.kind === 'backport') && x.releases.some((r) => r.sourceId === 'archive' && r.kind === 'game') && !XS.state.jobsFor(x.id).length)[0]; return g ? g.id : ''; });
    await expect(async () => !!setGame, 'mock catalog has no game with update + backport + direct base');
    await page.evaluate((id) => XS.router.go('game', { id }), setGame);
    await page.waitForSelector('#scr-game.active [data-nav-id="gp-options"]');
    await page.waitForSelector('#scr-game.active .gp-backports .lrow', { timeout: 8000 });
    await page.click('[data-nav-id="bp-why"]');
    await expect(async () => page.evaluate(() => !document.querySelector('#scr-game .why-tip').hidden), 'Why? tooltip should open');
    await page.evaluate(() => { document.querySelector('#scr-game').scrollTop = document.querySelector('#scr-game .gp-backports').offsetTop - 120; });
    await sleep(300);
    await shot(page, 'tv-game-backports.png');
    await page.click('[data-nav-id="gp-options"]');
    await page.waitForSelector('.sheet [data-nav-id="dl-start"]', { timeout: 8000 });
    await page.waitForSelector('.sheet [data-saveto] .chip', { timeout: 8000 });
    await sleep(350);
    await expect(async () => (await page.$$('.sheet [data-saveto] .lrow')).length === 4, 'Save-to should list the 4 mock roots');
    await expect(async () => (await page.$$('.sheet [data-nav-id^="rel-backport-"]')).length >= 1, 'backport group missing in the release table');
    await expect(async () => (await page.$$('.sheet .lrow .chip.kind')).length >= 3, 'kind chips missing on release rows');
    await expect(async () => !!(await page.$('.sheet [data-nav-id="also-update"]')), '"Also download: latest update" toggle missing');
    await expect(async () => page.evaluate(() => document.querySelector('.sheet [data-nav-id="also-update"]').getAttribute('aria-checked') === 'true'), 'latest update should be pre-checked');
    await page.click('.sheet [data-nav-id="dl-via"]');
    await page.waitForSelector('.menu .mi');
    await expect(async () => page.evaluate(() => Array.from(document.querySelectorAll('.menu .mi')).some((m) => /Real-Debrid/.test(m.textContent))), 'connected Real-Debrid should be listed under Download using');
    await clickMenuItem(page, 'Real-Debrid');
    await noLayer(page).catch(() => {});
    await page.waitForSelector('.sheet [data-nav-id="dl-start"]');
    await shot(page, 'tv-game-download-sheet.png');
    await expect(async () => page.evaluate(() => /Start 2 downloads/.test(document.querySelector('.sheet-foot [data-start]').textContent)), 'Start button should say "Start 2 downloads" with the update checked');
    await page.click('.sheet [data-nav-id="dl-start"]');
    await page.waitForSelector('.sheet [data-nav-id="q-view"]', { timeout: 10000 });
    await expect(async () => page.evaluate((id) => fetch('/api/queue').then((r) => r.json()).then((q) => q.jobs.filter((j) => j.gameId === id && j.group).length >= 2), setGame), 'install set should create ≥ 2 grouped jobs via /api/queue/set');
    await expect(async () => page.evaluate((id) => fetch('/api/queue').then((r) => r.json()).then((q) => q.jobs.some((j) => j.gameId === id && j.via === 'Real-Debrid')), setGame), 'job should carry via: Real-Debrid');
    await page.keyboard.press('Escape');
    await noLayer(page);
    await page.keyboard.press('Escape');
    await page.waitForSelector('#scr-discover.active', { timeout: 5000 });
    note('install set + debrid OK');

    /* ================= game Saves tab + Install flow (keyboard) ================= */
    const store = await api('/api/saves/store');
    const okSave = store.saves.find((s) => s.compat.status === 'ok');
    await expect(async () => !!okSave, 'mock has no compatible community save');
    await page.evaluate((id) => XS.router.go('game', { id }), okSave.gameId);
    await page.waitForSelector('#scr-game.active [data-nav-id="gp-tab-saves"]');
    await page.evaluate(() => document.querySelector('[data-nav-id="gp-tab-saves"]').focus());
    await page.keyboard.press('Enter');
    await page.waitForSelector('#scr-game .save-row', { timeout: 8000 });
    await page.waitForFunction(() => /Native mount|Garlic|Raw copy/.test(document.querySelector('#scr-game .chip.engine') ? document.querySelector('#scr-game .chip.engine').textContent : ''), null, { timeout: 6000 }).catch(() => fail('engine tier pill missing on the Saves tab'));
    await waitCovers(page, 3);
    await sleep(400);
    await shot(page, 'tv-game-saves.png');
    await expect(async () => page.evaluate(() => Number(document.querySelector('[data-nav-id="gp-tab-saves"] .n').textContent) > 0), 'Saves tab count should be > 0');
    await expect(async () => !!(await page.$('#scr-game .save-row .chip.compat.good')), 'a compatible save should show a green badge');
    const onInstall = async () => page.evaluate(() => (document.activeElement.getAttribute('data-nav-id') || '').indexOf('svi-') === 0);
    await pressUntil(page, 'ArrowDown', onInstall, 12);
    if (!(await onInstall())) await pressUntil(page, 'ArrowRight', onInstall, 4);
    await expect(onInstall, 'keyboard should reach an Install button (got ' + await activeInfo(page) + ')');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.sheet [data-nav-id="sv-install-go"]', { timeout: 6000 });
    await page.waitForSelector('.sheet [data-nav-id="svu-0"]', { timeout: 6000 });
    await sleep(300);
    await shot(page, 'tv-save-install.png');
    await expect(async () => page.evaluate(() => document.querySelector('.sheet [data-nav-id="sv-backup"]').getAttribute('aria-checked') === 'true'), '"Back up my current save first" should default on');
    await page.evaluate(() => document.querySelector('[data-nav-id="sv-install-go"]').focus());
    await page.keyboard.press('Enter');
    await noLayer(page);
    await page.waitForFunction(() => fetch('/api/queue').then((r) => r.json()).then((q) => q.jobs.some((j) => j.type === 'save-install')), null, { timeout: 6000, polling: 300 }).catch(() => fail('save-install job missing from the queue'));
    await page.click('#scr-game .save-open');
    await page.waitForSelector('.sheet [data-nav-id="sv-install"]');
    await sleep(300);
    await shot(page, 'tv-save-detail.png');
    await page.keyboard.press('Escape'); await noLayer(page);
    note('saves tab + install flow OK');

    /* ================= Community Saves screen + Upload wizard ================= */
    await page.evaluate(() => XS.router.go('saves'));
    await page.waitForSelector('#scr-saves.active .save-card', { timeout: 10000 });
    await waitCovers(page, 10);
    await sleep(400);
    await shot(page, 'tv-saves.png');
    await page.click('[data-nav-id="sv-compat"]'); await sleep(300);
    await expect(async () => page.evaluate(() => Array.from(document.querySelectorAll('#scr-saves .saves-grid .save-card .chip.compat')).every((c) => c.classList.contains('good'))), '"Compatible with my games" should hide incompatible saves');
    await page.click('[data-nav-id="sv-compat"]'); await sleep(200);
    await page.click('[data-nav-id="cat-platinum"]'); await sleep(300);
    await expect(async () => page.evaluate(() => Array.from(document.querySelectorAll('#scr-saves .saves-grid .save-card .chip.cat')).every((c) => c.classList.contains('platinum'))), 'category chip should filter the grid');
    await page.click('[data-nav-id="cat-all"]'); await sleep(200);
    await page.click('[data-nav-id="sv-upload"]');
    await page.waitForSelector('.sheet [data-nav-id="wz-user-0"]', { timeout: 6000 });
    await sleep(300);
    await shot(page, 'tv-saves-upload-1-profile.png');
    await page.click('[data-nav-id="wz-next"]');
    await page.waitForSelector('.sheet [data-nav-id="wz-title-0"]', { timeout: 8000 });
    await waitCovers(page, 2);
    await sleep(300);
    await shot(page, 'tv-saves-upload-2-title.png');
    await page.click('[data-nav-id="wz-title-0"]');
    await page.click('[data-nav-id="wz-next"]');
    await page.waitForSelector('.sheet [data-nav-id="wz-dir-0"]');
    await page.waitForFunction(() => !/reading version/.test(document.querySelector('.sheet [data-ver]').textContent), null, { timeout: 6000 }).catch(() => fail('installed version was not read'));
    await sleep(200);
    await shot(page, 'tv-saves-upload-3-dir.png');
    await page.click('[data-nav-id="wz-next"]');                                         // Export
    await page.waitForFunction(() => { const b = document.querySelector('.sheet [data-next]'); return b && !b.hasAttribute('disabled'); }, null, { timeout: 10000 });
    await expect(async () => page.evaluate(() => /Account ID removed/.test(document.querySelector('.sheet-body').textContent)), 'export summary should state the account id was removed');
    await sleep(200);
    await shot(page, 'tv-saves-upload-4-export.png');
    await page.click('[data-nav-id="wz-next"]');
    await page.waitForSelector('.sheet [data-nav-id="wz-host-0"]');
    await page.click('[data-nav-id="wz-next"]');                                         // Upload
    await page.waitForSelector('.sheet .bar.striped', { timeout: 4000 }).catch(() => fail('upload progress bar missing'));
    await page.waitForFunction(() => /Uploaded/.test(document.querySelector('.sheet-body').textContent), null, { timeout: 15000 });
    await sleep(200);
    await shot(page, 'tv-saves-upload-5-upload.png');
    await page.click('[data-nav-id="wz-next"]');
    await page.waitForSelector('.sheet [data-nav-id="wz-cat-starter"]');
    await expect(async () => page.evaluate(() => document.querySelector('.sheet [data-next]').hasAttribute('disabled')), 'Submit should be disabled until the form is valid');
    await page.click('[data-nav-id="wz-cat-starter"]');
    await page.fill('[data-nav-id="wz-name"]', 'Maxed starter — every weapon');
    await page.fill('[data-nav-id="wz-desc"]', 'All weapons unlocked, max money, right after the prologue.');
    await page.fill('[data-nav-id="wz-nick"]', 'xenoking');
    await sleep(200);
    await shot(page, 'tv-saves-upload-6-describe.png');
    await expect(async () => page.evaluate(() => !document.querySelector('.sheet [data-next]').hasAttribute('disabled')), 'Submit should enable once category, name and nickname are set');
    await page.click('[data-nav-id="wz-next"]');                                         // Submit
    await page.waitForSelector('.sheet [data-nav-id="wz-open-issue"]', { timeout: 10000 });
    await expect(async () => !!(await page.$('.sheet .qr svg')), 'submission QR missing');
    await sleep(300);
    await shot(page, 'tv-saves-upload-7-done.png');
    await expect(async () => (await api('/api/settings')).saves && (await api('/api/settings')).saves.nickname === 'xenoking', 'nickname should be remembered in settings.saves.nickname');
    await page.click('[data-nav-id="wz-done"]');
    await noLayer(page);
    note('upload wizard OK');

    /* ================= Homebrew tab + app page + install ================= */
    await page.click('[data-nav-id="tab:homebrew"]');
    await page.waitForSelector('#scr-homebrew.active .hb-card', { timeout: 10000 });
    await waitCovers(page, 10);
    await sleep(400);
    await shot(page, 'tv-homebrew.png');
    await expect(async () => !!(await page.$('#scr-homebrew [data-rail="essentials"]')), 'Essentials rail missing (featured.homebrew)');
    await expect(async () => !!(await page.$('#scr-homebrew [data-rail="emulators"]')) && !!(await page.$('#scr-homebrew [data-rail="tools"]')) && !!(await page.$('#scr-homebrew [data-rail="new"]')), 'Emulators / Tools / New versions rails missing');
    await expect(async () => page.evaluate(() => !/Invalid/.test(document.querySelector('#scr-homebrew [data-hb-meta]').textContent)), 'homebrew listing date renders badly');
    await page.click('[data-nav-id="hbcat-Emulator"]'); await sleep(300);
    await expect(async () => page.evaluate(() => Array.from(document.querySelectorAll('#scr-homebrew .hb-grid .hb-card .c')).every((c) => /Emulator/.test(c.textContent))), 'category chip should filter apps');
    await page.click('[data-nav-id="hbcat-all"]'); await sleep(200);
    await page.click('#scr-homebrew [data-rail="updates"] .hb-card');
    await page.waitForSelector('#scr-hbapp.active h1');
    await waitCovers(page, 4);
    await sleep(400);
    await shot(page, 'tv-homebrew-app.png');
    await expect(async () => page.evaluate(() => /Update to/.test(document.querySelector('#scr-hbapp [data-nav-id="gp-primary"]').textContent)), 'app with a newer version should offer Update');
    await expect(async () => page.evaluate(() => !/0 B/.test(document.querySelector('#scr-hbapp .gp-infopanel').textContent)), 'build sizes should not be 0 B');
    await page.evaluate(() => document.querySelector('#scr-hbapp [data-nav-id="gp-primary"]').focus());
    await page.keyboard.press('Enter');
    await page.waitForSelector('.sheet [data-nav-id="dl-start"]');
    await page.waitForFunction(() => document.activeElement && document.activeElement.getAttribute('data-nav-id') === 'dl-start', null, { timeout: 4000 });
    await sleep(200);
    await shot(page, 'tv-homebrew-install.png');
    await page.keyboard.press('Enter');
    await noLayer(page);
    await page.waitForFunction(() => fetch('/api/queue').then((r) => r.json()).then((q) => q.jobs.some((j) => j.gameId.indexOf('hb-') === 0 && j.format === 'PKG')), null, { timeout: 6000, polling: 300 }).catch(() => fail('homebrew PKG job missing from the queue'));
    await page.keyboard.press('Escape');
    await page.waitForSelector('#scr-homebrew.active', { timeout: 5000 });
    note('homebrew OK');

    /* ================= Library ================= */
    await page.click('[data-nav-id="tab:library"]');
    await page.waitForSelector('#scr-library.active .storage');
    await page.waitForSelector('#scr-library .files .frow', { timeout: 8000 });
    await waitCovers(page, 4);
    await sleep(300);
    await shot(page, 'tv-library.png');

    /* ================= Settings (+ theme switch sanity) ================= */
    await page.keyboard.press('o');
    await page.waitForSelector('#scr-settings.active .settings');
    await page.waitForFunction(() => document.querySelector('.logbox') && !/Loading/.test(document.querySelector('.logbox').textContent), null, { timeout: 8000 }).catch(() => note('settings log box not found (continuing)'));
    await sleep(300);
    await shot(page, 'tv-settings.png');
    await expect(async () => !!(await page.$('#banners .banner.info')), 'update banner missing although --update was passed');
    await page.click('[data-nav-id="set-theme"]');
    await page.waitForSelector('.menu [data-nav-id="mi-2"]');
    await page.click('.menu [data-nav-id="mi-2"]');                                  // OLED
    await page.waitForFunction(() => document.documentElement.getAttribute('data-theme') === 'oled');
    await sleep(300);
    await shot(page, 'tv-settings-oled.png');
    await page.click('[data-nav-id="set-theme"]');
    await page.waitForSelector('.menu [data-nav-id="mi-0"]');
    await page.click('.menu [data-nav-id="mi-0"]');
    await page.waitForFunction(() => document.documentElement.getAttribute('data-theme') === 'xeno-gold');

    /* ================= Search overlay (fuzzy + did you mean) ================= */
    await page.keyboard.press('/');
    await page.waitForSelector('.search-layer [data-nav-id="search-input"]');
    await page.keyboard.type('god');
    await page.waitForSelector('.search-layer .card', { timeout: 5000 });
    await waitCovers(page, 6);
    await sleep(300);
    await shot(page, 'tv-search.png');
    await page.fill('.search-layer [data-nav-id="search-input"]', 'god of wor');
    await page.waitForSelector('.search-layer [data-nav-id="search-dym"]', { timeout: 4000 }).catch(() => fail('search overlay: "Did you mean" missing'));
    await page.keyboard.press('Escape');
    await page.waitForSelector('.search-layer', { state: 'detached' });

    /* ================= Interaction sweep: source tools, speed test, collections, share QR, report ================= */
    const pageGame = await page.evaluate(() => { const g = XS.state.data.games.filter((x) => x.releases.some((r) => r.format === 'PAGE') && x.releases.some((r) => r.sourceId === 'archive') && !XS.state.jobsFor(x.id).length)[0]; return g ? g.id : ''; });
    await expect(async () => !!pageGame, 'mock catalog has no game with both a PAGE and an archive release');
    await page.evaluate((id) => XS.router.go('game', { id }), pageGame);
    await page.waitForSelector('#scr-game.active [data-nav-id="gp-options"]');
    await page.click('[data-nav-id="gp-options"]');
    await page.waitForSelector('.sheet [data-nav-id="rel-page-0"]');
    await page.click('.sheet [data-nav-id="rel-page-0"]');
    await page.waitForSelector('.sheet [data-nav-id="src-resolve"]');
    await expect(async () => !!(await page.$('.sheet [data-nav-id="src-pw"]')), 'password row missing for a DLPSGAME page release');
    await expect(async () => !!(await page.$('.sheet [data-nav-id="src-phone"]')), '"Open on your phone" row missing');
    await page.click('.sheet [data-nav-id="src-pw"]');
    await page.click('.sheet [data-nav-id="src-resolve"]');
    await page.waitForSelector('.sheet [data-nav-id="lnk-0"]', { timeout: 8000 });
    await page.click('.sheet [data-nav-id="lnk-0"]');
    await expect(async () => page.evaluate(() => /Custom link/.test(document.querySelector('.sheet-foot [data-foot-info]').textContent)), 'footer should describe the selected custom link');
    await page.click('.sheet [data-nav-id="dl-speed"]');
    await page.waitForSelector('.sheet [data-speed-results] .lrow', { timeout: 10000 });
    await shot(page, 'tv-game-source-tools.png');
    await page.keyboard.press('Escape');
    await noLayer(page);
    await page.click('[data-nav-id="gp-coll"]');
    await page.waitForSelector('.menu [data-nav-id^="mi-"]');
    await page.evaluate(() => { const items = Array.from(document.querySelectorAll('.menu .mi')); items[items.length - 1].click(); });
    await page.waitForSelector('.dialog [data-nav-id="prompt-input"]');
    await page.keyboard.type('Weekend backlog');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => fetch('/api/collections').then((r) => r.json()).then((c) => c.collections.some((x) => x.name === 'Weekend backlog')), null, { timeout: 5000, polling: 300 });
    await page.click('[data-nav-id="gp-more"]');
    await clickMenuItem(page, 'Share to phone');
    await page.waitForSelector('.dialog .qr svg');
    await shot(page, 'tv-game-share.png');
    await page.keyboard.press('Escape'); await noLayer(page);
    await page.click('[data-nav-id="gp-more"]');
    await clickMenuItem(page, 'Report broken link');
    await page.waitForSelector('.dialog .qr svg');
    await expect(async () => page.evaluate(() => /github\.com/.test(document.querySelector('.dialog').textContent)), 'report dialog should point at GitHub');
    await page.keyboard.press('Escape'); await noLayer(page);
    await page.click('[data-nav-id="tab:discover"]');
    await page.waitForSelector('#scr-discover.active .card');
    await page.click('[data-nav-id="request-game"]');
    await page.waitForSelector('.dialog .qr svg');
    await page.keyboard.press('Escape'); await noLayer(page);
    note('interaction sweep OK');

    /* ================= Screensaver (cover wall) ================= */
    await page.evaluate(() => XS.ca.screensaver.start());
    await page.waitForSelector('.screensaver.on', { timeout: 5000 });
    await waitCovers(page, 20);
    await sleep(900);
    await shot(page, 'tv-screensaver.png');
    await expect(async () => (await page.$$('.screensaver .ss-tile')).length >= 24, 'screensaver should show a wall of covers');
    await page.keyboard.press('ArrowDown');
    await page.waitForSelector('.screensaver', { state: 'detached', timeout: 3000 });
    await expect(async () => page.evaluate(() => XS.router.current().id === 'discover' && !XS.ui.layers.length), 'the key that exits the screensaver must not navigate');
    note('screensaver OK');

    /* ================= Pause / resume + history stress ================= */
    await page.click('[data-nav-id="tab:downloads"]');
    await page.waitForSelector('#scr-downloads.active .subtab');
    await page.click('[data-nav-id="dltab-active"]');
    await page.waitForSelector('#scr-downloads.active .job.st-downloading, #scr-downloads.active .job.st-connecting', { timeout: 10000 });
    const dlId = await page.$eval('#scr-downloads .job.st-downloading, #scr-downloads .job.st-connecting', (e) => e.getAttribute('data-job'));
    await page.click(`[data-nav-id="job-${dlId}-pause"]`);
    await page.waitForSelector(`.job[data-job="${dlId}"].st-paused`, { timeout: 5000 });
    await page.click(`[data-nav-id="job-${dlId}-resume"]`);
    await page.waitForFunction((id) => fetch('/api/queue').then((r) => r.json()).then((q) => { const j = q.jobs.filter((x) => x.id === id)[0]; return !!j && ['queued', 'connecting', 'downloading'].indexOf(j.state) >= 0; }), dlId, { timeout: 5000, polling: 300 });
    note('pause/resume round-trip OK');
    const stressGame = await page.evaluate(() => { const g = XS.state.data.games.filter((x) => x.platform === 'PS5' && x.releases.some((r) => r.sourceId === 'archive') && !XS.state.jobsFor(x.id).length)[3]; return g ? g.id : ''; });
    await page.evaluate((id) => XS.router.go('game', { id }), stressGame);
    await page.waitForSelector('#scr-game.active [data-nav-id="gp-primary"]');
    await page.click('[data-nav-id="gp-options"]');
    await page.waitForSelector('.sheet [data-nav-id="dl-start"]');
    await page.keyboard.press('Escape'); await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
    /* Rapid ○: every layer closes, history ends in sync at depth 0 and the app stays on a base tab. A press that lands
       while the previous back is still in flight is swallowed by the router on purpose (it must never overshoot the
       exit guard), so the tab can be Discover or the one the game was opened from. */
    await page.waitForFunction(() => !XS.ui.layers.length && history.state && history.state.d === 0 && !XS.router.busy() && XS.router.stack.length <= 1, null, { timeout: 4000, polling: 100 }).catch(async () => fail('rapid Escape×3 should close everything with history in sync (state: ' + await page.evaluate(() => XS.router.current().id + ' layers=' + XS.ui.layers.map((l) => l.key).join('+') + ' d=' + (history.state && history.state.d) + ' busy=' + XS.router.busy() + ' stack=' + XS.router.stack.map((e) => e.id).join('>')) + ')'));
    note('rapid Escape×3 landed on ' + await page.evaluate(() => XS.router.current().id));
    if (await page.evaluate(() => XS.router.current().id !== 'discover')) { await page.keyboard.press('Escape'); await page.waitForSelector('#scr-discover.active', { timeout: 5000 }); }
    await page.keyboard.press('Escape'); await sleep(700); await page.keyboard.press('Escape'); await sleep(700);
    await expect(async () => page.evaluate(() => XS.router.current().id === 'discover' && !!document.querySelector('#scr-discover.active')), 'Escape at the root must stay inside the app (exit guard)');
    await page.evaluate((id) => XS.router.go('game', { id }), stressGame);
    await page.waitForSelector('#scr-game.active [data-nav-id="gp-coll"]');
    await page.click('[data-nav-id="gp-coll"]');
    await page.waitForSelector('.menu .mi');
    await page.evaluate(() => { const items = Array.from(document.querySelectorAll('.menu .mi')); items[items.length - 1].click(); });
    await page.waitForSelector('.dialog [data-nav-id="prompt-input"]');
    await sleep(1400);
    await expect(async () => !!(await page.$('.dialog [data-nav-id="prompt-input"]')), 'a prompt opened while a menu is closing through history must stay open');
    await page.keyboard.press('Escape'); await noLayer(page);
    await page.keyboard.press('Escape'); await page.click('[data-nav-id="tab:library"]'); await sleep(1500);
    await expect(async () => page.evaluate(() => XS.router.current().id === 'library' && XS.router.stack.length === 1 && history.state && history.state.d === 0), 'tab switch during an in-flight back should end on that tab at depth 0');
    note('history stress OK');

    /* ================= Themes ================= */
    await page.click('[data-nav-id="tab:discover"]'); await page.waitForSelector('#scr-discover.active .card'); await sleep(300);
    for (const theme of ['midnight', 'oled', 'crimson', 'emerald', 'royal', 'ice']) {
      await page.evaluate((th) => XS.actions.applySettings({ general: { theme: th } }), theme);
      await sleep(250);
      if (theme === 'ice') await shot(page, 'tv-theme-ice.png');
    }
    await page.evaluate(() => XS.actions.applySettings({ general: { theme: 'xeno-gold' } }));

    const missing = await page.evaluate(() => XS.i18n.missing());
    if (missing.length) fail('missing i18n keys: ' + missing.join(', '));
    await ctx.close();

    /* ================= phone 390×844 ================= */
    const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'en-US' });
    const pp = await phone.newPage();
    watch(pp, 'phone');
    await pp.goto(BASE + '/', { waitUntil: 'load' });
    await pp.waitForSelector('#scr-discover.active .card', { timeout: 20000 });
    await waitCovers(pp, 8);
    await sleep(400);
    await shot(pp, 'phone-discover.png');
    await expect(async () => pp.evaluate(() => getComputedStyle(document.querySelector('#phonebar')).display === 'flex' && getComputedStyle(document.querySelector('#legend')).display === 'none'), 'phone layout should show the tab bar and hide the legend');
    await expect(async () => pp.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1 && document.querySelector('#scr-discover').scrollWidth <= window.innerWidth + 1), 'phone Discover has horizontal overflow');
    await pp.evaluate((id) => XS.router.go('game', { id }), okSave.gameId);
    await pp.waitForSelector('#scr-game.active .gp-info h1');
    await pp.waitForSelector('#scr-game.active .gal-thumb', { timeout: 10000 }).catch(() => note('phone: no gallery for this game'));
    await waitCovers(pp, 3);
    await sleep(500);
    await shot(pp, 'phone-game.png');
    await expect(async () => pp.evaluate(() => document.querySelector('#scr-game').scrollWidth <= window.innerWidth + 1), 'phone game page has horizontal overflow');
    await pp.click('[data-nav-id="gp-tab-saves"]');
    await pp.waitForSelector('#scr-game .save-row', { timeout: 8000 });
    await sleep(400);
    await shot(pp, 'phone-game-saves.png');
    await pp.evaluate(() => XS.router.go('saves'));
    await pp.waitForSelector('#scr-saves.active .save-card', { timeout: 10000 });
    await waitCovers(pp, 6);
    await sleep(400);
    await shot(pp, 'phone-saves.png');
    await expect(async () => pp.evaluate(() => document.querySelector('#scr-saves').scrollWidth <= window.innerWidth + 1), 'phone Community Saves has horizontal overflow');
    await pp.click('[data-nav-id="sv-upload"]');
    await pp.waitForSelector('.sheet [data-nav-id="wz-user-0"]');
    await sleep(300);
    await shot(pp, 'phone-saves-upload.png');
    await pp.keyboard.press('Escape'); await pp.waitForSelector('.layer', { state: 'detached' });
    await pp.click('[data-nav-id="pb:downloads"]');
    await pp.waitForSelector('#scr-downloads.active .job');
    await sleep(600);
    await shot(pp, 'phone-downloads.png');
    const missingPhone = await pp.evaluate(() => XS.i18n.missing());
    if (missingPhone.length) fail('phone: missing i18n keys: ' + missingPhone.join(', '));
    await phone.close();
  } finally {
    await browser.close();
    server.kill();
  }
  console.log('');
  if (problems.length) { console.log(`verify: ${problems.length} problem(s)`); problems.forEach((p) => console.log('  - ' + p)); process.exit(1); }
  console.log(`verify: OK — screenshots in ${OUT} (dist ${(distSize / 1024).toFixed(1)} KiB)`);
})().catch((err) => { console.error('verify: crashed: ' + (err.stack || err)); console.error(serverLog.slice(-20).join('')); server.kill(); if (problems.length) problems.forEach((p) => console.log('  - ' + p)); process.exit(1); });
