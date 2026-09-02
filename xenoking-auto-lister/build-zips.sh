#!/usr/bin/env bash
# Builds the two XENOKING Auto Lister zips from extension/ — same code, different config.js:
#   cdjr      -> INVENTORY_SOURCE "backend"  (Corwin CDJR via the XENOKING backend feed)
#   wholesale -> INVENTORY_SOURCE "vauto"    (Corwin Public Wholesale via the logged-in vAuto grid)
# Usage: ./build-zips.sh [output-dir]   (default: ./dist)
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
src="$here/extension"
out="${1:-$here/dist}"
ver="$(grep -o '"version": *"[^"]*"' "$src/manifest.json" | sed 's/.*"\([^"]*\)"$/\1/')"
mkdir -p "$out"

build() { # <name> <inventory-source> <manifest-name-suffix>
  local name="$1" source="$2" label="$3" tmp
  tmp="$(mktemp -d)"
  cp -r "$src/." "$tmp/"
  # Point "Load Vehicles" at the right inventory source.
  sed -i "s/INVENTORY_SOURCE: \"[a-z]*\"/INVENTORY_SOURCE: \"$source\"/" "$tmp/config.js"
  grep -q "INVENTORY_SOURCE: \"$source\"" "$tmp/config.js" || { echo "config.js patch failed for $name" >&2; exit 1; }
  # Distinct extension name so both builds can be installed side by side.
  if [ -n "$label" ]; then
    sed -i "s/\"name\": \"XENOKING Auto Lister\"/\"name\": \"XENOKING Auto Lister — $label\"/" "$tmp/manifest.json"
  fi
  local zip="$out/xenoking-extension-$name-v$ver.zip"
  rm -f "$zip"
  ( cd "$tmp" && zip -rq "$zip" . -x '*.DS_Store' )
  rm -rf "$tmp"
  echo "built: $zip  (INVENTORY_SOURCE=$source)"
}

build cdjr backend ""
build wholesale vauto "Wholesale"
