#!/usr/bin/env python3
"""Full link audit for the catalog (SPEC §17.12).

    audit.py [--catalog PATH] [--results PATH] [--budget-seconds N] [--concurrency 8] [--timeout 20]
             [--recheck-days 7] [--limit N] [--quiet]

For every release URL of ``catalog/xeno-catalog.json``:

* archive.org → ``/metadata/<identifier>`` once per item: the file must exist; its size must match
  the release (±1 MiB) and its md5/sha1 must match when both sides know them (cheap, exact);
* other direct hosts → ``HEAD`` then a 1-byte ``Range`` GET: needs 206/200, a non-HTML content type
  and a matching size when known;
* page sources → ``GET`` must be 200 and the page must contain a title id or the game's title
  (a parked / 404 / captcha page fails).

Verdicts: ``ok``, ``flaky`` (5xx / timeout / connection error), ``dead`` (404/410/401/403 on two
consecutive audits, or a wrong size / hash), ``page`` (HTML where a file was expected).
Concurrency 8, 20 s timeout, per-host rate limits, resumable: results are cached by URL in
``catalog/snapshots/audit/results.json`` with ``checkedAt`` and re-checked after 7 days (flaky
ones every run). ``--budget-seconds`` bounds a run; whatever was checked is saved, the rest waits
for the next run. ``merge.py`` reads the results: dead releases are dropped, ``release.health``
is set and ``game.verified`` becomes "any ok direct release". The process exits 0 even when
links are dead — a dead link is data, not a build failure.
"""
from __future__ import annotations

import argparse
import concurrent.futures
import json
import os
import re
import sys
import threading
import time
import urllib.parse
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from merge import ascii_fold, normalize_title  # noqa: E402
from netutil import BROWSER_UA, BudgetExceeded, Http, HttpError, HttpResponse  # noqa: E402

PROJECT_ROOT = HERE.parent.parent
DEFAULT_CATALOG = PROJECT_ROOT / "catalog" / "xeno-catalog.json"
DEFAULT_RESULTS = PROJECT_ROOT / "catalog" / "snapshots" / "audit" / "results.json"
ARCHIVE_METADATA = "https://archive.org/metadata/"
ARCHIVE_DOWNLOAD_RE = re.compile(r"^https?://(?:www\.)?archive\.org/download/([^/?#]+)/(.+)$")
HOST_INTERVALS = {"archive.org": 0.34, "raw.githubusercontent.com": 0.2}
SIZE_TOLERANCE = 1024 * 1024
HARD_STATUSES = (401, 403, 404, 410)
VERDICTS = ("ok", "flaky", "dead", "page")
SAVE_EVERY = 25


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _age_days(iso: str, now: datetime | None = None) -> float:
    try:
        then = datetime.fromisoformat((iso or "").replace("Z", "+00:00"))
    except ValueError:
        return 1e9
    return ((now or datetime.now(timezone.utc)) - then).total_seconds() / 86400.0


# --------------------------------------------------------------------------- #
# Verdict logic (pure, unit-tested)
# --------------------------------------------------------------------------- #

@dataclass
class Outcome:
    """What one probe observed. ``kind``: ok | page | hard | soft | wrong_size."""
    kind: str
    status: int = 0
    size: int = 0
    content_type: str = ""
    detail: str = ""


def decide(previous: dict[str, Any] | None, outcome: Outcome, checked_at: str) -> dict[str, Any]:
    """Next results record from the previous one and a fresh outcome (§17.12 rules)."""
    prev_failures = int((previous or {}).get("failures") or 0)
    if outcome.kind == "ok":
        verdict, failures = "ok", 0
    elif outcome.kind == "page":
        verdict, failures = "page", 0
    elif outcome.kind == "wrong_size":
        verdict, failures = "dead", max(prev_failures, 2)
    elif outcome.kind == "hard":
        failures = prev_failures + 1
        verdict = "dead" if failures >= 2 else "flaky"
    else:  # soft: 5xx / timeout / connection error — never kills a link on its own
        verdict, failures = "flaky", prev_failures
    return {
        "verdict": verdict, "status": int(outcome.status), "checkedAt": checked_at, "size": int(outcome.size or 0),
        "contentType": (outcome.content_type or "")[:60], "failures": failures, "detail": (outcome.detail or "")[:160],
    }


def needs_check(record: dict[str, Any] | None, recheck_days: float, now: datetime | None = None) -> bool:
    if not record:
        return True
    verdict = record.get("verdict")
    if verdict not in VERDICTS:
        return True
    if verdict in ("flaky", "page"):
        return True
    if verdict == "dead":
        return _age_days(str(record.get("checkedAt") or ""), now) > recheck_days * 4   # a dead link gets a late retry
    return _age_days(str(record.get("checkedAt") or ""), now) > recheck_days


def is_html(content_type: str) -> bool:
    ct = (content_type or "").lower()
    return "text/html" in ct or "application/xhtml" in ct


def size_matches(expected: int, actual: int) -> bool:
    if expected <= 0 or actual <= 0:
        return True
    return abs(expected - actual) <= SIZE_TOLERANCE


def page_matches(body_text: str, title: str, title_ids: list[str]) -> bool:
    """A page passes when it names one of the title ids or the game's (normalized) title."""
    text = body_text or ""
    for tid in title_ids:
        if tid and tid.upper() in text.upper():
            return True
    want = normalize_title(title)
    if not want:
        return False
    folded = re.sub(r"[^a-z0-9]+", " ", ascii_fold(text).lower())
    return f" {want} " in f" {folded} "


# --------------------------------------------------------------------------- #
# Planning
# --------------------------------------------------------------------------- #

@dataclass
class Check:
    url: str
    kind: str                 # archive | direct | page
    title: str = ""
    title_ids: list[str] = field(default_factory=list)
    expected_size: int = 0
    md5: str = ""
    sha1: str = ""
    identifier: str = ""      # archive.org
    name: str = ""            # archive.org file name (unquoted)
    game_id: str = ""


def classify(release: dict[str, Any], source_kind: str) -> str:
    url = str(release.get("url") or "")
    if ARCHIVE_DOWNLOAD_RE.match(url):
        return "archive"
    if release.get("format") == "PAGE" or source_kind != "direct":
        return "page"
    return "direct"


def plan(doc: dict[str, Any], results: dict[str, dict[str, Any]], recheck_days: float, limit: int = 0,
         now: datetime | None = None) -> list[Check]:
    """Checks for every release that needs one, never-checked first, then flaky/page, then stale ok."""
    kinds = {str(s.get("id")): str(s.get("kind") or "page") for s in doc.get("sources") or [] if isinstance(s, dict)}
    out: list[tuple[int, int, Check]] = []
    seen: set[str] = set()
    for gi, g in enumerate(doc.get("games") or []):
        title = str(g.get("title") or "")
        tids = [str(t) for t in (g.get("titleIds") or [])]
        for r in g.get("releases") or []:
            url = str(r.get("url") or "")
            if not url or url in seen:
                continue
            seen.add(url)
            rec = results.get(url)
            if not needs_check(rec, recheck_days, now):
                continue
            kind = classify(r, kinds.get(str(r.get("sourceId")), "page"))
            chk = Check(url=url, kind=kind, title=title, title_ids=[t for t in [str(r.get("titleId") or "")] + tids if t],
                        expected_size=int(r.get("sizeBytes") or 0), md5=str(r.get("md5") or ""), sha1=str(r.get("sha1") or ""),
                        game_id=str(g.get("id") or ""))
            m = ARCHIVE_DOWNLOAD_RE.match(url)
            if m:
                chk.identifier = urllib.parse.unquote(m.group(1))
                chk.name = urllib.parse.unquote(m.group(2).split("?", 1)[0])
            prio = 0 if rec is None else (1 if rec.get("verdict") in ("flaky", "page") else 2)
            out.append((prio, gi, chk))
    out.sort(key=lambda t: (t[0], t[1], t[2].url))
    checks = [c for _, _, c in out]
    return checks[:limit] if limit > 0 else checks


# --------------------------------------------------------------------------- #
# Probes
# --------------------------------------------------------------------------- #

class Auditor:
    def __init__(self, http: Http, *, timeout: float = 20.0, archive_base: str = ARCHIVE_METADATA,
                 log: Callable[[str], None] = print):
        self.http = http
        self.timeout = timeout
        self.archive_base = archive_base.rstrip("/") + "/"
        self.log = log
        self._meta_cache: dict[str, tuple[int, dict[str, Any] | None]] = {}
        self._meta_lock = threading.Lock()
        self._meta_inflight: dict[str, threading.Lock] = {}

    # -- archive.org ---------------------------------------------------------
    def _metadata(self, identifier: str, deadline: float | None) -> tuple[int, dict[str, Any] | None]:
        with self._meta_lock:
            if identifier in self._meta_cache:
                return self._meta_cache[identifier]
            gate = self._meta_inflight.setdefault(identifier, threading.Lock())
        with gate:   # workers asking for the same item wait for the one fetch instead of repeating it
            with self._meta_lock:
                if identifier in self._meta_cache:
                    return self._meta_cache[identifier]
            return self._metadata_fetch(identifier, deadline)

    def _metadata_fetch(self, identifier: str, deadline: float | None) -> tuple[int, dict[str, Any] | None]:
        try:
            resp = self.http.request("GET", self.archive_base + urllib.parse.quote(identifier), timeout=self.timeout,
                                     max_bytes=32 * 1024 * 1024, deadline=deadline)
        except HttpError as e:
            self.log(f"archive metadata {identifier}: {e}")
            return 0, None
        doc: dict[str, Any] | None = None
        if resp.status == 200:
            try:
                parsed = json.loads(resp.body.decode("utf-8", "replace"))
                doc = parsed if isinstance(parsed, dict) else {}
            except ValueError:
                doc = {}
        with self._meta_lock:
            self._meta_cache[identifier] = (resp.status, doc)
        return resp.status, doc

    def probe_archive(self, c: Check, deadline: float | None) -> Outcome:
        status, doc = self._metadata(c.identifier, deadline)
        if status == 0:
            return Outcome("soft", 0, detail="metadata unreachable")
        if status >= 500 or status == 429:
            return Outcome("soft", status, detail="metadata error")
        if status != 200 or doc is None:
            return Outcome("hard", status, detail="item missing")
        if not doc.get("files") and not doc.get("metadata"):
            return Outcome("hard", 404, detail="item empty (dark or removed)")
        for f in doc.get("files") or []:
            if not isinstance(f, dict):
                continue
            if str(f.get("name") or "") != c.name:
                continue
            try:
                size = int(f.get("size") or 0)
            except (TypeError, ValueError):
                size = 0
            if not size_matches(c.expected_size, size):
                return Outcome("wrong_size", 200, size, detail=f"size {size} != {c.expected_size}")
            for key in ("md5", "sha1"):
                mine, theirs = getattr(c, key), str(f.get(key) or "").lower()
                if mine and theirs and mine.lower() != theirs:
                    return Outcome("wrong_size", 200, size, detail=f"{key} mismatch")
            return Outcome("ok", 200, size, "application/octet-stream", "file listed in item metadata")
        return Outcome("hard", 404, detail="file not in item")

    # -- direct hosts --------------------------------------------------------
    def probe_direct(self, c: Check, deadline: float | None) -> Outcome:
        head: HttpResponse | None = None
        try:
            head = self.http.request("HEAD", c.url, timeout=self.timeout, deadline=deadline)
        except HttpError as e:
            return Outcome("soft", 0, detail=f"HEAD {e}")
        if head.status in HARD_STATUSES:
            return Outcome("hard", head.status, detail="HEAD refused")
        if head.status == 200 and is_html(head.header("content-type")):
            return Outcome("page", head.status, content_type=head.header("content-type"), detail="HEAD returned HTML")
        try:
            rng = self.http.request("GET", c.url, headers={"Range": "bytes=0-0"}, timeout=self.timeout,
                                    max_bytes=64 * 1024, deadline=deadline)
        except HttpError as e:
            return Outcome("soft", head.status, detail=f"range GET {e}")
        ct = rng.header("content-type") or head.header("content-type")
        if rng.status in HARD_STATUSES:
            return Outcome("hard", rng.status, content_type=ct, detail="range GET refused")
        if rng.status >= 500 or rng.status == 429 or rng.status == 0:
            return Outcome("soft", rng.status, content_type=ct, detail="range GET error")
        if rng.status not in (200, 206):
            return Outcome("hard", rng.status, content_type=ct, detail="unexpected status")
        if is_html(ct):
            return Outcome("page", rng.status, content_type=ct, detail="file URL answered with HTML")
        size = 0
        m = re.search(r"bytes\s+\d+-\d+/(\d+)", rng.header("content-range"))
        if m:
            size = int(m.group(1))
        elif head.status == 200 and head.header("content-length").isdigit():
            size = int(head.header("content-length"))
        elif rng.status == 200 and rng.header("content-length").isdigit():
            size = int(rng.header("content-length"))
        if not size_matches(c.expected_size, size):
            return Outcome("wrong_size", rng.status, size, ct, f"size {size} != {c.expected_size}")
        return Outcome("ok", rng.status, size, ct, "range " + str(rng.status))

    # -- pages ---------------------------------------------------------------
    def probe_page(self, c: Check, deadline: float | None) -> Outcome:
        try:
            resp = self.http.request("GET", c.url, timeout=self.timeout, max_bytes=2 * 1024 * 1024, deadline=deadline)
        except HttpError as e:
            return Outcome("soft", 0, detail=str(e))
        if resp.status in HARD_STATUSES:
            return Outcome("hard", resp.status, detail="page refused")
        if resp.status >= 500 or resp.status == 429:
            return Outcome("soft", resp.status, detail="page error")
        if resp.status != 200:
            return Outcome("hard", resp.status, detail="unexpected status")
        ct = resp.header("content-type")
        body = resp.body.decode("utf-8", "replace")
        if page_matches(body, c.title, c.title_ids):
            return Outcome("ok", 200, len(resp.body), ct, "page names the game")
        return Outcome("hard", 200, len(resp.body), ct, "page does not name the game (parked / captcha / moved)")

    def probe(self, c: Check, deadline: float | None) -> Outcome:
        if c.kind == "archive":
            return self.probe_archive(c, deadline)
        if c.kind == "direct":
            return self.probe_direct(c, deadline)
        return self.probe_page(c, deadline)


# --------------------------------------------------------------------------- #
# Results store + run loop
# --------------------------------------------------------------------------- #

def load_results(path: Path) -> dict[str, dict[str, Any]]:
    if not path.exists():
        return {}
    try:
        with open(path, "r", encoding="utf-8") as fh:
            doc = json.load(fh)
    except (OSError, ValueError):
        return {}
    rows = doc.get("results") if isinstance(doc, dict) else None
    return {str(k): v for k, v in (rows or {}).items() if isinstance(v, dict)} if isinstance(rows, dict) else {}


def save_results(path: Path, results: dict[str, dict[str, Any]], audited_at: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    counts = {v: 0 for v in VERDICTS}
    for r in results.values():
        if r.get("verdict") in counts:
            counts[r["verdict"]] += 1
    doc = {"version": 1, "auditedAt": audited_at, "counts": counts, "results": dict(sorted(results.items()))}
    tmp = path.with_suffix(".json.tmp")
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(doc, fh, ensure_ascii=False, indent=1, sort_keys=True)
        fh.write("\n")
    os.replace(tmp, path)


def audited_at_of(path: Path) -> str:
    try:
        with open(path, "r", encoding="utf-8") as fh:
            return str(json.load(fh).get("auditedAt") or "")
    except (OSError, ValueError, AttributeError):
        return ""


def prune_results(results: dict[str, dict[str, Any]], doc: dict[str, Any], keep_days: float = 60.0) -> int:
    """Forget URLs that left the catalog more than ``keep_days`` ago (keeps the committed file small)."""
    live = {str(r.get("url") or "") for g in doc.get("games") or [] for r in g.get("releases") or []}
    gone = [u for u, rec in results.items() if u not in live and _age_days(str(rec.get("checkedAt") or "")) > keep_days]
    for u in gone:
        del results[u]
    return len(gone)


def run_audit(auditor: Auditor, checks: list[Check], results: dict[str, dict[str, Any]], *, concurrency: int = 8,
              budget_seconds: float = 0.0, results_path: Path | None = None, log: Callable[[str], None] = print) -> dict[str, Any]:
    """Probe ``checks`` with a thread pool, updating ``results`` in place (saved every SAVE_EVERY)."""
    started = time.monotonic()
    deadline = started + budget_seconds if budget_seconds > 0 else None
    stats = {"planned": len(checks), "checked": 0, "ok": 0, "flaky": 0, "dead": 0, "page": 0, "budgetHit": False}
    lock = threading.Lock()
    audited_at = utc_now_iso()

    def work(c: Check) -> tuple[Check, Outcome | None]:
        if deadline is not None and time.monotonic() >= deadline:
            return c, None
        try:
            return c, auditor.probe(c, deadline)
        except BudgetExceeded:
            return c, None
        except Exception as e:  # noqa: BLE001 - one odd host must not end the audit
            return c, Outcome("soft", 0, detail=f"{type(e).__name__}: {e}")

    with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, concurrency)) as pool:
        futures = [pool.submit(work, c) for c in checks]
        for fut in concurrent.futures.as_completed(futures):
            c, outcome = fut.result()
            if outcome is None:
                stats["budgetHit"] = True
                continue
            rec = decide(results.get(c.url), outcome, utc_now_iso())
            rec["kind"] = c.kind
            with lock:
                results[c.url] = rec
                stats["checked"] += 1
                stats[rec["verdict"]] += 1
                if results_path is not None and stats["checked"] % SAVE_EVERY == 0:
                    save_results(results_path, results, audited_at)
    if results_path is not None:
        save_results(results_path, results, audited_at)
    stats["elapsed"] = round(time.monotonic() - started, 1)
    stats["auditedAt"] = audited_at
    log(f"audit: {stats['checked']}/{stats['planned']} checked in {stats['elapsed']}s — ok {stats['ok']}, "
        f"flaky {stats['flaky']}, dead {stats['dead']}, page {stats['page']}"
        + (" (budget reached; the rest waits for the next run)" if stats["budgetHit"] else ""))
    return stats


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--catalog", default=str(DEFAULT_CATALOG))
    ap.add_argument("--results", default=str(DEFAULT_RESULTS))
    ap.add_argument("--budget-seconds", type=float, default=0.0, help="stop scheduling checks after N seconds (0 = no limit)")
    ap.add_argument("--concurrency", type=int, default=8)
    ap.add_argument("--timeout", type=float, default=20.0)
    ap.add_argument("--recheck-days", type=float, default=7.0)
    ap.add_argument("--limit", type=int, default=0, help="debug: audit at most N URLs")
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args(argv)

    def log(msg: str) -> None:
        if not args.quiet or msg.startswith("audit:"):
            print(msg, flush=True)

    try:
        with open(args.catalog, "r", encoding="utf-8") as fh:
            doc = json.load(fh)
    except (OSError, ValueError) as e:
        print(f"cannot read catalog {args.catalog}: {e}", file=sys.stderr)
        return 2
    results_path = Path(args.results)
    results = load_results(results_path)
    pruned = prune_results(results, doc)
    checks = plan(doc, results, args.recheck_days, args.limit)
    total = sum(len(g.get("releases") or []) for g in doc.get("games") or [])
    log(f"audit: {len(checks)} of {total} release URLs need a check ({len(results)} cached, {pruned} pruned); "
        f"concurrency {args.concurrency}, budget {args.budget_seconds or 'unlimited'}s")
    http = Http(user_agent=BROWSER_UA, min_interval=1.0, host_intervals=HOST_INTERVALS)
    auditor = Auditor(http, timeout=args.timeout, log=log)
    run_audit(auditor, checks, results, concurrency=args.concurrency, budget_seconds=args.budget_seconds,
              results_path=results_path, log=log)
    return 0


if __name__ == "__main__":
    sys.exit(main())
