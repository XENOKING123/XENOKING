"""Orbit Store public catalogue envelope ({schemaVersion, revision, releases}).

Only the last plaintext feed is available (newer ones are encrypted), so this
source is snapshot-only: ``catalog/snapshots/orbit/catalogue-v2.json``. Entries
use the same shape as BlackBox's ``catalogue-v2.json`` and mostly overlap it;
the merge dedupes them by URL.
"""
from __future__ import annotations

from merge import GameDraft
from sources.base import SourceContext, SourceSpec, read_json_file
from sources.blackbox import build_drafts


def load_snapshot(ctx: SourceContext) -> list[GameDraft]:
    doc = read_json_file(ctx.snapshot("orbit/catalogue-v2.json"))
    return ctx.truncate(build_drafts({"catalog.json": doc}, source_id=SOURCE.id, priority=SOURCE.priority))


SOURCE = SourceSpec(
    id="orbit", name="Orbit catalogue", priority=90, budget=10.0,
    release_source_ids=("archive", "vikingfile"), online=None, snapshot=load_snapshot,
    description="Orbit Store plaintext catalogue envelope (snapshot only)",
)
