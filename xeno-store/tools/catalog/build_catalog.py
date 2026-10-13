#!/usr/bin/env python3
"""XENO STORE catalog builder (SPEC §10 / §10.1).

    build_catalog.py --offline            build from catalog/snapshots/ only
    build_catalog.py --online             live sources (each with a time budget; a failing
                                          source falls back to its snapshot / the previous catalog)
    build_catalog.py --validate           validate catalog/xeno-catalog.json and exit non-zero on errors
    options: --limit N (debug: cap games per source), --out PATH, --sources a,b, --quiet,
             --orbit PATH (a decrypted Orbit catalogue file/dir, §17.11), --enrich-budget N (seconds for the
             online Steam / PS Store passes, §17.1), --no-seeds (skip the §17.9 offline enrichment)

Writes catalog/xeno-catalog.json (compact, deterministic), catalog/revision.json
(revision bumps only when content changed) and catalog/report.json (per-source
counts, dropped reasons, timings). Stdlib only; Python 3.10+.
"""
from __future__ import annotations

import argparse
import concurrent.futures
import json
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from audit import audited_at_of, load_results as load_audit_results  # noqa: E402
from enrich import psstore, seeds, steam  # noqa: E402
from merge import GameDraft, catalog_content_signature, merge_drafts  # noqa: E402
from netutil import BROWSER_UA, BudgetExceeded, Http, HttpError  # noqa: E402
from schema import Catalog, SourceInfo, validate_catalog  # noqa: E402
from sources import REGISTRY, SourceContext, SourceSpec, get_sources  # noqa: E402
from sources.base import drafts_from_previous  # noqa: E402

PROJECT_ROOT = HERE.parent.parent          # xeno-store/
REPO_ROOT = PROJECT_ROOT.parent            # the repository (holds client/ with the bundled seeds)
CATALOG_DIR = PROJECT_ROOT / "catalog"
DEFAULT_OUT = CATALOG_DIR / "xeno-catalog.json"
AUDIT_RESULTS = CATALOG_DIR / "snapshots" / "audit" / "results.json"
JSON_SEPARATORS = (",", ":")
MAX_NODES = 600_000                        # the console parser caps at 900k JSON values; stay well under

# Politeness per host (seconds between requests); everything else uses 1 req/s.
HOST_INTERVALS = {
    "raw.githubusercontent.com": 0.2,
    "archive.org": 0.34,
    "dlpsgame.com": 1.0,
    "store.steampowered.com": 2.5,
    "store.playstation.com": 2.0,
}


def count_nodes(value) -> int:
    """Number of JSON values (objects, arrays and scalars) — what the console's bounded parser counts."""
    stack = [value]
    n = 0
    while stack:
        v = stack.pop()
        n += 1
        if isinstance(v, dict):
            stack.extend(v.values())
        elif isinstance(v, list):
            stack.extend(v)
    return n


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def load_json(path: Path):
    with open(path, "r", encoding="utf-8") as fh:
        return json.load(fh)


def write_json_atomic(path: Path, doc, *, compact: bool) -> int:
    """Write JSON via a temp file + rename; returns the byte size written."""
    path.parent.mkdir(parents=True, exist_ok=True)
    if compact:
        text = json.dumps(doc, ensure_ascii=False, separators=JSON_SEPARATORS, sort_keys=True)
    else:
        text = json.dumps(doc, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
    data = text.encode("utf-8")
    tmp = path.with_suffix(path.suffix + ".tmp")
    with open(tmp, "wb") as fh:
        fh.write(data)
    os.replace(tmp, path)
    return len(data)


def load_source_infos() -> list[SourceInfo]:
    doc = load_json(CATALOG_DIR / "sources.json")
    return [SourceInfo.from_dict(s) for s in doc.get("sources", [])]


def load_previous(path: Path, log) -> Catalog | None:
    if not path.exists():
        return None
    try:
        return Catalog.from_dict(load_json(path))
    except (OSError, ValueError) as e:
        log(f"previous catalog unreadable ({e}); starting from revision 0")
        return None


# --------------------------------------------------------------------------- #
# Running sources
# --------------------------------------------------------------------------- #

class SourceRun:
    """Outcome of one source: drafts plus everything report.json wants to know."""

    def __init__(self, spec: SourceSpec):
        self.spec = spec
        self.drafts: list[GameDraft] = []
        self.status = "skipped"        # live | snapshot | previous | skipped | failed
        self.error = ""
        self.elapsed = 0.0
        self.requests = 0

    def to_report(self, merged: dict[str, int]) -> dict:
        return {
            "id": self.spec.id, "name": self.spec.name, "status": self.status, "error": self.error,
            "elapsed": round(self.elapsed, 1), "draftGames": len(self.drafts),
            "draftReleases": sum(len(d.releases) for d in self.drafts),
            "games": merged.get("games", 0), "releases": merged.get("releases", 0), "dropped": merged.get("dropped", 0),
        }


def run_source(spec: SourceSpec, mode: str, *, root: Path, http: Http, limit: int, previous: Catalog | None,
               log, extra: dict | None = None) -> SourceRun:
    run = SourceRun(spec)
    started = time.monotonic()
    ctx = SourceContext(root=root, http=http, mode=mode, limit=limit, previous=previous, log=log, source_id=spec.id,
                        deadline=started + spec.budget, extra=dict(extra or {}))
    before = http.requests

    def finish(status: str, drafts: list[GameDraft]) -> SourceRun:
        run.status, run.drafts = status, drafts
        run.elapsed = time.monotonic() - started
        run.requests = http.requests - before
        return run

    if mode == "online" and spec.online is not None:
        try:
            drafts = spec.online(ctx)
            if drafts:
                return finish("live", drafts)
            run.error = "no entries returned"
        except BudgetExceeded as e:
            run.error = f"budget exceeded: {e}"
        except HttpError as e:
            run.error = str(e)
        except Exception as e:  # noqa: BLE001 - a scraper bug must never abort the build
            run.error = f"{type(e).__name__}: {e}"
        log(f"[{spec.id}] live fetch failed: {run.error}")
        # Fallback 1: what the last successful run published for this source.
        prev = drafts_from_previous(previous, spec.id, spec.release_source_ids, spec.priority - 5)
        if prev and spec.id not in ("blackbox", "orbit"):
            return finish("previous", prev)

    if spec.snapshot is not None:
        try:
            return finish("snapshot", spec.snapshot(ctx))
        except (OSError, ValueError) as e:
            run.error = f"snapshot unreadable: {e}"
            log(f"[{spec.id}] {run.error}")
            return finish("failed", [])
    if mode == "online" and spec.online is not None:
        return finish("failed", [])
    run.error = run.error or "no snapshot for this source (online only)"
    return finish("skipped", [])


def run_all_sources(specs: list[SourceSpec], mode: str, *, root: Path, http: Http, limit: int,
                    previous: Catalog | None, log, extra: dict | None = None) -> list[SourceRun]:
    if mode == "offline":
        return [run_source(s, mode, root=root, http=http, limit=limit, previous=previous, log=log, extra=extra)
                for s in specs]
    # Online: sources run in parallel; each respects its own deadline so the
    # slowest site bounds the build, not the sum of all sites.
    runs: list[SourceRun] = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=min(8, len(specs)) or 1) as pool:
        futures = {pool.submit(run_source, s, mode, root=root, http=http, limit=limit, previous=previous, log=log,
                               extra=extra): s for s in specs}
        for fut, spec in futures.items():
            try:
                runs.append(fut.result(timeout=spec.budget + 90))
            except concurrent.futures.TimeoutError:
                run = SourceRun(spec)
                run.status, run.error = "failed", "source did not return within its budget"
                log(f"[{spec.id}] {run.error}")
                runs.append(run)
    order = {s.id: i for i, s in enumerate(specs)}
    runs.sort(key=lambda r: order[r.spec.id])
    return runs


# --------------------------------------------------------------------------- #
# Build
# --------------------------------------------------------------------------- #

def fmt_size(n: int) -> str:
    return f"{n / (1024 * 1024):.2f} MB" if n >= 1024 * 1024 else f"{n / 1024:.1f} KB"


def print_summary(runs: list[SourceRun], report: dict, out_path: Path, size: int, log) -> None:
    rows = [("source", "status", "games", "uniqueReleases", "dropped", "time", "note")]
    for r in runs:
        rep = next(x for x in report["sources"] if x["id"] == r.spec.id)
        note = r.error[:60]
        rows.append((r.spec.id, r.status, str(rep["games"]), str(rep["releases"]), str(rep["dropped"]),
                     f"{r.elapsed:.1f}s", note))
    widths = [max(len(row[i]) for row in rows) for i in range(len(rows[0]))]
    for i, row in enumerate(rows):
        log("  ".join(cell.ljust(widths[j]) for j, cell in enumerate(row)).rstrip())
        if i == 0:
            log("  ".join("-" * w for w in widths))
    dropped = report["droppedReleases"]
    if dropped:
        log("dropped releases: " + ", ".join(f"{k}={v}" for k, v in sorted(dropped.items())))
    dg = report["droppedGames"]
    if dg:
        log("dropped games: " + ", ".join(f"{k}={v}" for k, v in sorted(dg.items())))
    a = report.get("audit") or {}
    if a.get("auditedAt"):
        log(f"audit: {a.get('ok', 0)} ok, {a.get('flaky', 0)} flaky, {a.get('page', 0)} page, "
            f"{a.get('droppedDead', 0)} dead dropped (results from {a['auditedAt']})")
    en = report.get("enrichment") or {}
    if en:
        log("enrichment: " + ", ".join(f"{k}={v}" for k, v in en.items() if not isinstance(v, dict)))
    log(f"catalog: {report['games']} games ({report['platforms'].get('HOMEBREW', 0)} homebrew), {report['releases']} releases, "
        f"{report['verifiedReleases']} verified, revision {report['revision']} "
        f"({'changed' if report['changed'] else 'unchanged'}), {fmt_size(size)}, {report['nodes']} JSON nodes -> {out_path}")


def build(args: argparse.Namespace, log) -> int:
    mode = "online" if args.online else "offline"
    out_path = Path(args.out).resolve() if args.out else DEFAULT_OUT
    revision_path = out_path.parent / "revision.json"
    report_path = out_path.parent / "report.json"
    source_infos = load_source_infos()
    previous = load_previous(out_path, log)
    specs = get_sources([s.strip() for s in args.sources.split(",") if s.strip()] if args.sources else None)

    http = Http(user_agent=BROWSER_UA, min_interval=1.0, host_intervals=HOST_INTERVALS)
    t0 = time.monotonic()
    extra = {"orbit_paths": [str(Path(p).resolve()) for p in (args.orbit or [])]}
    log(f"building catalog ({mode}) from {len(specs)} sources: {', '.join(s.id for s in specs)}")
    runs = run_all_sources(specs, mode, root=PROJECT_ROOT, http=http, limit=args.limit, previous=previous, log=log,
                           extra=extra)

    drafts: list[GameDraft] = []
    for r in runs:
        drafts.extend(r.drafts)
    generated_at = utc_now_iso()
    prev_revision = previous.revision if previous else 0

    # Enrichment (§17.9 seeds offline; §17.1 Steam / PS Store caches, refreshed online within a budget).
    enrichment: dict = {}
    enrichers = []
    seed_obj = None
    if not args.no_seeds:
        seed_fn, seed_obj = seeds.enricher(REPO_ROOT, log)
        if seed_fn is not None:
            enrichers.append(seed_fn)
    steam_cache = steam.SteamCache(PROJECT_ROOT / steam.CACHE_FILE)
    ps_cache = psstore.PsStoreCache(PROJECT_ROOT / psstore.CACHE_FILE)
    if mode == "online" and args.enrich_budget > 0:
        # A first merge pass tells us which titles matter most (popularity) and which store URLs exist.
        pre, _ = merge_drafts([_copy_draft(d) for d in drafts], source_infos, revision=1, generated_at=generated_at,
                              previous=previous, enrichers=enrichers)
        ranked = sorted((g for g in pre.games if g.platform in ("PS4", "PS5")), key=lambda g: (-g.popularity, g.title))
        half = args.enrich_budget / 2.0
        enrichment["steam"] = steam.run(steam.SteamClient(http), steam_cache, [g.title for g in ranked], half, log)
        enrichment["psstore"] = psstore.run(http, ps_cache, [g.psStoreUrl for g in ranked if g.psStoreUrl], half, log)
    enrichers.append(steam.enricher(steam_cache))
    enrichers.append(psstore.enricher(ps_cache))
    enrichment["steamCache"] = len(steam_cache.entries)
    enrichment["psStoreCache"] = len(ps_cache.entries)

    audit_results = load_audit_results(AUDIT_RESULTS)
    audited_at = audited_at_of(AUDIT_RESULTS) if audit_results else ""
    if audit_results:
        log(f"audit results: {len(audit_results)} URLs from {audited_at or 'unknown date'}")

    catalog, mreport = merge_drafts(drafts, source_infos, revision=prev_revision + 1 or 1,
                                    generated_at=generated_at, previous=previous, enrichers=enrichers,
                                    audit=audit_results or None)
    if seed_obj is not None:
        enrichment["seeds"] = seed_obj.stats.to_dict()

    doc = catalog.to_dict()
    changed = True
    if previous is not None and catalog_content_signature(doc) == catalog_content_signature(previous.to_dict()):
        changed = False
        doc["revision"] = previous.revision
        doc["generatedAt"] = previous.generatedAt or generated_at
    elif previous is None:
        doc["revision"] = 1

    errors = validate_catalog(doc)
    if errors:
        log(f"VALIDATION FAILED ({len(errors)} errors):")
        for e in errors[:50]:
            log("  " + e)
        return 2

    nodes = count_nodes(doc)
    if nodes > MAX_NODES:
        log(f"TOO LARGE: {nodes} JSON nodes exceeds the {MAX_NODES} budget the console parser is sized for")
        return 2
    size = write_json_atomic(out_path, doc, compact=True)
    verified = sum(1 for g in doc["games"] for r in g["releases"] if r["verifiedAt"])
    write_json_atomic(revision_path, {
        "revision": doc["revision"], "generatedAt": doc["generatedAt"], "games": len(doc["games"]),
        "releases": sum(len(g["releases"]) for g in doc["games"]), "verifiedReleases": verified,
        "auditedAt": audited_at,
    }, compact=False)
    health = _count(r["health"] or "unaudited" for g in doc["games"] for r in g["releases"])
    dropped_links = [s.split(": ", 2)[-1] for s in mreport.dropped_samples if ": audit_dead: " in s]
    report = {
        "generatedAt": generated_at, "mode": mode, "revision": doc["revision"], "changed": changed,
        "games": len(doc["games"]), "releases": sum(len(g["releases"]) for g in doc["games"]),
        "verifiedReleases": verified, "bytes": size, "elapsed": round(time.monotonic() - t0, 1),
        "httpRequests": http.requests, "httpFailures": http.failures, "mergedGroups": mreport.merged_groups,
        "nodes": nodes,
        "platforms": {p: sum(1 for g in doc["games"] if g["platform"] == p) for p in ("PS5", "PS4", "HOMEBREW")},
        "formats": _count(r["format"] for g in doc["games"] for r in g["releases"]),
        "kinds": _count(r["kind"] for g in doc["games"] for r in g["releases"]),
        "genres": _count(ge for g in doc["games"] for ge in g["genres"]),
        "backports": sum(g["backports"] for g in doc["games"]),
        "withScreenshots": sum(1 for g in doc["games"] if g["screenshots"]),
        "withMetacritic": sum(1 for g in doc["games"] if g["metacritic"] is not None),
        "withCheats": sum(1 for g in doc["games"] if g["cheats"]),
        "withPsStoreUrl": sum(1 for g in doc["games"] if g["psStoreUrl"]),
        "withTitleIds": sum(1 for g in doc["games"] if g["titleIds"]),
        "enrichment": enrichment,
        "audit": {
            "auditedAt": audited_at, "results": len(audit_results), "ok": health.get("ok", 0),
            "flaky": health.get("flaky", 0), "page": health.get("page", 0), "unaudited": health.get("unaudited", 0),
            "droppedDead": mreport.dropped_releases.get("audit_dead", 0), "droppedLinks": dropped_links[:500],
        },
        "droppedReleases": dict(sorted(mreport.dropped_releases.items())),
        "droppedGames": dict(sorted(mreport.dropped_games.items())),
        "droppedSamples": mreport.dropped_samples,
        "sources": [r.to_report(mreport.per_source.get(r.spec.id, {})) for r in runs],
    }
    write_json_atomic(report_path, report, compact=False)
    print_summary(runs, report, out_path, size, log)
    if args.online:
        failed = [r.spec.id for r in runs if r.status == "failed"]
        if failed:
            log(f"note: sources with no data this run: {', '.join(failed)}")
    return 0


def _copy_draft(d: GameDraft) -> GameDraft:
    """A deep-enough copy so the pre-merge pass cannot mutate the drafts the real merge consumes."""
    import copy
    return copy.deepcopy(d)


def _count(items) -> dict[str, int]:
    out: dict[str, int] = {}
    for it in items:
        out[it] = out.get(it, 0) + 1
    return dict(sorted(out.items()))


def validate(args: argparse.Namespace, log) -> int:
    path = Path(args.out).resolve() if args.out else DEFAULT_OUT
    try:
        doc = load_json(path)
    except (OSError, ValueError) as e:
        log(f"cannot read {path}: {e}")
        return 2
    errors = validate_catalog(doc)
    known = {s.id for s in REGISTRY.values()}
    rev_path = path.parent / "revision.json"
    if rev_path.exists():
        try:
            rev = load_json(rev_path)
            if rev.get("revision") != doc.get("revision"):
                errors.append(f"revision.json revision {rev.get('revision')} != catalog revision {doc.get('revision')}")
            if rev.get("games") != len(doc.get("games", [])):
                errors.append(f"revision.json games {rev.get('games')} != catalog games {len(doc.get('games', []))}")
        except (OSError, ValueError) as e:
            errors.append(f"revision.json unreadable: {e}")
    if errors:
        log(f"INVALID: {path} ({len(errors)} errors)")
        for e in errors[:100]:
            log("  " + e)
        return 1
    games = doc.get("games", [])
    releases = sum(len(g.get("releases", [])) for g in games)
    nodes = count_nodes(doc)
    if nodes > MAX_NODES:
        log(f"INVALID: {path} has {nodes} JSON nodes (budget {MAX_NODES})")
        return 1
    log(f"OK: {path} revision {doc.get('revision')} — {len(games)} games, {releases} releases, "
        f"{len(doc.get('sources', []))} sources ({len(known)} registered modules), {fmt_size(path.stat().st_size)}, "
        f"{nodes} JSON nodes")
    return 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    mode = ap.add_mutually_exclusive_group(required=True)
    mode.add_argument("--offline", action="store_true", help="build from snapshots only")
    mode.add_argument("--online", action="store_true", help="build from live sources with snapshot fallback")
    mode.add_argument("--validate", action="store_true", help="validate an existing catalog")
    ap.add_argument("--limit", type=int, default=0, help="debug: cap games per source")
    ap.add_argument("--out", default="", help=f"catalog path (default {DEFAULT_OUT})")
    ap.add_argument("--sources", default="", help="comma-separated source ids to run (default: all)")
    ap.add_argument("--quiet", action="store_true", help="only print the summary")
    ap.add_argument("--orbit", action="append", default=[], metavar="PATH",
                    help="a decrypted Orbit catalogue (file or directory of catalogue*.json); repeatable")
    ap.add_argument("--enrich-budget", type=float, default=240.0, metavar="SECONDS",
                    help="online only: seconds for the Steam + PS Store enrichment passes (0 = cache only)")
    ap.add_argument("--no-seeds", action="store_true", help="skip the offline seeds enrichment (titles-seed.zip, covers.json)")
    args = ap.parse_args(argv)

    messages: list[str] = []

    def log(msg: str) -> None:
        if args.quiet and msg.startswith("["):
            messages.append(msg)
            return
        print(msg, flush=True)

    try:
        if args.validate:
            return validate(args, log)
        return build(args, log)
    except KeyError as e:
        print(f"error: {e}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
