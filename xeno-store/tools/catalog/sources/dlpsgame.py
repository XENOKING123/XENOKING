"""dlpsgame.com — WordPress REST listing + per-post download bundles.

Faithful port of ``client/src/lib/xenoStore.ts`` (XENO TOOL):

* listing: ``/wp-json/wp/v2/posts?categories=<PS5|PS4>&per_page=100&page=N``
  with ``_embed=wp:featuredmedia`` for covers (first content image as fallback);
* bundle: every post body carries one or more base64 ``data-payload`` blocks,
  each owned by the closest preceding ``CUSA12345 - REGION (v1.23)`` heading.
  Inside, ``<p>`` sections read ``Game : …``, ``Update 1.37 (Fix 5.05/…) : …``,
  ``DLC (18) : …``, ``Password : …``; mirrors are the ``<a>`` tags (gateway
  links decoded) or, when the site lists hosts as plain text, the page itself.

Each section becomes a release (kind game/update/dlc) with ``mirrors`` and the
first mirror as ``url``. A post without any payload still yields one PAGE
release so the game stays browsable. The site 403s non-browser agents, so the
shared client sends a browser User-Agent and keeps to ~1 request/second.

Offline: ``catalog/snapshots/xeno-dlpsgame/catalog.json`` (name, platform,
cover_url, page_url) → one PAGE release per game.
"""
from __future__ import annotations

import base64
import binascii
import html
import re
import urllib.parse
from dataclasses import dataclass, field

from merge import (
    GameDraft, clean_title, make_release_id, parse_compat, parse_region, format_from_filename,
)
from schema import Release
from sources.base import BudgetExceeded, HttpError, SourceContext, SourceSpec, page_release, read_json_file
from sources import wpsite

BASE = "https://dlpsgame.com"
WP_API = BASE + "/wp-json/wp/v2/posts"
CATEGORY_IDS = {"PS5": 63019, "PS4": 4370}
PASSWORD = "DLPSGAME.COM"
PROVIDER = "DLPSGAME"
ID_PREFIX = "dlps"

HEADER_RE = re.compile(
    r"((?:CUSA|PPSA|PCAS)\s*\d{5})\s*[-–—]\s*([A-Z]{2,4}(?:\s*\([A-Za-z0-9\s]{1,15}\))?)"
    r"(?:\s*\(\s*v([0-9]+(?:\.[0-9]+){0,3})\s*\))?",
    re.I,
)
PAYLOAD_RE = re.compile(r'data-payload="([^"]+)"')
ANCHOR_RE = re.compile(r'<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)</a>', re.I)
P_BLOCK_RE = re.compile(r"<p[^>]*>([\s\S]*?)</p>", re.I)
TAG_RE = re.compile(r"<[^>]+>")
INLINE_ID_RE = re.compile(r"((?:C?USA|PPSA|PCAS)\d{5})\s*[-–—]\s*([A-Z]{2,4}(?:\s*\([^)]{1,15}\))?)", re.I)
UPDATE_RE = re.compile(r"^Update\s+([0-9]+(?:\.[0-9]+){0,3})\s*(\(([^)]+)\))?\s*:", re.I)
PASSWORD_RE = re.compile(r"^P[a]?(?:as)?sw[o]rd\s*:\s*(\S[^,]*)", re.I)
IMG_UPLOADS_RE = re.compile(r'<img[^>]+src="\s*(https?://[^"]+/wp-content/uploads/[^"]+\.(?:jpg|jpeg|png|webp))\s*"', re.I)
IMG_ANY_RE = re.compile(r'<img[^>]+src="\s*(https?://[^"\s]+\.(?:jpg|jpeg|png|webp))\s*"', re.I)
EXCLUDE_URL_RE = re.compile(r"guide-download-game|guide-download|tool-download", re.I)
EXCLUDE_LABEL_RE = re.compile(r"guide\s*download|tool\s*download|jdownload", re.I)
NON_HOST_WORD_RE = re.compile(
    r"^(v\d|fix|patch|here|click|link|dlc|update|game|password|works|voice|menu|screen|language|subtitle|region|thank|mega|free)",
    re.I,
)


@dataclass
class Mirror:
    host: str
    url: str
    indirect: bool = False


@dataclass
class BundleVersion:
    titleId: str
    region: str
    baseVersion: str = ""
    game: list[Mirror] | None = None
    updates: list[dict] = field(default_factory=list)   # {version, compat, mirrors}
    dlc: list[dict] = field(default_factory=list)       # {label, mirrors}
    password: str = ""
    languages: str = ""


def host_of(url: str) -> str:
    try:
        return (urllib.parse.urlsplit(url).hostname or "").lower().removeprefix("www.")
    except ValueError:
        return ""


def decode_gateway(url: str) -> str | None:
    """Real destination hidden in a shortener URL (base64/plain ``url=`` params, justpaste redirects)."""
    try:
        parts = urllib.parse.urlsplit(url)
    except ValueError:
        return None
    if "justpaste.it/redirect/" in url:
        segs = [s for s in parts.path.split("/") if s]
        if len(segs) >= 3:
            dest = urllib.parse.unquote(segs[2])
            if dest.startswith("http"):
                return dest
    q = urllib.parse.parse_qs(parts.query)
    for key in ("url", "u", "link", "id", "s"):
        for raw in q.get(key, []):
            if raw.startswith("http"):
                return raw
            try:
                pad = "=" * ((4 - len(raw) % 4) % 4)
                dec = base64.b64decode(raw.replace("-", "+").replace("_", "/") + pad).decode("utf-8", "ignore")
            except (binascii.Error, ValueError):
                continue
            if dec.startswith("http"):
                return dec
    return None


def extract_mirrors(fragment: str, fallback_url: str) -> list[Mirror]:
    out: list[Mirror] = []
    seen: set[str] = set()
    for m in ANCHOR_RE.finditer(fragment):
        url = m.group(1).strip()
        text = html.unescape(TAG_RE.sub("", m.group(2))).strip()
        if EXCLUDE_URL_RE.search(url) or EXCLUDE_LABEL_RE.search(text):
            continue
        dec = decode_gateway(url)
        if dec:
            url = dec
        if not url.startswith(("http://", "https://")) or url in seen:
            continue
        seen.add(url)
        out.append(Mirror(host=text or host_of(url), url=url))
    if not out and fallback_url:
        text = re.sub(r"\s+", " ", TAG_RE.sub(" ", fragment)).strip()
        colon = text.find(":")
        if colon != -1:
            for cand in re.split(r"\s*[–\-|/,]\s*", text[colon + 1:]):
                cand = cand.strip()
                if 2 <= len(cand) <= 24 and re.match(r"^[A-Za-z0-9]+$", cand) and not NON_HOST_WORD_RE.match(cand):
                    if cand in seen:
                        continue
                    seen.add(cand)
                    out.append(Mirror(host=cand, url=fallback_url, indirect=True))
    return out


def parse_version_block(decoded: str, header: dict | None, fallback_url: str) -> BundleVersion | None:
    decoded = html.unescape(decoded)
    m = INLINE_ID_RE.search(decoded)
    title_id = ((header or {}).get("titleId") or (m.group(1) if m else "") or "").upper()
    region = ((header or {}).get("region") or (m.group(2) if m else "") or "").upper()
    if not title_id:
        return None
    vm = re.search(r"v([0-9]+(?:\.[0-9]+){0,3})", decoded, re.I)
    base_version = (header or {}).get("version") or (vm.group(1) if vm else "")
    bv = BundleVersion(titleId=title_id, region=region, baseVersion=base_version or "")
    for raw in P_BLOCK_RE.findall(decoded):
        text = re.sub(r"\s+", " ", TAG_RE.sub(" ", raw)).strip()
        if not text or re.match(r"^Thank\b", text, re.I):
            continue
        if re.match(r"^Game\s*:", text, re.I):
            mirrors = extract_mirrors(raw, fallback_url)
            if mirrors or bv.game is None:
                bv.game = mirrors
            continue
        um = UPDATE_RE.match(text)
        if um:
            bv.updates.append({"version": um.group(1), "compat": (um.group(3) or "").strip(),
                               "mirrors": extract_mirrors(raw, fallback_url)})
            continue
        if re.match(r"^DLC\b[^:]*:", text, re.I):
            label = text[: text.index(":")].strip()
            if re.search(r"contents\b", label, re.I):
                continue
            bv.dlc.append({"label": label, "mirrors": extract_mirrors(raw, fallback_url)})
            continue
        pm = PASSWORD_RE.match(text)
        if pm and not bv.password:
            bv.password = re.sub(r"\s+\(.*$", "", pm.group(1)).strip()
            continue
        if re.match(r"^Languages?\s*:", text, re.I) and not re.search(r"voice|subtitle", text, re.I):
            if not bv.languages:
                bv.languages = re.sub(r"^Languages?\s*:\s*", "", text, flags=re.I).strip()
    if bv.game is None and not bv.updates and not bv.dlc:
        return None
    return bv


def parse_bundle(content_html: str, page_url: str) -> list[BundleVersion]:
    """All version blocks of a post body (``content.rendered``)."""
    text = html.unescape(content_html or "")
    headers = [{"titleId": re.sub(r"\s+", "", h.group(1)).upper(), "region": h.group(2).upper(),
                "version": h.group(3) or "", "idx": h.start()} for h in HEADER_RE.finditer(text)]
    versions: list[BundleVersion] = []
    for pm in PAYLOAD_RE.finditer(text):
        owner = None
        for h in headers:
            if h["idx"] < pm.start() and (owner is None or h["idx"] > owner["idx"]):
                owner = h
        try:
            decoded = base64.b64decode(re.sub(r"\s+", "", pm.group(1))).decode("utf-8", "replace")
        except (binascii.Error, ValueError):
            continue
        parsed = parse_version_block(decoded, owner, page_url)
        if parsed:
            versions.append(parsed)
    return versions


def _release(kind: str, mirrors: list[Mirror], *, title_id: str, region: str, version: str, compat: str,
             password: str, page_url: str, notes: str = "") -> Release | None:
    urls = [m.url for m in mirrors if not m.indirect]
    indirect_hosts = [m.host for m in mirrors if m.indirect]
    if not urls and not indirect_hosts:
        return None
    url = urls[0] if urls else page_url
    hosts = ", ".join(dict.fromkeys([m.host for m in mirrors if m.host]))
    note_parts = [p for p in (notes, f"Mirrors: {hosts}" if hosts else "") if p]
    if indirect_hosts and not urls:
        note_parts.append("Links are on the game page")
    return Release(
        id=make_release_id(ID_PREFIX, title_id, kind, version, url), url=url, sourceId=SOURCE.id,
        provider=PROVIDER, format=format_from_filename(url) or "PAGE", kind=kind, titleId=title_id,
        region=parse_region(region), version=version, browserUrl=page_url, mirrors=urls[1:],
        compat=" ".join(parse_compat(f"({compat})" if compat else "")), password=password or PASSWORD,
        notes=" · ".join(note_parts),
    )


def releases_from_bundle(versions: list[BundleVersion], page_url: str) -> list[Release]:
    out: list[Release] = []
    for bv in versions:
        pw = bv.password or PASSWORD
        lang = f"Languages: {bv.languages}" if bv.languages else ""
        if bv.game:
            r = _release("game", bv.game, title_id=bv.titleId, region=bv.region, version=bv.baseVersion, compat="",
                         password=pw, page_url=page_url, notes=lang)
            if r:
                out.append(r)
        for u in bv.updates:
            r = _release("update", u["mirrors"], title_id=bv.titleId, region=bv.region, version=u["version"],
                         compat=u["compat"], password=pw, page_url=page_url)
            if r:
                out.append(r)
        for d in bv.dlc:
            r = _release("dlc", d["mirrors"], title_id=bv.titleId, region=bv.region, version="", compat="",
                         password=pw, page_url=page_url, notes=d["label"])
            if r:
                out.append(r)
    return out


def cover_from_post(post: dict) -> str:
    embedded = post.get("_embedded") or {}
    fm = (embedded.get("wp:featuredmedia") or [{}])[0] or {}
    sizes = ((fm.get("media_details") or {}).get("sizes") or {})
    for key in ("medium_large", "medium"):
        u = (sizes.get(key) or {}).get("source_url")
        if u:
            return str(u)
    if fm.get("source_url"):
        return str(fm["source_url"])
    content = (post.get("content") or {}).get("rendered") or ""
    m = IMG_UPLOADS_RE.search(content) or IMG_ANY_RE.search(content)
    return m.group(1).strip() if m else ""


def draft_from_post(post: dict, platform: str) -> GameDraft | None:
    page_url = str(post.get("link") or "")
    title = clean_title(html.unescape(str((post.get("title") or {}).get("rendered") or "")))
    if not page_url or not title:
        return None
    content = (post.get("content") or {}).get("rendered") or ""
    releases = releases_from_bundle(parse_bundle(content, page_url), page_url)
    if not releases:
        releases = [page_release(SOURCE.id, PROVIDER, page_url, platform=platform, password=PASSWORD, prefix=ID_PREFIX)]
    return GameDraft(
        source=SOURCE.id, title=title, platform=platform, releases=releases, cover=cover_from_post(post),
        addedAt=str(post.get("date") or "")[:10], priority=SOURCE.priority, pageUrl=page_url,
    )


SITE = wpsite.SiteConfig(
    id="dlpsgame", name="DLPSGAME", base=BASE, provider=PROVIDER, password=PASSWORD, priority=60, budget=420.0,
    platforms={"PS5": ["ps5"], "PS4": ["ps4"]},
    category_urls={"PS5": [BASE + "/category/ps5/"], "PS4": [BASE + "/category/ps4/"]}, default_platform="PS4",
    rest=False, id_prefix=ID_PREFIX, description="dlpsgame.com WP REST + decoded bundles; sitemap/category fallback",
)


def draft_from_page_html(page_html: str, page_url: str) -> GameDraft | None:
    """A full post page (sitemap / category fallback): the generic parser for title/cover/platform, the
    deep bundle parser for the releases whenever the page still carries ``data-payload`` blocks."""
    d = wpsite.parse_page(SITE, page_html, page_url)
    if d is None:
        return None
    releases = releases_from_bundle(parse_bundle(page_html, page_url), page_url)
    if releases:
        d.releases = releases
    elif not d.releases:
        d.releases = [page_release(SOURCE.id, PROVIDER, page_url, platform=d.platform, password=PASSWORD, prefix=ID_PREFIX)]
    return d


def fetch_fallback(ctx: SourceContext) -> list[GameDraft]:
    """§17.10 strategies 2 and 3 when the REST listing is unavailable."""
    urls = wpsite.sitemap_post_urls(ctx, SITE)
    drafts: dict[str, GameDraft] = {}
    if urls:
        ctx.info(f"sitemap fallback: {len(urls)} post URLs")
        for url in urls[: SITE.max_posts]:
            if ctx.limit and len(drafts) >= ctx.limit:
                break
            try:
                body = ctx.get_text(url, timeout=30, max_bytes=4 * 1024 * 1024)
            except BudgetExceeded:
                break
            except HttpError:
                continue
            d = draft_from_page_html(body, url)
            if d:
                drafts[url] = d
    if not drafts:
        for d in wpsite.fetch_categories(ctx, SITE):
            drafts.setdefault(d.pageUrl, d)
    if not drafts:
        raise HttpError(BASE, 0, "no posts from sitemap or category pages")
    return ctx.truncate(list(drafts.values()))


def fetch_online(ctx: SourceContext) -> list[GameDraft]:
    try:
        return fetch_rest(ctx)
    except HttpError as e:
        ctx.info(f"REST listing failed ({e}); trying sitemap / category pages")
        return fetch_fallback(ctx)


def fetch_rest(ctx: SourceContext) -> list[GameDraft]:
    drafts: dict[str, GameDraft] = {}
    complete = True
    for platform, cat in CATEGORY_IDS.items():
        page = 1
        empty_streak = 0
        while True:
            if ctx.limit and len(drafts) >= ctx.limit:
                break
            if ctx.time_left() <= 0:
                complete = False
                ctx.info(f"{platform}: budget reached at page {page}")
                break
            url = (f"{WP_API}?categories={cat}&per_page=100&page={page}"
                   "&_embed=wp:featuredmedia&_fields=id,date,link,title,content,_embedded")
            try:
                posts = ctx.get_json(url, timeout=40)
            except BudgetExceeded:
                complete = False
                break
            except HttpError as e:
                if e.status == 400:      # rest_post_invalid_page_number: past the last page
                    break
                if page == 1:
                    raise
                ctx.info(f"{platform}: page {page} failed ({e}); stopping this category")
                complete = False
                break
            rows = [d for d in (draft_from_post(p, platform) for p in posts if isinstance(p, dict)) if d]
            if not rows:
                empty_streak += 1
                if empty_streak >= 2:
                    break
            else:
                empty_streak = 0
                for d in rows:
                    drafts.setdefault(d.pageUrl, d)
                if len(posts) < 100:
                    break
            page += 1
        ctx.info(f"{platform}: {sum(1 for d in drafts.values() if d.platform == platform)} posts")
    if not drafts:
        raise HttpError(WP_API, 0, "no posts returned")
    if not complete and not ctx.limit:
        # Partial run: top up with snapshot pages that were not reached.
        try:
            for d in load_snapshot(ctx):
                drafts.setdefault(d.pageUrl, d)
        except OSError:
            pass
    return ctx.truncate(list(drafts.values()))


def load_snapshot(ctx: SourceContext) -> list[GameDraft]:
    rows = read_json_file(ctx.snapshot("xeno-dlpsgame/catalog.json"))
    out: list[GameDraft] = []
    for row in rows:
        page_url = str(row.get("page_url") or "").strip()
        title = clean_title(str(row.get("name") or ""))
        platform = str(row.get("platform") or "").upper()
        if not page_url or not title or platform not in ("PS4", "PS5"):
            continue
        rel = page_release(SOURCE.id, PROVIDER, page_url, platform=platform, password=PASSWORD, prefix=ID_PREFIX)
        out.append(GameDraft(source=SOURCE.id, title=title, platform=platform, releases=[rel],
                             cover=str(row.get("cover_url") or ""), priority=SOURCE.priority, pageUrl=page_url))
    return ctx.truncate(out)


SOURCE = SourceSpec(
    id="dlpsgame", name="DLPSGAME", priority=60, budget=420.0, release_source_ids=("dlpsgame",),
    online=fetch_online, snapshot=load_snapshot,
    description="dlpsgame.com WordPress REST listing with decoded download bundles",
)
