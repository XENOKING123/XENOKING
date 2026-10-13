# XENO STORE catalog pipeline (`tools/catalog`)

Builds `catalog/xeno-catalog.json`, the catalog embedded in the ELF and published on GitHub for
the in-app refresh (SPEC §10 / §10.1, Phase 2 additions in §17.1, §17.9–§17.13, §17.21).
Stdlib-only Python 3.10+: no pip, no network needed for the default build.

```
tools/catalog/
  build_catalog.py     CLI (offline | online | validate), summary table, report.json, revision.json
  audit.py             §17.12 link audit (archive.org metadata, HEAD + 1-byte Range, page checks) → snapshots/audit/results.json
  schema.py            dataclasses (Catalog / Game / Release / SourceInfo) + validate_catalog()
  merge.py             title normalization, grouping, URL dedupe, backports, art/size/genre/compat/popularity, audit application
  netutil.py           urllib client: browser UA, gzip, per-host rate limit + circuit breaker, deadlines, HEAD/Range requests
  enrich/seeds.py      §17.9 offline enrichment from the seeds bundled with XENO TOOL (titles, cheats, covers)
  enrich/steam.py      §17.1 Steam storefront enrichment (online, cached in snapshots/enrich/steam-cache.json)
  enrich/psstore.py    §17.1 PlayStation Store page enrichment (online, cached in snapshots/enrich/psstore-cache.json)
  sources/__init__.py  registry (REGISTRY, get_sources)
  sources/base.py      SourceContext, SourceSpec, previous-catalog fallback, page_release()
  sources/wpsite.py    §17.10 generic WordPress site adapter (REST → sitemap → category pages; page rules)
  sources/<id>.py      one module per source (see table)
  tests/               unittest suite + fixtures/ (HTML/JSON/XML samples for every adapter)
```

## Running

All commands run from `xeno-store/`:

| command | what |
|---|---|
| `python3 tools/catalog/build_catalog.py --offline` | build from `catalog/snapshots/` + the bundled seeds + the enrichment caches (what `make catalog` and the CI build job run) |
| `python3 tools/catalog/build_catalog.py --online` | live sources with per-source time budgets, then the Steam / PS Store passes (`--enrich-budget`, default 240 s); any failure falls back (what the sync Action runs) |
| `python3 tools/catalog/build_catalog.py --validate` | validate the committed catalog + `revision.json` (+ the JSON node budget); exit 1 on any error |
| `python3 tools/catalog/audit.py --budget-seconds 1200` | §17.12 link audit, resumable; results in `catalog/snapshots/audit/results.json` (`make audit`) |
| `--orbit PATH` | add a decrypted Orbit catalogue (`catalogue*.json` file or directory of them), repeatable (§17.11) |
| `--enrich-budget N` | online only: seconds for the Steam + PS Store passes (0 = reuse the caches only) |
| `--no-seeds` | skip the offline seeds enrichment |
| `--limit N` | debug: cap games/pages per source |
| `--out PATH` | write somewhere else (`revision.json` / `report.json` go next to it) |
| `--sources blackbox,dlpsgame` | run a subset of the registry |
| `python3 -I -m unittest discover -s tools/catalog/tests -v` | tests (108, offline, with a local HTTP server for the audit) |

Outputs:

* `catalog/xeno-catalog.json` — compact JSON (`separators=(",",":")`, `ensure_ascii=False`,
  sorted object keys; games sorted by title, releases ranked). Deterministic: the same inputs
  produce the same bytes. Every key of the schema is present on every record (the console reader
  never guesses); strings are short and whitespace-free. The build refuses to write more than
  600,000 JSON nodes (the console parser is capped at 900,000); the current offline build is
  ~161k nodes / 3.6 MB (gzip ~0.6 MB, which is what the ELF and the refresh actually carry).
* `catalog/revision.json` — `{revision, generatedAt, games, releases, verifiedReleases, auditedAt}`.
  The revision only increments when the catalog *content* changed (everything except
  `revision`/`generatedAt` is hashed); an unchanged build rewrites identical files, so the sync
  workflow's "commit if changed" step stays quiet. The README "catalog status" badge reads these.
* `catalog/report.json` — per-source status (`live` / `snapshot` / `previous` / `failed` /
  `skipped`), counts, elapsed time, dropped releases with reasons and samples, format/kind/genre
  histograms, platform counts (PS5 / PS4 / HOMEBREW), backport count, enrichment coverage
  (`withScreenshots`, `withMetacritic`, `withCheats`, `withPsStoreUrl`, `withTitleIds`, seeds stats,
  cache sizes) and the audit block (`ok`/`flaky`/`page`/`unaudited`, `droppedDead`, `droppedLinks`).
  The same numbers are printed as a table at the end of every build.

## How a build works

1. **Sources** produce `GameDraft`s (one game as that source sees it, with its `Release`s).
   In `--offline` mode only snapshot loaders run. In `--online` mode every source runs in
   parallel with its own deadline; when the live fetch raises, returns nothing or overruns, the
   build falls back to (a) the previous catalog's releases for that source, else (b) its
   snapshot, else it is reported as `failed`. A broken site can never abort the build.
2. **merge.py** normalizes titles (`™®` stripped, site tags like `PS4 [FPKG] v1.03`,
   `+ Backport 5.05`, bare firmware numbers, editions, punctuation, articles, accents, trailing
   roman numerals), groups drafts by `(normalized title, platform)` (HOMEBREW apps by their store
   id), joins groups that share a title id or a download URL on the same platform, dedupes
   releases by URL (filling empty fields from the lower-priority copy and unioning mirrors),
   derives the §17.13 backport fields, applies the audit results, runs the enrichers, then computes
   art (prosperopatches/orbispatches CDN > PlayStation CDN > source cover, with fallbacks),
   `sizeMin/Max`, the clean genre list, compat tags, `verified`, `year`, `series`, the
   `updates/dlc/backports` counts, the `screenshots` fallback, `popularity` and `featured`.
   Game ids are `<slug>-<ps4|ps5|homebrew>` with the slug taken from the normalized title so the
   PS4 and PS5 entries of one game share it.
3. **schema.validate_catalog** fails loudly on duplicate game ids, releases without an http(s)
   URL (or with credentials), unknown `sourceId`, platforms other than PS4/PS5/HOMEBREW, negative
   sizes, missing titles, non-ISO dates, unknown formats/kinds/genres, duplicate release ids inside
   a game, the same URL under two games, and every Phase 2 rule (≤ 10 screenshot URLs, Metacritic
   0–100 or null, age rating 0–21 or null, plausible year, non-negative counts, slug-shaped `series`,
   firmware-shaped `backportFw`/`requiresFw`, `backport` releases with a target firmware, no `dead`
   health, HOMEBREW entries with an author / a known category / no Sony title ids / `app` releases,
   and no app-only keys on games). A build that does not validate is not written.

Release `addedAt` / game `addedAt` are sticky: a rebuild keeps the date from the previously
published catalog so re-scraped entries never look new again.

### Backports (§17.13)

`merge.parse_backport` reads `[BP 9.00]`, `BP4.xx`, `Backport 5.05`, `backported to 11.00`,
`(Backported)` from file names and section labels. A PKG / archive / page with such a tag becomes
`kind: "backport"` with `backportFw` (the target firmware) and `requiresFw` (= `backportFw`); a
full console image (FFPFSC / exFAT / FFPKG / FFPFS) tagged this way stays `kind: "game"` but
still carries `backportFw`, so the game counts as having a backport. `requiresFw` of every other
release is the lowest firmware tag in its labels (`9.xx`, `5.05` from `(Fix 5.05/6.72)`, `11.xx+`).
`game.backports` counts releases with kind `backport` or a `backportFw`. A backport whose target
firmware nobody states falls back to `update`/`game` (validation requires the firmware).

### Offline enrichment from the bundled seeds (§17.9)

`enrich/seeds.py` reads `client/src-tauri/resources/titles-seed.zip` with `zipfile` straight from
the repository (`All_Titles.json`: 69,552 titles; `cheatslist.json`: 1,905 title ids with trainers)
and `client/public/covers.json` (1,162 PlayStation CDN covers). Per game: official names for every
known title id (a title that is just a title id gets the official name), `titleIds` filled by exact
normalized-name match for name-only entries (best region first, at most 4 ids), `conceptId` →
`psStoreUrl` (`https://store.playstation.com/en-us/concept/<id>`), region hints from the content-id
prefix (UP=USA, EP=EUR, JP=JPN, HP=ASIA) for the game and its releases, `cheats` (unique trainer
names across every version of every title id) and a cover fallback. The offline build currently
resolves title ids for 1,910 of 1,965 games, a store URL for 1,905 and cheats for 543.
When the zip is absent (a checkout without `client/`) the build logs one line and continues.

### Steam and PlayStation Store (§17.1, online)

`enrich/steam.py`: `storesearch` by title (the exact name wins, else the first app whose name
normalizes like ours) → `appdetails` → 8 screenshots, about (plain text, ≤ 500 chars — the console
fetches the full text live through `/api/game/enrich`), developer, publisher, genres, Metacritic,
release date, features (Steam categories mapped to `Single-player`, `Online multiplayer`, `Co-op`,
`Local multiplayer`, `Controller support`, …), age rating and languages. 2.5 s between requests, a
429/403 ends the run, the pass has its own budget (half of `--enrich-budget`, most popular games
first), misses are cached too. `enrich/psstore.py` visits `store.playstation.com` concept/product
pages only for games that already carry a `psStoreUrl`, reads the embedded page JSON for
`SCREENSHOT` media and the long description (generic walk: a layout change degrades to "nothing
found"), 2 s between requests. Both caches live in `catalog/snapshots/enrich/` and are committed by
the sync workflow so offline builds reuse them; sources always win over Steam data (Steam only
fills gaps, except Metacritic which always applies).

### Homebrew apps (§17.21)

`sources/pkgzone.py` parses pkg-zone's listing cards (`<article class="pkg …">`: id after
`/details/`, title in `class="title font-bold"`, version in `class="number …"`, author after
`text-gray-300">`, the "Supports PS5" flag, cover `/images/<id>/cover.png`, downloads
`/download/ps5|ps4/<id>/latest`) and the details page (description, category, size, changelog)
into `platform: "HOMEBREW"` entries with `category` (Emulator / Tool / Game / Media / Utility /
Launcher / Payload / Other, inferred from the name when the page has none), `author`, `supportsPs5`
and `PKG` releases of kind `app` (a PS5 build when flagged, always the PS4 build; `filename` is set
so the engine names the file; `browserUrl` is the details page). pkg-zone is not WordPress and has
no snapshot: it is online only (with the previous-catalog fallback), and the console fetches the
listing live too (§17.21).

## Sources

| id | module | mode | notes |
|---|---|---|---|
| `blackbox` | `sources/blackbox.py` | online (raw.githubusercontent.com) + snapshot | the four `catalog/*.json` files of D3ATHLY/blackbox merged by release id; releases keep `sourceId` archive/vikingfile with verification data, hashes, browserUrl, home/pick order |
| `orbit` | `sources/orbit.py` | online (plaintext feed when one exists) + snapshot | every `catalogue*.json` envelope under `snapshots/orbit/`, BlackBox's `catalogue-v2.json` (Orbit's own release list) and `--orbit PATH`; merged by release id, newest revision wins; encrypted files are skipped |
| `dlpsgame` | `sources/dlpsgame.py` | online + snapshot | WP REST listing for the PS5/PS4 categories; every post's base64 `data-payload` blocks are decoded into releases (kind game/update/dlc, titleId/region/version, mirrors, password). Falls back to the sitemap / category pages (wpsite) with the same bundle parser. Snapshot = PAGE releases from `catalog/snapshots/xeno-dlpsgame/catalog.json` |
| `archive_org` | `sources/archive_org.py` | online only | seeds = archive identifiers found in the snapshots/previous catalog (+ the whole `ps4-fpkg-collection-english-*` series) + `advancedsearch.php`; `/metadata/<id>` → direct files with size/md5/sha1 |
| `superpsx` | `sources/superpsx.py` | online only | wpsite (REST → sitemap → Pencil-theme category listings); password SuperPSX |
| `romsfun` | `sources/romsfun.py` | online only | wpsite config (PlayStation 4 / 5 listings) |
| `romspure` | `sources/romspure.py` | online only | wpsite config (`/roms/ps4/`, `/roms/ps5/`) |
| `pkgzone` | `sources/pkgzone.py` | online only | pkg-zone card parser → HOMEBREW entries (§17.21) |
| `espacypkg` | `sources/espacypkg.py` | online only | wpsite config (`/category/ps4|ps5/`) |
| `pkggames` | `sources/pkggames.py` | online only | wpsite (REST → sitemap → the static PS5 game list) |
| `pspkg` | `sources/pspkg.py` | online only | wpsite (REST → sitemap → paginated PS4/PS5 listings; Cloudflare; often falls back) |
| `arabicps4` | `sources/arabicps4.py` | online only | static HTML (not WordPress): PS4 card grids + JS-unescaped PS5 list → PAGE releases; the torrent section is skipped |

`rutracker` is deliberately not a source (torrents cannot be downloaded on the console).

`release.sourceId` is the host the user downloads from and must exist in `catalog/sources.json`
(`archive`, `vikingfile`, `dlpsgame`, `pkgzone`, …). The catalog's `sources` array lists only the ids that
are actually referenced by a release.

### The generic WordPress adapter (`sources/wpsite.py`, §17.10)

A site is a `SiteConfig` (id, base URL, provider, password, platform category slugs / listing URLs,
budget, optional custom listing parser). `fetch_site` tries, stopping at the first strategy that
yields posts: (1) WP REST `/wp-json/wp/v2/posts?per_page=100&page=N&_fields=…` with
`_embed=wp:featuredmedia` for covers (`/wp-json/wp/v2/media/<id>` only for posts still without one,
capped), platform categories resolved from `/wp-json/wp/v2/categories`; (2) sitemaps
(`/sitemap_index.xml`, `/post-sitemap*.xml`, `/wp-sitemap-posts-post-N.xml`, `/sitemap.xml`) → post
URLs → every page fetched; (3) category listing pages with pagination (the site's own listing
parser when it has one, else the generic card parser), then the post pages for the links.
Page rules (`parse_post`): title cleanup (`merge.clean_title`: `PS4/PS5`, `[FPKG]`, `Backport …`,
`v1.xx`, `+ Update + DLC`, sizes, regions, title ids); platform from categories → URL → title → title
ids; title ids `(PPSA|CUSA)\d{5}`; versions `v?\d+\.\d{2}`; firmware tags (`5.05`, `9.00`, `11.00`,
`13.60`, `9.xx`); backport tags; kinds (game/update/dlc/backport) from the nearest heading / line /
lead text of each anchor; download anchors with host classification (terminal hosts — mediafire,
1fichier, vikingfile, akirabox, buzzheavier, gofile, pixeldrain, archive.org, … — become release
URLs; gateways — filecrypt, ouo and other shorteners — become mirrors the UI resolves; the site's own
links are ignored); cover (featured image / `og:image` / first content image); passwords
(`password[:\s]*([^\s<]+)`, else the site default); sizes (`\d+(\.\d+)?\s*(GB|MB)`, a section's own
size first, the post's size only for the base game). A post without usable links still yields one
PAGE release so the game stays browsable. Politeness: browser UA, 1 req/s per host, retries, a
time budget per site; every strategy stops cleanly at the deadline and returns what it has.
`report.json` records per-site success/failure so broken adapters are visible; a failing site never
breaks the build.

### Politeness

`netutil.Http` sends a real browser User-Agent (several sites 403 anything else), keeps one
request per second per host by default (`HOST_INTERVALS` in `build_catalog.py` tunes GitHub,
archive.org, Steam and the PlayStation Store), retries 429/5xx with backoff and honours
`Retry-After`, and opens a circuit for a host after five consecutive connection failures so an
unreachable site fails in milliseconds instead of queueing behind the rate limiter. Every request
checks the source's deadline first. `Http.request` adds HEAD / Range probes for the audit (statuses
are returned, not raised).

## The link audit (`audit.py`, §17.12)

For every release URL: archive.org → `/metadata/<identifier>` once per item (file must exist, size
within ±1 MiB of the release, md5/sha1 must agree when both sides know them); other direct hosts →
`HEAD` then a 1-byte `Range` GET (needs 206/200, a non-HTML content type, a matching size when
known; a 405 on HEAD just hands over to the GET); page sources → `GET` must be 200 and the page must
contain a title id or the game's title (parked / captcha / "domain for sale" pages fail).
Verdicts: `ok`, `flaky` (5xx / timeout / connection error — never a strike on its own), `dead`
(404/410/401/403 on two consecutive audits, or a wrong size / hash), `page` (HTML where a file was
expected). Concurrency 8, timeout 20 s, per-host rate limits, resumable: results are cached by URL
in `catalog/snapshots/audit/results.json` with `checkedAt`; `ok` links are re-checked after 7 days,
`flaky`/`page` every run, `dead` ones get a late retry after 28 days. `--budget-seconds N` bounds a
run (whatever was checked is saved; the rest waits for the next run). The process always exits 0:
a dead link is data, not a build failure. `build_catalog.py` reads the results on every build:
dead releases are dropped (and listed in `report.json` → `audit.droppedLinks`), `release.health` is
set, `ok` direct releases get `verifiedAt = checkedAt`, and `game.verified` becomes "any ok direct
release" (a release the audit never saw keeps its source-reported verification).

Makefile target (documented here for the build owner; `make audit` runs it):

```
audit:
	$(PYTHON) tools/catalog/audit.py --budget-seconds 1200
```

## The scheduled GitHub Action

`.github/workflows/xeno-store-catalog-sync.yml` runs every 6 hours (`17 */6 * * *`) and on
dispatch:

```
python3 tools/catalog/build_catalog.py --online --enrich-budget 240
python3 tools/catalog/audit.py --budget-seconds 1200
python3 tools/catalog/build_catalog.py --offline     # re-merge with the fresh audit results (no network)
python3 tools/catalog/build_catalog.py --validate
git add catalog/xeno-catalog.json catalog/revision.json catalog/report.json catalog/snapshots/enrich catalog/snapshots/audit
git diff --cached --quiet || git commit -m "[catalog-sync] revision N" && git push
```

Because an unchanged catalog produces byte-identical files, the commit step is a no-op when
nothing moved. `report.json` is committed too so broken adapters are visible in the repo
history. The main build workflow (`xeno-store.yml`) runs the `--offline` build and
`--validate` so pull requests never depend on third-party sites. The console fetches
`revision.json` first and only downloads the catalog when the revision is newer (SPEC §4.5).

## Adding a source

1. Create `tools/catalog/sources/<id>.py` exposing `SOURCE = SourceSpec(...)`:
   * `id`, `name`, `priority` (higher wins when picking title/metadata/art; BlackBox is 100,
     Orbit 90, dlpsgame 60, pkg-zone 50, page scrapers 20–40), `budget` (seconds for the online run),
     `release_source_ids` (the `sourceId` values it emits),
   * `online(ctx)` → `list[GameDraft]` (raise `HttpError` to trigger the fallback; use
     `ctx.get_text` / `ctx.get_json`, which apply the deadline and rate limit, and
     `ctx.limit` / `ctx.truncate()` for `--limit`), and/or `snapshot(ctx)` reading a file under
     `catalog/snapshots/<id>/`.
   * For a WordPress site, a `SiteConfig` + `online_for(SITE)` is the whole module (see
     `romsfun.py`); plug a custom listing parser in as `listing_parser` when the theme needs one.
   * Build releases with `schema.Release` (direct files: `format` from the extension, sizes,
     hashes) or `sources.base.page_release()` for pages that list mirrors. Use the `merge.py`
     helpers (`clean_title`, `parse_title_ids`, `parse_version`, `parse_region`,
     `parse_compat`, `parse_backport`, `detect_kind`, `format_from_filename`) so every source
     parses the same way.
2. Import the module in `sources/__init__.py` and add it to `_MODULES`.
3. Add the `sourceId` to `catalog/sources.json` (`kind` direct/browser/page, `notice`,
   `password`).
4. Add a fixture under `tests/fixtures/` and a test that feeds it to the parser (`tests/fakes.py`
   has a canned `FakeHttp` and `make_ctx`).
5. Run `--offline`, `--validate` and the tests.

Snapshots live under `catalog/snapshots/<name>/` and are plain upstream files; refresh them by
copying the upstream output (never hand-edit) so the offline build stays reproducible.

## Schema notes

* `format` is the §10 list plus `FFPFS` (a valid image extension per §3 that the engine
  routes to `homebrew/`). `kind` is `game | update | dlc | bundle | backport | app`.
* Game keys added in Phase 2 (always present): `screenshots` (≤ 10; offline fallback `[hero, heroFallback]`
  minus the cover), `about`, `metacritic` (int or null), `features`, `ageRating` (int or null), `languages`,
  `year`, `updates`, `dlc`, `backports`, `series` (normalized title with subtitle / trailing numbers stripped,
  as a slug: `god-of-war`, `final-fantasy`), `steamId`, `cheats`, `conceptId`, `psStoreUrl`, and for HOMEBREW
  entries `category`, `author`, `supportsPs5` (empty / false on games).
* Release keys added in Phase 2: `health` (`""` not audited, `ok`, `flaky`, `page`; `dead` never ships),
  `backportFw`, `requiresFw`.
* `tint` is chosen from a fixed dark palette by slug hash so cards can be tinted before art
  loads; it is deterministic and does not sample the image.
* `region` on a game is the source-reported region, else the seeds' content-id hint, else the most
  common release region.
* `compat` tags come from file names and update labels: `9.xx`, `4.xx` (from `BP4.xx`),
  `11.xx+`, and bare firmware numbers that are in `merge.KNOWN_FIRMWARES`
  (`5.05`, `13.60`, …) so update versions never leak in.
* `popularity` folds in BlackBox pick/home order, recency, release count, a verified direct link
  (source-reported or audited `ok`), artwork, Metacritic (above 50) and cheats; `featured` is the
  BlackBox home order, else the most popular PS5 games with hero art (Metacritic as tie-break).
