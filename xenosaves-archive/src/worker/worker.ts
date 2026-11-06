import fsp from 'node:fs/promises';
import os from 'node:os';
import type { Config } from '../config.js';
import type { Db } from '../db/pool.js';
import type { HostContext } from '../hosts/index.js';
import { log } from '../log.js';
import type { HttpClient } from '../net/http.js';
import { RobotsCache } from '../net/robots.js';
import { Semaphore } from '../net/ratelimit.js';
import { runDiscovery } from '../sources/runner.js';
import type { ObjectStorage } from '../storage/index.js';
import { event } from './events.js';
import { processRecord } from './pipeline.js';
import { claimRecords, extendLeases, recoverExpiredLeases, releaseLeases } from './queue.js';

export interface WorkerDeps {
  db: Db;
  cfg: Config;
  storage: ObjectStorage;
  http: HttpClient;
  hostCtx: HostContext;
}

async function getSetting<T>(db: Db, key: string, def: T): Promise<T> {
  const r = await db.query('select value from settings where key = $1', [key]);
  return r.rows[0] ? (r.rows[0].value as T) : def;
}

export class Worker {
  private stopping = false;
  private inflight = new Map<number, Promise<unknown>>();
  private sem: Semaphore;
  private processed = 0;
  private startedAt = new Date();
  private lastSchedulerRun = 0;
  private abort = new AbortController();
  private discoveryRunning = new Set<string>();

  constructor(private deps: WorkerDeps) {
    this.sem = new Semaphore(4);
  }

  get id() {
    return this.deps.cfg.worker.id;
  }

  async heartbeat(extra: Record<string, unknown> = {}): Promise<void> {
    const { db, cfg } = this.deps;
    let diskFree: number | null = null;
    try {
      const st = await fsp.statfs(cfg.workDir);
      diskFree = st.bavail * st.bsize;
    } catch {
      diskFree = null;
    }
    const info = {
      inflight: [...this.inflight.keys()],
      processed: this.processed,
      rss_bytes: process.memoryUsage().rss,
      load_avg: os.loadavg(),
      work_dir_free_bytes: diskFree,
      started_at: this.startedAt,
      storage_driver: this.deps.storage.driver,
      ...extra,
    };
    await db.query(
      `insert into workers (id, started_at, last_seen, info) values ($1, $2, now(), $3)
       on conflict (id) do update set last_seen = now(), info = excluded.info`,
      [this.id, this.startedAt, JSON.stringify(info)],
    );
    if (this.inflight.size) await extendLeases(db, this.id, [...this.inflight.keys()], cfg.worker.leaseSeconds);
  }

  /** Main loop. Resolves after stop() once in-flight work drains. */
  async run(opts: { once?: boolean; maxRecords?: number } = {}): Promise<void> {
    const { db, cfg } = this.deps;
    await fsp.mkdir(cfg.workDir, { recursive: true });
    const recovered = await recoverExpiredLeases(db);
    if (recovered) log.warn({ recovered }, 'requeued records from expired leases');
    await this.heartbeat();
    const hb = setInterval(() => this.heartbeat().catch((e) => log.error({ err: e }, 'heartbeat failed')), 15_000);
    try {
      while (!this.stopping) {
        if (cfg.worker.schedulerEnabled && !opts.once) await this.schedulerTick().catch((e) => log.error({ err: e }, 'scheduler tick failed'));
        const state = await getSetting<string>(db, 'collection_state', 'running');
        const concurrency = Number(await getSetting<number>(db, 'global_concurrency', 4)) || 1;
        this.sem.setPermits(Math.max(1, Math.min(64, concurrency)));
        let claimed = 0;
        if (state === 'running' && (await this.storageAllowsMore())) {
          const want = Math.min(this.sem.available, opts.maxRecords != null ? opts.maxRecords - this.processed - this.inflight.size : Infinity);
          if (want > 0) {
            const recs = await claimRecords(db, this.id, want, cfg.worker.leaseSeconds);
            claimed = recs.length;
            for (const rec of recs) {
              const release = await this.sem.acquire();
              const p = processRecord({ ...this.deps, workerId: this.id }, rec, this.abort.signal)
                .catch((e) => log.error({ err: e, record: rec.id }, 'pipeline crashed'))
                .finally(() => {
                  release();
                  this.processed++;
                  this.inflight.delete(rec.id);
                });
              this.inflight.set(rec.id, p);
            }
          }
        }
        if (opts.maxRecords != null && this.processed >= opts.maxRecords) break;
        if (opts.once && claimed === 0 && this.inflight.size === 0) {
          // drain mode: stop when nothing is due now
          const due = await db.query(`select count(*)::int as n from save_records where status='QUEUED' and redistribution='granted' and (next_attempt_at is null or next_attempt_at <= now())`);
          if (due.rows[0].n === 0 || state !== 'running') break;
        }
        if (claimed === 0 || this.sem.available === 0) {
          await Promise.race([new Promise((r) => setTimeout(r, cfg.worker.pollMs)), ...this.inflight.values()]);
        }
      }
      await Promise.allSettled([...this.inflight.values()]);
    } finally {
      clearInterval(hb);
      const released = await releaseLeases(db, this.id).catch(() => 0);
      if (released) log.warn({ released }, 'released leases on shutdown');
      await this.heartbeat({ stopped: true }).catch(() => {});
    }
  }

  /** Stop claiming; give in-flight downloads `graceMs` to finish, then abort them (they resume later). */
  async stop(graceMs = 30_000): Promise<void> {
    this.stopping = true;
    const t = setTimeout(() => this.abort.abort(), graceMs);
    await Promise.allSettled([...this.inflight.values()]);
    clearTimeout(t);
  }

  private async storageAllowsMore(): Promise<boolean> {
    const { db } = this.deps;
    const r = await db.query(
      `select coalesce(sum(size_bytes),0) as used, (select value from settings where key='storage_hard_limit_bytes') as hard from blobs where deleted_at is null`,
    );
    const used = Number(r.rows[0].used);
    const hard = Number(r.rows[0].hard);
    if (hard > 0 && used >= hard) {
      log.warn({ used, hard }, 'storage hard limit reached — not claiming new downloads');
      return false;
    }
    return true;
  }

  /** Every minute: run discovery for enabled sources whose interval elapsed. */
  async schedulerTick(): Promise<void> {
    if (Date.now() - this.lastSchedulerRun < 60_000) return;
    this.lastSchedulerRun = Date.now();
    const { db } = this.deps;
    const { rows } = await db.query(
      `select id from sources where enabled and not paused and policy <> 'BLOCKED' and kind <> 'no-automated-access'
         and (last_discovery_at is null or last_discovery_at < now() - make_interval(mins => discovery_interval_minutes))
         and coalesce(last_discovery_status,'') <> 'running'`,
    );
    for (const { id } of rows) {
      if (this.discoveryRunning.has(id)) continue;
      this.discoveryRunning.add(id);
      runDiscovery(db, { cfg: this.deps.cfg, http: this.deps.http, robots: new RobotsCache(this.deps.http), log }, id)
        .catch((e) => event(db, { sourceId: id, level: 'error', event: 'scheduled-discovery-failed', message: (e as Error).message }).catch(() => {}))
        .finally(() => this.discoveryRunning.delete(id));
    }
  }
}
