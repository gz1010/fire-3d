// The lower 48 states and DC (brief 3, CONTRACT §14.10): USPS codes and names for search parsing ("Boise, ID",
// "83702 ID", "Garfield Co., CO") and for display. Alaska, Hawaii and the territories are listed separately: Fire-3d
// does not support them yet, but search must still recognise their names to say so.

/** USPS code → name, the 48 contiguous states plus DC (same set as the backend's regions.L48). */
export const L48_STATES: Readonly<Record<string, string>> = {
  AL: 'Alabama',
  AZ: 'Arizona',
  AR: 'Arkansas',
  CA: 'California',
  CO: 'Colorado',
  CT: 'Connecticut',
  DE: 'Delaware',
  DC: 'District of Columbia',
  FL: 'Florida',
  GA: 'Georgia',
  ID: 'Idaho',
  IL: 'Illinois',
  IN: 'Indiana',
  IA: 'Iowa',
  KS: 'Kansas',
  KY: 'Kentucky',
  LA: 'Louisiana',
  ME: 'Maine',
  MD: 'Maryland',
  MA: 'Massachusetts',
  MI: 'Michigan',
  MN: 'Minnesota',
  MS: 'Mississippi',
  MO: 'Missouri',
  MT: 'Montana',
  NE: 'Nebraska',
  NV: 'Nevada',
  NH: 'New Hampshire',
  NJ: 'New Jersey',
  NM: 'New Mexico',
  NY: 'New York',
  NC: 'North Carolina',
  ND: 'North Dakota',
  OH: 'Ohio',
  OK: 'Oklahoma',
  OR: 'Oregon',
  PA: 'Pennsylvania',
  RI: 'Rhode Island',
  SC: 'South Carolina',
  SD: 'South Dakota',
  TN: 'Tennessee',
  TX: 'Texas',
  UT: 'Utah',
  VT: 'Vermont',
  VA: 'Virginia',
  WA: 'Washington',
  WV: 'West Virginia',
  WI: 'Wisconsin',
  WY: 'Wyoming',
}

/** States and territories Fire-3d does not support yet (recognised by search so it can say so). */
export const UNSUPPORTED_STATES: Readonly<Record<string, string>> = {
  AK: 'Alaska',
  HI: 'Hawaii',
  PR: 'Puerto Rico',
  VI: 'U.S. Virgin Islands',
  GU: 'Guam',
  AS: 'American Samoa',
  MP: 'Northern Mariana Islands',
}

const ALL: Readonly<Record<string, string>> = { ...L48_STATES, ...UNSUPPORTED_STATES }

/** Common abbreviations people type, beyond the USPS codes and full names. */
const ALIASES: Readonly<Record<string, string>> = {
  calif: 'CA',
  cal: 'CA',
  ariz: 'AZ',
  colo: 'CO',
  conn: 'CT',
  fla: 'FL',
  ill: 'IL',
  ind: 'IN',
  kans: 'KS',
  mass: 'MA',
  mich: 'MI',
  minn: 'MN',
  miss: 'MS',
  mont: 'MT',
  nebr: 'NE',
  nev: 'NV',
  okla: 'OK',
  ore: 'OR',
  oreg: 'OR',
  penn: 'PA',
  penna: 'PA',
  tenn: 'TN',
  tex: 'TX',
  wash: 'WA',
  wis: 'WI',
  wisc: 'WI',
  wyo: 'WY',
  'd.c.': 'DC',
  'washington dc': 'DC',
  'washington d.c.': 'DC',
}

const BY_NAME: ReadonlyMap<string, string> = new Map([
  ...Object.entries(ALL).map(([code, name]) => [name.toLowerCase(), code] as [string, string]),
  ...Object.entries(ALIASES),
])

/** The USPS code for a state word: a code ("id", "ID"), a name ("Idaho", "new mexico") or a common abbreviation
 *  ("Calif.", "Wash."); null when it is not a state. Includes Alaska, Hawaii and the territories. */
export function stateCode(word: string | null | undefined): string | null {
  if (!word) return null
  const w = word.trim().replace(/\s+/g, ' ')
  if (!w) return null
  const up = w.toUpperCase()
  if (up.length === 2 && up in ALL) return up
  const low = w.toLowerCase()
  return BY_NAME.get(low) ?? BY_NAME.get(low.replace(/\.$/, '')) ?? null
}

/** The state's name ("Idaho"), or null for an unknown code. */
export function stateName(code: string | null | undefined): string | null {
  return code ? (ALL[code.toUpperCase()] ?? null) : null
}

/** Is this one of the lower 48 states or DC (supported)? */
export function isLower48(code: string | null | undefined): boolean {
  return !!code && code.toUpperCase() in L48_STATES
}

/** Every lowercase state word search should strip or recognise: codes, names and abbreviations. */
export function stateWords(): string[] {
  return [...new Set([...Object.keys(ALL).map((c) => c.toLowerCase()), ...BY_NAME.keys()])]
}
