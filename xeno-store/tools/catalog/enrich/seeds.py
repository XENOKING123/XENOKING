"""Offline enrichment from XENO TOOL's bundled seeds (SPEC §17.9).

Inputs, read straight from this repository (never copied):

* ``client/src-tauri/resources/titles-seed.zip``
  * ``All_Titles.json`` — 69,552 PS4/PS5 titles: ``titleId`` (``CUSA00002_00``), ``conceptId``,
    official ``name``, ``contentId`` (``EP9000-CUSA00002_00-…``), ``region`` (content-id prefix), ``publisherId``;
  * ``cheatslist.json`` — ``{"entries":[{"id":"CUSA00002","version":"01.00","formats":{json|shn|mc4:{cheats:[...]}}}]}``.
* ``client/public/covers.json`` — ``{"titles": {"<lower-case title>": "<PlayStation CDN url>" | "no-image"}}``.

What a game gets: ``titleIds`` filled by exact normalized-name match when a source only knew the name,
official names for title-id-only entries, ``conceptId`` → ``psStoreUrl``, region hints from the
content-id prefix (UP=USA, EP=EUR, JP=JPN, HP=ASIA) for the game and its releases, ``cheats`` (unique
trainer names across all versions of all its title ids) and a PlayStation CDN cover fallback.
"""
from __future__ import annotations

import json
import re
import zipfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

from merge import clean_title, normalize_title, platform_for_title_id
from schema import Game

SEED_ZIP = Path("client/src-tauri/resources/titles-seed.zip")   # relative to the repository root
COVERS_JSON = Path("client/public/covers.json")
PS_STORE_CONCEPT = "https://store.playstation.com/en-us/concept/"
MAX_FILLED_TITLE_IDS = 4

_REGION_BY_PREFIX = {"U": "USA", "E": "EUR", "J": "JPN", "H": "ASIA", "K": "ASIA"}
_REGION_PREFERENCE = {"USA": 0, "EUR": 1, "JPN": 2, "ASIA": 3, "": 4}
_TITLE_ID_RE = re.compile(r"^([A-Z]{4}\d{5})(?:_\d{2})?$")
_LOOKS_LIKE_ID_RE = re.compile(r"^[A-Z]{4}\s?\d{5}$", re.I)


def region_for_content_id(content_id: str) -> str:
    """'EP9000-CUSA00002_00-…' -> 'EUR'; '' when the prefix is unknown (IP = Sony internal, blank)."""
    return _REGION_BY_PREFIX.get((content_id or "")[:1].upper(), "")


@dataclass
class SeedTitle:
    titleId: str
    name: str
    conceptId: int = 0
    region: str = ""


@dataclass
class SeedStats:
    games: int = 0
    titleIdsFilled: int = 0
    namesResolved: int = 0
    conceptIds: int = 0
    regions: int = 0
    cheats: int = 0
    covers: int = 0

    def to_dict(self) -> dict[str, int]:
        return dict(self.__dict__)


@dataclass
class Seeds:
    by_id: dict[str, SeedTitle] = field(default_factory=dict)
    by_name: dict[str, list[str]] = field(default_factory=dict)      # normalized name -> title ids
    cheats_by_id: dict[str, set[str]] = field(default_factory=dict)  # title id -> unique cheat names
    covers: dict[str, str] = field(default_factory=dict)             # normalized title -> CDN url
    stats: SeedStats = field(default_factory=SeedStats)
    source: str = ""

    # ------------------------------------------------------------------ loading
    @classmethod
    def from_documents(cls, titles: list[dict[str, Any]] | None, cheats: dict[str, Any] | list | None,
                       covers: dict[str, Any] | None) -> "Seeds":
        s = cls()
        for row in titles or []:
            if not isinstance(row, dict):
                continue
            m = _TITLE_ID_RE.match(str(row.get("titleId") or "").strip().upper())
            if not m:
                continue
            tid = m.group(1)
            name = str(row.get("name") or "").strip()
            try:
                concept = int(row.get("conceptId") or 0)
            except (TypeError, ValueError):
                concept = 0
            region = region_for_content_id(str(row.get("contentId") or "")) or _REGION_BY_PREFIX.get(
                str(row.get("region") or "")[:1].upper(), "")
            st = s.by_id.get(tid)
            if st is None:
                s.by_id[tid] = SeedTitle(titleId=tid, name=name, conceptId=concept, region=region)
            else:                       # a few ids repeat with a second content id; keep the richer row
                st.conceptId = st.conceptId or concept
                st.region = st.region or region
                st.name = st.name or name
            key = normalize_title(name) if name else ""
            if key:
                ids = s.by_name.setdefault(key, [])
                if tid not in ids:
                    ids.append(tid)
        entries = cheats.get("entries") if isinstance(cheats, dict) else cheats
        for e in entries or []:
            if not isinstance(e, dict):
                continue
            tid = str(e.get("id") or "").strip().upper()
            if not _TITLE_ID_RE.match(tid):
                continue
            names = s.cheats_by_id.setdefault(tid, set())
            formats = e.get("formats") or {}
            found = False
            for fmt in formats.values() if isinstance(formats, dict) else []:
                for name in (fmt or {}).get("cheats") or []:
                    if isinstance(name, str) and name.strip():
                        names.add(name.strip().lower())
                        found = True
            if not found:
                try:
                    total = int(e.get("cheatsTotal") or 0)
                except (TypeError, ValueError):
                    total = 0
                for i in range(total):   # names unknown: count them as distinct for this version
                    names.add(f"{e.get('version') or ''}#{i}")
        titles_map = covers.get("titles") if isinstance(covers, dict) and isinstance(covers.get("titles"), dict) else covers
        for key, url in (titles_map or {}).items() if isinstance(titles_map, dict) else []:
            if not isinstance(url, str) or not url.startswith(("http://", "https://")):
                continue
            nk = normalize_title(str(key))
            if nk and nk not in s.covers:
                s.covers[nk] = url
        return s

    @classmethod
    def load(cls, repo_root: Path, log: Callable[[str], None] = print) -> "Seeds | None":
        """Read the seeds from the repository; None (with a log line) when the zip is not there."""
        zip_path = repo_root / SEED_ZIP
        if not zip_path.exists():
            log(f"[seeds] {zip_path} not found; skipping offline enrichment")
            return None
        titles: list = []
        cheats: Any = None
        try:
            with zipfile.ZipFile(zip_path) as z:
                names = set(z.namelist())
                if "All_Titles.json" in names:
                    titles = json.loads(z.read("All_Titles.json").decode("utf-8", "replace"))
                if "cheatslist.json" in names:
                    cheats = json.loads(z.read("cheatslist.json").decode("utf-8", "replace"))
        except (OSError, ValueError, zipfile.BadZipFile) as e:
            log(f"[seeds] {zip_path} unreadable ({e}); skipping offline enrichment")
            return None
        covers: Any = None
        cov_path = repo_root / COVERS_JSON
        if cov_path.exists():
            try:
                with open(cov_path, "r", encoding="utf-8") as fh:
                    covers = json.load(fh)
            except (OSError, ValueError) as e:
                log(f"[seeds] {cov_path} unreadable ({e}); no cover fallbacks")
        s = cls.from_documents(titles if isinstance(titles, list) else [], cheats, covers)
        s.source = str(zip_path)
        log(f"[seeds] {len(s.by_id)} titles, {len(s.by_name)} names, {len(s.cheats_by_id)} ids with cheats, "
            f"{len(s.covers)} covers")
        return s

    # ------------------------------------------------------------------ lookups
    def ids_for_name(self, title: str, platform: str) -> list[str]:
        """Title ids whose official name normalizes exactly like ``title``, on ``platform``, best region first."""
        key = normalize_title(title)
        if not key:
            return []
        ids = [t for t in self.by_name.get(key, []) if platform_for_title_id(t) == platform]
        ids.sort(key=lambda t: (_REGION_PREFERENCE.get(self.by_id[t].region, 4), t))
        return ids[:MAX_FILLED_TITLE_IDS]

    def cheats_for(self, title_ids: list[str]) -> int:
        names: set[str] = set()
        for tid in title_ids:
            names |= self.cheats_by_id.get(tid, set())
        return len(names)

    def cover_for(self, title: str) -> str:
        return self.covers.get(normalize_title(title), "")

    # ------------------------------------------------------------------ enrichment
    def enrich(self, game: Game) -> None:
        if game.platform not in ("PS4", "PS5"):
            return
        self.stats.games += 1
        if not game.titleIds:
            ids = self.ids_for_name(game.title, game.platform)
            if ids:
                game.titleIds = ids
                self.stats.titleIdsFilled += 1
        seeds = [self.by_id[t] for t in game.titleIds if t in self.by_id]
        if _LOOKS_LIKE_ID_RE.match(game.title or "") or not game.title.strip():
            official = next((clean_title(s.name) for s in seeds if clean_title(s.name)), "")
            if official:
                game.title = official
                self.stats.namesResolved += 1
        if not game.conceptId:
            game.conceptId = next((s.conceptId for s in seeds if s.conceptId), 0)
            if game.conceptId:
                self.stats.conceptIds += 1
        if game.conceptId and not game.psStoreUrl:
            game.psStoreUrl = f"{PS_STORE_CONCEPT}{game.conceptId}"
        if not game.region:
            regions = [s.region for s in seeds if s.region]
            if regions:
                game.region = max(sorted(set(regions)), key=regions.count)
                self.stats.regions += 1
        for r in game.releases:
            if not r.region and r.titleId in self.by_id and self.by_id[r.titleId].region:
                r.region = self.by_id[r.titleId].region
        cheats = self.cheats_for(game.titleIds)
        if cheats > game.cheats:
            game.cheats = cheats
            self.stats.cheats += 1
        if not game.cover or not game.coverFallback:
            url = self.cover_for(game.title)
            if url and url != game.cover:
                if not game.cover:
                    game.cover = url
                else:
                    game.coverFallback = url
                self.stats.covers += 1


def enricher(repo_root: Path, log: Callable[[str], None] = print) -> tuple[Callable[[Game], None] | None, "Seeds | None"]:
    """(callable for merge_drafts, Seeds) — (None, None) when the seeds are unavailable."""
    s = Seeds.load(repo_root, log)
    if s is None:
        return None, None
    return s.enrich, s
