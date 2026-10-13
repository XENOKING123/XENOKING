#!/usr/bin/env python3
"""
test_downloads.py — download engine tests against range_server.py (SPEC §14):
segmented integrity (sha256), pause/resume, cancel+restart, mirror failover,
provider_page, source_changed (validator and tail-check variants), hash
mismatch + verified hash, retry on 429/Retry-After, connection drops,
sequential (no Range) servers, PKG auto-install simulation, queue
persistence across a restart, bandwidth limit, link replacement, move/clear.
"""
import json
import os
import shutil
import sys
import tempfile
import time
import unittest
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness  # noqa: E402
import range_server  # noqa: E402

MiB = 1024 * 1024


def ctl(rs, cmd):
    with urllib.request.urlopen(f"{rs}/ctl/{cmd}", timeout=10) as r:
        return json.loads(r.read())


class DownloadTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp(prefix="xeno-dl-")
        cls.files_dir = os.path.join(cls.tmp, "files")
        cls.httpd, cls.rport = range_server.serve_in_thread(cls.files_dir)
        cls.rs = f"http://127.0.0.1:{cls.rport}"
        cls.data = os.path.join(cls.tmp, "data")
        cls.sha = {n: ctl(cls.rs, f"sha256/{n}")["sha256"] for n in ("big.bin", "mid.bin", "small.bin", "tiny.pkg", "flipA.bin", "flipB.bin")}
        rs = cls.rs
        games = [
            harness.make_game("seg-ps5", "Segmented Game", "PPSA00001", [
                harness.make_release("r", f"{rs}/ok/big.bin", "PPSA00001 Segmented.ffpfsc", 64 * MiB, sha256=cls.sha["big.bin"], title_id="PPSA00001")]),
            harness.make_game("mirror-ps5", "Mirror Game", "PPSA00002", [
                harness.make_release("r", f"{rs}/f404/big.bin", "PPSA00002 Mirror.ffpfsc", 64 * MiB, sha256=cls.sha["big.bin"],
                                     mirrors=[f"{rs}/f403/big.bin", f"{rs}/ok/big.bin"], title_id="PPSA00002")]),
            harness.make_game("html-ps5", "Page Game", "PPSA00003", [
                harness.make_release("r", f"{rs}/html/big.bin", "PPSA00003 Page.ffpfsc", 64 * MiB, title_id="PPSA00003")]),
            harness.make_game("badhash-ps5", "Bad Hash Game", "PPSA00004", [
                harness.make_release("r", f"{rs}/ok/small.bin", "PPSA00004 BadHash.ffpfsc", 8 * MiB, sha256="0" * 64, title_id="PPSA00004")]),
            harness.make_game("pkg-ps5", "PKG Game", "PPSA01234", [
                harness.make_release("r", f"{rs}/ok/tiny.pkg", "PPSA01234 Game.pkg", 2 * MiB, fmt="PKG", sha256=cls.sha["tiny.pkg"])]),
            harness.make_game("r429-ps5", "Rate Limited Game", "PPSA00006", [
                harness.make_release("r", f"{rs}/r429/small.bin", "PPSA00006 Rate.ffpfsc", 8 * MiB, sha256=cls.sha["small.bin"], title_id="PPSA00006")]),
            harness.make_game("drop-ps5", "Dropping Game", "PPSA00007", [
                harness.make_release("r", f"{rs}/drop/big.bin", "PPSA00007 Drop.ffpfsc", 64 * MiB, sha256=cls.sha["big.bin"], title_id="PPSA00007")]),
            harness.make_game("norange-ps5", "Sequential Game", "PPSA00008", [
                harness.make_release("r", f"{rs}/norange/small.bin", "PPSA00008 Seq.ffpfsc", 8 * MiB, sha256=cls.sha["small.bin"], title_id="PPSA00008")]),
            harness.make_game("slow-ps5", "Slow Game", "PPSA00009", [
                harness.make_release("r", f"{rs}/slow/big.bin", "PPSA00009 Slow.ffpfsc", 64 * MiB, sha256=cls.sha["big.bin"], title_id="PPSA00009")]),
            harness.make_game("noetag-ps5", "No Validator Game", "PPSA00010", [
                harness.make_release("r", f"{rs}/noetag,slow/flipB.bin", "PPSA00010 NoEtag.ffpfsc", 8 * MiB, title_id="PPSA00010")]),
            harness.make_game("changed-ps5", "Changing Game", "PPSA00011", [
                harness.make_release("r", f"{rs}/slow/flipA.bin", "PPSA00011 Changing.ffpfsc", 32 * MiB, title_id="PPSA00011")]),
            harness.make_game("restart-ps5", "Restart Game", "PPSA00012", [
                harness.make_release("r", f"{rs}/slow/mid.bin", "PPSA00012 Restart.ffpfsc", 32 * MiB, sha256=cls.sha["mid.bin"], title_id="PPSA00012")]),
            harness.make_game("persist-ps5", "Persist Game", "PPSA00013", [
                harness.make_release("r", f"{rs}/slow/mid.bin", "PPSA00013 Persist.ffpfsc", 32 * MiB, sha256=cls.sha["mid.bin"], title_id="PPSA00013")]),
            harness.make_game("bw-ps5", "Bandwidth Game", "PPSA00014", [
                harness.make_release("r", f"{rs}/ok/big.bin", "PPSA00014 Bandwidth.ffpfsc", 64 * MiB, sha256=cls.sha["big.bin"], title_id="PPSA00014")]),
            harness.make_game("relink-ps5", "Relink Game", "PPSA00015", [
                harness.make_release("r", f"{rs}/f404/small.bin", "PPSA00015 Relink.ffpfsc", 8 * MiB, sha256=cls.sha["small.bin"], title_id="PPSA00015")]),
            harness.make_game("lm-ps5", "Last-Modified Game", "PPSA00016", [
                harness.make_release("r", f"{rs}/lm/mid.bin", "PPSA00016 LM.ffpfsc", 32 * MiB, sha256=cls.sha["mid.bin"], title_id="PPSA00016")]),
        ]
        harness.write_catalog(cls.data, games)
        cls.srv = harness.XenoServer(cls.data).start()
        cls.root = cls.srv.default_root

    @classmethod
    def tearDownClass(cls):
        cls.srv.stop()
        cls.httpd.shutdown()
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def setUp(self):
        ctl(self.rs, "reset")
        self.srv.api("PUT", "/api/settings", {"downloads": {"maxBytesPerSec": 0, "concurrentJobs": 1, "connections": 8}})

    def assert_clean_final(self, job, expected_sha):
        self.assertTrue(os.path.exists(job["path"]), job["path"])
        self.assertFalse(os.path.exists(job["path"] + ".xpart"))
        self.assertFalse(os.path.exists(job["path"] + ".xpart.json"))
        self.assertEqual(harness.sha256_file(job["path"]), expected_sha)

    def wait_written(self, jid, min_bytes, timeout=30):
        return self.srv.wait_job(jid, None, timeout=timeout,
                                 until=lambda j: j["state"] == "downloading" and j["written"] >= min_bytes)

    # ------------------------------------------------------------------------
    def test_01_segmented_integrity(self):
        job = self.srv.add(gameId="seg-ps5", releaseId="r", connections=8)
        self.assertEqual(job["state"], "queued")
        self.assertEqual(job["title"], "Segmented Game")
        self.assertEqual(job["format"], "FFPFSC")
        self.assertTrue(job["path"].endswith("/homebrew/PPSA00001 Segmented.ffpfsc"))
        self.assertEqual(job["verify"], "sha256")
        self.assertEqual(job["total"], 64 * MiB)
        j = self.srv.wait_job(job["id"], "done", timeout=90)
        self.assertTrue(j["verified"])
        self.assertEqual(j["sha256"], self.sha["big.bin"])
        self.assertEqual(j["written"], 64 * MiB)
        self.assert_clean_final(j, self.sha["big.bin"])
        stats = ctl(self.rs, "stats")
        self.assertGreaterEqual(stats["maxConcurrent"].get("big.bin", 0), 2, "download was not segmented")
        self.assertGreaterEqual(j["finishedAt"], j["startedAt"])
        st, lg = self.srv.api("GET", f"/api/queue/{job['id']}/log")
        self.assertTrue(any("segmented" in ln for ln in lg["lines"]))
        st, q = self.srv.api("GET", "/api/queue?history=1")
        me = [x for x in q["jobs"] if x["id"] == job["id"]][0]
        self.assertIn("speedHistory", me)
        self.assertEqual(q["summary"]["done"], 1)

    def test_02_pause_resume(self):
        job = self.srv.add(gameId="slow-ps5", releaseId="r")
        jid = job["id"]
        self.wait_written(jid, 2 * MiB)
        st, b = self.srv.action(jid, "pause")
        self.assertEqual(st, 200)
        self.assertEqual(b["job"]["state"], "paused")
        time.sleep(1.5)
        j = self.srv.job(jid)
        self.assertEqual(j["state"], "paused")
        self.assertTrue(os.path.exists(job["path"] + ".xpart"))
        self.assertTrue(os.path.exists(job["path"] + ".xpart.json"))
        with open(job["path"] + ".xpart.json") as f:
            sc = json.load(f)
        self.assertEqual(sc["v"], 1)
        self.assertEqual(sc["total"], 64 * MiB)
        self.assertTrue(sc["etag"])
        self.assertGreater(len(sc["done"]), 0)
        written_before = j["written"]
        self.assertGreater(written_before, 0)
        st, b = self.srv.action(jid, "resume")
        self.assertEqual(st, 200)
        self.assertEqual(b["job"]["state"], "queued")
        j = self.srv.wait_job(jid, "done", timeout=120)
        self.assert_clean_final(j, self.sha["big.bin"])
        st, lg = self.srv.api("GET", f"/api/queue/{jid}/log")
        self.assertTrue(any("resuming with" in ln for ln in lg["lines"]), lg["lines"])

    def test_03_cancel_and_restart(self):
        job = self.srv.add(gameId="restart-ps5", releaseId="r")
        jid = job["id"]
        self.wait_written(jid, 1 * MiB)
        st, b = self.srv.action(jid, "cancel")
        self.assertEqual(b["job"]["state"], "cancelled")
        time.sleep(1.0)
        self.assertTrue(os.path.exists(job["path"] + ".xpart"), "partial should be kept on cancel")
        st, b = self.srv.action(jid, "restart")
        self.assertEqual(st, 200)
        j = self.srv.wait_job(jid, "done", timeout=120)
        self.assertEqual(j["attempts"], 1)
        self.assert_clean_final(j, self.sha["mid.bin"])

    def test_04_mirror_failover(self):
        job = self.srv.add(gameId="mirror-ps5", releaseId="r")
        j = self.srv.wait_job(job["id"], "done", timeout=90)
        self.assertEqual(j["activeUrl"], f"{self.rs}/ok/big.bin")
        self.assertEqual(j["mirrorIndex"], 1)
        self.assertEqual(j["url"], f"{self.rs}/f404/big.bin")
        self.assert_clean_final(j, self.sha["big.bin"])
        st, lg = self.srv.api("GET", f"/api/queue/{job['id']}/log")
        text = "\n".join(lg["lines"])
        self.assertIn("http_404", text)
        self.assertIn("http_403", text)
        self.assertIn("mirror", text)

    def test_05_provider_page(self):
        job = self.srv.add(gameId="html-ps5", releaseId="r")
        j = self.srv.wait_job(job["id"], "failed", timeout=60)
        self.assertEqual(j["errorCode"], "provider_page")
        self.assertIn("web page", j["message"])

    def test_06_hash_mismatch_keeps_partial(self):
        job = self.srv.add(gameId="badhash-ps5", releaseId="r")
        j = self.srv.wait_job(job["id"], "failed", timeout=60)
        self.assertEqual(j["errorCode"], "hash_mismatch")
        self.assertFalse(j["verified"])
        self.assertEqual(j["sha256"], self.sha["small.bin"])
        self.assertTrue(os.path.exists(job["path"] + ".xpart"))
        self.assertFalse(os.path.exists(job["path"]))

    def test_07_retry_after_429(self):
        job = self.srv.add(gameId="r429-ps5", releaseId="r")
        jid = job["id"]
        j = self.srv.wait_job(jid, None, timeout=30, until=lambda x: x["nextRetryAt"] > 0 or x["state"] == "done")
        if j["state"] != "done":
            self.assertEqual(j["state"], "queued")
            self.assertEqual(j["errorCode"], "http_429")
            self.assertIn("Retrying", j["message"])
        j = self.srv.wait_job(jid, "done", timeout=60)
        self.assertGreaterEqual(j["attempts"], 2)
        self.assert_clean_final(j, self.sha["small.bin"])

    def test_08_connection_drops_recover(self):
        job = self.srv.add(gameId="drop-ps5", releaseId="r")
        j = self.srv.wait_job(job["id"], "done", timeout=120)
        self.assert_clean_final(j, self.sha["big.bin"])
        st, lg = self.srv.api("GET", f"/api/queue/{job['id']}/log")
        self.assertTrue(any("transient network" in ln for ln in lg["lines"]), lg["lines"])

    def test_09_sequential_no_range(self):
        job = self.srv.add(gameId="norange-ps5", releaseId="r")
        j = self.srv.wait_job(job["id"], "done", timeout=60)
        self.assertFalse(j["segmented"])
        self.assert_clean_final(j, self.sha["small.bin"])
        stats = ctl(self.rs, "stats")
        self.assertEqual(stats["maxConcurrent"].get("small.bin", 0), 1)

    def test_10_pkg_auto_install_simulation(self):
        job = self.srv.add(gameId="pkg-ps5", releaseId="r", autoInstall=True)
        self.assertTrue(job["path"].endswith("/xeno-store/pkg/PPSA01234 Game.pkg"))
        j = self.srv.wait_job(job["id"], "installed", timeout=60)
        self.assertEqual(j["install"]["state"], "installed")
        self.assertEqual(j["install"]["contentId"], "UP0001-PPSA01234_00-XENOTESTPKG00000")
        self.assertEqual(j["install"]["titleId"], "PPSA01234")
        self.assertTrue(os.path.isdir(os.path.join(self.data, "user", "app", "PPSA01234")))
        self.assertTrue(os.path.exists(j["path"]))
        self.assertEqual(harness.sha256_file(j["path"]), self.sha["tiny.pkg"])
        st, lib = self.srv.api("GET", "/api/library?scan=1")
        self.assertIn("PPSA01234", [i["titleId"] for i in lib["installed"]])
        pk = [f for f in lib["files"] if f["path"] == j["path"]]
        self.assertEqual(len(pk), 1)
        self.assertEqual(pk[0]["jobId"], job["id"])
        st, b = self.srv.api("POST", "/api/library/install", {"path": j["path"]})
        self.assertEqual(st, 200)
        self.assertEqual(b["job"]["state"], "installing")
        self.assertTrue(b["job"]["synthetic"])
        j2 = self.srv.wait_job(b["job"]["id"], "installed", timeout=30)
        self.assertEqual(j2["title"], "PKG Game")

    def test_11_source_changed_with_validator(self):
        job = self.srv.add(gameId="changed-ps5", releaseId="r")
        jid = job["id"]
        self.wait_written(jid, 2 * MiB)
        self.srv.action(jid, "pause")
        time.sleep(1.0)
        new_sha = ctl(self.rs, "flip/flipA.bin")["sha256"]
        self.srv.action(jid, "resume")
        j = self.srv.wait_job(jid, "failed", timeout=60)
        self.assertEqual(j["errorCode"], "source_changed")
        self.assertTrue(os.path.exists(job["path"] + ".xpart"))
        st, b = self.srv.action(jid, "restart")
        self.assertEqual(st, 200)
        j = self.srv.wait_job(jid, "done", timeout=120)
        self.assert_clean_final(j, new_sha)
        self.sha["flipA.bin"] = new_sha

    def test_12_source_changed_tail_check(self):
        job = self.srv.add(gameId="noetag-ps5", releaseId="r")
        jid = job["id"]
        self.wait_written(jid, 1 * MiB)
        self.srv.action(jid, "pause")
        time.sleep(1.0)
        with open(job["path"] + ".xpart.json") as f:
            sc = json.load(f)
        self.assertEqual(sc["etag"], "")
        self.assertEqual(sc["lastModified"], "")
        new_sha = ctl(self.rs, "flip/flipB.bin")["sha256"]
        self.srv.action(jid, "resume")
        j = self.srv.wait_job(jid, "failed", timeout=60)
        self.assertEqual(j["errorCode"], "source_changed")
        self.sha["flipB.bin"] = new_sha
        self.srv.action(jid, "remove", {"deleteFiles": True})
        self.assertFalse(os.path.exists(job["path"] + ".xpart"))

    def test_13_resume_passes_tail_check_when_unchanged(self):
        job = self.srv.add(gameId="noetag-ps5", releaseId="r")
        jid = job["id"]
        self.wait_written(jid, 1 * MiB)
        self.srv.action(jid, "pause")
        time.sleep(1.0)
        self.srv.action(jid, "resume")
        j = self.srv.wait_job(jid, "done", timeout=90)
        self.assert_clean_final(j, self.sha["flipB.bin"])
        st, lg = self.srv.api("GET", f"/api/queue/{jid}/log")
        self.assertTrue(any("tail check passed" in ln for ln in lg["lines"]), lg["lines"])

    def test_14_last_modified_only_resume(self):
        job = self.srv.add(gameId="lm-ps5", releaseId="r")
        jid = job["id"]
        j = self.srv.wait_job(jid, "done", timeout=90)
        self.assertTrue(j["segmented"])
        self.assertEqual(j["etag"], "")
        self.assertTrue(j["lastModified"])
        self.assert_clean_final(j, self.sha["mid.bin"])

    def test_15_queue_persistence_across_restart(self):
        job = self.srv.add(gameId="persist-ps5", releaseId="r")
        jid = job["id"]
        self.wait_written(jid, 2 * MiB)
        self.srv.stop()
        with open(os.path.join(self.data, "queue.json")) as f:
            q = json.load(f)
        self.assertEqual(q["v"], 1)
        mine = [x for x in q["jobs"] if x["id"] == jid]
        self.assertEqual(len(mine), 1)
        self.assertTrue(os.path.exists(job["path"] + ".xpart.json"))
        DownloadTests.srv = harness.XenoServer(self.data, port=self.srv.port).start()
        j = self.srv.job(jid)
        self.assertEqual(j["state"], "paused")
        self.assertEqual(j["message"], "Stopped when XENO STORE closed")
        self.assertGreater(j["written"], 0)
        self.assertGreater(len(j["segments"]), 0)
        st, b = self.srv.action(jid, "resume")
        self.assertEqual(st, 200)
        j = self.srv.wait_job(jid, "done", timeout=120)
        self.assert_clean_final(j, self.sha["mid.bin"])

    def test_16_bandwidth_limit(self):
        limit = 8 * MiB
        self.srv.api("PUT", "/api/settings", {"downloads": {"maxBytesPerSec": limit}})
        t0 = time.time()
        job = self.srv.add(gameId="bw-ps5", releaseId="r")
        j = self.srv.wait_job(job["id"], "done", timeout=60)
        elapsed = time.time() - t0
        expected = 64 * MiB / limit
        self.assertGreaterEqual(elapsed, expected * 0.75, f"too fast: {elapsed:.1f}s")
        self.assertLessEqual(elapsed, expected * 1.25 + 1.5, f"too slow: {elapsed:.1f}s")
        self.assert_clean_final(j, self.sha["big.bin"])
        self.srv.api("PUT", "/api/settings", {"downloads": {"maxBytesPerSec": 0}})

    def test_17_replace_url(self):
        job = self.srv.add(gameId="relink-ps5", releaseId="r")
        jid = job["id"]
        j = self.srv.wait_job(jid, "failed", timeout=60)
        self.assertEqual(j["errorCode"], "http_404")
        st, b = self.srv.action(jid, "url", {"url": "ftp://bad"})
        self.assertEqual(st, 400)
        st, b = self.srv.action(jid, "url", {"url": f"{self.rs}/ok/small.bin"})
        self.assertEqual(st, 200)
        self.assertEqual(b["job"]["state"], "queued")
        j = self.srv.wait_job(jid, "done", timeout=60)
        self.assertEqual(j["url"], f"{self.rs}/ok/small.bin")
        self.assert_clean_final(j, self.sha["small.bin"])

    def test_18_move_and_clear(self):
        a = self.srv.add(url=f"{self.rs}/slow/big.bin", filename="order-a.bin", format="BIN")
        b = self.srv.add(url=f"{self.rs}/ok/small.bin", filename="order-b.bin", format="BIN")
        c = self.srv.add(url=f"{self.rs}/ok/small.bin", filename="order-c.bin", format="BIN")
        self.wait_written(a["id"], 1)
        st, q = self.srv.api("GET", "/api/queue")
        order = [x["id"] for x in q["jobs"] if x["id"] in (a["id"], b["id"], c["id"])]
        self.assertEqual(order, [a["id"], b["id"], c["id"]])
        st, r = self.srv.action(c["id"], "move", {"direction": "up"})
        self.assertEqual(st, 200)
        st, q = self.srv.api("GET", "/api/queue")
        order = [x["id"] for x in q["jobs"] if x["id"] in (a["id"], b["id"], c["id"])]
        self.assertEqual(order, [a["id"], c["id"], b["id"]])
        st, r = self.srv.action(b["id"], "move", {"direction": "top"})
        st, q = self.srv.api("GET", "/api/queue")
        self.assertEqual(q["jobs"][0]["id"], b["id"])
        st, r = self.srv.action(b["id"], "move", {"direction": "sideways"})
        self.assertEqual(st, 400)
        self.srv.action(a["id"], "cancel", {"deleteFiles": True})
        self.srv.wait_job(b["id"], "done", timeout=60)
        self.srv.wait_job(c["id"], "done", timeout=60)
        time.sleep(0.5)
        self.assertFalse(os.path.exists(a["path"] + ".xpart"))
        st, r = self.srv.api("POST", "/api/queue/clear", {"states": ["done", "cancelled", "failed"]})
        self.assertGreaterEqual(r["removed"], 3)
        st, q = self.srv.api("GET", "/api/queue")
        self.assertTrue(all(x["state"] not in ("done", "cancelled", "failed") for x in q["jobs"]))
        self.assertTrue(os.path.exists(b["path"]))   # clear keeps files

    def test_19_verify_action_and_remove(self):
        job = self.srv.add(url=f"{self.rs}/ok/small.bin", filename="verify-me.bin", format="BIN", sha256=self.sha["small.bin"], verify=False, size=8 * MiB)
        j = self.srv.wait_job(job["id"], "done", timeout=60)
        self.assertEqual(j["verify"], "size")
        self.assertFalse(j["verified"])
        st, b = self.srv.action(job["id"], "verify")
        self.assertEqual(st, 200)
        j = self.srv.wait_job(job["id"], None, timeout=30, until=lambda x: x["state"] == "done" and x["sha256"])
        self.assertTrue(j["verified"])
        self.assertEqual(j["sha256"], self.sha["small.bin"])
        st, b = self.srv.action(job["id"], "remove", {"deleteFiles": True})
        self.assertEqual(st, 200)
        time.sleep(0.3)
        self.assertFalse(os.path.exists(j["path"]))
        self.assertIsNone(self.srv.job(job["id"]))


if __name__ == "__main__":
    unittest.main(verbosity=2)
