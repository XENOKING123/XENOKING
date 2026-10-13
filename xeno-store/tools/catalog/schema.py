"""Catalog schema v1 (SPEC §10): dataclasses, serialization and validation.

Everything the pipeline writes to ``catalog/xeno-catalog.json`` goes through the
types in this module. ``validate_catalog`` is the loud gate used by
``build_catalog.py --validate`` and by CI: it returns a list of human readable
error strings and an empty list means the document is valid.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field, asdict
from datetime import date, datetime
from typing import Any

SCHEMA_VERSION = 1
CATALOG_NAME = "XENO STORE Catalog"

# HOMEBREW entries are pkg-zone apps/emulators/tools (SPEC §17.21): same record
# shape as a game plus category/author/supportsPs5, releases of kind "app".
PLATFORMS = ("PS4", "PS5", "HOMEBREW")
GAME_PLATFORMS = ("PS4", "PS5")

# §10 list plus FFPFS, which §3 names as a valid image extension the engine
# routes to <root>/homebrew/. Keeping it here means a real-world file is never
# mislabelled as a different format just to pass validation.
FORMATS = ("FFPFSC", "exFAT", "PKG", "FPKG", "FFPKG", "FFPFS", "ZIP", "RAR", "7z", "PAGE")
# "backport" (§17.13) = a build patched to run on lower firmware; "app" (§17.21) = homebrew package.
KINDS = ("game", "update", "dlc", "bundle", "backport", "app")
HEALTHS = ("", "ok", "flaky", "dead", "page")   # "" = not audited yet (§17.12)
HOMEBREW_CATEGORIES = ("Emulator", "Tool", "Game", "Media", "Utility", "Launcher", "Payload", "Other")
MAX_SCREENSHOTS = 10

# The clean genre vocabulary every source's labels are mapped onto (merge.py).
GENRES = (
    "Action", "Adventure", "RPG", "Horror", "Racing", "Shooter", "Sports",
    "Strategy", "Simulation", "Fighting", "Puzzle", "Platformer", "Indie",
    "Family", "Music",
)

ARTWORK_LAYOUTS = ("wide", "ambient", "portrait")

_ISO_DATE_RE = re.compile(
    r"^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2}))?$"
)
_GAME_ID_RE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*-(ps4|ps5|homebrew)$")
_FW_RE = re.compile(r"^\d{1,2}\.(?:\d{2}|xx)\+?$")   # "9.00", "5.05", "11.xx+"
_RELEASE_ID_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{0,119}$")
_TITLE_ID_RE = re.compile(r"^[A-Z]{4}\d{5}$")
_HEX_RE = re.compile(r"^[0-9a-f]*$")


def is_iso_date(value: str) -> bool:
    """True for '' (dates may be empty), 'YYYY-MM-DD' or a full ISO-8601 timestamp."""
    if value == "":
        return True
    if not isinstance(value, str) or not _ISO_DATE_RE.match(value):
        return False
    try:
        if len(value) == 10:
            date.fromisoformat(value)
        else:
            datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return False
    return True


@dataclass
class SourceInfo:
    id: str
    name: str
    kind: str = "page"            # direct | browser | page
    homepage: str = ""
    notice: str = ""
    password: str = ""

    def to_dict(self) -> dict[str, Any]:
        d = {"id": self.id, "name": self.name, "kind": self.kind, "homepage": self.homepage}
        if self.notice:
            d["notice"] = self.notice
        if self.password:
            d["password"] = self.password
        return d

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "SourceInfo":
        return cls(
            id=str(d.get("id", "")), name=str(d.get("name", "")), kind=str(d.get("kind", "page")),
            homepage=str(d.get("homepage", "")), notice=str(d.get("notice", "")),
            password=str(d.get("password", "")),
        )


@dataclass
class Release:
    id: str
    url: str
    sourceId: str
    provider: str = ""
    format: str = "PAGE"
    kind: str = "game"
    titleId: str = ""
    region: str = ""
    version: str = ""
    filename: str = ""
    browserUrl: str = ""
    mirrors: list[str] = field(default_factory=list)
    sizeBytes: int = 0
    sha256: str = ""
    md5: str = ""
    sha1: str = ""
    verifiedAt: str = ""
    consoleVerified: bool = False
    compat: str = ""
    password: str = ""
    notes: str = ""
    addedAt: str = ""
    health: str = ""          # §17.12 audit verdict: "" (not audited) | ok | flaky | page (dead ones are dropped)
    backportFw: str = ""      # §17.13 target firmware of a backport ("5.05", "9.00", "4.xx")
    requiresFw: str = ""      # §17.13 minimum firmware parsed from labels ("11.xx+", "13.60")

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "Release":
        return cls(
            id=str(d.get("id", "")), url=str(d.get("url", "")), sourceId=str(d.get("sourceId", "")),
            provider=str(d.get("provider", "")), format=str(d.get("format", "PAGE")),
            kind=str(d.get("kind", "game")), titleId=str(d.get("titleId") or ""),
            region=str(d.get("region") or ""), version=str(d.get("version") or ""),
            filename=str(d.get("filename") or ""), browserUrl=str(d.get("browserUrl") or ""),
            mirrors=[str(m) for m in (d.get("mirrors") or [])], sizeBytes=int(d.get("sizeBytes") or 0),
            sha256=str(d.get("sha256") or ""), md5=str(d.get("md5") or ""), sha1=str(d.get("sha1") or ""),
            verifiedAt=str(d.get("verifiedAt") or ""), consoleVerified=bool(d.get("consoleVerified", False)),
            compat=str(d.get("compat") or ""), password=str(d.get("password") or ""),
            notes=str(d.get("notes") or ""), addedAt=str(d.get("addedAt") or ""),
            health=str(d.get("health") or ""), backportFw=str(d.get("backportFw") or ""),
            requiresFw=str(d.get("requiresFw") or ""),
        )


def _opt_int(v: Any) -> int | None:
    if v is None or isinstance(v, bool):
        return None
    try:
        return int(v)
    except (TypeError, ValueError):
        return None


@dataclass
class Game:
    id: str
    slug: str
    title: str
    platform: str
    titleIds: list[str] = field(default_factory=list)
    region: str = ""
    genres: list[str] = field(default_factory=list)
    tagline: str = ""
    description: str = ""
    publisher: str = ""
    developer: str = ""
    releaseDate: str = ""
    addedAt: str = ""
    cover: str = ""
    coverFallback: str = ""
    hero: str = ""
    heroFallback: str = ""
    artworkLayout: str = "wide"
    tint: str = "#1a2a5a"
    sizeMin: int = 0
    sizeMax: int = 0
    featured: int = 0
    popularity: float = 0.0
    verified: bool = False
    compat: list[str] = field(default_factory=list)
    # §17.1 additions (all optional for readers; always present in the file).
    screenshots: list[str] = field(default_factory=list)
    about: str = ""
    metacritic: int | None = None
    features: list[str] = field(default_factory=list)
    ageRating: int | None = None
    languages: list[str] = field(default_factory=list)
    year: int = 0
    updates: int = 0
    dlc: int = 0
    backports: int = 0        # §17.13
    series: str = ""
    steamId: int = 0
    # §17.9 seeds
    cheats: int = 0
    conceptId: int = 0
    psStoreUrl: str = ""
    # §17.21 homebrew apps (empty / false for games)
    category: str = ""
    author: str = ""
    supportsPs5: bool = False
    releases: list[Release] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        d = asdict(self)
        d["releases"] = [r.to_dict() for r in self.releases]
        return d

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "Game":
        return cls(
            id=str(d.get("id", "")), slug=str(d.get("slug", "")), title=str(d.get("title", "")),
            platform=str(d.get("platform", "")), titleIds=[str(t) for t in (d.get("titleIds") or [])],
            region=str(d.get("region") or ""), genres=[str(g) for g in (d.get("genres") or [])],
            tagline=str(d.get("tagline") or ""), description=str(d.get("description") or ""),
            publisher=str(d.get("publisher") or ""), developer=str(d.get("developer") or ""),
            releaseDate=str(d.get("releaseDate") or ""), addedAt=str(d.get("addedAt") or ""),
            cover=str(d.get("cover") or ""), coverFallback=str(d.get("coverFallback") or ""),
            hero=str(d.get("hero") or ""), heroFallback=str(d.get("heroFallback") or ""),
            artworkLayout=str(d.get("artworkLayout") or "wide"), tint=str(d.get("tint") or "#1a2a5a"),
            sizeMin=int(d.get("sizeMin") or 0), sizeMax=int(d.get("sizeMax") or 0),
            featured=int(d.get("featured") or 0), popularity=float(d.get("popularity") or 0.0),
            verified=bool(d.get("verified", False)), compat=[str(c) for c in (d.get("compat") or [])],
            screenshots=[str(u) for u in (d.get("screenshots") or [])], about=str(d.get("about") or ""),
            metacritic=_opt_int(d.get("metacritic")), features=[str(f) for f in (d.get("features") or [])],
            ageRating=_opt_int(d.get("ageRating")), languages=[str(l) for l in (d.get("languages") or [])],
            year=int(d.get("year") or 0), updates=int(d.get("updates") or 0), dlc=int(d.get("dlc") or 0),
            backports=int(d.get("backports") or 0), series=str(d.get("series") or ""),
            steamId=int(d.get("steamId") or 0), cheats=int(d.get("cheats") or 0),
            conceptId=int(d.get("conceptId") or 0), psStoreUrl=str(d.get("psStoreUrl") or ""),
            category=str(d.get("category") or ""), author=str(d.get("author") or ""),
            supportsPs5=bool(d.get("supportsPs5", False)),
            releases=[Release.from_dict(r) for r in (d.get("releases") or [])],
        )


@dataclass
class Catalog:
    revision: int
    generatedAt: str
    sources: list[SourceInfo] = field(default_factory=list)
    genres: list[str] = field(default_factory=list)
    games: list[Game] = field(default_factory=list)
    schemaVersion: int = SCHEMA_VERSION
    name: str = CATALOG_NAME

    def to_dict(self) -> dict[str, Any]:
        return {
            "schemaVersion": self.schemaVersion,
            "revision": self.revision,
            "generatedAt": self.generatedAt,
            "name": self.name,
            "sources": [s.to_dict() for s in self.sources],
            "genres": list(self.genres),
            "games": [g.to_dict() for g in self.games],
        }

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "Catalog":
        return cls(
            revision=int(d.get("revision") or 0), generatedAt=str(d.get("generatedAt") or ""),
            sources=[SourceInfo.from_dict(s) for s in (d.get("sources") or [])],
            genres=[str(g) for g in (d.get("genres") or [])],
            games=[Game.from_dict(g) for g in (d.get("games") or [])],
            schemaVersion=int(d.get("schemaVersion") or SCHEMA_VERSION),
            name=str(d.get("name") or CATALOG_NAME),
        )

    def release_count(self) -> int:
        return sum(len(g.releases) for g in self.games)


# --------------------------------------------------------------------------- #
# Validation
# --------------------------------------------------------------------------- #

def _is_http_url(u: Any) -> bool:
    return isinstance(u, str) and (u.startswith("http://") or u.startswith("https://")) and len(u) > 10


def validate_catalog(doc: dict[str, Any], max_errors: int = 200) -> list[str]:
    """Validate a catalog document (plain dict, as loaded from JSON).

    Fails loudly on: duplicate game ids, release without an http(s) URL, unknown
    sourceId, platform not PS4/PS5, negative sizes, missing title, non-ISO dates,
    plus structural problems (bad id format, unknown format/kind/genre, duplicate
    release ids inside a game, mirrors that are not URLs).
    """
    errors: list[str] = []

    def err(msg: str) -> None:
        if len(errors) < max_errors:
            errors.append(msg)
        elif len(errors) == max_errors:
            errors.append("... more errors omitted")

    if not isinstance(doc, dict):
        return ["catalog: root must be an object"]
    if doc.get("schemaVersion") != SCHEMA_VERSION:
        err(f"catalog: schemaVersion must be {SCHEMA_VERSION}, got {doc.get('schemaVersion')!r}")
    if not isinstance(doc.get("revision"), int) or doc.get("revision", 0) < 1:
        err(f"catalog: revision must be a positive integer, got {doc.get('revision')!r}")
    if not is_iso_date(str(doc.get("generatedAt", ""))) or not doc.get("generatedAt"):
        err(f"catalog: generatedAt must be an ISO timestamp, got {doc.get('generatedAt')!r}")
    if not isinstance(doc.get("name"), str) or not doc.get("name"):
        err("catalog: name is required")

    sources = doc.get("sources")
    source_ids: set[str] = set()
    if not isinstance(sources, list) or not sources:
        err("catalog: sources must be a non-empty list")
    else:
        for i, s in enumerate(sources):
            if not isinstance(s, dict) or not s.get("id") or not s.get("name"):
                err(f"sources[{i}]: id and name are required")
                continue
            if s["id"] in source_ids:
                err(f"sources[{i}]: duplicate source id {s['id']!r}")
            source_ids.add(s["id"])
            if s.get("kind") not in ("direct", "browser", "page"):
                err(f"sources[{i}] ({s['id']}): kind must be direct|browser|page")

    genres = doc.get("genres")
    if not isinstance(genres, list):
        err("catalog: genres must be a list")
        genres = []
    genre_set = set(genres)
    for g in genres:
        if g not in GENRES:
            err(f"catalog: genre {g!r} is not in the allowed vocabulary")

    games = doc.get("games")
    if not isinstance(games, list):
        return errors + ["catalog: games must be a list"]

    seen_ids: dict[str, int] = {}
    seen_urls: dict[str, str] = {}
    for gi, g in enumerate(games):
        where = f"games[{gi}]"
        if not isinstance(g, dict):
            err(f"{where}: must be an object")
            continue
        gid = g.get("id")
        where = f"games[{gi}] ({gid})"
        if not isinstance(gid, str) or not gid:
            err(f"{where}: id is required")
        else:
            if gid in seen_ids:
                err(f"{where}: duplicate game id (also games[{seen_ids[gid]}])")
            seen_ids.setdefault(gid, gi)
            if not _GAME_ID_RE.match(gid):
                err(f"{where}: id must look like <slug>-<ps4|ps5>")
        platform = g.get("platform")
        if platform not in PLATFORMS:
            err(f"{where}: platform must be PS4, PS5 or HOMEBREW, got {platform!r}")
        elif isinstance(gid, str) and gid and not gid.endswith("-" + platform.lower()):
            err(f"{where}: id suffix does not match platform {platform}")
        title = g.get("title")
        if not isinstance(title, str) or not title.strip():
            err(f"{where}: title is required")
        slug = g.get("slug")
        if not isinstance(slug, str) or not slug or (isinstance(gid, str) and gid != f"{slug}-{str(platform).lower()}"):
            err(f"{where}: slug must equal id without the platform suffix")
        for key in ("sizeMin", "sizeMax"):
            v = g.get(key, 0)
            if not isinstance(v, int) or isinstance(v, bool) or v < 0:
                err(f"{where}: {key} must be a non-negative integer, got {v!r}")
        if isinstance(g.get("sizeMin"), int) and isinstance(g.get("sizeMax"), int) and g["sizeMin"] > g["sizeMax"]:
            err(f"{where}: sizeMin > sizeMax")
        for key in ("releaseDate", "addedAt"):
            if not is_iso_date(str(g.get(key, ""))):
                err(f"{where}: {key} is not an ISO date: {g.get(key)!r}")
        for key in ("cover", "coverFallback", "hero", "heroFallback"):
            v = g.get(key, "")
            if v and not _is_http_url(v):
                err(f"{where}: {key} must be an http(s) URL or empty")
        if not isinstance(g.get("titleIds", []), list):
            err(f"{where}: titleIds must be a list")
        else:
            for t in g.get("titleIds", []):
                if not isinstance(t, str) or not _TITLE_ID_RE.match(t):
                    err(f"{where}: bad title id {t!r}")
        if not isinstance(g.get("genres", []), list):
            err(f"{where}: genres must be a list")
        else:
            for ge in g.get("genres", []):
                if ge not in genre_set:
                    err(f"{where}: genre {ge!r} not listed in catalog.genres")
        if not isinstance(g.get("featured", 0), int) or g.get("featured", 0) < 0:
            err(f"{where}: featured must be a non-negative integer")
        pop = g.get("popularity", 0.0)
        if not isinstance(pop, (int, float)) or isinstance(pop, bool) or pop < 0 or pop > 1:
            err(f"{where}: popularity must be a number in [0, 1]")
        if g.get("artworkLayout", "wide") not in ARTWORK_LAYOUTS:
            err(f"{where}: artworkLayout must be one of {ARTWORK_LAYOUTS}")
        tint = g.get("tint", "")
        if tint and not re.match(r"^#[0-9a-f]{6}$", str(tint)):
            err(f"{where}: tint must be #rrggbb")
        if not isinstance(g.get("compat", []), list):
            err(f"{where}: compat must be a list")
        _validate_phase2_game(g, where, err)

        releases = g.get("releases")
        if not isinstance(releases, list) or not releases:
            err(f"{where}: at least one release is required")
            continue
        seen_rids: set[str] = set()
        for ri, r in enumerate(releases):
            rw = f"{where}.releases[{ri}]"
            if not isinstance(r, dict):
                err(f"{rw}: must be an object")
                continue
            rid = r.get("id")
            if not isinstance(rid, str) or not _RELEASE_ID_RE.match(rid):
                err(f"{rw}: bad release id {rid!r}")
            elif rid in seen_rids:
                err(f"{rw}: duplicate release id {rid!r} inside the game")
            else:
                seen_rids.add(rid)
            url = r.get("url")
            if not _is_http_url(url):
                err(f"{rw}: url must be an http(s) URL, got {url!r}")
            elif "@" in url.split("://", 1)[1].split("/", 1)[0]:
                err(f"{rw}: url must not carry credentials")
            else:
                prev = seen_urls.get(url)
                if prev is not None and prev != gid:
                    err(f"{rw}: url already used by game {prev!r}")
                seen_urls.setdefault(url, gid)
            sid = r.get("sourceId")
            if sid not in source_ids:
                err(f"{rw}: unknown sourceId {sid!r}")
            if r.get("format") not in FORMATS:
                err(f"{rw}: format must be one of {FORMATS}, got {r.get('format')!r}")
            if r.get("kind") not in KINDS:
                err(f"{rw}: kind must be one of {KINDS}, got {r.get('kind')!r}")
            elif platform == "HOMEBREW" and r.get("kind") != "app":
                err(f"{rw}: HOMEBREW releases must have kind app")
            elif platform != "HOMEBREW" and r.get("kind") == "app":
                err(f"{rw}: kind app is only valid on HOMEBREW entries")
            if r.get("health", "") not in HEALTHS:
                err(f"{rw}: health must be one of {HEALTHS}, got {r.get('health')!r}")
            if r.get("health", "") == "dead":
                err(f"{rw}: dead releases must be dropped, not shipped")
            for key in ("backportFw", "requiresFw"):
                v = r.get(key, "")
                if not isinstance(v, str) or (v and not _FW_RE.match(v)):
                    err(f"{rw}: {key} must be a firmware tag like 9.00 / 11.xx+ or empty, got {v!r}")
            if r.get("kind") == "backport" and not r.get("backportFw"):
                err(f"{rw}: backport releases need backportFw")
            size = r.get("sizeBytes", 0)
            if not isinstance(size, int) or isinstance(size, bool) or size < 0:
                err(f"{rw}: sizeBytes must be a non-negative integer, got {size!r}")
            tid = r.get("titleId", "")
            if tid and not _TITLE_ID_RE.match(str(tid)):
                err(f"{rw}: bad titleId {tid!r}")
            for key in ("verifiedAt", "addedAt"):
                if not is_iso_date(str(r.get(key, ""))):
                    err(f"{rw}: {key} is not an ISO date: {r.get(key)!r}")
            for key, length in (("sha256", 64), ("md5", 32), ("sha1", 40)):
                v = str(r.get(key, ""))
                if v and (len(v) != length or not _HEX_RE.match(v)):
                    err(f"{rw}: {key} must be {length} lowercase hex chars or empty")
            bu = r.get("browserUrl", "")
            if bu and not _is_http_url(bu):
                err(f"{rw}: browserUrl must be an http(s) URL or empty")
            mirrors = r.get("mirrors", [])
            if not isinstance(mirrors, list):
                err(f"{rw}: mirrors must be a list")
            else:
                for m in mirrors:
                    if not _is_http_url(m):
                        err(f"{rw}: mirror is not an http(s) URL: {m!r}")
            if not isinstance(r.get("consoleVerified", False), bool):
                err(f"{rw}: consoleVerified must be a boolean")
    return errors


def _validate_phase2_game(g: dict[str, Any], where: str, err) -> None:
    """§17.1 / §17.9 / §17.13 / §17.21 fields. Every key may be absent (old readers) but never wrong-typed."""
    shots = g.get("screenshots", [])
    if not isinstance(shots, list):
        err(f"{where}: screenshots must be a list")
    else:
        if len(shots) > MAX_SCREENSHOTS:
            err(f"{where}: at most {MAX_SCREENSHOTS} screenshots")
        for u in shots:
            if not _is_http_url(u):
                err(f"{where}: screenshot is not an http(s) URL: {u!r}")
        if len(set(shots)) != len(shots):
            err(f"{where}: duplicate screenshots")
    for key in ("about", "series", "psStoreUrl", "category", "author", "developer"):
        if not isinstance(g.get(key, ""), str):
            err(f"{where}: {key} must be a string")
    if g.get("psStoreUrl") and not _is_http_url(g["psStoreUrl"]):
        err(f"{where}: psStoreUrl must be an http(s) URL or empty")
    mc = g.get("metacritic", None)
    if mc is not None and (not isinstance(mc, int) or isinstance(mc, bool) or not 0 <= mc <= 100):
        err(f"{where}: metacritic must be null or an integer 0..100, got {mc!r}")
    ar = g.get("ageRating", None)
    if ar is not None and (not isinstance(ar, int) or isinstance(ar, bool) or not 0 <= ar <= 21):
        err(f"{where}: ageRating must be null or an integer 0..21, got {ar!r}")
    for key in ("features", "languages"):
        v = g.get(key, [])
        if not isinstance(v, list) or any(not isinstance(x, str) or not x for x in v):
            err(f"{where}: {key} must be a list of non-empty strings")
    year = g.get("year", 0)
    if not isinstance(year, int) or isinstance(year, bool) or (year and not 1990 <= year <= 2100):
        err(f"{where}: year must be 0 or a plausible year, got {year!r}")
    for key in ("updates", "dlc", "backports", "cheats", "conceptId", "steamId"):
        v = g.get(key, 0)
        if not isinstance(v, int) or isinstance(v, bool) or v < 0:
            err(f"{where}: {key} must be a non-negative integer, got {v!r}")
    if g.get("series") and not re.match(r"^[a-z0-9]+(?:-[a-z0-9]+)*$", str(g["series"])):
        err(f"{where}: series must be a slug")
    if not isinstance(g.get("supportsPs5", False), bool):
        err(f"{where}: supportsPs5 must be a boolean")
    if g.get("platform") == "HOMEBREW":
        if not g.get("author"):
            err(f"{where}: HOMEBREW entries need an author")
        if g.get("category") and g["category"] not in HOMEBREW_CATEGORIES:
            err(f"{where}: category must be one of {HOMEBREW_CATEGORIES}")
        if g.get("titleIds"):
            err(f"{where}: HOMEBREW entries carry no Sony title ids")
    elif g.get("category") or g.get("author") or g.get("supportsPs5"):
        err(f"{where}: category/author/supportsPs5 are only valid on HOMEBREW entries")
