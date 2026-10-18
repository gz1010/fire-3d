"""National Weather Service fire weather alerts: Red Flag Warnings and Fire Weather Watches (BRIEF-2 U-R7).

Live (:func:`active_alerts`, :func:`place_live`): one statewide request,
``api.weather.gov/alerts/active?area=CA&event=Red Flag Warning,Fire Weather Watch``, cached 2 min, serves every
incident and the California overview. Each alert names its fire weather zones; their polygons
(``/zones/fire/{UGC}``) are cached 30 days. Coverage and distances use the full polygons; the map gets a copy
simplified to about 100 m.

Past times (:func:`archive_for_area`): the Iowa Environmental Mesonet (IEM, Iowa State University) VTEC archive, a
public-domain copy of NWS products, always labelled as archived. ``json/vtec_events_bypoint.py`` finds the fire
weather events at sample points, ``json/vtec_event.py`` gives each event's per-zone times and its text products, and
``geojson/vtec_event.py`` its zone polygons. NWS keeps no archive itself (it answers an empty list for past dates), so
an archive failure is an error for the caller ("not available for past dates"), never "no alerts".

Wording (event names, headlines, descriptions, instructions) is passed through verbatim. Archived text is the
segment for the zone in question of the latest statement issued by the requested time; archived times are the
archive's per-zone times (some watch rows end before they begin: upgraded or cancelled early). Requests go through
:mod:`fire3d.http` (disk cache, one retry) behind Fire-3d's own request limits, with the User-Agent
"Fire-3d/0.1 (research prototype)"; the optional ``FIRE3D_NWS_CONTACT`` is appended for NWS requests only.
"""

from __future__ import annotations

import logging
import math
import os
import re
import threading
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Callable, Iterable
from urllib.parse import quote

import numpy as np
import shapely
from shapely.geometry import Point, box, mapping, shape
from shapely.geometry.base import BaseGeometry

from .. import config
from .. import http as fhttp
from ..timeutil import DAY_MS, HOUR_MS, iso_to_ms, ms_to_dt, now_ms

log = logging.getLogger(__name__)

BBox = tuple[float, float, float, float]

NWS_API = "https://api.weather.gov"
NWS_WEB = "https://www.weather.gov"
FIRE_EVENTS = ("Red Flag Warning", "Fire Weather Watch")
FIRE_PHENOMENA = "FW"                                   # VTEC: FW.W Red Flag Warning, FW.A Fire Weather Watch
EVENT_BY_SIGNIFICANCE = {"W": "Red Flag Warning", "A": "Fire Weather Watch"}
ALERTS_TTL_S = 120.0
ZONE_TTL_S = 30 * 86400.0
ZONE_MISS_TTL_S = 3600.0
IEM_ROOT = "https://mesonet.agron.iastate.edu"
IEM_BYPOINT_URL = f"{IEM_ROOT}/json/vtec_events_bypoint.py"
IEM_EVENT_URL = f"{IEM_ROOT}/json/vtec_event.py"
IEM_EVENT_GEOJSON_URL = f"{IEM_ROOT}/geojson/vtec_event.py"
IEM_PAST_TTL_S = 30 * 86400.0
IEM_RECENT_TTL_S = 1800.0
ARCHIVE_LOOKBACK_MS = 14 * DAY_MS     # bypoint lists events by their start: look back far enough for long warnings
ARCHIVE_LOOKAHEAD_MS = 2 * DAY_MS
WATCH_LEAD_MS = 7 * DAY_MS            # a watch is issued at most this long before it begins
ENDED_LISTED_MS = 48 * HOUR_MS        # ended alerts stay listed (phase "ended") this long
SIMPLIFY_DEG = 0.001                  # about 100 m
COORD_PRECISION = 1e-4
TIMEOUT_S = 20.0
RETRIES = 1
KM_PER_DEG = 111.32

NWS_SOURCE: dict[str, str] = {
    "name": "National Weather Service",
    "url": "https://www.weather.gov/",
    "credit": "National Weather Service",
    "license": "U.S. Government work in the public domain; api.weather.gov data is open data, free to use for any "
               "purpose",
    "terms_url": "https://www.weather.gov/disclaimer",
}
IEM_SOURCE: dict[str, str] = {
    "name": "NWS products, archived copy: Iowa Environmental Mesonet",
    "url": "https://mesonet.agron.iastate.edu/vtec/",
    "credit": "National Weather Service, archived copy via the Iowa Environmental Mesonet (Iowa State University)",
    "license": "Public domain (IEM: \"may be used freely by anyone for any lawful purpose\"); not an official NWS "
               "source",
    "terms_url": "https://mesonet.agron.iastate.edu/disclaimer.php",
}


class SourceError(RuntimeError):
    """An upstream source failed (the message is user-facing and secret-free). ``status``: HTTP status or None."""

    def __init__(self, message: str, status: int | None = None):
        super().__init__(message)
        self.status = status


class SourceBusy(SourceError):
    """Fire-3d's own request limit for this source is reached."""


NWS_LIMITER = fhttp.RateLimiter(30, 60.0, "official: NWS API")
IEM_LIMITER = fhttp.RateLimiter(30, 60.0, "official: IEM archive")
_NWS_NAME = "The National Weather Service alert service"
_IEM_NAME = "The archive of past NWS alerts (Iowa Environmental Mesonet)"

_zones_lock = threading.Lock()
_zones: dict[tuple[str, str], tuple[float, "Zone | None"]] = {}
_details_lock = threading.Lock()
_details: dict[tuple, tuple[float, "EventDetail"]] = {}


def reset_state() -> None:
    """Forget the in-memory caches (tests)."""
    with _zones_lock:
        _zones.clear()
    with _details_lock:
        _details.clear()


# ----------------------------------------------------------------------------------------------------------------
# HTTP
# ----------------------------------------------------------------------------------------------------------------
_UNSAFE_UA = re.compile(r"[^\x20-\x7e]|[()]")


def user_agent() -> str:
    """User-Agent for NWS: ``config.USER_AGENT`` ("Fire-3d/0.1 (research prototype)"), with the optional
    ``FIRE3D_NWS_CONTACT`` (a website or email, sanitized) appended inside the parentheses. No personal data by
    default."""
    contact = _UNSAFE_UA.sub("", os.environ.get("FIRE3D_NWS_CONTACT", "")).strip()[:120]
    base = config.USER_AGENT
    if not contact:
        return base
    return f"{base[:-1]}; {contact})" if base.endswith(")") else f"{base} ({contact})"


def _nws_headers() -> dict[str, str]:
    return {"User-Agent": user_agent(), "Accept": "application/geo+json"}


def _get(url: str, params: Any, *, ttl_s: float, limiter: fhttp.RateLimiter, name: str,
         headers: dict[str, str] | None = None) -> fhttp.Response:
    """A cached GET; a rate-limit slot is spent only on real requests. Raises SourceBusy / SourceError."""
    hit = fhttp.peek_cache("GET", url, params, ttl_s)
    if hit is not None:
        return hit
    if not limiter.try_acquire():
        raise SourceBusy(f"{name}: Fire-3d's request limit is reached; try again in a minute")
    try:
        return fhttp.request("GET", url, params=params, headers=headers, ttl_s=ttl_s, timeout=TIMEOUT_S, retries=RETRIES)
    except fhttp.HttpError as e:
        code = f"HTTP {e.status}" if e.status is not None else "no response"
        raise SourceError(f"{name} could not be reached ({code})", e.status) from None
    except Exception as e:  # noqa: BLE001 - any other transport failure is an unreachable source too
        log.warning("%s: %s", name, config.mask_secrets(f"{type(e).__name__}: {e}"))
        raise SourceError(f"{name} could not be reached (no response)") from None


def _json(resp: fhttp.Response, url: str, params: Any, name: str) -> Any:
    try:
        return resp.json()
    except ValueError:
        fhttp.evict_cache("GET", url, params)
        raise SourceError(f"{name} sent a reply Fire-3d could not read") from None


# ----------------------------------------------------------------------------------------------------------------
# Small helpers
# ----------------------------------------------------------------------------------------------------------------
def _ms(v: Any) -> int | None:
    if not v:
        return None
    try:
        return iso_to_ms(str(v))
    except (TypeError, ValueError):
        return None


def _text(v: Any) -> str | None:
    """A one-line string field (stripped), or None."""
    if v is None or isinstance(v, (dict, list)):
        return None
    s = str(v).strip()
    return s or None


def _verbatim(v: Any) -> str | None:
    """Multi-line NWS text kept as written: line breaks kept, trailing spaces and outer blank lines removed."""
    if not isinstance(v, str):
        return None
    lines = [ln.rstrip() for ln in v.replace("\r\n", "\n").replace("\r", "\n").split("\n")]
    while lines and not lines[0]:
        lines.pop(0)
    while lines and not lines[-1]:
        lines.pop()
    return "\n".join(lines) or None


def _https(v: Any) -> str | None:
    s = _text(v)
    return s if s and s.startswith("https://") else None


def office_url(office: str | None) -> str | None:
    """The issuing NWS office's page (``KLOX`` -> https://www.weather.gov/lox), or None."""
    return f"{NWS_WEB}/{office[1:].lower()}" if office and re.fullmatch(r"K[A-Z]{3}", office) else None


# ----------------------------------------------------------------------------------------------------------------
# VTEC and UGC
# ----------------------------------------------------------------------------------------------------------------
VTEC_RE = re.compile(r"/([OTEX])\.([A-Z]{3})\.([A-Z]{4})\.([A-Z]{2})\.([A-Z])\.(\d{4})\.(\d{6}T\d{4}Z)-(\d{6}T\d{4}Z)/")
UGC_RE = re.compile(r"^[A-Z]{2}[CZ]\d{3}$")
_ZONE_URL_RE = re.compile(r"/zones/(fire|forecast|county|public)/([A-Z]{2}[CZ]\d{3})$")


def _vtec_time(s: str) -> int | None:
    if s.startswith("000000"):
        return None                                     # "already in effect" / "until further notice"
    try:
        return int(datetime.strptime(s, "%y%m%dT%H%MZ").replace(tzinfo=timezone.utc).timestamp() * 1000)
    except ValueError:
        return None


def parse_vtec(text: str) -> list[dict[str, Any]]:
    """Every P-VTEC string in ``text`` as ``{product_class, action, office, phenomena, significance, etn, begin_ms,
    end_ms}`` (times None for 000000T0000Z)."""
    out = []
    for m in VTEC_RE.finditer(text or ""):
        out.append({"product_class": m.group(1), "action": m.group(2), "office": m.group(3), "phenomena": m.group(4),
                    "significance": m.group(5), "etn": int(m.group(6)), "begin_ms": _vtec_time(m.group(7)),
                    "end_ms": _vtec_time(m.group(8))})
    return out


def _vtec_out(v: dict | None) -> dict | None:
    if not v:
        return None
    return {k: v[k] for k in ("office", "phenomena", "significance", "etn", "action")}


def expand_ugcs(block: str) -> list[str]:
    """Zone codes of a product's UGC block, e.g. ``CAZ362-369-370-372>374-548-110100-`` -> CAZ362, CAZ369, CAZ370,
    CAZ372, CAZ373, CAZ374, CAZ548 (``>`` ranges expanded; the DDHHMM expiry and ``ALL`` tokens dropped)."""
    out: list[str] = []
    prefix = None
    for tok in (t for t in re.sub(r"\s+", "", block or "").split("-") if t):
        m = re.fullmatch(r"([A-Z]{2}[CZ])(\d{3})(?:>(\d{3}))?", tok)
        if m:
            prefix, a, b = m.group(1), int(m.group(2)), int(m.group(3) or m.group(2))
        else:
            m = re.fullmatch(r"(\d{3})(?:>(\d{3}))?", tok)
            if not m or prefix is None:
                continue
            a, b = int(m.group(1)), int(m.group(2) or m.group(1))
        if a <= b <= 999:
            out.extend(f"{prefix}{n:03d}" for n in range(a, b + 1))
    return list(dict.fromkeys(out))


# ----------------------------------------------------------------------------------------------------------------
# Text products (archive)
# ----------------------------------------------------------------------------------------------------------------
_UGC_LINE_RE = re.compile(r"^[A-Z]{2}[CZ](?:\d{3}|ALL)[->]")
_UGC_END_RE = re.compile(r"-\d{6}-\s*$")
_TIME_LINE_RE = re.compile(r"^\d{3,4} (?:AM|PM) [A-Z]{3,4} [A-Z]{3} [A-Z]{3} \d{1,2} \d{4}$", re.I)
_PRECAUTION_RE = re.compile(r"^PRECAUTIONARY/PREPAREDNESS ACTIONS", re.I)


def product_sender(text: str) -> str | None:
    """The issuing office line of a text product ("National Weather Service Los Angeles/Oxnard CA")."""
    for ln in (text or "").splitlines()[:15]:
        s = ln.strip()
        if s.lower().startswith("national weather service"):
            return s
    return None


def _paragraphs(lines: list[str]) -> list[list[str]]:
    out: list[list[str]] = []
    cur: list[str] = []
    for ln in lines:
        if ln.strip():
            cur.append(ln.rstrip())
        elif cur:
            out.append(cur)
            cur = []
    if cur:
        out.append(cur)
    return out


def split_segment_body(lines: list[str]) -> dict[str, str | None]:
    """``headline`` (the first "..." paragraph, joined to one line), ``instruction`` (after "PRECAUTIONARY/
    PREPAREDNESS ACTIONS...") and ``description`` (the rest), all verbatim; "&&" or "$$" ends the text."""
    body: list[str] = []
    for ln in lines:
        if ln.strip() in ("&&", "$$"):
            break
        body.append(ln)
    headline = None
    desc: list[list[str]] = []
    instr: list[list[str]] = []
    in_instr = False
    for para in _paragraphs(body):
        first = para[0].strip()
        if _PRECAUTION_RE.match(first):
            in_instr = True
            para = para[1:]
            if para:
                instr.append(para)
        elif in_instr:
            instr.append(para)
        elif headline is None and not desc and first.startswith("..."):
            headline = " ".join(p.strip() for p in para)
        else:
            desc.append(para)
    join = lambda ps: "\n\n".join("\n".join(p) for p in ps).strip() or None  # noqa: E731
    return {"headline": headline, "description": join(desc), "instruction": join(instr)}


def product_segments(text: str) -> list[dict[str, Any]]:
    """The segments of an NWS text product: ``{ugcs, vtec, headline, description, instruction}``."""
    lines = (text or "").replace("\r\n", "\n").replace("\r", "\n").split("\n")
    out: list[dict[str, Any]] = []
    i, n = 0, len(lines)
    while i < n:
        if not _UGC_LINE_RE.match(lines[i].strip()):
            i += 1
            continue
        block = [lines[i].strip()]
        while not _UGC_END_RE.search(block[-1]) and i + 1 < n and len(block) < 12:
            i += 1
            block.append(lines[i].strip())
        end = i + 1
        while end < n and lines[end].strip() != "$$":
            end += 1
        seg = lines[i + 1:end]
        start = next((k + 1 for k, ln in enumerate(seg) if _TIME_LINE_RE.match(ln.strip())), None)
        body = seg[start:] if start is not None else [ln for ln in seg if not VTEC_RE.search(ln)]
        out.append({"ugcs": expand_ugcs("".join(block)), "vtec": parse_vtec("\n".join(seg)), **split_segment_body(body)})
        i = end + 1
    return out


# ----------------------------------------------------------------------------------------------------------------
# Geometry
# ----------------------------------------------------------------------------------------------------------------
def polygonal(g: Any) -> BaseGeometry | None:
    """A valid (Multi)Polygon from a GeoJSON geometry, or None."""
    if not isinstance(g, dict) or g.get("type") not in ("Polygon", "MultiPolygon", "GeometryCollection"):
        return None
    try:
        geom = shape(g)
    except (ValueError, TypeError, AttributeError, IndexError, KeyError):
        return None
    if not geom.is_valid:
        geom = shapely.make_valid(geom)
    if geom.geom_type == "GeometryCollection":
        polys = [p for p in geom.geoms if p.geom_type in ("Polygon", "MultiPolygon")]
        geom = shapely.union_all(polys) if polys else None
    return geom if geom is not None and not geom.is_empty and geom.area > 0 else None


def _km_frame(lon0: float, lat0: float) -> Callable[[np.ndarray], np.ndarray]:
    k = KM_PER_DEG * math.cos(math.radians(lat0))
    return lambda xy: np.column_stack(((xy[:, 0] - lon0) * k, (xy[:, 1] - lat0) * KM_PER_DEG))


def distance_km(geom: BaseGeometry, lon: float, lat: float) -> float:
    """Distance from (lon, lat) to ``geom`` in km (0 inside), in a local equirectangular frame."""
    return float(shapely.transform(geom, _km_frame(lon, lat)).distance(Point(0.0, 0.0)))


def simplified(geom: BaseGeometry, tol_deg: float = SIMPLIFY_DEG) -> dict:
    """GeoJSON of ``geom`` simplified for display (topology kept, coordinates on a 1e-4 degree grid)."""
    s = shapely.set_precision(geom.simplify(tol_deg, preserve_topology=True), COORD_PRECISION)
    return mapping(s if not s.is_empty else geom)


def zones_collection(zones: dict[str, dict], tol_deg: float = SIMPLIFY_DEG) -> dict:
    """``{key: {ugc, name, geom, alert_ids}}`` -> a FeatureCollection (simplified; properties ugc, name, alert_ids)."""
    feats = []
    for key in sorted(zones):
        z = zones[key]
        feats.append({"type": "Feature", "id": key, "geometry": simplified(z["geom"], tol_deg),
                      "properties": {"ugc": z["ugc"], "name": z["name"], "alert_ids": list(dict.fromkeys(z["alert_ids"]))}})
    return {"type": "FeatureCollection", "features": feats}


# ----------------------------------------------------------------------------------------------------------------
# Live alerts
# ----------------------------------------------------------------------------------------------------------------
def normalize_alert(feature: dict) -> dict[str, Any] | None:
    """One CAP alert of ``/alerts/active`` -> the endpoint's alert dict (wording verbatim); None unless it is an
    actual Red Flag Warning or Fire Weather Watch. Keys starting with "_" are internal."""
    p = feature.get("properties") if isinstance(feature, dict) else None
    if not isinstance(p, dict):
        return None
    event = _text(p.get("event"))
    if event not in FIRE_EVENTS or p.get("status") != "Actual":
        return None
    params = p.get("parameters") if isinstance(p.get("parameters"), dict) else {}
    vt = [v for s in (params.get("VTEC") or []) for v in parse_vtec(str(s))]
    fw = next((v for v in vt if v["phenomena"] == FIRE_PHENOMENA), vt[0] if vt else None)
    geocode = p.get("geocode") if isinstance(p.get("geocode"), dict) else {}
    ugcs = list(dict.fromkeys(u for u in (geocode.get("UGC") or []) if isinstance(u, str) and UGC_RE.match(u)))
    types: dict[str, str] = {}
    for z in p.get("affectedZones") or []:
        m = _ZONE_URL_RE.search(str(z))
        if m:
            types[m.group(2)] = m.group(1)
    headline = params.get("NWSheadline") or [None]
    return {
        "id": str(p.get("id") or feature.get("id") or ""),
        "url": _https(p.get("@id")) or _https(feature.get("id")),
        "office_url": office_url(fw["office"] if fw else None),
        "event": event,
        "vtec": _vtec_out(fw),
        "sender_name": _text(p.get("senderName")),
        "sent_ms": _ms(p.get("sent")),
        "effective_ms": _ms(p.get("effective")),
        "onset_ms": _ms(p.get("onset")),
        "expires_ms": _ms(p.get("expires")),
        "ends_ms": _ms(p.get("ends")),
        "headline": _text(p.get("headline")),
        "nws_headline": _text(headline[0] if isinstance(headline, list) and headline else None),
        "description": _verbatim(p.get("description")),
        "instruction": _verbatim(p.get("instruction")),
        "area_desc": _text(p.get("areaDesc")),
        "ugcs": ugcs,
        "message_type": _text(p.get("messageType")),
        "status": "Actual",
        "archived": False,
        "_zone_types": {u: types.get(u, "fire") for u in ugcs},
        "_geometry": polygonal(feature.get("geometry")),
    }


def active_alerts() -> tuple[list[dict], int, int | None]:
    """California's current Red Flag Warnings and Fire Weather Watches: ``(alerts, fetched_ms, NWS updated_ms)``.
    Raises SourceError / SourceBusy."""
    url = f"{NWS_API}/alerts/active?area=CA&event={quote(','.join(FIRE_EVENTS), safe=',')}"
    resp = _get(url, None, ttl_s=ALERTS_TTL_S, limiter=NWS_LIMITER, name=_NWS_NAME, headers=_nws_headers())
    data = _json(resp, url, None, _NWS_NAME)
    if not isinstance(data, dict) or not isinstance(data.get("features"), list):
        fhttp.evict_cache("GET", url, None)
        raise SourceError(f"{_NWS_NAME} sent an unexpected reply")
    alerts = [a for a in (normalize_alert(f) for f in data["features"]) if a is not None]
    return alerts, int(resp.fetched_ms), _ms(data.get("updated"))


@dataclass
class Zone:
    ugc: str
    name: str | None
    geom: BaseGeometry          # full polygon, lon/lat


def nws_zone(ugc: str, zone_type: str = "fire") -> Zone | None:
    """An NWS zone polygon (``/zones/{type}/{UGC}``, cached 30 days); None when NWS has no polygon for it.
    Raises SourceError / SourceBusy."""
    if not UGC_RE.match(ugc or "") or zone_type not in ("fire", "forecast", "county", "public"):
        return None
    key = (zone_type, ugc)
    with _zones_lock:
        hit = _zones.get(key)
        if hit is not None and hit[0] > time.monotonic():
            return hit[1]
    url = f"{NWS_API}/zones/{zone_type}/{ugc}"
    try:
        resp = _get(url, None, ttl_s=ZONE_TTL_S, limiter=NWS_LIMITER, name="The National Weather Service zone service",
                    headers=_nws_headers())
        data = _json(resp, url, None, "The National Weather Service zone service")
    except SourceBusy:
        raise
    except SourceError as e:
        if e.status != 404:
            raise
        data = None
    props = data.get("properties") if isinstance(data, dict) and isinstance(data.get("properties"), dict) else {}
    geom = polygonal(data.get("geometry")) if isinstance(data, dict) else None
    zone = Zone(ugc, _text(props.get("name")), geom) if geom is not None else None
    with _zones_lock:
        _zones[key] = (time.monotonic() + (ZONE_TTL_S if zone else ZONE_MISS_TTL_S), zone)
    return zone


def live_phase(a: dict, now: int) -> str:
    """``upcoming`` | ``in_effect`` | ``ended`` for a live alert at ``now`` (CAN / UPG / EXP or a past end: ended)."""
    action = (a.get("vtec") or {}).get("action")
    if a.get("message_type") == "Cancel" or action in ("CAN", "UPG", "EXP"):
        return "ended"
    if a.get("onset_ms") and now < a["onset_ms"]:
        return "upcoming"
    end = a.get("ends_ms") or None
    if end is not None and now >= end:
        return "ended"
    return "in_effect"


_PHASE_ORDER = {"in_effect": 0, "upcoming": 1, "ended": 2}


def _sort_key(a: dict) -> tuple:
    return (_PHASE_ORDER.get(a.get("phase"), 3), 0 if a.get("covers_reported_location") else 1,
            a.get("nearest_km") if a.get("nearest_km") is not None else 1e9, a.get("onset_ms") or 0, a.get("id"))


def _public(a: dict) -> dict:
    return {k: v for k, v in a.items() if not k.startswith("_")}


def place_live(alerts: list[dict], area: BBox | None, point: tuple[float, float] | None, *, now: int,
               zone_loader: Callable[[str, str], Zone | None] | None = None,
               tol_deg: float = SIMPLIFY_DEG) -> tuple[list[dict], dict, list[str]]:
    """The live alerts whose area meets ``area`` (every alert when None), each with ``covers_reported_location`` and
    ``nearest_km`` for ``point`` (lon, lat) and its ``phase``; the zones FeatureCollection (zones meeting the area);
    caveats. An alert none of whose zones could be loaded is listed with both values null, never dropped.
    ``zone_loader`` defaults to :func:`nws_zone`."""
    zone_loader = zone_loader or nws_zone
    abox = box(*area) if area else None
    zones: dict[str, dict] = {}
    out: list[dict] = []
    unplaced = partial = 0
    for a in alerts:
        parts: list[tuple[str | None, str | None, BaseGeometry]] = []
        missing = 0
        if a.get("_geometry") is not None:
            parts.append((None, None, a["_geometry"]))
        else:
            for ugc in a.get("ugcs") or []:
                try:
                    z = zone_loader(ugc, (a.get("_zone_types") or {}).get(ugc, "fire"))
                except SourceError as e:
                    log.info("NWS zone %s unavailable: %s", ugc, e)
                    z = None
                if z is None:
                    missing += 1
                else:
                    parts.append((z.ugc, z.name, z.geom))
        near = [pt for pt in parts if abox is None or pt[2].intersects(abox)]
        if not near and not missing:
            continue                                    # elsewhere in California
        alert = _public(a)
        alert["phase"] = live_phase(a, now)
        if not near:
            unplaced += 1
            alert.update(covers_reported_location=None, nearest_km=None)
            out.append(alert)
            continue
        if missing:
            partial += 1
        covers: bool | None = None
        nearest: float | None = None
        if point is not None:
            here = Point(*point)
            if any(g.covers(here) for _, _, g in parts):
                covers, nearest = True, 0.0
            elif not missing:
                covers, nearest = False, round(min(distance_km(g, *point) for _, _, g in parts), 1)
        alert.update(covers_reported_location=covers, nearest_km=nearest)
        for ugc, name, geom in near:
            z = zones.setdefault(ugc or alert["id"], {"ugc": ugc, "name": name, "geom": geom, "alert_ids": []})
            z["alert_ids"].append(alert["id"])
        out.append(alert)
    caveats = []
    if unplaced:
        caveats.append(f"{unplaced} fire weather alert(s) could not be placed on the map because NWS zone outlines did "
                       "not load; they are listed without a distance. Check weather.gov.")
    if partial:
        caveats.append("Some NWS zone outlines did not load, so a few distances are not shown.")
    out.sort(key=_sort_key)
    return out, zones_collection(zones, tol_deg), caveats


# ----------------------------------------------------------------------------------------------------------------
# Archive (IEM)
# ----------------------------------------------------------------------------------------------------------------
def _day(ms: int) -> str:
    return ms_to_dt(ms).strftime("%Y-%m-%d")


def archive_ttl_s(window_end_ms: int, now: int) -> float:
    """30 min while the window touches the last day (the archive is still filling), else 30 days."""
    return IEM_RECENT_TTL_S if window_end_ms >= now - DAY_MS else IEM_PAST_TTL_S


@dataclass
class ArchiveEvent:
    """One VTEC fire weather event found by bypoint at the sample points."""

    wfo: str                    # 3-letter office id (IEM), e.g. "LOX"
    year: int
    phenomena: str
    significance: str
    etn: int
    url: str | None             # IEM's page for the event
    rows: list[dict] = field(default_factory=list)       # {ugc, issue_ms, expire_ms} at the sample points
    point_ugcs: set[str] = field(default_factory=set)    # zones found at the reported location

    @property
    def key(self) -> tuple[str, int, str, str, int]:
        return (self.wfo, self.year, self.phenomena, self.significance, self.etn)

    @property
    def event(self) -> str:
        return EVENT_BY_SIGNIFICANCE.get(self.significance, f"{self.phenomena}.{self.significance}")


def bypoint_events(rows: Iterable[dict], *, at_point: bool, into: dict[tuple, ArchiveEvent] | None = None) -> dict[tuple, ArchiveEvent]:
    """Group IEM ``vtec_events_bypoint`` rows into fire weather events (FW.W / FW.A only)."""
    out = into if into is not None else {}
    for r in rows:
        if not isinstance(r, dict) or r.get("phenomena") != FIRE_PHENOMENA or r.get("significance") not in EVENT_BY_SIGNIFICANCE:
            continue
        wfo = str(r.get("wfo") or "").upper()
        try:
            etn = int(r.get("eventid"))
        except (TypeError, ValueError):
            continue
        url = str(r.get("url") or "")
        m = re.search(r"year=(\d{4})", url)
        issue, expire = _ms(r.get("issue")), _ms(r.get("expire"))
        year = int(m.group(1)) if m else (ms_to_dt(issue).year if issue else None)
        if not re.fullmatch(r"[A-Z]{3}", wfo) or year is None:
            continue
        key = (wfo, year, FIRE_PHENOMENA, r["significance"], etn)
        ev = out.get(key)
        if ev is None:
            ev = out[key] = ArchiveEvent(wfo, year, FIRE_PHENOMENA, r["significance"], etn,
                                         f"{IEM_ROOT}{url}" if url.startswith("/vtec/") else None)
        ugc = str(r.get("ugc") or "")
        if UGC_RE.match(ugc):
            ev.rows.append({"ugc": ugc, "issue_ms": issue, "expire_ms": expire})
            if at_point:
                ev.point_ugcs.add(ugc)
    return out


@dataclass
class EventDetail:
    """``json/vtec_event.py`` (per-zone times and text products) and ``geojson/vtec_event.py`` (zone polygons)."""

    zone_rows: list[dict]                       # {ugc, name, status, product_issue_ms, issue_ms, expire_ms, updated_ms}
    products: list[dict]                        # {valid_ms, product_id, text}, oldest first
    zones: dict[str, BaseGeometry] = field(default_factory=dict)
    _segments: dict[str, list[dict]] = field(default_factory=dict)

    def segments(self, product: dict) -> list[dict]:
        pid = str(product.get("product_id") or product.get("valid_ms"))
        if pid not in self._segments:
            self._segments[pid] = product_segments(product.get("text") or "")
        return self._segments[pid]


def parse_event_detail(data: Any) -> EventDetail:
    """The parts of IEM's ``vtec_event.py`` reply Fire-3d uses."""
    if not isinstance(data, dict) or not data.get("event_exists", True):
        raise ValueError("no such event")
    rows = []
    for u in data.get("ugcs") or []:
        if isinstance(u, dict) and UGC_RE.match(str(u.get("ugc") or "")):
            rows.append({"ugc": u["ugc"], "name": _text(u.get("name")), "status": _text(u.get("status")),
                         "product_issue_ms": _ms(u.get("utc_product_issue")), "issue_ms": _ms(u.get("utc_issue")),
                         "expire_ms": _ms(u.get("utc_expire")), "updated_ms": _ms(u.get("utc_updated"))})
    products = []
    for p in [data.get("report")] + list(data.get("svs") or []):
        if isinstance(p, dict) and isinstance(p.get("text"), str) and _ms(p.get("valid")) is not None:
            products.append({"valid_ms": _ms(p.get("valid")), "product_id": _text(p.get("product_id")), "text": p["text"]})
    products.sort(key=lambda p: p["valid_ms"])
    return EventDetail(rows, products)


def parse_event_zones(data: Any) -> dict[str, BaseGeometry]:
    """IEM ``geojson/vtec_event.py`` -> {UGC: polygon} (the feature id is the UGC; repeated ids are merged)."""
    out: dict[str, BaseGeometry] = {}
    for f in (data.get("features") if isinstance(data, dict) else None) or []:
        ugc = str((f or {}).get("id") or "")
        g = polygonal((f or {}).get("geometry"))
        if UGC_RE.match(ugc) and g is not None:
            out[ugc] = g if ugc not in out else shapely.union(out[ugc], g)
    return out


def _event_params(ev: ArchiveEvent) -> dict[str, Any]:
    return {"wfo": ev.wfo, "year": ev.year, "phenomena": ev.phenomena, "significance": ev.significance, "etn": ev.etn}


def _event_ttl_s(ev: ArchiveEvent, now: int) -> float:
    return archive_ttl_s(max((r["expire_ms"] or 0 for r in ev.rows), default=0), now)


def event_detail(ev: ArchiveEvent, *, now: int) -> EventDetail:
    """IEM's per-zone times and text products of one event, cached in memory and on disk (30 days once the event
    is over, else 30 min). Raises SourceError / SourceBusy."""
    with _details_lock:
        hit = _details.get(ev.key)
        if hit is not None and hit[0] > time.monotonic():
            return hit[1]
    params = _event_params(ev)
    ttl = _event_ttl_s(ev, now)
    resp = _get(IEM_EVENT_URL, params, ttl_s=ttl, limiter=IEM_LIMITER, name=_IEM_NAME)
    try:
        detail = parse_event_detail(_json(resp, IEM_EVENT_URL, params, _IEM_NAME))
    except ValueError:
        fhttp.evict_cache("GET", IEM_EVENT_URL, params)
        raise SourceError(f"{_IEM_NAME} has no record of this event") from None
    with _details_lock:
        _details[ev.key] = (time.monotonic() + min(ttl, 3600.0), detail)
    return detail


def load_event_zones(ev: ArchiveEvent, detail: EventDetail, *, now: int) -> None:
    """Fill ``detail.zones`` from IEM's zone polygons of the event (cached like :func:`event_detail`)."""
    if detail.zones:
        return
    params = _event_params(ev)
    resp = _get(IEM_EVENT_GEOJSON_URL, params, ttl_s=_event_ttl_s(ev, now), limiter=IEM_LIMITER, name=_IEM_NAME)
    detail.zones = parse_event_zones(_json(resp, IEM_EVENT_GEOJSON_URL, params, _IEM_NAME))


def segment_at(detail: EventDetail, ugc: str, ev: ArchiveEvent, at_ms: int) -> tuple[dict | None, dict | None]:
    """(product, segment): the latest product issued by ``at_ms`` with a segment for ``ugc`` carrying this event's
    VTEC; else the first product that has one (the event's text when nothing was issued yet)."""
    def has(seg: dict) -> bool:
        return ugc in seg["ugcs"] and any(v["phenomena"] == ev.phenomena and v["significance"] == ev.significance
                                          and v["etn"] == ev.etn for v in seg["vtec"])

    best: tuple[dict | None, dict | None] = (None, None)
    first: tuple[dict | None, dict | None] = (None, None)
    for prod in detail.products:
        seg = next((s for s in detail.segments(prod) if has(s)), None)
        if seg is None:
            continue
        if first[0] is None:
            first = (prod, seg)
        if prod["valid_ms"] <= at_ms:
            best = (prod, seg)
    return best if best[0] is not None else first


def zone_phase(row: dict, at_ms: int) -> str:
    """Phase of one per-zone row at ``at_ms`` (a row that ends before it begins was upgraded or cancelled early)."""
    issue, expire = row.get("issue_ms"), row.get("expire_ms")
    if expire is not None and at_ms >= expire:
        return "ended"
    if issue is not None and at_ms < issue:
        return "upcoming"
    return "in_effect"


def split_headlines(text: str | None) -> list[str]:
    """The headlines of an NWS headline paragraph ("...A... ...B..." -> ["...A...", "...B..."]), verbatim."""
    if not text:
        return []
    return [p.strip() for p in re.split(r"(?<=\.\.\.)\s+(?=\.\.\.)", text.strip()) if p.strip()]


def event_headline(paragraph: str | None, event: str) -> str | None:
    """The headline of ``paragraph`` that names ``event`` (a segment can head several products), else the paragraph."""
    heads = split_headlines(paragraph)
    return next((h for h in heads if event.upper() in h.upper()), paragraph)


def stated_times(seg_vtec: dict | None, row: dict, phase: str, at_ms: int) -> tuple[int | None, int | None]:
    """(onset_ms, ends_ms) as the latest statement issued by ``at_ms`` gave them for the zone, so they match its
    quoted text; the archive's per-zone times where the statement gives none or disagrees with ``phase`` (which
    comes from the per-zone times). An ended alert ends at the archive's per-zone end (known by ``at_ms``)."""
    onset, end = row.get("issue_ms"), row.get("expire_ms")
    if phase == "ended" or seg_vtec is None:
        return onset, end
    s_on, s_end = seg_vtec.get("begin_ms"), seg_vtec.get("end_ms")
    if s_on is not None and (s_on > at_ms) == (phase == "upcoming"):
        onset = s_on
    if s_end is not None and s_end > at_ms and (onset is None or s_end > onset):
        end = s_end
    return onset, end


def _pick_row(rows: list[dict], at_ms: int) -> dict:
    """The row that best describes the event at ``at_ms``: in effect, else the next to begin, else the last to end."""
    for phase in ("in_effect", "upcoming"):
        cand = [r for r in rows if zone_phase(r, at_ms) == phase]
        if cand:
            return min(cand, key=lambda r: r.get("issue_ms") or 0) if phase == "upcoming" else max(cand, key=lambda r: r.get("expire_ms") or 0)
    return max(rows, key=lambda r: r.get("expire_ms") or 0)


def place_archive(events: list[ArchiveEvent], details: dict[tuple, EventDetail | None], area: BBox,
                  point: tuple[float, float] | None, at_ms: int, *, tol_deg: float = SIMPLIFY_DEG) -> tuple[list[dict], dict]:
    """Archived alerts (``archived: true``) that had been issued by ``at_ms`` for zones meeting ``area`` and had not
    ended more than :data:`ENDED_LISTED_MS` before it, plus their zones FeatureCollection."""
    abox = box(*area)
    here = Point(*point) if point else None
    zones: dict[str, dict] = {}
    out: list[dict] = []
    for ev in events:
        det = details.get(ev.key)
        rows = list(det.zone_rows) if det and det.zone_rows else [
            {"ugc": r["ugc"], "name": None, "status": None, "product_issue_ms": None, "issue_ms": r["issue_ms"],
             "expire_ms": r["expire_ms"], "updated_ms": None} for r in ev.rows]
        geoms = det.zones if det else {}
        names = {r["ugc"]: r["name"] for r in rows if r.get("name")}
        sampled = {r["ugc"] for r in ev.rows}                       # the sample points lie inside the area
        near = sampled | {u for u, g in geoms.items() if g.intersects(abox)}
        covering = set(ev.point_ugcs) | ({u for u, g in geoms.items() if here is not None and g.covers(here)})
        considered = [r for r in rows if r["ugc"] in near]
        known = [r for r in considered if (r.get("product_issue_ms") or r.get("issue_ms") or 0) <= at_ms]
        if not known:
            continue
        basis = [r for r in known if r["ugc"] in covering] or known
        phases = {zone_phase(r, at_ms) for r in basis}
        phase = next(p for p in ("in_effect", "upcoming", "ended") if p in phases)
        if phase == "ended" and at_ms >= max((r.get("expire_ms") or 0) for r in basis) + ENDED_LISTED_MS:
            continue
        row = _pick_row(basis, at_ms)
        prod, seg = segment_at(det, row["ugc"], ev, at_ms) if det else (None, None)
        seg_vtec = next((v for v in (seg or {}).get("vtec", []) if v["phenomena"] == ev.phenomena
                         and v["significance"] == ev.significance and v["etn"] == ev.etn), None)
        office = seg_vtec["office"] if seg_vtec else f"K{ev.wfo}"
        covers = bool(covering) if (here is not None) else None
        nearest = 0.0 if covers else (round(min(distance_km(g, *point) for g in geoms.values()), 1)
                                      if geoms and point is not None else None)
        alert_id = f"{ev.year}-{office}-{ev.phenomena}-{ev.significance}-{ev.etn:04d}"
        all_ugcs = list(dict.fromkeys(r["ugc"] for r in rows))
        sent = prod["valid_ms"] if prod else row.get("product_issue_ms")
        onset, ends = stated_times(seg_vtec, row, phase, at_ms)
        out.append({
            "id": alert_id,
            "url": ev.url,
            "office_url": office_url(office),
            "event": ev.event,
            "vtec": {"office": office, "phenomena": ev.phenomena, "significance": ev.significance, "etn": ev.etn,
                     "action": seg_vtec["action"] if seg_vtec else (row.get("status") or "")},
            "sender_name": product_sender(prod["text"]) if prod else None,
            "sent_ms": sent,
            "effective_ms": sent,
            "onset_ms": onset,
            "expires_ms": None,                         # a CAP message expiry; archived products have none
            "ends_ms": ends,
            "headline": event_headline((seg or {}).get("headline"), ev.event),
            "nws_headline": (seg or {}).get("headline"),
            "description": (seg or {}).get("description"),
            "instruction": (seg or {}).get("instruction"),
            "area_desc": "; ".join(dict.fromkeys(names[u] for u in all_ugcs if u in names)) or None,
            "ugcs": all_ugcs,
            "message_type": None,
            "status": "Actual",
            "covers_reported_location": covers,
            "nearest_km": nearest,
            "archived": True,
            "phase": phase,
        })
        for ugc in sorted(u for u in near if u in geoms):
            z = zones.setdefault(ugc, {"ugc": ugc, "name": names.get(ugc), "geom": geoms[ugc], "alert_ids": []})
            z["alert_ids"].append(alert_id)
    out.sort(key=_sort_key)
    return out, zones_collection(zones, tol_deg)


def archive_for_area(area: BBox, point: tuple[float, float], samples: list[tuple[float, float]], at_ms: int,
                     window: tuple[int, int], *, now: int | None = None) -> dict[str, Any]:
    """Archived fire weather alerts near ``area`` at ``at_ms`` (see :func:`place_archive`): ``{alerts, zones,
    caveats, retrieved_ms}``. ``samples``: (lon, lat) points searched in the archive, the reported location first.
    Raises SourceError when the archive cannot be searched at the reported location, SourceBusy at Fire-3d's limit."""
    now = now or now_ms()
    ttl = archive_ttl_s(window[1], now)
    events: dict[tuple, ArchiveEvent] = {}
    fetched: list[int] = []
    caveats: list[str] = []
    failed = 0
    for i, (lon, lat) in enumerate(samples):
        params = {"lat": f"{lat:.4f}", "lon": f"{lon:.4f}", "sdate": _day(window[0]), "edate": _day(window[1])}
        try:
            resp = _get(IEM_BYPOINT_URL, params, ttl_s=ttl, limiter=IEM_LIMITER, name=_IEM_NAME)
            data = _json(resp, IEM_BYPOINT_URL, params, _IEM_NAME)
            if not isinstance(data, dict) or not isinstance(data.get("events"), list):
                fhttp.evict_cache("GET", IEM_BYPOINT_URL, params)
                raise SourceError(f"{_IEM_NAME} sent an unexpected reply")
        except SourceError:
            if i == 0:                  # the reported location itself: the archive answer would be incomplete
                raise
            failed += 1
            continue
        fetched.append(int(resp.fetched_ms))
        bypoint_events(data["events"], at_point=(i == 0), into=events)
    if failed:
        caveats.append("Part of the area could not be searched in the archive, so an alert there could be missing.")
    # Only events that can matter at at_ms: begun or announced by then, and not ended long before.
    cand = [ev for ev in events.values()
            if min((r["issue_ms"] or at_ms) for r in ev.rows) - WATCH_LEAD_MS <= at_ms
            and at_ms < max((r["expire_ms"] or at_ms) for r in ev.rows) + ENDED_LISTED_MS]
    details: dict[tuple, EventDetail | None] = {}
    text_missing = 0
    for ev in cand:
        try:
            det = event_detail(ev, now=now)
            if any((r.get("product_issue_ms") or r.get("issue_ms") or at_ms + 1) <= at_ms for r in det.zone_rows):
                load_event_zones(ev, det, now=now)       # polygons only for events issued by at_ms
            details[ev.key] = det
        except SourceBusy:
            raise
        except SourceError as e:
            log.info("IEM detail of %s unavailable: %s", ev.key, e)
            details[ev.key] = None
            text_missing += 1
    if text_missing:
        caveats.append("The archived text or area of some alerts could not be loaded; they are listed with the "
                       "archive's times only.")
    alerts, zones = place_archive(cand, details, area, point, at_ms)
    return {"alerts": alerts, "zones": zones, "caveats": caveats, "retrieved_ms": min(fetched) if fetched else None}
