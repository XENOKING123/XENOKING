# XENO STORE — User guide

Everything you need to install, use and troubleshoot XENO STORE 1.0 on a PS5.
Features that only work on real hardware are marked **(console only)**; the host build that
runs on a PC exists for tests and simulates them.

Contents: [Requirements](#requirements) · [Install](#install) · [First run](#first-run) · [The screens](#the-screens) ·
[Downloading](#downloading) · [Formats and file locations](#formats-and-file-locations) · [PKG install and install sets](#pkg-install-and-install-sets) ·
[Firmware notes](#firmware-notes) · [Browser sources and Enter file link](#browser-sources-and-enter-file-link) · [Debrid](#debrid-services) ·
[Saves hub](#saves-hub) · [Save Data Store](#save-data-store) · [Accounts](#accounts) · [Homebrew tab](#homebrew-tab) · [Companions](#companion-payloads) ·
[Phone](#phone-companion) · [Updating](#updating) · [Uninstall](#uninstall) · [Troubleshooting](#troubleshooting) · [Hardware test checklist](#hardware-test-checklist)

---

## Requirements

| Need | Notes |
|:--|:--|
| Jailbroken PS5 | Any exploit chain that gives you an ELF loader on port **9021** (etaHEN, ps5-payload-dev `elfldr`, XENO TOOL Payloads). |
| **ShadowMountPlus** (optional) | Mounts exFAT / FFPFSC / FFPKG dumps saved under `<drive>/homebrew/` and shows them on the home screen. XENO STORE talks to its API on `127.0.0.1:10101` after every image download and from the readiness checklist. Without it, image dumps are downloaded but not mounted. |
| **kstuff** (optional) | Kernel patches that let fake packages (FPKG) run and let the save engine mount saves through the native API. Firmware support follows the kstuff project — read its README for your firmware. |
| **etaHEN** (optional) | Provides a DPI package installer on `127.0.0.1:12800` (used as the second install fallback), its own homebrew launcher (reads `XENO-STORE.zip`), and fake-package support on supported firmware. |
| Drive space | The file size + a 256 MB reserve on the chosen drive. PS5 games range from 5 GB to 150 GB. |
| Network | The console must reach the hosts in `catalog/sources.json` and `raw.githubusercontent.com` for catalog sync. Phones must be on the same Wi-Fi as the console to pair. |

---

## Install

### A. Send the ELF (any loader on port 9021)

1. Download `xeno-store-browser.elf` (opens the PS5 browser for you) or `xeno-store.elf` (server only) from the **xeno-store-v1.0.0** release.
2. Send it: **XENO TOOL → Payloads → Send file**, `nc -q0 <ps5-ip> 9021 < xeno-store-browser.elf`, or etaHEN's payload menu.
3. A toast says **XENO STORE ready · http://192.168.x.x:9095**. The browser variant opens that page by itself; otherwise open it in the PS5 browser, or on your phone.
4. If the toast says **XENO STORE already running on :9095**, a copy is already up — just open the address.

### B. Home-screen app (etaHEN / itemzflow)

1. Download `XENO-STORE.zip`.
2. Extract it so the folder is exactly `/data/homebrew/XENO-STORE/` containing `eboot.bin`, `homebrew.json` and `sce_sys/` (XENO TOOL → Files, FTP, or etaHEN's file manager). Every entry in the zip carries mode `0777`, so it runs no matter which tool extracts it.
3. Launch **XENO STORE** from your homebrew launcher. It starts the server and opens the browser.

### C. Payload Manager (auto-start on boot)

Add `https://raw.githubusercontent.com/XENOKING123/XENOKING/main/xeno-store/updates/payloads.json` as a source, pick **XENO STORE** and enable auto-start.
CI writes the sha256 of every release into that file, so the manager verifies the download. Settings → Setup shows the same URL as a QR code.

---

## First run

The welcome sheet has three steps (all skippable, all editable later in Settings):

1. **Sources** — tick the catalog sources you want to see and acknowledge the notice (the sources host the files, XENO STORE does not).
2. **Default drive** — Internal (`/data`), M.2 (`/mnt/ext0`, `/mnt/ext1`) or USB (`/mnt/usb0` … `/mnt/usb7`). Only drives that are mounted and writable are offered.
3. **Readiness checklist** — the same list as Settings → Setup. Every failed check names the fix; some offer a one-tap action (install a companion, launch ShadowMountPlus, open Disk analyzer).

---

## The screens

| Tab | What is there |
|:--|:--|
| **Discover** | Hero spotlight (owner-curated picks first, then the newest art), rails: New on XENO, owner-curated rows, Latest releases, Trending, Verified & fast, Backports, Light downloads (< 10 GB), Massive worlds (> 80 GB), PS4 classics, Critically acclaimed, Your favorites, Continue downloading, Recently viewed, New community saves, Homebrew essentials, Popular genres, Surprise me, All games. |
| **Browse** | Search with ranking (exact → prefix → word → fuzzy) and "Did you mean", quick chips (PS5 · PS4 · Under 20 GB · Verified · New this week · Has updates · Direct only · Backports), facets with live counts (platform, source, format, region, genre, year, size, publisher, verified, updates, DLC, compat, features), presets you can save, 8 sort orders, a virtualized grid with Load more and a pager. |
| **Homebrew** | Apps, emulators and tools from pkg-zone: Essentials, Emulators, Tools, New versions, categories, search; app page with Install, "Installed · Update available". |
| **Library** | Storage bars per drive with a **Disk analyzer** (games, dumps, packages, saves, partials) and *Clean up partials*; installed titles with **Play** and **Uninstall**; files on drives with Install / Delete / Copy or move to another drive / Scan with ShadowMount; **Updates center** (newer updates and backports for what you have); **Saves hub**; **Community Saves**. |
| **Downloads** | Summary strip (speed, remaining, ETA, free space, keep-awake / rest-mode pill, lifetime stats), tabs Active · Queued · Finished · Failed · Cancelled, rows with segment visual and sparkline, install-set groups with "Install set paused at: …", per-state actions, retry countdowns, errors with the fix. |
| **Settings** | General, Accessibility, Downloads, Debrid, Sources, Catalog, Saves, Accounts, Setup, Pair a device, Updates, Notifications, Diagnostics, Uninstall, About. |

Controls are in the README. **Safe mode** (hold **L2** while the store opens, or Settings → General) disables animations, sounds and online enrichment for consoles that struggle.

---

## Downloading

1. Open a game page. Read the **Info panel** (developer, publisher, release date, Metacritic, firmware compat parsed from release names, what is included, sizes by format) and the gallery.
2. Press **Download** (or **Download best**, which picks: works on your firmware → verified direct → newest version → smallest, honouring Settings → Downloads → *Preferred format*).
3. In the **Download options** sheet: pick the release (grouped Game · Backports · Updates · DLC · Pages), **Save to** (free / after queue / after this, fits ✓/✗), **Connections** (1–16), **Verify hash**, **Auto-install** (PKG), **Download using** (Direct / a connected debrid service / Auto), **Speed test** (probes mirrors), and the **Also download** checkboxes that make an install set.
4. **Start download**. The job appears in Downloads; the console stays awake while anything downloads (Settings → Downloads → *Keep console awake*).

What the engine does for you:

* **Segments** — when the server honours `Range`, the file is split into chunks of at least 16 MB that up to 16 connections pull with work-stealing, so a slow connection never stalls the end. The per-host window shrinks on 429/5xx and grows again after 64 MB of clean transfer.
* **Turbo start** — with two or more mirrors the first 1 MB is raced from up to three of them and the fastest becomes primary (`job.turbo` in the API).
* **Resume** — every job keeps a `.xpart.json` sidecar (done ranges, ETag / Last-Modified). After a pause, a crash or a rest-mode wake the validators are re-probed and every segment continues from its checkpoint. A changed file on the server is reported as **source_changed** instead of being appended to.
* **Failover** — 401/403/404/410 on the primary URL tries the next mirror (same format and size), and the job message says which one it switched to.
* **Retries** — 5, 15, 45, 120, 300 s backoff up to 8 attempts, honouring `Retry-After`; a rest-mode sleep/wake never consumes an attempt.
* **Schedule** — Settings → Downloads → *Schedule window* ("22:00"–"07:00"): outside it jobs wait as *Scheduled for 22:00*; **Start now anyway** overrides per job.
* **Bandwidth limit** — Settings → Downloads → *Speed limit* (token bucket shared by all segments).
* **Verification** — sha256 is streamed after the download when the catalog knows the hash; mismatches are kept as `.xpart` for inspection.

---

## Formats and file locations

Data directory **(console)**: `/data/xeno-store/` — `settings.json`, `favorites.json`, `collections.json`, `queue.json`, `recent.json`, `stats.json`,
`catalog.json` + `catalog.meta.json` (refreshed catalog), `feeds/` (featured, messages, companions, saves-backend), `enrich/<gameId>.json`,
`homebrew.json` (pkg-zone cache), `payloads/<id>.elf` + `installed.json`, `icon.png`, `log.txt` (rotated at 2 MB → `log.1.txt`),
`xeno-store.elf` / `xeno-store.elf.new` (self-update staging). Host build: `./xeno-data/`.

Destinations under the chosen drive (`<root>` is `/data`, `/mnt/ext0`, `/mnt/usb0`, …):

| What | Where | Then |
|:--|:--|:--|
| exFAT · FFPFSC · FFPKG · FFPFS images | `<root>/homebrew/<filename>` | ShadowMountPlus scan (once per install set) |
| PKG · FPKG | `<root>/xeno-store/pkg/<filename>` | auto-install (see below) |
| ZIP | `<root>/xeno-store/files/<filename>` | extracted on the console: a folder dump goes to `<root>/homebrew/<name>/`, a single image straight to the image file; the archive is deleted after success (Settings → Downloads → *Extract ZIP* / *Delete archive after extract*) |
| RAR · 7z · anything else | `<root>/xeno-store/files/<filename>` | nothing — no RAR/7z engine on the console; extract with XENO TOOL on a PC and send the result |
| Save backups | `<root>/xeno-store/saves/<userName>/<TITLEID>_<ps5|ps4>_<YYYYMMDD-HHMM>.zip` | restore from Library → Saves hub |
| Community saves (file only) | `<root>/xeno-store/saves/community/<title>/…zip` | reachable from a PC through XENO TOOL / FTP |
| In-progress file | `<final>.xpart` + `<final>.xpart.json` | removed on completion; *Clean up partials* removes orphans |

Paths are built only from the known roots and sanitized names (no `..`, no separators, 200 bytes max); delete actions only touch paths the store recorded itself.
Full schemas: [`FORMATS.md`](FORMATS.md).

---

## PKG install and install sets

**(console only — the host build simulates success after 3 s)**

1. When a `.pkg` / `.fpkg` finishes and **Auto-install** is on, the store reads the package header (`\x7FCNT` or a PS5 fake package `\x7FFIH`), records the content ID, and calls the native installer (`sceAppInstUtilInstallByPackage` with the local path).
2. If the native call is refused, it falls back to the package installer daemon on `127.0.0.1:9040` (XENO TOOL's `ezremote-dpi`, listed in Companions), then to etaHEN's DPI on `127.0.0.1:12800` (served through the store's own `/pkgsrv/<token>` loopback URL).
3. The housekeeping thread polls `/user/app/<TITLEID>` every 2 s for up to 30 minutes, then toasts **✓ <title> installed** and shows a gold **Play** button.
4. Nothing worked → *Install failed* with the hex code and the hint. Press **Install** on the job to retry after fixing the setup (Settings → Setup explains which installer is missing).

**Install sets** (Download options → *Also download*): the game, the latest update, the DLCs and — when your firmware is below the game's requirement — the matching backport are queued as one group. Auto-install waits for the whole group and installs **in order** (`Settings → Downloads → Install order`, default `game,backport,update,dlc`), one package at a time, polling each until it is installed. A failed step pauses the set; Downloads shows *Install set paused at: <step>* with **Retry**. Image dumps in a set trigger a single ShadowMount scan after the last file.

**Backports** are releases rebuilt for a lower firmware. The catalog parses tags like `[BP 9.00]`; the store shows a *Backports* rail and facet, the game page groups them by target firmware, and *Download best* picks one when your console needs it. Library → Updates center lists backports for titles you already have.

---

## Firmware notes

* **PS5 fake packages (FPKG) run only on firmware 11.60 and lower as of October 2026**, with kstuff / etaHEN loaded. On newer firmware the store still downloads everything, installs **homebrew PKGs**, mounts **image dumps through ShadowMountPlus** (follow its firmware notes), backs up saves and browses the catalog — the readiness checklist tells you which parts apply to your console.
* The game page shows **"Works on 13.60"**-style chips parsed from release names; they come from the source's labels, not from testing by us.
* Network libraries (`libSceHttp`, `libSceSsl`, `libSceNet`) are loaded at runtime. If they fail to load you see **Downloads unavailable on this firmware**; browsing and everything local keeps working.
* The store never direct-links anything beyond the five libraries proven to load everywhere, so the ELF itself starts on every firmware the loader supports.

---

## Browser sources and Enter file link

Some releases are **pages** (a site listing mirrors) or **browser** links (a host with a human check). XENO STORE does not bypass CAPTCHAs; it makes the manual step short:

1. On the game page choose the release → **Get links**. Pages from allow-listed hosts (dlpsgame, archive.org, …) are resolved server-side into direct links you can start right away.
2. Otherwise **Open on PS5 browser** (or scan the **Share to phone** QR to open the page on your phone). Finish the check, copy the direct file link.
3. Back in the store: **Enter file link**, paste the URL, confirm the filename and format. From a phone this is one tap: open the store on the phone (Settings → Pair a device), the dialog is the same.
4. Password-protected archives show the password with a **Copy** button (`DLPSGAME.COM`, `SuperPSX`, …).

A download that receives a web page instead of a file stops with **provider_page** and the same instructions.

---

## Debrid services

Settings → **Debrid** connects a premium service with **your own API key**. Keys are stored only in `/data/xeno-store/settings.json`, shown masked, and are sent only to that service.

| Service | Where to get the key | What the store calls |
|:--|:--|:--|
| **Real-Debrid** | real-debrid.com → My account → API token | `POST /rest/1.0/unrestrict/link` (Bearer token); host list from `/hosts/domains` |
| **AllDebrid** | alldebrid.com → API keys (agent name `xeno-store`) | `GET /v4/link/unlock?agent=xeno-store&apikey=…&link=…`; host list from `/v4/hosts` |
| **TorBox** | torbox.app → Settings → API key | `POST /v1/api/webdl/createwebdownload`, polls `mylist` until finished, then `requestdl` |
| **Premiumize** | premiumize.me → Account → API key | `POST /api/transfer/directdl?apikey=…`; host list from `/api/services/list` |

Enter the key → the store validates it against the service's user endpoint and shows the account (user, expiry, supported hosts, refreshed daily).
In Download options choose **Download using**: *Direct*, a connected service, or *Auto* (uses a connected service whenever it supports the host).
The unrestricted link is downloaded by the normal engine (debrid CDNs support Range, so up to 16 connections). The job shows *via Real-Debrid*.
Errors are plain language: "Real-Debrid says this host is not supported", "Your TorBox plan limits files to 107 GB — pick a smaller format or download directly".

---

## Saves hub

Library → **Saves hub** **(console only)** lists the console's profiles and every save folder (`/user/home/<uid>/savedata_prospero/<TITLEID>/` for PS5, `/user/home/<uid>/savedata/<TITLEID>/` for PS4).

* **Back up** — a ZIP per title (image files + `sce_sys/`) into `<backup drive>/xeno-store/saves/<userName>/`. Runs as a job with progress and cancel. *Back up all saves now* does every title.
* **Restore** — picks a backup; the current save is zipped first as `.pre-restore` automatically (Settings → Saves → *Auto-backup before restore/transfer*).
* **Transfer between profiles** (Beta) — copies a title's save folder to another profile on the same console, backing up any existing destination save first. Saves are sealed to this console: a backup from *another* console needs re-signing (see the Save Data Store engine tiers).

---

## Save Data Store

PS5 titles only (PPSA). Entry points: the **Saves (n)** tab on a PS5 game page and Library → **Community Saves**.

**Compatibility check** on every card: installed? (`/user/app/<titleId>`), installed version (read from the console's app metadata), region (exact title ID — a save never loads on a different title ID; other regions are shown under *Other regions* with a warning), and version compare: ✓ *Matches your 01.004.000*, ⚠ *Made on 01.004.000, you have 01.000.000 — update the game first* (one tap opens the game's updates), ✗ *Game not installed*. Incompatible saves are hidden unless you toggle **Show all**. PS4 → PS5 conversion is not offered; the UI says so.

**Install to my saves** downloads the ZIP through the queue, verifies its sha256, backs up your current save (checkbox, on by default) and imports it with the engine. **Download file** only saves the ZIP to `<drive>/xeno-store/saves/community/`.

### Engine tiers — honest about what runs

`GET /api/saves/engine` and Settings → Saves show which tier is active; the UI never pretends a higher tier works.

| Tier | When | What it does |
|:--|:--|:--|
| **Native mount** | `libSceSaveData` resolves and kstuff-style save patches are loaded | Creates/mounts the save for (your profile, title, dir), copies files in, writes your account ID into `param.sfo`, unmounts. Export does the reverse and strips the account ID. Any failure unmounts and deletes the partial save. |
| **Garlic** | Garlic Save Manager answers on `127.0.0.1:8082` | Hands the ZIP to Garlic's import/export; shows *via Garlic* and *Open in Garlic*. |
| **Raw copy** | otherwise | Copies into the save folder directly with an automatic pre-backup. Labelled **Same console only** — a save made on another console will not load this way. |

### Upload my save (one-click share)

Library → Community Saves → **Upload my save**: pick profile → pick an installed PS5 title with saves → pick the save dir → the engine exports it (account ID stripped, no sealed keys ever included) → ZIP + `xeno-save.json` manifest → upload to **pixeldrain** (fallback **catbox**, ≤ 200 MB, or your own endpoint) → fill category, name, description, tags, nickname → **Submit**.
With the default GitHub backend the console shows a QR + short link to a prefilled issue so you finish on your phone; the owner approves it and it appears for everyone. With a Supabase backend (Settings → Saves → Backend) the row is inserted directly.
Privacy: no account IDs, console IDs or usernames leave the console; the nickname is what you typed.

---

## Accounts

Settings → **Accounts** **(console only)** lists the 16 profile slots with name, ID, type and whether they are activated.

**Activate** writes an activation into the registry for that slot (the `offact` method) so the profile behaves like a signed-in one offline. Read the warning sheet before confirming:

* **Back up your saves first** (Saves hub → Back up all). Saves are tied to the account ID; changing it on a profile that already has saves can make them unreadable.
* **A reboot is required** — the store offers **Reboot now** after the write (the queue is saved first).
* Do it on a **secondary profile** if unsure; **Clear** undoes the activation for a slot (reboot again).
* If the registry API is not available on your firmware the screen says *registry_unavailable* instead of guessing.

**NP fake sign-in / sign-out** are not done in-process: the Accounts screen links to the companion payloads (`np-fake-signin.elf`, `np-fake-signout.elf` from earthonion), downloads them with a hash check and sends them to the ELF loader. Activate the profile first.

---

## Homebrew tab

Apps, emulators and tools from **pkg-zone.com**. The console fetches the listing live (cached 7 days), and the catalog sync also carries it, so the tab works right after install. **Install** downloads the PKG and auto-installs it (PS5 build preferred; a PS4 build shows a warning). Installed apps are detected through `/user/app/<id>` and the recorded version; a newer listing shows **Update available**. Essentials are owner-curated in `updates/featured.json` → `homebrew`.

---

## Companion payloads

Settings → Setup → **Payloads** lists the owner-curated catalog from `updates/companions.json`: ShadowMountPlus, the package installer daemon, kstuff, NP fake sign-in / sign-out, the app dumper and Garlic Save Manager. **Install** downloads the ELF to `/data/xeno-store/payloads/<id>.elf`, checks its sha256 and **Launch** sends the bytes to the local ELF loader on `127.0.0.1:9021`. XENO STORE never loads code in-process. An entry whose hash is still a placeholder refuses to install until the owner publishes the real hash — that is deliberate.

**Ghost icon cleaner** (same screen) lists every `/data/homebrew/*` folder with size and whether it has an `eboot.bin` / icon and lets you delete leftovers after a double confirm. ShadowMountPlus re-registers whatever folder exists there, so deleting the folder is what removes the icon.

---

## Phone companion

Settings → **Pair a device** shows a QR code and both addresses: `http://<ps5-ip>:9095` and `http://xeno.local:9095` (the store answers mDNS for `xeno.local` and `xenostore.local`; opt out in Settings → General → mDNS). Open it on any phone on the same Wi-Fi: phone layout, bottom tabs, full-screen sheets, **Add to home screen**. An optional 4-digit PIN (Settings → Pairing) is required as a header for every change once set; the UI remembers it after the first entry.

---

## Updating

Settings → **Updates** → **Check** reads `updates/payloads.json` (fallback: the GitHub release API + `SHA256SUMS`). **Install update** downloads the new `xeno-store.elf` to `/data/xeno-store/xeno-store.elf.new`, verifies the sha256 and renames it into place. Then **Stop XENO STORE** and send the staged ELF with your loader, or reboot when Payload Manager auto-starts the store from its source (it downloads the new release itself). The catalog and the feeds update on their own every 6 hours and never need an ELF update.

---

## Uninstall

Settings → **Uninstall XENO STORE** opens a confirm sheet with four checkboxes:

| Checkbox | Removes | Default |
|:--|:--|:--|
| Settings, queue and cache | `/data/xeno-store/` | on |
| Home-screen app | `/data/homebrew/XENO-STORE/` | on |
| Payload Manager copy | only the copy the store created itself | on |
| Downloaded games | `<root>/homebrew/*` and `<root>/xeno-store/*` created by the store | **off** (keep your games) |

The store deletes exactly those paths (`POST /api/uninstall` returns the list), toasts and stops. It never registers itself with ShadowMount and never writes outside its data dir, its homebrew folder and the download roots, so there are no ghost icons to chase.

---

## Troubleshooting

| Symptom | Cause | Fix |
|:--|:--|:--|
| Toast **XENO STORE already running on :9095** | A copy is still up | Open the address. Use Settings → Updates → *Stop XENO STORE* before sending a new ELF. |
| **Downloads unavailable on this firmware** banner | `libSceHttp` / `libSceSsl` / `libSceNet` did not load | Reboot and send again; report your firmware with Diagnostics → log in an issue. Browsing still works. |
| **Console offline — browsing the saved catalog** | No route to the internet | Check the PS5 network settings; the catalog and the queue persist. |
| Job failed: **provider_page** | Host returned HTML | Open the page in the browser, finish the check, *Enter file link*. |
| Job failed: **source_changed** | The file changed on the server while paused | *Restart* from zero or pick another release/mirror. |
| Job failed: **hash_mismatch** | Downloaded bytes differ from the catalog hash | Keep the `.xpart` for inspection, *Restart*, or report the link (Report broken link). |
| Job failed: **no_space** | Free space < file + 256 MB | Library → Disk analyzer → *Clean up partials*, delete something, or another drive. |
| Job paused: **drive_missing** | USB/M.2 unmounted | Reconnect the drive; *Resume*. |
| Job: *Scheduled for 22:00* | Schedule window | *Start now anyway* or widen the window in Settings → Downloads. |
| *Install failed (0x…)* | Native installer refused, no DPI | Settings → Setup: install the package installer daemon or load etaHEN; press **Install** on the job again. |
| Image downloaded, no icon on the home screen | ShadowMountPlus not running | Checklist → **Launch ShadowMountPlus now** (or install it from Companions), then Library → *Scan with ShadowMount*. |
| **Install set paused at: update** | One step failed | Fix the cause shown on that job, **Retry**; the rest of the set continues in order. |
| Debrid: *bad_key* | Key rejected by the service | Regenerate the key on the service's site; AllDebrid needs an API key, not the account password. |
| Debrid: *unsupported_host* | The service does not cover that host | Pick *Direct* or another service in *Download using*. |
| Save install: *title_mismatch* | ZIP is for another title ID | Only install saves for the same title ID; other regions are not compatible. |
| Save install: *engine_unavailable* | No tier can import | Load kstuff (native), start Garlic, or use a save made on this console (raw). |
| Accounts: *registry_unavailable* | Registry API missing on this firmware | Not supported on this firmware; nothing was changed. |
| Phone cannot open `xeno.local` | Browser/OS without mDNS or an isolated Wi-Fi | Use the IP; disable "client isolation" on the router. |
| Phone gets *pinRequired* | A pairing PIN is set | Enter the PIN once; the UI keeps it. |
| UI looks stale after an update | Cached bundle | Reload once; the ETag changes with every build. |
| Want the raw log | — | Settings → Diagnostics (last 400 lines) or `/data/xeno-store/log.txt`. |

---

## Hardware test checklist

CI builds the ELF on every push (`make ps5`), but a console is needed to verify the Sony calls. Before a release the owner walks this list on real hardware and notes the firmware:

1. Send `xeno-store-browser.elf`; the toast and the browser appear; `GET /api/status` shows `platform:"ps5"`, the firmware and `downloadsAvailable:true`.
2. `XENO-STORE.zip` under `/data/homebrew/` launches from etaHEN / itemzflow with the XENO icon.
3. Download a small verified Archive.org release with 8 connections; pause, close the browser, reopen, resume; hash verifies; toast arrives with the icon.
4. Put the console in rest mode mid-download; wake it; the job goes `connecting` → `downloading` without a failed attempt.
5. PKG auto-install (native), then with the native path blocked, the DPI fallback; `/user/app/<id>` appears; **Play** launches the title.
6. An install set (game + update) installs in order; a forced failure pauses the set at the right step.
7. exFAT dump → `homebrew/` → ShadowMountPlus scan → icon on the home screen; **Launch ShadowMountPlus now** from the checklist works.
8. Saves hub: back up, restore (pre-restore zip exists), transfer between two profiles.
9. Save Data Store: engine tier reported correctly on this firmware; install a published save; export + upload a save; the issue link opens.
10. Accounts: activate a spare profile, reboot, confirm; clear it, reboot.
11. mDNS: a phone resolves `xeno.local`; the pairing PIN blocks unauthenticated writes.
12. Settings → Uninstall with "keep downloaded games": only the listed paths are gone.
