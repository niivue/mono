// Common VolumeHandle interface produced by every adapter. Routes only
// interact with this, so adding a new format means writing a new adapter
// that returns one of these.
//
// Layout convention: the typed-array `data` is in Fortran order
// (x fastest). shape = [sx, sy, sz]. spacing is in millimetres
// (or the file's native units), as [dx, dy, dz]. orientation is a 3x3
// matrix (row-major) mapping voxel axes to world axes; identity if
// unknown.

export type ScalarDtype =
  | 'uint8'
  | 'int8'
  | 'uint16'
  | 'int16'
  | 'uint32'
  | 'int32'
  | 'float32'
  | 'float64'
export type ColorDtype = 'rgb24' | 'rgba32'
export type Dtype = ScalarDtype | ColorDtype

export type TypedScalarArray =
  | Uint8Array
  | Int8Array
  | Uint16Array
  | Int16Array
  | Uint32Array
  | Int32Array
  | Float32Array
  | Float64Array

export type VoxelArray = TypedScalarArray

export type Shape3 = readonly [number, number, number]
export type Vec3 = readonly [number, number, number]
export type Affine4x4 = readonly [
  readonly [number, number, number, number],
  readonly [number, number, number, number],
  readonly [number, number, number, number],
  readonly [number, number, number, number],
]
export type Mat3x3 = readonly [Vec3, Vec3, Vec3]

export type Axis = 'axial' | 'coronal' | 'sagittal'

export type VolumeMetadata = Record<string, unknown>

export interface VolumeHandleInit {
  shape: Shape3
  spacing?: Vec3
  dtype: Dtype
  data: VoxelArray
  orientation?: Mat3x3
  affine?: Affine4x4 | null
  units?: string
  metadata?: VolumeMetadata
  sclSlope?: number
  sclInter?: number
}

export interface SliceImage {
  width: number
  height: number
  data: Uint8Array
}

const IDENTITY3: Mat3x3 = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
]

function clampByte(v: number): number {
  if (v <= 0) return 0
  if (v >= 255) return 255
  return v | 0
}

class HttpRangeError extends Error {
  status = 416
}

function rangeErr(axis: Axis, index: number, n: number): HttpRangeError {
  return new HttpRangeError(
    `Slice index ${index} out of range for axis ${axis} (0..${n - 1})`,
  )
}

export class VolumeHandle {
  shape: Shape3
  spacing: Vec3
  dtype: Dtype
  data: VoxelArray
  orientation: Mat3x3
  affine: Affine4x4 | null
  units: string
  metadata: VolumeMetadata
  sclSlope: number
  sclInter: number
  private _minMax: { min: number; max: number } | null = null

  constructor(init: VolumeHandleInit) {
    if (!Array.isArray(init.shape) || init.shape.length !== 3) {
      throw new Error('VolumeHandle requires a 3-element shape')
    }
    this.shape = init.shape
    this.spacing = init.spacing ?? [1, 1, 1]
    this.dtype = init.dtype
    this.data = init.data
    this.orientation = init.orientation ?? IDENTITY3
    this.affine = init.affine ?? null
    this.units = init.units ?? 'mm'
    this.metadata = init.metadata ?? {}
    this.sclSlope = init.sclSlope ?? 0
    this.sclInter = init.sclInter ?? 0

    if (this.affine) {
      const a = this.affine
      this.spacing = [
        Math.sqrt(a[0][0] ** 2 + a[1][0] ** 2 + a[2][0] ** 2),
        Math.sqrt(a[0][1] ** 2 + a[1][1] ** 2 + a[2][1] ** 2),
        Math.sqrt(a[0][2] ** 2 + a[1][2] ** 2 + a[2][2] ** 2),
      ]
    }
  }

  get bytesPerColorVoxel(): number {
    if (this.dtype === 'rgb24') return 3
    if (this.dtype === 'rgba32') return 4
    return 0
  }

  intensityRange(): { min: number; max: number } {
    if (this._minMax) return this._minMax
    if (this.bytesPerColorVoxel > 0) {
      this._minMax = { min: 0, max: 255 }
      return this._minMax
    }
    let min = Number.POSITIVE_INFINITY
    let max = Number.NEGATIVE_INFINITY
    const d = this.data
    const step = Math.max(1, Math.floor(d.length / 1_000_000))
    for (let i = 0; i < d.length; i += step) {
      const v = d[i] as number
      if (v < min) min = v
      if (v > max) max = v
    }
    if (!Number.isFinite(min) || !Number.isFinite(max) || min === max) {
      min = 0
      max = 1
    }
    this._minMax = { min, max }
    return this._minMax
  }

  getSlice(axis: Axis, index: number): SliceImage {
    const [sx, sy, sz] = this.shape

    let width: number
    let height: number
    let pickIjk: (u: number, v: number) => [number, number, number]

    if (axis === 'axial') {
      if (index < 0 || index >= sz) throw rangeErr(axis, index, sz)
      width = sx
      height = sy
      pickIjk = (u, v) => [u, v, index]
    } else if (axis === 'coronal') {
      if (index < 0 || index >= sy) throw rangeErr(axis, index, sy)
      width = sx
      height = sz
      pickIjk = (u, v) => [u, index, sz - 1 - v]
    } else if (axis === 'sagittal') {
      if (index < 0 || index >= sx) throw rangeErr(axis, index, sx)
      width = sy
      height = sz
      pickIjk = (u, v) => [index, u, sz - 1 - v]
    } else {
      throw new Error(`Unknown axis: ${axis as string}`)
    }

    const rgba = new Uint8Array(width * height * 4)
    const bpcv = this.bytesPerColorVoxel

    if (bpcv === 0) {
      const { min, max } = this.intensityRange()
      const scale = max > min ? 255 / (max - min) : 1
      for (let v = 0; v < height; v++) {
        for (let u = 0; u < width; u++) {
          const [x, y, z] = pickIjk(u, v)
          const value = this.voxelScalar(x, y, z)
          const g = clampByte((value - min) * scale)
          const o = (v * width + u) * 4
          rgba[o] = g
          rgba[o + 1] = g
          rgba[o + 2] = g
          rgba[o + 3] = 255
        }
      }
    } else {
      for (let v = 0; v < height; v++) {
        for (let u = 0; u < width; u++) {
          const [x, y, z] = pickIjk(u, v)
          const off = this.colorVoxelOffset(x, y, z, bpcv)
          const o = (v * width + u) * 4
          rgba[o] = this.data[off] as number
          rgba[o + 1] = this.data[off + 1] as number
          rgba[o + 2] = this.data[off + 2] as number
          rgba[o + 3] = bpcv === 4 ? (this.data[off + 3] as number) : 255
        }
      }
    }
    return { width, height, data: rgba }
  }

  voxelScalar(x: number, y: number, z: number): number {
    const [sx, sy] = this.shape
    return this.data[x + y * sx + z * sx * sy] as number
  }

  colorVoxelOffset(x: number, y: number, z: number, bpcv: number): number {
    const [sx, sy] = this.shape
    return (x + y * sx + z * sx * sy) * bpcv
  }

  sliceCount(axis: Axis): number {
    if (axis === 'axial') return this.shape[2]
    if (axis === 'coronal') return this.shape[1]
    if (axis === 'sagittal') return this.shape[0]
    throw new Error(`Unknown axis: ${axis as string}`)
  }

  sliceDims(axis: Axis): [number, number] {
    if (axis === 'axial') return [this.shape[0], this.shape[1]]
    if (axis === 'coronal') return [this.shape[0], this.shape[2]]
    if (axis === 'sagittal') return [this.shape[1], this.shape[2]]
    throw new Error(`Unknown axis: ${axis as string}`)
  }

  physicalSliceDims(axis: Axis): [number, number] {
    const [sx, sy, sz] = this.shape
    const [dx, dy, dz] = this.spacing
    if (axis === 'axial') return [sx * dx, sy * dy]
    if (axis === 'coronal') return [sx * dx, sz * dz]
    if (axis === 'sagittal') return [sy * dy, sz * dz]
    throw new Error(`Unknown axis: ${axis as string}`)
  }
}
