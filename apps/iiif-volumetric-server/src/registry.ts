// In-memory volume registry. Scans a directory tree, decides which adapter
// can handle each file (or DICOM directory), and lazily loads volumes on
// first access. Volumes are cached after first load.

import fs from 'node:fs/promises'
import path from 'node:path'

import { dicomAdapter } from './adapters/dicom.ts'
import { niftiAdapter, type VolumeAdapter } from './adapters/nifti.ts'
import { nrrdAdapter } from './adapters/nrrd.ts'
import { omezarrAdapter } from './adapters/omezarr.ts'
import type {
  Affine4x4,
  Dtype,
  Shape3,
  Vec3,
  VolumeHandle,
} from './adapters/volumeHandle.ts'
import {
  autocropBackground,
  computeTightBbox,
  cropVolume,
} from './util/autocrop.ts'
import { downsampleVolume } from './util/downsample.ts'
import { encodeNifti, encodeNiftiRaw } from './util/niftiEncoder.ts'
import { computeOccupancyGrid, type OccupancyGrid } from './util/occupancy.ts'

const ADAPTERS: VolumeAdapter[] = [
  niftiAdapter,
  nrrdAdapter,
  omezarrAdapter,
  dicomAdapter,
]

export interface LevelMetadata {
  level: number
  shape: Shape3
  spacing: Vec3
  affine?: Affine4x4 | null
  path?: string
  rawPath?: string | null
  ready?: boolean
  bytes?: number | null
  originalShape?: Shape3
  cropOffset?: [number, number, number]
  background?: number | null
}

export interface RegistryEntry {
  id: string
  format: string
  adapter: VolumeAdapter
  source: string
  shape: Shape3
  dtype: Dtype
  spacing: Vec3
  affine: Affine4x4 | null
  levels: LevelMetadata[]
  levelVolumes: Map<number, VolumeHandle>
  volume: VolumeHandle | null
}

export interface RawLevelLayout {
  shape: Shape3
  originalShape: Shape3
  cropOffset: [number, number, number]
  spacing: Vec3
  dtype: Dtype
  affine: Affine4x4 | null
  background: number | null
  sclSlope: number
  sclInter: number
  voxOffset: number
}

export interface RawLevelCache {
  entry: RegistryEntry
  level: LevelMetadata
  path: string
  layout: RawLevelLayout
}

export interface LoadLevelResult {
  entry: RegistryEntry
  level: LevelMetadata
  volume: VolumeHandle
}

interface Sidecar {
  level: number
  shape: Shape3
  originalShape: Shape3
  cropOffset: [number, number, number]
  background: number | null
  dtype: Dtype
  spacing: Vec3
}

class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message)
  }
}

export class Registry {
  entries: Map<string, RegistryEntry> = new Map()
  cacheDir: string | null = null
  rawLevelPromises: Map<string, Promise<RawLevelCache>> = new Map()
  pyramidPromises: Map<string, Promise<void>> = new Map()

  size(): number {
    return this.entries.size
  }

  list(): Array<{
    id: string
    format: string
    shape: Shape3
    dtype: Dtype
    spacing: Vec3
    source: string
    levels: Array<{
      level: number
      shape: Shape3
      spacing: Vec3
      ready: boolean
      bytes: number | null
      originalShape: Shape3
      cropOffset: [number, number, number]
    }>
  }> {
    return [...this.entries.values()].map((e) => ({
      id: e.id,
      format: e.format,
      shape: e.shape,
      dtype: e.dtype,
      spacing: e.spacing,
      source: e.source,
      levels: e.levels.map((l) => ({
        level: l.level,
        shape: l.shape,
        spacing: l.spacing,
        ready: l.ready !== false,
        bytes: l.bytes ?? null,
        originalShape: l.originalShape ?? l.shape,
        cropOffset: l.cropOffset ?? [0, 0, 0],
      })),
    }))
  }

  get(id: string): RegistryEntry | undefined {
    return this.entries.get(id)
  }

  async load(id: string): Promise<RegistryEntry> {
    const entry = this.entries.get(id)
    if (!entry) throw new HttpError(404, `Unknown volume id: ${id}`)
    if (!entry.volume) {
      entry.volume = await entry.adapter.load(entry.source)
      entry.shape = entry.volume.shape
      entry.dtype = entry.volume.dtype
      entry.spacing = entry.volume.spacing
      entry.affine = entry.volume.affine
    }
    return entry
  }

  async scan(dir: string): Promise<void> {
    this.cacheDir = path.join(dir, '.cache')
    try {
      await fs.mkdir(this.cacheDir, { recursive: true })
    } catch (_) {
      /* ignore */
    }

    let items: import('node:fs').Dirent[]
    try {
      items = await fs.readdir(dir, { withFileTypes: true })
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        console.warn(`Fixtures directory ${dir} does not exist; skipping`)
        return
      }
      throw err
    }

    for (const item of items) {
      if (item.name === '.cache') continue
      const full = path.join(dir, item.name)
      try {
        let entry: RegistryEntry | null = null
        if (item.isDirectory()) {
          const adapter = ADAPTERS.find((a) =>
            a.canHandle(full, { isDirectory: true }),
          )
          if (!adapter) continue
          const id = sanitizeId(item.name)
          const probe = await adapter.probe(full)
          entry = {
            id,
            format: adapter.format,
            adapter,
            source: full,
            shape: probe.shape,
            dtype: probe.dtype,
            spacing: probe.spacing,
            affine: probe.affine,
            levels: [],
            levelVolumes: new Map(),
            volume: null,
          }
        } else if (item.isFile()) {
          const adapter = ADAPTERS.find((a) =>
            a.canHandle(full, { isDirectory: false }),
          )
          if (!adapter) continue
          const id = sanitizeId(stripVolumeExtensions(item.name))
          const probe = await adapter.probe(full)
          entry = {
            id,
            format: adapter.format,
            adapter,
            source: full,
            shape: probe.shape,
            dtype: probe.dtype,
            spacing: probe.spacing,
            affine: probe.affine,
            levels: [],
            levelVolumes: new Map(),
            volume: null,
          }
        }
        if (entry) {
          this.entries.set(entry.id, entry)
          await this.refreshLevels(entry)
          void this.generatePyramidBackground(entry.id)
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        console.warn(`Skipping ${full}: ${message} (probe failed)`)
      }
    }
  }

  async loadLevel(id: string, levelIndex = 0): Promise<LoadLevelResult> {
    const normalized = Number(levelIndex)
    if (!Number.isInteger(normalized) || normalized < 0) {
      throw new HttpError(400, `Invalid level: ${levelIndex}`)
    }

    const entry = this.entries.get(id)
    if (!entry) throw new HttpError(404, `Unknown volume id: ${id}`)

    if (normalized === 0) {
      await this.load(id)
      const lvl = entry.levels.find((l) => l.level === 0) ?? {
        level: 0,
        shape: entry.shape,
        spacing: entry.spacing,
      }
      if (!entry.volume) throw new HttpError(500, `Volume ${id} failed to load`)
      return { entry, level: lvl, volume: entry.volume }
    }

    if (entry.format !== 'nifti') {
      throw new HttpError(
        501,
        `Pyramid levels are only implemented for NIfTI sources (got format=${entry.format})`,
      )
    }

    const level = entry.levels.find((l) => l.level === normalized)
    if (!level?.path) {
      throw new HttpError(
        404,
        `Level ${normalized} is not available for volume ${id}`,
      )
    }

    if (!entry.levelVolumes.has(normalized)) {
      entry.levelVolumes.set(normalized, await niftiAdapter.load(level.path))
    }

    const volume = entry.levelVolumes.get(normalized)
    if (!volume)
      throw new HttpError(500, `Failed to load level ${normalized} for ${id}`)
    return { entry, level, volume }
  }

  async getUncompressedNiftiLevel(
    id: string,
    levelIndex = 0,
  ): Promise<RawLevelCache> {
    const normalized = Number(levelIndex)
    if (!Number.isInteger(normalized) || normalized < 0) {
      throw new HttpError(400, `Invalid level: ${levelIndex}`)
    }

    const entry = this.entries.get(id)
    if (!entry) throw new HttpError(404, `Unknown volume id: ${id}`)
    if (entry.format !== 'nifti') {
      throw new HttpError(
        501,
        `Uncompressed level cache is only implemented for NIfTI sources (got format=${entry.format})`,
      )
    }

    const rawPath = this.rawLevelPath(entry.id, normalized)
    const cached = await this.readRawLevelCache(entry, normalized, rawPath)
    if (cached) return cached

    const key = `${entry.id}:L${normalized}`
    let pending = this.rawLevelPromises.get(key)
    if (!pending) {
      pending = this.createRawLevelCache(entry, normalized, rawPath)
      this.rawLevelPromises.set(key, pending)
    }
    try {
      return await pending
    } finally {
      if (this.rawLevelPromises.get(key) === pending) {
        this.rawLevelPromises.delete(key)
      }
    }
  }

  private async refreshLevels(entry: RegistryEntry): Promise<void> {
    if (!this.cacheDir) throw new Error('Registry.cacheDir not initialised')
    const level0RawPath = this.rawLevelPath(entry.id, 0)
    const levels: LevelMetadata[] = [
      {
        level: 0,
        shape: entry.shape,
        spacing: entry.spacing,
        affine: entry.affine,
        path: entry.source,
        rawPath: (await fileExists(level0RawPath)) ? level0RawPath : null,
        ready: true,
        bytes: await fileSize(entry.source),
        originalShape: entry.shape,
        cropOffset: [0, 0, 0],
      },
    ]
    for (let l = 1; l <= 3; l++) {
      const p = path.join(this.cacheDir, `${entry.id}_L${l}.nii.gz`)
      const rawPath = this.rawLevelPath(entry.id, l)
      const sidecarPath = this.sidecarLevelPath(entry.id, l)
      try {
        await fs.access(p)
        const probe = await niftiAdapter.probe(p)
        const stat = await fs.stat(p)
        const sidecar = await readSidecar(sidecarPath)
        levels.push({
          level: l,
          shape: probe.shape,
          spacing: probe.spacing,
          affine: probe.affine,
          path: p,
          rawPath: (await fileExists(rawPath)) ? rawPath : null,
          ready: true,
          bytes: stat.size,
          originalShape: sidecar?.originalShape ?? probe.shape,
          cropOffset: sidecar?.cropOffset ?? [0, 0, 0],
          background: sidecar?.background ?? null,
        })
      } catch (_) {
        // missing
      }
    }
    entry.levels = levels
  }

  private async generatePyramidBackground(id: string): Promise<void> {
    const entry = this.entries.get(id)
    if (!entry || entry.format !== 'nifti') return
    if (entry.levels.length > 1) return
    if (this.pyramidPromises.has(id)) return

    const promise = this.doGeneratePyramid(id).catch((err) => {
      console.error(`Failed to generate pyramid for ${id}:`, err)
    })
    this.pyramidPromises.set(id, promise)
    void promise.finally(() => {
      if (this.pyramidPromises.get(id) === promise) {
        this.pyramidPromises.delete(id)
      }
    })
  }

  async awaitPyramid(id: string): Promise<void> {
    const promise = this.pyramidPromises.get(id)
    if (promise) await promise
  }

  private async doGeneratePyramid(id: string): Promise<void> {
    if (!this.cacheDir) throw new Error('Registry.cacheDir not initialised')
    console.log(`Generating pyramid for ${id}...`)
    const entry = await this.load(id)
    if (!entry.volume) return

    try {
      await this.ensureOccupancyCache(entry, 16)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.warn(`  - Could not generate occupancy for ${id}: ${message}`)
    }

    let currentVolume: VolumeHandle = entry.volume
    for (let l = 1; l <= 3; l++) {
      const p = path.join(this.cacheDir, `${id}_L${l}.nii.gz`)
      try {
        await fs.access(p)
        currentVolume = await niftiAdapter.load(p)
        continue
      } catch (_) {
        /* generate below */
      }

      try {
        const down = downsampleVolume(currentVolume, 2)

        let downAffine: Affine4x4 | null = null
        if (currentVolume.affine) {
          const rows = currentVolume.affine.map((row) => [...row]) as [
            [number, number, number, number],
            [number, number, number, number],
            [number, number, number, number],
            [number, number, number, number],
          ]
          for (let i = 0; i < 3; i++) {
            rows[i][0] *= 2
            rows[i][1] *= 2
            rows[i][2] *= 2
          }
          downAffine = rows
        }
        down.affine = downAffine

        const background = autocropBackground(down)
        const tightBbox = computeTightBbox(down, background)
        const downShape: Shape3 = [down.shape[0], down.shape[1], down.shape[2]]
        let final: VolumeHandle = down
        let cropOffset: [number, number, number] = [0, 0, 0]
        if (tightBbox) {
          const [bx0, by0, bz0, bx1, by1, bz1] = tightBbox
          const isWhole =
            bx0 === 0 &&
            by0 === 0 &&
            bz0 === 0 &&
            bx1 === downShape[0] &&
            by1 === downShape[1] &&
            bz1 === downShape[2]
          if (!isWhole) {
            final = cropVolume(down, tightBbox)
            cropOffset = [bx0, by0, bz0]
          }
        }

        const encoded = encodeNifti({
          data: final.data,
          shape: final.shape,
          spacing: final.spacing,
          dtype: final.dtype,
          affine: final.affine,
          sclSlope: final.sclSlope,
          sclInter: final.sclInter,
        })
        const rawEncoded = encodeNiftiRaw({
          data: final.data,
          shape: final.shape,
          spacing: final.spacing,
          dtype: final.dtype,
          affine: final.affine,
          sclSlope: final.sclSlope,
          sclInter: final.sclInter,
        })
        const sidecar: Sidecar = {
          level: l,
          shape: final.shape,
          originalShape: downShape,
          cropOffset,
          background,
          dtype: final.dtype,
          spacing: final.spacing,
        }
        await fs.writeFile(
          this.sidecarLevelPath(id, l),
          JSON.stringify(sidecar, null, 2),
        )
        await fs.writeFile(this.rawLevelPath(id, l), rawEncoded)
        await fs.writeFile(p, encoded)
        const cropNote =
          cropOffset[0] || cropOffset[1] || cropOffset[2]
            ? ` cropped from ${downShape.join('x')} offset ${cropOffset.join(',')}`
            : ''
        console.log(
          `  - Wrote ${id} level ${l} (${final.shape.join('x')}${cropNote})`,
        )
        currentVolume = final
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        console.warn(`  - Could not generate level ${l} for ${id}: ${message}`)
        break
      }
    }
    await this.refreshLevels(entry)
  }

  private rawLevelPath(id: string, levelIndex: number): string {
    if (!this.cacheDir) throw new Error('Registry.cacheDir not initialised')
    return path.join(this.cacheDir, `${id}_L${levelIndex}.nii`)
  }

  private sidecarLevelPath(id: string, levelIndex: number): string {
    if (!this.cacheDir) throw new Error('Registry.cacheDir not initialised')
    return path.join(this.cacheDir, `${id}_L${levelIndex}.json`)
  }

  private occupancyPath(id: string, blockSize: number): string {
    if (!this.cacheDir) throw new Error('Registry.cacheDir not initialised')
    return path.join(this.cacheDir, `${id}_occupancy_N${blockSize}.bin`)
  }

  async getOccupancy(id: string, blockSize = 16): Promise<OccupancyGrid> {
    const normalized = Number(blockSize)
    if (!Number.isInteger(normalized) || normalized < 2 || normalized > 256) {
      throw new HttpError(
        400,
        `block must be an integer in [2, 256]; got ${blockSize}`,
      )
    }
    const entry = await this.load(id)
    if (entry.format !== 'nifti') {
      throw new HttpError(
        501,
        `Occupancy is only implemented for NIfTI sources (got format=${entry.format})`,
      )
    }
    if (!entry.volume) throw new HttpError(500, `Volume ${id} not loaded`)
    const dims: [number, number, number] = [
      Math.ceil(entry.shape[0] / normalized),
      Math.ceil(entry.shape[1] / normalized),
      Math.ceil(entry.shape[2] / normalized),
    ]
    const cachePath = this.occupancyPath(entry.id, normalized)
    const expectedBytes = dims[0] * dims[1] * dims[2]
    if (await fileExists(cachePath)) {
      const buf = await fs.readFile(cachePath)
      if (buf.length === expectedBytes) {
        return {
          data: new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength),
          dims,
          blockSize: normalized,
        }
      }
    }
    const background = autocropBackground(entry.volume)
    const result = computeOccupancyGrid(entry.volume, normalized, background)
    await fs.writeFile(cachePath, Buffer.from(result.data.buffer))
    return result
  }

  private async ensureOccupancyCache(
    entry: RegistryEntry,
    blockSize: number,
  ): Promise<void> {
    if (!entry.volume) return
    const cachePath = this.occupancyPath(entry.id, blockSize)
    if (await fileExists(cachePath)) return
    const background = autocropBackground(entry.volume)
    const result = computeOccupancyGrid(entry.volume, blockSize, background)
    await fs.writeFile(cachePath, Buffer.from(result.data.buffer))
  }

  private async readRawLevelCache(
    entry: RegistryEntry,
    levelIndex: number,
    rawPath: string,
  ): Promise<RawLevelCache | null> {
    if (!(await fileExists(rawPath))) return null
    const level = this.levelMetadata(entry, levelIndex)
    return {
      entry,
      level,
      path: rawPath,
      layout: rawLevelLayout(entry, level),
    }
  }

  private async createRawLevelCache(
    entry: RegistryEntry,
    levelIndex: number,
    rawPath: string,
  ): Promise<RawLevelCache> {
    const cached = await this.readRawLevelCache(entry, levelIndex, rawPath)
    if (cached) return cached

    const level = this.levelMetadata(entry, levelIndex)
    const sourcePath = levelIndex === 0 ? entry.source : (level.path as string)
    let volume: VolumeHandle | undefined =
      levelIndex === 0
        ? (entry.volume ?? undefined)
        : entry.levelVolumes.get(levelIndex)
    if (!volume) {
      volume = await niftiAdapter.load(sourcePath)
    }
    const raw = encodeNiftiRaw({
      data: volume.data,
      shape: volume.shape,
      spacing: volume.spacing,
      dtype: volume.dtype,
      affine: volume.affine,
      sclSlope: volume.sclSlope,
      sclInter: volume.sclInter,
    })
    const tmpPath = `${rawPath}.${process.pid}.${Date.now()}.tmp`
    try {
      await fs.writeFile(tmpPath, raw)
      await fs.rename(tmpPath, rawPath)
    } catch (err) {
      try {
        await fs.unlink(tmpPath)
      } catch (_) {
        /* ignore */
      }
      throw err
    }

    level.rawPath = rawPath
    return {
      entry,
      level,
      path: rawPath,
      layout: rawLevelLayout(entry, {
        ...level,
        shape: volume.shape,
        spacing: volume.spacing,
        affine: volume.affine,
      }),
    }
  }

  private levelMetadata(
    entry: RegistryEntry,
    levelIndex: number,
  ): LevelMetadata {
    const level = entry.levels.find((l) => l.level === levelIndex)
    if (level) return level
    if (levelIndex === 0) {
      return {
        level: 0,
        shape: entry.shape,
        spacing: entry.spacing,
        affine: entry.affine,
        path: entry.source,
      }
    }
    throw new HttpError(
      404,
      `Level ${levelIndex} is not available for volume ${entry.id}`,
    )
  }
}

function sanitizeId(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]/g, '_')
}

function stripVolumeExtensions(name: string): string {
  return name
    .replace(/\.nii\.gz$/i, '')
    .replace(/\.nii$/i, '')
    .replace(/\.nhdr$/i, '')
    .replace(/\.nrrd$/i, '')
    .replace(/\.ome\.tiff?$/i, '')
    .replace(/\.tiff?$/i, '')
}

export const registry = new Registry()

async function fileSize(p: string): Promise<number | null> {
  try {
    const stat = await fs.stat(p)
    return stat.isFile() ? stat.size : null
  } catch (_) {
    return null
  }
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch (_) {
    return false
  }
}

async function readSidecar(p: string): Promise<Sidecar | null> {
  try {
    const text = await fs.readFile(p, 'utf8')
    return JSON.parse(text) as Sidecar
  } catch (_) {
    return null
  }
}

function rawLevelLayout(
  entry: RegistryEntry,
  level: LevelMetadata,
): RawLevelLayout {
  const shape: Shape3 = level.shape ?? entry.shape
  return {
    shape,
    originalShape: level.originalShape ?? shape,
    cropOffset: level.cropOffset ?? [0, 0, 0],
    spacing: level.spacing ?? entry.spacing,
    dtype: entry.dtype,
    affine: level.affine ?? entry.affine ?? null,
    background: level.background ?? null,
    sclSlope: entry.volume?.sclSlope ?? 0,
    sclInter: entry.volume?.sclInter ?? 0,
    voxOffset: 352,
  }
}
