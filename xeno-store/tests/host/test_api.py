#!/usr/bin/env python3
"""
test_api.py — endpoint tests for the host build (SPEC §14): status, settings
round trip, favorites/collections/recent, export/import, queue validation
errors (bad_release, root_unavailable, exists, no_space via XENO_FAKE_FREE),
storage, library scan/delete allowlist, PIN enforcement, static routes, CORS,
path safety and links/check against the range server.
"""
import json
import os
import shutil
import sys
import tempfile
import unittest
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness  # noqa: E402
import range_server  # noqa: E402

MiB = 1024 * 1024


class ApiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp(prefix="xeno-api-")
        cls.files_dir = os.path.join(cls.tmp, "files")
        cls.httpd, cls.rport = range_server.serve_in_thread(cls.files_dir)
        cls.rs = f"http://127.0.0.1:{cls.rport}"
        cls.data = os.path.join(cls.tmp, "data")
        cls.extra_root = os.path.join(cls.tmp, "usb0")
        os.makedirs(cls.extra_root)
        harness.write_catalog(cls.data, [
            harness.make_game("test-game-ps5", "Test Game", "PPSA01234", [
                harness.make_release("r-small", f"{cls.rs}/ok/small.bin", "PPSA01234 Test Game.ffpfsc", 8 * MiB),
            ]),
            harness.make_game("other-game-ps4", "Café Résumé Game", "CUSA05678", [
                harness.make_release("r-page", "https://example.invalid/page", "", 0, fmt="PAGE", title_id="CUSA05678", source="other"),
            ], platform="PS4"),
        ])
        cls.srv = harness.XenoServer(cls.data, roots=[cls.extra_root]).start()

    @classmethod
    def tearDownClass(cls):
        cls.srv.stop()
        cls.httpd.shutdown()
        shutil.rmtree(cls.tmp, ignore_errors=True)

    # ---- system ----------------------------------------------------------
    def test_status_shape(self):
        st, b = self.srv.api("GET", "/api/status")
        self.assertEqual(st, 200)
        for k in ("ok", "app", "version", "build", "platform", "fw", "ip", "port", "uptime", "downloadsAvailable",
                  "catalog", "queue", "storage", "update", "notices"):
            self.assertIn(k, b)
        self.assertEqual(b["app"], "XENO STORE")
        self.assertEqual(b["platform"], "host")
        self.assertEqual(b["port"], self.srv.port)
        self.assertEqual(b["catalog"]["source"], "cached")
        self.assertEqual(b["catalog"]["games"], 2)
        self.assertTrue(b["downloadsAvailable"])
        for k in ("active", "queued", "paused", "failed", "done", "speed", "remaining"):
            self.assertIn(k, b["queue"])
        self.assertEqual(len(b["storage"]), 2)

    def test_log_endpoint(self):
        st, b = self.srv.api("GET", "/api/log?lines=20")
        self.assertEqual(st, 200)
        self.assertTrue(b["ok"])
        self.assertLessEqual(len(b["lines"]), 20)
        self.assertTrue(any("listening" in ln for ln in b["lines"]))

    def test_toast(self):
        st, b = self.srv.api("POST", "/api/system/toast", {"text": "hello from tests"})
        self.assertEqual(st, 200)
        st, _ = self.srv.api("POST", "/api/system/toast", {})
        self.assertEqual(st, 400)

    def test_unknown_route_and_method(self):
        st, b = self.srv.api("GET", "/api/nope")
        self.assertEqual(st, 404)
        self.assertFalse(b["ok"])
        self.assertEqual(b["error"], "not_found")
        st, b = self.srv.api("DELETE", "/api/status")
        self.assertEqual(st, 405)
        st, b = self.srv.api("GET", "/nothing-here")
        self.assertEqual(st, 404)
        self.assertEqual(b["error"], "not_found")

    def test_bad_json_body(self):
        st, b = self.srv.api("PUT", "/api/settings", b"{not json")
        self.assertEqual(st, 400)
        self.assertEqual(b["error"], "bad_json")

    def test_body_limit(self):
        st, b = self.srv.api("POST", "/api/system/toast", b"x" * (1 * MiB + 1))
        self.assertEqual(st, 413)
        self.assertEqual(b["error"], "body_too_large")
        st, b = self.srv.api("GET", "/api/status")   # server still healthy afterwards
        self.assertEqual(st, 200)

    def test_path_traversal_rejected(self):
        st, _, raw = self.srv.raw("GET", "/../etc/passwd")
        self.assertEqual(st, 400)
        st, _, raw = self.srv.raw("GET", "/i18n/%2e%2e/x.json")
        self.assertEqual(st, 400)
        st, _, raw = self.srv.raw("GET", "/api/%00")
        self.assertEqual(st, 400)

    def test_cors_preflight(self):
        st, hdrs, _ = self.srv.raw("OPTIONS", "/api/queue")
        self.assertEqual(st, 204)
        self.assertEqual(hdrs.get("Access-Control-Allow-Origin"), "*")
        self.assertIn("PUT", hdrs.get("Access-Control-Allow-Methods", ""))

    # ---- static -----------------------------------------------------------
    def test_index_gzip_and_etag(self):
        st, hdrs, raw = self.srv.raw("GET", "/")
        self.assertEqual(st, 200)
        self.assertTrue(hdrs["Content-Type"].startswith("text/html"))
        self.assertEqual(int(hdrs["Content-Length"]), len(raw))
        etag = hdrs["ETag"]
        st, hdrs2, raw2 = self.srv.raw("GET", "/", headers={"Accept-Encoding": "gzip"})
        self.assertEqual(hdrs2.get("Content-Encoding"), "gzip")
        self.assertLess(len(raw2), len(raw))
        st, _, raw3 = self.srv.raw("GET", "/index.html", headers={"If-None-Match": etag})
        self.assertEqual(st, 304)
        self.assertEqual(raw3, b"")

    def test_catalog_json_route(self):
        st, hdrs, raw = self.srv.raw("GET", "/catalog.json")
        self.assertEqual(st, 200)
        doc = json.loads(raw)
        self.assertEqual(doc["revision"], 2000000000)
        st, _, _ = self.srv.raw("GET", "/catalog.json", headers={"If-None-Match": hdrs["ETag"]})
        self.assertEqual(st, 304)

    def test_other_static(self):
        for path, ctype in (("/logo.jpg", "image/jpeg"), ("/icon.png", "image/png"),
                            ("/manifest.webmanifest", "application/manifest+json"), ("/i18n/en.json", "application/json")):
            st, hdrs, raw = self.srv.raw("GET", path)
            self.assertEqual(st, 200, path)
            self.assertTrue(hdrs["Content-Type"].startswith(ctype), path)
            self.assertGreater(len(raw), 0)
        st, _, _ = self.srv.raw("GET", "/i18n/zz-nope.json")
        self.assertEqual(st, 404)

    def test_pkgsrv_unknown_token(self):
        st, b = self.srv.api("GET", "/pkgsrv/doesnotexist")
        self.assertEqual(st, 404)

    # ---- catalog ----------------------------------------------------------
    def test_catalog_info_and_search(self):
        st, b = self.srv.api("GET", "/api/catalog/info")
        self.assertEqual(st, 200)
        self.assertEqual(b["revision"], 2000000000)
        self.assertEqual(b["games"], 2)
        self.assertEqual(b["releases"], 2)
        self.assertEqual(b["cachedRevision"], 2000000000)
        st, b = self.srv.api("GET", "/api/catalog/search?q=test%20game")
        self.assertEqual([g["id"] for g in b["items"]], ["test-game-ps5"])
        st, b = self.srv.api("GET", "/api/catalog/search?q=cafe%20resume")   # accent-insensitive
        self.assertEqual([g["id"] for g in b["items"]], ["other-game-ps4"])
        st, b = self.srv.api("GET", "/api/catalog/search?q=ppsa01234")        # title id
        self.assertEqual([g["id"] for g in b["items"]], ["test-game-ps5"])
        st, b = self.srv.api("GET", "/api/catalog/search?q=xeno&platform=PS4")  # publisher + platform filter
        self.assertEqual([g["id"] for g in b["items"]], ["other-game-ps4"])
        st, b = self.srv.api("GET", "/api/catalog/search?q=&limit=1")
        self.assertEqual(len(b["items"]), 1)

    def test_links_check(self):
        st, b = self.srv.api("POST", "/api/links/check", {"urls": [f"{self.rs}/ok/small.bin", f"{self.rs}/f404/small.bin"]})
        self.assertEqual(st, 200)
        r = {x["url"]: x for x in b["results"]}
        ok = r[f"{self.rs}/ok/small.bin"]
        self.assertEqual(ok["status"], 206)
        self.assertEqual(ok["size"], 8 * MiB)
        self.assertTrue(ok["acceptRanges"])
        self.assertGreaterEqual(ok["ms"], 0)
        self.assertEqual(r[f"{self.rs}/f404/small.bin"]["status"], 404)
        st, b = self.srv.api("POST", "/api/links/check", {"urls": "nope"})
        self.assertEqual(st, 400)

    def test_links_resolve_allowlist(self):
        st, b = self.srv.api("POST", "/api/links/resolve", {"url": f"{self.rs}/ok/small.bin"})
        self.assertEqual(st, 200)
        self.assertEqual(b["links"], [])
        self.assertFalse(b["allowed"])
        st, b = self.srv.api("POST", "/api/links/resolve", {"url": "ftp://x"})
        self.assertEqual(st, 400)

    # ---- settings / favorites / collections / recent ----------------------
    def test_settings_roundtrip_and_validation(self):
        st, b = self.srv.api("GET", "/api/settings")
        self.assertEqual(st, 200)
        s = b["settings"]
        self.assertEqual(s["v"], 1)
        self.assertEqual(s["general"]["theme"], "xeno-gold")
        self.assertEqual(s["downloads"]["connections"], 8)
        self.assertEqual(s["downloads"]["concurrentJobs"], 1)
        self.assertTrue(s["sources"]["enabled"]["archive"])
        self.assertIn("raw.githubusercontent.com", s["catalog"]["url"])
        st, b = self.srv.api("PUT", "/api/settings", {"downloads": {"connections": 99, "maxBytesPerSec": 1234}, "general": {"theme": "oled"}})
        self.assertEqual(st, 200)
        s = b["settings"]
        self.assertEqual(s["downloads"]["connections"], 16)        # clamped
        self.assertEqual(s["downloads"]["maxBytesPerSec"], 1234)
        self.assertEqual(s["general"]["theme"], "oled")
        self.assertEqual(s["downloads"]["concurrentJobs"], 1)       # untouched by the partial merge
        st, b = self.srv.api("PUT", "/api/settings", {"general": {"theme": "neon"}})
        self.assertEqual(st, 400)
        self.assertEqual(b["error"], "invalid_settings")
        st, b = self.srv.api("PUT", "/api/settings", {"downloads": {"scheduleStart": "25:99"}})
        self.assertEqual(st, 400)
        with open(os.path.join(self.data, "settings.json")) as f:
            on_disk = json.load(f)
        self.assertEqual(on_disk["general"]["theme"], "oled")
        self.srv.api("PUT", "/api/settings", {"downloads": {"connections": 8, "maxBytesPerSec": 0}, "general": {"theme": "xeno-gold"}})

    def test_favorites(self):
        self.srv.api("PUT", "/api/favorites", {"ids": []})
        st, b = self.srv.api("POST", "/api/favorites/toggle", {"id": "test-game-ps5"})
        self.assertEqual(st, 200)
        self.assertTrue(b["favorite"])
        st, b = self.srv.api("GET", "/api/favorites")
        self.assertEqual(b["ids"], ["test-game-ps5"])
        st, b = self.srv.api("POST", "/api/favorites/toggle", {"id": "test-game-ps5"})
        self.assertFalse(b["favorite"])
        st, b = self.srv.api("PUT", "/api/favorites", {"ids": ["a", "b", "a"]})
        self.assertEqual(b["ids"], ["a", "b"])
        with open(os.path.join(self.data, "favorites.json")) as f:
            self.assertEqual(json.load(f)["ids"], ["a", "b"])

    def test_collections_and_recent(self):
        st, b = self.srv.api("GET", "/api/collections")
        self.assertEqual(b["collections"][0]["id"], "wishlist")
        st, b = self.srv.api("PUT", "/api/collections", {"collections": [{"id": "fav", "name": "Favs", "icon": "star", "ids": ["x"]}]})
        self.assertEqual(st, 200)
        self.assertEqual(b["collections"][0]["ids"], ["x"])
        for i in range(35):
            self.srv.api("POST", "/api/recent", {"id": f"g{i}"})
        st, b = self.srv.api("GET", "/api/recent")
        self.assertEqual(len(b["ids"]), 30)
        self.assertEqual(b["ids"][0], "g34")

    def test_export_import(self):
        st, b = self.srv.api("GET", "/api/export")
        self.assertEqual(st, 200)
        for k in ("settings", "favorites", "collections", "recent"):
            self.assertIn(k, b)
        b["favorites"] = ["imported-1"]
        b["settings"]["general"]["cardSize"] = "l"
        st, b2 = self.srv.api("POST", "/api/import", b)
        self.assertEqual(st, 200)
        st, f = self.srv.api("GET", "/api/favorites")
        self.assertEqual(f["ids"], ["imported-1"])
        st, s = self.srv.api("GET", "/api/settings")
        self.assertEqual(s["settings"]["general"]["cardSize"], "l")
        st, _ = self.srv.api("POST", "/api/import", [1, 2])
        self.assertEqual(st, 400)

    def test_pin_enforcement(self):
        st, b = self.srv.api("PUT", "/api/settings", {"pairing": {"pin": "1234"}})
        self.assertEqual(st, 200)
        try:
            st, b = self.srv.api("POST", "/api/recent", {"id": "x"})
            self.assertEqual(st, 401)
            self.assertEqual(b["error"], "pin_required")
            st, b = self.srv.api("GET", "/api/recent")          # reads stay open
            self.assertEqual(st, 200)
            st, b = self.srv.api("GET", "/api/pair")
            self.assertTrue(b["pinRequired"])
            st, b = self.srv.api("POST", "/api/recent", {"id": "x"}, headers={"X-XENO-PIN": "1234"})
            self.assertEqual(st, 200)
            st, b = self.srv.api("PUT", "/api/settings", {"pairing": {"pin": "12"}}, headers={"X-XENO-PIN": "1234"})
            self.assertEqual(st, 400)
        finally:
            self.srv.api("PUT", "/api/settings", {"pairing": {"pin": ""}}, headers={"X-XENO-PIN": "1234"})

    def test_pair(self):
        st, b = self.srv.api("GET", "/api/pair")
        self.assertEqual(st, 200)
        self.assertTrue(b["url"].startswith("http://"))
        self.assertTrue(b["url"].endswith(f":{self.srv.port}/"))

    # ---- storage / library --------------------------------------------------
    def test_storage_and_default(self):
        st, b = self.srv.api("GET", "/api/storage")
        roots = {r["path"]: r for r in b["roots"]}
        self.assertIn(self.srv.default_root, roots)
        self.assertIn(self.extra_root, roots)
        self.assertTrue(roots[self.srv.default_root]["default"])
        self.assertTrue(all(r["writable"] for r in b["roots"]))
        self.assertTrue(all(r["free"] > 0 and r["total"] > 0 for r in b["roots"]))
        st, b = self.srv.api("POST", "/api/storage/default", {"root": self.extra_root})
        self.assertEqual(st, 200)
        st, b = self.srv.api("GET", "/api/storage")
        self.assertTrue({r["path"]: r for r in b["roots"]}[self.extra_root]["default"])
        st, b = self.srv.api("POST", "/api/storage/default", {"root": "/nope"})
        self.assertEqual(st, 422)
        self.srv.api("POST", "/api/storage/default", {"root": self.srv.default_root})

    def test_space(self):
        st, b = self.srv.api("GET", f"/api/space?root={urllib.request.quote(self.extra_root)}&bytes=1024")
        self.assertEqual(st, 200)
        self.assertEqual(b["root"], self.extra_root)
        self.assertTrue(b["fits"])
        self.assertEqual(b["afterThis"], b["afterQueue"] - 1024)
        st, b = self.srv.api("GET", "/api/space?root=/nope")
        self.assertEqual(st, 422)

    def test_library_scan_and_delete(self):
        hb = os.path.join(self.extra_root, "homebrew")
        files = os.path.join(self.extra_root, "xeno-store", "files")
        os.makedirs(hb, exist_ok=True)
        os.makedirs(files, exist_ok=True)
        p1 = os.path.join(hb, "PPSA01234 Test Game.ffpfsc")
        p2 = os.path.join(files, "archive.zip")
        p3 = os.path.join(files, "notes.txt")
        for p in (p1, p2, p3):
            with open(p, "wb") as f:
                f.write(b"x" * 1000)
        os.makedirs(os.path.join(self.data, "user", "app", "PPSA01234"), exist_ok=True)
        st, b = self.srv.api("GET", "/api/library?scan=1")
        self.assertEqual(st, 200)
        byname = {f["path"]: f for f in b["files"]}
        self.assertIn(p1, byname)
        self.assertIn(p2, byname)
        self.assertNotIn(p3, byname)
        self.assertEqual(byname[p1]["titleId"], "PPSA01234")
        self.assertEqual(byname[p1]["gameId"], "test-game-ps5")
        self.assertEqual(byname[p1]["format"], "FFPFSC")
        self.assertEqual(byname[p1]["root"], self.extra_root)
        self.assertFalse(byname[p1]["partial"])
        self.assertEqual(byname[p2]["format"], "ZIP")
        inst = {i["titleId"]: i for i in b["installed"]}
        self.assertIn("PPSA01234", inst)
        self.assertEqual(inst["PPSA01234"]["gameId"], "test-game-ps5")
        self.assertGreater(b["scannedAt"], 0)
        st, b = self.srv.api("POST", "/api/library/delete", {"path": p3})
        self.assertEqual(st, 403)
        self.assertTrue(os.path.exists(p3))
        st, b = self.srv.api("POST", "/api/library/delete", {"path": p2})
        self.assertEqual(st, 200)
        self.assertFalse(os.path.exists(p2))
        st, b = self.srv.api("POST", "/api/library/install", {"path": p1})
        self.assertEqual(st, 422)   # not a PKG

    def test_shadowmount_scan_unavailable(self):
        st, b = self.srv.api("POST", "/api/shadowmount/scan")
        self.assertEqual(st, 200)
        self.assertFalse(b["available"])

    # ---- queue validation -----------------------------------------------------
    def test_queue_validation_errors(self):
        st, b = self.srv.api("POST", "/api/queue", {"gameId": "nope", "releaseId": "r-small"})
        self.assertEqual(st, 404)
        self.assertEqual(b["error"], "bad_release")
        st, b = self.srv.api("POST", "/api/queue", {"gameId": "other-game-ps4", "releaseId": "r-page"})
        self.assertEqual(b["error"], "bad_release")
        st, b = self.srv.api("POST", "/api/queue", {})
        self.assertEqual(b["error"], "bad_release")
        st, b = self.srv.api("POST", "/api/queue", {"url": "ftp://x/y.bin", "filename": "y.bin"})
        self.assertEqual(b["error"], "bad_request")
        st, b = self.srv.api("POST", "/api/queue", {"url": "http://user:pw@127.0.0.1/y.bin", "filename": "y.bin"})
        self.assertEqual(b["error"], "bad_request")
        st, b = self.srv.api("POST", "/api/queue", {"gameId": "test-game-ps5", "releaseId": "r-small", "root": "/nope"})
        self.assertEqual(st, 422)
        self.assertEqual(b["error"], "root_unavailable")
        st, b = self.srv.api("POST", "/api/queue", {"url": f"{self.rs}/ok/small.bin", "filename": "../../evil.bin", "format": "BIN"})
        self.assertEqual(st, 200)
        self.assertTrue(b["job"]["path"].endswith("/xeno-store/files/evil.bin"))
        jid = b["job"]["id"]
        st, b = self.srv.api("POST", "/api/queue", {"url": f"{self.rs}/ok/small.bin", "filename": "evil.bin", "format": "BIN"})
        self.assertEqual(st, 409)
        self.assertEqual(b["error"], "exists")
        self.srv.wait_job(jid, "done", timeout=60)
        st, b = self.srv.api("POST", "/api/queue", {"url": f"{self.rs}/ok/small.bin", "filename": "evil.bin", "format": "BIN"})
        self.assertEqual(b["error"], "exists")   # final file present
        st, b = self.srv.api("POST", "/api/queue", {"url": f"{self.rs}/ok/small.bin", "filename": "evil.bin", "format": "BIN", "overwrite": True})
        self.assertEqual(st, 200)
        self.srv.wait_job(b["job"]["id"], "done", timeout=60)
        st, b = self.srv.api("POST", "/api/queue/nope/pause")
        self.assertEqual(st, 404)
        st, b = self.srv.api("POST", "/api/queue/clear", {"states": ["done"]})
        self.assertEqual(st, 200)
        self.assertGreaterEqual(b["removed"], 1)

    def test_no_space_with_fake_free(self):
        data = os.path.join(self.tmp, "data-nospace")
        harness.write_catalog(data, [
            harness.make_game("big-game-ps5", "Big Game", "PPSA09999", [
                harness.make_release("r-big", f"{self.rs}/ok/big.bin", "big.ffpfsc", 64 * MiB, title_id="PPSA09999"),
            ]),
        ])
        srv = harness.XenoServer(data, env={"XENO_FAKE_FREE": str(100 * MiB)}).start()
        try:
            st, b = srv.api("POST", "/api/queue", {"gameId": "big-game-ps5", "releaseId": "r-big"})
            self.assertEqual(st, 422)
            self.assertEqual(b["error"], "no_space")
            st, b = srv.api("GET", "/api/space?bytes=%d" % (64 * MiB))
            self.assertFalse(b["fits"])
            self.assertEqual(b["free"], 100 * MiB)
            st, b = srv.api("POST", "/api/queue", {"url": f"{self.rs}/ok/big.bin", "filename": "big.bin", "format": "BIN", "size": 64 * MiB})
            self.assertEqual(b["error"], "no_space")
        finally:
            srv.stop()


if __name__ == "__main__":
    unittest.main(verbosity=2)
