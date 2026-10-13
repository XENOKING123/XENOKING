"""Source registry.

Every module in this package exposes a ``SOURCE`` (``SourceSpec``). Adding a
source is: write ``sources/<id>.py`` with ``SOURCE``, import it below, and make
sure the ``release_source_ids`` it emits exist in ``catalog/sources.json``.
Order here is the order sources are listed in reports and run.
"""
from __future__ import annotations

from sources import arabicps4, archive_org, blackbox, dlpsgame, orbit, pkggames, pspkg, superpsx
from sources.base import SourceContext, SourceSpec

_MODULES = (blackbox, orbit, dlpsgame, archive_org, superpsx, pkggames, pspkg, arabicps4)

REGISTRY: dict[str, SourceSpec] = {m.SOURCE.id: m.SOURCE for m in _MODULES}


def get_sources(ids: list[str] | None = None) -> list[SourceSpec]:
    """Registered specs in registry order, optionally filtered; unknown ids raise KeyError."""
    if not ids:
        return list(REGISTRY.values())
    out = []
    for sid in ids:
        if sid not in REGISTRY:
            raise KeyError(f"unknown source {sid!r}; known: {', '.join(REGISTRY)}")
        out.append(REGISTRY[sid])
    return out


__all__ = ["REGISTRY", "SourceContext", "SourceSpec", "get_sources"]
