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
        "matched_address": "600 E MARIPOSA ST, ALTADENA, CA, 91001", "lat": 34.189637, "lon": -118.1373939,
        "tiger_line_id": "142735412", "side": "R", "from_address": "600", "to_address": "628",
    }]
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


def test_numbers_only_is_400(client: TestClient, upstream: Upstream) -> None:
    r = client.get("/api/geocode", params={"q": "91001"})
    assert r.status_code == 400 and upstream.calls == []


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
