"""Normalization, grouping, dedupe and ranking (SPEC §10 / §10.1).

Sources hand this module ``GameDraft`` objects (one per game *as the source sees
it*, each with its releases). ``merge_drafts`` turns them into a validated
``Catalog``:

1. every draft title is normalized; drafts sharing (normalized title, platform)
   become one game, and groups that share a title id on the same platform are
   joined too (union-find), so "Marvel's Spider-Man 2" and "Spider-Man 2" meet;
2. releases are deduped by URL (fields filled in from lower-priority copies,
   mirrors unioned), bad releases are dropped with a reason;
3. art, sizes, genres, compat, popularity and featured are computed;
4. games are sorted by title, ids are made unique and the result is returned
   together with a ``MergeReport`` for ``report.json``.

All parsing helpers (title ids, versions, regions, compat tags, kinds, formats)
live here as well because the sources share them.
"""
from __future__ import annotations

import hashlib
import re
import unicodedata
from dataclasses import dataclass, field
from typing import Iterable

from schema import (
    FORMATS, GENRES, KINDS, PLATFORMS, Catalog, Game, Release, SourceInfo, is_iso_date,
)

# --------------------------------------------------------------------------- #
# Title ids, platforms
# --------------------------------------------------------------------------- #

TITLE_ID_RE = re.compile(r"\b(PPSA|CUSA|PCAS|PCJS|PLAS|PLJM)\s?(\d{5})\b", re.I)
_PS5_PREFIXES = ("PPSA", "PCAS", "PCJS")
_PS4_PREFIXES = ("CUSA", "PLAS", "PLJM")


def parse_title_ids(text: str) -> list[str]:
    """Every Sony title id in ``text`` (PPSA/CUSA plus the Asian/Japanese prefixes), in order, unique."""
    out: list[str] = []
    for m in TITLE_ID_RE.finditer(text or ""):
        tid = (m.group(1) + m.group(2)).upper()
        if tid not in out:
            out.append(tid)
    return out


def platform_for_title_id(title_id: str) -> str:
    """'PS5' / 'PS4' for a title id prefix, '' when unknown."""
    p = (title_id or "")[:4].upper()
    if p in _PS5_PREFIXES:
        return "PS5"
    if p in _PS4_PREFIXES:
        return "PS4"
    return ""


def normalize_platform(value: str, title_id: str = "", default: str = "PS5") -> str:
    v = (value or "").strip().upper().replace(" ", "")
    if v in PLATFORMS:
        return v
    by_id = platform_for_title_id(title_id)
    return by_id or default


# --------------------------------------------------------------------------- #
# Titles
# --------------------------------------------------------------------------- #

_TRADEMARK_RE = re.compile(r"[™®©]")  # ™ ® ©
_FANCY = {
    "‘": "'", "’": "'", "“": '"', "”": '"', "–": "-", "—": "-",
    "…": "...", " ": " ",
}
_WS_RE = re.compile(r"\s+")

# Tags sites append to post titles. Order matters: version/bracket tags first,
# then platform/format words, then regions and trailing punctuation.
_TITLE_NOISE = [
    re.compile(r"\s*\[\s*v?\d+[\d.]*\s*\]", re.I),                     # [v1.00] [1.00.002]
    re.compile(r"\s*\(\s*v\d+[\d.]*\s*\)", re.I),                      # (v1.00)
    re.compile(r"\s+v\d+[\d.]*(?=\s|$)", re.I),                        # v1.00
    re.compile(r"\s*[\[(]\s*(?:bp|backport(?:ed)?)\s*[\d.x+]*\s*[\])]", re.I),  # [BP 9.00] (Backport)
    re.compile(r"\s*\b(?:backported|backport|bp\s?\d{1,2}\.\w{2}\+?)\b", re.I),
    re.compile(r"\s*\[\s*(?:\d{1,2}\.(?:xx|\d{2})\+?(?:\s*[/,-]\s*)?)+\s*\]", re.I),   # [9.xx] [5.05/6.72]
    re.compile(r"\s*\b\d{1,2}\.xx\+?\b", re.I),                        # 9.xx
    re.compile(r"\s*\((?:fw|firmware)\s*[^)]*\)", re.I),               # (FW 11.00)
    re.compile(r"\s*\+\s*(?:all\s+)?(?:update|updates|dlc|dlcs)(?:\s*\+\s*(?:update|updates|dlc|dlcs))*\b", re.I),
    re.compile(r"\s*[\[(]\s*(?:fake\s+)?f?pkg\s*[\])]", re.I),         # [FPKG] (Fake PKG)
    re.compile(r"\s+(?:fake\s+)?f?pkg(?=\s|$)", re.I),
    re.compile(r"\s*[\[(]\s*ps[45](?:\s*[/&+]\s*ps[45])?\s*[\])]", re.I),   # (PS5) [PS4/PS5]
    re.compile(r"\s+ps[45](?:\s*/\s*ps[45])?(?:\s+games?)?(?=\s|/|$)", re.I),   # PS4, PS5 game
    re.compile(r"\s*\b(?:free\s+)?download\b(?:\s+(?:free|game))*", re.I),
    re.compile(r"\s*\((?:EUR|USA|JPN|JAP|ASIA|ASIAN|KOR|CHN|NTSC|PAL|EU|US|JP|AS|HK|TW|MULTI\d*|EN|ENG|FR|DE|ES|IT|RU)(?:\s*[/,+-]\s*[A-Z]{2,5})*\)", re.I),
    re.compile(r"\s*\[(?:EUR|USA|JPN|JAP|ASIA|ASIAN|KOR|CHN|NTSC|PAL|EU|US|JP|AS|HK|TW|MULTI\d*|EN|ENG|FR|DE|ES|IT|RU)(?:\s*[/,+-]\s*[A-Z]{2,5})*\]", re.I),
    re.compile(r"\s*[\[(]\s*(?:PPSA|CUSA|PCAS|PCJS|PLAS|PLJM)\s?\d{5}\b[^\])]*[\])]", re.I),  # (CUSA12345)
    re.compile(r"\s*\b(?:PPSA|CUSA|PCAS|PCJS|PLAS|PLJM)\s?\d{5}\b", re.I),
    re.compile(r"\s*\b\d+(?:\.\d+)?\s*(?:GB|MB|TB)\b", re.I),           # 12.3GB
    re.compile(r"\s*[\[(]\s*(?:exfat|fat32|ffpfsc|ffpkg|ffpfs|offline|online|repack|dlc|update|patch|multi)[^\])]*[\])]", re.I),
]
_TRAILING_PUNCT_RE = re.compile(r"[\s\-:,/|+&]+$")
_LEADING_PUNCT_RE = re.compile(r"^[\s\-:,/|+]+")


def strip_marks(s: str) -> str:
    """Drop ™®©, unicode-normalize, map curly quotes/dashes to ASCII, collapse whitespace."""
    s = _TRADEMARK_RE.sub("", s or "")          # before NFKC, which would turn ™ into "TM"
    s = unicodedata.normalize("NFKC", s)
    s = "".join(_FANCY.get(ch, ch) for ch in s)
    return _WS_RE.sub(" ", s).strip()


def ascii_fold(s: str) -> str:
    """'Ragnarök' -> 'Ragnarok': strip combining accents so keys and slugs stay ASCII."""
    decomposed = unicodedata.normalize("NFKD", s or "")
    return "".join(ch for ch in decomposed if not unicodedata.combining(ch))


def clean_title(raw: str) -> str:
    """Strip platform/version/region/format suffixes from a site title (port of cleanGameTitle)."""
    s = strip_marks(raw)
    for _ in range(2):  # tags nest ("Game PS4 [FPKG] v1.03"); two passes settle every order
        for rx in _TITLE_NOISE:
            s = rx.sub("", s)
    s = _TRAILING_PUNCT_RE.sub("", s)
    s = _LEADING_PUNCT_RE.sub("", s)
    return _WS_RE.sub(" ", s).strip()


# Edition words that never change *which game* it is. "Definitive", "Legendary",
# "Director's Cut", "Remastered" and "Remake" are kept on purpose: those are
# separate products with their own title ids.
_EDITION_RE = re.compile(
    r"\b(?:(?:digital\s+|super\s+)?deluxe|gold|ultimate|complete|standard|premium|collector'?s?|special|"
    r"limited|anniversary|royal|platinum|enhanced|champion|launch|day\s*one|year\s*one|cross[\s-]?gen|"
    r"next[\s-]?gen|game\s+of\s+the\s+year|goty|bundle)\s+(?:edition|bundle|pack|version)\b"
    r"|\b(?:game\s+of\s+the\s+year|goty)\b",
    re.I,
)
_ARTICLE_RE = re.compile(r"^(?:the|a|an)\s+")
_NON_ALNUM_RE = re.compile(r"[^a-z0-9]+")
_ROMAN = {"ii": "2", "iii": "3", "iv": "4", "v": "5", "vi": "6", "vii": "7", "viii": "8", "ix": "9", "x": "10"}


def normalize_title(title: str) -> str:
    """Grouping key: cleaned, lower-cased, editions/punctuation/articles removed.

    'Cyberpunk 2077: Ultimate Edition (PS5)' and 'cyberpunk 2077' both map to
    'cyberpunk 2077'. Trailing roman numerals become digits so 'Final Fantasy VII'
    and 'Final Fantasy 7' meet; mid-title numerals are left alone.
    """
    s = ascii_fold(clean_title(title)).lower()
    s = s.replace("&", " and ")
    s = _EDITION_RE.sub(" ", s)
    s = _NON_ALNUM_RE.sub(" ", s).strip()
    s = _ARTICLE_RE.sub("", s)
    words = s.split()
    if len(words) > 1 and words[-1] in _ROMAN:
        words[-1] = _ROMAN[words[-1]]
    return " ".join(words)


def slugify(text: str) -> str:
    s = _NON_ALNUM_RE.sub("-", ascii_fold(text or "").lower()).strip("-")
    return s[:80].strip("-") or "untitled"


# --------------------------------------------------------------------------- #
# Versions, regions, compat, kinds, formats
# --------------------------------------------------------------------------- #

_VERSION_RE = re.compile(r"(?<![\d.])v?(\d{1,2}\.\d{2,3}(?:\.\d{3})?)(?!\.?\d)", re.I)
_VERSION_V_RE = re.compile(r"\bv\.?\s?(\d{1,2}(?:\.\d{1,3}){1,3})\b", re.I)
_BRACKET_VERSION_RE = re.compile(r"[\[(]\s*v?(\d{1,2}\.\d{2,3}(?:\.\d{3})?)\s*[\])]", re.I)
_FW_TOKEN_RE = re.compile(r"\b(?:bp|fw)\s?\d{1,2}\.(?:xx|\d{2})\+?|\b\d{1,2}\.xx\+?", re.I)
_LABEL_VERSION_RE = re.compile(r"^\s*(?:update|patch|version|ver)\s*:?\s*v?(\d{1,2}(?:\.\d{1,3}){1,3})\b", re.I)


def parse_version(text: str) -> str:
    """Game/update version from a filename or label ('01.003.002', 'v1.37' -> '1.37', '[1.28]' -> '1.28').

    Firmware tags ('9.xx', '13.60', 'BP4.xx', '(Fix 5.05/6.72)') are never returned as versions.
    """
    s = _COMPAT_FIX_GROUP_RE.sub(" ", text or "")
    s = _FW_TOKEN_RE.sub(" ", s)
    m = _LABEL_VERSION_RE.search(s) or _VERSION_V_RE.search(s) or _BRACKET_VERSION_RE.search(s)
    if m:
        return m.group(1)
    for m in _VERSION_RE.finditer(s):
        v = m.group(1)
        if v in KNOWN_FIRMWARES:
            continue
        # A bare 'NN.NN' token is a version only when zero-padded ('01.28') or
        # three-part ('1.003.000'); '13.60' / '5.05' alone are firmware tags.
        if v.count(".") >= 2 or v.startswith("0") or len(v.split(".")[1]) == 3:
            return v
    return ""


_REGION_TOKENS = {
    "EUR": "EUR", "EU": "EUR", "EUROPE": "EUR", "PAL": "EUR",
    "USA": "USA", "US": "USA", "NTSC": "USA", "NTSC-U": "USA", "AMERICA": "USA",
    "JPN": "JPN", "JP": "JPN", "JAP": "JPN", "JAPAN": "JPN", "NTSC-J": "JPN",
    "ASIA": "ASIA", "AS": "ASIA", "ASIAN": "ASIA", "HK": "ASIA", "TW": "ASIA", "CHN": "ASIA", "KOR": "ASIA",
}
_REGION_BRACKET_RE = re.compile(r"[\[(]\s*(EUR|USA|JPN|JAP|ASIA|ASIAN|KOR|CHN|PAL|NTSC(?:-[UJ])?|EU|US|JP|AS|HK|TW)\s*(?:\([^)]*\))?\s*[\])]", re.I)
_REGION_WORD_RE = re.compile(r"\b(EUR|USA|JPN|ASIA|EUROPE|JAPAN|AMERICA)\b", re.I)


def parse_region(text: str) -> str:
    """'EUR' / 'USA' / 'JPN' / 'ASIA' from tokens like [EU], (USA), 'EUR (exFAT)', or ''."""
    s = text or ""
    m = _REGION_BRACKET_RE.search(s)
    if m:
        return _REGION_TOKENS.get(m.group(1).upper(), "")
    head = s.strip().split(" ")[0].upper() if s.strip() else ""
    if head in _REGION_TOKENS:
        return _REGION_TOKENS[head]
    m = _REGION_WORD_RE.search(s)
    if m:
        return _REGION_TOKENS.get(m.group(1).upper(), "")
    return ""


# Firmware numbers people put in file names. A bare 'N.NN' token is only accepted
# as a compat tag when it is one of these, so update versions never leak in.
KNOWN_FIRMWARES = {
    # PS4
    "1.76", "4.05", "4.55", "5.05", "5.07", "6.72", "7.02", "7.50", "7.51", "7.55", "8.00", "8.01", "8.03",
    "8.50", "8.52", "9.00", "9.03", "9.04", "9.50", "9.51", "9.60", "10.00", "10.01", "10.50", "10.70",
    "10.71", "11.00", "11.02", "11.50", "11.52", "12.00", "12.02", "12.50", "12.52",
    # PS5
    "2.50", "3.00", "3.20", "4.03", "4.50", "4.51", "5.00", "5.02", "5.10", "5.50", "6.00", "6.02", "6.50",
    "7.00", "7.01", "7.20", "7.40", "7.60", "7.61", "8.20", "8.40", "8.60", "9.05", "9.20", "9.40",
    "10.20", "10.40", "10.60", "11.20", "12.20", "13.00", "13.60",
}
_COMPAT_XX_RE = re.compile(r"\b(\d{1,2})\.xx(\+?)", re.I)
_COMPAT_BP_RE = re.compile(r"\bbp\s?(\d{1,2}\.(?:xx|\d{2}))(\+?)", re.I)
_COMPAT_FIX_GROUP_RE = re.compile(r"\((?:fix|fw|firmware|bp|backport)[^)]*\)", re.I)
_COMPAT_NUM_RE = re.compile(r"(?<![\d.])(\d{1,2}\.\d{2})(?![\d.])")


def parse_compat(text: str) -> list[str]:
    """Firmware compat tags from a filename/label: '9.xx', '4.xx', '11.xx+', '13.60', '5.05'.

    Sources: 'N.xx' tokens anywhere, 'BPN.xx' backport tags, every number inside a
    '(Fix 5.05/6.72/7.55)' style group, and bare numbers from KNOWN_FIRMWARES.
    """
    s = text or ""
    tags: list[str] = []

    def add(tag: str) -> None:
        if tag not in tags:
            tags.append(tag)

    for m in _COMPAT_BP_RE.finditer(s):
        add(m.group(1).lower() + m.group(2))
    for m in _COMPAT_XX_RE.finditer(s):
        add(m.group(1) + ".xx" + m.group(2))
    for grp in _COMPAT_FIX_GROUP_RE.findall(s):
        for n in _COMPAT_NUM_RE.findall(grp):
            add(n)
    for m in _COMPAT_NUM_RE.finditer(s):
        if m.group(1) in KNOWN_FIRMWARES:
            add(m.group(1))
    return sorted(tags, key=_compat_sort_key)


def _compat_sort_key(tag: str) -> tuple:
    m = re.match(r"(\d+)\.(xx|\d+)(\+?)", tag)
    if not m:
        return (99, 0, tag)
    minor = 0 if m.group(2) == "xx" else int(m.group(2))
    return (int(m.group(1)), minor, m.group(3))


def detect_kind(label: str = "", filename: str = "", fmt: str = "") -> str:
    """'game' | 'update' | 'dlc' | 'bundle' from a section label and/or filename."""
    lab = (label or "").strip().lower()
    fn = (filename or "").lower()
    if lab:
        if re.match(r"^(?:update|patch)\b", lab) or re.search(r"\b(?:update|patch)\s*v?\d", lab):
            return "update"
        if lab.startswith("dlc") or re.search(r"\bdlcs?\b", lab) and not re.search(r"\b(?:game|base)\b", lab):
            return "dlc"
        if re.search(r"\b(?:bundle|all[\s-]in[\s-]one|game\s*\+\s*update|\+\s*dlc)\b", lab):
            return "bundle"
        if re.match(r"^(?:game|base)\b", lab):
            return "game"
    # Full console images are always complete games whatever their name says.
    if fmt in ("FFPFSC", "exFAT", "FFPKG", "FFPFS"):
        return "game"
    if re.search(r"(?:^|[-_\s.])(?:patch|update)(?:[-_\s.]|$)", fn) or re.search(r"-patch-\d", fn):
        return "update"
    if re.search(r"(?:^|[-_\s.(\[])(?:dlc|ac)(?:[-_\s.)\]]|$)", fn):
        return "dlc"
    return "game"


_EXT_FORMAT = {
    "ffpfsc": "FFPFSC", "exfat": "exFAT", "ffpkg": "FFPKG", "ffpfs": "FFPFS", "pkg": "PKG",
    "fpkg": "FPKG", "zip": "ZIP", "rar": "RAR", "7z": "7z",
}
_EXT_RE = re.compile(r"\.([a-z0-9]{1,6})(?:\?.*)?$", re.I)
_RAR_PART_RE = re.compile(r"\.(?:part\d+\.rar|r\d{2}|\d{3})$", re.I)


def format_from_filename(name: str) -> str:
    """Catalog format from a file name / URL path extension, '' when unknown."""
    n = (name or "").split("#")[0].rstrip("/")
    if _RAR_PART_RE.search(n):
        return "RAR"
    m = _EXT_RE.search(n)
    if not m:
        return ""
    return _EXT_FORMAT.get(m.group(1).lower(), "")


def normalize_format(value: str, filename: str = "") -> str:
    v = (value or "").strip()
    for f in FORMATS:
        if v.lower() == f.lower():
            return f
    return format_from_filename(filename or v) or ("PAGE" if not v else "")


# --------------------------------------------------------------------------- #
# Genres
# --------------------------------------------------------------------------- #

_GENRE_MAP = {
    "action": "Action", "action-adventure": "Action", "arcade": "Action", "hack and slash": "Action",
    "beat em up": "Action", "beat 'em up": "Action", "stealth": "Action", "open world": "Adventure",
    "adventure": "Adventure", "point and click": "Adventure", "visual novel": "Adventure", "narrative": "Adventure",
    "rpg": "RPG", "role-playing": "RPG", "role playing": "RPG", "role playing games": "RPG", "role playing game": "RPG",
    "role playing game (rpg)": "RPG", "jrpg": "RPG", "arpg": "RPG", "mmorpg": "RPG", "roguelike": "RPG",
    "horror": "Horror", "survival horror": "Horror", "survival": "Horror",
    "racing": "Racing", "driving": "Racing", "driving/racing": "Racing", "driving racing": "Racing", "motorsport": "Racing",
    "shooter": "Shooter", "fps": "Shooter", "first-person shooter": "Shooter", "third-person shooter": "Shooter",
    "shoot em up": "Shooter", "shoot 'em up": "Shooter", "battle royale": "Shooter",
    "sport": "Sports", "sports": "Sports", "football": "Sports", "soccer": "Sports", "basketball": "Sports",
    "wrestling": "Sports", "golf": "Sports", "skateboarding": "Sports",
    "strategy": "Strategy", "tactics": "Strategy", "tactical": "Strategy", "rts": "Strategy", "tower defense": "Strategy",
    "card": "Strategy", "turn-based": "Strategy", "turn based": "Strategy", "mmo": "Strategy",
    "simulation": "Simulation", "simulator": "Simulation", "sim": "Simulation", "management": "Simulation",
    "farming": "Simulation", "life sim": "Simulation", "sandbox": "Simulation", "building": "Simulation",
    "fighting": "Fighting", "brawler": "Fighting", "martial arts": "Fighting",
    "puzzle": "Puzzle", "logic": "Puzzle", "board": "Puzzle", "trivia": "Puzzle", "quiz": "Puzzle",
    "platform": "Platformer", "platformer": "Platformer", "metroidvania": "Platformer", "run and gun": "Platformer",
    "indie": "Indie", "unique": "Indie", "experimental": "Indie",
    "family": "Family", "party": "Family", "casual": "Family", "kids": "Family", "educational": "Family",
    "music": "Music", "rhythm": "Music", "music/rhythm": "Music", "dance": "Music", "karaoke": "Music",
}
_GENRE_SPLIT_RE = re.compile(r"\s*(?:/|,|;|\||&|\band\b|\+)\s*", re.I)


def normalize_genres(raw: str | Iterable[str] | None) -> list[str]:
    """Map free-form genre labels ('Adventure / Action', 'Role Playing Games') onto GENRES, in vocabulary order."""
    if raw is None:
        return []
    labels = [raw] if isinstance(raw, str) else list(raw)
    found: set[str] = set()
    for label in labels:
        for token in _GENRE_SPLIT_RE.split(str(label or "")):
            t = token.strip().lower().replace("-", " ").replace("_", " ")
            t = _WS_RE.sub(" ", t)
            if not t:
                continue
            g = _GENRE_MAP.get(t) or _GENRE_MAP.get(t.replace(" ", "-"))
            if not g:
                # 'Action RPG', 'Sports Simulation' → every word that maps on its own.
                for w in t.split():
                    if w in _GENRE_MAP:
                        found.add(_GENRE_MAP[w])
                continue
            found.add(g)
    return [g for g in GENRES if g in found]


# --------------------------------------------------------------------------- #
# Art, tints
# --------------------------------------------------------------------------- #

_ART_HOST_RANK = [
    ("cdn.prosperopatches.com", 0), ("prosperopatches.com", 0),
    ("cdn.orbispatches.com", 0), ("orbispatches.com", 0),
    ("image.api.playstation.com", 1), ("gmedia.playstation.com", 1), ("store.playstation.com", 1),
]


def art_rank(url: str) -> int:
    """0 = prosperopatches/orbispatches CDN, 1 = PlayStation CDN, 2 = anything else, 9 = empty."""
    if not url:
        return 9
    host = url.split("://", 1)[-1].split("/", 1)[0].lower()
    for h, rank in _ART_HOST_RANK:
        if host == h or host.endswith("." + h):
            return rank
    return 2


def pick_art(candidates: Iterable[tuple[str, int]]) -> tuple[str, str]:
    """(primary, fallback) from (url, sourcePriority) pairs: CDN rank first, then source priority."""
    seen: set[str] = set()
    ordered: list[tuple[int, int, str]] = []
    for url, prio in candidates:
        u = (url or "").strip()
        if not u or not u.startswith(("http://", "https://")) or u in seen:
            continue
        seen.add(u)
        ordered.append((art_rank(u), -prio, u))
    ordered.sort()
    urls = [u for _, _, u in ordered]
    return (urls[0] if urls else "", urls[1] if len(urls) > 1 else "")


# A fixed palette of dark, saturated tints; a game gets one by slug hash so the
# UI can tint a card before its artwork loads (deterministic across builds).
_TINT_PALETTE = [
    "#1a2a5a", "#3a1a5a", "#5a1a2a", "#1a5a3a", "#5a3a1a", "#1a4a5a", "#4a1a4a", "#2a5a1a",
    "#5a1a1a", "#1a1a5a", "#3a5a1a", "#5a4a1a", "#1a5a5a", "#2a2a2a", "#4a2a1a", "#1a3a4a",
]


def tint_for(slug: str) -> str:
    h = hashlib.sha1(slug.encode("utf-8")).digest()[0]
    return _TINT_PALETTE[h % len(_TINT_PALETTE)]


# --------------------------------------------------------------------------- #
# Drafts (what sources produce)
# --------------------------------------------------------------------------- #

@dataclass
class GameDraft:
    """One game as a single source sees it. ``priority`` decides whose metadata wins (higher first)."""
    source: str
    title: str
    platform: str
    releases: list[Release] = field(default_factory=list)
    titleIds: list[str] = field(default_factory=list)
    region: str = ""
    genres: list[str] = field(default_factory=list)   # raw labels, normalized by merge
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
    artworkLayout: str = ""
    homeOrder: int = 0
    pickOrder: int = 0
    priority: int = 10
    pageUrl: str = ""
    slugHint: str = ""    # a stable id from the source (BlackBox gameId) used to pick the slug


@dataclass
class MergeReport:
    games: int = 0
    releases: int = 0
    dropped_releases: dict[str, int] = field(default_factory=dict)
    dropped_games: dict[str, int] = field(default_factory=dict)
    dropped_samples: list[str] = field(default_factory=list)
    per_source: dict[str, dict[str, int]] = field(default_factory=dict)
    merged_groups: int = 0

    def drop_release(self, source: str, reason: str, sample: str = "") -> None:
        self.dropped_releases[reason] = self.dropped_releases.get(reason, 0) + 1
        ps = self.per_source.setdefault(source, {"games": 0, "releases": 0, "dropped": 0})
        ps["dropped"] += 1
        if sample and len(self.dropped_samples) < 100:
            self.dropped_samples.append(f"{source}: {reason}: {sample[:160]}")

    def drop_game(self, source: str, reason: str, sample: str = "") -> None:
        self.dropped_games[reason] = self.dropped_games.get(reason, 0) + 1
        if sample and len(self.dropped_samples) < 100:
            self.dropped_samples.append(f"{source}: game {reason}: {sample[:160]}")


# --------------------------------------------------------------------------- #
# Release helpers
# --------------------------------------------------------------------------- #

def short_hash(text: str, n: int = 8) -> str:
    return hashlib.sha1(text.encode("utf-8")).hexdigest()[:n]


def make_release_id(prefix: str, title_id: str, kind: str, version: str, url: str) -> str:
    """Readable, stable release id: '<prefix>-<titleid>-<kind>[-<version>]-<urlhash>'."""
    parts = [slugify(prefix or "rel")]
    if title_id:
        parts.append(title_id.lower())
    parts.append(kind or "game")
    if version:
        parts.append(re.sub(r"[^0-9.]", "", version))
    parts.append(short_hash(url))
    return "-".join(p for p in parts if p)


def _canon_url(url: str) -> str:
    return (url or "").strip()


def _clean_release(r: Release, source: str, report: MergeReport) -> Release | None:
    """Normalize one release in place; return None (and record why) when it must be dropped."""
    r.url = _canon_url(r.url)
    if not r.url.startswith(("http://", "https://")):
        report.drop_release(source, "release_without_http_url", f"{r.filename or r.id} {r.url}")
        return None
    hostpart = r.url.split("://", 1)[1].split("/", 1)[0]
    if "@" in hostpart:
        report.drop_release(source, "url_with_credentials", r.url)
        return None
    if r.sizeBytes < 0:
        report.drop_release(source, "negative_size", f"{r.filename} {r.sizeBytes}")
        return None
    r.format = normalize_format(r.format, r.filename or r.url)
    if r.format not in FORMATS:
        report.drop_release(source, "unknown_format", f"{r.filename} {r.format}")
        return None
    if r.kind not in KINDS:
        r.kind = detect_kind("", r.filename, r.format)
    r.titleId = (r.titleId or "").upper().replace(" ", "")
    if r.titleId and not re.match(r"^[A-Z]{4}\d{5}$", r.titleId):
        ids = parse_title_ids(r.titleId)
        r.titleId = ids[0] if ids else ""
    r.region = r.region if r.region in ("EUR", "USA", "JPN", "ASIA") else parse_region(r.region)
    r.version = (r.version or "").strip()
    for key in ("sha256", "md5", "sha1"):
        setattr(r, key, (getattr(r, key) or "").strip().lower())
    for key in ("verifiedAt", "addedAt"):
        v = getattr(r, key) or ""
        if v and not is_iso_date(v):
            setattr(r, key, "")
    r.mirrors = [m.strip() for m in r.mirrors if m and m.strip().startswith(("http://", "https://")) and "@" not in m.split("://", 1)[-1].split("/", 1)[0]]
    r.mirrors = [m for i, m in enumerate(r.mirrors) if m != r.url and m not in r.mirrors[:i]]
    if r.browserUrl and not r.browserUrl.startswith(("http://", "https://")):
        r.browserUrl = ""
    if not r.id:
        r.id = make_release_id(r.sourceId, r.titleId, r.kind, r.version, r.url)
    r.id = re.sub(r"[^a-z0-9._-]+", "-", r.id.lower()).strip("-")[:120] or short_hash(r.url)
    return r


def _fill_release(dst: Release, src: Release) -> None:
    """Fill empty fields of ``dst`` from a duplicate (same URL) lower-priority release."""
    for key in ("provider", "titleId", "region", "version", "filename", "browserUrl", "sha256", "md5", "sha1",
                "verifiedAt", "compat", "password", "notes", "addedAt"):
        if not getattr(dst, key) and getattr(src, key):
            setattr(dst, key, getattr(src, key))
    if dst.sizeBytes <= 0 and src.sizeBytes > 0:
        dst.sizeBytes = src.sizeBytes
    if dst.format == "PAGE" and src.format != "PAGE":
        dst.format = src.format
    if dst.kind == "game" and src.kind != "game" and dst.format == "PAGE":
        dst.kind = src.kind
    dst.consoleVerified = dst.consoleVerified or src.consoleVerified
    for m in src.mirrors:
        if m != dst.url and m not in dst.mirrors:
            dst.mirrors.append(m)
    # Keep the older addedAt so a re-scraped release does not look "new" again.
    if src.addedAt and (not dst.addedAt or src.addedAt < dst.addedAt):
        dst.addedAt = src.addedAt


_PROVIDER_RANK = {"archive": 0, "xeno": 0, "orbit": 1, "blackbox": 1, "vikingfile": 2}
_KIND_RANK = {"game": 0, "bundle": 1, "update": 2, "dlc": 3}
_FORMAT_RANK = {f: i for i, f in enumerate(("FFPFSC", "exFAT", "FFPKG", "FFPFS", "PKG", "FPKG", "ZIP", "RAR", "7z", "PAGE"))}


def _version_key(v: str) -> tuple:
    nums = [int(x) for x in re.findall(r"\d+", v or "")]
    return tuple(-n for n in nums) + (0,) * (4 - len(nums))


def release_sort_key(r: Release) -> tuple:
    """Games first, then verified direct hosts, then by format preference, newest version, id."""
    return (
        _KIND_RANK.get(r.kind, 9),
        0 if r.verifiedAt else 1,
        _PROVIDER_RANK.get(r.sourceId, 3),
        _FORMAT_RANK.get(r.format, 9),
        _version_key(r.version),
        r.id,
    )


# --------------------------------------------------------------------------- #
# Grouping
# --------------------------------------------------------------------------- #

class _UnionFind:
    def __init__(self) -> None:
        self.parent: dict[str, str] = {}

    def find(self, x: str) -> str:
        self.parent.setdefault(x, x)
        while self.parent[x] != x:
            self.parent[x] = self.parent[self.parent[x]]
            x = self.parent[x]
        return x

    def union(self, a: str, b: str) -> None:
        ra, rb = self.find(a), self.find(b)
        if ra != rb:
            # Deterministic root choice: lexicographically smaller key wins.
            if rb < ra:
                ra, rb = rb, ra
            self.parent[rb] = ra


def _group_drafts(drafts: list[GameDraft]) -> dict[str, list[GameDraft]]:
    """Group by (normalized title, platform); join groups that share a release title id on that platform."""
    uf = _UnionFind()
    keys: list[str] = []
    for d in drafts:
        key = f"{d.platform}|{normalize_title(d.title)}"
        keys.append(key)
        uf.find(key)
    by_title_id: dict[str, str] = {}
    for d, key in zip(drafts, keys):
        ids = set(d.titleIds) | {r.titleId for r in d.releases if r.titleId}
        for tid in ids:
            if platform_for_title_id(tid) not in ("", d.platform):
                continue  # a PS4 id listed on a PS5 page (cross-gen bundle) must not join platforms
            k = f"{d.platform}|{tid}"
            if k in by_title_id:
                uf.union(by_title_id[k], key)
            else:
                by_title_id[k] = key
    groups: dict[str, list[GameDraft]] = {}
    for d, key in zip(drafts, keys):
        groups.setdefault(uf.find(key), []).append(d)
    return groups


def _best(drafts: list[GameDraft], attr: str) -> str:
    for d in drafts:
        v = getattr(d, attr) or ""
        if isinstance(v, str) and v.strip():
            return v.strip()
    return ""


def _pick_title(drafts: list[GameDraft]) -> str:
    """Prefer the highest-priority source's title; among equals prefer the shortest clean one with mixed case."""
    best = ""
    best_key: tuple | None = None
    for d in drafts:
        t = clean_title(d.title)
        if not t:
            continue
        shouting = t.isupper() and len(t) > 4
        key = (-d.priority, 1 if shouting else 0, len(t), t)
        if best_key is None or key < best_key:
            best, best_key = t, key
    return best


def _popularity(drafts: list[GameDraft], releases: list[Release], max_pick: int, max_home: int, now_year: int) -> float:
    """0..1 heuristic: BlackBox pick/home order (curated), recency, release count, verified direct link, artwork."""
    pick = min((d.pickOrder for d in drafts if d.pickOrder > 0), default=0)
    home = min((d.homeOrder for d in drafts if d.homeOrder > 0), default=0)
    score = 0.0
    if pick and max_pick:
        score += 0.35 * (1.0 - (pick - 1) / max(max_pick, 1))
    if home and max_home:
        score += 0.25 * (1.0 - (home - 1) / max(max_home, 1))
    year = 0
    rd = _best(drafts, "releaseDate")
    if rd[:4].isdigit():
        year = int(rd[:4])
    if year:
        score += 0.15 * max(0.0, 1.0 - (now_year - year) / 8.0)
    score += 0.10 * min(1.0, len(releases) / 6.0)
    if any(r.verifiedAt and r.sourceId in ("archive", "xeno") for r in releases):
        score += 0.10
    if any(d.cover for d in drafts):
        score += 0.05
    return round(min(1.0, max(0.0, score)), 3)


def merge_drafts(
    drafts: list[GameDraft],
    source_infos: list[SourceInfo],
    *,
    revision: int,
    generated_at: str,
    previous: Catalog | None = None,
) -> tuple[Catalog, MergeReport]:
    """Build a Catalog from source drafts. See the module docstring for the steps."""
    report = MergeReport()
    known_sources = {s.id for s in source_infos}
    build_date = generated_at[:10]

    # Previous catalog lookups keep addedAt sticky across rebuilds.
    prev_game_added: dict[str, str] = {}
    prev_rel_added: dict[str, str] = {}
    if previous is not None:
        for g in previous.games:
            if g.addedAt:
                prev_game_added[g.id] = g.addedAt
            for r in g.releases:
                if r.addedAt:
                    prev_rel_added[r.url] = r.addedAt

    # 1. Clean drafts and releases; drop what cannot be shipped.
    clean: list[GameDraft] = []
    for d in drafts:
        ps = report.per_source.setdefault(d.source, {"games": 0, "releases": 0, "dropped": 0})
        d.title = strip_marks(d.title)
        if not clean_title(d.title):
            for r in d.releases:
                report.drop_release(d.source, "missing_title", r.url)
            report.drop_game(d.source, "missing_title", d.pageUrl or d.title)
            continue
        d.platform = normalize_platform(d.platform, d.titleIds[0] if d.titleIds else "", "")
        if d.platform not in PLATFORMS:
            for r in d.releases:
                report.drop_release(d.source, "bad_platform", r.url)
            report.drop_game(d.source, "bad_platform", d.title)
            continue
        kept: list[Release] = []
        for r in d.releases:
            if r.sourceId not in known_sources:
                report.drop_release(d.source, "unknown_source_id", f"{r.sourceId} {r.url}")
                continue
            cr = _clean_release(r, d.source, report)
            if cr is not None:
                kept.append(cr)
        d.releases = kept
        d.titleIds = [t for t in (parse_title_ids(" ".join(d.titleIds)) if d.titleIds else [])]
        for r in d.releases:
            if r.titleId and r.titleId not in d.titleIds:
                d.titleIds.append(r.titleId)
        if not d.releases:
            report.drop_game(d.source, "no_releases", d.title)
            continue
        clean.append(d)

    # 2. Group and merge.
    groups = _group_drafts(clean)
    max_pick = max((d.pickOrder for d in clean), default=0)
    max_home = max((d.homeOrder for d in clean), default=0)
    now_year = int(build_date[:4]) if build_date[:4].isdigit() else 2026

    games: list[Game] = []
    for _, members in sorted(groups.items()):
        members.sort(key=lambda d: (-d.priority, d.source, d.title))
        if len(members) > 1:
            report.merged_groups += 1
        platform = members[0].platform
        title = _pick_title(members)
        slug_source = next((d.slugHint for d in members if d.slugHint), "")
        slug = slugify(slug_source) if slug_source else slugify(normalize_title(title) or title)
        # BlackBox PS4 ids end with "-ps4"; the suffix is re-added by the id rule.
        slug = re.sub(r"-(ps4|ps5)$", "", slug) or "untitled"

        # Releases: dedupe by URL, higher-priority copy first.
        by_url: dict[str, Release] = {}
        for d in members:
            for r in d.releases:
                ex = by_url.get(r.url)
                if ex is None:
                    by_url[r.url] = r
                else:
                    _fill_release(ex, r)
                    report.drop_release(d.source, "duplicate_url")
        releases = list(by_url.values())
        # Mirrors that are themselves a release URL of this game are redundant.
        urls = set(by_url)
        for r in releases:
            r.mirrors = [m for m in r.mirrors if m not in urls]
            if not r.addedAt:
                r.addedAt = prev_rel_added.get(r.url, "") or build_date
            r.addedAt = r.addedAt[:10]
            if r.verifiedAt:
                r.verifiedAt = r.verifiedAt[:10]
            if not r.compat:
                r.compat = " ".join(parse_compat(r.filename))
            if not r.provider:
                r.provider = next((s.name for s in source_infos if s.id == r.sourceId), r.sourceId)
        releases.sort(key=release_sort_key)
        seen_rids: set[str] = set()
        for r in releases:
            base = r.id
            n = 2
            while r.id in seen_rids:
                r.id = f"{base}-{n}"
                n += 1
            seen_rids.add(r.id)

        title_ids = sorted({t for d in members for t in d.titleIds} | {r.titleId for r in releases if r.titleId})
        sizes = [r.sizeBytes for r in releases if r.sizeBytes > 0]
        compat = sorted({c for r in releases for c in r.compat.split() if c}, key=_compat_sort_key)
        genres = normalize_genres([g for d in members for g in d.genres])
        cover, cover_fb = pick_art(
            [(d.cover, d.priority) for d in members] + [(d.coverFallback, d.priority - 1) for d in members]
        )
        hero, hero_fb = pick_art(
            [(d.hero, d.priority) for d in members] + [(d.heroFallback, d.priority - 1) for d in members]
        )
        if hero and hero == cover and hero_fb:
            hero, hero_fb = hero_fb, ""
        region = _best(members, "region")
        if region not in ("EUR", "USA", "JPN", "ASIA"):
            regions = [r.region for r in releases if r.region]
            region = max(sorted(set(regions)), key=regions.count) if regions else ""
        home = min((d.homeOrder for d in members if d.homeOrder > 0), default=0)
        game_id = f"{slug}-{platform.lower()}"
        added_candidates = [d.addedAt[:10] for d in members if d.addedAt and is_iso_date(d.addedAt[:10])]
        added = prev_game_added.get(game_id, "") or (min(added_candidates) if added_candidates else "") or min(r.addedAt for r in releases)
        layout = _best(members, "artworkLayout")
        if layout not in ("wide", "ambient", "portrait"):
            layout = "wide"
        game = Game(
            id=game_id, slug=slug, title=title, platform=platform, titleIds=title_ids, region=region,
            genres=genres, tagline=_best(members, "tagline"), description=_best(members, "description"),
            publisher=_best(members, "publisher"), developer=_best(members, "developer"),
            releaseDate=_best(members, "releaseDate")[:10], addedAt=added[:10],
            cover=cover, coverFallback=cover_fb, hero=hero, heroFallback=hero_fb, artworkLayout=layout,
            tint=tint_for(slug), sizeMin=min(sizes) if sizes else 0, sizeMax=max(sizes) if sizes else 0,
            featured=home, popularity=_popularity(members, releases, max_pick, max_home, now_year),
            verified=any(r.verifiedAt or r.consoleVerified for r in releases), compat=compat, releases=releases,
        )
        if not is_iso_date(game.releaseDate):
            game.releaseDate = ""
        games.append(game)
        for d in members:
            report.per_source[d.source]["games"] += 1
        for d in members:
            report.per_source[d.source]["releases"] += sum(1 for r in d.releases if by_url.get(r.url) is r)

    # 3. Sort by title and make ids unique (two distinct groups can slugify alike).
    games.sort(key=lambda g: (g.title.lower(), g.platform, g.id))
    seen_ids: dict[str, int] = {}
    for g in games:
        if g.id in seen_ids:
            seen_ids[g.id] += 1
            g.slug = f"{g.slug}-{seen_ids[g.id]}"
            g.id = f"{g.slug}-{g.platform.lower()}"
            g.tint = tint_for(g.slug)
        else:
            seen_ids[g.id] = 1

    # Featured: BlackBox home order when present; otherwise the most popular PS5
    # games with hero art fill the Discover hero rail so it is never empty.
    if not any(g.featured for g in games):
        candidates = [g for g in games if g.hero and g.platform == "PS5"]
        candidates.sort(key=lambda g: (-g.popularity, g.title.lower()))
        for i, g in enumerate(candidates[:12], start=1):
            g.featured = i

    used_source_ids = {r.sourceId for g in games for r in g.releases}
    sources = [s for s in source_infos if s.id in used_source_ids]
    genres_used = [g for g in GENRES if any(g in game.genres for game in games)]
    catalog = Catalog(revision=revision, generatedAt=generated_at, sources=sources, genres=genres_used, games=games)
    report.games = len(games)
    report.releases = catalog.release_count()
    return catalog, report


def catalog_content_signature(doc: dict) -> str:
    """Hash of everything except revision/generatedAt, used to decide whether the revision bumps."""
    import json
    body = {k: v for k, v in doc.items() if k not in ("revision", "generatedAt")}
    return hashlib.sha256(json.dumps(body, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")).hexdigest()
