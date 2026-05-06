#!/usr/bin/env node
// Compare current dist entry sizes against benchmarks/baselines/bundle-sizes-baseline.json.
// Exits non-zero if any entry's totalReachable grew beyond the allowed budget.
// Run after `npm run build`.
//
// Flags:
//   --budget-kb <n>   Allowed totalReachable growth in KiB (default 5)
//   --update          Overwrite baseline with current sizes (after deliberate growth,
//                     or to seed the baseline on first run)

import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { gzipSync } from 'node:zlib'

const args = process.argv.slice(2)
function flag(name) {
  return args.includes(name)
}
function arg(name, fallback) {
  const i = args.indexOf(name)
  return i === -1 ? fallback : args[i + 1]
}

const BUDGET_KB = Number(arg('--budget-kb', '5'))
const UPDATE = flag('--update')
const BASELINE_PATH = resolve(
  process.cwd(),
  'benchmarks/baselines/bundle-sizes-baseline.json',
)
const DIST_DIR = resolve(process.cwd(), 'dist')
const DEFAULT_ENTRIES = [
  'niivuegpu.js',
  'niivuegpu.webgpu.js',
  'niivuegpu.webgl2.js',
]

const importRe = /(?:import|export)\s+(?:[^'"`]*?from\s+)?["'](\.[^"']+)["']/g

function collectDeps(entryFile) {
  const seen = new Set()
  function walk(filePath) {
    const absPath = resolve(DIST_DIR, filePath)
    if (seen.has(absPath)) return
    seen.add(absPath)
    const code = readFileSync(absPath, 'utf8')
    const baseDir = dirname(absPath)
    let m = importRe.exec(code)
    while (m !== null) {
      const depAbs = resolve(baseDir, m[1])
      if (depAbs.startsWith(DIST_DIR)) walk(depAbs.slice(DIST_DIR.length + 1))
      m = importRe.exec(code)
    }
  }
  walk(entryFile)
  return [...seen]
}

function summarize(entry) {
  const files = collectDeps(entry)
  const totalReachableBytes = files.reduce(
    (sum, abs) => sum + statSync(abs).size,
    0,
  )
  const entryAbs = resolve(DIST_DIR, entry)
  const entryBytes = readFileSync(entryAbs)
  return {
    name: entry,
    totalReachableBytes,
    minBytes: entryBytes.length,
    gzipBytes: gzipSync(entryBytes).length,
    minKB: entryBytes.length / 1024,
    gzipKB: gzipSync(entryBytes).length / 1024,
    chunks: files.length,
  }
}

let baseline = null
try {
  baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'))
} catch (_err) {
  if (!UPDATE) {
    console.error(`No baseline at ${BASELINE_PATH}.`)
    console.error(`Run with --update to seed it from the current build.`)
    process.exit(2)
  }
}

const targetEntries = baseline?.entries.map((b) => b.name) ?? DEFAULT_ENTRIES
const currentEntries = targetEntries.map(summarize)

let failed = false
const budgetBytes = BUDGET_KB * 1024
console.log(`Budget: +${BUDGET_KB} KiB (totalReachable bytes per entry)\n`)
for (const cur of currentEntries) {
  const base = baseline?.entries.find((b) => b.name === cur.name)
  if (!base) {
    console.log(
      `  ${cur.name}: new entry (${(cur.totalReachableBytes / 1024).toFixed(1)} KiB)`,
    )
    continue
  }
  const delta = cur.totalReachableBytes - base.totalReachableBytes
  const sign = delta >= 0 ? '+' : ''
  const fmt = `${(cur.totalReachableBytes / 1024).toFixed(1)} KiB (baseline ${(base.totalReachableBytes / 1024).toFixed(1)} KiB, ${sign}${(delta / 1024).toFixed(1)} KiB)`
  if (delta > budgetBytes) {
    console.log(`  FAIL ${cur.name}: ${fmt}`)
    failed = true
  } else {
    console.log(`  ok   ${cur.name}: ${fmt}`)
  }
}

if (UPDATE) {
  const payload = {
    schema: 'niivue-entry-sizes-v1',
    timestamp: new Date().toISOString(),
    entries: currentEntries,
  }
  const outDir = dirname(BASELINE_PATH)
  try {
    statSync(outDir)
  } catch {
    const { mkdirSync } = await import('node:fs')
    mkdirSync(outDir, { recursive: true })
  }
  writeFileSync(BASELINE_PATH, `${JSON.stringify(payload, null, 2)}\n`)
  console.log(`\nBaseline updated: ${BASELINE_PATH}`)
  process.exit(0)
}

if (failed) {
  console.error('\nBundle-size check failed. Investigate the growth above.')
  console.error(
    'If the growth is intentional, rerun with --update to refresh the baseline.',
  )
  process.exit(1)
}
console.log('\nAll entries within budget.')
