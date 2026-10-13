"""arabicps4games.com — PS4 direct card grids and the PS5 direct list (port of scrapeFromArabicps4).

* PS4: ``/0/ps4/index.html`` + ``indexpages2..11.html``, raw HTML cards; every
  URL attribute is whitespace-padded and must be stripped; covers on postimg.cc.
* PS5: ``/0/ps5/index.html`` is JS ``unescape()``-obfuscated; we decode the
  percent-encoded block and read the justpaste.it anchors.
The torrent section is skipped on purpose: torrents cannot be fetched on the console.
"""
from __future__ import annotations

import html
import re

from merge import GameDraft, clean_title
from sources.base import BudgetExceeded, HttpError, SourceContext, SourceSpec, page_release

BASE = "https://arabicps4games.com/0/"
PROVIDER = "ArabicPS4Games"
PS4_PAGES = 11
UNESCAPE_RE = re.compile(r"unescape\('([^']{50,})'\)")
PS5_ANCHOR_RE = re.compile(r'<a\s[^>]*href="(https?://justpaste\.it/[^"]+)"[^>]*rel="nofollow"[^>]*>([^<]+)</a>', re.I)
TORRENT_PREFIX_RE = re.compile(r"^\[PS[45]\]\s*", re.I)
TITLE_ID_SUFFIX_RE = re.compile(r"\s*\((?:PPSA|CUSA|BCAS|BCES|BLES|NPEA|NPUB|BCEU|BLAS|BLUS)\d+\).*$", re.I)
VERSION_SUFFIX_RE = re.compile(r"\s*\[\d+\.\d+[^\]]*\]\s*$", re.I)


def decode_js_unescape(page_html: str) -> str:
    m = UNESCAPE_RE.search(page_html)
    if not m:
        return ""
    return re.sub(r"%([0-9A-Fa-f]{2})", lambda mm: chr(int(mm.group(1), 16)), m.group(1))


def parse_cards(page_html: str, platform: str) -> list[GameDraft]:
    out: list[GameDraft] = []
    seen: set[str] = set()
    for card in page_html.split("<li>")[1:]:
        m1 = re.search(r'href="([^"]+)"[^>]*class="video-tmb"', card, re.I) or \
            re.search(r'class="video-tmb"[^>]*href="([^"]+)"', card, re.I)
        mirror = (m1.group(1) if m1 else "").strip()
        if not mirror.startswith("http"):
            continue
        cm = re.search(r'<img[^>]+src="([^"]+)"', card, re.I)
        cover = (cm.group(1) if cm else "").strip()
        tm = re.search(r"card-body[\s\S]{0,600}?<a[^>]*>([\s\S]{1,200}?)<br", card, re.I) or \
            re.search(r"card-body[\s\S]{0,600}?<a[^>]*>([^<]{2,120})</a>", card, re.I)
        if not tm:
            continue
        name = re.sub(r"\s+", " ", re.sub(r"<[^>]+>", "", tm.group(1))).strip()
        name = TORRENT_PREFIX_RE.sub("", name)
        name = TITLE_ID_SUFFIX_RE.sub("", name).strip()
        name = VERSION_SUFFIX_RE.sub("", name).strip()
        name = clean_title(html.unescape(name))
        if len(name) < 2 or mirror in seen:
            continue
        seen.add(mirror)
        out.append(GameDraft(
            source=SOURCE.id, title=name, platform=platform, priority=SOURCE.priority, pageUrl=mirror,
            cover=cover if cover.startswith("http") else "",
            releases=[page_release(SOURCE.id, PROVIDER, mirror, platform=platform)],
        ))
    return out


def parse_ps5_list(page_html: str) -> list[GameDraft]:
    decoded = decode_js_unescape(page_html) or page_html
    out: list[GameDraft] = []
    seen: set[str] = set()
    for m in PS5_ANCHOR_RE.finditer(decoded):
        page_url = m.group(1).strip()
        name = clean_title(html.unescape(m.group(2)).strip())
        if not name or page_url in seen:
            continue
        seen.add(page_url)
        out.append(GameDraft(
            source=SOURCE.id, title=name, platform="PS5", priority=SOURCE.priority, pageUrl=page_url,
            releases=[page_release(SOURCE.id, PROVIDER, page_url, platform="PS5")],
        ))
    return out


def fetch_online(ctx: SourceContext) -> list[GameDraft]:
    drafts: dict[str, GameDraft] = {}
    for page in range(1, PS4_PAGES + 1):
        if ctx.limit and len(drafts) >= ctx.limit:
            break
        url = BASE + ("ps4/index.html" if page == 1 else f"ps4/indexpages{page}.html")
        try:
            body = ctx.get_text(url)
        except BudgetExceeded:
            break
        except HttpError as e:
            if page == 1:
                raise
            ctx.info(f"PS4 page {page} failed ({e}); stopping")
            break
        rows = parse_cards(body, "PS4")
        if not rows:
            break
        for d in rows:
            drafts.setdefault(d.pageUrl, d)
    try:
        body = ctx.get_text(BASE + "ps5/index.html")
        for d in parse_ps5_list(body) if len(body) > 500 else []:
            drafts.setdefault(d.pageUrl, d)
    except (HttpError, BudgetExceeded) as e:
        ctx.info(f"PS5 list failed ({e})")
    if not drafts:
        raise HttpError(BASE, 0, "no games parsed")
    return ctx.truncate(list(drafts.values()))


SOURCE = SourceSpec(
    id="arabicps4", name="ArabicPS4Games", priority=20, budget=120.0, release_source_ids=("arabicps4",),
    online=fetch_online, snapshot=None, description="arabicps4games.com PS4 card grids + PS5 direct list",
)
