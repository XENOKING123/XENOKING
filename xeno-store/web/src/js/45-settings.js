/* XENO STORE — 45-settings.js: grouped settings. General (+ accessibility, safe mode, screensaver, controller remap,
   shortcuts), Downloads (+ prefer format, turbo, install sets, rest mode, ZIP extraction, schedule), Debrid (§17.14),
   Sources, Catalog, Saves (§17.17), Accounts (§17.18), Setup (§17.6), Pair a device (+ mDNS §17.19), Updates,
   Notifications, Diagnostics, About, Uninstall XENO STORE (§17.16). */
(function () {
  'use strict';
  var XS = window.XS, U = XS.util, S = XS.state, ui = XS.ui, api = XS.api, cb = XS.cb, h = U.h, t = XS.t;
  var root = null, bodyEl = null, navEl = null, group = 'general';
  var GROUPS = ['general', 'downloads', 'debrid', 'sources', 'catalog', 'saves', 'accounts', 'setup', 'pair', 'updates', 'notifications', 'diagnostics', 'about', 'uninstall'];
  var ICONS = { general: 'sliders', downloads: 'download', debrid: 'cloud', sources: 'globe', catalog: 'grid', saves: 'shield', accounts: 'gamepad', setup: 'check', pair: 'phone', updates: 'refresh', notifications: 'bell', diagnostics: 'log', about: 'info', uninstall: 'trash' };
  var THEMES = ['xeno-gold', 'midnight', 'oled', 'crimson', 'emerald', 'royal', 'ice'];
  var THEME_SWATCH = { 'xeno-gold': ['#0f1d44', '#ffce4a'], midnight: ['#0f1d44', '#4aa3ff'], oled: ['#000', '#ffce4a'], crimson: ['#2a0f15', '#ff5c6c'], emerald: ['#0c2a21', '#4affa6'], royal: ['#1e1040', '#c99bff'], ice: ['#ffffff', '#d99a00'] };
  var sget = cb.sget, sset = cb.sset;
  var debrid = { services: null, at: 0 }, accounts = { data: null, at: 0 }, mdns = { data: null, at: 0 };

  function render() {
    if (!root) return;
    U.clear(root);
    var inner = h('div.screen-inner');
    root.appendChild(inner);
    var wrap = h('div.settings');
    navEl = h('nav.set-nav', { data: { navRegion: '' } });
    GROUPS.forEach(function (gid) {
      var b = h('button.sn' + (gid === group ? '.on' : '') + (gid === 'uninstall' ? '.danger' : ''), { nav: 'set-nav-' + gid, data: { group: gid } }, [ui.svg(ICONS[gid]), h('span', { text: cb.groupLabel(gid) })]);
      b.addEventListener('click', function () { group = gid; U.$$('.sn', navEl).forEach(function (x) { x.classList.toggle('on', x === b); }); var target = bodyEl.querySelector('[data-group="' + gid + '"]'); if (target) { root.scrollTo({ top: target.offsetTop - 10, behavior: U.reducedMotion() ? 'auto' : 'smooth' }); var first = target.querySelector('[data-nav]'); if (first) setTimeout(function () { XS.nav.focus(first, false); }, 60); } });
      navEl.appendChild(b);
    });
    wrap.appendChild(navEl);
    bodyEl = h('div.set-body');
    GROUPS.forEach(function (gid) { var sec = h('section.set-group', { data: { group: gid, navRegion: '' } }); sec.appendChild(h('h2', [ui.svg(ICONS[gid]), h('span', { text: cb.groupLabel(gid) })])); BUILD[gid](sec); bodyEl.appendChild(sec); });
    wrap.appendChild(bodyEl);
    inner.appendChild(wrap);
  }
  function rerenderGroup(gid) {
    if (!bodyEl) return;
    var sec = bodyEl.querySelector('[data-group="' + gid + '"]'); if (!sec) return;
    var fid = sec.contains(document.activeElement) ? document.activeElement.getAttribute('data-nav-id') : null;
    U.clear(sec);
    sec.appendChild(h('h2', [ui.svg(ICONS[gid]), h('span', { text: cb.groupLabel(gid) })]));
    BUILD[gid](sec);
    if (fid) { var again = sec.querySelector('[data-nav-id="' + fid + '"]'); if (again) XS.nav.focus(again, false); }
  }
  function stepRow(id, icon, label, desc, value, min, max, onChange) {
    var row = h('div.lrow', { tabindex: '-1' }, [h('span.ic', { html: U.icon(icon) }), h('div.main', [h('div.name', { text: label }), h('div.desc', { text: desc })])]);
    row.appendChild(ui.stepper({ id: id, value: value, min: min, max: max, onChange: onChange }));
    return row;
  }
  function textRow(o) {
    /* value row that edits a free-text setting through a prompt */
    return ui.valueRow({ id: o.id, icon: o.icon, label: o.label, desc: o.desc, value: o.display !== undefined ? o.display : (o.value || t('common.off')), onClick: function () {
      ui.prompt(o.label, { label: o.inputLabel || o.label, value: o.value || '', placeholder: o.placeholder || '', text: o.text || '', type: o.type || 'text' }).then(function (v) {
        if (v === null) return; v = v.trim();
        if (o.validate && v && !o.validate(v)) { ui.toast({ cls: 'bad', title: o.invalid || t('err.bad_url') }); return; }
        sset(o.path, v, function () { rerenderGroup(o.group); });
      });
    } });
  }
  var isUrl = function (v) { return /^https?:\/\//i.test(v); };

  var BUILD = {};
  /* ---------------- General ---------------- */
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
    /* accessibility + delight (§17.7, §17.20) */
    sec.appendChild(h('div.group-title', { text: t('a11y.title') }));
    var a11y = h('div.list');
    a11y.appendChild(ui.toggleRow({ id: 'set-largetext', icon: 'eye', label: t('a11y.largeText'), desc: t('a11y.largeTextHint'), value: sget('general.largeText', false), onChange: function (v) { sset('general.largeText', v); } }));
    a11y.appendChild(ui.toggleRow({ id: 'set-contrast', icon: 'image', label: t('a11y.highContrast'), desc: t('a11y.highContrastHint'), value: sget('general.highContrast', false), onChange: function (v) { sset('general.highContrast', v); } }));
    var safeSession = cb.safeModeSession();
    a11y.appendChild(ui.toggleRow({ id: 'set-safemode', icon: 'shield', label: t('a11y.safeMode'), desc: safeSession ? t('a11y.safeModeSession') : t('a11y.safeModeHint'), value: sget('general.safeMode', false), onChange: function (v) { sset('general.safeMode', v); } }));
    a11y.appendChild(ui.toggleRow({ id: 'set-screensaver', icon: 'image', label: t('a11y.screensaver'), desc: t('a11y.screensaverHint'), value: sget('general.screensaver', true), onChange: function (v) { sset('general.screensaver', v); } }));
    a11y.appendChild(stepRow('set-ss-min', 'clock', t('a11y.screensaverMinutes'), t('a11y.screensaverMinutesHint'), U.clamp(Number(sget('general.screensaverMinutes', 3)) || 3, 1, 30), 1, 30, function (v) { sset('general.screensaverMinutes', v); }));
    a11y.appendChild(ui.toggleRow({ id: 'set-swap', icon: 'gamepad', label: t('a11y.swapConfirm'), desc: t('a11y.swapConfirmHint'), value: sget('general.controllerSwapConfirm', false), onChange: function (v) { sset('general.controllerSwapConfirm', v); } }));
    a11y.appendChild(ui.valueRow({ id: 'set-shortcuts', icon: 'log', label: t('a11y.shortcutsTitle'), desc: t('a11y.shortcutsRowHint'), value: '?', onClick: function () { cb.shortcuts.open(); } }));
    a11y.appendChild(ui.valueRow({ id: 'set-palette', icon: 'search', label: t('palette.title'), desc: t('palette.rowHint'), value: 'Ctrl / ⌘ K', onClick: function () { cb.palette.open(''); } }));
    sec.appendChild(a11y);
  };
  function swatch(th) { var c = THEME_SWATCH[th] || THEME_SWATCH['xeno-gold']; return h('span.theme-swatch', { style: { background: 'linear-gradient(135deg, ' + c[0] + ' 50%, ' + c[1] + ' 50%)' } }); }

  /* ---------------- Downloads ---------------- */
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
    var pf = sget('downloads.preferFormat', 'auto');
    var FORMATS = ['auto', 'exFAT', 'FFPFSC', 'PKG'];
    list.appendChild(ui.valueRow({ id: 'set-prefer', icon: 'box', label: t('settings2.preferFormat'), desc: t('settings2.preferFormatHint'), value: pf === 'auto' ? t('settings2.preferAuto') : pf, onClick: function (row) {
      ui.menu(row, FORMATS.map(function (f) { return { label: f === 'auto' ? t('settings2.preferAuto') : f, sub: f === 'auto' ? t('settings2.preferAutoSub') : '', checked: pf === f, onSelect: function () { sset('downloads.preferFormat', f, function () { rerenderGroup('downloads'); }); } }; }), { title: t('settings2.preferFormat') });
    } }));
    list.appendChild(ui.toggleRow({ id: 'set-turbo', icon: 'zap', label: t('settings2.turbo'), desc: t('settings2.turboHint'), value: sget('downloads.turboStart', true), onChange: function (v) { sset('downloads.turboStart', v); } }));
    list.appendChild(ui.toggleRow({ id: 'set-verify', icon: 'shield', label: t('set.verifyHashes'), desc: t('set.verifyHashesHint'), value: sget('downloads.verifyHashes', true), onChange: function (v) { sset('downloads.verifyHashes', v); } }));
    list.appendChild(ui.toggleRow({ id: 'set-autoinstall', icon: 'box', label: t('set.autoInstall'), desc: t('set.autoInstallHint'), value: sget('downloads.autoInstallPkg', true), onChange: function (v) { sset('downloads.autoInstallPkg', v); } }));
    list.appendChild(ui.toggleRow({ id: 'set-autosets', icon: 'box', label: t('settings2.autoInstallSets'), desc: t('settings2.autoInstallSetsHint'), value: sget('downloads.autoInstallSets', true), onChange: function (v) { sset('downloads.autoInstallSets', v); } }));
    var order = sget('downloads.installOrder', 'game,backport,update,dlc') || 'game,backport,update,dlc';
    var ORDERS = ['game,backport,update,dlc', 'game,update,backport,dlc', 'game,update,dlc,backport'];
    var orderLabel = function (o) { return o.split(',').map(function (k) { return t('game2.kind.' + k.trim()); }).join(' → '); };
    list.appendChild(ui.valueRow({ id: 'set-order', icon: 'sort', label: t('settings2.installOrder'), desc: t('settings2.installOrderHint'), value: orderLabel(order), onClick: function (row) {
      ui.menu(row, ORDERS.map(function (o) { return { label: orderLabel(o), checked: order === o, onSelect: function () { sset('downloads.installOrder', o, function () { rerenderGroup('downloads'); }); } }; }), { title: t('settings2.installOrder') });
    } }));
    list.appendChild(ui.toggleRow({ id: 'set-shadow', icon: 'zap', label: t('set.shadowScan'), desc: t('set.shadowScanHint'), value: sget('downloads.shadowMountScan', true), onChange: function (v) { sset('downloads.shadowMountScan', v); } }));
    list.appendChild(ui.toggleRow({ id: 'set-awake', icon: 'power', label: t('set.keepAwake'), desc: t('set.keepAwakeHint'), value: sget('downloads.keepAwake', true), onChange: function (v) { sset('downloads.keepAwake', v); } }));
    list.appendChild(ui.toggleRow({ id: 'set-restresume', icon: 'moon', label: t('settings2.restResume'), desc: t('settings2.restResumeHint'), value: sget('downloads.restModeAutoResume', true), onChange: function (v) { sset('downloads.restModeAutoResume', v); } }));
    list.appendChild(ui.toggleRow({ id: 'set-extract', icon: 'box', label: t('settings2.extractZip'), desc: t('settings2.extractZipHint'), value: sget('downloads.extractZip', true), onChange: function (v) { sset('downloads.extractZip', v); } }));
    list.appendChild(ui.toggleRow({ id: 'set-delarchive', icon: 'trash', label: t('settings2.deleteArchive'), desc: t('settings2.deleteArchiveHint'), value: sget('downloads.deleteArchiveAfterExtract', true), onChange: function (v) { sset('downloads.deleteArchiveAfterExtract', v); } }));
    var ss = sget('downloads.scheduleStart', ''), se = sget('downloads.scheduleEnd', '');
    list.appendChild(ui.valueRow({ id: 'set-schedule', icon: 'clock', label: t('set.schedule'), desc: ss && se ? t('settings2.scheduleActive', { start: ss, end: se }) : t('set.scheduleHint'), value: ss && se ? ss + ' – ' + se : t('set.scheduleOff'), onClick: function () { scheduleSheet(ss, se); } }));
    list.appendChild(stepRow('set-retry', 'retry', t('set.retryMax'), t('set.retryMaxHint'), sget('downloads.retryMax', 8), 0, 20, function (v) { sset('downloads.retryMax', v); }));
    list.appendChild(ui.toggleRow({ id: 'set-tls', icon: 'alert', label: t('set.insecureTls'), desc: t('set.insecureTlsHint'), value: sget('downloads.allowInsecureTls', false), onChange: function (v) { sset('downloads.allowInsecureTls', v); } }));
    sec.appendChild(list);
  };
  function scheduleSheet(ss, se) {
    var st = { start: ss || '', end: se || '' };
    var PRESETS = [['22:00', '07:00'], ['00:00', '08:00'], ['01:00', '06:00']];
    var handle = ui.sheet({
      title: t('set.schedule'), sub: t('set.scheduleHint'), cls: 'narrow', key: 'schedule',
      body: function (body) {
        body.appendChild(h('p.dim.small', { text: t('settings2.scheduleText') }));
        body.appendChild(h('h3', { text: t('settings2.schedulePresets') }));
        var chips = h('div.chips');
        PRESETS.forEach(function (p, i) { var c = h('button.chip' + (st.start === p[0] && st.end === p[1] ? '.on' : ''), { nav: 'sch-preset-' + i, text: p[0] + ' – ' + p[1] }); c.addEventListener('click', function () { st.start = p[0]; st.end = p[1]; a.value = p[0]; b.value = p[1]; U.$$('.chip', chips).forEach(function (x) { x.classList.toggle('on', x === c); }); }); chips.appendChild(c); });
        var off = h('button.chip' + (!st.start ? '.on' : ''), { nav: 'sch-off', text: t('set.scheduleOff') }); off.addEventListener('click', function () { st.start = ''; st.end = ''; a.value = ''; b.value = ''; U.$$('.chip', chips).forEach(function (x) { x.classList.toggle('on', x === off); }); }); chips.appendChild(off);
        body.appendChild(chips);
        body.appendChild(h('h3', { text: t('settings2.scheduleCustom') }));
        var a = h('input.input', { nav: 'sch-start', type: 'text', value: st.start, placeholder: '22:00', 'aria-label': t('set.scheduleStart'), inputmode: 'numeric', maxlength: '5' });
        var b = h('input.input', { nav: 'sch-end', type: 'text', value: st.end, placeholder: '07:00', 'aria-label': t('set.scheduleEnd'), inputmode: 'numeric', maxlength: '5' });
        a.addEventListener('input', function () { st.start = a.value.trim(); }); b.addEventListener('input', function () { st.end = b.value.trim(); });
        body.appendChild(h('div.two-fields', [h('div.field', [h('label', { text: t('set.scheduleStart') }), a]), h('div.field', [h('label', { text: t('set.scheduleEnd') }), b])]));
        body.appendChild(h('p.dim.small', { text: t('set.scheduleFormat') }));
      },
      foot: [h('span.spacer'), h('button.btn.primary', { nav: 'sch-save', text: t('common.ok'), on: { click: function () {
        var ok = (!st.start && !st.end) || (/^\d{2}:\d{2}$/.test(st.start) && /^\d{2}:\d{2}$/.test(st.end));
        if (!ok) { ui.toast({ cls: 'bad', title: t('set.scheduleBad') }); return; }
        cb.api.put('/api/settings', { downloads: { scheduleStart: st.start, scheduleEnd: st.end } }).then(function (r) { if (r.settings) { S.set('settings', r.settings); } else { var loc = S.data.settings || {}; loc.downloads = loc.downloads || {}; loc.downloads.scheduleStart = st.start; loc.downloads.scheduleEnd = st.end; S.set('settings', loc); } ui.closeLayer(handle); rerenderGroup('downloads'); ui.toast({ cls: 'good', title: st.start ? t('settings2.scheduleSaved', { start: st.start, end: st.end }) : t('settings2.scheduleCleared') }); }, function (err) { ui.errorToast(err, t('set.saveFailed')); });
      } } })]
    });
  }

  /* ---------------- Debrid (§17.14) ---------------- */
  var SERVICES = [{ id: 'realdebrid', name: 'Real-Debrid', site: 'real-debrid.com/apitoken' }, { id: 'alldebrid', name: 'AllDebrid', site: 'alldebrid.com/apikeys' }, { id: 'torbox', name: 'TorBox', site: 'torbox.app/settings' }, { id: 'premiumize', name: 'Premiumize', site: 'premiumize.me/account' }];
  function loadDebrid(force) {
    if (!force && debrid.services && Date.now() - debrid.at < 60000) return Promise.resolve(debrid.services);
    return cb.api.debrid().then(function (r) { debrid.services = r.services || []; debrid.at = Date.now(); return debrid.services; });
  }
  BUILD.debrid = function (sec) {
    sec.appendChild(h('p.dim.small', { text: t('debrid.intro'), style: { marginTop: '-6px', marginBottom: '12px' } }));
    var list = h('div.list'); sec.appendChild(list);
    var paint = function (services) {
      U.clear(list);
      var byId = {}; (services || []).forEach(function (s) { byId[s.id] = s; });
      SERVICES.forEach(function (def) {
        var s = byId[def.id] || { id: def.id, name: def.name, connected: false, hosts: [] };
        var key = sget('debrid.' + def.id + '.apiKey', '');
        var connected = !!s.connected || !!key;
        var row = h('div.lrow.debrid-row' + (connected ? '.on' : ''), { nav: 'debrid-' + def.id, data: { hints: 'select' } });
        row.appendChild(h('span.ic', { html: U.icon('cloud') }));
        var main = h('div.main', [h('div.name', [s.name || def.name, connected ? h('span.chip.sm.good', { text: t('debrid.connected'), style: { marginInlineStart: '8px' } }) : h('span.chip.sm', { text: t('debrid.notConnected'), style: { marginInlineStart: '8px' } })])]);
        var desc = [];
        if (connected) { if (s.user) desc.push(t('debrid.user', { name: s.user })); if (s.expires) desc.push(t('debrid.expires', { date: U.fmtDate(s.expires) })); desc.push(t('debrid.keyMasked', { key: s.apiKeyMasked || cb.maskKey(key) || '••••' })); }
        else desc.push(t('debrid.getKey', { site: def.site }));
        main.appendChild(h('div.desc', { text: desc.join(' · ') }));
        if (connected && s.hosts && s.hosts.length) {
          var hosts = h('div.tags');
          s.hosts.slice(0, 8).forEach(function (x) { hosts.appendChild(h('span.chip.sm', { text: x })); });
          if (s.hosts.length > 8) hosts.appendChild(h('span.chip.sm.gold', { text: t('debrid.moreHosts', { n: s.hosts.length - 8 }) }));
          main.appendChild(hosts);
        }
        row.appendChild(main);
        var act = h('button.btn.sm' + (connected ? '.ghost' : '.primary'), { nav: 'debrid-' + def.id + '-' + (connected ? 'disconnect' : 'connect'), text: connected ? t('debrid.disconnect') : t('debrid.connect') });
        act.addEventListener('click', function (e) { e.stopPropagation(); if (connected) disconnect(def, s); else connect(def); });
        row.appendChild(act);
        row.addEventListener('click', function (e) { if (e.target.closest('button')) return; if (connected) hostsSheet(def, s); else connect(def); });
        list.appendChild(row);
      });
      var connectedIds = SERVICES.filter(function (d) { return (byId[d.id] && byId[d.id].connected) || sget('debrid.' + d.id + '.apiKey', ''); });
      var pref = sget('debrid.preferred', 'auto') || 'auto';
      var prefLabel = pref === 'auto' ? t('game2.viaAuto') : pref === 'direct' ? t('game2.viaDirect') : (byId[pref] && byId[pref].name) || pref;
      list.appendChild(ui.valueRow({ id: 'debrid-preferred', icon: 'sliders', label: t('debrid.preferred'), desc: t('debrid.preferredHint'), value: prefLabel, onClick: function (row) {
        var items = [{ label: t('game2.viaAuto'), sub: t('game2.viaAutoSub'), checked: pref === 'auto', onSelect: function () { sset('debrid.preferred', 'auto', function () { rerenderGroup('debrid'); }); } }, { label: t('game2.viaDirect'), sub: t('game2.viaDirectSub'), checked: pref === 'direct', onSelect: function () { sset('debrid.preferred', 'direct', function () { rerenderGroup('debrid'); }); } }];
        connectedIds.forEach(function (d) { items.push({ label: d.name, checked: pref === d.id, onSelect: function () { sset('debrid.preferred', d.id, function () { rerenderGroup('debrid'); }); } }); });
        ui.menu(row, items, { title: t('debrid.preferred') });
      } }));
      list.appendChild(cb.note(t('debrid.privacy'), '', 'shield'));
    };
    paint(debrid.services || []);
    loadDebrid(false).then(paint, function (err) { list.appendChild(cb.note(t('debrid.loadFailed') + ' ' + ui.errorText(err), 'warn')); });
    function connect(def) {
      ui.prompt(t('debrid.connectTitle', { name: def.name }), { label: t('debrid.apiKey'), placeholder: t('debrid.apiKeyPlaceholder'), text: t('debrid.connectText', { name: def.name, site: def.site }), type: 'password', okLabel: t('debrid.connect') }).then(function (v) {
        if (v === null) return; v = v.trim();
        if (v.length < 8) { ui.toast({ cls: 'bad', title: t('debrid.keyTooShort') }); return; }
        var busy = ui.toast({ cls: 'gold', icon: 'cloud', title: t('debrid.checking', { name: def.name }), timeout: 30000 });
        cb.api.debridConnect(def.id, v).then(function (r) {
          busy.close();
          var s = r.service || {};
          ui.toast({ cls: 'good', title: t('debrid.connectedToast', { name: def.name }), desc: s.user ? t('debrid.user', { name: s.user }) : '' });
          if (XS.ca && XS.ca.api && XS.ca.api.debrid) XS.ca.api.debrid(true);
          loadDebrid(true).then(function () { rerenderGroup('debrid'); });
          api.settings().then(function (st) { S.set('settings', st); }, function () { /* ignore */ });
        }, function (err) { busy.close(); ui.errorToast(err, t('debrid.connectTitle', { name: def.name })); });
      });
    }
    function disconnect(def) {
      ui.confirm(t('debrid.disconnectTitle', { name: def.name }), t('debrid.disconnectText', { name: def.name }), t('debrid.disconnect'), true).then(function (ok) {
        if (!ok) return;
        cb.api.debridDisconnect(def.id).then(function () {
          ui.toast({ cls: 'good', title: t('debrid.disconnected', { name: def.name }) });
          if (XS.ca && XS.ca.api && XS.ca.api.debrid) XS.ca.api.debrid(true);
          loadDebrid(true).then(function () { rerenderGroup('debrid'); });
          api.settings().then(function (st) { S.set('settings', st); }, function () { /* ignore */ });
        }, function (err) { ui.errorToast(err, t('debrid.disconnect')); });
      });
    }
    function hostsSheet(def, s) {
      var hosts = (s.hosts || []).slice().sort();
      var hd = ui.sheet({ title: s.name || def.name, sub: hosts.length ? t('debrid.hostsSub', { n: hosts.length }) : t('debrid.hostsNone'), cls: 'narrow', body: function (body) {
        body.appendChild(h('div.panel', [cb.kv([[t('debrid.status'), t('debrid.connected')], [t('debrid.userLabel'), s.user || '—'], [t('debrid.expiresLabel'), s.expires ? U.fmtDate(s.expires) : '—'], [t('debrid.apiKey'), s.apiKeyMasked || cb.maskKey(sget('debrid.' + def.id + '.apiKey', '')) || '••••']])]));
        body.appendChild(h('h3', { text: t('debrid.hosts') }));
        if (!hosts.length) body.appendChild(h('p.dim', { text: t('debrid.hostsUnknown') }));
        else body.appendChild(h('div.chips', hosts.map(function (x) { return h('span.chip.sm', { text: x }); })));
        body.appendChild(cb.note(t('debrid.hostsNote'), '', 'info'));
      }, foot: [h('button.btn.ghost', { nav: 'dh-disc', text: t('debrid.disconnect'), on: { click: function () { ui.closeLayer(hd); disconnect(def); } } }), h('span.spacer'), h('button.btn.primary', { nav: 'dh-close', 'data-autofocus': '', text: t('common.close'), on: { click: function () { ui.closeLayer(hd); } } })] });
    }
  };

  /* ---------------- Sources ---------------- */
  BUILD.sources = function (sec) {
    var list = h('div.list');
    var enabled = sget('sources.enabled', {});
    var srcs = S.data.sources.length ? S.data.sources : [{ id: 'archive', name: 'Archive.org', kind: 'direct' }, { id: 'vikingfile', name: 'Vikingfile', kind: 'browser' }, { id: 'dlpsgame', name: 'DLPSGAME', kind: 'page' }];
    srcs.forEach(function (s) {
      list.appendChild(ui.toggleRow({ id: 'src-' + s.id, icon: s.kind === 'browser' ? 'globe' : s.kind === 'page' ? 'external' : 'cloud', label: s.name, desc: (s.notice || '') || t('source.kind.' + (s.kind || 'direct')), value: enabled[s.id] !== undefined ? !!enabled[s.id] : enabled.other !== false, onChange: function (v) { sset('sources.enabled.' + s.id, v); } }));
    });
    list.appendChild(ui.toggleRow({ id: 'src-other', icon: 'cloud', label: t('set.otherSources'), desc: t('set.otherSourcesHint'), value: enabled.other !== false, onChange: function (v) { sset('sources.enabled.other', v); } }));
    sec.appendChild(list);
    sec.appendChild(h('div.panel', { style: { marginTop: '12px' } }, [h('div.row', [ui.svg('alert'), h('b', { text: t('set.sourceNotice') })]), h('p.dim', { text: t('set.sourceNoticeText'), style: { marginTop: '8px', fontSize: '13.5px' } })]));
    sec.appendChild(ui.toggleRow({ id: 'src-ack', icon: 'check', label: t('set.acknowledge'), desc: t('set.acknowledgeHint'), value: sget('sources.acknowledged', false), onChange: function (v) { sset('sources.acknowledged', v); } }));
  };

  /* ---------------- Catalog ---------------- */
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
    list.appendChild(textRow({ id: 'cat-url', group: 'catalog', icon: 'link', label: t('set.catUrl'), desc: sget('catalog.url', ''), display: '', path: 'catalog.url', value: sget('catalog.url', ''), inputLabel: 'URL', text: t('set.catUrlHint'), validate: isUrl }));
    list.appendChild(textRow({ id: 'cat-featured', group: 'catalog', icon: 'star', label: t('settings2.featuredUrl'), desc: sget('catalog.featuredUrl', '') || t('settings2.feedDefault'), display: '', path: 'catalog.featuredUrl', value: sget('catalog.featuredUrl', ''), inputLabel: 'URL', text: t('settings2.feedHint'), validate: isUrl }));
    list.appendChild(textRow({ id: 'cat-messages', group: 'catalog', icon: 'bell', label: t('settings2.messagesUrl'), desc: sget('catalog.messagesUrl', '') || t('settings2.feedDefault'), display: '', path: 'catalog.messagesUrl', value: sget('catalog.messagesUrl', ''), inputLabel: 'URL', text: t('settings2.feedHint'), validate: isUrl }));
    list.appendChild(textRow({ id: 'cat-companions', group: 'catalog', icon: 'box', label: t('settings2.companionsUrl'), desc: sget('catalog.companionsUrl', '') || t('settings2.feedDefault'), display: '', path: 'catalog.companionsUrl', value: sget('catalog.companionsUrl', ''), inputLabel: 'URL', text: t('settings2.feedHint'), validate: isUrl }));
    sec.appendChild(list);
  };
  function releaseCount() { var n = 0; (S.data.games || []).forEach(function (g) { n += (g.releases || []).length; }); return n; }

  /* ---------------- Saves (§17.17, §17.22) ---------------- */
  BUILD.saves = function (sec) {
    var list = h('div.list');
    var br = sget('saves.backupRoot', ''), def = S.defaultRoot();
    var brRoot = br ? cb.rootByPath(br) : null;
    list.appendChild(ui.valueRow({ id: 'sv-root', icon: 'hdd', label: t('settings2.backupDrive'), desc: brRoot ? brRoot.path + ' · ' + t('dl.free', { n: U.fmtBytes(brRoot.free) }) : t('settings2.backupDriveDefault', { label: def ? def.label : '—' }), value: brRoot ? brRoot.label : t('settings2.sameAsDownloads'), onClick: function (row) {
      ui.menu(row, [{ label: t('settings2.sameAsDownloads'), checked: !br, onSelect: function () { sset('saves.backupRoot', '', function () { rerenderGroup('saves'); }); } }].concat((S.data.storage || []).map(function (r) { return { label: r.label, sub: r.path + ' · ' + U.fmtBytes(r.free), checked: br === r.path, disabled: !r.writable, onSelect: function () { sset('saves.backupRoot', r.path, function () { rerenderGroup('saves'); }); } }; })), { title: t('settings2.backupDrive') });
    } }));
    list.appendChild(ui.toggleRow({ id: 'sv-autobackup', icon: 'shield', label: t('settings2.autoBackup'), desc: t('settings2.autoBackupHint'), value: sget('saves.autoBackup', true), onChange: function (v) { sset('saves.autoBackup', v); } }));
    list.appendChild(ui.valueRow({ id: 'sv-hub', icon: 'folder', label: t('lib2.savesHub'), desc: t('settings2.savesHubHint'), onClick: function () { XS.router.go('saveshub'); } }));
    list.appendChild(ui.valueRow({ id: 'sv-backupall', icon: 'download', label: t('settings2.backUpAllNow'), desc: t('settings2.backUpAllNowHint'), noChevron: true, onClick: function (row) { backupAllNow(row); } }));
    list.appendChild(textRow({ id: 'sv-nick', group: 'saves', icon: 'gamepad', label: t('settings2.nickname'), desc: t('settings2.nicknameHint'), path: 'saves.nickname', value: sget('saves.nickname', ''), placeholder: 'xeno_fan' }));
    sec.appendChild(list);
    /* community feeds */
    sec.appendChild(h('div.group-title', { text: t('settings2.savesSources') }));
    var feeds = h('div.list');
    var urls = sget('saves.indexUrls', []) || [];
    if (!Array.isArray(urls)) urls = [];
    urls.forEach(function (u, i) {
      feeds.appendChild(ui.valueRow({ id: 'sv-url-' + i, icon: 'link', label: cb.hostOf(u) || u, desc: u, hints: 'remove', valueEl: h('span', { html: U.icon('x') }), noChevron: true, onClick: function () {
        ui.confirm(t('settings2.removeFeedTitle'), u, t('common.delete'), true).then(function (ok) { if (!ok) return; var next = urls.filter(function (x) { return x !== u; }); sset('saves.indexUrls', next, function () { rerenderGroup('saves'); }); });
      } }));
    });
    feeds.appendChild(ui.valueRow({ id: 'sv-url-add', icon: 'plus', label: t('settings2.addFeed'), desc: t('settings2.addFeedHint'), noChevron: true, onClick: function () {
      ui.prompt(t('settings2.addFeed'), { label: 'URL', placeholder: 'https://…/saves.json', text: t('settings2.addFeedText') }).then(function (v) {
        if (v === null) return; v = v.trim(); if (!v) return;
        if (!isUrl(v)) { ui.toast({ cls: 'bad', title: t('err.bad_url') }); return; }
        if (urls.indexOf(v) >= 0) return;
        sset('saves.indexUrls', urls.concat([v]), function () { rerenderGroup('saves'); });
      });
    } }));
    sec.appendChild(feeds);
    /* backend */
    sec.appendChild(h('div.group-title', { text: t('settings2.backend') }));
    var be = h('div.list');
    var kind = sget('saves.backend.kind', 'github') || 'github';
    var KINDS = ['github', 'supabase', 'none'];
    be.appendChild(ui.valueRow({ id: 'sv-be-kind', icon: 'cloud', label: t('settings2.backendKind'), desc: t('settings2.backendKind_' + kind + 'Hint'), value: t('settings2.backendKind_' + kind), onClick: function (row) {
      ui.menu(row, KINDS.map(function (k) { return { label: t('settings2.backendKind_' + k), sub: t('settings2.backendKind_' + k + 'Hint'), checked: kind === k, onSelect: function () { sset('saves.backend.kind', k, function () { rerenderGroup('saves'); }); } }; }), { title: t('settings2.backendKind') });
    } }));
    if (kind === 'supabase') {
      be.appendChild(textRow({ id: 'sv-be-url', group: 'saves', icon: 'link', label: t('settings2.supabaseUrl'), desc: t('settings2.supabaseUrlHint'), path: 'saves.backend.url', value: sget('saves.backend.url', ''), placeholder: 'https://<ref>.supabase.co', validate: isUrl }));
      var ak = sget('saves.backend.anonKey', '');
      be.appendChild(textRow({ id: 'sv-be-key', group: 'saves', icon: 'key', label: t('settings2.anonKey'), desc: t('settings2.anonKeyHint'), display: ak ? cb.maskKey(ak) : t('common.off'), path: 'saves.backend.anonKey', value: ak, placeholder: 'eyJ…', type: 'password' }));
      be.appendChild(textRow({ id: 'sv-be-bucket', group: 'saves', icon: 'folder', label: t('settings2.bucket'), path: 'saves.backend.bucket', value: sget('saves.backend.bucket', ''), placeholder: 'ps5-saves', display: sget('saves.backend.bucket', '') || 'ps5-saves' }));
      be.appendChild(textRow({ id: 'sv-be-fn', group: 'saves', icon: 'zap', label: t('settings2.garlicFunction'), desc: t('settings2.garlicFunctionHint'), path: 'saves.backend.garlicFunction', value: sget('saves.backend.garlicFunction', ''), placeholder: 'garlic-savedb', display: sget('saves.backend.garlicFunction', '') || 'garlic-savedb' }));
    }
    var sb = sget('catalog.savesBackendUrl', '');
    be.appendChild(textRow({ id: 'sv-be-feed', group: 'saves', icon: 'link', label: t('settings2.savesBackendUrl'), desc: sb || t('settings2.feedDefault'), display: '', path: 'catalog.savesBackendUrl', value: sb, inputLabel: 'URL', text: t('settings2.savesBackendUrlHint'), validate: isUrl }));
    sec.appendChild(be);
    /* upload */
    sec.appendChild(h('div.group-title', { text: t('settings2.upload') }));
    var up = h('div.list');
    var host = sget('saves.uploadHost', 'pixeldrain') || 'pixeldrain';
    var HOSTS = [['pixeldrain', 'pixeldrain', t('saves.hostPixeldrain')], ['catbox', 'catbox.moe', t('saves.hostCatbox')], ['custom', t('saves.hostCustom'), t('settings2.uploadCustomHint')]];
    var hostLabel = function (id) { for (var i = 0; i < HOSTS.length; i++) if (HOSTS[i][0] === id) return HOSTS[i][1]; return id; };
    up.appendChild(ui.valueRow({ id: 'sv-host', icon: 'upload', label: t('settings2.uploadHost'), desc: t('settings2.uploadHostHint'), value: hostLabel(host), onClick: function (row) {
      ui.menu(row, HOSTS.map(function (x) { return { label: x[1], sub: x[2], checked: host === x[0], onSelect: function () { sset('saves.uploadHost', x[0], function () { rerenderGroup('saves'); }); } }; }), { title: t('settings2.uploadHost') });
    } }));
    if (host === 'custom') up.appendChild(textRow({ id: 'sv-upload-ep', group: 'saves', icon: 'link', label: t('settings2.uploadEndpoint'), desc: t('settings2.uploadEndpointHint'), path: 'saves.uploadEndpoint', value: sget('saves.uploadEndpoint', ''), placeholder: 'https://…/upload', validate: isUrl }));
    up.appendChild(textRow({ id: 'sv-submit-ep', group: 'saves', icon: 'link', label: t('settings2.submitEndpoint'), desc: t('settings2.submitEndpointHint'), path: 'saves.submitEndpoint', value: sget('saves.submitEndpoint', ''), placeholder: 'https://…/submit', display: sget('saves.submitEndpoint', '') || t('settings2.submitGithub'), validate: isUrl }));
    sec.appendChild(up);
    sec.appendChild(cb.note(t('saves.privacyNote'), '', 'shield'));
  };
  function backupAllNow(row) {
    row.classList.add('busy');
    cb.api.savesUsers().then(function (r) {
      var users = r.users || [];
      var fg = users.filter(function (u) { return u.foreground; })[0] || users[0];
      if (!fg) { row.classList.remove('busy'); ui.toast({ cls: 'bad', title: t('saves.noUsers') }); return; }
      ui.confirm(t('settings2.backUpAllNow'), t('settings2.backUpAllNowText', { name: cb.userLabel(fg) }), t('lib2.backUpAll')).then(function (ok) {
        if (!ok) { row.classList.remove('busy'); return; }
        cb.api.savesBackupAll(fg.id).then(function (res) {
          row.classList.remove('busy');
          var n = res.started || (res.jobs || []).length;
          ui.toast({ cls: n ? 'gold' : 'good', title: n ? t('lib2.backupAllStarted', { n: n }) : t('lib2.backupAllNone'), action: n ? { label: t('lib2.savesHub'), onClick: function () { XS.router.go('saveshub'); } } : null });
        }, function (err) { row.classList.remove('busy'); ui.errorToast(err, t('lib2.backUpAll')); });
      });
    }, function (err) { row.classList.remove('busy'); ui.errorToast(err, t('lib2.backUpAll')); });
  }

  /* ---------------- Accounts (§17.18) ---------------- */
  function loadAccounts(force) {
    if (!force && accounts.data && Date.now() - accounts.at < 30000) return Promise.resolve(accounts.data);
    return cb.api.accounts().then(function (r) { accounts.data = r; accounts.at = Date.now(); return r; });
  }
  BUILD.accounts = function (sec) {
    sec.appendChild(h('p.dim.small', { text: t('accounts.intro'), style: { marginTop: '-6px', marginBottom: '12px' } }));
    var box = h('div'); sec.appendChild(box);
    box.appendChild(cb.busy(t('accounts.loading')));
    loadAccounts(false).then(function (r) { paintAccounts(box, r); }, function (err) { U.clear(box); box.appendChild(cb.note(t('accounts.loadFailed') + ' ' + ui.errorText(err), 'warn')); });
  };
  function paintAccounts(box, r) {
    U.clear(box);
    var slots = (r.slots || []).slice();
    var head = h('div.row', { style: { marginBottom: '10px', flexWrap: 'wrap' } });
    head.appendChild(r.supported === false ? h('span.chip.warn.wrap', { text: t('accounts.unsupported') }) : h('span.chip.good', { text: t('accounts.supported') }));
    if (r.simulated) head.appendChild(h('span.chip.wrap', { text: t('accounts.simulated') }));
    if (r.foregroundUser && r.foregroundUser.name) head.appendChild(h('span.chip.gold', { text: t('accounts.foreground', { name: r.foregroundUser.name }) }));
    box.appendChild(head);
    var list = h('div.list');
    var used = slots.filter(function (s) { return !s.empty && s.name; });
    if (!used.length) list.appendChild(h('p.dim', { text: t('accounts.noSlots') }));
    used.forEach(function (s) {
      var row = h('div.lrow.acc-row' + (s.activated ? '.on' : ''), { nav: 'acc-' + s.slot, data: { hints: 'select' } });
      row.appendChild(h('span.ic', { html: U.icon('gamepad') }));
      var main = h('div.main', [h('div.name', [s.name, s.foreground ? h('span.chip.sm.gold', { text: t('saves.foregroundUser'), style: { marginInlineStart: '8px' } }) : null])]);
      main.appendChild(h('div.desc', { text: t('accounts.slot', { n: s.slot }) + ' · ' + (s.activated ? t('accounts.activatedId', { id: s.id }) : t('accounts.notActivated')) + (s.type ? ' · ' + s.type : '') }));
      row.appendChild(main);
      if (s.activated) { var clr = h('button.btn.sm.ghost', { nav: 'acc-' + s.slot + '-clear', text: t('accounts.clear') }); clr.addEventListener('click', function (e) { e.stopPropagation(); clearSlot(s); }); row.appendChild(clr); }
      else { var act = h('button.btn.sm.primary', { nav: 'acc-' + s.slot + '-activate', text: t('accounts.activate') }); act.addEventListener('click', function (e) { e.stopPropagation(); activateSlot(s); }); row.appendChild(act); }
      row.addEventListener('click', function (e) { if (e.target.closest('button')) return; if (s.activated) clearSlot(s); else activateSlot(s); });
      list.appendChild(row);
    });
    list.appendChild(ui.valueRow({ id: 'acc-reboot', icon: 'power', label: t('accounts.reboot'), desc: t('accounts.rebootHint'), noChevron: true, danger: true, onClick: function () {
      ui.confirm(t('accounts.reboot'), t('accounts.rebootConfirm'), t('accounts.reboot'), true).then(function (ok) { if (!ok) return; cb.api.reboot().then(function () { ui.toast({ cls: 'gold', title: t('accounts.rebooting') }); }, function (err) { ui.errorToast(err, t('accounts.reboot')); }); });
    } }));
    list.appendChild(ui.valueRow({ id: 'acc-fake', icon: 'cloud', label: t('accounts.fakeSignIn'), desc: t('accounts.fakeSignInHint'), onClick: function () { fakeSignIn(); } }));
    list.appendChild(ui.valueRow({ id: 'acc-refresh', icon: 'refresh', label: t('common.refresh'), noChevron: true, onClick: function () { loadAccounts(true).then(function () { rerenderGroup('accounts'); }, ui.errorToast); } }));
    box.appendChild(list);
    box.appendChild(cb.note(t('accounts.note'), 'warn'));
  }
  function activateSlot(s) {
    var st = { id: '' };
    var hd = ui.sheet({
      title: t('accounts.activateTitle', { name: s.name }), sub: t('accounts.slot', { n: s.slot }), cls: 'narrow', key: 'activate:' + s.slot,
      body: function (body) {
        body.appendChild(cb.note(t('accounts.warn1'), 'warn'));
        body.appendChild(cb.note(t('accounts.warn2'), 'warn'));
        body.appendChild(cb.note(t('accounts.warn3'), '', 'info'));
        body.appendChild(h('h3', { text: t('accounts.idTitle') }));
        var input = h('input.input', { nav: 'act-id', type: 'text', placeholder: s.derivedId || '0x…', 'aria-label': t('accounts.idTitle'), autocomplete: 'off', spellcheck: 'false' });
        input.addEventListener('input', function () { st.id = input.value.trim(); });
        body.appendChild(h('div.field', [h('label', { text: t('accounts.idLabel') }), input]));
        body.appendChild(h('p.dim.small', { text: t('accounts.idHint', { id: s.derivedId || '' }) }));
      },
      foot: [h('button.btn.ghost', { nav: 'act-cancel', text: t('common.cancel'), on: { click: function () { ui.closeLayer(hd); } } }), h('span.spacer'), h('button.btn.primary', { nav: 'act-go', 'data-autofocus': '', text: t('accounts.activate'), on: { click: function () {
        if (st.id && !/^(0x)?[0-9a-f]{1,16}$/i.test(st.id)) { ui.toast({ cls: 'bad', title: t('accounts.idBad') }); return; }
        ui.confirm(t('accounts.activateConfirmTitle'), t('accounts.activateConfirmText', { name: s.name }), t('accounts.activate')).then(function (ok) {
          if (!ok) return;
          cb.api.accountActivate(s.slot, st.id).then(function (r) {
            ui.closeLayer(hd);
            ui.toast({ cls: 'good', title: t('accounts.activated', { name: s.name }), desc: t('accounts.rebootNeeded'), timeout: 9000, action: { label: t('accounts.reboot'), onClick: function () { ui.confirm(t('accounts.reboot'), t('accounts.rebootConfirm'), t('accounts.reboot'), true).then(function (ok2) { if (ok2) cb.api.reboot().then(function () { ui.toast({ cls: 'gold', title: t('accounts.rebooting') }); }, ui.errorToast); }); } } });
            loadAccounts(true).then(function () { rerenderGroup('accounts'); });
          }, function (err) { ui.errorToast(err, t('accounts.activate')); });
        });
      } } })]
    });
  }
  function clearSlot(s) {
    ui.confirm(t('accounts.clearTitle', { name: s.name }), t('accounts.clearText'), t('accounts.clear'), true).then(function (ok) {
      if (!ok) return;
      cb.api.accountClear(s.slot).then(function () { ui.toast({ cls: 'good', title: t('accounts.cleared', { name: s.name }), desc: t('accounts.rebootNeeded') }); loadAccounts(true).then(function () { rerenderGroup('accounts'); }); }, function (err) { ui.errorToast(err, t('accounts.clear')); });
    });
  }
  function fakeSignIn() {
    cb.api.payloads().then(function (r) {
      var list = (r.payloads || []).filter(function (p) { return /np[-_ ]?fake|sign[-_ ]?(in|out)/i.test((p.id || '') + ' ' + (p.name || '') + ' ' + (p.kind || '')); });
      var body = [h('p', { text: t('accounts.fakeText') })];
      if (!list.length) body.push(cb.note(t('accounts.fakeMissing'), 'warn'));
      var rows = h('div.list');
      list.forEach(function (p, i) {
        var row = h('div.lrow', { nav: 'fake-' + i, data: { hints: 'select' } }, [h('span.ic', { html: U.icon('cloud') }), h('div.main', [h('div.name', { text: p.name + (p.version ? ' v' + p.version : '') }), h('div.desc', { text: p.installed ? t('companions.installedLocal') : t('companions.notDownloaded') })])]);
        var b = h('button.btn.sm.primary', { nav: 'fake-' + i + '-go', text: p.installed ? t('companions.launch') : t('companions.install') });
        b.addEventListener('click', function (e) { e.stopPropagation(); if (XS.setupScreen) XS.setupScreen.payloadAction(p, b); });
        row.appendChild(b);
        row.addEventListener('click', function (e) { if (e.target.closest('button')) return; if (XS.setupScreen) XS.setupScreen.payloadAction(p, b); });
        rows.appendChild(row);
      });
      body.push(rows);
      body.push(cb.note(t('accounts.fakeNote'), '', 'info'));
      ui.dialog({ title: t('accounts.fakeSignIn'), body: body, buttons: [{ label: t('settings2.openSetup'), onClick: function (hd) { ui.closeLayer(hd); XS.router.go('setup', { section: 'payloads' }); } }, { label: t('common.close'), primary: true, autofocus: !list.length }] });
    }, function (err) { ui.errorToast(err, t('accounts.fakeSignIn')); });
  }

  /* ---------------- Setup (§17.6): entries into the Setup screen ---------------- */
  BUILD.setup = function (sec) {
    var st = (S.data.status && S.data.status.setup) || null;
    var list = h('div.list');
    var summary = !st || !st.checked ? t('setup.notChecked') : (st.ok === st.total ? t('setup.allOk', { n: st.total }) : t('setup.someFailing', { ok: st.ok, n: st.total }));
    list.appendChild(ui.valueRow({ id: 'setup-check', icon: 'check', label: t('setup.checklist'), desc: summary, valueEl: st && st.checked ? h('span.chip.sm' + (st.ok === st.total ? '.good' : '.warn'), { text: st.ok + ' / ' + st.total }) : null, onClick: function () { XS.router.go('setup', { section: 'checks' }); } }));
    list.appendChild(ui.valueRow({ id: 'setup-pm', icon: 'qr', label: t('setup.payloadManager'), desc: t('setup.payloadManagerHint'), onClick: function () { XS.router.go('setup', { section: 'pm' }); } }));
    list.appendChild(ui.valueRow({ id: 'setup-payloads', icon: 'box', label: t('companions.title'), desc: t('companions.hint'), onClick: function () { XS.router.go('setup', { section: 'payloads' }); } }));
    list.appendChild(ui.valueRow({ id: 'setup-ghost', icon: 'trash', label: t('setup.ghostCleaner'), desc: t('setup.ghostCleanerHint'), onClick: function () { XS.router.go('setup', { section: 'ghost' }); } }));
    sec.appendChild(list);
  };

  /* ---------------- Pair a device (+ mDNS §17.19) ---------------- */
  BUILD.pair = function (sec) {
    var box = h('div.panel');
    var url = pairUrl();
    paintPair(box, url, null);
    sec.appendChild(box);
    api.pair().then(function (r) { if (r.url && r.url !== url) paintPair(box, r.url, null); }, function () { /* keep the local guess */ });
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
    /* mDNS */
    var md = (S.data.status && S.data.status.mdns) || mdns.data || null;
    var mdOn = sget('general.mdns', true) !== false;
    var localUrl = (md && md.url) || ('http://xeno.local:' + ((S.data.status && S.data.status.port) || location.port || 9095) + '/');
    list.appendChild(ui.toggleRow({ id: 'pair-mdns', icon: 'wifi', label: t('settings2.mdns'), desc: t('settings2.mdnsHint'), value: mdOn, onChange: function (v) { sset('general.mdns', v, function () { rerenderGroup('pair'); }); } }));
    var state = !mdOn ? t('common.off') : (md ? (md.running ? t('settings2.mdnsRunning') : (md.error ? t('settings2.mdnsError', { err: md.error }) : t('settings2.mdnsStarting'))) : t('settings2.mdnsUnknown'));
    list.appendChild(ui.valueRow({ id: 'pair-local', icon: 'globe', label: t('settings2.localName'), desc: state + (md && md.names && md.names.length ? ' · ' + md.names.join(', ') : ''), valueEl: h('span.mono', { text: localUrl }), hints: 'select', onClick: function () { U.copyText(localUrl).then(function (ok) { ui.toast({ cls: ok ? 'good' : 'bad', title: ok ? t('toast.copied') : t('toast.copyFailed') }); }); } }));
    sec.appendChild(list);
    if (mdOn && !md && Date.now() - mdns.at > 15000) { mdns.at = Date.now(); cb.api.mdns().then(function (r) { mdns.data = r; rerenderGroup('pair'); }, function () { /* no mdns endpoint on this build */ }); }
  };
  function paintPair(box, url, local) {
    U.clear(box);
    box.appendChild(ui.qr(url));
    box.appendChild(h('div.pair-url', { text: url }));
    var mdOn = sget('general.mdns', true) !== false;
    if (mdOn) box.appendChild(h('div.pair-url.small', { text: local || ('http://xeno.local:' + ((S.data.status && S.data.status.port) || location.port || 9095) + '/') }));
    box.appendChild(h('p.dim', { text: t('set.pairHint') + (mdOn ? ' ' + t('settings2.localNameHint') : ''), style: { textAlign: 'center', marginTop: '10px' } }));
  }
  function pairUrl() {
    var st = S.data.status;
    var ip = st && st.ip ? st.ip : location.hostname;
    var port = st && st.port ? st.port : (location.port || 9095);
    return 'http://' + ip + ':' + port + '/';
  }

  /* ---------------- Updates ---------------- */
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

  /* ---------------- Notifications ---------------- */
  BUILD.notifications = function (sec) {
    var list = h('div.list');
    list.appendChild(ui.toggleRow({ id: 'ntf-toasts', icon: 'bell', label: t('set.ntfToasts'), desc: t('set.ntfToastsHint'), value: sget('notifications.toasts', true), onChange: function (v) { sset('notifications.toasts', v); } }));
    list.appendChild(ui.toggleRow({ id: 'ntf-complete', icon: 'check', label: t('set.ntfComplete'), value: sget('notifications.onComplete', true), onChange: function (v) { sset('notifications.onComplete', v); } }));
    list.appendChild(ui.toggleRow({ id: 'ntf-fail', icon: 'alert', label: t('set.ntfFail'), value: sget('notifications.onFail', true), onChange: function (v) { sset('notifications.onFail', v); } }));
    list.appendChild(ui.toggleRow({ id: 'ntf-install', icon: 'box', label: t('set.ntfInstall'), value: sget('notifications.onInstall', true), onChange: function (v) { sset('notifications.onInstall', v); } }));
    list.appendChild(ui.valueRow({ id: 'ntf-test', icon: 'bell', label: t('set.ntfTest'), desc: t('set.ntfTestHint'), noChevron: true, onClick: function () { api.toast(t('set.ntfTestText')).then(function () { ui.toast({ cls: 'good', title: t('toast.sent') }); }, ui.errorToast); } }));
    sec.appendChild(list);
  };

  /* ---------------- Diagnostics ---------------- */
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
    if (st.savesEngine) add(t('saves.engineTitle'), typeof st.savesEngine === 'string' ? st.savesEngine : (st.savesEngine.tier || ''));
    if (cb.safeMode()) add(t('a11y.safeMode'), cb.safeModeSession() ? t('a11y.safeModeSessionShort') : t('common.available'));
    add(t('diag.browser'), navigator.userAgent);
    add(t('diag.screen'), window.innerWidth + '×' + window.innerHeight + ' @' + (window.devicePixelRatio || 1) + 'x');
    sec.appendChild(h('div.panel', [h('h3', { text: t('diag.system'), style: { margin: '0 0 10px' } }), kv]));
    var logPanel = h('div.panel');
    var logBox = h('div.logbox', { nav: 'diag-log', text: t('diag.logLoading') });
    var head = h('div.row', { style: { marginBottom: '10px' } }, [h('h3', { text: t('diag.log'), style: { margin: 0 } }), h('span.spacer.grow')]);
    var rb = h('button.btn.sm', { nav: 'diag-log-refresh', text: t('common.refresh') }); rb.addEventListener('click', loadLog);
    var cbtn = h('button.btn.sm.ghost', { nav: 'diag-log-copy', text: t('common.copy') }); cbtn.addEventListener('click', function () { U.copyText(logBox.textContent).then(function (ok) { ui.toast({ cls: ok ? 'good' : 'bad', title: ok ? t('toast.copied') : t('toast.copyFailed') }); }); });
    head.appendChild(rb); head.appendChild(cbtn);
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

  /* ---------------- About ---------------- */
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
    [['Orbit Store', 'saawant12 · GPL-3.0 · ' + t('about.creditOrbit')], ['BlackBox', 'D3ATHLY · ' + t('about.creditBlackbox')], ['Overdrive', 'overdriveps5 · GPL-3.0 · ' + t('about.creditOverdrive')], ['ps5-payload-dev SDK', 'John Törnblom · ' + t('about.creditSdk')], ['CheatRunner / maj0r', t('about.creditCheat')], ['Cheat creators', t('about.creditCheatCreators')], ['hejran7', t('about.creditHejran')], ['qrcode-generator', 'Kazuhiko Arase · MIT · ' + t('about.creditQr')], ['prosperopatches / orbispatches', t('about.creditArt')], ['miniz', 'Rich Geldreich · MIT · ' + t('settings2.creditMiniz')], ['offact', 'ps5-payload-dev · ' + t('settings2.creditOffact')]].forEach(function (c) { credits.appendChild(h('div.credit', [h('b', { text: c[0] }), h('span', { text: c[1] })])); });
    sec.appendChild(credits);
    sec.appendChild(h('p.disclaimer', { text: t('about.license') }));
    sec.appendChild(h('p.disclaimer', { text: t('about.disclaimer') }));
  };

  /* ---------------- Uninstall XENO STORE (§17.16) ---------------- */
  BUILD.uninstall = function (sec) {
    sec.appendChild(h('p.dim.small', { text: t('uninstall.intro'), style: { marginTop: '-6px', marginBottom: '12px' } }));
    var list = h('div.list');
    list.appendChild(ui.valueRow({ id: 'uninstall-open', icon: 'trash', label: t('uninstall.row'), desc: t('uninstall.rowHint'), danger: true, onClick: function () { uninstallSheet(); } }));
    sec.appendChild(list);
    sec.appendChild(cb.note(t('uninstall.noGhosts'), '', 'shield'));
  };
  function uninstallSheet() {
    var st = { data: true, homebrew: true, payloadManager: false, keepDownloads: true };
    var handle = ui.sheet({
      title: t('uninstall.title'), sub: t('uninstall.sub'), cls: 'narrow', key: 'uninstall',
      body: function (body) {
        body.appendChild(cb.note(t('uninstall.warning'), 'warn'));
        body.appendChild(h('h3', { text: t('uninstall.what') }));
        var list = h('div.list');
        list.appendChild(cb.checkRow({ id: 'un-data', label: t('uninstall.data'), desc: t('uninstall.dataHint'), value: st.data, onChange: function (v) { st.data = v; paintFoot(); } }));
        list.appendChild(cb.checkRow({ id: 'un-homebrew', label: t('uninstall.homebrew'), desc: t('uninstall.homebrewHint'), value: st.homebrew, onChange: function (v) { st.homebrew = v; paintFoot(); } }));
        list.appendChild(cb.checkRow({ id: 'un-pm', label: t('uninstall.payloadManager'), desc: t('uninstall.payloadManagerHint'), value: st.payloadManager, onChange: function (v) { st.payloadManager = v; paintFoot(); } }));
        list.appendChild(cb.checkRow({ id: 'un-keep', label: t('uninstall.keepDownloads'), desc: t('uninstall.keepDownloadsHint'), value: st.keepDownloads, onChange: function (v) { st.keepDownloads = v; paintFoot(); } }));
        body.appendChild(list);
        body.appendChild(h('p.dim.small', { 'data-un-summary': '', text: '' }));
      },
      foot: [h('button.btn.ghost', { nav: 'un-cancel', 'data-autofocus': '', text: t('common.cancel'), on: { click: function () { ui.closeLayer(handle); } } }), h('span.spacer'), h('button.btn.danger', { nav: 'un-go', 'data-go': '', html: U.icon('trash') + '<span>' + U.escapeHtml(t('uninstall.go')) + '</span>', on: { click: go } })]
    });
    function paintFoot() {
      var any = st.data || st.homebrew || st.payloadManager || !st.keepDownloads;
      var b = handle.foot.querySelector('[data-go]'); if (any) b.removeAttribute('disabled'); else b.setAttribute('disabled', '');
      var sum = handle.body.querySelector('[data-un-summary]');
      if (sum) sum.textContent = !st.keepDownloads ? t('uninstall.summaryDeleteGames') : t('uninstall.summaryKeepGames');
    }
    function go() {
      var any = st.data || st.homebrew || st.payloadManager || !st.keepDownloads;
      if (!any) return;
      var text = (!st.keepDownloads ? t('uninstall.confirmGames') + ' ' : '') + t('uninstall.confirmText');
      ui.confirm(t('uninstall.confirmTitle'), text, t('uninstall.go'), true).then(function (ok) {
        if (!ok) return;
        var b = handle.foot.querySelector('[data-go]'); b.classList.add('busy');
        cb.api.uninstall({ data: st.data, homebrew: st.homebrew, payloadManager: st.payloadManager, downloads: !st.keepDownloads }).then(function (r) {
          b.classList.remove('busy');
          ui.closeLayer(handle);
          finalScreen(r);
        }, function (err) { b.classList.remove('busy'); ui.errorToast(err, t('uninstall.title')); });
      });
    }
    paintFoot();
  }
  function finalScreen(r) {
    var el = h('div.uninstalled', { role: 'dialog', 'aria-label': t('uninstall.doneTitle') });
    var box = h('div.box');
    box.appendChild(h('span.brand-badge', [h('img', { src: XS.logoSrc || '/logo.jpg', alt: '' })]));
    box.appendChild(h('h1', { text: t('uninstall.doneTitle') }));
    box.appendChild(h('p', { text: t('uninstall.doneText') }));
    var kv = [];
    var nRemoved = r.removedCount !== undefined ? r.removedCount : (r.removed || []).length;
    kv.push([nRemoved ? t('uninstall.removedN', { n: nRemoved }) : t('uninstall.nothingRemoved'), (r.removed || []).length ? h('div.paths', (r.removed || []).slice(0, 12).map(function (p) { return h('div.mono', { text: p }); })) : t('uninstall.nothing')]);
    if ((r.kept || []).length) kv.push([t('uninstall.kept'), h('div.paths', r.kept.slice(0, 12).map(function (p) { return h('div.mono', { text: p }); }))]);
    if ((r.failed || []).length) kv.push([t('uninstall.failed'), h('div.paths', r.failed.slice(0, 12).map(function (p) { return h('div.mono.bad', { text: p }); }))]);
    box.appendChild(h('div.panel', [cb.kv(kv)]));
    box.appendChild(h('p.dim.small', { text: t('uninstall.reinstall') }));
    box.appendChild(h('p.dim.small', { text: t('uninstall.thanks') }));
    el.appendChild(box);
    document.body.appendChild(el);
    try { U.store.set('wizardDone', false); } catch (e) { /* ignore */ }
  }

  XS.router.register('settings', {
    tab: false, icon: 'settings', label: function () { return t('nav.settings'); },
    mount: function (el) { root = el; },
    show: function (params) { if (params && params.group) group = params.group; render(); if (params && params.group) { var target = bodyEl.querySelector('[data-group="' + params.group + '"]'); if (target) { root.scrollTop = target.offsetTop - 10; var first = target.querySelector('[data-nav]'); if (first && !ui.layers.length) requestAnimationFrame(function () { if (!ui.layers.length && root.classList.contains('active')) XS.nav.focus(first, false); }); } } },
    refresh: function () { if (root && root.classList.contains('active')) render(); }
  });
  S.on('status', function () { /* values are read on render; avoid re-rendering under the user */ });
  XS.settingsScreen = { uninstallSheet: uninstallSheet, rerenderGroup: rerenderGroup };
})();
