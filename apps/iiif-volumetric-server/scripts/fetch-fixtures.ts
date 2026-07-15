// Download OpenNeuro T1w NIfTI samples into the local fixtures dir so the
// IIIF Volumetric Server has real volumes to serve.
//
// Usage:
//   bun run scripts/fetch-fixtures.ts                 (defaults below)
//   DATASET_ID=ds002336 MAX_SUBJECTS=20 bun run ...
//   bun run scripts/fetch-fixtures.ts --dataset=ds000228 --max=50
//
// Files are stored under fixtures/<datasetId>_<sub>_T1w.nii.gz.
// Already-present files are skipped, so the script is safe to re-run.

import fs from 'node:fs/promises'
import path from 'node:path'
import url from 'node:url'

const __dirname = path.dirname(url.fileURLToPath(import.meta.url))

interface Options {
  datasetId: string
  maxSubjects: number
  fixturesDir: string
  concurrency: number
}

function parseArgs(): Options {
  const args = new Map<string, string>()
  for (const raw of process.argv.slice(2)) {
    const match = /^--([^=]+)=(.*)$/.exec(raw)
    if (match) args.set(match[1] as string, match[2] as string)
  }
  const env = process.env
  const datasetId = args.get('dataset') ?? env.DATASET_ID ?? 'ds000228'
  const maxSubjects = Number(args.get('max') ?? env.MAX_SUBJECTS ?? '20')
  const fixturesDir = path.resolve(
    args.get('out') ??
      env.FIXTURES_DIR ??
      path.resolve(__dirname, '..', 'fixtures'),
  )
  const concurrency = Math.max(
    1,
    Number(args.get('concurrency') ?? env.FETCH_CONCURRENCY ?? '4'),
  )
  if (!Number.isFinite(maxSubjects) || maxSubjects <= 0) {
    throw new Error(`max must be a positive integer, got ${maxSubjects}`)
  }
  return { datasetId, maxSubjects, fixturesDir, concurrency }
}

async function listSubjects(
  datasetId: string,
  maxSubjects: number,
): Promise<string[]> {
  // OpenNeuro mirrors datasets on S3 with a public bucket listing. Paginate
  // through prefixes until we have enough unique "sub-XXX" identifiers.
  const seen = new Set<string>()
  let marker: string | undefined
  while (seen.size < maxSubjects) {
    const u = new URL('https://s3.amazonaws.com/openneuro.org/')
    u.searchParams.set('prefix', `${datasetId}/sub-`)
    if (marker) u.searchParams.set('marker', marker)
    const res = await fetch(u)
    if (!res.ok) {
      throw new Error(
        `S3 listing failed for ${datasetId}: ${res.status} ${res.statusText}`,
      )
    }
    const body = await res.text()
    const matches = body.match(
      new RegExp(`${datasetId}/(sub-[A-Za-z0-9]+)/`, 'g'),
    )
    if (!matches || matches.length === 0) break
    let lastKey = ''
    for (const m of matches) {
      const sub = m.slice(datasetId.length + 1, -1)
      seen.add(sub)
      lastKey = m
      if (seen.size >= maxSubjects) break
    }
    const truncated = /<IsTruncated>true<\/IsTruncated>/.test(body)
    if (!truncated || !lastKey) break
    marker = `${datasetId}/${lastKey.slice(datasetId.length + 1, -1)}/`
  }
  return Array.from(seen).slice(0, maxSubjects).sort()
}

async function downloadFile(srcUrl: string, dest: string): Promise<void> {
  const tmp = `${dest}.part`
  const res = await fetch(srcUrl)
  if (!res.ok || !res.body) {
    throw new Error(`${srcUrl}: ${res.status} ${res.statusText}`)
  }
  const buf = new Uint8Array(await res.arrayBuffer())
  await fs.writeFile(tmp, buf)
  await fs.rename(tmp, dest)
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
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

async function main(): Promise<void> {
  const opts = parseArgs()
  console.log(
    `Fetching up to ${opts.maxSubjects} T1w volume(s) from OpenNeuro/${opts.datasetId}`,
  )
  console.log(`  destination: ${opts.fixturesDir}`)
  await fs.mkdir(opts.fixturesDir, { recursive: true })

  const subjects = await listSubjects(opts.datasetId, opts.maxSubjects)
  if (subjects.length === 0) {
    throw new Error(`No subjects found under ${opts.datasetId}/sub-`)
  }
  console.log(`Found ${subjects.length} subject(s).`)

  let downloaded = 0
  let skipped = 0
  let failed = 0
  await runWithConcurrency(subjects, opts.concurrency, async (sub) => {
    const fileName = `${opts.datasetId}_${sub}_T1w.nii.gz`
    const dest = path.join(opts.fixturesDir, fileName)
    if (await fileExists(dest)) {
      skipped += 1
      return
    }
    const srcUrl = `https://s3.amazonaws.com/openneuro.org/${opts.datasetId}/${sub}/anat/${sub}_T1w.nii.gz`
    try {
      await downloadFile(srcUrl, dest)
      downloaded += 1
      console.log(`  [ok] ${fileName}`)
    } catch (err) {
      failed += 1
      const msg = err instanceof Error ? err.message : String(err)
      console.warn(`  [skip] ${fileName}: ${msg}`)
    }
  })

  console.log(
    `Done. downloaded=${downloaded} skipped=${skipped} failed=${failed}`,
  )
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
