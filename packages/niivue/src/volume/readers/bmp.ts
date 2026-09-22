import * as nifti from 'nifti-reader-js'
import { NiiDataType } from '@/NVConstants'
import type { NIFTI1, NIFTI2, TypedVoxelArray } from '@/NVTypes'
import { decodeImageRGBA } from '../imageDecode'

export const extensions = ['png', 'bmp', 'gif', 'jpg', 'jpeg']
export const type = 'nii'

export async function read(
  buffer: ArrayBuffer,
  _name?: string,
  _pairedImgData: ArrayBuffer | null = null,
): Promise<{ hdr: NIFTI1 | NIFTI2; img: ArrayBuffer | TypedVoxelArray }> {
  const imageData = await decodeImageRGBA(buffer)
  const { width, height, data } = imageData
  const hdr = new nifti.NIFTI1() as NIFTI1
  hdr.dims = [3, width, height, 1, 0, 0, 0, 0]
  hdr.pixDims = [1, 1, 1, 1, 1, 0, 0, 0]
  hdr.affine = [
    [hdr.pixDims[1], 0, 0, -(hdr.dims[1] - 2) * 0.5 * hdr.pixDims[1]],
    [0, hdr.pixDims[2], 0, -(hdr.dims[2] - 2) * 0.5 * hdr.pixDims[2]],
    [0, 0, hdr.pixDims[3], -(hdr.dims[3] - 2) * 0.5 * hdr.pixDims[3]],
    [0, 0, 0, 1],
  ]
  hdr.numBitsPerVoxel = 8
  hdr.datatypeCode = NiiDataType.DT_RGBA32
  let isGrayscale = true
  for (let i = 0; i < data.length; i += 4) {
    if (data[i] !== data[i + 1] || data[i] !== data[i + 2]) {
      isGrayscale = false
      break
    }
  }
  if (isGrayscale) {
    hdr.datatypeCode = NiiDataType.DT_UINT8
    const grayscaleData = new Uint8Array(width * height)
    for (let i = 0, j = 0; i < data.length; i += 4, j++) {
      grayscaleData[j] = data[i]
    }
    return { hdr, img: grayscaleData }
  }
  return { hdr, img: data.buffer as ArrayBuffer }
}
