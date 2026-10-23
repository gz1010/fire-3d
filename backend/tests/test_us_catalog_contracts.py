"""Brief 3 contracts (CONTRACT 14.1-14.7, 14.12): the IncidentSummary defaults for old manifests, the new models, the
defaulted additions to existing response models, and field parity with ``web/src/api/types.ts``."""

from __future__ import annotations

import re
from typing import Any

import pytest
from pydantic import BaseModel

from fire3d import config
from fire3d.contracts import (
    AccuracyFire,
    AccuracyRegion,
    AccuracyRegionsResponse,
    FireWeatherAlert,
    FireWeatherResponse,
    GeoLookup,
    IncidentListResponse,
    IncidentRecordResponse,
    IncidentSummary,
    ListSource,
    LiveStatus,
    LocalAlertsResponse,
    OfficialEnvelope,
    OtherRecord,
    SkillEntry,
    contract_problems,
    dump,
)

TYPES_TS = config.REPO_ROOT / "web" / "src" / "api" / "types.ts"

OLD_SUMMARY: dict[str, Any] = {
    "id": "2025-eaton-fire-dbfa57", "name": "Eaton Fire", "mode": "historical", "year": 2025,
    "calfire_uid": "dbfa5733-6f1b-4e2b-8d5e-0f5b0c0b1e2f", "started_ms": 1736297700000, "updated_ms": 1738000000000,
    "contained_ms": 1738000000000, "acres": 14021.0, "percent_contained": 100.0, "is_active": False,
    "county": "Los Angeles", "location": "Altadena", "admin_unit": "Los Angeles County Fire", "url": "https://www.fire.ca.gov/x",
    "lat": 34.20, "lon": -118.07, "detections_24h": None, "bundle_status": "ready", "bundle_built_ms": 1,
}


# ------------------------------------------------------------------------------------------------------------------
# IncidentSummary defaults (14.1 before-validator rule, implemented after validation)
# ------------------------------------------------------------------------------------------------------------------
def test_old_manifest_summary_gets_calfire_defaults() -> None:
    assert contract_problems(IncidentSummary, OLD_SUMMARY) == []
    s = IncidentSummary.model_validate(OLD_SUMMARY)
    assert s.uid == OLD_SUMMARY["calfire_uid"]
    assert s.record_source == "calfire" and s.record_issuer == "CAL FIRE" and s.agency == "CAL FIRE"
    assert s.source_name == "Eaton Fire"
    assert s.active_sources == []
    assert s.other_records == [] and s.complex_members == [] and s.aliases == []
    assert s.irwin_id is None and s.gacc is None and s.accuracy_region is None and s.complex_name is None
    d = dump(s)
    for k in ("uid", "record_source", "record_issuer", "agency", "source_name", "active_sources", "other_records",
              "complex_members", "aliases", "irwin_id", "unique_fire_id", "agency_code", "gacc", "accuracy_region",
              "complex_name"):
        assert k in d, k
    # the dump validates strictly and round-trips unchanged
    assert contract_problems(IncidentSummary, d) == []
    assert dump(IncidentSummary.model_validate(d)) == d


def test_active_old_summary_lists_calfire_as_active_source() -> None:
    s = IncidentSummary.model_validate({**OLD_SUMMARY, "is_active": True, "mode": "live"})
    assert s.active_sources == ["calfire"]


def test_given_fields_are_never_overwritten() -> None:
    wf = {**OLD_SUMMARY, "calfire_uid": "", "uid": "889237AB-1111-2222-3333-444455556666", "record_source": "wfigs",
          "record_issuer": "USFS via NIFC WFIGS", "agency": None, "agency_code": "USFS", "source_name": "HORSE GULCH",
          "active_sources": ["wfigs"], "state": "MT", "time_zone": "America/Denver", "lat": 46.6, "lon": -111.8}
    s = IncidentSummary.model_validate(wf)
    assert s.record_source == "wfigs" and s.agency is None and s.record_issuer == "USFS via NIFC WFIGS"
    assert s.source_name == "HORSE GULCH" and s.uid.startswith("889237AB")
    assert s.state == "MT" and s.time_zone == "America/Denver"
    assert contract_problems(IncidentSummary, dump(s)) == []


def test_wfigs_summary_without_issuer_never_defaults_to_calfire() -> None:
    s = IncidentSummary.model_validate({**OLD_SUMMARY, "calfire_uid": "", "record_source": "wfigs"})
    assert s.record_issuer is None and s.agency is None and s.active_sources == []


def test_time_zone_is_never_assumed_pacific_without_a_location_rule() -> None:
    s = IncidentSummary.model_validate({**OLD_SUMMARY, "lat": 35.29, "lon": -82.30})
    assert s.time_zone != "America/Los_Angeles"


# ------------------------------------------------------------------------------------------------------------------
# New models and defaulted additions (14.0)
# ------------------------------------------------------------------------------------------------------------------
def test_defaulted_additions_are_optional_and_omitted() -> None:
    assert not LiveStatus.model_fields["detections_24h"].is_required()
    assert not IncidentListResponse.model_fields["sources"].is_required()
    assert not FireWeatherResponse.model_fields["states_checked"].is_required()
    assert not FireWeatherResponse.model_fields["alert_states"].is_required()
    assert not FireWeatherAlert.model_fields["time_zone"].is_required()
    assert not SkillEntry.model_fields["growth_sorensen"].is_required()
    for name, f in IncidentSummary.model_fields.items():
        if name in ("uid", "record_source", "record_issuer", "state", "time_zone", "agency", "agency_code", "irwin_id",
                    "unique_fire_id", "source_name", "gacc", "accuracy_region", "active_sources", "other_records",
                    "complex_name", "complex_members", "aliases"):
            assert not f.is_required(), name
    st = {"last_refresh_ms": None, "next_refresh_ms": None, "active_incidents": 3, "detections_24h_ca": 12, "auto_build": False}
    assert contract_problems(LiveStatus, st) == []
    assert "detections_24h" not in dump(LiveStatus.model_validate(st))
    assert contract_problems(LiveStatus, {**st, "detections_24h": 140}) == []


def test_official_kinds_and_reason_codes_are_widened() -> None:
    lit = OfficialEnvelope.model_fields["kind"].annotation
    assert set(lit.__args__) == {"calfire", "fire_weather", "incident_record", "local_alerts"}
    rc = OfficialEnvelope.model_fields["reason_code"].annotation
    flat = {a for arg in rc.__args__ for a in getattr(arg, "__args__", ())}
    assert {"past_date", "upstream_error", "not_covered", "state_not_available"} <= flat


def _envelope(kind: str) -> dict:
    return {"kind": kind, "status": "unavailable", "reason_code": "not_covered", "reason": "x",
            "source": {"name": "NIFC WFIGS (IRWIN)", "url": "https://data-nifc.opendata.arcgis.com/", "credit": "NIFC WFIGS (IRWIN)"},
            "retrieved_ms": None, "source_updated_ms": None, "requested_at_ms": None, "now_ms": 1, "incident_id": "x",
            "caveats": []}


def test_incident_record_and_local_alerts_shapes() -> None:
    rec = {**_envelope("incident_record"), "record_source": "wfigs", "irwin_id": None, "unique_fire_id": None,
           "publisher": "NIFC WFIGS (IRWIN)", "agency_code": None, "agency": None, "protecting_unit": None, "state": "NC",
           "county": None, "time_zone": "America/New_York", "incident_url": None,
           "dataset_url": "https://data-nifc.opendata.arcgis.com/", "current": None, "complex": None, "changes": [],
           "recording_since_ms": None}
    assert contract_problems(IncidentRecordResponse, rec) == []
    assert contract_problems(IncidentRecordResponse, {**rec, "changes": [{"a": 1}]})
    assert contract_problems(IncidentRecordResponse, {**rec, "kind": "calfire"})
    alerts = {**_envelope("local_alerts"), "alerts": [], "area_bbox": None, "reported_location": None, "counties": [],
              "channels": [{"id": "nws_api", "status": "pending", "retrieved_ms": None, "source_updated_ms": None, "reason": None}]}
    assert contract_problems(LocalAlertsResponse, alerts) == []
    assert contract_problems(LocalAlertsResponse, {**alerts, "channels": [{**alerts["channels"][0], "status": "none"}]})


def test_accuracy_models_strict() -> None:
    fire = {"id": "2025-eaton-fire-dbfa57", "name": "Eaton", "state": "CA", "n_leads": 12, "growth_sorensen": 0.438,
            "fuels_edition": "LF2024", "lfm_method": "ca_month_table_drought", "era5_hours": 0}
    assert contract_problems(AccuracyFire, fire) == []
    reg = {"id": "OSCC", "name": "Southern California", "status": "tested", "n_fires": 3, "range": [0.395, 0.467],
           "by_lead": {"12": 0.4}, "fires": [fire]}
    assert contract_problems(AccuracyRegion, reg) == []
    assert contract_problems(AccuracyRegion, {**reg, "id": "WBCC"})
    assert contract_problems(GeoLookup, {"lon": -116.2, "lat": 43.6, "coverage": "lower48", "supported": True, "state": "ID",
                                         "state_name": "Idaho", "county": {"fips": "16001", "name": "Ada County"},
                                         "time_zone": "America/Denver", "time_zone_name": "Mountain Time", "note": None}) == []
    assert contract_problems(OtherRecord, {"source": "wfigs", "id": "X", "name": "TIMBER", "issuer": "USFS via NIFC WFIGS",
                                           "agency": None, "agency_code": "USFS", "acres": 1.0, "percent_contained": None,
                                           "is_active": True, "updated_ms": None, "url": None}) == []
    assert contract_problems(ListSource, {"id": "wfigs", "name": "NIFC WFIGS (IRWIN)", "status": "unavailable",
                                          "retrieved_ms": None, "reason": "timeout"}) == []


# ------------------------------------------------------------------------------------------------------------------
# contracts.py <-> web/src/api/types.ts parity (field names and optionality)
# ------------------------------------------------------------------------------------------------------------------
def _strip_comments(text: str) -> str:
    text = re.sub(r"/\*.*?\*/", "", text, flags=re.DOTALL)
    return re.sub(r"//[^\n]*", "", text)


def _ts_interfaces(text: str) -> dict[str, str]:
    out: dict[str, str] = {}
    for m in re.finditer(r"export interface (\w+)(?:\s+extends\s+[\w, ]+)?\s*\{", text):
        i, depth = m.end(), 1
        while depth:
            depth += {"{": 1, "}": -1}.get(text[i], 0)
            i += 1
        out[m.group(1)] = text[m.end():i - 1]
    return out


def _ts_fields(body: str) -> dict[str, tuple[bool, str]]:
    """Top-level fields of an interface or inline object body: name -> (optional, type text)."""
    parts, depth, cur = [], 0, ""
    for ch in body:
        if ch in "{[(<":
            depth += 1
        elif ch in "}])>":
            depth -= 1
        if depth == 0 and ch in ";\n":
            parts.append(cur)
            cur = ""
        else:
            cur += ch
    parts.append(cur)
    out: dict[str, tuple[bool, str]] = {}
    for p in parts:
        m = re.match(r"\s*(\w+)(\?)?\s*:\s*(.*)", p, flags=re.DOTALL)
        if m:
            out[m.group(1)] = (bool(m.group(2)), m.group(3).strip())
    return out


def _py_fields(model: type[BaseModel]) -> dict[str, bool]:
    return {name: not f.is_required() for name, f in model.model_fields.items()}


TS = _ts_interfaces(_strip_comments(TYPES_TS.read_text())) if TYPES_TS.is_file() else {}
PAIRS = [
    ("IncidentSummary", IncidentSummary), ("OtherRecord", OtherRecord), ("ListSource", ListSource),
    ("IncidentListResponse", IncidentListResponse), ("LiveStatus", LiveStatus), ("GeoLookup", GeoLookup),
    ("AccuracyRegionsResponse", AccuracyRegionsResponse), ("AccuracyRegion", AccuracyRegion), ("AccuracyFire", AccuracyFire),
]


@pytest.mark.skipif(not TS, reason="web/src/api/types.ts not found")
@pytest.mark.parametrize("ts_name,model", PAIRS, ids=[p[0] for p in PAIRS])
def test_types_ts_parity(ts_name: str, model: type[BaseModel]) -> None:
    ts = _ts_fields(TS[ts_name])
    py = _py_fields(model)
    if ts_name == "IncidentSummary":
        ts.pop("bbox_lonlat")           # list rows only: Python IncidentListRow.bbox_lonlat
        assert "aliases" in ts and "aliases" in py
    assert set(ts) == set(py), f"{ts_name}: only TS {sorted(set(ts) - set(py))}, only Python {sorted(set(py) - set(ts))}"
    for name, (optional, _) in ts.items():
        assert optional == py[name], f"{ts_name}.{name}: TS optional={optional}, Python optional={py[name]}"


@pytest.mark.skipif(not TS, reason="web/src/api/types.ts not found")
def test_types_ts_parity_inline_objects() -> None:
    from fire3d.contracts import (
        AccuracyAssignment,
        AccuracyMethod,
        AccuracyModelInfo,
        GeoCounty,
    )

    top = _ts_fields(TS["AccuracyRegionsResponse"])
    for key, model in (("model", AccuracyModelInfo), ("method", AccuracyMethod), ("assignment", AccuracyAssignment)):
        inner = _ts_fields(top[key][1].strip()[1:-1])
        assert set(inner) == set(model.model_fields), key
    county = _ts_fields(TS["GeoLookup"])["county"][1]
    inner = _ts_fields(county[county.index("{") + 1:county.index("}")])
    assert set(inner) == set(GeoCounty.model_fields)
    skill = re.search(r"skill\?:\s*\{([^}]*)\}", _strip_comments(TYPES_TS.read_text()))
    assert skill and set(_ts_fields(skill.group(1))) == set(SkillEntry.model_fields)
    assert "RecordSource = 'calfire' | 'wfigs'" in TYPES_TS.read_text()
    ids = re.search(r"AccuracyRegionId =([^\n]*)", TYPES_TS.read_text()).group(1)
    assert set(re.findall(r"'([A-Z-]+)'", ids)) == set(IncidentSummary.model_fields["accuracy_region"].annotation.__args__[0].__args__)
