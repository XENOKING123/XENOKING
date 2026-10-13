/* XENO STORE — 41-browse.js: faceted Browse (§17.4): facets with live counts (AND across, OR inside), quick chips,
   presets in settings.browse.presets, 8 sorts, fuzzy search with "Did you mean", recent searches, ≤150 mounted cards
   with Load-more-on-focus + pager. */
(function () {
  'use strict';
  var XS = window.XS, U = XS.util, S = XS.state, ui = XS.ui, ca = XS.ca, h = U.h, t = XS.t;
  var root = null, gridHost = null, metaEl = null, activeEl = null, searchBox = null, suggestEl = null, barEl = null, quickEl = null;
  var PAGE = 96, MAX_MOUNTED = 150;
  var SORTS = ['newest', 'added', 'az', 'smallest', 'largest', 'popular', 'metacritic', 'mostUpdates'];
  var YEARS = ['2026', '2025', '2024', '2023', '2022', '2021', '2020', '2015-2019', 'older'];
  var BOOL = ['verified', 'updates', 'dlc', 'backports', 'direct', 'newWeek', 'cheats'];
  var QUICK = [
    { id: 'ps5', facet: 'platform', value: 'PS5' }, { id: 'ps4', facet: 'platform', value: 'PS4' }, { id: 'le20', facet: 'size', value: 'le20' },
    { id: 'verified', facet: 'verified', value: 'yes' }, { id: 'newWeek', facet: 'newWeek', value: 'yes' }, { id: 'updates', facet: 'updates', value: 'yes' },
    { id: 'direct', facet: 'direct', value: 'yes' }, { id: 'backports', facet: 'backports', value: 'yes' }
  ];
  /* Facets: id → how a game's values are read. Boolean facets carry the single value "yes". */
  var FACETS = [
    { id: 'platform', get: function (fv) { return [fv.platform]; }, fixed: ['PS5', 'PS4'] },
    { id: 'source', get: function (fv) { return fv.sources; } },
    { id: 'format', get: function (fv) { return fv.formats; } },
    { id: 'region', get: function (fv) { return fv.regions; } },
    { id: 'genre', get: function (fv) { return fv.genres; } },
    { id: 'year', get: function (fv) { return fv.year ? [fv.year] : []; }, fixed: YEARS },
    { id: 'size', get: function (fv, g) { var out = []; ca.SIZE_BUCKETS.forEach(function (b) { if (ca.sizeMatches(g, b.id)) out.push(b.id); }); return out; }, fixed: ['le5', 'le20', 'le50', 'le100', 'gt100'] },
    { id: 'publisher', get: function (fv) { return fv.publisher ? [fv.publisher] : []; }, top: 30 },
    { id: 'compat', get: function (fv) { return fv.compat; } },
    { id: 'features', get: function (fv) { return fv.features; } },
    { id: 'verified', get: function (fv) { return fv.verified ? ['yes'] : []; }, bool: true },
    { id: 'updates', get: function (fv) { return fv.updates ? ['yes'] : []; }, bool: true },
    { id: 'dlc', get: function (fv) { return fv.dlc ? ['yes'] : []; }, bool: true },
    { id: 'backports', get: function (fv) { return fv.backports ? ['yes'] : []; }, bool: true },
    { id: 'direct', get: function (fv) { return fv.direct ? ['yes'] : []; }, bool: true },
    { id: 'newWeek', get: function (fv) { return fv.newWeek ? ['yes'] : []; }, bool: true },
    { id: 'cheats', get: function (fv) { return fv.cheats ? ['yes'] : []; }, bool: true }
  ];
  var f = defaults();
  var pageStart = 0, pageCount = 1, lastRes = [], lastCounts = {}, sheetHandle = null, gridApi = null;

  function defaults() { var sel = {}; FACETS.forEach(function (fc) { sel[fc.id] = []; }); return { q: '', sel: sel, favorites: false, sort: 'newest', sortExplicit: false }; }
  function facet(id) { for (var i = 0; i < FACETS.length; i++) if (FACETS[i].id === id) return FACETS[i]; return null; }
  function selectedCount() { var n = 0; FACETS.forEach(function (fc) { n += f.sel[fc.id].length; }); return n + (f.favorites ? 1 : 0); }
  function apply(params) {
    if (!params) return;
    var nf = defaults();
    if (params.genre) nf.sel.genre = [params.genre];
    if (params.platform) nf.sel.platform = [params.platform];
    if (params.sort) { nf.sort = params.sort; nf.sortExplicit = true; }
    if (params.q !== undefined) nf.q = params.q;
    if (params.size) nf.sel.size = [params.size];
    if (params.verified) nf.sel.verified = ['yes'];
    if (params.source) nf.sel.source = [params.source];
    if (params.favorites) nf.favorites = true;
    if (params.updates) nf.sel.updates = ['yes'];
    if (params.backports) nf.sel.backports = ['yes'];
    if (params.format) nf.sel.format = [params.format];
    if (params.compat) nf.sel.compat = [params.compat];
    if (params.direct) nf.sel.direct = ['yes'];
    if (params.newWeek) nf.sel.newWeek = ['yes'];
    if (params.cheats) nf.sel.cheats = ['yes'];
    if (params.publisher) nf.sel.publisher = [params.publisher];
    f = nf; pageStart = 0; pageCount = 1;
  }

  /* ---------- results + facet counts in one pass ---------- */
  function pool() {
    var showPs4 = !S.data.settings || !S.data.settings.general || S.data.settings.general.showPs4 !== false;
    var q = f.q.trim();
    var list;
    if (q) list = ca.search(q, 0).map(function (x) { return x.g; });
    else list = S.data.games.filter(ca.isGame);
    if (!showPs4 && f.sel.platform.indexOf('PS4') < 0) list = list.filter(function (g) { return g.platform !== 'PS4'; });
    if (f.favorites) list = list.filter(function (g) { return S.isFav(g.id); });
    return list;
  }
  function compute() {
    var list = pool(), res = [], counts = {};
    FACETS.forEach(function (fc) { counts[fc.id] = {}; });
    var active = FACETS.filter(function (fc) { return f.sel[fc.id].length; });
    for (var i = 0; i < list.length; i++) {
      var g = list[i], fv = ca.facetValues(g), vals = {}, fails = [], k;
      for (k = 0; k < FACETS.length; k++) vals[FACETS[k].id] = FACETS[k].get(fv, g);
      for (k = 0; k < active.length; k++) {
        var fc = active[k], sel = f.sel[fc.id], v = vals[fc.id], hit = false;
        for (var s = 0; s < sel.length && !hit; s++) if (v.indexOf(sel[s]) >= 0) hit = true;
        if (!hit) { fails.push(fc.id); if (fails.length > 1) break; }
      }
      if (!fails.length) {
        res.push(g);
        for (k = 0; k < FACETS.length; k++) bump(counts[FACETS[k].id], vals[FACETS[k].id]);
      } else if (fails.length === 1) bump(counts[fails[0]], vals[fails[0]]);
    }
    var q = f.q.trim();
    if (!(q && !f.sortExplicit)) res.sort(sorter(f.sort));
    lastRes = res; lastCounts = counts;
    return res;
  }
  function bump(m, vals) { for (var i = 0; i < vals.length; i++) m[vals[i]] = (m[vals[i]] || 0) + 1; }
  function cmp(a, b) { return a < b ? -1 : a > b ? 1 : 0; }
  function sorter(s) {
    switch (s) {
      case 'added': return function (a, b) { return cmp(b.addedAt || '', a.addedAt || '') || cmp(a._nt, b._nt); };
      case 'az': return function (a, b) { return cmp(a._nt, b._nt); };
      case 'smallest': return function (a, b) { return (a.sizeMax || Infinity) - (b.sizeMax || Infinity) || cmp(a._nt, b._nt); };
      case 'largest': return function (a, b) { return (b.sizeMax || 0) - (a.sizeMax || 0) || cmp(a._nt, b._nt); };
      case 'popular': return function (a, b) { return (b.popularity || 0) - (a.popularity || 0) || cmp(a._nt, b._nt); };
      case 'metacritic': return function (a, b) { return (typeof b.metacritic === 'number' ? b.metacritic : -1) - (typeof a.metacritic === 'number' ? a.metacritic : -1) || cmp(a._nt, b._nt); };
      case 'mostUpdates': return function (a, b) { return (ca.counts(b).update + ca.counts(b).dlc) - (ca.counts(a).update + ca.counts(a).dlc) || cmp(a._nt, b._nt); };
      default: return function (a, b) { return cmp(b.releaseDate || '', a.releaseDate || '') || cmp(b.addedAt || '', a.addedAt || '') || cmp(a._nt, b._nt); };
    }
  }

  /* ---------- labels ---------- */
  function sourceName(id) { for (var i = 0; i < S.data.sources.length; i++) if (S.data.sources[i].id === id) return S.data.sources[i].name; return id; }
  function optionLabel(fid, v) {
    if (fid === 'source') return sourceName(v);
    if (fid === 'size') return t('filter.size.' + v);
    if (fid === 'year') return v === 'older' ? t('facets.yearOlder') : v;
    if (fid === 'compat') return t('game.fw', { fw: v });
    if (fid === 'platform') return v;
    return v;
  }
  function facetLabel(fid) { return t('facets.' + fid); }
  function chipLabel(fid) {
    var sel = f.sel[fid];
    if (!sel.length) return facetLabel(fid);
    if (sel.length === 1) return optionLabel(fid, sel[0]);
    return t('facets.nSelected', { label: facetLabel(fid), n: sel.length });
  }
  /* Option list of a facet: fixed order, or values sorted by count (publisher: top 30). */
  function options(fid) {
    var fc = facet(fid), counts = lastCounts[fid] || {}, vals;
    if (fc.bool) return ['yes'];
    if (fc.fixed) vals = fc.fixed.slice();
    else {
      var set = {};
      S.data.games.forEach(function (g) { if (!ca.isGame(g)) return; fc.get(ca.facetValues(g), g).forEach(function (v) { set[v] = (set[v] || 0) + 1; }); });
      vals = Object.keys(set);
      vals.sort(function (a, b) { return (set[b] - set[a]) || cmp(a, b); });
      if (fc.top) vals = vals.slice(0, fc.top);
      if (fid === 'region') { var order = ['EUR', 'USA', 'JPN', 'ASIA']; vals.sort(function (a, b) { var ia = order.indexOf(a), ib = order.indexOf(b); if (ia < 0) ia = 99; if (ib < 0) ib = 99; return ia - ib || cmp(a, b); }); }
    }
    f.sel[fid].forEach(function (v) { if (vals.indexOf(v) < 0) vals.push(v); });
    return vals.map(function (v) { return { id: v, label: optionLabel(fid, v), count: counts[v] || 0 }; });
  }

  /* ---------- top bar: search, Filters, Sort, Presets ---------- */
  function topBar() {
    var bar = h('div.browse-bar', { data: { navRegion: '' } });
    searchBox = ui.searchBox({ id: 'browse-search', placeholder: t('browse.searchPlaceholder'), value: f.q,
      onInput: function (v) { f.q = v; pageStart = 0; pageCount = 1; liveUpdate(); },
      onEnter: function (v) { ca.recentSearches.push(v); paintSuggest(); var c = root.querySelector('.card'); if (c) XS.nav.focus(c); } });
    searchBox.input.addEventListener('focus', paintSuggest);
    bar.appendChild(searchBox);
    var n = selectedCount();
    var flt = h('button.btn' + (n ? '.on-gold' : ''), { nav: 'browse-filters', html: U.icon('filter') + '<span>' + U.escapeHtml(n ? t('browse2.filtersN', { n: n }) : t('browse2.filters')) + '</span>', data: { hints: 'select' } });
    flt.addEventListener('click', function () { openFacets(''); });
    bar.appendChild(flt);
    var sort = h('button.btn', { nav: 'flt-sort', html: U.icon('sort') + '<span>' + U.escapeHtml(f.q.trim() && !f.sortExplicit ? t('browse2.sortRelevance') : t('sort.' + f.sort)) + '</span>' });
    sort.addEventListener('click', function () {
      var items = [];
      if (f.q.trim()) items.push({ label: t('browse2.sortRelevance'), checked: !f.sortExplicit, onSelect: function () { f.sortExplicit = false; rerender('flt-sort'); } });
      SORTS.forEach(function (s) { items.push({ label: t('sort.' + s), checked: f.sortExplicit || !f.q.trim() ? f.sort === s : false, onSelect: function () { f.sort = s; f.sortExplicit = true; pageStart = 0; pageCount = 1; rerender('flt-sort'); } }); });
      ui.menu(sort, items, { title: t('browse.sortBy') });
    });
    bar.appendChild(sort);
    var pre = h('button.btn', { nav: 'browse-presets', html: U.icon('star') + '<span>' + U.escapeHtml(t('browse2.presets')) + '</span>' });
    pre.addEventListener('click', function () { presetsMenu(pre); });
    bar.appendChild(pre);
    return bar;
  }
  function facetChips() {
    var bar = h('div.browse-filters', { data: { navRegion: '' } });
    ['platform', 'genre', 'format', 'source', 'region', 'year', 'size', 'publisher', 'compat', 'features'].forEach(function (fid) {
      var on = f.sel[fid].length > 0;
      var c = h('button.chip' + (on ? '.on' : ''), { nav: 'flt-' + fid, data: { hints: 'select' } }, [h('span', { text: chipLabel(fid) }), ui.svg('chevD')]);
      c.addEventListener('click', function () { openFacets(fid); });
      bar.appendChild(c);
    });
    return bar;
  }
  function quickChips() {
    var bar = h('div.quick-chips', { data: { navRegion: '' } });
    bar.appendChild(h('span.qc-label', { text: t('browse2.quick') }));
    QUICK.forEach(function (qc) {
      var on = f.sel[qc.facet].indexOf(qc.value) >= 0;
      var c = h('button.chip.quick' + (on ? '.on' : ''), { nav: 'quick-' + qc.id, text: t('browse2.quickChip.' + qc.id), data: { hints: 'toggle' }, 'aria-pressed': on ? 'true' : 'false' });
      c.addEventListener('click', function () { toggleValue(qc.facet, qc.value); rerender('quick-' + qc.id); });
      bar.appendChild(c);
    });
    return bar;
  }
  function toggleValue(fid, v) {
    var sel = f.sel[fid], i = sel.indexOf(v);
    if (i >= 0) sel.splice(i, 1); else sel.push(v);
    pageStart = 0; pageCount = 1;
  }
  function activeChips() {
    var items = [];
    if (f.q) items.push({ label: '“' + f.q + '”', clear: function () { f.q = ''; if (searchBox) searchBox.input.value = ''; } });
    FACETS.forEach(function (fc) {
      f.sel[fc.id].forEach(function (v) { items.push({ label: fc.bool ? t('facets.' + fc.id) : (fc.id === 'platform' || fc.id === 'genre' || fc.id === 'region' || fc.id === 'publisher' ? optionLabel(fc.id, v) : facetLabel(fc.id) + ': ' + optionLabel(fc.id, v)), clear: function () { toggleValue(fc.id, v); } }); });
    });
    if (f.favorites) items.push({ label: t('discover.yourFavorites'), clear: function () { f.favorites = false; } });
    if (!items.length) return null;
    var wrap = h('div.browse-active', { data: { navRegion: '' } });
    items.forEach(function (it, i) {
      var c = h('button.chip.gold', { nav: 'act-' + i, data: { hints: 'remove' } }, [h('span', { text: it.label }), h('span.x', { text: '✕' })]);
      c.addEventListener('click', function () { it.clear(); pageStart = 0; pageCount = 1; rerender(); });
      wrap.appendChild(c);
    });
    var reset = h('button.chip', { nav: 'act-reset', text: t('browse.resetFilters') });
    reset.addEventListener('click', function () { f = defaults(); pageStart = 0; pageCount = 1; if (searchBox) searchBox.input.value = ''; rerender('browse-filters'); });
    wrap.appendChild(reset);
    return wrap;
  }
  /* Recent searches + suggestions under the bar while the query is empty. */
  function paintSuggest() {
    if (!suggestEl) return;
    U.clear(suggestEl);
    if (f.q.trim()) return;
    var rec = ca.recentSearches.get();
    var row = h('div.browse-suggest', { data: { navRegion: '' } });
    if (rec.length) {
      row.appendChild(h('span.qc-label', { text: t('search.recent') }));
      rec.slice(0, 6).forEach(function (q, i) { var c = h('button.chip', { nav: 'recent-' + i, text: q }); c.addEventListener('click', function () { f.q = q; searchBox.input.value = q; pageStart = 0; pageCount = 1; rerender('browse-search'); }); row.appendChild(c); });
      var clr = h('button.chip.ghost', { nav: 'recent-clear', text: t('search.clearRecent') }); clr.addEventListener('click', function () { ca.recentSearches.clear(); paintSuggest(); });
      row.appendChild(clr);
    }
    var sug = (S.data.lists.trending || []).filter(ca.isGame).slice(0, 5);
    if (sug.length) {
      row.appendChild(h('span.qc-label', { text: t('search.suggestions') }));
      sug.forEach(function (g, i) { var c = h('button.chip', { nav: 'sug-' + i, text: g.title }); c.addEventListener('click', function () { XS.router.go('game', { id: g.id }); }); row.appendChild(c); });
    }
    if (row.children.length > 1) suggestEl.appendChild(row);
  }

  /* ---------- Filters sheet: every facet, live counts ---------- */
  function openFacets(focusFacet) {
    if (sheetHandle && !sheetHandle.closed) { focusSection(focusFacet); return; }
    sheetHandle = ui.sheet({
      title: t('browse2.filters'), sub: t('browse.filterHint'), key: 'facets', cls: 'facets',
      body: function (body) { paintFacetBody(body); },
      foot: [
        h('button.btn.ghost', { nav: 'facet-clear', text: t('browse2.clearAll'), on: { click: function () { f = defaults(); pageStart = 0; pageCount = 1; if (searchBox) searchBox.input.value = ''; rerenderBehind(); refreshSheet(); } } }),
        h('span.spacer'),
        h('span.facet-total', { 'data-facet-total': '', text: ca.nResults(lastRes.length) }),
        h('button.btn.primary', { nav: 'facet-done', text: t('common.done'), on: { click: function () { ui.closeLayer(sheetHandle); } } })
      ],
      onClose: function () { sheetHandle = null; rerender('browse-filters'); }
    });
    requestAnimationFrame(function () { focusSection(focusFacet); });
  }
  function focusSection(fid) {
    if (!sheetHandle || !fid) return;
    var sec = sheetHandle.body.querySelector('[data-facet="' + fid + '"]');
    if (!sec) return;
    var first = sec.querySelector('[data-nav]');
    if (first) XS.nav.focus(first, false);
  }
  function paintFacetBody(body) {
    U.clear(body);
    var order = ['platform', 'genre', 'format', 'source', 'region', 'year', 'size', 'publisher', 'compat', 'features'];
    order.forEach(function (fid) { body.appendChild(facetSection(fid)); });
    var only = h('section.facet', { data: { facet: 'only' } });
    only.appendChild(h('h3', [t('browse2.onlyShow')]));
    var list = h('div.facet-opts');
    BOOL.forEach(function (fid) { list.appendChild(optionRow(fid, { id: 'yes', label: t('facets.' + fid), count: (lastCounts[fid] || {}).yes || 0 }, t('facets.hint.' + fid))); });
    only.appendChild(list);
    body.appendChild(only);
  }
  function facetSection(fid) {
    var sec = h('section.facet', { data: { facet: fid } });
    var opts = options(fid);
    sec.appendChild(h('h3', [facetLabel(fid), f.sel[fid].length ? h('span.count', { text: '· ' + f.sel[fid].length }) : null]));
    var list = h('div.facet-opts' + (opts.length > 8 ? '.cols' : ''));
    opts.forEach(function (o) { list.appendChild(optionRow(fid, o)); });
    if (!opts.length) list.appendChild(h('div.dim', { text: t('facets.none'), style: { padding: '4px 2px', fontSize: '13px' } }));
    sec.appendChild(list);
    return sec;
  }
  function optionRow(fid, o, hint) {
    var on = f.sel[fid].indexOf(o.id) >= 0;
    var row = h('button.fopt' + (on ? '.on' : '') + (!o.count && !on ? '.zero' : ''), { nav: 'fo-' + fid + '-' + U.hashStr(o.id).toString(36), role: 'checkbox', 'aria-checked': on ? 'true' : 'false', data: { hints: 'toggle', fo: fid + '|' + o.id } });
    row.appendChild(h('span.check', { html: on ? U.icon('check') : '' }));
    var main = h('span.main', [h('span.name', { text: o.label })]);
    if (hint) main.appendChild(h('span.hint', { text: hint }));
    row.appendChild(main);
    row.appendChild(h('span.n', { 'data-count': '', text: fmtCount(o.count) }));
    row.addEventListener('click', function () { toggleValue(fid, o.id); rerenderBehind(); refreshSheet(); });
    return row;
  }
  function fmtCount(n) { try { return Number(n || 0).toLocaleString(XS.i18n.locale); } catch (e) { return String(n || 0); } }
  /* Live update inside the open sheet: counts, checks and the total — no rebuild under the user's focus. */
  function refreshSheet() {
    if (!sheetHandle || sheetHandle.closed) return;
    var body = sheetHandle.body;
    U.$$('.fopt', body).forEach(function (row) {
      var parts = row.getAttribute('data-fo').split('|'), fid = parts[0], v = parts.slice(1).join('|');
      var on = f.sel[fid].indexOf(v) >= 0, n = (lastCounts[fid] || {})[v] || 0;
      row.classList.toggle('on', on); row.classList.toggle('zero', !n && !on); row.setAttribute('aria-checked', on ? 'true' : 'false');
      row.querySelector('.check').innerHTML = on ? U.icon('check') : '';
      row.querySelector('[data-count]').textContent = fmtCount(n);
    });
    U.$$('section.facet', body).forEach(function (sec) {
      var fid = sec.getAttribute('data-facet'); if (fid === 'only') return;
      var cnt = sec.querySelector('h3 .count'), n = f.sel[fid].length;
      if (n && !cnt) sec.querySelector('h3').appendChild(h('span.count', { text: '· ' + n }));
      else if (cnt) { if (n) cnt.textContent = '· ' + n; else cnt.parentNode.removeChild(cnt); }
    });
    var total = sheetHandle.foot.querySelector('[data-facet-total]'); if (total) total.textContent = ca.nResults(lastRes.length);
  }

  /* ---------- Presets (settings.browse.presets) ---------- */
  function presets() { var s = S.data.settings; return (s && s.browse && Array.isArray(s.browse.presets)) ? s.browse.presets : []; }
  function savePresets(list) {
    return ca.api.settingsPut({ browse: { presets: list } }).then(function (r) { if (r.settings) S.set('settings', r.settings); else { S.data.settings = S.data.settings || {}; S.data.settings.browse = { presets: list }; } }, function (err) { ui.errorToast(err, t('browse2.presets')); throw err; });
  }
  function summarize(p) {
    var parts = [];
    var sel = (p.filters && p.filters.sel) || {};
    for (var k in sel) if (sel[k] && sel[k].length) parts.push(k === 'platform' || k === 'genre' ? sel[k].join('/') : facetLabel(k));
    if (p.filters && p.filters.q) parts.push('“' + p.filters.q + '”');
    if (p.sort) parts.push(t('sort.' + p.sort));
    return parts.join(' · ') || t('browse2.presetEmpty');
  }
  function presetsMenu(anchor) {
    var list = presets(), items = [];
    list.forEach(function (p, i) {
      items.push({ label: p.name, sub: summarize(p), icon: 'star', onSelect: function () {
        var nf = defaults();
        var sel = (p.filters && p.filters.sel) || {};
        for (var k in sel) if (nf.sel[k] && Array.isArray(sel[k])) nf.sel[k] = sel[k].slice();
        nf.q = (p.filters && p.filters.q) || ''; nf.favorites = !!(p.filters && p.filters.favorites);
        if (p.sort && SORTS.indexOf(p.sort) >= 0) { nf.sort = p.sort; nf.sortExplicit = true; }
        f = nf; pageStart = 0; pageCount = 1; rerender('browse-presets');
        ui.toast({ cls: 'gold', icon: 'star', title: t('browse2.presetApplied', { name: p.name }), timeout: 2000 });
      } });
    });
    if (items.length) items.push('sep');
    items.push({ label: t('browse2.presetSave'), icon: 'plus', sub: selectedCount() || f.q ? t('browse2.presetSaveSub', { n: lastRes.length }) : t('browse2.presetSaveEmpty'), onSelect: function () {
      ui.prompt(t('browse2.presetSave'), { label: t('browse2.presetName'), placeholder: t('browse2.presetPlaceholder'), okLabel: t('browse2.presetSaveOk') }).then(function (name) {
        if (!name || !name.trim()) return;
        var p = { name: name.trim().slice(0, 40), filters: { sel: JSON.parse(JSON.stringify(f.sel)), q: f.q, favorites: f.favorites }, sort: f.sortExplicit || !f.q ? f.sort : '' };
        var next = list.filter(function (x) { return x.name !== p.name; }).concat([p]).slice(-20);
        savePresets(next).then(function () { ui.toast({ cls: 'good', icon: 'star', title: t('browse2.presetSaved', { name: p.name }) }); }, function () { /* toast shown */ });
      });
    } });
    if (list.length) items.push({ label: t('browse2.presetDelete'), icon: 'trash', danger: true, onSelect: function () {
      ui.menu(anchor, list.map(function (p) { return { label: p.name, icon: 'trash', danger: true, onSelect: function () {
        ui.confirm(t('browse2.presetDeleteTitle', { name: p.name }), t('browse2.presetDeleteText'), t('common.delete'), true).then(function (ok) { if (ok) savePresets(list.filter(function (x) { return x !== p; })).then(function () { ui.toast({ title: t('browse2.presetDeleted', { name: p.name }) }); }, function () { /* toast shown */ }); });
      } }; }), { title: t('browse2.presetDelete') });
    } });
    ui.menu(anchor, items, { title: t('browse2.presets') });
  }

  /* ---------- render ---------- */
  var liveUpdate = U.debounce(function () { renderResults(); paintSuggest(); refreshSheet(); }, 120);
  function render() {
    if (!root) return;
    U.clear(root);
    var inner = h('div.screen-inner');
    root.appendChild(inner);
    barEl = topBar(); inner.appendChild(barEl);
    suggestEl = h('div'); inner.appendChild(suggestEl); paintSuggest();
    quickEl = quickChips(); inner.appendChild(quickEl);
    inner.appendChild(facetChips());
    activeEl = h('div'); var ac = activeChips(); if (ac) activeEl.appendChild(ac); inner.appendChild(activeEl);
    metaEl = h('div.browse-meta'); inner.appendChild(metaEl);
    gridHost = h('div', { data: { navRegion: '' } }); inner.appendChild(gridHost);
    renderResults();
  }
  function renderResults() {
    if (!gridHost) return;
    var res = compute();
    U.clear(metaEl); U.clear(gridHost);
    if (!S.data.catalog) { gridHost.appendChild(ui.skeletonRail(8)); return; }
    var pages = Math.max(1, Math.ceil(res.length / PAGE));
    pageStart = Math.min(pageStart, pages - 1);
    pageCount = Math.max(1, Math.min(pageCount, pages - pageStart));
    metaEl.appendChild(h('span.n', { text: ca.nResults(res.length) }));
    if (pages > 1) metaEl.appendChild(h('span.mute', { text: t('browse2.showing', { from: pageStart * PAGE + 1, to: Math.min(res.length, (pageStart + pageCount) * PAGE), total: res.length }) }));
    metaEl.appendChild(h('span.spacer'));
    if (f.q.trim()) metaEl.appendChild(h('span.mute', { text: t('browse2.matching') }));
    if (!res.length) {
      var acts = [];
      var dym = f.q.trim() ? ca.didYouMean(f.q) : '';
      if (dym) {
        var b = h('button.btn.primary', { nav: 'dym', html: U.escapeHtml(t('browse2.didYouMean')) + ' <b>' + U.escapeHtml(dym) + '</b>' });
        b.addEventListener('click', function () { f.q = dym; searchBox.input.value = dym; pageStart = 0; rerender('browse-search'); });
        acts.push(b);
      }
      acts.push(h('button.btn', { nav: 'empty-reset', text: t('browse.resetFilters'), on: { click: function () { f = defaults(); if (searchBox) searchBox.input.value = ''; rerender('browse-search'); } } }));
      if (f.q.trim()) acts.push(h('button.btn.ghost', { nav: 'empty-request', html: U.icon('plus') + '<span>' + U.escapeHtml(t('game2.requestGame')) + '</span>', on: { click: function () { ca.requestGame(f.q.trim()); } } }));
      gridHost.appendChild(ui.emptyState(f.q ? t('browse.emptyQueryTitle', { q: f.q }) : t('browse.emptyTitle'), t('browse.emptyHint'), acts));
      return;
    }
    var win = res.slice(pageStart * PAGE, (pageStart + pageCount) * PAGE);
    var grid = h('div.vgrid.browse-grid');
    gridHost.appendChild(grid);
    gridApi = ui.vgrid(grid, win, root, function (g) {
      var c = ui.card(g);
      c.addEventListener('click', function () { if (f.q.trim()) ca.recentSearches.push(f.q.trim()); }, true);
      return c;
    });
    var more = pageStart + pageCount < pages;
    /* Load more on focus near the end (controller) and on scroll near the end (touch/mouse) — plus an explicit button. */
    grid.addEventListener('focusin', function (e) {
      if (!more) return;
      var card = e.target && e.target.closest ? e.target.closest('.card') : null; if (!card) return;
      var row = card.closest('.vrow'); if (!row) return;
      var ri = Number(row.getAttribute('data-row')), rows = Math.ceil(win.length / Math.max(1, row.children.length));
      if (ri >= rows - 2) loadMore(card.getAttribute('data-nav-id'));
    });
    if (more) {
      var lm = h('button.btn.lg.load-more', { nav: 'load-more', html: U.icon('down') + '<span>' + U.escapeHtml(t('browse2.loadMore', { n: Math.min(PAGE, res.length - (pageStart + pageCount) * PAGE) })) + '</span>' });
      lm.addEventListener('click', function () { loadMore('load-more'); });
      gridHost.appendChild(lm);
    }
    gridHost.appendChild(pager(pages));
    enforceMounted(grid);
  }
  var loading = false;
  function loadMore(focusId) {
    if (loading) return; loading = true;
    pageCount++;
    var scroll = root.scrollTop;
    renderResults();
    root.scrollTop = scroll;
    requestAnimationFrame(function () { loading = false; if (focusId) { var el = gridHost.querySelector('[data-nav-id="' + focusId + '"]'); if (el) XS.nav.focus(el, false); } });
  }
  /* Safety net for the ≤150 mounted cards budget: the virtual grid renders ±2 rows, which is far below on any TV. */
  function enforceMounted(grid) {
    requestAnimationFrame(function () {
      var cards = grid.querySelectorAll('.card');
      if (cards.length > MAX_MOUNTED) { var rows = grid.querySelectorAll('.vrow'); for (var i = rows.length - 1; i >= 0 && grid.querySelectorAll('.card').length > MAX_MOUNTED; i--) if (!rows[i].contains(document.activeElement)) grid.removeChild(rows[i]); }
    });
  }
  function pager(pages) {
    var p = h('div.pager', { data: { navRegion: '' } });
    function btn(label, target, on, id) {
      var b = h('button.pg' + (on ? '.on' : ''), { nav: 'pg-' + id, text: label });
      if (target === null) b.setAttribute('aria-disabled', 'true');
      b.addEventListener('click', function () { if (target === null) return; pageStart = target; pageCount = 1; renderResults(); root.scrollTop = Math.max(0, gridHost.offsetTop - 80); XS.nav.remember(XS.nav.key, 'pg-' + (target + 1)); ca.focusIn(gridHost, 'pg-' + (target + 1)); });
      return b;
    }
    p.appendChild(btn(t('common.prev'), pageStart > 0 ? pageStart - 1 : null, false, 'prev'));
    var win = [];
    for (var i = 0; i < pages; i++) if (i < 2 || i >= pages - 2 || Math.abs(i - pageStart) <= 2) win.push(i);
    var last = -1;
    win.forEach(function (i) { if (last >= 0 && i - last > 1) p.appendChild(h('span.mute', { text: '…' })); p.appendChild(btn(String(i + 1), i, i >= pageStart && i < pageStart + pageCount, i + 1)); last = i; });
    p.appendChild(btn(t('common.next'), pageStart + pageCount < pages ? pageStart + pageCount : null, false, 'next'));
    p.appendChild(h('span.mute.pg-info', { text: t('common.pageOf', { page: pageStart + 1, pages: pages }) }));
    return p;
  }
  function rerenderBehind() {
    /* Called from inside the Filters sheet: refresh the chips/results behind without touching the sheet's focus. */
    var scroll = root.scrollTop;
    var ac = activeChips(); U.clear(activeEl); if (ac) activeEl.appendChild(ac);
    var q2 = quickChips(); quickEl.parentNode.replaceChild(q2, quickEl); quickEl = q2;
    var fcs = facetChips(); var old = root.querySelector('.browse-filters'); if (old) old.parentNode.replaceChild(fcs, old);
    var tb = topBar(); barEl.parentNode.replaceChild(tb, barEl); barEl = tb;
    renderResults();
    root.scrollTop = scroll;
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
    setQuery: function (q) { f.q = q; pageStart = 0; pageCount = 1; render(); },
    state: function () { return f; }
  });
  S.on('catalog', function () { if (root && root.classList.contains('active')) render(); else if (root) U.clear(root); });
  S.on('favorites', function () { if (root) U.$$('.card[data-game]', root).forEach(function (c) { c.classList.toggle('fav', S.isFav(c.getAttribute('data-game'))); }); });
  XS.browse = { facets: FACETS, compute: compute, state: function () { return f; }, counts: function () { return lastCounts; } };
})();
