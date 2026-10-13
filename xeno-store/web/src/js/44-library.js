/* XENO STORE — 44-library.js: storage bars per root + disk analyzer (§17.20), installed titles with Play now /
   Uninstall / Back up saves, Updates center (§17.5, §17.13), Saves hub (§17.17), copy/move between drives (§17.16),
   installed homebrew apps with "Update available" (§17.21), files on drives with actions, filters, search. */
(function () {
  'use strict';
  var XS = window.XS, U = XS.util, S = XS.state, ui = XS.ui, api = XS.api, cb = XS.cb, h = U.h, t = XS.t;
  var root = null, filesEl = null, lib = null, flt = { root: '', format: '', q: '', partial: false }, scanning = false, instEl = null, storEl = null, usageEl = null, hbEl = null, entriesEl = null;
  var usage = null, usageAt = 0, usageBusy = false;
  var versions = {};   /* titleId → {installed, version, region} from /api/saves/installed-version */

  /* ================================================================ Library ================================================================ */
  function render() {
    if (!root) return;
    U.clear(root);
    var inner = h('div.screen-inner');
    root.appendChild(inner);
    /* quick entries */
    entriesEl = h('div.lib-entries', { data: { navRegion: '' } }); inner.appendChild(entriesEl);
    renderEntries();
    /* storage */
    inner.appendChild(h('div.section-head', [h('h2.section-title', { text: t('lib.storage') }), h('span.spacer'),
      h('button.btn.sm.ghost', { nav: 'lib-analyze', html: U.icon('sliders') + '<span>' + U.escapeHtml(t('lib2.analyze')) + '</span>', on: { click: function () { loadUsage(true); } } }),
      h('button.btn.sm.ghost', { nav: 'lib-refresh-storage', html: U.icon('refresh') + '<span>' + U.escapeHtml(t('common.refresh')) + '</span>', on: { click: function () { api.storage().then(function (r) { S.set('storage', r.roots || []); }, ui.errorToast); } } })]));
    storEl = h('div.storages', { data: { navRegion: '' } }); inner.appendChild(storEl);
    renderStorage();
    usageEl = h('div.usage', { data: { navRegion: '' } }); inner.appendChild(usageEl);
    renderUsage();
    /* installed */
    inner.appendChild(h('div.section-head', [h('h2.section-title', { text: t('lib.installed') }), h('span.spacer'), h('button.btn.sm.ghost', { nav: 'lib-updates', html: U.icon('refresh') + '<span>' + U.escapeHtml(t('lib2.updatesCenter')) + '</span>', on: { click: function () { XS.router.go('updates'); } } })]));
    instEl = h('div', { data: { navRegion: '' } }); inner.appendChild(instEl);
    /* homebrew apps */
    inner.appendChild(h('div.section-head', [h('h2.section-title', { text: t('lib2.homebrewApps') }), h('span.spacer'), XS.router.defs.homebrew ? h('button.btn.sm.ghost', { nav: 'lib-hb-tab', html: U.icon('box') + '<span>' + U.escapeHtml(t('lib2.homebrewOpen')) + '</span>', on: { click: function () { XS.router.go('homebrew'); } } }) : null]));
    hbEl = h('div', { data: { navRegion: '' } }); inner.appendChild(hbEl);
    renderHomebrew();
    /* files */
    var head = h('div.section-head', [h('h2.section-title', { text: t('lib.files') }), h('span.spacer')]);
    var scan = h('button.btn.sm', { nav: 'lib-scan', html: U.icon('refresh') + '<span>' + U.escapeHtml(t('lib.scan')) + '</span>' });
    scan.addEventListener('click', function () { load(true); });
    head.appendChild(scan);
    var sm = h('button.btn.sm.ghost', { nav: 'lib-shadow', html: U.icon('zap') + '<span>' + U.escapeHtml(t('lib.shadowScan')) + '</span>' });
    sm.addEventListener('click', function () { api.shadowmountScan().then(function (r) { ui.toast({ cls: r.available ? 'good' : 'bad', title: r.available ? t('toast.shadowOk') : t('toast.shadowMissing'), desc: r.status || '' }); }, ui.errorToast); });
    head.appendChild(sm);
    inner.appendChild(head);
    var tools = h('div.lib-tools', { data: { navRegion: '' } });
    var sb = ui.searchBox({ id: 'lib-search', placeholder: t('lib.searchPlaceholder'), value: flt.q, onInput: function (v) { flt.q = v; renderFiles(); } });
    tools.appendChild(sb);
    var rootsBtn = h('button.chip' + (flt.root ? '.on' : ''), { nav: 'lib-flt-root' }, [h('span', { text: flt.root ? cb.rootLabel(flt.root) : t('lib.allDrives') }), ui.svg('chevD')]);
    rootsBtn.addEventListener('click', function () { ui.menu(rootsBtn, [{ label: t('lib.allDrives'), checked: !flt.root, onSelect: function () { flt.root = ''; render(); } }].concat((S.data.storage || []).map(function (r) { return { label: r.label, sub: r.path, checked: flt.root === r.path, onSelect: function () { flt.root = r.path; render(); } }; }))); });
    tools.appendChild(rootsBtn);
    var fmts = ['exfat', 'ffpfsc', 'ffpkg', 'ffpfs', 'pkg', 'fpkg', 'zip', 'rar', '7z', 'xpart'];
    var fmtBtn = h('button.chip' + (flt.format ? '.on' : ''), { nav: 'lib-flt-fmt' }, [h('span', { text: flt.format ? flt.format.toUpperCase() : t('filter.format') }), ui.svg('chevD')]);
    fmtBtn.addEventListener('click', function () { ui.menu(fmtBtn, [{ label: t('filter.all'), checked: !flt.format, onSelect: function () { flt.format = ''; render(); } }].concat(fmts.map(function (f) { return { label: f.toUpperCase(), checked: flt.format === f, onSelect: function () { flt.format = f; render(); } }; }))); });
    tools.appendChild(fmtBtn);
    var part = h('button.chip' + (flt.partial ? '.on' : ''), { nav: 'lib-flt-partial', text: t('lib.partialOnly') });
    part.addEventListener('click', function () { flt.partial = !flt.partial; render(); });
    tools.appendChild(part);
    inner.appendChild(tools);
    filesEl = h('div.files', { data: { navRegion: '' } }); inner.appendChild(filesEl);
    renderInstalled(); renderFiles();
    if (!lib) load(false);
    if (!usage || Date.now() - usageAt > 120000) loadUsage(false);
  }
  function renderEntries() {
    if (!entriesEl) return;
    U.clear(entriesEl);
    var n = updateCandidates().length;
    function tile(id, icon, label, desc, onClick, badge) {
      var el = h('button.lib-tile', { nav: 'lib-entry-' + id, data: { hints: 'open' } }, [h('span.ic', { html: U.icon(icon) }), h('span.grow', [h('span.l', { text: label }), h('span.d', { text: desc })]), badge ? h('span.chip.sm.gold', { text: String(badge) }) : ui.svg('chevR')]);
      el.addEventListener('click', onClick);
      return el;
    }
    entriesEl.appendChild(tile('updates', 'refresh', t('lib2.updatesCenter'), n ? t('lib2.updatesN', { n: n }) : t('lib2.updatesNone'), function () { XS.router.go('updates'); }, n || 0));
    entriesEl.appendChild(tile('saveshub', 'shield', t('lib2.savesHub'), t('lib2.savesHubDesc'), function () { XS.router.go('saveshub'); }));
    if (XS.router.defs.saves) entriesEl.appendChild(tile('saves', 'cloud', t('lib2.communitySaves'), t('lib2.communitySavesDesc'), function () { XS.router.go('saves'); }));
    entriesEl.appendChild(tile('analyzer', 'sliders', t('lib2.diskAnalyzer'), t('lib2.diskAnalyzerDesc'), function () { loadUsage(true); var el = usageEl && usageEl.querySelector('[data-nav]'); if (el) XS.nav.focus(el, true); }));
  }

  /* ---------- storage cards ---------- */
  function renderStorage() {
    if (!storEl) return;
    var fid = storEl.contains(document.activeElement) ? document.activeElement.getAttribute('data-nav-id') : null;
    U.clear(storEl);
    var roots = S.data.storage || [];
    if (!roots.length) { storEl.appendChild(ui.emptyState(t('lib.noDrives'), t('lib.noDrivesHint'))); return; }
    var queued = {};
    S.data.queue.jobs.forEach(function (j) { if (['queued', 'downloading', 'connecting', 'paused', 'failed', 'verifying'].indexOf(j.state) >= 0) queued[j.root] = (queued[j.root] || 0) + Math.max(0, (j.total || 0) - (j.written || 0)); });
    roots.forEach(function (r) {
      var used = Math.max(0, r.total - r.free), q = Math.min(r.free, queued[r.path] || 0);
      var box = h('div.storage' + (r['default'] ? '.default' : ''), { nav: 'root:' + r.path, data: { hints: 'select' } });
      var top = h('div.top', [h('span.ic', { html: U.icon(cb.rootIcon(r)), style: { width: '34px', height: '34px', borderRadius: '10px', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(255,255,255,.06)', color: 'var(--dim)' } }), h('div.grow', [h('div.name', [r.label, r['default'] ? h('span.chip.sm.gold', { text: t('lib.default'), style: { marginInlineStart: '8px' } }) : null, !r.writable ? h('span.chip.sm.bad', { text: t('lib.readOnly'), style: { marginInlineStart: '8px' } }) : null]), h('div.path', { text: r.path })])]);
      if (!r['default'] && r.writable) {
        var sd = h('button.btn.sm.ghost', { nav: 'setdef:' + r.path, text: t('lib.setDefault') });
        sd.addEventListener('click', function (e) { e.stopPropagation(); api.storageDefault(r.path).then(function () { return api.storage(); }).then(function (res) { S.set('storage', res.roots || []); ui.toast({ cls: 'good', title: t('toast.defaultSet', { label: r.label }) }); }, ui.errorToast); });
        top.appendChild(sd);
      }
      box.appendChild(top);
      var bar = h('div.bar', [h('i', { style: { width: (r.total ? used / r.total * 100 : 0).toFixed(1) + '%' } })]);
      if (q) bar.appendChild(h('span.q', { style: { left: (r.total ? used / r.total * 100 : 0).toFixed(1) + '%', width: (r.total ? q / r.total * 100 : 0).toFixed(1) + '%' } }));
      box.appendChild(bar);
      var nums = h('div.nums', [h('span', [t('lib.used') + ' ', h('b', { text: U.fmtBytes(used) })]), h('span', [t('lib.free') + ' ', h('b', { text: U.fmtBytes(r.free) })]), h('span', [t('lib.total') + ' ', h('b', { text: U.fmtBytes(r.total) })])]);
      if (q) nums.appendChild(h('span.gold', [t('lib.queued') + ' ', h('b', { text: U.fmtBytes(q) })]));
      box.appendChild(nums);
      box.addEventListener('click', function () { flt.root = flt.root === r.path ? '' : r.path; render(); XS.nav.remember('library', 'root:' + r.path); XS.nav.restore(); });
      storEl.appendChild(box);
    });
    if (fid) { var again = storEl.querySelector('[data-nav-id="' + fid + '"]'); if (again) XS.nav.focus(again, false); }
  }

  /* ---------- disk analyzer (§17.20): what uses space per root, by category, with "Clean up partials" ---------- */
  var CATS = [['games', 'gold'], ['dumps', 'acc'], ['packages', 'good'], ['files', 'warn'], ['saves', 'royal'], ['partials', 'bad']];
  function loadUsage(force) {
    if (usageBusy) return;
    if (!force && usage && Date.now() - usageAt < 120000) { renderUsage(); return; }
    usageBusy = true;
    if (usageEl && !usage) { U.clear(usageEl); usageEl.appendChild(cb.busy(t('lib2.analyzing'))); }
    cb.api.libraryUsage().then(function (r) { usageBusy = false; usage = r; usageAt = Date.now(); renderUsage(); }, function (err) { usageBusy = false; usage = usage || { roots: [], error: err }; usageAt = Date.now(); renderUsage(); });
  }
  function renderUsage() {
    if (!usageEl) return;
    U.clear(usageEl);
    if (!usage) return;
    var roots = usage.roots || [];
    if (!roots.length) { if (usage.error) usageEl.appendChild(cb.note(t('lib2.analyzeFailed') + ' ' + ui.errorText(usage.error), 'warn')); return; }
    var head = h('div.usage-head', [h('span.kicker.sm', { text: t('lib2.diskAnalyzer') }), h('span.spacer'), h('span.dim.small', { text: usage.scannedAt ? t('lib2.analyzedAt', { when: cb.fmtAgo(usage.scannedAt) }) : '' })]);
    usageEl.appendChild(head);
    roots.forEach(function (r, i) {
      var cat = r.categories || {};
      var total = r.total || 1, used = r.used !== undefined ? r.used : Math.max(0, (r.total || 0) - (r.free || 0));
      var known = 0; CATS.forEach(function (c) { known += cat[c[0]] || 0; });
      var other = Math.max(0, used - known);
      var card = h('div.usage-card', { nav: 'usage:' + r.path, data: { hints: 'select' } });
      card.appendChild(h('div.top', [h('span.ic', { html: U.icon(cb.rootIcon(r)) }), h('span.name', { text: r.label || r.path }), h('span.dim.small', { text: U.fmtBytes(used) + ' ' + t('lib.used').toLowerCase() + ' · ' + U.fmtBytes(r.free) + ' ' + t('lib.free').toLowerCase() })]));
      var bar = h('div.ubar');
      CATS.forEach(function (c) { var v = cat[c[0]] || 0; if (v > 0) bar.appendChild(h('i.' + c[1], { style: { width: Math.max(0.4, v / total * 100).toFixed(2) + '%' }, title: t('lib2.cat.' + c[0]) + ' · ' + U.fmtBytes(v) })); });
      if (other > 0) bar.appendChild(h('i.other', { style: { width: (other / total * 100).toFixed(2) + '%' }, title: t('lib2.cat.other') + ' · ' + U.fmtBytes(other) }));
      card.appendChild(bar);
      var legend = h('div.ulegend');
      CATS.forEach(function (c) { var v = cat[c[0]] || 0; legend.appendChild(h('span.li' + (v ? '' : '.zero'), [h('i.' + c[1]), h('span', { text: t('lib2.cat.' + c[0]) }), h('b', { text: U.fmtBytes(v) })])); });
      legend.appendChild(h('span.li' + (other ? '' : '.zero'), [h('i.other'), h('span', { text: t('lib2.cat.other') }), h('b', { text: U.fmtBytes(other) })]));
      card.appendChild(legend);
      var partials = r.partials || [];
      var pbytes = cat.partials || partials.reduce(function (n, p) { return n + (p.size || 0); }, 0);
      var foot = h('div.ufoot');
      if (pbytes > 0) {
        foot.appendChild(h('span.dim.small', { text: t('lib2.partialsOn', { n: partials.length, size: U.fmtBytes(pbytes) }) }));
        var clean = h('button.btn.sm', { nav: 'usage-clean-' + i, html: U.icon('trash') + '<span>' + U.escapeHtml(t('lib2.cleanPartials')) + '</span>' });
        clean.addEventListener('click', function (e) { e.stopPropagation(); cleanPartials(r, partials, pbytes); });
        foot.appendChild(h('span.spacer')); foot.appendChild(clean);
      } else foot.appendChild(h('span.dim.small', { text: t('lib2.noPartials') }));
      card.appendChild(foot);
      card.addEventListener('click', function () { flt.root = flt.root === r.path ? '' : r.path; renderFiles(); var fb = root.querySelector('[data-nav-id="lib-flt-root"]'); if (fb) { fb.classList.toggle('on', !!flt.root); fb.querySelector('span').textContent = flt.root ? cb.rootLabel(flt.root) : t('lib.allDrives'); } });
      usageEl.appendChild(card);
    });
  }
  function cleanPartials(r, partials, bytes) {
    var owned = partials.filter(function (p) { return p.jobId; }).length;
    ui.confirm(t('lib2.cleanTitle'), t('lib2.cleanText', { n: partials.length, size: U.fmtBytes(bytes), label: r.label || r.path }) + (owned ? ' ' + t('lib2.cleanOwned', { n: owned }) : ''), t('lib2.cleanPartials'), true).then(function (ok) {
      if (!ok) return;
      cb.api.libraryClean(r.path).then(function (res) {
        ui.toast({ cls: 'good', title: t('lib2.cleanDone', { n: res.removedCount || (res.removed || []).length, size: U.fmtBytes(res.freed || 0) }), desc: (res.skipped || []).length ? t('lib2.cleanSkipped', { n: res.skipped.length }) : '' });
        loadUsage(true); load(true); api.storage().then(function (x) { S.set('storage', x.roots || []); }, function () { /* ignore */ });
      }, function (err) { ui.errorToast(err, t('lib2.cleanPartials')); });
    });
  }

  /* ---------- library scan ---------- */
  function load(scan) {
    if (scanning) return;
    scanning = true;
    if (filesEl && scan) { U.clear(filesEl); filesEl.appendChild(cb.busy(t('lib.scanning'))); }
    api.library(scan).then(function (r) { scanning = false; lib = r; S.set('library', r); renderInstalled(); renderFiles(); renderEntries(); renderHomebrew(); if (scan) ui.toast({ cls: 'good', title: t('toast.scanDone', { n: (r.files || []).length }) }); }, function (err) { scanning = false; if (filesEl) { U.clear(filesEl); filesEl.appendChild(ui.emptyState(t('lib.scanFailed'), ui.errorText(err))); } });
  }
  function gameFor(it) { return (it.gameId && S.game(it.gameId)) || (it.titleId && S.data.byTitleId[it.titleId]) || null; }
  function renderInstalled() {
    if (!instEl) return;
    U.clear(instEl);
    var inst = (lib && lib.installed) || [];
    if (!inst.length) { instEl.appendChild(h('p.dim', { text: lib ? t('lib.noInstalled') : t('lib.loading') })); return; }
    var grid = h('div.installed-grid');
    inst.forEach(function (it) {
      var g = gameFor(it);
      var title = it.title || (g && g.title) || it.titleId;
      var el = h('div.inst', { nav: 'inst:' + it.titleId, data: { hints: 'jobmenu' } });
      el.appendChild(ui.cover(it.cover || (g && g.cover), g && g.coverFallback, title));
      el.appendChild(h('div.t.ellipsis', { text: title }));
      var up = updatesFor(it);
      el.appendChild(h('div.id', [h('span', { text: it.titleId }), up.length ? h('span.chip.sm.warn', { text: t('lib2.updateChip') }) : null]));
      var acts = h('div.inst-acts');
      var play = h('button.btn.sm.primary', { nav: 'play:' + it.titleId, html: U.icon('play') + '<span>' + U.escapeHtml(t('lib2.playNow')) + '</span>' });
      play.addEventListener('click', function (e) { e.stopPropagation(); playNow(it, title); });
      acts.appendChild(play);
      var more = h('button.btn.sm.icon-only', { nav: 'instmore:' + it.titleId, html: U.icon('more'), 'aria-label': t('common.more') });
      more.addEventListener('click', function (e) { e.stopPropagation(); installedMenu(more, it, g, title); });
      acts.appendChild(more);
      el.appendChild(acts);
      el.addEventListener('click', function (e) { if (e.target.closest('button')) return; installedMenu(el, it, g, title); });
      grid.appendChild(el);
    });
    instEl.appendChild(grid);
  }
  function playNow(it, title) {
    cb.api.libraryLaunch(it.titleId).then(function (r) {
      ui.toast({ cls: 'gold', icon: 'play', title: t('lib2.launching', { title: r.title || title }), desc: r.simulated ? t('lib2.simulatedHost') : '' });
    }, function (err) { ui.errorToast(err, t('lib2.playNow')); });
  }
  function installedMenu(anchor, it, g, title) {
    var items = [];
    items.push({ label: t('lib2.playNow'), icon: 'play', onSelect: function () { playNow(it, title); } });
    if (g) items.push({ label: t('lib.openGame'), icon: 'external', onSelect: function () { XS.router.go('game', { id: g.id }); } });
    var ups = updatesFor(it);
    if (ups.length) items.push({ label: t('lib2.updateAvailable', { v: ups[0].version || '' }), sub: t('lib2.openUpdates'), icon: 'refresh', onSelect: function () { XS.router.go('updates', { titleId: it.titleId }); } });
    items.push({ label: t('lib2.backUpSaves'), icon: 'shield', onSelect: function () { XS.router.go('saveshub', { titleId: it.titleId }); } });
    items.push({ label: t('lib2.dumpGame'), sub: t('lib2.dumpGameSub'), icon: 'box', onSelect: function () { dumpGame(it, title); } });
    items.push('sep');
    items.push({ label: t('lib2.uninstallGame'), icon: 'trash', danger: true, onSelect: function () { uninstallGame(it, title); } });
    ui.menu(anchor, items, { title: title });
  }
  function uninstallGame(it, title) {
    cb.doubleConfirm(t('lib2.uninstallTitle', { title: title }), t('lib2.uninstallText', { id: it.titleId }), t('lib2.uninstallGame'), t('lib2.uninstallSure', { title: title })).then(function (ok) {
      if (!ok) return;
      cb.api.libraryUninstall(it.titleId, '').then(function (r) {
        if (r.confirmRequired && r.token) return cb.api.libraryUninstall(it.titleId, r.token);
        return r;
      }).then(function (r) {
        ui.toast({ cls: 'good', title: t('lib2.uninstalled', { title: title }), desc: r && r.simulated ? t('lib2.simulatedHost') : t('lib2.uninstalledSaves') });
        load(true); loadUsage(true); api.storage().then(function (x) { S.set('storage', x.roots || []); }, function () { /* ignore */ });
      }, function (err) { ui.errorToast(err, t('lib2.uninstallGame')); });
    });
  }
  function dumpGame(it, title) {
    cb.api.payloads().then(function (r) {
      var list = r.payloads || [];
      var dumper = list.filter(function (p) { return /dump/i.test((p.id || '') + ' ' + (p.name || '') + ' ' + (p.kind || '')); })[0];
      var body = [h('p', { text: t('lib2.dumpText', { title: title, id: it.titleId }) }), cb.note(t('lib2.dumpSteps'), '', 'info')];
      var buttons = [];
      if (dumper && dumper.installed) buttons.push({ label: t('lib2.dumpLaunch', { name: dumper.name }), primary: true, onClick: function (hd) { cb.api.payloadLaunch(dumper.id).then(function () { ui.toast({ cls: 'gold', title: t('companions.sent', { name: dumper.name }) }); ui.closeLayer(hd); }, function (err) { ui.errorToast(err, dumper.name); }); } });
      else buttons.push({ label: t('lib2.dumpGet'), primary: true, onClick: function (hd) { ui.closeLayer(hd); XS.router.go('setup', { section: 'payloads' }); } });
      buttons.push({ label: t('common.close'), autofocus: true });
      ui.dialog({ title: t('lib2.dumpGame'), body: body, buttons: buttons });
    }, function (err) { ui.errorToast(err, t('lib2.dumpGame')); });
  }

  /* ---------- installed homebrew apps (§17.21) ---------- */
  function renderHomebrew() {
    if (!hbEl) return;
    U.clear(hbEl);
    if (!XS.homebrew || !XS.homebrew.load) { hbEl.appendChild(h('p.dim', { text: t('lib2.homebrewNone') })); return; }
    hbEl.appendChild(cb.busy(t('lib.loading')));
    XS.homebrew.load().then(function (apps) {
      if (!hbEl) return;
      U.clear(hbEl);
      var installedIds = {};
      ((lib && lib.installed) || []).forEach(function (x) { installedIds[x.titleId] = 1; });
      var mine = (apps || []).filter(function (a) { return a.installedVersion || (a.titleId && installedIds[a.titleId]); });
      if (!mine.length) { hbEl.appendChild(h('p.dim', { text: t('lib2.homebrewNone') })); return; }
      var list = h('div.list');
      mine.forEach(function (a) {
        var iv = a.installedVersion || '';
        var newer = iv && a.version && cb.semverCmp(a.version, iv) > 0;
        var row = h('div.lrow.hbrow', { nav: 'hb:' + a.id, data: { hints: 'open' } });
        row.appendChild(ui.cover(XS.ca && XS.ca.api ? XS.ca.api.imageUrl(a.cover) : a.cover, '', a.title));
        var main = h('div.main', [h('div.name.ellipsis', { text: a.title }), h('div.desc', { text: [a.author, a.category].filter(Boolean).join(' · ') })]);
        var tags = h('div.tags');
        tags.appendChild(iv ? h('span.chip.sm.good', { text: t('lib2.installedV', { v: iv }) }) : h('span.chip.sm.good', { text: t('dl.state.installed') }));
        if (newer) tags.appendChild(h('span.chip.sm.warn', { html: U.icon('refresh') + '<span>' + U.escapeHtml(t('lib2.updateAvailable', { v: a.version })) + '</span>' }));
        main.appendChild(tags);
        row.appendChild(main);
        if (newer) {
          var rel = (a.releases || []).slice().sort(function (x, y) { return (x.platform === 'PS5' ? 0 : 1) - (y.platform === 'PS5' ? 0 : 1); })[0];
          var up = h('button.btn.sm.primary', { nav: 'hbup:' + a.id, html: U.icon('download') + '<span>' + U.escapeHtml(t('lib2.updateBtn')) + '</span>' });
          up.addEventListener('click', function (e) { e.stopPropagation(); if (rel && XS.homebrew.install) XS.homebrew.install(a, rel); else if (XS.router.defs.hbapp) XS.router.go('hbapp', { id: a.id }); });
          row.appendChild(up);
        }
        row.appendChild(h('span.val', { html: U.icon('chevR') }));
        row.addEventListener('click', function (e) { if (e.target.closest('button')) return; if (XS.router.defs.hbapp) XS.router.go('hbapp', { id: a.id }); });
        list.appendChild(row);
      });
      hbEl.appendChild(list);
    }, function () { if (hbEl) { U.clear(hbEl); hbEl.appendChild(h('p.dim', { text: t('lib2.homebrewNone') })); } });
  }

  /* ---------- files on drives ---------- */
  function renderFiles() {
    if (!filesEl) return;
    U.clear(filesEl);
    if (!lib) { filesEl.appendChild(ui.skeletonRail(1)); return; }
    var files = (lib.files || []).filter(function (f) {
      if (flt.root && f.root !== flt.root) return false;
      if (flt.format && String(f.format || '').toLowerCase() !== flt.format) return false;
      if (flt.partial && !f.partial) return false;
      if (flt.q && (f.name + ' ' + (f.title || '') + ' ' + (f.titleId || '')).toLowerCase().indexOf(flt.q.toLowerCase()) < 0) return false;
      return true;
    });
    if (!files.length) { filesEl.appendChild(ui.emptyState(t('lib.noFiles'), t('lib.noFilesHint'))); return; }
    files.sort(function (a, b) { return (b.mtime || 0) - (a.mtime || 0); });
    files.forEach(function (f) {
      var g = gameFor(f);
      var row = h('button.lrow.frow', { nav: 'file:' + f.path, data: { hints: 'jobmenu' } });
      if (g || f.cover) row.appendChild(ui.cover(f.cover || (g && g.cover), g && g.coverFallback, f.title || (g && g.title) || f.name));
      else row.appendChild(h('span.ic.fmt', { text: String(f.format || '?').toUpperCase().slice(0, 5) }));
      var main = h('div.main', [h('div.name.ellipsis', { text: f.title || (g && g.title) || f.name }), h('div.path', { text: f.path })]);
      var tags = h('div.tags', [h('span.chip.fmt.sm', { text: String(f.format || '').toUpperCase() })]);
      if (f.titleId) tags.appendChild(h('span.chip.sm', { text: f.titleId }));
      if (f.partial) tags.appendChild(h('span.chip.sm.warn', { text: t('lib.partial') }));
      if (f.jobId) tags.appendChild(h('span.chip.sm.acc', { text: t('lib.inQueue') }));
      tags.appendChild(h('span.chip.sm', { text: cb.rootLabel(f.root) }));
      main.appendChild(tags);
      row.appendChild(main);
      row.appendChild(h('span.sz', { text: U.fmtBytes(f.size) }));
      row.appendChild(h('span.val', { html: U.icon('more') }));
      row.addEventListener('click', function () { fileMenu(row, f, g); });
      filesEl.appendChild(row);
    });
  }
  function fileMenu(anchor, f, g) {
    var fmt = String(f.format || '').toLowerCase();
    var items = [];
    if (g) items.push({ label: t('lib.openGame'), icon: 'external', onSelect: function () { XS.router.go('game', { id: g.id }); } });
    if (fmt === 'pkg' || fmt === 'fpkg') items.push({ label: t('lib.installPkg'), icon: 'box', onSelect: function () { api.libraryInstall(f.path).then(function () { ui.toast({ cls: 'gold', title: t('toast.installStarted'), desc: f.name }); XS.actions.refreshQueue(); XS.router.go('downloads'); }, ui.errorToast); } });
    if (cb.isImage(fmt)) items.push({ label: t('lib.shadowScan'), icon: 'zap', onSelect: function () { api.shadowmountScan().then(function (r) { ui.toast({ cls: r.available ? 'good' : 'bad', title: r.available ? t('toast.shadowOk') : t('toast.shadowMissing'), desc: r.status || '' }); }, ui.errorToast); } });
    if (!f.partial && (S.data.storage || []).length > 1) {
      items.push({ label: t('lib2.copyTo'), icon: 'copy', onSelect: function () { transferSheet(f, g, false); } });
      items.push({ label: t('lib2.moveTo'), icon: 'swap', onSelect: function () { transferSheet(f, g, true); } });
    }
    if (f.jobId) items.push({ label: t('game.viewDownloads'), icon: 'download', onSelect: function () { XS.router.go('downloads'); } });
    items.push({ label: t('lib.copyPath'), icon: 'copy', onSelect: function () { U.copyText(f.path).then(function (ok) { ui.toast({ cls: ok ? 'good' : 'bad', title: ok ? t('toast.copied') : t('toast.copyFailed') }); }); } });
    items.push('sep');
    items.push({ label: t('lib.deleteFile'), icon: 'trash', danger: true, onSelect: function () {
      ui.confirm(t('lib.deleteTitle'), t('lib.deleteText', { name: f.name, size: U.fmtBytes(f.size) }), t('common.delete'), true).then(function (ok) {
        if (!ok) return;
        api.libraryDelete(f.path).then(function () { ui.toast({ cls: 'good', title: t('toast.deleted', { name: f.name }) }); load(true); loadUsage(true); api.storage().then(function (r) { S.set('storage', r.roots || []); }, function () { /* ignore */ }); }, ui.errorToast);
      });
    } });
    ui.menu(anchor, items, { title: f.name });
  }

  /* ---------- copy / move between drives (§17.16): destination + space check → POST /api/library/transfer ---------- */
  function transferSheet(f, g, move) {
    var st = { move: !!move, root: null, fits: null, checking: false };
    var MARGIN = 256 * 1024 * 1024;
    var handle = ui.sheet({
      title: move ? t('lib2.moveTo') : t('lib2.copyTo'), sub: f.name, cls: 'narrow', key: 'transfer:' + f.path,
      body: function (body) {
        var hero = h('div.cover-hero');
        if (g || f.cover) hero.appendChild(ui.cover(f.cover || (g && g.cover), g && g.coverFallback, f.title || f.name)); else hero.appendChild(h('span.ic.fmt.big', { text: String(f.format || '?').toUpperCase().slice(0, 5) }));
        hero.appendChild(h('div.grow', [h('h4', { text: f.title || (g && g.title) || f.name }), h('div.meta', { text: U.fmtBytes(f.size) + ' · ' + cb.rootLabel(f.root) })]));
        body.appendChild(hero);
        body.appendChild(h('div.panel', [h('div.row', [ui.svg('folder'), h('span.dim.small.mono', { text: f.path, style: { marginTop: 0, overflowWrap: 'anywhere' } })])]));
        body.appendChild(h('h3', { text: t('lib2.transferMode') }));
        body.appendChild(ui.segControl({ id: 'tr-mode', value: st.move ? 'move' : 'copy', options: [{ value: 'copy', label: t('dl2.copy') }, { value: 'move', label: t('dl2.move') }], onChange: function (v) { st.move = v === 'move'; handle.head.querySelector('h2').textContent = st.move ? t('lib2.moveTo') : t('lib2.copyTo'); paintFoot(); } }));
        body.appendChild(h('p.dim.small', { text: t('lib2.transferModeHint') }));
        body.appendChild(h('h3', { text: t('lib2.destination') }));
        body.appendChild(cb.rootRows({ id: 'tr-root', filter: function (r) { return r.path !== f.root; }, disabled: function (r) { return !r.writable; },
          desc: function (r) { var fits = r.free >= (f.size || 0) + MARGIN; return r.path + ' · ' + t('dl.free', { n: U.fmtBytes(r.free) }) + ' · ' + (fits ? t('dl.fits') : t('dl.noSpace')); },
          onPick: function (r) { st.root = r; st.fits = r.free >= (f.size || 0) + MARGIN; paintFoot(); checkSpace(r); } }));
        if ((S.data.storage || []).filter(function (r) { return r.path !== f.root; }).length === 0) body.appendChild(cb.note(t('lib2.transferSameDrive'), 'warn'));
        var sp = h('div.space-line', { 'data-space': '' });
        body.appendChild(sp);
        body.appendChild(cb.note(t('lib2.transferNote'), '', 'info'));
      },
      foot: [h('span.spacer'), h('button.btn.primary.lg', { nav: 'tr-start', 'data-start': '', text: move ? t('lib2.moveStart') : t('lib2.copyStart'), on: { click: start } })]
    });
    function checkSpace(r) {
      var line = handle.body.querySelector('[data-space]'); if (!line) return;
      U.clear(line); line.appendChild(h('span.dim.small', { text: t('lib2.checkingSpace') }));
      st.checking = true;
      cb.api.space(r.path, f.size || 0).then(function (sres) {
        st.checking = false;
        if (st.root !== r) return;
        st.fits = sres.fits !== undefined ? !!sres.fits : st.fits;
        U.clear(line);
        line.appendChild(h('span' + (st.fits ? '.good' : '.bad'), { html: U.icon(st.fits ? 'check' : 'alert') + ' ' + U.escapeHtml(st.fits ? t('lib2.spaceOk', { n: U.fmtBytes(sres.afterThis || 0) }) : t('lib2.spaceNo', { n: U.fmtBytes(Math.max(0, -(sres.afterThis || 0))) })) }));
        paintFoot();
      }, function () { st.checking = false; U.clear(line); paintFoot(); });
    }
    function paintFoot() {
      var b = handle.foot.querySelector('[data-start]');
      b.textContent = st.move ? t('lib2.moveStart') : t('lib2.copyStart');
      if (!st.root || st.fits === false) b.setAttribute('disabled', ''); else b.removeAttribute('disabled');
    }
    function start() {
      if (!st.root || st.fits === false) return;
      var b = handle.foot.querySelector('[data-start]'); b.classList.add('busy');
      cb.api.libraryTransfer(f.path, st.root.path, st.move).then(function (r) {
        b.classList.remove('busy');
        ui.closeLayer(handle);
        XS.actions.refreshQueue();
        ui.toast({ cls: 'gold', title: st.move ? t('lib2.moveQueued', { label: st.root.label }) : t('lib2.copyQueued', { label: st.root.label }), desc: f.name, action: { label: t('game.viewDownloads'), onClick: function () { XS.router.go('downloads'); } } });
      }, function (err) { b.classList.remove('busy'); ui.errorToast(err, st.move ? t('lib2.moveTo') : t('lib2.copyTo')); });
    }
    paintFoot();
  }

  /* ================================================================ Updates center (§17.5, §17.13) ================================================================ */
  var upRoot = null, upTitle = '';
  function kindOf(r) { if (!r) return 'game'; if (r.format === 'PAGE') return 'page'; return r.kind || 'game'; }
  function versionOf(titleId) { var v = versions[titleId]; return v && v.installed && v.version ? v.version : ''; }
  /* Every installed title + every downloaded (non-partial) file with a title ID; one entry per title ID. */
  function titleEntries() {
    var out = [], seen = {};
    ((lib && lib.installed) || []).forEach(function (it) { if (!it.titleId || seen[it.titleId]) return; seen[it.titleId] = 1; out.push({ titleId: it.titleId, game: gameFor(it), title: it.title, cover: it.cover, installed: true, path: it.path }); });
    ((lib && lib.files) || []).forEach(function (f) { if (!f.titleId || f.partial || seen[f.titleId]) return; var g = gameFor(f); if (!g) return; seen[f.titleId] = 1; out.push({ titleId: f.titleId, game: g, title: f.title || g.title, cover: f.cover || g.cover, installed: false, path: f.path, format: f.format }); });
    return out;
  }
  function updatesFor(it) {
    var g = gameFor(it); if (!g) return [];
    var cur = versionOf(it.titleId);
    var ups = (g.releases || []).filter(function (r) { return kindOf(r) === 'update' && r.format !== 'PAGE' && (!r.titleId || r.titleId === it.titleId || (g.titleIds || []).length === 1); });
    ups.sort(function (a, b) { return cb.semverCmp(b.version, a.version); });
    if (cur) ups = ups.filter(function (r) { return r.version && cb.semverCmp(r.version, cur) > 0; });
    return ups;
  }
  function backportsFor(e) {
    var g = e.game; if (!g) return [];
    var fw = cb.fwNum(cb.consoleFw()); if (!fw) return [];
    var base = (g.releases || []).filter(function (r) { return kindOf(r) === 'game' && r.requiresFw; });
    var need = 0; base.forEach(function (r) { need = Math.max(need, cb.fwNum(r.requiresFw)); });
    if (!need || need <= fw) return [];
    var bps = (g.releases || []).filter(function (r) { return kindOf(r) === 'backport' && r.format !== 'PAGE' && (!r.backportFw || cb.fwNum(r.backportFw) <= fw); });
    bps.sort(function (a, b) { return cb.fwNum(b.backportFw) - cb.fwNum(a.backportFw) || cb.semverCmp(b.version, a.version); });
    return bps;
  }
  function updateCandidates() {
    return titleEntries().map(function (e) { e.updates = updatesFor(e); e.backports = backportsFor(e); return e; }).filter(function (e) { return e.updates.length || e.backports.length; });
  }
  function fetchVersions(entries) {
    var todo = entries.filter(function (e) { return e.installed && !versions[e.titleId]; }).slice(0, 40);
    if (!todo.length) return Promise.resolve(false);
    var i = 0, changed = false;
    function next() {
      if (i >= todo.length) return Promise.resolve(changed);
      var batch = todo.slice(i, i + 6); i += 6;
      return Promise.all(batch.map(function (e) { return cb.api.installedVersion(e.titleId).then(function (r) { versions[e.titleId] = { installed: r.installed !== false, version: r.version || '', region: r.region || '' }; changed = true; }, function () { versions[e.titleId] = { installed: true, version: '', region: '' }; }); })).then(next);
    }
    return next();
  }
  function renderUpdates() {
    if (!upRoot) return;
    U.clear(upRoot);
    var inner = h('div.screen-inner'); upRoot.appendChild(inner);
    inner.appendChild(h('div.page-head', [h('div.grow', [h('span.kicker', { text: t('nav.library') }), h('h1', { text: t('lib2.updatesCenter') }), h('p.dim', { text: t('lib2.updatesSub') })])]));
    var body = h('div.updates', { data: { navRegion: '' } }); inner.appendChild(body);
    if (!lib) { body.appendChild(cb.busy(t('lib.loading'))); api.library(false).then(function (r) { lib = r; S.set('library', r); renderUpdates(); }, function (err) { U.clear(body); body.appendChild(ui.emptyState(t('lib.scanFailed'), ui.errorText(err))); }); return; }
    var entries = titleEntries();
    fetchVersions(entries).then(function (changed) { if (changed && upRoot.classList.contains('active')) paintUpdates(body, entries); });
    paintUpdates(body, entries);
  }
  function paintUpdates(body, entries) {
    U.clear(body);
    var cands = entries.map(function (e) { e.updates = updatesFor(e); e.backports = backportsFor(e); return e; });
    var withUp = cands.filter(function (e) { return e.updates.length; });
    var withBp = cands.filter(function (e) { return e.backports.length; });
    var upToDate = cands.filter(function (e) { return !e.updates.length && !e.backports.length; });
    var fw = cb.consoleFw();
    var toolbar = h('div.toolbar', { style: { marginBottom: '14px' } });
    toolbar.appendChild(h('span.chip.gold', { text: t('lib2.updatesN', { n: withUp.length }) }));
    if (withBp.length) toolbar.appendChild(h('span.chip.warn', { text: t('lib2.backportsN', { n: withBp.length }) }));
    if (fw) toolbar.appendChild(h('span.chip', { text: t('game2.firmware') + ' ' + fw }));
    toolbar.appendChild(h('span.spacer'));
    if (withUp.length > 1) { var all = h('button.btn.sm.primary', { nav: 'up-all', html: U.icon('download') + '<span>' + U.escapeHtml(t('lib2.updateAll', { n: withUp.length })) + '</span>' }); all.addEventListener('click', function () { updateAll(withUp); }); toolbar.appendChild(all); }
    var rescan = h('button.btn.sm.ghost', { nav: 'up-rescan', html: U.icon('refresh') + '<span>' + U.escapeHtml(t('lib.scan')) + '</span>' });
    rescan.addEventListener('click', function () { api.library(true).then(function (r) { lib = r; S.set('library', r); versions = {}; renderUpdates(); }, ui.errorToast); });
    toolbar.appendChild(rescan);
    body.appendChild(toolbar);
    if (!cands.length) { body.appendChild(ui.emptyState(t('lib2.updatesEmptyTitle'), t('lib2.updatesEmptyHint'))); return; }
    if (withUp.length) {
      body.appendChild(h('h2.section-title', { text: t('lib2.updatesAvailable'), style: { margin: '10px 0 8px' } }));
      var list = h('div.list');
      withUp.forEach(function (e) { list.appendChild(updateRow(e, e.updates[0], 'update')); });
      body.appendChild(list);
    }
    if (withBp.length) {
      body.appendChild(h('h2.section-title', { text: t('lib2.backportsAvailable'), style: { margin: '18px 0 8px' } }));
      body.appendChild(h('p.dim.small', { text: t('lib2.backportsHint', { fw: fw }) }));
      var list2 = h('div.list');
      withBp.forEach(function (e) { list2.appendChild(updateRow(e, e.backports[0], 'backport')); });
      body.appendChild(list2);
    }
    if (upToDate.length) {
      body.appendChild(h('h2.section-title', { text: t('lib2.upToDate'), style: { margin: '18px 0 8px' } }));
      var list3 = h('div.list');
      upToDate.forEach(function (e) {
        var v = versionOf(e.titleId);
        var row = h('button.lrow.uprow', { nav: 'ok:' + e.titleId, data: { hints: 'open' } });
        row.appendChild(ui.cover(e.cover || (e.game && e.game.cover), e.game && e.game.coverFallback, e.title || e.titleId));
        row.appendChild(h('div.main', [h('div.name.ellipsis', { text: e.title || (e.game && e.game.title) || e.titleId }), h('div.desc', { text: e.titleId + (v ? ' · v' + v : '') + ' · ' + (e.installed ? t('dl.state.installed') : t('lib2.downloadedFile')) })]));
        row.appendChild(h('span.chip.sm.good', { html: U.icon('check') + '<span>' + U.escapeHtml(v ? t('lib2.upToDateV', { v: v }) : t('lib2.noNewer')) + '</span>' }));
        row.addEventListener('click', function () { if (e.game) XS.router.go('game', { id: e.game.id }); });
        list3.appendChild(row);
      });
      body.appendChild(list3);
    }
    if (upTitle) { var target = body.querySelector('[data-nav-id="up:' + upTitle + '"]'); if (target) { XS.nav.focus(target, true); } upTitle = ''; }
  }
  function updateRow(e, r, kind) {
    var cur = versionOf(e.titleId);
    var row = h('div.lrow.uprow', { nav: (kind === 'backport' ? 'bp:' : 'up:') + e.titleId, data: { hints: 'jobmenu' } });
    row.appendChild(ui.cover(e.cover || (e.game && e.game.cover), e.game && e.game.coverFallback, e.title || e.titleId));
    var main = h('div.main', [h('div.name.ellipsis', { text: e.title || (e.game && e.game.title) || e.titleId })]);
    var desc = e.titleId + ' · ' + (e.installed ? (cur ? t('lib2.installedV', { v: cur }) : t('lib2.installedUnknownV')) : t('lib2.downloadedFile'));
    main.appendChild(h('div.desc', { text: desc }));
    var tags = h('div.tags');
    if (kind === 'backport') tags.appendChild(h('span.chip.sm.warn', { text: t('game2.kind.backport') + (r.backportFw ? ' · ' + t('game2.forFw', { fw: r.backportFw }) : '') }));
    else tags.appendChild(h('span.chip.sm.acc', { text: t('lib2.updateV', { v: r.version || '?' }) }));
    tags.appendChild(h('span.chip.fmt.sm', { text: ui.fmtLabel(r.format) }));
    if (r.sizeBytes) tags.appendChild(h('span.chip.sm', { text: U.fmtBytes(r.sizeBytes) }));
    if (r.provider) tags.appendChild(h('span.chip.sm', { text: r.provider }));
    if (r.sha256) tags.appendChild(h('span.chip.sm.gold', { text: t('dl.hashKnown') }));
    var n = kind === 'backport' ? e.backports.length : e.updates.length;
    if (n > 1) tags.appendChild(h('span.chip.sm', { text: t('lib2.moreVersions', { n: n - 1 }) }));
    main.appendChild(tags);
    row.appendChild(main);
    var go = h('button.btn.sm.primary', { nav: (kind === 'backport' ? 'bpgo:' : 'upgo:') + e.titleId, html: U.icon('download') + '<span>' + U.escapeHtml(t('lib2.downloadInstall')) + '</span>' });
    go.addEventListener('click', function (ev) { ev.stopPropagation(); queueUpdate(e, r, kind, go); });
    row.appendChild(go);
    var more = h('button.btn.sm.icon-only', { nav: (kind === 'backport' ? 'bpmore:' : 'upmore:') + e.titleId, html: U.icon('more'), 'aria-label': t('common.more') });
    more.addEventListener('click', function (ev) { ev.stopPropagation(); updateMenu(more, e, kind); });
    row.appendChild(more);
    row.addEventListener('click', function (ev) { if (ev.target.closest('button')) return; updateMenu(row, e, kind); });
    return row;
  }
  function updateMenu(anchor, e, kind) {
    var rs = kind === 'backport' ? e.backports : e.updates;
    var items = rs.map(function (r) { return { label: (kind === 'backport' ? t('game2.kind.backport') + ' ' : t('lib2.updateV', { v: '' }).trim() + ' ') + (r.version || '') + (r.backportFw ? ' · ' + r.backportFw : ''), sub: [ui.fmtLabel(r.format), r.provider, r.sizeBytes ? U.fmtBytes(r.sizeBytes) : ''].filter(Boolean).join(' · '), icon: 'download', onSelect: function () { queueUpdate(e, r, kind); } }; });
    items.push('sep');
    if (e.game) items.push({ label: t('lib.openGame'), icon: 'external', onSelect: function () { XS.router.go('game', { id: e.game.id }); } });
    if (e.game && XS.gamePage && XS.gamePage.openOptions) items.push({ label: t('game.options'), icon: 'sliders', onSelect: function () { XS.gamePage.openOptions(e.game); } });
    ui.menu(anchor, items, { title: e.title || e.titleId });
  }
  function queueUpdate(e, r, kind, btn) {
    var rootDef = S.defaultRoot();
    if (!rootDef) { ui.toast({ cls: 'bad', title: t('err.root_unavailable') }); return Promise.resolve(false); }
    var via = cb.sget('debrid.preferred', 'auto') || 'auto';
    var body = { gameId: e.game ? e.game.id : '', root: rootDef.path, items: [{ releaseId: r.id, kind: kind }], autoInstall: true, verify: 'auto', via: via, base: r.id, titleId: e.titleId };
    if (btn) btn.classList.add('busy');
    return cb.api.queueSet(body).then(null, function (err) {
      if (err.status !== 404) throw err;
      return api.queueAdd({ gameId: e.game ? e.game.id : '', releaseId: r.id, root: rootDef.path, autoInstall: true, verify: r.sha256 ? 'sha256' : 'size', via: via, kind: kind });
    }).then(function () {
      if (btn) btn.classList.remove('busy');
      XS.actions.refreshQueue();
      ui.toast({ cls: 'gold', title: t('lib2.updateQueued', { title: e.title || e.titleId, v: r.version || '' }), desc: t('lib2.updateQueuedHint'), cover: e.cover, action: { label: t('game.viewDownloads'), onClick: function () { XS.router.go('downloads'); } } });
      return true;
    }, function (err) {
      if (btn) btn.classList.remove('busy');
      if (err.error === 'already_queued' || err.error === 'queued') { ui.toast({ cls: 'gold', title: t('err.queued') }); return false; }
      ui.errorToast(err, t('lib2.downloadInstall'));
      return false;
    });
  }
  function updateAll(list) {
    ui.confirm(t('lib2.updateAllTitle'), t('lib2.updateAllText', { n: list.length }), t('lib2.updateAll', { n: list.length })).then(function (ok) {
      if (!ok) return;
      var p = Promise.resolve(), n = 0;
      list.forEach(function (e) { p = p.then(function () { return queueUpdate(e, e.updates[0], 'update').then(function (did) { if (did) n++; }); }); });
      p.then(function () { if (n) ui.toast({ cls: 'good', title: t('lib2.updateAllDone', { n: n }) }); });
    });
  }

  /* ================================================================ Saves hub (§17.17) ================================================================ */
  var shRoot = null, sh = { users: null, user: null, saves: null, backups: null, jobs: {}, loading: false, titleId: '' };
  function renderSavesHub() {
    if (!shRoot) return;
    U.clear(shRoot);
    var inner = h('div.screen-inner'); shRoot.appendChild(inner);
    var head = h('div.page-head', [h('div.grow', [h('span.kicker', { text: t('nav.library') }), h('h1', { text: t('lib2.savesHub') }), h('p.dim', { text: t('lib2.savesHubSub') })])]);
    var all = h('button.btn.primary', { nav: 'sh-backup-all', html: U.icon('shield') + '<span>' + U.escapeHtml(t('lib2.backUpAll')) + '</span>' });
    all.addEventListener('click', backupAll);
    head.appendChild(all);
    if (XS.router.defs.saves) { var cs = h('button.btn.ghost', { nav: 'sh-community', html: U.icon('cloud') + '<span>' + U.escapeHtml(t('lib2.communitySaves')) + '</span>' }); cs.addEventListener('click', function () { XS.router.go('saves'); }); head.appendChild(cs); }
    inner.appendChild(head);
    var usersEl = h('div.sh-users', { data: { navRegion: '' } }); inner.appendChild(usersEl);
    var jobsEl = h('div.sh-jobs', { data: { navRegion: '' } }); inner.appendChild(jobsEl);
    var listEl = h('div.sh-list', { data: { navRegion: '' } }); inner.appendChild(listEl);
    inner.appendChild(h('div.section-head', [h('h2.section-title', { text: t('lib2.backups') }), h('span.spacer'), h('button.btn.sm.ghost', { nav: 'sh-refresh-backups', html: U.icon('refresh') + '<span>' + U.escapeHtml(t('common.refresh')) + '</span>', on: { click: function () { loadBackups(true); } } })]));
    var bkEl = h('div.sh-backups', { data: { navRegion: '' } }); inner.appendChild(bkEl);
    inner.appendChild(cb.note(t('lib2.savesSealedNote'), '', 'info'));
    sh.els = { users: usersEl, jobs: jobsEl, list: listEl, backups: bkEl };
    paintJobs();
    if (!sh.users) { usersEl.appendChild(cb.busy(t('saves.loadingUsers'))); cb.api.savesUsers().then(function (r) { sh.users = r.users || []; if (!sh.user) { var fg = sh.users.filter(function (u) { return u.foreground; })[0]; sh.user = fg || sh.users[0] || null; } paintUsers(); loadSaves(); }, function (err) { U.clear(usersEl); usersEl.appendChild(ui.emptyState(t('lib2.savesLoadFailed'), ui.errorText(err))); }); }
    else { paintUsers(); loadSaves(); }
    loadBackups(false);
    pollJobs();
  }
  function paintUsers() {
    var el = sh.els.users; U.clear(el);
    if (!sh.users || !sh.users.length) { el.appendChild(cb.note(t('saves.noUsers'), 'warn')); return; }
    el.appendChild(ui.subtabs({ id: 'sh-user', value: sh.user ? String(sh.user.id) : '', tabs: sh.users.map(function (u) { return { id: String(u.id), label: cb.userLabel(u) + (u.foreground ? ' · ' + t('saves.foregroundUser') : '') }; }), onChange: function (id) { sh.user = sh.users.filter(function (u) { return String(u.id) === id; })[0] || null; sh.saves = null; loadSaves(); } }));
  }
  function loadSaves() {
    var el = sh.els.list; if (!el) return;
    U.clear(el);
    if (!sh.user) { el.appendChild(ui.emptyState(t('saves.pickProfile'), '')); return; }
    el.appendChild(cb.busy(t('lib2.readingSaves')));
    var uid = sh.user.id;
    cb.api.savesList(uid).then(function (r) { if (!sh.user || sh.user.id !== uid) return; sh.saves = r.saves || []; paintSaves(); }, function (err) { U.clear(el); el.appendChild(ui.emptyState(t('lib2.savesLoadFailed'), ui.errorText(err))); });
  }
  function saveTitle(s) { var g = (s.gameId && S.game(s.gameId)) || S.data.byTitleId[s.titleId] || null; return s.title || (g && g.title) || s.titleId; }
  function saveCover(s) { var g = (s.gameId && S.game(s.gameId)) || S.data.byTitleId[s.titleId] || null; return { src: s.cover || (g && g.cover), fb: g && g.coverFallback }; }
  function paintSaves() {
    var el = sh.els.list; U.clear(el);
    var list = sh.saves || [];
    if (!list.length) { el.appendChild(ui.emptyState(t('lib2.noSavesTitle'), t('lib2.noSavesHint', { name: cb.userLabel(sh.user) }))); return; }
    el.appendChild(h('div.section-head', { style: { margin: '14px 0 8px' } }, [h('h2.section-title', [t('lib2.savesOf', { name: cb.userLabel(sh.user) }), h('span.count', { text: t('saves.nSaves', { n: list.length }) })])]));
    var rows = h('div.list');
    list.slice().sort(function (a, b) { return (b.mtime || 0) - (a.mtime || 0); }).forEach(function (s) {
      var c = saveCover(s), title = saveTitle(s);
      var row = h('div.lrow.srow', { nav: 'save:' + s.titleId, data: { hints: 'jobmenu' } });
      row.appendChild(ui.cover(c.src, c.fb, title));
      var main = h('div.main', [h('div.name.ellipsis', { text: title }), h('div.desc', { text: s.titleId + (s.dirs && s.dirs.length ? ' · ' + t('lib2.nFolders', { n: s.dirs.length }) : '') + (s.mtime ? ' · ' + cb.fmtAgo(s.mtime) : '') })]);
      var tags = h('div.tags', [h('span.chip.sm' + (s.kind === 'ps4' ? '.ps4' : '.ps5'), { text: (s.kind || 'ps5').toUpperCase() }), h('span.chip.sm', { text: U.fmtBytes(s.size) })]);
      if (s.installed === false) tags.appendChild(h('span.chip.sm.warn', { text: t('saves.compat.short.notInstalled') }));
      if (s.version) tags.appendChild(h('span.chip.sm', { text: 'v' + s.version }));
      main.appendChild(tags);
      row.appendChild(main);
      var bk = h('button.btn.sm.primary', { nav: 'save-backup:' + s.titleId, html: U.icon('shield') + '<span>' + U.escapeHtml(t('lib2.backUp')) + '</span>' });
      bk.addEventListener('click', function (e) { e.stopPropagation(); backupOne(s, bk); });
      row.appendChild(bk);
      var more = h('button.btn.sm.icon-only', { nav: 'save-more:' + s.titleId, html: U.icon('more'), 'aria-label': t('common.more') });
      more.addEventListener('click', function (e) { e.stopPropagation(); saveMenu(more, s); });
      row.appendChild(more);
      row.addEventListener('click', function (e) { if (e.target.closest('button')) return; saveMenu(row, s); });
      rows.appendChild(row);
    });
    el.appendChild(rows);
    if (sh.titleId) { var target = el.querySelector('[data-nav-id="save-backup:' + sh.titleId + '"]'); if (target) XS.nav.focus(target, true); sh.titleId = ''; }
  }
  function saveMenu(anchor, s) {
    var title = saveTitle(s);
    var backupsFor = (sh.backups || []).filter(function (b) { return b.titleId === s.titleId; });
    var items = [
      { label: t('lib2.backUp'), sub: t('lib2.backUpSub'), icon: 'shield', onSelect: function () { backupOne(s); } },
      { label: t('lib2.restore'), sub: backupsFor.length ? t('lib2.restoreSubN', { n: backupsFor.length }) : t('lib2.restoreNone'), icon: 'retry', disabled: !backupsFor.length, onSelect: function () { pickBackup(s, backupsFor); } },
      { label: t('lib2.transferProfile'), sub: t('lib2.beta') + ' · ' + t('lib2.transferSub'), icon: 'swap', disabled: !sh.users || sh.users.length < 2, onSelect: function () { transferSaveSheet(s); } }
    ];
    var g = (s.gameId && S.game(s.gameId)) || S.data.byTitleId[s.titleId];
    if (g) items.push({ label: t('lib.openGame'), icon: 'external', onSelect: function () { XS.router.go('game', { id: g.id }); } });
    items.push({ label: t('lib.copyPath'), icon: 'copy', onSelect: function () { U.copyText(s.path || '').then(function (ok) { ui.toast({ cls: ok ? 'good' : 'bad', title: ok ? t('toast.copied') : t('toast.copyFailed') }); }); } });
    ui.menu(anchor, items, { title: title });
  }
  function backupOne(s, btn) {
    if (!sh.user) return;
    if (btn) btn.classList.add('busy');
    cb.api.savesBackup(sh.user.id, s.titleId, s.kind || '').then(function (r) {
      if (btn) btn.classList.remove('busy');
      var job = r.job || null;
      if (!job || !job.id) { ui.toast({ cls: 'good', title: t('lib2.backupDone', { title: saveTitle(s) }) }); loadBackups(true); return; }
      trackJob(job, saveTitle(s));
    }, function (err) { if (btn) btn.classList.remove('busy'); ui.errorToast(err, t('lib2.backUp')); });
  }
  function backupAll() {
    if (!sh.user) { ui.toast({ cls: 'bad', title: t('saves.pickProfile') }); return; }
    var n = (sh.saves || []).length;
    ui.confirm(t('lib2.backUpAll'), t('lib2.backUpAllText', { n: n, name: cb.userLabel(sh.user) }), t('lib2.backUpAll')).then(function (ok) {
      if (!ok) return;
      cb.api.savesBackupAll(sh.user.id).then(function (r) {
        var ids = r.jobs || [];
        if (!ids.length) { ui.toast({ cls: 'good', title: t('lib2.backupAllNone') }); return; }
        ui.toast({ cls: 'gold', title: t('lib2.backupAllStarted', { n: r.started || ids.length }) });
        ids.forEach(function (j) { var id = typeof j === 'string' ? j : (j && j.id); if (id) trackJob({ id: id, title: t('lib2.saveBackupJob'), state: 'queued' }, ''); });
      }, function (err) { ui.errorToast(err, t('lib2.backUpAll')); });
    });
  }
  function trackJob(job, title) {
    var id = job.id;
    sh.jobs[id] = { job: job, title: title || job.title || '' };
    paintJobs();
    cb.watchJob(id, function (j) { if (sh.jobs[id]) { sh.jobs[id].job = j; paintJobs(); } }).then(function (j) {
      if (j.state === 'done') { XS.sound && XS.sound.done(); ui.toast({ cls: 'good', title: t('lib2.backupDone', { title: title || j.title || '' }), desc: j.result && j.result.zipPath ? cb.basename(j.result.zipPath) : (j.message || '') }); loadBackups(true); }
      else if (j.state === 'failed') ui.toast({ cls: 'bad', title: t('lib2.backupFailed', { title: title || j.title || '' }), desc: j.error || j.message || '' , timeout: 8000 });
      setTimeout(function () { delete sh.jobs[id]; paintJobs(); }, 6000);
    }, function (err) { ui.errorToast(err, t('lib2.backUp')); delete sh.jobs[id]; paintJobs(); });
  }
  function paintJobs() {
    var el = sh.els && sh.els.jobs; if (!el) return;
    U.clear(el);
    var ids = Object.keys(sh.jobs);
    if (!ids.length) { el.hidden = true; return; }
    el.hidden = false;
    var panel = h('div.panel.sh-progress');
    panel.appendChild(h('div.kicker.sm', { text: t('lib2.inProgress'), style: { marginBottom: '8px' } }));
    ids.forEach(function (id) { var j = sh.jobs[id].job; var row = cb.cxJobRow({ id: id, title: sh.jobs[id].title || j.title || t('lib2.saveBackupJob'), state: j.state, percent: j.percent, done: j.done, total: j.total, message: j.message, error: j.error }); panel.appendChild(row); });
    el.appendChild(panel);
  }
  /* Jobs started elsewhere (Settings → Back up all) show up here too. */
  function pollJobs() {
    cb.api.savesJobs().then(function (r) {
      (r.jobs || []).forEach(function (j) { if (j.state === 'running' || j.state === 'queued') { if (!sh.jobs[j.id]) trackJob(j, j.title || ''); } });
    }, function () { /* no console jobs endpoint on this build: fine */ });
  }
  function loadBackups(force) {
    var el = sh.els && sh.els.backups; if (!el) return;
    if (!force && sh.backups) { paintBackups(); return; }
    U.clear(el); el.appendChild(cb.busy(t('lib.loading')));
    cb.api.savesBackups().then(function (r) { sh.backups = r.backups || []; paintBackups(); }, function (err) { U.clear(el); el.appendChild(ui.emptyState(t('lib2.backupsLoadFailed'), ui.errorText(err))); });
  }
  function paintBackups() {
    var el = sh.els.backups; U.clear(el);
    var list = (sh.backups || []).slice().sort(function (a, b) { return (b.mtime || 0) - (a.mtime || 0); });
    if (!list.length) { el.appendChild(ui.emptyState(t('lib2.noBackupsTitle'), t('lib2.noBackupsHint'))); return; }
    var rows = h('div.list');
    list.slice(0, 60).forEach(function (b, i) {
      var g = (b.gameId && S.game(b.gameId)) || S.data.byTitleId[b.titleId] || null;
      var title = b.title || (g && g.title) || b.titleId || b.name;
      var row = h('button.lrow.brow', { nav: 'bk-' + i, data: { hints: 'jobmenu' } });
      row.appendChild(ui.cover(b.cover || (g && g.cover), g && g.coverFallback, title));
      var main = h('div.main', [h('div.name.ellipsis', { text: title }), h('div.desc.ellipsis', { text: b.name || cb.basename(b.path) })]);
      var tags = h('div.tags');
      if (b.titleId) tags.appendChild(h('span.chip.sm', { text: b.titleId }));
      if (b.kind) tags.appendChild(h('span.chip.sm' + (b.kind === 'ps4' ? '.ps4' : '.ps5'), { text: String(b.kind).toUpperCase() }));
      if (b.user) tags.appendChild(h('span.chip.sm', { text: b.user }));
      if (b.root) tags.appendChild(h('span.chip.sm', { text: cb.rootLabel(b.root) }));
      if (b.preRestore) tags.appendChild(h('span.chip.sm.warn', { text: t('lib2.preRestore') }));
      main.appendChild(tags);
      row.appendChild(main);
      row.appendChild(h('span.sz', { text: U.fmtBytes(b.size) }));
      row.appendChild(h('span.val', { text: b.mtime ? U.fmtDateTime(b.mtime) : '' }));
      row.addEventListener('click', function () { backupMenu(row, b, title); });
      rows.appendChild(row);
    });
    el.appendChild(rows);
  }
  function backupMenu(anchor, b, title) {
    var items = [
      { label: t('lib2.restoreThis'), sub: t('lib2.restoreThisSub'), icon: 'retry', onSelect: function () { restoreSheet(b, title); } },
      { label: t('lib.copyPath'), icon: 'copy', onSelect: function () { U.copyText(b.path).then(function (ok) { ui.toast({ cls: ok ? 'good' : 'bad', title: ok ? t('toast.copied') : t('toast.copyFailed') }); }); } }
    ];
    ui.menu(anchor, items, { title: title });
  }
  function pickBackup(s, list) {
    var title = saveTitle(s);
    var items = list.slice().sort(function (a, b) { return (b.mtime || 0) - (a.mtime || 0); }).map(function (b) { return { label: b.mtime ? U.fmtDateTime(b.mtime) : b.name, sub: [U.fmtBytes(b.size), b.user, cb.rootLabel(b.root), b.preRestore ? t('lib2.preRestore') : ''].filter(Boolean).join(' · '), icon: 'folder', onSelect: function () { restoreSheet(b, title, s); } }; });
    ui.menu(null, items, { title: t('lib2.pickBackup', { title: title }) });
  }
  function restoreSheet(b, title, s) {
    var st = { user: sh.user || (sh.users && sh.users[0]) || null, overwrite: true };
    var handle = ui.sheet({
      title: t('lib2.restore'), sub: title, cls: 'narrow', key: 'restore:' + b.path,
      body: function (body) {
        body.appendChild(h('div.panel', [cb.kv([[t('lib2.backupFile'), b.name || cb.basename(b.path)], [t('game.titleId'), b.titleId || ''], [t('dl.size'), U.fmtBytes(b.size)], [t('lib2.madeOn'), b.mtime ? U.fmtDateTime(b.mtime) : '']])]));
        body.appendChild(h('h3', { text: t('saves.profile') }));
        var list = h('div.list');
        (sh.users || []).forEach(function (u, i) {
          var sel = st.user && st.user.id === u.id;
          var row = h('button.lrow' + (sel ? '.sel' : ''), { nav: 'rs-user-' + i, data: { hints: 'select' } }, [h('span.ic', { html: U.icon('gamepad') }), h('div.main', [h('div.name', { text: cb.userLabel(u) }), h('div.desc', { text: u.foreground ? t('saves.foregroundUser') : '' })]), h('span.check', { html: sel ? U.icon('check') : '' })]);
          if (sel) row.setAttribute('data-autofocus', '');
          row.addEventListener('click', function () { st.user = u; U.$$('.lrow', list).forEach(function (x) { x.classList.remove('sel'); x.querySelector('.check').innerHTML = ''; }); row.classList.add('sel'); row.querySelector('.check').innerHTML = U.icon('check'); });
          list.appendChild(row);
        });
        body.appendChild(list);
        body.appendChild(h('h3', { text: t('saves.options') }));
        body.appendChild(ui.toggleRow({ id: 'rs-overwrite', icon: 'alert', label: t('lib2.overwrite'), desc: t('lib2.overwriteHint'), value: st.overwrite, onChange: function (v) { st.overwrite = v; } }));
        body.appendChild(cb.note(t('lib2.preBackupNote'), '', 'shield'));
      },
      foot: [h('span.spacer'), h('button.btn.primary.lg', { nav: 'rs-go', 'data-start': '', html: U.icon('retry') + '<span>' + U.escapeHtml(t('lib2.restoreGo')) + '</span>', on: { click: go } })]
    });
    function go() {
      if (!st.user) { ui.toast({ cls: 'bad', title: t('saves.pickProfile') }); return; }
      var btn = handle.foot.querySelector('[data-start]'); btn.classList.add('busy');
      cb.api.savesRestore(st.user.id, b.path, st.overwrite).then(function (r) {
        btn.classList.remove('busy'); ui.closeLayer(handle);
        XS.sound && XS.sound.done();
        ui.toast({ cls: 'good', title: t('lib2.restored', { title: title }), desc: (r.files ? t('saves.nFiles', { n: r.files }) + ' · ' : '') + (r.preBackup ? t('lib2.preBackupMade') : '') });
        loadBackups(true); if (sh.user && st.user.id === sh.user.id) loadSaves();
      }, function (err) { btn.classList.remove('busy'); ui.errorToast(err, t('lib2.restore')); });
    }
  }
  function transferSaveSheet(s) {
    var title = saveTitle(s);
    var others = (sh.users || []).filter(function (u) { return !sh.user || u.id !== sh.user.id; });
    var st = { to: others[0] || null, move: false };
    var handle = ui.sheet({
      title: t('lib2.transferProfile'), sub: title + ' · ' + t('lib2.beta'), cls: 'narrow', key: 'transfer-save:' + s.titleId,
      body: function (body) {
        body.appendChild(h('div.row', { style: { marginBottom: '10px' } }, [h('span.chip.gold', { text: t('lib2.beta') }), h('span.dim.small', { text: t('lib2.transferBetaText'), style: { marginTop: 0 } })]));
        body.appendChild(h('div.panel', [cb.kv([[t('saves.profile'), cb.userLabel(sh.user)], [t('game.titleId'), s.titleId], [t('dl.size'), U.fmtBytes(s.size)]])]));
        body.appendChild(h('h3', { text: t('lib2.transferTo') }));
        var list = h('div.list');
        others.forEach(function (u, i) {
          var sel = st.to && st.to.id === u.id;
          var row = h('button.lrow' + (sel ? '.sel' : ''), { nav: 'ts-user-' + i, data: { hints: 'select' } }, [h('span.ic', { html: U.icon('gamepad') }), h('div.main', [h('div.name', { text: cb.userLabel(u) }), h('div.desc', { text: u.foreground ? t('saves.foregroundUser') : '' })]), h('span.check', { html: sel ? U.icon('check') : '' })]);
          if (sel) row.setAttribute('data-autofocus', '');
          row.addEventListener('click', function () { st.to = u; U.$$('.lrow', list).forEach(function (x) { x.classList.remove('sel'); x.querySelector('.check').innerHTML = ''; }); row.classList.add('sel'); row.querySelector('.check').innerHTML = U.icon('check'); });
          list.appendChild(row);
        });
        body.appendChild(list);
        body.appendChild(h('h3', { text: t('saves.options') }));
        body.appendChild(ui.toggleRow({ id: 'ts-move', icon: 'swap', label: t('lib2.transferMove'), desc: t('lib2.transferMoveHint'), value: st.move, onChange: function (v) { st.move = v; } }));
        body.appendChild(cb.note(t('lib2.transferPreBackup'), '', 'shield'));
        body.appendChild(cb.note(t('lib2.savesSealedNote'), 'warn'));
      },
      foot: [h('span.spacer'), h('button.btn.primary.lg', { nav: 'ts-go', 'data-start': '', html: U.icon('swap') + '<span>' + U.escapeHtml(t('lib2.transferGo')) + '</span>', on: { click: go } })]
    });
    function go() {
      if (!st.to || !sh.user) return;
      var btn = handle.foot.querySelector('[data-start]'); btn.classList.add('busy');
      cb.api.savesTransfer(sh.user.id, st.to.id, s.titleId, s.kind || '', st.move).then(function (r) {
        btn.classList.remove('busy'); ui.closeLayer(handle);
        XS.sound && XS.sound.done();
        ui.toast({ cls: 'good', title: t('lib2.transferred', { title: title, name: cb.userLabel(st.to) }), desc: (r.bytes ? U.fmtBytes(r.bytes) + ' · ' : '') + (r.preBackup ? t('lib2.preBackupMade') : '') });
        loadBackups(true); if (st.move) loadSaves();
      }, function (err) { btn.classList.remove('busy'); ui.errorToast(err, t('lib2.transferProfile')); });
    }
  }

  /* ================================================================ registration ================================================================ */
  XS.router.register('library', {
    tab: true, icon: 'library', label: function () { return t('nav.library'); },
    mount: function (el) { root = el; },
    show: function () { render(); },
    refresh: function () { if (root && root.classList.contains('active')) render(); }
  });
  XS.router.register('updates', {
    tab: false, icon: 'refresh', label: function () { return t('lib2.updatesCenter'); },
    mount: function (el) { upRoot = el; },
    show: function (params) { if (params && params.titleId) upTitle = params.titleId; renderUpdates(); },
    refresh: function () { if (upRoot && upRoot.classList.contains('active')) renderUpdates(); }
  });
  XS.router.register('saveshub', {
    tab: false, icon: 'shield', label: function () { return t('lib2.savesHub'); },
    mount: function (el) { shRoot = el; },
    show: function (params) { if (params && params.titleId) sh.titleId = params.titleId; renderSavesHub(); },
    refresh: function () { if (shRoot && shRoot.classList.contains('active')) renderSavesHub(); }
  });
  S.on('storage', function () { if (root && root.classList.contains('active')) renderStorage(); });
  S.on('library', function (r) { if (r && r !== lib) lib = r; });
  /* Queued bytes per drive change every poll: only repaint when the numbers actually moved. */
  var lastQueuedKey = '';
  S.on('queue', function () {
    if (!root || !root.classList.contains('active') || !storEl) return;
    var key = S.data.queue.jobs.map(function (j) { return j.root + ':' + j.state + ':' + Math.floor((j.written || 0) / 1e8); }).join(',');
    if (key !== lastQueuedKey) { lastQueuedKey = key; renderStorage(); }
  });
  XS.libraryScreen = { transferSheet: transferSheet, updateCandidates: updateCandidates, saveshub: { backupOne: backupOne }, reload: function () { load(true); } };
})();
