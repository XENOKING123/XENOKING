import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import type { App } from '../app.js';
import { verifyLocalToken } from '../storage/local.js';
import { friendlySaveName, slug } from '../export/naming.js';
import { adminTokenOk, extractKey, lookupApiKey, RateLimiter, sha256Hex } from './auth.js';
import { registerAdminRoutes } from './admin.js';
import { getSave, listGames, searchSaves, stats } from './queries.js';

function dashboardDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.join(here, 'dashboard');
}

export function downloadFilename(save: { title_id: string | null; game: string | null; original_filename: string | null; file_format: string | null; id: number; category?: string | null; description?: string | null }): string {
  return [save.title_id, slug(save.game, 60), friendlySaveName(save)].filter(Boolean).join('_');
}

export async function buildServer(app: App): Promise<FastifyInstance> {
  const { cfg, db, storage } = app;
  const server = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? 'info', redact: ['req.headers.authorization', 'req.headers["x-api-key"]'] },
    trustProxy: process.env.TRUST_PROXY === 'true',
    bodyLimit: 1024 * 1024,
    maxParamLength: 2048, // signed file tokens are long
  });
  const ipLimiter = new RateLimiter(240, 4); // ~240 req/min burst per IP
  const downloadLimiter = new RateLimiter(60, 0.5); // 60 burst, 30/min sustained per key/IP

  server.addHook('onRequest', async (req, reply) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'no-referrer');
    reply.header('x-frame-options', 'DENY');
    if (req.url.startsWith('/api/') && !ipLimiter.take(`ip:${req.ip}`)) {
      return reply.code(429).header('retry-after', '15').send({ error: 'rate_limited' });
    }
  });

  const requireCatalogKey = async (req: FastifyRequest, reply: FastifyReply) => {
    if (!cfg.catalogRequiresApiKey) return;
    const key = await lookupApiKey(db, extractKey(req.headers as any));
    if (!key || !key.scopes.includes('catalog')) return reply.code(401).send({ error: 'api_key_required' });
  };

  server.get('/healthz', async () => ({ ok: true }));
  server.get('/readyz', async (_req, reply) => {
    try {
      await db.query('select 1');
      const w = await db.query(`select count(*)::int as n from workers where last_seen > now() - interval '2 minutes' and not coalesce((info->>'stopped')::boolean, false)`);
      return { ok: true, db: 'ok', storage: storage.driver, live_workers: w.rows[0].n };
    } catch (err) {
      return reply.code(503).send({ ok: false, error: (err as Error).message });
    }
  });

  server.get('/api/stats', { preHandler: requireCatalogKey }, async () => {
    const s = await stats(db);
    return {
      saves_available: s.stored_records,
      unique_files: s.unique_files,
      stored_bytes: Number(s.stored_bytes),
      sources: s.sources,
      discovered_total: s.total_records,
      permission_pending: s.permission_pending,
    };
  });

  server.get('/api/games', { preHandler: requireCatalogKey }, async (req) => listGames(db, cfg.serveUnscannedFiles, req.query as any));
  server.get('/api/saves', { preHandler: requireCatalogKey }, async (req) => searchSaves(db, cfg.serveUnscannedFiles, req.query as any));

  server.get('/api/saves/:id', { preHandler: requireCatalogKey }, async (req, reply) => {
    const id = Number((req.params as any).id);
    if (!Number.isSafeInteger(id) || id <= 0) return reply.code(400).send({ error: 'bad_id' });
    const save = await getSave(db, cfg.serveUnscannedFiles, id);
    if (!save) return reply.code(404).send({ error: 'not_found' });
    const { storage_key: _k, ...pub } = save;
    return pub;
  });

  /**
   * Issues a short-lived signed URL for an authorized, stored archive.
   * Requires an API key (held server-side by XenoSaves) unless DOWNLOAD_REQUIRES_API_KEY=false.
   */
  server.get('/api/saves/:id/download', async (req, reply) => {
    const id = Number((req.params as any).id);
    if (!Number.isSafeInteger(id) || id <= 0) return reply.code(400).send({ error: 'bad_id' });
    const presented = extractKey(req.headers as any);
    const key = await lookupApiKey(db, presented);
    if (cfg.downloadRequiresApiKey && (!key || !key.scopes.includes('download'))) {
      return reply.code(401).send({ error: 'api_key_required' });
    }
    if (!downloadLimiter.take(key ? `key:${key.id}` : `ip:${req.ip}`)) {
      return reply.code(429).header('retry-after', '30').send({ error: 'rate_limited' });
    }
    const save = await getSave(db, cfg.serveUnscannedFiles, id);
    if (!save) return reply.code(404).send({ error: 'not_found' });
    const filename = downloadFilename(save);
    const ttl = cfg.signedUrlTtlSeconds;
    const url = await storage.signedDownloadUrl(save.storage_key, { filename, ttlSeconds: ttl });
    await db.query('insert into downloads (record_id, api_key_id, ip_hash) values ($1,$2,$3)', [id, key?.id ?? null, sha256Hex(`${req.ip}|${cfg.signingSecret}`)]);
    const body = { id, url, expires_at: new Date(Date.now() + ttl * 1000).toISOString(), filename, sha256: save.sha256, size: save.file_size };
    if ((req.query as any).redirect === '1') return reply.redirect(url, 302);
    return body;
  });

  // Local storage driver only: serve HMAC-signed, expiring file tokens.
  server.get('/files/:token', async (req, reply) => {
    if (storage.driver !== 'local') return reply.code(404).send({ error: 'not_found' });
    const v = verifyLocalToken(cfg.signingSecret, (req.params as any).token);
    if (!v) return reply.code(403).send({ error: 'invalid_or_expired_link' });
    const head = await storage.head(v.key);
    if (!head) return reply.code(404).send({ error: 'not_found' });
    reply.header('content-type', 'application/octet-stream');
    reply.header('content-length', String(head.size));
    reply.header('content-disposition', `attachment; filename="${v.filename.replace(/["\\\r\n]/g, '_')}"`);
    reply.header('cache-control', 'private, no-store');
    return reply.send(await storage.getStream(v.key));
  });

  // Admin dashboard (static) + admin API (bearer ADMIN_TOKEN)
  server.get('/admin', async (_req, reply) => {
    reply.header('content-type', 'text/html; charset=utf-8');
    reply.header('content-security-policy', "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'");
    return reply.send(fs.createReadStream(path.join(dashboardDir(), 'index.html')));
  });
  server.get('/admin/app.js', async (_req, reply) => {
    reply.header('content-type', 'application/javascript; charset=utf-8');
    return reply.send(fs.createReadStream(path.join(dashboardDir(), 'app.js')));
  });

  await server.register(async (admin) => {
    admin.addHook('onRequest', async (req, reply) => {
      if (!cfg.adminToken) return reply.code(503).send({ error: 'ADMIN_TOKEN not configured' });
      const auth = req.headers.authorization;
      const presented = typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7) : null;
      if (!ipLimiter.take(`admin:${req.ip}`)) return reply.code(429).send({ error: 'rate_limited' });
      if (!adminTokenOk(cfg.adminToken, presented)) return reply.code(401).send({ error: 'unauthorized' });
    });
    registerAdminRoutes(admin, app);
  }, { prefix: '/admin/api' });

  return server;
}
