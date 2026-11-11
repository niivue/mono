/**
 * Verifies the standalone build in dist/standalone/ (vite.config.standalone.ts),
 * as packages/niivue/scripts/check-standalone.ts does for core:
 *
 *   1. every import is relative and resolves inside the folder, except
 *      `@niivue/niivue` (the page maps it onto core's standalone build) and
 *      the optional `@niivue/dcm2niix`, which only /dicom and /tiff (JPEG
 *      2000 tiles) may reach, and only through a dynamic import. A dynamic
 *      import of `node:worker_threads` is allowed: zarrita-rs's Node-only worker
 *      branch, which the minifier inlines (browsers never run it);
 *   2. nothing locates an asset through `import.meta.url`;
 *   3. each entry's static imports stay within its format: /tiff loads no
 *      zarrita-rs code, /zarr and /dicom load no geotiff-rs code.
 *
 * Prints what each entry loads before any lazy chunk. Exits non-zero on any
 * violation. Run after `vite build -c vite.config.standalone.ts`.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../dist/standalone',
)
const ENTRIES = ['tiff.js', 'dicom.js', 'zarr.js']
const CORE = '@niivue/niivue'
const DCM2NIIX = '@niivue/dcm2niix'
const DCM2NIIX_ENTRIES = ['dicom.js', 'tiff.js']
const NODE_WORKER = 'node:worker_threads'
// Text only a format's own dependency contains (zarrita-rs's Zarr v3 metadata
// key; geotiff-rs's TIFF tag table).
const MARKERS: Record<string, string> = {
  'zarrita-rs': 'zarr_format',
  'geotiff-rs': 'StripByteCounts',
}
const FORBIDDEN: Record<string, string[]> = {
  'tiff.js': ['zarrita-rs'],
  'dicom.js': ['zarrita-rs', 'geotiff-rs'],
  'zarr.js': ['geotiff-rs'],
}

const listJs = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const abs = join(dir, name)
    if (statSync(abs).isDirectory()) return listJs(abs)
    return name.endsWith('.js') ? [abs] : []
  })

if (!existsSync(DIR)) {
  console.error(`[standalone] FAIL: ${DIR} does not exist; build it first.`)
  process.exit(1)
}

const transpiler = new Bun.Transpiler({ loader: 'js' })
const errors: string[] = []
const staticDeps = new Map<string, string[]>()
const bare = new Map<string, Set<string>>()
for (const abs of listJs(DIR)) {
  const rel = relative(DIR, abs)
  const code = readFileSync(abs, 'utf8')
  const deps: string[] = []
  for (const imp of transpiler.scanImports(code)) {
    const spec = imp.path
    if (!spec.startsWith('./') && !spec.startsWith('../')) {
      const nodeOnly = spec === NODE_WORKER && imp.kind === 'dynamic-import'
      if (spec !== CORE && spec !== DCM2NIIX && !nodeOnly)
        errors.push(`${rel}: bare ${imp.kind} "${spec}"`)
      if (spec === DCM2NIIX && imp.kind !== 'dynamic-import')
        errors.push(`${rel}: ${imp.kind} of optional ${DCM2NIIX}`)
      bare.set(rel, (bare.get(rel) ?? new Set()).add(spec))
      continue
    }
    const target = resolve(dirname(abs), spec)
    if (!target.startsWith(DIR + sep) || !existsSync(target)) {
      errors.push(`${rel}: import "${spec}" does not resolve inside the folder`)
    } else if (imp.kind === 'import-statement') {
      deps.push(relative(DIR, target))
    }
  }
  staticDeps.set(rel, deps)
  if (code.includes('import.meta.url'))
    errors.push(`${rel}: references import.meta.url`)
}

const closure = (entry: string): Set<string> => {
  const seen = new Set<string>()
  const walk = (f: string): void => {
    if (seen.has(f)) return
    seen.add(f)
    for (const d of staticDeps.get(f) ?? []) walk(d)
  }
  walk(entry)
  return seen
}

for (const entry of ENTRIES) {
  if (!staticDeps.has(entry)) {
    errors.push(`missing entry ${entry}`)
    continue
  }
  const files = [...closure(entry)]
  const text = files.map((f) => readFileSync(join(DIR, f), 'utf8')).join('\n')
  for (const dep of FORBIDDEN[entry]) {
    if (text.includes(MARKERS[dep]))
      errors.push(`${entry} statically loads ${dep} code`)
  }
  for (const f of files) {
    if (!DCM2NIIX_ENTRIES.includes(entry) && bare.get(f)?.has(DCM2NIIX))
      errors.push(`${entry} reaches ${DCM2NIIX} through ${f}`)
  }
  const kb = files.reduce((n, f) => n + statSync(join(DIR, f)).size, 0) / 1024
  console.log(
    `[standalone] ${entry}: ${files.length} file(s), ${kb.toFixed(1)} KiB before lazy chunks`,
  )
}

if (errors.length > 0) {
  console.error(`[standalone] FAIL: ${errors.length} problem(s):`)
  for (const e of errors) console.error(`  - ${e}`)
  process.exit(1)
}
console.log(
  `[standalone] ok: only ${CORE} and ${DCM2NIIX} (dicom, tiff; lazy) are bare`,
)
