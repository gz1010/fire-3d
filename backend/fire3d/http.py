"""Cached, retried, rate-limited HTTP client (httpx) shared by every data source.

* On-disk cache in ``CACHE_DIR/http`` keyed by sha256(method + masked URL + sorted params + body).
  ``ttl_s``: seconds a cached 2xx response stays valid; ``None`` = forever; ``0`` = bypass the cache entirely.
* Exponential backoff with jitter on 429 / 5xx / timeouts / connection errors (honours ``Retry-After``), except a
  429 whose body says a daily / hourly / minutely request limit was exceeded (Open-Meteo's quota answer, CONTRACT
  14.12.2): that one raises at once, since retrying within seconds cannot help.
* Only usable 2xx bodies are cached: a body that is an error in disguise (``{"error": true}``, an ArcGIS
  ``{"error": {...}}``, JSON that does not parse or is cut off, Open-Meteo's "Unexpected error while streaming
  data") is returned to the caller but never stored, and such an entry found in the cache is evicted.
* At most ``config.HTTP_MAX_CONCURRENCY`` (4) requests in flight per process; ``User-Agent`` set; redirects followed.
* Every request to ``firms.modaps.eosdis.nasa.gov/api/`` first takes a slot from :data:`firms_limiter`
  (150 per rolling 10 min); cache hits don't count.
* URLs in logs and exceptions always go through :func:`fire3d.config.mask_secrets`.
* :class:`DownMemo` remembers a failed upstream for a short time (60 s), so request paths that would ask the same dead
  host again (the fire lists, resolution of ids) answer from a cached copy, or say "unavailable", at once
  (brief 3 final verification; CONTRACT 14.16).

Everything here is synchronous and thread-safe; from async code call it via ``run_in_threadpool``/``to_thread``.
"""

from __future__ import annotations

import hashlib
import logging
import os
import random
import re
import tempfile
import threading
import time
from collections import deque
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping, Sequence
from urllib.parse import urlencode

import httpx
import orjson

from . import config

log = logging.getLogger(__name__)

DEFAULT_TTL_S: float | None = 3600.0
DEFAULT_TIMEOUT_S = 60.0
DEFAULT_RETRIES = 4
BACKOFF_BASE_S = 1.5
MAX_BACKOFF_S = 60.0

Params = Mapping[str, Any] | Sequence[tuple[str, Any]] | None

# A 429 with one of these bodies is a quota answer: never retried (Open-Meteo, CONTRACT 14.12.2).
_QUOTA_RE = re.compile(r"\b(daily|hourly|minutely)\s+api\s+request\s+limit\s+exceeded", re.IGNORECASE)
_STREAM_ERROR = b"Unexpected error while streaming data"
ERROR_BODY_PARSE_MAX = 4 << 20       # JSON bodies up to this size are parsed to check them; larger ones by their ends


def quota_period(text: str | bytes | None) -> str | None:
    """``"daily"`` / ``"hourly"`` / ``"minutely"`` when ``text`` is a request-limit answer, else None."""
    if not text:
        return None
    if isinstance(text, bytes):
        text = text[:2000].decode("utf-8", errors="replace")
    m = _QUOTA_RE.search(text)
    return m.group(1).lower() if m else None


def is_error_body(content: bytes, content_type: str = "", expect_json: bool = False) -> bool:
    """True when a 2xx body is an error in disguise and must not be cached: Open-Meteo's "Unexpected error while
    streaming data" (anywhere in the last 1 KB, or a short body), JSON that does not parse or is cut off, or a
    top-level JSON object whose ``error`` is ``true`` or an object (Open-Meteo, ArcGIS). ``expect_json``: the caller
    asked for JSON, so any body that is not JSON (an HTML maintenance page) is an error body too, and a good cached
    copy is never overwritten by it."""
    if not content:
        return expect_json
    if _STREAM_ERROR in content[-1024:] or (len(content) <= 4096 and _STREAM_ERROR in content):
        return True
    head = content[:64].lstrip()
    looks_json = "json" in (content_type or "").lower() or head[:1] in (b"{", b"[")
    if not looks_json:
        return expect_json
    if len(content) > ERROR_BODY_PARSE_MAX:      # too big to be an error answer; only catch a cut-off body
        tail = content.rstrip()[-1:]
        return head[:1] in (b"{", b"[") and tail not in (b"}", b"]")
    try:
        doc = orjson.loads(content)
    except orjson.JSONDecodeError:
        return True
    return isinstance(doc, dict) and (doc.get("error") is True or isinstance(doc.get("error"), dict))


class _MaskSecretsFilter(logging.Filter):
    """Masks secrets in records emitted by third-party HTTP loggers (httpx logs full URLs at INFO)."""

    def filter(self, record: logging.LogRecord) -> bool:
        try:
            msg = record.getMessage()
        except Exception:  # pragma: no cover - malformed record
            return True
        masked = config.mask_secrets(msg)
        if masked != msg:
            record.msg, record.args = masked, ()
        return True


for _name in ("httpx", "httpcore"):
    _lg = logging.getLogger(_name)
    _lg.addFilter(_MaskSecretsFilter())
    if _lg.level == logging.NOTSET or _lg.level < logging.WARNING:
        _lg.setLevel(logging.WARNING)


class HttpError(RuntimeError):
    """An HTTP failure with a secret-free message. ``status`` is None for transport errors/timeouts."""

    def __init__(self, status: int | None, url: str, message: str):
        self.status = status
        self.url = config.mask_secrets(url)
        self.message = config.mask_secrets(message)
        super().__init__(f"HTTP {status if status is not None else 'error'} for {self.url}: {self.message}")


class RateLimiter:
    """Thread-safe rolling-window limiter: at most ``max_calls`` acquisitions per ``per_seconds``."""

    def __init__(self, max_calls: int, per_seconds: float, name: str = "rate limiter"):
        if max_calls < 1 or per_seconds <= 0:
            raise ValueError("max_calls must be >= 1 and per_seconds > 0")
        self.max_calls = int(max_calls)
        self.per_seconds = float(per_seconds)
        self.name = name
        self._times: deque[float] = deque()
        self._lock = threading.Lock()

    def _prune(self, now: float) -> None:
        while self._times and now - self._times[0] >= self.per_seconds:
            self._times.popleft()

    def remaining(self) -> int:
        """Slots available right now."""
        with self._lock:
            self._prune(time.monotonic())
            return self.max_calls - len(self._times)

    def try_acquire(self) -> bool:
        """Take a slot if one is free; never blocks."""
        with self._lock:
            now = time.monotonic()
            self._prune(now)
            if len(self._times) < self.max_calls:
                self._times.append(now)
                return True
            return False

    def acquire(self, timeout: float | None = None) -> bool:
        """Block until a slot is free (or ``timeout`` seconds pass -> False)."""
        deadline = None if timeout is None else time.monotonic() + timeout
        warned = False
        while True:
            with self._lock:
                now = time.monotonic()
                self._prune(now)
                if len(self._times) < self.max_calls:
                    self._times.append(now)
                    return True
                wait = self.per_seconds - (now - self._times[0]) + 0.01
            if deadline is not None:
                left = deadline - time.monotonic()
                if left <= 0:
                    return False
                wait = min(wait, left)
            if not warned:
                log.warning("%s: %d calls / %.0f s reached; waiting %.0f s", self.name, self.max_calls, self.per_seconds, wait)
                warned = True
            time.sleep(min(wait, 5.0))

    def __enter__(self) -> "RateLimiter":
        self.acquire()
        return self

    def __exit__(self, *exc: object) -> None:
        return None


firms_limiter = RateLimiter(config.FIRMS_MAX_REQUESTS_PER_10MIN, 600.0, name="FIRMS API limiter")

DOWN_HOLD_S = 60.0
_memos: list["DownMemo"] = []


class DownMemo:
    """A short memory of failed upstreams: after :meth:`mark` (a request failed after its retries), :meth:`down` is
    True for ``hold_s`` seconds, so a request path answers from a cached copy (or says "unavailable") at once instead
    of waiting on a dead host again for every request; a success :meth:`clear`s it. Keys are the caller's (a list key,
    or a whole source after a connection error or timeout)."""

    def __init__(self, name: str, hold_s: float = DOWN_HOLD_S):
        self.name = name
        self.hold_s = float(hold_s)
        self._until: dict[str, float] = {}
        self._lock = threading.Lock()
        _memos.append(self)

    def mark(self, key: str) -> None:
        with self._lock:
            self._until[key] = time.monotonic() + self.hold_s

    def clear(self, key: str) -> None:
        with self._lock:
            self._until.pop(key, None)

    def down(self, *keys: str) -> bool:
        """True when any of ``keys`` failed less than ``hold_s`` seconds ago."""
        now = time.monotonic()
        with self._lock:
            for k in keys:
                t = self._until.get(k)
                if t is None:
                    continue
                if now < t:
                    return True
                self._until.pop(k, None)
        return False

    def reset(self) -> None:
        with self._lock:
            self._until.clear()


def reset_down_memos() -> None:
    """Forget every remembered failure (tests; a manual refresh)."""
    for m in _memos:
        m.reset()

_semaphore = threading.Semaphore(config.HTTP_MAX_CONCURRENCY)
_tls = threading.local()
_transport: httpx.BaseTransport | None = None   # tests may inject an httpx.MockTransport


def _client() -> httpx.Client:
    c = getattr(_tls, "client", None)
    if c is None or getattr(_tls, "transport", None) is not _transport:
        c = httpx.Client(
            follow_redirects=True,
            headers={"User-Agent": config.USER_AGENT},
            transport=_transport,
        )
        _tls.client, _tls.transport = c, _transport
    return c


def is_firms_api(url: str) -> bool:
    """True for URLs under ``firms.modaps.eosdis.nasa.gov/api/`` (rate-limited)."""
    rest = url.split("://", 1)[-1].lower()
    return rest.startswith(config.FIRMS_API_PREFIX) or rest.startswith("www." + config.FIRMS_API_PREFIX)


def _norm_params(params: Params) -> list[tuple[str, str]]:
    if not params:
        return []
    items = params.items() if isinstance(params, Mapping) else params
    out: list[tuple[str, str]] = []
    for k, v in items:
        if v is None:
            continue
        if isinstance(v, (list, tuple)):
            out.extend((str(k), str(x)) for x in v)
        else:
            out.append((str(k), str(v)))
    return out


def display_url(url: str, params: Params = None) -> str:
    """URL with its query string, secrets masked: safe for logs and error messages."""
    q = urlencode(_norm_params(params))
    return config.mask_secrets(f"{url}{'&' if '?' in url else '?'}{q}" if q else url)


def cache_key(method: str, url: str, params: Params = None, body: bytes | None = None) -> str:
    """sha256 of method + masked URL + sorted params + body (the key itself never enters the hash)."""
    h = hashlib.sha256()
    h.update(method.upper().encode())
    h.update(b"\n")
    h.update(config.mask_secrets(url).encode())
    h.update(b"\n")
    h.update(config.mask_secrets(urlencode(sorted(_norm_params(params)))).encode())
    h.update(b"\n")
    if body:
        h.update(body)
    return h.hexdigest()


def _cache_paths(key: str) -> tuple[Path, Path]:
    d = Path(config.CACHE_DIR) / config.HTTP_CACHE_DIR_NAME / key[:2]
    return d / f"{key}.bin", d / f"{key}.json"


def atomic_write_bytes(path: Path, data: bytes) -> None:
    """Write ``data`` to ``path`` atomically (temp file in the same dir + os.replace)."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.", suffix=".tmp")
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except FileNotFoundError:
            pass
        raise


@dataclass
class Response:
    """A completed (2xx) response, possibly served from the cache."""

    status: int
    url: str            # masked display URL
    content: bytes
    content_type: str
    from_cache: bool
    fetched_ms: int

    def json(self) -> Any:
        return orjson.loads(self.content)

    @property
    def text(self) -> str:
        charset = "utf-8"
        ct = self.content_type.lower()
        if "charset=" in ct:
            charset = ct.split("charset=", 1)[1].split(";")[0].strip() or "utf-8"
        return self.content.decode(charset, errors="replace")


def _cache_read(key: str, ttl_s: float | None) -> Response | None:
    body_p, meta_p = _cache_paths(key)
    try:
        st = body_p.stat()
    except FileNotFoundError:
        return None
    if ttl_s is not None and time.time() - st.st_mtime > ttl_s:
        return None
    try:
        meta = orjson.loads(meta_p.read_bytes())
        content = body_p.read_bytes()
    except (OSError, orjson.JSONDecodeError):
        return None
    if is_error_body(content, meta.get("content_type", "")):      # stored before error bodies were refused
        log.info("http cache: evicting an error body for %s", meta.get("url", ""))
        for p in (body_p, meta_p):
            try:
                p.unlink()
            except FileNotFoundError:
                pass
        return None
    return Response(int(meta.get("status", 200)), meta.get("url", ""), content, meta.get("content_type", ""), True, int(meta.get("fetched_ms", st.st_mtime * 1000)))


def peek_cache(method: str, url: str, params: Params = None, ttl_s: float | None = DEFAULT_TTL_S) -> Response | None:
    """The cached 2xx response that :func:`request` with these arguments would return without touching the network,
    or None. Lets callers spend a rate-limit slot only on real requests (bodyless requests only)."""
    if ttl_s is not None and ttl_s <= 0:
        return None
    return _cache_read(cache_key(method.upper(), url, params), ttl_s)


def has_cache(method: str, url: str, params: Params = None) -> bool:
    """True when a cached copy (any age) of this bodyless request exists (cheap: no body is read)."""
    return _cache_paths(cache_key(method.upper(), url, params))[0].is_file()


def evict_bad_answer(resp: Response, method: str, url: str, params: Params = None) -> None:
    """Drop an unusable 2xx answer from the cache, but only when it is the one stored there: an answer served from the
    cache, or a fresh one that :func:`request` stored (one that is not JSON was never stored, and evicting would then
    drop the last good copy, which stale-if-error needs)."""
    if resp.from_cache or not is_error_body(resp.content, resp.content_type, expect_json=True):
        evict_cache(method, url, params)


def evict_cache(method: str, url: str, params: Params = None) -> None:
    """Drop one cache entry, e.g. a 2xx answer that turned out to be unusable (the cache stores every 2xx)."""
    for p in _cache_paths(cache_key(method.upper(), url, params)):
        try:
            p.unlink()
        except FileNotFoundError:
            pass


def _cache_write(key: str, resp: Response) -> None:
    body_p, meta_p = _cache_paths(key)
    try:
        atomic_write_bytes(meta_p, orjson.dumps({"url": resp.url, "status": resp.status, "content_type": resp.content_type, "fetched_ms": resp.fetched_ms, "size": len(resp.content)}))
        atomic_write_bytes(body_p, resp.content)
    except OSError as e:  # a full disk must not break the caller
        log.warning("http cache write failed for %s: %s", resp.url, e)


def _retry_delay(attempt: int, retry_after: str | None) -> float:
    if retry_after:
        try:
            return min(float(retry_after), 120.0)
        except ValueError:
            pass
    return min(MAX_BACKOFF_S, BACKOFF_BASE_S * (2**attempt)) * (0.75 + 0.5 * random.random())


def request(
    method: str,
    url: str,
    *,
    params: Params = None,
    json_body: Any = None,
    data: bytes | None = None,
    headers: Mapping[str, str] | None = None,
    ttl_s: float | None = DEFAULT_TTL_S,
    timeout: float = DEFAULT_TIMEOUT_S,
    retries: int = DEFAULT_RETRIES,
    connect_timeout: float | None = None,
    expect_json: bool = False,
) -> Response:
    """Perform a cached request and return a 2xx :class:`Response`; raise :class:`HttpError` otherwise.
    ``connect_timeout`` (default ``min(15, timeout)``) bounds the connection; ``expect_json``: a 2xx body that is not
    JSON is returned but never cached (see :func:`is_error_body`)."""
    method = method.upper()
    body = orjson.dumps(json_body, option=orjson.OPT_SORT_KEYS) if json_body is not None else data
    shown = display_url(url, params)
    use_cache = ttl_s is None or ttl_s > 0
    key = cache_key(method, url, params, body) if use_cache else ""
    if use_cache:
        hit = _cache_read(key, ttl_s)
        if hit is not None:
            return hit
    hdrs = dict(headers or {})
    if json_body is not None:
        hdrs.setdefault("Content-Type", "application/json")
    norm = _norm_params(params) or None
    attempt = 0
    while True:
        if is_firms_api(url):
            firms_limiter.acquire()
        status: int | None = None
        retry_after: str | None = None
        try:
            with _semaphore:
                ct_s = min(15.0, timeout) if connect_timeout is None else min(connect_timeout, timeout)
                r = _client().request(method, url, params=norm, content=body, headers=hdrs, timeout=httpx.Timeout(timeout, connect=ct_s))
                content = r.content
            status = r.status_code
            if 200 <= status < 300:
                resp = Response(status, shown, content, r.headers.get("content-type", ""), False, int(time.time() * 1000))
                if use_cache:
                    if is_error_body(content, resp.content_type, expect_json):
                        log.warning("%s %s -> %d with an error body; not cached", method, shown, status)
                    else:
                        _cache_write(key, resp)
                return resp
            if (status != 429 and status < 500) or (status == 429 and quota_period(content)):
                snippet = content[:300].decode("utf-8", errors="replace").strip()
                raise HttpError(status, shown, snippet or r.reason_phrase or "request failed")
            err = f"status {status}"
            retry_after = r.headers.get("retry-after")
        except HttpError:
            raise
        except httpx.HTTPError as e:   # timeouts, connection/protocol errors
            err = type(e).__name__
        if attempt >= retries:
            raise HttpError(status, shown, f"{err} after {retries + 1} attempts") from None
        delay = _retry_delay(attempt, retry_after)
        log.warning("%s %s -> %s; retry %d/%d in %.1f s", method, shown, err, attempt + 1, retries, delay)
        time.sleep(delay)
        attempt += 1


def get_json(url: str, params: Params = None, *, ttl_s: float | None = DEFAULT_TTL_S, timeout: float = DEFAULT_TIMEOUT_S, headers: Mapping[str, str] | None = None, retries: int = DEFAULT_RETRIES) -> Any:
    """GET and parse JSON."""
    return request("GET", url, params=params, headers=headers, ttl_s=ttl_s, timeout=timeout, retries=retries).json()


def get_bytes(url: str, params: Params = None, *, ttl_s: float | None = DEFAULT_TTL_S, timeout: float = DEFAULT_TIMEOUT_S, headers: Mapping[str, str] | None = None, retries: int = DEFAULT_RETRIES) -> bytes:
    """GET raw bytes (check the magic number yourself: ArcGIS returns JSON errors with status 200)."""
    return request("GET", url, params=params, headers=headers, ttl_s=ttl_s, timeout=timeout, retries=retries).content


def get_text(url: str, params: Params = None, *, ttl_s: float | None = DEFAULT_TTL_S, timeout: float = DEFAULT_TIMEOUT_S, headers: Mapping[str, str] | None = None, retries: int = DEFAULT_RETRIES) -> str:
    """GET text (charset from Content-Type, default UTF-8)."""
    return request("GET", url, params=params, headers=headers, ttl_s=ttl_s, timeout=timeout, retries=retries).text


def post_json(url: str, body: Any, *, params: Params = None, ttl_s: float | None = DEFAULT_TTL_S, timeout: float = DEFAULT_TIMEOUT_S, headers: Mapping[str, str] | None = None, retries: int = DEFAULT_RETRIES) -> Any:
    """POST a JSON body and parse the JSON response (cached by body too)."""
    return request("POST", url, params=params, json_body=body, headers=headers, ttl_s=ttl_s, timeout=timeout, retries=retries).json()


def stream_download(
    url: str,
    path: str | os.PathLike[str],
    *,
    params: Params = None,
    timeout: float = 300.0,
    retries: int = DEFAULT_RETRIES,
    overwrite: bool = False,
    chunk_size: int = 1 << 20,
) -> Path:
    """Stream ``url`` to ``path`` atomically (temp file + rename). An existing file is kept unless ``overwrite``."""
    dest = Path(path)
    if dest.exists() and not overwrite:
        return dest
    dest.parent.mkdir(parents=True, exist_ok=True)
    shown = display_url(url, params)
    norm = _norm_params(params) or None
    attempt = 0
    while True:
        if is_firms_api(url):
            firms_limiter.acquire()
        status: int | None = None
        err = "error"
        fd, tmp = tempfile.mkstemp(dir=dest.parent, prefix=f".{dest.name}.", suffix=".part")
        try:
            with _semaphore, os.fdopen(fd, "wb") as f:
                with _client().stream("GET", url, params=norm, timeout=httpx.Timeout(timeout, connect=min(15.0, timeout))) as r:
                    status = r.status_code
                    if 200 <= status < 300:
                        for chunk in r.iter_bytes(chunk_size):
                            f.write(chunk)
            if status is not None and 200 <= status < 300:
                os.replace(tmp, dest)
                return dest
            if status is not None and status != 429 and status < 500:
                raise HttpError(status, shown, "download failed")
            err = f"status {status}"
        except HttpError:
            raise
        except httpx.HTTPError as e:
            err = type(e).__name__
        finally:
            if os.path.exists(tmp):
                os.unlink(tmp)
        if attempt >= retries:
            raise HttpError(status, shown, f"{err} after {retries + 1} attempts") from None
        delay = _retry_delay(attempt, None)
        log.warning("download %s -> %s; retry %d/%d in %.1f s", shown, err, attempt + 1, retries, delay)
        time.sleep(delay)
        attempt += 1
