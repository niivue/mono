import type {
  NVSlideChannelInfo,
  NVSlideLevelManifest,
  NVSlideManifest,
  NVSlidePlaneAxes,
  NVSlidePlaneIndex,
  NVSlideRangeEvent,
  NVSlideRangeStatus,
  NVSlideSampleArray,
  NVSlideTileFragment,
  NVSlideTileManifest,
  NVSlideTileSamples,
  SlideTileDecoder,
} from './NVSlide'
import { isMonochrome, readbackContext, readPixels } from './slideChannels'

/** A grey bitmap's red channel as 8-bit samples; closes the bitmap. */
function greySamples(bitmap: ImageBitmap): NVSlideTileSamples {
  const { width, height } = bitmap
  try {
    const ctx = readbackContext(width, height)
    if (!ctx) throw new Error('OffscreenCanvas 2D context unavailable')
    const rgba = readPixels(ctx, bitmap, 0, 0, width, height)
    const samples = new Uint8Array(width * height)
    for (let i = 0; i < samples.length; i++) samples[i] = rgba[i * 4] as number
    return { samples, width, height, bitsStored: 8 }
  } finally {
    bitmap.close()
  }
}

function copyUint8(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return copy
}

function copyClamped(bytes: Uint8Array): Uint8ClampedArray<ArrayBuffer> {
  const copy = new Uint8ClampedArray(bytes.byteLength)
  copy.set(bytes)
  return copy
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const length = parts.reduce((sum, part) => sum + part.byteLength, 0)
  const out = new Uint8Array(length)
  let ptr = 0
  for (const part of parts) {
    out.set(part, ptr)
    ptr += part.byteLength
  }
  return out
}

// Tile-codec registry. Built-ins cover the browser-native paths; additional
// codecs (e.g. image/jp2 via @niivue/dcm2niix) are registered by the
// consumer with NVSlide.registerTileDecoder, so the core ships no heavy codec.
export const tileDecoders = new Map<string, SlideTileDecoder>([
  [
    'image/jpeg',
    // No browser colour conversion: a slide's profile is the source's
    // (NVSlide.colorLut), not an APP2 segment inside a tile.
    (bytes) =>
      createImageBitmap(new Blob([copyUint8(bytes)], { type: 'image/jpeg' }), {
        colorSpaceConversion: 'none',
      }),
  ],
  [
    'raw-rgba',
    (bytes, { width, height }) => {
      const expected = width * height * 4
      if (bytes.byteLength !== expected) {
        throw new Error(
          `Expected ${expected} RGBA bytes, received ${bytes.byteLength}`,
        )
      }
      return createImageBitmap(new ImageData(copyClamped(bytes), width, height))
    },
  ],
  [
    'raw-gray',
    // Monochrome samples in platform byte order: the level's sampleType
    // (int16, float32), else unsigned, 8-bit when bitsStored is 8 or less,
    // else 16-bit (the default). Windowed by NVSlide like decoded DICOM
    // monochrome tiles.
    async (bytes, { width, height, level }) => {
      const { sampleType } = level
      const bitsStored = level.bitsStored ?? (sampleType === 'f32' ? 32 : 16)
      if (bitsStored > 16 && sampleType !== 'f32') {
        throw new Error(
          `raw-gray supports bitsStored up to 16, received ${bitsStored}`,
        )
      }
      const bytesPerSample =
        sampleType === 'f32'
          ? 4
          : sampleType === 'i16' || bitsStored > 8
            ? 2
            : 1
      if (bytes.byteLength !== width * height * bytesPerSample) {
        throw new Error(
          `Expected ${width}x${height} ${bytesPerSample * 8}-bit samples, received ${bytes.byteLength} bytes`,
        )
      }
      const { buffer } = copyUint8(bytes)
      const samples =
        sampleType === 'f32'
          ? new Float32Array(buffer)
          : sampleType === 'i16'
            ? new Int16Array(buffer)
            : bytesPerSample === 2
              ? new Uint16Array(buffer)
              : new Uint8Array(buffer)
      return { samples, width, height, bitsStored }
    },
  ],
])

/**
 * Telemetry + URL hooks a {@link SlideTileSource} uses. NVSlide implements this
 * so a source can resolve relative URLs and record wire bytes / range-request
 * status into the slide's stats + recent-request log without owning them.
 */
export interface SlideSourceHost {
  resolveUrl(url: string): string
  addWireBytes(bytes: number): void
  rangeHit(): void
  rangeFallback(): void
  pushRangeEvent(event: NVSlideRangeEvent): void
  updateRangeEvent(label: string, status: NVSlideRangeStatus): void
  /**
   * A source states channel `index`'s window or storedToValue after open, only
   * before that channel's first tile is served. NVSlide applies the window
   * unless the user has set one.
   */
  channelInfoChanged(
    index: number,
    patch: Pick<Partial<NVSlideChannelInfo>, 'window' | 'storedToValue'>,
  ): void
}

/**
 * A pluggable slide source: owns the pyramid manifest and fetches the bytes for
 * one tile in its level's `codec`: compressed (e.g. `image/jpeg`) or raw samples
 * (`raw-rgba` or `raw-gray`, as TIFF and Zarr return). NVSlide owns decoding, caching, stats
 * and the viewport; a source varies by FORMAT. {@link ManifestRangeSource} (the
 * default) addresses tiles as byte ranges in a per-level file (dicom-wsi-range-v1
 * and the synthetic pyramid); `DziSource` (per-tile URLs) and
 * `TiffSlideSource` in `@niivue/nv-ext-tile/tiff` (geotiff) implement the same contract.
 */
export interface SlideTileSource {
  readonly manifest: NVSlideManifest
  /** Adopted by an NVSlide before any fetch; wires up telemetry + URL resolution. */
  bind(host: SlideSourceHost): void
  /**
   * Fetch one tile's bytes in `level.codec` (compressed or raw samples); NVSlide
   * decodes them per that codec.
   *
   * `signal` fires when NVSlide no longer wants the tile -- the view moved on,
   * or the slide was disposed. A source that reads over the network should
   * pass it to `fetch()` so the read is abandoned on the wire rather than
   * discarded on arrival, and reject with an `AbortError`. Optional: a source
   * that ignores it stays correct, only wasteful, and NVSlide drops whatever
   * it resolves after the abort.
   */
  fetchTileBytes(
    level: NVSlideLevelManifest,
    tile: NVSlideTileManifest,
    label: string,
    signal?: AbortSignal,
  ): Promise<Uint8Array>
  /**
   * Decoded samples for one tile, one plane per entry of `channels` (indices
   * into {@link NVSlide.channels}, in that order): the visible ones, possibly
   * none (return `planes: 0`). When present NVSlide calls it instead of
   * `fetchTileBytes` and composites the planes itself. Such a source states
   * its channels in `manifest.channelInfo`; without it NVSlide assumes RGB
   * and asks for 3 planes. Optional.
   */
  fetchTileSamples?(
    level: NVSlideLevelManifest,
    tile: NVSlideTileManifest,
    channels: readonly number[],
    signal?: AbortSignal,
  ): Promise<NVSlideTileSamples>
  /** The slide's ICC profile bytes, or null when it has none. Optional. */
  fetchIccProfile?(signal?: AbortSignal): Promise<Uint8Array | null>
  /**
   * Release what this source owns: abort its reads (pending fetch* reject
   * AbortError), close files, revoke object URLs and terminate workers it
   * created, drop its caches. Never touches borrowed resources (a caller's
   * geotiff Pool or worker pool, the shared dcm2niix pool, a caller's fetch).
   * Idempotent; afterwards every fetch* rejects AbortError. Omitted by sources
   * that hold nothing. NVSlide calls it on dispose when it owns the source
   * (`NVSlideOptions.ownsSource`).
   */
  dispose?(): void
}

/**
 * A source with focal planes or time points. Fixed sources omit it; NVSlide
 * treats them as {z: 1, t: 1}.
 */
export interface SlidePlaneCapable {
  readonly planes: NVSlidePlaneAxes
  /**
   * The manifest of plane `p`, reading metadata only. Each level states
   * `plane`, which fetch* reads, so one bound source serves every plane.
   * Rejects RangeError out of bounds, AbortError on signal. Level-0 size,
   * pixelSpacingMM, channel count and per channel and level storedToValue,
   * sampleType and bitsStored must equal the current manifest's.
   */
  preparePlane(
    p: NVSlidePlaneIndex,
    signal?: AbortSignal,
  ): Promise<NVSlideManifest>
}

export function isAbortError(err: unknown): boolean {
  // Structural check: fetch() aborts reject with a DOMException named
  // 'AbortError', which is not an Error instance in every runtime.
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { name?: unknown }).name === 'AbortError'
  )
}

/**
 * Default source: a byte-range manifest (dicom-wsi-range-v1 / synthetic pyramid).
 * Each tile is one or more byte fragments addressed into a per-level file (or the
 * manifest `dataUrl`), fetched with an HTTP Range request (206) and a full-file
 * fallback for servers without range support.
 */
export class ManifestRangeSource implements SlideTileSource {
  readonly manifest: NVSlideManifest
  private host: SlideSourceHost | null = null

  constructor(manifest: NVSlideManifest) {
    this.manifest = manifest
  }

  bind(host: SlideSourceHost): void {
    this.host = host
  }

  private requireHost(): SlideSourceHost {
    if (!this.host) {
      throw new Error('ManifestRangeSource is not bound to an NVSlide host')
    }
    return this.host
  }

  private tileSourceUrl(level: NVSlideLevelManifest): string {
    const host = this.requireHost()
    if (level.fileUrl) return host.resolveUrl(level.fileUrl)
    if (this.manifest.dataUrl) return host.resolveUrl(this.manifest.dataUrl)
    throw new Error(`No byte source for slide L${level.index}`)
  }

  private tileFragments(tile: NVSlideTileManifest): NVSlideTileFragment[] {
    if (typeof tile.offset === 'number' && typeof tile.length === 'number') {
      return [{ offset: tile.offset, length: tile.length }]
    }
    if (tile.fragments && tile.fragments.length > 0) return tile.fragments
    throw new Error(`Tile ${tile.x}/${tile.y} has no byte ranges`)
  }

  private async fetchFragment(
    sourceUrl: string,
    fragment: NVSlideTileFragment,
    label: string,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    const host = this.requireHost()
    const start = fragment.offset
    const end = fragment.offset + fragment.length - 1
    const rangeLabel = `${label} ${start}-${end}`
    host.pushRangeEvent({ label: rangeLabel, status: 'pending' })
    let response: Response
    let wireBytes: Uint8Array
    try {
      response = await fetch(sourceUrl, {
        headers: { Range: `bytes=${start}-${end}` },
        signal,
      })
      if (!response.ok && response.status !== 206) {
        throw new Error(`HTTP ${response.status}`)
      }
      wireBytes = new Uint8Array(await response.arrayBuffer())
    } catch (error) {
      // The 'pending' entry must not outlive the request: a rejected fetch
      // (the load's signal firing, a network failure, an HTTP error) would
      // otherwise leave a stale 'pending' row in stats.lastRequests forever
      // (_runLoad's catch updates the TILE label, not this fragment's).
      host.updateRangeEvent(
        rangeLabel,
        signal?.aborted || isAbortError(error) ? 'aborted' : 'failed',
      )
      throw error
    }
    host.addWireBytes(wireBytes.byteLength)
    if (response.status === 206) {
      host.rangeHit()
      host.updateRangeEvent(rangeLabel, 'hit')
      if (wireBytes.byteLength !== fragment.length) {
        throw new Error(
          `Expected ${fragment.length} bytes, received ${wireBytes.byteLength}`,
        )
      }
      return wireBytes
    }
    host.rangeFallback()
    host.updateRangeEvent(rangeLabel, 'fallback')
    return wireBytes.slice(start, end + 1)
  }

  async fetchTileBytes(
    level: NVSlideLevelManifest,
    tile: NVSlideTileManifest,
    label: string,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    const sourceUrl = tile.fileUrl
      ? this.requireHost().resolveUrl(tile.fileUrl)
      : this.tileSourceUrl(level)
    const fragments = this.tileFragments(tile)
    const parts = await Promise.all(
      fragments.map((fragment) =>
        this.fetchFragment(sourceUrl, fragment, label, signal),
      ),
    )
    return parts.length === 1 ? (parts[0] as Uint8Array) : concatBytes(parts)
  }

  async fetchIccProfile(signal?: AbortSignal): Promise<Uint8Array | null> {
    const icc = this.manifest.iccProfile
    if (!icc) return null
    const url = this.requireHost().resolveUrl(icc.url)
    const { offset, length } = icc
    if ((offset === undefined) !== (length === undefined))
      throw new Error('ICC profile states only one of offset and length')
    // 64 MB: far beyond a scanner profile (Leica's is 13 MB), as dcm2niix caps it.
    if (length !== undefined && length > 64 * 1024 * 1024)
      throw new Error(`ICC profile of ${length} bytes`)
    if (offset !== undefined && length !== undefined)
      return this.fetchFragment(url, { offset, length }, 'icc', signal)
    const response = await fetch(url, { signal })
    if (!response.ok) throw new Error(`ICC profile HTTP ${response.status}`)
    return new Uint8Array(await response.arrayBuffer())
  }
}

/**
 * Refuse a DICOM-WSI manifest whose levels are not known to hold a single optical
 * path and focal plane: their frames would otherwise be laid out as one tile grid,
 * putting tiles from other channels or depths in the wrong places. Other formats
 * (DZI, TIFF, synthetic) have no such dimensions.
 *
 * A TILED_FULL level's frames cover the grid once per path and plane, so the frame
 * count confirms the tags and, when one is absent, proves it is 1 only if the
 * frames equal the grid. With no frame count (NumberOfFrames is Type 1, but a
 * server may still omit it), tags stating one of each are taken as given.
 */
export function assertSingleSlidePlane(manifest: NVSlideManifest): void {
  if (!manifest.format?.startsWith('dicom-wsi')) return
  for (const level of manifest.levels) {
    if (level.sparse) {
      if (level.opticalPaths === 1 && level.focalPlanes === 1) continue
      throw new Error(
        `Slide level ${level.index} is sparse but does not state one optical path and one focal plane`,
      )
    }
    const { frames } = level
    if (
      frames === undefined &&
      level.opticalPaths === 1 &&
      level.focalPlanes === 1
    )
      continue
    const grid = level.columns * level.rows
    const paths = level.opticalPaths ?? (frames === grid ? 1 : undefined)
    const planes = level.focalPlanes ?? (frames === grid ? 1 : undefined)
    const known =
      paths !== undefined &&
      planes !== undefined &&
      frames === grid * paths * planes
    if (known && paths === 1 && planes === 1) continue
    const what = known
      ? `holds ${paths} optical paths and ${planes} focal planes; only one of each is supported`
      : 'has optical paths or focal planes that are unknown or disagree with its frame count'
    throw new Error(`Slide level ${level.index} ${what}`)
  }
}

// The same bound as nv-ext-tile's DICOM-WSI index: the largest real level
// grid is 379k tiles, so a hosted manifest past this is broken or hostile.
export const MAX_SLIDE_GRID = 1 << 22

export function assertSlideGrid(tiles: number, levelIndex: number): void {
  if (tiles > MAX_SLIDE_GRID)
    throw new Error(
      `Slide level ${levelIndex} has ${tiles} tiles, over the ${MAX_SLIDE_GRID} a level may hold`,
    )
}

/**
 * A level that lists only its present tiles, or is sparse, becomes the dense
 * row-major grid with null holes, placed by each tile's x/y (a listing's order
 * is not trusted). Off-grid tiles and second tiles for a cell are dropped.
 * Returns a new level; the caller's manifest is not changed.
 */
export function placeListedTiles(
  level: NVSlideLevelManifest,
): NVSlideLevelManifest {
  const n = level.columns * level.rows
  assertSlideGrid(n, level.index)
  if (!level.sparse && level.tiles.length === n) return level
  const grid: Array<NVSlideTileManifest | null> = new Array(n).fill(null)
  for (const tile of level.tiles) {
    if (!tile) continue
    const { x, y } = tile
    if (!Number.isInteger(x) || !Number.isInteger(y)) continue
    if (x < 0 || y < 0 || x >= level.columns || y >= level.rows) continue
    grid[y * level.columns + x] ??= tile
  }
  return { ...level, tiles: grid }
}

/** The top-left `width` x `height` of each plane of a padded sample frame. */
export function cropSamples(
  frame: NVSlideTileSamples,
  width: number,
  height: number,
): NVSlideTileSamples {
  const w = Math.min(frame.width, width)
  const h = Math.min(frame.height, height)
  const planes = frame.planes ?? 1
  const Samples = frame.samples.constructor as new (
    n: number,
  ) => NVSlideSampleArray
  const samples = new Samples(w * h * planes)
  for (let p = 0; p < planes; p++)
    for (let y = 0; y < h; y++) {
      const from = (p * frame.height + y) * frame.width
      samples.set(frame.samples.subarray(from, from + w), (p * h + y) * w)
    }
  return { ...frame, samples, width: w, height: h }
}

export async function decodeTileBitmap(
  level: NVSlideLevelManifest,
  tile: NVSlideTileManifest,
  tileBytes: Uint8Array,
  signal: AbortSignal,
): Promise<ImageBitmap | NVSlideTileSamples> {
  const codec = level.codec ?? 'raw-rgba'
  const decoder = tileDecoders.get(codec)
  if (!decoder) {
    throw new Error(
      `No decoder for tile codec "${codec}". ` +
        'Register one with NVSlide.registerTileDecoder() ' +
        '(e.g. @niivue/dcm2niix createFrameDecoder for image/jp2).',
    )
  }
  let decoded = await decoder(tileBytes, {
    width: tile.width,
    height: tile.height,
    level,
    signal,
  })
  // A decoder that returns only a bitmap (the browser's JPEG) still windows:
  // a monochrome tile's grey level comes back as 8-bit samples.
  // Without a 2D OffscreenCanvas (Safari < 16.4) such a tile shows unwindowed.
  if (
    isMonochrome(level) &&
    !('samples' in decoded) &&
    typeof OffscreenCanvas !== 'undefined'
  )
    decoded = greySamples(decoded)
  // Formats that store whole tiles (DICOM) pad edge frames, and every frame of
  // a level smaller than one tile, at the right and bottom. Padding is not
  // slide: crop it, or the level's image shrinks into one corner.
  if (decoded.width <= tile.width && decoded.height <= tile.height)
    return decoded
  if ('samples' in decoded) return cropSamples(decoded, tile.width, tile.height)
  const bitmap = decoded
  try {
    return await createImageBitmap(
      bitmap,
      0,
      0,
      Math.min(bitmap.width, tile.width),
      Math.min(bitmap.height, tile.height),
    )
  } finally {
    bitmap.close()
  }
}
