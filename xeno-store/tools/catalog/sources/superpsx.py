"""superpsx.com — PS4/PS5 category listings → PAGE releases (port of scrapeFromSuperpsx).

The Pencil theme keeps each card's cover in a ``data-bgset`` attribute and the
title in ``h2.penci-entry-title > a``; both are harvested in one paired pass.
Game pages hide the real links behind a ``/dll-<slug>/`` hop, so the release is
the page itself (password ``SuperPSX``) and the UI resolves it on demand.
"""
from __future__ import annotations

import html
import re

from merge import GameDraft, clean_title
from sources.base import HttpError, SourceContext, SourceSpec, page_release
from sources.wpsite import SiteConfig, fetch_site

CATEGORY = {
    "PS4": ("https://www.superpsx.com/category/ps4/ps4-games-free/", 130),
    "PS5": ("https://www.superpsx.com/category/ps5/ps5-games/", 30),
}
PROVIDER = "SuperPSX"
PASSWORD = "SuperPSX"
BG_COVER_RE = re.compile(r'data-bgset="(https?://[^"]+/wp-content/uploads/[^"]+\.(?:webp|jpg|jpeg|png))"', re.I)
TITLE_LINK_RE = re.compile(
    r'class="[^"]*penci-entry-title[^"]*"[\s\S]{0,300}?<a\s[^>]*href="(https?://(?:www\.)?superpsx\.com/'
    r'(?!category|tag|page/|wp-|author|feed)[a-z0-9][a-z0-9-]*/)"[^>]*>([^<]{2,120})</a>',
    re.I,
)


def parse_listing(page_html: str, platform: str) -> list[GameDraft]:
    covers = BG_COVER_RE.findall(page_html)
    out: list[GameDraft] = []
    for i, m in enumerate(TITLE_LINK_RE.finditer(page_html)):
        page_url = m.group(1)
        name = html.unescape(m.group(2)).strip()
        name = re.sub(r"\s*[\[(][^\])]*[\])]", "", name).strip()
        name = re.sub(r"\s+(PS[45]|FPkg|fpkg|PKG)\b.*", "", name, flags=re.I).strip()
        name = clean_title(name) or clean_title(m.group(2))
        if not name:
            continue
        out.append(GameDraft(
            source=SOURCE.id, title=name, platform=platform, priority=SOURCE.priority, pageUrl=page_url,
            cover=covers[i] if i < len(covers) else "",
            releases=[page_release(SOURCE.id, PROVIDER, page_url, platform=platform, password=PASSWORD)],
        ))
    return out


SITE = SiteConfig(
    id="superpsx", name="SuperPSX", base="https://www.superpsx.com", provider=PROVIDER, password=PASSWORD,
    priority=40, budget=240.0, platforms={"PS5": ["ps5-games", "ps5"], "PS4": ["ps4-games-free", "ps4"]},
    category_urls={p: [u] for p, (u, _) in CATEGORY.items()}, default_platform="PS4",
    listing_parser=lambda body, platform: parse_listing(body, platform), max_pages=130,
    description="superpsx.com (WP REST → sitemap → Pencil category listings)",
)


def fetch_online(ctx: SourceContext) -> list[GameDraft]:
    """§17.10 strategies in order; the Pencil-theme listing parser above is the category-page fallback."""
    drafts = fetch_site(ctx, SITE)
    if not drafts:
        raise HttpError(CATEGORY["PS4"][0], 0, "no games parsed")
    return drafts


SOURCE = SourceSpec(
    id="superpsx", name="SuperPSX", priority=40, budget=240.0, release_source_ids=("superpsx",),
    online=fetch_online, snapshot=None, description=SITE.description,
)
