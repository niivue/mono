#!/usr/bin/env node
/**
 * Compare two benchmark JSON runs and emit a markdown diff table.
 *
 * Usage:
 *   node benchmarks/diff-runs.mjs <baseline.json> <candidate.json>
 *
 * Matches scenarios by name (renderer), name+dataSize (compute), tile count
 * (tile sweep), and verts-per-mesh+mesh-count (mesh sweep). Columns: baseline
 * mean, candidate mean, delta %, and a "winner" label (5% tie threshold).
 */
import { readFileSync } from 'node:fs'

function die(msg) {
  console.error(msg)
  process.exit(1)
}

const [a, b] = process.argv.slice(2)
if (!a || !b) die('Usage: node benchmarks/diff-runs.mjs <baseline.json> <candidate.json>')

const baseline = JSON.parse(readFileSync(a, 'utf-8'))
const candidate = JSON.parse(readFileSync(b, 'utf-8'))

if (baseline.schema !== candidate.schema) {
  die(`Schema mismatch: ${baseline.schema} vs ${candidate.schema}`)
}

const baselineLabel = baseline.env.label || 'Baseline'
const candidateLabel = candidate.env.label || 'Candidate'

function pct(a, b) {
  if (a == null || b == null || a === 0) return '—'
  const delta = ((b - a) / a) * 100
  const sign = delta >= 0 ? '+' : ''
  return `${sign}${delta.toFixed(1)}%`
}

function fmt(v) {
  if (v == null) return '—'
  return v.toFixed(3)
}

function diffRenderer() {
  const lines = []
  lines.push(`### Renderer scenarios`)
  lines.push('')
  lines.push(
    `| Scenario | Frames | ${baselineLabel} Wall (ms) | ${candidateLabel} Wall (ms) | Δ Wall | ` +
      `${baselineLabel} CPU | ${candidateLabel} CPU | Δ CPU | ` +
      `${baselineLabel} Submit | ${candidateLabel} Submit | Δ Submit | Winner |`,
  )
  lines.push(`|---|---|---|---|---|---|---|---|---|---|---|---|`)
  const bMap = new Map(baseline.renderer.map((r) => [r.name, r]))
  const cMap = new Map(candidate.renderer.map((r) => [r.name, r]))
  const names = [...new Set([...bMap.keys(), ...cMap.keys()])]
  for (const name of names) {
    const br = bMap.get(name)
    const cr = cMap.get(name)
    const bMean = br?.stats?.mean
    const cMean = cr?.stats?.mean
    const bCpu = br?.cpu?.mean
    const cCpu = cr?.cpu?.mean
    const bSub = br?.submit?.mean
    const cSub = cr?.submit?.mean
    const frames = br?.frames ?? cr?.frames ?? '—'
    let winner = '—'
    if (bMean != null && cMean != null) {
      if (Math.abs(bMean - cMean) / Math.max(bMean, cMean) < 0.05) winner = 'tie'
      else winner = bMean < cMean ? baselineLabel : candidateLabel
    }
    lines.push(
      `| ${name} | ${frames} | ${fmt(bMean)} | ${fmt(cMean)} | ${pct(bMean, cMean)} | ` +
        `${fmt(bCpu)} | ${fmt(cCpu)} | ${pct(bCpu, cCpu)} | ` +
        `${fmt(bSub)} | ${fmt(cSub)} | ${pct(bSub, cSub)} | ${winner} |`,
    )
  }
  return lines.join('\n')
}

function diffCompute() {
  const lines = []
  lines.push(`### Compute scenarios`)
  lines.push('')
  lines.push(`| Function | Size | ${baselineLabel} Mean (ms) | ${candidateLabel} Mean (ms) | Δ | Winner |`)
  lines.push(`|---|---|---|---|---|---|`)
  const key = (r) => `${r.name}::${r.dataSize}`
  const bMap = new Map(baseline.compute.map((r) => [key(r), r]))
  const cMap = new Map(candidate.compute.map((r) => [key(r), r]))
  const keys = [...new Set([...bMap.keys(), ...cMap.keys()])]
  for (const k of keys) {
    const br = bMap.get(k)
    const cr = cMap.get(k)
    const bMean = br?.stats?.mean
    const cMean = cr?.stats?.mean
    const [name, size] = k.split('::')
    let winner = '—'
    if (bMean != null && cMean != null) {
      if (Math.abs(bMean - cMean) / Math.max(bMean, cMean) < 0.05) winner = 'tie'
      else winner = bMean < cMean ? baselineLabel : candidateLabel
    }
    lines.push(`| ${name} | ${size} | ${fmt(bMean)} | ${fmt(cMean)} | ${pct(bMean, cMean)} | ${winner} |`)
  }
  return lines.join('\n')
}

function diffTileSweep() {
  const bt = baseline.sweeps?.tile
  const ct = candidate.sweeps?.tile
  if (!bt && !ct) return ''
  const lines = []
  lines.push(`### Tile-count sweep`)
  lines.push('')
  lines.push(
    `Linear fit (slope ms/tile, intercept ms): ` +
      `baseline=${fmt(bt?.slope)}/${fmt(bt?.intercept)}, ` +
      `candidate=${fmt(ct?.slope)}/${fmt(ct?.intercept)}`,
  )
  lines.push('')
  lines.push(`| Tiles | ${baselineLabel} Mean (ms) | ${candidateLabel} Mean (ms) | Δ | Winner |`)
  lines.push(`|---|---|---|---|---|`)
  const bMap = new Map((bt?.rows ?? []).map((r) => [r.tiles, r]))
  const cMap = new Map((ct?.rows ?? []).map((r) => [r.tiles, r]))
  const tileCounts = [...new Set([...bMap.keys(), ...cMap.keys()])].sort((a, b) => a - b)
  for (const tc of tileCounts) {
    const br = bMap.get(tc),
      cr = cMap.get(tc)
    const bMean = br?.stats?.mean
    const cMean = cr?.stats?.mean
    let winner = '—'
    if (bMean != null && cMean != null) {
      if (Math.abs(bMean - cMean) / Math.max(bMean, cMean) < 0.05) winner = 'tie'
      else winner = bMean < cMean ? baselineLabel : candidateLabel
    }
    lines.push(`| ${tc} | ${fmt(bMean)} | ${fmt(cMean)} | ${pct(bMean, cMean)} | ${winner} |`)
  }
  return lines.join('\n')
}

function diffMeshSweep() {
  const bm = baseline.sweeps?.mesh
  const cm = candidate.sweeps?.mesh
  if (!bm && !cm) return ''
  const lines = []
  lines.push(`### Mesh-size sweep`)
  lines.push('')
  lines.push(`| Verts/mesh | Meshes | ${baselineLabel} Mean (ms) | ${candidateLabel} Mean (ms) | Δ | Winner |`)
  lines.push(`|---|---|---|---|---|---|`)
  const key = (r) => `${r.size}::${r.count}`
  const bMap = new Map((bm ?? []).map((r) => [key(r), r]))
  const cMap = new Map((cm ?? []).map((r) => [key(r), r]))
  const keys = [...new Set([...bMap.keys(), ...cMap.keys()])]
  for (const k of keys) {
    const br = bMap.get(k),
      cr = cMap.get(k)
    const [size, count] = k.split('::')
    const bMean = br?.stats?.mean
    const cMean = cr?.stats?.mean
    let winner = '—'
    if (bMean != null && cMean != null) {
      if (Math.abs(bMean - cMean) / Math.max(bMean, cMean) < 0.05) winner = 'tie'
      else winner = bMean < cMean ? baselineLabel : candidateLabel
    }
    lines.push(`| ${size} | ${count} | ${fmt(bMean)} | ${fmt(cMean)} | ${pct(bMean, cMean)} | ${winner} |`)
  }
  return lines.join('\n')
}

function diffTract() {
  const bt = baseline.tract
  const ct = candidate.tract
  if (!bt && !ct) return ''
  const lines = []
  lines.push(`### Tract regeneration`)
  lines.push('')
  lines.push(`| Streamlines | ${baselineLabel} Mean (ms) | ${candidateLabel} Mean (ms) | Δ | Winner |`)
  lines.push(`|---|---|---|---|---|`)
  const bMap = new Map((bt ?? []).map((r) => [r.nStreamlines, r]))
  const cMap = new Map((ct ?? []).map((r) => [r.nStreamlines, r]))
  const keys = [...new Set([...bMap.keys(), ...cMap.keys()])].sort((a, b) => a - b)
  for (const k of keys) {
    const br = bMap.get(k),
      cr = cMap.get(k)
    const bMean = br?.stats?.mean
    const cMean = cr?.stats?.mean
    let winner = '—'
    if (bMean != null && cMean != null) {
      if (Math.abs(bMean - cMean) / Math.max(bMean, cMean) < 0.05) winner = 'tie'
      else winner = bMean < cMean ? baselineLabel : candidateLabel
    }
    lines.push(`| ${k.toLocaleString()} | ${fmt(bMean)} | ${fmt(cMean)} | ${pct(bMean, cMean)} | ${winner} |`)
  }
  return lines.join('\n')
}

function diffBundles() {
  const bb = baseline.bundleSizes
  const cb = candidate.bundleSizes
  if (!bb && !cb) return ''
  const lines = []
  lines.push(`### Bundle sizes`)
  lines.push('')
  lines.push(`| Entry | Baseline min KB | Candidate min KB | Δ | Baseline gzip KB | Candidate gzip KB | Δ |`)
  lines.push(`|---|---|---|---|---|---|---|`)
  const bMap = new Map((bb?.entries ?? []).map((e) => [e.name, e]))
  const cMap = new Map((cb?.entries ?? []).map((e) => [e.name, e]))
  const names = [...new Set([...bMap.keys(), ...cMap.keys()])]
  for (const name of names) {
    const be = bMap.get(name),
      ce = cMap.get(name)
    lines.push(
      `| \`${name}\` | ${fmt(be?.minKB)} | ${fmt(ce?.minKB)} | ${pct(be?.minKB, ce?.minKB)} | ` +
        `${fmt(be?.gzipKB)} | ${fmt(ce?.gzipKB)} | ${pct(be?.gzipKB, ce?.gzipKB)} |`,
    )
  }
  return lines.join('\n')
}

const out = []
out.push(`# Benchmark Comparison`)
out.push('')
out.push(`- **Baseline** (${baselineLabel}): ${baseline.env.timestamp}`)
out.push(`- **Candidate** (${candidateLabel}): ${candidate.env.timestamp}`)
out.push('')
out.push(`**Baseline GPU**: ${baseline.env.gpu?.description || 'n/a'}`)
out.push(`**Candidate GPU**: ${candidate.env.gpu?.description || 'n/a'}`)
out.push('')
out.push(
  `_Δ is the relative change from baseline to candidate. Negative = candidate faster. Winner is determined by absolute mean with a 5% tie threshold._`,
)
out.push('')

if (baseline.renderer?.length || candidate.renderer?.length) {
  out.push(diffRenderer())
  out.push('')
}
if (baseline.compute?.length || candidate.compute?.length) {
  out.push(diffCompute())
  out.push('')
}
if (baseline.sweeps?.tile?.rows?.length || candidate.sweeps?.tile?.rows?.length) {
  out.push(diffTileSweep())
  out.push('')
}
if (baseline.sweeps?.mesh?.length || candidate.sweeps?.mesh?.length) {
  out.push(diffMeshSweep())
  out.push('')
}
if (baseline.tract?.length || candidate.tract?.length) {
  out.push(diffTract())
  out.push('')
}
if (baseline.bundleSizes?.entries?.length || candidate.bundleSizes?.entries?.length) {
  out.push(diffBundles())
  out.push('')
}

console.log(out.join('\n'))
