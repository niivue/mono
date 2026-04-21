import { mat4 } from "gl-matrix"
import * as nifti from "nifti-reader-js"
import { decompress } from "@/codecs/NVGz"
import { log } from "@/logger"
import { NiiDataType } from "@/NVConstants"
import type { NIFTI1, NIFTI2, TypedVoxelArray } from "@/NVTypes"

export const extensions = ["mgh", "mgz"]
export const type = "nii"

export async function read(
  buffer: ArrayBuffer | Uint8Array,
  filename: string,
  _pairedImgData: ArrayBuffer | null = null,
): Promise<{ hdr: NIFTI1 | NIFTI2; img: ArrayBuffer | TypedVoxelArray }> {
  // Ensure we have a Uint8Array view for easy byte checks and slicing
  let raw = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer)
  // Detect gzip by magic bytes (31, 139)
  if (raw.length >= 2 && raw[0] === 31 && raw[1] === 139) {
    try {
      // decompress already expects a Uint8Array and returns a Uint8Array
      raw = await decompress(raw)
    } catch (err) {
      log.error("Failed to decompress MGZ file.", err)
      throw err
    }
  }
  const reader = new DataView(raw.buffer, raw.byteOffset, raw.byteLength)
  const hdr = new nifti.NIFTI1() as NIFTI1
  if (raw.byteLength < 284) {
    log.error("File too small to be a valid MGH/MGZ header.")
    throw new Error("Invalid MGH/MGZ header")
  }
  // --- Read MGH Header Fields ---
  const version = reader.getInt32(0, false)
  const width = reader.getInt32(4, false)
  const height = reader.getInt32(8, false)
  const depth = reader.getInt32(12, false)
  const nframes = reader.getInt32(16, false)
  const mtype = reader.getInt32(20, false)
  const spacingX = reader.getFloat32(30, false)
  const spacingY = reader.getFloat32(34, false)
  const spacingZ = reader.getFloat32(38, false)
  const xr = reader.getFloat32(42, false)
  const xa = reader.getFloat32(46, false)
  const xs = reader.getFloat32(50, false)
  const yr = reader.getFloat32(54, false)
  const ya = reader.getFloat32(58, false)
  const ys = reader.getFloat32(62, false)
  const zr = reader.getFloat32(66, false)
  const za = reader.getFloat32(70, false)
  const zs = reader.getFloat32(74, false)
  const cr = reader.getFloat32(78, false)
  const ca = reader.getFloat32(82, false)
  const cs = reader.getFloat32(86, false)

  if (version !== 1 && version !== 257) {
    log.warn(`Unexpected MGH version: ${version}.`)
  }
  if (width <= 0 || height <= 0 || depth <= 0) {
    log.error(`Invalid MGH dimensions: ${width}x${height}x${depth}`)
    throw new Error("Invalid MGH dimensions")
  }

  // Map MGH data type directly onto nvImage.hdr
  switch (mtype) {
    case 0:
      hdr.numBitsPerVoxel = 8
      hdr.datatypeCode = NiiDataType.DT_UINT8
      break
    case 4:
      hdr.numBitsPerVoxel = 16
      hdr.datatypeCode = NiiDataType.DT_INT16
      break
    case 1:
      hdr.numBitsPerVoxel = 32
      hdr.datatypeCode = NiiDataType.DT_INT32
      break
    case 3:
      hdr.numBitsPerVoxel = 32
      hdr.datatypeCode = NiiDataType.DT_FLOAT32
      break
    default:
      log.error(`Unsupported MGH data type: ${mtype}`)
      throw new Error(`Unsupported MGH data type: ${mtype}`)
  }

  // Set dimensions directly onto nvImage.hdr
  hdr.dims[1] = width
  hdr.dims[2] = height
  hdr.dims[3] = depth
  hdr.dims[4] = Math.max(1, nframes)
  hdr.dims[0] = hdr.dims[4] > 1 ? 4 : 3

  // Set pixel dimensions directly onto nvImage.hdr (using abs)
  hdr.pixDims[0] = 1
  hdr.pixDims[1] = Math.abs(spacingX)
  hdr.pixDims[2] = Math.abs(spacingY)
  hdr.pixDims[3] = Math.abs(spacingZ)
  hdr.pixDims[4] = 0

  hdr.sform_code = 1
  hdr.qform_code = 0
  hdr.sform_code = 1
  const rot44 = mat4.fromValues(
    xr * hdr.pixDims[1],
    yr * hdr.pixDims[2],
    zr * hdr.pixDims[3],
    0,
    xa * hdr.pixDims[1],
    ya * hdr.pixDims[2],
    za * hdr.pixDims[3],
    0,
    xs * hdr.pixDims[1],
    ys * hdr.pixDims[2],
    zs * hdr.pixDims[3],
    0,
    0,
    0,
    0,
    1,
  )
  const Pcrs = [hdr.dims[1] / 2.0, hdr.dims[2] / 2.0, hdr.dims[3] / 2.0, 1]

  const PxyzOffset = [0, 0, 0, 0]
  for (let i = 0; i < 3; i++) {
    PxyzOffset[i] = 0
    for (let j = 0; j < 3; j++) {
      PxyzOffset[i] = PxyzOffset[i] + rot44[j + i * 4] * Pcrs[j]
    }
  }
  hdr.affine = [
    [rot44[0], rot44[1], rot44[2], cr - PxyzOffset[0]],
    [rot44[4], rot44[5], rot44[6], ca - PxyzOffset[1]],
    [rot44[8], rot44[9], rot44[10], cs - PxyzOffset[2]],
    [0, 0, 0, 1],
  ]

  hdr.vox_offset = 284
  hdr.magic = "n+1"

  // Check data size
  const nBytesPerVoxel = hdr.numBitsPerVoxel / 8
  const nVoxels = width * height * depth * hdr.dims[4]
  const expectedBytes = nVoxels * nBytesPerVoxel
  // Return only the raw image data buffer
  const imgRaw = raw.slice(hdr.vox_offset, hdr.vox_offset + expectedBytes)
  // label detection based on:
  // https://github.com/pwighton/mgz-optimize/blob/main/mgz_optimize.py
  // option 1: detect label by version number
  let isLabel = version === 257
  // option 2: detect label by filename
  if (!isLabel) {
    const mgLabelFiles = [
      "aparc.DKTatlas+aseg.deep.mg",
      "aparc+aseg.mg",
      "aparc.DKTatlas+aseg.mg",
      "aparc.a2005s+aseg.mg",
      "aparc.a2009s+aseg.mg",
      "apas+head.mg",
      "apas+head.samseg.mg",
      "aseg.auto.mg",
      "aseg.auto_noCCseg.mg",
      "aseg.mg",
      "aseg.presurf.hypos.mg",
      "aseg.presurf.mg",
      "brainstemSsLabels.v13.FSvoxelSpace.mg",
      "brainstemSsLabels.v13.mg",
      "ctrl_pts.mg",
      "filled.auto.mg",
      "filled.mg",
      "gtmseg.mg",
      "hypothalamic_subunits_seg.v1.mg",
      "lh.hippoAmygLabels-T1.v22.CA.FSvoxelSpace.mg",
      "lh.hippoAmygLabels-T1.v22.CA.mg",
      "lh.hippoAmygLabels-T1.v22.FS60.FSvoxelSpace.mg",
      "lh.hippoAmygLabels-T1.v22.FS60.mg",
      "lh.hippoAmygLabels-T1.v22.FSvoxelSpace.mg",
      "lh.hippoAmygLabels-T1.v22.HBT.FSvoxelSpace.mg",
      "lh.hippoAmygLabels-T1.v22.HBT.mg",
      "lh.hippoAmygLabels-T1.v22.mg",
      "lh.ribbon.mg",
      "mca-dura.mg",
      "rh.hippoAmygLabels-T1.v22.CA.FSvoxelSpace.mg",
      "rh.hippoAmygLabels-T1.v22.CA.mg",
      "rh.hippoAmygLabels-T1.v22.FS60.FSvoxelSpace.mg",
      "rh.hippoAmygLabels-T1.v22.FS60.mg",
      "rh.hippoAmygLabels-T1.v22.FSvoxelSpace.mg",
      "rh.hippoAmygLabels-T1.v22.HBT.FSvoxelSpace.mg",
      "rh.hippoAmygLabels-T1.v22.HBT.mg",
      "rh.hippoAmygLabels-T1.v22.mg",
      "rh.ribbon.mg",
      "ribbon.mg",
      "synthseg.mg",
      "synthseg.rca.mg",
      "vsinus.mg",
      "subcort.mask.1mm.mg",
      "subcort.mask.mg",
      "surface.defects.mg",
      "ThalamicNuclei.v13.T1.FSvoxelSpace.mg",
      "ThalamicNuclei.v13.T1.mg",
      "wm.asegedit.mg",
      "wmparc.mg",
    ]
    isLabel = mgLabelFiles.some((label) => filename.includes(label))
  }
  return {
    img: imgRaw,
    hdr: hdr,
  }
}
