/* XENO STORE — 31-components-a.js: Phase 2 shared helpers (XS.ca.*): Phase 2 API wrappers, enrichment cache,
   full-screen gallery viewer, fuzzy search + "did you mean", facet values, kind/firmware helpers, QR + GitHub issue
   dialogs, ambient color from cover art, cover-wall screensaver and the announcement banner (§17.1–17.7, 17.22). */
(function () {
  'use strict';
  var XS = window.XS, U = XS.util, S = XS.state, ui = XS.ui, h = U.h, t = XS.t;
  var ca = XS.ca = {};
  var REPO = 'https://github.com/XENOKING123/XENOKING';
  ca.REPO = REPO;
  ca.XENO_TOOL_URL = REPO + '/releases/latest';

  /* ---------- settings helpers ---------- */
  function gen() { return (S.data.settings && S.data.settings.general) || {}; }
  ca.safeMode = function () { return gen().safeMode === true; };
  ca.isGame = function (g) { return !!g && (g.platform === 'PS5' || g.platform === 'PS4'); };
  ca.consoleFw = function () { var st = S.data.status; return (st && st.fw) ? String(st.fw) : ''; };
  /* Localized text from a {lang: text} map (featured rows, messages). */
  ca.localized = function (texts, fallback) {
    if (!texts) return fallback || '';
    if (typeof texts === 'string') return texts;
    var loc = XS.i18n.locale, base = loc.split('-')[0];
    if (texts[loc]) return texts[loc];
    if (texts[base]) return texts[base];
    for (var k in texts) if (k.split('-')[0] === base && texts[k]) return texts[k];
    if (texts.en) return texts.en;
    for (var k2 in texts) if (texts[k2]) return texts[k2];
    return fallback || '';
  };

  /* ---------- Phase 2 API (same envelope + PIN handling as 15-api.js) ---------- */
  function req(method, path, body, opts) {
    opts = opts || {};
    var headers = {};
    if (S.data.pin) headers['X-XENO-PIN'] = S.data.pin;
    return U.fetchJSON(path, { method: method, body: body, headers: headers, timeout: opts.timeout || 15000 }).then(null, function (err) {
      if (err.status === 401 && ui.askPin && !opts.noPin) return ui.askPin().then(function (ok) { return ok ? req(method, path, body, { noPin: true, timeout: opts.timeout }) : Promise.reject(err); });
      throw err;
    });
  }
  function qs(params) {
    var parts = [];
    for (var k in params) if (params[k] !== undefined && params[k] !== null && params[k] !== '') parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(params[k]));
    return parts.length ? '?' + parts.join('&') : '';
  }
  var debridCache = { at: 0, p: null };
  ca.api = {
    get: function (path, opts) { return req('GET', path, undefined, opts); },
    post: function (path, body, opts) { return req('POST', path, body || {}, opts); },
    enrich: function (id) { return req('GET', '/api/game/enrich' + qs({ id: id }), undefined, { timeout: 20000 }); },
    best: function (id) { return req('GET', '/api/game/best' + qs({ id: id }), undefined, { timeout: 12000 }); },
    debrid: function (force) {
      var now = Date.now();
      if (!force && debridCache.p && now - debridCache.at < 60000) return debridCache.p;
      debridCache.at = now;
      debridCache.p = req('GET', '/api/debrid', undefined, { timeout: 8000 }).then(function (r) { return r.services || []; }, function () { debridCache.at = 0; return []; });
      return debridCache.p;
    },
    queueAdd: function (body) { return req('POST', '/api/queue', body); },
    queueSet: function (body) { return req('POST', '/api/queue/set', body, { timeout: 30000 }); },
    savesStore: function (params) { return req('GET', '/api/saves/store' + qs(params || {}), undefined, { timeout: 20000 }); },
    savesInstall: function (id, body) { return req('POST', '/api/saves/store/' + encodeURIComponent(id) + '/install', body || {}); },
    savesDownload: function (id, body) { return req('POST', '/api/saves/store/' + encodeURIComponent(id) + '/download', body || {}); },
    savesEngine: function () { return req('GET', '/api/saves/engine', undefined, { timeout: 8000 }); },
    savesUsers: function () { return req('GET', '/api/saves/users'); },
    savesList: function (user) { return req('GET', '/api/saves' + qs({ user: user }), undefined, { timeout: 30000 }); },
    savesExport: function (body) { return req('POST', '/api/saves/export', body, { timeout: 120000 }); },
    savesUpload: function (body) { return req('POST', '/api/saves/upload', body, { timeout: 600000 }); },
    savesSubmit: function (body) { return req('POST', '/api/saves/submit', body, { timeout: 60000 }); },
    savesInstalledVersion: function (titleId) { return req('GET', '/api/saves/installed-version' + qs({ titleId: titleId }), undefined, { timeout: 8000 }); },
    homebrew: function (refresh) { return req('GET', '/api/homebrew' + (refresh ? '?refresh=1' : ''), undefined, { timeout: refresh ? 60000 : 20000 }); },
    settingsPut: function (partial) { return req('PUT', '/api/settings', partial); },
    /* Remote images (pkg-zone covers, save icons) go through the console's allowlisted proxy. */
    imageUrl: function (url) {
      if (!url) return '';
      if (/^https?:\/\//i.test(url)) return '/api/image?url=' + encodeURIComponent(url);
      return url;
    }
  };

  /* ---------- Enrichment (§17.2): one request per game per session, catalog data merged underneath ---------- */
  var enrichCache = {};
  function clean(a) { var seen = {}, out = []; (a || []).forEach(function (x) { if (x && typeof x === 'string' && !seen[x]) { seen[x] = 1; out.push(x); } }); return out; }
  function mergeEnrich(g, r) {
    r = r || {};
    var shots = clean(r.screenshots && r.screenshots.length ? r.screenshots : g.screenshots);
    if (!shots.length) shots = clean([g.hero, g.banner].filter(function (x) { return x && x !== g.cover; }));
    return {
      cached: !!r.cached, fromApi: !!r.ok,
      screenshots: shots.slice(0, 10),
      about: r.about || g.about || '',
      developer: r.developer || g.developer || '',
      publisher: r.publisher || g.publisher || '',
      metacritic: typeof r.metacritic === 'number' ? r.metacritic : (typeof g.metacritic === 'number' ? g.metacritic : null),
      features: clean(r.features && r.features.length ? r.features : g.features),
      languages: clean(r.languages && r.languages.length ? r.languages : g.languages),
      ageRating: typeof r.ageRating === 'number' ? r.ageRating : (typeof g.ageRating === 'number' ? g.ageRating : null),
      releaseDate: r.releaseDate || g.releaseDate || '',
      genres: clean(g.genres && g.genres.length ? g.genres : r.genres),
      hltb: typeof r.hltb === 'number' ? r.hltb : (typeof g.hltb === 'number' ? g.hltb : null),
      players: r.players || g.players || ''
    };
  }
  ca.enrich = function (g) {
    if (!g) return Promise.resolve(null);
    if (enrichCache[g.id]) return enrichCache[g.id];
    if (ca.safeMode() || !S.data.serverOk) return Promise.resolve(mergeEnrich(g, null));
    var p = ca.api.enrich(g.id).then(function (r) { return mergeEnrich(g, r); }, function () { delete enrichCache[g.id]; return mergeEnrich(g, null); });
    enrichCache[g.id] = p;
    return p;
  };
  ca.enrichLocal = function (g) { return mergeEnrich(g, null); };

  /* ---------- Release kinds, firmware, versions, sizes ---------- */
  var KINDS = ['game', 'update', 'dlc', 'backport', 'bundle', 'page'];
  ca.relKind = function (r) {
    if (!r) return 'game';
    if (r.format === 'PAGE') return 'page';
    if (r.kind === 'bundle') return 'game';
    return KINDS.indexOf(r.kind) >= 0 ? r.kind : 'game';
  };
  ca.kindChip = function (kind, small) {
    var k = kind || 'game';
    var cls = k === 'backport' ? '.warn' : k === 'update' ? '.acc' : k === 'dlc' ? '.good' : k === 'page' ? '' : '.gold';
    return h('span.chip.kind' + (small === false ? '' : '.sm') + cls, { text: t('game2.kind.' + k) });
  };
  ca.semverCmp = function (a, b) {
    var pa = String(a || '').replace(/^v/i, '').split(/[.\-_]/), pb = String(b || '').replace(/^v/i, '').split(/[.\-_]/);
    var n = Math.max(pa.length, pb.length);
    for (var i = 0; i < n; i++) {
      var x = parseInt(pa[i] || '0', 10), y = parseInt(pb[i] || '0', 10);
      if (isNaN(x)) x = 0; if (isNaN(y)) y = 0;
      if (x !== y) return x < y ? -1 : 1;
    }
    return 0;
  };
  ca.fwNum = function (fw) { var m = /(\d+)(?:\.(\d+))?/.exec(String(fw || '')); return m ? parseFloat(m[1] + '.' + (m[2] || '0')) : 0; };
  /* Firmware tags of a game: catalog compat + release compat / requiresFw. */
  ca.fwTags = function (g) {
    var seen = {}, out = [];
    function add(x) { x = String(x || '').trim(); if (!x || seen[x]) return; seen[x] = 1; out.push(x); }
    (g.compat || []).forEach(add);
    (g.releases || []).forEach(function (r) { if (r.compat) add(r.compat); if (r.requiresFw) add(r.requiresFw); });
    return out;
  };
  ca.counts = function (g) {
    var c = { game: 0, update: 0, dlc: 0, backport: 0, page: 0 };
    (g.releases || []).forEach(function (r) { c[ca.relKind(r)]++; });
    if (typeof g.updates === 'number') c.update = Math.max(c.update, g.updates);
    if (typeof g.dlc === 'number') c.dlc = Math.max(c.dlc, g.dlc);
    if (typeof g.backports === 'number') c.backport = Math.max(c.backport, g.backports);
    return c;
  };
  ca.sizesByFormat = function (g) {
    var m = {}, order = [];
    (g.releases || []).forEach(function (r) {
      if (r.format === 'PAGE' || !r.sizeBytes) return;
      var f = ui.fmtLabel(r.format);
      if (!m[f]) { m[f] = { format: f, min: r.sizeBytes, max: r.sizeBytes, n: 0 }; order.push(f); }
      m[f].min = Math.min(m[f].min, r.sizeBytes); m[f].max = Math.max(m[f].max, r.sizeBytes); m[f].n++;
    });
    return order.map(function (f) { return m[f]; });
  };
  ca.year = function (g) { if (typeof g.year === 'number') return g.year; var m = /^(\d{4})/.exec(g.releaseDate || ''); return m ? parseInt(m[1], 10) : 0; };
  ca.seriesOf = function (g) { return g.series || g._series || ''; };
  ca.twin = function (g) {
    var other = g.platform === 'PS5' ? 'PS4' : 'PS5';
    var games = S.data.games;
    for (var i = 0; i < games.length; i++) if (games[i].platform === other && games[i]._nt === g._nt) return games[i];
    return null;
  };
  ca.regionCode = function (region) { var m = { EUR: 'EU', USA: 'US', JPN: 'JP', ASIA: 'AS' }; return m[region] || region || ''; };

  /* ---------- Facet values per game (cached per catalog) ---------- */
  var GB = 1e9;
  var SIZE_BUCKETS = [{ id: 'le5', max: 5 }, { id: 'le20', max: 20 }, { id: 'le50', max: 50 }, { id: 'le100', max: 100 }, { id: 'gt100', min: 100 }];
  ca.SIZE_BUCKETS = SIZE_BUCKETS;
  ca.sizeMatches = function (g, id) {
    if (!g.sizeMax) return false;
    for (var i = 0; i < SIZE_BUCKETS.length; i++) {
      var b = SIZE_BUCKETS[i];
      if (b.id !== id) continue;
      if (b.max) return g.sizeMax <= b.max * GB;
      return g.sizeMax > b.min * GB;
    }
    return false;
  };
  ca.yearBucket = function (y) { if (!y) return ''; if (y >= 2020) return String(y); if (y >= 2015) return '2015-2019'; return 'older'; };
  var fvCatalog = null, newRef = 0;
  ca.facetValues = function (g) {
    if (fvCatalog !== S.data.catalog) { fvCatalog = S.data.catalog; newRef = 0; S.data.games.forEach(function (x) { x._fv = null; }); }
    if (g._fv) return g._fv;
    if (!newRef) { var mx = ''; S.data.games.forEach(function (x) { if (x.addedAt && x.addedAt > mx) mx = x.addedAt; }); newRef = mx ? Date.parse(mx) - 7 * 86400000 : 0; }
    var rs = g.releases || [], c = ca.counts(g);
    var src = {}, fmt = {}, reg = {};
    if (g.region) reg[g.region] = 1;
    rs.forEach(function (r) { if (r.sourceId) src[r.sourceId] = 1; if (r.format) fmt[ui.fmtLabel(r.format)] = 1; if (r.region) reg[r.region] = 1; });
    var y = ca.year(g);
    var fv = {
      platform: g.platform, sources: Object.keys(src), formats: Object.keys(fmt), regions: Object.keys(reg), genres: g.genres || [],
      year: ca.yearBucket(y), publisher: g.publisher || '', verified: !!g.verified, updates: c.update > 0, dlc: c.dlc > 0, backports: c.backport > 0,
      compat: ca.fwTags(g), features: g.features || [], direct: !!g._direct, hash: !!g._hasHash,
      newWeek: !!(g.addedAt && newRef && Date.parse(g.addedAt) >= newRef), cheats: (g.cheats || 0) > 0,
      metacritic: typeof g.metacritic === 'number' ? g.metacritic : -1
    };
    g._fv = fv;
    return fv;
  };

  /* ---------- Search: exact > prefix > word > fuzzy (Damerau/OSA ≤ 2), title IDs + publishers, "did you mean" ---------- */
  function osa(a, b, max) {
    var la = a.length, lb = b.length;
    if (Math.abs(la - lb) > max) return max + 1;
    var prev2 = null, prev = [], cur, i, j;
    for (j = 0; j <= lb; j++) prev[j] = j;
    for (i = 1; i <= la; i++) {
      cur = [i];
      var rowMin = i;
      for (j = 1; j <= lb; j++) {
        var cost = a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1;
        var v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
        if (i > 1 && j > 1 && a.charAt(i - 1) === b.charAt(j - 2) && a.charAt(i - 2) === b.charAt(j - 1)) v = Math.min(v, prev2[j - 2] + 1);
        cur[j] = v;
        if (v < rowMin) rowMin = v;
      }
      if (rowMin > max) return max + 1;
      prev2 = prev; prev = cur;
    }
    return prev[lb];
  }
  ca.editDistance = osa;
  var wordsCatalog = null, wordIndex = null;
  function buildWords() {
    if (wordsCatalog === S.data.catalog && wordIndex) return wordIndex;
    wordsCatalog = S.data.catalog; wordIndex = {};
    S.data.games.forEach(function (g) {
      if (!ca.isGame(g)) return;
      if (!g._words) g._words = g._nt.split(' ').filter(function (w) { return w.length >= 2; });
      g._words.forEach(function (w) { if (w.length >= 3) wordIndex[w] = (wordIndex[w] || 0) + 1; });
    });
    return wordIndex;
  }
  function fuzzyWord(qw, words) {
    var max = qw.length <= 4 ? 1 : 2, best = max + 1;
    for (var i = 0; i < words.length; i++) {
      var w = words[i];
      if (Math.abs(w.length - qw.length) > max) continue;
      var d = osa(qw, w, max);
      if (d < best) { best = d; if (!best) break; }
    }
    return best;
  }
  /* search(q, limit, pool) → [{g, score}] best first. */
  ca.search = function (q, limit, pool) {
    var qn = U.normTitle(q), raw = String(q || '').trim().toLowerCase();
    if (!qn && !raw) return [];
    var qws = qn.split(' ').filter(Boolean);
    var games = pool || S.data.games, out = [];
    var isTid = /^(ppsa|cusa)\d{0,5}$/i.test(raw);
    for (var i = 0; i < games.length; i++) {
      var g = games[i];
      if (!ca.isGame(g)) continue;
      var score = 0;
      if (!g._words) g._words = g._nt.split(' ').filter(function (w) { return w.length >= 2; });
      if (isTid) {
        var tids = g.titleIds || [];
        for (var k = 0; k < tids.length; k++) { var tl = tids[k].toLowerCase(); if (tl === raw) { score = 950; break; } if (tl.indexOf(raw) === 0) { score = 900; break; } }
      }
      if (!score && qn) {
        if (g._nt === qn) score = 1000;
        else if (g._nt.indexOf(qn) === 0) score = 800;
        else {
          var allStart = qws.length > 0, allIn = qws.length > 0;
          for (var w = 0; w < qws.length; w++) {
            var qw = qws[w], st = false, inn = false;
            for (var x = 0; x < g._words.length; x++) { if (g._words[x].indexOf(qw) === 0) { st = true; inn = true; break; } if (g._words[x].indexOf(qw) >= 0) inn = true; }
            if (!st) allStart = false;
            if (!inn) allIn = false;
          }
          if (allStart) score = 600;
          else if (allIn || g._search.indexOf(raw) >= 0) score = 400;
          else if ((g.publisher || '').toLowerCase().indexOf(raw) >= 0 || (g.developer || '').toLowerCase().indexOf(raw) >= 0) score = 300;
        }
      }
      if (!score && raw && g._search.indexOf(raw) >= 0) score = 350;
      if (!score && qws.length) {
        /* fuzzy: every query word (≥ 4 chars) within OSA distance ≤ 2 of a title word */
        var dist = 0, ok = true;
        for (var f = 0; f < qws.length; f++) {
          if (qws[f].length < 4) { ok = false; break; }
          var d = fuzzyWord(qws[f], g._words);
          if (d > 2) { ok = false; break; }
          dist += d;
        }
        if (ok) score = 200 - dist * 10;
      }
      if (score) out.push({ g: g, score: score + Math.min(50, (g.popularity || 0) * 2) });
    }
    out.sort(function (a, b) { return b.score - a.score || (a.g._nt < b.g._nt ? -1 : 1); });
    return limit ? out.slice(0, limit) : out;
  };
  /* didYouMean(q) → corrected query string or '' */
  ca.didYouMean = function (q) {
    var qn = U.normTitle(q);
    if (!qn) return '';
    var idx = buildWords(), words = Object.keys(idx), changed = false;
    var fixed = qn.split(' ').map(function (qw) {
      if (qw.length < 3 || idx[qw]) return qw;
      var max = qw.length <= 4 ? 1 : 2, best = '', bestD = max + 1, bestN = 0;
      for (var i = 0; i < words.length; i++) {
        var w = words[i];
        if (Math.abs(w.length - qw.length) > max) continue;
        var d = osa(qw, w, max);
        if (d < bestD || (d === bestD && idx[w] > bestN)) { bestD = d; best = w; bestN = idx[w]; }
      }
      if (best) { changed = true; return best; }
      return qw;
    }).join(' ');
    return changed && fixed !== qn ? fixed : '';
  };
  ca.recentSearches = {
    get: function () { return U.store.get('recentSearches', []); },
    push: function (q) { q = String(q || '').trim(); if (!q) return; var r = ca.recentSearches.get().filter(function (x) { return x.toLowerCase() !== q.toLowerCase(); }); r.unshift(q); U.store.set('recentSearches', r.slice(0, 10)); },
    clear: function () { U.store.del('recentSearches'); }
  };

  /* ---------- Metacritic badge, info rows ---------- */
  ca.metacritic = function (score, big) {
    if (typeof score !== 'number' || score <= 0) return null;
    var cls = score >= 75 ? '.good' : score >= 50 ? '.mixed' : '.bad';
    return h('span.mc' + cls + (big ? '.big' : ''), { title: t('game2.metacritic'), 'aria-label': t('game2.metacriticScore', { n: score }) }, [h('b', { text: String(score) }), h('small', { text: t('game2.metacriticShort') })]);
  };

  /* ---------- Share / report / request (§17.7) ---------- */
  ca.baseUrl = function () {
    var st = S.data.status;
    var ip = st && st.ip ? st.ip : location.hostname;
    var port = st && st.port ? st.port : (location.port || 9095);
    return 'http://' + ip + ':' + port + '/';
  };
  ca.issueUrl = function (kind, d) {
    d = d || {};
    var title = '', body = '', tpl = '';
    if (kind === 'broken') {
      title = '[XENO STORE] Broken link: ' + (d.game ? d.game.title : '') + (d.titleId ? ' (' + d.titleId + ')' : '');
      body = 'Game: ' + (d.game ? d.game.title + '\nID: ' + d.game.id : '-') + '\nRelease: ' + (d.release ? d.release.id + '\nURL: ' + d.release.url : '-') + '\nWhat happened: ';
    } else if (kind === 'request') {
      title = '[XENO STORE] Game request: ' + (d.query || '');
      body = 'Title: ' + (d.query || '') + '\nPlatform: ' + (d.platform || 'PS5 / PS4') + '\nTitle ID (if known): \nWhere it can be found: ';
    } else if (kind === 'save') {
      title = '[XENO STORE] Save report: ' + (d.save ? d.save.name + ' (' + d.save.titleId + ')' : '');
      body = 'Save id: ' + (d.save ? d.save.id : '-') + '\nGame: ' + (d.save ? d.save.title : '-') + '\nProblem: ';
    } else if (kind === 'homebrew') {
      title = '[XENO STORE] Homebrew issue: ' + (d.app ? d.app.title : '');
      body = 'App: ' + (d.app ? d.app.id : '-') + '\nVersion: ' + (d.app ? d.app.version : '-') + '\nProblem: ';
    }
    body += '\n\nXENO STORE ' + ((S.data.status && S.data.status.version) || XS.version) + (S.data.status && S.data.status.fw ? ' · firmware ' + S.data.status.fw : '');
    return REPO + '/issues/new?' + (tpl ? 'template=' + tpl + '&' : '') + 'title=' + encodeURIComponent(title) + '&body=' + encodeURIComponent(body);
  };
  /* A dialog with the QR of a URL for the phone + "Open in browser" for the console / desktop. */
  ca.linkDialog = function (o) {
    var body = [];
    if (o.hint) body.push(h('p', { text: o.hint }));
    body.push(h('div', { style: { marginTop: '14px' } }, [ui.qr(o.url)]));
    body.push(h('div.pair-url.small', { text: o.display || o.url }));
    var buttons = [];
    if (o.openLabel !== false) buttons.push({ label: o.openLabel || t('game2.openInBrowser'), onClick: function (hd) { U.openExternal(o.url); if (o.closeOnOpen !== false) ui.closeLayer(hd); } });
    buttons.push({ label: t('game2.copyUrl'), onClick: function () { U.copyText(o.url).then(function (ok) { ui.toast({ cls: ok ? 'good' : 'bad', title: ok ? t('toast.copied') : t('toast.copyFailed') }); }); } });
    buttons.push({ label: t('common.close'), primary: true, autofocus: true });
    return ui.dialog({ title: o.title, body: body, buttons: buttons, key: o.key });
  };
  ca.shareGame = function (g) { ca.linkDialog({ title: t('game.shareToPhone'), hint: t('game.shareHint'), url: ca.baseUrl() + '#game/' + encodeURIComponent(g.id), display: ca.baseUrl() + '#game/' + g.id, key: 'share:' + g.id }); };
  ca.reportBroken = function (g, r) { ca.linkDialog({ title: t('game.reportBroken'), hint: t('game2.reportHint'), url: ca.issueUrl('broken', { game: g, release: r, titleId: (g.titleIds || [])[0] || '' }), display: t('game2.issueOnGithub'), openLabel: t('game2.openIssue') }); };
  ca.requestGame = function (query) { ca.linkDialog({ title: t('game2.requestGame'), hint: t('game2.requestHint'), url: ca.issueUrl('request', { query: query || '' }), display: t('game2.issueOnGithub'), openLabel: t('game2.openIssue') }); };

  /* ---------- Ambient color from cover art (§17.3): canvas average, hash tint fallback, never throws ---------- */
  var ambientCache = {};
  ca.ambient = function (url, fallback) {
    fallback = fallback || 'rgb(26, 42, 90)';
    if (!url || ca.safeMode()) return Promise.resolve(fallback);
    if (ambientCache[url]) return Promise.resolve(ambientCache[url]);
    return new Promise(function (resolve) {
      var done = false;
      function finish(c) { if (done) return; done = true; if (c) ambientCache[url] = c; resolve(c || fallback); }
      try {
        var img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = function () {
          try {
            var cv = document.createElement('canvas'); cv.width = 12; cv.height = 12;
            var ctx = cv.getContext('2d'); if (!ctx) return finish(null);
            ctx.drawImage(img, 0, 0, 12, 12);
            var d = ctx.getImageData(0, 0, 12, 12).data, r = 0, g = 0, b = 0, n = 0;
            for (var i = 0; i < d.length; i += 4) { if (d[i + 3] < 40) continue; r += d[i]; g += d[i + 1]; b += d[i + 2]; n++; }
            if (!n) return finish(null);
            r = Math.round(r / n); g = Math.round(g / n); b = Math.round(b / n);
            /* lift very dark averages a little so the gradient reads on the navy canvas */
            var lum = 0.299 * r + 0.587 * g + 0.114 * b;
            if (lum < 40) { var k = 40 / Math.max(1, lum); r = Math.min(255, Math.round(r * k)); g = Math.min(255, Math.round(g * k)); b = Math.min(255, Math.round(b * k)); }
            finish('rgb(' + r + ', ' + g + ', ' + b + ')');
          } catch (e) { finish(null); }   /* tainted canvas: the CDN blocks CORS */
        };
        img.onerror = function () { finish(null); };
        setTimeout(function () { finish(null); }, 6000);
        img.src = url;
      } catch (e) { finish(null); }
    });
  };
  ca.hashTint = function (title, tint) {
    if (tint && /^#[0-9a-f]{6}$/i.test(tint)) return tint;
    var hue = U.hashStr(title) % 360; return 'hsl(' + hue + ', 48%, 32%)';
  };

  /* ---------- Full-screen gallery viewer (§17.3) ---------- */
  ca.gallery = function (images, index, opts) {
    opts = opts || {};
    images = (images || []).filter(Boolean);
    if (!images.length) return null;
    var i = Math.max(0, Math.min(images.length - 1, index || 0));
    var layer = h('div.layer.gallery-layer', { 'data-nav-scope': '', role: 'dialog', 'aria-label': opts.title || t('gallery.title') });
    layer.appendChild(h('div.backdrop'));
    var stage = h('div.gal-stage');
    var img = h('img.gal-img', { alt: '', draggable: 'false' });
    stage.appendChild(img);
    var spinner = h('div.gal-spin');
    stage.appendChild(spinner);
    layer.appendChild(stage);
    var top = h('div.gal-top', [h('div.gal-title.ellipsis', { text: opts.title || '' }), h('span.spacer'), h('span.gal-counter', { 'data-gal-counter': '' })]);
    var close = h('button.iconbtn.gal-close', { nav: 'gal-close', html: U.icon('x'), 'aria-label': t('common.close'), data: { hints: 'select' } });
    top.appendChild(close);
    layer.appendChild(top);
    var prev = h('button.gal-nav.prev', { nav: 'gal-prev', html: U.icon('chevL'), 'aria-label': t('gallery.prev'), data: { hints: 'select' } });
    var next = h('button.gal-nav.next', { nav: 'gal-next', html: U.icon('chevR'), 'aria-label': t('gallery.next'), data: { hints: 'select' }, 'data-autofocus': '' });
    layer.appendChild(prev); layer.appendChild(next);
    var hint = h('div.gal-hint', { html: U.glyph('L1') + U.glyph('R1') + ' <span>' + U.escapeHtml(t('gallery.hintFlip')) + '</span> &nbsp; ' + U.glyph('circle') + ' <span>' + U.escapeHtml(t('gallery.hintClose')) + '</span>' });
    layer.appendChild(hint);
    var dots = h('div.gal-dots');
    if (images.length <= 12) images.forEach(function (_, k) { dots.appendChild(h('i' + (k === i ? '.on' : ''))); });
    layer.appendChild(dots);
    var handle = null, idleTimer = null, scale = 1, zoomed = false;
    function showChrome() { layer.classList.remove('idle'); clearTimeout(idleTimer); idleTimer = setTimeout(function () { layer.classList.add('idle'); }, 2600); }
    function preload(k) { if (k >= 0 && k < images.length) { try { var im = new Image(); im.src = images[k]; } catch (e) { /* ignore */ } } }
    function paint(dir) {
      var url = images[i];
      layer.classList.add('loading');
      img.classList.remove('in');
      scale = 1; zoomed = false; img.style.transform = '';
      var mine = url;
      img.onload = function () { if (img.src !== mine && img.getAttribute('src') !== mine) return; layer.classList.remove('loading'); img.classList.add('in'); };
      img.onerror = function () { layer.classList.remove('loading'); layer.classList.add('broken'); };
      layer.classList.remove('broken');
      img.src = url;
      layer.querySelector('[data-gal-counter]').textContent = t('gallery.counter', { i: i + 1, n: images.length });
      U.$$('i', dots).forEach(function (d, k) { d.classList.toggle('on', k === i); });
      prev.toggleAttribute('disabled', images.length < 2); next.toggleAttribute('disabled', images.length < 2);
      preload(i + 1); preload(i - 1);
      if (dir && !U.reducedMotion() && img.animate) { try { img.animate([{ transform: 'translateX(' + (dir > 0 ? 28 : -28) + 'px)', opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: 220, easing: 'cubic-bezier(.16,1,.3,1)' }); } catch (e) { /* ignore */ } }
      showChrome();
    }
    function flip(dir) {
      if (images.length < 2) return;
      i = (i + dir + images.length) % images.length;
      paint(dir);
      if (XS.sound) XS.sound.tick();
    }
    prev.addEventListener('click', function () { flip(-1); });
    next.addEventListener('click', function () { flip(1); });
    close.addEventListener('click', function () { ui.closeLayer(handle); });
    stage.addEventListener('click', function (e) { if (e.target === stage) ui.closeLayer(handle); else showChrome(); });
    /* keys: ←/→ flip (capture phase so the spatial nav never sees them), any key shows the chrome */
    function onKey(e) {
      if (handle && handle.closed) return;
      showChrome();
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); e.stopPropagation(); if (!e.repeat || true) flip(e.key === 'ArrowRight' ? 1 : -1); }
    }
    window.addEventListener('keydown', onKey, true);
    /* L1/R1 (and Q/E) flip while the viewer is open */
    var savedActions = { tabPrev: XS.nav.actions.tabPrev, tabNext: XS.nav.actions.tabNext };
    XS.nav.actions.tabPrev = function () { flip(-1); };
    XS.nav.actions.tabNext = function () { flip(1); };
    /* touch: swipe to flip, pinch to zoom (1–3×), double tap toggles 2× */
    var tx0 = 0, ty0 = 0, tAt = 0, pinch0 = 0, lastTap = 0;
    stage.addEventListener('touchstart', function (e) {
      showChrome();
      if (e.touches.length === 2) { pinch0 = dist(e.touches); return; }
      tx0 = e.touches[0].clientX; ty0 = e.touches[0].clientY; tAt = Date.now();
    }, { passive: true });
    stage.addEventListener('touchmove', function (e) {
      if (e.touches.length === 2 && pinch0) { e.preventDefault(); scale = Math.max(1, Math.min(3, scale * (dist(e.touches) / pinch0))); pinch0 = dist(e.touches); img.style.transform = 'scale(' + scale.toFixed(3) + ')'; zoomed = scale > 1.02; }
    }, { passive: false });
    stage.addEventListener('touchend', function (e) {
      if (e.touches.length) return;
      if (pinch0) { pinch0 = 0; return; }
      var ch = e.changedTouches && e.changedTouches[0]; if (!ch) return;
      var dx = ch.clientX - tx0, dy = ch.clientY - ty0, dt = Date.now() - tAt;
      if (!zoomed && Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy) * 1.3 && dt < 700) { flip(dx < 0 ? 1 : -1); return; }
      if (Math.abs(dx) < 10 && Math.abs(dy) < 10) { var now = Date.now(); if (now - lastTap < 320) { scale = zoomed ? 1 : 2; zoomed = !zoomed; img.style.transform = zoomed ? 'scale(2)' : ''; } lastTap = now; }
    });
    function dist(tt) { var a = tt[0], b = tt[1]; return Math.sqrt((a.clientX - b.clientX) * (a.clientX - b.clientX) + (a.clientY - b.clientY) * (a.clientY - b.clientY)); }
    layer.addEventListener('mousemove', showChrome, { passive: true });
    handle = ui.openLayer(layer, { key: opts.key || 'gallery', type: 'overlay', onClose: function () {
      window.removeEventListener('keydown', onKey, true);
      clearTimeout(idleTimer);
      XS.nav.actions.tabPrev = savedActions.tabPrev; XS.nav.actions.tabNext = savedActions.tabNext;
      if (opts.onClose) opts.onClose(i);
    } });
    handle.flip = flip; handle.index = function () { return i; };
    paint(0);
    return handle;
  };

  /* ---------- Announcement banner (§17.7): status.messages + featured.banner, dismissed per id in localStorage ---------- */
  var bannerEl = null, bannerId = '';
  function pickMessage() {
    var st = S.data.status || {};
    var list = [];
    (st.messages || []).forEach(function (m) { if (m && m.id) list.push({ id: String(m.id), text: ca.localized(m.texts || m.text, ''), url: m.url || '', ts: m.ts || 0 }); });
    var fb = st.featured && st.featured.banner;
    if (fb && (fb.text || fb.texts)) list.push({ id: 'featured:' + U.hashStr(JSON.stringify(fb.text || fb.texts)).toString(36), text: ca.localized(fb.texts || fb.text, ''), url: fb.url || '', ts: 0 });
    list.sort(function (a, b) { return (b.ts || 0) - (a.ts || 0); });
    for (var i = 0; i < list.length; i++) if (list[i].text && U.store.get('msg.' + list[i].id, false) !== true) return list[i];
    return null;
  }
  ca.banner = function () {
    var box = U.$('#banners');
    if (!box) return null;
    var m = pickMessage();
    if (!m) { if (bannerEl && bannerEl.parentNode) bannerEl.parentNode.removeChild(bannerEl); bannerEl = null; bannerId = ''; return null; }
    if (bannerEl && bannerId === m.id && bannerEl.parentNode) return bannerEl;
    if (bannerEl && bannerEl.parentNode) bannerEl.parentNode.removeChild(bannerEl);
    bannerId = m.id;
    var b = h('div.banner.announce', { data: { announce: m.id } }, [h('span.dot'), h('span.tx', { text: m.text }), h('span.spacer')]);
    if (m.url) { var open = h('button.btn.sm', { nav: 'announce-open', text: t('discover2.bannerOpen') }); open.addEventListener('click', function () { U.openExternal(m.url); }); b.appendChild(open); }
    var dis = h('button.btn.sm.ghost', { nav: 'announce-dismiss', text: t('common.dismiss'), 'aria-label': t('common.dismiss') });
    dis.addEventListener('click', function () { U.store.set('msg.' + m.id, true); ca.banner(); });
    b.appendChild(dis);
    box.insertBefore(b, box.firstChild);
    bannerEl = b;
    return b;
  };
  S.on('status', function () { ca.banner(); });

  /* ---------- Cover-wall screensaver (§17.7): after N idle minutes on TV; any input exits ---------- */
  var ss = { el: null, timer: null, swap: null, lastPad: 0, idleSince: Date.now(), armed: false, started: 0 };
  function ssEnabled() {
    var g = gen();
    if (U.isPhone() || g.screensaver === false || g.safeMode) return false;
    return true;
  }
  function ssMinutes() { var n = Number(gen().screensaverMinutes); if (!n || n < 1) n = 3; return Math.min(30, n); }
  function ssTouch() { ss.idleSince = Date.now(); }
  function ssStart() {
    if (ss.el || !S.data.games.length) return;
    var pool = S.data.games.filter(function (g) { return ca.isGame(g) && g.cover; });
    if (pool.length < 12) return;
    var el = h('div.screensaver', { 'aria-hidden': 'true' });
    var cols = Math.max(6, Math.min(10, Math.round(window.innerWidth / 200)));
    var rows = Math.max(3, Math.round(window.innerHeight / 260) + 1);
    var wall = h('div.ss-wall', { style: { gridTemplateColumns: 'repeat(' + cols + ', 1fr)' } });
    var tiles = [];
    for (var k = 0; k < cols * rows; k++) {
      var g = pool[Math.floor(Math.random() * pool.length)];
      var tile = h('div.ss-tile'); tile.appendChild(ui.cover(g.cover, g.coverFallback, g.title));
      wall.appendChild(tile); tiles.push(tile);
    }
    el.appendChild(wall);
    var clock = h('div.ss-clock');
    el.appendChild(h('div.ss-brand', [h('span.brand-badge', [h('img', { src: XS.logoSrc || '/logo.jpg', alt: '' })]), h('span.brand-word', { html: 'XENO<em>STORE</em>' })]));
    el.appendChild(clock);
    el.appendChild(h('div.ss-hint', { text: t('discover2.screensaverHint') }));
    document.body.appendChild(el);
    ss.el = el; ss.started = Date.now();
    function tickClock() { try { clock.textContent = new Date().toLocaleTimeString(XS.i18n.locale, { hour: '2-digit', minute: '2-digit' }); } catch (e) { clock.textContent = ''; } }
    tickClock();
    ss.swap = setInterval(function () {
      tickClock();
      if (U.reducedMotion()) return;
      var tile = tiles[Math.floor(Math.random() * tiles.length)];
      var g2 = pool[Math.floor(Math.random() * pool.length)];
      var fresh = ui.cover(g2.cover, g2.coverFallback, g2.title); fresh.classList.add('ss-in');
      tile.appendChild(fresh);
      setTimeout(function () { if (tile.firstChild && tile.firstChild !== fresh) tile.removeChild(tile.firstChild); }, 900);
    }, 1500);
    requestAnimationFrame(function () { el.classList.add('on'); });
  }
  function ssStop(e) {
    if (!ss.el) return false;
    if (e && e.preventDefault && Date.now() - ss.started > 400) { e.preventDefault(); e.stopPropagation(); }
    clearInterval(ss.swap); ss.swap = null;
    var el = ss.el; ss.el = null;
    el.classList.remove('on');
    setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, U.reducedMotion() ? 0 : 400);
    ssTouch();
    return true;
  }
  ca.screensaver = {
    start: ssStart, stop: function () { return ssStop(null); }, active: function () { return !!ss.el; },
    setup: function () {
      if (ss.armed) return; ss.armed = true;
      ['keydown', 'pointerdown', 'pointermove', 'touchstart', 'wheel'].forEach(function (ev) {
        window.addEventListener(ev, function (e) { if (ss.el) { if (ev === 'pointermove') return; ssStop(e); return; } ssTouch(); }, { capture: true, passive: ev !== 'keydown' && ev !== 'pointerdown' && ev !== 'touchstart' });
      });
      ss.timer = setInterval(function () {
        if (XS.nav.lastPadAt !== ss.lastPad) { ss.lastPad = XS.nav.lastPadAt; if (ss.el) { ssStop(null); return; } ssTouch(); }
        if (ss.el || document.hidden || !ssEnabled()) return;
        if (XS.nav.isTyping && XS.nav.isTyping(document.activeElement)) { ssTouch(); return; }
        if (Date.now() - ss.idleSince >= ssMinutes() * 60000) ssStart();
      }, 1000);
    }
  };

  /* ---------- Prefetch the next covers of the rail the user is moving along (§17.7) ---------- */
  ca.prefetchRail = function (track, from) {
    if (!track || ca.safeMode()) return;
    var cards = U.$$('.card', track), idx = cards.indexOf(from);
    if (idx < 0) return;
    for (var k = idx + 1; k <= idx + 6 && k < cards.length; k++) {
      var g = S.game(cards[k].getAttribute('data-game'));
      if (g && g.cover) { try { var im = new Image(); im.src = g.cover; } catch (e) { /* ignore */ } }
    }
  };

  /* ---------- Small shared widgets ---------- */
  /* An empty value yields an empty fragment, so callers can append the result unconditionally. */
  ca.infoRow = function (label, valueEl) {
    if (valueEl === null || valueEl === undefined || valueEl === '' || (Array.isArray(valueEl) && !valueEl.length)) return document.createDocumentFragment();
    return h('div.ir', [h('div.k', { text: label }), h('div.v', typeof valueEl === 'string' ? { text: valueEl } : null, typeof valueEl === 'string' ? null : valueEl)]);
  };
  ca.chipList = function (items, cls) { return h('div.chips', items.map(function (x) { return h('span.chip.sm' + (cls || ''), { text: x }); })); };
  ca.fmtGB = function (n) { return U.fmtBytes(n, n >= 1e10 ? 0 : 1); };
  /* "No results" / "1 result" / "n results" without ICU =0 forms. */
  ca.nResults = function (n) { return n ? t('browse2.results', { n: n }) : t('browse2.noResults'); };
  /* Dates arrive as ISO strings (catalog, saves, pkg-zone) or Unix seconds (jobs, mtimes). */
  ca.fmtWhen = function (v) { if (!v) return ''; if (typeof v === 'number') return U.fmtDateTime(v); return U.fmtDate(v); };
  ca.busyRow = function (text) { return h('div.panel.busy-row', [h('div.row', [h('span.skel', { style: { width: '18px', height: '18px', borderRadius: '50%', flex: '0 0 auto' } }), h('span.dim', { text: text })])]); };
  ca.focusIn = function (root, id) { var el = root && root.querySelector('[data-nav-id="' + id + '"]'); if (el) XS.nav.focus(el, false); return !!el; };
  /* Collapsible "Why?" tooltip: a small ⓘ button that toggles an explanation line (works with a controller). */
  ca.why = function (id, label, text) {
    var wrap = h('span.why');
    var btn = h('button.why-btn', { nav: id, text: label, 'aria-expanded': 'false', data: { hints: 'toggle' } });
    var tip = h('span.why-tip', { text: text, hidden: true });
    btn.addEventListener('click', function () { var open = tip.hidden; tip.hidden = !open; btn.setAttribute('aria-expanded', open ? 'true' : 'false'); });
    wrap.appendChild(btn); wrap.appendChild(tip);
    return wrap;
  };
})();
