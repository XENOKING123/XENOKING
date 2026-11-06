# Deploying the XenoSaves Archive server

Everything below runs on **your** server. Nothing is deployed or made public by this repository on its own.

## 1. Server

A small VPS is enough — archives live in Cloudflare R2, the server only stages one download at a time per slot.

| | Recommended |
|---|---|
| OS | Ubuntu 24.04 LTS |
| CPU / RAM | 4 vCPU / 8 GB |
| Disk | 80 GB (Postgres + temp downloads; set `MAX_DOWNLOAD_BYTES` below free space / concurrency) |
| Network | unrestricted outbound HTTPS |

```bash
curl -fsSL https://get.docker.com | sh
```

## 2. Cloudflare R2 (private bucket)

1. Cloudflare dashboard → **R2** → *Create bucket* → name `xenosaves-archive` (keep it **private**; do not enable a public r2.dev URL or custom domain).
2. R2 → *Manage API tokens* → *Create API token* → **Object Read & Write**, scoped to that bucket only.
3. Note the **Access Key ID**, **Secret Access Key** and the S3 endpoint `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`.

Capacity: R2 has no fixed bucket size — 500 GB → 1 TB+ needs no change. Set the dashboard's soft/hard limits
(default 450 / 500 GiB) to control spend; the worker stops claiming downloads at the hard limit.

## 3. Configure and start

```bash
git clone <this repository> && cd xenosaves-archive
```

```bash
cp .env.example .env
```

Fill in `.env`: `POSTGRES_PASSWORD`, `S3_*`, and generate `ADMIN_TOKEN` / `SIGNING_SECRET`:

```bash
openssl rand -hex 32
```

```bash
docker compose up -d --build
```

This starts Postgres, ClamAV (`clamd`, which downloads its signature database on first start), runs migrations,
seeds the source registry, then starts the API/dashboard and the download worker. Check:

```bash
docker compose ps
```

```bash
curl -s http://127.0.0.1:8787/readyz
```

## 4. Expose the dashboard/API safely

The API listens on `127.0.0.1:8787` only. Put TLS in front, e.g. Cloudflare Tunnel or Caddy:

```bash
sudo apt install -y caddy
```

`/etc/caddy/Caddyfile`:

```
archive.example.com {
  reverse_proxy 127.0.0.1:8787
}
```

Then open `https://archive.example.com/admin` and sign in with `ADMIN_TOKEN`.

## 5. Load your sources

* **Apollo + licensed GitHub repos** — already enabled; they start downloading immediately.
* **Your scraper exports** (TTG, PlayerSquared, …): copy the export into `imports/thetechgame.json`
  (or `.csv`/`.jsonl`), then in the dashboard: source `thetechgame-import` → **Permission…** →
  `MIRROR_ALLOWED` with the permission evidence → **Enable** → **Discover now**.
  Watch *Sources*, *In progress* and *Activity log*.
* Optional official token from a site: add to the source's `config.auth`
  (`{"header":"Authorization","prefix":"Bearer ","env":"TTG_ARCHIVE_TOKEN","hosts":["www.thetechgame.com"]}`)
  and put `TTG_ARCHIVE_TOKEN=…` in `.env`.

## 6. Scale

* More throughput: raise *Concurrency* in the dashboard (per-host politeness limits still apply), or run more workers:
  `docker compose up -d --scale worker=3` (the Postgres queue is safe for many workers).
* The API is stateless — run more replicas behind the proxy if needed.

## 7. Backups & recovery

* `backup` service writes a nightly `pg_dump` to `./backups` (14 days kept). Copy that folder off-box
  (e.g. `rclone copy ./backups r2:xenosaves-backups`).
* Restore: `pg_restore -h <db> -U xsa -d xsa --clean backups/xsa-<date>.dump`.
* Objects are content-addressed (`blobs/sha256/..`). To mirror the bucket to a second bucket/provider:
  `rclone sync r2:xenosaves-archive backup-remote:xenosaves-archive`.
* Integrity audit: `docker compose run --rm api verify-storage --deep`.
* Orphan cleanup: `docker compose run --rm api gc` (dry-run) then `gc --apply`.

## 8. Export to your PC

```bash
docker compose run --rm -v "$PWD/exports:/exports" api export --out /exports/ps4 --platform PS4 --chunk-gb 2
```

Filters: `--platform`, `--title-id`, `--region`, `--category`, `--source`. Output: chunked ZIPs with the
`PS4/CUSA…-Game/` layout + `metadata.json` per game, `catalog.json`, `catalog.csv` and `export-manifest.json`.
Re-running resumes; every file is SHA-256-verified inside each chunk before it is marked complete.

## 9. Connecting XenoSaves later

Create a key for the XenoSaves **backend** (never ship it in the desktop app):

```bash
docker compose run --rm api api-key xenosaves-backend
```

Endpoints: `GET /api/games`, `GET /api/saves`, `GET /api/saves/{id}`, `GET /api/saves/{id}/download`
(returns a 5-minute signed R2 URL; header `x-api-key`), `GET /api/stats`.
