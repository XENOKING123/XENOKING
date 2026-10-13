#!/usr/bin/env python3
"""
make_ffpkg.py — builds an installable XENO STORE package (SPEC §12, the
"we have one too" .ffpkg/.pkg home-screen app).

It stages a PS5 application folder and hands it to the proven fake-package
builder (ps5upload's `fpkg_build`), which lays out and verifies a debug .pkg
the console can install from a USB drive or a package installer.

    build/apppkg/src/PPSA99500/
        eboot.bin            the browser ELF (serves the store + opens the browser)
        sce_sys/param.json   app metadata (titleId PPSA99500, full application)
        sce_sys/icon0.png    512x512 XENO logo (from homebrew/sce_sys/icon0.png)
    -> fpkg_build  ->  dist/XENO-STORE.pkg   (verified)

Usage:
    python3 tools/make_ffpkg.py [--elf PATH] [--out PATH] [--version X.Y.Z]
                                [--fpkg PATH] [--stage DIR] [--quiet]

The builder binary is found, in order: --fpkg, $XENO_FPKG_BUILD, `fpkg_build`
on PATH, then a few conventional locations. When it cannot be found the script
prints a clear message and exits 3 (so `make ffpkg` can skip gracefully);
exit 1 means a staging/input error, exit 2 means the builder reported a bad
package, exit 0 means a verified .pkg was produced.
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
ELF_MAGIC = b"\x7fELF"

TITLE_ID = "PPSA99500"
CONTENT_ID = "IV0000-PPSA99500_00-XENOSTORE0000000"
TITLE_NAME = "XENO STORE"
EXIT_NO_TOOL = 3


def read_version(root):
    try:
        with open(os.path.join(root, "VERSION"), encoding="utf-8") as fh:
            return fh.read().strip() or "0.0.0"
    except OSError:
        return "0.0.0"


def content_version(version):
    """param.json contentVersion "MM.mm": 1.0.0 -> 01.00, 1.2.0 -> 01.20."""
    parts = [p for p in version.split(".") if p.isdigit()]
    major = int(parts[0]) if parts else 1
    minor = int(parts[1]) if len(parts) > 1 else 0
    patch = int(parts[2]) if len(parts) > 2 else 0
    minor2 = min(99, minor * 10 + patch) if minor < 10 else min(99, minor)
    return "%02d.%02d" % (min(99, major), minor2)


def find_fpkg(explicit):
    """Locate the fpkg_build binary. Returns a path or None."""
    candidates = []
    if explicit:
        candidates.append(explicit)
    env = os.environ.get("XENO_FPKG_BUILD")
    if env:
        candidates.append(env)
    on_path = shutil.which("fpkg_build")
    if on_path:
        candidates.append(on_path)
    # Conventional checkout locations next to the repo.
    rel = os.path.join("ps5upload-up", "engine", "target", "release", "examples", "fpkg_build")
    for base in (ROOT, os.path.dirname(ROOT), os.path.join(ROOT, "tools"), os.path.join(ROOT, "ext")):
        candidates.append(os.path.join(base, rel))
        candidates.append(os.path.join(base, "ps5upload", "engine", "target", "release", "examples", "fpkg_build"))
    for c in candidates:
        if c and os.path.isfile(c) and os.access(c, os.X_OK):
            return c
    return None


def resolve_elf(elf_arg):
    if elf_arg:
        return elf_arg
    browser = os.path.join(ROOT, "xeno-store-browser.elf")
    if os.path.isfile(browser):
        return browser
    server = os.path.join(ROOT, "xeno-store.elf")
    if os.path.isfile(server):
        print("make_ffpkg: xeno-store-browser.elf missing, using xeno-store.elf", file=sys.stderr)
        return server
    return browser


def load_localized(root):
    """Carry the translated title names over from the homebrew param.json."""
    try:
        with open(os.path.join(root, "homebrew", "sce_sys", "param.json"), encoding="utf-8") as fh:
            lp = json.load(fh).get("localizedParameters")
            if isinstance(lp, dict) and lp.get("defaultLanguage"):
                return lp
    except (OSError, ValueError):
        pass
    return {"defaultLanguage": "en-US", "en-US": {"titleName": TITLE_NAME}}


def build_param(version, root):
    """The staged app's param.json — a full, free, DRM-less application."""
    return {
        "applicationCategoryType": 33554432,
        "titleId": TITLE_ID,
        "contentId": CONTENT_ID,
        "contentVersion": content_version(version),
        "masterVersion": "01.00",
        "localizedParameters": load_localized(root),
        "kernelDigest": "ASSET",
        "pubtoolInfo": {"creationDate": time.strftime("%Y-%m-%d", time.gmtime())},
        "applicationDrmType": "free",
        "attribute": 0,
        "downloadDataSize": 0,
        "parentalLevel": 0,
        "sdkVersion": "7.59.0.0",
    }


def main():
    ap = argparse.ArgumentParser(description="build dist/XENO-STORE.pkg from the browser ELF")
    ap.add_argument("--elf", default="", help="payload shipped as eboot.bin (default xeno-store-browser.elf)")
    ap.add_argument("--out", default=os.path.join(ROOT, "dist", "XENO-STORE.pkg"), help="output .pkg path")
    ap.add_argument("--version", default="", help="override the VERSION file")
    ap.add_argument("--fpkg", default="", help="path to the fpkg_build binary")
    ap.add_argument("--stage", default=os.path.join(ROOT, "build", "apppkg"), help="staging directory")
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args()

    def say(msg):
        if not args.quiet:
            print(msg)

    fpkg = find_fpkg(args.fpkg)
    if not fpkg:
        print("make_ffpkg: fpkg_build not found. Set $XENO_FPKG_BUILD or pass --fpkg; build it with\n"
              "  cargo build --release -p ps5upload-fpkg --example fpkg_build\n"
              "in the ps5upload engine checkout. Skipping .pkg build.", file=sys.stderr)
        return EXIT_NO_TOOL

    version = args.version.strip() or read_version(ROOT)
    elf = resolve_elf(args.elf)
    if not os.path.isfile(elf):
        print("make_ffpkg: ELF not found: %s (run 'make ps5' first)" % elf, file=sys.stderr)
        return 1
    with open(elf, "rb") as fh:
        if fh.read(4) != ELF_MAGIC:
            print("make_ffpkg: %s is not an ELF file" % elf, file=sys.stderr)
            return 1

    icon = os.path.join(ROOT, "homebrew", "sce_sys", "icon0.png")
    if not os.path.isfile(icon):
        print("make_ffpkg: missing icon %s" % icon, file=sys.stderr)
        return 1

    # Stage the application folder.
    stage = os.path.abspath(args.stage)
    src_dir = os.path.join(stage, "src", TITLE_ID)
    out_dir = os.path.join(stage, "out")
    if os.path.isdir(src_dir):
        shutil.rmtree(src_dir)
    os.makedirs(os.path.join(src_dir, "sce_sys"), exist_ok=True)
    os.makedirs(out_dir, exist_ok=True)
    # fpkg_build refuses to overwrite; clear any package left by an earlier run.
    for stale in ("XENO-STORE.pkg", "XENO-STORE.pkg.partial"):
        try:
            os.remove(os.path.join(out_dir, stale))
        except OSError:
            pass

    shutil.copyfile(elf, os.path.join(src_dir, "eboot.bin"))
    shutil.copyfile(icon, os.path.join(src_dir, "sce_sys", "icon0.png"))
    param = build_param(version, ROOT)
    with open(os.path.join(src_dir, "sce_sys", "param.json"), "w", encoding="utf-8") as fh:
        json.dump(param, fh, indent=2, ensure_ascii=False)
        fh.write("\n")

    say("make_ffpkg: staged %s" % src_dir)
    say("  eboot.bin  %s (%d bytes)" % (os.path.basename(elf), os.path.getsize(elf)))
    say("  title      %s  id %s  contentVersion %s" % (TITLE_NAME, TITLE_ID, param["contentVersion"]))

    # Build and verify with the Rust tool. It writes <name>.pkg into out_dir.
    cmd = [fpkg, src_dir, out_dir, "--content-id", CONTENT_ID, "--name", "XENO-STORE"]
    say("make_ffpkg: %s" % " ".join(cmd))
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if not args.quiet:
        tail = proc.stdout.strip().splitlines()[-3:] if proc.stdout else []
        for line in tail:
            print("  " + line)
    built = os.path.join(out_dir, "XENO-STORE.pkg")
    if proc.returncode != 0 or not os.path.isfile(built):
        sys.stderr.write(proc.stderr)
        print("make_ffpkg: fpkg_build failed (exit %d)" % proc.returncode, file=sys.stderr)
        return 2

    out = os.path.abspath(args.out)
    os.makedirs(os.path.dirname(out), exist_ok=True)
    shutil.copyfile(built, out)
    say("package: %s (%d bytes, verified)" % (out, os.path.getsize(out)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
