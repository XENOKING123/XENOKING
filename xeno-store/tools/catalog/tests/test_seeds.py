"""Offline enrichment from the bundled seeds (SPEC §17.9)."""
from __future__ import annotations

import json
import os
import shutil
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
sys.path.insert(0, HERE)

from enrich import seeds  # noqa: E402
from fakes import fixture_json  # noqa: E402
from schema import Game, Release  # noqa: E402


def make_seeds() -> seeds.Seeds:
    return seeds.Seeds.from_documents(fixture_json("seeds_titles.json"), fixture_json("seeds_cheats.json"), fixture_json("seeds_covers.json"))


def game(title, platform, title_ids=(), **kw) -> Game:
    g = Game(id="x-" + platform.lower(), slug="x", title=title, platform=platform, titleIds=list(title_ids),
             releases=[Release(id="r", url="https://a/x.pkg", sourceId="archive", format="PKG", titleId=title_ids[0] if title_ids else "")])
    for k, v in kw.items():
        setattr(g, k, v)
    return g


class SeedIndexTests(unittest.TestCase):
    def test_index(self):
        s = make_seeds()
        self.assertEqual(sorted(s.by_id), ["CUSA00002", "CUSA00207", "CUSA00299", "CUSA12345", "PPSA03243", "PPSA03244"])  # NPIA skipped
        self.assertEqual(s.by_id["CUSA00207"].region, "USA")
        self.assertEqual(s.by_id["CUSA00299"].region, "EUR")
        self.assertEqual(s.by_id["CUSA12345"].region, "JPN")
        self.assertEqual(s.by_id["CUSA00002"].name, "KILLZONE™ SHADOW FALL")
        self.assertEqual(s.by_name["killzone shadow fall"], ["CUSA00002"])
        self.assertEqual(s.by_name["bloodborne"], ["CUSA00207", "CUSA00299"])
        self.assertEqual(s.cheats_for(["CUSA00207"]), 4)                 # unique across versions
        self.assertEqual(s.cheats_for(["CUSA00207", "CUSA00299"]), 4)    # 'godmode' case-folds onto 'Godmode'
        self.assertEqual(s.cheats_for(["CUSA00002"]), 2)                 # names unknown: cheatsTotal counted
        self.assertEqual(s.cheats_for(["PPSA03243"]), 0)
        self.assertEqual(s.cover_for("Bloodborne™"), "https://image.api.playstation.com/cdn/UP9000/CUSA00207_00/bloodborne.png")
        self.assertEqual(s.cover_for("Killzone Shadow Fall"), "")        # 'no-image' is not a URL

    def test_region_for_content_id(self):
        self.assertEqual(seeds.region_for_content_id("UP9000-CUSA00207_00-X"), "USA")
        self.assertEqual(seeds.region_for_content_id("EP9000-CUSA00207_00-X"), "EUR")
        self.assertEqual(seeds.region_for_content_id("JP0123-X"), "JPN")
        self.assertEqual(seeds.region_for_content_id("HP0123-X"), "ASIA")
        self.assertEqual(seeds.region_for_content_id("IP9100-X"), "")
        self.assertEqual(seeds.region_for_content_id(""), "")

    def test_ids_for_name_prefers_platform_and_region(self):
        s = make_seeds()
        self.assertEqual(s.ids_for_name("Hogwarts Legacy", "PS5"), ["PPSA03244", "PPSA03243"])   # USA first, then EUR
        self.assertEqual(s.ids_for_name("Hogwarts Legacy", "PS4"), ["CUSA12345"])
        self.assertEqual(s.ids_for_name("Hogwarts Legacy: Digital Deluxe Edition (PS5)", "PS5"), ["PPSA03244", "PPSA03243"])
        self.assertEqual(s.ids_for_name("Unknown Game", "PS5"), [])


class EnrichTests(unittest.TestCase):
    def test_name_only_entry_gets_ids_concept_region_cheats_cover(self):
        s = make_seeds()
        g = game("Bloodborne", "PS4")
        g.releases[0].titleId = ""
        s.enrich(g)
        self.assertEqual(g.titleIds, ["CUSA00207", "CUSA00299"])
        self.assertEqual(g.conceptId, 201500)
        self.assertEqual(g.psStoreUrl, "https://store.playstation.com/en-us/concept/201500")
        self.assertIn(g.region, ("USA", "EUR"))
        self.assertEqual(g.cheats, 4)
        self.assertEqual(g.cover, "https://image.api.playstation.com/cdn/UP9000/CUSA00207_00/bloodborne.png")
        self.assertEqual(s.stats.titleIdsFilled, 1)

    def test_known_id_entry_keeps_its_ids_and_fills_release_region(self):
        s = make_seeds()
        g = game("Hogwarts Legacy", "PS5", ["PPSA03243"], cover="https://cdn/x.webp")
        s.enrich(g)
        self.assertEqual(g.titleIds, ["PPSA03243"])
        self.assertEqual(g.region, "EUR")
        self.assertEqual(g.releases[0].region, "EUR")
        self.assertEqual(g.conceptId, 10000001)
        self.assertEqual(g.cheats, 0)
        self.assertEqual(g.cover, "https://cdn/x.webp")
        self.assertEqual(g.coverFallback, "https://image.api.playstation.com/vulcan/ap/rnd/202208/0921/hogwarts.png")

    def test_title_id_only_title_gets_the_official_name(self):
        s = make_seeds()
        g = game("CUSA00002", "PS4", ["CUSA00002"])
        s.enrich(g)
        self.assertEqual(g.title, "KILLZONE SHADOW FALL")
        self.assertEqual(g.cheats, 2)
        self.assertEqual(s.stats.namesResolved, 1)

    def test_homebrew_and_existing_values_untouched(self):
        s = make_seeds()
        g = game("RetroArch", "HOMEBREW")
        s.enrich(g)
        self.assertEqual((g.titleIds, g.cheats, g.psStoreUrl), ([], 0, ""))
        g2 = game("Bloodborne", "PS4", ["CUSA00207"], region="JPN", psStoreUrl="https://store.playstation.com/en-us/product/X", cheats=9)
        s.enrich(g2)
        self.assertEqual((g2.region, g2.psStoreUrl, g2.cheats), ("JPN", "https://store.playstation.com/en-us/product/X", 9))

    def test_load_from_repo_layout_and_missing_zip(self):
        tmp = Path(tempfile.mkdtemp(prefix="xeno-seeds-"))
        try:
            logs = []
            self.assertIsNone(seeds.Seeds.load(tmp, logs.append))
            self.assertTrue(any("not found" in m for m in logs))
            (tmp / seeds.SEED_ZIP).parent.mkdir(parents=True)
            with zipfile.ZipFile(tmp / seeds.SEED_ZIP, "w") as z:
                z.writestr("All_Titles.json", json.dumps(fixture_json("seeds_titles.json")))
                z.writestr("cheatslist.json", json.dumps(fixture_json("seeds_cheats.json")))
            (tmp / seeds.COVERS_JSON).parent.mkdir(parents=True)
            (tmp / seeds.COVERS_JSON).write_text(json.dumps(fixture_json("seeds_covers.json")), encoding="utf-8")
            s = seeds.Seeds.load(tmp, logs.append)
            self.assertIsNotNone(s)
            self.assertEqual(len(s.by_id), 6)
            self.assertEqual(len(s.covers), 2)
            fn, obj = seeds.enricher(tmp, logs.append)
            self.assertIsNotNone(fn)
            g = game("Bloodborne", "PS4")
            fn(g)
            self.assertEqual(g.cheats, 4)
            # a corrupt zip is reported, never raised
            (tmp / seeds.SEED_ZIP).write_bytes(b"not a zip")
            self.assertIsNone(seeds.Seeds.load(tmp, logs.append))
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    def test_real_repo_seeds_when_present(self):
        from fakes import PROJECT_ROOT
        repo = PROJECT_ROOT.parent
        if not (repo / seeds.SEED_ZIP).exists():
            self.skipTest("bundled seeds not in this checkout")
        s = seeds.Seeds.load(repo, lambda m: None)
        self.assertGreater(len(s.by_id), 60000)
        self.assertEqual(s.by_id["CUSA00003"].name, "DRIVECLUB™")
        self.assertGreater(len(s.cheats_by_id), 1800)
        self.assertGreater(len(s.covers), 1000)


if __name__ == "__main__":
    unittest.main()
