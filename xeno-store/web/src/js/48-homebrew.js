/* XENO STORE — 48-homebrew.js: Homebrew tab (§17.21): rails Essentials (featured.homebrew) · Emulators · Tools ·
   New versions, search + category chips, app page with Install (PS5 build preferred, PS4 with a warning),
   "Installed · Update available" from the recorded installed version / library data. */
(function () {
  'use strict';
  var XS = window.XS, U = XS.util, S = XS.state, ui = XS.ui, ca = XS.ca, api = XS.api, h = U.h, t = XS.t;
  var root = null, appRoot = null, current = null;
  var cache = { apps: null, at: 0, p: null, meta: {} };
  var scr = { q: '', cat: '' };

  /* ---------- data ---------- */
  function normalize(a) {
    var x = {};
    for (var k in a) x[k] = a[k];
    x.id = String(x.id || '');
    x.title = x.title || x.name || x.id;
    x.version = String(x.version || '');
    x.author = x.author || x.publisher || '';
    x.category = x.category || 'Other';
    x.cover = x.cover || '';
    x.description = x.description || x.about || '';
    x.releases = Array.isArray(x.releases) ? x.releases : [];
    x.supportsPs5 = x.supportsPs5 !== undefined ? !!x.supportsPs5 : x.releases.some(function (r) { return r.platform === 'PS5'; });
    x.installedVersion = x.installedVersion || (x.installed && x.installed.version) || '';
    x.updatedAt = x.updatedAt || x.addedAt || '';
    return x;
  }
  function fromCatalog() {
    return S.data.games.filter(function (g) { return g.platform === 'HOMEBREW'; }).map(function (g) {
      var rs = (g.releases || []).map(function (r) { return { id: r.id, platform: r.platform || (/ps4/i.test(r.url || '') ? 'PS4' : 'PS5'), url: r.url, filename: r.filename, format: r.format || 'PKG', sizeBytes: r.sizeBytes || 0, version: r.version || '' }; });
      return normalize({ id: g.id, title: g.title, version: (rs[0] && rs[0].version) || g.version || '', author: g.author || g.publisher || '', category: g.category || '', supportsPs5: g.supportsPs5, cover: g.cover, details: g.details || g.psStoreUrl || '', description: g.description, size: g.sizeMax, changelog: g.changelog || '', updatedAt: g.addedAt, releases: rs, titleId: (g.titleIds || [])[0] || '' });
    });
  }
  function load(force) {
    if (!force && cache.apps && Date.now() - cache.at < 300000) return Promise.resolve(cache.apps);
    if (cache.p && !force) return cache.p;
    cache.p = ca.api.homebrew(force).then(function (r) {
      var apps = (r.apps || r.items || []).map(normalize);
      if (!apps.length) apps = fromCatalog();
      cache.apps = apps; cache.at = Date.now(); cache.meta = { updatedAt: r.updatedAt || '', cached: !!r.cached, source: r.source || '' }; cache.p = null;
      return apps;
    }, function (err) {
      cache.p = null;
      var apps = fromCatalog();
      if (apps.length) { cache.apps = apps; cache.at = Date.now(); cache.meta = { fallback: true }; return apps; }
      throw err;
    });
    return cache.p;
  }
  function byId(id) { return (cache.apps || []).filter(function (a) { return a.id === id; })[0] || null; }
  function installedInfo(a) {
    var inst = a.installedVersion;
    if (!inst && a.titleId && S.data.library && S.data.library.installed) { if (S.data.library.installed.some(function (x) { return x.titleId === a.titleId; })) inst = '?'; }
    if (!inst) return null;
    var newer = inst !== '?' && a.version && ca.semverCmp(a.version, inst) > 0;
    return { version: inst, update: newer };
  }
  function statusChip(a) {
    var ii = installedInfo(a); if (!ii) return null;
    if (ii.update) return h('span.chip.sm.warn', { html: U.icon('refresh') + '<span>' + U.escapeHtml(t('homebrew.updateAvailable', { v: a.version })) + '</span>' });
    return h('span.chip.sm.good', { html: U.icon('check') + '<span>' + U.escapeHtml(ii.version === '?' ? t('homebrew.installed') : t('homebrew.installedV', { v: ii.version })) + '</span>' });
  }
  function catLabel(c) { var k = String(c || '').toLowerCase(); return XS.i18n.has('homebrew.cat.' + k) ? t('homebrew.cat.' + k) : (c || t('homebrew.cat.other')); }
  function bestRelease(a, platform) {
    var rs = a.releases.filter(function (r) { return !platform || r.platform === platform; });
    rs.sort(function (x, y) { return (x.platform === 'PS5' ? 0 : 1) - (y.platform === 'PS5' ? 0 : 1); });
    return rs[0] || null;
  }

  /* ---------- widgets ---------- */
  function card(a, prefix) {
    var c = h('button.hb-card', { nav: (prefix || 'hb') + ':' + a.id, data: { hints: 'open', app: a.id } });
    c.appendChild(ui.cover(ca.api.imageUrl(a.cover), '', a.title));
    if (a.supportsPs5) c.appendChild(h('span.plat.ps5', { text: 'PS5' })); else c.appendChild(h('span.plat.ps4', { text: 'PS4' }));
    var ii = installedInfo(a);
    if (ii) c.appendChild(h('span.hb-state' + (ii.update ? '.upd' : ''), { html: U.icon(ii.update ? 'refresh' : 'check') }));
    c.appendChild(h('div.t.clamp2', { text: a.title }));
    c.appendChild(h('div.s.ellipsis', { text: [a.version ? 'v' + a.version : '', a.author].filter(Boolean).join(' · ') }));
    c.appendChild(h('div.c.ellipsis', { text: catLabel(a.category) }));
    c.addEventListener('click', function () { XS.router.go('hbapp', { id: a.id }); });
    return c;
  }
  function rail(title, apps, opts) {
    opts = opts || {};
    if (!apps || !apps.length) return null;
    var sec = h('section.rail', { data: { rail: opts.id || 'hb' } });
    var head = h('div.section-head', [h('h2.section-title', [title, h('span.count', { text: t('homebrew.nApps', { n: apps.length }) })])]);
    if (opts.more) { head.appendChild(h('span.spacer')); head.appendChild(h('button.btn.ghost.sm', { nav: 'more:' + (opts.id || 'hb'), text: t('common.seeAll'), on: { click: opts.more } })); }
    sec.appendChild(head);
    var track = h('div.rail-track', { data: { navRegion: '' } });
    apps.slice(0, opts.limit || 20).forEach(function (a) { track.appendChild(card(a, 'rail-' + (opts.id || 'hb'))); });
    sec.appendChild(track);
    return sec;
  }
  function essentials(n) {
    return load().then(function (apps) {
      var ids = (S.data.status && S.data.status.featured && S.data.status.featured.homebrew) || [];
      var out = ids.map(byId).filter(Boolean);
      if (!out.length) out = apps.slice().sort(function (a, b) { return (b.downloads || 0) - (a.downloads || 0); });
      return out.slice(0, n || 12);
    });
  }

  /* ---------- Homebrew tab ---------- */
  function render() {
    if (!root) return;
    U.clear(root);
    var inner = h('div.screen-inner.hb-screen');
    root.appendChild(inner);
    var head = h('div.page-head');
    head.appendChild(h('div.grow', [h('div.kicker', { text: t('homebrew.kicker') }), h('h1', { text: t('homebrew.title') }), h('p.dim', { 'data-hb-meta': '', text: t('homebrew.subtitle') })]));
    var rf = h('button.btn', { nav: 'hb-refresh', html: U.icon('refresh') + '<span>' + U.escapeHtml(t('homebrew.refresh')) + '</span>', title: t('homebrew.refreshHint') });
    rf.addEventListener('click', function () { rf.classList.add('busy'); load(true).then(function () { rf.classList.remove('busy'); render(); ca.focusIn(root, 'hb-refresh'); ui.toast({ cls: 'good', title: t('homebrew.refreshed', { n: cache.apps.length }) }); }, function (err) { rf.classList.remove('busy'); ui.errorToast(err, t('homebrew.refresh')); }); });
    head.appendChild(rf);
    inner.appendChild(head);
    var bar = h('div.browse-bar', { data: { navRegion: '' } });
    var sb = ui.searchBox({ id: 'hb-search', placeholder: t('homebrew.searchPlaceholder'), value: scr.q, onInput: function (v) { scr.q = v; live(); } });
    bar.appendChild(sb);
    inner.appendChild(bar);
    var chipsHost = h('div'); inner.appendChild(chipsHost);
    var bodyHost = h('div'); inner.appendChild(bodyHost);
    bodyHost.appendChild(ui.skeletonRail(8));
    var live = U.debounce(function () { paintBody(); }, 120);
    function paintChips(apps) {
      U.clear(chipsHost);
      var counts = {};
      apps.forEach(function (a) { var c = String(a.category || 'Other'); counts[c] = (counts[c] || 0) + 1; });
      var cats = Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a] || (a < b ? -1 : 1); });
      var wrap = h('div.chips.cat-chips', { data: { navRegion: '' } });
      [''].concat(cats).forEach(function (c) {
        var b = h('button.chip' + (scr.cat === c ? '.on' : ''), { nav: 'hbcat-' + (c || 'all').replace(/\W/g, ''), 'aria-pressed': scr.cat === c ? 'true' : 'false' }, [h('span', { text: c ? catLabel(c) : t('filter.all') }), c ? h('span.n', { text: String(counts[c]) }) : null]);
        b.addEventListener('click', function () { scr.cat = c; paintChips(apps); paintBody(); });
        wrap.appendChild(b);
      });
      chipsHost.appendChild(wrap);
    }
    function paintBody() {
      var apps = cache.apps || [];
      U.clear(bodyHost);
      var meta = inner.querySelector('[data-hb-meta]');
      if (meta) meta.textContent = cache.meta.fallback ? t('homebrew.fromCatalog') : (cache.meta.updatedAt ? t('homebrew.listedAt', { date: ca.fmtWhen(cache.meta.updatedAt) }) : t('homebrew.subtitle'));
      var q = scr.q.trim().toLowerCase();
      if (!q && !scr.cat) {
        var ids = (S.data.status && S.data.status.featured && S.data.status.featured.homebrew) || [];
        var ess = ids.map(byId).filter(Boolean);
        if (ess.length) bodyHost.appendChild(rail(t('homebrew.essentials'), ess, { id: 'essentials' }));
        var emu = apps.filter(function (a) { return /emul/i.test(a.category); });
        var tools = apps.filter(function (a) { return /tool|util/i.test(a.category); });
        var fresh = apps.filter(function (a) { return a.updatedAt; }).sort(function (a, b) { return a.updatedAt < b.updatedAt ? 1 : -1; }).slice(0, 20);
        var upd = apps.filter(function (a) { var ii = installedInfo(a); return ii && ii.update; });
        if (upd.length) bodyHost.appendChild(rail(t('homebrew.updatesForYou'), upd, { id: 'updates' }));
        if (emu.length) bodyHost.appendChild(rail(t('homebrew.emulators'), emu, { id: 'emulators', more: function () { scr.cat = emu[0].category; paintChips(apps); paintBody(); } }));
        if (tools.length) bodyHost.appendChild(rail(t('homebrew.tools'), tools, { id: 'tools', more: function () { scr.cat = tools[0].category; paintChips(apps); paintBody(); } }));
        if (fresh.length) bodyHost.appendChild(rail(t('homebrew.newVersions'), fresh, { id: 'new' }));
      }
      var list = apps.filter(function (a) {
        if (scr.cat && String(a.category) !== scr.cat) return false;
        if (q && (a.title + ' ' + a.author + ' ' + a.category + ' ' + a.id).toLowerCase().indexOf(q) < 0) return false;
        return true;
      }).sort(function (a, b) { return a.title.toLowerCase() < b.title.toLowerCase() ? -1 : 1; });
      bodyHost.appendChild(h('div.section-head', [h('h2.section-title', [q || scr.cat ? ca.nResults(list.length) : t('homebrew.allApps'), q || scr.cat ? null : h('span.count', { text: t('homebrew.nApps', { n: list.length }) })])]));
      if (!list.length) { bodyHost.appendChild(ui.emptyState(q ? t('browse.emptyQueryTitle', { q: scr.q }) : t('homebrew.emptyTitle'), t('homebrew.emptyHint'))); return; }
      var grid = h('div.vgrid.hb-grid', { data: { navRegion: '' } });
      bodyHost.appendChild(grid);
      ui.vgrid(grid, list, root, function (a) { return card(a, 'grid'); });
    }
    load().then(function (apps) { paintChips(apps); paintBody(); if (root.classList.contains('active') && !root.contains(document.activeElement)) XS.nav.restore(root); }, function (err) {
      U.clear(bodyHost);
      bodyHost.appendChild(ui.emptyState(t('homebrew.loadFailed'), ui.errorText(err), [h('button.btn.primary', { nav: 'hb-retry', text: t('common.retry'), on: { click: function () { render(); } } })]));
    });
  }

  /* ---------- app page ---------- */
  function renderApp(params) {
    U.clear(appRoot);
    appRoot.style.removeProperty('--gp-ambient');
    var a = byId(params.id);
    if (!a) {
      appRoot.appendChild(h('div.screen-inner', [ui.skeletonRail(4)]));
      load().then(function () { if (XS.router.current().id === 'hbapp' && XS.router.current().params.id === params.id) { if (byId(params.id)) renderApp(params); else { U.clear(appRoot); appRoot.appendChild(h('div.screen-inner.pad-top', [ui.emptyState(t('homebrew.notFound'), '', [h('button.btn.primary', { nav: 'hb-nf-back', text: t('common.back'), on: { click: function () { XS.router.back(); } } })])])); } } }, function () { U.clear(appRoot); appRoot.appendChild(h('div.screen-inner.pad-top', [ui.emptyState(t('homebrew.loadFailed'), '', [h('button.btn.primary', { nav: 'hb-nf-back', text: t('common.back'), on: { click: function () { XS.router.back(); } } })])])); });
      return;
    }
    current = a;
    var cover = ca.api.imageUrl(a.cover);
    var bd = h('div.gp-backdrop'); bd.appendChild(ui.cover(cover, '', a.title)); appRoot.appendChild(bd);
    appRoot.style.setProperty('--gp-ambient', ca.hashTint(a.title, ''));
    ca.ambient(cover, ca.hashTint(a.title, '')).then(function (c) { if (current === a) appRoot.style.setProperty('--gp-ambient', c); });
    var inner = h('div.screen-inner.gp.hb-app'); appRoot.appendChild(inner);
    var head = h('div.gp-head');
    var cov = h('div.gp-cover.square'); cov.appendChild(ui.cover(cover, '', a.title)); head.appendChild(cov);
    var info = h('div.gp-info');
    var chips = h('div.chips', [h('span.chip', { text: catLabel(a.category) }), a.supportsPs5 ? h('span.chip.ps5', { text: t('homebrew.supportsPs5') }) : h('span.chip.ps4', { text: t('homebrew.ps4Only') })]);
    var sc = statusChip(a); if (sc) chips.appendChild(sc);
    info.appendChild(chips);
    info.appendChild(h('h1', { text: a.title }));
    var meta = h('div.gp-meta');
    if (a.author) meta.appendChild(h('span', [t('homebrew.by') + ' ', h('b', { text: a.author })]));
    if (a.version) meta.appendChild(h('span', [t('homebrew.version') + ' ', h('b', { text: 'v' + a.version })]));
    var ps5r = bestRelease(a, 'PS5'), ps4r = bestRelease(a, 'PS4');
    var sz = (ps5r && ps5r.sizeBytes) || (ps4r && ps4r.sizeBytes) || a.size;
    if (sz) meta.appendChild(h('span', [t('game.size') + ' ', h('b', { text: U.fmtBytes(sz) })]));
    if (a.updatedAt) meta.appendChild(h('span', [t('homebrew.updated') + ' ', h('b', { text: U.fmtDate(a.updatedAt) })]));
    if (a.titleId) meta.appendChild(h('span', [t('game.titleId') + ' ', h('b.mono', { text: a.titleId })]));
    info.appendChild(meta);
    var statusEl = h('div'); info.appendChild(statusEl);
    var acts = h('div.gp-actions');
    var job = S.activeJobFor(a.id);
    var ii = installedInfo(a);
    if (job && ['downloading', 'connecting', 'queued', 'paused', 'failed', 'verifying', 'installing'].indexOf(job.state) >= 0) {
      statusEl.appendChild(h('div.gp-status', [ui.statePill(job), ui.progressBar(job), h('span.pct', { text: job.total ? U.fmtPct(U.pct(job.written, job.total)) : '' })]));
      var vb = h('button.btn.primary.lg', { nav: 'gp-primary', 'data-autofocus': '', html: U.icon('download') + '<span>' + U.escapeHtml(t('game.viewDownloads')) + '</span>' }); vb.addEventListener('click', function () { XS.router.go('downloads'); }); acts.appendChild(vb);
    } else {
      var rel = ps5r || ps4r;
      var label = !rel ? t('game.noSources') : ii && ii.update ? t('homebrew.update', { v: a.version }) : ii ? t('homebrew.reinstall') : t('homebrew.install');
      var inst = h('button.btn.primary.lg', { nav: 'gp-primary', 'data-autofocus': '', html: U.icon('box') + '<span>' + U.escapeHtml(label) + (rel ? ' <small>' + U.escapeHtml(rel.platform === 'PS5' ? t('homebrew.ps5Build') : t('homebrew.ps4Build')) + '</small>' : '') + '</span>', data: { hints: 'select' } });
      if (!rel) inst.setAttribute('disabled', '');
      inst.addEventListener('click', function () { if (rel) installFlow(a, rel); });
      acts.appendChild(inst);
      if (ps5r && ps4r) { var alt = h('button.btn.lg', { nav: 'hb-ps4', html: U.icon('box') + '<span>' + U.escapeHtml(t('homebrew.installPs4')) + '</span>' }); alt.addEventListener('click', function () { installFlow(a, ps4r); }); acts.appendChild(alt); }
    }
    if (a.details) { var det = h('button.btn.lg', { nav: 'hb-details', html: U.icon('external') + '<span>' + U.escapeHtml(t('homebrew.details')) + '</span>' }); det.addEventListener('click', function () { U.openExternal(a.details); }); acts.appendChild(det); }
    var more = h('button.btn.lg.icon-only', { nav: 'gp-more', html: U.icon('more'), 'aria-label': t('common.more') });
    more.addEventListener('click', function () {
      ui.menu(more, [
        { label: t('game.shareToPhone'), icon: 'qr', onSelect: function () { ca.linkDialog({ title: t('game.shareToPhone'), hint: t('game.shareHint'), url: ca.baseUrl() + '#homebrew', key: 'share-hb' }); } },
        { label: t('homebrew.copyLink'), icon: 'copy', disabled: !(ps5r || ps4r), onSelect: function () { var r = ps5r || ps4r; U.copyText(r.url).then(function (ok) { ui.toast({ cls: ok ? 'good' : 'bad', title: ok ? t('toast.copied') : t('toast.copyFailed'), desc: ok ? r.url : '' }); }); } },
        'sep',
        { label: t('homebrew.report'), icon: 'alert', sub: t('game.reportBrokenSub'), onSelect: function () { ca.linkDialog({ title: t('homebrew.report'), hint: t('game2.reportHint'), url: ca.issueUrl('homebrew', { app: a }), display: t('game2.issueOnGithub'), openLabel: t('game2.openIssue') }); } }
      ]);
    });
    acts.appendChild(more);
    info.appendChild(acts);
    head.appendChild(info);
    inner.appendChild(head);
    if (!a.supportsPs5) inner.appendChild(h('div.panel.note.warn', { style: { marginTop: '18px' } }, [h('div.row', [ui.svg('alert'), h('span', { text: t('homebrew.ps4Warning') })])]));
    if (a.description) {
      inner.appendChild(h('section.gp-about', [h('div.section-head', [h('h2.section-title', { text: t('game2.about') })])]));
      var p = h('div.gp-desc.clamp4'); String(a.description).split(/\n{2,}/).forEach(function (para) { if (para.trim()) p.appendChild(h('p', { text: para.trim() })); });
      inner.lastChild.appendChild(p);
      if (String(a.description).length > 320) { var mb = h('button.btn.ghost.sm.gp-desc-more', { nav: 'gp-desc', text: t('common.readMore') }); mb.addEventListener('click', function () { var open = !p.classList.toggle('clamp4'); mb.textContent = open ? t('common.readLess') : t('common.readMore'); }); inner.lastChild.appendChild(mb); }
    }
    if (a.changelog) inner.appendChild(h('section.gp-about', [h('div.section-head', [h('h2.section-title', { text: t('homebrew.changelog') })]), h('div.panel.changelog', { text: String(a.changelog) })]));
    var rows = h('div.gp-infopanel');
    var left = h('div.gp-col');
    left.appendChild(ca.infoRow(t('homebrew.builds'), [h('div.chips', a.releases.map(function (r) { return h('span.chip.sm' + (r.platform === 'PS5' ? '.ps5' : '.ps4'), { text: r.platform + (r.sizeBytes ? ' · ' + U.fmtBytes(r.sizeBytes) : '') }); }))]));
    if (ii) left.appendChild(ca.infoRow(t('homebrew.installedVersion'), ii.version === '?' ? t('homebrew.installed') : 'v' + ii.version));
    left.appendChild(ca.infoRow(t('homebrew.source'), 'pkg-zone.com'));
    rows.appendChild(h('div.section-head', [h('h2.section-title', { text: t('game2.info') })]));
    rows.appendChild(h('div.gp-cols', [left]));
    inner.appendChild(rows);
    var same = (cache.apps || []).filter(function (x) { return x !== a && x.category === a.category; }).slice(0, 20);
    if (same.length) inner.appendChild(rail(t('homebrew.moreIn', { cat: catLabel(a.category) }), same, { id: 'same-cat' }));
    appRoot.scrollTop = 0;
  }
  function installFlow(a, rel) {
    var go = function () { openInstall(a, rel); };
    if (rel.platform === 'PS4' && a.supportsPs5 !== false && bestRelease(a, 'PS5')) { ui.confirm(t('homebrew.ps4ConfirmTitle'), t('homebrew.ps4ConfirmText'), t('homebrew.installPs4')).then(function (ok) { if (ok) go(); }); return; }
    if (rel.platform === 'PS4') { ui.confirm(t('homebrew.ps4ConfirmTitle'), t('homebrew.ps4Warning'), t('homebrew.install')).then(function (ok) { if (ok) go(); }); return; }
    go();
  }
  function openInstall(a, rel) {
    var st = { root: S.defaultRoot(), autoInstall: !S.data.settings || !S.data.settings.downloads || S.data.settings.downloads.autoInstallPkg !== false };
    var handle = ui.sheet({
      title: t('homebrew.installTitle'), sub: a.title, key: 'hbinstall:' + a.id, cls: 'narrow',
      body: function (body) {
        var hero = h('div.cover-hero'); hero.appendChild(ui.cover(ca.api.imageUrl(a.cover), '', a.title));
        hero.appendChild(h('div.grow', [h('h4', { text: a.title }), h('div.meta', [h('span.chip.sm' + (rel.platform === 'PS5' ? '.ps5' : '.ps4'), { text: rel.platform }), ' ', h('span', { text: (a.version ? 'v' + a.version + ' · ' : '') + (rel.sizeBytes ? U.fmtBytes(rel.sizeBytes) : t('common.sizeUnknown')) })])]));
        body.appendChild(hero);
        body.appendChild(h('div.panel', [h('div.row', [ui.svg('box'), h('span.dim.small', { text: rel.filename || rel.url })])]));
        body.appendChild(h('h3', { text: t('dl.saveTo') }));
        var list = h('div.list');
        (S.data.storage || []).forEach(function (r, i) {
          var sel = st.root && st.root.path === r.path;
          var row = h('button.lrow' + (sel ? '.sel' : ''), { nav: 'root-' + i, data: { hints: 'select' } });
          if (!r.writable) row.setAttribute('aria-disabled', 'true');
          row.appendChild(h('span.ic', { html: U.icon(r.kind === 'usb' ? 'usb' : r.kind === 'm2' ? 'm2' : 'hdd') }));
          row.appendChild(h('div.main', [h('div.name', { text: r.label }), h('div.desc', { text: t('dl.free', { n: U.fmtBytes(r.free) }) })]));
          row.appendChild(h('span.check', { html: sel ? U.icon('check') : '' }));
          row.addEventListener('click', function () { if (!r.writable) return; st.root = r; U.$$('.lrow', list).forEach(function (x) { x.classList.remove('sel'); x.querySelector('.check').innerHTML = ''; }); row.classList.add('sel'); row.querySelector('.check').innerHTML = U.icon('check'); });
          list.appendChild(row);
        });
        body.appendChild(list);
        body.appendChild(h('h3', { text: t('dl.transfer') }));
        body.appendChild(ui.toggleRow({ id: 'hb-autoinstall', icon: 'box', label: t('dl.autoInstall'), desc: t('homebrew.autoInstallHint'), value: st.autoInstall, onChange: function (v) { st.autoInstall = v; } }));
      },
      foot: [
        h('span.spacer'),
        h('button.btn.primary.lg', { nav: 'dl-start', 'data-start': '', 'data-autofocus': '', html: U.icon('download') + '<span>' + U.escapeHtml(t('homebrew.installGo')) + '</span>', on: { click: start } })
      ]
    });
    function start() {
      if (!st.root) { ui.toast({ cls: 'bad', title: t('err.root_unavailable') }); return; }
      var btn = handle.foot.querySelector('[data-start]'); btn.classList.add('busy');
      var body = { gameId: a.id, releaseId: rel.id || '', url: rel.url, filename: rel.filename || (a.id + '-' + rel.platform.toLowerCase() + '.pkg'), format: 'PKG', root: st.root.path, autoInstall: st.autoInstall, title: a.title, cover: ca.api.imageUrl(a.cover), platform: rel.platform, kind: 'app' };
      api.queueAdd(body).then(function (r) {
        btn.classList.remove('busy');
        XS.actions.refreshQueue();
        ui.closeLayer(handle);
        ui.toast({ cls: 'gold', title: t('homebrew.queued', { title: a.title }), desc: st.autoInstall ? t('homebrew.queuedAuto') : '', cover: ca.api.imageUrl(a.cover), action: { label: t('game.viewDownloads'), onClick: function () { XS.router.go('downloads'); } } });
      }, function (err) { btn.classList.remove('busy'); if (err.error === 'already_queued' || err.error === 'queued') { ui.toast({ cls: 'gold', title: t('err.queued') }); return; } ui.errorToast(err, t('homebrew.install')); });
    }
  }

  XS.router.register('homebrew', {
    tab: true, icon: 'box', label: function () { return t('homebrew.tab'); },
    mount: function (el) { root = el; },
    show: function (params) { if (params && params.q !== undefined) scr.q = params.q; if (params && params.category !== undefined) scr.cat = params.category; if (!root.firstChild || (params && Object.keys(params).length)) render(); },
    refresh: render
  });
  XS.router.register('hbapp', {
    tab: false,
    mount: function (el) { appRoot = el; },
    key: function (params) { return 'hbapp:' + params.id; },
    show: function (params) { renderApp(params); },
    current: function () { return current; }
  });
  /* Nav order per SPEC §17.21: Discover · Browse · Homebrew · … (the router mounts tabs in registration order). */
  (function reorder() {
    var o = XS.router.order, i = o.indexOf('homebrew'), b = o.indexOf('browse');
    if (i > 0 && b >= 0 && i !== b + 1) { o.splice(i, 1); o.splice(b + 1, 0, 'homebrew'); }
  })();
  var lastKey = '';
  S.on('queue', function () { if (appRoot && appRoot.classList.contains('active') && current) { var job = S.activeJobFor(current.id); var key = job ? job.id + ':' + job.state + ':' + Math.floor(U.pct(job.written, job.total)) : 'none'; if (key !== lastKey) { lastKey = key; renderApp({ id: current.id }); } } });
  XS.homebrew = { load: load, essentials: essentials, rail: rail, card: card, byId: byId, install: installFlow, cardFromGame: function (g, prefix) { return card(byId(g.id) || normalize(g), prefix); } };
})();
