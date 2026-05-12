/**
 * Build a self-contained HTML performance report from one or more
 * benchmark JSON files (schema `niivue-benchmark-v1`).
 *
 * Usage:
 *   bun run bench/build-report.ts <out.html> <input.json> [input.json ...]
 *
 * Each input is treated as one backend run. The report stacks the runs
 * side by side and computes ratios where two runs are present (the slower
 * backend's mean divided by the faster backend's mean).
 */

import { readFile, writeFile } from 'node:fs/promises'
import { basename } from 'node:path'

type Stats = {
  mean: number
  median?: number
  stddev: number
  min?: number
  max?: number
  p95: number
  p99?: number
  count?: number
}

type RendererRow = {
  name: string
  frames: number
  stats: Stats
  cpu: Stats | null
  submit: Stats | null
  frame: Stats | null
  gpu: Stats | null
}

type ComputeRow = {
  name: string
  category?: string
  dataSize?: number
  iterations?: number
  stats: Stats
}

type Env = {
  timestamp: string
  userAgent?: string
  platform?: string
  hardwareConcurrency?: number
  paced?: boolean
  backend?: string
  requestedBackend?: string
  label?: string
  gpu?: {
    vendor?: string
    architecture?: string
    device?: string
    description?: string
    error?: string
  }
  webgl?: {
    vendor?: string
    renderer?: string
    version?: string
    error?: string
  }
}

type BenchJson = {
  schema?: string
  timestamp?: string
  env: Env
  renderer?: RendererRow[]
  compute?: ComputeRow[]
}

type Run = {
  source: string
  backend: string
  json: BenchJson
}

const [, , outPath, ...inputs] = process.argv
if (!outPath || inputs.length === 0) {
  console.error(
    'usage: bun run bench/build-report.ts <out.html> <input.json> [input.json ...]',
  )
  process.exit(2)
}

const runs: Run[] = []
for (const path of inputs) {
  const text = await readFile(path, 'utf8')
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    console.error(
      `[report] ${path} is not valid JSON: ${(err as Error).message}`,
    )
    process.exit(1)
  }
  if (!parsed || typeof parsed !== 'object') {
    console.error(`[report] ${path} did not decode to an object`)
    process.exit(1)
  }
  const json = parsed as Partial<BenchJson> & { reason?: string }
  if (json.reason && !json.schema) {
    console.warn(
      `[report] skipping ${path}: ${json.reason} (sentinel, no bench data)`,
    )
    continue
  }
  if (!json.env) {
    console.error(`[report] ${path} has no \`env\` block`)
    process.exit(1)
  }
  const backend = json.env.backend || json.env.requestedBackend || 'unknown'
  runs.push({
    source: basename(path),
    backend,
    json: json as BenchJson,
  })
}

if (runs.length === 0) {
  console.error('[report] no runs to report on')
  process.exit(1)
}

const html = buildHtml(runs)
await writeFile(outPath, html, 'utf8')
console.log(
  `[report] wrote ${html.length.toLocaleString()} bytes (${runs.length} run${runs.length === 1 ? '' : 's'}) to ${outPath}`,
)

function fmt(v: number | null | undefined, digits = 3): string {
  if (v == null || !Number.isFinite(v)) return '—'
  return v.toFixed(digits)
}

function fps(meanMs: number | null | undefined): string {
  if (meanMs == null || !Number.isFinite(meanMs) || meanMs <= 0) return '—'
  return (1000 / meanMs).toFixed(1)
}

function ratio(slowMs: number, fastMs: number): string {
  if (!Number.isFinite(slowMs) || !Number.isFinite(fastMs) || fastMs <= 0)
    return '—'
  return `${(slowMs / fastMs).toFixed(2)}×`
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function backendPretty(b: string): string {
  if (b === 'webgpu') return 'WebGPU'
  if (b === 'webgl2') return 'WebGL2'
  return b
}

function gpuDesc(env: Env): string {
  const g = env.gpu
  if (!g) return 'n/a'
  if (g.error) return `error: ${g.error}`
  if (g.description) return g.description
  return (
    [g.vendor, g.architecture, g.device].filter(Boolean).join(' / ') || 'n/a'
  )
}

function webglDesc(env: Env): string {
  const w = env.webgl
  if (!w) return 'n/a'
  if (w.error) return `error: ${w.error}`
  return [w.vendor, w.renderer].filter(Boolean).join(' / ') || 'n/a'
}

function rendererScenarioNames(runs: Run[]): string[] {
  const seen = new Set<string>()
  const order: string[] = []
  for (const r of runs) {
    for (const row of r.json.renderer ?? []) {
      if (!seen.has(row.name)) {
        seen.add(row.name)
        order.push(row.name)
      }
    }
  }
  return order
}

function computeScenarioNames(runs: Run[]): string[] {
  const seen = new Set<string>()
  const order: string[] = []
  for (const r of runs) {
    for (const row of r.json.compute ?? []) {
      if (!seen.has(row.name)) {
        seen.add(row.name)
        order.push(row.name)
      }
    }
  }
  return order
}

function findRenderer(run: Run, name: string): RendererRow | undefined {
  return run.json.renderer?.find((r) => r.name === name)
}

function findCompute(run: Run, name: string): ComputeRow | undefined {
  return run.json.compute?.find((r) => r.name === name)
}

function renderRendererSection(runs: Run[]): string {
  const names = rendererScenarioNames(runs)
  if (names.length === 0) return ''
  const headerCells: string[] = ['<th rowspan="2">Scenario</th>']
  for (const r of runs) {
    headerCells.push(
      `<th colspan="5" class="group">${escapeHtml(backendPretty(r.backend))}</th>`,
    )
  }
  if (runs.length === 2) {
    headerCells.push('<th rowspan="2">Wall ratio</th>')
    headerCells.push('<th rowspan="2">GPU ratio</th>')
  }
  const subHeaderCells: string[] = []
  for (const _ of runs) {
    subHeaderCells.push(
      '<th>Wall</th><th>~fps</th><th>CPU</th><th>Frame</th><th>GPU</th>',
    )
  }
  const bodyRows: string[] = []
  for (const name of names) {
    const cells: string[] = [`<td class="left">${escapeHtml(name)}</td>`]
    const wallMeans: number[] = []
    const gpuMeans: number[] = []
    for (const r of runs) {
      const row = findRenderer(r, name)
      if (!row) {
        cells.push('<td>—</td><td>—</td><td>—</td><td>—</td><td>—</td>')
        wallMeans.push(NaN)
        gpuMeans.push(NaN)
        continue
      }
      const wall = row.stats.mean
      const cpuM = row.cpu?.mean
      const frmM = row.frame?.mean
      const gpuM = row.gpu?.mean
      wallMeans.push(wall)
      gpuMeans.push(gpuM ?? NaN)
      cells.push(
        `<td>${fmt(wall)}</td>` +
          `<td>${fps(wall)}</td>` +
          `<td>${fmt(cpuM)}</td>` +
          `<td>${fmt(frmM)}</td>` +
          `<td>${fmt(gpuM)}</td>`,
      )
    }
    if (runs.length === 2) {
      const [a, b] = wallMeans
      const [ga, gb] = gpuMeans
      cells.push(
        `<td class="ratio">${
          Number.isFinite(a) && Number.isFinite(b)
            ? ratio(Math.max(a, b), Math.min(a, b))
            : '—'
        }</td>`,
      )
      cells.push(
        `<td class="ratio">${
          Number.isFinite(ga) && Number.isFinite(gb)
            ? ratio(Math.max(ga, gb), Math.min(ga, gb))
            : '—'
        }</td>`,
      )
    }
    bodyRows.push(`<tr>${cells.join('')}</tr>`)
  }
  return `<h2>Renderer scenarios</h2>
<table>
  <thead>
    <tr>${headerCells.join('')}</tr>
    <tr>${subHeaderCells.join('')}</tr>
  </thead>
  <tbody>
    ${bodyRows.join('\n    ')}
  </tbody>
</table>
<p class="caption">All times in ms unless noted. Wall = end-to-end render
including GPU pacing (WebGPU: <code>onSubmittedWorkDone</code>; WebGL2: no
sync — wall reflects CPU submit only). GPU column uses
<code>EXT_disjoint_timer_query_webgl2</code> on WebGL2 and is left blank
when the extension isn't exposed (e.g. SwiftShader). Ratios are
slower/faster, so the larger number sets the numerator.</p>`
}

function renderComputeSection(runs: Run[]): string {
  const names = computeScenarioNames(runs)
  if (names.length === 0) return ''
  const headerCells: string[] = ['<th rowspan="2">Scenario</th>']
  for (const r of runs) {
    headerCells.push(
      `<th colspan="3" class="group">${escapeHtml(backendPretty(r.backend))}</th>`,
    )
  }
  if (runs.length === 2) headerCells.push('<th rowspan="2">Ratio</th>')
  const subHeaderCells: string[] = []
  for (const _ of runs) {
    subHeaderCells.push('<th>Mean</th><th>p95</th><th>Stddev</th>')
  }
  const bodyRows: string[] = []
  for (const name of names) {
    const cells: string[] = [`<td class="left">${escapeHtml(name)}</td>`]
    const means: number[] = []
    for (const r of runs) {
      const row = findCompute(r, name)
      if (!row) {
        cells.push('<td>—</td><td>—</td><td>—</td>')
        means.push(NaN)
        continue
      }
      means.push(row.stats.mean)
      cells.push(
        `<td>${fmt(row.stats.mean)}</td>` +
          `<td>${fmt(row.stats.p95)}</td>` +
          `<td>${fmt(row.stats.stddev)}</td>`,
      )
    }
    if (runs.length === 2) {
      const [a, b] = means
      cells.push(
        `<td class="ratio">${
          Number.isFinite(a) && Number.isFinite(b)
            ? ratio(Math.max(a, b), Math.min(a, b))
            : '—'
        }</td>`,
      )
    }
    bodyRows.push(`<tr>${cells.join('')}</tr>`)
  }
  return `<h2>Compute scenarios</h2>
<table>
  <thead>
    <tr>${headerCells.join('')}</tr>
    <tr>${subHeaderCells.join('')}</tr>
  </thead>
  <tbody>
    ${bodyRows.join('\n    ')}
  </tbody>
</table>`
}

function renderEnvSection(runs: Run[]): string {
  const head = runs[0].json.env
  const headers = ['<th>Field</th>']
  for (const r of runs) {
    headers.push(`<th>${escapeHtml(backendPretty(r.backend))}</th>`)
  }
  const rows: Array<[string, (r: Run) => string]> = [
    ['Backend', (r) => escapeHtml(backendPretty(r.json.env.backend ?? '?'))],
    ['Paced', (r) => (r.json.env.paced ? 'yes' : 'no')],
    [
      'Requested',
      (r) =>
        r.json.env.requestedBackend
          ? escapeHtml(r.json.env.requestedBackend)
          : '—',
    ],
    ['WebGPU adapter', (r) => escapeHtml(gpuDesc(r.json.env))],
    ['WebGL renderer', (r) => escapeHtml(webglDesc(r.json.env))],
    ['Source file', (r) => `<code>${escapeHtml(r.source)}</code>`],
    ['Timestamp', (r) => escapeHtml(r.json.env.timestamp)],
  ]
  const body = rows
    .map(([label, fn]) => {
      const cells = runs.map((r) => `<td class="left">${fn(r)}</td>`)
      return `<tr><th class="left">${label}</th>${cells.join('')}</tr>`
    })
    .join('\n    ')
  return `<h2>Environment</h2>
<table class="env">
  <thead>
    <tr>${headers.join('')}</tr>
  </thead>
  <tbody>
    ${body}
  </tbody>
</table>
<p class="caption">Shared run info — Platform: ${escapeHtml(head.platform ?? 'unknown')},
  Cores: ${head.hardwareConcurrency ?? 'unknown'},
  UA: <code>${escapeHtml(head.userAgent ?? 'unknown')}</code></p>`
}

function buildHtml(runs: Run[]): string {
  const title = `NiiVue performance report — ${runs.map((r) => backendPretty(r.backend)).join(' vs ')}`
  const env = renderEnvSection(runs)
  const renderer = renderRendererSection(runs)
  const compute = renderComputeSection(runs)
  const generated = new Date().toISOString()
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>${escapeHtml(title)}</title>
<style>
  body {
    font-family: -apple-system, system-ui, sans-serif;
    margin: 0;
    padding: 24px;
    max-width: 1200px;
    background: #0d1117;
    color: #c9d1d9;
  }
  h1 { font-size: 20px; margin: 0 0 4px; }
  h2 { font-size: 16px; margin: 24px 0 8px; color: #c9d1d9; }
  .subtitle { color: #8b949e; font-size: 12px; margin-bottom: 24px; }
  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 12px;
    font-variant-numeric: tabular-nums;
    margin-bottom: 8px;
  }
  th, td {
    padding: 6px 10px;
    border-bottom: 1px solid #30363d;
    text-align: right;
  }
  th { background: #161b22; font-weight: 600; color: #c9d1d9; }
  th.group { background: #1f2933; }
  th.left, td.left { text-align: left; }
  td.ratio { font-weight: 600; color: #f0883e; }
  .caption {
    font-size: 11px;
    color: #8b949e;
    margin: 4px 0 16px;
    line-height: 1.5;
  }
  table.env th { width: 160px; }
  table.env td { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  code {
    background: #161b22;
    padding: 1px 4px;
    border-radius: 3px;
    font-size: 11px;
  }
  footer {
    margin-top: 32px;
    padding-top: 12px;
    border-top: 1px solid #30363d;
    color: #8b949e;
    font-size: 11px;
  }
</style>
</head>
<body>
<h1>${escapeHtml(title)}</h1>
<p class="subtitle">Generated ${escapeHtml(generated)} from
  ${runs.map((r) => `<code>${escapeHtml(r.source)}</code>`).join(', ')}.</p>
${env}
${renderer}
${compute}
<footer>
  Schema <code>niivue-benchmark-v1</code> &middot; report built by
  <code>bench/build-report.ts</code>
</footer>
</body>
</html>
`
}
