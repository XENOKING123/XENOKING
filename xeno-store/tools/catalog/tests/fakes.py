"""Test doubles shared by the catalog test suite: a canned HTTP client and a SourceContext factory."""
from __future__ import annotations

import json
import os
import re
import time
from pathlib import Path
from typing import Any, Callable

HERE = Path(__file__).resolve().parent
FIXTURES = HERE / "fixtures"
TOOLS = HERE.parent
PROJECT_ROOT = TOOLS.parent.parent


def fixture(name: str) -> str:
    with open(FIXTURES / name, "r", encoding="utf-8") as fh:
        return fh.read()


def fixture_json(name: str) -> Any:
    return json.loads(fixture(name))


class FakeHttp:
    """``netutil.Http`` stand-in: ``routes`` maps a URL regex to a body (str/bytes/dict/list), a callable
    ``(url) -> body`` or an int HTTP status (raised as HttpError). Unknown URLs are 404."""

    def __init__(self, routes: list[tuple[str, Any]] | None = None, *, default_status: int = 404):
        self.routes = [(re.compile(rx), body) for rx, body in (routes or [])]
        self.default_status = default_status
        self.requests = 0
        self.failures = 0
        self.seen: list[str] = []
        self.host_intervals: dict[str, float] = {}

    def add(self, rx: str, body: Any) -> None:
        self.routes.append((re.compile(rx), body))

    def _resolve(self, url: str) -> Any:
        from netutil import HttpError
        self.requests += 1
        self.seen.append(url)
        for rx, body in self.routes:
            if rx.search(url):
                if callable(body):
                    body = body(url)
                if isinstance(body, int):
                    self.failures += 1
                    raise HttpError(url, body, f"HTTP {body}")
                return body
        self.failures += 1
        raise HttpError(url, self.default_status, f"HTTP {self.default_status}")

    def get(self, url: str, **kw: Any) -> bytes:
        body = self._resolve(url)
        if isinstance(body, bytes):
            return body
        if isinstance(body, (dict, list)):
            return json.dumps(body).encode("utf-8")
        return str(body).encode("utf-8")

    def text(self, url: str, **kw: Any) -> str:
        return self.get(url, **kw).decode("utf-8", "replace")

    def json(self, url: str, **kw: Any) -> Any:
        return json.loads(self.text(url, **kw))


def make_ctx(http: Any, *, mode: str = "online", limit: int = 0, budget: float = 60.0, root: Path | None = None,
             source_id: str = "test", extra: dict | None = None):
    from sources.base import SourceContext
    logs: list[str] = []
    ctx = SourceContext(root=root or PROJECT_ROOT, http=http, mode=mode, limit=limit, deadline=time.monotonic() + budget,
                        log=logs.append, source_id=source_id, extra=dict(extra or {}))
    ctx.logs = logs  # type: ignore[attr-defined]
    return ctx
