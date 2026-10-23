"""Official evacuation zone sources by state (CONTRACT §14.8; audit docs/redesign/audit-3/evacuations.md).

Brief 3 decision 4: free, official, public, machine-readable state evacuation feeds where they exist; everywhere else
"not available in this state", never an all-clear. After the research of 2026-10-22 and the user's round-3 answers,
only two states have one:

* California: Cal OES "California Evacuation Aggregation Layer" (county GIS and Genasys Protect, rebuilt about every
  5 minutes; data.ca.gov "No restrictions on public use").
* Oregon: Oregon Department of Emergency Management "Evacuation Areas Public" (item
  dd2bee51e3004dc4b1004df34fbd9e29; licence field "Public", no further terms published, checked 2026-10-22 and again
  2026-10-23). Zones are entered by local, tribal and state GIS staff; OEM gives a level number (1-3), no issue time.

Every other lower-48 state (and DC) is ``not_available``, Washington and Florida included (BRIEF-3 round 3 item 1:
Washington's terms require users to indemnify the State; declined). There is no Washington adapter, flag or
certificate.

This module holds the registry (``STATE_AVAILABILITY``, ``ADAPTERS``), each source's field whitelist and mapping, the
status-key rule and the border dedup rule. ``fire3d.api.extras`` keeps the route, the fetching (its caches and request
limits) and the envelope. Nothing here makes a request.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable, Literal

from .. import http as fhttp
from .. import regions

AUDITED = "2026-10-22"

# Cal OES and Oregon OEM are both ArcGIS Online hosted layers on services.arcgis.com: one request limit for the host.
ARCGIS_LIMITER = fhttp.RateLimiter(60, 60.0, "extras: ArcGIS Online (Cal OES, Oregon OEM)")

CALOES_ROOT = "https://services.arcgis.com/BLN4oKB0N1YSgvY8/arcgis/rest/services"
CALOES_LAYER_URL = f"{CALOES_ROOT}/CA_EVACUATIONS_CalOESHosted_view/FeatureServer/0"
CALOES_INVENTORY_URL = f"{CALOES_ROOT}/County_Evacuation_Inventory_Public/FeatureServer/0"
CALOES_DATA_URL = "https://gis.data.ca.gov/datasets/CalEMA::california-evacuation-aggregation-layer"
CALOES_DISCLAIMER = ("This information is constantly changing, and Cal OES does not verify or certify the information "
                     "contained herein.")

OR_OEM_LAYER_URL = ("https://services.arcgis.com/uUvqNMGPm7axC2dD/arcgis/rest/services/Fire_Evacuation_Areas_Public/"
                    "FeatureServer/0")
OR_OEM_ITEM_URL = "https://www.arcgis.com/home/item.html?id=dd2bee51e3004dc4b1004df34fbd9e29"
# OEM press release of 2024-05-28 with the meaning of each level (quoted in OEM_LEVELS).
OR_OEM_LEVELS_URL = "https://www.oregon.gov/oem/Documents/NR-052424-2024_Evacuation_Preparedness_Release_EN.pdf"
OR_OEM_LEVELS: dict[int, tuple[str, str]] = {      # level -> (status key, OEM's definition)
    1: ("advisory", "Level 1: BE READY to evacuate"),
    2: ("warning", "Level 2: BE SET to evacuate"),
    3: ("order", "Level 3: GO NOW – Leave Immediately!"),
}

EVAC_TTL_S = 120.0                    # both layers update every 5-15 min

SOURCES: dict[str, dict[str, Any]] = {
    "caloes_evacuations": {
        "id": "caloes_evacuations",
        "name": "California Evacuation Aggregation Layer",
        "publisher": "California Governor's Office of Emergency Services (Cal OES)",
        "url": CALOES_DATA_URL,
        "service_url": CALOES_LAYER_URL,
        "license": "Public use (data.ca.gov: \"No restrictions on public use\")",
        "terms_url": "https://data.ca.gov/dataset/california-evacuation-aggregation-layer",
        "attribution": "Evacuation zones: local officials via county GIS and Genasys Protect, aggregated by Cal OES",
        "disclaimer": CALOES_DISCLAIMER,
        "cadence": "Rebuilt by Cal OES about every 5 minutes; current status only",
    },
    "caloes_evacuation_inventory": {
        "id": "caloes_evacuation_inventory",
        "name": "County Evacuation Inventory",
        "publisher": "Cal OES",
        "url": "https://www.arcgis.com/home/item.html?id=c685585b99da416fa6ab70027597ad47",
        "service_url": CALOES_INVENTORY_URL,
        "license": "Public use",
        "terms_url": "https://www.arcgis.com/home/item.html?id=c685585b99da416fa6ab70027597ad47",
        "attribution": "County coverage: Cal OES County Evacuation Inventory",
        "disclaimer": None,
        "cadence": "Updated by Cal OES as counties join",
    },
    "or_oem_evacuations": {
        "id": "or_oem_evacuations",
        "name": "Evacuation Areas Public (Oregon)",
        "publisher": "Oregon Department of Emergency Management (OEM)",
        "url": OR_OEM_ITEM_URL,
        "service_url": OR_OEM_LAYER_URL,
        "license": "Licence field \"Public\"; no further terms published (checked 2026-10-22)",
        "terms_url": OR_OEM_ITEM_URL,
        "attribution": "Evacuation zones: local, tribal and state officials, via the Oregon Department of Emergency "
                       "Management",
        "disclaimer": None,
        "cadence": "County and Genasys integrations every 5-15 minutes; OEM recalculates the layer every 15 minutes; "
                   "current status only",
    },
}

# Credit lines (CONTRACT §14.13) and the short aggregator names used in sentences.
CREDITS = {"caloes_evacuations": "Cal OES", "caloes_evacuation_inventory": "Cal OES",
           "or_oem_evacuations": "Oregon Department of Emergency Management"}

NOT_SUPPORTED = regions.NOT_SUPPORTED_NOTE
OUTSIDE_US = regions.OUTSIDE_US_NOTE


# ------------------------------------------------------------------------------------------------------------------
# Status wording -> styling key (the wording itself is always shown as the source gives it)
# ------------------------------------------------------------------------------------------------------------------
STATUS_RANK = {"order": 0, "shelter": 1, "warning": 2, "advisory": 3, "lifted": 4, "other": 5, "training": 6,
               "normal": 7, "unknown": 8}


def _norm(status: Any) -> str:
    return " ".join(str(status or "").lower().replace("_", " ").replace("-", " ").split())


def is_negation(status: Any) -> bool:
    """"No Evacuation Order", "Not Reporting", "None": wording that says there is no order (EV-R6)."""
    s = _norm(status)
    return s == "none" or s.startswith("no ") or s.startswith("not ") or s in ("no", "not")


def evac_status_key(status: str | None) -> str:
    """Styling class for an official status string (the string itself is always shown verbatim).

    EV-R6: a negation ("No Evacuation Order", "Not Reporting") never maps to order, warning or advisory."""
    s = _norm(status)
    if not s:
        return "unknown"
    if is_negation(s):
        return "other"
    if "lift" in s or "repopulat" in s:
        return "lifted"
    if "shelter" in s:
        return "shelter"
    if "order" in s or "level 3" in s or "go now" in s:
        return "order"
    if "warning" in s or "level 2" in s or "be set" in s:
        return "warning"
    if "advisory" in s or "level 1" in s or "be ready" in s:
        return "advisory"
    if "training" in s:
        return "training"
    if s == "normal":
        return "normal"
    return "other"


def is_placeholder_status(status: Any) -> bool:
    """Rows that say nothing is in force ("No Evacuation Order", "Not Reporting"): dropped by every adapter."""
    return is_negation(status)


# ------------------------------------------------------------------------------------------------------------------
# Field helpers
# ------------------------------------------------------------------------------------------------------------------
def _clean(v: Any) -> str | None:
    if v is None:
        return None
    s = str(v).strip()
    return s or None


def _int_ms(v: Any) -> int | None:
    try:
        x = int(v)
    except (TypeError, ValueError):
        return None
    return x if x > 0 else None


def _title(s: str | None) -> str | None:
    if not s:
        return None
    return " ".join(w[:1].upper() + w[1:].lower() for w in s.split())


def _county_name(c: str | None) -> str | None:
    """"Jackson" -> "Jackson County"; names that already say County are kept."""
    t = _clean(c)
    if not t:
        return None
    return t if "county" in t.lower() else f"{t} County"


def _polygonal(f: dict) -> dict | None:
    geom = f.get("geometry")
    if not isinstance(geom, dict) or geom.get("type") not in ("Polygon", "MultiPolygon"):
        return None
    return geom


def _representative_point(geom: dict) -> tuple[float, float] | None:
    """A point inside (or on) the polygon, for the state of a zone without a county."""
    try:
        from shapely.geometry import shape

        p = shape(geom).representative_point()
        return float(p.x), float(p.y)
    except Exception:  # noqa: BLE001 - a broken ring only loses the state
        return None


# ------------------------------------------------------------------------------------------------------------------
# Cal OES (California)
# ------------------------------------------------------------------------------------------------------------------
CALOES_FIELDS = ("OBJECTID", "STATUS", "ZONE_ID", "ZONE_NAME", "COUNTY", "CITY", "EVENT_TYPE", "NOTES",
                 "CRITICAL_INFO", "PUBLIC_INFO", "EDIT_DATE", "EditDate")


def normalize_caloes(f: dict) -> dict | None:
    """One Cal OES zone -> a small GeoJSON feature (official wording verbatim). The brief-2 props keep their values;
    the §14.8.2 props are added."""
    geom = _polygonal(f)
    if geom is None:
        return None
    p = f.get("properties") or {}
    status = _clean(p.get("STATUS"))
    if is_placeholder_status(status):
        return None
    zone_id = _clean(p.get("ZONE_ID")) or f"objectid-{p.get('OBJECTID')}"
    county = _clean(p.get("COUNTY"))
    county_t = _title(county)
    issuer_ms = _int_ms(p.get("EDIT_DATE"))
    listed_ms = _int_ms(p.get("EditDate"))
    return {
        "type": "Feature",
        "id": zone_id,
        "geometry": geom,
        "properties": {
            "zone_id": zone_id,
            "zone_name": _clean(p.get("ZONE_NAME")),
            "status": status,
            "status_key": evac_status_key(status),
            "county": county,
            "jurisdiction": f"{county_t} County" if county_t and "county" not in county_t.lower() else county_t,
            "city_code": _clean(p.get("CITY")),
            "event_type": _clean(p.get("EVENT_TYPE")),
            "notes": _clean(p.get("NOTES")),
            "critical_info": _clean(p.get("CRITICAL_INFO")),
            "public_info": _clean(p.get("PUBLIC_INFO")),
            "status_updated_ms": issuer_ms,
            "aggregated_ms": listed_ms,
            # §14.8.2 additions
            "state": "CA",
            "source_id": "caloes_evacuations",
            "status_verbatim": True,
            "status_raw": status,
            "status_label": None,
            "status_label_source": None,
            "incident_name": None,
            "hazard_type": _clean(p.get("EVENT_TYPE")),
            "listed_ms": listed_ms,
            "time_basis": "issuer" if issuer_ms is not None else ("state_layer_edit" if listed_ms is not None else "none"),
        },
    }


def caloes_status_key(props: dict) -> str:
    return evac_status_key(props.get("status"))


def caloes_zone_state(props: dict) -> str | None:
    return "CA"        # the statewide layer lists California counties only


# ------------------------------------------------------------------------------------------------------------------
# Oregon OEM
# ------------------------------------------------------------------------------------------------------------------
# Explicit whitelist (EV-R4): never Editor_Name, Editor_Email, Editor_Phone, created_user or last_edited_user.
OR_OEM_FIELDS = ("OBJECTID", "GlobalID", "Fire_Name", "Fire_Evacuation_Level", "County", "Evac_Area_Name",
                 "HazardType", "created_date", "last_edited_date")
# OEM's County domain includes one California county (EV §2.1).
OR_OEM_FOREIGN_COUNTIES = {"del norte": "CA"}


def oregon_level(v: Any) -> int | None:
    try:
        lv = int(v)
    except (TypeError, ValueError):
        return None
    return lv if lv in OR_OEM_LEVELS else None


def normalize_oregon(f: dict) -> dict | None:
    """One Oregon OEM zone -> the same feature shape as Cal OES (CONTRACT §14.8.4). The status "Level N" is Fire-3d's
    rendering of OEM's level number (``status_verbatim: false``), with OEM's own definition as ``status_label``. A row
    without a level 1-3 is dropped (EV-R6). OEM gives no issue time: ``status_updated_ms`` is null and ``listed_ms`` is
    when the zone was added to the state layer (``created_date``); ``last_edited_date`` is OEM's 15-minute
    recalculation and is never shown as an issue time."""
    geom = _polygonal(f)
    if geom is None:
        return None
    p = f.get("properties") or {}
    level = oregon_level(p.get("Fire_Evacuation_Level"))
    if level is None:
        return None
    key, label = OR_OEM_LEVELS[level]
    zone_id = _clean(p.get("GlobalID")) or f"or-objectid-{p.get('OBJECTID')}"
    county = _county_name(p.get("County"))
    listed_ms = _int_ms(p.get("created_date"))
    props = {
        "zone_id": zone_id,
        "zone_name": _clean(p.get("Evac_Area_Name")),
        "status": f"Level {level}",
        "status_key": key,
        "county": county,
        "jurisdiction": county,
        "city_code": None,
        "event_type": None,
        "notes": None,
        "critical_info": None,
        "public_info": None,
        "status_updated_ms": None,
        "aggregated_ms": None,
        "state": None,
        "source_id": "or_oem_evacuations",
        "status_verbatim": False,
        "status_raw": level,
        "status_label": label,
        "status_label_source": OR_OEM_LEVELS_URL,
        "incident_name": _clean(p.get("Fire_Name")),
        "hazard_type": _clean(p.get("HazardType")),
        "listed_ms": listed_ms,
        "time_basis": "state_layer_added" if listed_ms is not None else "none",
    }
    feat = {"type": "Feature", "id": zone_id, "geometry": geom, "properties": props}
    props["state"] = oregon_zone_state(props, geom)
    return feat


def oregon_status_key(props: dict) -> str:
    lv = oregon_level(props.get("status_raw"))
    return OR_OEM_LEVELS[lv][0] if lv is not None else "unknown"


def oregon_zone_state(props: dict, geom: dict | None = None) -> str | None:
    """Oregon, except OEM's "Del Norte" (California); a zone without a county takes the state at its geometry."""
    c = _clean(props.get("county"))
    if c:
        base = c.lower().removesuffix(" county").strip()
        return OR_OEM_FOREIGN_COUNTIES.get(base, "OR")
    if geom is not None:
        pt = _representative_point(geom)
        if pt is not None:
            st = regions.state_at(pt[0], pt[1])
            if st:
                return st
    return "OR"


# ------------------------------------------------------------------------------------------------------------------
# Adapters and the state registry
# ------------------------------------------------------------------------------------------------------------------
@dataclass(frozen=True)
class EvacAdapter:
    id: str                       # 'caloes_evacuations' | 'or_oem_evacuations'
    home_state: str               # 'CA' | 'OR'
    availability: Literal["available"]
    query_url: str
    out_fields: tuple[str, ...]   # explicit whitelist, never '*'
    where: str
    ttl_s: float                  # 120 for both
    limiter: fhttp.RateLimiter    # services.arcgis.com shared by CA and OR
    confirm_drop: bool            # CA only (the 5-minute rebuild)
    source: dict                  # SOURCES entry + 'credit'
    issuing_authority: str
    aggregator: str               # 'Cal OES' | 'Oregon OEM'
    standing_caveats: tuple[str, ...]
    normalize: Callable[[dict], dict | None]   # -> EvacZoneProps feature or None (drop)
    status_key: Callable[[dict], str]
    zone_state: Callable[[dict], str | None]

    @property
    def upstream_name(self) -> str:
        """Used in user-facing error texts ("Cal OES ArcGIS services could not be reached (HTTP 503)")."""
        return f"{self.aggregator} ArcGIS services"

    @property
    def layer_what(self) -> str:
        return f"{self.aggregator} evacuation layer"

    @property
    def none_caveat(self) -> str:
        """The per-source "not an all-clear" line when the source lists no zone in the area. Never the source's own
        "no records means no evacuations" sentence (Oregon's item says that; it is not repeated)."""
        if self.id == "caloes_evacuations":
            return "No orders or warnings are listed here right now. That is not an all-clear: follow local officials."
        return self.none_caveat_named

    @property
    def none_caveat_named(self) -> str:
        """The same line naming its source ("Cal OES lists no evacuation zone here right now. …"), for an answer that
        covers several states, so each "none" says whose it is (review round 1, R6)."""
        return (f"{self.aggregator} lists no evacuation zone here right now. That is not an all-clear: follow local "
                "officials.")


CALOES_ISSUING = ("Local emergency officials (county sheriff or emergency services, cities); each zone names its county. "
                  "Cal OES aggregates and does not verify.")
OR_OEM_ISSUING = ("Local, tribal and state emergency officials in Oregon (their GIS staff enter each zone); each zone names "
                  "its county. Oregon OEM aggregates.")

ADAPTERS: dict[str, EvacAdapter] = {
    "caloes_evacuations": EvacAdapter(
        id="caloes_evacuations",
        home_state="CA",
        availability="available",
        query_url=CALOES_LAYER_URL,
        out_fields=CALOES_FIELDS,
        where="1=1",
        ttl_s=EVAC_TTL_S,
        limiter=ARCGIS_LIMITER,
        confirm_drop=True,
        source={**SOURCES["caloes_evacuations"], "credit": CREDITS["caloes_evacuations"]},
        issuing_authority=CALOES_ISSUING,
        aggregator="Cal OES",
        standing_caveats=("Shown as current status. During Cal OES's 5-minute rebuild the layer can briefly miss zones.",),
        normalize=normalize_caloes,
        status_key=caloes_status_key,
        zone_state=caloes_zone_state,
    ),
    "or_oem_evacuations": EvacAdapter(
        id="or_oem_evacuations",
        home_state="OR",
        availability="available",
        query_url=OR_OEM_LAYER_URL,
        out_fields=OR_OEM_FIELDS,
        where="1=1",
        ttl_s=EVAC_TTL_S,
        limiter=ARCGIS_LIMITER,
        confirm_drop=False,
        source={**SOURCES["or_oem_evacuations"], "credit": CREDITS["or_oem_evacuations"]},
        issuing_authority=OR_OEM_ISSUING,
        aggregator="Oregon OEM",
        standing_caveats=(
            "Shown as current status. Oregon OEM gives no issue time for a zone; the time shown is when the zone was "
            "added to the Oregon state layer.",
            "Oregon levels are shown by Fire-3d as \"Level 1-3\" from OEM's level number, with OEM's definitions "
            "(Level 1: BE READY, Level 2: BE SET, Level 3: GO NOW).",
        ),
        normalize=normalize_oregon,
        status_key=oregon_status_key,
        zone_state=lambda props: oregon_zone_state(props),
    ),
}

_NOTES: dict[str, str] = {
    "AZ": "Arizona's statewide zones are planning zones whose status was not kept up to date in 2026; not shown.",
    "FL": "Florida's state emergency layer lists county-level status only; not shown.",
    "WA": "Washington's state evacuation layer is not used: its terms require users to indemnify the State.",
}
_LINKS: dict[str, list[dict[str, str]]] = {
    "CA": [{"label": "Cal OES evacuation layer", "url": CALOES_DATA_URL}],
    "OR": [{"label": "Oregon OEM evacuation areas", "url": OR_OEM_ITEM_URL}],
}
_STATE_ADAPTERS: dict[str, list[str]] = {}
for _a in ADAPTERS.values():
    _STATE_ADAPTERS.setdefault(_a.home_state, []).append(_a.id)

STATE_AVAILABILITY: dict[str, dict] = {
    st: {
        "state": st,
        "name": regions.STATE_NAMES[st],
        "availability": "available" if _STATE_ADAPTERS.get(st) else "not_available",
        "adapter_ids": list(_STATE_ADAPTERS.get(st, [])),
        "note": _NOTES.get(st),
        "audited": AUDITED,
        "links": list(_LINKS.get(st, [])),
    }
    for st in regions.L48
}


def state_name(st: str) -> str:
    return regions.STATE_NAMES.get(st, st)


def not_available_reason(states: list[str]) -> str:
    """CONTRACT §14.14: "Official evacuation zones are not available in this state ({State}). Follow local officials."""
    names = [state_name(s) for s in states]
    if len(names) == 1:
        return f"Official evacuation zones are not available in this state ({names[0]}). Follow local officials."
    return (f"Official evacuation zones are not available in these states ({', '.join(names)}). "
            "Follow local officials.")


def uncovered_state_caveat(st: str) -> str:
    """Mixed answers: "Nevada: official evacuation zones are not available in this state"."""
    return f"{state_name(st)}: official evacuation zones are not available in this state"


def outside_reason(lon: float, lat: float) -> str:
    """A bbox that touches no lower-48 state: Alaska / Hawaii / territories, or outside the United States."""
    return OUTSIDE_US if regions.coverage_at(lon, lat) == "outside_us" else NOT_SUPPORTED


def states_entries(states: list[str], checked: dict[str, bool]) -> list[dict]:
    """The response's ``states[]`` (CONTRACT §14.8.2): every state the bbox touches."""
    out = []
    for st in states:
        reg = STATE_AVAILABILITY.get(st)
        if reg is None:
            continue
        out.append({"state": st, "name": reg["name"], "availability": reg["availability"],
                    "checked": bool(checked.get(st, False)), "source_ids": list(reg["adapter_ids"]),
                    "note": reg["note"], "links": [dict(x) for x in reg["links"]]})
    return out


def dedup_border_zones(per_source: list[tuple[EvacAdapter, list[dict]]], answered: set[str]) -> list[dict]:
    """One copy per zone at state borders: a zone whose state (``props.state``) is another source's home state is
    dropped when that state's own source answered for this area (its copy wins); kept otherwise, with its own source."""
    home_of = {a.home_state: a.id for a, _ in per_source}
    out: list[dict] = []
    for ad, feats in per_source:
        for z in feats:
            st = z["properties"].get("state")
            owner = home_of.get(st) if st else None
            if owner and owner != ad.id and owner in answered:
                continue
            out.append(z)
    return out
