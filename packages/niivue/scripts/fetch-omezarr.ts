// Download an Open SciVis OME-Zarr volume into public/omezarr/<id>/ so the
// `range.html` chunk-streaming example can discover and stream it. The stores
// are NOT checked into git (see .gitignore) -- run this script once per volume
// to make the source available.
//
// These are OME-Zarr 0.5 (Zarr v3) pyramids in the public `ome-zarr-scivis` S3
// bucket. The demo only supports uint8/uint16 scalar stores, so the catalog
// below is limited to those. At full resolution they are multi-gigabyte, so by
// default this fetches only the two coarsest levels -- enough for the demo to
// render. Use --levels / --all to pull more.
//
// Usage:
//   bun run scripts/fetch-omezarr.ts --list                 # show catalog
//   bun run scripts/fetch-omezarr.ts --name=pawpawsaurus    # coarse levels
//   bun run scripts/fetch-omezarr.ts --name=richtmyer_meshkov --all
//   bun run scripts/fetch-omezarr.ts --name=pawpawsaurus --levels=2,3
//   bun run scripts/fetch-omezarr.ts --name=pawpawsaurus --force
//
// Restart the dev server after fetching so vite serves the new files.

import fs from 'node:fs/promises'
import path from 'node:path'
import url from 'node:url'

const __dirname = path.dirname(url.fileURLToPath(import.meta.url))

const BUCKET = 'ome-zarr-scivis'
const BASE_PREFIX = 'v0.5/96x2/'

interface CatalogEntry {
  // Store leaf without the `.ome.zarr` suffix; also the fixture dir name.
  name: string
  label: string
  // Number of pyramid levels (scale0..scaleN-1); largest index is coarsest.
  levelCount: number
}

// uint8/uint16/int16 scivis stores (what range.html supports). float32 stores
// (e.g. miranda) are intentionally omitted.
const CATALOG: CatalogEntry[] = [
  {
    name: 'pawpawsaurus',
    label: 'fossil CT, 958x646x1088, uint16, 4 levels',
    levelCount: 4,
  },
  {
    name: 'richtmyer_meshkov',
    label: 'instability sim, 2048x2048x1920, uint8, 5 levels',
    levelCount: 5,
  },
  {
    name: 'pig_heart',
    label: 'microCT, 2048x2048x2612, int16, 5 levels',
    levelCount: 5,
  },
]

interface Options {
  list: boolean
  name: string
  all: boolean
  levels: number[]
  force: boolean
  concurrency: number
  out: string | null
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
  const concurrency = Math.max(
    1,
    Number(flags.get('concurrency') ?? env.FETCH_CONCURRENCY ?? '8'),
  )
  const levels = (flags.get('levels') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0) // Number('') === 0, so drop empties first
    .map((s) => Number(s))
    .filter((n) => Number.isInteger(n) && n >= 0)
  return {
    list: flags.get('list') === 'true',
    name: flags.get('name') ?? env.OMEZARR_NAME ?? '',
    all: flags.get('all') === 'true',
    levels,
    force: flags.get('force') === 'true',
    concurrency,
    out: flags.get('out') ?? env.OMEZARR_OUT ?? null,
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

// Keep an object if it is store-level metadata (the root zarr.json and any
// per-scale group zarr.json) or it belongs to one of the wanted scale levels.
function wantObject(relKey: string, wantedLevels: Set<number> | null): boolean {
  if (wantedLevels === null) return true
  const scaleMatch = /(?:^|\/)scale(\d+)\//.exec(relKey)
  if (!scaleMatch) return true // root/store metadata
  return wantedLevels.has(Number(scaleMatch[1]))
}

function printCatalog(): void {
  console.log('Open SciVis OME-Zarr stores supported by range.html:\n')
  for (const d of CATALOG) {
    console.log(`  ${d.name.padEnd(20)} ${d.label}`)
  }
  console.log('\nPick one with --name=<name>.')
}

// Default coarse levels: the two coarsest (largest scale indices), which are
// small (tens of MB) and give the demo a usable progressive view.
function defaultLevels(entry: CatalogEntry): number[] {
  const top = entry.levelCount - 1
  return top > 0 ? [top - 1, top] : [top]
}

async function main(): Promise<void> {
  const opts = parseArgs()
  if (opts.list || !opts.name) {
    printCatalog()
    return
  }
  const entry = CATALOG.find((d) => d.name === opts.name)
  if (!entry) {
    throw new Error(
      `Unknown store '${opts.name}'. Run with --list to see names.`,
    )
  }

  const storeId = `${entry.name}.ome.zarr`
  const storePrefix = `${BASE_PREFIX}${storeId}/`
  const outDir = path.resolve(
    opts.out ?? path.resolve(__dirname, '..', 'public', 'omezarr', storeId),
  )

  // null => keep every level; otherwise the explicit set of scale indices.
  const wantedLevels: Set<number> | null = opts.all
    ? null
    : new Set(opts.levels.length > 0 ? opts.levels : defaultLevels(entry))

  const levelLabel = wantedLevels
    ? `scale ${[...wantedLevels].sort((a, b) => a - b).join(', ')}`
    : 'all levels'
  console.log(`Fetching ${storeId} (${levelLabel})`)
  console.log(`  source: s3://${BUCKET}/${storePrefix}`)
  console.log(`  dest:   ${outDir}`)
  console.log('  listing store ...')

  const all: S3Object[] = []
  for await (const obj of listObjects(storePrefix)) all.push(obj)
  if (all.length === 0) {
    throw new Error('no objects found -- store may have moved')
  }

  const selected = all.filter((o) =>
    wantObject(o.key.slice(storePrefix.length), wantedLevels),
  )
  const totalBytes = selected.reduce((sum, o) => sum + o.size, 0)
  console.log(
    `  ${selected.length} / ${all.length} objects, ${formatBytes(totalBytes)}`,
  )

  let downloaded = 0
  let skipped = 0
  let failed = 0
  await runWithConcurrency(selected, opts.concurrency, async (obj) => {
    const relKey = obj.key.slice(storePrefix.length)
    const dest = path.join(outDir, relKey)
    if (!opts.force && (await fileExists(dest))) {
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
    `\ndone: downloaded=${downloaded} skipped=${skipped} failed=${failed}`,
  )
  console.log(
    `Restart the dev server, then pick "${entry.name}" in range.html.`,
  )
  if (failed > 0) process.exit(1)
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
