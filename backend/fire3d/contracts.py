"""Pydantic v2 mirrors of the JSON contracts (SPEC 5.1 bundle files and SPEC 6 HTTP API).

Field names, Literal values and optionality match the TypeScript shapes exactly
(``web/src/api/types.ts`` mirrors the same shapes):

  * ``x: T | null`` in TS  -> required field typed ``T | None`` (always serialized, possibly as ``null``).
  * ``x?: T`` in TS        -> ``T | None = None`` that is **omitted** from dumps when ``None``.

Models allow unknown fields (lossless round trips); :func:`contract_problems` / :func:`validate_strict` flag them
plus any type error, so producers can check their output exactly. Dump with :func:`dump` (JSON-safe dict).
"""

from __future__ import annotations

from typing import Any, Iterator, Literal, TypeVar

import orjson
from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator

# ----------------------------------------------------------------------------------------------------------------
# Literal types
# ----------------------------------------------------------------------------------------------------------------
Mode = Literal["live", "historical"]
BundleStatus = Literal["none", "building", "ready", "error"]
ManifestStatus = Literal["building", "ready", "error"]
RunStatus = Literal["running", "ready", "error"]
EnsembleKind = Literal["gfs025", "ecmwf_ifs025", "perturbed", "none"]
EnsembleRequest = Literal["auto", "gfs025", "ecmwf_ifs025", "perturbed", "none"]
LayerGrid = Literal["render", "fire", "image", "points"]
LayerDtype = Literal["float32", "uint8", "uint16", "int16", "jpeg"]
Instrument = Literal["VIIRS", "MODIS", "GOES", "LANDSAT"]
DayNight = Literal["D", "N"]
EventType = Literal[
    "ignition", "rapid_growth", "spot_fire", "ridge_crossing", "containment", "peak_wind", "wind_shift", "perimeter_update"
]
EventConfidence = Literal["observed", "estimated", "probable"]
JobKind = Literal["build", "forecast", "refresh"]
JobState = Literal["queued", "running", "done", "error"]
AircraftCategory = Literal["airtanker", "helicopter", "air_attack", "lead_plane", "other_fire", "unknown"]

SCHEMA_VERSION = 1


def _is_none(v: Any) -> bool:
    return v is None


def Optional_(**kw: Any) -> Any:
    """A TS ``x?: T`` field: defaults to None and is left out of dumps when None."""
    return Field(default=None, exclude_if=_is_none, **kw)


class ContractModel(BaseModel):
    """Base for all contract models: unknown keys are kept (and reported by :func:`contract_problems`)."""

    model_config = ConfigDict(extra="allow", populate_by_name=True)


# ----------------------------------------------------------------------------------------------------------------
# SPEC 5.1 - bundle
# ----------------------------------------------------------------------------------------------------------------
# Brief 3 (CONTRACT 14.1): whose record a list row is, and the ten accuracy regions (14.4).
RecordSource = Literal["calfire", "wfigs"]
AccuracyRegionId = Literal["NWCC", "NRCC", "GBCC", "SWCC", "SACC-SP", "SACC-SE", "RMCC", "EACC", "ONCC", "OSCC"]


class OtherRecord(ContractModel):
    """Another agency's record of the same fire (California rows matched to WFIGS records; CONTRACT 14.1)."""

    source: RecordSource
    id: str                             # CAL FIRE UniqueId or IRWIN id
    name: str                           # that record's name, verbatim (a complex member's own name)
    issuer: str                         # same rule as record_issuer
    agency: str | None                  # plain protecting-agency name, null if unknown
    agency_code: str | None             # verbatim code ("USFS"), null for CAL FIRE
    acres: float | None
    percent_contained: float | None
    is_active: bool                     # that agency's own active status
    updated_ms: int | None              # that record's own update time
    url: str | None                     # that record's human-readable page (https)


def _fill_summary_defaults(s: IncidentSummary) -> None:
    """CONTRACT 14.1 defaults for old manifests and fixtures (CAL FIRE rows without the brief-3 fields): ``uid <-
    calfire_uid``, ``record_source "calfire"``, ``record_issuer "CAL FIRE"``, ``agency "CAL FIRE"``, ``source_name <-
    name``, ``active_sources ["calfire"] if is_active else []``, and ``state`` / ``time_zone`` from the location
    (``regions.state_at`` / ``regions.time_zone_at``; fallback the state's main zone, then "UTC"; never
    America/Los_Angeles by default). Only fields the input did not give are filled (``model_fields_set``). A NIFC
    WFIGS summary without an issuer gets the 14.2 issuer text from its ``agency_code`` ("USFS via NIFC WFIGS", else
    "NIFC WFIGS (IRWIN)"), never "CAL FIRE".

    Runs after validation (not as a before-validator), so strict JSON checks keep their JSON semantics."""
    given = s.model_fields_set
    put = lambda k, v: object.__setattr__(s, k, v)  # no validate_assignment on contract models
    if "record_source" not in given or s.record_source is None:
        put("record_source", "calfire")
    cal = s.record_source == "calfire"
    if "uid" not in given:
        put("uid", s.calfire_uid)
    if "record_issuer" not in given or s.record_issuer is None:
        # CONTRACT 14.2 issuer rule (catalog.record_issuer): never CAL FIRE for a NIFC WFIGS record
        code = (s.agency_code or "").strip()
        put("record_issuer", "CAL FIRE" if cal else (f"{code} via NIFC WFIGS" if code else "NIFC WFIGS (IRWIN)"))
    if "agency" not in given and cal:
        put("agency", "CAL FIRE")
    if "source_name" not in given:
        put("source_name", s.name)
    if "active_sources" not in given and cal:
        put("active_sources", ["calfire"] if s.is_active else [])
    if "state" not in given or "time_zone" not in given:
        _fill_place(s, given, put)


def _fill_place(s: IncidentSummary, given: set[str], put: Any) -> None:
    """``state`` / ``time_zone`` of a summary from its location (``fire3d.regions``, offline). Without the regions
    module (before us-catalog M2) both stay unset, so readers show the viewer's zone, labelled (never Pacific)."""
    try:
        from . import regions
    except ImportError:
        return
    lon, lat = float(s.lon), float(s.lat)
    if "state" not in given:
        put("state", regions.state_at(lon, lat))
    if "time_zone" not in given:
        tz = regions.time_zone_at(lon, lat)
        if tz is None and s.state:
            tz = regions.main_zone(s.state)
        put("time_zone", tz or "UTC")


class IncidentSummary(ContractModel):
    id: str
    name: str
    mode: Mode
    year: int
    calfire_uid: str                    # DEPRECATED (brief 3): the CAL FIRE UniqueId, or "" when not CAL FIRE's record
    started_ms: int
    updated_ms: int | None
    contained_ms: int | None
    acres: float | None
    percent_contained: float | None
    is_active: bool
    county: str | None
    location: str | None
    admin_unit: str | None
    url: str | None
    lat: float
    lon: float
    detections_24h: int | None          # live only
    bundle_status: BundleStatus
    bundle_built_ms: int | None
    # Brief 3 additions (CONTRACT 14.1). The five (R) fields are required in web/src/api/types.ts since the
    # integration; here they keep a default because old manifests and fixtures lack them, and the after-validator
    # (_fill_summary_defaults) fills them on read, so every dump and every response carries them (never omitted).
    uid: str | None = None                              # (R) CAL FIRE UniqueId, or IRWIN id (upper case, no braces)
    record_source: RecordSource | None = None           # (R) whose record this row is; absent on read = "calfire"
    record_issuer: str | None = None                    # (R) "CAL FIRE" | "USFS via NIFC WFIGS" | "NIFC WFIGS (IRWIN)"
    state: str | None = None                            # (R) USPS code of the point of origin (48 + "DC"); null off-US
    time_zone: str | None = None                        # (R) IANA zone of the reported location, never assumed
    agency: str | None = None                           # protecting agency, plain name; "CAL FIRE" for CAL FIRE rows
    agency_code: str | None = None                      # protecting-agency code, verbatim ("USFS", "C&L")
    irwin_id: str | None = None                         # WFIGS rows; CAL FIRE rows matched to ONE WFIGS fire
    unique_fire_id: str | None = None                   # NWCG UniqueFireIdentifier, e.g. "2026-TXTXS-000006"
    source_name: str | None = Optional_()               # the record's name verbatim
    gacc: str | None = None                             # WFIGS GACC code verbatim
    accuracy_region: AccuracyRegionId | None = None     # null: "Accuracy not yet tested here" (14.4)
    active_sources: list[RecordSource] = Field(default_factory=list)   # which records call the fire active
    other_records: list[OtherRecord] = Field(default_factory=list)     # California rows matched to WFIGS records
    complex_name: str | None = None                     # a member fire outside California: "Part of the X Complex"
    complex_members: list[str] = Field(default_factory=list)          # a CAL FIRE complex row: WFIGS member names
    aliases: list[str] = Field(default_factory=list)    # other ids that resolve to this row (14.2 "Id pinning")

    @model_validator(mode="after")
    def _brief3_defaults(self) -> IncidentSummary:
        _fill_summary_defaults(self)
        return self


class LayerInfo(ContractModel):
    file: str                           # path relative to the bundle dir
    grid: LayerGrid
    dtype: LayerDtype
    width: int | None = Optional_()
    height: int | None = Optional_()
    count: int | None = Optional_()     # points layers
    units: str | None = Optional_()
    nodata: float | None = Optional_()
    min: float | None = Optional_()
    max: float | None = Optional_()
    description: str


class ForecastSummary(ContractModel):
    run_id: str
    status: RunStatus
    issued_ms: int
    start_ms: int
    horizon_h: int
    ensemble: EnsembleKind
    members: int
    file: str                           # "forecasts/{run_id}/forecast.json"


class TimeRange(ContractModel):
    start_ms: int
    end_ms: int
    # live: latest observation of the fire = the newest of its detections / mapped perimeters and the confirmed
    # satellite passes over it that saw no new fire (SPEC 8.3); historical: end_ms
    now_ms: int
    last_detection_ms: int | None = Optional_()   # live: newest detection or mapped perimeter (burned area known to here)
    last_pass_ms: int | None = Optional_()        # live: newest confirmed VIIRS/MODIS pass over the fire (any outcome)


class GridSize(ContractModel):
    width: int
    height: int
    res_m: float


class ManifestGrid(ContractModel):
    crs: str
    utm_zone: int
    center_e: float
    center_n: float
    extent_m: float
    bbox_lonlat: tuple[float, float, float, float]   # w, s, e, n
    render: GridSize
    fire: GridSize
    elev_min_m: float
    elev_max_m: float


class Ignition(ContractModel):
    x: float
    z: float
    lat: float
    lon: float
    t_ms: int
    source: str


class DataSource(ContractModel):
    name: str
    detail: str
    fetched_ms: int


class ManifestStats(ContractModel):
    final_acres_observed: float
    detections: int
    perimeters: int


class IncidentManifest(ContractModel):
    schema_version: Literal[1]
    id: str
    name: str
    mode: Mode
    status: ManifestStatus
    summary: IncidentSummary
    time_origin_ms: int
    time_range: TimeRange
    grid: ManifestGrid
    layers: dict[str, LayerInfo]        # elevation fuel canopy_cover canopy_height burn_severity? observed_arrival naip sky_view water? trees
    ignition: Ignition | None
    default_profile_path: list[tuple[float, float]]   # local [x, z] polyline
    fuels_edition: str
    data_sources: list[DataSource]
    stats: ManifestStats
    forecasts: list[ForecastSummary]    # newest first
    warnings: list[str]
    built_ms: int                       # also the cache-buster (?v=built_ms)


class Detection(ContractModel):
    t_ms: int
    lat: float
    lon: float
    x: float
    z: float
    frp: float | None
    satellite: str
    instrument: Instrument
    confidence: str
    daynight: DayNight
    footprint_m: float


class DetectionsFile(ContractModel):
    detections: list[Detection]


class Perimeter(ContractModel):
    t_ms: int
    acres: float
    source: str
    rings: list[list[tuple[float, float]]]   # local x, z; <= 1500 vertices per perimeter; cumulative


class PerimetersFile(ContractModel):
    perimeters: list[Perimeter]


class TimeseriesFile(ContractModel):
    step_h: Literal[1]
    t_ms: list[int]                     # hourly, time_range.start_ms .. now_ms
    area_acres: list[float]
    growth_acres_per_h: list[float]
    ros_ch_per_h: list[float]
    detections_per_h: list[int]
    frp_mw_per_h: list[float] | None = Optional_()

    @model_validator(mode="after")
    def _lengths(self) -> "TimeseriesFile":
        n = len(self.t_ms)
        for name in ("area_acres", "growth_acres_per_h", "ros_ch_per_h", "detections_per_h", "frp_mw_per_h"):
            v = getattr(self, name)
            if v is not None and len(v) != n:
                raise ValueError(f"{name} has {len(v)} values, t_ms has {n}")
        return self


class Event(ContractModel):
    id: str
    type: EventType
    t_ms: int
    title: str
    detail: str
    x: float | None = Optional_()
    z: float | None = Optional_()
    confidence: EventConfidence
    source: str


class EventsFile(ContractModel):
    events: list[Event]


class AtFire(ContractModel):
    temp_c: list[float]
    rh_pct: list[float]
    dewpoint_c: list[float]
    wind_speed_ms: list[float]
    wind_dir_deg: list[float]           # FROM direction, degrees clockwise from north
    wind_gust_ms: list[float]
    precip_mm: list[float]
    fm1_pct: list[float]
    fm10_pct: list[float]
    fm100_pct: list[float]
    ffwi: list[float]                   # Fosberg Fire Weather Index
    flame_length_ft: list[float] | None = Optional_()          # added by spread/behavior.py
    ros_ch_per_h_potential: list[float] | None = Optional_()   # added by spread/behavior.py


class WeatherGrid(ContractModel):
    """4 x 4 weather grid. ``x``: the 4 column-centre x (west->east); ``z``: the 4 row-centre z (north->south);
    ``u_ms``/``v_ms`` flattened ``[t][j][i]`` (j row north->south, i column west->east), u east+, v north+."""

    nx: Literal[4]
    ny: Literal[4]
    x: list[float]
    z: list[float]
    u_ms: list[float]
    v_ms: list[float]


class WeatherFile(ContractModel):
    source: str                         # e.g. "open-meteo:gfs_hrrr"
    t_ms: list[int]                     # hourly
    at_fire: AtFire
    grid: WeatherGrid
    forecast_from_ms: int | None        # first hour that is forecast rather than (re)analysis

    @model_validator(mode="after")
    def _lengths(self) -> "WeatherFile":
        n = len(self.t_ms)
        for name in AtFire.model_fields:
            v = getattr(self.at_fire, name)
            if v is not None and len(v) != n:
                raise ValueError(f"at_fire.{name} has {len(v)} values, t_ms has {n}")
        g = self.grid
        if len(g.x) != g.nx or len(g.z) != g.ny:
            raise ValueError("grid.x / grid.z must have nx / ny entries")
        cells = g.nx * g.ny
        if len(g.u_ms) != n * cells or len(g.v_ms) != n * cells:
            raise ValueError(f"grid.u_ms / v_ms must have len(t_ms) * {cells} = {n * cells} values")
        return self


class ForecastModelInfo(ContractModel):
    engine: Literal["pyretechnics"]
    version: str
    surface_lw_ratio_model: str
    crown: bool
    spotting: bool
    spread_adjustment: float
    grid_res_m: float


class ForecastWeather(ContractModel):
    source: str
    ensemble: EnsembleKind
    members: int


class ForecastLayers(ContractModel):
    arrival_p10: LayerInfo
    arrival_p50: LayerInfo
    arrival_p90: LayerInfo
    burn_probability: LayerInfo
    flame_length_p50: LayerInfo


class ForecastSeries(ContractModel):
    t_ms: list[int]
    area_acres_p10: list[float]
    area_acres_p50: list[float]
    area_acres_p90: list[float]
    ros_ch_per_h_p50: list[float]

    @model_validator(mode="after")
    def _lengths(self) -> "ForecastSeries":
        n = len(self.t_ms)
        for name in ("area_acres_p10", "area_acres_p50", "area_acres_p90", "ros_ch_per_h_p50"):
            if len(getattr(self, name)) != n:
                raise ValueError(f"series.{name} length differs from t_ms")
        return self


class SkillEntry(ContractModel):
    lead_h: float
    sorensen: float
    observed_acres: float
    forecast_acres_p50: float
    growth_sorensen: float | None = Optional_()   # (R) brief 3 (CONTRACT 14.12.7): Sørensen of the new growth only


class ForecastManifest(ContractModel):
    run_id: str
    incident_id: str
    status: RunStatus
    error: str | None = Optional_()
    issued_ms: int
    start_ms: int
    horizon_h: int
    time_origin_ms: int
    model: ForecastModelInfo
    weather: ForecastWeather
    layers: ForecastLayers
    series: ForecastSeries
    skill: list[SkillEntry] | None = Optional_()   # historical runs only
    runtime_s: float
    warnings: list[str]


# ----------------------------------------------------------------------------------------------------------------
# SPEC 6 - HTTP API
# ----------------------------------------------------------------------------------------------------------------
class JobStatus(ContractModel):
    id: str
    kind: JobKind
    incident_id: str
    status: JobState
    progress: float                     # 0..1
    step: str
    message: str
    created_ms: int
    started_ms: int | None
    finished_ms: int | None
    error: str | None
    result: Any = None


class Aircraft(ContractModel):
    hex: str
    callsign: str | None
    registration: str | None
    type: str | None
    category: AircraftCategory
    is_fire_aircraft: bool
    reason: str
    lat: float
    lon: float
    x: float
    z: float
    alt_m: float | None
    agl_m: float | None
    gs_kt: float | None
    track_deg: float | None
    seen_s: float
    on_ground: bool


class HealthResponse(ContractModel):
    ok: bool
    version: str


class IncidentListRow(IncidentSummary):
    """A row of ``GET /api/incidents`` (BRIEF-2 O-R8): the summary plus the analysis area of a ready bundle."""

    bbox_lonlat: tuple[float, float, float, float] | None    # w, s, e, n of manifest.grid; null unless ready


class ListSource(ContractModel):
    """One source list behind ``GET /api/incidents`` (CONTRACT 14.1)."""

    id: RecordSource
    name: str                           # "CAL FIRE" | "NIFC WFIGS (IRWIN)"
    status: Literal["available", "unavailable"]
    retrieved_ms: int | None            # when Fire-3d fetched that list (never an issue time)
    reason: str | None                  # plain words when unavailable, or when stale
    stale: bool = False                 # CONTRACT 14.16: the list could not be refreshed; an older copy is shown


class IncidentListResponse(ContractModel):
    mode: Mode
    updated_ms: int
    incidents: list[IncidentListRow]
    year: int | None = Optional_()      # historical lists: the year listed
    sources: list[ListSource]           # brief 3 (14.1): which source lists answered; required since the integration


class IncidentDetailResponse(ContractModel):
    summary: IncidentSummary
    manifest: IncidentManifest | None
    job: JobStatus | None


class ForecastRequest(ContractModel):
    start_ms: int | None = None
    horizon_h: int = 72
    ensemble: EnsembleRequest = "auto"
    members: int | None = None


class AircraftResponse(ContractModel):
    updated_ms: int
    source: str                         # "adsb.lol", or "adsb.fi" (fallback while adsb.lol is unreachable)
    radius_nm: float
    aircraft: list[Aircraft]
    note: str | None = Optional_()      # e.g. why the list is empty (historical incident)


class LiveStatus(ContractModel):
    last_refresh_ms: int | None
    next_refresh_ms: int | None
    active_incidents: int | None        # null: unknown (the fire lists could not be reached; CONTRACT 14.16)
    detections_24h_ca: int | None       # kept for one release (brief 3)
    auto_build: bool
    detections_24h: int | None          # brief 3 (14.1): FIRMS feed rows of the last 24 h in the lower-48 states


# ----------------------------------------------------------------------------------------------------------------
# Brief 3 (CONTRACT 14.3, 14.4): point lookup and accuracy regions
# ----------------------------------------------------------------------------------------------------------------
Coverage = Literal["lower48", "alaska", "hawaii", "territory", "outside_us"]
AccuracyStatus = Literal["tested", "limited", "untested"]


class GeoCounty(ContractModel):
    fips: str
    name: str


class GeoLookup(ContractModel):
    """``GET /api/geo/lookup?lon=&lat=`` (CONTRACT 14.3)."""

    lon: float
    lat: float
    coverage: Coverage
    supported: bool                     # coverage == "lower48"
    state: str | None                   # USPS (lower 48 + DC only)
    state_name: str | None
    county: GeoCounty | None
    time_zone: str | None               # IANA; null when not supported
    time_zone_name: str | None          # "Mountain Time"
    note: str | None                    # the 14.14 coverage sentence when not supported, else null


class AccuracyFire(ContractModel):
    id: str
    name: str
    state: str
    n_leads: int
    growth_sorensen: float
    fuels_edition: str
    lfm_method: str
    era5_hours: float
    gfs_fill_hours: float | None = Optional_()   # hours where HRRR was missing and GFS filled it
    weather_source: str | None = Optional_()     # the bundle's verbatim weather source
    replaced: str | None = Optional_()           # the V 3 fire this one replaced and the failed check, else null
    growth_ratio_median: float | None = Optional_()   # this fire's median forecast / observed growth ratio


class AccuracyRegion(ContractModel):
    id: AccuracyRegionId
    name: str
    status: AccuracyStatus
    in_sample: bool | None = Optional_()
    seed: bool | None = Optional_()
    n_fires: int
    n_leads: int | None = Optional_()
    growth_sorensen: float | None = Optional_()  # mean over fires of each fire's mean growth Sørensen
    range: tuple[float, float] | None = Optional_()
    pooled_leads: float | None = Optional_()
    ignition_relative: float | None = Optional_()
    by_lead: dict[str, float] | None = Optional_()   # keys "12", "24", "48", "72"
    growth_ratio_median: float | None = Optional_()
    years: list[int] | None = Optional_()
    lfm_method: str | None = Optional_()
    fuels_editions: list[str] | None = Optional_()
    fuel_groups_tested: list[str] | None = Optional_()
    caveats: list[str] | None = Optional_()
    fires: list[AccuracyFire] | None = Optional_()


class AccuracyModelInfo(ContractModel):
    engine: str
    settings: str


class AccuracyMethod(ContractModel):
    metric: Literal["growth_sorensen"]
    forecast: str
    leads_h: list[float]
    aggregate: Literal["mean_of_fire_means"]
    min_fires: int
    min_leads: int
    weather: str
    starts: str
    secondary: str


class AccuracyAssignment(ContractModel):
    by: str
    split: dict[str, list[str]]
    fallback: str


class AccuracyRegionsResponse(ContractModel):
    """``GET /api/accuracy-regions``: ``regional_accuracy.json`` plus ``served_ms`` (CONTRACT 14.4)."""

    schema_version: Literal[1]
    generated_ms: int
    served_ms: int
    model: AccuracyModelInfo
    method: AccuracyMethod
    assignment: AccuracyAssignment
    regions: list[AccuracyRegion]       # all ten ids, always


# ----------------------------------------------------------------------------------------------------------------
# BRIEF-2 official endpoints (api/official.py; docs/redesign/CONTRACT.md section 13, official-backend)
# ----------------------------------------------------------------------------------------------------------------
OfficialStatus = Literal["available", "unavailable", "not_available_for_past_dates"]
OfficialKind = Literal["calfire", "fire_weather", "incident_record", "local_alerts"]       # brief 3 widened (14.5)
OfficialReasonCode = Literal["past_date", "upstream_error", "not_covered", "state_not_available"]   # brief 3 widened
AlertPhase = Literal["upcoming", "in_effect", "ended"]


class OfficialSource(ContractModel):
    name: str
    url: str
    credit: str
    license: str | None = Optional_()
    terms_url: str | None = Optional_()


class OfficialEnvelope(ContractModel):
    """The extras-style envelope shared by the official endpoints."""

    kind: OfficialKind
    status: OfficialStatus
    reason_code: OfficialReasonCode | None
    reason: str | None
    source: OfficialSource
    retrieved_ms: int | None            # when Fire-3d fetched it from the source
    source_updated_ms: int | None       # the source's own update time
    requested_at_ms: int | None
    now_ms: int
    incident_id: str | None
    caveats: list[str]


class CalFireCurrent(ContractModel):
    acres: float | None
    percent_contained: float | None
    is_active: bool
    final: bool
    updated_ms: int | None              # CAL FIRE's own "Updated"
    extinguished_ms: int | None         # CAL FIRE's "ExtinguishedDate"


class CalFireChange(ContractModel):
    updated_ms: int | None              # CAL FIRE's "Updated" of the new record
    seen_ms: int                        # when Fire-3d first saw it
    acres: tuple[float | None, float | None] | None = Optional_()                  # [old, new]
    percent_contained: tuple[float | None, float | None] | None = Optional_()
    is_active: tuple[bool, bool] | None = Optional_()
    final: tuple[bool, bool] | None = Optional_()


class CalFireOfficialResponse(OfficialEnvelope):
    incident_url: str | None
    agencies: str | None                # CAL FIRE's AgencyNames, verbatim
    current: CalFireCurrent | None
    changes: list[CalFireChange]        # oldest first
    recording_since_ms: int | None      # the baseline's seen_ms


class AlertVtec(ContractModel):
    office: str                         # e.g. "KLOX"
    phenomena: str                      # "FW"
    significance: str                   # "W" warning | "A" watch
    etn: int
    action: str                         # NEW CON EXT EXA EXB CAN UPG EXP COR ROU


class FireWeatherAlert(ContractModel):
    id: str
    url: str | None
    office_url: str | None
    event: str                          # "Red Flag Warning" | "Fire Weather Watch"
    vtec: AlertVtec | None
    sender_name: str | None
    sent_ms: int | None
    effective_ms: int | None
    onset_ms: int | None
    expires_ms: int | None
    ends_ms: int | None
    headline: str | None
    nws_headline: str | None
    description: str | None
    instruction: str | None
    area_desc: str | None
    ugcs: list[str]
    message_type: str | None            # CAP Alert | Update | Cancel; null for archived copies
    status: str
    covers_reported_location: bool | None
    nearest_km: float | None
    archived: bool
    phase: AlertPhase
    time_zone: str | None               # brief 3 (14.6): IANA zone of the alert's first zone, else its state's


class FireWeatherResponse(OfficialEnvelope):
    alerts: list[FireWeatherAlert]
    zones: dict[str, Any]               # GeoJSON FeatureCollection; properties ugc, name, alert_ids
    area_bbox: tuple[float, float, float, float] | None
    reported_location: tuple[float, float] | None    # lon, lat
    states_checked: list[str]           # brief 3 (14.6): the states this answer covers ([] = none could be checked)
    alert_states: list[str]             # brief 3 (14.6): the states with at least one alert here


# ----------------------------------------------------------------------------------------------------------------
# Brief 3 official endpoints (CONTRACT 14.5 incident record, 14.7 local officials' messages)
# ----------------------------------------------------------------------------------------------------------------
class IncidentRecordCurrent(ContractModel):
    name: str                           # verbatim
    acres: float | None
    percent_contained: float | None
    is_active: bool
    discovered_ms: int | None
    contained_ms: int | None
    controlled_ms: int | None
    out_ms: int | None
    updated_ms: int | None              # ModifiedOnDateTime_dt: the record's own update time
    ics209_report_ms: int | None


class IncidentRecordComplex(ContractModel):
    name: str
    id: str | None


class IncidentRecordResponse(OfficialEnvelope):
    """``GET /api/official/incident-record?incident=<id>`` (kind "incident_record", CONTRACT 14.5)."""

    kind: Literal["incident_record"]
    record_source: Literal["wfigs"]
    irwin_id: str | None
    unique_fire_id: str | None
    publisher: Literal["NIFC WFIGS (IRWIN)"]
    agency_code: str | None             # protecting-agency code, verbatim
    agency: str | None                  # its plain name (nwcg_agency_codes.json); null when the code is unknown
    protecting_unit: str | None
    state: str | None
    county: str | None
    time_zone: str
    incident_url: str | None            # the all-years layer's f=html query by IrwinID (https)
    dataset_url: str                    # the NIFC Open Data item page ("about this source")
    current: IncidentRecordCurrent | None
    complex: IncidentRecordComplex | None
    changes: list[Any] = Field(max_length=0)   # history outside California is deferred: always []
    recording_since_ms: None


LocalChannel = Literal["nws_api", "openfema_archive"]


class LocalAlert(ContractModel):
    id: str                             # the CAP identifier, verbatim
    channel: LocalChannel
    archived: bool
    event: str                          # verbatim ("Fire Warning", "Evacuation Immediate")
    event_code: str                     # FRW | EVI | SPW | CDW | CEM | LAE
    message_type: Literal["Alert", "Update", "Cancel"] | None
    references: list[str]
    sender_name: str | None             # verbatim; never the operator's sender address
    sender_is_platform: bool
    sent_ms: int | None
    effective_ms: int | None
    onset_ms: int | None
    expires_ms: int | None
    headline: str | None
    description: str | None
    instruction: str | None
    wea_text: str | None
    wea_long_text: str | None
    web: str | None                     # https only; the issuer's own link
    source_url: str                     # always set, https: where this copy of the message can be read
    area_desc: str | None
    same_codes: list[str]
    ugcs: list[str]
    polygon: dict[str, Any] | None      # GeoJSON Polygon, or MultiPolygon when an archived message had several areas
    match: Literal["polygon", "county"]
    covers_reported_location: bool | None
    nearest_km: float | None
    time_zone: str | None               # IANA of its area
    phase: AlertPhase                   # relative to at_ms when given, else to now


class LocalChannelStatus(ContractModel):
    id: LocalChannel
    status: Literal["available", "unavailable", "pending", "not_checked"]
    retrieved_ms: int | None
    source_updated_ms: int | None
    reason: str | None


class LocalAlertCounty(ContractModel):
    fips: str
    name: str
    state: str


class LocalAlertsResponse(OfficialEnvelope):
    """``GET /api/official/local-alerts`` (kind "local_alerts", CONTRACT 14.7)."""

    kind: Literal["local_alerts"]
    alerts: list[LocalAlert]
    channels: list[LocalChannelStatus]
    area_bbox: tuple[float, float, float, float] | None
    reported_location: tuple[float, float] | None
    counties: list[LocalAlertCounty]    # the counties searched (SAME matching)


# ----------------------------------------------------------------------------------------------------------------
# Helpers
# ----------------------------------------------------------------------------------------------------------------
M = TypeVar("M", bound=BaseModel)


class ContractError(ValueError):
    """Raised by :func:`validate_strict` with the list of problems."""

    def __init__(self, model: str, problems: list[str]):
        self.model = model
        self.problems = problems
        more = f" (+{len(problems) - 12} more)" if len(problems) > 12 else ""
        super().__init__(f"{model}: " + "; ".join(problems[:12]) + more)


def _extra_paths(obj: Any, path: str) -> Iterator[str]:
    if isinstance(obj, BaseModel):
        for k in (obj.model_extra or {}):
            yield f"{path}.{k}" if path else k
        for name in type(obj).model_fields:
            yield from _extra_paths(getattr(obj, name), f"{path}.{name}" if path else name)
    elif isinstance(obj, (list, tuple)):
        for i, v in enumerate(obj):
            if isinstance(v, (BaseModel, list, tuple, dict)):
                yield from _extra_paths(v, f"{path}[{i}]")
    elif isinstance(obj, dict):
        for k, v in obj.items():
            if isinstance(v, (BaseModel, list, tuple, dict)):
                yield from _extra_paths(v, f"{path}.{k}")


def contract_problems(model_cls: type[BaseModel], data: Any) -> list[str]:
    """Strictly check ``data`` (a dict, JSON bytes/str or model) against ``model_cls``: JSON-strict types (no
    numeric strings, no fractional ints) plus unknown keys anywhere. Returns problems; empty means valid."""
    if isinstance(data, BaseModel):
        data = dump(data)
    raw = data if isinstance(data, (bytes, str)) else orjson.dumps(data, option=orjson.OPT_SERIALIZE_NUMPY)
    try:
        obj = model_cls.model_validate_json(raw, strict=True)
    except ValidationError as e:
        return [f"{'.'.join(str(p) for p in err['loc']) or '<root>'}: {err['msg']}" for err in e.errors()]
    return [f"{p}: unexpected field" for p in _extra_paths(obj, "")]


def validate_strict(model_cls: type[M], data: Any) -> M:
    """Validate like :func:`contract_problems` and return the model, or raise :class:`ContractError`."""
    problems = contract_problems(model_cls, data)
    if problems:
        raise ContractError(model_cls.__name__, problems)
    return model_cls.model_validate_json(data if isinstance(data, (bytes, str)) else orjson.dumps(dump(data) if isinstance(data, BaseModel) else data, option=orjson.OPT_SERIALIZE_NUMPY))


def dump(model: BaseModel) -> dict:
    """JSON-safe dict of a contract model (``x?`` fields omitted when None)."""
    return model.model_dump(mode="json")
