#!/usr/bin/env python3
"""
test_ext_downloads.py — Phase 2 download-engine tests (SPEC §17.5, §17.13,
§17.14, §17.15, §17.16, §17.19) against range_server.py and its mock debrid
services:

  turbo start picks the fastest mirror · /api/game/best reasons ·
  /api/stats accumulates and survives a restart · schedule window holds jobs
  and "startNow" releases one · install set of 3 PKGs installs in order and
  pauses the group on a failure (then resumes after a fix) · debrid connect,
  unrestrict through Real-Debrid / AllDebrid / TorBox / Premiumize, plain-word
  errors for unsupported hosts and plan limits, auto mode · rest-mode drill
  (range server killed mid-transfer, wake event, server restarted → resumes
  from the checkpoints without consuming an attempt) · copy and move between
  drives · ZIP extraction with sanitized paths and archive deletion.
"""
import datetime
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


def hhmm(delta_minutes):
    t = datetime.datetime.now() + datetime.timedelta(minutes=delta_minutes)
    return f"{t.hour:02d}:{t.minute:02d}"


class ExtDownloadTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp(prefix="xeno-ext-")
        cls.files_dir = os.path.join(cls.tmp, "files")
        cls.httpd, cls.rport = range_server.serve_in_thread(cls.files_dir)
        cls.rs = f"http://127.0.0.1:{cls.rport}"
        cls.data = os.path.join(cls.tmp, "data")
        cls.usb = os.path.join(cls.tmp, "usb0")
        os.makedirs(cls.usb)
        names = ("big.bin", "mid.bin", "small.bin", "tiny.pkg", "set-game.pkg", "set-update.pkg", "set-dlc.pkg", "folder.zip", "single.zip")
        cls.sha = {n: ctl(cls.rs, f"sha256/{n}")["sha256"] for n in names}
        rs = cls.rs
        games = [
            harness.make_game("turbo-ps5", "Turbo Game", "PPSA00101", [
                harness.make_release("r", f"{rs}/slow/small.bin", "PPSA00101 Turbo.ffpfsc", 8 * MiB, sha256=cls.sha["small.bin"],
                                     mirrors=[f"{rs}/ok/small.bin"], title_id="PPSA00101")]),
            harness.make_game("best-ps5", "Best Game", "PPSA00102", [
                harness.make_release("r-page", "https://example.invalid/page", "", 0, fmt="PAGE", title_id="PPSA00102", source="other", verified_at=""),
                harness.make_release("r-old", f"{rs}/ok/small.bin", "PPSA00102 Old.ffpfsc", 8 * MiB, title_id="PPSA00102", version="01.000.000"),
                harness.make_release("r-new", f"{rs}/ok/mid.bin", "PPSA00102 New.ffpfsc", 32 * MiB, title_id="PPSA00102", version="01.002.000", sha256=cls.sha["mid.bin"]),
                harness.make_release("r-upd", f"{rs}/ok/tiny.pkg", "PPSA00102 Update.pkg", 2 * MiB, fmt="PKG", title_id="PPSA00102", kind="update", version="01.005.000"),
                harness.make_release("r-hifw", f"{rs}/ok/big.bin", "PPSA00102 HighFw.exfat", 64 * MiB, fmt="exFAT", title_id="PPSA00102",
                                     version="01.003.000", requiresFw="14.00"),
            ]),
            harness.make_game("stats-ps5", "Stats Game", "PPSA00103", [
                harness.make_release("r", f"{rs}/ok/small.bin", "PPSA00103 Stats.ffpfsc", 8 * MiB, sha256=cls.sha["small.bin"], title_id="PPSA00103")]),
            harness.make_game("sched-ps5", "Scheduled Game", "PPSA00104", [
                harness.make_release("r", f"{rs}/ok/small.bin", "PPSA00104 Sched.ffpfsc", 8 * MiB, sha256=cls.sha["small.bin"], title_id="PPSA00104")]),
            harness.make_game("set-ps5", "Set Game", "PPSA02222", [
                harness.make_release("r-game", f"{rs}/ok/set-game.pkg", "PPSA02222 Game.pkg", 2 * MiB, fmt="PKG", sha256=cls.sha["set-game.pkg"], title_id="PPSA02222"),
                harness.make_release("r-update", f"{rs}/ok/set-update.pkg", "PPSA02222 Update 01.001.pkg", 1 * MiB, fmt="PKG",
                                     sha256=cls.sha["set-update.pkg"], title_id="PPSA02222", kind="update", version="01.001.000"),
                harness.make_release("r-update-old", f"{rs}/ok/set-update.pkg", "PPSA02222 Update 01.000.pkg", 1 * MiB, fmt="PKG",
                                     sha256=cls.sha["set-update.pkg"], title_id="PPSA02222", kind="update", version="01.000.500"),
                harness.make_release("r-dlc", f"{rs}/ok/set-dlc.pkg", "PPSA02222 DLC.pkg", range_server.FILES["set-dlc.pkg"], fmt="PKG",
                                     sha256=cls.sha["set-dlc.pkg"], title_id="PPSA02222", kind="dlc"),
            ]),
            harness.make_game("setfail-ps5", "Set Fail Game", "PPSA03333", [
                harness.make_release("r-game", f"{rs}/ok/set-game.pkg", "PPSA03333 Game.pkg", 2 * MiB, fmt="PKG", sha256=cls.sha["set-game.pkg"], title_id="PPSA03333"),
                harness.make_release("r-update", f"{rs}/f404/set-update.pkg", "PPSA03333 Update.pkg", 1 * MiB, fmt="PKG",
                                     sha256=cls.sha["set-update.pkg"], title_id="PPSA03333", kind="update", version="01.001.000"),
            ]),
            harness.make_game("zipfolder-ps5", "Folder Dump Game", "PPSA06666", [
                harness.make_release("r", f"{rs}/ok/folder.zip", "Folder Dump.zip", 0, fmt="ZIP", title_id="PPSA06666")]),
            harness.make_game("zipsingle-ps5", "Single Zip Game", "PPSA05555", [
                harness.make_release("r", f"{rs}/ok/single.zip", "PPSA05555 Single.zip", 0, fmt="ZIP", title_id="PPSA05555")]),
            harness.make_game("zipkeep-ps5", "Keep Zip Game", "PPSA05556", [
                harness.make_release("r", f"{rs}/ok/single.zip", "PPSA05556 Keep.zip", 0, fmt="ZIP", title_id="PPSA05556")]),
        ]
        harness.write_catalog(cls.data, games)
        cls.env = {"XENO_RD_BASE": f"{rs}/rd", "XENO_AD_BASE": f"{rs}/ad", "XENO_TB_BASE": f"{rs}/tb", "XENO_PM_BASE": f"{rs}/pm"}
        cls.srv = harness.XenoServer(cls.data, roots=[cls.usb], env=cls.env).start()
        cls.root = cls.srv.default_root

    @classmethod
    def tearDownClass(cls):
        cls.srv.stop()
        cls.httpd.shutdown()
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def setUp(self):
        ctl(self.rs, "reset")
        self.srv.api("PUT", "/api/settings", {"downloads": {"maxBytesPerSec": 0, "concurrentJobs": 1, "connections": 8, "turboStart": True,
                                                            "scheduleStart": "", "scheduleEnd": "", "extractZip": True,
                                                            "deleteArchiveAfterExtract": True, "autoInstallSets": True, "preferFormat": "auto"}})

    def assert_clean_final(self, job, expected_sha):
        self.assertTrue(os.path.exists(job["path"]), job["path"])
        self.assertFalse(os.path.exists(job["path"] + ".xpart"))
        self.assertFalse(os.path.exists(job["path"] + ".xpart.json"))
        self.assertEqual(harness.sha256_file(job["path"]), expected_sha)

    def wait_written(self, jid, min_bytes, timeout=30):
        return self.srv.wait_job(jid, None, timeout=timeout, until=lambda j: j["state"] == "downloading" and j["written"] >= min_bytes)

    # ------------------------------------------------------------------ turbo
    def test_01_turbo_picks_fastest_mirror(self):
        job = self.srv.add(gameId="turbo-ps5", releaseId="r", connections=4)
        self.assertEqual(job["turbo"]["done"], False)
        j = self.srv.wait_job(job["id"], "done", timeout=90)
        turbo = j["turbo"]
        self.assertTrue(turbo["done"])
        self.assertEqual(turbo["picked"], f"{self.rs}/ok/small.bin", turbo)
        self.assertEqual(len(turbo["tested"]), 2)
        by_url = {t["url"]: t for t in turbo["tested"]}
        slow, fast = by_url[f"{self.rs}/slow/small.bin"], by_url[f"{self.rs}/ok/small.bin"]
        self.assertEqual(fast["status"], 206)
        self.assertGreater(fast["mbps"], slow["mbps"])
        self.assertGreater(fast["bytes"], 0)
        self.assertEqual(j["activeUrl"], f"{self.rs}/ok/small.bin")
        self.assertEqual(j["url"], f"{self.rs}/slow/small.bin")          # the catalog primary stays visible
        self.assertEqual(j["mirrorIndex"], 0)
        self.assertEqual(j["mirrors"][0], f"{self.rs}/ok/small.bin")
        self.assertIn(f"{self.rs}/slow/small.bin", j["mirrors"])            # the primary joined the failover list
        self.assert_clean_final(j, self.sha["small.bin"])
        st, lg = self.srv.api("GET", f"/api/queue/{job['id']}/log")
        self.assertTrue(any("turbo: picked" in ln for ln in lg["lines"]), lg["lines"])
        # a single-URL job never races
        one = self.srv.add(url=f"{self.rs}/ok/small.bin", filename="no-turbo.bin", format="BIN")
        j1 = self.srv.wait_job(one["id"], "done", timeout=60)
        self.assertTrue(j1["turbo"]["done"])
        self.assertEqual(j1["turbo"]["tested"], [])

    # ------------------------------------------------------------ best version
    def test_02_best_version_reasons(self):
        st, b = self.srv.api("GET", "/api/game/best?id=best-ps5&fw=13.60")
        self.assertEqual(st, 200, b)
        self.assertEqual(b["fw"], "13.60")
        self.assertEqual(b["releaseId"], "r-new")
        self.assertEqual(b["release"]["id"], "r-new")
        codes = [r["code"] for r in b["reasons"]]
        self.assertIn("compat", codes)
        self.assertIn("verified", codes)
        self.assertIn("hash", codes)
        self.assertIn("newest", codes)
        newest = [r for r in b["reasons"] if r["code"] == "newest"][0]
        self.assertEqual(newest["vars"]["v"], "01.002.000")
        self.assertIn("r-old", b["alternatives"])
        self.assertNotIn("r-new", b["alternatives"])
        self.assertEqual(b["candidates"], 5)
        # on firmware 14.00 the exFAT release becomes compatible and is the newest game release
        st, b = self.srv.api("GET", "/api/game/best?id=best-ps5&fw=14.00")
        self.assertEqual(b["releaseId"], "r-hifw")
        self.assertIn("compat", [r["code"] for r in b["reasons"]])
        # with no firmware known (host build) requiresFw cannot exclude anything: newest wins
        st, b = self.srv.api("GET", "/api/game/best?id=best-ps5")
        self.assertEqual(b["releaseId"], "r-hifw")
        self.assertNotIn("compat", [r["code"] for r in b["reasons"]])
        # preferFormat tips the choice
        self.srv.api("PUT", "/api/settings", {"downloads": {"preferFormat": "FFPFSC"}})
        st, b = self.srv.api("GET", "/api/game/best?id=best-ps5&fw=14.00")
        self.assertEqual(b["releaseId"], "r-new")
        self.assertIn("preferred", [r["code"] for r in b["reasons"]])
        self.srv.api("PUT", "/api/settings", {"downloads": {"preferFormat": "auto"}})
        st, b = self.srv.api("GET", "/api/game/best?id=nope")
        self.assertEqual(st, 404)
        st, b = self.srv.api("GET", "/api/game/best")
        self.assertEqual(st, 400)

    # ------------------------------------------------------------------ stats
    def test_03_stats_accumulate_and_persist(self):
        st, before = self.srv.api("GET", "/api/stats")
        self.assertEqual(st, 200)
        for k in ("totalBytes", "totalJobs", "bestSpeed", "avgSpeed", "byProvider", "since"):
            self.assertIn(k, before)
        job = self.srv.add(gameId="stats-ps5", releaseId="r")
        j = self.srv.wait_job(job["id"], "done", timeout=60)
        self.assert_clean_final(j, self.sha["small.bin"])
        st, after = self.srv.api("GET", "/api/stats")
        self.assertEqual(after["totalBytes"], before["totalBytes"] + 8 * MiB)
        self.assertEqual(after["totalJobs"], before["totalJobs"] + 1)
        self.assertGreater(after["bestSpeed"], 0)
        self.assertGreater(after["avgSpeed"], 0)
        self.assertGreaterEqual(after["byProvider"]["Archive.org"]["bytes"], 8 * MiB)
        self.assertTrue(os.path.exists(os.path.join(self.data, "stats.json")))
        st, q = self.srv.api("GET", "/api/queue")
        self.assertEqual(q["summary"]["lifetime"]["totalBytes"], after["totalBytes"])
        # survives a restart
        self.srv.stop()
        ExtDownloadTests.srv = harness.XenoServer(self.data, roots=[self.usb], env=self.env, port=self.srv.port).start()
        st, again = self.srv.api("GET", "/api/stats")
        self.assertEqual(again["totalBytes"], after["totalBytes"])
        self.assertEqual(again["totalJobs"], after["totalJobs"])
        self.assertEqual(again["byProvider"], after["byProvider"])
        st, r = self.srv.api("POST", "/api/stats/reset")
        self.assertEqual(r["totalBytes"], 0)

    # --------------------------------------------------------------- schedule
    def test_04_schedule_window_holds_and_start_now(self):
        start, end = hhmm(120), hhmm(180)   # a window that is closed right now
        st, r = self.srv.api("PUT", "/api/settings", {"downloads": {"scheduleStart": start, "scheduleEnd": end}})
        self.assertEqual(st, 200, r)
        job = self.srv.add(gameId="sched-ps5", releaseId="r")
        j = self.srv.wait_job(job["id"], None, timeout=10, until=lambda x: x["scheduledFor"] == start)
        self.assertEqual(j["state"], "queued")
        self.assertEqual(j["message"], f"Scheduled for {start}")
        time.sleep(2.0)
        j = self.srv.job(job["id"])
        self.assertEqual(j["state"], "queued", "a held job must not start")
        self.assertEqual(j["written"], 0)
        st, q = self.srv.api("GET", "/api/queue")
        self.assertTrue(q["summary"]["schedule"]["configured"])
        self.assertFalse(q["summary"]["schedule"]["open"])
        self.assertEqual(q["summary"]["schedule"]["nextStart"], start)
        self.assertEqual(q["summary"]["schedule"]["waiting"], 1)
        st, b = self.srv.action(job["id"], "startNow")
        self.assertEqual(st, 200, b)
        self.assertTrue(b["job"]["startNow"])
        j = self.srv.wait_job(job["id"], "done", timeout=60)
        self.assert_clean_final(j, self.sha["small.bin"])
        self.assertEqual(j["scheduledFor"], "")
        # opening the window releases held jobs by itself
        self.srv.api("PUT", "/api/settings", {"downloads": {"scheduleStart": "", "scheduleEnd": ""}})
        st, q = self.srv.api("GET", "/api/queue")
        self.assertTrue(q["summary"]["schedule"]["open"])
        self.assertFalse(q["summary"]["schedule"]["configured"])

    # ------------------------------------------------------------ install sets
    def test_05_install_set_installs_in_order(self):
        st, r = self.srv.api("POST", "/api/queue/set", {"gameId": "set-ps5", "base": "r-game", "also": {"update": True, "dlc": True},
                                                        "autoInstall": True, "verify": "auto"})
        self.assertEqual(st, 200, r)
        group = r["group"]
        self.assertTrue(group.startswith("g_"))
        jobs = r["jobs"]
        self.assertEqual([j["kind"] for j in jobs], ["game", "update", "dlc"])
        self.assertEqual([j["groupOrder"] for j in jobs], [1, 2, 3])
        self.assertEqual([j["releaseId"] for j in jobs], ["r-game", "r-update", "r-dlc"])   # newest update only
        self.assertTrue(all(j["group"] == group for j in jobs))
        ids = [j["id"] for j in jobs]
        done = {}
        for jid in ids:
            done[jid] = self.srv.wait_job(jid, "installed", timeout=120)
        self.assertTrue(all(done[i]["install"]["state"] == "installed" for i in ids))
        started = [done[i]["install"]["startedAt"] for i in ids]
        finished = [done[i]["finishedAt"] for i in ids]
        self.assertLessEqual(finished[0], started[1], "the update must wait for the game install")
        self.assertLessEqual(finished[1], started[2], "the DLC must wait for the update install")
        st, q = self.srv.api("GET", "/api/queue")
        g = [x for x in q["summary"]["groups"] if x["id"] == group][0]
        self.assertEqual(g["status"], "installed")
        self.assertEqual(g["installed"], 3)
        st, gg = self.srv.api("GET", "/api/downloads/groups")
        self.assertEqual(st, 200)
        self.assertIn(group, [x["id"] for x in gg["groups"]])
        st, lg = self.srv.api("GET", f"/api/queue/{ids[1]}/log")
        self.assertTrue(any("installs with the set" in ln or "install set" in ln for ln in lg["lines"]), lg["lines"])
        # a set with an explicit item list and a bad release is refused as a whole
        st, r = self.srv.api("POST", "/api/queue/set", {"gameId": "set-ps5", "items": [{"releaseId": "r-game"}, {"releaseId": "nope"}], "overwrite": True})
        self.assertEqual(st, 404)
        self.assertEqual(r["error"], "bad_release")
        st, r = self.srv.api("POST", "/api/queue/set", {"gameId": "set-ps5"})
        self.assertEqual(st, 400)

    def test_06_install_set_pauses_on_failure_and_resumes_after_fix(self):
        st, r = self.srv.api("POST", "/api/queue/set", {"gameId": "setfail-ps5", "base": "r-game", "also": {"update": True}, "autoInstall": True})
        self.assertEqual(st, 200, r)
        group = r["group"]
        game, upd = r["jobs"]
        self.assertEqual((game["kind"], upd["kind"]), ("game", "update"))
        self.srv.wait_job(upd["id"], "failed", timeout=60)
        g_job = self.srv.wait_job(game["id"], "done", timeout=60)
        time.sleep(1.5)
        g_job = self.srv.job(game["id"])
        self.assertEqual(g_job["state"], "done")
        self.assertEqual(g_job["install"]["state"], "pending", "the game must not install while the set is paused")
        st, q = self.srv.api("GET", "/api/queue")
        g = [x for x in q["summary"]["groups"] if x["id"] == group][0]
        self.assertEqual(g["status"], "paused")
        self.assertTrue(g["pausedAt"].startswith("update:"), g)
        self.assertEqual(g["pausedJobId"], upd["id"])
        # fix the link → the set resumes and installs game, then update
        st, b = self.srv.action(upd["id"], "url", {"url": f"{self.rs}/ok/set-update.pkg"})
        self.assertEqual(st, 200, b)
        u = self.srv.wait_job(upd["id"], "installed", timeout=120)
        gj = self.srv.wait_job(game["id"], "installed", timeout=30)
        self.assertLessEqual(gj["finishedAt"], u["install"]["startedAt"])
        st, q = self.srv.api("GET", "/api/queue")
        g = [x for x in q["summary"]["groups"] if x["id"] == group][0]
        self.assertEqual(g["status"], "installed")

    # ------------------------------------------------------------------ debrid
    def test_07_debrid_connect_and_unrestrict(self):
        st, d = self.srv.api("GET", "/api/debrid")
        self.assertEqual(st, 200)
        self.assertEqual([s["id"] for s in d["services"]], ["realdebrid", "alldebrid", "torbox", "premiumize"])
        self.assertTrue(all(not s["connected"] for s in d["services"]))
        st, r = self.srv.api("PUT", "/api/debrid", {"service": "realdebrid", "apiKey": "wrong"})
        self.assertEqual(st, 401, r)
        self.assertEqual(r["error"], "bad_key")
        self.assertIn("Real-Debrid rejected the API key", r["message"])
        st, r = self.srv.api("PUT", "/api/debrid", {"service": "nope", "apiKey": "x"})
        self.assertEqual(st, 400)
        keys = {"realdebrid": "rd-good", "alldebrid": "ad-good", "torbox": "tb-good", "premiumize": "pm-good"}
        for sid, key in keys.items():
            st, r = self.srv.api("PUT", "/api/debrid", {"service": sid, "apiKey": key})
            self.assertEqual(st, 200, r)
            svc = [s for s in r["services"] if s["id"] == sid][0]
            self.assertTrue(svc["connected"])
            self.assertTrue(svc["user"])
            self.assertTrue(svc["expires"])
            if sid != "torbox":
                self.assertIn("127.0.0.1", svc["hosts"])
                self.assertTrue(svc["hostsKnown"])
        st, s = self.srv.api("GET", "/api/settings")
        self.assertEqual(s["settings"]["debrid"]["realdebrid"]["apiKey"], "rd-good")
        labels = {"realdebrid": "Real-Debrid", "alldebrid": "AllDebrid", "torbox": "TorBox", "premiumize": "Premiumize"}
        expect_calls = {"realdebrid": ["unrestrict/link"], "alldebrid": ["link/unlock"],
                        "torbox": ["webdl/createwebdownload", "webdl/mylist", "webdl/requestdl"], "premiumize": ["transfer/directdl"]}
        for sid in keys:
            ctl(self.rs, "reset")
            # the direct link 404s: only the unrestricted /ok/ twin can succeed
            job = self.srv.add(url=f"{self.rs}/f404/small.bin", filename=f"via-{sid}.bin", format="BIN", via=sid, sha256=self.sha["small.bin"])
            self.assertEqual(job["viaRequested"], sid)
            j = self.srv.wait_job(job["id"], "done", timeout=120)
            self.assertEqual(j["via"], labels[sid], j)
            self.assertEqual(j["viaService"], sid)
            self.assertEqual(j["activeUrl"], f"{self.rs}/ok/small.bin")
            self.assertEqual(j["url"], f"{self.rs}/f404/small.bin")
            self.assertTrue(j["verified"])
            self.assert_clean_final(j, self.sha["small.bin"])
            calls = [c["path"] for c in ctl(self.rs, "stats")["debridCalls"]]
            for p in expect_calls[sid]:
                self.assertIn(p, calls, (sid, calls))
            st, lg = self.srv.api("GET", f"/api/queue/{job['id']}/log")
            self.assertTrue(any(f"via {labels[sid]}" in ln for ln in lg["lines"]), lg["lines"])
        # unsupported host → plain words, no transfer attempted
        job = self.srv.add(url="http://unsupported.example/small.bin", filename="unsup.bin", format="BIN", via="realdebrid")
        j = self.srv.wait_job(job["id"], "failed", timeout=30)
        self.assertEqual(j["errorCode"], "debrid_unsupported_host")
        self.assertEqual(j["message"], "Real-Debrid says this host is not supported")
        self.assertEqual(j["attempts"], 1)
        # plan limit (TorBox wording)
        job = self.srv.add(url=f"{self.rs}/ok/huge.bin", filename="huge.bin", format="BIN", via="torbox")
        j = self.srv.wait_job(job["id"], "failed", timeout=30)
        self.assertEqual(j["errorCode"], "debrid_limit")
        self.assertIn("limits files to 107 GB", j["message"])
        self.assertIn("pick a smaller format or download directly", j["message"])
        # auto: a connected service that lists the host is used (first in order: Real-Debrid)
        ctl(self.rs, "reset")
        job = self.srv.add(url=f"{self.rs}/f404/small.bin", filename="via-auto.bin", format="BIN", via="auto")
        j = self.srv.wait_job(job["id"], "done", timeout=60)
        self.assertEqual(j["viaService"], "realdebrid")
        # a bad via value is refused up front
        st, r = self.srv.api("POST", "/api/queue", {"url": f"{self.rs}/ok/small.bin", "filename": "x.bin", "via": "sharkbox"})
        self.assertEqual(st, 400)
        # disconnect clears the key and the cached account
        st, r = self.srv.api("DELETE", "/api/debrid/realdebrid")
        self.assertEqual(st, 200)
        rd = [s for s in r["services"] if s["id"] == "realdebrid"][0]
        self.assertFalse(rd["connected"])
        self.assertEqual(rd["user"], "")
        st, s = self.srv.api("GET", "/api/settings")
        self.assertEqual(s["settings"]["debrid"]["realdebrid"]["apiKey"], "")
        st, r = self.srv.api("DELETE", "/api/debrid/nope")
        self.assertEqual(st, 404)
        # an explicitly chosen service that is not connected fails with a hint
        job = self.srv.add(url=f"{self.rs}/ok/small.bin", filename="not-connected.bin", format="BIN", via="realdebrid")
        j = self.srv.wait_job(job["id"], "failed", timeout=30)
        self.assertEqual(j["errorCode"], "debrid_not_connected")
        self.assertIn("Settings", j["message"])
        for sid in ("alldebrid", "torbox", "premiumize"):
            self.srv.api("DELETE", f"/api/debrid/{sid}")

    # --------------------------------------------------------------- rest mode
    def test_08_rest_mode_resumes_without_consuming_attempts(self):
        proc = harness.RangeServerProcess(self.files_dir).start()
        try:
            self.assertEqual(proc.sha256("mid.bin"), self.sha["mid.bin"], "--keep must serve the same bytes")
            job = self.srv.add(url=f"{proc.base}/slow2/mid.bin", filename="rest-mode.bin", format="BIN", connections=2, sha256=self.sha["mid.bin"])
            jid = job["id"]
            self.wait_written(jid, 4 * MiB, timeout=40)
            proc.kill()                                   # every socket dies, like a console going to rest mode
            st, r = self.srv.api("POST", "/api/downloads/rest-mode/simulate")
            self.assertEqual(st, 200, r)
            j = self.srv.wait_job(jid, None, timeout=20, until=lambda x: x["state"] == "connecting" and x["restResuming"])
            self.assertIn("network", j["message"].lower())
            self.assertGreater(j["written"], 0, "the checkpointed bytes stay")
            st, q = self.srv.api("GET", "/api/queue")
            self.assertEqual(q["summary"]["restMode"]["resuming"], 1)
            self.assertTrue(q["summary"]["restMode"]["pill"])
            time.sleep(2.0)
            j = self.srv.job(jid)
            self.assertEqual(j["state"], "connecting")
            self.assertEqual(j["attempts"], 1)
            proc = harness.RangeServerProcess(self.files_dir, port=proc.port).start()   # the console woke up and the network is back
            j = self.srv.wait_job(jid, "done", timeout=120)
            self.assertEqual(j["attempts"], 1, "a sleep/wake cycle must not consume retry budget")
            self.assertGreaterEqual(j["restResumes"], 1)
            self.assertTrue(j["verified"])
            self.assert_clean_final(j, self.sha["mid.bin"])
            st, lg = self.srv.api("GET", f"/api/queue/{jid}/log")
            text = "\n".join(lg["lines"])
            self.assertIn("network is back", text)
            self.assertIn("resuming with", text)
        finally:
            proc.kill()

    # --------------------------------------------------------------- copy/move
    def test_09_copy_and_move_between_drives(self):
        job = self.srv.add(gameId="stats-ps5", releaseId="r", overwrite=True)
        j = self.srv.wait_job(job["id"], "done", timeout=60)
        src = j["path"]
        st, r = self.srv.api("POST", "/api/library/transfer", {"path": src, "toRoot": self.root})
        self.assertEqual(st, 422, r)
        self.assertEqual(r["error"], "same_drive")
        st, r = self.srv.api("POST", "/api/library/transfer", {"path": "/etc/hostname", "toRoot": self.usb})
        self.assertEqual(st, 403)
        st, r = self.srv.api("POST", "/api/library/transfer", {"path": src, "toRoot": "/nope"})
        self.assertEqual(st, 422)
        st, r = self.srv.api("POST", "/api/library/transfer", {"path": src, "toRoot": self.usb, "move": False})
        self.assertEqual(st, 200, r)
        cj = r["job"]
        self.assertEqual(cj["type"], "copy")
        self.assertEqual(cj["srcPath"], src)
        self.assertEqual(cj["root"], self.usb)
        self.assertEqual(cj["title"], "Stats Game")
        self.assertTrue(cj["path"].startswith(self.usb + "/homebrew/"))
        c = self.srv.wait_job(cj["id"], "done", timeout=60)
        self.assertEqual(c["written"], 8 * MiB)
        self.assertEqual(c["total"], 8 * MiB)
        self.assertIn("Copied to", c["message"])
        self.assertTrue(os.path.exists(src), "copy keeps the source")
        self.assert_clean_final(c, self.sha["small.bin"])
        # the copy now exists → a second copy is refused unless overwrite
        st, r = self.srv.api("POST", "/api/library/transfer", {"path": src, "toRoot": self.usb})
        self.assertEqual(st, 409)
        # move: a scanned file (library allowlist) is moved and the source unlinked
        pkg = self.srv.add(url=f"{self.rs}/ok/tiny.pkg", filename="move-me.pkg", format="PKG", autoInstall=False, overwrite=True)
        pj = self.srv.wait_job(pkg["id"], "done", timeout=60)
        st, lib = self.srv.api("GET", "/api/library?scan=1")
        self.assertIn(pj["path"], [f["path"] for f in lib["files"]])
        st, r = self.srv.api("POST", "/api/library/transfer", {"path": pj["path"], "toRoot": self.usb, "move": True})
        self.assertEqual(st, 200, r)
        m = self.srv.wait_job(r["job"]["id"], "done", timeout=60)
        self.assertTrue(m["move"])
        self.assertIn("Moved to", m["message"])
        self.assertFalse(os.path.exists(pj["path"]), "move unlinks the source")
        self.assertTrue(m["path"].startswith(self.usb + "/xeno-store/pkg/"))
        self.assert_clean_final(m, self.sha["tiny.pkg"])
        st, q = self.srv.api("GET", "/api/queue")
        self.assertIn("copying", q["summary"])
        # an unfinished partial cannot be transferred
        st, r = self.srv.api("POST", "/api/library/transfer", {"path": pj["path"] + ".xpart", "toRoot": self.usb})
        self.assertIn(st, (400, 403))

    # ---------------------------------------------------------------- zip
    def test_10_zip_extraction_sanitized_and_archive_deleted(self):
        job = self.srv.add(gameId="zipfolder-ps5", releaseId="r")
        self.assertTrue(job["path"].endswith("/xeno-store/files/Folder Dump.zip"))
        j = self.srv.wait_job(job["id"], "extracted", timeout=90)
        ex = j["extract"]
        self.assertEqual(ex["state"], "extracted")
        self.assertEqual(ex["dir"], os.path.join(self.root, "homebrew", "Folder Dump"))
        self.assertEqual(ex["files"], 4)
        self.assertTrue(ex["archiveDeleted"])
        self.assertFalse(os.path.exists(job["path"]), "archive removed after a successful extraction")
        self.assertTrue(os.path.exists(os.path.join(ex["dir"], "MyGame", "eboot.bin")))
        self.assertTrue(os.path.exists(os.path.join(ex["dir"], "MyGame", "sce_sys", "param.json")))
        self.assertEqual(os.path.getsize(os.path.join(ex["dir"], "MyGame", "data", "level1.dat")), 2 * MiB)
        self.assertIn("3 unsafe entries skipped", ex["message"])
        for base in (self.tmp, self.root, os.path.dirname(self.root)):
            for dirpath, _, files in os.walk(base):
                for f in files:
                    self.assertNotIn("evil", f, os.path.join(dirpath, f))
        self.assertEqual(j["written"], j["total"])
        self.assertIn("Extracted 4 files", j["message"])
        st, q = self.srv.api("GET", "/api/queue")
        self.assertEqual(q["summary"]["done"], len([x for x in q["jobs"] if x["state"] in ("done", "installed", "extracted")]))
        # a zip holding one image goes straight to homebrew/<image>
        job = self.srv.add(gameId="zipsingle-ps5", releaseId="r")
        j = self.srv.wait_job(job["id"], "extracted", timeout=90)
        img = os.path.join(self.root, "homebrew", "PPSA05555 Single Game.ffpfsc")
        self.assertEqual(j["extract"]["dir"], img)
        self.assertEqual(os.path.getsize(img), 4 * MiB)
        self.assertFalse(os.path.exists(job["path"]))
        self.assertFalse(os.path.exists(os.path.join(self.root, "xeno-store", "files", ".xeno-extract-" + job["id"])))
        # extraction off: the archive stays, "extract" action does it later and keeps it when configured
        self.srv.api("PUT", "/api/settings", {"downloads": {"extractZip": False, "deleteArchiveAfterExtract": False}})
        job = self.srv.add(gameId="zipkeep-ps5", releaseId="r")
        j = self.srv.wait_job(job["id"], "done", timeout=90)
        self.assertEqual(j["extract"]["state"], "idle")
        self.assertTrue(os.path.exists(j["path"]))
        self.assert_clean_final(j, self.sha["single.zip"])
        st, b = self.srv.action(job["id"], "extract")
        self.assertEqual(st, 200, b)
        j = self.srv.wait_job(job["id"], "extracted", timeout=60)
        self.assertFalse(j["extract"]["archiveDeleted"])
        self.assertTrue(os.path.exists(j["path"]), "archive kept when deleteArchiveAfterExtract is off")
        # the single image already exists from the previous job → the second extraction reports it honestly
        self.assertEqual(j["extract"]["dir"], img) if j["state"] == "extracted" else None
        st, b = self.srv.action(job["id"], "install")
        self.assertEqual(st, 400)

    # ------------------------------------------------------------ summary shape
    def test_11_queue_summary_phase2_shape(self):
        st, q = self.srv.api("GET", "/api/queue")
        s = q["summary"]
        for k in ("restMode", "schedule", "groups", "lifetime", "extracting", "copying"):
            self.assertIn(k, s)
        self.assertIn("pill", s["restMode"])
        self.assertIn("Rest mode", s["restMode"]["pill"])
        self.srv.api("PUT", "/api/settings", {"downloads": {"restModeAutoResume": False}})
        st, q = self.srv.api("GET", "/api/queue")
        self.assertIn("Resume", q["summary"]["restMode"]["pill"])
        self.srv.api("PUT", "/api/settings", {"downloads": {"restModeAutoResume": True}})
        for j in q["jobs"]:
            for k in ("type", "group", "groupOrder", "kind", "via", "viaService", "viaRequested", "turbo", "scheduledFor", "startNow", "extract", "restResumes"):
                self.assertIn(k, j)


if __name__ == "__main__":
    unittest.main(verbosity=2)
