/**
 * Verifies the self-contained ES module build in dist/standalone/.
 *
 * The folder is meant to be copied anywhere and loaded straight from a
 * `<script type="module">`, with no bundler and no import map for its
 * dependencies. That holds only while:
 *
 *   1. every static and dynamic import in every emitted file is a relative
 *      path (a bare specifier such as `gl-matrix` cannot be resolved by a
 *      browser without an import map),
 *   2. every relative import resolves to a file inside the folder, and
 *   3. nothing locates a sibling asset through `import.meta.url` (fonts and
 *      matcaps are inlined as data URIs, so no asset files are emitted).
 *
 * Imports are read with Bun's own parser (`Bun.Transpiler#scanImports`), not
 * a regex, so minified code and string literals cannot fool it.
 *
 * Runs as the last step of `bun run build`; exits non-zero on any violation.
 * Run on its own with: bun run scripts/check-standalone.ts
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const NIIVUE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const STANDALONE_DIR = join(NIIVUE_ROOT, 'dist', 'standalone')
const REQUIRED_ENTRIES = [
  'niivue.js',
  'niivue.webgl2.js',
  'niivue.webgpu.js',
  'viewport.js',
  'assets/fonts/index.js',
  'assets/matcaps/index.js',
]

function listJsFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name)
    if (statSync(abs).isDirectory()) out.push(...listJsFiles(abs))
    else if (name.endsWith('.js')) out.push(abs)
  }
  return out
}

if (!existsSync(STANDALONE_DIR)) {
  console.error(`[standalone] FAIL: ${STANDALONE_DIR} does not exist.`)
  console.error('[standalone] Run `bun run build` first.')
  process.exit(1)
}

const errors: string[] = []
for (const entry of REQUIRED_ENTRIES) {
  if (!existsSync(join(STANDALONE_DIR, entry))) {
    errors.push(`missing entry ${entry}`)
  }
}

const transpiler = new Bun.Transpiler({ loader: 'js' })
const files = listJsFiles(STANDALONE_DIR)
let importCount = 0
for (const abs of files) {
  const rel = relative(STANDALONE_DIR, abs)
  const code = readFileSync(abs, 'utf8')
  for (const imp of transpiler.scanImports(code)) {
    importCount++
    const spec = imp.path
    if (!spec.startsWith('./') && !spec.startsWith('../')) {
      errors.push(`${rel}: non-relative ${imp.kind} "${spec}"`)
      continue
    }
    const target = resolve(dirname(abs), spec)
    if (!target.startsWith(STANDALONE_DIR + sep)) {
      errors.push(`${rel}: import "${spec}" escapes dist/standalone/`)
    } else if (!existsSync(target)) {
      errors.push(`${rel}: import "${spec}" does not exist`)
    }
  }
  if (code.includes('import.meta.url')) {
    errors.push(
      `${rel}: references import.meta.url (assets must be inlined, not emitted)`,
    )
  }
}

if (errors.length > 0) {
  console.error(
    `[standalone] FAIL: ${errors.length} problem(s) in dist/standalone/:`,
  )
  for (const e of errors) console.error(`  - ${e}`)
  process.exit(1)
}

const totalBytes = files.reduce((sum, f) => sum + statSync(f).size, 0)
console.log(
  `[standalone] ok: ${files.length} files, ${importCount} imports, all relative and resolvable (${(totalBytes / 1024 / 1024).toFixed(2)} MiB total)`,
)
