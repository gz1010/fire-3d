"""The national list on recorded samples (``tests/data/firedata/us_*``, PROVENANCE.md "Brief 3"): the California merge
regression set of CONTRACT 14.2, prescribed burns and complex parents, complex members outside California, POOState
mismatches, IRWIN lookups, the national FIRMS feed and the keyless Montana archive. Offline."""

from __future__ import annotations

import json
from pathlib import Path

import httpx
import pandas as pd
import pytest

import fire3d.http as fhttp
from fire3d import catalog, config
from fire3d.api import live
from fire3d.contracts import IncidentSummary, contract_problems
from fire3d.sources import firms, wfigs
from fire3d.timeutil import iso_to_ms
from test_us_catalog_mock import WfigsServer

DATA = Path(__file__).parent / "data" / "firedata"


def _load(name: str):
    return json.loads((DATA / name).read_text())


CURRENT = _load("us_wfigs_current.json")["features"]
YTD = _load("us_wfigs_ytd_2026.json")["features"]
CA_2025 = _load("us_wfigs_ca_2025.json")["features"]
IRWIN = _load("us_wfigs_irwin_889237.json")["features"] + _load("us_wfigs_irwin_95c3c8.json")["features"]
CAL_LIVE = _load("us_calfire_live.json")
CAL_POOL = _load("us_calfire_pool_2026.json") + _load("us_calfire_pool_2025.json")


def _cal_year(year: int) -> list[dict]:
    seen, out = set(), []
    for r in CAL_POOL:
        if str(r.get("Started") or "")[:4] == str(year) and r["UniqueId"] not in seen:
            seen.add(r["UniqueId"])
            out.append(r)
    return out


@pytest.fixture
def recorded(monkeypatch: pytest.MonkeyPatch, tmp_data_dir: Path):
    monkeypatch.setattr(fhttp, "BACKOFF_BASE_S", 0.001)
    monkeypatch.setattr(catalog, "default_year", lambda: 2026)
    srv = WfigsServer(current=list(CURRENT), ytd=list(YTD), all_years=list(CA_2025) + list(IRWIN))
    feed = (DATA / "us_firms_feed_24h.csv").read_text()

    def handler(request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        if "incidents.fire.ca.gov" in url:
            q = dict(request.url.params)
            if q.get("inactive") == "false":
                return httpx.Response(200, json=CAL_LIVE)
            return httpx.Response(200, json=_cal_year(int(q.get("year", 0))))
        if "services3.arcgis.com" in url:
            return srv.handle(request)
        if "/data/active_fire/" in url:
            return httpx.Response(200, text=feed if "SUOMI_VIIRS_C2" in url else feed.split("\n")[0] + "\n")
        if "/data/country/viirs-snpp/2024/" in url:
            return httpx.Response(200, text=(DATA / "us_viirs_snpp_sp_mt_2024.csv").read_text())
        if "/data/country/modis/2024/" in url:
            return httpx.Response(200, text=(DATA / "us_viirs_snpp_sp_mt_2024.csv").read_text().split("\n")[0] + "\n")
        return httpx.Response(404)

    monkeypatch.setattr(fhttp, "_transport", httpx.MockTransport(handler))
    catalog.clear_cache()
    yield srv
    catalog.clear_cache()


def _norm(features: list[dict]) -> list[dict]:
    return [r for r in (wfigs.normalize(f) for f in features) if r is not None]


# ------------------------------------------------------------------------------------------------------------------
# California merge regression set (CONTRACT 14.2; B 5)
# ------------------------------------------------------------------------------------------------------------------
def test_merge_2025_counts_and_cases(recorded) -> None:
    from fire3d.sources.calfire import normalize_incident

    wf = [r for r, st in catalog.dedupe_wfigs(catalog._wfigs_rows(_norm(CA_2025))) if st == "CA"]
    pool = [r for r in (normalize_incident(x) for x in _cal_year(2025) + _cal_year(2024)) if (r["type"] or "").lower() in catalog.FIRE_TYPES]
    matched, members, unmatched = catalog.merge_california(wf, pool)
    by_uid = {r["uid"]: r["name"] for r in pool}
    member_names = {by_uid[u]: sorted(w["source_name"] for w in ws) for u, ws in members.items()}
    assert member_names == {"Orleans Complex": ["Butler"], "Swift Complex": ["PEAK"],
                            "TCU September Lightning Complex": ["2-2", "2-7", "2-8", "6-2", "6-5"]}
    assert sorted(catalog.display_name(w["source_name"]) for w in unmatched) == ["Alpaugh", "Big Cliff"]   # added as WFIGS rows
    assert sum(len(v) for v in matched.values()) == len(wf) - 7 - 2 == 69
    matched_names = {by_uid[u]: [w["source_name"] for w in ws] for u, ws in matched.items()}
    assert any(n.upper().startswith("LOG") for n in matched_names["Log Fire"])                 # discovered 6 days earlier
    assert any(n.upper().startswith("GIANELLI") for n in matched_names["Gianelli Fire"])
    assert sorted(n.upper() for n in matched_names["Dale Fire"]) == ["BRADFORD BRANCH", "DALE"]  # any name, 2.1 km, same day


def test_dale_row_keeps_the_same_name_record(recorded) -> None:
    dale = next(r for r in catalog.get_catalog("historical", year=2025) if r.name == "Dale Fire")
    assert sorted(o.name.upper() for o in dale.other_records) == ["BRADFORD BRANCH", "DALE"]
    assert dale.irwin_id == next(o.id for o in dale.other_records if o.name.upper() == "DALE")


def test_historical_2025_list(recorded) -> None:
    rows = catalog.get_catalog("historical", year=2025)
    ca = [r for r in rows if r.state == "CA"]
    assert {r.name for r in ca if r.record_source == "wfigs"} == {"Alpaugh", "Big Cliff"}
    tcu = next(r for r in ca if r.name.startswith("TCU September Lightning Complex"))
    assert tcu.irwin_id is None and tcu.record_source == "calfire" and tcu.acres == 13869.0
    assert sorted(tcu.complex_members) == ["2-2", "2-7", "2-8", "6-2", "6-5"]
    assert sorted(o.name for o in tcu.other_records) == ["2-2", "2-7", "2-8", "6-2", "6-5"]
    assert all(o.source == "wfigs" and o.issuer.endswith("NIFC WFIGS") or o.issuer == "NIFC WFIGS (IRWIN)" for o in tcu.other_records)
    assert tcu.gacc == "OSCC" and tcu.accuracy_region == "OSCC"
    assert not any(r.name in ("2-2", "2-7", "Butler", "Peak", "Bradford Branch") for r in rows)
    assert all(not contract_problems(IncidentSummary, r) for r in rows)
    assert len({r.id for r in rows}) == len(rows)


def test_timber_mccovey_and_marshall_2026(recorded) -> None:
    live_rows = catalog.get_catalog("live")
    by = {r.name: r for r in live_rows}
    timber = by["Timber Fire"]
    assert timber.record_source == "calfire" and timber.is_active and timber.active_sources == ["wfigs"]
    assert timber.other_records[0].source == "wfigs" and timber.other_records[0].is_active
    assert sum(1 for r in live_rows if r.state == "CA" and "timber" in r.name.lower()) == 1    # (Timberlin, IN is another fire)
    mc = by["McCovey"]
    assert mc.record_source == "wfigs" and mc.state == "CA"
    assert "Marshall Fire" not in by                                            # CAL FIRE's Marshall stays separate
    hist = {r.name: r for r in catalog.get_catalog("historical", year=2026, min_acres=0)}
    assert "Marshall Fire" in hist and not hist["Marshall Fire"].other_records
    assert all(r.state in ("CA",) or r.record_source == "wfigs" for r in live_rows)
    assert len(live_rows) >= 150 and len({r.state for r in live_rows}) >= 20


def test_prescribed_burns_and_complex_parents_never_listed(recorded) -> None:
    recorded.current = list(CURRENT)                                           # RX + CX rows served regardless
    rx_cx = [f for f in CURRENT + YTD if f["attributes"]["IncidentTypeCategory"] in ("RX", "CX")]
    assert {f["attributes"]["IncidentTypeCategory"] for f in rx_cx} == {"RX", "CX"}
    rows = catalog._wfigs_rows(_norm(CURRENT + YTD))                          # the client-side filter
    ids = {r["irwin_id"] for r, _ in rows}
    assert not ids & {wfigs.clean_irwin(f["attributes"]["IrwinID"]) for f in rx_cx}
    listed = {r.uid for r in catalog.get_catalog("live") + catalog.get_catalog("historical", year=2026)}
    assert not listed & {wfigs.clean_irwin(f["attributes"]["IrwinID"]) for f in rx_cx}


def test_complex_member_outside_california_listed_on_its_own(recorded) -> None:
    rows = catalog.get_catalog("historical", year=2026)
    hay = [r for r in rows if r.complex_name and "Hay Creek" in r.complex_name]
    assert hay and all(r.state == "OR" and r.record_source == "wfigs" and r.complex_name == "Hay Creek Complex" for r in hay)


def test_poostate_mismatches_are_kept(recorded) -> None:
    from fire3d import regions

    feats = {f["attributes"]["IncidentName"] + "/" + f["attributes"]["POOState"]: f for f in YTD}
    for key, st in (("Paradise/US-OR", "OR"), ("Zamora Bend/US-TX", "TX"), ("Sharpe/US-CO", "CO")):
        rec = wfigs.normalize(feats[key])
        assert catalog.wfigs_state(rec) == st, key
        s = catalog.summary_from_wfigs(rec, "historical", set())
        assert s.state == st and s.time_zone, key
    sharpe = wfigs.normalize(feats["Sharpe/US-CO"])
    assert regions.state_at(sharpe["lon"], sharpe["lat"]) == "OK"           # the point lies in Oklahoma
    rows = {r.uid for r in catalog.get_catalog("historical", year=2026)}
    for key in ("Paradise/US-OR", "Sharpe/US-CO"):
        assert wfigs.clean_irwin(feats[key]["attributes"]["IrwinID"]) in rows, key


def test_ids_from_irwin_and_ufi_year_and_summary_without_bundle(recorded) -> None:
    s = catalog.get_summary("2024-horse-gulch-889237")
    assert s is not None and s.record_source == "wfigs" and s.state == "MT" and s.time_zone == "America/Denver"
    assert s.uid.startswith("889237AA") and s.unique_fire_id == "2024-MTHLF-000367" and s.mode == "historical"
    assert s.bundle_status == "none" and s.accuracy_region == accuracy(s)
    bc = catalog.resolve_listed("2025-black-cove-95c3c8")
    assert bc is not None and bc.state == "NC" and bc.time_zone == "America/New_York" and bc.year == 2025
    assert catalog.resolve_listed("fixture-demo") is None
    assert catalog.find_by_irwin("{889237aa-38dc-45d4-a8d0-b70d8990f5b7}").id == "2024-horse-gulch-889237"


def accuracy(s: IncidentSummary) -> str | None:
    return catalog.accuracy_region_for(s.gacc, s.state)


# ------------------------------------------------------------------------------------------------------------------
# National FIRMS (CONTRACT 14.12.1) on the recorded feed and archive rows
# ------------------------------------------------------------------------------------------------------------------
def test_recorded_feed_box(recorded) -> None:
    from fire3d import regions

    raw = pd.read_csv(DATA / "us_firms_feed_24h.csv")
    df = firms.load_live_us(1)
    kept = set(zip(df["lat"].round(5), df["lon"].round(5)))
    for la, lo in zip(raw["latitude"], raw["longitude"]):
        hi_or_ak = la < 23.0 or la > 51.0
        assert ((round(la, 5), round(lo, 5)) in kept) != hi_or_ak, (la, lo)
    states = {regions.state_at(lo, la, max_km=0.0) for la, lo in kept}
    assert {"TX", "FL", "ME"} <= states and None in states                    # border rows outside the states kept
    assert live._count_24h(df.assign(t_ms=pd.Timestamp.now(tz="UTC").value // 10**6), lower48=True) == sum(
        1 for la, lo in kept if regions.in_lower48([lo], [la])[0])


def test_keyless_montana_archive(recorded, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(config, "FIRMS_MAP_KEY", None)
    box = (-111.9, 46.6, -111.5, 46.8)
    df = firms.detections_for(box, iso_to_ms("2024-07-09T00:00:00Z"), iso_to_ms("2024-07-12T00:00:00Z"), "historical")
    assert len(df) == 3 and set(df["source"]) == {"VIIRS_SNPP_SP"}
    pq = Path(config.CACHE_DIR) / "firms" / "firms_us_2024.parquet"
    assert pq.is_file() and not list(pq.parent.glob("firms_ca_*"))


def test_auto_build_candidates_on_the_recorded_national_list(recorded) -> None:
    rows = catalog.get_catalog("live")
    big = [r for r in rows if (r.acres or 0) >= 100 and r.state != "CA"][:6]
    now = pd.Timestamp.now(tz="UTC").value // 10**6
    dets = pd.DataFrame([{"t_ms": now - 3600_000, "lat": r.lat, "lon": r.lon} for r in big for _ in range(3)])
    cands = live.auto_build_candidates(rows, dets)
    assert 1 <= len(cands) <= 4 and any(c in {r.id for r in big} for c in cands)
    assert all(next(r for r in rows if r.id == c).acres >= 100 for c in cands)
