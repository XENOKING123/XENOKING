/* XENO STORE — 46-search.js: full-screen search overlay (△ or /): instant results, recent searches, suggestions. */
(function () {
  'use strict';
  var XS = window.XS, U = XS.util, S = XS.state, ui = XS.ui, h = U.h, t = XS.t;
  var handle = null, input = null, body = null, lastQ = '';
  var LIMIT = 48;

  function recents() { return U.store.get('recentSearches', []); }
  function pushRecent(q) { q = q.trim(); if (!q) return; var r = recents().filter(function (x) { return x.toLowerCase() !== q.toLowerCase(); }); r.unshift(q); U.store.set('recentSearches', r.slice(0, 8)); }

  function open(initial) {
    if (handle && !handle.closed) { input.focus(); return; }
    var layer = h('div.layer.search-layer', { 'data-nav-scope': '', role: 'search' });
    var top = h('div.search-top');
    var sb = ui.searchBox({ id: 'search-input', placeholder: t('search.placeholder'), value: initial || '', onInput: function (v) { update(v); }, onEnter: function (v) { var c = body.querySelector('.card'); if (c) { pushRecent(v); XS.nav.focus(c); } } });
    input = sb.input;
    input.setAttribute('data-autofocus', '');
    top.appendChild(sb);
    var close = h('button.btn.lg', { nav: 'search-close', html: U.icon('x') + '<span>' + U.escapeHtml(t('common.close')) + '</span>' });
    close.addEventListener('click', function () { ui.closeLayer(handle); });
    top.appendChild(close);
    layer.appendChild(top);
    layer.appendChild(h('div.search-hint', [h('span', { html: U.glyph('triangle') + ' ' + U.escapeHtml(t('search.hintToggle')) }), h('span', { html: U.glyph('circle') + ' ' + U.escapeHtml(t('search.hintClose')) }), h('span', { text: t('search.hintFields') })]));
    body = h('div.search-body', { data: { navRegion: '' } });
    layer.appendChild(body);
    handle = ui.openLayer(layer, { key: 'search', type: 'overlay', onClose: function () { handle = null; } });
    update(initial || '');
    setTimeout(function () { try { input.focus(); input.select(); } catch (e) { /* ignore */ } }, 30);
  }
  function update(q) {
    lastQ = q;
    U.clear(body);
    q = q.trim().toLowerCase();
    if (!q) { idle(); return; }
    var games = S.data.games, out = [], starts = [], tid = [];
    for (var i = 0; i < games.length && (out.length + starts.length + tid.length) < LIMIT * 2; i++) {
      var g = games[i];
      var idx = g._search.indexOf(q);
      if (idx < 0) continue;
      if ((g.titleIds || []).some(function (x) { return x.toLowerCase().indexOf(q) === 0; })) tid.push(g);
      else if (g._nt.indexOf(q) === 0) starts.push(g);
      else out.push(g);
    }
    var res = tid.concat(starts, out).slice(0, LIMIT);
    body.appendChild(h('div.browse-meta', [h('span', { text: t('browse.results', { n: res.length }) }), h('span.spacer'), res.length >= LIMIT ? h('button.btn.sm.ghost', { nav: 'search-more', text: t('search.openInBrowse'), on: { click: function () { var qq = lastQ; ui.closeLayer(handle); XS.router.go('browse', { q: qq }); } } }) : null]));
    if (!res.length) { body.appendChild(ui.emptyState(t('browse.emptyQueryTitle', { q: lastQ }), t('search.emptyHint'))); return; }
    var grid = h('div.grid');
    res.forEach(function (g) {
      var c = ui.card(g);
      c.addEventListener('click', function () { pushRecent(lastQ); }, true);
      grid.appendChild(c);
    });
    body.appendChild(grid);
  }
  function idle() {
    var rec = recents();
    if (rec.length) {
      body.appendChild(h('div.section-head', [h('h2.section-title', { text: t('search.recent') }), h('span.spacer'), h('button.btn.sm.ghost', { nav: 'search-clear-recent', text: t('search.clearRecent'), on: { click: function () { U.store.del('recentSearches'); update(''); } } })]));
      var chips = h('div.sug', { data: { navRegion: '' } });
      rec.forEach(function (q, i) { var c = h('button.chip', { nav: 'recent-' + i, text: q }); c.addEventListener('click', function () { input.value = q; update(q); }); chips.appendChild(c); });
      body.appendChild(chips);
    }
    body.appendChild(h('div.section-head', [h('h2.section-title', { text: t('search.suggestions') })]));
    var sug = h('div.sug', { data: { navRegion: '' } });
    S.data.genres.slice(0, 12).forEach(function (gn, i) { var c = h('button.chip', { nav: 'sug-' + i, text: gn.name }); c.addEventListener('click', function () { ui.closeLayer(handle); XS.router.go('browse', { genre: gn.name }); }); sug.appendChild(c); });
    body.appendChild(sug);
    var tr = (S.data.lists.trending || []).slice(0, 12);
    if (tr.length) body.appendChild(ui.rail(t('discover.trending'), tr, { id: 'search-trending', limit: 12 }));
    var nw = (S.data.lists.newest || []).slice(0, 12);
    if (nw.length) body.appendChild(ui.rail(t('discover.newOnXeno'), nw, { id: 'search-new', limit: 12 }));
  }
  XS.search = { open: open, toggle: function () { if (handle && !handle.closed) ui.closeLayer(handle); else open(''); }, isOpen: function () { return !!(handle && !handle.closed); } };
})();
