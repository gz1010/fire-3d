"""sources/firms.py: parsing/normalisation of every FIRMS format, chunking, source planning, limiter use, key
masking and the keyless fallbacks (offline: recorded samples in tests/data/firedata + httpx.MockTransport)."""

from __future__ import annotations

import re
from datetime import date, datetime, timezone
from pathlib import Path

import httpx
import numpy as np
import pandas as pd
import pytest

import fire3d.http as fhttp
from fire3d import config
from fire3d.sources import firms
from fire3d.timeutil import DAY_MS, HOUR_MS, iso_to_ms, now_ms

DATA = Path(__file__).parent / "data" / "firedata"
FAKE_KEY = "0123456789abcdef0123456789abcdef"
EATON_BBOX = (-118.25, 34.10, -117.95, 34.30)


def sample(name: str) -> str:
    return (DATA / name).read_text()


def utc_day(ms: int) -> str:
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).date().isoformat()


@pytest.fixture(autouse=True)
def _fake_key(monkeypatch: pytest.MonkeyPatch) -> None:
    """Never use the real MAP_KEY in tests."""
    monkeypatch.setattr(config, "FIRMS_MAP_KEY", FAKE_KEY)


class Router:
    """MockTransport handler: (regex on the URL, response body or callable) rules; records requests."""

    def __init__(self, rules: list[tuple[str, object]]):
        self.rules = rules
        self.calls: list[str] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        self.calls.append(url)
        for pat, resp in self.rules:
            if re.search(pat, url):
                r = resp(request) if callable(resp) else resp
                if isinstance(r, httpx.Response):
                    return r
                return httpx.Response(200, text=str(r), headers={"content-type": "text/plain"})
        return httpx.Response(404, text="no route")


@pytest.fixture
def route(monkeypatch: pytest.MonkeyPatch, tmp_data_dir: Path):
    monkeypatch.setattr(fhttp, "BACKOFF_BASE_S", 0.001)
    limiter = fhttp.RateLimiter(1000, 600)
    monkeypatch.setattr(fhttp, "firms_limiter", limiter)

    def install(rules: list[tuple[str, object]]) -> Router:
        r = Router(rules)
        r.limiter = limiter  # type: ignore[attr-defined]
        monkeypatch.setattr(fhttp, "_transport", httpx.MockTransport(r))
        return r

    return install


AVAIL = ("data_id,min_date,max_date\nMODIS_NRT,2026-08-01,2026-10-17\nMODIS_SP,2000-11-01,2026-07-31\n"
         "VIIRS_NOAA20_NRT,2026-07-01,2026-10-16\nVIIRS_NOAA20_SP,2018-04-01,2026-06-30\nVIIRS_NOAA21_SP,2023-03-01,2026-06-30\n"
         "VIIRS_NOAA21_NRT,2024-01-17,2026-10-16\nVIIRS_SNPP_NRT,2026-07-01,2026-10-16\nVIIRS_SNPP_SP,2012-01-20,2026-06-30\n"
         "LANDSAT_NRT,2022-06-20,2026-10-16\nGOES_NRT,2022-08-09,2026-10-17\n")


def avail() -> dict[str, tuple[date, date]]:
    out = {}
    for ln in AVAIL.strip().splitlines()[1:]:
        k, a, b = ln.split(",")
        out[k] = (date.fromisoformat(a), date.fromisoformat(b))
    return out


# ------------------------------------------------------------------------------------------------------------------
# Parsing
# ------------------------------------------------------------------------------------------------------------------
def test_viirs_sp_rows_zfill_and_type_rule() -> None:
    df = firms.parse_firms_csv(sample("viirs_noaa20_sp.csv"), "VIIRS_NOAA20_SP")
    assert tuple(df.columns) == firms.FIRMS_COLUMNS
    assert df["t_ms"].dtype == np.int64 and df["type"].dtype == np.int64
    raw = pd.read_csv(DATA / "viirs_noaa20_sp.csv", dtype=str)
    assert len(raw) == 8 and len(df) == 7                        # the type-1 (volcano) row is dropped
    assert set(df["type"]) == {0, 2, 3}                           # static (2) and offshore (3) rows are kept
    # "949" is 09:49 UTC, not 94:9 or 00:09
    assert iso_to_ms("2025-01-08T09:49:00Z") in set(df["t_ms"])
    assert (raw["acq_time"].str.len() < 4).any()
    assert set(df["satellite"]) == {"N20"} and set(df["instrument"]) == {"VIIRS"}
    assert set(df["confidence"]) <= {"l", "n", "h"} and set(df["source"]) == {"VIIRS_NOAA20_SP"}
    assert df["scan"].between(0.3, 0.9).all() and df["frp"].notna().all()


def test_modis_sp_numeric_confidence() -> None:
    df = firms.parse_firms_csv(sample("modis_sp.csv"), "MODIS_SP")
    assert len(df) == 5 and set(df["instrument"]) == {"MODIS"}
    assert set(df["satellite"]) <= {"Terra", "Aqua"}
    assert all(c.isdigit() and 0 <= int(c) <= 100 for c in df["confidence"])
    assert df["t_ms"].iloc[0] == iso_to_ms("2025-01-08T04:41:00Z")    # acq_time "441"


def test_goes_frp_rows_dropped_confidence_mapped_and_daynight() -> None:
    raw = pd.read_csv(DATA / "goes_nrt.csv", dtype=str)
    df = firms.parse_firms_csv(sample("goes_nrt.csv"), "GOES_NRT")
    assert raw["satellite"].str.endswith("FRP").sum() == 2
    assert len(df) == len(raw) - 2 and not df["satellite"].str.endswith("FRP").any()
    assert set(df["satellite"]) == {"G16", "G18"} and set(df["instrument"]) == {"GOES"}
    # FDC mask 30 = temporally filtered processed fire pixel -> 100 (passes the SPEC "GOES < 50" filter)
    assert set(df["confidence"]) == {"100"}
    assert firms.quality_mask(df).all()
    # acq_time "20" -> 00:20 UTC, i.e. 16:20 PST: the sun is up; FIRMS says "D" for every GOES row anyway
    assert df["t_ms"].iloc[0] == iso_to_ms("2025-01-09T00:20:00Z")
    assert (df["scan"] == firms.GOES_FOOTPRINT_KM).all() and (df["track"] == firms.GOES_FOOTPRINT_KM).all()
    assert set(df["type"]) == {-1}


def test_goes_daynight_recomputed_at_night() -> None:
    body = ("latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,instrument,confidence,version,bright_ti5,frp,daynight\n"
            "34.17609,-118.106422,-999,1005,3529,2025-01-08,230,G18,,10.0000,1.0NRT,-999,146.511,D\n"
            "34.17609,-118.106422,-999,1005,3529,2025-01-08,2000,G18,,30.0000,1.0NRT,-999,146.511,D\n"
            "34.17609,-118.106422,-999,1005,3529,2025-01-08,2000,G18,,15.0000,1.0NRT,-999,146.511,D\n")
    df = firms.parse_firms_csv(body, "GOES_NRT")
    assert list(df["daynight"]) == ["N", "D", "D"]                 # 18:30 PST is after sunset; 12:00 PST is day
    assert list(df["confidence"]) == ["100", "100", "20"]          # 15 = low-probability fire pixel


def test_landsat_rows() -> None:
    df = firms.parse_firms_csv(sample("landsat_nrt.csv"), "LANDSAT_NRT")
    assert len(df) == 4 and set(df["instrument"]) == {"LANDSAT"} and set(df["satellite"]) == {"L9"}
    assert df["frp"].isna().all()                                  # Landsat has no FRP
    assert set(df["confidence"]) <= {"l", "m", "h"}
    assert (df["scan"] == 0.03).all()                               # path/row pixel indices replaced by 30 m


def test_live_feed_words_and_satellite_codes() -> None:
    v = firms.parse_firms_csv(sample("viirs_snpp_feed.csv"), "VIIRS_SNPP_NRT")
    assert set(v["confidence"]) == {"n", "l", "h"}                  # "nominal"/"low"/"high" in the 7d feeds
    assert set(v["satellite"]) == {"N"} and set(v["type"]) == {-1}
    m = firms.parse_firms_csv(sample("modis_feed.csv"), "MODIS_NRT")
    assert set(m["satellite"]) == {"Terra", "Aqua"}                 # "T"/"A" in the feeds


def test_error_text_is_rejected_and_masked() -> None:
    with pytest.raises(firms.FirmsError) as ei:
        firms.parse_firms_csv(f"Invalid MAP_KEY {FAKE_KEY}.", "VIIRS_SNPP_SP")
    assert FAKE_KEY not in str(ei.value) and "***" in str(ei.value)
    assert len(firms.parse_firms_csv("latitude,longitude,acq_date,acq_time\n", "MODIS_SP")) == 0


def test_quality_mask_spec_thresholds() -> None:
    df = pd.DataFrame({"instrument": ["VIIRS", "VIIRS", "MODIS", "MODIS", "GOES", "GOES", "LANDSAT"],
                       "confidence": ["l", "n", "29", "30", "40", "60", "l"]})
    assert list(firms.quality_mask(df)) == [False, True, False, True, False, True, True]


def test_solar_elevation_sanity() -> None:
    noon = firms.solar_elevation_deg(iso_to_ms("2025-06-21T20:00:00Z"), 34.2, -118.1)      # 13:00 PDT
    night = firms.solar_elevation_deg(iso_to_ms("2025-06-21T08:00:00Z"), 34.2, -118.1)
    assert 75 < float(noon) < 80 and float(night) < -10


# ------------------------------------------------------------------------------------------------------------------
# Chunking + planning
# ------------------------------------------------------------------------------------------------------------------
def test_day_chunks() -> None:
    s, e = iso_to_ms("2025-01-07T18:00:00Z"), iso_to_ms("2025-01-18T03:00:00Z")      # touches Jan 7 .. Jan 18
    assert firms.day_chunks(s, e, 5) == [("2025-01-07", 5), ("2025-01-12", 5), ("2025-01-17", 2)]
    assert firms.day_chunks(s, e, 2)[:2] == [("2025-01-07", 2), ("2025-01-09", 2)]
    assert sum(n for _, n in firms.day_chunks(s, e, 2)) == 12
    one = iso_to_ms("2025-01-07T01:00:00Z")
    assert firms.day_chunks(one, one, 5) == [("2025-01-07", 1)]
    assert firms.day_chunks(e, s, 5) == []


def test_format_bbox_rounds_outward() -> None:
    assert firms.format_bbox((-118.2449, 34.1051, -117.9501, 34.2999)) == "-118.25,34.10,-117.95,34.30"
    assert firms.format_bbox(EATON_BBOX) == "-118.25,34.10,-117.95,34.30"
    with pytest.raises(ValueError):
        firms.format_bbox((1, 2, 1, 3))


def test_plan_sources_historical_and_live() -> None:
    a = avail()
    s, e = iso_to_ms("2025-01-07T00:00:00Z"), iso_to_ms("2025-01-12T23:00:00Z")
    hist = {src for src, _, _ in firms.plan_sources(s, e, "historical", a)}
    assert hist == {"VIIRS_SNPP_SP", "VIIRS_NOAA20_SP", "VIIRS_NOAA21_SP", "MODIS_SP", "GOES_NRT", "LANDSAT_NRT"}
    # live fire that started before the NRT coverage of SNPP/NOAA-20 (2026-07-01): SP before, NRT after
    s2, e2 = iso_to_ms("2026-06-25T00:00:00Z"), iso_to_ms("2026-07-05T00:00:00Z")
    live = firms.plan_sources(s2, e2, "live", a)
    snpp = [(src, a_, b_) for src, a_, b_ in live if "SNPP" in src]
    assert [x[0] for x in snpp] == ["VIIRS_SNPP_NRT", "VIIRS_SNPP_SP"]
    nrt_start = iso_to_ms("2026-07-01T00:00:00Z")
    assert snpp[0][1] == nrt_start and snpp[1][2] == nrt_start - 1
    assert any(src == "VIIRS_NOAA21_NRT" and a_ == s2 for src, a_, _ in live)       # N21 NRT from 2024
    # historical window past the SP coverage continues with NRT
    s3, e3 = iso_to_ms("2026-06-28T00:00:00Z"), iso_to_ms("2026-07-03T00:00:00Z")
    h3 = [(src, a_, b_) for src, a_, b_ in firms.plan_sources(s3, e3, "historical", a) if "NOAA20" in src]
    assert [x[0] for x in h3] == ["VIIRS_NOAA20_SP", "VIIRS_NOAA20_NRT"]
    only = firms.plan_sources(s, e, "historical", a, instruments=("VIIRS",), families=("SNPP", "NOAA20"))
    assert {src for src, _, _ in only} == {"VIIRS_SNPP_SP", "VIIRS_NOAA20_SP"}
    # GOES does not exist before 2022-08-09
    old = firms.plan_sources(iso_to_ms("2020-08-01T00:00:00Z"), iso_to_ms("2020-08-03T00:00:00Z"), "historical", a)
    assert "GOES_NRT" not in {src for src, _, _ in old}


def test_nrt_coverage_is_open_ended() -> None:
    a = avail()                                   # NRT "max_date" is just the newest day when it was fetched
    now = now_ms()
    chunks = firms.area_chunks("VIIRS_NOAA20_NRT", EATON_BBOX, now - 2 * DAY_MS, now, a)
    last = chunks[-1]
    last_day = (date.fromisoformat(last.day).toordinal() + last.days - 1)
    assert last_day == date.fromisoformat(utc_day(now)).toordinal()             # today is requested too


def test_chunk_ttls_and_goes_chunk_size() -> None:
    a = avail()
    sp = firms.area_chunks("VIIRS_SNPP_SP", EATON_BBOX, iso_to_ms("2025-01-07T00:00:00Z"), iso_to_ms("2025-01-12T00:00:00Z"), a)
    assert [c.days for c in sp] == [5, 1] and all(c.ttl_s == firms.TTL_IMMUTABLE_S for c in sp)
    goes_old = firms.area_chunks("GOES_NRT", EATON_BBOX, iso_to_ms("2025-01-07T00:00:00Z"), iso_to_ms("2025-01-12T00:00:00Z"), a)
    assert [c.days for c in goes_old] == [1] * 6                    # archived GOES: 1-day requests
    now = now_ms()
    goes_new = firms.area_chunks("GOES_NRT", EATON_BBOX, now - 4 * DAY_MS, now, a)
    assert max(c.days for c in goes_new) == 2
    assert goes_new[-1].ttl_s == firms.TTL_RECENT_NRT_S             # touches the last 48 h
    assert goes_new[0].ttl_s in (firms.TTL_IMMUTABLE_S, firms.TTL_RECENT_NRT_S)
    unknown = firms.area_chunks("VIIRS_SNPP_SP", EATON_BBOX, iso_to_ms("2025-01-07T00:00:00Z"), iso_to_ms("2025-01-08T00:00:00Z"), None)
    assert all(c.ttl_s == firms.TTL_UNCERTAIN_S for c in unknown)


# ------------------------------------------------------------------------------------------------------------------
# Area API through fire3d.http (mocked)
# ------------------------------------------------------------------------------------------------------------------
def test_fetch_area_requests_limiter_and_cache(route) -> None:
    viirs = sample("viirs_noaa20_sp.csv")
    r = route([(r"/api/area/csv/", viirs)])
    s, e = iso_to_ms("2025-01-07T00:00:00Z"), iso_to_ms("2025-01-12T23:59:59Z")
    df = firms.fetch_area("VIIRS_NOAA20_SP", EATON_BBOX, s, e, availability=avail(), max_workers=1)
    paths = sorted(httpx.URL(u).path for u in r.calls)
    assert paths == [f"/api/area/csv/{FAKE_KEY}/VIIRS_NOAA20_SP/-118.25,34.10,-117.95,34.30/1/2025-01-12",
                     f"/api/area/csv/{FAKE_KEY}/VIIRS_NOAA20_SP/-118.25,34.10,-117.95,34.30/5/2025-01-07"]
    assert r.limiter.remaining() == 1000 - 2                        # every area request took a limiter slot
    assert len(df) == 7                                              # same rows in both chunks -> deduplicated
    assert df.attrs["sources"][0]["requests"] == 2 and df.attrs["warnings"] == []
    firms.fetch_area("VIIRS_NOAA20_SP", EATON_BBOX, s, e, availability=avail())
    assert len(r.calls) == 2 and r.limiter.remaining() == 998       # cache hits are free
    cached = list((Path(config.CACHE_DIR) / "http").rglob("*.json"))
    assert cached and all(FAKE_KEY not in p.read_text() for p in cached)


def test_fetch_area_error_text_is_evicted_and_masked(route) -> None:
    r = route([(r"/api/area/csv/", f"Invalid MAP_KEY {FAKE_KEY}")])
    s = iso_to_ms("2025-01-07T00:00:00Z")
    with pytest.raises(firms.FirmsError) as ei:
        firms.fetch_area("MODIS_SP", EATON_BBOX, s, s + HOUR_MS, availability=avail())
    assert FAKE_KEY not in str(ei.value) and "***" in str(ei.value)
    assert not list((Path(config.CACHE_DIR) / "http").rglob("*.bin"))   # the 200 error page was not kept
    with pytest.raises(firms.FirmsError):
        firms.fetch_area("MODIS_SP", EATON_BBOX, s, s + HOUR_MS, availability=avail())
    assert len(r.calls) == 2


def test_fetch_area_without_key(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(config, "FIRMS_MAP_KEY", None)
    with pytest.raises(firms.FirmsKeyMissing):
        firms.fetch_area("MODIS_SP", EATON_BBOX, 0, 1)
    assert firms.data_availability() == {} and firms.mapkey_status() is None


def test_detections_for_historical_with_key(route) -> None:
    files = {"VIIRS_SNPP_SP": "viirs_noaa20_sp.csv", "VIIRS_NOAA20_SP": "viirs_noaa20_sp.csv", "VIIRS_NOAA21_SP": "viirs_noaa20_sp.csv",
             "MODIS_SP": "modis_sp.csv", "GOES_NRT": "goes_nrt.csv", "LANDSAT_NRT": "landsat_nrt.csv"}

    def area(request: httpx.Request) -> httpx.Response:
        src = request.url.path.split("/")[5]
        body = sample(files[src])
        if src == "VIIRS_SNPP_SP":                     # pretend this one is Suomi NPP data
            body = body.replace(",N20,", ",N,")
        return httpx.Response(200, text=body)

    r = route([(r"/api/data_availability/", AVAIL), (r"/api/area/csv/", area)])
    s, e = iso_to_ms("2025-01-07T00:00:00Z"), iso_to_ms("2025-01-15T00:00:00Z")
    df = firms.detections_for((-118.8, 33.9, -117.8, 34.4), s, e, "historical")
    assert tuple(df.columns) == firms.FIRMS_COLUMNS
    assert set(df["instrument"]) == {"VIIRS", "MODIS", "GOES", "LANDSAT"}
    assert {x["source"] for x in df.attrs["sources"]} == {"VIIRS_SNPP_SP", "VIIRS_NOAA20_SP", "VIIRS_NOAA21_SP", "MODIS_SP", "GOES_NRT", "LANDSAT_NRT"}
    assert df["t_ms"].is_monotonic_increasing and df["t_ms"].between(s, e).all()
    assert not df["satellite"].str.endswith("FRP").any() and (df["type"] != 1).all()
    area_calls = [u for u in r.calls if "/api/area/" in u]
    assert any("/GOES_NRT/" in u and "/1/2025-01-07" in u for u in area_calls)


def test_detections_for_falls_back_when_every_request_fails(route, monkeypatch: pytest.MonkeyPatch) -> None:
    feed = sample("viirs_snpp_feed.csv")
    route([(r"/api/data_availability/", AVAIL), (r"/api/area/csv/", httpx.Response(403, text="Forbidden")),
           (r"/data/active_fire/", feed)])
    now = now_ms()
    df = firms.detections_for((-125.0, 32.0, -114.0, 42.0), now - 5 * DAY_MS, now, "live")
    assert any("keyless" in w for w in df.attrs["warnings"])
    assert all(s_["via"] == "csv_feed_7d" for s_ in df.attrs["sources"])


def test_load_live_us_keeps_the_lower_48_box(route) -> None:
    r = route([(r"SUOMI_VIIRS_C2", sample("viirs_snpp_feed.csv")), (r"J1_VIIRS_C2", sample("viirs_snpp_feed.csv").replace(",N,", ",N20,")),
               (r"J2_VIIRS_C2", httpx.Response(500)), (r"MODIS_C6_1", sample("modis_feed.csv"))])
    df = firms.load_live_us(1)
    assert all("_24h.csv" in u for u in r.calls)
    w, s, e, n = firms.L48_FIRMS_BOX
    assert df["lon"].between(w, e).all() and df["lat"].between(s, n).all()
    assert set(df["source"]) == {"VIIRS_SNPP_NRT", "VIIRS_NOAA20_NRT", "MODIS_NRT"}
    assert any("J2_VIIRS_C2" in x for x in df.attrs["warnings"])      # one feed down: partial data + warning
    route([(r"/data/active_fire/", httpx.Response(500))])
    firms_ = firms
    with pytest.raises(firms_.FirmsError):
        firms_.load_live_us(7, refresh=True)


def test_load_year_us_downloads_once_to_parquet(route, monkeypatch: pytest.MonkeyPatch) -> None:
    viirs = sample("viirs_noaa20_sp.csv").replace(",N20,", ",N,")
    viirs = viirs.replace("2025-01-08,949,N,VIIRS,n,2,", "2025-01-08,949,N,VIIRS,n,2.0NRT,", 1)
    far = "\n45.0,-73.0,300,0.4,0.4,2025-01-08,1000,N,VIIRS,n,2,290,1.0,N,0\n"
    r = route([(r"/data/country/viirs-snpp/2025/", viirs.rstrip("\n") + far), (r"/data/country/modis/2025/", sample("modis_sp.csv"))])
    df = firms.load_year_us(2025, config.CA_BBOX)                     # the national file, read in the CA box
    assert len(r.calls) == 2 and len(df) == 7 + 5                    # Quebec row outside the CA box, volcano dropped
    assert set(df["source"]) == {"VIIRS_SNPP_SP", "VIIRS_SNPP_NRT", "MODIS_SP"}
    pq = Path(config.CACHE_DIR) / "firms" / "firms_us_2025.parquet"   # brief 3: one national file per year
    assert pq.is_file() and not list((pq.parent / "raw").glob("*.csv"))
    assert not list(pq.parent.glob("firms_ca_*"))
    again = firms.load_year_us(2025, config.CA_BBOX)
    assert len(r.calls) == 2 and len(again) == len(df)
    national = firms.load_year_us(2025)
    assert len(national) == len(df) + 1                                # the Quebec-border row (45.0, -73.0) is kept


def test_keyless_detections_use_yearly_archive(route, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(config, "FIRMS_MAP_KEY", None)
    route([(r"/data/country/viirs-snpp/2025/", sample("viirs_noaa20_sp.csv").replace(",N20,", ",N,")),
           (r"/data/country/modis/2025/", sample("modis_sp.csv"))])
    s, e = iso_to_ms("2025-01-07T00:00:00Z"), iso_to_ms("2025-01-12T00:00:00Z")
    df = firms.detections_for(EATON_BBOX, s, e, "historical")
    assert len(df) > 0 and set(df["instrument"]) == {"VIIRS", "MODIS"}
    assert any("no FIRMS_MAP_KEY" in w for w in df.attrs["warnings"])
    viirs_only = firms.detections_for(EATON_BBOX, s, e, "historical", instruments=("VIIRS",))
    assert set(viirs_only["instrument"]) == {"VIIRS"}


def test_goes_window_straddling_the_archive_boundary() -> None:
    from datetime import timedelta

    now = now_ms()
    chunks = firms.area_chunks("GOES_NRT", EATON_BBOX, now - 40 * DAY_MS, now, avail())
    split = date.fromisoformat(utc_day(now - firms.GOES_ARCHIVE_AGE_MS))
    end_day = lambda c: date.fromisoformat(c.day).toordinal() + c.days            # exclusive
    assert all(c.days == 1 for c in chunks if end_day(c) <= split.toordinal())    # archived part: 1-day requests
    assert any(c.days == 2 for c in chunks if end_day(c) > split.toordinal())     # recent part: 2-day requests
    later = firms.area_chunks("GOES_NRT", EATON_BBOX, now - 40 * DAY_MS, now + 3 * DAY_MS, avail())
    assert [c.day for c in later if c.days == 2][:3] == [c.day for c in chunks if c.days == 2][:3]   # stable grid
    for a, b in zip(chunks, chunks[1:]):                                         # contiguous, no gaps or overlap
        assert (date.fromisoformat(a.day) + timedelta(days=a.days)).isoformat() == b.day
    assert sum(c.days for c in chunks) >= 40


def test_load_year_us_only_for_completed_years() -> None:
    with pytest.raises(firms.FirmsError, match="completed years"):
        firms.load_year_us(int(utc_day(now_ms())[:4]))
