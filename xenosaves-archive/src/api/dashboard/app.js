'use strict';
(() => {
  const $ = (s) => document.querySelector(s);
  const STATUSES = ['DISCOVERED', 'PERMISSION_PENDING', 'QUEUED', 'DOWNLOADING', 'VERIFYING', 'STORED', 'FAILED', 'RESTRICTED', 'QUARANTINED', 'REMOVED'];
  let token = sessionStorage.getItem('xsa_admin') || '';
  let page = 1;
  let timer = null;

  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const fmtBytes = (n) => {
    n = Number(n || 0);
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return `${n.toFixed(i ? 1 : 0)} ${u[i]}`;
  };
  const pill = (s) => `<span class="pill p-${esc(s)}">${esc(s)}</span>`;
  const ago = (t) => {
    if (!t) return '—';
    const s = Math.round((Date.now() - new Date(t).getTime()) / 1000);
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.round(s / 60)}m ago`;
    if (s < 86400) return `${Math.round(s / 3600)}h ago`;
    return `${Math.round(s / 86400)}d ago`;
  };
  function toast(msg, bad) {
    const t = $('#toast');
    t.textContent = msg;
    t.style.background = bad ? '#b62324' : '#1f6feb';
    t.style.display = 'block';
    setTimeout(() => (t.style.display = 'none'), 3500);
  }

  async function api(path, opts = {}) {
    const res = await fetch(`/admin/api${path}`, {
      ...opts,
      headers: { authorization: `Bearer ${token}`, ...(opts.body ? { 'content-type': 'application/json' } : {}) },
    });
    if (res.status === 401) { logout(); throw new Error('unauthorized'); }
    const ct = res.headers.get('content-type') || '';
    const body = ct.includes('json') ? await res.json() : await res.text();
    if (!res.ok) throw new Error(body.error || res.statusText);
    return body;
  }
  const post = (p, b) => api(p, { method: 'POST', body: JSON.stringify(b || {}) });

  function logout() {
    sessionStorage.removeItem('xsa_admin');
    token = '';
    clearInterval(timer);
    $('#app').classList.add('hidden');
    $('#login').classList.remove('hidden');
  }

  async function login() {
    token = $('#token').value.trim();
    try {
      await api('/overview');
      sessionStorage.setItem('xsa_admin', token);
      start();
    } catch (e) {
      $('#loginErr').textContent = 'Sign-in failed: ' + e.message;
    }
  }

  function card(k, v, s) {
    return `<div class="card"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div>${s ? `<div class="s">${esc(s)}</div>` : ''}</div>`;
  }

  async function refresh() {
    const o = await api('/overview');
    const s = o.stats;
    $('#updated').textContent = 'updated ' + new Date().toLocaleTimeString();
    const discovered = Number(s.total_records);
    $('#cards').innerHTML = [
      card('Discovered saves', discovered.toLocaleString(), 'all sources, all statuses'),
      card('Downloaded archives', Number(s.stored_records).toLocaleString(), 'records with a real stored file'),
      card('Unique files', Number(s.unique_files).toLocaleString(), 'by SHA-256'),
      card('Stored', fmtBytes(s.stored_bytes), `dedup saved ${fmtBytes(s.dedup_saved_bytes)}`),
      card('Verified', Number(s.verified_records).toLocaleString(), 'all checks incl. malware scan'),
      card('Queued', Number(s.queued).toLocaleString(), `${s.in_progress} in progress`),
      card('Pending permission', Number(s.permission_pending).toLocaleString(), 'not downloaded'),
      card('Failed', Number(s.failed).toLocaleString(), ''),
      card('Duplicates', Number(s.duplicate_records).toLocaleString(), 'records sharing a file'),
      card('Restricted / external', Number(s.restricted).toLocaleString(), 'never bypassed'),
      card('Quarantined', Number(s.quarantined).toLocaleString(), ''),
      card('Sources', s.sources, ''),
    ].join('');

    const state = o.settings.collection_state;
    $('#stateTag').className = `pill p-${state}`;
    $('#stateTag').textContent = state;
    const soft = Number(o.settings.storage_soft_limit_bytes);
    const hard = Number(o.settings.storage_hard_limit_bytes);
    $('#storageText').textContent = `${fmtBytes(s.stored_bytes)} stored`;
    $('#limitText').textContent = `soft ${fmtBytes(soft)} · hard ${fmtBytes(hard)}`;
    $('#storageBar').style.width = `${Math.min(100, (Number(s.stored_bytes) / hard) * 100).toFixed(3)}%`;
    if (document.activeElement.tagName !== 'INPUT') {
      $('#conc').value = o.settings.global_concurrency;
      $('#soft').value = Math.round(soft / 1024 ** 3);
      $('#hard').value = Math.round(hard / 1024 ** 3);
    }

    $('#sources tbody').innerHTML = o.sources.map((src) => {
      const c = src.counts || {};
      const disc = src.last_discovery_status
        ? `${pill(src.last_discovery_status)} <span class="muted">${ago(src.last_discovery_at)}</span>${src.last_discovery_error ? `<div class="lvl-error trunc" title="${esc(src.last_discovery_error)}">${esc(src.last_discovery_error)}</div>` : ''}`
        : '<span class="muted">never</span>';
      return `<tr>
        <td><b>${esc(src.name)}</b><div class="muted">${esc(src.id)} · ${esc(src.kind)}${src.homepage ? ` · <a href="${esc(src.homepage)}" target="_blank" rel="noopener noreferrer">site</a>` : ''}</div>
            ${src.permission_evidence ? `<div class="muted trunc" title="${esc(src.permission_evidence)}">evidence: ${esc(src.permission_evidence)}</div>` : ''}</td>
        <td>${pill(src.policy)}<div class="muted">${src.enabled ? 'enabled' : 'disabled'}${src.paused ? ' · paused' : ''}</div></td>
        <td>${disc}</td>
        <td class="num">${c.STORED || 0}</td><td class="num">${(c.QUEUED || 0) + (c.DOWNLOADING || 0) + (c.VERIFYING || 0)}</td>
        <td class="num">${c.PERMISSION_PENDING || 0}</td><td class="num">${c.FAILED || 0}</td><td class="num">${c.RESTRICTED || 0}</td>
        <td class="num">${(Number(src.stored_bytes) / 1024 ** 3).toFixed(3)}</td>
        <td><div class="row">
          <button data-act="discover" data-id="${esc(src.id)}">Discover now</button>
          <button data-act="${src.paused ? 'resume' : 'pause'}" data-id="${esc(src.id)}">${src.paused ? 'Resume' : 'Pause'}</button>
          <button data-act="${src.enabled ? 'disable' : 'enable'}" data-id="${esc(src.id)}">${src.enabled ? 'Disable' : 'Enable'}</button>
          <button data-act="policy" data-id="${esc(src.id)}">Permission…</button>
        </div></td></tr>`;
    }).join('');

    $('#inprogress tbody').innerHTML = o.inProgress.length
      ? o.inProgress.map((r) => {
          const pct = r.bytes_total ? Math.round((r.bytes_downloaded / r.bytes_total) * 100) : null;
          return `<tr><td>${r.id}</td><td class="trunc">${esc(r.game_title || r.original_filename)}</td><td>${pill(r.status)}</td>
            <td>${fmtBytes(r.bytes_downloaded)}${r.bytes_total ? ` / ${fmtBytes(r.bytes_total)} (${pct}%)` : ''}</td></tr>`;
        }).join('')
      : '<tr><td colspan="4" class="muted">Nothing downloading right now</td></tr>';

    $('#recent tbody').innerHTML = o.recentStored.map((r) => `<tr><td>${r.id}</td><td class="trunc">${esc(r.game_title)}</td><td>${esc(r.title_id)}</td>
      <td>${esc(r.category || '—')}</td><td class="num">${fmtBytes(r.size_bytes)}</td><td>${r.verified ? pill('ok') : '<span class="muted">incomplete</span>'}</td></tr>`).join('')
      || '<tr><td colspan="6" class="muted">No stored files yet</td></tr>';

    $('#workers tbody').innerHTML = o.workers.map((w) => `<tr><td>${esc(w.id)}</td><td>${w.alive && !(w.info || {}).stopped ? pill('ok') : pill('stopped')}</td>
      <td>${ago(w.last_seen)}</td><td>${((w.info || {}).inflight || []).length}</td><td>${(w.info || {}).work_dir_free_bytes != null ? fmtBytes(w.info.work_dir_free_bytes) : '—'}</td></tr>`).join('')
      || '<tr><td colspan="5" class="muted">No worker has reported yet</td></tr>';

    $('#events').innerHTML = o.recentEvents.map((e) => `<div class="lvl-${esc(e.level)}">${new Date(e.at).toLocaleTimeString()} · ${esc(e.event)}${e.record_id ? ` #${e.record_id}` : ''}${e.source_id ? ` [${esc(e.source_id)}]` : ''} — ${esc(e.message || '')}</div>`).join('');

    const fs = $('#fSource');
    if (fs.options.length <= 1) for (const src of o.sources) fs.add(new Option(src.id, src.id));
  }

  async function loadRecords() {
    const p = new URLSearchParams({ page, page_size: 50 });
    if ($('#fStatus').value) p.set('status', $('#fStatus').value);
    if ($('#fSource').value) p.set('source', $('#fSource').value);
    if ($('#fQ').value) p.set('q', $('#fQ').value);
    const r = await api(`/records?${p}`);
    $('#pageInfo').textContent = `page ${r.page} · ${r.total.toLocaleString()} records`;
    $('#records tbody').innerHTML = r.results.map((x) => `<tr>
      <td>${x.id}</td><td>${esc(x.source_id)}</td>
      <td><div class="trunc" title="${esc(x.source_item_key)}">${esc(x.game_title || x.source_item_key)}</div><div class="muted">${esc(x.title_id || '')} ${esc(x.platform || '')} ${esc(x.category || '')}</div></td>
      <td>${pill(x.status)}<div class="muted">${esc(x.redistribution)}</div></td>
      <td class="trunc" title="${esc(x.status_reason || x.last_error || '')}">${esc(x.status_reason || x.last_error || '')}</td>
      <td class="num">${x.size_bytes ? fmtBytes(x.size_bytes) : '—'}</td>
      <td><div class="row">
        ${['FAILED', 'RESTRICTED'].includes(x.status) && x.redistribution === 'granted' ? `<button data-rec="retry" data-id="${x.id}">Retry</button>` : ''}
        ${x.status === 'QUARANTINED' ? `<button data-rec="recheck" data-id="${x.id}">Re-check</button>` : ''}
        ${x.status === 'PERMISSION_PENDING' ? `<button data-rec="grant" data-id="${x.id}">Grant…</button><button data-rec="deny" data-id="${x.id}">Deny</button>` : ''}
        ${!['REMOVED'].includes(x.status) ? `<button class="danger" data-rec="remove" data-id="${x.id}">Remove</button>` : ''}
        ${x.source_page_url ? `<a href="${esc(x.source_page_url)}" target="_blank" rel="noopener noreferrer">source</a>` : ''}
      </div></td></tr>`).join('') || '<tr><td colspan="7" class="muted">No records</td></tr>';
  }

  async function loadDups() {
    const d = await api('/duplicates');
    $('#dups').innerHTML = `<div><b>${d.exact.length}</b> files shared by multiple records (credits preserved) · <b>${d.repacked.length}</b> groups with identical contents in differently-packed archives (review only, never auto-merged)</div>`
      + d.exact.slice(0, 20).map((x) => `<div class="muted trunc">${esc(x.sha256.slice(0, 16))}… ${fmtBytes(x.size_bytes)} × ${x.records}: ${esc(x.items.join(', '))}</div>`).join('');
  }

  document.addEventListener('click', async (ev) => {
    const b = ev.target.closest('button');
    if (!b) return;
    try {
      const id = b.dataset.id;
      switch (b.dataset.act) {
        case 'discover': await post(`/sources/${id}/discover`); toast(`Discovery started for ${id}`); break;
        case 'pause': await post(`/sources/${id}`, { paused: true }); break;
        case 'resume': await post(`/sources/${id}`, { paused: false }); break;
        case 'enable': await post(`/sources/${id}`, { enabled: true }); break;
        case 'disable': await post(`/sources/${id}`, { enabled: false }); break;
        case 'policy': {
          const policy = prompt('Policy: MIRROR_ALLOWED, PERMISSION_REQUIRED, EXTERNAL_ONLY or BLOCKED');
          if (!policy) return;
          let evidence;
          if (policy.trim() === 'MIRROR_ALLOWED') {
            evidence = prompt('Permission evidence (licence URL, or where/when the site owner granted permission):');
            if (!evidence) return;
          }
          await post(`/sources/${id}`, { policy: policy.trim(), permission_evidence: evidence });
          toast('Policy updated');
          break;
        }
      }
      switch (b.dataset.rec) {
        case 'retry': await post(`/records/${id}/retry`); toast('Requeued'); break;
        case 'grant': {
          const basis = prompt('Permission basis (link / note proving the uploader or site allowed redistribution):');
          if (!basis) return;
          await post(`/records/${id}/permission`, { decision: 'grant', basis });
          toast('Permission recorded — queued');
          break;
        }
        case 'deny': await post(`/records/${id}/permission`, { decision: 'deny' }); break;
        case 'recheck': await post(`/records/${id}/recheck`); toast('Re-queued for a fresh download + inspection'); break;
        case 'remove': {
          const reason = prompt('Removal / takedown reason:');
          if (!reason) return;
          const r = await post(`/records/${id}/remove`, { reason });
          toast(r.object_deleted ? 'Removed and object deleted' : 'Removed (object still used by another record)');
          break;
        }
      }
      if (b.id === 'btnRun') await post('/collection', { state: 'running' });
      if (b.id === 'btnPause') await post('/collection', { state: 'paused' });
      if (b.id === 'btnStop' && confirm('Stop collection? In-flight downloads finish; nothing new starts.')) await post('/collection', { state: 'stopped' });
      if (b.id === 'btnLogout') return logout();
      if (b.id === 'saveSettings') {
        await post('/settings', {
          global_concurrency: Number($('#conc').value),
          storage_soft_limit_bytes: Math.round(Number($('#soft').value) * 1024 ** 3),
          storage_hard_limit_bytes: Math.round(Number($('#hard').value) * 1024 ** 3),
        });
        toast('Settings saved');
      }
      if (b.id === 'retryFailed') { const r = await post('/records/retry-failed', {}); toast(`${r.requeued} requeued`); }
      if (b.id === 'fGo') { page = 1; }
      if (b.id === 'prev') page = Math.max(1, page - 1);
      if (b.id === 'next') page++;
      await refresh();
      await loadRecords();
    } catch (e) {
      toast(e.message, true);
    }
  });

  $('#csv').addEventListener('click', async (ev) => {
    ev.preventDefault();
    const text = await api('/catalog.csv');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv' }));
    a.download = 'xenosaves-catalog.csv';
    a.click();
  });

  function start() {
    $('#login').classList.add('hidden');
    $('#app').classList.remove('hidden');
    const sel = $('#fStatus');
    if (sel.options.length <= 1) for (const s of STATUSES) sel.add(new Option(s, s));
    refresh().then(loadRecords).then(loadDups).catch((e) => toast(e.message, true));
    clearInterval(timer);
    timer = setInterval(() => refresh().catch(() => {}), 5000);
  }

  $('#loginBtn').addEventListener('click', login);
  $('#token').addEventListener('keydown', (e) => e.key === 'Enter' && login());
  if (token) start();
})();
