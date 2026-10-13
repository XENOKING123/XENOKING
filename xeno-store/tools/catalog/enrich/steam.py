"""Steam storefront enrichment (SPEC §17.1): screenshots, about, developer/publisher, genres,
Metacritic, release date, features and age rating — cached so offline builds reuse it.

Online flow (``--online`` builds only): ``storesearch`` by normalized title → the first *app* whose
name normalizes exactly like ours → ``appdetails`` → one cache entry. One request every 2.5 s,
a 429 ends the run (the next sync continues where this one stopped), and the whole pass has a
time budget so it can never delay the catalog. Misses are cached too (retried after 30 days).

Cache: ``catalog/snapshots/enrich/steam-cache.json`` =
``{"version": 1, "entries": {"<normalized title>": {...entry...} | {"miss": true, "fetchedAt": ...}}}``.
Keys are normalized titles so the PS4 and PS5 entries of one game share a lookup.
"""
from __future__ import annotations

import html
import json
import re
import time
import urllib.parse
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

from merge import ascii_fold, normalize_genres, normalize_title, strip_marks
from netutil import BudgetExceeded, Http, HttpError
from schema import Game

SEARCH_URL = "https://store.steampowered.com/api/storesearch/"
DETAILS_URL = "https://store.steampowered.com/api/appdetails"
HOST_INTERVAL = 2.5                 # seconds between Steam requests
CACHE_FILE = Path("catalog/snapshots/enrich/steam-cache.json")
MAX_SCREENSHOTS = 8
MAX_ABOUT_CHARS = 500               # the catalog ships inside the ELF; the console fetches the full text live (§17.2)
MISS_TTL_DAYS = 30
ENTRY_TTL_DAYS = 180

# Steam category labels → the feature vocabulary the UI shows (§17.1).
_FEATURE_MAP = {
    "single-player": "Single-player",
    "multi-player": "Online multiplayer", "online pvp": "Online multiplayer", "pvp": "Online multiplayer",
    "mmo": "Online multiplayer", "cross-platform multiplayer": "Cross-platform multiplayer",
    "co-op": "Co-op", "online co-op": "Co-op", "lan co-op": "Co-op",
    "shared/split screen": "Local multiplayer", "shared/split screen co-op": "Local multiplayer",
    "shared/split screen pvp": "Local multiplayer", "local co-op": "Local multiplayer",
    "local multi-player": "Local multiplayer",
    "full controller support": "Controller support", "partial controller support": "Controller support",
    "vr support": "VR", "vr supported": "VR", "vr only": "VR",
}
_TAG_RE = re.compile(r"<[^>]+>")
_WS_RE = re.compile(r"\s+")
_LANG_NOISE_RE = re.compile(r"\*|\(.*?\)|languages with full audio support|<[^>]+>", re.I)


def _now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _age_days(iso: str) -> float:
    try:
        then = datetime.fromisoformat((iso or "").replace("Z", "+00:00"))
    except ValueError:
        return 1e9
    return (datetime.now(timezone.utc) - then).total_seconds() / 86400.0


def html_to_text(fragment: str, limit: int = MAX_ABOUT_CHARS) -> str:
    """Steam's about_the_game HTML → plain text, paragraphs kept, cut at a sentence end near ``limit``."""
    s = re.sub(r"<\s*br\s*/?>", "\n", fragment or "", flags=re.I)
    s = re.sub(r"</\s*(?:p|div|li|h\d)\s*>", "\n\n", s, flags=re.I)
    s = html.unescape(_TAG_RE.sub("", s))
    s = re.sub(r"[ \t]+", " ", s)
    s = re.sub(r"\n{3,}", "\n\n", s).strip()
    if len(s) <= limit:
        return s
    cut = s[:limit]
    end = max(cut.rfind(". "), cut.rfind(".\n"), cut.rfind("! "), cut.rfind("? "))
    if end > limit // 2:
        return cut[: end + 1].strip()
    return cut.rsplit(" ", 1)[0].strip() + "…"


def parse_release_date(text: str) -> str:
    """'Dec 9, 2020' / '9 Dec, 2020' / '2020-12-09' -> '2020-12-09'; '' when unparseable."""
    t = (text or "").strip()
    for fmt in ("%b %d, %Y", "%d %b, %Y", "%Y-%m-%d", "%b %Y", "%B %d, %Y", "%d %B, %Y"):
        try:
            d = datetime.strptime(t, fmt)
            return d.strftime("%Y-%m-%d")
        except ValueError:
            continue
    m = re.search(r"\b(19|20)\d{2}\b", t)
    return f"{m.group(0)}-01-01" if m else ""


def parse_languages(text: str) -> list[str]:
    s = _LANG_NOISE_RE.sub("", html.unescape(text or ""))
    out: list[str] = []
    for part in re.split(r"[,;\n]", s):
        p = _WS_RE.sub(" ", part).strip(" .-")
        if p and p not in out and len(p) <= 40:
            out.append(p)
    return out[:20]


def parse_features(categories: list[dict[str, Any]] | None) -> list[str]:
    out: list[str] = []
    for c in categories or []:
        label = str((c or {}).get("description") or "").strip().lower()
        f = _FEATURE_MAP.get(label)
        if f and f not in out:
            out.append(f)
    return out


def entry_from_appdetails(data: dict[str, Any]) -> dict[str, Any]:
    """A cache entry from one ``appdetails`` payload (the ``data`` object)."""
    shots = []
    for sc in data.get("screenshots") or []:
        u = str((sc or {}).get("path_full") or (sc or {}).get("path_thumbnail") or "").strip()
        if u.startswith(("http://", "https://")) and u not in shots:
            shots.append(u)
        if len(shots) >= MAX_SCREENSHOTS:
            break
    mc = (data.get("metacritic") or {}).get("score")
    try:
        mc = int(mc) if mc is not None else None
    except (TypeError, ValueError):
        mc = None
    try:
        age = int(str(data.get("required_age") or "0").strip() or 0)
    except ValueError:
        age = 0
    try:
        app_id = int(data.get("steam_appid") or 0)
    except (TypeError, ValueError):
        app_id = 0
    return {
        "appId": app_id,
        "name": str(data.get("name") or ""),
        "screenshots": shots,
        "about": html_to_text(str(data.get("about_the_game") or data.get("short_description") or "")),
        "developer": ", ".join(str(d) for d in (data.get("developers") or [])[:2]),
        "publisher": ", ".join(str(p) for p in (data.get("publishers") or [])[:2]),
        "genres": normalize_genres([str((g or {}).get("description") or "") for g in data.get("genres") or []]),
        "metacritic": mc if mc is not None and 0 <= mc <= 100 else None,
        "releaseDate": parse_release_date(str((data.get("release_date") or {}).get("date") or "")),
        "features": parse_features(data.get("categories")),
        "ageRating": age if 0 < age <= 21 else None,
        "languages": parse_languages(str(data.get("supported_languages") or "")),
        "fetchedAt": _now_iso(),
    }


def _exact_key(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", ascii_fold(strip_marks(name)).lower()).strip()


def pick_search_item(items: list[dict[str, Any]], title: str) -> int:
    """Steam app id for ``title``: the app whose name matches exactly (ignoring case/punctuation) wins, else the
    first app whose name *normalizes* like ours (editions stripped), else 0."""
    want_exact, want = _exact_key(title), normalize_title(title)
    if not want:
        return 0
    apps = [it for it in items or [] if isinstance(it, dict) and str(it.get("type") or "app") == "app"]
    for key_fn, want_key in ((_exact_key, want_exact), (normalize_title, want)):
        for it in apps:
            if key_fn(str(it.get("name") or "")) == want_key:
                try:
                    return int(it.get("id") or 0)
                except (TypeError, ValueError):
                    return 0
    return 0


class SteamCache:
    def __init__(self, path: Path):
        self.path = path
        self.entries: dict[str, dict[str, Any]] = {}
        self.dirty = False
        self.load()

    def load(self) -> None:
        if not self.path.exists():
            return
        try:
            with open(self.path, "r", encoding="utf-8") as fh:
                doc = json.load(fh)
            if isinstance(doc, dict) and isinstance(doc.get("entries"), dict):
                self.entries = {str(k): v for k, v in doc["entries"].items() if isinstance(v, dict)}
        except (OSError, ValueError):
            self.entries = {}

    def save(self) -> None:
        if not self.dirty:
            return
        self.path.parent.mkdir(parents=True, exist_ok=True)
        doc = {"version": 1, "updatedAt": _now_iso(), "entries": dict(sorted(self.entries.items()))}
        tmp = self.path.with_suffix(".json.tmp")
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(doc, fh, ensure_ascii=False, indent=1, sort_keys=True)
            fh.write("\n")
        tmp.replace(self.path)
        self.dirty = False

    def get(self, title: str) -> dict[str, Any] | None:
        e = self.entries.get(normalize_title(title))
        return e if e and not e.get("miss") else None

    def needs_lookup(self, title: str) -> bool:
        key = normalize_title(title)
        if not key:
            return False
        e = self.entries.get(key)
        if e is None:
            return True
        ttl = MISS_TTL_DAYS if e.get("miss") else ENTRY_TTL_DAYS
        return _age_days(str(e.get("fetchedAt") or "")) > ttl

    def put(self, title: str, entry: dict[str, Any] | None) -> None:
        key = normalize_title(title)
        if not key:
            return
        self.entries[key] = entry if entry else {"miss": True, "fetchedAt": _now_iso()}
        self.dirty = True


def apply_entry(game: Game, e: dict[str, Any]) -> None:
    """Merge a cache entry under the catalog data (sources win; Steam fills the gaps, Metacritic always applies)."""
    if not game.screenshots:
        game.screenshots = [u for u in e.get("screenshots") or [] if isinstance(u, str)][:MAX_SCREENSHOTS]
    if not game.about:
        game.about = str(e.get("about") or "")
    if not game.developer:
        game.developer = str(e.get("developer") or "")
    if not game.publisher:
        game.publisher = str(e.get("publisher") or "")
    if not game.genres:
        game.genres = [str(g) for g in e.get("genres") or []]
    if game.metacritic is None and isinstance(e.get("metacritic"), int):
        game.metacritic = int(e["metacritic"])
    if not game.releaseDate:
        game.releaseDate = str(e.get("releaseDate") or "")
    if not game.features:
        game.features = [str(f) for f in e.get("features") or []]
    if game.ageRating is None and isinstance(e.get("ageRating"), int):
        game.ageRating = int(e["ageRating"])
    if not game.languages:
        game.languages = [str(l) for l in e.get("languages") or []]
    if not game.steamId:
        try:
            game.steamId = int(e.get("appId") or 0)
        except (TypeError, ValueError):
            game.steamId = 0


def enricher(cache: SteamCache) -> Callable[[Game], None]:
    def fn(game: Game) -> None:
        if game.platform not in ("PS4", "PS5"):
            return
        e = cache.get(game.title)
        if e:
            apply_entry(game, e)
    return fn


class SteamClient:
    """The two storefront calls, through the shared polite HTTP client."""

    def __init__(self, http: Http, deadline: float | None = None):
        self.http = http
        self.deadline = deadline
        http.host_intervals.setdefault("store.steampowered.com", HOST_INTERVAL)

    def search(self, title: str) -> list[dict[str, Any]]:
        q = urllib.parse.urlencode({"term": title, "l": "english", "cc": "US"})
        doc = self.http.json(f"{SEARCH_URL}?{q}", timeout=20, retries=1, deadline=self.deadline)
        return list((doc or {}).get("items") or []) if isinstance(doc, dict) else []

    def details(self, app_id: int) -> dict[str, Any] | None:
        q = urllib.parse.urlencode({"appids": str(app_id), "l": "english", "cc": "US"})
        doc = self.http.json(f"{DETAILS_URL}?{q}", timeout=20, retries=1, deadline=self.deadline)
        node = (doc or {}).get(str(app_id)) if isinstance(doc, dict) else None
        if not isinstance(node, dict) or not node.get("success") or not isinstance(node.get("data"), dict):
            return None
        return node["data"]

    def lookup(self, title: str) -> dict[str, Any] | None:
        app_id = pick_search_item(self.search(title), title)
        if not app_id:
            return None
        data = self.details(app_id)
        if data is None:
            return None
        return entry_from_appdetails(data)


def run(client: SteamClient, cache: SteamCache, titles: list[str], budget_seconds: float,
        log: Callable[[str], None] = print) -> dict[str, int]:
    """Look up every title that needs it, most important first, until the budget is spent. Never raises."""
    stats = {"looked": 0, "hits": 0, "misses": 0, "errors": 0, "skipped": 0, "stoppedBy": 0}
    started = time.monotonic()
    deadline = started + max(0.0, budget_seconds)
    client.deadline = deadline
    seen: set[str] = set()
    try:
        for title in titles:
            key = normalize_title(title)
            if not key or key in seen:
                continue
            seen.add(key)
            if not cache.needs_lookup(title):
                stats["skipped"] += 1
                continue
            if time.monotonic() >= deadline:
                break
            try:
                entry = client.lookup(title)
            except BudgetExceeded:
                break
            except HttpError as e:
                stats["errors"] += 1
                if e.status == 429 or e.status == 403:
                    log(f"[steam] {e}; stopping this run")
                    stats["stoppedBy"] = e.status
                    break
                if stats["errors"] >= 10:
                    log("[steam] too many errors; stopping this run")
                    break
                continue
            except (ValueError, TypeError, KeyError) as e:   # unexpected payload shape must not kill the build
                stats["errors"] += 1
                log(f"[steam] bad payload for {title!r}: {e}")
                continue
            stats["looked"] += 1
            if entry:
                stats["hits"] += 1
            else:
                stats["misses"] += 1
            cache.put(title, entry)
            if stats["looked"] % 20 == 0:
                cache.save()
    finally:
        cache.save()
    log(f"[steam] {stats['looked']} lookups ({stats['hits']} hits, {stats['misses']} misses, "
        f"{stats['errors']} errors) in {time.monotonic() - started:.0f}s; cache has {len(cache.entries)} entries")
    return stats
