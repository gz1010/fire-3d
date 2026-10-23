"""fixture-east (CONTRACT 14.12.9): the scenario's identity, and the bundle on disk when it was made
(``uv run python scripts/make_fixture.py --only east``; skipped otherwise)."""

from __future__ import annotations

import importlib.util
import json
import sys

import pytest
from fastapi.testclient import TestClient

from fire3d import config
from fire3d.contracts import IncidentManifest, IncidentSummary, contract_problems

SCRIPT = config.REPO_ROOT / "backend" / "scripts" / "make_fixture.py"
EAST = config.REPO_ROOT / "data" / "incidents" / "fixture-east"


@pytest.fixture(autouse=True)
def _no_live_loop(monkeypatch: pytest.MonkeyPatch) -> None:
    """``TestClient(app)`` runs the app's lifespan: never start the live loop (it would auto-build fires)."""
    from fire3d import config as _cfg

    monkeypatch.setattr(_cfg, "LIVE_ENABLED", False)
    monkeypatch.setattr(_cfg, "AUTO_BUILD_LIVE", False)


def _make_fixture_module():
    spec = importlib.util.spec_from_file_location("make_fixture_for_tests", SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = mod
    spec.loader.exec_module(mod)
    return mod


def test_east_scenario_identity() -> None:
    mf = _make_fixture_module()
    sc = mf.east_scenario()
    assert sc.id == "fixture-east" and sc.name == "Fixture East (synthetic)" and sc.mode == "historical"
    assert (sc.center_lat, sc.center_lon) == (35.29, -82.30) and sc.tz == "America/New_York"
    assert sc.calfire_uid == "" and sc.issuer == "NIFC WFIGS (IRWIN)"
    ex = sc.summary_extra
    assert ex["state"] == "NC" and ex["record_source"] == "wfigs" and ex["record_issuer"] == "NIFC WFIGS (IRWIN)"
    assert ex["irwin_id"] is None and ex["time_zone"] == "America/New_York"
    # the default run is unchanged: demo + live keep Pacific time, CAL FIRE text and no explicit brief-3 fields
    for s in (mf.demo_scenario(), mf.live_scenario()):
        assert s.tz == "America/Los_Angeles" and s.issuer == "CAL FIRE" and s.tz_abbr == "PT" and s.summary_extra == {}
    assert mf.utm_epsg_for(sc.center_lon) == 32617


@pytest.mark.skipif(not (EAST / "manifest.json").is_file(), reason="fixture-east not made")
def test_fixture_east_bundle_and_api() -> None:
    m = json.loads((EAST / "manifest.json").read_text())
    assert contract_problems(IncidentManifest, m) == []
    assert m["grid"]["utm_zone"] == 17 and m["grid"]["crs"] == "EPSG:32617"
    s = IncidentSummary.model_validate(m["summary"])
    assert (s.state, s.time_zone, s.irwin_id, s.record_source, s.calfire_uid) == ("NC", "America/New_York", None, "wfigs", "")
    texts = json.dumps(m) + (EAST / "events.json").read_text()
    assert "CAL FIRE" not in texts
    from fire3d.api.app import app

    with TestClient(app) as client:
        r = client.get("/api/incidents/fixture-east")
        assert r.status_code == 200
        body = r.json()
        assert body["summary"]["time_zone"] == "America/New_York" and body["summary"]["state"] == "NC"
        assert body["summary"]["irwin_id"] is None and body["manifest"]["grid"]["utm_zone"] == 17
