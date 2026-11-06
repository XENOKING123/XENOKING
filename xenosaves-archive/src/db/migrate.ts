import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Db } from './pool.js';

function migrationsDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const candidate of [path.join(here, '..', 'migrations'), path.join(here, '..', '..', 'migrations')]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error('migrations directory not found');
}

export async function migrate(db: Db): Promise<string[]> {
  const dir = migrationsDir();
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  const client = await db.connect();
  const applied: string[] = [];
  try {
    // Serialize concurrent migrators (api + worker starting together).
    await client.query('select pg_advisory_lock(727001)');
    await client.query(
      'create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())',
    );
    const done = new Set((await client.query('select name from schema_migrations')).rows.map((r) => r.name));
    for (const f of files) {
      if (done.has(f)) continue;
      const sql = fs.readFileSync(path.join(dir, f), 'utf8');
      await client.query('begin');
      try {
        await client.query(sql);
        await client.query('insert into schema_migrations (name) values ($1)', [f]);
        await client.query('commit');
        applied.push(f);
      } catch (err) {
        await client.query('rollback');
        throw new Error(`migration ${f} failed: ${(err as Error).message}`);
      }
    }
  } finally {
    await client.query('select pg_advisory_unlock(727001)').catch(() => {});
    client.release();
  }
  return applied;
}
