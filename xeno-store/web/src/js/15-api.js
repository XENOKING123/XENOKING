/* XENO STORE — 15-api.js: thin wrappers over the JSON API (SPEC §6). Field names are exact. */
(function () {
  'use strict';
  var XS = window.XS, U = XS.util, S = XS.state;
  var base = '';

  function req(method, path, body, opts) {
    opts = opts || {};
    var headers = {};
    if (S.data.pin) headers['X-XENO-PIN'] = S.data.pin;
    return U.fetchJSON(base + path, { method: method, body: body, headers: headers, timeout: opts.timeout }).then(function (r) {
      if (!S.data.serverOk) S.set('serverOk', true);
      return r;
    }, function (err) {
      if (err.status === 0 && !opts.quiet) S.set('serverOk', false);
      if (err.status === 401 && XS.ui && XS.ui.askPin && !opts.noPin) {
        return XS.ui.askPin().then(function (ok) { return ok ? req(method, path, body, { noPin: true }) : Promise.reject(err); });
      }
      throw err;
    });
  }
  function get(path, opts) { return req('GET', path, undefined, opts); }
  function post(path, body, opts) { return req('POST', path, body || {}, opts); }
  function put(path, body, opts) { return req('PUT', path, body || {}, opts); }
  function q(params) {
    var parts = [];
    for (var k in params) if (params[k] !== undefined && params[k] !== null && params[k] !== '') parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(params[k]));
    return parts.length ? '?' + parts.join('&') : '';
  }

  var api = {
    status: function () { return get('/api/status', { timeout: 6000 }); },
    log: function (lines) { return get('/api/log' + q({ lines: lines || 200 })); },
    toast: function (text) { return post('/api/system/toast', { text: text }); },
    stop: function () { return post('/api/system/stop'); },
    updateCheck: function () { return get('/api/update/check', { timeout: 30000 }); },
    updateApply: function () { return post('/api/update/apply', {}, { timeout: 120000 }); },
    catalogInfo: function () { return get('/api/catalog/info'); },
    catalogRefresh: function () { return post('/api/catalog/refresh', {}, { timeout: 65000 }); },
    catalogSearch: function (query, platform, limit) { return get('/api/catalog/search' + q({ q: query, platform: platform, limit: limit })); },
    linksCheck: function (urls) { return post('/api/links/check', { urls: urls }, { timeout: 90000 }); },
    linksResolve: function (url) { return post('/api/links/resolve', { url: url }, { timeout: 45000 }); },
    queue: function (history) { return get('/api/queue' + (history ? '?history=1' : ''), { timeout: 8000 }); },
    queueAdd: function (body) { return post('/api/queue', body); },
    queueAction: function (id, action, body) { return post('/api/queue/' + encodeURIComponent(id) + '/' + action, body || {}); },
    queueClear: function (states) { return post('/api/queue/clear', { states: states }); },
    queueLog: function (id) { return get('/api/queue/' + encodeURIComponent(id) + '/log'); },
    queueUrl: function (id, url) { return post('/api/queue/' + encodeURIComponent(id) + '/url', { url: url }); },
    space: function (root, bytes) { return get('/api/space' + q({ root: root, bytes: bytes })); },
    storage: function () { return get('/api/storage'); },
    storageDefault: function (root) { return post('/api/storage/default', { root: root }); },
    library: function (scan) { return get('/api/library' + (scan ? '?scan=1' : ''), { timeout: 60000 }); },
    libraryDelete: function (path) { return post('/api/library/delete', { path: path }); },
    libraryInstall: function (path) { return post('/api/library/install', { path: path }); },
    shadowmountScan: function () { return post('/api/shadowmount/scan'); },
    settings: function () { return get('/api/settings'); },
    settingsPut: function (partial) { return put('/api/settings', partial); },
    favorites: function () { return get('/api/favorites'); },
    favoritesPut: function (ids) { return put('/api/favorites', { ids: ids }); },
    favoriteToggle: function (id) { return post('/api/favorites/toggle', { id: id }); },
    collections: function () { return get('/api/collections'); },
    collectionsPut: function (collections) { return put('/api/collections', { collections: collections }); },
    recent: function () { return get('/api/recent'); },
    recentAdd: function (id) { return post('/api/recent', { id: id }, { quiet: true }); },
    exportAll: function () { return get('/api/export'); },
    importAll: function (obj) { return post('/api/import', obj); },
    pair: function () { return get('/api/pair'); },

    /* Catalog: GET /catalog.json with ETag; cached copy in localStorage keeps browsing when the console is unreachable. */
    catalogEtag: '',
    loadCatalog: function () {
      var headers = {};
      if (api.catalogEtag) headers['If-None-Match'] = api.catalogEtag;
      return new Promise(function (resolve, reject) {
        var ctl = (typeof AbortController === 'function') ? new AbortController() : null;
        var timer = setTimeout(function () { if (ctl) ctl.abort(); }, 30000);
        fetch(base + '/catalog.json', { headers: headers, cache: 'no-store', signal: ctl ? ctl.signal : undefined }).then(function (res) {
          clearTimeout(timer);
          if (res.status === 304) return resolve({ unchanged: true });
          if (!res.ok) throw new Error('http_' + res.status);
          var et = res.headers.get('ETag') || '';
          return res.json().then(function (cat) {
            api.catalogEtag = et;
            try { localStorage.setItem('xs.catalog', JSON.stringify(cat)); } catch (e) { /* too big for this browser: fine */ }
            resolve({ catalog: cat, etag: et });
          });
        }).catch(function (err) {
          clearTimeout(timer);
          var cached = null;
          try { var raw = localStorage.getItem('xs.catalog'); cached = raw ? JSON.parse(raw) : null; } catch (e) { cached = null; }
          if (cached) resolve({ catalog: cached, cached: true, error: err });
          else reject(err);
        });
      });
    }
  };
  XS.api = api;
})();
