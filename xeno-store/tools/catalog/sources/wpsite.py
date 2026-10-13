"""Generic WordPress game-site adapter (SPEC §17.10).

A site is a ``SiteConfig``; ``fetch_site`` tries, in order and stopping at the first strategy
that yields posts:

1. the WP REST API — ``/wp-json/wp/v2/posts?per_page=100&page=N&_fields=id,date,title,link,content,
   excerpt,featured_media,categories`` (plus ``_embed=wp:featuredmedia`` for covers; ``/wp-json/wp/v2/
   media/<id>`` only for posts that still have no cover, capped);
2. sitemaps — ``/sitemap_index.xml`` → ``post-sitemap*.xml`` (also ``/post-sitemap.xml``,
   ``/wp-sitemap-posts-post-N.xml``, ``/sitemap.xml``) → post URLs → each page is fetched and parsed;
3. category listing pages with pagination (``/category/<slug>/page/N/``), parsed by the site's own
   listing parser when it has one, else by the generic card parser.

Page parsing (``parse_post``) follows the §17.10 rules: title cleanup (``merge.clean_title``),
platform from categories / URL / title / title ids, title ids ``(PPSA|CUSA)\\d{5}``, versions,
firmware tags, backport tags, kinds (game/update/dlc/backport), download anchors with host
classification (terminal hosts become release URLs, gateways become mirrors the UI resolves),
cover (featured image / og:image / first content image), passwords, sizes. A post without any
usable link still yields one PAGE release so the game stays browsable.

Politeness is the shared ``netutil.Http`` (browser UA, 1 req/s per host, retries) plus the
source's deadline; every strategy stops cleanly when the budget runs out and returns what it has.
"""
from __future__ import annotations

import html
import re
import urllib.parse
from dataclasses import dataclass, field
from typing import Any, Callable

from merge import (
    GameDraft, clean_title, detect_kind, format_from_filename, make_release_id, parse_backport, parse_compat,
    parse_region, parse_title_ids, parse_version, platform_for_title_id, strip_marks,
)
from netutil import BudgetExceeded, HttpError
from schema import Release
from sources.base import SourceContext, page_release

# --------------------------------------------------------------------------- #
# Host classification
# --------------------------------------------------------------------------- #

TERMINAL_HOSTS = (
    "mediafire.com", "1fichier.com", "vikingfile.com", "akirabox.com", "buzzheavier.com", "gofile.io",
    "pixeldrain.com", "archive.org", "send.cm", "datanodes.to", "qiwi.gg", "krakenfiles.com", "bowfile.com",
    "fileaxa.com", "ranoz.gg", "hexload.com", "uploadhaven.com", "fastupload.io", "up-load.io", "ufile.io",
    "filesadmin.com", "ddownload.com", "rapidgator.net", "nitroflare.com", "katfile.com", "turbobit.net",
    "hitfile.net", "mega.nz", "mega.co.nz", "drive.google.com", "dropbox.com", "terabox.com", "1024terabox.com",
    "workupload.com", "anonfiles.com", "bayfiles.com", "letsupload.io", "uptobox.com", "zippyshare.com",
    "filen.io", "icedrive.net", "torrentmac.net",
)
GATEWAY_HOSTS = (
    "filecrypt.cc", "filecrypt.co", "ouo.io", "ouo.press", "shrinkme.io", "shrinkme.ink", "exe.io", "exey.io",
    "gplinks.in", "gplinks.co", "linkvertise.com", "cuty.io", "cutt.ly", "bit.ly", "rb.gy", "tinyurl.com",
    "shorte.st", "adf.ly", "linkspy.cc", "link1s.com", "mboost.me", "boost.ink", "bstlar.com", "justpaste.it",
    "paste.fo", "pastebin.com", "rentry.co", "sharer.pw", "shrinke.me", "za.gl", "zagl.org", "safelinku.com",
    "linkvertise.net", "ouo.co", "lootlinks.com", "lootlink.com", "loot-link.com", "lootdest.org", "clk.sh",
    "up2earn.com", "short.gy", "tiny.cc", "1link.club", "urlty.co", "ulinks.cc", "multiup.io", "multiup.org",
    "mirrored.to", "mirrorace.com", "hb.bizmrg.com",
)
_DOWNLOAD_WORD_RE = re.compile(
    r"download|mirror|link|here|part\s*\d|\b(?:mega|mediafire|1fichier|gofile|pixeldrain|viking|akira|buzz|torrent|"
    r"1f|gd|gdrive|drive|dropbox|terabox|direct|ddl)\b|\.(?:pkg|zip|rar|7z|ffpfsc|exfat)\b",
    re.I,
)


def host_of(url: str) -> str:
    try:
        return (urllib.parse.urlsplit(url).hostname or "").lower().removeprefix("www.")
    except ValueError:
        return ""


def _host_in(host: str, table: tuple[str, ...]) -> bool:
    return any(host == h or host.endswith("." + h) for h in table)


def classify_host(url: str, site_host: str = "") -> str:
    """'terminal' (the file lives there), 'gateway' (shortener / link crypter), 'site' (same site), 'other'."""
    host = host_of(url)
    if not host:
        return "other"
    if site_host and (host == site_host or host.endswith("." + site_host)):
        return "site"
    if _host_in(host, TERMINAL_HOSTS):
        return "terminal"
    if _host_in(host, GATEWAY_HOSTS):
        return "gateway"
    return "other"


# --------------------------------------------------------------------------- #
# Text rules
# --------------------------------------------------------------------------- #

PASSWORD_RE = re.compile(r"pass(?:word|wort|\b)\s*(?:is|=|:)?\s*[:\-]?\s*(?:<[^>]+>\s*)*([^\s<,;]{3,40})", re.I)
SIZE_RE = re.compile(r"(\d+(?:[.,]\d+)?)\s*(GB|MB|TB)\b", re.I)
_PASSWORD_NOISE = {"is", "protected", "required", "none", "no", "not", "needed", "the", "for", "archive", "rar", "zip"}
_TAG_RE = re.compile(r"<[^>]+>")
_WS_RE = re.compile(r"\s+")
_ANCHOR_RE = re.compile(r'<a\s[^>]*?href\s*=\s*["\']([^"\']+)["\'][^>]*>([\s\S]*?)</a>', re.I)
_HEADING_RE = re.compile(r"<(h[1-6]|strong|b|p|li|div|span|td|summary)[^>]*>([\s\S]*?)</\1>", re.I)
_IMG_RE = re.compile(r'<img[^>]+(?:data-src|data-lazy-src|data-bgset|src)\s*=\s*["\']\s*(https?://[^"\'\s]+)\s*["\']', re.I)
_OG_IMAGE_RE = re.compile(r'<meta\s+(?:property|name)=["\']og:image["\']\s+content=["\']([^"\']+)["\']', re.I)
_OG_IMAGE_RE2 = re.compile(r'<meta\s+content=["\']([^"\']+)["\']\s+(?:property|name)=["\']og:image["\']', re.I)
_OG_TITLE_RE = re.compile(r'<meta\s+(?:property|name)=["\']og:title["\']\s+content=["\']([^"\']+)["\']', re.I)
_H1_RE = re.compile(r"<h1[^>]*>([\s\S]*?)</h1>", re.I)
_TITLE_TAG_RE = re.compile(r"<title[^>]*>([\s\S]*?)</title>", re.I)
_CONTENT_RE = re.compile(
    r'<(?:div|article|section)[^>]+class=["\'][^"\']*(?:entry-content|post-content|td-post-content|article-content|'
    r'single-content|content-area|post-body|the-content|post-entry|entry)[^"\']*["\'][^>]*>([\s\S]*?)'
    r'(?:<footer|<div[^>]+class=["\'][^"\']*(?:comments|related|sidebar|post-tags)|</article>|</main>)', re.I)
_DATE_META_RE = re.compile(r'(?:article:published_time|datePublished)["\']?\s*(?:content=|:)\s*["\']([0-9]{4}-[0-9]{2}-[0-9]{2})', re.I)
_PLATFORM_HINT_RE = re.compile(r"\b(ps5|ps4|playstation\s*5|playstation\s*4)\b", re.I)
_LOC_RE = re.compile(r"<loc>\s*([^<\s]+)\s*</loc>", re.I)
_SITEMAP_SKIP_RE = re.compile(r"/(?:category|tag|author|page|feed|wp-content|wp-json|search|privacy|contact|about|dmca|faq)(?:/|$)|\?", re.I)
_CARD_RE = re.compile(
    r'<(?:article|div|li)[^>]+class=["\'][^"\']*(?:\bpost\b|type-post|entry|item|card|product|game|td_module|penci)[^"\']*["\'][^>]*>([\s\S]*?)</(?:article|div|li)>',
    re.I,
)
_CARD_LINK_RE = re.compile(r'<a\s[^>]*?href=["\'](https?://[^"\']+)["\'][^>]*>([\s\S]*?)</a>', re.I)
_SKIP_LABEL_RE = re.compile(r"^(?:read more|continue|more|comments?|\d+|home|next|prev(?:ious)?|›|«|»)$", re.I)


def text_of(fragment: str) -> str:
    return _WS_RE.sub(" ", html.unescape(_TAG_RE.sub(" ", fragment or ""))).strip()


def parse_password(text: str, default: str = "") -> str:
    """'Password: DLPSGAME.COM' / 'Pass = xyz' -> 'xyz'; the site default when the text names none."""
    for m in PASSWORD_RE.finditer(text or ""):
        cand = m.group(1).strip().strip("\"'`.;:,()[]")
        if cand and cand.lower() not in _PASSWORD_NOISE and not cand.lower().startswith("http"):
            return cand
    return default


def parse_size(text: str) -> int:
    """First 'NN.N GB/MB/TB' in ``text`` as bytes (0 when none)."""
    m = SIZE_RE.search(text or "")
    if not m:
        return 0
    num = float(m.group(1).replace(",", "."))
    unit = m.group(2).upper()
    mult = {"MB": 1024 ** 2, "GB": 1024 ** 3, "TB": 1024 ** 4}[unit]
    return int(num * mult)


def platform_from(categories: list[str], url: str, title: str, title_ids: list[str], default: str) -> str:
    """Platform from category names/slugs, the URL, the title, then the title ids."""
    for cat in categories:
        m = _PLATFORM_HINT_RE.search(cat or "")
        if m:
            return "PS5" if "5" in m.group(1) else "PS4"
    for text in (url, title):
        m = _PLATFORM_HINT_RE.search(text or "")
        if m:
            return "PS5" if "5" in m.group(1) else "PS4"
    for tid in title_ids:
        p = platform_for_title_id(tid)
        if p:
            return p
    return default


def cover_from(content: str, page_html: str = "", featured: str = "") -> str:
    if featured and featured.startswith(("http://", "https://")):
        return featured
    for rx in (_OG_IMAGE_RE, _OG_IMAGE_RE2):
        m = rx.search(page_html or "")
        if m and m.group(1).startswith(("http://", "https://")):
            return html.unescape(m.group(1))
    for m in _IMG_RE.finditer(content or ""):
        u = html.unescape(m.group(1))
        if re.search(r"\.(?:jpe?g|png|webp|avif)(?:\?|$)", u, re.I) and not re.search(r"emoji|smilies|avatar|logo|icon|banner-ad", u, re.I):
            return u
    return ""


# --------------------------------------------------------------------------- #
# Post → draft
# --------------------------------------------------------------------------- #

@dataclass
class LinkInfo:
    url: str
    label: str          # anchor text
    section: str        # nearest preceding heading / strong text
    cls: str            # terminal | gateway | other


def extract_links(content: str, site_host: str) -> list[LinkInfo]:
    """Every download-looking anchor of a post body with its section label, in document order."""
    out: list[LinkInfo] = []
    seen: set[str] = set()
    section = ""
    pos = 0
    events: list[tuple[int, str, Any]] = []
    for m in _HEADING_RE.finditer(content or ""):
        t = text_of(m.group(2))
        if 0 < len(t) <= 120 and not _ANCHOR_RE.search(m.group(2)):
            events.append((m.start(), "h", t))
    for m in _ANCHOR_RE.finditer(content or ""):
        events.append((m.start(), "a", m))
    events.sort(key=lambda e: e[0])
    for pos, kind, payload in events:
        if kind == "h":
            section = payload
            continue
        m = payload
        url = html.unescape(m.group(1).strip())
        label = text_of(m.group(2))
        if not url.startswith(("http://", "https://")) or url in seen:
            continue
        cls = classify_host(url, site_host)
        if cls == "site":
            continue
        if cls == "other" and not _DOWNLOAD_WORD_RE.search(label + " " + url):
            continue
        seen.add(url)
        out.append(LinkInfo(url=url, label=label, section=section, cls=cls))
    return out


@dataclass
class ReleaseGroup:
    kind: str
    version: str
    backport_fw: str
    title_id: str
    region: str
    compat: str
    size: int
    label: str
    links: list[LinkInfo] = field(default_factory=list)


def group_links(links: list[LinkInfo], default_title_id: str, default_region: str) -> list[ReleaseGroup]:
    """Links that describe the same thing (kind/version/backport/title id) form one release with mirrors."""
    groups: dict[tuple, ReleaseGroup] = {}
    order: list[tuple] = []
    for ln in links:
        ctx_text = f"{ln.section} {ln.label}"
        is_bp, bp_fw = parse_backport(ctx_text)
        compat_tags = parse_compat(ctx_text)
        if is_bp and not bp_fw and compat_tags:
            bp_fw = min(compat_tags, key=lambda t: (float(re.sub(r"[^0-9.]", "", t.replace(".xx", ".0")) or 0), t))
        kind = "backport" if is_bp and bp_fw else detect_kind(ln.section or ln.label, ln.label, "")
        if kind == "backport" and not bp_fw:
            kind = "update"
        version = parse_version(ctx_text)
        ids = parse_title_ids(ctx_text)
        title_id = ids[0] if ids else default_title_id
        region = parse_region(ln.section) or parse_region(ln.label) or default_region
        key = (kind, version, bp_fw, title_id, region)
        g = groups.get(key)
        if g is None:
            g = ReleaseGroup(kind=kind, version=version, backport_fw=bp_fw, title_id=title_id, region=region,
                             compat=" ".join(compat_tags), size=parse_size(ctx_text), label=ln.section or ln.label)
            groups[key] = g
            order.append(key)
        if not g.size:
            g.size = parse_size(ctx_text)
        g.links.append(ln)
    return [groups[k] for k in order]


def releases_from_groups(groups: list[ReleaseGroup], *, site_id: str, provider: str, page_url: str, password: str,
                         prefix: str, post_size: int) -> list[Release]:
    out: list[Release] = []
    for g in groups:
        terminals = [l for l in g.links if l.cls == "terminal"]
        gateways = [l for l in g.links if l.cls == "gateway"]
        others = [l for l in g.links if l.cls == "other"]
        ordered = terminals + gateways + others
        if not ordered:
            continue
        primary = ordered[0]
        hosts = list(dict.fromkeys(host_of(l.url) for l in ordered if host_of(l.url)))
        notes = [g.label[:80]] if g.label and g.label.lower() not in ("download", "download links", "links") else []
        if hosts:
            notes.append("Mirrors: " + ", ".join(hosts[:8]))
        if gateways and not terminals:
            notes.append("Links open through a link gateway")
        fname = primary.label if re.search(r"\.(?:pkg|zip|rar|7z|ffpfsc|exfat|ffpkg)$", primary.label, re.I) else ""
        fmt = format_from_filename(primary.url) or format_from_filename(fname) or "PAGE"
        out.append(Release(
            id=make_release_id(prefix, g.title_id, g.kind, g.version, primary.url), url=primary.url, sourceId=site_id,
            provider=provider, format=fmt, kind=g.kind, titleId=g.title_id, region=g.region, version=g.version,
            filename=fname, browserUrl=page_url, mirrors=[l.url for l in ordered[1:]], sizeBytes=g.size or post_size,
            compat=g.compat, password=password, notes=" · ".join(n for n in notes if n),
            backportFw=g.backport_fw, requiresFw=g.backport_fw,
        ))
    return out


@dataclass
class SiteConfig:
    """One WordPress-style game site. Only ``id``/``name``/``base`` are required."""
    id: str
    name: str
    base: str
    provider: str = ""
    password: str = ""
    priority: int = 30
    budget: float = 180.0
    platforms: dict[str, list[str]] = field(default_factory=lambda: {"PS5": ["ps5"], "PS4": ["ps4"]})
    category_urls: dict[str, list[str]] = field(default_factory=dict)   # explicit listing URLs per platform
    default_platform: str = "PS4"
    rest: bool = True
    sitemap: bool = True
    listing_parser: Callable[[str, str], list[GameDraft]] | None = None  # (html, platform) → drafts (strategy 3)
    fetch_pages: bool = True        # strategies 2/3: fetch each post page to read its links
    max_posts: int = 2500
    max_pages: int = 40
    max_media_lookups: int = 150
    id_prefix: str = ""
    skip_url_re: re.Pattern | None = None
    description: str = ""

    @property
    def host(self) -> str:
        return host_of(self.base)

    @property
    def prefix(self) -> str:
        return self.id_prefix or self.id


def parse_post(cfg: SiteConfig, *, title: str, url: str, content: str, categories: list[str] | None = None,
               date: str = "", featured: str = "", page_html: str = "") -> GameDraft | None:
    """Apply the §17.10 page rules to one post; None when there is no usable title or URL."""
    if cfg.skip_url_re and cfg.skip_url_re.search(url or ""):
        return None
    raw_title = html.unescape(strip_marks(title))
    name = clean_title(raw_title)
    if not name or not url.startswith(("http://", "https://")):
        return None
    content = content or ""
    text = text_of(content)
    title_ids = parse_title_ids(raw_title + " " + text[:4000])
    platform = platform_from(categories or [], url, raw_title, title_ids, cfg.default_platform)
    own_ids = [t for t in title_ids if platform_for_title_id(t) in ("", platform)]
    password = parse_password(text, cfg.password)
    region = parse_region(raw_title)
    post_size = parse_size(raw_title) or parse_size(text[:3000])
    links = extract_links(content, cfg.host)
    groups = group_links(links, own_ids[0] if own_ids else "", region)
    releases = releases_from_groups(groups, site_id=cfg.id, provider=cfg.provider or cfg.name, page_url=url,
                                    password=password, prefix=cfg.prefix, post_size=post_size)
    if not releases:
        rel = page_release(cfg.id, cfg.provider or cfg.name, url, title_id=own_ids[0] if own_ids else "",
                           platform=platform, password=password, prefix=cfg.prefix)
        rel.sizeBytes = post_size
        rel.compat = " ".join(parse_compat(raw_title))
        is_bp, bp_fw = parse_backport(raw_title)
        if is_bp:
            rel.backportFw = bp_fw or (rel.compat.split()[0] if rel.compat else "")
            if rel.backportFw:
                rel.kind = "backport"
        rel.version = parse_version(raw_title)
        rel.region = region
        releases = [rel]
    return GameDraft(
        source=cfg.id, title=name, platform=platform, releases=releases, titleIds=own_ids, region=region,
        cover=cover_from(content, page_html, featured), addedAt=(date or "")[:10], priority=cfg.priority, pageUrl=url,
    )


def parse_page(cfg: SiteConfig, page_html: str, url: str) -> GameDraft | None:
    """A full post page (strategies 2 and 3): title from h1/og:title/<title>, body from the content block."""
    title = ""
    for rx in (_H1_RE, _OG_TITLE_RE, _TITLE_TAG_RE):
        m = rx.search(page_html or "")
        if m:
            title = text_of(m.group(1))
            if rx is _TITLE_TAG_RE:
                title = re.split(r"\s+[|\-–]\s+", title)[0]
            if title:
                break
    m = _CONTENT_RE.search(page_html or "")
    content = m.group(1) if m else (page_html or "")
    dm = _DATE_META_RE.search(page_html or "")
    cats = re.findall(r'rel=["\']category(?: tag)?["\'][^>]*>([^<]+)<', page_html or "", re.I)
    return parse_post(cfg, title=title, url=url, content=content, categories=cats, date=dm.group(1) if dm else "",
                      page_html=page_html)


def parse_listing_cards(cfg: SiteConfig, page_html: str, platform: str) -> list[GameDraft]:
    """Generic category-page parser: cards with a post link, a title and (maybe) a cover → PAGE drafts."""
    out: list[GameDraft] = []
    seen: set[str] = set()
    base_host = cfg.host
    for m in _CARD_RE.finditer(page_html or ""):
        card = m.group(1)
        link, title = "", ""
        for lm in _CARD_LINK_RE.finditer(card):
            u, label = html.unescape(lm.group(1)), text_of(lm.group(2))
            if host_of(u) != base_host or _SITEMAP_SKIP_RE.search(u) or _SKIP_LABEL_RE.match(label or "x"):
                continue
            if not link:
                link = u
            if label and len(label) > len(title):
                title, link = label, u
        if not link or link in seen or not title:
            continue
        seen.add(link)
        img = _IMG_RE.search(card)
        d = parse_post(cfg, title=title, url=link, content="", categories=[platform],
                       featured=html.unescape(img.group(1)) if img else "")
        if d:
            d.platform = platform
            out.append(d)
    return out


# --------------------------------------------------------------------------- #
# Strategies
# --------------------------------------------------------------------------- #

def _rest_url(cfg: SiteConfig, page: int, category: int | None) -> str:
    q = {"per_page": "100", "page": str(page), "_embed": "wp:featuredmedia",
         "_fields": "id,date,title,link,content,excerpt,featured_media,categories,_embedded"}
    if category:
        q["categories"] = str(category)
    return f"{cfg.base.rstrip('/')}/wp-json/wp/v2/posts?" + urllib.parse.urlencode(q)


def resolve_categories(ctx: SourceContext, cfg: SiteConfig) -> dict[str, list[int]]:
    """Platform → WP category ids, by slug match against /wp-json/wp/v2/categories (empty when unavailable)."""
    out: dict[str, list[int]] = {}
    try:
        rows = ctx.get_json(f"{cfg.base.rstrip('/')}/wp-json/wp/v2/categories?per_page=100&_fields=id,slug,name,count", timeout=25)
    except (HttpError, BudgetExceeded):
        return out
    for row in rows if isinstance(rows, list) else []:
        if not isinstance(row, dict):
            continue
        slug = str(row.get("slug") or "").lower()
        name = str(row.get("name") or "").lower()
        for platform, slugs in cfg.platforms.items():
            if any(s == slug or s in slug or s in name for s in slugs):
                try:
                    out.setdefault(platform, []).append(int(row["id"]))
                except (KeyError, TypeError, ValueError):
                    pass
    return out


def _featured_from_post(post: dict) -> str:
    embedded = post.get("_embedded") or {}
    fm = (embedded.get("wp:featuredmedia") or [{}])
    fm = fm[0] if fm and isinstance(fm[0], dict) else {}
    sizes = ((fm.get("media_details") or {}).get("sizes") or {})
    for key in ("medium_large", "large", "medium"):
        u = (sizes.get(key) or {}).get("source_url")
        if u:
            return str(u)
    return str(fm.get("source_url") or "")


def drafts_from_rest_posts(cfg: SiteConfig, posts: list[dict], platform_hint: str, cat_names: dict[int, str]) -> list[GameDraft]:
    out: list[GameDraft] = []
    for p in posts:
        if not isinstance(p, dict):
            continue
        cats = [cat_names.get(c, "") for c in (p.get("categories") or []) if isinstance(c, int)]
        if platform_hint:
            cats.insert(0, platform_hint)
        d = parse_post(cfg, title=str((p.get("title") or {}).get("rendered") or ""), url=str(p.get("link") or ""),
                       content=str((p.get("content") or {}).get("rendered") or ""), categories=cats,
                       date=str(p.get("date") or ""), featured=_featured_from_post(p))
        if d:
            if not d.cover and isinstance(p.get("featured_media"), int) and p["featured_media"] > 0:
                d.cover = ""      # filled later by fetch_rest when budget allows
                d.slugHint = f"media:{p['featured_media']}"
            out.append(d)
    return out


def fetch_rest(ctx: SourceContext, cfg: SiteConfig) -> list[GameDraft]:
    cats = resolve_categories(ctx, cfg)
    cat_names: dict[int, str] = {}
    for platform, ids in cats.items():
        for cid in ids:
            cat_names[cid] = platform
    plan: list[tuple[str, int | None]] = []
    for platform, ids in cats.items():
        plan.extend((platform, cid) for cid in ids)
    if not plan:
        plan = [("", None)]       # no category match: read everything and classify per post
    drafts: dict[str, GameDraft] = {}
    for platform, cid in plan:
        page = 1
        while page <= cfg.max_pages and len(drafts) < cfg.max_posts:
            if ctx.limit and len(drafts) >= ctx.limit:
                break
            try:
                posts = ctx.get_json(_rest_url(cfg, page, cid), timeout=40)
            except BudgetExceeded:
                ctx.info(f"REST: budget reached at page {page}")
                return list(drafts.values())
            except HttpError as e:
                if e.status == 400:      # rest_post_invalid_page_number: past the last page
                    break
                if page == 1 and not drafts:
                    raise
                ctx.info(f"REST: page {page} failed ({e}); stopping this category")
                break
            if not isinstance(posts, list):
                if page == 1 and not drafts:
                    raise HttpError(cfg.base, 0, "REST posts endpoint did not return a list")
                break
            rows = drafts_from_rest_posts(cfg, posts, platform, cat_names)
            for d in rows:
                drafts.setdefault(d.pageUrl, d)
            if len(posts) < 100 or not rows:
                break
            page += 1
    # Covers for posts whose featured image was not embedded (bounded).
    looked = 0
    for d in drafts.values():
        if d.cover or not d.slugHint.startswith("media:") or looked >= cfg.max_media_lookups:
            d.slugHint = "" if d.slugHint.startswith("media:") else d.slugHint
            continue
        media_id = d.slugHint.split(":", 1)[1]
        d.slugHint = ""
        looked += 1
        try:
            m = ctx.get_json(f"{cfg.base.rstrip('/')}/wp-json/wp/v2/media/{media_id}?_fields=source_url,media_details", timeout=20)
            d.cover = _featured_from_post({"_embedded": {"wp:featuredmedia": [m]}}) if isinstance(m, dict) else ""
        except (HttpError, BudgetExceeded):
            break
    return list(drafts.values())


def sitemap_post_urls(ctx: SourceContext, cfg: SiteConfig) -> list[str]:
    base = cfg.base.rstrip("/")
    candidates = [f"{base}/sitemap_index.xml", f"{base}/sitemap.xml", f"{base}/post-sitemap.xml",
                  f"{base}/wp-sitemap.xml", f"{base}/sitemap-posts.xml"]
    urls: list[str] = []
    seen: set[str] = set()
    queue = list(candidates)
    visited: set[str] = set()
    while queue and len(urls) < cfg.max_posts:
        sm = queue.pop(0)
        if sm in visited:
            continue
        visited.add(sm)
        try:
            body = ctx.get_text(sm, timeout=30)
        except BudgetExceeded:
            break
        except HttpError:
            continue
        locs = [html.unescape(u) for u in _LOC_RE.findall(body)]
        if not locs:
            continue
        for loc in locs:
            if re.search(r"\.xml(?:\.gz)?$", loc, re.I):
                if re.search(r"post|sitemap-\d|wp-sitemap-posts-post", loc, re.I) and loc not in visited and len(visited) < 60:
                    queue.append(loc)
                continue
            if host_of(loc) != cfg.host or _SITEMAP_SKIP_RE.search(loc) or loc in seen:
                continue
            if cfg.skip_url_re and cfg.skip_url_re.search(loc):
                continue
            seen.add(loc)
            urls.append(loc)
        if urls and not queue:
            break
    return urls


def fetch_pages(ctx: SourceContext, cfg: SiteConfig, urls: list[str], platform_hint: str = "") -> list[GameDraft]:
    out: list[GameDraft] = []
    for i, url in enumerate(urls):
        if ctx.limit and len(out) >= ctx.limit:
            break
        try:
            body = ctx.get_text(url, timeout=30, max_bytes=4 * 1024 * 1024)
        except BudgetExceeded:
            ctx.info(f"pages: budget reached after {i} of {len(urls)}")
            break
        except HttpError:
            continue
        d = parse_page(cfg, body, url)
        if d:
            if platform_hint and not parse_title_ids(d.title):
                d.platform = platform_hint if not _PLATFORM_HINT_RE.search(url + " " + d.title) else d.platform
            out.append(d)
    return out


def fetch_sitemap(ctx: SourceContext, cfg: SiteConfig) -> list[GameDraft]:
    urls = sitemap_post_urls(ctx, cfg)
    if not urls:
        raise HttpError(cfg.base, 0, "no sitemap post URLs")
    ctx.info(f"sitemap: {len(urls)} post URLs")
    return fetch_pages(ctx, cfg, urls[: cfg.max_posts])


def fetch_categories(ctx: SourceContext, cfg: SiteConfig) -> list[GameDraft]:
    drafts: dict[str, GameDraft] = {}
    base = cfg.base.rstrip("/")
    for platform, slugs in cfg.platforms.items():
        listing_urls = cfg.category_urls.get(platform) or [f"{base}/category/{slugs[0]}/"] if slugs else []
        for listing in listing_urls:
            empty = 0
            for page in range(1, cfg.max_pages + 1):
                if ctx.limit and len(drafts) >= ctx.limit:
                    break
                url = listing if page == 1 else f"{listing.rstrip('/')}/page/{page}/"
                try:
                    body = ctx.get_text(url, timeout=30, max_bytes=4 * 1024 * 1024)
                except BudgetExceeded:
                    ctx.info(f"{platform}: budget reached at page {page}")
                    return list(drafts.values())
                except HttpError as e:
                    if page == 1 and not drafts:
                        raise
                    ctx.info(f"{platform}: page {page} failed ({e}); stopping")
                    break
                rows = cfg.listing_parser(body, platform) if cfg.listing_parser else parse_listing_cards(cfg, body, platform)
                before = len(drafts)
                for d in rows:
                    drafts.setdefault(d.pageUrl, d)
                if len(drafts) == before:
                    empty += 1
                    if empty >= 1:
                        break
                else:
                    empty = 0
    if cfg.fetch_pages and drafts and ctx.time_left() > 30:
        # Listing cards only know title/cover; the pages hold the links. Fetch as many as the budget allows.
        pages = fetch_pages(ctx, cfg, [d.pageUrl for d in drafts.values()])
        for p in pages:
            old = drafts.get(p.pageUrl)
            if old is not None:
                p.cover = p.cover or old.cover
                p.platform = old.platform if old.platform in ("PS4", "PS5") else p.platform
                drafts[p.pageUrl] = p
    return list(drafts.values())


def fetch_site(ctx: SourceContext, cfg: SiteConfig) -> list[GameDraft]:
    """Run the strategies in order; the first one that yields posts wins. Raises HttpError when none does."""
    errors: list[str] = []
    strategies: list[tuple[str, Callable[[SourceContext, SiteConfig], list[GameDraft]]]] = []
    if cfg.rest:
        strategies.append(("rest", fetch_rest))
    if cfg.sitemap:
        strategies.append(("sitemap", fetch_sitemap))
    strategies.append(("categories", fetch_categories))
    for name, fn in strategies:
        if ctx.time_left() <= 5:
            errors.append(f"{name}: no budget left")
            break
        try:
            drafts = fn(ctx, cfg)
        except BudgetExceeded as e:
            errors.append(f"{name}: {e}")
            break
        except HttpError as e:
            errors.append(f"{name}: {e}")
            continue
        drafts = [d for d in drafts if d and d.releases]
        if drafts:
            ctx.info(f"{name}: {len(drafts)} posts")
            return ctx.truncate(drafts)
        errors.append(f"{name}: no posts")
    raise HttpError(cfg.base, 0, "; ".join(errors) or "no strategy produced posts")


def online_for(cfg: SiteConfig) -> Callable[[SourceContext], list[GameDraft]]:
    def fn(ctx: SourceContext) -> list[GameDraft]:
        return fetch_site(ctx, cfg)
    return fn
