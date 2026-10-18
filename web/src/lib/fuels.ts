// LANDFIRE FBFM40 (Scott & Burgan 2005) fuel models: names, groups and two 256-entry RGBA lookup tables
// (index = fuel code, as stored in fuel.bin):
//   FUEL_REALISTIC_LUT - natural albedos for procedural realistic shading when imagery is off
//   FUEL_DATAVIZ_LUT   - a harmonious categorical palette that reads on the dark UI
// Code 0 = nodata (alpha 0).

export type FuelGroup = 'NB' | 'GR' | 'GS' | 'SH' | 'TU' | 'TL' | 'SB'

export interface FuelInfo {
  code: number
  label: string // "SH5"
  group: FuelGroup
  name: string // "High load, dry climate shrub"
  burnable: boolean
}

export const FUEL_GROUP_NAMES: Record<FuelGroup, string> = {
  NB: 'Non-burnable',
  GR: 'Grass',
  GS: 'Grass-shrub',
  SH: 'Shrub',
  TU: 'Timber-understory',
  TL: 'Timber litter',
  SB: 'Slash-blowdown',
}

const TABLE: [number, string, string][] = [
  [91, 'NB1', 'Urban / developed'],
  [92, 'NB2', 'Snow / ice'],
  [93, 'NB3', 'Agricultural'],
  [98, 'NB8', 'Open water'],
  [99, 'NB9', 'Bare ground'],
  [101, 'GR1', 'Short, sparse dry climate grass'],
  [102, 'GR2', 'Low load, dry climate grass'],
  [103, 'GR3', 'Low load, very coarse, humid climate grass'],
  [104, 'GR4', 'Moderate load, dry climate grass'],
  [105, 'GR5', 'Low load, humid climate grass'],
  [106, 'GR6', 'Moderate load, humid climate grass'],
  [107, 'GR7', 'High load, dry climate grass'],
  [108, 'GR8', 'High load, very coarse, humid climate grass'],
  [109, 'GR9', 'Very high load, humid climate grass'],
  [121, 'GS1', 'Low load, dry climate grass-shrub'],
  [122, 'GS2', 'Moderate load, dry climate grass-shrub'],
  [123, 'GS3', 'Moderate load, humid climate grass-shrub'],
  [124, 'GS4', 'High load, humid climate grass-shrub'],
  [141, 'SH1', 'Low load, dry climate shrub'],
  [142, 'SH2', 'Moderate load, dry climate shrub'],
  [143, 'SH3', 'Moderate load, humid climate shrub'],
  [144, 'SH4', 'Low load, humid climate timber-shrub'],
  [145, 'SH5', 'High load, dry climate shrub'],
  [146, 'SH6', 'Low load, humid climate shrub'],
  [147, 'SH7', 'Very high load, dry climate shrub'],
  [148, 'SH8', 'High load, humid climate shrub'],
  [149, 'SH9', 'Very high load, humid climate shrub'],
  [161, 'TU1', 'Low load, dry climate timber-grass-shrub'],
  [162, 'TU2', 'Moderate load, humid climate timber-shrub'],
  [163, 'TU3', 'Moderate load, humid climate timber-grass-shrub'],
  [164, 'TU4', 'Dwarf conifer with understory'],
  [165, 'TU5', 'Very high load, dry climate timber-shrub'],
  [181, 'TL1', 'Low load, compact conifer litter'],
  [182, 'TL2', 'Low load broadleaf litter'],
  [183, 'TL3', 'Moderate load conifer litter'],
  [184, 'TL4', 'Small downed logs'],
  [185, 'TL5', 'High load conifer litter'],
  [186, 'TL6', 'Moderate load broadleaf litter'],
  [187, 'TL7', 'Large downed logs'],
  [188, 'TL8', 'Long-needle litter'],
  [189, 'TL9', 'Very high load broadleaf litter'],
  [201, 'SB1', 'Low load activity fuel'],
  [202, 'SB2', 'Moderate load activity fuel or low load blowdown'],
  [203, 'SB3', 'High load activity fuel or moderate load blowdown'],
  [204, 'SB4', 'High load blowdown'],
]

const BY_CODE = new Map<number, FuelInfo>(
  TABLE.map(([code, label, name]) => [code, { code, label, group: label.slice(0, 2) as FuelGroup, name, burnable: code > 100 }]),
)

/** Fuel model info for an FBFM40 code (unknown codes -> a "Fuel model N" placeholder). */
export function fuelInfo(code: number): FuelInfo {
  const hit = BY_CODE.get(code)
  if (hit) return hit
  return { code, label: code === 0 ? '—' : String(code), group: 'NB', name: code === 0 ? 'No data' : `Fuel model ${code}`, burnable: false }
}

export const isBurnable = (code: number) => BY_CODE.get(code)?.burnable ?? false

export const FUEL_CODES: number[] = TABLE.map(([code]) => code)

type RGB = [number, number, number]

function hex(h: string): RGB {
  const n = parseInt(h.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

function mix(a: RGB, b: RGB, t: number): RGB {
  return [Math.round(a[0] + (b[0] - a[0]) * t), Math.round(a[1] + (b[1] - a[1]) * t), Math.round(a[2] + (b[2] - a[2]) * t)]
}

function buildLut(colorOf: (info: FuelInfo, indexInGroup: number, groupSize: number) => RGB): Uint8Array {
  const lut = new Uint8Array(256 * 4)
  const groups = new Map<FuelGroup, FuelInfo[]>()
  for (const info of BY_CODE.values()) {
    const arr = groups.get(info.group) ?? []
    arr.push(info)
    groups.set(info.group, arr)
  }
  for (const list of groups.values()) {
    list.forEach((info, i) => {
      const [r, g, b] = colorOf(info, i, list.length)
      lut.set([r, g, b, 255], info.code * 4)
    })
  }
  return lut
}

// Natural albedos (sRGB) for realistic procedural shading: straw grass, olive/sage shrub, dark conifer green,
// litter browns, stone grey, urban grey, water.
const REAL: Record<FuelGroup, [RGB, RGB]> = {
  GR: [hex('#c9b27c'), hex('#a8945e')], // pale straw -> denser golden grass
  GS: [hex('#a29a66'), hex('#7d7c4c')], // straw with sage shrubs
  SH: [hex('#6e7149'), hex('#434a2f')], // sage/olive chaparral -> dense dark chaparral
  TU: [hex('#46523a'), hex('#2c3826')], // timber with understory
  TL: [hex('#4f4a36'), hex('#2f3a28')], // litter floor under conifers -> dark canopy
  SB: [hex('#6b5a43'), hex('#4d4031')], // slash / blowdown browns
  NB: [hex('#7f7c76'), hex('#7f7c76')],
}
const REAL_NB: Record<number, RGB> = {
  91: hex('#77756f'), // urban grey
  92: hex('#e6e9ea'), // snow
  93: hex('#8a8a55'), // agriculture
  98: hex('#22323a'), // water
  99: hex('#938f86'), // stone / bare ground
}

export const FUEL_REALISTIC_LUT: Uint8Array = buildLut((info, i, n) =>
  info.group === 'NB' ? REAL_NB[info.code] ?? REAL.NB[0] : mix(REAL[info.group][0], REAL[info.group][1], n > 1 ? i / (n - 1) : 0),
)

// Data-viz palette tuned for the dark green-black UI (distinct hues per group, lightness by load).
const VIZ: Record<FuelGroup, [RGB, RGB]> = {
  GR: [hex('#f0dc8c'), hex('#c9a646')], // yellows
  GS: [hex('#d6d98a'), hex('#9fae4f')], // yellow-greens
  SH: [hex('#e3a46a'), hex('#a8572f')], // oranges / rust
  TU: [hex('#8fd0a0'), hex('#3f8f62')], // greens
  TL: [hex('#6fb7b0'), hex('#2f6f6c')], // teals
  SB: [hex('#c4a3e0'), hex('#7a5aa6')], // purples
  NB: [hex('#5d625f'), hex('#5d625f')],
}
const VIZ_NB: Record<number, RGB> = {
  91: hex('#9a9da3'),
  92: hex('#eef3f6'),
  93: hex('#b6bd7a'),
  98: hex('#4f8fd0'),
  99: hex('#6d6964'),
}

export const FUEL_DATAVIZ_LUT: Uint8Array = buildLut((info, i, n) =>
  info.group === 'NB' ? VIZ_NB[info.code] ?? VIZ.NB[0] : mix(VIZ[info.group][0], VIZ[info.group][1], n > 1 ? i / (n - 1) : 0),
)

/** CSS colour of a fuel code from a LUT. */
export function lutCss(lut: Uint8Array, code: number): string {
  const o = (code & 255) * 4
  return `rgb(${lut[o]}, ${lut[o + 1]}, ${lut[o + 2]})`
}

/** Representative data-viz colour per group (legends). */
export const FUEL_GROUP_COLORS: Record<FuelGroup, string> = Object.fromEntries(
  (Object.keys(VIZ) as FuelGroup[]).map((g) => {
    const [r, gg, b] = mix(VIZ[g][0], VIZ[g][1], 0.5)
    return [g, `rgb(${r}, ${gg}, ${b})`]
  }),
) as Record<FuelGroup, string>
