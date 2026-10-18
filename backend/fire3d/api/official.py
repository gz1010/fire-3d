"""Official information endpoints (BRIEF-2 U-R6, U-R7): CAL FIRE status history and NWS fire weather alerts.

* ``GET /api/official/calfire?incident=<id>``: CAL FIRE's current record of the incident, every change Fire-3d has
  recorded since it first checked (``sources.calfire_history``) and caveats. Each call is a check: it records the
  current record.
* ``GET /api/official/fire-weather?incident=<id>&at_ms=<ms>&margin_km=15``: NWS Red Flag Warnings and Fire Weather
  Watches near the incident (``sources.nws``): the live NWS list for the present, the IEM archive (``archived:
  true``) for a time older than now - 6 h or a historical incident. Without ``incident``: every current California
  alert (for the overview).

Both carry the official envelope (docs/redesign/CONTRACT.md section 13, official-backend). An upstream failure is not
an HTTP error: the answer is 200 with ``status: "unavailable"`` (CAL FIRE, live NWS) or
``"not_available_for_past_dates"`` (archive), so an empty list never stands in for "no alerts". Errors: 400 bad id,
404 unknown incident, 429 Fire-3d's own request limit. JSON is ``Cache-Control: no-store``. Route functions are plain
``def`` (FastAPI runs them in its threadpool).
"""

from __future__ import annotations

import logging
import math
from dataclasses import dataclass
from typing import Any

import orjson
from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import Response

from .. import bundle, catalog, config
from ..sources import calfire, calfire_history, nws
from ..timeutil import DAY_MS, HOUR_MS, now_ms
from .extras import expand_bbox

log = logging.getLogger(__name__)

router = APIRouter(tags=["official"])

PAST_TOLERANCE_MS = 6 * HOUR_MS        # an at_ms older than now - this is "past" (same rule as the extras)
DEFAULT_MARGIN_KM = 15.0               # "near this fire": the analysis area + 15 km (BRIEF-2 decision 9)
POINT_BOX_KM = 10.0                    # area of an incident without a bundle: reported location +- 10 km
HISTORICAL_SPAN_MAX_MS = 75 * DAY_MS
STATEWIDE_SIMPLIFY_DEG = 0.004         # overview outlines (about 400 m)
LAGGED_EDIT_MS = 7 * DAY_MS

CALFIRE_SOURCE: dict[str, str] = {"name": "CAL FIRE incident list", "url": "https://www.fire.ca.gov/incidents",
                                  "credit": "CAL FIRE"}
EMPTY_FC: dict[str, Any] = {"type": "FeatureCollection", "features": []}
STANDING_NWS = ("A Red Flag Warning or Fire Weather Watch is a weather alert about fire danger, not an evacuation "
                "order. Follow local officials.")

BBox = tuple[float, float, float, float]


def _json(obj: Any) -> Response:
    return Response(orjson.dumps(obj, option=orjson.OPT_SERIALIZE_NUMPY), media_type="application/json",
                    headers={"Cache-Control": "no-store"})


def _envelope(kind: str, source: dict[str, str], incident_id: str | None, at_ms: int | None, now: int) -> dict[str, Any]:
    return {"kind": kind, "status": "available", "reason_code": None, "reason": None, "source": dict(source),
            "retrieved_ms": None, "source_updated_ms": None, "requested_at_ms": at_ms, "now_ms": now,
            "incident_id": incident_id, "caveats": []}


def _num(v: Any) -> float | None:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if math.isfinite(f) else None


def _int(v: Any) -> int | None:
    f = _num(v)
    return int(f) if f is not None else None


def _bbox(v: Any) -> BBox | None:
    if not isinstance(v, (list, tuple)) or len(v) != 4:
        return None
    vals = [_num(x) for x in v]
    if any(x is None for x in vals) or not (vals[0] < vals[2] and vals[1] < vals[3]):
        return None
    return (vals[0], vals[1], vals[2], vals[3])  # type: ignore[return-value]


# ----------------------------------------------------------------------------------------------------------------
# Incidents
# ----------------------------------------------------------------------------------------------------------------
@dataclass
class IncidentRef:
    id: str
    mode: str | None
    lon: float | None
    lat: float | None
    aoi: BBox | None
    started_ms: int | None
    end_ms: int | None
    uid: str | None             # CAL FIRE UniqueId (from the bundle's summary)
    catalog_id: bool            # a real CAL FIRE id (SPEC 4.4), not a fixture
    has_bundle: bool


def incident_ref(incident_id: str) -> IncidentRef:
    """What the bundle on disk says about an incident (400 for an invalid id; 404 when the id is neither a CAL FIRE
    id nor a bundle). Incidents without a bundle are filled in from CAL FIRE by :func:`fill_from_calfire`."""
    try:
        bdir = bundle.bundle_dir(incident_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="invalid incident id") from None
    try:
        m = bundle.load_manifest(bdir) if bdir.is_dir() else None
    except (OSError, ValueError):
        m = None
    m = m if isinstance(m, dict) else None
    parsed = catalog.parse_incident_id(incident_id)
    if m is None and parsed is None:
        raise HTTPException(status_code=404, detail=f"unknown incident {incident_id!r}")
    s = (m or {}).get("summary") if isinstance((m or {}).get("summary"), dict) else {}
    grid = (m or {}).get("grid") if isinstance((m or {}).get("grid"), dict) else {}
    tr = (m or {}).get("time_range") if isinstance((m or {}).get("time_range"), dict) else {}
    uid = calfire_history.valid_uid(s.get("calfire_uid"))
    mode = (m or {}).get("mode") or s.get("mode")
    return IncidentRef(
        id=incident_id, mode=mode if mode in ("live", "historical") else None, lon=_num(s.get("lon")), lat=_num(s.get("lat")),
        aoi=_bbox(grid.get("bbox_lonlat")), started_ms=_int(s.get("started_ms")),
        end_ms=_int(tr.get("end_ms")) if mode == "historical" else _int(s.get("contained_ms")),
        uid=uid, catalog_id=parsed is not None and (uid is None or uid.startswith(parsed[2])), has_bundle=m is not None)


def match_record(recs: list[dict], ref: IncidentRef) -> dict | None:
    """The CAL FIRE record of ``ref``: same UniqueId, else the id's six UniqueId characters and name slug (or the
    only record with those characters, in case CAL FIRE renamed the fire)."""
    if ref.uid:
        for r in recs:
            if r.get("uid") == ref.uid:
                return r
    parsed = catalog.parse_incident_id(ref.id)
    if parsed is None:
        return None
    _, slug, uid6 = parsed
    cands = [r for r in recs if str(r.get("uid") or "").startswith(uid6)]
    exact = [r for r in cands if catalog.slugify(r.get("name") or "") == slug]
    return exact[0] if exact else (cands[0] if len(cands) == 1 else None)


def find_record(ref: IncidentRef) -> tuple[dict | None, str | None]:
    """(CAL FIRE record, list key) from the live list, else the id's year list; records what it checked into the
    status history. Raises ``calfire.CalFireError`` when CAL FIRE is unreachable and nothing is cached."""
    live = calfire.list_live()
    catalog.record_history(live, "live")
    rec = match_record(live, ref)
    if rec is not None:
        return rec, "live"
    parsed = catalog.parse_incident_id(ref.id)
    if parsed is None:
        return None, None
    rec = match_record(catalog.year_records(parsed[0]), ref)
    return (rec, calfire.list_key({"inactive": "true", "year": parsed[0]})) if rec is not None else (None, None)


def fill_from_calfire(ref: IncidentRef) -> None:
    """Location, mode and times of an incident without a bundle, from its CAL FIRE record (best effort)."""
    if ref.lat is not None and ref.lon is not None and ref.mode is not None and ref.started_ms is not None:
        return
    if not ref.catalog_id:
        return
    try:
        rec, key = find_record(ref)
    except Exception as e:  # noqa: BLE001 - CAL FIRE unreachable (or any transport failure): no location then
        log.info("official: CAL FIRE lookup for %s failed: %s", ref.id, config.mask_secrets(e))
        return
    if rec is None:
        if not ref.has_bundle:
            raise HTTPException(status_code=404, detail=f"unknown incident {ref.id!r}")
        return
    ref.lat = ref.lat if ref.lat is not None else rec.get("lat")
    ref.lon = ref.lon if ref.lon is not None else rec.get("lon")
    ref.mode = ref.mode or ("live" if key == "live" or rec.get("is_active") else "historical")
    ref.started_ms = ref.started_ms or rec.get("started_ms")
    ref.end_ms = ref.end_ms or rec.get("extinguished_ms")


# ----------------------------------------------------------------------------------------------------------------
# CAL FIRE
# ----------------------------------------------------------------------------------------------------------------
def _current(snap: dict) -> dict[str, Any]:
    return {"acres": snap.get("acres"), "percent_contained": snap.get("percent_contained"),
            "is_active": bool(snap.get("is_active")), "final": bool(snap.get("final")),
            "updated_ms": snap.get("updated_ms"), "extinguished_ms": snap.get("extinguished_ms")}


def _https(v: Any) -> str | None:
    s = str(v).strip() if v else ""
    return s if s.startswith("https://") else None


def calfire_payload(incident_id: str) -> dict[str, Any]:
    """``GET /api/official/calfire`` body (see the module doc)."""
    now = now_ms()
    ref = incident_ref(incident_id)
    out = _envelope("calfire", CALFIRE_SOURCE, incident_id, None, now)
    out.update(incident_url=None, agencies=None, current=None, changes=[], recording_since_ms=None)
    if not ref.catalog_id:
        out.update(status="unavailable", reason_code="not_covered",
                   reason="This incident is not in CAL FIRE's incident list (it is synthetic or local data), so there "
                          "is no CAL FIRE record.")
        return out
    rec: dict | None = None
    key: str | None = None
    unreachable = False
    try:
        rec, key = find_record(ref)
    except Exception as e:  # noqa: BLE001 - CAL FIRE unreachable (or any transport failure)
        log.info("official: CAL FIRE unavailable for %s: %s", incident_id, config.mask_secrets(e))
        unreachable = True
    snap = None
    if rec is not None and key is not None:
        seen = calfire.fetched_ms(key) or now
        calfire_history.record([rec], list_name=key, seen_ms=seen, track=True)
        snap = calfire_history.snapshot(rec, seen, key)
    uid = (rec or {}).get("uid") or ref.uid or calfire_history.find_uid(incident_id)
    hist = calfire_history.read(uid)
    if snap is None and not hist:
        if unreachable:
            out.update(status="unavailable", reason_code="upstream_error",
                       reason="CAL FIRE's incident list could not be reached, so its record is not shown. Check "
                              "fire.ca.gov.")
            return out
        if not ref.has_bundle:
            raise HTTPException(status_code=404, detail=f"unknown incident {incident_id!r}")
        out.update(status="unavailable", reason_code="not_covered",
                   reason="CAL FIRE's incident lists do not include this incident.")
        return out
    cur = hist[-1] if hist else snap
    if snap is not None and hist and calfire_history.is_new(hist[-1], snap):
        cur = snap                                      # the history write failed; show the fresh record anyway
    assert cur is not None
    url = _https((rec or {}).get("url")) or _https(cur.get("url"))
    changes = calfire_history.changes(hist)
    agencies = str((rec or {}).get("AgencyNames") or "").strip() or cur.get("agencies")
    out.update(incident_url=url, agencies=agencies,
               current=_current(cur), changes=changes, recording_since_ms=int(hist[0]["seen_ms"]) if hist else None,
               source_updated_ms=cur.get("updated_ms"))
    out["source"]["url"] = url or CALFIRE_SOURCE["url"]
    if rec is not None:
        out["retrieved_ms"] = calfire.fetched_ms(key) if key else None
    else:
        out.update(status="unavailable", reason_code="upstream_error" if unreachable else "not_covered",
                   reason=("CAL FIRE's incident list could not be reached just now." if unreachable else
                           "CAL FIRE's incident lists no longer include this incident.")
                          + " Showing the last record Fire-3d saw.")
    cav = out["caveats"]
    cav.append("These are CAL FIRE's own numbers and update time, quoted as published; they can lag what is "
               "happening on the ground.")
    if hist:
        cav.append("Fire-3d records CAL FIRE's changes only since it first checked this incident (recording_since_ms); "
                   "earlier changes are not available. A new CAL FIRE update time without new numbers is not listed "
                   "as a change.")
    if not cur.get("is_active") and not changes:
        cav.append("CAL FIRE's list keeps only the latest record, so the update-by-update history of a past fire is "
                   "not available. This is CAL FIRE's " + ("final record." if cur.get("final") else "latest record."))
    upd, ext = cur.get("updated_ms"), cur.get("extinguished_ms")
    if not cur.get("is_active") and upd and ext and upd > ext + LAGGED_EDIT_MS:
        cav.append("CAL FIRE edited this record well after the fire was contained; its update time is that edit, not "
                   "news from the fire.")
    return out


# ----------------------------------------------------------------------------------------------------------------
# NWS fire weather
# ----------------------------------------------------------------------------------------------------------------
def archive_window(at_ms: int, mode: str | None, started_ms: int | None, end_ms: int | None) -> tuple[int, int]:
    """Archive search window. A historical fire uses one window for its whole record (so a replay reuses the cached
    answers); otherwise the UTC day of ``at_ms``, 14 days back and 2 days ahead."""
    if mode == "historical" and started_ms is not None:
        hi = min(max(end_ms or started_ms, started_ms + 3 * DAY_MS), started_ms + HISTORICAL_SPAN_MAX_MS)
        if started_ms - DAY_MS <= at_ms <= hi:
            return started_ms - nws.ARCHIVE_LOOKBACK_MS, hi + nws.ARCHIVE_LOOKAHEAD_MS
    day = at_ms // DAY_MS * DAY_MS
    return day - nws.ARCHIVE_LOOKBACK_MS, day + nws.ARCHIVE_LOOKAHEAD_MS


def _corners(b: BBox) -> list[tuple[float, float]]:
    return [(b[0], b[1]), (b[2], b[1]), (b[2], b[3]), (b[0], b[3])]


def _quiet(alerts: list[dict]) -> bool:
    return not any(a.get("phase") in ("in_effect", "upcoming") for a in alerts)


def _statewide(out: dict[str, Any], at_ms: int | None, now: int) -> dict[str, Any]:
    if at_ms is not None and at_ms < now - PAST_TOLERANCE_MS:
        out.update(status="not_available_for_past_dates", reason_code="past_date",
                   reason="Past fire weather alerts are shown for a chosen fire only (from the archive).")
        return out
    try:
        alerts, fetched, updated = nws.active_alerts()
    except nws.SourceBusy as e:
        raise HTTPException(status_code=429, detail=str(e)) from None
    except nws.SourceError as e:
        out.update(status="unavailable", reason_code="upstream_error",
                   reason=f"{e}. Fire weather alerts are not shown; check weather.gov.")
        out["caveats"].append(STANDING_NWS)
        return out
    placed, zones, cav = nws.place_live(alerts, None, None, now=now, tol_deg=STATEWIDE_SIMPLIFY_DEG)
    out.update(alerts=placed, zones=zones, retrieved_ms=fetched, source_updated_ms=updated)
    out["caveats"] += cav
    if _quiet(placed):
        out["caveats"].append("No Red Flag Warning or Fire Weather Watch from the National Weather Service is in "
                              "effect in California right now. That is not an all-clear: follow local officials.")
    out["caveats"].append(STANDING_NWS)
    return out


def fire_weather_payload(incident: str | None, at_ms: int | None, margin_km: float = DEFAULT_MARGIN_KM) -> dict[str, Any]:
    """``GET /api/official/fire-weather`` body (see the module doc)."""
    now = now_ms()
    out = _envelope("fire_weather", nws.NWS_SOURCE, incident, at_ms, now)
    out.update(alerts=[], zones=EMPTY_FC, area_bbox=None, reported_location=None)
    if not incident:
        return _statewide(out, at_ms, now)
    ref = incident_ref(incident)
    fill_from_calfire(ref)
    if ref.lat is None or ref.lon is None:
        out.update(status="unavailable", reason_code="upstream_error",
                   reason="The fire's reported location could not be looked up (CAL FIRE could not be reached), so "
                          "fire weather alerts near it are not shown.")
        out["caveats"].append(STANDING_NWS)
        return out
    point = (float(ref.lon), float(ref.lat))
    base = ref.aoi or expand_bbox((point[0], point[1], point[0], point[1]), POINT_BOX_KM)
    area = expand_bbox(base, margin_km)
    out.update(area_bbox=list(area), reported_location=list(point))
    past = ref.mode == "historical" or (at_ms is not None and at_ms < now - PAST_TOLERANCE_MS)
    if not past:
        try:
            alerts, fetched, updated = nws.active_alerts()
        except nws.SourceBusy as e:
            raise HTTPException(status_code=429, detail=str(e)) from None
        except nws.SourceError as e:
            out.update(status="unavailable", reason_code="upstream_error",
                       reason=f"{e}. Fire weather alerts are not shown; check weather.gov.")
            out["caveats"].append(STANDING_NWS)
            return out
        placed, zones, cav = nws.place_live(alerts, area, point, now=now)
        out.update(alerts=placed, zones=zones, retrieved_ms=fetched, source_updated_ms=updated)
        out["caveats"] += cav
        if _quiet(placed):
            out["caveats"].append("No Red Flag Warning or Fire Weather Watch from the National Weather Service is in "
                                  "effect near this fire right now. That is not an all-clear: follow local officials.")
        out["caveats"].append(STANDING_NWS)
        return out
    out["source"] = dict(nws.IEM_SOURCE)
    if at_ms is None:
        out.update(status="not_available_for_past_dates", reason_code="past_date",
                   reason="This fire is in the past, so current alerts are not shown for it. Choose a time on the "
                          "timeline to see the archived alerts of that time.")
        return out
    window = archive_window(at_ms, ref.mode, ref.started_ms, ref.end_ms)
    try:
        res = nws.archive_for_area(area, point, [point] + _corners(base), at_ms, window, now=now)
    except nws.SourceBusy as e:
        raise HTTPException(status_code=429, detail=str(e)) from None
    except nws.SourceError as e:
        out.update(status="not_available_for_past_dates", reason_code="upstream_error",
                   reason=f"{e}. Past fire weather alerts are not shown for the selected time; that does not mean "
                          "there were none.")
        out["caveats"].append(STANDING_NWS)
        return out
    out.update(alerts=res["alerts"], zones=res["zones"], retrieved_ms=res["retrieved_ms"])
    cav = out["caveats"]
    cav.append("Archived copy of NWS products from the Iowa Environmental Mesonet (Iowa State University), not an "
               "official NWS source. Wording and times are those of the latest NWS statement issued by the selected "
               "time.")
    cav.append("The archive was searched at the reported location and the corners of the analysis area.")
    cav += res["caveats"]
    if _quiet(res["alerts"]):
        cav.append("No Red Flag Warning or Fire Weather Watch is in the archive for this area at the selected time. "
                   "That is not an all-clear.")
    cav.append(STANDING_NWS)
    return out


# ----------------------------------------------------------------------------------------------------------------
# Routes
# ----------------------------------------------------------------------------------------------------------------
@router.get("/api/official/calfire")
def get_calfire(incident: str = Query(..., min_length=1, max_length=160)) -> Response:
    """CAL FIRE's record of the incident plus the status changes Fire-3d has recorded."""
    return _json(calfire_payload(incident))


@router.get("/api/official/fire-weather")
def get_fire_weather(incident: str | None = Query(None, min_length=1, max_length=160),
                     at_ms: int | None = Query(None, ge=0),
                     margin_km: float = Query(DEFAULT_MARGIN_KM, ge=0, le=60)) -> Response:
    """NWS Red Flag Warnings and Fire Weather Watches near the incident (archive for past times), or statewide."""
    return _json(fire_weather_payload(incident, at_ms, margin_km))
