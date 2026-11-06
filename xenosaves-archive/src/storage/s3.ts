import crypto from 'node:crypto';
import fs from 'node:fs';
import type { Readable } from 'node:stream';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { Config } from '../config.js';
import { withRetries, type ObjectInfo, type ObjectStorage, type PutOptions } from './index.js';

/**
 * S3-compatible object storage. Primary target: Cloudflare R2
 *   S3_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com  S3_REGION=auto
 * The bucket must stay private; clients only ever receive short-lived presigned GET URLs.
 */
export class S3Storage implements ObjectStorage {
  readonly driver = 's3';
  private client: S3Client;
  private bucket: string;
  constructor(private cfg: Config) {
    const s3 = cfg.storage.s3;
    this.bucket = s3.bucket;
    this.client = new S3Client({
      region: s3.region,
      endpoint: s3.endpoint,
      forcePathStyle: s3.forcePathStyle,
      credentials:
        s3.accessKeyId && s3.secretAccessKey
          ? { accessKeyId: s3.accessKeyId, secretAccessKey: s3.secretAccessKey }
          : undefined,
      // R2 and most S3-compatible stores: only send checksums we ask for explicitly.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
  }

  async putFile(key: string, filePath: string, opts: PutOptions): Promise<void> {
    const metadata = { sha256: opts.sha256 };
    const contentType = opts.contentType ?? 'application/octet-stream';
    if (opts.size >= this.cfg.storage.s3.multipartThresholdBytes) {
      // Multipart: lib-storage retries individual parts; we retry the whole upload on failure.
      await withRetries(async () => {
        const upload = new Upload({
          client: this.client,
          params: { Bucket: this.bucket, Key: key, Body: fs.createReadStream(filePath), ContentType: contentType, Metadata: metadata },
          queueSize: 4,
          partSize: 16 * 1024 * 1024,
          leavePartsOnError: false,
        });
        await upload.done();
      });
    } else {
      const checksum = Buffer.from(opts.sha256, 'hex').toString('base64');
      await withRetries(() =>
        this.client.send(
          new PutObjectCommand({
            Bucket: this.bucket,
            Key: key,
            Body: fs.createReadStream(filePath),
            ContentLength: opts.size,
            ContentType: contentType,
            Metadata: metadata,
            // Server verifies the body against this SHA-256 and rejects mismatches.
            ChecksumSHA256: checksum,
          }),
        ),
      );
    }
    const head = await this.head(key);
    if (!head) throw new Error(`object ${key} missing after upload`);
    if (head.size !== opts.size) throw new Error(`object ${key} size mismatch after upload: ${head.size} != ${opts.size}`);
    if (head.metadata?.sha256 && head.metadata.sha256 !== opts.sha256) throw new Error(`object ${key} sha256 metadata mismatch`);
    // Read-back verification: re-hash what the store actually holds (independent of provider checksum support).
    if (opts.size <= this.cfg.storage.s3.verifyMaxBytes) {
      const h = crypto.createHash('sha256');
      for await (const chunk of await this.getStream(key)) h.update(chunk as Buffer);
      const got = h.digest('hex');
      if (got !== opts.sha256) {
        await this.delete(key).catch(() => {});
        throw new Error(`stored object ${key} failed read-back verification: ${got} != ${opts.sha256}`);
      }
    }
  }

  async head(key: string): Promise<ObjectInfo | null> {
    try {
      const r = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return { key, size: Number(r.ContentLength ?? 0), lastModified: r.LastModified, metadata: r.Metadata };
    } catch (err: any) {
      if (err?.$metadata?.httpStatusCode === 404 || err?.name === 'NotFound' || err?.name === 'NoSuchKey') return null;
      throw err;
    }
  }

  async getStream(key: string): Promise<Readable> {
    const r = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    return r.Body as Readable;
  }

  async delete(key: string): Promise<void> {
    await withRetries(() => this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key })));
  }

  async *list(prefix: string): AsyncIterable<ObjectInfo> {
    let token: string | undefined;
    do {
      const r = await this.client.send(
        new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken: token, MaxKeys: 1000 }),
      );
      for (const o of r.Contents ?? []) {
        if (o.Key) yield { key: o.Key, size: Number(o.Size ?? 0), lastModified: o.LastModified };
      }
      token = r.IsTruncated ? r.NextContinuationToken : undefined;
    } while (token);
  }

  async signedDownloadUrl(key: string, opts: { filename: string; ttlSeconds: number }): Promise<string> {
    const safe = opts.filename.replace(/["\\\r\n]/g, '_');
    return getSignedUrl(
      this.client,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ResponseContentDisposition: `attachment; filename="${safe}"`,
        ResponseContentType: 'application/octet-stream',
      }),
      { expiresIn: opts.ttlSeconds },
    );
  }

  /** Ensure the bucket exists (used by local dev against an S3 emulator; R2 buckets are created in the dashboard/IaC). */
  async ensureBucket(): Promise<void> {
    const { CreateBucketCommand, HeadBucketCommand } = await import('@aws-sdk/client-s3');
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
    } catch {
      await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }));
    }
  }
}
