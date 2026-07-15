// Download an OME-Zarr fixture from a public anonymous S3 bucket into
// fixtures/omezarr/<name>.zarr/. The script preserves the upstream
// directory tree so the standard OME-Zarr layout is intact for the
// adapter to walk.
//
// Default is Janelia OpenOrganelle jrc_hela-2's FIB-SEM EM image group
// (OME-Zarr v0.4, single-channel uint8). The full s0 pyramid level is
// ~120 GB; this script defaults to s4 (~15 MB) so a fresh checkout pulls
// something runnable in seconds. Pass --level=s3 / s2 / s1 / s0 to go
// bigger.
//
// IMPORTANT: the default prefix points at the OME-Zarr *image group*
// (recon-1/em/fibsem-uint8/), not the outer jrc_hela-2.zarr/ container
// — that container holds many sibling images (segmentations, predictions,
// labels) totalling hundreds of thousands of objects. Pulling all of
// them would take hours and produce data we can't render.
//
// Usage:
//   bun run scripts/fetch-omezarr.ts                          (defaults below)
//   bun run scripts/fetch-omezarr.ts --level=s2 --max-mb=4000
//   bun run scripts/fetch-omezarr.ts --bucket=idr --prefix=zarr/v0.4/idr0048A/9846152.zarr/ --level=0
//
// Strategy: fetch the root-level metadata files (.zattrs / .zgroup /
// zarr.json) directly by path, then list ONLY the chosen --level's
// prefix. Listing the whole image group would pull s0's chunk index
// (often tens of thousands of objects) just to discard it — wasteful
// when we only want one level's data.

import fs from 'node:fs/promises'
import path from 'node:path'
import url from 'node:url'

const __dirname = path.dirname(url.fileURLToPath(import.meta.url))

interface Options {
  bucket: string
  rootPrefix: string
  level: string
  outDir: string
  concurrency: number
  force: boolean
  maxBytes: number
}

interface S3Object {
  key: string
  size: number
}

function parseArgs(): Options {
  const args = new Map<string, string>()
  for (const raw of process.argv.slice(2)) {
    const m = /^--([^=]+)=(.*)$/.exec(raw)
    if (m) args.set(m[1] ?? '', m[2] ?? '')
    else if (raw === '--force') args.set('force', 'true')
  }
  const env = process.env
  const bucket =
    args.get('bucket') ?? env.OMEZARR_BUCKET ?? 'janelia-cosem-datasets'
  // Trailing slash is required so list-prefix doesn't accidentally match
  // sibling buckets/prefixes (e.g. "foo.zarr-other/...").
  const rootPrefix = (
    args.get('prefix') ??
    env.OMEZARR_PREFIX ??
    'jrc_hela-2/jrc_hela-2.zarr/recon-1/em/fibsem-uint8/'
  ).replace(/\/?$/, '/')
  const level = args.get('level') ?? env.OMEZARR_LEVEL ?? 's4'
  // Default name: leaf segment of the prefix, with `.zarr` appended if it
  // doesn't already end that way — so the output dir matches the
  // omezarrAdapter.canHandle() regex (/\.(ome\.)?zarr$/i).
  const leaf = rootPrefix.replace(/\/$/, '').split('/').pop() ?? 'volume.zarr'
  const defaultName = /\.(ome\.)?zarr$/i.test(leaf) ? leaf : `${leaf}.zarr`
  const name = args.get('name') ?? defaultName
  const fixturesDir = path.resolve(
    args.get('fixtures') ??
      env.FIXTURES_DIR ??
      path.resolve(__dirname, '..', 'fixtures'),
  )
  const outDir = path.join(fixturesDir, 'omezarr', name)
  const concurrency = Math.max(
    1,
    Number(args.get('concurrency') ?? env.FETCH_CONCURRENCY ?? '8'),
  )
  const force = args.get('force') === 'true'
  const maxBytes =
    Number(args.get('max-mb') ?? env.OMEZARR_MAX_MB ?? '5000') * 1024 * 1024
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
    throw new Error(
      `max-mb must be a positive number, got ${args.get('max-mb')}`,
    )
  }
  return { bucket, rootPrefix, level, outDir, concurrency, force, maxBytes }
}

// Anonymous S3 ListObjectsV2 via virtual-host HTTPS. Works for any public
// AWS Open Data Registry bucket. The XML response is small enough to
// parse with regex (proper SAX would pull in a dep for no real gain).
async function* listObjects(
  bucket: string,
  prefix: string,
): AsyncGenerator<S3Object> {
  let token: string | undefined
  do {
    const u = new URL(`https://${bucket}.s3.amazonaws.com/`)
    u.searchParams.set('list-type', '2')
    u.searchParams.set('prefix', prefix)
    if (token) u.searchParams.set('continuation-token', token)
    const res = await fetch(u)
    if (!res.ok) {
      throw new Error(
        `S3 list failed for ${bucket} ${prefix}: ${res.status} ${res.statusText}`,
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

function isMetadataBasename(basename: string): boolean {
  return (
    basename === '.zattrs' ||
    basename === '.zgroup' ||
    basename === '.zarray' ||
    basename === 'zarr.json'
  )
}

// Try to GET a known metadata file by absolute key; return null on 404.
// Used to probe well-known Zarr files (.zattrs / .zgroup / zarr.json)
// without paying for a recursive bucket listing.
async function tryHeadObject(
  bucket: string,
  key: string,
): Promise<S3Object | null> {
  const u = `https://${bucket}.s3.amazonaws.com/${key
    .split('/')
    .map(encodeURIComponent)
    .join('/')}`
  const res = await fetch(u, { method: 'HEAD' })
  if (!res.ok) return null
  const size = Number(res.headers.get('content-length') ?? '0')
  return { key, size }
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

async function downloadObject(
  bucket: string,
  key: string,
  dest: string,
): Promise<void> {
  const tmp = `${dest}.part`
  const srcUrl = `https://${bucket}.s3.amazonaws.com/${key
    .split('/')
    .map(encodeURIComponent)
    .join('/')}`
  const res = await fetch(srcUrl)
  if (!res.ok || !res.body) {
    throw new Error(`${srcUrl}: ${res.status} ${res.statusText}`)
  }
  await fs.mkdir(path.dirname(tmp), { recursive: true })
  // Buffer to RAM before write. Bun.write(path, Response) hangs in the
  // current bun build on darwin (silent stall after status-200), so we
  // pay the buffer cost. Fine for fixture-scale chunks (sub-MB at s4+);
  // if anyone ever fetches s0 single chunks (hundreds of MB) this would
  // need a stream-to-disk fallback.
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
      const item = items[i] as T
      await worker(item)
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

async function main(): Promise<void> {
  const opts = parseArgs()
  console.log(`Fetching OME-Zarr fixture:`)
  console.log(`  bucket:      ${opts.bucket}`)
  console.log(`  prefix:      ${opts.rootPrefix}`)
  console.log(`  level:       ${opts.level} (chunks at this level only)`)
  console.log(`  destination: ${opts.outDir}`)
  console.log(
    `  cap:         ${formatBytes(opts.maxBytes)} (use --force to override)`,
  )

  await fs.mkdir(opts.outDir, { recursive: true })

  // Phase 1: probe well-known root metadata files. The Zarr v2 + v3
  // specs only define a handful of root files (.zattrs, .zgroup,
  // zarr.json), so a few HEAD requests beat a recursive list. Misses
  // (404) are fine — different stores use different subsets.
  console.log(
    `Probing root metadata at s3://${opts.bucket}/${opts.rootPrefix} ...`,
  )
  const metaCandidates = ['.zattrs', '.zgroup', 'zarr.json']
  const rootMeta: S3Object[] = []
  for (const name of metaCandidates) {
    const obj = await tryHeadObject(opts.bucket, `${opts.rootPrefix}${name}`)
    if (obj) rootMeta.push(obj)
  }
  if (rootMeta.length === 0) {
    throw new Error(
      `No Zarr metadata (${metaCandidates.join(', ')}) at s3://${opts.bucket}/${opts.rootPrefix}. ` +
        `Is the prefix correct?`,
    )
  }

  // Phase 2: list the chosen level's prefix recursively. This gives us
  // the level's .zarray plus every chunk. Typical chunk counts: s5 ~few
  // dozen, s4 ~few hundred, s0 ~tens of thousands. Bounded — no need
  // for a hard cap here.
  const levelPrefix = `${opts.rootPrefix}${opts.level}/`
  console.log(`Listing s3://${opts.bucket}/${levelPrefix} ...`)
  const levelObjects: S3Object[] = []
  for await (const obj of listObjects(opts.bucket, levelPrefix)) {
    levelObjects.push(obj)
  }
  if (levelObjects.length === 0) {
    throw new Error(
      `No objects under s3://${opts.bucket}/${levelPrefix}. ` +
        `Level '${opts.level}' may not exist; check the bucket's pyramid layout.`,
    )
  }

  const toFetch: S3Object[] = [...rootMeta, ...levelObjects]
  let totalBytes = 0
  let metaCount = 0
  let chunkCount = 0
  for (const obj of toFetch) {
    totalBytes += obj.size
    if (isMetadataBasename(path.basename(obj.key))) metaCount += 1
    else chunkCount += 1
  }
  console.log(
    `Will fetch ${toFetch.length} objects ` +
      `(${metaCount} metadata, ${chunkCount} chunks at /${opts.level}/, ` +
      `${formatBytes(totalBytes)} total)`,
  )
  if (totalBytes > opts.maxBytes && !opts.force) {
    throw new Error(
      `Total ${formatBytes(totalBytes)} exceeds cap ${formatBytes(opts.maxBytes)}. ` +
        `Pass --max-mb=N to raise it, or --force to ignore.`,
    )
  }

  let downloaded = 0
  let skipped = 0
  let failed = 0
  await runWithConcurrency(toFetch, opts.concurrency, async (obj) => {
    const relKey = obj.key.slice(opts.rootPrefix.length)
    const dest = path.join(opts.outDir, relKey)
    if (await fileExists(dest)) {
      skipped += 1
      return
    }
    try {
      await downloadObject(opts.bucket, obj.key, dest)
      downloaded += 1
      if (downloaded % 50 === 0 || isMetadataBasename(path.basename(relKey))) {
        console.log(`  [ok] ${relKey}`)
      }
    } catch (err) {
      failed += 1
      const msg = err instanceof Error ? err.message : String(err)
      console.warn(`  [fail] ${relKey}: ${msg}`)
    }
  })

  console.log(
    `Done. downloaded=${downloaded} skipped=${skipped} failed=${failed} -> ${opts.outDir}`,
  )
  if (failed > 0) process.exit(1)
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
