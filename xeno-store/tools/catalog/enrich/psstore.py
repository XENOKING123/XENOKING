"""PlayStation Store page enrichment (SPEC §17.1, best effort, online only).

Only games that already carry a ``psStoreUrl`` (a concept/product URL from the seeds or a source)
are visited: ``https://store.playstation.com/en-us/concept/<id>`` or ``/product/<id>``. The page
embeds its data as JSON (``<script id="__NEXT_DATA__">``); screenshots are the media entries with
role ``SCREENSHOT`` and the description is the long/short description of the product. The parser
walks the JSON generically so a layout change degrades to "nothing found" instead of an error.
Results are cached in ``catalog/snapshots/enrich/psstore-cache.json`` keyed by URL.
"""
from __future__ import annotations

import html
import json
import re
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

from enrich.steam import html_to_text
from netutil import BudgetExceeded, Http, HttpError
from schema import Game

CACHE_FILE = Path("catalog/snapshots/enrich/psstore-cache.json")
HOST_INTERVAL = 2.0
MAX_SCREENSHOTS = 10
MISS_TTL_DAYS = 30
ENTRY_TTL_DAYS = 180
_NEXT_DATA_RE = re.compile(r'<script[^>]+id="__NEXT_DATA__"[^>]*>(.*?)</script>', re.S | re.I)
_OG_RE = re.compile(r'<meta\s+(?:property|name)="og:(image|description|title)"\s+content="([^"]*)"', re.I)
_STORE_URL_RE = re.compile(r"^https://store\.playstation\.com/[a-z]{2}-[a-z]{2}/(?:concept|product)/[A-Za-z0-9_\-]+/?$")


def _now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _age_days(iso: str) -> float:
    try:
        then = datetime.fromisoformat((iso or "").replace("Z", "+00:00"))
    except ValueError:
        return 1e9
    return (datetime.now(timezone.utc) - then).total_seconds() / 86400.0


def _walk(node: Any, shots: list[str], descs: list[tuple[int, str]], depth: int = 0) -> None:
    if depth > 40:
        return
    if isinstance(node, dict):
        role = str(node.get("role") or node.get("type") or "").upper()
        url = node.get("url")
        if isinstance(url, str) and url.startswith("https://") and role in ("SCREENSHOT", "GAMEHUB_COVER_ART") \
                and (str(node.get("__typename") or "Media") == "Media" or "media" in str(node.get("__typename")).lower()):
            if role == "SCREENSHOT" and url not in shots:
                shots.append(url)
        for key in ("descriptions",):
            for d in node.get(key) or [] if isinstance(node.get(key), list) else []:
                if isinstance(d, dict) and isinstance(d.get("value"), str):
                    kind = str(d.get("type") or "").upper()
                    descs.append((0 if kind == "LONG" else 1 if kind == "SHORT" else 2, d["value"]))
        if isinstance(node.get("description"), str) and len(node["description"]) > 40:
            descs.append((3, node["description"]))
        for v in node.values():
            _walk(v, shots, descs, depth + 1)
    elif isinstance(node, list):
        for v in node:
            _walk(v, shots, descs, depth + 1)


def parse_store_page(page_html: str) -> dict[str, Any]:
    """{screenshots:[...], about:str, cover:str} from a store page; empty values when nothing parses."""
    shots: list[str] = []
    descs: list[tuple[int, str]] = []
    m = _NEXT_DATA_RE.search(page_html or "")
    if m:
        try:
            _walk(json.loads(m.group(1)), shots, descs)
        except ValueError:
            pass
    about = ""
    if descs:
        descs.sort(key=lambda d: d[0])
        about = html_to_text(descs[0][1])
    cover = ""
    for kind, content in _OG_RE.findall(page_html or ""):
        content = html.unescape(content)
        if kind == "image" and content.startswith("https://"):
            cover = content
        elif kind == "description" and not about and len(content) > 40:
            about = html_to_text(content)
    return {"screenshots": shots[:MAX_SCREENSHOTS], "about": about, "cover": cover}


class PsStoreCache:
    def __init__(self, path: Path):
        self.path = path
        self.entries: dict[str, dict[str, Any]] = {}
        self.dirty = False
        if path.exists():
            try:
                with open(path, "r", encoding="utf-8") as fh:
                    doc = json.load(fh)
                if isinstance(doc, dict) and isinstance(doc.get("entries"), dict):
                    self.entries = {str(k): v for k, v in doc["entries"].items() if isinstance(v, dict)}
            except (OSError, ValueError):
                self.entries = {}

    def save(self) -> None:
        if not self.dirty:
            return
        self.path.parent.mkdir(parents=True, exist_ok=True)
        doc = {"version": 1, "updatedAt": _now_iso(), "entries": dict(sorted(self.entries.items()))}
        tmp = self.path.with_suffix(".json.tmp")
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(doc, fh, ensure_ascii=False, indent=1, sort_keys=True)
            fh.write("\n")
        tmp.replace(self.path)
        self.dirty = False

    def get(self, url: str) -> dict[str, Any] | None:
        e = self.entries.get(url)
        return e if e and not e.get("miss") else None

    def needs_lookup(self, url: str) -> bool:
        e = self.entries.get(url)
        if e is None:
            return True
        return _age_days(str(e.get("fetchedAt") or "")) > (MISS_TTL_DAYS if e.get("miss") else ENTRY_TTL_DAYS)

    def put(self, url: str, entry: dict[str, Any] | None) -> None:
        if entry and (entry.get("screenshots") or entry.get("about")):
            entry = dict(entry, fetchedAt=_now_iso())
        else:
            entry = {"miss": True, "fetchedAt": _now_iso()}
        self.entries[url] = entry
        self.dirty = True


def apply_entry(game: Game, e: dict[str, Any]) -> None:
    if not game.screenshots:
        game.screenshots = [u for u in e.get("screenshots") or [] if isinstance(u, str)][:MAX_SCREENSHOTS]
    if not game.about:
        game.about = str(e.get("about") or "")
    if not game.hero and isinstance(e.get("cover"), str) and e["cover"] != game.cover:
        game.heroFallback = game.heroFallback or e["cover"]


def enricher(cache: PsStoreCache) -> Callable[[Game], None]:
    def fn(game: Game) -> None:
        if game.psStoreUrl:
            e = cache.get(game.psStoreUrl)
            if e:
                apply_entry(game, e)
    return fn


def run(http: Http, cache: PsStoreCache, urls: list[str], budget_seconds: float,
        log: Callable[[str], None] = print) -> dict[str, int]:
    """Fetch store pages that need a (re)check until the budget is spent. Never raises."""
    http.host_intervals.setdefault("store.playstation.com", HOST_INTERVAL)
    stats = {"looked": 0, "hits": 0, "misses": 0, "errors": 0, "skipped": 0}
    started = time.monotonic()
    deadline = started + max(0.0, budget_seconds)
    seen: set[str] = set()
    try:
        for url in urls:
            if url in seen or not _STORE_URL_RE.match(url):
                continue
            seen.add(url)
            if not cache.needs_lookup(url):
                stats["skipped"] += 1
                continue
            if time.monotonic() >= deadline:
                break
            try:
                page = http.text(url, timeout=25, retries=1, deadline=deadline, max_bytes=6 * 1024 * 1024)
            except BudgetExceeded:
                break
            except HttpError as e:
                stats["errors"] += 1
                if e.status in (403, 429) or stats["errors"] >= 10:
                    log(f"[psstore] {e}; stopping this run")
                    break
                if e.status == 404:
                    cache.put(url, None)
                continue
            entry = parse_store_page(page)
            stats["looked"] += 1
            if entry["screenshots"] or entry["about"]:
                stats["hits"] += 1
            else:
                stats["misses"] += 1
            cache.put(url, entry)
            if stats["looked"] % 20 == 0:
                cache.save()
    finally:
        cache.save()
    log(f"[psstore] {stats['looked']} pages ({stats['hits']} hits, {stats['misses']} misses, {stats['errors']} errors) "
        f"in {time.monotonic() - started:.0f}s; cache has {len(cache.entries)} entries")
    return stats
