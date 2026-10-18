"""http.py: cache, retries, FIRMS limiter, secret masking (offline, via httpx.MockTransport)."""

from __future__ import annotations

import logging
import time
from pathlib import Path

import httpx
import pytest

import fire3d.http as fhttp
from fire3d import config

FAKE_KEY = "0123456789abcdef0123456789abcdef"


class Recorder:
    """MockTransport handler serving scripted responses and counting calls."""

    def __init__(self, *responses: httpx.Response | Exception):
        self.responses = list(responses)
        self.calls: list[httpx.Request] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.calls.append(request)
        r = self.responses.pop(0) if len(self.responses) > 1 else self.responses[0]
        if isinstance(r, Exception):
            raise r
        return r


@pytest.fixture
def mock(monkeypatch: pytest.MonkeyPatch, tmp_data_dir: Path):
    monkeypatch.setattr(fhttp, "BACKOFF_BASE_S", 0.001)

    def install(*responses: httpx.Response | Exception) -> Recorder:
        rec = Recorder(*responses)
        monkeypatch.setattr(fhttp, "_transport", httpx.MockTransport(rec))
        return rec

    return install


def test_rate_limiter_window() -> None:
    rl = fhttp.RateLimiter(3, 0.3)
    assert [rl.try_acquire() for _ in range(4)] == [True, True, True, False]
    assert rl.remaining() == 0
    assert rl.acquire(timeout=0.05) is False
    t0 = time.monotonic()
    assert rl.acquire(timeout=2.0) is True
    assert 0.2 < time.monotonic() - t0 < 1.5
    with pytest.raises(ValueError):
        fhttp.RateLimiter(0, 1)


def test_get_json_is_cached(mock) -> None:
    rec = mock(httpx.Response(200, json={"a": 1}))
    url = "https://example.test/data"
    assert fhttp.get_json(url, {"b": 2, "a": 1}) == {"a": 1}
    assert fhttp.get_json(url, {"a": 1, "b": 2}) == {"a": 1}         # param order does not matter
    assert len(rec.calls) == 1
    assert rec.calls[0].headers["user-agent"] == config.USER_AGENT
    r = fhttp.request("GET", url, params={"a": 1, "b": 2})
    assert r.from_cache and r.status == 200
    fhttp.get_json(url, {"a": 1, "b": 2}, ttl_s=0)                    # bypass
    assert len(rec.calls) == 2
    cache_files = list((Path(config.CACHE_DIR) / "http").rglob("*.bin"))
    assert len(cache_files) == 1


def test_ttl_expiry(mock) -> None:
    rec = mock(httpx.Response(200, text="hello"))
    assert fhttp.get_text("https://example.test/t", ttl_s=0.2) == "hello"
    assert fhttp.get_text("https://example.test/t", ttl_s=0.2) == "hello"
    assert len(rec.calls) == 1
    time.sleep(0.35)
    fhttp.get_text("https://example.test/t", ttl_s=0.2)
    assert len(rec.calls) == 2
    fhttp.get_text("https://example.test/t", ttl_s=None)              # None = never expires
    assert len(rec.calls) == 2


def test_retries_then_success(mock) -> None:
    rec = mock(httpx.Response(503), httpx.ConnectError("boom"), httpx.Response(429, headers={"retry-after": "0"}), httpx.Response(200, content=b"\x00\x01"))
    assert fhttp.get_bytes("https://example.test/b") == b"\x00\x01"
    assert len(rec.calls) == 4


def test_retries_exhausted_and_4xx(mock) -> None:
    mock(httpx.Response(500))
    with pytest.raises(fhttp.HttpError) as ei:
        fhttp.get_bytes("https://example.test/down", retries=2)
    assert ei.value.status == 500
    rec = mock(httpx.Response(404, text="not here"))
    with pytest.raises(fhttp.HttpError) as ei:
        fhttp.get_json("https://example.test/missing")
    assert ei.value.status == 404 and "not here" in str(ei.value)
    assert len(rec.calls) == 1


def test_errors_and_logs_mask_the_key(mock, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture) -> None:
    monkeypatch.setattr(config, "FIRMS_MAP_KEY", FAKE_KEY)
    monkeypatch.setattr(fhttp, "firms_limiter", fhttp.RateLimiter(100, 600))
    url = f"https://firms.modaps.eosdis.nasa.gov/api/area/csv/{FAKE_KEY}/VIIRS_SNPP_SP/-118,34,-117,35/1/2025-01-07"
    mock(httpx.Response(503), httpx.Response(400, text=f"Invalid MAP_KEY {FAKE_KEY}"))
    caplog.set_level(logging.DEBUG)
    with pytest.raises(fhttp.HttpError) as ei:
        fhttp.get_text(url)
    assert FAKE_KEY not in str(ei.value) and "***" in str(ei.value)
    assert ei.value.__cause__ is None and ei.value.__suppress_context__ in (True, False)
    assert FAKE_KEY not in caplog.text
    logging.getLogger("httpx").warning("HTTP Request: GET %s", url)
    assert FAKE_KEY not in caplog.text
    meta = list((Path(config.CACHE_DIR) / "http").rglob("*.json"))
    assert all(FAKE_KEY not in p.read_text() for p in meta)


def test_firms_requests_use_the_limiter(mock, monkeypatch: pytest.MonkeyPatch) -> None:
    lim = fhttp.RateLimiter(2, 600)
    monkeypatch.setattr(fhttp, "firms_limiter", lim)
    rec = mock(httpx.Response(200, text="latitude,longitude\n"))
    base = "https://firms.modaps.eosdis.nasa.gov/api/area/csv/KEY/VIIRS_SNPP_SP/-118,34,-117,35/1/"
    fhttp.get_text(base + "2025-01-07")
    fhttp.get_text(base + "2025-01-07")          # cache hit: no slot used
    assert lim.remaining() == 1
    fhttp.get_text("https://firms.modaps.eosdis.nasa.gov/data/active_fire/x.csv")   # not /api/: not limited
    assert lim.remaining() == 1
    fhttp.get_text(base + "2025-01-08")
    assert lim.remaining() == 0 and len(rec.calls) == 3
    assert fhttp.is_firms_api("https://firms.modaps.eosdis.nasa.gov/api/data_availability/csv/K/ALL")
    assert not fhttp.is_firms_api("https://example.test/firms.modaps.eosdis.nasa.gov/api/")


def test_post_json_cached_by_body(mock) -> None:
    rec = mock(httpx.Response(200, json={"features": []}))
    url = "https://example.test/search"
    fhttp.post_json(url, {"collections": ["s2"], "bbox": [1, 2, 3, 4]})
    fhttp.post_json(url, {"bbox": [1, 2, 3, 4], "collections": ["s2"]})      # same body, other key order
    fhttp.post_json(url, {"collections": ["s2"], "bbox": [1, 2, 3, 5]})
    assert len(rec.calls) == 2
    assert rec.calls[0].headers["content-type"] == "application/json"


def test_stream_download(mock, tmp_path: Path) -> None:
    rec = mock(httpx.Response(200, content=b"x" * 5000))
    dest = tmp_path / "dl" / "file.csv"
    assert fhttp.stream_download("https://example.test/f.csv", dest) == dest
    assert dest.read_bytes() == b"x" * 5000
    fhttp.stream_download("https://example.test/f.csv", dest)            # kept
    assert len(rec.calls) == 1
    mock(httpx.Response(200, content=b"new"))
    fhttp.stream_download("https://example.test/f.csv", dest, overwrite=True)
    assert dest.read_bytes() == b"new"
    assert not list(dest.parent.glob(".*part"))
    mock(httpx.Response(404))
    with pytest.raises(fhttp.HttpError):
        fhttp.stream_download("https://example.test/nope.csv", tmp_path / "dl" / "nope.csv")
    assert not (tmp_path / "dl" / "nope.csv").exists()


def test_tests_are_offline() -> None:
    with pytest.raises(Exception, match="network access in tests"):
        fhttp.get_json("https://example.test/real", ttl_s=0, retries=0)
