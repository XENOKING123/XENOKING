/* XENO STORE — 32-components-b.js: Phase 2 shared helpers (XS.cb.*), web part B.
   Phase 2 API wrappers (stats, setup, payloads, ghost folders, debrid, uninstall, library transfer/launch/
   uninstall/usage, saves hub, accounts, mDNS), settings get/set, accessibility attributes (large text, high
   contrast, safe mode incl. the L2-held-at-boot session flag), controller remap (swap ✕/○) without touching
   20-nav.js, keyboard shortcuts overlay (?), command palette (Ctrl/Cmd+K), install-set group status and a
   watcher for console-side jobs (/api/saves/jobs). SPEC §17.5–17.7, §17.13–17.20. */
(function () {
  'use strict';
  var XS = window.XS, U = XS.util, S = XS.state, ui = XS.ui, h = U.h, t = XS.t;
  var cb = XS.cb = {};

  /* ---------- API (same envelope + PIN handling as 15-api.js) ---------- */
  function req(method, path, body, opts) {
    opts = opts || {};
    var headers = {};
    if (S.data.pin) headers['X-XENO-PIN'] = S.data.pin;
    return U.fetchJSON(path, { method: method, body: body, headers: headers, timeout: opts.timeout || 15000 }).then(function (r) {
      if (!S.data.serverOk) S.set('serverOk', true);
      return r;
    }, function (err) {
      if (err.status === 0 && !opts.quiet) S.set('serverOk', false);
      if (err.status === 401 && ui.askPin && !opts.noPin) return ui.askPin().then(function (ok) { return ok ? req(method, path, body, { noPin: true, timeout: opts.timeout }) : Promise.reject(err); });
      throw err;
    });
  }
  function qs(params) {
    var parts = [];
    for (var k in params) if (params[k] !== undefined && params[k] !== null && params[k] !== '') parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(params[k]));
    return parts.length ? '?' + parts.join('&') : '';
  }
  var enc = encodeURIComponent;
  cb.api = {
    get: function (path, opts) { return req('GET', path, undefined, opts); },
    post: function (path, body, opts) { return req('POST', path, body || {}, opts); },
    put: function (path, body, opts) { return req('PUT', path, body || {}, opts); },
    del: function (path, opts) { return req('DELETE', path, undefined, opts); },
    stats: function () { return req('GET', '/api/stats', undefined, { timeout: 8000, quiet: true }); },
    setupCheck: function (run) { return req(run ? 'POST' : 'GET', '/api/setup/check', run ? {} : undefined, { timeout: 45000 }); },
    payloads: function () { return req('GET', '/api/payloads', undefined, { timeout: 20000 }); },
    payloadInstall: function (id) { return req('POST', '/api/payloads/' + enc(id) + '/install', {}, { timeout: 30000 }); },
    payloadLaunch: function (id) { return req('POST', '/api/payloads/' + enc(id) + '/launch', {}, { timeout: 30000 }); },
    homebrewDirs: function () { return req('GET', '/api/homebrew-dirs', undefined, { timeout: 30000 }); },
    homebrewDirDelete: function (name) { return req('POST', '/api/homebrew-dirs/delete', { name: name, confirm: name }, { timeout: 60000 }); },
    debrid: function () { return req('GET', '/api/debrid', undefined, { timeout: 10000 }); },
    debridConnect: function (service, apiKey) { return req('PUT', '/api/debrid', { service: service, apiKey: apiKey }, { timeout: 30000 }); },
    debridDisconnect: function (service) { return req('DELETE', '/api/debrid/' + enc(service)); },
    uninstall: function (body) { return req('POST', '/api/uninstall', body, { timeout: 120000 }); },
    libraryTransfer: function (path, toRoot, move) { return req('POST', '/api/library/transfer', { path: path, toRoot: toRoot, move: !!move }); },
    libraryLaunch: function (titleId) { return req('POST', '/api/library/launch', { titleId: titleId }); },
    libraryUninstall: function (titleId, token) { return req('POST', '/api/library/uninstall', { titleId: titleId, token: token || '' }, { timeout: 120000 }); },
    libraryUsage: function () { return req('GET', '/api/library/usage', undefined, { timeout: 60000 }); },
    libraryClean: function (root) { return req('POST', '/api/library/usage/clean', { root: root || '' }, { timeout: 60000 }); },
    savesUsers: function () { return req('GET', '/api/saves/users'); },
    savesList: function (user) { return req('GET', '/api/saves' + qs({ user: user }), undefined, { timeout: 30000 }); },
    savesBackup: function (user, titleId, kind) { return req('POST', '/api/saves/backup', { user: user, titleId: titleId, kind: kind || '' }, { timeout: 30000 }); },
    savesBackupAll: function (user) { return req('POST', '/api/saves/backup', { user: user, all: true }, { timeout: 60000 }); },
    savesBackups: function () { return req('GET', '/api/saves/backups', undefined, { timeout: 30000 }); },
    savesRestore: function (user, zipPath, overwrite) { return req('POST', '/api/saves/restore', { user: user, zipPath: zipPath, overwrite: !!overwrite }, { timeout: 120000 }); },
    savesTransfer: function (fromUser, toUser, titleId, kind, move) { return req('POST', '/api/saves/transfer', { fromUser: fromUser, toUser: toUser, titleId: titleId, kind: kind || '', move: !!move }, { timeout: 120000 }); },
    savesJobs: function () { return req('GET', '/api/saves/jobs', undefined, { timeout: 8000, quiet: true }); },
    savesJob: function (id) { return req('GET', '/api/saves/jobs/' + enc(id), undefined, { timeout: 8000, quiet: true }); },
    savesJobCancel: function (id) { return req('POST', '/api/saves/jobs/' + enc(id) + '/cancel'); },
    accounts: function () { return req('GET', '/api/accounts', undefined, { timeout: 15000 }); },
    accountActivate: function (slot, id) { var b = {}; if (id) b.id = id; return req('POST', '/api/accounts/' + enc(String(slot)) + '/activate', b, { timeout: 30000 }); },
    accountClear: function (slot) { return req('POST', '/api/accounts/' + enc(String(slot)) + '/clear', {}, { timeout: 30000 }); },
    reboot: function () { return req('POST', '/api/accounts/reboot', {}, { timeout: 10000 }); },
    mdns: function () { return req('GET', '/api/mdns', undefined, { timeout: 8000, quiet: true }); },
    queueStartNow: function (id) { return req('POST', '/api/queue/' + enc(id) + '/startnow', {}); },
    queueSet: function (body) { return req('POST', '/api/queue/set', body, { timeout: 30000 }); },
    installedVersion: function (titleId) { return req('GET', '/api/saves/installed-version' + qs({ titleId: titleId }), undefined, { timeout: 8000, quiet: true }); },
    space: function (root, bytes) { return req('GET', '/api/space' + qs({ root: root, bytes: bytes }), undefined, { timeout: 8000 }); }
  };

  /* ---------- settings get/set (shared by Settings and the screens that flip a toggle) ---------- */
  cb.sget = function (path, dflt) {
    var o = S.data.settings, p = path.split('.');
    for (var i = 0; i < p.length; i++) { if (!o || typeof o !== 'object') return dflt; o = o[p[i]]; }
    return o === undefined || o === null ? dflt : o;
  };
  cb.sset = function (path, value, done) {
    var p = path.split('.'), partial = {}, cur = partial;
    for (var i = 0; i < p.length - 1; i++) { cur[p[i]] = {}; cur = cur[p[i]]; }
    cur[p[p.length - 1]] = value;
    /* optimistic local update so the UI responds instantly; the server answer is authoritative */
    var local = S.data.settings || {}; var o = local;
    for (var k = 0; k < p.length - 1; k++) { if (!o[p[k]] || typeof o[p[k]] !== 'object') o[p[k]] = {}; o = o[p[k]]; }
    o[p[p.length - 1]] = value;
    S.set('settings', local);
    if (XS.actions && XS.actions.applySettings) XS.actions.applySettings(local);
    return cb.api.put('/api/settings', partial).then(function (r) {
      if (r.settings) { S.data.settings = r.settings; if (XS.actions && XS.actions.applySettings) XS.actions.applySettings(r.settings); }
      if (done) done(true);
      return r;
    }, function (err) { ui.errorToast(err, t('set.saveFailed')); if (done) done(false); throw err; });
  };
  cb.consoleFw = function () { var st = S.data.status; return st && st.fw ? String(st.fw) : ''; };
  cb.fwNum = function (fw) { var m = /(\d+)(?:\.(\d+))?/.exec(String(fw || '')); return m ? parseFloat(m[1] + '.' + (m[2] || '0')) : 0; };
  cb.semverCmp = function (a, b) {
    var pa = String(a || '').replace(/^v/i, '').split(/[.\-_]/), pb = String(b || '').replace(/^v/i, '').split(/[.\-_]/);
    var n = Math.max(pa.length, pb.length);
    for (var i = 0; i < n; i++) { var x = parseInt(pa[i] || '0', 10), y = parseInt(pb[i] || '0', 10); if (isNaN(x)) x = 0; if (isNaN(y)) y = 0; if (x !== y) return x < y ? -1 : 1; }
    return 0;
  };
  cb.rootByPath = function (p) { var rs = S.data.storage || []; for (var i = 0; i < rs.length; i++) if (rs[i].path === p) return rs[i]; return null; };
  cb.rootLabel = function (p) { var r = cb.rootByPath(p); return r ? r.label : (p || ''); };
  cb.rootIcon = function (r) { return r && r.kind === 'usb' ? 'usb' : r && r.kind === 'm2' ? 'm2' : 'hdd'; };
  cb.maskKey = function (k) { k = String(k || ''); if (!k) return ''; return '••••••••' + k.slice(-4); };
  cb.hostOf = function (url) { var m = /^https?:\/\/([^/:?#]+)/i.exec(String(url || '')); return m ? m[1].replace(/^www\./, '') : ''; };
  cb.fmtAgo = function (ts) {
    if (!ts) return '';
    var sec = Math.max(0, U.nowSec() - (ts > 1e12 ? Math.floor(ts / 1000) : ts));
    if (sec < 60) return t('lib2.justNow');
    if (sec < 3600) return t('lib2.minutesAgo', { n: Math.floor(sec / 60) });
    if (sec < 86400) return t('lib2.hoursAgo', { n: Math.floor(sec / 3600) });
    return U.fmtDateTime(ts);
  };
  cb.userLabel = function (u) { if (!u) return ''; return u.name || ('#' + u.id); };
  cb.basename = function (p) { p = String(p || '').replace(/\/+$/, ''); return p.substring(p.lastIndexOf('/') + 1); };
  cb.dirname = function (p) { p = String(p || ''); var i = p.lastIndexOf('/'); return i > 0 ? p.slice(0, i) : p; };
  cb.isArchive = function (fmt) { var f = String(fmt || '').toLowerCase(); return f === 'zip' || f === 'rar' || f === '7z'; };
  cb.isImage = function (fmt) { var f = String(fmt || '').toLowerCase(); return f === 'exfat' || f === 'ffpfsc' || f === 'ffpkg' || f === 'ffpfs'; };
  cb.isPkg = function (fmt) { var f = String(fmt || '').toLowerCase(); return f === 'pkg' || f === 'fpkg'; };

  /* ---------- Small shared widgets ---------- */
  cb.kv = function (rows) {
    var kv = h('dl.kv');
    rows.forEach(function (r) { if (!r || r[1] === undefined || r[1] === null || r[1] === '') return; kv.appendChild(h('dt', { text: r[0] })); kv.appendChild(h('dd', typeof r[1] === 'string' ? { text: r[1] } : null, typeof r[1] === 'string' ? null : r[1])); });
    return kv;
  };
  cb.note = function (text, cls, icon) {
    return h('div.panel.note' + (cls ? '.' + cls : ''), [h('div.row', [ui.svg(icon || (cls === 'warn' ? 'alert' : 'info')), h('span.dim.small', { text: text, style: { marginTop: 0 } })])]);
  };
  /* Checkbox row (sheets with several options): a toggle row that reads as a checklist. */
  cb.checkRow = function (o) {
    var row = h('button.lrow.crow' + (o.value ? '.on' : ''), { nav: o.id, role: 'checkbox', 'aria-checked': o.value ? 'true' : 'false', data: { hints: 'toggle' } });
    var box = h('span.cbox', { html: U.icon('check') });
    row.appendChild(box);
    var main = h('div.main', [h('div.name', { text: o.label })]);
    if (o.desc) main.appendChild(h('div.desc', { text: o.desc }));
    row.appendChild(main);
    if (o.danger) row.classList.add('danger');
    row.addEventListener('click', function () {
      var v = !row.classList.contains('on');
      row.classList.toggle('on', v); row.setAttribute('aria-checked', v ? 'true' : 'false');
      if (o.onChange) o.onChange(v, row);
    });
    row.get = function () { return row.classList.contains('on'); };
    return row;
  };
  cb.busy = function (text) { return h('div.panel.busy-row', [h('div.row', [h('span.skel', { style: { width: '18px', height: '18px', borderRadius: '50%', flex: '0 0 auto' } }), h('span.dim', { text: text })])]); };
  cb.spinnerBtn = function (btn, on) { if (!btn) return; btn.classList.toggle('busy', !!on); if (on) btn.setAttribute('aria-disabled', 'true'); else btn.removeAttribute('aria-disabled'); };
  cb.okToast = function (title, desc) { return ui.toast({ cls: 'good', title: title, desc: desc || '' }); };
  /* Two confirmations in a row for destructive, irreversible actions (uninstall game, delete folder). */
  cb.doubleConfirm = function (title, text, okLabel, secondText) {
    return ui.confirm(title, text, okLabel, true).then(function (ok) {
      if (!ok) return false;
      return ui.confirm(t('lib2.sureTitle'), secondText || t('lib2.sureText'), okLabel, true);
    });
  };
  /* Drive picker rows (transfer sheet, backup drive). onPick(root). */
  cb.rootRows = function (o) {
    var list = h('div.list');
    var roots = (S.data.storage || []).filter(function (r) { return !o.filter || o.filter(r); });
    if (!roots.length) { list.appendChild(h('p.dim', { text: t('lib.noDrives') })); return list; }
    roots.forEach(function (r, i) {
      var sel = o.selected && o.selected === r.path;
      var row = h('button.lrow' + (sel ? '.sel' : ''), { nav: (o.id || 'root') + '-' + i, data: { hints: 'select' } });
      var disabled = !r.writable || (o.disabled && o.disabled(r));
      if (disabled) row.setAttribute('aria-disabled', 'true');
      if (sel) row.setAttribute('data-autofocus', '');
      row.appendChild(h('span.ic', { html: U.icon(cb.rootIcon(r)) }));
      var desc = r.path + ' · ' + t('dl.free', { n: U.fmtBytes(r.free) });
      if (o.desc) desc = o.desc(r) || desc;
      row.appendChild(h('div.main', [h('div.name', [r.label, r['default'] ? h('span.chip.sm.gold', { text: t('lib.default'), style: { marginInlineStart: '8px' } }) : null]), h('div.desc', { text: desc })]));
      row.appendChild(h('span.check', { html: sel ? U.icon('check') : '' }));
      row.addEventListener('click', function () {
        if (disabled) return;
        U.$$('.lrow', list).forEach(function (x) { x.classList.remove('sel'); var c = x.querySelector('.check'); if (c) c.innerHTML = ''; });
        row.classList.add('sel'); row.querySelector('.check').innerHTML = U.icon('check');
        if (o.onPick) o.onPick(r, row);
      });
      list.appendChild(row);
    });
    return list;
  };
  /* Progress line for a console-side job (/api/saves/jobs): title, bar, percent, message. */
  cb.cxJobRow = function (job) {
    var row = h('div.cxjob', { data: { cxjob: job.id || '' } });
    row.appendChild(h('div.top', [h('span.t.ellipsis', { text: job.title || job.type || '' }), h('span.p', { text: '' })]));
    row.appendChild(h('div.bar', [h('i')]));
    row.appendChild(h('div.m.dim', { text: '' }));
    cb.cxJobPatch(row, job);
    return row;
  };
  cb.cxJobPatch = function (row, job) {
    var pct = typeof job.percent === 'number' ? job.percent : (job.total ? U.pct(job.done, job.total) : 0);
    var st = job.state || 'queued';
    row.className = 'cxjob st-' + st;
    var bar = row.querySelector('.bar'); bar.className = 'bar' + (st === 'running' ? ' gold' : st === 'done' ? ' good' : st === 'failed' ? ' bad' : '') + (st === 'running' && !job.total ? ' striped' : '');
    var i = bar.querySelector('i'); i.style.width = (st === 'done' ? 100 : st === 'running' && !job.total && !pct ? 100 : pct).toFixed(1) + '%';
    row.querySelector('.p').textContent = st === 'done' ? t('lib2.jobDone') : st === 'failed' ? t('dl.state.failed') : st === 'cancelled' ? t('dl.state.cancelled') : st === 'queued' ? t('dl.state.queued') : (job.total ? U.fmtPct(pct) : '…');
    var m = row.querySelector('.m');
    m.textContent = st === 'failed' ? (job.error || job.message || t('err.unknown')) : (job.message || (job.total ? U.fmtBytes(job.done) + ' / ' + U.fmtBytes(job.total) : ''));
    m.classList.toggle('bad', st === 'failed');
  };
  /* Polls a console job until it settles. onUpdate(job) on every poll; resolves with the final job. */
  cb.watchJob = function (id, onUpdate, opts) {
    opts = opts || {};
    var stopped = false, polls = 0, max = opts.maxPolls || 400, every = opts.every || 700;
    var p = new Promise(function (resolve, reject) {
      function step() {
        if (stopped) return;
        cb.api.savesJob(id).then(function (r) {
          var j = r.job || {};
          if (onUpdate) { try { onUpdate(j); } catch (e) { console.error(e); } }
          if (j.state === 'done' || j.state === 'failed' || j.state === 'cancelled') { resolve(j); return; }
          if (++polls >= max) { reject({ error: 'timeout', message: t('lib2.jobTimeout') }); return; }
          setTimeout(step, every);
        }, function (err) {
          if (++polls >= 6) { reject(err); return; }
          setTimeout(step, every * 2);
        });
      }
      step();
    });
    p.stop = function () { stopped = true; };
    return p;
  };

  /* ---------- Install-set groups (§17.13): status computed from the queue, like dl_group_statuses() ---------- */
  var ACTIVE = { downloading: 1, connecting: 1, verifying: 1, installing: 1, extracting: 1 };
  var COMPLETE = { done: 1, installed: 1, extracted: 1 };
  cb.ACTIVE_STATES = ACTIVE; cb.COMPLETE_STATES = COMPLETE;
  cb.groups = function (jobs) {
    var map = {}, order = [];
    (jobs || []).forEach(function (j) {
      if (!j.group) return;
      if (!map[j.group]) { map[j.group] = { id: j.group, jobs: [], gameId: j.gameId, title: j.title, cover: j.cover, platform: j.platform }; order.push(j.group); }
      map[j.group].jobs.push(j);
    });
    order.forEach(function (gid) {
      var g = map[gid];
      g.jobs.sort(function (a, b) { return (a.groupOrder || 0) - (b.groupOrder || 0) || (a.addedAt || 0) - (b.addedAt || 0); });
      var total = 0, downloaded = 0, installed = 0, failed = 0, pending = 0, cancelled = 0, installing = 0, written = 0, size = 0, active = 0, queued = 0;
      var pausedAt = '', pausedJob = null;
      g.jobs.forEach(function (j) {
        total++;
        var inst = j.install || {};
        var installFailed = (j.state === 'done' || j.state === 'installing') && inst.state === 'failed';
        if (j.state === 'cancelled') { cancelled++; return; }
        size += j.total || 0; written += (COMPLETE[j.state] ? (j.total || j.written || 0) : (j.written || 0));
        if (j.state === 'failed' || installFailed) { failed++; if (!pausedJob) { pausedJob = j; pausedAt = t('game2.kind.' + (j.kind || 'game')) + ': ' + (j.filename || j.title); } }
        if (COMPLETE[j.state] || j.state === 'installing' || j.state === 'extracting') downloaded++;
        if (j.state === 'installed') installed++;
        if (j.state === 'done' && inst.state === 'pending') pending++;
        if (j.state === 'installing') installing++;
        if (ACTIVE[j.state]) active++;
        if (j.state === 'queued') queued++;
      });
      var status = failed ? 'paused' : (total - cancelled === 0) ? 'cancelled' : (downloaded < total - cancelled) ? 'downloading' : (installing || pending) ? 'installing' : 'installed';
      g.total = total; g.downloaded = downloaded; g.installed = installed; g.failed = failed; g.pending = pending; g.cancelled = cancelled;
      g.status = status; g.pausedAt = pausedAt; g.pausedJob = pausedJob; g.written = written; g.size = size; g.active = active; g.queued = queued;
      g.step = Math.min(total, downloaded + (active ? 1 : 0));
      g.tab = status === 'paused' ? 'failed' : status === 'cancelled' ? 'cancelled' : (active || status === 'installing') ? 'active' : (queued && !active) ? 'queued' : status === 'installed' ? 'finished' : 'active';
    });
    return { map: map, order: order };
  };

  /* ---------- Accessibility (§17.7): large text, high contrast, safe mode (setting or L2 held at boot) ---------- */
  var session = { safeMode: false };
  try { session.safeMode = sessionStorage.getItem('xs.safeMode') === '1'; } catch (e) { session.safeMode = false; }
  cb.safeModeSession = function () { return session.safeMode; };
  cb.safeMode = function () { return session.safeMode || cb.sget('general.safeMode', false) === true; };
  cb.setSafeModeSession = function (on) { session.safeMode = !!on; try { if (on) sessionStorage.setItem('xs.safeMode', '1'); else sessionStorage.removeItem('xs.safeMode'); } catch (e) { /* ignore */ } cb.a11y.apply(S.data.settings || {}); };
  cb.a11y = {
    apply: function (s) {
      var g = (s && s.general) || {};
      var html = document.documentElement;
      if (g.largeText) html.setAttribute('data-large-text', '1'); else html.removeAttribute('data-large-text');
      if (g.highContrast) html.setAttribute('data-contrast', 'high'); else html.removeAttribute('data-contrast');
      var safe = session.safeMode || g.safeMode === true;
      if (safe) { html.setAttribute('data-safe-mode', '1'); html.setAttribute('data-motion', 'reduce'); if (XS.sound) XS.sound.setEnabled(false); }
      else html.removeAttribute('data-safe-mode');
      if (g.controllerSwapConfirm) html.setAttribute('data-swap-confirm', '1'); else html.removeAttribute('data-swap-confirm');
      cb.remap.fixLegend();
    }
  };
  /* L2 held while the store opens → safe mode for this session (Gamepad API only; the PS5 browser exposes it). */
  (function detectL2() {
    if (!navigator.getGamepads) return;
    var tries = 0;
    function poll() {
      var pads = null;
      try { pads = navigator.getGamepads(); } catch (e) { pads = null; }
      if (pads) for (var i = 0; i < pads.length; i++) { var gp = pads[i]; if (gp && gp.connected && gp.buttons && gp.buttons[6] && (gp.buttons[6].pressed || gp.buttons[6].value > 0.5)) { if (!session.safeMode) { cb.setSafeModeSession(true); if (ui.toast && document.body) ui.toast({ cls: 'gold', title: t('a11y.safeModeSessionToast'), timeout: 6000 }); } return; } }
      if (++tries < 90) requestAnimationFrame(poll);
    }
    requestAnimationFrame(poll);
  })();
  /* Wrap applySettings once the router exists; also hook the settings event so a plain S.set() paints too. */
  function hookApply() {
    var A = XS.actions;
    if (!A || !A.applySettings || A.applySettings._cbWrapped) return;
    var orig = A.applySettings;
    var wrapped = function (s) { var r = orig.apply(this, arguments); try { cb.a11y.apply(s); } catch (e) { console.error(e); } return r; };
    wrapped._cbWrapped = true;
    A.applySettings = wrapped;
    /* XS.ca.safeMode() (web part A) only reads the setting: make it see the session flag too. */
    if (XS.ca && typeof XS.ca.safeMode === 'function' && !XS.ca.safeMode._cbWrapped) { var o2 = XS.ca.safeMode; var w2 = function () { return o2() || session.safeMode; }; w2._cbWrapped = true; XS.ca.safeMode = w2; }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', hookApply); else hookApply();
  S.on('settings', function (s) { hookApply(); cb.a11y.apply(s || {}); });

  /* ---------- Controller remap (§17.20): swap ✕/○ when general.controllerSwapConfirm is on ----------
     Gamepad path: navigator.getGamepads is wrapped so 20-nav.js sees buttons 0/1 swapped.
     Keyboard path (the PS5 browser also synthesizes Enter/Escape from the pad): a capture-phase listener
     swaps Enter ↔ Escape on pad-like devices before 20-nav.js (bubble phase on window) sees the event. */
  function swapOn() { return cb.sget('general.controllerSwapConfirm', false) === true; }
  function padLike() { return /PlayStation/i.test(navigator.userAgent) || (XS.nav && Date.now() - XS.nav.lastPadAt < 5000); }
  cb.remap = {
    enabled: swapOn,
    install: function () {
      if (navigator.getGamepads && !navigator.getGamepads._cbWrapped) {
        var orig = navigator.getGamepads.bind(navigator);
        var wrapped = function () {
          var pads = orig();
          if (!swapOn() || !pads) return pads;
          var out = [];
          for (var i = 0; i < pads.length; i++) {
            var gp = pads[i];
            if (!gp) { out.push(gp); continue; }
            var btns = Array.prototype.slice.call(gp.buttons || []);
            if (btns.length > 1) { var tmp = btns[0]; btns[0] = btns[1]; btns[1] = tmp; }
            out.push({ id: gp.id, index: gp.index, connected: gp.connected, mapping: gp.mapping, timestamp: gp.timestamp, axes: gp.axes, buttons: btns });
          }
          return out;
        };
        wrapped._cbWrapped = true;
        try { Object.defineProperty(navigator, 'getGamepads', { value: wrapped, configurable: true, writable: true }); } catch (e) { try { navigator.getGamepads = wrapped; } catch (e2) { /* read-only: pad path keeps the default map */ } }
      }
      window.addEventListener('keydown', function (e) {
        if (e._xsRemap || !swapOn() || !padLike()) return;
        if (e.key !== 'Enter' && e.key !== 'Escape') return;
        var tgt = e.target;
        if (XS.nav && XS.nav.isTyping && XS.nav.isTyping(tgt)) return;
        e.stopImmediatePropagation(); e.preventDefault();
        var key = e.key === 'Enter' ? 'Escape' : 'Enter';
        var ev;
        try { ev = new KeyboardEvent('keydown', { key: key, code: key, bubbles: true, cancelable: true, repeat: e.repeat }); } catch (err) { ev = null; }
        if (!ev) return;
        ev._xsRemap = true;
        (tgt || document.body).dispatchEvent(ev);
      }, true);
      /* Legend glyphs follow the swap. */
      var legend = U.$('#legend');
      if (legend && window.MutationObserver) { new MutationObserver(function () { cb.remap.fixLegend(); }).observe(legend, { childList: true }); }
    },
    fixLegend: function () {
      var legend = U.$('#legend'); if (!legend) return;
      var want = swapOn();
      U.$$('.hint', legend).forEach(function (hint) {
        var swapped = hint.getAttribute('data-swapped') === '1';
        if (want === swapped) return;
        var g = hint.querySelector('.glyph.cross, .glyph.circle');
        if (!g) return;
        var repl = U.svgEl(U.glyph(g.classList.contains('cross') ? 'circle' : 'cross'));
        if (repl) g.parentNode.replaceChild(repl, g);
        if (want) hint.setAttribute('data-swapped', '1'); else hint.removeAttribute('data-swapped');
      });
    }
  };
  cb.remap.install();

  /* ---------- Keyboard shortcuts overlay (?) ---------- */
  cb.shortcuts = {
    handle: null,
    open: function () {
      if (cb.shortcuts.handle && !cb.shortcuts.handle.closed) { ui.closeLayer(cb.shortcuts.handle); return; }
      var swap = swapOn();
      var rows = [
        ['←↑→↓', 'dpad', t('a11y.sc.move')], ['Enter', swap ? 'circle' : 'cross', t('a11y.sc.select')], ['Esc / Backspace', swap ? 'cross' : 'circle', t('a11y.sc.back')],
        ['F', 'square', t('a11y.sc.favorite')], ['/', 'triangle', t('a11y.sc.search')], ['Q · E', 'L1R1', t('a11y.sc.tabs')], ['O', 'options', t('a11y.sc.settings')],
        ['Ctrl / ⌘ + K', '', t('a11y.sc.palette')], ['?', '', t('a11y.sc.help')]
      ];
      var body = h('div.sc-list');
      rows.forEach(function (r) {
        var g = r[1] === 'L1R1' ? U.glyph('L1') + U.glyph('R1') : r[1] ? U.glyph(r[1]) : '';
        body.appendChild(h('div.sc-row', [h('kbd', { text: r[0] }), h('span.sc-glyph', { html: g }), h('span.grow', { text: r[2] })]));
      });
      if (swap) body.appendChild(h('p.dim.small', { text: t('a11y.sc.swapNote') }));
      cb.shortcuts.handle = ui.dialog({ title: t('a11y.shortcutsTitle'), body: [h('p', { text: t('a11y.shortcutsText') }), body], key: 'shortcuts', buttons: [{ label: t('common.close'), primary: true, autofocus: true }] });
      return cb.shortcuts.handle;
    }
  };

  /* ---------- Command palette (Ctrl/Cmd+K): screens, settings, recent games, catalog search ---------- */
  var SCREENS = [
    { id: 'discover', icon: 'compass' }, { id: 'browse', icon: 'grid' }, { id: 'homebrew', icon: 'box' }, { id: 'downloads', icon: 'download' }, { id: 'library', icon: 'library' },
    { id: 'saves', icon: 'shield' }, { id: 'updates', icon: 'refresh' }, { id: 'saveshub', icon: 'folder' }, { id: 'setup', icon: 'check' }, { id: 'settings', icon: 'settings' }
  ];
  var SETTING_GROUPS = ['general', 'downloads', 'debrid', 'sources', 'catalog', 'saves', 'accounts', 'setup', 'pair', 'updates', 'notifications', 'diagnostics', 'about', 'uninstall'];
  cb.groupLabel = function (gid) { return XS.i18n.has('set.group.' + gid) ? t('set.group.' + gid) : (XS.i18n.has('settings2.group.' + gid) ? t('settings2.group.' + gid) : gid); };
  function screenLabel(id) { var d = XS.router.defs[id]; if (d && d.label) { try { return d.label(); } catch (e) { /* fallthrough */ } } return XS.i18n.has('palette.screen.' + id) ? t('palette.screen.' + id) : id; }
  function paletteItems(q) {
    q = String(q || '').trim().toLowerCase();
    var items = [];
    SCREENS.forEach(function (s) {
      if (!XS.router.defs[s.id]) return;
      var label = screenLabel(s.id);
      if (!q || label.toLowerCase().indexOf(q) >= 0 || s.id.indexOf(q) >= 0) items.push({ kind: 'screen', icon: s.icon, label: label, sub: t('palette.kind.screen'), run: function () { XS.router.go(s.id); } });
    });
    SETTING_GROUPS.forEach(function (g) {
      var label = cb.groupLabel(g);
      if (!q || label.toLowerCase().indexOf(q) >= 0 || g.indexOf(q) >= 0) items.push({ kind: 'setting', icon: 'settings', label: t('palette.settingsArrow', { name: label }), sub: t('palette.kind.setting'), run: function () { XS.router.go('settings', { group: g }); } });
    });
    var acts = [
      { label: t('a11y.shortcutsTitle'), icon: 'gamepad', run: function () { cb.shortcuts.open(); } },
      { label: t('palette.pauseAll'), icon: 'pause', run: function () { XS.router.go('downloads'); var el = U.$('[data-nav-id="dl-pauseall"]'); if (el) el.click(); } },
      { label: t('palette.resumeAll'), icon: 'play', run: function () { XS.router.go('downloads'); var el = U.$('[data-nav-id="dl-resumeall"]'); if (el) el.click(); } },
      { label: t('palette.surprise'), icon: 'shuffle', run: function () { var gs = S.data.games.filter(function (g) { return g.platform === 'PS5' || g.platform === 'PS4'; }); if (gs.length) XS.router.go('game', { id: gs[Math.floor(Math.random() * gs.length)].id }); } }
    ];
    acts.forEach(function (a) { if (!q || a.label.toLowerCase().indexOf(q) >= 0) items.push({ kind: 'action', icon: a.icon, label: a.label, sub: t('palette.kind.action'), run: a.run }); });
    var recent = (S.data.recent || []).map(function (id) { return S.game(id); }).filter(Boolean).slice(0, 8);
    recent.forEach(function (g) { if (!q || g._search.indexOf(q) >= 0) items.push({ kind: 'game', game: g, label: g.title, sub: t('palette.kind.recent') + ' · ' + g.platform, run: function () { XS.router.go('game', { id: g.id }); } }); });
    if (q.length >= 2) {
      var hits = [];
      if (XS.ca && typeof XS.ca.search === 'function') { try { hits = XS.ca.search(q, 8) || []; } catch (e) { hits = []; } }
      if (!hits.length) { for (var i = 0; i < S.data.games.length && hits.length < 8; i++) { var g = S.data.games[i]; if (g._search && g._search.indexOf(q) >= 0 && (g.platform === 'PS5' || g.platform === 'PS4')) hits.push(g); } }
      hits.forEach(function (hit) { var g = hit && hit.g ? hit.g : (hit && hit.game ? hit.game : hit); if (!g || !g.id) return; if (recent.indexOf(g) >= 0) return; items.push({ kind: 'game', game: g, label: g.title, sub: t('palette.kind.game') + ' · ' + g.platform, run: function () { XS.router.go('game', { id: g.id }); } }); });
    }
    return items.slice(0, 24);
  }
  cb.palette = {
    handle: null,
    isOpen: function () { return !!(cb.palette.handle && !cb.palette.handle.closed); },
    open: function (initial) {
      if (cb.palette.isOpen()) { ui.closeLayer(cb.palette.handle); return null; }
      var layer = h('div.layer.palette-layer', { 'data-nav-scope': '', role: 'dialog', 'aria-label': t('palette.title') });
      layer.appendChild(h('div.backdrop'));
      var box = h('div.palette');
      var input = h('input.input', { nav: 'palette-input', type: 'text', placeholder: t('palette.placeholder'), autocomplete: 'off', spellcheck: 'false', value: initial || '', 'data-autofocus': '', 'aria-label': t('palette.title') });
      box.appendChild(h('div.palette-top', [ui.svg('search'), input, h('kbd', { text: 'Esc' })]));
      var list = h('div.palette-list', { data: { navRegion: '' } });
      box.appendChild(list);
      box.appendChild(h('div.palette-hint', [h('span', { html: U.glyph('dpad') + ' ' + U.escapeHtml(t('palette.hintMove')) }), h('span', { html: U.glyph('cross') + ' ' + U.escapeHtml(t('palette.hintOpen')) }), h('span.spacer'), h('span.dim', { text: t('palette.noMatches') })]));
      layer.appendChild(box);
      var handle = null;
      function paint() {
        var items = paletteItems(input.value);
        U.clear(list);
        items.forEach(function (it, i) {
          var row = h('button.pal-item', { nav: 'pal-' + i, data: { hints: 'open' } });
          if (it.game) { var c = ui.cover(it.game.cover, it.game.coverFallback, it.game.title); row.appendChild(c); }
          else row.appendChild(h('span.ic', { html: U.icon(it.icon || 'info') }));
          row.appendChild(h('span.grow', [h('span.l.ellipsis', { text: it.label }), h('span.s.dim', { text: it.sub || '' })]));
          row.appendChild(h('span.kind', { text: t('palette.kind.' + it.kind) }));
          row.addEventListener('click', function () { ui.closeLayer(handle); setTimeout(function () { try { it.run(); } catch (e) { console.error(e); } }, 0); });
          list.appendChild(row);
        });
        if (!items.length) list.appendChild(h('div.empty.sm', [h('h3', { text: t('palette.empty') }), h('p', { text: t('palette.emptyHint') })]));
        var hint = box.querySelector('.palette-hint .dim'); if (hint) hint.textContent = items.length ? t('palette.hintCount', { n: items.length }) : t('palette.noMatches');
      }
      input.addEventListener('input', U.debounce(paint, 60));
      input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); var first = list.querySelector('.pal-item'); if (first) first.click(); }
        else if (e.key === 'ArrowDown') { e.preventDefault(); var f = list.querySelector('.pal-item'); if (f) XS.nav.focus(f, false); }
      });
      layer.firstChild.addEventListener('click', function () { ui.closeLayer(handle); });
      handle = ui.openLayer(layer, { key: 'palette', type: 'dialog', onClose: function () { cb.palette.handle = null; } });
      cb.palette.handle = handle;
      paint();
      return handle;
    }
  };
  /* Global keys: ? → shortcuts, Ctrl/Cmd+K → palette (never while typing, except Ctrl/Cmd+K). */
  window.addEventListener('keydown', function (e) {
    if (e._xsRemap) return;
    var typing = XS.nav && XS.nav.isTyping && XS.nav.isTyping(e.target);
    if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === 'k' || e.key === 'K')) { e.preventDefault(); e.stopImmediatePropagation(); if (XS.router && XS.router.busy && XS.router.busy()) return; cb.palette.open(''); return; }
    if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === '?') { e.preventDefault(); e.stopImmediatePropagation(); cb.shortcuts.open(); }
  }, true);

  /* ---------- Rest-mode pill text (§17.15) from the queue summary, with a local fallback ---------- */
  cb.restModeText = function (summary) {
    var s = summary || {};
    if (typeof s.restMode === 'string' && s.restMode) return { on: !!s.keepAwake, text: s.restMode };
    if (s.restMode && typeof s.restMode === 'object') return { on: !!(s.restMode.keepAwake || s.keepAwake), text: s.restMode.text || s.restMode.label || s.restMode.message || '' };
    var auto = cb.sget('downloads.restModeAutoResume', true) !== false;
    if (s.keepAwake) return { on: true, text: t('dl2.restAwake') };
    return { on: false, text: auto ? t('dl2.restAllowedResume') : t('dl2.restAllowedManual') };
  };
})();
