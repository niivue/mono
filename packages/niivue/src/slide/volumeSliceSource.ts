/**
 * Deep-zoom ONE PLANE of a multi-resolution volume as an NVSlide slide.
 *
 * A {@link ChunkedVolumeSource} already describes a pyramid of raw voxel
 * regions -- the same seam `nv.loadChunkedVolume` streams bricks through. A
 * whole-slide image is that pyramid read one plane at a time, so this adapter
 * turns any chunked volume (OME-Zarr, an HTTP range shard, a tile server) into
 * a {@link SlideTileSource}. The volumetric view and the deep-zoom view can
 * then share ONE source, one store cache and one set of bytes:
 *
 * ```ts
 * const volume = await fetchOmeZarrChunkedSource(url)
 * await nv.loadChunkedVolume(volume)
 * const slide = NVSlide.fromSource(
 *   new VolumeSliceSource(volume, { axis: 'z', window: [0, 400] }),
 * )
 * ```
 *
 * Tiles are emitted as `raw-rgba`: this adapter owns the intensity window (and
 * an optional colormap LUT), because voxels are scalars and a slide tile is
 * RGBA. The plane is FIXED for the life of a source; step through the volume
 * with {@link VolumeSliceSource.withIndex}, which shares the underlying volume
 * source (and therefore its cache).
 *
 * A caveat worth knowing before pointing this at a big store: a volumetric
 * pyramid is usually chunked CUBICALLY (64^3, 128^3), so reading one plane
 * decodes a whole slab of chunks and throws most of it away. Levels other than
 * the finest are cheap; the finest level of a gigavoxel store is not. Aligning
 * `tileSize` to the store's in-plane chunk size at least avoids decoding the
 * same chunk for two neighbouring tiles.
 */

import type { ChunkedVolumeSource } from '@/volume/ChunkedVolumeSource'
import type { Vec3i } from '@/volume/chunking'
import { getBitsPerVoxel, getTypedArrayConstructor } from '@/volume/utils'
import type {
  NVSlideLevelManifest,
  NVSlideManifest,
  NVSlideTileManifest,
  NVSlideYAxis,
  SlideSourceHost,
  SlideTileSource,
} from './NVSlide'

/** The display axis held FIXED by the plane (its normal). */
export type VolumeSliceAxis = 'x' | 'y' | 'z'

/** Options for {@link VolumeSliceSource}. */
export interface VolumeSliceSourceOptions {
  /** Plane normal in display axes. Default `'z'` (an axial plane). */
  axis?: VolumeSliceAxis
  /** Plane position along `axis`, in FINEST-level voxels. Default: the middle. */
  index?: number
  /**
   * Intensity window mapped onto the 0-255 ramp, in RAW voxel values. Default
   * `[0, 255]`, which is only right for uint8 data -- pass a real window (the
   * same one the volumetric view uses) for anything else.
   */
  window?: readonly [number, number]
  /**
   * 256-entry RGBA colormap (1024 bytes, `[r,g,b,a, r,g,b,a, ...]`) applied to
   * the windowed value. Default: opaque grayscale.
   */
  lut?: Uint8Array | null
  /** Tile edge in level pixels. Default 256. */
  tileSize?: number
  /** Manifest id. Default `'volume-slice'`. */
  id?: string
  /** Human-readable manifest name. Default: the id plus the plane. */
  name?: string
  /**
   * Physical size of one FINEST-level pixel in millimetres, `[u, v]` (u/v are
   * the in-plane display axes, see {@link VolumeSliceSource.planeAxes}).
   */
  pixelSpacingMM?: readonly [number, number]
  /**
   * Slide y direction. Default `'up'`: the in-plane axis is a display y or z
   * axis, which points UP, unlike a scanned slide's top-down pixel rows.
   */
  yAxis?: NVSlideYAxis
}

/** In-plane display axes `[u, v]` for each plane normal. */
const PLANE_AXES: Record<VolumeSliceAxis, [number, number]> = {
  x: [1, 2],
  y: [0, 2],
  z: [0, 1],
}

const AXIS_OF: Record<VolumeSliceAxis, number> = { x: 0, y: 1, z: 2 }

const DEFAULT_TILE_SIZE = 256

function grayLut(): Uint8Array {
  const lut = new Uint8Array(1024)
  for (let i = 0; i < 256; i++) {
    lut[i * 4] = i
    lut[i * 4 + 1] = i
    lut[i * 4 + 2] = i
    lut[i * 4 + 3] = 255
  }
  return lut
}

/**
 * One plane of a {@link ChunkedVolumeSource}, served as slide tiles.
 *
 * The manifest is pure metadata (no I/O), so stepping the plane is cheap: build
 * a new source with {@link VolumeSliceSource.withIndex} and hand it to
 * `NVSlide.fromSource`.
 */
export class VolumeSliceSource implements SlideTileSource {
  readonly manifest: NVSlideManifest
  /** The volume pyramid this plane is read from. */
  readonly volume: ChunkedVolumeSource
  /** The plane normal in display axes. */
  readonly axis: VolumeSliceAxis
  /** The plane's position along {@link axis}, in finest-level voxels. */
  readonly index: number
  /** Display axes `[u, v]` spanning the plane (0 = x, 1 = y, 2 = z). */
  readonly planeAxes: readonly [number, number]
  /** Number of planes along {@link axis} at the finest level. */
  readonly planeCount: number

  private readonly options: VolumeSliceSourceOptions
  private readonly bytesPerVoxel: number
  private readonly windowMin: number
  private readonly windowSpan: number
  private readonly lut: Uint8Array
  /** Plane position in EACH level's own voxel grid, by manifest level index. */
  private readonly planeForLevel: number[]
  private host: SlideSourceHost | null = null

  constructor(
    volume: ChunkedVolumeSource,
    options: VolumeSliceSourceOptions = {},
  ) {
    const levels = volume.levels
    if (!levels || levels.length === 0) {
      throw new Error('VolumeSliceSource: the volume source has no levels')
    }
    const bits = getBitsPerVoxel(volume.datatypeCode)
    if (!getTypedArrayConstructor(volume.datatypeCode) || bits === 0) {
      throw new Error(
        `VolumeSliceSource: datatype ${volume.datatypeCode} has no scalar voxels`,
      )
    }
    this.volume = volume
    this.options = options
    this.bytesPerVoxel = bits / 8
    this.axis = options.axis ?? 'z'
    this.planeAxes = PLANE_AXES[this.axis]
    const normal = AXIS_OF[this.axis]
    this.planeCount = levels[0].shape[normal]
    const index = options.index ?? Math.floor(this.planeCount / 2)
    if (!Number.isInteger(index) || index < 0 || index >= this.planeCount) {
      throw new Error(
        `VolumeSliceSource: plane ${index} is out of range ` +
          `(the volume has ${this.planeCount} along ${this.axis})`,
      )
    }
    this.index = index

    const [min, max] = options.window ?? [0, 255]
    if (!Number.isFinite(min) || !Number.isFinite(max)) {
      throw new Error('VolumeSliceSource: the window must be finite')
    }
    this.windowMin = min
    // A degenerate window would divide by zero; treat it as a 1-unit ramp so a
    // flat region renders black instead of NaN.
    this.windowSpan = max > min ? max - min : 1
    const lut = options.lut ?? null
    if (lut && lut.length !== 1024) {
      throw new Error(
        `VolumeSliceSource: the LUT must hold 256 RGBA entries (1024 bytes), got ${lut.length}`,
      )
    }
    this.lut = lut ?? grayLut()

    const tileSize = options.tileSize ?? DEFAULT_TILE_SIZE
    if (!Number.isInteger(tileSize) || tileSize < 1) {
      throw new Error(
        `VolumeSliceSource: tileSize must be a positive integer, got ${tileSize}`,
      )
    }
    const [uAxis, vAxis] = this.planeAxes
    const baseWidth = levels[0].shape[uAxis]
    const baseHeight = levels[0].shape[vAxis]
    const manifestLevels: NVSlideLevelManifest[] = []
    this.planeForLevel = []
    for (const [levelIndex, level] of levels.entries()) {
      const width = level.shape[uAxis]
      const height = level.shape[vAxis]
      const depth = level.shape[normal]
      if (width < 1 || height < 1 || depth < 1) {
        throw new Error(
          `VolumeSliceSource: level ${levelIndex} has an empty shape ` +
            `(${level.shape.join(' x ')})`,
        )
      }
      const columns = Math.ceil(width / tileSize)
      const rows = Math.ceil(height / tileSize)
      const tiles: NVSlideTileManifest[] = []
      for (let row = 0; row < rows; row++) {
        for (let column = 0; column < columns; column++) {
          tiles.push({
            x: column,
            y: row,
            width: Math.min(tileSize, width - column * tileSize),
            height: Math.min(tileSize, height - row * tileSize),
          })
        }
      }
      manifestLevels.push({
        index: levelIndex,
        width,
        height,
        downsample: baseWidth / width,
        tileWidth: tileSize,
        tileHeight: tileSize,
        columns,
        rows,
        codec: 'raw-rgba',
        tiles,
      })
      // Keep the plane at the same physical position as the level coarsens.
      this.planeForLevel.push(
        Math.min(
          depth - 1,
          Math.floor(((index + 0.5) * depth) / this.planeCount),
        ),
      )
      // Coarser than one tile buys nothing: NVSlide never picks such a level.
      if (columns <= 1 && rows <= 1) break
    }

    const id = options.id ?? 'volume-slice'
    this.manifest = {
      id,
      name: options.name ?? `${id} (${this.axis} ${index})`,
      format: 'volume-slice',
      width: baseWidth,
      height: baseHeight,
      tileSize,
      dtype: 'uint8',
      channels: 'rgba',
      displayYAxis: options.yAxis ?? 'up',
      levels: manifestLevels,
      ...(options.pixelSpacingMM
        ? { pixelSpacingMM: [...options.pixelSpacingMM] as [number, number] }
        : {}),
    }
  }

  /** The same plane orientation and appearance at another position. */
  withIndex(index: number): VolumeSliceSource {
    return new VolumeSliceSource(this.volume, { ...this.options, index })
  }

  bind(host: SlideSourceHost): void {
    this.host = host
  }

  async fetchTileBytes(
    level: NVSlideLevelManifest,
    tile: NVSlideTileManifest,
    label: string,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    const plane = this.planeForLevel[level.index]
    if (plane === undefined) {
      throw new Error(`VolumeSliceSource: no level ${level.index}`)
    }
    const [uAxis, vAxis] = this.planeAxes
    const normal = AXIS_OF[this.axis]
    const texOrigin: Vec3i = [0, 0, 0]
    const texDims: Vec3i = [1, 1, 1]
    texOrigin[normal] = plane
    texOrigin[uAxis] = tile.x * (level.tileWidth ?? tile.width)
    texOrigin[vAxis] = tile.y * (level.tileHeight ?? tile.height)
    texDims[uAxis] = tile.width
    texDims[vAxis] = tile.height

    this.host?.pushRangeEvent({ label, status: 'pending' })
    let voxels: Uint8Array
    try {
      voxels = await this.volume.fetchChunk({
        levelIndex: level.index,
        texOrigin,
        texDims,
        bytesPerVoxel: this.bytesPerVoxel,
        signal,
      })
    } catch (error) {
      this.host?.updateRangeEvent(label, signal?.aborted ? 'aborted' : 'failed')
      throw error
    }
    // The viewport may have moved while the fetch was resolving. If our signal
    // aborted in that window, this late-resolving read is stale: do no wire
    // accounting and do not mark 'hit'. Classify it as an abort (matching the
    // catch path) so NVSlide does not count a load NVSlide already treats as
    // aborted.
    if (signal?.aborted) {
      this.host?.updateRangeEvent(label, 'aborted')
    }
    signal?.throwIfAborted()
    // Voxel bytes READ, not necessarily bytes on the wire: the volume source
    // owns the transport (and may serve this region from its own cache).
    this.host?.addWireBytes(voxels.byteLength)
    this.host?.updateRangeEvent(label, 'hit')
    return this.toRgba(voxels, tile.width * tile.height)
  }

  /**
   * Window the region's scalar voxels through the LUT. The region is laid out
   * x-fastest then y then z with a single voxel along the plane normal, so the
   * pixel at (u, v) is always at `v * width + u` whichever axis is fixed.
   */
  private toRgba(voxels: Uint8Array, count: number): Uint8Array {
    const expected = count * this.bytesPerVoxel
    if (voxels.byteLength !== expected) {
      throw new Error(
        `VolumeSliceSource: region returned ${voxels.byteLength}B, expected ${expected}B`,
      )
    }
    const Ctor = getTypedArrayConstructor(this.volume.datatypeCode)
    if (!Ctor) {
      throw new Error(
        `VolumeSliceSource: datatype ${this.volume.datatypeCode} has no scalar voxels`,
      )
    }
    // A view needs its element alignment; copy when the region is a slice of a
    // larger buffer that does not start on one.
    const aligned =
      voxels.byteOffset % this.bytesPerVoxel === 0 ? voxels : voxels.slice()
    const values = new Ctor(
      aligned.buffer as ArrayBuffer,
      aligned.byteOffset,
      count,
    )
    const out = new Uint8Array(count * 4)
    const lut = this.lut
    const windowMin = this.windowMin
    const windowSpan = this.windowSpan
    for (let i = 0; i < count; i++) {
      const t = (values[i] - windowMin) / windowSpan
      // NaN fails both comparisons and falls through to 0.
      const shade = t >= 1 ? 255 : t > 0 ? (t * 255 + 0.5) | 0 : 0
      const entry = shade * 4
      const o = i * 4
      out[o] = lut[entry]
      out[o + 1] = lut[entry + 1]
      out[o + 2] = lut[entry + 2]
      out[o + 3] = lut[entry + 3]
    }
    return out
  }
}
