"""Brief 3 final fixes (CONTRACT 14.17): which agency time a summary's ``contained_ms`` is, the containment event, and
the plain names of the protecting-agency codes NIFC WFIGS sends."""

from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace

from fire3d import catalog
from fire3d.build.observed import CONTAINMENT_ATTR_SOURCE, containment_event_ok, containment_time
from fire3d.contracts import IncidentSummary
from fire3d.sources import wfigs
from test_us_catalog_mock import feature

IRWIN = "ABCDEF12-0000-4000-8000-0000000000{:02d}"


def _wfigs_summary(k: int, **times: str) -> IncidentSummary:
    rec = wfigs.normalize(feature(f"KIND {k}", IRWIN.format(k), "US-SC", -82.7, 35.1, discovered="2025-03-01T18:00:00Z",
                                  pct=100.0, **times))
    return catalog.summary_from_wfigs(rec, "historical", set())


def test_wfigs_contained_kind_names_the_time_it_is() -> None:
    # Table Rock (SC, 2025): the record has a fire-out time only; it is never called a containment time
    out_only = _wfigs_summary(1, out="2026-03-19T16:00:00Z")
    assert out_only.contained_ms == 1773936000000 and out_only.contained_kind == "out"
    controlled = _wfigs_summary(2, controlled="2025-03-20T12:00:00Z", out="2025-04-01T12:00:00Z")
    assert controlled.contained_kind == "controlled" and controlled.contained_ms == controlled.model_dump()["contained_ms"]
    contained = _wfigs_summary(3, contained="2025-03-10T12:00:00Z", controlled="2025-03-20T12:00:00Z")
    assert contained.contained_kind == "contained"
    none = _wfigs_summary(4)
    assert none.contained_ms is None and none.contained_kind is None
    assert catalog.contained_kind({"controlled_ms": 5, "out_ms": 9}) == "controlled"


def test_contained_kind_defaults() -> None:
    base = dict(id="2025-x-abcdef", name="X", mode="historical", year=2025, calfire_uid="u", started_ms=1, updated_ms=None,
                acres=None, percent_contained=100.0, is_active=False, county=None, location=None, admin_unit=None, url=None,
                lat=34.2, lon=-118.1, detections_24h=None, bundle_status="none", bundle_built_ms=None)
    # an old CAL FIRE manifest: its contained_ms is CAL FIRE's containment date
    assert IncidentSummary.model_validate({**base, "contained_ms": 5}).contained_kind == "contained"
    assert IncidentSummary.model_validate({**base, "contained_ms": None}).contained_kind is None
    # an older NIFC WFIGS manifest: unknown, never assumed "contained"
    old_wfigs = IncidentSummary.model_validate({**base, "calfire_uid": "", "contained_ms": 5, "record_source": "wfigs",
                                                "uid": "ABC", "agency_code": "FC"})
    assert old_wfigs.contained_kind is None
    assert "contained_kind" in old_wfigs.model_dump(mode="json")


def test_containment_event_only_at_a_containment_time() -> None:
    s_out = SimpleNamespace(started_ms=0, percent_contained=100.0, contained_ms=50, record_source="wfigs",
                            contained_kind="out", record_issuer="FC via NIFC WFIGS")
    t, src = containment_time([], s_out, issuer="FC via NIFC WFIGS")
    assert t == 50 and not containment_event_ok(src, s_out)          # the replay may end there; no "Containment" event
    s_cont = SimpleNamespace(**{**vars(s_out), "contained_kind": "contained"})
    assert containment_event_ok(containment_time([], s_cont, issuer="x")[1], s_cont)
    s_old = SimpleNamespace(**{**vars(s_out), "contained_kind": None})
    assert containment_event_ok("x (100% contained)", s_old)          # an older summary keeps the brief-2 behaviour
    s_cal = SimpleNamespace(**{**vars(s_out), "record_source": "calfire"})
    assert containment_event_ok("CAL FIRE (100% contained)", s_cal)
    assert containment_event_ok(CONTAINMENT_ATTR_SOURCE, s_out)       # a perimeter's own ContainmentDateTime


def test_agency_codes_wfigs_sends_have_plain_names() -> None:
    raw = json.loads(catalog.AGENCY_CODES_FILE.read_text())
    assert "PMS 931" in raw["meta"]["source"] and "public domain" in raw["meta"]["terms"]
    names = {"FWS": "U.S. Fish and Wildlife Service", "USFWS": "U.S. Fish and Wildlife Service",
             "DNRF": "Department of Natural Resources Forest Service", "FFP": "Forest Fire Protection",
             "NNSA": "National Nuclear Security Administration", "OES": "Office of Emergency Services",
             "DOC": "Department of Conservation", "FS": "USDA Forest Service", "CDF": "California Department of Forestry & Fire Protection"}
    for code, name in names.items():
        assert catalog.agency_name(code) == name, code
    # the codes NIFC WFIGS was seen sending (cached Current and year-to-date answers, 2026-10-23); only the ones PMS 931
    # does not name (or names twice) stay verbatim
    sent = ["USFS", "BLM", "DVF", "C&L", "BIA", "SFS", "FC", "DNR", "CAL FIRE", "DOF", "USFWS", "SF", "NPS", "DFR", "FWS",
            "DFFM", "DFF", "SHP", "DL", "USA", "ARNG", "FFS", "USAF", "DNRC", "DOC", "OES", "FFC", "TRIBE", "DWF", "DNRF",
            "FFP", "USMC", "DEC", "INTER", "NNSA", "USN"]
    unnamed = sorted(c for c in sent if catalog.agency_name(c) is None)
    assert unnamed == ["ARNG", "DEC", "DFFM", "INTER", "SHP", "TRIBE", "USMC"]
    assert set(raw["meta"]["not_named"]) == {*unnamed, "SP"} and catalog.agency_name("SP") is None   # SP: two meanings
    rows = json.loads((Path(__file__).parent / "data" / "firedata" / "us_wfigs_current.json").read_text())["features"]
    used = {r["attributes"]["POOProtectingAgency"] for r in rows if r["attributes"]["POOProtectingAgency"]}
    assert {c for c in used if catalog.agency_name(c) is None} == {"SHP", "INTER", "USMC", "TRIBE"}
