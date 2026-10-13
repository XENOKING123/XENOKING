"""Backports (SPEC §17.13), Phase 2 game fields (§17.1) and the §17.12 audit application in merge.py,
plus the Phase 2 validation rules in schema.py."""
from __future__ import annotations

import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

import merge  # noqa: E402
from schema import Game, Release, SourceInfo, validate_catalog  # noqa: E402

SOURCES = [
    SourceInfo(id="archive", name="Archive.org", kind="direct", homepage="https://archive.org"),
    SourceInfo(id="vikingfile", name="Vikingfile", kind="browser", homepage="https://vikingfile.com"),
    SourceInfo(id="dlpsgame", name="DLPSGAME", kind="page", homepage="https://dlpsgame.com", password="DLPSGAME.COM"),
    SourceInfo(id="pkgzone", name="pkg-zone", kind="direct", homepage="https://pkg-zone.com"),
]
GEN = "2026-10-13T00:00:00Z"


def rel(url, source="archive", **kw):
    base = dict(id="", url=url, sourceId=source, provider="Archive.org", format="PKG", kind="game")
    base.update(kw)
    return Release(**base)


def draft(title, platform, releases, source="blackbox", priority=100, **kw):
    return merge.GameDraft(source=source, title=title, platform=platform, releases=releases, priority=priority, **kw)


def build(drafts, **kw):
    return merge.merge_drafts(drafts, SOURCES, revision=1, generated_at=GEN, **kw)


class BackportParsingTests(unittest.TestCase):
    def test_parse_backport(self):
        cases = {
            "Hogwarts Legacy [BP 9.00] v1.05.pkg": (True, "9.00"),
            "Octopath Traveler 2 (PPSA09809)[v01.00][BP4.xx].ffpfsc": (True, "4.xx"),
            "Game Backport 5.05": (True, "5.05"),
            "Game backported to 11.00": (True, "11.00"),
            "Game 7.61 backport.pkg": (True, "7.61"),
            "Game (Backported)": (True, ""),
            "Game (BP)": (True, ""),
            "BPM: Bullets Per Minute": (False, ""),
            "Update 1.37 (Fix 5.05/6.72)": (False, ""),
            "": (False, ""),
        }
        for text, want in cases.items():
            with self.subTest(text=text):
                self.assertEqual(merge.parse_backport(text), want)

    def test_lowest_firmware_and_requires_fw(self):
        self.assertEqual(merge.lowest_firmware(["9.xx", "5.05", "6.72"]), "5.05")
        self.assertEqual(merge.lowest_firmware(["11.xx+"]), "11.xx+")
        self.assertEqual(merge.lowest_firmware([]), "")
        self.assertEqual(merge.requires_fw(["9.xx", "13.60"], "5.05"), "5.05")
        self.assertEqual(merge.requires_fw(["9.xx", "13.60"], ""), "9.xx")

    def test_detect_kind_backport(self):
        self.assertEqual(merge.detect_kind("Backport 9.00 :", ""), "backport")
        self.assertEqual(merge.detect_kind("Update 1.05 [Backport 5.05]", ""), "backport")
        self.assertEqual(merge.detect_kind("", "Game-[BP 9.00]-v1.05.pkg", "PKG"), "backport")
        self.assertEqual(merge.detect_kind("", "Game (PPSA1)[BP4.xx].ffpfsc", "FFPFSC"), "game")   # full image stays a game
        self.assertEqual(merge.detect_kind("", "CUSA00003-patch-01.28.pkg", "PKG"), "update")

    def test_series_slug(self):
        self.assertEqual(merge.series_slug("The Last of Us Part II"), "last-of-us")
        self.assertEqual(merge.series_slug("God of War: Ragnarok"), "god-of-war")
        self.assertEqual(merge.series_slug("Cyberpunk 2077"), "cyberpunk")
        self.assertEqual(merge.series_slug("Final Fantasy VII Remake"), "final-fantasy")
        self.assertEqual(merge.series_slug("Marvel's Spider-Man 2"), "marvels-spider-man")
        self.assertEqual(merge.series_slug("Gran Turismo 7"), "gran-turismo")
        self.assertEqual(merge.series_slug("Returnal"), "returnal")


class MergeBackportTests(unittest.TestCase):
    def test_backport_releases_get_fw_fields_and_counts(self):
        cat, _ = build([draft("Game", "PS4", [
            rel("https://a/game.pkg", filename="Game-CUSA00001-v1.00.pkg"),
            rel("https://a/bp.pkg", filename="Game [BP 5.05] v1.05.pkg"),
            rel("https://a/up.pkg", kind="update", filename="Game Update v1.10 (Fix 9.00/11.00).pkg"),
            rel("https://a/dlc.pkg", kind="dlc", filename="Game DLC pack.pkg"),
        ])])
        g = cat.games[0]
        by = {r.url: r for r in g.releases}
        bp = by["https://a/bp.pkg"]
        self.assertEqual((bp.kind, bp.backportFw, bp.requiresFw, bp.compat), ("backport", "5.05", "5.05", "5.05"))
        up = by["https://a/up.pkg"]
        self.assertEqual((up.kind, up.backportFw, up.requiresFw), ("update", "", "9.00"))
        self.assertEqual(by["https://a/game.pkg"].requiresFw, "")
        self.assertEqual((g.updates, g.dlc, g.backports), (1, 1, 1))
        self.assertEqual([r.kind for r in g.releases], ["game", "backport", "update", "dlc"])
        self.assertIn("5.05", g.compat)
        self.assertEqual(validate_catalog(cat.to_dict()), [])

    def test_full_image_with_backport_tag_stays_a_game_but_counts(self):
        cat, _ = build([draft("Stellar Blade", "PS5", [
            rel("https://a/sb.ffpfsc", format="FFPFSC", filename="Stellar Blade (PPSA13197)[v01.14]+[DLC&BP4.xx] 41.1GB.ffpfsc"),
        ])])
        g = cat.games[0]
        r = g.releases[0]
        self.assertEqual((r.kind, r.backportFw, r.requiresFw, r.compat), ("game", "4.xx", "4.xx", "4.xx"))
        self.assertEqual(g.backports, 1)

    def test_backport_without_target_firmware_falls_back_to_update_or_game(self):
        cat, _ = build([draft("Game", "PS4", [
            rel("https://a/x.pkg", kind="backport", filename="Game Update (Backported).pkg"),
            rel("https://a/y.pkg", kind="backport", filename="Game (BP).pkg"),
        ])])
        kinds = {r.url: r.kind for r in cat.games[0].releases}
        self.assertEqual(kinds, {"https://a/x.pkg": "update", "https://a/y.pkg": "game"})
        self.assertEqual(validate_catalog(cat.to_dict()), [])

    def test_phase2_game_fields_year_series_screenshots_fallback(self):
        cat, _ = build([draft("The Last of Us Part II", "PS5", [rel("https://a/t.ffpfsc", format="FFPFSC")],
                              releaseDate="2024-01-19", hero="https://cdn.prosperopatches.com/t/pic0.webp",
                              heroFallback="https://image.api.playstation.com/t/hero.png",
                              cover="https://cdn.prosperopatches.com/t/icon0.webp",
                              screenshots=[], features=["Single-player", "Single-player", ""], languages=["English"],
                              metacritic=93, ageRating=18, about="Long text", steamId=0)])
        g = cat.games[0]
        self.assertEqual(g.year, 2024)
        self.assertEqual(g.series, "last-of-us")
        self.assertEqual(g.screenshots, ["https://cdn.prosperopatches.com/t/pic0.webp", "https://image.api.playstation.com/t/hero.png"])
        self.assertEqual(g.features, ["Single-player"])
        self.assertEqual((g.metacritic, g.ageRating, g.about), (93, 18, "Long text"))
        doc = cat.to_dict()["games"][0]
        for key in ("screenshots", "about", "metacritic", "features", "ageRating", "languages", "year", "updates", "dlc",
                    "backports", "series", "steamId", "cheats", "conceptId", "psStoreUrl", "category", "author", "supportsPs5"):
            self.assertIn(key, doc)
        for key in ("health", "backportFw", "requiresFw"):
            self.assertIn(key, doc["releases"][0])
        self.assertEqual(validate_catalog(cat.to_dict()), [])

    def test_enrichers_run_before_ranking_and_metacritic_cheats_raise_popularity(self):
        def enrich(game: Game) -> None:
            if game.title == "Rated":
                game.metacritic = 95
                game.cheats = 20
        cat, _ = build([
            draft("Rated", "PS5", [rel("https://a/r.ffpfsc", format="FFPFSC")]),
            draft("Plain", "PS5", [rel("https://a/p.ffpfsc", format="FFPFSC")]),
        ], enrichers=[enrich])
        pop = {g.title: g.popularity for g in cat.games}
        self.assertGreater(pop["Rated"], pop["Plain"])
        self.assertEqual(next(g for g in cat.games if g.title == "Rated").metacritic, 95)

    def test_bad_enriched_values_are_sanitized(self):
        def enrich(game: Game) -> None:
            game.metacritic = 250
            game.ageRating = -1
            game.screenshots = ["https://a/1.jpg", "https://a/1.jpg", "ftp://x"] + [f"https://a/{i}.jpg" for i in range(2, 20)]
        cat, _ = build([draft("G", "PS5", [rel("https://a/g.ffpfsc", format="FFPFSC")])], enrichers=[enrich])
        g = cat.games[0]
        self.assertIsNone(g.metacritic)
        self.assertIsNone(g.ageRating)
        self.assertEqual(len(g.screenshots), 10)
        self.assertEqual(validate_catalog(cat.to_dict()), [])


class MergeAuditTests(unittest.TestCase):
    def test_dead_dropped_health_set_verified_recomputed(self):
        audit = {
            "https://a/dead.pkg": {"verdict": "dead", "checkedAt": "2026-10-10T00:00:00Z"},
            "https://a/dead2.pkg": {"verdict": "dead", "checkedAt": "2026-10-10T00:00:00Z"},
            "https://a/ok.pkg": {"verdict": "ok", "checkedAt": "2026-10-10T00:00:00Z"},
            "https://a/flaky.pkg": {"verdict": "flaky", "checkedAt": "2026-10-10T00:00:00Z"},
            "https://a/html.pkg": {"verdict": "page", "checkedAt": "2026-10-10T00:00:00Z"},
            "https://dlpsgame.com/x/": {"verdict": "ok", "checkedAt": "2026-10-10T00:00:00Z"},
        }
        cat, rep = build([
            draft("Game", "PS4", [
                rel("https://a/dead.pkg", verifiedAt="2026-01-01"),
                rel("https://a/ok.pkg"),
                rel("https://a/flaky.pkg", verifiedAt="2026-01-01"),
                rel("https://a/html.pkg"),
                rel("https://a/unaudited.pkg"),
                rel("https://dlpsgame.com/x/", source="dlpsgame", format="PAGE"),
            ]),
            draft("Only dead", "PS4", [rel("https://a/dead2.pkg")], source="orbit", priority=90),
            draft("Page only", "PS4", [rel("https://dlpsgame.com/y/", source="dlpsgame", format="PAGE", verifiedAt="2026-01-01")]),
        ], audit=audit)
        g = next(x for x in cat.games if x.title == "Game")
        by = {r.url: r for r in g.releases}
        self.assertNotIn("https://a/dead.pkg", by)
        self.assertEqual(by["https://a/ok.pkg"].health, "ok")
        self.assertEqual(by["https://a/ok.pkg"].verifiedAt, "2026-10-10")
        self.assertEqual(by["https://a/flaky.pkg"].health, "flaky")
        self.assertEqual(by["https://a/flaky.pkg"].verifiedAt, "")
        self.assertEqual(by["https://a/html.pkg"].health, "page")
        self.assertEqual(by["https://a/unaudited.pkg"].health, "")
        self.assertEqual(by["https://dlpsgame.com/x/"].health, "ok")
        self.assertTrue(g.verified)
        self.assertEqual(rep.dropped_releases.get("audit_dead"), 2)
        self.assertTrue(any("audit_dead" in s and "dead.pkg" in s for s in rep.dropped_samples))
        # "Only dead" had a single release and it is dead → the whole game is dropped and reported.
        self.assertFalse(any(x.title == "Only dead" for x in cat.games))
        self.assertEqual(rep.dropped_games.get("audit_dead"), 1)
        page_only = next(x for x in cat.games if x.title == "Page only")
        self.assertTrue(page_only.verified)   # unaudited source verification still counts
        self.assertEqual(validate_catalog(cat.to_dict()), [])

    def test_page_verdict_on_direct_release_is_not_verified(self):
        audit = {"https://a/html.pkg": {"verdict": "page", "checkedAt": "2026-10-10T00:00:00Z"}}
        cat, _ = build([draft("G", "PS4", [rel("https://a/html.pkg", verifiedAt="2026-01-01")])], audit=audit)
        self.assertFalse(cat.games[0].verified)


class Phase2ValidationTests(unittest.TestCase):
    def doc(self):
        cat, _ = build([draft("G", "PS5", [rel("https://a/g.ffpfsc", format="FFPFSC")])])
        return cat.to_dict()

    def assert_error(self, mutate, needle):
        doc = self.doc()
        mutate(doc)
        errs = validate_catalog(doc)
        self.assertTrue(any(needle in e for e in errs), errs)

    def test_rules(self):
        self.assertEqual(validate_catalog(self.doc()), [])
        self.assert_error(lambda d: d["games"][0].__setitem__("metacritic", 101), "metacritic")
        self.assert_error(lambda d: d["games"][0].__setitem__("metacritic", "84"), "metacritic")
        self.assert_error(lambda d: d["games"][0].__setitem__("ageRating", 99), "ageRating")
        self.assert_error(lambda d: d["games"][0].__setitem__("screenshots", [f"https://a/{i}" for i in range(11)]), "screenshots")
        self.assert_error(lambda d: d["games"][0].__setitem__("screenshots", ["nope"]), "screenshot")
        self.assert_error(lambda d: d["games"][0].__setitem__("year", 1800), "year")
        self.assert_error(lambda d: d["games"][0].__setitem__("updates", -1), "updates")
        self.assert_error(lambda d: d["games"][0].__setitem__("series", "Not A Slug"), "series")
        self.assert_error(lambda d: d["games"][0].__setitem__("category", "Tool"), "only valid on HOMEBREW")
        self.assert_error(lambda d: d["games"][0].__setitem__("psStoreUrl", "store.playstation.com/x"), "psStoreUrl")
        self.assert_error(lambda d: d["games"][0]["releases"][0].__setitem__("health", "dead"), "dead releases")
        self.assert_error(lambda d: d["games"][0]["releases"][0].__setitem__("health", "great"), "health")
        self.assert_error(lambda d: d["games"][0]["releases"][0].__setitem__("backportFw", "nine"), "backportFw")
        self.assert_error(lambda d: d["games"][0]["releases"][0].__setitem__("kind", "backport"), "need backportFw")
        self.assert_error(lambda d: d["games"][0]["releases"][0].__setitem__("kind", "app"), "only valid on HOMEBREW")

    def test_homebrew_rules(self):
        cat, _ = build([merge.GameDraft(source="pkgzone", title="etaHEN", platform="HOMEBREW", slugHint="etaHEN_v2",
                                        author="LightningMods", category="Payload", supportsPs5=True, priority=50,
                                        releases=[rel("https://pkg-zone.com/download/ps5/etaHEN_v2/latest", "pkgzone", kind="app",
                                                      filename="etaHEN_v2-ps5.pkg")])])
        doc = cat.to_dict()
        self.assertEqual(validate_catalog(doc), [])
        self.assertEqual(doc["games"][0]["id"], "etahen-v2-homebrew")
        self.assert_error_doc(doc, lambda d: d["games"][0].__setitem__("author", ""), "need an author")
        self.assert_error_doc(doc, lambda d: d["games"][0].__setitem__("category", "Weird"), "category must be")
        self.assert_error_doc(doc, lambda d: d["games"][0].__setitem__("titleIds", ["PPSA00001"]), "no Sony title ids")
        self.assert_error_doc(doc, lambda d: d["games"][0]["releases"][0].__setitem__("kind", "game"), "must have kind app")

    def assert_error_doc(self, doc, mutate, needle):
        import copy
        d = copy.deepcopy(doc)
        mutate(d)
        errs = validate_catalog(d)
        self.assertTrue(any(needle in e for e in errs), errs)


if __name__ == "__main__":
    unittest.main()
