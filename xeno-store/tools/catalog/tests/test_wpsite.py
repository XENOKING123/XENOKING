"""Generic WordPress adapter (SPEC §17.10): page rules, host classification and the three strategies."""
from __future__ import annotations

import os
import re
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
sys.path.insert(0, HERE)

from fakes import FakeHttp, fixture, fixture_json, make_ctx  # noqa: E402
from netutil import HttpError  # noqa: E402
from sources import wpsite  # noqa: E402
from sources.wpsite import SiteConfig  # noqa: E402

BASE = "https://example-games.test"
CFG = SiteConfig(id="superpsx", name="Example", base=BASE, provider="Example", password="Default1",
                 platforms={"PS5": ["ps5"], "PS4": ["ps4"]}, default_platform="PS4", max_media_lookups=5)


class HostClassificationTests(unittest.TestCase):
    def test_terminal_gateway_site_other(self):
        self.assertEqual(wpsite.classify_host("https://www.mediafire.com/file/x", "example-games.test"), "terminal")
        self.assertEqual(wpsite.classify_host("https://1fichier.com/?abc", ""), "terminal")
        self.assertEqual(wpsite.classify_host("https://archive.org/download/x/y.pkg", ""), "terminal")
        self.assertEqual(wpsite.classify_host("https://filecrypt.cc/Container/x.html", ""), "gateway")
        self.assertEqual(wpsite.classify_host("https://ouo.io/abcd", ""), "gateway")
        self.assertEqual(wpsite.classify_host("https://example-games.test/dll-x/", "example-games.test"), "site")
        self.assertEqual(wpsite.classify_host("https://sub.example-games.test/x", "example-games.test"), "site")
        self.assertEqual(wpsite.classify_host("https://unknown-host.test/x", "example-games.test"), "other")
        self.assertEqual(wpsite.classify_host("not a url", ""), "other")

    def test_password_and_size_rules(self):
        self.assertEqual(wpsite.parse_password("Password: DLPSGAME.COM"), "DLPSGAME.COM")
        self.assertEqual(wpsite.parse_password("the password is <b>XYZ123</b> (rar)", "d"), "XYZ123")
        self.assertEqual(wpsite.parse_password("Pass = SuperPSX"), "SuperPSX")
        self.assertEqual(wpsite.parse_password("no password required", "Default"), "Default")
        self.assertEqual(wpsite.parse_password("Password: https://x", "Default"), "Default")
        self.assertEqual(wpsite.parse_size("Size: 12,5 GB"), int(12.5 * 1024 ** 3))
        self.assertEqual(wpsite.parse_size("about 700MB"), 700 * 1024 ** 2)
        self.assertEqual(wpsite.parse_size("1.2 TB archive"), int(1.2 * 1024 ** 4))
        self.assertEqual(wpsite.parse_size("nothing"), 0)

    def test_platform_rules(self):
        self.assertEqual(wpsite.platform_from(["PS5 Games"], "", "", [], "PS4"), "PS5")
        self.assertEqual(wpsite.platform_from([], "https://x/game-ps4/", "", [], "PS5"), "PS4")
        self.assertEqual(wpsite.platform_from([], "https://x/game/", "Game PlayStation 5", [], "PS4"), "PS5")
        self.assertEqual(wpsite.platform_from([], "https://x/game/", "Game", ["CUSA00001"], "PS5"), "PS4")
        self.assertEqual(wpsite.platform_from([], "https://x/game/", "Game", [], "PS5"), "PS5")


class PostParsingTests(unittest.TestCase):
    def test_post_rules_title_platform_ids_links_kinds_backport_password_size(self):
        post = fixture_json("wpsite_posts_ps5.json")[0]
        d = wpsite.parse_post(CFG, title=post["title"]["rendered"], url=post["link"], content=post["content"]["rendered"],
                              categories=["PS5 Games"], date=post["date"], featured=wpsite._featured_from_post(post))
        self.assertEqual(d.title, "Hogwarts Legacy")
        self.assertEqual(d.platform, "PS5")
        self.assertEqual(d.titleIds, ["PPSA03243"])
        self.assertEqual(d.cover, "https://example-games.test/wp-content/uploads/hogwarts-768.jpg")
        self.assertEqual(d.addedAt, "2026-03-04")
        kinds = [(r.kind, r.version, r.backportFw, r.requiresFw) for r in d.releases]
        self.assertEqual(kinds, [("game", "1.00", "", ""), ("backport", "1.05", "5.05", "5.05"), ("dlc", "", "", "")])
        game, bp, dlc = d.releases
        self.assertEqual(game.url, "https://www.mediafire.com/folder/abc/hogwarts")
        self.assertEqual(game.mirrors, ["https://1fichier.com/?hog1", "https://ouo.io/hog2"])
        self.assertEqual(game.sizeBytes, int(72.5 * 1024 ** 3))
        self.assertEqual(game.password, "Example123")
        self.assertEqual(game.sourceId, "superpsx")
        self.assertEqual(game.format, "PAGE")
        self.assertEqual(game.browserUrl, post["link"])
        self.assertIn("Mirrors: mediafire.com, 1fichier.com, ouo.io", game.notes)
        self.assertEqual(bp.url, "https://gofile.io/d/hogup")
        self.assertEqual(bp.mirrors, ["https://pixeldrain.com/u/hogup"])
        self.assertEqual(bp.compat, "5.05")
        self.assertEqual(dlc.sizeBytes, int(1.2 * 1024 ** 3))   # the section's own size, not the post's
        # the site's own "how to install" link never becomes a release or a mirror
        self.assertFalse(any("how-to-install" in u for r in d.releases for u in [r.url] + r.mirrors))
        self.assertEqual(len({r.id for r in d.releases}), 3)

    def test_post_without_links_yields_page_release(self):
        post = fixture_json("wpsite_posts_ps5.json")[1]
        d = wpsite.parse_post(CFG, title=post["title"]["rendered"], url=post["link"], content=post["content"]["rendered"],
                              categories=["PS5 Games"], date=post["date"])
        self.assertEqual(d.title, "ASTRO BOT")
        self.assertEqual(d.titleIds, ["PPSA01342"])
        self.assertEqual(len(d.releases), 1)
        r = d.releases[0]
        self.assertEqual((r.format, r.kind, r.url, r.titleId, r.password), ("PAGE", "game", post["link"], "PPSA01342", "Default1"))

    def test_ps4_post_with_gateway_and_firmware_tag(self):
        post = fixture_json("wpsite_posts_ps4.json")[0]
        d = wpsite.parse_post(CFG, title=post["title"]["rendered"], url=post["link"], content=post["content"]["rendered"],
                              categories=["PS4 Games"])
        self.assertEqual((d.title, d.platform, d.titleIds), ("Bloodborne", "PS4", ["CUSA00207"]))
        self.assertEqual(d.cover, "https://example-games.test/wp-content/uploads/bloodborne.png")
        r = d.releases[0]
        self.assertEqual(r.url, "https://akirabox.com/f/blood")
        self.assertEqual(r.mirrors, ["https://filecrypt.cc/Container/blood.html"])
        self.assertEqual(r.region, "USA")
        self.assertEqual(r.sizeBytes, int(25.4 * 1024 ** 3))

    def test_full_page_parsing(self):
        d = wpsite.parse_page(CFG, fixture("wpsite_page_hogwarts.html"), BASE + "/hogwarts-legacy-ps5/")
        self.assertEqual(d.title, "Hogwarts Legacy")
        self.assertEqual(d.platform, "PS5")
        self.assertEqual(d.cover, "https://example-games.test/wp-content/uploads/hogwarts-og.jpg")
        self.assertEqual(d.addedAt, "2026-03-04")
        self.assertEqual([r.kind for r in d.releases], ["game", "backport"])
        self.assertEqual(d.releases[1].backportFw, "5.05")
        self.assertEqual(d.releases[0].password, "Example123")
        d2 = wpsite.parse_page(CFG, fixture("wpsite_page_bloodborne.html"), BASE + "/bloodborne-ps4/")
        self.assertEqual((d2.title, d2.platform), ("Bloodborne", "PS4"))
        self.assertEqual(d2.releases[0].compat, "9.00")
        self.assertEqual(d2.releases[0].requiresFw, "9.00")

    def test_title_noise_rules(self):
        from merge import clean_title
        self.assertEqual(clean_title("Game Name PS4 [FPKG] v1.03 + Update + DLC"), "Game Name")
        self.assertEqual(clean_title("Game Name PS5 Backport 9.00 (v1.10)"), "Game Name")
        self.assertEqual(clean_title("Game Name [BP 5.05] FPKG 12.3GB"), "Game Name")
        self.assertEqual(clean_title("Game Name (PPSA01234) PS5 Backported"), "Game Name")

    def test_listing_cards_parser(self):
        drafts = wpsite.parse_listing_cards(CFG, fixture("wpsite_category_ps5.html"), "PS5")
        self.assertEqual([d.title for d in drafts], ["Hogwarts Legacy", "ASTRO BOT"])
        self.assertEqual(drafts[0].cover, "https://example-games.test/wp-content/uploads/hogwarts-thumb.jpg")
        self.assertEqual(drafts[0].pageUrl, BASE + "/hogwarts-legacy-ps5/")
        self.assertTrue(all(d.platform == "PS5" for d in drafts))
        self.assertEqual(wpsite.parse_listing_cards(CFG, fixture("wpsite_category_empty.html"), "PS5"), [])


def rest_http(with_categories: bool = True) -> FakeHttp:
    http = FakeHttp()
    if with_categories:
        http.add(r"/wp-json/wp/v2/categories", fixture_json("wpsite_categories.json"))
    http.add(r"/wp-json/wp/v2/posts\?(?=.*[&?]categories=9)(?=.*[&?]page=1(?:&|$))", fixture_json("wpsite_posts_ps5.json"))
    http.add(r"/wp-json/wp/v2/posts\?(?=.*[&?]categories=7)(?=.*[&?]page=1(?:&|$))", fixture_json("wpsite_posts_ps4.json"))
    http.add(r"/wp-json/wp/v2/posts\?.*[&?]page=[2-9]", 400)
    http.add(r"/wp-json/wp/v2/media/55", fixture_json("wpsite_media_55.json"))
    return http


class StrategyTests(unittest.TestCase):
    def test_rest_strategy(self):
        http = rest_http()
        drafts = wpsite.fetch_site(make_ctx(http), CFG)
        titles = sorted((d.title, d.platform) for d in drafts)
        self.assertEqual(titles, [("ASTRO BOT", "PS5"), ("Bloodborne", "PS4"), ("Hogwarts Legacy", "PS5")])
        astro = next(d for d in drafts if d.title == "ASTRO BOT")
        self.assertEqual(astro.cover, "https://example-games.test/wp-content/uploads/astro-bot-300.jpg")  # media lookup
        self.assertEqual(astro.slugHint, "")
        self.assertFalse(any("sitemap" in u for u in http.seen))

    def test_rest_without_category_match_reads_everything(self):
        http = FakeHttp()
        http.add(r"/wp-json/wp/v2/categories", 404)
        http.add(r"/wp-json/wp/v2/posts\?(?!.*categories=).*[&?]page=1(?:&|$)", fixture_json("wpsite_posts_ps5.json") + fixture_json("wpsite_posts_ps4.json"))
        http.add(r"/wp-json/wp/v2/posts\?.*[&?]page=[2-9]", 400)
        http.add(r"/wp-json/wp/v2/media/55", 500)
        drafts = wpsite.fetch_site(make_ctx(http), CFG)
        self.assertEqual(sorted((d.title, d.platform) for d in drafts),
                         [("ASTRO BOT", "PS5"), ("Bloodborne", "PS4"), ("Hogwarts Legacy", "PS5")])

    def test_sitemap_strategy_when_rest_is_blocked(self):
        http = FakeHttp()
        http.add(r"/wp-json/", 403)
        http.add(r"/sitemap_index\.xml$", fixture("wpsite_sitemap_index.xml"))
        http.add(r"/post-sitemap\.xml$", fixture("wpsite_post_sitemap.xml"))
        http.add(r"/hogwarts-legacy-ps5/$", fixture("wpsite_page_hogwarts.html"))
        http.add(r"/bloodborne-ps4/$", fixture("wpsite_page_bloodborne.html"))
        ctx = make_ctx(http)
        drafts = wpsite.fetch_site(ctx, CFG)
        self.assertEqual(sorted(d.title for d in drafts), ["Bloodborne", "Hogwarts Legacy"])
        self.assertFalse(any("category-sitemap" in u or "page-sitemap" in u for u in http.seen))
        self.assertFalse(any("other-site.test" in u for u in http.seen))
        self.assertTrue(any("sitemap: 2 post URLs" in m for m in ctx.logs))

    def test_category_strategy_when_rest_and_sitemap_fail(self):
        http = FakeHttp()
        http.add(r"/wp-json/", 403)
        http.add(r"sitemap", 404)
        http.add(r"/category/ps5/$", fixture("wpsite_category_ps5.html"))
        http.add(r"/category/ps5/page/2/$", fixture("wpsite_category_empty.html"))
        http.add(r"/category/ps4/", 404)
        http.add(r"/hogwarts-legacy-ps5/$", fixture("wpsite_page_hogwarts.html"))
        http.add(r"/astro-bot-ps5/$", 500)
        drafts = wpsite.fetch_site(make_ctx(http), CFG)
        by = {d.title: d for d in drafts}
        self.assertEqual(sorted(by), ["ASTRO BOT", "Hogwarts Legacy"])
        self.assertEqual([r.kind for r in by["Hogwarts Legacy"].releases], ["game", "backport"])   # page fetched
        self.assertEqual(by["ASTRO BOT"].releases[0].format, "PAGE")                               # page failed: listing data kept
        self.assertEqual(by["Hogwarts Legacy"].cover, "https://example-games.test/wp-content/uploads/hogwarts-og.jpg")

    def test_custom_listing_parser_is_used_for_categories(self):
        from merge import GameDraft
        from sources.base import page_release
        calls = []

        def parser(body, platform):
            calls.append(platform)
            return [GameDraft(source="x", title="Custom Game", platform=platform, pageUrl=BASE + "/custom/",
                              releases=[page_release("superpsx", "Example", BASE + "/custom/", platform=platform)])]
        cfg = SiteConfig(id="superpsx", name="Example", base=BASE, rest=False, sitemap=False, listing_parser=parser,
                         fetch_pages=False, platforms={"PS5": ["ps5"]})
        http = FakeHttp([(r"/category/ps5/$", "<html>listing</html>"), (r"/category/ps5/page/2/$", "<html>listing</html>")])
        drafts = wpsite.fetch_site(make_ctx(http), cfg)
        self.assertEqual([d.title for d in drafts], ["Custom Game"])
        self.assertEqual(calls, ["PS5", "PS5"])   # page 2 yielded nothing new → stop

    def test_every_strategy_failing_raises_http_error_with_reasons(self):
        http = FakeHttp()
        http.add(r".*", 503)
        with self.assertRaises(HttpError) as cm:
            wpsite.fetch_site(make_ctx(http), CFG)
        self.assertIn("rest:", str(cm.exception))
        self.assertIn("categories:", str(cm.exception))

    def test_budget_is_respected(self):
        http = rest_http()
        ctx = make_ctx(http, budget=-1)   # already past the deadline
        with self.assertRaises(HttpError):
            wpsite.fetch_site(ctx, CFG)

    def test_limit_truncates(self):
        drafts = wpsite.fetch_site(make_ctx(rest_http(), limit=1), CFG)
        self.assertEqual(len(drafts), 1)


class SiteConfigsTests(unittest.TestCase):
    def test_every_registered_site_has_a_config_and_matching_source_ids(self):
        import json
        from sources import REGISTRY, dlpsgame, espacypkg, pkggames, pspkg, romsfun, romspure, superpsx, arabicps4
        from fakes import PROJECT_ROOT
        with open(PROJECT_ROOT / "catalog" / "sources.json", encoding="utf-8") as fh:
            known = {s["id"] for s in json.load(fh)["sources"]}
        for mod in (dlpsgame, espacypkg, pkggames, pspkg, romsfun, romspure, superpsx, arabicps4):
            site = mod.SITE
            self.assertEqual(site.id, mod.SOURCE.id)
            self.assertTrue(site.base.startswith("https://"))
            self.assertIn(site.id, REGISTRY)
            for sid in mod.SOURCE.release_source_ids:
                self.assertIn(sid, known, f"{mod.SOURCE.id} emits unknown sourceId {sid}")


if __name__ == "__main__":
    unittest.main()
