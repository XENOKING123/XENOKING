"""Shared plumbing for catalog sources: the context a source runs in, the spec
that registers it, and helpers to turn previous-catalog entries back into drafts
(the generic fallback when a site is down and no snapshot exists).
"""
from __future__ import annotations

import json
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

from merge import GameDraft
from netutil import BudgetExceeded, Http, HttpError
from schema import Catalog, Release

__all__ = ["BudgetExceeded", "HttpError", "SourceContext", "SourceSpec", "drafts_from_previous", "read_json_file"]


def read_json_file(path: Path) -> Any:
    with open(path, "r", encoding="utf-8") as fh:
        return json.load(fh)


@dataclass
class SourceContext:
    """Everything a source needs: where snapshots live, the HTTP client, the budget and a logger."""
    root: Path                      # the xeno-store/ project directory
    http: Http
    mode: str = "offline"           # offline | online
    limit: int = 0                  # debug: cap games per source (0 = unlimited)
    deadline: float = field(default_factory=lambda: time.monotonic() + 3600)
    previous: Catalog | None = None
    log: Callable[[str], None] = print
    source_id: str = ""
    extra: dict[str, Any] = field(default_factory=dict)   # CLI extras, e.g. {"orbit_paths": [...]}

    @property
    def snapshots_dir(self) -> Path:
        return self.root / "catalog" / "snapshots"

    def snapshot(self, relative: str) -> Path:
        return self.snapshots_dir / relative

    def time_left(self) -> float:
        return self.deadline - time.monotonic()

    def check_budget(self) -> None:
        if self.time_left() <= 0:
            raise BudgetExceeded(f"{self.source_id}: time budget exhausted")

    def get_text(self, url: str, **kw: Any) -> str:
        return self.http.text(url, deadline=self.deadline, **kw)

    def get_json(self, url: str, **kw: Any) -> Any:
        return self.http.json(url, deadline=self.deadline, **kw)

    def info(self, msg: str) -> None:
        self.log(f"[{self.source_id}] {msg}")

    def truncate(self, drafts: list[GameDraft]) -> list[GameDraft]:
        return drafts[: self.limit] if self.limit > 0 else drafts


@dataclass
class SourceSpec:
    """Registration record for one source module (see sources/__init__.py)."""
    id: str
    name: str
    priority: int                              # higher wins when picking metadata (merge.GameDraft.priority)
    budget: float                              # seconds the online fetch may take
    release_source_ids: tuple[str, ...]        # the release.sourceId values this source emits
    online: Callable[[SourceContext], list[GameDraft]] | None = None
    snapshot: Callable[[SourceContext], list[GameDraft]] | None = None
    description: str = ""

    def has_snapshot(self, ctx: SourceContext) -> bool:
        return self.snapshot is not None


def drafts_from_previous(previous: Catalog | None, source_id: str, release_source_ids: tuple[str, ...],
                         priority: int) -> list[GameDraft]:
    """Rebuild drafts for one source from the previously published catalog.

    Used when a site is unreachable during an online build: its releases from
    the last successful run are carried over, so a flaky site never makes games
    vanish from the store between syncs.
    """
    if previous is None:
        return []
    wanted = set(release_source_ids)
    out: list[GameDraft] = []
    for g in previous.games:
        rels = [Release.from_dict(r.to_dict()) for r in g.releases if r.sourceId in wanted]
        if not rels:
            continue
        out.append(GameDraft(
            source=source_id, title=g.title, platform=g.platform, releases=rels, titleIds=list(g.titleIds),
            region=g.region, genres=list(g.genres), tagline=g.tagline, description=g.description,
            publisher=g.publisher, developer=g.developer, releaseDate=g.releaseDate, addedAt=g.addedAt,
            cover=g.cover, coverFallback=g.coverFallback, hero=g.hero, heroFallback=g.heroFallback,
            artworkLayout=g.artworkLayout, priority=priority, slugHint=g.slug,
        ))
    return out


def page_release(source_id: str, provider: str, page_url: str, *, title_id: str = "", platform: str = "",
                 password: str = "", notes: str = "", prefix: str = "") -> Release:
    """A PAGE release: the URL is a web page listing mirrors; the UI resolves or opens it."""
    from merge import make_release_id
    return Release(
        id=make_release_id(prefix or source_id, title_id, "game", "", page_url), url=page_url,
        sourceId=source_id, provider=provider, format="PAGE", kind="game", titleId=title_id,
        password=password, notes=notes,
    )
