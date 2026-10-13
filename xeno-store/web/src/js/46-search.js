/* XENO STORE — 46-search.js: full-screen search overlay (△ or /): ranked instant results (exact > prefix > word >
   fuzzy, title IDs + publishers), "Did you mean", recent searches (10), suggestions. */
(function () {
  'use strict';
  var XS = window.XS, U = XS.util, S = XS.state, ui = XS.ui, ca = XS.ca, h = U.h, t = XS.t;
  var handle = null, input = null, body = null, lastQ = '';
  var LIMIT = 48;

  function open(initial) {
    if (handle && !handle.closed) { input.focus(); return; }
    var layer = h('div.layer.search-layer', { 'data-nav-scope': '', role: 'search' });
    var top = h('div.search-top');
    var sb = ui.searchBox({ id: 'search-input', placeholder: t('search.placeholder'), value: initial || '', onInput: function (v) { update(v); }, onEnter: function (v) { var c = body.querySelector('.card'); if (c) { ca.recentSearches.push(v); XS.nav.focus(c); } } });
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
  var pending = null;
  function update(q) {
    lastQ = q;
    clearTimeout(pending);
    pending = setTimeout(function () { paint(q); }, q.trim().length > 2 ? 60 : 0);
  }
  function paint(q) {
    U.clear(body);
    if (!q.trim()) { idle(); return; }
    var hits = ca.search(q, LIMIT + 1);
    var res = hits.slice(0, LIMIT).map(function (x) { return x.g; });
    var fuzzy = hits.length && hits[0].score < 350;
    body.appendChild(h('div.browse-meta', [h('span', { text: ca.nResults(res.length) + (hits.length > LIMIT ? '+' : '') }), fuzzy ? h('span.mute', { text: t('browse2.fuzzyNote') }) : null, h('span.spacer'), res.length >= LIMIT ? h('button.btn.sm.ghost', { nav: 'search-more', text: t('search.openInBrowse'), on: { click: function () { var qq = lastQ; ui.closeLayer(handle); XS.router.go('browse', { q: qq }); } } }) : null]));
    if (!res.length) {
      var acts = [];
      var dym = ca.didYouMean(q);
      if (dym) { var b = h('button.btn.primary', { nav: 'search-dym', html: U.escapeHtml(t('browse2.didYouMean')) + ' <b>' + U.escapeHtml(dym) + '</b>' }); b.addEventListener('click', function () { input.value = dym; update(dym); }); acts.push(b); }
      acts.push(h('button.btn.ghost', { nav: 'search-request', html: U.icon('plus') + '<span>' + U.escapeHtml(t('game2.requestGame')) + '</span>', on: { click: function () { ca.requestGame(q.trim()); } } }));
      body.appendChild(ui.emptyState(t('browse.emptyQueryTitle', { q: q }), t('search.emptyHint'), acts));
      return;
    }
    var grid = h('div.grid');
    res.forEach(function (g) {
      var c = ui.card(g);
      c.addEventListener('click', function () { ca.recentSearches.push(lastQ); }, true);
      grid.appendChild(c);
    });
    body.appendChild(grid);
  }
  function idle() {
    var rec = ca.recentSearches.get();
    if (rec.length) {
      body.appendChild(h('div.section-head', [h('h2.section-title', { text: t('search.recent') }), h('span.spacer'), h('button.btn.sm.ghost', { nav: 'search-clear-recent', text: t('search.clearRecent'), on: { click: function () { ca.recentSearches.clear(); paint(''); } } })]));
      var chips = h('div.sug', { data: { navRegion: '' } });
      rec.forEach(function (q, i) { var c = h('button.chip', { nav: 'recent-' + i, text: q }); c.addEventListener('click', function () { input.value = q; paint(q); }); chips.appendChild(c); });
      body.appendChild(chips);
    }
    body.appendChild(h('div.section-head', [h('h2.section-title', { text: t('search.suggestions') })]));
    var sug = h('div.sug', { data: { navRegion: '' } });
    S.data.genres.slice(0, 12).forEach(function (gn, i) { var c = h('button.chip', { nav: 'sug-' + i, text: gn.name }); c.addEventListener('click', function () { ui.closeLayer(handle); XS.router.go('browse', { genre: gn.name }); }); sug.appendChild(c); });
    (S.data.lists.trending || []).filter(ca.isGame).slice(0, 6).forEach(function (g, i) { var c = h('button.chip.gold', { nav: 'sugg-' + i, text: g.title }); c.addEventListener('click', function () { ui.closeLayer(handle); XS.router.go('game', { id: g.id }); }); sug.appendChild(c); });
    body.appendChild(sug);
    var tr = (S.data.lists.trending || []).filter(ca.isGame).slice(0, 12);
    if (tr.length) body.appendChild(ui.rail(t('discover.trending'), tr, { id: 'search-trending', limit: 12 }));
    var nw = (S.data.lists.newest || []).filter(ca.isGame).slice(0, 12);
    if (nw.length) body.appendChild(ui.rail(t('discover.newOnXeno'), nw, { id: 'search-new', limit: 12 }));
  }
  XS.search = { open: open, toggle: function () { if (handle && !handle.closed) ui.closeLayer(handle); else open(''); }, isOpen: function () { return !!(handle && !handle.closed); } };
})();
