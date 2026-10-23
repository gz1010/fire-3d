#!/usr/bin/env node
// Measures the brief-3 time migration (CONTRACT §14.9.3).
//
//   node web/scripts/check-time-api.mjs --role <label>      # that role's "owns" globs (plan3-roles.json), files under web/
//   node web/scripts/check-time-api.mjs web/src [more paths] # explicit files or directories
//   (both forms can be combined; add --quiet to print only files with a count above 0 and the totals)
//
// Two counts per file:
//   deprecated  uses of the Pacific-bound names of web/src/lib/time.ts (TZ, laParts, fmtDateTime, …): only names that the
//               file imports from lib/time (directly, renamed, or through a namespace import) and then uses. Comments
//               and strings never count (the file is parsed with the TypeScript compiler). lib/time.ts itself (where the
//               names are defined) and its own unit test lib/time.test.ts (which checks the deprecated shims until the
//               integration deletes both) are skipped.
//   la          'America/Los_Angeles' literals outside comments, in non-test files. A line can opt out with a
//               `// tz-ok: <reason>` comment; opt-outs are listed with their reasons and do not count.
// Exit code 1 when either total is above 0, else 0.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, extname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const here = dirname(fileURLToPath(import.meta.url))
export const WEB = resolve(here, '..')
const ROOT = resolve(WEB, '..')
export const TIME_MODULE = join(WEB, 'src', 'lib', 'time.ts')
/** The definitions' own test (it tests the deprecated shims; deleted with them by the integration). */
export const TIME_TEST = join(WEB, 'src', 'lib', 'time.test.ts')
const ROLES_FILE = join(ROOT, 'docs', 'redesign', 'plan3-roles.json')
const CODE_EXT = new Set(['.ts', '.tsx', '.mts', '.mjs', '.js', '.jsx'])
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', '.vite'])
const LA = 'America/Los_Angeles' // tz-ok: the checker's own search string

/** The deprecated (Pacific-bound) exports of lib/time.ts (§14.9.3). */
export const DEPRECATED = new Set([
  'TZ',
  'tzLabel',
  'laParts',
  'laOffsetMinutes',
  'startOfLaDay',
  'laTicks',
  'laDayTicks',
  'laWallToMs',
  'laWallTicks',
  'fmtDateTime',
  'fmtDate',
  'fmtDateTimeYear',
  'fmtTime',
  'fmtDay',
  'fmtDateRange',
  'fmtDateTimeTz',
  'fmtDateTimeYearTz',
  'fmtWeekdayDay',
  'LaParts',
])

const toPosix = (p) => p.split(sep).join('/')

/** Glob → RegExp, the same rules as PLAN-3 appendix B: '*' and '?' stay in one segment, '**' crosses '/',
 *  '[!x]' excludes a first character. */
export function globToRegExp(g) {
  let out = ''
  for (let i = 0; i < g.length; i++) {
    if (g.startsWith('**', i)) {
      out += '.*'
      i += 1
      continue
    }
    const c = g[i]
    if (c === '*') out += '[^/]*'
    else if (c === '?') out += '[^/]'
    else if (c === '[') {
      const j = g.indexOf(']', i)
      const body = g.slice(i + 1, j)
      out += body.startsWith('!') ? `[^/${escapeClass(body.slice(1))}]` : `[${escapeClass(body)}]`
      i = j
    } else out += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${out}$`)
}
const escapeClass = (s) => s.replace(/[\]\\^-]/g, '\\$&')

function walk(dir, out) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) walk(p, out)
    else if (CODE_EXT.has(extname(name))) out.push(p)
  }
  return out
}

function roleFiles(label) {
  const roles = JSON.parse(readFileSync(ROLES_FILE, 'utf8')).roles
  const role = roles.find((r) => r.label === label)
  if (!role) throw new Error(`unknown role '${label}' (plan3-roles.json has: ${roles.map((r) => r.label).join(', ')})`)
  const globs = [...role.owns, ...(role.owns_bugfix_only ?? [])].map(globToRegExp)
  return walk(WEB, []).filter((abs) => {
    const rel = toPosix(relative(ROOT, abs))
    return globs.some((rx) => rx.test(rel))
  })
}

function resolvesToTime(fromFile, spec) {
  if (!spec.startsWith('.')) return false
  const base = resolve(dirname(fromFile), spec)
  return [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts')].some((p) => p === TIME_MODULE)
}

const isTestFile = (abs) => /\.(test|spec)\.[cm]?[jt]sx?$/.test(abs) || /\.testutil\.[jt]sx?$/.test(abs)

/** Count both measures in one file's text. */
export function analyse(abs, text) {
  const kind = abs.endsWith('.tsx') || abs.endsWith('.jsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  const sf = ts.createSourceFile(abs, text, ts.ScriptTarget.Latest, true, kind)
  const locals = new Map() // local binding → imported deprecated name
  const namespaces = new Set()
  const importNodes = new Set()
  let deprecated = 0
  const uses = []
  const lineOf = (node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1

  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier) && resolvesToTime(abs, st.moduleSpecifier.text)) {
      importNodes.add(st)
      const cl = st.importClause
      if (!cl?.namedBindings) continue
      if (ts.isNamespaceImport(cl.namedBindings)) namespaces.add(cl.namedBindings.name.text)
      else
        for (const el of cl.namedBindings.elements) {
          const imported = (el.propertyName ?? el.name).text
          if (DEPRECATED.has(imported)) locals.set(el.name.text, imported)
        }
    } else if (
      ts.isExportDeclaration(st) &&
      st.moduleSpecifier &&
      ts.isStringLiteral(st.moduleSpecifier) &&
      resolvesToTime(abs, st.moduleSpecifier.text)
    ) {
      // a re-export spreads the deprecated name: each one counts as a use
      importNodes.add(st)
      if (st.exportClause && ts.isNamedExports(st.exportClause))
        for (const el of st.exportClause.elements) {
          const imported = (el.propertyName ?? el.name).text
          if (DEPRECATED.has(imported)) {
            deprecated++
            uses.push({ line: lineOf(el), name: imported })
          }
        }
      else if (!st.exportClause) {
        deprecated++
        uses.push({ line: lineOf(st), name: '*' })
      }
    }
  }

  const laLines = new Set()
  const visit = (node) => {
    if (importNodes.has(node)) return
    if (namespaces.size && ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && namespaces.has(node.expression.text)) {
      if (DEPRECATED.has(node.name.text)) {
        deprecated++
        uses.push({ line: lineOf(node), name: node.name.text })
      }
    } else if (namespaces.size && ts.isQualifiedName(node) && ts.isIdentifier(node.left) && namespaces.has(node.left.text)) {
      if (DEPRECATED.has(node.right.text)) {
        deprecated++
        uses.push({ line: lineOf(node), name: node.right.text })
      }
    } else if (ts.isIdentifier(node) && locals.has(node.text)) {
      const parent = node.parent
      // skip property names (obj.fmtDate, { fmtDate: 1 }) that only share the spelling
      const isPropName =
        (parent && ts.isPropertyAccessExpression(parent) && parent.name === node) ||
        (parent && ts.isPropertyAssignment(parent) && parent.name === node) ||
        (parent && ts.isQualifiedName(parent) && parent.right === node)
      if (!isPropName) {
        deprecated++
        uses.push({ line: lineOf(node), name: locals.get(node.text) })
      }
    }
    if (
      (ts.isStringLiteral(node) ||
        ts.isNoSubstitutionTemplateLiteral(node) ||
        ts.isTemplateHead(node) ||
        ts.isTemplateMiddle(node) ||
        ts.isTemplateTail(node) ||
        ts.isJsxText(node)) &&
      node.text.includes(LA)
    )
      laLines.add(lineOf(node))
    ts.forEachChild(node, visit)
  }
  visit(sf)

  const lines = text.split('\n')
  const la = []
  const optOuts = []
  if (!isTestFile(abs))
    for (const n of [...laLines].sort((a, b) => a - b)) {
      const m = /\/\/\s*tz-ok:\s*(.*)$/.exec(lines[n - 1] ?? '')
      if (m) optOuts.push({ line: n, reason: m[1].trim() || '(no reason given)' })
      else la.push(n)
    }
  return { deprecated, uses, la, optOuts }
}

function main(argv) {
  const files = new Set()
  let quiet = false
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--role') {
      const label = argv[++i]
      if (!label) throw new Error('--role needs a label')
      for (const f of roleFiles(label)) files.add(f)
    } else if (a === '--quiet') quiet = true
    else if (a === '-h' || a === '--help') {
      console.log('usage: node web/scripts/check-time-api.mjs [--role <label>] [--quiet] [paths...]')
      return 0
    } else {
      const p = resolve(process.cwd(), a)
      if (!existsSync(p)) throw new Error(`no such path: ${a}`)
      if (statSync(p).isDirectory()) for (const f of walk(p, [])) files.add(f)
      else files.add(p)
    }
  }
  if (!files.size) throw new Error('no files: pass --role <label> and/or paths')
  files.delete(TIME_MODULE)
  files.delete(TIME_TEST)
  let totalDep = 0
  let totalLa = 0
  const allOptOuts = []
  const sorted = [...files].sort()
  for (const abs of sorted) {
    const r = analyse(abs, readFileSync(abs, 'utf8'))
    totalDep += r.deprecated
    totalLa += r.la.length
    const rel = toPosix(relative(ROOT, abs))
    for (const o of r.optOuts) allOptOuts.push(`${rel}:${o.line}  ${o.reason}`)
    if (quiet && !r.deprecated && !r.la.length) continue
    if (!r.deprecated && !r.la.length) continue
    const names = [...new Set(r.uses.map((u) => u.name))].join(', ')
    console.log(`${String(r.deprecated).padStart(4)} deprecated  ${String(r.la.length).padStart(3)} la  ${rel}${names ? `  (${names})` : ''}${r.la.length ? `  la lines ${r.la.join(',')}` : ''}`)
  }
  if (allOptOuts.length) {
    console.log(`tz-ok opt-outs (${allOptOuts.length}):`)
    for (const o of allOptOuts) console.log(`  ${o}`)
  }
  console.log(`files checked: ${sorted.length}`)
  console.log(`total: ${totalDep} deprecated uses, ${totalLa} ${LA} literals`)
  return totalDep > 0 || totalLa > 0 ? 1 : 0
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exit(main(process.argv.slice(2)))
  } catch (e) {
    console.error(`check-time-api: ${e.message}`)
    process.exit(2)
  }
}
