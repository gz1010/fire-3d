"""Smoke test of the documented fixture server (``scripts/serve_fixture.py``, ``./dev.sh --fixture``).

Brief-3 integration review R2: the integration made ``LiveStatus.detections_24h`` and ``IncidentListResponse.sources``
required, and list rows have required ``bbox_lonlat`` since brief 2; the fixture server built both models without
them, so ``/api/incidents`` and ``/api/live/status`` answered 500. This test catches the next required-field change.
"""

from __future__ import annotations

import importlib.util
import shutil
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from fire3d import config
from fire3d.contracts import IncidentListResponse, LiveStatus

SCRIPT = config.REPO_ROOT / "backend" / "scripts" / "serve_fixture.py"


def _load_script():
    spec = importlib.util.spec_from_file_location("serve_fixture_under_test", SCRIPT)
    assert spec is not None and spec.loader is not None
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


@pytest.fixture
def client(tmp_path: Path, fixture_bundle: Path, fixture_live_bundle: Path) -> TestClient:
    """The fixture app over a temp data dir holding only the two synthetic bundles' manifests."""
    for src in (fixture_bundle, fixture_live_bundle):
        dst = tmp_path / "incidents" / src.name
        dst.mkdir(parents=True)
        shutil.copy(src / "manifest.json", dst / "manifest.json")
    return TestClient(_load_script().create_app(tmp_path))


def test_incident_lists_answer_with_the_required_fields(client: TestClient) -> None:
    for mode in ("historical", "live"):
        r = client.get("/api/incidents", params={"mode": mode})
        assert r.status_code == 200, r.text
        body = r.json()
        IncidentListResponse.model_validate(body)        # every required field is there
        assert body["incidents"], mode
        for row in body["incidents"]:
            assert row["bundle_status"] == "ready"
            bb = row["bbox_lonlat"]
            assert bb is not None and len(bb) == 4 and bb[0] < bb[2] and bb[1] < bb[3]
        # the fixture server never fetches the source lists: both say so in plain words
        assert {s["id"] for s in body["sources"]} == {"calfire", "wfigs"}
        assert all(s["status"] == "unavailable" and s["retrieved_ms"] is None and "Fixture server" in s["reason"] for s in body["sources"])


def test_historical_list_follows_the_year_asked(client: TestClient) -> None:
    demo_year = client.get("/api/incidents", params={"mode": "historical"}).json()["incidents"][0]["year"]
    same = client.get("/api/incidents", params={"mode": "historical", "year": demo_year}).json()
    other = client.get("/api/incidents", params={"mode": "historical", "year": demo_year - 7}).json()
    assert same["year"] == demo_year and len(same["incidents"]) == 1
    assert other["incidents"] == []


def test_live_status_answers_with_the_national_detection_count(client: TestClient) -> None:
    r = client.get("/api/live/status")
    assert r.status_code == 200, r.text
    body = r.json()
    LiveStatus.model_validate(body)
    assert body["active_incidents"] == 1
    assert body["detections_24h"] == body["detections_24h_ca"]
