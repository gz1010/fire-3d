"""backend/scripts/validate_us_fires.py: the pre-registered fires and starts (docs/validation.md 10.1), fuel families,
the collection into fires.json for ``validate regional``."""

from __future__ import annotations

import importlib.util
import json
import sys
from collections import Counter
from pathlib import Path

import numpy as np
import pytest

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "validate_us_fires.py"


@pytest.fixture(scope="module")
def vf():
    spec = importlib.util.spec_from_file_location("validate_us_fires", SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    sys.modules["validate_us_fires"] = mod                  # dataclasses resolve their module by name
    spec.loader.exec_module(mod)
    return mod


def test_twelve_fires_two_per_region(vf) -> None:
    assert len(vf.FIRES) == 12 and len({f.id for f in vf.FIRES}) == 12
    assert Counter(f.region for f in vf.FIRES) == {r: 2 for r in ("NWCC", "NRCC", "GBCC", "SWCC", "SACC-SP", "SACC-SE")}
    assert all(f.state != "CA" for f in vf.FIRES)
    for f in vf.FIRES:                       # every start is absolute UTC, at or after discovery
        for s in f.main_starts_utc + f.ignition_starts_utc():
            assert s.endswith("Z") and vf.to_ms(s) >= vf.to_ms(f.discovery_utc)


def test_pre_registered_starts(vf) -> None:
    hg = vf.fire_by_id("2024-horse-gulch-889237")
    assert hg.main_starts_utc == ("2024-07-10T01:32Z", "2024-07-10T07:32Z", "2024-07-10T19:32Z")
    assert hg.ignition_starts_utc() == hg.main_starts_utc
    gr = vf.fire_by_id("2025-greer-a746c6")
    assert gr.main_starts_utc[-1] == "2025-05-16T17:47:56Z" and len(gr.main_starts_utc) == 4
    wd = vf.fire_by_id("2024-windy-deuce-b972cf")
    assert wd.main_starts_utc == ("2024-02-27T06:30Z", "2024-02-27T12:30Z", "2024-02-27T18:30Z")
    assert wd.ignition_starts_utc()[0] == "2024-02-27T06:23:16Z"
    assert vf.local_label("2025-05-13T23:47:56Z", "America/Phoenix") == "May 13 16:47 MST"     # no daylight time
    assert "| 12 | Black Cove (NC, SACC-SE)" in vf.starts_markdown()


def test_fuel_families_and_groups(vf) -> None:
    fuel = np.array([[101, 102, 165, 183], [183, 183, 91, 145]])
    burned = np.array([[True, True, True, True], [True, True, True, False]])
    fam = vf.fuel_families(fuel, burned)
    assert fam == {"GR": pytest.approx(2 / 6, abs=1e-3), "TU": pytest.approx(1 / 6, abs=1e-3), "TL": 0.5}
    assert vf.fuel_groups(fam) == ["grass", "timber"]                     # TU 17 % alone would not count; TL does
    assert vf.fuel_groups({"GS": 0.6, "SH": 0.1}) == ["grass", "shrub"]
    assert vf.fuel_groups({}) == []


def test_collect_skips_failed_checks(vf, tmp_path: Path) -> None:
    rows = [{"lead_h": 12.0, "sorensen": 0.8, "sorensen_growth": 0.4, "spread_adjustment": 0.5,
             "observed_growth_acres": 10.0, "forecast_growth_acres": 20.0, "area_ratio": 2.0}]
    for fid in ("2025-emigrant-241e2b", "2025-lower-sugarloaf-569fb7"):
        (tmp_path / f"{fid}.main.json").write_text(json.dumps({"rows": rows}))
    checks = [{"id": "2025-emigrant-241e2b", "ok": True, "fuels_edition": "LF2024", "era5_hours": 0, "gfs_fill_hours": 0,
               "weather_source": "open-meteo:historical-forecast:gfs_hrrr", "fuel_groups": ["timber"],
               "live_fuel_moisture": [{"start": "2025-08-25T19:30Z", "method": "gsi_nfdrs2016"}]},
              {"id": "2025-lower-sugarloaf-569fb7", "ok": False}]
    spec = vf.collect(tmp_path, checks, {})
    assert [f["id"] for f in spec["fires"]] == ["2025-emigrant-241e2b"]
    f = spec["fires"][0]
    assert f["lfm_method"] == "gsi_nfdrs2016" and f["region"] == "NWCC" and f["year"] == 2025 and f["replaced"] is None
    assert spec["region_caveats"]["NWCC"][0].startswith("Two fires") and spec["in_sample_regions"] == ["OSCC"]
