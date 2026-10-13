"""Steam / PS Store enrichment (SPEC §17.1): parsers, caches, budgeted runs."""
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

from enrich import psstore, steam  # noqa: E402
from fakes import FakeHttp, fixture, fixture_json  # noqa: E402
from schema import Game  # noqa: E402


class SteamParserTests(unittest.TestCase):
    def test_entry_from_appdetails(self):
        data = fixture_json("steam_appdetails.json")["990080"]["data"]
        e = steam.entry_from_appdetails(data)
        self.assertEqual(e["appId"], 990080)
        self.assertEqual(len(e["screenshots"]), 8)
        self.assertEqual(e["screenshots"][0], "https://cdn.test/ss_1.1920x1080.jpg")
        self.assertTrue(e["about"].startswith("About\n\nHogwarts Legacy is an open-world action RPG"))
        self.assertNotIn("<", e["about"])
        self.assertEqual((e["developer"], e["publisher"]), ("Avalanche Software", "Warner Bros. Games"))
        self.assertEqual(e["genres"], ["Action", "RPG"])
        self.assertEqual(e["metacritic"], 84)
        self.assertEqual(e["releaseDate"], "2023-02-10")
        self.assertEqual(e["features"], ["Single-player", "Controller support"])
        self.assertEqual(e["ageRating"], 16)
        self.assertEqual(e["languages"], ["English", "French", "Italian", "German", "Spanish - Spain"])

    def test_helpers(self):
        self.assertEqual(steam.parse_release_date("9 Dec, 2020"), "2020-12-09")
        self.assertEqual(steam.parse_release_date("Coming 2027"), "2027-01-01")
        self.assertEqual(steam.parse_release_date(""), "")
        long = "<p>" + "Sentence one. " * 60 + "</p>"
        text = steam.html_to_text(long)
        self.assertLessEqual(len(text), steam.MAX_ABOUT_CHARS)
        self.assertTrue(text.endswith("."))
        items = fixture_json("steam_search.json")["items"]
        self.assertEqual(steam.pick_search_item(items, "Hogwarts Legacy"), 990080)
        self.assertEqual(steam.pick_search_item(items, "Hogwarts Legacy Deluxe Edition"), 1111)
        self.assertEqual(steam.pick_search_item(items, "Hogwarts"), 0)
        self.assertEqual(steam.pick_search_item([{"type": "dlc", "name": "Hogwarts Legacy", "id": 5}], "Hogwarts Legacy"), 0)

    def test_apply_entry_fills_gaps_only(self):
        e = steam.entry_from_appdetails(fixture_json("steam_appdetails.json")["990080"]["data"])
        g = Game(id="hogwarts-legacy-ps5", slug="hogwarts-legacy", title="Hogwarts Legacy", platform="PS5",
                 publisher="WB Games", genres=["Adventure"], releaseDate="2023-02-07")
        steam.apply_entry(g, e)
        self.assertEqual(g.publisher, "WB Games")
        self.assertEqual(g.genres, ["Adventure"])
        self.assertEqual(g.releaseDate, "2023-02-07")
        self.assertEqual(g.developer, "Avalanche Software")
        self.assertEqual(g.metacritic, 84)
        self.assertEqual(g.steamId, 990080)
        self.assertEqual(len(g.screenshots), 8)


class SteamRunTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="xeno-steam-"))

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_run_caches_hits_misses_and_stops_on_429(self):
        http = FakeHttp([
            (r"storesearch/\?.*term=Hogwarts\+Legacy", fixture_json("steam_search.json")),
            (r"storesearch/\?.*term=Nothing\+Here", {"total": 0, "items": []}),
            (r"storesearch/\?.*term=Rate\+Limited", 429),
            (r"appdetails\?appids=990080", fixture_json("steam_appdetails.json")),
        ])
        cache = steam.SteamCache(self.tmp / "steam-cache.json")
        client = steam.SteamClient(http)
        stats = steam.run(client, cache, ["Hogwarts Legacy", "Nothing Here", "Rate Limited", "Never Reached"], 60, lambda m: None)
        self.assertEqual((stats["hits"], stats["misses"], stats["errors"], stats["stoppedBy"]), (1, 1, 1, 429))
        self.assertIsNotNone(cache.get("Hogwarts Legacy"))
        self.assertIsNone(cache.get("Nothing Here"))
        self.assertFalse(cache.needs_lookup("Nothing Here"))     # a miss is remembered
        self.assertTrue(cache.needs_lookup("Never Reached"))
        self.assertTrue((self.tmp / "steam-cache.json").exists())
        again = steam.SteamCache(self.tmp / "steam-cache.json")
        self.assertEqual(sorted(again.entries), ["hogwarts legacy", "nothing here"])
        self.assertEqual(again.get("hogwarts legacy")["metacritic"], 84)
        # a second run with the same titles costs no requests
        before = http.requests
        steam.run(client, again, ["Hogwarts Legacy", "Nothing Here"], 60, lambda m: None)
        self.assertEqual(http.requests, before)

    def test_zero_budget_does_nothing(self):
        http = FakeHttp([(r".*", 500)])
        cache = steam.SteamCache(self.tmp / "c.json")
        stats = steam.run(steam.SteamClient(http), cache, ["A", "B"], 0, lambda m: None)
        self.assertEqual(stats["looked"], 0)
        self.assertEqual(http.requests, 0)

    def test_enricher_is_cache_only(self):
        cache = steam.SteamCache(self.tmp / "c.json")
        cache.put("Hogwarts Legacy", steam.entry_from_appdetails(fixture_json("steam_appdetails.json")["990080"]["data"]))
        fn = steam.enricher(cache)
        g = Game(id="hogwarts-legacy-ps4", slug="hogwarts-legacy", title="Hogwarts Legacy: Deluxe Edition", platform="PS4")
        fn(g)
        self.assertEqual(g.metacritic, 84)
        hb = Game(id="x-homebrew", slug="x", title="Hogwarts Legacy", platform="HOMEBREW")
        fn(hb)
        self.assertIsNone(hb.metacritic)


class PsStoreTests(unittest.TestCase):
    def test_parse_store_page(self):
        e = psstore.parse_store_page(fixture("psstore_page.html"))
        self.assertEqual(e["screenshots"], ["https://image.api.playstation.com/vulcan/ap/rnd/202111/3013/shot1.jpg",
                                            "https://image.api.playstation.com/vulcan/ap/rnd/202111/3013/shot2.jpg"])
        self.assertTrue(e["about"].startswith("Cyberpunk 2077 is an open-world, action-adventure RPG"))
        self.assertIn("—", e["about"])
        self.assertEqual(e["cover"], "https://image.api.playstation.com/vulcan/ap/rnd/202111/3013/cover.png")
        empty = psstore.parse_store_page("<html><body>nothing</body></html>")
        self.assertEqual(empty, {"screenshots": [], "about": "", "cover": ""})
        broken = psstore.parse_store_page('<script id="__NEXT_DATA__" type="application/json">{not json</script>'
                                          '<meta property="og:description" content="A long enough description of the game to count here." />')
        self.assertEqual(broken["screenshots"], [])
        self.assertTrue(broken["about"].startswith("A long enough"))

    def test_run_and_cache(self):
        tmp = Path(tempfile.mkdtemp(prefix="xeno-ps-"))
        try:
            url = "https://store.playstation.com/en-us/concept/10000974"
            gone = "https://store.playstation.com/en-us/concept/1"
            http = FakeHttp([(r"concept/10000974", fixture("psstore_page.html")), (r"concept/1$", 404)])
            cache = psstore.PsStoreCache(tmp / "ps.json")
            stats = psstore.run(http, cache, [url, gone, "https://evil.test/x", url], 30, lambda m: None)
            self.assertEqual((stats["looked"], stats["hits"], stats["errors"]), (1, 1, 1))
            self.assertEqual(http.requests, 2)
            g = Game(id="c-ps5", slug="c", title="Cyberpunk 2077", platform="PS5", psStoreUrl=url)
            psstore.enricher(psstore.PsStoreCache(tmp / "ps.json"))(g)
            self.assertEqual(len(g.screenshots), 2)
            self.assertTrue(g.about)
            self.assertFalse(cache.needs_lookup(gone))
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
