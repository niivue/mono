import { encode } from "cbor-x"
import type { NIFTI1, NIFTI2 } from "@/NVTypes"

export const extensions = ["IWI.CBOR"]

export async function write(
  hdr: NIFTI1 | NIFTI2,
  img: ArrayBuffer,
): Promise<ArrayBuffer> {
  const iwi: Record<string, unknown> = {
    imageType: {
      dimension: hdr.dims[0],
      componentType: "uint8",
      pixelType: "Scalar",
      components: 1,
    },
    direction: new Float64Array(9),
    origin: [] as number[],
    size: [] as bigint[],
    spacing: [] as number[],
    metadata: [],
  }

  const imageType = iwi.imageType as Record<string, unknown>
  const spacing = iwi.spacing as number[]
  const size = iwi.size as bigint[]
  const origin = iwi.origin as number[]
  const direction = iwi.direction as Float64Array

  for (let i = 0; i < hdr.dims[0]; i++) {
    spacing[i] = hdr.pixDims[i + 1]
    size[i] = BigInt(hdr.dims[i + 1])
  }

  if (hdr.dims[0] > 2) {
    // NIFTI is RAS, IWI is LPS
    origin[0] = -hdr.affine[0][3]
    origin[1] = -hdr.affine[1][3]
    origin[2] = hdr.affine[2][3]
    const mm = [hdr.pixDims[1], hdr.pixDims[2], hdr.pixDims[3]]
    direction[0] = hdr.affine[0][0] / -mm[0]
    direction[1] = hdr.affine[1][0] / -mm[0]
    direction[2] = hdr.affine[2][0] / mm[0]
    direction[3] = hdr.affine[0][1] / -mm[1]
    direction[4] = hdr.affine[1][1] / -mm[1]
    direction[5] = hdr.affine[2][1] / mm[1]
    direction[6] = hdr.affine[0][2] / -mm[2]
    direction[7] = hdr.affine[1][2] / -mm[2]
    direction[8] = hdr.affine[2][2] / mm[2]
  }

  if (hdr.datatypeCode === 128) {
    imageType.pixelType = "RGB"
    imageType.componentType = "uint8"
    imageType.components = 3
    iwi.data = new Uint8Array(img)
  } else if (hdr.datatypeCode === 64) {
    imageType.componentType = "float64"
    iwi.data = new Float64Array(img)
  } else if (hdr.datatypeCode === 16) {
    imageType.componentType = "float32"
    iwi.data = new Float32Array(img)
  } else if (hdr.datatypeCode === 2) {
    imageType.componentType = "uint8"
    iwi.data = new Uint8Array(img)
  } else if (hdr.datatypeCode === 4) {
    imageType.componentType = "int16"
    iwi.data = new Int16Array(img)
  } else if (hdr.datatypeCode === 8) {
    imageType.componentType = "int32"
    iwi.data = new Int32Array(img)
  } else {
    throw new Error(
      `NIfTI voxels use unsupported datatype ${hdr.datatypeCode}.`,
    )
  }

  const encoded = encode(iwi)
  return encoded.buffer.slice(
    encoded.byteOffset,
    encoded.byteOffset + encoded.byteLength,
  )
}
