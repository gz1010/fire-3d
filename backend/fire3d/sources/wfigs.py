"""NIFC WFIGS incident locations (IRWIN), the national fire list (brief 3, CONTRACT 14.1-14.2). Owner: us-catalog.

Three ArcGIS layers of ``services3.arcgis.com/T4QMspbfLg3qTGWY`` (owner NIFC_Authoritative; item licence is a
disclaimer only; credit "NIFC WFIGS (IRWIN)"):

* ``WFIGS_Incident_Locations_Current``: NIFC's own active rule (not declared contained, controlled or out; valid, not
  quarantined; falls off 3-14 days after the last edit). :func:`list_current`, cached 5 min.
* ``WFIGS_Incident_Locations_YearToDate``: this year's incidents. :func:`list_year` for the current UTC year, 30 min.
* ``WFIGS_Incident_Locations``: all years. :func:`list_year` for past years (24 h) and :func:`find_irwin_prefix`.

Every request filters server-side to wildfires (``IncidentTypeCategory='WF'``; year lists also ``IncidentSize >=
min``), names its ``outFields``, asks ``outSR=4326`` and goes through :mod:`fire3d.http` (cache, polite rate,
identifying User-Agent). Rows are returned as cleaned dicts (:func:`normalize`): the raw attribute keys plus
snake_case fields (``irwin_id`` upper case without braces, ``state`` USPS, times in epoch ms, ``lat`` / ``lon``).
When WFIGS is unreachable a stale cached copy is served (with a warning) before :class:`WfigsError` is raised.
"""

from __future__ import annotations

import logging
import math
import re
import threading
import time
from typing import Any
from urllib.parse import quote

from .. import config
from .. import http as fhttp

log = logging.getLogger(__name__)

SERVICE = "https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services"
CURRENT_URL = SERVICE + "/WFIGS_Incident_Locations_Current/FeatureServer/0/query"
YTD_URL = SERVICE + "/WFIGS_Incident_Locations_YearToDate/FeatureServer/0/query"
ALL_YEARS_URL = SERVICE + "/WFIGS_Incident_Locations/FeatureServer/0/query"
DATASET_URL = "https://data-nifc.opendata.arcgis.com/datasets/nifc::wildland-fire-incident-locations"   # item b4402f78...
NAME = "NIFC WFIGS (IRWIN)"
CREDIT = "NIFC WFIGS (IRWIN)"

CURRENT_TTL_S = 300.0          # 5 min (WFIGS refreshes from IRWIN every 5 min)
RECORD_TTL_S = 600.0           # 10 min: one record by IRWIN id (the incident-record endpoint)
YTD_TTL_S = 1800.0             # 30 min
ALL_YEARS_TTL_S = 86400.0      # 24 h
REFRESH_TTL_S = 1e-6
PAGE = 2000                    # the layers' maxRecordCount
TIMEOUT_S = 90.0

OUT_FIELDS = (
    "IrwinID", "UniqueFireIdentifier", "IncidentName", "IncidentTypeCategory", "IncidentSize", "PercentContained",
    "FireDiscoveryDateTime", "ContainmentDateTime", "ControlDateTime", "FireOutDateTime", "ModifiedOnDateTime_dt",
    "POOState", "POOCounty", "POOProtectingAgency", "POOProtectingUnit", "GACC", "IsCpxChild", "CpxName", "CpxID",
    "ICS209ReportDateTime",
)
WILDFIRE = "WF"
_BRACES = re.compile(r"[{}\s]")
_fetched_lock = threading.Lock()
_fetched: dict[str, int] = {}     # list key -> fetch time (ms) of the copy last returned


class WfigsError(RuntimeError):
    """A WFIGS list is unavailable (and no cached copy)."""


# ------------------------------------------------------------------------------------------------------------------
# Rows
# ------------------------------------------------------------------------------------------------------------------
def clean_irwin(value: Any) -> str:
    """``"{51374d2c-...}"`` -> ``"51374D2C-..."`` (upper case, no braces); "" when missing."""
    return _BRACES.sub("", str(value or "")).upper()


def record_url(irwin_id: str) -> str:
    """The record's human-readable page: the all-years layer's ``f=html`` query by IrwinID (https)."""
    where = quote("IrwinID='{" + clean_irwin(irwin_id) + "}'", safe="")
    return f"{ALL_YEARS_URL}?where={where}&outFields=*&f=html"


def _ms(value: Any) -> int | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        v = float(value)
    except (TypeError, ValueError):
        return None
    return int(v) if math.isfinite(v) else None


def _num(value: Any) -> float | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        v = float(value)
    except (TypeError, ValueError):
        return None
    return v if math.isfinite(v) else None


def _str(value: Any) -> str | None:
    s = " ".join(str(value).split()) if value is not None else ""
    return s or None


def ufi_year(ufi: Any) -> int | None:
    """The fire year of a NWCG UniqueFireIdentifier ("2026-TXTXS-000006" -> 2026)."""
    m = re.match(r"^\s*(\d{4})-", str(ufi or ""))
    return int(m.group(1)) if m else None


def normalize(feature: dict) -> dict | None:
    """One ArcGIS JSON feature -> cleaned dict (raw attributes kept, snake_case fields added); None without an IRWIN
    id, a discovery time or coordinates."""
    a = dict(feature.get("attributes") or {})
    g = feature.get("geometry") or {}
    irwin = clean_irwin(a.get("IrwinID"))
    lon, lat = _num(g.get("x")), _num(g.get("y"))
    started = _ms(a.get("FireDiscoveryDateTime"))
    if not irwin or lon is None or lat is None or started is None or not (-180 <= lon <= 180 and -90 <= lat <= 90):
        return None
    st = str(a.get("POOState") or "").strip().upper()
    size = _num(a.get("IncidentSize"))
    pc = _num(a.get("PercentContained"))
    rec = {**a}
    rec.update({
        "irwin_id": irwin,
        "unique_fire_id": _str(a.get("UniqueFireIdentifier")),
        "year": ufi_year(a.get("UniqueFireIdentifier")) or time.gmtime(started / 1000).tm_year,
        "source_name": _str(a.get("IncidentName")) or "Unnamed",
        "type": str(a.get("IncidentTypeCategory") or "").strip().upper(),
        "acres": size if size is not None and size >= 0 else None,
        "percent_contained": pc if pc is not None and 0 <= pc <= 100 else None,
        "started_ms": started,
        "contained_ms": _ms(a.get("ContainmentDateTime")),
        "controlled_ms": _ms(a.get("ControlDateTime")),
        "out_ms": _ms(a.get("FireOutDateTime")),
        "updated_ms": _ms(a.get("ModifiedOnDateTime_dt")),
        "ics209_report_ms": _ms(a.get("ICS209ReportDateTime")),
        "poo_state": st[3:] if st.startswith("US-") else (st or None),
        "poo_state_raw": st or None,
        "county": _str(a.get("POOCounty")),
        "agency_code": _str(a.get("POOProtectingAgency")),
        "protecting_unit": _str(a.get("POOProtectingUnit")),
        "gacc": _str(a.get("GACC")),
        "is_cpx_child": bool(a.get("IsCpxChild")),
        "cpx_name": _str(a.get("CpxName")),
        "cpx_id": clean_irwin(a.get("CpxID")) or None,
        "lat": lat,
        "lon": lon,
        "url": record_url(irwin),
    })
    return rec


# ------------------------------------------------------------------------------------------------------------------
# Requests
# ------------------------------------------------------------------------------------------------------------------
def list_key(url: str, where: str) -> str:
    layer = "current" if url == CURRENT_URL else "ytd" if url == YTD_URL else "all"
    return f"{layer}:{where}"


def fetched_ms(key: str) -> int | None:
    """When the copy of list ``key`` last returned was fetched from WFIGS (a cached copy keeps its fetch time)."""
    with _fetched_lock:
        return _fetched.get(key)


def last_fetched_ms() -> int | None:
    """The newest fetch time of any WFIGS list this process returned (for ``ListSource.retrieved_ms``)."""
    with _fetched_lock:
        return max(_fetched.values()) if _fetched else None


def _params(where: str, offset: int) -> dict[str, str]:
    return {"where": where, "outFields": ",".join(OUT_FIELDS), "outSR": "4326", "returnGeometry": "true", "f": "json",
            "orderByFields": "OBJECTID", "resultOffset": str(offset), "resultRecordCount": str(PAGE)}


def _get_page(url: str, params: dict, ttl_s: float | None, retries: int = fhttp.DEFAULT_RETRIES) -> tuple[list, bool, int]:
    resp = fhttp.request("GET", url, params=params, ttl_s=ttl_s, timeout=TIMEOUT_S, retries=retries)
    try:
        data = resp.json()
    except ValueError as e:
        fhttp.evict_cache("GET", url, params)
        raise WfigsError(f"WFIGS: invalid JSON ({e})") from None
    if not isinstance(data, dict) or "features" not in data:
        fhttp.evict_cache("GET", url, params)
        msg = (data.get("error") or {}).get("message") if isinstance(data, dict) else None
        raise WfigsError(f"WFIGS: unexpected answer ({msg or type(data).__name__})")
    return list(data["features"]), bool(data.get("exceededTransferLimit")), int(resp.fetched_ms)


def _query(url: str, where: str, ttl_s: float, refresh: bool) -> list[dict]:
    """Every page of a query (cached per page); on failure any cached copy (stale-if-error)."""
    feats: list[dict] = []
    fetched: list[int] = []
    offset = 0
    while True:
        params = _params(where, offset)
        try:
            page, more, t = _get_page(url, params, REFRESH_TTL_S if refresh else ttl_s)
        except (fhttp.HttpError, WfigsError) as e:
            try:
                page, more, t = _get_page(url, params, None, retries=0)    # any age; network only if never cached
                log.warning("WFIGS list unavailable (%s); serving the cached copy", config.mask_secrets(e))
            except (fhttp.HttpError, WfigsError):
                raise WfigsError(f"NIFC WFIGS list unavailable: {config.mask_secrets(e)}") from None
        feats += page
        fetched.append(t)
        if not more or not page or offset > 50 * PAGE:
            break
        offset += len(page)
    with _fetched_lock:
        _fetched[list_key(url, where)] = min(fetched)
    return [r for r in (normalize(f) for f in feats) if r is not None]


def current_where() -> str:
    return f"IncidentTypeCategory='{WILDFIRE}'"


def year_where(year: int, min_acres: float) -> str:
    w = f"IncidentTypeCategory='{WILDFIRE}' AND UniqueFireIdentifier LIKE '{int(year)}-%'"
    if min_acres and min_acres > 0:
        w += f" AND IncidentSize>={float(min_acres):g}"
    return w


def list_current(refresh: bool = False) -> list[dict]:
    """Every wildfire row of the Current layer (NIFC's active rule), all states, all sizes, cleaned."""
    return _query(CURRENT_URL, current_where(), CURRENT_TTL_S, refresh)


def list_year(year: int, min_acres: float = 300.0, refresh: bool = False) -> list[dict]:
    """The wildfires of fire year ``year`` (UniqueFireIdentifier year) of ``min_acres`` or more, all states: the
    YearToDate layer for the current UTC year (30 min cache), the all-years layer for past years (24 h)."""
    year = int(year)
    if year >= time.gmtime().tm_year:
        return _query(YTD_URL, year_where(year, min_acres), YTD_TTL_S, refresh)
    return _query(ALL_YEARS_URL, year_where(year, min_acres), ALL_YEARS_TTL_S, refresh)


def find_irwin_prefix(prefix: str, refresh: bool = False) -> list[dict]:
    """Wildfire rows of the all-years layer whose IRWIN id starts with ``prefix`` (hex, case-insensitive): one cached
    ``IrwinID LIKE '{ABCDEF%'`` query (24 h)."""
    p = re.sub(r"[^0-9A-Fa-f-]", "", str(prefix or "")).upper()
    if len(p) < 6:
        return []
    where = f"IrwinID LIKE '{{{p}%' AND IncidentTypeCategory='{WILDFIRE}'"
    return _query(ALL_YEARS_URL, where, ALL_YEARS_TTL_S, refresh)


def record_by_irwin(irwin_id: str, refresh: bool = False) -> dict | None:
    """One record of the all-years layer by its exact IRWIN id (any incident type; cached 10 min), cleaned; None when
    WFIGS has no such record. Raises :class:`WfigsError` when WFIGS is unreachable and nothing is cached."""
    irwin = clean_irwin(irwin_id)
    if not re.fullmatch(r"[0-9A-F-]{8,64}", irwin):
        return None
    rows = _query(ALL_YEARS_URL, "IrwinID='{" + irwin + "}'", RECORD_TTL_S, refresh)
    rows = [r for r in rows if r["irwin_id"] == irwin]
    return max(rows, key=lambda r: r.get("updated_ms") or 0) if rows else None
