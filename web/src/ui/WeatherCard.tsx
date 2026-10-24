// Weather & Fire Behavior card (SPEC 9.4) at the current timeline time: wind mph + cardinal (degrees), temperature,
// RH, 1-h dead fuel moisture, FFWI and flame length, from weather.json `at_fire` (hourly). Re-renders only when the
// timeline crosses an hour. Thresholds tint values; tooltips explain them. Brief 4 (H5): the readings keep their icons;
// flame length is orange (#ff9a5a) as the handoff, red from 8 ft. FFWI has no official or peer-reviewed
// category scale, so it is shown as a value with an explanation and no low / high labels or tint (lib/plainLanguage).
import { CloudSun, Droplet, Flame, Gauge, Leaf, Navigation2, Thermometer, Wind } from 'lucide-react'
import type { ReactNode } from 'react'
import type { WeatherFile } from '../api/types'
import { cardinal, fmtNumber, msToMph } from '../lib/format'
import { isOpenMeteo } from '../lib/dataCredits'
import { fireWeatherSeverity } from '../lib/plainLanguage'
import { fmtAt, fmtClock, zoneAbbr } from '../lib/time'
import { weatherAt, weatherIndex, type WeatherNow } from '../state/selectors'
import { useStore } from '../state/store'
import { useTimeFormat } from '../state/timeZone'
import { Card, EmptyNote } from './controls'
import { OpenMeteoCredit } from './DataCredits'

type Tone = '' | 'warn' | 'danger'

function Cell({ icon, label, value, unit, sub, tone = '', tip, className }: { icon: ReactNode; label: string; value: string; unit?: string; sub?: ReactNode; tone?: Tone; tip?: string; className?: string }) {
  return (
    <div className={`wx-cell ${tone ? `wx-${tone}` : ''}${className ? ` ${className}` : ''}`} data-tip={tip}>
      <span className="wx-icon">{icon}</span>
      <span className="wx-label">{label}</span>
      <span className="wx-value mono">
        {value}
        {unit && <span className="wx-unit">{unit}</span>}
      </span>
      {sub != null && <span className="wx-sub mono">{sub}</span>}
    </div>
  )
}

function flameTip(ft: number): string {
  if (ft < 4) return 'Flame length < 4 ft: direct attack by hand crews is generally possible'
  if (ft < 8) return '4–8 ft: too intense for hand crews; equipment needed at the head'
  if (ft < 11) return '8–11 ft: control problems likely; torching, crowning and spotting possible'
  return '> 11 ft: crowning, spotting and major runs likely; direct control ineffective'
}

const toneOf = (v: number | null, warn: number, danger: number, lowerIsWorse = false): Tone => {
  if (v == null) return ''
  if (lowerIsWorse) return v <= danger ? 'danger' : v <= warn ? 'warn' : ''
  return v >= danger ? 'danger' : v >= warn ? 'warn' : ''
}

export function WeatherCard() {
  const tf = useTimeFormat()
  const weather = useStore((s) => s.weather)
  const idx = useStore((s) => weatherIndex(s.weather, s.timeMs))
  const hasManifest = useStore((s) => s.manifest?.status === 'ready')
  if (!hasManifest) return null
  return (
    <Card className="wx" title="Weather & Fire Behavior" sub="at fire front" collapsible storageKey="weather" aside={weather && idx != null ? <WxStamp w={weather} i={idx} /> : undefined}>
      {!weather ? (
        <EmptyNote icon={<CloudSun size={15} />} title="No weather in this bundle" />
      ) : idx == null ? (
        <EmptyNote icon={<CloudSun size={15} />} title="Outside the weather record">
          {fmtAt(weather.t_ms[0], tf)} → {fmtAt(weather.t_ms[weather.t_ms.length - 1], tf)}
        </EmptyNote>
      ) : (
        <>
          <WxBody now={weatherAt(weather, idx)} />
          {isOpenMeteo(weather.source) && <OpenMeteoCredit className="wx-credit" />}
        </>
      )}
    </Card>
  )
}

function WxStamp({ w, i }: { w: WeatherFile; i: number }) {
  const tf = useTimeFormat()
  const t = w.t_ms[i]
  const fc = w.forecast_from_ms != null && t >= w.forecast_from_ms
  return (
    <span className="wx-stamp" data-tip={`${fc ? 'Weather forecast hour' : 'Analysis / archived-forecast hour'} · ${fmtClock(t, tf)} ${zoneAbbr(t, tf.tz)} · ${w.source}`}>
      <span className={`chip ${fc ? 'chip-gold' : 'chip-muted'}`}>{fc ? 'FCST' : 'ANL'}</span>
      <span className="mono secondary">{fmtClock(t, tf)}</span>
    </span>
  )
}

function WxBody({ now }: { now: WeatherNow }) {
  const severity = fireWeatherSeverity(now.ffwi)
  const mph = now.windMs != null ? msToMph(now.windMs) : null
  const gustMph = now.gustMs != null ? msToMph(now.gustMs) : null
  const critical = now.rhPct != null && now.rhPct <= 15 && ((mph ?? 0) >= 25 || (gustMph ?? 0) >= 35)
  // the arrow points where the wind blows TO (FROM + 180°)
  const toDeg = now.dirDeg != null ? (now.dirDeg + 180) % 360 : null
  return (
    <>
      <div className="wx-grid">
        <Cell
          icon={
            toDeg != null ? (
              <Navigation2 size={15} style={{ transform: `rotate(${toDeg}deg)` }} />
            ) : (
              <Wind size={15} />
            )
          }
          label="Wind"
          value={mph != null ? fmtNumber(mph) : '—'}
          unit=" mph"
          sub={now.dirDeg != null ? `${cardinal(now.dirDeg)} (${fmtNumber(now.dirDeg)}°)` : undefined}
          tone={toneOf(mph, 20, 35)}
          tip={`10 m wind from ${now.dirDeg != null ? `${cardinal(now.dirDeg)} (${fmtNumber(now.dirDeg)}°)` : '—'}${gustMph != null ? ` · gusts ${fmtNumber(gustMph)} mph` : ''}`}
        />
        <Cell
          icon={<Thermometer size={15} />}
          label="Temp"
          value={now.tempC != null ? fmtNumber(now.tempC) : '—'}
          unit=" °C"
          sub={now.dewpointC != null ? `dew ${fmtNumber(now.dewpointC)} °C` : undefined}
          tone={toneOf(now.tempC, 32, 38)}
          tip="2 m air temperature"
        />
        <Cell
          icon={<Droplet size={15} />}
          label="RH"
          value={now.rhPct != null ? fmtNumber(now.rhPct) : '—'}
          unit="%"
          sub={now.precipMm != null ? `rain ${fmtNumber(now.precipMm, 1)} mm` : undefined}
          tone={toneOf(now.rhPct, 20, 10, true)}
          tip="Relative humidity (≤ 15% with strong wind = critical fire weather)"
        />
        <Cell
          icon={<Leaf size={15} />}
          label="Fuel moisture"
          value={now.fm1Pct != null ? fmtNumber(now.fm1Pct, now.fm1Pct < 10 ? 1 : 0) : '—'}
          unit="%"
          sub="1-h dead fuel"
          tone={toneOf(now.fm1Pct, 6, 3, true)}
          tip={`1-h dead fuel moisture (fine fuels)${now.fm10Pct != null ? ` · 10-h ${fmtNumber(now.fm10Pct, 1)}%` : ''}`}
        />
        <Cell
          icon={<Gauge size={15} />}
          label="FFWI"
          value={now.ffwi != null ? fmtNumber(now.ffwi) : '—'}
          sub={now.ffwi != null ? 'of 100 (Fosberg)' : undefined}
          tip={`Fire weather severity: ${severity.explanation}`}
        />
        <Cell
          icon={<Flame size={15} />}
          label="Flame length"
          className="wx-flame"
          value={now.flameFt != null ? fmtNumber(now.flameFt, now.flameFt < 10 ? 1 : 0) : '—'}
          unit=" ft"
          sub="head fire"
          tone={toneOf(now.flameFt, 4, 8)}
          tip={now.flameFt != null ? `Potential head-fire flame length in the local fuels · ${flameTip(now.flameFt)}` : 'Flame length not computed for this bundle'}
        />
      </div>
      <div className="wx-foot mono">
        {gustMph != null && <span>gusts {fmtNumber(gustMph)} mph</span>}
        {gustMph != null && now.rosPotential != null && (
          <span className="wx-foot-sep" aria-hidden="true">
            ·
          </span>
        )}
        {now.rosPotential != null && <span data-tip="Potential head-fire rate of spread from weather + local fuels">ROS potential {fmtNumber(now.rosPotential, now.rosPotential < 10 ? 1 : 0)} ch/h</span>}
        {critical && (
          <span className="chip chip-danger wx-crit" data-tip="RH ≤ 15% with sustained wind ≥ 25 mph or gusts ≥ 35 mph">
            critical fire weather
          </span>
        )}
      </div>
    </>
  )
}
