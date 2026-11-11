/**
 * Load an OME-Zarr image as one NiiVue volume PER CHANNEL.
 *
 * An OME-Zarr store is a resolution pyramid over up to five dimensions; this
 * loader picks one level, pins the time and channel axes, and assembles each
 * requested channel's spatial block into a NIfTI `File`, so callers hand the
 * whole list to `loadVolumes`:
 *
 * ```ts
 * const channels = await loadOmeZarrVolumes(url, { channels: [0, 2] })
 * await nv.loadVolumes(channels)
 * ```
 *
 * Channel display comes from the store's own `omero` block: each volume is
 * named by its channel label, coloured by the closest palette match to its
 * stated colour, and windowed to its stated intensity range. By default only
 * the channels omero marks active load.
 *
 * The metadata parse lives in `omeZarr.ts`; store access and chunk decoding
 * are zarrita's. See `docs/ome-zarr-format.md`.
 */

import type {
  ImageFromUrlOptions,
  TypedVoxelArray,
  VolumeFrameSource,
} from '@niivue/niivue'
import {
  channelColormapsFor,
  channelVolumeFile,
  NiiDataType,
} from '@niivue/niivue'
import * as zarr from '@niivue/zarrita-rs/inline'
import {
  allocTypedArrayLike,
  checkOmeZarrIndex,
  type OmeZarrAxis,
  type OmeZarrAxisIndices,
  type OmeZarrInfo,
  type OmeZarrSpatialOrder,
  omeroActiveChannels,
  omeroWindowUsable,
  omeZarrAxisIndices,
  omeZarrResolveAxes,
  omeZarrSpatialOrder,
  omeZarrSpatialScaleUm,
  parseOmeZarrAttrs,
} from './omeZarr'

/** Zarr dtypes this loader can hand to the NIfTI assembler. */
const ZARR_TO_NIFTI: Record<string, number> = {
  uint8: NiiDataType.DT_UINT8,
  int8: NiiDataType.DT_INT8,
  uint16: NiiDataType.DT_UINT16,
  int16: NiiDataType.DT_INT16,
  uint32: NiiDataType.DT_UINT32,
  int32: NiiDataType.DT_INT32,
  float32: NiiDataType.DT_FLOAT32,
  float64: NiiDataType.DT_FLOAT64,
}

/**
 * The NIfTI datatype code for a zarr dtype, throwing on the ones NIfTI has no
 * lossless home for (int64, bool, strings).
 */
export function omeZarrNiftiDatatype(dtype: string): number {
  const code = ZARR_TO_NIFTI[dtype]
  if (code === undefined) {
    throw new Error(`OME-Zarr: dtype '${dtype}' is not supported`)
  }
  return code
}

const BYTES_PER_ELEMENT: Record<string, number> = {
  uint8: 1,
  int8: 1,
  uint16: 2,
  int16: 2,
  uint32: 4,
  int32: 4,
  float32: 4,
  float64: 8,
}

/**
 * The default per-channel decoded-size budget for the automatic level pick.
 * Generous enough for a full fluorescence stack, small enough that pointing
 * the loader at a slide-sized pyramid cannot flood the network or the GPU,
 * the lesson of the streaming demo's L0 incident.
 */
export const OME_ZARR_LEVEL_BUDGET_BYTES = 256 * 2 ** 20

/** One resolution level, described in display terms. */
export interface OmeZarrLevel {
  /** Store-relative path of the level's array. */
  path: string
  /**
   * Index into the multiscale's `datasets` list (0 = finest). Differs from
   * the level's position in {@link OmeZarrSource.levels} when only a subset
   * was opened (see {@link OpenOmeZarrOptions.levels}).
   */
  datasetIndex: number
  /** The array's full shape in declared axis order. */
  shape: number[]
  /** Normalized zarr dtype (`uint16`, `float32`, ...). */
  dtype: string
  /** Spatial extent in display order [x, y, z]. */
  dims: [number, number, number]
  /** Voxel spacing in display order, micrometres. */
  spacingUm: [number, number, number]
  /** Decoded bytes for ONE channel at ONE timepoint. */
  channelBytes: number
}

/** An opened store: parsed metadata plus one zarrita array per level. */
export interface OmeZarrSource {
  info: OmeZarrInfo
  /** Resolution levels, finest first. */
  levels: OmeZarrLevel[]
  /** The `@niivue/zarrita-rs/inline` arrays backing `levels`, index for index. Read them with that entry's `get`: the default `@niivue/zarrita-rs` entry and zarrita.js throw on them. */
  arrays: zarr.Array<zarr.DataType, zarr.Readable>[]
  /** Concrete axes shared by every level. */
  axes: OmeZarrAxis[]
  indices: OmeZarrAxisIndices
  order: OmeZarrSpatialOrder
  channelCount: number
  timepointCount: number
}

/** Options for {@link loadOmeZarrVolumes}. */
export interface OmeZarrLoadOptions {
  /**
   * Channel indices to load, all visible, in the order the volumes should be
   * returned. `'all'` loads every channel, hiding those omero marks inactive.
   * Defaults to the active channels (see {@link omeZarrChannelOptions}).
   */
  channels?: number[] | 'all'
  /** Timepoint to load (with `lazyTime`, the first shown). Defaults to the first. */
  timepoint?: number
  /**
   * Fetch other timepoints on demand: each volume gets a `frameSource`, so
   * `nv.setFrame4D(volume.id, t)` reads frame `t` (every channel of the store
   * switches together) and resolves once it is shown. An object is a shared
   * group key: stores loaded with the same object (raw + segmentation) switch
   * together too.
   */
  lazyTime?: boolean | object
  /** Decoded-frame cache budget for `lazyTime`, per store. Default 256 MiB. */
  frameCacheBytes?: number
  /**
   * Show the store as a segmentation: a generated label colormap (`Random`,
   * ID 0 clear) instead of the omero ramp and window. Defaults to whether the
   * store declares `image-label` metadata.
   */
  labels?: boolean
  /**
   * Pyramid level to read (0 = finest). Defaults to the finest level whose
   * per-channel decoded size fits {@link OmeZarrLoadOptions.levelBudgetBytes}.
   */
  level?: number
  /** Budget for the automatic level pick. Default 256 MiB per channel. */
  levelBudgetBytes?: number
  /** Override the fetcher, e.g. to add credentials or a cache. */
  fetchImpl?: (request: Request) => Promise<Response>
}

function displayDims(
  shape: number[],
  spatial: number[],
  order: OmeZarrSpatialOrder,
): [number, number, number] {
  return [
    shape[spatial[order.x]],
    shape[spatial[order.y]],
    order.z < 0 ? 1 : shape[spatial[order.z]],
  ]
}

/** Options for {@link openOmeZarr} / {@link fetchOmeZarr}. */
export interface OpenOmeZarrOptions {
  /**
   * Dataset indices (into the multiscale's `datasets` list) to open, finest
   * first. Defaults to every dataset. Use with a store that mirrors only some
   * levels, or to skip levels a consumer will never read.
   */
  levels?: number[]
  /**
   * Skip a requested level whose array is missing from the store (a partial
   * mirror) instead of throwing. At least one level must open.
   */
  ignoreMissingLevels?: boolean
  /**
   * The store's Zarr format, when the caller knows it. Unset, the root is
   * probed as v3 then v2, which logs a 404 for `zarr.json` on every v2 store.
   */
  zarrVersion?: 2 | 3
}

/**
 * Open the store root once, learning the Zarr format version so every level
 * array can be opened version-pinned. The version-agnostic `zarr.open` probes
 * v3 then v2 PER NODE, which costs a 404 per level on every v2 store.
 */
async function openStoreRoot(
  store: zarr.Readable,
  known?: 2 | 3,
): Promise<{
  group: zarr.Group<zarr.Readable>
  openArray: (path: string) => Promise<zarr.Array<zarr.DataType, zarr.Readable>>
}> {
  const root = zarr.root(store)
  let node: zarr.Group<zarr.Readable> | zarr.Array<zarr.DataType, zarr.Readable>
  let version: 2 | 3 = known ?? 3
  // A known version also skips the array probe: an OME-Zarr root is a group.
  if (known) {
    node = await (known === 2 ? zarr.open.v2 : zarr.open.v3)(root, {
      kind: 'group',
    })
  } else {
    try {
      node = await zarr.open.v3(root)
    } catch (err) {
      if (!zarr.isZarritaError(err, 'NotFoundError')) {
        throw err
      }
      node = await zarr.open.v2(root)
      version = 2
    }
  }
  if (node.kind !== 'group') {
    throw new Error('OME-Zarr: the store root is a Zarr array, not a group')
  }
  const group = node
  const openArray = (path: string) =>
    version === 3
      ? zarr.open.v3(group.resolve(path), { kind: 'array' })
      : zarr.open.v2(group.resolve(path), { kind: 'array' })
  return { group, openArray }
}

/**
 * Open an already-constructed store (any zarrita `Readable`, e.g. a `Map` in
 * tests) and describe its pyramid. Split out from {@link fetchOmeZarr} so
 * callers with a custom store do not need a URL.
 */
export async function openOmeZarr(
  store: zarr.Readable,
  options: OpenOmeZarrOptions = {},
): Promise<OmeZarrSource> {
  const { group, openArray } = await openStoreRoot(store, options.zarrVersion)
  const info = parseOmeZarrAttrs(group.attrs)

  const wanted = options.levels ?? info.datasets.map((_dataset, index) => index)
  for (const datasetIndex of wanted) {
    if (
      !Number.isInteger(datasetIndex) ||
      datasetIndex < 0 ||
      datasetIndex >= info.datasets.length
    ) {
      throw new Error(
        `OME-Zarr: level ${datasetIndex} is out of range ` +
          `(the multiscale lists ${info.datasets.length} datasets)`,
      )
    }
  }
  const opened = (
    await Promise.all(
      [...wanted]
        .sort((a, b) => a - b)
        .map(async (datasetIndex) => {
          try {
            return {
              datasetIndex,
              array: await openArray(info.datasets[datasetIndex].path),
            }
          } catch (err) {
            if (
              options.ignoreMissingLevels &&
              zarr.isZarritaError(err, 'NotFoundError')
            ) {
              return null
            }
            throw err
          }
        }),
    )
  ).filter((entry) => entry !== null)
  if (opened.length === 0) {
    throw new Error('OME-Zarr: none of the requested levels are present')
  }

  const axes = omeZarrResolveAxes(info, opened[0].array.shape.length)
  const indices = omeZarrAxisIndices(axes)
  const order = omeZarrSpatialOrder(axes, indices.spatial)

  const levels: OmeZarrLevel[] = opened.map(({ array, datasetIndex }) => {
    if (array.shape.length !== axes.length) {
      throw new Error(
        `OME-Zarr: level ${datasetIndex} has ${array.shape.length} ` +
          `dimensions, expected ${axes.length}`,
      )
    }
    const dims = displayDims(array.shape, indices.spatial, order)
    return {
      path: info.datasets[datasetIndex].path,
      datasetIndex,
      shape: array.shape,
      dtype: array.dtype,
      dims,
      spacingUm: omeZarrSpatialScaleUm(info.datasets[datasetIndex], axes),
      channelBytes:
        dims[0] * dims[1] * dims[2] * (BYTES_PER_ELEMENT[array.dtype] ?? 0),
    }
  })

  const finest = opened[0].array
  return {
    info,
    levels,
    arrays: opened.map((entry) => entry.array),
    axes,
    indices,
    order,
    channelCount: indices.channel < 0 ? 1 : finest.shape[indices.channel],
    timepointCount: indices.time < 0 ? 1 : finest.shape[indices.time],
  }
}

/**
 * Fetch an OME-Zarr store's metadata and open every pyramid level, without
 * reading any chunks.
 *
 * Useful on its own for building a channel or level picker before committing
 * to the (much larger) chunk reads.
 */
export async function fetchOmeZarr(
  url: string,
  options: OpenOmeZarrOptions & Pick<OmeZarrLoadOptions, 'fetchImpl'> = {},
): Promise<OmeZarrSource> {
  return openOmeZarr(omeZarrFetchStore(url, options.fetchImpl), options)
}

/**
 * A FetchStore that reads a successful HTML answer as a missing key: a dev server's or
 * SPA host's fallback page (200, for any path) is never store data, and zarrita
 * only falls back from v3 to v2 metadata on a missing key. A ranged read answered
 * 200 (the whole file) is rejected.
 */
export function omeZarrFetchStore(
  url: string,
  fetchImpl: (request: Request) => Promise<Response> = (r) => fetch(r),
): zarr.FetchStore {
  return new zarr.FetchStore(url, {
    async fetch(request) {
      const response = await fetchImpl(request)
      // Only a success: an HTML error page (502, 429, 403) must still throw.
      const type = response.headers.get('content-type')?.toLowerCase()
      if (response.ok && type?.startsWith('text/html')) {
        await response.body?.cancel()
        return new Response(null, { status: 404 })
      }
      // A server that ignores Range would send the whole file (a shard) per read.
      if (response.status === 200 && request.headers.has('range')) {
        await response.body?.cancel()
        throw new Error(
          `OME-Zarr: ${request.url} ignored the Range request (200, not 206)`,
        )
      }
      return response
    },
  })
}

/** The number of channels the store's channel axis carries (1 when absent). */
export function omeZarrChannelCount(source: OmeZarrSource): number {
  return source.channelCount
}

/** A channel's display name: its omero label, else a positional fallback. */
export function omeZarrChannelName(
  source: OmeZarrSource,
  channel: number,
): string {
  return source.info.channels[channel]?.label ?? `Channel ${channel + 1}`
}

/**
 * Display options for channel `c` as {@link omeZarrVolumesFrom} sets them: omero
 * label, colour and usable window, and `visible` when omero marks it active (a
 * missing flag counts as active; when every channel is marked inactive, channel 0
 * stays visible). Use it to style channels streamed through `omeZarrChunkedSource`.
 * `together` lists the channels shown with `c`, so two stating the same colour
 * get distinct ramps; it defaults to the active channels.
 */
export function omeZarrChannelOptions(
  source: OmeZarrSource,
  c: number,
  together: readonly number[] = omeroActiveChannels(
    source.info.channels,
    source.channelCount,
  ),
): OmeZarrChannelDisplay {
  const list = together.includes(c) ? together : [...together, c]
  const colormaps = channelColormapsFor(
    list.map((i) => source.info.channels[i]?.color),
  )
  // The chunked source requires levels to share a dtype.
  return channelDisplay(
    source,
    c,
    colormaps[list.indexOf(c)],
    source.levels[0].dtype,
  )
}

/** What {@link omeZarrChannelOptions} returns. */
export interface OmeZarrChannelDisplay {
  name: string
  colormap: string
  calMin?: number
  calMax?: number
  visible: boolean
}

function channelDisplay(
  source: OmeZarrSource,
  c: number,
  colormap: string,
  dtype: string,
): OmeZarrChannelDisplay {
  // A placeholder window is dropped, so the caller falls back to the data's
  // own range as it does for a channel with no window.
  const stated = source.info.channels[c]?.window
  const window = stated && omeroWindowUsable(stated, dtype) ? stated : null
  return {
    name: omeZarrChannelName(source, c),
    colormap,
    ...(window ? { calMin: window.start, calMax: window.end } : {}),
    visible: omeroActiveChannels(
      source.info.channels,
      source.channelCount,
    ).includes(c),
  }
}

/**
 * The finest level whose per-channel decoded size fits the budget, else the
 * coarsest level there is (levels are listed finest first).
 */
export function defaultOmeZarrLevel(
  source: OmeZarrSource,
  budgetBytes: number = OME_ZARR_LEVEL_BUDGET_BYTES,
): number {
  for (const [index, level] of source.levels.entries()) {
    if (level.channelBytes > 0 && level.channelBytes <= budgetBytes) {
      return index
    }
  }
  return source.levels.length - 1
}

/**
 * Wrap an assembled channel as a NIfTI `File` ready for `loadVolumes`,
 * origin-centred like every microscopy channel loader (see
 * `channelVolumeFile.ts`).
 */
export function omeZarrChannelFile(
  dims: readonly [number, number, number],
  spacingUm: readonly [number, number, number],
  datatypeCode: number,
  img: TypedVoxelArray,
  name: string,
): File {
  return channelVolumeFile(dims, spacingUm, datatypeCode, img, name)
}

/**
 * Reorder a read spatial block to NIfTI's x-fastest layout.
 *
 * zarrita returns the block C-ordered over the axes as DECLARED, so a
 * conventional `z y x` file is already x-fastest and passes through untouched;
 * an `x y z` file (e.g. the Human Organ Atlas) is transposed here, honouring
 * its declared order instead of presenting the anatomy rotated.
 */
export function omeZarrBlockToDisplay(
  data: TypedVoxelArray,
  shape: number[],
  stride: number[],
  order: OmeZarrSpatialOrder,
): { img: TypedVoxelArray; dims: [number, number, number] } {
  const nx = shape[order.x]
  const ny = shape[order.y]
  const nz = order.z < 0 ? 1 : shape[order.z]
  const strideX = stride[order.x]
  const strideY = stride[order.y]
  const strideZ = order.z < 0 ? 0 : stride[order.z]
  if (strideX === 1 && strideY === nx && (nz === 1 || strideZ === nx * ny)) {
    return { img: data, dims: [nx, ny, nz] }
  }
  const img = allocTypedArrayLike(data, nx * ny * nz)
  let out = 0
  for (let z = 0; z < nz; z++) {
    for (let y = 0; y < ny; y++) {
      let src = z * strideZ + y * strideY
      for (let x = 0; x < nx; x++) {
        img[out] = data[src]
        out += 1
        src += strideX
      }
    }
  }
  return { img, dims: [nx, ny, nz] }
}

/**
 * Build the per-channel load options from an already-opened store.
 *
 * Split out from {@link loadOmeZarrVolumes} so a caller that opened the store
 * itself (to show a channel picker) does not re-fetch the metadata.
 */
export async function omeZarrVolumesFrom(
  source: OmeZarrSource,
  options: OmeZarrLoadOptions = {},
): Promise<ImageFromUrlOptions[]> {
  const level =
    options.level ?? defaultOmeZarrLevel(source, options.levelBudgetBytes)
  checkOmeZarrIndex('level', level, source.levels.length)
  const datatypeCode = omeZarrNiftiDatatype(source.levels[level].dtype)

  const timepoint = options.timepoint ?? 0
  checkOmeZarrIndex('timepoint', timepoint, source.timepointCount)

  const total = source.channelCount
  const wanted =
    options.channels === 'all'
      ? Array.from({ length: total }, (_unused, i) => i)
      : (options.channels ?? omeroActiveChannels(source.info.channels, total))
  // Validate up front so a bad index fails before any chunk is fetched.
  for (const channel of wanted) checkOmeZarrIndex('channel', channel, total)

  const { indices, order } = source
  const array = source.arrays[level]
  const dtype = source.levels[level].dtype
  const labels = options.labels ?? source.info.isLabel
  const colormaps = channelColormapsFor(
    wanted.map((channel) => source.info.channels[channel]?.color),
  )
  // Spatial axes stay whole (null); time and channel pin to one index; any
  // other axis the file declares is pinned to its first entry.
  const readFrame = async (
    channel: number,
    t: number,
    signal?: AbortSignal,
  ): Promise<TypedVoxelArray> => {
    const selection = array.shape.map((_extent, axis) => {
      if (axis === indices.channel) {
        return channel
      }
      if (axis === indices.time) {
        return t
      }
      return indices.spatial.includes(axis) ? null : 0
    })
    const block = await zarr.get(array, selection, { signal })
    if (typeof block !== 'object' || block === null || !('data' in block)) {
      throw new Error('OME-Zarr: reading a level returned no block')
    }
    return omeZarrBlockToDisplay(
      block.data as TypedVoxelArray,
      block.shape,
      block.stride,
      order,
    ).img
  }
  const frames = options.lazyTime
    ? omeZarrFrameCache(
        options.frameCacheBytes ?? OME_ZARR_FRAME_CACHE_BYTES,
        readFrame,
      )
    : null
  const group = typeof options.lazyTime === 'object' ? options.lazyTime : {}
  const volumes: ImageFromUrlOptions[] = []
  for (const [orderIndex, channel] of wanted.entries()) {
    const img = frames
      ? await frames.load(channel, timepoint)
      : await readFrame(channel, timepoint)
    const display = channelDisplay(
      source,
      channel,
      colormaps[orderIndex],
      dtype,
    )
    const frameSource: VolumeFrameSource | undefined = frames
      ? {
          count: source.timepointCount,
          frame: timepoint,
          group,
          load: (t, signal) => frames.load(channel, t, signal),
        }
      : undefined
    volumes.push({
      ...(labels ? { name: display.name, colormap: 'Random' } : display),
      url: omeZarrChannelFile(
        source.levels[level].dims,
        source.levels[level].spacingUm,
        datatypeCode,
        img,
        display.name,
      ),
      // Only 'all' loads inactive channels; requested ones always show.
      visible: options.channels !== 'all' || display.visible,
      ...(frameSource ? { frameSource } : {}),
    })
  }
  return volumes
}

/** Default {@link OmeZarrLoadOptions.frameCacheBytes}. */
export const OME_ZARR_FRAME_CACHE_BYTES = 256 * 2 ** 20

/**
 * Decoded frames keyed by channel and timepoint, least recently used evicted
 * first once their bytes pass `budgetBytes`. A frame being read is shared by
 * every caller asking for it; once all of them abort, the read is aborted and
 * dropped, so a later request for that frame starts a fresh read instead of joining a cancelled one.
 */
export function omeZarrFrameCache(
  budgetBytes: number,
  read: (
    channel: number,
    t: number,
    signal?: AbortSignal,
  ) => Promise<TypedVoxelArray>,
): {
  load(
    channel: number,
    t: number,
    signal?: AbortSignal,
  ): Promise<TypedVoxelArray>
  /** Bytes of the frames held. */
  readonly bytes: number
} {
  const entries = new Map<string, Promise<TypedVoxelArray>>()
  const sizes = new Map<string, number>()
  // An unsettled read and the callers waiting on it: it is aborted only once
  // every caller that joined it has aborted (one caller's abort must not fail
  // another's load).
  const reads = new Map<string, { ctl: AbortController; waiting: number }>()
  let bytes = 0
  const drop = (key: string) => {
    entries.delete(key)
    reads.delete(key)
    bytes -= sizes.get(key) ?? 0
    sizes.delete(key)
  }
  return {
    get bytes() {
      return bytes
    },
    load(channel, t, signal) {
      const key = `${channel}:${t}`
      let pending = entries.get(key)
      if (pending) {
        // Re-insert: Map order is the recency order.
        entries.delete(key)
        entries.set(key, pending)
      } else {
        const run = { ctl: new AbortController(), waiting: 0 }
        const own: Promise<TypedVoxelArray> = read(
          channel,
          t,
          run.ctl.signal,
        ).then((img) => {
          if (entries.get(key) !== own) return img
          reads.delete(key)
          sizes.set(key, img.byteLength)
          bytes += img.byteLength
          for (const old of entries.keys()) {
            if (bytes <= budgetBytes) break
            if (old !== key && sizes.has(old)) drop(old)
          }
          return img
        })
        own.catch(() => {
          if (entries.get(key) === own) drop(key)
        })
        entries.set(key, own)
        reads.set(key, run)
        pending = own
      }
      const run = reads.get(key)
      if (run) {
        run.waiting++
        // A caller without a signal keeps the read alive.
        signal?.addEventListener(
          'abort',
          () => {
            if (--run.waiting === 0 && reads.get(key) === run) {
              run.ctl.abort()
              drop(key)
            }
          },
          { once: true },
        )
      }
      return pending
    },
  }
}

/**
 * Load the requested channels of an OME-Zarr store.
 *
 * The metadata is fetched and parsed ONCE; each channel then reads only its
 * own chunks of the chosen level.
 */
export async function loadOmeZarrVolumes(
  url: string,
  options: OmeZarrLoadOptions = {},
): Promise<ImageFromUrlOptions[]> {
  const source = await fetchOmeZarr(url, options)
  return omeZarrVolumesFrom(source, options)
}
