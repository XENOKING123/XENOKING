"""Site-specific parsers (SPEC §17.10): SuperPSX Pencil listings, pkg.games list, pspkg listings,
ArabicPS4Games card grids + JS-unescaped PS5 list, the dlpsgame page fallback with the deep bundle parser,
and the strategy chain (REST → sitemap → category pages) run end to end through a canned HTTP client."""
from __future__ import annotations

import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
sys.path.insert(0, HERE)

from fakes import FakeHttp, fixture, make_ctx  # noqa: E402
from netutil import HttpError  # noqa: E402
from schema import SourceInfo, validate_catalog  # noqa: E402
from sources import arabicps4, dlpsgame, espacypkg, pkggames, pspkg, romsfun, romspure, superpsx, wpsite  # noqa: E402
import merge  # noqa: E402

SOURCES = [
    SourceInfo(id="superpsx", name="SuperPSX", kind="page", homepage="https://www.superpsx.com", password="SuperPSX"),
    SourceInfo(id="pkggames", name="pkg.games", kind="page", homepage="https://pkg.games"),
    SourceInfo(id="pspkg", name="pspkg.com", kind="page", homepage="https://pspkg.com"),
    SourceInfo(id="arabicps4", name="ArabicPS4Games", kind="page", homepage="https://arabicps4games.com"),
    SourceInfo(id="dlpsgame", name="DLPSGAME", kind="page", homepage="https://dlpsgame.com", password="DLPSGAME.COM"),
]


class SuperPsxTests(unittest.TestCase):
    def test_listing_cards_titles_covers_and_category_links_skipped(self):
        drafts = superpsx.parse_listing(fixture("superpsx_listing.html"), "PS5")
        self.assertEqual([d.title for d in drafts], ["God of War Ragnarök", "Returnal"])
        self.assertEqual(drafts[0].pageUrl, "https://www.superpsx.com/god-of-war-ragnarok-ps5/")
        self.assertEqual(drafts[0].cover, "https://www.superpsx.com/wp-content/uploads/2024/05/god-of-war-ragnarok-ps5.webp")
        self.assertEqual(drafts[1].cover, "https://www.superpsx.com/wp-content/uploads/2024/02/returnal-ps5.jpg")
        for d in drafts:
            self.assertEqual(d.platform, "PS5")
            self.assertEqual(len(d.releases), 1)
            r = d.releases[0]
            self.assertEqual((r.sourceId, r.format, r.kind, r.password, r.url), ("superpsx", "PAGE", "game", "SuperPSX", d.pageUrl))
        self.assertEqual(superpsx.parse_listing("<html></html>", "PS5"), [])

    def test_strategy_chain_falls_through_to_category_listings(self):
        http = FakeHttp([
            (r"/wp-json/", 404),
            (r"sitemap", 404),
            (r"/category/ps5/ps5-games/$", fixture("superpsx_listing.html")),
            (r"/category/ps5/ps5-games/page/2/", 404),
            (r"/category/ps4/ps4-games-free/", 404),
        ])
        ctx = make_ctx(http, source_id="superpsx", budget=20.0)
        drafts = superpsx.fetch_online(ctx)
        self.assertEqual(sorted(d.title for d in drafts), ["God of War Ragnarök", "Returnal"])
        self.assertTrue(all(d.platform == "PS5" for d in drafts))
        # Every strategy was tried in order before the listing parser produced the games.
        self.assertTrue(any("/wp-json/wp/v2/categories" in u for u in http.seen))
        self.assertTrue(any("sitemap" in u for u in http.seen))
        self.assertTrue(any(u.endswith("/category/ps5/ps5-games/") for u in http.seen))
        self.assertTrue(any("categories: 2 posts" in line for line in ctx.logs))

    def test_second_platform_listing_still_counts_when_the_first_is_gone(self):
        http = FakeHttp([
            (r"/wp-json/", 404), (r"sitemap", 404),
            (r"/category/ps5/", 404),
            (r"/category/ps4/ps4-games-free/$", fixture("superpsx_listing.html").replace("PS5", "PS4")),
            (r"/category/ps4/ps4-games-free/page/", 404),
        ])
        drafts = superpsx.fetch_online(make_ctx(http, source_id="superpsx", budget=20.0))
        self.assertEqual(len(drafts), 2)
        self.assertTrue(all(d.platform == "PS4" for d in drafts))

    def test_everything_down_raises_for_the_fallback(self):
        with self.assertRaises(HttpError):
            superpsx.fetch_online(make_ctx(FakeHttp(), source_id="superpsx", budget=20.0))


class PkgGamesTests(unittest.TestCase):
    def test_static_list(self):
        drafts = pkggames.parse_listing(fixture("pkggames_list.html"))
        self.assertEqual([d.title for d in drafts], ["Astro Bot", "Demon's Souls"])
        self.assertEqual([d.pageUrl for d in drafts], ["https://pkg.games/ps5/astro-bot/", "https://pkg.games/ps5/demons-souls/"])
        self.assertTrue(all(d.platform == "PS5" and d.releases[0].sourceId == "pkggames" for d in drafts))

    def test_fetch_uses_the_list_page_and_keeps_listing_drafts_when_pages_fail(self):
        http = FakeHttp([(r"/wp-json/", 404), (r"sitemap", 404), (r"/ps5-game-list/$", fixture("pkggames_list.html"))])
        drafts = pkggames.fetch_online(make_ctx(http, source_id="pkggames", budget=20.0))
        self.assertEqual(sorted(d.title for d in drafts), ["Astro Bot", "Demon's Souls"])
        self.assertTrue(all(d.releases[0].format == "PAGE" for d in drafts))


class PspkgTests(unittest.TestCase):
    def test_listing_titles_from_attribute_text_or_slug_and_platform_filter(self):
        drafts = pspkg.parse_listing(fixture("pspkg_listing.html"), "PS4")
        self.assertEqual([d.title for d in drafts], ["Bloodborne", "The Last of Us Part II", "Gran Turismo Sport"])
        self.assertEqual(drafts[0].cover, "https://pspkg.com/covers/bloodborne.jpg")
        self.assertEqual(drafts[1].cover, "https://pspkg.com/covers/tlou2.webp")
        self.assertEqual(drafts[2].cover, "")
        self.assertTrue(all(d.platform == "PS4" and d.pageUrl.startswith("https://pspkg.com/ps4/download-") for d in drafts))
        ps5 = pspkg.parse_listing(fixture("pspkg_listing.html"), "PS5")
        self.assertEqual([(d.title, d.pageUrl) for d in ps5], [("Returnal", "https://pspkg.com/ps5/download-returnal-ps5-9001.html")])

    def test_pagination_stops_at_the_first_empty_page(self):
        http = FakeHttp([
            (r"/wp-json/", 404), (r"sitemap", 404),
            (r"pspkg\.com/ps5/$", 404),
            (r"pspkg\.com/ps4/$", fixture("pspkg_listing.html")),
            (r"pspkg\.com/ps4/page/2/", "<html><body>no games here</body></html>"),
            (r"download-.*\.html$", 404),
        ])
        ctx = make_ctx(http, source_id="pspkg", budget=20.0)
        drafts = pspkg.fetch_online(ctx)
        self.assertEqual(len(drafts), 3)
        self.assertFalse(any("/ps4/page/3/" in u for u in http.seen))


class ArabicPs4Tests(unittest.TestCase):
    def test_ps4_cards_strip_padding_prefixes_ids_and_skip_torrents(self):
        drafts = arabicps4.parse_cards(fixture("arabicps4_ps4_cards.html"), "PS4")
        self.assertEqual([d.title for d in drafts], ["God of War", "Bloodborne Game of the Year Edition"])
        self.assertEqual(drafts[0].pageUrl, "https://justpaste.it/ps4-god-of-war")
        self.assertEqual(drafts[0].cover, "https://i.postimg.cc/abc123/god-of-war.jpg")
        self.assertEqual(drafts[1].pageUrl, "https://justpaste.it/ps4-bloodborne")
        self.assertTrue(all(d.platform == "PS4" and d.releases[0].format == "PAGE" for d in drafts))

    def test_ps5_list_is_decoded_from_js_unescape(self):
        body = fixture("arabicps4_ps5_list.html")
        decoded = arabicps4.decode_js_unescape(body)
        self.assertIn('rel="nofollow"', decoded)
        drafts = arabicps4.parse_ps5_list(body)
        self.assertEqual([(d.title, d.pageUrl) for d in drafts],
                         [("Astro Bot", "https://justpaste.it/ps5-astro-bot"), ("Returnal", "https://justpaste.it/ps5-returnal")])
        self.assertTrue(all(d.platform == "PS5" for d in drafts))
        self.assertEqual(arabicps4.decode_js_unescape("<html>plain</html>"), "")

    def test_fetch_walks_ps4_pages_then_the_ps5_list(self):
        http = FakeHttp([
            (r"/0/ps4/index\.html$", fixture("arabicps4_ps4_cards.html")),
            (r"/0/ps4/indexpages2\.html$", 404),
            (r"/0/ps5/index\.html$", fixture("arabicps4_ps5_list.html")),
        ])
        drafts = arabicps4.fetch_online(make_ctx(http, source_id="arabicps4", budget=20.0))
        self.assertEqual(sorted(d.title for d in drafts), ["Astro Bot", "Bloodborne Game of the Year Edition", "God of War", "Returnal"])
        self.assertEqual({d.platform for d in drafts}, {"PS4", "PS5"})
        with self.assertRaises(HttpError):
            arabicps4.fetch_online(make_ctx(FakeHttp(), source_id="arabicps4", budget=20.0))


class DlpsgamePageFallbackTests(unittest.TestCase):
    URL = "https://dlpsgame.com/god-of-war-ps4/"

    def test_page_with_payload_blocks_uses_the_deep_bundle_parser(self):
        d = dlpsgame.draft_from_page_html(fixture("dlpsgame_page.html"), self.URL)
        self.assertIsNotNone(d)
        self.assertEqual((d.title, d.platform), ("God of War", "PS4"))
        self.assertEqual(d.cover, "https://dlpsgame.com/wp-content/uploads/2024/01/god-of-war-ps4.jpg")
        self.assertEqual(d.addedAt, "2024-01-15")
        self.assertEqual([r.kind for r in d.releases], ["game", "update", "dlc"])
        game, upd, dlc = d.releases
        self.assertEqual(game.url, "https://1fichier.com/?gow4base")
        self.assertEqual(game.mirrors, ["https://gofile.io/d/gow4"])        # the ouo gateway was decoded
        self.assertEqual((game.titleId, game.region, game.version), ("CUSA07408", "EUR", "1.00"))
        self.assertIn("Languages: English, French, German", game.notes)
        self.assertEqual((upd.version, upd.compat), ("1.35", "5.05 6.72"))
        self.assertEqual(dlc.notes.split(" · ")[0], "DLC (2)")
        self.assertTrue(all(r.password == "DLPSGAME.COM" and r.browserUrl == self.URL for r in d.releases))

    def test_page_without_payload_still_yields_one_page_release(self):
        page = '<html><head><title>Sackboy PS5 - DLPSGAME</title></head><body><h1>Sackboy: A Big Adventure PS5</h1>' \
               '<div class="entry-content"><p>Links are on the way.</p></div></body></html>'
        d = dlpsgame.draft_from_page_html(page, "https://dlpsgame.com/sackboy-ps5/")
        self.assertEqual((d.title, d.platform), ("Sackboy: A Big Adventure", "PS5"))
        self.assertEqual([(r.format, r.kind, r.url) for r in d.releases], [("PAGE", "game", "https://dlpsgame.com/sackboy-ps5/")])

    def test_rest_down_falls_back_to_the_sitemap_pages(self):
        http = FakeHttp([
            (r"/wp-json/", 403),
            (r"/sitemap_index\.xml$", '<sitemapindex><sitemap><loc>https://dlpsgame.com/post-sitemap.xml</loc></sitemap></sitemapindex>'),
            (r"/post-sitemap\.xml$", f'<urlset><url><loc>{self.URL}</loc></url><url><loc>https://dlpsgame.com/category/ps4/</loc></url></urlset>'),
            (r"/god-of-war-ps4/$", fixture("dlpsgame_page.html")),
        ])
        ctx = make_ctx(http, source_id="dlpsgame", budget=20.0)
        drafts = dlpsgame.fetch_online(ctx)
        self.assertEqual([d.title for d in drafts], ["God of War"])
        self.assertEqual(len(drafts[0].releases), 3)
        self.assertTrue(any("REST listing failed" in line for line in ctx.logs))


class WordPressOnlyConfigsTests(unittest.TestCase):
    """romsfun / romspure / espacypkg are pure SiteConfigs: the generic adapter runs them end to end."""

    def _rest_posts(self, base: str) -> list:
        return [{
            "id": 7, "date": "2025-03-01T00:00:00", "link": f"{base}/bloodborne-ps4/",
            "title": {"rendered": "Bloodborne PS4 [FPKG] v1.09 + Backport 5.05"},
            "content": {"rendered": '<h3>Game</h3><p><a href="https://1fichier.com/?bb">1Fichier</a></p>'
                                    '<h3>Backport 5.05</h3><p><a href="https://pixeldrain.com/u/bb505">Pixeldrain</a></p>'
                                    '<p>Password: none</p><p>Size: 28.5 GB</p>'},
            "categories": [3], "featured_media": 0,
        }]

    def test_each_config_through_the_rest_strategy(self):
        for mod in (romsfun, romspure, espacypkg):
            site = mod.SITE
            with self.subTest(site=site.id):
                http = FakeHttp([
                    (r"/wp-json/wp/v2/categories", [{"id": 3, "slug": site.platforms["PS4"][0], "name": "PS4", "count": 1}]),
                    (r"/wp-json/wp/v2/posts\?.*page=1", self._rest_posts(site.base)),
                    (r"/wp-json/wp/v2/posts\?.*page=2", 400),
                ])
                drafts = mod.SOURCE.online(make_ctx(http, source_id=site.id, budget=20.0))
                self.assertEqual(len(drafts), 1)
                d = drafts[0]
                self.assertEqual((d.title, d.platform, d.source), ("Bloodborne", "PS4", site.id))
                kinds = {r.kind: r for r in d.releases}
                self.assertEqual(set(kinds), {"game", "backport"})
                self.assertEqual(kinds["game"].url, "https://1fichier.com/?bb")
                self.assertEqual(kinds["game"].sizeBytes, int(28.5 * 1024 ** 3))
                self.assertEqual((kinds["backport"].backportFw, kinds["backport"].requiresFw), ("5.05", "5.05"))
                self.assertTrue(all(r.sourceId == site.id for r in d.releases))

    def test_skip_rules_keep_emulator_and_bios_pages_out(self):
        for mod, url in ((romsfun, "https://romsfun.com/roms/emulators/ppsspp/"), (romspure, "https://romspure.cc/bios/ps4/")):
            with self.subTest(site=mod.SITE.id):
                self.assertIsNone(wpsite.parse_post(mod.SITE, title="PPSSPP", url=url, content="<p>x</p>"))


class MergedSiteDraftsValidateTests(unittest.TestCase):
    def test_site_drafts_merge_into_a_valid_catalog(self):
        drafts = (superpsx.parse_listing(fixture("superpsx_listing.html"), "PS5")
                  + pkggames.parse_listing(fixture("pkggames_list.html"))
                  + pspkg.parse_listing(fixture("pspkg_listing.html"), "PS4")
                  + pspkg.parse_listing(fixture("pspkg_listing.html"), "PS5")
                  + arabicps4.parse_cards(fixture("arabicps4_ps4_cards.html"), "PS4")
                  + arabicps4.parse_ps5_list(fixture("arabicps4_ps5_list.html"))
                  + [dlpsgame.draft_from_page_html(fixture("dlpsgame_page.html"), DlpsgamePageFallbackTests.URL)])
        cat, report = merge.merge_drafts(drafts, SOURCES, revision=1, generated_at="2026-10-13T00:00:00Z")
        doc = cat.to_dict()
        self.assertEqual(validate_catalog(doc), [])
        titles = {g.title: g for g in cat.games}
        # superpsx, pspkg and arabicps4 all list Returnal for PS5: one game, three page releases.
        returnal = [g for g in cat.games if g.slug == "returnal"]
        self.assertEqual([(g.platform, len(g.releases)) for g in returnal], [("PS5", 3)])
        self.assertEqual(sorted(r.sourceId for r in returnal[0].releases), ["arabicps4", "pspkg", "superpsx"])
        self.assertEqual(sorted(g.id for g in cat.games if g.slug == "astro-bot"), ["astro-bot-ps5"])
        self.assertEqual(len(titles["Astro Bot"].releases), 2)        # pkg.games + arabicps4 pages
        gow = titles["God of War"]
        self.assertEqual((gow.updates, gow.dlc, gow.titleIds), (1, 1, ["CUSA07408"]))
        self.assertEqual(len(gow.releases), 4)                          # 3 bundle releases + the arabicps4 page
        self.assertEqual(report.dropped_releases, {})


if __name__ == "__main__":
    unittest.main()
