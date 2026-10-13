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
from sources.base import HttpError, SourceContext, SourceSpec, page_release
from sources.wpsite import SiteConfig, fetch_site

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


SITE = SiteConfig(
    id="pspkg", name="pspkg.com", base=BASE, provider=PROVIDER, priority=30, budget=180.0,
    platforms={"PS5": ["ps5"], "PS4": ["ps4"]}, category_urls={"PS5": [BASE + "ps5/"], "PS4": [BASE + "ps4/"]},
    default_platform="PS4", listing_parser=parse_listing, max_pages=MAX_PAGES,
    description="pspkg.com (WP REST → sitemap → paginated PS4/PS5 listings; Cloudflare often blocks)",
)


def fetch_online(ctx: SourceContext) -> list[GameDraft]:
    drafts = fetch_site(ctx, SITE)
    if not drafts:
        raise HttpError(BASE, 0, "no games parsed")
    return drafts


SOURCE = SourceSpec(
    id="pspkg", name="pspkg.com", priority=30, budget=180.0, release_source_ids=("pspkg",),
    online=fetch_online, snapshot=None, description=SITE.description,
)
