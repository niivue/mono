// NIfTI-1 / NIfTI-2 adapter. Uses nifti-reader-js, which understands both
// the .nii and .nii.gz forms.

import fs from 'node:fs/promises'
import nifti from 'nifti-reader-js'
import type {
  Affine4x4,
  Dtype,
  Shape3,
  Vec3,
  VoxelArray,
} from './volumeHandle.ts'
import { VolumeHandle } from './volumeHandle.ts'

export interface ProbeMeta {
  shape: Shape3
  dtype: Dtype
  spacing: Vec3
  affine: Affine4x4 | null
}

// One pyramid level surfaced by an adapter that has a native multiscale
// representation (OME-Zarr, DICOM-WSI, OME-TIFF). Level 0 is the
// highest-resolution; higher indices are coarser, following OME-Zarr
// convention. `spacing` reflects the per-level physical voxel size.
export interface AdapterLevel {
  level: number
  shape: Shape3
  spacing: Vec3
  affine?: Affine4x4 | null
}

export interface AdapterContext {
  isDirectory: boolean
}

// Half-open bbox in (X, Y, Z) voxel coords matching VolumeHandle. End
// indices are exclusive. The adapter is responsible for clamping any
// out-of-range values; callers (the registry) clamp before dispatch so
// adapters can trust the inputs lie inside the level shape.
export interface SubvolumeBbox {
  x0: number
  y0: number
  z0: number
  x1: number
  y1: number
  z1: number
}

export interface VolumeAdapter {
  format: string
  canHandle(path: string, ctx: AdapterContext): boolean
  probe(filePath: string): Promise<ProbeMeta>
  load(filePath: string): Promise<VolumeHandle>
  // Adapters with a native multiscale pyramid (OME-Zarr datasets, future
  // DICOM-WSI tiers) implement these. When absent, the registry falls
  // back to generating a pyramid from level 0 (NIfTI path).
  probeLevels?(filePath: string): Promise<AdapterLevel[]>
  loadLevel?(filePath: string, levelIdx: number): Promise<VolumeHandle>
  // Chunk-aware partial read. Returns a VolumeHandle whose shape equals
  // (x1-x0, y1-y0, z1-z0) and whose data covers only that slab — useful
  // for native-pyramid sources where loading the full level into RAM is
  // wasteful (s3+ of jrc_hela-2 is hundreds of MB to GBs).
  loadSubvolume?(
    filePath: string,
    levelIdx: number,
    bbox: SubvolumeBbox,
  ): Promise<VolumeHandle>
}

interface NiftiHeader {
  dims: number[]
  pixDims: number[]
  datatypeCode: number
  affine: Affine4x4
  description?: string
  intent_name?: string
  sform_code?: number
  qform_code?: number
  scl_slope?: number
  scl_inter?: number
  xyzt_units?: number
}

export const niftiAdapter: VolumeAdapter = {
  format: 'nifti',

  canHandle(p: string, { isDirectory }: AdapterContext): boolean {
    if (isDirectory) return false
    return /\.nii(\.gz)?$/i.test(p)
  },

  async probe(filePath: string): Promise<ProbeMeta> {
    const buf = await fs.readFile(filePath)
    const ab = toArrayBuffer(buf)
    const decompressed = (
      nifti.isCompressed(ab) ? nifti.decompress(ab) : ab
    ) as ArrayBuffer
    if (!nifti.isNIFTI(decompressed)) {
      throw new Error('Not a valid NIfTI file')
    }
    const header = nifti.readHeader(decompressed) as unknown as NiftiHeader
    return {
      shape: [header.dims[1] ?? 1, header.dims[2] ?? 1, header.dims[3] ?? 1],
      dtype: niftiDtypeName(header.datatypeCode),
      spacing: [
        header.pixDims[1] || 1,
        header.pixDims[2] || 1,
        header.pixDims[3] || 1,
      ],
      affine: header.affine,
    }
  },

  async load(filePath: string): Promise<VolumeHandle> {
    const buf = await fs.readFile(filePath)
    const ab = toArrayBuffer(buf)
    const decompressed = (
      nifti.isCompressed(ab) ? nifti.decompress(ab) : ab
    ) as ArrayBuffer
    const header = nifti.readHeader(decompressed) as unknown as NiftiHeader
    const rawImage = nifti.readImage(
      header as unknown as Parameters<typeof nifti.readImage>[0],
      decompressed,
    )
    const data = wrapTyped(rawImage, header.datatypeCode)
    const shape: Shape3 = [
      header.dims[1] ?? 1,
      header.dims[2] ?? 1,
      header.dims[3] ?? 1,
    ]
    const spacing: Vec3 = [
      header.pixDims[1] || 1,
      header.pixDims[2] || 1,
      header.pixDims[3] || 1,
    ]
    return new VolumeHandle({
      shape,
      spacing,
      affine: header.affine,
      dtype: niftiDtypeName(header.datatypeCode),
      data,
      units: niftiUnitsName(header.xyzt_units),
      sclSlope: header.scl_slope ?? 0,
      sclInter: header.scl_inter ?? 0,
      metadata: {
        descrip: header.description?.trim?.() || '',
        intent_name: header.intent_name?.trim?.() || '',
        sform_code: header.sform_code,
        qform_code: header.qform_code,
      },
    })
  },
}

function toArrayBuffer(buf: Buffer): ArrayBuffer {
  const ab = new ArrayBuffer(buf.byteLength)
  new Uint8Array(ab).set(buf)
  return ab
}

function wrapTyped(arrayBuffer: ArrayBuffer, datatypeCode: number): VoxelArray {
  switch (datatypeCode) {
    case nifti.NIFTI1.TYPE_UINT8:
      return new Uint8Array(arrayBuffer)
    case nifti.NIFTI1.TYPE_INT16:
      return new Int16Array(arrayBuffer)
    case nifti.NIFTI1.TYPE_UINT16:
      return new Uint16Array(arrayBuffer)
    case nifti.NIFTI1.TYPE_INT32:
      return new Int32Array(arrayBuffer)
    case nifti.NIFTI1.TYPE_UINT32:
      return new Uint32Array(arrayBuffer)
    case nifti.NIFTI1.TYPE_FLOAT32:
      return new Float32Array(arrayBuffer)
    case nifti.NIFTI1.TYPE_FLOAT64:
      return new Float64Array(arrayBuffer)
    case nifti.NIFTI1.TYPE_INT8:
      return new Int8Array(arrayBuffer)
    case 128:
      return new Uint8Array(arrayBuffer)
    case 2304:
      return new Uint8Array(arrayBuffer)
    default:
      throw new Error(`Unsupported NIfTI datatype code ${datatypeCode}`)
  }
}

function niftiDtypeName(code: number): Dtype {
  switch (code) {
    case nifti.NIFTI1.TYPE_UINT8:
      return 'uint8'
    case nifti.NIFTI1.TYPE_INT8:
      return 'int8'
    case nifti.NIFTI1.TYPE_INT16:
      return 'int16'
    case nifti.NIFTI1.TYPE_UINT16:
      return 'uint16'
    case nifti.NIFTI1.TYPE_INT32:
      return 'int32'
    case nifti.NIFTI1.TYPE_UINT32:
      return 'uint32'
    case nifti.NIFTI1.TYPE_FLOAT32:
      return 'float32'
    case nifti.NIFTI1.TYPE_FLOAT64:
      return 'float64'
    case 128:
      return 'rgb24'
    case 2304:
      return 'rgba32'
    default:
      throw new Error(`Unsupported NIfTI datatype code ${code}`)
  }
}

function niftiUnitsName(xyzt_units: number | undefined): string {
  const SPATIAL_MASK = 0x07
  const code = (xyzt_units || 0) & SPATIAL_MASK
  switch (code) {
    case 1:
      return 'm'
    case 2:
      return 'mm'
    case 3:
      return 'um'
    default:
      return 'mm'
  }
}
