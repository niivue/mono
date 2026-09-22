// Download an Allen "volume-viewer" JSON + PNG atlas dataset into
// fixtures/allen/ so the server has a real multi-channel source to serve.
//
// A dataset is one `<name>_atlas.json` sidecar plus the PNG atlases it lists
// in `images[]`. Both live in the same directory upstream, and the adapter
// resolves image names relative to the sidecar, so the fetch is: read the
// sidecar, then pull each image name from the same base URL.
//
// Usage:
//   bun run scripts/fetch-allen.ts                     (default dataset below)
//   bun run scripts/fetch-allen.ts --url=https://host/path/foo_atlas.json
//   bun run scripts/fetch-allen.ts --out=/tmp/allen --force
//
// Fixtures are NOT committed (see .gitignore) — the licence on the published
// Allen data is unconfirmed and this repo deploys publicly.

import fs from 'node:fs/promises'
import path from 'node:path'
import url from 'node:url'

const __dirname = path.dirname(url.fileURLToPath(import.meta.url))

// The IMSC 3D viewer's sample dataset: 32 channels, 256x256x58, ~11 atlases.
const DEFAULT_URL =
  'https://imsc.allencell.org/assets/COMP_crop_M1-M2_atlas.json'

interface Options {
  sidecarUrl: string
  outDir: string
  concurrency: number
  force: boolean
}

// A non-integer here is worse than a bad default: NaN or 0 makes
// runWithConcurrency spawn no workers, so the run "succeeds" downloading
// nothing. Exported for tests.
export function parseConcurrency(raw: string): number {
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`concurrency must be a positive integer, got '${raw}'`)
  }
  return n
}

function parseArgs(): Options {
  const args = new Map<string, string>()
  for (const raw of process.argv.slice(2)) {
    const m = /^--([^=]+)=(.*)$/.exec(raw)
    if (m) args.set(m[1] ?? '', m[2] ?? '')
    else if (raw === '--force') args.set('force', 'true')
  }
  const env = process.env
  const sidecarUrl = args.get('url') ?? env.ALLEN_ATLAS_URL ?? DEFAULT_URL
  if (!/_atlas\.json$/i.test(sidecarUrl)) {
    // The adapter only claims files matching this suffix, so a fixture named
    // anything else would download fine and then never be served.
    throw new Error(
      `--url must end in _atlas.json (the adapter's sidecar pattern), got ${sidecarUrl}`,
    )
  }
  return {
    sidecarUrl,
    outDir: path.resolve(
      args.get('out') ??
        env.ALLEN_FIXTURES_DIR ??
        path.resolve(__dirname, '..', 'fixtures', 'allen'),
    ),
    concurrency: parseConcurrency(
      args.get('concurrency') ?? env.FETCH_CONCURRENCY ?? '4',
    ),
    force: args.get('force') === 'true',
  }
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

async function download(src: string, dest: string): Promise<number> {
  const res = await fetch(src)
  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText}`)
  }
  const bytes = new Uint8Array(await res.arrayBuffer())
  await fs.mkdir(path.dirname(dest), { recursive: true })
  // Write via temp + rename (as the registry's pyramid cache does): the skip
  // check above only tests existence, so a partial file left by an interrupted
  // run would otherwise be treated as complete forever after.
  const tmpPath = `${dest}.${process.pid}.${Date.now()}.tmp`
  try {
    await fs.writeFile(tmpPath, bytes)
    await fs.rename(tmpPath, dest)
  } catch (err) {
    try {
      await fs.unlink(tmpPath)
    } catch (_) {
      /* ignore */
    }
    throw err
  }
  return bytes.byteLength
}

async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0
  async function next(): Promise<void> {
    while (cursor < items.length) {
      const item = items[cursor++]
      if (item === undefined) return
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
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

// Image names come from a remote sidecar, so treat them as untrusted: a name
// containing a path separator or `..` would write outside the fixtures dir.
function safeImageName(name: unknown): string {
  if (typeof name !== 'string' || name.length === 0) {
    throw new Error(`Allen atlas: images[].name must be a non-empty string`)
  }
  if (name !== path.basename(name) || name === '..') {
    throw new Error(`Allen atlas: refusing image name with a path: ${name}`)
  }
  return name
}

async function main(): Promise<void> {
  const opts = parseArgs()
  const sidecarName = path.basename(new URL(opts.sidecarUrl).pathname)
  const baseUrl = new URL('.', opts.sidecarUrl).toString()

  console.log('Fetching Allen atlas fixture:')
  console.log(`  sidecar:     ${opts.sidecarUrl}`)
  console.log(`  destination: ${opts.outDir}`)

  await fs.mkdir(opts.outDir, { recursive: true })
  const sidecarPath = path.join(opts.outDir, sidecarName)
  if (opts.force || !(await fileExists(sidecarPath))) {
    const size = await download(opts.sidecarUrl, sidecarPath)
    console.log(`  [ok] ${sidecarName} (${formatBytes(size)})`)
  } else {
    console.log(`  [skip] ${sidecarName}`)
  }

  const info = JSON.parse(await fs.readFile(sidecarPath, 'utf8')) as {
    images?: unknown
    channels?: unknown
  }
  if (!Array.isArray(info.images) || info.images.length === 0) {
    throw new Error(`${sidecarName} lists no images[] to fetch`)
  }
  const names = info.images.map((img) =>
    safeImageName((img as { name?: unknown })?.name),
  )
  console.log(
    `  ${names.length} atlas image(s), ${info.channels ?? '?'} channel(s)`,
  )

  let downloaded = 0
  let skipped = 0
  let failed = 0
  let bytes = 0
  await runWithConcurrency(names, opts.concurrency, async (name) => {
    const dest = path.join(opts.outDir, name)
    if (!opts.force && (await fileExists(dest))) {
      skipped += 1
      return
    }
    try {
      // Read-modify-write AFTER the await: `bytes += await download(...)`
      // reads `bytes` before suspending, so concurrent runners would each
      // write back a total computed from a stale read.
      const size = await download(new URL(name, baseUrl).toString(), dest)
      bytes += size
      downloaded += 1
      console.log(`  [ok] ${name}`)
    } catch (err) {
      failed += 1
      console.warn(
        `  [fail] ${name}: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  })

  console.log(
    `Done. downloaded=${downloaded} (${formatBytes(bytes)}) ` +
      `skipped=${skipped} failed=${failed} -> ${opts.outDir}`,
  )
  if (failed > 0) process.exit(1)
}

if (import.meta.main) {
  main().catch((err: unknown) => {
    console.error(err)
    process.exit(1)
  })
}
