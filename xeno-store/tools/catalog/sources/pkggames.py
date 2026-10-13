"""pkg.games — one static page lists every PS5 game as a plain <ul> (port of scrapeFromPkgGames).

No covers on the list page; the UI shows the title initial until it opens the
game page. Releases are PAGE releases pointing at ``https://pkg.games/ps5/<slug>/``.
"""
from __future__ import annotations

import html
import re

from merge import GameDraft, clean_title
from sources.base import HttpError, SourceContext, SourceSpec, page_release

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


def fetch_online(ctx: SourceContext) -> list[GameDraft]:
    body = ctx.get_text(LIST_URL, timeout=30)
    if len(body) < 500:
        raise HttpError(LIST_URL, 0, "list page too small")
    drafts = parse_listing(body)
    if not drafts:
        raise HttpError(LIST_URL, 0, "no games parsed")
    return ctx.truncate(drafts)


SOURCE = SourceSpec(
    id="pkggames", name="pkg.games", priority=30, budget=60.0, release_source_ids=("pkggames",),
    online=fetch_online, snapshot=None, description="pkg.games static PS5 game list",
)
