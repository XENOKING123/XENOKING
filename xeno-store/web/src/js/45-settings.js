/* XENO STORE — 45-settings.js: grouped settings (General, Downloads, Sources, Catalog, Pair, Updates, Notifications, Diagnostics, About). */
(function () {
  'use strict';
  var XS = window.XS, U = XS.util, S = XS.state, ui = XS.ui, api = XS.api, h = U.h, t = XS.t;
  var root = null, bodyEl = null, navEl = null, group = 'general';
  var GROUPS = ['general', 'downloads', 'sources', 'catalog', 'pair', 'updates', 'notifications', 'diagnostics', 'about'];
  var ICONS = { general: 'sliders', downloads: 'download', sources: 'cloud', catalog: 'grid', pair: 'phone', updates: 'refresh', notifications: 'bell', diagnostics: 'log', about: 'info' };
  var THEMES = ['xeno-gold', 'midnight', 'oled', 'crimson', 'emerald', 'royal', 'ice'];
  var THEME_SWATCH = { 'xeno-gold': ['#0f1d44', '#ffce4a'], midnight: ['#0f1d44', '#4aa3ff'], oled: ['#000', '#ffce4a'], crimson: ['#2a0f15', '#ff5c6c'], emerald: ['#0c2a21', '#4affa6'], royal: ['#1e1040', '#c99bff'], ice: ['#ffffff', '#d99a00'] };

  function sget(path, dflt) { var o = S.data.settings; var p = path.split('.'); for (var i = 0; i < p.length; i++) { if (!o || typeof o !== 'object') return dflt; o = o[p[i]]; } return o === undefined ? dflt : o; }
  function sset(path, value, done) {
    var p = path.split('.'), partial = {}, cur = partial;
    for (var i = 0; i < p.length - 1; i++) { cur[p[i]] = {}; cur = cur[p[i]]; }
    cur[p[p.length - 1]] = value;
    /* optimistic local update so the UI responds instantly; the server answer is authoritative */
    var local = S.data.settings || {}; var o = local; for (var k = 0; k < p.length - 1; k++) { o[p[k]] = o[p[k]] || {}; o = o[p[k]]; } o[p[p.length - 1]] = value;
    S.set('settings', local);
    XS.actions.applySettings(local);
    api.settingsPut(partial).then(function (r) { if (r.settings) { S.data.settings = r.settings; XS.actions.applySettings(r.settings); } if (done) done(true); }, function (err) { ui.errorToast(err, t('set.saveFailed')); if (done) done(false); });
  }

  function render() {
    if (!root) return;
    U.clear(root);
    var inner = h('div.screen-inner');
    root.appendChild(inner);
    var wrap = h('div.settings');
    navEl = h('nav.set-nav', { data: { navRegion: '' } });
    GROUPS.forEach(function (gid) {
      var b = h('button.sn' + (gid === group ? '.on' : ''), { nav: 'set-nav-' + gid, data: { group: gid } }, [ui.svg(ICONS[gid]), h('span', { text: t('set.group.' + gid) })]);
      b.addEventListener('click', function () { group = gid; U.$$('.sn', navEl).forEach(function (x) { x.classList.toggle('on', x === b); }); var target = bodyEl.querySelector('[data-group="' + gid + '"]'); if (target) { root.scrollTo({ top: target.offsetTop - 10, behavior: U.reducedMotion() ? 'auto' : 'smooth' }); var first = target.querySelector('[data-nav]'); if (first) setTimeout(function () { XS.nav.focus(first, false); }, 60); } });
      navEl.appendChild(b);
    });
    wrap.appendChild(navEl);
    bodyEl = h('div.set-body');
    GROUPS.forEach(function (gid) { var sec = h('section.set-group', { data: { group: gid, navRegion: '' } }); sec.appendChild(h('h2', [ui.svg(ICONS[gid]), h('span', { text: t('set.group.' + gid) })])); BUILD[gid](sec); bodyEl.appendChild(sec); });
    wrap.appendChild(bodyEl);
    inner.appendChild(wrap);
  }

  var BUILD = {};
  BUILD.general = function (sec) {
    var list = h('div.list');
    var lang = sget('general.language', 'auto');
    list.appendChild(ui.valueRow({ id: 'set-lang', icon: 'globe', label: t('set.language'), value: lang === 'auto' ? t('set.languageAuto', { name: XS.i18n.langName(XS.i18n.locale) }) : XS.i18n.langName(lang), onClick: function (row) {
      ui.menu(row, [{ label: t('set.languageAutoShort'), checked: lang === 'auto', onSelect: function () { sset('general.language', 'auto', render); } }].concat(XS.i18n.languages.map(function (l) { return { label: l.name, sub: XS.i18n.available(l.code) ? '' : t('set.languageMissing'), checked: lang === l.code, onSelect: function () { sset('general.language', l.code, render); } }; })), { title: t('set.language') });
    } }));
    var theme = sget('general.theme', 'xeno-gold');
    list.appendChild(ui.valueRow({ id: 'set-theme', icon: 'moon', label: t('set.theme'), valueEl: h('span.row', [swatch(theme), h('span', { text: t('theme.' + theme) })]), onClick: function (row) {
      ui.menu(row, THEMES.map(function (th) { return { label: t('theme.' + th), checked: theme === th, onSelect: function () { sset('general.theme', th, render); } }; }), { title: t('set.theme') });
    } }));
    var cs = h('div.lrow', { tabindex: '-1' }, [h('span.ic', { html: U.icon('grid') }), h('div.main', [h('div.name', { text: t('set.cardSize') })])]);
    cs.appendChild(ui.segControl({ id: 'set-cards', value: sget('general.cardSize', 'm'), options: [{ value: 's', label: t('set.cardS') }, { value: 'm', label: t('set.cardM') }, { value: 'l', label: t('set.cardL') }], onChange: function (v) { sset('general.cardSize', v); } }));
    list.appendChild(cs);
    list.appendChild(ui.toggleRow({ id: 'set-motion', icon: 'zap', label: t('set.reduceMotion'), desc: t('set.reduceMotionHint'), value: sget('general.reduceMotion', false), onChange: function (v) { sset('general.reduceMotion', v); } }));
    list.appendChild(ui.toggleRow({ id: 'set-sounds', icon: 'bell', label: t('set.sounds'), desc: t('set.soundsHint'), value: sget('general.sounds', true), onChange: function (v) { sset('general.sounds', v); } }));
    list.appendChild(ui.toggleRow({ id: 'set-hints', icon: 'gamepad', label: t('set.hints'), desc: t('set.hintsHint'), value: sget('general.hints', true), onChange: function (v) { sset('general.hints', v); } }));
    list.appendChild(ui.toggleRow({ id: 'set-ps4', icon: 'box', label: t('set.showPs4'), desc: t('set.showPs4Hint'), value: sget('general.showPs4', true), onChange: function (v) { sset('general.showPs4', v); } }));
    list.appendChild(ui.toggleRow({ id: 'set-adult', icon: 'eye', label: t('set.adultFilter'), desc: t('set.adultFilterHint'), value: sget('general.adultFilter', false), onChange: function (v) { sset('general.adultFilter', v); } }));
    sec.appendChild(list);
  };
  function swatch(th) { var c = THEME_SWATCH[th] || THEME_SWATCH['xeno-gold']; return h('span.theme-swatch', { style: { background: 'linear-gradient(135deg, ' + c[0] + ' 50%, ' + c[1] + ' 50%)' } }); }
  BUILD.downloads = function (sec) {
    var list = h('div.list');
    var def = S.defaultRoot();
    list.appendChild(ui.valueRow({ id: 'set-root', icon: 'hdd', label: t('set.defaultDrive'), desc: def ? def.path + ' · ' + t('dl.free', { n: U.fmtBytes(def.free) }) : t('lib.noDrives'), value: def ? def.label : '—', onClick: function (row) {
      ui.menu(row, (S.data.storage || []).map(function (r) { return { label: r.label, sub: r.path + ' · ' + U.fmtBytes(r.free), checked: !!r['default'], disabled: !r.writable, onSelect: function () { api.storageDefault(r.path).then(function () { return api.storage(); }).then(function (res) { S.set('storage', res.roots || []); S.data.settings.downloads.defaultRoot = r.path; render(); }, ui.errorToast); } }; }), { title: t('set.defaultDrive') });
    } }));
    list.appendChild(stepRow('set-conn', 'zap', t('set.connections'), t('set.connectionsHint'), sget('downloads.connections', 8), 1, 16, function (v) { sset('downloads.connections', v); }));
    list.appendChild(stepRow('set-conc', 'download', t('set.concurrent'), t('set.concurrentHint'), sget('downloads.concurrentJobs', 1), 1, 4, function (v) { sset('downloads.concurrentJobs', v); }));
    var lim = sget('downloads.maxBytesPerSec', 0);
    var LIMITS = [0, 5e6, 10e6, 20e6, 50e6, 100e6, 200e6];
    list.appendChild(ui.valueRow({ id: 'set-limit', icon: 'sliders', label: t('set.speedLimit'), desc: t('set.speedLimitHint'), value: lim ? U.fmtSpeed(lim) : t('set.unlimited'), onClick: function (row) {
      ui.menu(row, LIMITS.map(function (l) { return { label: l ? U.fmtSpeed(l) : t('set.unlimited'), checked: lim === l, onSelect: function () { sset('downloads.maxBytesPerSec', l, render); } }; }), { title: t('set.speedLimit') });
    } }));
    list.appendChild(ui.toggleRow({ id: 'set-verify', icon: 'shield', label: t('set.verifyHashes'), desc: t('set.verifyHashesHint'), value: sget('downloads.verifyHashes', true), onChange: function (v) { sset('downloads.verifyHashes', v); } }));
    list.appendChild(ui.toggleRow({ id: 'set-autoinstall', icon: 'box', label: t('set.autoInstall'), desc: t('set.autoInstallHint'), value: sget('downloads.autoInstallPkg', true), onChange: function (v) { sset('downloads.autoInstallPkg', v); } }));
    list.appendChild(ui.toggleRow({ id: 'set-shadow', icon: 'zap', label: t('set.shadowScan'), desc: t('set.shadowScanHint'), value: sget('downloads.shadowMountScan', true), onChange: function (v) { sset('downloads.shadowMountScan', v); } }));
    list.appendChild(ui.toggleRow({ id: 'set-awake', icon: 'power', label: t('set.keepAwake'), desc: t('set.keepAwakeHint'), value: sget('downloads.keepAwake', true), onChange: function (v) { sset('downloads.keepAwake', v); } }));
    var ss = sget('downloads.scheduleStart', ''), se = sget('downloads.scheduleEnd', '');
    list.appendChild(ui.valueRow({ id: 'set-schedule', icon: 'clock', label: t('set.schedule'), desc: t('set.scheduleHint'), value: ss && se ? ss + ' – ' + se : t('set.scheduleOff'), onClick: function () {
      ui.prompt(t('set.scheduleStart'), { label: t('set.scheduleFormat'), value: ss, placeholder: '01:00' }).then(function (a) {
        if (a === null) return;
        a = a.trim();
        if (!a) { sset('downloads.scheduleStart', ''); sset('downloads.scheduleEnd', '', render); return; }
        if (!/^\d{2}:\d{2}$/.test(a)) { ui.toast({ cls: 'bad', title: t('set.scheduleBad') }); return; }
        ui.prompt(t('set.scheduleEnd'), { label: t('set.scheduleFormat'), value: se, placeholder: '07:00' }).then(function (b) {
          if (b === null) return; b = b.trim();
          if (!/^\d{2}:\d{2}$/.test(b)) { ui.toast({ cls: 'bad', title: t('set.scheduleBad') }); return; }
          sset('downloads.scheduleStart', a); sset('downloads.scheduleEnd', b, render);
        });
      });
    } }));
    list.appendChild(stepRow('set-retry', 'retry', t('set.retryMax'), t('set.retryMaxHint'), sget('downloads.retryMax', 8), 0, 20, function (v) { sset('downloads.retryMax', v); }));
    list.appendChild(ui.toggleRow({ id: 'set-tls', icon: 'alert', label: t('set.insecureTls'), desc: t('set.insecureTlsHint'), value: sget('downloads.allowInsecureTls', false), onChange: function (v) { sset('downloads.allowInsecureTls', v); } }));
    sec.appendChild(list);
  };
  function stepRow(id, icon, label, desc, value, min, max, onChange) {
    var row = h('div.lrow', { tabindex: '-1' }, [h('span.ic', { html: U.icon(icon) }), h('div.main', [h('div.name', { text: label }), h('div.desc', { text: desc })])]);
    row.appendChild(ui.stepper({ id: id, value: value, min: min, max: max, onChange: onChange }));
    return row;
  }
  BUILD.sources = function (sec) {
    var list = h('div.list');
    var enabled = sget('sources.enabled', {});
    var srcs = S.data.sources.length ? S.data.sources : [{ id: 'archive', name: 'Archive.org', kind: 'direct' }, { id: 'vikingfile', name: 'Vikingfile', kind: 'browser' }, { id: 'dlpsgame', name: 'DLPSGAME', kind: 'page' }];
    var known = {};
    srcs.forEach(function (s) {
      known[s.id] = 1;
      list.appendChild(ui.toggleRow({ id: 'src-' + s.id, icon: s.kind === 'browser' ? 'globe' : s.kind === 'page' ? 'external' : 'cloud', label: s.name, desc: (s.notice || '') || t('source.kind.' + (s.kind || 'direct')), value: enabled[s.id] !== undefined ? !!enabled[s.id] : enabled.other !== false, onChange: function (v) { sset('sources.enabled.' + s.id, v); } }));
    });
    list.appendChild(ui.toggleRow({ id: 'src-other', icon: 'cloud', label: t('set.otherSources'), desc: t('set.otherSourcesHint'), value: enabled.other !== false, onChange: function (v) { sset('sources.enabled.other', v); } }));
    sec.appendChild(list);
    sec.appendChild(h('div.panel', { style: { marginTop: '12px' } }, [h('div.row', [ui.svg('alert'), h('b', { text: t('set.sourceNotice') })]), h('p.dim', { text: t('set.sourceNoticeText'), style: { marginTop: '8px', fontSize: '13.5px' } })]));
    sec.appendChild(ui.toggleRow({ id: 'src-ack', icon: 'check', label: t('set.acknowledge'), desc: t('set.acknowledgeHint'), value: sget('sources.acknowledged', false), onChange: function (v) { sset('sources.acknowledged', v); } }));
  };
  BUILD.catalog = function (sec) {
    var list = h('div.list');
    var cat = S.data.catalog || {}, st = S.data.status && S.data.status.catalog;
    var kv = h('dl.kv');
    function add(k, v) { kv.appendChild(h('dt', { text: k })); kv.appendChild(h('dd', { text: v })); }
    add(t('set.catRevision'), String(cat.revision || (st && st.revision) || '—'));
    add(t('set.catGames'), t('common.nGames', { n: (cat.games || []).length }));
    add(t('set.catReleases'), String(releaseCount()));
    add(t('set.catGenerated'), cat.generatedAt ? U.fmtDate(cat.generatedAt) : '—');
    add(t('set.catSource'), st && st.source ? t('set.catSource_' + st.source) : '—');
    add(t('set.catLastCheck'), sget('catalog.lastCheck', 0) ? U.fmtDateTime(sget('catalog.lastCheck', 0)) : t('common.never'));
    sec.appendChild(h('div.panel', [kv]));
    sec.appendChild(h('div', { style: { height: '8px' } }));
    list.appendChild(ui.valueRow({ id: 'cat-refresh', icon: 'refresh', label: t('set.catRefresh'), desc: t('set.catRefreshHint'), noChevron: true, onClick: function (row) {
      row.classList.add('busy');
      api.catalogRefresh().then(function (r) { row.classList.remove('busy'); ui.toast({ cls: 'good', title: r.updated ? t('toast.catUpdated', { rev: r.revision }) : t('toast.catCurrent', { rev: r.revision }) }); if (r.updated) XS.actions.reloadCatalog(); }, function (err) { row.classList.remove('busy'); ui.errorToast(err, t('set.catRefresh')); });
    } }));
    list.appendChild(ui.toggleRow({ id: 'cat-auto', icon: 'clock', label: t('set.catAuto'), desc: t('set.catAutoHint'), value: sget('catalog.autoRefresh', true), onChange: function (v) { sset('catalog.autoRefresh', v); } }));
    list.appendChild(ui.valueRow({ id: 'cat-url', icon: 'link', label: t('set.catUrl'), desc: sget('catalog.url', ''), onClick: function () {
      ui.prompt(t('set.catUrl'), { label: 'URL', value: sget('catalog.url', ''), text: t('set.catUrlHint') }).then(function (v) { if (v === null) return; v = v.trim(); if (v && !/^https?:\/\//i.test(v)) { ui.toast({ cls: 'bad', title: t('err.bad_url') }); return; } sset('catalog.url', v, render); });
    } }));
    sec.appendChild(list);
  };
  function releaseCount() { var n = 0; (S.data.games || []).forEach(function (g) { n += (g.releases || []).length; }); return n; }
  BUILD.pair = function (sec) {
    var box = h('div.panel');
    var url = pairUrl();
    box.appendChild(ui.qr(url));
    box.appendChild(h('div.pair-url', { text: url }));
    box.appendChild(h('p.dim', { text: t('set.pairHint'), style: { textAlign: 'center', marginTop: '10px' } }));
    sec.appendChild(box);
    api.pair().then(function (r) { if (r.url && r.url !== url) { U.clear(box); box.appendChild(ui.qr(r.url)); box.appendChild(h('div.pair-url', { text: r.url })); box.appendChild(h('p.dim', { text: t('set.pairHint'), style: { textAlign: 'center', marginTop: '10px' } })); } }, function () { /* keep the local guess */ });
    var list = h('div.list', { style: { marginTop: '10px' } });
    list.appendChild(ui.valueRow({ id: 'pair-copy', icon: 'copy', label: t('set.pairCopy'), noChevron: true, onClick: function () { U.copyText(url).then(function (ok) { ui.toast({ cls: ok ? 'good' : 'bad', title: ok ? t('toast.copied') : t('toast.copyFailed') }); }); } }));
    var pin = sget('pairing.pin', '');
    list.appendChild(ui.valueRow({ id: 'pair-pin', icon: 'key', label: t('set.pin'), desc: t('set.pinHint'), value: pin ? '••••' : t('common.off'), onClick: function () {
      ui.prompt(t('set.pin'), { label: t('set.pinLabel'), value: '', placeholder: '0000', type: 'password', text: t('set.pinText') }).then(function (v) {
        if (v === null) return; v = v.trim();
        if (v && !/^\d{4}$/.test(v)) { ui.toast({ cls: 'bad', title: t('set.pinBad') }); return; }
        S.data.pin = v; U.store.set('pin', v);
        sset('pairing.pin', v, render);
      });
    } }));
    sec.appendChild(list);
  };
  function pairUrl() {
    var st = S.data.status;
    var ip = st && st.ip ? st.ip : location.hostname;
    var port = st && st.port ? st.port : (location.port || 9095);
    return 'http://' + ip + ':' + port + '/';
  }
  BUILD.updates = function (sec) {
    var st = S.data.status || {}, up = st.update || {};
    var kv = h('dl.kv');
    function add(k, v) { kv.appendChild(h('dt', { text: k })); kv.appendChild(h('dd', { text: v })); }
    add(t('set.updCurrent'), st.version || XS.version);
    add(t('set.updLatest'), up.latest || '—');
    add(t('set.updLastCheck'), sget('updates.lastCheck', 0) ? U.fmtDateTime(sget('updates.lastCheck', 0)) : t('common.never'));
    sec.appendChild(h('div.panel', [kv, up.notes ? h('p.dim', { text: up.notes, style: { marginTop: '10px', fontSize: '13.5px' } }) : null]));
    sec.appendChild(h('div', { style: { height: '8px' } }));
    var list = h('div.list');
    list.appendChild(ui.valueRow({ id: 'upd-check', icon: 'refresh', label: t('set.updCheck'), noChevron: true, onClick: function (row) {
      row.classList.add('busy');
      api.updateCheck().then(function (r) { row.classList.remove('busy'); S.data.status = S.data.status || {}; S.data.status.update = { available: r.available, latest: r.latest, current: r.current, notes: r.notes || '', url: r.url }; S.emit('status', S.data.status); ui.toast({ cls: r.available ? 'gold' : 'good', title: r.available ? t('toast.updateAvailable', { v: r.latest }) : t('toast.upToDate') }); render(); }, function (err) { row.classList.remove('busy'); ui.errorToast(err, t('set.updCheck')); });
    } }));
    if (up.available) {
      list.appendChild(ui.valueRow({ id: 'upd-apply', icon: 'download', label: t('set.updInstall', { v: up.latest }), desc: t('set.updInstallHint'), noChevron: true, onClick: function (row) {
        row.classList.add('busy');
        api.updateApply().then(function (r) { row.classList.remove('busy'); ui.toast({ cls: 'good', title: t('toast.updateReady'), desc: r.path || '' }); }, function (err) { row.classList.remove('busy'); ui.errorToast(err, t('set.updInstall', { v: up.latest })); });
      } }));
    }
    list.appendChild(ui.valueRow({ id: 'upd-stop', icon: 'power', label: t('set.stop'), desc: t('set.stopHint'), noChevron: true, danger: true, onClick: function () {
      ui.confirm(t('set.stop'), t('set.stopConfirm'), t('set.stop'), true).then(function (ok) { if (!ok) return; api.stop().then(function () { ui.toast({ cls: 'gold', title: t('toast.stopped') }); }, function () { ui.toast({ cls: 'gold', title: t('toast.stopped') }); }); });
    } }));
    list.appendChild(ui.toggleRow({ id: 'upd-auto', icon: 'clock', label: t('set.updAuto'), desc: t('set.updAutoHint'), value: sget('updates.autoCheck', true), onChange: function (v) { sset('updates.autoCheck', v); } }));
    sec.appendChild(list);
  };
  BUILD.notifications = function (sec) {
    var list = h('div.list');
    list.appendChild(ui.toggleRow({ id: 'ntf-toasts', icon: 'bell', label: t('set.ntfToasts'), desc: t('set.ntfToastsHint'), value: sget('notifications.toasts', true), onChange: function (v) { sset('notifications.toasts', v); } }));
    list.appendChild(ui.toggleRow({ id: 'ntf-complete', icon: 'check', label: t('set.ntfComplete'), value: sget('notifications.onComplete', true), onChange: function (v) { sset('notifications.onComplete', v); } }));
    list.appendChild(ui.toggleRow({ id: 'ntf-fail', icon: 'alert', label: t('set.ntfFail'), value: sget('notifications.onFail', true), onChange: function (v) { sset('notifications.onFail', v); } }));
    list.appendChild(ui.toggleRow({ id: 'ntf-install', icon: 'box', label: t('set.ntfInstall'), value: sget('notifications.onInstall', true), onChange: function (v) { sset('notifications.onInstall', v); } }));
    list.appendChild(ui.valueRow({ id: 'ntf-test', icon: 'bell', label: t('set.ntfTest'), desc: t('set.ntfTestHint'), noChevron: true, onClick: function () { api.toast(t('set.ntfTestText')).then(function () { ui.toast({ cls: 'good', title: t('toast.sent') }); }, ui.errorToast); } }));
    sec.appendChild(list);
  };
  BUILD.diagnostics = function (sec) {
    var st = S.data.status || {};
    var kv = h('dl.kv');
    function add(k, v) { kv.appendChild(h('dt', { text: k })); kv.appendChild(h('dd', { text: v })); }
    add(t('diag.version'), (st.version || XS.version) + (st.build ? ' (' + st.build + ')' : ''));
    add(t('diag.platform'), (st.platform || '—') + (st.fw ? ' · FW ' + st.fw : ''));
    add(t('diag.address'), st.ip ? st.ip + ':' + st.port : location.host);
    add(t('diag.uptime'), st.uptime !== undefined ? U.fmtDur(st.uptime) : '—');
    add(t('diag.downloads'), st.downloadsAvailable === false ? t('common.unavailable') : t('common.available'));
    add(t('diag.catalog'), st.catalog ? (st.catalog.source || '') + ' · r' + st.catalog.revision : '—');
    add(t('diag.browser'), navigator.userAgent);
    add(t('diag.screen'), window.innerWidth + '×' + window.innerHeight + ' @' + (window.devicePixelRatio || 1) + 'x');
    sec.appendChild(h('div.panel', [h('h3', { text: t('diag.system'), style: { margin: '0 0 10px' } }), kv]));
    var logPanel = h('div.panel');
    var logBox = h('div.logbox', { nav: 'diag-log', text: t('diag.logLoading') });
    var head = h('div.row', { style: { marginBottom: '10px' } }, [h('h3', { text: t('diag.log'), style: { margin: 0 } }), h('span.spacer.grow')]);
    var rb = h('button.btn.sm', { nav: 'diag-log-refresh', text: t('common.refresh') }); rb.addEventListener('click', loadLog);
    var cb = h('button.btn.sm.ghost', { nav: 'diag-log-copy', text: t('common.copy') }); cb.addEventListener('click', function () { U.copyText(logBox.textContent).then(function (ok) { ui.toast({ cls: ok ? 'good' : 'bad', title: ok ? t('toast.copied') : t('toast.copyFailed') }); }); });
    head.appendChild(rb); head.appendChild(cb);
    logPanel.appendChild(head); logPanel.appendChild(logBox);
    sec.appendChild(logPanel);
    function loadLog() { api.log(200).then(function (r) { U.clear(logBox); (r.lines || []).forEach(function (l) { var cls = /\b(error|fail|fatal)\b/i.test(l) ? 'e' : /\bwarn/i.test(l) ? 'w' : ''; logBox.appendChild(h('div' + (cls ? '.' + cls : ''), { text: l })); }); if (!(r.lines || []).length) logBox.textContent = t('diag.logEmpty'); logBox.scrollTop = logBox.scrollHeight; }, function (err) { logBox.textContent = ui.errorText(err); }); }
    loadLog();
    var list = h('div.list', { style: { marginTop: '12px' } });
    list.appendChild(ui.valueRow({ id: 'diag-export', icon: 'upload', label: t('diag.export'), desc: t('diag.exportHint'), onClick: function () {
      api.exportAll().then(function (data) {
        delete data.$etag;
        var txt = JSON.stringify(data, null, 2);
        var ta = h('textarea.input', { nav: 'exp-text', readonly: true, text: txt });
        var hd = ui.sheet({ title: t('diag.export'), sub: t('diag.exportSub', { n: U.fmtBytes(txt.length) }), body: [ta], foot: [
          h('button.btn', { nav: 'exp-copy', text: t('common.copy'), on: { click: function () { U.copyText(txt).then(function (ok) { ui.toast({ cls: ok ? 'good' : 'bad', title: ok ? t('toast.copied') : t('toast.copyFailed') }); }); } } }),
          h('button.btn', { nav: 'exp-dl', text: t('diag.download'), on: { click: function () { try { var blob = new Blob([txt], { type: 'application/json' }); var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'xeno-store-export.json'; document.body.appendChild(a); a.click(); document.body.removeChild(a); } catch (e) { ui.toast({ cls: 'bad', title: t('toast.copyFailed') }); } } } }),
          h('span.spacer'), h('button.btn.primary', { nav: 'exp-close', text: t('common.close'), on: { click: function () { ui.closeLayer(hd); } } })
        ] });
      }, ui.errorToast);
    } }));
    list.appendChild(ui.valueRow({ id: 'diag-import', icon: 'download', label: t('diag.import'), desc: t('diag.importHint'), onClick: function () {
      var ta = h('textarea.input', { nav: 'imp-text', placeholder: '{ "settings": { … } }' });
      var file = h('input', { type: 'file', accept: 'application/json,.json', style: { display: 'none' } });
      file.addEventListener('change', function () { var f = file.files && file.files[0]; if (!f) return; var fr = new FileReader(); fr.onload = function () { ta.value = String(fr.result || ''); }; fr.readAsText(f); });
      var hd = ui.sheet({ title: t('diag.import'), sub: t('diag.importSub'), body: [ta, file, h('div.btn-row', { style: { marginTop: '10px' } }, [h('button.btn.sm', { nav: 'imp-file', text: t('diag.chooseFile'), on: { click: function () { file.click(); } } })])], foot: [
        h('span.spacer'),
        h('button.btn.primary', { nav: 'imp-apply', text: t('diag.importApply'), on: { click: function () {
          var obj = null; try { obj = JSON.parse(ta.value); } catch (e) { ui.toast({ cls: 'bad', title: t('diag.importBad') }); return; }
          api.importAll(obj).then(function () { ui.closeLayer(hd); ui.toast({ cls: 'good', title: t('toast.imported') }); XS.actions.reloadAll(); }, ui.errorToast);
        } } })
      ] });
    } }));
    list.appendChild(ui.valueRow({ id: 'diag-clearcache', icon: 'trash', label: t('diag.clearCache'), desc: t('diag.clearCacheHint'), noChevron: true, onClick: function () { try { localStorage.removeItem('xs.catalog'); localStorage.removeItem('xs.recentSearches'); } catch (e) { /* ignore */ } ui.toast({ cls: 'good', title: t('toast.cacheCleared') }); } }));
    sec.appendChild(list);
  };
  BUILD.about = function (sec) {
    var st = S.data.status || {};
    var hero = h('div.about-hero', [h('span.brand-badge', [h('img', { src: XS.logoSrc || '/logo.jpg', alt: '' })]), h('div', [h('h2', { html: 'XENO <em>STORE</em>' }), h('p', { text: t('about.tagline') }), h('p.mute', { text: t('about.version', { v: st.version || XS.version, build: st.build || '' }) })])]);
    sec.appendChild(hero);
    var links = h('div.btn-row', { style: { marginTop: '12px' } });
    links.appendChild(h('button.btn.sm', { nav: 'about-gh', html: U.icon('external') + '<span>GitHub · XENOKING123/XENOKING</span>', on: { click: function () { U.openExternal('https://github.com/XENOKING123/XENOKING'); } } }));
    links.appendChild(h('button.btn.sm.ghost', { nav: 'about-issues', html: U.icon('alert') + '<span>' + U.escapeHtml(t('about.reportIssue')) + '</span>', on: { click: function () { U.openExternal('https://github.com/XENOKING123/XENOKING/issues'); } } }));
    sec.appendChild(links);
    sec.appendChild(h('h3', { text: t('about.credits'), style: { margin: '22px 0 8px', fontSize: '15px' } }));
    var credits = h('div.credits');
    [['Orbit Store', 'saawant12 · GPL-3.0 · ' + t('about.creditOrbit')], ['BlackBox', 'D3ATHLY · ' + t('about.creditBlackbox')], ['Overdrive', 'overdriveps5 · GPL-3.0 · ' + t('about.creditOverdrive')], ['ps5-payload-dev SDK', 'John Törnblom · ' + t('about.creditSdk')], ['CheatRunner / maj0r', t('about.creditCheat')], ['Cheat creators', t('about.creditCheatCreators')], ['hejran7', t('about.creditHejran')], ['qrcode-generator', 'Kazuhiko Arase · MIT · ' + t('about.creditQr')], ['prosperopatches / orbispatches', t('about.creditArt')]].forEach(function (c) { credits.appendChild(h('div.credit', [h('b', { text: c[0] }), h('span', { text: c[1] })])); });
    sec.appendChild(credits);
    sec.appendChild(h('p.disclaimer', { text: t('about.license') }));
    sec.appendChild(h('p.disclaimer', { text: t('about.disclaimer') }));
  };

  XS.router.register('settings', {
    tab: false, icon: 'settings', label: function () { return t('nav.settings'); },
    mount: function (el) { root = el; },
    show: function (params) { if (params && params.group) group = params.group; render(); if (params && params.group) { var target = bodyEl.querySelector('[data-group="' + params.group + '"]'); if (target) root.scrollTop = target.offsetTop - 10; } },
    refresh: function () { if (root && root.classList.contains('active')) render(); }
  });
  S.on('status', function () { /* values are read on render; avoid re-rendering under the user */ });
})();
