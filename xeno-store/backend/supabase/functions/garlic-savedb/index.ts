// XENO STORE · Save Data Store · garlic-savedb edge function.
//
// Mirrors garlicsaves.com's Save DB into public.ps5_save_collection (PS5 rows
// only) and proxies decrypted zip downloads for `garlic:<id>` rows. The Garlic
// session cookies live in function secrets and never reach a console:
// consoles call this function with the project's public anon key only.
//
// Actions (POST JSON):
//   {}                                   list every PS5 save parsed from garlicsaves.com/savedb
//   { "action": "download", "id": 123 }  stream the decrypted zip for Garlic save 123
//   { "action": "sync", "covers": 6 }    insert unseen PS5 saves (status 'published', source 'garlic'),
//                                        then fill covers / sizes for a few rows (icon0.png from the zip)
//   { "action": "debug" }                raw page sample, for when Garlic changes its HTML
//
// Secrets: GARLIC_SAVEDB_SESSION (fallback GARLIC_SESSION), GARLIC_SAVEDB_CF (fallback
// GARLIC_CF_CLEARANCE), optional GARLIC_USERNAME / GARLIC_PASSWORD, optional XENO_SYNC_TOKEN
// (when set, `sync` requires the header x-xeno-sync-token to match). SUPABASE_URL and
// SUPABASE_SERVICE_ROLE_KEY are injected by the platform.
import { corsHeaders } from 'npm:@supabase/supabase-js@2/cors';
import { createClient } from 'npm:@supabase/supabase-js@2';
import JSZip from 'npm:jszip@3.10.1';

const GARLIC_BASE = 'https://garlicsaves.com';
const BUCKET = 'ps5-saves';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36';
const TITLE_RE = /^PPSA\d{5}$/;
const MAX_COVER_ZIP = 256 * 1024 * 1024;  // never buffer more than this for a cover lookup
type Jar = Map<string, string>;

type GarlicSave = { id: number; titleId: string; title: string; platform: 'ps5' | 'ps4'; description: string; by: string };

function seed(jar: Jar, raw: string, name: string) {
  if (!raw) return;
  if (!raw.includes('=')) { jar.set(name, raw); return; }
  for (const p of raw.split(';')) {
    const i = p.indexOf('=');
    if (i > 0) {
      const k = p.slice(0, i).trim();
      if (!/^(path|domain|max-age|expires|secure|httponly|samesite)$/i.test(k)) jar.set(k, p.slice(i + 1).trim());
    }
  }
}
function absorb(h: Headers, jar: Jar) {
  const vals: string[] = (h as any).getSetCookie?.() || [];
  for (const raw of vals) {
    const f = raw.split(';', 1)[0]; const i = f.indexOf('=');
    if (i > 0) jar.set(f.slice(0, i).trim(), f.slice(i + 1).trim());
  }
}
async function gfetch(path: string, jar: Jar, init: RequestInit = {}) {
  const headers = new Headers(init.headers || {});
  headers.set('User-Agent', UA);
  headers.set('Referer', `${GARLIC_BASE}/savedb`);
  headers.set('Origin', GARLIC_BASE);
  const c = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  if (c) headers.set('Cookie', c);
  const r = await fetch(path.startsWith('http') ? path : `${GARLIC_BASE}${path}`, { ...init, headers, redirect: 'manual', signal: AbortSignal.timeout(25000) });
  absorb(r.headers, jar);
  return r;
}
const isLogin = (r: Response, t: string) => (r.status >= 300 && r.status < 400 && /login/i.test(r.headers.get('location') || '')) || /name="password"/i.test(t);

async function session(): Promise<Jar> {
  const jar: Jar = new Map();
  seed(jar, Deno.env.get('GARLIC_SAVEDB_SESSION') || Deno.env.get('GARLIC_SESSION') || '', 'session');
  seed(jar, Deno.env.get('GARLIC_SAVEDB_CF') || Deno.env.get('GARLIC_CF_CLEARANCE') || '', 'cf_clearance');
  const r = await gfetch('/savedb', jar); const t = await r.text();
  if (!isLogin(r, t)) return jar;
  const f = new FormData();
  f.append('username', Deno.env.get('GARLIC_USERNAME') || '');
  f.append('password', Deno.env.get('GARLIC_PASSWORD') || '');
  const lr = await gfetch('/login', jar, { method: 'POST', body: f });
  const lt = await lr.text();
  (jar as any).__login = { status: lr.status, loc: lr.headers.get('location'), err: strip(lt).slice(0, 300), cookies: [...jar.keys()] };
  return jar;
}

const strip = (s: string) => s.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();

function parse(html: string): GarlicSave[] {
  const out: GarlicSave[] = [];
  for (const p of html.split('<div class="savedb-card">').slice(1)) {
    const id = Number(p.match(/\/savedb\/(\d+)\/download/)?.[1]);
    const titleId = p.match(/savedb-card-cusa">\s*([A-Z]{4}\d{5})/)?.[1];
    if (!id || !titleId) continue;
    out.push({
      id, titleId,
      title: strip(p.match(/savedb-card-title">([\s\S]*?)<\/span>/)?.[1] || titleId),
      platform: /badge-ps5/.test(p) ? 'ps5' : 'ps4',
      description: strip(p.match(/savedb-card-desc">([\s\S]*?)<\/div>/)?.[1] || ''),
      by: strip(p.match(/<span>\s*by\s+([^<]+)<\/span>/)?.[1] || 'garlicsaves'),
    });
  }
  return out;
}

// Same keyword rules as the console (cx_savestore.c) so chips match everywhere.
function inferCategory(text: string): string {
  const t = text.toLowerCase();
  if (t.includes('100%') || t.includes('platinum')) return 'platinum';
  if (t.includes('start') || t.includes('ng+') || t.includes('max')) return 'starter';
  if (t.includes('trophy') || t.includes('boss')) return 'checkpoint';
  if (t.includes('mod') || t.includes('glitch')) return 'modded';
  if (t.includes('chapter')) return 'chapter';
  return 'other';
}

async function fetchZip(id: number, jar: Jar) {
  let r = await gfetch(`/savedb/${id}/download`, jar);
  if (r.status >= 300 && r.status < 400) {
    const loc = r.headers.get('location') || '';
    if (/login/i.test(loc)) throw new Error('Garlic session expired');
    r = await gfetch(loc, jar);
  }
  if (!r.ok) throw new Error(`Garlic download ${r.status}`);
  const name = r.headers.get('content-disposition')?.match(/filename="?([^";]+)/)?.[1] || `garlic_${id}.zip`;
  return { r, name: name.replace(/[^\w.\- ]/g, '_').slice(0, 120) };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  try {
    if (req.method !== 'POST') return json({ error: 'POST JSON only' }, 405);
    const body = await req.json().catch(() => ({}));
    const action = typeof body.action === 'string' ? body.action : 'list';
    if (action === 'sync') {
      const want = Deno.env.get('XENO_SYNC_TOKEN') || '';
      if (want && req.headers.get('x-xeno-sync-token') !== want) return json({ error: 'sync token missing or wrong' }, 403);
    }
    const jar = await session();
    if (action === 'debug') {
      const r = await gfetch(`/savedb${body.q ? `?q=${encodeURIComponent(String(body.q))}` : ''}`, jar);
      const t = await r.text();
      const from = Math.max(0, Number(body.from) || 0);
      const n = Math.min(20000, Math.max(1, Number(body.n) || 6000));
      return json({ login: (jar as any).__login, status: r.status, len: t.length, sample: t.slice(from, from + n) });
    }
    if (action === 'download') {
      const id = Number(body.id);
      if (!Number.isInteger(id) || id <= 0) return json({ error: 'bad id' }, 400);
      const { r, name } = await fetchZip(id, jar);
      const headers: Record<string, string> = { ...corsHeaders, 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="${name}"`, 'Access-Control-Expose-Headers': 'Content-Disposition, Content-Length' };
      const len = r.headers.get('content-length');
      if (len) headers['Content-Length'] = len;
      return new Response(r.body, { headers });
    }
    if (action === 'sync') {
      const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
      const list: GarlicSave[] = [];
      for (let page = 1; page <= 50; page++) {
        const r = await gfetch(`/savedb?q=&page=${page}`, jar); const t = await r.text();
        if (page === 1 && isLogin(r, t)) return json({ error: 'Garlic session expired' }, 502);
        const items = parse(t).filter(i => !list.some(a => a.id === i.id));
        if (!items.length) break; list.push(...items);
      }
      const ps5 = list.filter(s => s.platform === 'ps5' && TITLE_RE.test(s.titleId));
      const { data: have } = await db.from('ps5_save_collection').select('garlic_id').not('garlic_id', 'is', null);
      const known = new Set((have || []).map((h: any) => h.garlic_id));
      const fresh = ps5.filter(s => !known.has(s.id));
      if (fresh.length) {
        const ins = await db.from('ps5_save_collection').insert(fresh.map(s => ({
          garlic_id: s.id, title_id: s.titleId, game: s.title.slice(0, 120), shared_by: s.by.slice(0, 60),
          notes: s.description.slice(0, 300) || null, file_path: `garlic:${s.id}`, file_name: `${s.titleId}.zip`,
          category: inferCategory(s.description), status: 'published', source: 'garlic',
        })));
        if (ins.error) return json({ error: ins.error.message }, 500);
      }
      // fill covers for a few saves per run (icon0.png inside the zip)
      const covers = Math.min(20, Math.max(0, Number(body.covers ?? 3)));
      const { data: noCover } = await db.from('ps5_save_collection').select('id,garlic_id,title_id').not('garlic_id', 'is', null).is('cover_path', null).is('file_size', null).limit(covers);
      let covered = 0;
      for (const row of noCover || []) {
        try {
          const { r, name } = await fetchZip(row.garlic_id, jar);
          const declared = Number(r.headers.get('content-length') || 0);
          if (declared > MAX_COVER_ZIP) { await r.body?.cancel(); await db.from('ps5_save_collection').update({ file_size: declared, file_name: name }).eq('id', row.id); continue; }
          const buf = new Uint8Array(await r.arrayBuffer());
          let cover: string | null = null;
          try {
            const zip = await JSZip.loadAsync(buf);
            const e = Object.values(zip.files).find((f: any) => !f.dir && /(^|\/)icon0\.png$/i.test(f.name)) as any;
            if (e) {
              const path = `${row.title_id}/garlic-${row.garlic_id}-cover.png`;
              const up = await db.storage.from(BUCKET).upload(path, await e.async('uint8array'), { contentType: 'image/png', upsert: true });
              if (!up.error) { cover = path; covered++; }
            }
          } catch { /* not a readable zip */ }
          await db.from('ps5_save_collection').update({ cover_path: cover, file_size: buf.length, file_name: name }).eq('id', row.id);
        } catch (e: any) { if (/expired/.test(e.message)) break; }
      }
      return json({ total: list.length, ps5: ps5.length, added: fresh.length, covered, remainingCovers: Math.max(0, (noCover?.length || 0) - covered) });
    }
    // list (all pages)
    const all: GarlicSave[] = [];
    for (let page = 1; page <= 20; page++) {
      const r = await gfetch(`/savedb?page=${page}${body.q ? `&q=${encodeURIComponent(String(body.q))}` : ''}`, jar);
      const t = await r.text();
      const items = parse(t);
      const fresh = items.filter(i => !all.some(a => a.id && a.id === i.id));
      if (!fresh.length) break;
      all.push(...fresh);
    }
    return json({ results: all.filter(s => s.platform === 'ps5' && TITLE_RE.test(s.titleId)) });
  } catch (e: any) {
    return json({ error: e.message }, 500);
  }
});
