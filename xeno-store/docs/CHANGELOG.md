# Changelog

All notable changes to XENO STORE. The version lives in `VERSION`; releases are tagged `xeno-store-v<VERSION>`.

## 1.0.0 — 2026-10-13

First release. A native PS5 game store + download manager by XENOKING.

### Console payload (C, `src/`)
- One ELF (`xeno-store.elf`, plus `xeno-store-browser.elf` that opens the PS5 browser), HTTP/1.1 server on :9095, embedded UI + catalog + locales (gzip variants), PWA manifest.
- Download engine: segmented transfer with work-stealing chunks (1–16 connections), per-host adaptive window, resume sidecars with validator re-probe and tail check, mirror failover, retry backoff honouring `Retry-After`, provider-page detection, free-space guards, token-bucket bandwidth limit, sha256 verification, queue persistence.
- Phase 2 engine: Turbo start (mirror race), auto best version, install sets with ordered auto-install, schedule window with "Start now anyway", lifetime statistics, rest-mode detection and auto-resume, ZIP extraction on the console (miniz), copy/move between drives as queue jobs, debrid resolution (Real-Debrid, AllDebrid, TorBox, Premiumize).
- PKG install: native `sceAppInstUtilInstallByPackage`, fallbacks to the DPI daemon on :9040 and etaHEN DPI on :12800 (`/pkgsrv/<token>`), install polling, Play and Uninstall for installed titles.
- Console features: readiness checklist, uninstall and ghost-icon cleaner, companion payloads (sha256 + local ELF loader on :9021), saves hub (backup / restore / transfer), Save Data Store with native / Garlic / raw engine tiers and GitHub or Supabase backends, offline account activation (registry slots) with reboot, mDNS for `xeno.local` / `xenostore.local`, disk analyzer, homebrew store (pkg-zone) with image proxy, on-console Steam enrichment, owner-curated feeds (featured, messages, companions, saves backend).
- Self-update from `updates/payloads.json` with sha256 verification and GitHub release fallback.
- Safety: bounded buffers, sanitized paths built only from known roots, job-owned deletes, allow-listed outbound hosts, optional pairing PIN, runtime `dlsym` for every Sony API outside the five proven libraries.

### Web UI (`web/`)
- Single-file ES2017 bundle (no frameworks) with DualSense spatial navigation, history-based back, gamepad polling, sounds, 7 themes, large-text / high-contrast, safe mode, cover-wall screensaver, command palette and shortcuts overlay.
- Screens: Discover (hero, curated rows, rails, surprise me, all games), Browse (faceted filters with live counts, quick chips, presets, ranked search with "Did you mean"), Game (gallery + full-screen viewer, info panel, backports, install sets, Download best, saves tab), Downloads (groups, stats, schedule, rest pill, extraction, copy jobs), Library (storage + disk analyzer, installed titles with Play / Uninstall, files, Updates center, saves hub, community saves, transfer), Homebrew, Settings (all Phase 2 groups), Setup (checklist, Payload Manager QR, companions, ghost cleaner), Search overlay, first-run wizard, phone layout.
- 14 locales wired in (English complete; other locales fall back to English until translated).

### Catalog pipeline (`tools/catalog/`)
- 1,965 games / 2,592 releases merged from BlackBox, Orbit, Archive.org, dlpsgame, SuperPSX, pkg.games, pspkg, ArabicPS4Games, romsfun, romspure, espacypkg and pkg-zone; generic WordPress adapter; offline seeds enrichment (official titles, cheats counts, covers); Steam / PlayStation Store enrichment with committed caches; backports and install-set fields; link audit with `ok` / `flaky` / `dead` / `page` verdicts; deterministic output; 125 unit tests.

### Packaging, CI, docs
- `make` targets `web catalog assets host test ps5 ps5-check pkg all clean distclean`; `tools/make_homebrew.py` builds `dist/XENO-STORE/` + `XENO-STORE.zip` (mode 0777 entries, titleId `XENO00002`).
- `xeno-store.yml`: web + catalog → host tests (77) → PS5 ELF (LLVM 18, SDK v0.40) → release `xeno-store-v<VERSION>` with `SHA256SUMS`, writes hashes into `updates/payloads.json`.
- `xeno-store-catalog-sync.yml`: every 6 hours, online build + link audit + validation, commits only real changes.
- Docs: README, GUIDE, API, FORMATS, SPEC; feeds `updates/payloads.json`, `messages.json` (10 languages), `featured.json`, `companions.json`, `saves-backend.json`.

### Known limits (documented, not faked)
- RAR / 7z archives are downloaded, not extracted on the console.
- Human checks on browser hosts are finished in the PS5 browser or on the phone; no CAPTCHA bypass.
- PS5 fake packages run only on firmware 11.60 and lower (October 2026) with kstuff / etaHEN; the checklist says what applies to your console.
- Companion payloads install only once the owner publishes their sha256 (placeholders refuse to install by design).
- Hardware calls (install, saves, accounts, mDNS, rest mode) are verified on a console before each release; CI compiles them and tests the host simulation.
