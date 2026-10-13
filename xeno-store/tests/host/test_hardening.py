#!/usr/bin/env python3
"""
test_hardening.py — Phase 3 C hardening and Orbit download-durability parity:

  * the DNS-rebind / Origin / Sec-Fetch request gate (a phone on the LAN passes,
    evil.com is refused) and the nosniff / no-referrer headers,
  * device pairing (console code, show cooldown, strike lockout, bearer token,
    loopback-only /api/session),
  * the self-healing :9095 listener (forced rebind keeps the server reachable),
  * download durability: the persisted resume cursor never advances past the
    last fsync, even when a flush fails mid-transfer,
  * the exFAT/USB bounded-window download path produces correct bytes,
  * classic ZipCrypto extraction with the community password list, a user
    override password, and a zip-slip refusal.

Each test spins up its own host-binary instance on a temp data dir.
"""
import hashlib
import json
import os
import signal
import sys
import tempfile
import time
import unittest
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness  # noqa: E402
from harness import XenoServer, RangeServerProcess, free_port, MiB  # noqa: E402
import range_server  # noqa: E402


def community_entry_sha():
    return hashlib.sha256(range_server.encrypted_entry_bytes()).hexdigest()


class GateTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp(prefix="xeno-gate.")
        cls.srv = XenoServer(os.path.join(cls.tmp, "data")).start()

    @classmethod
    def tearDownClass(cls):
        cls.srv.stop()

    def host(self, value):
        return {"Host": value}

    def test_phone_without_origin_passes(self):
        # A normal phone browser: Host is the console IP:port, no Origin header.
        st, _, _ = self.srv.raw("GET", "/api/status", headers=self.host(f"192.168.1.20:{self.srv.port}"))
        self.assertEqual(st, 200)

    def test_evil_host_rejected(self):
        for h in ("evil.com", f"evil.com:{self.srv.port}", "attacker.example"):
            st, _, _ = self.srv.raw("GET", "/api/status", headers=self.host(h))
            self.assertEqual(st, 403, f"Host {h} must be refused")

    def test_local_names_pass(self):
        for h in (f"ps5.local:{self.srv.port}", f"console.home.arpa:{self.srv.port}", f"localhost:{self.srv.port}", f"127.0.0.1:{self.srv.port}"):
            st, _, _ = self.srv.raw("GET", "/api/status", headers=self.host(h))
            self.assertEqual(st, 200, f"Host {h} must pass")

    def test_wrong_port_rejected(self):
        st, _, _ = self.srv.raw("GET", "/api/status", headers=self.host("192.168.1.20:1"))
        self.assertEqual(st, 403)

    def test_origin_must_match(self):
        good = f"192.168.1.20:{self.srv.port}"
        st, _, _ = self.srv.raw("GET", "/api/status", headers={"Host": good, "Origin": f"http://{good}"})
        self.assertEqual(st, 200)
        st, _, _ = self.srv.raw("GET", "/api/status", headers={"Host": good, "Origin": "http://evil.com"})
        self.assertEqual(st, 403)

    def test_sec_fetch_site_on_api(self):
        good = f"192.168.1.20:{self.srv.port}"
        for site in ("same-origin", "none"):
            st, _, _ = self.srv.raw("GET", "/api/status", headers={"Host": good, "Sec-Fetch-Site": site})
            self.assertEqual(st, 200, site)
        for site in ("cross-site", "same-site"):
            st, _, _ = self.srv.raw("GET", "/api/status", headers={"Host": good, "Sec-Fetch-Site": site})
            self.assertEqual(st, 403, site)

    def test_security_headers(self):
        st, hdrs, _ = self.srv.raw("GET", "/api/status", headers=self.host(f"192.168.1.20:{self.srv.port}"))
        self.assertEqual(hdrs.get("X-Content-Type-Options"), "nosniff")
        self.assertEqual(hdrs.get("Referrer-Policy"), "no-referrer")

    def test_static_assets_still_served(self):
        st, _, body = self.srv.raw("GET", "/", headers=self.host(f"192.168.1.20:{self.srv.port}"))
        self.assertEqual(st, 200)
        self.assertIn(b"<!", body[:64].lower())


class PairingTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp(prefix="xeno-pair.")
        cls.srv = XenoServer(os.path.join(cls.tmp, "data")).start()

    @classmethod
    def tearDownClass(cls):
        cls.srv.stop()

    def code(self):
        st, b = self.srv.api("GET", "/api/pair")
        self.assertEqual(st, 200)
        self.assertEqual(len(b["code"]), 6)       # loopback peer sees the literal code
        self.assertIn("cooldown", b)
        return b["code"]

    def test_01_session_is_loopback_and_issues_token(self):
        st, b = self.srv.api("GET", "/api/session")
        self.assertEqual(st, 200)
        self.assertEqual(len(b["token"]), 64)
        self.assertTrue(b["pairUrl"].startswith("http://"))
        self.assertEqual(b["port"], self.srv.port)

    def test_02_show_cooldown(self):
        st, b = self.srv.api("POST", "/api/pair/show")
        self.assertEqual(st, 200)
        self.assertTrue(b.get("shown"))
        st, b = self.srv.api("POST", "/api/pair/show")
        self.assertEqual(st, 429)
        self.assertEqual(b["error"], "cooldown")
        self.assertGreater(b["retryAfter"], 0)

    def test_03_redeem_wrong_then_right(self):
        code = self.code()
        st, b = self.srv.api("POST", "/api/pair", {"code": "000000" if code != "000000" else "111111"})
        self.assertEqual(st, 403)
        self.assertEqual(b["error"], "bad_code")
        st, b = self.srv.api("POST", "/api/pair", {"code": code})
        self.assertEqual(st, 200)
        self.assertEqual(len(b["token"]), 64)

    def test_04_strike_lockout(self):
        # Five wrong codes in a row lock pairing for a minute (429).
        bad = "999999"
        if self.code() == bad:
            bad = "888888"
        got_lock = False
        for _ in range(6):
            st, b = self.srv.api("POST", "/api/pair", {"code": bad})
            if st == 429:
                got_lock = True
                self.assertGreater(b["retryAfter"], 0)
                break
            self.assertEqual(st, 403)
        self.assertTrue(got_lock, "pairing must lock out after repeated wrong codes")

    def test_05_token_authorizes_when_pin_set(self):
        srv = XenoServer(os.path.join(self.tmp, "data2")).start()
        try:
            code = srv.api("GET", "/api/pair")[1]["code"]
            token = srv.api("POST", "/api/pair", {"code": code})[1]["token"]
            srv.api("PUT", "/api/settings", {"pairing": {"pin": "7788"}})
            # no auth → refused
            st, _ = srv.api("POST", "/api/recent", {"id": "a"})
            self.assertEqual(st, 401)
            # bearer token → accepted
            st, _ = srv.api("POST", "/api/recent", {"id": "a"}, headers={"Authorization": f"Bearer {token}"})
            self.assertEqual(st, 200)
            # the PIN still works too
            st, _ = srv.api("POST", "/api/recent", {"id": "b"}, headers={"X-XENO-PIN": "7788"})
            self.assertEqual(st, 200)
        finally:
            srv.stop()

    def test_06_tokens_persist_across_restart(self):
        srv = XenoServer(os.path.join(self.tmp, "data3"))
        srv.start()
        code = srv.api("GET", "/api/pair")[1]["code"]
        token = srv.api("POST", "/api/pair", {"code": code})[1]["token"]
        srv.api("PUT", "/api/settings", {"pairing": {"pin": "4455"}})
        srv.stop()
        srv2 = XenoServer(srv.data_dir, port=srv.port)
        srv2.start()
        try:
            st, _ = srv2.api("POST", "/api/recent", {"id": "c"}, headers={"Authorization": f"Bearer {token}"})
            self.assertEqual(st, 200, "a paired token must survive a restart")
        finally:
            srv2.stop()


class ListenerTests(unittest.TestCase):
    def test_self_healing_rebind(self):
        tmp = tempfile.mkdtemp(prefix="xeno-listener.")
        srv = XenoServer(os.path.join(tmp, "data")).start()
        try:
            self.assertEqual(srv.api("GET", "/api/status")[0], 200)
            srv.proc.send_signal(signal.SIGUSR1)   # host hook: force the watchdog to rebind
            time.sleep(1.5)
            # the server must still answer on the same port after the rebind
            ok = False
            for _ in range(50):
                try:
                    if srv.api("GET", "/api/status")[0] == 200:
                        ok = True
                        break
                except Exception:
                    pass
                time.sleep(0.1)
            self.assertTrue(ok, "server must stay reachable after a listener rebind")
            self.assertIn("rebound", srv.log_text(), "a rebind must be logged")
        finally:
            srv.stop()
            srv.stop()


class DurabilityTests(unittest.TestCase):
    def _sidecar_done_sum(self, path):
        with open(path) as f:
            sc = json.load(f)
        return sum(e[1] - e[0] for e in sc.get("done", [])), sc

    def test_cursor_never_past_fsync(self):
        tmp = tempfile.mkdtemp(prefix="xeno-durable.")
        rs = RangeServerProcess(os.path.join(tmp, "files")).start()
        threshold = 12 * MiB
        srv = XenoServer(os.path.join(tmp, "data"), env={"XENO_HOST_FSYNC_FAIL_AFTER": str(threshold)}).start()
        try:
            # one slow stream so periodic 5 s checkpoints run while bytes arrive
            job = srv.add(url=f"{rs.base}/slow/mid.bin", filename="durable.bin", format="BIN", connections=1)
            j = srv.wait_job(job["id"], None, timeout=60, until=lambda x: x["state"] == "failed")
            self.assertEqual(j["errorCode"], "io_error")
            sidecar = j["path"] + ".xpart.json"
            xpart = j["path"] + ".xpart"
            self.assertTrue(os.path.exists(sidecar), "a sidecar must have been written")
            done_sum, _ = self._sidecar_done_sum(sidecar)
            # The persisted (durable) cursor must never exceed what was fsynced.
            self.assertLessEqual(done_sum, threshold,
                                 "resume cursor advanced past the last successful fsync")
            if os.path.exists(xpart):
                # live bytes on disk ran ahead of the durable cursor we persisted.
                self.assertGreaterEqual(os.path.getsize(xpart), done_sum)
        finally:
            srv.stop()
            rs.kill()


class UsbWindowTests(unittest.TestCase):
    def test_usb_download_is_correct(self):
        tmp = tempfile.mkdtemp(prefix="xeno-usb.")
        rs = RangeServerProcess(os.path.join(tmp, "files")).start()
        srv = XenoServer(os.path.join(tmp, "data"), env={"XENO_HOST_USB": "1"}).start()
        try:
            want = rs.sha256("mid.bin")
            job = srv.add(url=f"{rs.base}/ok/mid.bin", filename="usb.bin", format="BIN", sha256=want, connections=8)
            j = srv.wait_job(job["id"], "done", timeout=90)
            self.assertEqual(j["state"], "done")
            self.assertEqual(harness.sha256_file(j["path"]), want, "USB bounded-window bytes must be correct")
        finally:
            srv.stop()
            rs.kill()


class ArchivePasswordTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp(prefix="xeno-zip.")
        cls.rs = RangeServerProcess(os.path.join(cls.tmp, "files")).start()

    @classmethod
    def tearDownClass(cls):
        cls.rs.kill()

    def _server(self, name):
        srv = XenoServer(os.path.join(self.tmp, name)).start()
        srv.api("PUT", "/api/settings", {"downloads": {"extractZip": True, "deleteArchiveAfterExtract": False}})
        return srv

    def test_community_password_auto(self):
        srv = self._server("data-com")
        try:
            job = srv.add(url=f"{self.rs.base}/ok/secretcom.zip", filename="secretcom.zip", format="ZIP")
            j = srv.wait_job(job["id"], "extracted", timeout=90)
            out = os.path.join(srv.data_dir, "downloads", "homebrew", "PPSA07001 Community.ffpfsc")
            self.assertEqual(j["extract"]["dir"], out)
            self.assertTrue(os.path.exists(out))
            self.assertEqual(harness.sha256_file(out), community_entry_sha())
        finally:
            srv.stop()

    def test_custom_password_required(self):
        srv = self._server("data-pw")
        try:
            # no password + not in the community list → extraction fails cleanly
            job = srv.add(url=f"{self.rs.base}/ok/secretpw.zip", filename="secretpw.zip", format="ZIP")
            j = srv.wait_job(job["id"], None, timeout=90, until=lambda x: x["extract"]["state"] in ("failed", "extracted"))
            self.assertEqual(j["extract"]["state"], "failed")
            self.assertEqual(j["state"], "done")
            # with the right override password → extracts
            job = srv.add(url=f"{self.rs.base}/ok/secretpw.zip", filename="secretpw2.zip", format="ZIP", password="xeno-secret-42")
            j = srv.wait_job(job["id"], "extracted", timeout=90)
            out = os.path.join(srv.data_dir, "downloads", "homebrew", "PPSA07002 Custom.ffpfsc")
            self.assertTrue(os.path.exists(out))
            self.assertEqual(harness.sha256_file(out), community_entry_sha())
        finally:
            srv.stop()

    def test_zip_slip_refused(self):
        srv = self._server("data-slip")
        try:
            job = srv.add(url=f"{self.rs.base}/ok/slip.zip", filename="slip.zip", format="ZIP")
            j = srv.wait_job(job["id"], "extracted", timeout=90)
            root = os.path.join(srv.data_dir, "downloads")
            dump = j["extract"]["dir"]
            # only the safe entries survive; every slip entry is skipped
            self.assertTrue(os.path.exists(os.path.join(dump, "safe", "keep.bin")))
            self.assertTrue(os.path.exists(os.path.join(dump, "safe", "readme.txt")))
            # the evil entries are named slip-*.bin; the legit archive is slip.zip
            for base in (self.tmp, root, os.path.dirname(root), os.path.dirname(self.tmp)):
                for dirpath, _, files in os.walk(base):
                    for f in files:
                        self.assertFalse(f.startswith("slip-"), os.path.join(dirpath, f))
            # the __MACOSX junk entry is dropped, not written
            self.assertFalse(os.path.exists(os.path.join(dump, "__MACOSX")))
        finally:
            srv.stop()


if __name__ == "__main__":
    unittest.main()
