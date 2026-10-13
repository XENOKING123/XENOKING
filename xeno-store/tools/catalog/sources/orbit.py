"""Orbit Store catalogue envelopes (SPEC §17.11): ``{schemaVersion, revision, releases:[...]}``.

Inputs, all merged (newest revision wins when a release id repeats):

* every plaintext ``catalogue*.json`` under ``catalog/snapshots/orbit/`` (the last feed Orbit
  published unencrypted; newer ``.enc`` files are not decrypted by us),
* ``catalog/snapshots/blackbox/catalogue-v2.json`` (BlackBox is built from Orbit, so its
  envelope is Orbit's own release list),
* ``--orbit PATH`` — a user-supplied decrypted catalogue (file, or a directory of
  ``catalogue*.json``), the same input Overdrive's importer accepts,
* online: the plaintext envelope at a few well-known paths of the Orbit repository, when one
  still exists (a non-JSON or encrypted body is ignored and the snapshots are used).

Entries have the BlackBox/Orbit shape, so ``sources.blackbox.build_drafts`` maps them.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from merge import GameDraft
from netutil import HttpError
from sources.base import BudgetExceeded, SourceContext, SourceSpec
from sources.blackbox import build_drafts

ORBIT_RAW_CANDIDATES = (
    "https://raw.githubusercontent.com/saawant12/orbit-store-ps5/main/catalogue-v2.json",
    "https://raw.githubusercontent.com/saawant12/orbit-store-ps5/main/catalog/catalogue-v2.json",
    "https://raw.githubusercontent.com/saawant12/orbit-store-ps5/main/public/catalogue-v2.json",
)


def parse_envelope(doc: Any) -> tuple[int, list[dict]]:
    """(revision, releases) from an envelope, a bare release list or ``{"games": [...]}``; (0, []) otherwise."""
    if isinstance(doc, dict):
        rows = doc.get("releases")
        if not isinstance(rows, list):
            rows = doc.get("games") if isinstance(doc.get("games"), list) else []
        try:
            rev = int(doc.get("revision") or 0)
        except (TypeError, ValueError):
            rev = 0
    elif isinstance(doc, list):
        rows, rev = doc, 0
    else:
        return 0, []
    out = [r for r in rows if isinstance(r, dict) and isinstance(r.get("url"), str) and r.get("url")]
    return rev, out


def read_envelope_file(path: Path) -> tuple[int, list[dict]]:
    """Parse one file; encrypted / non-JSON bodies yield (0, [])."""
    try:
        with open(path, "rb") as fh:
            raw = fh.read()
        if not raw.lstrip().startswith((b"{", b"[")):
            return 0, []
        return parse_envelope(json.loads(raw.decode("utf-8", "replace")))
    except (OSError, ValueError):
        return 0, []


def envelope_files(paths: list[Path]) -> list[Path]:
    """Expand files/directories into the catalogue*.json files they hold, in a stable order."""
    out: list[Path] = []
    for p in paths:
        if p.is_dir():
            out.extend(sorted(p.glob("catalogue*.json")))
        elif p.is_file():
            out.append(p)
    return out


def merge_envelopes(envelopes: list[tuple[int, list[dict]]]) -> list[dict]:
    """Union by release id (then URL); the entry from the highest revision wins."""
    best: dict[str, tuple[int, dict]] = {}
    order: list[str] = []
    for rev, rows in sorted(envelopes, key=lambda e: e[0]):
        for r in rows:
            key = str(r.get("id") or r.get("url"))
            if key not in best:
                order.append(key)
            best[key] = (rev, r)
    return [best[k][1] for k in order]


def collect_snapshot_envelopes(ctx: SourceContext) -> list[tuple[int, list[dict]]]:
    paths = [ctx.snapshot("orbit"), ctx.snapshot("blackbox/catalogue-v2.json")]
    paths += [Path(p) for p in ctx.extra.get("orbit_paths", [])]
    envs: list[tuple[int, list[dict]]] = []
    for f in envelope_files(paths):
        rev, rows = read_envelope_file(f)
        if rows:
            envs.append((rev, rows))
            ctx.info(f"{f.name}: revision {rev}, {len(rows)} releases")
        else:
            ctx.info(f"{f.name}: not a plaintext envelope; skipped")
    return envs


def drafts_from_envelopes(envs: list[tuple[int, list[dict]]], ctx: SourceContext) -> list[GameDraft]:
    rows = merge_envelopes(envs)
    if not rows:
        raise FileNotFoundError("no Orbit catalogue envelope found")
    return ctx.truncate(build_drafts({"catalog.json": {"releases": rows}}, source_id=SOURCE.id, priority=SOURCE.priority))


def load_snapshot(ctx: SourceContext) -> list[GameDraft]:
    return drafts_from_envelopes(collect_snapshot_envelopes(ctx), ctx)


def fetch_online(ctx: SourceContext) -> list[GameDraft]:
    envs = collect_snapshot_envelopes(ctx)
    for url in ORBIT_RAW_CANDIDATES:
        try:
            doc = ctx.get_json(url, timeout=20, retries=0, max_bytes=48 * 1024 * 1024)
        except (HttpError, BudgetExceeded) as e:
            ctx.info(f"no plaintext feed at {url.rsplit('/main/', 1)[-1]} ({e})")
            continue
        rev, rows = parse_envelope(doc)
        if rows:
            ctx.info(f"live envelope: revision {rev}, {len(rows)} releases")
            envs.append((rev, rows))
            break
    return drafts_from_envelopes(envs, ctx)


SOURCE = SourceSpec(
    id="orbit", name="Orbit catalogue", priority=90, budget=30.0,
    release_source_ids=("archive", "vikingfile"), online=fetch_online, snapshot=load_snapshot,
    description="Orbit Store catalogue-v2 envelopes (snapshots, BlackBox's copy, --orbit PATH, live when plaintext)",
)
