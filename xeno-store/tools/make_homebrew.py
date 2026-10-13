#!/usr/bin/env python3
"""
make_homebrew.py — builds the XENO STORE home-screen homebrew folder (SPEC §12).

    dist/XENO-STORE/
      eboot.bin            the browser ELF (serves the store + opens the PS5 browser)
      homebrew.json        etaHEN / itemzflow launcher metadata (title XENO STORE, id XENO00002)
      sce_sys/icon0.png    512x512 XENO logo (home-screen icon)
      sce_sys/param.json   PS5 app metadata (titleId XENO00002)
    dist/XENO-STORE.zip    the same folder zipped; every entry carries mode 0777 so the
                           folder extracts runnable no matter which tool unpacks it on the console.

Usage: python3 tools/make_homebrew.py [--elf PATH] [--out DIR] [--version X.Y.Z] [--quiet]

Defaults: ELF = xeno-store-browser.elf next to the Makefile (falls back to xeno-store.elf
with a warning), out = dist/, version = the VERSION file. The version is stamped into
homebrew.json ("version") and param.json ("contentVersion") so the launcher shows the real
build. Exit code 1 when an input is missing or the ELF is not an ELF.
"""
import argparse
import hashlib
import json
import os
import shutil
import sys
import time
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
APP_DIR_NAME = "XENO-STORE"
ELF_MAGIC = b"\x7fELF"
ZIP_MODE = 0o777


def read_version(root):
    try:
        with open(os.path.join(root, "VERSION"), encoding="utf-8") as fh:
            v = fh.read().strip()
            return v or "0.0.0"
    except OSError:
        return "0.0.0"


def content_version(version):
    """param.json contentVersion is "MM.mm": 1.0.0 -> 01.00, 1.2.0 -> 01.20, 1.0.3 -> 01.03."""
    parts = [p for p in version.split(".") if p.isdigit()]
    major = int(parts[0]) if parts else 1
    minor = int(parts[1]) if len(parts) > 1 else 0
    patch = int(parts[2]) if len(parts) > 2 else 0
    minor2 = min(99, minor * 10 + patch) if minor < 10 else min(99, minor)
    return "%02d.%02d" % (min(99, major), minor2)


def load_json(path):
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def sha256_of(path):
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def add_zip_entry(zf, arcname, data, stamp):
    info = zipfile.ZipInfo(arcname, date_time=stamp)
    info.compress_type = zipfile.ZIP_DEFLATED
    if arcname.endswith("/"):
        info.external_attr = ((0o40000 | ZIP_MODE) << 16) | 0x10   # drwxrwxrwx + MS-DOS directory flag
        info.compress_type = zipfile.ZIP_STORED
        zf.writestr(info, b"")
    else:
        info.external_attr = (0o100000 | ZIP_MODE) << 16           # -rwxrwxrwx regular file
        zf.writestr(info, data)


def main():
    ap = argparse.ArgumentParser(description="build dist/XENO-STORE/ and dist/XENO-STORE.zip")
    ap.add_argument("--elf", default="", help="payload to ship as eboot.bin (default xeno-store-browser.elf)")
    ap.add_argument("--out", default=os.path.join(ROOT, "dist"), help="output directory (default dist/)")
    ap.add_argument("--version", default="", help="override the VERSION file")
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args()

    def say(msg):
        if not args.quiet:
            print(msg)

    version = args.version.strip() or read_version(ROOT)
    elf = args.elf
    if not elf:
        elf = os.path.join(ROOT, "xeno-store-browser.elf")
        if not os.path.isfile(elf):
            fallback = os.path.join(ROOT, "xeno-store.elf")
            if os.path.isfile(fallback):
                print("make_homebrew: xeno-store-browser.elf missing, shipping xeno-store.elf (no auto-open browser)", file=sys.stderr)
                elf = fallback
    if not os.path.isfile(elf):
        print("make_homebrew: ELF not found: %s (run 'make ps5' first)" % elf, file=sys.stderr)
        return 1
    with open(elf, "rb") as fh:
        head = fh.read(4)
    if head != ELF_MAGIC:
        print("make_homebrew: %s is not an ELF file" % elf, file=sys.stderr)
        return 1

    hb_dir = os.path.join(ROOT, "homebrew")
    icon = os.path.join(hb_dir, "sce_sys", "icon0.png")
    param_src = os.path.join(hb_dir, "sce_sys", "param.json")
    meta_src = os.path.join(hb_dir, "homebrew.json")
    for p in (icon, param_src, meta_src):
        if not os.path.isfile(p):
            print("make_homebrew: missing input %s" % p, file=sys.stderr)
            return 1

    try:
        param = load_json(param_src)
        meta = load_json(meta_src)
    except (OSError, ValueError) as e:
        print("make_homebrew: cannot read metadata: %s" % e, file=sys.stderr)
        return 1
    if param.get("titleId") != meta.get("id"):
        print("make_homebrew: titleId mismatch: param.json %r vs homebrew.json %r" % (param.get("titleId"), meta.get("id")), file=sys.stderr)
        return 1
    meta["version"] = version
    meta.setdefault("exec", "eboot.bin")
    meta.setdefault("icon", "sce_sys/icon0.png")
    param["contentVersion"] = content_version(version)
    param.setdefault("pubtoolInfo", {})["creationDate"] = time.strftime("%Y-%m-%d", time.gmtime())

    out_root = os.path.abspath(args.out)
    app_dir = os.path.join(out_root, APP_DIR_NAME)
    if os.path.isdir(app_dir):
        shutil.rmtree(app_dir)
    os.makedirs(os.path.join(app_dir, "sce_sys"), exist_ok=True)

    with open(elf, "rb") as fh:
        elf_bytes = fh.read()
    with open(icon, "rb") as fh:
        icon_bytes = fh.read()
    meta_bytes = (json.dumps(meta, indent=2, ensure_ascii=False) + "\n").encode("utf-8")
    param_bytes = (json.dumps(param, indent=2, ensure_ascii=False) + "\n").encode("utf-8")

    files = [
        ("eboot.bin", elf_bytes),
        ("homebrew.json", meta_bytes),
        ("sce_sys/icon0.png", icon_bytes),
        ("sce_sys/param.json", param_bytes),
    ]
    for rel, data in files:
        dest = os.path.join(app_dir, rel)
        with open(dest, "wb") as fh:
            fh.write(data)
        os.chmod(dest, ZIP_MODE)
    os.chmod(app_dir, ZIP_MODE)
    os.chmod(os.path.join(app_dir, "sce_sys"), ZIP_MODE)

    zip_path = os.path.join(out_root, APP_DIR_NAME + ".zip")
    # Deterministic timestamps: the ELF's mtime (CI builds are reproducible per commit).
    mt = time.gmtime(max(os.path.getmtime(elf), 315532800))
    stamp = (mt.tm_year, mt.tm_mon, mt.tm_mday, mt.tm_hour, mt.tm_min, mt.tm_sec)
    with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
        add_zip_entry(zf, APP_DIR_NAME + "/", b"", stamp)
        add_zip_entry(zf, APP_DIR_NAME + "/sce_sys/", b"", stamp)
        for rel, data in files:
            add_zip_entry(zf, APP_DIR_NAME + "/" + rel, data, stamp)

    say("homebrew folder: %s" % app_dir)
    say("  eboot.bin      %s (%d bytes, sha256 %s)" % (os.path.basename(elf), len(elf_bytes), sha256_of(elf)[:16] + "..."))
    say("  title          %s  id %s  version %s  contentVersion %s" % (meta.get("title"), meta.get("id"), version, param["contentVersion"]))
    say("zip: %s (%d bytes)" % (zip_path, os.path.getsize(zip_path)))
    with zipfile.ZipFile(zip_path) as zf:
        for info in zf.infolist():
            say("  %o  %10d  %s" % ((info.external_attr >> 16) & 0o777, info.file_size, info.filename))
    return 0


if __name__ == "__main__":
    sys.exit(main())
