"""Official information endpoints (BRIEF-2 U-R6, U-R7; brief 3 CONTRACT 14.5-14.7): CAL FIRE status history, NWS
fire weather alerts and the local officials' messages relayed by NWS (with FEMA's archive for past days).

* ``GET /api/official/calfire?incident=<id>``: CAL FIRE's current record of the incident, every change Fire-3d has
  recorded since it first checked (``sources.calfire_history``) and caveats. Each call is a check: it records the
  current record. A fire whose record is NIFC WFIGS's answers ``not_covered``.
* ``GET /api/official/fire-weather?incident=<id>&at_ms=<ms>&margin_km=15``: NWS Red Flag Warnings and Fire Weather
  Watches near the incident (``sources.nws``): the live national NWS list for the present (alerts of the states the
  fire's area touches), the IEM archive (``archived: true``) for a time older than now - 6 h or a historical
  incident. Without ``incident``: every current alert in the lower 48 states (for the overview). ``states_checked``
  says which states the answer covers, ``alert_states`` which of them have an alert.
* ``GET /api/official/local-alerts?incident=<id>&at_ms=&margin_km=15`` or ``?bbox=w,s,e,n``: local officials'
  messages (Fire Warning, Evacuation Immediate, ...) tied to the area, from the NWS (live and its last 7 days) and the
  FEMA IPAWS archive via OpenFEMA (older than 24 h), one alert per CAP id, each with a link (``source_url``).

Incidents are resolved from their bundle on disk, else from ``catalog.get_summary`` (any listed fire, CAL FIRE or
NIFC WFIGS, with or without a bundle; :func:`fill_from_catalog`).

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
from ..sources import calfire, calfire_history, nws, openfema
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
SCOPE_WORDS = "the lower 48 states"     # the national request's scope, in the caveats (CONTRACT 14.6)
WFIGS_NOT_CALFIRE = "CAL FIRE does not list this fire; its official record is published by NIFC WFIGS."

# Local officials' messages (CONTRACT 14.7)
LOCAL_SOURCE: dict[str, str] = {
    "name": "National Weather Service (relayed local officials' messages)",
    "url": "https://www.weather.gov/dsb/nonweatheralerts",
    "credit": "National Weather Service (relayed local officials' messages)",
    "license": nws.NWS_SOURCE["license"],
    "terms_url": nws.NWS_SOURCE["terms_url"],
}
LOCAL_CAVEAT = ("Fire-3d lists only the local alerts the National Weather Service relays; most are not relayed (about "
                "1 in 20 fire and evacuation alerts in 2024-26). No alert here is not an all-clear: follow local "
                "officials.")
ARCHIVE_CAVEAT = ("Archived copy from FEMA (OpenFEMA, published about a day later); FEMA does not validate message "
                  "content. Replays can list more than was visible live.")
NWS_KEEPS_REASON = "NWS keeps about 7 days of alerts."
ARCHIVE_NOT_BUILT_REASON = "The FEMA archive is not checked in this version."
ARCHIVE_RECENT_REASON = ("FEMA publishes its archive about a day later; messages of the last 24 hours come from the "
                         "National Weather Service.")
ARCHIVE_POINT_REASON = "The FEMA archive is checked for a chosen fire only."
NWS_PAST_POINT_REASON = "Past local alerts are checked for a chosen fire only."
ARCHIVE_ENABLED = True                 # the background OpenFEMA prefetch (us-pipeline cut-line item a)
ARCHIVE_PENDING_REASON = "FEMA's archive is being fetched; ask again in a minute."

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
    catalog_id: bool            # an id of the catalog's form (SPEC 4.4: CAL FIRE or NIFC WFIGS), not a fixture
    has_bundle: bool
    record_source: str | None = None    # "calfire" | "wfigs" (from the bundle's summary or the catalog)
    state: str | None = None
    time_zone: str | None = None


def incident_ref(incident_id: str) -> IncidentRef:
    """What the bundle on disk says about an incident (400 for an invalid id; 404 when the id is neither of the
    catalog's form nor a bundle). Incidents without a bundle are filled in by :func:`fill_from_catalog`."""
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
    rs = s.get("record_source")
    if rs not in ("calfire", "wfigs"):
        rs = "calfire" if uid else None          # old manifests: a CAL FIRE uid means a CAL FIRE record
    return IncidentRef(
        id=incident_id, mode=mode if mode in ("live", "historical") else None, lon=_num(s.get("lon")), lat=_num(s.get("lat")),
        aoi=_bbox(grid.get("bbox_lonlat")), started_ms=_int(s.get("started_ms")),
        end_ms=_int(tr.get("end_ms")) if mode == "historical" else _int(s.get("contained_ms")),
        uid=uid, catalog_id=parsed is not None and (uid is None or uid.startswith(parsed[2])), has_bundle=m is not None,
        record_source=rs, state=s.get("state") if isinstance(s.get("state"), str) else None,
        time_zone=s.get("time_zone") if isinstance(s.get("time_zone"), str) else None)


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


def _catalog_summary(incident_id: str) -> tuple[Any, bool]:
    """``(catalog.get_summary(id) as a dict or None, reachable)``; a lookup failure is (None, False)."""
    try:
        s = catalog.get_summary(incident_id)
    except Exception as e:  # noqa: BLE001 - a list unreachable (or any transport failure)
        log.info("official: catalog lookup for %s failed: %s", incident_id, config.mask_secrets(e))
        return None, False
    if s is None:
        return None, True
    if hasattr(s, "model_dump"):
        s = s.model_dump()
    return (s if isinstance(s, dict) else None), True


def fill_from_catalog(ref: IncidentRef) -> None:
    """Location, mode, times, state, time zone and record source of an incident from the catalog
    (``catalog.get_summary``: any listed fire, CAL FIRE or NIFC WFIGS, with or without a bundle), filling only what
    the bundle did not say. HTTP 404 for an id nobody lists and no bundle; a lookup failure leaves the gaps."""
    complete = (ref.lat is not None and ref.lon is not None and ref.mode is not None and ref.started_ms is not None
                and ref.record_source is not None)
    if complete or not ref.catalog_id:
        return
    s, reachable = _catalog_summary(ref.id)
    if s is None:
        if reachable and not ref.has_bundle:
            raise HTTPException(status_code=404, detail=f"unknown incident {ref.id!r}")
        return
    ref.lat = ref.lat if ref.lat is not None else _num(s.get("lat"))
    ref.lon = ref.lon if ref.lon is not None else _num(s.get("lon"))
    mode = s.get("mode")
    ref.mode = ref.mode or (mode if mode in ("live", "historical") else None)
    ref.started_ms = ref.started_ms or _int(s.get("started_ms"))
    ref.end_ms = ref.end_ms or _int(s.get("contained_ms"))
    rs = s.get("record_source")
    ref.record_source = ref.record_source or (rs if rs in ("calfire", "wfigs") else None)
    ref.state = ref.state or (s.get("state") if isinstance(s.get("state"), str) else None)
    ref.time_zone = ref.time_zone or (s.get("time_zone") if isinstance(s.get("time_zone"), str) else None)
    ref.uid = ref.uid or calfire_history.valid_uid(s.get("calfire_uid"))


def fill_from_calfire(ref: IncidentRef) -> None:
    """Deprecated alias of :func:`fill_from_catalog` (brief 3)."""
    fill_from_catalog(ref)


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
    if ref.record_source is None and not ref.has_bundle:
        s, _ = _catalog_summary(incident_id)
        rs = (s or {}).get("record_source")
        ref.record_source = rs if rs in ("calfire", "wfigs") else None
    if ref.record_source == "wfigs":
        out.update(status="unavailable", reason_code="not_covered", reason=WFIGS_NOT_CALFIRE)
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
    """The overview: every current alert in the lower 48 states (the shared national request)."""
    if at_ms is not None and at_ms < now - PAST_TOLERANCE_MS:
        out.update(status="not_available_for_past_dates", reason_code="past_date",
                   reason="Past fire weather alerts are shown for a chosen fire only (from the archive).")
        return out
    try:
        ans = nws.national_active()
    except nws.SourceBusy as e:
        raise HTTPException(status_code=429, detail=str(e)) from None
    except nws.SourceError as e:
        out.update(status="unavailable", reason_code="upstream_error",
                   reason=f"{e}. Fire weather alerts are not shown; check weather.gov.")
        out["caveats"].append(STANDING_NWS)
        return out
    placed, zones, cav = nws.place_live(ans.fire, None, None, now=now, tol_deg=STATEWIDE_SIMPLIFY_DEG)
    out.update(alerts=placed, zones=zones, retrieved_ms=ans.fetched_ms, source_updated_ms=ans.updated_ms,
               states_checked=list(ans.states), alert_states=nws.alert_states(placed))
    out["caveats"] += cav
    out["caveats"].append(f"Checked: every National Weather Service Red Flag Warning and Fire Weather Watch in effect in "
                          f"{SCOPE_WORDS} ({len(ans.states)} areas, including DC), in one request.")
    if _quiet(placed):
        out["caveats"].append("No Red Flag Warning or Fire Weather Watch from the National Weather Service is in "
                              f"effect in {SCOPE_WORDS} right now. That is not an all-clear: follow local officials.")
    out["caveats"].append(STANDING_NWS)
    return out


def _fire_area(ref: IncidentRef, margin_km: float) -> tuple[tuple[float, float], BBox, BBox]:
    """``(reported location, base area, area)`` of a located incident: its analysis area (else the reported
    location +- 10 km), expanded by ``margin_km``."""
    point = (float(ref.lon), float(ref.lat))  # type: ignore[arg-type]
    base = ref.aoi or expand_bbox((point[0], point[1], point[0], point[1]), POINT_BOX_KM)
    return point, base, expand_bbox(base, margin_km)


def fire_weather_payload(incident: str | None, at_ms: int | None, margin_km: float = DEFAULT_MARGIN_KM) -> dict[str, Any]:
    """``GET /api/official/fire-weather`` body (see the module doc)."""
    now = now_ms()
    out = _envelope("fire_weather", nws.NWS_SOURCE, incident, at_ms, now)
    out.update(alerts=[], zones=EMPTY_FC, area_bbox=None, reported_location=None, states_checked=[], alert_states=[])
    if not incident:
        return _statewide(out, at_ms, now)
    ref = incident_ref(incident)
    fill_from_catalog(ref)
    if ref.lat is None or ref.lon is None:
        out.update(status="unavailable", reason_code="upstream_error",
                   reason="The fire's reported location could not be looked up (the fire lists could not be reached), "
                          "so fire weather alerts near it are not shown.")
        out["caveats"].append(STANDING_NWS)
        return out
    point, base, area = _fire_area(ref, margin_km)
    out.update(area_bbox=list(area), reported_location=list(point))
    states = nws.states_in_area(area)
    past = ref.mode == "historical" or (at_ms is not None and at_ms < now - PAST_TOLERANCE_MS)
    if not past:
        try:
            ans = nws.national_active()
        except nws.SourceBusy as e:
            raise HTTPException(status_code=429, detail=str(e)) from None
        except nws.SourceError as e:
            out.update(status="unavailable", reason_code="upstream_error",
                       reason=f"{e}. Fire weather alerts are not shown; check weather.gov.")
            out["caveats"].append(STANDING_NWS)
            return out
        checked = [st for st in states if st in ans.states]
        mine = nws.in_states(ans.fire, checked)             # before any zone outline is loaded
        placed, zones, cav = nws.place_live(mine, area, point, now=now)
        out.update(alerts=placed, zones=zones, retrieved_ms=ans.fetched_ms, source_updated_ms=ans.updated_ms,
                   states_checked=checked, alert_states=nws.alert_states(placed))
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
    out.update(alerts=res["alerts"], zones=res["zones"], retrieved_ms=res["retrieved_ms"], states_checked=states,
               alert_states=nws.alert_states(res["alerts"]))
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
# Local officials' messages (CONTRACT 14.7)
# ----------------------------------------------------------------------------------------------------------------
def parse_bbox_param(v: str) -> BBox:
    """``w,s,e,n`` -> a bbox; HTTP 400 when it is not four finite numbers with w < e, s < n in lon/lat range."""
    parts = [x.strip() for x in str(v).split(",")]
    vals = [_num(x) for x in parts] if len(parts) == 4 else []
    b = _bbox(vals) if vals and all(x is not None for x in vals) else None
    if b is None or not (-180 <= b[0] <= 180 and -180 <= b[2] <= 180 and -90 <= b[1] <= 90 and -90 <= b[3] <= 90):
        raise HTTPException(status_code=400, detail="bbox must be w,s,e,n in degrees (west < east, south < north)")
    if (b[2] - b[0]) > 10 or (b[3] - b[1]) > 10:
        raise HTTPException(status_code=400, detail="bbox is too large (at most 10 degrees a side)")
    return b


def _counties(area: BBox, point: tuple[float, float] | None) -> tuple[list[dict], str | None]:
    """The counties the area touches (``regions.counties_in_bbox``) and the county FIPS at the point."""
    r = nws._regions()
    if r is None:
        return [], None
    try:
        cs = [{"fips": c.fips, "name": c.name, "state": c.state} for c in r.counties_in_bbox(tuple(area))]
        here = r.county_at(*point) if point is not None else None
    except Exception as e:  # noqa: BLE001 - a broken data file: polygon matching still works
        log.warning("official: county lookup failed: %s", e)
        return [], None
    return cs, (here.fips if here is not None else None)


def _channel(cid: str, status: str, reason: str | None = None, retrieved: int | None = None,
             updated: int | None = None) -> dict[str, Any]:
    return {"id": cid, "status": status, "retrieved_ms": retrieved, "source_updated_ms": updated, "reason": reason}


def _archive_channel(ref: IncidentRef | None, at: int, now: int, area: BBox, point: tuple[float, float] | None,
                     fips: list[str], point_county: str | None) -> tuple[dict, list[dict], list[str]]:
    """The ``openfema_archive`` channel: ``(channel, alerts, caveats)``. Never waits on the request path longer than
    ``openfema.REQUEST_WAIT_S``; a cache miss answers ``pending`` while the background fetch runs."""
    if ref is None:
        return _channel("openfema_archive", "not_checked", ARCHIVE_POINT_REASON), [], []
    if at > now - openfema.ARCHIVE_DELAY_MS:
        return _channel("openfema_archive", "not_checked", ARCHIVE_RECENT_REASON), [], []
    if not ARCHIVE_ENABLED:
        return _channel("openfema_archive", "not_checked", ARCHIVE_NOT_BUILT_REASON), [], []
    credit = [ARCHIVE_CAVEAT, f"{openfema.CREDIT}: {openfema.NOTICE}."]
    end = ref.end_ms if ref.mode == "historical" else None
    if ref.mode == "historical" and end is None and ref.started_ms:
        end = int(ref.started_ms) + openfema.HISTORICAL_DEFAULT_SPAN_MS      # a past fire without a known end
    window = openfema.incident_window(ref.started_ms, end, at, now)
    try:
        status, doc, why = openfema.ensure(window, now=now)
    except nws.SourceBusy as e:
        return _channel("openfema_archive", "unavailable", str(e)), [], credit
    if status == "pending":
        return _channel("openfema_archive", "pending", ARCHIVE_PENDING_REASON), [], credit
    if status != "available" or doc is None:
        return _channel("openfema_archive", "unavailable", f"{why}. Archived local alerts are not shown; that does "
                                                           "not mean there were none."), [], credit
    alerts = nws.place_local(openfema.answer(window, at, doc), area, point, fips, at, point_county=point_county)
    if doc.get("truncated"):
        credit.append("FEMA's archive had more messages in this period than Fire-3d reads; some may be missing.")
    return _channel("openfema_archive", "available", None, int(doc["fetched_ms"]), None), alerts, credit


def merge_local(nws_alerts: list[dict], archive_alerts: list[dict]) -> tuple[list[dict], int]:
    """One alert per CAP id (the ``nws_api`` copy wins over the archived one), only alerts with an https
    ``source_url``; returns ``(alerts, dropped for want of a link)``. Sorted like ``nws.place_local``."""
    out: dict[str, dict] = {}
    for a in list(nws_alerts) + list(archive_alerts):
        out.setdefault(a["id"], a)
    alerts = list(out.values())
    kept = [a for a in alerts if str(a.get("source_url") or "").startswith("https://")]
    kept.sort(key=nws._local_sort_key)
    return kept, len(alerts) - len(kept)


def local_alerts_payload(incident: str | None, bbox: str | None, at_ms: int | None,
                         margin_km: float = DEFAULT_MARGIN_KM) -> dict[str, Any]:
    """``GET /api/official/local-alerts`` body (CONTRACT 14.7)."""
    if (incident is None) == (bbox is None):
        raise HTTPException(status_code=400, detail="give either incident or bbox, not both")
    now = now_ms()
    out = _envelope("local_alerts", LOCAL_SOURCE, incident, at_ms, now)
    out.update(alerts=[], channels=[], area_bbox=None, reported_location=None, counties=[])
    point: tuple[float, float] | None = None
    ref: IncidentRef | None = None
    if incident is not None:
        ref = incident_ref(incident)
        fill_from_catalog(ref)
        if ref.lat is None or ref.lon is None:
            out.update(status="unavailable", reason_code="upstream_error",
                       reason="The fire's reported location could not be looked up (the fire lists could not be "
                              "reached), so local officials' alerts near it are not shown.",
                       channels=[_channel("nws_api", "not_checked", "The fire's location is unknown."),
                                 _channel("openfema_archive", "not_checked", "The fire's location is unknown.")])
            out["caveats"].append(LOCAL_CAVEAT)
            return out
        point, _, area = _fire_area(ref, margin_km)
        out["reported_location"] = list(point)
    else:
        area = parse_bbox_param(bbox or "")
    out["area_bbox"] = list(area)
    at = int(at_ms) if at_ms is not None else now
    states = nws.states_in_area(area)
    counties, point_county = _counties(area, point)
    out["counties"] = counties
    fips = [c["fips"] for c in counties]
    caveats: list[str] = []
    nws_alerts: list[dict] = []
    dropped = 0
    age = now - at
    try:
        if age <= nws.LIVE_WINDOW_MS:
            ans = nws.national_active()
            checked = [st for st in states if st in ans.states]
            nws_alerts = nws.place_local(nws.local_in_states(ans.local, checked), area, point, fips, at,
                                         point_county=point_county)
            dropped += ans.dropped_no_link
            nws_ch = _channel("nws_api", "available", None, ans.fetched_ms, ans.updated_ms)
        elif age <= nws.NWS_KEEPS_MS and incident is None:
            nws_ch = _channel("nws_api", "not_checked", NWS_PAST_POINT_REASON)
        elif age <= nws.NWS_KEEPS_MS:
            local, fetched, d = nws.past_local(states, at, now=now)
            nws_alerts = nws.place_local(local, area, point, fips, at, point_county=point_county)
            dropped += d
            nws_ch = _channel("nws_api", "available", None, fetched, None)
        else:
            nws_ch = _channel("nws_api", "not_checked", NWS_KEEPS_REASON)
    except nws.SourceBusy as e:
        raise HTTPException(status_code=429, detail=str(e)) from None
    except nws.SourceError as e:
        nws_ch = _channel("nws_api", "unavailable", f"{e}. Local officials' alerts relayed by NWS are not shown; "
                                                    "that does not mean there were none.")
    arch_ch, arch_alerts, arch_cav = _archive_channel(ref, at, now, area, point, fips, point_county)
    caveats += arch_cav
    kept, no_link = merge_local(nws_alerts, arch_alerts)
    dropped += no_link
    out.update(alerts=kept, channels=[nws_ch, arch_ch])
    tried = [c for c in (nws_ch, arch_ch) if c["status"] != "not_checked"]
    if tried and not any(c["status"] in ("available", "pending") for c in tried):
        out.update(status="unavailable", reason_code="upstream_error", reason=next(c["reason"] for c in tried))
    elif not tried:
        out.update(status="not_available_for_past_dates", reason_code="past_date",
                   reason="Local officials' alerts are not checked for this time: " + " ".join(
                       dict.fromkeys(c["reason"] for c in (nws_ch, arch_ch) if c["reason"])))
    avail = [c for c in (nws_ch, arch_ch) if c["status"] == "available"]
    out["retrieved_ms"] = min((c["retrieved_ms"] for c in avail if c["retrieved_ms"]), default=None)
    out["source_updated_ms"] = nws_ch["source_updated_ms"]
    if dropped:
        caveats.append(f"{dropped} alert(s) without a source link were not shown.")
    out["caveats"] = [LOCAL_CAVEAT] + caveats
    return out


# ----------------------------------------------------------------------------------------------------------------
# Routes
# ----------------------------------------------------------------------------------------------------------------
@router.get("/api/official/calfire")
def get_calfire(incident: str = Query(..., min_length=1, max_length=160)) -> Response:
    """CAL FIRE's record of the incident plus the status changes Fire-3d has recorded."""
    return _json(calfire_payload(incident))


@router.get("/api/official/local-alerts")
def get_local_alerts(incident: str | None = Query(None, min_length=1, max_length=160),
                     bbox: str | None = Query(None, min_length=1, max_length=120),
                     at_ms: int | None = Query(None, ge=0),
                     margin_km: float = Query(DEFAULT_MARGIN_KM, ge=0, le=60)) -> Response:
    """Local officials' messages relayed by NWS near the incident (or in ``bbox``), with FEMA's archive for past
    days (CONTRACT 14.7)."""
    return _json(local_alerts_payload(incident, bbox, at_ms, margin_km))


@router.get("/api/official/fire-weather")
def get_fire_weather(incident: str | None = Query(None, min_length=1, max_length=160),
                     at_ms: int | None = Query(None, ge=0),
                     margin_km: float = Query(DEFAULT_MARGIN_KM, ge=0, le=60)) -> Response:
    """NWS Red Flag Warnings and Fire Weather Watches near the incident (archive for past times), or statewide."""
    return _json(fire_weather_payload(incident, at_ms, margin_km))
