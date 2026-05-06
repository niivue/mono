import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { gzipSync } from 'node:zlib'

const args = process.argv.slice(2)
const jsonIdx = args.indexOf('--json')
const wantJson = jsonIdx !== -1
const jsonOut = wantJson ? args[jsonIdx + 1] || 'benchmarks/entry-sizes.json' : null
const entries = wantJson ? args.slice(0, jsonIdx) : args
const defaultEntries = ['niivuegpu.js', 'niivuegpu.webgpu.js', 'niivuegpu.webgl2.js']
const targets = entries.length > 0 ? entries : defaultEntries
const distDir = resolve(process.cwd(), 'dist')

const importRe = /(?:import|export)\s+(?:[^'"`]*?from\s+)?["'](\.[^"']+)["']/g

function collectDeps(entryFile) {
  const seen = new Set()

  function walk(filePath) {
    const absPath = resolve(distDir, filePath)
    if (seen.has(absPath)) return
    seen.add(absPath)

    const code = readFileSync(absPath, 'utf8')
    const baseDir = dirname(absPath)

    let match = importRe.exec(code)
    while (match !== null) {
      const rel = match[1]
      const depAbs = resolve(baseDir, rel)
      if (depAbs.startsWith(distDir)) {
        walk(depAbs.slice(distDir.length + 1))
      }
      match = importRe.exec(code)
    }
  }

  walk(entryFile)
  return [...seen]
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`
}

function summarize(entry) {
  const files = collectDeps(entry)
  let total = 0
  const rows = files
    .map((abs) => {
      const size = statSync(abs).size
      total += size
      return { file: abs.slice(distDir.length + 1), size }
    })
    .sort((a, b) => b.size - a.size)
  const entryAbs = resolve(distDir, entry)
  const entryBytes = readFileSync(entryAbs)
  const gzipBytes = gzipSync(entryBytes).length
  return { entry, total, rows, entrySize: entryBytes.length, gzipSize: gzipBytes }
}

function report(s) {
  console.log(`\nEntry: ${s.entry}`)
  console.log(`Total reachable JS: ${formatBytes(s.total)} (${s.total} bytes)`)
  console.log(`Entry file: ${formatBytes(s.entrySize)} min, ${formatBytes(s.gzipSize)} gzip`)
  console.log(`Chunks: ${s.rows.length}`)
  for (const row of s.rows) {
    console.log(`  - ${row.file}: ${formatBytes(row.size)}`)
  }
}

const summaries = targets.map(summarize)
for (const s of summaries) report(s)

if (wantJson) {
  const payload = {
    schema: 'niivue-entry-sizes-v1',
    timestamp: new Date().toISOString(),
    entries: summaries.map((s) => ({
      name: s.entry,
      totalReachableBytes: s.total,
      minBytes: s.entrySize,
      gzipBytes: s.gzipSize,
      minKB: s.entrySize / 1024,
      gzipKB: s.gzipSize / 1024,
      chunks: s.rows.length,
    })),
  }
  const outPath = resolve(process.cwd(), jsonOut)
  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, JSON.stringify(payload, null, 2))
  console.log(`\nWrote ${jsonOut}`)
}
