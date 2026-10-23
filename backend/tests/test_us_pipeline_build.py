"""Build anywhere in the lower 48 (CONTRACT 14.2 build gate, 14.9.7 fire-local time, 14.12.1 refresh feed, 14.12.3
LANDFIRE editions, 14.12.5 issuer text, 14.12.6 data source names, 14.12.10 interim live fuel moisture), offline."""

from __future__ import annotations

import warnings
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

with warnings.catch_warnings():
    warnings.simplefilter("ignore")
    from fastapi.testclient import TestClient

from fire3d import bundle, cli, config
from fire3d.build import aoi, pipeline
from fire3d.build import observed as obs
from fire3d.build import weather_bundle as WB
from fire3d.contracts import IncidentSummary
from fire3d.grid import make_aoi
from fire3d.sources import landfire
from fire3d.timeutil import DAY_MS, HOUR_MS, fmt_local, iso_to_ms, local_month, now_ms, zone_of
from fire3d.types import record_issuer_of
from test_pipeline_support import FakeBuild, make_summary

WFIGS_ID = "2024-horse-gulch-889237"
AK_ID = "2025-alaska-fire-0a1b2c"
CA_ID = "2025-test-fire-abc123"
MT_IRWIN = "889237AB-0000-4000-8000-000000000000"


def wfigs_summary(iid: str = WFIGS_ID, *, state: str = "MT", lat: float = 46.08, lon: float = -111.47,
                  tz: str = "America/Denver", mode: str = "historical", started: str = "2024-07-20T20:00:00Z",
                  issuer: str = "USFS via NIFC WFIGS") -> IncidentSummary:
    base = make_summary(iid, mode, name="Horse Gulch Fire", lat=lat, lon=lon, acres=8000.0,
                        started_ms=iso_to_ms(started))
    return base.model_copy(update={"calfire_uid": "", "record_source": "wfigs", "record_issuer": issuer, "agency": None,
                                   "state": state, "time_zone": tz, "irwin_id": MT_IRWIN, "agency_code": "USFS",
                                   "uid": MT_IRWIN, "year": int(iid[:4])})


@pytest.fixture
def fake(tmp_data_dir, monkeypatch) -> FakeBuild:
    fb = FakeBuild([make_summary(CA_ID, "historical"), wfigs_summary(),
                    wfigs_summary(AK_ID, state="AK", lat=64.8, lon=-147.7, tz="America/Anchorage",
                                  started="2025-06-20T20:00:00Z", issuer="BLM via NIFC WFIGS"),
                    wfigs_summary("2023-old-fire-0b1c2d", started="2023-08-01T20:00:00Z")])
    return fb.install(monkeypatch)


# ----------------------------------------------------------------------------------------------------------------
# Build gate (14.2)
# ----------------------------------------------------------------------------------------------------------------
def test_wfigs_id_is_buildable(fake) -> None:
    s = fake.summaries[WFIGS_ID]
    assert pipeline.is_catalog_incident(WFIGS_ID, s) and pipeline.is_catalog_incident(WFIGS_ID, s.model_dump())
    m = pipeline.build_incident(WFIGS_ID)
    assert m.status == "ready" and m.fuels_edition == "LF2023"                  # FY2024 fire -> LF2023
    names = [d.name for d in m.data_sources]
    assert names[0] == "NIFC WFIGS incident record (IRWIN)" and "CAL FIRE incidents" not in names
    assert MT_IRWIN in m.data_sources[0].detail and "USFS via NIFC WFIGS" in m.data_sources[0].detail
    raw = (bundle.bundle_dir(WFIGS_ID) / "manifest.json").read_text()
    assert "CAL FIRE" not in raw
    ca = pipeline.build_incident(CA_ID)
    assert [d.name for d in ca.data_sources][0] == "CAL FIRE incidents" and ca.fuels_edition == "LF2024"


def test_bundle_only_id_is_refused_with_409(fake) -> None:
    pipeline.build_incident(WFIGS_ID)
    fake.summaries["fixture-east"] = wfigs_summary("2025-black-cove-95c3c8").model_copy(update={"id": "fixture-east"})
    with pytest.raises(pipeline.BuildRefused) as ei:
        pipeline.build_incident("fixture-east", force=True)
    assert ei.value.status == 409
    assert str(ei.value) == "'fixture-east' is a local or synthetic bundle; it cannot be rebuilt."
    assert "CAL FIRE catalog" not in str(ei.value)
    with pytest.raises(pipeline.BuildRefused) as ei:
        pipeline.build_incident("2025-nobody-fire-000000")
    assert ei.value.status == 404
    # listed under another id (an alias)
    fake.summaries["2024-horse-gulch-aaaaaa"] = fake.summaries[WFIGS_ID]
    with pytest.raises(pipeline.BuildRefused) as ei:
        pipeline.build_incident("2024-horse-gulch-aaaaaa")
    assert ei.value.status == 409 and "is listed as" in str(ei.value)


def test_alaska_is_refused_with_422_by_the_cli_and_the_api(fake, capsys) -> None:
    with pytest.raises(pipeline.BuildRefused) as ei:
        pipeline.build_incident(AK_ID)
    assert ei.value.status == 422 and str(ei.value) == "Fire-3d does not support Alaska, Hawaii or US territories yet."
    assert cli.main(["build", AK_ID]) == 1
    err = capsys.readouterr().err
    assert "Fire-3d does not support Alaska, Hawaii or US territories yet." in err and "422" in err
    assert not (bundle.bundle_dir(AK_ID) / "manifest.json").exists()
    from fire3d.api.app import app

    with TestClient(app) as client:
        r = client.post(f"/api/incidents/{AK_ID}/build")
        assert r.status_code == 422 and r.json()["detail"] == "Fire-3d does not support Alaska, Hawaii or US territories yet."
        r = client.post(f"/api/incidents/{WFIGS_ID}/build")
        assert r.status_code == 200 and r.json()["kind"] == "build"


def test_fire_before_oct_2023_needs_force(fake) -> None:
    with pytest.raises(pipeline.BuildRefused) as ei:
        pipeline.build_incident("2023-old-fire-0b1c2d")
    assert ei.value.status == 422 and "October 2023" in str(ei.value) and "LF2023" in str(ei.value)
    assert pipeline.build_incident("2023-old-fire-0b1c2d", force=True).fuels_edition == "LF2023"


def test_refresh_live_uses_the_national_feed(fake, monkeypatch) -> None:
    from fire3d.sources import firms

    live = wfigs_summary("2026-live-fire-def456", mode="live", started="2026-10-22T10:00:00Z")
    fake.summaries[live.id] = live.model_copy(update={"started_ms": now_ms() - 30 * HOUR_MS, "is_active": True})
    pipeline.build_incident(live.id)
    calls: list[int] = []
    monkeypatch.setattr(firms, "load_live_us", lambda days=7, refresh=False: calls.append(days) or pd.DataFrame(
        {"t_ms": pd.Series([], dtype="int64"), "lat": pd.Series([], dtype="float64"), "lon": pd.Series([], dtype="float64")}))
    monkeypatch.setattr(firms, "load_live_ca", lambda *a, **k: pytest.fail("refresh_live must use load_live_us"))
    assert pipeline.refresh_live(live.id) is False and calls == [2]


# ----------------------------------------------------------------------------------------------------------------
# Fire-local time and issuer text (14.9.7, 14.12.5)
# ----------------------------------------------------------------------------------------------------------------
def test_fmt_local_and_month_follow_the_fire_zone() -> None:
    t = iso_to_ms("2024-07-21T02:30:00Z")
    assert fmt_local(t, "America/Denver") == "Jul 20, 20:30 MDT"
    assert fmt_local(iso_to_ms("2024-01-21T02:30:00Z"), "America/Denver") == "Jan 20, 19:30 MST"
    assert fmt_local(t, "America/New_York", year=True) == "Jul 20, 2024, 22:30 EDT"
    assert fmt_local(t, None) == "Jul 21, 02:30 UTC" and fmt_local(t, "Not/AZone") == "Jul 21, 02:30 UTC"
    edge = iso_to_ms("2025-08-01T03:00:00Z")                 # Jul 31 in Montana, Aug 1 in UTC
    assert local_month(edge, "America/Denver") == 7 and local_month(edge, "UTC") == 8
    assert zone_of({"lon": -111.04, "lat": 45.68}) == "America/Denver"
    assert zone_of({"summary": {"time_zone": "America/Chicago"}}) == "America/Chicago"
    assert zone_of({}) == "UTC"


def test_montana_ignition_and_veto_text_use_mountain_time() -> None:
    started = iso_to_ms("2024-07-20T20:00:00Z")
    empty = pd.DataFrame({"t_ms": pd.Series([], dtype="int64"), "x": [], "z": [], "satellite": [], "instrument": []})
    goes = pd.DataFrame({"t_ms": [started - 3 * HOUR_MS + k * 600_000 for k in range(4)], "x": [0.0] * 4,
                         "z": [0.0] * 4, "satellite": ["G18"] * 4, "frp": [10.0] * 4})
    t, why, *_ = obs.ignition_time(started, started - 6 * HOUR_MS, (0.0, 0.0), goes, empty, started + 5 * HOUR_MS,
                                   issuer="USFS via NIFC WFIGS", tz="America/Denver")
    assert "MDT" in why and "PDT" not in why
    _, why3, *_ = obs.ignition_time(started, started - 6 * HOUR_MS, (0.0, 0.0), empty.assign(frp=[]), empty,
                                    started + 5 * HOUR_MS, issuer="USFS via NIFC WFIGS", tz="America/Denver")
    assert why3 == "USFS via NIFC WFIGS start"
    x, z, rc, where, notes = obs.place_ignition(make_aoi(-111.47, 46.08, None, "historical", acres=500.0)[1], (0.0, 0.0),
                                                np.array([[9000.0, 9000.0]]), np.zeros((4, 4), dtype=bool),
                                                issuer="USFS via NIFC WFIGS")
    assert where == "centroid of the earliest FIRMS detections" and notes[0].startswith("USFS via NIFC WFIGS point is")
    from fire3d.build import live_observation as lo
    note = lo.describe_start({"last_detection_ms": started, "rule": "last_detection"}, started + 5 * HOUR_MS, "America/Denver")
    assert "MDT" in note
    from fire3d.sources import overpass
    assert overpass.pass_time(started, "America/Denver") == "Jul 20 14:00 MDT"


def test_issuer_rule() -> None:
    assert record_issuer_of({"record_issuer": "C&L via NIFC WFIGS"}) == "C&L via NIFC WFIGS"
    assert record_issuer_of({"record_source": "wfigs"}) == "NIFC WFIGS (IRWIN)"
    assert record_issuer_of({"calfire_uid": "abc"}) == "CAL FIRE" and record_issuer_of({}) == "CAL FIRE"
    assert obs.perimeter_identity(wfigs_summary()) == {"record_source": "wfigs", "state": "MT", "irwin_id": MT_IRWIN}
    assert obs.perimeter_identity(make_summary(CA_ID)) == {}


def _all_text(bdir: Path) -> str:
    return "\n".join(p.read_text(errors="replace") for p in bdir.rglob("*.json"))


def test_wfigs_bundle_text_never_says_cal_fire(tmp_data_dir, monkeypatch) -> None:
    from test_observed import Scenario
    from test_weather_bundle import FakeSource

    sc = Scenario().install(monkeypatch)
    seen: dict = {}

    def perims(name, lat, lon, start_ms, end_ms, *, acres=None, contained_ms=None, **ident):
        seen.update(ident)
        return Scenario.fetch_perimeters(sc, name, lat, lon, start_ms, end_ms, acres=acres, contained_ms=contained_ms)

    from fire3d.sources import perimeters as wfigs

    monkeypatch.setattr(wfigs, "fetch_perimeters", perims)
    ctx = sc.context()
    s = ctx.summary.model_copy(update={"calfire_uid": "", "record_source": "wfigs", "record_issuer": "USFS via NIFC WFIGS",
                                       "state": "MT", "time_zone": "America/Denver", "irwin_id": MT_IRWIN,
                                       "percent_contained": 100.0, "agency": None, "agency_code": "USFS",
                                       "uid": MT_IRWIN, "active_sources": []})
    ctx.summary, ctx.time_zone = s, "America/Denver"
    bundle.update_manifest(ctx.bundle_dir, lambda m: m.update(summary=s.model_dump()))
    from fire3d.build.pipeline import incident_record_source

    bundle.update_manifest(ctx.bundle_dir, lambda m: m.update(data_sources=[incident_record_source(s, 1)]))
    obs.build_observed_stats(ctx)
    assert seen == {"record_source": "wfigs", "state": "MT", "irwin_id": MT_IRWIN}
    names = [d["name"] for d in bundle.load_manifest(ctx.bundle_dir)["data_sources"]]
    assert names[0] == "NIFC WFIGS incident record (IRWIN)" and "NIFC WFIGS fire perimeters" in names
    events = bundle.read_json(ctx.bundle_dir / "events.json")["events"]
    ign = next(e for e in events if e["type"] == "ignition")
    assert ign["detail"].startswith("Reported by USFS via NIFC WFIGS ") and ("MDT" in ign["detail"] or "MST" in ign["detail"])
    assert ign["source"].startswith("USFS via NIFC WFIGS")
    monkeypatch.setattr(WB, "water_year_precip", lambda *a: {"precip_mm": 150.0, "from": "x", "to": "y", "days": 9,
                                                             "source": "fake", "fetched_ms": 0, "warnings": []})
    WB.build_weather(ctx, source=FakeSource(ctx.fire_grid))
    m = bundle.load_manifest(ctx.bundle_dir)
    assert WB.INTERIM_LFM_WARNING in m["warnings"]
    text = _all_text(ctx.bundle_dir)
    hits = [text[max(0, i - 160): i + 60] for i in range(len(text)) if text.startswith("CAL FIRE", i)]
    assert hits == [] and "PDT" not in text and "PST" not in text


def test_wfigs_forecast_text_names_the_record_issuer(tmp_data_dir, monkeypatch) -> None:
    from fire3d.build import weather_bundle
    from fire3d.spread import ensemble
    from test_live_forecast import _live_bundle, _members

    monkeypatch.setattr(weather_bundle, "member_weathers", _members([]))
    bdir = _live_bundle(tmp_data_dir / "incidents", t_obs_end_h=18.0, now_h=20.0)
    bundle.update_manifest(bdir, lambda m: m["summary"].update(record_source="wfigs", record_issuer="USFS via NIFC WFIGS",
                                                                time_zone="America/Denver", state="MT"))
    fm = ensemble.run_forecast(bdir, horizon_h=6, workers=1)
    text = " | ".join(fm.warnings)
    assert "USFS via NIFC WFIGS reports 35% containment" in text and "CAL FIRE" not in text
    start_note = next(w for w in fm.warnings if w.startswith("forecast starts"))
    assert ("MDT" in start_note or "MST" in start_note) and "PDT" not in start_note
    assert "CAL FIRE" not in _all_text(bdir)


def test_interim_moisture_note_outside_california_only(tmp_data_dir) -> None:
    from test_weather_bundle import make_ctx

    ctx, _ = make_ctx(tmp_data_dir, "historical", iso_to_ms("2025-07-31T20:00:00Z"))
    man = bundle.load_manifest(ctx.bundle_dir)
    man["summary"] = {"state": "MT", "time_zone": "America/Denver", "record_source": "wfigs"}
    _, _, note = WB.live_moisture_for(ctx.bundle_dir, man, iso_to_ms("2025-08-01T03:00:00Z"), fetch=False)
    assert note.startswith(WB.INTERIM_LFM_NOTE)
    herb, woody, _ = WB.live_moisture_for(ctx.bundle_dir, man, iso_to_ms("2025-08-01T03:00:00Z"), fetch=False)
    from fire3d.spread import moisture

    assert (herb, woody) == moisture.live_fuel_moisture(7)               # July in Montana, not August (UTC)
    man["summary"] = {"state": "CA", "time_zone": "America/Los_Angeles", "calfire_uid": "abc"}
    _, _, note_ca = WB.live_moisture_for(ctx.bundle_dir, man, iso_to_ms("2025-08-01T03:00:00Z"), fetch=False)
    assert not note_ca.startswith("Live fuel moisture: California's seasonal values")


# ----------------------------------------------------------------------------------------------------------------
# LANDFIRE editions (14.12.3)
# ----------------------------------------------------------------------------------------------------------------
@pytest.mark.parametrize("started,mode,edition", [
    ("2023-10-01T00:00:00Z", "historical", "LF2023"), ("2024-07-20T20:00:00Z", "historical", "LF2023"),
    ("2024-10-01T00:00:00Z", "historical", "LF2024"), ("2025-01-08T02:18:00Z", "historical", "LF2024"),
    ("2025-07-02T20:00:00Z", "historical", "LF2024"), ("2025-10-01T00:00:00Z", "historical", "LF2025"),
    ("2026-08-01T00:00:00Z", "historical", "LF2025"), ("2026-10-22T00:00:00Z", "live", "LF2025"),
])
def test_edition_for(started: str, mode: str, edition: str) -> None:
    assert landfire.edition_for(mode, iso_to_ms(started)) == edition
    assert landfire.has_prefire_edition(iso_to_ms(started))


def test_no_forward_fallback_and_older_editions() -> None:
    assert landfire.older_edition("LF2025") == "LF2024" and landfire.older_edition("LF2024") == "LF2023"
    assert landfire.older_edition("LF2023") is None
    assert not landfire.has_prefire_edition(iso_to_ms("2023-09-30T12:00:00Z"))
    assert landfire.service_url("LF2023", "FBFM40").endswith("/Landfire_LF2023/LF2023_FBFM40_CONUS/ImageServer/exportImage")


def test_fetch_fuels_falls_back_to_the_older_edition_only(monkeypatch) -> None:
    from fire3d.sources.terrain import FetchInfo, RasterFetchError

    _, fire = make_aoi(-82.3, 35.29, None, "historical", acres=1000.0)
    asked: list[str] = []

    def info(grid, edition, layers, seasonal=None):
        asked.append(edition)
        if edition == "LF2024":
            raise RasterFetchError("LF2024 down")
        return ({k: np.full(fire.shape, 102, np.int16) for k in layers},
                {k: FetchInfo("u", 1, False, 0.0) for k in layers}, [])

    monkeypatch.setattr(landfire, "fetch_landfire_info", info)
    monkeypatch.setattr(landfire, "fetch_layer", lambda *a, **k: (_ for _ in ()).throw(RasterFetchError("veg off")))
    monkeypatch.setattr(landfire, "fetch_evt_physiognomy", lambda: (_ for _ in ()).throw(RasterFetchError("x")))
    ff = aoi.fetch_fuels(fire, "LF2024")
    assert asked == ["LF2024", "LF2023"] and ff.edition == "LF2023" and "LF2025" not in asked
    asked.clear()
    with pytest.raises(aoi.StaticLayerError):
        monkeypatch.setattr(landfire, "fetch_landfire_info", lambda *a, **k: (_ for _ in ()).throw(RasterFetchError("all down")))
        aoi.fetch_fuels(fire, "LF2023")


def _ff(edition: str, fbfm: np.ndarray) -> aoi.FuelsFetch:
    return aoi.FuelsFetch({"FBFM40": fbfm}, {}, edition, None)


def test_nodata_land_switches_lf2025_to_lf2024_with_the_warning() -> None:
    _, fire = make_aoi(-82.3, 35.29, None, "live", acres=1000.0)
    land = np.ones(fire.shape, dtype=bool)
    south = np.full(fire.shape, 102, np.int16)
    south[: fire.height // 10, :] = landfire.NODATA                        # 10 % of the land: not released
    fetched: list[str] = []

    def fetch(grid, edition, seasonal=None):
        fetched.append(edition)
        return _ff(edition, np.full(fire.shape, 102, np.int16))

    ff, notes = aoi.choose_fuels(fire, _ff("LF2025", south), land, fetch=fetch)
    assert ff.edition == "LF2024" and fetched == ["LF2024"]
    assert notes == ["LANDFIRE 2025 is not released here yet; LANDFIRE 2024 used"]


def test_coast_and_border_keep_lf2025() -> None:
    _, fire = make_aoi(-118.54, 34.07, None, "live", acres=1000.0)
    coast = np.full(fire.shape, 102, np.int16)
    coast[:, : fire.width // 3] = landfire.NODATA                          # a third is sea: NoData, not land
    land = np.ones(fire.shape, dtype=bool)
    land[:, : fire.width // 3] = False
    land[0, fire.width // 3 - 1] = True                                    # a sliver of polygon over the water
    ff, notes = aoi.choose_fuels(fire, _ff("LF2025", coast), land, fetch=lambda *a: pytest.fail("no switch"))
    assert ff.edition == "LF2025" and notes == []


def test_land_masks_at_the_mexican_border() -> None:
    _, fire = make_aoi(-117.03, 32.55, None, "live", acres=3000.0)
    elev = np.full(fire.shape, 120.0, np.float32)
    land, abroad = aoi.land_masks(fire, elev)
    assert land.any() and abroad.any() and not (land & abroad).any()
    sea = np.zeros(fire.shape, np.float32)
    land0, abroad0 = aoi.land_masks(fire, sea)
    assert not land0.any() and not abroad0.any()                           # 0 m: sea, neither land nor abroad
    assert landfire.OUTSIDE_COVERAGE == "outside fuel data coverage: not modeled (unknown, not low)"


# ----------------------------------------------------------------------------------------------------------------
# Skill: growth Sørensen (14.12.7, cut-line item d)
# ----------------------------------------------------------------------------------------------------------------
def test_forecast_skill_carries_growth_sorensen(tmp_data_dir, monkeypatch) -> None:
    from fire3d.build import weather_bundle
    from fire3d.contracts import ForecastManifest, contract_problems
    from fire3d.spread import ensemble, validate
    from test_spread_support import ORIGIN, H, make_bundle, make_weather

    bdir = make_bundle(tmp_data_dir / "incidents", iid="growth-test", m=32, ignition_rc=(16, 8))
    monkeypatch.setattr(weather_bundle, "member_weathers",
                        lambda *a, **k: [make_weather(t0=ORIGIN - 72 * H, hours=300, speed_kmh=15.0, label="m")])
    fm = ensemble.run_forecast(bdir, start_ms=ORIGIN + 6 * H, horizon_h=24, workers=1)
    assert fm.skill and all(s.growth_sorensen is not None and 0.0 <= s.growth_sorensen <= 1.0 for s in fm.skill)
    doc = bundle.read_json(bdir / "forecasts" / fm.run_id / "forecast.json")
    assert contract_problems(ForecastManifest, doc) == [] and "growth_sorensen" in doc["skill"][0]
    obs = bundle.read_layer(bdir, "observed_arrival")
    start_h = (fm.start_ms - ORIGIN) / H
    rows = validate.skill_from_arrays(bundle.read_array(bdir, doc["layers"]["arrival_p50"]), obs, start_h, 30.0,
                                      growth=True, horizon_h=24, data_end_h=60.0)
    assert [s.growth_sorensen for s in fm.skill] == [r["sorensen_growth"] for r in rows]
    assert validate.skill_entry({"lead_h": 12.0, "sorensen": 0.5, "observed_acres": 1.0, "forecast_acres_p50": 2.0}) == {
        "lead_h": 12.0, "sorensen": 0.5, "observed_acres": 1.0, "forecast_acres_p50": 2.0}
