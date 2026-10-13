#!/usr/bin/env python3
"""
harness.py — shared helpers for the host test suite: spawn the host binary with
a temp data dir and roots, talk JSON to it, wait for job states, hash files.
"""
import hashlib
import json
import os
import signal
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
PROJECT = os.path.dirname(os.path.dirname(HERE))
BINARY = os.environ.get("XENO_BIN", os.path.join(PROJECT, "build", "host", "xeno-store"))

MiB = 1024 * 1024


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


class XenoServer:
    """One host-binary instance. `roots` are extra --root dirs; the data dir's
    downloads/ folder is always the first (default) root."""

    def __init__(self, data_dir, roots=(), env=None, port=None, log_name="xeno.log"):
        self.data_dir = data_dir
        self.roots = list(roots)
        self.port = port or free_port()
        self.env = dict(os.environ)
        self.env.pop("HTTPS_PROXY", None)
        self.env.pop("HTTP_PROXY", None)
        self.env.pop("https_proxy", None)
        self.env.pop("http_proxy", None)
        if env:
            self.env.update(env)
        self.proc = None
        self.log_path = os.path.join(data_dir, log_name)
        self.base = f"http://127.0.0.1:{self.port}"
        self.pin = None

    @property
    def default_root(self):
        return os.path.join(self.data_dir, "downloads")

    def start(self, timeout=10.0):
        os.makedirs(self.data_dir, exist_ok=True)
        args = [BINARY, "--port", str(self.port), "--data", self.data_dir, "--log-level", "debug"]
        for r in self.roots:
            args += ["--root", r]
        self.logf = open(self.log_path, "ab")
        self.proc = subprocess.Popen(args, stdout=self.logf, stderr=subprocess.STDOUT, env=self.env)
        deadline = time.time() + timeout
        while time.time() < deadline:
            if self.proc.poll() is not None:
                raise RuntimeError(f"xeno-store exited early with {self.proc.returncode}; see {self.log_path}")
            try:
                st, body = self.api("GET", "/api/status")
                if st == 200 and body.get("ok"):
                    return self
            except Exception:
                pass
            time.sleep(0.1)
        raise RuntimeError("xeno-store did not become ready")

    def stop(self, timeout=10.0):
        if not self.proc:
            return
        if self.proc.poll() is None:
            self.proc.send_signal(signal.SIGTERM)
            try:
                self.proc.wait(timeout=timeout)
            except subprocess.TimeoutExpired:
                self.proc.kill()
                self.proc.wait()
        self.logf.close()
        self.proc = None

    def kill(self):
        if self.proc and self.proc.poll() is None:
            self.proc.kill()
            self.proc.wait()
        if self.proc:
            self.logf.close()
        self.proc = None

    def raw(self, method, path, body=None, headers=None, timeout=70):
        data = None
        hdrs = {"Accept": "application/json"}
        if body is not None:
            data = body if isinstance(body, bytes) else json.dumps(body).encode()
            hdrs["Content-Type"] = "application/json"
        if self.pin:
            hdrs["X-XENO-PIN"] = self.pin
        if headers:
            hdrs.update(headers)
        req = urllib.request.Request(self.base + path, data=data, method=method, headers=hdrs)
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return resp.status, dict(resp.headers), resp.read()
        except urllib.error.HTTPError as e:
            return e.code, dict(e.headers), e.read()

    def api(self, method, path, body=None, headers=None, timeout=70):
        st, _, raw = self.raw(method, path, body, headers, timeout)
        try:
            return st, json.loads(raw.decode("utf-8"))
        except Exception:
            return st, {"_raw": raw}

    def job(self, jid):
        st, body = self.api("GET", "/api/queue?history=1")
        for j in body.get("jobs", []):
            if j["id"] == jid:
                return j
        return None

    def wait_job(self, jid, states, timeout=60, until=None):
        """Waits until the job's state is in `states` (or `until(job)` is true)."""
        if isinstance(states, str):
            states = {states}
        deadline = time.time() + timeout
        last = None
        while time.time() < deadline:
            j = self.job(jid)
            if j is None:
                raise AssertionError(f"job {jid} vanished")
            last = j
            if until is not None and until(j):
                return j
            if until is None and j["state"] in states:
                return j
            time.sleep(0.1)
        raise AssertionError(f"timeout waiting for {jid} → {states}; last={json.dumps(last)[:600]}")

    def add(self, **body):
        st, resp = self.api("POST", "/api/queue", body)
        if st != 200:
            raise AssertionError(f"POST /api/queue failed {st}: {resp}")
        return resp["job"]

    def action(self, jid, action, body=None):
        return self.api("POST", f"/api/queue/{jid}/{action}", body or {})

    def log_text(self):
        try:
            with open(self.log_path, "rb") as f:
                return f.read().decode("utf-8", "replace")
        except OSError:
            return ""


class RangeServerProcess:
    """range_server.py as a child process, so a test can kill it mid-transfer
    (every open connection dies, new connects are refused) and bring it back
    on the same port with the same files (--keep) — the rest-mode drill."""

    def __init__(self, files_dir, port=None):
        self.files_dir = files_dir
        self.port = port or free_port()
        self.proc = None
        self.base = f"http://127.0.0.1:{self.port}"

    def start(self, timeout=20.0):
        script = os.path.join(HERE, "range_server.py")
        self.proc = subprocess.Popen([sys.executable, "-I", script, "--dir", self.files_dir, "--port", str(self.port), "--keep"],
                                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        deadline = time.time() + timeout
        while time.time() < deadline:
            try:
                with urllib.request.urlopen(self.base + "/ctl/stats", timeout=2) as r:
                    r.read()
                return self
            except Exception:
                if self.proc.poll() is not None:
                    raise RuntimeError("range_server exited early")
                time.sleep(0.1)
        raise RuntimeError("range_server did not start")

    def kill(self):
        if self.proc and self.proc.poll() is None:
            self.proc.kill()
            self.proc.wait()
        self.proc = None

    def sha256(self, name):
        with urllib.request.urlopen(f"{self.base}/ctl/sha256/{name}", timeout=10) as r:
            return json.loads(r.read())["sha256"]


def wait_until(cond, timeout=30, every=0.1, what="condition"):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if cond():
            return True
        time.sleep(every)
    raise AssertionError(f"timeout waiting for {what}")


def write_catalog(data_dir, games, revision=2000000000):
    """Drops a cached catalog with a huge revision so the binary prefers it."""
    doc = {
        "schemaVersion": 1,
        "revision": revision,
        "generatedAt": "2026-01-01T00:00:00Z",
        "name": "XENO STORE test catalog",
        "sources": [
            {"id": "archive", "name": "Archive.org", "kind": "direct", "homepage": "https://archive.org"},
            {"id": "other", "name": "Other", "kind": "direct"},
        ],
        "genres": ["Action"],
        "games": games,
    }
    os.makedirs(data_dir, exist_ok=True)
    with open(os.path.join(data_dir, "catalog.json"), "w") as f:
        json.dump(doc, f)


def make_game(gid, title, title_id, releases, platform="PS5"):
    return {
        "id": gid, "slug": gid, "title": title, "platform": platform, "titleIds": [title_id],
        "region": "EUR", "genres": ["Action"], "publisher": "XENO", "releaseDate": "2026-01-01",
        "cover": "https://example.invalid/cover.webp", "verified": True, "featured": 0, "popularity": 1.0,
        "sizeMin": min([r.get("sizeBytes", 0) for r in releases] or [0]),
        "sizeMax": max([r.get("sizeBytes", 0) for r in releases] or [0]),
        "releases": releases,
    }


def make_release(rid, url, filename, size, fmt="FFPFSC", sha256="", mirrors=None, title_id="PPSA01234", source="archive",
                 kind="game", version="01.000.000", verified_at="2026-01-01", **extra):
    r = {
        "id": rid, "titleId": title_id, "region": "EUR", "version": version, "format": fmt, "kind": kind,
        "provider": "Archive.org" if source == "archive" else "Other", "sourceId": source, "filename": filename,
        "url": url, "browserUrl": "", "mirrors": mirrors or [], "sizeBytes": size, "sha256": sha256,
        "verifiedAt": verified_at, "consoleVerified": False,
    }
    r.update(extra)
    return r
