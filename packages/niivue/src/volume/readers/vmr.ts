import * as nifti from "nifti-reader-js"
import { log } from "@/logger"
import { NiiDataType } from "@/NVConstants"
import type { NIFTI1, NIFTI2, TypedVoxelArray } from "@/NVTypes"

export const extensions = ["vmr", "v16"]
export const type = "nii"

function readV16(buffer: ArrayBuffer): { hdr: NIFTI1; img: ArrayBuffer } {
  const hdr = new nifti.NIFTI1() as NIFTI1
  hdr.dims = [3, 1, 1, 1, 0, 0, 0, 0]
  hdr.pixDims = [1, 1, 1, 1, 1, 0, 0, 0]
  const reader = new DataView(buffer)
  hdr.dims[1] = reader.getUint16(0, true)
  hdr.dims[2] = reader.getUint16(2, true)
  hdr.dims[3] = reader.getUint16(4, true)
  const nBytes = 2 * hdr.dims[1] * hdr.dims[2] * hdr.dims[3]
  if (nBytes + 6 !== buffer.byteLength) {
    log.warn("This does not look like a valid BrainVoyager V16 file")
  }
  hdr.numBitsPerVoxel = 16
  hdr.datatypeCode = NiiDataType.DT_UINT16
  log.warn("Warning: V16 files have no spatial transforms")
  hdr.affine = [
    [0, 0, -hdr.pixDims[1], (hdr.dims[1] - 2) * 0.5 * hdr.pixDims[1]],
    [-hdr.pixDims[2], 0, 0, (hdr.dims[2] - 2) * 0.5 * hdr.pixDims[2]],
    [0, -hdr.pixDims[3], 0, (hdr.dims[3] - 2) * 0.5 * hdr.pixDims[3]],
    [0, 0, 0, 1],
  ]
  hdr.littleEndian = true
  return { hdr, img: buffer.slice(6) }
}

function readVMR(buffer: ArrayBuffer): { hdr: NIFTI1; img: ArrayBuffer } {
  const hdr = new nifti.NIFTI1() as NIFTI1
  hdr.dims = [3, 1, 1, 1, 0, 0, 0, 0]
  hdr.pixDims = [1, 1, 1, 1, 1, 0, 0, 0]
  const reader = new DataView(buffer)
  const version = reader.getUint16(0, true)
  if (version !== 4) {
    log.warn("Not a valid version 4 VMR image")
  }
  hdr.dims[1] = reader.getUint16(2, true)
  hdr.dims[2] = reader.getUint16(4, true)
  hdr.dims[3] = reader.getUint16(6, true)
  const nBytes = hdr.dims[1] * hdr.dims[2] * hdr.dims[3]
  if (version >= 4) {
    let pos = 8 + nBytes
    const nSpatialTransforms = reader.getUint32(pos + 88, true)
    pos = pos + 92
    if (nSpatialTransforms > 0) {
      const len = buffer.byteLength
      for (let i = 0; i < nSpatialTransforms; i++) {
        while (pos < len && reader.getUint8(pos) !== 0) pos++
        pos++
        pos += 4
        while (pos < len && reader.getUint8(pos) !== 0) pos++
        pos++
        const nValues = reader.getUint32(pos, true)
        pos += 4
        for (let j = 0; j < nValues; j++) pos += 4
      }
    }
    hdr.pixDims[1] = reader.getFloat32(pos + 2, true)
    hdr.pixDims[2] = reader.getFloat32(pos + 6, true)
    hdr.pixDims[3] = reader.getFloat32(pos + 10, true)
  }
  log.warn("Warning: VMR spatial transform not implemented")
  hdr.affine = [
    [0, 0, -hdr.pixDims[1], (hdr.dims[1] - 2) * 0.5 * hdr.pixDims[1]],
    [-hdr.pixDims[2], 0, 0, (hdr.dims[2] - 2) * 0.5 * hdr.pixDims[2]],
    [0, -hdr.pixDims[3], 0, (hdr.dims[3] - 2) * 0.5 * hdr.pixDims[3]],
    [0, 0, 0, 1],
  ]
  hdr.numBitsPerVoxel = 8
  hdr.datatypeCode = NiiDataType.DT_UINT8
  return { hdr, img: buffer.slice(8, 8 + nBytes) }
}

export function read(
  buffer: ArrayBuffer,
  name?: string,
  _pairedImgData: ArrayBuffer | null = null,
): { hdr: NIFTI1 | NIFTI2; img: ArrayBuffer | TypedVoxelArray } {
  const lowerName = name?.toLowerCase() ?? ""
  if (lowerName.endsWith(".v16")) {
    return readV16(buffer)
  }
  return readVMR(buffer)
}
