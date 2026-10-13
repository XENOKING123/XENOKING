/* XENO STORE — 25-sound.js: WebAudio synth (SPEC §11.6). Silent until the first user gesture. */
(function () {
  'use strict';
  var XS = window.XS;
  var ctx = null, unlocked = false, enabled = true, lastTick = 0;
  function ac() {
    if (ctx) return ctx;
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    try { ctx = new AC(); } catch (e) { ctx = null; }
    return ctx;
  }
  function unlock() {
    if (unlocked) return;
    var c = ac();
    if (!c) return;
    if (c.state === 'suspended' && c.resume) c.resume().then(function () { unlocked = true; }, function () { /* ignore */ });
    else unlocked = true;
  }
  /* tone(freq, seconds, gainDb, type, freqEnd) — one oscillator with a short envelope. */
  function tone(freq, dur, db, type, freqEnd, delay) {
    if (!enabled || !unlocked) return;
    var c = ac(); if (!c || c.state !== 'running') return;
    try {
      var t0 = c.currentTime + (delay || 0);
      var o = c.createOscillator(), g = c.createGain();
      o.type = type || 'sine';
      o.frequency.setValueAtTime(freq, t0);
      if (freqEnd) o.frequency.exponentialRampToValueAtTime(freqEnd, t0 + dur);
      var amp = Math.pow(10, db / 20);
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(amp, t0 + Math.min(0.004, dur / 3));
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      o.connect(g); g.connect(c.destination);
      o.start(t0); o.stop(t0 + dur + 0.02);
    } catch (e) { /* audio unavailable: silent */ }
  }
  XS.sound = {
    setEnabled: function (on) { enabled = !!on; },
    tick: function () { var now = Date.now(); if (now - lastTick < 30) return; lastTick = now; tone(1200, 0.0015 + 0.012, -24, 'sine'); },
    select: function () { tone(660, 0.03, -18, 'sine'); tone(990, 0.03, -18, 'sine', null, 0.03); },
    back: function () { tone(440, 0.05, -20, 'sine'); },
    error: function () { tone(200, 0.12, -20, 'sawtooth'); },
    done: function () { tone(523, 0.08, -16, 'sine'); tone(659, 0.08, -16, 'sine', null, 0.08); tone(784, 0.08, -16, 'sine', null, 0.16); },
    unlock: unlock
  };
  ['keydown', 'pointerdown', 'touchstart', 'mousedown', 'click'].forEach(function (ev) {
    window.addEventListener(ev, unlock, { passive: true });
  });
})();
