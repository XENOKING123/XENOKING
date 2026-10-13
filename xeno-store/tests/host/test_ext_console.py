#!/usr/bin/env python3
"""
test_ext_console.py — console feature tests for the host build (SPEC §17):
Phase 2 settings fields, readiness checks, offline accounts (simulated
registry), saves hub (users/list/backup/restore/transfer with zip content
assertions and pre-backups), Save Data Store (index + compatibility against
simulated installed versions, install through the simulated native engine,
export → manifest → zip, upload adapters, submission), uninstall path
allowlist, ghost icon cleaner, companion payloads (sha256 + ELF loader),
homebrew listing parser on fixture HTML, enrichment cache + fail-soft, image
proxy allowlist, library usage/clean/launch/uninstall and the mDNS packet
builder.

Every external service is a loopback mock: the host build accepts loopback
hosts in its allowlists and reads XENO_*_BASE / XENO_PORT_* overrides.
"""
import base64
import hashlib
import http.server
import io
import json
import os
import shutil
import socket
import struct
import sys
import tempfile
import threading
import time
import unittest
import zipfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness  # noqa: E402

PLAYER = 0x179A0CD8
GUEST = 0x2B3C4D5E
TITLE = "PPSA01234"
OTHER_TITLE = "PPSA09999"
UNINSTALL_TITLE = "PPSA07777"
PS4_TITLE = "CUSA05678"


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

def build_sfo(entries):
    """Minimal PSF (param.sfo) writer: entries = [(key, fmt, data, max_len)]."""
    keys = b""
    key_offsets = []
    for k, _, _, _ in entries:
        key_offsets.append(len(keys))
        keys += k.encode() + b"\0"
    data = b""
    data_offsets = []
    for _, _, d, mx in entries:
        data_offsets.append(len(data))
        data += d.ljust(mx, b"\0")
    n = len(entries)
    key_start = 20 + 16 * n
    data_start = key_start + len(keys)
    pad = (-data_start) % 4
    data_start += pad
    hdr = b"\0PSF" + struct.pack("<IIII", 0x0101, key_start, data_start, n)
    idx = b"".join(struct.pack("<HHIII", key_offsets[i], entries[i][1], len(entries[i][2]), entries[i][3], data_offsets[i]) for i in range(n))
    return hdr + idx + keys + b"\0" * pad + data


def sfo_get(buf, key):
    key_start, data_start, n = struct.unpack("<III", buf[8:20])
    for i in range(n):
        koff, fmt, ln, mx, doff = struct.unpack("<HHIII", buf[20 + 16 * i:36 + 16 * i])
        k = buf[key_start + koff:].split(b"\0", 1)[0].decode()
        if k == key:
            return fmt, buf[data_start + doff:data_start + doff + mx]
    return None


def make_sfo(account_id):
    return build_sfo([
        ("ACCOUNT_ID", 0x0404, struct.pack("<Q", account_id), 8),
        ("MAINTITLE", 0x0204, b"Test Game", 128),
        ("SAVEDATA_DIRECTORY", 0x0204, b"SAVEDATA00", 64),
        ("TITLE_ID", 0x0204, TITLE.encode(), 12),
    ])


def write(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as f:
        f.write(data)


def read(path):
    with open(path, "rb") as f:
        return f.read()


def dns_query(name, qtype=1, qclass=1, qid=0x1234):
    pkt = struct.pack(">HHHHHH", qid, 0, 1, 0, 0, 0)
    for label in name.split("."):
        pkt += bytes([len(label)]) + label.encode()
    pkt += b"\0" + struct.pack(">HH", qtype, qclass)
    return pkt


def dns_read_name(pkt, pos):
    labels = []
    while True:
        ln = pkt[pos]
        pos += 1
        if ln == 0:
            break
        labels.append(pkt[pos:pos + ln].decode())
        pos += ln
    return ".".join(labels), pos


PKGZONE_PAGE1 = """<!doctype html><html><body>
<div class="grid">
<article class="pkg card rounded">
  <a href="/details/retroarch_ps5"><img src="/images/retroarch_ps5/cover.png"></a>
  <h2 class="title font-bold">RetroArch (PS5)</h2>
  <span class="number text-sm">1.19.1</span>
  <span class="text-gray-300">Libretro Team</span>
  <span class="badge">Supports PS5</span>
</article>
<article class="not-a-pkg"><a href="/details/ignored_one">x</a><h2 class="title font-bold">Ignored</h2></article>
<article class="pkg card">
  <a href="/details/ftp_server_42">FTP</a>
  <h2 class="title font-bold">Simple FTP &amp; Tools</h2>
  <span class="number">0.9</span>
  <span class="text-gray-300">someone</span>
</article>
</div></body></html>"""
PKGZONE_PAGE_EMPTY = "<html><body><p>No more packages</p></body></html>"

PNG_BYTES = b"\x89PNG\r\n\x1a\n" + b"\0" * 64


class Mock(http.server.BaseHTTPRequestHandler):
    """Loopback mock for Steam, pkg-zone, save index/zips, feeds, uploads."""
    state = {"routes": {}, "requests": [], "uploads": []}

    def log_message(self, *a):
        pass

    def _lookup(self):
        path = self.path.split("?", 1)[0]
        query = self.path.split("?", 1)[1] if "?" in self.path else ""
        r = self.state["routes"].get(path)
        if r is None:
            for k, v in self.state["routes"].items():
                if k.endswith("*") and path.startswith(k[:-1]):
                    r = v
                    break
        if r is None:
            return 404, "application/json", b'{"error":"not found"}'
        status, ctype, body = r
        if callable(body):
            body = body(query)
        if isinstance(body, str):
            body = body.encode()
        return status, ctype, body

    def _send(self, status, ctype, body, head=False):
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if not head:
            self.wfile.write(body)

    def do_GET(self):
        self.state["requests"].append(("GET", self.path))
        self._send(*self._lookup())

    def do_HEAD(self):
        self.state["requests"].append(("HEAD", self.path))
        status, ctype, body = self._lookup()
        self._send(status, ctype, body, head=True)

    def _read_body(self):
        n = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(n) if n else b""

    def do_POST(self):
        body = self._read_body()
        self.state["requests"].append(("POST", self.path))
        if self.path.startswith("/upload"):
            self.state["uploads"].append({"method": "POST", "path": self.path, "ctype": self.headers.get("Content-Type", ""), "body": body})
            port = self.server.server_address[1]
            self._send(200, "application/json", json.dumps({"url": f"http://127.0.0.1:{port}/files/uploaded.zip"}).encode())
            return
        if self.path.startswith("/user/api.php"):
            self.state["uploads"].append({"method": "POST", "path": self.path, "ctype": self.headers.get("Content-Type", ""), "body": body})
            self._send(200, "text/plain", b"https://files.catbox.moe/abcd12.zip")
            return
        if self.path.startswith("/submit"):
            self.state["uploads"].append({"method": "POST", "path": self.path, "ctype": self.headers.get("Content-Type", ""), "body": body})
            self._send(200, "application/json", b'{"ok":true}')
            return
        self._send(*self._lookup())

    def do_PUT(self):
        body = self._read_body()
        self.state["requests"].append(("PUT", self.path))
        self.state["uploads"].append({"method": "PUT", "path": self.path, "ctype": self.headers.get("Content-Type", ""), "body": body})
        if self.path.startswith("/api/file/"):
            self._send(201, "application/json", b'{"id":"pd1234"}')
            return
        self._send(404, "application/json", b"{}")


def serve_mock():
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Mock)
    srv.daemon_threads = True
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    return srv, srv.server_address[1]


class TcpSink(threading.Thread):
    """Accepts connections and records everything received (fake ELF loader / daemon)."""

    def __init__(self):
        super().__init__(daemon=True)
        self.sock = socket.socket()
        self.sock.bind(("127.0.0.1", 0))
        self.sock.listen(4)
        self.port = self.sock.getsockname()[1]
        self.received = []
        self.start()

    def run(self):
        while True:
            try:
                c, _ = self.sock.accept()
            except OSError:
                return
            c.settimeout(5)
            buf = b""
            try:
                while True:
                    d = c.recv(65536)
                    if not d:
                        break
                    buf += d
            except OSError:
                pass
            c.close()
            self.received.append(buf)


# ---------------------------------------------------------------------------
# the suite
# ---------------------------------------------------------------------------

class ConsoleTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp(prefix="xeno-console-")
        cls.data = os.path.join(cls.tmp, "data")
        cls.sim = os.path.join(cls.data, "sim")
        cls.mock, cls.mport = serve_mock()
        cls.base = f"http://127.0.0.1:{cls.mport}"
        cls.loader = TcpSink()
        cls.shadow = TcpSink()
        cls.elf = b"\x7fELF" + bytes(range(256)) * 16
        cls.elf_sha = hashlib.sha256(cls.elf).hexdigest()
        cls._setup_routes()
        cls._setup_console()
        harness.write_catalog(cls.data, [
            harness.make_game("test-game-ps5", "Test Game", TITLE, [
                harness.make_release("r1", f"{cls.base}/game.bin", "PPSA01234 Test Game.ffpfsc", 1024),
            ]),
            harness.make_game("other-game-ps4", "Unknown Pixel Thing", PS4_TITLE, [
                harness.make_release("r2", f"{cls.base}/other.bin", "CUSA05678 Other.pkg", 1024, fmt="PKG", title_id=PS4_TITLE),
            ], platform="PS4"),
            harness.make_game("uninstall-me-ps5", "Uninstall Me", UNINSTALL_TITLE, [
                harness.make_release("r3", f"{cls.base}/u.bin", "PPSA07777 U.ffpfsc", 1024, title_id=UNINSTALL_TITLE),
            ]),
        ])
        env = {
            "XENO_STEAM_BASE": cls.base,
            "XENO_PKGZONE_BASE": cls.base,
            "XENO_PIXELDRAIN_BASE": cls.base,
            "XENO_CATBOX_BASE": cls.base,
            "XENO_PORT_LOADER": str(cls.loader.port),
            "XENO_PORT_SHADOWMOUNT": str(cls.shadow.port),
            "XENO_PORT_DPI": "1",
            "XENO_PORT_ETAHEN": "1",
            "XENO_PORT_GARLIC": "1",
        }
        cls.srv = harness.XenoServer(cls.data, env=env).start()
        cls.root = cls.srv.default_root
        # point every feed at the mock
        st, b = cls.srv.api("PUT", "/api/settings", {
            "catalog": {"revisionUrl": f"{cls.base}/revision.json", "featuredUrl": f"{cls.base}/featured.json",
                        "messagesUrl": f"{cls.base}/messages.json", "companionsUrl": f"{cls.base}/companions.json",
                        "savesBackendUrl": f"{cls.base}/saves-backend.json"},
            "saves": {"indexUrls": [f"{cls.base}/saves.json"], "backend": {"kind": "none"},
                      "uploadEndpoint": f"{cls.base}/upload", "nickname": "tester"},
        })
        assert st == 200, b
        st, b = cls.srv.api("POST", "/api/feeds/refresh", {})
        assert st == 200, b

    @classmethod
    def tearDownClass(cls):
        cls.srv.stop()
        cls.mock.shutdown()
        shutil.rmtree(cls.tmp, ignore_errors=True)

    # ---- fixtures --------------------------------------------------------
    @classmethod
    def _setup_routes(cls):
        r = Mock.state["routes"]
        base = cls.base
        r["/revision.json"] = (200, "application/json", json.dumps({"revision": 1}))
        r["/featured.json"] = (200, "application/json", json.dumps({"hero": ["test-game-ps5"], "rows": [{"title": {"en": "Staff picks"}, "ids": ["test-game-ps5"]}]}))
        r["/messages.json"] = (200, "application/json", json.dumps({"messages": [{"id": "m1", "ts": 1, "texts": {"en": "Hello from the mock"}}]}))
        r["/companions.json"] = (200, "application/json", json.dumps({"payloads": [
            {"id": "shadowmountplus", "name": "ShadowMountPlus", "version": "1.2", "url": f"{base}/smp.elf", "sha256": cls.elf_sha, "notes": "mounts dumps", "kind": "loader"},
            {"id": "badhash", "name": "Bad Hash", "version": "1", "url": f"{base}/smp.elf", "sha256": "00" * 32},
            {"id": "notelf", "name": "Not ELF", "version": "1", "url": f"{base}/notelf.bin", "sha256": ""},
            {"id": "webpage", "name": "Web page", "version": "1", "url": f"{base}/page.html", "sha256": ""},
        ]}))
        r["/saves-backend.json"] = (200, "application/json", json.dumps({"kind": "github"}))
        r["/smp.elf"] = (200, "application/octet-stream", cls.elf)
        r["/notelf.bin"] = (200, "application/octet-stream", b"NOTANELF" * 64)
        r["/cover.png"] = (200, "image/png", PNG_BYTES)
        r["/page.html"] = (200, "text/html", "<html><body>not an image</body></html>")
        r["/"] = (200, "text/html", lambda q: PKGZONE_PAGE1 if q in ("page=1", "") else PKGZONE_PAGE_EMPTY)
        r["/api/storesearch/"] = (200, "application/json", lambda q: json.dumps(
            {"total": 1, "items": [{"id": 1091500, "name": "Test Game"}]} if "Test" in q.replace("%20", " ") else {"total": 0, "items": []}))
        r["/api/appdetails"] = (200, "application/json", json.dumps({"1091500": {"success": True, "data": {
            "screenshots": [{"id": 0, "path_full": f"{base}/s1.jpg"}, {"id": 1, "path_full": f"{base}/s2.jpg"}],
            "about_the_game": "<p>A <strong>great</strong> game.<br>Second line.</p>",
            "developers": ["Dev Studio"], "publishers": ["Pub Co"], "metacritic": {"score": 86},
            "categories": [{"id": 2, "description": "Single-player"}, {"id": 1, "description": "Multi-player"}],
            "genres": [{"id": "1", "description": "Action"}],
            "supported_languages": "English<strong>*</strong>, French, German<br><strong>*</strong>languages with full audio support",
            "release_date": {"coming_soon": False, "date": "10 Dec, 2020"}, "required_age": "18"}}}))
        # community save zip + index
        sfo = make_sfo(0x1122334455667788)
        bio = io.BytesIO()
        with zipfile.ZipFile(bio, "w", zipfile.ZIP_DEFLATED) as z:
            z.writestr("game.dat", b"COMMUNITY-SAVE-" + b"x" * 4000)
            z.writestr("sce_sys/param.sfo", sfo)
            z.writestr("sce_sys/sealedkey", b"SECRET")
            z.writestr("xeno-save.json", json.dumps({"titleId": TITLE, "dirName": "SAVEDATA00", "gameVersion": "01.004.000", "region": "EUR", "files": []}))
        cls.save_zip = bio.getvalue()
        cls.save_sha = hashlib.sha256(cls.save_zip).hexdigest()
        r["/save.zip"] = (200, "application/zip", cls.save_zip)
        r["/saves.json"] = (200, "application/json", json.dumps({"schemaVersion": 1, "saves": [
            {"id": "sv_match", "titleId": TITLE, "gameId": "test-game-ps5", "title": "Test Game", "category": "starter", "name": "Match", "description": "max money",
             "author": "nick", "gameVersion": "01.004.000", "region": "EUR", "dirName": "SAVEDATA00", "size": len(cls.save_zip), "sha256": cls.save_sha,
             "url": f"{base}/save.zip", "format": "xeno-save-zip", "createdAt": "2026-10-01", "downloads": 3, "status": "published", "tags": ["ng+"]},
            {"id": "sv_newer", "titleId": TITLE, "title": "Test Game", "name": "Newer", "description": "100% platinum run", "gameVersion": "01.006.000", "url": f"{base}/save.zip", "status": "published"},
            {"id": "sv_unknown", "titleId": TITLE, "title": "Test Game", "name": "No version", "url": f"{base}/save.zip", "status": "published"},
            {"id": "sv_other", "titleId": OTHER_TITLE, "title": "Other", "name": "Other game", "gameVersion": "01.000.000", "url": f"{base}/save.zip", "status": "published"},
            {"id": "sv_pending", "titleId": TITLE, "name": "pending", "url": f"{base}/save.zip", "status": "pending"},
            {"id": "sv_dup", "titleId": TITLE, "name": "dup of match", "sha256": cls.save_sha, "url": f"{base}/save.zip", "status": "published"},
            {"id": "sv_ps4", "titleId": PS4_TITLE, "name": "ps4 not allowed", "url": f"{base}/save.zip", "status": "published"},
            {"id": "sv_badhash", "titleId": TITLE, "title": "Test Game", "name": "bad hash", "gameVersion": "01.004.000", "sha256": "00" * 32, "url": f"{base}/save.zip", "status": "published"},
        ]}))

    @classmethod
    def home(cls, uid):
        return os.path.join(cls.sim, "user", "home", f"{uid:x}")

    @classmethod
    def _setup_console(cls):
        os.makedirs(cls.sim, exist_ok=True)
        with open(os.path.join(cls.sim, "users.json"), "w") as f:
            json.dump({"users": [{"id": PLAYER, "name": "Player", "foreground": True}, {"id": GUEST, "name": "Guest", "foreground": False}]}, f)
        # PS5 save for Player: raw image + sce_sys + simulated decrypted content
        t = os.path.join(cls.home(PLAYER), "savedata_prospero", TITLE)
        cls.original_image = b"IMG" + os.urandom(65536)
        write(os.path.join(t, "sdimg_SAVEDATA00"), cls.original_image)
        write(os.path.join(t, "sce_sys", "SAVEDATA00", "param.sfo"), make_sfo(0xABCDEF))
        write(os.path.join(t, ".sim", "SAVEDATA00", "game.dat"), b"ORIGINAL-DECRYPTED-" + b"y" * 10000)
        write(os.path.join(t, ".sim", "SAVEDATA00", "sce_sys", "param.sfo"), make_sfo(0xABCDEF))
        # PS4 save for Player
        write(os.path.join(cls.home(PLAYER), "savedata", PS4_TITLE, "sdimg_X"), b"ps4" * 100)
        os.makedirs(cls.home(GUEST), exist_ok=True)
        # installed titles + appmeta versions
        for tid in (TITLE, UNINSTALL_TITLE):
            os.makedirs(os.path.join(cls.data, "user", "app", tid), exist_ok=True)
        write(os.path.join(cls.sim, "system_data", "priv", "appmeta", TITLE, "param.json"), json.dumps({"contentVersion": "01.004.000"}).encode())
        write(os.path.join(cls.data, "user", "app", UNINSTALL_TITLE, "sce_sys", "param.json"), json.dumps({"contentVersion": "01.000.000"}).encode())
        # home-screen app folders for the ghost cleaner
        write(os.path.join(cls.sim, "data", "homebrew", "OTHER-APP", "eboot.bin"), b"\x7fELF")
        write(os.path.join(cls.sim, "data", "homebrew", "OTHER-APP", "sce_sys", "icon0.png"), PNG_BYTES)
        write(os.path.join(cls.sim, "data", "homebrew", "OTHER-APP", "sce_sys", "param.json"), json.dumps({"localizedParameters": {"en-US": {"titleName": "Other App"}}}).encode())
        write(os.path.join(cls.sim, "data", "homebrew", "GHOST", "icon.png"), b"x")

    # ---- settings ----------------------------------------------------------
    def test_01_settings_phase2_fields(self):
        st, b = self.srv.api("GET", "/api/settings")
        s = b["settings"]
        self.assertEqual(s["general"]["screensaverMinutes"], 3)
        self.assertTrue(s["general"]["mdns"])
        self.assertFalse(s["general"]["safeMode"])
        self.assertEqual(s["downloads"]["preferFormat"], "auto")
        self.assertTrue(s["downloads"]["turboStart"])
        self.assertTrue(s["downloads"]["autoInstallSets"])
        self.assertEqual(s["downloads"]["installOrder"], "game,backport,update,dlc")
        self.assertTrue(s["downloads"]["restModeAutoResume"])
        self.assertTrue(s["downloads"]["extractZip"])
        self.assertTrue(s["downloads"]["deleteArchiveAfterExtract"])
        self.assertEqual(s["debrid"]["preferred"], "auto")
        for k in ("realdebrid", "alldebrid", "torbox", "premiumize"):
            self.assertEqual(s["debrid"][k]["apiKey"], "")
        for k in ("featuredUrl", "messagesUrl", "companionsUrl", "savesBackendUrl"):
            self.assertIn("127.0.0.1", s["catalog"][k])   # set by setUpClass
        self.assertTrue(s["saves"]["autoBackup"])
        self.assertEqual(s["saves"]["backend"]["kind"], "none")
        self.assertEqual(s["saves"]["uploadHost"], "pixeldrain")
        self.assertEqual(s["browse"]["presets"], [])
        st, b = self.srv.api("PUT", "/api/settings", {
            "general": {"largeText": True, "highContrast": True, "screensaver": False, "screensaverMinutes": 99, "controllerSwapConfirm": True},
            "downloads": {"preferFormat": "ffpfsc", "turboStart": False, "installOrder": "dlc, game", "extractZip": False},
            "debrid": {"realdebrid": {"apiKey": "RDKEY123"}, "torbox": "TBKEY", "preferred": "realdebrid"},
            "saves": {"uploadHost": "catbox", "backend": {"kind": "supabase", "url": "https://abc.supabase.co/", "anonKey": "anon"}},
            "browse": {"presets": [{"name": "Small PS5", "filters": {"platform": ["PS5"], "size": "le20"}, "sort": "smallest"}]},
        })
        self.assertEqual(st, 200, b)
        s = b["settings"]
        self.assertTrue(s["general"]["largeText"])
        self.assertEqual(s["general"]["screensaverMinutes"], 30)   # clamped
        self.assertFalse(s["general"]["screensaver"])
        self.assertEqual(s["downloads"]["preferFormat"], "FFPFSC")   # canonical spelling
        self.assertFalse(s["downloads"]["turboStart"])
        self.assertEqual(s["downloads"]["installOrder"], "dlc,game,backport,update")   # missing kinds appended
        self.assertEqual(s["debrid"]["realdebrid"]["apiKey"], "RDKEY123")
        self.assertEqual(s["debrid"]["torbox"]["apiKey"], "TBKEY")
        self.assertEqual(s["debrid"]["preferred"], "realdebrid")
        self.assertEqual(s["saves"]["uploadHost"], "catbox")
        self.assertEqual(s["saves"]["backend"]["url"], "https://abc.supabase.co")   # trailing slash stripped
        self.assertEqual(s["saves"]["backend"]["bucket"], "ps5-saves")
        self.assertEqual(s["browse"]["presets"][0]["filters"], {"platform": ["PS5"], "size": "le20"})
        self.assertEqual(s["browse"]["presets"][0]["sort"], "smallest")
        with open(os.path.join(self.data, "settings.json")) as f:
            disk = json.load(f)
        self.assertEqual(disk["browse"]["presets"][0]["name"], "Small PS5")
        self.assertEqual(disk["debrid"]["realdebrid"]["apiKey"], "RDKEY123")
        # validation
        for bad in ({"downloads": {"preferFormat": "rar"}}, {"downloads": {"installOrder": "game,movie"}},
                    {"debrid": {"preferred": "megaupload"}}, {"saves": {"backend": {"kind": "ftp"}}},
                    {"saves": {"uploadHost": "mega"}}, {"saves": {"indexUrls": ["ftp://x"]}}, {"catalog": {"featuredUrl": "nope"}}):
            st, b = self.srv.api("PUT", "/api/settings", bad)
            self.assertEqual(st, 400, (bad, b))
            self.assertEqual(b["error"], "invalid_settings")
        # export carries the new groups; import restores them
        st, ex = self.srv.api("GET", "/api/export")
        for k in ("debrid", "saves", "browse"):
            self.assertIn(k, ex["settings"])
        ex["settings"]["debrid"]["realdebrid"]["apiKey"] = "FROM-IMPORT"
        st, b = self.srv.api("POST", "/api/import", ex)
        self.assertEqual(st, 200, b)
        st, b = self.srv.api("GET", "/api/settings")
        self.assertEqual(b["settings"]["debrid"]["realdebrid"]["apiKey"], "FROM-IMPORT")
        # restore the defaults this suite relies on
        st, b = self.srv.api("PUT", "/api/settings", {
            "general": {"screensaver": True, "screensaverMinutes": 3},
            "downloads": {"preferFormat": "auto", "turboStart": True, "installOrder": "game,backport,update,dlc", "extractZip": True},
            "debrid": {"realdebrid": {"apiKey": ""}, "torbox": {"apiKey": ""}, "preferred": "auto"},
            "saves": {"uploadHost": "pixeldrain", "backend": {"kind": "none", "url": "", "anonKey": ""}},
            "browse": {"presets": []},
        })
        self.assertEqual(st, 200, b)

    # ---- status extras + feeds ---------------------------------------------
    def test_02_status_extra_and_feeds(self):
        st, b = self.srv.api("GET", "/api/status")
        self.assertEqual(st, 200)
        self.assertEqual(b["featured"]["hero"], ["test-game-ps5"])
        self.assertEqual(b["messages"][0]["id"], "m1")
        self.assertIn("checked", b["setup"])
        self.assertEqual(b["savesEngine"], "native")
        self.assertEqual(b["mdns"]["names"], ["xeno.local", "xenostore.local"])
        st, f = self.srv.api("GET", "/api/feeds")
        self.assertEqual(f["companions"]["payloads"][0]["id"], "shadowmountplus")
        self.assertTrue(os.path.exists(os.path.join(self.data, "feeds", "featured.json")))

    # ---- setup checks ------------------------------------------------------
    def test_03_setup_checks(self):
        st, b = self.srv.api("GET", "/api/setup/check")
        self.assertEqual(st, 200, b)
        checks = {c["id"]: c for c in b["checks"]}
        for cid in ("shadowmount", "dpi", "etahen", "internet", "drive", "space", "firmware", "payload-manager"):
            self.assertIn(cid, checks)
            self.assertTrue(checks[cid]["detail"])
            self.assertTrue(checks[cid]["fix"])
        self.assertTrue(checks["shadowmount"]["ok"])      # TcpSink answers on the overridden port
        self.assertFalse(checks["dpi"]["ok"])              # port 1 → nothing listens
        self.assertTrue(checks["dpi"]["optional"])
        self.assertTrue(checks["internet"]["ok"])          # HEAD to the mock revision URL
        self.assertTrue(checks["drive"]["ok"])
        self.assertTrue(checks["payload-manager"]["ok"])
        self.assertTrue(b["payloadsUrl"].endswith("updates/payloads.json"))
        self.assertEqual(b["summary"]["total"], len(b["checks"]))
        self.assertTrue(any(("HEAD", "/revision.json") == r for r in Mock.state["requests"]))

    # ---- accounts ----------------------------------------------------------
    def test_04_accounts(self):
        st, b = self.srv.api("GET", "/api/accounts")
        self.assertEqual(st, 200, b)
        self.assertTrue(b["supported"] and b["simulated"])
        slots = {s["slot"]: s for s in b["slots"]}
        self.assertEqual(sorted(slots), list(range(1, 17)))   # every registry slot, empty ones flagged
        self.assertTrue(slots[7]["empty"] and not slots[7]["activated"])
        self.assertFalse(slots[1]["empty"])
        self.assertEqual(slots[1]["name"], "Player")
        self.assertEqual(slots[2]["name"], "Guest")
        self.assertFalse(slots[1]["activated"])
        self.assertTrue(slots[1]["foreground"])
        self.assertFalse(slots[2]["foreground"])
        self.assertEqual(b["foregroundUser"]["name"], "Player")
        self.assertEqual(len(b["users"]), 2)
        derived = slots[1]["derivedId"]
        st, b = self.srv.api("POST", "/api/accounts/1/activate", {})
        self.assertEqual(st, 200, b)
        self.assertEqual(b["id"], derived)
        self.assertTrue(b["rebootRequired"])
        st, b = self.srv.api("GET", "/api/accounts")
        s1 = [s for s in b["slots"] if s["slot"] == 1][0]
        self.assertTrue(s1["activated"])
        self.assertEqual(s1["type"], "np")
        self.assertEqual(s1["flags"], 0x1002)
        with open(os.path.join(self.sim, "registry.json")) as f:
            self.assertIn("keys", json.load(f))
        st, b = self.srv.api("POST", "/api/accounts/2/activate", {"id": "0x1122334455667788"})
        self.assertEqual(st, 200, b)
        self.assertEqual(b["id"], "0x1122334455667788")
        st, b = self.srv.api("POST", "/api/accounts/2/activate", {"id": "not-hex"})
        self.assertEqual(st, 400)
        st, b = self.srv.api("POST", "/api/accounts/2/clear", {})
        self.assertEqual(st, 200, b)
        st, b = self.srv.api("GET", "/api/accounts")
        s2 = [s for s in b["slots"] if s["slot"] == 2][0]
        self.assertFalse(s2["activated"])
        self.assertEqual(s2["id"], "0x" + "0" * 16)
        st, b = self.srv.api("POST", "/api/accounts/99/activate", {})
        self.assertEqual(st, 400)
        st, b = self.srv.api("POST", "/api/accounts/7/activate", {})   # empty slot
        self.assertEqual(st, 422)
        st, b = self.srv.api("POST", "/api/accounts/reboot", {})
        self.assertEqual(st, 200, b)
        self.assertTrue(b["simulated"])

    # ---- saves hub -----------------------------------------------------------
    def test_10_saves_users_and_list(self):
        st, b = self.srv.api("GET", "/api/saves/users")
        self.assertEqual([u["name"] for u in b["users"]], ["Player", "Guest"])
        self.assertTrue(b["users"][0]["foreground"])
        st, b = self.srv.api("GET", f"/api/saves?user={PLAYER}")
        self.assertEqual(st, 200, b)
        saves = {s["titleId"]: s for s in b["saves"]}
        self.assertIn(TITLE, saves)
        self.assertEqual(saves[TITLE]["kind"], "ps5")
        self.assertEqual(saves[TITLE]["title"], "Test Game")
        self.assertIn("SAVEDATA00", saves[TITLE]["dirs"])
        self.assertTrue(saves[TITLE]["installed"])
        self.assertGreater(saves[TITLE]["size"], 65536)
        self.assertEqual(saves[PS4_TITLE]["kind"], "ps4")
        self.assertIn("X", saves[PS4_TITLE]["dirs"])
        st, b = self.srv.api("GET", "/api/saves")   # foreground user by default
        self.assertEqual(b["user"]["name"], "Player")
        st, b = self.srv.api("GET", "/api/saves?user=12345")
        self.assertEqual(st, 404)

    def test_11_saves_backup_restore(self):
        st, b = self.srv.api("POST", "/api/saves/backup", {"user": PLAYER, "titleId": TITLE, "wait": True})
        self.assertEqual(st, 200, b)
        job = b["job"]
        self.assertEqual(job["type"], "backup")
        self.assertEqual(job["state"], "done", job)
        zp = job["result"]["zipPath"]
        self.assertTrue(zp.startswith(os.path.join(self.root, "xeno-store", "saves", "Player")), zp)
        self.assertRegex(os.path.basename(zp), r"^PPSA01234_ps5_\d{8}-\d{4}\.zip$")
        with zipfile.ZipFile(zp) as z:
            names = set(z.namelist())
            self.assertIn("sdimg_SAVEDATA00", names)
            self.assertIn("sce_sys/SAVEDATA00/param.sfo", names)
            self.assertIn("xeno-backup.json", names)
            self.assertEqual(z.read("sdimg_SAVEDATA00"), self.original_image)
            man = json.loads(z.read("xeno-backup.json"))
            self.assertEqual(man["titleId"], TITLE)
            self.assertEqual(man["kind"], "ps5")
            self.assertEqual(man["user"]["name"], "Player")
        st, b = self.srv.api("GET", "/api/saves/backups")
        found = [x for x in b["backups"] if x["path"] == zp]
        self.assertEqual(len(found), 1)
        self.assertEqual(found[0]["titleId"], TITLE)
        self.assertEqual(found[0]["user"], "Player")
        self.assertFalse(found[0]["preRestore"])
        # damage the live save, then restore
        img = os.path.join(self.home(PLAYER), "savedata_prospero", TITLE, "sdimg_SAVEDATA00")
        write(img, b"CORRUPTED")
        st, b = self.srv.api("POST", "/api/saves/restore", {"user": PLAYER, "zipPath": zp})
        self.assertEqual(st, 409, b)
        self.assertEqual(b["error"], "exists")
        st, b = self.srv.api("POST", "/api/saves/restore", {"user": PLAYER, "zipPath": "/etc/passwd"})
        self.assertEqual(st, 403)
        st, b = self.srv.api("POST", "/api/saves/restore", {"user": PLAYER, "zipPath": zp, "overwrite": True})
        self.assertEqual(st, 200, b)
        self.assertEqual(b["style"], "raw")
        self.assertTrue(b["preBackup"].endswith(".pre-restore.zip"), b)
        self.assertTrue(os.path.exists(b["preBackup"]))
        with zipfile.ZipFile(b["preBackup"]) as z:
            self.assertEqual(z.read("sdimg_SAVEDATA00"), b"CORRUPTED")
        with open(img, "rb") as f:
            self.assertEqual(f.read(), self.original_image)
        self.assertFalse(os.path.exists(os.path.join(self.home(PLAYER), "savedata_prospero", TITLE, "xeno-backup.json")))
        st, b = self.srv.api("GET", "/api/saves/backups")
        self.assertTrue(any(x["preRestore"] for x in b["backups"]))
        # back up everything at once → one job per title
        st, b = self.srv.api("POST", "/api/saves/backup", {"user": PLAYER, "all": True})
        self.assertEqual(st, 200, b)
        self.assertEqual(b["started"], 2)
        for jid in b["jobs"]:
            deadline = time.time() + 30
            while time.time() < deadline:
                st, j = self.srv.api("GET", f"/api/saves/jobs/{jid}")
                if j["job"]["state"] in ("done", "failed", "cancelled"):
                    break
                time.sleep(0.1)
            self.assertEqual(j["job"]["state"], "done", j)
        st, b = self.srv.api("POST", "/api/saves/backup", {"user": PLAYER, "titleId": "PPSA00000"})
        self.assertEqual(st, 404)
        st, b = self.srv.api("GET", "/api/saves/jobs/nope")
        self.assertEqual(st, 404)

    def test_12_saves_transfer(self):
        src = os.path.join(self.home(PLAYER), "savedata_prospero", TITLE)
        dst = os.path.join(self.home(GUEST), "savedata_prospero", TITLE)
        st, b = self.srv.api("POST", "/api/saves/transfer", {"fromUser": PLAYER, "toUser": GUEST, "titleId": TITLE})
        self.assertEqual(st, 200, b)
        self.assertEqual(b["preBackup"], "")
        self.assertFalse(b["moved"])
        with open(os.path.join(dst, "sdimg_SAVEDATA00"), "rb") as f:
            self.assertEqual(f.read(), self.original_image)
        self.assertTrue(os.path.exists(os.path.join(src, "sdimg_SAVEDATA00")))
        # second transfer onto an existing destination → pre-backup first; move removes the source copy
        write(os.path.join(dst, "sdimg_SAVEDATA00"), b"GUEST-VERSION")
        st, b = self.srv.api("POST", "/api/saves/transfer", {"fromUser": PLAYER, "toUser": GUEST, "titleId": TITLE, "move": True})
        self.assertEqual(st, 200, b)
        self.assertTrue(b["preBackup"].endswith(".pre-restore.zip"))
        self.assertIn(os.path.join("saves", "Guest"), b["preBackup"])
        with zipfile.ZipFile(b["preBackup"]) as z:
            self.assertEqual(z.read("sdimg_SAVEDATA00"), b"GUEST-VERSION")
        self.assertTrue(b["moved"])
        self.assertFalse(os.path.exists(src))
        with open(os.path.join(dst, "sdimg_SAVEDATA00"), "rb") as f:
            self.assertEqual(f.read(), self.original_image)
        # move it back so later tests still find Player's save
        st, b = self.srv.api("POST", "/api/saves/transfer", {"fromUser": GUEST, "toUser": PLAYER, "titleId": TITLE, "move": True})
        self.assertEqual(st, 200, b)
        self.assertTrue(os.path.exists(os.path.join(src, "sdimg_SAVEDATA00")))
        st, b = self.srv.api("POST", "/api/saves/transfer", {"fromUser": PLAYER, "toUser": PLAYER, "titleId": TITLE})
        self.assertEqual(st, 400)
        st, b = self.srv.api("POST", "/api/saves/transfer", {"fromUser": PLAYER, "toUser": GUEST, "titleId": "PPSA00000"})
        self.assertEqual(st, 404)

    # ---- save data store -----------------------------------------------------
    def test_20_store_list_compatibility(self):
        st, b = self.srv.api("GET", "/api/saves/engine")
        self.assertEqual(b["tier"], "native")
        self.assertTrue(b["simulated"])
        self.assertFalse(b["garlic"]["available"])
        st, b = self.srv.api("GET", "/api/saves/store?refresh=1")
        self.assertEqual(st, 200, b)
        rows = {r["id"]: r for r in b["saves"]}
        self.assertIn("sv_match", rows)
        self.assertNotIn("sv_pending", rows)     # only published rows
        self.assertNotIn("sv_dup", rows)         # deduped by sha256
        self.assertNotIn("sv_ps4", rows)         # PS5 only
        m = rows["sv_match"]
        self.assertTrue(m["installed"])
        self.assertEqual(m["installedVersion"], "01.004.000")
        self.assertEqual(m["compat"], "match")
        self.assertEqual(m["category"], "starter")
        self.assertEqual(m["source"], "github")
        self.assertEqual(m["tags"], ["ng+"])
        self.assertEqual(rows["sv_newer"]["compat"], "update_game")
        self.assertEqual(rows["sv_newer"]["category"], "platinum")   # inferred from the notes
        self.assertIn("update the game first", rows["sv_newer"]["compatText"])
        self.assertEqual(rows["sv_unknown"]["compat"], "unknown")
        self.assertEqual(rows["sv_other"]["compat"], "not_installed")
        self.assertEqual(b["backend"], "none")
        self.assertEqual(b["engine"], "native")
        self.assertTrue(any(s["kind"] == "github" and s["rows"] >= 5 for s in b["sources"]))
        st, b = self.srv.api("GET", f"/api/saves/store?titleId={OTHER_TITLE}")
        self.assertEqual([r["id"] for r in b["saves"]], ["sv_other"])
        st, b = self.srv.api("GET", "/api/saves/store?category=platinum")
        self.assertEqual([r["id"] for r in b["saves"]], ["sv_newer"])
        st, b = self.srv.api("GET", "/api/saves/store?q=nick")
        self.assertEqual([r["id"] for r in b["saves"]], ["sv_match"])
        st, b = self.srv.api("GET", f"/api/saves/installed-version?titleId={TITLE}")
        self.assertEqual(b["version"], "01.004.000")
        self.assertEqual(b["source"], "appmeta")
        st, b = self.srv.api("GET", f"/api/saves/installed-version?titleId={UNINSTALL_TITLE}")
        self.assertEqual(b["version"], "01.000.000")
        self.assertEqual(b["source"], "app")
        st, b = self.srv.api("GET", "/api/saves/installed-version?titleId=bad")
        self.assertEqual(st, 400)

    def test_21_store_install_native_sim(self):
        st, b = self.srv.api("POST", "/api/saves/store/sv_match/install", {"user": PLAYER, "backupFirst": True, "wait": True})
        self.assertEqual(st, 200, b)
        job = b["job"]
        self.assertEqual(job["type"], "save-install")
        self.assertEqual(job["state"], "done", job)
        res = job["result"]
        self.assertEqual(res["sha256"], self.save_sha)
        self.assertEqual(res["tier"], "native")
        self.assertEqual(res["style"], "decrypted")
        self.assertTrue(res["preBackup"].endswith(".pre-restore.zip"))
        self.assertTrue(os.path.exists(res["preBackup"]))
        self.assertIn(os.path.join("xeno-store", "saves", "community", "Test Game"), res["zipPath"])
        tdir = os.path.join(self.home(PLAYER), "savedata_prospero", TITLE)
        with open(os.path.join(tdir, ".sim", "SAVEDATA00", "game.dat"), "rb") as f:
            self.assertTrue(f.read().startswith(b"COMMUNITY-SAVE-"))
        self.assertFalse(os.path.exists(os.path.join(tdir, ".sim", "SAVEDATA00", "sce_sys", "sealedkey")))   # never imported
        self.assertFalse(os.path.exists(os.path.join(tdir, ".sim", "SAVEDATA00", "xeno-save.json")))
        self.assertTrue(os.path.exists(os.path.join(tdir, "sdimg_SAVEDATA00")))
        with open(os.path.join(tdir, ".sim", "SAVEDATA00", "sce_sys", "param.sfo"), "rb") as f:
            fmt, raw = sfo_get(f.read(), "ACCOUNT_ID")
        acct = struct.unpack("<Q", raw[:8])[0]
        self.assertEqual(f"{acct:016x}" if acct else "0", res["accountId"])
        self.assertNotEqual(acct, 0x1122334455667788)   # the uploader's id never survives the import
        # download only
        st, b = self.srv.api("POST", "/api/saves/store/sv_newer/download", {"wait": True})
        self.assertEqual(st, 200, b)
        self.assertEqual(b["job"]["type"], "save-download")
        self.assertEqual(b["job"]["state"], "done", b)
        self.assertTrue(os.path.exists(b["job"]["result"]["zipPath"]))
        # sha mismatch → failed job, nothing left behind
        st, b = self.srv.api("POST", "/api/saves/store/sv_badhash/install", {"user": PLAYER, "wait": True})
        self.assertEqual(st, 200, b)
        self.assertEqual(b["job"]["state"], "failed")
        self.assertIn("sha256", b["job"]["error"])
        st, b = self.srv.api("POST", "/api/saves/store/nope/install", {"user": PLAYER})
        self.assertEqual(st, 404)

    def test_22_export_upload_submit(self):
        st, b = self.srv.api("POST", "/api/saves/export", {"user": PLAYER, "titleId": TITLE, "dirName": "SAVEDATA00"})
        self.assertEqual(st, 200, b)
        self.assertEqual(b["format"], "xeno-save-zip")
        self.assertTrue(b["shareable"])
        self.assertTrue(b["accountIdStripped"])
        self.assertEqual(b["tier"], "native")
        self.assertEqual(b["gameVersion"], "01.004.000")
        self.assertEqual(b["title"], "Test Game")
        zp = b["zipPath"]
        self.assertTrue(os.path.exists(zp))
        self.assertEqual(hashlib.sha256(read(zp)).hexdigest(), b["sha256"])
        self.assertEqual(b["size"], os.path.getsize(zp))
        man = b["manifest"]
        self.assertEqual(man["titleId"], TITLE)
        self.assertEqual(man["dirName"], "SAVEDATA00")
        self.assertTrue(man["accountIdStripped"])
        self.assertTrue(any(f["path"] == "game.dat" for f in man["files"]))
        with zipfile.ZipFile(zp) as z:
            names = set(z.namelist())
            self.assertIn("game.dat", names)
            self.assertIn("xeno-save.json", names)
            self.assertIn("sce_sys/param.sfo", names)
            self.assertNotIn("sce_sys/sealedkey", names)
            inner = json.loads(z.read("xeno-save.json"))
            self.assertEqual(inner["format"], "xeno-save-zip")
            self.assertTrue(inner["createdBy"].startswith("XENO STORE"))
            fmt, raw = sfo_get(z.read("sce_sys/param.sfo"), "ACCOUNT_ID")
            self.assertEqual(struct.unpack("<Q", raw[:8])[0], 0)
            entry = [f for f in man["files"] if f["path"] == "game.dat"][0]
            self.assertEqual(entry["sha256"], hashlib.sha256(z.read("game.dat")).hexdigest())
        # upload: custom endpoint (multipart), pixeldrain (PUT), catbox (multipart with reqtype)
        st, b = self.srv.api("POST", "/api/saves/upload", {"zipPath": zp, "host": "custom"})
        self.assertEqual(st, 200, b)
        self.assertTrue(b["url"].endswith("/files/uploaded.zip"))
        self.assertEqual(b["size"], os.path.getsize(zp))
        up = [u for u in Mock.state["uploads"] if u["path"].startswith("/upload")][-1]
        self.assertIn("multipart/form-data", up["ctype"])
        self.assertIn(b'name="file"', up["body"])
        self.assertIn(read(zp), up["body"])
        st, b = self.srv.api("POST", "/api/saves/upload", {"zipPath": zp, "host": "pixeldrain"})
        self.assertEqual(st, 200, b)
        self.assertEqual(b["url"], f"{self.base}/api/file/pd1234")
        up = [u for u in Mock.state["uploads"] if u["method"] == "PUT"][-1]
        self.assertEqual(up["body"], read(zp))
        st, b = self.srv.api("POST", "/api/saves/upload", {"zipPath": zp, "host": "catbox"})
        self.assertEqual(st, 200, b)
        self.assertTrue(b["url"].startswith("https://files.catbox.moe/"))
        up = [u for u in Mock.state["uploads"] if u["path"].startswith("/user/api.php")][-1]
        self.assertIn(b'name="reqtype"\r\n\r\nfileupload', up["body"])
        self.assertIn(b'name="fileToUpload"', up["body"])
        st, b = self.srv.api("POST", "/api/saves/upload", {"zipPath": "/etc/hostname", "host": "custom"})
        self.assertEqual(st, 403)
        # submit → GitHub issue hand-off by default
        meta = {"titleId": TITLE, "gameId": "test-game-ps5", "title": "Test Game", "name": "My run", "category": "chapter",
                "description": "Chapter 4", "gameVersion": "01.004.000", "region": "EUR", "dirName": "SAVEDATA00",
                "url": b.get("url", f"{self.base}/files/uploaded.zip"), "sha256": "ab" * 32, "size": 123, "tags": ["ng+"]}
        st, b = self.srv.api("POST", "/api/saves/submit", meta)
        self.assertEqual(st, 200, b)
        self.assertEqual(b["method"], "github")
        self.assertTrue(b["issueUrl"].startswith("https://github.com/XENOKING123/XENOKING/issues/new?template=save-submission.md"))
        self.assertEqual(b["qr"], b["issueUrl"])
        self.assertEqual(b["submission"]["titleId"], TITLE)
        self.assertEqual(b["submission"]["author"], "tester")   # nickname from settings
        self.assertEqual(b["submission"]["category"], "chapter")
        self.assertIn("PPSA01234", b["issueUrl"])
        st, b = self.srv.api("POST", "/api/saves/submit", dict(meta, titleId=PS4_TITLE))
        self.assertEqual(st, 400)
        st, b = self.srv.api("POST", "/api/saves/submit", dict(meta, description="x" * 301))
        self.assertEqual(st, 400)
        # custom submit endpoint
        self.srv.api("PUT", "/api/settings", {"saves": {"submitEndpoint": f"{self.base}/submit"}})
        st, b = self.srv.api("POST", "/api/saves/submit", meta)
        self.assertEqual(b["method"], "custom")
        sub = [u for u in Mock.state["uploads"] if u["path"].startswith("/submit")][-1]
        self.assertEqual(json.loads(sub["body"])["titleId"], TITLE)
        self.srv.api("PUT", "/api/settings", {"saves": {"submitEndpoint": ""}})

    # ---- companion payloads ---------------------------------------------------
    def test_30_companions(self):
        st, b = self.srv.api("GET", "/api/payloads")
        self.assertEqual(st, 200, b)
        ids = {p["id"]: p for p in b["payloads"]}
        self.assertIn("shadowmountplus", ids)
        self.assertFalse(ids["shadowmountplus"]["installed"])
        self.assertEqual(b["loaderPort"], self.loader.port)
        self.assertTrue(b["loaderAvailable"])
        st, b = self.srv.api("POST", "/api/payloads/shadowmountplus/launch", {})
        self.assertEqual(st, 404)   # not installed yet
        st, b = self.srv.api("POST", "/api/payloads/shadowmountplus/install", {})
        self.assertEqual(st, 200, b)
        jid = b["job"]["id"]
        self.assertEqual(b["job"]["type"], "payload-install")
        deadline = time.time() + 30
        while time.time() < deadline:
            st, j = self.srv.api("GET", f"/api/saves/jobs/{jid}")
            if j["job"]["state"] in ("done", "failed"):
                break
            time.sleep(0.1)
        self.assertEqual(j["job"]["state"], "done", j)
        self.assertEqual(j["job"]["result"]["sha256"], self.elf_sha)
        self.assertTrue(j["job"]["result"]["verified"])
        local = os.path.join(self.data, "payloads", "shadowmountplus.elf")
        self.assertEqual(read(local), self.elf)
        st, b = self.srv.api("GET", "/api/payloads")
        p = [x for x in b["payloads"] if x["id"] == "shadowmountplus"][0]
        self.assertTrue(p["installed"])
        self.assertEqual(p["installedVersion"], "1.2")
        self.assertEqual(p["localPath"], local)
        # launch → bytes arrive at the loader
        before = len(self.loader.received)
        st, b = self.srv.api("POST", "/api/payloads/shadowmountplus/launch", {})
        self.assertEqual(st, 200, b)
        self.assertEqual(b["bytes"], len(self.elf))
        self.assertEqual(b["port"], self.loader.port)
        deadline = time.time() + 5
        while len(self.loader.received) <= before and time.time() < deadline:
            time.sleep(0.05)
        self.assertEqual(self.loader.received[-1], self.elf)
        # sha mismatch and non-ELF downloads fail cleanly
        for pid, needle in (("badhash", "sha256"), ("notelf", "not an ELF"), ("webpage", "web page")):
            st, b = self.srv.api("POST", f"/api/payloads/{pid}/install", {})
            self.assertEqual(st, 200, b)
            jid = b["job"]["id"]
            deadline = time.time() + 30
            while time.time() < deadline:
                st, j = self.srv.api("GET", f"/api/saves/jobs/{jid}")
                if j["job"]["state"] in ("done", "failed"):
                    break
                time.sleep(0.1)
            self.assertEqual(j["job"]["state"], "failed", j)
            self.assertIn(needle, j["job"]["error"])
            self.assertFalse(os.path.exists(os.path.join(self.data, "payloads", f"{pid}.elf")))
        st, b = self.srv.api("POST", "/api/payloads/../../etc/install", {})
        self.assertNotEqual(st, 200)
        st, b = self.srv.api("POST", "/api/payloads/unknown/install", {})
        self.assertEqual(st, 404)

    # ---- ghost icon cleaner ------------------------------------------------------
    def test_40_homebrew_dirs(self):
        st, b = self.srv.api("GET", "/api/homebrew-dirs")
        self.assertEqual(st, 200, b)
        dirs = {d["name"]: d for d in b["dirs"]}
        self.assertIn("OTHER-APP", dirs)
        self.assertTrue(dirs["OTHER-APP"]["hasEboot"] and dirs["OTHER-APP"]["hasIcon"])
        self.assertEqual(dirs["OTHER-APP"]["title"], "Other App")
        self.assertFalse(dirs["OTHER-APP"]["isXenoStore"])
        self.assertIn("GHOST", dirs)
        self.assertFalse(dirs["GHOST"]["hasEboot"])
        st, b = self.srv.api("POST", "/api/homebrew-dirs/delete", {"name": "GHOST"})
        self.assertEqual(st, 428)
        st, b = self.srv.api("POST", "/api/homebrew-dirs/delete", {"name": "NOT-LISTED", "confirm": "NOT-LISTED"})
        self.assertEqual(st, 403)
        st, b = self.srv.api("POST", "/api/homebrew-dirs/delete", {"name": "../sim", "confirm": "../sim"})
        self.assertEqual(st, 400)
        st, b = self.srv.api("POST", "/api/homebrew-dirs/delete", {"name": "GHOST", "confirm": "GHOST"})
        self.assertEqual(st, 200, b)
        self.assertFalse(os.path.exists(os.path.join(self.sim, "data", "homebrew", "GHOST")))
        self.assertTrue(os.path.exists(os.path.join(self.sim, "data", "homebrew", "OTHER-APP", "eboot.bin")))

    # ---- homebrew store --------------------------------------------------------
    def test_50_homebrew_listing(self):
        st, b = self.srv.api("GET", "/api/homebrew?refresh=1")
        self.assertEqual(st, 200, b)
        self.assertTrue(b["live"])
        items = {i["id"]: i for i in b["items"]}
        self.assertIn("retroarch_ps5", items)
        self.assertIn("ftp_server_42", items)
        self.assertNotIn("ignored_one", items)   # article without the pkg class
        ra = items["retroarch_ps5"]
        self.assertEqual(ra["title"], "RetroArch (PS5)")
        self.assertEqual(ra["version"], "1.19.1")
        self.assertEqual(ra["author"], "Libretro Team")
        self.assertTrue(ra["supportsPs5"])
        self.assertEqual(ra["cover"], f"{self.base}/images/retroarch_ps5/cover.png")
        self.assertEqual(ra["details"], f"{self.base}/details/retroarch_ps5")
        self.assertEqual(ra["downloadPs5"], f"{self.base}/download/ps5/retroarch_ps5/latest")
        self.assertEqual(ra["downloadPs4"], f"{self.base}/download/ps4/retroarch_ps5/latest")
        self.assertEqual(ra["category"], "Emulator")
        self.assertFalse(ra["installed"])
        ftp = items["ftp_server_42"]
        self.assertEqual(ftp["title"], "Simple FTP & Tools")   # entity decoded
        self.assertFalse(ftp["supportsPs5"])
        self.assertEqual(ftp["downloadPs5"], "")
        self.assertEqual(ftp["category"], "Tool")
        self.assertTrue(os.path.exists(os.path.join(self.data, "homebrew.json")))
        pages = [p for m, p in Mock.state["requests"] if p.startswith("/?page=")]
        self.assertEqual(pages[-2:], ["/?page=1", "/?page=2"])   # stops at the first empty page
        st, b = self.srv.api("GET", "/api/homebrew")
        self.assertTrue(b["cached"])
        st, b = self.srv.api("GET", "/api/homebrew?q=retro")
        self.assertEqual([i["id"] for i in b["items"]], ["retroarch_ps5"])
        st, b = self.srv.api("GET", "/api/homebrew?category=Tool")
        self.assertEqual([i["id"] for i in b["items"]], ["ftp_server_42"])
        # installed state recorded by the install flow
        st, b = self.srv.api("POST", "/api/homebrew/retroarch_ps5/installed", {"titleId": TITLE, "version": "1.18.0"})
        self.assertEqual(st, 200, b)
        st, b = self.srv.api("GET", "/api/homebrew?q=retro")
        self.assertTrue(b["items"][0]["installed"])
        self.assertEqual(b["items"][0]["installedVersion"], "1.18.0")
        self.assertTrue(b["items"][0]["updateAvailable"])
        st, b = self.srv.api("POST", "/api/homebrew/bad%2Fid/installed", {"titleId": "x"})
        self.assertNotEqual(st, 200)

    def test_51_image_proxy(self):
        st, hdrs, raw = self.srv.raw("GET", f"/api/image?url={self.base}/cover.png")
        self.assertEqual(st, 200)
        self.assertEqual(hdrs.get("Content-Type"), "image/png")
        self.assertEqual(raw, PNG_BYTES)
        st, b = self.srv.api("GET", "/api/image?url=https://evil.example/cover.png")
        self.assertEqual(st, 403)
        self.assertEqual(b["error"], "forbidden")
        st, b = self.srv.api("GET", f"/api/image?url={self.base}/page.html")
        self.assertEqual(st, 415)
        st, b = self.srv.api("GET", "/api/image?url=ftp://pkg-zone.com/x.png")
        self.assertEqual(st, 400)

    # ---- enrichment ------------------------------------------------------------
    def test_60_enrich_cache_and_fail_soft(self):
        st, b = self.srv.api("GET", "/api/game/enrich?id=test-game-ps5")
        self.assertEqual(st, 200, b)
        self.assertFalse(b["cached"])
        self.assertEqual(b["screenshots"], [f"{self.base}/s1.jpg", f"{self.base}/s2.jpg"])
        self.assertEqual(b["developer"], "Dev Studio")
        self.assertEqual(b["publisher"], "Pub Co")
        self.assertEqual(b["metacritic"], 86)
        self.assertIn("Single-player", b["features"])
        self.assertEqual(b["languages"], ["English", "French", "German"])
        self.assertEqual(b["ageRating"], 18)
        self.assertEqual(b["steamId"], 1091500)
        self.assertIn("great game", b["about"])
        self.assertNotIn("<strong>", b["about"])
        self.assertEqual(b["source"], "steam")
        cache = os.path.join(self.data, "enrich", "test-game-ps5.json")
        self.assertTrue(os.path.exists(cache))
        st, b = self.srv.api("GET", "/api/game/enrich?id=test-game-ps5")
        self.assertTrue(b["cached"])
        self.assertEqual(b["metacritic"], 86)
        # no Steam match → fail soft with the catalog data
        st, b = self.srv.api("GET", "/api/game/enrich?id=other-game-ps4")
        self.assertEqual(st, 200, b)
        self.assertTrue(b["ok"])
        self.assertFalse(b["cached"])
        self.assertEqual(b["screenshots"], [])
        self.assertEqual(b["source"], "catalog")
        self.assertFalse(os.path.exists(os.path.join(self.data, "enrich", "other-game-ps4.json")))
        st, b = self.srv.api("GET", "/api/game/enrich?id=does-not-exist")
        self.assertEqual(st, 404)
        st, b = self.srv.api("GET", "/api/game/enrich?id=../../x")
        self.assertNotEqual(st, 200)
        # safe mode never touches the network but still answers
        self.srv.api("PUT", "/api/settings", {"general": {"safeMode": True}})
        n = len(Mock.state["requests"])
        st, b = self.srv.api("GET", "/api/game/enrich?id=uninstall-me-ps5")
        self.assertEqual(st, 200)
        self.assertTrue(b["offline"])
        self.assertEqual(len(Mock.state["requests"]), n)
        self.srv.api("PUT", "/api/settings", {"general": {"safeMode": False}})

    # ---- library extras ----------------------------------------------------------
    def test_70_library_usage_and_clean(self):
        write(os.path.join(self.root, "homebrew", "PPSA01234 dump.exfat"), b"d" * (1 << 20))
        write(os.path.join(self.root, "xeno-store", "pkg", "game.pkg"), b"p" * 4096)
        write(os.path.join(self.root, "xeno-store", "files", "old.zip.xpart"), b"x" * 8192)
        write(os.path.join(self.root, "xeno-store", "files", "old.zip.xpart.json"), b"{}")
        st, b = self.srv.api("GET", "/api/library/usage")
        self.assertEqual(st, 200, b)
        r = [x for x in b["roots"] if x["path"] == self.root][0]
        self.assertGreaterEqual(r["categories"]["dumps"], 1 << 20)
        self.assertGreaterEqual(r["categories"]["packages"], 4096)
        self.assertGreaterEqual(r["categories"]["partials"], 8192)
        self.assertGreater(r["categories"]["saves"], 0)
        self.assertTrue(any(p["path"].endswith("old.zip.xpart") for p in r["partials"]))
        self.assertTrue(r["default"])
        st, b = self.srv.api("POST", "/api/library/usage/clean", {})
        self.assertEqual(st, 200, b)
        self.assertEqual(b["removedCount"], 1)
        self.assertGreaterEqual(b["freed"], 8192)
        self.assertFalse(os.path.exists(os.path.join(self.root, "xeno-store", "files", "old.zip.xpart")))
        self.assertFalse(os.path.exists(os.path.join(self.root, "xeno-store", "files", "old.zip.xpart.json")))
        self.assertTrue(os.path.exists(os.path.join(self.root, "xeno-store", "pkg", "game.pkg")))
        st, b = self.srv.api("POST", "/api/library/usage/clean", {"root": "/nope"})
        self.assertEqual(st, 422)

    def test_71_library_launch_and_uninstall(self):
        st, b = self.srv.api("POST", "/api/library/launch", {"titleId": TITLE})
        self.assertEqual(st, 200, b)
        self.assertTrue(b["launched"] and b["simulated"])
        self.assertEqual(b["title"], "Test Game")
        with open(os.path.join(self.sim, "launched.json")) as f:
            self.assertEqual(json.load(f)["titleId"], TITLE)
        st, b = self.srv.api("POST", "/api/library/launch", {"titleId": "PPSA00000"})
        self.assertEqual(st, 404)
        st, b = self.srv.api("POST", "/api/library/launch", {"titleId": "nope"})
        self.assertEqual(st, 400)
        # double confirm
        st, b = self.srv.api("POST", "/api/library/uninstall", {"titleId": UNINSTALL_TITLE})
        self.assertEqual(st, 200, b)
        self.assertTrue(b["confirmRequired"])
        token = b["token"]
        self.assertTrue(os.path.exists(os.path.join(self.data, "user", "app", UNINSTALL_TITLE)))
        st, b = self.srv.api("POST", "/api/library/uninstall", {"titleId": UNINSTALL_TITLE, "token": "wrong"})
        self.assertTrue(b["confirmRequired"])
        self.assertTrue(os.path.exists(os.path.join(self.data, "user", "app", UNINSTALL_TITLE)))
        st, b = self.srv.api("POST", "/api/library/uninstall", {"titleId": TITLE, "token": token})   # token bound to the title
        self.assertTrue(b["confirmRequired"])
        st, b = self.srv.api("POST", "/api/library/uninstall", {"titleId": UNINSTALL_TITLE, "token": token})
        self.assertEqual(st, 200, b)
        self.assertTrue(b["uninstalled"])
        self.assertFalse(os.path.exists(os.path.join(self.data, "user", "app", UNINSTALL_TITLE)))
        self.assertTrue(os.path.exists(os.path.join(self.data, "user", "app", TITLE)))

    # ---- mDNS ---------------------------------------------------------------------
    def test_80_mdns_packet_builder(self):
        st, b = self.srv.api("GET", "/api/mdns")
        self.assertEqual(b["mdns"]["names"], ["xeno.local", "xenostore.local"])
        self.assertTrue(b["mdns"]["enabled"])
        self.assertEqual(b["mdns"]["port"], 5353)
        self.assertTrue(b["mdns"]["url"].startswith("http://xeno.local:"))
        q = dns_query("XENO.local")   # names are matched case-insensitively
        st, b = self.srv.api("POST", "/api/mdns/build", {"query": base64.b64encode(q).decode(), "ip": "192.168.1.20"})
        self.assertEqual(st, 200, b)
        ans = base64.b64decode(b["answer"])
        self.assertEqual(len(ans), b["length"])
        self.assertFalse(b["unicast"])
        qid, flags, qd, an, ns, ar = struct.unpack(">HHHHHH", ans[:12])
        self.assertEqual(qid, 0)              # multicast replies carry id 0
        self.assertEqual(flags, 0x8400)       # response + authoritative
        self.assertEqual((qd, an, ns, ar), (0, 1, 0, 0))
        name, pos = dns_read_name(ans, 12)
        self.assertEqual(name, "xeno.local")
        rtype, rclass, ttl, rdlen = struct.unpack(">HHIH", ans[pos:pos + 10])
        self.assertEqual((rtype, rclass, ttl, rdlen), (1, 0x8001, 120, 4))
        self.assertEqual(ans[pos + 10:pos + 14], bytes([192, 168, 1, 20]))
        self.assertEqual(len(ans), pos + 14)
        # exact bytes for the canonical query
        expected = struct.pack(">HHHHHH", 0, 0x8400, 0, 1, 0, 0) + b"\x04xeno\x05local\x00" + struct.pack(">HHIH", 1, 0x8001, 120, 4) + bytes([192, 168, 1, 20])
        self.assertEqual(ans, expected)
        # QU (unicast-response) bit → unicast reply keeping the id
        q = dns_query("xenostore.local", qclass=0x8001, qid=0xBEEF)
        st, b = self.srv.api("POST", "/api/mdns/build", {"query": base64.b64encode(q).decode(), "ip": "10.0.0.7"})
        ans = base64.b64decode(b["answer"])
        self.assertTrue(b["unicast"])
        self.assertEqual(struct.unpack(">H", ans[:2])[0], 0xBEEF)
        name, pos = dns_read_name(ans, 12)
        self.assertEqual(name, "xenostore.local")
        self.assertEqual(ans[-4:], bytes([10, 0, 0, 7]))
        # other names, AAAA questions and responses are ignored
        for pkt in (dns_query("printer.local"), dns_query("xeno.local", qtype=28), bytes([0, 1, 0x84, 0]) + b"\0" * 8, b"\x12"):
            st, b = self.srv.api("POST", "/api/mdns/build", {"query": base64.b64encode(pkt).decode()})
            self.assertEqual(b["length"], 0, pkt)
        # announcement lists both names
        st, b = self.srv.api("POST", "/api/mdns/build", {"query": "", "announce": True, "ip": "192.168.1.20"})
        ans = base64.b64decode(b["answer"])
        self.assertEqual(struct.unpack(">H", ans[6:8])[0], 2)
        n1, pos = dns_read_name(ans, 12)
        n2, _ = dns_read_name(ans, pos + 14)
        self.assertEqual((n1, n2), ("xeno.local", "xenostore.local"))
        # live responder (best-effort: only when the host build could bind :5353)
        st, b = self.srv.api("GET", "/api/mdns")
        if b["mdns"]["running"]:
            s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            s.settimeout(2)
            s.sendto(dns_query("xeno.local"), ("127.0.0.1", 5353))
            try:
                data, _ = s.recvfrom(512)
                self.assertEqual(struct.unpack(">H", data[2:4])[0], 0x8400)
                self.assertEqual(dns_read_name(data, 12)[0], "xeno.local")
            except socket.timeout:
                pass   # another responder on the machine may own the port
            s.close()
        # opt-out stops the responder
        self.srv.api("PUT", "/api/settings", {"general": {"mdns": False}})
        deadline = time.time() + 5
        while time.time() < deadline:
            st, b = self.srv.api("GET", "/api/mdns")
            if not b["mdns"]["running"]:
                break
            time.sleep(0.2)
        self.assertFalse(b["mdns"]["running"])
        self.srv.api("PUT", "/api/settings", {"general": {"mdns": True}})


class UninstallTests(unittest.TestCase):
    """Separate instance: the endpoint stops the server."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="xeno-uninstall-")
        self.data = os.path.join(self.tmp, "data")
        self.sim = os.path.join(self.data, "sim")
        self.decoy = os.path.join(self.tmp, "decoy")
        write(os.path.join(self.decoy, "keep.txt"), b"keep")
        write(os.path.join(self.sim, "data", "homebrew", "XENO-STORE", "eboot.bin"), b"\x7fELF")
        write(os.path.join(self.sim, "data", "homebrew", "OTHER-APP", "eboot.bin"), b"\x7fELF")
        self.srv = harness.XenoServer(self.data).start()
        self.root = self.srv.default_root
        write(os.path.join(self.root, "xeno-store", "pkg", "a.pkg"), b"p" * 100)
        write(os.path.join(self.root, "xeno-store", "files", "b.zip"), b"z" * 100)
        write(os.path.join(self.root, "xeno-store", "saves", "Player", "PPSA01234_ps5_20260101-0000.zip"), b"s" * 100)
        write(os.path.join(self.root, "homebrew", "user-dump.exfat"), b"u" * 100)
        write(os.path.join(self.root, "homebrew", "queued-dump.exfat"), b"q" * 100)
        with open(os.path.join(self.data, "payload-manager.json"), "w") as f:
            json.dump({"path": os.path.join(self.decoy, "keep.txt")}, f)   # not an .elf → never deleted

    def tearDown(self):
        self.srv.stop()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_uninstall_exact_paths_only(self):
        st, b = self.srv.api("POST", "/api/uninstall", {})
        self.assertEqual(st, 400)
        body = {"data": False, "homebrew": True, "payloadManager": True, "downloads": True,
                "paths": [self.decoy, "/"], "root": self.decoy, "path": self.decoy}
        st, b = self.srv.api("POST", "/api/uninstall", body)
        self.assertEqual(st, 200, b)
        self.assertTrue(b["stopping"])
        removed = set(b["removed"])
        self.assertIn(os.path.join(self.sim, "data", "homebrew", "XENO-STORE"), removed)
        self.assertIn(os.path.join(self.root, "xeno-store", "pkg"), removed)
        self.assertIn(os.path.join(self.root, "xeno-store", "files"), removed)
        for p in removed:
            self.assertTrue(p.startswith(self.data) or p.startswith(self.root), p)
        kept = set(b["kept"])
        self.assertIn(self.data, kept)
        self.assertIn(os.path.join(self.root, "xeno-store", "saves"), kept)
        self.assertEqual(b["failed"], [])
        # exact paths only: neighbours, user dumps, saves and client-supplied paths survive
        self.assertTrue(os.path.exists(os.path.join(self.sim, "data", "homebrew", "OTHER-APP", "eboot.bin")))
        self.assertFalse(os.path.exists(os.path.join(self.sim, "data", "homebrew", "XENO-STORE")))
        self.assertTrue(os.path.exists(os.path.join(self.root, "homebrew", "user-dump.exfat")))
        self.assertTrue(os.path.exists(os.path.join(self.root, "xeno-store", "saves", "Player", "PPSA01234_ps5_20260101-0000.zip")))
        self.assertTrue(os.path.exists(os.path.join(self.decoy, "keep.txt")))
        self.assertTrue(os.path.exists(os.path.join(self.data, "settings.json")))
        self.assertFalse(os.path.exists(os.path.join(self.root, "xeno-store", "pkg")))
        deadline = time.time() + 10
        while time.time() < deadline and self.srv.proc.poll() is None:
            time.sleep(0.1)
        self.assertIsNotNone(self.srv.proc.poll(), "server should stop after uninstall")

    def test_uninstall_data_dir(self):
        st, b = self.srv.api("POST", "/api/uninstall", {"data": True})
        self.assertEqual(st, 200, b)
        self.assertIn(self.data, b["removed"])
        self.assertFalse(os.path.exists(os.path.join(self.data, "settings.json")))
        self.assertTrue(os.path.exists(os.path.join(self.root, "xeno-store", "pkg", "a.pkg")))   # downloads kept
        self.assertTrue(os.path.exists(os.path.join(self.sim, "data", "homebrew", "XENO-STORE", "eboot.bin")) or not os.path.exists(self.sim))
        deadline = time.time() + 10
        while time.time() < deadline and self.srv.proc.poll() is None:
            time.sleep(0.1)
        self.assertIsNotNone(self.srv.proc.poll())


if __name__ == "__main__":
    unittest.main(verbosity=2)
