// ---------------------------------------------------------------------------
// XENOKING auth gate
// Runs BEFORE the tool. The tool bundle is NOT loaded until the logged-in
// account is owner-approved — the gate injects it only after approval, so
// unapproved users never get the tool code running at all. Owner logins get an
// in-panel dashboard to approve/block/ban sign-ups. Talks to the XENOKING
// backend (see backend/). No inline scripts, so it satisfies the extension CSP
// (script-src 'self').
// ---------------------------------------------------------------------------
(function () {
  'use strict';

  var CFG = window.XENOKING_CONFIG || {};
  var TOOL_BUNDLE = CFG.TOOL_BUNDLE || '/sidepanel.b7741352.js';
  var BACKEND = '';
  var TOKEN = '';
  var ROLE = ''; // 'owner' | 'admin' for staff accounts, '' for regular users

  // ---- storage helpers (chrome.storage.local is promise-based in MV3) --------
  function sget(keys) { return chrome.storage.local.get(keys); }
  function sset(obj) { return chrome.storage.local.set(obj); }
  function sdel(keys) { return chrome.storage.local.remove(keys); }

  function plasmo() { return document.getElementById('__plasmo'); }
  function hideApp() { var p = plasmo(); if (p) p.style.display = 'none'; }
  function showApp() { var p = plasmo(); if (p) p.style.display = ''; }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // Require https for the backend (login/password travel over it). Allow http
  // only for localhost during development.
  function normalizeBackend(url) {
    var u = String(url == null ? '' : url).trim().replace(/\/+$/, '');
    if (!u) return '';
    if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
    if (/^http:\/\//i.test(u) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/i.test(u)) {
      throw new Error('Server URL must start with https://');
    }
    return u;
  }

  // ---- backend calls --------------------------------------------------------
  async function api(path, opts) {
    opts = opts || {};
    if (!BACKEND) throw new Error('No server URL configured yet.');
    var headers = { 'Content-Type': 'application/json' };
    if (TOKEN) headers.Authorization = 'Bearer ' + TOKEN;
    if (opts.headers) for (var k in opts.headers) headers[k] = opts.headers[k];
    var res = await fetch(BACKEND + path, {
      method: opts.method || 'GET',
      headers: headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    var data = {};
    try { data = await res.json(); } catch (e) { /* non-JSON */ }
    if (!res.ok) {
      var err = new Error(data.message || data.error || ('HTTP ' + res.status));
      err.code = data.error; err.status = res.status;
      throw err;
    }
    return data;
  }

  // ---- gate root ------------------------------------------------------------
  var root = document.createElement('div');
  root.id = 'xk-gate';
  document.body.appendChild(root);
  hideApp();

  var EMBLEM =
    '<svg class="xk-emblem" viewBox="0 0 120 120" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
    '<defs><linearGradient id="xkg" x1="0" y1="0" x2="120" y2="120" gradientUnits="userSpaceOnUse">' +
    '<stop stop-color="#25e6ff"/><stop offset=".55" stop-color="#8b5cf6"/><stop offset="1" stop-color="#ff3d81"/>' +
    '</linearGradient></defs>' +
    '<path d="M60 6 108 33 108 87 60 114 12 87 12 33Z" fill="rgba(10,14,28,.55)" stroke="url(#xkg)" stroke-width="3" stroke-linejoin="round"/>' +
    '<path d="M34 78 L29 45 L46 60 L60 35 L74 60 L91 45 L86 78 Z" fill="url(#xkg)"/>' +
    '<rect x="34" y="82" width="52" height="8" rx="2.5" fill="url(#xkg)"/>' +
    '<circle cx="29" cy="43" r="4.5" fill="#25e6ff"/><circle cx="60" cy="32" r="4.5" fill="#8b5cf6"/><circle cx="91" cy="43" r="4.5" fill="#ff3d81"/>' +
    '</svg>';

  function brand() {
    return '<div class="xk-brand">' + EMBLEM + '<div class="xk-word">XENOKING</div><div class="xk-tag">AUTO LISTER</div></div>';
  }

  function durationSelect() {
    return '<select class="xk-dur" title="Access length">' +
      '<option value="0">Unlimited</option>' +
      '<option value="1">1 day</option><option value="3">3 days</option>' +
      '<option value="7">7 days</option><option value="14">14 days</option>' +
      '<option value="30" selected>30 days</option>' +
      '<option value="60">60 days</option><option value="90">90 days</option>' +
      '</select>';
  }

  // ---- reveal: provision the shared key, then load the tool bundle ----------
  // Approved users get the shared inventory/AI key from the server written into
  // the key the tool reads (storage "password", @plasmohq JSON-encoded), so they
  // never type an API key themselves. The tool bundle is injected here — it does
  // not run for anyone who never reaches this point.
  var toolInjected = false;
  function injectTool() {
    if (toolInjected) return;
    toolInjected = true;
    var s = document.createElement('script');
    s.src = TOOL_BUNDLE;
    // The tool bundle mounts inside a DOMContentLoaded listener, but that event
    // already fired long before this (we inject after login). Fire a synthetic
    // one once the script has registered its listener so the app actually mounts.
    s.onload = function () {
      try { document.dispatchEvent(new Event('DOMContentLoaded')); } catch (e) { /* ignore */ }
    };
    document.body.appendChild(s);
  }

  async function provisionAndReveal() {
    var provisioned = false;
    try {
      var r = await api('/api/config');
      var key = r && r.config && r.config.dataApiKey;
      if (key) { await sset({ password: JSON.stringify(String(key)) }); provisioned = true; }
    } catch (e) { /* non-fatal: tool still opens, user can enter a key manually */ }
    root.remove();
    showApp();
    injectTool();
    if (ROLE) addAdminFab();
    if (provisioned) hideLegacyKeyField();
  }

  // Floating button over the tool so owner/admins can hop back to the
  // dashboard to approve people. Reloading the panel re-runs the gate, which
  // routes staff straight to the dashboard (tool data lives in chrome.storage,
  // so nothing is lost).
  function addAdminFab() {
    if (byId('xk-admin-fab')) return;
    var b = document.createElement('button');
    b.id = 'xk-admin-fab';
    b.textContent = '⚙ Admin';
    b.title = 'Back to the admin dashboard';
    b.setAttribute('style',
      'position:fixed;bottom:14px;right:14px;z-index:2147483647;' +
      'background:linear-gradient(135deg,#2563eb,#8b5cf6);color:#fff;border:none;' +
      'border-radius:999px;padding:10px 16px;font-weight:700;font-size:13px;' +
      'font-family:system-ui,sans-serif;box-shadow:0 6px 24px rgba(37,99,235,.55);cursor:pointer');
    b.onclick = function () { location.reload(); };
    document.body.appendChild(b);
  }

  // Best-effort: hide the old "Enter your API Key" input in the tool UI once we
  // auto-provision the key. Guarded so a UI change never breaks the tool.
  function hideLegacyKeyField() {
    var tries = 0;
    var timer = setInterval(function () {
      tries++;
      try {
        var inputs = document.querySelectorAll('#__plasmo input[placeholder]');
        inputs.forEach(function (inp) {
          if (/enter your api key/i.test(inp.getAttribute('placeholder') || '')) {
            var box = inp.closest('div');
            if (box && box.parentElement) box.parentElement.style.display = 'none';
          }
        });
      } catch (e) { /* ignore */ }
      if (tries >= 8) clearInterval(timer);
    }, 400);
  }

  // ---- views ----------------------------------------------------------------
  function needBackendField() { return !CFG.BACKEND_URL; }

  function renderLogin(msg, msgCls) {
    root.innerHTML =
      brand() +
      '<div class="xk-card">' +
        (needBackendField() ? '<label>Server URL</label><input id="xk-base" placeholder="https://your-server.com" value="' + esc(BACKEND) + '">' : '') +
        '<label>Email</label><input id="xk-email" type="email" autocomplete="username">' +
        '<label>Password</label><input id="xk-pass" type="password" autocomplete="current-password">' +
        '<button class="xk-full" id="xk-login">Log in</button>' +
        '<div class="xk-msg ' + (msgCls || 'err') + '" id="xk-msg">' + esc(msg || '') + '</div>' +
        '<div class="xk-switch">No account? <a id="xk-to-signup">Sign up</a></div>' +
      '</div>';
    byId('xk-login').onclick = doLogin;
    byId('xk-to-signup').onclick = function () { renderSignup(); };
    focusFirst();
  }

  function renderSignup(msg, msgCls) {
    root.innerHTML =
      brand() +
      '<div class="xk-card">' +
        (needBackendField() ? '<label>Server URL</label><input id="xk-base" placeholder="https://your-server.com" value="' + esc(BACKEND) + '">' : '') +
        '<label>Name (optional)</label><input id="xk-name" type="text" autocomplete="name">' +
        '<label>Email</label><input id="xk-email" type="email" autocomplete="username">' +
        '<label>Password</label><input id="xk-pass" type="password" autocomplete="new-password">' +
        '<button class="xk-full" id="xk-signup">Create account</button>' +
        '<div class="xk-msg ' + (msgCls || 'err') + '" id="xk-msg">' + esc(msg || '') + '</div>' +
        '<div class="xk-note">New accounts must be approved by the owner before you can use the tool.</div>' +
        '<div class="xk-switch">Already have an account? <a id="xk-to-login">Log in</a></div>' +
      '</div>';
    byId('xk-signup').onclick = doSignup;
    byId('xk-to-login').onclick = function () { renderLogin(); };
    focusFirst();
  }

  function renderStatus(title, msg) {
    root.innerHTML =
      brand() +
      '<div class="xk-card">' +
        '<h3 style="margin:0 0 6px">' + esc(title) + '</h3>' +
        '<div class="xk-note">' + esc(msg) + '</div>' +
        '<button class="xk-ghost xk-full" id="xk-logout">Back to login</button>' +
      '</div>';
    byId('xk-logout').onclick = logout;
  }

  function renderOwner() {
    root.innerHTML =
      brand() +
      '<div class="xk-card xk-dash">' +
        '<div class="xk-between">' +
          '<div class="xk-counts" id="xk-counts"><span class="xk-chip">Loading…</span></div>' +
          '<div class="xk-row">' +
            '<button class="xk-ghost" id="xk-refresh">Refresh</button>' +
            '<button id="xk-open">Open Tool</button>' +
            '<button class="xk-ghost" id="xk-logout">Log out</button>' +
          '</div>' +
        '</div>' +
        '<div class="xk-userlist" id="xk-rows"><div class="xk-empty"><span class="xk-spin"></span></div></div>' +
        '<div class="xk-msg err" id="xk-msg"></div>' +
      '</div>';
    byId('xk-refresh').onclick = loadUsers;
    byId('xk-logout').onclick = logout;
    byId('xk-open').onclick = function () { provisionAndReveal(); };
    byId('xk-rows').addEventListener('click', onOwnerAction);
    loadUsers();
  }

  function accessLine(u) {
    if (u.role === 'owner') return '';
    if (u.status !== 'approved') return '';
    if (u.days_left == null) return '<div class="xk-uleft"><b>Unlimited</b> access</div>';
    if (u.expired || u.days_left <= 0) return '<div class="xk-uleft">access <b>expired</b></div>';
    return '<div class="xk-uleft"><b>' + u.days_left + '</b> day' + (u.days_left === 1 ? '' : 's') + ' left</div>';
  }

  async function loadUsers() {
    var msg = byId('xk-msg'); if (msg) msg.textContent = '';
    try {
      var r = await api('/api/admin/users');
      var users = (r.users || []).filter(function (u) { return u.role !== 'owner'; });
      var counts = { pending: 0, approved: 0, blocked: 0, banned: 0, expired: 0 };
      var cards = users.map(function (u) {
        var expired = u.status === 'approved' && (u.expired || (u.days_left != null && u.days_left <= 0));
        var key = expired ? 'expired' : u.status;
        counts[key] = (counts[key] || 0) + 1;
        var primaryLabel = (u.status === 'approved') ? (expired ? 'Renew' : 'Update') : 'Approve';
        var isAdmin = u.role === 'admin';
        var adminBadge = isAdmin
          ? '<span class="xk-pill" style="margin-right:6px;background:rgba(139,92,246,.18);color:#c4a8ff;border:1px solid rgba(139,92,246,.45)">ADMIN</span>'
          : '';
        // Admins may only manage regular users — admin accounts are the owner's.
        var actions;
        if (isAdmin && ROLE !== 'owner') {
          actions = '<div class="xk-note" style="margin:0">Managed by the owner</div>';
        } else {
          var roleBtn = ROLE === 'owner'
            ? (isAdmin
                ? '<button class="xk-ghost" data-a="role" data-role="user" title="Remove admin powers">Remove Admin</button>'
                : '<button class="xk-ghost" data-a="role" data-role="admin" title="Let this user approve people too">Make Admin</button>')
            : '';
          actions = durationSelect() +
            '<button class="xk-approve" data-a="approve">' + primaryLabel + '</button>' +
            roleBtn +
            '<button class="xk-block" data-a="block">Block</button>' +
            '<button class="xk-ban" data-a="ban">Ban</button>' +
            '<button class="xk-del" data-a="delete">Delete</button>';
        }
        return '<div class="xk-ucard" data-id="' + esc(String(u.id)) + '">' +
          '<div class="xk-uhead"><div>' +
            '<div class="xk-uemail">' + esc(u.email) + '</div>' +
            (u.name ? '<div class="xk-uname">' + esc(u.name) + '</div>' : '') +
            accessLine(u) +
          '</div><span>' + adminBadge + '<span class="xk-pill ' + key + '">' + (key === 'approved' ? 'active' : key) + '</span></span></div>' +
          '<div class="xk-uactions">' + actions + '</div>' +
        '</div>';
      }).join('');
      byId('xk-rows').innerHTML = cards || '<div class="xk-empty">No sign-ups yet. Share the extension and approvals will show up here.</div>';
      byId('xk-counts').innerHTML =
        '<span class="xk-chip">' + counts.pending + ' pending</span>' +
        '<span class="xk-chip">' + counts.approved + ' active</span>' +
        (counts.expired ? '<span class="xk-chip">' + counts.expired + ' expired</span>' : '') +
        '<span class="xk-chip">' + counts.blocked + ' blocked</span>' +
        '<span class="xk-chip">' + counts.banned + ' banned</span>';
    } catch (e) {
      if (e.code === 'owner_only' || e.code === 'admin_only' || e.status === 401) return logout();
      var m = byId('xk-msg'); if (m) m.textContent = e.message;
    }
  }

  async function onOwnerAction(ev) {
    var btn = ev.target.closest('button[data-a]');
    if (!btn) return;
    var card = btn.closest('.xk-ucard');
    if (!card) return;
    var id = card.getAttribute('data-id');
    var action = btn.getAttribute('data-a');
    if (action === 'delete' && !confirm('Delete this user permanently?')) return;
    btn.disabled = true;
    try {
      if (action === 'role') {
        await api('/api/admin/users/' + id + '/role', { method: 'POST', body: { role: btn.getAttribute('data-role') } });
      } else {
        var sel = card.querySelector('.xk-dur');
        var days = sel ? Number(sel.value) || 0 : 0;
        await api('/api/admin/users/' + id + '/' + action, { method: 'POST', body: { days: days } });
      }
      await loadUsers();
    } catch (e) {
      var m = byId('xk-msg'); if (m) m.textContent = e.message; btn.disabled = false;
    }
  }

  // ---- actions --------------------------------------------------------------
  // Reads + validates the backend URL from the field (throws if not https).
  function readBackendFromField() {
    var f = byId('xk-base');
    if (f) BACKEND = normalizeBackend(f.value);
  }

  async function doSignup() {
    var msg = byId('xk-msg'); msg.className = 'xk-msg err';
    try { readBackendFromField(); } catch (e) { msg.textContent = e.message; return; }
    if (!BACKEND) { msg.textContent = 'Enter the server URL.'; return; }
    var email = val('xk-email'), pass = val('xk-pass'), name = val('xk-name');
    byId('xk-signup').disabled = true;
    try {
      await sset({ xk_backend: BACKEND });
      await api('/api/signup', { method: 'POST', body: { email: email, password: pass, name: name } });
      renderStatus('Almost there', 'Account created for ' + email + '. The owner needs to approve you before you can log in.');
    } catch (e) {
      msg.textContent = e.message; byId('xk-signup').disabled = false;
    }
  }

  async function doLogin() {
    var msg = byId('xk-msg'); msg.className = 'xk-msg err';
    try { readBackendFromField(); } catch (e) { msg.textContent = e.message; return; }
    if (!BACKEND) { msg.textContent = 'Enter the server URL.'; return; }
    var email = val('xk-email'), pass = val('xk-pass');
    byId('xk-login').disabled = true;
    try {
      await sset({ xk_backend: BACKEND });
      var r = await api('/api/login', { method: 'POST', body: { email: email, password: pass } });
      TOKEN = r.token;
      await sset({ xk_token: TOKEN });
      route(r.user);
    } catch (e) {
      byId('xk-login').disabled = false;
      msg.textContent = e.message;
    }
  }

  async function logout() {
    TOKEN = '';
    await sdel(['xk_token']);
    renderLogin();
  }

  function route(user) {
    if (!user) return renderLogin();
    ROLE = (user.role === 'owner' || user.role === 'admin') ? user.role : '';
    if (ROLE) return renderOwner();
    if (user.status === 'approved') return provisionAndReveal();
    var m = {
      pending: 'Your account is waiting for owner approval.',
      blocked: 'Your account has been blocked. Contact the owner.',
      banned: 'Your account has been banned.',
      expired: 'Your access has expired. Ask the owner to renew it.',
    };
    return renderStatus('No access yet', m[user.status] || 'Your account is not approved.');
  }

  // ---- helpers --------------------------------------------------------------
  function byId(id) { return document.getElementById(id); }
  function val(id) { var e = byId(id); return e ? e.value.trim() : ''; }
  function focusFirst() { var e = root.querySelector('input'); if (e) e.focus(); }

  // ---- boot -----------------------------------------------------------------
  (async function boot() {
    try {
      var saved = await sget(['xk_token', 'xk_backend']);
      try {
        BACKEND = normalizeBackend(CFG.BACKEND_URL || saved.xk_backend || '');
      } catch (e) {
        return renderLogin(e.message, 'err');
      }
      TOKEN = saved.xk_token || '';
      if (TOKEN && BACKEND) {
        try {
          var me = await api('/api/me');
          return route(me.user);
        } catch (e) {
          if (e.status === 401) { TOKEN = ''; await sdel(['xk_token']); }
          else if (e.code && ['pending', 'blocked', 'banned', 'expired'].indexOf(e.code) >= 0) {
            return route({ status: e.code, role: 'user' });
          }
        }
      }
      renderLogin();
    } catch (e) {
      renderLogin('Could not start: ' + (e.message || e), 'err');
    }
  })();
})();
