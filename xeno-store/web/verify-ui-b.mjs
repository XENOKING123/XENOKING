#!/usr/bin/env node
/*
 * XENO STORE — web/verify-ui-b.mjs: Playwright (Chromium) check of the Phase 2 web features (part B) against the
 * mock API (dev-server.mjs + dev-server-ext-*.mjs). Same conventions as verify-ui.mjs.
 *
 *   1. builds web/dist/index.html (unless --no-build) and starts the mock on a free port (first-run wizard skipped)
 *   2. at 1920×1080: Downloads (install-set groups, lifetime stats, rest-mode pill, turbo chip, debrid label, copy and
 *      backup jobs, ZIP extraction, scheduled row + Start now, paused set + Retry), Library (disk analyzer + clean-up,
 *      Play now, uninstall with the token flow, copy-to-drive sheet, installed homebrew), Updates center (one-tap
 *      download+install), Saves hub (keyboard: Back up → progress → toast; restore; profile transfer), Settings
 *      (Setup via keyboard + run check + launch companion + ghost cleaner, Debrid connect, Accounts activate, Saves,
 *      Pair/mDNS, Uninstall sheet open/cancel + the final screen), command palette, shortcuts overlay, large text +
 *      high contrast, controller remap legend
 *   3. at 390×844: Downloads and Settings
 *   4. fails on any console error / uncaught exception, any failed or ≥ 400 request, missing i18n keys
 *
 * Usage: PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers node web/verify-ui-b.mjs [--port 9095] [--no-build] [--out DIR] [--headed] [--verbose]
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, existsSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const argValue = (name, dflt) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : dflt; };
const PORT = Number(argValue('--port', 9500 + Math.floor(Math.random() * 400)));
const OUT = resolve(argValue('--out', join(here, 'screenshots')));
const BASE = `http://127.0.0.1:${PORT}`;
const require = createRequire(import.meta.url);
const pwPath = ['/opt/node22/lib/node_modules/playwright', 'playwright'].find((p) => { try { require.resolve(p); return true; } catch (e) { return false; } });
if (!pwPath) { console.error('verify-b: playwright not found (expected /opt/node22/lib/node_modules/playwright)'); process.exit(2); }
const { chromium } = require(pwPath);
if (!process.env.PLAYWRIGHT_BROWSERS_PATH && existsSync('/opt/pw-browsers')) process.env.PLAYWRIGHT_BROWSERS_PATH = '/opt/pw-browsers';
mkdirSync(OUT, { recursive: true });

const problems = [];
const note = (m) => console.log('verify-b: ' + m);
const fail = (m) => { problems.push(m); console.log('verify-b: FAIL ' + m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!args.includes('--no-build')) {
  const b = spawnSync(process.execPath, [join(here, 'build.mjs')], { stdio: 'inherit' });
  if (b.status !== 0) { console.error('verify-b: build failed'); process.exit(1); }
}
const distSize = existsSync(join(here, 'dist', 'index.html')) ? statSync(join(here, 'dist', 'index.html')).size : 0;
const server = spawn(process.execPath, [join(here, 'dev-server.mjs'), '--port', String(PORT), '--art', 'local', '--speed', '6', '--acknowledged'], { stdio: ['ignore', 'pipe', 'pipe'] });
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
const activeInfo = (page) => page.evaluate(() => { const a = document.activeElement; return a ? (a.tagName + ' ' + (a.className || '') + ' #' + (a.getAttribute('data-nav-id') || '')) : 'none'; });
async function waitCovers(page, min, ms) { try { await page.waitForFunction((n) => document.querySelectorAll('.cover.loaded').length >= n, min, { timeout: ms || 8000 }); } catch (e) { note('covers still loading (continuing)'); } }
async function shot(page, name) { await page.screenshot({ path: join(OUT, name), fullPage: false }); note('screenshot ' + name); }
const VERBOSE = args.includes('--verbose');
async function expect(cond, msg) { let ok = false; try { ok = await cond(); } catch (e) { ok = false; if (VERBOSE) note('expect threw: ' + e.message); } if (!ok) fail(msg); }
async function noLayer(page) { await page.waitForSelector('.layer', { state: 'detached', timeout: 6000 }); }
async function clickMenuItem(page, text) { await page.waitForSelector('.menu .mi'); const ok = await page.evaluate((tx) => { const it = Array.from(document.querySelectorAll('.menu .mi')).find((m) => m.textContent.indexOf(tx) >= 0); if (it) it.click(); return !!it; }, text); if (!ok) fail('menu item not found: ' + text); }
async function waitToast(page, text, ms) { try { await page.waitForFunction((tx) => Array.from(document.querySelectorAll('#toasts .toast')).some((t) => t.textContent.indexOf(tx) >= 0), text, { timeout: ms || 8000 }); return true; } catch (e) { fail('toast not seen: "' + text + '" (toasts: ' + await page.evaluate(() => Array.from(document.querySelectorAll('#toasts .toast')).map((t) => t.textContent.trim().slice(0, 80)).join(' | ')) + ')'); return false; } }
async function confirmDialog(page) { await page.waitForSelector('.dialog [data-nav-id="dlg-1"]'); await page.click('.dialog [data-nav-id="dlg-1"]'); }
async function keyTo(page, navId, max) {
  /* keyboard-only: walk with arrows until the target has focus (falls back to a programmatic focus and reports it) */
  for (let i = 0; i < (max || 40); i++) {
    const cur = await page.evaluate(() => document.activeElement && document.activeElement.getAttribute('data-nav-id'));
    if (cur === navId) return true;
    await page.keyboard.press('ArrowDown'); await sleep(60);
  }
  note('keyboard walk did not reach ' + navId + ' (focus: ' + await activeInfo(page) + '), focusing it directly');
  await page.focus('[data-nav-id="' + navId + '"]');
  return false;
}
const api = (path, init) => fetch(BASE + path, init).then((r) => r.json());
const put = (path, body) => api(path, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

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
    await page.waitForFunction(() => !!(window.XS && XS.cb && XS.cb.palette), null, { timeout: 5000 });
    await expect(async () => page.evaluate(() => typeof XS.actions.applySettings === 'function' && XS.actions.applySettings._cbWrapped === true), 'applySettings should be wrapped by 32-components-b (accessibility attributes)');

    /* ---------- Downloads: groups, stats, rest pill, turbo, via, copy, backup, extracting ---------- */
    await page.click('[data-nav-id="tab:downloads"]');
    await page.waitForSelector('#scr-downloads.active .jobgroup', { timeout: 10000 });
    await page.waitForFunction(() => { const s = document.querySelector('#scr-downloads .dl-stats'); return s && !s.hidden && /Lifetime/.test(s.textContent); }, null, { timeout: 8000 }).catch(() => fail('lifetime stats line (/api/stats) missing on Downloads'));
    await expect(async () => !!(await page.$('#scr-downloads .stat.pill.rest')), 'rest-mode pill missing');
    await expect(async () => page.evaluate(() => /awake|Rest mode/.test(document.querySelector('#scr-downloads .stat.pill.rest').textContent)), 'rest-mode pill text missing');
    await expect(async () => (await api('/api/queue')).summary.restMode.pill === await page.evaluate(() => document.querySelector('#scr-downloads .stat.pill.rest .v').textContent), 'rest-mode pill should show summary.restMode.pill verbatim (dl.c shape)');
    await page.waitForFunction(() => { const s = document.querySelector('#scr-downloads .dl-sched'); return s && !s.hidden && /Download window 22:00 – 07:00/.test(s.textContent) && /open now|closed/.test(s.textContent); }, null, { timeout: 6000 }).catch(() => fail('download window line (summary.schedule) missing on Downloads'));
    await expect(async () => !!(await page.$('#scr-downloads .job .chip.turbo')), 'turbo result chip ("Fastest mirror") missing on the running row');
    await expect(async () => page.evaluate(() => /Fastest mirror/.test(document.querySelector('#scr-downloads .job .chip.turbo').textContent)), 'turbo chip should read "Fastest mirror: …"');
    await expect(async () => !!(await page.$('#scr-downloads .job .chip.via')), '"via Real-Debrid" label missing');
    await expect(async () => !!(await page.$('#scr-downloads .job.type-copy')), 'copy job row missing');
    await expect(async () => !!(await page.$('#scr-downloads .job.st-extracting')), 'ZIP extracting row missing');
    await expect(async () => !!(await page.$('#scr-downloads .jobgroup .ghead .bar')), 'install-set group progress bar missing');
    await expect(async () => (await page.$$('#scr-downloads .jobgroup .members .job.member')).length >= 3, 'install-set members should be listed under the group');
    await waitCovers(page, 6);
    await page.evaluate(() => { const g = document.querySelector('#scr-downloads .jobgroup .ghead'); if (g) g.focus(); });
    await sleep(500);
    await shot(page, 'tv-b-downloads.png');
    /* queued tab: scheduled row + Start now */
    await page.click('[data-nav-id="dltab-queued"]');
    await page.waitForSelector('#scr-downloads .job.st-queued', { timeout: 6000 });
    const startNow = await page.$('#scr-downloads [data-nav-id^="job-j_sched"][data-nav-id$="-startnow"]');
    await expect(async () => !!startNow, 'scheduled row should offer "Start now"');
    await expect(async () => page.evaluate(() => Array.from(document.querySelectorAll('#scr-downloads .job.st-queued')).some((r) => /Scheduled for 22:00/.test(r.textContent))), '"Scheduled for 22:00" missing on the scheduled row');
    await shot(page, 'tv-b-downloads-queued.png');
    if (startNow) {
      await startNow.click();
      await waitToast(page, 'starts now');
      await page.waitForFunction(() => fetch('/api/queue').then((r) => r.json()).then((q) => q.jobs.some((j) => j.startNow === true && j.scheduledFor === '22:00' && !/^j_sched/.test(j.id))), null, { timeout: 6000, polling: 300 }).catch(() => fail('Start now should turn the scheduled entry into a real queued job with startNow:true'));
      await expect(async () => serverLog.some((l) => /startNow j_sched[0-9a-f]+ via \/startNow/.test(l)), 'the UI should call POST /api/queue/{id}/startNow (the dl_action name)');
    }
    /* failed tab: paused install set + Retry */
    await page.click('[data-nav-id="dltab-failed"]');
    await page.waitForSelector('#scr-downloads .jobgroup.gs-paused', { timeout: 6000 });
    await expect(async () => page.evaluate(() => /Install set paused at: update/i.test(document.querySelector('#scr-downloads .jobgroup.gs-paused').textContent)), '"Install set paused at: update…" missing');
    await expect(async () => !!(await page.$('#scr-downloads .jobgroup.gs-paused [data-nav-id^="group-"][data-nav-id$="-retry"]')), 'paused set should offer Retry');
    await waitCovers(page, 3);
    await sleep(300);
    await shot(page, 'tv-b-downloads-set-paused.png');
    await page.click('#scr-downloads .jobgroup.gs-paused [data-nav-id^="group-"][data-nav-id$="-retry"]');
    await waitToast(page, 'Retrying');
    await page.waitForFunction(() => !document.querySelector('#scr-downloads .jobgroup.gs-paused'), null, { timeout: 8000 }).catch(() => fail('after Retry the paused set should leave the Failed tab'));
    /* finished tab: backup job, extracted ZIP (after the mock finishes extracting) */
    await page.click('[data-nav-id="dltab-finished"]');
    await page.waitForSelector('#scr-downloads .job.type-backup', { timeout: 6000 }).catch(() => fail('save backup job row missing in Finished'));
    await page.waitForSelector('#scr-downloads .job.st-extracted', { timeout: 25000 }).catch(() => fail('ZIP should reach the "extracted" state'));
    await expect(async () => page.evaluate(() => { const r = document.querySelector('#scr-downloads .job.st-extracted'); return r && /Extracted/.test(r.textContent); }), 'extracted row should show the "Extracted · n files" chip');
    await sleep(300);
    await shot(page, 'tv-b-downloads-finished.png');
    /* turbo details sheet from the row menu */
    await page.click('[data-nav-id="dltab-active"]');
    await page.waitForSelector('#scr-downloads .job .chip.turbo');
    await page.evaluate(() => { const row = document.querySelector('#scr-downloads .job .chip.turbo').closest('.job'); row.querySelector('[data-nav-id$="-more"]').click(); });
    await clickMenuItem(page, 'Mirror race results');
    await page.waitForSelector('.sheet [data-nav-id="turbo-close"]');
    await expect(async () => (await page.$$('.sheet .lrow')).length === 3, 'turbo sheet should list the 3 raced mirrors');
    await page.keyboard.press('Escape'); await noLayer(page);

    /* ---------- Library: analyzer, play now, uninstall, copy to drive, homebrew ---------- */
    await page.click('[data-nav-id="tab:library"]');
    await page.waitForSelector('#scr-library.active .usage-card', { timeout: 10000 });
    await page.waitForSelector('#scr-library .inst-acts', { timeout: 8000 });
    await page.waitForSelector('#scr-library .files .frow', { timeout: 8000 });
    await page.waitForSelector('#scr-library .hbrow', { timeout: 8000 }).catch(() => fail('installed homebrew apps list missing'));
    await expect(async () => !!(await page.$('#scr-library .hbrow .chip.warn')), 'an installed homebrew app should show "Update available"');
    await expect(async () => (await page.$$('#scr-library .lib-tile')).length >= 3, 'Library quick entries missing');
    await expect(async () => !!(await page.$('#scr-library .ubar i.bad')), 'disk analyzer should show the partials segment');
    await waitCovers(page, 6);
    await sleep(300);
    await shot(page, 'tv-b-library.png');
    await page.evaluate(() => { const c = document.querySelector('#scr-library .usage-card'); if (c) c.scrollIntoView(); });
    await sleep(200);
    await shot(page, 'tv-b-disk-analyzer.png');
    const clean = await page.$('#scr-library [data-nav-id^="usage-clean-"]');
    if (!clean) fail('Clean up partials button missing'); else { await clean.click(); await confirmDialog(page); await waitToast(page, 'freed'); }
    /* play now */
    await page.click('#scr-library [data-nav-id^="play:"]');
    await waitToast(page, 'Launching');
    /* uninstall a game: menu → double confirm → token flow */
    const instCount = (await api('/api/library')).installed.length;
    await page.click('#scr-library [data-nav-id^="instmore:"]');
    await clickMenuItem(page, 'Uninstall game');
    await confirmDialog(page); await confirmDialog(page);
    await waitToast(page, 'uninstalled');
    await expect(async () => (await api('/api/library')).installed.length === instCount - 1, 'uninstall should remove the title from /api/library.installed');
    /* copy to another drive */
    await page.waitForFunction(() => !document.querySelector('#scr-library .files .busy-row') && Array.from(document.querySelectorAll('#scr-library .files .frow')).some((r) => !/Partial/.test(r.textContent)), null, { timeout: 10000 }).catch(() => fail('no complete file row to copy after the rescan'));
    await page.evaluate(() => { const row = Array.from(document.querySelectorAll('#scr-library .files .frow')).find((r) => !/Partial/.test(r.textContent)); if (row) row.click(); });
    await clickMenuItem(page, 'Copy to another drive');
    await page.waitForSelector('.sheet [data-nav-id="tr-start"]');
    await page.click('.sheet [data-nav-id="tr-root-0"]');
    await page.waitForFunction(() => { const l = document.querySelector('.sheet [data-space]'); return l && /Fits|Not enough/.test(l.textContent); }, null, { timeout: 6000 }).catch(() => fail('transfer sheet should show the space check result'));
    await shot(page, 'tv-b-transfer-sheet.png');
    const fits = await page.evaluate(() => /Fits/.test(document.querySelector('.sheet [data-space]').textContent));
    if (fits) {
      await page.click('.sheet [data-nav-id="tr-start"]');
      await waitToast(page, 'added to the queue');
      await expect(async () => (await api('/api/queue')).jobs.some((j) => j.type === 'copy' && j.state === 'queued'), 'copy job should be queued through /api/library/transfer');
    } else { note('first destination has no space for the first file: closing the sheet'); await page.keyboard.press('Escape'); await noLayer(page); }
    /* updates center */
    await page.click('[data-nav-id="lib-entry-updates"]');
    await page.waitForSelector('#scr-updates.active .uprow', { timeout: 10000 });
    await waitCovers(page, 3);
    await sleep(400);
    await shot(page, 'tv-b-updates.png');
    const upCount = (await api('/api/queue')).jobs.length;
    await page.click('#scr-updates [data-nav-id^="upgo:"]');
    await waitToast(page, 'added');
    await expect(async () => (await api('/api/queue')).jobs.length > upCount, 'one-tap update should queue a job via /api/queue/set');
    await page.keyboard.press('Escape');
    await page.waitForSelector('#scr-library.active', { timeout: 6000 });

    /* ---------- Saves hub, keyboard only: entry → Back up → progress → toast ---------- */
    await page.evaluate(() => document.querySelector('[data-nav-id="lib-entry-saveshub"]').focus());
    await page.keyboard.press('Enter');
    await page.waitForSelector('#scr-saveshub.active .srow', { timeout: 10000 });
    await page.waitForSelector('#scr-saveshub .sh-backups .brow', { timeout: 8000 });
    await waitCovers(page, 3);
    await sleep(300);
    await shot(page, 'tv-b-saves-hub.png');
    const backupsBefore = (await page.$$('#scr-saveshub .sh-backups .brow')).length;
    await page.evaluate(() => document.querySelector('#scr-saveshub [data-nav-id^="save-backup:"]').focus());
    await page.keyboard.press('Enter');
    await page.waitForSelector('#scr-saveshub .cxjob', { timeout: 6000 }).catch(() => fail('backup progress row (.cxjob) missing after Back up'));
    await sleep(500);
    await shot(page, 'tv-b-saves-hub-progress.png');
    await waitToast(page, 'backed up', 20000);
    await page.waitForFunction((n) => document.querySelectorAll('#scr-saveshub .sh-backups .brow').length > n, backupsBefore, { timeout: 8000 }).catch(() => fail('backups list should grow after a backup'));
    /* restore the newest backup */
    await page.click('#scr-saveshub .sh-backups .brow');
    await clickMenuItem(page, 'Restore this backup');
    await page.waitForSelector('.sheet [data-nav-id="rs-go"]');
    await shot(page, 'tv-b-saves-restore.png');
    await page.click('.sheet [data-nav-id="rs-go"]');
    await waitToast(page, 'restored');
    /* transfer to the other profile (Beta) */
    await page.click('#scr-saveshub [data-nav-id^="save-more:"]');
    await clickMenuItem(page, 'Transfer to profile');
    await page.waitForSelector('.sheet [data-nav-id="ts-go"]');
    await expect(async () => page.evaluate(() => /Beta/.test(document.querySelector('.sheet .sheet-head').textContent)), 'transfer sheet should carry the Beta label');
    await page.click('.sheet [data-nav-id="ts-go"]');
    await waitToast(page, 'transferred');
    /* back up all */
    await page.click('[data-nav-id="sh-backup-all"]');
    await confirmDialog(page);
    await waitToast(page, 'started');
    await page.keyboard.press('Escape');
    await page.waitForSelector('#scr-library.active', { timeout: 6000 });

    /* ---------- Settings → Setup (keyboard), run check, launch companion, install companion, ghost cleaner ---------- */
    await page.keyboard.press('o');
    await page.waitForSelector('#scr-settings.active .settings');
    await page.evaluate(() => document.querySelector('[data-nav-id="set-nav-general"]').focus());
    await keyTo(page, 'set-nav-setup', 20);
    await page.keyboard.press('Enter');
    await sleep(300);
    await expect(async () => page.evaluate(() => document.activeElement && document.activeElement.getAttribute('data-nav-id') === 'setup-check'), 'Enter on the Setup nav entry should focus the checklist row (got ' + await activeInfo(page) + ')');
    await page.keyboard.press('Enter');
    await page.waitForSelector('#scr-setup.active .check-row', { timeout: 10000 });
    await page.evaluate(() => document.querySelector('[data-nav-id="setup-run"]').focus());
    await page.keyboard.press('Enter');
    await waitToast(page, 'checks');
    await expect(async () => !!(await page.$('#scr-setup .pm-panel .qr svg')), 'Payload Manager QR missing');
    await expect(async () => (await page.$$('#scr-setup .payload-row')).length >= 5, 'companion payloads list missing');
    await expect(async () => (await page.$$('#scr-setup .ghost-row')).length >= 4, 'ghost icon list missing');
    await sleep(300);
    await shot(page, 'tv-b-setup.png');
    await expect(async () => !!(await page.$('#scr-setup [data-nav-id="check-shadowmount-launch"]')), '"Launch ShadowMountPlus now" should be offered when a copy exists and the API is silent');
    await page.click('#scr-setup [data-nav-id="check-shadowmount-launch"]');
    await waitToast(page, 'sent to the loader');
    await page.waitForFunction(() => { const r = document.querySelector('#scr-setup [data-nav-id="check-shadowmount"]'); return r && r.classList.contains('ok'); }, null, { timeout: 12000 }).catch(() => fail('after launching ShadowMountPlus the re-check should pass'));
    await page.click('#scr-setup [data-nav-id="pl-etahen-dpi-helper-install"]');
    await waitToast(page, 'ready', 20000);
    await page.evaluate(() => { const r = document.querySelector('#scr-setup .ghost-row'); if (r) r.scrollIntoView(); });
    await sleep(200);
    await shot(page, 'tv-b-setup-ghosts.png');
    await page.click('#scr-setup [data-nav-id="ghost-PPSA01234-delete"]');
    await confirmDialog(page); await confirmDialog(page);
    await waitToast(page, 'deleted');
    await page.waitForFunction(() => !document.querySelector('#scr-setup [data-nav-id="ghost-PPSA01234"]'), null, { timeout: 8000 }).catch(() => fail('deleted ghost folder should leave the list'));
    await page.keyboard.press('Escape');
    await page.waitForSelector('#scr-settings.active', { timeout: 6000 });

    /* ---------- Settings → Debrid / Accounts / Saves / Pair ---------- */
    await page.click('[data-nav-id="set-nav-debrid"]');
    await page.waitForSelector('#scr-settings .debrid-row', { timeout: 8000 });
    await sleep(500);
    await expect(async () => page.evaluate(() => /••••/.test(document.querySelector('#scr-settings [data-nav-id="debrid-realdebrid"]').textContent)), 'connected service should show a masked key');
    await shot(page, 'tv-b-settings-debrid.png');
    await page.click('[data-nav-id="debrid-alldebrid-connect"]');
    await page.waitForSelector('.dialog [data-nav-id="prompt-input"]');
    await page.fill('.dialog [data-nav-id="prompt-input"]', 'alldebrid-test-key-123456');
    await page.keyboard.press('Enter');
    await waitToast(page, 'AllDebrid connected', 10000);
    await page.waitForFunction(() => { const r = document.querySelector('#scr-settings [data-nav-id="debrid-alldebrid"]'); return r && r.classList.contains('on'); }, null, { timeout: 8000 }).catch(() => fail('AllDebrid row should turn connected'));
    await page.click('[data-nav-id="set-nav-accounts"]');
    await page.waitForSelector('#scr-settings .acc-row', { timeout: 8000 });
    await sleep(800);
    await shot(page, 'tv-b-settings-accounts.png');
    await page.click('[data-nav-id="acc-2-activate"]');
    await page.waitForSelector('.sheet [data-nav-id="act-go"]');
    await shot(page, 'tv-b-accounts-activate.png');
    await page.click('.sheet [data-nav-id="act-go"]');
    await confirmDialog(page);
    await waitToast(page, 'activated');
    await page.waitForFunction(() => !!document.querySelector('#scr-settings [data-nav-id="acc-2-clear"]'), null, { timeout: 8000 }).catch(() => fail('activated slot should offer Clear'));
    await page.click('[data-nav-id="set-nav-saves"]');
    await page.waitForSelector('#scr-settings [data-nav-id="sv-root"]');
    await sleep(800);
    await shot(page, 'tv-b-settings-saves.png');
    await page.click('[data-nav-id="set-nav-pair"]');
    await page.waitForSelector('#scr-settings [data-nav-id="pair-local"]');
    await sleep(700);
    await expect(async () => page.evaluate(() => /xeno\.local:/.test(document.querySelector('#scr-settings [data-nav-id="pair-local"]').textContent)), 'Pair a device should show http://xeno.local:<port>');
    await expect(async () => page.evaluate(() => /Answering on this network/.test(document.querySelector('#scr-settings [data-nav-id="pair-local"]').textContent)), 'Pair a device should read the mDNS state from the {ok, mdns:{…}} envelope');
    await expect(async () => !!(await page.$('#scr-settings [data-nav-id="pair-mdns"]')), 'mDNS toggle missing');
    await sleep(200);
    await shot(page, 'tv-b-settings-pair.png');
    /* downloads group: Phase 2 rows */
    await page.click('[data-nav-id="set-nav-downloads"]');
    await sleep(300);
    for (const id of ['set-prefer', 'set-turbo', 'set-autosets', 'set-order', 'set-restresume', 'set-extract', 'set-delarchive', 'set-schedule']) await expect(async () => !!(await page.$('#scr-settings [data-nav-id="' + id + '"]')), 'Settings → Downloads row missing: ' + id);
    await page.click('[data-nav-id="set-schedule"]');
    await page.waitForSelector('.sheet [data-nav-id="sch-save"]');
    await page.click('.sheet [data-nav-id="sch-preset-1"]');
    await page.click('.sheet [data-nav-id="sch-save"]');
    await waitToast(page, '00:00 and 08:00');
    await expect(async () => (await api('/api/settings')).downloads.scheduleStart === '00:00', 'schedule window should be saved');

    /* ---------- Uninstall sheet, keyboard: open from the nav, cancel with Escape ---------- */
    await page.evaluate(() => document.querySelector('[data-nav-id="set-nav-general"]').focus());
    await keyTo(page, 'set-nav-uninstall', 20);
    await page.keyboard.press('Enter');
    await sleep(300);
    await expect(async () => page.evaluate(() => document.activeElement && document.activeElement.getAttribute('data-nav-id') === 'uninstall-open'), 'Enter on the Uninstall nav entry should focus the uninstall row (got ' + await activeInfo(page) + ')');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.sheet [data-nav-id="un-go"]');
    await expect(async () => page.evaluate(() => document.querySelector('.sheet [data-nav-id="un-keep"]').classList.contains('on')), '"Keep downloaded games" should be on by default');
    await sleep(300);
    await shot(page, 'tv-b-uninstall-sheet.png');
    await page.keyboard.press('Escape');
    await noLayer(page);
    await expect(async () => page.evaluate(() => !!document.querySelector('#scr-settings.active')), 'cancelling the uninstall sheet should return to Settings');

    /* ---------- Command palette + shortcuts overlay ---------- */
    await page.click('[data-nav-id="tab:discover"]');
    await page.waitForSelector('#scr-discover.active');
    await page.keyboard.press('Control+k');
    await page.waitForSelector('.palette [data-nav-id="palette-input"]', { timeout: 5000 });
    await page.fill('.palette [data-nav-id="palette-input"]', 'debrid');
    await page.waitForFunction(() => document.querySelectorAll('.palette .pal-item').length >= 1 && /Debrid/.test(document.querySelector('.palette .pal-item').textContent), null, { timeout: 4000 }).catch(() => fail('palette should list "Settings → Debrid" for "debrid"'));
    await sleep(200);
    await shot(page, 'tv-b-palette.png');
    await page.keyboard.press('Enter');
    await page.waitForSelector('#scr-settings.active', { timeout: 6000 });
    await expect(async () => page.evaluate(() => !!document.querySelector('[data-nav-id="set-nav-debrid"].on')), 'palette entry should open Settings → Debrid');
    await page.waitForFunction(() => !XS.router.busy() && !XS.ui.layers.length && !document.querySelector('.layer'), null, { timeout: 5000 });
    await page.keyboard.press('Control+k');
    await page.waitForSelector('.palette [data-nav-id="palette-input"]');
    await page.fill('.palette [data-nav-id="palette-input"]', 'god of');
    await page.waitForFunction(() => Array.from(document.querySelectorAll('.palette .pal-item .kind')).some((k) => /Game/.test(k.textContent)), null, { timeout: 4000 }).catch(async () => fail('palette should find catalog games (' + await page.evaluate(() => JSON.stringify({ active: document.activeElement && (document.activeElement.className + '/' + document.activeElement.value), palettes: document.querySelectorAll('.palette').length, layers: XS.ui.layers.map((l) => l.key).join('+'), busy: XS.router.busy(), items: Array.from(document.querySelectorAll('.palette .pal-item')).map((e) => e.textContent.trim().slice(0, 30)), search: (function () { try { return XS.ca.search('god of', 2).map((x) => x.g.title); } catch (e) { return 'ERR ' + e.message; } })() })) + ')'));
    await page.keyboard.press('Escape'); await noLayer(page);
    await page.keyboard.press('?');
    await page.waitForSelector('.dialog .sc-row', { timeout: 5000 });
    await shot(page, 'tv-b-shortcuts.png');
    await page.keyboard.press('Escape'); await noLayer(page);

    /* ---------- Accessibility: large text + high contrast; controller remap legend ---------- */
    await put('/api/settings', { general: { largeText: true, highContrast: true } });
    await page.evaluate(() => fetch('/api/settings').then((r) => r.json()).then((s) => { XS.state.set('settings', s); XS.actions.applySettings(s); }));
    await page.waitForFunction(() => document.documentElement.getAttribute('data-large-text') === '1' && document.documentElement.getAttribute('data-contrast') === 'high', null, { timeout: 4000 }).catch(() => fail('large text / high contrast attributes not applied'));
    await page.click('[data-nav-id="tab:discover"]');
    await page.waitForSelector('#scr-discover.active .card');
    await waitCovers(page, 10);
    await sleep(400);
    await shot(page, 'tv-b-a11y-discover.png');
    await page.click('[data-nav-id="tab:downloads"]');
    await page.waitForSelector('#scr-downloads.active .job');
    await sleep(400);
    await shot(page, 'tv-b-a11y-downloads.png');
    await expect(async () => page.evaluate(() => parseFloat(getComputedStyle(document.querySelector('.lrow .name, .job .ttl h4')).fontSize) >= 18), 'large text should enlarge row titles');
    await put('/api/settings', { general: { largeText: false, highContrast: false, controllerSwapConfirm: true } });
    await page.evaluate(() => fetch('/api/settings').then((r) => r.json()).then((s) => { XS.state.set('settings', s); XS.actions.applySettings(s); }));
    await page.waitForFunction(() => !document.documentElement.hasAttribute('data-large-text') && document.documentElement.getAttribute('data-swap-confirm') === '1', null, { timeout: 4000 }).catch(() => fail('swap attribute not applied'));
    await page.evaluate(() => { const r = document.querySelector('#scr-downloads .job'); if (r) r.focus(); });
    await sleep(300);
    await expect(async () => page.evaluate(() => { const first = document.querySelector('#legend .hint .glyph'); return first && first.classList.contains('circle'); }), 'with swap on, the legend select hint should show ○ (got ' + await page.evaluate(() => { const f = document.querySelector('#legend .hint .glyph'); return f ? f.getAttribute('class') : 'none'; }) + ')');
    await expect(async () => page.evaluate(() => { const pads = navigator.getGamepads && navigator.getGamepads(); return navigator.getGamepads && navigator.getGamepads._cbWrapped === true && (pads === null || typeof pads === 'object'); }), 'navigator.getGamepads should be wrapped for the ✕/○ swap');
    await put('/api/settings', { general: { controllerSwapConfirm: false } });
    await page.evaluate(() => fetch('/api/settings').then((r) => r.json()).then((s) => { XS.state.set('settings', s); XS.actions.applySettings(s); }));
    await sleep(200);

    /* ---------- Uninstall for real: final screen ---------- */
    await page.evaluate(() => XS.router.go('settings', { group: 'uninstall' }));
    await page.waitForSelector('#scr-settings.active [data-nav-id="uninstall-open"]');
    await page.click('[data-nav-id="uninstall-open"]');
    await page.waitForSelector('.sheet [data-nav-id="un-go"]');
    await page.click('.sheet [data-nav-id="un-go"]');
    await confirmDialog(page);
    await page.waitForSelector('.uninstalled', { timeout: 10000 });
    await expect(async () => page.evaluate(() => { const tx = document.querySelector('.uninstalled').textContent; return /removed/.test(tx) && /\/data\/homebrew\/XENO-STORE/.test(tx) && /Kept/.test(tx) && /\/mnt\/ext0\/xeno-store/.test(tx); }), 'final screen should list what was removed (home-screen app + data dir) and kept (downloads on every drive)');
    await sleep(400);
    await shot(page, 'tv-b-uninstalled.png');

    const missing = await page.evaluate(() => XS.i18n.missing());
    if (missing.length) fail('missing i18n keys: ' + missing.join(', '));
    await ctx.close();

    /* ================= phone 390×844 ================= */
    const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'en-US' });
    const pp = await phone.newPage();
    watch(pp, 'phone');
    await pp.goto(BASE + '/#downloads', { waitUntil: 'load' });
    await pp.waitForSelector('#scr-downloads.active .job', { timeout: 20000 });
    /* by now the seeded install sets may have finished (6× speed): show whichever tab holds one */
    if (!(await pp.$('#scr-downloads .jobgroup'))) { await pp.click('[data-nav-id="dltab-finished"]'); await pp.waitForSelector('#scr-downloads .jobgroup', { timeout: 8000 }).catch(() => fail('phone: no install-set group in Active or Finished')); }
    await waitCovers(pp, 3);
    await sleep(500);
    await shot(pp, 'phone-b-downloads.png');
    await expect(async () => pp.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1 && document.querySelector('#scr-downloads').scrollWidth <= window.innerWidth + 1), 'phone Downloads has horizontal overflow');
    await pp.evaluate(() => XS.router.go('settings', { group: 'debrid' }));
    await pp.waitForSelector('#scr-settings.active .debrid-row', { timeout: 8000 });
    await sleep(400);
    await shot(pp, 'phone-b-settings.png');
    await expect(async () => pp.evaluate(() => document.querySelector('#scr-settings').scrollWidth <= window.innerWidth + 1), 'phone Settings has horizontal overflow');
    await pp.evaluate(() => XS.router.go('saveshub'));
    await pp.waitForSelector('#scr-saveshub.active .srow', { timeout: 10000 });
    await sleep(400);
    await shot(pp, 'phone-b-saves-hub.png');
    await expect(async () => pp.evaluate(() => document.querySelector('#scr-saveshub').scrollWidth <= window.innerWidth + 1), 'phone Saves hub has horizontal overflow');
    const missingPhone = await pp.evaluate(() => XS.i18n.missing());
    if (missingPhone.length) fail('phone: missing i18n keys: ' + missingPhone.join(', '));
    await phone.close();
  } finally {
    await browser.close();
    server.kill();
  }
  console.log('');
  if (problems.length) { console.log(`verify-b: ${problems.length} problem(s)`); problems.forEach((p) => console.log('  - ' + p)); process.exit(1); }
  console.log(`verify-b: OK — screenshots in ${OUT} (dist ${(distSize / 1024).toFixed(1)} KiB)`);
})().catch((err) => { console.error('verify-b: crashed: ' + (err.stack || err)); console.error(serverLog.slice(-20).join('')); server.kill(); if (problems.length) problems.forEach((p) => console.log('  - ' + p)); process.exit(1); });
