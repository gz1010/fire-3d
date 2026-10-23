"""Paths, environment, constants and SSL setup for Fire-3d.

Imported (directly or indirectly) by every backend module. At import time it:
  * loads ``<repo>/.env`` with a tiny KEY=VALUE parser (real environment variables win),
  * points SSL_CERT_FILE / REQUESTS_CA_BUNDLE / CURL_CA_BUNDLE at certifi (SPEC 1), so httpx,
    rasterio/GDAL ``/vsicurl/`` and friends verify certificates on this machine.

Secrets: the only secret is ``FIRMS_MAP_KEY``. Never print or log it; pass any text that may contain it
(URLs, exception messages) through :func:`mask_secrets` first.
"""

from __future__ import annotations

import os
import re
from pathlib import Path

import certifi

from . import __version__

VERSION = __version__

# ----------------------------------------------------------------------------------------------------------------
# Paths
# ----------------------------------------------------------------------------------------------------------------
PACKAGE_DIR = Path(__file__).resolve().parent
BACKEND_DIR = PACKAGE_DIR.parent
REPO_ROOT = BACKEND_DIR.parent
ENV_FILE = REPO_ROOT / ".env"


def parse_env_file(path: str | os.PathLike[str]) -> dict[str, str]:
    """Parse a ``.env`` file: ``KEY=VALUE`` lines, blanks and ``#`` comments ignored, optional ``export ``
    prefix, surrounding single/double quotes stripped. Missing file -> ``{}``."""
    out: dict[str, str] = {}
    p = Path(path)
    if not p.is_file():
        return out
    for raw in p.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[len("export "):].lstrip()
        key, sep, value = line.partition("=")
        key = key.strip()
        if not sep or not key or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key):
            continue
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in ("'", '"'):
            value = value[1:-1]
        elif " #" in value:  # inline comment after an unquoted value
            value = value.split(" #", 1)[0].rstrip()
        out[key] = value
    return out


def load_env_file(path: str | os.PathLike[str] = ENV_FILE) -> dict[str, str]:
    """Load ``path`` into ``os.environ`` with ``setdefault`` (real environment variables take precedence).
    Returns the parsed mapping."""
    values = parse_env_file(path)
    for k, v in values.items():
        os.environ.setdefault(k, v)
    return values


load_env_file(ENV_FILE)


def _env_flag(name: str, default: str) -> bool:
    return os.environ.get(name, default).strip().lower() in ("1", "true", "yes", "on")


def resolve_dir(value: str | None, default: Path) -> Path:
    """An env-var directory: ``~`` expanded; relative paths are taken relative to REPO_ROOT (not the CWD)."""
    if not value:
        return default.resolve()
    p = Path(value).expanduser()
    return (p if p.is_absolute() else REPO_ROOT / p).resolve()


DATA_DIR = resolve_dir(os.environ.get("FIRE3D_DATA_DIR"), REPO_ROOT / "data")
CACHE_DIR = resolve_dir(os.environ.get("FIRE3D_CACHE_DIR"), REPO_ROOT / "data" / "cache")   # shared even when DATA_DIR moves
INCIDENTS_DIR = DATA_DIR / "incidents"

# ----------------------------------------------------------------------------------------------------------------
# SSL (SPEC 1): python.org Python's urllib fails cert checks here; make every client use certifi's bundle.
# ----------------------------------------------------------------------------------------------------------------
CA_BUNDLE = certifi.where()
for _k in ("SSL_CERT_FILE", "REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE"):
    _cur = os.environ.get(_k)
    if not _cur or not Path(_cur).is_file():
        os.environ[_k] = CA_BUNDLE
# GDAL /vsicurl/ tuning for COG reads (Sentinel-2): no directory listings, a few retries, block cache.
os.environ.setdefault("GDAL_DISABLE_READDIR_ON_OPEN", "EMPTY_DIR")
os.environ.setdefault("GDAL_HTTP_MAX_RETRY", "3")
os.environ.setdefault("GDAL_HTTP_RETRY_DELAY", "2")
os.environ.setdefault("VSI_CACHE", "TRUE")
os.environ.setdefault("CPL_VSIL_CURL_ALLOWED_EXTENSIONS", ".tif,.tiff,.TIF,.TIFF,.jp2,.xml,.json")

# ----------------------------------------------------------------------------------------------------------------
# Constants (SPEC 4)
# ----------------------------------------------------------------------------------------------------------------
NEVER = 1.0e6                      # raster arrival sentinel: never burns (hours)
ACRE_M2 = 4046.8564224             # m² per acre
CHAIN_M = 20.1168                  # m per chain
MS_PER_H = 3_600_000
CA_BBOX = (-124.6, 32.4, -113.9, 42.1)   # w, s, e, n (lon/lat)
RENDER_SIZE = 1024                 # render grid width = height
WEATHER_GRID_N = 4                 # weather grid is 4 x 4

# AOI sizing (SPEC 8.1)
FIRE_GRID_TARGET_RES_M = 30.0
FIRE_GRID_MULTIPLE = 16
FIRE_GRID_MIN = 128
FIRE_GRID_MAX = 512
AOI_MARGIN_M = {"historical": 2000.0, "live": 6000.0}
AOI_MIN_EXTENT_M = {"historical": 8000.0, "live": 16000.0}
AOI_MAX_EXTENT_M = 60000.0
AOI_BBOX_SCALE = 1.3
FALLBACK_MIN_RADIUS_M = 1000.0

# HTTP client (fire3d/http.py)
USER_AGENT = "Fire-3d/0.1 (research prototype)"
HTTP_MAX_CONCURRENCY = 4
HTTP_CACHE_DIR_NAME = "http"

# ----------------------------------------------------------------------------------------------------------------
# Secrets: NASA FIRMS MAP_KEY (SPEC 1). May be None; everything must work without it.
# ----------------------------------------------------------------------------------------------------------------
FIRMS_MAP_KEY: str | None = (os.environ.get("FIRMS_MAP_KEY") or "").strip() or None
FIRMS_MAX_REQUESTS_PER_10MIN = 150          # client-side cap (the key allows 5000 transactions / 10 min)
FIRMS_API_PREFIX = "firms.modaps.eosdis.nasa.gov/api/"

_SECRET_PATTERNS = (
    # FIRMS key as a query parameter (mapkey_status etc.)
    (re.compile(r"(?i)(MAP_?KEY=)[^&\s'\"]+"), r"\1***"),
    # FIRMS key as a path segment: /api/<endpoint>/<format>/<KEY>/ or /api/data_availability/csv/<KEY>/
    (re.compile(r"(?i)(firms\.modaps\.eosdis\.nasa\.gov/api/[a-z_]+/(?:[a-z_]+/)?)[0-9a-f]{32}"), r"\1***"),
)


def mask_secrets(text: object) -> str:
    """Return ``str(text)`` with the FIRMS MAP_KEY (and anything that looks like one in a FIRMS URL) replaced
    by ``***``. Use on every URL / message that may reach a log, an exception or a file."""
    s = text if isinstance(text, str) else str(text)
    key = FIRMS_MAP_KEY
    if key:
        s = s.replace(key, "***")
    for pat, repl in _SECRET_PATTERNS:
        s = pat.sub(repl, s)
    return s


# ----------------------------------------------------------------------------------------------------------------
# Feature flags
# ----------------------------------------------------------------------------------------------------------------
LIVE_ENABLED = _env_flag("FIRE3D_LIVE", "1")                       # run the live refresh loop in the API
# Open-Meteo weighted request budget (CONTRACT 14.12.2): the free API allows < 10,000 calls a day per IP; above this
# many weighted calls today a live refresh keeps the bundle's last weather. Live weather is refetched at most hourly.
OPEN_METEO_DAILY_SOFT_CAP = 6000.0
LIVE_WEATHER_REFETCH_S = 3600.0
AUTO_BUILD_LIVE = _env_flag("FIRE3D_AUTO_BUILD_LIVE", "1")          # auto-build live incidents on startup

# ----------------------------------------------------------------------------------------------------------------
# Live fuel moisture defaults for California (SPEC 8.4), kg/kg (fractions). Configurable here.
# ----------------------------------------------------------------------------------------------------------------
LIVE_FUEL_MOISTURE_BY_MONTH: dict[int, tuple[float, float]] = {
    # month: (herbaceous, woody)
    1: (1.2, 1.2), 2: (1.2, 1.2), 3: (1.2, 1.2), 4: (1.2, 1.2),     # Jan-Apr: green-up
    5: (0.6, 1.0), 6: (0.6, 1.0),                                   # May-Jun: curing
    7: (0.3, 0.7), 8: (0.3, 0.7), 9: (0.3, 0.7), 10: (0.3, 0.7),    # Jul-Oct: peak season, cured
    11: (0.6, 0.9), 12: (0.6, 0.9),                                 # Nov-Dec
}
FOLIAR_MOISTURE = 1.0                                               # kg/kg (100 %)
# Drought adjustment (docs/validation.md): the Nov-Jun rows assume a normal rainy-season green-up. When the
# water year (from Oct 1) has brought little rain, herbs stay cured and shrubs stay at dry-season moisture, so the
# month's values are blended toward LIVE_FUEL_MOISTURE_DRY by the water-year precipitation P at the fire:
# P <= GREENUP_MIN_PRECIP_MM (a "germinating rain", ~1 inch) -> dry values, P >= GREENUP_FULL_PRECIP_MM -> the table.
LIVE_FUEL_MOISTURE_DRY: tuple[float, float] = (0.3, 0.7)            # (herbaceous, woody): the Jul-Oct row
GREENUP_MIN_PRECIP_MM = 25.0
GREENUP_FULL_PRECIP_MM = 100.0
DROUGHT_ADJUSTED_LFM = True                                         # False: the plain month table (SPEC 8.4)

# ----------------------------------------------------------------------------------------------------------------
# Calibrated forecast settings (docs/validation.md: deterministic hindcasts of the 2025 Eaton, Madre and Palisades
# fires from 8 start times, 32 scored leads; highest mean growth-only Sorensen). These are the SpreadSettings that
# forecasts (CLI, API, live loop, pipeline) and the calibration CLI use unless a caller passes its own;
# types.SpreadSettings keeps the neutral physics defaults (multiplier 1, no hold/decay/WUI).
# ----------------------------------------------------------------------------------------------------------------
FORECAST_SPREAD_ADJUSTMENT = 0.5    # spread-rate multiplier at the forecast start (best of the calibration grid)
FORECAST_ADJUSTMENT_DECAY_H = 12.0  # ... relaxing toward FORECAST_ADJUSTMENT_FLOOR x that, e-folding lead time (h)
FORECAST_ADJUSTMENT_FLOOR = 0.1
FORECAST_HOLD_INACTIVE = True       # observation-informed start: perimeter without recent activity is held
FORECAST_WUI = False                # WUI surrogate (burnable developed land near wildland): lowered skill, so off
# Live forecasts (docs/validation.md section 6). LIVE_START_LATEST_PASS: time_range.now_ms of a live bundle (the
# default forecast start, SPEC 6) is the latest observation of the fire including confirmed VIIRS/MODIS passes that
# saw no new fire (build/live_observation.py); False restores "last detection or perimeter".
LIVE_START_LATEST_PASS = True
FORECAST_HOLD_CONTAINED = True      # live: hold at least CAL FIRE's contained share of the perimeter (quietest part)
FORECAST_DECAY_FROM_LAST_ACTIVITY = True   # live: the multiplier's decay clock starts at the last sign of activity
FORECAST_ACTIVE_RADIUS_M = 1000.0   # held perimeter: cells within this distance of recent activity stay active
FORECAST_ACTIVE_EDGE_M = 0.0        # activity deeper than this inside the burned area is ignored (0 = off; tested)
FORECAST_ACTIVE_GROWTH_ONLY = True   # detections on ground burned before the window are burnout, not activity (6.6)

# =================================================================================================================
# AIRCRAFT CLASSIFICATION (SPEC 8.6)
# Owned by the api agent (used by sources/aircraft.py). Rules, in confidence order:
#   1. ICAO type designator (ICAO Doc 8643) in FIRE_AIRCRAFT_TYPES. Types that are also common outside
#      firefighting (FIRE_AIRCRAFT_TYPES_SHARED) need supporting evidence: a fleet registration / callsign match,
#      or flying low & slow over the fire.
#   2. Fleet registrations (FIRE_REGISTRATION_PATTERNS, strong), fire callsign prefixes (FIRE_CALLSIGN_PREFIXES)
#      and the firefighting squawk (FIRE_SQUAWK_CODES). FIRE_REGISTRATION_PATTERNS_WEAK (blocks that are mostly,
#      not only, fire/land-agency aircraft) also need the low & slow condition.
#   3. Proximity: inside the AOI (and near the burned area when known), AGL < AIRCRAFT_MAX_AGL_M,
#      gs < AIRCRAFT_MAX_GS_KT, not an airliner category (A3-A5) -> "other_fire", "low & slow over fire".
#   Every "low & slow" inference is vetoed by NON_FIRE_* evidence (air ambulance, police, news, airlift callsigns or
#   operators; gliders, balloons, ultralights).
# Category "other_fire" on a registration/callsign rule means "fire fleet, role unknown": sources/aircraft.py
# refines it from the type (FIRE_AIRCRAFT_TYPES) or the ADS-B emitter category (A7 rotorcraft -> helicopter).
# Sources (checked 2026-10-16): ICAO Doc 8643 type designators; FAA JO 7340 notice adding ICAO 3LD/telephony
# "CFR/CALFIRE" for CAL FIRE (2017, replacing the US special call sign "CALFR"); CAL FIRE fleet N-numbers
# (N422DF-N458DF S-2T, N451DF-N492DF S-70i, N459/461/463DF King Air, N457DF Baron, N468DF C-130H) from public
# flight-tracker fleet lists; operator fleet registrations from the FAA registry mirrors and photo captions
# (10 Tanker, Neptune, Erickson Aero Tanker, Aero-Flite, Coulson); USFS N1xxZ registrations (FAA registry,
# e.g. N148Z/N149Z/N181Z, Lead 56 = N156Z).
# Live-tracker cross-checks: airplanes.live operator page "CFR" (California Department of Forestry and Fire
# Protection, telephony CALFIRE) lists S-2 airtankers flying as CFR74 / CFR75 / CFR89 with ADS-B type S2P (the
# tracker databases encode the S-2T as S2P) and registrations N425DF / N439DF / N444DF; FlightAware photo captions
# show 10 Tanker's DC-10 N612AX (Tanker 910) flying as flight ID "TNKR910". adsb.lol /v2/point responses carry
# the ICAO type in "t", the registration in "r", the space-padded flight ID in "flight", the ADS-B emitter
# category in "category" (A1 light .. A5 heavy, A7 rotorcraft) and alt_baro = "ground" on the ground. adsb.lol
# answers HTTP 429 after a few quick requests, hence the request budget and the cooldown below.
# =================================================================================================================
FIRE_AIRCRAFT_TYPES: dict[str, str] = {               # ICAO type designator -> category
    # --- fixed-wing airtankers ---------------------------------------------------------------------------------
    "DC10": "airtanker",   # McDonnell Douglas DC-10-30 - 10 Tanker Air Carrier VLATs (Tankers 910/911/912/914)
    "MD87": "airtanker",   # McDonnell Douglas MD-87 - Erickson Aero Tanker LATs (Tankers 101-107)
    "RJ85": "airtanker",   # Avro RJ85 - Aero-Flite LATs (Tankers 160-169)
    "B461": "airtanker",   # BAe 146-100 - Neptune Aviation LATs
    "B462": "airtanker",   # BAe 146-200 - Neptune Aviation LATs (Tankers 02/10/40/41)
    "B463": "airtanker",   # BAe 146-300
    "C130": "airtanker",   # Lockheed C-130/L-100 Hercules - CAL FIRE C-130H (Tankers 116-122), Coulson C-130H/Q
    "C30J": "airtanker",   # Lockheed Martin C-130J Super Hercules (USAF MAFFS units; LM-100J)
    "CL2T": "airtanker",   # Canadair CL-215T / CL-415 / DHC-515 turbine scoopers (Bridger, Aero-Flite, LA County lease)
    "CL2P": "airtanker",   # Canadair CL-215 piston scooper
    "S2P": "airtanker",    # Grumman S-2 Tracker (piston)
    "S2T": "airtanker",    # Marsh S-2F3AT Turbo Tracker - CAL FIRE Tankers 70-100
    "AT8T": "airtanker",   # Air Tractor AT-802/802F/Fire Boss - single-engine airtankers (SEATs)
    "AT6T": "airtanker",   # Air Tractor AT-602 - SEATs
    "B733": "airtanker",   # Boeing 737-300 - Coulson 737 FireLiner (Tankers 137-139); shared with airlines
    "A319": "airtanker",   # Airbus A319 - Neptune Aviation A319 airtankers (2026); shared with airlines
    "DH8D": "airtanker",   # De Havilland Canada Dash 8-400 - Conair Q400AT/MRE airtankers; shared with airlines
    # --- air attack / lead / reconnaissance -----------------------------------------------------------------------
    "V10": "air_attack",   # North American OV-10A Bronco (ICAO designator V10; seen live as CFR110 / N410DF, 2026-10-17)
    "OV10": "air_attack",  # OV-10 as some databases encode it - CAL FIRE air attack (Air Attack 1xx/3xx/4xx)
    "AC90": "air_attack",  # (Gulfstream/Rockwell) Turbo Commander 690 - USFS/contract air attack
    "AC95": "air_attack",  # Commander 695 Jetprop 980/1000 - contract air attack
    "BE20": "lead_plane",  # Beech King Air 200/250/260 - USFS lead planes, CAL FIRE A200CT (N459DF/N461DF/N463DF)
    "BE9L": "lead_plane",  # Beech King Air 90 - USFS lead planes (legacy)
    "B350": "lead_plane",  # Beech King Air 350 - lead / aerial supervision module (ASM)
    "BE58": "air_attack",  # Beech Baron 58 - CAL FIRE (N457DF), legacy lead/air attack
    "PC12": "air_attack",  # Pilatus PC-12 - contract air attack / intel (IR mapping)
    # --- helicopters ------------------------------------------------------------------------------------------
    "S64": "helicopter",   # Sikorsky / Erickson S-64 Air-Crane (Skycrane) helitankers
    "H60": "helicopter",   # Sikorsky S-70 / UH-60 Black Hawk family - CAL FIRE S-70i Firehawk, LA County, contractors
    "S70": "helicopter",   # S-70 (Firehawk) as some databases encode it
    "H47": "helicopter",   # Boeing CH-47 Chinook - contract heavy helitankers (ICAO designator)
    "CH47": "helicopter",  # CH-47 as some databases encode it (not an official ICAO designator)
    "KMAX": "helicopter",  # Kaman K-MAX (K-1200) - external-load helitankers
    "S61": "helicopter",   # Sikorsky S-61 - Croman/Siller helitankers
    "UH1": "helicopter",   # Bell UH-1H Super Huey - CAL FIRE helitack (legacy), county fire departments
    "B205": "helicopter",  # Bell 205/UH-1H civil - CAL FIRE / Kern County Fire helitack
    "B212": "helicopter",  # Bell 212 - contract Type 2 helicopters
    "B412": "helicopter",  # Bell 412 - LA County / Orange County fire helicopters
    "H500": "helicopter",  # MD 500 - contract Type 3 / aerial ignition
    "AS50": "helicopter",  # Airbus AS350 / H125 - contract Type 3 helitack
    "B407": "helicopter",  # Bell 407 - contract Type 3 helitack
}
# Types also flown in large numbers outside firefighting (military transports, airliners, business/utility
# aircraft and helicopters): they count only with supporting evidence (fleet registration, fire callsign, or
# low & slow over the fire).
FIRE_AIRCRAFT_TYPES_SHARED: frozenset[str] = frozenset({
    "C130", "C30J", "AT8T", "AT6T", "B733", "A319", "DH8D", "AC90", "AC95", "BE20", "BE9L", "B350", "BE58", "PC12",
    "H60", "S70", "H47", "CH47", "S61", "UH1", "B205", "B212", "B412", "H500", "AS50", "B407",
})
FIRE_REGISTRATION_PATTERNS: list[tuple[str, str]] = [   # (regex on registration/operator, category)
    (r"^N4\d\dDF$", "other_fire"),                       # CAL FIRE state fleet: N4xxDF (S-2T, S-70i, OV-10A, C-130H, King Air)
    (r"^N(612|603|522)AX$|^N17085$", "airtanker"),        # 10 Tanker Air Carrier DC-10s (Tankers 910/914/912, 911)
    (r"^N47\dNA$", "airtanker"),                          # Neptune Aviation BAe 146 (N470NA T-40, N471NA T-41, N472NA T-10, N474NA T-02)
    (r"^N29\dEA$", "airtanker"),                          # Erickson Aero Tanker MD-87 (N291EA T-101, N293EA T-103)
    (r"^N355AC$", "airtanker"),                           # Aero-Flite RJ85 Tanker 162
    (r"^N140CG$|^N4053L$|^N431[23]L$", "airtanker"),      # Coulson Aviation (USA) C-130H (N140CG = Tanker 133)
    (r"(?i)\b(CAL ?FIRE|FORESTRY AND FIRE|DEPT OF FORESTRY|10 TANKER|NEPTUNE AVIATION|AERO[ -]?FLITE|ERICKSON AERO TANKER"
     r"|COULSON AVIATION|BRIDGER AIR ?TANKER|BRIDGER AEROSPACE|AERO AIR LLC|AIR SPRAY|CONAIR)\b", "other_fire"),  # operator names (registry "ownOp")
]
FIRE_REGISTRATION_PATTERNS_WEAK: list[tuple[str, str]] = [   # need low & slow over the fire as well
    (r"^N1\d\dZ$", "other_fire"),                         # US Forest Service fleet N1xxZ (lead planes, ASM, smokejumpers, IR)
    (r"^N\d{1,3}DF$", "other_fire"),                      # other "DF" (Dept. of Forestry) N-numbers outside the verified N4xxDF block
    (r"(?i)\b(FOREST SERVICE|USDA|DEPT OF THE INTERIOR|BUREAU OF LAND MANAGEMENT|COUNTY OF LOS ANGELES|FIRE (DEPT|DEPARTMENT|AUTHORITY|PROTECTION))\b", "other_fire"),
]
FIRE_CALLSIGN_PREFIXES: list[tuple[str, str]] = [       # (callsign prefix, category); must be followed by a digit or end
    ("CFR", "other_fire"),       # CAL FIRE ICAO three-letter designator (telephony CALFIRE), e.g. CFR301
    ("CALFIRE", "other_fire"),   # CAL FIRE telephony used as a flight ID
    ("CALFR", "other_fire"),     # former US special call sign of CAL FIRE (cancelled 2017)
    ("TANKER", "airtanker"),     # "Tanker 912"
    ("TNKR", "airtanker"),       # abbreviated tanker flight IDs
    ("ATTACK", "air_attack"),    # "Air Attack 340" / "Attack 340"
    ("AIRATK", "air_attack"),
    ("LEAD", "lead_plane"),      # "Lead 51" (USFS lead planes)
    ("BDOG", "lead_plane"),      # "Bird Dog" (BLM lead/aerial supervision)
    ("HELI", "helicopter"),      # "Helicopter 404" / "Heli 404"
    ("COPTER", "helicopter"),    # CAL FIRE / county "Copter 301"
    ("HELITAK", "helicopter"),
    ("FIRE", "other_fire"),      # city/county fire department aircraft, e.g. "FIRE3"
    ("JUMPER", "other_fire"),    # smokejumper aircraft "Jumper 15"
    ("MAFFS", "airtanker"),      # military C-130s with the Modular Airborne FireFighting System ("MAFFS 1")
]
# Transponder code 1255 is the US national beacon code for firefighting aircraft (FAA JO 7110.66, National Beacon
# Code Allocation Plan): strong evidence, like a fire callsign.
FIRE_SQUAWK_CODES: dict[str, str] = {"1255": "other_fire"}
# Evidence AGAINST the weak "low & slow over fire" inference: news, police and air-ambulance helicopters, airlift
# flights, gliders and balloons also fly low and slow near fires. It only vetoes the inferences that rest on
# "low & slow" (rule 3, shared types and weak registrations without other evidence); a dedicated fire type, a fleet
# registration, a fire callsign or squawk 1255 still wins.
NON_FIRE_CALLSIGN_PREFIXES: list[tuple[str, str]] = [   # (prefix + digit/end, what it is)
    ("RCH", "military airlift (USAF Air Mobility Command 'Reach')"),
    ("REACH", "air ambulance (REACH Air Medical Services)"),
    ("MERCY", "air ambulance (Mercy Air)"),
    ("CALSTAR", "air ambulance (CALSTAR)"),
    ("NEWS", "news helicopter"),
]
NON_FIRE_OPERATOR_PATTERNS: list[tuple[str, str]] = [   # (regex on the registry operator "ownOp", what it is)
    (r"(?i)\b(POLICE|SHERIFF'?S?|HIGHWAY PATROL|LAW ENFORCEMENT|BORDER PATROL|CUSTOMS)\b", "law enforcement"),
    (r"(?i)\b(AIR METHODS|AIR MEDICAL|MEDICAL|AMBULANCE|MEDEVAC|MERCY AIR|REACH AIR|CALSTAR|LIFE ?FLIGHT)\b", "air ambulance"),
    (r"(?i)\b(BROADCASTING|BROADCAST|TELEVISION|NEWS|MEDIA)\b", "news media"),
    (r"(?i)\b(FLIGHT SCHOOL|FLIGHT TRAINING|FLIGHT ACADEMY|TOURS?|SIGHTSEEING)\b", "flight training or tours"),
]
NON_FIRE_EMITTER_CATEGORIES = frozenset({"B1", "B2", "B3", "B4"})   # glider, lighter-than-air, parachutist, ultralight
AIRCRAFT_RADIUS_NM = 40.0             # adsb.lol /v2/point radius around the incident (SPEC 8.6)
AIRCRAFT_FETCH_TTL_S = 5.0            # fire3d.http cache TTL for adsb.lol responses
AIRCRAFT_RESPONSE_CACHE_S = 10.0      # API response cache per incident (SPEC 6)
AIRCRAFT_STALE_OK_S = 120.0           # serve the last good list (with a note) for this long when adsb.lol fails
AIRCRAFT_MAX_REQUESTS_PER_MIN = 10    # client-side adsb.lol budget (it answers 429 after short bursts)
AIRCRAFT_COOLDOWN_S = 30.0            # no adsb.lol requests for this long after an HTTP 429
AIRCRAFT_PROVIDER_DOWN_S = 300.0      # skip an unreachable/failing provider (adsb.lol -> adsb.fi fallback) this long
AIRCRAFT_TIMEOUT_S = 10.0             # adsb.lol request timeout (no retries: the API serves stale data instead)
AIRCRAFT_MAX_AGL_M = 1500.0           # proximity rule: below this height above ground ...
AIRCRAFT_MAX_GS_KT = 250.0            # ... and slower than this
AIRCRAFT_NEAR_FIRE_M = 5000.0         # ... and within this distance of the burned area (when known)
AIRLINER_CATEGORIES = frozenset({"A3", "A4", "A5"})   # ADS-B emitter categories: large / B757 / heavy
GEOID_UNDULATION_CA_M = -33.0         # EGM96 geoid height in California (approx.): MSL = ellipsoidal - N
# ===================================== END AIRCRAFT CLASSIFICATION ===============================================
