"""Archive.org (online only): advancedsearch + item metadata → direct releases.

1. Seed identifiers: every ``archive.org/download/<id>/`` URL in the BlackBox
   snapshot and the previous catalog, the whole ``ps4-fpkg-collection-english-a``
   … ``-z`` series (the pattern those URLs follow), plus ``advancedsearch.php``
   hits for ``PPSA* OR CUSA* OR ffpfsc OR exfat OR "ps4 fpkg"`` in the software
   and data media types and ``identifier:ps4-fpkg-collection*``.
2. ``/metadata/<identifier>`` for each seed (4 workers, ~3 req/s): every file
   with a game extension becomes a release with name/size/md5/sha1 and the URL
   ``https://archive.org/download/<id>/<urlencoded name>``.

Title ids come from the file name or identifier, the format from the
extension, versions / regions / compat from the file name (merge.py helpers).
The source has no snapshot: the BlackBox snapshot already carries the curated
archive items, and an online run that fails keeps the previous catalog's
archive releases through the generic fallback.
"""
from __future__ import annotations

import concurrent.futures
import re
import urllib.parse

from merge import (
    GameDraft, clean_title, detect_kind, format_from_filename, make_release_id, normalize_title, parse_compat,
    parse_region, parse_title_ids, parse_version, platform_for_title_id,
)
from schema import Release
from sources.base import BudgetExceeded, HttpError, SourceContext, SourceSpec, read_json_file

SEARCH_URL = "https://archive.org/advancedsearch.php"
METADATA_URL = "https://archive.org/metadata/"
DOWNLOAD_URL = "https://archive.org/download/"
THUMB_URL = "https://archive.org/services/img/"
PROVIDER = "Archive.org"
SOURCE_ID = "archive"
ID_PREFIX = "ia"
QUERIES = (
    '(PPSA* OR CUSA* OR ffpfsc OR exfat OR "ps4 fpkg") AND mediatype:(software OR data)',
    "identifier:ps4-fpkg-collection*",
)
SEARCH_ROWS = 500
SEARCH_PAGES = 6
MAX_IDENTIFIERS = 2500
WORKERS = 4
_DOWNLOAD_RE = re.compile(r"https?://archive\.org/download/([^/?#]+)/")
_COLLECTION_RE = re.compile(r"^(ps4-fpkg-collection-[a-z]+-)[a-z0-9]$")
_PLATFORM_HINT_RE = re.compile(r"\b(ps4|ps5)\b", re.I)


def seed_identifiers(ctx: SourceContext) -> list[str]:
    """Known identifiers from the snapshots and the previous catalog, with the collection series expanded."""
    ids: set[str] = set()
    for rel_path in ("blackbox/catalog.json", "blackbox/catalogue-v2.json", "blackbox/releases.json", "orbit/catalogue-v2.json"):
        path = ctx.snapshot(rel_path)
        if not path.exists():
            continue
        try:
            doc = read_json_file(path)
        except (OSError, ValueError):
            continue
        rows = doc.get("releases", []) if isinstance(doc, dict) else doc
        for row in rows:
            m = _DOWNLOAD_RE.match(str(row.get("url") or ""))
            if m:
                ids.add(urllib.parse.unquote(m.group(1)))
    if ctx.previous is not None:
        for g in ctx.previous.games:
            for r in g.releases:
                m = _DOWNLOAD_RE.match(r.url)
                if m:
                    ids.add(urllib.parse.unquote(m.group(1)))
    for ident in list(ids):
        m = _COLLECTION_RE.match(ident)
        if m:
            ids.update(m.group(1) + ch for ch in "abcdefghijklmnopqrstuvwxyz0123456789")
    return sorted(ids)


def search_identifiers(ctx: SourceContext) -> list[str]:
    found: list[str] = []
    for query in QUERIES:
        for page in range(1, SEARCH_PAGES + 1):
            if ctx.time_left() < 60:  # leave time for metadata calls
                return found
            params = urllib.parse.urlencode(
                [("q", query), ("fl[]", "identifier"), ("rows", str(SEARCH_ROWS)), ("page", str(page)),
                 ("sort[]", "publicdate desc"), ("output", "json")]
            )
            try:
                doc = ctx.get_json(f"{SEARCH_URL}?{params}", timeout=30)
            except (HttpError, BudgetExceeded) as e:
                ctx.info(f"search failed: {e}")
                return found
            docs = ((doc or {}).get("response") or {}).get("docs") or []
            for d in docs:
                ident = str(d.get("identifier") or "")
                if ident and ident not in found:
                    found.append(ident)
            if len(docs) < SEARCH_ROWS:
                break
    return found


def _title_from_filename(name: str) -> str:
    base = name.rsplit("/", 1)[-1]
    base = re.sub(r"\.[a-z0-9]{1,6}$", "", base, flags=re.I)
    base = re.sub(r"[-_]?(?:game|patch|update|dlc)[-_]\d[\d.]*[-_]r[0-9a-f]{6,}$", "", base, flags=re.I)
    return clean_title(base.replace("_", " "))


def releases_for_item(identifier: str, meta: dict) -> list[tuple[str, str, Release]]:
    """[(title, platform, release)] for every game file of one item."""
    files = [f for f in (meta.get("files") or []) if isinstance(f, dict)]
    item_meta = meta.get("metadata") or {}
    item_title = clean_title(str(item_meta.get("title") or ""))
    item_text = f"{identifier} {item_title} {item_meta.get('description') or ''}"
    game_files = [f for f in files if format_from_filename(str(f.get("name") or ""))]
    use_item_title = bool(item_title) and len(game_files) <= 3 and re.search(r"[a-z]", item_title, re.I)
    out: list[tuple[str, str, Release]] = []
    for f in game_files:
        name = str(f.get("name") or "")
        fname = name.rsplit("/", 1)[-1]
        fmt = format_from_filename(name)
        ids = parse_title_ids(fname) or parse_title_ids(identifier)
        title_id = ids[0] if ids else ""
        platform = platform_for_title_id(title_id)
        if not platform:
            hint = _PLATFORM_HINT_RE.search(item_text)
            platform = hint.group(1).upper() if hint else ("PS5" if fmt in ("FFPFSC", "exFAT", "FFPKG", "FFPFS") else "PS4")
        title = item_title if use_item_title else _title_from_filename(fname)
        if not title:
            title = item_title or _title_from_filename(identifier)
        kind = detect_kind("", fname, fmt)
        version = parse_version(fname)
        url = DOWNLOAD_URL + urllib.parse.quote(identifier) + "/" + urllib.parse.quote(name)
        try:
            size = int(f.get("size") or 0)
        except (TypeError, ValueError):
            size = 0
        rel = Release(
            id=make_release_id(ID_PREFIX, title_id, kind, version, url), url=url, sourceId=SOURCE_ID,
            provider=PROVIDER, format=fmt, kind=kind, titleId=title_id, region=parse_region(fname),
            version=version, filename=fname, sizeBytes=max(0, size), md5=str(f.get("md5") or ""),
            sha1=str(f.get("sha1") or ""), compat=" ".join(parse_compat(fname)),
            addedAt=str(item_meta.get("publicdate") or item_meta.get("addeddate") or "")[:10],
        )
        out.append((title, platform, rel))
    return out


def fetch_online(ctx: SourceContext) -> list[GameDraft]:
    identifiers = seed_identifiers(ctx)
    ctx.info(f"{len(identifiers)} seed identifiers")
    for ident in search_identifiers(ctx):
        if ident not in identifiers:
            identifiers.append(ident)
    identifiers = identifiers[:MAX_IDENTIFIERS]
    if ctx.limit:
        identifiers = identifiers[: ctx.limit]
    ctx.info(f"{len(identifiers)} identifiers to read")

    drafts: dict[tuple[str, str], GameDraft] = {}
    errors = 0
    done = 0

    def fetch(ident: str) -> tuple[str, dict | None, str]:
        try:
            return ident, ctx.get_json(METADATA_URL + urllib.parse.quote(ident), timeout=30), ""
        except BudgetExceeded as e:
            return ident, None, f"budget: {e}"
        except HttpError as e:
            return ident, None, str(e)

    with concurrent.futures.ThreadPoolExecutor(max_workers=WORKERS) as pool:
        futures = []
        for ident in identifiers:
            futures.append(pool.submit(fetch, ident))
        for fut in concurrent.futures.as_completed(futures):
            ident, meta, err = fut.result()
            if meta is None:
                errors += 1
                if err.startswith("budget"):
                    for f in futures:
                        f.cancel()
                continue
            done += 1
            for title, platform, rel in releases_for_item(ident, meta):
                key = (normalize_title(title), platform)
                d = drafts.get(key)
                if d is None:
                    d = GameDraft(source=SOURCE.id, title=title, platform=platform, priority=SOURCE.priority,
                                  coverFallback=THUMB_URL + urllib.parse.quote(ident))
                    drafts[key] = d
                d.releases.append(rel)
                if rel.titleId and rel.titleId not in d.titleIds:
                    d.titleIds.append(rel.titleId)
    ctx.info(f"metadata read for {done} items, {errors} failed")
    if done == 0:
        raise HttpError(METADATA_URL, 0, "no item metadata could be read")
    return [drafts[k] for k in sorted(drafts)]


SOURCE = SourceSpec(
    id="archive_org", name="Archive.org", priority=70, budget=300.0, release_source_ids=(SOURCE_ID,),
    online=fetch_online, snapshot=None,
    description="archive.org advancedsearch + item metadata (direct, verifiable files)",
)
