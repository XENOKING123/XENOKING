/* XENO STORE — 43-downloads.js: summary strip, tabs, job rows with segment bars, sparkline, retry countdown, state-driven actions. */
(function () {
  'use strict';
  var XS = window.XS, U = XS.util, S = XS.state, ui = XS.ui, api = XS.api, h = U.h, t = XS.t;
  var root = null, tab = 'active', listEl = null, summaryEl = null, tabsEl = null, rows = {};
  var TABS = {
    active: ['downloading', 'connecting', 'verifying', 'installing', 'paused'],
    queued: ['queued'],
    finished: ['done', 'installed'],
    failed: ['failed'],
    cancelled: ['cancelled']
  };
  function tabOf(j) { for (var k in TABS) if (TABS[k].indexOf(j.state) >= 0) return k; return 'active'; }
  function counts() { var c = { active: 0, queued: 0, finished: 0, failed: 0, cancelled: 0 }; S.data.queue.jobs.forEach(function (j) { c[tabOf(j)]++; }); return c; }

  function render() {
    if (!root) return;
    U.clear(root); rows = {};
    var inner = h('div.screen-inner');
    root.appendChild(inner);
    summaryEl = h('div.dl-summary'); inner.appendChild(summaryEl);
    var tools = h('div.dl-tools', { data: { navRegion: '' } });
    var c = counts();
    tabsEl = ui.subtabs({ id: 'dltab', value: tab, tabs: ['active', 'queued', 'finished', 'failed', 'cancelled'].map(function (k) { return { id: k, label: t('dl.tab.' + k), count: c[k] }; }), onChange: function (id) { tab = id; renderList(); } });
    tools.appendChild(tabsEl);
    tools.appendChild(h('span.spacer'));
    var pauseAll = h('button.btn.sm', { nav: 'dl-pauseall', html: U.icon('pause') + '<span>' + U.escapeHtml(t('dl.pauseAll')) + '</span>' });
    pauseAll.addEventListener('click', function () { bulk(['downloading', 'connecting', 'queued'], 'pause'); });
    var resumeAll = h('button.btn.sm', { nav: 'dl-resumeall', html: U.icon('play') + '<span>' + U.escapeHtml(t('dl.resumeAll')) + '</span>' });
    resumeAll.addEventListener('click', function () { bulk(['paused'], 'resume'); });
    var clear = h('button.btn.sm.ghost', { nav: 'dl-clear', html: U.icon('trash') + '<span>' + U.escapeHtml(t('dl.clearFinished')) + '</span>' });
    clear.addEventListener('click', function () { api.queueClear(['done', 'installed', 'cancelled']).then(function (r) { ui.toast({ cls: 'good', title: t('toast.cleared', { n: r.removed || 0 }) }); XS.actions.refreshQueue(); }, ui.errorToast); });
    tools.appendChild(pauseAll); tools.appendChild(resumeAll); tools.appendChild(clear);
    inner.appendChild(tools);
    listEl = h('div.jobs', { data: { navRegion: '' } });
    inner.appendChild(listEl);
    renderSummary();
    renderList();
  }
  function bulk(states, action) {
    var js = S.data.queue.jobs.filter(function (j) { return states.indexOf(j.state) >= 0; });
    if (!js.length) return;
    var p = Promise.resolve();
    js.forEach(function (j) { p = p.then(function () { return api.queueAction(j.id, action).then(null, function () { /* keep going */ }); }); });
    p.then(function () { XS.actions.refreshQueue(); });
  }

  function renderSummary() {
    if (!summaryEl) return;
    var s = S.data.queue.summary || {};
    var jobs = S.data.queue.jobs;
    var speed = s.speed || 0, remaining = s.remaining || 0, eta = s.eta;
    if (eta === undefined) eta = speed > 0 ? remaining / speed : 0;
    var r = S.defaultRoot();
    var active = s.active !== undefined ? s.active : jobs.filter(function (j) { return j.state === 'downloading' || j.state === 'connecting'; }).length;
    U.clear(summaryEl);
    summaryEl.appendChild(stat(t('dl.sum.speed'), U.fmtSpeed(speed), speed > 0 ? 'gold' : ''));
    summaryEl.appendChild(stat(t('dl.sum.remaining'), U.fmtBytes(remaining)));
    summaryEl.appendChild(stat(t('dl.sum.eta'), speed > 0 && remaining > 0 ? U.fmtDur(eta) : '—'));
    summaryEl.appendChild(stat(t('dl.sum.free'), r ? U.fmtBytes(r.free) : '—', '', r ? r.label : ''));
    summaryEl.appendChild(stat(t('dl.sum.active'), String(active), '', t('dl.sum.queuedN', { n: s.queued || jobs.filter(function (j) { return j.state === 'queued'; }).length })));
    var ka = h('div.stat.pill' + (s.keepAwake ? '.on' : ''), [h('i.dot'), h('div', [h('div.k', { text: t('dl.sum.keepAwake') }), h('div.v', { text: s.keepAwake ? t('dl.sum.keepAwakeOn') : t('dl.sum.keepAwakeOff') })])]);
    summaryEl.appendChild(ka);
  }
  function stat(k, v, cls, small) {
    var el = h('div.stat' + (cls ? '.' + cls : ''), [h('div.k', { text: k }), h('div.v', [v, small ? h('small', { text: small }) : null])]);
    return el;
  }

  function visibleJobs() {
    var js = S.data.queue.jobs.filter(function (j) { return tabOf(j) === tab; });
    var order = ['downloading', 'connecting', 'verifying', 'installing', 'paused', 'queued', 'failed', 'done', 'installed', 'cancelled'];
    js.sort(function (a, b) { var d = order.indexOf(a.state) - order.indexOf(b.state); if (d) return d; if (a.state === 'queued') return (a.priority - b.priority) || (a.addedAt - b.addedAt); return (b.finishedAt || b.addedAt) - (a.finishedAt || a.addedAt); });
    return js;
  }
  function renderList() {
    if (!listEl) return;
    var js = visibleJobs();
    var seen = {};
    var focusedId = document.activeElement && document.activeElement.closest('.job') ? document.activeElement.closest('.job').getAttribute('data-job') : null;
    if (!js.length) {
      U.clear(listEl); rows = {};
      var dlAvail = !S.data.status || S.data.status.downloadsAvailable !== false;
      listEl.appendChild(ui.emptyState(t('dl.empty.' + tab), dlAvail ? t('dl.emptyHint') : t('err.downloads_unavailable'), tab === 'active' ? [h('button.btn.primary', { nav: 'dl-browse', text: t('nav.browse'), on: { click: function () { XS.router.go('browse'); } } })] : null));
      return;
    }
    var empty = listEl.querySelector('.empty'); if (empty) listEl.removeChild(empty);
    js.forEach(function (j, i) {
      seen[j.id] = 1;
      var row = rows[j.id];
      if (!row) { row = jobRow(j); rows[j.id] = row; }
      else patchRow(row, j);
      if (listEl.children[i] !== row) listEl.insertBefore(row, listEl.children[i] || null);
    });
    for (var id in rows) if (!seen[id]) { if (rows[id].parentNode) listEl.removeChild(rows[id]); delete rows[id]; }
    if (focusedId && !rows[focusedId]) XS.nav.focusFirst(listEl);
    if (tabsEl) { var c = counts(); for (var k in c) tabsEl.setCount(k, c[k]); }
  }

  function jobRow(j) {
    var row = h('div.job.st-' + j.state, { nav: 'job:' + j.id, data: { job: j.id, hints: 'jobmenu' } });
    row.appendChild(ui.cover(j.cover, '', j.title));
    row.appendChild(h('div.ttl', [h('h4', { text: j.title }), ui.statePill(j)]));
    row.appendChild(h('div.meta'));
    row.appendChild(ui.progressBar(j));
    var side = h('div.side', [h('div.pct'), h('div.acts')]);
    row.appendChild(side);
    row.appendChild(h('div.stats'));
    row.addEventListener('click', function (e) { if (e.target.closest('button')) return; jobMenu(row, j.id); });
    patchRow(row, j, true);
    return row;
  }
  function patchRow(row, j, full) {
    var prev = row._job;
    row._job = j;
    var stateChanged = !prev || prev.state !== j.state || prev.errorCode !== j.errorCode || prev.message !== j.message || prev.nextRetryAt !== j.nextRetryAt;
    if (stateChanged) {
      row.className = 'job st-' + j.state;
      var pill = row.querySelector('.state-pill'); if (pill) pill.parentNode.replaceChild(ui.statePill(j), pill);
      var meta = row.querySelector('.meta'); U.clear(meta);
      meta.appendChild(h('span.chip.fmt.sm', { text: ui.fmtLabel(j.format) }));
      if (j.provider) meta.appendChild(h('span', { text: j.provider }));
      if (j.total) meta.appendChild(h('span', { text: U.fmtBytes(j.total) }));
      if (j.rootLabel) meta.appendChild(h('span', { html: U.icon('hdd').replace('<svg ', '<svg style="width:12px;height:12px;vertical-align:-2px;fill:none;stroke:currentColor;stroke-width:2" ') + ' ' + U.escapeHtml(j.rootLabel) }));
      if (j.platform) meta.appendChild(ui.platChip(j.platform, true));
      if (j.verified) meta.appendChild(ui.tick(t('dl.hashVerified')));
      if (j.install && j.install.state === 'installed') meta.appendChild(h('span.chip.sm.good', { text: t('dl.state.installed') }));
      paintActions(row, j);
      paintError(row, j);
    }
    ui.updateBar(row.querySelector('.bar'), j);
    var p = j.state === 'done' || j.state === 'installed' ? 100 : U.pct(j.written, j.total);
    row.querySelector('.pct').textContent = j.total || j.state === 'done' || j.state === 'installed' ? U.fmtPct(p) : (j.state === 'queued' ? '' : '…');
    var stats = row.querySelector('.stats'); U.clear(stats);
    if (j.state === 'downloading' || j.state === 'connecting') {
      stats.appendChild(h('span', [h('b', { text: U.fmtBytes(j.written) }), ' / ' + (j.total ? U.fmtBytes(j.total) : '?')]));
      stats.appendChild(h('span.spd', { text: U.fmtSpeed(j.speed) }));
      if (j.speed > 0) stats.appendChild(h('span', [t('dl.etaLabel') + ' ', h('b', { text: U.fmtDur(j.eta) })]));
      stats.appendChild(h('span', { text: t('dl.connectionsN', { n: j.connections || 1 }) }));
      if (j.phase) stats.appendChild(h('span', { text: j.phase }));
      var hist = j.speedHistory || [];
      if (hist.length > 1) stats.appendChild(ui.sparkline(hist));
    } else if (j.state === 'verifying') {
      stats.appendChild(h('span', { text: t('dl.verifyingProgress', { n: U.fmtPct(U.pct(j.written, j.total)) }) }));
    } else if (j.state === 'installing') {
      stats.appendChild(h('span', { text: (j.install && j.install.message) || t('dl.installing') }));
    } else if (j.state === 'paused' || j.state === 'queued' || j.state === 'cancelled') {
      stats.appendChild(h('span', [h('b', { text: U.fmtBytes(j.written) }), j.total ? ' / ' + U.fmtBytes(j.total) : '']));
      if (j.message) stats.appendChild(h('span', { text: j.message }));
      if (j.state === 'queued') stats.appendChild(h('span', { text: t('dl.queuedPos', { n: queuePos(j) }) }));
    } else if (j.state === 'failed') {
      stats.appendChild(h('span', [h('b', { text: U.fmtBytes(j.written) }), j.total ? ' / ' + U.fmtBytes(j.total) : '']));
      if (j.attempts) stats.appendChild(h('span', { text: t('dl.attempts', { n: j.attempts }) }));
      if (j.nextRetryAt && j.nextRetryAt > U.nowSec()) stats.appendChild(h('span.gold', { 'data-retry': j.nextRetryAt, text: t('dl.retryIn', { s: j.nextRetryAt - U.nowSec() }) }));
    } else {
      stats.appendChild(h('span', { text: U.fmtBytes(j.total || j.written) }));
      if (j.finishedAt) stats.appendChild(h('span', { text: U.fmtDateTime(j.finishedAt) }));
      if (j.path) stats.appendChild(h('span.ellipsis.mono', { text: j.path, style: { maxWidth: '420px' } }));
    }
  }
  function queuePos(j) { var q = S.data.queue.jobs.filter(function (x) { return x.state === 'queued'; }); q.sort(function (a, b) { return (a.priority - b.priority) || (a.addedAt - b.addedAt); }); return q.indexOf(j) + 1; }
  /* The one primary action per state, Overdrive style; everything else is behind the row's menu. */
  function primaryFor(j) {
    switch (j.state) {
      case 'downloading': case 'connecting': case 'queued': return { a: 'pause', icon: 'pause' };
      case 'paused': return { a: 'resume', icon: 'play' };
      case 'failed': return { a: 'retry', icon: 'retry' };
      case 'cancelled': return { a: 'restart', icon: 'retry' };
      case 'done': return (j.format === 'PKG' || j.format === 'FPKG') && !(j.install && j.install.state === 'installed') ? { a: 'install', icon: 'box' } : { a: 'remove', icon: 'x' };
      case 'installed': return { a: 'remove', icon: 'x' };
      default: return null;
    }
  }
  function paintActions(row, j) {
    var acts = row.querySelector('.acts'); U.clear(acts);
    var p = primaryFor(j);
    if (p) {
      var b = h('button.btn.sm' + (j.state === 'failed' || j.state === 'paused' ? '.primary' : ''), { nav: 'job-' + j.id + '-' + p.a, html: U.icon(p.icon) + '<span>' + U.escapeHtml(t('dl.action.' + p.a)) + '</span>' });
      b.addEventListener('click', function (e) { e.stopPropagation(); XS.actions.jobAction(j, p.a); });
      acts.appendChild(b);
    }
    var more = h('button.btn.sm.icon-only', { nav: 'job-' + j.id + '-more', html: U.icon('more'), 'aria-label': t('common.more') });
    more.addEventListener('click', function (e) { e.stopPropagation(); jobMenu(more, j.id); });
    acts.appendChild(more);
  }
  function paintError(row, j) {
    var old = row.querySelector('.err'); if (old) row.removeChild(old);
    var box = null;
    if (j.state === 'failed') {
      box = h('div.err', [ui.svg('alert'), h('div', [h('b', { text: ui.errorText(j) }), h('span', { text: fixText(j) })])]);
    } else if (j.state === 'paused' && j.errorCode) {
      box = h('div.err.warn', [ui.svg('alert'), h('div', [h('b', { text: ui.errorText(j) }), h('span', { text: fixText(j) })])]);
    } else if (j.install && j.install.state === 'failed') {
      box = h('div.err', [ui.svg('alert'), h('div', [h('b', { text: t('err.install_failed') }), h('span', { text: j.install.message || '' })])]);
    } else if (j.state === 'done' && (j.format === 'PKG' || j.format === 'FPKG') && (!j.install || j.install.state === 'idle')) {
      box = h('div.err.info', [ui.svg('info'), h('div', [h('b', { text: t('dl.pkgReady') }), h('span', { text: t('dl.pkgReadyHint') })])]);
    }
    if (box) row.appendChild(box);
  }
  function fixText(j) {
    var code = j.errorCode || j.error || '';
    var key = 'err.fix.' + code;
    var fix = code && XS.i18n.has(key) ? t(key) : '';
    var msg = j.message && j.message !== ui.errorText(j) ? j.message : '';
    return [fix, msg].filter(Boolean).join(' ');
  }
  function jobMenu(anchor, id) {
    var j = null; S.data.queue.jobs.forEach(function (x) { if (x.id === id) j = x; }); if (!j) return;
    var st = j.state, items = [];
    var can = function (a) { return items.push({ label: t('dl.action.' + a), icon: ICON[a] || 'info', danger: a === 'delete' || a === 'remove', onSelect: function () { XS.actions.jobAction(j, a); } }); };
    var ICON = { pause: 'pause', resume: 'play', cancel: 'stop', retry: 'retry', restart: 'retry', remove: 'x', 'delete': 'trash', install: 'box', open: 'folder', url: 'link', up: 'up', down: 'down', top: 'up', bottom: 'down', verify: 'shield', log: 'log' };
    if (st === 'downloading' || st === 'connecting' || st === 'queued') can('pause');
    if (st === 'paused') can('resume');
    if (st === 'failed') can('retry');
    if (st === 'done' && (j.format === 'PKG' || j.format === 'FPKG')) can('install');
    if (['downloading', 'connecting', 'queued', 'paused', 'failed', 'verifying'].indexOf(st) >= 0) can('cancel');
    if (['paused', 'failed', 'cancelled'].indexOf(st) >= 0) { can('restart'); can('url'); }
    if (st === 'queued') { can('top'); can('up'); can('down'); can('bottom'); }
    if ((st === 'done' || st === 'installed') && j.sha256Expected) can('verify');
    if (st === 'done' || st === 'installed') can('open');
    items.push('sep');
    can('log');
    if (['done', 'installed', 'cancelled', 'failed', 'paused'].indexOf(st) >= 0) can('remove');
    if (st !== 'downloading' && st !== 'connecting') can('delete');
    ui.menu(anchor, items, { title: j.title });
  }

  /* 1 s tick: retry countdowns without per-row timers. */
  function tick() {
    if (!root || !root.classList.contains('active')) return;
    U.$$('[data-retry]', root).forEach(function (el) {
      var left = Number(el.getAttribute('data-retry')) - U.nowSec();
      el.textContent = left > 0 ? t('dl.retryIn', { s: left }) : t('dl.retryingNow');
    });
  }

  XS.router.register('downloads', {
    tab: true, icon: 'download', label: function () { return t('nav.downloads'); },
    mount: function (el) { root = el; },
    show: function (params) { if (params && params.tab) tab = params.tab; render(); XS.actions.refreshQueue(true); },
    tick: tick
  });
  S.on('queue', function () { if (root && root.classList.contains('active') && listEl) { renderSummary(); renderList(); } });
  S.on('storage', function () { if (root && root.classList.contains('active')) renderSummary(); });
  XS.downloadsScreen = { jobMenu: jobMenu };
})();
