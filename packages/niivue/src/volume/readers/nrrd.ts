import { mat3, mat4, vec3 } from "gl-matrix"
import * as nifti from "nifti-reader-js"
import { decompress } from "@/codecs/NVGz"
import { log } from "@/logger"
import * as NVTransforms from "@/math/NVTransforms"
import { NiiDataType } from "@/NVConstants"
import type { NIFTI1, NIFTI2, TypedVoxelArray } from "@/NVTypes"

export const extensions = ["nrrd", "nhdr"]
export const type = "nii"

export async function read(
  buffer: ArrayBuffer,
  _name?: string,
  pairedImgData: ArrayBuffer | null = null,
): Promise<{ hdr: NIFTI1 | NIFTI2; img: ArrayBuffer | TypedVoxelArray }> {
  const hdr = new nifti.NIFTI1() as NIFTI1
  hdr.pixDims = [1, 1, 1, 1, 1, 0, 0, 0]
  hdr.dims = [0, 0, 0, 0, 0, 0, 0, 0]

  const bytes = new Uint8Array(buffer)
  let headerText: string | null = null
  for (let i = 1; i < bytes.length; i++) {
    if (bytes[i - 1] === 10 && bytes[i] === 10) {
      const headerBytes = buffer.slice(0, i - 1)
      headerText = new TextDecoder().decode(headerBytes)
      hdr.vox_offset = i + 1
      break
    }
  }
  if (!headerText) {
    throw new Error("NRRD: could not parse header")
  }

  const lines = headerText.split("\n")
  if (!lines[0].startsWith("NRRD")) {
    throw new Error("NRRD: invalid header signature")
  }

  let isGz = false
  let isMicron = false
  let isDetached = false
  const mat33 = mat3.fromValues(NaN, 0, 0, 0, 1, 0, 0, 0, 1)
  const offset = vec3.fromValues(0, 0, 0)
  let rot33 = mat3.create()

  for (let i = 1; i < lines.length; i++) {
    let str = lines[i]
    if (!str || str[0] === "#") continue
    str = str.toLowerCase()
    const items = str.split(":")
    if (items.length < 2) continue
    const key = items[0].trim()
    let value = items[1].trim()
    value = value.replaceAll(")", " ").replaceAll("(", " ").trim()

    switch (key) {
      case "data file":
        isDetached = true
        break
      case "encoding":
        if (value.includes("raw")) isGz = false
        else if (value.includes("gz")) isGz = true
        else throw new Error(`NRRD: unsupported encoding ${value}`)
        break
      case "type":
        switch (value) {
          case "uchar":
          case "unsigned char":
          case "uint8":
          case "uint8_t":
            hdr.numBitsPerVoxel = 8
            hdr.datatypeCode = NiiDataType.DT_UINT8
            break
          case "signed char":
          case "int8":
          case "int8_t":
            hdr.numBitsPerVoxel = 8
            hdr.datatypeCode = NiiDataType.DT_INT8
            break
          case "short":
          case "short int":
          case "signed short":
          case "signed short int":
          case "int16":
          case "int16_t":
            hdr.numBitsPerVoxel = 16
            hdr.datatypeCode = NiiDataType.DT_INT16
            break
          case "ushort":
          case "unsigned short":
          case "unsigned short int":
          case "uint16":
          case "uint16_t":
            hdr.numBitsPerVoxel = 16
            hdr.datatypeCode = NiiDataType.DT_UINT16
            break
          case "int":
          case "signed int":
          case "int32":
          case "int32_t":
            hdr.numBitsPerVoxel = 32
            hdr.datatypeCode = NiiDataType.DT_INT32
            break
          case "uint":
          case "unsigned int":
          case "uint32":
          case "uint32_t":
            hdr.numBitsPerVoxel = 32
            hdr.datatypeCode = NiiDataType.DT_UINT32
            break
          case "float":
            hdr.numBitsPerVoxel = 32
            hdr.datatypeCode = NiiDataType.DT_FLOAT32
            break
          case "double":
            hdr.numBitsPerVoxel = 64
            hdr.datatypeCode = NiiDataType.DT_FLOAT64
            break
          default:
            throw new Error(`NRRD: unsupported data type ${value}`)
        }
        break
      case "spacings": {
        const values = value.split(/[ ,]+/)
        for (let d = 0; d < values.length; d++) {
          hdr.pixDims[d + 1] = parseFloat(values[d])
        }
        break
      }
      case "sizes": {
        const dims = value.split(/[ ,]+/)
        hdr.dims[0] = dims.length
        for (let d = 0; d < dims.length; d++) {
          hdr.dims[d + 1] = parseInt(dims[d], 10)
        }
        break
      }
      case "endian":
        hdr.littleEndian = value.includes("little")
        break
      case "space directions": {
        const vs = value.split(/[ ,]+/)
        if (vs.length === 9) {
          for (let d = 0; d < 9; d++) {
            mat33[d] = parseFloat(vs[d])
          }
        }
        break
      }
      case "space origin": {
        const ts = value.split(/[ ,]+/)
        if (ts.length === 3) {
          offset[0] = parseFloat(ts[0])
          offset[1] = parseFloat(ts[1])
          offset[2] = parseFloat(ts[2])
        }
        break
      }
      case "space units":
        if (value.includes("microns")) isMicron = true
        break
      case "space":
        if (
          value.includes("right-anterior-superior") ||
          value.includes("ras")
        ) {
          rot33 = mat3.fromValues(1, 0, 0, 0, 1, 0, 0, 0, 1)
        } else if (
          value.includes("left-anterior-superior") ||
          value.includes("las")
        ) {
          rot33 = mat3.fromValues(-1, 0, 0, 0, 1, 0, 0, 0, 1)
        } else if (
          value.includes("left-posterior-superior") ||
          value.includes("lps")
        ) {
          rot33 = mat3.fromValues(-1, 0, 0, 0, -1, 0, 0, 0, 1)
        } else {
          log.warn("NRRD: unsupported space", value)
        }
        break
      default:
        break
    }
  }

  if (!Number.isNaN(mat33[0])) {
    hdr.sform_code = 2
    if (isMicron) {
      mat3.multiplyScalar(mat33, mat33, 0.001)
      offset[0] *= 0.001
      offset[1] *= 0.001
      offset[2] *= 0.001
    }
    if (rot33[0] < 0) offset[0] = -offset[0]
    if (rot33[4] < 0) offset[1] = -offset[1]
    if (rot33[8] < 0) offset[2] = -offset[2]
    mat3.multiply(mat33, rot33, mat33)
    const mat = mat4.fromValues(
      mat33[0],
      mat33[3],
      mat33[6],
      offset[0],
      mat33[1],
      mat33[4],
      mat33[7],
      offset[1],
      mat33[2],
      mat33[5],
      mat33[8],
      offset[2],
      0,
      0,
      0,
      1,
    )
    const mm000 = NVTransforms.vox2mm(null, [0, 0, 0], mat)
    const mm100 = NVTransforms.vox2mm(null, [1, 0, 0], mat)
    const mm010 = NVTransforms.vox2mm(null, [0, 1, 0], mat)
    const mm001 = NVTransforms.vox2mm(null, [0, 0, 1], mat)
    vec3.subtract(mm100, mm100, mm000)
    vec3.subtract(mm010, mm010, mm000)
    vec3.subtract(mm001, mm001, mm000)
    hdr.pixDims[0] = 1
    hdr.pixDims[1] = vec3.length(mm100)
    hdr.pixDims[2] = vec3.length(mm010)
    hdr.pixDims[3] = vec3.length(mm001)
    hdr.affine = [
      [mat[0], mat[1], mat[2], mat[3]],
      [mat[4], mat[5], mat[6], mat[7]],
      [mat[8], mat[9], mat[10], mat[11]],
      [0, 0, 0, 1],
    ]
  }

  const sourceBuffer = isDetached ? pairedImgData : buffer
  const sourceOffset = isDetached ? 0 : hdr.vox_offset
  if (isDetached && !pairedImgData) {
    throw new Error("NRRD: detached header requires paired image data")
  }
  if (!sourceBuffer || sourceOffset >= sourceBuffer.byteLength) {
    throw new Error(`NRRD: data offset (${sourceOffset}) out of range`)
  }
  let dataSection = sourceBuffer.slice(sourceOffset)
  if (isGz) {
    const raw = await decompress(new Uint8Array(dataSection))
    dataSection = raw.buffer.slice(
      raw.byteOffset,
      raw.byteOffset + raw.byteLength,
    ) as ArrayBuffer
  }

  const nBytesPerVoxel = hdr.numBitsPerVoxel / 8
  const nVoxels = hdr.dims
    .slice(1, hdr.dims[0] + 1)
    .reduce((acc, dim) => acc * Math.max(1, dim), 1)
  const expectedBytes = nVoxels * nBytesPerVoxel
  if (dataSection.byteLength < expectedBytes) {
    throw new Error(
      `NRRD: image data size mismatch (expected ${expectedBytes}, got ${dataSection.byteLength})`,
    )
  }
  if (dataSection.byteLength > expectedBytes) {
    dataSection = dataSection.slice(0, expectedBytes)
  }

  return { hdr, img: dataSection }
}
