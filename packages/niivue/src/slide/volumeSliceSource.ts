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
 * const volume = await fetchOmeZarrChunkedSource(url) // @niivue/nv-ext-tile/zarr
 * await nv.loadChunkedVolume(volume)
 * const slide = NVSlide.fromSource(
 *   new VolumeSliceSource(volume, { axis: 'z', window: [0, 400] }),
 * )
 * ```
 *
 * Tiles are scalar samples ({@link VolumeSliceSource.fetchTileSamples}) in the
 * volume's own type (uint8, uint16, int16 or float32; other types as float32),
 * one channel whose window and colormap the options seed. Change them with
 * `slide.setChannel(0, { calMin, calMax, colormap })`, which re-fuses tiles on
 * the GPU without refetching. The plane is FIXED for the life of a source; step
 * through the volume with {@link VolumeSliceSource.withIndex}, which shares the
 * underlying volume source (and therefore its cache).
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
  NVSlideSampleArray,
  NVSlideTileManifest,
  NVSlideTileSamples,
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
   * Channel 0's initial window, in RAW voxel values. Default `[0, 255]`, which
   * is only right for uint8 data -- pass a real window (the same one the
   * volumetric view uses) for anything else.
   */
  window?: readonly [number, number]
  /** Channel 0's initial NiiVue colormap name. Default `'gray'`. */
  colormap?: string
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
    const Ctor = getTypedArrayConstructor(volume.datatypeCode)
    if (!Ctor || bits === 0) {
      throw new Error(
        `VolumeSliceSource: datatype ${volume.datatypeCode} has no scalar voxels`,
      )
    }
    this.volume = volume
    this.options = options
    this.bytesPerVoxel = bits / 8
    // Samples are the volume's type, or float32 for one a tile cannot hold:
    // the levels say so, for NVSlide's cache budget.
    const sampleBits =
      Ctor === Uint8Array
        ? 8
        : Ctor === Uint16Array || Ctor === Int16Array
          ? 16
          : 32
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
        bitsStored: sampleBits,
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
      dtype: 'scalar',
      channels: 'gray',
      displayYAxis: options.yAxis ?? 'up',
      levels: manifestLevels,
      channelInfo: [
        {
          name: id,
          colormap: options.colormap ?? 'gray',
          // A degenerate window would divide by zero: a 1-unit ramp instead.
          window: { calMin: min, calMax: max > min ? max : min + 1 },
          active: true,
        },
      ],
      ...(options.pixelSpacingMM
        ? { pixelSpacingMM: [...options.pixelSpacingMM] as [number, number] }
        : {}),
    }
  }

  /**
   * Min and max raw voxel value inside a box of the plane, given in base
   * pixels (any corner order) and read at manifest level `levelIndex`, where a
   * coarser level is cheaper. The NVSlide contrast gesture uses it, as NiiVue's
   * contrast drag does on a slice. null for an empty box or a flat region.
   */
  async intensityRange(
    box: { x0: number; y0: number; x1: number; y1: number },
    levelIndex = 0,
  ): Promise<[number, number] | null> {
    const level = this.manifest.levels[levelIndex]
    const plane = this.planeForLevel[levelIndex]
    if (!level || plane === undefined) return null
    const sx = level.width / this.manifest.width
    const sy = level.height / this.manifest.height
    const clampTo = (v: number, n: number) =>
      Math.max(0, Math.min(n, Math.floor(v)))
    const u0 = clampTo(Math.min(box.x0, box.x1) * sx, level.width)
    const u1 = clampTo(Math.max(box.x0, box.x1) * sx + 1, level.width)
    const v0 = clampTo(Math.min(box.y0, box.y1) * sy, level.height)
    const v1 = clampTo(Math.max(box.y0, box.y1) * sy + 1, level.height)
    if (!(u1 > u0 && v1 > v0)) return null
    const [uAxis, vAxis] = this.planeAxes
    const texOrigin: Vec3i = [0, 0, 0]
    const texDims: Vec3i = [1, 1, 1]
    texOrigin[AXIS_OF[this.axis]] = plane
    texOrigin[uAxis] = u0
    texOrigin[vAxis] = v0
    texDims[uAxis] = u1 - u0
    texDims[vAxis] = v1 - v0
    const voxels = await this.volume.fetchChunk({
      levelIndex,
      texOrigin,
      texDims,
      bytesPerVoxel: this.bytesPerVoxel,
    })
    const values = this.scalars(voxels, (u1 - u0) * (v1 - v0))
    let lo = Number.POSITIVE_INFINITY
    let hi = Number.NEGATIVE_INFINITY
    for (const v of values) {
      if (v < lo) lo = v
      if (v > hi) hi = v
    }
    return lo < hi ? [lo, hi] : null
  }

  /** The same plane orientation and appearance at another position. */
  withIndex(index: number): VolumeSliceSource {
    return new VolumeSliceSource(this.volume, { ...this.options, index })
  }

  bind(host: SlideSourceHost): void {
    this.host = host
  }

  /** Not used: NVSlide asks a sample source for {@link fetchTileSamples}. */
  async fetchTileBytes(): Promise<Uint8Array> {
    throw new Error('VolumeSliceSource serves samples (fetchTileSamples)')
  }

  /** The tile's voxels as one sample plane (`channels` is `[0]`). */
  async fetchTileSamples(
    level: NVSlideLevelManifest,
    tile: NVSlideTileManifest,
    _channels: readonly number[],
    signal?: AbortSignal,
  ): Promise<NVSlideTileSamples> {
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

    // NVSlide's label for the tile, so its abort lands on this event.
    const label = `L${level.index}/${tile.x}/${tile.y}`
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
    // The region is laid out x-fastest then y then z with a single voxel along
    // the plane normal, so the pixel at (u, v) is at `v * width + u` whichever
    // axis is fixed.
    const values = this.scalars(voxels, tile.width * tile.height)
    const samples: NVSlideSampleArray =
      values instanceof Uint8Array ||
      values instanceof Uint16Array ||
      values instanceof Int16Array ||
      values instanceof Float32Array
        ? // Own the bytes: the cache keeps them, not the source's buffer.
          values.slice()
        : Float32Array.from(values as ArrayLike<number>)
    return {
      samples,
      width: tile.width,
      height: tile.height,
      bitsStored: samples.BYTES_PER_ELEMENT * 8,
      planes: 1,
    }
  }

  /** The region's bytes as the volume's own scalar type. */
  private scalars(voxels: Uint8Array, count: number) {
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
    return values
  }
}
