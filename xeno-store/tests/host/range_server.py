#!/usr/bin/env python3
"""
range_server.py — fault-injecting HTTP file server for the download tests.

URL layout: /<modes>/<name>  where <modes> is a comma-separated list of:
  ok        plain file (ETag + Last-Modified + Accept-Ranges)
  noetag    no validators at all (ETag/Last-Modified omitted)
  lm        Last-Modified only (no ETag)
  norange   Range is ignored: always 200 + full body, no Accept-Ranges
  slow      throttle every stream to SLOW_RATE (default 1 MiB/s); slow4 → 4 MiB/s
  drop      close the connection after 4 MiB on the first 2 large requests
  r429      first request per path → 429 with Retry-After: 1, then normal
  f403      first request per path → 403, then normal
  f404      always 404
  html      200 text/html page instead of the file
Control endpoints:
  /ctl/flip/<name>   rewrite the file with new random bytes (same size) → {"sha256": ...}
  /ctl/sha256/<name> → {"sha256": ...}
  /ctl/stats         → request counters + max concurrent streams per file + debrid calls
  /ctl/reset         → clear counters and once-flags

ZIP fixtures (generated next to the files): folder.zip (a folder dump with
nested dirs plus three unsafe entries that must be skipped) and single.zip
(one .ffpfsc image that extracts straight to homebrew/).

Mock debrid APIs (SPEC §17.14 shapes) under /rd, /ad, /tb and /pm so the
payload can be pointed at them with XENO_RD_BASE=http://127.0.0.1:PORT/rd …:
  keys: rd-good / ad-good / tb-good / pm-good are valid, anything else is
  rejected in the service's own error style; supported hosts are 127.0.0.1,
  localhost, 1fichier.com and mediafire.com; a link to <modes>/<name> is
  unrestricted to /ok/<name>; a link whose file is called huge.bin triggers
  the plan-limit error; TorBox reports "downloading" on the first poll and
  "completed" afterwards.

Run standalone:  python3 range_server.py --dir DIR [--port N] [--keep]
Or import and call serve_in_thread(dir, port=0, keep=False).
"""
import argparse
import hashlib
import io
import json
import os
import re
import socket
import sys
import threading
import time
import urllib.parse
import zipfile
from email.utils import formatdate
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MiB = 1024 * 1024
FILES = {"big.bin": 64 * MiB, "mid.bin": 32 * MiB, "small.bin": 8 * MiB, "tiny.pkg": 2 * MiB,
         "flipA.bin": 32 * MiB, "flipB.bin": 8 * MiB,
         "set-game.pkg": 2 * MiB, "set-update.pkg": 1 * MiB, "set-dlc.pkg": 3 * MiB // 2}   # flip*.bin are rewritten by the source_changed tests
ZIPS = ("folder.zip", "single.zip", "secretcom.zip", "secretpw.zip", "slip.zip")
# Classic ZipCrypto fixtures (built with the `zip` CLI): the community password
# "SuperPSX" and a custom password not in the built-in list. The plaintext is a
# fixed pattern so a test can recompute its SHA-256 without a side channel.
ENCRYPTED_ZIPS = {
    "secretcom.zip": ("PPSA07001 Community.ffpfsc", "SuperPSX"),
    "secretpw.zip": ("PPSA07002 Custom.ffpfsc", "xeno-secret-42"),
}
ENCRYPTED_ENTRY_SIZE = MiB


def encrypted_entry_bytes():
    return bytes((i * 37 + 11) & 0xFF for i in range(ENCRYPTED_ENTRY_SIZE))
PKG_CONTENT_ID = b"UP0001-PPSA01234_00-XENOTESTPKG00000"   # 36 chars, title id at 7..15
PKG_CONTENT_IDS = {"set-game.pkg": b"UP0001-PPSA02222_00-XENOSETGAME00000",
                   "set-update.pkg": b"UP0001-PPSA02222_00-XENOSETUPDATE000",
                   "set-dlc.pkg": b"UP0001-PPSA02222_00-XENOSETDLC000000"}
DEBRID_KEYS = {"rd": "rd-good", "ad": "ad-good", "tb": "tb-good", "pm": "pm-good"}
DEBRID_HOSTS = ["127.0.0.1", "localhost", "1fichier.com", "mediafire.com"]


class State:
    def __init__(self, directory):
        self.dir = directory
        self.lock = threading.Lock()
        self.requests = {}
        self.once = set()
        self.drop_count = {}
        self.active = {}
        self.max_concurrent = {}
        self.range_requests = 0
        self.sha = {}
        self.mtime = {}
        self.debrid_calls = []
        self.torbox_polls = {}
        self.torbox_next_id = 100

    def path(self, name):
        return os.path.join(self.dir, name)

    def generate(self, keep=False):
        """Creates every fixture; with keep=True existing files are reused
        (sha/mtime read from disk) so a restarted server serves identical
        bytes and validators — the rest-mode test depends on that."""
        os.makedirs(self.dir, exist_ok=True)
        for name, size in FILES.items():
            if keep and os.path.exists(self.path(name)) and os.path.getsize(self.path(name)) == size:
                self.adopt(name)
            else:
                self.write_random(name, size)
        for name in ZIPS:
            if keep and os.path.exists(self.path(name)):
                self.adopt(name)
            elif name in ENCRYPTED_ZIPS:
                self.write_encrypted_zip(name)
            else:
                self.write_zip(name)

    def adopt(self, name):
        h = hashlib.sha256()
        with open(self.path(name), "rb") as f:
            for chunk in iter(lambda: f.read(1 << 20), b""):
                h.update(chunk)
        with self.lock:
            self.sha[name] = h.hexdigest()
            self.mtime[name] = os.path.getmtime(self.path(name))

    def write_random(self, name, size):
        data = bytearray(os.urandom(size))
        if name.endswith(".pkg"):
            data[0:4] = b"\x7fCNT"
            data[0x40:0x40 + 36] = PKG_CONTENT_IDS.get(name, PKG_CONTENT_ID)
        with open(self.path(name), "wb") as f:
            f.write(data)
        with self.lock:
            self.sha[name] = hashlib.sha256(data).hexdigest()
            self.mtime[name] = time.time()
        return self.sha[name]

    def write_zip(self, name):
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
            if name == "folder.zip":
                zf.writestr("MyGame/eboot.bin", os.urandom(1 * MiB))
                zf.writestr("MyGame/sce_sys/param.json", json.dumps({"titleId": "PPSA06666", "title": "Folder Dump"}))
                zf.writestr("MyGame/data/level1.dat", os.urandom(2 * MiB))
                zf.writestr("MyGame/data/notes.txt", b"readme")
                # unsafe entries: must be skipped, never written
                zf.writestr("../evil-parent.txt", b"evil")
                zf.writestr("/abs/evil-abs.txt", b"evil")
                zf.writestr("MyGame/../../evil-nested.txt", b"evil")
            elif name == "slip.zip":
                zf.writestr("safe/keep.bin", os.urandom(1 * MiB))      # survivors (folder dump)
                zf.writestr("safe/readme.txt", b"ok")
                zf.writestr("../slip-parent.bin", b"evil")
                zf.writestr("/abs/slip-abs.bin", b"evil")
                zf.writestr("a/../../slip-nested.bin", b"evil")
                zf.writestr("win\\slip-back.bin", b"evil")
                zf.writestr("__MACOSX/safe/._keep.bin", b"junk")
            else:
                zf.writestr("PPSA05555 Single Game.ffpfsc", os.urandom(4 * MiB))
        data = buf.getvalue()
        with open(self.path(name), "wb") as f:
            f.write(data)
        with self.lock:
            self.sha[name] = hashlib.sha256(data).hexdigest()
            self.mtime[name] = time.time()

    def write_encrypted_zip(self, name):
        import subprocess, tempfile, shutil
        entry, password = ENCRYPTED_ZIPS[name]
        out = self.path(name)
        if os.path.exists(out):
            os.remove(out)
        tdir = tempfile.mkdtemp()
        try:
            fp = os.path.join(tdir, entry)
            with open(fp, "wb") as f:
                f.write(encrypted_entry_bytes())
            subprocess.run(["zip", "-q", "-P", password, "-j", out, fp], check=True)
        finally:
            shutil.rmtree(tdir, ignore_errors=True)
        with open(out, "rb") as f:
            data = f.read()
        with self.lock:
            self.sha[name] = hashlib.sha256(data).hexdigest()
            self.mtime[name] = time.time()

    def reset(self):
        with self.lock:
            self.requests.clear()
            self.once.clear()
            self.drop_count.clear()
            self.max_concurrent.clear()
            self.range_requests = 0
            self.debrid_calls.clear()
            self.torbox_polls.clear()

    def enter(self, name):
        with self.lock:
            self.active[name] = self.active.get(name, 0) + 1
            self.max_concurrent[name] = max(self.max_concurrent.get(name, 0), self.active[name])

    def leave(self, name):
        with self.lock:
            self.active[name] = max(0, self.active.get(name, 0) - 1)


STATE = None


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "XenoRangeServer/1.0"

    def log_message(self, fmt, *args):   # keep the test output clean
        if os.environ.get("RANGE_SERVER_VERBOSE"):
            sys.stderr.write("range_server: " + fmt % args + "\n")

    def _json(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Connection", "close")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def do_HEAD(self):
        self.do_GET()

    def do_POST(self):
        path = self.path.split("?")[0]
        parts = [p for p in path.split("/") if p]
        if parts and parts[0] in ("rd", "ad", "tb", "pm"):
            return self._debrid(parts[0], parts[1:])
        return self._json(404, {"error": "no such endpoint"})

    # ---- mock debrid services (SPEC §17.14 shapes) ------------------------
    def _form(self):
        n = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(n) if n else b""
        return {k: v[0] for k, v in urllib.parse.parse_qs(raw.decode("utf-8", "replace")).items()}

    def _query(self):
        q = self.path.split("?", 1)[1] if "?" in self.path else ""
        return {k: v[0] for k, v in urllib.parse.parse_qs(q).items()}

    def _bearer(self):
        auth = self.headers.get("Authorization") or ""
        return auth[7:].strip() if auth.lower().startswith("bearer ") else ""

    def _unrestrict(self, link):
        """Maps a range-server link to its /ok/ twin; returns (direct, name, size) or an error code."""
        try:
            u = urllib.parse.urlsplit(link)
        except ValueError:
            return "unsupported"
        host = (u.hostname or "").lower()
        if host not in DEBRID_HOSTS:
            return "unsupported"
        parts = [p for p in u.path.split("/") if p]
        name = parts[-1] if parts else ""
        if name == "huge.bin":
            return "limit"
        if name not in FILES and name not in ZIPS:
            return "unavailable"
        size = os.path.getsize(STATE.path(name))
        direct = f"{u.scheme}://{u.netloc}/ok/{name}"
        return (direct, name, size)

    def _debrid(self, svc, parts):
        sub = "/".join(parts)
        q = self._query()
        form = self._form() if self.command == "POST" else {}
        with STATE.lock:
            STATE.debrid_calls.append({"svc": svc, "method": self.command, "path": sub})
        good = DEBRID_KEYS[svc]
        link = form.get("link") or form.get("src") or q.get("link") or ""
        if svc == "rd":
            key = self._bearer()
            if key != good:
                return self._json(401, {"error": "bad_token", "error_code": 8})
            if sub == "user":
                return self._json(200, {"id": 1, "username": "xenoking", "email": "x@example.com", "premium": 86400 * 200,
                                        "expiration": "2027-01-01T00:00:00.000Z", "type": "premium"})
            if sub == "hosts/domains":
                return self._json(200, DEBRID_HOSTS)
            if sub == "unrestrict/link":
                r = self._unrestrict(link)
                if r == "unsupported":
                    return self._json(503, {"error": "hoster_unsupported", "error_code": 16})
                if r == "limit":
                    return self._json(503, {"error": "traffic_exhausted", "error_code": 36})
                if r == "unavailable":
                    return self._json(503, {"error": "unavailable_file", "error_code": 19})
                direct, name, size = r
                return self._json(200, {"id": "RDX1", "filename": name, "filesize": size, "link": link, "host": "127.0.0.1",
                                        "download": direct, "streamable": 0})
            return self._json(404, {"error": "unknown_resource", "error_code": 7})
        if svc == "ad":
            key = q.get("apikey", "")
            if sub == "hosts":
                return self._json(200, {"status": "success", "data": {"hosts": {
                    "local": {"name": "local", "domains": ["127.0.0.1", "localhost"], "status": True},
                    "1fichier": {"name": "1fichier", "domains": ["1fichier.com"], "status": True},
                    "mediafire": {"name": "mediafire", "domains": ["mediafire.com"], "status": True}}}})
            if key != good:
                return self._json(200, {"status": "error", "error": {"code": "AUTH_BAD_APIKEY", "message": "The auth apikey is invalid"}})
            if sub == "user":
                return self._json(200, {"status": "success", "data": {"user": {"username": "xenoking", "isPremium": True, "premiumUntil": 1800000000}}})
            if sub == "link/unlock":
                r = self._unrestrict(link)
                if r == "unsupported":
                    return self._json(200, {"status": "error", "error": {"code": "LINK_HOST_NOT_SUPPORTED", "message": "This host or link is not supported"}})
                if r == "limit":
                    return self._json(200, {"status": "error", "error": {"code": "MUST_BE_PREMIUM", "message": "You must be premium to process this link"}})
                if r == "unavailable":
                    return self._json(200, {"status": "error", "error": {"code": "LINK_DOWN", "message": "This link is not available on the file hosting website"}})
                direct, name, size = r
                return self._json(200, {"status": "success", "data": {"link": direct, "host": "127.0.0.1", "filename": name, "filesize": size, "id": "ADX1"}})
            return self._json(404, {"status": "error", "error": {"code": "ENDPOINT", "message": "unknown"}})
        if svc == "tb":
            key = self._bearer() or q.get("token", "")
            if key != good:
                return self._json(401, {"success": False, "error": "BAD_TOKEN", "detail": "Invalid token"})
            if sub == "user/me":
                return self._json(200, {"success": True, "data": {"email": "xeno@example.com", "plan": 2, "premium_expires_at": "2027-01-01T00:00:00Z"}})
            if sub == "webdl/createwebdownload":
                r = self._unrestrict(link)
                if r == "unsupported":
                    return self._json(200, {"success": False, "error": "LINK_NOT_SUPPORTED", "detail": "This host is not supported"})
                if r == "limit":
                    return self._json(200, {"success": False, "error": "DOWNLOAD_TOO_LARGE", "detail": "Your plan limits files to 107 GB"})
                if r == "unavailable":
                    return self._json(200, {"success": False, "error": "DOWNLOAD_SERVER_ERROR", "detail": "The link is dead"})
                direct, name, size = r
                with STATE.lock:
                    wid = STATE.torbox_next_id
                    STATE.torbox_next_id += 1
                    STATE.torbox_polls[wid] = {"direct": direct, "name": name, "size": size, "polls": 0}
                return self._json(200, {"success": True, "data": {"webdownload_id": wid, "hash": "deadbeef", "auth_id": "x"}})
            if sub == "webdl/mylist":
                wid = int(q.get("id", "0") or 0)
                with STATE.lock:
                    item = STATE.torbox_polls.get(wid)
                    if item is not None:
                        item["polls"] += 1
                if item is None:
                    return self._json(200, {"success": False, "error": "NOT_FOUND", "detail": "no such download"})
                if item["polls"] < 2:
                    return self._json(200, {"success": True, "data": {"id": wid, "download_state": "downloading", "download_finished": False, "files": []}})
                return self._json(200, {"success": True, "data": {"id": wid, "name": item["name"], "download_state": "completed", "download_finished": True,
                                                                  "files": [{"id": 0, "name": item["name"], "size": item["size"]}]}})
            if sub == "webdl/requestdl":
                wid = int(q.get("web_id", "0") or 0)
                with STATE.lock:
                    item = STATE.torbox_polls.get(wid)
                if item is None:
                    return self._json(200, {"success": False, "error": "NOT_FOUND", "detail": "no such download"})
                return self._json(200, {"success": True, "data": item["direct"]})
            return self._json(404, {"success": False, "error": "UNKNOWN", "detail": "unknown endpoint"})
        if svc == "pm":
            key = q.get("apikey", "")
            if key != good:
                return self._json(200, {"status": "error", "message": "Invalid API key"})
            if sub == "account/info":
                return self._json(200, {"status": "success", "customer_id": 123456, "premium_until": 1800000000, "limit_used": 0.1})
            if sub == "services/list":
                return self._json(200, {"directdl": DEBRID_HOSTS, "cache": ["1fichier.com"], "fairusefactor": {}})
            if sub == "transfer/directdl":
                r = self._unrestrict(link)
                if r == "unsupported":
                    return self._json(200, {"status": "error", "message": "This host is not supported"})
                if r == "limit":
                    return self._json(200, {"status": "error", "message": "Fair use limit reached"})
                if r == "unavailable":
                    return self._json(200, {"status": "error", "message": "File not found on the host"})
                direct, name, size = r
                return self._json(200, {"status": "success", "location": "", "filename": name, "filesize": size,
                                        "content": [{"path": name, "size": size, "link": direct, "stream_link": ""}]})
            return self._json(404, {"status": "error", "message": "unknown endpoint"})
        return self._json(404, {"error": "unknown service"})

    def _ctl(self, parts):
        cmd = parts[0] if parts else ""
        name = parts[1] if len(parts) > 1 else ""
        if cmd == "flip" and name in FILES:
            return self._json(200, {"sha256": STATE.write_random(name, FILES[name])})
        if cmd == "sha256" and name in FILES:
            return self._json(200, {"sha256": STATE.sha[name]})
        if cmd == "sha256" and name in ZIPS:
            return self._json(200, {"sha256": STATE.sha[name]})
        if cmd == "stats":
            with STATE.lock:
                return self._json(200, {"requests": dict(STATE.requests), "maxConcurrent": dict(STATE.max_concurrent),
                                        "rangeRequests": STATE.range_requests, "debridCalls": list(STATE.debrid_calls)})
        if cmd == "reset":
            STATE.reset()
            return self._json(200, {"ok": True})
        return self._json(404, {"error": "unknown control"})

    def do_GET(self):
        path = self.path.split("?")[0]
        parts = [p for p in path.split("/") if p]
        if parts and parts[0] == "ctl":
            return self._ctl(parts[1:])
        if parts and parts[0] in ("rd", "ad", "tb", "pm"):
            return self._debrid(parts[0], parts[1:])
        if len(parts) != 2 or (parts[1] not in FILES and parts[1] not in ZIPS):
            return self._json(404, {"error": "no such file"})
        modes = set(parts[0].split(","))
        name = parts[1]
        key = path
        with STATE.lock:
            STATE.requests[key] = STATE.requests.get(key, 0) + 1
            first = key not in STATE.once
            STATE.once.add(key)
            if "Range" in self.headers:
                STATE.range_requests += 1
        if "f404" in modes:
            return self._json(404, {"error": "gone"})
        if "f403" in modes and first:
            return self._json(403, {"error": "forbidden once"})
        if "r429" in modes and first:
            body = b"slow down"
            self.send_response(429)
            self.send_header("Retry-After", "1")
            self.send_header("Content-Type", "text/plain")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Connection", "close")
            self.end_headers()
            self.wfile.write(body)
            return
        if "html" in modes:
            body = b"<!DOCTYPE html><html><head><title>Download</title></head><body><a href='/ok/big.bin'>Click</a></body></html>"
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Connection", "close")
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(body)
            return
        self._serve_file(name, modes, key)

    def _serve_file(self, name, modes, key):
        fpath = STATE.path(name)
        total = os.path.getsize(fpath)
        start, end, partial = 0, total - 1, False
        rng = self.headers.get("Range")
        if rng and "norange" not in modes:
            m = re.match(r"bytes=(\d*)-(\d*)$", rng.strip())
            if not m:
                return self._json(416, {"error": "bad range"})
            a, b = m.group(1), m.group(2)
            if a == "" and b == "":
                return self._json(416, {"error": "bad range"})
            if a == "":
                start, end = max(0, total - int(b)), total - 1
            else:
                start = int(a)
                end = int(b) if b else total - 1
            if start >= total or end < start:
                self.send_response(416)
                self.send_header("Content-Range", f"bytes */{total}")
                self.send_header("Content-Length", "0")
                self.send_header("Connection", "close")
                self.end_headers()
                return
            end = min(end, total - 1)
            partial = True
        length = end - start + 1
        self.send_response(206 if partial else 200)
        self.send_header("Content-Type", "application/octet-stream")
        self.send_header("Content-Length", str(length))
        self.send_header("Connection", "close")
        if "norange" not in modes:
            self.send_header("Accept-Ranges", "bytes")
        if "noetag" not in modes:
            if "lm" not in modes:
                self.send_header("ETag", '"' + STATE.sha[name][:32] + '"')
            self.send_header("Last-Modified", formatdate(STATE.mtime[name], usegmt=True))
        if partial:
            self.send_header("Content-Range", f"bytes {start}-{end}/{total}")
        self.end_headers()
        if self.command == "HEAD":
            return
        rate = 0
        for m in modes:
            if m.startswith("slow"):
                rate = (int(m[4:]) if m[4:] else 1) * MiB
        drop_at = None
        if "drop" in modes and length > 4 * MiB:
            with STATE.lock:
                n = STATE.drop_count.get(key, 0)
                if n < 2:
                    STATE.drop_count[key] = n + 1
                    drop_at = 4 * MiB
        STATE.enter(name)
        try:
            sent = 0
            piece = 64 * 1024
            t0 = time.time()
            with open(fpath, "rb") as f:
                f.seek(start)
                while sent < length:
                    chunk = f.read(min(piece, length - sent))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    sent += len(chunk)
                    if drop_at is not None and sent >= drop_at:
                        self.wfile.flush()
                        try:
                            self.connection.shutdown(socket.SHUT_RDWR)
                        except OSError:
                            pass
                        self.close_connection = True
                        return
                    if rate:
                        expected = sent / rate
                        ahead = expected - (time.time() - t0)
                        if ahead > 0:
                            time.sleep(min(ahead, 0.25))
        except (BrokenPipeError, ConnectionResetError):
            pass
        finally:
            STATE.leave(name)


def serve_in_thread(directory, port=0, keep=False):
    global STATE
    STATE = State(directory)
    STATE.generate(keep=keep)
    httpd = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    httpd.allow_reuse_address = True
    httpd.daemon_threads = True
    t = threading.Thread(target=httpd.serve_forever, daemon=True)
    t.start()
    return httpd, httpd.server_address[1]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", required=True)
    ap.add_argument("--port", type=int, default=0)
    ap.add_argument("--keep", action="store_true", help="reuse existing fixture files (same bytes, same validators)")
    args = ap.parse_args()
    httpd, port = serve_in_thread(args.dir, args.port, keep=args.keep)
    print(f"range_server listening on 127.0.0.1:{port}", flush=True)
    try:
        while True:
            time.sleep(3600)
    except KeyboardInterrupt:
        httpd.shutdown()


if __name__ == "__main__":
    main()
