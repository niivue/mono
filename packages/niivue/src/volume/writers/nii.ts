/**
 * NIfTI Volume Writer
 *
 * Serializes a NIfTI header + image data into a single-file NIfTI-1 (.nii).
 * Compression (.nii.gz) is handled by the writer registry, not here.
 */

import type { NIFTI1, NIFTI2 } from "@/NVTypes"
import { hdrToArrayBuffer } from "../utils"

export const extensions = ["NII", "NII.GZ"]

export async function write(
  hdr: NIFTI1 | NIFTI2,
  img: ArrayBuffer,
): Promise<ArrayBuffer> {
  const hdrBytes = hdrToArrayBuffer(hdr) // 348 bytes
  const extFlag = new Uint8Array(4) // 4-byte extension flag (all zeros = no extensions)
  const voxOffset = 352 // 348 header + 4 extension flag
  const imgBytes = new Uint8Array(img)

  const output = new Uint8Array(voxOffset + imgBytes.length)
  output.set(hdrBytes, 0)
  output.set(extFlag, 348)
  output.set(imgBytes, voxOffset)

  return output.buffer
}
