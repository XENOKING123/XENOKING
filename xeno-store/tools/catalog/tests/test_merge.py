"""Unit tests for the catalog pipeline (stdlib unittest).

Run from xeno-store/:  python3 -I -m unittest discover -s tools/catalog/tests -v
"""
from __future__ import annotations

import json
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

import merge  # noqa: E402
import schema  # noqa: E402
from schema import Release, SourceInfo, validate_catalog  # noqa: E402
from sources import dlpsgame  # noqa: E402
from sources import blackbox  # noqa: E402

SOURCES = [
    SourceInfo(id="archive", name="Archive.org", kind="direct", homepage="https://archive.org"),
    SourceInfo(id="vikingfile", name="Vikingfile", kind="browser", homepage="https://vikingfile.com"),
    SourceInfo(id="dlpsgame", name="DLPSGAME", kind="page", homepage="https://dlpsgame.com", password="DLPSGAME.COM"),
]
GEN = "2026-10-13T00:00:00Z"


def rel(url: str, source: str = "archive", **kw) -> Release:
    base = dict(id="", url=url, sourceId=source, provider="Archive.org", format="FFPFSC", kind="game")
    base.update(kw)
    return Release(**base)


def draft(title: str, platform: str, releases: list[Release], source: str = "blackbox", priority: int = 100, **kw) -> merge.GameDraft:
    return merge.GameDraft(source=source, title=title, platform=platform, releases=releases, priority=priority, **kw)


def build(drafts, previous=None):
    return merge.merge_drafts(drafts, SOURCES, revision=1, generated_at=GEN, previous=previous)


class TitleNormalizationTests(unittest.TestCase):
    def test_clean_title_strips_site_noise(self):
        cases = {
            "The Witcher 3: Wild Hunt – Complete Edition PS4 [FPKG] v1.03": "The Witcher 3: Wild Hunt - Complete Edition",
            "God of War Ragnarök (PPSA08330) [BP 9.00]": "God of War Ragnarök",
            "Hunting Simulator 2 PS4 [FPkg]": "Hunting Simulator 2",
            "Stellar Blade (PPSA13197)[v01.14]+[DLC&BP4.xx] 41.1GB": "Stellar Blade",
            "Marvel's Spider-Man 2 PS5 Download": "Marvel's Spider-Man 2",
            "DRIVECLUB™": "DRIVECLUB",
            "3D MiniGolf": "3D MiniGolf",
            "Cyberpunk 2077 (EUR) (CUSA16579)": "Cyberpunk 2077",
        }
        for raw, want in cases.items():
            with self.subTest(raw=raw):
                self.assertEqual(merge.clean_title(raw), want)

    def test_normalize_title_groups_editions_and_punctuation(self):
        self.assertEqual(merge.normalize_title("Cyberpunk 2077: Ultimate Edition (PS5)"), "cyberpunk 2077")
        self.assertEqual(merge.normalize_title("cyberpunk 2077"), "cyberpunk 2077")
        self.assertEqual(merge.normalize_title("Assassin’s Creed Shadows"), merge.normalize_title("Assassins Creed Shadows"))
        self.assertEqual(merge.normalize_title("The Last of Us Part II"), "last of us part 2")
        self.assertEqual(merge.normalize_title("Final Fantasy VII Remake"), "final fantasy vii remake")
        self.assertEqual(merge.normalize_title("God of War Ragnarök"), "god of war ragnarok")
        self.assertEqual(merge.normalize_title("Mafia: Definitive Edition"), "mafia definitive edition")
        self.assertEqual(merge.normalize_title("Skyrim Anniversary Edition"), "skyrim")

    def test_slugify(self):
        self.assertEqual(merge.slugify("god of war ragnarok"), "god-of-war-ragnarok")
        self.assertEqual(merge.slugify("  ***  "), "untitled")


class ParsingTests(unittest.TestCase):
    def test_title_ids(self):
        self.assertEqual(merge.parse_title_ids("PPSA04029 Cyberpunk (CUSA16579) PCAS00001 ppsa04029"), ["PPSA04029", "CUSA16579", "PCAS00001"])
        self.assertEqual(merge.platform_for_title_id("CUSA00003"), "PS4")
        self.assertEqual(merge.platform_for_title_id("PPSA00003"), "PS5")
        self.assertEqual(merge.platform_for_title_id("XXXX00003"), "")

    def test_versions(self):
        self.assertEqual(merge.parse_version("PPSA25380 ELDEN RING NIGHTREIGN 9.xx (01.003.002).ffpfsc"), "01.003.002")
        self.assertEqual(merge.parse_version("CUSA00003-game-01.28-r04102304a5dc.pkg"), "01.28")
        self.assertEqual(merge.parse_version("DRIVECLUB - [EU] [EN] [1.28].pkg"), "1.28")
        self.assertEqual(merge.parse_version("Update 1.37 (Fix 5.05/6.72/7.55)"), "1.37")
        self.assertEqual(merge.parse_version("Game v1.000.002 13.60.rar"), "1.000.002")
        self.assertEqual(merge.parse_version("PPSA26786 Indiana Jones 10.xx.ffpfsc"), "")
        self.assertEqual(merge.parse_version("Something 13.60.pkg"), "")

    def test_regions(self):
        self.assertEqual(merge.parse_region("DRIVECLUB - [EU] [EN] [1.28].pkg"), "EUR")
        self.assertEqual(merge.parse_region("Flower - [US] [EN] [1.00].pkg"), "USA")
        self.assertEqual(merge.parse_region("EUR (exFAT)"), "EUR")
        self.assertEqual(merge.parse_region("Game (JPN) v1.00"), "JPN")
        self.assertEqual(merge.parse_region("ASIA"), "ASIA")
        self.assertEqual(merge.parse_region("Nothing here"), "")

    def test_compat_tags(self):
        self.assertEqual(merge.parse_compat("PPSA25380 ELDEN RING NIGHTREIGN 9.xx (01.003.002).ffpfsc"), ["9.xx"])
        self.assertEqual(merge.parse_compat("Octopath Traveler 2 (PPSA09809)[v01.00][BP4.xx] 6.26GB.ffpfsc"), ["4.xx"])
        self.assertEqual(merge.parse_compat("Tales of Berseria (PPSA22826)[v01.02][11.xx+].ffpfsc"), ["11.xx+"])
        self.assertEqual(merge.parse_compat("Update 1.37 (Fix 5.05/6.72/7.55)"), ["5.05", "6.72", "7.55"])
        self.assertEqual(merge.parse_compat("Game 13.60 v1.000.002.rar"), ["13.60"])
        self.assertEqual(merge.parse_compat("CUSA00003-game-01.28.pkg"), [])

    def test_kind_and_format(self):
        self.assertEqual(merge.detect_kind("Update 1.37 : Lets", ""), "update")
        self.assertEqual(merge.detect_kind("DLC (18) :", ""), "dlc")
        self.assertEqual(merge.detect_kind("Game :", ""), "game")
        self.assertEqual(merge.detect_kind("", "CUSA00003-patch-01.28.pkg", "PKG"), "update")
        self.assertEqual(merge.detect_kind("", "CUSA00003-dlc-pack.pkg", "PKG"), "dlc")
        self.assertEqual(merge.detect_kind("", "Stellar Blade [v01.14]+[DLC&BP4.xx].ffpfsc", "FFPFSC"), "game")
        self.assertEqual(merge.format_from_filename("x.ffpfsc"), "FFPFSC")
        self.assertEqual(merge.format_from_filename("x.exfat"), "exFAT")
        self.assertEqual(merge.format_from_filename("x.part1.rar"), "RAR")
        self.assertEqual(merge.format_from_filename("https://host/file.7z?dl=1"), "7z")
        self.assertEqual(merge.format_from_filename("https://host/page/"), "")
        self.assertEqual(merge.normalize_format("exfat"), "exFAT")
        self.assertEqual(merge.normalize_format("", "https://x/y/"), "PAGE")

    def test_genres(self):
        self.assertEqual(merge.normalize_genres("Role Playing Games / Action"), ["Action", "RPG"])
        self.assertEqual(merge.normalize_genres(["Driving/Racing", "Sport", "Simulator"]), ["Racing", "Sports", "Simulation"])
        self.assertEqual(merge.normalize_genres("Action RPG"), ["Action", "RPG"])
        self.assertEqual(merge.normalize_genres("Unknown Thing"), [])
        self.assertEqual(merge.normalize_genres(None), [])
        for g in merge.normalize_genres("Party / Casual / Platform / Rhythm"):
            self.assertIn(g, schema.GENRES)

    def test_art_ranking(self):
        primary, fallback = merge.pick_art([
            ("https://dlpsgame.com/cover.jpg", 60),
            ("https://image.api.playstation.com/x.png", 50),
            ("https://cdn.prosperopatches.com/titles/x/icon0.webp", 10),
        ])
        self.assertEqual(primary, "https://cdn.prosperopatches.com/titles/x/icon0.webp")
        self.assertEqual(fallback, "https://image.api.playstation.com/x.png")
        self.assertEqual(merge.pick_art([("", 1), ("ftp://no", 1)]), ("", ""))


class GroupingTests(unittest.TestCase):
    def test_groups_by_normalized_title_and_platform(self):
        cat, rep = build([
            draft("Cyberpunk 2077", "PS5", [rel("https://a/1.ffpfsc", titleId="PPSA04029", sizeBytes=100)]),
            draft("Cyberpunk 2077: Ultimate Edition (PS5)", "PS5", [rel("https://dlpsgame.com/cyberpunk-2077-ps5/", "dlpsgame", format="PAGE")], source="dlpsgame", priority=60),
            draft("Cyberpunk 2077", "PS4", [rel("https://a/2.pkg", titleId="CUSA16579", format="PKG")]),
        ])
        ids = [g.id for g in cat.games]
        self.assertEqual(ids, ["cyberpunk-2077-ps4", "cyberpunk-2077-ps5"])
        ps5 = cat.games[1]
        self.assertEqual(len(ps5.releases), 2)
        self.assertEqual(ps5.slug, "cyberpunk-2077")
        self.assertEqual(ps5.title, "Cyberpunk 2077")
        self.assertEqual(ps5.sizeMin, 100)
        self.assertEqual(ps5.sizeMax, 100)
        self.assertEqual(rep.merged_groups, 1)
        self.assertEqual([s.id for s in cat.sources], ["archive", "dlpsgame"])

    def test_title_id_joins_differently_named_groups(self):
        cat, _ = build([
            draft("Marvel's Spider-Man 2", "PS5", [rel("https://a/1.ffpfsc", titleId="PPSA08694")]),
            draft("Spider-Man 2", "PS5", [rel("https://b/2.exfat", titleId="PPSA08694", format="exFAT")], source="orbit", priority=90),
        ])
        self.assertEqual(len(cat.games), 1)
        self.assertEqual(cat.games[0].title, "Marvel's Spider-Man 2")
        self.assertEqual(cat.games[0].titleIds, ["PPSA08694"])

    def test_cross_platform_title_ids_do_not_join(self):
        cat, _ = build([
            draft("Game", "PS5", [rel("https://a/1.ffpfsc", titleId="PPSA00001")], titleIds=["CUSA00001"]),
            draft("Game", "PS4", [rel("https://a/2.pkg", titleId="CUSA00001", format="PKG")]),
        ])
        self.assertEqual(sorted(g.id for g in cat.games), ["game-ps4", "game-ps5"])

    def test_release_dedupe_by_url_fills_fields_and_unions_mirrors(self):
        cat, rep = build([
            draft("Game", "PS5", [rel("https://a/1.ffpfsc", titleId="PPSA00001", sizeBytes=0, mirrors=["https://m/1"])]),
            draft("Game", "PS5", [rel("https://a/1.ffpfsc", sizeBytes=500, md5="a" * 32, version="01.02", mirrors=["https://m/2", "https://m/1"])],
                  source="orbit", priority=90),
        ])
        self.assertEqual(len(cat.games), 1)
        r = cat.games[0].releases[0]
        self.assertEqual(len(cat.games[0].releases), 1)
        self.assertEqual(r.sizeBytes, 500)
        self.assertEqual(r.md5, "a" * 32)
        self.assertEqual(r.version, "01.02")
        self.assertEqual(r.mirrors, ["https://m/1", "https://m/2"])
        self.assertEqual(rep.dropped_releases, {"duplicate_url": 1})

    def test_bad_releases_are_dropped_with_reasons(self):
        cat, rep = build([
            draft("Good", "PS5", [rel("https://a/good.ffpfsc"), rel("ftp://a/bad"), rel("https://a/x.ffpfsc", "nosuch"),
                                  rel("https://a/neg.ffpfsc", sizeBytes=-1), rel("https://user:pw@a/cred.ffpfsc")]),
            draft("", "PS5", [rel("https://a/notitle.ffpfsc")]),
            draft("Bad platform", "PS3", [rel("https://a/ps3.pkg", format="PKG")]),
            draft("Only bad", "PS5", [rel("not a url")]),
        ])
        self.assertEqual([g.id for g in cat.games], ["good-ps5"])
        self.assertEqual(len(cat.games[0].releases), 1)
        self.assertEqual(rep.dropped_releases["release_without_http_url"], 2)
        self.assertEqual(rep.dropped_releases["unknown_source_id"], 1)
        self.assertEqual(rep.dropped_releases["negative_size"], 1)
        self.assertEqual(rep.dropped_releases["url_with_credentials"], 1)
        self.assertEqual(rep.dropped_releases["missing_title"], 1)
        self.assertEqual(rep.dropped_releases["bad_platform"], 1)
        self.assertEqual(rep.dropped_games, {"missing_title": 1, "bad_platform": 1, "no_releases": 1})

    def test_same_slug_distinct_groups_get_unique_ids(self):
        # Two groups whose titles differ only by a title id link but normalize alike cannot
        # happen; simulate the id collision path by forcing titles that clean to the same slug
        # on different platforms being distinct, and identical ones on one platform via hint.
        cat, _ = build([
            draft("X", "PS5", [rel("https://a/1.ffpfsc")]),
            draft("X", "PS4", [rel("https://a/2.pkg", format="PKG")]),
        ])
        self.assertEqual(sorted(g.id for g in cat.games), ["x-ps4", "x-ps5"])
        self.assertEqual(len({g.id for g in cat.games}), 2)

    def test_releases_sorted_games_first_then_verified(self):
        cat, _ = build([draft("G", "PS5", [
            rel("https://a/dlc.pkg", format="PKG", kind="dlc"),
            rel("https://a/u.pkg", format="PKG", kind="update"),
            rel("https://vikingfile.com/f/x", "vikingfile", provider="Vikingfile", format="exFAT"),
            rel("https://a/g.ffpfsc", verifiedAt="2026-10-01"),
        ])])
        kinds = [(r.kind, r.sourceId) for r in cat.games[0].releases]
        self.assertEqual(kinds, [("game", "archive"), ("game", "vikingfile"), ("update", "archive"), ("dlc", "archive")])
        self.assertTrue(cat.games[0].verified)

    def test_compat_sizes_genres_art_and_featured(self):
        cat, _ = build([
            draft("A", "PS5", [rel("https://a/A 9.xx.ffpfsc", filename="A 9.xx.ffpfsc", sizeBytes=10),
                               rel("https://a/A2.ffpfsc", filename="A (PPSA1)[BP4.xx].ffpfsc", sizeBytes=30)],
                  genres=["Role-playing", "Driving/Racing"], homeOrder=2, pickOrder=5,
                  cover="https://dlpsgame.com/c.jpg", coverFallback="https://cdn.prosperopatches.com/t/icon0.webp",
                  hero="https://cdn.prosperopatches.com/t/pic0.webp"),
        ])
        g = cat.games[0]
        self.assertEqual(g.compat, ["4.xx", "9.xx"])
        self.assertEqual((g.sizeMin, g.sizeMax), (10, 30))
        self.assertEqual(g.genres, ["RPG", "Racing"])
        self.assertEqual(g.cover, "https://cdn.prosperopatches.com/t/icon0.webp")
        self.assertEqual(g.coverFallback, "https://dlpsgame.com/c.jpg")
        self.assertEqual(g.featured, 2)
        self.assertGreater(g.popularity, 0.2)
        self.assertEqual(cat.genres, ["RPG", "Racing"])
        self.assertRegex(g.tint, r"^#[0-9a-f]{6}$")

    def test_popularity_follows_pick_order_recency_and_release_count(self):
        cat, _ = build([
            draft("Top", "PS5", [rel("https://a/t1.ffpfsc", verifiedAt="2026-10-01"), rel("https://a/t2.exfat", format="exFAT")],
                  pickOrder=1, releaseDate="2026-01-01", cover="https://c/1.jpg"),
            draft("Mid", "PS5", [rel("https://a/m.ffpfsc")], pickOrder=5, releaseDate="2020-01-01"),
            draft("Low", "PS5", [rel("https://a/l.ffpfsc")]),
        ])
        pop = {g.title: g.popularity for g in cat.games}
        self.assertGreater(pop["Top"], pop["Mid"])
        self.assertGreater(pop["Mid"], pop["Low"])
        self.assertTrue(all(0.0 <= p <= 1.0 for p in pop.values()))

    def test_featured_fallback_when_no_home_order(self):
        cat, _ = build([
            draft(f"Game {i}", "PS5", [rel(f"https://a/{i}.ffpfsc")], hero=f"https://cdn.prosperopatches.com/{i}/pic0.webp", releaseDate="2025-01-01")
            for i in range(3)
        ])
        self.assertEqual(sorted(g.featured for g in cat.games), [1, 2, 3])

    def test_added_at_is_sticky_across_rebuilds(self):
        cat1, _ = build([draft("Old", "PS5", [rel("https://a/old.ffpfsc", addedAt="2025-01-01")])])
        cat2, _ = build([draft("Old", "PS5", [rel("https://a/old.ffpfsc")]), draft("New", "PS5", [rel("https://a/new.ffpfsc")])], previous=cat1)
        by_id = {g.id: g for g in cat2.games}
        self.assertEqual(by_id["old-ps5"].addedAt, "2025-01-01")
        self.assertEqual(by_id["old-ps5"].releases[0].addedAt, "2025-01-01")
        self.assertEqual(by_id["new-ps5"].addedAt, GEN[:10])

    def test_output_is_deterministic(self):
        drafts = lambda: [  # noqa: E731
            draft("B", "PS5", [rel("https://a/b.ffpfsc"), rel("https://a/b2.exfat", format="exFAT")]),
            draft("A", "PS4", [rel("https://a/a.pkg", format="PKG")]),
        ]
        one, _ = build(drafts())
        two, _ = build(list(reversed(drafts())))
        dump = lambda c: json.dumps(c.to_dict(), sort_keys=True)  # noqa: E731
        self.assertEqual(dump(one), dump(two))
        self.assertEqual([g.title for g in one.games], ["A", "B"])


class ValidationTests(unittest.TestCase):
    def _doc(self):
        cat, _ = build([draft("Good Game", "PS5", [rel("https://a/good.ffpfsc", titleId="PPSA00001", sizeBytes=5)])])
        return cat.to_dict()

    def test_valid_document_passes(self):
        self.assertEqual(validate_catalog(self._doc()), [])

    def test_duplicate_game_ids(self):
        doc = self._doc()
        doc["games"].append(json.loads(json.dumps(doc["games"][0])))
        doc["games"][1]["releases"][0]["url"] = "https://a/other.ffpfsc"
        self.assertTrue(any("duplicate game id" in e for e in validate_catalog(doc)))

    def test_release_without_http_url(self):
        doc = self._doc()
        doc["games"][0]["releases"][0]["url"] = "ftp://a/x"
        self.assertTrue(any("url must be an http(s) URL" in e for e in validate_catalog(doc)))

    def test_unknown_source_id(self):
        doc = self._doc()
        doc["games"][0]["releases"][0]["sourceId"] = "mystery"
        self.assertTrue(any("unknown sourceId" in e for e in validate_catalog(doc)))

    def test_bad_platform(self):
        doc = self._doc()
        doc["games"][0]["platform"] = "PS3"
        self.assertTrue(any("platform must be PS4, PS5 or HOMEBREW" in e for e in validate_catalog(doc)))

    def test_negative_sizes(self):
        doc = self._doc()
        doc["games"][0]["releases"][0]["sizeBytes"] = -5
        doc["games"][0]["sizeMin"] = -1
        errs = validate_catalog(doc)
        self.assertTrue(any("sizeBytes must be a non-negative" in e for e in errs))
        self.assertTrue(any("sizeMin must be a non-negative" in e for e in errs))

    def test_missing_title(self):
        doc = self._doc()
        doc["games"][0]["title"] = "   "
        self.assertTrue(any("title is required" in e for e in validate_catalog(doc)))

    def test_dates(self):
        doc = self._doc()
        doc["games"][0]["releaseDate"] = "13/10/2026"
        doc["games"][0]["releases"][0]["verifiedAt"] = "2026-13-40"
        errs = validate_catalog(doc)
        self.assertTrue(any("releaseDate is not an ISO date" in e for e in errs))
        self.assertTrue(any("verifiedAt is not an ISO date" in e for e in errs))
        doc = self._doc()
        doc["games"][0]["releaseDate"] = ""
        doc["games"][0]["addedAt"] = "2026-10-03T19:37:21+05:30"
        self.assertEqual(validate_catalog(doc), [])

    def test_format_kind_and_genre_vocabulary(self):
        doc = self._doc()
        doc["games"][0]["releases"][0]["format"] = "ISO"
        doc["games"][0]["releases"][0]["kind"] = "demo"
        doc["games"][0]["genres"] = ["Weird"]
        errs = validate_catalog(doc)
        self.assertTrue(any("format must be one of" in e for e in errs))
        self.assertTrue(any("kind must be one of" in e for e in errs))
        self.assertTrue(any("not listed in catalog.genres" in e for e in errs))

    def test_id_must_match_platform(self):
        doc = self._doc()
        doc["games"][0]["id"] = "good-game-ps4"
        self.assertTrue(any("id suffix does not match platform" in e for e in validate_catalog(doc)))


class DlpsgameBundleTests(unittest.TestCase):
    PAGE = "https://dlpsgame.com/test-game-ps4/"

    def _content(self, inner_html: str, header: str = "CUSA12345 - EUR (v1.00)") -> str:
        import base64
        payload = base64.b64encode(inner_html.encode("utf-8")).decode("ascii")
        return f'<h3>{header}</h3><div data-payload="{payload}"></div>'

    def test_bundle_parsing_yields_game_update_dlc(self):
        inner = (
            '<p>Game : <a href="https://1fichier.com/?abc">1Fichier</a> - <a href="https://ouo.io/s?s=https://gofile.io/d/xyz">Gofile</a></p>'
            '<p>Update 1.37 (Fix 5.05/6.72) : <a href="https://mediafire.com/file/u137">Mediafire</a></p>'
            '<p>DLC (18) : <a href="https://pixeldrain.com/u/dlc">Pixeldrain</a></p>'
            '<p>DLC (18) Contents : <a href="https://dlpsgame.com/guide-download-game/">Here</a></p>'
            '<p>Password : DLPSGAME.COM</p><p>Languages : English, French</p>'
        )
        versions = dlpsgame.parse_bundle(self._content(inner), self.PAGE)
        self.assertEqual(len(versions), 1)
        v = versions[0]
        self.assertEqual((v.titleId, v.region, v.baseVersion, v.password), ("CUSA12345", "EUR", "1.00", "DLPSGAME.COM"))
        self.assertEqual([m.url for m in v.game], ["https://1fichier.com/?abc", "https://gofile.io/d/xyz"])
        self.assertEqual(v.updates[0]["version"], "1.37")
        self.assertEqual(len(v.dlc), 1)
        rels = dlpsgame.releases_from_bundle(versions, self.PAGE)
        self.assertEqual([r.kind for r in rels], ["game", "update", "dlc"])
        self.assertEqual(rels[0].url, "https://1fichier.com/?abc")
        self.assertEqual(rels[0].mirrors, ["https://gofile.io/d/xyz"])
        self.assertEqual(rels[0].region, "EUR")
        self.assertEqual(rels[0].version, "1.00")
        self.assertEqual(rels[1].compat, "5.05 6.72")
        self.assertEqual(rels[1].version, "1.37")
        self.assertTrue(all(r.browserUrl == self.PAGE and r.password == "DLPSGAME.COM" for r in rels))
        self.assertEqual(len({r.id for r in rels}), 3)

    def test_plain_text_hosts_point_at_the_page(self):
        inner = "<p>Game : Rootz – Akia – 1File</p>"
        rels = dlpsgame.releases_from_bundle(dlpsgame.parse_bundle(self._content(inner), self.PAGE), self.PAGE)
        self.assertEqual(len(rels), 1)
        self.assertEqual(rels[0].url, self.PAGE)
        self.assertEqual(rels[0].format, "PAGE")
        self.assertIn("Rootz", rels[0].notes)

    def test_post_without_payload_becomes_page_release(self):
        post = {"link": self.PAGE, "title": {"rendered": "Test Game PS4 [FPKG] v1.03"},
                "content": {"rendered": '<img src="https://dlpsgame.com/wp-content/uploads/c.jpg"/>'}}
        d = dlpsgame.draft_from_post(post, "PS4")
        self.assertEqual(d.title, "Test Game")
        self.assertEqual(d.cover, "https://dlpsgame.com/wp-content/uploads/c.jpg")
        self.assertEqual(d.releases[0].format, "PAGE")
        self.assertEqual(d.releases[0].url, self.PAGE)

    def test_gateway_decoding(self):
        self.assertEqual(dlpsgame.decode_gateway("https://ouo.io/s?s=https://gofile.io/d/x"), "https://gofile.io/d/x")
        self.assertEqual(dlpsgame.decode_gateway("https://justpaste.it/redirect/abc/https%3A%2F%2Fmega.nz%2Ff"), "https://mega.nz/f")
        self.assertEqual(dlpsgame.decode_gateway("https://shrink.me/?url=aHR0cHM6Ly8xZmljaGllci5jb20vP2FiYw"), "https://1fichier.com/?abc")
        self.assertIsNone(dlpsgame.decode_gateway("https://1fichier.com/?abc"))


class BlackBoxMappingTests(unittest.TestCase):
    def test_entries_map_to_releases_with_verification(self):
        entry = {"id": "ppsa04029-ffpfsc", "titleId": "PPSA04029", "sizeBytes": 10, "provider": "Archive.org",
                 "format": "FFPFSC", "version": None, "filename": "PPSA04029 Cyberpunk 2077 9.xx.ffpfsc",
                 "url": "https://archive.org/download/x/y.ffpfsc", "sourceId": "archive", "gameId": "cyberpunk-2077",
                 "title": "Cyberpunk 2077", "genre": "Role-playing", "cover": "https://cdn.prosperopatches.com/i.webp",
                 "sourceVerification": "file-metadata", "sourceCheckedAt": "2026-10-03T13:51:35+00:00",
                 "homeOrder": 0, "pickOrder": 7}
        ver = {"id": "ppsa04029-ffpfsc", "verification": {"checkedAt": "2026-10-03T13:51:35+00:00", "httpStatus": 200,
                                                           "sourceReportedHashes": {"md5": "a" * 32, "sha1": "b" * 40}}}
        drafts = blackbox.build_drafts({"catalog.json": [entry], "releases.json": [ver]})
        self.assertEqual(len(drafts), 1)
        d = drafts[0]
        r = d.releases[0]
        self.assertEqual((d.platform, d.pickOrder, d.genres), ("PS5", 7, ["Role-playing"]))
        self.assertEqual((r.md5, r.sha1, r.verifiedAt, r.compat, r.kind), ("a" * 32, "b" * 40, "2026-10-03", "9.xx", "game"))

    def test_ps4_entry_with_id_only_title_recovers_name_from_url(self):
        entry = {"id": "cusa00031-pkg", "titleId": "CUSA00031", "sizeBytes": 1, "provider": "Archive.org", "format": "PKG",
                 "filename": "CUSA00031-game-01.00-r1.pkg", "sourceId": "archive", "gameId": "rayman-legends-ps4",
                 "title": "CUSA00031", "platform": "ps4",
                 "url": "https://archive.org/download/ps4-fpkg-collection-english-r/Rayman%20Legends%20-%20[EU]%20[EN]%20[1.00].pkg"}
        d = blackbox.build_drafts({"catalog.json": [entry]})[0]
        self.assertEqual((d.title, d.platform), ("Rayman Legends", "PS4"))
        self.assertEqual(d.releases[0].region, "EUR")


if __name__ == "__main__":
    unittest.main()
