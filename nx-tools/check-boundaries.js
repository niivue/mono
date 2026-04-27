/**
 * Module boundary enforcement for the NX workspace.
 *
 * Rules:
 * 1. Apps can depend on libs, but not on other apps
 * 2. Libs cannot depend on apps
 * 3. Python projects cannot depend on TypeScript projects (and vice versa)
 *
 * Exception: `ipyniivue` is allowed to depend on TypeScript libs because
 * its codegen pipeline bundles @niivue/* TypeScript outputs into a
 * generated browser bundle (`src/ipyniivue/static/widget.js`) that ships
 * inside the Python wheel. The dependency exists at codegen time only —
 * there is no runtime Python-to-TypeScript call. See
 * `packages/ipyniivue/CLAUDE.md` for the architecture rationale.
 *
 * Run: bunx nx graph --file=tmp-graph.json && node nx-tools/check-boundaries.js
 * Or use the "check-boundaries" target defined in the root package.json.
 */

// Python projects allowed to depend on TypeScript libs. Add a project
// here only when its TypeScript dependencies are bundled into a static
// asset shipped in the Python wheel (i.e., the codegen pipeline).
const PY_TO_TS_ALLOWED = new Set(['ipyniivue'])

const { readFileSync, unlinkSync } = require('node:fs')
const { execSync } = require('node:child_process')
const { join } = require('node:path')

const root = join(__dirname, '..')
const graphFile = join(root, 'tmp-boundary-graph.json')

// Generate the graph
execSync(`bunx nx graph --file=${graphFile}`, { cwd: root, stdio: 'pipe' })

const graph = JSON.parse(readFileSync(graphFile, 'utf-8'))
unlinkSync(graphFile)

const nodes = graph.graph.nodes
const dependencies = graph.graph.dependencies

const errors = []

for (const [source, deps] of Object.entries(dependencies)) {
  const sourceNode = nodes[source]
  if (!sourceNode) continue

  const sourceTags = sourceNode.data.tags || []
  const _sourceIsApp = sourceTags.includes('type:app')
  const _sourceIsLib = sourceTags.includes('type:lib')
  const sourceIsTS = sourceTags.includes('lang:typescript')
  const sourceIsPy = sourceTags.includes('lang:python')

  for (const dep of deps) {
    const targetNode = nodes[dep.target]
    if (!targetNode) continue

    const targetTags = targetNode.data.tags || []
    const targetIsApp = targetTags.includes('type:app')
    const _targetIsLib = targetTags.includes('type:lib')
    const targetIsTS = targetTags.includes('lang:typescript')
    const targetIsPy = targetTags.includes('lang:python')

    // Rule 1 & 2: No project can depend on an app
    if (targetIsApp) {
      errors.push(
        `${source} -> ${dep.target}: cannot depend on an app (only libs are allowed as dependencies)`,
      )
    }

    // Rule 3: No cross-language dependencies
    if (sourceIsTS && targetIsPy) {
      errors.push(
        `${source} -> ${dep.target}: TypeScript project cannot depend on a Python project`,
      )
    }
    if (sourceIsPy && targetIsTS && !PY_TO_TS_ALLOWED.has(source)) {
      errors.push(
        `${source} -> ${dep.target}: Python project cannot depend on a TypeScript project`,
      )
    }
  }
}

if (errors.length > 0) {
  console.error('Module boundary violations found:\n')
  for (const err of errors) {
    console.error(`  ✗ ${err}`)
  }
  console.error(`\n${errors.length} violation(s) found.`)
  process.exit(1)
} else {
  console.log('✓ All module boundary rules passed.')
}
