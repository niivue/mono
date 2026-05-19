// Download one DICOM-WSI series from the public NCI Imaging Data Commons
// (IDC) bucket into fixtures/dicom-wsi/<name>_dicom/.
//
// IDC stores each DICOM instance as a flat object under the bucket root,
// keyed by the series UUID. For a given series UUID, listing the bucket
// with that prefix returns every .dcm file in the series — typically one
// per pyramid level / tile group for a WSI.
//
// The `_dicom` suffix on the output directory is what the existing
// dicomAdapter.canHandle() regex looks for (see src/adapters/dicom.ts).
//
// Usage:
//   bun run scripts/fetch-dicom-wsi.ts                          (defaults below)
//   bun run scripts/fetch-dicom-wsi.ts --series=<series-uuid>
//   bun run scripts/fetch-dicom-wsi.ts --series=<uuid> --name=tcga-kich-001
//
// The default series is a CPTAC-BRCA WSI series verified anonymously
// readable on idc-open-data. To pick another, grab a series UUID from
// https://portal.imaging.datacommons.cancer.gov/ (it appears in series
// metadata as SeriesInstanceUID, and IDC's bucket key is the same UUID).

import fs from 'node:fs/promises'
import path from 'node:path'
import url from 'node:url'

const __dirname = path.dirname(url.fileURLToPath(import.meta.url))

interface Options {
  bucket: string
  seriesUuid: string
  outDir: string
  concurrency: number
  force: boolean
  maxBytes: number
}

interface S3Object {
  key: string
  size: number
}

const DEFAULT_SERIES = 'cdac3f73-4fc9-4e0d-913b-b64aa3100977'

function parseArgs(): Options {
  const args = new Map<string, string>()
  for (const raw of process.argv.slice(2)) {
    const m = /^--([^=]+)=(.*)$/.exec(raw)
    if (m) args.set(m[1] ?? '', m[2] ?? '')
    else if (raw === '--force') args.set('force', 'true')
  }
  const env = process.env
  const bucket = args.get('bucket') ?? env.IDC_BUCKET ?? 'idc-open-data'
  const seriesUuid = args.get('series') ?? env.IDC_SERIES_UUID ?? DEFAULT_SERIES
  if (!/^[0-9a-f-]{36}$/i.test(seriesUuid)) {
    throw new Error(
      `series UUID must be a 36-character UUID, got '${seriesUuid}'`,
    )
  }
  // Short-prefix name keeps fixtures readable in `ls`; full UUID would
  // make the registry / IIIF id ugly. The full UUID is recoverable from
  // the contained .dcm filenames if needed.
  const defaultName = `idc-${seriesUuid.slice(0, 8)}`
  const name = args.get('name') ?? defaultName
  const fixturesDir = path.resolve(
    args.get('fixtures') ??
      env.FIXTURES_DIR ??
      path.resolve(__dirname, '..', 'fixtures'),
  )
  // _dicom suffix matches dicomAdapter.canHandle() regex.
  const outDir = path.join(fixturesDir, 'dicom-wsi', `${name}_dicom`)
  const concurrency = Math.max(
    1,
    Number(args.get('concurrency') ?? env.FETCH_CONCURRENCY ?? '8'),
  )
  const force = args.get('force') === 'true'
  const maxBytes =
    Number(args.get('max-mb') ?? env.DICOM_WSI_MAX_MB ?? '5000') * 1024 * 1024
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
    throw new Error(
      `max-mb must be a positive number, got ${args.get('max-mb')}`,
    )
  }
  return { bucket, seriesUuid, outDir, concurrency, force, maxBytes }
}

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
  // Buffer to RAM: Bun.write(path, Response) hangs in the current bun
  // build on darwin. DICOM-WSI instances are typically <100MB each.
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
  console.log(`Fetching DICOM-WSI series:`)
  console.log(`  bucket:      ${opts.bucket}`)
  console.log(`  series:      ${opts.seriesUuid}`)
  console.log(`  destination: ${opts.outDir}`)
  console.log(
    `  cap:         ${formatBytes(opts.maxBytes)} (use --force to override)`,
  )

  await fs.mkdir(opts.outDir, { recursive: true })

  // IDC layout is `s3://idc-open-data/<series-uuid>/<instance-uuid>.dcm`,
  // so the series UUID is itself the listing prefix.
  const prefix = `${opts.seriesUuid}/`
  console.log(`Listing s3://${opts.bucket}/${prefix} ...`)
  const all: S3Object[] = []
  for await (const obj of listObjects(opts.bucket, prefix)) {
    if (obj.key.endsWith('.dcm')) all.push(obj)
  }
  if (all.length === 0) {
    throw new Error(
      `No .dcm objects under s3://${opts.bucket}/${prefix} — series UUID may be wrong or private.`,
    )
  }
  const totalBytes = all.reduce((s, o) => s + o.size, 0)
  console.log(
    `Found ${all.length} .dcm file(s), ${formatBytes(totalBytes)} total.`,
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
  await runWithConcurrency(all, opts.concurrency, async (obj) => {
    const basename = path.basename(obj.key)
    const dest = path.join(opts.outDir, basename)
    if (await fileExists(dest)) {
      skipped += 1
      return
    }
    try {
      await downloadObject(opts.bucket, obj.key, dest)
      downloaded += 1
      console.log(`  [ok] ${basename} (${formatBytes(obj.size)})`)
    } catch (err) {
      failed += 1
      const msg = err instanceof Error ? err.message : String(err)
      console.warn(`  [fail] ${basename}: ${msg}`)
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
