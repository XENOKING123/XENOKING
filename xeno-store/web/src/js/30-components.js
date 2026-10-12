/* XENO STORE — 30-components.js: covers, cards, rails, hero, chips, sheets, menus, dialogs, toasts, progress, controls, QR. */
(function () {
  'use strict';
  var XS = window.XS, U = XS.util, S = XS.state, h = U.h, t = XS.t;
  var ui = {};

  /* ---------- Cover image with skeleton shimmer, fallback chain and tinted placeholder ---------- */
  ui.cover = function (src, fallback, title, opts) {
    opts = opts || {};
    var el = h('div.cover', { style: { background: U.tintGradient(title) } });
    var ph = h('div.ph', [U.initials(title), h('small', { text: opts.phLabel || '' })]);
    el.appendChild(ph);
    var urls = [src, fallback].filter(Boolean);
    if (!urls.length) { el.classList.add('failed'); return el; }
    var img = document.createElement('img');
    img.alt = '';
    img.loading = 'lazy';
    img.decoding = 'async';
    var idx = 0;
    img.onload = function () { el.classList.add('loaded'); };
    img.onerror = function () {
      idx++;
      if (idx < urls.length) img.src = urls[idx];
      else el.classList.add('failed');
    };
    img.src = urls[0];
    el.appendChild(img);
    return el;
  };

  ui.platChip = function (platform, small) {
    var p = platform === 'PS4' ? 'ps4' : 'ps5';
    return h('span.chip.' + p + (small ? '.sm' : ''), { text: platform === 'PS4' ? 'PS4' : 'PS5' });
  };
  ui.fmtChip = function (fmt) { return h('span.chip.fmt.sm', { text: fmtLabel(fmt) }); };
  function fmtLabel(f) { return f === 'PAGE' ? t('format.page') : String(f || '').toUpperCase(); }
  ui.fmtLabel = fmtLabel;
  ui.sizeRange = function (g) {
    if (!g.sizeMax) return t('common.sizeUnknown');
    if (g.sizeMin && g.sizeMin !== g.sizeMax) return U.fmtBytes(g.sizeMin) + ' – ' + U.fmtBytes(g.sizeMax);
    return U.fmtBytes(g.sizeMax);
  };
  ui.tick = function (label) { return h('span.tick', { html: U.icon('check') + (label ? '<span>' + U.escapeHtml(label) + '</span>' : '') }); };
  ui.svg = function (name) { return U.svgEl(U.icon(name)); };
  ui.glyph = function (name) { return U.svgEl(U.glyph(name)); };

  /* ---------- Game card ---------- */
  ui.card = function (g, opts) {
    opts = opts || {};
    var job = opts.job || null;
    var card = h('a.card', { nav: 'g:' + g.id, data: { hints: 'open fav', game: g.id }, href: '#game/' + encodeURIComponent(g.id) });
    card.appendChild(ui.cover(g.cover, g.coverFallback, g.title));
    card.appendChild(h('span.plat.' + (g.platform === 'PS4' ? 'ps4' : 'ps5'), { text: g.platform }));
    if (g.sizeMax) card.appendChild(h('span.size', { text: U.fmtBytes(g.sizeMax, g.sizeMax >= 1e10 ? 0 : 1) }));
    if (g.verified) card.appendChild(h('span.vtick', { html: U.icon('check'), title: t('common.verified') }));
    card.appendChild(h('span.fav-dot', { html: U.icon('heart') }));
    if (S.isFav(g.id)) card.classList.add('fav');
    if (job && job.total) card.appendChild(h('div.prog', [h('i', { style: { width: U.pct(job.written, job.total).toFixed(1) + '%' } })]));
    card.appendChild(h('div.title.clamp2', { text: g.title }));
    var sub = h('div.sub');
    if (job) sub.appendChild(h('span.gold', { text: t('dl.state.' + job.state) + (job.total ? ' · ' + U.fmtPct(U.pct(job.written, job.total)) : '') }));
    else {
      var fmts = uniqueFormats(g);
      sub.appendChild(h('span.ellipsis', { text: fmts.slice(0, 3).join(' · ') || (g.publisher || '') }));
    }
    card.appendChild(sub);
    card.addEventListener('click', function (e) { e.preventDefault(); XS.router.go('game', { id: g.id }); });
    return card;
  };
  function uniqueFormats(g) {
    var seen = {}, out = [];
    (g.releases || []).forEach(function (r) { var f = fmtLabel(r.format); if (!seen[f]) { seen[f] = 1; out.push(f); } });
    return out;
  }
  ui.uniqueFormats = uniqueFormats;

  /* ---------- Rail (horizontal, cards snap, focus kept at 1/3 by nav) ---------- */
  ui.rail = function (title, games, opts) {
    opts = opts || {};
    if (!games || !games.length) return null;
    var sec = h('section.rail', { data: { rail: opts.id || '' } });
    var head = h('div.section-head', [
      h('h2.section-title', [title, h('span.count', { text: t('common.nGames', { n: opts.total || games.length }) })])
    ]);
    if (opts.more) {
      head.appendChild(h('span.spacer'));
      head.appendChild(h('button.btn.ghost.sm', { nav: 'more:' + (opts.id || title), text: t('common.seeAll'), on: { click: opts.more } }));
    }
    sec.appendChild(head);
    var track = h('div.rail-track', { data: { navRegion: '' } });
    var limit = opts.limit || 30;
    for (var i = 0; i < games.length && i < limit; i++) {
      if (opts.render) track.appendChild(opts.render(games[i]));
      else track.appendChild(ui.card(games[i], { job: opts.jobs ? opts.jobs[games[i].id] : null }));
    }
    sec.appendChild(track);
    return sec;
  };
  ui.genreTile = function (genre, count) {
    var tile = h('a.tile', { nav: 'genre:' + genre, style: { '--tile-tint': U.tintFor(genre) }, href: '#browse' }, [
      h('span', { text: genre }), h('span.count', { text: t('common.nGames', { n: count }) })
    ]);
    tile.style.setProperty('--tile-tint', U.tintFor(genre));
    tile.addEventListener('click', function (e) { e.preventDefault(); XS.router.go('browse', { genre: genre }); });
    return tile;
  };

  /* ---------- Layers: sheet / dialog / menu / overlay. The router keeps history in sync. ---------- */
  ui.layers = [];
  var host = null;
  function layerHost() { return host || (host = U.$('#layers')); }
  ui.openLayer = function (el, opts) {
    opts = opts || {};
    var handle = { el: el, key: opts.key || U.uid('layer'), onClose: opts.onClose || null, opener: document.activeElement, type: opts.type || 'sheet', closed: false };
    ui.layers.push(handle);
    layerHost().appendChild(el);
    if (XS.router) XS.router.layerOpened(handle);
    XS.nav.key = handle.key;
    requestAnimationFrame(function () { XS.nav.focusFirst(el); });
    return handle;
  };
  /* closeLayer(handle): user-initiated → the router pops history and calls back closeNow. */
  ui.closeLayer = function (handle, fromHistory) {
    if (!handle || handle.closed) return;
    if (!fromHistory && XS.router && XS.router.layerClosing(handle)) return;
    ui.closeNow(handle);
  };
  ui.closeNow = function (handle, result) {
    if (!handle || handle.closed) return;
    handle.closed = true;
    var i = ui.layers.indexOf(handle); if (i >= 0) ui.layers.splice(i, 1);
    var el = handle.el;
    el.classList.add('closing');
    el.setAttribute('inert', '');
    var dur = U.reducedMotion() ? 0 : 230;
    setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, dur);
    if (handle.onClose) { try { handle.onClose(result); } catch (e) { console.error(e); } }
    var top = ui.layers[ui.layers.length - 1];
    if (top) { XS.nav.key = top.key; XS.nav.restore(top.el); }
    else if (XS.router) { XS.router.restoreScreenFocus(handle.opener); }
  };
  ui.closeTop = function () { var top = ui.layers[ui.layers.length - 1]; if (top) { ui.closeLayer(top); return true; } return false; };
  ui.topLayer = function () { return ui.layers[ui.layers.length - 1] || null; };

  /* sheet({title, sub, body(el), foot[], cls, key, onClose}) */
  ui.sheet = function (o) {
    var layer = h('div.layer');
    var sheet = h('div.sheet' + (o.cls ? '.' + o.cls : ''), { 'data-nav-scope': '', role: 'dialog', 'aria-label': o.title || '' });
    var head = h('div.sheet-head');
    var ttl = h('div.grow', [h('h2', { text: o.title || '' })]);
    if (o.sub) ttl.appendChild(h('div.sub', { text: o.sub }));
    head.appendChild(ttl);
    var closeBtn = h('button.iconbtn', { nav: 'sheet-close', html: U.icon('x'), 'aria-label': t('common.close'), data: { hints: 'select' } });
    head.appendChild(closeBtn);
    sheet.appendChild(head);
    var body = h('div.sheet-body', { data: { navRegion: '' } });
    sheet.appendChild(body);
    var foot = null;
    if (o.foot && o.foot.length) { foot = h('div.sheet-foot', o.foot); sheet.appendChild(foot); }
    layer.appendChild(h('div.backdrop'));
    layer.appendChild(sheet);
    var handle = null;
    closeBtn.addEventListener('click', function () { ui.closeLayer(handle); });
    layer.firstChild.addEventListener('click', function () { ui.closeLayer(handle); });
    handle = ui.openLayer(layer, { key: o.key || U.uid('sheet'), onClose: o.onClose, type: 'sheet' });
    handle.body = body; handle.foot = foot; handle.head = head; handle.sheet = sheet;
    if (typeof o.body === 'function') o.body(body, handle); else if (o.body) U.append(body, o.body);
    return handle;
  };

  /* dialog({title, text, body, buttons:[{label, cls, primary, autofocus, onClick(handle)}], key}) */
  ui.dialog = function (o) {
    var layer = h('div.layer.dialog-wrap');
    var box = h('div.dialog', { 'data-nav-scope': '', role: 'dialog' });
    if (o.title) box.appendChild(h('h2', { text: o.title }));
    if (o.text) box.appendChild(h('p', { text: o.text }));
    if (o.body) U.append(box, typeof o.body === 'function' ? o.body() : o.body);
    var acts = h('div.actions');
    var handle = null;
    (o.buttons || []).forEach(function (b, i) {
      var btn = h('button.btn' + (b.primary ? '.primary' : '') + (b.cls ? '.' + b.cls : ''), { nav: 'dlg-' + i, text: b.label });
      if (b.autofocus) btn.setAttribute('data-autofocus', '');
      btn.addEventListener('click', function () { if (b.onClick) b.onClick(handle); else ui.closeLayer(handle); });
      acts.appendChild(btn);
    });
    box.appendChild(acts);
    layer.appendChild(h('div.backdrop'));
    layer.appendChild(box);
    handle = ui.openLayer(layer, { key: o.key || U.uid('dlg'), onClose: o.onClose, type: 'dialog' });
    handle.box = box;
    return handle;
  };
  ui.confirm = function (title, text, okLabel, danger) {
    return new Promise(function (resolve) {
      var done = false;
      ui.dialog({
        title: title, text: text,
        onClose: function () { if (!done) { done = true; resolve(false); } },
        buttons: [
          { label: t('common.cancel'), autofocus: true, onClick: function (hd) { done = true; resolve(false); ui.closeLayer(hd); } },
          { label: okLabel || t('common.ok'), primary: !danger, cls: danger ? 'danger' : '', onClick: function (hd) { done = true; resolve(true); ui.closeLayer(hd); } }
        ]
      });
    });
  };
  /* prompt(title, {label, value, placeholder, text, type, okLabel}) → Promise(string|null) */
  ui.prompt = function (title, o) {
    o = o || {};
    return new Promise(function (resolve) {
      var done = false;
      var input = h('input.input', { nav: 'prompt-input', type: o.type || 'text', value: o.value || '', placeholder: o.placeholder || '', autocomplete: 'off', spellcheck: 'false', 'data-autofocus': '' });
      input.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); finish(input.value); } });
      var handle = null;
      function finish(v) { if (done) return; done = true; resolve(v); ui.closeLayer(handle); }
      handle = ui.dialog({
        title: title, text: o.text || '',
        body: h('div.field', [o.label ? h('label', { text: o.label }) : null, input]),
        onClose: function () { if (!done) { done = true; resolve(null); } },
        buttons: [
          { label: t('common.cancel'), onClick: function () { finish(null); } },
          { label: o.okLabel || t('common.ok'), primary: true, onClick: function () { finish(input.value); } }
        ]
      });
    });
  };
  ui.askPin = function () {
    return ui.prompt(t('pin.title'), { text: t('pin.text'), label: t('pin.label'), type: 'password', placeholder: '0000', okLabel: t('pin.unlock') }).then(function (v) {
      if (v === null) return false;
      S.data.pin = String(v).trim(); U.store.set('pin', S.data.pin); return true;
    });
  };

  /* menu(anchor, items:[{label, icon, sub, danger, checked, disabled, onSelect}, 'sep', {title}]) */
  ui.menu = function (anchor, items, opts) {
    opts = opts || {};
    var layer = h('div.layer.menu-wrap');
    var menu = h('div.menu', { 'data-nav-scope': '', role: 'menu' });
    if (opts.title) menu.appendChild(h('div.mtitle', { text: opts.title }));
    var handle = null;
    items.forEach(function (it, i) {
      if (it === 'sep') { menu.appendChild(h('div.sep')); return; }
      if (it.title) { menu.appendChild(h('div.mtitle', { text: it.title })); return; }
      var mi = h('button.mi' + (it.danger ? '.danger' : ''), { nav: 'mi-' + i, role: 'menuitem' });
      if (it.disabled) mi.setAttribute('aria-disabled', 'true');
      if (it.icon) mi.appendChild(ui.svg(it.icon));
      var lab = h('span.grow', [h('span', { text: it.label })]);
      if (it.sub) lab.appendChild(h('span.sub', { text: it.sub }));
      mi.appendChild(lab);
      if (it.checked) mi.appendChild(h('span.check', { html: U.icon('check') }));
      if (it.autofocus || (it.checked && !opts.noAutofocus)) mi.setAttribute('data-autofocus', '');
      mi.addEventListener('click', function () {
        if (it.disabled) return;
        if (!it.keepOpen) ui.closeLayer(handle);
        if (it.onSelect) it.onSelect(it, handle);
      });
      menu.appendChild(mi);
    });
    layer.appendChild(h('div.backdrop', { style: { background: 'rgba(3,6,16,.35)' } }));
    layer.appendChild(menu);
    layer.firstChild.addEventListener('click', function () { ui.closeLayer(handle); });
    handle = ui.openLayer(layer, { key: U.uid('menu'), type: 'menu', onClose: opts.onClose });
    /* Position under the anchor, kept inside the viewport. */
    requestAnimationFrame(function () {
      var r = anchor && anchor.getBoundingClientRect ? anchor.getBoundingClientRect() : { left: 40, bottom: 80, right: 300, top: 40, width: 0, height: 0 };
      var mw = menu.offsetWidth, mh = menu.offsetHeight;
      var left = Math.min(Math.max(12, r.left), window.innerWidth - mw - 12);
      var top = r.bottom + 8;
      if (top + mh > window.innerHeight - 12) top = Math.max(12, r.top - mh - 8);
      if (U.isPhone()) { left = 12; menu.style.width = (window.innerWidth - 24) + 'px'; menu.style.maxWidth = 'none'; }
      menu.style.left = left + 'px'; menu.style.top = top + 'px';
    });
    return handle;
  };

  /* ---------- Toasts ---------- */
  ui.toast = function (o) {
    if (typeof o === 'string') o = { title: o };
    var box = U.$('#toasts');
    var el = h('div.toast' + (o.cls ? '.' + o.cls : ''));
    if (o.cover) el.appendChild(ui.cover(o.cover, '', o.title));
    else el.appendChild(h('span.ic', { html: U.icon(o.icon || (o.cls === 'bad' ? 'alert' : o.cls === 'good' ? 'check' : 'info')) }));
    var body = h('div.grow', [h('div.t', { text: o.title })]);
    if (o.desc) body.appendChild(h('div.d', { text: o.desc }));
    el.appendChild(body);
    if (o.action) {
      var b = h('button.btn.sm' + (o.action.primary ? '.primary' : ''), { nav: 'toast-act', text: o.action.label });
      b.addEventListener('click', function () { remove(); o.action.onClick(); });
      el.appendChild(b);
    }
    box.appendChild(el);
    var timer = setTimeout(remove, o.timeout || 4500);
    function remove() { clearTimeout(timer); if (!el.parentNode) return; el.classList.add('out'); setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, U.reducedMotion() ? 0 : 220); }
    el.addEventListener('click', function (e) { if (!e.target.closest('button')) remove(); });
    while (box.children.length > 4) box.removeChild(box.firstChild);
    return { close: remove, el: el };
  };
  ui.errorToast = function (err, title) {
    XS.sound && XS.sound.error();
    return ui.toast({ cls: 'bad', title: title || t('err.title'), desc: ui.errorText(err), timeout: 7000 });
  };
  /* Every error names the problem and the fix in one line; raw codes only in Diagnostics. */
  ui.errorText = function (err) {
    if (!err) return t('err.unknown');
    var code = err.errorCode || err.error || (typeof err === 'string' ? err : '');
    var key = 'err.' + code;
    if (code && XS.i18n.has(key)) return t(key);
    if (err.status === 0) return t('err.network');
    return err.message || t('err.unknown');
  };

  /* ---------- Progress: bar with segment visualization ---------- */
  ui.progressBar = function (job) {
    var bar = h('div.bar' + (job.state === 'downloading' ? '.gold' : job.state === 'failed' ? '.bad' : job.state === 'done' || job.state === 'installed' ? '.good' : job.state === 'paused' ? '.warn' : ''));
    ui.updateBar(bar, job);
    return bar;
  };
  ui.updateBar = function (bar, job) {
    var total = job.total || 0;
    var segs = job.segments || [];
    bar.className = 'bar' + (job.state === 'downloading' ? ' gold' : job.state === 'failed' ? ' bad' : job.state === 'done' || job.state === 'installed' ? ' good' : job.state === 'paused' ? ' warn' : '') + (job.state === 'verifying' || job.state === 'installing' ? ' striped' : '');
    if (total && segs.length > 1 && job.state !== 'done' && job.state !== 'installed' && job.state !== 'verifying') {
      /* segments: [[startMiB, endMiB, doneMiB]] in catalog units; we only need proportions. */
      var span = 0;
      for (var i = 0; i < segs.length; i++) span = Math.max(span, segs[i][1]);
      if (!span) span = total;
      U.clear(bar);
      for (var k = 0; k < segs.length; k++) {
        var s = segs[k], w = (s[1] - s[0]) / span * 100, d = (s[1] - s[0]) ? (s[2] - s[0]) / (s[1] - s[0]) * 100 : 0;
        if (s[2] === undefined) d = 0;
        var seg = h('div.seg' + (d >= 99.9 ? '.full' : d > 0 && job.state === 'downloading' ? '.live' : ''), { style: { left: (s[0] / span * 100) + '%', width: w + '%' } }, [h('b', { style: { width: Math.max(0, Math.min(100, d)) + '%' } })]);
        bar.appendChild(seg);
      }
    } else {
      var i0 = bar.querySelector('i') || bar.appendChild(h('i'));
      if (bar.querySelector('.seg')) { U.clear(bar); i0 = bar.appendChild(h('i')); }
      var p = job.state === 'done' || job.state === 'installed' ? 100 : U.pct(job.written, total);
      if (job.state === 'verifying' && total) p = U.pct(job.written, total);
      i0.style.width = p.toFixed(2) + '%';
    }
  };
  ui.sparkline = function (hist, w, h0) {
    w = w || 120; h0 = h0 || 34;
    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'spark'); svg.setAttribute('viewBox', '0 0 ' + w + ' ' + h0); svg.setAttribute('preserveAspectRatio', 'none');
    ui.updateSparkline(svg, hist, w, h0);
    return svg;
  };
  ui.updateSparkline = function (svg, hist, w, h0) {
    w = w || 120; h0 = h0 || 34;
    hist = (hist || []).slice(-60);
    U.clear(svg);
    if (hist.length < 2) return;
    var max = 1; for (var i = 0; i < hist.length; i++) max = Math.max(max, hist[i]);
    var pts = [];
    for (var k = 0; k < hist.length; k++) pts.push([(k / (hist.length - 1) * w).toFixed(1), (h0 - 2 - (hist[k] / max) * (h0 - 4)).toFixed(1)]);
    var d = 'M' + pts.map(function (p) { return p[0] + ' ' + p[1]; }).join(' L');
    var area = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    area.setAttribute('class', 'area'); area.setAttribute('d', d + ' L' + w + ' ' + h0 + ' L0 ' + h0 + ' Z');
    var line = document.createElementNS('http://www.w3.org/2000/svg', 'path'); line.setAttribute('d', d);
    svg.appendChild(area); svg.appendChild(line);
  };
  ui.statePill = function (job) {
    var pill = h('span.state-pill.' + job.state, [h('i.dot'), h('span', { text: t('dl.state.' + job.state) })]);
    return pill;
  };

  /* ---------- Controls ---------- */
  ui.toggleRow = function (o) {
    var row = h('button.lrow', { nav: o.id, role: 'switch', 'aria-checked': o.value ? 'true' : 'false', data: { hints: 'toggle' } });
    if (o.icon) row.appendChild(h('span.ic', { html: U.icon(o.icon) }));
    var main = h('div.main', [h('div.name', { text: o.label })]);
    if (o.desc) main.appendChild(h('div.desc', { text: o.desc }));
    row.appendChild(main);
    var tg = h('span.toggle' + (o.value ? '.on' : ''));
    row.appendChild(tg);
    row.addEventListener('click', function () {
      var v = !tg.classList.contains('on');
      tg.classList.toggle('on', v); row.setAttribute('aria-checked', v ? 'true' : 'false');
      if (o.onChange) o.onChange(v, row);
    });
    return row;
  };
  ui.valueRow = function (o) {
    var row = h('button.lrow' + (o.danger ? '.danger' : ''), { nav: o.id, data: { hints: o.hints || 'select' } });
    if (o.icon) row.appendChild(h('span.ic', { html: U.icon(o.icon) }));
    var main = h('div.main', [h('div.name', { text: o.label })]);
    if (o.desc) main.appendChild(h('div.desc', { text: o.desc }));
    row.appendChild(main);
    var val = h('span.val');
    if (o.valueEl) val.appendChild(o.valueEl); else if (o.value !== undefined && o.value !== null) val.appendChild(h('span', { text: String(o.value) }));
    if (!o.noChevron) val.appendChild(ui.svg('chevR'));
    row.appendChild(val);
    if (o.onClick) row.addEventListener('click', function () { o.onClick(row); });
    if (o.disabled) row.setAttribute('aria-disabled', 'true');
    return row;
  };
  ui.stepper = function (o) {
    var v = o.value;
    var wrap = h('div.stepper');
    var minus = h('button.sb', { nav: o.id + '-minus', text: '−', 'aria-label': t('common.decrease') });
    var val = h('span.sv', { text: o.format ? o.format(v) : String(v) });
    var plus = h('button.sb', { nav: o.id + '-plus', text: '+', 'aria-label': t('common.increase') });
    function set(nv) { nv = U.clamp(nv, o.min, o.max); if (nv === v) return; v = nv; val.textContent = o.format ? o.format(v) : String(v); if (o.onChange) o.onChange(v); }
    minus.addEventListener('click', function () { set(v - (o.step || 1)); });
    plus.addEventListener('click', function () { set(v + (o.step || 1)); });
    wrap.appendChild(minus); wrap.appendChild(val); wrap.appendChild(plus);
    wrap.set = set; wrap.get = function () { return v; };
    return wrap;
  };
  ui.segControl = function (o) {
    var wrap = h('div.seg-ctl', { role: 'radiogroup' });
    var v = o.value;
    o.options.forEach(function (opt, i) {
      var b = h('button.so' + (opt.value === v ? '.on' : ''), { nav: o.id + '-' + i, text: opt.label, role: 'radio', 'aria-checked': opt.value === v ? 'true' : 'false' });
      b.addEventListener('click', function () {
        v = opt.value;
        U.$$('.so', wrap).forEach(function (x) { x.classList.toggle('on', x === b); x.setAttribute('aria-checked', x === b ? 'true' : 'false'); });
        if (o.onChange) o.onChange(v);
      });
      wrap.appendChild(b);
    });
    return wrap;
  };
  ui.subtabs = function (o) {
    var wrap = h('div.subtabs', { role: 'tablist' });
    o.tabs.forEach(function (tab, i) {
      var b = h('button.subtab' + (tab.id === o.value ? '.on' : ''), { nav: o.id + '-' + tab.id, role: 'tab', data: { tab: tab.id } }, [h('span', { text: tab.label })]);
      if (tab.count !== undefined) b.appendChild(h('span.n', { text: String(tab.count) }));
      b.addEventListener('click', function () {
        U.$$('.subtab', wrap).forEach(function (x) { x.classList.toggle('on', x === b); });
        if (o.onChange) o.onChange(tab.id);
      });
      wrap.appendChild(b);
    });
    wrap.setCount = function (id, n) { var b = wrap.querySelector('[data-tab="' + id + '"] .n'); if (b) b.textContent = String(n); };
    return wrap;
  };
  ui.emptyState = function (title, hint, actions) {
    var e = h('div.empty', [h('h3', { text: title }), hint ? h('p', { text: hint }) : null]);
    if (actions && actions.length) e.appendChild(h('div.actions', actions));
    return e;
  };
  ui.searchBox = function (o) {
    var box = h('div.search-box');
    box.appendChild(ui.svg('search'));
    var input = h('input.input', { nav: o.id, type: 'search', placeholder: o.placeholder || '', autocomplete: 'off', autocorrect: 'off', autocapitalize: 'off', spellcheck: 'false', value: o.value || '', enterkeyhint: 'search', 'aria-label': o.placeholder || '' });
    input.addEventListener('input', function () { if (o.onInput) o.onInput(input.value); });
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); if (o.onEnter) o.onEnter(input.value); else input.blur(); } });
    box.appendChild(input);
    box.input = input;
    return box;
  };

  /* ---------- QR (vendored qrcode-generator) ---------- */
  ui.qr = function (text) {
    var box = h('div.qr');
    try {
      var q = window.qrcode(0, 'M');
      q.addData(text);
      q.make();
      box.innerHTML = q.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
    } catch (e) {
      box.appendChild(h('div', { text: text, style: { color: '#000', fontSize: '12px', wordBreak: 'break-all' } }));
    }
    return box;
  };

  /* ---------- Skeleton rail while the catalog loads ---------- */
  ui.skeletonRail = function (n) {
    var track = h('div.rail-track');
    for (var i = 0; i < (n || 8); i++) track.appendChild(h('div.skel', { style: { width: 'var(--card-w)', height: 'calc(var(--card-w) * 1.33 + 70px)', flex: '0 0 auto', borderRadius: '18px' } }));
    return h('section.rail', [h('div.section-head', [h('div.skel', { style: { width: '220px', height: '24px' } })]), track]);
  };

  /* ---------- Virtualized grid: renders only rows within ±2 rows of the scroller viewport ---------- */
  ui.vgrid = function (container, items, scroller, render) {
    var cols = 0, rowH = 0, gap = 18, pitch = 0, rows = {}, rafPending = false, width = 0;
    container.classList.add('vgrid');
    function measure() {
      var W = container.clientWidth;
      if (!W) return false;
      var cs = getComputedStyle(document.documentElement);
      var cardW = parseFloat(cs.getPropertyValue('--card-w')) || 196;
      gap = parseFloat(cs.getPropertyValue('--rail-gap')) || 18;
      var c = Math.max(1, Math.floor((W + gap) / (cardW + gap)));
      if (c === cols && W === width && rowH) return true;
      cols = c; width = W;
      var probe = rowEl(0); probe.style.visibility = 'hidden';
      if (items.length) probe.appendChild(render(items[0]));
      container.appendChild(probe);
      rowH = probe.offsetHeight || Math.round(cardW * 1.33 + 70);
      container.removeChild(probe);
      pitch = rowH + gap;
      var n = Math.ceil(items.length / cols);
      container.style.height = Math.max(0, n * pitch - gap) + 'px';
      for (var k in rows) { if (rows[k].parentNode) container.removeChild(rows[k]); }
      rows = {};
      return true;
    }
    function rowEl(i) {
      var r = h('div.vrow', { data: { row: i } });
      r.style.top = (i * pitch) + 'px';
      r.style.gridTemplateColumns = 'repeat(' + cols + ', 1fr)';
      return r;
    }
    function update() {
      rafPending = false;
      if (!container.isConnected) { detach(); return; }
      if (!measure()) return;
      var sb = scroller.getBoundingClientRect(), cb = container.getBoundingClientRect();
      var top = sb.top - cb.top, bottom = top + sb.height;
      var first = Math.max(0, Math.floor(top / pitch) - 2);
      var last = Math.min(Math.ceil(items.length / cols) - 1, Math.ceil(bottom / pitch) + 2);
      var active = document.activeElement;
      for (var k in rows) {
        var idx = Number(k);
        if ((idx < first || idx > last) && !(active && rows[k].contains(active))) { container.removeChild(rows[k]); delete rows[k]; }
      }
      for (var i = first; i <= last; i++) {
        if (rows[i]) continue;
        var r = rowEl(i);
        for (var c = 0; c < cols; c++) { var it = items[i * cols + c]; if (it) r.appendChild(render(it)); }
        rows[i] = r; container.appendChild(r);
      }
    }
    function schedule() { if (rafPending) return; rafPending = true; requestAnimationFrame(update); }
    function detach() { scroller.removeEventListener('scroll', schedule); window.removeEventListener('resize', schedule); }
    scroller.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    requestAnimationFrame(update);
    container.vgridUpdate = schedule;
    return { update: schedule, detach: detach };
  };

  XS.ui = ui;
})();
