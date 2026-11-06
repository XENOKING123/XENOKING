import type { Db, Tx } from '../db/pool.js';
import { log } from '../log.js';

/** JSON for Postgres jsonb: strips NUL characters (jsonb rejects \u0000) anywhere in keys or strings. */
export function pgJson(v: unknown): string {
  return JSON.stringify(v, function (this: any, _k, val) {
    if (typeof val === 'string') return val.replace(/\u0000/g, '');
    if (val && typeof val === 'object' && !Array.isArray(val) && Object.keys(val).some((k) => k.includes('\u0000'))) {
      return Object.fromEntries(Object.entries(val).map(([k, x]) => [k.replace(/\u0000/g, ''), x]));
    }
    return val;
  });
}

export interface EventInput {
  recordId?: number | null;
  sourceId?: string | null;
  level?: 'debug' | 'info' | 'warn' | 'error';
  event: string;
  message?: string;
  details?: unknown;
}

/** Durable per-record download log (also mirrored to structured stdout logs). */
export async function event(db: Db | Tx, e: EventInput): Promise<void> {
  const level = e.level ?? 'info';
  log[level === 'debug' ? 'debug' : level]({ record: e.recordId, source: e.sourceId, event: e.event }, e.message ?? e.event);
  await db.query(
    'insert into job_events (record_id, source_id, level, event, message, details) values ($1,$2,$3,$4,$5,$6)',
    [e.recordId ?? null, e.sourceId ?? null, level, e.event, e.message?.replace(/\u0000/g, '').slice(0, 4000) ?? null, e.details === undefined ? null : pgJson(e.details)],
  );
}

export async function audit(db: Db | Tx, actor: string, action: string, target: string | null, details?: unknown): Promise<void> {
  log.info({ actor, action, target }, 'audit');
  await db.query('insert into audit_log (actor, action, target, details) values ($1,$2,$3,$4)', [
    actor,
    action,
    target,
    details === undefined ? null : pgJson(details),
  ]);
}
