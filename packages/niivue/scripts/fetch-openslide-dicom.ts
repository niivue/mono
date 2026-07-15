// Download one DICOM-WSI series from the OpenSlide test-data set
// (https://openslide.cs.cmu.edu/download/openslide-testdata/DICOM/) into
// public/dicom-wsi/<slide>/, then build the same dicom-wsi-range-v1 manifest the
// CPTAC-BRCA fetcher produces, so NVSlide / slides.html can stream its JPEG tiles
// over HTTP Range with no backend.
//
// OpenSlide ships these as .zip archives of .dcm files. Only the JPEG +
// TILED_FULL archives are loadable in-browser today:
//   - JPEG 2000 archives can't be decoded by createImageBitmap (browsers have no
//     JPEG 2000 decoder), so they are refused.
//   - TILED_SPARSE archives need per-frame position parsing the manifest builder
//     does not implement yet (it assumes TILED_FULL frame ordering), so they are
//     refused with a note.
// `--list` shows which archives are loadable.
//
// The download + manifest are multi-hundred-MB and gitignored (see .gitignore).
// Requires `unzip` on PATH. Reuses buildManifest from fetch-dicom-wsi.ts.
//
// Usage:
//   bun run scripts/fetch-openslide-dicom.ts                  # default 3dhistech-1
//   bun run scripts/fetch-openslide-dicom.ts --slide=hamamatsu-2
//   bun run scripts/fetch-openslide-dicom.ts --list
//   bun run scripts/fetch-openslide-dicom.ts --force          # re-download + rebuild
//
// Restart the dev server after fetching, then pick the slide in slides.html.

import { spawnSync } from 'node:child_process'
import type { FileHandle } from 'node:fs/promises'
import fs from 'node:fs/promises'
import path from 'node:path'
import url from 'node:url'
import { buildManifest } from './fetch-dicom-wsi.ts'

const __dirname = path.dirname(url.fileURLToPath(import.meta.url))

const BASE_URL =
  'https://openslide.cs.cmu.edu/download/openslide-testdata/DICOM/'

type Tiling = 'TILED_FULL' | 'TILED_SPARSE'
type Codec = 'jpeg' | 'jpeg2000'

interface Preset {
  key: string
  zip: string
  codec: Codec
  tiling: Tiling
  approxMB: number
  note: string
  /** Set when an archive is known-unloadable for a reason other than tiling. */
  unsupported?: string
}

// Compatibility from DICOM/index.yaml. NVSlide decodes tiles in-browser via
// createImageBitmap (baseline JPEG only) and the manifest builder assumes
// TILED_FULL frame ordering, so only jpeg + TILED_FULL is loadable today.
const PRESETS: Preset[] = [
  {
    key: '3dhistech-1',
    zip: '3DHISTECH-1.zip',
    codec: 'jpeg',
    tiling: 'TILED_FULL',
    approxMB: 345,
    note: '3DHISTECH brightfield, JPEG TILED_FULL',
  },
  {
    key: 'hamamatsu-2',
    zip: 'Hamamatsu-2.zip',
    codec: 'jpeg',
    tiling: 'TILED_FULL',
    approxMB: 191,
    note: 'Hamamatsu brightfield, TILED_FULL but dicom-parser buffer overrun',
    // The instances ARE TILED_FULL JPEG, but dicom-parser throws
    // "buffer overrun" parsing them (before the pixel data), so the byte-range
    // manifest cannot be built. Needs a parser workaround/alternative, not a
    // tiling change. See docs/slide-plane-review-todos.md.
    unsupported:
      'dicom-parser raises a buffer overrun on these instances (pixel data is never reached).',
  },
  {
    key: 'leica-4',
    zip: 'Leica-4.zip',
    codec: 'jpeg',
    tiling: 'TILED_SPARSE',
    approxMB: 81,
    note: 'Leica, JPEG but TILED_SPARSE (not yet supported)',
  },
  {
    key: '3dhistech-2',
    zip: '3DHISTECH-2.zip',
    codec: 'jpeg',
    tiling: 'TILED_SPARSE',
    approxMB: 2180,
    note: '3DHISTECH, JPEG but TILED_SPARSE (not yet supported)',
  },
  {
    key: 'cmu-1-jp2k-33005',
    zip: 'CMU-1-JP2K-33005.zip',
    codec: 'jpeg2000',
    tiling: 'TILED_FULL',
    approxMB: 121,
    note: 'JPEG 2000 ICT (decoded by the OpenJPEG WASM codec)',
  },
  {
    key: 'cmu-1-jp2k-ict',
    zip: 'CMU-1-JP2K-ICT.zip',
    codec: 'jpeg2000',
    tiling: 'TILED_FULL',
    approxMB: 729,
    note: 'JPEG 2000 YBR_ICT (decoded by the OpenJPEG WASM codec)',
  },
  {
    key: 'cmu-1-jp2k-rct',
    zip: 'CMU-1-JP2K-RCT.zip',
    codec: 'jpeg2000',
    tiling: 'TILED_FULL',
    approxMB: 729,
    note: 'JPEG 2000 YBR_RCT (decoded by the OpenJPEG WASM codec)',
  },
  {
    key: 'jp2k-33003-1',
    zip: 'JP2K-33003-1.zip',
    codec: 'jpeg2000',
    tiling: 'TILED_FULL',
    approxMB: 62,
    note: 'JPEG 2000 (decoded by the OpenJPEG WASM codec)',
  },
]

const DEFAULT_KEY = '3dhistech-1'

function parseArgs(): Map<string, string> {
  const args = new Map<string, string>()
  for (const raw of process.argv.slice(2)) {
    const m = /^--([^=]+)=(.*)$/.exec(raw)
    if (m) args.set(m[1] ?? '', m[2] ?? '')
    else if (raw.startsWith('--')) args.set(raw.slice(2), 'true')
  }
  return args
}

function supportReason(p: Preset): string | null {
  // JPEG 2000 is loadable: the manifest is tagged image/jp2 and the slides demo
  // registers an OpenJPEG WASM decoder (examples/openjpeg-decoder.js). Only
  // TILED_SPARSE is still unsupported (the builder assumes TILED_FULL ordering).
  if (p.unsupported) return p.unsupported
  if (p.tiling !== 'TILED_FULL') {
    return `${p.tiling} frame ordering is not yet supported by the manifest builder (only TILED_FULL).`
  }
  return null
}

function printList(): void {
  console.log('OpenSlide DICOM-WSI archives:\n')
  for (const p of PRESETS) {
    const tag = supportReason(p) === null ? 'LOADABLE   ' : 'unsupported'
    console.log(
      `  ${p.key.padEnd(18)} ${String(p.approxMB).padStart(5)} MB  [${tag}]  ${p.note}`,
    )
  }
  console.log(`\nDefault: ${DEFAULT_KEY}. Fetch with --slide=<key>.`)
}

async function download(srcUrl: string, dest: string): Promise<void> {
  const res = await fetch(srcUrl)
  if (!res.ok) {
    throw new Error(`GET ${srcUrl} -> ${res.status} ${res.statusText}`)
  }
  // Buffer to RAM then write (mirrors fetch-dicom-wsi.ts; streaming a Response to
  // Bun.write can stall). Large archives need correspondingly large memory.
  await Bun.write(dest, await res.arrayBuffer())
}

function unzip(zipPath: string, destDir: string): void {
  const r = spawnSync('unzip', ['-o', '-q', zipPath, '-d', destDir], {
    stdio: 'inherit',
  })
  if (r.status !== 0) {
    throw new Error(
      `unzip exited ${r.status}. Is 'unzip' installed and on PATH?`,
    )
  }
}

// DICOM files carry the "DICM" magic at byte offset 128.
async function isDicom(file: string): Promise<boolean> {
  let fh: FileHandle | undefined
  try {
    fh = await fs.open(file, 'r')
    const buf = Buffer.alloc(4)
    const { bytesRead } = await fh.read(buf, 0, 4, 128)
    return bytesRead === 4 && buf.toString('latin1') === 'DICM'
  } catch {
    return false
  } finally {
    await fh?.close()
  }
}

async function walk(dir: string): Promise<string[]> {
  const out: string[] = []
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...(await walk(full)))
    else if (e.isFile()) out.push(full)
  }
  return out
}

// Copy every DICOM instance found anywhere in the extracted tree into filesDir as
// NNNN.dcm, so buildManifest (which globs *.dcm in one flat dir) sees them. Skips
// non-DICOM files (READMEs, etc.).
async function collectDicom(
  extractDir: string,
  filesDir: string,
): Promise<number> {
  const all = (await walk(extractDir)).sort()
  let n = 0
  for (const f of all) {
    if (await isDicom(f)) {
      await fs.copyFile(
        f,
        path.join(filesDir, `${String(n).padStart(4, '0')}.dcm`),
      )
      n++
    }
  }
  return n
}

async function main(): Promise<void> {
  const args = parseArgs()
  if (args.get('list') === 'true') {
    printList()
    return
  }
  const key = args.get('slide') ?? DEFAULT_KEY
  const preset = PRESETS.find((p) => p.key === key)
  if (!preset) {
    console.error(`Unknown slide "${key}". Run with --list to see options.`)
    process.exit(1)
    return
  }
  const reason = supportReason(preset)
  if (reason) {
    console.error(`"${preset.key}" is not loadable by NVSlide: ${reason}`)
    console.error('Pick a LOADABLE archive (run with --list).')
    process.exit(1)
    return
  }

  const force = args.get('force') === 'true'
  const outDir = path.resolve(
    args.get('out') ??
      path.join(__dirname, '..', 'public', 'dicom-wsi', preset.key),
  )
  const filesDir = path.join(outDir, 'files')
  const manifestPath = path.join(outDir, 'manifest.json')

  if (!force) {
    try {
      await fs.access(manifestPath)
      console.log(`Already built: ${manifestPath} (use --force to rebuild)`)
      return
    } catch {
      // not built yet
    }
  }

  console.log(
    `OpenSlide DICOM-WSI: ${preset.key} (${preset.zip}, ~${preset.approxMB} MB)`,
  )
  await fs.rm(outDir, { recursive: true, force: true })
  await fs.mkdir(filesDir, { recursive: true })

  const tmpDir = path.join(outDir, '.extract')
  await fs.mkdir(tmpDir, { recursive: true })
  const zipPath = path.join(tmpDir, preset.zip)

  console.log(`  downloading ${BASE_URL}${preset.zip} ...`)
  await download(`${BASE_URL}${preset.zip}`, zipPath)

  console.log('  unzipping ...')
  unzip(zipPath, tmpDir)

  console.log('  collecting DICOM instances ...')
  const count = await collectDicom(tmpDir, filesDir)
  if (count === 0) {
    throw new Error('No DICOM (DICM-magic) files found in the archive.')
  }
  console.log(`  found ${count} DICOM instance(s)`)

  console.log('  building manifest.json (parsing JPEG frame offsets) ...')
  let manifest: Record<string, unknown>
  try {
    manifest = await buildManifest(preset.key, filesDir)
  } catch (err) {
    // dicom-parser throws a {exception, dataSet} object (not an Error) on a
    // malformed element, so surface its `.exception`/message rather than
    // "[object Object]".
    const msg =
      err instanceof Error
        ? err.message
        : ((err as { exception?: string })?.exception ?? String(err))
    throw new Error(
      `manifest build failed: ${msg}\n` +
        '(A "not a TILED_FULL instance" error means an unsupported frame ' +
        'organization; a "buffer overrun" means dicom-parser cannot parse this ' +
        "archive's encoding — e.g. Hamamatsu-2 — and the pixel data is never reached.)",
    )
  }
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest)}\n`)

  // Drop the extracted zip + tree; keep only files/ + manifest.json.
  await fs.rm(tmpDir, { recursive: true, force: true })

  const levels = manifest.levels as Array<Record<string, unknown>>
  console.log(`  wrote ${manifestPath} (${levels.length} pyramid level(s))`)
  for (const lvl of levels) {
    console.log(
      `    L${lvl.index}: ${lvl.width}x${lvl.height}, ` +
        `${lvl.columns}x${lvl.rows} tiles (${lvl.frames} frames)`,
    )
  }
  console.log(
    `\nRestart the dev server, then pick "openslide-${preset.key}" in slides.html.`,
  )
}

if (import.meta.main) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
  })
}
