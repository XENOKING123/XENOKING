# Source discovery & permission report

Prepared 2026-11-06 for the XenoSaves Archive server. **Evidence tags:**
**[M]** measured / read directly · **[S]** search-engine snippet (live page not fetched) · **[I]** inference / estimate.

> **Limits of this research.** The build sandbox could reach only GitHub. No terms-of-service page, FAQ or
> robots.txt of a non-GitHub site could be fetched directly, so every non-GitHub fact marked [S] is
> provisional until someone reads the live page. GitHub was checked directly: blobless clones (trees only),
> `HEAD` requests for sizes, LICENSE/README reads. **No save file was downloaded during research.**

## Summary

| Source | Hosts files? | PS4/PS5 saves available | Login / paywall | Automated access | Redistribution | Policy in registry |
|---|---|---|---|---|---|---|
| **Apollo Save Tool DB** (github.com/bucanero/apollo-saves) | Yes (git) | **233 PS4 zips, 136 titles, 371.6 MiB [M]**; no PS5 folder | None | Yes (GitHub; archival use allowed by GitHub AUP §7) | **GPL-3.0 [M]** | `MIRROR_ALLOWED` ✅ live-tested |
| GitHub vVvSHaD0WvVv/Diablo-3-S34-Modded-Save-V2 | Yes | 1 zip, 1.9 MiB [M] | None | Yes | **GPL-3.0 (LICENSE file detected by connector) [M]** | licence auto-grant ✅ live-tested |
| 14 other GitHub repos with save data | Yes | ~3.36 GiB total [M] (2.56 GiB is one Saints Row repo, stored as raw save folders, not archives) | None | Yes | **No licence** → GitHub ToS D.5 only allows viewing/forking on GitHub | `PERMISSION_REQUIRED` (catalogued, not downloaded) |
| **The Tech Game** | Probably on-site [I] | "PS4 Game Saves & Sets: 13,951 files / 327.16 GB"; "PS4 Modded: 521 files / 7.55 GB"; PS5 Modded: none [S, snapshot date unknown] | **Member login required** [I; third-party downloader needs username/password] | Unknown (ToS not readable from sandbox) | Unknown | `PERMISSION_REQUIRED` + `thetechgame-import` link-list slot |
| **PlayerSquared** | On-site attachments [I] | Unknown; ≈2,700+ threads incl. requests [I] | Credits system for some content [S] | Unknown | **Terms: "cannot … redistribute our content"** [S] | `EXTERNAL_ONLY` + `playersquared-import` slot |
| XDG Mods | Unknown | Unknown (per-game starter pages) [S] | Paid "XDG PLUS" tier implies free-tier limits [S] | Unknown | Unknown | `EXTERNAL_ONLY` |
| RothedDB | Ad-redirect to external hosts [S] | "500+ titles" across PS2–PS4/PSP/Switch/PC [S] | **Paid credit tiers (Rare/Epic/Legendary)** [S] | Unknown | Says most content made by others [S] | `EXTERNAL_ONLY` |
| GBAtemp (Sony PS4 › Game saves) | Yes, on-site [S] | 54–1,000 (conflicting snapshots) [S] | Unknown | Unknown | Per resource author | `PERMISSION_REQUIRED` |
| SaveGameWorld | Yes, direct `/download/*.zip|rar` [M via third-party index] | ≥129 PS4 entries [M] | None seen [S] | Unknown | Unknown | `PERMISSION_REQUIRED` |
| savegamefiles.com | Unknown | ≈51+ posts [I] | Unknown | Unknown | Unknown | `PERMISSION_REQUIRED` |
| GarlicSaves | Processing service; deletes uploads [S] | "Sample saves", count unknown | API key | Unknown | Unknown | `PERMISSION_REQUIRED` |
| GameFAQs | Yes | Unknown (PS4 save pages exist) [S] | Account to upload | **ToS bans scraping** [S] | Contributors | `BLOCKED` |
| Reddit r/GamingSaves | No (links out) | Unknown | — | **robots.txt blocks unknown bots (2024)** [S] | Post authors | `BLOCKED` |
| Se7enSins / PSXHAX / NextGenUpdate threads | Mostly MEGA links [S] | Unknown | Unknown | Unknown | Thread authors | `EXTERNAL_ONLY` |
| Internet Archive | Yes | **No PS4/PS5 save items found** (only game dumps — excluded) [S] | No | API exists | Per item licence | connector built, disabled |
| Nexus Mods | PC-focused | No PS4/PS5 save category [S] | Account for API | 20k req/day cap [S] | Per author | not registered |
| savegame.pro | — | No save site found under that name | — | — | — | not a source |

## What can be mirrored today vs. the 500 GB target

| Bucket | Size | Basis |
|---|---|---|
| **Mirror-allowed now** | **≈ 0.37 GB** (Apollo 371.6 MiB + 1.9 MiB GPL repo) | explicit open licence |
| Needs permission — The Tech Game | ≈ 334.7 GB reported (14,472 files) [S] | login-gated; ToS unread |
| Needs permission — unlicensed GitHub repos | ≈ 3.4 GiB [M] | no licence |
| Needs permission — PlayerSquared | ≈ 4–5 GB very rough [I] | terms forbid redistribution without permission |
| Needs permission — GBAtemp, SaveGameWorld, savegamefiles, forum threads | < 1 GB [I] | operator / author permission |
| **Gap to 500 GB** | **≈ 499.6 GB without new permissions; ≈ 155 GB even if every source above grants permission** | the reported public PS4/PS5 save universe is ≈ 345 GB |

**Bottom line:** the legally mirrorable PS4/PS5 save corpus today is under 0.5 GB. About 96 % of the
discoverable volume sits on The Tech Game. The route to hundreds of GB is written permission from TTG
(and PlayerSquared, GBAtemp, SaveGameWorld, GitHub repo owners) — see `PERMISSION-REQUESTS.md`. Once a
source's permission is recorded, its scraper export is imported through a `link-list` source and the worker
downloads everything automatically, with all verification and without bypassing any access control.

## How sources are wired

| Kind | Connector | Live-tested here |
|---|---|---|
| `apollo-db` | Apollo index (`games.txt`/`saves.txt`) via blobless git clone; blob ids verify every download | ✅ |
| `github-repo` | any GitHub repo; licence detected from LICENSE file; unlicensed → pending | ✅ |
| `link-list` | JSON / JSONL / CSV exports (your scrapers, community submissions, site-provided datasets); post page and file host kept separate; common column names auto-mapped | ✅ (integration test) |
| `archive-org` | Internet Archive scrape + metadata APIs; open-licence items auto-granted | ⚠️ unit-tested only (archive.org unreachable from sandbox) |
| `no-automated-access` | catalogue entry that refuses to run and states why | ✅ |

**File hosts** (separate from discovery sources): GitHub raw/releases ✅ live · direct HTTP(S) ✅ integration-tested ·
MediaFire, Google Drive, Dropbox, OneDrive, MEGA ⚠️ unit-tested against page/URL fixtures only (hosts unreachable
from the build sandbox) — they must be smoke-tested from the production server before relying on them.

## Next sources to research when the server has open internet

- Verify TTG / PlayerSquared / GBAtemp / SaveGameWorld terms and robots.txt live; update policies.
- GitHub Releases of the GPL-tagged vVvSHaD0WvVv Diablo repos (saves may live in release assets).
- Periodic GitHub search for newly licensed save repositories (the `github-repo` connector is ready).
- Discord/Telegram communities: only via owner-provided, permission-cleared exports.
