#!/usr/bin/env python3
"""
gen_assets.py — embeds the web bundle, the catalog, the logo, the icon and
every i18n file into src/assets.h as C byte arrays, each with a pre-gzipped
variant (gzip level 9) so the payload can serve compressed responses without
linking zlib.

Missing inputs (other parts of the tree may not be built yet) do not fail the
build: a clearly labelled placeholder is embedded and a warning is printed.

Usage: python3 tools/gen_assets.py [--root DIR] [--out src/assets.h]
"""
import argparse
import gzip
import hashlib
import json
import os
import sys
import time

PLACEHOLDER_HTML = """<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>XENO STORE</title>
<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#060b1c;color:#eaf1ff;font-family:Inter,system-ui,sans-serif}
.box{max-width:560px;padding:32px;border:1px solid #22417e;border-radius:18px;background:#0f1d44}
h1{margin:0 0 12px;color:#ffce4a}code{background:#15265a;padding:2px 6px;border-radius:6px}</style></head>
<body><div class="box"><h1>XENO STORE</h1><p>The web UI was not built when this payload was compiled.</p>
<p>Run <code>make web</code> then <code>make assets</code> and rebuild. The API is live at <code>/api/status</code>.</p></div></body></html>
"""
PLACEHOLDER_CATALOG = json.dumps(
    {"schemaVersion": 1, "revision": 0, "generatedAt": "1970-01-01T00:00:00Z", "name": "XENO STORE Catalog (placeholder)",
     "sources": [], "genres": [], "games": []}, separators=(",", ":")).encode()

# 1x1 transparent PNG / minimal JPEG so /icon.png and /logo.jpg always answer
PLACEHOLDER_PNG = bytes.fromhex(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da6364f8cfc000000301010018dd8db00000000049454e44ae426082")
PLACEHOLDER_JPG = bytes.fromhex(
    "ffd8ffe000104a46494600010100000100010000ffdb004300080606070605080707070909080a0c140d0c0b0b0c1912130f141d1a1f1e1d1a1c1c20242e2720222c231c1c2837292c30313434341f27393d38323c2e333432ffc0000b080001000101011100ffc4001f0000010501010101010100000000000000000102030405060708090a0bffc400b5100002010303020403050504040000017d01020300041105122131410613516107227114328191a1082342b1c11552d1f02433627282090a161718191a25262728292a3435363738393a434445464748494a535455565758595a636465666768696a737475767778797a838485868788898a92939495969798999aa2a3a4a5a6a7a8a9aab2b3b4b5b6b7b8b9bac2c3c4c5c6c7c8c9cad2d3d4d5d6d7d8d9dae1e2e3e4e5e6e7e8e9eaf1f2f3f4f5f6f7f8f9faffda0008010100003f00fbd0ffd9")


def read_or_placeholder(path, placeholder, label, warnings):
    if os.path.isfile(path) and os.path.getsize(path) > 0:
        with open(path, "rb") as f:
            return f.read(), False
    warnings.append(f"{label} missing ({path}) — embedding placeholder")
    return placeholder, True


def c_array(name, data):
    out = [f"static const unsigned char {name}[] = {{\n"]
    line = []
    for i, b in enumerate(data):
        line.append(f"{b:#04x}")
        if len(line) == 24:
            out.append(",".join(line) + ",\n")
            line = []
    if line:
        out.append(",".join(line) + ",\n")
    if not data:
        out.append("0x00\n")
    out.append("};\n")
    return "".join(out)


def c_ident(s):
    return "".join(ch if ch.isalnum() else "_" for ch in s)


def main():
    ap = argparse.ArgumentParser()
    here = os.path.dirname(os.path.abspath(__file__))
    ap.add_argument("--root", default=os.path.dirname(here))
    ap.add_argument("--out", default=None)
    args = ap.parse_args()
    root = os.path.abspath(args.root)
    out = args.out or os.path.join(root, "src", "assets.h")
    warnings = []

    html, ph_ui = read_or_placeholder(os.path.join(root, "web", "dist", "index.html"), PLACEHOLDER_HTML.encode(), "web/dist/index.html", warnings)
    catalog, ph_cat = read_or_placeholder(os.path.join(root, "catalog", "xeno-catalog.json"), PLACEHOLDER_CATALOG, "catalog/xeno-catalog.json", warnings)
    if not ph_cat:
        try:
            doc = json.loads(catalog.decode("utf-8"))
            if not isinstance(doc.get("games"), list):
                raise ValueError("no games array")
        except Exception as e:  # noqa: BLE001
            warnings.append(f"catalog/xeno-catalog.json is invalid ({e}) — embedding placeholder")
            catalog, ph_cat = PLACEHOLDER_CATALOG, True
    logo, _ = read_or_placeholder(os.path.join(root, "web", "src", "logo.jpg"), PLACEHOLDER_JPG, "web/src/logo.jpg", warnings)
    icon, _ = read_or_placeholder(os.path.join(root, "homebrew", "sce_sys", "icon0.png"), PLACEHOLDER_PNG, "homebrew/sce_sys/icon0.png", warnings)

    i18n = []
    i18n_dir = os.path.join(root, "web", "src", "i18n")
    if os.path.isdir(i18n_dir):
        for fn in sorted(os.listdir(i18n_dir)):
            if not fn.endswith(".json"):
                continue
            code = fn[:-5]
            with open(os.path.join(i18n_dir, fn), "rb") as f:
                data = f.read()
            try:
                json.loads(data.decode("utf-8"))
            except Exception as e:  # noqa: BLE001
                warnings.append(f"i18n/{fn} is invalid JSON ({e}) — skipped")
                continue
            i18n.append((code, data))
    if not i18n:
        warnings.append("no i18n files found — embedding a minimal en.json")
        i18n.append(("en", json.dumps({"app.name": "XENO STORE"}).encode()))

    h = hashlib.sha256()
    for blob in [html, catalog, logo, icon] + [d for _, d in i18n]:
        h.update(len(blob).to_bytes(8, "little"))
        h.update(blob)
    build_hash = h.hexdigest()[:16]

    def gz(data):
        return gzip.compress(data, compresslevel=9, mtime=0)

    parts = []
    parts.append("/* GENERATED by tools/gen_assets.py — do not edit, do not commit. */\n")
    parts.append("#ifndef XENO_ASSETS_H\n#define XENO_ASSETS_H\n#include <stddef.h>\n")
    parts.append(f'#define XENO_BUILD_HASH "{build_hash}"\n')
    parts.append(f'#define XENO_ASSETS_GENERATED_AT "{time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}"\n')
    parts.append(f"#define XENO_ASSETS_PLACEHOLDER_UI {1 if ph_ui else 0}\n")
    parts.append(f"#define XENO_ASSETS_PLACEHOLDER_CATALOG {1 if ph_cat else 0}\n")
    parts.append("typedef struct xs_asset { const unsigned char *data; size_t len; const unsigned char *gz; size_t gz_len; } xs_asset;\n")
    parts.append("typedef struct xs_i18n_asset { const char *code; xs_asset a; } xs_i18n_asset;\n")
    parts.append("extern const xs_asset xs_index_html, xs_catalog_json, xs_logo_jpg, xs_icon_png;\n")
    parts.append("extern const xs_i18n_asset xs_i18n[];\nextern const size_t xs_i18n_count;\n")
    parts.append("#ifdef XENO_ASSETS_IMPL\n")

    def emit(name, data, with_gz=True):
        parts.append(c_array(name + "_data", data))
        if with_gz:
            g = gz(data)
            parts.append(c_array(name + "_gz_data", g))
            parts.append(f"const xs_asset {name} = {{ {name}_data, {len(data)}u, {name}_gz_data, {len(g)}u }};\n")
        else:
            parts.append(f"const xs_asset {name} = {{ {name}_data, {len(data)}u, NULL, 0u }};\n")

    emit("xs_index_html", html)
    emit("xs_catalog_json", catalog)
    emit("xs_logo_jpg", logo, with_gz=False)
    emit("xs_icon_png", icon, with_gz=False)
    for code, data in i18n:
        ident = "xs_i18n_" + c_ident(code)
        parts.append(c_array(ident + "_data", data))
        g = gz(data)
        parts.append(c_array(ident + "_gz_data", g))
        parts.append(f"static const xs_asset {ident} = {{ {ident}_data, {len(data)}u, {ident}_gz_data, {len(g)}u }};\n")
    parts.append("const xs_i18n_asset xs_i18n[] = {\n")
    for code, _ in i18n:
        parts.append(f'  {{ "{code}", {{ xs_i18n_{c_ident(code)}_data, xs_i18n_{c_ident(code)}.len, xs_i18n_{c_ident(code)}_gz_data, xs_i18n_{c_ident(code)}.gz_len }} }},\n')
    parts.append("};\n")
    parts.append(f"const size_t xs_i18n_count = {len(i18n)}u;\n")
    parts.append("#endif /* XENO_ASSETS_IMPL */\n#endif /* XENO_ASSETS_H */\n")

    os.makedirs(os.path.dirname(out), exist_ok=True)
    tmp = out + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write("".join(parts))
    os.replace(tmp, out)

    for w in warnings:
        print(f"gen_assets: WARNING: {w}", file=sys.stderr)
    print(f"gen_assets: wrote {out} (build {build_hash}; ui {len(html)} B, catalog {len(catalog)} B, "
          f"logo {len(logo)} B, icon {len(icon)} B, {len(i18n)} locale(s){', PLACEHOLDERS' if warnings else ''})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
