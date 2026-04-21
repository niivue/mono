import * as nifti from "nifti-reader-js"
import { readMatV4 } from "@/codecs/NVMatlab"
import { NiiDataType } from "@/NVConstants"
import type { NIFTI1, NIFTI2, TypedVoxelArray } from "@/NVTypes"

export const extensions = ["fz", "gqi", "qsdr", "fib"]
export const type = "nii"

export async function read(
  buffer: ArrayBuffer,
  _name?: string,
  _pairedImgData: ArrayBuffer | null = null,
): Promise<{ hdr: NIFTI1 | NIFTI2; img: ArrayBuffer | TypedVoxelArray }> {
  const hdr = new nifti.NIFTI1() as NIFTI1
  hdr.littleEndian = false
  hdr.dims = [3, 1, 1, 1, 0, 0, 0, 0]
  hdr.pixDims = [1, 1, 1, 1, 1, 0, 0, 0]

  const mat = await readMatV4(buffer, true)
  if (!("dimension" in mat) || !("dti_fa" in mat)) {
    throw new Error("Not a valid DSI Studio FIB file")
  }
  const hasV1 =
    "index0" in mat &&
    "index1" in mat &&
    "index2" in mat &&
    "odf_vertices" in mat

  hdr.numBitsPerVoxel = 32
  hdr.datatypeCode = NiiDataType.DT_FLOAT32
  hdr.dims[1] = mat.dimension[0]
  hdr.dims[2] = mat.dimension[1]
  hdr.dims[3] = mat.dimension[2]
  hdr.dims[4] = 1
  hdr.pixDims[1] = mat.voxel_size[0]
  hdr.pixDims[2] = mat.voxel_size[1]
  hdr.pixDims[3] = mat.voxel_size[2]
  hdr.sform_code = 1
  const xmm = (hdr.dims[1] - 1) * 0.5 * hdr.pixDims[1]
  const ymm = (hdr.dims[2] - 1) * 0.5 * hdr.pixDims[2]
  const zmm = (hdr.dims[3] - 1) * 0.5 * hdr.pixDims[3]
  hdr.affine = [
    [hdr.pixDims[1], 0, 0, -xmm],
    [0, -hdr.pixDims[2], 0, ymm],
    [0, 0, hdr.pixDims[2], -zmm],
    [0, 0, 0, 1],
  ]
  hdr.littleEndian = true

  const nVox3D = hdr.dims[1] * hdr.dims[2] * hdr.dims[3]
  const nBytes3D = nVox3D * Math.ceil(hdr.numBitsPerVoxel / 8)
  const nBytes = nBytes3D * hdr.dims[4]
  const buff8v1 = new Uint8Array(new ArrayBuffer(nVox3D * 4 * 3))
  if (hasV1) {
    const nvox = nVox3D
    const dir0 = new Float32Array(nvox)
    const dir1 = new Float32Array(nvox)
    const dir2 = new Float32Array(nvox)
    const idxs = mat.index0
    const dirs = mat.odf_vertices
    for (let i = 0; i < nvox; i++) {
      const idx = idxs[i] * 3
      dir0[i] = dirs[idx + 0]
      dir1[i] = dirs[idx + 1]
      dir2[i] = -dirs[idx + 2]
    }
    buff8v1.set(
      new Uint8Array(dir0.buffer, dir0.byteOffset, dir0.byteLength),
      0 * nBytes3D,
    )
    buff8v1.set(
      new Uint8Array(dir1.buffer, dir1.byteOffset, dir1.byteLength),
      1 * nBytes3D,
    )
    buff8v1.set(
      new Uint8Array(dir2.buffer, dir2.byteOffset, dir2.byteLength),
      2 * nBytes3D,
    )
  }
  if ("report" in mat) {
    hdr.description = new TextDecoder().decode(
      mat.report.subarray(0, Math.min(79, mat.report.byteLength)),
    )
  }

  const buff8 = new Uint8Array(new ArrayBuffer(nBytes))
  const arrFA = Float32Array.from(mat.dti_fa)
  if ("mask" in mat) {
    let slope = 1
    if ("dti_fa_slope" in mat) slope = mat.dti_fa_slope[0]
    let inter = 1
    if ("dti_fa_inter" in mat) inter = mat.dti_fa_inter[0]
    const nvox = nVox3D
    const mask = mat.mask
    const f32 = new Float32Array(nvox)
    let j = 0
    for (let i = 0; i < nvox; i++) {
      if (mask[i] !== 0) {
        f32[i] = arrFA[j] * slope + inter
        j++
      }
    }
    ;(hdr as unknown as { v1?: Float32Array }).v1 = new Float32Array(
      buff8v1.buffer,
    )
    return { hdr, img: f32.buffer }
  }

  const imgFA = new Uint8Array(arrFA.buffer, arrFA.byteOffset, arrFA.byteLength)
  buff8.set(imgFA, 0)
  ;(hdr as unknown as { v1?: Float32Array }).v1 = new Float32Array(
    buff8v1.buffer,
  )
  return { hdr, img: buff8.buffer }
}
