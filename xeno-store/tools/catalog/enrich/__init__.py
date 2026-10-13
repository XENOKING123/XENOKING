"""Metadata enrichment for merged games (SPEC §17.1, §17.9).

Each module exposes a factory that returns a callable ``fn(game) -> None`` which
``merge.merge_drafts(..., enrichers=[...])`` runs on every merged game before
ranking. Enrichers never raise for a single game and never touch the network
during an offline build: Steam / PS Store data comes from the committed caches
under ``catalog/snapshots/enrich/``; the seeds come from the zip bundled with
XENO TOOL in this repository.
"""
from __future__ import annotations

from enrich import psstore, seeds, steam

__all__ = ["psstore", "seeds", "steam"]
