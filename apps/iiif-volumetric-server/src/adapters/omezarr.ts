// OME-Zarr (NGFF) adapter. Reads real chunk data via zarrita, supporting
// Zarr v2 + v3 stores with blosc/gzip/zstd compressed chunks.
//
// Pyramid handling: we walk multiscales[0].datasets, try to open each
// one's array metadata, and surface only the levels actually available
// on disk. Those are then renumbered densely (0..N-1) with the
// highest-resolution available level becoming level 0 — that way a
// partial fetch (e.g. only s5) still works through the registry's
// "level 0 is the default" convention. The OME-Zarr dataset path
// (e.g. "s5") is stashed internally so we can address chunks correctly.
//
// load(dir) materialises level 0; loadLevel(dir, i) any registry level.
// Each load reads the entire level into RAM — fine for s4/s5 tiers,
// painful for s0 of multi-GB EM stacks. Streaming/sparse rendering is
// a separate project (see CLOUD_DEPLOYMENT_PLAN.md).
//
// Layout: NGFF spatial axes are always the trailing dims (..., z, y, x).
// Zarr arrays are stored C-order (last-axis-fastest), which is the same
// byte layout as Fortran-order (x-fastest) when the shape is relabelled
// from (Z, Y, X) to (X, Y, Z) — VolumeHandle's convention. No transpose
// needed.

import FileSystemStore from '@zarrita/storage/fs'
import * as zarr from 'zarrita'
import type {
  AdapterChannel,
  AdapterContext,
  AdapterLevel,
  ChannelSelector,
  ProbeMeta,
  SubvolumeBbox,
  VolumeAdapter,
} from './nifti.ts'
import type { Dtype, Shape3, Vec3, VoxelArray } from './volumeHandle.ts'
import { VolumeHandle } from './volumeHandle.ts'

interface NgffAxis {
  name?: string
  type?: string
  unit?: string
}

interface NgffCoordinateTransform {
  type: string
  scale?: number[]
  translation?: number[]
}

interface NgffDataset {
  path: string
  coordinateTransformations?: NgffCoordinateTransform[]
}

interface NgffMultiscale {
  version?: string
  axes?: NgffAxis[]
  datasets?: NgffDataset[]
  coordinateTransformations?: NgffCoordinateTransform[]
}

// `omero.channels` is the rendering-hints block; its only use here is the
// per-channel human label, which is what makes the split entries findable.
interface NgffOmero {
  channels?: Array<{ label?: string }>
}

interface NgffAttrs {
  // OME-Zarr <= 0.4 places `multiscales` at the top of the group attrs.
  multiscales?: NgffMultiscale[]
  omero?: NgffOmero
  // OME-Zarr 0.5+ (Zarr v3) nests all OME metadata under an `ome` key.
  ome?: {
    version?: string
    multiscales?: NgffMultiscale[]
    omero?: NgffOmero
  }
}

// Resolved view of one level's metadata, with shape and spacing already
// pruned to the spatial 3D triple in (X, Y, Z) order. `index` is the
// dense registry-facing index (0 = best available); `sourceIndex` and
// `path` describe where in the OME-Zarr pyramid this actually came
// from (e.g. sourceIndex=5, path="s5" if only s5 was fetched).
interface ResolvedLevel {
  index: number
  sourceIndex: number
  path: string
  shape: Shape3
  spacing: Vec3
}

// zarrita scalar dtypes we can map to NIfTI / VolumeHandle. Excludes
// 'bool', 'int64', 'uint64', and string types — NIfTI has no direct
// representation for those and we'd have to lossy-cast.
const SUPPORTED_DTYPES = new Set<string>([
  'uint8',
  'int8',
  'uint16',
  'int16',
  'uint32',
  'int32',
  'float32',
  'float64',
])

const DTYPE_BYTES: Record<string, number> = {
  uint8: 1,
  int8: 1,
  uint16: 2,
  int16: 2,
  uint32: 4,
  int32: 4,
  float32: 4,
  float64: 8,
}

// Largest level loadLevel will materialise whole; bigger levels must be read via
// loadSubvolume (s0 of a multi-GB EM/CT store must not be loaded into RAM in one
// request). Mirrors the DICOM-WSI adapter's MAX_WHOLE_LEVEL_BYTES.
const MAX_WHOLE_LEVEL_BYTES = 768 * 1024 * 1024

export const omezarrAdapter: VolumeAdapter = {
  format: 'ome-zarr',

  canHandle(p: string, { isDirectory }: AdapterContext): boolean {
    if (!isDirectory) return false
    return /\.(ome\.)?zarr$/i.test(p)
  },

  async probe(dirPath: string): Promise<ProbeMeta> {
    const levels = await resolveLevels(dirPath)
    const top = levels[0]
    if (!top) throw new Error(`No pyramid levels found in ${dirPath}`)
    const dtype = await readDtype(dirPath, top.path)
    return {
      shape: top.shape,
      dtype,
      spacing: top.spacing,
      affine: null,
    }
  },

  async probeLevels(dirPath: string): Promise<AdapterLevel[]> {
    const levels = await resolveLevels(dirPath)
    return levels.map((l) => ({
      level: l.index,
      shape: l.shape,
      spacing: l.spacing,
      affine: null,
    }))
  },

  // A store with no `c` axis — or one of length 1, where there is nothing
  // to pick — reports no channels, so the registry keeps making exactly one
  // entry for it under its plain name.
  async probeChannels(dirPath: string): Promise<AdapterChannel[]> {
    const info = await resolveChannelInfo(dirPath)
    if (!info || info.names.length < 2) return []
    return info.names.map((name, index) => ({ index, name }))
  },

  async load(
    dirPath: string,
    channel?: ChannelSelector,
  ): Promise<VolumeHandle> {
    return loadLevelInternal(dirPath, 0, channel)
  },

  async loadLevel(
    dirPath: string,
    levelIdx: number,
    channel?: ChannelSelector,
  ): Promise<VolumeHandle> {
    return loadLevelInternal(dirPath, levelIdx, channel)
  },

  async loadSubvolume(
    dirPath: string,
    levelIdx: number,
    bbox: SubvolumeBbox,
    channel?: ChannelSelector,
  ): Promise<VolumeHandle> {
    return loadSubvolumeInternal(dirPath, levelIdx, bbox, channel)
  },
}

async function loadLevelInternal(
  dirPath: string,
  levelIdx: number,
  channel?: ChannelSelector,
): Promise<VolumeHandle> {
  const { target, arr, channelAxis } = await openLevelArray(dirPath, levelIdx)
  const elemBytes = DTYPE_BYTES[arr.dtype] ?? 1
  const bytes = target.shape.reduce((a, b) => a * b, 1) * elemBytes
  if (bytes > MAX_WHOLE_LEVEL_BYTES) {
    throw new Error(
      `Level ${levelIdx} (${target.shape.join('x')}, ${Math.round(
        bytes / 1024 / 1024,
      )} MB) exceeds the whole-level cap; read it via subvolume.`,
    )
  }
  const selection: Array<number | null> = leadingSelection(
    arr.shape,
    channelAxis,
    channel,
  )
  selection.push(null, null, null)
  const view = await zarr.get(arr, selection)
  return new VolumeHandle({
    shape: target.shape,
    spacing: target.spacing,
    dtype: arr.dtype as Dtype,
    data: view.data as VoxelArray,
    metadata: {
      omezarr: {
        level: target.index,
        levelPath: target.path,
        channel: channelAxis >= 0 ? (channel ?? 0) : undefined,
      },
    },
  })
}

async function loadSubvolumeInternal(
  dirPath: string,
  levelIdx: number,
  bbox: SubvolumeBbox,
  channel?: ChannelSelector,
): Promise<VolumeHandle> {
  const { target, arr, channelAxis } = await openLevelArray(dirPath, levelIdx)
  // VolumeHandle uses (X, Y, Z); zarr storage is (..., Z, Y, X). Map the
  // bbox into per-axis slices so zarrita only fetches/decodes the chunks
  // that intersect the requested slab.
  const selection: Array<number | zarr.Slice> = leadingSelection(
    arr.shape,
    channelAxis,
    channel,
  )
  selection.push(zarr.slice(bbox.z0, bbox.z1))
  selection.push(zarr.slice(bbox.y0, bbox.y1))
  selection.push(zarr.slice(bbox.x0, bbox.x1))
  const view = await zarr.get(arr, selection)
  const sx = bbox.x1 - bbox.x0
  const sy = bbox.y1 - bbox.y0
  const sz = bbox.z1 - bbox.z0
  return new VolumeHandle({
    shape: [sx, sy, sz],
    spacing: target.spacing,
    dtype: arr.dtype as Dtype,
    data: view.data as VoxelArray,
    metadata: {
      omezarr: {
        level: target.index,
        levelPath: target.path,
        channel: channelAxis >= 0 ? (channel ?? 0) : undefined,
        subvolume: { x0: bbox.x0, y0: bbox.y0, z0: bbox.z0 },
      },
    },
  })
}

async function openLevelArray(dirPath: string, levelIdx: number) {
  const levels = await resolveLevels(dirPath)
  const target = levels.find((l) => l.index === levelIdx)
  if (!target) {
    throw new Error(
      `Level ${levelIdx} not found in ${dirPath} (available: ${levels
        .map((l) => l.index)
        .join(', ')})`,
    )
  }
  const store = new FileSystemStore(dirPath)
  const arr = await zarr.open(zarr.root(store).resolve(`/${target.path}`), {
    kind: 'array',
  })
  if (!SUPPORTED_DTYPES.has(arr.dtype)) {
    throw new Error(
      `OME-Zarr dtype '${arr.dtype}' is not supported by this server`,
    )
  }
  const info = await resolveChannelInfo(dirPath)
  const channelAxis =
    info && info.axisIndex < arr.shape.length - 3 ? info.axisIndex : -1
  return { target, arr, channelAxis }
}

// Index each leading (non-spatial) axis down to a single element so the read
// yields a 3D volume: the channel axis gets the requested channel, every
// other leading axis (t, and any extra) gets 0. NGFF requires the spatial
// axes to be the trailing dims, so everything before them is safe to pin.
function leadingSelection(
  shape: readonly number[],
  channelAxis: number,
  channel: ChannelSelector,
): number[] {
  const selection: number[] = []
  for (let i = 0; i < shape.length - 3; i++) {
    if (i !== channelAxis) {
      selection.push(0)
      continue
    }
    const index = channel ?? 0
    const length = shape[i] ?? 0
    if (!Number.isInteger(index) || index < 0 || index >= length) {
      throw new Error(
        `Channel ${index} is out of range (store has ${length} channel(s))`,
      )
    }
    selection.push(index)
  }
  return selection
}

interface ChannelInfo {
  // Position of the channel axis in the FULL axis list, not among the
  // leading axes — callers compare it against `ndim - 3` themselves.
  axisIndex: number
  names: string[]
}

// Read the `c` axis and its labels from the group metadata. This reopens the
// group on every load; that is one small JSON read next to a chunk fetch of
// megabytes, so it is not worth threading through resolveLevels.
async function resolveChannelInfo(
  dirPath: string,
): Promise<ChannelInfo | null> {
  const store = new FileSystemStore(dirPath)
  const grp = await zarr.open(zarr.root(store), { kind: 'group' })
  const attrs = grp.attrs as NgffAttrs
  const ms = attrs.multiscales?.[0] ?? attrs.ome?.multiscales?.[0]
  const axes = ms?.axes
  if (!axes || axes.length === 0) return null
  const axisIndex = axes.findIndex(
    (a) => a.type === 'channel' || a.name?.toLowerCase() === 'c',
  )
  if (axisIndex < 0) return null
  // The channel axis must be a leading (non-spatial) one. NGFF puts the
  // spatial axes last, so a `c` inside the trailing three dims (e.g. a 2D
  // c,y,x store) is read as a spatial dim and cannot be selected per
  // channel — reporting channels for it would mint N identical entries.
  if (axisIndex >= axes.length - 3) return null

  // The axis length lives on the array, not the metadata. Use the first
  // dataset that opens — a partial fixture fetch may be missing the rest.
  let length = 0
  for (const ds of ms?.datasets ?? []) {
    if (!ds?.path) continue
    try {
      const arr = await zarr.open(zarr.root(store).resolve(`/${ds.path}`), {
        kind: 'array',
      })
      // A mismatch between the declared axes and the real array means we
      // cannot trust axisIndex to point at the channel axis.
      if (arr.shape.length !== axes.length) return null
      length = arr.shape[axisIndex] ?? 0
      break
    } catch (err) {
      if (err instanceof zarr.NotFoundError) continue
      throw err
    }
  }
  if (length < 1) return null

  const labels = (attrs.omero ?? attrs.ome?.omero)?.channels ?? []
  const names = Array.from({ length }, (_unused, i) => {
    const label = labels[i]?.label
    return typeof label === 'string' && label.length > 0 ? label : `c${i}`
  })
  return { axisIndex, names }
}

async function resolveLevels(dirPath: string): Promise<ResolvedLevel[]> {
  const store = new FileSystemStore(dirPath)
  const grp = await zarr.open(zarr.root(store), { kind: 'group' })
  const attrs = grp.attrs as NgffAttrs
  // OME-Zarr 0.5 moved `multiscales` under an `ome` namespace key; older
  // stores keep it at the top level. Accept either.
  const ms = attrs.multiscales?.[0] ?? attrs.ome?.multiscales?.[0]
  if (!ms?.datasets?.length) {
    throw new Error(`No multiscales metadata in ${dirPath}`)
  }
  // Per-axis unit → mm conversion. NGFF lets each axis carry its own
  // unit string ("nanometer", "micrometer", …). We multiply spacing by
  // these so downstream NIfTI consumers (niivue) get mm-per-voxel.
  const axisToMm = (ms.axes ?? []).map((a) => unitToMm(a.unit))
  const topLevelScale = scaleFromTransforms(ms.coordinateTransformations)

  const available: ResolvedLevel[] = []
  for (let i = 0; i < ms.datasets.length; i++) {
    const ds = ms.datasets[i]
    if (!ds?.path) continue
    // NGFF allows scale at both the multiscale level and per-dataset;
    // they multiply elementwise (per spec).
    const datasetScale = scaleFromTransforms(ds.coordinateTransformations)
    const combinedScale = combineScales(topLevelScale, datasetScale)
    // Open this level's array to read its real shape. Partial fixture
    // fetches (e.g. only s5 downloaded) will 404 here on the other
    // levels — skip them so the registry only sees what's loadable.
    let arrShape: number[]
    try {
      const arr = await zarr.open(zarr.root(store).resolve(`/${ds.path}`), {
        kind: 'array',
      })
      arrShape = arr.shape
    } catch (err) {
      if (err instanceof zarr.NotFoundError) continue
      throw err
    }
    const spatial3 = lastThree(arrShape)
    const spacing3 = applyUnits(
      lastThree(padScale(combinedScale, arrShape.length)),
      axisToMm.slice(-3),
    )
    available.push({
      index: 0, // reassigned below once we know how many survived
      sourceIndex: i,
      path: ds.path,
      // VolumeHandle wants (X, Y, Z); Zarr storage is (Z, Y, X).
      shape: [spatial3[2], spatial3[1], spatial3[0]] as Shape3,
      spacing: [spacing3[2], spacing3[1], spacing3[0]] as Vec3,
    })
  }
  if (available.length === 0) {
    throw new Error(
      `No fetchable datasets in ${dirPath} (multiscales declares ${ms.datasets.length} but none have chunk data)`,
    )
  }
  return available.map((lvl, denseIdx) => ({ ...lvl, index: denseIdx }))
}

async function readDtype(dirPath: string, levelPath: string): Promise<Dtype> {
  const store = new FileSystemStore(dirPath)
  const arr = await zarr.open(zarr.root(store).resolve(`/${levelPath}`), {
    kind: 'array',
  })
  if (!SUPPORTED_DTYPES.has(arr.dtype)) {
    throw new Error(`OME-Zarr dtype '${arr.dtype}' is not supported`)
  }
  return arr.dtype as Dtype
}

function scaleFromTransforms(
  transforms: NgffCoordinateTransform[] | undefined,
): number[] {
  if (!transforms) return []
  for (const t of transforms) {
    if (t.type === 'scale' && Array.isArray(t.scale)) return t.scale
  }
  return []
}

function combineScales(a: number[], b: number[]): number[] {
  if (a.length === 0) return b
  if (b.length === 0) return a
  const n = Math.max(a.length, b.length)
  const out = new Array<number>(n)
  for (let i = 0; i < n; i++) out[i] = (a[i] ?? 1) * (b[i] ?? 1)
  return out
}

function padScale(scale: number[], ndim: number): number[] {
  if (scale.length >= ndim) return scale
  const out = new Array<number>(ndim).fill(1)
  // Right-align: the trailing axes of scale correspond to the trailing
  // axes of the array (i.e. the spatial ones).
  const offset = ndim - scale.length
  for (let i = 0; i < scale.length; i++) out[offset + i] = scale[i] ?? 1
  return out
}

function lastThree(arr: number[]): [number, number, number] {
  const n = arr.length
  return [arr[n - 3] ?? 1, arr[n - 2] ?? 1, arr[n - 1] ?? 1]
}

function applyUnits(
  values: [number, number, number],
  units: number[],
): [number, number, number] {
  const u = padScale(units.length ? units : [], 3)
  return [
    values[0] * (u[0] ?? 1),
    values[1] * (u[1] ?? 1),
    values[2] * (u[2] ?? 1),
  ]
}

// NGFF unit names follow UCUM. We only handle the SI-prefixed lengths
// that show up in practice; anything else is treated as 1 (passthrough).
function unitToMm(unit: string | undefined): number {
  if (!unit) return 1
  switch (unit.toLowerCase()) {
    case 'angstrom':
      return 1e-7
    case 'nanometer':
      return 1e-6
    case 'micrometer':
    case 'micron':
      return 1e-3
    case 'millimeter':
      return 1
    case 'centimeter':
      return 10
    case 'meter':
      return 1000
    default:
      return 1
  }
}
