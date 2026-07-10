// Ensure the streaming demos' on-demand sample data is present, downloading it
// if missing. The large real samples (OME-Zarr volumes, DICOM-WSI slides) are
// NOT checked into git; they are fetched on demand by fetch-omezarr.ts and
// fetch-dicom-wsi.ts. This orchestrator checks what each demo needs and only
// downloads what is absent, so it is cheap to run repeatedly (e.g. before
// `dev`) and a no-op once the samples are in place.
//
// Usage:
//   bun run scripts/ensure-samples.ts            # default demo samples
//   bun run scripts/ensure-samples.ts --all      # every catalogued sample
//   bun run scripts/ensure-samples.ts --force    # re-download even if present
//
// What "present" means: a sample's marker file exists under public/ (the store
// root metadata for OME-Zarr, the generated manifest for DICOM-WSI). The
// per-source fetch scripts are themselves resumable, so a partial download is
// completed rather than restarted.

import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import url from 'node:url'

const __dirname = path.dirname(url.fileURLToPath(import.meta.url))
const PUBLIC = path.resolve(__dirname, '..', 'public')

interface Sample {
  label: string
  // File whose existence means the sample is already downloaded.
  marker: string
  // Args passed to the per-source fetch script.
  script: 'fetch-omezarr.ts' | 'fetch-dicom-wsi.ts'
  args: string[]
  // Included in the default (no --all) set.
  default: boolean
}

// Markers are deliberately the cheapest "is it here" signal: the store/manifest
// root. The fetch scripts handle level/partial completeness themselves.
const SAMPLES: Sample[] = [
  {
    label: 'pawpawsaurus OME-Zarr (range.html)',
    marker: 'omezarr/pawpawsaurus.ome.zarr/zarr.json',
    script: 'fetch-omezarr.ts',
    args: ['--name=pawpawsaurus'],
    default: true,
  },
  {
    label: 'CPTAC-BRCA DICOM-WSI (slides.html)',
    marker: 'dicom-wsi/cptac-brca/manifest.json',
    script: 'fetch-dicom-wsi.ts',
    args: [],
    default: true,
  },
  {
    label: 'richtmyer-meshkov OME-Zarr (range.html)',
    marker: 'omezarr/richtmyer_meshkov.ome.zarr/zarr.json',
    script: 'fetch-omezarr.ts',
    args: ['--name=richtmyer_meshkov'],
    default: false,
  },
  {
    label: 'pig_heart OME-Zarr, int16 (range.html)',
    marker: 'omezarr/pig_heart.ome.zarr/zarr.json',
    script: 'fetch-omezarr.ts',
    args: ['--name=pig_heart'],
    default: false,
  },
]

interface Options {
  all: boolean
  force: boolean
}

function parseArgs(): Options {
  const flags = new Set(
    process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')[0]),
  )
  return { all: flags.has('all'), force: flags.has('force') }
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

// Run a fetch script as a child process, streaming its output through, and
// resolve with its exit code.
function runFetch(script: string, args: string[]): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn('bun', [path.join(__dirname, script), ...args], {
      stdio: 'inherit',
    })
    child.on('close', (code) => resolve(code ?? 1))
    child.on('error', () => resolve(1))
  })
}

async function main(): Promise<void> {
  const opts = parseArgs()
  const wanted = SAMPLES.filter((s) => opts.all || s.default)

  console.log(
    `Ensuring ${wanted.length} sample(s)` +
      (opts.all ? ' (--all)' : ' (default set; --all for more)') +
      `${opts.force ? ' (--force re-download)' : ''}`,
  )

  let downloaded = 0
  let present = 0
  let failed = 0
  for (const sample of wanted) {
    const here = await exists(path.join(PUBLIC, sample.marker))
    if (here && !opts.force) {
      console.log(`  [present] ${sample.label}`)
      present += 1
      continue
    }
    console.log(`  [fetch]   ${sample.label}`)
    const args = opts.force ? [...sample.args, '--force'] : sample.args
    const code = await runFetch(sample.script, args)
    if (code === 0) {
      downloaded += 1
    } else {
      failed += 1
      console.warn(`  [fail]    ${sample.label} (exit ${code})`)
    }
  }

  console.log(
    `\nSamples: ${present} present, ${downloaded} downloaded, ${failed} failed.`,
  )
  if (failed > 0) process.exit(1)
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
