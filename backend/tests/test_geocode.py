"""api/geocode.py: the Census Geocoder proxy, offline (httpx.MockTransport serving replies recorded 2026-10-17)."""

from __future__ import annotations

import warnings
from collections.abc import Iterator

import httpx
import orjson
import pytest
from fastapi import FastAPI

with warnings.catch_warnings():     # the installed Starlette deprecates httpx in its TestClient (not our code)
    warnings.simplefilter("ignore")
    from fastapi.testclient import TestClient

import fire3d.http as fhttp
from fire3d.api import geocode

# Recorded from https://geocoding.geo.census.gov/geocoder/locations/onelineaddress (benchmark=Public_AR_Current,
# format=json) on 2026-10-17. Public buildings / generic queries only.
SINGLE = (
    b'{"result":{"input":{"address":{"address":"600 E Mariposa St, Altadena, CA 91001"},"benchmark":{"isDefault":true,'
    b'"benchmarkDescription":"Public Address Ranges - Current Benchmark","id":"4","benchmarkName":"Public_AR_Current"}},'
    b'"addressMatches":[{"tigerLine":{"side":"R","tigerLineId":"142735412"},"coordinates":{"x":-118.137393868125,'
    b'"y":34.189637011412},"addressComponents":{"zip":"91001","streetName":"MARIPOSA","preType":"","city":"ALTADENA",'
    b'"preDirection":"E","suffixDirection":"","fromAddress":"600","state":"CA","suffixType":"ST","toAddress":"628",'
    b'"suffixQualifier":"","preQualifier":""},"matchedAddress":"600 E MARIPOSA ST, ALTADENA, CA, 91001"}]}}'
)
NO_MATCH = (
    b'{"result":{"input":{"address":{"address":"1 Nowhere Blvd, Nowhere, CA 99999"},"benchmark":{"isDefault":true,'
    b'"benchmarkDescription":"Public Address Ranges - Current Benchmark","id":"4","benchmarkName":"Public_AR_Current"}},'
    b'"addressMatches":[]}}'
)
# "100 Main St, CA" returned 50 candidates; the first three are kept here.
AMBIGUOUS = orjson.loads(
    b'{"result":{"input":{"address":{"address":"100 Main St, CA"},"benchmark":{"isDefault":true,"benchmarkDescription":'
    b'"Public Address Ranges - Current Benchmark","id":"4","benchmarkName":"Public_AR_Current"}},"addressMatches":['
    b'{"tigerLine":{"side":"R","tigerLineId":"106908022"},"coordinates":{"x":-120.848416796656,"y":39.464554327407},'
    b'"addressComponents":{"zip":"95910","streetName":"MAIN","preType":"","city":"ALLEGHANY","preDirection":"",'
    b'"suffixDirection":"","fromAddress":"100","state":"CA","suffixType":"ST","toAddress":"104","suffixQualifier":"",'
    b'"preQualifier":""},"matchedAddress":"100 MAIN ST, ALLEGHANY, CA, 95910"},'
    b'{"tigerLine":{"side":"L","tigerLineId":"611036043"},"coordinates":{"x":-120.373159237641,"y":39.820027185255},'
    b'"addressComponents":{"zip":"96129","streetName":"MAIN","preType":"","city":"BECKWOURTH","preDirection":"",'
    b'"suffixDirection":"","fromAddress":"144","state":"CA","suffixType":"ST","toAddress":"100","suffixQualifier":"",'
    b'"preQualifier":""},"matchedAddress":"100 MAIN ST, BECKWOURTH, CA, 96129"},'
    b'{"tigerLine":{"side":"R","tigerLineId":"657858521"},"coordinates":{"x":-122.458545621916,"y":37.873826809972},'
    b'"addressComponents":{"zip":"94920","streetName":"MAIN","preType":"","city":"BELVEDERE TIBURON","preDirection":"",'
    b'"suffixDirection":"","fromAddress":"70","state":"CA","suffixType":"ST","toAddress":"104","suffixQualifier":"",'
    b'"preQualifier":""},"matchedAddress":"100 MAIN ST, BELVEDERE TIBURON, CA, 94920"}]}}'
)
BAD_BENCHMARK = b'{"errors":["Invalid benchmark in request"],"status":"400"}'


class Upstream:
    """Scripted Census replies; records each request."""

    def __init__(self) -> None:
        self.calls: list[httpx.Request] = []
        self.replies: list[httpx.Response | Exception] = []
        self.default: httpx.Response | Exception = httpx.Response(200, content=SINGLE, headers={"content-type": "application/json"})

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.calls.append(request)
        r = self.replies.pop(0) if self.replies else self.default
        if isinstance(r, Exception):
            raise r
        return r


def ok(body: bytes | dict) -> httpx.Response:
    content = body if isinstance(body, bytes) else orjson.dumps(body)
    return httpx.Response(200, content=content, headers={"content-type": "application/json"})


@pytest.fixture
def upstream(tmp_data_dir, monkeypatch) -> Iterator[Upstream]:
    up = Upstream()
    monkeypatch.setattr(fhttp, "_transport", httpx.MockTransport(up))
    monkeypatch.setattr(fhttp, "_retry_delay", lambda attempt, retry_after: 0.0)
    monkeypatch.setattr(geocode, "upstream_limiter", fhttp.RateLimiter(geocode.UPSTREAM_PER_MINUTE, 60.0))
    geocode.clear_cache()
    yield up
    geocode.clear_cache()


@pytest.fixture
def client(upstream) -> TestClient:
    app = FastAPI()
    app.include_router(geocode.router)
    return TestClient(app)


def test_router_is_mounted_on_the_api(upstream: Upstream) -> None:
    from fire3d.api.app import app

    r = TestClient(app).get("/api/geocode", params={"q": "34.2, -118.1"})   # no lifespan: nothing else starts
    assert r.status_code == 400 and "coordinates" in r.json()["detail"]
    assert upstream.calls == []


def test_single_match(client: TestClient, upstream: Upstream) -> None:
    r = client.get("/api/geocode", params={"q": "  600 E Mariposa St,   Altadena, CA 91001 "})
    assert r.status_code == 200
    assert r.headers["cache-control"] == "private, max-age=3600"
    body = r.json()
    assert body["query"] == "600 E Mariposa St, Altadena, CA 91001"
    assert body["matches"] == [{
        "kind": "address", "matched_address": "600 E MARIPOSA ST, ALTADENA, CA, 91001", "lat": 34.189637, "lon": -118.1373939,
        "tiger_line_id": "142735412", "side": "R", "from_address": "600", "to_address": "628",
    }]
    assert body["kind"] == "address" and body["local"] is False
    assert body["total_matches"] == 1
    assert body["benchmark"] == "Public_AR_Current"
    assert body["source"] == "U.S. Census Bureau Geocoder"
    assert "interpolated along address ranges" in body["attribution"]
    assert "not at a building or rooftop" in body["note"]
    assert body["cached"] is False and body["fetched_ms"] > 0
    # the upstream request: documented endpoint + current benchmark, JSON, identifying User-Agent, no key
    (req,) = upstream.calls
    assert req.url.host == "geocoding.geo.census.gov"
    assert req.url.path == "/geocoder/locations/onelineaddress"
    assert dict(req.url.params) == {"address": "600 E MARIPOSA ST, ALTADENA, CA 91001", "benchmark": "Public_AR_Current", "format": "json"}
    assert req.headers["user-agent"].startswith("Fire-3d/")


def test_cache_is_keyed_by_the_normalised_query(client: TestClient, upstream: Upstream) -> None:
    assert client.get("/api/geocode", params={"q": "600 E Mariposa St, Altadena, CA 91001"}).json()["cached"] is False
    again = client.get("/api/geocode", params={"q": "600 e MARIPOSA st,\tAltadena, ca 91001"}).json()
    assert again["cached"] is True and again["query"] == "600 e MARIPOSA st, Altadena, ca 91001"
    assert again["matches"][0]["matched_address"] == "600 E MARIPOSA ST, ALTADENA, CA, 91001"
    assert len(upstream.calls) == 1
    # a restart (empty memory cache) is served by fire3d.http's disk cache: still no second upstream call
    geocode.clear_cache()
    third = client.get("/api/geocode", params={"q": "600 E Mariposa St, Altadena, CA 91001"}).json()
    assert third["cached"] is True and len(upstream.calls) == 1


def test_no_match_is_an_empty_list(client: TestClient, upstream: Upstream) -> None:
    upstream.default = ok(NO_MATCH)
    r = client.get("/api/geocode", params={"q": "1 Nowhere Blvd, Nowhere, CA 99999"})
    assert r.status_code == 200
    assert r.json()["matches"] == [] and r.json()["total_matches"] == 0


def test_ambiguous_queries_list_every_candidate_up_to_the_limit(client: TestClient, upstream: Upstream) -> None:
    upstream.default = ok(AMBIGUOUS)
    body = client.get("/api/geocode", params={"q": "100 Main St, CA"}).json()
    assert [m["matched_address"] for m in body["matches"]] == [
        "100 MAIN ST, ALLEGHANY, CA, 95910", "100 MAIN ST, BECKWOURTH, CA, 96129", "100 MAIN ST, BELVEDERE TIBURON, CA, 94920"]
    # 50 candidates upstream (as recorded): the first MAX_MATCHES are returned, total_matches says how many exist
    many = orjson.loads(orjson.dumps(AMBIGUOUS))
    base = many["result"]["addressMatches"][0]
    many["result"]["addressMatches"] = [
        {**base, "coordinates": {"x": -120.0 - i / 100, "y": 39.0 + i / 100}, "matchedAddress": f"100 MAIN ST, TOWN {i}, CA, 95910"} for i in range(50)]
    upstream.default = ok(many)
    body = client.get("/api/geocode", params={"q": "100 Main St, California"}).json()
    assert len(body["matches"]) == geocode.MAX_MATCHES == 10 and body["total_matches"] == 50


def test_bad_coordinates_and_duplicates_are_dropped() -> None:
    payload = orjson.loads(SINGLE)
    good = payload["result"]["addressMatches"][0]
    payload["result"]["addressMatches"] = [
        good, dict(good),                                                     # duplicate
        {**good, "coordinates": {"x": "nan", "y": 34.1}},                     # not finite
        {**good, "coordinates": {"x": -118.1, "y": 134.1}},                   # out of range
        {**good, "coordinates": None},                                        # missing
        {**good, "tigerLine": {"side": "X", "tigerLineId": ""}, "matchedAddress": "602 E MARIPOSA ST, ALTADENA, CA, 91001"},
    ]
    matches, bench = geocode.parse_reply(payload)
    assert bench == "Public_AR_Current"
    assert [m["matched_address"] for m in matches] == ["600 E MARIPOSA ST, ALTADENA, CA, 91001", "602 E MARIPOSA ST, ALTADENA, CA, 91001"]
    assert matches[1]["side"] is None and matches[1]["tiger_line_id"] is None
    with pytest.raises(ValueError):
        geocode.parse_reply({"errors": ["x"]})


@pytest.mark.parametrize("q", ["", "   ", "\t\n"])
def test_empty_query_is_400(client: TestClient, upstream: Upstream, q: str) -> None:
    r = client.get("/api/geocode", params={"q": q})
    assert r.status_code == 400 and "street address" in r.json()["detail"]
    assert r.headers["cache-control"] == "no-store"
    assert upstream.calls == []


def test_missing_parameter_is_400(client: TestClient, upstream: Upstream) -> None:
    assert client.get("/api/geocode").status_code == 400
    assert upstream.calls == []


def test_too_long_query_is_400(client: TestClient, upstream: Upstream) -> None:
    r = client.get("/api/geocode", params={"q": "1 Main St " + "x" * 200})
    assert r.status_code == 400 and "too long" in r.json()["detail"]
    assert upstream.calls == []


@pytest.mark.parametrize("q", ["34.2048, -118.1027", "34.2048 N 118.1027 W", "34°12'17\"N 118°06'10\"W", "geo:34.2,-118.1",
                               "-118.1027 34.2048", "34 12.5 N, 118 6.2 W"])
def test_coordinates_are_never_sent_upstream(client: TestClient, upstream: Upstream, q: str) -> None:
    r = client.get("/api/geocode", params={"q": q})
    assert r.status_code == 400 and "coordinates" in r.json()["detail"].lower()
    assert upstream.calls == []


@pytest.mark.parametrize("q", ["100 W 200 N, Provo, UT", "100 W 200 N", "600 E Mariposa St"])
def test_street_grid_addresses_are_not_mistaken_for_coordinates(q: str) -> None:
    assert not geocode.looks_like_coordinates(geocode.normalize_query(q))


@pytest.mark.parametrize("q", ["12345678", "123", "9100", "#!?"])
def test_numbers_only_is_400(client: TestClient, upstream: Upstream, q: str) -> None:
    r = client.get("/api/geocode", params={"q": q})
    assert r.status_code == 400 and "ZIP code" in r.json()["detail"]
    assert upstream.calls == []


def test_upstream_rejection_is_502_with_only_the_short_census_message(client: TestClient, upstream: Upstream) -> None:
    upstream.default = httpx.Response(400, content=BAD_BENCHMARK, headers={"content-type": "application/json"})
    r = client.get("/api/geocode", params={"q": "600 E Mariposa St, Altadena, CA 91001"})
    assert r.status_code == 502
    detail = r.json()["detail"]
    assert detail == "The Census Geocoder rejected the request (HTTP 400): Invalid benchmark in request."
    assert "errors" not in detail and "{" not in detail
    assert len(upstream.calls) == 1     # 4xx is not retried


def test_upstream_server_error_is_retried_once_then_502(client: TestClient, upstream: Upstream) -> None:
    upstream.default = httpx.Response(503, content=b"<html>maintenance</html>")
    r = client.get("/api/geocode", params={"q": "600 E Mariposa St, Altadena, CA 91001"})
    assert r.status_code == 502 and "HTTP 503" in r.json()["detail"] and "html" not in r.json()["detail"]
    assert len(upstream.calls) == 1 + geocode.RETRIES


def test_upstream_timeout_is_504(client: TestClient, upstream: Upstream) -> None:
    upstream.default = httpx.ReadTimeout("timed out")
    r = client.get("/api/geocode", params={"q": "600 E Mariposa St, Altadena, CA 91001"})
    assert r.status_code == 504 and "did not answer in time" in r.json()["detail"]


def test_unreachable_upstream_is_502(client: TestClient, upstream: Upstream) -> None:
    upstream.default = httpx.ConnectError("connection refused")
    r = client.get("/api/geocode", params={"q": "600 E Mariposa St, Altadena, CA 91001"})
    assert r.status_code == 502 and "Cannot reach the Census Geocoder" in r.json()["detail"]


def test_unparseable_reply_is_502_and_heals_on_the_next_request(client: TestClient, upstream: Upstream) -> None:
    upstream.replies = [httpx.Response(200, content=b"<html>The requested URL was rejected</html>", headers={"content-type": "text/html"})]
    r = client.get("/api/geocode", params={"q": "600 E Mariposa St, Altadena, CA 91001"})
    assert r.status_code == 502 and "could not be read" in r.json()["detail"] and "html" not in r.json()["detail"].lower()
    # fire3d.http cached that 200 on disk; the next request finds it unreadable, fetches again and recovers
    r = client.get("/api/geocode", params={"q": "600 E Mariposa St, Altadena, CA 91001"})
    assert r.status_code == 200 and r.json()["matches"][0]["side"] == "R" and r.json()["cached"] is False
    assert len(upstream.calls) == 2
    r = client.get("/api/geocode", params={"q": "600 E Mariposa St, Altadena, CA 91001"})
    assert r.json()["cached"] is True and len(upstream.calls) == 2


def test_own_rate_limit_is_429_but_cached_queries_still_work(client: TestClient, upstream: Upstream, monkeypatch) -> None:
    monkeypatch.setattr(geocode, "upstream_limiter", fhttp.RateLimiter(2, 60.0))
    assert client.get("/api/geocode", params={"q": "1 A St, Altadena, CA"}).status_code == 200
    assert client.get("/api/geocode", params={"q": "2 A St, Altadena, CA"}).status_code == 200
    r = client.get("/api/geocode", params={"q": "3 A St, Altadena, CA"})
    assert r.status_code == 429 and r.headers["retry-after"] == "60"
    assert "coordinates and incident search still work" in r.json()["detail"]
    assert client.get("/api/geocode", params={"q": "1 a st, altadena, ca"}).json()["cached"] is True
    assert len(upstream.calls) == 2


def test_memory_cache_is_bounded(client: TestClient, upstream: Upstream, monkeypatch) -> None:
    monkeypatch.setattr(geocode, "CACHE_MAX_ENTRIES", 3)
    for i in range(5):
        client.get("/api/geocode", params={"q": f"{i} A St, Altadena, CA"})
    assert len(geocode._cache) == 3
    assert list(geocode._cache) == ["2 a st, altadena, ca", "3 a st, altadena, ca", "4 a st, altadena, ca"]


def test_configured_benchmark_is_sent(client: TestClient, upstream: Upstream, monkeypatch) -> None:
    monkeypatch.setattr(geocode, "BENCHMARK", "Public_AR_ACS2026")
    client.get("/api/geocode", params={"q": "600 E Mariposa St, Altadena, CA 91001"})
    assert upstream.calls[0].url.params["benchmark"] == "Public_AR_ACS2026"


# ------------------------------------------------------------------------------------------------------------------
# Towns, cities and ZIP areas (local Census Gazetteer index, brief 2 C-R5): never an upstream call
# ------------------------------------------------------------------------------------------------------------------
def local(client: TestClient, q: str) -> dict:
    r = client.get("/api/geocode", params={"q": q})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["local"] is True and body["benchmark"] is None
    assert body["source"] == "U.S. Census Bureau Gazetteer Files" and "public domain" in body["attribution"]
    return body


def test_the_built_index_covers_us_places_counties_and_zip_areas() -> None:
    raw = orjson.loads(geocode.GAZETTEER_PATH.read_bytes())
    assert geocode.GAZETTEER_PATH.name == "gazetteer_us.json"
    assert not (geocode.GAZETTEER_PATH.parent / "gazetteer_ca.json").exists()          # replaced (brief 3)
    assert raw["source"] == "U.S. Census Bureau Gazetteer Files" and raw["vintage"] >= 2026
    assert raw["counts"] == {"places": len(raw["places"]), "zips": len(raw["zips"])}
    kinds = {k: sum(1 for p in raw["places"] if p[1] == k) for k in ("city", "town", "village", "borough", "cdp", "county")}
    assert kinds["city"] > 10000 and kinds["town"] > 4000 and kinds["village"] > 3000 and kinds["cdp"] > 12000
    assert kinds["county"] == 3222                                    # counties and equivalents, 2026 vintage
    assert len(raw["zips"]) > 33000
    states = {p[2] for p in raw["places"]}
    assert {"CA", "ID", "IL", "NY", "DC", "AK", "HI", "PR"} <= states
    ca = [p for p in raw["places"] if p[2] == "CA" and p[1] in ("city", "town", "cdp")]
    assert len(ca) == 462 + 21 + 1139                                 # every California place, as in brief 2
    for _, _, _, lat, lon, area, *_ in raw["places"]:
        assert -15 <= lat <= 72 and -180 <= lon <= 180 and area >= 0


@pytest.mark.parametrize("q", ["91001", "CA 91001", "91001 CA", "91001-1234", "91001, California"])
def test_zip_codes_are_matched_locally(client: TestClient, upstream: Upstream, q: str) -> None:
    body = local(client, q)
    assert body["kind"] == "zip" and body["total_matches"] == 1
    (m,) = body["matches"]
    assert m["kind"] == "zip" and m["zip"] == "91001" and m["matched_address"] == "ZIP 91001, CA" and m["exact"] is True
    assert m["name"] == "ZIP 91001, CA" and m["state"] == "CA" and m["state_name"] == "California" and m["supported"] is True
    assert m["county"] == "Los Angeles County"
    assert m["lat"] == pytest.approx(34.1945, abs=1e-3) and m["lon"] == pytest.approx(-118.1383, abs=1e-3)
    assert m["near"] == "Altadena" and m["near_km"] < 2 and m["land_km2"] > 10
    assert "ZIP Code Tabulation Areas" in body["note"] and "PO-box" in body["note"]
    assert upstream.calls == []


@pytest.mark.parametrize("q", ["83702", "83702 ID", "ID 83702", "83702, Idaho"])
def test_zip_codes_nationally(client: TestClient, upstream: Upstream, q: str) -> None:
    (m,) = local(client, q)["matches"]
    assert m["matched_address"] == "ZIP 83702, ID" and m["state"] == "ID" and m["county"] == "Ada County"
    assert m["near"] in ("Boise City", "Garden City") and m["supported"] is True
    assert upstream.calls == []


def test_a_zip_nobody_has_is_an_explained_empty_list(client: TestClient, upstream: Upstream) -> None:
    body = local(client, "00000")
    assert body["kind"] == "zip" and body["matches"] == []
    assert body["note"].startswith("No US city, town, county or ZIP code matches '00000'.")
    assert "e.g. 600 E Mariposa St, Altadena; Boise, ID; 83702" in body["note"]
    assert upstream.calls == []


@pytest.mark.parametrize("q", ["Altadena", "altadena, ca", "ALTADENA CA USA", "Altadena, California"])
def test_town_names_are_matched_locally(client: TestClient, upstream: Upstream, q: str) -> None:
    body = local(client, q)
    assert body["kind"] == "place"
    (m,) = body["matches"]
    assert m["kind"] == "place" and m["name"] == "Altadena, CA" and m["place_type"] == "cdp"
    assert m["place_type_label"] == "census-designated place" and m["matched_address"] == "Altadena, CA"
    assert m["exact"] is True and m["near"] is None and m["state"] == "CA" and m["county"] == "Los Angeles County"
    assert m["lat"] == pytest.approx(34.1922, abs=1e-3) and m["lon"] == pytest.approx(-118.1356, abs=1e-3)
    assert "internal point" in body["note"] and "house number" in body["note"]
    assert upstream.calls == []


def test_place_matching_folds_accents_synonyms_and_alternate_names(client: TestClient, upstream: Upstream) -> None:
    assert [m["name"] for m in local(client, "La Canada, CA")["matches"]] == ["La Cañada Flintridge, CA"]
    v = local(client, "Ventura, CA")["matches"]
    assert v[0]["name"] == "San Buenaventura (Ventura), CA" and v[0]["exact"] is True     # the name in parentheses
    assert local(client, "Paso Robles")["matches"][0]["name"] == "El Paso de Robles (Paso Robles), CA"
    assert [m["name"] for m in local(client, "Mt Shasta, CA")["matches"]] == ["Mount Shasta, CA"]
    assert [m["name"] for m in local(client, "Saint Helena, CA")["matches"]] == ["St. Helena, CA"]
    assert local(client, "California City")["matches"][0]["name"] == "California City, CA"
    assert upstream.calls == []


def test_place_ranking_and_same_named_places(client: TestClient) -> None:
    la = local(client, "Los Angeles")["matches"]
    assert la[0]["name"] == "Los Angeles, CA" and la[0]["place_type"] == "city" and la[0]["exact"] is True
    # two places named Paradise in California (the Butte County town and a Mono County CDP): told apart by "near"
    para = [m for m in local(client, "Paradise, CA")["matches"] if m["exact"]]
    assert [(m["place_type"], m["near"]) for m in para] == [("town", "Chico"), ("cdp", "Bishop")]
    alta = local(client, "Alta, CA")["matches"]
    assert alta[0]["name"] == "Alta, CA" and alta[0]["exact"] and "Altadena, CA" in [m["name"] for m in alta]


@pytest.mark.parametrize("q", ["Springfield, IL", "Springfield IL", "Springfield, Illinois", "springfield il usa"])
def test_town_and_state(client: TestClient, upstream: Upstream, q: str) -> None:
    m = local(client, q)["matches"][0]
    assert m["name"] == "Springfield, IL" and m["state"] == "IL" and m["place_type"] == "city" and m["exact"]
    assert m["county"] == "Sangamon County" and m["supported"] is True
    assert upstream.calls == []


def test_bare_name_lists_the_largest_matches_across_states(client: TestClient) -> None:
    body = local(client, "Springfield")
    states = [m["state"] for m in body["matches"]]
    assert len(states) == geocode.PLACE_LIMIT and len(set(states)) >= 6 and body["total_matches"] > 8
    assert all(m["name"] == f"Springfield, {m['state']}" for m in body["matches"] if m["exact"])
    assert body["matches"][0]["place_type"] == "city"


def test_boise_county_and_alaska(client: TestClient, upstream: Upstream) -> None:
    b = local(client, "Boise, ID")["matches"][0]
    assert b["name"] == "Boise City, ID" and b["exact"] is True and b["state"] == "ID"     # Census's name; "Boise" alias
    assert b["lat"] == pytest.approx(43.598, abs=0.01) and b["lon"] == pytest.approx(-116.232, abs=0.01)
    ada = local(client, "Ada County, ID")["matches"][0]
    assert ada["name"] == "Ada County, ID" and ada["place_type"] == "county" and ada["county"] == "Ada County"
    ak = local(client, "Anchorage, AK")
    a = ak["matches"][0]
    assert a["state"] == "AK" and a["supported"] is False
    assert a["note"] == "Fire-3d does not support Alaska, Hawaii or US territories yet."
    assert "Fire-3d does not support Alaska, Hawaii or US territories yet." in ak["note"]
    nash = local(client, "Nashville, TN")["matches"][0]
    assert nash["name"] == "Nashville-Davidson, TN" and nash["exact"]
    assert upstream.calls == []


def test_a_town_with_its_zip_lists_both(client: TestClient) -> None:
    body = local(client, "Altadena, CA 91001")
    assert body["kind"] == "place" and [m["kind"] for m in body["matches"]] == ["place", "zip"] and body["total_matches"] == 2


@pytest.mark.parametrize("q", ["Pasadena City Hall", "Main St, Altadena", "Nowhereville"])
def test_landmarks_and_streets_without_numbers_are_not_searched(client: TestClient, upstream: Upstream, q: str) -> None:
    body = local(client, q)
    assert body["matches"] == [] and body["total_matches"] == 0
    assert body["note"].startswith(f"No US city, town, county or ZIP code matches '{q}'.")
    assert "Landmarks, businesses and street names without a house number are not searched" in body["note"]
    assert upstream.calls == []


def test_street_addresses_still_go_to_the_census(client: TestClient, upstream: Upstream) -> None:
    body = client.get("/api/geocode", params={"q": "600 E Mariposa St, Altadena, CA 91001"}).json()
    assert body["kind"] == "address" and body["local"] is False and body["matches"][0]["kind"] == "address"
    assert len(upstream.calls) == 1


@pytest.mark.parametrize(("q", "street"), [("600 E Mariposa St", True), ("N1234 County Rd 5", True), ("100-12 Main St", True),
                                           ("91001 CA", True), ("Altadena", False), ("29", False), ("1 A", False)])
def test_street_address_rule(q: str, street: bool) -> None:
    assert geocode.looks_like_street_address(q) is street    # "91001 CA" is caught as a ZIP before this rule


def test_missing_index_is_503_for_towns_but_addresses_work(client: TestClient, upstream: Upstream, monkeypatch, tmp_path) -> None:
    monkeypatch.setattr(geocode, "GAZETTEER_PATH", tmp_path / "missing.json")
    geocode.reset_gazetteer()
    try:
        r = client.get("/api/geocode", params={"q": "Altadena"})
        assert r.status_code == 503 and "house number" in r.json()["detail"] and r.headers["cache-control"] == "no-store"
        assert client.get("/api/geocode", params={"q": "91001"}).status_code == 503
        assert client.get("/api/geocode", params={"q": "600 E Mariposa St, Altadena, CA"}).status_code == 200
    finally:
        geocode.reset_gazetteer()


def test_split_local() -> None:
    assert geocode.split_local("Altadena, CA 91001-1234") == (("altadena",), "91001")
    assert geocode.split_local("California") == (("california",), None)     # a state word alone is kept
    assert geocode.split_local("CA 91001") == ((), "91001")
    assert geocode.split_local("Mount Shasta, Calif.") == (("mt", "shasta"), None)
    assert geocode.split_query("Springfield, IL") == (("springfield",), None, "IL")
    assert geocode.split_query("Springfield IL") == (("springfield",), None, "IL")
    assert geocode.split_query("83702 ID") == ((), "83702", "ID")
    assert geocode.split_query("ID 83702") == ((), "83702", "ID")
    assert geocode.split_query("New York, New York") == (("new", "york"), None, "NY")
    assert geocode.split_query("Washington, DC") == (("washington",), None, "DC")
    assert geocode.split_query("Washington") == (("washington",), None, None)
    assert geocode.split_query("Kansas City, Kansas") == (("kansas", "city"), None, "KS")


# ------------------------------------------------------------------------------------------------------------------
# scripts/build_gazetteer.py (offline, synthetic rows in both delimiter styles)
# ------------------------------------------------------------------------------------------------------------------
def _build_module():
    import importlib.util
    from pathlib import Path

    path = Path(__file__).resolve().parents[1] / "scripts" / "build_gazetteer.py"
    spec = importlib.util.spec_from_file_location("build_gazetteer", path)
    mod = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(mod)
    return mod


def test_build_gazetteer_parses_places_counties_and_zctas(tmp_path) -> None:
    b = _build_module()
    places = ("USPS|GEOID|GEOIDFQ|ANSICODE|NAME|LSAD|FUNCSTAT|ALAND|AWATER|ALAND_SQMI|AWATER_SQMI|INTPTLAT|INTPTLONG\n"
              "CA|0600884|x|y|Altadena CDP|57|S|21900000|0|8.4|0|34.192212|-118.135589\n"
              "CA|0656000|x|y|Pasadena city|25|A|59470000|0|22.9|0|34.160602|-118.137954\n"
              "ID|1608830|x|y|Boise City city|25|A|225000000|0|86.9|0|43.598100|-116.231600\n"
              "TN|4752006|x|y|Nashville-Davidson metropolitan government (balance)|00|C|1232000000|0|475|0|36.172200|-86.784600\n"
              "AK|0203000|x|y|Anchorage municipality|37|A|4415000000|0|1704|0|61.174900|-149.284300\n")
    counties = ("USPS\tGEOID\tANSICODE\tNAME\tALAND\tAWATER\tALAND_SQMI\tAWATER_SQMI\tINTPTLAT\tINTPTLONG\n"
                "ID\t16001\tx\tAda County\t2725000000\t0\t1052\t0\t43.451500\t-116.244400\n")
    zctas = ("GEOID\tALAND\tAWATER\tALAND_SQMI\tAWATER_SQMI\tINTPTLAT\tINTPTLONG\n"      # tab style (older vintages)
             "91001\t21400000\t0\t8.3\t0\t34.194500\t-118.138300\n"
             "10001\t1600000\t0\t0.6\t0\t40.750000\t-73.997000\n"
             "99501\t1000\t0\t0\t0\t61.21\t-149.87\n"                                # Alaska: by its ZIP prefix
             "96201\t1000\t0\t0\t0\t10.0\t-150.0\n")                                  # nowhere: dropped
    p, z = b.build(places, counties, zctas)
    assert [r[:3] for r in p] == [["Ada County", "county", "ID"], ["Altadena", "cdp", "CA"], ["Anchorage", "municipality", "AK"],
                                  ["Boise City", "city", "ID"], ["Nashville-Davidson", "city", "TN"], ["Pasadena", "city", "CA"]]
    assert p[1][3:] == [34.1922, -118.1356, 21.9, "Los Angeles County", None] and p[5][5] == 59.5
    assert p[3][7] == "Boise" and p[4][7] == "Nashville" and p[2][6] is None          # aliases; no county outside L48
    assert z == [["10001", "NY", 40.75, -73.997, 1.6], ["91001", "CA", 34.1945, -118.1383, 21.4], ["99501", "AK", 61.21, -149.87, 0.0]]
    out = tmp_path / "g.json"
    b.write(out, 2026, p, z)
    raw = orjson.loads(out.read_bytes())
    assert raw["vintage"] == 2026 and raw["counts"] == {"places": 6, "zips": 3} and raw["source"] == "U.S. Census Bureau Gazetteer Files"
    g = geocode.Gazetteer(raw)
    assert g.zips["91001"].lat == 34.1945 and g.zips["99501"].state == "AK"
    assert b._decode("Pi\xf1on".encode("latin-1")) == "Piñon"                      # Latin-1 fallback
