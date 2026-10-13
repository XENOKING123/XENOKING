#!/usr/bin/env python3
"""Regenerates the intake test fixtures deterministically (same bytes every run).

  python3 -I tools/saves/tests/fixtures/make_fixtures.py

Writes: good-save.zip (xeno-save-zip layout), garlic-save.zip (Garlic layout in a
folder), sealed-save.zip (contains a sealed key), raw-backup.zip (same-console
backup), issue-good.md (the body XENO STORE prefills), event-opened.json (the
Actions payload for that issue).
"""
import hashlib
import json
import os
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
STAMP = (2026, 1, 1, 0, 0, 0)
TITLE = "PPSA04029"


def blob(seed: bytes, n: int) -> bytes:
    out = b""
    h = seed
    while len(out) < n:
        h = hashlib.sha256(h).digest()
        out += h
    return out[:n]


def write_zip(path: str, entries, comment: bytes = b"") -> None:
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        for name, data in entries:
            info = zipfile.ZipInfo(name, date_time=STAMP)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            z.writestr(info, data)
        if comment:
            z.comment = comment


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def main() -> None:
    save = blob(b"xeno-save-data", 4096)
    sfo = b"\x00PSF" + blob(b"param-sfo", 124)
    icon = b"\x89PNG\r\n\x1a\n" + blob(b"icon0", 200)
    files = [("SAVEDATA00.bin", save), ("sce_sys/param.sfo", sfo), ("sce_sys/icon0.png", icon)]
    manifest = {
        "titleId": TITLE, "dirName": "SAVEDATA00", "kind": "ps5", "format": "xeno-save-zip",
        "gameVersion": "01.004.000", "region": "EUR", "accountIdStripped": True, "sameConsoleOnly": False,
        "createdBy": "XENO STORE 1.0.0", "createdAt": "2026-01-01T00:00:00Z",
        "files": [{"path": n, "size": len(d), "sha256": sha(d)} for n, d in files],
    }
    good = os.path.join(HERE, "good-save.zip")
    write_zip(good, files + [("xeno-save.json", json.dumps(manifest, indent=1).encode())])
    write_zip(os.path.join(HERE, "garlic-save.zip"), [
        ("PPSA04029_save/data0.bin", blob(b"garlic", 1500)), ("PPSA04029_save/sce_sys/param.sfo", sfo), ("PPSA04029_save/sce_sys/icon0.png", icon)])
    write_zip(os.path.join(HERE, "sealed-save.zip"), [("SAVEDATA00.bin", save), ("sce_sys/param.sfo", sfo), ("sce_sys/sealedkey", blob(b"key", 96))])
    write_zip(os.path.join(HERE, "raw-backup.zip"), [("sdimg_SAVEDATA00", blob(b"img", 2048)), ("sce_sys/keystone", blob(b"ks", 96)), ("xeno-backup.json", b"{}")])
    with open(good, "rb") as f:
        data = f.read()
    block = {
        "titleId": TITLE, "gameId": "cyberpunk-2077-ps5", "title": "Cyberpunk 2077", "category": "chapter",
        "name": "Chapter 4 — all weapons unlocked", "description": "Right after the heist. Every iconic weapon in the stash, 1.2M eddies.",
        "author": "nick", "gameVersion": "01.004.000", "region": "EUR", "dirName": "SAVEDATA00",
        "size": len(data), "sha256": sha(data), "url": "https://pixeldrain.com/api/file/xenoTestGood",
        "format": "xeno-save-zip", "kind": "ps5", "tags": ["ng+", "max money"],
    }
    body = "<!-- Submitted from XENO STORE 1.0.0. Keep the JSON block below unchanged. -->\n\n```json\n" + json.dumps(block, indent=2, ensure_ascii=False) + "\n```\n"
    with open(os.path.join(HERE, "issue-good.md"), "w", encoding="utf-8", newline="\n") as f:
        f.write(body)
    event = {
        "action": "opened",
        "issue": {
            "number": 42, "title": "[save] Cyberpunk 2077 — Chapter 4 — all weapons unlocked", "body": body, "state": "open",
            "labels": [{"name": "save-submission"}], "created_at": "2026-01-02T10:00:00Z", "updated_at": "2026-01-02T10:00:00Z",
            "html_url": "https://github.com/XENOKING123/XENOKING/issues/42", "user": {"login": "someone"},
        },
        "repository": {"full_name": "XENOKING123/XENOKING"},
    }
    with open(os.path.join(HERE, "event-opened.json"), "w", encoding="utf-8", newline="\n") as f:
        json.dump(event, f, indent=2, ensure_ascii=False)
        f.write("\n")
    print("fixtures written to", HERE, "· good-save.zip sha256", sha(data), "size", len(data))


if __name__ == "__main__":
    main()
