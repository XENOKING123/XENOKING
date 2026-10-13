"""pspkg.com — paginated /ps4/ and /ps5/ listings (port of scrapeFromPspkg).

Entries look like ``https://pspkg.com/ps4/download-<slug>-ps4-<id>.html``; the
600 characters after each link hold the title (alt/title attribute or anchor
text) and the cover image. The site sits behind Cloudflare, so a plain fetch
often fails; the build then falls back to the previous catalog's pspkg entries.
"""
from __future__ import annotations

import html
import re

from merge import GameDraft, clean_title
from sources.base import BudgetExceeded, HttpError, SourceContext, SourceSpec, page_release

BASE = "https://pspkg.com/"
PROVIDER = "pspkg.com"
MAX_PAGES = 80
SKIP_TITLE_RE = re.compile(r"^(download|game|update|dlc|click|here|free|ps[45]|4gamer|password|region)", re.I)
IMG_RE = re.compile(r'src="(https?://[^"]+\.(?:jpg|jpeg|png|webp))"', re.I)


def parse_listing(page_html: str, platform: str) -> list[GameDraft]:
    pfx = platform.lower()
    link_re = re.compile(rf'href="(https://pspkg\.com/{pfx}/download-([a-z0-9\-]+)-{pfx}-\d+\.html)"', re.I)
    out: list[GameDraft] = []
    seen: set[str] = set()
    for m in link_re.finditer(page_html):
        page_url, slug = m.group(1), m.group(2)
        if page_url in seen:
            continue
        seen.add(page_url)
        chunk = page_html[m.start(): m.start() + 600]
        name = ""
        candidates = re.findall(r'(?:alt|title)="([^"]{4,120})"', chunk, re.I) + re.findall(r">([^<]{4,80})<", chunk)
        for cand in candidates:
            cand = html.unescape(cand).strip()
            if len(cand) >= 4 and not SKIP_TITLE_RE.match(cand):
                name = cand
                break
        if not name:
            name = re.sub(rf"-{pfx}$", "", slug, flags=re.I).replace("-", " ").title()
        img = IMG_RE.search(chunk)
        out.append(GameDraft(
            source=SOURCE.id, title=clean_title(name), platform=platform, priority=SOURCE.priority,
            pageUrl=page_url, cover=img.group(1) if img else "",
            releases=[page_release(SOURCE.id, PROVIDER, page_url, platform=platform)],
        ))
    return out


def fetch_online(ctx: SourceContext) -> list[GameDraft]:
    drafts: dict[str, GameDraft] = {}
    for platform in ("PS5", "PS4"):
        base = f"{BASE}{platform.lower()}/"
        for page in range(1, MAX_PAGES + 1):
            if ctx.limit and len(drafts) >= ctx.limit:
                break
            url = base if page == 1 else f"{base}page/{page}/"
            try:
                body = ctx.get_text(url)
            except BudgetExceeded:
                ctx.info(f"{platform}: budget reached at page {page}")
                break
            except HttpError as e:
                if page == 1 and platform == "PS5":
                    raise
                ctx.info(f"{platform}: page {page} failed ({e}); stopping")
                break
            if len(body) < 500:
                break
            rows = parse_listing(body, platform)
            added = 0
            for d in rows:
                if d.pageUrl not in drafts:
                    drafts[d.pageUrl] = d
                    added += 1
            if added == 0 or (added < 8 and page > 1):
                break
    if not drafts:
        raise HttpError(BASE, 0, "no games parsed")
    return ctx.truncate(list(drafts.values()))


SOURCE = SourceSpec(
    id="pspkg", name="pspkg.com", priority=30, budget=180.0, release_source_ids=("pspkg",),
    online=fetch_online, snapshot=None, description="pspkg.com PS4/PS5 listings",
)
