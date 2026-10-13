"""Save Data Store intake (SPEC §17.22.5): body parsing, validation, capped download, zip inspection, index updates."""
from __future__ import annotations

import hashlib
import io
import json
import os
import shutil
import sys
import tempfile
import threading
import unittest
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
FIX = os.path.join(HERE, "fixtures")
sys.path.insert(0, os.path.dirname(HERE))

import intake  # noqa: E402


def read(name: str, mode: str = "rb"):
    with open(os.path.join(FIX, name), mode, **({} if "b" in mode else {"encoding": "utf-8"})) as f:
        return f.read()


GOOD = read("good-save.zip")
GOOD_SHA = hashlib.sha256(GOOD).hexdigest()
BODY = read("issue-good.md", "r")
EVENT = json.loads(read("event-opened.json", "r"))


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    files: dict[str, bytes] = {}

    def log_message(self, *a):
        pass

    def do_GET(self):
        path = self.path.split("?")[0]
        if path == "/redirect":
            self.send_response(302)
            self.send_header("Location", "/good.zip")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        if path == "/html":
            body = b"<html><body>Please wait, checking your browser</body></html>"
            self.send_response(200)
            self.send_header("Content-Type", "text/html")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if path == "/nolength":
            self.send_response(200)
            self.send_header("Content-Type", "application/zip")
            self.send_header("Connection", "close")
            self.end_headers()
            self.wfile.write(GOOD)
            self.close_connection = True
            return
        data = self.files.get(path)
        if data is None:
            self.send_response(404)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        self.send_response(200)
        self.send_header("Content-Type", "application/zip")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


class ServerMixin:
    srv: ThreadingHTTPServer
    base: str

    @classmethod
    def setUpClass(cls):
        Handler.files = {"/good.zip": GOOD, "/big.zip": GOOD + b"\0" * 100000, "/empty.zip": b""}
        cls.srv = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        cls.base = "http://127.0.0.1:%d" % cls.srv.server_address[1]
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()
        cls.srv.server_close()


class Args:
    """argparse namespace stand-in for intake.run()."""

    def __init__(self, **kw):
        defaults = dict(event=None, issue_json=None, body=None, number=0, title="", labels="", created_at="", index="", file=None,
                        download_dir=None, keep=False, no_download=False, max_bytes=intake.MAX_BYTES, dry_run=False, out=None,
                        now="2026-01-02T12:00:00Z", strict=False)
        defaults.update(kw)
        self.__dict__.update(defaults)


class ParseTests(unittest.TestCase):
    def test_fenced_block(self):
        d = intake.parse_issue_body(BODY)
        self.assertEqual(d["titleId"], "PPSA04029")
        self.assertEqual(d["sha256"], GOOD_SHA)

    def test_crlf_and_language_variants(self):
        body = "intro\r\n```JSON\r\n{\"titleId\": \"PPSA00001\"}\r\n```\r\n"
        self.assertEqual(intake.parse_issue_body(body)["titleId"], "PPSA00001")
        body = "```\n{\"titleId\": \"PPSA00002\"}\n```"
        self.assertEqual(intake.parse_issue_body(body)["titleId"], "PPSA00002")

    def test_bare_json(self):
        self.assertEqual(intake.parse_issue_body('hello {"titleId":"PPSA00003"} bye')["titleId"], "PPSA00003")

    def test_first_valid_block_wins(self):
        body = "```json\nnot json\n```\n```json\n{\"a\":1}\n```"
        self.assertEqual(intake.parse_issue_body(body), {"a": 1})

    def test_errors(self):
        for body in ("", "   ", "no block here", "```json\n[1,2]\n```"):
            with self.assertRaises(ValueError):
                intake.parse_issue_body(body)


class ValidateTests(unittest.TestCase):
    def good(self):
        return json.loads(intake.FENCE_RE.search(BODY).group(1))

    def test_good(self):
        sub, errors, warnings = intake.normalize_submission(self.good())
        self.assertEqual(errors, [])
        self.assertEqual(warnings, [])
        self.assertEqual(sub["category"], "chapter")
        self.assertEqual(sub["tags"], ["ng+", "max money"])
        self.assertEqual(sub["format"], "xeno-save-zip")

    def test_title_id(self):
        for bad in ("CUSA12345", "ppsa1234", "", "PPSA123456", 12345):
            raw = self.good()
            raw["titleId"] = bad
            _, errors, _ = intake.normalize_submission(raw)
            self.assertTrue(any("titleId" in e for e in errors), bad)
        raw = self.good()
        raw["titleId"] = " ppsa04029 "
        sub, errors, _ = intake.normalize_submission(raw)
        self.assertEqual(errors, [])
        self.assertEqual(sub["titleId"], "PPSA04029")

    def test_sizes_and_hash(self):
        raw = self.good()
        raw["size"] = intake.MAX_BYTES + 1
        _, errors, _ = intake.normalize_submission(raw)
        self.assertIn("size must be 2 GiB or less", errors)
        raw = self.good()
        raw["size"] = "abc"
        _, errors, _ = intake.normalize_submission(raw)
        self.assertTrue(any("size" in e for e in errors))
        raw = self.good()
        raw["sha256"] = "XYZ"
        _, errors, _ = intake.normalize_submission(raw)
        self.assertTrue(any("sha256" in e for e in errors))
        raw = self.good()
        raw["sha256"] = GOOD_SHA.upper()
        sub, errors, _ = intake.normalize_submission(raw)
        self.assertEqual(errors, [])
        self.assertEqual(sub["sha256"], GOOD_SHA)

    def test_urls(self):
        self.assertEqual(intake.check_url("https://pixeldrain.com/api/file/abc"), "")
        self.assertEqual(intake.check_url("https://files.catbox.moe/abc.zip"), "")
        for bad in ("", "http://pixeldrain.com/x", "https://user:pw@host/x", "https://localhost/x", "https://127.0.0.1/x",
                    "https://192.168.1.5/x", "https://10.0.0.1/x", "ftp://x/y", "https://host/a b", "https://host/<x>"):
            self.assertNotEqual(intake.check_url(bad), "", bad)

    def test_text_cleanup_and_limits(self):
        raw = self.good()
        raw["author"] = "@ nick\x00\x01  "
        raw["description"] = "x" * 301
        raw["category"] = "weird"
        raw["name"] = "  Max\tstart  "
        raw["tags"] = ["NG+", "ng+", "x" * 40, "ok tag", "", 5, "bad\nline"] + ["t%d" % i for i in range(20)]
        sub, errors, warnings = intake.normalize_submission(raw)
        self.assertEqual(sub["author"], "nick")
        self.assertIn("description must be 300 characters or less (it has 301)", errors)
        self.assertTrue(any("category" in w for w in warnings))
        self.assertEqual(sub["category"], "starter")  # inferred from "Max start"
        self.assertEqual(sub["name"], "Max start")
        self.assertEqual(sub["tags"][:2], ["ng+", "ok tag"])
        self.assertLessEqual(len(sub["tags"]), 10)

    def test_raw_and_ps4_rejected(self):
        raw = self.good()
        raw["format"] = "xeno-raw-zip"
        _, errors, _ = intake.normalize_submission(raw)
        self.assertTrue(any("format" in e for e in errors))
        raw = self.good()
        raw["kind"] = "ps4"
        _, errors, _ = intake.normalize_submission(raw)
        self.assertIn("kind must be ps5", errors)

    def test_version_region_dirname(self):
        raw = self.good()
        raw["gameVersion"] = "v1.04"
        raw["region"] = "eu!"
        raw["dirName"] = "../x"
        _, errors, _ = intake.normalize_submission(raw)
        self.assertTrue(any("gameVersion" in e for e in errors))
        self.assertTrue(any("region" in e for e in errors))
        self.assertTrue(any("dirName" in e for e in errors))
        raw = self.good()
        raw["gameVersion"] = ""
        raw["region"] = "usa"
        raw["dirName"] = ""
        sub, errors, warnings = intake.normalize_submission(raw)
        self.assertEqual(errors, [])
        self.assertEqual(sub["region"], "USA")
        self.assertTrue(any("dirName" in w for w in warnings))

    def test_infer_category(self):
        self.assertEqual(intake.infer_category("100% platinum run"), "platinum")
        self.assertEqual(intake.infer_category("NG+ max money"), "starter")
        self.assertEqual(intake.infer_category("before final boss"), "checkpoint")
        self.assertEqual(intake.infer_category("modded stats"), "modded")
        self.assertEqual(intake.infer_category("chapter 7"), "chapter")
        self.assertEqual(intake.infer_category("hello"), "other")


class ZipTests(unittest.TestCase):
    def test_good_xeno(self):
        r = intake.inspect_zip(os.path.join(FIX, "good-save.zip"), "PPSA04029")
        self.assertTrue(r["ok"], r["reasons"])
        self.assertEqual(r["layout"], "xeno")
        self.assertEqual(r["dirName"], "SAVEDATA00")
        self.assertEqual(r["gameVersion"], "01.004.000")
        self.assertTrue(r["hasIcon"] and r["hasParamSfo"])
        self.assertEqual(r["dataFiles"], 1)

    def test_title_mismatch(self):
        r = intake.inspect_zip(os.path.join(FIX, "good-save.zip"), "PPSA00001")
        self.assertFalse(r["ok"])
        self.assertTrue(any("PPSA04029, not PPSA00001" in x for x in r["reasons"]))

    def test_garlic_layout_in_folder(self):
        r = intake.inspect_zip(os.path.join(FIX, "garlic-save.zip"), "PPSA04029")
        self.assertTrue(r["ok"], r["reasons"])
        self.assertEqual(r["layout"], "garlic")
        self.assertEqual(r["dataFiles"], 1)

    def test_sealed_key(self):
        r = intake.inspect_zip(os.path.join(FIX, "sealed-save.zip"), "PPSA04029")
        self.assertFalse(r["ok"])
        self.assertTrue(any("sealed key" in x for x in r["reasons"]))

    def test_raw_backup(self):
        r = intake.inspect_zip(os.path.join(FIX, "raw-backup.zip"), "PPSA04029")
        self.assertFalse(r["ok"])
        joined = " ".join(r["reasons"])
        self.assertIn("raw (sealed) save image", joined)
        self.assertIn("sealed key", joined)
        self.assertIn("raw console backup", joined)

    def _zip(self, entries, manifest=None):
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w") as z:
            for n, d in entries:
                z.writestr(n, d)
            if manifest is not None:
                z.writestr("xeno-save.json", json.dumps(manifest))
        d = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, d, True)
        p = os.path.join(d, "t.zip")
        with open(p, "wb") as f:
            f.write(buf.getvalue())
        return p

    def test_paths(self):
        r = intake.inspect_zip(self._zip([("/abs.bin", b"x"), ("../up.bin", b"x"), ("ok.bin", b"x")]))
        self.assertTrue(any("absolute path" in x for x in r["reasons"]))
        self.assertTrue(any("parent-directory" in x for x in r["reasons"]))

    def test_only_sce_sys(self):
        r = intake.inspect_zip(self._zip([("sce_sys/param.sfo", b"x")]))
        self.assertFalse(r["ok"])
        self.assertEqual(r["layout"], "none")

    def test_manifest_rules(self):
        base = [("data.bin", b"abc")]
        r = intake.inspect_zip(self._zip(base, {"titleId": "PPSA00001", "sameConsoleOnly": True}), "PPSA00001")
        self.assertTrue(any("same-console" in x for x in r["reasons"]))
        r = intake.inspect_zip(self._zip(base, {"titleId": "PPSA00001", "accountIdStripped": False}), "PPSA00001")
        self.assertTrue(any("account id" in x for x in r["reasons"]))
        r = intake.inspect_zip(self._zip(base, {"titleId": "PPSA00001", "format": "xeno-raw-zip"}), "PPSA00001")
        self.assertTrue(any("xeno-raw-zip" in x for x in r["reasons"]))
        r = intake.inspect_zip(self._zip(base, {"titleId": "PPSA00001", "files": [{"path": "missing.bin", "size": 1}, {"path": "data.bin", "size": 99}]}), "PPSA00001")
        self.assertTrue(any("missing.bin" in x for x in r["reasons"]))
        self.assertTrue(any("size of data.bin" in x for x in r["reasons"]))
        p = self._zip(base)
        with zipfile.ZipFile(p, "a") as z:
            z.writestr("xeno-save.json", "{not json")
        r = intake.inspect_zip(p)
        self.assertTrue(any("not valid JSON" in x for x in r["reasons"]))

    def test_not_a_zip(self):
        d = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, d, True)
        p = os.path.join(d, "x.zip")
        with open(p, "wb") as f:
            f.write(b"hello" * 100)
        r = intake.inspect_zip(p)
        self.assertFalse(r["ok"])
        self.assertIn("not a zip", r["reasons"][0])


class DownloadTests(ServerMixin, unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.dir, True)
        self.dest = os.path.join(self.dir, "d.zip")

    def test_ok(self):
        size, sha = intake.download(self.base + "/good.zip", self.dest, len(GOOD))
        self.assertEqual((size, sha), (len(GOOD), GOOD_SHA))

    def test_redirect_and_no_length(self):
        size, sha = intake.download(self.base + "/redirect", self.dest, len(GOOD))
        self.assertEqual(sha, GOOD_SHA)
        size, sha = intake.download(self.base + "/nolength", self.dest, len(GOOD))
        self.assertEqual(sha, GOOD_SHA)

    def test_declared_size_cap(self):
        with self.assertRaises(ValueError) as cm:
            intake.download(self.base + "/big.zip", self.dest, len(GOOD))
        self.assertIn("submission says", str(cm.exception))

    def test_stream_cap_without_length(self):
        with self.assertRaises(ValueError) as cm:
            intake.download(self.base + "/nolength", self.dest, 100)
        self.assertIn("larger than the submitted size", str(cm.exception))

    def test_html_page(self):
        with self.assertRaises(ValueError) as cm:
            intake.download(self.base + "/html", self.dest, 1000)
        self.assertIn("web page", str(cm.exception))

    def test_404_and_empty(self):
        with self.assertRaises(ValueError) as cm:
            intake.download(self.base + "/missing.zip", self.dest, 10)
        self.assertIn("HTTP 404", str(cm.exception))
        with self.assertRaises(ValueError) as cm:
            intake.download(self.base + "/empty.zip", self.dest, 10)
        self.assertIn("empty", str(cm.exception))

    def test_max_bytes_cap(self):
        with self.assertRaises(ValueError):
            intake.download(self.base + "/good.zip", self.dest, 0, max_bytes=100)


class IndexTests(unittest.TestCase):
    def test_validate_shipped_index(self):
        path = os.path.join(os.path.dirname(HERE), "..", "..", "updates", "saves.json")
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        self.assertEqual(intake.validate_index(data), [])
        self.assertTrue(all(s["status"] == "example" for s in data["saves"]))

    def test_validate_errors(self):
        self.assertTrue(intake.validate_index([]))
        bad = {"schemaVersion": 1, "updatedAt": "x", "saves": [{"id": "a", "status": "published", "titleId": "PPSA00001", "url": "http://x", "sha256": "0", "size": 0}, {"id": "a", "status": "nope", "titleId": "CUSA00001"}]}
        errs = intake.validate_index(bad)
        self.assertTrue(any("duplicated" in e for e in errs))
        self.assertTrue(any("https" in e for e in errs))
        self.assertTrue(any("status" in e for e in errs))
        self.assertTrue(any("PPSA" in e for e in errs))

    def test_upsert_keeps_examples_and_sorts(self):
        idx = {"schemaVersion": 1, "updatedAt": "t", "saves": [{"id": "ex", "status": "example", "titleId": "PPSA00001"}, {"id": "b", "issue": 9, "status": "pending", "titleId": "PPSA00001"}]}
        e = {"id": "a", "issue": 3, "status": "published", "titleId": "PPSA00001"}
        out, changed = intake.upsert(idx, e)
        self.assertTrue(changed)
        self.assertEqual([s["id"] for s in out["saves"]], ["ex", "a", "b"])
        out2, changed2 = intake.upsert(out, dict(e))
        self.assertFalse(changed2)
        self.assertEqual(intake.dump_index(out), intake.dump_index(out2))
        e2 = dict(e, status="rejected")
        out3, changed3 = intake.upsert(out, e2)
        self.assertTrue(changed3)
        self.assertEqual([s["id"] for s in out3["saves"]], ["ex", "a", "b"])
        self.assertEqual(out3["saves"][1]["status"], "rejected")

    def test_decide_status(self):
        self.assertEqual(intake.decide_status([], True), "pending")
        self.assertEqual(intake.decide_status(["approved"], True), "published")
        self.assertEqual(intake.decide_status(["Approved", "rejected"], True), "rejected")
        self.assertEqual(intake.decide_status(["approved"], False), "rejected")


class RunTests(ServerMixin, unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.dir, True)
        self.index = os.path.join(self.dir, "saves.json")
        self.event = os.path.join(self.dir, "event.json")
        shutil.copy(os.path.join(FIX, "event-opened.json"), self.event)

    def _event(self, **changes):
        ev = json.loads(read("event-opened.json", "r"))
        issue = ev["issue"]
        block = json.loads(intake.FENCE_RE.search(issue["body"]).group(1))
        if "block" in changes:
            block.update(changes.pop("block"))
            issue["body"] = "```json\n" + json.dumps(block) + "\n```"
        if "labels" in changes:
            issue["labels"] = [{"name": l} for l in changes.pop("labels")]
        issue.update(changes)
        with open(self.event, "w", encoding="utf-8") as f:
            json.dump(ev, f)
        return block

    def test_opened_pending_with_local_file(self):
        r = intake.run(Args(event=self.event, index=self.index, file=os.path.join(FIX, "good-save.zip")))
        self.assertTrue(r["ok"], r["errors"])
        self.assertEqual(r["status"], "pending")
        self.assertTrue(r["changed"])
        with open(self.index, encoding="utf-8") as f:
            idx = json.load(f)
        self.assertEqual(intake.validate_index(idx), [])
        self.assertEqual(idx["updatedAt"], "2026-01-02T12:00:00Z")
        e = idx["saves"][0]
        self.assertEqual((e["issue"], e["status"], e["id"]), (42, "pending", "sv_" + GOOD_SHA[:12]))
        self.assertEqual(e["createdAt"], "2026-01-02T10:00:00Z")
        self.assertEqual(e["layout"], "xeno")
        self.assertTrue(e["needsResign"])
        self.assertIn("waiting for review", r["comment"])
        self.assertIn("<!-- xeno-saves-intake -->", r["comment"])
        # second run with nothing changed: no diff, same bytes
        before = read_file(self.index)
        r2 = intake.run(Args(event=self.event, index=self.index, file=os.path.join(FIX, "good-save.zip"), now="2026-02-02T00:00:00Z"))
        self.assertFalse(r2["changed"])
        self.assertEqual(before, read_file(self.index))

    def test_download_path_end_to_end(self):
        self._event(block={"url": "https://pixeldrain.com/api/file/xenoTestGood"})
        real = intake.download

        def fake(url, dest, expected, **kw):
            self.assertEqual(url, "https://pixeldrain.com/api/file/xenoTestGood")
            return real(self.base + "/good.zip", dest, expected, **kw)

        intake.download = fake
        try:
            r = intake.run(Args(event=self.event, index=self.index, download_dir=os.path.join(self.dir, "dl")))
        finally:
            intake.download = real
        self.assertTrue(r["ok"], r["errors"])
        self.assertEqual(r["checks"]["sha256"], GOOD_SHA)
        self.assertFalse(os.path.exists(os.path.join(self.dir, "dl", "submission.zip")))  # cleaned up

    def test_approved_then_rejected_label(self):
        self._event(labels=["save-submission", "approved"])
        r = intake.run(Args(event=self.event, index=self.index, file=os.path.join(FIX, "good-save.zip")))
        self.assertEqual(r["status"], "published")
        self.assertIn("Published", r["comment"])
        with open(self.index, encoding="utf-8") as f:
            self.assertEqual(json.load(f)["saves"][0]["status"], "published")
        self._event(labels=["save-submission", "rejected"])
        r = intake.run(Args(event=self.event, index=self.index, file=os.path.join(FIX, "good-save.zip")))
        self.assertEqual(r["status"], "rejected")
        with open(self.index, encoding="utf-8") as f:
            idx = json.load(f)
        self.assertEqual(len(idx["saves"]), 1)
        self.assertEqual(idx["saves"][0]["status"], "rejected")

    def test_hash_mismatch_is_rejected_even_when_approved(self):
        self._event(labels=["approved"], block={"sha256": "0" * 64})
        r = intake.run(Args(event=self.event, index=self.index, file=os.path.join(FIX, "good-save.zip")))
        self.assertFalse(r["ok"])
        self.assertEqual(r["status"], "rejected")
        self.assertTrue(any("sha256" in e for e in r["errors"]))
        self.assertFalse(os.path.exists(self.index))  # nothing to record for a brand-new invalid submission
        self.assertIn("Not published", r["comment"])

    def test_edit_that_breaks_a_known_entry_marks_it_rejected(self):
        intake.run(Args(event=self.event, index=self.index, file=os.path.join(FIX, "good-save.zip")))
        self._event(block={"titleId": "CUSA00001"})
        r = intake.run(Args(event=self.event, index=self.index, file=os.path.join(FIX, "good-save.zip")))
        self.assertFalse(r["ok"])
        with open(self.index, encoding="utf-8") as f:
            e = json.load(f)["saves"][0]
        self.assertEqual(e["status"], "rejected")
        self.assertEqual(e["titleId"], "PPSA04029")  # the previous good data is kept
        self.assertTrue(e["reasons"])

    def test_sealed_zip_rejected(self):
        with open(os.path.join(FIX, "sealed-save.zip"), "rb") as f:
            data = f.read()
        self._event(block={"size": len(data), "sha256": hashlib.sha256(data).hexdigest()})
        r = intake.run(Args(event=self.event, index=self.index, file=os.path.join(FIX, "sealed-save.zip")))
        self.assertFalse(r["ok"])
        self.assertTrue(any("sealed key" in e for e in r["errors"]))

    def test_duplicate_file_other_issue(self):
        intake.run(Args(event=self.event, index=self.index, file=os.path.join(FIX, "good-save.zip")))
        self._event(number=43, html_url="https://github.com/XENOKING123/XENOKING/issues/43")
        r = intake.run(Args(event=self.event, index=self.index, file=os.path.join(FIX, "good-save.zip")))
        self.assertFalse(r["ok"])
        self.assertTrue(any("already in the store" in e for e in r["errors"]))

    def test_examples_are_preserved(self):
        shutil.copy(os.path.join(os.path.dirname(HERE), "..", "..", "updates", "saves.json"), self.index)
        with open(self.index, encoding="utf-8") as f:
            examples = json.load(f)["saves"]
        intake.run(Args(event=self.event, index=self.index, file=os.path.join(FIX, "good-save.zip")))
        with open(self.index, encoding="utf-8") as f:
            idx = json.load(f)
        self.assertEqual(idx["saves"][:len(examples)], examples)
        self.assertEqual(idx["saves"][-1]["issue"], 42)
        self.assertEqual(intake.validate_index(idx), [])

    def test_no_download_and_dry_run(self):
        r = intake.run(Args(event=self.event, index=self.index, no_download=True, dry_run=True))
        self.assertTrue(r["ok"])
        self.assertTrue(any("not downloaded" in w for w in r["warnings"]))
        self.assertFalse(os.path.exists(self.index))

    def test_body_input_and_cli(self):
        rc = intake.main(["--body", os.path.join(FIX, "issue-good.md"), "--number", "7", "--file", os.path.join(FIX, "good-save.zip"),
                          "--index", self.index, "--now", "2026-01-02T12:00:00Z", "--out", os.path.join(self.dir, "r.json")])
        self.assertEqual(rc, 0)
        with open(os.path.join(self.dir, "r.json"), encoding="utf-8") as f:
            r = json.load(f)
        self.assertEqual(r["issue"], 7)
        self.assertEqual(r["entry"]["issueUrl"], intake.ISSUE_BASE + "7")
        rc = intake.main(["--validate-index", self.index])
        self.assertEqual(rc, 0)
        rc = intake.main(["--body", os.path.join(FIX, "issue-good.md"), "--number", "8", "--file", os.path.join(FIX, "sealed-save.zip"), "--index", self.index, "--strict", "--dry-run", "--out", os.path.join(self.dir, "r2.json")])
        self.assertEqual(rc, 2)

    def test_bad_inputs_exit_1(self):
        with open(self.index, "w") as f:
            f.write("{broken")
        self.assertEqual(intake.main(["--event", self.event, "--index", self.index, "--no-download"]), 1)
        self.assertEqual(intake.main(["--validate-index", self.index]), 1)
        self.assertEqual(intake.main(["--no-download"]), 1)


def read_file(p):
    with open(p, "rb") as f:
        return f.read()


if __name__ == "__main__":
    unittest.main()
