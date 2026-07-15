// Download OME-Zarr volumes from the Open SciVis Datasets collection into
// fixtures/omezarr/<name>.ome.zarr/ so the iiif-volumetric demo can serve
// them alongside pawpawsaurus.
//
// These are the same datasets offered by the niivue OME-Zarr viewer demo
// (https://niivue.com/demos/features/ome-zarr.html), hosted as OME-Zarr
// 0.5 (Zarr v3) pyramids in the public `ome-zarr-scivis` S3 bucket. Each
// store is a full multiscale pyramid: a root zarr.json plus scale0/ (full
// resolution) ... scaleN/ (coarsest).
//
// Whole stores are downloaded so the demo's progressive level-of-detail
// works end to end. A per-dataset size cap (--max-mb) skips the giants by
// default; --coarse drops the full-resolution scale0 level so a large
// pyramid can still be pulled at a fraction of the size (the demo paints
// coarse-first, so it stays useful — only zoom-to-full-res is lost).
//
// Usage:
//   bun run scripts/fetch-scivis-omezarr.ts --list
//   bun run scripts/fetch-scivis-omezarr.ts --name=bonsai,foot,carp
//   bun run scripts/fetch-scivis-omezarr.ts --name=chameleon --coarse
//   bun run scripts/fetch-scivis-omezarr.ts --all --max-mb=2000
//
// After fetching, restart the server (bun run dev) so the registry
// re-scans the fixtures directory and picks up the new volumes.

import fs from 'node:fs/promises'
import path from 'node:path'
import url from 'node:url'

const __dirname = path.dirname(url.fileURLToPath(import.meta.url))

const BUCKET = 'ome-zarr-scivis'
const BASE_PREFIX = 'v0.5/96x2/'

interface Dataset {
  category: string
  // Store leaf without the `.ome.zarr` suffix; also the fixture dir name.
  name: string
  label: string
}

// Mirrors the dataset menu on the niivue OME-Zarr viewer demo page.
const CATALOG: Dataset[] = [
  { category: 'CT', name: 'aneurism', label: 'head arteries, 256^3, uint8' },
  {
    category: 'CT',
    name: 'backpack',
    label: 'CT of backpack, 512x512x373, uint16',
  }, // prettier-ignore
  {
    category: 'CT',
    name: 'beechnut',
    label: 'microCT, 1024x1024x1546, uint16',
  },
  { category: 'CT', name: 'bonsai', label: 'CT of tree, 256^3, uint8' },
  {
    category: 'CT',
    name: 'boston_teapot',
    label: 'SIGGRAPH teapot, 256x256x178, uint8',
  }, // prettier-ignore
  {
    category: 'CT',
    name: 'bunny',
    label: 'Stanford Bunny CT, 512x512x361, uint16',
  }, // prettier-ignore
  { category: 'CT', name: 'carp', label: 'fish CT, 256x256x512, uint16' },
  { category: 'CT', name: 'chameleon', label: 'CT, 1024x1024x1080, uint16' },
  { category: 'CT', name: 'christmas_tree', label: 'CT, 512x499x512, uint16' },
  {
    category: 'CT',
    name: 'engine',
    label: 'engine block CT, 256x256x128, uint8',
  }, // prettier-ignore
  { category: 'CT', name: 'foot', label: 'human foot, 256^3, uint8' },
  {
    category: 'CT',
    name: 'kingsnake',
    label: 'snake egg CT, 1024x1024x795, uint8',
  }, // prettier-ignore
  { category: 'CT', name: 'lobster', label: 'CT in resin, 301x324x56, uint8' },
  {
    category: 'CT',
    name: 'pancreas',
    label: 'abdominal CT, 240x512x512, int16',
  },
  {
    category: 'CT',
    name: 'pawpawsaurus',
    label: 'fossil CT, 958x646x1088, uint16',
  }, // prettier-ignore
  {
    category: 'CT',
    name: 'pig_heart',
    label: 'microCT, 2048x2048x2612, int16',
  },
  {
    category: 'CT',
    name: 'present',
    label: 'industrial CT, 492x492x442, uint16',
  },
  { category: 'CT', name: 'prone', label: 'abdomen CT, 512x512x463, uint16' },
  { category: 'CT', name: 'skull', label: 'phantom skull, 256^3, uint8' },
  {
    category: 'CT',
    name: 'spathorhynchus',
    label: 'fossil CT, 1024x1024x750, uint16',
  }, // prettier-ignore
  {
    category: 'CT',
    name: 'stag_beetle',
    label: 'industrial CT, 832x832x494, uint16',
  }, // prettier-ignore
  {
    category: 'CT',
    name: 'statue_leg',
    label: 'bronze statue CT, 341x341x93, uint8',
  }, // prettier-ignore
  {
    category: 'CT',
    name: 'stent',
    label: 'abdomen with stent, 512x512x174, uint16',
  }, // prettier-ignore
  {
    category: 'CT',
    name: 'synthetic_truss_with_five_defects',
    label: 'simulated CT, 1200^3, float32',
  }, // prettier-ignore
  { category: 'CT', name: 'vertebra', label: 'angiography, 512^3, uint16' },
  { category: 'CT', name: 'vis_male', label: 'head scan, 128x256x256, uint8' },
  { category: 'CT', name: 'woodbranch', label: 'microCT, 2048^3, uint16' },
  { category: 'CT', name: 'zeiss', label: 'car part CT, 680^3, uint8' },
  { category: 'MRI', name: 'frog', label: 'MRI, 256x256x44, uint8' },
  {
    category: 'MRI',
    name: 'mri_ventricles',
    label: 'head CSF, 256x256x124, uint8',
  }, // prettier-ignore
  {
    category: 'MRI',
    name: 'mri_woman',
    label: 'head MRI, 256x256x109, uint16',
  },
  {
    category: 'MRI',
    name: 'mrt_angio',
    label: 'head angiography, 416x512x112, uint16',
  }, // prettier-ignore
  {
    category: 'Microscopy',
    name: 'marmoset_neurons',
    label: 'V1 cortex, 1024x1024x314, uint8',
  }, // prettier-ignore
  {
    category: 'Microscopy',
    name: 'neocortical_layer_1_axons',
    label: 'barrel cortex, 1464x1033x76, uint8',
  }, // prettier-ignore
  {
    category: 'Simulation',
    name: 'blunt_fin',
    label: 'flow sim, 256x128x64, uint8',
  }, // prettier-ignore
  {
    category: 'Simulation',
    name: 'csafe_heptane',
    label: 'combustion sim, 302^3, uint8',
  }, // prettier-ignore
  {
    category: 'Simulation',
    name: 'duct',
    label: 'wall-bounded flow, 193x194x1000, float32',
  }, // prettier-ignore
  {
    category: 'Simulation',
    name: 'fuel',
    label: 'fuel injection sim, 64^3, uint8',
  },
  {
    category: 'Simulation',
    name: 'hcci_oh',
    label: 'autoignition sim, 560^3, float32',
  }, // prettier-ignore
  {
    category: 'Simulation',
    name: 'hydrogen_atom',
    label: 'electron dist, 128^3, uint8',
  }, // prettier-ignore
  {
    category: 'Simulation',
    name: 'jicf_q',
    label: 'jet crossflow, 1408x1080x1100, float32',
  }, // prettier-ignore
  {
    category: 'Simulation',
    name: 'magnetic_reconnection',
    label: 'sim, 512^3, float32',
  }, // prettier-ignore
  {
    category: 'Simulation',
    name: 'marschner_lobb',
    label: 'high freq test, 41^3, uint8',
  }, // prettier-ignore
  {
    category: 'Simulation',
    name: 'miranda',
    label: 'Rayleigh-Taylor sim, 1024^3, float32',
  }, // prettier-ignore
  {
    category: 'Simulation',
    name: 'neghip',
    label: 'protein electron dist, 64^3, uint8',
  }, // prettier-ignore
  {
    category: 'Simulation',
    name: 'nucleon',
    label: 'nuclear sim, 41^3, uint8',
  },
  {
    category: 'Simulation',
    name: 'richtmyer_meshkov',
    label: 'instability, 2048x2048x1920, uint8',
  }, // prettier-ignore
  {
    category: 'Simulation',
    name: 'shockwave',
    label: 'planar shock sim, 64x64x512, uint8',
  }, // prettier-ignore
  {
    category: 'Simulation',
    name: 'silicium',
    label: 'grid sim, 98x34x34, uint8',
  },
  {
    category: 'Simulation',
    name: 'tacc_turbulence',
    label: 'enstrophy, 256^3, float32',
  }, // prettier-ignore
  { category: 'Other', name: 'tooth', label: '103x94x161, uint8' },
]

interface Options {
  list: boolean
  all: boolean
  names: string[]
  coarse: boolean
  force: boolean
  concurrency: number
  maxBytes: number
  fixturesDir: string
}

interface S3Object {
  key: string
  size: number
}

function parseArgs(): Options {
  const flags = new Map<string, string>()
  for (const raw of process.argv.slice(2)) {
    const m = /^--([^=]+)=(.*)$/.exec(raw)
    if (m) flags.set(m[1] ?? '', m[2] ?? '')
    else if (raw.startsWith('--')) flags.set(raw.slice(2), 'true')
  }
  const env = process.env
  const names = (flags.get('name') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  const concurrency = Math.max(
    1,
    Number(flags.get('concurrency') ?? env.FETCH_CONCURRENCY ?? '8'),
  )
  const maxMb = Number(flags.get('max-mb') ?? env.OMEZARR_MAX_MB ?? '4000')
  if (!Number.isFinite(maxMb) || maxMb <= 0) {
    throw new Error(
      `max-mb must be a positive number, got ${flags.get('max-mb')}`,
    ) // prettier-ignore
  }
  const fixturesDir = path.resolve(
    flags.get('fixtures') ??
      env.FIXTURES_DIR ??
      path.resolve(__dirname, '..', 'fixtures'),
  )
  return {
    list: flags.get('list') === 'true',
    all: flags.get('all') === 'true',
    names,
    coarse: flags.get('coarse') === 'true',
    force: flags.get('force') === 'true',
    concurrency,
    maxBytes: maxMb * 1024 * 1024,
    fixturesDir,
  }
}

// Anonymous S3 ListObjectsV2 over virtual-host HTTPS. The XML response is
// small enough that a regex parse beats pulling in an XML dependency.
async function* listObjects(prefix: string): AsyncGenerator<S3Object> {
  let token: string | undefined
  do {
    const u = new URL(`https://${BUCKET}.s3.amazonaws.com/`)
    u.searchParams.set('list-type', '2')
    u.searchParams.set('prefix', prefix)
    if (token) u.searchParams.set('continuation-token', token)
    const res = await fetch(u)
    if (!res.ok) {
      throw new Error(
        `S3 list failed for ${prefix}: ${res.status} ${res.statusText}`,
      )
    }
    const body = await res.text()
    for (const m of body.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
      const inner = m[1] ?? ''
      const keyMatch = /<Key>([^<]+)<\/Key>/.exec(inner)
      const sizeMatch = /<Size>(\d+)<\/Size>/.exec(inner)
      if (keyMatch && sizeMatch) {
        yield { key: keyMatch[1] ?? '', size: Number(sizeMatch[1]) }
      }
    }
    const nextMatch =
      /<NextContinuationToken>([^<]+)<\/NextContinuationToken>/.exec(body)
    token = nextMatch ? nextMatch[1] : undefined
  } while (token)
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

async function downloadObject(key: string, dest: string): Promise<void> {
  const tmp = `${dest}.part`
  const srcUrl = `https://${BUCKET}.s3.amazonaws.com/${key
    .split('/')
    .map(encodeURIComponent)
    .join('/')}`
  const res = await fetch(srcUrl)
  if (!res.ok || !res.body) {
    throw new Error(`${srcUrl}: ${res.status} ${res.statusText}`)
  }
  await fs.mkdir(path.dirname(tmp), { recursive: true })
  // Buffer to RAM before writing: Bun.write(path, Response) can stall on
  // darwin. Fine for pyramid chunks, which are sub-MB each.
  await Bun.write(tmp, await res.arrayBuffer())
  await fs.rename(tmp, dest)
}

async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let index = 0
  async function next(): Promise<void> {
    while (true) {
      const i = index
      index += 1
      if (i >= items.length) return
      await worker(items[i] as T)
    }
  }
  const runners: Array<Promise<void>> = []
  for (let i = 0; i < Math.min(limit, items.length); i++) runners.push(next())
  await Promise.all(runners)
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

function printCatalog(): void {
  let category = ''
  for (const d of CATALOG) {
    if (d.category !== category) {
      category = d.category
      console.log(`\n${category}`)
    }
    console.log(`  ${d.name.padEnd(34)} ${d.label}`)
  }
  console.log(`\n${CATALOG.length} datasets. Pass --name=a,b,c or --all.`)
}

function resolveDatasets(opts: Options): Dataset[] {
  if (opts.all) return CATALOG
  const picked: Dataset[] = []
  for (const wanted of opts.names) {
    const match = CATALOG.find((d) => d.name === wanted)
    if (!match) {
      throw new Error(
        `Unknown dataset '${wanted}'. Run with --list to see valid names.`,
      )
    }
    picked.push(match)
  }
  return picked
}

// Fetch one whole store. Returns false if it was skipped (over the cap).
async function fetchDataset(d: Dataset, opts: Options): Promise<boolean> {
  const storePrefix = `${BASE_PREFIX}${d.name}.ome.zarr/`
  const outDir = path.join(opts.fixturesDir, 'omezarr', `${d.name}.ome.zarr`)
  console.log(`\n${d.name} (${d.label})`)
  console.log(`  listing s3://${BUCKET}/${storePrefix} ...`)

  let objects: S3Object[] = []
  for await (const obj of listObjects(storePrefix)) objects.push(obj)
  if (objects.length === 0) {
    console.warn(`  [skip] no objects found — store may have moved`)
    return false
  }
  // --coarse drops the full-resolution level so a large pyramid can be
  // pulled cheaply; the root zarr.json and every coarser level stay.
  if (opts.coarse) {
    objects = objects.filter((o) => !o.key.includes('/scale0/'))
  }

  const totalBytes = objects.reduce((sum, o) => sum + o.size, 0)
  console.log(
    `  ${objects.length} objects, ${formatBytes(totalBytes)}` +
      (opts.coarse ? ' (coarse: full-res level excluded)' : ''),
  )
  if (totalBytes > opts.maxBytes && !opts.force) {
    console.warn(
      `  [skip] exceeds cap ${formatBytes(opts.maxBytes)} — ` +
        `raise --max-mb, add --coarse, or --force`,
    )
    return false
  }

  let downloaded = 0
  let skipped = 0
  let failed = 0
  await runWithConcurrency(objects, opts.concurrency, async (obj) => {
    const relKey = obj.key.slice(storePrefix.length)
    const dest = path.join(outDir, relKey)
    if (await fileExists(dest)) {
      skipped += 1
      return
    }
    try {
      await downloadObject(obj.key, dest)
      downloaded += 1
    } catch (err) {
      failed += 1
      const msg = err instanceof Error ? err.message : String(err)
      console.warn(`  [fail] ${relKey}: ${msg}`)
    }
  })
  console.log(
    `  done: downloaded=${downloaded} skipped=${skipped} failed=${failed}`,
  )
  return failed === 0
}

async function main(): Promise<void> {
  const opts = parseArgs()
  if (opts.list) {
    printCatalog()
    return
  }
  const datasets = resolveDatasets(opts)
  if (datasets.length === 0) {
    console.log('Open SciVis OME-Zarr fetcher.\n')
    console.log(
      'Pick datasets with --name=a,b,c or fetch everything with --all.',
    ) // prettier-ignore
    printCatalog()
    return
  }

  console.log(
    `Fetching ${datasets.length} dataset(s) -> ${path.join(opts.fixturesDir, 'omezarr')}`,
  )
  console.log(
    `Per-dataset cap: ${formatBytes(opts.maxBytes)}` +
      (opts.force ? ' (ignored: --force)' : ''),
  )

  const fetched: string[] = []
  const skippedDatasets: string[] = []
  let hadFailure = false
  for (const d of datasets) {
    const ok = await fetchDataset(d, opts)
    if (ok) fetched.push(d.name)
    else skippedDatasets.push(d.name)
    if (!ok) hadFailure = true
  }

  console.log(`\nFetched ${fetched.length}: ${fetched.join(', ') || '(none)'}`)
  if (skippedDatasets.length > 0) {
    console.log(
      `Skipped ${skippedDatasets.length}: ${skippedDatasets.join(', ')}`,
    ) // prettier-ignore
  }
  console.log('Restart the server (bun run dev) to register new volumes.')
  if (hadFailure) process.exit(1)
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
