/* XENO STORE — 33-design.js: XENO Glass motion helpers (SPEC §18). Plain ES2017, no DOM writes outside rAF.
   - reduce-motion gate: mirrors the OS preference into html.prm (the Reduce-motion setting sets data-motion itself)
   - tilt-on-focus: the focused card's frame follows the pointer (desktop only); TV keeps the fixed gentle tilt from CSS
   - sliding gold tab indicator: one element in the top bar, moved with transform only, re-placed when tabs re-render
   - hero crossfade: the previous slide's art is re-inserted and faded out (opacity) when Discover rotates the spotlight
   - genre icons: a small inline-SVG set for the genre tiles (no emoji in chrome) */
(function () {
  'use strict';
  var XS = window.XS, U = XS.util;
  var D = {};
  var html = document.documentElement;

  /* ---------- reduce-motion gate ---------- */
  var mq = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  function syncPrm() { html.classList.toggle('prm', !!(mq && mq.matches)); }
  syncPrm();
  if (mq) { if (mq.addEventListener) mq.addEventListener('change', syncPrm); else if (mq.addListener) mq.addListener(syncPrm); }
  D.motion = function () { return !U.reducedMotion() && html.getAttribute('data-safe-mode') !== '1'; };
  var finePointer = !!(window.matchMedia && window.matchMedia('(hover: hover) and (pointer: fine)').matches);

  /* ---------- tilt toward the pointer (desktop); CSS owns the transform, we only feed --rx/--ry ---------- */
  var tiltEl = null, tiltRaf = 0, px = 0, py = 0;
  function cardOf(el) { return el && el.closest ? el.closest('.card, .hb-card, .save-card') : null; }
  function applyTilt() {
    tiltRaf = 0;
    var c = tiltEl; if (!c || c !== document.activeElement) return;
    var r = c.getBoundingClientRect(); if (!r.width || !r.height) return;
    var x = (px - r.left) / r.width - .5, y = (py - r.top) / r.height - .5;
    c.style.setProperty('--ry', (x * 9).toFixed(2) + 'deg');
    c.style.setProperty('--rx', (-y * 7).toFixed(2) + 'deg');
  }
  function clearTilt(c) { if (!c) return; c.style.removeProperty('--rx'); c.style.removeProperty('--ry'); if (tiltEl === c) tiltEl = null; }
  if (finePointer) {
    document.addEventListener('mousemove', function (e) {
      if (!D.motion()) return;
      var c = cardOf(e.target);
      if (!c || c !== document.activeElement) return;
      px = e.clientX; py = e.clientY; tiltEl = c;
      if (!tiltRaf) tiltRaf = requestAnimationFrame(applyTilt);
    }, { passive: true });
    document.addEventListener('focusout', function (e) { clearTilt(cardOf(e.target)); });
    document.addEventListener('mouseout', function (e) { var c = cardOf(e.target); if (c && !(e.relatedTarget && c.contains(e.relatedTarget))) clearTilt(c); }, { passive: true });
  }

  /* ---------- sliding gold tab indicator ---------- */
  var ind = null, indRaf = 0;
  function ensureInd() {
    var bar = document.getElementById('topbar'); if (!bar) return null;
    if (!ind) { ind = document.createElement('span'); ind.className = 'tab-ind'; ind.setAttribute('aria-hidden', 'true'); bar.appendChild(ind); bar.classList.add('has-ind'); }
    return ind;
  }
  function placeInd() {
    indRaf = 0;
    var el = ensureInd(); if (!el) return;
    var active = document.querySelector('#tabs .tab.active');
    if (!active || !active.offsetWidth) { el.classList.remove('on'); return; }
    var bar = el.parentNode.getBoundingClientRect(), r = active.getBoundingClientRect();
    var x = r.left - bar.left, y = r.top - bar.top, w = Math.max(1, r.width);
    if (Math.abs(r.height - parseFloat(el.style.height || '0')) > .5) el.style.height = r.height + 'px';
    var first = !el.classList.contains('on');
    if (first) el.style.transition = 'none';
    el.style.transform = 'translate3d(' + x.toFixed(1) + 'px,' + y.toFixed(1) + 'px,0) scaleX(' + (w / 100).toFixed(4) + ')';
    if (first) { el.classList.add('on'); void el.offsetWidth; el.style.transition = ''; }
  }
  function scheduleInd() { if (!indRaf) indRaf = requestAnimationFrame(placeInd); }
  var tabs = document.getElementById('tabs');
  if (tabs && window.MutationObserver) new MutationObserver(scheduleInd).observe(tabs, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
  window.addEventListener('resize', scheduleInd);
  scheduleInd();
  D.placeTabIndicator = scheduleInd;

  /* ---------- hero crossfade (opacity only): keep the previous .art on top while it fades ---------- */
  var main = document.getElementById('main');
  if (main && window.MutationObserver) {
    new MutationObserver(function (recs) {
      var hero = null, removedArt = null, i, k, n;
      for (i = 0; i < recs.length; i++) {
        var m = recs[i], tg = m.target;
        if (!tg || !tg.classList || !tg.classList.contains('hero')) continue;
        for (k = 0; k < m.addedNodes.length; k++) { n = m.addedNodes[k]; if (n.classList && n.classList.contains('art') && !n.classList.contains('prev') && !n.getAttribute('data-born')) n.setAttribute('data-born', String(Date.now())); }
        for (k = 0; k < m.removedNodes.length; k++) { n = m.removedNodes[k]; if (n.classList && n.classList.contains('art') && !n.classList.contains('prev')) { removedArt = n; hero = tg; } }
      }
      if (!hero || !removedArt || !hero.isConnected || !hero.classList.contains('swap') || !D.motion()) return;
      if (!removedArt.querySelector('.cover.loaded')) return;
      var fresh = hero.querySelector('.art:not(.prev)'); if (!fresh || fresh === removedArt) return;
      var old = hero.querySelector('.art.prev'); if (old && old.parentNode) old.parentNode.removeChild(old);
      var born = Number(removedArt.getAttribute('data-born') || 0);
      var kb = born ? 1 + .06 * Math.min(1, Math.max(0, (Date.now() - born) / 12000)) : 1.06;
      removedArt.classList.add('prev');
      removedArt.style.setProperty('--kb', kb.toFixed(4));
      fresh.parentNode.insertBefore(removedArt, fresh.nextSibling);
      setTimeout(function () { if (removedArt.parentNode) removedArt.parentNode.removeChild(removedArt); }, 900);
    }).observe(main, { childList: true, subtree: true });
  }

  /* ---------- genre icons (24 px grid, 1.75 px strokes) ---------- */
  var P = '<svg viewBox="0 0 24 24" aria-hidden="true">';
  var GI = {
    sword: P + '<path d="M14.5 4.5l5 5L9 20l-5-5z"/><path d="M4 20l3-3"/><path d="M13 7l4 4"/><path d="M18 3l3 3"/></svg>',
    crosshair: P + '<circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="1.5"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4"/></svg>',
    ball: P + '<circle cx="12" cy="12" r="9"/><path d="M12 3a12 12 0 0 1 0 18M12 3a12 12 0 0 0 0 18M3 12h18"/></svg>',
    flag: P + '<path d="M5 21V4"/><path d="M5 4h12l-2 4 2 4H5"/></svg>',
    ghost: P + '<path d="M5 21v-9a7 7 0 0 1 14 0v9l-2.3-2-2.3 2-2.4-2-2.4 2-2.3-2z"/><path d="M9.5 11h.01M14.5 11h.01"/></svg>',
    puzzle: P + '<path d="M4 7h4a2 2 0 1 1 4 0h4v4a2 2 0 1 0 0 4v4h-4a2 2 0 1 1-4 0H4v-4a2 2 0 1 0 0-4z"/></svg>',
    pawn: P + '<circle cx="12" cy="6" r="3"/><path d="M9 20h6"/><path d="M10 11h4l2 9H8z"/></svg>',
    dice: P + '<rect x="4" y="4" width="16" height="16" rx="3"/><path d="M8.5 8.5h.01M15.5 8.5h.01M12 12h.01M8.5 15.5h.01M15.5 15.5h.01"/></svg>',
    note: P + '<path d="M9 18V6l10-2v12"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="16.5" cy="16" r="2.5"/></svg>',
    fire: P + '<path d="M12 22a6 6 0 0 1-6-6c0-3 2-5 3-7 0 2 1 3 2 3 0-3 1-6 4-8 0 3 3 5 3 9a6 6 0 0 1-6 9z"/></svg>',
    car: P + '<path d="M3 13l2-5h14l2 5"/><path d="M3 13h18v4H3z"/><circle cx="7" cy="17" r="2"/><circle cx="17" cy="17" r="2"/></svg>',
    fist: P + '<path d="M7 11V7a2 2 0 1 1 4 0v4"/><path d="M11 10V5a2 2 0 1 1 4 0v5"/><path d="M15 10V7a2 2 0 1 1 4 0v7a6 6 0 0 1-6 6h-2a6 6 0 0 1-6-6v-3a2 2 0 1 1 4 0"/></svg>',
    mountain: P + '<path d="M3 20l6-11 4 6 2-3 6 8z"/><circle cx="17" cy="6" r="2"/></svg>',
    blocks: P + '<rect x="3" y="14" width="6" height="6" rx="1"/><rect x="9" y="8" width="6" height="6" rx="1"/><rect x="15" y="2" width="6" height="6" rx="1"/><rect x="15" y="14" width="6" height="6" rx="1"/></svg>',
    people: P + '<circle cx="9" cy="8" r="3"/><circle cx="17" cy="9" r="2.5"/><path d="M3 20a6 6 0 0 1 12 0"/><path d="M15 20a4 4 0 0 1 6-3.5"/></svg>',
    mask: P + '<path d="M4 6c3-1.5 13-1.5 16 0v6a8 8 0 0 1-16 0z"/><path d="M8 11h2M14 11h2"/><path d="M9 15c1 1 5 1 6 0"/></svg>'
  };
  var GENRE_RULES = [
    ['shoot', 'crosshair'], ['fps', 'crosshair'], ['sport', 'ball'], ['football', 'ball'], ['soccer', 'ball'], ['basket', 'ball'],
    ['rac', 'car'], ['driv', 'car'], ['horror', 'ghost'], ['surviv', 'fire'], ['puzzle', 'puzzle'], ['strateg', 'pawn'], ['tactic', 'pawn'],
    ['rpg', 'sword'], ['role', 'sword'], ['action', 'sword'], ['fight', 'fist'], ['brawl', 'fist'], ['music', 'note'], ['rhythm', 'note'],
    ['adventure', 'mountain'], ['open world', 'mountain'], ['platform', 'blocks'], ['sandbox', 'blocks'], ['family', 'people'], ['party', 'people'],
    ['kids', 'people'], ['stealth', 'mask'], ['casual', 'dice'], ['card', 'dice'], ['board', 'dice'], ['sim', 'flag'], ['indie', 'blocks']
  ];
  D.icons = GI;
  D.icon = function (name) { return GI[name] || U.icon(name); };
  D.genreIcon = function (genre) {
    var g = String(genre || '').toLowerCase();
    for (var i = 0; i < GENRE_RULES.length; i++) if (g.indexOf(GENRE_RULES[i][0]) >= 0) return GI[GENRE_RULES[i][1]];
    return U.icon('gamepad');
  };

  XS.design = D;
})();
