// Download the Pawpawsaurus OME-Zarr volume into
// public/omezarr/pawpawsaurus.ome.zarr/ so the `range.html` chunk-streaming
// example can discover and stream it. The store is NOT checked into git
// (see .gitignore) -- run this script once to make the source available.
//
// Pawpawsaurus is a fossil CT scan (958x646x1088, uint16) published in the
// Open SciVis Datasets collection as an OME-Zarr 0.5 (Zarr v3) pyramid in the
// public `ome-zarr-scivis` S3 bucket. It is a multi-gigabyte store at full
// resolution, so by default this fetches only the two coarsest levels
// (scale2 + scale3) -- enough for the demo to render. Use flags to pull more.
//
// Usage:
//   bun run scripts/fetch-pawpawsaurus.ts            # coarse levels (default)
//   bun run scripts/fetch-pawpawsaurus.ts --all      # every level (multi-GB)
//   bun run scripts/fetch-pawpawsaurus.ts --levels=3 # only scale3 (smallest)
//   bun run scripts/fetch-pawpawsaurus.ts --force    # re-download everything
//
// Restart the dev server after fetching so vite serves the new files.

import fs from 'node:fs/promises'
import path from 'node:path'
import url from 'node:url'

const __dirname = path.dirname(url.fileURLToPath(import.meta.url))

const BUCKET = 'ome-zarr-scivis'
const STORE_PREFIX = 'v0.5/96x2/pawpawsaurus.ome.zarr/'
// Coarsest-first levels pulled when no --levels/--all flag is given. scale2 and
// scale3 are small (~tens of MB) and give the demo a usable progressive view.
const DEFAULT_LEVELS = [2, 3]

interface Options {
  all: boolean
  levels: number[]
  force: boolean
  concurrency: number
  outDir: string
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
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n >= 0)
  const defaultOut = path.resolve(
    __dirname,
    '..',
    'public',
    'omezarr',
    'pawpawsaurus.ome.zarr',
  )
  return {
    all: flags.get('all') === 'true',
    levels,
    force: flags.get('force') === 'true',
    concurrency,
    outDir: path.resolve(flags.get('out') ?? env.PAWPAW_OUT ?? defaultOut),
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

async function main(): Promise<void> {
  const opts = parseArgs()
  // null => keep every level; otherwise the explicit set of scale indices.
  const wantedLevels: Set<number> | null = opts.all
    ? null
    : new Set(opts.levels.length > 0 ? opts.levels : DEFAULT_LEVELS)

  const levelLabel = wantedLevels
    ? `scale ${[...wantedLevels].sort((a, b) => a - b).join(', ')}`
    : 'all levels'
  console.log(`Fetching pawpawsaurus.ome.zarr (${levelLabel})`)
  console.log(`  source: s3://${BUCKET}/${STORE_PREFIX}`)
  console.log(`  dest:   ${opts.outDir}`)
  console.log('  listing store ...')

  const all: S3Object[] = []
  for await (const obj of listObjects(STORE_PREFIX)) all.push(obj)
  if (all.length === 0) {
    throw new Error('no objects found — store may have moved')
  }

  const selected = all.filter((o) =>
    wantObject(o.key.slice(STORE_PREFIX.length), wantedLevels),
  )
  const totalBytes = selected.reduce((sum, o) => sum + o.size, 0)
  console.log(
    `  ${selected.length} / ${all.length} objects, ${formatBytes(totalBytes)}`,
  )

  let downloaded = 0
  let skipped = 0
  let failed = 0
  await runWithConcurrency(selected, opts.concurrency, async (obj) => {
    const relKey = obj.key.slice(STORE_PREFIX.length)
    const dest = path.join(opts.outDir, relKey)
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
    'Restart the dev server, then pick "pawpawsaurus OME-Zarr" in range.html.',
  )
  if (failed > 0) process.exit(1)
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
