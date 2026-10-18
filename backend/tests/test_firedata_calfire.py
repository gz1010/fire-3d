"""sources/calfire.py: record cleaning, caching and stale-if-error (offline, recorded CAL FIRE rows)."""

from __future__ import annotations

import json
from pathlib import Path

import httpx
import pytest

import fire3d.http as fhttp
from fire3d import config
from fire3d.sources import calfire
from fire3d.timeutil import iso_to_ms

DATA = Path(__file__).parent / "data" / "firedata"
LIVE = json.loads((DATA / "calfire_live.json").read_text())
Y2025 = json.loads((DATA / "calfire_2025.json").read_text())


@pytest.fixture
def server(monkeypatch: pytest.MonkeyPatch, tmp_data_dir: Path):
    monkeypatch.setattr(fhttp, "BACKOFF_BASE_S", 0.001)
    state = {"calls": [], "mode": "ok"}

    def handler(request: httpx.Request) -> httpx.Response:
        state["calls"].append(str(request.url))
        if state["mode"] == "down":
            return httpx.Response(503)
        if state["mode"] == "html":
            return httpx.Response(200, text="<html>maintenance</html>", headers={"content-type": "text/html"})
        q = dict(request.url.params)
        return httpx.Response(200, json=LIVE if q.get("inactive") == "false" else Y2025)

    monkeypatch.setattr(fhttp, "_transport", httpx.MockTransport(handler))
    return state


def test_normalize_incident() -> None:
    raw = dict(LIVE[0], PercentContained=None, Latitude=0, Longitude=0)
    r = calfire.normalize_incident(raw)
    assert r["Name"] == r["name"] == "Timber Fire"                     # trailing space removed
    assert r["uid"] == "b7e4a30e-67ab-4964-882e-751da30b44e0" and r["type"] == "Wildfire"
    assert r["started_ms"] == iso_to_ms("2026-08-09T03:35:00Z") and r["year"] == 2026
    assert r["extinguished_ms"] is None and r["percent_contained"] is None
    assert r["lat"] is None and r["lon"] is None                       # 0/0 is "no location"
    assert r["acres"] == 25351.9 and r["is_active"] is True and r["county"] == "Monterey"
    assert r["AdminUnit"] == r["admin_unit"]
    e = calfire.normalize_incident(Y2025[1])
    assert e["name"] == "Eaton Fire" and e["extinguished_ms"] == iso_to_ms("2025-01-31T18:48:42Z")
    assert e["lat"] == 34.203483 and e["year"] == 2025 and not e["is_active"]


def test_clean_name_and_times() -> None:
    assert calfire.clean_name("  Orleans   Complex ") == "Orleans Complex"
    assert calfire.parse_time_ms("") is None and calfire.parse_time_ms("not a date") is None
    assert calfire.parse_time_ms("2025-01-08T02:18:00Z") == iso_to_ms("2025-01-08T02:18:00Z")


def test_lists_are_cached_and_refreshable(server) -> None:
    live = calfire.list_live()
    assert [r["name"] for r in live][:2] == ["Timber Fire", "Blue Fire"]
    calfire.list_live()
    assert len(server["calls"]) == 1                                   # served from the 10-min cache
    calfire.list_live(refresh=True)
    assert len(server["calls"]) == 2
    y = calfire.list_year(2025)
    assert "year=2025" in server["calls"][-1] and "inactive=true" in server["calls"][-1] and len(y) == 8


def test_stale_copy_when_calfire_is_down(server, caplog: pytest.LogCaptureFixture) -> None:
    calfire.list_live()
    server["mode"] = "down"
    rows = calfire.list_live(refresh=True)
    assert len(rows) == len(LIVE) and "serving the cached copy" in caplog.text
    with pytest.raises(calfire.CalFireError):
        calfire.list_year(2024)                                        # never cached: nothing to fall back to


def test_html_with_status_200_is_not_cached(server) -> None:
    server["mode"] = "html"
    with pytest.raises(calfire.CalFireError):
        calfire.list_live()
    assert not list((Path(config.CACHE_DIR) / "http").rglob("*.bin"))
    server["mode"] = "ok"
    assert len(calfire.list_live()) == len(LIVE)
