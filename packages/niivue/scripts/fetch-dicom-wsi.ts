// Download one DICOM-WSI series from the public NCI Imaging Data Commons (IDC)
// bucket into public/dicom-wsi/<name>/, then write a `manifest.json` sidecar
// describing each pyramid level's JPEG tiles by byte offset+length so the
// `slides.html` example can stream tiles directly with HTTP Range requests --
// no backend, only static file serving.
//
// This mirrors what the IIIF volumetric server's dicom-wsi-range-v1 route does
// at request time, but precomputes it offline. NVSlide consumes the manifest +
// the raw .dcm files exactly as it does when served by that server: it fetches
// each tile's JPEG fragment via `Range: bytes=...` and decodes it in-browser
// with createImageBitmap.
//
// The downloaded series + manifest are multi-hundred-MB and are gitignored
// (see .gitignore); run this script once to make the source available.
//
// Usage:
//   bun run scripts/fetch-dicom-wsi.ts                      # default CPTAC-BRCA
//   bun run scripts/fetch-dicom-wsi.ts --series=<uuid>      # another IDC series
//   bun run scripts/fetch-dicom-wsi.ts --series=<uuid> --name=tcga-kich-001
//   bun run scripts/fetch-dicom-wsi.ts --force              # re-download + rebuild
//
// Restart the dev server after fetching so vite serves the new files.

import fs from 'node:fs/promises'
import path from 'node:path'
import url from 'node:url'
import dicomParser from 'dicom-parser'

const __dirname = path.dirname(url.fileURLToPath(import.meta.url))

// Default: a real CPTAC-BRCA whole-slide pyramid on idc-open-data -- 7
// instances, ~487 MB, a 4-level TILED_FULL JPEG pyramid (53783x49534 base down
// to 1680x1547) plus label/overview/thumbnail. Verified anonymously readable.
// Pick another series UUID from https://portal.imaging.datacommons.cancer.gov/
// (it is the bucket key: `s3://idc-open-data/<series-uuid>/`).
const DEFAULT_SERIES = '37cb2625-cd6b-40f8-9c95-e0168ce52d0f'

// dicom-parser tag keys are 'xggggeeee' (group+element, lowercase hex).
const TAG = {
  imageType: 'x00080008',
  photometric: 'x00280004',
  rows: 'x00280010', // tile height
  columns: 'x00280011', // tile width
  pixelSpacing: 'x00280030',
  numberOfFrames: 'x00280008',
  dimensionOrganizationType: 'x00209311',
  totalPixelMatrixColumns: 'x00480006', // level width
  totalPixelMatrixRows: 'x00480007', // level height
  transferSyntaxUid: 'x00020010',
  pixelData: 'x7fe00010',
}

interface Options {
  bucket: string
  seriesUuid: string
  name: string
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
    else if (raw.startsWith('--')) args.set(raw.slice(2), 'true')
  }
  const env = process.env
  const bucket = args.get('bucket') ?? env.IDC_BUCKET ?? 'idc-open-data'
  const seriesUuid = args.get('series') ?? env.IDC_SERIES_UUID ?? DEFAULT_SERIES
  if (!/^[0-9a-f-]{36}$/i.test(seriesUuid)) {
    throw new Error(`series UUID must be a 36-char UUID, got '${seriesUuid}'`)
  }
  // Default to a stable readable name for the bundled series, else a short
  // prefix of the UUID so the fixture is recognizable in `ls`.
  const defaultName =
    seriesUuid === DEFAULT_SERIES
      ? 'cptac-brca'
      : `idc-${seriesUuid.slice(0, 8)}`
  const name = args.get('name') ?? defaultName
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
  const defaultOut = path.resolve(__dirname, '..', 'public', 'dicom-wsi', name)
  return {
    bucket,
    seriesUuid,
    name,
    outDir: path.resolve(args.get('out') ?? env.DICOM_WSI_OUT ?? defaultOut),
    concurrency,
    force,
    maxBytes,
  }
}

// Anonymous S3 ListObjectsV2 over virtual-host HTTPS. The XML response is small
// enough that a regex parse beats pulling in an XML dependency.
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
  // Buffer to RAM before writing: Bun.write(path, Response) can stall on
  // darwin. DICOM-WSI instances are typically <100MB each.
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

// --- DICOM-WSI metadata + tile geometry (mirrors the server's dicomWsi.ts) ---

type WsiFlavor = 'volume' | 'label' | 'overview' | 'thumbnail' | 'other'

interface WsiMeta {
  file: string
  fileName: string
  width: number
  height: number
  tileWidth: number
  tileHeight: number
  frames: number
  tiledFull: boolean
  encapsulated: boolean
  photometric: string
  flavor: WsiFlavor
  spacingMM: [number, number]
}

// JPEG family is 1.2.840.10008.1.2.4.*, RLE is 1.2.840.10008.1.2.5; the
// uncompressed little/big-endian syntaxes are not encapsulated.
function isEncapsulated(uid: string): boolean {
  const u = uid.trim()
  return u.startsWith('1.2.840.10008.1.2.4') || u === '1.2.840.10008.1.2.5'
}

function classifyImageType(imageType: string): WsiFlavor {
  const t = imageType.toUpperCase()
  if (t.includes('LABEL')) return 'label'
  if (t.includes('OVERVIEW')) return 'overview'
  if (t.includes('THUMBNAIL')) return 'thumbnail'
  if (t.includes('VOLUME')) return 'volume'
  return 'other'
}

function readMeta(file: string, ds: dicomParser.DataSet): WsiMeta {
  const imageType = ds.string(TAG.imageType) ?? ''
  const width =
    ds.uint32(TAG.totalPixelMatrixColumns) ?? ds.uint16(TAG.columns) ?? 0
  const height = ds.uint32(TAG.totalPixelMatrixRows) ?? ds.uint16(TAG.rows) ?? 0
  const tileWidth = ds.uint16(TAG.columns) ?? width
  const tileHeight = ds.uint16(TAG.rows) ?? height
  const frames = ds.intString(TAG.numberOfFrames) ?? 1
  const org = (ds.string(TAG.dimensionOrganizationType) ?? '').toUpperCase()
  const encapsulated = isEncapsulated(ds.string(TAG.transferSyntaxUid) ?? '')
  const sy = ds.floatString(TAG.pixelSpacing, 0) // row spacing (y)
  const sx = ds.floatString(TAG.pixelSpacing, 1) // column spacing (x)
  return {
    file,
    fileName: path.basename(file),
    width,
    height,
    tileWidth,
    tileHeight,
    frames,
    tiledFull: org.includes('TILED_FULL'),
    encapsulated,
    photometric: (ds.string(TAG.photometric) ?? '').toUpperCase(),
    flavor: classifyImageType(imageType),
    spacingMM: [
      Number.isFinite(sx) && sx ? (sx as number) : 1,
      Number.isFinite(sy) && sy ? (sy as number) : 1,
    ],
  }
}

function tilesAcross(m: { width: number; tileWidth: number }): number {
  return Math.ceil(m.width / m.tileWidth)
}

function tilesDown(m: { height: number; tileHeight: number }): number {
  return Math.ceil(m.height / m.tileHeight)
}

// --- manifest assembly --------------------------------------------------------

interface TileFragment {
  offset: number
  length: number
}

interface TileEntry {
  x: number
  y: number
  width: number
  height: number
  frame: number
  offset?: number
  length?: number
  fragments?: TileFragment[]
}

interface ParsedInstance {
  meta: WsiMeta
  fileSize: number
  transferSyntaxUid: string
  pixelData: dicomParser.Element | null
  basicOffsetTable: number[]
  fragments: dicomParser.Fragment[]
}

async function parseInstance(file: string): Promise<ParsedInstance> {
  const bytes = await fs.readFile(file)
  const ds = dicomParser.parseDicom(
    new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength),
  )
  const meta = readMeta(file, ds)
  const pixelData = ds.elements[TAG.pixelData] ?? null
  const fragments = pixelData?.fragments ?? []
  const basicOffsetTable =
    pixelData && meta.encapsulated
      ? dicomParser.createJPEGBasicOffsetTable(ds, pixelData)
      : []
  return {
    meta,
    fileSize: bytes.byteLength,
    transferSyntaxUid: ds.string(TAG.transferSyntaxUid) ?? '',
    pixelData,
    basicOffsetTable,
    fragments,
  }
}

function findFragmentIndex(
  fragments: readonly dicomParser.Fragment[],
  offset: number,
): number {
  const index = fragments.findIndex((f) => f.offset === offset)
  if (index < 0) {
    throw new Error(`No encapsulated fragment starts at offset ${offset}`)
  }
  return index
}

function countFrameFragments(
  frameIndex: number,
  basicOffsetTable: readonly number[],
  fragments: readonly dicomParser.Fragment[],
  startFragmentIndex: number,
): number {
  if (frameIndex === basicOffsetTable.length - 1) {
    return fragments.length - startFragmentIndex
  }
  const nextFrameOffset = basicOffsetTable[frameIndex + 1]
  if (typeof nextFrameOffset !== 'number') {
    throw new Error(`No next frame offset for frame ${frameIndex}`)
  }
  for (let i = startFragmentIndex + 1; i < fragments.length; i++) {
    if (fragments[i]?.offset === nextFrameOffset) return i - startFragmentIndex
  }
  throw new Error(`Could not resolve fragment count for frame ${frameIndex}`)
}

function fragmentsForFrame(
  parsed: ParsedInstance,
  frameIndex: number,
): TileFragment[] {
  const { fragments, basicOffsetTable } = parsed
  if (fragments.length === 0) {
    throw new Error(`No encapsulated fragments in ${parsed.meta.fileName}`)
  }
  if (frameIndex >= basicOffsetTable.length) {
    throw new Error(
      `Frame ${frameIndex} exceeds ${basicOffsetTable.length} indexed frames`,
    )
  }
  const offset = basicOffsetTable[frameIndex]
  if (typeof offset !== 'number') {
    throw new Error(`No offset for frame ${frameIndex}`)
  }
  const startIndex = findFragmentIndex(fragments, offset)
  const count = countFrameFragments(
    frameIndex,
    basicOffsetTable,
    fragments,
    startIndex,
  )
  // `position` is the absolute byte offset of the fragment data in the file,
  // which is what an HTTP Range request fetches.
  return fragments
    .slice(startIndex, startIndex + count)
    .map((f) => ({ offset: f.position, length: f.length }))
}

function tileEntry(
  level: WsiMeta,
  parsed: ParsedInstance,
  col: number,
  row: number,
): TileEntry {
  const frame = row * tilesAcross(level) + col
  const fragments = fragmentsForFrame(parsed, frame)
  const width = Math.min(level.tileWidth, level.width - col * level.tileWidth)
  const height = Math.min(
    level.tileHeight,
    level.height - row * level.tileHeight,
  )
  if (fragments.length === 1) {
    const fragment = fragments[0]
    if (!fragment) throw new Error(`Frame ${frame} has no first fragment`)
    return {
      x: col,
      y: row,
      width,
      height,
      frame,
      offset: fragment.offset,
      length: fragment.length,
    }
  }
  return { x: col, y: row, width, height, frame, fragments }
}

function levelManifest(
  level: WsiMeta & { level: number },
  parsed: ParsedInstance,
  l0Width: number,
): Record<string, unknown> {
  if (!level.tiledFull) {
    throw new Error(`${parsed.meta.fileName} is not a TILED_FULL instance`)
  }
  if (!level.encapsulated) {
    throw new Error(`${parsed.meta.fileName} is not encapsulated pixel data`)
  }
  const columns = tilesAcross(level)
  const rows = tilesDown(level)
  const tiles: TileEntry[] = []
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < columns; col++) {
      tiles.push(tileEntry(level, parsed, col, row))
    }
  }
  return {
    index: level.level,
    width: level.width,
    height: level.height,
    downsample: l0Width / level.width,
    tileWidth: level.tileWidth,
    tileHeight: level.tileHeight,
    columns,
    rows,
    frames: level.frames,
    fileName: parsed.meta.fileName,
    fileUrl: `files/${encodeURIComponent(parsed.meta.fileName)}`,
    fileSize: parsed.fileSize,
    codec: 'image/jpeg',
    transferSyntaxUid: parsed.transferSyntaxUid,
    photometric: level.photometric,
    spacingMM: level.spacingMM,
    tiles,
  }
}

export async function buildManifest(
  id: string,
  filesDir: string,
): Promise<Record<string, unknown>> {
  const names = (await fs.readdir(filesDir))
    .filter((n) => /\.dcm$/i.test(n))
    .sort()
  const files = names.map((n) => path.join(filesDir, n))
  const parsed = await Promise.all(files.map((f) => parseInstance(f)))

  // Keep VOLUME tiers, highest-resolution first, numbered 0..N-1.
  const volumes = parsed
    .filter((p) => p.meta.flavor === 'volume' && p.meta.width > 0)
    .sort((a, b) => b.meta.width * b.meta.height - a.meta.width * a.meta.height)
  if (volumes.length === 0) {
    throw new Error(`No VOLUME levels found for ${id}`)
  }
  const l0Width = volumes[0]?.meta.width ?? 0
  const levels = volumes.map((p, i) =>
    levelManifest({ ...p.meta, level: i }, p, l0Width),
  )
  return {
    id,
    name: `${id} DICOM-WSI`,
    format: 'dicom-wsi-range-v1',
    description:
      'Precomputed DICOM-WSI frame directory for browser-only tile loading with HTTP Range requests.',
    width: volumes[0]?.meta.width ?? 0,
    height: volumes[0]?.meta.height ?? 0,
    displayYAxis: 'up',
    dtype: 'uint8',
    channels: 'encoded-rgb',
    levels,
  }
}

async function main(): Promise<void> {
  const opts = parseArgs()
  const filesDir = path.join(opts.outDir, 'files')
  const manifestPath = path.join(opts.outDir, 'manifest.json')

  console.log('Fetching DICOM-WSI series:')
  console.log(`  bucket: ${opts.bucket}`)
  console.log(`  series: ${opts.seriesUuid}`)
  console.log(`  dest:   ${opts.outDir}`)

  await fs.mkdir(filesDir, { recursive: true })

  // IDC layout: s3://idc-open-data/<series-uuid>/<instance-uuid>.dcm
  const prefix = `${opts.seriesUuid}/`
  console.log(`  listing s3://${opts.bucket}/${prefix} ...`)
  const all: S3Object[] = []
  for await (const obj of listObjects(opts.bucket, prefix)) {
    if (obj.key.endsWith('.dcm')) all.push(obj)
  }
  if (all.length === 0) {
    throw new Error(
      `No .dcm objects under s3://${opts.bucket}/${prefix} -- series UUID may be wrong or private.`,
    )
  }
  const totalBytes = all.reduce((s, o) => s + o.size, 0)
  console.log(`  ${all.length} .dcm file(s), ${formatBytes(totalBytes)}`)
  if (totalBytes > opts.maxBytes && !opts.force) {
    throw new Error(
      `Total ${formatBytes(totalBytes)} exceeds cap ${formatBytes(opts.maxBytes)}. ` +
        'Pass --max-mb=N to raise it, or --force to ignore.',
    )
  }

  let downloaded = 0
  let skipped = 0
  let failed = 0
  await runWithConcurrency(all, opts.concurrency, async (obj) => {
    const dest = path.join(filesDir, path.basename(obj.key))
    if (!opts.force && (await fileExists(dest))) {
      skipped += 1
      return
    }
    try {
      await downloadObject(opts.bucket, obj.key, dest)
      downloaded += 1
    } catch (err) {
      failed += 1
      console.warn(
        `  [fail] ${path.basename(obj.key)}: ${err instanceof Error ? err.message : err}`,
      )
    }
  })
  console.log(`  downloaded=${downloaded} skipped=${skipped} failed=${failed}`)
  if (failed > 0) {
    throw new Error(
      'Some .dcm files failed to download; not building manifest.',
    )
  }

  console.log('  building manifest.json (parsing JPEG frame offsets) ...')
  const manifest = await buildManifest(opts.name, filesDir)
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest)}\n`)
  const levels = manifest.levels as Array<Record<string, unknown>>
  console.log(`  wrote ${manifestPath} (${levels.length} pyramid level(s))`)
  for (const lvl of levels) {
    console.log(
      `    L${lvl.index}: ${lvl.width}x${lvl.height}, ` +
        `${lvl.columns}x${lvl.rows} tiles (${lvl.frames} frames)`,
    )
  }
  console.log(
    `\nRestart the dev server, then pick "${opts.name}" in slides.html.`,
  )
}

// Only run the IDC download when invoked directly; importing this module (e.g.
// fetch-openslide-dicom.ts reusing buildManifest) must not trigger a download.
if (import.meta.main) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
  })
}
