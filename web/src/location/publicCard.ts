// The location card in the Public fire view (brief 4 H4, PLAN-4 decision a: "Public shows no model output"; review R4).
// Pure and tested (publicCard.test.ts). The card keeps what is observed, mapped, official or measured terrain, and
// leaves out every model reading: the spread model's sentence, run and reliability line, the forecast section, the
// weather-model readings (wind and dryness, tagged MODEL: HRRR / Open-Meteo forecasts, not observations), the
// forecast's own caveats and the model sources. LocationCard puts "… is in Command ›" in their place.
import type { LocationCardModel } from './describe'
import { isModelCaveat } from './locationCheck'

export function withoutModel(card: LocationCardModel): LocationCardModel {
  return {
    ...card,
    summary: {
      ...card.summary,
      model: null,
      run: null,
      reasons: card.summary.reasons.filter((r) => r.kind !== 'Model'),
      reliability: card.summary.reliability.filter((l) => l.key !== 'model'),
    },
    details: card.details.filter((s) => s.key !== 'forecast').map((s) => ({ ...s, lines: s.lines.filter((l) => l.kind !== 'Model') })).filter((s) => s.lines.length > 0),
    sources: card.sources.filter((s) => s.kind !== 'model'),
    caveats: card.caveats.filter((c) => !isModelCaveat(c)),
  }
}
