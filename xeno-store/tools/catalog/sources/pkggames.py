"""pkg.games — one static page lists every PS5 game as a plain <ul> (port of scrapeFromPkgGames).

No covers on the list page; the UI shows the title initial until it opens the
game page. Releases are PAGE releases pointing at ``https://pkg.games/ps5/<slug>/``.
"""
from __future__ import annotations

import html
import re

from merge import GameDraft, clean_title
from sources.base import HttpError, SourceContext, SourceSpec, page_release
from sources.wpsite import SiteConfig, fetch_site

LIST_URL = "https://pkg.games/ps5-game-list/"
PROVIDER = "pkg.games"
ENTRY_RE = re.compile(r'href="(https://pkg\.games/ps5/[a-z0-9\-/]+?/)"[^>]*>\s*([^<]+)', re.I)


def parse_listing(page_html: str) -> list[GameDraft]:
    out: list[GameDraft] = []
    seen: set[str] = set()
    for m in ENTRY_RE.finditer(page_html):
        page_url = m.group(1)
        name = clean_title(html.unescape(m.group(2)).strip())
        if not name or page_url in seen:
            continue
        seen.add(page_url)
        out.append(GameDraft(
            source=SOURCE.id, title=name, platform="PS5", priority=SOURCE.priority, pageUrl=page_url,
            releases=[page_release(SOURCE.id, PROVIDER, page_url, platform="PS5")],
        ))
    return out


SITE = SiteConfig(
    id="pkggames", name="pkg.games", base="https://pkg.games", provider=PROVIDER, priority=30, budget=90.0,
    platforms={"PS5": ["ps5"]}, category_urls={"PS5": [LIST_URL]}, default_platform="PS5",
    listing_parser=lambda body, platform: parse_listing(body), max_pages=1, fetch_pages=True,
    description="pkg.games (WP REST → sitemap → static PS5 game list)",
)


def fetch_online(ctx: SourceContext) -> list[GameDraft]:
    drafts = fetch_site(ctx, SITE)
    if not drafts:
        raise HttpError(LIST_URL, 0, "no games parsed")
    return drafts


SOURCE = SourceSpec(
    id="pkggames", name="pkg.games", priority=30, budget=60.0, release_source_ids=("pkggames",),
    online=fetch_online, snapshot=None, description=SITE.description,
)
