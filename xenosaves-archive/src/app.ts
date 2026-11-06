import { loadConfig, type Config } from './config.js';
import { createPool, type Db } from './db/pool.js';
import type { HostContext } from './hosts/index.js';
import { HttpClient } from './net/http.js';
import { createStorage, type ObjectStorage } from './storage/index.js';

export interface App {
  cfg: Config;
  db: Db;
  storage: ObjectStorage;
  http: HttpClient;
  hostCtx: HostContext;
  close(): Promise<void>;
}

export function createApp(cfg: Config = loadConfig()): App {
  const db = createPool(cfg.databaseUrl);
  const storage = createStorage(cfg);
  const http = new HttpClient({
    userAgent: cfg.userAgent,
    timeoutMs: cfg.limits.httpTimeoutMs,
    maxRedirects: cfg.limits.maxRedirects,
    allowPrivateNetwork: cfg.allowPrivateNetwork,
  });
  return {
    cfg,
    db,
    storage,
    http,
    hostCtx: { http, googleApiKey: process.env.GOOGLE_API_KEY || undefined },
    async close() {
      await db.end();
    },
  };
}
