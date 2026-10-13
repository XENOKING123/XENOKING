"""Small stdlib HTTP client for the catalog pipeline.

Features the scrapers need and nothing more: a browser User-Agent (several
sites 403 anything else), gzip, per-host politeness (minimum interval between
requests to the same host, shared across threads), bounded bodies, retries with
backoff on transient errors, and a hard *deadline* so a slow site can never
hold the build hostage. Proxies and CA bundles come from the environment, as
urllib does by default.
"""
from __future__ import annotations

import gzip
import json
import socket
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

BROWSER_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)
PIPELINE_UA = "XENO-STORE-catalog/1.0 (+https://github.com/XENOKING123/XENOKING)"

DEFAULT_TIMEOUT = 20.0
DEFAULT_MAX_BYTES = 24 * 1024 * 1024


class HttpError(Exception):
    """A request failed for good (after retries). ``status`` is 0 for transport errors."""

    def __init__(self, url: str, status: int, message: str):
        super().__init__(f"{message} ({url})")
        self.url = url
        self.status = status


class BudgetExceeded(Exception):
    """Raised before a request would start past the caller's deadline."""


def host_of(url: str) -> str:
    try:
        return (urllib.parse.urlsplit(url).hostname or "").lower()
    except ValueError:
        return ""


class Http:
    """Thread-safe GET helper with per-host rate limiting and deadlines."""

    def __init__(self, user_agent: str = BROWSER_UA, min_interval: float = 1.0,
                 host_intervals: dict[str, float] | None = None):
        self.user_agent = user_agent
        self.min_interval = min_interval
        self.host_intervals = dict(host_intervals or {})
        self._last: dict[str, float] = {}
        self._down: dict[str, int] = {}     # consecutive transport failures per host
        self._lock = threading.Lock()
        self.requests = 0
        self.failures = 0
        self.host_down_after = 5            # transport failures in a row before a host is declared down

    # -- politeness ----------------------------------------------------------
    def _interval_for(self, host: str) -> float:
        for h, iv in self.host_intervals.items():
            if host == h or host.endswith("." + h):
                return iv
        return self.min_interval

    def _wait_turn(self, host: str, deadline: float | None) -> None:
        interval = self._interval_for(host)
        while True:
            with self._lock:
                now = time.monotonic()
                ready_at = self._last.get(host, 0.0) + interval
                if now >= ready_at:
                    self._last[host] = now
                    return
                wait = ready_at - now
            if deadline is not None and time.monotonic() + wait > deadline:
                raise BudgetExceeded(f"budget exhausted waiting for {host}")
            time.sleep(min(wait, 0.5))

    # -- requests ------------------------------------------------------------
    def get(self, url: str, *, timeout: float = DEFAULT_TIMEOUT, headers: dict[str, str] | None = None,
            retries: int = 2, max_bytes: int = DEFAULT_MAX_BYTES, deadline: float | None = None,
            accept: str = "*/*") -> bytes:
        """GET ``url`` and return the (decompressed) body. Raises HttpError or BudgetExceeded."""
        host = host_of(url)
        if not host:
            raise HttpError(url, 0, "bad url")
        attempt = 0
        last_err = ""
        while True:
            if deadline is not None and time.monotonic() >= deadline:
                raise BudgetExceeded(f"budget exhausted before {url}")
            # Circuit breaker: once a host has refused N connections in a row it
            # is treated as down and every further request fails immediately
            # instead of queueing behind the rate limiter.
            with self._lock:
                if self._down.get(host, 0) >= self.host_down_after:
                    raise HttpError(url, 0, f"host {host} unreachable (circuit open)")
            self._wait_turn(host, deadline)
            req = urllib.request.Request(url, method="GET")
            req.add_header("User-Agent", self.user_agent)
            req.add_header("Accept", accept)
            req.add_header("Accept-Encoding", "gzip")
            req.add_header("Accept-Language", "en-US,en;q=0.8")
            for k, v in (headers or {}).items():
                req.add_header(k, v)
            eff_timeout = timeout
            if deadline is not None:
                eff_timeout = max(1.0, min(timeout, deadline - time.monotonic()))
            self.requests += 1
            try:
                with urllib.request.urlopen(req, timeout=eff_timeout) as resp:
                    body = _read_bounded(resp, max_bytes)
                    if resp.headers.get("Content-Encoding", "").lower() == "gzip":
                        body = gzip.decompress(body)
                    with self._lock:
                        self._down[host] = 0
                    return body
            except urllib.error.HTTPError as e:
                status = e.code
                last_err = f"HTTP {status}"
                with self._lock:
                    self._down[host] = 0        # the host answered; it is up
                retry_after = _retry_after(e.headers.get("Retry-After"))
                if status in (429, 500, 502, 503, 504, 520, 521, 522, 524) and attempt < retries:
                    attempt += 1
                    self._backoff(attempt, retry_after, deadline)
                    continue
                self.failures += 1
                raise HttpError(url, status, last_err) from None
            except BudgetExceeded:
                raise
            except (urllib.error.URLError, socket.timeout, TimeoutError, ConnectionError, OSError, EOFError) as e:
                last_err = f"{type(e).__name__}: {getattr(e, 'reason', e)}"
                # The agent proxy answers "Tunnel connection failed: 403" for
                # unreachable hosts; that never recovers, so fail fast.
                permanent = "403" in str(e) or "Name or service not known" in str(e)
                if attempt < retries and not permanent:
                    attempt += 1
                    self._backoff(attempt, 0, deadline)
                    continue
                self.failures += 1
                with self._lock:
                    self._down[host] = self._down.get(host, 0) + 1
                raise HttpError(url, 0, last_err) from None

    def _backoff(self, attempt: int, retry_after: int, deadline: float | None) -> None:
        wait = max(float(retry_after), 1.5 * attempt)
        if deadline is not None and time.monotonic() + wait > deadline:
            raise BudgetExceeded("budget exhausted during backoff")
        time.sleep(wait)

    def request(self, method: str, url: str, *, timeout: float = DEFAULT_TIMEOUT,
                headers: dict[str, str] | None = None, max_bytes: int = DEFAULT_MAX_BYTES,
                deadline: float | None = None) -> "HttpResponse":
        """One request of any method (HEAD / GET with Range …) with the same politeness as ``get``.

        HTTP error statuses are *returned* (status + headers, body truncated), not raised; only
        transport failures raise ``HttpError`` (status 0). No retries: the audit decides those.
        """
        host = host_of(url)
        if not host:
            raise HttpError(url, 0, "bad url")
        if deadline is not None and time.monotonic() >= deadline:
            raise BudgetExceeded(f"budget exhausted before {url}")
        with self._lock:
            if self._down.get(host, 0) >= self.host_down_after:
                raise HttpError(url, 0, f"host {host} unreachable (circuit open)")
        self._wait_turn(host, deadline)
        req = urllib.request.Request(url, method=method.upper())
        req.add_header("User-Agent", self.user_agent)
        req.add_header("Accept", "*/*")
        req.add_header("Accept-Language", "en-US,en;q=0.8")
        for k, v in (headers or {}).items():
            req.add_header(k, v)
        eff_timeout = timeout
        if deadline is not None:
            eff_timeout = max(1.0, min(timeout, deadline - time.monotonic()))
        self.requests += 1
        try:
            with urllib.request.urlopen(req, timeout=eff_timeout) as resp:
                body = b"" if method.upper() == "HEAD" else _read_bounded_soft(resp, max_bytes)
                with self._lock:
                    self._down[host] = 0
                return HttpResponse(resp.status, _lower_headers(resp.headers), body, resp.geturl())
        except urllib.error.HTTPError as e:
            with self._lock:
                self._down[host] = 0
            try:
                body = b"" if method.upper() == "HEAD" else _read_bounded_soft(e, min(max_bytes, 256 * 1024))
            except (OSError, ValueError):
                body = b""
            return HttpResponse(e.code, _lower_headers(e.headers), body, url)
        except BudgetExceeded:
            raise
        except (urllib.error.URLError, socket.timeout, TimeoutError, ConnectionError, OSError, EOFError) as e:
            self.failures += 1
            with self._lock:
                self._down[host] = self._down.get(host, 0) + 1
            raise HttpError(url, 0, f"{type(e).__name__}: {getattr(e, 'reason', e)}") from None

    def text(self, url: str, **kw: Any) -> str:
        return self.get(url, **kw).decode("utf-8", "replace")

    def json(self, url: str, **kw: Any) -> Any:
        kw.setdefault("accept", "application/json, */*;q=0.5")
        raw = self.get(url, **kw)
        try:
            return json.loads(raw.decode("utf-8", "replace"))
        except ValueError as e:
            raise HttpError(url, 200, f"invalid JSON: {e}") from None


class HttpResponse:
    """What ``Http.request`` returns: status, lower-cased headers, (possibly truncated) body, final URL."""

    __slots__ = ("status", "headers", "body", "url")

    def __init__(self, status: int, headers: dict[str, str], body: bytes, url: str):
        self.status, self.headers, self.body, self.url = status, headers, body, url

    def header(self, name: str, default: str = "") -> str:
        return self.headers.get(name.lower(), default)


def _lower_headers(msg: Any) -> dict[str, str]:
    out: dict[str, str] = {}
    try:
        for k, v in msg.items():
            out[str(k).lower()] = str(v)
    except AttributeError:
        pass
    return out


def _read_bounded_soft(resp: Any, max_bytes: int) -> bytes:
    """Like _read_bounded but truncates instead of raising (audit bodies are only inspected)."""
    chunks: list[bytes] = []
    total = 0
    while total < max_bytes:
        chunk = resp.read(min(256 * 1024, max_bytes - total))
        if not chunk:
            break
        total += len(chunk)
        chunks.append(chunk)
    return b"".join(chunks)


def _read_bounded(resp: Any, max_bytes: int) -> bytes:
    chunks: list[bytes] = []
    total = 0
    while True:
        chunk = resp.read(256 * 1024)
        if not chunk:
            break
        total += len(chunk)
        if total > max_bytes:
            raise HttpError(getattr(resp, "url", "?"), 200, f"body larger than {max_bytes} bytes")
        chunks.append(chunk)
    return b"".join(chunks)


def _retry_after(value: str | None) -> int:
    if not value:
        return 0
    try:
        return max(0, min(int(value), 60))
    except ValueError:
        return 0
