import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import pg from 'pg';
import yauzl from 'yauzl';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { goodSaveZip, makeZip, patchZipName, tmpDir } from '../helpers.js';

const TEST_DB = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@127.0.0.1:5433/xsa_test';
const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');

let dbReachable = false;
try {
  const c = new pg.Client({ connectionString: TEST_DB });
  await c.connect();
  await c.end();
  dbReachable = true;
} catch {
  dbReachable = false;
}

describe.runIf(dbReachable)('end-to-end pipeline (local HTTP server → worker → storage → API)', () => {
  let server: http.Server;
  let base = '';
  const hits: Record<string, number> = {};
  const rangesSeen: string[] = [];
  const files: Record<string, Buffer> = {};
  let app: any;
  let api: any;
  let dir: string;
  let mods: any;

  beforeAll(async () => {
    dir = tmpDir('xsa-int-');
    files.good = await goodSaveZip('Bloodborne', 'CUSA00207', 'A');
    files.flaky = await goodSaveZip('Bloodborne', 'CUSA00207', 'B');
    files.drop = await goodSaveZip('Elden Ring', 'CUSA18617', 'C');
    files.evil = patchZipName(await makeZip([{ name: 'aa/evil.txt', data: 'x' }]), 'aa/evil.txt', '../evil.txt');
    files.exe = await makeZip([{ name: 'save/userdata0000', data: Buffer.concat([Buffer.from('MZ'), Buffer.alloc(100)]) }]);
    const pwSrc = path.join(dir, 'pw.txt');
    fs.writeFileSync(pwSrc, 'secret');
    execFileSync('7z', ['a', '-tzip', '-pSECRET', path.join(dir, 'pw.zip'), pwSrc], { stdio: 'ignore' });
    files.pw = fs.readFileSync(path.join(dir, 'pw.zip'));

    server = http.createServer((req, res) => {
      const name = req.url!.replace(/^\//, '').replace(/\?.*$/, '');
      hits[name] = (hits[name] ?? 0) + 1;
      if (req.headers.range) rangesSeen.push(`${name}:${req.headers.range}`);
      const send = (buf: Buffer) => {
        res.writeHead(200, { 'content-type': 'application/zip', 'content-length': buf.length, 'accept-ranges': 'bytes' });
        res.end(buf);
      };
      switch (name) {
        case 'good.zip':
        case 'dup-copy.zip':
          return send(files.good);
        case 'flaky.zip':
          if (hits[name] === 1) {
            res.writeHead(503, { 'retry-after': '0' });
            return res.end('busy');
          }
          return send(files.flaky);
        case 'drop.zip': {
          const buf = files.drop;
          const m = /bytes=(\d+)-/.exec(req.headers.range ?? '');
          if (m) {
            const start = Number(m[1]);
            res.writeHead(206, { 'content-type': 'application/zip', 'content-length': buf.length - start, 'content-range': `bytes ${start}-${buf.length - 1}/${buf.length}` });
            return res.end(buf.subarray(start));
          }
          res.writeHead(200, { 'content-type': 'application/zip', 'content-length': buf.length, 'accept-ranges': 'bytes' });
          res.write(buf.subarray(0, Math.floor(buf.length / 2)), () => setTimeout(() => res.socket?.destroy(), 50));
          return;
        }
        case 'gone.zip':
          res.writeHead(404);
          return res.end();
        case 'login.zip':
          res.writeHead(200, { 'content-type': 'text/html' });
          return res.end('<html><form>Please log in to download</form></html>');
        case 'evil.zip':
          return send(files.evil);
        case 'exe.zip':
          return send(files.exe);
        case 'pw.zip':
          return send(files.pw);
        case 'huge.zip':
          res.writeHead(200, { 'content-type': 'application/zip', 'content-length': 50 * 1024 * 1024 });
          return res.end();
        case 'pending.zip':
          return send(files.good);
        default:
          res.writeHead(404);
          res.end();
      }
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    // fresh schema
    const c = new pg.Client({ connectionString: TEST_DB });
    await c.connect();
    await c.query('drop schema public cascade; create schema public;');
    await c.end();

    Object.assign(process.env, {
      DATABASE_URL: TEST_DB,
      STORAGE_DRIVER: 'local',
      DATA_DIR: dir,
      ALLOW_PRIVATE_NETWORK: 'true',
      WORKER_POLL_MS: '100',
      SCHEDULER_ENABLED: 'false',
      MAX_DOWNLOAD_BYTES: String(5 * 1024 * 1024),
      SERVE_UNSCANNED_FILES: 'true',
      ADMIN_TOKEN: 'test-admin-token-123',
      SIGNING_SECRET: 'test-signing-secret',
      PUBLIC_BASE_URL: 'http://archive.test',
      LOG_LEVEL: 'warn',
    });
    mods = {
      app: await import('../../src/app.js'),
      migrate: await import('../../src/db/migrate.js'),
      runner: await import('../../src/sources/runner.js'),
      worker: await import('../../src/worker/worker.js'),
      queue: await import('../../src/worker/queue.js'),
      server: await import('../../src/api/server.js'),
      robots: await import('../../src/net/robots.js'),
      log: await import('../../src/log.js'),
      exp: await import('../../src/export/export.js'),
    };
    app = mods.app.createApp();
    await mods.migrate.migrate(app.db);
    await app.db.query(`update settings set value = '1' where key = 'global_concurrency'`);

    const listA = path.join(dir, 'permitted.json');
    fs.writeFileSync(
      listA,
      JSON.stringify([
        { id: 'good', page_url: 'https://forum.example/t/1', download_url: `${base}/good.zip`, game: 'Bloodborne', title_id: 'CUSA00207', description: 'Platinum save, NG+2', author: 'Alice' },
        { id: 'dup-copy', page_url: 'https://forum.example/t/2', download_url: `${base}/dup-copy.zip`, game: 'Bloodborne', description: 'same file re-uploaded' },
        { id: 'flaky', download_url: `${base}/flaky.zip`, game: 'Bloodborne', description: '100% completion' },
        { id: 'drop', download_url: `${base}/drop.zip`, game: 'Elden Ring', title_id: 'CUSA18617' },
        { id: 'gone', download_url: `${base}/gone.zip` },
        { id: 'login', download_url: `${base}/login.zip` },
        { id: 'evil', download_url: `${base}/evil.zip` },
        { id: 'exe', download_url: `${base}/exe.zip` },
        { id: 'pw', download_url: `${base}/pw.zip` },
        { id: 'huge', download_url: `${base}/huge.zip` },
      ]),
    );
    const listB = path.join(dir, 'mirror2.json');
    fs.writeFileSync(listB, JSON.stringify([{ id: 'same-link', page_url: 'https://other-site.example/p/9', download_url: `${base}/good.zip`, game: 'Bloodborne', author: 'Alice (reposted)' }]));
    const listC = path.join(dir, 'pending.json');
    fs.writeFileSync(listC, JSON.stringify([{ id: 'pending', download_url: `${base}/pending.zip`, game: 'Something' }]));
    const ins = `insert into sources (id, name, kind, policy, permission_evidence, enabled, config) values ($1,$2,'link-list',$3,$4,true,$5)`;
    await app.db.query(ins, ['permitted', 'Permitted list', 'MIRROR_ALLOWED', 'test fixture: owner-generated files', JSON.stringify({ file: listA })]);
    await app.db.query(ins, ['mirror2', 'Second site', 'MIRROR_ALLOWED', 'test fixture: owner-generated files', JSON.stringify({ file: listB })]);
    await app.db.query(ins, ['needs-permission', 'No permission yet', 'PERMISSION_REQUIRED', null, JSON.stringify({ file: listC })]);

    api = await mods.server.buildServer(app);
  }, 120_000);

  afterAll(async () => {
    await api?.close();
    await app?.close();
    server?.close();
  });

  const status = async (key: string) => (await app.db.query(`select * from save_records where source_item_key = $1`, [key])).rows[0];

  it('discovers items and gates them by permission', async () => {
    const ctx = { cfg: app.cfg, http: app.http, robots: new mods.robots.RobotsCache(app.http), log: mods.log.log };
    const a = await mods.runner.runDiscovery(app.db, ctx, 'permitted');
    expect(a).toMatchObject({ seen: 10, inserted: 10, queued: 10 });
    await mods.runner.runDiscovery(app.db, ctx, 'mirror2');
    const c = await mods.runner.runDiscovery(app.db, ctx, 'needs-permission');
    expect(c).toMatchObject({ seen: 1, permissionPending: 1, queued: 0 });
    const again = await mods.runner.runDiscovery(app.db, ctx, 'permitted');
    expect(again).toMatchObject({ seen: 10, inserted: 0, updated: 10 });
  });

  it('downloads, retries, resumes, verifies, quarantines and deduplicates', async () => {
    for (let i = 0; i < 40; i++) {
      const w = new mods.worker.Worker({ db: app.db, cfg: app.cfg, storage: app.storage, http: app.http, hostCtx: app.hostCtx });
      await w.run({ once: true });
      const left = await app.db.query(`select count(*)::int n from save_records where status in ('QUEUED','DOWNLOADING','VERIFYING')`);
      if (left.rows[0].n === 0) break;
      await new Promise((r) => setTimeout(r, 300));
    }
    const good = await status('good');
    expect(good.status).toBe('STORED');
    expect(good.blob_sha256).toBe(sha(files.good));
    expect(good.verified).toBe(false); // malware scanner has no signature DB here → honest "not verified"
    expect(good.title_id).toBe('CUSA00207');
    expect(good.original_author).toBe('Alice');
    expect(good.category).toBe('Platinum');

    const sameLink = await status('same-link');
    expect(sameLink.status).toBe('STORED');
    expect(sameLink.blob_sha256).toBe(good.blob_sha256);
    expect(hits['good.zip']).toBe(1); // second source reused the stored file — no second download

    const dup = await status('dup-copy');
    expect(dup.status).toBe('STORED');
    expect(dup.blob_sha256).toBe(good.blob_sha256);
    expect(dup.status_reason).toMatch(/deduplicated/);

    const flaky = await status('flaky');
    expect(flaky.status).toBe('STORED');
    expect(flaky.attempts).toBe(2);

    const drop = await status('drop');
    expect(drop.status).toBe('STORED');
    expect(drop.blob_sha256).toBe(sha(files.drop));
    expect(rangesSeen.some((r) => r.startsWith('drop.zip:bytes='))).toBe(true);
    const ev = await app.db.query(`select message from job_events where record_id = $1 and event = 'downloaded'`, [drop.id]);
    expect(ev.rows.some((r: any) => r.message.includes('(resumed)'))).toBe(true);

    expect((await status('gone')).status).toBe('FAILED');
    expect((await status('gone')).status_reason).toMatch(/dead link/);
    expect((await status('login')).status).toBe('RESTRICTED');
    expect((await status('pw')).status).toBe('RESTRICTED');
    expect((await status('pw')).status_reason).toMatch(/password/);
    expect((await status('huge')).status).toBe('FAILED');
    expect((await status('huge')).status_reason).toMatch(/limit/);

    const evil = await status('evil');
    expect(evil.status).toBe('QUARANTINED');
    const evilBlob = (await app.db.query('select storage_key, quarantined from blobs where sha256 = $1', [evil.blob_sha256])).rows[0];
    expect(evilBlob).toMatchObject({ quarantined: true });
    expect(evilBlob.storage_key).toMatch(/^quarantine\//);
    expect((await status('exe')).status).toBe('QUARANTINED');

    expect((await status('pending')).status).toBe('PERMISSION_PENDING');
    expect(hits['pending.zip']).toBeUndefined(); // never fetched without permission

    // every STORED record has a physical object of the right size and hash
    const stored = (await app.db.query(`select b.storage_key, b.size_bytes, b.sha256 from save_records r join blobs b on b.sha256 = r.blob_sha256 where r.status = 'STORED'`)).rows;
    for (const s of stored) {
      const buf = fs.readFileSync(path.join(app.cfg.storage.localDir, s.storage_key));
      expect(buf.length).toBe(Number(s.size_bytes));
      expect(sha(buf)).toBe(s.sha256);
    }
    // no temp files left behind
    expect(fs.readdirSync(app.cfg.workDir).length).toBe(0);
  }, 120_000);

  it('serves only authorized stored files through the API with short-lived signed links', async () => {
    const list = (await api.inject({ url: '/api/saves?page_size=100' })).json();
    expect(list.total).toBe(5); // good, same-link, dup-copy, flaky, drop
    expect(list.results.every((r: any) => r.redistribution.status === 'granted')).toBe(true);
    const goodRec = await status('good');
    const one = (await api.inject({ url: `/api/saves/${goodRec.id}` })).json();
    expect(one).toMatchObject({ game: 'Bloodborne', title_id: 'CUSA00207', platform: 'PS4', sha256: sha(files.good), original_author: 'Alice' });
    expect(one.credits.length).toBe(3); // three sources credited for the same file
    expect(one.verification.malware_scan).toBe('not_run');
    expect(one.archive.param_sfo.MAINTITLE).toBe('Bloodborne');
    expect(one.archive.param_sfo).not.toHaveProperty('ACCOUNT_ID');

    expect((await api.inject({ url: `/api/saves/${(await status('evil')).id}` })).statusCode).toBe(404);
    expect((await api.inject({ url: `/api/saves/${(await status('pending')).id}` })).statusCode).toBe(404);
    expect((await api.inject({ url: `/api/saves/${goodRec.id}/download` })).statusCode).toBe(401);

    const key = (await api.inject({ method: 'POST', url: '/admin/api/api-keys', headers: { authorization: 'Bearer test-admin-token-123' }, payload: { name: 'xenosaves-backend' } })).json().key;
    expect(key).toMatch(/^xsa_/);
    const dl = (await api.inject({ url: `/api/saves/${goodRec.id}/download`, headers: { 'x-api-key': key } })).json();
    expect(dl.sha256).toBe(sha(files.good));
    expect(dl.url).toMatch(/^http:\/\/archive\.test\/files\//);
    const tokenPath = new URL(dl.url).pathname;
    const fileRes = await api.inject({ url: tokenPath });
    expect(fileRes.statusCode).toBe(200);
    expect(fileRes.headers['content-disposition']).toMatch(/CUSA00207_Bloodborne/);
    expect(sha(fileRes.rawPayload)).toBe(sha(files.good));
    expect((await api.inject({ url: tokenPath.slice(0, -3) + 'abc' })).statusCode).toBe(403);
    const games = (await api.inject({ url: '/api/games' })).json();
    expect(games.results.map((g: any) => g.title_id)).toEqual(expect.arrayContaining(['CUSA00207', 'CUSA18617']));
    const st = (await api.inject({ url: '/api/stats' })).json();
    expect(st).toMatchObject({ saves_available: 5, unique_files: 3 });
  });

  it('admin API requires the token and reports dedup savings', async () => {
    expect((await api.inject({ url: '/admin/api/overview' })).statusCode).toBe(401);
    expect((await api.inject({ url: '/admin/api/overview', headers: { authorization: 'Bearer wrong' } })).statusCode).toBe(401);
    const o = (await api.inject({ url: '/admin/api/overview', headers: { authorization: 'Bearer test-admin-token-123' } })).json();
    expect(o.stats.duplicate_records).toBe(2);
    expect(Number(o.stats.dedup_saved_bytes)).toBe(2 * files.good.length);
    expect(o.stats.permission_pending).toBe(1);
    const dups = (await api.inject({ url: '/admin/api/duplicates', headers: { authorization: 'Bearer test-admin-token-123' } })).json();
    expect(dups.exact[0].records).toBe(3);
  });

  it('exports chunked, checksum-verified ZIPs with a virtual layout, and resumes', async () => {
    const out = path.join(dir, 'export');
    const m1 = await mods.exp.runExport(app.db, app.storage, { outDir: out, filter: { platform: 'PS4' }, chunkBytes: 1 });
    expect(m1.total_files).toBe(3); // 3 unique files across 2 game folders (dups collapse per folder)
    expect(m1.chunks.length).toBe(3);
    const names: string[] = [];
    for (const ch of m1.chunks) {
      const zf: any = await new Promise((res, rej) => yauzl.open(path.join(out, `${ch.name}.zip`), { lazyEntries: true }, (e, z) => (e ? rej(e) : res(z))));
      await new Promise<void>((res) => {
        zf.on('entry', (e: any) => {
          names.push(e.fileName);
          zf.readEntry();
        });
        zf.on('end', res);
        zf.readEntry();
      });
    }
    expect(names.some((n) => /^PS4\/CUSA00207-Bloodborne\/Platinum-save-NG-2-\d+\.zip$/.test(n))).toBe(true);
    expect(names).toContain('PS4/CUSA18617-Elden-Ring/metadata.json');
    const catalog = JSON.parse(fs.readFileSync(path.join(out, 'catalog.json'), 'utf8'));
    expect(catalog.length).toBe(5);
    expect(fs.readFileSync(path.join(out, 'catalog.csv'), 'utf8').split('\n')[0]).toMatch(/^id,platform,title_id,game/);
    const logs: string[] = [];
    await mods.exp.runExport(app.db, app.storage, { outDir: out, filter: { platform: 'PS4' }, chunkBytes: 1 }, (l: string) => logs.push(l));
    expect(logs.every((l) => l.startsWith('skip'))).toBe(true);
  });

  it('takedown removes the record and deletes the object once unreferenced', async () => {
    const auth = { authorization: 'Bearer test-admin-token-123' };
    const flaky = await status('flaky');
    const r = (await api.inject({ method: 'POST', url: `/admin/api/records/${flaky.id}/remove`, headers: auth, payload: { reason: 'takedown request #1' } })).json();
    expect(r).toMatchObject({ ok: true, object_deleted: true });
    expect(fs.existsSync(path.join(app.cfg.storage.localDir, 'blobs/sha256', flaky.blob_sha256.slice(0, 2), flaky.blob_sha256.slice(2, 4), flaky.blob_sha256))).toBe(false);
    const good = await status('good');
    const r2 = (await api.inject({ method: 'POST', url: `/admin/api/records/${good.id}/remove`, headers: auth, payload: { reason: 'one credit removed' } })).json();
    expect(r2.object_deleted).toBe(false); // other sources still reference the same file
    const audit = (await api.inject({ url: '/admin/api/audit', headers: auth })).json();
    expect(audit.some((a: any) => a.action === 'record.remove')).toBe(true);
  });

  it('owner permission grant queues a pending item; policy upgrade needs evidence', async () => {
    const auth = { authorization: 'Bearer test-admin-token-123' };
    const bad = await api.inject({ method: 'POST', url: '/admin/api/sources/needs-permission', headers: auth, payload: { policy: 'MIRROR_ALLOWED' } });
    expect(bad.statusCode).toBe(400);
    const pending = await status('pending');
    expect((await api.inject({ method: 'POST', url: `/admin/api/records/${pending.id}/permission`, headers: auth, payload: { decision: 'grant' } })).statusCode).toBe(400);
    const ok = await api.inject({ method: 'POST', url: `/admin/api/records/${pending.id}/permission`, headers: auth, payload: { decision: 'grant', basis: 'Uploader confirmed by email on 2026-11-06' } });
    expect(ok.statusCode).toBe(200);
    expect((await status('pending')).status).toBe('QUEUED');
  });

  it('recovers work from a crashed worker (expired lease)', async () => {
    const gone = await status('gone');
    await app.db.query(`update save_records set status='DOWNLOADING', lease_owner='dead-worker', lease_expires_at = now() - interval '1 minute' where id = $1`, [gone.id]);
    const n = await mods.queue.recoverExpiredLeases(app.db);
    expect(n).toBe(1);
    expect((await status('gone')).status).toBe('QUEUED');
  });
});
