/* XENO STORE — 90-boot.js: init order: nav → settings → mount → route → data → polling → first-run wizard. */
(function () {
  'use strict';
  var XS = window.XS, U = XS.util, S = XS.state, ui = XS.ui, api = XS.api, h = U.h, t = XS.t, R = XS.router, A = XS.actions;

  function firstRun() {
    var s = S.data.settings;
    if (!s || (s.sources && s.sources.acknowledged) || U.store.get('wizardDone', false)) return;
    var step = 0, enabled = {}, srcs = S.data.sources.length ? S.data.sources : [{ id: 'archive', name: 'Archive.org', kind: 'direct' }, { id: 'vikingfile', name: 'Vikingfile', kind: 'browser' }, { id: 'dlpsgame', name: 'DLPSGAME', kind: 'page' }];
    srcs.forEach(function (x) { enabled[x.id] = (s.sources && s.sources.enabled && s.sources.enabled[x.id] !== undefined) ? !!s.sources.enabled[x.id] : true; });
    var root = S.defaultRoot(), ack = false, hd = null;
    function paint() {
      var body = hd.body; U.clear(body); U.clear(hd.foot);
      var steps = h('div.steps'); for (var i = 0; i < 3; i++) steps.appendChild(h('i' + (i <= step ? '.on' : ''))); body.appendChild(steps);
      if (step === 0) {
        body.appendChild(h('div.wiz-hero', [h('span.brand-badge', [h('img', { src: XS.logoSrc || '/logo.jpg', alt: '' })]), h('div', [h('h2', { text: t('wizard.welcomeTitle') }), h('p', { text: t('wizard.welcomeText') })])]));
        body.appendChild(h('h3', { text: t('wizard.sourcesTitle') }));
        body.appendChild(h('p.dim', { text: t('wizard.sourcesText'), style: { marginBottom: '10px' } }));
        var list = h('div.list');
        srcs.forEach(function (x) { list.appendChild(ui.toggleRow({ id: 'wiz-src-' + x.id, icon: x.kind === 'browser' ? 'globe' : x.kind === 'page' ? 'external' : 'cloud', label: x.name, desc: x.notice || t('source.kind.' + (x.kind || 'direct')), value: enabled[x.id], onChange: function (v) { enabled[x.id] = v; } })); });
        body.appendChild(list);
        body.appendChild(h('div.panel', { style: { marginTop: '12px' } }, [h('div.row', [ui.svg('alert'), h('b', { text: t('set.sourceNotice') })]), h('p.dim', { text: t('set.sourceNoticeText'), style: { marginTop: '8px', fontSize: '13.5px' } })]));
        body.appendChild(ui.toggleRow({ id: 'wiz-ack', icon: 'check', label: t('set.acknowledge'), value: ack, onChange: function (v) { ack = v; var nb = hd.foot.querySelector('[data-next]'); if (nb) nb.toggleAttribute('disabled', !v); } }));
        hd.foot.appendChild(h('button.btn.ghost', { nav: 'wiz-skip', text: t('wizard.skip'), on: { click: function () { U.store.set('wizardDone', true); ui.closeLayer(hd); } } }));
        hd.foot.appendChild(h('span.spacer'));
        var next = h('button.btn.primary', { nav: 'wiz-next', 'data-next': '', text: t('common.next'), on: { click: function () { if (!ack) return; step = 1; paint(); } } });
        if (!ack) next.setAttribute('disabled', '');
        hd.foot.appendChild(next);
      } else if (step === 1) {
        body.appendChild(h('h3', { text: t('wizard.driveTitle') }));
        body.appendChild(h('p.dim', { text: t('wizard.driveText'), style: { marginBottom: '10px' } }));
        var roots = S.data.storage || [];
        if (!roots.length) body.appendChild(h('div.panel', [h('span.dim', { text: t('lib.noDrives') })]));
        var rl = h('div.list');
        roots.forEach(function (r, i) {
          var sel = root && root.path === r.path;
          var row = h('button.lrow' + (sel ? '.sel' : ''), { nav: 'wiz-root-' + i, data: { hints: 'select' } });
          if (sel) row.setAttribute('data-autofocus', '');
          row.appendChild(h('span.ic', { html: U.icon(r.kind === 'usb' ? 'usb' : r.kind === 'm2' ? 'm2' : 'hdd') }));
          row.appendChild(h('div.main', [h('div.name', { text: r.label }), h('div.desc', { text: r.path + ' · ' + t('dl.free', { n: U.fmtBytes(r.free) }) })]));
          row.appendChild(h('span.check', { html: sel ? U.icon('check') : '' }));
          row.addEventListener('click', function () { root = r; U.$$('.lrow', rl).forEach(function (x) { x.classList.remove('sel'); x.querySelector('.check').innerHTML = ''; }); row.classList.add('sel'); row.querySelector('.check').innerHTML = U.icon('check'); });
          rl.appendChild(row);
        });
        body.appendChild(rl);
        hd.foot.appendChild(h('button.btn.ghost', { nav: 'wiz-back', text: t('common.back'), on: { click: function () { step = 0; paint(); } } }));
        hd.foot.appendChild(h('span.spacer'));
        hd.foot.appendChild(h('button.btn.primary', { nav: 'wiz-next2', 'data-autofocus': roots.length ? null : '', text: t('common.next'), on: { click: function () { step = 2; paint(); } } }));
      } else {
        body.appendChild(h('div.wiz-hero', [h('span.ic', { style: { width: '72px', height: '72px', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(255,206,74,.14)', color: 'var(--gold)', flex: '0 0 auto' }, html: U.icon('check').replace('<svg ', '<svg style="width:34px;height:34px;fill:none;stroke:currentColor;stroke-width:2.5" ') }), h('div', [h('h2', { text: t('wizard.doneTitle') }), h('p', { text: t('wizard.doneText') })])]));
        var kv = h('dl.kv');
        kv.appendChild(h('dt', { text: t('wizard.sourcesTitle') })); kv.appendChild(h('dd', { text: srcs.filter(function (x) { return enabled[x.id]; }).map(function (x) { return x.name; }).join(', ') || '—' }));
        kv.appendChild(h('dt', { text: t('set.defaultDrive') })); kv.appendChild(h('dd', { text: root ? root.label + ' (' + root.path + ')' : '—' }));
        body.appendChild(h('div.panel', [kv]));
        body.appendChild(h('p.dim', { text: t('wizard.tips'), style: { marginTop: '14px' } }));
        hd.foot.appendChild(h('button.btn.ghost', { nav: 'wiz-back2', text: t('common.back'), on: { click: function () { step = 1; paint(); } } }));
        hd.foot.appendChild(h('span.spacer'));
        hd.foot.appendChild(h('button.btn.primary.lg', { nav: 'wiz-finish', 'data-autofocus': '', text: t('wizard.finish'), on: { click: finish } }));
      }
      requestAnimationFrame(function () { XS.nav.focusFirst(hd.el); });
    }
    function finish() {
      var partial = { sources: { enabled: enabled, acknowledged: true } };
      if (root) partial.downloads = { defaultRoot: root.path };
      api.settingsPut(partial).then(function (r) { if (r.settings) { S.set('settings', r.settings); A.applySettings(r.settings); } }, function () { /* offline: local only */ });
      if (root) api.storageDefault(root.path).then(function () { return api.storage(); }).then(function (r) { S.set('storage', r.roots || []); }, function () { /* ignore */ });
      U.store.set('wizardDone', true);
      ui.closeLayer(hd);
      ui.toast({ cls: 'gold', title: t('wizard.readyToast') });
    }
    hd = ui.sheet({ title: t('wizard.title'), key: 'wizard', cls: 'wide', body: function () { /* painted below */ } });
    paint();
  }

  function boot() {
    XS.logoSrc = (document.querySelector('.brand-badge img') || {}).src || '/logo.jpg';
    XS.nav.init();
    api.settings().then(function (s) { S.data.settings = s; }, function () { S.data.settings = null; }).then(function () {
      A.applySettings(S.data.settings || {});
      R.mount();
      R.start();
      var first = A.reloadCatalog(true).then(null, function () { /* banner */ });
      A.reloadAll().then(function () { R.startPolling(); first.then(firstRun); });
      if (S.data.settings && S.data.settings.updates && S.data.settings.updates.autoCheck !== false) {
        setTimeout(function () { api.updateCheck().then(function (r) { if (r && r.available) { S.data.status = S.data.status || {}; S.data.status.update = { available: true, latest: r.latest, current: r.current, notes: r.notes || '', url: r.url }; S.emit('status', S.data.status); } }, function () { /* quiet */ }); }, 4000);
      }
    });
    document.addEventListener('visibilitychange', function () { if (!document.hidden) { A.refreshQueue().then(null, function () { /* ignore */ }); } });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
