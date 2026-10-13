#!/usr/bin/env python3
"""XENO STORE · Save Data Store · GitHub intake (SPEC §17.22.5).

Turns a `save-submission` issue into a row of `updates/saves.json`, the
zero-infrastructure community index every console reads:

  issue body  ──►  JSON block  ──►  field validation  ──►  download (size cap)
            ──►  sha256 check  ──►  zip inspection    ──►  index upsert

Status is driven by labels: `approved` → published, `rejected` → rejected,
otherwise pending. Consoles show `published` rows only. A submission that
fails any check is never published, whatever the labels say.

Stdlib only (Python 3.10+). Usage:

  intake.py --event "$GITHUB_EVENT_PATH" --index updates/saves.json --out result.json
  intake.py --issue-json issue.json ...            # `gh issue view N --json number,title,body,labels,createdAt,url`
  intake.py --body body.md --number 12 --labels approved --file save.zip --dry-run
  intake.py --validate-index updates/saves.json

Exit code 0 when the intake ran (the result JSON says whether the submission
was accepted), 1 on a tool error (unreadable index, bad arguments),
2 with --strict when the submission was rejected.
"""
from __future__ import annotations

import argparse
import hashlib
import io
import ipaddress
import json
import os
import re
import stat
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from datetime import datetime, timezone

SCHEMA_VERSION = 1
MAX_BYTES = 2 * 1024 * 1024 * 1024          # 2 GiB — same cap as the Supabase backend
MAX_ZIP_ENTRIES = 20000
MAX_ZIP_UNCOMPRESSED = 8 * 1024 * 1024 * 1024
MAX_MANIFEST = 256 * 1024
CHUNK = 1024 * 1024
CATEGORIES = ("starter", "platinum", "checkpoint", "modded", "chapter", "other")
TITLE_RE = re.compile(r"^PPSA\d{5}$")
VERSION_RE = re.compile(r"^[0-9]{1,3}(\.[0-9]{1,3}){0,3}$")
REGION_RE = re.compile(r"^[A-Z0-9_-]{1,8}$")
DIRNAME_RE = re.compile(r"^[A-Za-z0-9_.-]{1,32}$")
SHA_RE = re.compile(r"^[0-9a-f]{64}$")
TAG_RE = re.compile(r"^[a-z0-9][a-z0-9 +._-]{0,23}$")
GAMEID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,120}$")
SEALED_RE = re.compile(r"(^|/)(sealedkey|sealedkey\.bin|keystone|keystone\.bin|[^/]+\.sealedkey)$", re.I)
RAW_IMAGE_RE = re.compile(r"(^|/)sdimg_[^/]*$", re.I)
MANIFEST = "xeno-save.json"
FENCE_RE = re.compile(r"```(?:json|JSON)?[ \t]*\r?\n(.*?)\r?\n[ \t]*```", re.S)
CONTROL_RE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
USER_AGENT = "XENO-STORE-saves-intake/1.0 (+https://github.com/XENOKING123/XENOKING)"
ISSUE_BASE = "https://github.com/XENOKING123/XENOKING/issues/"


class IntakeError(Exception):
    """A problem with the tool's own inputs (not with the submission)."""


# ----------------------------------------------------------------------------
# helpers

def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def clean_text(v, max_len: int) -> str:
    if not isinstance(v, str):
        v = "" if v is None else str(v)
    v = CONTROL_RE.sub("", v)
    v = re.sub(r"[ \t]+", " ", v).strip()
    return v[:max_len].strip()


def infer_category(text: str) -> str:
    """Same keyword rules as the console (cx_savestore.c) so chips match everywhere."""
    t = (text or "").lower()
    if "100%" in t or "platinum" in t:
        return "platinum"
    if "start" in t or "ng+" in t or "max" in t:
        return "starter"
    if "trophy" in t or "boss" in t:
        return "checkpoint"
    if "mod" in t or "glitch" in t:
        return "modded"
    if "chapter" in t:
        return "chapter"
    return "other"


def entry_id(sha256: str, issue: int) -> str:
    """Deterministic id: the file hash when known, else the issue number."""
    if sha256:
        return "sv_" + sha256[:12]
    return "sv_issue%d" % issue


# ----------------------------------------------------------------------------
# 1. issue body → submission dict

def parse_issue_body(body: str) -> dict:
    """Return the first fenced JSON block of an issue body as a dict."""
    if not isinstance(body, str) or not body.strip():
        raise ValueError("the issue body is empty — it must contain the JSON block XENO STORE prefilled")
    body = body.replace("\r\n", "\n")
    candidates = [m.group(1) for m in FENCE_RE.finditer(body)]
    if not candidates:
        # tolerate a bare JSON object (someone pasted it without the fence)
        start, end = body.find("{"), body.rfind("}")
        if start >= 0 and end > start:
            candidates = [body[start:end + 1]]
    for text in candidates:
        text = text.strip()
        if not text or text.startswith("//"):
            continue
        try:
            data = json.loads(text)
        except ValueError:
            continue
        if isinstance(data, dict) and data:
            return data
    raise ValueError("no valid JSON block found in the issue body — keep the ```json block the console prefilled unchanged")


def normalize_submission(raw: dict) -> tuple[dict, list[str], list[str]]:
    """Validate the fields of a submission. Returns (submission, errors, warnings)."""
    errors: list[str] = []
    warnings: list[str] = []
    if not isinstance(raw, dict):
        return {}, ["the JSON block must be an object"], warnings
    sub: dict = {}

    tid = clean_text(raw.get("titleId") or raw.get("title_id"), 16).upper()
    if not TITLE_RE.search(tid):
        errors.append("titleId must be a PS5 id like PPSA12345 (PS4 CUSA saves are not accepted)")
    sub["titleId"] = tid

    gid = clean_text(raw.get("gameId"), 121).lower()
    if gid and not GAMEID_RE.search(gid):
        warnings.append("gameId ignored (not a catalog slug)")
        gid = ""
    sub["gameId"] = gid

    title = clean_text(raw.get("title") or raw.get("game"), 120)
    if not title:
        errors.append("title is required (the game name, 1–120 characters)")
    sub["title"] = title

    name = clean_text(raw.get("name"), 80)
    if not name:
        errors.append("name is required (what the save is, 1–80 characters)")
    sub["name"] = name

    desc_raw = raw.get("description") if isinstance(raw.get("description"), str) else raw.get("notes") if isinstance(raw.get("notes"), str) else ""
    desc = clean_text(desc_raw, 2000)
    if len(desc) > 300:
        errors.append("description must be 300 characters or less (it has %d)" % len(desc))
    sub["description"] = desc[:300]

    author = clean_text(raw.get("author") or raw.get("nickname") or raw.get("shared_by"), 80).lstrip("@").strip()
    if not author:
        errors.append("author (your nickname) is required, 1–60 characters")
    elif len(author) > 60:
        errors.append("author must be 60 characters or less")
    if re.search(r"https?://|www\.", author, re.I):
        errors.append("author must be a nickname, not a link")
    sub["author"] = author[:60]

    cat = clean_text(raw.get("category"), 24).lower()
    if cat and cat not in CATEGORIES:
        warnings.append("category '%s' is not one of %s — inferred from the text instead" % (cat, ", ".join(CATEGORIES)))
        cat = ""
    sub["category"] = cat or infer_category(name + " " + desc)

    ver = clean_text(raw.get("gameVersion") or raw.get("game_version"), 24)
    if ver and not VERSION_RE.search(ver):
        errors.append("gameVersion must look like 01.004.000 (or be empty)")
    sub["gameVersion"] = ver

    region = clean_text(raw.get("region"), 12).upper()
    if region and not REGION_RE.search(region):
        errors.append("region must be letters/digits only (EUR, USA, JPN, ASIA, …) or empty")
    sub["region"] = region

    dirname = clean_text(raw.get("dirName") or raw.get("dir_name"), 40)
    if dirname and not DIRNAME_RE.search(dirname):
        errors.append("dirName must be a save directory name like SAVEDATA00")
    elif not dirname:
        warnings.append("dirName is empty — the manifest inside the zip will be used")
    sub["dirName"] = dirname

    size_raw = raw.get("size", raw.get("file_size"))
    size = 0
    if isinstance(size_raw, bool) or size_raw is None:
        errors.append("size (bytes) is required")
    else:
        try:
            size = int(size_raw)
        except (TypeError, ValueError):
            errors.append("size must be an integer number of bytes")
        else:
            if size <= 0:
                errors.append("size must be a positive number of bytes")
            elif size > MAX_BYTES:
                errors.append("size must be 2 GiB or less")
    sub["size"] = size

    sha = clean_text(raw.get("sha256"), 80).lower()
    if not SHA_RE.search(sha):
        errors.append("sha256 must be the 64-hex-character hash of the zip")
    sub["sha256"] = sha

    url = clean_text(raw.get("url"), 1024)
    url_err = check_url(url)
    if url_err:
        errors.append(url_err)
    sub["url"] = url

    mirror = clean_text(raw.get("mirror"), 1024)
    if mirror and check_url(mirror):
        warnings.append("mirror ignored (%s)" % check_url(mirror))
        mirror = ""
    sub["mirror"] = mirror

    fmt = clean_text(raw.get("format"), 32) or "xeno-save-zip"
    if fmt != "xeno-save-zip":
        errors.append("format must be xeno-save-zip (raw same-console backups cannot be shared)")
    sub["format"] = "xeno-save-zip"
    kind = clean_text(raw.get("kind"), 8).lower() or "ps5"
    if kind != "ps5":
        errors.append("kind must be ps5")
    sub["kind"] = "ps5"

    tags_in = raw.get("tags")
    tags: list[str] = []
    if isinstance(tags_in, str):
        tags_in = [t for t in re.split(r"[,\n]", tags_in)]
    if isinstance(tags_in, list):
        for t in tags_in:
            t = clean_text(t, 64).lower()
            if t and TAG_RE.search(t) and t not in tags:   # over-long or odd tags are dropped, never truncated
                tags.append(t)
            if len(tags) >= 10:
                break
    sub["tags"] = tags

    screenshot = clean_text(raw.get("screenshot"), 1024)
    if screenshot and check_url(screenshot):
        screenshot = ""
    sub["screenshot"] = screenshot
    return sub, errors, warnings


def check_url(url: str) -> str:
    """Return '' when the URL is an acceptable public https download link, else the reason."""
    if not url:
        return "url is required (the uploaded zip link)"
    try:
        p = urllib.parse.urlsplit(url)
    except ValueError:
        return "url is not a valid URL"
    if p.scheme != "https":
        return "url must start with https://"
    if not p.hostname or p.username or p.password:
        return "url must be a plain https link without credentials"
    host = p.hostname.lower()
    if host in ("localhost",) or host.endswith(".local") or host.endswith(".internal"):
        return "url must point to a public host"
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        ip = None
    if ip is not None and (ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved or ip.is_multicast or ip.is_unspecified):
        return "url must point to a public host"
    if any(c in url for c in " <>\"'\\"):
        return "url contains characters that are not allowed"
    return ""


# ----------------------------------------------------------------------------
# 2. download with a size cap + sha256

def download(url: str, dest: str, expected_size: int, max_bytes: int = MAX_BYTES, timeout: float = 60.0, opener=None) -> tuple[int, str]:
    """Stream `url` into `dest` (≤ max_bytes and ≤ expected_size), return (size, sha256)."""
    cap = min(max_bytes, expected_size) if expected_size > 0 else max_bytes
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "*/*"})
    open_fn = opener or urllib.request.urlopen
    h = hashlib.sha256()
    got = 0
    try:
        with open_fn(req, timeout=timeout) as resp:
            final = str(resp.geturl() if hasattr(resp, "geturl") else url)
            if url.lower().startswith("https://") and not final.lower().startswith("https://"):
                raise ValueError("the link redirected to a non-https address")
            length = resp.headers.get("Content-Length") if hasattr(resp, "headers") else None
            if length is not None:
                try:
                    declared = int(length)
                except ValueError:
                    declared = -1
                if declared > cap:
                    raise ValueError("the file is %d bytes but the submission says %d" % (declared, expected_size) if expected_size else "the file is larger than the %d byte limit" % cap)
            ctype = (resp.headers.get("Content-Type") or "").lower() if hasattr(resp, "headers") else ""
            with open(dest, "wb") as out:
                first = b""
                while True:
                    chunk = resp.read(CHUNK)
                    if not chunk:
                        break
                    if not first:
                        first = chunk[:4]
                        if "text/html" in ctype and not first.startswith(b"PK"):
                            raise ValueError("the link returned a web page instead of the zip (expired or needs a browser)")
                    got += len(chunk)
                    if got > cap:
                        raise ValueError("the download is larger than the submitted size (%d bytes)" % expected_size if expected_size else "the download exceeded the %d byte limit" % cap)
                    h.update(chunk)
                    out.write(chunk)
    except urllib.error.HTTPError as e:
        raise ValueError("the link answered HTTP %d" % e.code) from None
    except urllib.error.URLError as e:
        raise ValueError("the link could not be fetched (%s)" % getattr(e, "reason", e)) from None
    except (TimeoutError, OSError) as e:
        if isinstance(e, ValueError):
            raise
        raise ValueError("the download failed (%s)" % e) from None
    if got == 0:
        raise ValueError("the link returned an empty file")
    return got, h.hexdigest()


def sha256_file(path: str) -> tuple[int, str]:
    h = hashlib.sha256()
    n = 0
    with open(path, "rb") as f:
        while True:
            chunk = f.read(CHUNK)
            if not chunk:
                break
            n += len(chunk)
            h.update(chunk)
    return n, h.hexdigest()


# ----------------------------------------------------------------------------
# 3. zip inspection

def inspect_zip(path: str, expected_title: str = "") -> dict:
    """Check that the zip is a shareable decrypted PS5 save.

    Returns {ok, layout: xeno|garlic|none, reasons, dataFiles, hasManifest,
             hasParamSfo, hasIcon, dirName, gameVersion, region, manifest}.
    """
    res = {"ok": False, "layout": "none", "reasons": [], "dataFiles": 0, "hasManifest": False, "hasParamSfo": False,
           "hasIcon": False, "dirName": "", "gameVersion": "", "region": "", "manifest": None, "entries": 0}
    reasons: list[str] = []
    try:
        zf = zipfile.ZipFile(path)
    except (zipfile.BadZipFile, OSError) as e:
        res["reasons"] = ["the file is not a zip (%s)" % e]
        return res
    with zf:
        infos = zf.infolist()
        res["entries"] = len(infos)
        if not infos:
            reasons.append("the zip is empty")
        if len(infos) > MAX_ZIP_ENTRIES:
            reasons.append("the zip has more than %d entries" % MAX_ZIP_ENTRIES)
            infos = infos[:MAX_ZIP_ENTRIES]
        names = [i.filename for i in infos]
        tops = {n.split("/")[0] for n in names}
        prefix = ""
        if len(tops) == 1 and all("/" in n for n in names):
            top = next(iter(tops))
            if top.lower() != "sce_sys":
                prefix = top + "/"
        total = 0
        data_files = 0
        manifest_info = None
        for info in infos:
            n = info.filename
            if n.startswith("/") or n.startswith("\\") or re.match(r"^[A-Za-z]:[\\/]", n):
                reasons.append("absolute path inside the zip: %s" % n)
            if ".." in re.split(r"[\\/]", n):
                reasons.append("parent-directory path inside the zip: %s" % n)
            if SEALED_RE.search(n):
                reasons.append("sealed key inside the zip: %s" % n)
            if RAW_IMAGE_RE.search(n):
                reasons.append("raw (sealed) save image inside the zip: %s" % n)
            mode = (info.external_attr >> 16) & 0xFFFF
            if mode and stat.S_ISLNK(mode):
                reasons.append("symbolic link inside the zip: %s" % n)
            if info.is_dir():
                continue
            total += max(0, info.file_size)
            rel = n[len(prefix):] if prefix and n.startswith(prefix) else n
            low = rel.lower()
            if rel == MANIFEST:
                res["hasManifest"] = True
                manifest_info = info
                continue
            if rel == "xeno-backup.json":
                reasons.append("this is a raw console backup (xeno-backup.json), not a shareable save")
                continue
            if low == "sce_sys/param.sfo":
                res["hasParamSfo"] = True
                continue
            if low == "sce_sys/icon0.png":
                res["hasIcon"] = True
                continue
            if low.startswith("sce_sys/"):
                continue
            data_files += 1
        if total > MAX_ZIP_UNCOMPRESSED:
            reasons.append("the zip expands to more than 8 GiB")
        res["dataFiles"] = data_files
        if not data_files:
            reasons.append("no save files found at the zip root (expected the decrypted save files, optionally with sce_sys/)")
        if manifest_info is not None:
            if manifest_info.file_size > MAX_MANIFEST:
                reasons.append("xeno-save.json is too large")
            else:
                try:
                    man = json.loads(zf.read(manifest_info).decode("utf-8"))
                except (ValueError, UnicodeDecodeError, zipfile.BadZipFile, RuntimeError) as e:
                    man = None
                    reasons.append("xeno-save.json is not valid JSON (%s)" % e)
                if isinstance(man, dict):
                    res["manifest"] = {k: man.get(k) for k in ("titleId", "dirName", "kind", "format", "gameVersion", "region", "accountIdStripped", "sameConsoleOnly", "createdBy", "createdAt")}
                    mt = clean_text(man.get("titleId"), 16).upper()
                    if expected_title and mt and mt != expected_title:
                        reasons.append("the manifest says the save is for %s, not %s" % (mt, expected_title))
                    if man.get("format") not in (None, "", "xeno-save-zip"):
                        reasons.append("the manifest format is %s — only xeno-save-zip can be shared" % man.get("format"))
                    if man.get("sameConsoleOnly") is True:
                        reasons.append("the manifest marks this save as same-console only (raw export); share a decrypted export instead")
                    if man.get("accountIdStripped") is False:
                        reasons.append("the manifest says the account id was not stripped")
                    dn = clean_text(man.get("dirName"), 40)
                    res["dirName"] = dn if DIRNAME_RE.search(dn) else ""
                    gv = clean_text(man.get("gameVersion"), 24)
                    res["gameVersion"] = gv if VERSION_RE.search(gv) else ""
                    rg = clean_text(man.get("region"), 12).upper()
                    res["region"] = rg if REGION_RE.search(rg) else ""
                    files = man.get("files")
                    if isinstance(files, list):
                        present = {(n[len(prefix):] if prefix and n.startswith(prefix) else n): i for n, i in ((i.filename, i) for i in infos)}
                        for f in files[:MAX_ZIP_ENTRIES]:
                            if not isinstance(f, dict):
                                continue
                            fp = f.get("path")
                            if not isinstance(fp, str) or fp not in present:
                                reasons.append("the manifest lists %s but it is not in the zip" % fp)
                            elif isinstance(f.get("size"), int) and f["size"] != present[fp].file_size:
                                reasons.append("the manifest size of %s does not match the zip" % fp)
                elif man is not None:
                    reasons.append("xeno-save.json must be a JSON object")
    seen: list[str] = []
    for r in reasons:
        if r not in seen:
            seen.append(r)
    res["reasons"] = seen
    res["layout"] = "xeno" if res["hasManifest"] else ("garlic" if data_files else "none")
    res["ok"] = not seen
    return res


# ----------------------------------------------------------------------------
# 4. the index

def empty_index(now: str) -> dict:
    return {"schemaVersion": SCHEMA_VERSION, "updatedAt": now, "saves": []}


def load_index(path: str, now: str) -> dict:
    if not os.path.exists(path):
        return empty_index(now)
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError) as e:
        raise IntakeError("cannot read the index %s: %s" % (path, e))
    errs = validate_index(data)
    if errs:
        raise IntakeError("the index %s is invalid: %s" % (path, "; ".join(errs[:5])))
    return data


def validate_index(data) -> list[str]:
    errs: list[str] = []
    if not isinstance(data, dict):
        return ["the index must be a JSON object"]
    if data.get("schemaVersion") != SCHEMA_VERSION:
        errs.append("schemaVersion must be %d" % SCHEMA_VERSION)
    if not isinstance(data.get("updatedAt"), str):
        errs.append("updatedAt must be an ISO timestamp string")
    saves = data.get("saves")
    if not isinstance(saves, list):
        return errs + ["saves must be an array"]
    ids: set[str] = set()
    for i, s in enumerate(saves):
        where = "saves[%d]" % i
        if not isinstance(s, dict):
            errs.append("%s must be an object" % where)
            continue
        sid = s.get("id")
        if not isinstance(sid, str) or not sid:
            errs.append("%s.id missing" % where)
        elif sid in ids:
            errs.append("%s.id %s is duplicated" % (where, sid))
        else:
            ids.add(sid)
        status = s.get("status")
        if status not in ("published", "pending", "rejected", "example"):
            errs.append("%s.status must be published, pending, rejected or example" % where)
        tid = s.get("titleId")
        if not isinstance(tid, str) or not TITLE_RE.search(tid):
            errs.append("%s.titleId must be a PPSA id" % where)
        if status == "published":
            if not isinstance(s.get("url"), str) or not s["url"].startswith("https://"):
                errs.append("%s.url must be https for a published save" % where)
            if not isinstance(s.get("sha256"), str) or not SHA_RE.search(s["sha256"]):
                errs.append("%s.sha256 must be 64 hex for a published save" % where)
            if not isinstance(s.get("size"), int) or s["size"] <= 0:
                errs.append("%s.size must be a positive integer for a published save" % where)
        for key in ("title", "name", "author", "category"):
            if key in s and not isinstance(s[key], str):
                errs.append("%s.%s must be a string" % (where, key))
        if "category" in s and s["category"] not in CATEGORIES:
            errs.append("%s.category must be one of %s" % (where, ", ".join(CATEGORIES)))
        if "tags" in s and not (isinstance(s["tags"], list) and all(isinstance(t, str) for t in s["tags"])):
            errs.append("%s.tags must be an array of strings" % where)
    return errs


def build_entry(sub: dict, issue: int, issue_url: str, created_at: str, status: str, look: dict | None, previous: dict | None, reasons: list[str]) -> dict:
    """Canonical key order; `previous` keeps createdAt/downloads stable across edits."""
    prev = previous or {}
    dirname = sub.get("dirName") or (look or {}).get("dirName") or prev.get("dirName", "")
    version = sub.get("gameVersion") or (look or {}).get("gameVersion") or prev.get("gameVersion", "")
    region = sub.get("region") or (look or {}).get("region") or prev.get("region", "")
    sha = sub.get("sha256", "")
    entry = {
        "id": entry_id(sha, issue),
        "issue": issue,
        "issueUrl": issue_url or (ISSUE_BASE + str(issue)),
        "titleId": sub.get("titleId", ""),
        "gameId": sub.get("gameId", ""),
        "title": sub.get("title", ""),
        "category": sub.get("category") or "other",
        "name": sub.get("name", ""),
        "description": sub.get("description", ""),
        "author": sub.get("author", ""),
        "gameVersion": version,
        "region": region,
        "dirName": dirname,
        "size": int(sub.get("size") or 0),
        "sha256": sha,
        "url": sub.get("url", ""),
        "mirror": sub.get("mirror", ""),
        "format": "xeno-save-zip",
        "kind": "ps5",
        "layout": (look or {}).get("layout") or prev.get("layout", ""),
        "createdAt": prev.get("createdAt") or created_at,
        "downloads": int(prev.get("downloads") or 0),
        "status": status,
        "tags": list(sub.get("tags") or []),
        "screenshot": sub.get("screenshot", ""),
        "cover": prev.get("cover", ""),
        "source": "xeno",
        "needsResign": True,
    }
    if reasons:
        entry["reasons"] = list(reasons)
    return entry


def upsert(index: dict, entry: dict) -> tuple[dict, bool]:
    """Replace the entry for the same issue (or the same file), keep examples untouched, sort deterministically."""
    saves = index.get("saves") or []
    examples = [s for s in saves if isinstance(s, dict) and s.get("status") == "example"]
    rows = [s for s in saves if isinstance(s, dict) and s.get("status") != "example"]
    kept = [s for s in rows if s.get("issue") != entry["issue"]]
    kept.append(entry)
    kept.sort(key=lambda s: (int(s.get("issue") or 0), str(s.get("id") or "")))
    new_saves = examples + kept
    changed = json.dumps(new_saves, sort_keys=True, ensure_ascii=False) != json.dumps(saves, sort_keys=True, ensure_ascii=False)
    out = dict(index)
    out["saves"] = new_saves
    return out, changed


def find_existing(index: dict, issue: int, sha256: str) -> tuple[dict | None, dict | None]:
    """(entry for this issue, published/pending entry of another issue with the same file)."""
    mine = None
    other = None
    for s in index.get("saves") or []:
        if not isinstance(s, dict) or s.get("status") == "example":
            continue
        if s.get("issue") == issue:
            mine = s
        elif sha256 and s.get("sha256") == sha256 and s.get("status") in ("published", "pending"):
            other = s
    return mine, other


def dump_index(index: dict) -> str:
    return json.dumps(index, indent=2, ensure_ascii=False) + "\n"


def write_index(path: str, index: dict) -> None:
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8", newline="\n") as f:
        f.write(dump_index(index))
    os.replace(tmp, path)


# ----------------------------------------------------------------------------
# 5. decisions + comment

def decide_status(labels: list[str], valid: bool) -> str:
    low = {l.lower() for l in labels}
    if "rejected" in low or not valid:
        return "rejected"
    if "approved" in low:
        return "published"
    return "pending"


def render_comment(result: dict) -> str:
    """Plain XENO team wording for the issue comment."""
    status = result.get("status")
    sub = result.get("submission") or {}
    lines = ["<!-- xeno-saves-intake -->"]
    head = "%s · %s" % (sub.get("title") or sub.get("titleId") or "save", sub.get("name") or sub.get("category") or "")
    if status == "published":
        lines.append("**Published.** %s is now in the XENO STORE Save Data Store (entry `%s`). Consoles pick it up within an hour." % (head, result.get("id")))
    elif status == "pending":
        lines.append("**Checked and waiting for review.** %s passed every check; the XENO team will add the `approved` label to publish it." % head)
    else:
        lines.append("**Not published.** %s" % ("This submission was rejected." if not result.get("errors") else "The checks below did not pass:"))
        for e in result.get("errors") or []:
            lines.append("- %s" % e)
        if result.get("errors"):
            lines.append("")
            lines.append("Fix the issue body (keep the JSON block) or upload again from XENO STORE → Library → Community Saves → Upload my save; the checks run again on every edit.")
    checks = result.get("checks") or {}
    if checks:
        parts = []
        if checks.get("size") is not None:
            parts.append("size %s" % checks["size"])
        if checks.get("sha256"):
            parts.append("sha256 %s" % checks["sha256"])
        if checks.get("layout"):
            parts.append("layout %s" % checks["layout"])
        if checks.get("dataFiles") is not None:
            parts.append("%d save file(s)" % checks["dataFiles"])
        if parts:
            lines.append("")
            lines.append("Checks: " + " · ".join(parts) + ".")
    warns = result.get("warnings") or []
    if warns:
        lines.append("")
        lines.append("Notes: " + "; ".join(warns) + ".")
    lines.append("")
    lines.append("— XENO team · automated intake")
    return "\n".join(lines)


# ----------------------------------------------------------------------------
# 6. the run

def read_issue(args) -> dict:
    """Normalize the three input forms into {number, title, body, labels, created_at, html_url}."""
    if args.event:
        with open(args.event, "r", encoding="utf-8") as f:
            ev = json.load(f)
        issue = ev.get("issue") if isinstance(ev, dict) else None
        if not isinstance(issue, dict):
            raise IntakeError("the event payload has no issue object")
    elif args.issue_json:
        with open(args.issue_json, "r", encoding="utf-8") as f:
            issue = json.load(f)
        if not isinstance(issue, dict):
            raise IntakeError("the issue JSON must be an object")
    elif args.body:
        with open(args.body, "r", encoding="utf-8") as f:
            body = f.read()
        issue = {"number": args.number, "title": args.title or "", "body": body, "labels": [], "created_at": args.created_at or "", "html_url": ""}
    else:
        raise IntakeError("one of --event, --issue-json or --body is required")
    number = issue.get("number")
    if args.number:
        number = args.number
    if not isinstance(number, int) or number <= 0:
        raise IntakeError("the issue number is missing")
    labels = []
    for l in issue.get("labels") or []:
        if isinstance(l, dict) and isinstance(l.get("name"), str):
            labels.append(l["name"])
        elif isinstance(l, str):
            labels.append(l)
    if args.labels:
        labels += [l.strip() for l in args.labels.split(",") if l.strip()]
    return {
        "number": number,
        "title": issue.get("title") or "",
        "body": issue.get("body") or "",
        "labels": labels,
        "created_at": issue.get("created_at") or issue.get("createdAt") or args.created_at or "",
        "html_url": issue.get("html_url") or issue.get("url") or "",
    }


def run(args) -> dict:
    now = args.now or utc_now()
    issue = read_issue(args)
    number = issue["number"]
    result: dict = {"ok": False, "issue": number, "status": "rejected", "errors": [], "warnings": [], "checks": {}, "changed": False, "labels": issue["labels"]}
    index = load_index(args.index, now)

    sub: dict = {}
    look = None
    try:
        raw = parse_issue_body(issue["body"])
        sub, errors, warnings = normalize_submission(raw)
    except ValueError as e:
        errors, warnings = [str(e)], []
    result["submission"] = sub
    result["warnings"] = warnings

    mine, other = find_existing(index, number, sub.get("sha256", ""))
    if other is not None and not errors:
        errors.append("this exact file is already in the store as `%s` (issue #%s)" % (other.get("id"), other.get("issue")))

    if not errors and not args.no_download:
        tmpdir = args.download_dir or tempfile.mkdtemp(prefix="xeno-save-")
        os.makedirs(tmpdir, exist_ok=True)
        path = args.file or os.path.join(tmpdir, "submission.zip")
        try:
            if args.file:
                size, sha = sha256_file(args.file)
            else:
                size, sha = download(sub["url"], path, sub["size"], max_bytes=args.max_bytes)
            result["checks"]["size"] = size
            result["checks"]["sha256"] = sha
            if size != sub["size"]:
                errors.append("the file is %d bytes but the submission says %d" % (size, sub["size"]))
            if sha != sub["sha256"]:
                errors.append("the sha256 of the file does not match the submission")
            if not errors:
                look = inspect_zip(path, sub["titleId"])
                result["checks"]["layout"] = look["layout"]
                result["checks"]["dataFiles"] = look["dataFiles"]
                result["checks"]["entries"] = look["entries"]
                errors.extend(look["reasons"])
                if look.get("manifest"):
                    result["checks"]["manifest"] = look["manifest"]
        except ValueError as e:
            errors.append(str(e))
        finally:
            if not args.file and not args.keep and os.path.exists(path):
                try:
                    os.remove(path)
                except OSError:
                    pass
    elif not errors and args.no_download:
        warnings.append("file not downloaded (--no-download): size, sha256 and zip contents were not checked")

    valid = not errors
    status = decide_status(issue["labels"], valid)
    result["errors"] = errors
    result["ok"] = valid
    result["status"] = status

    if valid or mine is not None:
        if valid:
            entry = build_entry(sub, number, issue["html_url"], issue["created_at"] or now, status, look, mine, [])
        else:
            # keep what we knew about the file, flip the status, record why
            entry = dict(mine)
            entry["status"] = "rejected"
            entry["reasons"] = list(errors)
        new_index, changed = upsert(index, entry)
        result["id"] = entry["id"]
        result["entry"] = entry
        if changed:
            new_index["updatedAt"] = now
        result["changed"] = changed
        if changed and not args.dry_run:
            write_index(args.index, new_index)
            result["written"] = args.index
    else:
        result["id"] = ""
    result["comment"] = render_comment(result)
    return result


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="XENO STORE community save intake")
    src = ap.add_argument_group("input")
    src.add_argument("--event", help="GitHub Actions event payload ($GITHUB_EVENT_PATH)")
    src.add_argument("--issue-json", help="issue JSON (gh issue view N --json number,title,body,labels,createdAt,url)")
    src.add_argument("--body", help="issue body markdown file (with --number)")
    src.add_argument("--number", type=int, default=0, help="issue number (overrides the payload)")
    src.add_argument("--title", default="", help="issue title (with --body)")
    src.add_argument("--labels", default="", help="extra labels, comma separated (approved, rejected)")
    src.add_argument("--created-at", default="", help="ISO timestamp used as createdAt (with --body)")
    ap.add_argument("--index", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "updates", "saves.json"), help="updates/saves.json path")
    ap.add_argument("--file", help="use this local zip instead of downloading the url")
    ap.add_argument("--download-dir", help="where the zip is downloaded (default: a temp dir)")
    ap.add_argument("--keep", action="store_true", help="keep the downloaded zip")
    ap.add_argument("--no-download", action="store_true", help="validate the fields only")
    ap.add_argument("--max-bytes", type=int, default=MAX_BYTES, help="download cap in bytes (default 2 GiB)")
    ap.add_argument("--dry-run", action="store_true", help="do not write the index")
    ap.add_argument("--out", help="write the result JSON here (stdout otherwise)")
    ap.add_argument("--now", default="", help="fixed timestamp for updatedAt (tests)")
    ap.add_argument("--strict", action="store_true", help="exit 2 when the submission is rejected")
    ap.add_argument("--validate-index", metavar="PATH", help="validate an index file and exit")
    args = ap.parse_args(argv)
    try:
        if args.validate_index:
            with open(args.validate_index, "r", encoding="utf-8") as f:
                data = json.load(f)
            errs = validate_index(data)
            for e in errs:
                print("error: %s" % e, file=sys.stderr)
            n = len([s for s in data.get("saves", []) if isinstance(s, dict)]) if isinstance(data, dict) else 0
            pub = len([s for s in data.get("saves", []) if isinstance(s, dict) and s.get("status") == "published"]) if isinstance(data, dict) else 0
            print("%s: %s (%d entries, %d published)" % (args.validate_index, "ok" if not errs else "%d error(s)" % len(errs), n, pub))
            return 0 if not errs else 1
        if args.max_bytes <= 0 or args.max_bytes > MAX_BYTES:
            raise IntakeError("--max-bytes must be between 1 and %d" % MAX_BYTES)
        result = run(args)
    except IntakeError as e:
        print("intake: %s" % e, file=sys.stderr)
        return 1
    except (OSError, ValueError) as e:
        print("intake: %s" % e, file=sys.stderr)
        return 1
    text = json.dumps(result, indent=2, ensure_ascii=False)
    if args.out:
        with open(args.out, "w", encoding="utf-8") as f:
            f.write(text + "\n")
        print("intake #%d: %s%s" % (result["issue"], result["status"], " (index updated)" if result.get("written") else ""))
    else:
        print(text)
    if args.strict and not result["ok"]:
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
