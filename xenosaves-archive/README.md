# XenoSaves Archive

An independent PS4/PS5 save-archive server. It discovers saves on external sites, downloads the actual archives
(ZIP/RAR/7z) wherever downloading **and** redistribution are authorized, verifies them, stores each unique
file once in Cloudflare R2 (or any S3-compatible store), keeps full provenance metadata in its own PostgreSQL
database, and serves them through a secure API with short-lived signed URLs. It has its own owner dashboard.

It is **not** connected to XenoSaves, Lovable or any existing Supabase project. XenoSaves can connect later
through the API.

```
 discovery sources                    file hosts                       verification                  storage / catalog
 ─────────────────                    ──────────                       ────────────                  ─────────────────
 Apollo DB (git)        ─┐            GitHub raw/releases ─┐           size + SHA-256                R2 bucket (private)
 GitHub repos (licence) ─┤  items →   MediaFire          ─┤  bytes →   published-hash check   →      blobs/sha256/ab/cd/<sha>
 link-list imports      ─┤  (post +   MEGA               ─┤            archive safety (no extract)   Postgres: records, blobs,
   (your scrapers,      ─┤   file     Google Drive       ─┤            ClamAV                        events, audit, API keys
    submissions)        ─┤   link)    Dropbox / OneDrive ─┤            dedup (exact + repack)        ── API / dashboard / export
 Internet Archive API   ─┘            direct HTTP(S)     ─┘
```

## What it does

| Area | Implementation |
|---|---|
| Discovery | Modular connectors (`src/sources/`). The discovery source (forum post, repo, dataset) and the file host (MediaFire, MEGA…) are recorded separately. Scheduled per source. |
| Permission gate | Every source has a policy: `MIRROR_ALLOWED` (needs recorded evidence), `PERMISSION_REQUIRED`, `EXTERNAL_ONLY`, `BLOCKED`. Only `QUEUED` + `redistribution = granted` records are ever downloaded or served. Licences are detected automatically for GitHub repos. |
| Download worker | Durable Postgres queue (`FOR UPDATE SKIP LOCKED` + leases; crash-safe), global concurrency + per-host politeness limits, HTTP Range resume, exponential backoff honouring `Retry-After`, dead-link / restricted / too-large classification, duplicate-URL skip. |
| Safety | SSRF guard on every hop (scheme/port/credentials/private-IP checks, connect-time DNS guard against rebinding), manual redirect validation, size caps. Archives are never extracted to disk or executed: ZIPs are stream-decompressed in memory under a byte cap; RAR/7z are listed and integrity-tested with 7-Zip. Path traversal, symlinks, executables (by type and header), password protection, entry-count/size bombs are detected. Suspicious files go to `quarantine/` and are never served. ClamAV via clamd or clamscan. |
| Storage | Content-addressed keys, multipart uploads, server-side SHA-256 checksum on single-part uploads, read-back re-hash after upload, private bucket, presigned 5-minute GETs. |
| Dedup | Exact (SHA-256) — one stored object, every source credited. Repacks (same contents, different archive bytes) are detected with a content fingerprint and reported, never auto-merged. |
| Metadata | Title, platform, CUSA/PPSA, region (only when stated), category (keyword suggestion, labelled as such), verbatim description, author/uploader (with where that came from), source page, original link, original filename, size, SHA-256, download date, verification, redistribution basis. PARAM.SFO is parsed (account IDs dropped) and only fills gaps. |
| API | `GET /api/games`, `/api/saves`, `/api/saves/{id}`, `/api/saves/{id}/download` (API key → signed URL), `/api/stats`, `/healthz`, `/readyz`. |
| Dashboard | `/admin` — totals, storage vs limits, per-source progress, in-progress downloads, worker health, activity log, records browser, permission review, retry, remove/takedown, quarantine re-check, start/pause/safe-stop, concurrency + storage limits, duplicates, catalog CSV. Every owner action is audit-logged. |
| Export | Chunked, resumable ZIP (or folder) export by platform / title / region / category / source with `PS4/CUSA…-Game/` layout, `metadata.json` per game, `catalog.json/.csv`, per-file SHA-256 verification. |

Record statuses: `DISCOVERED → PERMISSION_PENDING | QUEUED → DOWNLOADING → VERIFYING → STORED`, plus
`FAILED`, `RESTRICTED` (access-controlled or external-only — never bypassed), `QUARANTINED`, `REMOVED`.

## Quick start (local)

Requirements: Node 20+, PostgreSQL 14+, git, 7-Zip (`p7zip-full`), optionally ClamAV.

```bash
npm install
```

```bash
export DATABASE_URL=postgres://localhost/xsa STORAGE_DRIVER=local ADMIN_TOKEN=$(openssl rand -hex 16)
```

```bash
npx tsx src/cli.ts migrate && npx tsx src/cli.ts seed-sources
```

```bash
npx tsx src/cli.ts discover apollo-saves
```

```bash
npx tsx src/cli.ts work --once
```

```bash
npx tsx src/cli.ts serve
```

Then open http://localhost:8787/admin. Production deployment (R2, Docker Compose, TLS, backups): **[docs/DEPLOY.md](docs/DEPLOY.md)**.

## CLI

`xsa migrate | seed-sources | discover <id|all> | work [--once] | serve | stats | report | api-key <name> | export … | verify-storage [--deep] | gc [--apply] | ensure-bucket`

## Tests

```bash
npm test
```

Unit tests cover SSRF rules, archive inspection (traversal, symlinks, executables, bombs, encryption, 7z),
metadata extraction, host resolvers, licence detection, permission gating, rate limiting, robots.txt and
signed links. Integration tests run the full pipeline against a real PostgreSQL and a local HTTP server
(retries, resume after a dropped connection, dedup, quarantine, restricted pages, API download, export,
takedown, lease recovery) and the S3 driver against an S3-compatible emulator (set `TEST_DATABASE_URL`,
`S3_TEST_ENDPOINT`; tests skip when those services are absent).

## Documents

* [docs/SOURCES.md](docs/SOURCES.md) — source discovery & permission report (what can be mirrored, the gap to 500 GB)
* [docs/REPORT.md](docs/REPORT.md) — results of the real end-to-end import
* [docs/PERMISSION-REQUESTS.md](docs/PERMISSION-REQUESTS.md) — templates to unlock large sources; importing scraper exports
* [docs/DEPLOY.md](docs/DEPLOY.md) — server, R2, Docker Compose, backups, scaling, export, API keys
