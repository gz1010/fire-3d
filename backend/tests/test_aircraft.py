"""sources/aircraft.py: SPEC 8.6 classification on crafted adsb.lol samples, geometry (x/z, AGL), fetching."""

from __future__ import annotations

import httpx
import numpy as np
import pytest

import fire3d.http as fhttp
from fire3d import bundle, config
from fire3d.grid import make_aoi, manifest_grid
from fire3d.sources import aircraft as acmod
from fire3d.sources.aircraft import AircraftContext, AircraftUnavailable, classify

LON, LAT = -118.07, 34.20

# Geometry dicts as AircraftContext.geometry() returns them
OVER_FIRE = {"inside_aoi": True, "near_fire": True, "agl_m": 350.0, "alt_m": 1250.0, "ground_m": 900.0, "on_ground": False}
OUTSIDE = {"inside_aoi": False, "near_fire": None, "agl_m": None, "alt_m": 900.0, "ground_m": None, "on_ground": False}
FAR_FROM_BURN = dict(OVER_FIRE, near_fire=False)
HIGH = dict(OVER_FIRE, agl_m=2600.0)


def ac(**kw):
    base = {"hex": "a1b2c3", "type": "adsb_icao", "lat": LAT, "lon": LON, "alt_baro": 4000, "gs": 120.0, "track": 90.0, "seen": 0.4}
    base.update(kw)
    return base


@pytest.fixture(autouse=True)
def _reset_limits():
    acmod.reset_limits()
    yield
    acmod.reset_limits()


# ------------------------------------------------------------------------------------------------ classification
@pytest.mark.parametrize("sample,cat", [
    (ac(flight="TNKR910 ", r="N612AX", t="DC10", category="A5"), "airtanker"),           # 10 Tanker VLAT (heavy category is fine)
    (ac(flight="CFR74   ", r="N439DF", t="S2P", category="A1"), "airtanker"),            # CAL FIRE S-2T as trackers encode it
    (ac(flight="T162", r="N355AC", t="RJ85", category="A3"), "airtanker"),
    (ac(flight="N470NA", r="N470NA", t="B462", category="A3"), "airtanker"),
    (ac(flight="CFR330", r="N422DF", t="OV10", category="A1"), "air_attack"),
    (ac(flight="CFR110", r="N410DF", t="V10", category="A1"), "air_attack"),             # real adsb.fi record, 2026-10-17
    (ac(r="N189AC", t="S64", category="A7"), "helicopter"),
])
def test_known_fire_types(sample, cat):
    category, is_fire, reason = classify(sample, OUTSIDE)
    assert (category, is_fire) == (cat, True)
    assert reason.startswith(f"type {sample['t']}")


def test_calfire_helicopter_by_fleet_registration():
    # S-70i Firehawk: H60 is a shared type (military Black Hawks), so it needs the CAL FIRE N4xxDF registration
    cat, fire, reason = classify(ac(flight="CFR301", r="N481DF", t="H60", category="A7", alt_baro=9500, gs=140), OUTSIDE)
    assert (cat, fire) == ("helicopter", True) and "N481DF" in reason
    # unknown type, rotorcraft emitter category, CAL FIRE registration -> helicopter
    cat, fire, reason = classify(ac(r="N486DF", t="", category="A7"), None)
    assert (cat, fire) == ("helicopter", True) and "fleet registration N486DF" in reason


def test_calfire_callsign_and_operator():
    assert classify(ac(flight="CALFIRE1", t="", category="A1"), None)[:2] == ("other_fire", True)
    cat, fire, reason = classify(ac(flight="CFR205", t="", category="A7"), None)
    assert (cat, fire) == ("helicopter", True) and "callsign CFR205" in reason
    cat, fire, _ = classify(ac(r="N123AB", ownOp="CAL FIRE (California Department of Forestry and Fire Protection)", t="C182"), None)
    assert (cat, fire) == ("other_fire", True)


def test_callsign_prefix_must_end_or_continue_with_digit():
    assert classify(ac(flight="LEAD56", t="", category="A1"), OUTSIDE)[:2] == ("lead_plane", True)
    assert classify(ac(flight="LEADER1", t="", category="A1"), OUTSIDE)[1] is False
    assert classify(ac(flight="HELIX12", t="", category="A7"), OUTSIDE)[1] is False
    assert classify(ac(flight="MAFFS2", t="C130", category="A3"), OUTSIDE)[:2] == ("airtanker", True)


def test_airliner_over_the_fire_is_not_fire_aircraft():
    # United A321neo on approach, low and slow inside the AOI right over the burn: category A3 excludes it
    cat, fire, reason = classify(ac(flight="UAL2494 ", r="N54525", t="A21N", category="A3", alt_baro=3000, gs=160), OVER_FIRE)
    assert (cat, fire) == ("unknown", False) and "airliner" in reason
    # a Boeing 737-300 is a shared type (Coulson FireLiner): an airline flight does not count
    cat, fire, _ = classify(ac(flight="SWA1234", r="N645SW", t="B733", category="A3", alt_baro=31000, gs=440), OUTSIDE)
    assert fire is False


def test_low_slow_general_aviation_over_fire():
    sample = ac(flight="N32169  ", r="N32169", t="C172", category="A1", alt_baro=4200, gs=95.0)
    cat, fire, reason = classify(sample, OVER_FIRE)
    assert (cat, fire) == ("other_fire", True) and reason.startswith("low & slow over fire") and "350 m AGL" in reason
    assert classify(sample, OUTSIDE)[1] is False
    assert "km from the burned area" in classify(sample, FAR_FROM_BURN)[2]
    assert "too high" in classify(sample, HIGH)[2]
    assert "too fast" in classify(dict(sample, gs=300.0), OVER_FIRE)[2]
    assert classify(dict(sample, alt_baro="ground"), dict(OVER_FIRE, on_ground=True))[1] is False
    assert classify(dict(sample, category="C1"), OVER_FIRE)[1] is False        # surface emergency vehicle


def test_shared_types_need_evidence():
    blackhawk = ac(flight="", r="", t="H60", category="A7", alt_baro=6000, gs=130)
    assert classify(blackhawk, OUTSIDE)[1] is False
    cat, fire, reason = classify(blackhawk, OVER_FIRE)
    assert (cat, fire) == ("helicopter", True) and "low & slow" in reason
    king_air = ac(flight="N156Z", r="N156Z", t="BE20", category="A2", alt_baro=25000, gs=280)
    assert classify(king_air, OUTSIDE)[1] is False                              # USFS reg is a weak pattern
    assert classify(dict(king_air, gs=150.0), OVER_FIRE)[:2] == ("lead_plane", True)
    assert classify(ac(r="N148Z", t="", category="A1", gs=120.0), OVER_FIRE)[:2] == ("other_fire", True)


def test_non_fire_evidence_vetoes_low_and_slow_only():
    # news / police / air-ambulance helicopters over the fire: low & slow alone no longer makes them fire aircraft
    news = ac(flight="N8TV", r="N8TV", t="AS50", category="A7", ownOp="KTTV FOX TELEVISION STATIONS", gs=60.0)
    cat, fire, reason = classify(news, OVER_FIRE)
    assert (cat, fire) == ("unknown", False) and "news media" in reason and "low & slow" in reason
    assert classify(ac(flight="MERCY12", t="EC35", category="A7", gs=110.0), OVER_FIRE)[1] is False
    assert classify(ac(t="", category="A7", ownOp="LOS ANGELES COUNTY SHERIFF'S DEPT", gs=70.0), OVER_FIRE)[1] is False
    assert classify(ac(t="", category="B4", gs=40.0), OVER_FIRE)[1] is False          # ultralight
    assert classify(ac(flight="RCH871", t="C17", category="A5", gs=200.0), OUTSIDE)[1] is False
    # ... but strong evidence still wins: a fire type, a fleet registration, a fire callsign
    assert classify(ac(flight="NEWS1", t="S64", category="A7"), OVER_FIRE)[:2] == ("helicopter", True)
    assert classify(ac(r="N481DF", t="H60", category="A7", ownOp="AIR METHODS"), OVER_FIRE)[:2] == ("helicopter", True)
    # without veto evidence the SPEC proximity rule is unchanged
    assert classify(ac(flight="N123AB", t="AS50", category="A7", gs=60.0), OVER_FIRE)[:2] == ("helicopter", True)


def test_firefighting_squawk_is_strong_evidence():
    cat, fire, reason = classify(ac(t="", category="A7", squawk="1255", alt_baro=9000, gs=120.0), OUTSIDE)
    assert (cat, fire) == ("helicopter", True) and "1255" in reason
    cat, fire, reason = classify(ac(t="BE20", category="A2", squawk="1255", gs=200.0), OUTSIDE)
    assert (cat, fire) == ("lead_plane", True) and "squawk 1255" in reason
    assert classify(ac(t="", category="A1", squawk="1200", gs=120.0), OUTSIDE)[1] is False


def test_no_context_disables_the_proximity_rule():
    assert classify(ac(t="C172", category="A1", gs=90.0), None)[:2] == ("unknown", False)


# ------------------------------------------------------------------------------------------------ geometry
def _context(tmp_path, *, burned_radius_m: float | None = 800.0) -> AircraftContext:
    render, fire = make_aoi(LON, LAT, None, "live", acres=500.0)
    X, Z = render.cell_centers_local()
    dem = (1000.0 + 0.01 * X).astype(np.float32)                 # 1000 m at the centre, rising eastward
    bdir = tmp_path / "incidents" / "2026-geom-fire-000000"
    m = {"id": "2026-geom-fire-000000", "grid": manifest_grid(render, fire, float(dem.min()), float(dem.max())), "layers": {}}
    bundle.save_manifest(bdir, m)
    bundle.write_layer(bdir, "elevation", dem, "render", "m", "test")
    FX, FZ = fire.cell_centers_local()
    arr = np.full(fire.shape, config.NEVER, np.float32)
    if burned_radius_m:
        arr[np.hypot(FX, FZ) <= burned_radius_m] = 5.0
    bundle.write_layer(bdir, "observed_arrival", arr, "fire", "h", "test")
    return AircraftContext.from_bundle(bdir, bundle.load_manifest(bdir))


def test_geometry_local_coords_and_agl(tmp_path):
    ctx = _context(tmp_path)
    lon0, lat0 = ctx.center_lonlat()
    g = ctx.geometry(ac(lat=lat0, lon=lon0, alt_baro=4000, alt_geom=None))
    assert abs(g["x"]) < 1.0 and abs(g["z"]) < 1.0 and g["inside_aoi"] and g["near_fire"] is True
    assert g["alt_m"] == pytest.approx(4000 * 0.3048)
    assert g["agl_m"] == pytest.approx(4000 * 0.3048 - 1000.0, abs=1.0)
    # ~3 km north: z negative (south is +z), still inside the AOI but > 2 km from the 800 m burn -> not near
    north = ctx.geometry(ac(lat=lat0 + 3000 / 111_320, lon=lon0))
    assert north["z"] == pytest.approx(-3000, abs=25) and abs(north["x"]) < 60 and north["near_fire"] is True   # UTM grid convergence
    far = ctx.geometry(ac(lat=lat0 + 7000 / 111_320, lon=lon0))
    assert far["inside_aoi"] and far["near_fire"] is False
    outside = ctx.geometry(ac(lat=lat0 + 0.5, lon=lon0))
    assert outside["inside_aoi"] is False and outside["agl_m"] is None


def test_altitude_parsing():
    assert acmod.altitude_msl_m({"alt_baro": "ground"}) is None and acmod.is_on_ground({"alt_baro": "ground"})
    # GNSS height above the ellipsoid -> MSL with the California geoid (N = -33 m)
    assert acmod.altitude_msl_m({"alt_baro": 1000, "alt_geom": 1100}) == pytest.approx(1100 * 0.3048 + 33.0)
    # pressure altitude corrected with the reported QNH (+10 hPa ~ +84 m)
    assert acmod.altitude_msl_m({"alt_baro": 1000, "nav_qnh": 1023.25}) == pytest.approx(304.8 + 84.3, abs=0.1)
    assert acmod.altitude_msl_m({"alt_baro": None}) is None
    assert acmod.track_deg({"true_heading": 370.0}) == pytest.approx(10.0) and acmod.track_deg({}) is None


def test_to_aircraft_on_ground_and_last_position(tmp_path):
    ctx = _context(tmp_path)
    lon0, lat0 = ctx.center_lonlat()
    a = acmod.to_aircraft(ac(hex="ABC123", flight="CFR74 ", r="N439DF", t="s2p", alt_baro="ground", gs=0.0, lat=lat0, lon=lon0, seen_pos=1.26), ctx)
    assert a is not None and a.hex == "abc123" and a.callsign == "CFR74" and a.type == "S2P"
    assert a.on_ground and a.agl_m == 0.0 and a.alt_m == pytest.approx(1000.0, abs=1.0)
    assert a.category == "airtanker" and a.is_fire_aircraft and a.seen_s == 1.3
    stale = ac(hex="def456", r="N481DF", t="H60", category="A7")
    del stale["lat"], stale["lon"]
    stale["lastPosition"] = {"lat": lat0, "lon": lon0, "seen_pos": 42.0}
    b = acmod.to_aircraft(stale, ctx)
    assert b is not None and b.seen_s == 42.0 and abs(b.x) < 1
    nopos = ac(hex="aaa111")
    del nopos["lat"]
    assert acmod.to_aircraft(nopos, ctx) is None
    assert acmod.to_aircraft(ac(hex=""), ctx) is None


def test_aircraft_list_filters_sorts_and_dedupes(tmp_path):
    ctx = _context(tmp_path)
    lon0, lat0 = ctx.center_lonlat()
    raw = [
        ac(hex="000001", flight="UAL1", t="A21N", category="A3", lat=lat0, lon=lon0, alt_baro=3500, gs=150),
        ac(hex="000002", flight="N5512Q", t="C172", category="A1", lat=lat0, lon=lon0, alt_baro=4000, gs=90),
        ac(hex="000003", flight="TNKR911", r="N17085", t="DC10", category="A5", lat=lat0, lon=lon0),
        ac(hex="000003", flight="TNKR911", r="N17085", t="DC10", category="A5", lat=lat0, lon=lon0),
        ac(hex="000004", r="N486DF", t="H60", category="A7", lat=lat0, lon=lon0, alt_baro=2500, gs=60),
        {"hex": "000005", "lat": "bad", "lon": None},
    ]
    fire_only = acmod.aircraft_list(raw, ctx)
    assert [a.hex for a in fire_only] == ["000003", "000004", "000002"]
    assert [a.category for a in fire_only] == ["airtanker", "helicopter", "other_fire"]
    everything = acmod.aircraft_list(raw, ctx, include_all=True)
    assert [a.hex for a in everything][-1] == "000001" and not everything[-1].is_fire_aircraft


def test_context_around_point_without_bundle():
    ctx = AircraftContext.around(LON, LAT, acres=200.0)
    assert ctx.grid.extent_m == config.AOI_MIN_EXTENT_M["live"] and ctx.dem is None
    g = ctx.geometry(ac(lat=LAT, lon=LON, alt_baro=3000))
    assert g["inside_aoi"] and g["agl_m"] is None and g["near_fire"] is None
    # without a DEM the MSL altitude bounds AGL: 914 m MSL < 1500 m -> low & slow
    assert classify(ac(t="C172", category="A1", alt_baro=3000, gs=90), ctx)[1] is True


# ------------------------------------------------------------------------------------------------ fetching
def _transport(handler, counter):
    def wrapped(request: httpx.Request) -> httpx.Response:
        counter.append(str(request.url))
        return handler(request)

    return httpx.MockTransport(wrapped)


def test_fetch_point_parses_response(tmp_data_dir, monkeypatch):
    calls: list[str] = []
    body = {"ac": [ac(hex="abc001", flight="TNKR910", t="DC10"), "junk"], "msg": "No error", "now": 1792201743500, "total": 1}
    monkeypatch.setattr(fhttp, "_transport", _transport(lambda r: httpx.Response(200, json=body), calls))
    raw, now = acmod.fetch_point(LAT, LON, 40)
    assert now == 1792201743500 and [a["hex"] for a in raw] == ["abc001"]
    assert calls == ["https://api.adsb.lol/v2/point/34.2000/-118.0700/40"]
    assert acmod.fetch_aircraft(LAT, LON, 40)[0]["flight"] == "TNKR910"     # served from the 5 s cache
    assert len(calls) == 1


def test_fetch_point_rate_limit_cooldown(tmp_data_dir, monkeypatch):
    calls: list[str] = []
    monkeypatch.setattr(fhttp, "_transport", _transport(lambda r: httpx.Response(429, text="slow down"), calls))
    with pytest.raises(AircraftUnavailable, match="429"):
        acmod.fetch_point(LAT, LON, 40)
    assert len(calls) == 2                                                  # adsb.lol, then the adsb.fi fallback
    with pytest.raises(AircraftUnavailable, match="backing off"):
        acmod.fetch_point(LAT, LON, 40)
    assert len(calls) == 2                                                  # no request during the cooldowns


def test_fetch_point_falls_back_to_adsb_fi(tmp_data_dir, monkeypatch):
    calls: list[str] = []
    body = {"aircraft": [ac(hex="abc002", flight="CFR301", t="H60")], "now": 1792268670.001, "resultCount": 1}

    def handler(r: httpx.Request) -> httpx.Response:
        if r.url.host == "api.adsb.lol":
            raise httpx.ConnectTimeout("timed out", request=r)
        return httpx.Response(200, json=body)

    monkeypatch.setattr(fhttp, "_transport", _transport(handler, calls))
    raw, now = acmod.fetch_point(LAT, LON, 40)
    assert [a["hex"] for a in raw] == ["abc002"] and now == 1792268670001 and acmod.last_source() == "adsb.fi"
    assert calls == ["https://api.adsb.lol/v2/point/34.2000/-118.0700/40",
                     "https://opendata.adsb.fi/api/v2/lat/34.2000/lon/-118.0700/dist/40"]
    acmod.fetch_point(LAT + 1, LON, 40)                                     # adsb.lol is skipped while it is down
    assert calls[2:] == ["https://opendata.adsb.fi/api/v2/lat/35.2000/lon/-118.0700/dist/40"]


def test_fetch_point_budget_and_errors(tmp_data_dir, monkeypatch):
    calls: list[str] = []
    monkeypatch.setattr(config, "AIRCRAFT_MAX_REQUESTS_PER_MIN", 1)
    monkeypatch.setattr(config, "AIRCRAFT_FETCH_TTL_S", 0)
    acmod.reset_limits()
    monkeypatch.setattr(fhttp, "_transport", _transport(lambda r: httpx.Response(200, json={"ac": []}), calls))
    acmod.fetch_point(LAT, LON, 40)
    assert acmod.last_source() == "adsb.lol"
    acmod.fetch_point(LAT + 1, LON, 40)                                     # adsb.lol budget used up -> adsb.fi
    assert acmod.last_source() == "adsb.fi"
    with pytest.raises(AircraftUnavailable, match="budget"):
        acmod.fetch_point(LAT + 2, LON, 40)
    assert len(calls) == 2
    acmod.reset_limits()
    monkeypatch.setattr(fhttp, "_transport", _transport(lambda r: httpx.Response(200, content=b"<html>"), calls))
    with pytest.raises(AircraftUnavailable, match="invalid JSON"):
        acmod.fetch_point(LAT, LON, 40)
    acmod.reset_limits()
    monkeypatch.setattr(fhttp, "_transport", _transport(lambda r: httpx.Response(503), calls))
    with pytest.raises(AircraftUnavailable, match="HTTP 503"):
        acmod.fetch_point(LAT + 3, LON, 40)
    with pytest.raises(AircraftUnavailable, match="unreachable"):             # both providers now skipped for a while
        acmod.fetch_point(LAT + 4, LON, 40)


def test_fetch_point_unexpected_transport_error_is_unavailable(tmp_data_dir, monkeypatch):
    """Any transport failure (not only httpx errors) is an honest 'unavailable', never an exception (API 500)."""
    calls: list[str] = []

    def handler(r: httpx.Request) -> httpx.Response:
        raise RuntimeError("socket layer exploded")

    monkeypatch.setattr(fhttp, "_transport", _transport(handler, calls))
    with pytest.raises(AircraftUnavailable, match="RuntimeError"):
        acmod.fetch_point(LAT, LON, 40)
    assert len(calls) == 2                                                  # both providers tried, both now skipped
    with pytest.raises(AircraftUnavailable, match="unreachable"):
        acmod.fetch_point(LAT, LON, 40)
    assert len(calls) == 2


def test_point_url_radius_bounds():
    assert acmod.point_url(34.123456, -118.5, 0.2).endswith("/1")
    assert acmod.point_url(34.1, -118.5, 999).endswith("/250")
