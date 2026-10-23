"""Fire records and accuracy regions (brief 3, CONTRACT 14.4, 14.5). Owner: us-catalog.

* ``GET /api/official/incident-record?incident=<id>``: the fire's NIFC WFIGS (IRWIN) record, the protecting agency's
  numbers as NIFC publishes them, with the record's own times and a link. Works for every listed id with an IRWIN id
  (WFIGS rows, and California rows matched to one WFIGS record). Not covered (``unavailable`` + ``not_covered``, each
  with its reason): a California row without a matched record, a CAL FIRE complex row (never one member's record), a
  bundle-only or synthetic id (``fixture-demo``, ``fixture-east``). An id nobody knows is HTTP 404. WFIGS down:
  ``unavailable`` + ``upstream_error``. History outside California is deferred (``changes`` is always ``[]``).
* ``GET /api/accuracy-regions``: ``data/regional_accuracy.json`` (schema 1; seeded by us-catalog, written by the
  validation tooling) plus ``served_ms``; all ten regions, a missing one served as ``untested``; the status follows
  the counts (``tested`` >= 2 fires and >= 16 leads, else ``limited`` with >= 1 fire, else ``untested``).

The record is official information: never merged with model output, its absence is never an all-clear. JSON is
``Cache-Control: no-store`` (records) / ``no-cache`` (accuracy regions).
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

import orjson
from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import Response

from .. import bundle, catalog, config, regions
from ..contracts import AccuracyRegionsResponse, IncidentRecordResponse, IncidentSummary, dump
from ..sources import wfigs
from ..timeutil import now_ms

log = logging.getLogger(__name__)

router = APIRouter(tags=["official"])

ACCURACY_FILE = Path(__file__).resolve().parents[1] / "data" / "regional_accuracy.json"
REGION_NAMES: dict[str, str] = {
    "NWCC": "Northwest", "NRCC": "Northern Rockies", "GBCC": "Great Basin", "SWCC": "Southwest",
    "SACC-SP": "Southern Plains", "SACC-SE": "Southeast", "RMCC": "Rocky Mountain", "EACC": "Eastern",
    "ONCC": "Northern California", "OSCC": "Southern California",
}
MIN_FIRES = 2
MIN_LEADS = 16

PUBLISHER = "NIFC WFIGS (IRWIN)"
RECORD_SOURCE: dict[str, str] = {"name": PUBLISHER, "url": wfigs.DATASET_URL, "credit": "NIFC WFIGS (IRWIN)",
                                 "license": "NIFC disclaimer (no use restriction)", "terms_url": wfigs.DATASET_URL}
CAVEAT_NUMBERS = ("These are the protecting agency's numbers as published by NIFC WFIGS (IRWIN), with the record's own "
                  "update time. Fire-3d does not record changes to this record yet.")
CAVEAT_NOT_ALL_CLEAR = "No record or no change is not an all-clear: follow local officials."
REASON_NO_MATCH = "NIFC WFIGS has no record matched to this fire."
REASON_COMPLEX = "This is a CAL FIRE complex; NIFC WFIGS lists its member fires separately."
REASON_SYNTHETIC = "This is synthetic or local data; it has no agency record."
REASON_DOWN = "NIFC WFIGS could not be reached; the agency record is not shown."
REASON_GONE = "NIFC WFIGS no longer has this record."


def _json(obj: Any, cache: str = "no-store") -> Response:
    return Response(orjson.dumps(obj), media_type="application/json", headers={"Cache-Control": cache})


# ------------------------------------------------------------------------------------------------------------------
# Incident record (14.5)
# ------------------------------------------------------------------------------------------------------------------
def _base(summary: IncidentSummary | None, incident_id: str, now: int) -> dict[str, Any]:
    s = summary
    tz = (s.time_zone if s is not None else None) or (regions.main_zone(s.state) if s is not None and s.state else "UTC")
    irwin = s.irwin_id if s is not None else None
    return {
        "kind": "incident_record", "status": "unavailable", "reason_code": None, "reason": None,
        "source": dict(RECORD_SOURCE), "retrieved_ms": None, "source_updated_ms": None, "requested_at_ms": None,
        "now_ms": now, "incident_id": incident_id, "caveats": [CAVEAT_NUMBERS, CAVEAT_NOT_ALL_CLEAR],
        "record_source": "wfigs", "irwin_id": irwin, "unique_fire_id": s.unique_fire_id if s is not None else None,
        "publisher": PUBLISHER, "agency_code": s.agency_code if s is not None and s.record_source == "wfigs" else None,
        "agency": None, "protecting_unit": None, "state": s.state if s is not None else None, "county": None,
        "time_zone": tz, "incident_url": wfigs.record_url(irwin) if irwin else None, "dataset_url": wfigs.DATASET_URL,
        "current": None, "complex": None, "changes": [], "recording_since_ms": None,
    }


def _not_covered(body: dict[str, Any], reason: str) -> dict[str, Any]:
    body.update(status="unavailable", reason_code="not_covered", reason=reason)
    return body


def _resolve(incident_id: str) -> tuple[IncidentSummary | None, bool]:
    """``(summary, listed)``: the listed summary (``catalog.resolve_listed``), else a bundle's (listed False); 404 when
    nobody knows the id, 400 for an invalid id."""
    try:
        bundle.bundle_dir(incident_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="invalid incident id") from None
    try:
        listed = catalog.resolve_listed(incident_id)
    except Exception as e:  # noqa: BLE001 - a lookup failure falls back to the bundle on disk
        log.warning("incident-record: resolve_listed(%s) failed: %s", incident_id, config.mask_secrets(e))
        listed = None
    if listed is not None:
        return listed, True
    s = catalog.manifest_summary(incident_id)
    if s is None:
        raise HTTPException(status_code=404, detail=f"unknown incident {incident_id!r}")
    return s, False


def incident_record_payload(incident_id: str) -> dict[str, Any]:
    """The ``IncidentRecordResponse`` body for one incident id (CONTRACT 14.5)."""
    now = now_ms()
    s, listed = _resolve(incident_id)
    body = _base(s, incident_id, now)
    if not listed:
        return _not_covered(body, REASON_SYNTHETIC)
    if s.complex_members:
        body.update(irwin_id=None, incident_url=None)
        return _not_covered(body, REASON_COMPLEX)
    irwin = s.irwin_id or (s.uid if s.record_source == "wfigs" else None)
    if not irwin:
        return _not_covered(body, REASON_NO_MATCH)
    try:
        rec = wfigs.record_by_irwin(irwin)
    except Exception as e:  # noqa: BLE001 - an upstream failure is an honest status, never an HTTP error
        log.warning("incident-record %s: WFIGS unavailable: %s", incident_id, config.mask_secrets(e))
        body.update(reason_code="upstream_error", reason=REASON_DOWN, irwin_id=irwin, incident_url=wfigs.record_url(irwin))
        return body
    body.update(irwin_id=irwin, incident_url=wfigs.record_url(irwin),
                retrieved_ms=wfigs.fetched_ms(wfigs.list_key(wfigs.ALL_YEARS_URL, "IrwinID='{" + wfigs.clean_irwin(irwin) + "}'")))
    if rec is None:
        body.update(reason_code="upstream_error", reason=REASON_GONE)
        return body
    try:
        current_ids = catalog.active_irwin_ids(wfigs.list_current())
    except Exception as e:  # noqa: BLE001 - the active flag then falls back to "not in the Current layer"
        log.info("incident-record %s: Current layer unavailable: %s", incident_id, config.mask_secrets(e))
        current_ids = set()
    st = catalog.wfigs_state(rec) or rec.get("poo_state") or s.state
    tz = regions.time_zone_at(rec["lon"], rec["lat"]) or s.time_zone or (regions.main_zone(st) if st else "UTC")
    body.update(
        status="available", reason_code=None, reason=None,
        source={**RECORD_SOURCE, "url": wfigs.record_url(irwin)},
        source_updated_ms=rec.get("updated_ms"),
        unique_fire_id=rec.get("unique_fire_id"), agency_code=rec.get("agency_code"), agency=None,
        protecting_unit=rec.get("protecting_unit"), state=st, county=rec.get("county"), time_zone=tz,
        current={
            "name": rec.get("source_name") or "", "acres": rec.get("acres"), "percent_contained": rec.get("percent_contained"),
            "is_active": catalog.wfigs_active(rec, current_ids), "discovered_ms": rec.get("started_ms"),
            "contained_ms": rec.get("contained_ms"), "controlled_ms": rec.get("controlled_ms"), "out_ms": rec.get("out_ms"),
            "updated_ms": rec.get("updated_ms"), "ics209_report_ms": rec.get("ics209_report_ms"),
        },
        complex={"name": rec["cpx_name"], "id": rec.get("cpx_id")} if rec.get("cpx_name") else None,
    )
    return body


@router.get("/api/official/incident-record")
def incident_record(incident: str = Query(..., min_length=1, max_length=200)) -> Response:
    """CONTRACT 14.5: the fire's NIFC WFIGS (IRWIN) record, with the protecting agency's own numbers and times."""
    body = incident_record_payload(incident)
    return _json(dump(IncidentRecordResponse.model_validate(body)))


# ------------------------------------------------------------------------------------------------------------------
# Accuracy regions (14.4)
# ------------------------------------------------------------------------------------------------------------------
def region_status(region: dict[str, Any]) -> str:
    """``tested`` with >= 2 fires and >= 16 scored leads, else ``limited`` with >= 1 fire, else ``untested``."""
    n_fires = int(region.get("n_fires") or 0)
    n_leads = int(region.get("n_leads") or 0)
    if n_fires >= MIN_FIRES and n_leads >= MIN_LEADS:
        return "tested"
    return "limited" if n_fires >= 1 else "untested"


def accuracy_payload(path: Path | None = None) -> dict[str, Any]:
    """The regional accuracy file with every region present (missing -> ``untested``), each status recomputed from its
    counts, the regions in the fixed order of :data:`REGION_NAMES`, plus ``served_ms``."""
    data = orjson.loads((path or ACCURACY_FILE).read_bytes())
    by_id = {r.get("id"): dict(r) for r in data.get("regions") or [] if isinstance(r, dict)}
    out = []
    for rid, name in REGION_NAMES.items():
        r = by_id.get(rid) or {"id": rid, "name": name, "status": "untested", "n_fires": 0}
        r.setdefault("name", name)
        r["status"] = region_status(r)
        out.append(r)
    return {**data, "regions": out, "served_ms": now_ms()}


@router.get("/api/accuracy-regions")
def accuracy_regions() -> Response:
    """CONTRACT 14.4: the per-region hindcast accuracy file plus ``served_ms`` (``Cache-Control: no-cache``)."""
    try:
        body = accuracy_payload()
    except (OSError, ValueError) as e:
        log.error("accuracy regions file unreadable: %s", e)
        raise HTTPException(status_code=503, detail="accuracy regions unavailable") from None
    return _json(dump(AccuracyRegionsResponse.model_validate(body)), cache="no-cache")
