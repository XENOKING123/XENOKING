import os from 'node:os';
import path from 'node:path';

function str(name: string, def?: string): string | undefined {
  const v = process.env[name];
  return v === undefined || v === '' ? def : v;
}
function req(name: string): string {
  const v = str(name);
  if (!v) throw new Error(`Missing required environment variable ${name}`);
  return v;
}
function num(name: string, def: number): number {
  const v = str(name);
  if (v === undefined) return def;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`Environment variable ${name} must be a number`);
  return n;
}
function bool(name: string, def: boolean): boolean {
  const v = str(name);
  if (v === undefined) return def;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}

export type StorageDriver = 's3' | 'local';

export interface Config {
  databaseUrl: string;
  storage: {
    driver: StorageDriver;
    s3: {
      endpoint?: string;
      region: string;
      bucket: string;
      accessKeyId?: string;
      secretAccessKey?: string;
      forcePathStyle: boolean;
      multipartThresholdBytes: number;
      verifyMaxBytes: number;
    };
    localDir: string;
  };
  workDir: string;
  signingSecret: string;
  signedUrlTtlSeconds: number;
  publicBaseUrl: string;
  port: number;
  host: string;
  adminToken?: string;
  catalogRequiresApiKey: boolean;
  downloadRequiresApiKey: boolean;
  serveUnscannedFiles: boolean;
  limits: {
    maxDownloadBytes: number;
    maxUncompressedBytes: number;
    maxEntries: number;
    maxCompressionRatio: number;
    httpTimeoutMs: number;
    maxRedirects: number;
  };
  clamav: { clamscanPath?: string; clamdHost?: string; clamdPort: number };
  allowPrivateNetwork: boolean;
  userAgent: string;
  githubToken?: string;
  alertWebhookUrl?: string;
  worker: { id: string; leaseSeconds: number; pollMs: number; schedulerEnabled: boolean };
  gitCacheDir: string;
}

export function loadConfig(): Config {
  const dataDir = str('DATA_DIR', path.resolve('data'))!;
  const driver = (str('STORAGE_DRIVER', 'local') as StorageDriver);
  if (driver !== 's3' && driver !== 'local') throw new Error('STORAGE_DRIVER must be "s3" or "local"');
  const signingSecret = str('SIGNING_SECRET');
  if (!signingSecret && process.env.NODE_ENV === 'production') {
    throw new Error('SIGNING_SECRET is required in production');
  }
  return {
    databaseUrl: req('DATABASE_URL'),
    storage: {
      driver,
      s3: {
        endpoint: str('S3_ENDPOINT'),
        region: str('S3_REGION', 'auto')!,
        bucket: str('S3_BUCKET', 'xenosaves-archive')!,
        accessKeyId: str('S3_ACCESS_KEY_ID'),
        secretAccessKey: str('S3_SECRET_ACCESS_KEY'),
        forcePathStyle: bool('S3_FORCE_PATH_STYLE', false),
        multipartThresholdBytes: num('S3_MULTIPART_THRESHOLD_BYTES', 64 * 1024 * 1024),
        verifyMaxBytes: num('S3_VERIFY_MAX_BYTES', 64 * 1024 * 1024),
      },
      localDir: str('LOCAL_STORAGE_DIR', path.join(dataDir, 'objects'))!,
    },
    workDir: str('WORK_DIR', path.join(dataDir, 'work'))!,
    signingSecret: signingSecret ?? 'dev-only-insecure-signing-secret',
    signedUrlTtlSeconds: num('SIGNED_URL_TTL_SECONDS', 300),
    publicBaseUrl: str('PUBLIC_BASE_URL', `http://localhost:${num('PORT', 8787)}`)!,
    port: num('PORT', 8787),
    host: str('HOST', '0.0.0.0')!,
    adminToken: str('ADMIN_TOKEN'),
    catalogRequiresApiKey: bool('CATALOG_REQUIRES_API_KEY', false),
    downloadRequiresApiKey: bool('DOWNLOAD_REQUIRES_API_KEY', true),
    serveUnscannedFiles: bool('SERVE_UNSCANNED_FILES', false),
    limits: {
      maxDownloadBytes: num('MAX_DOWNLOAD_BYTES', 2 * 1024 ** 3),
      maxUncompressedBytes: num('MAX_UNCOMPRESSED_BYTES', 8 * 1024 ** 3),
      maxEntries: num('MAX_ARCHIVE_ENTRIES', 50_000),
      maxCompressionRatio: num('MAX_COMPRESSION_RATIO', 1000),
      httpTimeoutMs: num('HTTP_TIMEOUT_MS', 60_000),
      maxRedirects: num('MAX_REDIRECTS', 5),
    },
    clamav: {
      clamscanPath: str('CLAMSCAN_PATH'),
      clamdHost: str('CLAMD_HOST'),
      clamdPort: num('CLAMD_PORT', 3310),
    },
    allowPrivateNetwork: bool('ALLOW_PRIVATE_NETWORK', false),
    userAgent: str(
      'CRAWLER_USER_AGENT',
      `XenoSavesArchiveBot/0.1 (+${str('CRAWLER_CONTACT_URL', 'https://github.com/XENOKING123')})`,
    )!,
    githubToken: str('GITHUB_TOKEN'),
    alertWebhookUrl: str('ALERT_WEBHOOK_URL'),
    worker: {
      id: str('WORKER_ID', `${os.hostname()}-${process.pid}`)!,
      leaseSeconds: num('WORKER_LEASE_SECONDS', 300),
      pollMs: num('WORKER_POLL_MS', 2000),
      schedulerEnabled: bool('SCHEDULER_ENABLED', true),
    },
    gitCacheDir: str('GIT_CACHE_DIR', path.join(dataDir, 'git-cache'))!,
  };
}
