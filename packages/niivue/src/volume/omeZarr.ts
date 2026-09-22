/**
 * Parse OME-Zarr (OME-NGFF) group metadata.
 *
 * An OME-Zarr image is a Zarr GROUP whose attributes describe a multiscale
 * pyramid (named axes plus one dataset per resolution level) and, when the
 * writer cares about display, an `omero` block naming each channel's label,
 * colour and intensity window. This module turns that already-fetched JSON
 * into typed structures and answers the axis questions every consumer has
 * (which dimension is channel? which spatial axis is display x?). It never
 * touches the network, so the Bun unit tests exercise it directly; store
 * access and chunk decoding live in `omeZarrLoader.ts`.
 * See `docs/ome-zarr-format.md`.
 */

import type { TypedVoxelArray } from '@/NVTypes'
import { omeLengthToMicrons } from './omeTiff'

/**
 * A zero-filled typed array of `source`'s concrete type. Shared by the
 * whole-level loader's block transpose and the chunk source's brick repack,
 * which both rebuild a read block without knowing its dtype statically.
 */
export function allocTypedArrayLike<T extends TypedVoxelArray>(
  source: T,
  length: number,
): T {
  const ctor = source.constructor as new (length: number) => T
  return new ctor(length)
}

/** One entry of a multiscale's `axes` list. */
export interface OmeZarrAxis {
  /** Axis name: conventionally `t`, `c`, `z`, `y`, `x`. */
  name: string
  /** `time`, `channel` or `space`; inferred from the name when not stated. */
  type: string
  /** Unit string as written (`micrometer`, `nanometer`, ...), or null. */
  unit: string | null
}

/** One resolution level of the pyramid, finest first. */
export interface OmeZarrDataset {
  /** Store-relative path of the level's Zarr array. */
  path: string
  /** Per-axis scale factors, or null when the dataset states none. */
  scale: number[] | null
  /** Per-axis translation, or null when the dataset states none. */
  translation: number[] | null
}

/** An omero channel's intensity window. */
export interface OmeZarrWindow {
  /** Display window lower bound (maps to the colormap's dark end). */
  start: number
  /** Display window upper bound. */
  end: number
  /** Stated data minimum, or null. */
  min: number | null
  /** Stated data maximum, or null. */
  max: number | null
}

/** Display metadata for one channel, from the `omero.channels` list. */
export interface OmeZarrChannel {
  label: string | null
  /** Channel colour as 0-255 RGB, or null when absent or malformed. */
  color: readonly [number, number, number] | null
  window: OmeZarrWindow | null
  /** False only when the file explicitly deactivates the channel. */
  active: boolean
}

/** Everything this package reads from an OME-Zarr group's attributes. */
export interface OmeZarrInfo {
  /** The `multiscales` (or 0.5 `ome`) version string, or null. */
  version: string | null
  /** The multiscale's stated name, or null. */
  name: string | null
  /** Declared axes, or null: 0.1-0.3 stores may omit them. */
  axes: OmeZarrAxis[] | null
  /** Resolution levels, finest first (the order the file lists them). */
  datasets: OmeZarrDataset[]
  /** Channel display metadata; empty when the group has no `omero` block. */
  channels: OmeZarrChannel[]
}

type JsonObject = Record<string, unknown>

function asObject(value: unknown): JsonObject | null {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as JsonObject
  }
  return null
}

function asNumberArray(value: unknown): number[] | null {
  if (!Array.isArray(value)) {
    return null
  }
  const nums = value.filter((v): v is number => typeof v === 'number')
  return nums.length === value.length ? nums : null
}

/** Axis type from a conventional single-letter name, else empty. */
function inferAxisType(name: string): string {
  const n = name.toLowerCase()
  if (n === 't') {
    return 'time'
  }
  if (n === 'c') {
    return 'channel'
  }
  if (n === 'x' || n === 'y' || n === 'z') {
    return 'space'
  }
  return ''
}

/** 0.3 wrote axes as bare name strings; 0.4+ as objects. Both are accepted. */
function parseAxis(entry: unknown): OmeZarrAxis | null {
  if (typeof entry === 'string') {
    return { name: entry, type: inferAxisType(entry), unit: null }
  }
  const obj = asObject(entry)
  if (!obj || typeof obj.name !== 'string') {
    return null
  }
  const type = typeof obj.type === 'string' ? obj.type : inferAxisType(obj.name)
  return {
    name: obj.name,
    type,
    unit: typeof obj.unit === 'string' ? obj.unit : null,
  }
}

function parseDataset(entry: unknown): OmeZarrDataset | null {
  const obj = asObject(entry)
  if (!obj || typeof obj.path !== 'string') {
    return null
  }
  let scale: number[] | null = null
  let translation: number[] | null = null
  if (Array.isArray(obj.coordinateTransformations)) {
    for (const raw of obj.coordinateTransformations) {
      const transform = asObject(raw)
      if (transform?.type === 'scale') {
        scale = scale ?? asNumberArray(transform.scale)
      } else if (transform?.type === 'translation') {
        translation = translation ?? asNumberArray(transform.translation)
      }
    }
  }
  return { path: obj.path, scale, translation }
}

/**
 * An omero colour is hex RGB, `"FF0000"`, though writers also produce a
 * leading `#` and an appended alpha byte, both tolerated (alpha is dropped).
 */
export function parseOmeroColor(
  value: unknown,
): readonly [number, number, number] | null {
  if (typeof value !== 'string') {
    return null
  }
  const hex = value.trim().replace(/^#/, '')
  if (!/^[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(hex)) {
    return null
  }
  return [
    Number.parseInt(hex.slice(0, 2), 16),
    Number.parseInt(hex.slice(2, 4), 16),
    Number.parseInt(hex.slice(4, 6), 16),
  ]
}

function parseChannel(entry: unknown): OmeZarrChannel {
  const obj = asObject(entry) ?? {}
  const windowObj = asObject(obj.window)
  let window: OmeZarrWindow | null = null
  if (
    windowObj &&
    typeof windowObj.start === 'number' &&
    typeof windowObj.end === 'number'
  ) {
    window = {
      start: windowObj.start,
      end: windowObj.end,
      min: typeof windowObj.min === 'number' ? windowObj.min : null,
      max: typeof windowObj.max === 'number' ? windowObj.max : null,
    }
  }
  return {
    label: typeof obj.label === 'string' ? obj.label : null,
    color: parseOmeroColor(obj.color),
    window,
    active: obj.active !== false,
  }
}

/**
 * Parse an OME-Zarr group's attributes.
 *
 * Accepts every layout the format has shipped: a v2 `.zattrs` object with
 * `multiscales`/`omero` at its top level (0.1-0.4), or a v3 attributes object
 * with the same keys wrapped in `ome` (0.5). Throws when there is no
 * multiscale image to read.
 */
export function parseOmeZarrAttrs(attrs: unknown): OmeZarrInfo {
  const rootAttrs = asObject(attrs)
  const ome = asObject(rootAttrs?.ome) ?? rootAttrs
  const multiscales = Array.isArray(ome?.multiscales) ? ome.multiscales : null
  const multiscale = asObject(multiscales?.[0])
  if (!multiscale) {
    throw new Error('OME-Zarr: group metadata has no multiscales')
  }

  let axes: OmeZarrAxis[] | null = null
  if (Array.isArray(multiscale.axes)) {
    const parsed = multiscale.axes.map(parseAxis)
    if (parsed.every((axis): axis is OmeZarrAxis => axis !== null)) {
      axes = parsed
    }
  }

  const datasets = Array.isArray(multiscale.datasets)
    ? multiscale.datasets
        .map(parseDataset)
        .filter((ds): ds is OmeZarrDataset => ds !== null)
    : []
  if (datasets.length === 0) {
    throw new Error('OME-Zarr: multiscale lists no datasets')
  }

  const omero = asObject(ome?.omero) ?? asObject(rootAttrs?.omero)
  const channels = Array.isArray(omero?.channels)
    ? omero.channels.map(parseChannel)
    : []

  return {
    version:
      typeof multiscale.version === 'string'
        ? multiscale.version
        : typeof ome?.version === 'string'
          ? ome.version
          : null,
    name: typeof multiscale.name === 'string' ? multiscale.name : null,
    axes,
    datasets,
    channels,
  }
}

/** The 0.1-0.3 fixed dimension order, which files without axes rely on. */
const DEFAULT_AXES: readonly OmeZarrAxis[] = [
  { name: 't', type: 'time', unit: null },
  { name: 'c', type: 'channel', unit: null },
  { name: 'z', type: 'space', unit: null },
  { name: 'y', type: 'space', unit: null },
  { name: 'x', type: 'space', unit: null },
]

/**
 * The concrete axes of an array with `rank` dimensions: the declared ones
 * when present (their count must match), else the trailing slice of the
 * pre-0.4 fixed order `t c z y x`.
 */
export function omeZarrResolveAxes(
  info: OmeZarrInfo,
  rank: number,
): OmeZarrAxis[] {
  if (info.axes) {
    if (info.axes.length !== rank) {
      throw new Error(
        `OME-Zarr: ${info.axes.length} axes declared for a ${rank}-dimensional array`,
      )
    }
    return info.axes
  }
  if (rank < 2 || rank > 5) {
    throw new Error(
      `OME-Zarr: cannot infer axes for a ${rank}-dimensional array`,
    )
  }
  return DEFAULT_AXES.slice(5 - rank)
}

/** Where time, channel and space live in an axis list. */
export interface OmeZarrAxisIndices {
  /** Dimension index of the time axis, or -1. */
  time: number
  /** Dimension index of the (first) channel axis, or -1. */
  channel: number
  /** Dimension indices of the spatial axes, in declared order. */
  spatial: number[]
}

/**
 * Classify each axis. Two or three spatial axes are required: this package
 * loads volumes, and a 2D image is a volume with one slice.
 */
export function omeZarrAxisIndices(axes: OmeZarrAxis[]): OmeZarrAxisIndices {
  let time = -1
  let channel = -1
  const spatial: number[] = []
  for (const [index, axis] of axes.entries()) {
    if (axis.type === 'time' && time < 0) {
      time = index
    } else if (axis.type === 'channel' && channel < 0) {
      channel = index
    } else if (axis.type === 'space') {
      spatial.push(index)
    }
  }
  if (spatial.length < 2 || spatial.length > 3) {
    throw new Error(
      `OME-Zarr: expected 2 or 3 spatial axes, found ${spatial.length}`,
    )
  }
  return { time, channel, spatial }
}

/** Positions WITHIN the spatial list that map to display x, y and z. */
export interface OmeZarrSpatialOrder {
  x: number
  y: number
  /** -1 for a 2D image (no z axis; the volume gets a single slice). */
  z: number
}

/**
 * Map the spatial axes to display x/y/z.
 *
 * When the axes carry the conventional names they are matched by name, so an
 * `x y z`-ordered file (e.g. the Human Organ Atlas) presents the same way as
 * the usual `z y x`. Unconventional names fall back to position: the
 * fastest-varying (last) axis is display x, the slowest display z.
 */
export function omeZarrSpatialOrder(
  axes: OmeZarrAxis[],
  spatial: number[],
): OmeZarrSpatialOrder {
  const names = spatial.map((idx) => axes[idx].name.toLowerCase())
  const x = names.indexOf('x')
  const y = names.indexOf('y')
  if (x >= 0 && y >= 0) {
    const z = names.indexOf('z')
    if (spatial.length === 2 || z >= 0) {
      return { x, y, z: spatial.length === 2 ? -1 : z }
    }
  }
  if (spatial.length === 2) {
    return { x: 1, y: 0, z: -1 }
  }
  return { x: 2, y: 1, z: 0 }
}

/**
 * A dataset's voxel spacing in display order, in MICROMETRES, the working
 * unit for every microscopy volume in this package (see `omeLengthToMicrons`).
 * An axis with no stated scale or an unrecognised unit gets 1.
 */
export function omeZarrSpatialScaleUm(
  dataset: OmeZarrDataset,
  axes: OmeZarrAxis[],
): [number, number, number] {
  const { spatial } = omeZarrAxisIndices(axes)
  const order = omeZarrSpatialOrder(axes, spatial)
  const at = (position: number): number => {
    if (position < 0) {
      return 1
    }
    const axisIndex = spatial[position]
    const value = dataset.scale?.[axisIndex]
    if (typeof value !== 'number') {
      return 1
    }
    const um = omeLengthToMicrons(value, axes[axisIndex].unit ?? undefined)
    return um > 0 ? um : 1
  }
  return [at(order.x), at(order.y), at(order.z)]
}
