#!/usr/bin/env bun
// Merge Bun unit-test coverage with browser (e2e) coverage and summarise
// which source each suite exercises. Writes a merged lcov and a markdown
// summary (to $GITHUB_STEP_SUMMARY when set, otherwise stdout).
//
// Usage (paths relative to the package root, where both lcov files' SF:
// paths are rooted):
//   bun .github/scripts/coverage-merge.ts --bun coverage/lcov.info \
//     --e2e coverage-e2e/lcov.info --out coverage-merged/lcov.info \
//     --sources src [--exclude <glob>]... [--title <text>]
//
// A missing input counts as a suite that hit nothing, so an e2e-only (or
// Bun-only) run still gets a report.
//
// Lines only. Both inputs number lines of the original .ts file, but they
// count different lines as executable: Bun marks every line of a multi-line
// statement, V8 (via source maps) only the line a statement starts on. For a
// file both suites loaded, the lines compared are the ones both count, and a
// line is covered when either suite hit it. A file only one suite loaded keeps
// that suite's lines, and a source file neither loaded counts as 0% with an
// estimated size. Bun's lcov has no per-function records, so functions are
// not merged.

import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { Glob } from 'bun'
import { estimateSource, type LcovRecord, parseLcov } from './lcov'

const usage =
  'usage: coverage-merge.ts --bun <lcov> --e2e <lcov> [--out <lcov>] [--sources <dir>] [--exclude <glob>]... [--title <text>]\n'
const valueOptions = new Set([
  '--bun',
  '--e2e',
  '--out',
  '--sources',
  '--exclude',
  '--title',
])
const options = new Map<string, string[]>()
const args = Bun.argv.slice(2)
for (let i = 0; i < args.length; i++) {
  const arg = args[i] ?? ''
  const value = args[i + 1]
  if (!valueOptions.has(arg) || value === undefined) {
    Bun.stderr.write(`coverage-merge: bad argument ${arg}\n${usage}`)
    process.exit(2)
  }
  options.set(arg, [...(options.get(arg) ?? []), value])
  i++
}
const option = (name: string): string | undefined => options.get(name)?.at(-1)
const bunPath = option('--bun')
const e2ePath = option('--e2e')
if (!bunPath || !e2ePath) {
  Bun.stderr.write(usage)
  process.exit(2)
}
const outPath = option('--out')
const sourcesDir = option('--sources')
const title = option('--title') ?? 'Coverage: unit (Bun) and browser (e2e)'
const excludeGlobs = (options.get('--exclude') ?? []).map((g) => new Glob(g))
const isExcluded = (file: string) => excludeGlobs.some((g) => g.match(file))

const read = async (path: string): Promise<Map<string, LcovRecord> | null> => {
  const file = Bun.file(path)
  if (!(await file.exists())) return null
  const records = parseLcov(await file.text()).filter(
    (r) => !isExcluded(r.file),
  )
  return new Map(records.map((r) => [r.file, r]))
}
const bun = await read(bunPath)
const e2e = await read(e2ePath)

type FileCoverage = {
  file: string
  /** Line to hit count in each suite, over the lines compared. */
  bunLines: Map<number, number>
  e2eLines: Map<number, number>
  /** Lines compared; for a file neither suite loaded, an estimate. */
  total: number
  bunHit: number
  e2eHit: number
  mergedHit: number
  loaded: boolean
}

const hitsOn = (r: LcovRecord | undefined, lines: number[]) =>
  new Map(lines.map((l) => [l, r?.lines.get(l) ?? 0]))

const files = new Map<string, FileCoverage>()
const names = new Set([...(bun?.keys() ?? []), ...(e2e?.keys() ?? [])])
for (const file of names) {
  const b = bun?.get(file)
  const e = e2e?.get(file)
  let lines: number[]
  if (b && e) {
    lines = [...e.lines.keys()].filter((l) => b.lines.has(l))
    if (lines.length === 0)
      lines = [...new Set([...b.lines.keys(), ...e.lines.keys()])]
  } else {
    lines = [...((b ?? e)?.lines.keys() ?? [])]
  }
  lines.sort((x, y) => x - y)
  const bunLines = hitsOn(b, lines)
  const e2eLines = hitsOn(e, lines)
  const hit = (m: Map<number, number>) =>
    [...m.values()].filter((h) => h > 0).length
  files.set(file, {
    file,
    bunLines,
    e2eLines,
    total: lines.length,
    bunHit: hit(bunLines),
    e2eHit: hit(e2eLines),
    mergedHit: lines.filter(
      (l) => (bunLines.get(l) ?? 0) > 0 || (e2eLines.get(l) ?? 0) > 0,
    ).length,
    loaded: true,
  })
}

// Source files neither suite loaded.
const root = process.cwd()
if (sourcesDir) {
  const scanRoot = resolve(sourcesDir)
  for await (const rel of new Glob('**/*.ts').scan({ cwd: scanRoot })) {
    if (/\.(test|spec)\.tsx?$|\.d\.ts$/.test(rel)) continue
    const file = relative(root, join(scanRoot, rel))
    if (files.has(file) || isExcluded(file)) continue
    const { lines } = estimateSource(await Bun.file(join(scanRoot, rel)).text())
    files.set(file, {
      file,
      bunLines: new Map(),
      e2eLines: new Map(),
      total: lines,
      bunHit: 0,
      e2eHit: 0,
      mergedHit: 0,
      loaded: false,
    })
  }
}

if (outPath) {
  const out: string[] = []
  for (const f of [...files.values()].sort((a, b) =>
    a.file.localeCompare(b.file),
  )) {
    if (!f.loaded) continue
    out.push('TN:', `SF:${f.file}`)
    for (const [line, hits] of f.bunLines)
      out.push(`DA:${line},${hits + (f.e2eLines.get(line) ?? 0)}`)
    out.push(`LF:${f.total}`, `LH:${f.mergedHit}`, 'end_of_record')
  }
  mkdirSync(dirname(resolve(outPath)), { recursive: true })
  await Bun.write(outPath, `${out.join('\n')}\n`)
}

// Areas: the top-level directories of the sources dir, and its root files.
const sourcesRel = sourcesDir ? relative(root, resolve(sourcesDir)) : ''
const areaOf = (file: string): string => {
  const rel = sourcesRel ? relative(sourcesRel, file) : file
  const slash = rel.indexOf('/')
  return slash < 0
    ? join(sourcesRel, rel)
    : `${join(sourcesRel, rel.slice(0, slash))}/`
}
type Sum = {
  files: number
  total: number
  bunHit: number
  e2eHit: number
  mergedHit: number
}
const add = (s: Sum, f: FileCoverage) => {
  s.files++
  s.total += f.total
  s.bunHit += f.bunHit
  s.e2eHit += f.e2eHit
  s.mergedHit += f.mergedHit
}
const empty = (): Sum => ({
  files: 0,
  total: 0,
  bunHit: 0,
  e2eHit: 0,
  mergedHit: 0,
})
const all = empty()
const areas = new Map<string, Sum>()
for (const f of files.values()) {
  add(all, f)
  const area = areaOf(f.file)
  const s = areas.get(area) ?? empty()
  add(s, f)
  areas.set(area, s)
}

const pct = (hit: number, total: number) =>
  total === 0 ? '-' : `${((hit / total) * 100).toFixed(1)}%`
const input = (path: string, m: Map<string, LcovRecord> | null) =>
  m ? `\`${path}\` (${m.size} files)` : `\`${path}\` (missing: counted as 0%)`

const md: string[] = []
md.push(`## ${title}`, '')
md.push(`Unit: ${input(bunPath, bun)}. Browser: ${input(e2ePath, e2e)}.`)
if (outPath) md.push(`Merged lcov: \`${outPath}\`.`)
md.push('')
md.push('| Suite | Lines covered | Lines | Percent |')
md.push('| --- | ---: | ---: | ---: |')
md.push(
  `| Unit (Bun) | ${all.bunHit} | ${all.total} | ${pct(all.bunHit, all.total)} |`,
)
md.push(
  `| Browser (e2e) | ${all.e2eHit} | ${all.total} | ${pct(all.e2eHit, all.total)} |`,
)
md.push(
  `| Merged | ${all.mergedHit} | ${all.total} | ${pct(all.mergedHit, all.total)} |`,
)
md.push('')
md.push(
  'Lines both suites count as executable, where both loaded a file; files neither loaded count as 0% with an estimated size. Browser coverage is page JavaScript only: not Web Workers, not shader execution.',
  '',
)
md.push('| Area | Files | Lines | Unit | Browser | Merged |')
md.push('| --- | ---: | ---: | ---: | ---: | ---: |')
for (const [area, s] of [...areas].sort((a, b) => b[1].total - a[1].total)) {
  md.push(
    `| \`${area}\` | ${s.files} | ${s.total} | ${pct(s.bunHit, s.total)} | ${pct(s.e2eHit, s.total)} | ${pct(s.mergedHit, s.total)} |`,
  )
}
md.push('')

const list = (heading: string, pick: (f: FileCoverage) => boolean) => {
  const picked = [...files.values()]
    .filter(pick)
    .sort((a, b) => b.total - a.total || a.file.localeCompare(b.file))
  md.push(`<details><summary>${heading} (${picked.length})</summary>`, '')
  md.push('| File | Lines | Unit | Browser | Merged |')
  md.push('| --- | ---: | ---: | ---: | ---: |')
  for (const f of picked) {
    md.push(
      `| \`${f.file}\`${f.loaded ? '' : ' (not loaded, size est.)'} | ${f.total} | ${pct(f.bunHit, f.total)} | ${pct(f.e2eHit, f.total)} | ${pct(f.mergedHit, f.total)} |`,
    )
  }
  md.push('', '</details>', '')
}
list(
  'Files covered only by the browser suite',
  (f) => f.e2eHit > 0 && f.bunHit === 0,
)
list(
  'Files covered only by the unit suite',
  (f) => f.bunHit > 0 && f.e2eHit === 0,
)
list('Files neither suite covers', (f) => f.mergedHit === 0 && f.total > 0)

// Where each suite adds the most lines the other misses.
const gains = (heading: string, gain: (f: FileCoverage) => number) => {
  const top = [...files.values()]
    .filter((f) => gain(f) > 0)
    .sort((a, b) => gain(b) - gain(a))
    .slice(0, 25)
  md.push(`<details><summary>${heading} (top ${top.length})</summary>`, '')
  md.push('| File | Lines added | Lines | Unit | Browser | Merged |')
  md.push('| --- | ---: | ---: | ---: | ---: | ---: |')
  for (const f of top) {
    md.push(
      `| \`${f.file}\` | ${gain(f)} | ${f.total} | ${pct(f.bunHit, f.total)} | ${pct(f.e2eHit, f.total)} | ${pct(f.mergedHit, f.total)} |`,
    )
  }
  md.push('', '</details>', '')
}
gains('Lines only the browser suite covers', (f) => f.mergedHit - f.bunHit)
gains('Lines only the unit suite covers', (f) => f.mergedHit - f.e2eHit)

const output = `${md.join('\n')}\n`
const summaryPath = process.env.GITHUB_STEP_SUMMARY
if (summaryPath) appendFileSync(summaryPath, output)
else await Bun.write(Bun.stdout, output)
