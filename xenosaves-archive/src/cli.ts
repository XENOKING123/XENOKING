#!/usr/bin/env node
import { createApp } from './app.js';
import { buildServer } from './api/server.js';
import { newApiKey, sha256Hex } from './api/auth.js';
import { stats } from './api/queries.js';
import { deleteBlobIfOrphaned } from './api/admin.js';
import { migrate } from './db/migrate.js';
import { runExport } from './export/export.js';
import { log } from './log.js';
import { RobotsCache } from './net/robots.js';
import { DEFAULT_SOURCES } from './sources/registry.js';
import { runDiscovery } from './sources/runner.js';
import { S3Storage } from './storage/s3.js';
import { blobKey } from './storage/index.js';
import { Worker } from './worker/worker.js';
import { hashFile } from './worker/pipeline.js';

const HELP = `xsa — XenoSaves Archive server

  migrate                         apply database migrations
  seed-sources                    insert/update the default source registry (policies from docs/SOURCES.md)
  discover <source-id|all>        run discovery now
  work [--once] [--max N]         run the download worker (--once: drain due work then exit)
  serve                           start the API + admin dashboard
  stats                           print collection totals
  report                          print per-source/per-status report (markdown)
  api-key <name>                  create an API key for a client (e.g. the XenoSaves backend)
  export --out DIR [--platform PS4] [--title-id CUSA00207] [--region EU] [--category Platinum]
         [--source ID] [--chunk-gb 2] [--format zip|dir]
                                  chunked, resumable, checksum-verified export
  verify-storage [--deep]         check every blob exists (and with --deep, re-hash it)
  gc [--apply]                    find (and with --apply delete) objects not referenced by the database
  ensure-bucket                   create the S3 bucket if missing (local emulators only; create R2 buckets in Cloudflare)
`;

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  if (!cmd || cmd === 'help' || cmd === '--help') {
    process.stdout.write(HELP);
    return;
  }
  const app = createApp();
  const { db, cfg, storage } = app;
  try {
    switch (cmd) {
      case 'migrate': {
        const applied = await migrate(db);
        console.log(applied.length ? `applied: ${applied.join(', ')}` : 'up to date');
        break;
      }
      case 'seed-sources': {
        for (const s of DEFAULT_SOURCES) {
          await db.query(
            `insert into sources (id, name, kind, homepage, config, policy, license, permission_evidence, enabled, discovery_interval_minutes)
             values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
             on conflict (id) do update set name = excluded.name, kind = excluded.kind, homepage = excluded.homepage, config = excluded.config,
               license = coalesce(sources.license, excluded.license),
               permission_evidence = coalesce(sources.permission_evidence, excluded.permission_evidence), updated_at = now()`,
            [s.id, s.name, s.kind, s.homepage, JSON.stringify(s.config), s.policy, s.license, s.permission_evidence, s.enabled, s.discovery_interval_minutes ?? 1440],
          );
        }
        console.log(`seeded ${DEFAULT_SOURCES.length} sources (existing policies/enabled flags were kept)`);
        break;
      }
      case 'discover': {
        const target = args[0];
        if (!target) throw new Error('usage: discover <source-id|all>');
        const ids =
          target === 'all'
            ? (await db.query(`select id from sources where enabled and policy <> 'BLOCKED' and kind <> 'no-automated-access' order by id`)).rows.map((r) => r.id)
            : [target];
        for (const id of ids) {
          try {
            const s = await runDiscovery(db, { cfg, http: app.http, robots: new RobotsCache(app.http), log }, id);
            console.log(`${id}: ${JSON.stringify(s)}`);
          } catch (err) {
            console.error(`${id}: ${(err as Error).message}`);
            if (target !== 'all') process.exitCode = 1;
          }
        }
        break;
      }
      case 'work': {
        const worker = new Worker({ db, cfg, storage, http: app.http, hostCtx: app.hostCtx });
        const stop = () => {
          log.warn('stopping worker (finishing in-flight downloads)…');
          worker.stop().catch(() => {});
        };
        process.once('SIGINT', stop);
        process.once('SIGTERM', stop);
        await worker.run({ once: args.includes('--once'), maxRecords: flag(args, '--max') ? Number(flag(args, '--max')) : undefined });
        break;
      }
      case 'serve': {
        const server = await buildServer(app);
        await server.listen({ port: cfg.port, host: cfg.host });
        const shutdown = async () => {
          await server.close();
          await app.close();
          process.exit(0);
        };
        process.once('SIGINT', shutdown);
        process.once('SIGTERM', shutdown);
        return; // keep running
      }
      case 'stats': {
        console.log(JSON.stringify(await stats(db), null, 2));
        break;
      }
      case 'report': {
        const s = await stats(db);
        const per = (
          await db.query(`select s.id, s.policy, r.status, count(r.id)::int as n, coalesce(sum(b.size_bytes),0)::bigint as bytes
                            from sources s left join save_records r on r.source_id = s.id left join blobs b on b.sha256 = r.blob_sha256
                           group by s.id, s.policy, r.status order by s.id, r.status`)
        ).rows;
        console.log('| metric | value |\n|---|---|');
        for (const [k, v] of Object.entries(s)) console.log(`| ${k} | ${v} |`);
        console.log('\n| source | policy | status | records | stored bytes |\n|---|---|---|---|---|');
        for (const r of per) console.log(`| ${r.id} | ${r.policy} | ${r.status ?? '—'} | ${r.n} | ${r.bytes} |`);
        break;
      }
      case 'api-key': {
        const name = args[0];
        if (!name) throw new Error('usage: api-key <name>');
        const key = newApiKey();
        await db.query('insert into api_keys (name, key_hash) values ($1,$2)', [name, sha256Hex(key)]);
        console.log(key);
        console.error('Store this key server-side only (never in a desktop/browser build). It is not shown again.');
        break;
      }
      case 'export': {
        const out = flag(args, '--out');
        if (!out) throw new Error('usage: export --out DIR [filters]');
        const manifest = await runExport(
          db,
          storage,
          {
            outDir: out,
            filter: {
              platform: flag(args, '--platform'),
              titleId: flag(args, '--title-id'),
              region: flag(args, '--region'),
              category: flag(args, '--category'),
              source: flag(args, '--source'),
              includeUnpermitted: args.includes('--include-unpermitted'),
            },
            chunkBytes: flag(args, '--chunk-gb') ? Math.round(Number(flag(args, '--chunk-gb')) * 1024 ** 3) : undefined,
            format: (flag(args, '--format') as 'zip' | 'dir') ?? 'zip',
          },
          (m) => console.log(m),
        );
        console.log(`export complete: ${manifest.total_files} files, ${manifest.total_bytes} bytes, ${manifest.chunks.length} chunk(s) → ${out}`);
        break;
      }
      case 'verify-storage': {
        const deep = args.includes('--deep');
        const { rows } = await db.query('select sha256, size_bytes, storage_key from blobs where deleted_at is null');
        let ok = 0;
        const bad: string[] = [];
        const tmpDir = `${cfg.workDir}/verify`;
        const fsp = await import('node:fs/promises');
        const fs = await import('node:fs');
        const { pipeline } = await import('node:stream/promises');
        await fsp.mkdir(tmpDir, { recursive: true });
        for (const b of rows) {
          const head = await storage.head(b.storage_key);
          if (!head || head.size !== Number(b.size_bytes)) {
            bad.push(`${b.sha256} missing or wrong size`);
            continue;
          }
          if (deep) {
            const p = `${tmpDir}/${b.sha256}`;
            await pipeline(await storage.getStream(b.storage_key), fs.createWriteStream(p));
            const h = await hashFile(p);
            await fsp.rm(p, { force: true });
            if (h.sha256 !== b.sha256) {
              bad.push(`${b.sha256} content hash mismatch (${h.sha256})`);
              continue;
            }
          }
          ok++;
        }
        console.log(`verified ${ok}/${rows.length} objects${deep ? ' (deep re-hash)' : ''}`);
        for (const x of bad) console.log(`PROBLEM ${x}`);
        if (bad.length) process.exitCode = 2;
        break;
      }
      case 'gc': {
        const apply = args.includes('--apply');
        const known = new Set((await db.query('select storage_key from blobs where deleted_at is null')).rows.map((r) => r.storage_key));
        const orphans: string[] = [];
        for (const prefix of ['blobs/', 'quarantine/']) {
          for await (const o of storage.list(prefix)) {
            const age = o.lastModified ? Date.now() - o.lastModified.getTime() : Infinity;
            if (!known.has(o.key) && age > 3600_000) orphans.push(o.key);
          }
        }
        // Blobs whose every record was removed
        const unref = (await db.query(`select b.sha256 from blobs b where b.deleted_at is null and not exists (select 1 from save_records r where r.blob_sha256 = b.sha256 and r.status <> 'REMOVED')`)).rows;
        console.log(`orphan objects: ${orphans.length}; unreferenced blobs: ${unref.length}`);
        if (apply) {
          for (const k of orphans) await storage.delete(k);
          for (const u of unref) await deleteBlobIfOrphaned(app, u.sha256);
          console.log('deleted.');
        } else for (const k of orphans.slice(0, 50)) console.log(`  ${k}`);
        break;
      }
      case 'ensure-bucket': {
        if (!(storage instanceof S3Storage)) throw new Error('STORAGE_DRIVER is not s3');
        await storage.ensureBucket();
        console.log(`bucket ${cfg.storage.s3.bucket} ready`);
        break;
      }
      case 'blob-key': {
        console.log(blobKey(args[0]));
        break;
      }
      default:
        process.stdout.write(HELP);
        process.exitCode = 1;
    }
  } finally {
    if (cmd !== 'serve') await app.close();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
