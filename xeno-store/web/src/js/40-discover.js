/* XENO STORE — 40-discover.js: hero spotlight (featured.hero first), rails incl. owner-curated featured rows,
   backports, community saves, homebrew essentials; announcement banner; prefetch; surprise me; All games grid. */
(function () {
  'use strict';
  var XS = window.XS, U = XS.util, S = XS.state, ui = XS.ui, ca = XS.ca, h = U.h, t = XS.t;
  var PAGE = 96;
  var heroTimer = null, heroIdx = 0, heroList = [], heroEl = null, page = 0, root = null, gridEl = null;
  var dirty = false;   /* something changed while Discover was hidden (recent games, job set): re-render on the next show */

  function featured() { var st = S.data.status; return (st && st.featured) || {}; }
  function heroPool() {
    var L = S.data.lists;
    var pool = [], seen = {};
    function add(g) { if (g && ca.isGame(g) && !seen[g.id] && pool.length < 10) { seen[g.id] = 1; pool.push(g); } }
    (featured().hero || []).forEach(function (id) { add(S.game(id)); });   /* owner-curated first (§17.1) */
    (L.featured || []).forEach(add);
    (L.newest || []).forEach(function (g) { if (g.hero || g.cover) add(g); });
    return pool.slice(0, 10);
  }

  function renderHero(container) {
    heroList = heroPool();
    if (!heroList.length) return;
    heroIdx = Math.min(heroIdx, heroList.length - 1);
    heroEl = h('section.hero', { data: { navFrame: '' } });
    container.appendChild(heroEl);
    paintHero(false);
    startRotation();
  }
  function paintHero(animate) {
    var g = heroList[heroIdx];
    if (!g || !heroEl) return;
    var focusedInHero = heroEl.contains(document.activeElement);
    var focusId = focusedInHero && document.activeElement.getAttribute('data-nav-id');
    U.clear(heroEl);
    heroEl.classList.toggle('swap', !!animate && !U.reducedMotion());
    var art = h('div.art');
    art.appendChild(ui.cover(g.hero || g.cover, g.heroFallback || g.coverFallback, g.title));
    heroEl.appendChild(art);
    var body = h('div.body');
    var curated = (featured().hero || []).indexOf(g.id) >= 0;
    body.appendChild(h('div.kicker', { text: curated ? t('discover2.kickerStaff') : g.featured > 0 ? t('discover.kickerFeatured') : t('discover.kicker') }));
    body.appendChild(h('h1', { text: g.title }));
    if (g.tagline) body.appendChild(h('p.tagline.clamp2', { text: g.tagline }));
    var chips = h('div.chips');
    chips.appendChild(ui.platChip(g.platform));
    ui.uniqueFormats(g).slice(0, 3).forEach(function (f) { chips.appendChild(h('span.chip.fmt', { text: f })); });
    if (g.sizeMax) chips.appendChild(h('span.chip', { text: ui.sizeRange(g) }));
    if (g.verified) chips.appendChild(h('span.chip.gold', { html: U.icon('check') + '<span>' + U.escapeHtml(t('common.verified')) + '</span>' }));
    var mc = ca.metacritic(g.metacritic); if (mc) chips.appendChild(mc);
    if (g.cheats > 0) chips.appendChild(h('span.chip.gold', { html: U.icon('zap') + '<span>' + U.escapeHtml(t('game2.cheatsChip', { n: g.cheats })) + '</span>' }));
    body.appendChild(chips);
    var acts = h('div.actions');
    var view = h('button.btn.primary.lg', { nav: 'hero-view', html: U.icon('play') + '<span>' + U.escapeHtml(t('discover.viewGame')) + '</span>', data: { hints: 'select' } });
    view.addEventListener('click', function () { XS.router.go('game', { id: g.id }); });
    var fav = h('button.btn.lg.icon-only.fav' + (S.isFav(g.id) ? '.on' : ''), { nav: 'hero-fav', html: U.icon('heart'), 'aria-label': t('game.favorite'), data: { game: g.id } });
    fav.addEventListener('click', function () { XS.actions.toggleFavorite(g.id); });
    acts.appendChild(view); acts.appendChild(fav);
    body.appendChild(acts);
    heroEl.appendChild(body);
    var thumb = h('div.thumb'); thumb.appendChild(ui.cover(g.cover, g.coverFallback, g.title)); heroEl.appendChild(thumb);
    var dots = h('div.dots');
    heroList.forEach(function (_, i) { dots.appendChild(h('i' + (i === heroIdx ? '.on' : ''))); });
    heroEl.appendChild(dots);
    if (focusId) { var again = heroEl.querySelector('[data-nav-id="' + focusId + '"]'); if (again) XS.nav.focus(again, false); }
    /* ambient crossfade: preload the next hero's art so the swap never flashes a placeholder */
    var nxt = heroList[(heroIdx + 1) % heroList.length];
    if (nxt && !ca.safeMode()) { try { var im = new Image(); im.src = nxt.hero || nxt.cover; } catch (e) { /* ignore */ } }
  }
  function startRotation() {
    stopRotation();
    heroTimer = setInterval(function () {
      if (!heroEl || !root.classList.contains('active') || XS.ui.layers.length || ca.screensaver.active()) return;
      if (heroEl.contains(document.activeElement)) return;   /* don't yank a focused hero */
      heroIdx = (heroIdx + 1) % heroList.length;
      paintHero(true);
    }, 8000);
  }
  function stopRotation() { if (heroTimer) clearInterval(heroTimer); heroTimer = null; }

  function jobsByGame() {
    var m = {};
    S.data.queue.jobs.forEach(function (j) { if (!m[j.gameId] || rank(j) < rank(m[j.gameId])) m[j.gameId] = j; });
    return m;
  }
  function rank(j) { return ['downloading', 'connecting', 'verifying', 'installing', 'queued', 'paused', 'failed', 'done', 'installed', 'cancelled'].indexOf(j.state); }
  function jobGame(j) {
    var g = S.game(j.gameId);
    if (g && ca.isGame(g)) return g;
    var syn = { id: j.gameId, title: j.title, platform: j.platform, cover: j.cover, coverFallback: '', releases: [], sizeMax: j.total, _synthetic: true };
    if (g && g.platform === 'HOMEBREW') { for (var k in g) if (k !== 'cover') syn[k] = g[k]; syn._homebrew = true; }
    else if (j.type === 'save-install' || j.type === 'save-download' || j.kind === 'app') syn._homebrew = j.kind === 'app';
    return syn;
  }
  function games(list) { return (list || []).filter(ca.isGame); }

  function rails(container) {
    var L = S.data.lists, jobs = jobsByGame();
    function add(id, title, list, opts) {
      opts = opts || {};
      opts.id = id; opts.jobs = jobs; opts.limit = opts.limit || 20;
      if (!list || !list.length) return;
      var sec = ui.rail(title, list, opts);
      if (sec) container.appendChild(sec);
    }
    var cont = S.data.queue.jobs.filter(function (j) { return ['downloading', 'connecting', 'queued', 'paused', 'verifying', 'installing', 'failed'].indexOf(j.state) >= 0; });
    /* homebrew installs show as app cards (proxied cover, opens the app page); everything else as game cards */
    if (cont.length) add('continue', t('discover.continue'), cont.map(jobGame), { more: function () { XS.router.go('downloads'); }, render: function (g) { return g._homebrew && XS.homebrew ? XS.homebrew.cardFromGame(g, 'rail.continue') : ui.card(g, { job: jobs[g.id], navPrefix: 'rail.continue' }); } });
    add('new', t('discover.newOnXeno'), games(L.newest), { more: function () { XS.router.go('browse', { sort: 'added' }); } });
    /* owner-curated rows from updates/featured.json (§17.1) */
    (featured().rows || []).forEach(function (row, i) {
      var list = (row.ids || []).map(S.game).filter(ca.isGame);
      var title = ca.localized(row.title, '');
      if (list.length && title) add('featured-' + i, title, list);
    });
    add('latest', t('discover.latestReleases'), games(L.latest), { more: function () { XS.router.go('browse', { sort: 'newest' }); } });
    add('trending', t('discover.trending'), games(L.trending), { more: function () { XS.router.go('browse', { sort: 'popular' }); } });
    add('verified', t('discover.verifiedFast'), games(L.verified), { more: function () { XS.router.go('browse', { verified: 1, source: 'archive' }); } });
    var bps = S.data.games.filter(function (g) { return ca.isGame(g) && ca.counts(g).backport > 0; }).sort(function (a, b) { return (b.popularity || 0) - (a.popularity || 0); }).slice(0, 30);
    if (bps.length) add('backports', t('discover2.backports'), bps, { more: function () { XS.router.go('browse', { backports: 1 }); } });
    add('light', t('discover.light'), games(L.light), { more: function () { XS.router.go('browse', { size: 'le10', sort: 'smallest' }); } });
    add('massive', t('discover.massive'), games(L.massive), { more: function () { XS.router.go('browse', { size: 'gt100', sort: 'largest' }); } });
    add('ps4', t('discover.ps4'), games(L.ps4), { more: function () { XS.router.go('browse', { platform: 'PS4' }); } });
    var mcs = S.data.games.filter(function (g) { return ca.isGame(g) && typeof g.metacritic === 'number' && g.metacritic >= 85; }).sort(function (a, b) { return b.metacritic - a.metacritic; }).slice(0, 30);
    if (mcs.length) add('acclaimed', t('discover2.acclaimed'), mcs, { more: function () { XS.router.go('browse', { sort: 'metacritic' }); } });
    var favs = S.data.favorites.map(S.game).filter(ca.isGame);
    if (favs.length) add('favorites', t('discover.yourFavorites'), favs, { more: function () { XS.router.go('browse', { favorites: 1 }); } });
    var recent = S.data.recent.map(S.game).filter(ca.isGame);
    if (recent.length) add('recent', t('discover.recentlyViewed'), recent);
    /* community saves + homebrew essentials: async rails that fill in when the API answers */
    container.appendChild(savesRailHost());
    container.appendChild(homebrewRailHost());
    var genres = S.data.genres.slice(0, 16);
    if (genres.length) {
      var sec = ui.rail(t('discover.popularGenres'), genres, { id: 'genres', total: genres.length, render: function (gn) { return ui.genreTile(gn.name, gn.count); } });
      if (sec) container.appendChild(sec);
    }
  }
  function savesRailHost() {
    var host = h('div', { data: { railHost: 'saves' } });
    if (!XS.saves || !S.data.serverOk) return host;
    XS.saves.newest(12).then(function (list) {
      if (!list.length) return;
      var sec = XS.saves.rail(t('discover2.newSaves'), list, { id: 'saves', more: function () { XS.router.go('saves'); } });
      if (sec && host.isConnected) { U.clear(host); host.appendChild(sec); }
    }, function () { /* offline: no rail */ });
    return host;
  }
  function homebrewRailHost() {
    var host = h('div', { data: { railHost: 'homebrew' } });
    if (!XS.homebrew || !S.data.serverOk) return host;
    XS.homebrew.essentials(12).then(function (apps) {
      if (!apps.length) return;
      var sec = XS.homebrew.rail(t('discover2.homebrewEssentials'), apps, { id: 'hb', more: function () { XS.router.go('homebrew'); } });
      if (sec && host.isConnected) { U.clear(host); host.appendChild(sec); }
    }, function () { /* offline: no rail */ });
    return host;
  }

  function allGames(container) {
    var list = games(S.data.lists.alpha);
    var pages = Math.max(1, Math.ceil(list.length / PAGE));
    page = Math.min(page, pages - 1);
    var sec = h('section.all-games');
    sec.appendChild(h('div.section-head', [h('h2.section-title', [t('discover.allGames'), h('span.count', { text: t('common.nGames', { n: list.length }) })]), h('span.spacer'), h('span.mute', { text: t('common.pageOf', { page: page + 1, pages: pages }) })]));
    gridEl = h('div.vgrid', { data: { navRegion: '' } });
    sec.appendChild(gridEl);
    ui.vgrid(gridEl, list.slice(page * PAGE, page * PAGE + PAGE), root, function (g) { return ui.card(g); });
    sec.appendChild(pager(pages));
    container.appendChild(sec);
  }
  function pager(pages) {
    var p = h('div.pager', { data: { navRegion: '' } });
    function btn(label, target, on, id) {
      var b = h('button.pg' + (on ? '.on' : ''), { nav: 'pg-' + id, text: label });
      if (target === null) b.setAttribute('aria-disabled', 'true');
      b.addEventListener('click', function () { if (target === null) return; page = target; render(); XS.nav.remember('discover', 'pg-' + (target + 1)); XS.nav.restore(); });
      return b;
    }
    p.appendChild(btn(t('common.prev'), page > 0 ? page - 1 : null, false, 'prev'));
    var win = [];
    for (var i = 0; i < pages; i++) if (i < 2 || i >= pages - 2 || Math.abs(i - page) <= 2) win.push(i);
    var last = -1;
    win.forEach(function (i) { if (last >= 0 && i - last > 1) p.appendChild(h('span.mute', { text: '…' })); p.appendChild(btn(String(i + 1), i, i === page, i + 1)); last = i; });
    p.appendChild(btn(t('common.next'), page < pages - 1 ? page + 1 : null, false, 'next'));
    return p;
  }

  /* Full render keeps the user's place: scroll offset and the focused element (by data-nav-id) survive. */
  function render() {
    if (!root) return;
    stopRotation();
    dirty = false;
    featuredChanged();   /* the rendered featured set is now current */
    var scroll = root.scrollTop;
    var fid = root.contains(document.activeElement) ? document.activeElement.getAttribute('data-nav-id') : null;
    U.clear(root);
    var inner = h('div.screen-inner');
    root.appendChild(inner);
    if (!S.data.catalog) {
      inner.appendChild(h('div.hero.skel', { style: { minHeight: '440px', marginTop: '22px' } }));
      inner.appendChild(ui.skeletonRail(8)); inner.appendChild(ui.skeletonRail(8));
      return;
    }
    renderHero(inner);
    var top = h('div.discover-top');
    var req = h('button.btn.ghost', { nav: 'request-game', html: U.icon('plus') + '<span>' + U.escapeHtml(t('game2.requestGame')) + '</span>', title: t('game2.requestSub') });
    req.addEventListener('click', function () { ca.requestGame(''); });
    top.appendChild(req);
    top.appendChild(h('span.spacer'));
    var surprise = h('button.btn', { nav: 'surprise', html: U.icon('shuffle') + '<span>' + U.escapeHtml(t('discover.surpriseMe')) + '</span>' });
    surprise.addEventListener('click', function () { var pool = games(S.data.games); var g = pool[Math.floor(Math.random() * pool.length)]; if (g) XS.router.go('game', { id: g.id }); });
    top.appendChild(surprise);
    inner.appendChild(top);
    rails(inner);
    allGames(inner);
    root.scrollTop = scroll;
    if (fid) { var again = root.querySelector('[data-nav-id="' + fid + '"]'); if (again) XS.nav.focus(again, false); }
  }

  /* Only patch what changed on queue/favorite updates: no full re-render while the user is browsing. */
  function patchFavorites() {
    if (!root) return;
    U.$$('.card[data-game]', root).forEach(function (c) { c.classList.toggle('fav', S.isFav(c.getAttribute('data-game'))); });
    U.$$('.btn.fav[data-game]', root).forEach(function (b) { b.classList.toggle('on', S.isFav(b.getAttribute('data-game'))); });
  }
  var lastContinueKey = '';
  function patchQueue() {
    if (!root || !root.firstChild) return;
    var cont = S.data.queue.jobs.filter(function (j) { return ['downloading', 'connecting', 'queued', 'paused', 'verifying', 'installing', 'failed'].indexOf(j.state) >= 0; });
    var key = cont.map(function (j) { return j.id + ':' + j.state; }).join(',');
    if (key !== lastContinueKey) { lastContinueKey = key; if (root.classList.contains('active')) render(); else dirty = true; return; }
    if (!root.classList.contains('active')) return;
    var m = jobsByGame();
    U.$$('[data-rail="continue"] .card[data-game]', root).forEach(function (c) {
      var j = m[c.getAttribute('data-game')]; if (!j) return;
      var bar = c.querySelector('.prog i'); if (bar && j.total) bar.style.width = U.pct(j.written, j.total).toFixed(1) + '%';
      var sub = c.querySelector('.sub span'); if (sub) sub.textContent = t('dl.state.' + j.state) + (j.total ? ' · ' + U.fmtPct(U.pct(j.written, j.total)) : '');
    });
  }
  var lastFeaturedKey = '';
  function featuredChanged() {
    var key = JSON.stringify(featured().hero || []) + '|' + JSON.stringify((featured().rows || []).map(function (r) { return r.ids; }));
    if (key === lastFeaturedKey) return false;
    lastFeaturedKey = key; return true;
  }

  XS.router.register('discover', {
    tab: true, icon: 'compass', label: function () { return t('nav.discover'); },
    mount: function (el) {
      root = el;
      /* prefetch the next 6 covers of the rail the user walks along (§17.7) */
      el.addEventListener('focusin', function (e) { var card = e.target && e.target.closest ? e.target.closest('.card') : null; if (card && card.parentNode && card.parentNode.classList.contains('rail-track')) ca.prefetchRail(card.parentNode, card); });
      ca.banner();
      ca.screensaver.setup();
    },
    show: function () { if (!root.firstChild || !S.data.catalog || dirty) render(); else { startRotation(); patchFavorites(); } },
    hide: function () { stopRotation(); },
    refresh: render
  });
  S.on('catalog', function () { if (root) { lastContinueKey = ''; render(); if (root.classList.contains('active')) XS.nav.restore(); } });
  S.on('favorites', patchFavorites);
  S.on('queue', patchQueue);
  S.on('recent', function () { dirty = true; });   /* "Recently viewed" refreshes when the user comes back, never under their focus */
  S.on('status', function () { ca.banner(); if (root && S.data.catalog && featuredChanged()) { if (root.classList.contains('active') && !root.contains(document.activeElement)) render(); else dirty = true; } });
})();
