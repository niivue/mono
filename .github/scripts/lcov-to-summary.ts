#!/usr/bin/env bun
// Parse an lcov.info file and emit a markdown coverage summary.
// Writes to $GITHUB_STEP_SUMMARY when set; otherwise prints to stdout.
//
// Usage:
//   bun .github/scripts/lcov-to-summary.ts <lcov-path> [options]
//
// Options:
//   --title <text>          Section heading (default "Coverage").
//   --sources <dir>         Also list source files under <dir> that no test
//                           loaded. Bun omits never-loaded files from lcov, so
//                           its totals cover loaded files only. Matched files
//                           (default **/*.ts, minus *.test.ts, *.spec.ts and
//                           *.d.ts) absent from lcov are counted as 0% in an
//                           extra "including unloaded files" total. Their line
//                           and function counts are estimates (TypeScript
//                           stripped with Bun.Transpiler, then counted).
//   --root <dir>            Directory lcov SF: paths are relative to
//                           (default: the parent of the lcov file's directory,
//                           i.e. the package root for <pkg>/coverage/lcov.info).
//   --exclude <glob>        Glob relative to --root to leave out of the
//                           unloaded-file scan. Repeatable.
//   --min-lines <pct>       Fail (exit 1) when loaded-file line coverage is
//                           below <pct> percent.
//   --min-functions <pct>   Fail (exit 1) when loaded-file function coverage
//                           is below <pct> percent.
//
// The --min-* floors apply to the exact lcov totals of loaded files, not to
// the estimated "including unloaded" totals.

import { appendFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { Glob } from 'bun'
import { estimateSource, type LcovRecord, parseLcov } from './lcov'

type Record = LcovRecord

type Totals = Omit<Record, 'file' | 'lines'>

const usage =
  'usage: lcov-to-summary.ts <lcov-path> [--title <title>] [--sources <dir>] [--root <dir>] [--exclude <glob>]... [--min-lines <pct>] [--min-functions <pct>]\n'

const valueOptions = new Set([
  '--title',
  '--sources',
  '--root',
  '--exclude',
  '--min-lines',
  '--min-functions',
])

const args = Bun.argv.slice(2)
const positional: string[] = []
const options = new Map<string, string[]>()
for (let i = 0; i < args.length; i++) {
  const arg = args[i] ?? ''
  if (!arg.startsWith('--')) {
    positional.push(arg)
    continue
  }
  if (!valueOptions.has(arg)) {
    Bun.stderr.write(`lcov-to-summary: unknown option ${arg}\n${usage}`)
    process.exit(2)
  }
  const value = args[i + 1]
  if (value === undefined) {
    Bun.stderr.write(`lcov-to-summary: ${arg} needs a value\n${usage}`)
    process.exit(2)
  }
  options.set(arg, [...(options.get(arg) ?? []), value])
  i++
}
const option = (name: string): string | undefined => options.get(name)?.at(-1)
const percentOption = (name: string): number | null => {
  const raw = option(name)
  if (raw === undefined) return null
  const value = Number(raw)
  if (Number.isNaN(value) || value < 0 || value > 100) {
    Bun.stderr.write(`lcov-to-summary: ${name} must be 0-100, got ${raw}\n`)
    process.exit(2)
  }
  return value
}

const lcovPath = positional[0]
const title = option('--title') ?? 'Coverage'
const sourcesDir = option('--sources')
const excludes = options.get('--exclude') ?? []
const minLines = percentOption('--min-lines')
const minFunctions = percentOption('--min-functions')

if (!lcovPath) {
  Bun.stderr.write(usage)
  process.exit(2)
}

const sfRoot = resolve(option('--root') ?? dirname(dirname(resolve(lcovPath))))

const lcovFile = Bun.file(lcovPath)
if (!(await lcovFile.exists())) {
  Bun.stderr.write(`lcov-to-summary: cannot read ${lcovPath}\n`)
  process.exit(0)
}
const lcov = await lcovFile.text()

const records = parseLcov(lcov)

if (records.length === 0) {
  Bun.stderr.write(`lcov-to-summary: no records parsed from ${lcovPath}\n`)
  process.exit(0)
}

const sumTotals = (rs: Record[]): Totals =>
  rs.reduce<Totals>(
    (acc, r) => {
      acc.linesFound += r.linesFound
      acc.linesHit += r.linesHit
      acc.fnFound += r.fnFound
      acc.fnHit += r.fnHit
      acc.brFound += r.brFound
      acc.brHit += r.brHit
      return acc
    },
    { linesFound: 0, linesHit: 0, fnFound: 0, fnHit: 0, brFound: 0, brHit: 0 },
  )

const totals = sumTotals(records)

const pct = (hit: number, found: number): number | null =>
  found === 0 ? null : (hit / found) * 100
const fmtPct = (v: number | null): string =>
  v === null ? '-' : `${v.toFixed(2)}%`

const linesPct = pct(totals.linesHit, totals.linesFound)
const fnPct = pct(totals.fnHit, totals.fnFound)
const brPct = pct(totals.brHit, totals.brFound)

type Unloaded = { file: string; lines: number; functions: number }
const unloaded: Unloaded[] = []
if (sourcesDir) {
  const loaded = new Set(records.map((r) => resolve(sfRoot, r.file)))
  const excludeGlobs = excludes.map((p) => new Glob(p))
  const testFile = /\.(test|spec)\.tsx?$|\.d\.ts$/
  const scanRoot = resolve(sourcesDir)
  for await (const rel of new Glob('**/*.ts').scan({ cwd: scanRoot })) {
    if (testFile.test(rel)) continue
    const abs = join(scanRoot, rel)
    if (loaded.has(abs)) continue
    const fromRoot = relative(sfRoot, abs)
    if (excludeGlobs.some((g) => g.match(fromRoot))) continue
    const counts = estimateSource(await Bun.file(abs).text())
    unloaded.push({ file: fromRoot, ...counts })
  }
  unloaded.sort((a, b) => b.lines - a.lines || a.file.localeCompare(b.file))
}

const rootRel = relative(process.cwd(), lcovPath) || lcovPath

const lines: string[] = []
lines.push(`## ${title}`)
lines.push('')
lines.push(`Source: \`${rootRel}\` - ${records.length} files loaded by tests`)
lines.push('')
lines.push('| Metric | Covered | Total | Percent |')
lines.push('| --- | ---: | ---: | ---: |')
lines.push(
  `| Lines | ${totals.linesHit} | ${totals.linesFound} | ${fmtPct(linesPct)} |`,
)
lines.push(
  `| Functions | ${totals.fnHit} | ${totals.fnFound} | ${fmtPct(fnPct)} |`,
)
if (totals.brFound > 0) {
  lines.push(
    `| Branches | ${totals.brHit} | ${totals.brFound} | ${fmtPct(brPct)} |`,
  )
}
lines.push('')

if (sourcesDir) {
  const extraLines = unloaded.reduce((n, u) => n + u.lines, 0)
  const extraFns = unloaded.reduce((n, u) => n + u.functions, 0)
  const allLines = totals.linesFound + extraLines
  const allFns = totals.fnFound + extraFns
  lines.push(
    `Including ${unloaded.length} source files no test loaded (counted as 0%; their sizes are estimates):`,
  )
  lines.push('')
  lines.push('| Metric | Covered | Total (est.) | Percent (est.) |')
  lines.push('| --- | ---: | ---: | ---: |')
  lines.push(
    `| Lines | ${totals.linesHit} | ${allLines} | ${fmtPct(pct(totals.linesHit, allLines))} |`,
  )
  lines.push(
    `| Functions | ${totals.fnHit} | ${allFns} | ${fmtPct(pct(totals.fnHit, allFns))} |`,
  )
  lines.push('')
  if (unloaded.length > 0) {
    const byDir = new Map<string, { files: number; lines: number }>()
    for (const u of unloaded) {
      const dir = dirname(u.file)
      const entry = byDir.get(dir) ?? { files: 0, lines: 0 }
      entry.files++
      entry.lines += u.lines
      byDir.set(dir, entry)
    }
    lines.push(
      `<details><summary>Files no test loaded (${unloaded.length})</summary>`,
    )
    lines.push('')
    lines.push('| Directory | Files | Lines (est.) |')
    lines.push('| --- | ---: | ---: |')
    for (const [dir, e] of [...byDir].sort((a, b) => b[1].lines - a[1].lines)) {
      lines.push(`| \`${dir}\` | ${e.files} | ${e.lines} |`)
    }
    lines.push('')
    lines.push('| File | Lines (est.) | Functions (est.) |')
    lines.push('| --- | ---: | ---: |')
    for (const u of unloaded) {
      lines.push(`| \`${u.file}\` | ${u.lines} | ${u.functions} |`)
    }
    lines.push('')
    lines.push('</details>')
    lines.push('')
  }
}

const failures: string[] = []
if (minLines !== null && (linesPct ?? 0) < minLines) {
  failures.push(
    `line coverage ${fmtPct(linesPct)} is below the ${minLines}% floor`,
  )
}
if (minFunctions !== null && (fnPct ?? 0) < minFunctions) {
  failures.push(
    `function coverage ${fmtPct(fnPct)} is below the ${minFunctions}% floor`,
  )
}
if (minLines !== null || minFunctions !== null) {
  const floors = [
    minLines === null ? null : `lines ${minLines}%`,
    minFunctions === null ? null : `functions ${minFunctions}%`,
  ]
    .filter((f) => f !== null)
    .join(', ')
  lines.push(
    failures.length === 0
      ? `Coverage floor (loaded files): ${floors} - passed.`
      : `Coverage floor (loaded files): ${floors} - FAILED: ${failures.join('; ')}.`,
  )
  lines.push('')
}

const perFile = records
  .map((r) => ({ ...r, pct: pct(r.linesHit, r.linesFound) }))
  .sort((a, b) => {
    if (a.pct === null && b.pct === null) return a.file.localeCompare(b.file)
    if (a.pct === null) return 1
    if (b.pct === null) return -1
    return a.pct - b.pct
  })

lines.push('<details><summary>Per-file coverage (worst to best)</summary>')
lines.push('')
lines.push('| File | Lines | Functions | Branches | Line % |')
lines.push('| --- | ---: | ---: | ---: | ---: |')
for (const r of perFile) {
  const linePct = pct(r.linesHit, r.linesFound)
  const fns = `${r.fnHit}/${r.fnFound}`
  const brs = r.brFound === 0 ? '-' : `${r.brHit}/${r.brFound}`
  lines.push(
    `| \`${r.file}\` | ${r.linesHit}/${r.linesFound} | ${fns} | ${brs} | ${fmtPct(linePct)} |`,
  )
}
lines.push('')
lines.push('</details>')
lines.push('')

const output = `${lines.join('\n')}\n`

const summaryPath = process.env.GITHUB_STEP_SUMMARY
if (summaryPath) {
  appendFileSync(summaryPath, output)
} else {
  await Bun.write(Bun.stdout, output)
}

if (failures.length > 0) {
  for (const f of failures) Bun.stderr.write(`lcov-to-summary: ${f}\n`)
  process.exit(1)
}
