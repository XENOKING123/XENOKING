# XENO STORE · Save Data Store backend (Supabase)

The community save database behind **Library → Community Saves** and the
**Saves (n)** tab on every PS5 game page (SPEC §17.22.8). It is the owner's
Garlic mirror, ported to XENO naming and extended with the Save Data Store
columns, the download counter, moderation and a server-side submission check.

Consoles never see a Garlic cookie or a service key: they talk to the project
with the **public anon key** only, and row-level security decides what that
key may do (read everything, insert *pending* rows, upload into the bucket).

```
backend/supabase/
├── migrations/
│   ├── 0000_ps5_save_collection.sql        table, grants, RLS, storage policies (as provided)
│   ├── 0001_ps5_save_cover.sql             cover_path
│   ├── 0002_ps5_collection_garlic_source.sql garlic_id (unique)
│   ├── 0003_garlic_sync_cron.sql           optional: every-6-hours Garlic sync (pg_cron + pg_net)
│   └── 0004_xeno_save_store.sql            XENO columns, increment_downloads(id), indexes, bucket, moderation RLS
├── functions/
│   ├── _shared/zipdir.ts                   zip central-directory reader (no full download)
│   ├── garlic-savedb/index.ts              list / download / sync / debug against garlicsaves.com
│   └── xeno-save-submit/index.ts           validates a submission and inserts it with the service role
├── config/saves-backend.example.json       what goes into updates/saves-backend.json
└── README.md
```

## What the schema looks like after 0004

`public.ps5_save_collection`

| column | type | notes |
|---|---|---|
| `id` | uuid | primary key |
| `title_id` | text | `PPSA#####` only (CHECK) — PS4 CUSA saves are refused |
| `game` | text 1–120 | game name |
| `shared_by` | text 1–60 | nickname typed by the uploader (never a PSN id) |
| `notes` | text ≤ 300 | description |
| `file_path` | text, unique | `PPSA12345/<uuid>-<name>.zip` in the bucket, or `garlic:<id>` |
| `file_name` | text | download name |
| `file_size` | bigint ≤ 2 GiB | |
| `cover_path` | text | `PPSA12345/<uuid>-cover.png` (icon0.png from the zip) |
| `garlic_id` | integer, unique | set on mirrored Garlic rows |
| `category` | text | `starter` · `platinum` · `checkpoint` · `modded` · `chapter` · `other` |
| `game_version` | text | `01.004.000` style (what the console compares against the installed version) |
| `region` | text | `EUR`, `USA`, `JPN`, `ASIA`, … |
| `tags` | text[] ≤ 10 | free chips |
| `downloads` | integer | bumped by `increment_downloads(id)` |
| `status` | text | `pending` · `published` · `rejected` — **consoles list `published` only** |
| `source` | text | `xeno` (console upload) · `garlic` (mirror) · `manual` (owner) |
| `sha256` | text | 64 hex, verified by the console after download |
| `created_at` | timestamptz | |

Indexes: `(title_id, created_at desc)`, `(status, created_at desc)`, unique `file_path`.

RPC: `select increment_downloads('<uuid>')` → new count (published rows only,
`SECURITY DEFINER`, callable with the anon key).

## Deploy (in order)

You need the Supabase CLI (`npm i -g supabase` or the release binary), a
project, and its ref + anon key (Project Settings → API).

### 1. Link the project

```sh
cd xeno-store/backend/supabase
supabase login
supabase link --project-ref YOUR-PROJECT-REF
```

### 2. Run the migrations

Either paste each file into the SQL editor (Dashboard → SQL) in order
`0000 → 0001 → 0002 → 0004`, or run them with psql:

```sh
for f in migrations/0000_*.sql migrations/0001_*.sql migrations/0002_*.sql migrations/0004_*.sql; do
  psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f "$f"
done
```

`0004` is idempotent and also creates the private `ps5-saves` bucket with a
2 GiB object limit (if you created the bucket by hand already, it only updates
the limit). Skip `0003` unless you want the Garlic mirror (step 5).

### 3. Set the secrets

```sh
# Garlic mirror (only if you run garlic-savedb): cookie values from a logged-in browser
supabase secrets set GARLIC_SAVEDB_SESSION='<session cookie>' GARLIC_SAVEDB_CF='<cf_clearance cookie>'
# optional fallback login (Cloudflare often blocks it; cookies are the reliable path)
supabase secrets set GARLIC_USERNAME='<user>' GARLIC_PASSWORD='<pass>'
# optional: protect the sync action from strangers
supabase secrets set XENO_SYNC_TOKEN="$(openssl rand -hex 24)"
# optional: publish console uploads without review (default: they wait as 'pending')
supabase secrets set XENO_AUTO_PUBLISH=1
```

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are injected by the platform;
never put the service key anywhere a console or a browser can read it.

To refresh the Garlic cookies: sign in at garlicsaves.com, DevTools →
Application → Cookies → garlicsaves.com, copy `session` and `cf_clearance`,
set them again. They expire after days to weeks; when they do, Garlic
downloads and the sync fail until fresh values are set (consoles keep working
with the rows already mirrored and with XENO uploads).

### 4. Deploy the functions

```sh
supabase functions deploy xeno-save-submit --no-verify-jwt
supabase functions deploy garlic-savedb --no-verify-jwt     # only with the Garlic mirror
```

`--no-verify-jwt` lets consoles call them with the anon key (the functions
check their own inputs; the Garlic secrets never leave the function).

Quick test:

```sh
curl -sS -X POST "https://YOUR-PROJECT-REF.supabase.co/functions/v1/xeno-save-submit" \
  -H "apikey: YOUR-ANON-KEY" -H "Authorization: Bearer YOUR-ANON-KEY" -H "Content-Type: application/json" \
  -d '{"title_id":"PPSA00000"}'
# → {"ok":false,"errors":["game is required (1–120 characters)", ...]}
```

### 5. Schedule the Garlic sync (optional)

Enable the `pg_cron` and `pg_net` extensions (Database → Extensions), edit
`migrations/0003_garlic_sync_cron.sql` (project ref, anon key, sync token) and
run it. The job POSTs `{"action":"sync","covers":6}` every 6 hours; known
`garlic_id`s are skipped so runs are cheap. Run it once by hand to seed:

```sh
curl -sS -X POST "https://YOUR-PROJECT-REF.supabase.co/functions/v1/garlic-savedb" \
  -H "apikey: YOUR-ANON-KEY" -H "Authorization: Bearer YOUR-ANON-KEY" \
  -H "x-xeno-sync-token: YOUR-SYNC-TOKEN" -H "Content-Type: application/json" \
  -d '{"action":"sync","covers":6}'
# → {"total":..,"ps5":..,"added":..,"covered":..,"remainingCovers":..}
```

### 6. Point the consoles at it

Copy `config/saves-backend.example.json` over
`xeno-store/updates/saves-backend.json` (fill `url` and `anonKey`) and commit:
consoles fetch that file with the catalog. Or type the URL and anon key into
**Settings → Saves → Backend** on one console. Both backends (this database and
the GitHub `updates/saves.json` index) can be active at once; the console merges
them and dedupes by sha256 / garlic id.

## How consoles use it

| step | request |
|---|---|
| list | `GET {url}/rest/v1/ps5_save_collection?select=*&order=created_at.desc&limit=2000` (+ `&title_id=eq.PPSA…`) with `apikey` + `Authorization: Bearer <anon>`; the console keeps `status = 'published'` rows only |
| cover | `POST {url}/storage/v1/object/sign/ps5-saves/<cover_path>` → signed URL (1 h, cached) |
| download (upload row) | signed URL for `file_path` |
| download (Garlic row) | `POST {url}/functions/v1/garlic-savedb {"action":"download","id":<garlic_id>}` → zip stream |
| counter | `POST {url}/rest/v1/rpc/increment_downloads {"id":"<uuid>"}` |
| upload | `POST {url}/storage/v1/object/ps5-saves/<PPSA>/<uuid>-<name>.zip` (`Content-Type: application/zip`), cover `…-cover.png` |
| submit | `POST {url}/functions/v1/xeno-save-submit {…row…}` → `{ok,id,status}` — or a direct `POST /rest/v1/ps5_save_collection` with `status:"pending"`, `source:"xeno"` (RLS enforces exactly that) |

## Moderation

* Console uploads land as `status = 'pending'` (RLS makes anything else fail
  for the anon key). Review them in the Table editor and set `status` to
  `published` or `rejected`; or set `XENO_AUTO_PUBLISH=1` on
  `xeno-save-submit` to trust submissions that pass the server-side check.
* `xeno-save-submit` refuses: non-PPSA ids, missing/oversized fields, objects
  that are not in the bucket, size mismatches, zips without decrypted save
  files, sealed keys (`sealedkey`, `keystone`), raw `sdimg_*` images, raw
  console backups (`xeno-backup.json`) and absolute / parent paths.
  It reads only the zip's central directory (one `Range` request of ≤ 1 MiB).
* Delete a row and its object(s) to remove a save; there is deliberately no
  delete endpoint for consoles.

## Honest limits

* The sha256 is stored as declared by the uploader; it is verified by every
  console after download, not by the edge function (hashing a 2 GiB object in
  a function would time out).
* Garlic rows are metadata mirrors; the zip streams from garlicsaves.com on
  demand through the function and depends on a live Garlic session.
* Re-signing a downloaded save to the user's account happens on the console
  (native mount, Garlic Save Manager, or same-console raw copy) — see
  `docs/SAVES.md`; the backend only stores and serves files.
