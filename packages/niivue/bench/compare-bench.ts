/**
 * Compare two niivue-benchmark-v1 JSON files.
 *
 * Usage: bun run bench/compare-bench.ts <base.json> <head.json> [flags]
 *
 *   --warn-pct=<n>   Mark scenarios as WARN when head is >n% slower (default 10).
 *   --fail-pct=<n>   Exit non-zero when head is >n% slower (default 25).
 *   --noise-ms=<n>   Sub-clock-resolution floor in ms (default 0.5). Scenarios
 *                    where both base and head are below this are forced to OK
 *                    so 0.1->0.2ms doesn't read as +100%.
 *   --out=<path>     Also write the markdown report to <path>.
 *
 * Compares wall-time median (`stats.median`) for each renderer and compute
 * scenario matched by name. Scenarios that exist in only one side are
 * reported as MISSING and ignored for the pass/fail gate.
 */

import { readFile, writeFile } from 'node:fs/promises'

interface Stats {
  median: number
}
interface Scenario {
  name: string
  stats?: Stats
}
interface BenchJson {
  schema?: string
  env?: { gpu?: { vendor?: string; architecture?: string } }
  renderer?: Scenario[]
  compute?: Scenario[]
}

function parseFlag(name: string, fallback: number): number {
  const arg = process.argv.find((a) => a.startsWith(`--${name}=`))
  if (!arg) return fallback
  const v = Number(arg.split('=')[1])
  if (!Number.isFinite(v)) {
    console.error(`bad value for --${name}`)
    process.exit(2)
  }
  return v
}

function parseStrFlag(name: string): string | null {
  const arg = process.argv.find((a) => a.startsWith(`--${name}=`))
  return arg ? (arg.split('=')[1] ?? null) : null
}

const positional = process.argv.slice(2).filter((a) => !a.startsWith('--'))
const [basePath, headPath] = positional
if (!basePath || !headPath) {
  console.error(
    'usage: bun run compare-bench <base.json> <head.json> [--warn-pct=N] [--fail-pct=N] [--out=PATH]',
  )
  process.exit(2)
}

const warnPct = parseFlag('warn-pct', 10)
const failPct = parseFlag('fail-pct', 25)
const noiseMs = parseFlag('noise-ms', 0.5)
const outPath = parseStrFlag('out')

const base: BenchJson = JSON.parse(await readFile(basePath, 'utf8'))
const head: BenchJson = JSON.parse(await readFile(headPath, 'utf8'))

// Either side may be a sentinel:
//   * base: main predates the perf gate (bootstrap case).
//   * head: bench failed in the CI environment (SwiftShader bug etc.).
// In both cases, post an advisory comment and exit cleanly so the PR
// isn't blocked by infrastructure issues unrelated to the change itself.
const SCHEMA = 'niivue-benchmark-v1'
const baseMissing = base.schema !== SCHEMA
const headMissing = head.schema !== SCHEMA

if (baseMissing || headMissing) {
  const usable = baseMissing ? head : base
  const usableLabel = baseMissing ? 'Head' : 'Base'
  const reasonLines: string[] = []
  if (headMissing && baseMissing) {
    reasonLines.push(
      'Both bench runs failed to produce numbers in CI — usually a ' +
        'SwiftShader/WebGPU environment issue rather than a PR-specific ' +
        'regression. Skipping comparison.',
    )
  } else if (headMissing) {
    reasonLines.push(
      'The PR-side bench failed to produce numbers in CI — usually a ' +
        'SwiftShader/WebGPU environment issue rather than a PR-specific ' +
        'regression. Reporting base (`main`) numbers only.',
    )
    reasonLines.push(
      `Reason recorded: \`${(head as { reason?: string }).reason ?? 'unknown'}\``,
    )
  } else {
    reasonLines.push(
      'No baseline available on `main` yet — looks like this is the first ' +
        'PR after the perf gate landed (or `main` is missing the bench ' +
        'infrastructure). Reporting head numbers only; future PRs will get ' +
        'a real comparison once this lands.',
    )
  }

  const rows: string[] = [`| Scenario | ${usableLabel} (ms) |`, '|---|---:|']
  if (!(headMissing && baseMissing)) {
    for (const s of [...(usable.renderer ?? []), ...(usable.compute ?? [])]) {
      const m = s.stats?.median
      rows.push(`| ${s.name} | ${m == null ? '—' : m.toFixed(3)} |`)
    }
  }

  const usableGpu = usable.env?.gpu
  const md = [
    '## NiiVue Benchmark Comparison',
    '',
    ...reasonLines,
    '',
    headMissing && baseMissing
      ? ''
      : `${usableLabel} GPU: \`${usableGpu?.vendor ?? '?'} / ${usableGpu?.architecture ?? '?'}\``,
    '',
    headMissing && baseMissing ? '' : `### ${usableLabel} scenarios`,
    '',
    ...(headMissing && baseMissing ? [] : rows),
    '',
  ].join('\n')
  console.log(md)
  if (outPath) await writeFile(outPath, md, 'utf8')
  process.exit(0)
}

type Status = 'OK' | 'WARN' | 'FAIL' | 'FASTER' | 'MISSING'
interface Row {
  name: string
  base: number | null
  head: number | null
  pct: number | null
  status: Status
}

function compareGroup(
  baseList: Scenario[] | undefined,
  headList: Scenario[] | undefined,
): Row[] {
  const baseMap = new Map((baseList ?? []).map((s) => [s.name, s]))
  const headMap = new Map((headList ?? []).map((s) => [s.name, s]))
  const names = new Set([...baseMap.keys(), ...headMap.keys()])
  const rows: Row[] = []
  for (const name of names) {
    const b = baseMap.get(name)?.stats?.median ?? null
    const h = headMap.get(name)?.stats?.median ?? null
    if (b == null || h == null) {
      rows.push({ name, base: b, head: h, pct: null, status: 'MISSING' })
      continue
    }
    if (b === 0) {
      rows.push({
        name,
        base: b,
        head: h,
        pct: null,
        status: h === 0 ? 'OK' : 'WARN',
      })
      continue
    }
    const pct = ((h - b) / b) * 100
    let status: Status = 'OK'
    // Below the noise floor a 0.1->0.2ms swing reads as +100% but means
    // nothing — clock resolution dominates. Classify as OK in that case
    // but still display the percent so it's auditable.
    const belowNoise = b < noiseMs && h < noiseMs
    if (!belowNoise) {
      if (pct >= failPct) status = 'FAIL'
      else if (pct >= warnPct) status = 'WARN'
      else if (pct <= -warnPct) status = 'FASTER'
    }
    rows.push({ name, base: b, head: h, pct, status })
  }
  rows.sort((a, b) => a.name.localeCompare(b.name))
  return rows
}

const rendererRows = compareGroup(base.renderer, head.renderer)
const computeRows = compareGroup(base.compute, head.compute)

function fmtMs(v: number | null): string {
  return v == null ? '—' : v.toFixed(3)
}
function fmtPct(v: number | null): string {
  if (v == null) return '—'
  const sign = v > 0 ? '+' : ''
  return `${sign}${v.toFixed(1)}%`
}

function renderTable(title: string, rows: Row[]): string {
  if (rows.length === 0) return ''
  const lines: string[] = [
    `### ${title}`,
    '',
    '| Scenario | Base (ms) | Head (ms) | Δ | Status |',
    '|---|---:|---:|---:|---|',
  ]
  for (const r of rows) {
    lines.push(
      `| ${r.name} | ${fmtMs(r.base)} | ${fmtMs(r.head)} | ${fmtPct(r.pct)} | ${r.status} |`,
    )
  }
  lines.push('')
  return lines.join('\n')
}

const allRows = [...rendererRows, ...computeRows]
const counts = {
  OK: 0,
  WARN: 0,
  FAIL: 0,
  FASTER: 0,
  MISSING: 0,
} as Record<Status, number>
for (const r of allRows) counts[r.status]++

const baseGpu = base.env?.gpu
const headGpu = head.env?.gpu

const md = [
  '## NiiVue Benchmark Comparison',
  '',
  `Threshold: warn ≥${warnPct}% slower, fail ≥${failPct}% slower, ` +
    `noise floor ${noiseMs}ms. Comparing wall-time median (\`stats.median\`).`,
  '',
  `Base GPU: \`${baseGpu?.vendor ?? '?'} / ${baseGpu?.architecture ?? '?'}\``,
  `Head GPU: \`${headGpu?.vendor ?? '?'} / ${headGpu?.architecture ?? '?'}\``,
  '',
  `**Summary**: ${counts.FAIL} FAIL · ${counts.WARN} WARN · ${counts.FASTER} FASTER · ${counts.OK} OK · ${counts.MISSING} MISSING`,
  '',
  renderTable('Renderer scenarios', rendererRows),
  renderTable('Compute scenarios', computeRows),
].join('\n')

console.log(md)
if (outPath) await writeFile(outPath, md, 'utf8')

process.exit(counts.FAIL > 0 ? 1 : 0)
