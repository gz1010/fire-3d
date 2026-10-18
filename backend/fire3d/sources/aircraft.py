"""Live firefighting aircraft from adsb.lol (SPEC 2, 6, 8.6). Owner: api agent.

* :func:`fetch_aircraft` / :func:`fetch_point` - raw adsb.lol ``/v2/point`` aircraft dicts through
  :mod:`fire3d.http` (5 s cache TTL), guarded by a client-side request budget and a cooldown after HTTP 429
  (adsb.lol rate-limits short bursts). When adsb.lol fails, the adsb.fi open-data API (same readsb aircraft fields)
  is tried; a provider that is unreachable is skipped for ``AIRCRAFT_PROVIDER_DOWN_S``. :func:`last_source` names
  the provider of the latest successful fetch. Failures raise :class:`AircraftUnavailable` (secret-free message).
* :func:`classify` - ``(category, is_fire_aircraft, reason)`` per SPEC 8.6 with the tables in the config section
  "AIRCRAFT CLASSIFICATION": known fire types, fleet registrations / callsigns, then "low & slow over fire".
* :class:`AircraftContext` - the incident frame: local x/z, MSL altitude, AGL from the DEM inside the AOI, distance
  to the burned area. :func:`to_aircraft` / :func:`aircraft_list` turn adsb.lol dicts into contract ``Aircraft``.

Altitude (``alt_m``, metres above mean sea level): ``alt_geom`` (GNSS height above the WGS84 ellipsoid) when
present, converted with the California geoid undulation; else ``alt_baro`` (pressure altitude) corrected with the
aircraft's ``nav_qnh`` when it reports one. ``alt_baro == "ground"`` means on the ground.
"""

from __future__ import annotations

import functools
import logging
import math
import re
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable, Mapping

import numpy as np

from .. import config, http
from ..contracts import Aircraft
from ..grid import Grid, make_aoi

log = logging.getLogger(__name__)

SOURCE = "adsb.lol"
POINT_URL = "https://api.adsb.lol/v2/point/{lat:.4f}/{lon:.4f}/{radius:d}"
FALLBACK_SOURCE = "adsb.fi"      # opendata.adsb.fi: free non-commercial use, about 1 request/s
FALLBACK_URL = "https://opendata.adsb.fi/api/v2/lat/{lat:.4f}/lon/{lon:.4f}/dist/{radius:d}"
MAX_RADIUS_NM = 250
FT_M = 0.3048
QNH_M_PER_HPA = 8.43            # height change per hPa of pressure near sea level (~27.7 ft/hPa)
STANDARD_QNH_HPA = 1013.25

CATEGORY_ORDER = ("airtanker", "helicopter", "air_attack", "lead_plane", "other_fire", "unknown")
CATEGORY_LABEL = {
    "airtanker": "airtanker", "helicopter": "helicopter", "air_attack": "air attack", "lead_plane": "lead plane",
    "other_fire": "fire aircraft", "unknown": "unknown",
}
_REG_LIKE = re.compile(r"^(N[0-9][0-9A-Z]{0,4}|C-?[FGI][A-Z]{3})$")   # US / Canadian registrations used as flight IDs


class AircraftUnavailable(RuntimeError):
    """adsb.lol cannot be queried right now (rate limit, cooldown, HTTP or network error); message is secret-free."""


# ----------------------------------------------------------------------------------------------------------------
# Fetching
# ----------------------------------------------------------------------------------------------------------------
@dataclass
class _Provider:
    name: str
    url: str
    list_key: str                 # "ac" (adsb.lol) or "aircraft" (adsb.fi)
    now_scale: float              # multiplier turning the response's "now" into epoch ms
    budget: Any = None
    cooldown_until: float = 0.0   # time.monotonic() before which the provider is skipped
    cooldown_why: str = ""


def _new_providers() -> list[_Provider]:
    n = int(config.AIRCRAFT_MAX_REQUESTS_PER_MIN)
    return [
        _Provider(SOURCE, POINT_URL, "ac", 1.0, http.RateLimiter(n, 60.0, name="adsb.lol budget")),
        _Provider(FALLBACK_SOURCE, FALLBACK_URL, "aircraft", 1000.0, http.RateLimiter(n, 60.0, name="adsb.fi budget")),
    ]


_state_lock = threading.Lock()
_providers = _new_providers()
_last_fetch: dict[str, float] = {}
_last_source = SOURCE


def point_url(lat: float, lon: float, radius_nm: float = config.AIRCRAFT_RADIUS_NM, template: str = POINT_URL) -> str:
    """The adsb.lol ``/v2/point/{lat}/{lon}/{radius}`` URL (radius rounded to whole nm, 1..250); ``template``
    selects another provider's URL pattern."""
    radius = int(min(max(round(float(radius_nm)), 1), MAX_RADIUS_NM))
    return template.format(lat=float(lat), lon=float(lon), radius=radius)


def reset_limits() -> None:
    """Forget the cooldowns, budgets and fetch history (tests)."""
    global _providers, _last_source
    with _state_lock:
        _last_fetch.clear()
        _providers = _new_providers()
        _last_source = SOURCE


def last_source() -> str:
    """Provider ("adsb.lol" or "adsb.fi") of the most recent successful :func:`fetch_point`."""
    return _last_source


def _fetch_from(pv: _Provider, lat: float, lon: float, radius_nm: float) -> tuple[list[dict], int | None]:
    url = point_url(lat, lon, radius_nm, pv.url)
    now = time.monotonic()
    with _state_lock:
        if now < pv.cooldown_until:
            raise AircraftUnavailable(f"{pv.name} {pv.cooldown_why}: backing off for {pv.cooldown_until - now:.0f} s")
        cache_fresh = now - _last_fetch.get(url, -1e18) < config.AIRCRAFT_FETCH_TTL_S
    if not cache_fresh and not pv.budget.try_acquire():
        raise AircraftUnavailable(f"{pv.name} request budget ({pv.budget.max_calls}/min) used up; try again shortly")
    try:
        data = http.get_json(url, ttl_s=config.AIRCRAFT_FETCH_TTL_S, timeout=config.AIRCRAFT_TIMEOUT_S, retries=0)
    except http.HttpError as e:
        if e.status == 429:
            with _state_lock:
                pv.cooldown_until, pv.cooldown_why = time.monotonic() + config.AIRCRAFT_COOLDOWN_S, "rate limit"
            raise AircraftUnavailable(f"{pv.name} rate limit (HTTP 429); pausing requests for {config.AIRCRAFT_COOLDOWN_S:.0f} s") from None
        if e.status is None or e.status >= 500:      # unreachable or failing: skip it for a while
            with _state_lock:
                pv.cooldown_until, pv.cooldown_why = time.monotonic() + config.AIRCRAFT_PROVIDER_DOWN_S, "unreachable"
        what = f"HTTP {e.status}" if e.status is not None else e.message
        raise AircraftUnavailable(config.mask_secrets(f"{pv.name} request failed ({what})")) from None
    except ValueError:  # orjson.JSONDecodeError
        raise AircraftUnavailable(f"{pv.name} returned invalid JSON") from None
    except Exception as e:  # noqa: BLE001 - any other transport failure: treat the provider as down, never a 500
        with _state_lock:
            pv.cooldown_until, pv.cooldown_why = time.monotonic() + config.AIRCRAFT_PROVIDER_DOWN_S, "unreachable"
        raise AircraftUnavailable(config.mask_secrets(f"{pv.name} request failed ({type(e).__name__})")) from None
    with _state_lock:
        _last_fetch[url] = time.monotonic()
    if not isinstance(data, dict) or not isinstance(data.get(pv.list_key) or [], list):
        raise AircraftUnavailable(f"unexpected {pv.name} response")
    t = data.get("now")
    now_ms = int(float(t) * pv.now_scale) if isinstance(t, (int, float)) and not isinstance(t, bool) and t > 0 else None
    return [a for a in (data.get(pv.list_key) or []) if isinstance(a, dict)], now_ms


def fetch_point(lat: float, lon: float, radius_nm: float = config.AIRCRAFT_RADIUS_NM) -> tuple[list[dict], int | None]:
    """``(aircraft dicts, provider 'now' in epoch ms or None)`` within ``radius_nm`` of (lat, lon): adsb.lol
    ``/v2/point``, else the adsb.fi fallback (:func:`last_source` says which answered)."""
    global _last_source
    errors: list[str] = []
    for pv in list(_providers):
        try:
            out = _fetch_from(pv, lat, lon, radius_nm)
        except AircraftUnavailable as e:
            errors.append(str(e))
            continue
        _last_source = pv.name
        return out
    raise AircraftUnavailable("; ".join(errors))


def fetch_aircraft(lat: float, lon: float, radius_nm: float = config.AIRCRAFT_RADIUS_NM) -> list[dict]:
    """Raw adsb.lol aircraft dicts within ``radius_nm`` of (lat, lon) (``/v2/point``; SPEC 7.3)."""
    return fetch_point(lat, lon, radius_nm)[0]


# ----------------------------------------------------------------------------------------------------------------
# Field parsing
# ----------------------------------------------------------------------------------------------------------------
def _num(v: Any) -> float | None:
    """A finite float, or None (bools, strings like "ground", NaN)."""
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        return None
    f = float(v)
    return f if math.isfinite(f) else None


def _text(v: Any) -> str:
    return str(v).strip() if v is not None else ""


def is_on_ground(ac: Mapping[str, Any]) -> bool:
    """adsb.lol reports ``alt_baro: "ground"`` for aircraft on the ground."""
    ab = ac.get("alt_baro")
    return isinstance(ab, str) and ab.strip().lower() == "ground"


def position(ac: Mapping[str, Any]) -> tuple[float, float, float | None] | None:
    """``(lat, lon, position age s)`` from ``lat``/``lon``, else ``lastPosition``; None without a position."""
    lat, lon = _num(ac.get("lat")), _num(ac.get("lon"))
    age = _num(ac.get("seen_pos"))
    if lat is None or lon is None:
        lp = ac.get("lastPosition")
        if not isinstance(lp, Mapping):
            return None
        lat, lon, age = _num(lp.get("lat")), _num(lp.get("lon")), _num(lp.get("seen_pos"))
        if lat is None or lon is None:
            return None
    if not (-90.0 <= lat <= 90.0 and -180.0 <= lon <= 180.0):
        return None
    return lat, lon, age


def altitude_msl_m(ac: Mapping[str, Any]) -> float | None:
    """Altitude above mean sea level in metres (see module docstring); None when unknown or on the ground."""
    if is_on_ground(ac):
        return None
    geom = _num(ac.get("alt_geom"))
    if geom is not None:
        return geom * FT_M - config.GEOID_UNDULATION_CA_M          # MSL = ellipsoidal height - geoid undulation
    baro = _num(ac.get("alt_baro"))
    if baro is None:
        return None
    alt = baro * FT_M
    qnh = _num(ac.get("nav_qnh"))
    if qnh is not None and 940.0 <= qnh <= 1070.0:
        alt += (qnh - STANDARD_QNH_HPA) * QNH_M_PER_HPA
    return alt


def track_deg(ac: Mapping[str, Any]) -> float | None:
    """Ground track, else true heading, else magnetic heading (degrees clockwise from north)."""
    for key in ("track", "true_heading", "mag_heading"):
        v = _num(ac.get(key))
        if v is not None:
            return v % 360.0
    return None


# ----------------------------------------------------------------------------------------------------------------
# Incident frame: grid, DEM, burned area
# ----------------------------------------------------------------------------------------------------------------
def _sample(arr: np.ndarray, extent_m: float, x: float, z: float) -> float | None:
    """Bilinear sample of a north-up raster covering the AOI square at local (x, z) (pixel-centre convention)."""
    h, w = arr.shape
    half = extent_m / 2.0
    r = (z + half) / extent_m * h - 0.5
    c = (x + half) / extent_m * w - 0.5
    r = min(max(r, 0.0), h - 1.0)
    c = min(max(c, 0.0), w - 1.0)
    r0, c0 = int(math.floor(r)), int(math.floor(c))
    r1, c1 = min(r0 + 1, h - 1), min(c0 + 1, w - 1)
    fr, fc = r - r0, c - c0
    v = (arr[r0, c0] * (1 - fr) * (1 - fc) + arr[r0, c1] * (1 - fr) * fc + arr[r1, c0] * fr * (1 - fc) + arr[r1, c1] * fr * fc)
    v = float(v)
    return v if math.isfinite(v) else None


@dataclass
class AircraftContext:
    """Everything the proximity rule and the local coordinates need for one incident.

    ``grid`` defines the local frame and the AOI square; ``dem`` (render grid, m) gives AGL inside the AOI;
    ``fire_dist_m`` (fire grid) is the distance to the nearest burned pixel; ``ground_m`` is a fallback ground
    elevation used when there is no DEM.
    """

    grid: Grid
    dem: np.ndarray | None = None
    fire_dist_m: np.ndarray | None = None
    ground_m: float | None = None

    @classmethod
    def around(cls, lon: float, lat: float, acres: float | None = None) -> "AircraftContext":
        """A context without a bundle: the live AOI (SPEC 8.1 fallback circle) around the incident point."""
        render, _ = make_aoi(lon, lat, None, "live", acres=acres)
        return cls(grid=render)

    @classmethod
    def from_bundle(cls, bdir: str | Path, manifest: dict) -> "AircraftContext":
        """Context from a built bundle: render grid + elevation + distance to the observed burned area."""
        from scipy.ndimage import distance_transform_edt

        from .. import bundle
        from ..grid import grids_from_manifest

        render, fire = grids_from_manifest(manifest)
        dem = dist = None
        layers = manifest.get("layers") or {}
        try:
            if "elevation" in layers:
                dem = bundle.read_layer(bdir, "elevation", manifest).astype(np.float32)
        except (OSError, ValueError, KeyError) as e:
            log.warning("aircraft context: cannot read elevation for %s: %s", manifest.get("id"), e)
        try:
            if "observed_arrival" in layers:
                arr = bundle.read_layer(bdir, "observed_arrival", manifest)
                burned = np.asarray(arr) < config.NEVER * 0.5
                if burned.any():
                    dist = (distance_transform_edt(~burned) * fire.res_m).astype(np.float32)
        except (OSError, ValueError, KeyError) as e:
            log.warning("aircraft context: cannot read observed_arrival for %s: %s", manifest.get("id"), e)
        ground = float(np.nanmedian(dem)) if dem is not None and dem.size else None
        return cls(grid=render, dem=dem, fire_dist_m=dist, ground_m=ground)

    def center_lonlat(self) -> tuple[float, float]:
        """(lon, lat) of the AOI centre (the point to query adsb.lol around)."""
        lon, lat = self.grid.local_to_lonlat(0.0, 0.0)
        return float(lon), float(lat)

    def geometry(self, ac: Mapping[str, Any]) -> dict | None:
        """Per-aircraft geometry for :func:`classify` / :func:`to_aircraft`; None without a position."""
        pos = position(ac)
        if pos is None:
            return None
        lat, lon, age = pos
        x, z = self.grid.lonlat_to_local(lon, lat)
        inside = bool(self.grid.contains_local(x, z))
        on_ground = is_on_ground(ac)
        ground = None
        if inside and self.dem is not None:
            ground = _sample(self.dem, self.grid.extent_m, x, z)
        alt = altitude_msl_m(ac)
        if on_ground:
            alt, agl = ground, 0.0
        else:
            agl = alt - ground if (alt is not None and ground is not None) else None
        near = None
        if inside and self.fire_dist_m is not None:
            d = _sample(self.fire_dist_m, self.grid.extent_m, x, z)
            near = d is not None and d <= config.AIRCRAFT_NEAR_FIRE_M
        return {
            "lat": lat, "lon": lon, "x": x, "z": z, "inside_aoi": inside, "on_ground": on_ground,
            "alt_m": alt, "agl_m": agl, "ground_m": ground if ground is not None else self.ground_m,
            "near_fire": near, "seen_pos": age,
        }


# ----------------------------------------------------------------------------------------------------------------
# Classification (SPEC 8.6)
# ----------------------------------------------------------------------------------------------------------------
@functools.lru_cache(maxsize=256)
def _rx(pattern: str) -> re.Pattern[str]:
    return re.compile(pattern)


def _match_patterns(patterns: Iterable[tuple[str, str]], values: Iterable[tuple[str, str]]) -> tuple[str, str, str] | None:
    """First (category, matched value, what) for regex ``patterns`` over labelled ``values``."""
    vals = [(what, v) for what, v in values if v]
    for pat, cat in patterns:
        rx = _rx(pat)
        for what, v in vals:
            if rx.search(v):
                return cat, v, what
    return None


def _match_callsign(callsign: str) -> tuple[str, str] | None:
    """(category, prefix) when the callsign starts with a fire prefix followed by a digit, space, '-' or the end."""
    cs = callsign.upper()
    for prefix, cat in config.FIRE_CALLSIGN_PREFIXES:
        p = prefix.upper()
        if cs.startswith(p):
            rest = cs[len(p):]
            if not rest or rest[0].isdigit() or rest[0] in " -":
                return cat, prefix
    return None


def non_fire_evidence(callsign: str, operator: str, emitter: str) -> str | None:
    """Why an aircraft is known NOT to be a fire aircraft (air ambulance / police / news callsign or operator,
    glider/balloon/ultralight emitter category), or None. Vetoes only the "low & slow" inferences."""
    cs = callsign.upper()
    for prefix, what in config.NON_FIRE_CALLSIGN_PREFIXES:
        p = prefix.upper()
        if cs.startswith(p) and (len(cs) == len(p) or cs[len(p)].isdigit() or cs[len(p)] in " -"):
            return f"callsign {cs} is {what}"
    if operator:
        for pat, what in config.NON_FIRE_OPERATOR_PATTERNS:
            if _rx(pat).search(operator):
                return f"operator {operator} is {what}"
    if emitter in config.NON_FIRE_EMITTER_CATEGORIES:
        return f"emitter category {emitter} (glider, balloon, parachutist or ultralight)"
    return None


def low_and_slow(ac: Mapping[str, Any], geo: Mapping[str, Any] | None) -> tuple[bool, str]:
    """SPEC 8.6 rule 3: inside the AOI (and near the burned area when known), AGL < 1500 m, gs < 250 kt, airborne,
    not an airliner (A3-A5) or surface vehicle (C*). Returns (ok, short explanation)."""
    if is_on_ground(ac) or (geo or {}).get("on_ground"):
        return False, "on the ground"
    emitter = _text(ac.get("category")).upper()
    if emitter in config.AIRLINER_CATEGORIES:
        return False, f"airliner category {emitter}"
    if emitter.startswith("C"):
        return False, f"surface vehicle or obstacle ({emitter})"
    if not geo:
        return False, "no position relative to the fire"
    if not geo.get("inside_aoi"):
        return False, "outside the AOI"
    if geo.get("near_fire") is False:
        return False, f"more than {config.AIRCRAFT_NEAR_FIRE_M / 1000:g} km from the burned area"
    height = geo.get("agl_m")
    if height is None:
        alt, ground = geo.get("alt_m"), geo.get("ground_m")
        if alt is None:
            return False, "altitude unknown"
        height = alt - ground if ground is not None else alt    # without terrain, MSL bounds AGL from above
    if height >= config.AIRCRAFT_MAX_AGL_M:
        return False, f"too high ({height:,.0f} m AGL)"
    gs = _num(ac.get("gs"))
    if gs is None:
        return False, "ground speed unknown"
    if gs >= config.AIRCRAFT_MAX_GS_KT:
        return False, f"too fast ({gs:.0f} kt)"
    return True, f"{max(height, 0.0):,.0f} m AGL, {gs:.0f} kt"


def classify(ac: Mapping[str, Any], context: Any = None) -> tuple[str, bool, str]:
    """``(category, is_fire_aircraft, reason)`` for an adsb.lol aircraft dict (SPEC 8.6).

    ``context`` is an :class:`AircraftContext`, a geometry dict from :meth:`AircraftContext.geometry` (keys
    ``inside_aoi``, ``agl_m``, ``alt_m``, ``ground_m``, ``near_fire``, ``on_ground``), or None (no proximity rule).
    """
    geo = context.geometry(ac) if isinstance(context, AircraftContext) else (dict(context) if context else None)
    t = _text(ac.get("t")).upper()
    reg = _text(ac.get("r")).upper()
    cs = _text(ac.get("flight")).upper()
    owner = _text(ac.get("ownOp"))
    emitter = _text(ac.get("category")).upper()
    low, low_why = low_and_slow(ac, geo)
    squawk = _text(ac.get("squawk"))
    sq_cat = config.FIRE_SQUAWK_CODES.get(squawk) if squawk else None
    veto = non_fire_evidence(cs, owner, emitter)

    t_cat = config.FIRE_AIRCRAFT_TYPES.get(t) if t else None
    shared = t in config.FIRE_AIRCRAFT_TYPES_SHARED
    ids = [("registration", reg), ("flight ID", cs if _REG_LIKE.match(cs) else ""), ("operator", owner)]
    reg_m = _match_patterns(config.FIRE_REGISTRATION_PATTERNS, ids)
    weak_m = _match_patterns(config.FIRE_REGISTRATION_PATTERNS_WEAK, ids)
    cs_m = _match_callsign(cs) if cs else None

    def refine(cat: str) -> str:
        if cat == "other_fire":
            if t_cat:
                return t_cat
            if emitter == "A7":
                return "helicopter"
        return cat

    def fleet(m: tuple[str, str, str]) -> str:
        return f"fleet {m[2]} {m[1]}" if m[2] != "operator" else f"fleet operator {m[1]}"

    # 1. known firefighting types
    if t_cat and not shared:
        return t_cat, True, f"type {t} ({CATEGORY_LABEL[t_cat]})"
    if t_cat:
        if reg_m:
            return t_cat, True, f"type {t} ({CATEGORY_LABEL[t_cat]}) + {fleet(reg_m)}"
        if cs_m:
            cat = cs_m[0] if cs_m[0] != "other_fire" else t_cat
            return cat, True, f"type {t} + fire callsign {cs}"
        if sq_cat:
            return t_cat, True, f"type {t} ({CATEGORY_LABEL[t_cat]}) + firefighting squawk {squawk}"
        if low and not veto:
            return t_cat, True, f"type {t} ({CATEGORY_LABEL[t_cat]}), low & slow over fire ({low_why})"
    # 2. fleet registrations / operators, fire callsigns, the firefighting squawk
    if reg_m:
        cat = refine(reg_m[0])
        return cat, True, f"{fleet(reg_m)} ({CATEGORY_LABEL[cat]})"
    if cs_m:
        cat = refine(cs_m[0])
        return cat, True, f"fire callsign {cs} (prefix {cs_m[1]})"
    if sq_cat:
        cat = refine(sq_cat)
        return cat, True, f"squawk {squawk} (US firefighting beacon code)"
    if weak_m and low and not veto:
        cat = refine(weak_m[0])
        return cat, True, f"{fleet(weak_m)}, low & slow over fire ({low_why})"
    # 3. proximity, unless something says otherwise
    if low and veto:
        return "unknown", False, f"low & slow over fire, but {veto}"
    if low:
        return "other_fire", True, f"low & slow over fire ({low_why})"
    return "unknown", False, f"not identified as fire aircraft: {low_why}"


# ----------------------------------------------------------------------------------------------------------------
# Contract objects
# ----------------------------------------------------------------------------------------------------------------
def to_aircraft(ac: Mapping[str, Any], ctx: AircraftContext) -> Aircraft | None:
    """Contract :class:`Aircraft` for one adsb.lol dict (None without a hex id or a position)."""
    hex_id = _text(ac.get("hex")).lower()
    geo = ctx.geometry(ac)
    if not hex_id or geo is None:
        return None
    category, is_fire, reason = classify(ac, geo)
    seen = geo.get("seen_pos")
    if seen is None:
        seen = _num(ac.get("seen"))
    gs = _num(ac.get("gs"))
    trk = track_deg(ac)
    return Aircraft(
        hex=hex_id,
        callsign=_text(ac.get("flight")) or None,
        registration=_text(ac.get("r")) or None,
        type=_text(ac.get("t")).upper() or None,
        category=category,
        is_fire_aircraft=is_fire,
        reason=reason,
        lat=round(float(geo["lat"]), 6),
        lon=round(float(geo["lon"]), 6),
        x=round(float(geo["x"]), 1),
        z=round(float(geo["z"]), 1),
        alt_m=None if geo["alt_m"] is None else round(float(geo["alt_m"]), 1),
        agl_m=None if geo["agl_m"] is None else round(float(geo["agl_m"]), 1),
        gs_kt=None if gs is None else round(gs, 1),
        track_deg=None if trk is None else round(trk, 1),
        seen_s=round(max(float(seen or 0.0), 0.0), 1),
        on_ground=bool(geo["on_ground"]),
    )


def aircraft_list(raw: Iterable[Mapping[str, Any]], ctx: AircraftContext, include_all: bool = False) -> list[Aircraft]:
    """Classified aircraft (fire aircraft only unless ``include_all``), fire aircraft first, by category/callsign."""
    out: list[Aircraft] = []
    seen_hex: set[str] = set()
    for ac in raw:
        try:
            a = to_aircraft(ac, ctx)
        except (TypeError, ValueError) as e:      # one malformed record must not drop the whole list
            log.debug("skipping malformed adsb.lol record: %s", e)
            continue
        if a is None or a.hex in seen_hex or (not include_all and not a.is_fire_aircraft):
            continue
        seen_hex.add(a.hex)
        out.append(a)
    out.sort(key=lambda a: (not a.is_fire_aircraft, CATEGORY_ORDER.index(a.category), a.callsign or a.registration or a.hex))
    return out
