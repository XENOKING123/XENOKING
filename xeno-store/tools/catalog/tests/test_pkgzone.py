"""pkg-zone card parser (SPEC §17.21) → HOMEBREW entries."""
from __future__ import annotations

import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
sys.path.insert(0, HERE)

import merge  # noqa: E402
from fakes import FakeHttp, fixture, make_ctx  # noqa: E402
from netutil import HttpError  # noqa: E402
from schema import SourceInfo, validate_catalog  # noqa: E402
from sources import pkgzone  # noqa: E402

SOURCES = [SourceInfo(id="pkgzone", name="pkg-zone", kind="direct", homepage="https://pkg-zone.com")]


class CardParserTests(unittest.TestCase):
    def test_cards(self):
        cards = pkgzone.parse_cards(fixture("pkgzone_listing.html"))
        self.assertEqual([c["id"] for c in cards], ["etaHEN_v2", "RetroArch_1_19", "ps5_ftp"])
        eta = cards[0]
        self.assertEqual((eta["title"], eta["version"], eta["author"], eta["supportsPs5"]), ("etaHEN", "2.1b", "LightningMods", True))
        self.assertEqual(eta["cover"], "https://pkg-zone.com/images/etaHEN_v2/cover.png")
        self.assertEqual(eta["details"], "https://pkg-zone.com/details/etaHEN_v2")
        self.assertEqual(eta["downloads"], {"PS5": "https://pkg-zone.com/download/ps5/etaHEN_v2/latest",
                                            "PS4": "https://pkg-zone.com/download/ps4/etaHEN_v2/latest"})
        retro = cards[1]
        self.assertEqual((retro["version"], retro["author"], retro["supportsPs5"]), ("1.19.1", "Libretro", False))
        self.assertTrue(cards[2]["supportsPs5"])
        self.assertEqual(pkgzone.parse_cards("<html>no cards</html>"), [])

    def test_details(self):
        d = pkgzone.parse_details(fixture("pkgzone_details.html"))
        self.assertTrue(d["description"].startswith("RetroArch is a frontend for emulators"))
        self.assertEqual(d["category"], "Emulators")
        self.assertEqual(d["size"], int(54.2 * 1024 ** 2))
        self.assertEqual(d["changelog"], "Faster startup\nFixed PS5 controller mapping")
        self.assertEqual(pkgzone.parse_details(""), {"description": "", "category": "", "size": 0, "changelog": ""})

    def test_category_normalization(self):
        self.assertEqual(pkgzone.normalize_category("Emulators"), "Emulator")
        self.assertEqual(pkgzone.normalize_category("Tools"), "Tool")
        self.assertEqual(pkgzone.normalize_category("", "PS5 FTP Server"), "Tool")
        self.assertEqual(pkgzone.normalize_category("", "etaHEN", "jailbreak payload loader"), "Payload")
        self.assertEqual(pkgzone.normalize_category("", "Kodi"), "Media")
        self.assertEqual(pkgzone.normalize_category("", "Something"), "Other")

    def test_drafts_and_merge_to_homebrew_entries(self):
        cards = pkgzone.parse_cards(fixture("pkgzone_listing.html"))
        details = pkgzone.parse_details(fixture("pkgzone_details.html"))
        drafts = [pkgzone.draft_from_card(c, details if c["id"] == "RetroArch_1_19" else None) for c in cards]
        for d in drafts:
            self.assertEqual(d.platform, "HOMEBREW")
            for r in d.releases:
                self.assertEqual((r.kind, r.format, r.sourceId), ("app", "PKG", "pkgzone"))
                self.assertTrue(r.filename.endswith(".pkg"))
        eta = drafts[0]
        self.assertEqual([r.url for r in eta.releases], ["https://pkg-zone.com/download/ps5/etaHEN_v2/latest",
                                                         "https://pkg-zone.com/download/ps4/etaHEN_v2/latest"])
        self.assertEqual(eta.releases[0].filename, "etaHEN_v2-ps5-v2.1b.pkg")
        retro = drafts[1]
        self.assertEqual((retro.category, retro.author, retro.supportsPs5), ("Emulator", "Libretro", False))
        self.assertEqual(len(retro.releases), 1)
        self.assertEqual(retro.releases[0].sizeBytes, int(54.2 * 1024 ** 2))

        cat, rep = merge.merge_drafts(drafts, SOURCES, revision=1, generated_at="2026-10-13T00:00:00Z")
        ids = sorted(g.id for g in cat.games)
        self.assertEqual(ids, ["etahen-v2-homebrew", "ps5-ftp-homebrew", "retroarch-1-19-homebrew"])
        ftp = next(g for g in cat.games if g.slug == "ps5-ftp")
        self.assertEqual(ftp.title, "PS5 FTP Server")      # app names are kept verbatim (no "PS5" stripping)
        self.assertEqual((ftp.category, ftp.author, ftp.supportsPs5, ftp.titleIds, ftp.genres), ("Tool", "SiSTRo", True, [], []))
        self.assertEqual(ftp.publisher, "SiSTRo")
        self.assertEqual(ftp.series, "")
        self.assertTrue(all(r.kind == "app" for g in cat.games for r in g.releases))
        self.assertEqual(validate_catalog(cat.to_dict()), [])

    def test_online_fetch_paginates_and_stops(self):
        http = FakeHttp([
            (r"^https://pkg-zone\.com/$", fixture("pkgzone_listing.html")),
            (r"\?page=2$", "<html>no cards here</html>"),
            (r"/details/RetroArch_1_19$", fixture("pkgzone_details.html")),
            (r"/details/", 500),
        ])
        drafts = pkgzone.fetch_online(make_ctx(http, source_id="pkgzone"))
        self.assertEqual(len(drafts), 3)
        self.assertEqual(sum(1 for u in http.seen if "page=" in u), 1)
        retro = next(d for d in drafts if d.slugHint == "RetroArch_1_19")
        self.assertEqual(retro.category, "Emulator")
        with self.assertRaises(HttpError):
            pkgzone.fetch_online(make_ctx(FakeHttp([(r".*", 403)]), source_id="pkgzone"))


if __name__ == "__main__":
    unittest.main()
