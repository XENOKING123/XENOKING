#!/usr/bin/env python3
"""XENO STORE catalog builder (SPEC §10 / §10.1).

    build_catalog.py --offline            build from catalog/snapshots/ only
    build_catalog.py --online             live sources (each with a time budget; a failing
                                          source falls back to its snapshot / the previous catalog)
    build_catalog.py --validate           validate catalog/xeno-catalog.json and exit non-zero on errors
    options: --limit N (debug: cap games per source), --out PATH, --sources a,b, --quiet

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

from merge import GameDraft, catalog_content_signature, merge_drafts  # noqa: E402
from netutil import BROWSER_UA, BudgetExceeded, Http, HttpError  # noqa: E402
from schema import Catalog, SourceInfo, validate_catalog  # noqa: E402
from sources import REGISTRY, SourceContext, SourceSpec, get_sources  # noqa: E402
from sources.base import drafts_from_previous  # noqa: E402

PROJECT_ROOT = HERE.parent.parent          # xeno-store/
CATALOG_DIR = PROJECT_ROOT / "catalog"
DEFAULT_OUT = CATALOG_DIR / "xeno-catalog.json"
JSON_SEPARATORS = (",", ":")

# Politeness per host (seconds between requests); everything else uses 1 req/s.
HOST_INTERVALS = {
    "raw.githubusercontent.com": 0.2,
    "archive.org": 0.34,
    "dlpsgame.com": 1.0,
}


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
               log) -> SourceRun:
    run = SourceRun(spec)
    started = time.monotonic()
    ctx = SourceContext(root=root, http=http, mode=mode, limit=limit, previous=previous, log=log, source_id=spec.id,
                        deadline=started + spec.budget)
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
                    previous: Catalog | None, log) -> list[SourceRun]:
    if mode == "offline":
        return [run_source(s, mode, root=root, http=http, limit=limit, previous=previous, log=log) for s in specs]
    # Online: sources run in parallel; each respects its own deadline so the
    # slowest site bounds the build, not the sum of all sites.
    runs: list[SourceRun] = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=min(8, len(specs)) or 1) as pool:
        futures = {pool.submit(run_source, s, mode, root=root, http=http, limit=limit, previous=previous, log=log): s
                   for s in specs}
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
    log(f"catalog: {report['games']} games, {report['releases']} releases, "
        f"{report['verifiedReleases']} verified, revision {report['revision']} "
        f"({'changed' if report['changed'] else 'unchanged'}), {fmt_size(size)} -> {out_path}")


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
    log(f"building catalog ({mode}) from {len(specs)} sources: {', '.join(s.id for s in specs)}")
    runs = run_all_sources(specs, mode, root=PROJECT_ROOT, http=http, limit=args.limit, previous=previous, log=log)

    drafts: list[GameDraft] = []
    for r in runs:
        drafts.extend(r.drafts)
    generated_at = utc_now_iso()
    prev_revision = previous.revision if previous else 0
    catalog, mreport = merge_drafts(drafts, source_infos, revision=prev_revision + 1 or 1,
                                    generated_at=generated_at, previous=previous)

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

    size = write_json_atomic(out_path, doc, compact=True)
    verified = sum(1 for g in doc["games"] for r in g["releases"] if r["verifiedAt"])
    write_json_atomic(revision_path, {
        "revision": doc["revision"], "generatedAt": doc["generatedAt"], "games": len(doc["games"]),
        "releases": sum(len(g["releases"]) for g in doc["games"]), "verifiedReleases": verified,
    }, compact=False)
    report = {
        "generatedAt": generated_at, "mode": mode, "revision": doc["revision"], "changed": changed,
        "games": len(doc["games"]), "releases": sum(len(g["releases"]) for g in doc["games"]),
        "verifiedReleases": verified, "bytes": size, "elapsed": round(time.monotonic() - t0, 1),
        "httpRequests": http.requests, "httpFailures": http.failures, "mergedGroups": mreport.merged_groups,
        "platforms": {p: sum(1 for g in doc["games"] if g["platform"] == p) for p in ("PS5", "PS4")},
        "formats": _count(r["format"] for g in doc["games"] for r in g["releases"]),
        "kinds": _count(r["kind"] for g in doc["games"] for r in g["releases"]),
        "genres": _count(ge for g in doc["games"] for ge in g["genres"]),
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
    log(f"OK: {path} revision {doc.get('revision')} — {len(games)} games, {releases} releases, "
        f"{len(doc.get('sources', []))} sources ({len(known)} registered modules), {fmt_size(path.stat().st_size)}")
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
