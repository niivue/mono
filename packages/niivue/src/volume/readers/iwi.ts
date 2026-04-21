import { decode } from "cbor-x"
import * as nifti from "nifti-reader-js"
import type { NIFTI1, TypedVoxelArray } from "@/NVTypes"

// ITK-Wasm image format (.iwi.cbor)
// https://docs.itk.org/en/latest/learn/python_quick_start.html

interface IWImageType {
  dimension: number
  componentType: string
  pixelType: string
  components: number
}

interface IWImage {
  imageType: IWImageType
  size: bigint[] | number[]
  data:
    | Uint8Array
    | Int16Array
    | Uint16Array
    | Int32Array
    | Float32Array
    | Float64Array
  spacing?: number[]
  origin?: number[]
  direction?: number[]
  metadata?: unknown[]
}

export const extensions = ["IWI.CBOR"]
export const type = "nii"

export async function read(buffer: ArrayBuffer): Promise<{
  hdr: NIFTI1
  img: ArrayBuffer | TypedVoxelArray
}> {
  const iwi = decode(new Uint8Array(buffer)) as IWImage
  return iwi2nii(iwi)
}

function iwi2nii(iwi: IWImage): {
  hdr: NIFTI1
  img: ArrayBuffer | TypedVoxelArray
} {
  if (!("imageType" in iwi) || !("size" in iwi) || !("data" in iwi)) {
    throw new Error('.iwi.cbor must have "imageType", "size" and "data".')
  }

  const hdr = new nifti.NIFTI1() as NIFTI1
  hdr.littleEndian = true

  // set dims
  hdr.dims = [3, 1, 1, 1, 0, 0, 0, 0]
  hdr.dims[0] = iwi.size.length
  let nvox = 1
  for (let i = 0; i < iwi.size.length; i++) {
    hdr.dims[i + 1] = Number(BigInt(iwi.size[i]) & BigInt(0xffffffff))
    nvox *= Math.max(hdr.dims[i + 1], 1)
  }

  // set pixDims
  hdr.pixDims = [1, 1, 1, 1, 1, 0, 0, 0]
  if (iwi.spacing) {
    for (let i = 0; i < iwi.spacing.length; i++) {
      hdr.pixDims[i + 1] = iwi.spacing[i]
    }
  }

  // determine datatype from voxel data
  if (iwi.data instanceof Uint8Array) {
    if (iwi.imageType.pixelType === "RGB") {
      hdr.numBitsPerVoxel = 24
      hdr.datatypeCode = 128 // DT_RGB24
    } else {
      hdr.numBitsPerVoxel = 8
      hdr.datatypeCode = 2 // DT_UINT8
    }
  } else if (iwi.data instanceof Int16Array) {
    hdr.numBitsPerVoxel = 16
    hdr.datatypeCode = 4 // DT_INT16
  } else if (iwi.data instanceof Uint16Array) {
    hdr.numBitsPerVoxel = 16
    hdr.datatypeCode = 512 // DT_UINT16
  } else if (iwi.data instanceof Int32Array) {
    hdr.numBitsPerVoxel = 32
    hdr.datatypeCode = 8 // DT_INT32
  } else if (iwi.data instanceof Float64Array) {
    hdr.numBitsPerVoxel = 64
    hdr.datatypeCode = 64 // DT_FLOAT64
  } else if (iwi.data instanceof Float32Array) {
    hdr.numBitsPerVoxel = 32
    hdr.datatypeCode = 16 // DT_FLOAT32
  } else {
    throw new Error(".iwi.cbor voxels use unsupported datatype.")
  }

  const nbyte = nvox * Math.floor(hdr.numBitsPerVoxel / 8)
  // see https://github.com/InsightSoftwareConsortium/ITK-Wasm/issues/1239
  const img8 = new Uint8Array(
    iwi.data.buffer,
    iwi.data.byteOffset,
    iwi.data.byteLength,
  )
  if (nbyte !== img8.byteLength) {
    throw new Error(`expected ${nbyte} bytes but have ${img8.byteLength}`)
  }

  hdr.vox_offset = 352
  hdr.scl_inter = 0
  hdr.scl_slope = 1
  hdr.magic = "n+1"

  // set affine transform
  if (iwi.direction && iwi.origin) {
    // NIFTI is RAS, IWI is LPS
    // https://www.nitrc.org/plugins/mwiki/index.php/dcm2nii:MainPage#Spatial_Coordinates
    const m = iwi.direction.slice()
    const mm = iwi.spacing?.slice()
    if (!mm) {
      throw new Error("IWI spacing is undefined")
    }
    const o = iwi.origin
    hdr.sform_code = 1
    hdr.affine = [
      [m[0] * -mm[0], m[3] * -mm[1], m[6] * -mm[2], -o[0]],
      [m[1] * -mm[0], m[4] * -mm[1], m[7] * -mm[2], -o[1]],
      [m[2] * mm[0], m[5] * mm[1], m[8] * mm[2], o[2]],
      [0, 0, 0, 1],
    ]
  }

  // Return header and image data separately (like other format loaders)
  const img = img8.buffer.slice(
    img8.byteOffset,
    img8.byteOffset + img8.byteLength,
  ) as ArrayBuffer
  return { hdr, img }
}
