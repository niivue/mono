import { readMatV4 } from '@/codecs/NVMatlab'
import { NiiDataType } from '@/NVConstants'
import type { NIFTI1, NIFTI2, TypedVoxelArray } from '@/NVTypes'
import { dsiStudioHeader } from './fib'

export const extensions = ['src', 'src.gz']
export const type = 'nii'

export async function read(
  buffer: ArrayBuffer,
  _name?: string,
  _pairedImgData: ArrayBuffer | null = null,
): Promise<{ hdr: NIFTI1 | NIFTI2; img: ArrayBuffer | TypedVoxelArray }> {
  const mat = await readMatV4(buffer)
  if (!('dimension' in mat) || !('image0' in mat)) {
    throw new Error('Not a valid DSI Studio SRC file')
  }
  let n = 0
  let len = 0
  for (const [key, value] of Object.entries(mat)) {
    if (!key.startsWith('image')) continue
    if (n === 0) len = value.length
    else if (len !== value.length) len = -1
    if (value.constructor !== Uint16Array) {
      throw new Error('DSI Studio SRC files always use Uint16 datatype')
    }
    n++
  }
  if (len < 1 || n < 1) {
    throw new Error(
      'SRC file not valid DSI Studio data. The image(s) should have the same length',
    )
  }

  const hdr = dsiStudioHeader(mat, n)
  hdr.numBitsPerVoxel = 16
  hdr.datatypeCode = NiiDataType.DT_UINT16

  const nBytes3D =
    hdr.dims[1] * hdr.dims[2] * hdr.dims[3] * (hdr.numBitsPerVoxel / 8)
  const nBytes = nBytes3D * hdr.dims[4]
  const buff8 = new Uint8Array(new ArrayBuffer(nBytes))
  let offset = 0
  for (let i = 0; i < n; i++) {
    const arr = mat[`image${i}`]
    const img8 = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength)
    buff8.set(img8, offset)
    offset += nBytes3D
  }
  return { hdr, img: buff8.buffer }
}
