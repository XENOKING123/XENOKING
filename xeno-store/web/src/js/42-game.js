/* XENO STORE — 42-game.js: game page (§11.2 + §17.3/17.5/17.13/17.14/17.22): enrichment, screenshot rail + viewer,
   info panel, About, ambient backdrop, backports, Download best (reasons sheet), Download options sheet with
   "Download using" (debrid) and "Also download" install sets, Saves tab, share / report. */
(function () {
  'use strict';
  var XS = window.XS, U = XS.util, S = XS.state, ui = XS.ui, api = XS.api, ca = XS.ca, h = U.h, t = XS.t;
  var root = null, current = null, statusEl = null, primaryEl = null, overviewEl = null, savesEl = null, tabsEl = null, galleryEl = null, infoEl = null, aboutEl = null;
  var KIND_ORDER = ['game', 'backport', 'update', 'dlc', 'page'];
  var tabByGame = {};

  function source(id) { for (var i = 0; i < S.data.sources.length; i++) if (S.data.sources[i].id === id) return S.data.sources[i]; return null; }
  var relKind = ca.relKind;
  function isDirect(r) { var s = source(r.sourceId); return r.format !== 'PAGE' && (!s || s.kind === 'direct'); }
  function isBrowser(r) { var s = source(r.sourceId); return !!(s && s.kind === 'browser'); }
  function relPassword(r) { var s = source(r.sourceId); return r.password || (s && s.password) || ''; }
  function fwOk(r) {
    var fw = ca.fwNum(ca.consoleFw()); if (!fw) return true;
    var need = ca.fwNum(r.requiresFw || r.compat);
    if (relKind(r) === 'backport') need = ca.fwNum(r.backportFw || r.requiresFw);
    return !need || need <= fw;
  }
  function preferFormat() { var d = S.data.settings && S.data.settings.downloads; return d && d.preferFormat && d.preferFormat !== 'auto' ? String(d.preferFormat).toUpperCase() : ''; }
  /* Client-side "best": compatible fw → verified direct → newest version → smallest (mirrors /api/game/best). */
  function rankRelease(r) {
    var k = relKind(r) === 'game' ? 0 : relKind(r) === 'backport' ? 1 : 2;
    var compat = fwOk(r) ? 0 : 1;
    var d = isDirect(r) ? 0 : isBrowser(r) ? 1 : 2;
    var v = r.verifiedAt || r.consoleVerified || r.sha256 || r.md5 ? 0 : 1;
    var pf = preferFormat() && String(r.format).toUpperCase() === preferFormat() ? 0 : 1;
    return [k, compat, d, v, pf];
  }
  function bestRelease(g) {
    var rs = (g.releases || []).slice();
    rs.sort(function (a, b) {
      var ra = rankRelease(a), rb = rankRelease(b);
      for (var i = 0; i < ra.length; i++) if (ra[i] !== rb[i]) return ra[i] - rb[i];
      var vc = ca.semverCmp(b.version || '', a.version || ''); if (vc) return vc;
      return (a.sizeBytes || Infinity) - (b.sizeBytes || Infinity);
    });
    return rs[0] || null;
  }
  function localReasons(g, r) {
    var out = [], fw = ca.consoleFw();
    if (!r) return out;
    if (fw && fwOk(r)) out.push(t('game2.reason.compat', { fw: fw }));
    if (isDirect(r) && (r.verifiedAt || r.consoleVerified)) out.push(t('game2.reason.verified'));
    else if (isDirect(r)) out.push(t('game2.reason.direct'));
    if (r.sha256 || r.md5 || r.sha1) out.push(t('game2.reason.hash'));
    var others = (g.releases || []).filter(function (x) { return x !== r && relKind(x) === relKind(r); });
    if (r.version && others.every(function (x) { return ca.semverCmp(x.version || '', r.version) <= 0; })) out.push(t('game2.reason.newest', { v: r.version }));
    if (r.sizeBytes && others.length && others.every(function (x) { return !x.sizeBytes || x.sizeBytes >= r.sizeBytes; })) out.push(t('game2.reason.smallest', { size: U.fmtBytes(r.sizeBytes) }));
    if (preferFormat() && String(r.format).toUpperCase() === preferFormat()) out.push(t('game2.reason.preferred', { format: ui.fmtLabel(r.format) }));
    if (!others.length) out.push(t('game2.reason.onlyOne'));
    return out;
  }

  /* ---------- page ---------- */
  function render(params) {
    var g = S.game(params.id);
    current = g;
    U.clear(root);
    root.style.removeProperty('--gp-ambient');
    if (!g) {
      if (!S.data.catalog) { root.appendChild(h('div.screen-inner', [ui.skeletonRail(6)])); return; }
      root.appendChild(h('div.screen-inner.pad-top', [ui.emptyState(t('game.notFound'), t('game.notFoundHint'), [h('button.btn.primary', { nav: 'nf-back', text: t('common.back'), on: { click: function () { XS.router.back(); } } })])]));
      return;
    }
    if (g.platform === 'HOMEBREW') {
      /* catalog entries from pkg-zone have their own page */
      root.appendChild(h('div.screen-inner.pad-top', [ui.emptyState(g.title, t('homebrew.subtitle'), [h('button.btn.primary', { nav: 'nf-hb', 'data-autofocus': '', html: U.icon('box') + '<span>' + U.escapeHtml(t('homebrew.tab')) + '</span>', on: { click: function () { XS.router.go('hbapp', { id: g.id }); } } })])]));
      return;
    }
    api.recentAdd(g.id).then(function () { var r = S.data.recent.filter(function (x) { return x !== g.id; }); r.unshift(g.id); S.set('recent', r.slice(0, 30)); }, function () { /* offline: ignore */ });
    var local = ca.enrichLocal(g), counts = ca.counts(g);

    var bd = h('div.gp-backdrop'); bd.appendChild(ui.cover(g.hero || g.cover, g.heroFallback || g.coverFallback, g.title)); root.appendChild(bd);
    root.style.setProperty('--gp-ambient', ca.hashTint(g.title, g.tint));
    ca.ambient(g.cover || g.hero, ca.hashTint(g.title, g.tint)).then(function (c) { if (current === g) root.style.setProperty('--gp-ambient', c); });

    var inner = h('div.screen-inner.gp');
    root.appendChild(inner);
    var head = h('div.gp-head');
    var cov = h('div.gp-cover'); cov.appendChild(ui.cover(g.cover, g.coverFallback, g.title)); head.appendChild(cov);
    var info = h('div.gp-info');
    var chips = h('div.chips', [ui.platChip(g.platform), g.region ? h('span.chip', { text: g.region }) : null, g.verified ? h('span.chip.gold', { html: U.icon('check') + '<span>' + U.escapeHtml(t('common.verified')) + '</span>' }) : null]);
    (local.genres || []).slice(0, 3).forEach(function (gn) { chips.appendChild(h('span.chip', { text: gn })); });
    var mc = ca.metacritic(local.metacritic); if (mc) chips.appendChild(mc);
    info.appendChild(chips);
    info.appendChild(h('h1', { text: g.title }));
    if (g.tagline) info.appendChild(h('p.tagline', { text: g.tagline }));
    var meta = h('div.gp-meta');
    if (local.publisher) meta.appendChild(h('span', [t('game.publisher') + ' ', h('b', { text: local.publisher })]));
    if (local.developer && local.developer !== local.publisher) meta.appendChild(h('span', [t('game.developer') + ' ', h('b', { text: local.developer })]));
    if (local.releaseDate) meta.appendChild(h('span', [t('game.released') + ' ', h('b', { text: U.fmtDate(local.releaseDate) })]));
    meta.appendChild(h('span', [t('game.size') + ' ', h('b', { text: ui.sizeRange(g) })]));
    if (g.titleIds && g.titleIds.length) meta.appendChild(h('span', [t('game.titleId') + ' ', h('b.mono', { text: g.titleIds.join(', ') })]));
    meta.appendChild(h('span', [t('game.options') + ' ', h('b', { text: t('common.nOptions', { n: (g.releases || []).length }) })]));
    info.appendChild(meta);
    var fmts = h('div.gp-releases');
    ui.uniqueFormats(g).forEach(function (fm) { fmts.appendChild(h('span.chip.fmt.sm', { text: fm })); });
    ca.fwTags(g).slice(0, 4).forEach(function (c) { fmts.appendChild(h('span.chip.sm.acc', { text: t('game.fw', { fw: c }) })); });
    if (counts.backport) fmts.appendChild(h('span.chip.sm.warn', { text: t('game2.includedBackports', { n: counts.backport }) }));
    if (g.cheats > 0) {
      var ch = h('a.chip.sm.gold.cheats', { nav: 'gp-cheats', href: ca.XENO_TOOL_URL, html: U.icon('zap') + '<span>' + U.escapeHtml(t('game2.cheatsChip', { n: g.cheats })) + '</span>', title: t('game2.cheatsHint'), data: { hints: 'open' } });
      ch.addEventListener('click', function (e) { e.preventDefault(); U.openExternal(ca.XENO_TOOL_URL); });
      fmts.appendChild(ch);
    }
    info.appendChild(fmts);
    statusEl = h('div'); info.appendChild(statusEl);
    var acts = h('div.gp-actions');
    primaryEl = h('span.gp-primary-wrap'); acts.appendChild(primaryEl);
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
    paintStatus();

    /* Overview · Saves tabs (Saves is PS5 only, §17.22) */
    overviewEl = h('div.gp-overview'); savesEl = h('div.gp-saves', { hidden: true });
    var ps5 = g.platform === 'PS5' && !!XS.saves;
    if (ps5) {
      tabsEl = ui.subtabs({ id: 'gp-tab', value: tabByGame[g.id] || 'overview', tabs: [{ id: 'overview', label: t('game2.tabOverview') }, { id: 'saves', label: t('game2.tabSaves'), count: 0 }], onChange: function (id) { showTab(g, id); } });
      tabsEl.classList.add('gp-tabs');
      inner.appendChild(tabsEl);
      XS.saves.count(g).then(function (n) { if (current === g && tabsEl) tabsEl.setCount('saves', n); }, function () { /* offline */ });
    } else tabsEl = null;
    inner.appendChild(overviewEl); inner.appendChild(savesEl);

    /* Overview: gallery (fades in with enrichment) · info panel · about · backports · rails */
    galleryEl = h('section.gp-gallery.pending');
    if (!ca.safeMode()) { var sk = h('div.gal-rail.skel-row'); for (var i = 0; i < 4; i++) sk.appendChild(h('div.skel.gal-skel')); galleryEl.appendChild(sk); }
    overviewEl.appendChild(galleryEl);
    infoEl = h('section.gp-infopanel'); overviewEl.appendChild(infoEl);
    aboutEl = h('section.gp-about'); overviewEl.appendChild(aboutEl);
    paintInfo(g, local); paintAbout(g, local); paintGallery(g, local, false);
    if (counts.backport) overviewEl.appendChild(backportsSection(g));
    var ser = sameSeries(g), like = S.similar(g, 20).filter(ca.isGame), twin = ca.twin(g);
    if (twin) overviewEl.appendChild(twinRow(twin));
    if (ser.length) overviewEl.appendChild(ui.rail(t('game.sameSeries'), ser, { id: 'series' }));
    if (like.length) overviewEl.appendChild(ui.rail(t('game.moreLikeThis'), like, { id: 'similar' }));
    if (ps5 && (tabByGame[g.id] === 'saves')) showTab(g, 'saves');
    root.scrollTop = 0;

    ca.enrich(g).then(function (e) {
      if (current !== g || !e) return;
      paintInfo(g, e); paintAbout(g, e); paintGallery(g, e, true);
      var mc2 = ca.metacritic(e.metacritic);
      if (mc2 && !chips.querySelector('.mc')) chips.appendChild(mc2);
      if (e.developer && !local.developer && e.developer !== local.publisher) meta.insertBefore(h('span', [t('game.developer') + ' ', h('b', { text: e.developer })]), meta.firstChild ? meta.firstChild.nextSibling : null);
    });
  }
  function showTab(g, id) {
    tabByGame[g.id] = id;
    overviewEl.hidden = id !== 'overview'; savesEl.hidden = id !== 'saves';
    if (id === 'saves' && XS.saves && !savesEl.firstChild) XS.saves.renderGameTab(savesEl, g, { onCount: function (n) { if (tabsEl) tabsEl.setCount('saves', n); } });
  }
  function sameSeries(g) {
    var key = ca.seriesOf(g); if (!key) return [];
    var out = [];
    for (var i = 0; i < S.data.games.length && out.length < 20; i++) { var o = S.data.games[i]; if (o !== g && ca.isGame(o) && ca.seriesOf(o) === key) out.push(o); }
    return out;
  }
  function twinRow(twin) {
    var row = h('button.gp-twin', { nav: 'gp-twin', data: { hints: 'open' } });
    row.appendChild(ui.cover(twin.cover, twin.coverFallback, twin.title));
    row.appendChild(h('div.grow', [h('div.k', { text: t('game2.alsoOn', { platform: twin.platform }) }), h('div.name', { text: twin.title }), h('div.desc', { text: ui.sizeRange(twin) + ' · ' + ui.uniqueFormats(twin).slice(0, 3).join(' · ') })]));
    row.appendChild(ui.platChip(twin.platform));
    row.appendChild(ui.svg('chevR'));
    row.addEventListener('click', function () { XS.router.go('game', { id: twin.id }); });
    return row;
  }

  /* ---------- gallery rail (§17.3) ---------- */
  function paintGallery(g, e, fromApi) {
    if (!galleryEl) return;
    var shots = (e && e.screenshots) || [];
    if (!shots.length) { if (fromApi || ca.safeMode()) { galleryEl.hidden = true; U.clear(galleryEl); } return; }
    U.clear(galleryEl);
    galleryEl.hidden = false;
    galleryEl.classList.remove('pending');
    galleryEl.appendChild(h('div.section-head', [h('h2.section-title', [t('game2.screenshots'), h('span.count', { text: t('gallery.nImages', { n: shots.length }) })])]));
    var rail = h('div.gal-rail', { data: { navRegion: '' } });
    var max = Math.min(shots.length, 6);
    function open(i) { ca.gallery(shots, i, { title: g.title, key: 'gallery:' + g.id }); }
    for (var i = 0; i < max; i++) {
      (function (i) {
        var th = h('button.gal-thumb', { nav: 'shot-' + i, 'aria-label': t('gallery.counter', { i: i + 1, n: shots.length }), data: { hints: 'open' } });
        th.appendChild(ui.cover(shots[i], '', g.title, { phLabel: '' }));
        th.addEventListener('click', function () { open(i); });
        rail.appendChild(th);
      })(i);
    }
    var all = h('button.gal-thumb.more', { nav: 'shot-all', data: { hints: 'open' } }, [ui.svg('image'), h('span', { text: t('game2.viewGallery') }), h('small', { text: t('gallery.nImages', { n: shots.length }) })]);
    all.addEventListener('click', function () { open(0); });
    rail.appendChild(all);
    galleryEl.appendChild(rail);
    if (fromApi && !U.reducedMotion() && !ca.safeMode()) { galleryEl.classList.add('fade-in'); }
  }

  /* ---------- info panel (§17.3) ---------- */
  function paintInfo(g, e) {
    if (!infoEl) return;
    U.clear(infoEl);
    var counts = ca.counts(g);
    var left = h('div.gp-col'), right = h('div.gp-col');
    left.appendChild(ca.infoRow(t('game.developer'), e.developer || ''));
    left.appendChild(ca.infoRow(t('game.publisher'), e.publisher || ''));
    left.appendChild(ca.infoRow(t('game2.releaseDate'), e.releaseDate ? U.fmtDate(e.releaseDate) : ''));
    if (e.genres && e.genres.length) left.appendChild(ca.infoRow(t('game2.genres'), ca.chipList(e.genres)));
    if (typeof e.metacritic === 'number' && e.metacritic > 0) left.appendChild(ca.infoRow(t('game2.metacritic'), [ca.metacritic(e.metacritic, true)]));
    if (typeof e.ageRating === 'number' && e.ageRating > 0) left.appendChild(ca.infoRow(t('game2.ageRating'), t('game2.ageValue', { n: e.ageRating })));
    if (e.languages && e.languages.length) {
      var langs = e.languages.slice(0, 8).join(', ') + (e.languages.length > 8 ? ' ' + t('game2.moreN', { n: e.languages.length - 8 }) : '');
      left.appendChild(ca.infoRow(t('game2.languages'), langs));
    }
    if (e.features && e.features.length) left.appendChild(ca.infoRow(t('game2.features'), ca.chipList(e.features, '.acc')));
    if (typeof e.hltb === 'number' && e.hltb > 0) left.appendChild(ca.infoRow(t('game2.hltb'), t('game2.hltbValue', { n: e.hltb })));
    if (e.players) left.appendChild(ca.infoRow(t('game2.players'), String(e.players)));
    /* platform + title ids with region chips */
    var ids = h('div.chips');
    ids.appendChild(ui.platChip(g.platform, true));
    var tids = g.titleIds || [];
    tids.forEach(function (tid) {
      var regions = {}; if (g.region) regions[g.region] = 1;
      (g.releases || []).forEach(function (r) { if (r.titleId === tid && r.region) regions[r.region] = 1; });
      var chip = h('span.chip.sm.mono', { text: tid });
      Object.keys(regions).forEach(function (rg) { chip.appendChild(h('em.reg', { text: ca.regionCode(rg) })); });
      ids.appendChild(chip);
    });
    if (!tids.length) ids.appendChild(h('span.chip.sm', { text: t('game2.noTitleId') }));
    right.appendChild(ca.infoRow(t('game2.platformIds'), [ids]));
    var fws = ca.fwTags(g);
    right.appendChild(ca.infoRow(t('game2.firmware'), fws.length ? [ca.chipList(fws.map(function (x) { return t('game.fw', { fw: x }); }), '.acc')] : t('game2.fwNotListed')));
    var inc = [];
    if (counts.game) inc.push(t('game2.includedBase'));
    if (counts.update) inc.push(t('game2.includedUpdates', { n: counts.update }));
    if (counts.dlc) inc.push(t('game2.includedDlc', { n: counts.dlc }));
    if (counts.backport) inc.push(t('game2.includedBackports', { n: counts.backport }));
    if (counts.page) inc.push(t('game2.includedPages', { n: counts.page }));
    if (inc.length) right.appendChild(ca.infoRow(t('game2.included'), [ca.chipList(inc)]));
    var sizes = ca.sizesByFormat(g);
    if (sizes.length) right.appendChild(ca.infoRow(t('game2.sizesByFormat'), [h('div.sizes', sizes.map(function (s) { return h('span', [h('b.mono', { text: s.format }), ' ', s.min === s.max ? U.fmtBytes(s.max) : U.fmtBytes(s.min) + ' – ' + U.fmtBytes(s.max)]); }))]));
    if (g.cheats > 0) right.appendChild(ca.infoRow(t('game2.cheats'), t('game2.cheatsValue', { n: g.cheats })));
    if (g.psStoreUrl) { var ps = h('button.btn.sm.ghost', { nav: 'gp-psstore', html: U.icon('external') + '<span>' + U.escapeHtml(t('game2.psStore')) + '</span>' }); ps.addEventListener('click', function () { U.openExternal(g.psStoreUrl); }); right.appendChild(ca.infoRow(t('game2.store'), [ps])); }
    var cols = h('div.gp-cols', [left, right]);
    if (!left.children.length && !right.children.length) { infoEl.hidden = true; return; }
    infoEl.hidden = false;
    infoEl.appendChild(h('div.section-head', [h('h2.section-title', { text: t('game2.info') })]));
    infoEl.appendChild(cols);
  }
  function paintAbout(g, e) {
    if (!aboutEl) return;
    U.clear(aboutEl);
    var text = (e && e.about) || g.about || g.description || '';
    if (!text) { aboutEl.hidden = true; return; }
    aboutEl.hidden = false;
    aboutEl.appendChild(h('div.section-head', [h('h2.section-title', { text: t('game2.about') })]));
    var p = h('div.gp-desc.clamp4');
    String(text).split(/\n{2,}/).forEach(function (para) { if (para.trim()) p.appendChild(h('p', { text: para.trim() })); });
    aboutEl.appendChild(p);
    if (String(text).length > 320 || String(text).split(/\n{2,}/).length > 1) {
      var mb = h('button.btn.ghost.sm.gp-desc-more', { nav: 'gp-desc', text: t('common.readMore'), 'aria-expanded': 'false' });
      mb.addEventListener('click', function () { var open = !p.classList.toggle('clamp4'); mb.textContent = open ? t('common.readLess') : t('common.readMore'); mb.setAttribute('aria-expanded', open ? 'true' : 'false'); });
      aboutEl.appendChild(mb);
    }
  }

  /* ---------- backports (§17.13): grouped by target firmware, newest first, "Why?" ---------- */
  function backportsSection(g) {
    var sec = h('section.gp-backports');
    var groups = {}, order = [];
    (g.releases || []).forEach(function (r) { if (relKind(r) !== 'backport') return; var fw = r.backportFw || r.compat || t('game2.fwUnknown'); if (!groups[fw]) { groups[fw] = []; order.push(fw); } groups[fw].push(r); });
    order.sort(function (a, b) { return ca.fwNum(b) - ca.fwNum(a); });
    var head = h('div.section-head', [h('h2.section-title', [t('game2.backports'), h('span.count', { text: t('common.nOptions', { n: order.reduce(function (n, k) { return n + groups[k].length; }, 0) }) })])]);
    head.appendChild(ca.why('bp-why', t('game2.backportsWhy'), t('game2.backportsWhyText')));
    sec.appendChild(head);
    var fw = ca.consoleFw();
    order.forEach(function (k) {
      var rs = groups[k].slice().sort(function (a, b) { return ca.semverCmp(b.version || '', a.version || ''); });
      var runs = fw && ca.fwNum(k) && ca.fwNum(k) <= ca.fwNum(fw);
      sec.appendChild(h('h4.bp-fw', [t('game2.forFw', { fw: k }), runs ? h('span.chip.sm.good', { html: U.icon('check') + '<span>' + U.escapeHtml(t('game2.runsOnYours', { fw: fw })) + '</span>' }) : null]));
      var list = h('div.list', { data: { navRegion: '' } });
      rs.forEach(function (r, i) {
        var row = h('button.lrow', { nav: 'bp-' + k.replace(/\W/g, '') + '-' + i, data: { hints: 'select' } });
        row.appendChild(h('span.ic', { html: U.icon('box') }));
        var l1 = h('div.l1', [ca.kindChip('backport'), h('span.chip.fmt.sm', { text: ui.fmtLabel(r.format) }), h('span.name', { text: r.provider || r.sourceId }), r.version ? h('span.chip.sm', { text: 'v' + r.version }) : null, r.region ? h('span.chip.sm', { text: r.region }) : null, r.requiresFw ? h('span.chip.sm.warn', { text: t('game2.requiresFw', { fw: r.requiresFw }) }) : null]);
        var l2 = h('div.desc', { text: [r.filename, r.notes].filter(Boolean).join(' · ') });
        row.appendChild(h('div.main', [l1, l2]));
        row.appendChild(h('span.sz', { text: r.sizeBytes ? U.fmtBytes(r.sizeBytes) : '' }));
        row.appendChild(h('span.val', { html: U.icon('download') }));
        row.addEventListener('click', function () { openOptions(g, r); });
        list.appendChild(row);
      });
      sec.appendChild(list);
    });
    return sec;
  }

  /* ---------- Primary action: Download best (gold) + Options; or the active job's action ---------- */
  function paintStatus() {
    if (!current || !statusEl) return;
    var g = current, job = S.activeJobFor(g.id);
    var hadFocus = primaryEl.contains(document.activeElement);
    U.clear(statusEl); U.clear(primaryEl);
    var dlAvail = !S.data.status || S.data.status.downloadsAvailable !== false;
    var hasRel = (g.releases || []).length > 0;
    var best = hasRel ? bestRelease(g) : null;
    var bestIsFile = !!best && best.format !== 'PAGE' && !isBrowser(best);
    var btn;
    if (job && ['downloading', 'connecting', 'queued', 'paused', 'failed', 'verifying', 'installing'].indexOf(job.state) >= 0) {
      var p = U.pct(job.written, job.total);
      var st = h('div.gp-status');
      st.appendChild(ui.statePill(job));
      st.appendChild(ui.progressBar(job));
      st.appendChild(h('span.pct', { text: job.total ? U.fmtPct(p) : '' }));
      var lbl = job.state === 'downloading' ? U.fmtSpeed(job.speed) + ' · ' + U.fmtDur(job.eta) : (job.message || job.phase || '');
      if (job.state === 'failed') lbl = ui.errorText(job);
      if (job.via) lbl = (lbl ? lbl + ' · ' : '') + t('game2.viaLabel', { service: job.via });
      if (lbl) st.appendChild(h('span.lbl.dim.ellipsis', { text: lbl }));
      statusEl.appendChild(st);
      var action = job.state === 'downloading' || job.state === 'connecting' || job.state === 'queued' ? 'pause' : job.state === 'paused' ? 'resume' : job.state === 'failed' ? 'retry' : null;
      if (action) {
        btn = h('button.btn.primary.lg', { nav: 'gp-primary', 'data-autofocus': '', html: U.icon(action === 'pause' ? 'pause' : action === 'resume' ? 'play' : 'retry') + '<span>' + U.escapeHtml(t('dl.action.' + action)) + '</span>' });
        btn.addEventListener('click', function () { XS.actions.jobAction(job, action); });
      } else {
        btn = h('button.btn.primary.lg', { nav: 'gp-primary', 'data-autofocus': '', html: U.icon('download') + '<span>' + U.escapeHtml(t('game.viewDownloads')) + '</span>' });
        btn.addEventListener('click', function () { XS.router.go('downloads'); });
      }
      primaryEl.appendChild(btn);
      var again = h('button.btn.lg', { nav: 'gp-options', html: U.icon('download') + '<span>' + U.escapeHtml(t('game.downloadAgain')) + '</span>' });
      again.addEventListener('click', function () { openOptions(g); });
      primaryEl.appendChild(again);
    } else {
      if (job && (job.state === 'done' || job.state === 'installed')) {
        statusEl.appendChild(h('div.gp-status', [ui.statePill(job), h('span.lbl', { text: job.state === 'installed' ? t('game.installedAt', { path: job.path }) : t('game.downloadedTo', { path: job.path }) })]));
      }
      if (hasRel && bestIsFile) {
        btn = h('button.btn.primary.lg', { nav: 'gp-primary', 'data-autofocus': '', html: U.icon('zap') + '<span>' + U.escapeHtml(t('game2.downloadBest')) + '</span>', data: { hints: 'select' } });
        if (!dlAvail) btn.title = t('err.downloads_unavailable');
        btn.addEventListener('click', function () { openBest(g); });
        primaryEl.appendChild(btn);
        var opt = h('button.btn.lg', { nav: 'gp-options', html: U.icon('sliders') + '<span>' + U.escapeHtml(t('game2.options')) + '</span>' });
        opt.addEventListener('click', function () { openOptions(g); });
        primaryEl.appendChild(opt);
      } else {
        btn = h('button.btn.primary.lg', { nav: 'gp-primary', 'data-autofocus': '', html: U.icon('download') + '<span>' + U.escapeHtml(hasRel ? t('game.download') : t('game.noSources')) + '</span>', data: { hints: 'select' } });
        if (!hasRel) btn.setAttribute('disabled', '');
        if (!dlAvail) btn.title = t('err.downloads_unavailable');
        btn.addEventListener('click', function () { if (hasRel) openOptions(g); });
        primaryEl.appendChild(btn);
        if (!hasRel) { var rq = h('button.btn.lg', { nav: 'gp-request', html: U.icon('plus') + '<span>' + U.escapeHtml(t('game2.requestGame')) + '</span>' }); rq.addEventListener('click', function () { ca.requestGame(g.title); }); primaryEl.appendChild(rq); }
      }
    }
    if (hadFocus) XS.nav.focus(primaryEl.querySelector('[data-nav]'), false);
  }

  function moreMenu(anchor, g) {
    var best = bestRelease(g);
    var tid = (g.titleIds || [])[0] || '';
    var patches = tid ? (tid.indexOf('CUSA') === 0 ? 'https://orbispatches.com/' + tid : 'https://prosperopatches.com/' + tid) : '';
    var items = [
      { label: t('game.copyLink'), icon: 'copy', disabled: !best, onSelect: function () { U.copyText(best.url).then(function (ok) { ui.toast({ cls: ok ? 'good' : 'bad', title: ok ? t('toast.copied') : t('toast.copyFailed'), desc: ok ? best.url : '' }); }); } },
      { label: t('game.openPatches', { site: tid.indexOf('CUSA') === 0 ? 'orbispatches' : 'prosperopatches' }), icon: 'external', disabled: !patches, onSelect: function () { U.openExternal(patches); } }
    ];
    if (g.psStoreUrl) items.push({ label: t('game2.psStore'), icon: 'external', onSelect: function () { U.openExternal(g.psStoreUrl); } });
    if (g.cheats > 0) items.push({ label: t('game2.cheatsChip', { n: g.cheats }), icon: 'zap', sub: t('game2.cheatsHint'), onSelect: function () { U.openExternal(ca.XENO_TOOL_URL); } });
    items.push({ label: t('game.shareToPhone'), icon: 'qr', onSelect: function () { ca.shareGame(g); } });
    items.push('sep');
    items.push({ label: t('game.reportBroken'), icon: 'alert', sub: t('game.reportBrokenSub'), onSelect: function () { ca.reportBroken(g, best); } });
    items.push({ label: t('game2.requestGame'), icon: 'plus', sub: t('game2.requestSub'), onSelect: function () { ca.requestGame(g.title); } });
    ui.menu(anchor, items);
  }

  /* ---------- shared sheet state ---------- */
  function newState(g, release) {
    var d = (S.data.settings && S.data.settings.downloads) || {};
    var deb = (S.data.settings && S.data.settings.debrid) || {};
    return {
      release: release || bestRelease(g), root: S.defaultRoot(), customUrl: '', customName: '', customFormat: '',
      connections: d.connections || 8, verify: d.verifyHashes !== false, autoInstall: d.autoInstallPkg !== false, overwrite: false, space: {},
      via: deb.preferred && deb.preferred !== 'auto' ? deb.preferred : 'auto', services: null, also: { update: false, dlc: false, backport: false }
    };
  }
  function selSize(st) { return st.release && st.release.format !== 'PAGE' ? (st.release.sizeBytes || 0) : 0; }
  function setSize(g, st) { var n = selSize(st); installSet(g, st).forEach(function (it) { if (st.also[it.key] && it.release.sizeBytes) n += it.release.sizeBytes; }); return n; }
  function refreshSpace(g, st, handle) {
    var size = setSize(g, st);
    var roots = S.data.storage || [];
    var pending = roots.length;
    if (!pending) { repaintSaveTo(handle, st); return; }
    roots.forEach(function (r) {
      api.space(r.path, size).then(function (sp) { st.space[r.path] = sp; }, function () { st.space[r.path] = null; }).then(function () { if (--pending === 0) repaintSaveTo(handle, st); });
    });
  }
  function repaintSaveTo(handle, st) {
    if (handle.closed) return;
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
    var extra = installSet(st.game, st).filter(function (it) { return st.also[it.key]; }).length;
    var sizeTxt = setSize(st.game, st) ? U.fmtBytes(setSize(st.game, st)) : t('common.sizeUnknown');
    info.textContent = r ? (st.customUrl ? t('dl.footCustom', { name: st.customName || st.customUrl }) : (extra ? t('game2.footSet', { n: extra + 1, size: sizeTxt, root: st.root ? st.root.label : '—' }) : t('dl.footInfo', { format: ui.fmtLabel(r.format), size: sizeTxt, root: st.root ? st.root.label : '—' }))) : '';
    if (page) { start.innerHTML = U.icon('external') + '<span>' + U.escapeHtml(t('dl.openPage')) + '</span>'; start.classList.remove('primary'); start.classList.add('ghost'); }
    else { start.innerHTML = U.icon('download') + '<span>' + U.escapeHtml(fits ? (extra ? t('game2.startSet', { n: extra + 1 }) : t('dl.start')) : t('dl.noSpace')) + '</span>'; start.classList.add('primary'); start.classList.remove('ghost'); }
    start.toggleAttribute('disabled', !r || (!page && !fits && !!sp));
  }
  /* Install set candidates (§17.13): latest update · DLC (n) · backport for your firmware. */
  function installSet(g, st) {
    var base = st.release; if (!g || !base || relKind(base) === 'page' || st.customUrl) return [];
    var out = [], rs = g.releases || [], fw = ca.fwNum(ca.consoleFw());
    var ups = rs.filter(function (r) { return relKind(r) === 'update' && r !== base && r.format !== 'PAGE'; }).sort(function (a, b) { return ca.semverCmp(b.version || '', a.version || ''); });
    if (ups.length && relKind(base) !== 'update') out.push({ key: 'update', release: ups[0], label: t('game2.alsoUpdate', { v: ups[0].version ? 'v' + ups[0].version : ui.fmtLabel(ups[0].format) }), sub: U.fmtBytes(ups[0].sizeBytes), dflt: true });
    var dlcs = rs.filter(function (r) { return relKind(r) === 'dlc' && r !== base && r.format !== 'PAGE'; });
    if (dlcs.length) out.push({ key: 'dlc', release: dlcs[0], releases: dlcs, label: t('game2.alsoDlc', { n: dlcs.length }), sub: U.fmtBytes(dlcs.reduce(function (n, r) { return n + (r.sizeBytes || 0); }, 0)), dflt: false });
    var need = ca.fwNum(base.requiresFw);
    var bps = rs.filter(function (r) { return relKind(r) === 'backport' && r !== base && r.format !== 'PAGE' && (!fw || !ca.fwNum(r.backportFw) || ca.fwNum(r.backportFw) <= fw); }).sort(function (a, b) { return ca.fwNum(b.backportFw) - ca.fwNum(a.backportFw) || ca.semverCmp(b.version || '', a.version || ''); });
    if (bps.length && relKind(base) !== 'backport') out.push({ key: 'backport', release: bps[0], label: t('game2.alsoBackport', { fw: bps[0].backportFw || bps[0].compat || '' }), sub: t('game2.alsoBackportSub', { fw: ca.consoleFw() || '—', need: base.requiresFw || '—' }), dflt: !!(fw && need && need > fw) });
    return out;
  }
  function installSetBlock(body, g, st, handle) {
    var items = installSet(g, st);
    var box = h('div', { 'data-installset': '' });
    if (!items.length) return box;
    box.appendChild(h('h3', { text: t('game2.alsoDownload') }));
    var list = h('div.list');
    items.forEach(function (it) {
      if (st.also[it.key] === undefined || !st._alsoInit) st.also[it.key] = it.dflt;
      list.appendChild(ui.toggleRow({ id: 'also-' + it.key, icon: it.key === 'update' ? 'refresh' : it.key === 'dlc' ? 'plus' : 'box', label: it.label, desc: it.sub, value: st.also[it.key], onChange: function (v) { st.also[it.key] = v; refreshSpace(g, st, handle); } }));
    });
    st._alsoInit = true;
    box.appendChild(list);
    var d = (S.data.settings && S.data.settings.downloads) || {};
    box.appendChild(h('p.dim.hintline', { text: d.autoInstallSets !== false ? t('game2.alsoHint', { order: (d.installOrder || 'game,backport,update,dlc').split(',').map(function (k) { return t('game2.kind.' + k.trim()); }).join(' → ') }) : t('game2.alsoHintManual') }));
    return box;
  }
  /* "Download using": Direct · Auto · each connected debrid service (§17.14) */
  function viaRow(body, st, handle) {
    var row = ui.valueRow({ id: 'dl-via', icon: 'cloud', label: t('game2.via'), desc: t('game2.viaSub'), value: viaLabel(st), onClick: function () { viaMenu(row, st, handle); } });
    row.setAttribute('data-via', '');
    ca.api.debrid().then(function (services) {
      st.services = services;
      var connected = services.filter(function (s) { return s.connected; });
      if (!connected.length && st.via === 'auto') st.via = 'direct';
      if (st.via !== 'direct' && st.via !== 'auto' && !connected.some(function (s) { return s.id === st.via; })) st.via = connected.length ? 'auto' : 'direct';
      var v = row.querySelector('.val span'); if (v) v.textContent = viaLabel(st);
    });
    return row;
  }
  function viaLabel(st) {
    if (st.via === 'direct') return t('game2.viaDirect');
    if (st.via === 'auto') return t('game2.viaAuto');
    var s = (st.services || []).filter(function (x) { return x.id === st.via; })[0];
    return s ? s.name : st.via;
  }
  function viaMenu(anchor, st, handle) {
    var connected = (st.services || []).filter(function (s) { return s.connected; });
    var items = [{ label: t('game2.viaDirect'), sub: t('game2.viaDirectSub'), icon: 'link', checked: st.via === 'direct', onSelect: function () { st.via = 'direct'; repaintVia(handle, st); } }];
    if (connected.length) items.push({ label: t('game2.viaAuto'), sub: t('game2.viaAutoSub'), icon: 'zap', checked: st.via === 'auto', onSelect: function () { st.via = 'auto'; repaintVia(handle, st); } });
    connected.forEach(function (s) { items.push({ label: s.name, sub: [s.user, s.expires ? t('game2.viaExpires', { date: U.fmtDate(s.expires) }) : ''].filter(Boolean).join(' · '), icon: 'cloud', checked: st.via === s.id, onSelect: function () { st.via = s.id; repaintVia(handle, st); } }); });
    items.push('sep');
    items.push({ label: t('game2.viaConnect'), sub: t('game2.viaConnectSub'), icon: 'settings', onSelect: function () { ui.closeLayer(handle); XS.router.go('settings', { group: 'debrid' }); } });
    ui.menu(anchor, items, { title: t('game2.via') });
  }
  function repaintVia(handle, st) { var v = handle.body.querySelector('[data-via] .val span'); if (v) v.textContent = viaLabel(st); }

  /* ---------- Download best (§17.5): GET /api/game/best → reasons sheet ---------- */
  function openBest(g) {
    var st = newState(g); st.game = g;
    var handle = ui.sheet({
      title: t('game2.bestTitle'), sub: g.title, key: 'best:' + g.id,
      body: function (body) { body.appendChild(ca.busyRow(t('game2.bestPicking'))); },
      foot: [
        h('button.btn.ghost', { nav: 'best-other', html: U.icon('sliders') + '<span>' + U.escapeHtml(t('game2.otherVersions')) + '</span>', on: { click: function () { ui.closeNow(handle); openOptions(g, st.release); } } }),
        h('span.dim', { 'data-foot-info': '', text: '' }),
        h('span.spacer'),
        h('button.btn.primary.lg', { nav: 'dl-start', 'data-start': '', html: U.icon('download') + '<span>' + U.escapeHtml(t('dl.start')) + '</span>', on: { click: function () { startDownload(g, st, handle); } } })
      ]
    });
    var local = { release: bestRelease(g), reasons: localReasons(g, bestRelease(g)), fromApi: false };
    ca.api.best(g.id).then(function (r) {
      var rel = null;
      if (r.release && r.release.id) rel = (g.releases || []).filter(function (x) { return x.id === r.release.id; })[0] || r.release;
      else if (r.releaseId) rel = (g.releases || []).filter(function (x) { return x.id === r.releaseId; })[0];
      var reasons = (r.reasons || []).map(function (x) { if (typeof x === 'string') return XS.i18n.has('game2.reason.' + x) ? t('game2.reason.' + x, r.vars || {}) : x; if (x && x.code && XS.i18n.has('game2.reason.' + x.code)) return t('game2.reason.' + x.code, x.vars || x); return (x && (x.text || x.message)) || ''; }).filter(Boolean);
      if (rel && rel.format !== 'PAGE') paintBest(handle, g, st, { release: rel, reasons: reasons.length ? reasons : localReasons(g, rel), fromApi: true });
      else paintBest(handle, g, st, local);
    }, function () { paintBest(handle, g, st, local); });
  }
  function paintBest(handle, g, st, pick) {
    if (handle.closed) return;
    var body = handle.body; U.clear(body);
    var r = pick.release;
    st.release = r;
    if (!r) { body.appendChild(ui.emptyState(t('game.noSources'), '')); return; }
    var hero = h('div.cover-hero');
    hero.appendChild(ui.cover(g.cover, g.coverFallback, g.title));
    hero.appendChild(h('div.grow', [h('h4', { text: g.title }), h('div.meta', [ui.platChip(g.platform, true), ' ', h('span', { text: ui.sizeRange(g) })])]));
    body.appendChild(hero);
    var card = h('div.best-card');
    card.appendChild(h('div.kicker', { text: pick.fromApi ? t('game2.bestPicked') : t('game2.bestLocal') }));
    var l1 = h('div.l1', [ca.kindChip(relKind(r)), h('span.chip.fmt', { text: ui.fmtLabel(r.format) }), h('span.name', { text: r.provider || r.sourceId }), r.version ? h('span.chip.sm', { text: 'v' + r.version }) : null, r.region ? h('span.chip.sm', { text: r.region }) : null, (r.verifiedAt || r.consoleVerified) ? ui.tick(r.consoleVerified ? t('dl.consoleVerified') : t('common.verified')) : null, (r.compat || r.requiresFw) ? h('span.chip.sm.acc', { text: t('game.fw', { fw: r.compat || r.requiresFw }) }) : null]);
    card.appendChild(l1);
    card.appendChild(h('div.l2', [h('b.size', { text: r.sizeBytes ? U.fmtBytes(r.sizeBytes) : t('common.sizeUnknown') }), r.filename ? h('span.ellipsis.dim', { text: r.filename }) : null]));
    var why = h('ul.reasons');
    pick.reasons.forEach(function (x) { why.appendChild(h('li', { html: U.icon('check') + '<span>' + U.escapeHtml(x) + '</span>' })); });
    card.appendChild(h('h3', { text: t('game2.whyThis') }));
    card.appendChild(why);
    body.appendChild(card);
    body.appendChild(installSetBlock(body, g, st, handle));
    body.appendChild(h('h3', { text: t('game2.via') }));
    body.appendChild(viaRow(body, st, handle));
    body.appendChild(h('h3', { text: t('dl.saveTo') }));
    body.appendChild(saveToList(handle, st));
    var fmt = r.format;
    if (fmt === 'PKG' || fmt === 'FPKG') body.appendChild(ui.toggleRow({ id: 'dl-autoinstall', icon: 'box', label: t('dl.autoInstall'), desc: t('dl.autoInstallHint'), value: st.autoInstall, onChange: function (v) { st.autoInstall = v; } }));
    updateFoot(handle, st);
    api.storage().then(function (res) { S.set('storage', res.roots || []); if (!st.root) st.root = S.defaultRoot(); refreshSpace(g, st, handle); }, function () { refreshSpace(g, st, handle); });
    requestAnimationFrame(function () { if (!handle.closed) { var s = handle.foot.querySelector('[data-start]'); if (s) XS.nav.focus(s, false); } });
  }

  /* ---------- Download options sheet ---------- */
  function openOptions(g, preselect) {
    var st = newState(g, preselect); st.game = g;
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
  function paintOptions(body, handle, g, st) {
    U.clear(body);
    var hero = h('div.cover-hero');
    hero.appendChild(ui.cover(g.cover, g.coverFallback, g.title));
    hero.appendChild(h('div.grow', [h('h4', { text: g.title }), h('div.meta', [ui.platChip(g.platform, true), ' ', h('span', { text: ui.sizeRange(g) })])]));
    body.appendChild(hero);

    /* Release table grouped Game · Backports · Updates · DLC · Pages */
    var groups = {};
    (g.releases || []).forEach(function (r) { var k = relKind(r); (groups[k] = groups[k] || []).push(r); });
    var best = bestRelease(g);
    KIND_ORDER.forEach(function (k) {
      var rs = groups[k]; if (!rs || !rs.length) return;
      if (k === 'update' || k === 'backport') rs = rs.slice().sort(function (a, b) { return ca.semverCmp(b.version || '', a.version || ''); });
      body.appendChild(h('h3', [t('game2.group.' + k), h('span.count', { text: '· ' + rs.length })]));
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
        left.appendChild(ca.kindChip(k));
        left.appendChild(h('span.chip.fmt.sm', { text: ui.fmtLabel(r.format) }));
        left.appendChild(h('span.name', { text: r.provider || (source(r.sourceId) || {}).name || r.sourceId }));
        if (r.version) left.appendChild(h('span.chip.sm', { text: 'v' + r.version }));
        if (r.region) left.appendChild(h('span.chip.sm', { text: r.region }));
        if (r.verifiedAt || r.consoleVerified) left.appendChild(ui.tick(r.consoleVerified ? t('dl.consoleVerified') : t('common.verified')));
        if (k === 'backport' && (r.backportFw || r.compat)) left.appendChild(h('span.chip.sm.warn', { text: t('game2.forFw', { fw: r.backportFw || r.compat }) }));
        else if (r.compat || r.requiresFw) left.appendChild(h('span.chip.sm' + (fwOk(r) ? '.acc' : '.bad'), { text: t('game.fw', { fw: r.compat || r.requiresFw }) }));
        if (r === best) left.appendChild(h('span.chip.sm.gold', { text: t('dl.recommended') }));
        if (r.health === 'flaky') left.appendChild(h('span.chip.sm.warn', { text: t('game2.flaky') }));
        l1.appendChild(left);
        l1.appendChild(h('span.size', { text: r.format === 'PAGE' ? '' : (r.sizeBytes ? U.fmtBytes(r.sizeBytes) : t('common.sizeUnknown')) }));
        var l2 = h('div.l2');
        if (r.filename) l2.appendChild(h('span.ellipsis', { text: r.filename, style: { maxWidth: '360px' } }));
        if (r.mirrors && r.mirrors.length) l2.appendChild(h('span', { text: t('dl.mirrors', { n: r.mirrors.length }) }));
        if (r.sha256 || r.md5 || r.sha1) l2.appendChild(h('span', { text: t('dl.hashKnown') }));
        if (r.notes) l2.appendChild(h('span', { text: r.notes }));
        if (/^(ZIP|RAR|7Z)$/i.test(r.format || '')) l2.appendChild(h('span.warn', { text: t('game2.archiveNote') }));
        if (!S.sourceEnabled(r.sourceId)) l2.appendChild(h('span.warn', { text: t('dl.sourceDisabled') }));
        l1.appendChild(l2);
        main.appendChild(l1);
        row.appendChild(main);
        row.appendChild(h('span.check', { html: sel ? U.icon('check') : '' }));
        row.addEventListener('click', function () {
          st.release = r; st.customUrl = ''; st.customName = ''; st.customFormat = ''; st._alsoInit = false;
          U.$$('.lrow', body).forEach(function (x) { x.classList.remove('sel'); var c = x.querySelector(':scope > .check'); if (c) c.innerHTML = ''; });
          row.classList.add('sel'); row.querySelector(':scope > .check').innerHTML = U.icon('check');
          repaintSourceTools(body, handle, g, st);
          var isb = body.querySelector('[data-installset]'); if (isb) isb.parentNode.replaceChild(installSetBlock(body, g, st, handle), isb);
          refreshSpace(g, st, handle);
        });
        list.appendChild(row);
      });
      body.appendChild(list);
    });

    body.appendChild(h('div', { 'data-sourcetools': '' }));
    repaintSourceTools(body, handle, g, st);
    body.appendChild(installSetBlock(body, g, st, handle));

    body.appendChild(h('h3', { text: t('game2.via') }));
    body.appendChild(viaRow(body, st, handle));

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
      box.appendChild(ui.valueRow({ id: 'src-phone', icon: 'qr', label: t('game2.openOnPhone'), desc: t('game2.openOnPhoneSub'), onClick: function () { ca.linkDialog({ title: t('game2.openOnPhone'), hint: t('game2.openOnPhoneHint'), url: pageUrl }); } }));
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
      var isb = body.querySelector('[data-installset]'); if (isb) isb.parentNode.replaceChild(installSetBlock(body, g, st, handle), isb);
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
    out.appendChild(ca.busyRow(t('dl.testing', { n: urls.length })));
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

  /* ---------- start: single job (POST /api/queue) or install set (POST /api/queue/set) ---------- */
  function startDownload(g, st, handle) {
    var r = st.release; if (!r) return;
    var page = (r.format === 'PAGE' || isBrowser(r)) && !st.customUrl;
    if (page) { U.openExternal(r.browserUrl || r.url); return; }
    if (!st.root) { ui.toast({ cls: 'bad', title: t('err.root_unavailable') }); return; }
    var body = { gameId: g.id, releaseId: r.id, root: st.root.path, connections: st.connections, verify: st.verify ? (r.sha256 ? 'sha256' : 'size') : 'none', autoInstall: st.autoInstall, via: st.via || 'direct' };
    if (st.customUrl) { body.url = st.customUrl; body.filename = st.customName; body.format = st.customFormat || r.format; }
    if (st.overwrite) body.overwrite = true;
    var extras = installSet(g, st).filter(function (it) { return st.also[it.key]; });
    var start = handle.foot.querySelector('[data-start]');
    start.classList.add('busy');
    var p;
    if (extras.length) {
      var items = [{ releaseId: r.id, kind: relKind(r) }];
      extras.forEach(function (it) { (it.releases || [it.release]).forEach(function (x) { items.push({ releaseId: x.id, kind: it.key }); }); });
      var setBody = { gameId: g.id, root: st.root.path, connections: st.connections, verify: st.verify ? 'auto' : 'none', autoInstall: st.autoInstall, via: st.via || 'direct', base: r.id, items: items, also: { update: !!st.also.update, dlc: !!st.also.dlc, backport: !!st.also.backport }, overwrite: !!st.overwrite };
      p = ca.api.queueSet(setBody).then(function (res) { return { jobs: res.jobs || (res.job ? [res.job] : []), group: res.group || '' }; }, function (err) {
        if (err.status !== 404) throw err;
        /* older payload without /api/queue/set: queue each release in order */
        var seq = Promise.resolve([]);
        items.forEach(function (it) { seq = seq.then(function (acc) { var b = {}; for (var k in body) b[k] = body[k]; b.releaseId = it.releaseId; delete b.url; delete b.filename; delete b.format; return api.queueAdd(b).then(function (res) { acc.push(res.job); return acc; }, function (e2) { if (e2.error === 'already_queued' || e2.error === 'queued') return acc; throw e2; }); }); });
        return seq.then(function (jobs) { return { jobs: jobs, group: '' }; });
      });
    } else p = api.queueAdd(body).then(function (res) { return { jobs: [res.job || {}], group: '' }; });
    p.then(function (res) {
      start.classList.remove('busy');
      XS.actions.refreshQueue();
      queuedView(handle, g, res.jobs, st);
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
  function queuedView(handle, g, jobs, st) {
    XS.sound.select();
    var job = jobs[0] || {};
    var body = handle.body; U.clear(body);
    body.appendChild(h('div.wiz-hero', [h('span.ic.okring', { html: U.icon('check').replace('<svg ', '<svg style="width:30px;height:30px;fill:none;stroke:currentColor;stroke-width:2.5" ') }), h('div', [h('h2', { text: jobs.length > 1 ? t('game2.setQueued', { n: jobs.length }) : t('dl.queuedTitle') }), h('p', { text: jobs.length > 1 ? t('game2.setQueuedText', { title: g.title }) : t('dl.queuedText', { title: g.title }) })])]));
    var kv = h('dl.kv');
    function add(k, v) { kv.appendChild(h('dt', { text: k })); kv.appendChild(h('dd', { text: v })); }
    if (jobs.length > 1) jobs.forEach(function (j, i) { add((i + 1) + '. ' + t('game2.kind.' + (j.kind || (i === 0 ? relKind(st.release) : 'update'))), (j.filename || '') + (j.total ? ' · ' + U.fmtBytes(j.total) : '')); });
    else {
      add(t('dl.file'), job.filename || st.customName || (st.release && st.release.filename) || '');
      add(t('dl.format'), ui.fmtLabel(job.format || st.customFormat || (st.release && st.release.format)));
      add(t('dl.size'), job.total ? U.fmtBytes(job.total) : (selSize(st) ? U.fmtBytes(selSize(st)) : t('common.sizeUnknown')));
    }
    add(t('dl.destination'), job.path || (st.root ? st.root.label : ''));
    add(t('dl.connections'), String(job.connections || st.connections));
    if (st.via && st.via !== 'direct') add(t('game2.via'), job.via || viaLabel(st));
    body.appendChild(h('div.panel', [kv]));
    U.clear(handle.foot);
    handle.foot.appendChild(h('button.btn.lg', { nav: 'q-done', text: t('common.done'), on: { click: function () { ui.closeLayer(handle); } } }));
    handle.foot.appendChild(h('span.spacer'));
    var view = h('button.btn.primary.lg', { nav: 'q-view', 'data-autofocus': '', html: U.icon('download') + '<span>' + U.escapeHtml(t('game.viewDownloads')) + '</span>' });
    view.addEventListener('click', function () { XS.router.go('downloads'); });
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
  var lastKey = '';
  S.on('queue', function () { if (root && root.classList.contains('active') && current) {
    var job = S.activeJobFor(current.id);
    var key = job ? job.id + ':' + job.state + ':' + Math.floor(U.pct(job.written, job.total)) + ':' + (job.speed || 0) : 'none';
    if (key !== lastKey) { lastKey = key; paintStatus(); }
  } });
  S.on('favorites', function () { if (root) { var b = root.querySelector('.btn.fav[data-game]'); if (b) b.classList.toggle('on', S.isFav(b.getAttribute('data-game'))); U.$$('.card[data-game]', root).forEach(function (c) { c.classList.toggle('fav', S.isFav(c.getAttribute('data-game'))); }); } });
  S.on('catalog', function () { if (root && root.classList.contains('active') && XS.router.current().id === 'game') render(XS.router.current().params); });
  XS.gamePage = { openOptions: openOptions, openBest: openBest, bestRelease: bestRelease, installSet: installSet };
})();
