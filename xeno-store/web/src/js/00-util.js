/* XENO STORE — 00-util.js: DOM helpers, formatters, fetchJSON, icons. One global namespace: XS. */
(function () {
  'use strict';
  var XS = window.XS = window.XS || {};
  XS.version = '1.0.0';

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  /* h('div.cls#id', {attrs, on:{}, text, html, style:{}}, children) — tiny element builder. */
  function h(spec, attrs, children) {
    var m = /^([a-z0-9-]+)?((?:[.#][\w-]+)*)$/i.exec(spec || 'div');
    var tag = (m && m[1]) || 'div';
    var el = document.createElement(tag);
    if (m && m[2]) {
      var parts = m[2].match(/[.#][\w-]+/g) || [];
      for (var i = 0; i < parts.length; i++) {
        if (parts[i].charAt(0) === '.') el.classList.add(parts[i].slice(1));
        else el.id = parts[i].slice(1);
      }
    }
    if (attrs && (typeof attrs !== 'object' || Array.isArray(attrs) || attrs.nodeType)) { children = attrs; attrs = null; }
    if (attrs) {
      for (var k in attrs) {
        if (!Object.prototype.hasOwnProperty.call(attrs, k)) continue;
        var v = attrs[k];
        if (v === null || v === undefined || v === false) continue;
        if (k === 'text') el.textContent = v;
        else if (k === 'html') el.innerHTML = v;
        else if (k === 'cls' || k === 'className') el.className += (el.className ? ' ' : '') + v;
        else if (k === 'style' && typeof v === 'object') { for (var s in v) el.style[s] = v[s]; }
        else if (k === 'on') { for (var ev in v) el.addEventListener(ev, v[ev]); }
        else if (k === 'data') { for (var d in v) if (v[d] !== null && v[d] !== undefined) el.setAttribute('data-' + d.replace(/[A-Z]/g, function (c) { return '-' + c.toLowerCase(); }), v[d]); }  /* navRegion → data-nav-region */
        else if (k === 'nav') { el.setAttribute('data-nav', ''); if (v !== true) el.setAttribute('data-nav-id', v); el.tabIndex = -1; }
        else if (v === true) el.setAttribute(k, '');
        else el.setAttribute(k, v);
      }
    }
    append(el, children);
    return el;
  }
  function append(el, children) {
    if (children === null || children === undefined || children === false) return el;
    if (Array.isArray(children)) { for (var i = 0; i < children.length; i++) append(el, children[i]); return el; }
    if (children.nodeType) { el.appendChild(children); return el; }
    el.appendChild(document.createTextNode(String(children)));
    return el;
  }
  function clear(el) { while (el && el.firstChild) el.removeChild(el.firstChild); return el; }
  function svgEl(html) { var t = document.createElement('span'); t.innerHTML = html; return t.firstChild; }

  function escapeHtml(s) {
    return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* Sizes are shown in decimal units like the PS5 storage screen (1 GB = 1e9 bytes). */
  function fmtBytes(n, digits) {
    n = Number(n) || 0;
    if (n <= 0) return '0 B';
    var units = ['B', 'KB', 'MB', 'GB', 'TB'];
    var i = 0;
    while (n >= 1000 && i < units.length - 1) { n /= 1000; i++; }
    var d = digits !== undefined ? digits : (i >= 3 ? (n < 10 ? 2 : 1) : (n < 10 ? 1 : 0));
    return n.toFixed(d) + ' ' + units[i];
  }
  function fmtSpeed(bps) {
    bps = Number(bps) || 0;
    if (bps < 1000) return '0 KB/s';
    var mb = bps / 1e6;
    if (mb < 1) return (bps / 1e3).toFixed(0) + ' KB/s';
    if (mb < 100) return mb.toFixed(1) + ' MB/s';
    if (mb < 1000) return mb.toFixed(0) + ' MB/s';
    return (mb / 1000).toFixed(2) + ' GB/s';
  }
  function fmtDur(sec) {
    sec = Math.max(0, Math.round(Number(sec) || 0));
    if (!isFinite(sec)) return '—';
    var hh = Math.floor(sec / 3600), mm = Math.floor((sec % 3600) / 60), ss = sec % 60;
    if (hh >= 48) return Math.round(hh / 24) + 'd ' + (hh % 24) + 'h';
    if (hh > 0) return hh + 'h ' + pad2(mm) + 'm';
    if (mm > 0) return mm + 'm ' + pad2(ss) + 's';
    return ss + 's';
  }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function fmtDate(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso).slice(0, 10);
    try { return d.toLocaleDateString(XS.i18n ? XS.i18n.locale : undefined, { year: 'numeric', month: 'short', day: 'numeric' }); }
    catch (e) { return String(iso).slice(0, 10); }
  }
  function fmtDateTime(ts) {
    if (!ts) return '';
    var d = new Date(ts > 1e12 ? ts : ts * 1000);
    try { return d.toLocaleString(XS.i18n ? XS.i18n.locale : undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); }
    catch (e) { return d.toISOString().slice(0, 16).replace('T', ' '); }
  }
  function pct(written, total) { if (!total) return 0; return Math.max(0, Math.min(100, written / total * 100)); }
  function fmtPct(p) { return (p >= 99.95 ? 100 : p < 10 ? p.toFixed(1) : Math.floor(p)) + '%'; }
  function nowSec() { return Math.floor(Date.now() / 1000); }
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

  function debounce(fn, ms) {
    var t = null;
    return function () { var args = arguments, self = this; clearTimeout(t); t = setTimeout(function () { fn.apply(self, args); }, ms); };
  }
  /* Coalesces many calls into one per animation frame (batch DOM writes). */
  function rafBatch(fn) {
    var pending = false;
    return function () { if (pending) return; pending = true; requestAnimationFrame(function () { pending = false; fn(); }); };
  }

  /* Deterministic tint from a title so placeholders are stable and distinct. */
  function hashStr(s) { var x = 2166136261; s = String(s || ''); for (var i = 0; i < s.length; i++) { x ^= s.charCodeAt(i); x = (x * 16777619) >>> 0; } return x; }
  function tintFor(s) { var hue = hashStr(s) % 360; return 'hsl(' + hue + ', 48%, 32%)'; }
  function tintGradient(s) { var hue = hashStr(s) % 360; return 'linear-gradient(160deg, hsl(' + hue + ', 55%, 36%), hsl(' + ((hue + 40) % 360) + ', 50%, 18%))'; }
  function initials(title) {
    var w = String(title || '').replace(/[^\w\s]/g, ' ').trim().split(/\s+/).filter(function (x) { return x && !/^(the|a|an|of)$/i.test(x); });
    return (w.slice(0, 2).map(function (x) { return x.charAt(0); }).join('') || '?').toUpperCase();
  }

  var uidN = 0;
  function uid(prefix) { return (prefix || 'x') + (++uidN) + '_' + Date.now().toString(36); }

  var store = {
    get: function (k, dflt) { try { var v = localStorage.getItem('xs.' + k); return v === null ? dflt : JSON.parse(v); } catch (e) { return dflt; } },
    set: function (k, v) { try { localStorage.setItem('xs.' + k, JSON.stringify(v)); } catch (e) { /* private mode / quota: ignore */ } },
    del: function (k) { try { localStorage.removeItem('xs.' + k); } catch (e) { /* ignore */ } }
  };

  /* fetchJSON(url, {method, body, headers, timeout}) → Promise(resolves parsed JSON; rejects {status, error, message}). */
  function fetchJSON(url, opts) {
    opts = opts || {};
    var timeout = opts.timeout || 15000;
    var headers = opts.headers || {};
    var init = { method: opts.method || 'GET', headers: headers, cache: 'no-store' };
    if (opts.body !== undefined) { init.body = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body); headers['Content-Type'] = 'application/json'; }
    var ctl = (typeof AbortController === 'function') ? new AbortController() : null;
    if (ctl) init.signal = ctl.signal;
    var timer = null;
    var p = new Promise(function (resolve, reject) {
      timer = setTimeout(function () { if (ctl) ctl.abort(); reject({ status: 0, error: 'timeout', message: 'timeout' }); }, timeout);
      fetch(url, init).then(function (res) {
        var et = res.headers.get('ETag') || '';
        return res.text().then(function (txt) {
          var data = null;
          try { data = txt ? JSON.parse(txt) : {}; } catch (e) { data = { ok: false, error: 'bad_json', message: txt.slice(0, 200) }; }
          if (data && typeof data === 'object' && !Array.isArray(data)) data.$etag = et;
          if (!res.ok || (data && data.ok === false)) {
            reject({ status: res.status, error: (data && data.error) || ('http_' + res.status), message: (data && data.message) || res.statusText, data: data });
          } else resolve(data);
        });
      }, function (err) {
        reject({ status: 0, error: 'network', message: (err && err.message) || 'network' });
      });
    });
    p.then(function () { clearTimeout(timer); }, function () { clearTimeout(timer); });
    return p;
  }

  function isPhone() { return window.innerWidth < 820; }
  function reducedMotion() {
    return document.documentElement.getAttribute('data-motion') === 'reduce' ||
      (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }
  function copyText(text) {
    return new Promise(function (resolve) {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(function () { resolve(true); }, function () { resolve(legacyCopy(text)); });
      } else resolve(legacyCopy(text));
    });
  }
  function legacyCopy(text) {
    try {
      var ta = document.createElement('textarea'); ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.focus(); ta.select();
      var ok = document.execCommand('copy'); document.body.removeChild(ta); return !!ok;
    } catch (e) { return false; }
  }
  /* Opens a URL in the PS5 browser (new tab when allowed, else navigates the current page). */
  function openExternal(url) {
    var w = null;
    try { w = window.open(url, '_blank'); } catch (e) { w = null; }
    if (!w) { try { location.href = url; } catch (e2) { /* ignore */ } }
  }
  function normTitle(t) {
    return String(t || '').toLowerCase().replace(/[™®©]/g, '').replace(/\b(deluxe|ultimate|gold|complete|standard|definitive|digital|goty|game of the year|edition|remastered|bundle)\b/g, '')
      .replace(/[^a-z0-9]+/g, ' ').trim();
  }
  function seriesKey(t) {
    var s = String(t || '').replace(/[™®©]/g, '');
    var m = /^([^:–\-(]+)/.exec(s);
    s = (m ? m[1] : s).toLowerCase().replace(/\b(the|a|an)\b/g, '').replace(/\b\d+\b/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
    var words = s.split(' ').filter(Boolean);
    return words.slice(0, 2).join(' ');
  }

  /* Inline SVG icons (stroke-based, inherit currentColor). */
  var P = '<svg viewBox="0 0 24 24" aria-hidden="true">';
  var icons = {
    search: P + '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>',
    settings: P + '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3h.1a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8v.1a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>',
    heart: P + '<path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8l1 1L12 21l7.8-7.6 1-1a5.5 5.5 0 0 0 0-7.8z"/></svg>',
    download: P + '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5"/><path d="M12 15V3"/></svg>',
    pause: P + '<rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>',
    play: P + '<path d="M6 4l14 8-14 8z"/></svg>',
    x: P + '<path d="M18 6L6 18M6 6l12 12"/></svg>',
    check: P + '<path d="M20 6L9 17l-5-5"/></svg>',
    retry: P + '<path d="M1 4v6h6"/><path d="M3.5 15a9 9 0 1 0 2.1-9.4L1 10"/></svg>',
    trash: P + '<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/></svg>',
    folder: P + '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
    info: P + '<circle cx="12" cy="12" r="9"/><path d="M12 16v-4M12 8h.01"/></svg>',
    alert: P + '<path d="M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/></svg>',
    chevR: P + '<path d="M9 18l6-6-6-6"/></svg>',
    chevL: P + '<path d="M15 18l-6-6 6-6"/></svg>',
    chevD: P + '<path d="M6 9l6 6 6-6"/></svg>',
    star: P + '<path d="M12 2l3.1 6.3 6.9 1-5 4.9 1.2 6.8L12 17.8 5.8 21l1.2-6.8-5-4.9 6.9-1z"/></svg>',
    plus: P + '<path d="M12 5v14M5 12h14"/></svg>',
    minus: P + '<path d="M5 12h14"/></svg>',
    copy: P + '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
    external: P + '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><path d="M15 3h6v6"/><path d="M10 14L21 3"/></svg>',
    link: P + '<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/></svg>',
    qr: P + '<rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><path d="M14 14h3v3h-3zM20 14h1v1h-1zM14 20h1v1h-1zM20 20h1v1h-1zM17 17h4v4"/></svg>',
    zap: P + '<path d="M13 2L3 14h9l-1 8 10-12h-9z"/></svg>',
    hdd: P + '<rect x="2" y="7" width="20" height="10" rx="2"/><path d="M6 12h.01M10 12h.01"/></svg>',
    usb: P + '<path d="M12 2v18"/><path d="M12 20a2 2 0 1 0 0 .01"/><path d="M8 9l4-3 4 3"/><path d="M7 12h4M13 14h4"/><circle cx="7" cy="12" r="1.5"/><rect x="15" y="12.5" width="3" height="3"/></svg>',
    m2: P + '<rect x="3" y="8" width="18" height="8" rx="1"/><path d="M7 16v2M11 16v2M15 16v2M7 6v2M11 6v2M15 6v2"/></svg>',
    wifi: P + '<path d="M5 12.5a10 10 0 0 1 14 0"/><path d="M8.5 16a5 5 0 0 1 7 0"/><path d="M2 9a14 14 0 0 1 20 0"/><circle cx="12" cy="19.5" r="1"/></svg>',
    clock: P + '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
    compass: P + '<circle cx="12" cy="12" r="9"/><path d="M16 8l-2.5 5.5L8 16l2.5-5.5z"/></svg>',
    grid: P + '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>',
    library: P + '<path d="M4 4h4v16H4zM10 4h4v16h-4z"/><path d="M16.5 4.5l3.5 1-4 15-3.5-1z"/></svg>',
    moon: P + '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>',
    globe: P + '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/></svg>',
    bell: P + '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/></svg>',
    log: P + '<path d="M4 6h16M4 12h10M4 18h14"/></svg>',
    upload: P + '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M17 8l-5-5-5 5"/><path d="M12 3v12"/></svg>',
    more: P + '<circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/></svg>',
    filter: P + '<path d="M22 3H2l8 9.5V19l4 2v-8.5z"/></svg>',
    sort: P + '<path d="M3 6h18M6 12h12M10 18h4"/></svg>',
    shuffle: P + '<path d="M16 3h5v5"/><path d="M4 20L21 3"/><path d="M21 16v5h-5"/><path d="M15 15l6 6"/><path d="M4 4l5 5"/></svg>',
    up: P + '<path d="M12 19V5M5 12l7-7 7 7"/></svg>',
    down: P + '<path d="M12 5v14M19 12l-7 7-7-7"/></svg>',
    box: P + '<path d="M21 8l-9-5-9 5v8l9 5 9-5z"/><path d="M3 8l9 5 9-5M12 13v8"/></svg>',
    shield: P + '<path d="M12 2l8 3v6c0 5-3.5 9-8 11-4.5-2-8-6-8-11V5z"/><path d="M9 12l2 2 4-4"/></svg>',
    refresh: P + '<path d="M21 12a9 9 0 1 1-2.6-6.4"/><path d="M21 3v6h-6"/></svg>',
    power: P + '<path d="M18.4 6.6a9 9 0 1 1-12.8 0"/><path d="M12 2v10"/></svg>',
    phone: P + '<rect x="6" y="2" width="12" height="20" rx="2"/><path d="M11 18h2"/></svg>',
    home: P + '<path d="M3 11l9-8 9 8v10a1 1 0 0 1-1 1h-5v-7h-6v7H4a1 1 0 0 1-1-1z"/></svg>',
    eye: P + '<path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z"/><circle cx="12" cy="12" r="3"/></svg>',
    key: P + '<circle cx="8" cy="15" r="4"/><path d="M10.9 12.1L21 2M15 8l3 3M18 5l3 3"/></svg>',
    tag: P + '<path d="M20.6 13.4l-7.2 7.2a2 2 0 0 1-2.8 0L2 12V2h10l8.6 8.6a2 2 0 0 1 0 2.8z"/><path d="M7 7h.01"/></svg>',
    image: P + '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>',
    gamepad: P + '<path d="M6 12h4M8 10v4M15 11h.01M18 13h.01"/><path d="M17.3 5H6.7a4 4 0 0 0-4 3.6l-.7 7a3 3 0 0 0 5.2 2.2L9.5 15h5l2.3 2.8a3 3 0 0 0 5.2-2.2l-.7-7a4 4 0 0 0-4-3.6z"/></svg>',
    sliders: P + '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3"/><path d="M1 14h6M9 8h6M17 16h6"/></svg>',
    cloud: P + '<path d="M18 10h-1.3A6 6 0 1 0 6 15h12a3 3 0 0 0 0-6z"/></svg>',
    swap: P + '<path d="M17 3l4 4-4 4"/><path d="M3 7h18"/><path d="M7 21l-4-4 4-4"/><path d="M21 17H3"/></svg>',
    installed: P + '<path d="M20 7L9 18l-5-5"/><path d="M4 21h16"/></svg>',
    stop: P + '<rect x="5" y="5" width="14" height="14" rx="2"/></svg>'
  };
  function icon(name) { return icons[name] || icons.info; }

  /* PlayStation button glyphs for the legend and buttons. */
  var G = '<svg class="glyph %c" viewBox="0 0 24 24" aria-hidden="true"><circle class="ring" cx="12" cy="12" r="10.5"/>';
  var glyphs = {
    cross: G.replace('%c', 'cross') + '<path class="in" d="M8 8l8 8M16 8l-8 8"/></svg>',
    circle: G.replace('%c', 'circle') + '<circle class="in" cx="12" cy="12" r="4.6"/></svg>',
    square: G.replace('%c', 'square') + '<rect class="in" x="7.6" y="7.6" width="8.8" height="8.8"/></svg>',
    triangle: G.replace('%c', 'triangle') + '<path class="in" d="M12 7l5.2 9H6.8z"/></svg>',
    L1: '<svg class="glyph shoulder" viewBox="0 0 28 24" aria-hidden="true"><rect x="2" y="5" width="24" height="14" rx="5"/><text x="14" y="16" text-anchor="middle">L1</text></svg>',
    R1: '<svg class="glyph shoulder" viewBox="0 0 28 24" aria-hidden="true"><rect x="2" y="5" width="24" height="14" rx="5"/><text x="14" y="16" text-anchor="middle">R1</text></svg>',
    L2: '<svg class="glyph shoulder" viewBox="0 0 28 24" aria-hidden="true"><rect x="2" y="5" width="24" height="14" rx="5"/><text x="14" y="16" text-anchor="middle">L2</text></svg>',
    R2: '<svg class="glyph shoulder" viewBox="0 0 28 24" aria-hidden="true"><rect x="2" y="5" width="24" height="14" rx="5"/><text x="14" y="16" text-anchor="middle">R2</text></svg>',
    options: '<svg class="glyph shoulder" viewBox="0 0 28 24" aria-hidden="true"><rect x="2" y="5" width="24" height="14" rx="5"/><path d="M9 10h10M9 14h10" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
    dpad: '<svg class="glyph" viewBox="0 0 24 24" aria-hidden="true"><path class="in" d="M9 3h6v6h6v6h-6v6H9v-6H3V9h6z"/></svg>'
  };
  function glyph(name) { return glyphs[name] || ''; }

  XS.util = {
    $: $, $$: $$, h: h, append: append, clear: clear, svgEl: svgEl, escapeHtml: escapeHtml,
    fmtBytes: fmtBytes, fmtSpeed: fmtSpeed, fmtDur: fmtDur, fmtDate: fmtDate, fmtDateTime: fmtDateTime, pad2: pad2, pct: pct, fmtPct: fmtPct,
    nowSec: nowSec, clamp: clamp, debounce: debounce, rafBatch: rafBatch, hashStr: hashStr, tintFor: tintFor, tintGradient: tintGradient,
    initials: initials, uid: uid, store: store, fetchJSON: fetchJSON, isPhone: isPhone, reducedMotion: reducedMotion, copyText: copyText,
    openExternal: openExternal, normTitle: normTitle, seriesKey: seriesKey, icon: icon, glyph: glyph
  };
})();
