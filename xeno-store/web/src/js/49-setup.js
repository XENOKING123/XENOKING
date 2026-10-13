/* XENO STORE — 49-setup.js: Setup screen (§17.6, §17.16): readiness checklist from /api/setup/check with fixes and
   actions ("Launch ShadowMountPlus now"), "Add XENO STORE to Payload Manager" (source URL + QR), companion payloads
   (install / launch through the local ELF loader), ghost icon cleaner (/api/homebrew-dirs with a double confirm).
   Reachable from Settings → Setup and offered once after the first run. */
(function () {
  'use strict';
  var XS = window.XS, U = XS.util, S = XS.state, ui = XS.ui, cb = XS.cb, h = U.h, t = XS.t;
  var root = null, els = {}, data = { checks: null, payloads: null, dirs: null, checkBusy: false }, want = '';

  function render() {
    if (!root) return;
    U.clear(root); els = {};
    var inner = h('div.screen-inner'); root.appendChild(inner);
    var head = h('div.page-head', [h('div.grow', [h('span.kicker', { text: t('nav.settings') }), h('h1', { text: t('setup.title') }), h('p.dim', { text: t('setup.sub') })])]);
    var run = h('button.btn.primary', { nav: 'setup-run', html: U.icon('refresh') + '<span>' + U.escapeHtml(t('setup.runCheck')) + '</span>' });
    run.addEventListener('click', function () { runCheck(true); });
    head.appendChild(run);
    inner.appendChild(head);
    /* jump chips */
    var jumps = h('div.chips.setup-jumps', { data: { navRegion: '' } });
    [['checks', t('setup.checklist')], ['pm', t('setup.payloadManager')], ['payloads', t('companions.title')], ['ghost', t('setup.ghostCleaner')]].forEach(function (j) {
      var c = h('button.chip', { nav: 'setup-jump-' + j[0], text: j[1] });
      c.addEventListener('click', function () { jump(j[0]); });
      jumps.appendChild(c);
    });
    inner.appendChild(jumps);
    /* checklist */
    inner.appendChild(section(inner, 'checks', t('setup.checklist'), t('setup.checklistHint')));
    els.checks = h('div.list', { data: { navRegion: '' } }); inner.appendChild(els.checks);
    /* payload manager */
    inner.appendChild(section(inner, 'pm', t('setup.payloadManager'), t('setup.payloadManagerHint')));
    els.pm = h('div', { data: { navRegion: '' } }); inner.appendChild(els.pm);
    /* companions */
    inner.appendChild(section(inner, 'payloads', t('companions.title'), t('companions.hint')));
    els.payloads = h('div', { data: { navRegion: '' } }); inner.appendChild(els.payloads);
    /* ghost icons */
    inner.appendChild(section(inner, 'ghost', t('setup.ghostCleaner'), t('setup.ghostCleanerHint')));
    els.ghost = h('div', { data: { navRegion: '' } }); inner.appendChild(els.ghost);
    paintChecks(); paintPm(); paintPayloads(); paintDirs();
    if (!data.checks) runCheck(false);
    if (!data.payloads) loadPayloads();
    if (!data.dirs) loadDirs();
    if (want) { var w = want; want = ''; requestAnimationFrame(function () { jump(w); }); }
  }
  function section(inner, id, title, hint) {
    return h('div.section-head', { data: { setupSection: id } }, [h('div.grow', [h('h2.section-title', { text: title }), h('p.dim.small', { text: hint, style: { marginTop: '2px' } })])]);
  }
  function jump(id) {
    var sec = root.querySelector('[data-setup-section="' + id + '"]'); if (!sec) return;
    root.scrollTo({ top: Math.max(0, sec.offsetTop - 12), behavior: U.reducedMotion() ? 'auto' : 'smooth' });
    var box = els[id === 'checks' ? 'checks' : id];
    var first = box && box.querySelector('[data-nav]');
    if (first) setTimeout(function () { XS.nav.focus(first, false); }, 80);
  }

  /* ---------- readiness checklist ---------- */
  var CHECK_ICON = { shadowmount: 'zap', dpi: 'box', etahen: 'box', internet: 'wifi', drive: 'hdd', space: 'hdd', firmware: 'shield', 'payload-manager': 'qr' };
  function runCheck(force) {
    if (data.checkBusy) return;
    data.checkBusy = true;
    var btn = root && root.querySelector('[data-nav-id="setup-run"]'); if (btn) btn.classList.add('busy');
    if (els.checks && !data.checks) { U.clear(els.checks); els.checks.appendChild(cb.busy(t('setup.checking'))); }
    cb.api.setupCheck(force).then(function (r) {
      data.checkBusy = false; data.checks = r; if (btn) btn.classList.remove('busy');
      paintChecks();
      if (force) { var ok = (r.checks || []).filter(function (c) { return c.ok; }).length, n = (r.checks || []).length; ui.toast({ cls: ok === n ? 'good' : 'gold', title: ok === n ? t('setup.allOk', { n: n }) : t('setup.someFailing', { ok: ok, n: n }) }); }
      if (XS.actions && XS.actions.refreshStatus) XS.actions.refreshStatus().then(null, function () { /* ignore */ });
    }, function (err) { data.checkBusy = false; if (btn) btn.classList.remove('busy'); if (els.checks) { U.clear(els.checks); els.checks.appendChild(ui.emptyState(t('setup.checkFailed'), ui.errorText(err))); } });
  }
  function paintChecks() {
    var box = els.checks; if (!box || !data.checks) return;
    U.clear(box);
    var list = data.checks.checks || [];
    var ok = list.filter(function (c) { return c.ok; }).length;
    var summary = h('div.setup-summary' + (ok === list.length ? '.ok' : ''), [
      h('span.ring', { html: U.icon(ok === list.length ? 'check' : 'alert') }),
      h('div.grow', [h('b', { text: ok === list.length ? t('setup.allOk', { n: list.length }) : t('setup.someFailing', { ok: ok, n: list.length }) }), h('span.dim.small', { text: (data.checks.fw ? t('game2.firmware') + ' ' + data.checks.fw + ' · ' : '') + (data.checks.summary && data.checks.summary.at ? t('setup.checkedAt', { when: cb.fmtAgo(data.checks.summary.at) }) : t('setup.checkedNow')) })])
    ]);
    box.appendChild(summary);
    list.forEach(function (c) {
      var row = h('div.lrow.check-row' + (c.ok ? '.ok' : c.optional ? '.opt' : '.fail'), { nav: 'check-' + c.id, data: { hints: 'select' } });
      row.appendChild(h('span.ic', { html: U.icon(CHECK_ICON[c.id] || 'info') }));
      var main = h('div.main', [h('div.name', [XS.i18n.has('setup.check.' + c.id) ? t('setup.check.' + c.id) : c.id, h('span.chip.sm' + (c.ok ? '.good' : c.optional ? '.warn' : '.bad'), { text: c.ok ? t('setup.ok') : c.optional ? t('setup.optional') : t('setup.fix'), style: { marginInlineStart: '8px' } })])]);
      if (c.detail) main.appendChild(h('div.desc', { text: c.detail }));
      if (!c.ok && c.fix) main.appendChild(h('div.fixline', [ui.svg('info'), h('span', { text: c.fix })]));
      row.appendChild(main);
      if (!c.ok && c.action === 'launch' && c.actionId) {
        var b = h('button.btn.sm.primary', { nav: 'check-' + c.id + '-launch', html: U.icon('play') + '<span>' + U.escapeHtml(c.id === 'shadowmount' ? t('setup.launchShadow') : t('companions.launch')) + '</span>' });
        b.addEventListener('click', function (e) { e.stopPropagation(); launchPayload({ id: c.actionId, name: c.id === 'shadowmount' ? 'ShadowMountPlus' : c.actionId }, b).then(function () { setTimeout(function () { runCheck(true); }, 2500); }); });
        row.appendChild(b);
      } else if (!c.ok && c.action === 'install' && c.actionId) {
        var b2 = h('button.btn.sm.primary', { nav: 'check-' + c.id + '-install', text: t('companions.install') });
        b2.addEventListener('click', function (e) { e.stopPropagation(); jump('payloads'); });
        row.appendChild(b2);
      } else if (!c.ok && c.id === 'payload-manager') {
        var b3 = h('button.btn.sm', { nav: 'check-' + c.id + '-pm', text: t('setup.showQr') });
        b3.addEventListener('click', function (e) { e.stopPropagation(); jump('pm'); });
        row.appendChild(b3);
      } else if (!c.ok && (c.id === 'drive' || c.id === 'space')) {
        var b4 = h('button.btn.sm', { nav: 'check-' + c.id + '-lib', text: t('nav.library') });
        b4.addEventListener('click', function (e) { e.stopPropagation(); XS.router.go('library'); });
        row.appendChild(b4);
      }
      row.addEventListener('click', function (e) { if (e.target.closest('button')) return; checkDetail(c); });
      box.appendChild(row);
    });
    if (!list.length) box.appendChild(ui.emptyState(t('setup.noChecks'), ''));
  }
  function checkDetail(c) {
    var body = [];
    if (c.detail) body.push(h('p', { text: c.detail }));
    if (c.fix) body.push(cb.note(c.fix, c.ok ? '' : 'warn', c.ok ? 'check' : 'info'));
    if (XS.i18n.has('setup.explain.' + c.id)) body.push(h('p.dim.small', { text: t('setup.explain.' + c.id) }));
    ui.dialog({ title: XS.i18n.has('setup.check.' + c.id) ? t('setup.check.' + c.id) : c.id, body: body, buttons: [{ label: t('common.close'), primary: true, autofocus: true }] });
  }

  /* ---------- Payload Manager source ---------- */
  function paintPm() {
    var box = els.pm; if (!box) return;
    U.clear(box);
    var url = (data.checks && data.checks.payloadsUrl) || cb.sget('updates.feed', '') || 'https://raw.githubusercontent.com/XENOKING123/XENOKING/main/xeno-store/updates/payloads.json';
    var panel = h('div.panel.pm-panel');
    panel.appendChild(ui.qr(url));
    panel.appendChild(h('div.pair-url.small', { text: url }));
    panel.appendChild(h('p.dim', { text: t('setup.pmText'), style: { textAlign: 'center', marginTop: '10px' } }));
    var acts = h('div.btn-row', { style: { justifyContent: 'center', marginTop: '12px' } });
    acts.appendChild(h('button.btn.sm', { nav: 'pm-copy', html: U.icon('copy') + '<span>' + U.escapeHtml(t('game2.copyUrl')) + '</span>', on: { click: function () { U.copyText(url).then(function (ok) { ui.toast({ cls: ok ? 'good' : 'bad', title: ok ? t('toast.copied') : t('toast.copyFailed') }); }); } } }));
    acts.appendChild(h('button.btn.sm.ghost', { nav: 'pm-open', html: U.icon('external') + '<span>' + U.escapeHtml(t('game2.openInBrowser')) + '</span>', on: { click: function () { U.openExternal(url); } } }));
    panel.appendChild(acts);
    box.appendChild(panel);
    box.appendChild(h('ol.setup-steps', [h('li', { text: t('setup.pmStep1') }), h('li', { text: t('setup.pmStep2') }), h('li', { text: t('setup.pmStep3') })]));
  }

  /* ---------- companion payloads ---------- */
  function loadPayloads() {
    if (els.payloads && !data.payloads) { U.clear(els.payloads); els.payloads.appendChild(cb.busy(t('companions.loading'))); }
    cb.api.payloads().then(function (r) { data.payloads = r; paintPayloads(); }, function (err) { if (els.payloads) { U.clear(els.payloads); els.payloads.appendChild(ui.emptyState(t('companions.loadFailed'), ui.errorText(err))); } });
  }
  function paintPayloads() {
    var box = els.payloads; if (!box || !data.payloads) return;
    U.clear(box);
    var r = data.payloads, list = r.payloads || [];
    var head = h('div.row', { style: { marginBottom: '10px', flexWrap: 'wrap' } });
    head.appendChild(h('span.chip' + (r.loaderAvailable ? '.good' : '.warn'), { html: U.icon(r.loaderAvailable ? 'check' : 'alert') + '<span>' + U.escapeHtml(r.loaderAvailable ? t('companions.loaderOk', { port: r.loaderPort || 9021 }) : t('companions.loaderMissing', { port: r.loaderPort || 9021 })) + '</span>' }));
    if (r.feedFetchedAt) head.appendChild(h('span.dim.small', { text: t('companions.feedAt', { when: cb.fmtAgo(r.feedFetchedAt) }), style: { marginTop: 0 } }));
    head.appendChild(h('span.spacer'));
    var rf = h('button.btn.sm.ghost', { nav: 'pl-refresh', html: U.icon('refresh') + '<span>' + U.escapeHtml(t('common.refresh')) + '</span>' });
    rf.addEventListener('click', function () { data.payloads = null; loadPayloads(); });
    head.appendChild(rf);
    box.appendChild(head);
    if (!list.length) { box.appendChild(ui.emptyState(t('companions.empty'), t('companions.emptyHint'))); return; }
    var rows = h('div.list');
    list.forEach(function (p) {
      var row = h('div.lrow.payload-row' + (p.installed ? '.on' : ''), { nav: 'pl-' + p.id, data: { hints: 'select' } });
      row.appendChild(h('span.ic', { html: U.icon(kindIcon(p)) }));
      var main = h('div.main', [h('div.name', [p.name, p.version ? h('span.dim.small', { text: 'v' + p.version, style: { marginInlineStart: '8px', marginTop: 0 } }) : null])]);
      if (p.notes) main.appendChild(h('div.desc', { text: p.notes }));
      var tags = h('div.tags');
      if (p.installed) tags.appendChild(h('span.chip.sm.good', { text: t('companions.installedLocal') + (p.installedVersion ? ' · v' + p.installedVersion : '') }));
      else tags.appendChild(h('span.chip.sm', { text: t('companions.notDownloaded') }));
      if (p.updateAvailable) tags.appendChild(h('span.chip.sm.warn', { text: t('lib2.updateAvailable', { v: p.version }) }));
      if (p.size) tags.appendChild(h('span.chip.sm', { text: U.fmtBytes(p.size) }));
      if (p.sha256) tags.appendChild(h('span.chip.sm.gold', { text: t('companions.shaChecked') }));
      if (p.kind) tags.appendChild(h('span.chip.sm', { text: p.kind }));
      main.appendChild(tags);
      row.appendChild(main);
      var act = h('button.btn.sm' + (p.installed && !p.updateAvailable ? '' : '.primary'), { nav: 'pl-' + p.id + '-' + (p.installed && !p.updateAvailable ? 'launch' : 'install'), html: U.icon(p.installed && !p.updateAvailable ? 'play' : 'download') + '<span>' + U.escapeHtml(p.installed && !p.updateAvailable ? t('companions.launch') : (p.updateAvailable ? t('lib2.updateBtn') : t('companions.install'))) + '</span>' });
      act.addEventListener('click', function (e) { e.stopPropagation(); payloadAction(p, act); });
      row.appendChild(act);
      var more = h('button.btn.sm.icon-only', { nav: 'pl-' + p.id + '-more', html: U.icon('more'), 'aria-label': t('common.more') });
      more.addEventListener('click', function (e) { e.stopPropagation(); payloadMenu(more, p); });
      row.appendChild(more);
      row.addEventListener('click', function (e) { if (e.target.closest('button')) return; payloadMenu(row, p); });
      rows.appendChild(row);
    });
    box.appendChild(rows);
    box.appendChild(cb.note(r.note || t('companions.note'), '', 'shield'));
  }
  function kindIcon(p) { var k = String((p.kind || '') + ' ' + (p.id || '')).toLowerCase(); if (/shadow|mount/.test(k)) return 'zap'; if (/dpi|install/.test(k)) return 'box'; if (/sign|np/.test(k)) return 'cloud'; if (/dump/.test(k)) return 'hdd'; if (/save|garlic/.test(k)) return 'shield'; return 'box'; }
  function payloadMenu(anchor, p) {
    var items = [];
    if (p.installed) items.push({ label: t('companions.launch'), sub: t('companions.launchSub', { port: (data.payloads && data.payloads.loaderPort) || 9021 }), icon: 'play', onSelect: function () { launchPayload(p); } });
    items.push({ label: p.installed ? t('companions.reinstall') : t('companions.install'), sub: p.url ? cb.hostOf(p.url) : '', icon: 'download', onSelect: function () { installPayload(p); } });
    if (p.homepage) items.push({ label: t('game2.openInBrowser'), sub: cb.hostOf(p.homepage), icon: 'external', onSelect: function () { U.openExternal(p.homepage); } });
    if (p.localPath) items.push({ label: t('lib.copyPath'), icon: 'copy', onSelect: function () { U.copyText(p.localPath).then(function (ok) { ui.toast({ cls: ok ? 'good' : 'bad', title: ok ? t('toast.copied') : t('toast.copyFailed') }); }); } });
    ui.menu(anchor, items, { title: p.name });
  }
  function payloadAction(p, btn) { if (p.installed && !p.updateAvailable) return launchPayload(p, btn); return installPayload(p, btn); }
  function installPayload(p, btn) {
    if (btn) btn.classList.add('busy');
    return cb.api.payloadInstall(p.id).then(function (r) {
      var job = r.job || null;
      if (!job || !job.id) { if (btn) btn.classList.remove('busy'); ui.toast({ cls: 'good', title: t('companions.installed', { name: p.name }) }); data.payloads = null; loadPayloads(); return true; }
      var toast = ui.toast({ cls: 'gold', icon: 'download', title: t('companions.downloading', { name: p.name }), desc: '', timeout: 120000 });
      return cb.watchJob(job.id, function (j) { var d = toast.el.querySelector('.d'); if (d) d.textContent = j.total ? U.fmtBytes(j.done || 0) + ' / ' + U.fmtBytes(j.total) : (j.message || ''); }).then(function (j) {
        toast.close(); if (btn) btn.classList.remove('busy');
        if (j.state === 'done') { XS.sound && XS.sound.done(); ui.toast({ cls: 'good', title: t('companions.installed', { name: p.name }), desc: j.result && j.result.verified ? t('companions.shaChecked') : (j.message || ''), action: { label: t('companions.launch'), onClick: function () { launchPayload(p); } } }); }
        else ui.toast({ cls: 'bad', title: t('companions.installFailed', { name: p.name }), desc: j.error || j.message || '', timeout: 8000 });
        data.payloads = null; loadPayloads();
        return j.state === 'done';
      }, function (err) { toast.close(); if (btn) btn.classList.remove('busy'); ui.errorToast(err, p.name); return false; });
    }, function (err) { if (btn) btn.classList.remove('busy'); ui.errorToast(err, t('companions.install')); return false; });
  }
  function launchPayload(p, btn) {
    if (btn) btn.classList.add('busy');
    return cb.api.payloadLaunch(p.id).then(function (r) {
      if (btn) btn.classList.remove('busy');
      XS.sound && XS.sound.done();
      ui.toast({ cls: 'good', icon: 'play', title: t('companions.sent', { name: p.name }), desc: t('companions.sentDesc', { size: U.fmtBytes(r.bytes || 0), port: r.port || 9021 }) });
      return true;
    }, function (err) { if (btn) btn.classList.remove('busy'); ui.errorToast(err, t('companions.launch')); return false; });
  }

  /* ---------- ghost icon cleaner ---------- */
  function loadDirs() {
    if (els.ghost && !data.dirs) { U.clear(els.ghost); els.ghost.appendChild(cb.busy(t('setup.ghostLoading'))); }
    cb.api.homebrewDirs().then(function (r) { data.dirs = r; paintDirs(); }, function (err) { if (els.ghost) { U.clear(els.ghost); els.ghost.appendChild(ui.emptyState(t('setup.ghostLoadFailed'), ui.errorText(err))); } });
  }
  function paintDirs() {
    var box = els.ghost; if (!box || !data.dirs) return;
    U.clear(box);
    var dirs = (data.dirs.dirs || []).slice();
    box.appendChild(cb.note(data.dirs.note || t('setup.ghostNote'), '', 'info'));
    var head = h('div.row', { style: { margin: '10px 0' } }, [h('span.dim.small', { text: t('setup.ghostRoot', { root: data.dirs.root || '/data/homebrew' }), style: { marginTop: 0 } }), h('span.spacer'), h('button.btn.sm.ghost', { nav: 'ghost-refresh', html: U.icon('refresh') + '<span>' + U.escapeHtml(t('common.refresh')) + '</span>', on: { click: function () { data.dirs = null; loadDirs(); } } })]);
    box.appendChild(head);
    if (!dirs.length) { box.appendChild(ui.emptyState(t('setup.ghostEmpty'), t('setup.ghostEmptyHint'))); return; }
    dirs.sort(function (a, b) { return (a.isXenoStore ? 1 : 0) - (b.isXenoStore ? 1 : 0) || (b.mtime || 0) - (a.mtime || 0); });
    var rows = h('div.list');
    dirs.forEach(function (d) {
      var ghost = !d.hasEboot;
      var row = h('div.lrow.ghost-row' + (ghost ? '.ghost' : ''), { nav: 'ghost-' + d.name, data: { hints: 'select' } });
      row.appendChild(h('span.ic', { html: U.icon(d.hasIcon ? 'image' : 'folder') }));
      var main = h('div.main', [h('div.name', [d.title || d.name, d.isXenoStore ? h('span.chip.sm.gold', { text: 'XENO STORE', style: { marginInlineStart: '8px' } }) : null])]);
      main.appendChild(h('div.desc.mono', { text: d.path || d.name }));
      var tags = h('div.tags', [h('span.chip.sm', { text: U.fmtBytes(d.size || 0) })]);
      tags.appendChild(d.hasEboot ? h('span.chip.sm.good', { text: t('setup.hasEboot') }) : h('span.chip.sm.warn', { text: t('setup.noEboot') }));
      tags.appendChild(d.hasIcon ? h('span.chip.sm', { text: t('setup.hasIcon') }) : h('span.chip.sm.warn', { text: t('setup.noIcon') }));
      if (ghost) tags.appendChild(h('span.chip.sm.bad', { text: t('setup.ghostLikely') }));
      if (d.mtime) tags.appendChild(h('span.chip.sm', { text: cb.fmtAgo(d.mtime) }));
      main.appendChild(tags);
      row.appendChild(main);
      var del = h('button.btn.sm' + (d.isXenoStore ? '.ghost' : '.danger'), { nav: 'ghost-' + d.name + '-delete', html: U.icon('trash') + '<span>' + U.escapeHtml(t('common.delete')) + '</span>' });
      del.addEventListener('click', function (e) { e.stopPropagation(); deleteDir(d); });
      row.appendChild(del);
      row.addEventListener('click', function (e) { if (e.target.closest('button')) return; deleteDir(d); });
      rows.appendChild(row);
    });
    box.appendChild(rows);
  }
  function deleteDir(d) {
    var text = t('setup.ghostDeleteText', { name: d.name, size: U.fmtBytes(d.size || 0) }) + (d.isXenoStore ? ' ' + t('setup.ghostDeleteSelf') : '');
    cb.doubleConfirm(t('setup.ghostDeleteTitle', { name: d.title || d.name }), text, t('common.delete'), t('setup.ghostDeleteSure', { name: d.name })).then(function (ok) {
      if (!ok) return;
      cb.api.homebrewDirDelete(d.name).then(function () {
        ui.toast({ cls: 'good', title: t('setup.ghostDeleted', { name: d.name }), desc: t('setup.ghostDeletedHint') });
        data.dirs = null; loadDirs();
      }, function (err) { ui.errorToast(err, t('common.delete')); });
    });
  }

  /* ---------- first-run nudge: once, as a toast (never a blocking layer) ---------- */
  var nudged = false;
  S.on('status', function (st) {
    if (nudged || !st || !st.setup || U.store.get('setupNudged', false) === true) return;
    var s = S.data.settings;
    if (!s || !s.sources || !s.sources.acknowledged) return;      /* the first-run wizard comes first */
    if (ui.layers.length || U.isPhone()) return;
    if (st.setup.checked && st.setup.ok === st.setup.total) { U.store.set('setupNudged', true); nudged = true; return; }
    nudged = true; U.store.set('setupNudged', true);
    ui.toast({ cls: 'gold', icon: 'check', title: t('setup.nudgeTitle'), desc: t('setup.nudgeText'), timeout: 14000, action: { label: t('setup.nudgeAction'), onClick: function () { XS.router.go('setup', { section: 'checks' }); } } });
  });

  XS.router.register('setup', {
    tab: false, icon: 'check', label: function () { return t('setup.title'); },
    mount: function (el) { root = el; },
    show: function (params) { if (params && params.section) want = params.section; render(); },
    refresh: function () { if (root && root.classList.contains('active')) render(); }
  });
  XS.setupScreen = { payloadAction: payloadAction, launchPayload: launchPayload, installPayload: installPayload, runCheck: runCheck };
})();
