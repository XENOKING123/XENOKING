/* XENO STORE — 20-nav.js: spatial navigation (Overdrive's geometric scoring ported to plain JS),
   focus memory per screen, scroll-into-view with margins, rails keep focus at 1/3, gamepad polling, shortcuts. */
(function () {
  'use strict';
  var XS = window.XS, U = XS.util;
  var KEYS = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };
  var remembered = {};
  var nav = {
    key: 'discover',              /* current screen/layer key for focus memory (set by the router) */
    actions: {},                  /* back(), tabPrev(), tabNext(), search(), favorite(), options() — set by the router */
    lastPadAt: 0,
    padEnabled: true
  };

  /* With a sheet/menu open (data-nav-scope), navigation is trapped inside the topmost one. */
  function scope() {
    var layers = U.$$('#layers [data-nav-scope]');
    return layers.length ? layers[layers.length - 1] : null;
  }
  function visible(el) {
    if (el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true') return false;
    if (el.closest('[inert]')) return false;
    var r = el.getClientRects();
    return r.length > 0 && (r[0].width > 0 || r[0].height > 0);
  }
  function focusables() {
    var sc = scope();
    var pool;
    if (sc) pool = U.$$('[data-nav]', sc);
    else {
      pool = U.$$('#topbar [data-nav], #banners [data-nav], #phonebar [data-nav]');
      var screen = U.$('#main .screen.active');
      if (screen) pool = pool.concat(U.$$('[data-nav]', screen));
    }
    return pool.filter(visible);
  }
  function isChrome(el) { return !!el.closest('#topbar, #phonebar, #banners'); }

  /* Overdrive scoring: horizontal = gap + 2×|dy| (misalignment costs more than distance);
     vertical = gap between edges + 0.5×horizontal edge distance (so no row is skipped). */
  function distance(from, to, dir) {
    var fx = from.left + from.width / 2, fy = from.top + from.height / 2;
    var tx = to.left + to.width / 2, ty = to.top + to.height / 2;
    var ahead = dir === 'right' ? tx > fx + 1 : dir === 'left' ? tx < fx - 1 : dir === 'down' ? ty > fy + 1 : ty < fy - 1;
    if (!ahead) return Infinity;
    var gap = Math.max(0, dir === 'right' ? to.left - from.right : dir === 'left' ? from.left - to.right : dir === 'down' ? to.top - from.bottom : from.top - to.bottom);
    if (dir === 'left' || dir === 'right') return gap + Math.abs(ty - fy) * 2;
    var edge = Math.max(0, to.left - from.right, from.left - to.right);
    return gap + edge * 0.5;
  }

  function scrollContainersTo(el, smooth) {
    var r = el.getBoundingClientRect();
    var behavior = smooth && !U.reducedMotion() ? 'smooth' : 'auto';
    for (var box = el.parentElement; box && box !== document.body; box = box.parentElement) {
      var cs = getComputedStyle(box);
      var b = box.getBoundingClientRect();
      if (/auto|scroll/.test(cs.overflowX) && box.scrollWidth > box.clientWidth + 2) {
        /* Rails: keep the focused card's center at ~1/3 from the start edge (2/3 from the left in RTL).
           A scrollBy delta works whatever sign convention the browser uses for RTL scrollLeft. */
        var rtl = document.documentElement.dir === 'rtl';
        var anchor = b.left + b.width * (rtl ? 2 / 3 : 1 / 3);
        var delta = (r.left + r.width / 2) - anchor;
        if (Math.abs(delta) > 2) { try { box.scrollBy({ left: delta, behavior: behavior }); } catch (e) { box.scrollLeft += delta; } }
        r = el.getBoundingClientRect();
      }
      if (/auto|scroll/.test(cs.overflowY) && box.scrollHeight > box.clientHeight + 2) {
        var mTop = 72, mBot = 48;
        var frame = el.closest('[data-nav-frame]');
        var fr = frame && box.contains(frame) ? frame.getBoundingClientRect() : r;
        var dy = 0;
        if (fr.height > b.height - mTop - mBot) dy = fr.top - b.top - 24;
        else if (fr.top < b.top + mTop) dy = fr.top - b.top - mTop;
        else if (fr.bottom > b.bottom - mBot) dy = fr.bottom - b.bottom + mBot;
        if (dy) scrollTo(box, { top: box.scrollTop + dy, behavior: behavior });
      }
    }
  }
  function scrollTo(box, opts) {
    try { box.scrollTo(opts); } catch (e) { if (opts.top !== undefined) box.scrollTop = opts.top; if (opts.left !== undefined) box.scrollLeft = opts.left; }
  }

  function focusEl(el, smooth) {
    if (!el || el.focus === undefined) return false;
    if (el.tabIndex < 0 && !el.hasAttribute('tabindex')) el.tabIndex = -1;
    try { el.focus({ preventScroll: true }); } catch (e) { el.focus(); }
    scrollContainersTo(el, smooth !== false);
    return document.activeElement === el;
  }
  function focusFirst(root) {
    var sc = root || scope();
    var pool = sc ? U.$$('[data-nav]', sc).filter(visible) : focusables().filter(function (e) { return !isChrome(e); });
    var auto = null;
    for (var i = 0; i < pool.length; i++) if (pool[i].hasAttribute('data-autofocus')) { auto = pool[i]; break; }
    var el = auto || pool[0] || (sc ? null : focusables()[0]);
    return el ? focusEl(el, false) : false;
  }
  function remembered_el() {
    var id = remembered[nav.key];
    if (!id) return null;
    var sc = scope() || document;
    var els = U.$$('[data-nav-id]', sc);
    for (var i = 0; i < els.length; i++) if (els[i].getAttribute('data-nav-id') === id && visible(els[i])) return els[i];
    return null;
  }
  function restore(root) {
    var el = remembered_el();
    if (el && (!root || root.contains(el))) return focusEl(el, false);
    return focusFirst(root);
  }

  function move(dir, smooth) {
    var current = document.activeElement;
    var sc = scope();
    if (!current || !current.hasAttribute('data-nav') || !visible(current) || (sc && !sc.contains(current)) || (!sc && current.closest('#layers'))) {
      return restore();
    }
    var from = current.getBoundingClientRect();
    var horizontal = dir === 'left' || dir === 'right';
    var inBeam = function (r) { return horizontal ? (r.top < from.bottom && from.top < r.bottom) : (r.left < from.right && from.left < r.right); };
    var pick = function (pool, beamOnly) {
      var best = null, bestScore = Infinity;
      for (var i = 0; i < pool.length; i++) {
        var rect = pool[i].getBoundingClientRect();
        if (beamOnly && !inBeam(rect)) continue;
        var s = distance(from, rect, dir);
        if (s < bestScore) { bestScore = s; best = pool[i]; }
      }
      return best;
    };
    var others = focusables().filter(function (el) { return el !== current; });
    var screen = U.$('#main .screen.active');
    var scrolled = screen && screen.scrollTop > 8;
    /* The top bar is fixed: when the page is scrolled it only wins once the content ran out in that direction. */
    var pools = (!sc && !isChrome(current) && scrolled)
      ? [others.filter(function (e) { return !isChrome(e); }), others.filter(isChrome)]
      : [others];
    /* Up/down stay inside the current region (grid, list, sheet section) while it has somewhere to go. */
    var region = current.closest('[data-nav-region]');
    if (region && !horizontal) pools.unshift(others.filter(function (e) { return region.contains(e); }));
    /* Left/right stay in the same row (beam); up/down take the nearest neighbor. */
    var best = null;
    for (var p = 0; p < pools.length && !best; p++) best = pick(pools[p], horizontal);
    if (!best && horizontal) { for (var p2 = 0; p2 < pools.length && !best; p2++) best = pick(pools[p2].filter(function (e) { return !!e.closest('.rail-track') === !!current.closest('.rail-track') && e.closest('.rail-track') === current.closest('.rail-track'); }), false); }
    if (best) {
      XS.sound && XS.sound.tick();
      focusEl(best, smooth);
      return true;
    }
    /* Nothing in that direction: vertical arrows scroll long content (not inside a menu). */
    var scroller = sc ? (current.closest('.sheet-body, .search-body') || null) : screen;
    if (scroller && (dir === 'up' || dir === 'down')) {
      scrollTo(scroller, { top: scroller.scrollTop + (dir === 'down' ? 1 : -1) * scroller.clientHeight * 0.4, behavior: smooth && !U.reducedMotion() ? 'smooth' : 'auto' });
    }
    return false;
  }

  function pressAnim(el) {
    if (U.reducedMotion() || !el.animate) return;
    try { el.animate([{ transform: 'scale(1)' }, { transform: 'scale(.96)' }, { transform: 'scale(1)' }], { duration: 200, easing: 'cubic-bezier(.2,.8,.2,1)' }); } catch (e) { /* ignore */ }
  }
  function isTyping(el) { return !!el && (el.matches('input, textarea, select, [contenteditable="true"]')); }

  /* Gamepad API: 60 Hz poll, repeat 350 ms then 90 ms, buttons per SPEC §11.3. */
  var pad = { held: {}, since: {}, lastFire: {}, raf: 0 };
  var BTN = { 0: 'select', 1: 'back', 2: 'favorite', 3: 'search', 4: 'tabPrev', 5: 'tabNext', 9: 'options', 12: 'up', 13: 'down', 14: 'left', 15: 'right' };
  function pollPads() {
    pad.raf = requestAnimationFrame(pollPads);
    if (!nav.padEnabled || !navigator.getGamepads) return;
    var pads = navigator.getGamepads();
    var now = Date.now();
    var active = {};
    for (var i = 0; i < pads.length; i++) {
      var gp = pads[i];
      if (!gp || !gp.connected) continue;
      for (var b in BTN) if (gp.buttons[b] && gp.buttons[b].pressed) active[BTN[b]] = true;
      var ax = gp.axes[0] || 0, ay = gp.axes[1] || 0;
      if (ax < -0.5) active.left = true; else if (ax > 0.5) active.right = true;
      if (ay < -0.5) active.up = true; else if (ay > 0.5) active.down = true;
    }
    for (var a in active) {
      if (!pad.held[a]) { pad.held[a] = true; pad.since[a] = now; pad.lastFire[a] = now; padAction(a); }
      else if (a === 'up' || a === 'down' || a === 'left' || a === 'right') {
        var held = now - pad.since[a];
        if (held > 350 && now - pad.lastFire[a] >= 90) { pad.lastFire[a] = now; padAction(a, true); }
      }
    }
    for (var h in pad.held) if (!active[h]) delete pad.held[h];
  }
  function padAction(a, repeat) {
    nav.lastPadAt = Date.now();
    if (a === 'up' || a === 'down' || a === 'left' || a === 'right') { move(a, !repeat); return; }
    if (a === 'select') { var el = document.activeElement; if (el && el.hasAttribute('data-nav') && !isTyping(el)) { XS.sound && XS.sound.select(); pressAnim(el); el.click(); } return; }
    if (nav.actions[a]) nav.actions[a]();
  }

  function init() {
    window.addEventListener('keydown', function (e) {
      if (e.defaultPrevented) return;
      /* The PS5 browser also synthesizes key events from the pad: skip duplicates right after a pad action. */
      if (Date.now() - nav.lastPadAt < 120 && (KEYS[e.key] || e.key === 'Enter' || e.key === 'Escape')) { e.preventDefault(); return; }
      var dir = KEYS[e.key];
      var t = e.target;
      if (dir) {
        if (isTyping(t) && (dir === 'left' || dir === 'right')) {
          var atEdge = dir === 'left' ? t.selectionStart === 0 : t.selectionEnd === (t.value || '').length;
          if (!atEdge) return;
        }
        if (isTyping(t) && t.tagName === 'TEXTAREA' && (dir === 'up' || dir === 'down')) return;
        e.preventDefault();
        move(dir, !e.repeat);
        return;
      }
      if (e.key === 'Enter') {
        if (!t || !t.hasAttribute('data-nav') || isTyping(t) || e.repeat) return;
        e.preventDefault();
        XS.sound && XS.sound.select();
        pressAnim(t);
        t.click();
        return;
      }
      if (e.key === 'Escape' || (e.key === 'Backspace' && !isTyping(t))) {
        e.preventDefault();
        if (nav.actions.back) nav.actions.back();
        return;
      }
      if (isTyping(t) || e.ctrlKey || e.metaKey || e.altKey) return;
      var k = e.key.toLowerCase();
      if (k === 'f' && nav.actions.favorite) { e.preventDefault(); nav.actions.favorite(); }
      else if (k === 'q' && nav.actions.tabPrev) { e.preventDefault(); nav.actions.tabPrev(); }
      else if (k === 'e' && nav.actions.tabNext) { e.preventDefault(); nav.actions.tabNext(); }
      else if (k === '/' && nav.actions.search) { e.preventDefault(); nav.actions.search(); }
      else if (k === 'o' && nav.actions.options) { e.preventDefault(); nav.actions.options(); }
    });
    document.addEventListener('focusin', function (e) {
      var el = e.target;
      if (!el || !el.getAttribute) return;
      var id = el.getAttribute('data-nav-id');
      if (id) remembered[nav.key] = id;
      if (XS.router && XS.router.onFocus) XS.router.onFocus(el);
    });
    /* Mouse hover = focus, but only on real pointer movement (not after a scroll under a still pointer). */
    var mx = -1, my = -1;
    document.addEventListener('mousemove', function (e) {
      if (e.clientX === mx && e.clientY === my) return;
      mx = e.clientX; my = e.clientY;
      var el = e.target && e.target.closest ? e.target.closest('[data-nav]') : null;
      if (!el || el === document.activeElement || !visible(el)) return;
      var sc = scope();
      if (sc && !sc.contains(el)) return;
      try { el.focus({ preventScroll: true }); } catch (err) { el.focus(); }
    }, { passive: true });
    document.addEventListener('click', function (e) {
      var el = e.target && e.target.closest ? e.target.closest('[data-nav-id]') : null;
      if (el) remembered[nav.key] = el.getAttribute('data-nav-id');
    }, true);
    if (navigator.getGamepads) pad.raf = requestAnimationFrame(pollPads);
  }

  nav.scope = scope; nav.focusables = focusables; nav.focus = focusEl; nav.focusFirst = focusFirst; nav.restore = restore;
  nav.move = move; nav.init = init; nav.remember = function (key, id) { remembered[key] = id; }; nav.forget = function (key) { delete remembered[key]; };
  nav.scrollIntoView = scrollContainersTo; nav.isTyping = isTyping;
  XS.nav = nav;
})();
