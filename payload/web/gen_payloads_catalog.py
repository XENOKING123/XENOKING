#!/usr/bin/env python3
"""Generate payloads-catalog.json from the Rust CATALOGUE const so the
on-console web UI can pull the curated payload list (it can't run the
Rust command). Field strings in the const are single-line, so a
per-field regex is reliable.

Usage: gen_payloads_catalog.py <payloads.rs> <out.json>
"""
import sys
import re
import json


def field_str(block, key):
    m = re.search(rf'\b{key}:\s*"((?:[^"\\]|\\.)*)"', block)
    return m.group(1).encode().decode("unicode_escape") if m else None


def field_opt(block, key):
    m = re.search(rf'\b{key}:\s*Some\("((?:[^"\\]|\\.)*)"\)', block)
    if m:
        return m.group(1).encode().decode("unicode_escape")
    return None


def field_int(block, key):
    m = re.search(rf'\b{key}:\s*(\d+)', block)
    return int(m.group(1)) if m else 0


def field_ports(block):
    m = re.search(r'\bports:\s*&\[([^\]]*)\]', block)
    if not m:
        return []
    return [int(n) for n in re.findall(r'\d+', m.group(1))]


def main():
    if len(sys.argv) != 3:
        sys.stderr.write(__doc__)
        return 2
    src = open(sys.argv[1], encoding="utf-8").read()
    # Take only the CATALOGUE const body.
    cstart = src.find("const CATALOGUE")
    if cstart < 0:
        sys.stderr.write("CATALOGUE const not found\n")
        return 1
    body = src[cstart:]
    # Split into entries on the struct-literal marker.
    chunks = body.split("CatalogueEntry {")[1:]
    out = []
    for ch in chunks:
        pid = field_str(ch, "id")
        if not pid:
            continue
        out.append({
            "id": pid,
            "display_name": field_str(ch, "display_name") or pid,
            "role": field_str(ch, "role") or "",
            "description": field_str(ch, "description") or "",
            "repo_host": field_str(ch, "repo_host") or "github.com",
            "repo_owner": field_str(ch, "repo_owner") or "",
            "repo_name": field_str(ch, "repo_name") or "",
            "asset_name_hint": field_str(ch, "asset_name_hint") or "",
            "on_console_marker_path": field_opt(ch, "on_console_marker_path"),
            "process_name_hint": field_opt(ch, "process_name_hint"),
            "ports": field_ports(ch),
            "autoload_priority": field_int(ch, "autoload_priority"),
            "autoload_delay_ms": field_int(ch, "autoload_delay_ms"),
            "homepage": field_str(ch, "homepage") or "",
        })
    json.dump(out, open(sys.argv[2], "w", encoding="utf-8", newline="\n"),
              indent=2, ensure_ascii=False)
    print(f"wrote {len(out)} payload entries -> {sys.argv[2]}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
