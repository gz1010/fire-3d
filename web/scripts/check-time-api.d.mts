// Types for check-time-api.mjs (imported by its unit test, src/lib/checkTimeApi.test.ts).
export const WEB: string
export const TIME_MODULE: string
export const DEPRECATED: Set<string>
export function globToRegExp(glob: string): RegExp
export interface Analysis {
  deprecated: number
  uses: { line: number; name: string }[]
  la: number[]
  optOuts: { line: number; reason: string }[]
}
export function analyse(absPath: string, text: string): Analysis
