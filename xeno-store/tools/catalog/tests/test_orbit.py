"""Orbit catalogue envelopes (SPEC §17.11): snapshots, BlackBox's copy, --orbit PATH, encrypted files."""
from __future__ import annotations

import json
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
sys.path.insert(0, HERE)

from fakes import FIXTURES, FakeHttp, fixture_json, make_ctx  # noqa: E402
from sources import orbit  # noqa: E402


class EnvelopeTests(unittest.TestCase):
    def test_parse_and_merge(self):
        old = orbit.parse_envelope(fixture_json("orbit_envelope_old.json"))
        new = orbit.parse_envelope(fixture_json("orbit_envelope_new.json"))
        self.assertEqual((old[0], len(old[1])), (13, 2))
        self.assertEqual((new[0], len(new[1])), (47, 1))
        self.assertEqual(orbit.parse_envelope([{"url": "https://a/1"}, {"nourl": 1}]), (0, [{"url": "https://a/1"}]))
        self.assertEqual(orbit.parse_envelope("nope"), (0, []))
        merged = orbit.merge_envelopes([new, old])
        self.assertEqual([r["id"] for r in merged], ["ppsa04029-ffpfsc", "ppsa01342-exfat"])
        astro = next(r for r in merged if r["id"] == "ppsa01342-exfat")
        self.assertEqual(astro["url"], "https://vikingfile.com/f/new-astro")   # the newer revision wins

    def test_read_envelope_file_skips_encrypted(self):
        self.assertEqual(orbit.read_envelope_file(FIXTURES / "orbit_catalogue_encrypted.json"), (0, []))
        self.assertEqual(orbit.read_envelope_file(FIXTURES / "does-not-exist.json"), (0, []))
        rev, rows = orbit.read_envelope_file(FIXTURES / "orbit_envelope_new.json")
        self.assertEqual((rev, len(rows)), (47, 1))


class SourceTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="xeno-orbit-"))
        snaps = self.tmp / "catalog" / "snapshots"
        (snaps / "orbit").mkdir(parents=True)
        (snaps / "blackbox").mkdir(parents=True)
        shutil.copy(FIXTURES / "orbit_envelope_old.json", snaps / "orbit" / "catalogue-v2.json")
        shutil.copy(FIXTURES / "orbit_catalogue_encrypted.json", snaps / "orbit" / "catalogue-v3.json")
        shutil.copy(FIXTURES / "orbit_envelope_new.json", snaps / "blackbox" / "catalogue-v2.json")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_snapshot_merges_orbit_and_blackbox_envelopes(self):
        ctx = make_ctx(FakeHttp(), mode="offline", root=self.tmp, source_id="orbit")
        drafts = orbit.load_snapshot(ctx)
        titles = {d.title: d for d in drafts}
        self.assertEqual(sorted(titles), ["ASTRO BOT", "Cyberpunk 2077"])
        self.assertEqual(titles["ASTRO BOT"].releases[0].url, "https://vikingfile.com/f/new-astro")
        self.assertEqual(titles["ASTRO BOT"].pickOrder, 1)
        self.assertEqual(titles["Cyberpunk 2077"].homeOrder, 2)
        self.assertTrue(all(d.source == "orbit" and d.priority == orbit.SOURCE.priority for d in drafts))
        self.assertTrue(any("catalogue-v3.json: not a plaintext envelope" in m for m in ctx.logs))

    def test_user_supplied_path_file_and_directory(self):
        user_dir = self.tmp / "decrypted"
        user_dir.mkdir()
        extra = json.loads((FIXTURES / "orbit_envelope_new.json").read_text(encoding="utf-8"))
        extra["revision"] = 99
        extra["releases"][0]["url"] = "https://vikingfile.com/f/user-astro"
        (user_dir / "catalogue-v9.json").write_text(json.dumps(extra), encoding="utf-8")
        single = self.tmp / "my-catalogue.json"
        single.write_text(json.dumps({"schemaVersion": 1, "revision": 5, "releases": [
            {"id": "ppsa00001-ffpfsc", "titleId": "PPSA00001", "url": "https://archive.org/download/x/y.ffpfsc", "format": "FFPFSC",
             "sourceId": "archive", "provider": "Archive.org", "title": "User Game", "gameId": "user-game"}]}), encoding="utf-8")
        ctx = make_ctx(FakeHttp(), mode="offline", root=self.tmp, source_id="orbit",
                       extra={"orbit_paths": [str(user_dir), str(single), str(self.tmp / "missing.json")]})
        drafts = orbit.load_snapshot(ctx)
        titles = {d.title: d for d in drafts}
        self.assertEqual(sorted(titles), ["ASTRO BOT", "Cyberpunk 2077", "User Game"])
        self.assertEqual(titles["ASTRO BOT"].releases[0].url, "https://vikingfile.com/f/user-astro")

    def test_online_falls_back_to_snapshots_when_feed_is_gone(self):
        http = FakeHttp([(r"raw\.githubusercontent\.com", 404)])
        ctx = make_ctx(http, root=self.tmp, source_id="orbit")
        drafts = orbit.fetch_online(ctx)
        self.assertEqual(len(drafts), 2)
        self.assertEqual(http.requests, len(orbit.ORBIT_RAW_CANDIDATES))

    def test_online_uses_a_live_plaintext_feed(self):
        live = {"schemaVersion": 1, "revision": 60, "releases": [
            {"id": "ppsa01342-exfat", "titleId": "PPSA01342", "url": "https://vikingfile.com/f/live-astro", "format": "exFAT",
             "sourceId": "vikingfile", "provider": "Vikingfile", "title": "ASTRO BOT", "gameId": "astro-bot"}]}
        http = FakeHttp([(r"/main/catalogue-v2\.json$", live), (r".*", 404)])
        drafts = orbit.fetch_online(make_ctx(http, root=self.tmp, source_id="orbit"))
        astro = next(d for d in drafts if d.title == "ASTRO BOT")
        self.assertEqual(astro.releases[0].url, "https://vikingfile.com/f/live-astro")

    def test_nothing_available_raises(self):
        empty = self.tmp / "empty"
        (empty / "catalog" / "snapshots").mkdir(parents=True)
        with self.assertRaises(FileNotFoundError):
            orbit.load_snapshot(make_ctx(FakeHttp(), mode="offline", root=empty, source_id="orbit"))


if __name__ == "__main__":
    unittest.main()
