#!/usr/bin/env bash
# Builds the two XENOKING Auto Lister zips from extension/ — same code, different config.js:
#   cdjr      -> INVENTORY_SOURCE "backend"  (Corwin CDJR via the XENOKING backend feed)
#   wholesale -> INVENTORY_SOURCE "vauto"    (Corwin Public Wholesale via the logged-in vAuto grid)
# Usage: ./build-zips.sh [output-dir]   (default: ./dist — must NOT be inside extension/)
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
src="$here/extension"
out="${1:-$here/dist}"
mkdir -p "$out"
out="$(cd "$out" && pwd)"
case "$out/" in "$src/"*) echo "output dir must not be inside extension/ (it would get zipped into the next build)" >&2; exit 1;; esac
ver="$(grep -o '"version": *"[^"]*"' "$src/manifest.json" | sed 's/.*"\([^"]*\)"$/\1/')"
[ -n "$ver" ] || { echo "could not read version from manifest.json" >&2; exit 1; }

# Portable in-place substitution (BSD/macOS sed has no -i without a suffix).
subst() { # <file> <sed-expression>
  local f="$1" expr="$2"
  sed "$expr" "$f" > "$f.tmp" && mv "$f.tmp" "$f"
}

build() { # <name> <inventory-source> <manifest-name-suffix>
  local name="$1" source="$2" label="$3" tmp
  tmp="$(mktemp -d)"
  cp -R "$src/." "$tmp/"
  # Point "Load Vehicles" at the right inventory source, and prove the patch took.
  subst "$tmp/config.js" "s/INVENTORY_SOURCE: \"[a-z]*\"/INVENTORY_SOURCE: \"$source\"/"
  grep -q "INVENTORY_SOURCE: \"$source\"" "$tmp/config.js" || { echo "config.js patch failed for $name" >&2; exit 1; }
  # Distinct extension name so both builds can be installed side by side — and prove that took too.
  if [ -n "$label" ]; then
    subst "$tmp/manifest.json" "s/\"name\": \"XENOKING Auto Lister\"/\"name\": \"XENOKING Auto Lister — $label\"/"
    grep -q "\"name\": \"XENOKING Auto Lister — $label\"" "$tmp/manifest.json" || { echo "manifest name patch failed for $name (manifest reformatted?)" >&2; exit 1; }
  fi
  node -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))' "$tmp/manifest.json" 2>/dev/null || python3 -c 'import json,sys; json.load(open(sys.argv[1]))' "$tmp/manifest.json"
  local zip="$out/xenoking-extension-$name-v$ver.zip"
  rm -f "$zip"
  ( cd "$tmp" && zip -rq "$zip" . -x '*.DS_Store' )
  rm -rf "$tmp"
  echo "built: $zip  (INVENTORY_SOURCE=$source)"
}

build cdjr backend ""
build wholesale vauto "Wholesale"
