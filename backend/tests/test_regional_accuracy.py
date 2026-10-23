"""Per-fire and per-region accuracy (CONTRACT 14.4; docs/validation.md section 10): mean of fire means, status rule,
the JSON schema of ``fire3d/data/regional_accuracy.json`` and the committed file itself."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from fire3d.contracts import AccuracyRegionsResponse
from fire3d.spread import validate as V

DATA_FILE = Path(V.__file__).resolve().parents[1] / "data" / "regional_accuracy.json"


def _rows(scores: list[float], leads=(12, 24, 48, 72), ratio: float = 2.0) -> list[dict]:
    out = []
    for i, s in enumerate(scores):
        lead = leads[i % len(leads)]
        out.append({"lead_h": float(lead), "sorensen": 0.8, "sorensen_growth": s, "observed_growth_acres": 100.0,
                    "forecast_growth_acres": 100.0 * ratio, "area_ratio": ratio, "spread_adjustment": 0.5})
    return out


def _fire(fid: str, region: str, scores: list[float], **kw) -> dict:
    return {"id": fid, "name": fid.title(), "state": kw.pop("state", "MT"), "region": region, "year": kw.pop("year", 2025),
            "rows": _rows(scores, ratio=kw.pop("ratio", 2.0)), "fuels_edition": kw.pop("fuels_edition", "LF2024"),
            "lfm_method": kw.pop("lfm_method", "gsi_nfdrs2016"), "era5_hours": 0, "gfs_fill_hours": 0,
            "weather_source": "open-meteo:historical-forecast:gfs_hrrr", "replaced": None, **kw}


def test_status_rule() -> None:
    assert V.region_status(0, 0) == "untested"
    assert V.region_status(1, 12) == "limited"
    assert V.region_status(1, 40) == "limited"                 # one fire is never a regional score
    assert V.region_status(2, 12) == "limited"                 # 2 fires under 16 leads
    assert V.region_status(2, 16) == "tested"
    assert V.region_status(3, 32) == "tested"


def test_mean_of_fire_means_not_pooled() -> None:
    # fire A: 4 leads at 0.2; fire B: 12 leads at 0.6 -> mean of fire means 0.4, pooled 0.5
    r = V.region_accuracy("NRCC", "Northern Rockies", [_fire("a", "NRCC", [0.2] * 4), _fire("b", "NRCC", [0.6] * 12)])
    assert r["growth_sorensen"] == pytest.approx(0.4) and r["pooled_leads"] == pytest.approx(0.5)
    assert r["range"] == [0.2, 0.6] and r["n_fires"] == 2 and r["n_leads"] == 16 and r["status"] == "tested"
    assert r["fires"][0]["growth_sorensen"] == pytest.approx(0.2) and r["fires"][1]["n_leads"] == 12
    assert set(r["by_lead"]) == {"12", "24", "48", "72"} and r["in_sample"] is False


def test_by_lead_keys_and_ratio_median() -> None:
    a = _fire("a", "SWCC", [0.1, 0.2, 0.3, 0.4], ratio=1.5)
    b = _fire("b", "SWCC", [0.3, 0.4, 0.5, 0.6], ratio=3.0)
    r = V.region_accuracy("SWCC", "Southwest", [a, b])
    assert r["by_lead"] == {"12": 0.2, "24": 0.3, "48": 0.4, "72": 0.5}
    assert r["growth_ratio_median"] == pytest.approx(2.25)
    assert r["status"] == "limited"                            # 2 fires, 8 leads


def test_limited_with_one_fire_and_untested_with_none() -> None:
    r = V.region_accuracy("NWCC", "Northwest", [_fire("a", "NWCC", [0.4] * 12)])
    assert r["status"] == "limited" and r["n_fires"] == 1 and r["growth_sorensen"] == pytest.approx(0.4)
    r = V.region_accuracy("RMCC", "Rocky Mountain", [])
    assert r == {"id": "RMCC", "name": "Rocky Mountain", "status": "untested", "n_fires": 0}
    r = V.region_accuracy("NWCC", "Northwest", [_fire("a", "NWCC", [])])          # a fire with no scored lead
    assert r["status"] == "untested" and r["n_fires"] == 0


def test_ignition_relative_and_metadata() -> None:
    a = _fire("a", "SACC-SE", [0.4] * 12, ignition_rows=_rows([0.1] * 12), fuel_groups=["timber"], year=2025,
              caveats=["timed by VIIRS"])
    b = _fire("b", "SACC-SE", [0.2] * 12, ignition_rows=_rows([0.3] * 8), fuel_groups=["grass", "timber"], year=2024,
              fuels_edition="LF2023")
    r = V.region_accuracy("SACC-SE", "Southeast", [a, b], caveats=["small sample"])
    assert r["ignition_relative"] == pytest.approx(0.2)
    assert r["years"] == [2024, 2025] and r["fuels_editions"] == ["LF2023", "LF2024"]
    assert r["fuel_groups_tested"] == ["grass", "timber"] and r["lfm_method"] == "gsi_nfdrs2016"
    assert r["caveats"] == ["small sample", "timed by VIIRS"]
    assert r["fires"][0]["weather_source"] == "open-meteo:historical-forecast:gfs_hrrr" and r["fires"][0]["era5_hours"] == 0


def test_regional_file_schema_ten_regions_no_seed() -> None:
    fires = [_fire("e", "NWCC", [0.4] * 12), _fire("l", "NWCC", [0.3] * 12),
             _fire("ca1", "OSCC", [0.5] * 12, state="CA", lfm_method="ca_month_table_drought"),
             _fire("ca2", "OSCC", [0.4] * 8, state="CA", lfm_method="ca_month_table_drought"),
             _fire("ca3", "OSCC", [0.45] * 12, state="CA", lfm_method="ca_month_table_drought")]
    doc = V.regional_accuracy(fires, generated_ms=1, engine="pyretechnics x", settings="config.FORECAST_* @ abc")
    assert [r["id"] for r in doc["regions"]] == [rid for rid, _ in V.ACCURACY_REGIONS] and len(doc["regions"]) == 10
    by = {r["id"]: r for r in doc["regions"]}
    assert by["OSCC"]["in_sample"] is True and by["NWCC"]["in_sample"] is False
    assert by["RMCC"]["status"] == "untested" and by["NWCC"]["status"] == "tested"
    assert "seed" not in json.dumps(doc)
    AccuracyRegionsResponse.model_validate({**doc, "served_ms": 2})              # the contract schema
    with pytest.raises(ValueError, match="unknown accuracy region"):
        V.regional_accuracy([_fire("x", "XXCC", [0.1])], generated_ms=1, engine="e", settings="s")


def test_regional_cli_writes_the_file(tmp_path: Path) -> None:
    spec = {"fires": [_fire("e", "NWCC", [0.4] * 12)], "generated_ms": 5, "engine": "e", "settings": "s",
            "region_caveats": {"NWCC": ["timber only"]}}
    src = tmp_path / "fires.json"
    src.write_text(json.dumps(spec))
    out = tmp_path / "regional_accuracy.json"
    assert V.main(["regional", str(src), "--out", str(out)]) == 0
    doc = json.loads(out.read_text())
    assert doc["generated_ms"] == 5 and doc["regions"][0]["caveats"] == ["timber only"]


def test_iso_starts() -> None:
    assert V._iso_ms("2025-08-25T19:30Z") == 1756150200000
    assert V._iso_ms("2025-05-13T23:47:56Z") == V._iso_ms("2025-05-13T23:47:56+00:00")


def test_committed_file_follows_the_contract() -> None:
    doc = json.loads(DATA_FILE.read_text())
    AccuracyRegionsResponse.model_validate({**doc, "served_ms": 0})
    ids = [r["id"] for r in doc["regions"]]
    assert sorted(ids) == sorted(rid for rid, _ in V.ACCURACY_REGIONS)
    for r in doc["regions"]:
        assert r["status"] == V.region_status(r.get("n_fires", 0), r.get("n_leads", 0) or 0)
        for f in r.get("fires") or []:
            assert f["era5_hours"] == 0
        if r["status"] == "tested":
            assert r["n_fires"] >= 2 and r["n_leads"] >= 16
