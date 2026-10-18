"""sources/overpass.py: CMR granule parsing, the per-product search, confirmation against FIRMS data times."""

from __future__ import annotations

import json

import httpx
import pytest

import fire3d.http as fhttp
from fire3d.sources import overpass

H = 3_600_000
T0 = 1_792_000_000_000 // H * H          # 2026-10 hour boundary


def _entry(t_ms: int, flag: str = "DAY", published_ms: int | None = None, minutes: int = 6) -> dict:
    iso = lambda ms: overpass._iso(ms).replace("Z", ".000Z")  # noqa: E731
    e = {"time_start": iso(t_ms), "time_end": iso(t_ms + minutes * 60_000), "day_night_flag": flag}
    if published_ms is not None:
        e["updated"] = iso(published_ms)
    return e


def test_parse_granules_flags_and_bad_entries() -> None:
    p = overpass.PRODUCT_BY_SATELLITE["N21"]
    entries = [_entry(T0, "DAY", T0 + 2 * H), _entry(T0 + H, "NIGHT"), {"time_start": "garbage"}, "x",
               _entry(T0 + 2 * H, "BOTH")]
    out = overpass.parse_granules(entries, p, p.nrt, lat=34.0, lon=-118.0)
    assert [q.t_ms for q in out] == [T0, T0 + H, T0 + 2 * H]
    assert out[0].daynight == "D" and out[1].daynight == "N" and out[2].daynight in ("D", "N")
    assert out[0].t_end_ms == T0 + 6 * 60_000 and out[0].published_ms == T0 + 2 * H and out[1].published_ms is None
    assert out[0].satellite == "N21" and out[0].instrument == "VIIRS" and out[0].product == "VJ214IMG_NRT v2"
    assert "NOAA-21 VIIRS" in out[0].describe() and "(day)" in out[0].describe()


def test_confirmation_rules() -> None:
    p = overpass.Pass(T0, T0 + 6 * 60_000, "N20", "VIIRS", "NOAA-20 VIIRS", "N", T0 + H, "x")
    assert not overpass.is_confirmed(p, T0 + H + 29 * 60_000)          # published, but FIRMS fetched too soon after
    assert overpass.is_confirmed(p, T0 + H + 30 * 60_000)
    q = overpass.Pass(T0, T0 + 6 * 60_000, "N20", "VIIRS", "NOAA-20 VIIRS", "N", None, "x")
    assert not overpass.is_confirmed(q, T0 + 2 * H)                     # no publish time: FIRMS' 3 h latency
    assert overpass.is_confirmed(q, T0 + 6 * 60_000 + 3 * H)
    assert overpass.confirmed([p, q], None) == []
    assert overpass.confirmed([q, p], T0 + 4 * H) == [p, q] or overpass.confirmed([q, p], T0 + 4 * H)[0].t_ms == T0


def test_detections_per_pass() -> None:
    a = overpass.Pass(T0, T0 + 6 * 60_000, "N", "VIIRS", "Suomi NPP VIIRS", "D", None, "x")
    b = overpass.Pass(T0 + 2 * H, T0 + 2 * H + 6 * 60_000, "N", "VIIRS", "Suomi NPP VIIRS", "D", None, "x")
    t = [T0 + 2 * 60_000, T0 + 7 * 60_000, T0 + 8 * 60_000, T0 + 2 * H + 60_000]
    s = ["N", "N", "N", "N20"]
    assert overpass.detections_per_pass([a, b], t, s) == [2, 0]        # +1 min slack; another satellite does not count


@pytest.fixture
def cmr(monkeypatch):
    """Mock CMR: answers per short_name/version from ``responses``; records requests."""
    state = {"responses": {}, "requests": []}

    def handler(request: httpx.Request) -> httpx.Response:
        q = dict(request.url.params)
        state["requests"].append({**q, "client": request.headers.get("client-id")})
        key = (q.get("short_name"), q.get("version"))
        r = state["responses"].get(key)
        if r is None:
            return httpx.Response(200, json={"feed": {"entry": []}})
        if isinstance(r, int):
            return httpx.Response(r, text="boom")
        return httpx.Response(200, json={"feed": {"entry": r}})

    monkeypatch.setattr(fhttp, "_transport", httpx.MockTransport(handler))
    monkeypatch.setattr(fhttp, "BACKOFF_BASE_S", 0.001)
    monkeypatch.setattr(overpass, "_limiter", fhttp.RateLimiter(1000, 1.0, "test"))
    return state


def test_fetch_passes_nrt_and_errors(tmp_data_dir, cmr) -> None:
    cmr["responses"][("VJ214IMG_NRT", "2")] = [_entry(T0, "DAY", T0 + H), _entry(T0 + 10 * H, "NIGHT", T0 + 11 * H)]
    cmr["responses"][("MOD14", "6.1NRT")] = [_entry(T0 + 5 * H, "DAY", T0 + 6 * H, minutes=5)]
    cmr["responses"][("VNP14IMG_NRT", "2")] = 500                      # one product fails: listed, the rest still used
    out = overpass.fetch_passes(-117.41, 33.34, T0 - H, T0 + 12 * H, nrt=True)
    assert [(q.satellite, q.t_ms) for q in out] == [("N21", T0 + 10 * H), ("Terra", T0 + 5 * H), ("N21", T0)]
    assert len(out.errors) == 1 and "VNP14IMG_NRT" in out.errors[0] and not out.complete
    req = cmr["requests"]
    assert {r["short_name"] for r in req} >= {"VNP14IMG_NRT", "VJ114IMG_NRT", "VJ214IMG_NRT", "MOD14", "MYD14"}
    r0 = next(r for r in req if r["short_name"] == "VJ214IMG_NRT")
    assert r0["point"] == "-117.41000,33.34000" and r0["version"] == "2" and r0["sort_key"] == "-start_date"
    assert r0["temporal"].startswith(overpass._iso(T0 - H)) and r0["client"] == "fire3d"
    assert "VJ214IMG_NRT v2" in out.source and out.fetched_ms is not None


def test_fetch_passes_archive_and_satellite_filter(tmp_data_dir, cmr) -> None:
    cmr["responses"][("VJ114IMG", "002")] = [_entry(T0, "DAY")]
    out = overpass.fetch_passes(-118.0, 34.0, T0 - H, T0 + H, nrt=False, satellites=["N20"])
    assert [q.product for q in out] == ["VJ114IMG v002"] and out.complete
    assert [r["short_name"] for r in cmr["requests"]] == ["VJ114IMG"]


def test_fetch_passes_offline_never_raises(tmp_data_dir) -> None:
    # the autouse offline transport raises inside httpx: every product is an error, nothing propagates
    out = overpass.fetch_passes(-118.0, 34.0, T0, T0 + H)
    assert len(out) == 0 and len(out.errors) == len(overpass.PRODUCTS) and not out.complete
    assert "network access in tests" in out.errors[0]
    assert all("skipped, NASA CMR unreachable" in e for e in out.errors[1:])    # an outage costs one timeout
    assert overpass.fetch_passes(-118.0, 34.0, T0 + H, T0).errors == ["empty time window"]


def test_iso_parsing() -> None:
    assert overpass.iso_to_ms("2026-10-17T21:24:00.000Z") == 1792272240000
    assert overpass.iso_to_ms("2026-10-17T21:24:00") == 1792272240000   # naive -> UTC
    assert overpass.iso_to_ms("nope") is None and overpass.iso_to_ms(None) is None
    assert json.dumps(overpass.Pass(T0, T0, "N", "VIIRS", "x", "D", None, "p").as_dict())
