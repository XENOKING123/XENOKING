/* XENO STORE — 47-saves.js: PS5 Save Data Store UI (§17.22): the game page "Saves (n)" tab, the Community Saves
   screen (id "saves"), save detail sheet, Install / Download / Report flows and the Upload-my-save wizard.
   Uses /api/saves/* exactly as SPEC §17.22.7; the re-sign engine tier is shown honestly (native / garlic / raw). */
(function () {
  'use strict';
  var XS = window.XS, U = XS.util, S = XS.state, ui = XS.ui, ca = XS.ca, h = U.h, t = XS.t;
  var root = null;
  var CATS = ['starter', 'platinum', 'checkpoint', 'modded', 'chapter', 'other'];
  var SORTS = ['newest', 'popular', 'version'];
  var cache = { all: null, allAt: 0, byGame: {}, engine: null, engineAt: 0, users: null };
  var scr = { q: '', cat: '', sort: 'newest', compatOnly: false };

  /* ---------- data ---------- */
  function normalize(sv) {
    var s = {};
    for (var k in sv) s[k] = sv[k];
    s.id = String(s.id || '');
    s.category = CATS.indexOf(s.category) >= 0 ? s.category : inferCategory((s.name || '') + ' ' + (s.description || '') + ' ' + (s.notes || '') + ' ' + (s.tags || []).join(' '));
    s.name = s.name || s.file_name || s.game || t('saves.untitled');
    s.title = s.title || s.game || (S.data.byTitleId[s.titleId] ? S.data.byTitleId[s.titleId].title : s.titleId || '');
    s.author = s.author || s.shared_by || '';
    s.gameVersion = s.gameVersion || s.game_version || '';
    s.createdAt = s.createdAt || s.created_at || '';
    s.downloads = Number(s.downloads) || 0;
    s.size = Number(s.size || s.file_size) || 0;
    s.tags = Array.isArray(s.tags) ? s.tags : [];
    s.compat = s.compat && typeof s.compat === 'object' ? s.compat : { status: 'unknown' };
    if (!s.compat.status) s.compat.status = 'unknown';
    var g = s.gameId ? S.game(s.gameId) : (s.titleId ? S.data.byTitleId[s.titleId] : null);
    s._game = g || null;
    if (!s.cover && !s.cover_path && g) s._coverFallback = g.cover;
    return s;
  }
  function inferCategory(text) {
    var x = String(text || '').toLowerCase();
    if (/100\s*%|platinum|all trophies/.test(x)) return 'platinum';
    if (/\b(start|starter|ng\+|new game\+|max|maxed|unlocked)\b/.test(x)) return 'starter';
    if (/\b(trophy|boss|checkpoint)\b/.test(x)) return 'checkpoint';
    if (/\b(mod|modded|glitch|glitched|hack)\b/.test(x)) return 'modded';
    if (/\b(chapter|act|mission|level)\b/.test(x)) return 'chapter';
    return 'other';
  }
  function fetchAll(force) {
    if (!force && cache.all && Date.now() - cache.allAt < 120000) return Promise.resolve(cache.all);
    return ca.api.savesStore({}).then(function (r) { cache.all = (r.saves || []).map(normalize); cache.allAt = Date.now(); return cache.all; });
  }
  function fetchGame(g, force) {
    var key = g.id;
    var c = cache.byGame[key];
    if (!force && c && Date.now() - c.at < 120000) return Promise.resolve(c.list);
    var tid = (g.titleIds || [])[0] || '';
    return ca.api.savesStore(tid ? { titleId: tid, gameId: g.id } : { gameId: g.id }).then(function (r) {
      var list = (r.saves || []).map(normalize);
      cache.byGame[key] = { list: list, at: Date.now() };
      return list;
    });
  }
  function engine() {
    if (cache.engine && Date.now() - cache.engineAt < 300000) return Promise.resolve(cache.engine);
    var st = S.data.status;
    if (st && st.savesEngine && st.savesEngine.tier) { cache.engine = st.savesEngine; cache.engineAt = Date.now(); return Promise.resolve(cache.engine); }
    return ca.api.savesEngine().then(function (r) { cache.engine = { tier: r.tier || 'raw', detail: r.detail || '' }; cache.engineAt = Date.now(); return cache.engine; }, function () { return { tier: 'unknown', detail: '' }; });
  }
  function tierText(tier) { return t('saves.tier.' + (['native', 'garlic', 'raw'].indexOf(tier) >= 0 ? tier : 'unknown')); }
  function tierHint(tier) { return t('saves.tierHint.' + (['native', 'garlic', 'raw'].indexOf(tier) >= 0 ? tier : 'unknown')); }
  function enginePill(e) {
    var tier = e ? e.tier : 'unknown';
    var cls = tier === 'native' ? '.good' : tier === 'garlic' ? '.acc' : tier === 'raw' ? '.warn' : '';
    return h('span.chip.engine' + cls, { title: tierHint(tier) + (e && e.detail ? ' · ' + e.detail : '') }, [ui.svg('shield'), h('span', { text: t('saves.engine', { tier: tierText(tier) }) })]);
  }
  function users() {
    if (cache.users) return Promise.resolve(cache.users);
    return ca.api.savesUsers().then(function (r) { cache.users = r.users || []; return cache.users; });
  }
  function compatible(s) { return s.compat.status === 'ok' || s.compat.status === 'newer'; }

  /* ---------- widgets ---------- */
  function compatBadge(s, long) {
    var c = s.compat || {}, st = c.status || 'unknown';
    var cls = st === 'ok' || st === 'newer' ? '.good' : st === 'update' || st === 'region' ? '.warn' : st === 'notInstalled' ? '.bad' : '';
    var icon = st === 'ok' || st === 'newer' ? 'check' : st === 'notInstalled' ? 'x' : st === 'unknown' ? 'info' : 'alert';
    if (long) return h('div.compat-line' + cls, [ui.svg(icon), h('span', { text: compatText(s) })]);
    var text = t('saves.compat.short.' + (['ok', 'newer', 'update', 'region', 'notInstalled', 'unknown'].indexOf(st) >= 0 ? st : 'unknown'));
    return h('span.chip.sm.compat' + cls, { title: compatText(s) }, [ui.svg(icon), h('span', { text: text })]);
  }
  function compatText(s) {
    var c = s.compat || {}, st = c.status || 'unknown';
    if (c.message) return c.message;
    if (st === 'ok') return t('saves.compat.ok', { v: c.installedVersion || s.gameVersion || '' });
    if (st === 'newer') return t('saves.compat.newer', { v: s.gameVersion || '', mine: c.installedVersion || '' });
    if (st === 'update') return t('saves.compat.update', { v: s.gameVersion || '', mine: c.installedVersion || '' });
    if (st === 'region') return t('saves.compat.region', { tid: s.titleId || '' });
    if (st === 'notInstalled') return t('saves.compat.notInstalled');
    return t('saves.compat.unknown');
  }
  function coverEl(s) { return ui.cover(ca.api.imageUrl(s.cover || s.cover_path || s.screenshot || ''), s._coverFallback || '', s.title); }
  function catChip(cat) { return h('span.chip.sm.cat.' + cat, { text: t('saves.cat.' + cat) }); }
  function metaLine(s) {
    var parts = [];
    if (s.author) parts.push(t('saves.by', { name: s.author }));
    if (s.createdAt) parts.push(U.fmtDate(s.createdAt));
    if (s.size) parts.push(U.fmtBytes(s.size));
    if (s.downloads) parts.push(t('saves.nDownloads', { n: s.downloads }));
    if (s.gameVersion) parts.push('v' + s.gameVersion);
    if (s.region) parts.push(s.region);
    return parts.join(' · ');
  }
  /* Vertical card for rails / grids */
  function card(s, prefix) {
    var c = h('button.save-card', { nav: (prefix || 'sv') + ':' + s.id, data: { hints: 'open', save: s.id } });
    c.appendChild(coverEl(s));
    c.appendChild(h('div.t.clamp2', { text: s.name }));
    c.appendChild(h('div.g.ellipsis', { text: s.title }));
    var row = h('div.row2', [catChip(s.category), compatBadge(s)]);
    c.appendChild(row);
    c.addEventListener('click', function () { openSave(s); });
    return c;
  }
  /* Horizontal row for the game tab */
  function rowCard(s, i) {
    var r = h('div.save-row', { data: { save: s.id } });
    var open = h('button.save-open', { nav: 'svr-' + i, data: { hints: 'open' } });
    open.appendChild(coverEl(s));
    var main = h('div.main');
    main.appendChild(h('div.l1', [h('span.name.ellipsis', { text: s.name }), catChip(s.category), compatBadge(s)]));
    if (s.description) main.appendChild(h('div.desc.clamp2', { text: s.description }));
    main.appendChild(h('div.meta', { text: metaLine(s) }));
    open.appendChild(main);
    open.addEventListener('click', function () { openSave(s); });
    r.appendChild(open);
    var acts = h('div.acts');
    var inst = h('button.btn.sm.primary', { nav: 'svi-' + i, html: U.icon('download') + '<span>' + U.escapeHtml(t('saves.install')) + '</span>' });
    inst.addEventListener('click', function () { installSheet(s); });
    var dl = h('button.btn.sm', { nav: 'svd-' + i, html: U.icon('folder') + '<span>' + U.escapeHtml(t('saves.downloadFile')) + '</span>' });
    dl.addEventListener('click', function () { downloadFile(s); });
    var rep = h('button.btn.sm.ghost.icon-only', { nav: 'svp-' + i, html: U.icon('alert'), 'aria-label': t('saves.report'), title: t('saves.report') });
    rep.addEventListener('click', function () { report(s); });
    acts.appendChild(inst); acts.appendChild(dl); acts.appendChild(rep);
    r.appendChild(acts);
    return r;
  }
  function rail(title, list, opts) {
    opts = opts || {};
    if (!list || !list.length) return null;
    var sec = h('section.rail', { data: { rail: opts.id || 'saves' } });
    var head = h('div.section-head', [h('h2.section-title', [title, h('span.count', { text: t('saves.nSaves', { n: list.length }) })])]);
    if (opts.more) { head.appendChild(h('span.spacer')); head.appendChild(h('button.btn.ghost.sm', { nav: 'more:' + (opts.id || 'saves'), text: t('common.seeAll'), on: { click: opts.more } })); }
    sec.appendChild(head);
    var track = h('div.rail-track', { data: { navRegion: '' } });
    list.forEach(function (s) { track.appendChild(card(s, 'rail-' + (opts.id || 'saves'))); });
    sec.appendChild(track);
    return sec;
  }
  function catChips(cur, onPick, prefix) {
    var wrap = h('div.chips.cat-chips', { data: { navRegion: '' } });
    [''].concat(CATS).forEach(function (c) {
      var b = h('button.chip' + (cur === c ? '.on' : ''), { nav: (prefix || 'cat') + '-' + (c || 'all'), text: c ? t('saves.cat.' + c) : t('filter.all'), 'aria-pressed': cur === c ? 'true' : 'false' });
      b.addEventListener('click', function () { onPick(c); });
      wrap.appendChild(b);
    });
    return wrap;
  }

  /* ---------- Game page tab ---------- */
  function renderGameTab(container, g, opts) {
    opts = opts || {};
    U.clear(container);
    var state = { cat: '', showAll: false, list: null, eng: null };
    var head = h('div.sv-head');
    var pill = h('span', { 'data-engine': '' }); head.appendChild(pill);
    head.appendChild(h('span.spacer'));
    var up = h('button.btn', { nav: 'sv-upload-game', html: U.icon('upload') + '<span>' + U.escapeHtml(t('saves.uploadMine')) + '</span>' });
    up.addEventListener('click', function () { uploadWizard({ titleId: (g.titleIds || [])[0] || '', gameId: g.id }); });
    head.appendChild(up);
    container.appendChild(head);
    var chipsHost = h('div'); container.appendChild(chipsHost);
    var listHost = h('div.sv-list', { data: { navRegion: '' } }); container.appendChild(listHost);
    listHost.appendChild(ca.busyRow(t('saves.loading')));
    engine().then(function (e) { state.eng = e; var fresh = enginePill(e); if (pill.parentNode) pill.parentNode.replaceChild(fresh, pill); pill = fresh; });
    function paintChips() { U.clear(chipsHost); chipsHost.appendChild(catChips(state.cat, function (c) { state.cat = c; paintChips(); paintList(); }, 'svcat')); }
    function paintList() {
      U.clear(listHost);
      var all = state.list || [];
      var mine = all.filter(function (s) { return !g.titleIds || !g.titleIds.length || g.titleIds.indexOf(s.titleId) >= 0 || !s.titleId; });
      var others = all.filter(function (s) { return mine.indexOf(s) < 0; });
      var filtered = state.cat ? mine.filter(function (s) { return s.category === state.cat; }) : mine;
      var anyCompat = mine.some(compatible);
      var hidden = 0;
      var shown = filtered.filter(function (s) { if (state.showAll || !anyCompat || compatible(s)) return true; hidden++; return false; });
      if (!all.length) {
        listHost.appendChild(ui.emptyState(t('saves.emptyGameTitle'), t('saves.emptyGameHint'), [h('button.btn.primary', { nav: 'sv-upload-first', html: U.icon('upload') + '<span>' + U.escapeHtml(t('saves.uploadMine')) + '</span>', on: { click: function () { uploadWizard({ titleId: (g.titleIds || [])[0] || '', gameId: g.id }); } } })]));
        return;
      }
      if (!anyCompat && mine.length) listHost.appendChild(h('div.panel.note', [h('div.row', [ui.svg('info'), h('span.dim', { text: mine.some(function (s) { return s.compat.status === 'notInstalled'; }) ? t('saves.noteNotInstalled') : mine.some(function (s) { return s.compat.status === 'update'; }) ? t('saves.noteUpdate') : t('saves.noteUnknown') })])]));
      if (!shown.length && filtered.length) listHost.appendChild(h('div.panel.note', [h('span.dim', { text: t('saves.allHidden', { n: filtered.length }) })]));
      shown.forEach(function (s, i) { listHost.appendChild(rowCard(s, i)); });
      if (hidden > 0 || state.showAll) {
        var tg = h('button.btn.ghost.sm', { nav: 'sv-showall', text: state.showAll ? t('saves.hideIncompatible') : t('saves.showAll', { n: hidden }) });
        tg.addEventListener('click', function () { state.showAll = !state.showAll; paintList(); ca.focusIn(listHost, 'sv-showall'); });
        listHost.appendChild(h('div.sv-foot', [tg]));
      }
      if (others.length) {
        listHost.appendChild(h('div.section-head', [h('h3.section-title', [t('saves.otherRegions'), h('span.count', { text: t('saves.nSaves', { n: others.length }) })])]));
        listHost.appendChild(h('div.panel.note.warn', [h('div.row', [ui.svg('alert'), h('span', { text: t('saves.otherRegionsWarn') })])]));
        others.forEach(function (s, i) { listHost.appendChild(rowCard(s, 100 + i)); });
      }
    }
    fetchGame(g).then(function (list) { state.list = list; if (opts.onCount) opts.onCount(list.length); paintChips(); paintList(); }, function (err) { U.clear(listHost); listHost.appendChild(ui.emptyState(t('saves.loadFailed'), ui.errorText(err), [h('button.btn', { nav: 'sv-retry', text: t('common.retry'), on: { click: function () { renderGameTab(container, g, opts); } } })])); });
  }

  /* ---------- Save detail sheet ---------- */
  function openSave(s) {
    var handle = ui.sheet({
      title: s.name, sub: s.title + (s.titleId ? ' · ' + s.titleId : ''), key: 'save:' + s.id,
      body: function (body) {
        var hero = h('div.cover-hero'); hero.appendChild(coverEl(s));
        hero.appendChild(h('div.grow', [h('div.chips', [catChip(s.category), s.region ? h('span.chip.sm', { text: s.region }) : null, s.gameVersion ? h('span.chip.sm', { text: 'v' + s.gameVersion }) : null, s.source === 'garlic' || s.garlic_id ? h('span.chip.sm.acc', { text: t('saves.fromGarlic') }) : null]), h('div.meta', { text: metaLine(s) })]));
        body.appendChild(hero);
        if (s.description) body.appendChild(h('p.sv-desc', { text: s.description }));
        if (s.tags.length) body.appendChild(h('div.chips', s.tags.map(function (x) { return h('span.chip.sm', { text: '#' + x }); })));
        body.appendChild(h('h3', { text: t('saves.compatibility') }));
        var cp = h('div.panel.compat-panel', [h('div.row', [compatBadge(s, true)])]);
        if (s.compat.status === 'update' && s._game) { var ub = h('button.btn.sm', { nav: 'sv-update-game', html: U.icon('refresh') + '<span>' + U.escapeHtml(t('saves.openUpdates')) + '</span>' }); ub.addEventListener('click', function () { ui.closeLayer(handle); if (XS.gamePage) XS.gamePage.openOptions(s._game); }); cp.appendChild(h('div', { style: { marginTop: '10px' } }, [ub])); }
        if (s.compat.status === 'region') cp.appendChild(h('p.dim.small', { text: t('saves.otherRegionsWarn') }));
        body.appendChild(cp);
        body.appendChild(h('h3', { text: t('saves.engineTitle') }));
        var eng = h('div.panel', [h('div.row', [h('span', { 'data-engine': '' })])]);
        body.appendChild(eng);
        engine().then(function (e) { var ph = eng.querySelector('[data-engine]'); if (ph) { ph.parentNode.replaceChild(enginePill(e), ph); eng.appendChild(h('p.dim.small', { text: tierHint(e.tier) })); } });
        var kv = h('dl.kv');
        function add(k, v) { if (!v) return; kv.appendChild(h('dt', { text: k })); kv.appendChild(h('dd', { text: v })); }
        add(t('saves.fileSize'), s.size ? U.fmtBytes(s.size) : '');
        add(t('saves.dirName'), s.dirName || '');
        add(t('saves.sha256'), s.sha256 ? String(s.sha256).slice(0, 16) + '…' : '');
        add(t('saves.format'), s.format || (s.garlic_id ? 'garlic-zip' : ''));
        body.appendChild(h('h3', { text: t('saves.details') }));
        body.appendChild(h('div.panel', [kv]));
        if (s._game) { var gb = h('button.lrow', { nav: 'sv-game', data: { hints: 'open' } }); gb.appendChild(ui.cover(s._game.cover, s._game.coverFallback, s._game.title)); gb.appendChild(h('div.main', [h('div.name', { text: s._game.title }), h('div.desc', { text: t('saves.openGame') })])); gb.appendChild(h('span.val', { html: U.icon('chevR') })); gb.addEventListener('click', function () { ui.closeLayer(handle); XS.router.go('game', { id: s._game.id }); }); body.appendChild(h('div', { style: { marginTop: '12px' } }, [gb])); }
      },
      foot: [
        h('button.btn.ghost', { nav: 'sv-report', html: U.icon('alert') + '<span>' + U.escapeHtml(t('saves.report')) + '</span>', on: { click: function () { report(s); } } }),
        h('button.btn', { nav: 'sv-download', html: U.icon('folder') + '<span>' + U.escapeHtml(t('saves.downloadFile')) + '</span>', on: { click: function () { downloadFile(s); } } }),
        h('span.spacer'),
        h('button.btn.primary.lg', { nav: 'sv-install', 'data-autofocus': '', html: U.icon('download') + '<span>' + U.escapeHtml(t('saves.install')) + '</span>', on: { click: function () { installSheet(s); } } })
      ]
    });
    return handle;
  }

  /* ---------- Install to my saves (§17.22.4) ---------- */
  function installSheet(s) {
    var st = { user: null, backupFirst: !(S.data.settings && S.data.settings.saves && S.data.settings.saves.autoBackup === false) };
    var handle = ui.sheet({
      title: t('saves.installTitle'), sub: s.name, key: 'svinstall:' + s.id, cls: 'narrow',
      body: function (body) {
        body.appendChild(h('div.panel.compat-panel', [h('div.row', [compatBadge(s, true)])]));
        if (s.compat.status === 'notInstalled') body.appendChild(h('div.panel.note.warn', [h('div.row', [ui.svg('alert'), h('span', { text: t('saves.installNotInstalled') })])]));
        else if (s.compat.status === 'update') body.appendChild(h('div.panel.note.warn', [h('div.row', [ui.svg('alert'), h('span', { text: t('saves.installUpdateFirst') })])]));
        else if (s.compat.status === 'region') body.appendChild(h('div.panel.note.warn', [h('div.row', [ui.svg('alert'), h('span', { text: t('saves.otherRegionsWarn') })])]));
        body.appendChild(h('h3', { text: t('saves.profile') }));
        var ul = h('div.list', { 'data-users': '' });
        ul.appendChild(ca.busyRow(t('saves.loadingUsers')));
        body.appendChild(ul);
        users().then(function (list) {
          U.clear(ul);
          if (!list.length) { ul.appendChild(h('div.panel', [h('span.dim', { text: t('saves.noUsers') })])); return; }
          list.forEach(function (u, i) {
            if (!st.user && (u.foreground || i === 0)) st.user = u;
            var sel = st.user === u;
            var row = h('button.lrow' + (sel ? '.sel' : ''), { nav: 'svu-' + i, data: { hints: 'select' } });
            row.appendChild(h('span.ic', { html: U.icon('gamepad') }));
            row.appendChild(h('div.main', [h('div.name', { text: u.name || String(u.id) }), h('div.desc', { text: (u.foreground ? t('saves.foregroundUser') + ' · ' : '') + 'id ' + u.id })]));
            row.appendChild(h('span.check', { html: sel ? U.icon('check') : '' }));
            row.addEventListener('click', function () { st.user = u; U.$$('.lrow', ul).forEach(function (x) { x.classList.remove('sel'); x.querySelector('.check').innerHTML = ''; }); row.classList.add('sel'); row.querySelector('.check').innerHTML = U.icon('check'); });
            ul.appendChild(row);
          });
        }, function (err) { U.clear(ul); ul.appendChild(h('div.panel', [h('span.warn', { text: ui.errorText(err) })])); });
        body.appendChild(h('h3', { text: t('saves.options') }));
        body.appendChild(ui.toggleRow({ id: 'sv-backup', icon: 'shield', label: t('saves.backupFirst'), desc: t('saves.backupFirstHint'), value: st.backupFirst, onChange: function (v) { st.backupFirst = v; } }));
        var eng = h('div.panel', { style: { marginTop: '12px' } }, [h('div.row', [h('span', { 'data-engine': '' })])]);
        body.appendChild(eng);
        engine().then(function (e) { var ph = eng.querySelector('[data-engine]'); if (ph) { ph.parentNode.replaceChild(enginePill(e), ph); eng.appendChild(h('p.dim.small', { text: tierHint(e.tier) })); } });
        body.appendChild(h('p.dim.small', { text: t('saves.installSteps') }));
      },
      foot: [
        h('button.btn.ghost', { nav: 'sv-cancel', text: t('common.cancel'), on: { click: function () { ui.closeLayer(handle); } } }),
        h('span.spacer'),
        h('button.btn.primary.lg', { nav: 'sv-install-go', 'data-autofocus': '', 'data-go': '', html: U.icon('download') + '<span>' + U.escapeHtml(t('saves.installGo')) + '</span>', on: { click: go } })
      ]
    });
    function go() {
      var btn = handle.foot.querySelector('[data-go]');
      if (!st.user) { ui.toast({ cls: 'bad', title: t('saves.pickProfile') }); return; }
      btn.classList.add('busy');
      ca.api.savesInstall(s.id, { user: st.user.id, backupFirst: st.backupFirst }).then(function (r) {
        btn.classList.remove('busy');
        XS.actions.refreshQueue();
        if (r.job && r.job.id) watch[r.job.id] = { save: s, kind: 'install' };
        ui.closeLayer(handle);
        ui.toast({ cls: 'gold', title: t('saves.installQueued'), desc: s.name, action: { label: t('game.viewDownloads'), onClick: function () { XS.router.go('downloads'); } } });
      }, function (err) { btn.classList.remove('busy'); ui.errorToast(err, t('saves.install')); });
    }
  }
  var watch = {};
  S.on('queue', function () {
    var ids = Object.keys(watch); if (!ids.length) return;
    S.data.queue.jobs.forEach(function (j) {
      var w = watch[j.id]; if (!w) return;
      if (j.state === 'done' || j.state === 'installed') { delete watch[j.id]; XS.sound.done(); ui.toast({ cls: 'good', title: w.kind === 'install' ? t('saves.installedToast') : t('saves.downloadedToast'), desc: w.kind === 'install' ? t('saves.installedToastSub') : (j.path || ''), timeout: 7000 }); }
      else if (j.state === 'failed' || j.state === 'cancelled') delete watch[j.id];
    });
  });
  function downloadFile(s) {
    ca.api.savesDownload(s.id, {}).then(function (r) {
      XS.actions.refreshQueue();
      if (r.job && r.job.id) watch[r.job.id] = { save: s, kind: 'download' };
      ui.toast({ cls: 'gold', title: t('saves.downloadQueued'), desc: r.job && r.job.path ? r.job.path : s.name, action: { label: t('game.viewDownloads'), onClick: function () { XS.router.go('downloads'); } } });
    }, function (err) { ui.errorToast(err, t('saves.downloadFile')); });
  }
  function report(s) { ca.linkDialog({ title: t('saves.report'), hint: t('saves.reportHint'), url: ca.issueUrl('save', { save: s }), display: t('game2.issueOnGithub'), openLabel: t('game2.openIssue') }); }

  /* ---------- Community Saves screen ---------- */
  function render() {
    if (!root) return;
    U.clear(root);
    var inner = h('div.screen-inner.saves-screen');
    root.appendChild(inner);
    var head = h('div.page-head');
    head.appendChild(h('div.grow', [h('div.kicker', { text: t('saves.kicker') }), h('h1', { text: t('saves.title') }), h('p.dim', { text: t('saves.subtitle') })]));
    var pill = h('span', { 'data-engine': '' }); head.appendChild(pill);
    engine().then(function (e) { var fresh = enginePill(e); if (pill.parentNode) pill.parentNode.replaceChild(fresh, pill); });
    var mine = h('button.btn.lg', { nav: 'sv-mine', html: U.icon('library') + '<span>' + U.escapeHtml(t('saves.mySaves')) + '</span>' });
    mine.addEventListener('click', function () { XS.router.go('library', { section: 'saves' }); });
    head.appendChild(mine);
    var up = h('button.btn.primary.lg', { nav: 'sv-upload', 'data-autofocus': '', html: U.icon('upload') + '<span>' + U.escapeHtml(t('saves.uploadMine')) + '</span>' });
    up.addEventListener('click', function () { uploadWizard({}); });
    head.appendChild(up);
    inner.appendChild(head);
    var bar = h('div.browse-bar', { data: { navRegion: '' } });
    var sb = ui.searchBox({ id: 'sv-search', placeholder: t('saves.searchPlaceholder'), value: scr.q, onInput: function (v) { scr.q = v; live(); } });
    bar.appendChild(sb);
    var sort = h('button.btn', { nav: 'sv-sort', html: U.icon('sort') + '<span>' + U.escapeHtml(t('saves.sort.' + scr.sort)) + '</span>' });
    sort.addEventListener('click', function () { ui.menu(sort, SORTS.map(function (s2) { return { label: t('saves.sort.' + s2), checked: scr.sort === s2, onSelect: function () { scr.sort = s2; render(); ca.focusIn(root, 'sv-sort'); } }; }), { title: t('browse.sortBy') }); });
    bar.appendChild(sort);
    var comp = h('button.chip.quick' + (scr.compatOnly ? '.on' : ''), { nav: 'sv-compat', text: t('saves.compatibleOnly'), 'aria-pressed': scr.compatOnly ? 'true' : 'false' });
    comp.addEventListener('click', function () { scr.compatOnly = !scr.compatOnly; render(); ca.focusIn(root, 'sv-compat'); });
    bar.appendChild(comp);
    var rf = h('button.iconbtn', { nav: 'sv-refresh', html: U.icon('refresh'), 'aria-label': t('common.refresh'), title: t('common.refresh') });
    rf.addEventListener('click', function () { cache.all = null; cache.byGame = {}; render(); });
    bar.appendChild(rf);
    inner.appendChild(bar);
    inner.appendChild(catChips(scr.cat, function (c) { scr.cat = c; render(); ca.focusIn(root, 'cat-' + (c || 'all')); }));
    var newestHost = h('div'); inner.appendChild(newestHost);
    var meta = h('div.browse-meta'); inner.appendChild(meta);
    var gridHost = h('div', { data: { navRegion: '' } }); inner.appendChild(gridHost);
    gridHost.appendChild(ca.busyRow(t('saves.loading')));
    var live = U.debounce(function () { paintGrid(); }, 120);
    function paintGrid() {
      var all = cache.all || [];
      var q = scr.q.trim().toLowerCase();
      var list = all.filter(function (s) {
        if (scr.cat && s.category !== scr.cat) return false;
        if (scr.compatOnly && !compatible(s)) return false;
        if (q && ((s.title || '') + ' ' + (s.name || '') + ' ' + (s.titleId || '') + ' ' + (s.author || '') + ' ' + s.tags.join(' ')).toLowerCase().indexOf(q) < 0) return false;
        return true;
      });
      list.sort(scr.sort === 'popular' ? function (a, b) { return b.downloads - a.downloads || cmpDate(a, b); } : scr.sort === 'version' ? function (a, b) { return ca.semverCmp(b.gameVersion, a.gameVersion) || cmpDate(a, b); } : cmpDate);
      U.clear(meta); meta.appendChild(h('span', { text: t('saves.nSaves', { n: list.length }) }));
      U.clear(gridHost);
      if (!list.length) { gridHost.appendChild(ui.emptyState(q ? t('browse.emptyQueryTitle', { q: scr.q }) : t('saves.emptyTitle'), t('saves.emptyHint'), [h('button.btn.primary', { nav: 'sv-upload2', html: U.icon('upload') + '<span>' + U.escapeHtml(t('saves.uploadMine')) + '</span>', on: { click: function () { uploadWizard({}); } } })])); return; }
      var grid = h('div.grid.saves-grid');
      list.slice(0, 200).forEach(function (s) { grid.appendChild(card(s, 'grid')); });
      gridHost.appendChild(grid);
    }
    function cmpDate(a, b) { return (b.createdAt || '') < (a.createdAt || '') ? -1 : (b.createdAt || '') > (a.createdAt || '') ? 1 : 0; }
    fetchAll().then(function () {
      if (!scr.q && !scr.cat && !scr.compatOnly) { var nw = cache.all.slice().sort(cmpDate).slice(0, 12); var sec = rail(t('discover2.newSaves'), nw, { id: 'newest' }); if (sec) newestHost.appendChild(sec); }
      paintGrid();
    }, function (err) { U.clear(gridHost); gridHost.appendChild(ui.emptyState(t('saves.loadFailed'), ui.errorText(err), [h('button.btn', { nav: 'sv-retry', text: t('common.retry'), on: { click: render } })])); });
  }

  /* ---------- Upload my save wizard (§17.22.5) ---------- */
  function uploadWizard(prefill) {
    prefill = prefill || {};
    var sv = (S.data.settings && S.data.settings.saves) || {};
    var st = { step: 0, user: null, users: [], titles: null, title: null, dir: null, exp: null, host: sv.uploadHost || 'pixeldrain', up: null, sub: null, eng: null,
      meta: { category: '', name: '', description: '', tags: '', nickname: sv.nickname || '' }, busy: false, q: '' };
    var STEPS = ['profile', 'title', 'dir', 'export', 'upload', 'meta', 'done'];
    var hd = ui.sheet({ title: t('saves.wizTitle'), key: 'svwiz', cls: 'wide', body: function () { /* painted below */ } });
    engine().then(function (e) { st.eng = e; if (st.step === 3) paint(); });
    function stepBar() { var s = h('div.steps'); STEPS.forEach(function (_, i) { s.appendChild(h('i' + (i <= st.step ? '.on' : ''))); }); return s; }
    function foot(backFn, nextLabel, nextFn, nextDisabled) {
      U.clear(hd.foot);
      if (backFn) hd.foot.appendChild(h('button.btn.ghost', { nav: 'wz-back', text: t('common.back'), on: { click: backFn } }));
      hd.foot.appendChild(h('span.dim.wz-step', { text: t('saves.wizStep', { i: st.step + 1, n: STEPS.length, name: t('saves.wizSteps.' + STEPS[st.step]) }) }));
      hd.foot.appendChild(h('span.spacer'));
      if (nextFn) { var nb = h('button.btn.primary.lg', { nav: 'wz-next', 'data-next': '', text: nextLabel, on: { click: nextFn } }); if (nextDisabled) nb.setAttribute('disabled', ''); hd.foot.appendChild(nb); }
    }
    function setNextEnabled(on) { var nb = hd.foot.querySelector('[data-next]'); if (nb) nb.toggleAttribute('disabled', !on); }
    function selectRow(list, nav, icon, name, desc, selected, onPick, coverSrc) {
      var row = h('button.lrow' + (selected ? '.sel' : ''), { nav: nav, data: { hints: 'select' } });
      if (coverSrc !== undefined) row.appendChild(ui.cover(coverSrc.src, coverSrc.fallback, name)); else row.appendChild(h('span.ic', { html: U.icon(icon) }));
      row.appendChild(h('div.main', [h('div.name.ellipsis', { text: name }), desc ? h('div.desc', { text: desc }) : null]));
      row.appendChild(h('span.check', { html: selected ? U.icon('check') : '' }));
      row.addEventListener('click', function () { U.$$('.lrow', list).forEach(function (x) { x.classList.remove('sel'); x.querySelector('.check').innerHTML = ''; }); row.classList.add('sel'); row.querySelector('.check').innerHTML = U.icon('check'); onPick(); });
      return row;
    }
    function paint() {
      var body = hd.body; U.clear(body); U.clear(hd.foot);
      body.appendChild(stepBar());
      var s = STEPS[st.step];
      if (s === 'profile') {
        body.appendChild(h('div.wiz-hero', [h('span.ic.okring.gold', { html: U.icon('upload').replace('<svg ', '<svg style="width:30px;height:30px;fill:none;stroke:currentColor;stroke-width:2.2" ') }), h('div', [h('h2', { text: t('saves.wizWelcome') }), h('p', { text: t('saves.wizWelcomeText') })])]));
        body.appendChild(h('h3', { text: t('saves.profile') }));
        var ul = h('div.list'); ul.appendChild(ca.busyRow(t('saves.loadingUsers'))); body.appendChild(ul);
        body.appendChild(h('p.dim.small', { text: t('saves.privacyNote') }));
        foot(null, t('common.next'), function () { if (st.user) { st.step = 1; st.titles = null; paint(); } }, !st.user);
        users().then(function (list) {
          U.clear(ul); st.users = list;
          if (!list.length) { ul.appendChild(h('div.panel', [h('span.dim', { text: t('saves.noUsers') })])); return; }
          list.forEach(function (u, i) { if (!st.user && (u.foreground || i === 0)) st.user = u; ul.appendChild(selectRow(ul, 'wz-user-' + i, 'gamepad', u.name || String(u.id), (u.foreground ? t('saves.foregroundUser') + ' · ' : '') + 'id ' + u.id, st.user === u, function () { st.user = u; setNextEnabled(true); })); });
          setNextEnabled(!!st.user);
          requestAnimationFrame(function () { XS.nav.focusFirst(hd.el); });
        }, function (err) { U.clear(ul); ul.appendChild(h('div.panel', [h('span.warn', { text: ui.errorText(err) })])); });
      } else if (s === 'title') {
        body.appendChild(h('h3', { text: t('saves.wizPickTitle') }));
        var sb = ui.searchBox({ id: 'wz-title-search', placeholder: t('saves.wizTitleSearch'), value: st.q, onInput: function (v) { st.q = v; paintTitles(); } });
        body.appendChild(sb);
        var tl = h('div.list', { style: { marginTop: '10px' } }); tl.appendChild(ca.busyRow(t('saves.loading'))); body.appendChild(tl);
        foot(function () { st.step = 0; paint(); }, t('common.next'), function () { if (st.title) { st.step = 2; paint(); } }, !st.title);
        function paintTitles() {
          U.clear(tl);
          var q = st.q.trim().toLowerCase();
          var list = (st.titles || []).filter(function (x) { return x.kind !== 'ps4' && (!q || ((x.title || '') + ' ' + x.titleId).toLowerCase().indexOf(q) >= 0); });
          if (!list.length) { tl.appendChild(h('div.panel', [h('span.dim', { text: st.titles && st.titles.length ? t('browse.emptyQueryTitle', { q: st.q }) : t('saves.wizNoSaves') })])); return; }
          list.forEach(function (x, i) {
            var g = S.data.byTitleId[x.titleId] || (x.gameId ? S.game(x.gameId) : null);
            var name = x.title || (g ? g.title : x.titleId);
            tl.appendChild(selectRow(tl, 'wz-title-' + i, 'box', name, x.titleId + (x.size ? ' · ' + U.fmtBytes(x.size) : '') + (x.mtime ? ' · ' + ca.fmtWhen(x.mtime) : ''), st.title === x, function () { st.title = x; st.dir = null; setNextEnabled(true); }, { src: x.cover || (g ? g.cover : ''), fallback: g ? g.coverFallback : '' }));
          });
        }
        if (st.titles) paintTitles();
        else ca.api.savesList(st.user ? st.user.id : '').then(function (r) {
          st.titles = (r.saves || []).map(function (x) { var g = S.data.byTitleId[x.titleId] || (x.gameId ? S.game(x.gameId) : null); if (g) { x.title = x.title || g.title; x.cover = x.cover || g.cover; x.gameId = x.gameId || g.id; x.region = x.region || g.region; } return x; });
          if (prefill.titleId && !st.title) { st.title = st.titles.filter(function (x) { return x.titleId === prefill.titleId; })[0] || null; }
          paintTitles(); setNextEnabled(!!st.title);
          if (st.title) { var sel = tl.querySelector('.lrow.sel'); if (sel) XS.nav.focus(sel, false); }
        }, function (err) { U.clear(tl); tl.appendChild(h('div.panel', [h('span.warn', { text: ui.errorText(err) })])); });
      } else if (s === 'dir') {
        var x = st.title, g = S.data.byTitleId[x.titleId] || (x.gameId ? S.game(x.gameId) : null);
        var hero = h('div.cover-hero'); hero.appendChild(ui.cover(x.cover || (g ? g.cover : ''), g ? g.coverFallback : '', x.title || x.titleId));
        var auto = h('div.chips');
        auto.appendChild(h('span.chip.sm.mono', { text: x.titleId }));
        if (x.region || (g && g.region)) auto.appendChild(h('span.chip.sm', { text: x.region || g.region }));
        var verChip = h('span.chip.sm', { 'data-ver': '', text: x.version ? 'v' + x.version : t('saves.wizVersionLoading') }); auto.appendChild(verChip);
        hero.appendChild(h('div.grow', [h('h4', { text: x.title || x.titleId }), auto, h('div.meta', { text: t('saves.wizAutoFilled') })]));
        body.appendChild(hero);
        if (!x.version) ca.api.savesInstalledVersion(x.titleId).then(function (r) { if (r.version) { x.version = r.version; verChip.textContent = 'v' + r.version; } else verChip.textContent = t('saves.wizVersionUnknown'); if (r.region && !x.region) x.region = r.region; }, function () { verChip.textContent = t('saves.wizVersionUnknown'); });
        body.appendChild(h('h3', { text: t('saves.wizPickDir') }));
        var dl = h('div.list'); body.appendChild(dl);
        var dirs = Array.isArray(x.dirs) && x.dirs.length ? x.dirs : [{ name: x.dirName || basename(x.path) || 'SAVEDATA00', size: x.size, mtime: x.mtime }];
        dirs.forEach(function (d, i) { if (!st.dir && i === 0) st.dir = d; dl.appendChild(selectRow(dl, 'wz-dir-' + i, 'folder', d.name, [d.size ? U.fmtBytes(d.size) : '', d.mtime ? ca.fmtWhen(d.mtime) : '', d.title || ''].filter(Boolean).join(' · '), st.dir === d, function () { st.dir = d; setNextEnabled(true); })); });
        body.appendChild(h('p.dim.small', { text: t('saves.wizDirHint') }));
        foot(function () { st.step = 1; paint(); }, t('saves.wizExport'), function () { st.step = 3; st.exp = null; paint(); }, !st.dir);
      } else if (s === 'export') {
        body.appendChild(h('h3', { text: t('saves.wizSteps.export') }));
        var ep = h('div.panel'); body.appendChild(ep);
        var eng = h('div.row', [st.eng ? enginePill(st.eng) : h('span.dim', { text: t('saves.loading') })]); body.appendChild(h('div.panel', { style: { marginTop: '12px' } }, [eng, h('p.dim.small', { text: st.eng ? t('saves.wizExportEngine', { tier: tierText(st.eng.tier) }) + ' ' + tierHint(st.eng.tier) : '' })]));
        foot(function () { st.step = 2; paint(); }, t('common.next'), function () { if (st.exp) { st.step = 4; paint(); } }, !st.exp);
        if (st.exp) paintExport(ep);
        else {
          ep.appendChild(h('div.row', [h('span.skel', { style: { width: '18px', height: '18px', borderRadius: '50%', flex: '0 0 auto' } }), h('span.dim', { text: t('saves.wizExporting', { dir: st.dir.name }) })]));
          ca.api.savesExport({ user: st.user ? st.user.id : '', titleId: st.title.titleId, dirName: st.dir.name }).then(function (r) {
            st.exp = r; paintExport(ep); setNextEnabled(true);
            var m = r.manifest || {}; if (m.gameVersion && !st.title.version) st.title.version = m.gameVersion; if (m.region && !st.title.region) st.title.region = m.region;
            ca.focusIn(hd.el, 'wz-next');
          }, function (err) { U.clear(ep); ep.appendChild(h('div.row', [ui.svg('alert'), h('span.warn', { text: ui.errorText(err) })])); ep.appendChild(h('div', { style: { marginTop: '10px' } }, [h('button.btn.sm', { nav: 'wz-retry', text: t('common.retry'), on: { click: function () { st.exp = null; paint(); } } })])); });
        }
        function paintExport(box) {
          U.clear(box);
          var r = st.exp, m = r.manifest || {};
          var kv = h('dl.kv');
          function add(k, v) { if (!v) return; kv.appendChild(h('dt', { text: k })); kv.appendChild(h('dd', { text: v })); }
          add(t('saves.wizZip'), r.zipPath || '');
          add(t('saves.fileSize'), r.size ? U.fmtBytes(r.size) : '');
          add(t('saves.wizFiles'), m.files ? t('saves.nFiles', { n: m.files.length }) : '');
          add(t('saves.sha256'), r.sha256 ? String(r.sha256).slice(0, 24) + '…' : '');
          add(t('saves.gameVersion'), m.gameVersion || st.title.version || '');
          add(t('saves.region'), m.region || st.title.region || '');
          box.appendChild(h('div.row', [ui.svg('check'), h('b', { text: t('saves.wizExported') })]));
          box.appendChild(kv);
          box.appendChild(h('div.chips', { style: { marginTop: '10px' } }, [h('span.chip.sm.good', { html: U.icon('check') + '<span>' + U.escapeHtml(t('saves.wizAccountStripped')) + '</span>' }), h('span.chip.sm.good', { html: U.icon('check') + '<span>' + U.escapeHtml(t('saves.wizNoSealedKeys')) + '</span>' })]));
        }
      } else if (s === 'upload') {
        body.appendChild(h('h3', { text: t('saves.wizHost') }));
        var hosts = [{ id: 'pixeldrain', label: 'pixeldrain', sub: t('saves.hostPixeldrain') }, { id: 'catbox', label: 'catbox', sub: t('saves.hostCatbox') }];
        if (sv.uploadEndpoint) hosts.push({ id: 'custom', label: t('saves.hostCustom'), sub: sv.uploadEndpoint });
        if (!hosts.some(function (x) { return x.id === st.host; })) st.host = 'pixeldrain';
        body.appendChild(ui.segControl({ id: 'wz-host', value: st.host, options: hosts.map(function (x) { return { value: x.id, label: x.label }; }), onChange: function (v) { st.host = v; } }));
        body.appendChild(h('p.dim.small', { text: hosts.map(function (x) { return x.label + ': ' + x.sub; }).join(' · ') }));
        var up = h('div.panel', { style: { marginTop: '14px' } }); body.appendChild(up);
        if (st.up) paintUploaded(up);
        else up.appendChild(h('div.row', [ui.svg('upload'), h('span.dim', { text: t('saves.wizUploadReady', { size: st.exp && st.exp.size ? U.fmtBytes(st.exp.size) : '' }) })]));
        foot(function () { st.step = 3; paint(); }, st.up ? t('common.next') : t('saves.wizUploadGo'), function () {
          if (st.up) { st.step = 5; paint(); return; }
          if (st.busy) return; st.busy = true;
          U.clear(up);
          var bar = h('div.bar.gold.striped', [h('i', { style: { width: '100%' } })]);
          up.appendChild(h('div.row', [h('span.dim', { text: t('saves.wizUploading', { size: st.exp && st.exp.size ? U.fmtBytes(st.exp.size) : '', host: st.host }) })]));
          up.appendChild(h('div', { style: { marginTop: '10px' } }, [bar]));
          up.appendChild(h('p.dim.small', { text: t('saves.wizUploadNote') }));
          setNextEnabled(false);
          ca.api.savesUpload({ zipPath: st.exp.zipPath, host: st.host }).then(function (r) {
            st.busy = false; st.up = r; paintUploaded(up);
            U.clear(hd.foot); foot(function () { st.step = 3; paint(); }, t('common.next'), function () { st.step = 5; paint(); });
            ca.focusIn(hd.el, 'wz-next');
          }, function (err) { st.busy = false; U.clear(up); up.appendChild(h('div.row', [ui.svg('alert'), h('span.warn', { text: ui.errorText(err) })])); setNextEnabled(true); });
        });
        function paintUploaded(box) { U.clear(box); box.appendChild(h('div.row', [ui.svg('check'), h('b', { text: t('saves.wizUploaded') })])); var kv = h('dl.kv'); kv.appendChild(h('dt', { text: 'URL' })); kv.appendChild(h('dd.mono', { text: st.up.url || '' })); if (st.up.size) { kv.appendChild(h('dt', { text: t('saves.fileSize') })); kv.appendChild(h('dd', { text: U.fmtBytes(st.up.size) })); } if (st.up.sha256) { kv.appendChild(h('dt', { text: t('saves.sha256') })); kv.appendChild(h('dd.mono', { text: String(st.up.sha256).slice(0, 24) + '…' })); } box.appendChild(kv); }
      } else if (s === 'meta') {
        var m = st.meta;
        body.appendChild(h('h3', { text: t('saves.wizCategory') }));
        body.appendChild(catChipsPick());
        var f1 = h('div.field', [h('label', { text: t('saves.wizName') }), h('input.input', { nav: 'wz-name', type: 'text', maxlength: '80', value: m.name, placeholder: t('saves.wizNamePlaceholder'), on: { input: function (e) { m.name = e.target.value; validate(); } } })]);
        var counter = h('span.counter', { text: m.description.length + ' / 300' });
        var f2 = h('div.field', [h('label', [t('saves.wizDescription'), ' ', counter]), h('textarea.input.desc', { nav: 'wz-desc', maxlength: '300', placeholder: t('saves.wizDescriptionPlaceholder'), on: { input: function (e) { m.description = e.target.value.slice(0, 300); counter.textContent = m.description.length + ' / 300'; validate(); } } })]);
        f2.querySelector('textarea').value = m.description;
        var f3 = h('div.field', [h('label', { text: t('saves.wizTags') }), h('input.input', { nav: 'wz-tags', type: 'text', value: m.tags, placeholder: 'ng+, max money, chapter 4', on: { input: function (e) { m.tags = e.target.value; } } })]);
        var f4 = h('div.field', [h('label', { text: t('saves.wizNickname') }), h('input.input', { nav: 'wz-nick', type: 'text', maxlength: '32', value: m.nickname, placeholder: t('saves.wizNicknamePlaceholder'), on: { input: function (e) { m.nickname = e.target.value; validate(); } } })]);
        body.appendChild(h('div.wz-form', [f1, f2, f3, f4]));
        var autoKv = h('dl.kv');
        [[t('game.titleId'), st.title.titleId], [t('saves.gameVersion'), st.title.version || (st.exp && st.exp.manifest && st.exp.manifest.gameVersion) || t('saves.wizVersionUnknown')], [t('saves.region'), st.title.region || ''], [t('saves.fileSize'), st.up && st.up.size ? U.fmtBytes(st.up.size) : ''], [t('saves.sha256'), st.up && st.up.sha256 ? String(st.up.sha256).slice(0, 16) + '…' : '']].forEach(function (kv) { if (!kv[1]) return; autoKv.appendChild(h('dt', { text: kv[0] })); autoKv.appendChild(h('dd', { text: kv[1] })); });
        body.appendChild(h('h3', { text: t('saves.wizAutoFilled') }));
        body.appendChild(h('div.panel', [autoKv]));
        body.appendChild(h('p.dim.small', { text: t('saves.privacyNote') }));
        foot(function () { st.step = 4; paint(); }, t('saves.wizSubmit'), submit, !valid());
        function validate() { setNextEnabled(valid()); }
        function valid() { return !!(m.category && m.name.trim() && m.nickname.trim()); }
        function catChipsPick() {
          var wrap = h('div.chips', { data: { navRegion: '' } });
          CATS.forEach(function (c) { var b = h('button.chip' + (m.category === c ? '.on' : ''), { nav: 'wz-cat-' + c, text: t('saves.cat.' + c), role: 'radio', 'aria-checked': m.category === c ? 'true' : 'false' }); b.addEventListener('click', function () { m.category = c; U.$$('.chip', wrap).forEach(function (x) { x.classList.toggle('on', x === b); x.setAttribute('aria-checked', x === b ? 'true' : 'false'); }); validate(); }); wrap.appendChild(b); });
          return wrap;
        }
        function submit() {
          if (!valid() || st.busy) return; st.busy = true;
          var nb = hd.foot.querySelector('[data-next]'); if (nb) nb.classList.add('busy');
          var payload = { titleId: st.title.titleId, gameId: st.title.gameId || '', title: st.title.title || '', category: m.category, name: m.name.trim(), description: m.description.trim(), tags: m.tags.split(',').map(function (x) { return x.trim(); }).filter(Boolean).slice(0, 10), nickname: m.nickname.trim(), gameVersion: st.title.version || (st.exp && st.exp.manifest && st.exp.manifest.gameVersion) || '', region: st.title.region || '', dirName: st.dir.name, size: (st.up && st.up.size) || (st.exp && st.exp.size) || 0, sha256: (st.up && st.up.sha256) || (st.exp && st.exp.sha256) || '', url: st.up ? st.up.url : '', host: st.host, zipPath: st.exp ? st.exp.zipPath : '' };
          ca.api.savesSubmit(payload).then(function (r) { st.busy = false; st.sub = r; if (m.nickname && m.nickname !== sv.nickname) ca.api.settingsPut({ saves: { nickname: m.nickname } }).then(function (rr) { if (rr.settings) S.set('settings', rr.settings); }, function () { /* ignore */ }); cache.all = null; cache.byGame = {}; st.step = 6; paint(); }, function (err) { st.busy = false; if (nb) nb.classList.remove('busy'); ui.errorToast(err, t('saves.wizSubmit')); });
        }
      } else if (s === 'done') {
        var r = st.sub || {};
        body.appendChild(h('div.wiz-hero', [h('span.ic.okring', { html: U.icon('check').replace('<svg ', '<svg style="width:30px;height:30px;fill:none;stroke:currentColor;stroke-width:2.5" ') }), h('div', [h('h2', { text: t('saves.wizDoneTitle') }), h('p', { text: r.issueUrl ? t('saves.wizDoneIssue') : t('saves.wizDoneBackend', { status: r.status || 'pending' }) })])]));
        if (r.issueUrl) {
          body.appendChild(h('div', { style: { marginTop: '8px' } }, [ui.qr(r.issueUrl)]));
          body.appendChild(h('div.pair-url.small', { text: t('game2.issueOnGithub') }));
          var ob = h('button.btn.primary.lg', { nav: 'wz-open-issue', 'data-autofocus': '', html: U.icon('external') + '<span>' + U.escapeHtml(t('game2.openIssue')) + '</span>' }); ob.addEventListener('click', function () { U.openExternal(r.issueUrl); });
          var cb = h('button.btn', { nav: 'wz-copy', html: U.icon('copy') + '<span>' + U.escapeHtml(t('game2.copyUrl')) + '</span>' }); cb.addEventListener('click', function () { U.copyText(r.issueUrl).then(function (ok) { ui.toast({ cls: ok ? 'good' : 'bad', title: ok ? t('toast.copied') : t('toast.copyFailed') }); }); });
          body.appendChild(h('div.btn-row', { style: { justifyContent: 'center', marginTop: '14px' } }, [ob, cb]));
          body.appendChild(h('p.dim.small', { style: { textAlign: 'center', marginTop: '12px' }, text: t('saves.wizReviewNote') }));
        } else {
          var kv = h('dl.kv');
          if (r.id) { kv.appendChild(h('dt', { text: 'ID' })); kv.appendChild(h('dd.mono', { text: String(r.id) })); }
          if (r.backend) { kv.appendChild(h('dt', { text: t('saves.backend') })); kv.appendChild(h('dd', { text: String(r.backend) })); }
          if (r.url) { kv.appendChild(h('dt', { text: 'URL' })); kv.appendChild(h('dd.mono', { text: String(r.url) })); }
          body.appendChild(h('div.panel', [kv]));
        }
        U.clear(hd.foot);
        hd.foot.appendChild(h('span.spacer'));
        hd.foot.appendChild(h('button.btn.primary.lg', { nav: 'wz-done', text: t('common.done'), on: { click: function () { ui.closeLayer(hd); } } }));
      }
      requestAnimationFrame(function () { if (!hd.el.contains(document.activeElement)) XS.nav.focusFirst(hd.el); });
    }
    function basename(p) { p = String(p || '').replace(/\/+$/, ''); return p.substring(p.lastIndexOf('/') + 1); }
    paint();
    return hd;
  }

  XS.router.register('saves', {
    tab: false, icon: 'shield', label: function () { return t('saves.title'); },
    mount: function (el) { root = el; },
    show: function (params) { if (params && params.q !== undefined) scr.q = params.q; if (params && params.category) scr.cat = params.category; render(); },
    refresh: render
  });
  XS.saves = {
    count: function (g) { return fetchGame(g).then(function (l) { return l.length; }); },
    newest: function (n) { return fetchAll().then(function (list) { return list.slice().sort(function (a, b) { return (b.createdAt || '') < (a.createdAt || '') ? -1 : 1; }).slice(0, n || 12); }); },
    rail: rail, card: card, renderGameTab: renderGameTab, openSave: openSave, install: installSheet, download: downloadFile, report: report, upload: uploadWizard,
    engine: engine, categories: CATS, invalidate: function () { cache.all = null; cache.byGame = {}; }
  };
})();
