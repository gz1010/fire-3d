"""api/extras.py: evacuation zones, cameras and recent imagery (offline; trimmed real responses recorded 2026-10-17).

Upstream calls go through fire3d.http, whose transport is replaced by an httpx.MockTransport router here (the
autouse conftest guard refuses any real network access).
"""

from __future__ import annotations

import io
import time
import warnings
from pathlib import Path
from typing import Callable

import httpx
import numpy as np
import orjson
import pytest
from fastapi import FastAPI

with warnings.catch_warnings():     # the installed Starlette deprecates httpx in its TestClient (not our code)
    warnings.simplefilter("ignore")
    from fastapi.testclient import TestClient

import fire3d.catalog as catalog
import fire3d.http as fhttp
from fire3d import config
from fire3d.api import extras as ex
from fire3d.timeutil import DAY_MS, HOUR_MS

# ----------------------------------------------------------------------------------------------------------------
# Recorded samples (trimmed real responses, 2026-10-17)
# ----------------------------------------------------------------------------------------------------------------
NOW = 1792268900000      # 2026-10-17T20:28:20Z

EVAC_FEATURES = [
    {"type": "Feature", "id": 1098131, "geometry": {"type": "Polygon", "coordinates": [[[-118.812772, 34.10384], [-118.798423, 34.09908], [-118.793212, 34.03579], [-118.83181, 34.042128], [-118.851014, 34.087134], [-118.812772, 34.10384]]]},
     "properties": {"OBJECTID": 1098131, "COUNTY": "LOS ANGELES", "CITY": "KAN", "ZONE_NAME": None, "ZONE_ID": "US-CA-XLA-KAN-U017", "STATUS": "Evacuation Order", "EVENT_TYPE": None, "CRITICAL_INFO": None, "PUBLIC_INFO": None, "EDIT_DATE": 1792112236000, "STATEWIDE_LAST_UPDATED": None, "NOTES": "Local authorities are responding to a fast-moving Wildfire. An EVACUATION ORDER has been issued. LEAVE NOW. Your safety is in danger if you stay. Call 911 if you need emergency assistance. Visit Alertla.org for more information.", "SHAPE__Area": 62800268.0390625, "SHAPE__Length": 36911.89210608921, "GlobalID": "eeaa7ce6-52b3-4580-bfbc-64e234e2f1ec", "CreationDate": 1792112431851, "Creator": "CalOES_Scripts", "EditDate": 1792112431851, "Editor": "CalOES_Scripts"}},
    {"type": "Feature", "id": 1098137, "geometry": {"type": "Polygon", "coordinates": [[[-118.809146, 34.132073], [-118.85265, 34.113123], [-118.852044, 34.115221], [-118.867959, 34.119699], [-118.821423, 34.131424], [-118.809146, 34.132073]]]},
     "properties": {"OBJECTID": 1098137, "COUNTY": "LOS ANGELES", "CITY": "WLV", "ZONE_NAME": None, "ZONE_ID": "US-CA-XLA-WLV-C201", "STATUS": "Evacuation Warning", "EVENT_TYPE": None, "CRITICAL_INFO": None, "PUBLIC_INFO": None, "EDIT_DATE": 1792112632000, "STATEWIDE_LAST_UPDATED": None, "NOTES": "Local authorities are responding to a Wildfire. An EVACUATION WARNING has been issued. PREPARE TO LEAVE.  Consider leaving now if you need more time to evacuate. Call 911 for emergency assistance. Visit AlertLA.org for more information.", "SHAPE__Area": 10553897.57421875, "SHAPE__Length": 17719.35051415194, "GlobalID": "912a0e02-8130-4c56-a826-d0b383cf329b", "CreationDate": 1792112732471, "Creator": "CalOES_Scripts", "EditDate": 1792112732471, "Editor": "CalOES_Scripts"}},
]
EVAC_LAYER_INFO = {"name": "CA_EVACUATIONS", "geometryType": "esriGeometryPolygon", "maxRecordCount": 2000,
                   "editingInfo": {"lastEditDate": 1792263695245, "schemaLastEditDate": 1792119286908, "dataLastEditDate": 1792263695245}}
INVENTORY_LA = [{"type": "Feature", "id": 19, "geometry": None, "properties": {"CountyName": "Los Angeles", "Source": "Zonehaven", "Reference_App": "https://lacounty.maps.arcgis.com/apps/webappviewer/index.html?id=695f0c805ba046b28c84da79bbf252dc", "DataInUse": "Yes", "DataAcqStatus": "Acquired"}},
                {"type": "Feature", "id": 56, "geometry": None, "properties": {"CountyName": "Ventura", "Source": "County", "Reference_App": "https://vcoes.maps.arcgis.com/apps/View/index.html?appid=24d2d88d701b4eaa8e9fe6e5882c8258", "DataInUse": "Yes", "DataAcqStatus": "Acquired"}}]
INVENTORY_IMPERIAL = [{"type": "Feature", "id": 13, "geometry": None, "properties": {"CountyName": "Imperial", "Source": None, "Reference_App": None, "DataInUse": "No", "DataAcqStatus": "No Data"}}]

WEBCAM_FEATURES = [
    {"type": "Feature", "id": 336, "geometry": {"type": "Point", "coordinates": [-123.2174, 38.948601]}, "properties": {"Location": "Mt. Sanel 1", "Source": "Alert California", "Display_Type": "Picture", "View_Direction": "Pan-Tilt-Zoom", "Webcam_URL": "https://cameras.alertcalifornia.org/?id=Axis-Sanel1", "Thumbnail_Url": "https://cameras.alertcalifornia.org/public-camera-data/Axis-Sanel1/latest-frame.jpg", "NearBy_Place": None, "County": "mendocino", "Elevation_Ft": None, "CameraType": "\nALERTCalifornia", "View_Degrees": 169.66, "Longitude": None, "Latitude": None}},
    {"type": "Feature", "id": 1395, "geometry": {"type": "Point", "coordinates": [-123.085535999666, 38.9494100002112]}, "properties": {"Location": "US-101: S of Hopland - Looking South", "Source": "CalTrans", "Display_Type": "Picture", "View_Direction": "South", "Webcam_URL": "https://cwwp2.dot.ca.gov/data/d1/cctv/image/us101sofhoplandlookings/us101sofhoplandlookings.jpg", "Thumbnail_Url": "https://cwwp2.dot.ca.gov/data/d1/cctv/image/us101sofhoplandlookings/us101sofhoplandlookings.jpg", "NearBy_Place": "Hopland", "County": "Mendocino", "Elevation_Ft": 100, "CameraType": "Traffic", "View_Degrees": None, "Longitude": -123.085536, "Latitude": 38.94941}},
    {"type": "Feature", "id": 4001, "geometry": {"type": "Point", "coordinates": [-120.2, 39.2]}, "properties": {"Location": "Alpine Meadows CTC", "Source": "Alert Wildfire", "Display_Type": "Picture", "View_Direction": None, "Webcam_URL": "https://alertwildfire.org/?currentFirecam=ca-alpine-meadows-ctc-1&viewMode=Grid\n", "Thumbnail_Url": "http://api.nvseismolab.org/camera/Axis-Alpine", "NearBy_Place": None, "County": "Placer", "Elevation_Ft": None, "CameraType": "Fire", "View_Degrees": None, "Longitude": None, "Latitude": None}},
]
CWWP2_D01 = {"data": [{"cctv": {"index": "224", "recordTimestamp": {"recordDate": "2026-03-12", "recordTime": "09:31:01", "recordEpoch": "1773333061"}, "location": {"district": "1", "locationName": "US-101: S of Hopland - Looking South", "nearbyPlace": "Hopland", "longitude": "-123.085431", "latitude": "38.949302", "elevation": "100", "direction": "South", "county": "Mendocino", "route": "US-101"}, "inService": "true", "imageData": {"imageDescription": "", "streamingVideoURL": "", "static": {"currentImageUpdateFrequency": "10", "currentImageURL": "https://cwwp2.dot.ca.gov/data/d1/cctv/image/us101sofhoplandlookings/us101sofhoplandlookings.jpg", "referenceImageUpdateFrequency": "10"}}}}]}

S2_FEATURES = [
    {"type": "Feature", "id": "S2A_10SDH_20261015_1_L2A", "geometry": {"type": "Polygon", "coordinates": [[[-124.15273968462017, 38.84330116198253], [-124.13716096929272, 37.85395976905534], [-122.88905777402445, 37.85939870863902], [-122.88753750000963, 38.84893533228092], [-124.15273968462017, 38.84330116198253]]]}, "properties": {"datetime": "2026-10-15T19:14:05.791000Z", "created": "2026-10-16T00:49:16.033Z", "eo:cloud_cover": 0.00067, "platform": "sentinel-2a"}, "assets": {"visual": {"href": "https://sentinel-cogs.s3.us-west-2.amazonaws.com/sentinel-s2-l2a-cogs/10/S/DH/2026/10/S2A_10SDH_20261015_1_L2A/TCI.tif"}}},
    {"type": "Feature", "id": "S2C_10SDH_20261013_0_L2A", "geometry": {"type": "Polygon", "coordinates": [[[-124.15273968462017, 38.84330116198253], [-124.13716096929272, 37.85395976905534], [-122.88905777402445, 37.85939870863902], [-122.88753750000963, 38.84893533228092], [-124.15273968462017, 38.84330116198253]]]}, "properties": {"datetime": "2026-10-13T19:13:56.115000Z", "created": "2026-10-13T23:02:48.645Z", "eo:cloud_cover": 0.001208, "platform": "sentinel-2c"}, "assets": {"visual": {"href": "https://sentinel-cogs.s3.us-west-2.amazonaws.com/sentinel-s2-l2a-cogs/10/S/DH/2026/10/S2C_10SDH_20261013_0_L2A/TCI.tif"}}},
    {"type": "Feature", "id": "S2C_10SDJ_20261013_0_L2A", "geometry": {"type": "Polygon", "coordinates": [[[-124.16761290616307, 39.74438631043687], [-124.15132112032015, 38.755202928221415], [-122.88767593356906, 38.760819498079734], [-122.88608605736994, 39.7502030226425], [-124.16761290616307, 39.74438631043687]]]}, "properties": {"datetime": "2026-10-13T19:13:41.676000Z", "created": "2026-10-13T23:04:42.257Z", "eo:cloud_cover": 0.000873, "platform": "sentinel-2c"}, "assets": {"visual": {"href": "https://sentinel-cogs.s3.us-west-2.amazonaws.com/sentinel-s2-l2a-cogs/10/S/DJ/2026/10/S2C_10SDJ_20261013_0_L2A/TCI.tif"}}},
]
HLS_ENTRIES = [
    {"id": "G4342907676-LPCLOUD", "title": "HLS.L30.T10SDH.2026277T185153.v2.0", "time_start": "2026-10-04T18:51:53.583Z", "time_end": "2026-10-04T18:52:17.478Z", "updated": "2026-10-06T00:40:21.991Z", "cloud_cover": "100", "day_night_flag": "DAY", "polygons": [["38.8433101 -124.1527513 37.8539507 -124.1371722 37.8593897 -122.8890464 38.8489443 -122.887526 38.8433101 -124.1527513"]]},
    {"id": "G4342932790-LPCLOUD", "title": "HLS.L30.T10SDJ.2026277T185129.v2.0", "time_start": "2026-10-04T18:51:29.696Z", "time_end": "2026-10-04T18:51:53.583Z", "updated": "2026-10-06T00:53:59.879Z", "cloud_cover": "100", "day_night_flag": "DAY", "polygons": [["39.4933275 -124.163413 38.7551938 -124.1513325 38.7608105 -122.8876644 39.750212 -122.8860744 39.7451642 -124.0885053 39.4933275 -124.163413"]]},
]
VIIRS_ENTRIES = [
    {"id": "G4371855283-LAADS", "title": "LAADS:10079092564", "time_start": "2026-10-16T21:00:00.000Z", "time_end": "2026-10-16T21:06:00.000Z", "updated": "2026-10-17T03:14:58.300Z", "day_night_flag": "DAY", "polygons": [["15.403799 -128.782227 19.666225 -100.725952 40.57753 -103.071823 35.415043 -137.163483 15.403799 -128.782227"]]},
    {"id": "G4371863293-LAADS", "title": "LAADS:10079091864", "time_start": "2026-10-16T21:06:00.000Z", "time_end": "2026-10-16T21:12:00.000Z", "updated": "2026-10-17T03:19:43.540Z", "day_night_flag": "DAY", "polygons": [["35.307922 -137.121979 40.462029 -103.085693 61.160896 -102.427872 53.586697 -152.655167 35.307922 -137.121979"]]},
]
GIBS_DAILY_DOMAIN = ('<?xml version="1.0"?><Domains><DimensionDomain><ows:Identifier>time</ows:Identifier><Domain>'
                     '2018-01-05/2018-02-21/P1D,2022-01-14/2026-10-17/P1D</Domain><Size>2</Size></DimensionDomain></Domains>')
GIBS_HLS_DOMAIN = ('<Domains><DimensionDomain><Domain>2025-08-21/2026-02-28/P1D,2026-03-02/2026-10-11/P1D</Domain>'
                   '<Size>2</Size></DimensionDomain></Domains>')
GIBS_GOES_DOMAIN = ('<Domains><DimensionDomain><Domain>2026-10-17T16:00:00Z/2026-10-17T19:40:00Z/PT10M</Domain>'
                    '<Size>1</Size></DimensionDomain></Domains>')

COOLEY_BBOX = "-123.3528,38.7125,-123.0412,38.9559"
LA_BBOX = "-119.0,33.95,-118.5,34.3"


# ----------------------------------------------------------------------------------------------------------------
# Fixtures
# ----------------------------------------------------------------------------------------------------------------
Handler = httpx.Response | Callable[[httpx.Request], httpx.Response]


class Router:
    """MockTransport handler: the first route whose substring occurs in the URL answers; counts calls per route."""

    def __init__(self) -> None:
        self.routes: list[tuple[str, Handler]] = []
        self.calls: list[str] = []

    def add(self, match: str, resp: Handler) -> "Router":
        self.routes.insert(0, (match, resp))
        return self

    def count(self, match: str) -> int:
        return sum(1 for u in self.calls if match in u)

    def __call__(self, request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        self.calls.append(url)
        for match, resp in self.routes:
            if match in url:
                return resp(request) if callable(resp) else resp
        raise RuntimeError(f"unrouted request in test: {url}")


def geojson(features: list[dict], **extra) -> httpx.Response:
    return httpx.Response(200, json={"type": "FeatureCollection", "features": features, **extra})


@pytest.fixture
def router(monkeypatch: pytest.MonkeyPatch, tmp_data_dir: Path) -> Router:
    ex.reset_state()
    monkeypatch.setattr(fhttp, "BACKOFF_BASE_S", 0.001)
    monkeypatch.setattr(ex, "now_ms", lambda: NOW)
    r = Router()
    monkeypatch.setattr(fhttp, "_transport", httpx.MockTransport(r))
    monkeypatch.setattr(catalog, "get_summary", lambda iid: None)
    for up in (ex.UP_ARCGIS, ex.UP_CWWP2, ex.UP_FRAMES, ex.UP_EARTH_SEARCH, ex.UP_CMR, ex.UP_GIBS, ex.UP_RENDER):
        monkeypatch.setattr(up, "limiter", fhttp.RateLimiter(1000, 60.0, "test"))
    yield r
    ex.reset_state()


@pytest.fixture
def client() -> TestClient:
    app = FastAPI()
    app.include_router(ex.router)
    return TestClient(app)


def write_manifest(data_dir: Path, incident_id: str, mode: str, bbox: list[float]) -> None:
    d = data_dir / "incidents" / incident_id
    d.mkdir(parents=True, exist_ok=True)
    (d / "manifest.json").write_bytes(orjson.dumps({"id": incident_id, "mode": mode, "status": "ready",
                                                     "summary": {"mode": mode}, "grid": {"bbox_lonlat": bbox}}))


def evac_routes(r: Router, zones: list[dict] | Handler = EVAC_FEATURES, inventory: list[dict] = INVENTORY_LA) -> Router:
    r.add("County_Evacuation_Inventory_Public/FeatureServer/0/query", geojson(inventory))
    r.add("CA_EVACUATIONS_CalOESHosted_view/FeatureServer/0?", httpx.Response(200, json=EVAC_LAYER_INFO))
    resp = zones if isinstance(zones, httpx.Response) or callable(zones) else geojson(zones)
    r.add("CA_EVACUATIONS_CalOESHosted_view/FeatureServer/0/query", resp)
    return r


# ----------------------------------------------------------------------------------------------------------------
# Area and time
# ----------------------------------------------------------------------------------------------------------------
def test_parse_bbox_validates() -> None:
    assert ex.parse_bbox("-118.9,34.0,-118.5,34.3") == (-118.9, 34.0, -118.5, 34.3)
    for bad in (None, "", "1,2,3", "a,b,c,d", "-118,34,-119,35", "-118,35,-117,34", "-120,30,-117,33", "nan,1,2,3"):
        with pytest.raises(ValueError):
            ex.parse_bbox(bad)
    with pytest.raises(ValueError):
        ex.parse_bbox("-119,34,-118,34.5", max_span=0.8)


def test_past_rule() -> None:
    b = (-118.9, 34.0, -118.5, 34.3)
    assert not ex.AreaContext(b, None, NOW, None, "live").is_past
    assert not ex.AreaContext(b, NOW - 5 * HOUR_MS, NOW, None, "live").is_past
    assert ex.AreaContext(b, NOW - 7 * HOUR_MS, NOW, None, None).is_past
    assert not ex.AreaContext(b, NOW + 48 * HOUR_MS, NOW, None, None).is_past     # forecast times show current status
    assert ex.AreaContext(b, None, NOW, "x", "historical").is_past                 # replay of a past fire
    assert ex.AreaContext(b, NOW + 48 * HOUR_MS, NOW, None, None).reference_ms == NOW


# ----------------------------------------------------------------------------------------------------------------
# Evacuations
# ----------------------------------------------------------------------------------------------------------------
@pytest.mark.parametrize("status,key", [
    ("Evacuation Order", "order"), ("EVACUATION ORDER", "order"), ("Evacuation Warning", "warning"),
    ("Shelter in Place", "shelter"), ("SHELTER-IN-PLACE", "shelter"), ("Advisory", "advisory"),
    ("Evacuation Order Lifted", "lifted"), ("Normal", "normal"), ("Training", "training"),
    ("EVACUATION LEVEL 3: GO NOW", "order"), ("Evacuation Level 2: Be Set", "warning"), ("Something new", "other"),
    (None, "unknown"), ("", "unknown"),
])
def test_status_key(status, key) -> None:
    assert ex.evac_status_key(status) == key


def test_evacuations_current(router: Router, client: TestClient) -> None:
    evac_routes(router)
    r = client.get("/api/extras/evacuations", params={"bbox": LA_BBOX})
    assert r.status_code == 200 and r.headers["cache-control"] == "no-store"
    d = r.json()
    assert d["status"] == "available" and d["reason"] is None
    assert d["counts"] == {"order": 1, "warning": 1}
    first, second = d["zones"]["features"]
    assert first["id"] == "US-CA-XLA-KAN-U017" and first["properties"]["status"] == "Evacuation Order"   # verbatim
    assert first["properties"]["jurisdiction"] == "Los Angeles County"
    assert first["properties"]["notes"].startswith("Local authorities are responding to a fast-moving Wildfire.")
    assert first["properties"]["status_updated_ms"] == 1792112236000
    assert second["properties"]["status_key"] == "warning"
    assert d["source_updated_ms"] == 1792263695245 and isinstance(d["retrieved_ms"], int)
    assert [c["county"] for c in d["coverage"]] == ["Los Angeles", "Ventura"]
    assert d["coverage"][0]["zone_source"] == "Genasys Protect (Zonehaven)"
    assert d["sources"][0]["publisher"].startswith("California Governor's Office of Emergency Services")
    assert "Cal OES does not verify" in d["sources"][0]["disclaimer"]
    # cached: a second request does not reach the layer again
    n = router.count("CA_EVACUATIONS_CalOESHosted_view/FeatureServer/0/query")
    client.get("/api/extras/evacuations", params={"bbox": LA_BBOX})
    assert router.count("CA_EVACUATIONS_CalOESHosted_view/FeatureServer/0/query") == n


def test_evacuations_past_never_shows_current_status(router: Router, client: TestClient, tmp_data_dir: Path) -> None:
    evac_routes(router)
    d = client.get("/api/extras/evacuations", params={"bbox": LA_BBOX, "at_ms": NOW - 3 * DAY_MS}).json()
    assert d["status"] == "not_available_for_past_dates" and d["reason_code"] == "past_date"
    assert d["zones"]["features"] == [] and d["counts"] == {}
    write_manifest(tmp_data_dir, "2025-eaton-fire-dbfa57", "historical", [-118.17, 34.15, -117.97, 34.26])
    d = client.get("/api/extras/evacuations", params={"incident": "2025-eaton-fire-dbfa57"}).json()
    assert d["status"] == "not_available_for_past_dates" and d["zones"]["features"] == []
    assert router.calls == []                     # nothing fetched for past dates


def test_evacuations_incident_area(router: Router, client: TestClient, tmp_data_dir: Path) -> None:
    evac_routes(router, zones=[])
    write_manifest(tmp_data_dir, "2026-cooley-fire-0c342f", "live", [-123.30, 38.75, -123.10, 38.90])
    d = client.get("/api/extras/evacuations", params={"incident": "2026-cooley-fire-0c342f", "margin_km": 10}).json()
    assert d["status"] == "available" and d["counts"] == {}
    w, s, e, n = d["bbox"]
    assert w < -123.30 and e > -123.10 and s < 38.75 and n > 38.90
    assert any("not an all-clear" in c for c in d["caveats"])
    assert client.get("/api/extras/evacuations", params={"incident": "no-such-fire"}).status_code == 404
    assert client.get("/api/extras/evacuations", params={"incident": "../etc"}).status_code == 400
    assert client.get("/api/extras/evacuations").status_code == 400


def test_evacuations_county_not_covered(router: Router, client: TestClient) -> None:
    evac_routes(router, inventory=INVENTORY_IMPERIAL)
    d = client.get("/api/extras/evacuations", params={"bbox": "-115.7,32.7,-115.3,33.0"}).json()
    assert d["status"] == "unavailable" and d["reason_code"] == "not_covered"
    assert "Imperial" in d["reason"] and d["zones"]["features"] == []


def test_evacuations_upstream_failure(router: Router, client: TestClient) -> None:
    evac_routes(router, zones=httpx.Response(503, text="busy"))
    d = client.get("/api/extras/evacuations", params={"bbox": LA_BBOX}).json()
    assert d["status"] == "unavailable" and d["reason_code"] == "upstream_error"
    assert "HTTP 503" in d["reason"] and d["zones"]["features"] == []
    ex.reset_state()
    evac_routes(router, zones=httpx.Response(200, json={"error": {"code": 400, "message": "Invalid query"}}))
    d = client.get("/api/extras/evacuations", params={"bbox": LA_BBOX}).json()
    assert d["status"] == "unavailable" and "error" in d["reason"]


def test_evacuations_confirms_a_sudden_drop(router: Router, client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    """The layer is rebuilt every 5 min and may briefly miss zones: a drop is re-queried once."""
    monkeypatch.setattr(ex.time, "sleep", lambda s: None)
    answers = [EVAC_FEATURES, EVAC_FEATURES[:1], EVAC_FEATURES]
    evac_routes(router, zones=lambda req: geojson(answers.pop(0)))
    assert client.get("/api/extras/evacuations", params={"bbox": LA_BBOX}).json()["counts"] == {"order": 1, "warning": 1}
    ex._mem.clear()                               # TTL expiry
    d = client.get("/api/extras/evacuations", params={"bbox": LA_BBOX}).json()
    assert d["counts"] == {"order": 1, "warning": 1} and answers == []


def test_evacuations_rate_limit(router: Router, client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    evac_routes(router)
    monkeypatch.setattr(ex.UP_ARCGIS, "limiter", fhttp.RateLimiter(1, 60.0, "test"))
    r = client.get("/api/extras/evacuations", params={"bbox": LA_BBOX})
    assert r.status_code == 429 and "limit" in r.json()["detail"]


# ----------------------------------------------------------------------------------------------------------------
# Cameras
# ----------------------------------------------------------------------------------------------------------------
def test_camera_ids_are_not_an_open_proxy() -> None:
    assert ex.camera_frame_url("alertca:Axis-Sanel1") == (
        "https://cameras.alertcalifornia.org/public-camera-data/Axis-Sanel1/latest-frame.jpg", "alertcalifornia")
    assert ex.camera_frame_url("caltrans:d1:us101sofhoplandlookings")[0] == (
        "https://cwwp2.dot.ca.gov/data/d1/cctv/image/us101sofhoplandlookings/us101sofhoplandlookings.jpg")
    for bad in ("", "alertca:", "alertca:../x", "alertca:a/b", "caltrans:d13:x", "caltrans:d1:UPPER", "http://evil",
                "caltrans:d1:x/../y", "other:abc"):
        with pytest.raises(ValueError):
            ex.camera_frame_url(bad)


def test_cameras_listing(router: Router, client: TestClient) -> None:
    router.add("CalOES_California_Webcams/FeatureServer/0/query", geojson(WEBCAM_FEATURES))
    router.add("CalOES_California_Webcams/FeatureServer/0?", httpx.Response(200, json={"editingInfo": {"dataLastEditDate": 1792267236506}}))
    router.add("cctvStatusD01.json", httpx.Response(200, json=CWWP2_D01))
    d = client.get("/api/extras/cameras", params={"bbox": COOLEY_BBOX}).json()
    assert d["status"] == "available" and d["counts"] == {"wildfire": 1, "traffic": 1}
    assert d["excluded"] == {"Alert Wildfire": 1} and any("not verified" in c for c in d["caveats"])
    fire, traffic = d["cameras"]["features"]
    fp, tp = fire["properties"], traffic["properties"]
    assert fp["id"] == "alertca:Axis-Sanel1" and fp["credit"] == "ALERTCalifornia | UC San Diego"
    assert fp["azimuth_deg"] == 169.7 and fp["viewer_url"] == "https://cameras.alertcalifornia.org/?id=Axis-Sanel1"
    assert "CC BY-NC-ND 4.0" in fp["license"] and fp["county"] == "Mendocino"
    assert fp["frame_endpoint"] == "/api/extras/cameras/latest?id=alertca%3AAxis-Sanel1"
    assert tp["id"] == "caltrans:d1:us101sofhoplandlookings" and tp["in_service"] is True and tp["update_minutes"] == 10
    assert tp["status_record_ms"] == 1773333061000 and "_image_url" not in tp
    assert traffic["geometry"]["coordinates"] == [-123.085536, 38.94941]
    assert d["source_updated_ms"] == 1792267236506


def test_cameras_past(router: Router, client: TestClient) -> None:
    d = client.get("/api/extras/cameras", params={"bbox": COOLEY_BBOX, "at_ms": NOW - DAY_MS}).json()
    assert d["status"] == "not_available_for_past_dates" and d["cameras"]["features"] == [] and router.calls == []


def jpeg_bytes(w: int = 64, h: int = 36) -> bytes:
    from PIL import Image

    buf = io.BytesIO()
    Image.new("RGB", (w, h), (120, 130, 140)).save(buf, "JPEG")
    return buf.getvalue()


def test_camera_latest_frame(router: Router, client: TestClient) -> None:
    img = jpeg_bytes()
    router.add("public-camera-data/Axis-Sanel1/latest-frame.jpg",
               httpx.Response(200, content=img, headers={"content-type": "image/jpeg", "last-modified": "Sat, 17 Oct 2026 20:28:21 GMT"}))
    d = client.get("/api/extras/cameras/latest", params={"id": "alertca:Axis-Sanel1"}).json()
    assert d["status"] == "available" and d["image_time_ms"] == 1792268901000
    assert d["width"] == 64 and d["height"] == 36 and d["credit"] == "ALERTCalifornia | UC San Diego"
    assert d["age_ms"] == NOW - 1792268901000
    frame = client.get(d["image_url"])
    assert frame.status_code == 200 and frame.content == img and frame.headers["content-type"] == "image/jpeg"
    # short in-memory cache: an immediate second request does not refetch
    client.get("/api/extras/cameras/latest", params={"id": "alertca:Axis-Sanel1"})
    assert router.count("latest-frame.jpg") == 1
    assert client.get("/api/extras/cameras/frames/" + "0" * 32 + ".jpg").status_code == 404
    assert client.get("/api/extras/cameras/frames/../../etc.jpg").status_code == 404


def test_camera_latest_failures(router: Router, client: TestClient) -> None:
    router.add("Axis-Gone/latest-frame.jpg", httpx.Response(404, text="nope"))
    router.add("Axis-Html/latest-frame.jpg", httpx.Response(200, text="<html>maintenance</html>"))
    router.add("Axis-NoTime/latest-frame.jpg", httpx.Response(200, content=jpeg_bytes(), headers={"content-type": "image/jpeg"}))
    d = client.get("/api/extras/cameras/latest", params={"id": "alertca:Axis-Gone"}).json()
    assert d["status"] == "unavailable" and "HTTP 404" in d["reason"] and d["image_url"] is None
    d = client.get("/api/extras/cameras/latest", params={"id": "alertca:Axis-Html"}).json()
    assert d["status"] == "unavailable" and "did not return an image" in d["reason"]
    d = client.get("/api/extras/cameras/latest", params={"id": "alertca:Axis-NoTime"}).json()
    assert d["status"] == "available" and d["image_time_ms"] is None and "did not report" in d["reason"]
    assert client.get("/api/extras/cameras/latest", params={"id": "https://example.com/x.jpg"}).status_code == 400


# ----------------------------------------------------------------------------------------------------------------
# Imagery
# ----------------------------------------------------------------------------------------------------------------
def test_gibs_domain_helpers() -> None:
    dom = ex.parse_gibs_domain(GIBS_GOES_DOMAIN)
    assert dom == [(1792252800000, 1792266000000, 600000)]
    assert ex.gibs_latest_at_or_before(dom, NOW) == 1792266000000           # 19:40Z
    assert ex.gibs_latest_at_or_before(dom, 1792259000000) == 1792258800000  # floor to the 10-min grid
    assert ex.gibs_latest_at_or_before(dom, 1792250000000) is None
    daily = ex.parse_gibs_domain(GIBS_DAILY_DOMAIN)
    assert ex.gibs_has(daily, 1792195200000)                                  # 2026-10-16
    assert not ex.gibs_has(daily, 1792195200000 + HOUR_MS)                    # not on the daily grid
    assert not ex.gibs_has(daily, 1700000000000)                              # gap 2018..2022
    assert ex.parse_gibs_domain("<x/>") == []
    assert ex.parse_gibs_domain("<Domain>2025-01-08/2025-01-08T04:30:00Z/PT10M</Domain>")[0][0] == 1736294400000


def test_sentinel2_pass_grouping() -> None:
    b = ex.parse_bbox(COOLEY_BBOX)
    passes = ex.group_s2_passes(S2_FEATURES, b, NOW)
    assert [len(p["items"]) for p in passes] == [1, 2]
    newest, older = passes
    assert newest["platform"] == "sentinel-2a" and 0.5 < newest["coverage"] < 0.6   # only the southern tile
    assert older["coverage"] == pytest.approx(1.0, abs=1e-6) and older["cloud"] == pytest.approx(0.0, abs=0.01)
    assert older["published"] == ex._iso_to_ms("2026-10-13T23:02:48.645Z")
    # a reference time before the newest scene hides it (never list imagery acquired after the selected time)
    assert len(ex.group_s2_passes(S2_FEATURES, b, ex._iso_to_ms("2026-10-14T00:00:00Z"))) == 1


def imagery_routes(r: Router) -> Router:
    r.add("earth-search.aws.element84.com/v1/search", geojson(S2_FEATURES))
    r.add("short_name=HLSL30", httpx.Response(200, json={"feed": {"entry": HLS_ENTRIES}}))
    r.add("short_name=VJ102MOD", httpx.Response(200, json={"feed": {"entry": VIIRS_ENTRIES}}))
    r.add("short_name=VJ202MOD", httpx.Response(200, json={"feed": {"entry": []}}))
    r.add("HLS_L30_Nadir_BRDF_Adjusted_Reflectance/default/GoogleMapsCompatible_Level12/all/all.xml", httpx.Response(200, text=GIBS_HLS_DOMAIN))
    r.add("CorrectedReflectance_TrueColor/default/GoogleMapsCompatible_Level9/all/all.xml", httpx.Response(200, text=GIBS_DAILY_DOMAIN))
    r.add("GOES-West_ABI_GeoColor/default/GoogleMapsCompatible_Level7/all/", httpx.Response(200, text=GIBS_GOES_DOMAIN))
    return r


def test_imagery_listing(router: Router, client: TestClient) -> None:
    imagery_routes(router)
    d = client.get("/api/extras/imagery", params={"bbox": COOLEY_BBOX}).json()
    assert d["status"] == "available"
    fams = {f["family"]: f for f in d["families"]}
    assert fams["sentinel-2"]["count"] == 2 and fams["landsat"]["count"] == 1 and fams["goes"]["count"] == 1
    assert d["source_updated_ms"] == max(p["published_ms"] for p in d["products"] if p["published_ms"])
    prods = {p["id"]: p for p in d["products"]}
    acq = [p["acquired_ms"] for p in d["products"]]
    assert acq == sorted(acq, reverse=True)
    s2 = prods["sentinel-2:S2C_10SDJ_20261013_0_L2A,S2C_10SDH_20261013_0_L2A"]     # least cloudy tile first
    assert s2["display"]["type"] == "image" and s2["resolution_m"] == 10 and s2["platform"] == "Sentinel-2C"
    assert s2["display"]["url"] == ("/api/extras/imagery/sentinel2.webp?items=S2C_10SDJ_20261013_0_L2A,"
                                    "S2C_10SDH_20261013_0_L2A&bbox=" + COOLEY_BBOX)
    assert s2["display"]["coordinates"] == [[-123.3528, 38.9559], [-123.0412, 38.9559], [-123.0412, 38.7125], [-123.3528, 38.7125]]
    assert s2["attribution"] == "Contains modified Copernicus Sentinel data 2026 (Earth Search by Element 84)"
    # the render of this ~35 km area is coarser than the native 10 m: say so
    assert s2["display"]["pixel_m"] == ex.render_pixel_m(ex.parse_bbox(COOLEY_BBOX)) and 12 < s2["display"]["pixel_m"] < 15
    assert s2["resolution_note"].startswith("10 m pixels, shown at about 13 m over this area")
    assert 3 * HOUR_MS < s2["latency_ms"] < 5 * HOUR_MS
    ls = prods["landsat:2026-10-04"]
    assert ls["available"] and ls["cloud_cover_pct"] == 100.0 and ls["coverage_pct"] == 100.0
    assert ls["display"]["tiles"][0].endswith("/HLS_L30_Nadir_BRDF_Adjusted_Reflectance/default/2026-10-04/GoogleMapsCompatible_Level12/{z}/{y}/{x}.png")
    goes = prods["goes-west:2026-10-17T19:40:00Z"]
    assert goes["display"]["max_zoom"] == 7 and goes["latency_ms"] > 0 and goes["acquired_ms"] == 1792266000000
    v = prods["viirs:noaa20:true_color:2026-10-16"]
    assert v["available"] and v["pass_times_ms"] == [1792184400000, 1792184760000]   # 21:00Z and 21:06Z
    assert v["display"]["tiles"][0].endswith("VIIRS_NOAA20_CorrectedReflectance_TrueColor/default/2026-10-16/GoogleMapsCompatible_Level9/{z}/{y}/{x}.jpg")
    assert prods["viirs:noaa20:fire_false_color:2026-10-16"]["display"]["tiles"][0].count("BandsM11-I2-I1") == 1
    assert "not the dated aerial basemap" in d["caveats"][0]


def test_imagery_viirs_waits_for_processing(router: Router, client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    """A pass 1 h ago is listed but not displayable yet; a replay time before the pass hides the date."""
    imagery_routes(router)
    monkeypatch.setattr(ex, "now_ms", lambda: 1792184760000 + HOUR_MS)
    d = client.get("/api/extras/imagery", params={"bbox": COOLEY_BBOX, "families": "viirs"}).json()
    v = [p for p in d["products"] if p["family"] == "viirs"]
    assert v and not any(p["available"] for p in v) and "3 hours" in v[0]["unavailable_reason"]
    assert d["families"][0]["status"] == "none"
    d = client.get("/api/extras/imagery", params={"bbox": COOLEY_BBOX, "families": "viirs", "at_ms": 1792184500000}).json()
    assert d["products"] == []                    # 21:06Z pass is after the selected time: the daily image is not offered


def test_imagery_family_failure_is_isolated(router: Router, client: TestClient) -> None:
    imagery_routes(router)
    router.add("earth-search.aws.element84.com/v1/search", httpx.Response(502, text="bad gateway"))
    d = client.get("/api/extras/imagery", params={"bbox": COOLEY_BBOX, "families": "sentinel-2,goes"}).json()
    fams = {f["family"]: f for f in d["families"]}
    assert d["status"] == "available"
    assert fams["sentinel-2"]["status"] == "unavailable" and "HTTP 502" in fams["sentinel-2"]["reason"]
    assert fams["goes"]["status"] == "available"
    assert client.get("/api/extras/imagery", params={"bbox": COOLEY_BBOX, "families": "bogus"}).status_code == 400
    assert client.get("/api/extras/imagery", params={"bbox": "-124,38,-122.9,39"}).status_code == 400   # span > 0.8


def test_render_grid_limits() -> None:
    (x0, y0, x1, y1), w, h = ex.render_grid((-123.3528, 38.7125, -123.0412, 38.9559))
    assert max(w, h) <= ex.RENDER_MAX_PX
    ground_m = (x1 - x0) / w * np.cos(np.radians(38.83))
    assert ground_m >= 10.0 - 1e-6
    (_, _, _, _), w2, h2 = ex.render_grid((-118.10, 34.18, -118.09, 34.19))
    assert w2 < 100 and h2 < 120                   # small areas stay at 10 m, never upsampled
    assert ex.render_pixel_m((-118.10, 34.18, -118.09, 34.19)) == 10.0
    assert abs(ex.render_pixel_m((-123.3528, 38.7125, -123.0412, 38.9559)) - ground_m) < 0.1


def test_sentinel2_render_and_cache(router: Router, client: TestClient, tmp_data_dir: Path) -> None:
    href = S2_FEATURES[1]["assets"]["visual"]["href"]
    router.add("/collections/sentinel-2-l2a/items/S2C_10SDH_20261013_0_L2A", httpx.Response(200, json=S2_FEATURES[1]))
    router.add("/collections/sentinel-2-l2a/items/S2C_10SDJ_20261013_0_L2A", httpx.Response(200, json=S2_FEATURES[2]))
    calls: list[str] = []

    def fake_read(h: str, bounds, w: int, hgt: int) -> np.ndarray:
        calls.append(h)
        rgb = np.zeros((3, hgt, w), dtype=np.uint8)
        if h == href:
            rgb[:, hgt // 2:, :] = 90                 # southern half covered by the first tile
        else:
            rgb[:, :, : w // 2] = 160                 # western half by the second
        return rgb

    b = ex.parse_bbox(COOLEY_BBOX)
    p = ex.render_sentinel2(["S2C_10SDH_20261013_0_L2A", "S2C_10SDJ_20261013_0_L2A"], b, reader=fake_read)
    assert p.parent == Path(config.CACHE_DIR) / "extras" / "sentinel2" and p.suffix == ".webp"
    from PIL import Image

    with Image.open(p) as im:
        assert im.mode == "RGBA"
        a = np.asarray(im)
    h, w = a.shape[:2]
    assert a[h - 1, w - 1, 3] == 255 and abs(int(a[h - 1, w - 1, 0]) - 90) < 8      # first item wins in the south
    assert a[0, 0, 3] == 255 and abs(int(a[0, 0, 0]) - 160) < 8                       # second fills the north-west
    assert a[0, w - 1, 3] == 0                                                         # no data -> transparent
    assert len(calls) == 2
    again = ex.render_sentinel2(["S2C_10SDH_20261013_0_L2A", "S2C_10SDJ_20261013_0_L2A"], b, reader=fake_read)
    assert again == p and len(calls) == 2            # disk cache hit


def test_sentinel2_render_rejects_foreign_assets(router: Router, client: TestClient) -> None:
    bad = {**S2_FEATURES[1], "assets": {"visual": {"href": "https://example.com/TCI.tif"}}}
    router.add("/collections/sentinel-2-l2a/items/S2C_10SDH_20261013_0_L2A", httpx.Response(200, json=bad))
    r = client.get("/api/extras/imagery/sentinel2.webp", params={"items": "S2C_10SDH_20261013_0_L2A", "bbox": COOLEY_BBOX})
    assert r.status_code == 502 and "true-colour" in r.json()["detail"]
    assert client.get("/api/extras/imagery/sentinel2.webp", params={"items": "../../x", "bbox": COOLEY_BBOX}).status_code == 400
    assert client.get("/api/extras/imagery/sentinel2.webp", params={"items": "S2C_10SDH_20261013_0_L2A", "bbox": "-125,37,-122,40"}).status_code == 400


def test_sources_endpoint(client: TestClient) -> None:
    d = client.get("/api/extras/sources").json()
    assert d["past_tolerance_ms"] == 6 * HOUR_MS
    assert d["sources"]["alertcalifornia"]["attribution"] == "ALERTCalifornia | UC San Diego"
    assert "Global Imagery Browse Services" in d["sources"]["nasa_viirs"]["disclaimer"]
    for s in d["sources"].values():
        assert s["terms_url"].startswith("https://") and s["license"]


def test_no_secret_in_error_text(router: Router, client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(config, "FIRMS_MAP_KEY", "0123456789abcdef0123456789abcdef")
    evac_routes(router, zones=httpx.Response(500, text="0123456789abcdef0123456789abcdef"))
    body = client.get("/api/extras/evacuations", params={"bbox": LA_BBOX}).text
    assert "0123456789abcdef0123456789abcdef" not in body


def test_frame_store_is_bounded(monkeypatch: pytest.MonkeyPatch) -> None:
    ex.reset_state()
    monkeypatch.setattr(ex, "FRAME_STORE_MAX", 3)
    tokens = [ex._store_frame(bytes([i]) * 10, "image/jpeg") for i in range(5)]
    assert len(ex._frame_store) == 3 and tokens[0] not in ex._frame_store and tokens[-1] in ex._frame_store
    t0 = time.monotonic()
    monkeypatch.setattr(ex.time, "monotonic", lambda: t0 + ex.FRAME_KEEP_S + 1)
    ex._store_frame(b"new", "image/jpeg")
    assert len(ex._frame_store) == 1
    ex.reset_state()
