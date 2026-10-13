/* XENO STORE — 42-game.js: game page + Download options sheet (releases, save-to, connections, verify, speed test, links). */
(function () {
  'use strict';
  var XS = window.XS, U = XS.util, S = XS.state, ui = XS.ui, api = XS.api, h = U.h, t = XS.t;
  var root = null, current = null, statusEl = null, primaryEl = null;
  var KIND_ORDER = ['game', 'update', 'dlc', 'bundle', 'page'];

  function source(id) { for (var i = 0; i < S.data.sources.length; i++) if (S.data.sources[i].id === id) return S.data.sources[i]; return null; }
  function relKind(r) { if (r.format === 'PAGE') return 'page'; return KIND_ORDER.indexOf(r.kind) >= 0 ? r.kind : 'game'; }
  function isDirect(r) { var s = source(r.sourceId); return r.format !== 'PAGE' && (!s || s.kind === 'direct'); }
  function isBrowser(r) { var s = source(r.sourceId); return !!(s && s.kind === 'browser'); }
  function relPassword(r) { var s = source(r.sourceId); return r.password || (s && s.password) || ''; }
  /* Recommended release: verified direct game file with a known size, newest version first. */
  function bestRelease(g) {
    var rs = (g.releases || []).slice();
    rs.sort(function (a, b) {
      var ka = relKind(a) === 'game' ? 0 : 1, kb = relKind(b) === 'game' ? 0 : 1;
      if (ka !== kb) return ka - kb;
      var da = isDirect(a) ? 0 : isBrowser(a) ? 1 : 2, db = isDirect(b) ? 0 : isBrowser(b) ? 1 : 2;
      if (da !== db) return da - db;
      var va = a.verifiedAt ? 0 : 1, vb = b.verifiedAt ? 0 : 1;
      if (va !== vb) return va - vb;
      return (b.version || '') > (a.version || '') ? 1 : -1;
    });
    return rs[0] || null;
  }

  function render(params) {
    var g = S.game(params.id);
    current = g;
    U.clear(root);
    if (!g) {
      if (!S.data.catalog) { root.appendChild(h('div.screen-inner', [ui.skeletonRail(6)])); return; }
      root.appendChild(h('div.screen-inner.pad-top', [ui.emptyState(t('game.notFound'), t('game.notFoundHint'), [h('button.btn.primary', { nav: 'nf-back', text: t('common.back'), on: { click: function () { XS.router.back(); } } })])]));
      return;
    }
    api.recentAdd(g.id).then(function () { var r = S.data.recent.filter(function (x) { return x !== g.id; }); r.unshift(g.id); S.set('recent', r.slice(0, 30)); }, function () { /* offline: ignore */ });

    var bd = h('div.gp-backdrop'); bd.appendChild(ui.cover(g.hero || g.cover, g.heroFallback || g.coverFallback, g.title)); root.appendChild(bd);
    var inner = h('div.screen-inner.gp');
    root.appendChild(inner);
    var head = h('div.gp-head');
    var cov = h('div.gp-cover'); cov.appendChild(ui.cover(g.cover, g.coverFallback, g.title)); head.appendChild(cov);
    var info = h('div.gp-info');
    info.appendChild(h('div.chips', [ui.platChip(g.platform), g.region ? h('span.chip', { text: g.region }) : null, g.verified ? h('span.chip.gold', { html: U.icon('check') + '<span>' + U.escapeHtml(t('common.verified')) + '</span>' }) : null].concat((g.genres || []).slice(0, 3).map(function (gn) { return h('span.chip', { text: gn }); }))));
    info.appendChild(h('h1', { text: g.title }));
    if (g.tagline) info.appendChild(h('p.tagline', { text: g.tagline }));
    var meta = h('div.gp-meta');
    if (g.publisher) meta.appendChild(h('span', [t('game.publisher') + ' ', h('b', { text: g.publisher })]));
    if (g.developer && g.developer !== g.publisher) meta.appendChild(h('span', [t('game.developer') + ' ', h('b', { text: g.developer })]));
    if (g.releaseDate) meta.appendChild(h('span', [t('game.released') + ' ', h('b', { text: U.fmtDate(g.releaseDate) })]));
    meta.appendChild(h('span', [t('game.size') + ' ', h('b', { text: ui.sizeRange(g) })]));
    if (g.titleIds && g.titleIds.length) meta.appendChild(h('span', [t('game.titleId') + ' ', h('b.mono', { text: g.titleIds.join(', ') })]));
    meta.appendChild(h('span', [t('game.options') + ' ', h('b', { text: t('common.nOptions', { n: (g.releases || []).length }) })]));
    info.appendChild(meta);
    var fmts = h('div.gp-releases');
    ui.uniqueFormats(g).forEach(function (f) { fmts.appendChild(h('span.chip.fmt.sm', { text: f })); });
    (g.compat || []).forEach(function (c) { fmts.appendChild(h('span.chip.sm.acc', { text: t('game.fw', { fw: c }) })); });
    info.appendChild(fmts);
    statusEl = h('div'); info.appendChild(statusEl);
    var acts = h('div.gp-actions');
    primaryEl = h('span'); acts.appendChild(primaryEl);
    var fav = h('button.btn.lg.fav' + (S.isFav(g.id) ? '.on' : ''), { nav: 'gp-fav', html: U.icon('heart') + '<span>' + U.escapeHtml(t('game.favorite')) + '</span>', data: { game: g.id } });
    fav.addEventListener('click', function () { XS.actions.toggleFavorite(g.id); });
    acts.appendChild(fav);
    var coll = h('button.btn.lg', { nav: 'gp-coll', html: U.icon('plus') + '<span>' + U.escapeHtml(t('game.collection')) + '</span>' });
    coll.addEventListener('click', function () { XS.actions.collectionMenu(coll, g.id); });
    acts.appendChild(coll);
    var more = h('button.btn.lg.icon-only', { nav: 'gp-more', html: U.icon('more'), 'aria-label': t('common.more') });
    more.addEventListener('click', function () { moreMenu(more, g); });
    acts.appendChild(more);
    info.appendChild(acts);
    head.appendChild(info);
    inner.appendChild(head);
    if (g.description) {
      var desc = h('p.gp-desc.clamp3', { text: g.description });
      inner.appendChild(desc);
      if (g.description.length > 260) {
        var mb = h('button.btn.ghost.sm.gp-desc-more', { nav: 'gp-desc', text: t('common.readMore') });
        mb.addEventListener('click', function () { var open = desc.classList.toggle('clamp3'); mb.textContent = open ? t('common.readMore') : t('common.readLess'); });
        inner.appendChild(mb);
      }
    }
    paintStatus();
    var like = S.similar(g, 20);
    var ser = S.series(g, 20);
    if (ser.length) inner.appendChild(ui.rail(t('game.sameSeries'), ser, { id: 'series' }));
    if (like.length) inner.appendChild(ui.rail(t('game.moreLikeThis'), like, { id: 'similar' }));
    root.scrollTop = 0;
  }

  /* Primary action follows the game's active job (one primary action per page, Overdrive pattern). */
  function paintStatus() {
    if (!current || !statusEl) return;
    var g = current, job = S.activeJobFor(g.id);
    var hadFocus = primaryEl.contains(document.activeElement);
    U.clear(statusEl); U.clear(primaryEl);
    var dlAvail = !S.data.status || S.data.status.downloadsAvailable !== false;
    var hasRel = (g.releases || []).length > 0;
    var btn;
    if (job && ['downloading', 'connecting', 'queued', 'paused', 'failed', 'verifying', 'installing'].indexOf(job.state) >= 0) {
      var p = U.pct(job.written, job.total);
      var st = h('div.gp-status');
      st.appendChild(ui.statePill(job));
      st.appendChild(ui.progressBar(job));
      st.appendChild(h('span.pct', { text: job.total ? U.fmtPct(p) : '' }));
      var lbl = job.state === 'downloading' ? U.fmtSpeed(job.speed) + ' · ' + U.fmtDur(job.eta) : (job.message || job.phase || '');
      if (job.state === 'failed') lbl = ui.errorText(job);
      if (lbl) st.appendChild(h('span.lbl.dim.ellipsis', { text: lbl }));
      statusEl.appendChild(st);
      var action = job.state === 'downloading' || job.state === 'connecting' || job.state === 'queued' ? 'pause' : job.state === 'paused' ? 'resume' : job.state === 'failed' ? 'retry' : null;
      if (action) {
        btn = h('button.btn.primary.lg', { nav: 'gp-primary', html: U.icon(action === 'pause' ? 'pause' : action === 'resume' ? 'play' : 'retry') + '<span>' + U.escapeHtml(t('dl.action.' + action)) + '</span>' });
        btn.addEventListener('click', function () { XS.actions.jobAction(job, action); });
      } else {
        btn = h('button.btn.primary.lg', { nav: 'gp-primary', html: U.icon('download') + '<span>' + U.escapeHtml(t('game.viewDownloads')) + '</span>' });
        btn.addEventListener('click', function () { XS.router.go('downloads'); });
      }
      primaryEl.appendChild(btn);
      var again = h('button.btn.lg', { nav: 'gp-again', html: U.icon('download') + '<span>' + U.escapeHtml(t('game.downloadAgain')) + '</span>' });
      again.addEventListener('click', function () { openOptions(g); });
      primaryEl.appendChild(again);
    } else {
      if (job && (job.state === 'done' || job.state === 'installed')) {
        statusEl.appendChild(h('div.gp-status', [ui.statePill(job), h('span.lbl', { text: job.state === 'installed' ? t('game.installedAt', { path: job.path }) : t('game.downloadedTo', { path: job.path }) })]));
      }
      btn = h('button.btn.primary.lg', { nav: 'gp-primary', html: U.icon('download') + '<span>' + U.escapeHtml(hasRel ? t('game.download') : t('game.noSources')) + '</span>', data: { hints: 'select' } });
      if (!hasRel) btn.setAttribute('disabled', '');
      if (!dlAvail) btn.title = t('err.downloads_unavailable');
      btn.addEventListener('click', function () { if (hasRel) openOptions(g); });
      primaryEl.appendChild(btn);
    }
    if (hadFocus) XS.nav.focus(primaryEl.querySelector('[data-nav]'), false);
  }

  function moreMenu(anchor, g) {
    var best = bestRelease(g);
    var tid = (g.titleIds || [])[0] || '';
    var patches = tid ? (tid.indexOf('CUSA') === 0 ? 'https://orbispatches.com/' + tid : 'https://prosperopatches.com/' + tid) : '';
    var ip = S.data.status && S.data.status.ip ? S.data.status.ip : location.hostname;
    var port = S.data.status && S.data.status.port ? S.data.status.port : (location.port || 9095);
    var shareUrl = 'http://' + ip + ':' + port + '/#game/' + encodeURIComponent(g.id);
    var issue = 'https://github.com/XENOKING123/XENOKING/issues/new?title=' + encodeURIComponent('[XENO STORE] Broken link: ' + g.title + (tid ? ' (' + tid + ')' : '')) + '&body=' + encodeURIComponent('Game: ' + g.title + '\nID: ' + g.id + '\nRelease: ' + (best ? best.id + '\nURL: ' + best.url : '-') + '\nWhat happened: ');
    ui.menu(anchor, [
      { label: t('game.copyLink'), icon: 'copy', disabled: !best, onSelect: function () { U.copyText(best.url).then(function (ok) { ui.toast({ cls: ok ? 'good' : 'bad', title: ok ? t('toast.copied') : t('toast.copyFailed'), desc: ok ? best.url : '' }); }); } },
      { label: t('game.openPatches', { site: tid.indexOf('CUSA') === 0 ? 'orbispatches' : 'prosperopatches' }), icon: 'external', disabled: !patches, onSelect: function () { U.openExternal(patches); } },
      { label: t('game.shareToPhone'), icon: 'qr', onSelect: function () { ui.dialog({ title: t('game.shareToPhone'), body: [h('p', { text: t('game.shareHint') }), h('div', { style: { marginTop: '14px' } }, [ui.qr(shareUrl)]), h('div.pair-url', { text: shareUrl })], buttons: [{ label: t('common.close'), primary: true, autofocus: true }] }); } },
      'sep',
      { label: t('game.reportBroken'), icon: 'alert', sub: t('game.reportBrokenSub'), onSelect: function () { U.openExternal(issue); } }
    ]);
  }

  /* ---------- Download options sheet ---------- */
  function openOptions(g) {
    var st = {
      release: bestRelease(g), root: S.defaultRoot(), customUrl: '', customName: '', customFormat: '',
      connections: (S.data.settings && S.data.settings.downloads.connections) || 8,
      verify: !S.data.settings || S.data.settings.downloads.verifyHashes !== false,
      autoInstall: !S.data.settings || S.data.settings.downloads.autoInstallPkg !== false,
      overwrite: false, space: {}
    };
    var handle = ui.sheet({
      title: t('dl.title'), sub: g.title, cls: 'wide', key: 'dlopts:' + g.id,
      body: function (body, hd) { paintOptions(body, hd, g, st); },
      foot: [
        h('span.dim', { 'data-foot-info': '', text: '' }),
        h('span.spacer'),
        h('button.btn.primary.lg', { nav: 'dl-start', 'data-start': '', html: U.icon('download') + '<span>' + U.escapeHtml(t('dl.start')) + '</span>', on: { click: function () { startDownload(g, st, handle); } } })
      ]
    });
    api.storage().then(function (r) { S.set('storage', r.roots || []); if (!st.root) st.root = S.defaultRoot(); refreshSpace(g, st, handle); }, function () { refreshSpace(g, st, handle); });
  }
  function selSize(st) { return st.release && st.release.format !== 'PAGE' ? (st.release.sizeBytes || 0) : 0; }
  function refreshSpace(g, st, handle) {
    var size = selSize(st);
    var roots = S.data.storage || [];
    var pending = roots.length;
    if (!pending) { repaintSaveTo(handle, st); return; }
    roots.forEach(function (r) {
      api.space(r.path, size).then(function (sp) { st.space[r.path] = sp; }, function () { st.space[r.path] = null; }).then(function () { if (--pending === 0) repaintSaveTo(handle, st); });
    });
  }
  function repaintSaveTo(handle, st) {
    var box = handle.body.querySelector('[data-saveto]');
    if (box) { var fresh = saveToList(handle, st); box.parentNode.replaceChild(fresh, box); }
    updateFoot(handle, st);
  }
  function updateFoot(handle, st) {
    var info = handle.foot && handle.foot.querySelector('[data-foot-info]');
    var start = handle.foot && handle.foot.querySelector('[data-start]');
    if (!info || !start) return;
    var r = st.release;
    var page = r && (r.format === 'PAGE' || isBrowser(r)) && !st.customUrl;
    var sp = st.root ? st.space[st.root.path] : null;
    var fits = !sp || sp.fits !== false;
    info.textContent = r ? (st.customUrl ? t('dl.footCustom', { name: st.customName || st.customUrl }) : t('dl.footInfo', { format: ui.fmtLabel(r.format), size: selSize(st) ? U.fmtBytes(selSize(st)) : t('common.sizeUnknown'), root: st.root ? st.root.label : '—' })) : '';
    if (page) { start.innerHTML = U.icon('external') + '<span>' + U.escapeHtml(t('dl.openPage')) + '</span>'; start.classList.remove('primary'); start.classList.add('ghost'); }
    else { start.innerHTML = U.icon('download') + '<span>' + U.escapeHtml(fits ? t('dl.start') : t('dl.noSpace')) + '</span>'; start.classList.add('primary'); start.classList.remove('ghost'); }
    start.toggleAttribute('disabled', !r || (!page && !fits && !!sp));
  }

  function paintOptions(body, handle, g, st) {
    U.clear(body);
    var hero = h('div.cover-hero');
    hero.appendChild(ui.cover(g.cover, g.coverFallback, g.title));
    hero.appendChild(h('div.grow', [h('h4', { text: g.title }), h('div.meta', [ui.platChip(g.platform, true), ' ', h('span', { text: ui.sizeRange(g) })])]));
    body.appendChild(hero);

    /* Release table grouped Game · Updates · DLC · Pages */
    var groups = {};
    (g.releases || []).forEach(function (r) { var k = relKind(r); (groups[k] = groups[k] || []).push(r); });
    KIND_ORDER.forEach(function (k) {
      if (!groups[k]) return;
      if (k === 'bundle') { groups.game = (groups.game || []).concat(groups.bundle); return; }
    });
    ['game', 'update', 'dlc', 'page'].forEach(function (k) {
      var rs = groups[k]; if (!rs || !rs.length) return;
      body.appendChild(h('h3', [t('dl.group.' + k), h('span.count', { text: '· ' + rs.length })]));
      var list = h('div.list');
      rs.forEach(function (r, i) {
        var sel = st.release === r;
        var row = h('button.lrow' + (sel ? '.sel' : ''), { nav: 'rel-' + k + '-' + i, data: { hints: 'select' } });
        if (sel) row.setAttribute('data-autofocus', '');
        var kindIcon = r.format === 'PAGE' ? 'external' : isBrowser(r) ? 'globe' : (r.format === 'PKG' || r.format === 'FPKG') ? 'box' : 'hdd';
        row.appendChild(h('span.ic', { html: U.icon(kindIcon) }));
        var main = h('div.main');
        var l1 = h('div.rel');
        var left = h('div.l1');
        left.appendChild(h('span.chip.fmt.sm', { text: ui.fmtLabel(r.format) }));
        left.appendChild(h('span.name', { text: r.provider || (source(r.sourceId) || {}).name || r.sourceId }));
        if (r.version) left.appendChild(h('span.chip.sm', { text: 'v' + r.version }));
        if (r.region) left.appendChild(h('span.chip.sm', { text: r.region }));
        if (r.verifiedAt) left.appendChild(ui.tick(r.consoleVerified ? t('dl.consoleVerified') : t('common.verified')));
        if (r.compat) left.appendChild(h('span.chip.sm.acc', { text: t('game.fw', { fw: r.compat }) }));
        if (r === bestRelease(g)) left.appendChild(h('span.chip.sm.gold', { text: t('dl.recommended') }));
        l1.appendChild(left);
        l1.appendChild(h('span.size', { text: r.format === 'PAGE' ? '' : (r.sizeBytes ? U.fmtBytes(r.sizeBytes) : t('common.sizeUnknown')) }));
        var l2 = h('div.l2');
        if (r.filename) l2.appendChild(h('span.ellipsis', { text: r.filename, style: { maxWidth: '360px' } }));
        if (r.mirrors && r.mirrors.length) l2.appendChild(h('span', { text: t('dl.mirrors', { n: r.mirrors.length }) }));
        if (r.sha256 || r.md5 || r.sha1) l2.appendChild(h('span', { text: t('dl.hashKnown') }));
        if (r.notes) l2.appendChild(h('span', { text: r.notes }));
        if (!S.sourceEnabled(r.sourceId)) l2.appendChild(h('span.warn', { text: t('dl.sourceDisabled') }));
        l1.appendChild(l2);
        main.appendChild(l1);
        row.appendChild(main);
        row.appendChild(h('span.check', { html: sel ? U.icon('check') : '' }));
        row.addEventListener('click', function () {
          st.release = r; st.customUrl = ''; st.customName = ''; st.customFormat = '';
          U.$$('.lrow', body).forEach(function (x) { x.classList.remove('sel'); var c = x.querySelector(':scope > .check'); if (c) c.innerHTML = ''; });
          row.classList.add('sel'); row.querySelector(':scope > .check').innerHTML = U.icon('check');
          repaintSourceTools(body, handle, g, st);
          refreshSpace(g, st, handle);
        });
        list.appendChild(row);
      });
      body.appendChild(list);
    });

    body.appendChild(h('div', { 'data-sourcetools': '' }));
    repaintSourceTools(body, handle, g, st);

    body.appendChild(h('h3', { text: t('dl.saveTo') }));
    body.appendChild(saveToList(handle, st));

    body.appendChild(h('h3', { text: t('dl.transfer') }));
    var conn = h('div.lrow', { tabindex: '-1' });
    conn.appendChild(h('span.ic', { html: U.icon('zap') }));
    conn.appendChild(h('div.main', [h('div.name', { text: t('dl.connections') }), h('div.desc', { text: t('dl.connectionsHint') })]));
    conn.appendChild(ui.stepper({ id: 'dl-conn', value: st.connections, min: 1, max: 16, onChange: function (v) { st.connections = v; } }));
    body.appendChild(conn);
    body.appendChild(ui.toggleRow({ id: 'dl-verify', icon: 'shield', label: t('dl.verify'), desc: t('dl.verifyHint'), value: st.verify, onChange: function (v) { st.verify = v; } }));
    var fmt = st.release ? st.release.format : '';
    if (fmt === 'PKG' || fmt === 'FPKG' || st.customFormat === 'PKG' || st.customFormat === 'FPKG') {
      body.appendChild(ui.toggleRow({ id: 'dl-autoinstall', icon: 'box', label: t('dl.autoInstall'), desc: t('dl.autoInstallHint'), value: st.autoInstall, onChange: function (v) { st.autoInstall = v; } }));
    }
    var speed = h('button.lrow', { nav: 'dl-speed', data: { hints: 'select' } });
    speed.appendChild(h('span.ic', { html: U.icon('wifi') }));
    speed.appendChild(h('div.main', [h('div.name', { text: t('dl.speedTest') }), h('div.desc', { text: t('dl.speedTestHint') })]));
    speed.appendChild(h('span.val', { html: U.icon('chevR') }));
    speed.addEventListener('click', function () { speedTest(body, speed, st); });
    body.appendChild(speed);
    body.appendChild(h('div', { 'data-speed-results': '' }));
    updateFoot(handle, st);
  }

  /* Source-specific tools for browser/page releases: open on PS5 browser, Get links, Enter file link, password. */
  function repaintSourceTools(body, handle, g, st) {
    var box = body.querySelector('[data-sourcetools]');
    if (!box) return;
    U.clear(box);
    var r = st.release;
    if (!r) return;
    var pw = relPassword(r);
    var browser = r.format === 'PAGE' || isBrowser(r) || !!r.browserUrl;
    if (!browser && !pw && !st.customUrl) { updateFoot(handle, st); return; }
    box.appendChild(h('h3', { text: t('dl.sourceTools') }));
    if (browser) {
      var src = source(r.sourceId);
      box.appendChild(h('div.panel', { style: { marginBottom: '8px' } }, [h('div.row', [ui.svg('info'), h('span.dim', { text: (src && src.notice) || t('dl.browserNotice') })])]));
      var pageUrl = r.browserUrl || r.url;
      box.appendChild(ui.valueRow({ id: 'src-open', icon: 'external', label: t('dl.openOnPs5'), desc: pageUrl, onClick: function () { U.openExternal(pageUrl); } }));
      box.appendChild(ui.valueRow({ id: 'src-resolve', icon: 'link', label: t('dl.getLinks'), desc: t('dl.getLinksHint'), onClick: function (row) { resolveLinks(box, row, pageUrl, st, g, handle); } }));
    }
    box.appendChild(ui.valueRow({ id: 'src-enter', icon: 'key', label: t('dl.enterLink'), desc: st.customUrl ? st.customUrl : t('dl.enterLinkHint'), onClick: function () { enterLink(st, g, handle, body); } }));
    if (pw) {
      var shown = false;
      var pwRow = ui.valueRow({ id: 'src-pw', icon: 'eye', label: t('dl.password'), value: '••••••••', hints: 'select', onClick: function (row) {
        shown = !shown; row.querySelector('.val span').textContent = shown ? pw : '••••••••';
        if (shown) U.copyText(pw).then(function (ok) { if (ok) ui.toast({ cls: 'good', title: t('toast.passwordCopied'), desc: pw }); });
      } });
      box.appendChild(pwRow);
    }
    box.appendChild(h('div', { 'data-links': '' }));
    updateFoot(handle, st);
  }
  function resolveLinks(box, row, pageUrl, st, g, handle) {
    row.classList.add('busy');
    var out = box.querySelector('[data-links]'); U.clear(out);
    api.linksResolve(pageUrl).then(function (res) {
      row.classList.remove('busy');
      var links = res.links || [];
      if (!links.length) { out.appendChild(h('div.panel', [h('span.dim', { text: t('dl.noLinksFound') })])); return; }
      out.appendChild(h('h3', [t('dl.foundLinks'), h('span.count', { text: '· ' + links.length })]));
      var list = h('div.list');
      links.forEach(function (l, i) {
        var lr = h('button.lrow', { nav: 'lnk-' + i, data: { hints: 'select' } });
        lr.appendChild(h('span.ic', { html: U.icon('link') }));
        lr.appendChild(h('div.main', [h('div.name.ellipsis', { text: l.label || l.url }), h('div.desc.ellipsis', { text: (l.host || '') + (l.size ? ' · ' + U.fmtBytes(l.size) : '') })]));
        lr.appendChild(h('span.check', { html: '' }));
        lr.addEventListener('click', function () {
          st.customUrl = l.url; st.customName = l.label && /\.\w{2,6}$/.test(l.label) ? l.label : guessName(l.url); st.customFormat = guessFormat(st.customName);
          U.$$('.lrow', list).forEach(function (x) { x.querySelector('.check').innerHTML = ''; });
          lr.querySelector('.check').innerHTML = U.icon('check');
          updateFoot(handle, st);
          ui.toast({ cls: 'good', title: t('toast.linkSelected'), desc: st.customName });
        });
        list.appendChild(lr);
      });
      out.appendChild(list);
      var first = list.querySelector('[data-nav]'); if (first) XS.nav.focus(first);
    }, function (err) { row.classList.remove('busy'); ui.errorToast(err, t('dl.getLinks')); });
  }
  function guessName(url) { try { var p = decodeURIComponent(url.split('?')[0].split('#')[0]); return p.substring(p.lastIndexOf('/') + 1) || 'download.bin'; } catch (e) { return 'download.bin'; } }
  function guessFormat(name) {
    var m = /\.([a-z0-9]{2,6})$/i.exec(name || '');
    var ext = m ? m[1].toLowerCase() : '';
    var map = { ffpfsc: 'FFPFSC', exfat: 'exFAT', pkg: 'PKG', fpkg: 'FPKG', ffpkg: 'FFPKG', ffpfs: 'FFPFS', zip: 'ZIP', rar: 'RAR', '7z': '7z' };
    return map[ext] || '';
  }
  function enterLink(st, g, handle, body) {
    ui.prompt(t('dl.enterLink'), { label: t('dl.enterLinkLabel'), placeholder: 'https://…/PPSA00000.ffpfsc', value: st.customUrl, text: t('dl.enterLinkText'), okLabel: t('dl.useLink') }).then(function (v) {
      if (v === null) return;
      v = v.trim();
      if (!/^https?:\/\/[^\s@]+$/i.test(v)) { ui.toast({ cls: 'bad', title: t('err.bad_url') }); return; }
      st.customUrl = v; st.customName = guessName(v); st.customFormat = guessFormat(st.customName);
      repaintSourceTools(body, handle, g, st);
      refreshSpace(g, st, handle);
    });
  }
  function saveToList(handle, st) {
    var wrap = h('div.list', { 'data-saveto': '' });
    var roots = S.data.storage || [];
    if (!roots.length) { wrap.appendChild(h('div.panel', [h('span.dim', { text: t('dl.noRoots') })])); return wrap; }
    roots.forEach(function (r, i) {
      var sel = st.root && st.root.path === r.path;
      var sp = st.space[r.path];
      var row = h('button.lrow' + (sel ? '.sel' : ''), { nav: 'root-' + i, data: { hints: 'select' } });
      if (!r.writable) row.setAttribute('aria-disabled', 'true');
      row.appendChild(h('span.ic', { html: U.icon(r.kind === 'usb' ? 'usb' : r.kind === 'm2' ? 'm2' : 'hdd') }));
      var main = h('div.main', [h('div.name', [r.label, r['default'] ? h('span.chip.sm.gold', { text: t('lib.default'), style: { marginInlineStart: '8px' } }) : null])]);
      var d = [];
      d.push(t('dl.free', { n: U.fmtBytes(r.free) }));
      if (sp) { d.push(t('dl.afterQueue', { n: U.fmtBytes(sp.afterQueue) })); d.push(t('dl.afterThis', { n: U.fmtBytes(sp.afterThis) })); }
      main.appendChild(h('div.desc', { text: d.join(' · ') }));
      if (!r.writable) main.appendChild(h('div.desc.warn', { text: t('dl.notWritable') }));
      row.appendChild(main);
      if (sp) row.appendChild(h('span.chip.sm' + (sp.fits ? '.good' : '.bad'), { html: U.icon(sp.fits ? 'check' : 'x') + '<span>' + U.escapeHtml(sp.fits ? t('dl.fits') : t('dl.noFit')) + '</span>' }));
      row.appendChild(h('span.check', { html: sel ? U.icon('check') : '' }));
      row.addEventListener('click', function () {
        if (!r.writable) return;
        st.root = r;
        U.$$('.lrow', wrap).forEach(function (x) { x.classList.remove('sel'); x.querySelector(':scope > .check').innerHTML = ''; });
        row.classList.add('sel'); row.querySelector(':scope > .check').innerHTML = U.icon('check');
        updateFoot(handle, st);
      });
      wrap.appendChild(row);
    });
    return wrap;
  }
  function speedTest(body, row, st) {
    var r = st.release; if (!r) return;
    var urls = st.customUrl ? [st.customUrl] : [r.url].concat(r.mirrors || []).filter(Boolean).slice(0, 8);
    var out = body.querySelector('[data-speed-results]'); U.clear(out);
    row.classList.add('busy');
    out.appendChild(h('div.panel', [h('div.row', [h('span.skel', { style: { width: '18px', height: '18px', borderRadius: '50%' } }), h('span.dim', { text: t('dl.testing', { n: urls.length }) })])]));
    api.linksCheck(urls).then(function (res) {
      row.classList.remove('busy'); U.clear(out);
      var list = h('div.list');
      (res.results || []).forEach(function (x, i) {
        var ok = x.status >= 200 && x.status < 400;
        var host = ''; try { host = new URL(x.finalUrl || x.url).hostname; } catch (e) { host = x.url; }
        var lr = h('div.lrow', { tabindex: '-1' });
        lr.appendChild(h('span.ic' + (ok ? '.good' : '.bad'), { html: U.icon(ok ? 'check' : 'x') }));
        var desc = [];
        desc.push(ok ? t('dl.probeOk', { status: x.status }) : t('dl.probeFail', { status: x.status || t('err.networkShort') }));
        desc.push(x.acceptRanges ? t('dl.rangesYes') : t('dl.rangesNo'));
        if (x.size) desc.push(U.fmtBytes(x.size));
        lr.appendChild(h('div.main', [h('div.name.ellipsis', { text: (i === 0 ? t('dl.primary') + ' · ' : t('dl.mirror') + ' ' + i + ' · ') + host }), h('div.desc', { text: desc.join(' · ') })]));
        var v = h('span.val', [h('span', { text: (x.ms !== undefined ? x.ms + ' ms' : '—') })]);
        if (x.bytesPerSec) v.appendChild(h('span.dim', { text: '· ~' + U.fmtSpeed(x.bytesPerSec) }));
        lr.appendChild(v);
        list.appendChild(lr);
      });
      out.appendChild(list);
    }, function (err) { row.classList.remove('busy'); U.clear(out); ui.errorToast(err, t('dl.speedTest')); });
  }

  function startDownload(g, st, handle) {
    var r = st.release; if (!r) return;
    var page = (r.format === 'PAGE' || isBrowser(r)) && !st.customUrl;
    if (page) { U.openExternal(r.browserUrl || r.url); return; }
    if (!st.root) { ui.toast({ cls: 'bad', title: t('err.root_unavailable') }); return; }
    var body = { gameId: g.id, releaseId: r.id, root: st.root.path, connections: st.connections, verify: st.verify ? (r.sha256 ? 'sha256' : 'size') : 'none', autoInstall: st.autoInstall };
    if (st.customUrl) { body.url = st.customUrl; body.filename = st.customName; body.format = st.customFormat || r.format; }
    if (st.overwrite) body.overwrite = true;
    var start = handle.foot.querySelector('[data-start]');
    start.classList.add('busy');
    api.queueAdd(body).then(function (res) {
      start.classList.remove('busy');
      XS.actions.refreshQueue();
      queuedView(handle, g, res.job || {}, st);
    }, function (err) {
      start.classList.remove('busy');
      if (err.error === 'exists') {
        ui.confirm(t('dl.existsTitle'), t('dl.existsText'), t('dl.overwrite'), true).then(function (ok) { if (ok) { st.overwrite = true; startDownload(g, st, handle); } });
        return;
      }
      if (err.error === 'queued' || err.error === 'already_queued') {
        ui.toast({ cls: 'gold', title: t('err.queued'), action: { label: t('game.viewDownloads'), onClick: function () { XS.router.go('downloads'); } } });
        return;
      }
      XS.sound.error();
      var box = handle.body;
      var old = box.querySelector('[data-dl-error]'); if (old) old.parentNode.removeChild(old);
      box.insertBefore(h('div.job.st-failed', { 'data-dl-error': '', style: { display: 'block', marginBottom: '12px' } }, [h('div.err', { style: { gridColumn: 'auto' } }, [ui.svg('alert'), h('div', [h('b', { text: t('err.title') }), h('span', { text: ui.errorText(err) })])])]), box.firstChild);
      box.scrollTop = 0;
    });
  }
  /* After queueing: the sheet turns into a confirmation with "View downloads" as the one primary action. */
  function queuedView(handle, g, job, st) {
    XS.sound.select();
    var body = handle.body; U.clear(body);
    body.appendChild(h('div.wiz-hero', [h('span.ic', { style: { width: '64px', height: '64px', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(74,255,138,.14)', color: 'var(--good)', flex: '0 0 auto' }, html: U.icon('check').replace('<svg ', '<svg style="width:30px;height:30px;fill:none;stroke:currentColor;stroke-width:2.5" ') }), h('div', [h('h2', { text: t('dl.queuedTitle') }), h('p', { text: t('dl.queuedText', { title: g.title }) })])]));
    var kv = h('dl.kv');
    function add(k, v) { kv.appendChild(h('dt', { text: k })); kv.appendChild(h('dd', { text: v })); }
    add(t('dl.file'), job.filename || st.customName || (st.release && st.release.filename) || '');
    add(t('dl.format'), ui.fmtLabel(job.format || st.customFormat || (st.release && st.release.format)));
    add(t('dl.size'), job.total ? U.fmtBytes(job.total) : (selSize(st) ? U.fmtBytes(selSize(st)) : t('common.sizeUnknown')));
    add(t('dl.destination'), job.path || (st.root ? st.root.label : ''));
    add(t('dl.connections'), String(job.connections || st.connections));
    body.appendChild(h('div.panel', [kv]));
    U.clear(handle.foot);
    handle.foot.appendChild(h('button.btn.lg', { nav: 'q-done', text: t('common.done'), on: { click: function () { ui.closeLayer(handle); } } }));
    handle.foot.appendChild(h('span.spacer'));
    var view = h('button.btn.primary.lg', { nav: 'q-view', 'data-autofocus': '', html: U.icon('download') + '<span>' + U.escapeHtml(t('game.viewDownloads')) + '</span>' });
    view.addEventListener('click', function () { XS.router.go('downloads'); });   /* a tab switch collapses the sheet and the game page through history */
    handle.foot.appendChild(view);
    XS.nav.focus(view, false);
    ui.toast({ cls: 'gold', title: t('toast.queued'), desc: g.title, cover: g.cover });
  }

  XS.router.register('game', {
    tab: false,
    mount: function (el) { root = el; },
    key: function (params) { return 'game:' + params.id; },
    show: function (params) { render(params); },
    favorite: function () { if (current) XS.actions.toggleFavorite(current.id); },
    current: function () { return current; }
  });
  S.on('queue', function () { if (root && root.classList.contains('active') && current) {
    var job = S.activeJobFor(current.id);
    var key = job ? job.id + ':' + job.state + ':' + Math.floor(U.pct(job.written, job.total)) + ':' + (job.speed || 0) : 'none';
    if (key !== lastKey) { lastKey = key; paintStatus(); }
  } });
  var lastKey = '';
  S.on('favorites', function () { if (root) { var b = root.querySelector('.btn.fav[data-game]'); if (b) b.classList.toggle('on', S.isFav(b.getAttribute('data-game'))); U.$$('.card[data-game]', root).forEach(function (c) { c.classList.toggle('fav', S.isFav(c.getAttribute('data-game'))); }); } });
  S.on('catalog', function () { if (root && root.classList.contains('active') && XS.router.current().id === 'game') render(XS.router.current().params); });
  XS.gamePage = { openOptions: openOptions, bestRelease: bestRelease };
})();
