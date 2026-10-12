/* XENO STORE — 44-library.js: storage bars per root, installed titles, files on drives with actions, filters, search. */
(function () {
  'use strict';
  var XS = window.XS, U = XS.util, S = XS.state, ui = XS.ui, api = XS.api, h = U.h, t = XS.t;
  var root = null, filesEl = null, lib = null, flt = { root: '', format: '', q: '', partial: false }, scanning = false, instEl = null, storEl = null;

  function render() {
    if (!root) return;
    U.clear(root);
    var inner = h('div.screen-inner');
    root.appendChild(inner);
    inner.appendChild(h('div.section-head', [h('h2.section-title', { text: t('lib.storage') }), h('span.spacer'), h('button.btn.sm.ghost', { nav: 'lib-refresh-storage', html: U.icon('refresh') + '<span>' + U.escapeHtml(t('common.refresh')) + '</span>', on: { click: function () { api.storage().then(function (r) { S.set('storage', r.roots || []); }, ui.errorToast); } } })]));
    storEl = h('div.storages', { data: { navRegion: '' } }); inner.appendChild(storEl);
    renderStorage();
    inner.appendChild(h('div.section-head', [h('h2.section-title', { text: t('lib.installed') }), h('span.spacer')]));
    instEl = h('div', { data: { navRegion: '' } }); inner.appendChild(instEl);
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
    var rootsBtn = h('button.chip' + (flt.root ? '.on' : ''), { nav: 'lib-flt-root' }, [h('span', { text: flt.root ? rootLabel(flt.root) : t('lib.allDrives') }), ui.svg('chevD')]);
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
  }
  function rootLabel(p) { var rs = S.data.storage || []; for (var i = 0; i < rs.length; i++) if (rs[i].path === p) return rs[i].label; return p; }
  function renderStorage() {
    if (!storEl) return;
    U.clear(storEl);
    var roots = S.data.storage || [];
    if (!roots.length) { storEl.appendChild(ui.emptyState(t('lib.noDrives'), t('lib.noDrivesHint'))); return; }
    var queued = {};
    S.data.queue.jobs.forEach(function (j) { if (['queued', 'downloading', 'connecting', 'paused', 'failed', 'verifying'].indexOf(j.state) >= 0) queued[j.root] = (queued[j.root] || 0) + Math.max(0, (j.total || 0) - (j.written || 0)); });
    roots.forEach(function (r, i) {
      var used = Math.max(0, r.total - r.free), q = Math.min(r.free, queued[r.path] || 0);
      var box = h('div.storage' + (r['default'] ? '.default' : ''), { nav: 'root:' + r.path, data: { hints: 'select' } });
      var top = h('div.top', [h('span.ic', { html: U.icon(r.kind === 'usb' ? 'usb' : r.kind === 'm2' ? 'm2' : 'hdd'), style: { width: '34px', height: '34px', borderRadius: '10px', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(255,255,255,.06)', color: 'var(--dim)' } }), h('div.grow', [h('div.name', [r.label, r['default'] ? h('span.chip.sm.gold', { text: t('lib.default'), style: { marginInlineStart: '8px' } }) : null, !r.writable ? h('span.chip.sm.bad', { text: t('lib.readOnly'), style: { marginInlineStart: '8px' } }) : null]), h('div.path', { text: r.path })])]);
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
  }
  function load(scan) {
    if (scanning) return;
    scanning = true;
    if (filesEl && scan) { U.clear(filesEl); filesEl.appendChild(h('div.panel', [h('div.row', [h('span.skel', { style: { width: '18px', height: '18px', borderRadius: '50%' } }), h('span.dim', { text: t('lib.scanning') })])])); }
    api.library(scan).then(function (r) { scanning = false; lib = r; S.set('library', r); renderInstalled(); renderFiles(); if (scan) ui.toast({ cls: 'good', title: t('toast.scanDone', { n: (r.files || []).length }) }); }, function (err) { scanning = false; if (filesEl) { U.clear(filesEl); filesEl.appendChild(ui.emptyState(t('lib.scanFailed'), ui.errorText(err))); } });
  }
  function renderInstalled() {
    if (!instEl) return;
    U.clear(instEl);
    var inst = (lib && lib.installed) || [];
    if (!inst.length) { instEl.appendChild(h('p.dim', { text: lib ? t('lib.noInstalled') : t('lib.loading') })); return; }
    var grid = h('div.installed-grid');
    inst.forEach(function (it) {
      var g = (it.gameId && S.game(it.gameId)) || S.data.byTitleId[it.titleId] || null;
      var el = h('a.inst', { nav: 'inst:' + it.titleId, data: { hints: g ? 'open' : '' } });
      el.appendChild(ui.cover(it.cover || (g && g.cover), g && g.coverFallback, it.title || (g && g.title) || it.titleId));
      el.appendChild(h('div.t.ellipsis', { text: it.title || (g && g.title) || it.titleId }));
      el.appendChild(h('div.id', { text: it.titleId }));
      el.addEventListener('click', function () { if (g) XS.router.go('game', { id: g.id }); else ui.toast({ title: it.titleId, desc: it.path || '' }); });
      grid.appendChild(el);
    });
    instEl.appendChild(grid);
  }
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
    files.forEach(function (f, i) {
      var g = (f.gameId && S.game(f.gameId)) || (f.titleId && S.data.byTitleId[f.titleId]) || null;
      var row = h('button.lrow.frow', { nav: 'file:' + f.path, data: { hints: 'jobmenu' } });
      if (g || f.cover) row.appendChild(ui.cover(f.cover || (g && g.cover), g && g.coverFallback, f.title || (g && g.title) || f.name));
      else row.appendChild(h('span.ic.fmt', { text: String(f.format || '?').toUpperCase().slice(0, 5) }));
      var main = h('div.main', [h('div.name.ellipsis', { text: f.title || (g && g.title) || f.name }), h('div.path', { text: f.path })]);
      var tags = h('div.tags', [h('span.chip.fmt.sm', { text: String(f.format || '').toUpperCase() })]);
      if (f.titleId) tags.appendChild(h('span.chip.sm', { text: f.titleId }));
      if (f.partial) tags.appendChild(h('span.chip.sm.warn', { text: t('lib.partial') }));
      if (f.jobId) tags.appendChild(h('span.chip.sm.acc', { text: t('lib.inQueue') }));
      tags.appendChild(h('span.chip.sm', { text: rootLabel(f.root) }));
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
    if (['exfat', 'ffpfsc', 'ffpkg', 'ffpfs'].indexOf(fmt) >= 0) items.push({ label: t('lib.shadowScan'), icon: 'zap', onSelect: function () { api.shadowmountScan().then(function (r) { ui.toast({ cls: r.available ? 'good' : 'bad', title: r.available ? t('toast.shadowOk') : t('toast.shadowMissing'), desc: r.status || '' }); }, ui.errorToast); } });
    if (f.jobId) items.push({ label: t('game.viewDownloads'), icon: 'download', onSelect: function () { XS.router.go('downloads'); } });
    items.push({ label: t('lib.copyPath'), icon: 'copy', onSelect: function () { U.copyText(f.path).then(function (ok) { ui.toast({ cls: ok ? 'good' : 'bad', title: ok ? t('toast.copied') : t('toast.copyFailed') }); }); } });
    items.push('sep');
    items.push({ label: t('lib.deleteFile'), icon: 'trash', danger: true, onSelect: function () {
      ui.confirm(t('lib.deleteTitle'), t('lib.deleteText', { name: f.name, size: U.fmtBytes(f.size) }), t('common.delete'), true).then(function (ok) {
        if (!ok) return;
        api.libraryDelete(f.path).then(function () { ui.toast({ cls: 'good', title: t('toast.deleted', { name: f.name }) }); load(true); api.storage().then(function (r) { S.set('storage', r.roots || []); }, function () { /* ignore */ }); }, ui.errorToast);
      });
    } });
    ui.menu(anchor, items, { title: f.name });
  }

  XS.router.register('library', {
    tab: true, icon: 'library', label: function () { return t('nav.library'); },
    mount: function (el) { root = el; },
    show: function () { render(); }
  });
  S.on('storage', function () { if (root && root.classList.contains('active')) renderStorage(); });
  S.on('queue', function () { if (root && root.classList.contains('active') && storEl) renderStorage(); });
})();
