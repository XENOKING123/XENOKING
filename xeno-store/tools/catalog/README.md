# XENO STORE catalog pipeline (`tools/catalog`)

Builds `catalog/xeno-catalog.json`, the catalog embedded in the ELF and
published on GitHub for the in-app refresh (SPEC §10 / §10.1). Stdlib-only
Python 3.10+: no pip, no network needed for the default build.

```
tools/catalog/
  build_catalog.py     CLI (offline | online | validate), summary table, report.json, revision.json
  schema.py            dataclasses (Catalog / Game / Release / SourceInfo) + validate_catalog()
  merge.py             title normalization, grouping, URL dedupe, art/size/genre/compat/popularity, ranking
  netutil.py           urllib client: browser UA, gzip, per-host rate limit + circuit breaker, deadlines
  sources/__init__.py  registry (REGISTRY, get_sources)
  sources/base.py      SourceContext, SourceSpec, previous-catalog fallback, page_release()
  sources/<id>.py      one module per source (see table)
  tests/test_merge.py  unittest suite
```

## Running

All commands run from `xeno-store/`:

| command | what |
|---|---|
| `python3 tools/catalog/build_catalog.py --offline` | build from `catalog/snapshots/` only (what `make catalog` and the CI build job run) |
| `python3 tools/catalog/build_catalog.py --online` | live sources with per-source time budgets; any failure falls back (what the sync Action runs) |
| `python3 tools/catalog/build_catalog.py --validate` | validate the committed catalog + `revision.json`; exit 1 on any error |
| `--limit N` | debug: cap games/pages per source |
| `--out PATH` | write somewhere else (`revision.json` / `report.json` go next to it) |
| `--sources blackbox,dlpsgame` | run a subset of the registry |
| `python3 -I -m unittest discover -s tools/catalog/tests -v` | tests |

Outputs:

* `catalog/xeno-catalog.json` — compact JSON (`separators=(",",":")`, `ensure_ascii=False`,
  sorted object keys; games sorted by title, releases ranked). Deterministic: the same inputs
  produce the same bytes.
* `catalog/revision.json` — `{revision, generatedAt, games, releases, verifiedReleases}`. The
  revision only increments when the catalog *content* changed (everything except
  `revision`/`generatedAt` is hashed); an unchanged build rewrites identical files, so the sync
  workflow's "commit if changed" step stays quiet.
* `catalog/report.json` — per-source status (`live` / `snapshot` / `previous` / `failed` /
  `skipped`), counts, elapsed time, dropped releases with reasons and samples, format/kind/genre
  histograms. The same numbers are printed as a table at the end of every build.

## How a build works

1. **Sources** produce `GameDraft`s (one game as that source sees it, with its `Release`s).
   In `--offline` mode only snapshot loaders run. In `--online` mode every source runs in
   parallel with its own deadline; when the live fetch raises, returns nothing or overruns, the
   build falls back to (a) the previous catalog's releases for that source, else (b) its
   snapshot, else it is reported as `failed`. A broken site can never abort the build.
2. **merge.py** normalizes titles (`™®` stripped, site tags like `PS4 [FPKG] v1.03`, editions,
   punctuation, articles, accents, trailing roman numerals), groups drafts by
   `(normalized title, platform)`, joins groups that share a title id or a download URL on the
   same platform, dedupes releases by URL (filling empty fields from the lower-priority copy and
   unioning mirrors), then computes art (prosperopatches/orbispatches CDN > PlayStation CDN >
   source cover, with fallbacks), `sizeMin/Max`, the clean genre list, compat tags, `verified`,
   `popularity` (BlackBox pick/home order, recency, release count, verified direct link, art)
   and `featured` (BlackBox home order; when none exists the most popular PS5 games with hero
   art fill the Discover rail). Game ids are `<slug>-<ps4|ps5>` with the slug taken from the
   normalized title so the PS4 and PS5 entries of one game share it.
3. **schema.validate_catalog** fails loudly on duplicate game ids, releases without an http(s)
   URL (or with credentials), unknown `sourceId`, platforms other than PS4/PS5, negative sizes,
   missing titles, non-ISO dates, unknown formats/kinds/genres, duplicate release ids inside a
   game and the same URL under two games. A build that does not validate is not written.

Release `addedAt` / game `addedAt` are sticky: a rebuild keeps the date from the previously
published catalog so re-scraped entries never look new again.

## Sources

| id | module | mode | notes |
|---|---|---|---|
| `blackbox` | `sources/blackbox.py` | online (raw.githubusercontent.com) + snapshot | the four `catalog/*.json` files of D3ATHLY/blackbox merged by release id; releases keep `sourceId` archive/vikingfile with verification data, hashes, browserUrl, home/pick order |
| `orbit` | `sources/orbit.py` | snapshot only | last plaintext Orbit `catalogue-v2.json` envelope; newer feeds are encrypted |
| `dlpsgame` | `sources/dlpsgame.py` | online + snapshot | WP REST listing for the PS5/PS4 categories; every post's base64 `data-payload` blocks are decoded into releases (kind game/update/dlc, titleId/region/version, mirrors, password). Snapshot = PAGE releases from `catalog/snapshots/xeno-dlpsgame/catalog.json` |
| `archive_org` | `sources/archive_org.py` | online only | seeds = archive identifiers found in the snapshots/previous catalog (+ the whole `ps4-fpkg-collection-english-*` series) + `advancedsearch.php`; `/metadata/<id>` → direct files with size/md5/sha1 |
| `superpsx` | `sources/superpsx.py` | online only | category listings → PAGE releases (password SuperPSX) |
| `pkggames` | `sources/pkggames.py` | online only | static PS5 game list → PAGE releases |
| `pspkg` | `sources/pspkg.py` | online only | paginated PS4/PS5 listings → PAGE releases (Cloudflare; often falls back) |
| `arabicps4` | `sources/arabicps4.py` | online only | PS4 card grids + JS-unescaped PS5 list → PAGE releases; the torrent section is skipped |

`release.sourceId` is the host the user downloads from and must exist in `catalog/sources.json`
(`archive`, `vikingfile`, `dlpsgame`, …). The catalog's `sources` array lists only the ids that
are actually referenced by a release.

### Politeness

`netutil.Http` sends a real browser User-Agent (several sites 403 anything else), keeps one
request per second per host by default (`HOST_INTERVALS` in `build_catalog.py` tunes GitHub
and archive.org), retries 429/5xx with backoff and honours `Retry-After`, and opens a circuit
for a host after five consecutive connection failures so an unreachable site fails in
milliseconds instead of queueing behind the rate limiter. Every request checks the source's
deadline first.

## The scheduled GitHub Action

`.github/workflows/xeno-store-catalog-sync.yml` runs every 6 hours (`17 */6 * * *`) and on
dispatch:

```
python3 tools/catalog/build_catalog.py --online
python3 tools/catalog/build_catalog.py --validate
git add catalog/xeno-catalog.json catalog/revision.json catalog/report.json
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
     dlpsgame 60, page scrapers 20–40), `budget` (seconds for the online run),
     `release_source_ids` (the `sourceId` values it emits),
   * `online(ctx)` → `list[GameDraft]` (raise `HttpError` to trigger the fallback; use
     `ctx.get_text` / `ctx.get_json`, which apply the deadline and rate limit, and
     `ctx.limit` / `ctx.truncate()` for `--limit`), and/or `snapshot(ctx)` reading a file under
     `catalog/snapshots/<id>/`.
   * Build releases with `schema.Release` (direct files: `format` from the extension, sizes,
     hashes) or `sources.base.page_release()` for pages that list mirrors. Use the `merge.py`
     helpers (`clean_title`, `parse_title_ids`, `parse_version`, `parse_region`,
     `parse_compat`, `detect_kind`, `format_from_filename`) so every source parses the same way.
2. Import the module in `sources/__init__.py` and add it to `_MODULES`.
3. Add the `sourceId` to `catalog/sources.json` (`kind` direct/browser/page, `notice`,
   `password`).
4. Add a test in `tests/test_merge.py` that feeds a captured HTML/JSON fragment to the parser.
5. Run `--offline`, `--validate` and the tests.

Snapshots live under `catalog/snapshots/<name>/` and are plain upstream files; refresh them by
copying the upstream output (never hand-edit) so the offline build stays reproducible.

## Schema notes

* `format` is the §10 list plus `FFPFS` (a valid image extension per §3 that the engine
  routes to `homebrew/`).
* `tint` is chosen from a fixed dark palette by slug hash so cards can be tinted before art
  loads; it is deterministic and does not sample the image.
* `region` on a game is the source-reported region, else the most common release region.
* `compat` tags come from file names and update labels: `9.xx`, `4.xx` (from `BP4.xx`),
  `11.xx+`, and bare firmware numbers that are in `merge.KNOWN_FIRMWARES`
  (`5.05`, `13.60`, …) so update versions never leak in.
