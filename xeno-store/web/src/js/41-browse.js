/* XENO STORE — 41-browse.js: search field, filter chips → side sheet, sort, active filters, virtualized grid. */
(function () {
  'use strict';
  var XS = window.XS, U = XS.util, S = XS.state, ui = XS.ui, h = U.h, t = XS.t;
  var root = null, gridEl = null, countEl = null, activeEl = null, searchBox = null;
  var GB = 1e9;
  var SIZES = [{ id: 'le5', max: 5 }, { id: 'le20', max: 20 }, { id: 'le50', max: 50 }, { id: 'le100', max: 100 }, { id: 'gt100', min: 100 }];
  var SORTS = ['newest', 'added', 'az', 'smallest', 'largest', 'popular'];
  var REGIONS = ['EUR', 'USA', 'JPN', 'ASIA'];
  var FORMATS = ['FFPFSC', 'exFAT', 'PKG', 'FPKG', 'FFPKG', 'ZIP', 'RAR', '7z', 'PAGE'];
  var f = defaults();
  function defaults() { return { q: '', platform: 'all', source: [], format: [], region: [], genre: [], size: '', verified: false, updates: false, favorites: false, sort: 'newest' }; }

  function apply(params) {
    if (!params) return;
    var nf = defaults();
    if (params.genre) nf.genre = [params.genre];
    if (params.platform) nf.platform = params.platform;
    if (params.sort) nf.sort = params.sort;
    if (params.q !== undefined) nf.q = params.q;
    if (params.size) nf.size = params.size;
    if (params.verified) nf.verified = true;
    if (params.source) nf.source = [params.source];
    if (params.favorites) nf.favorites = true;
    if (params.updates) nf.updates = true;
    f = nf;
  }

  function results() {
    var q = f.q.trim().toLowerCase(), games = S.data.games, out = [];
    var showPs4 = !S.data.settings || !S.data.settings.general || S.data.settings.general.showPs4 !== false;
    var sz = null; SIZES.forEach(function (s) { if (s.id === f.size) sz = s; });
    for (var i = 0; i < games.length; i++) {
      var g = games[i];
      if (f.platform !== 'all' && g.platform !== f.platform) continue;
      if (!showPs4 && g.platform === 'PS4' && f.platform !== 'PS4') continue;
      if (q && g._search.indexOf(q) < 0) continue;
      if (f.favorites && !S.isFav(g.id)) continue;
      if (f.verified && !g.verified) continue;
      if (f.updates && !(g._kinds.update || g._kinds.dlc)) continue;
      if (f.genre.length && !overlap(g.genres || [], f.genre)) continue;
      if (f.region.length && !(f.region.indexOf(g.region) >= 0 || overlap((g.releases || []).map(function (r) { return r.region; }), f.region))) continue;
      if (f.source.length && !overlap((g.releases || []).map(function (r) { return r.sourceId; }), f.source)) continue;
      if (f.format.length && !overlap((g.releases || []).map(function (r) { return r.format; }), f.format)) continue;
      if (sz) {
        if (!g.sizeMax) continue;
        if (sz.max && g.sizeMax > sz.max * GB) continue;
        if (sz.min && g.sizeMax <= sz.min * GB) continue;
      }
      out.push(g);
    }
    out.sort(sorter(f.sort));
    return out;
  }
  function overlap(a, b) { for (var i = 0; i < a.length; i++) if (b.indexOf(a[i]) >= 0) return true; return false; }
  function sorter(s) {
    switch (s) {
      case 'added': return function (a, b) { return cmp(b.addedAt || '', a.addedAt || '') || cmp(a._nt, b._nt); };
      case 'az': return function (a, b) { return cmp(a._nt, b._nt); };
      case 'smallest': return function (a, b) { return (a.sizeMax || Infinity) - (b.sizeMax || Infinity) || cmp(a._nt, b._nt); };
      case 'largest': return function (a, b) { return (b.sizeMax || 0) - (a.sizeMax || 0) || cmp(a._nt, b._nt); };
      case 'popular': return function (a, b) { return (b.popularity || 0) - (a.popularity || 0) || cmp(a._nt, b._nt); };
      default: return function (a, b) { return cmp(b.releaseDate || '', a.releaseDate || '') || cmp(b.addedAt || '', a.addedAt || '') || cmp(a._nt, b._nt); };
    }
  }
  function cmp(a, b) { return a < b ? -1 : a > b ? 1 : 0; }

  function chipBtn(id, label, on, onClick) {
    var c = h('button.chip' + (on ? '.on' : ''), { nav: 'flt-' + id, data: { hints: 'select' } }, [h('span', { text: label }), ui.svg('chevD')]);
    c.addEventListener('click', onClick);
    return c;
  }
  function filterBar() {
    var bar = h('div.browse-filters', { data: { navRegion: '' } });
    var src = S.data.sources;
    bar.appendChild(chipBtn('platform', f.platform === 'all' ? t('filter.platform') : f.platform, f.platform !== 'all', function (e) {
      pickOne(e.currentTarget, t('filter.platform'), [{ id: 'all', label: t('filter.all') }, { id: 'PS5', label: 'PS5' }, { id: 'PS4', label: 'PS4' }], f.platform, function (v) { f.platform = v; });
    }));
    bar.appendChild(chipBtn('source', f.source.length ? t('filter.sourceN', { n: f.source.length }) : t('filter.source'), f.source.length > 0, function () {
      pickMany(t('filter.source'), src.map(function (s) { return { id: s.id, label: s.name, sub: t('source.kind.' + (s.kind || 'direct')) }; }), f.source, function (v) { f.source = v; });
    }));
    bar.appendChild(chipBtn('format', f.format.length ? f.format.map(ui.fmtLabel).join(', ') : t('filter.format'), f.format.length > 0, function () {
      pickMany(t('filter.format'), FORMATS.map(function (x) { return { id: x, label: ui.fmtLabel(x) }; }), f.format, function (v) { f.format = v; });
    }));
    bar.appendChild(chipBtn('region', f.region.length ? f.region.join(', ') : t('filter.region'), f.region.length > 0, function () {
      pickMany(t('filter.region'), REGIONS.map(function (x) { return { id: x, label: x }; }), f.region, function (v) { f.region = v; });
    }));
    bar.appendChild(chipBtn('genre', f.genre.length ? (f.genre.length === 1 ? f.genre[0] : t('filter.genreN', { n: f.genre.length })) : t('filter.genre'), f.genre.length > 0, function () {
      pickMany(t('filter.genre'), S.data.genres.map(function (gn) { return { id: gn.name, label: gn.name, sub: t('common.nGames', { n: gn.count }) }; }), f.genre, function (v) { f.genre = v; });
    }));
    bar.appendChild(chipBtn('size', f.size ? t('filter.size.' + f.size) : t('filter.size.label'), !!f.size, function (e) {
      pickOne(e.currentTarget, t('filter.size.label'), [{ id: '', label: t('filter.any') }].concat(SIZES.map(function (s) { return { id: s.id, label: t('filter.size.' + s.id) }; })), f.size, function (v) { f.size = v; });
    }));
    var ver = h('button.chip' + (f.verified ? '.on' : ''), { nav: 'flt-verified' }, [ui.svg('check'), h('span', { text: t('filter.verifiedOnly') })]);
    ver.addEventListener('click', function () { f.verified = !f.verified; rerender('flt-verified'); });
    bar.appendChild(ver);
    var upd = h('button.chip' + (f.updates ? '.on' : ''), { nav: 'flt-updates' }, [h('span', { text: t('filter.hasUpdates') })]);
    upd.addEventListener('click', function () { f.updates = !f.updates; rerender('flt-updates'); });
    bar.appendChild(upd);
    var sort = h('button.chip.acc', { nav: 'flt-sort' }, [ui.svg('sort'), h('span', { text: t('sort.' + f.sort) })]);
    sort.addEventListener('click', function () {
      ui.menu(sort, SORTS.map(function (s) { return { label: t('sort.' + s), checked: f.sort === s, onSelect: function () { f.sort = s; rerender('flt-sort'); } }; }), { title: t('browse.sortBy') });
    });
    bar.appendChild(sort);
    return bar;
  }
  function pickOne(anchor, title, options, value, set) {
    ui.menu(anchor, options.map(function (o) { return { label: o.label, checked: o.id === value, onSelect: function () { set(o.id); rerender(); } }; }), { title: title });
  }
  /* Multi-select side sheet with a check per option; applied live so the count updates behind the sheet. */
  function pickMany(title, options, selected, set) {
    var cur = selected.slice();
    ui.sheet({
      title: title, key: 'filter-' + title, sub: t('browse.filterHint'),
      body: function (body) {
        var list = h('div.filter-opts');
        options.forEach(function (o, i) {
          var row = h('button.lrow' + (cur.indexOf(o.id) >= 0 ? '.sel' : ''), { nav: 'opt-' + i, data: { hints: 'toggle' } });
          row.appendChild(h('div.main', [h('div.name', { text: o.label }), o.sub ? h('div.desc', { text: o.sub }) : null]));
          row.appendChild(h('span.check', { html: cur.indexOf(o.id) >= 0 ? U.icon('check') : '' }));
          row.addEventListener('click', function () {
            var k = cur.indexOf(o.id);
            if (k >= 0) cur.splice(k, 1); else cur.push(o.id);
            row.classList.toggle('sel', k < 0);
            row.querySelector('.check').innerHTML = k < 0 ? U.icon('check') : '';
            set(cur.slice()); rerender();
          });
          list.appendChild(row);
        });
        body.appendChild(list);
      },
      foot: [
        h('button.btn.ghost', { nav: 'opt-clear', text: t('filter.clear'), on: { click: function () { cur = []; set([]); rerender(); U.$$('.lrow', XS.ui.topLayer().el).forEach(function (r) { r.classList.remove('sel'); r.querySelector('.check').innerHTML = ''; }); } } }),
        h('span.spacer'),
        h('button.btn.primary', { nav: 'opt-done', text: t('common.done'), on: { click: function () { ui.closeTop(); } } })
      ]
    });
  }
  function activeChips() {
    var wrap = h('div.browse-active', { data: { navRegion: '' } });
    var items = [];
    if (f.q) items.push({ label: '“' + f.q + '”', clear: function () { f.q = ''; if (searchBox) searchBox.input.value = ''; } });
    if (f.platform !== 'all') items.push({ label: f.platform, clear: function () { f.platform = 'all'; } });
    f.source.forEach(function (s) { items.push({ label: sourceName(s), clear: function () { f.source = f.source.filter(function (x) { return x !== s; }); } }); });
    f.format.forEach(function (s) { items.push({ label: ui.fmtLabel(s), clear: function () { f.format = f.format.filter(function (x) { return x !== s; }); } }); });
    f.region.forEach(function (s) { items.push({ label: s, clear: function () { f.region = f.region.filter(function (x) { return x !== s; }); } }); });
    f.genre.forEach(function (s) { items.push({ label: s, clear: function () { f.genre = f.genre.filter(function (x) { return x !== s; }); } }); });
    if (f.size) items.push({ label: t('filter.size.' + f.size), clear: function () { f.size = ''; } });
    if (f.verified) items.push({ label: t('filter.verifiedOnly'), clear: function () { f.verified = false; } });
    if (f.updates) items.push({ label: t('filter.hasUpdates'), clear: function () { f.updates = false; } });
    if (f.favorites) items.push({ label: t('discover.yourFavorites'), clear: function () { f.favorites = false; } });
    if (!items.length) return null;
    items.forEach(function (it, i) {
      var c = h('button.chip.gold', { nav: 'act-' + i, data: { hints: 'remove' } }, [h('span', { text: it.label }), h('span.x', { text: '✕' })]);
      c.addEventListener('click', function () { it.clear(); rerender(); });
      wrap.appendChild(c);
    });
    var reset = h('button.chip', { nav: 'act-reset', text: t('browse.resetFilters') });
    reset.addEventListener('click', function () { f = defaults(); if (searchBox) searchBox.input.value = ''; rerender('flt-platform'); });
    wrap.appendChild(reset);
    return wrap;
  }
  function sourceName(id) { for (var i = 0; i < S.data.sources.length; i++) if (S.data.sources[i].id === id) return S.data.sources[i].name; return id; }

  var liveUpdate = U.debounce(function () { renderResults(); }, 120);
  function render() {
    if (!root) return;
    U.clear(root);
    var inner = h('div.screen-inner');
    root.appendChild(inner);
    var bar = h('div.browse-bar');
    searchBox = ui.searchBox({ id: 'browse-search', placeholder: t('browse.searchPlaceholder'), value: f.q, onInput: function (v) { f.q = v; liveUpdate(); }, onEnter: function () { var c = root.querySelector('.card'); if (c) XS.nav.focus(c); } });
    bar.appendChild(searchBox);
    inner.appendChild(bar);
    inner.appendChild(filterBar());
    activeEl = h('div');
    var ac = activeChips(); if (ac) activeEl.appendChild(ac);
    inner.appendChild(activeEl);
    var meta = h('div.browse-meta');
    countEl = h('span'); meta.appendChild(countEl);
    inner.appendChild(meta);
    gridEl = h('div', { data: { navRegion: '' } });
    inner.appendChild(gridEl);
    renderResults();
  }
  function renderResults() {
    if (!gridEl) return;
    var res = results();
    countEl.textContent = t('browse.results', { n: res.length });
    U.clear(gridEl);
    if (!S.data.catalog) { gridEl.appendChild(ui.skeletonRail(8)); return; }
    if (!res.length) {
      gridEl.appendChild(ui.emptyState(f.q ? t('browse.emptyQueryTitle', { q: f.q }) : t('browse.emptyTitle'), t('browse.emptyHint'), [
        h('button.btn', { nav: 'empty-reset', text: t('browse.resetFilters'), on: { click: function () { f = defaults(); render(); } } })
      ]));
      return;
    }
    ui.vgrid(gridEl, res, root, function (g) { return ui.card(g); });
  }
  function rerender(focusId) {
    var fid = focusId || (document.activeElement && document.activeElement.getAttribute('data-nav-id'));
    var inSheet = !!XS.ui.layers.length;
    var scroll = root.scrollTop;
    render();
    root.scrollTop = scroll;
    if (!inSheet && fid) { var el = root.querySelector('[data-nav-id="' + fid + '"]'); if (el) XS.nav.focus(el, false); }
  }

  XS.router.register('browse', {
    tab: true, icon: 'grid', label: function () { return t('nav.browse'); },
    mount: function (el) { root = el; },
    show: function (params) { if (params && Object.keys(params).length) { apply(params); render(); } else if (!root.firstChild || !S.data.catalog) render(); },
    refresh: render,
    setQuery: function (q) { f.q = q; render(); }
  });
  S.on('catalog', function () { if (root && root.classList.contains('active')) render(); else if (root) U.clear(root); });
  S.on('favorites', function () { if (root) U.$$('.card[data-game]', root).forEach(function (c) { c.classList.toggle('fav', S.isFav(c.getAttribute('data-game'))); }); });
})();
