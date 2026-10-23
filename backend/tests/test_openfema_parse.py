"""sources/openfema.py: the IPAWS archive query and its parsing (CONTRACT 14.7), offline.

``tests/data/official/openfema_window_frw.json`` is a real OpenFEMA ``IpawsArchivedAlerts`` answer for the actual
messages sent 2026-10-09 21:00 to 2026-10-10 03:00 UTC (recorded 2026-10-23 by
``scripts/record_test_samples_official.py --only national``), cut to the in-scope messages plus one FFW, TOR, LEW
and one Cancel. Operators' sender addresses were replaced by a placeholder and ``originalMessage`` was cut to its
``<references>`` element; polygons are rounded to 4 decimals.
"""

from __future__ import annotations

import json
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

import httpx
import pytest

import fire3d.http as fhttp
from fire3d.sources import nws, openfema
from fire3d.timeutil import HOUR_MS, iso_to_ms

DATA = Path(__file__).parent / "data" / "official"
FEMA = json.loads((DATA / "openfema_window_frw.json").read_text())
ROWS = FEMA["IpawsArchivedAlerts"]


def test_scope_filter_on_the_recorded_window() -> None:
    parsed = openfema.parse_records(ROWS)
    codes = sorted(a["event_code"] for a in parsed)
    assert codes == ["FRW", "FRW", "FRW", "FRW", "FRW", "SPW"]          # weather alerts, LEW, non-fire LAE, Cancel out
    assert all(a["channel"] == "openfema_archive" and a["archived"] is True for a in parsed)
    assert not any("Long Beach" in (a["sender_name"] or "") for a in parsed)   # "Get sandbags-Fire Station 7"
    for a in parsed:
        assert "sender" not in a and a["source_url"].startswith("https://www.fema.gov/api/open/v1/IpawsArchivedAlerts?")


def test_law_enforcement_sample_keeps_only_its_event_code() -> None:
    """The LEW record is in the sample for the scope filter only; its texts are a neutral placeholder (it named a
    private person), and the recorder removes them the same way on a re-record."""
    import record_test_samples_official as rec

    lew = [inf for r in ROWS for inf in r.get("info") or []
           if any(e.get("value") == "LEW" for e in inf.get("eventCode") or [])]
    assert len(lew) == 1
    texts = [p["value"] for p in lew[0]["parameter"] if p["name"] in rec.TEXT_PARAMS]
    texts += [lew[0].get(k) for k in ("headline", "description", "instruction") if lew[0].get(k)]
    assert texts and all(t == rec.TEXT_REMOVED for t in texts)
    raw = {"info": [{"headline": "h", "description": "d", "instruction": "i", "eventCode": [{"value": "LEW"}],
                     "parameter": [{"name": "CMAMtext", "value": "x"}, {"name": "WEAHandling", "value": "Imminent Threat"}]}]}
    out = rec.remove_texts(raw)["info"][0]
    assert out["headline"] == out["description"] == out["instruction"] == rec.TEXT_REMOVED
    assert out["parameter"] == [{"name": "CMAMtext", "value": rec.TEXT_REMOVED}, {"name": "WEAHandling", "value": "Imminent Threat"}]


def test_kern_update_references_times_and_link() -> None:
    parsed = {a["id"]: a for a in openfema.parse_records(ROWS)}
    upd = next(a for a in parsed.values() if a["message_type"] == "Update")
    assert upd["references"] == ["2780357279770323"] and upd["references"][0] in parsed
    assert upd["sender_name"] == "Kern County OES" and upd["sender_is_platform"] is False
    assert upd["sent_ms"] == iso_to_ms("2026-10-09T22:01:50Z")
    assert upd["wea_text"] and "Cyrus Fire" in upd["wea_text"]
    assert upd["same_codes"] == ["006029"] and upd["_geom"] is not None and upd["polygon"]["type"] in ("Polygon", "MultiPolygon")
    url = upd["source_url"]
    assert url == f"{openfema.API_URL}?$filter=identifier%20eq%20%27{upd['id']}%27"
    assert parse_qs(urlsplit(url).query)["$filter"] == [f"identifier eq '{upd['id']}'"]


def test_message_without_polygon_keeps_its_county_codes() -> None:
    sh = next(a for a in openfema.parse_records(ROWS) if a["same_codes"] == ["056033"])
    assert sh["event_code"] == "FRW" and sh["_geom"] is None and sh["polygon"] is None
    assert sh["sender_name"] == "Sheridan County WY" and sh["wea_text"].startswith("SHERIDAN ALERTS")


def test_references_never_keep_the_sender_part() -> None:
    xml = ("<alert><references>ops@example.org,ID-1,2026-10-09T14:30:11-05:00 "
           "other@example.org,ID-2,2026-10-09T15:00:00-05:00</references></alert>")
    assert openfema.references_of(xml) == ["ID-1", "ID-2"]
    assert openfema.references_of("<cap:references>a@b,ID-3,2026</cap:references>") == ["ID-3"]
    assert openfema.references_of(None) == [] and openfema.references_of("<alert/>") == []


def test_language_and_platform_and_status() -> None:
    row = json.loads(json.dumps(next(r for r in ROWS if r["msgType"] == "Update")))
    es = json.loads(json.dumps(row["info"][0]))
    es["language"] = "es-US"
    es["headline"] = "Aviso"
    row["info"] = [es] + row["info"]
    assert openfema.parse_record(row)["headline"] != "Aviso"                 # the English info is used
    row["info"][1]["senderName"] = "Public Alert System"
    assert openfema.parse_record(row)["sender_is_platform"] is True
    row["status"] = "Exercise"
    assert openfema.parse_record(row) is None


def test_window_params_and_archive_window() -> None:
    a, b = iso_to_ms("2026-10-09T21:00:00Z"), iso_to_ms("2026-10-10T03:00:00Z")
    p = openfema.window_params(a, b, 2000)
    assert p["$filter"] == "status eq 'Actual' and sent ge '2026-10-09T21:00:00.000Z' and sent lt '2026-10-10T03:00:00.000Z'"
    assert p["$skip"] == "2000" and p["$top"] == "1000" and "originalMessage" not in p["$select"] and p["$orderby"] == "sent"
    r = openfema.window_params(a, b, refs=True)
    assert r["$select"] == "identifier,originalMessage" and r["$filter"].endswith(" and msgType ne 'Alert'")
    at = iso_to_ms("2026-10-10T00:30:00Z")
    lo, hi = openfema.archive_window(at)
    assert lo == iso_to_ms("2026-10-09T00:00:00Z") and hi == iso_to_ms("2026-10-10T02:00:00Z")
    assert lo <= at - 24 * HOUR_MS and hi >= at + HOUR_MS


def test_fetch_window_pages_and_errors(tmp_data_dir, monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        refs = "originalMessage" in request.url.params["$select"]
        rows = [r for r in ROWS if r["msgType"] != "Alert"] if refs else [{k: v for k, v in r.items() if k != "originalMessage"} for r in ROWS]
        if not refs:
            calls.append(request)
        skip = int(request.url.params["$skip"])
        page = rows[skip:skip + 10]
        return httpx.Response(200, json={"metadata": {"count": len(rows)}, "IpawsArchivedAlerts": page})

    monkeypatch.setattr(fhttp, "_transport", httpx.MockTransport(handler))
    monkeypatch.setattr(openfema, "PAGE_SIZE", 10)
    monkeypatch.setattr(openfema, "OPENFEMA_LIMITER", fhttp.RateLimiter(100, 60.0, "test"))
    a, b = iso_to_ms("2026-10-09T21:00:00Z"), iso_to_ms("2026-10-10T03:00:00Z")
    recs, fetched, truncated = openfema.fetch_window(a, b, now=iso_to_ms("2026-10-23T00:00:00Z"))
    assert len(recs) == len(ROWS) and not truncated and len(calls) == 2 and fetched > 0
    upd = next(r for r in recs if r["msgType"] == "Update")
    assert openfema.references_of(upd.get("originalMessage")) == ["2780357279770323"]        # merged from the 2nd query
    assert all("originalMessage" not in r for r in recs if r["msgType"] == "Alert")
    assert [c.url.params["$skip"] for c in calls] == ["0", "10"]
    assert all(c.url.params["$filter"].startswith("status eq 'Actual' and sent ge") for c in calls)
    openfema.fetch_window(a, b, now=iso_to_ms("2026-10-23T00:00:00Z"))
    assert len(calls) == 2                                                    # cached

    monkeypatch.setattr(fhttp, "_transport", httpx.MockTransport(lambda r: httpx.Response(503)))
    monkeypatch.setattr(fhttp, "BACKOFF_BASE_S", 0.001)
    with pytest.raises(nws.SourceError, match="could not be reached"):
        openfema.fetch_window(a + HOUR_MS, b, now=iso_to_ms("2026-10-23T00:00:00Z"))
    monkeypatch.setattr(fhttp, "_transport", httpx.MockTransport(lambda r: httpx.Response(200, json={"error": [{"name": "x"}]})))
    with pytest.raises(nws.SourceError, match="unexpected reply"):
        openfema.fetch_window(a + 2 * HOUR_MS, b, now=iso_to_ms("2026-10-23T00:00:00Z"))


def test_credit_notice_and_terms() -> None:
    assert openfema.CREDIT == "FEMA IPAWS archive via OpenFEMA"
    assert openfema.NOTICE == ("This product uses the Federal Emergency Management Agency's OpenFEMA API, but is not "
                               "endorsed by FEMA")
    assert openfema.TERMS_URL == "https://www.fema.gov/about/openfema/terms-conditions"
    assert openfema.SOURCE["credit"] == openfema.CREDIT and openfema.SOURCE["url"].startswith("https://")


# ----------------------------------------------------------------------------------------------------------------
# Incident windows, disk cache, background fetch (cut-line item a)
# ----------------------------------------------------------------------------------------------------------------
def test_incident_window_covers_the_record() -> None:
    now = iso_to_ms("2026-10-23T00:41:00Z")
    start, end = iso_to_ms("2025-03-22T18:00:00Z"), iso_to_ms("2025-04-10T00:00:00Z")
    w = openfema.incident_window(start, end, iso_to_ms("2025-03-25T12:00:00Z"), now)
    assert w == (iso_to_ms("2025-03-21T00:00:00Z"), iso_to_ms("2025-04-11T00:00:00Z"))
    assert openfema.incident_window(start, end, iso_to_ms("2025-04-01T00:00:00Z"), now) == w     # one window per fire
    live = openfema.incident_window(iso_to_ms("2026-10-15T20:00:00Z"), None, iso_to_ms("2026-10-20T00:00:00Z"), now)
    assert live == (iso_to_ms("2026-10-14T00:00:00Z"), iso_to_ms("2026-10-23T00:00:00Z"))       # up to today 00:00
    other = openfema.incident_window(start, end, iso_to_ms("2025-08-01T12:00:00Z"), now)          # outside the record
    assert other == (iso_to_ms("2025-07-31T00:00:00Z"), iso_to_ms("2025-08-02T00:00:00Z"))


def _fema_server(monkeypatch, handler) -> None:
    monkeypatch.setattr(fhttp, "_transport", httpx.MockTransport(handler))
    monkeypatch.setattr(fhttp, "BACKOFF_BASE_S", 0.001)
    monkeypatch.setattr(openfema, "OPENFEMA_LIMITER", fhttp.RateLimiter(100, 60.0, "test"))
    openfema.reset_state()


def test_ensure_fetches_in_the_background_and_stores_on_disk(tmp_data_dir, monkeypatch: pytest.MonkeyPatch) -> None:
    import threading
    import time

    gate = threading.Event()
    calls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(str(request.url))
        gate.wait(10)
        return httpx.Response(200, json={"metadata": {"count": len(ROWS)}, "IpawsArchivedAlerts": ROWS})

    _fema_server(monkeypatch, handler)
    monkeypatch.setattr(openfema, "REQUEST_WAIT_S", 0.2)
    now = iso_to_ms("2026-10-23T00:41:00Z")
    w = openfema.incident_window(iso_to_ms("2026-10-09T20:00:00Z"), iso_to_ms("2026-10-11T00:00:00Z"),
                                 iso_to_ms("2026-10-10T00:00:00Z"), now)
    t0 = time.monotonic()
    assert openfema.ensure(w, now=now) == ("pending", None, None)
    assert openfema.ensure(w, now=now)[0] == "pending"
    assert time.monotonic() - t0 < 2.0 and len(calls) == 1                    # one fetch (still waiting), deduplicated
    gate.set()
    for _ in range(100):
        if openfema.load_cached(w, now) is not None:
            break
        time.sleep(0.05)
    status, doc, _ = openfema.ensure(w, now=now)
    assert status == "available" and doc is not None and len(calls) == 2      # the messages + the updates' XML
    assert openfema.cache_file(w).is_file() and openfema.cache_file(w).parent.name == "openfema"
    assert openfema.cache_file(w).is_relative_to(tmp_data_dir)
    stored = openfema.load_cached(w, now)
    assert {a["event_code"] for a in stored["alerts"]} == {"FRW", "SPW"}
    assert any(a["_geom"] is not None for a in stored["alerts"]) and all("sender" not in a for a in stored["alerts"])
    at = iso_to_ms("2026-10-10T00:30:00Z")
    picked = openfema.answer(w, at, stored)
    assert picked and all(at - 24 * HOUR_MS <= a["sent_ms"] <= at + HOUR_MS for a in picked)


def test_ensure_remembers_a_failure(tmp_data_dir, monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(str(request.url))
        return httpx.Response(503)

    _fema_server(monkeypatch, handler)
    now = iso_to_ms("2026-10-23T00:41:00Z")
    w = (iso_to_ms("2026-10-09T00:00:00Z"), iso_to_ms("2026-10-11T00:00:00Z"))
    status, doc, why = openfema.ensure(w, now=now, wait_s=5.0)
    assert status == "unavailable" and doc is None and "could not be reached" in why
    n = len(calls)
    assert openfema.ensure(w, now=now)[0] == "unavailable" and len(calls) == n       # not asked again for 10 min


def test_prefetch_after_a_build(tmp_data_dir, monkeypatch: pytest.MonkeyPatch) -> None:
    _fema_server(monkeypatch, lambda r: httpx.Response(200, json={"metadata": {"count": len(ROWS)}, "IpawsArchivedAlerts": ROWS}))
    now = iso_to_ms("2026-10-23T00:41:00Z")
    start, end = iso_to_ms("2026-10-09T20:00:00Z"), iso_to_ms("2026-10-11T00:00:00Z")
    assert openfema.prefetch(start, end, now=now) is True
    w = openfema.incident_window(start, end, start + 24 * HOUR_MS, now)
    assert openfema.load_cached(w, now) is not None
    assert openfema.prefetch(now - HOUR_MS, None, now=now) is False                    # nothing archived yet
