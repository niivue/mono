#!/usr/bin/env bun
// Verify that committed example notebooks don't carry executed state.
//
// JupyterLab persists widget views as cell outputs containing
// `application/vnd.jupyter.widget-view+json` with a transient `model_id`.
// On reopen JupyterLab tries to restore those views before the kernel
// has matching live models and shows "widget model not found". The
// fix is to commit notebooks with `execution_count: null` and
// `outputs: []` for every code cell — strip via:
//
//   jupyter nbconvert --clear-output --inplace packages/ipyniivue/examples/*.ipynb
//
// This script enforces that hygiene rule so CI catches the recurring
// drift before review.
//
// Usage:
//   bun .github/scripts/check-notebook-hygiene.ts [glob ...]
//
// Default scope is `packages/ipyniivue/examples/*.ipynb` (the only
// place anywidget notebooks live today). Pass globs as arguments to
// scope to a different set.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Glob } from 'bun'

const root = resolve(import.meta.dir, '..', '..')
const patterns = Bun.argv.slice(2)
const globs =
  patterns.length > 0 ? patterns : ['packages/ipyniivue/examples/*.ipynb']

type Issue = { file: string; cell: number; problem: string }
const issues: Issue[] = []
const seen: string[] = []

for (const pattern of globs) {
  const glob = new Glob(pattern)
  for await (const rel of glob.scan({ cwd: root, absolute: false })) {
    seen.push(rel)
    let nb: unknown
    try {
      nb = JSON.parse(readFileSync(resolve(root, rel), 'utf-8'))
    } catch (err) {
      issues.push({ file: rel, cell: -1, problem: `not valid JSON: ${err}` })
      continue
    }
    const cells = (nb as { cells?: unknown[] }).cells ?? []
    for (let i = 0; i < cells.length; i++) {
      const cell = cells[i] as Record<string, unknown>
      if (cell.cell_type !== 'code') continue
      if (cell.execution_count != null) {
        issues.push({
          file: rel,
          cell: i,
          problem: `execution_count is ${JSON.stringify(cell.execution_count)} (expected null)`,
        })
      }
      const outputs = cell.outputs
      if (Array.isArray(outputs) && outputs.length > 0) {
        issues.push({
          file: rel,
          cell: i,
          problem: `has ${outputs.length} output(s) (expected [])`,
        })
      }
    }
  }
}

if (seen.length === 0) {
  console.warn(`No notebooks matched: ${globs.join(', ')}`)
}

if (issues.length > 0) {
  console.error('Notebook hygiene check failed.')
  console.error('Strip outputs with:')
  console.error(
    '  jupyter nbconvert --clear-output --inplace ' + globs.join(' '),
  )
  console.error('')
  for (const i of issues) {
    const loc = i.cell >= 0 ? `cell ${i.cell}` : 'file'
    console.error(`  ${i.file}: ${loc}: ${i.problem}`)
  }
  process.exit(1)
}

console.log(`OK: ${seen.length} notebooks clean`)
