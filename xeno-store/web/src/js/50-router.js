/* XENO STORE — 50-router.js: screens, history (Back = in-app back), tabs, legend, status chips, banners, polling, actions. */
(function () {
  'use strict';
  var XS = window.XS, U = XS.util, S = XS.state, ui = XS.ui, api = XS.api, h = U.h, t = XS.t;
  var R = XS.router;
  R.stack = [];
  R.screens = {};
  R.tabs = [];
  var scrolls = {}, pendingTab = null, polling = { queue: 0, status: 0, catalog: 0 }, prevJobs = {}, bannerEls = {}, dismissedUpdate = U.store.get('dismissedUpdate', '');

  function depth() { return Math.max(0, R.stack.length - 1) + ui.layers.length; }
  function pushHistory() { try { history.pushState({ d: depth() }, ''); } catch (e) { /* ignore */ } }
  function syncHistory() { try { history.replaceState({ d: depth() }, ''); } catch (e) { /* ignore */ } }
  function screenKey(entry) { var d = R.defs[entry.id]; return d && d.key ? d.key(entry.params) : entry.id; }
  R.current = function () { return R.stack[R.stack.length - 1] || { id: 'discover', params: {} }; };

  R.mount = function () {
    var main = U.$('#main');
    R.order.forEach(function (id) {
      var def = R.defs[id];
      var el = h('section.screen', { id: 'scr-' + id, data: { screen: id } });
      main.appendChild(el);
      R.screens[id] = el;
      if (def.mount) def.mount(el);
      if (def.tab) R.tabs.push(id);
    });
    renderTabs(); renderPhonebar(); renderChrome();
    XS.nav.actions = {
      back: function () { R.back(); },
      tabPrev: function () { stepTab(-1); }, tabNext: function () { stepTab(1); },
      search: function () { XS.search.toggle(); },
      favorite: function () { favoriteFocused(); },
      options: function () { if (R.current().id !== 'settings') R.go('settings'); }
    };
    window.addEventListener('popstate', function (e) { reconcile(e.state && typeof e.state.d === 'number' ? e.state.d : 0); });
    window.addEventListener('hashchange', function () { routeHash(false); });
    window.addEventListener('resize', U.debounce(function () { renderChrome(); }, 150));
    window.addEventListener('online', updateBanners); window.addEventListener('offline', updateBanners);
    setInterval(tick, 1000);
  };

  function showScreen(entry, opts) {
    opts = opts || {};
    var cur = U.$('#main .screen.active');
    if (cur) {
      var curEntry = R.current();
      scrolls[screenKey(curEntry)] = cur.scrollTop;
      var curDef = R.defs[cur.getAttribute('data-screen')];
      if (curDef && curDef.hide) curDef.hide();
      cur.classList.remove('active');
    }
    var el = R.screens[entry.id], def = R.defs[entry.id];
    el.classList.add('active');
    XS.nav.key = screenKey(entry);
    if (opts.fresh) XS.nav.forget(XS.nav.key);
    if (def.show) def.show(entry.params || {});
    var saved = scrolls[XS.nav.key];
    if (!opts.fresh && saved !== undefined) el.scrollTop = saved;
    renderTabs(); renderPhonebar(); updateLegend();
    if (XS.search.isOpen()) ui.closeNow(ui.topLayer());
    requestAnimationFrame(function () { if (!ui.layers.length) XS.nav.restore(el); });
  }

  /* go(id, params): tabs replace the base entry; sub-screens (game) push. */
  R.go = function (id, params, opts) {
    params = params || {}; opts = opts || {};
    var def = R.defs[id]; if (!def) return;
    var isTab = !!def.tab || id === 'settings';
    if (isTab) {
      if (depth() > 0 && !opts.noHistory) {
        /* Collapse everything above the base through history so the browser's stack matches ours. */
        pendingTab = { id: id, params: params };
        var d = depth();
        closeAllLayersNow();
        history.go(-d);
        setTimeout(function () { if (pendingTab) { var p = pendingTab; pendingTab = null; R.stack = []; finishTab(p); } }, 350);
        return;
      }
      R.stack = [];
      finishTab({ id: id, params: params });
      return;
    }
    var same = R.current().id === id && JSON.stringify(R.current().params) === JSON.stringify(params);
    if (same) { showScreen(R.current(), { fresh: false }); return; }
    if (!R.stack.length) R.stack.push({ id: 'discover', params: {} });
    R.stack.push({ id: id, params: params });
    pushHistory();
    showScreen(R.current(), { fresh: true });
    setHash();
  };
  function finishTab(p) { R.stack = [{ id: p.id, params: p.params }]; syncHistory(); showScreen(R.current(), { fresh: Object.keys(p.params).length > 0 }); setHash(); }
  function closeAllLayersNow() { while (ui.layers.length) ui.closeNow(ui.layers[ui.layers.length - 1]); }
  function setHash() {
    var e = R.current(); var hsh = e.id === 'game' ? '#game/' + encodeURIComponent(e.params.id) : (e.id === 'discover' ? '' : '#' + e.id);
    try { if (location.hash !== hsh && !(hsh === '' && !location.hash)) history.replaceState({ d: depth() }, '', location.pathname + location.search + hsh); } catch (err) { /* ignore */ }
  }
  function routeHash(initial) {
    var hsh = location.hash || '';
    var m = /^#game\/(.+)$/.exec(hsh);
    if (m) { var id = decodeURIComponent(m[1]); if (R.current().id === 'game' && R.current().params.id === id) return; if (initial) { R.stack = [{ id: 'discover', params: {} }]; syncHistory(); } R.go('game', { id: id }); return; }
    var tab = hsh.replace('#', '');
    if (R.defs[tab] && (R.defs[tab].tab || tab === 'settings')) { if (R.current().id !== tab || initial) R.go(tab, {}, { noHistory: initial }); return; }
    if (initial) R.go('discover', {}, { noHistory: true });
  }
  R.start = function () { syncHistory(); routeHash(true); };

  R.back = function () {
    XS.sound.back();
    if (ui.layers.length) { ui.closeLayer(ui.topLayer()); return true; }
    if (R.stack.length > 1) { history.back(); return true; }
    if (R.current().id !== 'discover') { R.go('discover'); return true; }
    return false;
  };
  function reconcile(target) {
    var guard = 0;
    while (depth() > target && guard++ < 50) {
      if (ui.layers.length) ui.closeNow(ui.topLayer());
      else if (R.stack.length > 1) { R.stack.pop(); showScreen(R.current(), { fresh: false }); setHash(); }
      else break;
    }
    if (depth() < target) syncHistory();
    if (pendingTab && depth() === 0) { var p = pendingTab; pendingTab = null; R.stack = []; finishTab(p); }
  }
  R.layerOpened = function () { pushHistory(); updateLegend(); };
  R.layerClosing = function (handle) {
    var top = ui.topLayer();
    if (handle === top && history.state && history.state.d === depth()) { history.back(); return true; }
    setTimeout(syncHistory, 0);
    return false;
  };
  R.restoreScreenFocus = function (opener) {
    updateLegend();
    var e = R.current(); XS.nav.key = screenKey(e);
    if (opener && opener.isConnected && opener.hasAttribute('data-nav')) { XS.nav.focus(opener, false); return; }
    XS.nav.restore(R.screens[e.id]);
  };
  function stepTab(dir) {
    if (ui.layers.length) return;
    var cur = R.current().id;
    var i = R.tabs.indexOf(cur);
    if (i < 0) { R.go(R.tabs[0]); return; }
    var n = (i + dir + R.tabs.length) % R.tabs.length;
    R.go(R.tabs[n]);
  }
  function favoriteFocused() {
    var el = document.activeElement;
    var g = el && el.closest ? el.closest('[data-game]') : null;
    if (g) { XS.actions.toggleFavorite(g.getAttribute('data-game')); return; }
    var def = R.defs[R.current().id];
    if (def && def.favorite) def.favorite();
  }

  /* ---------- Chrome: tabs, phone bar, legend, status chips, banners ---------- */
  function renderTabs() {
    var box = U.$('#tabs'); U.clear(box);
    var cur = R.current().id;
    R.tabs.forEach(function (id) {
      var def = R.defs[id];
      var a = h('a.tab' + (id === cur ? '.active' : ''), { nav: 'tab:' + id, href: '#' + id, role: 'tab', 'aria-selected': id === cur ? 'true' : 'false' }, [h('span', { text: def.label() })]);
      if (id === 'downloads') a.appendChild(h('span.badge', { 'data-dl-badge': '', hidden: true }));
      a.addEventListener('click', function (e) { e.preventDefault(); R.go(id); });
      box.appendChild(a);
    });
    updateBadge();
  }
  function renderPhonebar() {
    var box = U.$('#phonebar'); U.clear(box);
    var cur = R.current().id;
    var items = [{ id: 'discover', icon: 'compass' }, { id: 'browse', icon: 'grid' }, { id: 'search', icon: 'search' }, { id: 'downloads', icon: 'download' }, { id: 'library', icon: 'library' }];
    items.forEach(function (it) {
      var b = h('button.pb' + (it.id === cur ? '.active' : ''), { nav: 'pb:' + it.id }, [ui.svg(it.icon), h('span', { text: it.id === 'search' ? t('nav.search') : R.defs[it.id].label() })]);
      if (it.id === 'downloads') b.appendChild(h('span.badge', { 'data-dl-badge': '', hidden: true }));
      b.addEventListener('click', function () { if (it.id === 'search') XS.search.toggle(); else R.go(it.id); });
      box.appendChild(b);
    });
    updateBadge();
  }
  function renderChrome() {
    var right = U.$('#topbar-right'); U.clear(right);
    right.appendChild(h('div.status-chips#status-chips'));
    var sb = h('button.iconbtn', { nav: 'top-search', html: U.icon('search'), 'aria-label': t('nav.search'), title: t('nav.search') + ' (△ /)' });
    sb.addEventListener('click', function () { XS.search.toggle(); });
    var st = h('button.iconbtn', { nav: 'top-settings', html: U.icon('settings'), 'aria-label': t('nav.settings'), title: t('nav.settings') });
    st.addEventListener('click', function () { R.go('settings'); });
    right.appendChild(sb); right.appendChild(st);
    updateChips(); updateLegend(); updateBanners();
  }
  function updateChips() {
    var box = U.$('#status-chips'); if (!box) return;
    U.clear(box);
    var st = S.data.status, q = S.data.queue.summary || {};
    if (q.speed > 0) box.appendChild(h('span.schip.speed', { html: U.icon('download') + '<span>' + U.escapeHtml(U.fmtSpeed(q.speed)) + '</span>' }));
    var r = S.defaultRoot();
    if (r) box.appendChild(h('span.schip.free' + (r.free < 20e9 ? '.warn' : ''), { html: U.icon('hdd') + '<span>' + U.escapeHtml(t('status.free', { n: U.fmtBytes(r.free, 0), label: r.label })) + '</span>', title: r.path }));
    if (st && st.ip) box.appendChild(h('span.schip.ip', { html: U.icon('wifi') + '<span>' + U.escapeHtml(st.ip + ':' + st.port) + '</span>', title: t('status.ipHint') }));
    if (!S.data.serverOk) box.appendChild(h('span.schip.bad', { html: U.icon('alert') + '<span>' + U.escapeHtml(t('status.offline')) + '</span>' }));
  }
  function updateBadge() {
    var jobs = S.data.queue.jobs, active = [], w = 0, tot = 0;
    jobs.forEach(function (j) { if (['downloading', 'connecting', 'verifying', 'installing', 'queued'].indexOf(j.state) >= 0) { active.push(j); w += j.written || 0; tot += j.total || 0; } });
    var txt = active.length ? (active.length + (tot ? ' · ' + Math.floor(w / tot * 100) + '%' : '')) : '';
    U.$$('[data-dl-badge]').forEach(function (b) { b.hidden = !txt; b.textContent = txt; b.classList.toggle('pulse', S.data.queue.summary && S.data.queue.summary.speed > 0); });
  }
  var HINTS = { open: ['cross', 'legend.open'], select: ['cross', 'legend.select'], toggle: ['cross', 'legend.toggle'], remove: ['cross', 'legend.remove'], jobmenu: ['cross', 'legend.actions'], fav: ['square', 'legend.favorite'] };
  var legendRaf = null;
  function updateLegend() {
    if (legendRaf) return;
    legendRaf = requestAnimationFrame(function () {
      legendRaf = null;
      var box = U.$('#legend'); if (!box) return;
      U.clear(box);
      if (S.data.settings && S.data.settings.general && S.data.settings.general.hints === false) { box.style.display = 'none'; return; }
      box.style.display = '';
      var el = document.activeElement, items = [], seen = {};
      var hs = el && el.getAttribute ? (el.getAttribute('data-hints') || '') : '';
      if (el && el.closest && el.closest('[data-game]') && hs.indexOf('fav') < 0) hs += ' fav';
      hs.split(/\s+/).forEach(function (k) { if (HINTS[k] && !seen[k]) { seen[k] = 1; items.push(HINTS[k]); } });
      if (!seen.open && !seen.select && !seen.toggle && !seen.remove && !seen.jobmenu) items.unshift(HINTS.select);
      if (ui.layers.length) items.push(['circle', 'legend.close']);
      else { if (R.stack.length > 1) items.push(['circle', 'legend.back']); items.push(['triangle', 'legend.search']); items.push(['L1R1', 'legend.tabs']); items.push(['options', 'legend.settings']); }
      items.forEach(function (it) {
        var g = it[0] === 'L1R1' ? U.glyph('L1') + U.glyph('R1') : U.glyph(it[0]);
        box.appendChild(h('span.hint', { html: g + '<span>' + U.escapeHtml(t(it[1])) + '</span>' }));
      });
      box.appendChild(h('span.spacer'));
      box.appendChild(h('span.ver', { text: 'XENO STORE ' + ((S.data.status && S.data.status.version) || XS.version) }));
    });
  }
  R.onFocus = function () { updateLegend(); };
  function banner(id, cls, text, action) {
    var box = U.$('#banners');
    if (bannerEls[id]) { var tx = bannerEls[id].querySelector('.tx'); if (tx.textContent !== text) tx.textContent = text; return; }
    var b = h('div.banner.' + cls, [h('span.dot'), h('span.tx', { text: text }), h('span.spacer')]);
    if (action) { var ab = h('button.btn.sm' + (action.primary ? '.primary' : ''), { nav: 'banner-' + id, text: action.label }); ab.addEventListener('click', action.onClick); b.appendChild(ab); }
    box.appendChild(b); bannerEls[id] = b;
  }
  function unbanner(id) { if (bannerEls[id]) { if (bannerEls[id].parentNode) bannerEls[id].parentNode.removeChild(bannerEls[id]); delete bannerEls[id]; } }
  function updateBanners() {
    var st = S.data.status;
    if (!S.data.serverOk) banner('server', 'bad', t('banner.serverDown'), { label: t('common.retry'), onClick: function () { XS.actions.reloadAll(); } }); else unbanner('server');
    if (S.data.serverOk && st && st.downloadsAvailable === false) banner('nodl', 'warn', t('banner.downloadsUnavailable', { fw: st.fw || '' })); else unbanner('nodl');
    if (navigator.onLine === false || (S.data.catalogCached && S.data.serverOk)) banner('offline', 'warn', t('banner.offline')); else unbanner('offline');
    if (st && st.update && st.update.available && dismissedUpdate !== st.update.latest) banner('update', 'info', t('banner.update', { v: st.update.latest }), { label: t('banner.updateAction'), primary: true, onClick: function () { dismissedUpdate = st.update.latest; U.store.set('dismissedUpdate', dismissedUpdate); unbanner('update'); R.go('settings', { group: 'updates' }); } }); else if (!(st && st.update && st.update.available)) unbanner('update');
    if (st && st.notices && st.notices.length) { var n = st.notices[0]; if (U.store.get('notice.' + n.id, false) !== true) banner('notice', 'info', n.text, { label: t('common.dismiss'), onClick: function () { U.store.set('notice.' + n.id, true); unbanner('notice'); } }); }
    updateChips();
  }

  /* ---------- Polling ---------- */
  function hasActive() { return S.data.queue.jobs.some(function (j) { return ['downloading', 'connecting', 'verifying', 'installing', 'queued'].indexOf(j.state) >= 0; }); }
  function scheduleQueue() {
    clearTimeout(polling.queue);
    var fast = R.current().id === 'downloads' || hasActive();
    polling.queue = setTimeout(function () { XS.actions.refreshQueue().then(scheduleQueue, scheduleQueue); }, fast ? 1000 : 5000);
  }
  function scheduleStatus() {
    clearTimeout(polling.status);
    polling.status = setTimeout(function () { XS.actions.refreshStatus().then(scheduleStatus, scheduleStatus); }, 10000);
  }
  function scheduleCatalog() {
    clearTimeout(polling.catalog);
    polling.catalog = setTimeout(function () { XS.actions.reloadCatalog(true).then(scheduleCatalog, scheduleCatalog); }, 5 * 60 * 1000);
  }
  R.startPolling = function () { scheduleQueue(); scheduleStatus(); scheduleCatalog(); };
  function tick() {
    var def = R.defs[R.current().id];
    if (def && def.tick) def.tick();
  }

  /* ---------- Actions shared by screens ---------- */
  var A = XS.actions = {};
  A.refreshQueue = function (force) {
    return api.queue(true).then(function (r) {
      var jobs = r.jobs || [];
      detectTransitions(jobs);
      S.set('queue', { jobs: jobs, summary: r.summary || {} });
      updateBadge(); updateChips();
      return r;
    }, function (err) { updateChips(); updateBanners(); throw err; });
  };
  function detectTransitions(jobs) {
    var ntf = (S.data.settings && S.data.settings.notifications) || {};
    var next = {};
    jobs.forEach(function (j) {
      next[j.id] = j.state;
      var was = prevJobs[j.id];
      if (!was || was === j.state) return;
      if (j.state === 'done' && ntf.onComplete !== false) { XS.sound.done(); ui.toast({ cls: 'good', title: t('toast.done', { title: j.title }), desc: U.fmtBytes(j.total), cover: j.cover, action: { label: t('game.viewDownloads'), onClick: function () { R.go('downloads', { tab: 'finished' }); } } }); }
      else if (j.state === 'installed' && ntf.onInstall !== false) { XS.sound.done(); ui.toast({ cls: 'good', title: t('toast.installed', { title: j.title }), cover: j.cover }); }
      else if (j.state === 'failed' && ntf.onFail !== false) { XS.sound.error(); ui.toast({ cls: 'bad', title: t('toast.failed', { title: j.title }), desc: ui.errorText(j), cover: j.cover, timeout: 8000, action: { label: t('dl.action.retry'), onClick: function () { A.jobAction(j, 'retry'); } } }); }
    });
    prevJobs = next;
  }
  A.refreshStatus = function () {
    return api.status().then(function (st) { S.set('status', st); if (st.storage && st.storage.length) S.set('storage', st.storage); updateBanners(); updateChips(); return st; }, function (err) { updateBanners(); throw err; });
  };
  A.reloadCatalog = function (quiet) {
    return api.loadCatalog().then(function (r) {
      if (r.unchanged) return r;
      S.data.catalogCached = !!r.cached;
      S.setCatalog(r.catalog);
      updateBanners();
      if (!quiet && !r.cached) ui.toast({ cls: 'good', title: t('toast.catalogLoaded', { n: (r.catalog.games || []).length }) });
      return r;
    }, function (err) { if (!quiet) ui.errorToast(err, t('err.catalogTitle')); throw err; });
  };
  A.reloadAll = function () {
    return Promise.all([
      api.settings().then(function (s) { S.set('settings', s); A.applySettings(s); }, function () { /* keep defaults */ }),
      api.favorites().then(function (r) { S.set('favorites', r.ids || []); }, function () { /* ignore */ }),
      api.collections().then(function (r) { S.set('collections', r.collections || []); }, function () { /* ignore */ }),
      api.recent().then(function (r) { S.set('recent', r.ids || []); }, function () { /* ignore */ }),
      api.storage().then(function (r) { S.set('storage', r.roots || []); }, function () { /* ignore */ }),
      A.refreshStatus().then(null, function () { /* banner shows it */ }),
      A.refreshQueue().then(null, function () { /* ignore */ })
    ]).then(function () { var def = R.defs[R.current().id]; if (def && def.refresh) def.refresh(); updateBanners(); });
  };
  A.applySettings = function (s) {
    var g = (s && s.general) || {};
    var html = document.documentElement;
    html.setAttribute('data-theme', g.theme || 'xeno-gold');
    html.setAttribute('data-cards', g.cardSize || 'm');
    if (g.reduceMotion) html.setAttribute('data-motion', 'reduce'); else html.removeAttribute('data-motion');
    XS.sound.setEnabled(g.sounds !== false);
    var want = XS.i18n.resolve(g.language || 'auto');
    if (want !== XS.i18n.locale) { XS.i18n.setLocale(g.language || 'auto'); if (R.tabs.length) { renderTabs(); renderPhonebar(); renderChrome(); var def = R.defs[R.current().id]; if (def && def.refresh) def.refresh(); else if (def && def.show) def.show(R.current().params); } }
    updateLegend();
  };
  A.toggleFavorite = function (id) {
    var was = S.isFav(id);
    var ids = S.data.favorites.filter(function (x) { return x !== id; });
    if (!was) ids.push(id);
    S.set('favorites', ids);
    XS.sound.select();
    var g = S.game(id);
    ui.toast({ cls: was ? '' : 'gold', icon: 'heart', title: was ? t('toast.unfavorited') : t('toast.favorited'), desc: g ? g.title : '', timeout: 2000 });
    api.favoriteToggle(id).then(function (r) {
      if (typeof r.favorite === 'boolean' && r.favorite === was) { var fixed = S.data.favorites.filter(function (x) { return x !== id; }); if (r.favorite) fixed.push(id); S.set('favorites', fixed); }
    }, function (err) { S.set('favorites', S.data.favorites.filter(function (x) { return x !== id; }).concat(was ? [id] : [])); ui.errorToast(err, t('game.favorite')); });
  };
  A.collectionMenu = function (anchor, gameId) {
    var cols = S.data.collections || [];
    var items = cols.map(function (c) {
      var has = (c.ids || []).indexOf(gameId) >= 0;
      return { label: c.name, sub: t('common.nGames', { n: (c.ids || []).length }), icon: c.icon === 'star' ? 'star' : 'folder', checked: has, onSelect: function () {
        c.ids = has ? c.ids.filter(function (x) { return x !== gameId; }) : (c.ids || []).concat([gameId]);
        api.collectionsPut(cols).then(function (r) { S.set('collections', r.collections || cols); ui.toast({ cls: 'good', title: has ? t('toast.removedFrom', { name: c.name }) : t('toast.addedTo', { name: c.name }) }); }, ui.errorToast);
      } };
    });
    items.push('sep');
    items.push({ label: t('game.newCollection'), icon: 'plus', onSelect: function () {
      ui.prompt(t('game.newCollection'), { label: t('game.collectionName'), placeholder: t('game.collectionPlaceholder') }).then(function (name) {
        if (!name || !name.trim()) return;
        var c = { id: 'c_' + Date.now().toString(36), name: name.trim(), icon: 'folder', ids: [gameId] };
        var list = cols.concat([c]);
        api.collectionsPut(list).then(function (r) { S.set('collections', r.collections || list); ui.toast({ cls: 'good', title: t('toast.addedTo', { name: c.name }) }); }, ui.errorToast);
      });
    } });
    ui.menu(anchor, items, { title: t('game.collection') });
  };
  A.jobAction = function (job, action) {
    function run(a, body) { return api.queueAction(job.id, a, body).then(function () { A.refreshQueue(); }, function (err) { ui.errorToast(err, t('dl.action.' + action)); }); }
    switch (action) {
      case 'pause': case 'resume': case 'retry': case 'install': case 'verify': return run(action);
      case 'cancel': return ui.confirm(t('dl.cancelTitle'), t('dl.cancelText', { title: job.title }), t('dl.action.cancel'), true).then(function (ok) { if (ok) run('cancel'); });
      case 'restart': return ui.confirm(t('dl.restartTitle'), t('dl.restartText', { n: U.fmtBytes(job.written) }), t('dl.action.restart'), true).then(function (ok) { if (ok) run('restart'); });
      case 'remove': return run('remove');
      case 'delete': return ui.confirm(t('dl.deleteTitle'), t('dl.deleteText', { title: job.title }), t('dl.action.delete'), true).then(function (ok) { if (ok) run('remove', { deleteFiles: true }); });
      case 'up': case 'down': case 'top': case 'bottom': return run('move', { direction: action });
      case 'url': return ui.prompt(t('dl.changeLink'), { label: t('dl.enterLinkLabel'), value: job.url, text: t('dl.changeLinkText') }).then(function (v) { if (v === null) return; v = v.trim(); if (!/^https?:\/\//i.test(v)) { ui.toast({ cls: 'bad', title: t('err.bad_url') }); return; } api.queueUrl(job.id, v).then(function () { ui.toast({ cls: 'good', title: t('toast.linkUpdated') }); A.refreshQueue(); }, function (err) { ui.errorToast(err, t('dl.changeLink')); }); });
      case 'open': return R.go('library');
      case 'log': return api.queueLog(job.id).then(function (r) {
        var box = h('div.logbox', { nav: 'joblog', style: { height: '60vh' } });
        (r.lines || []).forEach(function (l) { box.appendChild(h('div' + (/error|fail/i.test(l) ? '.e' : /warn/i.test(l) ? '.w' : ''), { text: l })); });
        if (!(r.lines || []).length) box.textContent = t('diag.logEmpty');
        var hd = ui.sheet({ title: t('dl.action.log'), sub: job.title, body: [box], foot: [h('span.spacer'), h('button.btn.primary', { nav: 'joblog-close', text: t('common.close'), on: { click: function () { ui.closeLayer(hd); } } })] });
      }, ui.errorToast);
    }
  };

  S.on('queue', function () { updateBadge(); updateChips(); });
  S.on('status', updateBanners);
  S.on('serverOk', updateBanners);
  S.on('storage', updateChips);
})();
