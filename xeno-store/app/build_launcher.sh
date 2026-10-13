#!/usr/bin/env bash
# build_launcher.sh — builds the XENO STORE app-launcher ELF with prospero-clang.
#
#   PS5_PAYLOAD_SDK=/path/to/ps5-payload-sdk app/build_launcher.sh [OUTPUT]
#
# Default OUTPUT is app/dist/xeno-store-launcher.elf. Links only
# SceSystemService + SceUserService (the server-only set): the launcher probes
# the store, streams the saved server ELF to the loader if needed, waits, then
# opens the browser. The top-level `make launcher` target calls this.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
src="$here/launcher_main.c"
out="${1:-$here/dist/xeno-store-launcher.elf}"

if [ -z "${PS5_PAYLOAD_SDK:-}" ]; then
  echo "build_launcher: PS5_PAYLOAD_SDK is not set — export it to the ps5-payload-dev SDK" >&2
  exit 1
fi
cc="$PS5_PAYLOAD_SDK/bin/prospero-clang"
if [ ! -x "$cc" ]; then
  echo "build_launcher: $cc not found" >&2
  exit 1
fi

mkdir -p "$(dirname "$out")"
"$cc" -std=gnu11 -Wall -Wextra -Werror -O2 -o "$out" "$src" \
  -lSceSystemService -lSceUserService
echo "launcher: $out ($(wc -c < "$out") bytes)"
