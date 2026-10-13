"""pkg-zone.com — homebrew apps, emulators and tools as HOMEBREW catalog entries (SPEC §17.21).

Listing pages ``https://pkg-zone.com/?page=N`` (stop at the first page without cards, max 40).
Each card is ``<article class="pkg …">`` with the id after ``/details/`` (alnum + ``_``), the title
inside ``class="title font-bold"``, the version inside ``class="number …"``, the author after
``text-gray-300">``, a "Supports PS5" text flag, the cover ``/images/<id>/cover.png``, the details
page ``/details/<id>`` and the downloads ``/download/ps5/<id>/latest`` and ``/download/ps4/<id>/latest``.
The details page adds description, category, size and changelog when present (fetched for as many
apps as the budget allows, newest first). pkg-zone is not WordPress, so the wpsite adapter is not used.
"""
from __future__ import annotations

import html
import re

from merge import GameDraft, make_release_id, strip_marks
from schema import HOMEBREW_CATEGORIES, Release
from sources.base import BudgetExceeded, HttpError, SourceContext, SourceSpec

BASE = "https://pkg-zone.com"
PROVIDER = "pkg-zone"
MAX_PAGES = 40
MAX_DETAIL_PAGES = 400
ID_RE = re.compile(r"/details/([A-Za-z0-9_]+)")
ARTICLE_RE = re.compile(r'<article[^>]+class="[^"]*\bpkg\b[^"]*"[^>]*>([\s\S]*?)</article>', re.I)
TITLE_RE = re.compile(r'class="title font-bold[^"]*"[^>]*>([\s\S]*?)</', re.I)
VERSION_RE = re.compile(r'class="number[^"]*"[^>]*>\s*(?:v\.?\s*)?([0-9][0-9A-Za-z.\-_]*)\s*<', re.I)
AUTHOR_RE = re.compile(r'text-gray-300"[^>]*>\s*(?:by\s+)?([^<]{1,80}?)\s*<', re.I)
PS5_RE = re.compile(r"supports\s+ps5", re.I)
TAG_RE = re.compile(r"<[^>]+>")
WS_RE = re.compile(r"\s+")
SIZE_RE = re.compile(r"(\d+(?:[.,]\d+)?)\s*(KB|MB|GB)\b", re.I)
_VERSION_NUM_RE = re.compile(r"\d+(?:\.\d+)*")

_CATEGORY_WORDS = (
    (re.compile(r"emulat|retroarch|ppsspp|dolphin|pcsx|duckstation|flycast|mame|snes|nes\b|genesis|mgba|desmume|citra|yuzu|vita3k", re.I), "Emulator"),
    (re.compile(r"payload|\.elf\b|elf loader|kstuff|etahen|jailbreak|exploit", re.I), "Payload"),
    (re.compile(r"launcher|loader|itemzflow|shadowmount|mount", re.I), "Launcher"),
    (re.compile(r"media|player|video|music|kodi|vlc|stream|movie|mpv|plex", re.I), "Media"),
    (re.compile(r"tool|utilit|ftp|manager|dumper|backup|save|trainer|cheat|installer|debug|remote|browser|patch", re.I), "Tool"),
    (re.compile(r"game|port|homebrew game|doom|quake|clone|puzzle|arcade", re.I), "Game"),
)


def _text(fragment: str) -> str:
    return WS_RE.sub(" ", html.unescape(TAG_RE.sub(" ", fragment or ""))).strip()


def normalize_category(label: str, title: str = "", description: str = "") -> str:
    """Map a free-form category (or, failing that, the name/description) onto HOMEBREW_CATEGORIES."""
    lab = (label or "").strip()
    for cat in HOMEBREW_CATEGORIES:
        if lab.lower().rstrip("s") == cat.lower():
            return cat
    for rx, cat in _CATEGORY_WORDS:
        if lab and rx.search(lab):
            return cat
    for rx, cat in _CATEGORY_WORDS:
        if rx.search(title or "") or rx.search(description or ""):
            return cat
    return "Other"


def parse_size(text: str) -> int:
    m = SIZE_RE.search(text or "")
    if not m:
        return 0
    n = float(m.group(1).replace(",", "."))
    return int(n * {"KB": 1024, "MB": 1024 ** 2, "GB": 1024 ** 3}[m.group(2).upper()])


def parse_cards(page_html: str) -> list[dict]:
    """[{id, title, version, author, supportsPs5, cover, details, downloads:{PS5,PS4}}] for every card on a page."""
    out: list[dict] = []
    seen: set[str] = set()
    for m in ARTICLE_RE.finditer(page_html or ""):
        card = m.group(1)
        idm = ID_RE.search(card)
        if not idm:
            continue
        app_id = idm.group(1)
        if app_id in seen:
            continue
        tm = TITLE_RE.search(card)
        title = _text(tm.group(1)) if tm else ""
        if not title:
            continue
        seen.add(app_id)
        vm = VERSION_RE.search(card)
        am = AUTHOR_RE.search(card)
        author = _text(am.group(1)) if am else ""
        ps5 = bool(PS5_RE.search(_text(card)))
        out.append({
            "id": app_id, "title": strip_marks(title), "version": (vm.group(1).strip() if vm else ""),
            "author": author, "supportsPs5": ps5,
            "cover": f"{BASE}/images/{app_id}/cover.png", "details": f"{BASE}/details/{app_id}",
            "downloads": {"PS5": f"{BASE}/download/ps5/{app_id}/latest", "PS4": f"{BASE}/download/ps4/{app_id}/latest"},
        })
    return out


_DETAIL_LABEL_RE = {
    "category": re.compile(r"categor(?:y|ies)\s*:?\s*(?:<[^>]+>\s*)*([A-Za-z][A-Za-z /&\-]{1,30})", re.I),
    "size": re.compile(r"(?:size|file\s*size)\s*:?\s*(?:<[^>]+>\s*)*(\d+(?:[.,]\d+)?\s*(?:KB|MB|GB))", re.I),
}
_DESC_RE = re.compile(r'<(?:p|div)[^>]+class="[^"]*(?:description|desc|about|summary)[^"]*"[^>]*>([\s\S]*?)</(?:p|div)>', re.I)
_OG_DESC_RE = re.compile(r'<meta\s+(?:property|name)="(?:og:)?description"\s+content="([^"]*)"', re.I)
_CHANGELOG_RE = re.compile(r"change\s*log[\s\S]{0,200}?<(?:pre|ul|ol|div|p)[^>]*>([\s\S]*?)</(?:pre|ul|ol|div|p)>", re.I)


def parse_details(page_html: str) -> dict:
    """{description, category, size, changelog} from a details page; empty values when absent."""
    doc = page_html or ""
    desc = ""
    m = _DESC_RE.search(doc)
    if m:
        desc = _text(m.group(1))
    if not desc:
        m = _OG_DESC_RE.search(doc)
        desc = _text(m.group(1)) if m else ""
    cat = ""
    m = _DETAIL_LABEL_RE["category"].search(doc)
    if m:
        cat = _text(m.group(1)).strip(" :-")
    size = 0
    m = _DETAIL_LABEL_RE["size"].search(doc)
    if m:
        size = parse_size(m.group(1))
    changelog = ""
    m = _CHANGELOG_RE.search(doc)
    if m:
        changelog = re.sub(r"\s*<\s*(?:br|/li|/p)\s*/?>\s*", "\n", m.group(1), flags=re.I)
        changelog = html.unescape(TAG_RE.sub("", changelog)).strip()[:600]
    return {"description": desc[:600], "category": cat, "size": size, "changelog": changelog}


def _release(card: dict, platform: str, size: int) -> Release:
    url = card["downloads"][platform]
    version = card.get("version") or ""
    vtag = re.sub(r"[^0-9A-Za-z.]+", "", version)
    filename = f"{card['id']}-{platform.lower()}" + (f"-v{vtag}" if vtag else "") + ".pkg"
    return Release(
        id=make_release_id("pkgzone", "", "app", version, url), url=url, sourceId=SOURCE.id, provider=PROVIDER,
        format="PKG", kind="app", version=version, filename=filename, browserUrl=card["details"], sizeBytes=size,
        notes=f"{platform} build" + (" · native PS5 package" if platform == "PS5" else ""),
    )


def draft_from_card(card: dict, details: dict | None = None) -> GameDraft:
    details = details or {}
    desc = details.get("description") or ""
    category = normalize_category(details.get("category") or "", card["title"], desc)
    size = int(details.get("size") or 0)
    releases: list[Release] = []
    if card.get("supportsPs5"):
        releases.append(_release(card, "PS5", size))
    releases.append(_release(card, "PS4", size))
    notes = details.get("changelog") or ""
    if notes:
        releases[0].notes = f"{releases[0].notes} · Changelog: {notes[:200]}"
    return GameDraft(
        source=SOURCE.id, title=card["title"], platform="HOMEBREW", releases=releases, priority=SOURCE.priority,
        slugHint=card["id"], pageUrl=card["details"], cover=card["cover"], description=desc,
        publisher=card.get("author") or "", author=card.get("author") or "pkg-zone", category=category,
        supportsPs5=bool(card.get("supportsPs5")),
    )


def fetch_online(ctx: SourceContext) -> list[GameDraft]:
    cards: dict[str, dict] = {}
    for page in range(1, MAX_PAGES + 1):
        if ctx.limit and len(cards) >= ctx.limit:
            break
        url = BASE + "/" if page == 1 else f"{BASE}/?page={page}"
        try:
            body = ctx.get_text(url, timeout=30, max_bytes=4 * 1024 * 1024)
        except BudgetExceeded:
            ctx.info(f"budget reached at page {page}")
            break
        except HttpError as e:
            if page == 1:
                raise
            ctx.info(f"page {page} failed ({e}); stopping")
            break
        rows = parse_cards(body)
        if not rows:
            break
        new = 0
        for c in rows:
            if c["id"] not in cards:
                cards[c["id"]] = c
                new += 1
        if new == 0:
            break
    if not cards:
        raise HttpError(BASE, 0, "no app cards parsed")
    details: dict[str, dict] = {}
    for i, (app_id, card) in enumerate(cards.items()):
        if i >= MAX_DETAIL_PAGES or ctx.time_left() < 15:
            break
        try:
            details[app_id] = parse_details(ctx.get_text(card["details"], timeout=25, max_bytes=2 * 1024 * 1024))
        except BudgetExceeded:
            break
        except HttpError:
            continue
    ctx.info(f"{len(cards)} apps, {len(details)} detail pages")
    return ctx.truncate([draft_from_card(c, details.get(c["id"])) for c in cards.values()])


SOURCE = SourceSpec(
    id="pkgzone", name="pkg-zone", priority=50, budget=240.0, release_source_ids=("pkgzone",),
    online=fetch_online, snapshot=None, description="pkg-zone.com homebrew app cards → HOMEBREW entries",
)
