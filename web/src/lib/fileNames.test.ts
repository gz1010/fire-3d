// Guard: no two script files in one folder may differ only by upper / lower case (e.g. fixedCopy.ts next to
// FixedCopy.tsx). macOS and Windows disks ignore case, so an extensionless import such as './FixedCopy' can resolve to
// the other file there and the app fails to load, while Linux (CI, the cloud) works. Brief 4 shipped one such pair.
import { describe, expect, it } from 'vitest'

// keys only: the files are listed, never loaded
const files = Object.keys(import.meta.glob('/src/**/*.{ts,tsx,js,jsx,mts,mjs}'))

/** "src/ui/shell/FixedCopy.tsx" -> ["src/ui/shell", "FixedCopy"]; test files keep their ".test" part. */
function dirAndStem(path: string): [string, string] {
  const i = path.lastIndexOf('/')
  const name = path.slice(i + 1)
  return [path.slice(0, i), name.replace(/\.(ts|tsx|js|jsx|mts|mjs)$/, '')]
}

describe('source file names', () => {
  it('finds the source files', () => {
    expect(files.length).toBeGreaterThan(100)
  })

  it('never has two files in one folder whose names differ only by case', () => {
    const seen = new Map<string, string>()
    const clashes: string[] = []
    for (const f of files) {
      const [dir, stem] = dirAndStem(f)
      const key = `${dir.toLowerCase()}/${stem.toLowerCase()}`
      const other = seen.get(key)
      if (other && dirAndStem(other)[1] !== stem) clashes.push(`${other} <-> ${f}`)
      else seen.set(key, f)
    }
    expect(clashes).toEqual([])
  })
})
