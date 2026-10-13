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
  /ctl/stats         → request counters + max concurrent streams per file
  /ctl/reset         → clear counters and once-flags

Run standalone:  python3 range_server.py --dir DIR [--port N]
Or import and call serve_in_thread(dir).
"""
import argparse
import hashlib
import json
import os
import re
import socket
import sys
import threading
import time
from email.utils import formatdate
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MiB = 1024 * 1024
FILES = {"big.bin": 64 * MiB, "mid.bin": 32 * MiB, "small.bin": 8 * MiB, "tiny.pkg": 2 * MiB,
         "flipA.bin": 32 * MiB, "flipB.bin": 8 * MiB}   # flip*.bin are rewritten by the source_changed tests
PKG_CONTENT_ID = b"UP0001-PPSA01234_00-XENOTESTPKG00000"   # 36 chars, title id at 7..15


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

    def path(self, name):
        return os.path.join(self.dir, name)

    def generate(self):
        os.makedirs(self.dir, exist_ok=True)
        for name, size in FILES.items():
            self.write_random(name, size)

    def write_random(self, name, size):
        data = bytearray(os.urandom(size))
        if name.endswith(".pkg"):
            data[0:4] = b"\x7fCNT"
            data[0x40:0x40 + 36] = PKG_CONTENT_ID
        with open(self.path(name), "wb") as f:
            f.write(data)
        with self.lock:
            self.sha[name] = hashlib.sha256(data).hexdigest()
            self.mtime[name] = time.time()
        return self.sha[name]

    def reset(self):
        with self.lock:
            self.requests.clear()
            self.once.clear()
            self.drop_count.clear()
            self.max_concurrent.clear()
            self.range_requests = 0

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

    def _ctl(self, parts):
        cmd = parts[0] if parts else ""
        name = parts[1] if len(parts) > 1 else ""
        if cmd == "flip" and name in FILES:
            return self._json(200, {"sha256": STATE.write_random(name, FILES[name])})
        if cmd == "sha256" and name in FILES:
            return self._json(200, {"sha256": STATE.sha[name]})
        if cmd == "stats":
            with STATE.lock:
                return self._json(200, {"requests": dict(STATE.requests), "maxConcurrent": dict(STATE.max_concurrent),
                                        "rangeRequests": STATE.range_requests})
        if cmd == "reset":
            STATE.reset()
            return self._json(200, {"ok": True})
        return self._json(404, {"error": "unknown control"})

    def do_GET(self):
        path = self.path.split("?")[0]
        parts = [p for p in path.split("/") if p]
        if parts and parts[0] == "ctl":
            return self._ctl(parts[1:])
        if len(parts) != 2 or parts[1] not in FILES:
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


def serve_in_thread(directory, port=0):
    global STATE
    STATE = State(directory)
    STATE.generate()
    httpd = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    httpd.daemon_threads = True
    t = threading.Thread(target=httpd.serve_forever, daemon=True)
    t.start()
    return httpd, httpd.server_address[1]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", required=True)
    ap.add_argument("--port", type=int, default=0)
    args = ap.parse_args()
    httpd, port = serve_in_thread(args.dir, args.port)
    print(f"range_server listening on 127.0.0.1:{port}", flush=True)
    try:
        while True:
            time.sleep(3600)
    except KeyboardInterrupt:
        httpd.shutdown()


if __name__ == "__main__":
    main()
