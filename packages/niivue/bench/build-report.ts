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

/**
 * Per-backend GPU time accounting:
 *
 * - WebGPU: `_waitGpu` awaits `device.queue.onSubmittedWorkDone()`, so
 *   `wall` includes GPU execution. The `frame` perf mark is the JS work
 *   to issue commands. `wall − frame` therefore approximates GPU time.
 *   WebGPU does *not* populate the per-frame `gpu` array — there is no
 *   timestamp-query path on the bench side.
 *
 * - WebGL2: there is no analogous fence (Chromium's `clientWaitSync` has
 *   a ~10ms IPC floor; see `examples/benchmark.js`). `_waitGpu` is a
 *   no-op, so `wall ≈ frame` (CPU submit only). GPU time is read from
 *   the `gpu` array, populated by `EXT_disjoint_timer_query_webgl2`
 *   when the extension is exposed (true on real GPUs; false on
 *   headless SwiftShader, in which case the column reads `—`).
 */
function gpuMeanForRun(row: RendererRow, backend: string): number | null {
  if (backend === 'webgpu') {
    const wall = row.stats?.mean
    const frame = row.frame?.mean
    if (
      typeof wall === 'number' &&
      typeof frame === 'number' &&
      Number.isFinite(wall) &&
      Number.isFinite(frame)
    ) {
      return Math.max(0, wall - frame)
    }
    return null
  }
  return row.gpu?.mean ?? null
}

function gpuLabel(backend: string): string {
  return backend === 'webgpu' ? 'GPU est. (wall−frame)' : 'GPU (timer)'
}

/**
 * Effective per-frame time for WebGL2: CPU and GPU run concurrently on
 * the host, so steady-state frame rate is governed by whichever side is
 * slower. Returns null when GPU timer data is missing — in that case we
 * can't honestly compute fps (a `frame`-only number would overstate it
 * by ignoring the GPU side).
 */
function effectiveMsWebGl2(row: RendererRow): number | null {
  const frame = row.frame?.mean
  const gpu = row.gpu?.mean
  if (typeof frame !== 'number' || !Number.isFinite(frame)) return null
  if (typeof gpu !== 'number' || !Number.isFinite(gpu)) return null
  return Math.max(frame, gpu)
}

function renderBackendTable(run: Run): string {
  const isWebGpu = run.backend === 'webgpu'
  const rows = run.json.renderer ?? []
  if (rows.length === 0) return ''
  const headers = isWebGpu
    ? [
        'Scenario',
        'Frames',
        'Wall (CPU+GPU)',
        '~fps',
        'CPU',
        'Submit',
        'Frame',
        gpuLabel(run.backend),
        'p95',
        'Stddev',
      ]
    : [
        'Scenario',
        'Frames',
        'CPU',
        'Submit',
        'Frame',
        gpuLabel(run.backend),
        'Effective',
        '~fps',
        'p95',
        'Stddev',
      ]
  const headerHtml = headers
    .map((h, i) => `<th${i === 0 ? ' class="left"' : ''}>${escapeHtml(h)}</th>`)
    .join('')
  const bodyRows: string[] = []
  for (const row of rows) {
    const wall = row.stats.mean
    const cpuM = row.cpu?.mean
    const subM = row.submit?.mean
    const frmM = row.frame?.mean
    const gpuM = gpuMeanForRun(row, run.backend)
    const baseCells = isWebGpu
      ? [
          `<td>${fmt(wall)}</td>`,
          `<td>${fps(wall)}</td>`,
          `<td>${fmt(cpuM)}</td>`,
          `<td>${fmt(subM)}</td>`,
          `<td>${fmt(frmM)}</td>`,
          `<td>${fmt(gpuM)}</td>`,
        ]
      : (() => {
          const eff = effectiveMsWebGl2(row)
          return [
            `<td>${fmt(cpuM)}</td>`,
            `<td>${fmt(subM)}</td>`,
            `<td>${fmt(frmM)}</td>`,
            `<td>${fmt(gpuM)}</td>`,
            `<td>${fmt(eff)}</td>`,
            `<td>${fps(eff)}</td>`,
          ]
        })()
    bodyRows.push(
      `<tr><td class="left">${escapeHtml(row.name)}</td>` +
        `<td>${row.frames}</td>` +
        baseCells.join('') +
        `<td>${fmt(row.stats.p95)}</td>` +
        `<td>${fmt(row.stats.stddev)}</td></tr>`,
    )
  }
  const caption = isWebGpu
    ? `<code>Wall</code> includes GPU pacing via <code>onSubmittedWorkDone</code>.
       <code>GPU est.</code> is <code>wall − frame</code> (no
       per-frame timestamp queries on the WebGPU bench path).`
    : `WebGL2 has no cheap GPU fence in Chromium, so we measure CPU work
       (perf marks) and GPU work (<code>EXT_disjoint_timer_query_webgl2</code>)
       separately. <code>Effective</code> is <code>max(frame, GPU)</code>
       — the steady-state per-frame cost on a pipelined GPU, since CPU
       submit and GPU execution overlap. <code>~fps</code> is
       <code>1000 / Effective</code>. Both stay blank when the timer-query
       extension is unavailable (e.g. SwiftShader headless) because we
       can't honestly report fps from CPU work alone.`
  return `<h2>${escapeHtml(backendPretty(run.backend))} scenarios</h2>
<table>
  <thead>
    <tr>${headerHtml}</tr>
  </thead>
  <tbody>
    ${bodyRows.join('\n    ')}
  </tbody>
</table>
<p class="caption">${caption}</p>`
}

/**
 * Per-backend frame time used as the basis for fps.
 *   - WebGPU: paced `wall` (CPU + GPU serial via onSubmittedWorkDone).
 *   - WebGL2: `max(frame, GPU)` because CPU submit and GPU execution
 *     overlap on real hardware. Null when GPU timer data is missing.
 *
 * These are not the same measurement technique (WebGPU is wall-clock
 * with a fence, WebGL2 is reconstructed from two parallel measurements),
 * but they're the most honest approximation of "what fps would a user
 * see in this scene" we can produce without a frame-pacing harness on
 * top of rAF.
 */
function frameMsForFps(row: RendererRow, backend: string): number | null {
  if (backend === 'webgpu') {
    return Number.isFinite(row.stats.mean) ? row.stats.mean : null
  }
  return effectiveMsWebGl2(row)
}

function renderFpsHeadToHead(runs: Run[]): string {
  if (runs.length !== 2) return ''
  const names = rendererScenarioNames(runs)
  if (names.length === 0) return ''
  const [a, b] = runs
  const aName = escapeHtml(backendPretty(a.backend))
  const bName = escapeHtml(backendPretty(b.backend))
  const headerCells = [
    '<th class="left" rowspan="2">Scenario</th>',
    `<th colspan="2" class="group">${aName}</th>`,
    `<th colspan="2" class="group">${bName}</th>`,
    '<th rowspan="2">Winner</th>',
    '<th rowspan="2">Speedup</th>',
  ]
  const subHeaderCells = [
    '<th>fps</th>',
    '<th>frame (ms)</th>',
    '<th>fps</th>',
    '<th>frame (ms)</th>',
  ]
  const bodyRows: string[] = []
  for (const name of names) {
    const rowA = findRenderer(a, name)
    const rowB = findRenderer(b, name)
    const msA = rowA ? frameMsForFps(rowA, a.backend) : null
    const msB = rowB ? frameMsForFps(rowB, b.backend) : null
    const fpsA = msA != null && msA > 0 ? 1000 / msA : null
    const fpsB = msB != null && msB > 0 ? 1000 / msB : null
    let winner = '—'
    let speedup = '—'
    if (fpsA != null && fpsB != null && msA != null && msB != null) {
      if (msA < msB) {
        winner = aName
        speedup = ratio(msB, msA)
      } else if (msB < msA) {
        winner = bName
        speedup = ratio(msA, msB)
      } else {
        winner = 'tie'
        speedup = '1.00×'
      }
    }
    bodyRows.push(
      `<tr><td class="left">${escapeHtml(name)}</td>` +
        `<td>${fpsA == null ? '—' : fpsA.toFixed(1)}</td>` +
        `<td>${fmt(msA)}</td>` +
        `<td>${fpsB == null ? '—' : fpsB.toFixed(1)}</td>` +
        `<td>${fmt(msB)}</td>` +
        `<td>${winner}</td>` +
        `<td class="ratio">${speedup}</td></tr>`,
    )
  }
  return `<h2>fps head-to-head</h2>
<table>
  <thead>
    <tr>${headerCells.join('')}</tr>
    <tr>${subHeaderCells.join('')}</tr>
  </thead>
  <tbody>
    ${bodyRows.join('\n    ')}
  </tbody>
</table>
<p class="caption">fps comes from a backend-appropriate frame time:
WebGPU uses paced <code>wall</code> (CPU+GPU serial via
<code>onSubmittedWorkDone</code>); WebGL2 uses
<code>max(frame, GPU timer)</code> because CPU submit and GPU execution
overlap on real hardware. Rows show <code>—</code> when WebGL2 timer-query
data is unavailable (e.g. SwiftShader headless). Speedup = slower frame
time ÷ faster frame time.</p>`
}

function renderComparisonSection(runs: Run[]): string {
  if (runs.length !== 2) return ''
  const names = rendererScenarioNames(runs)
  if (names.length === 0) return ''
  const [a, b] = runs
  const aName = escapeHtml(backendPretty(a.backend))
  const bName = escapeHtml(backendPretty(b.backend))
  const headerCells = [
    '<th class="left" rowspan="2">Scenario</th>',
    `<th colspan="3" class="group">CPU (frame, ms)</th>`,
    `<th colspan="3" class="group">GPU (ms)</th>`,
  ]
  const subHeaderCells = [
    `<th>${aName}</th>`,
    `<th>${bName}</th>`,
    '<th>Ratio</th>',
    `<th>${aName}</th>`,
    `<th>${bName}</th>`,
    '<th>Ratio</th>',
  ]
  const bodyRows: string[] = []
  for (const name of names) {
    const rowA = findRenderer(a, name)
    const rowB = findRenderer(b, name)
    const cpuA = rowA?.frame?.mean ?? NaN
    const cpuB = rowB?.frame?.mean ?? NaN
    const gpuA = rowA ? (gpuMeanForRun(rowA, a.backend) ?? NaN) : NaN
    const gpuB = rowB ? (gpuMeanForRun(rowB, b.backend) ?? NaN) : NaN
    const cpuRatio =
      Number.isFinite(cpuA) && Number.isFinite(cpuB)
        ? ratio(Math.max(cpuA, cpuB), Math.min(cpuA, cpuB))
        : '—'
    const gpuRatio =
      Number.isFinite(gpuA) && Number.isFinite(gpuB)
        ? ratio(Math.max(gpuA, gpuB), Math.min(gpuA, gpuB))
        : '—'
    bodyRows.push(
      `<tr><td class="left">${escapeHtml(name)}</td>` +
        `<td>${fmt(cpuA)}</td>` +
        `<td>${fmt(cpuB)}</td>` +
        `<td class="ratio">${cpuRatio}</td>` +
        `<td>${fmt(gpuA)}</td>` +
        `<td>${fmt(gpuB)}</td>` +
        `<td class="ratio">${gpuRatio}</td></tr>`,
    )
  }
  return `<h2>Apples-to-apples comparison</h2>
<table>
  <thead>
    <tr>${headerCells.join('')}</tr>
    <tr>${subHeaderCells.join('')}</tr>
  </thead>
  <tbody>
    ${bodyRows.join('\n    ')}
  </tbody>
</table>
<p class="caption">CPU = the <code>niivue:render-frame</code> perf mark
(pure JS, no GPU sync) — directly comparable across backends. GPU =
<code>wall − frame</code> for WebGPU (paced), and
<code>EXT_disjoint_timer_query_webgl2</code> for WebGL2. Both are real
device time, modulo measurement technique. Ratios are slower / faster.</p>`
}

function renderRendererSection(runs: Run[]): string {
  const tables = runs
    .map((r) => renderBackendTable(r))
    .filter((s) => s.length > 0)
  if (tables.length === 0) return ''
  return [
    renderFpsHeadToHead(runs),
    tables.join('\n'),
    renderComparisonSection(runs),
  ]
    .filter((s) => s.length > 0)
    .join('\n')
}

function isSwiftShader(run: Run): boolean {
  const blobs = [
    run.json.env.gpu?.description,
    run.json.env.gpu?.vendor,
    run.json.env.gpu?.device,
    run.json.env.webgl?.renderer,
    run.json.env.webgl?.vendor,
  ]
    .filter((s): s is string => typeof s === 'string')
    .join(' ')
    .toLowerCase()
  return blobs.includes('swiftshader')
}

function renderEnvWarning(runs: Run[]): string {
  const swiftRuns = runs.filter(isSwiftShader)
  if (swiftRuns.length === 0) return ''
  const labels = swiftRuns.map((r) => backendPretty(r.backend)).join(', ')
  return `<div class="warning">
  <strong>SwiftShader detected</strong> on ${escapeHtml(labels)} — these
  runs are software-rasterised, so absolute numbers are not representative
  of real-GPU performance. Re-run with <code>BENCH_HEADED=1</code> to use
  the host GPU (Metal on macOS, Vulkan on Linux/Windows).
</div>`
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
  const warning = renderEnvWarning(runs)
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
  .warning {
    margin: 16px 0;
    padding: 10px 14px;
    background: #3a2308;
    border: 1px solid #9e6a03;
    border-radius: 6px;
    color: #f0883e;
    font-size: 13px;
    line-height: 1.5;
  }
  .warning strong { color: #f0883e; }
</style>
</head>
<body>
<h1>${escapeHtml(title)}</h1>
<p class="subtitle">Generated ${escapeHtml(generated)} from
  ${runs.map((r) => `<code>${escapeHtml(r.source)}</code>`).join(', ')}.</p>
${warning}
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
