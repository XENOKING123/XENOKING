import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { tmpDir } from '../helpers.js';

const ENDPOINT = process.env.S3_TEST_ENDPOINT ?? 'http://127.0.0.1:9000';
let reachable = false;
try {
  const r = await fetch(ENDPOINT, { signal: AbortSignal.timeout(2000) });
  reachable = r.status > 0;
} catch {
  reachable = false;
}

describe.runIf(reachable)('S3/R2 storage driver (against an S3-compatible emulator)', () => {
  it('uploads (single + multipart) with integrity checks, presigns, lists and deletes', async () => {
    Object.assign(process.env, {
      DATABASE_URL: 'postgres://unused',
      STORAGE_DRIVER: 's3',
      S3_ENDPOINT: ENDPOINT,
      S3_REGION: 'us-east-1',
      S3_BUCKET: `xsa-test-${Date.now()}`,
      S3_ACCESS_KEY_ID: 'test',
      S3_SECRET_ACCESS_KEY: 'test',
      S3_FORCE_PATH_STYLE: 'true',
      S3_MULTIPART_THRESHOLD_BYTES: String(6 * 1024 * 1024),
    });
    const { loadConfig } = await import('../../src/config.js');
    const { S3Storage } = await import('../../src/storage/s3.js');
    const { blobKey } = await import('../../src/storage/index.js');
    const s3 = new S3Storage(loadConfig());
    await s3.ensureBucket();
    const dir = tmpDir('xsa-s3-');

    const small = crypto.randomBytes(200_000);
    const smallSha = crypto.createHash('sha256').update(small).digest('hex');
    fs.writeFileSync(path.join(dir, 'small'), small);
    await s3.putFile(blobKey(smallSha), path.join(dir, 'small'), { sha256: smallSha, size: small.length, contentType: 'application/zip' });
    const head = await s3.head(blobKey(smallSha));
    expect(head?.size).toBe(small.length);
    expect(head?.metadata?.sha256).toBe(smallSha);

    // Wrong declared SHA-256 must be rejected by the server-side checksum
    const wrong = 'f'.repeat(64);
    await expect(s3.putFile(blobKey(wrong), path.join(dir, 'small'), { sha256: wrong, size: small.length })).rejects.toThrow();
    expect(await s3.head(blobKey(wrong))).toBeNull();

    // Multipart path
    const big = crypto.randomBytes(20 * 1024 * 1024);
    const bigSha = crypto.createHash('sha256').update(big).digest('hex');
    fs.writeFileSync(path.join(dir, 'big'), big);
    await s3.putFile(blobKey(bigSha), path.join(dir, 'big'), { sha256: bigSha, size: big.length });
    expect((await s3.head(blobKey(bigSha)))?.size).toBe(big.length);

    // Presigned short-lived GET returns the exact bytes with an attachment filename
    const url = await s3.signedDownloadUrl(blobKey(smallSha), { filename: 'CUSA00207_Bloodborne_save.zip', ttlSeconds: 60 });
    expect(url).toMatch(/X-Amz-Expires=60/);
    const res = await fetch(url);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toContain('CUSA00207_Bloodborne_save.zip');
    expect(crypto.createHash('sha256').update(Buffer.from(await res.arrayBuffer())).digest('hex')).toBe(smallSha);
    // Unsigned access is refused (private bucket semantics)
    const unsigned = await fetch(url.split('?')[0]);
    expect([401, 403]).toContain(unsigned.status);

    const keys: string[] = [];
    for await (const o of s3.list('blobs/')) keys.push(o.key);
    expect(keys.sort()).toEqual([blobKey(smallSha), blobKey(bigSha)].sort());
    await s3.delete(blobKey(bigSha));
    expect(await s3.head(blobKey(bigSha))).toBeNull();
  }, 120_000);
});
