"""BlackBox (D3ATHLY/blackbox) public catalog.

Online: the four JSON files under ``catalog/`` of the GitHub repository, read
from raw.githubusercontent.com. Offline: the same files vendored under
``catalog/snapshots/blackbox/``. The files overlap heavily:

* ``catalog.json``      – flat release list with game metadata inlined (PS5 + PS4 PKG)
* ``games.json``        – richer game records (artwork fallbacks, banners)
* ``releases.json``     – verification details (hashes, checkedAt, browserUrl)
* ``catalogue-v2.json`` – Orbit-format envelope with homeOrder/pickOrder/region

Every release id seen in any file becomes one Release; releases are grouped by
BlackBox ``gameId`` + platform into drafts. Release ``sourceId`` stays what
BlackBox says (``archive`` / ``vikingfile``) because that is the host the user
downloads from.
"""
from __future__ import annotations

import re
import urllib.parse
from typing import Any

from merge import (
    GameDraft, clean_title, detect_kind, parse_compat, parse_region, parse_version, platform_for_title_id,
)
from schema import Release
from sources.base import HttpError, SourceContext, SourceSpec, read_json_file

RAW_BASE = "https://raw.githubusercontent.com/D3ATHLY/blackbox/main/catalog/"
FILES = ("catalog.json", "games.json", "releases.json", "catalogue-v2.json")
PROVIDER_TO_SOURCE = {"archive.org": "archive", "vikingfile": "vikingfile"}


def _as_list(doc: Any) -> list[dict]:
    if isinstance(doc, dict):
        doc = doc.get("releases") or doc.get("games") or []
    return [x for x in doc if isinstance(x, dict)] if isinstance(doc, list) else []


def _source_id(entry: dict) -> str:
    sid = str(entry.get("sourceId") or "").strip().lower()
    if sid:
        return sid
    return PROVIDER_TO_SOURCE.get(str(entry.get("provider") or "").strip().lower(), "")


def _verification(entry: dict, ver: dict | None) -> tuple[str, str, str, bool]:
    """(verifiedAt, md5, sha1, consoleVerified) from the richest verification block available."""
    v = (ver or {}).get("verification") or entry.get("sourceVerification") or {}
    if not isinstance(v, dict):   # catalog.json carries a method name string ("file-metadata") here
        v = {}
    hashes = v.get("sourceReportedHashes") or {}
    ok = v.get("httpStatus") in (200, 206) or v.get("rangeStatus") in (200, 206)
    verified_at = ""
    if v and ok:
        verified_at = str(v.get("checkedAt") or "")
    elif not v:
        verified_at = str(entry.get("sourceCheckedAt") or "")
    console = bool(entry.get("consoleVerified") or v.get("consoleVerified"))
    return verified_at[:10], str(hashes.get("md5") or ""), str(hashes.get("sha1") or ""), console


def entry_to_release(entry: dict, ver: dict | None = None, v2: dict | None = None) -> Release | None:
    url = str(entry.get("url") or "").strip()
    sid = _source_id(entry)
    if not url or not sid:
        return None
    filename = str(entry.get("filename") or "")
    fmt = str(entry.get("format") or "")
    # Collection items keep the descriptive name only in the URL ("Rayman Legends - [EU] [EN] [1.00].pkg").
    url_name = urllib.parse.unquote(url.rsplit("/", 1)[-1])
    verified_at, md5, sha1, console = _verification(entry, ver)
    region = (str(entry.get("region") or (v2 or {}).get("region") or "")
              or parse_region(filename) or parse_region(url_name))
    version = (str(entry.get("version") or (ver or {}).get("version") or "")
               or parse_version(filename) or parse_version(url_name))
    browser = str(entry.get("browserUrl") or (ver or {}).get("browserUrl") or (v2 or {}).get("browserUrl") or "")
    return Release(
        id=str(entry.get("id") or ""), url=url, sourceId=sid, provider=str(entry.get("provider") or ""),
        format=fmt, kind=detect_kind("", filename, fmt), titleId=str(entry.get("titleId") or ""),
        region=region, version=version, filename=filename, browserUrl=browser,
        sizeBytes=int(entry.get("sizeBytes") or 0), sha256=str(entry.get("sha256") or ""), md5=md5, sha1=sha1,
        verifiedAt=verified_at, consoleVerified=console,
        compat=" ".join(parse_compat(filename) or parse_compat(url_name)),
        addedAt=str(entry.get("addedAt") or "")[:10],
    )


_EXT_RE = re.compile(r"\.[a-z0-9]{1,6}$", re.I)
_COLLECTION_FILE_RE = re.compile(r"^(.*?)\s*-\s*\[(?:EU|US|JP|AS|EUR|USA|JPN|ASIA)\]", re.I)


def best_title(entry: dict, meta: dict, v2: dict) -> str:
    """A displayable title: the entry's own, else games.json / v2, else the file name in the URL.

    BlackBox's PS4 collection entries sometimes carry only the title id as
    ``title`` ("CUSA00031") while the URL still names the game
    ("Rayman Legends - [EU] [EN] [1.00].pkg"); that name is recovered here.
    """
    for cand in (entry.get("title"), meta.get("title"), v2.get("title")):
        if cand and clean_title(str(cand)):
            return str(cand)
    url = str(entry.get("url") or "")
    base = urllib.parse.unquote(url.rsplit("/", 1)[-1]) if "/" in url else ""
    for cand in (base, str(entry.get("filename") or "")):
        cand = _EXT_RE.sub("", cand)
        m = _COLLECTION_FILE_RE.match(cand)
        if m:
            cand = m.group(1)
        if clean_title(cand):
            return clean_title(cand)
    game_id = re.sub(r"-(ps4|ps5)$", "", str(entry.get("gameId") or ""))
    return game_id.replace("-", " ").title() if game_id else ""


def _platform(entry: dict) -> str:
    p = str(entry.get("platform") or "").upper()
    if p in ("PS4", "PS5"):
        return p
    return platform_for_title_id(str(entry.get("titleId") or "")) or "PS5"


def entries_to_drafts(entries: list[dict], games_meta: dict[str, dict], verifications: dict[str, dict],
                      v2_by_id: dict[str, dict], *, source_id: str, priority: int) -> list[GameDraft]:
    """Group release entries by BlackBox gameId + platform into drafts with merged game metadata."""
    groups: dict[tuple[str, str], GameDraft] = {}
    for e in entries:
        rid = str(e.get("id") or "")
        rel = entry_to_release(e, verifications.get(rid), v2_by_id.get(rid))
        if rel is None:
            continue
        game_id = str(e.get("gameId") or "")
        meta = games_meta.get(game_id, {})
        v2 = v2_by_id.get(rid, {})
        platform = _platform(e)
        title = best_title(e, meta, v2)
        key = (game_id or rel.url, platform)
        d = groups.get(key)
        if d is None:
            banner = meta.get("banner") or {}
            candidates = meta.get("artworkCandidates") or []
            d = GameDraft(
                source=source_id, title=title, platform=platform, priority=priority, slugHint=game_id,
                titleIds=[rel.titleId] if rel.titleId else [],
                region=str(e.get("region") or v2.get("region") or ""),
                genres=[g for g in (e.get("genre"), meta.get("genre"), v2.get("genre")) if g],
                tagline=str(e.get("tagline") or meta.get("tagline") or v2.get("tagline") or ""),
                description=str(e.get("description") or meta.get("description") or v2.get("description") or ""),
                publisher=str(e.get("publisher") or meta.get("publisher") or v2.get("publisher") or ""),
                releaseDate=str(e.get("releaseDate") or meta.get("releaseDate") or v2.get("releaseDate") or "")[:10],
                addedAt=str(e.get("addedAt") or meta.get("addedAt") or v2.get("addedAt") or "")[:10],
                cover=str(e.get("cover") or meta.get("cover") or v2.get("cover") or ""),
                coverFallback=str(e.get("coverFallback") or meta.get("coverFallback") or v2.get("coverFallback")
                                  or (candidates[0] if candidates else "")),
                hero=str(e.get("hero") or meta.get("hero") or v2.get("hero") or banner.get("url") or ""),
                heroFallback=str(e.get("heroFallback") or meta.get("heroFallback") or v2.get("heroFallback")
                                 or banner.get("url") or ""),
                artworkLayout=str(e.get("artworkLayout") or meta.get("artworkLayout") or ""),
            )
            groups[key] = d
        elif not d.title and title:
            d.title = title
        if rel.titleId and rel.titleId not in d.titleIds:
            d.titleIds.append(rel.titleId)
        for order_key in ("homeOrder", "pickOrder"):
            for src in (e, v2, meta):
                val = src.get(order_key)
                if isinstance(val, int) and val > 0 and (getattr(d, order_key) == 0 or val < getattr(d, order_key)):
                    setattr(d, order_key, val)
        d.releases.append(rel)
    return [d for d in groups.values() if d.title]


def build_drafts(files: dict[str, Any], *, source_id: str = "blackbox", priority: int = 100) -> list[GameDraft]:
    """``files`` maps each FILES name to its parsed JSON (missing optional files are fine)."""
    catalog = _as_list(files.get("catalog.json"))
    games_meta = {str(g.get("id")): g for g in _as_list(files.get("games.json")) if g.get("id")}
    verifications = {str(r.get("id")): r for r in _as_list(files.get("releases.json")) if r.get("id")}
    v2_by_id = {str(r.get("id")): r for r in _as_list(files.get("catalogue-v2.json")) if r.get("id")}

    seen_ids = {str(e.get("id")) for e in catalog}
    seen_urls = {str(e.get("url")) for e in catalog}
    entries = list(catalog)
    # Releases only present in catalogue-v2 / releases.json still ship.
    for extra in (v2_by_id.values(), verifications.values()):
        for r in extra:
            rid, url = str(r.get("id")), str(r.get("url"))
            if rid in seen_ids or url in seen_urls:
                continue
            e = dict(r)
            meta = games_meta.get(str(r.get("gameId") or ""), {})
            e.setdefault("title", meta.get("title", ""))
            seen_ids.add(rid)
            seen_urls.add(url)
            entries.append(e)
    return entries_to_drafts(entries, games_meta, verifications, v2_by_id, source_id=source_id, priority=priority)


def load_snapshot(ctx: SourceContext) -> list[GameDraft]:
    files: dict[str, Any] = {}
    for name in FILES:
        path = ctx.snapshot("blackbox/" + name)
        if path.exists():
            files[name] = read_json_file(path)
    if "catalog.json" not in files:
        raise FileNotFoundError(str(ctx.snapshot("blackbox/catalog.json")))
    return ctx.truncate(build_drafts(files, source_id=SOURCE.id, priority=SOURCE.priority))


def fetch_online(ctx: SourceContext) -> list[GameDraft]:
    files: dict[str, Any] = {}
    for name in FILES:
        try:
            files[name] = ctx.get_json(RAW_BASE + name, timeout=30, max_bytes=64 * 1024 * 1024)
            ctx.info(f"fetched {name}")
        except HttpError as e:
            if name == "catalog.json":
                raise
            ctx.info(f"optional {name} unavailable: {e}")
    return ctx.truncate(build_drafts(files, source_id=SOURCE.id, priority=SOURCE.priority))


SOURCE = SourceSpec(
    id="blackbox", name="BlackBox catalog", priority=100, budget=90.0,
    release_source_ids=("archive", "vikingfile"), online=fetch_online, snapshot=load_snapshot,
    description="D3ATHLY/blackbox catalog JSON (Archive.org + Vikingfile releases)",
)
