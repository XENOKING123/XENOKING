/* XENO STORE — 43-downloads.js: summary strip (speed, remaining, ETA, free, active, rest-mode pill), lifetime stats
   (/api/stats), tabs, install-set groups (§17.13), schedule rows with "Start now" (§17.5), turbo result chips,
   copy/move and backup jobs (§17.16/§17.17), debrid "via" labels (§17.14), ZIP extracting/extracted states (§17.19),
   job rows with segment bars, sparkline, retry countdown and state-driven actions. */
(function () {
  'use strict';
  var XS = window.XS, U = XS.util, S = XS.state, ui = XS.ui, api = XS.api, cb = XS.cb, h = U.h, t = XS.t;
  var root = null, tab = 'active', listEl = null, summaryEl = null, statsEl = null, tabsEl = null, rows = {}, groupEls = {}, stats = null, statsAt = 0;
  var TABS = {
    active: ['downloading', 'connecting', 'verifying', 'installing', 'paused', 'extracting'],
    queued: ['queued'],
    finished: ['done', 'installed', 'extracted'],
    failed: ['failed'],
    cancelled: ['cancelled']
  };
  function tabOf(j) { for (var k in TABS) if (TABS[k].indexOf(j.state) >= 0) return k; return 'active'; }
  function isScheduled(j) { return j.state === 'queued' && !!j.scheduledFor && !j.startNow; }
  /* Tab counts: a group counts once, in the tab its status maps to. */
  function counts() {
    var c = { active: 0, queued: 0, finished: 0, failed: 0, cancelled: 0 };
    var gs = cb.groups(S.data.queue.jobs);
    S.data.queue.jobs.forEach(function (j) { if (!j.group || !gs.map[j.group]) c[tabOf(j)]++; });
    gs.order.forEach(function (gid) { c[gs.map[gid].tab]++; });
    return c;
  }

  function render() {
    if (!root) return;
    U.clear(root); rows = {}; groupEls = {};
    var inner = h('div.screen-inner');
    root.appendChild(inner);
    summaryEl = h('div.dl-summary'); inner.appendChild(summaryEl);
    statsEl = h('div.dl-stats'); inner.appendChild(statsEl);
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
    clear.addEventListener('click', function () { api.queueClear(['done', 'installed', 'extracted', 'cancelled']).then(function (r) { ui.toast({ cls: 'good', title: t('toast.cleared', { n: r.removed || 0 }) }); XS.actions.refreshQueue(); }, ui.errorToast); });
    tools.appendChild(pauseAll); tools.appendChild(resumeAll); tools.appendChild(clear);
    inner.appendChild(tools);
    listEl = h('div.jobs', { data: { navRegion: '' } });
    inner.appendChild(listEl);
    renderSummary();
    renderStats();
    renderList();
  }
  function bulk(states, action) {
    var js = S.data.queue.jobs.filter(function (j) { return states.indexOf(j.state) >= 0; });
    if (!js.length) return;
    var p = Promise.resolve();
    js.forEach(function (j) { p = p.then(function () { return api.queueAction(j.id, action).then(null, function () { /* keep going */ }); }); });
    p.then(function () { XS.actions.refreshQueue(); });
  }

  /* ---------- summary strip + lifetime stats ---------- */
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
    var rm = cb.restModeText(s);
    var pill = h('div.stat.pill.rest' + (rm.on ? '.on' : ''), { title: t('dl2.restHint') }, [h('i.dot'), h('div', [h('div.k', { text: rm.on ? t('dl.sum.keepAwake') : t('dl2.restMode') }), h('div.v', { text: rm.text })])]);
    summaryEl.appendChild(pill);
  }
  function stat(k, v, cls, small) {
    return h('div.stat' + (cls ? '.' + cls : ''), [h('div.k', { text: k }), h('div.v', [v, small ? h('small', { text: small }) : null])]);
  }
  function loadStats(force) {
    if (!force && stats && Date.now() - statsAt < 60000) { renderStats(); return; }
    cb.api.stats().then(function (r) { stats = r; statsAt = Date.now(); renderStats(); }, function () { stats = stats || null; statsAt = Date.now(); renderStats(); });
  }
  function renderStats() {
    if (!statsEl) return;
    U.clear(statsEl);
    if (!stats || (!stats.totalBytes && !stats.totalJobs)) { statsEl.hidden = true; return; }
    statsEl.hidden = false;
    var parts = [];
    parts.push(h('span.seg', [h('b', { text: t('dl2.lifetime') }), ' ', U.fmtBytes(stats.totalBytes || 0)]));
    if (stats.bestSpeed) parts.push(h('span.seg', [h('b', { text: t('dl2.best') }), ' ', U.fmtSpeed(stats.bestSpeed)]));
    if (stats.avgSpeed) parts.push(h('span.seg', [h('b', { text: t('dl2.avg') }), ' ', U.fmtSpeed(stats.avgSpeed)]));
    if (stats.totalJobs) parts.push(h('span.seg', { text: t('dl2.nDownloads', { n: stats.totalJobs }) }));
    var best = '', bestN = 0;
    var bp = stats.byProvider || {};
    for (var k in bp) if (bp[k] && (bp[k].bytes || 0) > bestN) { bestN = bp[k].bytes; best = k; }
    if (best) parts.push(h('span.seg', { text: t('dl2.topProvider', { name: best, size: U.fmtBytes(bestN) }) }));
    statsEl.appendChild(h('span.ic', { html: U.icon('zap') }));
    parts.forEach(function (p, i) { if (i) statsEl.appendChild(h('span.dot', { text: '·' })); statsEl.appendChild(p); });
  }

  /* ---------- list: ungrouped job rows + install-set groups ---------- */
  function orderIdx(st) { var order = ['downloading', 'connecting', 'extracting', 'verifying', 'installing', 'paused', 'queued', 'failed', 'done', 'installed', 'extracted', 'cancelled']; var i = order.indexOf(st); return i < 0 ? 99 : i; }
  function visibleEntries() {
    var gs = cb.groups(S.data.queue.jobs);
    var entries = [];
    S.data.queue.jobs.forEach(function (j) { if (j.group && gs.map[j.group]) return; if (tabOf(j) === tab) entries.push({ kind: 'job', job: j, st: j.state, at: j.finishedAt || j.addedAt || 0, pri: j.priority || 0 }); });
    gs.order.forEach(function (gid) { var g = gs.map[gid]; if (g.tab !== tab) return; var first = g.jobs[0] || {}; entries.push({ kind: 'group', group: g, st: g.status === 'paused' ? 'failed' : g.status === 'installed' ? 'installed' : g.active ? 'downloading' : g.status, at: first.finishedAt || first.addedAt || 0, pri: first.priority || 0 }); });
    entries.sort(function (a, b) { var d = orderIdx(a.st) - orderIdx(b.st); if (d) return d; if (a.st === 'queued') return (a.pri - b.pri) || (a.at - b.at); return b.at - a.at; });
    return entries;
  }
  function renderList() {
    if (!listEl) return;
    var entries = visibleEntries();
    var seenJobs = {}, seenGroups = {};
    var focusedId = document.activeElement && document.activeElement.closest('.job, .jobgroup') ? (document.activeElement.closest('.job, .jobgroup').getAttribute('data-job') || document.activeElement.closest('.job, .jobgroup').getAttribute('data-group')) : null;
    if (!entries.length) {
      U.clear(listEl); rows = {}; groupEls = {};
      var dlAvail = !S.data.status || S.data.status.downloadsAvailable !== false;
      listEl.appendChild(ui.emptyState(t('dl.empty.' + tab), dlAvail ? t('dl.emptyHint') : t('err.downloads_unavailable'), tab === 'active' ? [h('button.btn.primary', { nav: 'dl-browse', text: t('nav.browse'), on: { click: function () { XS.router.go('browse'); } } })] : null));
      if (tabsEl) { var c0 = counts(); for (var k0 in c0) tabsEl.setCount(k0, c0[k0]); }
      return;
    }
    var empty = listEl.querySelector('.empty'); if (empty) listEl.removeChild(empty);
    var want = [];
    entries.forEach(function (e) {
      if (e.kind === 'job') {
        var j = e.job; seenJobs[j.id] = 1;
        var row = rows[j.id];
        if (!row || row._grouped) { if (row && row.parentNode) row.parentNode.removeChild(row); row = jobRow(j); rows[j.id] = row; }
        else patchRow(row, j);
        want.push(row);
      } else {
        var g = e.group; seenGroups[g.id] = 1;
        var gel = groupEls[g.id];
        if (!gel) { gel = groupEl(g); groupEls[g.id] = gel; } else patchGroup(gel, g);
        g.jobs.forEach(function (j) {
          seenJobs[j.id] = 1;
          var jr = rows[j.id];
          if (!jr || !jr._grouped) { if (jr && jr.parentNode) jr.parentNode.removeChild(jr); jr = jobRow(j, true); rows[j.id] = jr; }
          else patchRow(jr, j);
          var members = gel.querySelector('.members');
          if (jr.parentNode !== members) members.appendChild(jr);
        });
        /* keep member order */
        var members2 = gel.querySelector('.members');
        g.jobs.forEach(function (j, i) { var jr = rows[j.id]; if (members2.children[i] !== jr) members2.insertBefore(jr, members2.children[i] || null); });
        want.push(gel);
      }
    });
    want.forEach(function (el, i) { if (listEl.children[i] !== el) listEl.insertBefore(el, listEl.children[i] || null); });
    for (var id in rows) if (!seenJobs[id]) { if (rows[id].parentNode) rows[id].parentNode.removeChild(rows[id]); delete rows[id]; }
    for (var gid in groupEls) if (!seenGroups[gid]) { if (groupEls[gid].parentNode) groupEls[gid].parentNode.removeChild(groupEls[gid]); delete groupEls[gid]; }
    while (listEl.children.length > want.length) listEl.removeChild(listEl.lastChild);
    if (focusedId && !rows[focusedId] && !groupEls[focusedId] && !listEl.contains(document.activeElement)) XS.nav.focusFirst(listEl);
    if (tabsEl) { var c = counts(); for (var k in c) tabsEl.setCount(k, c[k]); }
  }

  /* ---------- install-set group card ---------- */
  function groupEl(g) {
    var el = h('div.jobgroup', { data: { group: g.id } });
    var head = h('div.ghead', { nav: 'group:' + g.id, data: { hints: 'jobmenu' } });
    head.appendChild(ui.cover(g.cover, '', g.title));
    head.appendChild(h('div.ttl', [h('h4', { text: g.title }), h('span.chip.sm.gold', { text: t('dl2.installSet') }), h('span.state-pill')]));
    head.appendChild(h('div.meta'));
    head.appendChild(h('div.bar.gold', [h('i')]));
    head.appendChild(h('div.side', [h('div.pct'), h('div.acts')]));
    head.appendChild(h('div.stats'));
    head.addEventListener('click', function (e) { if (e.target.closest('button')) return; groupMenu(head, g.id); });
    el.appendChild(head);
    el.appendChild(h('div.members'));
    patchGroup(el, g, true);
    return el;
  }
  function patchGroup(el, g, full) {
    var prev = el._sig;
    var sig = [g.status, g.downloaded, g.installed, g.failed, g.pending, g.pausedAt, g.jobs.map(function (j) { return j.state + (j.install && j.install.state); }).join(',')].join('|');
    var head = el.querySelector('.ghead');
    if (full || prev !== sig) {
      el._sig = sig;
      el.className = 'jobgroup gs-' + g.status;
      var pillState = g.status === 'paused' ? 'failed' : g.status === 'installed' ? 'installed' : g.status === 'installing' ? 'installing' : g.status === 'cancelled' ? 'cancelled' : (g.active ? 'downloading' : 'queued');
      var pill = head.querySelector('.state-pill');
      var np = h('span.state-pill.' + pillState, [h('i.dot'), h('span', { text: g.status === 'paused' ? t('dl2.setPaused') : t('dl.state.' + pillState) })]);
      pill.parentNode.replaceChild(np, pill);
      var meta = head.querySelector('.meta'); U.clear(meta);
      var kinds = g.jobs.map(function (j) { return t('game2.kind.' + (j.kind || 'game')); });
      meta.appendChild(h('span', { text: kinds.join(' → ') }));
      meta.appendChild(h('span', { text: U.fmtBytes(g.size) }));
      var first = g.jobs[0];
      if (first && first.rootLabel) meta.appendChild(h('span', { text: first.rootLabel }));
      if (g.platform) meta.appendChild(ui.platChip(g.platform, true));
      if (first && first.via) meta.appendChild(h('span.chip.sm.acc', { text: t('game2.viaLabel', { service: first.via }) }));
      var acts = head.querySelector('.acts'); U.clear(acts);
      if (g.status === 'paused' && g.pausedJob) {
        var retry = h('button.btn.sm.primary', { nav: 'group-' + g.id + '-retry', html: U.icon('retry') + '<span>' + U.escapeHtml(t('dl.action.retry')) + '</span>' });
        retry.addEventListener('click', function (e) { e.stopPropagation(); retryGroupStep(g); });
        acts.appendChild(retry);
      } else if (g.active || g.queued) {
        var pause = h('button.btn.sm', { nav: 'group-' + g.id + '-pause', html: U.icon('pause') + '<span>' + U.escapeHtml(t('dl.action.pause')) + '</span>' });
        pause.addEventListener('click', function (e) { e.stopPropagation(); groupBulk(g, ['downloading', 'connecting', 'queued'], 'pause'); });
        acts.appendChild(pause);
      } else if (g.jobs.some(function (j) { return j.state === 'paused'; })) {
        var resume = h('button.btn.sm.primary', { nav: 'group-' + g.id + '-resume', html: U.icon('play') + '<span>' + U.escapeHtml(t('dl.action.resume')) + '</span>' });
        resume.addEventListener('click', function (e) { e.stopPropagation(); groupBulk(g, ['paused'], 'resume'); });
        acts.appendChild(resume);
      }
      var more = h('button.btn.sm.icon-only', { nav: 'group-' + g.id + '-more', html: U.icon('more'), 'aria-label': t('common.more') });
      more.addEventListener('click', function (e) { e.stopPropagation(); groupMenu(more, g.id); });
      acts.appendChild(more);
      var old = head.querySelector('.err'); if (old) head.removeChild(old);
      if (g.status === 'paused') head.appendChild(h('div.err', [ui.svg('alert'), h('div', [h('b', { text: t('dl2.setPausedAt', { step: g.pausedAt }) }), h('span', { text: t('dl2.setPausedHint') })])]));
      else if (g.status === 'installed') head.appendChild(h('div.err.info.ok', [ui.svg('check'), h('div', [h('b', { text: t('dl2.setInstalled', { n: g.installed }) }), h('span', { text: t('dl2.setInstalledHint') })])]));
    }
    var bar = head.querySelector('.bar');
    var p = g.size ? U.pct(g.written, g.size) : (g.total ? g.downloaded / g.total * 100 : 0);
    if (g.status === 'installed') p = 100;
    bar.className = 'bar' + (g.status === 'paused' ? ' bad' : g.status === 'installed' ? ' good' : g.status === 'installing' ? ' gold striped' : ' gold');
    bar.querySelector('i').style.width = p.toFixed(2) + '%';
    head.querySelector('.pct').textContent = U.fmtPct(p);
    var stats = head.querySelector('.stats'); U.clear(stats);
    stats.appendChild(h('span', { text: t('dl2.setStep', { i: Math.max(1, Math.min(g.total, g.step)), n: g.total }) }));
    var speed = 0; g.jobs.forEach(function (j) { if (j.state === 'downloading') speed += j.speed || 0; });
    if (speed > 0) stats.appendChild(h('span.spd', { text: U.fmtSpeed(speed) }));
    stats.appendChild(h('span', { text: t('dl2.setProgress', { done: g.downloaded, inst: g.installed, n: g.total }) }));
    if (g.status === 'installing') stats.appendChild(h('span', { text: t('dl2.setInstallingOrder') }));
  }
  function groupBulk(g, states, action) {
    var js = g.jobs.filter(function (j) { return states.indexOf(j.state) >= 0; });
    var p = Promise.resolve();
    js.forEach(function (j) { p = p.then(function () { return api.queueAction(j.id, action).then(null, function () { /* keep going */ }); }); });
    p.then(function () { XS.actions.refreshQueue(); });
  }
  function retryGroupStep(g) {
    var j = g.pausedJob; if (!j) return;
    var a = j.state === 'failed' ? 'retry' : 'install';
    api.queueAction(j.id, a).then(function () { ui.toast({ cls: 'gold', title: t('dl2.setRetrying', { step: g.pausedAt }) }); XS.actions.refreshQueue(); }, function (err) { ui.errorToast(err, t('dl.action.retry')); });
  }
  function groupMenu(anchor, gid) {
    var gs = cb.groups(S.data.queue.jobs), g = gs.map[gid]; if (!g) return;
    var items = [];
    if (g.pausedJob) items.push({ label: t('dl2.setRetryStep'), icon: 'retry', onSelect: function () { retryGroupStep(g); } });
    if (g.active || g.queued) items.push({ label: t('dl2.setPauseAll'), icon: 'pause', onSelect: function () { groupBulk(g, ['downloading', 'connecting', 'queued'], 'pause'); } });
    if (g.jobs.some(function (j) { return j.state === 'paused'; })) items.push({ label: t('dl2.setResumeAll'), icon: 'play', onSelect: function () { groupBulk(g, ['paused'], 'resume'); } });
    if (g.gameId && S.game(g.gameId)) items.push({ label: t('lib.openGame'), icon: 'external', onSelect: function () { XS.router.go('game', { id: g.gameId }); } });
    items.push('sep');
    if (g.jobs.some(function (j) { return !cb.COMPLETE_STATES[j.state] && j.state !== 'cancelled'; })) items.push({ label: t('dl2.setCancelAll'), icon: 'stop', danger: true, onSelect: function () { ui.confirm(t('dl.cancelTitle'), t('dl2.setCancelText', { title: g.title, n: g.total }), t('dl.action.cancel'), true).then(function (ok) { if (ok) groupBulk(g, ['downloading', 'connecting', 'queued', 'paused', 'failed', 'verifying'], 'cancel'); }); } });
    items.push({ label: t('dl2.setRemoveAll'), icon: 'x', danger: true, onSelect: function () { var p = Promise.resolve(); g.jobs.forEach(function (j) { p = p.then(function () { return api.queueAction(j.id, 'remove').then(null, function () { /* running steps stay */ }); }); }); p.then(function () { XS.actions.refreshQueue(); }); } });
    ui.menu(anchor, items, { title: t('dl2.installSet') + ' · ' + g.title });
  }

  /* ---------- job row ---------- */
  function jobRow(j, grouped) {
    var row = h('div.job.st-' + j.state + (grouped ? '.member' : ''), { nav: 'job:' + j.id, data: { job: j.id, hints: 'jobmenu' } });
    row._grouped = !!grouped;
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
  function typeOf(j) { return j.type || 'download'; }
  function jobTitle(j) {
    if (typeOf(j) === 'copy') return (j.move ? t('dl2.moveTitle') : t('dl2.copyTitle')) + ' · ' + (j.title || cb.basename(j.srcPath || j.path));
    if (typeOf(j) === 'backup') return t('dl2.backupTitle') + ' · ' + (j.title || j.titleId || '');
    return j.title;
  }
  function turboChip(j) {
    var tb = j.turbo; if (!tb || !tb.picked || !(tb.tested && tb.tested.length >= 2)) return null;
    var hit = null; (tb.tested || []).forEach(function (x) { if (x.url === tb.picked) hit = x; });
    var speed = hit && hit.mbps ? U.fmtSpeed(hit.mbps * 1e6) : '';
    var chip = h('span.chip.sm.turbo', { html: U.icon('zap') + '<span>' + U.escapeHtml(t('dl2.turboPicked', { host: cb.hostOf(tb.picked) || t('dl.primary') }) + (speed ? ' · ' + speed : '')) + '</span>', title: t('dl2.turboHint', { n: tb.tested.length }) });
    return chip;
  }
  function patchRow(row, j, full) {
    var prev = row._job;
    row._job = j;
    var ex = j.extract || {};
    var stateChanged = full || !prev || prev.state !== j.state || prev.errorCode !== j.errorCode || prev.message !== j.message || prev.nextRetryAt !== j.nextRetryAt || (prev.install && prev.install.state) !== (j.install && j.install.state) || (prev.extract && prev.extract.state) !== ex.state || (prev.turbo && prev.turbo.picked) !== (j.turbo && j.turbo.picked) || prev.scheduledFor !== j.scheduledFor || prev.startNow !== j.startNow || prev.via !== j.via;
    if (stateChanged) {
      row.className = 'job st-' + j.state + (row._grouped ? ' member' : '') + (typeOf(j) !== 'download' ? ' type-' + typeOf(j) : '');
      row.querySelector('.ttl h4').textContent = jobTitle(j);
      var pill = row.querySelector('.state-pill'); if (pill) pill.parentNode.replaceChild(statePill(j), pill);
      var meta = row.querySelector('.meta'); U.clear(meta);
      if (typeOf(j) === 'copy') {
        meta.appendChild(h('span.chip.sm' + (j.move ? '.warn' : '.acc'), { text: j.move ? t('dl2.move') : t('dl2.copy') }));
        meta.appendChild(h('span.mono.ellipsis', { text: cb.rootLabel(cb.dirname(cb.dirname(j.srcPath || ''))) || cb.dirname(j.srcPath || ''), style: { maxWidth: '200px' } }));
        meta.appendChild(h('span', { html: U.icon('chevR').replace('<svg ', '<svg style="width:12px;height:12px;vertical-align:-2px;fill:none;stroke:currentColor;stroke-width:2" ') }));
        meta.appendChild(h('span', { text: j.rootLabel || cb.rootLabel(j.root) }));
        if (j.total) meta.appendChild(h('span', { text: U.fmtBytes(j.total) }));
      } else if (typeOf(j) === 'backup') {
        meta.appendChild(h('span.chip.sm.gold', { text: t('dl2.saveBackup') }));
        if (j.titleId) meta.appendChild(h('span.mono', { text: j.titleId }));
        if (j.rootLabel) meta.appendChild(h('span', { text: j.rootLabel }));
      } else {
        if (j.kind && j.kind !== 'game' && j.kind !== 'app') meta.appendChild(h('span.chip.sm' + (j.kind === 'backport' ? '.warn' : j.kind === 'update' ? '.acc' : j.kind === 'dlc' ? '.good' : ''), { text: XS.i18n.has('game2.kind.' + j.kind) ? t('game2.kind.' + j.kind) : j.kind }));
        meta.appendChild(h('span.chip.fmt.sm', { text: ui.fmtLabel(j.format) }));
        if (j.provider) meta.appendChild(h('span', { text: j.provider }));
        if (j.via) meta.appendChild(h('span.chip.sm.acc.via', { html: U.icon('cloud') + '<span>' + U.escapeHtml(t('game2.viaLabel', { service: j.via })) + '</span>' }));
        if (j.total) meta.appendChild(h('span', { text: U.fmtBytes(j.total) }));
        if (j.rootLabel) meta.appendChild(h('span', { html: U.icon('hdd').replace('<svg ', '<svg style="width:12px;height:12px;vertical-align:-2px;fill:none;stroke:currentColor;stroke-width:2" ') + ' ' + U.escapeHtml(j.rootLabel) }));
        if (j.platform && j.platform !== 'HOMEBREW') meta.appendChild(ui.platChip(j.platform, true));
        if (j.verified) meta.appendChild(ui.tick(t('dl.hashVerified')));
        if (j.install && j.install.state === 'installed') meta.appendChild(h('span.chip.sm.good', { text: t('dl.state.installed') }));
        var tc = turboChip(j); if (tc) meta.appendChild(tc);
        if (ex.state === 'extracted') meta.appendChild(h('span.chip.sm.good', { html: U.icon('box') + '<span>' + U.escapeHtml(t('dl2.extracted', { n: ex.files || 0 })) + '</span>', title: ex.dir || '' }));
        if (ex.archiveDeleted) meta.appendChild(h('span.chip.sm', { text: t('dl2.archiveDeleted') }));
      }
      paintActions(row, j);
      paintError(row, j);
    }
    ui.updateBar(row.querySelector('.bar'), j.state === 'extracted' ? extractedView(j) : j);
    var done = cb.COMPLETE_STATES[j.state];
    var p = done ? 100 : U.pct(j.written, j.total);
    row.querySelector('.pct').textContent = j.total || done ? U.fmtPct(p) : (j.state === 'queued' ? '' : '…');
    var stats = row.querySelector('.stats'); U.clear(stats);
    if (j.state === 'downloading' || j.state === 'connecting') {
      stats.appendChild(h('span', [h('b', { text: U.fmtBytes(j.written) }), ' / ' + (j.total ? U.fmtBytes(j.total) : '?')]));
      stats.appendChild(h('span.spd', { text: U.fmtSpeed(j.speed) }));
      if (j.speed > 0) stats.appendChild(h('span', [t('dl.etaLabel') + ' ', h('b', { text: U.fmtDur(j.eta) })]));
      if (typeOf(j) === 'download') stats.appendChild(h('span', { text: t('dl.connectionsN', { n: j.connections || 1 }) }));
      if (j.restResuming) stats.appendChild(h('span.gold', { text: t('dl2.restResuming') }));
      else if (j.state === 'connecting' && j.turbo && !j.turbo.done && (j.mirrors || []).length >= 1 && cb.sget('downloads.turboStart', true) !== false && typeOf(j) === 'download') stats.appendChild(h('span.gold', { text: t('dl2.turboRacing', { n: Math.min(3, (j.mirrors || []).length + 1) }) }));
      else if (j.phase) stats.appendChild(h('span', { text: j.phase }));
      var hist = j.speedHistory || [];
      if (hist.length > 1) stats.appendChild(ui.sparkline(hist));
    } else if (j.state === 'verifying') {
      stats.appendChild(h('span', { text: t('dl.verifyingProgress', { n: U.fmtPct(U.pct(j.written, j.total)) }) }));
    } else if (j.state === 'extracting') {
      stats.appendChild(h('span', { text: ex.message || t('dl2.extracting') }));
      if (ex.files) stats.appendChild(h('span', { text: t('dl2.extractFiles', { n: ex.files }) }));
      if (ex.dir) stats.appendChild(h('span.ellipsis.mono', { text: ex.dir, style: { maxWidth: '420px' } }));
    } else if (j.state === 'installing') {
      stats.appendChild(h('span', { text: (j.install && j.install.message) || t('dl.installing') }));
      if (j.group) stats.appendChild(h('span', { text: t('dl2.setInstallingOrder') }));
    } else if (j.state === 'queued' && isScheduled(j)) {
      stats.appendChild(h('span.gold', { html: U.icon('clock').replace('<svg ', '<svg style="width:13px;height:13px;vertical-align:-2px;fill:none;stroke:currentColor;stroke-width:2" ') + ' ' + U.escapeHtml(t('dl2.scheduledFor', { time: j.scheduledFor })) }));
      stats.appendChild(h('span', { text: t('dl2.scheduledHint') }));
      if (j.total) stats.appendChild(h('span', { text: U.fmtBytes(j.total) }));
    } else if (j.state === 'paused' || j.state === 'queued' || j.state === 'cancelled') {
      stats.appendChild(h('span', [h('b', { text: U.fmtBytes(j.written) }), j.total ? ' / ' + U.fmtBytes(j.total) : '']));
      if (j.message) stats.appendChild(h('span', { text: j.message }));
      if (j.state === 'queued') stats.appendChild(h('span', { text: t('dl.queuedPos', { n: queuePos(j) }) }));
      if (j.state === 'queued' && j.group) stats.appendChild(h('span', { text: t('dl2.setWaits') }));
    } else if (j.state === 'failed') {
      stats.appendChild(h('span', [h('b', { text: U.fmtBytes(j.written) }), j.total ? ' / ' + U.fmtBytes(j.total) : '']));
      if (j.attempts) stats.appendChild(h('span', { text: t('dl.attempts', { n: j.attempts }) }));
      if (j.nextRetryAt && j.nextRetryAt > U.nowSec()) stats.appendChild(h('span.gold', { 'data-retry': j.nextRetryAt, text: t('dl.retryIn', { s: j.nextRetryAt - U.nowSec() }) }));
    } else {
      stats.appendChild(h('span', { text: U.fmtBytes(j.total || j.written) }));
      if (j.peakSpeed) stats.appendChild(h('span', { text: t('dl2.peak', { speed: U.fmtSpeed(j.peakSpeed) }) }));
      if (j.finishedAt) stats.appendChild(h('span', { text: U.fmtDateTime(j.finishedAt) }));
      var shown = j.state === 'extracted' && ex.dir ? ex.dir : j.path;
      if (shown) stats.appendChild(h('span.ellipsis.mono', { text: shown, style: { maxWidth: '420px' } }));
    }
  }
  function extractedView(j) { return { state: 'done', total: j.total, written: j.total, segments: [] }; }
  function statePill(j) {
    var st = j.state;
    var label = XS.i18n.has('dl.state.' + st) ? t('dl.state.' + st) : (XS.i18n.has('dl2.state.' + st) ? t('dl2.state.' + st) : st);
    if (st === 'queued' && isScheduled(j)) label = t('dl2.state.scheduled');
    var cls = st === 'extracting' ? 'installing' : st === 'extracted' ? 'done' : st;
    return h('span.state-pill.' + cls, [h('i.dot'), h('span', { text: label })]);
  }
  function queuePos(j) { var q = S.data.queue.jobs.filter(function (x) { return x.state === 'queued' && !isScheduled(x); }); q.sort(function (a, b) { return (a.priority - b.priority) || (a.addedAt - b.addedAt); }); return Math.max(1, q.indexOf(j) + 1); }
  /* The one primary action per state, Overdrive style; everything else is behind the row's menu. */
  function primaryFor(j) {
    switch (j.state) {
      case 'queued': return isScheduled(j) ? { a: 'startnow', icon: 'play', primary: true } : { a: 'pause', icon: 'pause' };
      case 'downloading': case 'connecting': return { a: 'pause', icon: 'pause' };
      case 'paused': return { a: 'resume', icon: 'play', primary: true };
      case 'failed': return { a: 'retry', icon: 'retry', primary: true };
      case 'cancelled': return { a: 'restart', icon: 'retry' };
      case 'done': return cb.isPkg(j.format) && !(j.install && j.install.state === 'installed') ? { a: 'install', icon: 'box' } : { a: 'remove', icon: 'x' };
      case 'installed': case 'extracted': return { a: 'remove', icon: 'x' };
      default: return null;
    }
  }
  function paintActions(row, j) {
    var acts = row.querySelector('.acts'); U.clear(acts);
    var p = primaryFor(j);
    if (p) {
      var b = h('button.btn.sm' + (p.primary ? '.primary' : ''), { nav: 'job-' + j.id + '-' + p.a, html: U.icon(p.icon) + '<span>' + U.escapeHtml(p.a === 'startnow' ? t('dl2.startNow') : t('dl.action.' + p.a)) + '</span>' });
      b.addEventListener('click', function (e) { e.stopPropagation(); jobAction(j, p.a); });
      acts.appendChild(b);
    }
    var more = h('button.btn.sm.icon-only', { nav: 'job-' + j.id + '-more', html: U.icon('more'), 'aria-label': t('common.more') });
    more.addEventListener('click', function (e) { e.stopPropagation(); jobMenu(more, j.id); });
    acts.appendChild(more);
  }
  function jobAction(j, a) {
    if (a === 'startnow') {
      return cb.api.queueStartNow(j.id).then(function () { ui.toast({ cls: 'gold', title: t('dl2.startNowToast', { title: j.title }) }); XS.actions.refreshQueue(); }, function (err) {
        if (err.status === 404) return api.queueAction(j.id, 'resume').then(function () { XS.actions.refreshQueue(); }, function (e2) { ui.errorToast(e2, t('dl2.startNow')); });
        ui.errorToast(err, t('dl2.startNow'));
      });
    }
    return XS.actions.jobAction(j, a);
  }
  function paintError(row, j) {
    var old = row.querySelector('.err'); if (old) row.removeChild(old);
    var box = null, ex = j.extract || {};
    if (j.state === 'failed') {
      box = h('div.err', [ui.svg('alert'), h('div', [h('b', { text: ui.errorText(j) }), h('span', { text: fixText(j) })])]);
    } else if (j.state === 'paused' && j.errorCode) {
      box = h('div.err.warn', [ui.svg('alert'), h('div', [h('b', { text: ui.errorText(j) }), h('span', { text: fixText(j) })])]);
    } else if (j.install && j.install.state === 'failed') {
      box = h('div.err', [ui.svg('alert'), h('div', [h('b', { text: t('err.install_failed') }), h('span', { text: (j.install.message || '') + (j.group ? ' ' + t('dl2.setStepFailed') : '') })])]);
    } else if (ex.state === 'failed') {
      box = h('div.err.warn', [ui.svg('alert'), h('div', [h('b', { text: t('dl2.extractFailed') }), h('span', { text: ex.message || t('dl2.extractFailedHint') })])]);
    } else if (j.state === 'done' && cb.isPkg(j.format) && (!j.install || j.install.state === 'idle') && !j.group) {
      box = h('div.err.info', [ui.svg('info'), h('div', [h('b', { text: t('dl.pkgReady') }), h('span', { text: t('dl.pkgReadyHint') })])]);
    } else if (j.state === 'done' && cb.isArchive(j.format) && ex.state !== 'extracted' && ex.state !== 'extracting' && typeOf(j) === 'download' && (j.kind || 'game') !== 'save') {
      var zip = String(j.format || '').toLowerCase() === 'zip';
      box = h('div.err.info', [ui.svg('info'), h('div', [h('b', { text: zip ? t('dl2.zipNotExtracted') : t('dl2.archiveLimit', { format: ui.fmtLabel(j.format) }) }), h('span', { text: zip ? t('dl2.zipNotExtractedHint') : t('dl2.archiveLimitHint') })])]);
    } else if (j.state === 'done' && j.group && j.install && j.install.state === 'pending') {
      box = h('div.err.info', [ui.svg('clock'), h('div', [h('b', { text: t('dl2.setWaitingInstall') }), h('span', { text: t('dl2.setInstallingOrder') })])]);
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
    var ICON = { pause: 'pause', resume: 'play', cancel: 'stop', retry: 'retry', restart: 'retry', remove: 'x', 'delete': 'trash', install: 'box', open: 'folder', url: 'link', up: 'up', down: 'down', top: 'up', bottom: 'down', verify: 'shield', log: 'log' };
    var can = function (a) { return items.push({ label: t('dl.action.' + a), icon: ICON[a] || 'info', danger: a === 'delete' || a === 'remove', onSelect: function () { XS.actions.jobAction(j, a); } }); };
    if (st === 'queued' && isScheduled(j)) items.push({ label: t('dl2.startNow'), sub: t('dl2.startNowSub', { time: j.scheduledFor }), icon: 'play', onSelect: function () { jobAction(j, 'startnow'); } });
    if (st === 'downloading' || st === 'connecting' || st === 'queued') can('pause');
    if (st === 'paused') can('resume');
    if (st === 'failed') can('retry');
    if (st === 'done' && cb.isPkg(j.format)) can('install');
    if (['downloading', 'connecting', 'queued', 'paused', 'failed', 'verifying'].indexOf(st) >= 0) can('cancel');
    if (['paused', 'failed', 'cancelled'].indexOf(st) >= 0 && typeOf(j) === 'download') { can('restart'); can('url'); }
    if (['paused', 'failed', 'cancelled'].indexOf(st) >= 0 && typeOf(j) !== 'download') can('restart');
    if (st === 'queued') { can('top'); can('up'); can('down'); can('bottom'); }
    if ((st === 'done' || st === 'installed') && j.sha256Expected) can('verify');
    if (st === 'done' || st === 'installed' || st === 'extracted') can('open');
    if (j.gameId && S.game(j.gameId)) items.push({ label: t('lib.openGame'), icon: 'external', onSelect: function () { XS.router.go('game', { id: j.gameId }); } });
    if (j.turbo && j.turbo.tested && j.turbo.tested.length) items.push({ label: t('dl2.turboDetails'), icon: 'zap', onSelect: function () { turboSheet(j); } });
    items.push('sep');
    can('log');
    if (['done', 'installed', 'extracted', 'cancelled', 'failed', 'paused'].indexOf(st) >= 0) can('remove');
    if (st !== 'downloading' && st !== 'connecting' && typeOf(j) === 'download') can('delete');
    ui.menu(anchor, items, { title: j.title });
  }
  function turboSheet(j) {
    var tb = j.turbo || {}, list = h('div.list');
    (tb.tested || []).forEach(function (x, i) {
      var picked = x.url === tb.picked;
      var row = h('div.lrow' + (picked ? '.sel' : ''), { tabindex: '-1' }, [
        h('span.ic', { html: U.icon(picked ? 'zap' : 'link') }),
        h('div.main', [h('div.name', { text: cb.hostOf(x.url) || x.url }), h('div.desc.mono.ellipsis', { text: x.url })]),
        h('span.val', { text: (x.status ? 'HTTP ' + x.status + ' · ' : '') + (x.ms ? x.ms + ' ms · ' : '') + (x.mbps ? U.fmtSpeed(x.mbps * 1e6) : t('dl.probeFail', { status: x.status || 0 })) })
      ]);
      if (picked) row.querySelector('.main').appendChild(h('div.tags', [h('span.chip.sm.gold', { text: t('dl2.turboWinner') })]));
      list.appendChild(row);
    });
    var hd = ui.sheet({ title: t('dl2.turboTitle'), sub: j.title, cls: 'narrow', body: [h('p.dim.small', { text: t('dl2.turboExplain') }), list], foot: [h('span.spacer'), h('button.btn.primary', { nav: 'turbo-close', 'data-autofocus': '', text: t('common.close'), on: { click: function () { ui.closeLayer(hd); } } })] });
  }

  /* 1 s tick: retry countdowns without per-row timers; stats refresh once a minute. */
  function tick() {
    if (!root || !root.classList.contains('active')) return;
    U.$$('[data-retry]', root).forEach(function (el) {
      var left = Number(el.getAttribute('data-retry')) - U.nowSec();
      el.textContent = left > 0 ? t('dl.retryIn', { s: left }) : t('dl.retryingNow');
    });
    if (Date.now() - statsAt > 60000) loadStats(true);
  }

  XS.router.register('downloads', {
    tab: true, icon: 'download', label: function () { return t('nav.downloads'); },
    mount: function (el) { root = el; },
    show: function (params) { if (params && params.tab) tab = params.tab; render(); loadStats(false); XS.actions.refreshQueue(true); },
    refresh: function () { if (root && root.classList.contains('active')) render(); },
    tick: tick
  });
  S.on('queue', function () { if (root && root.classList.contains('active') && listEl) { renderSummary(); renderList(); } });
  S.on('storage', function () { if (root && root.classList.contains('active')) renderSummary(); });
  S.on('settings', function () { if (root && root.classList.contains('active')) renderSummary(); });
  XS.downloadsScreen = { jobMenu: jobMenu, groups: function () { return cb.groups(S.data.queue.jobs); }, reloadStats: function () { loadStats(true); } };
})();
