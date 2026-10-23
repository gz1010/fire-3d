// Unit tests for web/scripts/check-time-api.mjs (CONTRACT §14.9.3): import-based counting only, comments and strings
// ignored, America/Los_Angeles literals with `// tz-ok:` opt-outs, the plan's glob rules.
import { describe, expect, it } from 'vitest'
import { DEPRECATED, TIME_MODULE, analyse, globToRegExp } from '../../scripts/check-time-api.mjs'

const LA = ['America', 'Los_Angeles'].join('/')
const file = (rel: string) => TIME_MODULE.replace(/lib[\\/]time\.ts$/, rel)

describe('check-time-api: deprecated uses', () => {
  it('counts named, renamed and namespace imports from lib/time, and only their uses', () => {
    const src = [
      "import { fmtDateTime, fmtTime as ft, fmtAt, timeFmt } from '../lib/time'",
      "import * as T from '../lib/time'",
      'const a = fmtDateTime(1) + ft(2)',
      'const b = T.tzLabel(3) + T.fmtClock(4, timeFmt(null, "24h"))',
      'type P = T.LaParts',
      '// fmtDateTime(5) in a comment does not count',
      'const s = "fmtDateTime(6) in a string does not count"',
      'const o = { fmtDateTime: 1 }; o.fmtDateTime',
      'fmtAt(1, timeFmt(null, "12h"))',
    ].join('\n')
    const r = analyse(file('ui/Fake.tsx'), src)
    expect(r.uses.map((u) => u.name)).toEqual(['fmtDateTime', 'fmtTime', 'tzLabel', 'LaParts'])
    expect(r.deprecated).toBe(4)
  })

  it('ignores the same names imported from another module, and imports without uses', () => {
    const src = ["import { fmtDate } from './format'", "import { fmtTime } from '../lib/time'", 'fmtDate(1)'].join('\n')
    expect(analyse(file('ui/Fake.ts'), src).deprecated).toBe(0)
  })

  it('resolves relative paths from the file (lib/x.ts imports ./time)', () => {
    expect(analyse(file('lib/x.ts'), "import { laParts } from './time'\nlaParts(1)").deprecated).toBe(1)
    expect(analyse(file('ui/shell/x.ts'), "import { laParts } from '../../lib/time'\nlaParts(1)").deprecated).toBe(1)
  })

  it('counts a re-export of a deprecated name', () => {
    expect(analyse(file('ui/x.ts'), "export { fmtDate, fmtAt } from '../lib/time'").deprecated).toBe(1)
  })

  it('knows every deprecated name of §14.9.3', () => {
    expect(DEPRECATED.size).toBe(19)
    for (const n of ['TZ', 'laWallTicks', 'fmtDateTimeYearTz', 'fmtWeekdayDay', 'LaParts']) expect(DEPRECATED.has(n)).toBe(true)
    expect(DEPRECATED.has('fmtAt')).toBe(false)
  })
})

describe('check-time-api: America/Los_Angeles literals', () => {
  it('counts string, template and JSX text literals outside comments, with tz-ok opt-outs', () => {
    const src = [
      `const a = '${LA}'`,
      `// '${LA}' in a comment`,
      `const b = \`zone \${1} ${LA}\``,
      `const c = '${LA}' // tz-ok: the CAL FIRE feed's own zone`,
      `const d = <dd>${LA}</dd>`,
    ].join('\n')
    const r = analyse(file('ui/Fake.tsx'), src)
    expect(r.la).toEqual([1, 3, 5])
    expect(r.optOuts).toEqual([{ line: 4, reason: "the CAL FIRE feed's own zone" }])
  })

  it('skips test files for literals', () => {
    expect(analyse(file('ui/Fake.test.ts'), `const a = '${LA}'`).la).toEqual([])
  })
})

describe('check-time-api: globs (PLAN-3 appendix B rules)', () => {
  it('* stays in a segment, ** crosses, [!x] excludes a first character', () => {
    expect(globToRegExp('web/src/lib/**').test('web/src/lib/a/b.ts')).toBe(true)
    expect(globToRegExp('web/src/ui/*.tsx').test('web/src/ui/a.tsx')).toBe(true)
    expect(globToRegExp('web/src/ui/*.tsx').test('web/src/ui/shell/a.tsx')).toBe(false)
    const shell = globToRegExp('web/src/ui/shell/[!dLUo]*')
    expect(shell.test('web/src/ui/shell/FireCard.tsx')).toBe(true)
    expect(shell.test('web/src/ui/shell/dataStatus.ts')).toBe(false)
    expect(shell.test('web/src/ui/shell/LayersPanel.tsx')).toBe(false)
    expect(shell.test('web/src/ui/shell/officialSummary.ts')).toBe(false)
    const loc = globToRegExp('web/src/location/[!o]*')
    expect(loc.test('web/src/location/search.ts')).toBe(true)
    expect(loc.test('web/src/location/official.ts')).toBe(false)
  })
})
