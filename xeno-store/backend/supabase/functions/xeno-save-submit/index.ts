// XENO STORE · Save Data Store · xeno-save-submit edge function.
//
// Validates a community save submission and inserts the row with the service
// role, so the table's RLS can stay strict. Consoles (and the phone companion)
// call it after uploading the zip to the `ps5-saves` bucket:
//
//   POST /functions/v1/xeno-save-submit   (apikey + Authorization: Bearer <anon key>)
//   {
//     "title_id": "PPSA04029", "game": "Cyberpunk 2077", "shared_by": "nick",
//     "notes": "Chapter 4 — all weapons unlocked", "category": "chapter",
//     "game_version": "01.004.000", "region": "EUR", "tags": ["ng+", "max money"],
//     "file_path": "PPSA04029/<uuid>-save.zip", "file_name": "PPSA04029_SAVEDATA00.zip",
//     "file_size": 1234567, "sha256": "<64 hex>", "cover_path": "PPSA04029/<uuid>-cover.png"
//   }
//   → 200 { ok: true, id, status: "pending" | "published" }
//   → 400 { ok: false, errors: [...] }
//
// Checks: PPSA title id, field lengths, size ≤ 2 GiB, the object exists in our
// bucket under its title id with the declared size, and the zip's central
// directory (read with one Range request, never the whole file) contains a
// decrypted save (xeno-save.json manifest or Garlic layout), no sealed keys,
// no raw sdimg_ images, no absolute or parent paths. The sha256 is stored as
// given for consoles to verify after download; hashing a 2 GiB object inside
// an edge function is not attempted.
//
// Secrets: SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (platform), optional
// XENO_AUTO_PUBLISH=1 to publish without review, optional XENO_SAVES_BUCKET.
import { corsHeaders } from 'npm:@supabase/supabase-js@2/cors';
import { createClient } from 'npm:@supabase/supabase-js@2';
import { readZipDirectory, inspectSaveEntries } from '../_shared/zipdir.ts';

const MAX_SIZE = 2 * 1024 * 1024 * 1024;
const TAIL = 1024 * 1024;
const TITLE_RE = /^PPSA\d{5}$/;
const CATEGORIES = ['starter', 'platinum', 'checkpoint', 'modded', 'chapter', 'other'];
const VERSION_RE = /^[0-9]{1,3}(\.[0-9]{1,3}){0,3}$/;
const REGION_RE = /^[A-Z0-9_-]{1,8}$/;
const SHA_RE = /^[0-9a-f]{64}$/;
const PATH_RE = /^(PPSA\d{5})\/[A-Za-z0-9._-]{1,200}\.zip$/;
const COVER_RE = /^(PPSA\d{5})\/[A-Za-z0-9._-]{1,200}\.png$/;
const TAG_RE = /^[a-z0-9][a-z0-9 +._-]{0,23}$/;

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').slice(0, max) : '');

function inferCategory(text: string): string {
  const t = text.toLowerCase();
  if (t.includes('100%') || t.includes('platinum')) return 'platinum';
  if (t.includes('start') || t.includes('ng+') || t.includes('max')) return 'starter';
  if (t.includes('trophy') || t.includes('boss')) return 'checkpoint';
  if (t.includes('mod') || t.includes('glitch')) return 'modded';
  if (t.includes('chapter')) return 'chapter';
  return 'other';
}

interface Row {
  title_id: string; game: string; shared_by: string; notes: string | null; file_path: string; file_name: string;
  file_size: number; cover_path: string | null; category: string; game_version: string | null; region: string | null;
  tags: string[]; sha256: string | null; status: string; source: string;
}

function validate(body: any): { row?: Row; errors: string[] } {
  const errors: string[] = [];
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { errors: ['JSON object required'] };
  const title_id = str(body.title_id || body.titleId, 9).toUpperCase();
  if (!TITLE_RE.test(title_id)) errors.push('title_id must be a PS5 id like PPSA12345 (PS4 CUSA saves are not accepted)');
  const game = str(body.game || body.title, 120);
  if (!game) errors.push('game is required (1–120 characters)');
  const shared_by = str(body.shared_by || body.author || body.nickname, 60);
  if (!shared_by) errors.push('shared_by is required (1–60 characters)');
  const notesRaw = typeof body.notes === 'string' ? body.notes : typeof body.description === 'string' ? body.description : '';
  if (notesRaw.length > 300) errors.push('notes must be 300 characters or less');
  const notes = str(notesRaw, 300) || null;
  const nameHint = str(body.name, 80);
  const file_path = str(body.file_path, 300);
  if (!PATH_RE.test(file_path)) errors.push('file_path must be <PPSA id>/<name>.zip inside the ps5-saves bucket');
  else if (file_path.split('/')[0] !== title_id) errors.push('file_path must start with the same title id as title_id');
  const file_name = str(body.file_name, 160) || file_path.split('/').pop() || `${title_id}.zip`;
  const file_size = Number(body.file_size ?? body.size);
  if (!Number.isInteger(file_size) || file_size <= 0) errors.push('file_size must be a positive integer (bytes)');
  else if (file_size > MAX_SIZE) errors.push('file_size must be 2 GiB or less');
  const cover_path = str(body.cover_path, 300) || null;
  if (cover_path && (!COVER_RE.test(cover_path) || cover_path.split('/')[0] !== title_id)) errors.push('cover_path must be <same PPSA id>/<name>.png');
  let category = str(body.category, 20).toLowerCase();
  if (category && !CATEGORIES.includes(category)) errors.push(`category must be one of ${CATEGORIES.join(', ')}`);
  if (!category) category = inferCategory(`${nameHint} ${notes || ''}`);
  const game_version = str(body.game_version || body.gameVersion, 20) || null;
  if (game_version && !VERSION_RE.test(game_version)) errors.push('game_version must look like 01.004.000');
  const region = str(body.region, 8).toUpperCase() || null;
  if (region && !REGION_RE.test(region)) errors.push('region must be letters/digits only (EUR, USA, JPN, ASIA, ...)');
  const tagsIn = Array.isArray(body.tags) ? body.tags : [];
  const tags = [...new Set(tagsIn.map((t: unknown) => str(t, 24).toLowerCase()).filter((t: string) => TAG_RE.test(t)))].slice(0, 10) as string[];
  const sha256 = str(body.sha256, 64).toLowerCase() || null;
  if (sha256 && !SHA_RE.test(sha256)) errors.push('sha256 must be 64 hex characters');
  if (errors.length) return { errors };
  return { errors, row: { title_id, game, shared_by, notes, file_path, file_name, file_size, cover_path, category, game_version, region, tags, sha256, status: 'pending', source: 'xeno' } };
}

async function objectSize(url: string, key: string, bucket: string, path: string): Promise<number> {
  const r = await fetch(`${url}/storage/v1/object/authenticated/${bucket}/${path.split('/').map(encodeURIComponent).join('/')}`, {
    method: 'HEAD', headers: { apikey: key, Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(20000),
  });
  if (r.status === 404 || r.status === 400) return -1;
  if (!r.ok) throw new Error(`storage answered HTTP ${r.status}`);
  return Number(r.headers.get('content-length') || 0);
}

async function objectTail(url: string, key: string, bucket: string, path: string, size: number): Promise<{ bytes: Uint8Array; start: number }> {
  const start = Math.max(0, size - TAIL);
  const r = await fetch(`${url}/storage/v1/object/authenticated/${bucket}/${path.split('/').map(encodeURIComponent).join('/')}`, {
    headers: { apikey: key, Authorization: `Bearer ${key}`, Range: `bytes=${start}-${size - 1}` }, signal: AbortSignal.timeout(30000),
  });
  if (!r.ok) throw new Error(`storage answered HTTP ${r.status} for the zip tail`);
  const buf = new Uint8Array(await r.arrayBuffer());
  // A server that ignores Range returns the whole object: keep only the tail.
  if (r.status === 200 && buf.length > TAIL) return { bytes: buf.subarray(buf.length - TAIL), start: buf.length - TAIL };
  return { bytes: buf, start: r.status === 200 ? 0 : start };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  if (req.method !== 'POST') return json({ ok: false, errors: ['POST JSON only'] }, 405);
  try {
    const body = await req.json().catch(() => null);
    const { row, errors } = validate(body);
    if (!row) return json({ ok: false, errors }, 400);
    const url = Deno.env.get('SUPABASE_URL')!;
    const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const bucket = Deno.env.get('XENO_SAVES_BUCKET') || 'ps5-saves';
    const size = await objectSize(url, key, bucket, row.file_path);
    if (size < 0) return json({ ok: false, errors: [`${row.file_path} is not in the ${bucket} bucket — upload the zip first`] }, 400);
    if (size > MAX_SIZE) return json({ ok: false, errors: ['the uploaded zip is larger than 2 GiB'] }, 400);
    if (size > 0 && size !== row.file_size) return json({ ok: false, errors: [`file_size ${row.file_size} does not match the uploaded object (${size} bytes)`] }, 400);
    const problems: string[] = [];
    const tail = await objectTail(url, key, bucket, row.file_path, size || row.file_size);
    try {
      const dir = readZipDirectory(tail.bytes, tail.start);
      if (dir.truncated) problems.push('the zip directory is too large to inspect (more than 1 MiB of entries)');
      const look = inspectSaveEntries(dir.entries);
      problems.push(...look.reasons);
    } catch (e: any) {
      problems.push(e.message || 'the file is not a zip');
    }
    if (problems.length) return json({ ok: false, errors: problems }, 400);
    if ((Deno.env.get('XENO_AUTO_PUBLISH') || '') === '1') row.status = 'published';
    const db = createClient(url, key);
    const { data: dup } = await db.from('ps5_save_collection').select('id,status').eq('file_path', row.file_path).limit(1);
    if (dup && dup.length) return json({ ok: true, id: dup[0].id, status: dup[0].status, note: 'already submitted' });
    const ins = await db.from('ps5_save_collection').insert(row).select('id,status').single();
    if (ins.error) return json({ ok: false, errors: [ins.error.message] }, 500);
    return json({ ok: true, id: ins.data.id, status: ins.data.status });
  } catch (e: any) {
    return json({ ok: false, errors: [e.message || 'unexpected error'] }, 500);
  }
});
