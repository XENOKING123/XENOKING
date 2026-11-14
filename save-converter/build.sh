#!/usr/bin/env bash
# Build the self-contained converter: compile the engine to WebAssembly and
# inline it (base64) into a single HTML file that runs offline from file://.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
cd "$here/engine"
cargo build --release --target wasm32-unknown-unknown
wasm="target/wasm32-unknown-unknown/release/xeno_save_converter.wasm"
mkdir -p "$here/dist"
base64 -w0 "$wasm" > "$here/dist/.wasm.b64"
python3 - "$here/index.html" "$here/dist/xeno-save-converter.html" "$here/dist/.wasm.b64" <<'PY'
import sys
tpl, out, b64file = sys.argv[1], sys.argv[2], sys.argv[3]
html = open(tpl, encoding="utf-8").read()
b64 = open(b64file).read().strip()
assert "__WASM_B64__" in html, "placeholder missing"
open(out, "w", encoding="utf-8").write(html.replace("__WASM_B64__", b64))
PY
rm -f "$here/dist/.wasm.b64"
size=$(du -h "$here/dist/xeno-save-converter.html" | cut -f1)
echo "built: dist/xeno-save-converter.html ($size)"
