import fs from 'node:fs/promises'
import path from 'node:path'

import type { DataSet, Element, Fragment } from 'dicom-parser'
import type { Express } from 'express'

import {
  buildPyramid,
  frameIndexForTile,
  readInstanceMeta,
  TAG,
  tilesAcross,
  tilesDown,
  type WsiLevel,
} from '../adapters/dicomWsi.ts'
import type { Registry, RegistryEntry } from '../registry.ts'
import { asyncHandler, HttpError } from '../util/http.ts'

interface DicomParserModule {
  parseDicom(byteArray: Uint8Array): DataSet
  createJPEGBasicOffsetTable(
    dataSet: DataSet,
    pixelDataElement: Element,
    fragments?: Fragment[],
  ): number[]
}

interface ParsedInstance {
  dataSet: DataSet
  file: string
  fileName: string
  fileSize: number
  meta: ReturnType<typeof readInstanceMeta>
  pixelData: Element | null
  basicOffsetTable: number[]
  transferSyntaxUid: string
}

interface DicomWsiTileFragment {
  offset: number
  length: number
}

interface DicomWsiTileEntry {
  x: number
  y: number
  width: number
  height: number
  frame: number
  offset?: number
  length?: number
  fragments?: DicomWsiTileFragment[]
}

interface DicomWsiClientLevel {
  index: number
  width: number
  height: number
  downsample: number
  tileWidth: number
  tileHeight: number
  columns: number
  rows: number
  frames: number
  fileName: string
  fileUrl: string
  fileSize: number
  codec: 'image/jpeg'
  transferSyntaxUid: string
  photometric: string
  spacingMM: readonly [number, number]
  tiles: DicomWsiTileEntry[]
}

interface DicomWsiClientManifest {
  id: string
  name: string
  format: 'dicom-wsi-range-v1'
  description: string
  width: number
  height: number
  displayYAxis: 'up'
  dtype: 'uint8'
  channels: 'encoded-rgb'
  levels: DicomWsiClientLevel[]
}

let parserPromise: Promise<DicomParserModule> | null = null
const manifestCache = new Map<string, Promise<DicomWsiClientManifest>>()

function parser(): Promise<DicomParserModule> {
  if (!parserPromise) {
    parserPromise = import('dicom-parser' as string).then((m) => {
      const mod = m as { default?: DicomParserModule } & DicomParserModule
      return (mod.default ?? mod) as DicomParserModule
    })
  }
  return parserPromise
}

function dicomEntry(registry: Registry, id: string): RegistryEntry {
  const entry = registry.get(id)
  if (!entry) throw new HttpError(404, `Unknown volume id: ${id}`)
  if (entry.format !== 'dicom-wsi') {
    throw new HttpError(400, `${id} is ${entry.format}, not dicom-wsi`)
  }
  return entry
}

function fileUrl(fileName: string): string {
  return `files/${encodeURIComponent(fileName)}`
}

function findFragmentIndex(
  fragments: readonly Fragment[],
  offset: number,
): number {
  const index = fragments.findIndex((fragment) => fragment.offset === offset)
  if (index < 0) {
    throw new Error(`No encapsulated fragment starts at offset ${offset}`)
  }
  return index
}

function countFrameFragments(
  frameIndex: number,
  basicOffsetTable: readonly number[],
  fragments: readonly Fragment[],
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
): DicomWsiTileFragment[] {
  const pixelData = parsed.pixelData
  if (!pixelData?.fragments) {
    throw new Error(`No encapsulated fragments in ${parsed.fileName}`)
  }
  const basicOffsetTable = parsed.basicOffsetTable
  if (frameIndex >= basicOffsetTable.length) {
    throw new Error(
      `Frame ${frameIndex} exceeds ${basicOffsetTable.length} indexed frames in ${parsed.fileName}`,
    )
  }
  const offset = basicOffsetTable[frameIndex]
  if (typeof offset !== 'number') {
    throw new Error(`No offset for frame ${frameIndex} in ${parsed.fileName}`)
  }
  const startIndex = findFragmentIndex(pixelData.fragments, offset)
  const fragmentCount = countFrameFragments(
    frameIndex,
    basicOffsetTable,
    pixelData.fragments,
    startIndex,
  )
  const fragments = pixelData.fragments.slice(
    startIndex,
    startIndex + fragmentCount,
  )
  if (fragments.length === 0) {
    throw new Error(
      `Frame ${frameIndex} has no fragments in ${parsed.fileName}`,
    )
  }
  return fragments.map((fragment) => ({
    offset: fragment.position,
    length: fragment.length,
  }))
}

function tileEntry(
  level: WsiLevel,
  parsed: ParsedInstance,
  col: number,
  row: number,
): DicomWsiTileEntry {
  const frame = frameIndexForTile(level, col, row)
  const fragments = fragmentsForFrame(parsed, frame)
  const width = Math.min(level.tileWidth, level.width - col * level.tileWidth)
  const height = Math.min(
    level.tileHeight,
    level.height - row * level.tileHeight,
  )
  if (fragments.length === 1) {
    const fragment = fragments[0]
    if (!fragment) {
      throw new Error(
        `Frame ${frame} has no first fragment in ${parsed.fileName}`,
      )
    }
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
  level: WsiLevel,
  parsed: ParsedInstance,
  l0: WsiLevel,
): DicomWsiClientLevel {
  if (!level.tiledFull) {
    throw new Error(`${parsed.fileName} is not a TILED_FULL DICOM instance`)
  }
  if (!level.encapsulated) {
    throw new Error(`${parsed.fileName} is not encapsulated pixel data`)
  }
  const columns = tilesAcross(level)
  const rows = tilesDown(level)
  const tiles: DicomWsiTileEntry[] = []
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < columns; col++) {
      tiles.push(tileEntry(level, parsed, col, row))
    }
  }
  return {
    index: level.level,
    width: level.width,
    height: level.height,
    downsample: l0.width / level.width,
    tileWidth: level.tileWidth,
    tileHeight: level.tileHeight,
    columns,
    rows,
    frames: level.frames,
    fileName: parsed.fileName,
    fileUrl: fileUrl(parsed.fileName),
    fileSize: parsed.fileSize,
    codec: 'image/jpeg',
    transferSyntaxUid: parsed.transferSyntaxUid,
    photometric: level.photometric,
    spacingMM: level.spacingMM,
    tiles,
  }
}

async function parseInstance(file: string): Promise<ParsedInstance> {
  const p = await parser()
  const bytes = await fs.readFile(file)
  const dataSet = p.parseDicom(
    new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength),
  )
  const meta = readInstanceMeta(file, dataSet)
  const pixelData = dataSet.elements[TAG.pixelData] ?? null
  const basicOffsetTable =
    pixelData && meta.encapsulated
      ? p.createJPEGBasicOffsetTable(dataSet, pixelData)
      : []
  return {
    dataSet,
    file,
    fileName: path.basename(file),
    fileSize: bytes.byteLength,
    meta,
    pixelData,
    basicOffsetTable,
    transferSyntaxUid: dataSet.string(TAG.transferSyntaxUid) ?? '',
  }
}

async function dicomFilesIn(dirPath: string): Promise<string[]> {
  const items = await fs.readdir(dirPath)
  return items
    .filter((name) => /\.dcm$/i.test(name))
    .sort()
    .map((name) => path.join(dirPath, name))
}

async function buildClientManifest(
  entry: RegistryEntry,
): Promise<DicomWsiClientManifest> {
  const files = await dicomFilesIn(entry.source)
  const parsed = await Promise.all(files.map((file) => parseInstance(file)))
  const levels = buildPyramid(parsed.map((item) => item.meta))
  const l0 = levels[0]
  if (!l0) {
    throw new Error(`No VOLUME levels found for ${entry.id}`)
  }
  const parsedByFile = new Map(parsed.map((item) => [item.file, item]))
  const clientLevels = levels.map((level) => {
    const parsedLevel = parsedByFile.get(level.file)
    if (!parsedLevel) {
      throw new Error(`No parsed DICOM instance for ${level.file}`)
    }
    return levelManifest(level, parsedLevel, l0)
  })
  return {
    id: entry.id,
    name: `${entry.id} DICOM-WSI range manifest`,
    format: 'dicom-wsi-range-v1',
    description:
      'Precomputed DICOM-WSI frame directory for browser-only tile loading with HTTP Range requests.',
    width: l0.width,
    height: l0.height,
    displayYAxis: 'up',
    dtype: 'uint8',
    channels: 'encoded-rgb',
    levels: clientLevels,
  }
}

function cachedManifest(entry: RegistryEntry): Promise<DicomWsiClientManifest> {
  const cached = manifestCache.get(entry.id)
  if (cached) return cached
  const pending = buildClientManifest(entry)
  manifestCache.set(entry.id, pending)
  return pending
}

export function mountDicomWsiClientRoutes(
  app: Express,
  registry: Registry,
): void {
  app.get(
    '/dicom-wsi/:id/manifest.json',
    asyncHandler(async (req, res) => {
      const entry = dicomEntry(registry, req.params.id)
      const manifest = await cachedManifest(entry)
      res.set('Content-Type', 'application/json')
      res.set('Cache-Control', 'public, max-age=3600')
      res.json(manifest)
    }),
  )

  app.get(
    '/dicom-wsi/:id/files/:fileName',
    asyncHandler(async (req, res) => {
      const entry = dicomEntry(registry, req.params.id)
      const fileName = req.params.fileName
      if (!/^[A-Za-z0-9._-]+\.dcm$/i.test(fileName)) {
        throw new HttpError(400, `Invalid DICOM file name: ${fileName}`)
      }
      const fullPath = path.join(entry.source, fileName)
      const relative = path.relative(entry.source, fullPath)
      if (relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new HttpError(400, `Invalid DICOM file path: ${fileName}`)
      }
      res.set('Content-Type', 'application/dicom')
      res.set('Cache-Control', 'public, max-age=3600')
      res.sendFile(path.resolve(fullPath), { acceptRanges: true })
    }),
  )
}
