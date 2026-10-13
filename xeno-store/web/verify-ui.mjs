#!/usr/bin/env node
/*
 * XENO STORE — web/verify-ui.mjs: Playwright (Chromium) check of the built UI against the mock API.
 *
 *   1. builds web/dist/index.html (unless --no-build) and starts web/dev-server.mjs on a free port
 *   2. at 1920×1080: screenshots of first-run, Discover, Browse (filter sheet open), Game page,
 *      Game page with the Download options sheet, Downloads, Library, Settings, Search overlay
 *   3. walks Discover → Game → Download options → Start download → Downloads using ONLY keyboard
 *      events (ArrowDown/ArrowRight/Enter/Escape) and asserts the new job appears
 *   4. at 390×844 (phone): Discover, Game page, Downloads
 *   5. fails when the page logs a console error / uncaught exception, or any request to the mock
 *      server fails or answers with status ≥ 400
 *
 * Usage: PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers node web/verify-ui.mjs [--port 9095] [--no-build] [--out DIR] [--headed]
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, existsSync } from 'node:fs';
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

(async () => {
  await waitServer();
  note('dev-server up on ' + BASE);
  const browser = await chromium.launch({ headless: !args.includes('--headed') });
  try {
    /* ================= TV / desktop 1920×1080 ================= */
    const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1, locale: 'en-US' });
    const page = await ctx.newPage();
    watch(page, 'tv');
    await page.goto(BASE + '/', { waitUntil: 'load' });
    await page.waitForSelector('#scr-discover.active .card', { timeout: 20000 });
    if (VERBOSE) {
      page.on('console', (msg) => { if (msg.text().indexOf('[dbg]') === 0) note(msg.text()); });
      await page.evaluate(() => {
        window.addEventListener('popstate', (e) => console.log('[dbg] popstate state=' + JSON.stringify(e.state) + ' hash=' + location.hash));
        window.addEventListener('hashchange', () => console.log('[dbg] hashchange ' + location.hash));
        new MutationObserver((muts) => muts.forEach((m) => { if (m.target.classList.contains('active')) console.log('[dbg] active screen → ' + m.target.id + ' stack=' + XS.router.stack.length + ' hist=' + JSON.stringify(history.state)); })).observe(document.querySelector('#main'), { attributes: true, attributeFilter: ['class'], subtree: true });
        document.addEventListener('focusin', (e) => console.log('[dbg] focusin ' + (e.target.getAttribute('data-nav-id') || e.target.tagName) + ' in ' + (e.target.closest('.screen') ? e.target.closest('.screen').id : '-')));
      });
    }
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
    await page.waitForSelector('.layer', { state: 'detached', timeout: 5000 });
    await expect(async () => (await page.evaluate(() => fetch('/api/settings').then((r) => r.json()).then((s) => s.sources.acknowledged && s.downloads.defaultRoot === '/mnt/ext0'))), 'wizard did not persist sources.acknowledged + default root');
    await waitCovers(page, 20);
    await sleep(400);
    await shot(page, 'tv-discover.png');
    await expect(async () => (await page.$$('#scr-discover .rail')).length >= 6, 'Discover should show at least 6 rails');
    await expect(async () => !!(await page.$('#legend .hint')), 'legend hints missing');
    await expect(async () => !!(await page.$('#tabs [data-dl-badge]:not([hidden])')), 'Downloads badge should be visible while a job is active');

    /* ================= Browse + filter sheet ================= */
    await page.click('[data-nav-id="tab:browse"]');
    await page.waitForSelector('#scr-browse.active .card');
    await waitCovers(page, 12);
    await page.click('[data-nav-id="flt-genre"]');
    await page.waitForSelector('.sheet .filter-opts [data-nav-id="opt-0"]');
    await page.click('[data-nav-id="opt-0"]');
    await sleep(350);
    await shot(page, 'tv-browse-filter.png');
    await page.keyboard.press('Escape');
    await page.waitForSelector('.layer', { state: 'detached' });
    await expect(async () => !!(await page.$('#scr-browse .browse-active .chip.gold')), 'active-filter chip missing after picking a genre');
    await page.click('[data-nav-id="act-reset"]');
    await sleep(200);

    /* ================= keyboard-only walk: Discover → Game → Download options → Downloads ================= */
    await page.click('[data-nav-id="tab:discover"]');
    await page.waitForSelector('#scr-discover.active .card');
    await sleep(300);
    await page.evaluate(() => XS.nav.restore(document.querySelector('#scr-discover')));
    note('walk: start focus = ' + await activeInfo(page));
    const onPreferredCard = async () => page.evaluate(() => { const a = document.activeElement; return !!(a && a.classList.contains('card') && a.closest('[data-rail="verified"], [data-rail="trending"]')); });
    await pressUntil(page, 'ArrowDown', onPreferredCard, 14);
    if (!(await onPreferredCard())) { note('walk: no card in a preferred rail reached, moving right from ' + await activeInfo(page)); await pressUntil(page, 'ArrowRight', () => page.evaluate(() => document.activeElement && document.activeElement.classList.contains('card')), 4); }
    /* open cards along the rail until one has a direct (non-page, non-browser) release: only those can be queued */
    let title = '', direct = false;
    for (let attempt = 0; attempt < 8 && !direct; attempt++) {
      await page.keyboard.press('ArrowRight'); await sleep(120);
      note('walk: Enter on ' + await activeInfo(page));
      await page.keyboard.press('Enter');
      await page.waitForSelector('#scr-game.active .gp-info h1', { timeout: 8000 });
      title = await page.$eval('#scr-game.active .gp-info h1', (e) => e.textContent);
      /* the primary action must be "Download" (no job in flight for this game) and the best release must be a direct file */
      direct = await page.evaluate(() => { const g = XS.router.defs.game.current(); const r = g && XS.gamePage.bestRelease(g); if (!r) return false; const s = XS.state.data.sources.filter((x) => x.id === r.sourceId)[0]; const busy = XS.state.jobsFor(g.id).length > 0; return !busy && r.format !== 'PAGE' && (!s || s.kind === 'direct'); });
      if (direct) break;
      note('walk: ' + title + ' has no direct release or is already queued, going back (Escape)');
      await page.keyboard.press('Escape');
      await page.waitForSelector('#scr-discover.active', { timeout: 5000 });
      await sleep(250);
      if (VERBOSE) note('  after back: ' + await page.evaluate(() => JSON.stringify({ active: document.activeElement.getAttribute('data-nav-id'), screens: Array.from(document.querySelectorAll('.screen.active')).map((e) => e.id), key: XS.nav.key, stack: XS.router.stack.length, layers: XS.ui.layers.length, inDiscover: document.querySelector('#scr-discover').contains(document.activeElement) })));
    }
    if (!direct) { fail('walk: no game with a direct release reached along the rail'); throw new Error('walk aborted'); }
    note('walk: game page = ' + title);
    await waitCovers(page, 4);
    await sleep(500);
    await shot(page, 'tv-game.png');
    await expect(async () => (await activeId(page)) === 'gp-primary', 'game page should focus the primary Download button (got ' + await activeInfo(page) + ')');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.sheet [data-nav-id="dl-start"]', { timeout: 8000 });
    await page.waitForSelector('.sheet [data-saveto] .chip', { timeout: 8000 });     // /api/space answered for every root
    await sleep(350);
    await shot(page, 'tv-game-download-sheet.png');
    await expect(async () => (await page.$$('.sheet [data-saveto] .lrow')).length === 4, 'Save-to should list the 4 mock roots');
    await expect(async () => (await page.$$('.sheet [data-nav-id^="rel-"]')).length >= 1, 'release table empty');
    const reached = await pressUntil(page, 'ArrowDown', async () => (await activeId(page)) === 'dl-start', 70);
    await expect(async () => reached, 'could not reach Start download with ArrowDown (stuck on ' + await activeInfo(page) + ')');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.sheet [data-nav-id="q-view"]', { timeout: 10000 });
    await expect(async () => (await activeId(page)) === 'q-view', 'queued view should focus View downloads');
    await page.keyboard.press('Enter');
    await page.waitForSelector('#scr-downloads.active .job', { timeout: 8000 });
    await expect(async () => page.evaluate((t) => Array.from(document.querySelectorAll('#scr-downloads .job h4')).some((h) => h.textContent === t) || Array.from(document.querySelectorAll('#scr-downloads .subtab')).length > 0, title), 'queued job not visible on Downloads');
    await expect(async () => page.evaluate((t) => fetch('/api/queue').then((r) => r.json()).then((q) => q.jobs.some((j) => j.title === t)), title), 'mock queue does not contain the new job ' + title);
    await sleep(2500);                                                               // let the simulation move so sparklines/segments exist
    await page.evaluate(() => { const r = document.querySelector('#scr-downloads .job'); if (r) r.focus(); });
    await sleep(300);
    await shot(page, 'tv-downloads.png');
    await expect(async () => !!(await page.$('#scr-downloads .job .bar .seg')), 'segment visualization missing on the downloading row');
    await expect(async () => !!(await page.$('#scr-downloads .job .spark')), 'sparkline missing');
    await page.click('[data-nav-id="dltab-failed"]');
    await page.waitForSelector('#scr-downloads .job.st-failed .err');
    await expect(async () => !!(await page.$('#scr-downloads .job.st-failed [data-retry]')), 'retry countdown missing on the failed job');
    await shot(page, 'tv-downloads-failed.png');
    /* Escape = in-app back: downloads is a tab, so Back returns to Discover */
    await page.keyboard.press('Escape');
    await page.waitForSelector('#scr-discover.active', { timeout: 5000 });

    /* ================= Library ================= */
    await page.click('[data-nav-id="tab:library"]');
    await page.waitForSelector('#scr-library.active .storage');
    await page.waitForSelector('#scr-library .files .frow', { timeout: 8000 });
    await waitCovers(page, 4);
    await sleep(300);
    await shot(page, 'tv-library.png');
    await expect(async () => (await page.$$('#scr-library .storage')).length === 4, 'Library should show 4 storage bars');

    /* ================= Settings (+ theme switch sanity) ================= */
    await page.keyboard.press('o');
    await page.waitForSelector('#scr-settings.active .settings');
    await page.waitForFunction(() => document.querySelector('.logbox') && !/Loading/.test(document.querySelector('.logbox').textContent), null, { timeout: 8000 });
    await sleep(300);
    await shot(page, 'tv-settings.png');
    await expect(async () => !!(await page.$('#scr-settings .qr svg')), 'pairing QR not rendered');
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

    /* ================= Search overlay ================= */
    await page.keyboard.press('/');
    await page.waitForSelector('.search-layer [data-nav-id="search-input"]');
    await page.keyboard.type('god');
    await page.waitForSelector('.search-layer .card', { timeout: 5000 });
    await waitCovers(page, 6);
    await sleep(300);
    await shot(page, 'tv-search.png');
    await page.keyboard.press('Escape');
    await page.waitForSelector('.search-layer', { state: 'detached' });

    /* ================= Interaction sweep: source tools, speed test, collections, settings menus, library menu ================= */
    const pageGame = await page.evaluate(() => { const g = XS.state.data.games.filter((x) => x.releases.some((r) => r.format === 'PAGE') && x.releases.some((r) => r.sourceId === 'archive') && !XS.state.jobsFor(x.id).length)[0]; return g ? g.id : ''; });
    await expect(async () => !!pageGame, 'mock catalog has no game with both a PAGE and an archive release');
    await page.evaluate((id) => XS.router.go('game', { id }), pageGame);
    await page.waitForSelector('#scr-game.active [data-nav-id="gp-primary"]');
    await page.click('[data-nav-id="gp-primary"]');
    await page.waitForSelector('.sheet [data-nav-id="rel-page-0"]');
    await page.click('.sheet [data-nav-id="rel-page-0"]');
    await page.waitForSelector('.sheet [data-nav-id="src-resolve"]');
    await expect(async () => !!(await page.$('.sheet [data-nav-id="src-pw"]')), 'password row missing for a DLPSGAME page release');
    await page.click('.sheet [data-nav-id="src-pw"]');                                  // reveal + copy
    await page.click('.sheet [data-nav-id="src-resolve"]');                             // Get links → /api/links/resolve
    await page.waitForSelector('.sheet [data-nav-id="lnk-0"]', { timeout: 8000 });
    await page.click('.sheet [data-nav-id="lnk-0"]');
    await expect(async () => page.evaluate(() => /Custom link/.test(document.querySelector('.sheet-foot [data-foot-info]').textContent)), 'footer should describe the selected custom link');
    await page.click('.sheet [data-nav-id="dl-speed"]');                                // Speed test → /api/links/check
    await page.waitForSelector('.sheet [data-speed-results] .lrow', { timeout: 10000 });
    await shot(page, 'tv-game-source-tools.png');
    await page.keyboard.press('Escape');
    await page.waitForSelector('.layer', { state: 'detached' });
    await page.click('[data-nav-id="gp-coll"]');                                        // + Collection → new collection prompt
    await page.waitForSelector('.menu [data-nav-id^="mi-"]');
    await page.evaluate(() => { const items = Array.from(document.querySelectorAll('.menu .mi')); items[items.length - 1].click(); });
    await page.waitForSelector('.dialog [data-nav-id="prompt-input"]');
    await page.keyboard.type('Weekend backlog');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => fetch('/api/collections').then((r) => r.json()).then((c) => c.collections.some((x) => x.name === 'Weekend backlog')), null, { timeout: 5000, polling: 300 });
    await page.click('[data-nav-id="gp-more"]');                                        // ⋯ menu → Share to phone QR dialog
    await page.waitForSelector('.menu [data-nav-id="mi-2"]');
    await page.click('.menu [data-nav-id="mi-2"]');
    await page.waitForSelector('.dialog .qr svg');
    await page.keyboard.press('Escape');
    await page.waitForSelector('.layer', { state: 'detached' });
    await page.keyboard.press('o');                                                     // Settings: language menu, catalog refresh, export sheet
    await page.waitForSelector('#scr-settings.active [data-nav-id="set-lang"]');
    await page.click('[data-nav-id="set-lang"]');
    await page.waitForSelector('.menu [data-nav-id="mi-0"]');
    await page.keyboard.press('Escape');
    await page.waitForSelector('.layer', { state: 'detached' });
    await page.click('[data-nav-id="cat-refresh"]');
    await page.waitForSelector('.toast', { timeout: 8000 });
    await page.click('[data-nav-id="diag-export"]');
    await page.waitForSelector('.sheet textarea.input', { timeout: 8000 });
    await expect(async () => page.evaluate(() => document.querySelector('.sheet textarea.input').value.indexOf('"settings"') > 0), 'export sheet should contain the settings JSON');
    await page.keyboard.press('Escape');
    await page.waitForSelector('.layer', { state: 'detached' });
    await page.click('[data-nav-id="tab:library"]');                                    // Library: file row menu
    await page.waitForSelector('#scr-library.active .files .frow');
    await page.click('#scr-library .files .frow');
    await page.waitForSelector('.menu [data-nav-id="mi-0"]');
    await page.keyboard.press('Escape');
    await page.waitForSelector('.layer', { state: 'detached' });
    note('interaction sweep OK');

    /* ================= Pause / resume through the UI on the Downloads screen ================= */
    await page.click('[data-nav-id="tab:downloads"]');
    await page.waitForSelector('#scr-downloads.active .subtab');
    await page.click('[data-nav-id="dltab-active"]');          /* the screen remembers the last sub-tab (Failed) */
    await page.waitForSelector('#scr-downloads.active .job.st-downloading, #scr-downloads.active .job.st-connecting', { timeout: 10000 });
    const dlId = await page.$eval('#scr-downloads .job.st-downloading, #scr-downloads .job.st-connecting', (e) => e.getAttribute('data-job'));
    await page.click(`[data-nav-id="job-${dlId}-pause"]`);
    await page.waitForSelector(`.job[data-job="${dlId}"].st-paused`, { timeout: 5000 });
    await page.click(`[data-nav-id="job-${dlId}-resume"]`);
    /* resume re-queues the job; with one download slot it may wait in Queued (a different sub-tab), so check the API */
    await page.waitForFunction((id) => fetch('/api/queue').then((r) => r.json()).then((q) => { const j = q.jobs.filter((x) => x.id === id)[0]; return !!j && ['queued', 'connecting', 'downloading'].indexOf(j.state) >= 0; }), dlId, { timeout: 5000, polling: 300 });
    await page.waitForSelector(`.job[data-job="${dlId}"].st-paused`, { state: 'detached', timeout: 5000 });
    note('pause/resume round-trip OK');
    /* ================= History stress: rapid ○, ○ at the root (exit guard), open-while-closing, tab during back ================= */
    const stressGame = await page.evaluate(() => { const g = XS.state.data.games.filter((x) => x.releases.some((r) => r.sourceId === 'archive') && !XS.state.jobsFor(x.id).length)[2]; return g ? g.id : ''; });
    await page.evaluate((id) => XS.router.go('game', { id }), stressGame);
    await page.waitForSelector('#scr-game.active [data-nav-id="gp-primary"]');
    await page.click('[data-nav-id="gp-primary"]');
    await page.waitForSelector('.sheet [data-nav-id="dl-start"]');
    await page.keyboard.press('Escape'); await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
    await sleep(1500);
    await expect(async () => page.evaluate(() => XS.router.current().id === 'discover' && !XS.ui.layers.length && history.state && history.state.d === 0 && !XS.router.busy()), 'rapid Escape×3 should land on Discover with history in sync');
    await page.keyboard.press('Escape'); await sleep(700); await page.keyboard.press('Escape'); await sleep(700);
    await expect(async () => page.evaluate(() => XS.router.current().id === 'discover' && location.href.indexOf(location.host) > 0 && !!document.querySelector('#scr-discover.active')), 'Escape at the root must stay inside the app (exit guard)');
    await page.evaluate((id) => XS.router.go('game', { id }), stressGame);
    await page.waitForSelector('#scr-game.active [data-nav-id="gp-coll"]');
    await page.click('[data-nav-id="gp-coll"]');
    await page.waitForSelector('.menu .mi');
    await page.evaluate(() => { const items = Array.from(document.querySelectorAll('.menu .mi')); items[items.length - 1].click(); });
    await page.waitForSelector('.dialog [data-nav-id="prompt-input"]');
    await sleep(1400);
    await expect(async () => !!(await page.$('.dialog [data-nav-id="prompt-input"]')), 'a prompt opened while a menu is closing through history must stay open');
    await page.keyboard.press('Escape');
    await page.waitForSelector('.layer', { state: 'detached' });
    await page.keyboard.press('Escape'); await page.click('[data-nav-id="tab:library"]'); await sleep(1500);
    await expect(async () => page.evaluate(() => XS.router.current().id === 'library' && XS.router.stack.length === 1 && history.state && history.state.d === 0), 'tab switch during an in-flight back should end on that tab at depth 0');
    note('history stress OK');

    /* ================= Themes: every theme applies without errors; the light one is captured for contrast review ================= */
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
    /* open a game that has no job yet (the first rail is "Continue downloading", whose primary action is Pause) */
    const phoneCard = await pp.evaluate(() => { const cards = Array.from(document.querySelectorAll('#scr-discover [data-rail="new"] .card, #scr-discover [data-rail="trending"] .card')); const c = cards.filter((x) => !XS.state.jobsFor(x.getAttribute('data-game')).length)[0]; return c ? c.getAttribute('data-nav-id') : ''; });
    await expect(async () => !!phoneCard, 'phone: no job-free card found in the New/Trending rails');
    await pp.click(`[data-nav-id="${phoneCard}"]`);
    await pp.waitForSelector('#scr-game.active .gp-info h1');
    await waitCovers(pp, 3);
    await sleep(400);
    await shot(pp, 'phone-game.png');
    await pp.click('[data-nav-id="gp-primary"]');
    await pp.waitForSelector('.sheet [data-nav-id="dl-start"]');
    await sleep(400);
    await shot(pp, 'phone-download-sheet.png');
    await pp.keyboard.press('Escape');
    await pp.waitForSelector('.layer', { state: 'detached' });
    await pp.click('[data-nav-id="pb:downloads"]');
    await pp.waitForSelector('#scr-downloads.active .job');
    await sleep(600);
    await shot(pp, 'phone-downloads.png');
    await phone.close();
  } finally {
    await browser.close();
    server.kill();
  }
  console.log('');
  if (problems.length) { console.log(`verify: ${problems.length} problem(s)`); problems.forEach((p) => console.log('  - ' + p)); process.exit(1); }
  console.log(`verify: OK — screenshots in ${OUT}`);
})().catch((err) => { console.error('verify: crashed: ' + (err.stack || err)); console.error(serverLog.slice(-20).join('')); server.kill(); process.exit(1); });
