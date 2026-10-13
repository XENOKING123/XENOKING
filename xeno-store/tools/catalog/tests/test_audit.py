"""Link audit (SPEC §17.12): verdict logic, planning, probes against a local HTTP server, resumable results."""
from __future__ import annotations

import json
import os
import shutil
import sys
import tempfile
import threading
import unittest
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
sys.path.insert(0, HERE)

import audit  # noqa: E402
from netutil import Http  # noqa: E402

FILE_SIZE = 2048
HITS: dict[str, int] = {}


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):  # silence
        pass

    def _send(self, status, body=b"", ctype="application/octet-stream", extra=None):
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        p = self.path
        HITS[p] = HITS.get(p, 0) + 1
        if p == "/file.bin":
            rng = self.headers.get("Range")
            if rng:
                self._send(206, b"\0", extra={"Content-Range": f"bytes 0-0/{FILE_SIZE}", "Accept-Ranges": "bytes"})
            else:
                self._send(200, b"\0" * FILE_SIZE if self.command == "GET" else b"", extra={"Content-Length": str(FILE_SIZE)} if self.command == "HEAD" else None)
            return
        if p == "/norange.bin":
            self._send(200, b"\0" * 300)
            return
        if p == "/wrong.bin":
            self._send(206 if self.headers.get("Range") else 200, b"\0", extra={"Content-Range": "bytes 0-0/50000000"})
            return
        if p == "/html-file.bin":
            self._send(200, b"<html>login</html>", "text/html; charset=utf-8")
            return
        if p == "/missing.bin":
            self._send(404, b"nope", "text/plain")
            return
        if p == "/forbidden.bin":
            self._send(403, b"", "text/plain")
            return
        if p == "/flaky.bin":
            self._send(503, b"", "text/plain")
            return
        if p == "/nohead.bin" and self.command == "HEAD":
            self._send(405, b"")
            return
        if p == "/nohead.bin":
            self._send(206, b"\0", extra={"Content-Range": f"bytes 0-0/{FILE_SIZE}"})
            return
        if p == "/page-ok/":
            self._send(200, b"<html><h1>Bloodborne PS4</h1><p>CUSA00207</p></html>", "text/html")
            return
        if p == "/page-title/":
            self._send(200, "<html><h1>God of War Ragnarök - Download</h1></html>".encode("utf-8"), "text/html; charset=utf-8")
            return
        if p == "/page-parked/":
            self._send(200, b"<html>This domain is for sale</html>", "text/html")
            return
        if p == "/metadata/good-item":
            doc = {"metadata": {"identifier": "good-item"}, "files": [
                {"name": "Game.pkg", "size": str(FILE_SIZE), "md5": "a" * 32},
                {"name": "Other File.ffpfsc", "size": "999"},
            ]}
            self._send(200, json.dumps(doc).encode(), "application/json")
            return
        if p == "/metadata/empty-item":
            self._send(200, b"{}", "application/json")
            return
        if p == "/metadata/broken-item":
            self._send(500, b"", "text/plain")
            return
        self._send(404, b"not found", "text/plain")


def catalog_doc(base: str) -> dict:
    def rel(url, fmt="PKG", source="archive", size=0, md5=""):
        return {"id": "r-" + url.rsplit("/", 1)[-1].lower() or "x", "url": url, "sourceId": source, "format": fmt, "sizeBytes": size, "md5": md5,
                "titleId": "", "kind": "game", "verifiedAt": "", "mirrors": []}
    return {
        "sources": [{"id": "archive", "kind": "direct"}, {"id": "xeno", "kind": "direct"}, {"id": "dlpsgame", "kind": "page"}],
        "games": [
            {"id": "bloodborne-ps4", "title": "Bloodborne", "titleIds": ["CUSA00207"], "releases": [
                rel(f"{base}/file.bin", source="xeno", size=FILE_SIZE),
                rel(f"{base}/norange.bin", source="xeno"),
                rel(f"{base}/wrong.bin", source="xeno", size=1000),
                rel(f"{base}/html-file.bin", source="xeno"),
                rel(f"{base}/missing.bin", source="xeno"),
                rel(f"{base}/forbidden.bin", source="xeno"),
                rel(f"{base}/flaky.bin", source="xeno"),
                rel(f"{base}/nohead.bin", source="xeno", size=FILE_SIZE),
                rel(f"{base}/page-ok/", "PAGE", "dlpsgame"),
                rel(f"{base}/page-parked/", "PAGE", "dlpsgame"),
                rel("https://archive.org/download/good-item/Game.pkg", size=FILE_SIZE, md5="a" * 32),
                rel("https://archive.org/download/good-item/Other%20File.ffpfsc", "FFPFSC", size=5_000_000),
                rel("https://archive.org/download/good-item/Nope.pkg"),
                rel("https://archive.org/download/empty-item/Game.pkg"),
                rel("https://archive.org/download/broken-item/Game.pkg"),
            ]},
            {"id": "god-of-war-ragnarok-ps5", "title": "God of War Ragnarök", "titleIds": [], "releases": [
                rel(f"{base}/page-title/", "PAGE", "dlpsgame"),
            ]},
        ],
    }


class VerdictLogicTests(unittest.TestCase):
    def test_decide(self):
        now = "2026-10-13T00:00:00Z"
        self.assertEqual(audit.decide(None, audit.Outcome("ok", 206, 10), now)["verdict"], "ok")
        self.assertEqual(audit.decide(None, audit.Outcome("page", 200), now)["verdict"], "page")
        self.assertEqual(audit.decide(None, audit.Outcome("wrong_size", 206, 5), now)["verdict"], "dead")
        first = audit.decide(None, audit.Outcome("hard", 404), now)
        self.assertEqual((first["verdict"], first["failures"]), ("flaky", 1))
        second = audit.decide(first, audit.Outcome("hard", 404), now)
        self.assertEqual((second["verdict"], second["failures"]), ("dead", 2))
        soft = audit.decide(first, audit.Outcome("soft", 503), now)
        self.assertEqual((soft["verdict"], soft["failures"]), ("flaky", 1))      # a timeout never adds a strike
        back = audit.decide(second, audit.Outcome("ok", 206, 10), now)
        self.assertEqual((back["verdict"], back["failures"]), ("ok", 0))

    def test_needs_check(self):
        now = datetime(2026, 10, 13, tzinfo=timezone.utc)
        fresh = (now - timedelta(days=1)).isoformat().replace("+00:00", "Z")
        stale = (now - timedelta(days=8)).isoformat().replace("+00:00", "Z")
        self.assertTrue(audit.needs_check(None, 7, now))
        self.assertFalse(audit.needs_check({"verdict": "ok", "checkedAt": fresh}, 7, now))
        self.assertTrue(audit.needs_check({"verdict": "ok", "checkedAt": stale}, 7, now))
        self.assertTrue(audit.needs_check({"verdict": "flaky", "checkedAt": fresh}, 7, now))
        self.assertTrue(audit.needs_check({"verdict": "page", "checkedAt": fresh}, 7, now))
        self.assertFalse(audit.needs_check({"verdict": "dead", "checkedAt": stale}, 7, now))
        self.assertTrue(audit.needs_check({"verdict": "bogus", "checkedAt": fresh}, 7, now))

    def test_helpers(self):
        self.assertTrue(audit.size_matches(0, 5))
        self.assertTrue(audit.size_matches(1000, 1000 + 1024 * 1024))
        self.assertFalse(audit.size_matches(1000, 1000 + 1024 * 1024 + 1))
        self.assertTrue(audit.is_html("text/html; charset=utf-8"))
        self.assertFalse(audit.is_html("application/octet-stream"))
        self.assertTrue(audit.page_matches("<p>cusa00207</p>", "", ["CUSA00207"]))
        self.assertTrue(audit.page_matches("<h1>God of War Ragnarök (PS5)</h1>", "God of War Ragnarok", []))
        self.assertFalse(audit.page_matches("<h1>Domain for sale</h1>", "God of War Ragnarok", ["PPSA00001"]))
        self.assertFalse(audit.page_matches("anything", "", []))

    def test_plan_prioritizes_and_classifies(self):
        doc = catalog_doc("http://h.test")
        results = {"http://h.test/file.bin": {"verdict": "ok", "checkedAt": audit.utc_now_iso()},
                   "http://h.test/flaky.bin": {"verdict": "flaky", "checkedAt": audit.utc_now_iso()}}
        checks = audit.plan(doc, results, 7)
        urls = [c.url for c in checks]
        self.assertNotIn("http://h.test/file.bin", urls)            # fresh ok → skipped
        self.assertIn("http://h.test/flaky.bin", urls)
        self.assertEqual(urls[-1], "http://h.test/flaky.bin")        # re-checks after never-checked ones
        kinds = {c.url: c.kind for c in checks}
        self.assertEqual(kinds["http://h.test/page-ok/"], "page")
        self.assertEqual(kinds["http://h.test/norange.bin"], "direct")
        self.assertEqual(kinds["https://archive.org/download/good-item/Other%20File.ffpfsc"], "archive")
        arch = next(c for c in checks if c.url.endswith("Other%20File.ffpfsc"))
        self.assertEqual((arch.identifier, arch.name), ("good-item", "Other File.ffpfsc"))
        self.assertEqual(len(audit.plan(doc, {}, 7, limit=3)), 3)

    def test_prune_results(self):
        doc = {"games": [{"releases": [{"url": "https://keep/1"}]}]}
        old = (datetime.now(timezone.utc) - timedelta(days=90)).isoformat()
        results = {"https://keep/1": {"checkedAt": old}, "https://gone/1": {"checkedAt": old},
                   "https://gone/recent": {"checkedAt": audit.utc_now_iso()}}
        self.assertEqual(audit.prune_results(results, doc), 1)
        self.assertEqual(sorted(results), ["https://gone/recent", "https://keep/1"])


class LocalServerAuditTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.base = f"http://127.0.0.1:{cls.server.server_address[1]}"
        cls.tmp = Path(tempfile.mkdtemp(prefix="xeno-audit-"))

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def auditor(self):
        http = Http(min_interval=0.0)
        return audit.Auditor(http, timeout=5, archive_base=self.base + "/metadata/", log=lambda m: None)

    def test_probes_and_verdicts(self):
        doc = catalog_doc(self.base)
        results: dict = {}
        path = self.tmp / "results.json"
        checks = audit.plan(doc, results, 7)
        stats = audit.run_audit(self.auditor(), checks, results, concurrency=4, results_path=path, log=lambda m: None)
        self.assertEqual(stats["checked"], len(checks))
        v = {u.replace(self.base, ""): r["verdict"] for u, r in results.items()}
        self.assertEqual(v["/file.bin"], "ok")
        self.assertEqual(results[self.base + "/file.bin"]["size"], FILE_SIZE)
        self.assertEqual(v["/norange.bin"], "ok")                 # 200 without Range support is still a file
        self.assertEqual(v["/wrong.bin"], "dead")                 # size off by far more than 1 MiB
        self.assertEqual(v["/html-file.bin"], "page")
        self.assertEqual(v["/missing.bin"], "flaky")              # first 404: one strike
        self.assertEqual(results[self.base + "/missing.bin"]["failures"], 1)
        self.assertEqual(v["/forbidden.bin"], "flaky")
        self.assertEqual(v["/flaky.bin"], "flaky")
        self.assertEqual(results[self.base + "/flaky.bin"]["failures"], 0)
        self.assertEqual(v["/nohead.bin"], "ok")                  # HEAD 405 → the range GET decides
        self.assertEqual(v["/page-ok/"], "ok")
        self.assertEqual(v["/page-title/"], "ok")
        self.assertEqual(v["/page-parked/"], "flaky")
        self.assertEqual(v["https://archive.org/download/good-item/Game.pkg"], "ok")
        self.assertEqual(v["https://archive.org/download/good-item/Other%20File.ffpfsc"], "dead")   # wrong size
        self.assertEqual(v["https://archive.org/download/good-item/Nope.pkg"], "flaky")             # file not in item
        self.assertEqual(v["https://archive.org/download/empty-item/Game.pkg"], "flaky")
        self.assertEqual(v["https://archive.org/download/broken-item/Game.pkg"], "flaky")
        self.assertEqual(HITS.get("/metadata/good-item"), 1)      # one metadata call per item
        saved = json.loads(path.read_text(encoding="utf-8"))
        self.assertEqual(saved["version"], 1)
        self.assertEqual(saved["counts"]["ok"], sum(1 for r in results.values() if r["verdict"] == "ok"))
        self.assertEqual(audit.load_results(path).keys(), results.keys())
        self.assertTrue(audit.audited_at_of(path))

        # second run: hard failures become dead, fresh ok links are not re-checked
        checks2 = audit.plan(doc, results, 7)
        urls2 = {c.url for c in checks2}
        self.assertNotIn(self.base + "/file.bin", urls2)
        self.assertIn(self.base + "/missing.bin", urls2)
        audit.run_audit(self.auditor(), checks2, results, concurrency=4, log=lambda m: None)
        self.assertEqual(results[self.base + "/missing.bin"]["verdict"], "dead")
        self.assertEqual(results[self.base + "/forbidden.bin"]["verdict"], "dead")
        self.assertEqual(results[self.base + "/page-parked/"]["verdict"], "dead")
        self.assertEqual(results[self.base + "/flaky.bin"]["verdict"], "flaky")   # 503 twice is still only flaky

    def test_budget_stops_scheduling(self):
        doc = catalog_doc(self.base)
        results: dict = {}
        checks = audit.plan(doc, results, 7)
        stats = audit.run_audit(self.auditor(), checks, results, concurrency=1, budget_seconds=0.000001, log=lambda m: None)
        self.assertTrue(stats["budgetHit"])
        self.assertLess(stats["checked"], len(checks))

    def test_unreachable_host_is_soft(self):
        doc = {"sources": [{"id": "xeno", "kind": "direct"}],
               "games": [{"id": "g-ps4", "title": "G", "titleIds": [], "releases": [
                   {"url": "http://127.0.0.1:9/nothing.pkg", "sourceId": "xeno", "format": "PKG", "sizeBytes": 0}]}]}
        results: dict = {}
        audit.run_audit(self.auditor(), audit.plan(doc, results, 7), results, concurrency=1, log=lambda m: None)
        rec = results["http://127.0.0.1:9/nothing.pkg"]
        self.assertEqual((rec["verdict"], rec["failures"]), ("flaky", 0))

    def test_cli_main(self):
        cat_path = self.tmp / "cat.json"
        cat_path.write_text(json.dumps(catalog_doc(self.base)), encoding="utf-8")
        res_path = self.tmp / "cli-results.json"
        rc = audit.main(["--catalog", str(cat_path), "--results", str(res_path), "--limit", "3", "--quiet", "--timeout", "5"])
        self.assertEqual(rc, 0)
        self.assertEqual(len(audit.load_results(res_path)), 3)
        self.assertEqual(audit.main(["--catalog", str(self.tmp / "missing.json"), "--quiet"]), 2)


if __name__ == "__main__":
    unittest.main()
