"""contracts.py: exact field names, optional-field omission, strict checking, fixture bundles."""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pytest

from fire3d import bundle, config
from fire3d.contracts import (
    Aircraft,
    ContractError,
    DetectionsFile,
    EventsFile,
    ForecastManifest,
    IncidentManifest,
    JobStatus,
    LayerInfo,
    PerimetersFile,
    TimeseriesFile,
    WeatherFile,
    contract_problems,
    dump,
    validate_strict,
)


def test_optional_fields_are_omitted_nullable_kept() -> None:
    li = LayerInfo(file="layers/a.bin", grid="fire", dtype="uint8", width=2, height=2, description="d")
    assert dump(li) == {"file": "layers/a.bin", "grid": "fire", "dtype": "uint8", "width": 2, "height": 2, "description": "d"}
    job = JobStatus(id="j1", kind="forecast", incident_id="i", status="queued", progress=0, step="", message="", created_ms=1, started_ms=None, finished_ms=None, error=None)
    d = dump(job)
    assert d["started_ms"] is None and d["result"] is None and "error" in d


def test_strict_problems() -> None:
    ok = {"file": "a", "grid": "fire", "dtype": "uint8", "description": "d"}
    assert contract_problems(LayerInfo, ok) == []
    assert contract_problems(LayerInfo, {**ok, "extra": 1}) == ["extra: unexpected field"]
    assert contract_problems(LayerInfo, {**ok, "grid": "tile"})
    assert contract_problems(LayerInfo, {**ok, "width": "4"})
    with pytest.raises(ContractError):
        validate_strict(LayerInfo, {**ok, "dtype": "float64"})
    m = validate_strict(LayerInfo, {**ok, "min": np.float32(0.5)})
    assert m.min == 0.5


def test_aircraft_categories() -> None:
    base = dict(hex="a1b2c3", callsign="TNKR911", registration="N612AX", type="DC10", is_fire_aircraft=True, reason="type",
                lat=34.2, lon=-118.0, x=0.0, z=0.0, alt_m=900.0, agl_m=600.0, gs_kt=160.0, track_deg=90.0, seen_s=1.0, on_ground=False)
    for cat in ("airtanker", "helicopter", "air_attack", "lead_plane", "other_fire", "unknown"):
        assert contract_problems(Aircraft, {**base, "category": cat}) == []
    assert contract_problems(Aircraft, {**base, "category": "drone"})


FILES = {
    "manifest.json": IncidentManifest,
    "detections.json": DetectionsFile,
    "perimeters.json": PerimetersFile,
    "timeseries.json": TimeseriesFile,
    "events.json": EventsFile,
    "weather.json": WeatherFile,
}


def _check_bundle(b: Path) -> None:
    for name, model in FILES.items():
        assert contract_problems(model, (b / name).read_bytes()) == [], name
    m = bundle.load_manifest(b)
    for lname, info in m["layers"].items():
        p = b / info["file"]
        assert p.is_file(), lname
        if info["dtype"] != "jpeg":
            n = info["count"] * 6 if info["grid"] == "points" else info["width"] * info["height"]
            assert p.stat().st_size == n * bundle.DTYPES[info["dtype"]].itemsize, lname
    for fs in m["forecasts"]:
        fm = b / fs["file"]
        assert contract_problems(ForecastManifest, fm.read_bytes()) == []
    assert m["layers"]["observed_arrival"]["width"] == m["grid"]["fire"]["width"]
    assert m["layers"]["elevation"]["width"] == m["grid"]["render"]["width"] == config.RENDER_SIZE


def test_fixture_bundle_matches_contracts(fixture_bundle: Path) -> None:
    _check_bundle(fixture_bundle)


def test_fixture_live_bundle_matches_contracts(fixture_live_bundle: Path) -> None:
    _check_bundle(fixture_live_bundle)
    m = bundle.load_manifest(fixture_live_bundle)
    arr = bundle.read_layer(fixture_live_bundle, "observed_arrival", m)
    now_h = (m["time_range"]["now_ms"] - m["time_origin_ms"]) / 3.6e6
    burned = arr[arr < config.NEVER]
    assert burned.size and burned.max() <= now_h + 1e-3          # nothing observed after "now"
