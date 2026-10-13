# XENO STORE — HTTP API reference

Base URL: `http://<ps5-ip>:9095` (or `http://xeno.local:9095`). Every endpoint lives under `/api` except the
static routes in §1. This file follows the route tables in `src/api.c` (core, SPEC §6), `src/ext_downloads.c`
(download extensions, §17.5 / §17.13 / §17.14 / §17.16) and `src/ext_console.c` (console features, §17.2 /
§17.6 / §17.16–§17.22); the module name is given with each group so the code can be checked.

**Envelope.** Success → the documented object, always with `"ok": true`. Failure →
`{"ok":false,"error":"<code>","message":"<human text>"}` with a matching status (400 bad request, 401 bad key,
403 forbidden, 404 not found, 409 exists, 413 body too large, 422 cannot do it now, 428 confirm required,
429 busy, 500 io/oom, 502 upstream, 503 feature unavailable on this firmware). Timestamps are Unix seconds,
sizes are bytes. Bodies are JSON (`Content-Type: application/json`), limit 1 MiB. CORS is open
(`Access-Control-Allow-Origin: *`); `OPTIONS` answers preflights.

**Pairing PIN.** When `settings.pairing.pin` is set, every mutating request must carry
`X-XENO-PIN: 1234`; otherwise `401 {"error":"pin_required","pinRequired":true}`.

Routes with `{id}` style parameters are matched by segment; `id` values are the ones returned by the API.

---

## 1. Static routes (`src/server.c`)

| Route | Returns |
|:--|:--|
| `GET /`, `GET /index.html` | The embedded UI (`text/html`, `Cache-Control: no-cache`, ETag = build hash, gzip when accepted). |
| `GET /catalog.json` | The current catalog (embedded or the newer cached copy), gzip when accepted, ETag = revision. |
| `GET /logo.jpg`, `GET /icon.png` | Header badge / 512×512 icon. |
| `GET /manifest.webmanifest` | PWA manifest so phones can "Add to home screen". |
| `GET /i18n/<code>.json` | An embedded locale file. |
| `GET /pkgsrv/<token>` | Range-capable serving of a staged `.pkg` for the etaHEN DPI fallback (loopback only). |

---

## 2. System (`src/api.c`)

### `GET /api/status`

```json
{"ok":true,"app":"XENO STORE","version":"1.0.0","build":"a1b2c3d","platform":"ps5","fw":"11.00",
 "ip":"192.168.1.20","port":9095,"uptime":1234,"downloadsAvailable":true,"transport":"sceHttp",
 "catalog":{"revision":2,"games":1965,"releases":2592,"source":"embedded","updatedAt":1760313600},
 "queue":{"active":1,"queued":2,"paused":0,"failed":0,"done":5,"speed":52428800,"remaining":10737418240,"eta":205,"keepAwake":true},
 "storage":[{"path":"/data","label":"Internal","kind":"internal","free":412316860416,"total":825000000000,"writable":true,"default":true}],
 "update":{"available":false,"latest":"1.0.0","current":"1.0.0","url":"","sha256":"","notes":"","checkedAt":1760313600},
 "featured":{"hero":["ghost-of-yotei-ps5"],"rows":[{"title":{"en":"Staff picks"},"ids":["elden-ring-ps5"]}],"homebrew":["RetroArch_1_19"],"banner":{"text":{"en":"…"},"url":""}},
 "messages":[{"id":"welcome-1.0.0","ts":1760313600,"url":"","texts":{"en":"Welcome…"}}],
 "setup":{"checked":true,"total":8,"failing":1,"at":1760313600},
 "savesEngine":"native","mdns":{"enabled":true,"running":true,"names":["xeno.local","xenostore.local"],"ip":"192.168.1.20","port":9095,"url":"http://xeno.local:9095","error":""},
 "consoleJobs":0,
 "notices":[{"id":"downloads_unavailable","text":"…"}]}
```

`featured`, `messages`, `setup`, `savesEngine`, `mdns` and `consoleJobs` come from `api_status_extra()` in `ext_console.c`. `platform` is `ps5` or `host`; `transport` names the HTTP backend in use.

### `GET /api/log?lines=200` → `{"ok":true,"lines":["…"]}` (ring buffer, max 400).
### `POST /api/system/toast {"text":"Hello"}` → `{"ok":true}` (debug; shows a console notification).
### `POST /api/system/stop` → `{"ok":true,"stopping":true}` — saves the queue, toasts, exits (used before sending a new ELF).
### `GET|POST /api/update/check`

```json
{"ok":true,"current":"1.0.0","latest":"1.0.1","url":"https://github.com/…/xeno-store.elf","sha256":"…","notes":"…","available":true,"checkedAt":1760313600}
```
Reads `settings.updates.feed` (`updates/payloads.json`), falling back to the GitHub release API + `SHA256SUMS`.

### `POST /api/update/apply` → `{"ok":true,"path":"/data/xeno-store/xeno-store.elf","restartRequired":true}` (downloads to `.elf.new`, verifies the sha256, renames). Failure: `502 update_failed` with the reason (no update, hash mismatch, network).

---

## 3. Catalog & links (`src/api.c`)

### `GET /api/catalog/info`
```json
{"ok":true,"revision":2,"generatedAt":"2026-10-13T04:19:46Z","games":1965,"releases":2592,"sources":[{"id":"archive","name":"Archive.org","kind":"direct"}],"embeddedRevision":2,"cachedRevision":0}
```
### `POST /api/catalog/refresh` → `{"ok":true,"updated":true,"revision":3}` (blocking, ≤ 60 s; also refreshes the feeds).
### `GET /api/catalog/search?q=elden&platform=PS5&limit=20` → `{"ok":true,"items":[<game summary>…]}` (server-side search for phones and as a fallback).
### `POST /api/links/check {"urls":["https://…"]}`
```json
{"ok":true,"results":[{"url":"https://…","status":206,"size":156011528192,"acceptRanges":true,"finalUrl":"https://…","ms":184}]}
```
≤ 8 URLs, 10 s each (`HEAD`, then a 1-byte Range `GET`).
### `POST /api/links/resolve {"url":"https://dlpsgame.com/…"}` → `{"ok":true,"links":[{"url":"…","label":"Base game (EUR)","host":"1fichier.com","size":0}]}`. Only allow-listed hosts are fetched (dlpsgame.com, archive.org, raw.githubusercontent.com, github.com, api.github.com, prosperopatches.com, orbispatches.com, vikingfile.com); unknown hosts answer `links:[]`.

### `GET /api/game/best?id=<gameId>&fw=11.00` (`src/ext_downloads.c`, §17.5)
Picks the release to download: same kind → compatible with the console firmware → direct → verified → preferred format → newest → smallest.
```json
{"ok":true,"fw":"11.00","releaseId":"ppsa04029-ffpfsc","release":{…catalog release…},
 "reasons":[{"code":"compat","vars":{"fw":"11.00","requires":"9.00"}},{"code":"verified","vars":{}},{"code":"newest","vars":{"v":"01.003.002"}}],
 "alternatives":["ppsa04029-exfat"],"candidates":3}
```
Reason codes: `compat`, `verified`, `direct`, `hash`, `newest`, `smallest`, `preferred`, `onlyOne`, `pageOnly`. Errors: `not_found`, `no_release`.

### `GET /api/game/enrich?id=<gameId>&refresh=0` (`src/ext_console.c`, §17.2)
```json
{"ok":true,"id":"elden-ring-ps5","cached":true,"fetchedAt":1760313600,"stale":false,"offline":false,"source":"steam",
 "screenshots":["https://…"],"about":"…","developer":"FromSoftware","publisher":"Bandai Namco","metacritic":96,
 "features":["Single-player","Online multiplayer"],"genres":["Action","RPG"],"languages":["English","…"],"releaseDate":"2022-02-25","ageRating":16,"steamId":1245620,"headerImage":"https://…","website":""}
```
Steam `storesearch` + `appdetails`, cached 30 days at `/data/xeno-store/enrich/<gameId>.json`, merged over the catalog. Offline → `{"ok":true,"cached":false,"offline":true,"screenshots":[]}`.

### `GET /api/feeds` / `POST /api/feeds/refresh` (`src/ext_console.c`)
```json
{"ok":true,"featured":{…},"messages":{…},"companions":{…},"savesBackend":{…},"fetchedAt":{"featured":1760313600,"messages":1760313600,"companions":1760313600,"savesBackend":1760313600}}
```
The four owner-curated feeds (`updates/featured.json`, `messages.json`, `companions.json`, `saves-backend.json`), cached at `/data/xeno-store/feeds/`, refreshed every 6 h with the catalog; `null` when never fetched.

---

## 4. Queue (`src/api.c`, `src/dl.c`)

### Job object
```json
{"id":"j_1a2b3c","type":"download","gameId":"cyberpunk-2077-ps5","title":"Cyberpunk 2077","titleId":"PPSA04029","platform":"PS5",
 "cover":"https://…","releaseId":"ppsa04029-ffpfsc","kind":"game","format":"FFPFSC","provider":"Archive.org","sourceId":"archive",
 "url":"https://…","activeUrl":"https://…","mirrors":["https://…"],"mirrorIndex":0,"filename":"PPSA04029 Cyberpunk 2077.ffpfsc",
 "root":"/data","rootLabel":"Internal","path":"/data/homebrew/PPSA04029 Cyberpunk 2077.ffpfsc",
 "state":"downloading","phase":"","message":"","error":"","errorCode":"",
 "total":156011528192,"written":12345678,"speed":52428800,"peakSpeed":61000000,"eta":2740,
 "connections":8,"segmented":true,"activeSegments":8,"window":8,"segments":[[0,16777216,16777216],[16777216,33554432,8000000]],
 "sha256":"","sha256Expected":"","verified":false,"verify":"size",
 "addedAt":1760000000,"startedAt":1760000010,"finishedAt":0,"attempts":1,"nextRetryAt":0,"priority":0,
 "autoInstall":true,"install":{"state":"idle","message":"","contentId":""},
 "resumable":true,"etag":"\"abc\"","lastModified":"","synthetic":false,
 "group":"g_9f8e7d","groupOrder":1,"via":"","viaService":"","viaRequested":"auto",
 "turbo":{"done":true,"picked":"https://…","tested":[{"url":"https://…","ms":120,"mbps":48.2,"status":206,"bytes":1048576}]},
 "scheduledFor":"","startNow":false,"srcPath":"","move":false,
 "extract":{"state":"idle","message":"","dir":"","files":0,"archiveDeleted":false},
 "restResumes":0,"restResuming":false,"speedHistory":[…60 samples when ?history=1…]}
```
States: `queued → connecting → downloading → verifying → done`, side states `paused`, `failed`, `cancelled`, `installing`, `installed`, plus `extracting` / `copying` for the matching job types. `type` is `download`, `copy` (drive transfer), `backup` (saves) or `save-install` / `save-download`. Error codes: `no_space`, `exists`, `bad_release`, `root_unavailable`, `downloads_unavailable`, `source_changed`, `provider_page`, `hash_mismatch`, `drive_missing`, `network`.

### `GET /api/queue?history=1`
```json
{"ok":true,"jobs":[…],"summary":{"active":1,"queued":2,"paused":0,"failed":0,"done":5,"speed":52428800,"remaining":10737418240,"eta":205,"keepAwake":true,"extracting":0,"copying":0,
 "restMode":{"pill":"awake","autoResume":true,"resuming":false,"lastWakeAt":0},
 "schedule":{"configured":true,"open":false,"start":"22:00","end":"07:00","nextStart":1760400000,"waiting":2},
 "groups":[{"id":"g_9f8e7d","gameId":"…","title":"…","total":3,"downloaded":1,"installed":0,"failed":0,"pending":2,"status":"downloading","pausedAt":"","pausedJobId":""}],
 "lifetime":{"totalBytes":2200000000000,"totalJobs":140,"bestSpeed":98000000,"avgSpeed":41000000}}}
```

### `POST /api/queue`
```json
{"gameId":"cyberpunk-2077-ps5","releaseId":"ppsa04029-ffpfsc","root":"/data","connections":8,"verify":"auto","autoInstall":true,"overwrite":false,"via":"auto"}
```
or a raw link: `{"url":"https://…/file.pkg","filename":"file.pkg","format":"PKG","title":"…","gameId":"…","root":"/data"}`.
Checks: release exists, drive writable, free ≥ total + 256 MiB, not already queued, final file absent (or `overwrite`). `via` is `auto`, `direct` or a debrid service id. → `{"ok":true,"job":{…}}`.

### `POST /api/queue/set` (`src/ext_downloads.c`, §17.13 install sets)
```json
{"gameId":"elden-ring-ps5","base":"ppsa05890-pkg","also":{"update":true,"dlc":false,"backport":false},"root":"/data","connections":8,"verify":"auto","autoInstall":true}
```
or an explicit list: `{"gameId":"…","items":["rel-a","rel-b"]}` / `{"items":[{"releaseId":"…","kind":"dlc"}]}`.
Orders the items by `settings.downloads.installOrder`, checks space for the whole set, creates every job with a shared `group` (rolls back on any failure) → `{"ok":true,"group":"g_9f8e7d","jobs":[…]}`.

### `GET /api/downloads/groups` → `{"ok":true,"groups":[…as in summary.groups…]}`.

### `POST /api/queue/{id}/{action}` → `{"ok":true,"job":{…}}`

| action | body | effect |
|:--|:--|:--|
| `pause` / `resume` | — | checkpoints / re-probes validators and continues |
| `cancel` | `{"deleteFiles":false}` | stops, state `cancelled`, keeps the partial unless asked |
| `retry` | — | clears the failure and requeues |
| `restart` | — | discards the partial, from zero |
| `remove` | `{"deleteFiles":false}` | forgets the entry; with `deleteFiles` also deletes partial/final + sidecar (job-owned paths only) |
| `install` | — | starts the PKG install for a `done` package |
| `verify` | — | computes the sha256 in the background, sets `verified` |
| `extract` | — | (re)runs the ZIP extraction of a finished archive |
| `start` | — | "Start now anyway" for a job waiting on the schedule window |
| `url` | `{"url":"https://…"}` | replace the source URL (Enter file link); the partial is kept only when the size matches |
| `move` | `{"direction":"up"\|"down"\|"top"\|"bottom"}` | reorder queued jobs |

### `POST /api/queue/clear {"states":["done","cancelled","failed"]}` → `{"ok":true,"removed":3}` (keeps files).
### `GET /api/queue/{id}/log` → `{"ok":true,"lines":[…]}`.
### `GET /api/space?root=/data&bytes=156011528192` → `{"ok":true,"root":"/data","free":412316860416,"afterQueue":300000000000,"afterThis":144000000000,"fits":true}`.

### `GET /api/stats` / `POST /api/stats/reset` (`src/ext_downloads.c`, §17.5)
```json
{"ok":true,"v":1,"totalBytes":2200000000000,"totalJobs":140,"bestSpeed":98000000,"avgSpeed":41000000,"totalSeconds":53000,
 "byProvider":{"Archive.org":{"bytes":1900000000000,"jobs":120}},"since":1759000000,"updatedAt":1760313600}
```

### `POST /api/library/transfer` (`src/ext_downloads.c`, §17.16 copy/move)
`{"path":"/data/homebrew/X.ffpfsc","toRoot":"/mnt/usb0","move":true,"overwrite":false}` → `{"ok":true,"job":{"type":"copy","srcPath":"…","move":true,…}}`. Errors: `same_drive`, `no_space`, `root_unavailable`, `forbidden` (path not from the last library scan).

### `POST /api/downloads/rest-mode/simulate` — **host build only**: fires the wake-up handler for tests → `{"ok":true,"simulated":true}`.

---

## 5. Debrid (`src/ext_downloads.c`, `src/dlx_debrid.c`, §17.14)

### `GET /api/debrid`
```json
{"ok":true,"preferred":"auto","services":[
 {"id":"realdebrid","name":"Real-Debrid","connected":true,"user":"nick","expires":1765000000,"hostsKnown":312,"hosts":["1fichier.com","mediafire.com"],"hostsUpdatedAt":1760300000,"error":""},
 {"id":"alldebrid","name":"AllDebrid","connected":false,"user":"","expires":0,"hostsKnown":0,"hosts":[],"hostsUpdatedAt":0,"error":""},
 {"id":"torbox","name":"TorBox","connected":false,…},{"id":"premiumize","name":"Premiumize","connected":false,…}]}
```
### `PUT|POST /api/debrid {"service":"realdebrid","apiKey":"…"}` → validates with the service's user endpoint, stores the key, answers like `GET`. Errors: `bad_key` (401), `network` / `service_error` (502), `not_found`.
### `DELETE /api/debrid/{service}` → forgets the key, answers like `GET`.

---

## 6. Storage & Library (`src/api.c`, `src/ext_console.c`)

### `GET /api/storage` → `{"ok":true,"roots":[{"path":"/data","label":"Internal","kind":"internal","free":…,"total":…,"writable":true,"default":true},{"path":"/mnt/usb0","label":"USB 1","kind":"usb",…}]}`.
### `POST /api/storage/default {"root":"/mnt/ext0"}` → `{"ok":true}`.
### `GET /api/library?scan=1`
```json
{"ok":true,"files":[{"path":"/data/homebrew/PPSA04029 Cyberpunk 2077.ffpfsc","name":"…","size":156011528192,"mtime":1760000000,"format":"FFPFSC","root":"/data","titleId":"PPSA04029","gameId":"cyberpunk-2077-ps5","title":"Cyberpunk 2077","cover":"https://…","platform":"PS5","partial":false,"jobId":"j_1a2b3c"}],
 "installed":[{"titleId":"PPSA04029","gameId":"cyberpunk-2077-ps5","title":"Cyberpunk 2077","cover":"https://…","path":"/user/app/PPSA04029"}],"scannedAt":1760313600}
```
### `POST /api/library/delete {"path":"…"}` → `{"ok":true}` (only paths from the last scan).
### `POST /api/library/install {"path":"/data/xeno-store/pkg/x.pkg"}` → `{"ok":true,"job":{…synthetic installing job…}}`.
### `POST /api/shadowmount/scan` → `{"ok":true,"available":true,"status":200}` (`POST http://127.0.0.1:10101/api/v1/scan`).
### `POST /api/library/launch {"titleId":"PPSA04029"}` → `{"ok":true,"titleId":"PPSA04029","launched":true,"simulated":false,"at":1760313600}` (`sceLncUtilLaunchApp` via dlsym; `not_installed` 404).
### `POST /api/library/uninstall {"titleId":"PPSA04029"}` — first call answers `428 {"error":"confirm_required","confirmRequired":true,"token":"…","expiresIn":60,"title":"…"}`; repeat with `{"titleId":"…","token":"…"}` → `{"ok":true,"uninstalled":true,"titleId":"…","message":"…"}` (`sceAppInstUtilAppUnInstall` via dlsym).
### `GET /api/library/usage` (Disk analyzer)
```json
{"ok":true,"roots":[{"path":"/data","label":"Internal","kind":"internal","free":…,"total":…,"used":…,"default":true,
 "categories":{"games":…,"dumps":…,"packages":…,"files":…,"saves":…,"partials":…},"xenoTotal":…}],"scannedAt":1760313600}
```
### `POST /api/library/usage/clean {"root":"/data"}` → `{"ok":true,"removed":[…],"skipped":[…],"removedCount":3,"freed":5368709120}` (orphan `.xpart` files and sidecars only).

---

## 7. Settings, favorites, collections, recent (`src/api.c`, `src/settings.c`)

### `GET /api/settings` → `{"ok":true,"settings":{…SPEC §9 object + Phase 2 fields…}}`
Phase 2 keys: `general.{largeText,highContrast,safeMode,screensaver,screensaverMinutes,controllerSwapConfirm,mdns}`,
`downloads.{preferFormat,turboStart,autoInstallSets,installOrder,scheduleStart,scheduleEnd,restModeAutoResume,extractZip,deleteArchiveAfterExtract}`,
`debrid.{realdebrid:{apiKey},alldebrid:{apiKey},torbox:{apiKey},premiumize:{apiKey},preferred}` (keys are returned masked),
`catalog.{featuredUrl,messagesUrl,companionsUrl,savesBackendUrl}`,
`saves.{backupRoot,autoBackup,indexUrls[],backend:{kind,url,anonKey,bucket,garlicFunction},uploadHost,uploadEndpoint,submitEndpoint,nickname}`,
`browse.presets[{name,filters,sort}]`.
### `PUT /api/settings {"downloads":{"connections":16}}` → deep merge, ranges clamped, atomic save → `{"ok":true,"settings":{…}}`.
### `GET /api/favorites` → `{"ok":true,"ids":[…]}` · `PUT /api/favorites {"ids":[…]}` · `POST /api/favorites/toggle {"id":"…"}` → `{"ok":true,"favorite":true}`.
### `GET /api/collections` → `{"ok":true,"collections":[{"id":"wishlist","name":"Wishlist","icon":"star","ids":[]}]}` · `PUT /api/collections {"collections":[…]}`.
### `GET /api/recent` → `{"ok":true,"ids":[…]}` · `POST /api/recent {"id":"…"}` (keeps 30).
### `GET /api/export` → one JSON with settings, favorites, collections, recent · `POST /api/import {…}` → `{"ok":true,"imported":true}`.
### `GET /api/pair` → `{"ok":true,"url":"http://192.168.1.20:9095/","ip":"192.168.1.20","port":9095,"pinRequired":false}` (the UI renders the QR and shows the `xeno.local` address from `/api/mdns`).
### `GET /api/mdns` → `{"ok":true,"mdns":{"enabled":true,"running":true,"names":["xeno.local","xenostore.local"],"ip":"…","port":9095,"url":"http://xeno.local:9095","error":""}}`. `POST /api/mdns/build` exists in the host build only (packet builder test hook).

---

## 8. Setup, uninstall, ghost icons, companions (`src/ext_console.c`, §17.6 / §17.16)

### `GET|POST /api/setup/check`
```json
{"ok":true,"checks":[
 {"id":"shadowmount","ok":false,"optional":false,"detail":"Nothing answers on 127.0.0.1:10101","fix":"Start ShadowMountPlus …","action":"launch","actionId":"shadowmount-plus"},
 {"id":"dpi","ok":true,"optional":false,"detail":"Package installer daemon answers on 127.0.0.1:9040","fix":""},
 {"id":"etahen","ok":false,"optional":true,"detail":"No etaHEN DPI on 127.0.0.1:12800","fix":"…"},
 {"id":"internet","ok":true,"optional":false,"detail":"raw.githubusercontent.com answered in 184 ms","fix":""},
 {"id":"drive","ok":true,"optional":false,"detail":"Internal (/data) is writable","fix":""},
 {"id":"space","ok":true,"optional":false,"detail":"384 GB free on Internal","fix":""},
 {"id":"firmware","ok":true,"optional":false,"detail":"Firmware 11.00 — FPKG installs work with kstuff / etaHEN","fix":""},
 {"id":"payload-manager","ok":false,"optional":true,"detail":"…","fix":"Add the source URL below …"}],
 "payloadsUrl":"https://raw.githubusercontent.com/XENOKING123/XENOKING/main/xeno-store/updates/payloads.json","fw":"11.00",
 "summary":{"checked":true,"total":8,"failing":2,"at":1760313600}}
```
`action` is `launch` or `install` with `actionId` = a companion id.

### `POST /api/uninstall {"data":true,"homebrew":true,"payloadManager":true,"downloads":false}`
→ `{"ok":true,"removed":["/data/xeno-store","/data/homebrew/XENO-STORE"],"kept":["/data/homebrew"],"failed":[],"removedCount":2,"failedCount":0,"stopping":true}` then the server exits. At least one flag must be true.

### `GET /api/homebrew-dirs` → `{"ok":true,"dirs":[{"name":"XENO-STORE","path":"/data/homebrew/XENO-STORE","title":"XENO STORE","size":5478000,"hasEboot":true,"hasIcon":true,"isXenoStore":true,"mtime":…}],"root":"/data/homebrew","note":"…"}`.
### `POST /api/homebrew-dirs/delete {"name":"OldApp","confirm":"OldApp"}` → `{"ok":true,"deleted":"OldApp"}` (name must be repeated; `confirm_required` 428 otherwise).

### `GET /api/payloads`
```json
{"ok":true,"payloads":[{"id":"shadowmount-plus","name":"ShadowMountPlus","version":"1.03","kind":"shadowmount","url":"https://…","sha256":"…","notes":"…","homepage":"…","size":0,
   "installed":true,"localPath":"/data/xeno-store/payloads/shadowmount-plus.elf","localSize":412000,"installedVersion":"1.03","installedAt":1760300000,"updateAvailable":false}],
 "loaderPort":9021,"loaderAvailable":true,"feedFetchedAt":1760313600,"note":"Payloads are downloaded to the console (sha256 checked) and sent to the local ELF loader on :9021. XENO STORE never loads code in-process."}
```
### `POST /api/payloads/{id}/install` → `{"ok":true,"job":{"id":"cx_…","type":"payload","title":"ShadowMountPlus v1.03","state":"running","done":0,"total":412000,"percent":0,…}}` (download + sha256; a placeholder hash fails with `download_failed`).
### `POST /api/payloads/{id}/launch` → `{"ok":true,"id":"…","bytes":412000,"port":9021,"sent":true}`. Errors: `not_installed` 404, `loader_unavailable` 503.

---

## 9. Saves hub (`src/ext_console.c`, `src/cx_saves.c`, §17.17)

### `GET /api/saves/users` → `{"ok":true,"users":[{"id":268435456,"name":"XENO","foreground":true}]}`.
### `GET /api/saves?user=268435456` → `{"ok":true,"user":268435456,"saves":[{"titleId":"PPSA04029","title":"Cyberpunk 2077","cover":"…","gameId":"…","path":"/user/home/10000000/savedata_prospero/PPSA04029","size":12400000,"mtime":…,"kind":"ps5","dirs":["SAVEDATA00"],"installed":true}],"count":1}`.
### `POST /api/saves/backup {"user":268435456,"titleId":"PPSA04029","kind":"ps5","wait":false}` → `{"ok":true,"job":{"id":"cx_…","type":"backup",…,"result":{"zipPath":"/data/xeno-store/saves/XENO/PPSA04029_ps5_20261013-1200.zip","files":12,"bytes":12400000}}}`. `{"user":…,"all":true}` starts one job per title → `{"ok":true,"jobs":[…],"started":n}`.
### `GET /api/saves/backups` → `{"ok":true,"backups":[{"zipPath":"…","titleId":"…","kind":"ps5","size":…,"createdAt":…,"root":"/data","user":"XENO"}]}`.
### `POST /api/saves/restore {"user":…,"zipPath":"…","overwrite":true}` → `{"ok":true,"titleId":"…","files":12,"bytes":…,"preRestore":"…/PPSA04029_ps5_….pre-restore.zip","tier":"raw"}`.
### `POST /api/saves/transfer {"fromUser":…,"toUser":…,"titleId":"…","kind":"ps5","move":false}` → `{"ok":true,"moved":false,"files":…,"bytes":…,"preBackup":"…","note":"Saves are sealed to this console …"}`.
### `GET /api/saves/jobs` → `{"ok":true,"jobs":[…]}` · `GET /api/saves/jobs/{id}` → `{"ok":true,"job":{…}}` · `POST /api/saves/jobs/{id}/cancel`.
Console job object: `{"id","type":"backup|payload|save-install|save-download|export|upload","title","state":"queued|running|done|failed|cancelled","message","error","errorCode","done","total","percent","createdAt","startedAt","finishedAt","result":{…}}`.
### `GET /api/saves/engine` → `{"ok":true,"tier":"native","detail":"libSceSaveData loaded; mount test ok","native":{"available":true},"garlic":{"available":false,"port":8082},"raw":{"available":true},"simulated":false}` (tier ∈ `native` | `garlic` | `raw`).

---

## 10. Save Data Store (`src/ext_console.c`, `src/cx_savestore.c`, §17.22)

### `GET /api/saves/store?titleId=PPSA04029&category=starter&q=&refresh=0`
```json
{"ok":true,"backend":"github","engine":"native","cached":true,"updatedAt":1760313600,"count":1,
 "sources":[{"kind":"github","url":"https://raw.githubusercontent.com/…/saves.json","rows":40,"ok":true,"cached":true}],
 "saves":[{"id":"sv_1","titleId":"PPSA04029","gameId":"cyberpunk-2077-ps5","title":"Cyberpunk 2077","category":"starter","name":"Chapter 4 — all weapons","description":"…","author":"nick",
   "gameVersion":"01.004.000","region":"EUR","dirName":"SAVEDATA00","size":1234567,"sha256":"…","url":"https://pixeldrain.com/api/file/…","mirror":"","format":"xeno-save-zip","createdAt":"…","downloads":12,"status":"published","tags":["ng+"],"screenshot":"","source":"github","cover":"/api/saves/store/sv_1/cover","needsResign":true,
   "installed":true,"installedVersion":"01.004.000","otherRegion":false,"installedTitleId":"PPSA04029","versionCompare":0,"compat":"ok","compatText":"Matches your 01.004.000"}]}
```
`compat` ∈ `ok` | `older` | `newer` | `not_installed` | `other_region`. Supabase rows add `storagePath` / `garlicId`.
### `POST /api/saves/store/{id}/install {"user":…,"backupFirst":true,"wait":false}` → `{"ok":true,"job":{"type":"save-install",…}}` (download → sha256 → engine import).
### `POST /api/saves/store/{id}/download {"user":…}` → `{"ok":true,"job":{"type":"save-download",…}}` (ZIP only, to `<root>/xeno-store/saves/community/`).
### `GET /api/saves/store/{id}/cover` → `302` to the cover (signed Supabase URL or catalog art).
### `POST /api/saves/export {"user":…,"titleId":"PPSA04029","dirName":"SAVEDATA00"}` → `{"ok":true,"zipPath":"…","size":…,"sha256":"…","tier":"native","accountIdStripped":true,"manifest":{…xeno-save.json…},"shareable":true}`.
### `POST /api/saves/upload {"zipPath":"…","host":"pixeldrain"}` → `{"ok":true,"url":"https://pixeldrain.com/api/file/abc","sha256":"…","size":…,"host":"pixeldrain"}`.
### `POST /api/saves/submit {"titleId":"…","name":"…","category":"starter","description":"…","tags":[…],"nickname":"…","url":"…","sha256":"…","size":…,"gameVersion":"…","region":"…"}` → `{"ok":true,"method":"github-issue","issueUrl":"https://github.com/XENOKING123/XENOKING/issues/new?template=save-submission.md&title=…&body=…","qr":"<svg…>","submission":{…},"note":"…"}` (or `method:"custom"` / `"supabase"`).
### `GET /api/saves/installed-version?titleId=PPSA04029` → `{"ok":true,"titleId":"PPSA04029","installed":true,"version":"01.004.000","source":"appmeta"}`.

---

## 11. Accounts (`src/ext_console.c`, `src/cx_accounts.c`, §17.18)

### `GET /api/accounts`
```json
{"ok":true,"supported":true,"simulated":false,"foregroundUser":268435456,
 "users":[{"id":268435456,"name":"XENO","foreground":true}],
 "slots":[{"slot":1,"name":"XENO","id":"0x1234abcd5678ef90","type":1,"flags":0,"empty":false,"activated":false,"foreground":true,"derivedId":"0x…"}]}
```
### `POST /api/accounts/{slot}/activate {"id":"0x1234abcd5678ef90"}` (id optional; derived from the name when omitted) → `{"ok":true,"slot":1,"id":"0x…","activated":true,"rebootRequired":true,"note":"Reboot the console for the activation to take effect. Back up your saves first."}`. Errors: `registry_unavailable` 503, `activate_failed` 422.
### `POST /api/accounts/{slot}/clear` → `{"ok":true,"slot":1,"activated":false,"rebootRequired":true}`.
### `POST /api/accounts/reboot` → `{"ok":true,"rebooting":true,"simulated":false}` (saves the queue, `sceSystemServiceRequestReboot`).

---

## 12. Homebrew store (`src/ext_console.c`, `src/cx_homebrew.c`, §17.21)

### `GET /api/homebrew?refresh=0&q=retro&category=Emulator`
```json
{"ok":true,"cached":true,"live":false,"fetchedAt":1760313600,"source":"pkg-zone","count":1,"pkgZoneItems":220,"categories":["Emulator","Tool","Game","Media"],
 "items":[{"id":"RetroArch_1_19","title":"RetroArch","version":"1.19","author":"Libretro","supportsPs5":true,"cover":"/api/image?url=https%3A%2F%2Fpkg-zone.com%2Fimages%2FRetroArch_1_19%2Fcover.png",
   "details":"https://pkg-zone.com/details/RetroArch_1_19","downloadPs5":"https://pkg-zone.com/download/ps5/RetroArch_1_19/latest","downloadPs4":"https://pkg-zone.com/download/ps4/RetroArch_1_19/latest",
   "category":"Emulator","installed":{"titleId":"","version":"","installedAt":0}}]}
```
Live listing cached 7 days at `/data/xeno-store/homebrew.json`; falls back to the catalog's `HOMEBREW` entries.
### `POST /api/homebrew/{id}/installed {"titleId":"…","version":"1.19"}` → `{"ok":true,"id":"…"}` (records the installed version for "Update available").
### `GET /api/image?url=https://pkg-zone.com/images/<id>/cover.png` → the image bytes, allow-listed hosts only (404/403 otherwise).

---

## 13. Errors quick reference

| code | meaning |
|:--|:--|
| `bad_request` | missing/invalid field; message says which |
| `pin_required` | pairing PIN set and header missing/wrong |
| `not_found` / `bad_release` / `no_release` / `not_installed` | unknown id / release / title |
| `exists` | file already queued or present (use `overwrite`) |
| `no_space` / `root_unavailable` / `same_drive` | destination problems |
| `downloads_unavailable` | network libraries did not load on this firmware |
| `provider_page` / `source_changed` / `hash_mismatch` / `drive_missing` | job failure reasons (see GUIDE) |
| `bad_key` / `not_connected` / `unsupported_host` / `limit` / `service_error` | debrid |
| `confirm_required` | repeat the call with the `token` / `confirm` value |
| `loader_unavailable` / `engine_unavailable` / `registry_unavailable` | the console feature is missing on this firmware or setup |
| `forbidden` | a path that was not produced by the store (deletes/transfers accept only recorded paths) |
